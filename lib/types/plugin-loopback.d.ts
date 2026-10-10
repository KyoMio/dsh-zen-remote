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
import type { IncomingMessage } from 'node:http';
/** The loopback bind info, re-read live per request by the wiring. */
export interface PluginLoopbackTarget {
    protocol: 'http:' | 'https:';
    port: number;
}
/** The request headers this bridge passes through to the plugin. */
export interface PluginLoopbackHeaders {
    accept?: string;
    range?: string;
    /** PB-9: a forwarded request body's content type. */
    contentType?: string;
}
/** The plugin route's answer, headers whitelisted to what the relay may
 * forward. `stream` is the RAW IncomingMessage: the caller reads it (and
 * only it) — the module has already drained every other outcome. */
export interface PluginLoopbackResponse {
    status: number;
    contentType: string | undefined;
    contentLength: string | undefined;
    cacheControl: string | undefined;
    stream: IncomingMessage;
}
/** The one failure the relay maps onto 502 `loopback-auth`: the cookie
 * exchange could not run (no token URL on this host) or did not yield a
 * cookie (wrong token, a non-redirect answer, a network error). */
export declare class LoopbackAuthError extends Error {
    constructor(message: string);
}
declare function isLoopbackAuthError(error: unknown): error is LoopbackAuthError;
export interface CreatePluginLoopbackOptions {
    /** The loopback bind, read live per request (a restarted web server may
     * have moved; a snapshot would keep dialing the old port). */
    getTarget: () => PluginLoopbackTarget;
    /** The authenticated token URL (the lan-gate wiring's
     * `connection.authenticatedUrl(protocol//127.0.0.1:port)` shape), read
     * live per exchange; `undefined` — a host without the method — means the
     * cookie can never be obtained and every bridged call fails
     * `loopback-auth`. */
    getTokenUrl: () => string | undefined;
}
export interface PluginLoopback {
    /** One validated request against the local plugin route. `path` arrives
     * undecoded and `query` is the RELAY-CHECKED serialization (the caller
     * never passes raw wire input — the parse-once discipline). `body` (PB-9)
     * is the relay request's body streamed verbatim (an IncomingMessage or a
     * byte stream), `null` for bodyless methods; it is pumped into the
     * loopback request as-is — sizing it is the ROUTE's job, transport is
     * this module's. Throws {@link LoopbackAuthError} when the cookie cannot
     * be obtained; every other failure (target unreachable, the signal
     * aborted, the body dying mid-flight) rejects with the underlying error
     * and is the caller's `internal`/hang-up case. */
    request(method: string, path: string, query: string, headers: PluginLoopbackHeaders, body: import('node:http').IncomingMessage | import('node:stream').Readable | null, signal: AbortSignal): Promise<PluginLoopbackResponse>;
}
/**
 * Build the loopback executor. The cookie lives only in this closure.
 */
export declare function createPluginLoopback(options: CreatePluginLoopbackOptions): PluginLoopback;
export { isLoopbackAuthError };
//# sourceMappingURL=plugin-loopback.d.ts.map