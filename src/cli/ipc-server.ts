/**
 * The CLI's local IPC control server (CLI-1): a small HTTP server over a
 * 0600 Unix domain socket (`<dshHome>/zen-remote-cli.sock`, Windows: a named
 * pipe), owned by the DSH plugin process. Every DSH `webServer` route sits
 * behind signed-cookie auth, and the pieces the CLI must drive (the relay
 * pool, the managed Caddy / cloudflared children, the wizard state) follow
 * the plugin's single-in-process-owner discipline — so the CLI talks to THIS
 * process over THIS socket instead of a second entry point. Same user, same
 * machine: the 0600 socket IS the authentication.
 *
 * Lifecycle: the server is module-level (one per process, per dshHome). A
 * plugin row reload — including the role flips `restart-watcher` triggers —
 * re-acquires it and swaps the request DELEGATE in place; the underlying
 * socket never unbinds, so a CLI session survives every reload. When the
 * last owning row released it and a short grace period passes without a new
 * acquire, the server closes and the socket file is removed (the grace
 * covers the cordis dispose order, where the OLD row's disposer runs after
 * the NEW row's apply — a plain refcount would tear down between them).
 *
 * The wiring side (src/index.ts) folds the acquire/release into the existing
 * `'dsh-zen-remote: restart watcher'` effect on purpose: test/
 * role-wiring.test.cjs pins the exact number of top-level `ctx.effect`
 * registrations per role, so the IPC lifecycle may not add one.
 */

import { createServer, get } from 'node:http'
import type { IncomingMessage, RequestListener, Server, ServerResponse } from 'node:http'
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { connectsRole, servesRole } from '../config.js'
import type { ZenRemoteConfig } from '../config.js'
import { responseJson } from '../http.js'
import { ADMIN_ROUTE_PREFIX } from '../admin-routes.js'
import { CLIENT_ROUTE_PREFIX } from '../client-routes.js'
import { WIZARD_ROUTE_PREFIX } from '../wizard/routes.js'

/** The CLI protocol's major version. A client asking for a different one is
 * talking to a build it cannot drive (SPEC: refuse and tell the user to
 * upgrade the plugin). */
export const CLI_PROTOCOL_VERSION = 1

/** The protocol handshake route. */
export const CLI_PING_ROUTE = '/_dsh/zen-remote/cli/ping'

/** The config-write route (POST `{set, unset}` → the anti-shadowing writer). */
export const CLI_CONFIG_ROUTE = '/_dsh/zen-remote/cli/config'

/** Socket file / pipe basename: `zen-remote-cli.sock`, `-2.sock`, … */
export const CLI_SOCKET_BASENAME = 'zen-remote-cli'

/** How long a fully-released IPC server waits for a re-acquire (the hot
 * reload window: cordis runs the OLD row's disposer AFTER the new apply, so
 * refcount 0 is momentary during every reload). Exported for tests. */
export const CLI_CLOSE_GRACE_MS = 250

/** Inbound config body cap — the CLI writes a few fields at a time. */
const MAX_BODY_BYTES = 16 * 1024

/** Socket paths the process still holds, for the exit-time cleanup. */
const boundSocketFiles = new Set<string>()
let exitHookInstalled = false

function ensureExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const path of boundSocketFiles) {
      try {
        unlinkSync(path)
      } catch { /* already gone */ }
    }
  })
}

/**
 * The bind candidates, in backoff order: `<dshHome>/zen-remote-cli.sock`,
 * then `-2.sock` … `-8.sock` (two DSH instances on one machine — a web
 * profile and a headless one — each get their own channel). Windows has no
 * filesystem sockets: named pipes under the package's pipe name
 * `dsh-zen-remote-cli` with the same numbering.
 */
export function candidateSocketPaths(dshHome: string, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = []
  for (let n = 1; n <= 8; n += 1) {
    if (platform === 'win32') {
      out.push(n === 1 ? `\\\\.\\pipe\\dsh-${CLI_SOCKET_BASENAME}` : `\\\\.\\pipe\\dsh-${CLI_SOCKET_BASENAME}-${n}`)
    } else {
      out.push(join(dshHome, n === 1 ? `${CLI_SOCKET_BASENAME}.sock` : `${CLI_SOCKET_BASENAME}-${n}.sock`))
    }
  }
  return out
}

/** One role-gated handler set the IPC server forwards to — the row-scoped
 * closures src/index.ts builds per apply (per role branch). */
export interface CliIpcDelegate {
  /** The CURRENT effective role, re-read per request (a volatile row field). */
  role(): 'host' | 'client' | 'peer'
  /** The row's display name (this device's name on a client). */
  serverName(): string
  /** The profile context's name, when the composition has one. */
  profileName(): string | undefined
  /** This package's version, for the handshake header and ping body. */
  pluginVersion(): string
  /** The anti-shadowing config write (src/cli/config-writer.ts, wired with
   * the row object and the restart watcher's checkNow). */
  writeConfig(input: { set?: Record<string, unknown>; unset?: readonly string[] }):
    | { ok: true; values: ZenRemoteConfig }
    | { ok: false; code: 'env-shadowed'; field: string; envVar: string }
  /** Host-role handler sets; absent means the composition never built them
   * (the wrong-role gate answers before any consumer reaches here). */
  wizardHandler?: CliRouteHandler | undefined
  adminHandler?: CliRouteHandler | undefined
  /** Both roles mount a client handler (remote-status / debug-report are
   * role-agnostic); the wrong-role gate covers the pairing routes. */
  clientHandler?: CliRouteHandler | undefined
}

export type CliRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

export interface CliIpcServerOptions {
  dshHome: string
  delegate: CliIpcDelegate
  /** Bind-shape override (tests pin both platforms' candidate lists). */
  platform?: NodeJS.Platform
}

export interface CliIpcServer {
  /** The candidate path this instance actually bound. */
  readonly socketPath: string
  /** Hot reload: replace the delegate without touching the socket. */
  swapDelegate(delegate: CliIpcDelegate): void
  /** Close the server, clean the socket file, and answer once drained. */
  close(): Promise<void>
}

/** Is something ANSWERING on this socket path? A stale file (a dead
 * instance's leftover, or a plain file that merely squats the name) answers
 * nothing and may be cleaned; a live DSH instance answers its ping and must
 * be left alone. */
function probeAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = get({ socketPath, path: CLI_PING_ROUTE, timeout: 150 }, (res) => {
      res.resume()
      done(true)
    })
    req.on('timeout', () => {
      req.destroy()
      done(false)
    })
    req.on('error', () => done(false))
  })
}

/** Read the whole body under the cap and demand one JSON object. Same
 * contract as every route module's reader: empty body → `{}`, malformed or
 * oversized → null. */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const declared = req.headers['content-length']
  const expected = declared === undefined ? undefined : Number(declared)
  if (expected !== undefined && Number.isSafeInteger(expected) && expected > MAX_BODY_BYTES) return null
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === code
}

/**
 * Bind one CLI IPC server: walk the candidate paths, probing occupied files
 * for a live owner (skip those), cleaning stale ones, and answering with the
 * bound handle. Throws when every candidate is taken by a live instance.
 */
export async function createCliIpcServer(options: CliIpcServerOptions): Promise<CliIpcServer> {
  const platform = options.platform ?? process.platform
  const isWin = platform === 'win32'
  let delegate = options.delegate
  let current: Server | undefined
  let socketPath = ''

  const routeListener: RequestListener = (req, res) => {
    void handleCliRequest(req, res, () => delegate)
  }

  for (const candidate of candidateSocketPaths(options.dshHome, platform)) {
    if (!isWin && existsSync(candidate)) {
      if (await probeAlive(candidate)) continue
      try {
        unlinkSync(candidate)
      } catch {
        continue // unwritable squatter — try the next name
      }
    }
    const server = createServer(routeListener)
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(candidate, () => resolve())
      })
      current = server
      socketPath = candidate
      break
    } catch (error) {
      // EADDRINUSE (another process won the race) or any other bind failure
      // — the remaining candidates are the fallback, never a crash.
      server.close()
      if (!isErrnoCode(error, 'EADDRINUSE')) void error
      continue
    }
  }
  if (current === undefined) {
    throw new Error(`every ${CLI_SOCKET_BASENAME} candidate is occupied by a live instance (${options.dshHome})`)
  }
  if (!isWin) {
    try {
      chmodSync(socketPath, 0o600)
    } catch { /* exotic filesystems — the 0700 home is the outer wall */ }
  } else {
    // Named pipes carry no unlinkable file; nothing to register for exit.
  }
  if (!isWin) {
    boundSocketFiles.add(socketPath)
    ensureExitHook()
  }
  // The listen-phase `once('error')` is spent; later server-level errors
  // (accept failures on a dying socket) must not crash the host process.
  current.on('error', () => {})
  // The listening handle must not hold the event loop open (the same
  // discipline as the restart watcher's poll and the fetch-route fallback
  // timer): the DSH host process stays alive on its own services anyway,
  // and a composition whose everything-else has shut down should still be
  // able to exit. The exit hook above still cleans the socket file.
  if (typeof current.unref === 'function') current.unref()

  let closed = false
  return {
    socketPath,
    swapDelegate(next: CliIpcDelegate): void {
      delegate = next
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve()
      closed = true
      boundSocketFiles.delete(socketPath)
      return new Promise((resolve) => {
        const finish = (): void => {
          if (!isWin) {
            try {
              unlinkSync(socketPath)
            } catch { /* the server's own close unlink usually got here first */ }
          }
          resolve()
        }
        current!.close(() => finish())
        if (typeof current!.closeAllConnections === 'function') current!.closeAllConnections()
      })
    },
  }
}

/** The per-request dispatch: version headers on EVERY answer first, then the
 * two CLI routes, then the role-gated forwards into the row's handlers. */
async function handleCliRequest(
  req: IncomingMessage,
  res: ServerResponse,
  getDelegate: () => CliIpcDelegate,
): Promise<void> {
  try {
    const delegate = getDelegate()
    res.setHeader('x-zr-cli-version', String(CLI_PROTOCOL_VERSION))
    res.setHeader('x-zr-plugin-version', delegate.pluginVersion())
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const route = url.pathname
    const method = req.method ?? 'GET'

    if (route === CLI_PING_ROUTE) {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET')
        responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } })
        return
      }
      const role = delegate.role()
      const profileName = delegate.profileName()
      responseJson(res, 200, {
        ok: true,
        cliProtocolVersion: CLI_PROTOCOL_VERSION,
        pluginVersion: delegate.pluginVersion(),
        pid: process.pid,
        role,
        serves: servesRole(role),
        connects: connectsRole(role),
        serverName: delegate.serverName(),
        ...(profileName === undefined ? {} : { profileName }),
      })
      return
    }

    if (route === CLI_CONFIG_ROUTE) {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST')
        responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } })
        return
      }
      const body = await readJsonObject(req)
      if (body === null) {
        responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'The request body must be one JSON object' } })
        return
      }
      const set = body.set === undefined ? undefined : plainObject(body.set)
      const rawUnset = body.unset === undefined ? undefined : body.unset
      const unset = Array.isArray(rawUnset) && rawUnset.every((item) => typeof item === 'string')
        ? (rawUnset as string[])
        : undefined
      if ((body.set !== undefined && set === undefined) || (body.unset !== undefined && unset === undefined)) {
        responseJson(res, 400, { ok: false, error: { code: 'bad-request', message: '`set` must be an object and `unset` a string array' } })
        return
      }
      let result: { ok: true; values: ZenRemoteConfig } | { ok: false; code: 'env-shadowed'; field: string; envVar: string }
      try {
        result = delegate.writeConfig({
          ...(set === undefined ? {} : { set }),
          ...(unset === undefined ? {} : { unset }),
        })
      } catch (error) {
        responseJson(res, 500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
        return
      }
      if (!result.ok) {
        responseJson(res, 409, { ok: false, error: { code: result.code, field: result.field, envVar: result.envVar } })
        return
      }
      responseJson(res, 200, { ok: true, values: result.values })
      return
    }

    if (route === WIZARD_ROUTE_PREFIX || route.startsWith(`${WIZARD_ROUTE_PREFIX}/`)) {
      await forwardIfRole(req, res, delegate, delegate.wizardHandler)
      return
    }
    if (route === ADMIN_ROUTE_PREFIX || route.startsWith(`${ADMIN_ROUTE_PREFIX}/`)) {
      await forwardIfRole(req, res, delegate, delegate.adminHandler)
      return
    }
    if (route === CLIENT_ROUTE_PREFIX || route.startsWith(`${CLIENT_ROUTE_PREFIX}/`)) {
      // The pairing surfaces belong to a dialing role; remote-status and the
      // debug report are every role's own (the host answers its empty
      // conclusion). SPEC pins exactly this split.
      const sub = route.slice(CLIENT_ROUTE_PREFIX.length) || '/'
      const pairingOnly = new Set(['/status', '/claim', '/unpair', '/reconnect'])
      const required: 'client' | undefined = pairingOnly.has(sub) ? 'client' : undefined
      if (required !== undefined && !connectsRole(delegate.role())) {
        wrongRole(res, delegate.role(), required)
        return
      }
      if (delegate.clientHandler === undefined) {
        responseJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'no client handler in this row generation' } })
        return
      }
      await delegate.clientHandler(req, res)
      return
    }

    responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Unknown CLI route' } })
  } catch (error) {
    // A malformed req.url (`new URL` throwing) or a broken delegate must
    // never escape as an unhandled rejection — the handler owns the whole
    // response lifecycle.
    if (!res.headersSent) {
      responseJson(res, 500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
    } else {
      res.destroy()
    }
  }
}

/** The host-side role gate: answer 409 wrong-role (or 503 when the row never
 * built the handler) and stop there, or forward into the row's handler. */
async function forwardIfRole(
  req: IncomingMessage,
  res: ServerResponse,
  delegate: CliIpcDelegate,
  handler: CliRouteHandler | undefined,
): Promise<void> {
  if (!servesRole(delegate.role())) {
    wrongRole(res, delegate.role(), 'host')
    return
  }
  if (handler === undefined) {
    responseJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'no host handler in this row generation' } })
    return
  }
  await handler(req, res)
}

function wrongRole(res: ServerResponse, role: 'host' | 'client' | 'peer', required: 'host' | 'client'): void {
  responseJson(res, 409, { ok: false, error: { code: 'wrong-role', role, required } })
}

// --- module-level reuse coordinator (hot reload) -----------------------------
//
// One server per process per dshHome. apply() acquires with ITS delegate;
// the next apply swaps; the refcount only reaches zero across a reload
// momentarily, and the grace period eats that moment instead of tearing the
// socket down between the two rows.

interface AcquireEntry {
  starting: Promise<CliIpcServer>
  server: CliIpcServer | undefined
  pendingDelegate: CliIpcDelegate | undefined
  refCount: number
  closed: boolean
  graceTimer: ReturnType<typeof setTimeout> | undefined
}

const acquisitions = new Map<string, AcquireEntry>()

/**
 * A stand-in delegate for the bind window: between `listen` succeeding and
 * the acquiring row's swap landing (one microtask later), a request would
 * otherwise meet no delegate at all. It answers EVERYTHING through the
 * entry's pending delegate — which `acquireCliIpcServer` sets synchronously
 * — so the stub is only visible when literally no row ever acquired, and
 * its write refuses rather than pretending.
 */
function bootstrapDelegateFor(getEntry: () => AcquireEntry | undefined): CliIpcDelegate {
  return {
    role: () => getEntry()?.pendingDelegate?.role() ?? 'host',
    serverName: () => getEntry()?.pendingDelegate?.serverName() ?? '',
    profileName: () => getEntry()?.pendingDelegate?.profileName(),
    pluginVersion: () => getEntry()?.pendingDelegate?.pluginVersion() ?? 'unknown',
    writeConfig: (input) => {
      const current = getEntry()?.pendingDelegate
      if (current === undefined) throw new Error('no plugin row has acquired the CLI IPC server yet')
      return current.writeConfig(input)
    },
    wizardHandler: undefined,
    adminHandler: undefined,
    clientHandler: undefined,
  }
}

/**
 * Acquire (or hot-swap into) this process's IPC server for `dshHome`.
 * Synchronous on purpose: apply() runs inside cordis and cannot await. The
 * returned handle's `release()` is the row disposer; a release that hits
 * refcount 0 closes the server after {@link CLI_CLOSE_GRACE_MS} unless a new
 * row acquires first.
 */
export function acquireCliIpcServer(dshHome: string, delegate: CliIpcDelegate): { release(): void } {
  let entry = acquisitions.get(dshHome)
  if (entry === undefined) {
    // The entry the bind closure reads through `getEntry` — assigned right
    // after the (synchronous) object literal completes, long before any
    // request callback can run.
    let creating: AcquireEntry | undefined
    const created: AcquireEntry = {
      starting: createCliIpcServer({ dshHome, delegate: bootstrapDelegateFor(() => creating) }),
      server: undefined,
      pendingDelegate: undefined,
      refCount: 0,
      closed: false,
      graceTimer: undefined,
    }
    creating = created
    entry = created
    acquisitions.set(dshHome, created)
    void created.starting
      .then((server) => {
        created.server = server
        if (created.closed) {
          void server.close()
          return
        }
        if (created.pendingDelegate !== undefined) server.swapDelegate(created.pendingDelegate)
      })
      .catch(() => {
        // Every candidate was taken by live instances — drop the slot so a
        // later acquire can retry from scratch.
        if (acquisitions.get(dshHome) === created) acquisitions.delete(dshHome)
      })
  }
  if (entry.graceTimer !== undefined) {
    clearTimeout(entry.graceTimer)
    entry.graceTimer = undefined
  }
  entry.refCount += 1
  entry.pendingDelegate = delegate
  if (entry.server !== undefined && !entry.closed) entry.server.swapDelegate(delegate)
  return {
    release() {
      if (entry!.refCount > 0) entry!.refCount -= 1
      if (entry!.refCount > 0 || entry!.closed || entry!.graceTimer !== undefined) return
      entry!.graceTimer = setTimeout(() => {
        entry!.graceTimer = undefined
        if (entry!.refCount > 0 || entry!.closed) return
        acquisitions.delete(dshHome)
        entry!.closed = true
        void entry!.starting.then((server) => server.close()).catch(() => {})
      }, CLI_CLOSE_GRACE_MS)
      if (typeof entry!.graceTimer.unref === 'function') entry!.graceTimer.unref()
    },
  }
}
