/**
 * Session-activity tracking for the shared remote table (T22c): the bridge
 * from DSH's session event stream to share-store bookkeeping, plus the idle
 * sweeper that puts away sessions gone quiet. Pure logic — no DSH imports,
 * no filesystem, and timers only through injectable functions — so the tests
 * can drive every tick from a fake clock (test/activity.test.cjs).
 *
 * The event mapping is the rule set agreed for "what counts as activity":
 * every session event means the session moved, EXCEPT `session/end-seed`,
 * which DSH appends by itself whenever a session is merely opened (see the
 * main repo's docs/spike-relay.md §2.1 pitfall 2) — counting it would reset
 * the idle clock every time someone looks at a conversation. A turn marks
 * the session busy for its whole span (`turn/start` → `turn/end`), so
 * waiting on an approval or an answer — both happen INSIDE a turn — never
 * idles out either.
 *
 * T22c-fix added parent propagation: subagent sessions never enter the
 * shared table themselves, but their events (a background child grinding on
 * after the parent's own turn ended) must keep the ANCESTORS' idle clocks
 * fresh — {@link createParentIndex} records the child→parent links from
 * session headers, and the tracker touches every ancestor along the chain.
 */
import type { ShareStore } from './share-store.js';
/** What `createActivityTracker` hands back: one call per session event. */
export interface ActivityTracker {
    /** Report one session event. No-op for unshared sessions (share-store
     * ignores strangers) and for the `session/end-seed` marker. */
    onEvent(sessionId: string, eventType: string): void;
}
/** Map one DSH session event onto the shared table's clock rules. `parentOf`
 * (optional) reports the parent of a subagent session; when given, a child's
 * event also refreshes every ancestor's clock (touch only — see below). */
export declare function createActivityTracker(store: ShareStore, parentOf?: (id: string) => string | undefined): ActivityTracker;
/** The slice of a live DSH Session the parent index reads: the session id
 * plus the two subagent-relevant header fields. Declared structurally so
 * this module never imports DSH types (an optional peer dependency) and the
 * tests can feed plain objects. Field names per DSH 0.2.0 dsh-session's
 * `validateSessionHeader`: `origin` (only legal value `'subagent'`) and
 * `parentSession` (must be a string). */
export interface ObservableSession {
    id?: unknown;
    header?: {
        origin?: unknown;
        parentSession?: unknown;
    } | undefined;
}
/** Remembers which sessions are subagents of which, as reported by
 * {@link ParentIndex.observe}. */
export interface ParentIndex {
    /** Record one session's parent link when it IS a subagent; every other
     * shape (top-level sessions, id-less or header-less stubs, undefined) is
     * a no-op. */
    observe(session: ObservableSession | undefined): void;
    /** The recorded parent of `id`, or undefined when unknown. */
    parentOf(id: string): string | undefined;
}
/**
 * The child→parent table backing subagent activity propagation (T22c-fix):
 * the tracker refreshes ancestors' clocks and the relay's `isAccessible`
 * walks it to decide whether a subagent session is reachable. Pure in-memory
 * — rebuilt from live `session/event` traffic after every restart, so there
 * is nothing to persist and nothing to invalidate.
 */
export declare function createParentIndex(): ParentIndex;
/** Duck-typed timer halves: Node's setInterval/clearInterval at runtime,
 * fakes in tests. Loose on purpose — the real NodeJS.Timeout type would
 * fight the contravariant `clearInterval` parameter under strictFunctionTypes. */
type StartInterval = (callback: () => void, ms: number) => unknown;
type ClearInterval = (handle: unknown) => void;
export interface SweeperOptions {
    /** The shared table to sweep. */
    store: ShareStore;
    /** Read fresh before EVERY sweep: `idleHours` is a volatile row setting
     * that can change without a restart, so it is never snapshotted here. */
    getIdleHours: () => number;
    /** Sweep cadence in ms. Default 60_000 — a minute late is fine for a
     * threshold measured in hours. */
    intervalMs?: number;
    /** Injectable timer halves (tests drive ticks by hand). */
    setIntervalImpl?: StartInterval;
    clearIntervalImpl?: ClearInterval;
}
/**
 * ponytail: 忙碌状态不写盘（share-store 的持久化刻意省略 busy）。一个会话在回合
 * 中（比如等审批）经历了 DSH 重启，重启后按空闲处理，计时起点仍是回合开始时
 * `touch` 打下的时间戳；如果那时距重启已超过 idleHours，重启后的第一次扫描就会
 * 关闭它的远程。DSH 重启本身会中断正在进行的回合，所以这种情况下关闭远程是
 * 可以接受的。
 *
 * Start the idle sweeper: every interval, first feed the table the CURRENT
 * idle budget, then close whatever has been quiet past it. Returns the stop
 * function (the host half hands it to ctx.effect). Two failure disciplines:
 * a throwing getIdleHours or sweep is swallowed — the timer must survive to
 * try again next tick — and the underlying timer is unref()ed so the sweeper
 * alone never keeps the DSH process alive.
 */
export declare function startSweeper(options: SweeperOptions): () => void;
export {};
//# sourceMappingURL=activity.d.ts.map