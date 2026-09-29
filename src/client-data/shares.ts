/**
 * Session-sharing data for the browser half (T33b + T33b-fix): the
 * shared-session table behind the three entry points (session "…" menu
 * item, title-row remote icon, settings-page shared list).
 * Browser-import-free so scripts/check-shares.mjs drives it directly with a
 * fake fetch:
 *
 * - `parseSharesBody(body, now)` maps the `GET /_dsh/zen-remote/admin/shares`
 *   body (T33a: `{ ok, shares:[{ sessionId, sharedAt, lastActivityAt, busy,
 *   remainingMs(null=忙碌), viewers, title }] }`) into tolerant view entries,
 *   each stamped with the parse time so `describeShare` can let the idle
 *   countdown tick between polls;
 * - `describeShare(entry, now, t?)` maps one entry (or the absence of one)
 *   to the icon's three states — off / on / watched (a desktop client is
 *   viewing) — plus the hover line (idle time left, or the busy copy);
 * - `shareFailText(outcome, action, t)` maps a refused share/unshare to the
 *   one-line `window.alert` copy, keyed by the server's error code;
 * - `createSharesStore(fetchImpl, visibility?, pollMs?)` is the subscription
 *   store every part shares. The ROLE gates everything (T33b-fix): until
 *   the registration wires a role nothing polls and nothing renders; only
 *   a host polls. A failed GET — 404 during a plugin reload, a dropped
 *   connection, anything — fails exactly its own round: the last table
 *   stays on screen and the next tick asks again; no latch, no permanent
 *   shutdown. The poll cadence is visibility-shaped: the timer only runs
 *   while the page is visible, becoming visible pulls once immediately;
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
  /**
   * The deployment role, wired by the registration from the SAME decision
   * the settings page makes (row document first, client-config probe as the
   * fallback — settings-form.ts's settingsRoleOf). `'unknown'` until that
   * wiring answers: nothing polls, the parts render nothing. `'client'`
   * hides the parts and stops the polling; switching back to host resumes.
   */
  role: 'unknown' | 'host' | 'client'
  /** One GET has answered ok — parts render nothing before this. */
  ready: boolean
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

// --- share/unshare outcomes ---------------------------------------------------

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

/** How one share/unshare/unshare-all POST ended. A refused action carries
 * the server's error `code` when it sent one (`subagent-session`,
 * `no-session`, …) for the alert copy to key on. */
export type ShareActionOutcome =
  | { ok: true }
  | { ok: false, code?: string, message?: string }

/** The action verbs the POST route takes (mirror of the server's set). */
export type ShareAction = 'share' | 'unshare' | 'unshare-all'

/** The locale keys `shareFailText` needs. */
export type ShareFailTextKey = 'shareRemoteFailSubagent' | 'shareRemoteFailEmpty' | 'shareRemoteFailGeneric'
export type ShareFailTextFormatter = (key: ShareFailTextKey) => string

/**
 * The one-line `window.alert` copy for a refused action (T33b-fix): the
 * share-specific server codes map to their reasons, everything else —
 * including every unshare failure — reads as the generic retry line.
 */
export function shareFailText(outcome: { ok: boolean, code?: string }, action: ShareAction, t: ShareFailTextFormatter): string {
  if (action === 'share') {
    if (outcome.code === 'subagent-session') return t('shareRemoteFailSubagent')
    if (outcome.code === 'no-session') return t('shareRemoteFailEmpty')
  }
  return t('shareRemoteFailGeneric')
}

// --- the store ---------------------------------------------------------------

/** Whether the page is currently visible, plus change notifications — the
 * seam that keeps the poll cadence visibility-shaped while staying
 * testable (the check script injects a controllable source). */
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

/** The store face the three T33b parts share. */
export interface SharesStore {
  /** The current snapshot — a stable frozen reference until the next change. */
  getSnapshot(): SharesSnapshot
  /** Observe snapshot replacements; polling runs while at least one
   * listener is attached AND the wired role is host AND the page is
   * visible. */
  subscribe(listener: () => void): () => void
  /** Wire the deployment role (settings-form.ts's settingsRoleOf verdict,
   * re-applied on every configForms snapshot update). Flipping back to host
   * resumes polling with an immediate pull; flipping to client stops it. */
  setRole(role: 'host' | 'client'): void
  /** GET now (latest-wins). @returns whether an ok body landed. */
  refresh(): Promise<boolean>
  /** POST share, then refresh immediately. @returns the action's outcome. */
  share(sessionId: string): Promise<ShareActionOutcome>
  /** POST unshare for one session, then refresh. @returns the outcome. */
  unshare(sessionId: string): Promise<ShareActionOutcome>
  /** POST unshare-all, then refresh. @returns the outcome. */
  unshareAll(): Promise<ShareActionOutcome>
}

/** Poll cadence while the page is visible, the role is host, and at least
 * one part is mounted. */
export const SHARES_POLL_MS = 30_000

/**
 * Build one store over an injectable fetch and visibility source. The GET is
 * latest-wins (T16's gate): an earlier request answering late never
 * overwrites a newer table. Every GET failure fails its own round only —
 * the last ready table stays up and the next tick retries (a plugin reload
 * serving a few 404s must not blind the page until reload). The timer is
 * real while visible and gone while hidden; becoming visible pulls once
 * immediately. `pollMs` exists for the check script: the shipped cadence is
 * far too slow for a test to observe, so tests run a few cycles at 5 ms.
 */
export function createSharesStore(
  fetchImpl: typeof fetch,
  visibility: VisibilitySource = documentVisibility,
  pollMs: number = SHARES_POLL_MS,
): SharesStore {
  const gate = createLatestGate()
  const listeners = new Set<() => void>()
  let role: SharesSnapshot['role'] = 'unknown'
  let snapshot: SharesSnapshot = Object.freeze({ role, ready: false, entries: Object.freeze([]) })
  let timer: ReturnType<typeof setInterval> | undefined
  let offVisibility: (() => void) | undefined

  const publish = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const applyBody = (body: unknown): void => {
    snapshot = Object.freeze({
      role,
      ready: true,
      entries: Object.freeze(parseSharesBody(body, Date.now())),
    })
    publish()
  }

  const refresh = async (): Promise<boolean> => {
    // A client (or not-yet-wired) deployment never asks: the route does not
    // exist there, and the settings-page rule holds — no wasted admin/* 404s.
    if (role !== 'host') return false
    const ticket = gate.next()
    try {
      const res = await fetchImpl(ADMIN_SHARES_ROUTE, { cache: 'no-store' })
      if (!gate.isLatest(ticket)) return false
      // 404 during a plugin reload, a 5xx, a broken body — all fail exactly
      // this round: keep the last table, answer false, retry next tick.
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

  const post = async (payload: Record<string, unknown>): Promise<ShareActionOutcome> => {
    let outcome: ShareActionOutcome = { ok: false }
    try {
      const res = await fetchImpl(ADMIN_SHARES_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
    // The action landed — the table must say so before the next poll tick.
    if (outcome.ok) await refresh()
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
    if (role !== 'host' || listeners.size === 0) return
    if (visibility.visible()) {
      // Becoming visible pulls once immediately, then resumes the cadence.
      void refresh()
      startTimer()
    } else {
      // Hidden: the timer is really gone, not just gated inside the tick.
      stopTimer()
    }
  }

  /** Reconcile the poll machinery with (role, listeners, visibility). */
  const syncPolling = (): void => {
    const shouldRun = role === 'host' && listeners.size > 0
    if (!shouldRun) {
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
      // Fresh run — first subscriber, or a client→host flip: pull once right
      // away instead of leaving the first table up to one cadence away.
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
    setRole(next: 'host' | 'client'): void {
      if (role === next) return
      role = next
      syncPolling()
      snapshot = Object.freeze({ ...snapshot, role })
      publish()
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

/**
 * The subscribe face the title-row icon hands `useSyncExternalStore`: on
 * the phone shell (a non-desktop-shell viewport at or under 767px) the
 * mobile stylesheet blanket-hides every `conversation.session.header.actions`
 * entry (styles/header.css.ts), so the icon would never be seen — it does
 * not subscribe either, and a subscription that never opens never polls.
 * Pure over (store, phoneShell) so the desktop-gate test drives it with a
 * counting fake fetch.
 */
export function subscribeIfNotPhoneShell(store: SharesStore, phoneShell: boolean, listener: () => void): () => void {
  return phoneShell ? () => {} : store.subscribe(listener)
}
