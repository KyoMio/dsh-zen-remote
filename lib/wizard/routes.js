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
import { responseJson, sameOriginPost } from '../http.js';
import { hostOf } from '../config.js';
import { normalizeTrustedIp, mergeProxyList, parseProxyList } from './source-detect.js';
import { projectWizardStatus } from './status.js';
/** Prefix all wizard routes live under (one webServer prefix registration;
 * the host web server matches longest-prefix-first, so these win over the
 * plain admin prefix registration). */
export const WIZARD_ROUTE_PREFIX = '/_dsh/zen-remote/admin/wizard';
/** GET: the sanitized wizard status projection. */
export const WIZARD_STATUS_ROUTE = `${WIZARD_ROUTE_PREFIX}/status`;
/** POST `{ip}`: merge one detected reverse-proxy IP into the persisted
 * trustedProxies (GW-5). */
export const WIZARD_TRUST_PROXY_ROUTE = `${WIZARD_ROUTE_PREFIX}/trust-proxy`;
/** POST `{publicUrl}`: start the final verification — mint the web pairing
 * code (GW-9). GET: poll its status. */
export const WIZARD_VERIFY_ROUTE = `${WIZARD_ROUTE_PREFIX}/verify`;
/** POST `{token}`: store the Cloudflare API token 0600 on this machine;
 * DELETE: stop the consumers and remove it (GW-13a). */
export const WIZARD_CF_TOKEN_ROUTE = `${WIZARD_ROUTE_PREFIX}/cf-token`;
/** POST `{token}`: store the cloudflared connector token (GW-13a). */
export const WIZARD_TUNNEL_TOKEN_ROUTE = `${WIZARD_ROUTE_PREFIX}/tunnel-token`;
/** POST: start the managed Caddy from the saved row config; POST (stop)
 * terminates it; GET answers its three-state (GW-13a). */
export const WIZARD_CADDY_START_ROUTE = `${WIZARD_ROUTE_PREFIX}/caddy/start`;
export const WIZARD_CADDY_STOP_ROUTE = `${WIZARD_ROUTE_PREFIX}/caddy/stop`;
export const WIZARD_CADDY_STATUS_ROUTE = `${WIZARD_ROUTE_PREFIX}/caddy/status`;
/** POST `{domain}`: the zone/account probe the migration card re-checks;
 * POST `{domain, tunnelId?}`: the full tunnel setup; POST (stop) and GET
 * (three-state) mirror the Caddy pair (GW-13b). */
export const WIZARD_TUNNEL_CHECK_ROUTE = `${WIZARD_ROUTE_PREFIX}/tunnel/check-domain`;
export const WIZARD_TUNNEL_SETUP_ROUTE = `${WIZARD_ROUTE_PREFIX}/tunnel/setup`;
export const WIZARD_TUNNEL_STOP_ROUTE = `${WIZARD_ROUTE_PREFIX}/tunnel/stop`;
export const WIZARD_TUNNEL_STATUS_ROUTE = `${WIZARD_ROUTE_PREFIX}/tunnel/status`;
/** Inbound body cap — the wizard forms send a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024;
/**
 * Read the whole body under the cap and demand one JSON object. An empty
 * body counts as `{}`. Answers null for anything malformed — the route
 * maps that to 400.
 */
async function readJsonObject(req) {
    const declared = req.headers['content-length'];
    const expected = declared === undefined ? undefined : Number(declared);
    if (expected !== undefined && Number.isSafeInteger(expected) && expected > MAX_BODY_BYTES)
        return null;
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES)
            return null;
        chunks.push(bytes);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '')
        return {};
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
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
                    runtime = (await options.getRuntime?.()) ?? {};
                }
                catch {
                    // A broken runtime probe is "no information", never a failed read.
                    runtime = {};
                }
                responseJson(res, 200, projectWizardStatus(options.getConfig().values, runtime));
                return;
            }
            if (route === WIZARD_TRUST_PROXY_ROUTE && method === 'POST') {
                if (!sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                const trust = options.trustProxy;
                // A wiring that predates GW-5 has no persister: same answer as the
                // other unwired verbs.
                if (trust === undefined) {
                    responseJson(res, 501, { ok: false, error: { code: 'not-implemented', message: 'This wizard step is not wired up yet' } });
                    return;
                }
                const body = await readJsonObject(req);
                if (body === null) {
                    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'request body must be a JSON object' } });
                    return;
                }
                const ip = normalizeTrustedIp(body.ip);
                if (ip === undefined) {
                    responseJson(res, 400, { ok: false, error: { code: 'bad-ip', message: 'ip must be an IPv4 or IPv6 literal' } });
                    return;
                }
                let resolved;
                try {
                    resolved = trust.resolved();
                }
                catch {
                    resolved = { value: '', source: 'default' };
                }
                // env / row values SHADOW the file layer the persister writes: a
                // write there would silently do nothing. Refuse honestly instead.
                if (resolved.source === 'env' || resolved.source === 'row') {
                    responseJson(res, 409, {
                        ok: false,
                        error: {
                            code: 'proxy-list-shadowed',
                            message: `trustedProxies 目前由${resolved.source === 'env' ? '环境变量' : '插件行配置'}提供，请先清掉那边的值再自动信任`,
                        },
                    });
                    return;
                }
                if (parseProxyList(resolved.value).includes(ip)) {
                    responseJson(res, 200, { ok: true, added: false });
                    return;
                }
                const merged = mergeProxyList(resolved.value, ip);
                // GW-fix-2/L2: the persister re-reads the persisted surface and
                // refuses when it moved since `resolved()` — two 信任 clicks in
                // quick succession must not lose either IP.
                const landed = await trust.write(resolved.value, merged);
                if (landed === false) {
                    responseJson(res, 409, {
                        ok: false,
                        error: { code: 'trust-list-changed', message: '信任列表刚被其他操作修改，请刷新后重试' },
                    });
                    return;
                }
                responseJson(res, 200, { ok: true, added: true });
                return;
            }
            if (route === WIZARD_CF_TOKEN_ROUTE && (method === 'POST' || method === 'DELETE')) {
                if (!sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                const store = options.tokenStore;
                if (store === undefined) {
                    responseJson(res, 501, { ok: false, error: { code: 'not-implemented', message: 'This wizard step is not wired up yet' } });
                    return;
                }
                if (method === 'DELETE') {
                    store.deleteCfToken();
                    responseJson(res, 200, { ok: true, configured: false });
                    return;
                }
                const body = await readJsonObject(req);
                const token = typeof body?.token === 'string' ? body.token.trim() : '';
                if (token === '') {
                    responseJson(res, 400, { ok: false, error: { code: 'bad-token', message: 'token must be a non-empty string' } });
                    return;
                }
                store.writeCfToken(token);
                responseJson(res, 200, { ok: true, configured: true });
                return;
            }
            if (route === WIZARD_TUNNEL_TOKEN_ROUTE && method === 'POST') {
                if (!sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                const store = options.tokenStore;
                if (store === undefined) {
                    responseJson(res, 501, { ok: false, error: { code: 'not-implemented', message: 'This wizard step is not wired up yet' } });
                    return;
                }
                const body = await readJsonObject(req);
                const token = typeof body?.token === 'string' ? body.token.trim() : '';
                if (token === '') {
                    responseJson(res, 400, { ok: false, error: { code: 'bad-token', message: 'token must be a non-empty string' } });
                    return;
                }
                store.writeTunnelToken(token);
                responseJson(res, 200, { ok: true, configured: true });
                return;
            }
            if (route.startsWith(`${WIZARD_ROUTE_PREFIX}/caddy/`)) {
                // Walls first, then the method shape, then (and only then) the
                // wiring check — a 501 must never answer before the walls, and a
                // wrong method on a wired route must still read 405.
                if (method === 'POST' && !sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                if (method !== 'GET' && method !== 'POST') {
                    res.setHeader('Allow', 'GET, POST');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET or POST' } });
                    return;
                }
                const caddy = options.caddy;
                if (caddy === undefined) {
                    responseJson(res, 501, { ok: false, error: { code: 'not-implemented', message: 'This wizard step is not wired up yet' } });
                    return;
                }
                if (route === WIZARD_CADDY_STATUS_ROUTE && method === 'GET') {
                    responseJson(res, 200, { ok: true, state: caddy.status() });
                    return;
                }
                if (route === WIZARD_CADDY_STOP_ROUTE && method !== 'POST') {
                    // GW-fix-4/H2: a GET must never stop a process, even by accident.
                    res.setHeader('Allow', 'GET, POST');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST to stop' } });
                    return;
                }
                if (route === WIZARD_CADDY_STOP_ROUTE) {
                    caddy.stop();
                    responseJson(res, 200, { ok: true, state: caddy.status() });
                    return;
                }
                // start: the SAVED row config is the source of truth (the configure
                // step stored it); the gateway's ACTUAL port wins over the
                // configured one.
                const values = options.getConfig().values;
                const domain = hostOf(values.ingressDomain);
                if (domain === undefined) {
                    responseJson(res, 400, { ok: false, error: { code: 'no-domain', message: '保存一个有效的公开域名后再启动' } });
                    return;
                }
                let runtime = {};
                try {
                    runtime = (await options.getRuntime?.()) ?? {};
                }
                catch {
                    runtime = {};
                }
                const gatewayPort = typeof runtime.gatewayActualPort === 'number' ? runtime.gatewayActualPort : values.port;
                const result = await caddy.start({ domain, httpsPort: values.ingressHttpsPort, gatewayPort });
                // The start result may carry a failure detail — never the token.
                responseJson(res, 200, { ok: result.ok, ...(result.ok ? { caddyfile: result.caddyfile } : { error: result.error, detail: result.detail, installUrl: result.installUrl }) });
                return;
            }
            if (route.startsWith(`${WIZARD_ROUTE_PREFIX}/tunnel/`)) {
                // Same discipline as the caddy block: walls, then method shape,
                // then the wiring check.
                if (method === 'POST' && !sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                if (method !== 'GET' && method !== 'POST') {
                    res.setHeader('Allow', 'GET, POST');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET or POST' } });
                    return;
                }
                const tunnel = options.tunnel;
                if (tunnel === undefined) {
                    responseJson(res, 501, { ok: false, error: { code: 'not-implemented', message: 'This wizard step is not wired up yet' } });
                    return;
                }
                if (route === WIZARD_TUNNEL_STATUS_ROUTE && method === 'GET') {
                    responseJson(res, 200, { ok: true, state: tunnel.status() });
                    return;
                }
                if (method !== 'POST') {
                    res.setHeader('Allow', 'GET, POST');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET or POST' } });
                    return;
                }
                const body = await readJsonObject(req);
                const domain = typeof body?.domain === 'string' ? body.domain : '';
                if (route === WIZARD_TUNNEL_CHECK_ROUTE) {
                    const result = await tunnel.checkDomain(domain);
                    responseJson(res, 200, { ok: result.ok, ...(result.ok ? { onCloudflare: result.onCloudflare, zoneId: result.zoneId } : { reason: result.reason, detail: result.detail }) });
                    return;
                }
                if (route === WIZARD_TUNNEL_STOP_ROUTE && method !== 'POST') {
                    res.setHeader('Allow', 'GET, POST');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST to stop' } });
                    return;
                }
                if (route === WIZARD_TUNNEL_STOP_ROUTE) {
                    tunnel.stop();
                    responseJson(res, 200, { ok: true, state: tunnel.status() });
                    return;
                }
                if (route === WIZARD_TUNNEL_SETUP_ROUTE) {
                    const tunnelId = typeof body?.tunnelId === 'string' && body.tunnelId !== '' ? body.tunnelId : undefined;
                    const result = await tunnel.setup({ domain, tunnelId });
                    // The setup answer never carries the connector token — only its
                    // file path (a server-local fact) and the conflict list.
                    if (result.ok) {
                        responseJson(res, 200, { ok: true, tunnelId: result.tunnelId, publicUrl: result.publicUrl });
                    }
                    else {
                        responseJson(res, 200, {
                            ok: false,
                            reason: result.reason,
                            ...(result.detail !== undefined ? { detail: result.detail } : {}),
                            ...(result.existing !== undefined ? { existing: result.existing } : {}),
                            ...(result.installUrl !== undefined ? { installUrl: result.installUrl } : {}),
                        });
                    }
                    return;
                }
                responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown wizard route' } });
                return;
            }
            if (route === WIZARD_VERIFY_ROUTE && (method === 'POST' || method === 'GET')) {
                // Wall 3 applies to the POST; the GET is read-only polling. Both
                // answers are 200 with the orchestration's own verdict in the
                // body — the UI branches on `ok` / `result`, not on status codes.
                if (method === 'POST' && !sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                const verify = options.verify;
                if (verify === undefined) {
                    responseJson(res, 501, { ok: false, error: { code: 'not-implemented', message: 'This wizard step is not wired up yet' } });
                    return;
                }
                if (method === 'GET') {
                    responseJson(res, 200, await verify.check());
                    return;
                }
                const body = await readJsonObject(req);
                if (body === null) {
                    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'request body must be a JSON object' } });
                    return;
                }
                responseJson(res, 200, await verify.start({
                    publicUrl: body.publicUrl,
                    ...(body.probeOnly === true ? { probeOnly: true } : {}),
                }));
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