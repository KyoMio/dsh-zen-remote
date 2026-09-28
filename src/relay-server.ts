/**
 * Server-side relay routes for the desktop client (T22a, first half of the
 * 2.0.0 remote-session work): authentication, ping, handshake, and the single
 * invoke passthrough. Streaming subscriptions, event forwarding and activity
 * stats are T22b.
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
import { decideInvoke } from './relay-access.js'

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

/** Shape of the `typertGateway` service this route needs (measured live,
 * docs/spike-relay.md §2.1: invoke returns the unwrapped business value and
 * throws errors carrying a string `code`). Declared structurally instead of
 * augmenting `Context`: the providing package is not a devDependency here,
 * and a local augmentation could collide with its own once that changes. */
export interface RelayGateway {
  invoke(call: { namespace: string; method: string; args: unknown; signal?: AbortSignal }): Promise<unknown>
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
  /** The host gateway service invokes go through. */
  gateway: RelayGateway
  /** Handshake facts. */
  serverInfo: RelayServerInfo
  /** Ancestor lookup for subagent reachability; defaults to "no parent". */
  parentOf?: (id: string) => string | undefined
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
 * What may travel to the client about a failed gateway call: DSH's own
 * errors (RemoteError / TypertGatewayError) always carry a string `code` —
 * those pass through with a clipped message. Anything else (a plugin bug,
 * a node Error with an absolute path in `message`) reports `internal` and
 * NO message at all.
 */
function errorOf(error: unknown): { code: string; message?: string } {
  const code =
    error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : ''
  if (code === '') return { code: 'internal' }
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
 * After the gate, `x-zen-remote-device` is the caller's device id (T22b
 * activity stats hang off it).
 *
 * @param options - secret, share store, gateway service and server facts.
 * @returns a handler owning the full response lifecycle of one request.
 */
export function createRelayHandler(
  options: RelayHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { secret, store, gateway, serverInfo } = options
  const parentOf = options.parentOf ?? (() => undefined)
  const isAccessible = (sessionId: string): boolean => store.isAccessible(sessionId, parentOf)

  return async function handleRelay(req, res) {
    if (
      !secretsMatch(headerValue(req, 'x-zen-remote-secret'), secret) ||
      headerValue(req, 'x-zen-remote-via') !== 'gateway' ||
      headerValue(req, 'x-zen-remote-role') !== 'desktop-client'
    ) {
      responseJson(res, 401, { ok: false, error: { code: 'relay-unauthorized' } })
      return
    }
    // The authenticated caller's device id. Unused until T22b wires the
    // "who is looking" activity stats; read here so the contract is visible.
    const deviceId = headerValue(req, 'x-zen-remote-device')

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
        const value = await gateway.invoke({ namespace, method, args, signal: hangUp.signal })
        responseJson(res, 200, { ok: true, value })
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

    responseJson(res, 404, { ok: false, error: { code: 'not-found' } })
  }
}
