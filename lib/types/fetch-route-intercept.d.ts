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
import type { RelayClient } from './relay-client.js';
/** The host's upload route, verbatim from its registration (RT
 * dsh-client-file-upload lib/index.js:73). */
export declare const FILE_UPLOAD_PATH = "/api/session/uploadFileBinary";
/** The host's session-log export route (RT dsh-session-log-export
 * lib/index.js:488). */
export declare const SESSION_EXPORT_PATH = "/api/session.export";
/** Verdict of {@link checkFetchRouteShape}. `notes` record non-fatal facts —
 * the export entry missing at install time only means the export refusal is
 * not installed (the upload wrap is the load-bearing half). */
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
 * leaves every route exactly as it was. The upload entry is REQUIRED (all
 * three facts the pump relies on); the export entry is OPTIONAL — its
 * absence is a note, not a refusal, because the export refusal is a
 * convenience over the upload channel, not its prerequisite.
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
    /** The export entry currently holds our wrapper (false when the entry was
     * absent or misshaped at install time). */
    exportWrapped: boolean;
    /** Every upload that entered the wrapper, local passthroughs included. */
    uploadCalls: number;
    /** Uploads forwarded through the relay (virtual ids only). */
    uploadForwarded: number;
    /** Uploads refused locally (offline, mismatch, relay refusals, relay
     * transport death). */
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
}
export interface FetchRouteInterceptHandle {
    /** Restore both entries — each ONLY while it still holds our wrapper.
     * Idempotent. After it ran, the wrappers stay installed-but-inert if
     * someone had chained over them (same posture as intercept.ts). */
    uninstall(): void;
    /** The status-route view. */
    diagnostics(): FetchRouteInterceptDiagnostics;
}
/**
 * Install the wrappers over the two fetch-route entries. Assumes
 * {@link checkFetchRouteShape} passed (the wiring gates on it) — the export
 * half additionally consults the verdict's `notes` to know whether its
 * entry was wrappable at all.
 */
export declare function installFetchRouteIntercept(options: InstallFetchRouteInterceptOptions): FetchRouteInterceptHandle;
//# sourceMappingURL=fetch-route-intercept.d.ts.map