/**
 * Admin routes for the 2.0.0 settings surface (T14): pairing, device
 * management and a push test, driven from the DSH plugin page's settings
 * block (the T15 client half) instead of the gateway's own admin page.
 *
 * Why these live in the HOST process rather than the gateway: the gateway's
 * admin API is loopback-only by design (isLocalDirect — loopback peer, no
 * X-Forwarded-* headers), while a browser page runs on DSH's origin, never
 * on the gateway's. So the browser talks to THESE same-origin routes and
 * this module then calls the gateway AS the local machine — a bare
 * `http://127.0.0.1:<port>` request with hand-built headers (no cookies, no
 * Origin, no forwarded anything) that `isLocalDirect` admits.
 *
 * Two walls every route applies, in order:
 *
 *   1. `admit` — routes registered via webServer.register do NOT pass
 *      through DSH's `/api` authentication, so each request must ask the
 *      connection service itself; its rejection is relayed verbatim.
 *   2. The gateway marker. A request wearing `x-zen-remote-via` arrived
 *      THROUGH the gateway from a remote device (the gateway strips
 *      client-forged copies before stamping its own). POSTs are refused —
 *      pairing and device management are server-side acts. GET status is
 *      answered, but with the live pairing code stripped. The marker wall
 *      runs BEFORE same-origin because a forwarded request presents as
 *      same-origin (the gateway rewrites Origin/Host), so the marker is the
 *      only thing identifying it.
 *
 * Every POST additionally passes sameOriginPost, and bodies are capped at
 * 16 KiB of JSON object. The handler is built by a factory so the tests can
 * drive it over a real socket with a mock gateway and a mock admit.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConfigSource, ZenRemoteConfig } from './config.js';
/** Prefix all admin routes live under (one webServer prefix registration). */
export declare const ADMIN_ROUTE_PREFIX = "/_dsh/zen-remote/admin";
/** GET: the gateway's status verbatim plus the effective config; remote
 * callers get the live pairing code stripped. */
export declare const ADMIN_STATUS_ROUTE = "/_dsh/zen-remote/admin/status";
/** POST `{role}`: mint a pairing code. */
export declare const ADMIN_PAIR_ROUTE = "/_dsh/zen-remote/admin/pair";
/** POST `{action, id?, role?, kind?, name?}`: device management, whitelist below. */
export declare const ADMIN_ACTION_ROUTE = "/_dsh/zen-remote/admin/action";
/** POST: fire one fixed test notification through the gateway. */
export declare const ADMIN_PUSH_TEST_ROUTE = "/_dsh/zen-remote/admin/push-test";
/** What `connection.admit` answers: the operator peer, or the refusal status. */
export type AdminAdmission = {
    readonly peer: unknown;
} | {
    readonly rejection: 401 | 403;
};
/** The effective-config snapshot resolveConfig() produces, recomputed per request. */
export interface AdminConfigSnapshot {
    values: ZenRemoteConfig;
    sources: Record<keyof ZenRemoteConfig, ConfigSource>;
}
export interface AdminHandlerOptions {
    /** The connection service's admit, injected by apply(); tests fake it. */
    admit: (req: IncomingMessage) => AdminAdmission;
    /** Gateway root — `http://127.0.0.1:<port>` in production. */
    gatewayBase: string;
    /** Fresh resolveConfig() per call — volatile row fields must not go stale,
     * and the test-push copy reads its `lang` from here per request. */
    getConfig: () => AdminConfigSnapshot;
    /** Longest wait for one gateway round-trip, defaulting to 5s. Tests inject
     * a short value so a silent gateway fails the request in milliseconds. */
    timeoutMs?: number;
}
export type AdminHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/**
 * Build the admin route handler for one plugin row. The returned handler
 * owns the full response lifecycle of every request under
 * {@link ADMIN_ROUTE_PREFIX} and never throws.
 */
export declare function createAdminHandler(options: AdminHandlerOptions): AdminHandler;
//# sourceMappingURL=admin-routes.d.ts.map