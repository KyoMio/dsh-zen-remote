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
 *
 * T41b adds the plain-HTTP relay under `client/http/<route>`: the GETs the
 * browser fetch wrapper intercepted (`/api/changes.summary` / `changes.diff`
 * naming a virtual session id) are re-issued here through the relay client's
 * `http()` with the original id restored, and the upstream status,
 * content type and body travel back verbatim.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminAdmission } from './admin-routes.js';
import type { FetchRouteInterceptDiagnostics } from './fetch-route-intercept.js';
import type { InterceptDiagnostics } from './intercept.js';
import type { RelayClient } from './relay-client.js';
/** Prefix all client routes live under (one webServer prefix registration). */
export declare const CLIENT_ROUTE_PREFIX = "/_dsh/zen-remote/client";
/** POST `{serverUrl, code, name}`: redeem a desktop pairing code. */
export declare const CLIENT_CLAIM_ROUTE = "/_dsh/zen-remote/client/claim";
/** GET: the current connection state (never carries the token). */
export declare const CLIENT_STATUS_ROUTE = "/_dsh/zen-remote/client/status";
/** POST: one immediate reconnect attempt (T43, the settings page's 立即重连);
 * answered 409 unless the relay client is currently `offline`. */
export declare const CLIENT_RECONNECT_ROUTE = "/_dsh/zen-remote/client/reconnect";
/** GET: the remote-session status the T34 client parts render from (T34) —
 * the relay's serving state, the interface-compatibility verdict, the
 * handshake's server name, and the closed-session map. The prefix is
 * registered on BOTH roles (T34-fix): a host — no relay client wired —
 * answers the empty `{state:'unpaired', versionMismatch:false, serverName:'',
 * closed:{}}` conclusion. It carries no token and no server address. */
export declare const CLIENT_REMOTE_STATUS_ROUTE = "/_dsh/zen-remote/client/remote-status";
/** POST `{sessionId: <虚拟 id>}`: close one remote session from THIS machine
 * (T34) — the backend forwards the ORIGINAL id through the relay's
 * `POST relay/v1/unshare`, so the server closes it with reason `'client'`. */
export declare const CLIENT_UNSHARE_ROUTE = "/_dsh/zen-remote/client/unshare";
/** Prefix of the plain-HTTP relay routes (T41b):
 * `GET ${CLIENT_HTTP_ROUTE_PREFIX}<route>?<query>` relays one intercepted
 * `/api/<route>` call (the fetch wrapper's rewrites land here) to the
 * server, with the virtual session id swapped back to the original. */
export declare const CLIENT_HTTP_ROUTE_PREFIX = "/_dsh/zen-remote/client/http/";
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
    /** The live relay client (T23a), once apply() built one. When it has LEFT
     * its initial `unpaired` state — a connection attempt ran — the status
     * route reports ITS verdict (state + handshake server name) and skips the
     * ping probe; the probe below stays as the fallback for a client that
     * never connected, so the settings page still gets a fresh answer while
     * the startup `connect()` is still unpaired. */
    getRelayClient?: () => RelayClient | undefined;
    /** The typert interception's diagnostics (T23b-1), read live per request.
     * Shapes, counters and failure codes only — never a token. Undefined when
     * this composition never even attempted an install (no typertGateway). */
    getIntercept?: () => InterceptDiagnostics | undefined;
    /** The exact-fetch-route interception's diagnostics (T51), read live per
     * request: the local upload route's remote-forwarding install state and
     * its refusal counters. Undefined when this composition never attempted
     * one (no connection service, or no fileUploads service to inject). */
    getFetchRouteIntercept?: () => FetchRouteInterceptDiagnostics | undefined;
    /** Serve ONLY the remote-status route (T41a-fix2, the host role's mount):
     * every other route under the prefix answers the same 404 an unknown path
     * would. The claim / status / reconnect / unshare routes exist for a
     * CLIENT — a host carries no relay client and no pairing surface, so
     * answering them (even with their empty conclusions) is exposure without
     * a user. The remote-status route stays: the T34 client parts poll it on
     * whatever role this process runs. */
    remoteStatusOnly?: boolean;
}
export type ClientHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/**
 * Build the client route handler for one plugin row. The returned handler
 * owns the full response lifecycle of every request under
 * {@link CLIENT_ROUTE_PREFIX} and never throws.
 */
export declare function createClientHandler(options: ClientHandlerOptions): ClientHandler;
//# sourceMappingURL=client-routes.d.ts.map