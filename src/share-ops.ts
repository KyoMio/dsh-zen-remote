/**
 * Pure share-table operations driven by host-side observations (T33a): the
 * busy restore after a restart, and the share decision for a freshly created
 * session. No DSH imports, no I/O, no clock — the table and every host fact
 * come in as arguments, so the tests can drive them with plain objects.
 *
 * Field semantics verified against the DSH 0.2.0 sources (and spot-checked
 * against the 0.1.7 line this package still supports):
 *
 * - `agents.list()` returns live agents whose `id` IS the session id (the
 *   agent registry is keyed by it, its typert wire type is
 *   `dsh-session/types#SessionId`, and `hasDesktopActiveTasks` in
 *   dsh-desktop-host feeds `agent.id` straight into `workspace/session-activity`'s
 *   `sessionId`). `status` is a getter answering `'idle'` or `'running'`;
 *   `'running'` means a turn is in flight (including waiting on approval).
 * - a session header's `origin` is only ever `'subagent'` (subagent child,
 *   with `parentSession` naming its delegating parent); a FORK carries
 *   `parentSession` (its source) and `isSeeded: true` with NO origin — per
 *   `session/fork`'s `meta` in dsh-api-session-controller and
 *   `validateSessionHeader` in dsh-session.
 */

import type { ShareStore } from './share-store.js'

/** The slice of a live agent the busy restore reads. Declared structurally
 * so this module never imports DSH types and the tests can feed plain
 * objects — the same discipline as activity.ts's ObservableSession. */
export interface AgentStatusLike {
  id?: unknown
  status?: unknown
}

/** The slice of a DSH session header the share decision reads. Field names
 * per `validateSessionHeader`: `id` (matches the session id), `origin`
 * (only legal value `'subagent'`), `parentSession` (a string when set),
 * `isSeeded` (true on a fork). */
export interface CreatedSessionHeaderLike {
  id?: unknown
  origin?: unknown
  parentSession?: unknown
  isSeeded?: unknown
}

/** The slice of a DSH Session read to detect an unused blank placeholder
 * reclaimed by `session/create` (`dsh-api-session-controller`'s `claim`
 * resumes persisted blank sessions with `source: 'resume'`). */
export interface CreatedSessionLike {
  header?: CreatedSessionHeaderLike | null | undefined
  snapshotEvents?: (() => readonly { type?: unknown }[]) | undefined
}

/** The slice of `ctx.agents.turnBoundaryOf(session)` (DSH 0.2+ projection
 * reader, the non-deprecated replacement for `snapshotEvents()`). */
export interface TurnBoundaryLike {
  openTurnStartSeq?: unknown
  lastTurn?: unknown
}

/**
 * Whether `session` is an unseeded, non-subagent blank session (zero turns
 * ever started). DSH's `createInWorkspace` reuses persisted blank sessions
 * via `session/create` → `agents.resume` (`source: 'resume'`); judging
 * blankness lets `agent/created` auto-share a reclaimed blank placeholder
 * while keeping established conversations closed across reopens.
 *
 * Prefers `turnBoundaryOf(session)` (DSH's `sessionProjections`-backed
 * `ctx.agents.turnBoundaryOf`, the predicate `dsh-api-session-controller`'s
 * own `isBlank` uses: `openTurnStartSeq === null && lastTurn === 0`); falls
 * back to `session.snapshotEvents()` when `turnBoundaryOf` is absent (DSH
 * 0.1.7 compatibility or unit-test mocks; ponytail: remove `snapshotEvents`
 * fallback once 0.1.7 support is dropped and `@deepseek-ai/dsh-session`
 * retires synchronous event-log reads).
 */
export function isBlankSession(
  session: CreatedSessionLike | undefined | null,
  turnBoundaryOf?: ((session: CreatedSessionLike) => TurnBoundaryLike | undefined) | undefined,
): boolean {
  if (session === null || typeof session !== 'object') return false
  const header = session.header
  if (header === null || typeof header !== 'object') return false
  if (header.origin === 'subagent' || header.isSeeded === true) return false
  if (typeof header.id !== 'string' || header.id === '') return false
  if (typeof turnBoundaryOf === 'function') {
    try {
      const boundary = turnBoundaryOf(session)
      if (boundary !== null && typeof boundary === 'object') {
        return boundary.openTurnStartSeq === null && boundary.lastTurn === 0
      }
    } catch {
      // Fall through to snapshotEvents when the projection reader is unavailable.
    }
  }
  if (typeof session.snapshotEvents !== 'function') return false
  try {
    const events = session.snapshotEvents()
    if (!Array.isArray(events)) return false
    return !events.some((event) => event !== null && typeof event === 'object' && event.type === 'turn/start')
  } catch {
    return false
  }
}

/**
 * Whether `event` is the very first `turn/start` (`turn === 1`) of an
 * unseeded non-subagent session. Covers the in-memory `reuseLive` path of
 * `session/create`, where a live blank session (created before
 * `autoShareNewSessions` was enabled, or after its idle window expired in
 * memory) is reused without emitting `agent/created`.
 */
export function isFirstTurnStart(
  session: { header?: CreatedSessionHeaderLike | null | undefined } | undefined | null,
  event: { type?: unknown; data?: unknown } | undefined | null,
): boolean {
  if (event === null || typeof event !== 'object' || event.type !== 'turn/start') return false
  const data = event.data as { turn?: unknown } | null | undefined
  if (data === null || typeof data !== 'object' || data.turn !== 1) return false
  const header = session?.header
  if (header === null || typeof header !== 'object') return false
  if (header.origin === 'subagent' || header.isSeeded === true) return false
  return typeof header.id === 'string' && header.id !== ''
}

/**
 * Re-mark the busy flags a restart wiped. `busy` is deliberately never
 * persisted, so after a plugin-row restart every shared session resumes as
 * idle — and an idle session whose agent is actually mid-turn would idle out
 * from under it. For every shared session whose agent currently reports
 * `status === 'running'`, set busy; everything else keeps the post-restart
 * idle default (setting busy FALSE here would re-stamp lastActivityAt and
 * silently restart idle clocks for sessions nobody touched). The running
 * flags then live their normal life: T22c's activity tracker clears them on
 * `turn/end`.
 *
 * A throwing `listAgents` means "no information", not "nothing runs" — the
 * restore degrades to a no-op instead of failing its caller (a route, or
 * plugin startup).
 */
export function restoreBusy(store: ShareStore, listAgents: () => readonly AgentStatusLike[]): void {
  let roster: readonly AgentStatusLike[]
  try {
    roster = listAgents()
  } catch {
    return
  }
  const running = new Set<string>()
  for (const agent of roster) {
    if (agent !== null && typeof agent === 'object' && typeof agent.id === 'string' && agent.status === 'running') {
      running.add(agent.id)
    }
  }
  if (running.size === 0) return
  for (const entry of store.list()) {
    if (running.has(entry.sessionId)) store.setBusy(entry.sessionId, true)
  }
}

export interface OnSessionCreatedOptions {
  /** The shared-session table the decision writes into. */
  store: ShareStore
  /** The volatile `autoShareNewSessions` knob, resolved by the caller AT
   * EVENT TIME — never snapshotted at apply. */
  autoShare: boolean
  /** Ancestor lookup for fork-source reachability (the same index the
   * activity tracker and relay use). */
  parentOf: (id: string) => string | undefined
}

/**
 * The share decision for one freshly created session (the `agent/created`
 * `source: 'startup'` payload's session header). Returns whether the session
 * entered the table.
 *
 * Three shapes, judged off the header alone:
 * - subagent child (`origin === 'subagent'`): never enters the table — it
 *   borrows reachability from its ancestor chain.
 * - fork (`parentSession` set, origin absent): an ORDINARY user-created
 *   session (its header has no subagent marker), so the auto-share knob
 *   applies to it exactly as to a top-level one, with the fork source as an
 *   extra path: shared when its source is accessible OR the knob is on.
 * - top-level: shared only when the auto-share knob is on right now.
 */
export function onSessionCreated(
  header: CreatedSessionHeaderLike | undefined | null,
  options: OnSessionCreatedOptions,
): boolean {
  if (header === null || typeof header !== 'object') return false
  const { store, autoShare, parentOf } = options
  if (header.origin === 'subagent') return false
  const { id, parentSession } = header
  if (typeof id !== 'string' || id === '') return false
  if (typeof parentSession === 'string' && parentSession !== '') {
    return store.isAccessible(parentSession, parentOf) || autoShare ? store.share(id) : false
  }
  return autoShare ? store.share(id) : false
}
