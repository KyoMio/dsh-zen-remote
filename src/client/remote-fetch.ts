/**
 * The sub-client's plain-HTTP relay, browser half (T41b). The session page's
 * changes / diff panel does not ride the typert gateway — it GETs
 * `/api/changes.summary` and `/api/changes.diff` with the session id in the
 * query (RT dsh-client-ui-deliverables/lib/client.js ~13-17, 90-109, 208:
 * plain call-time `fetch(url, { signal })`, document-relative string URLs),
 * so a remote session's virtual id would hit the LOCAL DSH and 404. This
 * module wraps `window.fetch` ONCE: a same-origin GET whose path is exactly
 * one of those two routes and whose `sessionId` parameter carries a virtual
 * id (`zr~` prefix, virtual-id.ts's skeleton — the strict parse happens in
 * the backend route) is rewritten to the sub-client relay route
 * `/_dsh/zen-remote/client/http/<route>?<original query>`, `init` (the
 * abort signal) passing through untouched. Every other request — local
 * sessions, any other path, cross-origin, non-GET — reaches the original
 * fetch unchanged, so a host-role deployment (whose session ids are never
 * virtual) is bit-for-bit unintercepted.
 *
 * Not covered by THIS wrapper (each surface has its own channel since T51):
 * the attachment upload's HTTP branch runs inside a Web Worker over XHR /
 * Worker-scoped fetch — unreachable from `window.fetch`, so it is intercepted
 * one layer down, at the host's exact-fetch-route table, by
 * `src/fetch-route-intercept.ts` (which relays the bytes and likewise blocks
 * the session export); `present.host` / `changes.open` / `present.open`
 * belong to entries hidden on remote sessions rather than relayed. The
 * complete not-relayed registry still lives beside the server's in
 * src/relay-access.ts.
 */

/** The two exact paths this wrapper may rewrite (the registry on the server
 * is src/relay-access.ts's RELAY_HTTP_ROUTES; the client side matches by
 * path because the URL is all it sees). */
const API_ROUTES: ReadonlySet<string> = new Set(['/api/changes.summary', '/api/changes.diff'])

/** PB-27 finding 4: the clue surface's URL shapes. better-sidebar's clue
 * calls POST `/sidebar/api/clues.*` (the method name in the path tail —
 * `/sidebar/api/clues.list`, `/sidebar/api/clues.saveEdit`, …) and the four
 * pack share routes POST under `/sidebar/clues/share/`. All of it is
 * workspace-keyed — there is nothing a remote session may legitimately
 * read or write there, so inside a remote session these calls are blocked
 * at the fetch layer, before the network. */
const CLUE_API_PREFIX = '/sidebar/api/clues.'
const CLUE_API_EXACT = '/sidebar/api/clues'
const CLUE_SHARE_PREFIX = '/sidebar/clues/share/'

/** The remote-session probe, overridable in tests: whether the CURRENT
 * session on screen is a remote one, read off the same html attribute
 * remote-session.ts's guard writes and remote-session.css.ts's hiding keys
 * on. Reading the attribute rather than the backend's current-session
 * report is the whole point of the fix: the report lags a switch by up to
 * a second (and is shared process-wide), while the attribute moves with
 * the main view in the same frame the panels read — a local session's clue
 * load can no longer be judged by a stale remote value, and a remote
 * panel's clue call can no longer slip through a stale local one. */
export interface RemoteSessionProbe {
  (): boolean
}
const defaultRemoteProbe: RemoteSessionProbe = () => {
  const doc = (globalThis as { document?: { documentElement?: { hasAttribute?: (name: string) => boolean } } }).document
  return doc?.documentElement?.hasAttribute?.('data-zr-remote-session') === true
}
let remoteSessionProbe: RemoteSessionProbe = defaultRemoteProbe
/** Test seam: swap the probe for one install generation. Not part of the
 * public surface. */
export function setRemoteSessionProbeForTests(probe: RemoteSessionProbe | undefined): void {
  remoteSessionProbe = probe ?? defaultRemoteProbe
}

/** Whether one parsed path is a clue call the remote session must not
 * reach — the `/sidebar/api/clues.*` methods and the four share routes. */
export function isCluePath(pathname: string): boolean {
  return pathname.startsWith(CLUE_API_PREFIX) || pathname === CLUE_API_EXACT || pathname.startsWith(CLUE_SHARE_PREFIX)
}

/** The synthetic refusal answer, in the plugin's own envelope shape: the
 * clue UI unwraps `/sidebar` responses through its readEnvelope, which
 * turns a non-ok status into a SidebarApiError carrying the wire code —
 * exactly what the intercept layer's 503 refusal produces. The blocked
 * call therefore degrades inside the panel's ordinary error path instead
 * of throwing a foreign shape, and the clue surfaces are hidden by the
 * stylesheet anyway, so this response exists for the race and the
 * background pollers, not for a user to read. */
function clueBlockedBody(): string {
  return JSON.stringify({ ok: false, error: { code: 'remote-clues-unsupported', message: 'The clue library stays on this machine; it is not available in a remote session.' } })
}

/**
 * The block decision, pure: whether one fetch call is a clue request that
 * must not leave this machine. Only same-origin clue paths count, and only
 * while the probe says the session on screen is remote — local sessions
 * (and every non-clue path) pass through untouched.
 */
export function shouldBlockClueCall(input: unknown, baseHref: string, isRemote: boolean): boolean {
  if (!isRemote) return false
  // String and URL inputs, plus Request-shaped objects (a `url` string) —
  // the clue calls themselves use strings, but the wrapper wraps ALL of
  // window.fetch, so the decision must not misjudge the other shapes.
  const raw = typeof input === 'string' || input instanceof URL
    ? input
    : typeof input === 'object' && input !== null && typeof (input as { url?: unknown }).url === 'string'
      ? (input as { url: string }).url
      : undefined
  if (raw === undefined) return false
  let parsed: URL
  let base: URL
  try {
    parsed = new URL(raw, baseHref)
    base = new URL(baseHref)
  } catch {
    return false
  }
  if (parsed.origin !== base.origin) return false
  return isCluePath(parsed.pathname)
}

/** Prefix of the sub-client backend route the rewritten calls land on. */
export const CLIENT_HTTP_ROUTE_PREFIX = '/_dsh/zen-remote/client/http/'

/** The fetch face this module wraps; injectable so tests drive a fake. */
export interface FetchHost {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  location: { href: string }
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
 *
 * 行重载的次序（新实例 apply 早于旧实例 dispose）下，晚到的 install 采纳
 * 现有包装并把令牌易主——随后旧实例的卸载因令牌不再是自己的而是空操作，
 * 包装由新实例接管；真正撤销只发生在现任令牌自己的卸载上。单独一个模块级
 * `installed` 布尔做不到这一点：旧实例的卸载会撤掉新实例正依赖的包装。
 */
let originalFetch: FetchHost['fetch'] | undefined
let wrappedFetch: FetchHost['fetch'] | undefined
let active = false
let ownerToken: object | undefined

/**
 * Wrap the host's `fetch` exactly once and return the uninstaller. A call
 * while a wrap is already live adopts it (no second layer, exactly one hop)
 * and takes over its ownership. The wrapper reads `location.href` per call,
 * not at install time.
 */
export function installRemoteApiFetch(host: FetchHost): () => void {
  const token: object = {}
  if (!active) {
    originalFetch = host.fetch
    const original = host.fetch.bind(host)
    const wrapped: FetchHost['fetch'] = (input, init) => {
      // An uninstalled wrapper still referenced by an outer wrapper passes
      // through untouched — it no longer speaks for a live install.
      if (!active) return original(input, init)
      // PB-27 finding 4: inside a remote session the clue surface is OFF —
      // its entry points are hidden by the stylesheet and its calls are
      // blocked HERE, before the network. The probe reads the same html
      // attribute the hiding keys on, so the block moves with the session
      // switch in the same frame and never inherits the backend report's
      // 1 s lag in either direction.
      if (shouldBlockClueCall(input, host.location.href, remoteSessionProbe())) {
        return Promise.resolve(new Response(clueBlockedBody(), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }))
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
