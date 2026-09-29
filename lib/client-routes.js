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
import { classifyClaimResponse, classifyProbe, CLAIM_PATH, normalizeServerUrl, RELAY_PING_PATH } from './client-pairing.js';
import { unwrapVolatile } from './config.js';
import { responseJson, sameOriginPost } from './http.js';
import { RELAY_HTTP_ROUTES } from './relay-access.js';
import { relayCredentialsDigest, RelayError } from './relay-client.js';
import { fromVirtual } from './virtual-id.js';
/** Prefix all client routes live under (one webServer prefix registration). */
export const CLIENT_ROUTE_PREFIX = '/_dsh/zen-remote/client';
/** POST `{serverUrl, code, name}`: redeem a desktop pairing code. */
export const CLIENT_CLAIM_ROUTE = `${CLIENT_ROUTE_PREFIX}/claim`;
/** GET: the current connection state (never carries the token). */
export const CLIENT_STATUS_ROUTE = `${CLIENT_ROUTE_PREFIX}/status`;
/** POST: one immediate reconnect attempt (T43, the settings page's 立即重连);
 * answered 409 unless the relay client is currently `offline`. */
export const CLIENT_RECONNECT_ROUTE = `${CLIENT_ROUTE_PREFIX}/reconnect`;
/** GET: the remote-session status the T34 client parts render from (T34) —
 * the relay's serving state, the interface-compatibility verdict, the
 * handshake's server name, and the closed-session map. The prefix is
 * registered on BOTH roles (T34-fix): a host — no relay client wired —
 * answers the empty `{state:'unpaired', versionMismatch:false, serverName:'',
 * closed:{}}` conclusion. It carries no token and no server address. */
export const CLIENT_REMOTE_STATUS_ROUTE = `${CLIENT_ROUTE_PREFIX}/remote-status`;
/** POST `{sessionId: <虚拟 id>}`: close one remote session from THIS machine
 * (T34) — the backend forwards the ORIGINAL id through the relay's
 * `POST relay/v1/unshare`, so the server closes it with reason `'client'`. */
export const CLIENT_UNSHARE_ROUTE = `${CLIENT_ROUTE_PREFIX}/unshare`;
/** Prefix of the plain-HTTP relay routes (T41b):
 * `GET ${CLIENT_HTTP_ROUTE_PREFIX}<route>?<query>` relays one intercepted
 * `/api/<route>` call (the fetch wrapper's rewrites land here) to the
 * server, with the virtual session id swapped back to the original. */
export const CLIENT_HTTP_ROUTE_PREFIX = `${CLIENT_ROUTE_PREFIX}/http/`;
/** Longest wait for one pairing round-trip to the server's gateway. */
const CLAIM_TIMEOUT_MS = 10_000;
/** Longest wait for one connection probe. */
const PROBE_TIMEOUT_MS = 5_000;
/** Inbound claim body cap — the settings form sends a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024;
/**
 * One refusal this module raises on purpose, carrying the status and code the
 * browser should see.
 *
 * Fields are assigned in the body rather than declared as constructor
 * parameter properties: check scripts import these modules through Node's
 * strip-only type stripping, which rejects that syntax (same reason as
 * UploadError in index.ts and AdminError in admin-routes.ts).
 */
class ClientRouteError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.name = 'ClientRouteError';
        this.status = status;
        this.code = code;
    }
}
/**
 * Read the whole body under the cap and demand one JSON object. Same contract
 * as the admin routes' reader: an empty body counts as `{}`, a declared
 * oversized body length is refused before a byte is read, and the streaming
 * cap stays as the chunked-body guard.
 */
async function readJsonBody(req) {
    const declared = req.headers['content-length'];
    const expected = declared === undefined ? undefined : Number(declared);
    if (expected !== undefined && Number.isSafeInteger(expected) && expected > MAX_BODY_BYTES) {
        throw new ClientRouteError(400, 'bad-request', `request body exceeds the ${MAX_BODY_BYTES}-byte limit`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES)
            throw new ClientRouteError(400, 'bad-request', `request body exceeds the ${MAX_BODY_BYTES}-byte limit`);
        chunks.push(bytes);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '')
        return {};
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new ClientRouteError(400, 'bad-request', 'request body must be valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ClientRouteError(400, 'bad-request', 'request body must be a JSON object');
    }
    return parsed;
}
function stringOrEmpty(value) {
    return typeof value === 'string' ? value : '';
}
/**
 * Write one relayed upstream answer (T41b): the underlying `/api` route's
 * status with its body as received, and a content type held to JSON — the
 * two registered routes answer JSON, and a compromised server must not land
 * a scriptable type (`text/html`) on this same-origin browser path (T41b-fix),
 * so anything else downgrades to inert `text/plain`. `nosniff` backs the
 * downgrade up, and the no-store discipline every route here answers with.
 */
function respondUpstream(res, result) {
    const bytes = Buffer.from(result.body, 'utf8');
    const mediaType = result.contentType?.split(';', 1)[0]?.trim().toLowerCase();
    const contentType = mediaType === 'application/json' && result.contentType !== undefined ? result.contentType : 'text/plain; charset=utf-8';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.writeHead(result.status);
    res.end(bytes);
}
/**
 * Map one relay failure onto the plain-HTTP answer (T41b): the four
 * link-level codes mean "the server chain is not usable" (503
 * `remote-offline`); a refusal the relay route itself answered keeps ITS
 * status and code (an unshared session is the relay's 403 `not-shared`,
 * verbatim); anything else is a bug and answers a bare 502.
 */
function respondRelayFailure(res, error) {
    if (error instanceof RelayError) {
        if (error.code === 'offline' || error.code === 'unpaired' || error.code === 'revoked' || error.code === 'incompatible') {
            responseJson(res, 503, { ok: false, error: { code: 'remote-offline' } });
            return;
        }
        if (error.status !== undefined && error.status >= 400 && error.status <= 599) {
            responseJson(res, error.status, { ok: false, error: { code: error.code } });
            return;
        }
    }
    responseJson(res, 502, { ok: false, error: { code: 'internal' } });
}
/** One probe of the server's relay ping with the row's token. Only the
 * Authorization header ever sees the token. */
async function probe(fetchImpl, serverUrl, token) {
    let response;
    try {
        response = await fetchImpl(serverUrl.replace(/\/+$/u, '') + RELAY_PING_PATH, {
            method: 'GET',
            headers: { authorization: `Bearer ${token}` },
            // A wrong server must not walk the probe through a redirect chain.
            redirect: 'manual',
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
    }
    catch {
        return classifyProbe({ kind: 'error' });
    }
    const text = await response.text().catch(() => undefined);
    let body;
    if (text !== undefined) {
        try {
            body = JSON.parse(text);
        }
        catch {
            body = undefined;
        }
    }
    return classifyProbe({ kind: 'response', status: response.status, body });
}
/** Relay one classified claim outcome to the browser. The success envelope
 * additionally echoes the NORMALIZED address — the exact string this route
 * validated, so the browser writes back what the backend approved. */
function respondClaim(res, outcome, serverUrl) {
    if (outcome.ok) {
        responseJson(res, 200, { ...outcome, serverUrl });
        return;
    }
    responseJson(res, 200, outcome);
}
/**
 * Map one relay failure onto the status vocabulary (T23a-fix, extended by
 * T43): ONLY the gateway's unpaired wall is `revoked`. A server that refuses
 * the relay prefix or speaks another protocol version answers
 * `incompatible` — the settings page renders it with its own "upgrade both
 * ends" copy. The relay route's own 401 `relay-unauthorized` is a
 * server-side secret fault, and every other odd shape lands in `unexpected`
 * — never in a verdict that would unpair a validly-paired device. Transport
 * death is `unreachable`.
 */
function probeStateOfRelayError(error) {
    if (error instanceof RelayError) {
        if (error.code === 'revoked')
            return 'revoked';
        if (error.code === 'offline')
            return 'unreachable';
        if (error.code === 'unpaired')
            return 'unpaired';
        if (error.code === 'incompatible')
            return 'incompatible';
    }
    return 'unexpected';
}
/**
 * One live handshake bounded by the probe timeout. An abandoned connect
 * keeps running in the background — its result lands in the relay client's
 * state and digest either way — but the status answer never waits longer
 * than a probe would have.
 */
async function withProbeTimeout(promise) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new RelayError('offline', `no handshake within ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS);
                if (typeof timer.unref === 'function')
                    timer.unref();
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/**
 * The relay client's live state in the `remote-status` vocabulary (T34):
 * `connecting` and `incompatible` report as `offline` — both are "the link
 * is not serving, recovery pending" as far as a remote session is concerned.
 * No relay client wired (a host role) is `unpaired`, the honest "no
 * connection configured".
 */
function remoteStatusStateOf(relay) {
    if (relay === undefined)
        return 'unpaired';
    switch (relay.state) {
        case 'online':
            return 'online';
        case 'revoked':
            return 'revoked';
        case 'unpaired':
            return 'unpaired';
        default:
            return 'offline';
    }
}
/**
 * Build the client route handler for one plugin row. The returned handler
 * owns the full response lifecycle of every request under
 * {@link CLIENT_ROUTE_PREFIX} and never throws.
 */
export function createClientHandler(options) {
    const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    return async (req, res) => {
        // Wall 1: DSH's own admission, relaying its refusal verbatim.
        const admission = options.admit(req);
        if ('rejection' in admission) {
            responseJson(res, admission.rejection, {
                ok: false,
                error: { code: admission.rejection === 401 ? 'unauthorized' : 'forbidden' },
            });
            return;
        }
        const route = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
        const method = req.method ?? 'GET';
        try {
            // The host mount's least-exposure wall (T41a-fix2): only remote-status
            // exists here, and it sits BEHIND the admission wall like every other
            // route. The shape of the refusal matches the unknown-path fallthrough.
            if (options.remoteStatusOnly === true && route !== CLIENT_REMOTE_STATUS_ROUTE) {
                responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown client route' } });
                return;
            }
            if (route === CLIENT_CLAIM_ROUTE) {
                if (method !== 'POST') {
                    res.setHeader('Allow', 'POST');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } });
                    return;
                }
                if (!sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                const body = await readJsonBody(req);
                const normalized = normalizeServerUrl(stringOrEmpty(body.serverUrl));
                if (!normalized.ok) {
                    responseJson(res, 400, { ok: false, code: normalized.reason });
                    return;
                }
                const payload = JSON.stringify({
                    code: stringOrEmpty(body.code),
                    name: stringOrEmpty(body.name),
                });
                let status;
                let gatewayBody;
                try {
                    // No hand-set body-length (or host/connection/transfer-encoding)
                    // header here: DSH swaps the global fetch's dispatcher for its
                    // bundled undici 8.x, which refuses any fetch that carries one
                    // (UND_ERR_INVALID_ARG → the whole pairing round-trip answers
                    // "unreachable"), while the dispatcher computes the length itself
                    // from the string body.
                    const response = await fetchImpl(new URL(CLAIM_PATH, normalized.url), {
                        method: 'POST',
                        headers: { 'content-type': 'application/json; charset=utf-8' },
                        body: payload,
                        // A wrong server must not walk the pairing round-trip through a
                        // redirect chain (T16-fix): any 3xx lands in the classifier's
                        // `unexpected` bucket instead of being followed.
                        redirect: 'manual',
                        signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
                    });
                    status = response.status;
                    const text = await response.text();
                    try {
                        gatewayBody = JSON.parse(text);
                    }
                    catch {
                        gatewayBody = undefined;
                    }
                }
                catch {
                    responseJson(res, 502, { ok: false, code: 'unreachable' });
                    return;
                }
                respondClaim(res, classifyClaimResponse(status, gatewayBody), normalized.url);
                return;
            }
            if (route === CLIENT_STATUS_ROUTE) {
                if (method !== 'GET') {
                    res.setHeader('Allow', 'GET');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } });
                    return;
                }
                // The typert interception's view (T23b-1) rides on EVERY status
                // answer, whatever the connection state — the settings surface needs
                // it to explain a refused install even while unpaired. The interface
                // compat verdict (T42) appears once there is something to report: a
                // stored comparison from the relay client's last handshake, or any
                // incompatible call the interceptor recorded. Absent otherwise —
                // nothing to show, and the settings block presence-gates on exactly
                // that.
                const intercept = options.getIntercept?.();
                const compatRelay = options.getRelayClient?.();
                const compat = compatRelay?.compat !== undefined || (intercept?.incompatibleCalls.length ?? 0) > 0
                    ? {
                        identical: compatRelay?.compat?.identical ?? [],
                        different: compatRelay?.compat?.different ?? [],
                        unavailable: compatRelay?.compat?.unavailable ?? [],
                        incompatibleCalls: intercept?.incompatibleCalls ?? [],
                    }
                    : undefined;
                const withDiagnostics = (body) => {
                    const next = intercept === undefined ? body : { ...body, intercept };
                    return compat === undefined ? next : { ...next, compat };
                };
                // The ROW decides its own two shapes first, per request (both fields
                // are volatile { get() } wrappers — only the row object apply()
                // received is a live source): without both credentials nothing is
                // paired, and a stored address that no longer normalizes must never
                // see the token (T16-fix).
                const row = options.getRowConfig();
                const record = row !== null && typeof row === 'object' && !Array.isArray(row) ? row : {};
                const serverUrl = stringOrEmpty(unwrapVolatile(record.serverUrl)).trim();
                const token = stringOrEmpty(unwrapVolatile(record.deviceToken));
                if (token === '' || serverUrl === '') {
                    responseJson(res, 200, withDiagnostics({ state: 'unpaired' }));
                    return;
                }
                const normalized = normalizeServerUrl(serverUrl);
                if (!normalized.ok) {
                    responseJson(res, 200, withDiagnostics({ state: 'invalid-url' }));
                    return;
                }
                const relay = options.getRelayClient?.();
                if (relay === undefined) {
                    // T16 shape: no relay client wired — the ping probe is the answer.
                    const state = await probe(fetchImpl, normalized.url, token);
                    responseJson(res, 200, withDiagnostics({ state, serverUrl: normalized.url }));
                    return;
                }
                // The cached verdict is trusted only over the EXACT credentials the
                // handshake earned it with: an online state whose digest no longer
                // matches the row (address edited, re-pair) is an answer about a
                // DIFFERENT server and falls through to a live connect instead
                // (T23a-fix). The token never enters this body — the digest is a
                // one-way sha256 prefix computed on both sides.
                if (relay.state === 'online' &&
                    relay.handshakeInfo !== undefined &&
                    relay.lastHandshakeDigest !== undefined &&
                    relay.lastHandshakeDigest === relayCredentialsDigest(normalized.url, token)) {
                    responseJson(res, 200, withDiagnostics({ state: relay.state, serverName: relay.handshakeInfo.serverName, serverUrl: normalized.url }));
                    return;
                }
                // Everything else — never connected, offline, connecting, revoked,
                // stale credentials — gets ONE live connect bounded by the probe
                // timeout; its FRESH result is the answer, never the possibly stale
                // cached state. A failed attempt additionally carries the relay
                // client's reconnect machinery readout (T43): when the next
                // automatic retry fires and which code failed last — both free of
                // credential material by contract.
                try {
                    const info = await withProbeTimeout(relay.connect());
                    responseJson(res, 200, withDiagnostics({ state: 'online', serverName: info.serverName, serverUrl: normalized.url }));
                }
                catch (error) {
                    const body = { state: probeStateOfRelayError(error), serverUrl: normalized.url };
                    if (relay.nextRetryAt !== null && relay.nextRetryAt !== undefined)
                        body.nextRetryAt = relay.nextRetryAt;
                    if (relay.lastError !== undefined)
                        body.lastError = relay.lastError;
                    responseJson(res, 200, withDiagnostics(body));
                }
                return;
            }
            if (route === CLIENT_RECONNECT_ROUTE) {
                if (method !== 'POST') {
                    res.setHeader('Allow', 'POST');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } });
                    return;
                }
                if (!sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                const relay = options.getRelayClient?.();
                // No relay client (a composition that never built one): there is
                // nothing to reconnect, and the probe-shaped status route is the
                // only connection surface this deployment has.
                if (relay === undefined) {
                    responseJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'No relay client is running' } });
                    return;
                }
                // The button is only clickable while offline; anything else is a
                // conflict with the state the page just rendered.
                if (relay.state !== 'offline' || !relay.reconnect()) {
                    responseJson(res, 409, { ok: false, error: { code: 'not-offline', message: 'The client is not offline' } });
                    return;
                }
                // Fired, not awaited: the attempt runs on the relay client (bounded
                // by its own request timeout), the state lands there either way, and
                // the page's status refresh reports the outcome.
                responseJson(res, 200, { ok: true });
                return;
            }
            if (route === CLIENT_REMOTE_STATUS_ROUTE) {
                if (method !== 'GET') {
                    res.setHeader('Allow', 'GET');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } });
                    return;
                }
                // T34: the T34 client parts' data source — no token, no server
                // address, nothing but the serving state, the compat verdict's
                // difference flag, the display name and the closed-session map.
                const relay = options.getRelayClient?.();
                const intercept = options.getIntercept?.();
                responseJson(res, 200, {
                    state: remoteStatusStateOf(relay),
                    versionMismatch: (relay?.compat?.different?.length ?? 0) > 0,
                    serverName: relay?.handshakeInfo?.serverName ?? '',
                    closed: Object.fromEntries((intercept?.closedSessions ?? []).map((record) => [record.sessionId, record.reason])),
                });
                return;
            }
            if (route === CLIENT_UNSHARE_ROUTE) {
                if (method !== 'POST') {
                    res.setHeader('Allow', 'POST');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } });
                    return;
                }
                if (!sameOriginPost(req)) {
                    responseJson(res, 403, {
                        ok: false,
                        error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
                    });
                    return;
                }
                const body = await readJsonBody(req);
                // Only a VIRTUAL id is a remote session of this deployment — a local
                // id here is a caller bug, refused before anything travels.
                const parts = fromVirtual(body.sessionId);
                if (parts === undefined) {
                    responseJson(res, 400, { ok: false, error: { code: 'not-virtual', message: 'sessionId must be a remote (virtual) session id' } });
                    return;
                }
                const relay = options.getRelayClient?.();
                if (relay === undefined) {
                    responseJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'No relay client is running' } });
                    return;
                }
                // A session of a DIFFERENT server than the current handshake would
                // just answer not-shared out there — the mismatch is answerable
                // locally, with the code the interceptor uses for the same fact.
                if (relay.handshakeInfo === undefined || relay.handshakeInfo.serverId !== parts.serverId) {
                    responseJson(res, 200, { ok: false, error: { code: 'remote-mismatch', message: '此远程会话属于其他主服务端' } });
                    return;
                }
                try {
                    await relay.unshare(parts.id);
                    responseJson(res, 200, { ok: true });
                }
                catch (error) {
                    // The relay's refusal travels with its code — the icon's alert
                    // keys the short copy on it.
                    const code = error instanceof RelayError ? error.code : 'internal';
                    responseJson(res, 200, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } });
                }
                return;
            }
            if (route.startsWith(CLIENT_HTTP_ROUTE_PREFIX)) {
                // The plain-HTTP relay (T41b): the browser fetch wrapper sends the
                // `/api/changes.*` calls it intercepted here. Same first wall as
                // every client route (admit, above), then the four checks the
                // interceptor's own routes apply — registered route, exactly one
                // virtual session id, the relay online, and THAT id belonging to the
                // connected server — before the query travels with the original id
                // restored.
                if (method !== 'GET') {
                    res.setHeader('Allow', 'GET');
                    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } });
                    return;
                }
                const httpRoute = route.slice(CLIENT_HTTP_ROUTE_PREFIX.length);
                // Registry lookup by hasOwnProperty, never a bare index: `route` is
                // a wire string, and `constructor` must not resolve through the
                // object prototype.
                if (httpRoute === '' || !Object.prototype.hasOwnProperty.call(RELAY_HTTP_ROUTES, httpRoute)) {
                    responseJson(res, 404, { ok: false, error: { code: 'unknown-route' } });
                    return;
                }
                const url = new URL(req.url ?? '/', 'http://dsh.internal');
                const sessionIds = url.searchParams.getAll('sessionId');
                const virtualId = sessionIds.length === 1 ? sessionIds[0] : undefined;
                if (virtualId === undefined || virtualId === '') {
                    responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId is required exactly once' } });
                    return;
                }
                const parts = fromVirtual(virtualId);
                if (parts === undefined) {
                    responseJson(res, 400, { ok: false, error: { code: 'not-virtual', message: 'sessionId is not a remote session id' } });
                    return;
                }
                const relay = options.getRelayClient?.();
                if (relay === undefined || relay.state !== 'online') {
                    responseJson(res, 503, { ok: false, error: { code: 'remote-offline' } });
                    return;
                }
                if (relay.handshakeInfo?.serverId !== parts.serverId) {
                    responseJson(res, 400, { ok: false, error: { code: 'remote-mismatch', message: '此远程会话属于其他主服务端' } });
                    return;
                }
                url.searchParams.set('sessionId', parts.id);
                // A browser walk-off cancels the round-trip mid-flight; the write
                // guard in the catch keeps a settled answer from racing the close.
                const hangUp = new AbortController();
                res.once('close', () => {
                    if (!res.writableEnded)
                        hangUp.abort();
                });
                try {
                    const result = await relay.http(httpRoute, url.searchParams.toString(), hangUp.signal);
                    respondUpstream(res, result);
                }
                catch (error) {
                    if (!res.writableEnded && !res.destroyed)
                        respondRelayFailure(res, error);
                }
                return;
            }
            responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown client route' } });
        }
        catch (error) {
            // Only the route's OWN refusals carry a message; anything else is a bug
            // and answers a bare 500 — internal error text (absolute paths, stack
            // fragments) never reaches the browser (T16-fix).
            if (error instanceof ClientRouteError) {
                responseJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
                return;
            }
            responseJson(res, 500, { ok: false, error: { code: 'internal' } });
        }
    };
}
//# sourceMappingURL=client-routes.js.map