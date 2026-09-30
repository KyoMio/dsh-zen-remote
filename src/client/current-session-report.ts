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
 * Runs only in the CLIENT role (a host has no relay and no intercept): the
 * role comes from the SAME cached `client-config` probe the share parts
 * use — a definite 'client' starts reporting, a 'host' never reports, and
 * an undecided probe re-asks on each tick (once it lands the answer is
 * stable for the process's lifetime).
 */
import { CURRENT_SESSION_STORAGE_KEY, currentSessionReportEquals, parseCurrentSessionStorage } from '../client-data/current-session.ts'
import type { CurrentSessionReport } from '../client-data/current-session.ts'
import { probeClientConfigRole } from './remote-share-register.ts'

/** Default POST target, mirrored from src/client-routes.ts (the client
 * tsconfig cannot reach the host file). */
const CURRENT_SESSION_ROUTE = '/_dsh/zen-remote/client/current-session'

/** The re-check cadence — the same 1s the backend's fallback poll uses. */
const CHECK_INTERVAL_MS = 1_000

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
  probeRole?: () => Promise<'host' | 'client' | undefined>
  /** POST target. Default: the current-session route. */
  route?: string
  /** The re-check interval; default 1000ms. */
  intervalMs?: number
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
  const post = (report: ReportableReport): Promise<unknown> => {
    const doFetch = options.fetchImpl ?? fetch
    const body = report.kind === 'open' ? { sessionId: report.sessionId } : { sessionId: null }
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
  let lastReported: CurrentSessionReport | undefined
  let role: 'host' | 'client' | undefined
  let inFlight = false

  const tick = async (): Promise<void> => {
    if (role === undefined) {
      const answer = await probeRole()
      // A failed probe changes nothing — the next tick asks again; a
      // definite answer is stable for the page's life.
      if (answer !== undefined) role = answer
    }
    if (role !== 'client') return
    const report = parseCurrentSessionStorage(readRaw())
    if (report.kind === 'unavailable') return
    if (lastReported !== undefined && currentSessionReportEquals(report, lastReported)) return
    try {
      await post(report)
      lastReported = report
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
