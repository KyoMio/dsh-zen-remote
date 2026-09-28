/**
 * Admin routes for the 2.0.0 settings surface (T14): pairing, device
 * management and a push test, driven from the DSH plugin page's settings
 * block (the T15 client half) instead of the gateway's own admin page.
 *
 * Why these live in the HOST process rather than the gateway: the gateway's
 * admin API is loopback-only by design (isLocalDirect — loopback peer, no
 * X-Forwarded-* headers), while a browser page runs on DSH's origin, never
 * on the gateway's. So the browser talks to THESE same-origin routes and
 * this module then calls the gateway AS the local machine — a bare
 * `http://127.0.0.1:<port>` request with hand-built headers (no cookies, no
 * Origin, no forwarded anything) that `isLocalDirect` admits.
 *
 * Two walls every route applies, in order:
 *
 *   1. `admit` — routes registered via webServer.register do NOT pass
 *      through DSH's `/api` authentication, so each request must ask the
 *      connection service itself; its rejection is relayed verbatim.
 *   2. The gateway marker. A request wearing `x-zen-remote-via` arrived
 *      THROUGH the gateway from a remote device (the gateway strips
 *      client-forged copies before stamping its own). POSTs are refused —
 *      pairing and device management are server-side acts. GET status is
 *      answered, but with the live pairing code stripped. The marker wall
 *      runs BEFORE same-origin because a forwarded request presents as
 *      same-origin (the gateway rewrites Origin/Host), so the marker is the
 *      only thing identifying it.
 *
 * The ONE deliberate exception is the shares route (T33a): toggling session
 * sharing is exactly what the spec grants the Web application端 (devices
 * behind the gateway have full server permissions), so there the marker wall
 * is skipped and a forwarded POST passes once it clears admit and
 * same-origin. Desktop application clients can never reach any admin route —
 * the gateway only forwards them into the relay prefix.
 *
 * Every POST additionally passes sameOriginPost, and bodies are capped at
 * 16 KiB of JSON object. The handler is built by a factory so the tests can
 * drive it over a real socket with a mock gateway and a mock admit.
 */

import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConfigSource, ZenRemoteConfig } from './config.js'
import { responseJson, sameOriginPost } from './http.js'
import type { RelayGateway } from './relay-server.js'
import { restoreBusy } from './share-ops.js'
import type { AgentStatusLike } from './share-ops.js'
import type { ShareStore } from './share-store.js'

/** Prefix all admin routes live under (one webServer prefix registration). */
export const ADMIN_ROUTE_PREFIX = '/_dsh/zen-remote/admin'

/** GET: the gateway's status verbatim plus the effective config; remote
 * callers get the live pairing code stripped. */
export const ADMIN_STATUS_ROUTE = `${ADMIN_ROUTE_PREFIX}/status`

/** POST `{role}`: mint a pairing code. */
export const ADMIN_PAIR_ROUTE = `${ADMIN_ROUTE_PREFIX}/pair`

/** POST `{action, id?, role?, kind?, name?}`: device management, whitelist below. */
export const ADMIN_ACTION_ROUTE = `${ADMIN_ROUTE_PREFIX}/action`

/** POST: fire one fixed test notification through the gateway. */
export const ADMIN_PUSH_TEST_ROUTE = `${ADMIN_ROUTE_PREFIX}/push-test`

/** GET: every shared session with its clocks, viewers and titles.
 * POST `{action, sessionId?}`: share / unshare / unshare-all (T33a). */
export const ADMIN_SHARES_ROUTE = `${ADMIN_ROUTE_PREFIX}/shares`

/** Longest wait for one gateway round-trip. */
const GATEWAY_TIMEOUT_MS = 5000

/** Inbound admin body cap — the settings forms send a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024

/** Tag every test notification carries, so the phone can spot and sweep them. */
const TEST_PUSH_TAG = 'dsh-zen-remote-test'

/** The device-management verbs this surface forwards. `new-code` is
 * deliberately absent: minting codes is the pair route's job, and forwarding
 * it twice would only blur which surface created the live code. */
const FORWARDABLE_ACTIONS: ReadonlySet<string> = new Set(['set-role', 'set-kind', 'rename', 'revoke', 'revoke-all'])

/** The share-toggle verbs POST shares understands (T33a). */
const SHARE_ACTIONS: ReadonlySet<string> = new Set(['share', 'unshare', 'unshare-all'])

/** Longest wait for one session/projections call (titles, share existence).
 * A hung typert gateway must not hold a route open forever. */
const PROJECTION_TIMEOUT_MS = 5000

/** Fixed test-push copy — Chinese by default, English for `lang: 'en'`
 * (`'auto'` has no requester signal here, so it falls to Chinese). */
const TEST_PUSH_COPY = {
  zh: { title: 'DSH 测试推送', body: '这是一条来自 dsh-zen-remote 设置页的测试通知' },
  en: { title: 'DSH Test Push', body: 'This is a test notification from the dsh-zen-remote settings page' },
} as const

/**
 * One rejection carrying the status the client should see.
 *
 * Fields are assigned in the body rather than declared as constructor
 * parameter properties: check scripts import these modules through Node's
 * strip-only type stripping, which rejects that syntax (same reason as
 * UploadError in index.ts).
 */
class AdminError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AdminError'
    this.status = status
    this.code = code
  }
}

/** What `connection.admit` answers: the operator peer, or the refusal status. */
export type AdminAdmission = { readonly peer: unknown } | { readonly rejection: 401 | 403 }

/** The effective-config snapshot resolveConfig() produces, recomputed per request. */
export interface AdminConfigSnapshot {
  values: ZenRemoteConfig
  sources: Record<keyof ZenRemoteConfig, ConfigSource>
}

export interface AdminHandlerOptions {
  /** The connection service's admit, injected by apply(); tests fake it. */
  admit: (req: IncomingMessage) => AdminAdmission
  /** Gateway root — `http://127.0.0.1:<port>` in production. */
  gatewayBase: string
  /** Fresh resolveConfig() per call — volatile row fields must not go stale,
   * and the test-push copy reads its `lang` from here per request. */
  getConfig: () => AdminConfigSnapshot
  /** Longest wait for one gateway round-trip, defaulting to 5s. Tests inject
   * a short value so a silent gateway fails the request in milliseconds. */
  timeoutMs?: number
  /** The shared-session table backing the shares routes (T33a). Absent — a
   * composition that never built the table — and both shares routes answer
   * 404 like any unknown admin path. */
  store?: ShareStore
  /** The typertGateway service, looked up PER REQUEST through the host
   * context's reflection layer (`ctx.get`: no inject requirement, undefined
   * when the composition has none). Titles and the share action's existence
   * check go through it; a failed lookup degrades — titles are null and
   * share trusts the table alone. The lookup itself must never be allowed to
   * throw into the route, so callers wrap it. */
  typert?: () => RelayGateway | undefined
  /** Live agent roster for the busy restore a successful `share` performs.
   * Absent or throwing means "no information": nothing is marked busy. */
  listAgents?: () => readonly AgentStatusLike[]
  /** Current viewer count per shared session; T22b will inject the real
   * relay counter. Defaults to zero. */
  viewerCount?: (sessionId: string) => number
  /** Longest wait for one session/projections call (titles and the share
   * existence check). Default {@link PROJECTION_TIMEOUT_MS}; a timed-out
   * title is null and a timed-out existence check is a 502. Tests inject a
   * short value. */
  projectionTimeoutMs?: number
}

export type AdminHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/**
 * Read the whole body under the cap and demand one JSON object. An empty
 * body counts as `{}` — the gateway's own reader treats absence the same
 * way, and the push-test button posts no body at all.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  // A declared oversized body is refused before a byte is read, so the client
  // gets its 400 without the server (or the phone) spending the whole body on
  // the wire. The streaming cap below remains as the chunked-body guard.
  const declared = req.headers['content-length']
  const expected = declared === undefined ? undefined : Number(declared)
  if (expected !== undefined && Number.isSafeInteger(expected) && expected > MAX_BODY_BYTES) {
    throw new AdminError(400, 'bad-request', `request body exceeds the ${MAX_BODY_BYTES}-byte limit`)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > MAX_BODY_BYTES) {
      throw new AdminError(400, 'bad-request', `request body exceeds the ${MAX_BODY_BYTES}-byte limit`)
    }
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new AdminError(400, 'bad-request', 'request body must be valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AdminError(400, 'bad-request', 'request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

interface GatewayReply {
  status: number
  body: unknown
}

/**
 * One call to the gateway AS the local machine: a fresh loopback connection
 * with only the headers this call needs. No cookie, no Origin, and above all
 * no X-Forwarded-* — any of those would make the gateway's isLocalDirect
 * classify the call as proxied/remote and refuse the local-only surface.
 * Resolves with whatever parsable JSON the gateway returned, at any status;
 * deciding what that means for the route is the caller's job.
 */
async function callGateway(options: AdminHandlerOptions, method: 'GET' | 'POST', path: string, payload?: unknown): Promise<GatewayReply> {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, options.gatewayBase),
      {
        method,
        headers: body === undefined
          ? undefined
          : { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)) },
        signal: AbortSignal.timeout(options.timeoutMs ?? GATEWAY_TIMEOUT_MS),
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        response.on('error', () => {
          reject(new AdminError(502, 'gateway-unreachable', 'The gateway response failed'))
        })
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
          } catch {
            reject(new AdminError(502, 'gateway-unreachable', 'The gateway returned an unparsable response'))
          }
        })
      },
    )
    request.on('error', () => {
      reject(new AdminError(502, 'gateway-unreachable', 'The gateway did not answer'))
    })
    request.end(body)
  })
}

/**
 * One gateway round-trip for a state-changing route. A 2xx reply relays to
 * the browser verbatim; anything else becomes a 502 error envelope — the
 * gateway DID answer, but with a refusal the settings page must not mistake
 * for success (and must not see raw, since the envelope shape is ours).
 */
async function relay(options: AdminHandlerOptions, method: 'GET' | 'POST', path: string, payload: unknown, res: ServerResponse): Promise<void> {
  const reply = await callGateway(options, method, path, payload)
  if (reply.status < 200 || reply.status >= 300) {
    responseJson(res, 502, { ok: false, error: { code: 'gateway-error', status: reply.status } })
    return
  }
  responseJson(res, reply.status, reply.body)
}

function testPushPayload(lang: ZenRemoteConfig['lang']): { title: string; body: string; tag: string } {
  return { ...(lang === 'en' ? TEST_PUSH_COPY.en : TEST_PUSH_COPY.zh), tag: TEST_PUSH_TAG }
}

/** GET status: the gateway payload plus the live config. Recomputed per
 * request — volatile row fields (serverName, idleHours, …) change without a
 * plugin restart, so an apply-time snapshot would go stale. */
async function respondStatus(options: AdminHandlerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const viaGateway = req.headers['x-zen-remote-via'] !== undefined
  const config = options.getConfig()
  let gateway: unknown = null
  let gatewayStatus: number | null = null
  let gatewayReachable = false
  try {
    const reply = await callGateway(options, 'GET', '/lan-gate/status')
    gatewayStatus = reply.status
    // A parsable JSON reply is not automatically a healthy gateway: an error
    // envelope (403, 500) must not surface as "reachable".
    if (reply.status >= 200 && reply.status < 300) {
      gateway = reply.body
      gatewayReachable = true
    }
  } catch {
    // No answer at all (refused, reset, timeout, non-JSON): gatewayStatus
    // stays null and the settings page renders from config alone.
  }
  // A remote device may see the device list but never the live pairing code.
  if (viaGateway && gateway !== null && typeof gateway === 'object') {
    ;(gateway as { pairing?: unknown }).pairing = null
  }
  responseJson(res, 200, { ok: true, gateway, gatewayReachable, gatewayStatus, config, viaGateway })
}

/** One rejection after the per-call projection timeout. Timer unref'd: a
 * settled call must not keep the process alive for the leftover tail. */
function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('projection timed out')), ms)
    if (typeof timer === 'object' && timer !== null && typeof (timer as { unref?: unknown }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
  })
}

/** What one `session/projections` call can turn out to be. `no-gateway` is
 * the composition without the service; `no-session` is DSH's own null
 * answer for a dead session id; `values` carries the projection values
 * (empty object when they arrived in an unexpected shape). */
type ProjectionOutcome =
  | { kind: 'no-gateway' }
  | { kind: 'no-session' }
  | { kind: 'values'; values: Record<string, unknown> }

/**
 * One call to the typert gateway's `session/projections`, under the per-call
 * timeout. Every failure mode the route can survive is a VALUE here — only
 * a transport failure or a timeout throws, and the caller decides what those
 * mean (titles: null; existence: 502). The typert lookup runs INSIDE the
 * guard: a throwing lookup is a degraded composition, not a route failure.
 */
async function projectionOf(options: AdminHandlerOptions, sessionId: string): Promise<ProjectionOutcome> {
  let gateway: RelayGateway | undefined
  try {
    gateway = options.typert?.()
  } catch {
    return { kind: 'no-gateway' }
  }
  if (gateway === undefined) return { kind: 'no-gateway' }
  const value = await Promise.race([
    gateway.invoke({ namespace: 'session', method: 'projections', args: { request: { sessionId } } }),
    rejectAfter(options.projectionTimeoutMs ?? PROJECTION_TIMEOUT_MS),
  ])
  if (value === null || value === undefined) return { kind: 'no-session' }
  const values = (value as { values?: unknown }).values
  return {
    kind: 'values',
    values: values !== null && typeof values === 'object' ? (values as Record<string, unknown>) : {},
  }
}

/**
 * One session title through `session/projections`. Anything other than a
 * string answer — a null projection (session gone), a service-less or
 * degraded composition, a transport failure, a timeout — is `null`, and one
 * failed title must never fail the listing around it.
 */
async function titleOf(options: AdminHandlerOptions, sessionId: string): Promise<string | null> {
  try {
    const outcome = await projectionOf(options, sessionId)
    if (outcome.kind !== 'values') return null
    const title = outcome.values.title
    return typeof title === 'string' ? title : null
  } catch {
    return null
  }
}

/**
 * Prove a session exists before `share` enters it into the table, and hand
 * back its projection values for the caller's follow-up checks. The same
 * `session/projections` call the titles use, where a `null` projection IS
 * the "no such live session" answer. A transport failure or timeout is NOT
 * a null — it refuses with 502 rather than quietly sharing a session nobody
 * could see. Without a typert gateway there is nothing to ask, and the table
 * alone is the truth available (empty values, no objection).
 */
async function requireSession(options: AdminHandlerOptions, sessionId: string): Promise<Record<string, unknown>> {
  let outcome: ProjectionOutcome
  try {
    outcome = await projectionOf(options, sessionId)
  } catch {
    throw new AdminError(502, 'gateway-unreachable', 'The session lookup failed')
  }
  if (outcome.kind === 'no-gateway') return {}
  if (outcome.kind === 'no-session') throw new AdminError(404, 'no-session', `no live session "${sessionId}"`)
  return outcome.values
}

/** GET shares: the table verbatim, plus the derived fields the settings page
 * renders — the idle countdown (busy reads `Infinity` from the store, `null`
 * on the wire), the current viewer count, and the session titles, fetched
 * concurrently so one slow or failing lookup delays nobody else. */
async function respondShares(options: AdminHandlerOptions, res: ServerResponse): Promise<void> {
  const store = options.store as ShareStore
  const viewerCount = options.viewerCount ?? (() => 0)
  const shares = store.list().map((entry) => {
    const remaining = store.remainingMs(entry.sessionId)
    return {
      sessionId: entry.sessionId,
      sharedAt: entry.sharedAt,
      lastActivityAt: entry.lastActivityAt,
      busy: entry.busy,
      remainingMs: remaining === Infinity ? null : remaining,
      viewers: viewerCount(entry.sessionId),
      title: null as string | null,
    }
  })
  await Promise.all(shares.map(async (row) => {
    row.title = await titleOf(options, row.sessionId)
  }))
  responseJson(res, 200, { ok: true, shares })
}

/**
 * Build the admin route handler for one plugin row. The returned handler
 * owns the full response lifecycle of every request under
 * {@link ADMIN_ROUTE_PREFIX} and never throws.
 */
export function createAdminHandler(options: AdminHandlerOptions): AdminHandler {
  return async (req, res) => {
    // Wall 1 first: DSH's own admission (webServer routes skip /api auth).
    const admission = options.admit(req)
    if ('rejection' in admission) {
      responseJson(res, admission.rejection, {
        ok: false,
        error: { code: admission.rejection === 401 ? 'unauthorized' : 'forbidden' },
      })
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const route = url.pathname
    const method = req.method ?? 'GET'
    try {
      if (route === ADMIN_STATUS_ROUTE) {
        if (method !== 'GET') {
          res.setHeader('Allow', 'GET')
          responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } })
          return
        }
        await respondStatus(options, req, res)
        return
      }
      if (route === ADMIN_SHARES_ROUTE) {
        // No table, no route: a composition that never built the share store
        // answers like any unknown admin path.
        if (options.store === undefined) {
          responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown admin route' } })
          return
        }
        if (method === 'GET') {
          await respondShares(options, res)
          return
        }
        if (method === 'POST') {
          // The deliberate exception to the marker wall (see the module
          // comment): the Web application端 behind the gateway may toggle
          // sharing, so a via-gateway POST is NOT refused here. Same-origin
          // still applies — a forwarded request passes it because the
          // gateway rewrites Origin/Host onto the upstream origin.
          if (!sameOriginPost(req)) {
            responseJson(res, 403, {
              ok: false,
              error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
            })
            return
          }
          const body = await readJsonBody(req)
          const action = body.action
          if (typeof action !== 'string' || !SHARE_ACTIONS.has(action)) {
            responseJson(res, 400, {
              ok: false,
              error: { code: 'bad-action', message: `action must be one of ${[...SHARE_ACTIONS].join(', ')}` },
            })
            return
          }
          const store: ShareStore = options.store
          if (action === 'unshare-all') {
            for (const entry of store.list()) store.unshare(entry.sessionId, 'manual')
            responseJson(res, 200, { ok: true })
            return
          }
          const sessionId = body.sessionId
          if (typeof sessionId !== 'string' || sessionId === '') {
            responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId is required' } })
            return
          }
          if (action === 'share') {
            const values = await requireSession(options, sessionId)
            // Subagent children never enter the table — they inherit
            // reachability through the parent chain. DSH marks the identity
            // in the projection's `subagent` field (dsh-subagent folds
            // `subagent/descriptor` events; the view is the identity object
            // or null — null ⟺ no valid descriptor, so OBJECT is the
            // subagent answer, never merely "not undefined").
            if (values.subagent !== null && typeof values.subagent === 'object') {
              responseJson(res, 400, {
                ok: false,
                error: { code: 'subagent-session', message: 'subagent sessions are reachable through their parent and cannot be shared alone' },
              })
              return
            }
            store.share(sessionId)
            // A session whose agent is mid-turn must not look idle: the same
            // restore a restart runs, scoped to whatever runs right now.
            restoreBusy(store, options.listAgents ?? (() => []))
            responseJson(res, 200, { ok: true })
            return
          }
          store.unshare(sessionId, 'manual')
          responseJson(res, 200, { ok: true })
          return
        }
        res.setHeader('Allow', 'GET, POST')
        responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET or POST' } })
        return
      }
      if (route === ADMIN_PAIR_ROUTE || route === ADMIN_ACTION_ROUTE || route === ADMIN_PUSH_TEST_ROUTE) {
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST')
          responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } })
          return
        }
        // Wall 2, BEFORE same-origin: a forwarded remote request presents as
        // same-origin (the gateway rewrites Origin/Host), so the marker is
        // the only signal that says "this did not start on this machine".
        if (req.headers['x-zen-remote-via'] !== undefined) {
          responseJson(res, 403, {
            ok: false,
            error: { code: 'via-gateway', message: '配对与设备管理只能在服务端本机操作' },
          })
          return
        }
        if (!sameOriginPost(req)) {
          responseJson(res, 403, {
            ok: false,
            error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
          })
          return
        }
        if (route === ADMIN_PUSH_TEST_ROUTE) {
          await readJsonBody(req) // drained and validated; the copy is fixed
          // The copy language is read HERE, not at apply time: a lang edit on
          // the row applies live, and getConfig() re-resolves per request.
          await relay(options, 'POST', '/pwa/push/send', testPushPayload(options.getConfig().values.lang), res)
          return
        }
        const body = await readJsonBody(req)
        if (route === ADMIN_ACTION_ROUTE && (typeof body.action !== 'string' || !FORWARDABLE_ACTIONS.has(body.action))) {
          responseJson(res, 400, {
            ok: false,
            error: { code: 'bad-action', message: `action must be one of ${[...FORWARDABLE_ACTIONS].join(', ')}` },
          })
          return
        }
        await relay(options, 'POST', route === ADMIN_PAIR_ROUTE ? '/lan-gate/pair' : '/lan-gate/action', body, res)
        return
      }
      responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown admin route' } })
    } catch (error) {
      if (error instanceof AdminError) {
        responseJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
        return
      }
      responseJson(res, 500, { ok: false, error: { code: 'internal', message: 'The admin route failed' } })
    }
  }
}
