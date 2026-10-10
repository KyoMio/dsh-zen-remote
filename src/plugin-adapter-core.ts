/**
 * The plugin bridge's adapter core (PB-11) — the framework half of the
 * pluggable adapters. A cooperative plugin registers its OWN bridge
 * declaration (PB-1); an adapter is zen-remote-internal code, written
 * against one third-party plugin's EXACT version, that locates the session
 * ids in that plugin's requests and rewrites them both ways (GLOSSARY:
 * 适配器). This module owns everything the framework needs to run one:
 * the route/locator shapes, their validation, the locate → classify →
 * rewrite pipeline, and the digest the adapter registers under.
 *
 * Deliberately OUTSIDE `src/adapters/`: the pluggability contract
 * (test/adapters-pluggable.test.cjs) is that deleting that directory breaks
 * ONLY the wiring import in src/index.ts. The adapter-author face — the
 * `BridgeAdapter` interface — lives in `src/adapters/types.ts` ON TOP of
 * the shapes defined here (it re-exports them), so the framework never
 * imports a single thing from `src/adapters/`.
 *
 * Pure logic: no DSH, no I/O. The id semantics ride src/virtual-id.ts —
 * a request counts as REMOTE exactly when every id the route's locator
 * finds is a `zr~` virtual id, and the rewrite swaps each for its real
 * half before the request leaves for the relay (docs/adr/0001: the
 * sub-client never lets a remote session's request reach a local plugin).
 */

import { createHash } from 'node:crypto'
import { isVirtual, fromVirtual } from './virtual-id.js'
import type { NormalizedBridgeRoute, NormalizedDeclaration } from './plugin-bridge.js'
import { BRIDGE_METHODS, MAX_ROUTE_BODY_BYTES, DEFAULT_ROUTE_BODY_BYTES } from './plugin-bridge.js'

export { fromVirtual }

/** Where a route's session id lives in a request (`AdapterRoute.locator`).
 * `query` names the search parameter; `path-segment` counts segments AFTER
 * the declared path (a `prefix` route's variable part, already decoded once
 * off the wire); `json-body` names TOP-LEVEL fields of the parsed JSON
 * request body — every one of those fields that is present counts. */
export type AdapterLocator =
  | { in: 'query'; name: string }
  | { in: 'path-segment'; index: number }
  | { in: 'json-body'; fields: readonly string[] }

/** One adapter route as the adapter declares it. `match: 'prefix'` hits
 * `pathname === path || pathname.startsWith(path + '/')` on the RAW
 * undecoded pathname; `exact` is the equality alone. `local: true` marks a
 * path that stays on the sub-client's own machine forever (static assets
 * and the like) — it never forwards, in either direction. */
export interface AdapterRoute {
  path: string
  match: 'exact' | 'prefix'
  methods?: readonly string[]
  maxBody?: number
  stream?: boolean
  upgrade?: boolean
  locator: AdapterLocator
  local?: boolean
}

/** One adapter route after validation: every scalar filled with its
 * EFFECTIVE value (the adapters have no legacy-digest constraint, so
 * unlike the cooperative {@link NormalizedBridgeRoute} the canonical form
 * always carries the defaults). */
export interface NormalizedAdapterRoute {
  path: string
  match: 'exact' | 'prefix'
  methods: string[]
  maxBody: number
  stream: boolean
  upgrade: boolean
  locator: AdapterLocator
  local: boolean
}

/** The two hook faces an adapter may implement (both optional — an adapter
 * that only relocates ids needs neither). `client.request` runs on the
 * sub-client AFTER the ids are rewritten to their real halves and can
 * refuse the forward outright or swap the parsed JSON body;
 * `client.response` runs on the sub-client on a JSON answer and returns
 * the rewritten body (real ids back to virtual form). `server.request`
 * runs on the main server before the loopback and can strip fields (e.g.
 * a `cwd`) the local machine must not receive. */
export interface AdapterRequestContext {
  method: string
  /** The matched route, as declared. */
  route: AdapterRoute
  /** The request's query, ids already in their REAL form. */
  query: URLSearchParams
  /** The parsed JSON request body when the route locates in the body and a
   * body arrived; `undefined` otherwise. */
  body: unknown
}

/** The verdict of a request hook: allow (optionally replacing the JSON
 * body), or refuse with a reason — the refusal travels the bridge's
 * uniform 503 shape on the client half, a 403 on the server half. */
export type AdapterVerdict =
  | { allow: true; body?: unknown }
  | { allow: false; reason: string }

/** The context of `client.response`: the parsed JSON answer plus the
 * virtualizer for this device — an adapter maps server-real session ids
 * back to THIS sub-client's virtual form with it. */
export interface AdapterResponseContext {
  status: number
  body: unknown
  /** Wrap one server-real session id into this device's virtual form. */
  virtualize(id: string): string
  /** Whether a value already IS a virtual id (rewriters skip those). */
  isVirtual(value: unknown): boolean
}

/** The hook members the framework calls, structurally. `src/adapters/
 * types.ts`'s `BridgeAdapter` conforms to this shape by construction. */
export interface AdapterHooks {
  client?: {
    request?(ctx: AdapterRequestContext): AdapterVerdict
    response?(ctx: AdapterResponseContext): unknown
  }
  server?: {
    request?(ctx: AdapterRequestContext): AdapterVerdict
  }
}

/** One adapter after validation: the route table, the digest the registry
 * entry carries, the registry-shaped declaration (server-scope routes —
 * an adapter is whole-machine data by definition), and the hooks. */
export interface NormalizedAdapter {
  plugin: string
  /** The exact versions this adapter was written against; the INSTALLED
   * version must be among them or the adapter does not register. */
  versions: readonly string[]
  routes: NormalizedAdapterRoute[]
  /** The digest of the ROUTE TABLE (locator and match included) — the
   * value the registry entry and the handshake both carry. */
  digest: string
  /** What went into the registry: version = the INSTALLED version, digest
   * = {@link digest}, routes = the forwardable (non-local) ones. */
  declaration: NormalizedDeclaration
  hooks: AdapterHooks
}

const PLUGIN_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const MAX_ROUTES = 64

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(field: string, detail: string): never {
  throw new Error(`invalid adapter, ${field}: ${detail}`)
}

/** Validate one adapter's route table and fold it, together with the
 * INSTALLED plugin version, into the registry-ready form.
 *
 * Route paths follow the cooperative declaration's rules verbatim (plain
 * absolute paths, off the host-owned `/_dsh/` and `/api` prefixes) — an
 * adapter must not be able to reach anything a declaration cannot. The
 * installed version must be listed EXACTLY (`versions` are what the
 * adapter was written against); anything else refuses the adapter whole.
 * @throws with a field-naming message on any illegal shape.
 */
export function normalizeAdapter(input: unknown, installedVersion: string): NormalizedAdapter {
  if (!isRecord(input)) fail('adapter', 'expected an object')
  for (const key of Object.keys(input)) {
    if (key !== 'plugin' && key !== 'versions' && key !== 'routes' && key !== 'client' && key !== 'server') {
      fail(key, 'unknown field (typo guard)')
    }
  }
  const { plugin, versions, routes } = input
  if (typeof plugin !== 'string' || plugin === '' || plugin.length > 214 || !PLUGIN_PATTERN.test(plugin)) {
    fail('plugin', `"${String(plugin)}" is not an npm package name`)
  }
  if (!Array.isArray(versions) || versions.length === 0 || versions.some((v) => typeof v !== 'string' || v === '')) {
    fail('versions', 'must be a non-empty array of version strings')
  }
  if (!versions.includes(installedVersion)) {
    fail('versions', `installed version "${installedVersion}" is not among the adapter's versions`)
  }
  if (!Array.isArray(routes) || routes.length === 0) fail('routes', 'must be a non-empty array')
  if (routes.length > MAX_ROUTES) fail('routes', `${routes.length} routes exceeds the ${MAX_ROUTES} cap`)

  const seen = new Set<string>()
  const normalized: NormalizedAdapterRoute[] = routes.map((route, index): NormalizedAdapterRoute => {
    if (!isRecord(route)) fail(`routes[${index}]`, 'expected an object')
    for (const key of Object.keys(route)) {
      if (key !== 'path' && key !== 'match' && key !== 'methods' && key !== 'maxBody' && key !== 'stream' && key !== 'upgrade' && key !== 'locator' && key !== 'local') {
        fail(`routes[${index}].${key}`, 'unknown field (typo guard)')
      }
    }
    const { path, match, methods, maxBody, stream, upgrade, locator, local } = route
    if (typeof path !== 'string' || path === '' || !path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('..') || /\s/u.test(path)) {
      fail(`routes[${index}].path`, `"${String(path)}" must be a plain absolute path`)
    }
    if (path.startsWith('/_dsh/') || path.startsWith('/api')) {
      fail(`routes[${index}].path`, `"${path}" starts with a host-owned prefix (/_dsh/ or /api)`)
    }
    if (match !== 'exact' && match !== 'prefix') fail(`routes[${index}].match`, 'must be "exact" or "prefix"')
    if (seen.has(path)) fail(`routes[${index}].path`, `duplicate path "${path}"`)
    seen.add(path)
    let normalizedMethods: string[]
    if (methods === undefined) {
      normalizedMethods = ['GET']
    } else {
      if (!Array.isArray(methods) || methods.length === 0) fail(`routes[${index}].methods`, 'must be a non-empty array of HTTP methods')
      const upper: string[] = []
      for (const entry of methods) {
        if (typeof entry !== 'string' || !(BRIDGE_METHODS as readonly string[]).includes(entry)) {
          fail(`routes[${index}].methods`, `${JSON.stringify(entry ?? null)} is not one of ${BRIDGE_METHODS.join(', ')}`)
        }
        if (!upper.includes(entry)) upper.push(entry)
      }
      upper.sort()
      normalizedMethods = upper
    }
    const normalizedMaxBody = maxBody === undefined ? DEFAULT_ROUTE_BODY_BYTES : maxBody
    if (typeof normalizedMaxBody !== 'number' || !Number.isInteger(normalizedMaxBody) || normalizedMaxBody <= 0 || normalizedMaxBody > MAX_ROUTE_BODY_BYTES) {
      fail(`routes[${index}].maxBody`, `must be a positive integer up to ${MAX_ROUTE_BODY_BYTES}`)
    }
    const normalizedStream = stream === undefined ? false : stream
    if (typeof normalizedStream !== 'boolean') fail(`routes[${index}].stream`, 'must be a boolean')
    const normalizedUpgrade = upgrade === undefined ? false : upgrade
    if (typeof normalizedUpgrade !== 'boolean') fail(`routes[${index}].upgrade`, 'must be a boolean')
    if (normalizedUpgrade) {
      if (normalizedStream) fail(`routes[${index}].upgrade`, 'cannot be combined with stream')
      if (normalizedMethods.some((entry) => entry !== 'GET')) fail(`routes[${index}].upgrade`, 'upgrade routes are GET-only')
    }
    if (!isRecord(locator)) fail(`routes[${index}].locator`, 'expected an object')
    if (locator.in === 'query') {
      if (typeof locator.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(locator.name)) {
        fail(`routes[${index}].locator.name`, 'must be a query parameter name')
      }
    } else if (locator.in === 'path-segment') {
      if (typeof locator.index !== 'number' || !Number.isInteger(locator.index) || locator.index < 0) {
        fail(`routes[${index}].locator.index`, 'must be a non-negative integer')
      }
      if (match !== 'prefix') fail(`routes[${index}].locator`, 'path-segment locating needs a prefix route')
    } else if (locator.in === 'json-body') {
      if (!Array.isArray(locator.fields) || locator.fields.length === 0 || locator.fields.some((f) => typeof f !== 'string' || f === '')) {
        fail(`routes[${index}].locator.fields`, 'must be a non-empty array of top-level field names')
      }
    } else {
      fail(`routes[${index}].locator.in`, 'must be "query", "path-segment" or "json-body"')
    }
    if (local !== undefined && local !== true && local !== false) fail(`routes[${index}].local`, 'must be a boolean')
    const normalizedLocal: boolean = local === true
    return {
      path,
      match,
      methods: normalizedMethods,
      maxBody: normalizedMaxBody,
      stream: normalizedStream,
      upgrade: normalizedUpgrade,
      locator: locator as AdapterLocator,
      local: normalizedLocal,
    }
  })
  normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const digest = adapterDigestOf(plugin, installedVersion, normalized)
  // The registry entry: server-scope routes only (an adapter is whole-machine
  // data by definition — the consent wall applies per plugin, default off),
  // local routes left out (they never forward, so the server half must never
  // see them).
  const declaration: NormalizedDeclaration = {
    plugin,
    version: installedVersion,
    routes: normalized
      .filter((route) => !route.local)
      .map((route): NormalizedBridgeRoute => ({
        path: route.path,
        scope: 'server',
        sessionParam: 'sessionId',
        stream: route.stream,
        methods: route.methods.length === 1 && route.methods[0] === 'GET' ? undefined : [...route.methods],
        maxBody: route.maxBody === DEFAULT_ROUTE_BODY_BYTES ? undefined : route.maxBody,
        upgrade: route.upgrade ? true : undefined,
      })),
    digest,
  }
  const hooks: AdapterHooks = {}
  if (isRecord(input.client) || input.client === undefined) {
    const client = input.client as AdapterHooks['client']
    if (client !== undefined && (typeof client.request === 'function' || typeof client.response === 'function')) {
      hooks.client = {
        ...(typeof client.request === 'function' ? { request: (ctx) => client.request!(ctx) } : {}),
        ...(typeof client.response === 'function' ? { response: (ctx) => client.response!(ctx) } : {}),
      }
    }
  }
  if (isRecord(input.server) || input.server === undefined) {
    const server = input.server as AdapterHooks['server']
    if (server !== undefined && typeof server.request === 'function') {
      hooks.server = { request: (ctx) => server.request!(ctx) }
    }
  }
  return { plugin, versions: [...versions] as string[], routes: normalized, digest, declaration, hooks }
}

/** The digest of one adapter's route table: sha256 over a canonical JSON of
 * `{plugin, version, routes}` — the locator and the match mode INCLUDED (a
 * different locating rule is a different adapter), hex, first 16 chars.
 * Routes arrive path-sorted, so order never moves the hash. */
export function adapterDigestOf(plugin: string, version: string, routes: NormalizedAdapterRoute[]): string {
  const canonical = JSON.stringify({
    plugin,
    version,
    routes: routes.map((route) => ({
      path: route.path,
      match: route.match,
      methods: route.methods,
      maxBody: route.maxBody,
      stream: route.stream,
      upgrade: route.upgrade,
      locator: route.locator,
      local: route.local,
    })),
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
}

/** The prefix-match rule, shared verbatim by both halves: equality or one
 * path segment deeper, on the RAW undecoded pathname. */
export function adapterPathMatches(route: NormalizedAdapterRoute, pathname: string): boolean {
  if (route.match === 'exact') return pathname === route.path
  return pathname === route.path || pathname.startsWith(`${route.path}/`)
}

/** The adapter route a forwarded request hit, or `undefined`. `local`
 * routes never match here — they stay on the sub-client's own machine in
 * both directions, so the server half must never see (nor serve) them. */
export function matchAdapterRoute(adapters: readonly NormalizedAdapter[] | undefined, pathname: string): { adapter: NormalizedAdapter; route: NormalizedAdapterRoute } | undefined {
  if (adapters === undefined) return undefined
  for (const adapter of adapters) {
    for (const route of adapter.routes) {
      if (route.local) continue
      if (adapterPathMatches(route, pathname)) return { adapter, route }
    }
  }
  return undefined
}

/** One located session id: where it sat and the value as found. */
export interface AdapterIdHit {
  kind: 'query' | 'path-segment' | 'json-body'
  /** The query parameter or JSON field name; undefined for a path segment. */
  key: string | undefined
  value: string
}

/** Locate the session ids one request carries for one route. A query
 * parameter counts once per value it appears with; a JSON body field counts
 * when present with a non-empty string value; a path segment counts when
 * the segment exists (decoded once off the wire). */
export function locateAdapterIds(route: NormalizedAdapterRoute, pathname: string, search: URLSearchParams, body: unknown): AdapterIdHit[] {
  const hits: AdapterIdHit[] = []
  const locator = route.locator
  if (locator.in === 'query') {
    for (const value of search.getAll(locator.name)) {
      if (value !== '') hits.push({ kind: 'query', key: locator.name, value })
    }
  } else if (locator.in === 'path-segment') {
    // `index` counts the segments AFTER the declared path: /p/api + open/X
    // → index 0 is "open", index 1 is "X". In split('/') terms the prefix
    // occupies subscripts 1..prefixDepth, so the target sits one past it.
    const prefixDepth = route.path.split('/').length - 1
    const segments = pathname.split('/')
    const at = prefixDepth + 1 + locator.index
    if (at < segments.length && segments[at] !== '') {
      let decoded = segments[at]
      try {
        decoded = decodeURIComponent(segments[at])
      } catch {
        // A malformed escape stays verbatim — the value simply will not be
        // a session id.
      }
      hits.push({ kind: 'path-segment', key: undefined, value: decoded })
    }
  } else {
    if (isRecord(body)) {
      for (const field of locator.fields) {
        const value = body[field]
        if (typeof value === 'string' && value !== '') hits.push({ kind: 'json-body', key: field, value })
      }
    }
  }
  return hits
}

/** The remote/local verdict of one request (the design's rule, verbatim):
 * every located id virtual → remote; none located, or none virtual →
 * local; a MIX of virtual and plain ids → the request is malformed for the
 * bridge and refuses rather than guessing which half travels. */
export type AdapterRemoteVerdict =
  | { kind: 'remote'; hits: AdapterIdHit[] }
  | { kind: 'local' }
  | { kind: 'mixed' }

export function classifyAdapterRequest(route: NormalizedAdapterRoute, pathname: string, search: URLSearchParams, body: unknown): AdapterRemoteVerdict {
  const hits = locateAdapterIds(route, pathname, search, body)
  if (hits.length === 0) return { kind: 'local' }
  const virtual = hits.map((hit) => isVirtual(hit.value))
  if (virtual.every(Boolean)) return { kind: 'remote', hits }
  if (virtual.every((entry) => !entry)) return { kind: 'local' }
  return { kind: 'mixed' }
}

/** What {@link rewriteAdapterRequest} produces: the request coordinates
 * with every located virtual id swapped for its real half. */
export interface AdapterRewrite {
  pathname: string
  query: URLSearchParams
  /** The re-serialized JSON body for a body-locating route that arrived
   * with a body; `undefined` when there is nothing to re-serialize. */
  bodyText: string | undefined
}

/** Swap every located virtual id for its real half (the pure client-half
 * rewrite): the query is re-serialized, the path segment re-encoded, the
 * JSON body re-serialized. The re-encode direction is the wire contract —
 * `encodeURIComponent` of the real id is what the server decodes again. */
export function rewriteAdapterRequest(
  route: NormalizedAdapterRoute,
  pathname: string,
  search: URLSearchParams,
  body: unknown,
  hits: AdapterIdHit[],
  realIdOf: (virtualId: string) => string,
): AdapterRewrite {
  const rewrittenQuery = new URLSearchParams(search)
  let rewrittenPathname = pathname
  let bodyText: string | undefined
  // The body copy is made ONCE: several fields of one body can locate ids,
  // and re-copying per hit would drop every earlier field's rewrite.
  let bodyCopy: Record<string, unknown> | undefined
  for (const hit of hits) {
    const parts = fromVirtual(hit.value)
    if (parts === undefined) continue
    const real = realIdOf(hit.value)
    if (hit.kind === 'query') {
      rewrittenQuery.set(hit.key!, real)
    } else if (hit.kind === 'path-segment') {
      const prefixDepth = route.path.split('/').length - 1
      const segments = rewrittenPathname.split('/')
      segments[prefixDepth + 1 + (route.locator as { index: number }).index] = encodeURIComponent(real)
      rewrittenPathname = segments.join('/')
    } else {
      if (bodyCopy === undefined && isRecord(body)) bodyCopy = { ...body }
      if (bodyCopy !== undefined) {
        bodyCopy[hit.key!] = real
        bodyText = JSON.stringify(bodyCopy)
      }
    }
  }
  return { pathname: rewrittenPathname, query: rewrittenQuery, bodyText }
}

/** Whether the adapter still owns its plugin's registry entry, or a
 * cooperative declaration (the plugin's OWN `zenRemote.bridge(...)`, which
 * always wins) has taken the seat since: an entry with a different digest
 * means the adapter yielded. */
export function adapterOwnsRegistryEntry(adapter: NormalizedAdapter, registryEntry: { version: string; digest: string } | undefined): boolean {
  return registryEntry !== undefined && registryEntry.digest === adapter.digest && registryEntry.version === adapter.declaration.version
}

/** The largest JSON answer the client half will buffer for a response
 * rewrite: past this the body passes through untouched (8 MB). */
export const MAX_ADAPTER_RESPONSE_BUFFER_BYTES = 8 * 1024 * 1024
