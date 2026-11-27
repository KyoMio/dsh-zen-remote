/**
 * The sub-client's plain-HTTP relay and plugin block-rule wrapper, browser half
 * (T41b). The session page's changes / diff panel does not ride the typert
 * gateway — it GETs `/api/changes.summary` and `/api/changes.diff` with the
 * session id in the query (RT dsh-client-ui-deliverables/lib/client.js ~13-17,
 * 90-109, 208: plain call-time `fetch(url, { signal })`, document-relative
 * string URLs), so a remote session's virtual id would hit the LOCAL DSH and
 * 404. This module wraps `window.fetch` ONCE: a same-origin GET whose path is
 * exactly one of those two routes and whose `sessionId` parameter carries a
 * virtual id (`zr~` prefix, virtual-id.ts's skeleton — the strict parse happens
 * in the backend route) is rewritten to the sub-client relay route
 * `/_dsh/zen-remote/client/http/<route>?<original query>`, `init` (the abort
 * signal) passing through untouched.
 *
 * Callers may also pass generic {@link RemoteFetchBlockRule} entries (e.g.
 * workspace-keyed plugin routes registered by an adapter rule module) so
 * remote sessions fail closed before hitting the network and local sessions on
 * client/peer nodes carry the per-request panel-session header. Every other
 * request — and every request when `shouldAnnotateLocal` returns false (host
 * role) — reaches the original fetch unchanged.
 */

/** The two exact paths this wrapper may rewrite (the registry on the server
 * is src/relay-access.ts's RELAY_HTTP_ROUTES; the client side matches by
 * path because the URL is all it sees). */
const API_ROUTES: ReadonlySet<string> = new Set(['/api/changes.summary', '/api/changes.diff'])

/** Rule describing a same-origin fetch path class that remote sessions block
 * locally and local sessions may annotate with the panel-session header. */
export interface RemoteFetchBlockRule {
  matchPath(pathname: string): boolean
  refusalBody(): string
  status?: number
  annotateLocalHeader?: boolean
}

/** The remote-session probe, overridable in tests: whether the CURRENT
 * session on screen is a remote one, read off the html attribute
 * remote-session.ts's guard writes and remote-session.css.ts's hiding keys
 * on. Reading the attribute rather than the backend's current-session report
 * avoids the up-to-1s report lag across session switches. */
export interface RemoteSessionProbe {
  (): boolean
}
const defaultRemoteProbe: RemoteSessionProbe = () => {
  const doc = (globalThis as { document?: { documentElement?: { hasAttribute?: (name: string) => boolean } } }).document
  return doc?.documentElement?.hasAttribute?.('data-zr-remote-session') === true
}
let remoteSessionProbe: RemoteSessionProbe = defaultRemoteProbe
/**
 * Test seam: swap the remote-session probe for tests. Not part of the public
 * runtime contract.
 * @param probe - override probe, or undefined to restore the default DOM probe.
 */
export function setRemoteSessionProbeForTests(probe: RemoteSessionProbe | undefined): void {
  remoteSessionProbe = probe ?? defaultRemoteProbe
}

/** Header sent on local-session requests matching an annotating rule so the
 * backend intercept reads the same-frame page state instead of a lagged poll. */
export const PANEL_SESSION_HEADER = 'x-zen-remote-panel-session'
const PANEL_SESSION_LOCAL = 'local'

/**
 * Resolve `input` against `baseHref` and return its pathname only when it is
 * same-origin with `baseHref`. Handles string, `URL`, and Request-like objects
 * carrying a string `url`.
 * @param input - fetch input argument.
 * @param baseHref - page location base URL.
 * @returns same-origin pathname, or undefined when unparseable or cross-origin.
 */
export function resolveSameOriginPathname(input: unknown, baseHref: string): string | undefined {
  const raw = typeof input === 'string' || input instanceof URL
    ? input
    : typeof input === 'object' && input !== null && typeof (input as { url?: unknown }).url === 'string'
      ? (input as { url: string }).url
      : undefined
  if (raw === undefined) return undefined
  let parsed: URL
  let base: URL
  try {
    parsed = new URL(raw, baseHref)
    base = new URL(baseHref)
  } catch {
    return undefined
  }
  if (parsed.origin !== base.origin) return undefined
  return parsed.pathname
}

/**
 * Find the first block rule whose `matchPath` accepts the same-origin pathname
 * of `input`.
 * @param input - fetch input argument.
 * @param baseHref - page location base URL.
 * @param rules - configured block rules.
 * @returns matching rule, or undefined.
 */
export function matchFetchBlockRule(
  input: unknown,
  baseHref: string,
  rules: readonly RemoteFetchBlockRule[],
): RemoteFetchBlockRule | undefined {
  if (rules.length === 0) return undefined
  const pathname = resolveSameOriginPathname(input, baseHref)
  if (pathname === undefined) return undefined
  for (const rule of rules) {
    if (rule.matchPath(pathname)) return rule
  }
  return undefined
}

/**
 * Pure block decision: whether one fetch call must be blocked locally before
 * reaching the network.
 * @param input - fetch input argument.
 * @param baseHref - page location base URL.
 * @param isRemote - whether the active session on screen is remote.
 * @param rules - configured block rules.
 * @returns true when `isRemote` is true and a rule matches `input`.
 */
export function shouldBlockFetchCall(
  input: unknown,
  baseHref: string,
  isRemote: boolean,
  rules: readonly RemoteFetchBlockRule[],
): boolean {
  if (!isRemote) return false
  return matchFetchBlockRule(input, baseHref, rules) !== undefined
}

function mergeHeadersLowercase(target: Record<string, string>, given: unknown): void {
  if (given === undefined || given === null) return
  if (Array.isArray(given)) {
    for (const entry of given) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
        target[entry[0].toLowerCase()] = entry[1]
      }
    }
    return
  }
  if (typeof (given as { forEach?: unknown }).forEach === 'function') {
    ;(given as { forEach: (cb: (value: string, key: string) => void) => void }).forEach((value, key) => {
      target[key.toLowerCase()] = value
    })
    return
  }
  if (typeof given === 'object') {
    for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
      if (typeof value === 'string') target[key.toLowerCase()] = value
    }
  }
}

/**
 * Build a `RequestInit` carrying `x-zen-remote-panel-session: local` while
 * preserving headers from BOTH `input` (`Request` or Request-like `.headers`)
 * and `init?.headers` (plain record, tuple array, or `Headers`-like `.forEach`).
 * All header keys are normalized to lowercase so case variants cannot produce
 * duplicate headers and any prior value for the panel-session header is
 * replaced cleanly.
 * @param input - fetch input argument.
 * @param init - optional caller `RequestInit`.
 * @returns new `RequestInit` with normalized headers and the local annotation.
 */
export function annotatePanelHeader(input: unknown, init?: RequestInit): RequestInit {
  const base: Record<string, string> = {}
  const inputHeaders = (typeof Request !== 'undefined' && input instanceof Request)
    || (typeof input === 'object' && input !== null && !(input instanceof URL) && 'headers' in input)
    ? (input as { headers?: unknown }).headers
    : undefined
  mergeHeadersLowercase(base, inputHeaders)
  mergeHeadersLowercase(base, init?.headers)
  base[PANEL_SESSION_HEADER] = PANEL_SESSION_LOCAL
  return { ...(init ?? {}), headers: base }
}

/** Prefix of the sub-client backend route the rewritten calls land on. */
export const CLIENT_HTTP_ROUTE_PREFIX = '/_dsh/zen-remote/client/http/'

/** The fetch face this module wraps; injectable so tests drive a fake. */
export interface FetchHost {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  location: { href: string }
}

/** Options configuring plugin block rules and local header annotation. */
export interface InstallRemoteApiFetchOptions {
  blockRules?: readonly RemoteFetchBlockRule[]
  shouldAnnotateLocal?: () => boolean
}

/**
 * The rewrite decision, pure: the relay URL for one fetch call, or
 * `undefined` to pass through untouched. Only a GET, same-origin against
 * `baseHref`, on one of the two exact paths, with a `zr~`-prefixed
 * `sessionId` rewrites — every other shape of the world returns undefined.
 */
export function rewriteRemoteApiUrl(input: unknown, method: string, baseHref: string): string | undefined {
  if (method.toUpperCase() !== 'GET') return undefined
  if (typeof input !== 'string' && !(input instanceof URL)) return undefined
  let parsed: URL
  let base: URL
  try {
    parsed = new URL(input, baseHref)
    base = new URL(baseHref)
  } catch {
    return undefined
  }
  if (parsed.origin !== base.origin) return undefined
  if (!API_ROUTES.has(parsed.pathname)) return undefined
  const sessionId = parsed.searchParams.get('sessionId')
  if (sessionId === null || !sessionId.startsWith('zr~')) return undefined
  return `${CLIENT_HTTP_ROUTE_PREFIX}${parsed.pathname.slice('/api/'.length)}${parsed.search}`
}

/**
 * The layered install state. `active` is the wrapper's own liveness: after
 * an uninstall the wrapper function may STILL be reachable (an outer wrapper
 * installed over us keeps a reference and keeps calling us), so it degrades
 * to a plain passthrough instead of rewriting for a plugin that is gone.
 * `ownerToken` is the current install generation's ownership: every
 * installRemoteApiFetch call mints one, and only the call whose token is the
 * sitting one may actually unwrap.
 */
let originalFetch: FetchHost['fetch'] | undefined
let wrappedFetch: FetchHost['fetch'] | undefined
let active = false
let ownerToken: object | undefined
let activeBlockRules: readonly RemoteFetchBlockRule[] = []
let activeShouldAnnotateLocal: (() => boolean) | undefined

/**
 * Wrap the host's `fetch` exactly once and return the uninstaller. A call
 * while a wrap is already live adopts it (no second layer, exactly one hop),
 * updates the active options, and takes over its ownership. The wrapper reads
 * `location.href` per call, not at install time.
 * @param host - window-like object exposing `fetch` and `location.href`.
 * @param options - optional block rules and local-annotation gate.
 * @returns uninstaller function for this install generation.
 */
export function installRemoteApiFetch(host: FetchHost, options?: InstallRemoteApiFetchOptions): () => void {
  const token: object = {}
  activeBlockRules = options?.blockRules ?? []
  activeShouldAnnotateLocal = options?.shouldAnnotateLocal
  if (!active) {
    originalFetch = host.fetch
    const original = host.fetch.bind(host)
    const wrapped: FetchHost['fetch'] = (input, init) => {
      // An uninstalled wrapper still referenced by an outer wrapper passes
      // through untouched — it no longer speaks for a live install.
      if (!active) return original(input, init)
      const isRemoteNow = remoteSessionProbe()
      const matchedRule = matchFetchBlockRule(input, host.location.href, activeBlockRules)
      if (matchedRule !== undefined) {
        if (isRemoteNow) {
          return Promise.resolve(new Response(matchedRule.refusalBody(), {
            status: matchedRule.status ?? 503,
            headers: { 'content-type': 'application/json' },
          }))
        }
        if (matchedRule.annotateLocalHeader === true && (activeShouldAnnotateLocal?.() ?? false)) {
          return original(input, annotatePanelHeader(input, init))
        }
      }
      const method = init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method)
      const rewritten = rewriteRemoteApiUrl(input, method, host.location.href)
      if (rewritten === undefined) return original(input, init)
      return original(rewritten, init)
    }
    wrappedFetch = wrapped
    host.fetch = wrapped
    active = true
  }
  ownerToken = token
  return () => {
    if (ownerToken !== token) return
    ownerToken = undefined
    active = false
    activeBlockRules = []
    activeShouldAnnotateLocal = undefined
    // Restore only if nothing wrapped over us in the meantime (a later
    // wrapper's closure keeps our function reachable; pulling the property
    // would silently drop ITS wrap — ours going inert via `active` would be
    // wrong for them too, so the guard simply leaves both in place).
    if (wrappedFetch !== undefined && host.fetch === wrappedFetch && originalFetch !== undefined) {
      host.fetch = originalFetch
    }
    originalFetch = undefined
    wrappedFetch = undefined
  }
}
