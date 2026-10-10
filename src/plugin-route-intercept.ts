/**
 * The plugin bridge's route interception (PB-4): the sub-client's local
 * DSH process owns a webServer whose `match(pathname)` every request goes
 * through (RT dsh-host-webserver lib/index.js:350-364 — `handle` computes
 * the RAW, undecoded pathname and calls `this.match`). Overriding that one
 * method intercepts every route lookup — including routes registered AFTER
 * us, because the host re-reads the instance method per request. A request
 * aimed at a BRIDGED plugin's declared route, carrying a VIRTUAL session id,
 * cannot be served locally (the session lives on the server): the surrogate
 * handler forwards it through `relay.pluginRequest` (PB-3's
 * `relay/v1/plugin`) with the real id restored, and streams the answer
 * back. Everything else — undeclared routes, local sessions — flows to the
 * original route untouched.
 *
 * The un-bridged refusals answer a UNIFORM 503 shape (header
 * `x-zen-remote: unbridged`, JSON body naming the reason) — and, decisive
 * for the security posture, they answer WITHOUT the local plugin handler
 * ever running: a remote session must never execute a plugin route against
 * local state, not even when the bridge is down (docs/adr/0001).
 *
 * The wrap is gated on a structural shape check like the typert and
 * fetch-route ones; uninstall restores `match` only while the instance
 * still holds OUR wrapper — a later wrapper chained over us keeps working,
 * and ours goes inert instead (the same posture as intercept.ts and
 * fetch-route-intercept.ts).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BridgeRegistry, BridgeStatus } from './plugin-bridge.js'
import { routeMethodsOf, routeMaxBodyOf, routeUpgradesOf } from './plugin-bridge.js'
import { Readable, Transform } from 'node:stream'
import type { Socket } from 'node:net'
import type { RelayClient } from './relay-client.js'
import { fromVirtual, isVirtual, toVirtual } from './virtual-id.js'
import type { NormalizedAdapter, NormalizedAdapterRoute, AdapterIdHit, AdapterVerdict } from './plugin-adapter-core.js'
import { adapterPathMatches, classifyAdapterRequest, rewriteAdapterRequest, adapterOwnsRegistryEntry, MAX_ADAPTER_RESPONSE_BUFFER_BYTES } from './plugin-adapter-core.js'

/** Structural verdict of {@link checkWebServerShape}: the facts the wrap
 * reads per request — the `match` function the host's handle calls, the two
 * route tables, and (PB-10) the `upgrades` table the host's upgrade handler
 * reads `this.upgrades.get(pathname)` from (both Maps, RT
 * lib/index.js:467-478 and 298-308; the probe verified them on real
 * 0.2.0-rc.2 / 0.2.1-alpha.2 instances). */
export type WebServerShapeCheck = { ok: true } | { ok: false; reasons: string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Pure inspection of the RAW webServer instance — nothing is mutated, so a
 * failed check leaves every route exactly as it was. */
export function checkWebServerShape(webServer: unknown): WebServerShapeCheck {
  if (!isRecord(webServer)) return { ok: false, reasons: ['webServer: not an object'] }
  const reasons: string[] = []
  if (typeof webServer.match !== 'function') reasons.push('match: not a function')
  if (!(webServer.exact instanceof Map)) reasons.push('exact: not a Map')
  if (!(webServer.prefixes instanceof Map)) reasons.push('prefixes: not a Map')
  if (!(webServer.upgrades instanceof Map)) reasons.push('upgrades: not a Map')
  if (reasons.length > 0) return { ok: false, reasons }
  return { ok: true }
}

/** One failure of the bridge answered to a browser, in the diagnostics
 * ring. The query NEVER travels — only the plugin name and the reason. */
export interface PluginRouteFailureRecord {
  time: string
  plugin: string
  reason: string
}

/** What the client status route surfaces about this interception. */
export interface PluginRouteInterceptDiagnostics {
  installed: boolean
  shape: WebServerShapeCheck
  /** Requests forwarded through the relay (virtual ids on declared routes,
   * everything green). */
  forwarded: number
  /** Requests answered with the uniform unbridged 503. */
  refused: number
  /** The refusals keyed by reason. */
  refusalsByReason: Record<string, number>
  /** The most recent refusals, oldest first, capped — time, plugin, reason
   * only, never a query, never a session id. */
  recentFailures: PluginRouteFailureRecord[]
  /** PB-10: tunnels live RIGHT NOW. */
  tunnelsCurrent: number
  /** PB-10: tunnels opened / torn down since the install. */
  tunnelsOpened: number
  tunnelsClosed: number
  /** PB-11: adapter requests forwarded through the relay. */
  adapterForwarded: number
  /** PB-11: adapter JSON answers rewritten by a `client.response` hook, and
   * answers that passed through UNTOUCHED because the buffer cap (8 MB) or
   * a parse failure made a rewrite impossible. */
  adapterResponseRewrites: number
  adapterResponsePassthroughs: number
}

export interface InstallPluginRouteInterceptOptions {
  /** The RAW webServer instance (`ctx.webServer[symbols.original]`). */
  webServer: object
  /** The local declaration registry (the `zenRemote` service's table). */
  registry: BridgeRegistry
  /** The client relay client; `pluginRequest` is the forwarding door. */
  relay: RelayClient
  /** The CURRENT handshake's server id, read live per call; a virtual id
   * minted for another server (or before any handshake) refuses
   * `server-changed`. */
  getServerId: () => string | undefined
  /** The PB-2 bridge verdicts, computed live per call; a plugin that is
   * not bridged right now refuses with the status's own reason. */
  getStatus: () => BridgeStatus[]
  /** The validated adapters (PB-11), as the wiring registered them.
   * Absent/empty — the pluggable default — means no adapter routes exist
   * and this interception behaves exactly as before. */
  adapters?: readonly NormalizedAdapter[]
  /** Progress logging, wired to the context logger by index.ts. */
  log?: (format: string, ...args: unknown[]) => void
}

export interface PluginRouteInterceptHandle {
  /** Restore `match` — ONLY while the instance still holds our wrapper
   * (chained-over wraps go inert instead). Idempotent. */
  uninstall(): void
  diagnostics(): PluginRouteInterceptDiagnostics
}

/** Longest failure ring kept for the status surface. */
const MAX_FAILURES = 10

/** What one declared-route hit carries from the match lookup into its
 * surrogate handler. */
interface DeclaredHit {
  plugin: string
  version: string
  digest: string
  /** The declared route path — the exact string the forward uses. */
  path: string
  sessionParam: string
  /** The EFFECTIVE forwardable methods (PB-9): the declared list, or
   * `['GET']` when the route declared none. */
  methods: string[]
  /** The EFFECTIVE body cap (PB-9), in bytes. */
  maxBody: number
}

export function installPluginRouteIntercept(options: InstallPluginRouteInterceptOptions): PluginRouteInterceptHandle {
  // Shape FIRST, like every wrap: a caller that skipped checkWebServerShape
  // (or a host whose shape changed between the check and this call) gets an
  // INERT handle — nothing on the instance is touched — instead of a
  // TypeError from a missing table midway through the install.
  const shape = checkWebServerShape(options.webServer)
  if (!shape.ok) {
    options.log?.('plugin route intercept refused: %s', shape.reasons.join('; '))
    return {
      uninstall() {},
      diagnostics(): PluginRouteInterceptDiagnostics {
        return {
          installed: false,
          shape,
          forwarded: 0,
          refused: 0,
          refusalsByReason: {},
          recentFailures: [],
          adapterForwarded: 0,
          adapterResponseRewrites: 0,
          adapterResponsePassthroughs: 0,
          tunnelsCurrent: 0,
          tunnelsOpened: 0,
          tunnelsClosed: 0,
        }
      },
    }
  }
  const { webServer, registry, relay, getServerId, getStatus, log } = options
  const adapters = options.adapters ?? []
  const target = webServer as { match: (this: unknown, pathname: string) => unknown }
  const savedMatch = target.match

  let installed = true
  let forwarded = 0
  let refused = 0
  let adapterForwarded = 0
  let adapterResponseRewrites = 0
  let adapterResponsePassthroughs = 0
  let tunnelsCurrent = 0
  let tunnelsOpened = 0
  let tunnelsClosed = 0
  const refusalsByReason: Record<string, number> = {}
  const recentFailures: PluginRouteFailureRecord[] = []

  /** The unbridged refusal written straight onto an upgrading socket
   * (PB-10): the WebSocket handshake never happened, so the "response" is
   * hand-written HTTP — same shape, same marker, then the socket dies
   * without the local plugin ever seeing the connection. */
  const answerUnbridgedSocket = (socket: Socket, plugin: string, reason: string): void => {
    recordRefusal(plugin, reason)
    log?.('plugin upgrade refused for %s: %s', plugin, reason)
    const body = Buffer.from(JSON.stringify({ ok: false, error: { code: 'zr-plugin-unbridged', reason, plugin } }), 'utf8')
    try {
      socket.write(
        `HTTP/1.1 503 Service Unavailable\r\n` +
          `x-zen-remote: unbridged\r\n` +
          `content-type: application/json; charset=utf-8\r\n` +
          `content-length: ${body.length}\r\n` +
          `connection: close\r\n` +
          `\r\n`,
      )
      socket.end(body)
    } catch {
      // The socket was already gone.
    }
  }

  const recordRefusal = (plugin: string, reason: string): void => {
    refused += 1
    refusalsByReason[reason] = (refusalsByReason[reason] ?? 0) + 1
    if (recentFailures.length >= MAX_FAILURES) recentFailures.shift()
    recentFailures.push({ time: new Date().toISOString(), plugin, reason })
  }

  /** The uniform unbridged 503: one shape for every refusal, the local
   * plugin handler never reached. */
  const answerUnbridged = (res: ServerResponse, plugin: string, reason: string): void => {
    recordRefusal(plugin, reason)
    log?.('plugin route refused for %s: %s', plugin, reason)
    res.setHeader('x-zen-remote', 'unbridged')
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.writeHead(503)
    res.end(JSON.stringify({ ok: false, error: { code: 'zr-plugin-unbridged', reason, plugin } }))
  }

  /** The original route handler when it is worth calling at all. */
  const handlerOf = (route: unknown): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined =>
    route !== undefined && isRecord(route) && typeof (route as { handler?: unknown }).handler === 'function'
      ? (route as { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }).handler
      : undefined

  /** The declared route this pathname hits — EXACT equality only this task
   * (a declared prefix does not cover longer paths; that arrives with
   * PB-12). First plugin in registry order wins, deterministically. */
  const declaredRouteOf = (pathname: string): DeclaredHit | undefined => {
    for (const declaration of registry.list()) {
      for (const route of declaration.routes) {
        if (route.path === pathname) {
          return {
            plugin: declaration.plugin,
            version: declaration.version,
            digest: declaration.digest,
            path: route.path,
            sessionParam: route.sessionParam,
            methods: routeMethodsOf(route),
            maxBody: routeMaxBodyOf(route),
          }
        }
      }
    }
    return undefined
  }

  /** The surrogate handler: ONE query parse, the virtual-id gate, the
   * unbridged walls in contract order, then the relay round-trip. */
  const surrogateHandler = (declared: DeclaredHit, originalHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined) =>
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const passthrough = async (): Promise<void> => {
        if (originalHandler !== undefined) {
          await originalHandler(req, res)
          return
        }
        res.writeHead(404)
        res.end()
      }
      // Chained-over: inert passthrough, exactly the posture of the other
      // intercepts.
      if (!installed) {
        await passthrough()
        return
      }
      // ONE parse of the query (the session parameter's home — `match` only
      // ever saw the pathname): everything below reads THIS parse.
      let searchParams: URLSearchParams
      try {
        searchParams = new URL(req.url ?? '/', 'http://local').searchParams
      } catch {
        answerUnbridged(res, declared.plugin, 'bad-query')
        return
      }
      const values = searchParams.getAll(declared.sessionParam)
      // The parameter appearing MORE than once is a shape violation the
      // bridge refuses (bad-query) — never a passthrough, and never a
      // forward of whichever duplicate a parser happens to keep. Its TOTAL
      // absence, though, is the LOCAL route's business (a whole-machine
      // route may simply not take one).
      if (values.length > 1) {
        answerUnbridged(res, declared.plugin, 'bad-query')
        return
      }
      const value = values.length === 1 ? values[0] : undefined
      // A LOCAL id (or none at all): the original route's business — its
      // handler runs exactly as if we were never here.
      if (value === undefined || value === '' || !value.startsWith('zr~')) {
        await passthrough()
        return
      }
      const parts = fromVirtual(value)
      if (parts === undefined || parts.id === '') {
        answerUnbridged(res, declared.plugin, 'bad-query')
        return
      }
      if (parts.serverId !== getServerId()) {
        answerUnbridged(res, declared.plugin, 'server-changed')
        return
      }
      // PB-9: the method must be one the route declared — the write surface
      // is exactly as explicit as the read one was in 2.1, and an undeclared
      // method never reaches the local plugin OR the relay.
      const method = req.method ?? 'GET'
      if (!declared.methods.includes(method)) {
        answerUnbridged(res, declared.plugin, 'method-not-bridged')
        return
      }
      // PB-9: the body gate, BEFORE a byte moves — a declared
      // Content-Length past the route's `maxBody` is refused locally (the
      // relay would refuse it at the streaming count anyway; refusing here
      // saves the round-trip and keeps the plugin out of it entirely).
      const hasBody = method !== 'GET' && method !== 'HEAD'
      const declaredLength = Number(req.headers['content-length'])
      if (hasBody && Number.isFinite(declaredLength) && declaredLength > declared.maxBody) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.writeHead(413)
        res.end(JSON.stringify({ ok: false, error: { code: 'zr-plugin-body-too-large' } }))
        recordRefusal(declared.plugin, 'body-too-large')
        log?.('plugin request for %s refused locally: body-too-large (%s declared)', declared.path, req.headers['content-length'])
        return
      }
      const status = getStatus().find((entry) => entry.plugin === declared.plugin)
      if (status === undefined || !status.bridged) {
        answerUnbridged(res, declared.plugin, status?.reason ?? 'not-on-server')
        return
      }
      forwarded += 1
      // Logged HERE, after the virtual-id gate (PB-5-fix): a local panel
      // polling its route every second must not log a line a second — the
      // bridge only speaks when a request actually leaves for the relay (or
      // is refused below, which answerUnbridged logs).
      log?.('plugin route %s forwards for %s', declared.path, declared.plugin)
      // The session id rides the CHECKED parse, restored to its ORIGINAL
      // form, re-serialized once — what was judged is what is forwarded.
      searchParams.set(declared.sessionParam, parts.id)
      const controller = new AbortController()
      // The counting gate's failure has its OWN abort signal (PB-9-fix, the
      // mirror of the relay route's bodyGateError): tripping the gate is a
      // LOCAL verdict — it must tear the relay round-trip down AND be
      // readable in the catch below without depending on the error MESSAGE
      // surviving undici's fetch rejection. It also tells the relay client
      // (through the aborted signal) that this is a caller abort, never a
      // transport death.
      let bodyGateFailed = false
      const bodyAbort = new AbortController()
      const forwardSignal = AbortSignal.any([controller.signal, bodyAbort.signal])
      const onClientGone = (): void => {
        if (!res.writableEnded) controller.abort()
      }
      res.on('close', onClientGone)
      try {
        const accept = typeof req.headers.accept === 'string' ? req.headers.accept : undefined
        const range = typeof req.headers.range === 'string' ? req.headers.range : undefined
        const requestContentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined
        // PB-9: the request body streams through a counting Transform —
        // node's pipe owns the backpressure, and the route's `maxBody` is
        // enforced ON THE STREAM for a chunked body (no Content-Length for
        // the pre-check above to read). Past the cap the gate errors, which
        // aborts the relay round-trip mid-flight and answers the local 413
        // below (the browser's headers are not out — nothing ever started).
        let bodyStream: ReadableStream<Uint8Array> | null = null
        if (hasBody) {
          let pumped = 0
          const gate = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              pumped += chunk.length
              if (pumped > declared.maxBody) {
                callback(new Error('zr-plugin-body-too-large'))
                return
              }
              callback(null, chunk)
            },
          })
          req.on('error', (error) => gate.destroy(error))
          gate.on('error', () => {
            if (!bodyGateFailed) bodyGateFailed = true
            bodyAbort.abort()
          })
          // The fetch body must be a WEB ReadableStream (undici's contract);
          // Readable.toWeb adapts the counting gate, preserving backpressure.
          bodyStream = Readable.toWeb(gate) as ReadableStream<Uint8Array>
          req.pipe(gate)
        }
        const response = await relay.pluginRequest(
          {
            plugin: declared.plugin,
            version: declared.version,
            digest: declared.digest,
            path: declared.path,
            query: searchParams.toString(),
            method,
            ...(hasBody ? { body: bodyStream } : {}),
            ...(hasBody && requestContentType !== undefined ? { contentType: requestContentType } : {}),
            ...(hasBody && Number.isFinite(declaredLength) && declaredLength > 0 ? { contentLength: declaredLength } : {}),
            ...(accept !== undefined ? { accept } : {}),
            ...(range !== undefined ? { range } : {}),
          },
          forwardSignal,
        )
        // A relay-side refusal travels its OWN marker header (PB-3); the
        // browser sees the uniform unbridged shape with that code as the
        // reason. The relay's JSON body is disposed unread.
        const refusal = response.headers.get('x-zen-remote-error')
        if (refusal !== null) {
          await response.body?.cancel().catch(() => {})
          answerUnbridged(res, declared.plugin, refusal)
          return
        }
        const contentType = response.headers.get('content-type')
        const contentLength = response.headers.get('content-length')
        const cacheControl = response.headers.get('cache-control')
        res.writeHead(response.status, {
          ...(contentType !== null ? { 'content-type': contentType } : {}),
          ...(contentLength !== null ? { 'content-length': contentLength } : {}),
          ...(cacheControl !== null ? { 'cache-control': cacheControl } : {}),
        })
        // Stream the body through with real backpressure; a mid-stream
        // failure with headers already out can only cut the response.
        const reader = response.body?.getReader()
        if (reader !== undefined) {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (!res.write(value)) {
              await new Promise<void>((resolve) => {
                const settled = (): void => {
                  res.off('drain', settled)
                  res.off('close', settled)
                  resolve()
                }
                res.once('drain', settled)
                res.once('close', settled)
              })
            }
          }
        }
        res.end()
      } catch (error) {
        // The gate's local flag FIRST (PB-9-fix): the counting gate tripped
        // mid-forward — the chunked body outgrew the route's `maxBody` while
        // the relay round-trip was still being written. The browser's
        // headers are not out, so the local 413 still fits — same shape the
        // pre-check above answers. The flag is local on purpose: the gate's
        // error cannot be relied on to survive undici's fetch rejection
        // wrapper, and the relay client has (correctly) NOT judged the link
        // offline for a caller abort — answering from the wire's error would
        // misreport this as 503 offline.
        if (bodyGateFailed && !res.headersSent) {
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.writeHead(413)
          res.end(JSON.stringify({ ok: false, error: { code: 'zr-plugin-body-too-large' } }))
          recordRefusal(declared.plugin, 'body-too-large')
          return
        }
        if (controller.signal.aborted || res.destroyed || res.headersSent) {
          // The browser is gone (its abort tore the relay round-trip down)
          // or the body already started: the status cannot change, so the
          // response is cut.
          try {
            res.destroy()
          } catch {
            // Already gone.
          }
          return
        }
        const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : 'offline'
        answerUnbridged(res, declared.plugin, code === 'aborted' ? 'offline' : code)
      } finally {
        res.off('close', onClientGone)
      }
    }

  // ---- PB-11: the adapter interception ---------------------------------------
  //
  // An adapter (src/adapters/, validated into a NormalizedAdapter by the
  // wiring) claims routes of a NON-cooperative plugin: the match lookup
  // below hands one of those requests to a surrogate that locates the
  // session ids (query / path segment / JSON body), classifies the request
  // — every id virtual → forward, none → local passthrough, a mix → the
  // uniform 503 (docs/adr/0001: a remote session never reaches a local
  // plugin) — rewrites the ids to their real halves and forwards through
  // the SAME relay door the cooperative surrogate uses. On the way back a
  // `client.response` hook maps real ids to virtual form inside a buffered
  // JSON answer (8 MB cap; past it the answer passes through untouched).

  /** The adapter route this pathname hits, if any: only an adapter that
   * STILL owns its plugin's registry entry qualifies — a plugin's own
   * cooperative declaration always wins, and the adapter yields silently
   * here (the registration-time yield logged a line already). */
  const adapterRouteOf = (pathname: string): { adapter: NormalizedAdapter; route: NormalizedAdapterRoute } | undefined => {
    if (!installed || adapters.length === 0) return undefined
    for (const adapter of adapters) {
      if (!adapterOwnsRegistryEntry(adapter, registry.get(adapter.plugin))) continue
      for (const route of adapter.routes) {
        if (route.local) continue
        if (adapterPathMatches(route, pathname)) return { adapter, route }
      }
    }
    return undefined
  }

  /** The adapter surrogate: locate → classify → walls → rewrite → hooks →
   * the relay round-trip, then the buffered JSON rewrite on the way back. */
  const adapterSurrogateHandler = (hit: { adapter: NormalizedAdapter; route: NormalizedAdapterRoute }, originalHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined) =>
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const { adapter, route } = hit
      const plugin = adapter.plugin
      // The local passthrough. A body-locating route has ALREADY consumed
      // the request body by the time this runs, so the replay hands the
      // buffered bytes back behind the original request's metadata — the
      // shape a local handler actually reads (method/url/headers/pipe).
      const passthrough = async (replayBody?: Buffer): Promise<void> => {
        if (originalHandler === undefined) {
          res.writeHead(404)
          res.end()
          return
        }
        if (replayBody !== undefined) {
          const replay = new Transform()
          replay.end(replayBody)
          Object.assign(replay, { method: req.method, url: req.url, headers: req.headers })
          await originalHandler(replay as unknown as IncomingMessage, res)
          return
        }
        await originalHandler(req, res)
      }
      // Chained-over: inert passthrough, exactly the posture of the other
      // intercepts.
      if (!installed) {
        await passthrough()
        return
      }
      let controller: AbortController | undefined
      const onClientGone = (): void => {
        if (controller !== undefined && !res.writableEnded) controller.abort()
      }
      res.on('close', onClientGone)
      try {
        let url: URL
        try {
          url = new URL(req.url ?? '/', 'http://local')
        } catch {
          answerUnbridged(res, plugin, 'bad-query')
          return
        }
        const pathname = url.pathname
        const searchParams = url.searchParams
        const method = req.method ?? 'GET'
        const hasBody = method !== 'GET' && method !== 'HEAD'

        // A body-locating route buffers the request body up front (bounded
        // by the route's own maxBody — the cooperative 413 shape, answered
        // locally, the plugin never reached). Any other locator's body
        // streams through the cooperative counting gate below.
        let bufferedBody: Buffer | undefined
        if (hasBody && route.locator.in === 'json-body') {
          const chunks: Buffer[] = []
          let size = 0
          let over = false
          for await (const chunk of req) {
            size += (chunk as Buffer).length
            if (size > route.maxBody) {
              over = true
              break
            }
            chunks.push(Buffer.from(chunk as Uint8Array))
          }
          if (over) {
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.writeHead(413)
            res.end(JSON.stringify({ ok: false, error: { code: 'zr-plugin-body-too-large' } }))
            recordRefusal(plugin, 'body-too-large')
            return
          }
          bufferedBody = Buffer.concat(chunks)
        }
        // A present body must be a JSON object when the route locates in
        // the body: a remote request with a corrupted body refuses rather
        // than falling through to the local plugin.
        let parsedBody: unknown
        let bodyGiven = false
        if (hasBody && route.locator.in === 'json-body' && bufferedBody !== undefined && bufferedBody.length > 0) {
          try {
            parsedBody = JSON.parse(bufferedBody.toString('utf8'))
            bodyGiven = true
          } catch {
            answerUnbridged(res, plugin, 'bad-query')
            return
          }
        }

        // The remote/local verdict on the ids as they arrived.
        const verdict = classifyAdapterRequest(route, pathname, searchParams, bodyGiven ? parsedBody : undefined)
        if (verdict.kind === 'local') {
          await passthrough(bufferedBody)
          return
        }
        if (verdict.kind === 'mixed') {
          answerUnbridged(res, plugin, 'bad-query')
          return
        }
        // Remote: the route's method wall, then per-id server walls.
        if (!route.methods.includes(method)) {
          answerUnbridged(res, plugin, 'method-not-bridged')
          return
        }
        const serverId = getServerId()
        for (const idHit of verdict.hits) {
          const parts = fromVirtual(idHit.value)
          if (parts === undefined || parts.id === '') {
            answerUnbridged(res, plugin, 'bad-query')
            return
          }
          if (parts.serverId !== serverId) {
            answerUnbridged(res, plugin, 'server-changed')
            return
          }
        }
        // The bridge verdicts (version skew, consent, offline…) judged from
        // the SAME live table the cooperative surrogate reads — the
        // adapter's registry entry makes the plugin indistinguishable from
        // a cooperative one here.
        const status = getStatus().find((entry) => entry.plugin === plugin)
        if (status === undefined || !status.bridged) {
          answerUnbridged(res, plugin, status?.reason ?? 'not-on-server')
          return
        }

        // Real ids in, coordinates rewritten.
        const rewrite = rewriteAdapterRequest(route, pathname, searchParams, bodyGiven ? parsedBody : undefined, verdict.hits, (virtualId) => fromVirtual(virtualId)!.id)
        // The client hook: refuse, or replace the parsed body wholesale.
        // The hook sees the REWRITTEN body — the ids are already real (the
        // design's order: locate → rewrite → hook → forward).
        const hook = adapter.hooks.client?.request
        if (hook !== undefined) {
          const hookedBody = bodyGiven && rewrite.bodyText !== undefined ? JSON.parse(rewrite.bodyText) : bodyGiven ? parsedBody : undefined
          let hookVerdict: AdapterVerdict
          try {
            hookVerdict = hook({ method, route, query: rewrite.query, body: hookedBody })
          } catch {
            answerUnbridged(res, plugin, 'internal')
            return
          }
          if (!hookVerdict.allow) {
            answerUnbridged(res, plugin, hookVerdict.reason)
            return
          }
          if (hookedBody !== undefined && hookVerdict.body !== undefined) {
            rewrite.bodyText = JSON.stringify(hookVerdict.body)
          }
        }

        controller = new AbortController()
        adapterForwarded += 1
        // The forward. A body-locating route sends its (possibly rewritten)
        // buffer; any other body rides the cooperative counting gate.
        const accept = typeof req.headers.accept === 'string' ? req.headers.accept : undefined
        const range = typeof req.headers.range === 'string' ? req.headers.range : undefined
        const requestContentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined
        let bodyStream: ReadableStream<Uint8Array> | null = null
        let contentLength: number | undefined
        if (hasBody && route.locator.in === 'json-body') {
          const payload = rewrite.bodyText !== undefined ? Buffer.from(rewrite.bodyText, 'utf8') : bufferedBody ?? Buffer.alloc(0)
          contentLength = payload.length
          bodyStream = Readable.toWeb(Readable.from(payload)) as ReadableStream<Uint8Array>
        } else if (hasBody) {
          let pumped = 0
          const gate = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              pumped += chunk.length
              if (pumped > route.maxBody) {
                callback(new Error('zr-plugin-body-too-large'))
                return
              }
              callback(null, chunk)
            },
          })
          gate.on('error', () => controller?.abort())
          bodyStream = Readable.toWeb(gate) as ReadableStream<Uint8Array>
          req.pipe(gate)
        }
        const response = await relay.pluginRequest(
          {
            plugin,
            version: adapter.declaration.version,
            digest: adapter.digest,
            path: rewrite.pathname,
            query: rewrite.query.toString(),
            method,
            ...(bodyStream !== null ? { body: bodyStream } : {}),
            ...(bodyStream !== null && requestContentType !== undefined ? { contentType: requestContentType } : {}),
            ...(bodyStream !== null && contentLength !== undefined ? { contentLength } : {}),
            ...(accept !== undefined ? { accept } : {}),
            ...(range !== undefined ? { range } : {}),
          },
          controller.signal,
        )
        const refusal = response.headers.get('x-zen-remote-error')
        if (refusal !== null) {
          await response.body?.cancel().catch(() => {})
          answerUnbridged(res, plugin, refusal)
          return
        }
        const contentType = response.headers.get('content-type')
        const responseLength = response.headers.get('content-length')
        const cacheControl = response.headers.get('cache-control')
        const responseHook = adapter.hooks.client?.response
        const rewriteCandidate = responseHook !== undefined && !route.stream && contentType !== null && contentType.includes('application/json')
        if (!rewriteCandidate) {
          // The verbatim pump: chunk-for-chunk with real backpressure, the
          // cooperative surrogate's discipline.
          res.writeHead(response.status, {
            ...(contentType !== null ? { 'content-type': contentType } : {}),
            ...(responseLength !== null ? { 'content-length': responseLength } : {}),
            ...(cacheControl !== null ? { 'cache-control': cacheControl } : {}),
          })
          const reader = response.body?.getReader()
          if (reader !== undefined) {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (!res.write(value)) {
                await new Promise<void>((resolve) => {
                  const settled = (): void => {
                    res.off('drain', settled)
                    res.off('close', settled)
                    resolve()
                  }
                  res.once('drain', settled)
                  res.once('close', settled)
                })
              }
            }
          }
          res.end()
          return
        }
        // The buffered rewrite: the whole answer (≤ 8 MB), parsed, hooked,
        // re-serialized with a corrected content-length. Past the cap — or
        // on a parse/hook failure — the answer passes through untouched.
        const reader = response.body!.getReader()
        const chunks: Buffer[] = []
        let size = 0
        let overflow = false
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          // The over-cap chunk ITSELF is body content — it lands in the
          // passthrough buffer too; only the REWRITE is cancelled.
          chunks.push(Buffer.from(value))
          if (size > MAX_ADAPTER_RESPONSE_BUFFER_BYTES) {
            overflow = true
            break
          }
        }
        if (overflow) {
          adapterResponsePassthroughs += 1
          res.writeHead(response.status, {
            ...(contentType !== null ? { 'content-type': contentType } : {}),
            ...(responseLength !== null ? { 'content-length': responseLength } : {}),
            ...(cacheControl !== null ? { 'cache-control': cacheControl } : {}),
          })
          for (const chunk of chunks) {
            if (!res.write(chunk)) {
              await new Promise<void>((resolve) => {
                const settled = (): void => {
                  res.off('drain', settled)
                  res.off('close', settled)
                  resolve()
                }
                res.once('drain', settled)
                res.once('close', settled)
              })
            }
          }
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (!res.write(value)) {
              await new Promise<void>((resolve) => {
                const settled = (): void => {
                  res.off('drain', settled)
                  res.off('close', settled)
                  resolve()
                }
                res.once('drain', settled)
                res.once('close', settled)
              })
            }
          }
          res.end()
          return
        }
        const text = Buffer.concat(chunks).toString('utf8')
        let rewrittenBody: unknown
        try {
          rewrittenBody = responseHook({
            status: response.status,
            body: JSON.parse(text),
            virtualize: (id: string) => toVirtual(serverId ?? '', id),
            isVirtual: (value: unknown) => isVirtual(value),
          })
        } catch {
          adapterResponsePassthroughs += 1
          const passthroughBody = Buffer.from(text, 'utf8')
          res.writeHead(response.status, {
            ...(contentType !== null ? { 'content-type': contentType } : {}),
            ...(cacheControl !== null ? { 'cache-control': cacheControl } : {}),
            'content-length': String(passthroughBody.length),
          })
          res.end(passthroughBody)
          return
        }
        adapterResponseRewrites += 1
        const outBody = Buffer.from(JSON.stringify(rewrittenBody), 'utf8')
        res.writeHead(response.status, {
          ...(contentType !== null ? { 'content-type': contentType } : {}),
          ...(cacheControl !== null ? { 'cache-control': cacheControl } : {}),
          'content-length': String(outBody.length),
        })
        res.end(outBody)
      } catch (error) {
        if (controller?.signal.aborted || res.destroyed || res.headersSent) {
          try {
            res.destroy()
          } catch {
            // Already gone.
          }
          return
        }
        const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : 'offline'
        answerUnbridged(res, plugin, code === 'aborted' ? 'offline' : code)
      } finally {
        res.off('close', onClientGone)
      }
    }

  /** The wrapped match: original verdict first, then the adapter routes
   * (PB-11 — BEFORE the declaration lookup: the adapter's registry entry
   * IS a declaration, and the cooperative surrogate's query-sessionParam
   * logic is not how an adapter request is judged), then the exact
   * declaration lookup — an undeclared pathname returns whatever the
   * original match answered, untouched. */
  const wrappedMatch = function match(this: unknown, pathname: string): unknown {
    const route = savedMatch.call(this, pathname)
    if (!installed) return route
    if (typeof pathname !== 'string' || !pathname.startsWith('/')) return route
    const adapterHit = adapterRouteOf(pathname)
    if (adapterHit !== undefined) {
      return {
        kind: 'exact',
        path: pathname,
        handler: adapterSurrogateHandler(adapterHit, handlerOf(route)),
      }
    }
    const declared = declaredRouteOf(pathname)
    if (declared !== undefined) {
      return {
        kind: 'exact',
        path: pathname,
        handler: surrogateHandler(declared, handlerOf(route)),
      }
    }
    return route
  }

  // ---- PB-10: the WebSocket upgrade interception -----------------------------
  //
  // The host's upgrade handler reads `this.upgrades.get(pathname)` (RT
  // dsh-host-webserver — the probe verified the shape on real instances).
  // Shadowing that ONE method on the raw instance intercepts every upgrade
  // lookup, including upgrades registered after us. Declared `upgrade`
  // routes with a virtual session id become a byte tunnel to the server:
  // the browser's WebSocket speaks to THIS process, the bytes travel the
  // tunnel, and the REAL handshake (101, frames, close) is produced by the
  // plugin route on the server machine — neither end parses WebSocket
  // frames (docs/adr/0002).

  const targetWithUpgrades = webServer as { upgrades: Map<string, unknown> }
  const savedUpgradesGet = targetWithUpgrades.upgrades.get
  const upgradeRoutesOf = (pathname: string): { plugin: string; version: string; digest: string; path: string; sessionParam: string } | undefined => {
    if (!installed) return undefined
    for (const declaration of registry.list()) {
      for (const route of declaration.routes) {
        if (route.path === pathname && routeUpgradesOf(route)) {
          return {
            plugin: declaration.plugin,
            version: declaration.version,
            digest: declaration.digest,
            path: route.path,
            sessionParam: route.sessionParam,
          }
        }
      }
    }
    return undefined
  }

  /** The tunnel's surrogate upgrade handler. Every outcome — refusal,
   * teardown, the byte pumping — owns the socket's whole remaining life. */
  const surrogateUpgrade = (declared: { plugin: string; version: string; digest: string; path: string; sessionParam: string }, originalHandler: unknown) =>
    (req: IncomingMessage, socket: Socket, head: Buffer): void => {
      // The host never awaits an upgrade handler — the async body runs on
      // its own and every failure path owns the socket's teardown.
      void (async () => {
        log?.('upgrade entered for %s', declared.path)
      const socketGone = (): boolean => socket.destroyed || !socket.writable
      const passthrough = (): void => {
        if (typeof originalHandler === 'function') {
          originalHandler(req, socket, head)
          return
        }
        try {
          socket.destroy()
        } catch {
          // Already gone.
        }
      }
      try {
        // ONE parse of the query — the session parameter's home.
        let searchParams: URLSearchParams
        try {
          searchParams = new URL(req.url ?? '/', 'http://local').searchParams
        } catch {
          answerUnbridgedSocket(socket, declared.plugin, 'bad-query')
          return
        }
        const values = searchParams.getAll(declared.sessionParam)
        if (values.length > 1) {
          answerUnbridgedSocket(socket, declared.plugin, 'bad-query')
          return
        }
        const value = values.length === 1 ? values[0] : undefined
        // A LOCAL session (or no parameter at all): the original upgrade
        // handler's business, the head bytes untouched.
        if (value === undefined || value === '' || !value.startsWith('zr~')) {
          passthrough()
          return
        }
        const parts = fromVirtual(value)
        if (parts === undefined || parts.id === '') {
          answerUnbridgedSocket(socket, declared.plugin, 'bad-query')
          return
        }
        if (parts.serverId !== getServerId()) {
          answerUnbridgedSocket(socket, declared.plugin, 'server-changed')
          return
        }
        // The PB-2 bridge verdict, the SAME wall the HTTP surrogate raises:
        // the tunnel opens only for a plugin bridged RIGHT NOW — an absent
        // or unbridged status refuses with its own reason, and the local
        // plugin handler is never reached.
        const bridgeStatus = getStatus().find((entry) => entry.plugin === declared.plugin)
        if (bridgeStatus === undefined || !bridgeStatus.bridged) {
          answerUnbridgedSocket(socket, declared.plugin, bridgeStatus?.reason ?? 'not-on-server')
          return
        }
        // ---- bridged: open the byte tunnel (PB-10) ---------------------
        const controller = new AbortController()
        socket.on('close', () => controller.abort())
        const wsKey = typeof req.headers['sec-websocket-key'] === 'string' ? req.headers['sec-websocket-key'] : undefined
        const wsVersion = typeof req.headers['sec-websocket-version'] === 'string' ? req.headers['sec-websocket-version'] : undefined
        if (wsKey === undefined || wsVersion === undefined) {
          answerUnbridgedSocket(socket, declared.plugin, 'bad-query')
          return
        }
        const protocol = typeof req.headers['sec-websocket-protocol'] === 'string' ? req.headers['sec-websocket-protocol'] : undefined
        const extensions = typeof req.headers['sec-websocket-extensions'] === 'string' ? req.headers['sec-websocket-extensions'] : undefined
        const query = new URLSearchParams(searchParams)
        query.set(declared.sessionParam, parts.id)
        let tunnel: { tunnel: string; frames: AsyncIterable<Uint8Array> }
        try {
          log?.('opening tunnel for %s', declared.path)
          tunnel = await relay.pluginTunnelOpen(
            {
              plugin: declared.plugin,
              version: declared.version,
              digest: declared.digest,
              path: declared.path,
              query: query.toString(),
              wsHeaders: {
                'sec-websocket-key': wsKey,
                'sec-websocket-version': wsVersion,
                ...(protocol !== undefined ? { 'sec-websocket-protocol': protocol } : {}),
                ...(extensions !== undefined ? { 'sec-websocket-extensions': extensions } : {}),
              },
              ...(head.length > 0 ? { head: head.toString('base64') } : {}),
            },
            controller.signal,
          )
        } catch (error) {
          // The relay refused the open (unbridged walls arrive with their
          // code in the error). The browser's handshake never completes.
          const rawCode = (error as { code?: unknown } | null)?.code
          const code = typeof rawCode === 'string' && rawCode !== '' ? rawCode : 'offline'
          answerUnbridgedSocket(socket, declared.plugin, code)
          return
        }
        tunnelsCurrent += 1
        tunnelsOpened += 1
        log?.('tunnel open for %s: %s', declared.path, tunnel.tunnel)
        // ---- downstream: tunnel frames → the browser socket -------------
        void (async () => {
          try {
            for await (const chunk of tunnel.frames) {
              if (socketGone()) break
              if (!socket.write(chunk)) {
                // Real backpressure: the NEXT frame is not pulled until the
                // browser socket drained — the tunnel's server half pauses
                // its upstream read in turn (the same discipline the NDJSON
                // streams run).
                await new Promise<void>((resolve) => {
                  const settled = (): void => {
                    socket.off('drain', settled)
                    socket.off('close', settled)
                    resolve()
                  }
                  socket.once('drain', settled)
                  socket.once('close', settled)
                })
                if (socketGone()) break
              }
            }
          } catch {
            // The tunnel died (transport or server-side failure) — the
            // browser socket follows, below.
          }
          // Upstream is over: the browser's WebSocket ends here. A WebSocket
          // close frame cannot be synthesized (this is a byte tunnel — the
          // upstream's own close bytes, when the plugin sent any, already
          // travelled as data), so the socket is cut the honest way.
          if (!socketGone()) socket.destroy()
        })()
        // ---- upstream: browser bytes → ordered sends --------------------
        let sendSeq = 0
        let upstreamBroken = false
        let pending = Promise.resolve()
        socket.on('data', (chunk: Buffer) => {
          let offset = 0
          while (offset < chunk.length) {
            const part = chunk.subarray(offset, Math.min(offset + 65536, chunk.length))
            offset += part.length
            const bytes = new Uint8Array(part)
            const seq = sendSeq
            sendSeq += 1
            // ONE in-flight send at a time: each chunk chains behind the
            // previous answer, which is what keeps the server-side sequence
            // gate satisfied and the byte order intact.
            pending = pending.then(async () => {
              if (upstreamBroken) return
              try {
                await relay.pluginTunnelSend(tunnel.tunnel, seq, bytes, controller.signal)
              } catch {
                upstreamBroken = true
              }
            })
          }
        })
        const teardownTunnel = (): void => {
          upstreamBroken = true
          tunnelsCurrent -= 1
          tunnelsClosed += 1
          void relay.pluginTunnelClose(tunnel.tunnel).catch(() => {})
        }
        socket.on('close', teardownTunnel)
        socket.on('error', teardownTunnel)
        } catch {
          // Any unexpected failure in the bridged path: the socket goes.
          try {
            socket.destroy()
          } catch {
            // Already gone.
          }
        }
      })().catch(() => {
        try {
          socket.destroy()
        } catch {
          // Already gone.
        }
      })
      void originalHandler
    }

  const wrappedUpgradesGet = function get(this: Map<string, unknown>, pathname: string): unknown {
    const entry = savedUpgradesGet.call(this, pathname)
    if (!installed) return entry
    if (typeof pathname !== 'string' || !pathname.startsWith('/')) return entry
    const declared = upgradeRoutesOf(pathname)
    if (declared === undefined) return entry
    const originalHandler = entry !== undefined && isRecord(entry) && typeof (entry as { handler?: unknown }).handler === 'function'
      ? (entry as { handler: unknown }).handler
      : undefined
    return {
      path: pathname,
      handler: surrogateUpgrade(declared, originalHandler),
    }
  } as unknown as typeof targetWithUpgrades.upgrades.get

  target.match = wrappedMatch as typeof target.match
  // Instance-owning property shadows Map.prototype.get — exactly the seam
  // the probe verified (the host calls `this.upgrades.get(pathname)`).
  targetWithUpgrades.upgrades.get = wrappedUpgradesGet

  return {
    uninstall() {
      if (!installed) return
      installed = false
      // Only restore while the instance still holds OUR wrapper — a later
      // wrapper chained over us captured this function, and restoring the
      // original would silently drop ITS wrap. Ours goes inert instead.
      if (target.match === wrappedMatch) target.match = savedMatch
      if (targetWithUpgrades.upgrades.get === wrappedUpgradesGet) {
        targetWithUpgrades.upgrades.get = savedUpgradesGet
      }
    },
    diagnostics(): PluginRouteInterceptDiagnostics {
      return {
        installed,
        shape: checkWebServerShape(webServer),
        forwarded,
        refused,
        refusalsByReason: { ...refusalsByReason },
        recentFailures: [...recentFailures],
        adapterForwarded,
        adapterResponseRewrites,
        adapterResponsePassthroughs,
        tunnelsCurrent,
        tunnelsOpened,
        tunnelsClosed,
      }
    },
  }
}
