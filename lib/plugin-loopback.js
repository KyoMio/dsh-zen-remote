/**
 * The plugin bridge's loopback executor (PB-3): performs one GET against one
 * of THIS server's own plugin routes, over real loopback HTTP, so the
 * plugin's own handler — its authentication, its req/res semantics — runs
 * exactly as it would for a local browser (docs/adr/0001). The relay route
 * hands this module a validated path + query and gets the plugin's answer
 * back as a status code plus a byte stream to pump at the sub-client.
 *
 * Why the cookie dance: DSH 0.1.2+ requires a signed cookie on EVERY route.
 * The gateway half solved this for browsers by "playing courier" — one
 * `GET /?token=…` (the only URL that accepts a token), then the 303's
 * `set-cookie` straight onto the client (lib/lan-gate-server.cjs
 * attemptAuthExchange). This module is the same courier for the relay: it
 * keeps ONE cookie in memory for the process, exchanges it once on first
 * use, and re-exchanges exactly once when the plugin route answers 401 (a
 * rotated signing key). The exchange is the lan-gate.mjs wiring's shape:
 * `connection.authenticatedUrl(protocol//127.0.0.1:port)` builds the token
 * URL — absent on 0.1.1 hosts, where there is nothing to exchange and every
 * bridged call fails `loopback-auth` honestly.
 *
 * The cookie never leaves this module: no log, no state file, no response —
 * it exists only as the `cookie` request header on the loopback hop.
 *
 * Transport is node:http / node:https on purpose: the plugin's answer must
 * stream (chunk after chunk, with real backpressure) and must die the
 * moment the sub-client hangs up (an AbortSignal reaches the socket), and
 * 0.2.1's self-signed https needs `rejectUnauthorized: false` — a per-
 * request knob fetch cannot express. The loosened verification is safe BY
 * CONSTRUCTION: the connection is dialed to the literal 127.0.0.1 the
 * wiring pinned, never to a name that could be spoofed; the worst an
 * on-path attacker could forge is data from the machine's own web server
 * to itself.
 */
import http from 'node:http';
import https from 'node:https';
/** The one failure the relay maps onto 502 `loopback-auth`: the cookie
 * exchange could not run (no token URL on this host) or did not yield a
 * cookie (wrong token, a non-redirect answer, a network error). */
export class LoopbackAuthError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LoopbackAuthError';
    }
}
function isLoopbackAuthError(error) {
    return error instanceof LoopbackAuthError;
}
/** One raw loopback request that never follows redirects and resolves with
 * the raw IncomingMessage (the caller drains or streams it). The loosened
 * certificate verification (PB-3-fix) applies ONLY to a literal `127.0.0.1`
 * hostname — the plugin hop the wiring pins — never to the token exchange
 * when its URL names anything else. */
function rawRequest(target, pathWithQuery, headers, signal) {
    return new Promise((resolve, reject) => {
        const transport = target.protocol === 'https:' ? https : http;
        // The signal reaching request() tears the socket down on abort — the
        // sub-client's hang-up propagates here without extra wiring.
        const request = transport.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port,
            method: 'GET',
            path: pathWithQuery,
            headers,
            // 0.2.1 serves self-signed https; the dial is the literal loopback
            // address (see the module comment), so certificate identity carries
            // no information to verify — and ONLY there: any other hostname
            // (the token URL's, should the wiring ever point it elsewhere) keeps
            // full verification.
            ...(target.protocol === 'https:' && target.hostname === '127.0.0.1' ? { rejectUnauthorized: false } : {}),
            signal,
        }, resolve);
        request.on('error', reject);
        request.end();
    });
}
/** The `name=value` pair of the FIRST set-cookie header, or undefined. */
function cookiePairOf(setCookies) {
    const first = setCookies?.[0];
    if (first === undefined)
        return undefined;
    const pair = first.split(';', 1)[0] ?? '';
    return pair.includes('=') && pair !== '' ? pair : undefined;
}
/**
 * Build the loopback executor. The cookie lives only in this closure.
 */
export function createPluginLoopback(options) {
    let cookie;
    /** One `GET <tokenUrl>` (never redirected — node:http already does not
     * follow): a 3xx carrying a set-cookie yields the pair; anything else is
     * an exchange failure. The token response body is always drained and
     * discarded — it is the DSH homepage, none of this module's business. */
    const exchangeCookie = async (signal) => {
        const tokenUrl = options.getTokenUrl();
        if (tokenUrl === undefined)
            throw new LoopbackAuthError('this host exposes no authenticated token URL');
        let url;
        try {
            url = new URL(tokenUrl);
        }
        catch {
            throw new LoopbackAuthError('the token URL does not parse');
        }
        let response;
        try {
            response = await rawRequest({ protocol: url.protocol, hostname: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) }, `${url.pathname}${url.search}`, { accept: 'text/html' }, signal);
        }
        catch (error) {
            if (signal.aborted)
                throw error;
            throw new LoopbackAuthError(`the token exchange request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const status = response.statusCode ?? 0;
        const pair = cookiePairOf(response.headers['set-cookie']);
        response.resume();
        if (status >= 300 && status < 400 && pair !== undefined) {
            cookie = pair;
            return;
        }
        throw new LoopbackAuthError(`the token exchange answered ${status}${pair === undefined ? ' without a cookie' : ''}`);
    };
    return {
        async get(path, query, headers, signal) {
            const target = options.getTarget();
            const pathWithQuery = query === '' ? path : `${path}?${query}`;
            const attempt = async () => {
                const requestHeaders = { host: `127.0.0.1:${target.port}` };
                if (headers.accept !== undefined)
                    requestHeaders.accept = headers.accept;
                if (headers.range !== undefined)
                    requestHeaders.range = headers.range;
                // The cookie rides ONLY here. An absent cookie still attempts the
                // route — a plugin route that skipped DSH auth answers honestly.
                if (cookie !== undefined)
                    requestHeaders.cookie = cookie;
                return rawRequest({ protocol: target.protocol, hostname: '127.0.0.1', port: target.port }, pathWithQuery, requestHeaders, signal);
            };
            let response = await attempt();
            if (response.statusCode === 401) {
                // Stale or missing cookie: exchange ONCE and retry. A 401 after the
                // fresh cookie is the plugin's own answer — it travels to the
                // sub-client verbatim, like any other status.
                response.resume();
                cookie = undefined;
                await exchangeCookie(signal);
                response = await attempt();
            }
            return {
                status: response.statusCode ?? 0,
                contentType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : undefined,
                contentLength: typeof response.headers['content-length'] === 'string' ? response.headers['content-length'] : undefined,
                cacheControl: typeof response.headers['cache-control'] === 'string' ? response.headers['cache-control'] : undefined,
                stream: response,
            };
        },
    };
}
export { isLoopbackAuthError };
//# sourceMappingURL=plugin-loopback.js.map