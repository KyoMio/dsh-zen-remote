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
import type { RelayClient } from './relay-client.js';
/** The host's upload route, verbatim from its registration (RT
 * dsh-client-file-upload lib/index.js:73). */
export declare const FILE_UPLOAD_PATH = "/api/session/uploadFileBinary";
/** The host's session-log export route (RT dsh-session-log-export
 * lib/index.js:488). */
export declare const SESSION_EXPORT_PATH = "/api/session.export";
/** Verdict of {@link checkFetchRouteShape}. STRUCTURAL only: `ok` answers
 * "is this a connection service with a fetch-route table at all"; each
 * route's entry findings travel as `notes` — present/absent/misshaped — and
 * the per-route attach decisions are the install's business (T51-fix). */
export type FetchRouteShapeCheck = {
    ok: true;
    notes: string[];
} | {
    ok: false;
    reasons: string[];
};
/** One exact-fetch route entry, as `registerFetchRoute` stores it (RT
 * dsh-client-connection lib/index.js:627-631). */
export interface FetchRouteEntry {
    methods: Set<string>;
    requestBody: string;
    fetch: (request: Request) => Promise<Response>;
}
/**
 * Check the RAW connection service instance against the shape the wrap
 * depends on. Pure inspection — nothing is mutated, so a failed check
 * leaves every route exactly as it was. Only the structural facts refuse;
 * the two entries' facts are described in `notes` (they attach lazily).
 */
export declare function checkFetchRouteShape(connection: unknown): FetchRouteShapeCheck;
/** One refusal the wrappers answered, in the diagnostics ring. */
export interface FetchRouteFailureRecord {
    /** ISO timestamp of the moment the refusal was answered. */
    time: string;
    /** Which wrapper answered it. */
    route: 'upload' | 'export';
    code: string;
}
/** What the client status route surfaces about this interception: flags,
 * counters and codes only — never a token, never a server address. */
export interface FetchRouteInterceptDiagnostics {
    installed: boolean;
    shape: FetchRouteShapeCheck;
    /** The upload entry currently holds our wrapper. */
    uploadWrapped: boolean;
    /** The export entry currently holds our wrapper (false while absent or
     * refused). */
    exportWrapped: boolean;
    /** The upload entry was absent at last check and the attach retry is
     * still running (T51-fix). */
    uploadPending: boolean;
    /** The export entry was absent at last check and the attach retry is
     * still running (T51-fix). */
    exportPending: boolean;
    /** The upload entry was present but misshaped — attach refused for THIS
     * route only; the reason is stable diagnostics text (T51-fix). */
    uploadAttachRefused: string | undefined;
    /** Same, for the export entry. */
    exportAttachRefused: string | undefined;
    /** Every upload that entered the wrapper, local passthroughs included. */
    uploadCalls: number;
    /** Uploads forwarded through the relay (virtual ids only). */
    uploadForwarded: number;
    /** Uploads refused locally (oversize, offline, mismatch, relay
     * refusals, relay transport death). */
    uploadRefused: number;
    /** Export requests blocked with `remote-unsupported`. */
    exportBlocked: number;
    /** The most recent refusals, oldest first, capped. */
    recentFailures: FetchRouteFailureRecord[];
}
export interface InstallFetchRouteInterceptOptions {
    /** The RAW connection service instance
     * (`ctx.connection[symbols.original]`) — the one whose `fetchRoutes` Map
     * the shared handler reads per request. */
    connection: object;
    /** The client relay client (T23a) the uploads travel through. */
    relay: RelayClient;
    /** The CURRENT handshake's server id, read live per call; `undefined`
     * makes every remote upload a `remote-offline`. */
    getServerId: () => string | undefined;
    /** Progress logging, wired to the context logger by index.ts. */
    log?: (format: string, ...args: unknown[]) => void;
    /** The lazy-attach retry cadence (T51-fix): how often the table is
     * re-probed for entries that were absent at install, and how many probes
     * before giving up. Defaults 3000 ms × 10; tests shrink both. */
    attachRetryMs?: number;
    attachAttempts?: number;
}
export interface FetchRouteInterceptHandle {
    /** Restore every attached entry — each ONLY while it still holds our
     * wrapper — and stop the attach retry. Idempotent. After it ran, the
     * wrappers stay installed-but-inert if someone had chained over them
     * (same posture as intercept.ts). */
    uninstall(): void;
    /** The status-route view. */
    diagnostics(): FetchRouteInterceptDiagnostics;
}
/**
 * Install the wrappers over the two fetch-route entries. Assumes
 * {@link checkFetchRouteShape} passed (the wiring gates on it — the gate is
 * structural only); each entry attaches on its own facts, immediately when
 * present and attachable, via the bounded retry when absent, never when
 * present-but-misshaped.
 */
export declare function installFetchRouteIntercept(options: InstallFetchRouteInterceptOptions): FetchRouteInterceptHandle;
//# sourceMappingURL=fetch-route-intercept.d.ts.map