/**
 * Server-side relay routes for the desktop client (T22a routes, T22b
 * streaming): authentication, ping, handshake, the single invoke passthrough,
 * and the NDJSON stream subscription route with share-change synchronization.
 * Event forwarding (`$events`) and activity stats are later tasks.
 *
 * Why the secret: the desktop client is a Node process on another machine —
 * it has no DSH login cookie, so the gateway authenticates it with a Bearer
 * pairing token and marks the forwarded request with `x-zen-remote-*` headers.
 * But DSH only listens on 127.0.0.1, where any local process could bypass the
 * gateway and forge those headers. The plugin therefore mints a per-apply
 * secret, hands it to the gateway child through `LAN_GATE_RELAY_SECRET`, the
 * gateway stamps every device-authenticated forward with it, and these routes
 * re-verify it on every request with `timingSafeEqual`.
 *
 * Path dispatch never decodes the request path. The gateway only admits relay
 * paths whose raw and URL-normalized forms are byte-identical, which lets
 * `/_dsh/zen-remote/relay/..%2f..%2fapi` through — decoding it here before
 * matching would reopen the traversal the gateway just closed. Every route is
 * an exact comparison on `new URL(req.url).pathname` as-is; anything else is
 * a 404.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ShareStore } from './share-store.js'
import { decideInvoke, decideStream } from './relay-access.js'
import {
  createWorkspaceFollowState,
  filterControlFrame,
  filterJobListFrame,
  filterSessionListResult,
  filterWorkspaceFrame,
} from './relay-filter.js'

/**
 * Registration prefix on the host webServer. Deliberately WITHOUT the
 * trailing slash: the webserver matches a prefix route as `pathname === p ||
 * pathname.startsWith(p + '/')`, so a trailing slash here would match only
 * `…/relay//…` shapes and never `…/relay/ping`.
 */
export const RELAY_PREFIX = '/_dsh/zen-remote/relay'

/** The one protocol version this file speaks; the handshake reports it. */
const RELAY_PROTOCOL = 1

/** Request body ceiling for the POST routes. */
const MAX_BODY_BYTES = 1024 * 1024

/** Error messages forwarded to the client are clipped to this many chars. */
const MAX_MESSAGE_CHARS = 500

/**
 * DSH's own error vocabulary is `namespace/name` (`gateway/cancelled`,
 * `session/unknown-session`, …). Only codes of that exact SHAPE travel to the
 * client with their message — Node's system errors also carry a string
 * `code` (`ENOENT`), and their messages quote server-side absolute paths, so
 * anything not shaped like a DSH code reports `internal` with no message.
 */
const DSH_ERROR_CODE = /^[a-z][a-zA-Z-]*\/[a-zA-Z-]+$/

/** Concurrent streams one device may hold open (per `x-zen-remote-device`). */
const MAX_STREAMS_PER_DEVICE = 32

/** Stream heartbeat when the caller does not inject one. */
const DEFAULT_HEARTBEAT_MS = 15_000

/** How long a stream's finish may wait for a backed-up socket buffer to
 * drain before the response is destroyed (T43-A). */
const DEFAULT_END_DRAIN_TIMEOUT_MS = 5_000

/** `{"type":"ping"}` as one ready-made NDJSON line. */
const PING_LINE = Buffer.from('{"type":"ping"}\n', 'utf8')

/** Most recent jobs remembered per session for ownership checks (4b): the
 * latest `job/list` frame replaces the whole set, so this only bounds a
 * pathological single frame. */
const JOB_CACHE_LIMIT = 1024

/** Shape of the `typertGateway` service this route needs (measured live,
 * docs/spike-relay.md §2.1: invoke returns the unwrapped business value and
 * throws errors carrying a string `code`; stream opens one `mode: 'stream'`
 * method and resolves to an async iterable of its frames). Declared
 * structurally instead of augmenting `Context`: the providing package is not
 * a devDependency here, and a local augmentation could collide with its own
 * once that changes. */
export interface RelayGateway {
  invoke(call: { namespace: string; method: string; args: unknown; signal?: AbortSignal }): Promise<unknown>
  stream(call: {
    namespace: string
    method: string
    args: unknown
    signal?: AbortSignal
  }): Promise<AsyncIterable<unknown>>
}

/** What the handshake reports about this server. `serverName` is a CALLBACK
 * on purpose: the row value is a volatile (`{ get() }` wrapped) setting that
 * can change without restarting the plugin row, so it must be recomputed at
 * handshake time, not snapshotted at registration. */
export interface RelayServerInfo {
  serverId: string
  serverName: () => string
  dshVersion: string
}

export interface RelayHandlerOptions {
  /** The per-apply shared secret; an empty one refuses every request. */
  secret: string
  /** The shared-session table deciding reachability. */
  store: ShareStore
  /** The host gateway service invokes and streams go through. */
  gateway: RelayGateway
  /** Handshake facts. */
  serverInfo: RelayServerInfo
  /** Ancestor lookup for subagent reachability; defaults to "no parent". */
  parentOf?: (id: string) => string | undefined
  /** Stream heartbeat interval in ms (a `{"type":"ping"}` line that keeps
   * reverse proxies from timing the idle stream away); defaults to 15000.
   * Tests inject a small value. */
  heartbeatMs?: number
  /** How long a stream's finish may wait for a backed-up write buffer to
   * drain before the response is destroyed (T43-A: a client that stopped
   * reading must not pin the viewer count and the device budget forever);
   * defaults to 5000. Tests inject a small value. */
  endDrainTimeoutMs?: number
}

/**
 * The relay route handler plus its introspection surface. A function WITH
 * properties on purpose: the webServer registration wants exactly a request
 * handler, and the "who is looking" badge (a later UI task) wants the
 * per-session viewer counts — while the row-reload path (T22b-fix) needs to
 * tear every open stream down with the handler that owns it.
 */
export interface RelayHandler {
  (req: IncomingMessage, res: ServerResponse): Promise<void>
  /** How many session-scoped relay streams currently reference the session
   * (across all devices). */
  viewerCount(sessionId: string): number
  /** End every currently open stream: each client gets one
   * `error{code:'server-restart'}` line, then the response ends (a client
   * that stopped reading is destroyed after {@link RelayHandlerOptions.endDrainTimeoutMs}),
   * the upstream subscription aborts and every counter/listener cleans up —
   * including the handler's own share-table subscriptions, so a table change
   * after the close never reaches this handler again (T43-B). A plugin row
   * reload builds a new handler and share table; without this the streams of
   * the OLD handler would keep pushing, unreachable by any unshare. */
  closeAll(reason: string): void
}

/** One 8-hex-character short server id: four random bytes, enough to tell a
 * handful of servers apart in a client's server list without leaking anything
 * countable about the deployment. */
const SERVER_ID_PATTERN = /^[0-9a-f]{8}$/

const SERVER_ID_FILE = 'zen-remote-server.json'

/**
 * Read the persisted server id, creating (and persisting) one on first use.
 * A missing file is the normal first run; an unreadable or damaged file must
 * never take the host down, so every failure degrades to a fresh per-process
 * id that simply is not remembered across restarts.
 */
export function loadServerId(home: string): string {
  const file = join(home, SERVER_ID_FILE)
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const id = (parsed as { serverId?: unknown } | null)?.serverId
    if (typeof id === 'string' && SERVER_ID_PATTERN.test(id)) return id
  } catch {
    // First run, unreadable path, or unparsable JSON — mint a new one below.
  }
  const id = randomBytes(4).toString('hex')
  try {
    // tmp + rename, the same atomic dance the share table uses: a crash
    // mid-write must not leave a half-file that would corrupt the next read.
    mkdirSync(home, { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify({ serverId: id }))
    renameSync(`${file}.tmp`, file)
  } catch {
    // Unwritable home: the id stays process-local. Nothing may throw here.
  }
  return id
}

/**
 * The DSH version reported in the handshake: `DSH_CLIENT_VERSION` when the
 * host sets it, else the version of the `@deepseek-ai/dsh` package resolved
 * from here (compositions without that package installed — tests, Electron —
 * report `'unknown'`). Never throws.
 */
export function resolveDshVersion(): string {
  const fromEnv = process.env.DSH_CLIENT_VERSION
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('@deepseek-ai/dsh/package.json') as { version?: unknown }
    if (pkg !== null && typeof pkg === 'object' && typeof pkg.version === 'string') return pkg.version
  } catch {
    // Not resolvable in this composition — 'unknown' is an honest answer.
  }
  return 'unknown'
}

function responseJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  res.writeHead(status)
  res.end(bytes)
}

/** First (and in practice only) value of one request header. */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Constant-time secret comparison. Different lengths are trivially unequal
 * (timingSafeEqual itself throws on that); an empty configured secret refuses
 * everything, so "the gateway half is off" can never fail open.
 */
function secretsMatch(provided: string | undefined, secret: string): boolean {
  if (secret === '' || provided === undefined) return false
  const left = Buffer.from(provided, 'utf8')
  const right = Buffer.from(secret, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Read one JSON object body under the byte cap. An EMPTY body parses as the
 * empty object (the handshake takes no arguments; invoke then fails its own
 * field checks). Anything else — unparsable, a JSON array or scalar — comes
 * back undefined and becomes a 400. An oversized body is DRAINED, not
 * aborted mid-read: destroying the socket before the response goes out would
 * leave the desktop client with a connection error instead of the status
 * code explaining the refusal.
 */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (value: Record<string, unknown> | undefined): void => {
      if (!done) {
        done = true
        resolve(value)
      }
    }
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size <= MAX_BODY_BYTES) chunks.push(chunk)
      // Past the cap: keep consuming without buffering.
    })
    req.on('end', () => {
      if (done || size > MAX_BODY_BYTES) {
        finish(undefined)
        return
      }
      if (size === 0) {
        finish({})
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        finish(undefined)
        return
      }
      finish(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined)
    })
    req.on('error', () => finish(undefined))
  })
}

/**
 * What may travel to the client about a failed gateway call. DSH's own errors
 * always carry a `namespace/name`-shaped string `code` — those pass through
 * with a clipped message. EVERYTHING else — a plugin bug, or a Node system
 * error whose `code` (`ENOENT`, …) and message (`… '/Users/x/…'`) quote the
 * server's filesystem — reports `internal` and NO message at all (T22a-fix).
 */
function errorOf(error: unknown): { code: string; message?: string } {
  const code =
    error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : ''
  if (!DSH_ERROR_CODE.test(code)) return { code: 'internal' }
  const text = error instanceof Error ? error.message : String(error)
  return { code, message: text.slice(0, MAX_MESSAGE_CHARS) }
}

/**
 * Build the relay route handler mounted under {@link RELAY_PREFIX}. Exported
 * as a factory so the route tests can drive it against a plain node:http
 * server with a fake gateway and a real share store — no harness required.
 *
 * Every request passes the same gate first: gateway secret, then the two
 * marking headers. Failures answer a uniform 401 that does not say WHICH
 * check failed — the difference would only help someone probing the wall.
 * After the gate, `x-zen-remote-device` is the caller's device id (the
 * per-device stream budget hangs off it).
 *
 * @param options - secret, share store, gateway service and server facts.
 * @returns the handler owning the full response lifecycle of one request,
 *   with `viewerCount` alongside for the "who is looking" surface.
 */
export function createRelayHandler(options: RelayHandlerOptions): RelayHandler {
  const { secret, store, gateway, serverInfo } = options
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const endDrainTimeoutMs = options.endDrainTimeoutMs ?? DEFAULT_END_DRAIN_TIMEOUT_MS
  const parentOf = options.parentOf ?? (() => undefined)
  const isAccessible = (sessionId: string): boolean => store.isAccessible(sessionId, parentOf)

  /** Session-scoped streams currently open, per session (cross-device). */
  const viewers = new Map<string, number>()

  /** Open streams per device id, for the per-device budget. */
  const streamsByDevice = new Map<string, number>()

  /** Latest `job/list` rows seen per session — the recent-state half of the
   * job ownership check (the other half is a one-shot list on a cache miss).
   * An unshared session's rows are forgotten (T22b-fix): its jobs are none of
   * this client's business anymore. */
  const recentJobs = new Map<string, Map<string, string | undefined>>()
  /**
   * Every share-table listener this handler registered — the ownership
   * cache's unshare sweeper below, plus one per open stream. closeAll
   * detaches them ALL (T43-B): after the handler closed, a share/unshare on
   * the table must never re-enter the dead handler, not even through a
   * stream whose pump is still parked on a full socket buffer.
   */
  const tableUnsubscribers = new Set<() => void>()
  tableUnsubscribers.add(
    store.subscribe((event) => {
      if (event.type === 'unshared') recentJobs.delete(event.sessionId)
    }),
  )

  /** Kill switches of the streams currently open on THIS handler, and the
   * reason recorded by closeAll — a request that was mid-ownership-probe
   * when closeAll ran reads it just before it would open its upstream. */
  const openStreamKills = new Set<() => void>()
  let serverClosedReason: string | null = null

  /** Record one raw `job/list` frame into the ownership cache (unfiltered:
   * ownerless entries are remembered too, as "not owned by anyone"). */
  const rememberJobs = (sessionId: string, frame: unknown): void => {
    if (!isPlainObject(frame) || frame.type !== 'rows' || !Array.isArray(frame.jobs)) return
    const jobs = new Map<string, string | undefined>()
    for (const job of frame.jobs) {
      if (jobs.size >= JOB_CACHE_LIMIT) break
      if (isPlainObject(job) && typeof job.id === 'string' && job.id !== '') {
        jobs.set(job.id, typeof job.owner === 'string' ? job.owner : undefined)
      }
    }
    recentJobs.set(sessionId, jobs)
  }

  /**
   * Whether `jobId` belongs to `sessionId` — the relay-side ownership check
   * for `job/follow` / `job/kill`. DSH opens ownerless jobs to every session,
   * so without this a shared session would be a window onto server-wide
   * processes. The answer comes from the most recent `job/list` rows; on a
   * cache miss, one throwaway `job/list` stream is opened and abandoned. A
   * job the list does not mention is REFUSED: no answer is treated as no
   * permission, never the reverse.
   */
  const ownsJob = async (sessionId: string, jobId: string, signal: AbortSignal): Promise<boolean> => {
    const cached = recentJobs.get(sessionId)
    if (cached !== undefined && cached.has(jobId)) return cached.get(jobId) === sessionId
    try {
      const iterable = await gateway.stream({
        namespace: 'job',
        method: 'list',
        args: { request: { sessionId } },
        signal,
      })
      for await (const frame of iterable) {
        rememberJobs(sessionId, frame)
        const jobs = recentJobs.get(sessionId)
        // The first frame is the whole recent set; anything the client could
        // have seen lives in it or nowhere.
        return jobs !== undefined && jobs.has(jobId) && jobs.get(jobId) === sessionId
      }
      return false
    } catch {
      return false
    }
  }

  const handle: RelayHandler = async function handleRelay(req, res) {
    if (
      !secretsMatch(headerValue(req, 'x-zen-remote-secret'), secret) ||
      headerValue(req, 'x-zen-remote-via') !== 'gateway' ||
      headerValue(req, 'x-zen-remote-role') !== 'desktop-client'
    ) {
      responseJson(res, 401, { ok: false, error: { code: 'relay-unauthorized' } })
      return
    }
    // The stream route below budgets concurrent streams per device; other
    // routes do not need the id beyond the gate itself.

    // The pathname EXACTLY as the webserver saw it — never decoded before
    // matching (see the module comment): a decoded match would turn the
    // gateway-admitted `…%2f…` shapes back into a traversal.
    let pathname = ''
    try {
      pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    } catch {
      responseJson(res, 404, { ok: false, error: { code: 'not-found' } })
      return
    }

    if (req.method === 'GET' && pathname === `${RELAY_PREFIX}/ping`) {
      responseJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && pathname === `${RELAY_PREFIX}/v1/handshake`) {
      const body = await readJsonObject(req)
      if (body === undefined) {
        responseJson(res, 400, { ok: false, error: { code: 'bad-request' } })
        return
      }
      responseJson(res, 200, {
        ok: true,
        relayProtocol: RELAY_PROTOCOL,
        serverId: serverInfo.serverId,
        serverName: serverInfo.serverName(),
        dshVersion: serverInfo.dshVersion,
        fingerprints: {},
      })
      return
    }

    if (req.method === 'POST' && pathname === `${RELAY_PREFIX}/v1/unshare`) {
      const body = await readJsonObject(req)
      const sessionId = body?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        responseJson(res, 400, { ok: false, error: { code: 'bad-request' } })
        return
      }
      // The TABLE only — isShared, not isAccessible: a subagent or fork
      // session never entered the table, so it cannot be closed alone; it
      // leaves remote access together with its family or not at all.
      if (!store.isShared(sessionId)) {
        responseJson(res, 403, { ok: false, error: { code: 'not-shared' } })
        return
      }
      store.unshare(sessionId, 'client')
      responseJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && pathname === `${RELAY_PREFIX}/v1/invoke`) {
      const body = await readJsonObject(req)
      const namespace = body?.namespace
      const method = body?.method
      const args = body?.args
      if (
        typeof namespace !== 'string' ||
        namespace === '' ||
        typeof method !== 'string' ||
        method === '' ||
        args === null ||
        typeof args !== 'object' ||
        Array.isArray(args)
      ) {
        responseJson(res, 400, { ok: false, error: { code: 'bad-request' } })
        return
      }
      const decision = decideInvoke(namespace, method, args, isAccessible)
      if (!decision.allow) {
        responseJson(res, 403, { ok: false, error: { code: decision.reason } })
        return
      }
      // A client hanging up must not leave the host running the call to
      // completion behind a dead socket: the connection's close (arriving
      // before the response ends) cancels the AbortController whose signal
      // rides into gateway.invoke. 'close' also fires AFTER a normal end,
      // so only an unfinished response counts as a hang-up.
      const hangUp = new AbortController()
      const onClientGone = (): void => {
        if (!res.writableEnded) hangUp.abort()
      }
      res.on('close', onClientGone)
      try {
        // `job/kill` additionally proves the target job belongs to the
        // claimed session (4b): DSH opens ownerless jobs to everyone, so the
        // share-table check alone would let one shared session kill
        // server-wide background jobs.
        if (namespace === 'job' && method === 'kill') {
          const request = isPlainObject(args) ? args.request : undefined
          const jobId =
            isPlainObject(request) && typeof request.jobId === 'string' && request.jobId !== ''
              ? request.jobId
              : undefined
          const sessionId = isPlainObject(request) && typeof request.sessionId === 'string' ? request.sessionId : ''
          if (jobId === undefined || sessionId === '' || !(await ownsJob(sessionId, jobId, hangUp.signal))) {
            responseJson(res, 403, { ok: false, error: { code: 'forbidden' } })
            return
          }
          // The ownership probe can take a round trip — remote may have been
          // closed while it ran (T22b-fix). The decision above is stale the
          // moment an await happened; re-run the share-table check before
          // anything is forwarded.
          if (!isAccessible(sessionId)) {
            responseJson(res, 403, { ok: false, error: { code: 'not-shared' } })
            return
          }
        }
        const value = await gateway.invoke({ namespace, method, args, signal: hangUp.signal })
        const travels = decision.filter === 'session-list' ? filterSessionListResult(value, isAccessible) : value
        responseJson(res, 200, { ok: true, value: travels })
      } catch (error) {
        // The gateway's own failures (unknown namespace, absent service) are
        // business answers, not transport errors: they ride a 200 envelope
        // like every other result, with the gateway's string code preserved.
        const { code, message } = errorOf(error)
        responseJson(res, 200, message === undefined ? { ok: false, error: { code } } : { ok: false, error: { code, message } })
      } finally {
        res.off('close', onClientGone)
      }
      return
    }

    if (req.method === 'POST' && pathname === `${RELAY_PREFIX}/v1/stream`) {
      // Body validation identical to invoke: one JSON object naming the
      // method and carrying object args.
      const body = await readJsonObject(req)
      const namespace = body?.namespace
      const method = body?.method
      const args = body?.args
      if (
        typeof namespace !== 'string' ||
        namespace === '' ||
        typeof method !== 'string' ||
        method === '' ||
        args === null ||
        typeof args !== 'object' ||
        Array.isArray(args)
      ) {
        responseJson(res, 400, { ok: false, error: { code: 'bad-request' } })
        return
      }
      const decision = decideStream(namespace, method, args, isAccessible)
      if (!decision.allow) {
        // Refusals are plain JSON: the NDJSON protocol only starts once the
        // stream is allowed, so a 403 here is the same shape invoke answers.
        responseJson(res, 403, { ok: false, error: { code: decision.reason } })
        return
      }
      const device = headerValue(req, 'x-zen-remote-device') ?? ''
      if ((streamsByDevice.get(device) ?? 0) >= MAX_STREAMS_PER_DEVICE) {
        responseJson(res, 429, { ok: false, error: { code: 'too-many-streams' } })
        return
      }
      streamsByDevice.set(device, (streamsByDevice.get(device) ?? 0) + 1)
      try {
        // `job/follow` proves job ownership before anything is streamed (4b) —
        // same check, same refusal as `job/kill` on the invoke route.
        if (namespace === 'job' && method === 'follow') {
          const request = isPlainObject(args) ? args.request : undefined
          const jobId =
            isPlainObject(request) && typeof request.jobId === 'string' && request.jobId !== ''
              ? request.jobId
              : undefined
          const sessionId = decision.sessionIds[0] ?? ''
          if (jobId === undefined || sessionId === '' || !(await ownsJob(sessionId, jobId, hangUpOf(res)))) {
            responseJson(res, 403, { ok: false, error: { code: 'forbidden' } })
            return
          }
        }

        // Headers that keep every intermediary from buffering the line
        // stream: DSH's web server runs a compression middleware that would
        // hold the response until it is complete (it skips responses marked
        // `no-transform`), and nginx keeps buffering unless told otherwise.
        // Flushed immediately, so the client sees 200 + content type before
        // the first upstream frame exists.
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store, no-transform')
        res.setHeader('X-Accel-Buffering', 'no')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.flushHeaders()

        let clientGone = false
        let finished = false
        const hangUp = new AbortController()
        const onClientGone = (): void => {
          if (!res.writableEnded) {
            clientGone = true
            hangUp.abort()
          }
        }
        // 'error' rides along because a write racing a destroyed socket
        // surfaces there first; the reaction is the same as a hang-up.
        res.on('close', onClientGone)
        res.on('error', onClientGone)

        const heartbeat = setInterval(() => {
          if (!finished && !clientGone) res.write(PING_LINE)
        }, heartbeatMs)
        // The host process must never be kept alive by a heartbeat alone.
        if (typeof heartbeat.unref === 'function') heartbeat.unref()

        /**
         * One NDJSON line, honoring backpressure: when the socket buffer is
         * full the write returns false and the caller waits for `drain`
         * before the next write runs. A line racing a disconnect resolves
         * without writing (the 'close' leg of the wait). `tail` exempts the
         * line closeWith is writing from its own finished gate — without it
         * the end/error line would silence itself.
         *
         * Every write goes through ONE promise chain (T22b-fix): share-change
         * frames are enqueued behind whatever the pump is draining instead of
         * `void`-ing into the socket buffer in parallel, so a burst of
         * synthesized frames neither interleaves the pump's write/drain
         * cycles nor grows the buffer unboundedly.
         */
        let writeChain: Promise<void> = Promise.resolve()
        const writeLine = (value: unknown, tail = false): Promise<void> => {
          const run = writeChain.then(() => {
            if ((!tail && finished) || clientGone || res.destroyed || res.writableEnded) return
            return new Promise<void>((resolve) => {
              if (res.write(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'))) {
                resolve()
                return
              }
              let settle = (): void => {}
              const onDrain = (): void => settle()
              const onClose = (): void => settle()
              settle = (): void => {
                res.off('drain', onDrain)
                res.off('close', onClose)
                resolve()
              }
              res.on('drain', onDrain)
              res.on('close', onClose)
            })
          })
          writeChain = run.then(
            () => undefined,
            () => undefined,
          )
          return run
        }

        /**
         * The one transition into "response over": idempotent, clears the
         * heartbeat, writes the optional tail line, then ends the response.
         *
         * T43-A/fix: a client that stopped reading must not pin the stream —
         * with it the viewer count and the device budget — forever. The
         * watchdog starts UNCONDITIONALLY and owns the whole finish: the
         * response either FINISHES (tail line and end-of-body handed to the
         * socket — the `finish` event disarms the timer) or is gone
         * (`close`), or it is destroyed after `endDrainTimeoutMs`. No
         * branching on `writableNeedDrain`: a write that returned true can
         * still be sitting in front of a full kernel buffer, and `finish`
         * is the only honest "it drained" signal.
         */
        const closeWith = (line: Record<string, unknown> | null): void => {
          if (finished) return
          finished = true
          clearInterval(heartbeat)
          let watchdog: ReturnType<typeof setTimeout> | undefined
          const stopWatchdog = (): void => {
            res.off('finish', onSettled)
            res.off('close', onSettled)
            if (watchdog !== undefined) {
              clearTimeout(watchdog)
              watchdog = undefined
            }
          }
          const onSettled = (): void => {
            stopWatchdog()
          }
          if (!clientGone && !res.destroyed && !res.writableEnded) {
            res.once('finish', onSettled)
            res.once('close', onSettled)
            watchdog = setTimeout(() => {
              watchdog = undefined
              res.off('finish', onSettled)
              res.off('close', onSettled)
              // The tail is somewhere in the buffers but the client never
              // reads: destroying is the only way this response (and its
              // counters) ever finishes.
              try {
                res.destroy()
              } catch {
                // Already gone.
              }
            }, endDrainTimeoutMs)
            // The host process must never be kept alive by a finish alone.
            if (typeof watchdog.unref === 'function') watchdog.unref()
          }
          const tailLine = line === null ? Promise.resolve() : writeLine(line, true)
          void tailLine.then(() => {
            if (!clientGone && !res.destroyed && !res.writableEnded) res.end()
          })
        }

        // ---- share-change synchronization (T22b §4) --------------------

        let unsubscribe = (): void => {}
        let applyToState: ((frame: unknown) => void) | undefined

        if (decision.filter === 'workspace') {
          // Keep the UNFILTERED latest workspace state so share changes can
          // synthesize exactly the frames the client is now allowed to see.
          const state = createWorkspaceFollowState()
          applyToState = (frame) => state.apply(frame)
          unsubscribe = store.subscribe((event) => {
            if (event.type !== 'shared' && event.type !== 'unshared') return
            if (finished || clientGone) return
            for (const frame of state.onShareChange(event.sessionId, isAccessible)) {
              void writeLine({ type: 'frame', frame })
            }
          })
        } else if (decision.filter === 'control') {
          // A newly shared session needs its current projections: fetch
          // them once and emit one synthesized `projection` frame per key,
          // shaped exactly like the upstream frames. An unshared session
          // synthesizes nothing — the client drops it via the workspace
          // stream's re-filtered upserts.
          const syncProjections = async (sessionId: string): Promise<void> => {
            let result: unknown
            try {
              result = await gateway.invoke({
                namespace: 'session',
                method: 'projections',
                args: { request: { sessionId } },
                signal: hangUp.signal,
              })
            } catch {
              return // projections unavailable — the next live projection frame will flow anyway
            }
            if (!isPlainObject(result) || finished || clientGone || !isAccessible(sessionId)) return
            const values = isPlainObject(result.values) ? result.values : {}
            const seq = typeof result.asOfSeq === 'number' ? result.asOfSeq : 0
            for (const key of Object.keys(values)) {
              void writeLine({ type: 'frame', frame: { type: 'projection', sessionId, key, value: values[key], seq } })
            }
          }
          unsubscribe = store.subscribe((event) => {
            if (event.type !== 'shared' || finished || clientGone) return
            void syncProjections(event.sessionId)
          })
        } else {
          // Session-scoped stream: count its viewers, and die loudly when
          // a dependency stops being shared — silence would leave the
          // client reading a session it can no longer reach.
          for (const id of decision.sessionIds) viewers.set(id, (viewers.get(id) ?? 0) + 1)
          unsubscribe = store.subscribe((event) => {
            if (event.type !== 'unshared' || finished || clientGone) return
            if (decision.sessionIds.every((id) => isAccessible(id))) return
            closeWith({
              type: 'error',
              error: {
                code: 'unshared',
                message: `shared session ${event.sessionId} was unshared (${event.reason})`,
              },
            })
            hangUp.abort()
          })
        }

        const filterFrame: (frame: unknown) => unknown =
          decision.filter === 'workspace'
            ? (frame) => filterWorkspaceFrame(frame, isAccessible)
            : decision.filter === 'control'
              ? (frame) => filterControlFrame(frame, isAccessible)
              : namespace === 'job' && method === 'list'
                ? // 4b: ownerless and foreign jobs stay server-side.
                  (frame) => filterJobListFrame(frame, ownerSessionIdOf(args))
                : (frame) => frame

        // closeAll's kill switch for THIS stream: idempotent, safe to call on
        // an already-finished stream. Registered only while the response is
        // being served; the pump's finally unregisters it.
        const killThisStream = (): void => {
          hangUp.abort()
          const reason = serverClosedReason
          closeWith(
            reason === null || reason === ''
              ? { type: 'error', error: { code: 'server-restart' } }
              : { type: 'error', error: { code: 'server-restart', message: reason } },
          )
        }
        openStreamKills.add(killThisStream)
        // Registered beside the kill switch: closeAll detaches the stream's
        // share-table listener synchronously, before the pump's own teardown
        // gets a turn (T43-B).
        tableUnsubscribers.add(unsubscribe)

        // Last gate before anything is opened (T22b-fix): both checks cover
        // the window the ownership probe (or any earlier await) opened — an
        // unshare or a closeAll during that window fires no event this stream
        // could have observed, so the CURRENT state decides.
        const firstInaccessible = decision.sessionIds.find((id) => !isAccessible(id))
        const restartReason = serverClosedReason

        try {
          if (restartReason !== null) {
            // The handler was closed while this request was still deciding —
            // nothing may open anymore.
            killThisStream()
          } else if (firstInaccessible !== undefined) {
            hangUp.abort()
            closeWith({
              type: 'error',
              error: { code: 'unshared', message: `shared session ${firstInaccessible} is no longer shared` },
            })
          } else {
            const iterable = await gateway.stream({ namespace, method, args, signal: hangUp.signal })
            for await (const frame of iterable) {
              if (finished || clientGone) break
              if (namespace === 'job' && method === 'list') rememberJobs(ownerSessionIdOf(args), frame)
              applyToState?.(frame)
              const filtered = filterFrame(frame)
              if (filtered === null) continue
              await writeLine({ type: 'frame', frame: filtered })
            }
            closeWith({ type: 'end' })
          }
        } catch (error) {
          if (hangUp.signal.aborted || clientGone) {
            // The abort a hang-up (or an unshare kill) sends into the
            // iterator surfaces as gateway/cancelled — that is the stream's
            // DOCUMENTED normal end, swallowed whole.
            closeWith(null)
          } else {
            const { code, message } = errorOf(error)
            closeWith(message === undefined ? { type: 'error', error: { code } } : { type: 'error', error: { code, message } })
          }
        } finally {
          openStreamKills.delete(killThisStream)
          clearInterval(heartbeat)
          unsubscribe()
          tableUnsubscribers.delete(unsubscribe)
          res.off('close', onClientGone)
          res.off('error', onClientGone)
          if (decision.filter === undefined) {
            for (const id of decision.sessionIds) {
              const remaining = (viewers.get(id) ?? 1) - 1
              if (remaining <= 0) viewers.delete(id)
              else viewers.set(id, remaining)
            }
          }
        }
      } finally {
        const remaining = (streamsByDevice.get(device) ?? 1) - 1
        if (remaining <= 0) streamsByDevice.delete(device)
        else streamsByDevice.set(device, remaining)
      }
      return
    }

    responseJson(res, 404, { ok: false, error: { code: 'not-found' } })
  }

  handle.viewerCount = (sessionId: string): number => viewers.get(sessionId) ?? 0
  handle.closeAll = (reason: string): void => {
    // Detach EVERY share-table listener first (T43-B): after this point the
    // dead handler must not be reached by any share/unshare — not even by a
    // stream whose pump is parked on a full socket buffer and whose own
    // teardown still awaits the 'close' the kills below cause. Calling an
    // unsubscribe twice is a no-op, so the pumps' finallys stay honest.
    for (const detach of [...tableUnsubscribers]) detach()
    tableUnsubscribers.clear()
    // Remember the reason for requests still inside their ownership probe —
    // they read it at the pre-open gate. Killing the open streams runs their
    // normal teardown (error line, res.end, abort), whose finally releases
    // the viewer/device counters and the share-table listeners.
    serverClosedReason = typeof reason === 'string' ? reason : ''
    for (const kill of [...openStreamKills]) kill()
    openStreamKills.clear()
  }
  return handle
}

/** The claimed session of a `job/list` subscription — decideStream has
 * already verified it is a non-empty shared id; anything else is '' and the
 * job filter then keeps nothing. */
function ownerSessionIdOf(args: unknown): string {
  const request = isPlainObject(args) ? args.request : undefined
  return isPlainObject(request) && typeof request.sessionId === 'string' ? request.sessionId : ''
}

/**
 * A throwaway abort signal for checks that run before the stream's own
 * controller exists (the job ownership probe). Tied to the response: once the
 * client is gone there is no point fetching anything for it.
 */
function hangUpOf(res: ServerResponse): AbortSignal {
  const controller = new AbortController()
  res.once('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  return controller.signal
}
