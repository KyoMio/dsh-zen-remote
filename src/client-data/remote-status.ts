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
 * - `getRemoteStatusStore()` is the page-wide singleton.
 */

import { createLatestGate } from './settings-form.ts'
import { zh } from '../client/locales.ts'

/** Same-origin client route feeding this store (host half: T34,
 * src/client-routes.ts). */
export const REMOTE_STATUS_ROUTE = '/_dsh/zen-remote/client/remote-status'

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
    asOf: now,
  }
}

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
  | 'remoteBannerClosedIdle'
  | 'remoteBannerClosedManual'
  | 'remoteBannerClosedClient'

export type RemoteBannerFormatter = (key: RemoteBannerTextKey) => string

/**
 * The composer banner copy for one virtual session (T34): the session's
 * closed reason — if the server closed this session — outranks the offline
 * line; a merely offline link reads the temporarily-readonly copy. `undefined`
 * when neither applies (online and not closed): no banner.
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
  if (view !== undefined && view !== null && view.state === 'offline') return t('remoteBannerOffline')
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
}

/** Poll cadence while the page is visible and at least one part is mounted
 * (T34: 15 秒). */
export const REMOTE_STATUS_POLL_MS = 15_000

/**
 * Build one store over an injectable fetch and visibility source — the
 * shares-store discipline: latest-wins (an earlier request answering late
 * never overwrites a newer table), every GET failure fails its own round,
 * the timer is real while visible and gone while hidden, and becoming
 * visible pulls once immediately. `pollMs` exists for tests: the shipped
 * cadence is far too slow to observe.
 */
export function createRemoteStatusStore(
  fetchImpl: typeof fetch,
  visibility: VisibilitySource = documentVisibility,
  pollMs: number = REMOTE_STATUS_POLL_MS,
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

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      syncPolling()
      return () => {
        listeners.delete(listener)
        syncPolling()
      }
    },
    refresh,
    unshare,
  }
}

let singleton: RemoteStatusStore | undefined

/** The page-wide store every registered part reads — one poll loop no
 * matter how many of the icon and banner parts are mounted at once. Created
 * lazily over the real fetch, so check scripts never construct it. */
export function getRemoteStatusStore(): RemoteStatusStore {
  singleton ??= createRemoteStatusStore((input, init) => fetch(input, init))
  return singleton
}
