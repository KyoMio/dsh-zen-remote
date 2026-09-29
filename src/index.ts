/**
 * dsh-mobile-nav, node half.
 *
 * Was an empty apply (pure client UI plugin) until S7. It now owns ONE host
 * route: the phone composer's attachment upload. The official file picker
 * opens on the machine running DSH, which is useless from a phone, and the
 * public client API has no upload verb at all — the only public browser->host
 * byte channel is `session.prompt([{type:'image',…}])`, which is images only
 * and lands as a sent message rather than a file on disk. So a non-image
 * attachment needs a route of its own, and that route belongs here rather
 * than in the gateway half of this plugin: the gateway authenticates and forwards
 * verbatim, it does not know what a session or a workspace is.
 *
 * The browser half still ships via exports["./client"], discovered through
 * the package.json dsh.client declaration.
 */

import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'

// The loader's volatile-only config announcement (T17b): committed volatile
// changes ride `loader/volatile-update` on the row context with the changed
// field paths (cordis-plugin-loader/lib/index.js, ~line 420, DSH 0.2.0). The
// loader package is not a dependency here, so its Events augmentation is
// restated locally to keep the ctx.on call typed.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: string[][]): void
  }
}
import { readFileConfig, resolveConfig, unwrapVolatile } from './config.js'
import { createActivityTracker, createParentIndex, startSweeper } from './activity.js'
import { ADMIN_ROUTE_PREFIX, createAdminHandler } from './admin-routes.js'
import type { SessionQueryLike } from './admin-routes.js'
import { normalizedRowServerUrl } from './client-pairing.js'
import { CLIENT_ROUTE_PREFIX, createClientHandler } from './client-routes.js'
import { responseJson, sameOriginPost } from './http.js'
import { onSessionCreated, restoreBusy } from './share-ops.js'
import type { AgentStatusLike } from './share-ops.js'
import type { AdminAdmission } from './admin-routes.js'
import { startRestartWatcher } from './restart-watcher.js'
import { handleShareExport, SHARE_EXPORT_ROUTE } from './share-export.js'
import { createShareStore } from './share-store.js'
import { createRelayClient, RelayError } from './relay-client.js'
import type { RelayClient } from './relay-client.js'
import { runSelfCheck, installIntercept } from './intercept.js'
import type { InterceptDiagnostics, InterceptHandle } from './intercept.js'
import { checkGatewayShape } from './intercept-shape.js'
import type { GatewayShapeCheck } from './intercept-shape.js'
import { createRelayHandler, loadServerId, RELAY_PREFIX, resolveDshVersion } from './relay-server.js'
import type { RelayGateway, RelayHandler } from './relay-server.js'

// The loader's config schema (settings form) and the role normalizer live in
// src/config.ts next to the resolution they describe; re-exported so the
// plugin row's public surface stays on the main entry. The same-origin gate
// moved to src/http.ts next to the response envelope (T14) but its export
// stays here for scripts/check-upload-endpoint.mjs.
export { Config, resolveRole } from './config.js'
export { sameOriginPost } from './http.js'

// The two sub-plugin entries the host role loads. They ship as plain .mjs at
// the package root, and `..` resolves there both from this file (via the
// hand-written lan-gate.d.mts / dsh-push.d.mts declarations) and from the
// built lib/index.js (via the real files).
import * as gateway from '../lan-gate.mjs'
import * as push from '../dsh-push.mjs'

/** Exact route the phone composer POSTs one file body to. */
export const UPLOAD_ROUTE = '/_dsh/mobile-nav/upload'

/**
 * The one piece of cordis the typert interception needs at RUNTIME: the
 * registered symbol under which every cordis proxy answers with its raw
 * instance (`symbols.original` in @deepseek-ai/cordis is
 * `Symbol.for('cordis.original')`). Bound LOCALLY instead of imported —
 * a runtime import would make the built lib depend on @deepseek-ai/cordis,
 * whose dev copy in this package's node_modules would shadow the host's
 * (the check-host-shadow gate fails the build for exactly that). Registered
 * symbols are shared across module copies by design, so the lookup is
 * identity-exact; if cordis ever renames the key the lookup yields
 * undefined and the interception reports a refused install instead of
 * misbehaving.
 */
const symbols = { original: Symbol.for('cordis.original') } as const

/** Exact route the browser GETs the plugin row's client-facing knobs from.
 * The client bundle ships statically and never sees the row config, so the
 * host republishes the client-relevant subset here (issue #2). */
export const CLIENT_CONFIG_ROUTE = '/_dsh/mobile-nav/client-config'

/** Workspace-relative directory uploads land in (also the `@` prefix the composer inserts). */
export const UPLOAD_DIR = '.dsh-uploads'

/** Body cap when the plugin row sets no `maxUploadBytes`. */
export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** Longest filename, in bytes, that survives sanitization (ext4/APFS leaf limit is 255). */
const MAX_NAME_BYTES = 180

/** Distinct leaf names tried before a collision is given up on. */
const MAX_COLLISION_TRIES = 100

/**
 * The client role's relay client (T23a), created inside apply() and kept on
 * the module so other halves of the plugin can reach it without reaching
 * into a context. T23b's request interception reads it through
 * {@link getRelayClient}; it stays undefined on the host role (and in
 * compositions that never ran this module's apply).
 */
let clientRelayClient: RelayClient | undefined

/** The live client-role relay client, if one was built. */
export function getRelayClient(): RelayClient | undefined {
  return clientRelayClient
}

/** Host half config. Every field below arrives through the loader as a
 * volatile live reference — a `{ get() }` wrapper over the stored value, not
 * the value itself (src/config.ts explains why every field is volatile) — so
 * the types name the value each field RESOLVES to, and every read goes
 * through `unwrapVolatile` at use time (this file's route handlers) or
 * through `resolveConfig`, which unwraps per field (T17b). */
export interface MobileNavConfig {
  /** Which parts of the plugin run in this DSH process. `'host'` — the
   * default, and the fallback for any value that is not exactly `'client'` —
   * additionally loads the gateway and push sub-plugins; `'client'` mounts
   * only the three host routes, for setups where another DSH process owns
   * the channel. Volatile: resolved per use, never snapshotted. */
  role?: unknown
  /** Max upload body in bytes; larger bodies get 413. Default {@link DEFAULT_MAX_UPLOAD_BYTES}.
   * Volatile: re-read per request through `unwrapVolatile`. */
  maxUploadBytes?: unknown
  /** Fold each turn's process at every viewport width, not just below the
   * phone breakpoint. Default false (phone-only). A browser can still opt
   * itself in via `?mobile-nav-turn-fold=1` when this is off. Volatile:
   * re-read per request through `unwrapVolatile`. */
  turnFoldDesktop?: unknown
  /** Calibration for the composer lift used when a phone's keyboard is
   * invisible to the browser (src/client/effects/keyboard-avoid.ts). Leave
   * every one of these unset to keep the shipped estimate — the route omits
   * what the row never set, and the client half owns the defaults, so there
   * is one place each default is written.
   *
   * Share of the layout viewport the estimated lift starts from (shipped
   * 0.42). Clamped to 0-1. Volatile: re-read per request. */
  keyboardLiftRatio?: unknown
  /** Ceiling on that estimate in CSS pixels (shipped 400). Clamped to 0-2000.
   * Volatile: re-read per request. */
  keyboardLiftMaxPx?: unknown
  /** Extra clearance above a keyboard the browser DID react to, Android only
   * (shipped 15). Clamped to 0-200. Volatile: re-read per request. */
  keyboardSafetyPadPx?: unknown
}

/**
 * One configured number on its way to the browser, clamped into a band that
 * cannot break the composer — a ratio of 5 or a 9000px lift would push the
 * input clean off the screen with no way back except editing the YAML again.
 * Absent from the result when the row left it unset or wrote something that
 * is not a finite number, which leaves the client on its shipped default.
 *
 * Exported for scripts/check-keyboard-avoid.mjs — this is the trust boundary
 * between a hand-edited YAML row and the browser, so it is asserted directly.
 */
export function clamped(key: string, value: number | undefined, min: number, max: number): Record<string, number> {
  if (typeof value !== 'number' || !Number.isFinite(value)) return {}
  return { [key]: Math.min(Math.max(value, min), max) }
}

/**
 * One rejection carrying the status the client should see.
 *
 * Fields are assigned in the body rather than declared as constructor
 * parameter properties: `scripts/check-upload-endpoint.mjs` imports this
 * module through Node's strip-only type stripping, which rejects that syntax.
 */
class UploadError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'UploadError'
    this.status = status
    this.code = code
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === code
}

/**
 * Reject a resolved path that is not rooted below the expected directory.
 * @param root - the directory the target must stay inside.
 * @param target - the resolved candidate path.
 * @throws when the target escapes the root.
 */
export function ensurePathInside(root: string, target: string): void {
  const rel = relative(root, target)
  if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new UploadError(400, 'path-escape', `resolved upload path escapes its workspace root: ${target}`)
  }
}

/**
 * Convert an untrusted browser label into one portable leaf filename.
 *
 * Everything that could steer the write out of the upload directory is gone
 * after this: only the basename survives (so `../../etc/passwd` becomes
 * `passwd`), separators and control characters become `_`, leading dots are
 * dropped, and the Windows reserved device names are prefixed. Whitespace
 * folds to `_` rather than being kept: the client appends the result to the
 * composer draft as an `@path` mention, and a mention with a space in it is
 * broken for the agent reading it, not just for the chip parser. Length is
 * capped in BYTES because the label arrives as UTF-8.
 * @param raw - browser-supplied filename.
 * @returns a single safe leaf name, never empty.
 */
export function safeUploadName(raw: string): string {
  const leaf = basename(raw.replaceAll('\\', '/')).normalize('NFC')
  let cleaned = leaf
    .replace(/[<>:"|?*\u0000-\u001f/\\]/gu, '_')
    .replace(/\s+/gu, '_')
    .replace(/^\.+/u, '')
    .trim()
    .replace(/[. ]+$/u, '')
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(cleaned)) cleaned = `_${cleaned}`
  const candidate = cleaned === '' ? 'upload.bin' : cleaned
  if (Buffer.byteLength(candidate) <= MAX_NAME_BYTES) return candidate
  const extension = extname(candidate).slice(0, 20)
  const budget = Math.max(1, MAX_NAME_BYTES - Buffer.byteLength(extension))
  let stem = candidate.slice(0, Math.max(1, candidate.length - extension.length))
  while (Buffer.byteLength(stem) > budget) stem = stem.slice(0, -1)
  return `${stem}${extension}`
}

function singleQuery(url: URL, key: string): string {
  const values = url.searchParams.getAll(key)
  const value = values[0]
  if (values.length !== 1 || value === undefined || value === '') {
    throw new UploadError(400, 'bad-request', `${key} is required exactly once`)
  }
  return value
}

/** Create the directory if absent, then prove it is a real directory inside the workspace. */
async function ensureManagedDirectory(workspace: string, path: string): Promise<string> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (!isErrnoCode(error, 'EEXIST')) throw error
  }
  const entry = await lstat(path)
  // A symlink here would be the one way a prior workspace write could still
  // redirect the bytes elsewhere — realpath alone would happily follow it.
  if (entry.isSymbolicLink()) {
    throw new UploadError(400, 'path-escape', `upload directory is a symbolic link: ${path}`)
  }
  if (!entry.isDirectory()) throw new UploadError(400, 'path-escape', `upload path is not a directory: ${path}`)
  const canonical = await realpath(path)
  ensurePathInside(workspace, canonical)
  return canonical
}

interface UploadRoot {
  /** Canonical directory the bytes are written into. */
  writeRoot: string
  /** The same directory as the user sees it (pre-realpath), for the returned relative path. */
  visibleRoot: string
}

/**
 * Resolve (and create) the upload directory of one live session.
 * @param ctx - host context carrying the sessions service.
 * @param sessionId - the session whose workspace receives the file.
 * @returns the canonical and visible upload directories.
 * @throws 404 when no live session has that id.
 */
async function sessionUploadRoot(ctx: Context, sessionId: string): Promise<UploadRoot> {
  const session = ctx.sessions.get(sessionId as never)
  if (session === undefined) throw new UploadError(404, 'session-not-found', `live Session not found: ${sessionId}`)
  const cwd = session.header.cwd
  if (cwd === undefined || !isAbsolute(cwd)) {
    throw new UploadError(404, 'session-not-found', `Session has no absolute workspace: ${sessionId}`)
  }
  const visibleWorkspace = resolve(cwd)
  const workspace = await realpath(visibleWorkspace)
  const visibleRoot = join(visibleWorkspace, UPLOAD_DIR)
  const writeRoot = await ensureManagedDirectory(workspace, visibleRoot)
  return { writeRoot, visibleRoot }
}

/**
 * Claim one not-yet-existing leaf name, suffixing `-1`, `-2`, … on collision.
 * `wx` makes the claim atomic, so two concurrent uploads of the same name
 * cannot both win the same path.
 */
async function openUnique(directory: string, filename: string): Promise<{ handle: FileHandle; path: string }> {
  const extension = extname(filename)
  const stem = filename.slice(0, filename.length - extension.length) || 'upload'
  for (let n = 0; n < MAX_COLLISION_TRIES; n += 1) {
    const path = join(directory, n === 0 ? `${stem}${extension}` : `${stem}-${n}${extension}`)
    ensurePathInside(directory, path)
    try {
      return { handle: await open(path, 'wx', 0o600), path }
    } catch (error) {
      if (!isErrnoCode(error, 'EEXIST')) throw error
    }
  }
  throw new UploadError(409, 'name-taken', `too many files named like ${filename}`)
}

/**
 * Stream the request body onto disk under a running byte cap.
 * @param req - the request whose body is the file.
 * @param directory - canonical upload directory.
 * @param filename - sanitized leaf name.
 * @param maxBytes - hard cap; exceeding it aborts and unlinks.
 * @returns the absolute path written and its byte count.
 */
async function writeUpload(
  req: IncomingMessage,
  directory: string,
  filename: string,
  maxBytes: number,
): Promise<{ path: string; bytes: number }> {
  const declared = req.headers['content-length']
  const expected = declared === undefined ? undefined : Number(declared)
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) {
    throw new UploadError(400, 'bad-request', 'Content-Length is not a byte count')
  }
  // Reject the oversized upload before a single byte is read, so the phone
  // gets its 413 without spending the whole body on the radio.
  if (expected !== undefined && expected > maxBytes) {
    throw new UploadError(413, 'too-large', `upload exceeds the ${maxBytes}-byte limit`)
  }

  const { handle, path } = await openUnique(directory, filename)
  let received = 0
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      received += bytes.length
      // Chunked bodies declare no length, so the cap must also hold here.
      if (received > maxBytes) throw new UploadError(413, 'too-large', `upload exceeds the ${maxBytes}-byte limit`)
      await handle.write(bytes)
    }
    if (expected !== undefined && received !== expected) {
      throw new UploadError(400, 'truncated', `upload body size mismatch: expected ${expected}, received ${received}`)
    }
    await handle.close()
    return { path, bytes: received }
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(path, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Handle one `POST {@link UPLOAD_ROUTE}?session=<id>&name=<file>` request.
 *
 * Exported so an integration check can drive it with a plain node:http server
 * and a fake sessions service instead of booting a harness.
 * @param ctx - host context carrying the sessions service and logger.
 * @param maxBytes - body cap.
 * @param req - inbound request; its body is the raw file.
 * @param res - the response this call owns end to end.
 * @param admit - DSH's connection-service admission, passed by the apply()
 *   wiring (T17): webServer routes skip DSH's /api authentication, so every
 *   request must ask the connection service itself, its refusal relayed
 *   verbatim — same first wall as the admin and client routes. Optional only
 *   for the direct-drive check scripts; production always passes it.
 */
export async function handleUpload(
  ctx: Context,
  maxBytes: number,
  req: IncomingMessage,
  res: ServerResponse,
  admit?: (req: IncomingMessage) => AdminAdmission,
): Promise<void> {
  if (admit !== undefined) {
    const admission = admit(req)
    if ('rejection' in admission) {
      responseJson(res, admission.rejection, {
        ok: false,
        error: { code: admission.rejection === 401 ? 'unauthorized' : 'forbidden' },
      })
      return
    }
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } })
    return
  }
  if (!sameOriginPost(req)) {
    const error = { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' }
    responseJson(res, 403, { ok: false, error })
    return
  }
  try {
    const url = new URL(req.url ?? UPLOAD_ROUTE, 'http://dsh.internal')
    const sessionId = singleQuery(url, 'session')
    const filename = safeUploadName(singleQuery(url, 'name'))
    const root = await sessionUploadRoot(ctx, sessionId)
    const written = await writeUpload(req, root.writeRoot, filename, maxBytes)
    const leaf = basename(written.path)
    responseJson(res, 201, {
      ok: true,
      relPath: `${UPLOAD_DIR}/${leaf}`,
      absolutePath: join(root.visibleRoot, leaf),
      filename: leaf,
      bytes: written.bytes,
    })
  } catch (error) {
    const status = error instanceof UploadError ? error.status : 400
    const code = error instanceof UploadError ? error.code : 'upload-rejected'
    ctx.logger.warn('dsh-mobile-nav upload rejected: %s', message(error))
    responseJson(res, status, { ok: false, error: { code, message: message(error) } })
  }
}

/**
 * Host half: mount the upload route wherever a webServer and live sessions
 * exist. Both are injected INSIDE apply rather than declared as a top-level
 * `inject`, so the plugin row still loads (and the browser half still ships)
 * in a composition without them — Electron carries no webServer.
 *
 * On the host role (the default) this row also loads the gateway and push
 * sub-plugins, each with the RESOLVED config — every field merged from env >
 * row > lan-gate.config.json > defaults (src/config.ts) — not the raw row,
 * so the halves see the same effective values the row does. Cordis honors a
 * sub-plugin's own `inject` before calling its apply and routes fiber
 * failures into the context logger, so a fire-and-forget call is the whole
 * contract. The route tests' fake contexts carry a no-op `plugin` for it.
 * @param ctx - host plugin context.
 * @param config - the plugin row config as the loader handed it over (see
 *   {@link MobileNavConfig}): every field is a volatile live reference
 *   (`{ get() }` wrapper, T17), so nothing here is snapshotted —
 *   `resolveConfig` merges the row with `lan-gate.config.json` and the
 *   environment per read, and the route handlers unwrap their knobs per
 *   request.
 */
export function apply(ctx: Context, config: MobileNavConfig = {}): void {
  const effective = resolveConfig(config, readFileConfig(), process.env)
  if (effective.values.role === 'host') {
    // A row that switched from client to host must not leave a stale relay
    // client where getRelayClient() can find it (T23a-fix).
    clientRelayClient = undefined
    // The relay shared secret (T22a): minted fresh per apply, handed to the
    // gateway child through LAN_GATE_RELAY_SECRET and kept here for the
    // relay routes below. The push half never sees it.
    const relaySecret = randomBytes(32).toString('hex')
    ctx.plugin(gateway, { ...effective.values, relaySecret })
    ctx.plugin(push, effective.values)
    // The shared-session table backing the relay's access control. The relay
    // route consumes it below; the activity tracker and idle sweeper (T22c)
    // keep its "quiet for idleHours → close" promise. The settings surface is
    // a later task.
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const store = createShareStore({
      file: join(home, 'zen-remote-shares.json'),
      idleHours: effective.values.idleHours,
    })
    // The live relay handler, kept so the admin shares route can read viewer
    // counts through it (T33a2): the handler is the only piece that knows
    // who is connected. Assigned when the relay route mounts, cleared in its
    // teardown (identity-checked: a row reload builds a NEW handler before
    // the old one's disposer runs) — the admin route reads whatever is live
    // at request time and answers 0 viewers when none is mounted.
    let relayHandler: RelayHandler | undefined
    // Keep the table's clocks honest (T22c). The subscription mirrors
    // dsh-push.mjs's session/event listener — post-commit append feed for
    // EVERY session, subagent children included. The session id is read off
    // the Session object itself: `session.id` (a getter over the durable
    // header's single copy, per @deepseek-ai/dsh-session's Session type),
    // same field the push half reads through exec.agent.session.id. An event
    // that somehow arrives without a usable id is ignored, and listener
    // registration failure degrades to a warning like the push half's.
    // The parent index (T22c-fix) records subagent→parent links off the same
    // events' headers — DSH 0.2.0 dsh-session's validateSessionHeader pins
    // the two fields (`origin` is only ever 'subagent', `parentSession` a
    // string) — so a background child's motion refreshes its ancestors'
    // clocks and the relay can walk the same chain for reachability.
    const parentIndex = createParentIndex()
    const tracker = createActivityTracker(store, parentIndex.parentOf)
    try {
      ctx.on('session/event', (session, event) => {
        // Record the parent link BEFORE tracking, so a child's very first
        // event already reaches its ancestors.
        parentIndex.observe(session)
        const sessionId: unknown = session?.id
        if (typeof sessionId !== 'string' || sessionId === '') return
        tracker.onEvent(sessionId, event.type)
      })
    } catch (error) {
      ctx.logger.warn('dsh-zen-remote cannot listen on "session/event": %s', message(error))
    }
    // Auto-share and fork-following (T33a), off `agent/created` — the only
    // host event that fires EXACTLY ONCE per NEW session. Its `source` is
    // 'startup' for fresh creation (top-level, fork and subagent all go
    // through the same factory call) and 'resume' when a persisted session
    // re-enters the live store, so filtering on 'startup' is what keeps a
    // manually-closed session closed across reopens — `session/created`
    // re-fires on resume and `api-session/added` also fires when an agent is
    // disposed, so neither qualifies. The payload's agent id IS the session
    // id (dsh-agent keys its registry by it; its typert wire type is
    // `dsh-session/types#SessionId`), and by announce time the fresh header
    // already carries the subagent/fork markers the share decision reads.
    // autoShareNewSessions is a volatile row setting: resolved at EVENT time,
    // never snapshotted here.
    try {
      ctx.on('agent/created', ({ agent, source }) => {
        // The feed dispatches SERIALLY: a throwing listener rolls the whole
        // session creation back (dsh-agent's announce awaits every listener
        // and fails the creation on the first rejection). Sharing is
        // best-effort bookkeeping — it must never be able to fail the
        // creation that triggered it.
        try {
          if (source !== 'startup') return
          onSessionCreated(agent.session.header, {
            store,
            autoShare: resolveConfig(config, readFileConfig(), process.env).values.autoShareNewSessions,
            parentOf: parentIndex.parentOf,
          })
        } catch (error) {
          ctx.logger.warn('dsh-zen-remote cannot share new session "%s": %s', agent.id, message(error))
        }
      })
    } catch (error) {
      ctx.logger.warn('dsh-zen-remote cannot listen on "agent/created": %s', message(error))
    }
    // Busy restore (T33a): `busy` is never persisted, so right after a row
    // restart every shared session believes itself idle — including one whose
    // agent is mid-turn, which would then idle out from under the turn. Once
    // the agents service exists, re-mark whatever is actually running (the
    // flags clear again through the tracker's turn/end above).
    ctx.inject(['agents'], (agentsCtx) => {
      const agents = (agentsCtx as Context & { agents: { list(): readonly AgentStatusLike[] } }).agents
      restoreBusy(store, () => agents.list())
    })
    // Settings-surface admin routes (T14). The browser cannot call the
    // gateway's loopback-only admin API from DSH's origin, so the host
    // process re-exposes it same-origin and the handler calls the gateway AS
    // the local machine. `connection` supplies admit() — webServer routes
    // skip DSH's /api authentication — so a composition without one (Electron
    // carries no webServer either) simply never mounts the routes. Everything
    // config-shaped is resolved PER REQUEST inside the handler (volatile row
    // fields change without a restart, and the test-push copy follows the
    // live `lang`); only the non-volatile gateway port is captured here,
    // which a row restart re-reads anyway. Registered AFTER the store exists
    // above: an inject callback whose services are already present runs
    // synchronously during apply, and the shares options close over `store`.
    ctx.inject(['webServer', 'connection'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: ADMIN_ROUTE_PREFIX,
        handler: createAdminHandler({
          admit: (req) => webCtx.connection.admit(req),
          gatewayBase: `http://127.0.0.1:${effective.values.port}`,
          getConfig: () => resolveConfig(config, readFileConfig(), process.env),
          // Shares routes (T33a): the table above is the truth they serve and
          // mutate. typertGateway and agents are deliberately NOT in this
          // inject's declaration list — adding them would keep the WHOLE
          // admin prefix off 0.1.7 / Electron compositions that lack them —
          // so they are read PER REQUEST through the reflection layer's
          // store lookup (runtime `ctx.get`, declared `ctx.reflect.get`),
          // which answers undefined when the service is absent. Property
          // access is not an option: cordis refuses reads of services the
          // context did not declare (`cannot get property … without inject`),
          // which would turn every shares request into a 500.
          store,
          typert: () => webCtx.reflect.get('typertGateway') as RelayGateway | undefined,
          listAgents: () => (webCtx.reflect.get('agents') as { list(): readonly AgentStatusLike[] } | undefined)?.list() ?? [],
          // The "who is looking" badge (T33a2): read through whichever relay
          // handler is live right now. sessionQuery likewise — the share
          // action reads the durable session header through it to judge
          // subagent sessions, degrading to the projection identity when the
          // composition lacks the service.
          viewerCount: (id) => relayHandler?.viewerCount(id) ?? 0,
          sessionQuery: () => webCtx.reflect.get('sessionQuery') as SessionQueryLike | undefined,
        }),
      }), 'dsh-zen-remote: admin routes')
    })
    // The idle sweeper (T22c): every minute, hand the table the CURRENT
    // idleHours and let it close sessions quiet past that. idleHours is a
    // volatile row field, so getIdleHours re-resolves from the SAME row
    // object apply() received at every tick — never snapshotted (the same
    // discipline as serverName in the relay route above); an illegal value
    // falls back inside resolveConfig, and share-store ignores the rest.
    ctx.effect(
      () => startSweeper({ store, getIdleHours: () => resolveConfig(config, readFileConfig(), process.env).values.idleHours }),
      'dsh-zen-remote: idle sweeper',
    )
    // The relay routes live where the typertGateway service does (0.2.0
    // compositions): a composition without it — 0.1.7, Electron — simply
    // never mounts them, and the relay prefix stays unrouted.
    ctx.inject(['webServer', 'typertGateway'], (relayCtx) => {
      // Structurally typed instead of a Context augmentation: the providing
      // package is not a devDependency here (see RelayGateway's comment).
      const gatewayService = (relayCtx as Context & { typertGateway: RelayGateway }).typertGateway
      relayCtx.effect(() => {
        const handler = createRelayHandler({
          secret: relaySecret,
          store,
          gateway: gatewayService,
          // Subagent reachability (T22c-fix): isAccessible walks the same
          // child→parent chain the activity tracker keeps fresh.
          parentOf: parentIndex.parentOf,
          serverInfo: {
            serverId: loadServerId(home),
            // serverName is a volatile row setting ({ get() } wrapped) that
            // can change without a row restart, so it is recomputed from the
            // SAME row object apply() received at every handshake — never
            // snapshotted from the resolveConfig call above.
            serverName: () => resolveConfig(config, readFileConfig(), process.env).values.serverName,
            dshVersion: resolveDshVersion(),
          },
        })
        const unregister = relayCtx.webServer.register({
          kind: 'prefix',
          path: RELAY_PREFIX,
          handler,
        })
        // Publish the handler for the admin shares route's viewer counts
        // (T33a2) BEFORE the route is reachable, so no request can hit a
        // mounted route with an unpublished handler.
        relayHandler = handler
        // A row reload builds a NEW handler over a NEW share table; the open
        // streams of this one would push forever, unreachable by any unshare
        // (T22b-fix) — so the teardown ends them with a server-restart error
        // line before the route itself is unregistered, and the pointer
        // follows (identity-checked: the new handler is already live by the
        // time this old disposer runs).
        return () => {
          handler.closeAll('plugin row reloaded')
          unregister()
          if (relayHandler === handler) relayHandler = undefined
        }
      }, 'dsh-zen-remote: relay route')
    })
  } else {
    // Sub-client half (T16, T23a): pairing claim + connection status, talking to
    // the SERVER's gateway instead of running one. Same admission wall as
    // the admin routes — and, like them, a composition without a connection
    // service (Electron carries none) simply never mounts the routes. The
    // handler keeps the RAW row object: serverUrl / deviceToken are volatile
    // ({ get() } wrapped), so every request reads them live through
    // unwrapVolatile — an apply-time snapshot would go stale the moment the
    // settings page pairs or unpairs.
    //
    // The relay client (T23a) reads the SAME volatile fields live at every
    // request; the address passes the claim route's normalizer, and an
    // address that no longer normalizes counts as missing — a hand-edited
    // row must not receive the pairing token.
    const row = config as Record<string, unknown>
    const relayClient = createRelayClient({
      getServerUrl: () => normalizedRowServerUrl(row),
      getToken: () => {
        const value = unwrapVolatile(row.deviceToken)
        return typeof value === 'string' && value !== '' ? value : undefined
      },
    })
    clientRelayClient = relayClient
    // A stopped or reloaded row must not leave a stale instance where the
    // module getter can hand it out (T23a-fix), and its reconnect machinery
    // (T43) must not outlive the row either: stop() cancels the armed retry
    // timer and blocks further scheduling. The identity guard keeps a slow
    // dispose from clearing a NEWER row's instance that a reload already
    // installed.
    ctx.effect(() => () => {
      relayClient.stop()
      if (clientRelayClient === relayClient) clientRelayClient = undefined
    }, 'dsh-zen-remote: relay client disposal')
    // Credentials watch (T43): serverUrl / deviceToken are volatile row
    // fields, and a pairing write (or unpair) commits them WITHOUT a row
    // restart. The loader announces the commit on the row context; the
    // client drops its pending reconnect wait and dials the new credentials
    // immediately. Failure to subscribe degrades to a warning — the ladder
    // and the per-request getters keep working without it.
    ctx.effect(() => {
      try {
        const off = ctx.on('loader/volatile-update', () => relayClient.credentialsChanged())
        return () => {
          off()
        }
      } catch (error) {
        ctx.logger.warn('dsh-zen-remote: cannot listen on "loader/volatile-update" for relay credentials: %s', message(error))
        return () => {}
      }
    }, 'dsh-zen-remote: relay credentials watcher')
    // One connection attempt at startup (T23a). Failures only log — the
    // status route surfaces the resulting state, and the client's own
    // backoff ladder (T43) takes over from the first failure. An unpaired
    // row is the normal not-configured shape and stays silent.
    void relayClient.connect().catch((error) => {
      if (error instanceof RelayError && error.code === 'unpaired') return
      const code = error instanceof RelayError ? error.code : 'error'
      ctx.logger.warn('dsh-zen-remote relay client initial connect failed (%s): %s', code, message(error))
    })
    // The typertGateway interception (T23b-1): remote-session calls ride the
    // relay, everything else reaches the local gateway untouched. The live
    // diagnostics flow to the client status route through whichever of the
    // two slots is filled — an installed handle, or the shape verdict that
    // REFUSED an install (both belong on the settings surface). A
    // composition without typertGateway (0.1.7 client) leaves both empty and
    // the status answer simply carries no intercept field.
    let interceptHandle: InterceptHandle | undefined
    let interceptRefused: GatewayShapeCheck | undefined
    const interceptDiagnostics = (): InterceptDiagnostics | undefined => {
      if (interceptHandle !== undefined) return interceptHandle.diagnostics()
      if (interceptRefused !== undefined) {
        return { installed: false, shape: interceptRefused, recentFailures: [] }
      }
      return undefined
    }
    ctx.inject(['typertGateway'], (gatewayCtx) => {
      // Degraded logging: the real cordis context always carries a logger,
      // but a row fake without one must not crash apply.
      const logWarn = (...args: Parameters<Context['logger']['warn']>): void => { ctx.logger?.warn(...args) }
      const proxy = (gatewayCtx as Context & { typertGateway?: unknown }).typertGateway
      const raw = proxy !== null && typeof proxy === 'object'
        ? (proxy as Record<PropertyKey, unknown>)[symbols.original]
        : undefined
      if (raw === null || typeof raw !== 'object') {
        interceptRefused = { ok: false, reasons: ['original: typertGateway[symbols.original] is not an object'] }
        logWarn('dsh-zen-remote client intercept not installed: %s', interceptRefused.reasons[0])
        return
      }
      // Shape first (spike §4.1): a failed check leaves the gateway exactly
      // as it was — remote features stay off, local behavior is untouched.
      const shape = checkGatewayShape(raw)
      if (!shape.ok) {
        interceptRefused = shape
        logWarn('dsh-zen-remote client intercept not installed: %s', shape.reasons.join('; '))
        return
      }
      const handle = installIntercept({
        raw,
        relay: relayClient,
        getServerId: () => relayClient.handshakeInfo?.serverId,
        log: (format, ...args) => { ctx.logger?.info(`dsh-zen-remote ${format}`, ...args) },
      })
      interceptHandle = handle
      gatewayCtx.effect(() => () => {
        handle.uninstall()
        if (interceptHandle === handle) interceptHandle = undefined
      }, 'dsh-zen-remote: typert intercept')
      // Behavior self-check (spike §4.1 check 4) — the shape check proves
      // the constructor still resolves dynamically, this proves the wrap is
      // actually REACHED: one local `workspace/follow` through
      // wireStream.open must enter the wrapper at least once and answer a
      // `baseline` first frame with a value.items array. One retry after a
      // pause; only a second failure uninstalls (a half-trusted
      // interception is worse than none). Failure handling lives in
      // runSelfCheck, which records the verdict via noteSelfCheck.
      void runSelfCheck(raw, { handle, log: logWarn })
    })
    ctx.inject(['webServer', 'connection'], (clientCtx) => {
      clientCtx.effect(() => clientCtx.webServer.register({
        kind: 'prefix',
        path: CLIENT_ROUTE_PREFIX,
        handler: createClientHandler({
          admit: (req) => clientCtx.connection.admit(req),
          getRowConfig: () => config,
          getRelayClient: () => relayClient,
          getIntercept: interceptDiagnostics,
        }),
      }), 'dsh-zen-remote: client routes')
    })
  }
  // Restart watcher (T17 + T17b), both roles: every Config field is volatile
  // (the settings surface would not exist otherwise), so the restart-required
  // fields are watched by fingerprint instead — when their resolved values
  // (row, lan-gate.config.json, or environment — all re-read per trigger)
  // move, the plugin row reloads through cordis and apply() runs again,
  // restarting the gateway child and push half with it. Two triggers share
  // the one fire-at-most-once guard: the 2s poll (the fallback for the
  // layers a settings save never touches — lan-gate.config.json and the
  // LAN_GATE_* / DSH_PUSH_* environment) and, immediately, the loader's
  // `loader/volatile-update` event: DSH 0.2.0 commits a volatile-only
  // settings change WITHOUT restarting the row and announces it on the row
  // context (`fiber.ctx.emit(self, "loader/volatile-update", paths)`, the
  // listener filter being `owner.fiber === fiber` — verified in
  // cordis-plugin-loader/lib/index.js of loader 1.0.5 / DSH 0.2.0-rc.1,
  // ~line 420). Subscribing here on the row context receives exactly this
  // row's updates, so a saved restart-required field reloads the row within
  // the same tick instead of waiting out the poll. ctx.fiber is the row's
  // own Fiber (cordis 4.0.4 assigns it in the Fiber constructor: `this.ctx =
  // parent.extend({ fiber: this })`), and restart() is its public
  // dispose-and-reload entry. A fake context without a fiber (the route
  // tests) only ever reaches the warn.
  const reload = (): void => {
    const fiber = (ctx as { fiber?: { restart?: () => Promise<unknown> } }).fiber
    if (fiber?.restart === undefined) {
      ctx.logger.warn('dsh-zen-remote: a restart-required setting changed, but no fiber is available to reload the plugin row')
      return
    }
    try {
      Promise.resolve(fiber.restart()).catch((error) => {
        ctx.logger.warn('dsh-zen-remote: plugin row reload failed: %s', message(error))
      })
    } catch (error) {
      ctx.logger.warn('dsh-zen-remote: plugin row reload failed: %s', message(error))
    }
  }
  ctx.effect(() => {
    const watcher = startRestartWatcher({
      getValues: () => resolveConfig(config, readFileConfig(), process.env).values,
      onChange: reload,
    })
    // Registration failure degrades to a warning, like the session feeds
    // above: the poll trigger keeps the watcher fully functional without it.
    try {
      ctx.on('loader/volatile-update', () => { watcher.checkNow() })
    } catch (error) {
      ctx.logger.warn('dsh-zen-remote: cannot listen on "loader/volatile-update": %s', message(error))
    }
    return watcher.stop
  }, 'dsh-zen-remote: restart watcher')
  // The upload route carries the T17 admission wall too: webServer routes
  // skip DSH's /api authentication, so without the connection service's
  // admit this 1.x-era route was the one unauthenticated write path left. A
  // composition without connection (Electron carries none) mounts nothing.
  // maxBytes is NOT captured here: `maxUploadBytes` is a volatile row field
  // ({ get() } wrapped), so the cap is re-read from the SAME row object per
  // request — an edit applies without waiting for a row reload. A stored
  // value that is not a positive finite number falls to the shipped default,
  // the same junk-in/shipped-default rule the keyboard knobs follow.
  ctx.inject(['webServer', 'sessions', 'connection'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: UPLOAD_ROUTE,
      handler: (req, res) => {
        const rawMax: unknown = unwrapVolatile(config.maxUploadBytes)
        const maxBytes = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
          ? rawMax
          : DEFAULT_MAX_UPLOAD_BYTES
        // Returned, not fire-and-forget: handleUpload owns res end to end,
        // and a rejection escaping it must reach webServer's unified error
        // handling instead of vanishing into an unhandled rejection (T17b
        // restored the await-shaped contract the route used to have).
        return handleUpload(
          webCtx,
          maxBytes,
          req,
          res,
          (admitReq) => webCtx.connection.admit(admitReq),
        )
      },
    }), 'dsh-mobile-nav: upload route')
  })
  // Needs only the webServer: the client-config route must exist even in a
  // composition without live sessions — and it is the settings page's
  // fallback role probe (T17): when the row snapshot cannot answer the saved
  // role (role only in lan-gate.config.json), this route reports the
  // EFFECTIVE one. Every displayed knob is re-read from the SAME row object
  // per request through unwrapVolatile, so an edit lands without waiting for
  // a row reload.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: CLIENT_CONFIG_ROUTE,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET')
          responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } })
          return
        }
        responseJson(res, 200, {
          role: resolveConfig(config, readFileConfig(), process.env).values.role,
          turnFoldDesktop: unwrapVolatile(config.turnFoldDesktop) === true,
          ...clamped('keyboardLiftRatio', unwrapVolatile(config.keyboardLiftRatio) as number | undefined, 0, 1),
          ...clamped('keyboardLiftMaxPx', unwrapVolatile(config.keyboardLiftMaxPx) as number | undefined, 0, 2000),
          ...clamped('keyboardSafetyPadPx', unwrapVolatile(config.keyboardSafetyPadPx) as number | undefined, 0, 200),
        })
      },
    }), 'dsh-mobile-nav: client config route')
  })
  // Share-image transcript route (issue #7): needs the sessionQuery service
  // every standard dsh-base composition provides, plus the connection
  // service for the T17 admission wall (same as the upload route: without
  // admit this 1.x-era route answered unauthenticated reads of any session's
  // transcript). Injected lazily like the routes above, so a composition
  // without them (Electron carries neither webServer nor sessionQuery)
  // simply never mounts the route — the browser half's fetch then 404s into
  // its "needs full DSH" message.
  ctx.inject(['webServer', 'sessionQuery', 'connection'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: SHARE_EXPORT_ROUTE,
      handler: (req, res) => handleShareExport(webCtx, req, res, (admitReq) => webCtx.connection.admit(admitReq)),
    }), 'dsh-mobile-nav: share export route')
  })
}
