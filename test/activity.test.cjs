/* dsh-zen-remote · activity (src/activity.ts)
 *
 * The T22c tracker + sweeper are pure logic over the T21 shared table, so
 * these tests run them for real: the BUILT lib/activity.js and
 * lib/share-store.js (the committed artifacts production imports), a
 * manually advanced fake clock, real temp files for the store's
 * persistence, and hand-driven injected timers for the sweeper — no DSH,
 * no cordis, no wall-clock waiting.
 */
'use strict'
const { test, before } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ACTIVITY_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'activity.js')).href
const STORE_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'share-store.js')).href

const HOUR = 3_600_000
const T0 = 1_750_000_000_000

let createActivityTracker
let createParentIndex
let startSweeper
let createShareStore

before(async () => {
  ;({ createActivityTracker, createParentIndex, startSweeper } = await import(ACTIVITY_URL))
  ;({ createShareStore } = await import(STORE_URL))
})

/** Fake clock: the store asks, the test moves time. */
function makeClock(start) {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

/** Fresh persistence file in its own temp dir, removed when the test ends. */
function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-activity-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'shared-sessions.json')
}

/** A store + tracker wired together on the fake clock, with one session shared. */
function makeTrackedStore(t, clock, sessionId = 'a') {
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })
  const tracker = createActivityTracker(store)
  store.share(sessionId)
  return { store, tracker }
}

// ---- tracker: event → clock mapping ----------------------------------------

test('session/end-seed does not refresh the idle clock; a normal event does', (t) => {
  const clock = makeClock(T0)

  // 'a' gets only the auto-appended end-seed marker: it must age out exactly
  // on schedule, as if nobody had ever opened the session.
  const a = makeTrackedStore(t, clock)
  clock.advance(47 * HOUR)
  a.tracker.onEvent('a', 'session/end-seed')
  clock.advance(HOUR)
  assert.deepEqual(a.store.sweep(), ['a'], 'the seed marker never counts as activity')

  // 'b' gets an ordinary event 5s before its original deadline: one full
  // fresh idle span counts from the MOMENT OF THE EVENT.
  const b = makeTrackedStore(t, clock, 'b')
  clock.advance(48 * HOUR - 5_000)
  b.tracker.onEvent('b', 'user/message')
  clock.advance(4_000)
  assert.deepEqual(b.store.sweep(), [], 'a normal event pushed the deadline back')
  clock.advance(48 * HOUR - 4_000 - 1_000)
  assert.deepEqual(b.store.sweep(), [], 'still alive a full original span past the share point')
  clock.advance(1_000)
  assert.deepEqual(b.store.sweep(), ['b'], 'and only for one fresh idle span')
})

test('every ordinary event counts as activity', (t) => {
  const clock = makeClock(T0)
  const { store, tracker } = makeTrackedStore(t, clock)

  for (const type of ['tool/call', 'approval/asked', 'approval/decided', 'assistant/message']) {
    clock.advance(HOUR)
    tracker.onEvent('a', type)
    clock.advance(47 * HOUR)
    assert.deepEqual(store.sweep(), [], `${type} counted as activity`)
    clock.advance(1)
  }
})

test('turn/start keeps a shared session alive across 1000 hours of turning', (t) => {
  const clock = makeClock(T0)
  const { store, tracker } = makeTrackedStore(t, clock)

  tracker.onEvent('a', 'turn/start')
  clock.advance(1000 * HOUR)
  assert.equal(store.remainingMs('a'), Infinity, 'a busy session never idles out')
  assert.deepEqual(store.sweep(), [], '1000 hours mid-turn: still not swept')
})

test('turn/end restarts the idle span from that moment', (t) => {
  const clock = makeClock(T0)
  const { store, tracker } = makeTrackedStore(t, clock)

  tracker.onEvent('a', 'turn/start')
  clock.advance(50 * HOUR)
  tracker.onEvent('a', 'turn/end')
  // The turn began at T0, so WITHOUT the busy→idle re-stamp the session is
  // already past its 48h budget here (lastActivityAt would still be T0).
  assert.deepEqual(store.sweep(), [], 'the span restarts at turn end, not turn start')
  clock.advance(48 * HOUR - 1)
  assert.deepEqual(store.sweep(), [], 'one ms inside the fresh span: alive')
  clock.advance(1)
  assert.deepEqual(store.sweep(), ['a'], 'a full idle span after turn end: closed')
})

// ---- T22c-fix: parent index + ancestor refresh ------------------------------

/** A subagent-shaped session stub for observe(). */
const subagent = (id, parentSession) => ({ id, header: { origin: 'subagent', parentSession } })

test('parentIndex records subagent links and answers parentOf; everything else stays undefined', () => {
  const index = createParentIndex()
  index.observe(subagent('kid', 'top'))
  assert.equal(index.parentOf('kid'), 'top')

  // Non-subagent sessions, header-less and id-less stubs, garbage field
  // types, self-parents: none of them record a link.
  index.observe({ id: 'plain', header: {} })
  index.observe({ id: 'seed', header: { origin: 'subagent' } })
  index.observe({ id: 'bad', header: { origin: 'subagent', parentSession: 42 } })
  index.observe(subagent('self', 'self'))
  index.observe(undefined)
  index.observe({})
  assert.equal(index.parentOf('plain'), undefined)
  assert.equal(index.parentOf('seed'), undefined)
  assert.equal(index.parentOf('bad'), undefined)
  assert.equal(index.parentOf('self'), undefined)
  assert.equal(index.parentOf('nobody'), undefined, 'unobserved sessions have no parent')
})

test('a subagent event refreshes the parent clock but never its busy flag', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })
  store.share('top')
  store.share('kid') // synthetic: real children never enter the table, but a
  //                  shared child must STILL get its own full mapping
  const index = createParentIndex()
  index.observe(subagent('kid', 'top'))
  const tracker = createActivityTracker(store, index.parentOf)

  clock.advance(47 * HOUR)
  tracker.onEvent('kid', 'turn/start')
  assert.deepEqual(
    // list() sorts by sharedAt; all shared at T0, so by id: kid < top.
    store.list().map((e) => [e.sessionId, e.lastActivityAt, e.busy]),
    [
      ['kid', T0 + 47 * HOUR, true],
      ['top', T0 + 47 * HOUR, false],
    ],
    'the child runs busy, the parent is merely refreshed',
  )

  // THE bug this fixes: the background child's event stream is all that
  // keeps the parent (refreshed, never busy) alive past the parent's own
  // 48h budget. Each child event below lands one hour before the parent
  // would expire.
  tracker.onEvent('kid', 'turn/start')
  clock.advance(47 * HOUR)
  assert.deepEqual(store.sweep(), [], 'still alive ahead of the next child event')
  tracker.onEvent('kid', 'tool/call')
  clock.advance(47 * HOUR)
  assert.deepEqual(store.sweep(), [], 'the child event pushed the parent clock again')

  tracker.onEvent('kid', 'turn/end')
  clock.advance(48 * HOUR - 1)
  assert.deepEqual(store.sweep(), [], 'both clocks restart at the child turn end')
  clock.advance(1)
  assert.deepEqual(store.sweep(), ['kid', 'top'], 'and a full span later both age out together')
})

test('three nested subagents refresh every ancestor up the chain', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })
  for (const id of ['top', 'c1', 'c2']) store.share(id)
  const index = createParentIndex()
  index.observe(subagent('c1', 'top'))
  index.observe(subagent('c2', 'c1'))
  index.observe(subagent('c3', 'c2'))
  const tracker = createActivityTracker(store, index.parentOf)

  clock.advance(47 * HOUR)
  tracker.onEvent('c3', 'user/message')
  assert.deepEqual(
    // All three shared at T0: list() breaks the tie by id — c1, c2, top.
    store.list().map((e) => [e.sessionId, e.lastActivityAt]),
    [
      ['c1', T0 + 47 * HOUR],
      ['c2', T0 + 47 * HOUR],
      ['top', T0 + 47 * HOUR],
    ],
    'grandparent, parent and every layer between were touched',
  )
})

test('a parent cycle terminates instead of looping', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })
  store.share('a')
  const index = createParentIndex()
  index.observe(subagent('a', 'b'))
  index.observe(subagent('b', 'a'))
  const tracker = createActivityTracker(store, index.parentOf)

  assert.doesNotThrow(() => tracker.onEvent('a', 'user/message'), 'the walk stops at the repeated id')
  clock.advance(48 * HOUR)
  assert.deepEqual(store.sweep(), ['a'], 'the touch landed once, then the walk ended')
})

test('the parent table evicts its oldest entry past the 5000 cap', () => {
  const index = createParentIndex()
  for (let i = 0; i <= 5000; i += 1) index.observe(subagent(`k${i}`, `p${i}`))
  assert.equal(index.parentOf('k0'), undefined, 'the oldest insertion was evicted')
  assert.equal(index.parentOf('k1'), 'p1')
  assert.equal(index.parentOf('k5000'), 'p5000', 'the newest entries all survive')

  // Re-observing only overwrites in place; the next NEW entry evicts the
  // current oldest, which is k1 now.
  index.observe(subagent('k1', 'p1-moved'))
  assert.equal(index.parentOf('k1'), 'p1-moved')
  index.observe(subagent('k5001', 'p5001'))
  assert.equal(index.parentOf('k1'), undefined, 'k1 became the oldest and went')
  assert.equal(index.parentOf('k2'), 'p2')
})

// ---- sweeper: injected timers, ordering, survival ---------------------------

/** Start the sweeper with timer halves that never wait: the interval callback
 * is captured for hand-driving, the unref/clear behavior is recorded. */
function captureSweeper(store, getIdleHours) {
  let tick
  let intervalMs
  const unrefCalls = []
  const cleared = []
  const handle = { unref: () => unrefCalls.push(true) }
  const stop = startSweeper({
    store,
    getIdleHours,
    setIntervalImpl: (cb, ms) => {
      tick = cb
      intervalMs = ms
      return handle
    },
    clearIntervalImpl: (h) => cleared.push(h),
  })
  return { tick: () => tick(), intervalMs: () => intervalMs, unrefCalls, cleared, handle, stop }
}

test('sweeper feeds setIdleHours before every sweep, unrefs, and stops cleanly', () => {
  const order = []
  let hours = 48
  const store = {
    setIdleHours: (h) => order.push(['setIdleHours', h]),
    sweep: () => {
      order.push(['sweep'])
      return []
    },
  }
  const sw = captureSweeper(store, () => hours)
  assert.equal(sw.intervalMs(), 60_000, 'the default cadence is one minute')
  assert.deepEqual(sw.unrefCalls, [true], 'the timer is unref()ed so it never pins the process')

  // The volatile row setting changed without a restart: the NEXT tick must
  // already sweep against the new budget — proof it is re-read every time.
  hours = 24
  sw.tick()
  assert.deepEqual(
    order,
    [
      ['setIdleHours', 24],
      ['sweep'],
    ],
    'fresh budget first, sweep second, on every tick',
  )
  sw.stop()
  assert.deepEqual(sw.cleared, [sw.handle], 'the stop function clears the captured handle')
})

test('a throwing getIdleHours must not kill the timer', () => {
  const seen = []
  const store = {
    setIdleHours: (h) => seen.push(h),
    sweep: () => [],
  }
  let fail = true
  const sw = captureSweeper(store, () => {
    if (fail) throw new Error('config exploded')
    return 48
  })

  assert.doesNotThrow(() => sw.tick(), 'the tick swallows the error')
  assert.deepEqual(seen, [], 'nothing was fed while getIdleHours threw')
  fail = false
  sw.tick()
  assert.deepEqual(seen, [48], 'the next tick runs normally — the timer survived')
})

test('one real sweeper tick re-reads idleHours and closes expired sessions', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })
  store.share('a')
  let hours = 48
  const sw = captureSweeper(store, () => hours)

  clock.advance(47 * HOUR)
  sw.tick()
  assert.equal(store.isShared('a'), true, '47h < 48h: untouched')
  hours = 40
  sw.tick()
  assert.equal(store.isShared('a'), false, 'the re-read 40h budget closed the 47h-old session')
  sw.stop()
})
