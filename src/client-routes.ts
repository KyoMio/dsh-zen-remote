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

import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import type { AdminAdmission } from './admin-routes.js'
import { classifyClaimResponse, classifyProbe, CLAIM_PATH, normalizeServerUrl, RELAY_PING_PATH } from './client-pairing.js'
import type { ClaimOutcome, ProbeState } from './client-pairing.js'
import { readFileConfig, resolveConfig, unwrapVolatile } from './config.js'
import { assembleDebugReport } from './debug-report.js'
import type { LogRingEntry } from './log-ring.js'
import type { FetchRouteInterceptDiagnostics } from './fetch-route-intercept.js'
import type { CurrentSessionRead, InterceptDiagnostics } from './intercept.js'
import type { PluginRouteInterceptDiagnostics } from './plugin-route-intercept.js'
import { responseJson, sameOriginPost } from './http.js'
import type { BridgeStatus } from './plugin-bridge.js'
import { RELAY_HTTP_ROUTES } from './relay-access.js'
import { relayCredentialsDigest, RelayError } from './relay-client.js'
import type { RelayClient, RelayHttpResult } from './relay-client.js'
import { MAX_PAIRED_SERVERS } from './relay-pool.js'
import type { RelayPool, RelayPoolEntryView } from './relay-pool.js'
import { resolveDshVersion } from './relay-server.js'
import { fromVirtual } from './virtual-id.js'

/** Prefix all client routes live under (one webServer prefix registration). */
export const CLIENT_ROUTE_PREFIX = '/_dsh/zen-remote/client'

/** POST `{serverUrl, code, name}`: redeem a desktop pairing code. */
export const CLIENT_CLAIM_ROUTE = `${CLIENT_ROUTE_PREFIX}/claim`

/** GET: the current connection state (never carries the token). */
export const CLIENT_STATUS_ROUTE = `${CLIENT_ROUTE_PREFIX}/status`

/** POST: one immediate reconnect attempt (T43, the settings page's 立即重连);
 * answered 409 unless the relay client is currently `offline`. */
export const CLIENT_RECONNECT_ROUTE = `${CLIENT_ROUTE_PREFIX}/reconnect`

/** POST: the browser's NETWORK-RESTORED hint.
 *
 * Why this route exists: the host half runs in a plain Node process with no
 * OS network events, and the browser half cannot touch the relay client's
 * memory across the HTTP boundary. So the browser — the only place that can
 * observe `online`/`visibilitychange` — reports the hint here, and the host
 * turns it into ONE controlled probe + reconnect.
 *
 * Deliberately narrower than `reconnect`:
 *  - it first runs `probeHealth()` (authenticated GET /ping); a hint NEVER
 *    alone proves the link is back (`navigator.onLine === true` is not
 *    evidence);
 *  - only a successful probe advances to `networkRestored()`, which itself
 *    refuses outside `offline` and inside its 3s anti-storm gap;
 *  - it answers the probe outcome so the page can log/annotate it.
 *
 * It NEVER changes state by itself: `probeHealth` is read-only, and
 * `networkRestored` is the same controlled path the settings button uses. */
export const CLIENT_NETWORK_HINT_ROUTE = `${CLIENT_ROUTE_PREFIX}/network-hint`

/** GET: the remote-session status the T34 client parts render from (T34) —
 * the relay's serving state, the interface-compatibility verdict, the
 * handshake's server name, and the closed-session map. The prefix is
 * registered on BOTH roles (T34-fix): a host — no relay client wired —
 * answers the empty `{state:'unpaired', versionMismatch:false, serverName:'',
 * closed:{}}` conclusion. It carries no token and no server address. */
export const CLIENT_REMOTE_STATUS_ROUTE = `${CLIENT_ROUTE_PREFIX}/remote-status`

/** GET: the redacted diagnostic report (CU-3, SPEC 方案 C) — `_meta`,
 * `config`, `status`, optional `gateway`, `logs` plates, assembled by
 * {@link assembleDebugReport} and safe to paste into a GitHub issue. Mounted
 * on BOTH roles (each answers its own report); a request that arrived
 * through the gateway is refused BEFORE dispatch (the wizard's via wall) —
 * diagnostics are a machine-local export, and the gateway must never be able
 * to fetch this machine's report for its own device table either. */
export const CLIENT_DEBUG_REPORT_ROUTE = `${CLIENT_ROUTE_PREFIX}/debug-report`

/** POST `{sessionId: <虚拟 id>}`: close one remote session from THIS machine
 * (T34) — the backend forwards the ORIGINAL id through the relay's
 * `POST relay/v1/unshare`, so the server closes it with reason `'client'`. */
export const CLIENT_UNSHARE_ROUTE = `${CLIENT_ROUTE_PREFIX}/unshare`

/** POST `{sessionId: string | null}`: the browser's report of which session
 * the host UI currently has open (T62) — the intercept layer runs in this
 * backend process and cannot read the browser's localStorage itself. `null`
 * means a readable signal says nothing is open; the sink stores the value
 * and re-judges the mergers immediately. */
export const CLIENT_CURRENT_SESSION_ROUTE = `${CLIENT_ROUTE_PREFIX}/current-session`

/** POST `{entryId?: string, all?: boolean}` (MS-5): remove one paired server
 * by its entry id, or every paired server at once (`all: true`). The paired
 * list lives in `zen-remote-state.json`; this route goes through the pool so
 * the live clients stop with their records. Pool-mode only — a mount without
 * a pool has no paired list to edit and answers the unknown-path 404. */
export const CLIENT_UNPAIR_ROUTE = `${CLIENT_ROUTE_PREFIX}/unpair`

/** Longest `sessionId` the current-session route accepts (T62): real ids —
 * a local `session-<uuid>` or a `zr~<serverId>~<id>` virtual id — are far
 * shorter; the cap bounds garbage, not reality. */
const MAX_CURRENT_SESSION_ID = 512

/** Prefix of the plain-HTTP relay routes (T41b):
 * `GET ${CLIENT_HTTP_ROUTE_PREFIX}<route>?<query>` relays one intercepted
 * `/api/<route>` call (the fetch wrapper's rewrites land here) to the
 * server, with the virtual session id swapped back to the original. */
export const CLIENT_HTTP_ROUTE_PREFIX = `${CLIENT_ROUTE_PREFIX}/http/`

/** Longest wait for one pairing round-trip to the server's gateway. */
const CLAIM_TIMEOUT_MS = 10_000

/** Longest wait for one connection probe. */
const PROBE_TIMEOUT_MS = 5_000

/** Inbound claim body cap — the settings form sends a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024

/** The fetch face this module needs; injectable for tests. */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

export interface ClientHandlerOptions {
  /** The connection service's admit, injected by apply(); tests fake it. */
  admit: (req: IncomingMessage) => AdminAdmission
  /** The plugin ROW as apply() received it — `serverUrl` / `deviceToken` are
   * volatile, so they must be read through this at request time, never
   * snapshotted at registration. */
  getRowConfig: () => unknown
  /** Outbound fetch, defaulting to the global one. */
  fetchImpl?: FetchLike
  /** Upload-redirect service probe (RD-6): lazily reflects `connection` /
   * `fileUploads` from a context that already resolved, plus whether the
   * fetch-route inject callback ever fired. Answers WHY the upload
   * redirection is absent on compositions where one of the two services
   * never becomes available (cordis keeps such injects silently PENDING). */
  getServiceProbe?: () => Record<string, unknown>
  /** The live relay client (T23a), once apply() built one. When it has LEFT
   * its initial `unpaired` state — a connection attempt ran — the status
   * route reports ITS verdict (state + handshake server name) and skips the
   * ping probe; the probe below stays as the fallback for a client that
   * never connected, so the settings page still gets a fresh answer while
   * the startup `connect()` is still unpaired. */
  getRelayClient?: () => RelayClient | undefined
  /** MS-5 POOL mode: the multi-server relay pool. When present it REPLACES
   * the row-driven single-client facts everywhere: the paired list (not the
   * row's serverUrl/deviceToken) is the truth, claim pairs straight into the
   * pool (the token never reaches the browser), unpair/reconnect address
   * pool entries, and status / remote-status report the whole list (the
   * top level keeps the FIRST entry's fields so the existing page keeps
   * rendering). The single-`getRelayClient` form above stays exactly as it
   * was for the old wiring and the tests. */
  pool?: RelayPool
  /** MS-5: the PB-2 bridge verdict for ONE pool entry, computed PER CALL off
   * that entry's own handshake table and connection state — per-server
   * isolation for the status / remote-status bodies. Undefined (old tests,
   * the unwired host mount): every per-server `pluginBridge` / per-server
   * `bridgedPlugins` list reads `[]`. */
  getPluginBridgeStatusForServer?: (serverId: string | undefined, client: RelayClient) => BridgeStatus[]
  /** The typert interception's diagnostics (T23b-1), read live per request.
   * Shapes, counters and failure codes only — never a token. Undefined when
   * this composition never even attempted an install (no typertGateway). */
  getIntercept?: () => InterceptDiagnostics | undefined
  /** The exact-fetch-route interception's diagnostics (T51), read live per
   * request: the local upload route's remote-forwarding install state and
   * its refusal counters. Undefined when this composition never attempted
   * one (no connection service, or no fileUploads service to inject). */
  getFetchRouteIntercept?: () => FetchRouteInterceptDiagnostics | undefined
  /** The plugin-route interception's diagnostics (PB-4), read live per
   * request: the local webServer `match` wrap that forwards bridged-plugin
   * requests for remote sessions. Undefined when this composition never
   * attempted one (a host role, or no webServer). */
  getPluginRouteIntercept?: () => PluginRouteInterceptDiagnostics | undefined
  /** The plugin bridge's live verdict (PB-2), computed PER CALL off the local
   * registry, the last handshake's `plugins` table and the connection state —
   * never a stored conclusion. Wired only by the CLIENT role's mount; absent
   * (the host mount, old tests) both routes answer the empty shape: status's
   * `pluginBridge: []` and remote-status's `bridgedPlugins: []`. */
  getPluginBridgeStatus?: () => BridgeStatus[]
  /** Serve ONLY the remote-status route (T41a-fix2, the host role's mount):
   * every other route under the prefix answers the same 404 an unknown path
   * would. The claim / status / reconnect / unshare routes exist for a
   * CLIENT — a host carries no relay client and no pairing surface, so
   * answering them (even with their empty conclusions) is exposure without
   * a user. The remote-status route stays: the T34 client parts poll it on
   * whatever role this process runs. */
  remoteStatusOnly?: boolean
  /** T62: the sink for the browser's current-session reports — stores the
   * latest value (memory, last write wins across windows) and makes the
   * intercept re-judge at once. Wired only on the CLIENT mount; the HOST
   * mount's remoteStatusOnly wall 404s the route before this matters, and
   * a client handler WITHOUT the sink answers the same 404 (no sink, no
   * route). */
  onCurrentSession?: (read: CurrentSessionRead, reportedLang?: 'zh' | 'en') => void
  /** Language for route error messages (`'zh'` default, `'en'` English). */
  lang?: 'zh' | 'en' | (() => 'zh' | 'en') | undefined
  /** CU-3, the debug-report route's inputs — all optional; the route answers
   * its 404-shaped refusal without them (an unwired composition must not
   * pretend to have diagnostics). Wired on BOTH role mounts.
   *
   * The log ring's snapshot (CU-1), oldest first. */
  getLogSnapshot?: () => readonly LogRingEntry[]
  /** The gateway child's summary plate (HOST mount only): liveness, port,
   * device and share counts — counts, never tokens. May be async (it probes
   * the gateway's own status). */
  getGatewaySummary?: () => Record<string, unknown> | Promise<Record<string, unknown>>
  /** The profile context's display name, when the composition has one. */
  getProfileName?: () => string | undefined
  /** This package's own version, read at module load in src/index.ts. */
  getPluginVersion?: () => string
  /** PG-2: the live pairing cap (`resolveConfig`'s `maxServers`), read PER
   * REQUEST — the field is volatile and deliberately not a restart field, so
   * a change reaches the next request without any reload. POOL-mode mounts
   * do NOT read this for the cap (PG-2-fix): status and the claim pre-check
   * follow {@link effectiveMaxServers}, i.e. `pool.maxServers()` — the one
   * synthesis that folds the peer mode's network cap in, matching what
   * `pool.pair()` enforces. This getter answers only as the fallback for a
   * mount without a pool, or a pool predating the getter (test stubs).
   * Missing answers the historic constant 8. */
  getMaxServers?: () => number
}

export type ClientHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

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
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ClientRouteError'
    this.status = status
    this.code = code
  }
}

/**
 * Read the whole body under the cap and demand one JSON object. Same contract
 * as the admin routes' reader: an empty body counts as `{}`, a declared
 * oversized body length is refused before a byte is read, and the streaming
 * cap stays as the chunked-body guard.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = req.headers['content-length']
  const expected = declared === undefined ? undefined : Number(declared)
  if (expected !== undefined && Number.isSafeInteger(expected) && expected > MAX_BODY_BYTES) {
    throw new ClientRouteError(400, 'bad-request', `request body exceeds the ${MAX_BODY_BYTES}-byte limit`)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new ClientRouteError(400, 'bad-request', `request body exceeds the ${MAX_BODY_BYTES}-byte limit`)
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ClientRouteError(400, 'bad-request', 'request body must be valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ClientRouteError(400, 'bad-request', 'request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Write one relayed upstream answer (T41b): the underlying `/api` route's
 * status with its body as received, and a content type held to JSON — the
 * two registered routes answer JSON, and a compromised server must not land
 * a scriptable type (`text/html`) on this same-origin browser path (T41b-fix),
 * so anything else downgrades to inert `text/plain`. `nosniff` backs the
 * downgrade up, and the no-store discipline every route here answers with.
 */
function respondUpstream(res: ServerResponse, result: RelayHttpResult): void {
  const bytes = Buffer.from(result.body, 'utf8')
  const mediaType = result.contentType?.split(';', 1)[0]?.trim().toLowerCase()
  const contentType =
    mediaType === 'application/json' && result.contentType !== undefined ? result.contentType : 'text/plain; charset=utf-8'
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.writeHead(result.status)
  res.end(bytes)
}

/**
 * Map one relay failure onto the plain-HTTP answer (T41b): the four
 * link-level codes mean "the server chain is not usable" (503
 * `remote-offline`); a refusal the relay route itself answered keeps ITS
 * status and code (an unshared session is the relay's 403 `not-shared`,
 * verbatim); anything else is a bug and answers a bare 502.
 */
function respondRelayFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof RelayError) {
    if (error.code === 'offline' || error.code === 'unpaired' || error.code === 'revoked' || error.code === 'incompatible') {
      responseJson(res, 503, { ok: false, error: { code: 'remote-offline' } })
      return
    }
    if (error.status !== undefined && error.status >= 400 && error.status <= 599) {
      responseJson(res, error.status, { ok: false, error: { code: error.code } })
      return
    }
  }
  responseJson(res, 502, { ok: false, error: { code: 'internal' } })
}

/** One probe of the server's relay ping with the row's token. Only the
 * Authorization header ever sees the token. */
async function probe(fetchImpl: FetchLike, serverUrl: string, token: string): Promise<ProbeState> {
  let response: Response
  try {
    response = await fetchImpl(serverUrl.replace(/\/+$/u, '') + RELAY_PING_PATH, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      // A wrong server must not walk the probe through a redirect chain.
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch {
    return classifyProbe({ kind: 'error' })
  }
  const text = await response.text().catch(() => undefined)
  let body: unknown
  if (text !== undefined) {
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
  }
  return classifyProbe({ kind: 'response', status: response.status, body })
}

/** Relay one classified claim outcome to the browser. The success envelope
 * additionally echoes the NORMALIZED address — the exact string this route
 * validated, so the browser writes back what the backend approved. */
function respondClaim(res: ServerResponse, outcome: ClaimOutcome, serverUrl: string): void {
  if (outcome.ok) {
    responseJson(res, 200, { ...outcome, serverUrl })
    return
  }
  responseJson(res, 200, outcome)
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
function probeStateOfRelayError(error: unknown): ProbeState | 'unpaired' | 'incompatible' {
  if (error instanceof RelayError) {
    if (error.code === 'revoked') return 'revoked'
    if (error.code === 'offline') return 'unreachable'
    if (error.code === 'unpaired') return 'unpaired'
    if (error.code === 'incompatible') return 'incompatible'
  }
  return 'unexpected'
}

/**
 * The online status body (T59): the handshake facts plus the device's own
 * name — the SERVER's record of this device (T59), which the settings page
 * follows into the row while the user is not mid-edit. Absent from an older
 * relay client (no handshake field) and then the body carries it as '' —
 * the settings page treats empty as "nothing to follow". While a
 * locally-pushed rename is queued or in flight the name is FORCED empty
 * (T59-fix): the answer could predate the push, and a page that followed it
 * would bounce the user's fresh save back to the old name.
 */
function deviceStatusBody(state: string, info: { serverName: string, deviceName?: string }, serverUrl: string, deviceNameSyncing: boolean): Record<string, unknown> {
  return {
    state,
    serverName: info.serverName,
    serverUrl,
    deviceName: !deviceNameSyncing && typeof info.deviceName === 'string' ? info.deviceName : '',
  }
}

/**
 * One live handshake bounded by the probe timeout. An abandoned connect
 * keeps running in the background — its result lands in the relay client's
 * state and digest either way — but the status answer never waits longer
 * than a probe would have.
 */
async function withProbeTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RelayError('offline', `no handshake within ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The relay client's live state in the `remote-status` vocabulary (T34):
 * `connecting` and `incompatible` report as `offline` — both are "the link
 * is not serving, recovery pending" as far as a remote session is concerned.
 * No relay client wired (a host role) is `unpaired`, the honest "no
 * connection configured".
 */
function remoteStatusStateOf(relay: RelayClient | undefined): 'online' | 'offline' | 'revoked' | 'unpaired' {
  if (relay === undefined) return 'unpaired'
  switch (relay.state) {
    case 'online':
      return 'online'
    case 'revoked':
      return 'revoked'
    case 'unpaired':
      return 'unpaired'
    default:
      return 'offline'
  }
}

/**
 * The diagnostics decorator shared by the single-client and pool status
 * bodies (CU-3's extraction, extended by MS-5): every interception getter is
 * read live per call, and the compat verdict rides whenever there is
 * something to report — from `compatRelay`'s last handshake (the single
 * client, or in pool mode the FIRST entry's client) or from the interceptor's
 * incompatible-call ring. `pluginBridgeOverride` replaces the single-client
 * verdict source in pool mode (the first entry's per-server verdicts, keeping
 * the top-level field's shape).
 */
function diagnosticsDecorator(
  options: ClientHandlerOptions,
  compatRelay: RelayClient | undefined,
  pluginBridgeOverride?: BridgeStatus[],
): (body: Record<string, unknown>) => Record<string, unknown> {
  const intercept = options.getIntercept?.()
  const fetchRouteIntercept = options.getFetchRouteIntercept?.()
  const serviceProbe = options.getServiceProbe?.()
  const pluginRouteIntercept = options.getPluginRouteIntercept?.()
  const compat =
    compatRelay?.compat !== undefined || (intercept?.incompatibleCalls.length ?? 0) > 0
      ? {
          identical: compatRelay?.compat?.identical ?? [],
          different: compatRelay?.compat?.different ?? [],
          unavailable: compatRelay?.compat?.unavailable ?? [],
          incompatibleCalls: intercept?.incompatibleCalls ?? [],
        }
      : undefined
  return (body: Record<string, unknown>): Record<string, unknown> => {
    // PB-2: the per-plugin bridge verdict rides EVERY status answer —
    // the settings surface explains a not-bridged plugin whatever the
    // connection state (unpaired reads all-offline, the honest verdict).
    let next: Record<string, unknown> = { ...body, pluginBridge: pluginBridgeOverride ?? options.getPluginBridgeStatus?.() ?? [] }
    if (intercept !== undefined) next = { ...next, intercept }
    if (fetchRouteIntercept !== undefined) next = { ...next, fetchRouteIntercept }
    if (serviceProbe !== undefined) next = { ...next, serviceProbe }
    if (pluginRouteIntercept !== undefined) next = { ...next, pluginRouteIntercept }
    return compat === undefined ? next : { ...next, compat }
  }
}

/**
 * One pool entry's per-server status row (MS-5): the live client facts and
 * the entry's own identity — NEVER the token, which the route never even
 * sees (it lives in the state file, behind the pool). `compat` appears only
 * once that client has a handshake verdict to report; `pluginBridge` comes
 * from the per-server verdict getter ([] unwired).
 */
function poolServerStatus(entry: RelayPoolEntryView, options: ClientHandlerOptions): Record<string, unknown> {
  const client = entry.client
  const body: Record<string, unknown> = {
    entryId: entry.entryId,
    serverId: entry.serverId,
    serverUrl: entry.serverUrl,
    serverName: entry.serverName ?? '',
    displayName: entry.displayName,
    state: client.state,
    nextRetryAt: client.nextRetryAt ?? null,
    ...(client.lastError !== undefined ? { lastError: client.lastError } : {}),
    ...(client.compat !== undefined
      ? { compat: { identical: client.compat.identical, different: client.compat.different, unavailable: client.compat.unavailable } }
      : {}),
    pluginBridge: options.getPluginBridgeStatusForServer?.(entry.serverId, client) ?? [],
  }
  return body
}

/**
 * The EFFECTIVE pairing cap for a pool-mode mount (PG-2-fix): the pool's own
 * `maxServers()` is the one synthesis point that folds the peer mode's
 * network-reported `maxPeersFromGateway` into the configured value, and
 * `pool.pair()` enforces exactly that number — so the status body and the
 * claim pre-check must read the SAME source, not the raw config value (two
 * truths would let the pre-check admit what pair refuses, or the reverse).
 * The live config getter (then the historic constant) answers only when
 * there is no pool, or the pool predates the getter (test stubs).
 */
function effectiveMaxServers(pool: RelayPool | undefined, options: ClientHandlerOptions): number {
  if (pool !== undefined && typeof pool.maxServers === 'function') return pool.maxServers()
  return options.getMaxServers?.() ?? MAX_PAIRED_SERVERS
}

/**
 * The POOL status body (MS-5): the paired list is the truth — the row's
 * serverUrl/deviceToken are never consulted. The top level keeps the FIRST
 * entry's compatibility fields (the old single-server page keeps rendering)
 * and every entry reports as one `servers` row; `maxServers` names the
 * EFFECTIVE cap — the pool's own synthesis (PG-2-fix), the same number
 * `pool.pair()` enforces. An empty pool answers `unpaired` — the honest
 * "nothing paired".
 */
async function poolStatusBodyOf(options: ClientHandlerOptions): Promise<Record<string, unknown>> {
  const pool = options.pool as RelayPool
  const entries = pool.entries()
  const first = entries[0]
  const bridgeOverride = first !== undefined
    ? options.getPluginBridgeStatusForServer?.(first.serverId, first.client) ?? []
    : []
  const withDiagnostics = diagnosticsDecorator(options, first?.client, bridgeOverride)
  const servers = entries.map((entry) => poolServerStatus(entry, options))
  const maxServers = effectiveMaxServers(pool, options)
  if (first === undefined) {
    return withDiagnostics({ state: 'unpaired', maxServers, servers })
  }
  const body = deviceStatusBody(
    first.client.state,
    { serverName: first.serverName ?? '', deviceName: first.client.handshakeInfo?.deviceName },
    first.serverUrl,
    first.client.deviceNameSyncing,
  )
  if (first.client.nextRetryAt !== null && first.client.nextRetryAt !== undefined) body.nextRetryAt = first.client.nextRetryAt
  if (first.client.lastError !== undefined) body.lastError = first.client.lastError
  return withDiagnostics({ ...body, maxServers, servers })
}

/**
 * The status route's body, computed exactly as the CLIENT_STATUS_ROUTE
 * branch always has — extracted (CU-3) so the debug-report route can embed
 * the same diagnostics aggregation without a second implementation. All
 * reads are live per call: volatile row fields, the interception getters,
 * the relay client's current state. May await one bounded probe or connect
 * (never longer than the probe timeout). In pool mode the paired list is
 * the truth instead ({@link poolStatusBodyOf}); the row is not consulted.
 */
async function statusBodyOf(options: ClientHandlerOptions): Promise<Record<string, unknown>> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))
  if (options.pool !== undefined) return poolStatusBodyOf(options)
  // The typert interception's view (T23b-1) rides on EVERY status
  // answer, whatever the connection state — the settings surface needs
  // it to explain a refused install even while unpaired. The interface
  // compat verdict (T42) appears once there is something to report: a
  // stored comparison from the relay client's last handshake, or any
  // incompatible call the interceptor recorded. Absent otherwise —
  // nothing to show, and the settings block presence-gates on exactly
  // that.
  const compatRelay = options.getRelayClient?.()
  const withDiagnostics = diagnosticsDecorator(options, compatRelay)
  // The ROW decides its own two shapes first, per request (both fields
  // are volatile { get() } wrappers — only the row object apply()
  // received is a live source): without both credentials nothing is
  // paired, and a stored address that no longer normalizes must never
  // see the token (T16-fix).
  const row = options.getRowConfig()
  const record = row !== null && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : {}
  const serverUrl = stringOrEmpty(unwrapVolatile(record.serverUrl)).trim()
  const token = stringOrEmpty(unwrapVolatile(record.deviceToken))
  if (token === '' || serverUrl === '') {
    return withDiagnostics({ state: 'unpaired' })
  }
  const normalized = normalizeServerUrl(serverUrl)
  if (!normalized.ok) {
    return withDiagnostics({ state: 'invalid-url' })
  }
  const relay = options.getRelayClient?.()
  if (relay === undefined) {
    // T16 shape: no relay client wired — the ping probe is the answer.
    const state = await probe(fetchImpl, normalized.url, token)
    return withDiagnostics({ state, serverUrl: normalized.url })
  }
  // The cached verdict is trusted only over the EXACT credentials the
  // handshake earned it with: an online state whose digest no longer
  // matches the row (address edited, re-pair) is an answer about a
  // DIFFERENT server and falls through to a live connect instead
  // (T23a-fix). The token never enters this body — the digest is a
  // one-way sha256 prefix computed on both sides.
  if (
    relay.state === 'online' &&
    relay.handshakeInfo !== undefined &&
    relay.lastHandshakeDigest !== undefined &&
    relay.lastHandshakeDigest === relayCredentialsDigest(normalized.url, token)
  ) {
    return withDiagnostics(deviceStatusBody(relay.state, relay.handshakeInfo, normalized.url, relay.deviceNameSyncing))
  }
  // Everything else — never connected, offline, connecting, revoked,
  // stale credentials — gets ONE live connect bounded by the probe
  // timeout; its FRESH result is the answer, never the possibly stale
  // cached state. A failed attempt additionally carries the relay
  // client's reconnect machinery readout (T43): when the next
  // automatic retry fires and which code failed last — both free of
  // credential material by contract.
  try {
    const info = await withProbeTimeout(relay.connect())
    return withDiagnostics(deviceStatusBody('online', info, normalized.url, relay.deviceNameSyncing))
  } catch (error) {
    const body: Record<string, unknown> = { state: probeStateOfRelayError(error), serverUrl: normalized.url }
    if (relay.nextRetryAt !== null && relay.nextRetryAt !== undefined) body.nextRetryAt = relay.nextRetryAt
    if (relay.lastError !== undefined) body.lastError = relay.lastError
    return withDiagnostics(body)
  }
}

/**
 * Build the client route handler for one plugin row. The returned handler
 * owns the full response lifecycle of every request under
 * {@link CLIENT_ROUTE_PREFIX} and never throws.
 */
export function createClientHandler(options: ClientHandlerOptions): ClientHandler {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const resolveLang = (): 'zh' | 'en' => {
    const value = typeof options.lang === 'function' ? options.lang() : options.lang
    return value === 'en' ? 'en' : 'zh'
  }
  const mismatchMessage = (): string =>
    resolveLang() === 'en' ? 'This remote session belongs to another server' : '此远程会话属于其他主服务端'
  return async (req, res) => {
    // Wall 1: DSH's own admission, relaying its refusal verbatim.
    const admission = options.admit(req)
    if ('rejection' in admission) {
      responseJson(res, admission.rejection, {
        ok: false,
        error: { code: admission.rejection === 401 ? 'unauthorized' : 'forbidden' },
      })
      return
    }
    const route = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const method = req.method ?? 'GET'
    try {
      // CU-3: the debug-report route's via wall, BEFORE any dispatch (the
      // wizard's rule): a request wearing the gateway's marker arrived from
      // a remote device, and a forwarded request presents as same-origin
      // (the gateway rewrites Origin/Host) — the marker is the only honest
      // signal. The report is a machine-local export; the gateway must
      // never be able to fetch this machine's diagnostics either.
      if (route === CLIENT_DEBUG_REPORT_ROUTE && req.headers['x-zen-remote-via'] !== undefined) {
        responseJson(res, 403, {
          ok: false,
          error: {
            code: 'via-gateway',
            message: resolveLang() === 'en' ? 'Diagnostics report can only be exported on this machine' : '诊断报告只能在本机导出',
          },
        })
        return
      }
      // The host mount's least-exposure wall (T41a-fix2): remote-status and
      // the debug report (CU-3, both roles answer their own) exist here,
      // and both sit BEHIND the admission wall like every other route. The
      // shape of the refusal matches the unknown-path fallthrough.
      if (options.remoteStatusOnly === true && route !== CLIENT_REMOTE_STATUS_ROUTE && route !== CLIENT_DEBUG_REPORT_ROUTE) {
        responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown client route' } })
        return
      }
      if (route === CLIENT_CLAIM_ROUTE) {
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST')
          responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } })
          return
        }
        if (!sameOriginPost(req)) {
          responseJson(res, 403, {
            ok: false,
            error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
          })
          return
        }
        const body = await readJsonBody(req)
        const normalized = normalizeServerUrl(stringOrEmpty(body.serverUrl))
        if (!normalized.ok) {
          responseJson(res, 400, { ok: false, code: normalized.reason })
          return
        }
        // MS-5 pool mode: the pairing cap is judged BEFORE the round-trip —
        // a refusal the user can fix locally (remove a server, or re-enter
        // an already-paired address) must not spend a claim code on the
        // wire. The cap is the POOL's effective cap ({@link
        // effectiveMaxServers}, PG-2-fix): the same `pool.maxServers()`
        // synthesis — gateway cap folded in — that `pool.pair()` enforces,
        // so the pre-check can never disagree with the actual pairing. An
        // address that is ALREADY paired is always allowed through:
        // re-pairing it just refreshes the token in place, at the cap too.
        // The pool stays the single writer afterwards: the gateway's
        // token goes straight into `zen-remote-state.json` and NEVER reaches
        // the browser — this response carries only the entry id and the
        // address echo.
        const pool = options.pool
        if (pool !== undefined) {
          const known = pool.entries().some((entry) => entry.serverUrl === normalized.url)
          if (!known && pool.entries().length >= effectiveMaxServers(pool, options)) {
            responseJson(res, 409, { ok: false, code: 'limit-reached' })
            return
          }
        }
        const payload = JSON.stringify({
          code: stringOrEmpty(body.code),
          name: stringOrEmpty(body.name),
        })
        let status: number
        let gatewayBody: unknown
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
          })
          status = response.status
          const text = await response.text()
          try {
            gatewayBody = JSON.parse(text)
          } catch {
            gatewayBody = undefined
          }
        } catch {
          responseJson(res, 502, { ok: false, code: 'unreachable' })
          return
        }
        const outcome = classifyClaimResponse(status, gatewayBody)
        if (pool === undefined || !outcome.ok) {
          respondClaim(res, outcome, normalized.url)
          return
        }
        // Pool mode, redemption succeeded: land the pairing in the state
        // file through the pool (which also starts/refreshes the live
        // client) and answer without the token. The pair() can only refuse
        // past the pre-check on a concurrent writer — the same envelopes.
        const paired = await pool.pair({
          serverUrl: normalized.url,
          token: outcome.token,
          deviceId: outcome.deviceId,
          deviceName: outcome.deviceName,
        })
        if (!paired.ok) {
          responseJson(res, paired.code === 'limit-reached' ? 409 : 400, { ok: false, code: paired.code })
          return
        }
        responseJson(res, 200, {
          ok: true,
          entryId: paired.entry.entryId,
          deviceId: outcome.deviceId,
          deviceName: outcome.deviceName,
          serverUrl: normalized.url,
        })
        return
      }
      if (route === CLIENT_UNPAIR_ROUTE) {
        // MS-5: remove one paired server or all of them. Pool-mode only —
        // a mount without a pool has no paired list to edit (the old
        // single-server pairing lived in the ROW, which the browser writes
        // directly), and answers the same 404 an unknown path would.
        const pool = options.pool
        if (pool === undefined) {
          responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown client route' } })
          return
        }
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST')
          responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } })
          return
        }
        if (!sameOriginPost(req)) {
          responseJson(res, 403, {
            ok: false,
            error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
          })
          return
        }
        const body = await readJsonBody(req)
        if (body.all === true) {
          const removed = pool.unpairAll()
          responseJson(res, 200, { ok: true, removed })
          return
        }
        if (typeof body.entryId === 'string' && body.entryId !== '') {
          const removed = pool.unpair(body.entryId)
          responseJson(res, 200, { ok: true, removed: removed ? 1 : 0 })
          return
        }
        responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'entryId (non-empty string) or all (true) is required' } })
        return
      }
      if (route === CLIENT_STATUS_ROUTE) {
        if (method !== 'GET') {
          res.setHeader('Allow', 'GET')
          responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } })
          return
        }
        responseJson(res, 200, await statusBodyOf(options))
        return
      }
      if (route === CLIENT_DEBUG_REPORT_ROUTE) {
        // Unwired composition (no log ring handed over): the same shape an
        // unknown path gets — an old host must not pretend to have a report.
        const logs = options.getLogSnapshot?.()
        if (logs === undefined) {
          responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown client route' } })
          return
        }
        if (method !== 'GET') {
          res.setHeader('Allow', 'GET')
          responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } })
          return
        }
        // The picked config summary (CU-2's construction layer): field by
        // NAME, never a spread — deviceToken and the other secret row fields
        // are structurally absent; the assembler's deep redactor is the
        // second layer behind this. serverUrl travels to the assembler raw
        // and comes out as a shape (scheme + address class + port).
        const row = options.getRowConfig()
        const record = row !== null && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : {}
        const values = resolveConfig(record, readFileConfig(), process.env).values
        const rawMaxUpload: unknown = unwrapVolatile(record.maxUploadBytes)
        const maxUploadBytes = typeof rawMaxUpload === 'number' && Number.isFinite(rawMaxUpload) && rawMaxUpload > 0
          ? rawMaxUpload
          : undefined
        const rawProfile = options.getProfileName?.()
        const report = assembleDebugReport({
          meta: {
            generatedAt: new Date().toISOString(),
            pluginVersion: options.getPluginVersion?.() ?? 'unknown',
            dshVersion: resolveDshVersion(),
            platform: `${process.platform} ${process.arch}`,
            role: String(values.role),
            ...(rawProfile === undefined ? {} : { profileName: rawProfile }),
          },
          configSummary: {
            role: values.role,
            host: values.host,
            port: values.port,
            idleHours: values.idleHours,
            maxServers: values.maxServers,
            maxUploadBytes,
            autoShareNewSessions: values.autoShareNewSessions,
            pluginBridgeConsent: values.pluginBridgeConsent,
            pushSummary: values.pushSummary,
            pushTurnEnd: values.pushTurnEnd,
            pushTool: values.pushTool,
            pushEnabled: values.pushEnabled,
            pushSessionName: values.pushSessionName,
            serverUrl: stringOrEmpty(unwrapVolatile(record.serverUrl)).trim(),
          },
          statusBody: await statusBodyOf(options),
          ...(options.getGatewaySummary === undefined ? {} : { gatewaySummary: await options.getGatewaySummary() }),
          logs,
          home: homedir(),
        })
        responseJson(res, 200, report)
        return
      }
      if (route === CLIENT_RECONNECT_ROUTE) {
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST')
          responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } })
          return
        }
        if (!sameOriginPost(req)) {
          responseJson(res, 403, {
            ok: false,
            error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
          })
          return
        }
        const relay = options.getRelayClient?.()
        // MS-5 pool mode: an optional { entryId } names ONE server — the
        // same offline-only, 409-on-conflict contract the single client's
        // button has, per entry; without it every OFFLINE server gets one
        // attempt (an online server is not "reconnected", it is fine).
        const pool = options.pool
        if (pool !== undefined) {
          const body = await readJsonBody(req)
          const entryId = typeof body.entryId === 'string' && body.entryId !== '' ? body.entryId : undefined
          if (entryId === undefined) {
            const started = await pool.reconnect()
            responseJson(res, 200, { ok: true, started })
            return
          }
          const entry = pool.getByEntryId(entryId)
          if (entry === undefined) {
            responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'No such paired server' } })
            return
          }
          if (entry.client.state !== 'offline' || !entry.client.reconnect()) {
            responseJson(res, 409, { ok: false, error: { code: 'not-offline', message: 'The client is not offline' } })
            return
          }
          responseJson(res, 200, { ok: true })
          return
        }
        // No relay client (a composition that never built one): there is
        // nothing to reconnect, and the probe-shaped status route is the
        // only connection surface this deployment has.
        if (relay === undefined) {
          responseJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'No relay client is running' } })
          return
        }
        // The button is only clickable while offline; anything else is a
        // conflict with the state the page just rendered.
        if (relay.state !== 'offline' || !relay.reconnect()) {
          responseJson(res, 409, { ok: false, error: { code: 'not-offline', message: 'The client is not offline' } })
          return
        }
        // Fired, not awaited: the attempt runs on the relay client (bounded
        // by its own request timeout), the state lands there either way, and
        // the page's status refresh reports the outcome.
        responseJson(res, 200, { ok: true })
        return
      }
      if (route === CLIENT_NETWORK_HINT_ROUTE) {
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST')
          responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } })
          return
        }
        if (!sameOriginPost(req)) {
          responseJson(res, 403, {
            ok: false,
            error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
          })
          return
        }
        const relay = options.getRelayClient?.()
        // MS-5 pool mode: the same QUESTION per server — one authenticated
        // ping sweep over the offline clients, the reachable ones get the
        // controlled `networkRestored()` (probe-first, no storm, offline
        // only — the pool method enforces the same rules per client).
        const pool = options.pool
        if (pool !== undefined) {
          const outcome = await pool.probeAndRestoreAll()
          responseJson(res, 200, { ok: true, reachable: outcome.reachable, reconnected: outcome.reconnected })
          return
        }
        if (relay === undefined) {
          responseJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'No relay client is running' } })
          return
        }
        // a hint is a QUESTION, not a verdict.
        // `probeHealth` is one authenticated GET /ping: it proves the HOST is
        // reachable with the current token — nothing about the long streams.
        // Only a reachable host earns the controlled reconnect, and
        // `networkRestored()` is what enforces "offline only" + the 3s gap.
        const reachable = await relay.probeHealth()
        if (!reachable) {
          // Honest answer: the network may be back, the HOST is not.
          responseJson(res, 200, { ok: true, reachable: false, reconnected: false })
          return
        }
        const reconnected = relay.networkRestored()
        responseJson(res, 200, { ok: true, reachable: true, reconnected })
        return
      }
      if (route === CLIENT_REMOTE_STATUS_ROUTE) {
        if (method !== 'GET') {
          res.setHeader('Allow', 'GET')
          responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } })
          return
        }
        // T34: the T34 client parts' data source — no token, no server
        // address, nothing but the serving state, the compat verdict's
        // difference flag, the display name and the closed-session map.
        // PB-2 adds `bridgedPlugins`: the names whose bridge verdict is
        // bridged RIGHT NOW, sorted (the list arrives plugin-sorted, but the
        // sort is pinned here so the field's shape never depends on the
        // registry's internal order). The host mount — no verdict source —
        // answers [].
        // MS-5 pool mode: the SAME shape per server, under `servers` keyed
        // by the handshake serverId (an entry that never handshook owns no
        // virtual ids and is not addressable — skipped). The top level
        // mirrors the FIRST entry so the old page keeps rendering.
        const pool = options.pool
        const intercept = options.getIntercept?.()
        const bridgedOf = (serverId: string | undefined, client: RelayClient): string[] =>
          (options.getPluginBridgeStatusForServer?.(serverId, client) ?? [])
            .filter((status) => status.bridged)
            .map((status) => status.plugin)
            .sort()
        if (pool !== undefined) {
          const entries = pool.entries()
          const first = entries[0]
          const servers: Record<string, Record<string, unknown>> = {}
          for (const entry of entries) {
            if (entry.serverId === undefined) continue
            servers[entry.serverId] = {
              state: remoteStatusStateOf(entry.client),
              versionMismatch: (entry.client.compat?.different?.length ?? 0) > 0,
              serverName: entry.serverName ?? '',
              bridgedPlugins: bridgedOf(entry.serverId, entry.client),
            }
          }
          responseJson(res, 200, {
            state: remoteStatusStateOf(first?.client),
            versionMismatch: (first?.client.compat?.different?.length ?? 0) > 0,
            serverName: first?.serverName ?? '',
            closed: Object.fromEntries((intercept?.closedSessions ?? []).map((record) => [record.sessionId, record.reason])),
            bridgedPlugins: first !== undefined ? bridgedOf(first.serverId, first.client) : [],
            servers,
          })
          return
        }
        const relay = options.getRelayClient?.()
        responseJson(res, 200, {
          state: remoteStatusStateOf(relay),
          versionMismatch: (relay?.compat?.different?.length ?? 0) > 0,
          serverName: relay?.handshakeInfo?.serverName ?? '',
          closed: Object.fromEntries((intercept?.closedSessions ?? []).map((record) => [record.sessionId, record.reason])),
          bridgedPlugins: (options.getPluginBridgeStatus?.() ?? [])
            .filter((status) => status.bridged)
            .map((status) => status.plugin)
            .sort(),
        })
        return
      }
      if (route === CLIENT_CURRENT_SESSION_ROUTE) {
        // No sink wired: a client mount without the intercept half — same
        // answer an unknown path gets (the host mount never reaches here,
        // its remoteStatusOnly wall 404s first).
        const sink = options.onCurrentSession
        if (sink === undefined) {
          responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown client route' } })
          return
        }
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST')
          responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } })
          return
        }
        if (!sameOriginPost(req)) {
          responseJson(res, 403, {
            ok: false,
            error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
          })
          return
        }
        const body = await readJsonBody(req)
        // Exactly `sessionId`: a non-empty string (length-capped) or null —
        // null is a REAL "nothing is open" answer; anything else (absent,
        // wrong type, blank, over-long) is a malformed report, refused.
        const raw = body.sessionId
        if (raw !== null && (typeof raw !== 'string' || raw === '' || raw.length > MAX_CURRENT_SESSION_ID)) {
          responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId must be a non-empty string of at most 512 characters, or null' } })
          return
        }
        const read: CurrentSessionRead = raw === null ? { kind: 'none' } : { kind: 'open', sessionId: raw }
        const reportedLang = body.lang === 'en' ? ('en' as const) : body.lang === 'zh' ? ('zh' as const) : undefined
        sink(read, reportedLang)
        responseJson(res, 200, { ok: true })
        return
      }
      if (route === CLIENT_UNSHARE_ROUTE) {
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST')
          responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } })
          return
        }
        if (!sameOriginPost(req)) {
          responseJson(res, 403, {
            ok: false,
            error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
          })
          return
        }
        const body = await readJsonBody(req)
        // Only a VIRTUAL id is a remote session of this deployment — a local
        // id here is a caller bug, refused before anything travels.
        const parts = fromVirtual(body.sessionId)
        if (parts === undefined) {
          responseJson(res, 400, { ok: false, error: { code: 'not-virtual', message: 'sessionId must be a remote (virtual) session id' } })
          return
        }
        // MS-5 pool mode: the id's serverId half names the server — its own
        // client closes the session with the ORIGINAL id. A server the pool
        // does not hold is the same remote-mismatch the interceptor answers.
        const pool = options.pool
        if (pool !== undefined) {
          const entry = pool.getByServerId(parts.serverId)
          if (entry === undefined) {
            responseJson(res, 200, { ok: false, error: { code: 'remote-mismatch', message: mismatchMessage() } })
            return
          }
          try {
            await entry.client.unshare(parts.id)
            responseJson(res, 200, { ok: true })
          } catch (error) {
            const code = error instanceof RelayError ? error.code : 'internal'
            responseJson(res, 200, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } })
          }
          return
        }
        const relay = options.getRelayClient?.()
        if (relay === undefined) {
          responseJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'No relay client is running' } })
          return
        }
        // A session of a DIFFERENT server than the current handshake would
        // just answer not-shared out there — the mismatch is answerable
        // locally, with the code the interceptor uses for the same fact.
        if (relay.handshakeInfo === undefined || relay.handshakeInfo.serverId !== parts.serverId) {
          responseJson(res, 200, { ok: false, error: { code: 'remote-mismatch', message: mismatchMessage() } })
          return
        }
        try {
          await relay.unshare(parts.id)
          responseJson(res, 200, { ok: true })
        } catch (error) {
          // The relay's refusal travels with its code — the icon's alert
          // keys the short copy on it.
          const code = error instanceof RelayError ? error.code : 'internal'
          responseJson(res, 200, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } })
        }
        return
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
          res.setHeader('Allow', 'GET')
          responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } })
          return
        }
        const httpRoute = route.slice(CLIENT_HTTP_ROUTE_PREFIX.length)
        // Registry lookup by hasOwnProperty, never a bare index: `route` is
        // a wire string, and `constructor` must not resolve through the
        // object prototype.
        if (httpRoute === '' || !Object.prototype.hasOwnProperty.call(RELAY_HTTP_ROUTES, httpRoute)) {
          responseJson(res, 404, { ok: false, error: { code: 'unknown-route' } })
          return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionIds = url.searchParams.getAll('sessionId')
        const virtualId = sessionIds.length === 1 ? sessionIds[0] : undefined
        if (virtualId === undefined || virtualId === '') {
          responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId is required exactly once' } })
          return
        }
        const parts = fromVirtual(virtualId)
        if (parts === undefined) {
          responseJson(res, 400, { ok: false, error: { code: 'not-virtual', message: 'sessionId is not a remote session id' } })
          return
        }
        // MS-5 pool mode: route by the id's serverId half. A server the pool
        // does not hold refuses like a foreign one; its client must be the
        // ONLINE one before the query travels with the original id restored.
        const pool = options.pool
        if (pool !== undefined) {
          const entry = pool.getByServerId(parts.serverId)
          if (entry === undefined) {
            responseJson(res, 400, { ok: false, error: { code: 'remote-mismatch', message: mismatchMessage() } })
            return
          }
          if (entry.client.state !== 'online') {
            responseJson(res, 503, { ok: false, error: { code: 'remote-offline' } })
            return
          }
          url.searchParams.set('sessionId', parts.id)
          // A browser walk-off cancels the round-trip mid-flight; the write
          // guard in the catch keeps a settled answer from racing the close.
          const hangUp = new AbortController()
          res.once('close', () => {
            if (!res.writableEnded) hangUp.abort()
          })
          try {
            const result = await entry.client.http(httpRoute, url.searchParams.toString(), hangUp.signal)
            respondUpstream(res, result)
          } catch (error) {
            if (!res.writableEnded && !res.destroyed) respondRelayFailure(res, error)
          }
          return
        }
        const relay = options.getRelayClient?.()
        if (relay === undefined || relay.state !== 'online') {
          responseJson(res, 503, { ok: false, error: { code: 'remote-offline' } })
          return
        }
        if (relay.handshakeInfo?.serverId !== parts.serverId) {
          responseJson(res, 400, { ok: false, error: { code: 'remote-mismatch', message: mismatchMessage() } })
          return
        }
        url.searchParams.set('sessionId', parts.id)
        // A browser walk-off cancels the round-trip mid-flight; the write
        // guard in the catch keeps a settled answer from racing the close.
        const hangUp = new AbortController()
        res.once('close', () => {
          if (!res.writableEnded) hangUp.abort()
        })
        try {
          const result = await relay.http(httpRoute, url.searchParams.toString(), hangUp.signal)
          respondUpstream(res, result)
        } catch (error) {
          if (!res.writableEnded && !res.destroyed) respondRelayFailure(res, error)
        }
        return
      }
      responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown client route' } })
    } catch (error) {
      // Only the route's OWN refusals carry a message; anything else is a bug
      // and answers a bare 500 — internal error text (absolute paths, stack
      // fragments) never reaches the browser (T16-fix).
      if (error instanceof ClientRouteError) {
        responseJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
        return
      }
      responseJson(res, 500, { ok: false, error: { code: 'internal' } })
    }
  }
}
