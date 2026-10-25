/**
 * Remote-session status data for the browser half (T34): the poll store
 * behind the two sub-client parts — the title-row connection icon and the
 * composer's readonly banner. Built as a mirror of shares.ts (T33b):
 * browser-import-free so the desktop-gate test and check scripts drive it
 * with a fake fetch.
 *
 * - `parseRemoteStatusBody(body, now)` maps the
 *   `GET /_dsh/zen-remote/client/remote-status` body
 *   (`{ state, versionMismatch, serverName, closed }`) into a tolerant view;
 * - `describeRemoteStatus(view)` maps one view to the icon's three states —
 *   online (lit) / offline (grey; `revoked` / `unpaired` count as offline —
 *   the link is not serving either way) / mismatch (yellow, only ever while
 *   online) — plus the hover line;
 * - `bannerText(view, sessionId)` picks the composer banner copy for one
 *   session: the closed reason (idle / manual / client) outranks the offline
 *   line — a closed session stays closed even while the server is down;
 * - `createRemoteStatusStore(fetchImpl, visibility?, pollMs?)` is the
 *   subscription store both parts share. There is NO role gate here (unlike
 *   shares.ts): both roles register the parts, and the parts subscribe only
 *   while a VIRTUAL-id session is on screen — a host page (local sessions
 *   only) never opens a subscription, so nothing polls. A failed GET fails
 *   exactly its own round; the poll cadence is visibility-shaped like the
 *   shares store's;
 * - `subscribeIfVirtual(store, sessionId, listener)` is the subscribe face
 *   the parts hand `useSyncExternalStore`: the virtual-id gate lives HERE,
 *   so a local session mounts without ever opening a subscription;
 * - `getRemoteStatusStore()` is the page-wide singleton.
 */

import { createLatestGate } from './settings-form.ts'
import { isVirtual } from '../virtual-id.ts'
import { zh } from '../client/locales.ts'

/** Same-origin client route feeding this store (host half: T34,
 * src/client-routes.ts). */
export const REMOTE_STATUS_ROUTE = '/_dsh/zen-remote/client/remote-status'
/** the browser's network-restored hint (POST). */
export const NETWORK_HINT_ROUTE = '/_dsh/zen-remote/client/network-hint'

/** Same-origin client route closing one remote session from this machine. */
export const CLIENT_UNSHARE_ROUTE = '/_dsh/zen-remote/client/unshare'

/** The relay's serving state, as the route words it. */
export type RemoteStatusState = 'online' | 'offline' | 'revoked' | 'unpaired'

/** Why the server closed a session's remote access. */
export type RemoteClosedReason = 'manual' | 'client' | 'idle'

/** One parsed status body, stamped with the parse time for future decay. */
export interface RemoteStatusView {
  state: RemoteStatusState
  versionMismatch: boolean
  serverName: string
  closed: Readonly<Record<string, RemoteClosedReason>>
  /** The plugins whose bridge verdict is bridged RIGHT NOW (PB-2; sorted
   * server-side). A garbage or missing field degrades to the empty list —
   * nothing is ever considered bridged on a shape the parse does not
   * trust. */
  bridgedPlugins: readonly string[]
  /** When this view was parsed off a GET body. */
  asOf: number
}

/** Everything the parts read off the store, one frozen object per change. */
export interface RemoteStatusSnapshot {
  /** One GET has answered ok — parts render nothing before this. */
  ready: boolean
  view: RemoteStatusView | undefined
}

/** Parse one GET body tolerantly: a garbage shape is "not online yet", a
 * garbage field degrades to its default — never a throw into the polling
 * loop. */
export function parseRemoteStatusBody(body: unknown, now: number): RemoteStatusView {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const state = record.state === 'online' || record.state === 'revoked' || record.state === 'unpaired' ? record.state : 'offline'
  const closed: Record<string, RemoteClosedReason> = {}
  if (record.closed !== null && typeof record.closed === 'object') {
    for (const [sessionId, reason] of Object.entries(record.closed as Record<string, unknown>)) {
      if (sessionId === '') continue
      closed[sessionId] = reason === 'client' || reason === 'idle' ? reason : 'manual'
    }
  }
  return {
    state,
    versionMismatch: record.versionMismatch === true,
    serverName: typeof record.serverName === 'string' ? record.serverName : '',
    closed,
    bridgedPlugins: Array.isArray(record.bridgedPlugins)
      ? record.bridgedPlugins.filter((name): name is string => typeof name === 'string' && name !== '')
      : [],
    asOf: now,
  }
}

// --- the bridge stamp (PB-14) -----------------------------------------------

/**
 * Whether ONE plugin's bridge verdict is bridged RIGHT NOW, judged off the
 * `bridgedPlugins` list the remote-status body carries. Tolerant by the
 * same discipline as the parse: a garbage list (an older server that never
 * learned the field, a broken body) reads as "not bridged" — the hiding
 * rules stay in force unless the server positively says otherwise, never
 * the reverse. This is the pure core behind the
 * `html[data-zr-bridge-<plugin>]` stamp the remote-session stylesheet
 * spends.
 */
export function shouldStampBridgeAttribute(bridgedPlugins: unknown, plugin: string): boolean {
  return Array.isArray(bridgedPlugins) && bridgedPlugins.includes(plugin)
}

/** The plugin the bridge stamp names. */
export const BRIDGE_STAMP_PLUGIN = 'dsh-better-sidebar'

/** The html attribute the stamp writes (`data-zr-bridge-dsh-better-sidebar`). */
export const BRIDGE_STAMP_ATTRIBUTE = `data-zr-bridge-${BRIDGE_STAMP_PLUGIN}`

// --- the icon's states -------------------------------------------------------

/** The locale keys `describeRemoteStatus` needs. */
export type RemoteStatusTextKey =
  | 'remoteStatusOnline'
  | 'remoteStatusOffline'
  | 'remoteStatusMismatch'
  | 'remoteStatusRevoked'
  | 'remoteStatusUnpaired'

/** Minimal shape of the framework `t` seat over the plugin's namespace. */
export type RemoteStatusFormatter = (key: RemoteStatusTextKey) => string

/** Default formatter: the plugin's Chinese dictionary. Components pass their
 * real framework `t`; this serves the pure-function callers (tests, check
 * scripts). */
export function createZhRemoteStatusFormatter(): RemoteStatusFormatter {
  return (key) => zh[key]
}

/** The icon's states and its hover line (T34, refined by T34-fix): online
 * (lit), offline (grey, reconnecting), mismatch (yellow, only ever while
 * online — an offline link outranks it), and `revoked` / `unpaired` as
 * states of their OWN (T34-fix) — the hover and the click say the precise
 * word, never "reconnecting", because neither recovers on its own. */
export interface RemoteStatusDescription {
  state: 'online' | 'offline' | 'mismatch' | 'revoked' | 'unpaired'
  hoverText: string
}

export function describeRemoteStatus(
  view: RemoteStatusView | undefined | null,
  t: RemoteStatusFormatter = createZhRemoteStatusFormatter(),
): RemoteStatusDescription {
  if (view === undefined || view === null) return { state: 'offline', hoverText: t('remoteStatusOffline') }
  if (view.state === 'revoked') return { state: 'revoked', hoverText: t('remoteStatusRevoked') }
  if (view.state === 'unpaired') return { state: 'unpaired', hoverText: t('remoteStatusUnpaired') }
  if (view.state === 'online') {
    return view.versionMismatch
      ? { state: 'mismatch', hoverText: t('remoteStatusMismatch') }
      : { state: 'online', hoverText: t('remoteStatusOnline') }
  }
  return { state: 'offline', hoverText: t('remoteStatusOffline') }
}

// --- the composer banner copy ------------------------------------------------

/** The locale keys `bannerText` needs. */
export type RemoteBannerTextKey =
  | 'remoteBannerOffline'
  | 'remoteBannerRevoked'
  | 'remoteBannerUnpaired'
  | 'remoteBannerClosedIdle'
  | 'remoteBannerClosedManual'
  | 'remoteBannerClosedClient'

export type RemoteBannerFormatter = (key: RemoteBannerTextKey) => string

/**
 * The composer banner copy for one virtual session (T34): the session's
 * closed reason — if the server closed this session — outranks the
 * link-level lines (offline, T41a-fix2's revoked / unpaired); a merely
 * offline link reads the temporarily-readonly copy, and a revoked token or
 * an unpaired client reads the "not coming back on its own" copy — both
 * stand a banner AND disable the input (the component raises its composer
 * block from whatever this returns), since neither recovers without the
 * settings page. `undefined` when nothing applies (online and not closed):
 * no banner.
 */
export function bannerText(
  view: RemoteStatusView | undefined | null,
  sessionId: string,
  t: RemoteBannerFormatter = (key) => zh[key],
): string | undefined {
  const reason = view?.closed[sessionId]
  if (reason === 'idle') return t('remoteBannerClosedIdle')
  if (reason === 'client') return t('remoteBannerClosedClient')
  // 'manual' — and any word this build does not know (a newer server's
  // vocabulary): a closure with no certain reason reads as the manual close.
  if (reason !== undefined) return t('remoteBannerClosedManual')
  if (view !== undefined && view !== null) {
    if (view.state === 'offline') return t('remoteBannerOffline')
    // T41a-fix2: a revoked token / an unpaired client is not "reconnecting"
    // — the composer must not sit disabled on a promise no reconnect keeps.
    if (view.state === 'revoked') return t('remoteBannerRevoked')
    if (view.state === 'unpaired') return t('remoteBannerUnpaired')
  }
  return undefined
}

// --- the store ---------------------------------------------------------------

/** Whether the page is currently visible — the same seam shares.ts uses to
 * keep the poll cadence visibility-shaped (testable via injection). */
export interface VisibilitySource {
  visible(): boolean
  subscribe(listener: () => void): () => void
}

/** The real source: `visibilitychange` off `document` (Node: always visible,
 * never notifying). */
export const documentVisibility: VisibilitySource = {
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  subscribe: (listener) => {
    if (typeof document === 'undefined') return () => {}
    document.addEventListener('visibilitychange', listener)
    return () => { document.removeEventListener('visibilitychange', listener) }
  },
}

// --- the NETWORK-RESTORED hint source ---------------

/**
 * the browser-side signal that a previously broken
 * link MAY be back. Two triggers, both cheap and event-driven (never polled):
 *
 *  - `window`'s `online` event — the browser's own reachability flag going
 *    true. Note this is a HINT, never proof: `navigator.onLine === true`
 *    means "an interface is up", not "the host is reachable". The host
 *    resolves the question with an authenticated `/ping` before anything
 *    reconnects.
 *  - `visibilitychange` → visible: a backgrounded tab (throttled timers, a
 *    possibly-changed network) coming back is the other moment a stale
 *    `offline` is most likely, and it costs one hint at most.
 *
 * Deliberately NOT wired: `window`'s `offline` event. Going offline needs no
 * action (the poll and the streams already notice), and firing a hint there
 * would only produce refused round-trips.
 */
export interface NetworkHintSource {
  /** Attach; the returned function detaches. */
  subscribe(listener: () => void): () => void
}

/** The real source (Node / SSR: never notifying — a host has no navigator). */
export const windowNetworkHint: NetworkHintSource = {
  subscribe: (listener) => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
    const onOnline = (): void => { listener() }
    const onVisibility = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') listener()
    }
    window.addEventListener('online', onOnline)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('online', onOnline)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    }
  },
}

/** How one `client/unshare` POST ended. A refused action carries the
 * backend's error `code` when it sent one (`not-shared`, `remote-mismatch`,
 * …). */
export type RemoteUnshareOutcome =
  | { ok: true }
  | { ok: false, code?: string, message?: string }

/** The store face the two T34 parts share. */
export interface RemoteStatusStore {
  /** The current snapshot — a stable frozen reference until the next change. */
  getSnapshot(): RemoteStatusSnapshot
  /** Observe snapshot replacements; polling runs while at least one listener
   * is attached AND the page is visible. */
  subscribe(listener: () => void): () => void
  /** GET now (latest-wins). @returns whether an ok body landed. */
  refresh(): Promise<boolean>
  /** POST client/unshare for one VIRTUAL session id, then refresh.
   * @returns the action's outcome. */
  unshare(sessionId: string): Promise<RemoteUnshareOutcome>

  /** fire one network-restored hint now (the same
   * controlled round the window `online` event drives). Exposed for tests
   * and for a host-side manual probe; never bypasses the host's probe. */
  notifyNetworkRestored(): void
}

/** Poll cadence while the page is visible and at least one part is mounted
 * (T34: 15 秒). */
export const REMOTE_STATUS_POLL_MS = 15_000

/** The minimum gap between two client-side network hints — the same 3s the
 * host's `networkRestored()` enforces, so the two never fight. `hintGapMs`
 * injects a smaller one (tests). */
const NETWORK_HINT_CLIENT_GAP_MS = 3_000

/**
 * Build one store over an injectable fetch and visibility source — the
 * shares-store discipline: latest-wins (an earlier request answering late
 * never overwrites a newer table), every GET failure fails its own round,
 * the timer is real while visible and gone while hidden, and becoming
 * visible pulls once immediately. `pollMs` exists for tests: the shipped
 * cadence is far too slow to observe. `hintGapMs` exists for the same
 * reason: the shipped hint gap (default 3000) is far too slow to observe.
 */
export function createRemoteStatusStore(
  fetchImpl: typeof fetch,
  visibility: VisibilitySource = documentVisibility,
  pollMs: number = REMOTE_STATUS_POLL_MS,
  /** the network-restored hint source. Omitted → no
   * hint wiring (a host mount, or a test). */
  networkHint?: NetworkHintSource,
  /** the minimum gap between two client-side hints, ms; default 3000 (the
   * same anti-storm gap the host enforces). Exists for tests, like
   * `pollMs`: the shipped gap is far too slow to observe. */
  hintGapMs: number = NETWORK_HINT_CLIENT_GAP_MS,
): RemoteStatusStore {
  const gate = createLatestGate()
  const listeners = new Set<() => void>()
  let snapshot: RemoteStatusSnapshot = Object.freeze({ ready: false, view: undefined })
  let timer: ReturnType<typeof setInterval> | undefined
  let offVisibility: (() => void) | undefined

  const publish = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const applyBody = (body: unknown): void => {
    snapshot = Object.freeze({ ready: true, view: Object.freeze(parseRemoteStatusBody(body, Date.now())) })
    publish()
  }

  const refresh = async (): Promise<boolean> => {
    const ticket = gate.next()
    try {
      const res = await fetchImpl(REMOTE_STATUS_ROUTE, { cache: 'no-store' })
      if (!gate.isLatest(ticket)) return false
      // 404 during a plugin reload, a 5xx, a broken body — all fail exactly
      // this round: keep the last view, answer false, retry next tick.
      if (!res.ok) return false
      const body = await res.json().catch(() => undefined) as unknown
      if (body === undefined || body === null || typeof body !== 'object') return false
      if (!gate.isLatest(ticket)) return false
      applyBody(body)
      return true
    } catch {
      return false
    }
  }

  const unshare = async (sessionId: string): Promise<RemoteUnshareOutcome> => {
    let outcome: RemoteUnshareOutcome = { ok: false }
    try {
      const res = await fetchImpl(CLIENT_UNSHARE_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const body = await res.json().catch(() => ({})) as { ok?: unknown, error?: { code?: unknown, message?: unknown } }
      if (res.ok && body.ok === true) outcome = { ok: true }
      else {
        outcome = { ok: false }
        const error = body.error !== null && typeof body.error === 'object' ? body.error : {}
        if (typeof error.code === 'string') outcome.code = error.code
        if (typeof error.message === 'string') outcome.message = error.message
      }
    } catch {
      outcome = { ok: false }
    }
    // The action landed (or demonstrably failed) — refresh so the next
    // render reflects the table the route now serves.
    void refresh()
    return outcome
  }

  const startTimer = (): void => {
    if (timer === undefined) timer = setInterval(() => { void refresh() }, pollMs)
  }

  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  const onVisibility = (): void => {
    if (listeners.size === 0) return
    if (visibility.visible()) {
      // Becoming visible pulls once immediately, then resumes the cadence.
      void refresh()
      startTimer()
    } else {
      // Hidden: the timer is really gone, not just gated inside the tick.
      stopTimer()
    }
  }

  /** Reconcile the poll machinery with (listeners, visibility). */
  const syncPolling = (): void => {
    if (listeners.size === 0) {
      stopTimer()
      if (offVisibility !== undefined) {
        offVisibility()
        offVisibility = undefined
      }
      return
    }
    if (offVisibility === undefined) offVisibility = visibility.subscribe(onVisibility)
    if (!visibility.visible()) {
      stopTimer()
      return
    }
    if (timer === undefined) {
      // Fresh run — first subscriber (or a return to visibility): pull once
      // right away instead of leaving the first view one cadence away.
      void refresh()
      startTimer()
    }
  }

  // ONE controlled round per hint.
  //
  // The chain is: hint → POST client/network-hint → host runs probeHealth()
  // (authenticated GET /ping) → only a reachable host advances to
  // networkRestored() (which is itself offline-only + 3s-gapped) → the next
  // status poll reflects the new state, and the intercept layer's $zr/events
  // leg reopens on its own once the relay reads online.
  //
  // THREE client-side guards keep a flapping machine from turning the hint
  // into a poll: a healthy-link gate (the last status read said `online` —
  // nothing to retire), an in-flight slot (one hint at a time), and a
  // minimum gap (the same 3s the host enforces, so the two never fight).
  let hintInFlight = false
  let lastHintAt = 0

  const sendNetworkHint = async (): Promise<void> => {
    // The healthy-link gate: a hint exists to retire a stale `offline`. While
    // the last status read says `online`, a tab switch or a browser `online`
    // event must not spend the hint→ping→refresh triple. `view` undefined
    // (no GET answered yet) passes — conservative before the first read.
    if (snapshot.view?.state === 'online') return
    if (hintInFlight) return
    const now = Date.now()
    if (now - lastHintAt < hintGapMs) return
    lastHintAt = now
    hintInFlight = true
    try {
      await fetchImpl(NETWORK_HINT_ROUTE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    } catch {
      // A hint that cannot be delivered is simply dropped — the poll and the
      // streams are still the truth, and the next event tries again.
    } finally {
      hintInFlight = false
      // Whatever the hint achieved, re-read the status so the UI stops
      // showing a stale `offline` the moment the host is back.
      void refresh()
    }
  }

  let offNetworkHint: (() => void) | undefined
  const startHintWiring = (): void => {
    if (networkHint === undefined || offNetworkHint !== undefined) return
    offNetworkHint = networkHint.subscribe(() => { void sendNetworkHint() })
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      syncPolling()
      startHintWiring()
      return () => {
        listeners.delete(listener)
        syncPolling()
        // The hint listener follows the subscribers: no page, no hints.
        if (listeners.size === 0 && offNetworkHint !== undefined) {
          offNetworkHint()
          offNetworkHint = undefined
        }
      }
    },
    refresh,
    unshare,
    /** explicit hint trigger (tests / manual probe). */
    notifyNetworkRestored: () => { void sendNetworkHint() },
  }
}

let singleton: RemoteStatusStore | undefined

/**
 * The subscribe face both T34 parts hand `useSyncExternalStore`: a VIRTUAL-id
 * session subscribes to the store — the subscription is what keeps it
 * polling — while a local session gets a no-op, so a page showing only local
 * sessions (a host's own view of itself) never opens a subscription and never
 * sends a remote-status request. Pure over (store, sessionId) so the
 * desktop-gate test drives it with a counting fake fetch.
 */
export function subscribeIfVirtual(store: RemoteStatusStore, sessionId: string, listener: () => void): () => void {
  return isVirtual(sessionId) ? store.subscribe(listener) : () => {}
}

/** The page-wide store every registered part reads — one poll loop no
 * matter how many of the icon and banner parts are mounted at once. Created
 * lazily over the real fetch, so check scripts never construct it. */
export function getRemoteStatusStore(): RemoteStatusStore {
  // the REAL entry wiring. The network-hint source is
  // passed here and nowhere else, so every mounted remote part (icon + banner)
  // shares ONE store and therefore ONE hint subscription — no per-component
  // listeners, no duplicate POSTs.
  //
  // Node / SSR: `windowNetworkHint.subscribe` returns a no-op detacher and
  // never fires (there is no `window`), so a host mount is unaffected.
  singleton ??= createRemoteStatusStore(
    (input, init) => fetch(input, init),
    documentVisibility,
    REMOTE_STATUS_POLL_MS,
    windowNetworkHint,
  )
  return singleton
}
