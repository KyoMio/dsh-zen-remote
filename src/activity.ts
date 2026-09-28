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

import type { ShareStore } from './share-store.js'

/** What `createActivityTracker` hands back: one call per session event. */
export interface ActivityTracker {
  /** Report one session event. No-op for unshared sessions (share-store
   * ignores strangers) and for the `session/end-seed` marker. */
  onEvent(sessionId: string, eventType: string): void
}

/** Auto-appended when a session is opened; a snapshot of attention, not activity. */
const END_SEED_EVENT = 'session/end-seed'

/** Map one DSH session event onto the shared table's clock rules. `parentOf`
 * (optional) reports the parent of a subagent session; when given, a child's
 * event also refreshes every ancestor's clock (touch only — see below). */
export function createActivityTracker(
  store: ShareStore,
  parentOf: (id: string) => string | undefined = () => undefined,
): ActivityTracker {
  // Walk UP from the session itself, touching each ancestor once. Bounded
  // like share-store's own isAccessible walk: 16 hops, and a repeated id
  // (a hostile/corrupt parent chain) stops the walk dead instead of looping.
  const touchAncestors = (sessionId: string): void => {
    const seen = new Set<string>([sessionId])
    let current = sessionId
    for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
      let parent: string | undefined
      try {
        parent = parentOf(current)
      } catch {
        // A throwing parentOf means "no parent from here".
        return
      }
      if (parent === undefined || parent === '' || seen.has(parent)) return
      seen.add(parent)
      // Touch ONLY: a child's turn start/end says nothing about whether the
      // parent is running or waiting — the parent's own turn events govern
      // its busy flag.
      store.touch(parent)
      current = parent
    }
  }
  return {
    onEvent(sessionId, eventType) {
      if (eventType === END_SEED_EVENT) return
      // The child itself is handled exactly as before (a shared child would
      // get the full mapping; an unshared one is ignored by the store).
      if (eventType === 'turn/start') {
        // Busy AND touched: the touch stamps "activity began here", which is
        // the clock the table falls back to after a restart (busy is not
        // persisted — see the note on startSweeper).
        store.setBusy(sessionId, true)
        store.touch(sessionId)
      } else if (eventType === 'turn/end') {
        // No touch of its own: share-store re-stamps lastActivityAt when busy
        // flips to false, so the idle span restarts at the turn's actual end.
        store.setBusy(sessionId, false)
      } else {
        store.touch(sessionId)
      }
      // A subagent's motion is its ancestors' motion too: a background child
      // (run_in_background) keeps working after the parent's own turn ended,
      // and without this the parent idles out mid-orchestration. The
      // end-seed marker never reaches here — a session being OPENED (even a
      // subagent one) is a look, not motion, and must not defer anyone's
      // idle clock.
      touchAncestors(sessionId)
    },
  }
}

/** The slice of a live DSH Session the parent index reads: the session id
 * plus the two subagent-relevant header fields. Declared structurally so
 * this module never imports DSH types (an optional peer dependency) and the
 * tests can feed plain objects. Field names per DSH 0.2.0 dsh-session's
 * `validateSessionHeader`: `origin` (only legal value `'subagent'`) and
 * `parentSession` (must be a string). */
export interface ObservableSession {
  id?: unknown
  header?: { origin?: unknown; parentSession?: unknown } | undefined
}

/** Remembers which sessions are subagents of which, as reported by
 * {@link ParentIndex.observe}. */
export interface ParentIndex {
  /** Record one session's parent link when it IS a subagent; every other
   * shape (top-level sessions, id-less or header-less stubs, undefined) is
   * a no-op. */
  observe(session: ObservableSession | undefined): void
  /** The recorded parent of `id`, or undefined when unknown. */
  parentOf(id: string): string | undefined
}

/**
 * ponytail: 父子表上限 5000 条，超出按最早插入淘汰。这是内存里的纯派生数据
 * （重启后由 session/event 重建），淘汰只发生在「第 5001 个新子会话」出现时，
 * 按插入序删最早的一条；反复 observe 已有 id 只覆盖值、不动位置。上限挡的是
 * 长驻进程里无限累积的子会话 id，5000 对单机并发子智能体绰绰有余。
 */
/** Entries the parent index keeps before the oldest insertion is evicted. */
const MAX_PARENT_ENTRIES = 5000

/** Same-walk ancestor bound as share-store's isAccessible: 16 hops. */
const MAX_ANCESTOR_HOPS = 16

/**
 * The child→parent table backing subagent activity propagation (T22c-fix):
 * the tracker refreshes ancestors' clocks and the relay's `isAccessible`
 * walks it to decide whether a subagent session is reachable. Pure in-memory
 * — rebuilt from live `session/event` traffic after every restart, so there
 * is nothing to persist and nothing to invalidate.
 */
export function createParentIndex(): ParentIndex {
  // Insertion order is the eviction order: Map preserves it.
  const parents = new Map<string, string>()
  return {
    observe(session) {
      const header = session?.header
      if (header === undefined || header.origin !== 'subagent') return
      const { parentSession } = header
      if (typeof parentSession !== 'string' || parentSession === '') return
      const id = session?.id
      // A self-parent would poison every future walk into a 1-cycle; the
      // seen-set in the walkers already survives it, but there is no honest
      // link to record in the first place.
      if (typeof id !== 'string' || id === '' || id === parentSession) return
      if (!parents.has(id) && parents.size >= MAX_PARENT_ENTRIES) {
        const oldest = parents.keys().next().value
        if (oldest !== undefined) parents.delete(oldest)
      }
      parents.set(id, parentSession)
    },

    parentOf(id) {
      return parents.get(id)
    },
  }
}

/** Duck-typed timer halves: Node's setInterval/clearInterval at runtime,
 * fakes in tests. Loose on purpose — the real NodeJS.Timeout type would
 * fight the contravariant `clearInterval` parameter under strictFunctionTypes. */
type StartInterval = (callback: () => void, ms: number) => unknown
type ClearInterval = (handle: unknown) => void

export interface SweeperOptions {
  /** The shared table to sweep. */
  store: ShareStore
  /** Read fresh before EVERY sweep: `idleHours` is a volatile row setting
   * that can change without a restart, so it is never snapshotted here. */
  getIdleHours: () => number
  /** Sweep cadence in ms. Default 60_000 — a minute late is fine for a
   * threshold measured in hours. */
  intervalMs?: number
  /** Injectable timer halves (tests drive ticks by hand). */
  setIntervalImpl?: StartInterval
  clearIntervalImpl?: ClearInterval
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
export function startSweeper(options: SweeperOptions): () => void {
  const { store, getIdleHours, intervalMs = 60_000 } = options
  const setIntervalImpl: StartInterval = options.setIntervalImpl ?? ((callback, ms) => setInterval(callback, ms))
  const clearIntervalImpl: ClearInterval =
    options.clearIntervalImpl ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
  const tick = () => {
    try {
      store.setIdleHours(getIdleHours())
      store.sweep()
    } catch {
      // Anything thrown here (a hostile getIdleHours, a disk hiccup in
      // sweep's persist) must not kill the timer: the next interval retries.
    }
  }
  const handle = setIntervalImpl(tick, intervalMs)
  if (typeof handle === 'object' && handle !== null && typeof (handle as { unref?: unknown }).unref === 'function') {
    ;(handle as { unref: () => void }).unref()
  }
  return () => {
    clearIntervalImpl(handle)
  }
}
