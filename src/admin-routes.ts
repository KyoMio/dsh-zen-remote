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
 * Every POST additionally passes sameOriginPost, and bodies are capped at
 * 16 KiB of JSON object. The handler is built by a factory so the tests can
 * drive it over a real socket with a mock gateway and a mock admit.
 */

import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConfigSource, ZenRemoteConfig } from './config.js'
import { responseJson, sameOriginPost } from './http.js'

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
