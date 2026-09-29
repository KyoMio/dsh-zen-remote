/**
 * The exact-fetch-route interception (T51): the sub-client's own DSH process
 * keeps serving its local UI, but the two `/api` routes a REMOTE session's
 * surface reaches must not run against local state:
 *
 * - `/api/session/uploadFileBinary` — a NON-image attachment enters through
 *   dsh-client-file-upload's Web Worker (XHR for Blobs, worker-scoped fetch
 *   for streams — RT dsh-client-file-upload lib/client.js:72-152), so
 *   neither a `window.fetch` wrapper nor the typert interception sees it.
 *   What the worker's request DOES hit is the host's shared fetch-handler
 *   table: `HostConnectionService.fetchRoutes` is a plain Map the shared
 *   handler re-reads per request (`fetchRoutes.get(pathname)` then
 *   `route.fetch(request)`, RT dsh-client-connection lib/index.js:558 and
 *   ~614-617), and the upload registers `requestBody: "streaming"` with a
 *   closure `fetch` (RT dsh-client-file-upload lib/index.js:73, 171-176).
 *   Replacing that entry's `fetch` intercepts every upload at the local
 *   backend. A virtual `sessionId` rides the relay's binary channel to the
 *   server (the staged receipt then resolves under the SAME session the
 *   forwarded `session/prompt` runs against); anything else reaches the
 *   original function untouched.
 * - `/api/session.export` — a remote session's log lives on the SERVER, and
 *   a virtual id on the local route could only fail; the wrap refuses it
 *   with 403 `remote-unsupported` before the local route runs (the UI
 *   entry is hidden remotely too, remote-session.css.ts).
 *
 * The wrap is gated on a shape check like the typert one (intercept-shape
 * .ts): a future DSH that reshapes the entry must leave this install OFF
 * and local uploads exactly as they were. Uninstall restores an entry only
 * while it still holds OUR wrapper — a later wrapper chained over us keeps
 * working, and ours goes inert instead (the same posture as intercept.ts).
 */
import { RelayError } from './relay-client.js';
import { fromVirtual } from './virtual-id.js';
/** The host's upload route, verbatim from its registration (RT
 * dsh-client-file-upload lib/index.js:73). */
export const FILE_UPLOAD_PATH = '/api/session/uploadFileBinary';
/** The host's session-log export route (RT dsh-session-log-export
 * lib/index.js:488). */
export const SESSION_EXPORT_PATH = '/api/session.export';
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
/**
 * Check the RAW connection service instance against the shape the wrap
 * depends on. Pure inspection — nothing is mutated, so a failed check
 * leaves every route exactly as it was. The upload entry is REQUIRED (all
 * three facts the pump relies on); the export entry is OPTIONAL — its
 * absence is a note, not a refusal, because the export refusal is a
 * convenience over the upload channel, not its prerequisite.
 */
export function checkFetchRouteShape(connection) {
    if (!isRecord(connection) || Array.isArray(connection)) {
        return { ok: false, reasons: ['connection: not an object'] };
    }
    if (!(connection.fetchRoutes instanceof Map)) {
        return { ok: false, reasons: ['fetchRoutes: not a Map'] };
    }
    const routes = connection.fetchRoutes;
    const reasons = [];
    const notes = [];
    const upload = routes.get(FILE_UPLOAD_PATH);
    if (!isRecord(upload)) {
        reasons.push(`upload: no "${FILE_UPLOAD_PATH}" entry in fetchRoutes`);
    }
    else {
        if (!(upload.methods instanceof Set) || !upload.methods.has('POST')) {
            reasons.push('upload: methods does not admit POST');
        }
        if (typeof upload.fetch !== 'function')
            reasons.push('upload: fetch is not a function');
        if (upload.requestBody !== 'streaming') {
            reasons.push(`upload: requestBody is ${JSON.stringify(upload.requestBody ?? null)}, expected "streaming"`);
        }
    }
    const exported = routes.get(SESSION_EXPORT_PATH);
    if (!isRecord(exported)) {
        notes.push(`export: no "${SESSION_EXPORT_PATH}" entry at install time — the remote-export refusal is not installed`);
    }
    else if (typeof exported.fetch !== 'function') {
        notes.push('export: fetch is not a function — the remote-export refusal is not installed');
    }
    if (reasons.length > 0)
        return { ok: false, reasons };
    return { ok: true, notes };
}
/** Longest failure ring kept for the status surface. */
const MAX_FAILURES = 20;
/** The first value of one repeated query parameter, or `undefined` — the
 * host's own `.get()` reading (RT dsh-client-file-upload lib/index.js:20-22),
 * kept so a weird local request meets the same behavior remotely it would
 * have locally. */
function firstQuery(url, name) {
    const values = url.searchParams.getAll(name);
    return values[0];
}
/**
 * The failure envelope the browser half parses (RT dsh-client-file-upload
 * lib/client.js:272-297, `parseFileUploadResult`): code AND message AND a
 * record `details`, all required — a details-less error throws in the UI's
 * parser, so every envelope WE construct carries `details: {}`.
 */
function uploadFailure(code, message) {
    return new Response(JSON.stringify({ ok: false, error: { code, message, details: {} } }), {
        // The host's own route answers business failures with HTTP 200 + this
        // envelope (RT lib/index.js:34-55) — the shape `parseFileUploadResult`
        // turns back into a RemoteError — so a relayed refusal keeps that
        // contract and only LINK-level facts surface as real status codes.
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
}
function statusFailure(status, code, message) {
    return new Response(JSON.stringify({ ok: false, error: { code, message, details: {} } }), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
}
/** The relay codes that mean "the LINK is not usable" — 503, not a business
 * envelope (the same four the T41b http wrapper answers remote-offline
 * for). */
const LINK_DOWN_CODES = new Set(['offline', 'unpaired', 'revoked', 'incompatible']);
/**
 * Install the wrappers over the two fetch-route entries. Assumes
 * {@link checkFetchRouteShape} passed (the wiring gates on it) — the export
 * half additionally consults the verdict's `notes` to know whether its
 * entry was wrappable at all.
 */
export function installFetchRouteIntercept(options) {
    const { connection, relay, getServerId, log } = options;
    const shape = checkFetchRouteShape(connection);
    const routes = connection.fetchRoutes;
    const uploadEntry = routes.get(FILE_UPLOAD_PATH);
    const exportEntry = routes.get(SESSION_EXPORT_PATH);
    const exportWrappable = shape.ok && exportEntry !== undefined && typeof exportEntry.fetch === 'function';
    const savedUpload = uploadEntry.fetch;
    const savedExport = exportWrappable ? exportEntry.fetch : undefined;
    let installed = true;
    const failures = [];
    const counters = { uploadCalls: 0, uploadForwarded: 0, uploadRefused: 0, exportBlocked: 0 };
    const recordFailure = (route, code) => {
        if (failures.length >= MAX_FAILURES)
            failures.shift();
        failures.push({ time: new Date().toISOString(), route, code });
    };
    const wrappedUpload = async (request) => {
        counters.uploadCalls += 1;
        const passthrough = () => savedUpload.call(uploadEntry, request);
        // An uninstalled (chained-over) wrap is INERT, not absent.
        if (!installed)
            return passthrough();
        let url;
        try {
            url = new URL(request.url);
        }
        catch {
            return passthrough();
        }
        if (url.pathname !== FILE_UPLOAD_PATH)
            return passthrough();
        const sessionId = firstQuery(url, 'sessionId');
        // No id, or a LOCAL id: the original route's business, its request body
        // never touched (the pump below is the only consumer).
        const parts = sessionId === undefined || sessionId === '' ? undefined : fromVirtual(sessionId);
        if (parts === undefined)
            return passthrough();
        // Virtual from here: the local route cannot serve this id, so every
        // outcome is ours to answer.
        const serverId = getServerId();
        if (relay.state !== 'online' || serverId === undefined) {
            counters.uploadRefused += 1;
            recordFailure('upload', 'remote-offline');
            log?.('upload for %s refused: relay not online', sessionId);
            return statusFailure(503, 'remote-offline', '服务端离线，远程会话暂时无法上传文件');
        }
        if (parts.serverId !== serverId) {
            counters.uploadRefused += 1;
            recordFailure('upload', 'remote-mismatch');
            log?.('upload for %s refused: belongs to another server', sessionId);
            return statusFailure(400, 'remote-mismatch', '此远程会话属于其他主服务端');
        }
        counters.uploadForwarded += 1;
        try {
            const declaredLength = request.headers.get('content-length');
            const bytes = declaredLength !== null && declaredLength !== '' && /^\d+$/.test(declaredLength)
                ? Number(declaredLength)
                : undefined;
            // The request's own body stream rides to the server UNREAD by us; the
            // browser's abort signal rides along so a cancelled picker closes the
            // relay round-trip too.
            const result = await relay.upload({ sessionId: parts.id, name: firstQuery(url, 'name'), body: request.body, bytes }, request.signal);
            return new Response(result.body, {
                status: result.status,
                headers: {
                    'content-type': result.contentType ?? 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                },
            });
        }
        catch (error) {
            counters.uploadRefused += 1;
            const code = error instanceof RelayError ? error.code : 'internal';
            recordFailure('upload', code);
            log?.('upload for %s failed through the relay: %s', sessionId, code);
            if (error instanceof RelayError && LINK_DOWN_CODES.has(error.code)) {
                return statusFailure(503, 'remote-offline', '服务端离线，远程会话暂时无法上传文件');
            }
            // A business answer — the relay's own refusal (`not-shared`,
            // `payload-too-large`, …) or the upstream route's failure envelope —
            // keeps the host's 200-with-envelope contract, details normalized to
            // the record `parseFileUploadResult` demands.
            const message = error instanceof Error ? error.message : String(error);
            return uploadFailure(code, message);
        }
    };
    const wrappedExport = async (request) => {
        const passthrough = () => savedExport !== undefined ? savedExport.call(exportEntry, request) : Promise.resolve(new Response('not found', { status: 404 }));
        if (!installed)
            return passthrough();
        let url;
        try {
            url = new URL(request.url);
        }
        catch {
            return passthrough();
        }
        if (url.pathname !== SESSION_EXPORT_PATH)
            return passthrough();
        const sessionId = firstQuery(url, 'sessionId');
        const parts = sessionId === undefined || sessionId === '' ? undefined : fromVirtual(sessionId);
        if (parts === undefined)
            return passthrough();
        counters.exportBlocked += 1;
        recordFailure('export', 'remote-unsupported');
        return statusFailure(403, 'remote-unsupported', '远程会话不支持导出');
    };
    uploadEntry.fetch = wrappedUpload;
    if (exportWrappable)
        exportEntry.fetch = wrappedExport;
    log?.('fetch-route intercept installed (upload wrapped, export %s)', exportWrappable ? 'wrapped' : 'not present at install time');
    return {
        uninstall() {
            if (!installed)
                return;
            installed = false;
            // Only replace while the entry still holds OUR wrapper — a later
            // wrapper chained over us captured this function, and restoring the
            // original would silently drop ITS wrap. Ours goes inert instead.
            if (uploadEntry.fetch === wrappedUpload)
                uploadEntry.fetch = savedUpload;
            if (exportWrappable && exportEntry.fetch === wrappedExport) {
                ;
                exportEntry.fetch = savedExport;
            }
        },
        diagnostics() {
            return {
                installed,
                shape,
                uploadWrapped: uploadEntry.fetch === wrappedUpload,
                exportWrapped: exportWrappable && exportEntry.fetch === wrappedExport,
                ...counters,
                recentFailures: [...failures],
            };
        },
    };
}
//# sourceMappingURL=fetch-route-intercept.js.map