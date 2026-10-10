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
import type { RelayClient } from './relay-client.js'
import { fromVirtual } from './virtual-id.js'

/** Structural verdict of {@link checkWebServerShape}: the two facts the
 * wrap reads per request — the `match` function the host's handle calls,
 * and the two route tables (both Maps, RT lib/index.js:467-478 and 298-308;
 * the probe verified them on real 0.2.0-rc.2 / 0.2.1-alpha.2 instances). */
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
}

export function installPluginRouteIntercept(options: InstallPluginRouteInterceptOptions): PluginRouteInterceptHandle {
  const { webServer, registry, relay, getServerId, getStatus, log } = options
  const target = webServer as { match: (this: unknown, pathname: string) => unknown }
  const savedMatch = target.match

  let installed = true
  let forwarded = 0
  let refused = 0
  const refusalsByReason: Record<string, number> = {}
  const recentFailures: PluginRouteFailureRecord[] = []

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
      if (req.method !== 'GET') {
        answerUnbridged(res, declared.plugin, 'method-not-bridged')
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
      const onClientGone = (): void => {
        if (!res.writableEnded) controller.abort()
      }
      res.on('close', onClientGone)
      try {
        const accept = typeof req.headers.accept === 'string' ? req.headers.accept : undefined
        const range = typeof req.headers.range === 'string' ? req.headers.range : undefined
        const response = await relay.pluginRequest(
          {
            plugin: declared.plugin,
            version: declared.version,
            digest: declared.digest,
            path: declared.path,
            query: searchParams.toString(),
            ...(accept !== undefined ? { accept } : {}),
            ...(range !== undefined ? { range } : {}),
          },
          controller.signal,
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

  /** The wrapped match: original verdict first, then the exact declaration
   * lookup — an undeclared pathname returns whatever the original match
   * answered, untouched. */
  const wrappedMatch = function match(this: unknown, pathname: string): unknown {
    const route = savedMatch.call(this, pathname)
    if (!installed) return route
    if (typeof pathname !== 'string' || !pathname.startsWith('/')) return route
    const declared = declaredRouteOf(pathname)
    if (declared === undefined) return route
    return {
      kind: 'exact',
      path: pathname,
      handler: surrogateHandler(declared, handlerOf(route)),
    }
  }

  target.match = wrappedMatch as typeof target.match

  return {
    uninstall() {
      if (!installed) return
      installed = false
      // Only restore while the instance still holds OUR wrapper — a later
      // wrapper chained over us captured this function, and restoring the
      // original would silently drop ITS wrap. Ours goes inert instead.
      if (target.match === wrappedMatch) target.match = savedMatch
    },
    diagnostics(): PluginRouteInterceptDiagnostics {
      return {
        installed,
        shape: checkWebServerShape(webServer),
        forwarded,
        refused,
        refusalsByReason: { ...refusalsByReason },
        recentFailures: [...recentFailures],
      }
    },
  }
}
