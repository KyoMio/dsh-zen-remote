/**
 * Wizard route skeleton (GW-4): every `/_dsh/zen-remote/admin/wizard/*`
 * route the gateway wizard serves, with the security walls applied to ALL
 * of them, in this order:
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
 * The skeleton serves exactly one real route — `GET /wizard/status`, the
 * sanitized projection from status.ts, which reads only (never mutates) —
 * plus 501 placeholders for every POST under the prefix; later tasks fill
 * those in. GET /status answers from a per-request config resolution and
 * the injected runtime probe; a throwing runtime probe degrades to
 * "nothing configured" instead of failing the read.
 *
 * The handler is built by a factory so the tests drive it over a real
 * socket with mock admit/config (same seam as the admin routes).
 */
import { responseJson, sameOriginPost } from '../http.js';
import { projectWizardStatus } from './status.js';
/** Prefix all wizard routes live under (one webServer prefix registration;
 * the host web server matches longest-prefix-first, so these win over the
 * plain admin prefix registration). */
export const WIZARD_ROUTE_PREFIX = '/_dsh/zen-remote/admin/wizard';
/** GET: the sanitized wizard status projection. */
export const WIZARD_STATUS_ROUTE = `${WIZARD_ROUTE_PREFIX}/status`;
/**
 * Build the wizard route handler for one plugin row. The returned handler
 * owns the full response lifecycle of every request under
 * {@link WIZARD_ROUTE_PREFIX} and never throws.
 */
export function createWizardHandler(options) {
    return async (req, res) => {
        // EVERYTHING rides inside the one guard (GW-fix-1/L1): a malformed
        // req.url explodes in `new URL`, and a broken connection service can
        // throw out of admit — neither may escape as an unhandled rejection,
        // the handler owns the full response lifecycle, always.
        try {
            // Wall 1 first: DSH's own admission.
            const admission = options.admit(req);
            if ('rejection' in admission) {
                responseJson(res, admission.rejection, {
                    ok: false,
                    error: { code: admission.rejection === 401 ? 'unauthorized' : 'forbidden' },
                });
                return;
            }
            const url = new URL(req.url ?? '/', 'http://dsh.internal');
            const route = url.pathname;
            const method = req.method ?? 'GET';
            // Wall 2, on EVERY wizard route before anything else: unlike
            // admin/status there is no remote-readable exception — the wizard is
            // a server-owner surface, GET included. This runs BEFORE same-origin
            // because a forwarded request presents as same-origin (the gateway
            // rewrites Origin/Host); the marker is the identifying signal.
            if (req.headers['x-zen-remote-via'] !== undefined) {
                responseJson(res, 403, {
                    ok: false,
                    error: { code: 'via-gateway', message: '配置引导只能在服务端本机操作' },
                });
                return;
            }
            if (route === WIZARD_STATUS_ROUTE && method === 'GET') {
                let runtime = {};
                try {
                    runtime = options.getRuntime?.() ?? {};
                }
                catch {
                    // A broken runtime probe is "no information", never a failed read.
                    runtime = {};
                }
                responseJson(res, 200, projectWizardStatus(options.getConfig().values, runtime));
                return;
            }
            if (route.startsWith(`${WIZARD_ROUTE_PREFIX}/`)) {
                if (method === 'POST') {
                    if (!sameOriginPost(req)) {
                        responseJson(res, 403, {
                            ok: false,
                            error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                        });
                        return;
                    }
                    // Skeleton placeholder: later tasks mount the real verbs here.
                    responseJson(res, 501, {
                        ok: false,
                        error: { code: 'not-implemented', message: 'This wizard step is not wired up yet' },
                    });
                    return;
                }
                if (method === 'GET') {
                    // Unknown GET under the wizard prefix: 404, after the walls.
                    responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown wizard route' } });
                    return;
                }
                res.setHeader('Allow', 'GET, POST');
                responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET or POST' } });
                return;
            }
            responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown wizard route' } });
        }
        catch {
            if (!res.headersSent) {
                responseJson(res, 500, { ok: false, error: { code: 'internal', message: 'The wizard route failed' } });
            }
            else {
                res.destroy();
            }
        }
    };
}
//# sourceMappingURL=routes.js.map