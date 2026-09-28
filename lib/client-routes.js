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
import { classifyClaimResponse, classifyProbe, CLAIM_PATH, normalizeServerUrl, RELAY_PING_PATH } from './client-pairing.js';
import { unwrapVolatile } from './config.js';
import { responseJson, sameOriginPost } from './http.js';
/** Prefix all client routes live under (one webServer prefix registration). */
export const CLIENT_ROUTE_PREFIX = '/_dsh/zen-remote/client';
/** POST `{serverUrl, code, name}`: redeem a desktop pairing code. */
export const CLIENT_CLAIM_ROUTE = `${CLIENT_ROUTE_PREFIX}/claim`;
/** GET: the current connection state (never carries the token). */
export const CLIENT_STATUS_ROUTE = `${CLIENT_ROUTE_PREFIX}/status`;
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
 * oversized Content-Length is refused before a byte is read, and the
 * streaming cap stays as the chunked-body guard.
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
                    const response = await fetchImpl(new URL(CLAIM_PATH, normalized.url), {
                        method: 'POST',
                        headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)) },
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
                // Per-request read: both fields are volatile ({ get() } wrapped), so
                // only the row object apply() received is a live source.
                const row = options.getRowConfig();
                const record = row !== null && typeof row === 'object' ? row : {};
                const serverUrl = stringOrEmpty(unwrapVolatile(record.serverUrl)).trim();
                const token = stringOrEmpty(unwrapVolatile(record.deviceToken));
                if (token === '' || serverUrl === '') {
                    responseJson(res, 200, { state: 'unpaired' });
                    return;
                }
                // Re-validate the STORED address before it is used (T16-fix): the row
                // is hand-editable YAML, and a plain-http public address written there
                // must not get the pairing token sent to it in cleartext. A failed
                // check answers invalid-url and sends NOTHING.
                const normalized = normalizeServerUrl(serverUrl);
                if (!normalized.ok) {
                    responseJson(res, 200, { state: 'invalid-url' });
                    return;
                }
                const state = await probe(fetchImpl, normalized.url, token);
                responseJson(res, 200, { state, serverUrl: normalized.url });
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