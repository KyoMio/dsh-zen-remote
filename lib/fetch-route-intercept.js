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
 *   with 403 `remote-unsupported` before the local route runs (the UI entry
 *   is hidden remotely too, remote-session.css.ts).
 *
 * EVERY answer the UPLOAD wrapper produces is HTTP 200 + the failure
 * envelope the browser half parses (T51-fix): dsh-client-file-upload's
 * `FileUploadRuntime.upload` throws a bare English transport error on any
 * non-200 status and never reaches `parseFileUploadResult` (RT
 * lib/client.js:190 vs 272-297) — so offline, mismatch and the local
 * oversize refusal all travel as the host's own failure shape, and the
 * Chinese message lands on the attachment card. Only the EXPORT wrapper
 * keeps a real 403: its UI (the export dialog) reads `response.ok` and
 * prints the status.
 *
 * The wrap is gated on a structural shape check like the typert one
 * (intercept-shape.ts): a future DSH without the fetchRoutes Map must leave
 * this install OFF and local uploads exactly as they were. ENTRY-LEVEL facts
 * attach per route (T51-fix): an entry that is absent at install time —
 * session-log-export may register after us — is retried on a bounded timer
 * and on each call of the OTHER wrapper; an entry that is present but
 * misshaped is refused for ITS route only (present-but-wrong never fixes
 * itself — `registerFetchRoute` throws on a duplicate path), and the rest
 * of the install still runs. Uninstall restores an entry only while it
 * still holds OUR wrapper — a later wrapper chained over us keeps working,
 * and ours goes inert instead (the same posture as intercept.ts).
 */
import { RelayError } from './relay-client.js';
import { fromVirtual } from './virtual-id.js';
import { MAX_UPLOAD_BYTES } from './relay-server.js';
/** The host's upload route, verbatim from its registration (RT
 * dsh-client-file-upload lib/index.js:73). */
export const FILE_UPLOAD_PATH = '/api/session/uploadFileBinary';
/** The host's session-log export route (RT dsh-session-log-export
 * lib/index.js:488). */
export const SESSION_EXPORT_PATH = '/api/session.export';
/** The remote upload cap, the relay's own 100 MiB (relay-server.ts explains
 * why the host has no number to mirror). Interpolated into the local
 * oversize refusal so the card names the real limit. */
const UPLOAD_CAP_MIB = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));
const OVERSIZE_MESSAGE = `文件超过远程上传上限（${UPLOAD_CAP_MIB} MiB）`;
const OFFLINE_MESSAGE = '服务端离线，远程会话暂时无法上传文件';
const MISMATCH_MESSAGE = '此远程会话属于其他主服务端';
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
/**
 * Check the RAW connection service instance against the shape the wrap
 * depends on. Pure inspection — nothing is mutated, so a failed check
 * leaves every route exactly as it was. Only the structural facts refuse;
 * the two entries' facts are described in `notes` (they attach lazily).
 */
export function checkFetchRouteShape(connection) {
    if (!isRecord(connection) || Array.isArray(connection)) {
        return { ok: false, reasons: ['connection: not an object'] };
    }
    if (!(connection.fetchRoutes instanceof Map)) {
        return { ok: false, reasons: ['fetchRoutes: not a Map'] };
    }
    const routes = connection.fetchRoutes;
    return {
        ok: true,
        notes: [
            describeEntry(routes.get(FILE_UPLOAD_PATH), 'upload', ['POST'], 'streaming'),
            describeEntry(routes.get(SESSION_EXPORT_PATH), 'export', ['GET', 'HEAD'], 'buffered'),
        ],
    };
}
/** One entry's attach-worthiness, as a human-readable note: what the table
 * held for this route at check time. */
function describeEntry(entry, label, methods, body) {
    if (!isRecord(entry))
        return `${label}: absent at check time (the attach retries)`;
    const problem = entryProblem(entry, methods, body);
    if (problem !== undefined)
        return `${label}: present but misshaped (attach refused: ${problem})`;
    return `${label}: present and attachable`;
}
/** The entry-level facts one route must prove before its wrapper may
 * install, or the reason it may not. */
function entryProblem(entry, methods, body) {
    if (!isRecord(entry))
        return 'entry is not an object';
    const admitted = entry.methods;
    if (!(admitted instanceof Set) || !methods.every((method) => admitted.has(method))) {
        return `methods does not admit ${methods.join('+')}`;
    }
    if (typeof entry.fetch !== 'function')
        return 'fetch is not a function';
    if (entry.requestBody !== body) {
        return `requestBody is ${JSON.stringify(entry.requestBody ?? null)}, expected ${JSON.stringify(body)}`;
    }
    return undefined;
}
/** Longest failure ring kept for the status surface. */
const MAX_FAILURES = 20;
/** Default lazy-attach cadence (T51-fix): every 3 s, at most 10 probes —
 * a route registered during the same startup wave lands on the first or
 * second tick, and a composition that never ships the route stops the
 * probe after half a minute. */
const DEFAULT_ATTACH_RETRY_MS = 3_000;
const DEFAULT_ATTACH_ATTEMPTS = 10;
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
 * parser, so every envelope WE construct carries `details: {}`. HTTP 200 on
 * purpose (T51-fix): the host's own route answers business failures with
 * 200 + this envelope (RT lib/index.js:34-55), and a non-200 status would
 * die in `FileUploadRuntime.upload` as a bare English transport error
 * before the envelope was ever read.
 */
function uploadFailure(code, message) {
    return new Response(JSON.stringify({ ok: false, error: { code, message, details: {} } }), {
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
/** The relay codes that mean "the LINK is not usable" — a link fact, not a
 * business answer about one call (still answered as a 200 envelope, see
 * {@link uploadFailure}). */
const LINK_DOWN_CODES = new Set(['offline', 'unpaired', 'revoked', 'incompatible']);
/**
 * Install the wrappers over the two fetch-route entries. Assumes
 * {@link checkFetchRouteShape} passed (the wiring gates on it — the gate is
 * structural only); each entry attaches on its own facts, immediately when
 * present and attachable, via the bounded retry when absent, never when
 * present-but-misshaped.
 */
export function installFetchRouteIntercept(options) {
    const { connection, relay, getServerId, log } = options;
    const attachRetryMs = options.attachRetryMs ?? DEFAULT_ATTACH_RETRY_MS;
    const attachAttempts = options.attachAttempts ?? DEFAULT_ATTACH_ATTEMPTS;
    const shape = checkFetchRouteShape(connection);
    const routes = connection.fetchRoutes;
    let installed = true;
    const failures = [];
    const counters = { uploadCalls: 0, uploadForwarded: 0, uploadRefused: 0, exportBlocked: 0 };
    // The per-route attach state. `undefined` entry = absent so far (the
    // retry may still land it); a refusal string = present-but-misshaped,
    // permanent for this install.
    let uploadEntry;
    let savedUpload;
    let uploadAttachRefused;
    let exportEntry;
    let savedExport;
    let exportAttachRefused;
    const recordFailure = (route, code) => {
        if (failures.length >= MAX_FAILURES)
            failures.shift();
        failures.push({ time: new Date().toISOString(), route, code });
    };
    const wrappedUpload = async (request) => {
        counters.uploadCalls += 1;
        // The other half may have registered while we were installing: every
        // real call re-probes a still-missing route before doing anything else.
        if (installed && exportEntry === undefined && exportAttachRefused === undefined)
            attachExport();
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
        // A DECLARED body past the relay's cap is refused locally (T51-fix):
        // the browser's XHR branch always sends Content-Length, so the honest
        // answer travels before a byte moves and a 250 MiB pick can never take
        // the connection for a doomed round-trip.
        const declaredLength = request.headers.get('content-length');
        const declared = declaredLength !== null && declaredLength !== '' && /^\d+$/.test(declaredLength) ? Number(declaredLength) : undefined;
        if (declared !== undefined && declared > MAX_UPLOAD_BYTES) {
            counters.uploadRefused += 1;
            recordFailure('upload', 'payload-too-large');
            log?.('upload for %s refused locally: payload-too-large (%s declared)', sessionId, declaredLength);
            return uploadFailure('payload-too-large', OVERSIZE_MESSAGE);
        }
        const serverId = getServerId();
        if (relay.state !== 'online' || serverId === undefined) {
            counters.uploadRefused += 1;
            recordFailure('upload', 'remote-offline');
            log?.('upload for %s refused: relay not online', sessionId);
            return uploadFailure('remote-offline', OFFLINE_MESSAGE);
        }
        if (parts.serverId !== serverId) {
            counters.uploadRefused += 1;
            recordFailure('upload', 'remote-mismatch');
            log?.('upload for %s refused: belongs to another server', sessionId);
            return uploadFailure('remote-mismatch', MISMATCH_MESSAGE);
        }
        counters.uploadForwarded += 1;
        try {
            // The request's own body stream rides to the server UNREAD by us; the
            // browser's abort signal rides along so a cancelled picker closes the
            // relay round-trip too.
            const result = await relay.upload({ sessionId: parts.id, name: firstQuery(url, 'name'), body: request.body, bytes: declared }, request.signal);
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
                // A link fact — but still the parseable 200 envelope (T51-fix): the
                // transport error the UI would otherwise show for a non-200 says
                // nothing a user can act on.
                return uploadFailure('remote-offline', OFFLINE_MESSAGE);
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
        if (installed && uploadEntry === undefined && uploadAttachRefused === undefined)
            attachUpload();
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
    // ---- the per-route attach (T51-fix) --------------------------------------
    /** Attach the upload wrapper to its entry, or answer whether the retry
     * should stop: `true` = attached, or permanently refused; `false` = still
     * absent, keep probing. */
    const attachUpload = () => {
        if (!installed)
            return true;
        if (uploadEntry !== undefined)
            return true;
        const candidate = routes.get(FILE_UPLOAD_PATH);
        if (candidate === undefined)
            return false;
        const problem = entryProblem(candidate, ['POST'], 'streaming');
        if (problem !== undefined) {
            uploadAttachRefused = problem;
            log?.('upload route attach refused: %s', problem);
            return true;
        }
        uploadEntry = candidate;
        savedUpload = uploadEntry.fetch;
        uploadEntry.fetch = wrappedUpload;
        log?.('upload route attached');
        return true;
    };
    /** The export half of {@link attachUpload}. */
    const attachExport = () => {
        if (!installed)
            return true;
        if (exportEntry !== undefined)
            return true;
        const candidate = routes.get(SESSION_EXPORT_PATH);
        if (candidate === undefined)
            return false;
        const problem = entryProblem(candidate, ['GET', 'HEAD'], 'buffered');
        if (problem !== undefined) {
            exportAttachRefused = problem;
            log?.('export route attach refused: %s', problem);
            return true;
        }
        exportEntry = candidate;
        savedExport = exportEntry.fetch;
        exportEntry.fetch = wrappedExport;
        log?.('export route attached');
        return true;
    };
    // First attach, right now: whatever the table already held is wrapped
    // before this returns.
    attachUpload();
    attachExport();
    // The bounded retry for what was absent (T51-fix): a probe every
    // attachRetryMs, at most attachAttempts of them, stopped early once
    // nothing is pending. `unref()`ed — startup ordering must never hold the
    // process open for a route that may never come.
    let attempts = 1;
    let retryTimer;
    const stopRetrying = () => {
        if (retryTimer !== undefined) {
            clearInterval(retryTimer);
            retryTimer = undefined;
        }
    };
    const stillPending = () => uploadEntry === undefined || exportEntry === undefined;
    if (stillPending() && attempts < attachAttempts) {
        retryTimer = setInterval(() => {
            attempts += 1;
            attachUpload();
            attachExport();
            if (!stillPending() || attempts >= attachAttempts)
                stopRetrying();
        }, attachRetryMs);
        if (typeof retryTimer.unref === 'function')
            retryTimer.unref();
    }
    return {
        uninstall() {
            if (!installed)
                return;
            installed = false;
            stopRetrying();
            // Only replace while the entry still holds OUR wrapper — a later
            // wrapper chained over us captured this function, and restoring the
            // original would silently drop ITS wrap. Ours goes inert instead.
            if (uploadEntry !== undefined && uploadEntry.fetch === wrappedUpload)
                uploadEntry.fetch = savedUpload;
            if (exportEntry !== undefined && exportEntry.fetch === wrappedExport)
                exportEntry.fetch = savedExport;
        },
        diagnostics() {
            return {
                installed,
                shape,
                uploadWrapped: uploadEntry !== undefined && uploadEntry.fetch === wrappedUpload,
                exportWrapped: exportEntry !== undefined && exportEntry.fetch === wrappedExport,
                uploadPending: installed && uploadEntry === undefined && uploadAttachRefused === undefined,
                exportPending: installed && exportEntry === undefined && exportAttachRefused === undefined,
                uploadAttachRefused,
                exportAttachRefused,
                ...counters,
                recentFailures: [...failures],
            };
        },
    };
}
//# sourceMappingURL=fetch-route-intercept.js.map