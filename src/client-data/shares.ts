/**
 * Session-sharing data for the browser half (T33b): the shared-session table
 * behind the three entry points (session "…" menu item, title-row remote
 * icon, settings-page shared list). Browser-import-free so
 * scripts/check-shares.mjs drives it directly with a fake fetch:
 *
 * - `parseSharesBody(body, now)` maps the `GET /_dsh/zen-remote/admin/shares`
 *   body (T33a: `{ ok, shares:[{ sessionId, sharedAt, lastActivityAt, busy,
 *   remainingMs(null=忙碌), viewers, title }] }`) into tolerant view entries,
 *   each stamped with the parse time so `describeShare` can let the idle
 *   countdown tick between polls;
 * - `describeShare(entry, now, t?)` maps one entry (or the absence of one)
 *   to the icon's three states — off / on / watched (a desktop client is
 *   viewing) — plus the hover line (idle time left, or the busy copy);
 * - `createSharesStore(fetchImpl)` is the subscription store every part
 *   shares: latest-wins GETs, visibility-aware polling (fetch once on
 *   becoming visible, then every 30 s; paused while hidden; started by the
 *   first subscriber, stopped by the last), and the three POST actions that
 *   refresh immediately after landing. A 404 latches `available: false` and
 *   stops the polling for good — the shares route exists only on the host
 *   role, so that latch is the client-role gate for the T33b parts;
 * - `getSharesStore()` is the page-wide singleton the registered components
 *   read, so exactly one poll loop exists no matter how many parts mount.
 */

import { createLatestGate } from './settings-form.ts'
import { zh } from '../client/locales.ts'

/** Same-origin admin shares route (host half: T33a, src/admin-routes.ts). */
export const ADMIN_SHARES_ROUTE = '/_dsh/zen-remote/admin/shares'

/** One shared session as the parts render it. `asOf` is the parse time that
 * anchors the local countdown decay (the wire has no such field). */
export interface ShareEntryView {
  sessionId: string
  sharedAt: number
  lastActivityAt: number
  busy: boolean
  /** Idle time left at `asOf`; null = busy (not counting down). */
  remainingMs: number | null
  viewers: number
  title: string | null
  /** When this row was parsed off a GET body (Date.now() of the refresh). */
  asOf: number
}

/** Everything the parts read off the store, one frozen object per change. */
export interface SharesSnapshot {
  /** One GET has answered ok — parts render nothing before this. */
  ready: boolean
  /** The shares route exists here (host role). A 404 latches this false. */
  available: boolean
  entries: readonly ShareEntryView[]
}

/** The locale keys `describeShare` needs, as its formatter accepts them. */
export type ShareTextKey =
  | 'shareRemoteStateOff'
  | 'shareRemoteBusy'
  | 'shareRemoteRemainingHours'
  | 'shareRemoteRemainingMinutes'

/** Minimal shape of the framework `t` seat over the plugin's namespace. */
export type ShareTextFormatter = (key: ShareTextKey, params?: Record<string, number>) => string

/** `{count}` interpolation, the same contract the locale dictionaries use. */
function interpolate(text: string, params: Record<string, number> | undefined): string {
  return params === undefined ? text : text.replace(/\{(\w+)\}/g, (raw, key: string) => (
    Object.hasOwn(params, key) ? String(params[key]) : raw
  ))
}

/** Default formatter: the plugin's Chinese dictionary (the key-set source of
 * truth). Components pass their real framework `t`, so the default only
 * serves the pure-function callers (check script, non-React reads). */
export function createZhShareFormatter(): ShareTextFormatter {
  return (key, params) => interpolate(zh[key], params)
}

/** The icon's three states and the hover line (T33b spec). */
export interface ShareDescription {
  state: 'off' | 'on' | 'watched'
  remainingText: string
}

/**
 * Map one entry — or the absence of one — to the remote icon's state and its
 * hover text. The idle countdown decays locally from the entry's `asOf` stamp
 * (a ≤30 s-poll skew beats a frozen number), floors at zero, reads as hours
 * once above the hour and minutes below it, and swaps to the busy copy when
 * the session is not counting down at all. A session with a desktop client
 * watching reads `watched` regardless of the countdown — the countdown stays
 * in the hover text.
 */
export function describeShare(
  entry: ShareEntryView | undefined | null,
  now: number,
  t: ShareTextFormatter = createZhShareFormatter(),
): ShareDescription {
  if (entry === undefined || entry === null) return { state: 'off', remainingText: t('shareRemoteStateOff') }
  const remaining = entry.remainingMs
  if (entry.busy || remaining === null) {
    return { state: entry.viewers > 0 ? 'watched' : 'on', remainingText: t('shareRemoteBusy') }
  }
  const left = Math.max(0, remaining - Math.max(0, now - entry.asOf))
  const minutes = Math.max(1, Math.ceil(left / 60_000))
  const remainingText = minutes >= 60
    ? t('shareRemoteRemainingHours', { count: Math.round(left / 3_600_000) })
    : t('shareRemoteRemainingMinutes', { count: minutes })
  return { state: entry.viewers > 0 ? 'watched' : 'on', remainingText }
}

/** Parse one GET body tolerantly: a garbage shape is an empty table, a
 * garbage row is dropped — never a throw into the polling loop. */
export function parseSharesBody(body: unknown, now: number): ShareEntryView[] {
  const raw = body !== null && typeof body === 'object'
    ? (body as { shares?: unknown }).shares
    : undefined
  if (!Array.isArray(raw)) return []
  const entries: ShareEntryView[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (typeof row.sessionId !== 'string' || row.sessionId === '') continue
    const finite = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined
    const remaining = row.remainingMs === null ? null : finite(row.remainingMs) ?? null
    entries.push({
      sessionId: row.sessionId,
      sharedAt: finite(row.sharedAt) ?? 0,
      lastActivityAt: finite(row.lastActivityAt) ?? 0,
      // On the wire remainingMs is null exactly when the session is busy.
      busy: row.busy === true || remaining === null,
      remainingMs: remaining,
      viewers: Math.max(0, Math.trunc(finite(row.viewers) ?? 0)),
      title: typeof row.title === 'string' && row.title !== '' ? row.title : null,
      asOf: now,
    })
  }
  return entries
}

/** The store face the three T33b parts share. */
export interface SharesStore {
  /** The current snapshot — a stable frozen reference until the next change. */
  getSnapshot(): SharesSnapshot
  /** Observe snapshot replacements; the FIRST subscriber starts the poll
   * loop, the LAST unsubscriber stops it. */
  subscribe(listener: () => void): () => void
  /** GET now (latest-wins). @returns whether an ok body landed. */
  refresh(): Promise<boolean>
  /** POST share, then refresh immediately. @returns whether the POST landed. */
  share(sessionId: string): Promise<boolean>
  /** POST unshare for one session, then refresh. @returns POST outcome. */
  unshare(sessionId: string): Promise<boolean>
  /** POST unshare-all, then refresh. @returns POST outcome. */
  unshareAll(): Promise<boolean>
}

/** Poll cadence while the page is visible and at least one part is mounted. */
export const SHARES_POLL_MS = 30_000

/**
 * Build one store over an injectable fetch. The GET is latest-wins (T16's
 * gate): an earlier request answering late never overwrites a newer table.
 * A 404 — the shares route does not exist here, i.e. this deployment is not
 * the host — latches `available: false` and retires the poll loop; every
 * other failure keeps the last ready table on screen.
 */
export function createSharesStore(fetchImpl: typeof fetch): SharesStore {
  const gate = createLatestGate()
  const listeners = new Set<() => void>()
  let snapshot: SharesSnapshot = Object.freeze({ ready: false, available: true, entries: Object.freeze([]) })
  // The 404 latch: once the route is known absent, polling never starts again.
  let available = true
  let interval: ReturnType<typeof setInterval> | undefined
  let visibilityHooked = false

  const publish = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const applyBody = (body: unknown): void => {
    snapshot = Object.freeze({
      ready: true,
      available: true,
      entries: Object.freeze(parseSharesBody(body, Date.now())),
    })
    publish()
  }

  const refresh = async (): Promise<boolean> => {
    if (!available) return false
    const ticket = gate.next()
    try {
      const res = await fetchImpl(ADMIN_SHARES_ROUTE, { cache: 'no-store' })
      if (res.status === 404) {
        available = false
        stopPolling()
        snapshot = Object.freeze({ ready: false, available: false, entries: Object.freeze([]) })
        publish()
        return false
      }
      if (!res.ok) return false
      const body = await res.json().catch(() => undefined) as unknown
      if (body === undefined || (body as { ok?: unknown }).ok !== true) return false
      if (!gate.isLatest(ticket)) return false
      applyBody(body)
      return true
    } catch {
      return false
    }
  }

  const post = async (payload: Record<string, unknown>): Promise<boolean> => {
    try {
      const res = await fetchImpl(ADMIN_SHARES_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({})) as { ok?: unknown }
      if (!(res.ok && body.ok === true)) return false
    } catch {
      return false
    }
    // The action landed — the table must say so before the next poll tick.
    await refresh()
    return true
  }

  const tick = (): void => {
    // setInterval keeps firing while hidden; the fetch inside is what the
    // visibility gate stops, so a hidden page stays request-free.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    void refresh()
  }

  const onVisibility = (): void => {
    if (interval === undefined) return
    // Becoming visible pulls once immediately; hiding just stops the timer
    // (the tick's own gate covers the race in between).
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void refresh()
  }

  const startPolling = (): void => {
    if (!available || interval !== undefined) return
    void refresh()
    interval = setInterval(tick, SHARES_POLL_MS)
    if (!visibilityHooked && typeof document !== 'undefined') {
      visibilityHooked = true
      document.addEventListener('visibilitychange', onVisibility)
    }
  }

  const stopPolling = (): void => {
    if (interval !== undefined) {
      clearInterval(interval)
      interval = undefined
    }
    if (visibilityHooked && typeof document !== 'undefined') {
      visibilityHooked = false
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      if (listeners.size === 1) startPolling()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stopPolling()
      }
    },
    refresh,
    share: (sessionId: string) => post({ action: 'share', sessionId }),
    unshare: (sessionId: string) => post({ action: 'unshare', sessionId }),
    unshareAll: () => post({ action: 'unshare-all' }),
  }
}

let singleton: SharesStore | undefined

/** The page-wide store every registered part reads — one poll loop no
 * matter how many of the menu items, the header icon and the settings
 * list are mounted at once. Created lazily over the real fetch, so the
 * check script never constructs it. */
export function getSharesStore(): SharesStore {
  singleton ??= createSharesStore((input, init) => fetch(input, init))
  return singleton
}
