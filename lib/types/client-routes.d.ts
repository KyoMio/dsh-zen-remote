/**
 * Sub-client backend routes (T16): pairing claim and connection status for a
 * DSH process running `role: 'client'` — this machine's settings page is the
 * ONLY browser surface that talks to them, same-origin like the host's admin
 * routes (T14). The claim route forwards the pairing code to the SERVER's
 * gateway (`<serverUrl>/lan-gate/pair/claim-desktop`) and hands the returned
 * token straight back to the browser, which writes it into the row's
 * `deviceToken` secret field; this process itself never persists or logs the
 * token — it only ever puts it into an Authorization header for the status
 * probe. The status route reads `serverUrl` / `deviceToken` from the plugin
 * ROW PER REQUEST (both are volatile `{ get() }`-wrapped fields, so the row
 * object `apply()` received is the only live source) and probes the server's
 * relay ping, reporting one of the five connection states.
 *
 * Same walls as the admin routes, in the same order: `admit` first (webServer
 * routes skip DSH's /api authentication), then for the POST also the
 * same-origin gate and a 16 KiB JSON-object body cap. Built by a factory so
 * the tests drive it over a real socket with a mock server gateway.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminAdmission } from './admin-routes.js';
/** Prefix all client routes live under (one webServer prefix registration). */
export declare const CLIENT_ROUTE_PREFIX = "/_dsh/zen-remote/client";
/** POST `{serverUrl, code, name}`: redeem a desktop pairing code. */
export declare const CLIENT_CLAIM_ROUTE = "/_dsh/zen-remote/client/claim";
/** GET: the current connection state (never carries the token). */
export declare const CLIENT_STATUS_ROUTE = "/_dsh/zen-remote/client/status";
/** The fetch face this module needs; injectable for tests. */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
export interface ClientHandlerOptions {
    /** The connection service's admit, injected by apply(); tests fake it. */
    admit: (req: IncomingMessage) => AdminAdmission;
    /** The plugin ROW as apply() received it — `serverUrl` / `deviceToken` are
     * volatile, so they must be read through this at request time, never
     * snapshotted at registration. */
    getRowConfig: () => unknown;
    /** Outbound fetch, defaulting to the global one. */
    fetchImpl?: FetchLike;
}
export type ClientHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/**
 * Build the client route handler for one plugin row. The returned handler
 * owns the full response lifecycle of every request under
 * {@link CLIENT_ROUTE_PREFIX} and never throws.
 */
export declare function createClientHandler(options: ClientHandlerOptions): ClientHandler;
//# sourceMappingURL=client-routes.d.ts.map