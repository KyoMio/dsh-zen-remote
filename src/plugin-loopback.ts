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

import http from 'node:http'
import https from 'node:https'
import type { IncomingMessage } from 'node:http'
import { ADAPTER_RESPONSE_HEADER_ALLOWLIST } from './plugin-adapter-core.js'

/** The adapter allowlist's headers off one loopback answer, verbatim. */
function extraAdapterHeadersOf(response: IncomingMessage): Record<string, string> {
  const extra: Record<string, string> = {}
  for (const name of ADAPTER_RESPONSE_HEADER_ALLOWLIST) {
    const value = response.headers[name]
    if (typeof value === 'string' && value !== '') extra[name] = value
  }
  return extra
}

/** The loopback bind info, re-read live per request by the wiring. */
export interface PluginLoopbackTarget {
  protocol: 'http:' | 'https:'
  port: number
}

/** The request headers this bridge passes through to the plugin. */
export interface PluginLoopbackHeaders {
  accept?: string
  range?: string
  /** PB-9: a forwarded request body's content type. */
  contentType?: string
}

/** The plugin route's answer, headers whitelisted to what the relay may
 * forward. `stream` is the RAW IncomingMessage: the caller reads it (and
 * only it) — the module has already drained every other outcome.
 * `extraHeaders` (PB-12) carries the ADAPTER allowlist — the headers an
 * adapter's answer may hand the browser verbatim (the HTML preview's CSP
 * sandbox, download dispositions, range headers); the cooperative relay
 * branch ignores it. */
export interface PluginLoopbackResponse {
  status: number
  contentType: string | undefined
  contentLength: string | undefined
  cacheControl: string | undefined
  extraHeaders: Record<string, string>
  stream: IncomingMessage
}

/** The one failure the relay maps onto 502 `loopback-auth`: the cookie
 * exchange could not run (no token URL on this host) or did not yield a
 * cookie (wrong token, a non-redirect answer, a network error). */
export class LoopbackAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoopbackAuthError'
  }
}

function isLoopbackAuthError(error: unknown): error is LoopbackAuthError {
  return error instanceof LoopbackAuthError
}

export interface CreatePluginLoopbackOptions {
  /** The loopback bind, read live per request (a restarted web server may
   * have moved; a snapshot would keep dialing the old port). */
  getTarget: () => PluginLoopbackTarget
  /** The authenticated token URL (the lan-gate wiring's
   * `connection.authenticatedUrl(protocol//127.0.0.1:port)` shape), read
   * live per exchange; `undefined` — a host without the method — means the
   * cookie can never be obtained and every bridged call fails
   * `loopback-auth`. */
  getTokenUrl: () => string | undefined
}

export interface PluginLoopback {
  /** The cookie the tunnel executor (PB-10) needs to write its OWN upgrade
   * request — a raw socket dial, which cannot ride this module's `request`
   * (it owns the cookie internally). Resolves the current pair, exchanging
   * once when none is cached; empty string means the host has no token URL
   * and the tunnel cannot authenticate. The cookie stays in memory. */
  cookieHeader(): Promise<string>
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
  request(
    method: string,
    path: string,
    query: string,
    headers: PluginLoopbackHeaders,
    body: import('node:http').IncomingMessage | import('node:stream').Readable | null,
    signal: AbortSignal,
  ): Promise<PluginLoopbackResponse>
}

/** One raw loopback request that never follows redirects and resolves with
 * the raw IncomingMessage (the caller drains or streams it). `body`, when
 * given, is pumped into the request verbatim (PB-9's write forwarding); a
 * body dying mid-flight destroys the request, which rejects the promise.
 * The loosened certificate verification (PB-3-fix) applies ONLY to a
 * literal `127.0.0.1` hostname — the plugin hop the wiring pins — never to
 * the token exchange when its URL names anything else. */
function rawRequest(
  target: { protocol: string; hostname: string; port: number },
  method: string,
  pathWithQuery: string,
  headers: Record<string, string>,
  body: import('node:http').IncomingMessage | import('node:stream').Readable | null,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http
    // The signal reaching request() tears the socket down on abort — the
    // sub-client's hang-up propagates here without extra wiring.
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method,
        path: pathWithQuery,
        headers,
        // 0.2.1 serves self-signed https; the dial is the literal loopback
        // address (see the module comment), so certificate identity carries
        // no information to verify — and ONLY there: any other hostname
        // (the token URL's, should the wiring ever point it elsewhere) keeps
        // full verification.
        ...(target.protocol === 'https:' && target.hostname === '127.0.0.1' ? { rejectUnauthorized: false } : {}),
        signal,
      },
      resolve,
    )
    request.on('error', reject)
    if (body === null) {
      request.end()
      return
    }
    // The body streams through as-is: node's pipe owns the backpressure and
    // ends the request when the body ends. A source error (the relay
    // request's socket dying) tears the loopback request down, which
    // rejects through the handler above.
    body.on('error', (error: Error) => {
      request.destroy(error)
    })
    body.pipe(request)
  })
}

/** The `name=value` pair of the FIRST set-cookie header, or undefined. */
function cookiePairOf(setCookies: string[] | undefined): string | undefined {
  const first = setCookies?.[0]
  if (first === undefined) return undefined
  const pair = first.split(';', 1)[0] ?? ''
  return pair.includes('=') && pair !== '' ? pair : undefined
}

/**
 * Build the loopback executor. The cookie lives only in this closure.
 */
export function createPluginLoopback(options: CreatePluginLoopbackOptions): PluginLoopback {
  let cookie: string | undefined

  /** One `GET <tokenUrl>` (never redirected — node:http already does not
   * follow): a 3xx carrying a set-cookie yields the pair; anything else is
   * an exchange failure. The token response body is always drained and
   * discarded — it is the DSH homepage, none of this module's business. */
  const exchangeCookie = async (signal: AbortSignal): Promise<void> => {
    const tokenUrl = options.getTokenUrl()
    if (tokenUrl === undefined) throw new LoopbackAuthError('this host exposes no authenticated token URL')
    let url: URL
    try {
      url = new URL(tokenUrl)
    } catch {
      throw new LoopbackAuthError('the token URL does not parse')
    }
    let response: IncomingMessage
    try {
      response = await rawRequest(
        { protocol: url.protocol, hostname: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) },
        'GET',
        `${url.pathname}${url.search}`,
        { accept: 'text/html' },
        null,
        signal,
      )
    } catch (error) {
      if (signal.aborted) throw error
      throw new LoopbackAuthError(`the token exchange request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const status = response.statusCode ?? 0
    const pair = cookiePairOf(response.headers['set-cookie'])
    response.resume()
    if (status >= 300 && status < 400 && pair !== undefined) {
      cookie = pair
      return
    }
    throw new LoopbackAuthError(`the token exchange answered ${status}${pair === undefined ? ' without a cookie' : ''}`)
  }

  return {
    async cookieHeader() {
      if (cookie === undefined) await exchangeCookie(new AbortController().signal)
      return cookie ?? ''
    },
    async request(method, path, query, headers, body, signal) {
      const target = options.getTarget()
      const pathWithQuery = query === '' ? path : `${path}?${query}`
      // A body cannot be replayed: the first attempt pumps it into the
      // loopback socket, and a 401 arriving afterwards leaves nothing to
      // retry with. So a body-bearing request WARMS the cookie first (one
      // exchange, no plugin request), and a 401 after that travels verbatim
      // — the plugin's own auth answer, like any other status. Bodyless
      // requests keep the full 401 → re-exchange → retry ladder.
      if (body !== null && cookie === undefined) {
        await exchangeCookie(signal)
      }
      const attempt = async (): Promise<IncomingMessage> => {
        const requestHeaders: Record<string, string> = { host: `127.0.0.1:${target.port}` }
        if (headers.accept !== undefined) requestHeaders.accept = headers.accept
        if (headers.range !== undefined) requestHeaders.range = headers.range
        // PB-9: the forwarded body's content type — the ONE body header the
        // bridge passes through.
        if (headers.contentType !== undefined) requestHeaders['content-type'] = headers.contentType
        // The cookie rides ONLY here. An absent cookie still attempts the
        // route — a plugin route that skipped DSH auth answers honestly.
        if (cookie !== undefined) requestHeaders.cookie = cookie
        return rawRequest(
          { protocol: target.protocol, hostname: '127.0.0.1', port: target.port },
          method,
          pathWithQuery,
          requestHeaders,
          body,
          signal,
        )
      }
      let response = await attempt()
      if (response.statusCode === 401 && body === null) {
        // Stale or missing cookie: exchange ONCE and retry. A 401 after the
        // fresh cookie is the plugin's own answer — it travels to the
        // sub-client verbatim, like any other status.
        response.resume()
        cookie = undefined
        await exchangeCookie(signal)
        response = await attempt()
      }
      return {
        status: response.statusCode ?? 0,
        contentType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : undefined,
        contentLength: typeof response.headers['content-length'] === 'string' ? response.headers['content-length'] : undefined,
        cacheControl: typeof response.headers['cache-control'] === 'string' ? response.headers['cache-control'] : undefined,
        // PB-12: the adapter allowlist — the HTML preview's CSP sandbox, a
        // download's content-disposition, range headers. Collected here so
        // the adapter forwards can hand them to the browser; the relay's
        // cooperative branch ignores the field.
        extraHeaders: extraAdapterHeadersOf(response),
        stream: response,
      }
    },
  }
}

export { isLoopbackAuthError }
