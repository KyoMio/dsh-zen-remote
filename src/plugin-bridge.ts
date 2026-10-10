/**
 * The plugin bridge's registration and comparison half (PB-1).
 *
 * Other DSH plugins can hand zen-remote a "bridge declaration": the list of
 * THEIR OWN HTTP routes that may be forwarded to the main server inside a
 * remote session (docs/adr/0001). A plugin counts as "bridged" only when
 * BOTH ends agree on the plugin name, the exact version AND the declaration
 * digest — everything here is the pure logic behind that agreement: the
 * declaration shape and its validation ({@link normalizeDeclaration}), the
 * per-process registry backing the `zenRemote` service
 * ({@link createBridgeRegistry}), and the local-vs-server comparison that a
 * later task feeds handshake data into ({@link compareBridges}).
 *
 * Pure logic by design: no DSH imports, no I/O, no clocks — the digest is
 * the only place node:crypto appears, which is fine because this module only
 * ever runs in the backend process. Nothing here talks to the relay or the
 * network; the handshake side and the request rewrite side are later tasks
 * that consume a {@link BridgeRegistry} through src/index.ts.
 */

import { createHash } from 'node:crypto'

/** Where a bridged route's caller supplies the session id. `'session'` — the
 * data is scoped to one session, forwarded after the server checks the share.
 * `'server'` — whole-machine data (e.g. every zcode task), which the server
 * owner must consent to per plugin (the `pluginBridgeConsent` row knob). */
export type BridgeScope = 'session' | 'server'

/** One forwardable route as a plugin declares it. `sessionParam` names the
 * URL query parameter carrying the session id (default `'sessionId'`);
 * `stream` marks routes answered as an event stream rather than one JSON
 * body. */
export interface BridgeRoute {
  path: string
  scope: BridgeScope
  sessionParam?: string
  stream?: boolean
}

/** What a plugin hands `zenRemote.bridge(...)` — the raw, unvalidated shape. */
export interface BridgeDeclaration {
  plugin: string
  version: string
  routes: BridgeRoute[]
}

/** A declaration after validation: every route field filled, routes sorted
 * by path, and the 16-hex-char digest both ends will compare. */
export interface NormalizedDeclaration {
  plugin: string
  version: string
  routes: Required<BridgeRoute>[]
  digest: string
}

/** Longest legal `plugin` — the npm package name cap. */
const MAX_PLUGIN_LENGTH = 214

/** Most routes one declaration may carry. */
const MAX_ROUTES = 64

/** npm package name shape: lowercase, URL-safe run of `[a-z0-9._-]` that
 * starts with a letter or digit, optionally `@scope/name` with the same body
 * rules on both halves. Not the full official validator (reserved names,
 * edge punctuation) — enough that a typo'd string cannot masquerade as a
 * package name and that the two ends normalize identically. */
const PLUGIN_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

/** Query-parameter name carrying the session id. */
const SESSION_PARAM_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every rejection says WHICH field failed and why. */
function fail(field: string, detail: string): never {
  throw new Error(`invalid bridge declaration, ${field}: ${detail}`)
}

/**
 * Validate one declaration and fold it into its comparable form.
 *
 * Route paths must be plain absolute paths (start with `/`, no `?`, `#`,
 * `..` or whitespace) and must stay off the two prefixes zen-remote does not
 * own: `/_dsh/` (the plugin's own surface) and `/api` (the host's shared
 * fetch channel) — bridging either would let a third plugin put words in the
 * host's mouth. The `/api` check is the literal string prefix, so a plugin
 * route like `/apifoo` is refused too; that overreach is deliberate, the
 * rule must stay trivially predictable on both ends.
 *
 * The digest is sha256 over a canonical JSON of `{plugin, version, routes}`
 * with a fixed key order, hex, first 16 characters — route ORDER is not part
 * of it (two ends listing the same routes in different orders still match),
 * any field VALUE is.
 * @throws with a field-naming message on any illegal shape.
 */
export function normalizeDeclaration(input: unknown): NormalizedDeclaration {
  if (!isPlainObject(input)) fail('declaration', 'expected an object')
  for (const key of Object.keys(input)) {
    if (key !== 'plugin' && key !== 'version' && key !== 'routes') fail(key, 'unknown field (typo guard)')
  }
  const { plugin, version, routes } = input
  if (typeof plugin !== 'string' || plugin === '') fail('plugin', 'must be a non-empty string')
  if (plugin.length > MAX_PLUGIN_LENGTH) fail('plugin', `longer than ${MAX_PLUGIN_LENGTH} characters`)
  if (!PLUGIN_PATTERN.test(plugin)) fail('plugin', `"${plugin}" is not an npm package name`)
  if (typeof version !== 'string' || version.trim() === '') fail('version', 'must be a non-empty string')
  if (!Array.isArray(routes) || routes.length === 0) fail('routes', 'must be a non-empty array')
  if (routes.length > MAX_ROUTES) fail('routes', `${routes.length} routes exceeds the ${MAX_ROUTES} cap`)

  const seen = new Set<string>()
  const normalizedRoutes = routes.map((route, index): Required<BridgeRoute> => {
    if (!isPlainObject(route)) fail(`routes[${index}]`, 'expected an object')
    for (const key of Object.keys(route)) {
      if (key !== 'path' && key !== 'scope' && key !== 'sessionParam' && key !== 'stream') {
        fail(`routes[${index}].${key}`, 'unknown field (typo guard)')
      }
    }
    const { path, scope, sessionParam, stream } = route
    if (typeof path !== 'string' || path === '') fail(`routes[${index}].path`, 'must be a non-empty string')
    if (!path.startsWith('/')) fail(`routes[${index}].path`, `"${path}" must start with "/"`)
    if (path.includes('?')) fail(`routes[${index}].path`, `"${path}" must not contain "?"`)
    if (path.includes('#')) fail(`routes[${index}].path`, `"${path}" must not contain "#"`)
    if (path.includes('..')) fail(`routes[${index}].path`, `"${path}" must not contain ".."`)
    if (/\s/u.test(path)) fail(`routes[${index}].path`, `"${path}" must not contain whitespace`)
    if (path.startsWith('/_dsh/') || path.startsWith('/api')) {
      fail(`routes[${index}].path`, `"${path}" starts with a host-owned prefix (/_dsh/ or /api) and cannot be bridged`)
    }
    if (scope !== 'session' && scope !== 'server') {
      fail(`routes[${index}].scope`, 'must be "session" or "server"')
    }
    const param = sessionParam === undefined ? 'sessionId' : sessionParam
    if (typeof param !== 'string' || !SESSION_PARAM_PATTERN.test(param)) {
      fail(`routes[${index}].sessionParam`, `"${String(param)}" must match ${SESSION_PARAM_PATTERN.source}`)
    }
    const streamFlag = stream === undefined ? false : stream
    if (typeof streamFlag !== 'boolean') fail(`routes[${index}].stream`, 'must be a boolean')
    if (seen.has(path)) fail(`routes[${index}].path`, `duplicate path "${path}"`)
    seen.add(path)
    return { path, scope, sessionParam: param, stream: streamFlag }
  })
  normalizedRoutes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  // Fixed key order = the canonical form both ends hash; insertion order of
  // the object literal IS the contract, JSON.stringify never sorts.
  const canonical = JSON.stringify({
    plugin,
    version,
    routes: normalizedRoutes.map((route) => ({
      path: route.path,
      scope: route.scope,
      sessionParam: route.sessionParam,
      stream: route.stream,
    })),
  })
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
  return { plugin, version, routes: normalizedRoutes, digest }
}

/** The service provided on the row context as `zenRemote`, both roles. Other
 * plugins reach it with `ctx.inject(['zenRemote'], (c) => …)`; when
 * zen-remote is not installed the inject never fires, so dependents need no
 * conditional code. Exported as a TYPE only — no Context augmentation, so
 * nothing here leaks into compositions without this plugin. */
export interface ZenRemoteService {
  /** Register this process's bridge declaration. Throws on an illegal
   * declaration (nothing is registered); on success returns the dispose that
   * removes exactly this registration. */
  bridge(declaration: BridgeDeclaration): () => void
}

/** How `register` reports a same-plugin overwrite. Injectable so tests (and
 * src/index.ts, via the context logger) can observe it; absent = silent. */
export interface CreateBridgeRegistryOptions {
  warn?: (message: string) => void
}

/** The per-process declaration table behind the `zenRemote` service. */
export interface BridgeRegistry {
  /** Validate and record one declaration (throws pass through, nothing is
   * registered). A same-plugin registration REPLACES the earlier one and
   * reports through `warn`. The returned dispose removes only the
   * registration it came from — after an overwrite the STALE dispose is a
   * no-op and must not remove the replacement. */
  register(input: unknown): () => void
  /** All live declarations, sorted by plugin name. */
  list(): NormalizedDeclaration[]
  get(plugin: string): NormalizedDeclaration | undefined
  /** Fires once per successful register and per effective removal (an
   * overwritten stale dispose fires nothing). Returns the unsubscribe. */
  onChange(listener: () => void): () => void
}

/**
 * Create the registry one DSH process (one plugin row) owns.
 *
 * Overwrite bookkeeping is identity-based, not flag-based: each dispose
 * closes over the exact declaration object it registered and only deletes
 * the table entry while it is STILL that object — a stale dispose meeting a
 * newer registration finds someone else's identity and does nothing.
 */
export function createBridgeRegistry(options: CreateBridgeRegistryOptions = {}): BridgeRegistry {
  const byPlugin = new Map<string, NormalizedDeclaration>()
  const listeners = new Set<() => void>()
  const warn = options.warn
  // A throwing listener must not break the register/remove that invoked it —
  // registration is bookkeeping other plugins depend on, a bad observer is
  // that observer's problem. Failures surface through warn when there is one.
  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        warn?.(`a zenRemote onChange listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return {
    register(input) {
      const normalized = normalizeDeclaration(input)
      const replaced = byPlugin.has(normalized.plugin)
      byPlugin.set(normalized.plugin, normalized)
      if (replaced) warn?.(`plugin "${normalized.plugin}" re-registered its bridge declaration; the earlier one was replaced`)
      emit()
      return () => {
        if (byPlugin.get(normalized.plugin) !== normalized) return
        byPlugin.delete(normalized.plugin)
        emit()
      }
    },
    list() {
      return [...byPlugin.values()].sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0))
    },
    get(plugin) {
      return byPlugin.get(plugin)
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Why a plugin is NOT bridged. The order of the cases below is the order
 * {@link compareBridges} judges them in. */
export type BridgeReason =
  | 'not-on-server'
  | 'version-mismatch'
  | 'declaration-mismatch'
  | 'consent-off'
  | 'offline'
  | 'server-too-old'

/** One plugin's bridge verdict on this device. */
export interface BridgeStatus {
  plugin: string
  bridged: boolean
  reason?: BridgeReason
  localVersion: string
  serverVersion?: string
}

/** What the server reports about one plugin at handshake time (a later task
 * carries it in the relay handshake). `serverScopeConsent` records whether
 * the server owner consented to this plugin's whole-machine-data routes. */
export interface ServerPluginEntry {
  version: string
  digest: string
  serverScopeConsent: boolean
}

/**
 * Compare the local registry against the server's handshake table — one
 * {@link BridgeStatus} per LOCAL declaration, in the input order.
 *
 * Judged in this order, first hit wins: offline → the server predates the
 * plugins handshake field (`undefined`, so nothing can match) → the plugin
 * is absent server-side → version differs → version equal but digest
 * differs (same release, different declaration — a skew worth naming) → a
 * `scope:'server'` route without the server owner's consent → bridged.
 *
 * Consent is judged `!== true` on purpose, not `=== false`: an entry without
 * the field (an older server that learned the field later) means UNKNOWN
 * consent, and whole-machine data must stay home until the server says yes.
 */
export function compareBridges(
  local: NormalizedDeclaration[],
  server: Record<string, ServerPluginEntry> | undefined,
  online: boolean,
): BridgeStatus[] {
  return local.map((declaration): BridgeStatus => {
    const localStatus: BridgeStatus = { plugin: declaration.plugin, bridged: false, localVersion: declaration.version }
    if (!online) return { ...localStatus, reason: 'offline' }
    if (server === undefined) return { ...localStatus, reason: 'server-too-old' }
    const entry: unknown = server[declaration.plugin]
    if (typeof entry !== 'object' || entry === null) return { ...localStatus, reason: 'not-on-server' }
    const record = entry as Partial<ServerPluginEntry>
    const serverVersion = typeof record.version === 'string' ? record.version : undefined
    if (serverVersion !== declaration.version) return { ...localStatus, reason: 'version-mismatch', serverVersion }
    if (record.digest !== declaration.digest) return { ...localStatus, reason: 'declaration-mismatch', serverVersion }
    const hasServerScopeRoute = declaration.routes.some((route) => route.scope === 'server')
    if (hasServerScopeRoute && record.serverScopeConsent !== true) {
      return { ...localStatus, reason: 'consent-off', serverVersion }
    }
    return { plugin: declaration.plugin, bridged: true, localVersion: declaration.version, serverVersion }
  })
}
