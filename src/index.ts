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

import { createOwnerPeerSource, createSharedApiFetchGetter } from './owner-peer.js'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { homedir, networkInterfaces } from 'node:os'
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
import { readFileConfig, resolveConfig, unwrapVolatile, servesRole, connectsRole } from './config.js'
import { createActivityTracker, createParentIndex, seedParentIndexFromSnapshots, startSweeper, type PersistedSessionSnapshot } from './activity.js'
import { ADMIN_ROUTE_PREFIX, createAdminHandler } from './admin-routes.js'
import type { AdminHandlerOptions, SessionQueryLike } from './admin-routes.js'
import { CLIENT_ROUTE_PREFIX, createClientHandler } from './client-routes.js'
import { responseJson, sameOriginPost } from './http.js'
import { isBlankSession, isFirstTurnStart, onSessionCreated, restoreBusy } from './share-ops.js'
import type { AgentStatusLike, TurnBoundaryLike } from './share-ops.js'
import type { AdminAdmission } from './admin-routes.js'
import { startRestartWatcher } from './restart-watcher.js'
import { handleShareExport, SHARE_EXPORT_ROUTE } from './share-export.js'
import { createShareStore } from './share-store.js'
import { createRelayPool } from './relay-pool.js'
import { ensurePeerIdentity, readPeerNetwork } from './state-store.js'
import type { RelayPool } from './relay-pool.js'
import { createPeerEngine } from './peer/engine.js'
import type { PeerEngine } from './peer/engine.js'
import { volatileUpdateTouchesServerName } from './relay-client.js'
import type { RelayClient } from './relay-client.js'
import { computeFingerprints } from './fingerprint.js'
import { createLocalOnlyGateway, runSelfCheck, installIntercept } from './intercept.js'
import type { CurrentSessionRead, InterceptDiagnostics, InterceptHandle, SessionInventorySlot } from './intercept.js'
import { checkGatewayShape } from './intercept-shape.js'
import type { GatewayShapeCheck } from './intercept-shape.js'
import { checkFetchRouteShape, installFetchRouteIntercept, shouldFallbackInstall } from './fetch-route-intercept.js'
import type { FetchRouteInterceptDiagnostics, FetchRouteInterceptHandle, FetchRouteShapeCheck } from './fetch-route-intercept.js'
import { checkWebServerShape, installPluginRouteIntercept } from './plugin-route-intercept.js'
import type { PluginRouteInterceptDiagnostics, PluginRouteInterceptHandle, WebServerShapeCheck } from './plugin-route-intercept.js'
import { normalizeAdapter, adapterOwnsRegistryEntry } from './plugin-adapter-core.js'
import type { NormalizedAdapter } from './plugin-adapter-core.js'
import { ADAPTERS } from './adapters/index.js'
// PB-19: the better-sidebar surface extractor, a PURE utility inside the
// adapters directory — the one subdirectory import the wiring makes besides
// the ADAPTERS array (test/adapters-pluggable.test.cjs pins both to this
// file). The fs read that feeds it also lives HERE: nothing inside
// src/adapters/ touches the disk.
import { betterSidebarSurfaceDigest, extractBetterSidebarSurface, surfaceLooksHealthy } from './adapters/dsh-better-sidebar/surface.js'
import { createRelayHandler, loadServerId, RELAY_PREFIX, resolveDshVersion } from './relay-server.js'
import type { RelayGateway, RelayHandler } from './relay-server.js'
import { createBridgeRegistry, compareBridges } from './plugin-bridge.js'
import { createWizardHandler, WIZARD_ROUTE_PREFIX } from './wizard/routes.js'
import type { WizardHandlerOptions } from './wizard/routes.js'
import { createCaddyManager } from './wizard/caddy-process.js'
import type { SubprocessServiceLike } from './wizard/caddy-process.js'
import { cfTokenConfigured, deleteCfTokenFile, readCfTokenFile, writeCfTokenFile } from './wizard/token-store.js'
import { createCloudflaredManager, tunnelTokenConfigured } from './wizard/cloudflared.js'
import { checkDomainOnCloudflare as runTunnelCheck, setupTunnel } from './wizard/tunnel-orchestrator.js'
import { writeTunnelTokenFile } from './wizard/cloudflared.js'
import { detectForwardedSource, parseProxyList } from './wizard/source-detect.js'
import { createVerificationManager } from './wizard/verify.js'
import type { BridgeDeclaration, BridgeRegistry, BridgeStatus, ServerPluginEntry, ZenRemoteService } from './plugin-bridge.js'
import { createPluginLoopback } from './plugin-loopback.js'
import { createPluginTunnel } from './plugin-tunnel.js'
import { createLogRing, createPluginLog } from './log-ring.js'
import { DEFAULT_MAX_UPLOAD_BYTES } from './upload-limits.js'
import { applyUnshadowedRowKeys, clearUnshadowedRowKeys, writeCliConfig } from './cli/config-writer.js'
import { acquireCliIpcServer } from './cli/ipc-server.js'
import type { CliIpcDelegate, CliRouteHandler } from './cli/ipc-server.js'

// The plugin bridge's public types (PB-1), re-exported so another plugin's
// author can `import type { … } from 'dsh-zen-remote'` without reaching into
// lib/types. Type-only: no runtime code, no Context augmentation.
export type { BridgeDeclaration, ZenRemoteService } from './plugin-bridge.js'

// The loader's config schema (settings form) and the role normalizer live in
// src/config.ts next to the resolution they describe; re-exported so the
// plugin row's public surface stays on the main entry. The same-origin gate
// moved to src/http.ts next to the response envelope (T14) but its export
// stays here for scripts/check-upload-endpoint.mjs.
export { Config, resolveRole, servesRole, connectsRole } from './config.js'
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
 * This package's own version, read once off the package root (`../package.json`
 * resolves there both from src/ under the type-stripping scripts and from the
 * built lib/ in production). The debug report's `_meta` plate carries it —
 * issue triage starts at "which build is this" — and the row-apply log line
 * stamps it. Unreadable file degrades to `'unknown'`, never throws.
 */
let pluginVersion = 'unknown'
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
  if (typeof pkg?.version === 'string' && pkg.version !== '') pluginVersion = pkg.version
} catch { /* keep 'unknown' */ }

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

// The phone composer's default body cap lives in upload-limits.ts with the
// plugin's other upload numbers (the comment there spells out why this must
// stay phone-only and never size the relay); re-exported so the main entry's
// public surface keeps the name.
export { DEFAULT_MAX_UPLOAD_BYTES }

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

/** The live client-role relay client, if one was built. MS-5: the wiring no
 * longer builds one — the relay POOL below replaced it — so this stays
 * undefined in production compositions; the getter (and the client-routes
 * option of the same shape) remain for the single-client contract's old
 * consumers and tests. */
export function getRelayClient(): RelayClient | undefined {
  return clientRelayClient
}

/**
 * The client role's relay pool (MS-5), created inside apply() and kept on
 * the module so the debug-report wiring or a later half can reach it without
 * reaching into a context. Undefined on a pure host role (and in
 * compositions that never ran this module's apply), and — identity-guarded
 * in the disposal effect — after the row that owned a pool was unloaded or
 * reloaded (the T23a-fix discipline the relay client's slot always followed).
 */
let clientRelayPool: RelayPool | undefined

/** The live client-role relay pool, if one was built. */
export function getRelayPool(): RelayPool | undefined {
  return clientRelayPool
}

/**
 * The peer-role engine (PG-8), created inside apply() when the row's role is
 * `'peer'`: gateway WS control link, local TOFU anchoring, punch/mux paths
 * and the pool's virtual mounts all live behind it. Same slot discipline as
 * the pool — identity-guarded in the disposal effect, so a reloaded row
 * never leaves a stale engine here. Undefined on every other role.
 */
let livePeerEngine: PeerEngine | undefined

/** The live peer-role engine, if one was built. */
export function getPeerEngine(): PeerEngine | undefined {
  return livePeerEngine
}

/**
 * The plugin bridge's declaration registry (PB-1), created inside apply() on
 * BOTH roles and kept on the module so later tasks (the handshake's plugins
 * table, the client-side rewrite) can reach it without reaching into a
 * context. Undefined in compositions that never ran this module's apply, and
 * — identity-guarded below — after the row that owned a registry was
 * unloaded or reloaded, so a reloaded row never leaves a stale table where
 * the getter can hand it out (the T23a-fix discipline).
 */
let bridgeRegistry: BridgeRegistry | undefined

/** The live bridge registry, if a plugin row is currently applied. */
export function getBridgeRegistry(): BridgeRegistry | undefined {
  return bridgeRegistry
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
  await ensureSelfIgnoring(canonical)
  return canonical
}

/**
 * Drop a self-ignoring `.gitignore` (`*` + `!.gitignore`) next to the
 * upload directory's creation, so dropped files never surface as untracked
 * entries in the session workspace — an agent's `git add -A` would
 * otherwise commit the user's uploads. `wx` keeps a pre-existing
 * (user-customized) file untouched; in a non-git workspace the file is an
 * inert no-op. Best-effort only: a read-only directory still receives the
 * upload route's own error, never a new one from here.
 */
async function ensureSelfIgnoring(directory: string): Promise<void> {
  try {
    await writeFile(join(directory, '.gitignore'), '*\n!.gitignore\n', { flag: 'wx', mode: 0o644 })
  } catch (error) {
    if (!isErrnoCode(error, 'EEXIST') && !isErrnoCode(error, 'EROFS') && !isErrnoCode(error, 'EACCES')) throw error
  }
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
 * @param warn - where the rejection line goes. apply() passes its double-
 *   writer (context logger + the CU-1 log ring), so a rejected upload — the
 *   very path issue #49 is triaged on — shows up in the debug report. The
 *   ring is per-apply on purpose (a row reload clears it), which is why it
 *   arrives as a parameter instead of a module singleton. Defaults to the
 *   context logger for the direct-drive check scripts.
 */
export async function handleUpload(
  ctx: Context,
  maxBytes: number,
  req: IncomingMessage,
  res: ServerResponse,
  admit?: (req: IncomingMessage) => AdminAdmission,
  warn?: (format: string, ...args: unknown[]) => void,
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
    if (warn !== undefined) warn('dsh-mobile-nav upload rejected: %s', message(error))
    else ctx.logger.warn('dsh-mobile-nav upload rejected: %s', message(error))
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
  const initialHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  applyUnshadowedRowKeys(initialHome, config as Record<string, unknown>)
  // CU-1: the plugin's own log ring (SPEC 方案 C) — rebuilt per apply, so a
  // row reload clears it (expected: the report describes THIS process
  // generation). `logWarn` / `logInfo` are the branch-shared double-writers:
  // every line below reaches the context logger exactly as before and the
  // ring besides, so the debug report (CU-2) can answer "what did the plugin
  // actually log" without a log file (the desktop app writes none).
  const ring = createLogRing()
  const pluginLog = createPluginLog(ring, ctx.logger as Parameters<typeof createPluginLog>[1])
  const logWarn = pluginLog.warn
  const logInfo = pluginLog.info
  const effective = resolveConfig(config, readFileConfig(), process.env)
  // Lifecycle: the row came up. Role and both versions are the first things
  // an issue report needs.
  ring.push('info', 'row apply: role=%s plugin=%s dsh=%s', effective.values.role, pluginVersion, resolveDshVersion())
  // RD-6 probe fact: whether the fetch-route inject callback (below, in the
  // client-half wiring) ever fired. On a composition where `connection` or
  // `fileUploads` never becomes available the callback stays silently
  // PENDING (cordis waits forever, printing nothing) and every fetch-route
  // diagnostic stays undefined — this flag is the one honest signal of that
  // state. Declared this early because probes on BOTH role branches read it.
  let fetchRouteInjectSeen = false
  /** BU-1: how the fetch-route wrap got installed — `'inject'` via the
   * primary `ctx.inject` callback, `'fallback'` via the bounded lazy timer
   * below, `undefined` while not installed. Read live by the service probe. */
  let fetchRouteInstalledVia: 'inject' | 'fallback' | undefined
  /** BU-1: ISO timestamp of the moment a fallback attempt FAILED (shape
   * refused, original unresolvable) — the tick stops after one, so this is
   * also "the fallback gave up here". An install success does not set it. */
  let fetchRouteFallbackTriedAt: string | undefined
  /** The client branch's fetch-route diagnostics getter, assigned once that
   * branch declares it; the probe reads it lazily through this slot so both
   * role mounts can share one probe factory. */
  let fetchRouteDiagnosticsRef: (() => unknown) | undefined
  /** RD-6: build the lazy service probe against a context whose own inject
   * already resolved (the client-routes mounts qualify on both roles). One
   * reflection per process for the SERVICE PRESENCE facts (below); the
   * fetch-route facts are re-read live on every call — they change while the
   * page is open (the inject may fire, or the fallback may step in, long
   * after the first probe). */
  const uploadServiceProbe = (probeCtx: Context): (() => Record<string, unknown>) => {
    let cached: {
      connectionService: string
      fileUploadsService: string
      connectionShape?: FetchRouteShapeCheck
    } | undefined
    return () => {
      if (cached === undefined) {
        const reflect = (probeCtx as Context & { reflect?: { get(name: string): unknown } }).reflect
        const connection = reflect?.get('connection')
        const fileUploads = reflect?.get('fileUploads')
        cached = {
          connectionService: connection === undefined ? 'absent' : 'present',
          fileUploadsService: fileUploads === undefined ? 'absent' : 'present',
          ...(connection === undefined ? {} : { connectionShape: checkFetchRouteShape(connection) }),
        }
      }
      const fetchRoute = fetchRouteDiagnosticsRef?.()
      return {
        uploadInjectSeen: fetchRouteInjectSeen,
        installedVia: fetchRouteInstalledVia,
        ...(fetchRouteFallbackTriedAt === undefined ? {} : { fallbackTriedAt: fetchRouteFallbackTriedAt }),
        ...cached,
        ...(fetchRoute === undefined ? {} : { fetchRoute }),
      }
    }
  }
  // The plugin bridge's zenRemote service (PB-1), provided on BOTH roles
  // before any role branch: a plugin that wants its panel data forwarded in
  // remote sessions declares that against THIS process whichever role it
  // runs as, and the declaration registry is the one piece of PB-1 both the
  // server half (handshake plugins table) and the client half (route
  // rewrite) will read. ctx.provide (cordis 4) registers the service owned
  // by THIS row's fiber: visible to `inject(['zenRemote'])` dependents once
  // the row is active, withdrawn when the row unloads — so a composition
  // without zen-remote never fires those injects and a row reload swaps the
  // service wholesale. The registry goes into the module slot BEFORE the
  // provide so this apply's consumers never see a window without it; the
  // effect's identity guard then clears the slot exactly when THIS row
  // unloads (a reload installs the new registry before the old disposer
  // runs, same shape as clientRelayClient). provide() throwing is not worth
  // failing the row over — the bridge stays off, everything else keeps
  // working — so it degrades to a warning like the session feeds do.
  const registry = createBridgeRegistry({
    warn: (text) => { logWarn('dsh-zen-remote plugin bridge: %s', text) },
  })
  bridgeRegistry = registry
  try {
    const service: ZenRemoteService = {
      bridge: (declaration: BridgeDeclaration) => registry.register(declaration),
    }
    ctx.provide('zenRemote', service)
  } catch (error) {
    logWarn('dsh-zen-remote: cannot provide the "zenRemote" service: %s', message(error))
  }
  ctx.effect(() => () => {
    if (bridgeRegistry === registry) bridgeRegistry = undefined
  }, 'dsh-zen-remote: plugin bridge registry disposal')
  // The adapters (PB-11): each one registers ONLY against its target's
  // EXACT installed version, probed off the host's `pluginPackages` service
  // (`packageOf(name, ctx.baseUrl)` — verified on 0.2.0-rc.2 to answer
  // `{name, version, dir, …}` or undefined; any other shape, a missing
  // service or a probe failure reads as "not installed" and the adapter
  // stays out). PB-19 exception: a version OUTSIDE the list still registers
  // when the installed build's wire-surface digest (extracted here from its
  // lib/index.js, the wiring being the only place the feature touches the
  // disk) is whitelisted in the adapter's `surfaces` table — a wire-identical
  // patch release bridges without a zen-remote release, and every failure of
  // the extraction is logged apart from the digest-mismatch refusal. A plugin
  // that registers its OWN cooperative declaration always wins: the adapter
  // yields at registration time (logged), and the runtime re-checks the
  // registry digest on every request. Both roles run this loop — the registry
  // entries drive the handshake table, the bridge verdicts and the settings
  // listing on either side, while the returned array feeds the two request
  // halves.
  const adapters: NormalizedAdapter[] = []
  {
    const adapterWarn = (text: string): void => { logWarn('dsh-zen-remote adapter: %s', text) }
    for (const adapter of ADAPTERS) {
      try {
        const holder = ctx as unknown as { get?: (name: string) => unknown; baseUrl?: string }
        const packages = holder.get?.('pluginPackages') as { packageOf?: (specifier: string, parentURL: string) => unknown } | undefined
        const found = packages?.packageOf?.(adapter.plugin, holder.baseUrl ?? '') as { version?: unknown; dir?: unknown } | undefined
        const installedVersion = found !== null && typeof found === 'object' && typeof (found as { version?: unknown }).version === 'string'
          ? (found as { version: string }).version
          : undefined
        if (installedVersion === undefined || installedVersion === '') {
          adapterWarn(`${adapter.plugin}: target package (or its version) not found; not registered`)
          continue
        }
        // PB-19: a version outside the adapter's list gets ONE more chance —
        // its wire surface. Extract it, hash it, and let normalizeAdapter
        // judge the digest against the adapter's `surfaces` table. Anything
        // that goes wrong here leaves the digest undefined — the core then
        // refuses as a plain unlisted version, and the warns below name WHY
        // no digest was offered (no dir, unreadable file, lost dispatch
        // table), distinct from a digest that simply missed.
        const unlisted = !adapter.versions.includes(installedVersion)
        let surfaceDigest: string | undefined
        if (unlisted) {
          const dir = typeof found?.dir === 'string' && found.dir !== '' ? found.dir : undefined
          if (dir === undefined) {
            adapterWarn(`${adapter.plugin}: version ${installedVersion} is unlisted and packageOf gave no dir; no surface digest to offer`)
          } else {
            try {
              const surface = extractBetterSidebarSurface(readFileSync(join(dir, 'lib/index.js'), 'utf8'))
              if (!surfaceLooksHealthy(surface)) {
                adapterWarn(`${adapter.plugin}: surface extractor lost the dispatch table (${surface.methods.length} methods) — treating as unknown surface`)
              } else {
                surfaceDigest = betterSidebarSurfaceDigest(surface)
              }
            } catch (error) {
              adapterWarn(`${adapter.plugin}: cannot read ${join(dir, 'lib/index.js')} for a surface digest: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
        const normalized = normalizeAdapter(adapter, installedVersion, surfaceDigest === undefined ? undefined : { surfaceDigest })
        if (registry.get(normalized.plugin) !== undefined) {
          adapterWarn(`${normalized.plugin}: the plugin registers its own bridge declaration; the adapter yields`)
          continue
        }
        registry.registerNormalized(normalized.declaration)
        adapters.push(normalized)
        if (unlisted && surfaceDigest !== undefined) {
          logInfo('dsh-zen-remote adapter: %s bridged by surface digest %s (version %s unlisted)', normalized.plugin, surfaceDigest, installedVersion)
        } else {
          logInfo('dsh-zen-remote adapter: %s adapted at version %s', normalized.plugin, installedVersion)
        }
      } catch (error) {
        adapterWarn(`${adapter.plugin} refused: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  // CU-3: the debug-report route's profile fact — read per call through the
  // reflection layer's store lookup (a composition without profileContext
  // answers undefined, and a throwing read degrades to undefined too).
  const profileName = (): string | undefined => {
    try {
      const holder = ctx as unknown as { get?: (name: string) => unknown }
      const profile = holder.get?.('profileContext') as { name?: unknown } | undefined
      return typeof profile?.name === 'string' && profile.name !== '' ? profile.name : undefined
    } catch {
      return undefined
    }
  }
  // MS-5: the two role halves are INDEPENDENT branches now, not an either/or
  // — a future 'peer' deploy (servesRole AND connectsRole both true) runs
  // both; host runs only the serving half; client only the dialing half.
  // CLI-1: the row-scoped pieces the CLI IPC delegate forwards to. The role
  // branches fill the slots they own; the restart-watcher effect at the
  // bottom hands them to acquireCliIpcServer as ONE delegate, whose release
  // rides the same effect (role-wiring pins the top-level effect counts, so
  // the IPC lifecycle may not register its own).
  const noopAdmit: (req: IncomingMessage) => AdminAdmission = () => ({ peer: {} })
  const reflectNow = (): { get(name: string): unknown } | undefined =>
    (ctx as Context & { reflect?: { get(name: string): unknown } }).reflect
  let cliWizardHandler: CliRouteHandler | undefined
  let cliAdminHandler: CliRouteHandler | undefined
  let cliClientHandler: CliRouteHandler | undefined
  let reportedBrowserLang: 'zh' | 'en' | undefined
  const resolveActiveLang = (): 'zh' | 'en' => {
    const cfg = resolveConfig(config, readFileConfig(), process.env).values.lang
    if (cfg === 'en') return 'en'
    if (cfg === 'zh') return 'zh'
    if (reportedBrowserLang !== undefined) return reportedBrowserLang
    return 'zh'
  }
  /** The managed ingress children THIS row generation owns (host branch
   * only): the restart-watcher disposer stops them, which is the ONLY stop
   * on compositions without a webServer (there the wizard effect — the
   * historic owner of the stop — never fires). */
  const cliManagedChildren: Array<{ stop(): void }> = []
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  // PG-8: the peer role runs BOTH halves, so the connects branch needs two
  // facts the serves branch owns — the relay secret (the marking header the
  // mux stamps onto every inbound virtual request) and the live relay
  // handler (the inbound end of the mux). Slots only; peer wiring reads them
  // through getters so a not-yet-mounted handler answers undefined.
  let servingRelaySecret: string | undefined
  let servingRelayHandler: RelayHandler | undefined
  let servingGatewaySummary: (() => Promise<Record<string, unknown>>) | undefined
  const pluginLoopbackSecret = randomBytes(32).toString('hex')
  const effectivePluginConsent = (): Record<string, boolean> => {
    const resolved = resolveConfig(config, readFileConfig(), process.env)
    const rawConsent = resolved.values.pluginBridgeConsent
    if (resolved.values.role !== 'peer') return rawConsent
    const merged: Record<string, boolean> = { ...rawConsent }
    for (const declaration of registry.list()) {
      if (!(declaration.plugin in merged)) merged[declaration.plugin] = true
    }
    return merged
  }
  if (servesRole(effective.values.role)) {
    // A row that switched from client to host must not leave a stale relay
    // client where getRelayClient() can find it (T23a-fix) — and no stale
    // pool either where getRelayPool() can (MS-5; a peer row rebuilds its
    // pool right after, this block having only cleared the previous
    // generation's slot).
    clientRelayClient = undefined
    clientRelayPool = undefined
    // The relay shared secret (T22a): minted fresh per apply, handed to the
    // gateway child through LAN_GATE_RELAY_SECRET and kept here for the
    // relay routes below. The push half never sees it.
    const relaySecret = randomBytes(32).toString('hex')
    // PG-8: the peer half stamps this secret onto every mux-inbound request.
    servingRelaySecret = relaySecret
    // CU-1 lifecycle: the gateway child's spawn/exit, reported back through
    // this hook (lan-gate.mjs reads it off the config object it is handed).
    // The child runs in a subprocess whose console the ring cannot see, so
    // these two lines are the debug report's only record of it. Either call
    // must never break the gateway half — lan-gate.mjs guards its side, we
    // guard ours. The hook rides as a NON-enumerable property: it is wiring,
    // not configuration — the gateway's config stays exactly "resolved values
    // + relaySecret" for every spread, deep compare and serialization (the
    // role-wiring test pins that shape), while a direct read still finds it.
    const gatewayEvent = (event: 'spawn' | 'exit', detail: Record<string, unknown>): void => {
      try {
        if (event === 'spawn') ring.push('info', 'gateway spawned (port=%s)', String(detail.port ?? '?'))
        else ring.push('warn', 'gateway exited (code=%s signal=%s error=%s)', String(detail.code ?? '—'), String(detail.signal ?? '—'), String(detail.error ?? '—'))
      } catch { /* the ring must never break the wiring */ }
    }
    const gatewayConfig: Record<string, unknown> = { ...effective.values, relaySecret }
    Object.defineProperty(gatewayConfig, 'gatewayEvent', { value: gatewayEvent, enumerable: false })
    ctx.plugin(gateway, gatewayConfig)
    ctx.plugin(push, effective.values)
    // The shared-session table backing the relay's access control. The relay
    // route consumes it below; the activity tracker and idle sweeper (T22c)
    // keep its "quiet for idleHours → close" promise. The settings surface is
    // a later task. (`home` is hoisted to apply() level — the CLI IPC
    // delegate binds its socket under the same directory.)
    // MS-1: the table now lives INSIDE the three-in-one state file (alongside
    // the server identity and the paired-servers list); share-store's loader
    // migrates a legacy zen-remote-shares.json in and every write preserves
    // the other two top-level fields.
    const store = createShareStore({
      file: join(home, 'zen-remote-state.json'),
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
    // Track sessions explicitly unshared by a user or client during this row's
    // lifetime so the `turn/start` (turn 1) fallback for `reuseLive` blank
    // sessions never overrides an intentional manual unshare before Turn 1.
    const manuallyUnshared = new Set<string>()
    store.subscribe((ev) => {
      if (ev.type === 'shared') manuallyUnshared.delete(ev.sessionId)
      else if (ev.type === 'unshared' && (ev.reason === 'manual' || ev.reason === 'client')) {
        manuallyUnshared.add(ev.sessionId)
      }
    })
    try {
      ctx.on('session/event', (session, event) => {
        // Record the parent link BEFORE tracking, so a child's very first
        // event already reaches its ancestors.
        parentIndex.observe(session)
        const sessionId: unknown = session?.id
        if (typeof sessionId !== 'string' || sessionId === '') return
        // When `session/create` reuses a blank session that was ALREADY live
        // in memory (`reuseLive`), DSH emits no `agent/created`. If that blank
        // session was not shared (e.g. `autoShareNewSessions` was turned on
        // after it was pre-created, or its idle window expired in memory) and
        // was not manually unshared while blank, share it as Turn 1 starts so
        // `tracker.onEvent` right below marks it busy too.
        if (isFirstTurnStart(session, event) && !manuallyUnshared.has(sessionId) && !store.isShared(sessionId)) {
          try {
            onSessionCreated(session.header, {
              store,
              autoShare: resolveConfig(config, readFileConfig(), process.env).values.autoShareNewSessions,
              parentOf: parentIndex.parentOf,
            })
          } catch (error) {
            logWarn('dsh-zen-remote cannot share new session "%s": %s', sessionId, message(error))
          }
        }
        tracker.onEvent(sessionId, event.type)
      })
    } catch (error) {
      logWarn('dsh-zen-remote cannot listen on "session/event": %s', message(error))
    }
    // Auto-share and fork-following (T33a), off `agent/created`. Its `source`
    // is 'startup' for fresh creation (top-level, fork and subagent all go
    // through the same factory call) and 'resume' when a persisted session
    // re-enters the live store. DSH's "New Session" (`createInWorkspace` →
    // `session/create`) reuses persisted blank sessions (zero turns ever
    // started) via `agents.resume`, which arrives with `source === 'resume'`;
    // `isBlankSession` lets those reclaimed placeholders auto-share while
    // keeping established conversations closed across reopens.
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
          // PB-26a: record the subagent→parent link the moment the child
          // exists — for EVERY source. A sidechat child (better-sidebar's
          // sidechat.start → agents.create) rides no workspace and writes
          // no catalog; until its first session/event the index knew
          // nothing of it, so the relay answered not-shared for a session
          // whose share it inherits through its parent, and the forwarded
          // status frames the client needs to announce the row never left.
          parentIndex.observe(agent.session)
          const turnBoundaryOf = (s: unknown): TurnBoundaryLike | undefined => {
            const ag = reflectNow()?.get('agents') as { turnBoundaryOf?: (sess: unknown) => TurnBoundaryLike } | undefined
            return typeof ag?.turnBoundaryOf === 'function' ? ag.turnBoundaryOf(s) : undefined
          }
          if (source !== 'startup' && !(source === 'resume' && isBlankSession(agent.session, turnBoundaryOf))) return
          if (typeof agent.id === 'string') manuallyUnshared.delete(agent.id)
          onSessionCreated(agent.session.header, {
            store,
            autoShare: resolveConfig(config, readFileConfig(), process.env).values.autoShareNewSessions,
            parentOf: parentIndex.parentOf,
          })
        } catch (error) {
          logWarn('dsh-zen-remote cannot share new session "%s": %s', agent.id, message(error))
        }
      })
    } catch (error) {
      logWarn('dsh-zen-remote cannot listen on "agent/created": %s', message(error))
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
    // Restart repair (2026-10-13): the parent index rebuilds only from LIVE
    // session/event traffic, so after a host restart every already-stored
    // sidechat / subagent child lost its parent link and the relay answered
    // `not-shared` for a session whose share it used to inherit through the
    // ancestor chain. Seed the index once from the persistence service's
    // snapshot list — headers only, event logs are never read.
    try {
      ctx.inject(['sessionPersistence'], (persistenceCtx) => {
        const persistence = (persistenceCtx as Context & {
          sessionPersistence?: { list(): Promise<readonly PersistedSessionSnapshot[]> } | undefined
        }).sessionPersistence
        if (persistence === undefined) {
          logWarn('dsh-zen-remote: no sessionPersistence service — pre-restart subagent sessions stay not-shared until they emit an event')
          return
        }
        void persistence
          .list()
          .then((snapshots) => {
            const recorded = seedParentIndexFromSnapshots(parentIndex, snapshots)
            if (recorded > 0) logInfo('dsh-zen-remote: restored %d persisted parent links', recorded)
          })
          .catch((error: unknown) => logWarn('dsh-zen-remote cannot seed parent links from persisted sessions: %s', message(error)))
      })
    } catch (error) {
      logWarn('dsh-zen-remote cannot listen on "sessionPersistence": %s', message(error))
    }
    // CLI-1: the managed-ingress machinery MOVED OUT of the wizard route's
    // inject so the CLI IPC delegate shares ONE set of managers / handler
    // options with the browser routes (same caddyManager, same
    // cloudflaredManager, same verification session, same relay store). The
    // subprocess service is read the lazy way — off the reflection layer,
    // which answers undefined on compositions without it — so the wizard
    // options simply degrade to their 501 placeholders there.
    const getConfig = (): ReturnType<typeof resolveConfig> => resolveConfig(config, readFileConfig(), process.env)
    const subprocessService = reflectNow()?.get('subprocess') as SubprocessServiceLike | undefined
    const caddyManager = subprocessService === undefined ? undefined : createCaddyManager({ subprocess: subprocessService, dshHome: home })
    const cloudflaredManager = subprocessService === undefined ? undefined : createCloudflaredManager({ subprocess: subprocessService, dshHome: home })
    for (const child of [caddyManager, cloudflaredManager]) {
      if (child !== undefined) cliManagedChildren.push(child)
    }
    // The verification session lives in THIS manager set's closure (GW-9):
    // memory-only by design, and a row reload rebuilds it — the same
    // "stale" verdict the config fingerprint produces, arriving via the
    // process generation instead.
    const currentMode = (): string => getConfig().values.ingressMode
    const detectLanCandidates = (): { ip: string; kind: 'tailscale' | 'lan'; iface: string }[] => {
      try {
        const nets = networkInterfaces()
        const tailscale: { ip: string; kind: 'tailscale' | 'lan'; iface: string }[] = []
        const primaryLan: { ip: string; kind: 'tailscale' | 'lan'; iface: string }[] = []
        const bridgeLan: { ip: string; kind: 'tailscale' | 'lan'; iface: string }[] = []
        for (const [iface, entries] of Object.entries(nets)) {
          if (!Array.isArray(entries)) continue
          const isContainerBridge = /^(?:docker\d*|br-|veth|cni\d*|flannel|virbr\d*|cali)/i.test(iface)
          for (const entry of entries) {
            if (!entry || entry.internal || entry.family !== 'IPv4') continue
            const addr = entry.address
            if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr)) {
              tailscale.push({ ip: addr, kind: 'tailscale', iface })
            } else if (
              /^192\.168\./.test(addr)
              || /^10\./.test(addr)
              || /^172\.(?:1[6-9]|2\d|3[01])\./.test(addr)
            ) {
              if (isContainerBridge) bridgeLan.push({ ip: addr, kind: 'lan', iface })
              else primaryLan.push({ ip: addr, kind: 'lan', iface })
            }
          }
        }
        return [...tailscale, ...primaryLan, ...bridgeLan]
      } catch {
        return []
      }
    }
    // One runtime probe per request: the gateway's own status (source-IP
    // detection + the ACTUAL port for snippets/QR), plus our processes'
    // liveness for the projection.
    const buildRuntime = async () => {
      const lanAddresses = detectLanCandidates()
      const lanAddress = (lanAddresses.find((c) => c.kind === 'lan') ?? lanAddresses[0])?.ip
      try {
        const response = await fetch(`http://127.0.0.1:${effective.values.port}/lan-gate/status`, { signal: AbortSignal.timeout(3000) })
        if (!response.ok) return { caddyRunning: caddyManager?.isRunning() === true, lanAddress, lanAddresses }
        const body = (await response.json()) as { host?: unknown; port?: unknown; lastForwardedSource?: unknown }
        return {
          lastForwardedSource: detectForwardedSource(body),
          // GW-fix-3/M2: the wizard's snippets and QR target the
          // gateway's ACTUAL port (it may have retried past the
          // configured one).
          gatewayActualPort: typeof body?.port === 'number' ? body.port : undefined,
          gatewayActualHost: typeof body?.host === 'string' ? body.host : undefined,
          lanAddress,
          lanAddresses,
          caddyRunning: caddyManager?.isRunning() === true,
          cloudflaredRunning: cloudflaredManager?.isRunning() === true,
          tunnelTokenConfigured: cloudflaredManager !== undefined,
          cfTokenConfigured: cfTokenConfigured(home),
        }
      } catch {
        // No answer is no detection — the status projection renders
        // its null shape and the UI offers nothing.
        return {
          lanAddress,
          lanAddresses,
          caddyRunning: caddyManager?.isRunning() === true,
          cloudflaredRunning: cloudflaredManager?.isRunning() === true,
          tunnelTokenConfigured: tunnelTokenConfigured(home),
          cfTokenConfigured: cfTokenConfigured(home),
        }
      }
    }
    const verification = createVerificationManager({
      gatewayBase: `http://127.0.0.1:${effective.values.port}`,
      getValues: () => getConfig().values,
      // runtimeReady now covers the managed paths: Caddy must actually be
      // alive; cloudflared arrives with GW-13b; the external path has no
      // process of ours to wait for.
      runtimeReady: () => {
        const mode = currentMode()
        if (mode === 'caddy') return caddyManager?.isRunning() === true
        if (mode === 'cloudflared') return cloudflaredManager?.isRunning() === true
        return true
      },
    })
    const wizardOptionsFor = (admit: (req: IncomingMessage) => AdminAdmission): WizardHandlerOptions => ({
      admit,
      getConfig,
      tokenStore: {
        writeCfToken: (token) => { writeCfTokenFile(home, token) },
        deleteCfToken: () => {
          // Stop the consumers first (the mode-switch rule): whichever
          // process might hold the token in its environment dies before
          // the file disappears.
          caddyManager?.stop()
          cloudflaredManager?.stop()
          deleteCfTokenFile(home)
        },
        cfTokenConfigured: () => cfTokenConfigured(home),
        writeTunnelToken: (token) => { writeTunnelTokenFile(home, token) },
      },
      ...(caddyManager === undefined ? {} : {
        caddy: {
          start: async (input: { domain: string; httpsPort: number; gatewayPort: number }) => {
            // 模式切换：starting managed Caddy stops any running cloudflared tunnel first,
            // and restarts Caddy if it was already running with an older config.
            cloudflaredManager?.stop()
            if (caddyManager.isRunning()) caddyManager.stop()
            // The token rides the child env only — read from the store
            // inside the wiring, never through a route payload.
            const token = readCfTokenFile(home)
            if (token === undefined) return { ok: false as const, error: 'missing-token' as const }
            return caddyManager.start({ ...input, cfToken: token })
          },
          stop: () => caddyManager.stop(),
          status: () => (caddyManager.isRunning() ? 'running' as const : caddyManager.hasStarted() ? 'stopped' as const : 'never-started' as const),
        },
      }),
      ...(cloudflaredManager === undefined ? {} : {
        tunnel: {
          checkDomain: (domain: string) => runTunnelCheck(
            { readToken: () => readCfTokenFile(home) },
            domain,
          ),
          setup: (input: { domain: string; tunnelId?: string }) => setupTunnel(
            {
              dshHome: home,
              readToken: () => readCfTokenFile(home),
              gatewayPort: async () => {
                // The ingress service target is the gateway's ACTUAL
                // port — same fallback as the caddy start route: probe
                // /lan-gate/status first, fall back to the configured
                // port when it does not answer (GW-fix-4/M2).
                try {
                  const response = await fetch(`http://127.0.0.1:${getConfig().values.port}/lan-gate/status`, { signal: AbortSignal.timeout(3000) })
                  if (response.ok) {
                    const body = (await response.json()) as { port?: unknown }
                    if (typeof body?.port === 'number') return body.port
                  }
                } catch { /* fall through to the configured port */ }
                return getConfig().values.port
              },
              cloudflared: {
                start: async (startInput: { tunnelToken: string }) => {
                  if (cloudflaredManager.isRunning()) cloudflaredManager.stop()
                  const started = await cloudflaredManager.start({ tunnelToken: startInput.tunnelToken })
                  return started.ok ? ({ ok: true } as const) : ({ ok: false, error: started.error ?? 'spawn-failed' } as const)
                },
                // 模式切换：starting the tunnel stops the managed Caddy.
                stopCaddy: () => caddyManager?.stop(),
              },
            },
            input,
          ),
          stop: () => cloudflaredManager.stop(),
          status: () => (cloudflaredManager.isRunning() ? 'running' as const : cloudflaredManager.hasStarted() ? 'stopped' as const : 'never-started' as const),
        },
      }),
      verify: { start: (input) => verification.start(input), check: () => verification.check() },
      getRuntime: () => buildRuntime(),
      trustProxy: {
        resolved: () => {
          const snapshot = resolveConfig(config, readFileConfig(), process.env)
          return { value: snapshot.values.trustedProxies, source: snapshot.sources.trustedProxies }
        },
        write: async (expected, list) => {
          const file = join(home, 'lan-gate.config.json')
          const current = readFileConfig()
          // Concurrent-write guard (GW-fix-2/L2): the route resolved
          // the list moments ago; if the file layer moved since (a
          // parallel trust click, a hand edit), refuse instead of
          // clobbering the other writer's entry. Both sides compare
          // normalized so an illegal file value reads as "empty", the
          // same thing resolveConfig saw.
          const now = typeof current.trustedProxies === 'string' ? current.trustedProxies : ''
          if (parseProxyList(now).join(',') !== parseProxyList(expected).join(',')) return false
          const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
          await writeFile(tmp, `${JSON.stringify({ ...current, trustedProxies: list }, null, 2)}\n`, { mode: 0o600 })
          await rename(tmp, file)
          return true
        },
      },
    })
    const adminOptionsFor = (admit: (req: IncomingMessage) => AdminAdmission): AdminHandlerOptions => ({
      admit,
      gatewayBase: `http://127.0.0.1:${effective.values.port}`,
      getConfig,
      // Shares routes (T33a): the table above is the truth they serve and
      // mutate. typertGateway and agents are deliberately NOT declared in
      // any inject — adding them would keep the WHOLE admin prefix off
      // 0.1.7 / Electron compositions that lack them — so they are read PER
      // REQUEST through the reflection layer's store lookup (runtime
      // `ctx.get`, declared `ctx.reflect.get`), which answers undefined
      // when the service is absent. Property access is not an option:
      // cordis refuses reads of services the context did not declare
      // (`cannot get property … without inject`), which would turn every
      // shares request into a 500.
      store,
      typert: () => {
        const g = reflectNow()?.get('typertGateway') as RelayGateway | undefined
        return g !== undefined ? createLocalOnlyGateway(g) : undefined
      },
      getPeer: createOwnerPeerSource(() => reflectNow()?.get('connection')),
      listAgents: () => (reflectNow()?.get('agents') as { list(): readonly AgentStatusLike[] } | undefined)?.list() ?? [],
      // The "who is looking" badge (T33a2): read through whichever relay
      // handler is live right now. sessionQuery likewise — the share
      // action reads the durable session header through it to judge
      // subagent sessions, degrading to the projection identity when the
      // composition lacks the service.
      viewerCount: (id: string) => relayHandler?.viewerCount(id) ?? 0,
      sessionQuery: () => reflectNow()?.get('sessionQuery') as SessionQueryLike | undefined,
      // The plugin bridge listing (PB-5): the SAME registry this apply
      // built and the SAME live consent reader the relay's plugins table
      // uses — one source of truth per question. PB-11: the listing
      // marks the plugins an adapter stands in for (live — a plugin
      // that registered its own declaration stops being marked).
      pluginBridge: {
        registry,
        getConsent: effectivePluginConsent,
        adaptedPlugins: () => new Set(adapters.filter((adapter) => adapterOwnsRegistryEntry(adapter, registry.get(adapter.plugin))).map((adapter) => adapter.plugin)),
      },
    })
    // The CLI IPC delegate's OWN handler instances (CLI-1): same options,
    // same managers, same verification session as the browser routes below
    // — only the admit differs, because the request arrived over the 0600
    // socket (same user, same machine) instead of DSH's cookie wall.
    cliAdminHandler = createAdminHandler(adminOptionsFor(noopAdmit))
    cliWizardHandler = createWizardHandler(wizardOptionsFor(noopAdmit))

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
        handler: createAdminHandler(adminOptionsFor((req) => webCtx.connection.admit(req))),
      }), 'dsh-zen-remote: admin routes')
    })
    // Gateway-wizard routes (GW-4, extended by GW-5): a separate LONGEST-
    // prefix registration under the admin prefix — the host web server
    // matches the longest prefix first, so /admin/wizard/* lands here and
    // everything else stays with the admin handler above. Same host-only
    // gate and admit wall; the wizard handler applies its own via-marker
    // and same-origin walls to every route. The runtime probe reads the
    // gateway's own /lan-gate/status for the untrusted-proxy detection
    // (read-only, best-effort); the trust-proxy persister merges into the
    // FILE layer of lan-gate.config.json — the only writable config surface
    // the plugin owns — which the restart watcher's poll picks up and
    // reloads the row from (trustedProxies is a restart field), restarting
    // the gateway with the new trust list. When the resolved value comes
    // from env or the row the route refuses instead: a file-layer write
    // would be shadowed there. (CLI-1: the managers and the handler options
    // moved OUT of this inject to apply() level — see wizardOptionsFor —
    // so the CLI IPC delegate drives the SAME manager set; this effect only
    // registers the route and stops the children with the row.)
    ctx.inject(['webServer', 'connection'], (wizardCtx) => {
      wizardCtx.effect(() => {
        const unregister = wizardCtx.webServer.register({
          kind: 'prefix',
          path: WIZARD_ROUTE_PREFIX,
          handler: createWizardHandler(wizardOptionsFor((req) => wizardCtx.connection.admit(req))),
        })
        // H1: the row's disposal must not orphan the managed children — the
        // Caddy/cloudflared processes die WITH the row that spawned them,
        // before the route registration unregisters.
        return () => {
          caddyManager?.stop()
          cloudflaredManager?.stop()
          unregister()
        }
      }, 'dsh-zen-remote: wizard routes')
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
      // T41b: the `/api` shared-fetch dispatcher, probed PER REQUEST through
      // the reflection layer (the same discipline as the admin routes'
      // typertGateway: adding `connection` to the inject list would keep the
      // whole relay prefix off compositions that lack the service). The
      // connection service's `createSharedFetchHandler('/api').fetch` is the
      // in-process entry to the same exact-fetch route table the browser
      // `/api` transport dispatches through (RT dsh-client-connection
      // lib/index.js ~608-637 — pathname + method lookup over `fetchRoutes`,
      // the registry dsh-client-ui-deliverables' changes routes register
      // into), so a synthetic Request reaches the serving functions directly:
      // no loopback HTTP, no login state. A composition without the service
      // answers the relay route 501 instead. DSH 0.2.1-rc.3: the handler's
      // fetch takes the requesting Peer as a second argument and refuses
      // everything but the owner (a missing peer there throws TypeError,
      // surfacing as a 502 on every relayed /api call) — the dispatcher
      // forwards the cached owner Peer below; pre-rc.3 hosts ignore it.
      const relayPeer = createOwnerPeerSource(() => relayCtx.reflect.get('connection'))
      const getApiFetch = createSharedApiFetchGetter(() => relayCtx.reflect.get('connection'), relayPeer)
      relayCtx.effect(() => {
        // The plugin bridge's loopback facts (PB-3), both read PER REQUEST
        // through the reflection layer: the web server may have restarted on
        // another port or protocol, and the connection service's
        // authenticatedUrl — the token-exchange entry the lan-gate wiring
        // also reads (0.1.1 hosts lack the method entirely) — lives on a
        // service deliberately NOT in this inject's declaration list (same
        // reason as getApiFetch above: adding it would keep the whole relay
        // prefix off compositions that lack it).
        const getLoopbackTarget = () => {
          const webServer = relayCtx.reflect.get('webServer') as { protocol?: unknown; port?: unknown } | undefined
          const port = typeof webServer?.port === 'number' && webServer.port > 0 ? webServer.port : undefined
          if (port === undefined) throw new Error('the web server exposes no loopback port')
          return { protocol: webServer?.protocol === 'https:' ? ('https:' as const) : ('http:' as const), port }
        }
        const getTokenUrl = () => {
          const connection = relayCtx.reflect.get('connection') as
            | { authenticatedUrl?: (base: string) => string | undefined }
            | undefined
          if (typeof connection?.authenticatedUrl !== 'function') return undefined
          const { protocol, port } = getLoopbackTarget()
          return connection.authenticatedUrl(`${protocol}//127.0.0.1:${port}`)
        }
        // One loopback executor for BOTH plugin halves (the HTTP forward and
        // the PB-10 tunnel): a single cookie cache behind two consumers.
        const pluginLoopback = createPluginLoopback({ getTarget: getLoopbackTarget, getTokenUrl, loopbackSecret: pluginLoopbackSecret })
        const pluginConsent = effectivePluginConsent
        const handler = createRelayHandler({
          secret: relaySecret,
          store,
          gateway: createLocalOnlyGateway(gatewayService),
          getApiFetch,
          // DSH 0.2.1-alpha.3: one cached owner/answer Peer for every relay
          // gateway call — `$events/result` must come from the Peer that
          // opened `$events`.
          getPeer: relayPeer,
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
            // The server's interface fingerprints (T42): recomputed at EVERY
            // handshake, deliberately uncached — the typert loader registers
            // package by package asynchronously, so a client that
            // auto-reconnects right after a server restart would otherwise
            // handshake a half-empty registry and pin those throwaway values
            // for the row's lifetime. ~7 ms per computation against a full
            // registry; a failed compute lands as the empty map inside the
            // relay handler's own guard.
            fingerprints: () => computeFingerprints(relayCtx),
            // PB-2: the plugin bridge table, rebuilt FRESH at every handshake
            // from the PB-1 registry and the row's consent map — both live:
            // the registry through this apply's own closure, the consent
            // through resolveConfig on the SAME row object (a volatile field,
            // read at use time per the hard constraint, never snapshotted).
            plugins: () => {
              const consent = pluginConsent()
              const table: Record<string, ServerPluginEntry> = {}
              for (const declaration of registry.list()) {
                table[declaration.plugin] = {
                  version: declaration.version,
                  digest: declaration.digest,
                  serverScopeConsent: consent[declaration.plugin] === true,
                }
              }
              return table
            },
          },
          // PB-3: the forwarding half of the plugin bridge — the registry
          // this apply built (the zenRemote service's table), the consent
          // map read LIVE per request (a volatile row field), and the
          // loopback executor over the wiring's two reflection getters.
          // PB-10: the WebSocket byte tunnel's server half shares the SAME
          // loopback (one cookie cache) and the same live consent; its
          // reachability judgment rides the store directly (the handler's
          // own isAccessible closure is not visible out here).
          pluginBridge: {
            registry,
            getConsent: pluginConsent,
            loopback: pluginLoopback,
            adapters,
            tunnel: createPluginTunnel({
              bridge: { registry, getConsent: pluginConsent, loopback: pluginLoopback },
              getTarget: getLoopbackTarget,
              isAccessible: (sessionId) => store.isAccessible(sessionId, parentIndex.parentOf),
              heartbeatMs: 15_000,
              loopbackSecret: pluginLoopbackSecret,
            }),
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
        // PG-8: the mux's inbound end — same handler, same lifetime.
        servingRelayHandler = handler
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
          if (servingRelayHandler === handler) servingRelayHandler = undefined
        }
      }, 'dsh-zen-remote: relay route')
    })
    // CU-3 (host mount): the gateway child's summary plate for the debug
    // report — one best-effort probe of the gateway's own status endpoint
    // (the same seam the wizard's runtime probe reads) reduced to liveness,
    // port and COUNTS. The endpoint's device rows carry no tokens and we
    // keep none of their fields anyway; the share table's size is read off
    // the store this apply owns. The gateway being down IS the summary.
    const gatewaySummary = async (): Promise<Record<string, unknown>> => {
      let reachable = false
      let port: number | undefined
      let deviceCount: number | undefined
      let pushSubscriptions: number | undefined
      try {
        const response = await fetch(`http://127.0.0.1:${effective.values.port}/lan-gate/status`, { signal: AbortSignal.timeout(3000) })
        reachable = response.ok
        if (reachable) {
          const body = await response.json() as { port?: unknown; devices?: unknown; pushSubscriptions?: unknown }
          if (typeof body?.port === 'number') port = body.port
          if (Array.isArray(body?.devices)) deviceCount = body.devices.length
          if (typeof body?.pushSubscriptions === 'number') pushSubscriptions = body.pushSubscriptions
        }
      } catch { /* unreachable is an honest answer */ }
      return {
        reachable,
        ...(port === undefined ? {} : { port }),
        ...(deviceCount === undefined ? {} : { deviceCount }),
        ...(pushSubscriptions === undefined ? {} : { pushSubscriptions }),
        shareCount: store.list().length,
      }
    }
    servingGatewaySummary = gatewaySummary
    // The remote-status route lives on BOTH roles (T34-fix): it is what the
    // client-half parts poll, and a desktop app can switch roles without a
    // code path change — on a host it reads the empty
    // `{state:'unpaired', versionMismatch:false, …}` conclusion. The rest of
    // the client prefix does NOT (T41a-fix2): claim / status / reconnect /
    // unshare exist for a client role's pairing surface, and a host answers
    // them 404 (least exposure — the prefix registration stays one route,
    // the handler just refuses everything but remote-status). Same admission
    // wall as the client role's mount.
    // Peer role ALSO enters `connectsRole` below, which owns the full client
    // prefix (`peer/*` included) — registering here too would throw duplicate
    // prefix route on dsh-host-webserver and leave `remoteStatusOnly` masking
    // every `/client/peer/*` request with 404 `not-found`.
    if (!connectsRole(effective.values.role)) {
      ctx.inject(['webServer', 'connection'], (clientCtx) => {
        clientCtx.effect(() => clientCtx.webServer.register({
          kind: 'prefix',
          path: CLIENT_ROUTE_PREFIX,
          handler: createClientHandler({
            admit: (req) => clientCtx.connection.admit(req),
            getRowConfig: () => config,
            remoteStatusOnly: true,
            getServiceProbe: uploadServiceProbe(clientCtx),
            getLogSnapshot: () => ring.snapshot(),
            getGatewaySummary: gatewaySummary,
            getProfileName: profileName,
            getPluginVersion: () => pluginVersion,
            lang: resolveActiveLang,
          }),
        }), 'dsh-zen-remote: client routes (host)')
      })
      // CLI-1: the IPC delegate's client face on a pure host role — remote-status
      // and the debug report answer (both are every role's own); the IPC
      // prefix gate covers the pairing routes (409 wrong-role before any
      // request reaches here), and the handler keeps the host mount's
      // least-exposure wall besides.
      cliClientHandler = createClientHandler({
        admit: noopAdmit,
        getRowConfig: () => config,
        remoteStatusOnly: true,
        getServiceProbe: uploadServiceProbe(ctx),
        getLogSnapshot: () => ring.snapshot(),
        getGatewaySummary: gatewaySummary,
        getProfileName: profileName,
        getPluginVersion: () => pluginVersion,
        lang: resolveActiveLang,
      })
    }
  }
  if (connectsRole(effective.values.role)) {
    // Sub-client half (T16, T23a; MS-5 pool rewiring): the paired-servers
    // connection pool instead of the single row-driven client. The row's
    // serverUrl/deviceToken survive only as the LEGACY source — read once
    // here so an old single-server row migrates into
    // `zen-remote-state.json`'s paired list (state-store's migration keeps
    // the list's other entries); from then on the pool's paired list is the
    // single truth, edited by the client routes' claim/unpair.
    const row = config as Record<string, unknown>
    // (`home` is hoisted to apply() level — the pool's state file and the
    // CLI IPC socket share the same directory.)
    // MS-3/MS-5: the intercept handle is created inside the typertGateway
    // inject below, but the POOL's state callbacks (created first) forward
    // to it — the closure is fine (the callbacks fire after apply() returned
    // or not at all); the declaration just moved up so the wiring reads
    // top-down.
    let interceptHandle: InterceptHandle | undefined
    const legacyCredentials = (): { serverUrl?: string; deviceToken?: string } | undefined => {
      const url = unwrapVolatile(row.serverUrl)
      const token = unwrapVolatile(row.deviceToken)
      const serverUrl = typeof url === 'string' && url.trim() !== '' ? url : undefined
      const deviceToken = typeof token === 'string' && token !== '' ? token : undefined
      return serverUrl === undefined && deviceToken === undefined ? undefined : { serverUrl, deviceToken }
    }
    // PG-2: the pairing cap's three live sources, read PER CALL — the config
    // field is volatile (not a restart field), and the network cap lives in
    // the state file's peerNetwork block, which a peer-mode join writes at
    // any time.
    const clientStateFile = join(home, 'zen-remote-state.json')
    const maxServersCap = (): number => resolveConfig(config, readFileConfig(), process.env).values.maxServers
    const maxServersSource = (): ReturnType<typeof resolveConfig>['sources']['maxServers'] =>
      resolveConfig(config, readFileConfig(), process.env).sources.maxServers
    // PC-09: the network cap is a PEER fact. The state file keeps a former
    // peer life's `peerNetwork` block on purpose (switching back must find
    // it intact), but a client row must pair by its OWN configuration — so
    // the getter answers undefined outside peer mode, and the pool never
    // sees a network cap to fold in. The role is a restart field: this
    // snapshot lives exactly as long as the row, same as `skipPersistedServers`
    // below; a role change rebuilds the pool through a fresh apply().
    const peerNetworkCap = (): number | undefined =>
      effective.values.role === 'peer' ? readPeerNetwork(clientStateFile)?.maxPeersFromGateway : undefined
    // CU-1 lifecycle: the pool's per-server link flips enter the ring —
    // `online` with the entry and its handshake server id, `offline` with
    // the failure code (lastError is a short code by contract, never free
    // text). The client's subscribe re-announces the CURRENT state when only
    // the handshake identity moved (the T59 heartbeat), so the per-entry
    // dedupe keeps the heartbeats out of the ring: one line per actual state
    // change. Every event ALSO reaches the intercept's pool hub — the merged
    // streams re-scan `pool.entries()` on it.
    const poolRingStates = new Map<string, string>()
    const relayPool = createRelayPool({
      stateFile: clientStateFile,
      legacySource: legacyCredentials,
      skipPersistedServers: effective.values.role === 'peer',
      // PG-2: pair() and maxServers() read the live cap per call.
      getMaxServers: maxServersCap,
      getMaxServersSource: maxServersSource,
      getPeerNetworkCap: peerNetworkCap,
      // Interface compatibility (T42): after each completed handshake this
      // side computes its OWN fingerprints against THIS process's typert
      // registry (read per call — at creation time the row context may still
      // be assembling), and the client stores the group-by-group verdict the
      // status route reports.
      computeOwnFingerprints: () => computeFingerprints(ctx),
      onStateChange: ({ entryId, serverId, state, lastError }) => {
        if (poolRingStates.get(entryId) !== state) {
          poolRingStates.set(entryId, state)
          if (state === 'online') ring.push('info', 'relay pool online (entry=%s server=%s)', entryId, serverId ?? '?')
          else if (state === 'offline') ring.push('warn', 'relay pool offline (entry=%s code=%s)', entryId, lastError ?? '?')
        }
        interceptHandle?.notePoolEvent()
      },
      onServerRemoved: ({ entryId, reason }) => {
        poolRingStates.delete(entryId)
        ring.push('info', 'relay pool server removed (entry=%s reason=%s)', entryId, reason)
        interceptHandle?.notePoolEvent()
      },
    })
    clientRelayPool = relayPool
    // PG-8: the peer role ALSO joins a virtual network — one engine owns the
    // gateway WS control link, the local TOFU anchoring, the punch/mux paths
    // and the pool's virtual mounts. Created beside the pool (it mounts into
    // it), torn down with it (the SAME disposal effect — the role-wiring
    // contract pins the top-level effect counts, so no new effect appears).
    const peerEngine: PeerEngine | undefined = effective.values.role === 'peer'
      ? createPeerEngine({
          stateFile: clientStateFile,
          identity: ensurePeerIdentity(clientStateFile),
          relayPool,
          // The mux's inbound end rides the serving half; both slots stay
          // undefined until the relay route's own effect mounts it (and on
          // compositions with no webServer — the mux then answers 503).
          relayHandler: () => servingRelayHandler,
          relaySecret: () => servingRelaySecret ?? '',
          serverName: () => resolveConfig(config, readFileConfig(), process.env).values.serverName,
          // STUN probing derives its ports from the gateway's authorized
          // welcome (`stun`, the real UDP bind results since PC-01a) and runs
          // on the punch socket; an old gateway without the field degrades to
          // `unknown`. Explicit `udpProbe` stays a controlled-caller override
          // and is intentionally NOT set here.
          log: (line) => { ring.push('info', 'peer: %s', line) },
        })
      : undefined
    livePeerEngine = peerEngine
    // PG-9 启动自动恢复：state 文件里已有 peerNetwork 记录（本机曾入网）
    // 就直接按 join 序列连回——重启 DSH 不再需要重新粘贴邀请链接。未入网
    // 时 resumeFromState() 自己回答 false，什么也不做。
    peerEngine?.resumeFromState()
    // A stopped or reloaded row must not leave a stale pool where the module
    // getter can hand it out (T23a-fix's discipline), and its clients'
    // reconnect machinery must not outlive the row either: stop() ends every
    // client (which cancels armed retry timers and blocks scheduling). The
    // identity guard keeps a slow dispose from clearing a NEWER row's pool.
    // The peer engine (when present) dies in the same breath — its virtual
    // mounts, its WS link and its punch sockets all belong to this row.
    ctx.effect(() => () => {
      peerEngine?.stop()
      if (livePeerEngine === peerEngine) livePeerEngine = undefined
      relayPool.stop()
      if (clientRelayPool === relayPool) clientRelayPool = undefined
    }, 'dsh-zen-remote: relay pool disposal')
    // The plugin bridge's live verdict (PB-2), per POOL ENTRY now (MS-5) — a
    // host has no remote sessions of its own to bridge anything into, and
    // server A's verdicts must never answer for server B's. Computed PER
    // CALL (never a stored conclusion): the local registry is this apply's
    // own closure, the entry's table is ITS LAST handshake's `plugins`
    // (undefined until one succeeded — an old server reads server-too-old),
    // and `online` is that client's CURRENT state — so a registry change, a
    // fresh handshake or a link flip shows up at the very next read.
    const pluginBridgeStatusFor = (serverId: string | undefined, client: RelayClient): BridgeStatus[] =>
      compareBridges(registry.list(), client.handshakeInfo?.plugins, client.state === 'online')
    // Device-name watch (T59 through MS-5's pool): the row's `serverName` is
    // this device's name, and a USER-committed change is broadcast to EVERY
    // paired server's gateway device table — one-way (MS decision: the
    // server's record never rewrites the row). The loader announces the
    // commit on the row context, but the event fires for EVERY volatile
    // commit (an unrelated knob, or a settings page's own server-driven
    // follow write), so the listener filters on the changed paths. Each
    // client pushes only when the name differs from its server's record
    // (queueDeviceName's contract) — which is what keeps a follow write from
    // bouncing back and forth. NOT pushed at startup either: the row's
    // loaded name is stale by definition and an unconditional boot-time push
    // would overwrite an administrator's rename. A rename committed offline
    // and lost to a process exit stays local until the user edits it again —
    // accepted; the server's record wins by default. (The old T43
    // credentialsChanged half of this listener is gone with the row client:
    // the pool's credentials live in the state file, edited by claim/unpair,
    // and its clients react to THOSE on their own.)
    ctx.effect(() => {
      try {
        const off = ctx.on('loader/volatile-update', (paths) => {
          peerEngine?.refreshMounts()
          if (!volatileUpdateTouchesServerName(paths)) return
          const name = unwrapVolatile(row.serverName)
          if (typeof name === 'string' && name.trim() !== '') {
            relayPool.queueDeviceNameAll(name)
            peerEngine?.announceSelfName(name)
          }
        })
        return () => {
          off()
        }
      } catch (error) {
        logWarn('dsh-zen-remote: cannot listen on "loader/volatile-update" for relay credentials: %s', message(error))
        return () => {}
      }
    }, 'dsh-zen-remote: relay credentials watcher')
    // The typertGateway interception (T23b-1): remote-session calls ride the
    // relay, everything else reaches the local gateway untouched. The live
    // diagnostics flow to the client status route through whichever of the
    // two slots is filled — an installed handle, or the shape verdict that
    // REFUSED an install (both belong on the settings surface). A
    // composition without typertGateway (0.1.7 client) leaves both empty and
    // the status answer simply carries no intercept field. (The handle's
    // declaration itself sits above, beside the pool — its callbacks forward
    // pool events here.)
    let interceptRefused: GatewayShapeCheck | undefined
    // T62: the browser's current-session report, held here and read live by
    // the intercept (which cannot reach the browser's localStorage — it
    // wraps the backend gateway). Last write wins across windows; until the
    // first report arrives the value is `unavailable` and the intercept
    // keeps its conservative tombstone behavior.
    let reportedCurrentSession: CurrentSessionRead = { kind: 'unavailable' }
    const onCurrentSession = (read: CurrentSessionRead, reportedLang?: 'zh' | 'en'): void => {
      reportedCurrentSession = read
      if (reportedLang !== undefined) reportedBrowserLang = reportedLang
      // Re-judge NOW — the merger dedupes no-change calls, so a report that
      // carries nothing new costs one compare.
      interceptHandle?.currentSessionChanged()
    }
    // PB-25b: the KNOWN-real-session inventory — the union of the merged
    // global streams' session snapshots (the workspace merger's sessionHome:
    // every real id the sidebar currently holds as a `zr~` row). Each merged
    // stream owns one slot; a report REPLACES that stream's share (never a
    // delta — merge-streams' contract) and the union rebuilds wholesale on
    // every report and dispose (stream count is single digits). The
    // plugin-route rewrite reads the union LIVE per answer through the
    // getter — the same live-read discipline as getServerId/getStatus: a
    // snapshot captured at install time would be permanently empty (the
    // streams start reporting after the install), and an id that appears
    // between two stream refreshes waits for the next refresh by design
    // (the documented ceiling in merge-streams.ts). Read-only consumption:
    // nothing below ever mutates what a merger handed over.
    // MS-5: each share is tagged with the serverId its stream asked the slot
    // for, so the plugin-route's per-server face can answer the union of ONE
    // server's ids — a rewrite against server A must never see B's ids.
    const knownSessionShares = new Map<SessionInventorySlot, { serverId: string | undefined; ids: ReadonlySet<string> }>()
    const knownRealIds = new Set<string>()
    const rebuildKnownRealIds = (): void => {
      knownRealIds.clear()
      for (const share of knownSessionShares.values()) {
        for (const id of share.ids) knownRealIds.add(id)
      }
    }
    const createSessionInventorySlot = (serverId?: string): SessionInventorySlot => {
      const slot: SessionInventorySlot = {
        replace(ids) {
          knownSessionShares.set(slot, { serverId, ids })
          rebuildKnownRealIds()
        },
        dispose() {
          if (knownSessionShares.delete(slot)) rebuildKnownRealIds()
        },
      }
      return slot
    }
    /** MS-5: one server's share of the union, for the plugin-route rewrite's
     * per-server face. An entry that never reported (its stream not open
     * yet) contributes nothing — the request-local scan still runs. */
    const knownRealIdsForServer = (serverId: string): ReadonlySet<string> => {
      const out = new Set<string>()
      for (const share of knownSessionShares.values()) {
        if (share.serverId !== serverId) continue
        for (const id of share.ids) out.add(id)
      }
      return out
    }
    const interceptDiagnostics = (): InterceptDiagnostics | undefined => {
      if (interceptHandle !== undefined) return interceptHandle.diagnostics()
      if (interceptRefused !== undefined) {
        return { installed: false, shape: interceptRefused, recentFailures: [], incompatibleCalls: [], closedSessions: [] }
      }
      return undefined
    }
    ctx.inject(['typertGateway', 'connection'], (gatewayCtx) => {
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
        // MS-5 POOL mode: routing and merging read the relay pool — every
        // call/stream/event rides the virtual id's serverId half to ITS
        // server, the three global reads merge ALL paired servers in pairing
        // order. (The single-server `relay` + `getServerId` form is gone
        // from the wiring with the row client.)
        pool: relayPool,
        getCurrentSession: () => reportedCurrentSession,
        lang: resolveActiveLang,
        // PB-25b: each merged stream reports its real-session inventory
        // share into the union above.
        createSessionInventorySlot,
        log: (format, ...args) => { logInfo(`dsh-zen-remote ${format}`, ...args) },
      })
      interceptHandle = handle
      gatewayCtx.effect(() => () => {
        handle.uninstall()
        if (interceptHandle === handle) interceptHandle = undefined
      }, 'dsh-zen-remote: typert intercept')
      // Behavior self-check (spike §4.1 check 4) — the shape check proves
      // the constructor still resolves dynamically, this proves the wrap is
      // actually REACHED: one local `workspace/follow` through
      // wireStream.open, whose own payload must enter the wrapper (recognized
      // by identity, not by call counters) and answer a `baseline` first
      // frame with a value.items array. One retry after a pause; only a
      // second failure uninstalls (a half-trusted interception is worse than
      // none). Failure handling lives in runSelfCheck, which records the
      // verdict via noteSelfCheck.
      // DSH 0.2.1-alpha.3: the probe needs an owner Peer of its own (the
      // gateway's operatorPeer fallback is gone), and a Peer can only be
      // minted from the connection service — which the host gateway's own
      // constructor pulls in through a NESTED inject, so typertGateway alone
      // never guarantees it is up. `connection` therefore rides the inject
      // declaration (issue #53): the install WAITS for the peer source
      // instead of running a probe that cannot pass and tearing the
      // interception down (one retry, then uninstall, no recovery) on hosts
      // where connection merely lags startup.
      void runSelfCheck(raw, {
        handle,
        log: logWarn,
        info: (format, ...args) => { logInfo(`dsh-zen-remote ${format}`, ...args) },
        getPeer: createOwnerPeerSource(() => gatewayCtx.reflect.get('connection')),
      })
    })
    // The exact-fetch-route interception (T51): the local backend's
    // `/api/session/uploadFileBinary` entry forwards REMOTE sessions'
    // non-image attachments through the relay's binary channel (the
    // browser's Web-Worker upload bypasses window.fetch and the typert
    // gateway entirely — it lands here), and `/api/session.export` refuses
    // virtual ids. Injected on `fileUploads` beside `connection` on purpose:
    // the upload route is registered inside the FileUploads service's
    // CONSTRUCTOR (RT dsh-client-file-upload lib/index.js:171-176), so
    // requiring the service both guarantees the entry exists and skips
    // compositions that have no upload service at all — the same
    // absent-half-loads-anyway posture the typertGateway inject keeps. The
    // diagnostics flow to the client status route like the typert
    // interception's, refused installs included.
    let fetchRouteHandle: FetchRouteInterceptHandle | undefined
    let fetchRouteRefused: FetchRouteShapeCheck | undefined
    const fetchRouteDiagnostics = (): FetchRouteInterceptDiagnostics | undefined => {
      if (fetchRouteHandle !== undefined) return fetchRouteHandle.diagnostics()
      if (fetchRouteRefused !== undefined) {
        return {
          installed: false,
          shape: fetchRouteRefused,
          uploadWrapped: false,
          exportWrapped: false,
          uploadPending: false,
          exportPending: false,
          uploadAttachRefused: undefined,
          exportAttachRefused: undefined,
          uploadCalls: 0,
          uploadForwarded: 0,
          uploadRefused: 0,
          exportBlocked: 0,
          recentFailures: [],
        }
      }
      return undefined
    }
    fetchRouteDiagnosticsRef = fetchRouteDiagnostics
    ctx.inject(['connection', 'fileUploads'], (connectionCtx) => {
      fetchRouteInjectSeen = true
      // BU-1 double-install guard: the fallback timer may have installed
      // while this callback sat PENDING — or recorded a refusal. Either way
      // this primary path has nothing left to do; installing again would
      // chain a second wrap over the first (behaviorally right, structurally
      // dirty) and overwrite the diagnostics' installedVia.
      if (fetchRouteHandle !== undefined || fetchRouteRefused !== undefined) return
      const proxy = (connectionCtx as Context & { connection?: unknown }).connection
      const raw = proxy !== null && typeof proxy === 'object'
        ? (proxy as unknown as Record<PropertyKey, unknown>)[symbols.original]
        : undefined
      if (raw === null || typeof raw !== 'object') {
        fetchRouteRefused = { ok: false, reasons: ['original: connection[symbols.original] is not an object'] }
        logWarn('dsh-zen-remote fetch-route intercept not installed: %s', fetchRouteRefused.reasons[0])
        return
      }
      // Shape first, like the typert wrap: a failed check leaves every route
      // exactly as it was — local uploads untouched, remote uploads keep
      // failing with the honest local error. (The media note rides along:
      // this wiring always hands a resolveRemoteFileScope over, P55-2.)
      const shape = checkFetchRouteShape(raw, true)
      if (!shape.ok) {
        fetchRouteRefused = shape
        logWarn('dsh-zen-remote fetch-route intercept not installed: %s', shape.reasons.join('; '))
        return
      }
      const handle = installFetchRouteIntercept({
        connection: raw,
        // MS-5 pool mode: each upload's serverId half picks its own client.
        getRelayForServer: (serverId) => relayPool.getByServerId(serverId)?.client,
        // P55-2: the /api/file media route forwards to the session the
        // intercept currently holds — read LIVE per request, so an uninstalled
        // (or not-yet-installed) typert wrap answers undefined and the media
        // request passes through to the local route.
        resolveRemoteFileScope: (filePath) => interceptHandle?.resolveRemoteFileScope(filePath),
        lang: resolveActiveLang,
        log: (format, ...args) => { logInfo(`dsh-zen-remote ${format}`, ...args) },
      })
      fetchRouteHandle = handle
      fetchRouteInstalledVia = 'inject'
      // CU-1 lifecycle: a successful install logs nothing today (the wrap's
      // own log lines only fire per call), so the ring gets one explicit
      // record — the debug report's "did the redirect actually attach" fact.
      // The refused and fallback paths funnel through logWarn/logInfo below
      // and enter the ring that way.
      ring.push('info', 'fetch-route intercept attached (via=inject)')
      connectionCtx.effect(() => () => {
        handle.uninstall()
        if (fetchRouteHandle === handle) {
          fetchRouteHandle = undefined
          fetchRouteInstalledVia = undefined
        }
      }, 'dsh-zen-remote: fetch-route intercept')
    })
    // BU-1: the fetch-route FALLBACK install (SPEC §2). RD-6 proved the
    // machine-local failure mode: on one Windows client the
    // `['connection','fileUploads']` inject above sat silently PENDING (a
    // stuck row keeps cordis waiting forever, printing nothing), the wrap
    // never installed, and every remote upload fell through to the local
    // backend. The inject stays the FIRST choice — this timer only acts when
    // it demonstrably has not fired while BOTH services are present in the
    // reflection layer, then installs through the same
    // checkFetchRouteShape → symbols.original → installFetchRouteIntercept
    // path, sharing the handle/refused slots (which is also the
    // double-install guard: whichever path runs first, the other sees the
    // slots set and stands down). Bounded: a 3 s tick, at most 20 (a minute)
    // — a composition that never ships the services stops probing; unref'd
    // and cleared with the row.
    let fallbackTimer: ReturnType<typeof setInterval> | undefined
    let fallbackAttempts = 0
    const stopFallbackTimer = (): void => {
      if (fallbackTimer !== undefined) {
        clearInterval(fallbackTimer)
        fallbackTimer = undefined
      }
    }
    fallbackTimer = setInterval(() => {
      // The tick budget is checked BEFORE acting but does not cancel the
      // current tick: attempt #20 still runs, no tick #21 ever comes.
      fallbackAttempts += 1
      if (fallbackAttempts >= 20) stopFallbackTimer()
      // Same reflection the service probe reads: both services must be
      // PRESENT — their absence means a legitimate startup wait (or a
      // composition without them), where the inject must stay first choice.
      const reflect = (ctx as Context & { reflect?: { get(name: string): unknown } }).reflect
      const connection = reflect?.get('connection')
      const fileUploads = reflect?.get('fileUploads')
      if (!shouldFallbackInstall({
        injectSeen: fetchRouteInjectSeen,
        handleSet: fetchRouteHandle !== undefined,
        refused: fetchRouteRefused !== undefined,
        servicesPresent: connection !== undefined && fileUploads !== undefined,
      })) {
        // The services being absent is a WAIT (next tick re-judges); the
        // primary path having advanced is a VERDICT — the fallback has no
        // business left, stop probing.
        if (fetchRouteInjectSeen || fetchRouteHandle !== undefined || fetchRouteRefused !== undefined) stopFallbackTimer()
        return
      }
      // Shape against the proxy first (fetchRoutes reads through it); the
      // raw instance comes off the same symbols slot the inject path uses.
      // (The media note rides along — same install options as the inject
      // path, P55-2.)
      const shape = checkFetchRouteShape(connection, true)
      if (!shape.ok) {
        // Structural mismatch is a verdict, not a wait: record the attempt
        // and stop. A later inject trigger may still install (it checks the
        // RAW instance, which can differ from what the proxy exposed).
        fetchRouteFallbackTriedAt = new Date().toISOString()
        stopFallbackTimer()
        logWarn('dsh-zen-remote fetch-route fallback declined: %s', shape.reasons.join('; '))
        return
      }
      const raw = connection !== null && typeof connection === 'object'
        ? (connection as unknown as Record<PropertyKey, unknown>)[symbols.original]
        : undefined
      if (raw === null || typeof raw !== 'object') {
        fetchRouteFallbackTriedAt = new Date().toISOString()
        stopFallbackTimer()
        logWarn('dsh-zen-remote fetch-route fallback declined: %s', 'original: connection[symbols.original] is not an object')
        return
      }
      const handle = installFetchRouteIntercept({
        connection: raw,
        // MS-5 pool mode: each upload's serverId half picks its own client.
        getRelayForServer: (serverId) => relayPool.getByServerId(serverId)?.client,
        // P55-2: same live read as the inject path — the media route follows
        // whichever typert intercept is currently installed.
        resolveRemoteFileScope: (filePath) => interceptHandle?.resolveRemoteFileScope(filePath),
        lang: resolveActiveLang,
        log: (format, ...args) => { logInfo(`dsh-zen-remote ${format}`, ...args) },
      })
      fetchRouteHandle = handle
      fetchRouteInstalledVia = 'fallback'
      stopFallbackTimer()
      logInfo('dsh-zen-remote fetch-route intercept installed via the fallback timer (inject never fired)')
      // Same disposal contract as the inject path: the wrap dies with the
      // row (the fallback has no service context of its own to hang on).
      ctx.effect(() => () => {
        handle.uninstall()
        if (fetchRouteHandle === handle) {
          fetchRouteHandle = undefined
          fetchRouteInstalledVia = undefined
        }
      }, 'dsh-zen-remote: fetch-route intercept (fallback)')
    }, 3_000)
    if (typeof fallbackTimer.unref === 'function') fallbackTimer.unref()
    ctx.effect(() => () => { stopFallbackTimer() }, 'dsh-zen-remote: fetch-route fallback timer')
    // The plugin bridge's route interception (PB-4): the local webServer's
    // `match` wrap forwarding bridged-plugin requests for REMOTE sessions
    // through the relay. Injected on `webServer` alone — the only service
    // it reads — and the raw instance comes off the reflection layer's
    // symbols lookup, the same face the typert and fetch-route wraps use.
    // The diagnostics flow to the client status route like theirs, refused
    // installs included.
    let pluginRouteHandle: PluginRouteInterceptHandle | undefined
    let pluginRouteRefused: WebServerShapeCheck | undefined
    const pluginRouteDiagnostics = (): PluginRouteInterceptDiagnostics | undefined => {
      if (pluginRouteHandle !== undefined) return pluginRouteHandle.diagnostics()
      if (pluginRouteRefused !== undefined) {
        return {
          installed: false,
          shape: pluginRouteRefused,
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
      }
      return undefined
    }
    ctx.inject(['webServer'], (wsCtx) => {
      const proxy = (wsCtx as Context & { webServer?: unknown }).webServer
      const raw = proxy !== null && typeof proxy === 'object'
        ? (proxy as unknown as Record<PropertyKey, unknown>)[symbols.original]
        : undefined
      if (raw === null || typeof raw !== 'object') {
        pluginRouteRefused = { ok: false, reasons: ['original: webServer[symbols.original] is not an object'] }
        logWarn('dsh-zen-remote plugin-route intercept not installed: %s', pluginRouteRefused.reasons[0])
        return
      }
      // Shape first, like every wrap: a failed check leaves the webServer
      // exactly as it was — local routing untouched, remote bridging off.
      const shape = checkWebServerShape(raw)
      if (!shape.ok) {
        pluginRouteRefused = shape
        logWarn('dsh-zen-remote plugin-route intercept not installed: %s', shape.reasons.join('; '))
        return
      }
      const handle = installPluginRouteIntercept({
        webServer: raw,
        registry,
        loopbackSecret: pluginLoopbackSecret,
        // MS-5 pool mode: validation, forwarding and response rewriting are
        // judged against the located id's OWN server — its relay client, its
        // bridge verdicts (its handshake's plugin table against the local
        // registry) and its own known-real-id inventory.
        getRelayForServer: (serverId) => relayPool.getByServerId(serverId)?.client,
        getStatusForServer: (serverId) => {
          const entry = relayPool.getByServerId(serverId)
          return entry !== undefined ? pluginBridgeStatusFor(entry.serverId, entry.client) : []
        },
        getKnownRealIdsForServer: knownRealIdsForServer,
        adapters,
        // PB-12: the browser's currently open session — a VIRTUAL id means
        // a remote panel is the request's origin, the signal the adapter
        // routes' deny hooks read (better-sidebar's open.external carries
        // no session field of its own).
        getCurrentSession: () => (reportedCurrentSession.kind === 'open' ? reportedCurrentSession.sessionId : undefined),
        // PB-25b: the known-real-session union, read LIVE per rewriteIds
        // answer — the rewriteIds deep scan rewrites an id that already sits
        // in the browser's view even when this request never carried it.
        getKnownRealIds: () => knownRealIds,
        // PB-26a: a response rewrite that minted a virtual id (a sidechat
        // child from `rewriteIds.fields` or an adapter's `virtualize`) is the
        // client's only early notice of a row that rides no workspace/follow
        // frame — hand it to the summary sync so the sidebar row appears.
        onMintedVirtualIds: (ids) => { interceptHandle?.nudgeSummarySync(ids) },
        log: (format, ...args) => { logInfo(`dsh-zen-remote ${format}`, ...args) },
      })
      pluginRouteHandle = handle
      wsCtx.effect(() => () => {
        handle.uninstall()
        if (pluginRouteHandle === handle) pluginRouteHandle = undefined
      }, 'dsh-zen-remote: plugin route intercept')
    })
    // CLI-1: one options factory, two handler instances — the browser mount
    // below keeps its admit wall, and the CLI IPC delegate's instance (same
    // pool, same diagnostics getters, same everything but admit) lets the
    // local CLI drive THIS pool directly over the 0600 socket.
    const clientOptionsFor = (admit: (req: IncomingMessage) => AdminAdmission, probeCtx: Context) => ({
      admit,
      getRowConfig: () => config,
      // MS-5 POOL mode: the paired list is the truth — claim pairs into
      // the pool (the token never reaches the browser), unpair/reconnect
      // address pool entries, and status / remote-status report every
      // server. The row still rides along for the non-connection knobs
      // (the debug report's config summary) — never for credentials.
      pool: relayPool,
      // PG-2: the status body and the claim pre-check read the LIVE cap.
      getMaxServers: maxServersCap,
      // PG-9: the peer management routes' live engine and the joined
      // network's HTTP origin, both read per request. Undefined engine on a
      // non-peer row — the routes then answer 503 peer-unavailable.
      getPeerEngine: () => peerEngine,
      getPeerNetworkOrigin: () => readPeerNetwork(clientStateFile)?.gatewayHttpOrigin,
      getPluginBridgeStatusForServer: pluginBridgeStatusFor,
      getIntercept: interceptDiagnostics,
      getFetchRouteIntercept: fetchRouteDiagnostics,
      getServiceProbe: uploadServiceProbe(probeCtx),
      getPluginRouteIntercept: pluginRouteDiagnostics,
      onCurrentSession,
      getLogSnapshot: () => ring.snapshot(),
      ...(servingGatewaySummary === undefined ? {} : { getGatewaySummary: servingGatewaySummary }),
      getProfileName: profileName,
      getPluginVersion: () => pluginVersion,
      lang: resolveActiveLang,
    })
    cliClientHandler = createClientHandler(clientOptionsFor(noopAdmit, ctx))
    ctx.inject(['webServer', 'connection'], (clientCtx) => {
      clientCtx.effect(() => clientCtx.webServer.register({
        kind: 'prefix',
        path: CLIENT_ROUTE_PREFIX,
        handler: createClientHandler(clientOptionsFor((req) => clientCtx.connection.admit(req), clientCtx)),
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
    // CU-1 lifecycle: the row is about to reload — the ring dies with this
    // apply right after, so this line is the reload's only witness in the
    // NEXT generation's report (the fresh apply's row-apply line follows).
    ring.push('info', 'row reload: a restart-required setting changed, reloading the plugin row')
    const fiber = (ctx as { fiber?: { restart?: () => Promise<unknown> } }).fiber
    if (fiber?.restart === undefined) {
      logWarn('dsh-zen-remote: a restart-required setting changed, but no fiber is available to reload the plugin row')
      return
    }
    try {
      Promise.resolve(fiber.restart()).catch((error) => {
        logWarn('dsh-zen-remote: plugin row reload failed: %s', message(error))
      })
    } catch (error) {
      logWarn('dsh-zen-remote: plugin row reload failed: %s', message(error))
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
      ctx.on('loader/volatile-update', (paths) => {
        if (Array.isArray(paths)) {
          const topKeys = paths
            .map((p) => (Array.isArray(p) && typeof p[0] === 'string' ? p[0] : undefined))
            .filter((k): k is string => k !== undefined)
          if (topKeys.length > 0) clearUnshadowedRowKeys(home, topKeys)
        }
        watcher.checkNow()
      })
    } catch (error) {
      logWarn('dsh-zen-remote: cannot listen on "loader/volatile-update": %s', message(error))
    }
    // CLI-1: hot-swap THIS row generation's delegate into the module-level
    // IPC server (acquire is synchronous — apply() runs inside cordis; the
    // first bind completes in the background and the CLI client retries
    // until then). writeCliConfig's onAfterWrite re-checks the fingerprint
    // IMMEDIATELY, so a CLI config write to a restart-required field
    // reloads the row without waiting out the 2s poll. Every role getter
    // re-resolves per call: ping answers the CURRENT effective role even in
    // the instant before a pending reload lands. The IPC lifecycle rides
    // this existing effect on purpose — role-wiring pins the top-level
    // effect counts, so it may not register its own.
    const delegate: CliIpcDelegate = {
      role: () => resolveConfig(config, readFileConfig(), process.env).values.role,
      serverName: () => resolveConfig(config, readFileConfig(), process.env).values.serverName,
      profileName,
      pluginVersion: () => pluginVersion,
      writeConfig: (input) => writeCliConfig({
        dshHome: home,
        row: config as Record<string, unknown>,
        env: process.env,
        set: input.set,
        unset: input.unset,
        onAfterWrite: () => { watcher.checkNow() },
      }),
      wizardHandler: cliWizardHandler,
      adminHandler: cliAdminHandler,
      clientHandler: cliClientHandler,
    }
    const cliIpc = acquireCliIpcServer(home, delegate)
    return () => {
      // Release THIS row's hold (a concurrent reload's new acquire keeps
      // the socket alive — that is the coordinator's grace window). The
      // managed ingress children die with the row here too: on compositions
      // WITHOUT a webServer the wizard effect above never fires, so this is
      // the only stop they would ever get (with webServer both stop — stop
      // is idempotent, safe before any start).
      cliIpc.release()
      watcher.stop()
      for (const child of cliManagedChildren) child.stop()
    }
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
          logWarn,
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
