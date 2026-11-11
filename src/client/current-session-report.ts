/**
 * T62: the browser half of the current-session signal. The intercept layer
 * that decides whether a closed-remote session hides runs in the BACKEND
 * Node process (it wraps the host's typert gateway there — src/index.ts's
 * installIntercept), so THIS is the only place the host's persisted
 * selection (localStorage `dsh.sessions.current`, the workspace UI's
 * selection store) is readable. The reporter watches it and POSTs every
 * CHANGE to the backend route; the route stores the value and makes the
 * intercept re-judge at once, with a 1s backend poll as the fallback.
 *
 * Re-check points: page load, the `storage` event (a DIFFERENT tab or
 * window changed the key — same-tab writes fire no storage event), the
 * page becoming visible again, and a 1s interval that doubles as the retry
 * path: a failed POST leaves the last-reported value untouched, so the
 * next tick re-sends it (same-tab navigations are what the interval is
 * really for). Failures are silent — background plumbing must never log
 * or toast.
 *
 * Runs only in the CLIENT and PEER roles (a host has no relay and no
 * intercept): the role comes from the SAME cached `client-config` probe the
 * share parts use — a definite 'client' or 'peer' starts reporting (PG-9:
 * a peer mounts the same remote sessions), a 'host' never reports, and an
 * undecided probe re-asks on each tick (once it lands the answer is stable
 * for the process's lifetime).
 */
import { CURRENT_SESSION_STORAGE_KEY, currentSessionReportEquals, parseCurrentSessionStorage } from '../client-data/current-session.ts'
import type { CurrentSessionReport } from '../client-data/current-session.ts'
import { probeClientConfigRole } from './remote-share-register.ts'

/** Default POST target, mirrored from src/client-routes.ts (the client
 * tsconfig cannot reach the host file). */
const CURRENT_SESSION_ROUTE = '/_dsh/zen-remote/client/current-session'

/** The re-check cadence — the same 1s the backend's fallback poll uses. */
const CHECK_INTERVAL_MS = 1_000

/**
 * How often the current value is re-sent even when unchanged (T66): the
 * reporter otherwise posts only CHANGES, but the backend can be reset
 * underneath the page — a plugin row reload re-runs apply() and drops its
 * stored value — leaving the page convinced it already reported. One
 * unconditional re-post per window keeps the two ends converging without
 * waiting for the user to navigate.
 */
const RESEND_INTERVAL_MS = 30_000

/** The storage face used, narrowed to the one method (structurally typed:
 * this module compiles under the client tsconfig with DOM lib, but tests
 * inject stubs). */
interface StorageLike {
  getItem(key: string): string | null
}

export interface CurrentSessionReporterOptions {
  /** The storage reader. Default: the page's localStorage; a broken or
   * absent one makes every read `unavailable` and nothing is ever posted. */
  storage?: StorageLike
  /** Outbound POST transport. Default: the page's fetch. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<unknown>
  /** The role probe. Default: the shared cached client-config probe. */
  probeRole?: () => Promise<'host' | 'client' | 'peer' | undefined>
  /** POST target. Default: the current-session route. */
  route?: string
  /** The re-check interval; default 1000ms. */
  intervalMs?: number
  /** The unconditional re-send window (T66); default 30000ms. */
  resendIntervalMs?: number
  /** Optional UI language reader (`'zh'` | `'en'`); when present (or when
   * `<html lang>` is set in the browser), the value rides the POST body as
   * `lang` so the backend merger can localize sidebar group suffixes. */
  getLang?: () => 'zh' | 'en' | undefined
}

/** One reportable value — `unavailable` never travels. */
type ReportableReport = Exclude<CurrentSessionReport, { kind: 'unavailable' }>

/**
 * Start the reporter loop. Returns the disposer (listeners + interval) the
 * mounting effect calls on teardown.
 */
export function startCurrentSessionReporter(options: CurrentSessionReporterOptions = {}): () => void {
  const readRaw = (): string | null | undefined => {
    const storage = options.storage ?? (globalThis as { localStorage?: StorageLike | null }).localStorage
    if (storage === null || storage === undefined || typeof storage.getItem !== 'function') return undefined
    try {
      return storage.getItem(CURRENT_SESSION_STORAGE_KEY)
    } catch {
      return undefined
    }
  }
  const readLang = (): 'zh' | 'en' | undefined => {
    if (options.getLang !== undefined) return options.getLang()
    const doc = (globalThis as { document?: { documentElement?: { lang?: unknown } } }).document
    const htmlLang = doc?.documentElement?.lang
    if (typeof htmlLang === 'string' && htmlLang !== '') {
      return htmlLang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }
    return undefined
  }
  const post = (report: ReportableReport, lang: 'zh' | 'en' | undefined): Promise<unknown> => {
    const doFetch = options.fetchImpl ?? fetch
    const base = report.kind === 'open' ? { sessionId: report.sessionId } : { sessionId: null }
    const body = lang !== undefined ? { ...base, lang } : base
    return doFetch(options.route ?? CURRENT_SESSION_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })
  }
  const probeRole = options.probeRole ?? probeClientConfigRole

  // The last value the backend ACCEPTED (undefined = nothing posted yet).
  // A failed POST must not advance it — that is the whole retry rule: the
  // value still differs, so the next change or the next check re-sends.
  // T66: the timestamp of the last accepted post drives the slow unconditional
  // re-send (0 = due immediately, which is the page-load post).
  let lastReported: CurrentSessionReport | undefined
  let lastReportedLang: 'zh' | 'en' | undefined
  let lastSentAt = 0
  const resendEveryMs = options.resendIntervalMs ?? RESEND_INTERVAL_MS
  let role: 'host' | 'client' | 'peer' | undefined
  let inFlight = false

  const tick = async (): Promise<void> => {
    if (role === undefined) {
      const answer = await probeRole()
      // A failed probe changes nothing — the next tick asks again; a
      // definite answer is stable for the page's life.
      if (answer !== undefined) role = answer
    }
    // A peer mounts the same remote sessions as a client — its zr~ panel
    // switches must reach the route too (PG-9-fix). Only a host idles.
    if (role !== 'client' && role !== 'peer') return
    const report = parseCurrentSessionStorage(readRaw())
    if (report.kind === 'unavailable') return
    const lang = readLang()
    const now = Date.now()
    // T66: inside the re-send window an unchanged value says nothing; once
    // the window passes, the CURRENT value re-posts even unchanged — the
    // backend may have been reset underneath the page.
    const resendDue = now - lastSentAt >= resendEveryMs
    if (
      !resendDue &&
      lastReported !== undefined &&
      currentSessionReportEquals(report, lastReported) &&
      lang === lastReportedLang
    ) {
      return
    }
    try {
      await post(report, lang)
      lastReported = report
      lastReportedLang = lang
      lastSentAt = now
    } catch {
      // Silent: the next tick sees the unchanged lastReported and retries.
    }
  }
  const tickOnce = (): void => {
    // One re-check at a time: a slow POST must not pile up parallel tries.
    if (inFlight) return
    inFlight = true
    void tick().finally(() => { inFlight = false })
  }

  const globalObj = globalThis as {
    window?: { addEventListener(type: string, fn: () => void): void, removeEventListener(type: string, fn: () => void): void }
    document?: { addEventListener(type: string, fn: () => void): void, removeEventListener(type: string, fn: () => void): void }
  }
  const onStorage = (): void => { tickOnce() }
  const onVisibility = (): void => { tickOnce() }
  globalObj.window?.addEventListener('storage', onStorage)
  globalObj.document?.addEventListener('visibilitychange', onVisibility)
  const timer = setInterval(() => { tickOnce() }, options.intervalMs ?? CHECK_INTERVAL_MS)
  tickOnce()
  return () => {
    clearInterval(timer)
    globalObj.window?.removeEventListener('storage', onStorage)
    globalObj.document?.removeEventListener('visibilitychange', onVisibility)
  }
}

/**
 * Mount the reporter as one page-lifetime effect. The caller places this
 BEFORE the desktop-shell gate in apply(): the desktop app in the client
 * role is exactly where remote sessions live, so the report must not wait
 * on a width gate. On a host the loop idles after one probe answer.
 */
export function mountCurrentSessionReporter(ctx: { effect(fn: () => () => void, name: string): void }, options: CurrentSessionReporterOptions = {}): void {
  ctx.effect(() => startCurrentSessionReporter(options), 'dsh-zen-remote: current-session report')
}
