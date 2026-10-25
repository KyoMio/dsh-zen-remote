/**
 * Wizard route skeleton (GW-4, extended by GW-5): every
 * `/_dsh/zen-remote/admin/wizard/*` route the gateway wizard serves, with
 * the security walls applied to ALL of them, in this order:
 *
 *   1. `connection.admit` — webServer-registered routes skip DSH's `/api`
 *      authentication, so each request asks the connection service first;
 *      its rejection is relayed verbatim (401/403).
 *   2. The gateway marker. A request wearing `x-zen-remote-via` came
 *      THROUGH the gateway from a remote device. Unlike the admin status
 *      route there is no read-only exception: the wizard is a server-owner
 *      surface, and a remote device gets a flat 403 `via-gateway` — GET
 *      included. The marker wall runs BEFORE same-origin because a
 *      forwarded request presents as same-origin (the gateway rewrites
 *      Origin/Host onto the upstream origin); the marker is the only thing
 *      identifying it.
 *   3. `sameOriginPost` for every POST.
 *
 * Real routes: `GET /wizard/status` (the sanitized projection from
 * status.ts — reads only, never mutates) and, since GW-5, `POST
 * /wizard/trust-proxy` (merge one detected proxy IP into the persisted
 * `trustedProxies` list). Every other POST under the prefix is a 501
 * placeholder; later tasks fill those in. GET /status answers from a
 * per-request config resolution and the injected runtime probe; a throwing
 * runtime probe degrades to "nothing configured" instead of failing the
 * read.
 *
 * The handler is built by a factory so the tests drive it over a real
 * socket with mock admit/config (same seam as the admin routes).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminAdmission, AdminConfigSnapshot } from '../admin-routes.js';
import type { ConfigSource } from '../config.js';
import { type WizardRuntimeInput } from './status.js';
/** Prefix all wizard routes live under (one webServer prefix registration;
 * the host web server matches longest-prefix-first, so these win over the
 * plain admin prefix registration). */
export declare const WIZARD_ROUTE_PREFIX = "/_dsh/zen-remote/admin/wizard";
/** GET: the sanitized wizard status projection. */
export declare const WIZARD_STATUS_ROUTE = "/_dsh/zen-remote/admin/wizard/status";
/** POST `{ip}`: merge one detected reverse-proxy IP into the persisted
 * trustedProxies (GW-5). */
export declare const WIZARD_TRUST_PROXY_ROUTE = "/_dsh/zen-remote/admin/wizard/trust-proxy";
export interface WizardHandlerOptions {
    /** The connection service's admit, injected by apply(); tests fake it. */
    admit: (req: IncomingMessage) => AdminAdmission;
    /** Fresh resolveConfig() per call — the ingress fields are volatile row
     * fields and must not go stale. */
    getConfig: () => AdminConfigSnapshot;
    /** The live wizard runtime facts (token presence as booleans, process
     * liveness, the gateway's actual port, probe memories, the untrusted-
     * proxy detection), read PER REQUEST. MAY be async (the GW-5 wiring
     * rounds-trips the gateway's own status). MUST be read-only — GET
     * /status calls it, and a GET never changes state. Absent means
     * "nothing configured, nothing running"; a throw is degraded to the
     * same. Later tasks inject the real probe. */
    getRuntime?: () => WizardRuntimeInput | Promise<WizardRuntimeInput>;
    /** The trust-proxy persistence (GW-5, GW-fix-2/L2), injected by apply():
     * the CURRENTLY resolved trustedProxies with its layer, and the atomic
     * persister for a merged list. `write` re-checks the persisted surface
     * against `expected` (the value `resolved` answered moments earlier) —
     * answering false when another writer moved it in between, which the
     * route turns into a 409 instead of a silent clobber. Absent — a wiring
     * that predates GW-5 — and the route answers 501 like the other
     * placeholders. */
    trustProxy?: {
        resolved: () => {
            value: string;
            source: ConfigSource;
        };
        write: (expected: string, list: string) => boolean | Promise<boolean>;
    };
}
export type WizardHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/**
 * Build the wizard route handler for one plugin row. The returned handler
 * owns the full response lifecycle of every request under
 * {@link WIZARD_ROUTE_PREFIX} and never throws.
 */
export declare function createWizardHandler(options: WizardHandlerOptions): WizardHandler;
//# sourceMappingURL=routes.d.ts.map