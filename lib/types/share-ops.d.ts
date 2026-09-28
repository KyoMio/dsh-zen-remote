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
import type { ShareStore } from './share-store.js';
/** The slice of a live agent the busy restore reads. Declared structurally
 * so this module never imports DSH types and the tests can feed plain
 * objects — the same discipline as activity.ts's ObservableSession. */
export interface AgentStatusLike {
    id?: unknown;
    status?: unknown;
}
/** The slice of a DSH session header the share decision reads. Field names
 * per `validateSessionHeader`: `id` (matches the session id), `origin`
 * (only legal value `'subagent'`), `parentSession` (a string when set). */
export interface CreatedSessionHeaderLike {
    id?: unknown;
    origin?: unknown;
    parentSession?: unknown;
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
export declare function restoreBusy(store: ShareStore, listAgents: () => readonly AgentStatusLike[]): void;
export interface OnSessionCreatedOptions {
    /** The shared-session table the decision writes into. */
    store: ShareStore;
    /** The volatile `autoShareNewSessions` knob, resolved by the caller AT
     * EVENT TIME — never snapshotted at apply. */
    autoShare: boolean;
    /** Ancestor lookup for fork-source reachability (the same index the
     * activity tracker and relay use). */
    parentOf: (id: string) => string | undefined;
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
export declare function onSessionCreated(header: CreatedSessionHeaderLike | undefined | null, options: OnSessionCreatedOptions): boolean;
//# sourceMappingURL=share-ops.d.ts.map