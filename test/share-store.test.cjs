/* dsh-zen-remote · share-store (src/share-store.ts)
 *
 * The T21 shared-table module is pure logic + one JSON file, so these tests
 * run it for real: the BUILT lib/share-store.js (same committed artifact
 * production imports), a manually advanced fake clock, and real files under
 * os.tmpdir() — the persistence promises (atomic tmp+rename, corrupt-file
 * quarantine, 60s write throttle) are only honest when a real filesystem
 * answers. No DSH, no cordis, no network.
 */
'use strict'
const { test, before } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'share-store.js')).href

const HOUR = 3_600_000
const IDLE_MS = 48 * HOUR
const T0 = 1_750_000_000_000

let createShareStore

before(async () => {
  ;({ createShareStore } = await import(MODULE_URL))
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-share-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'shared-sessions.json')
}

function recorder(store) {
  const events = []
  store.subscribe((event) => events.push(event))
  return events
}

// ---- 1. share / repeat share / unshare / repeat unshare: returns + events ----

test('share and unshare return values and events', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })
  const events = recorder(store)

  assert.equal(store.share('a'), true, 'first share returns true')
  assert.deepEqual(events, [{ type: 'shared', sessionId: 'a' }])

  clock.advance(1_000)
  assert.equal(store.share('a'), false, 'repeat share returns false')
  assert.equal(store.isShared('a'), true)
  assert.deepEqual(store.list(), [
    // sharedAt frozen at the FIRST share, lastActivityAt refreshed to now.
    { sessionId: 'a', sharedAt: T0, lastActivityAt: T0 + 1_000, busy: false },
  ])
  assert.deepEqual(events, [{ type: 'shared', sessionId: 'a' }], 'repeat share emits nothing')

  assert.equal(store.unshare('a', 'client'), true)
  assert.deepEqual(events, [
    { type: 'shared', sessionId: 'a' },
    { type: 'unshared', sessionId: 'a', reason: 'client' },
  ])
  assert.equal(store.isShared('a'), false)

  assert.equal(store.unshare('a', 'client'), false, 'repeat unshare returns false')
  assert.equal(events.length, 2, 'repeat unshare emits nothing')
})

// ---- 2. idle expiry, touch pushes the deadline, touch ignores strangers ----

test('idle expiry: sweep closes exactly at idleMs, touch defers', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })
  const events = recorder(store)

  store.share('a')
  clock.advance(IDLE_MS - 1)
  assert.deepEqual(store.sweep(), [], 'one ms short of idle: still alive')
  clock.advance(1)
  assert.deepEqual(store.sweep(), ['a'])
  assert.deepEqual(events, [
    { type: 'shared', sessionId: 'a' },
    { type: 'unshared', sessionId: 'a', reason: 'idle' },
  ])
  assert.equal(store.sweep().length, 0, 'second sweep finds nothing left')
})

test('touch pushes the idle deadline back', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })

  store.share('a')
  clock.advance(IDLE_MS - 10)
  store.touch('a')
  clock.advance(9)
  assert.deepEqual(store.sweep(), [], '9ms after a touch: alive again')
  clock.advance(IDLE_MS - 9)
  assert.deepEqual(store.sweep(), ['a'], 'a fresh full idle span later: closed')
})

test('touch on an unshared session is a no-op', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })
  const events = recorder(store)

  store.touch('ghost')
  assert.equal(store.isShared('ghost'), false, 'touch must not create an entry')
  assert.deepEqual(store.list(), [])
  assert.deepEqual(store.sweep(), [])
  assert.deepEqual(events, [])
})

// ---- 3. busy never idles out; clock restarts when busy ends ----

test('busy sessions never expire; unbusying restarts the clock', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })
  const events = recorder(store)

  store.share('a')
  store.setBusy('a', true)
  clock.advance(1_000 * HOUR)
  assert.equal(store.remainingMs('a'), Infinity, 'busy: countdown suspended')
  assert.deepEqual(store.sweep(), [], 'a thousand busy hours: still alive')

  clock.advance(1)
  store.setBusy('a', false)
  assert.equal(store.remainingMs('a'), IDLE_MS, 'busy ended: full budget from now')
  assert.deepEqual(events, [{ type: 'shared', sessionId: 'a' }], 'busy transitions emit nothing')

  clock.advance(IDLE_MS)
  assert.deepEqual(store.sweep(), ['a'])
  assert.deepEqual(events, [
    { type: 'shared', sessionId: 'a' },
    { type: 'unshared', sessionId: 'a', reason: 'idle' },
  ])
})

test('setBusy is idempotent and ignores unshared sessions', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })

  store.share('a')
  store.setBusy('a', true)
  store.setBusy('a', true) // repeat true: no state change, must not restart clock
  clock.advance(IDLE_MS)
  store.setBusy('a', false) // ends NOW, so the clock restarts here
  assert.equal(store.remainingMs('a'), IDLE_MS, 'the duplicate setBusy did not shift anything')

  store.setBusy('ghost', true) // must not throw or create anything
  assert.equal(store.isShared('ghost'), false)
})

// ---- 4. setIdleHours takes effect immediately; invalid values ignored ----

test('setIdleHours shrinks the budget and the next sweep applies it', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })

  store.share('a')
  clock.advance(HOUR)
  store.setIdleHours(1)
  assert.equal(store.remainingMs('a'), 0, '1h idle against a 1h budget: expired right now')
  clock.advance(HOUR)
  assert.deepEqual(store.sweep(), ['a'], 'already past the new budget: closed on next sweep')
})

test('invalid idleHours values are ignored (constructor falls back to 48)', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 0, now: clock.now })
  store.share('b')
  assert.equal(store.remainingMs('b'), 48 * HOUR, 'constructor: 0 falls back to the 48h default')

  store.setIdleHours(2)
  const before = store.remainingMs('b')
  for (const bad of [0, -5, 9000, Number.NaN, '3', null, Infinity]) store.setIdleHours(bad)
  assert.equal(store.remainingMs('b'), before, 'every invalid value left the 2h budget in place')
})

// ---- 5. inheritance through parentOf ----

test('accessibility is inherited from a shared ancestor', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })
  const edges = { child: 'parent', grandchild: 'child', parent: 'root' }
  const parentOf = (id) => edges[id]

  assert.equal(store.isAccessible('parent', parentOf), false)
  store.share('parent')
  assert.equal(store.isAccessible('parent', parentOf), true, 'self counts')
  assert.equal(store.isAccessible('child', parentOf), true)
  assert.equal(store.isAccessible('grandchild', parentOf), true)
  assert.equal(store.isAccessible('root', parentOf), false, 'plain chain without a shared ancestor')
  assert.equal(store.isAccessible('stranger', parentOf), false)

  store.unshare('parent', 'manual')
  assert.equal(store.isAccessible('child', parentOf), false, 'ancestor gone: inheritance gone')
})

test('isAccessible: cycles, depth cap, and throwing parentOf all return false', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })

  // Two-node cycle, nobody shared: must return false, not hang. (If a shared
  // session sits ON the chain it is found before any cycle is completed.)
  const cycle = (id) => (id === 'a' ? 'b' : 'a')
  assert.equal(store.isAccessible('a', cycle), false)
  store.share('b')
  assert.equal(store.isAccessible('a', cycle), true, 'shared node on the ring: reachable')
  store.unshare('b', 'manual')
  assert.equal(store.isAccessible('a', cycle), false)

  // s0 → s1 → … → s40. The walk checks at most 16 ancestors (s1..s16), so a
  // shared s16 is reachable while a shared s17 — one hop too deep — is not.
  const edges = {}
  for (let i = 0; i < 40; i += 1) edges[`s${i}`] = `s${i + 1}`
  const parentOf = (id) => edges[id]
  for (const depth of [15, 16, 17]) {
    store.share(`s${depth}`)
    assert.equal(
      store.isAccessible('s0', parentOf),
      depth <= 16,
      `ancestor ${depth} hops up: ${depth <= 16 ? 'accessible' : 'beyond the 16-hop cap'}`,
    )
    store.unshare(`s${depth}`, 'manual')
  }

  assert.equal(
    store.isAccessible('x', () => {
      throw new Error('boom')
    }),
    false,
    'a throwing parentOf counts as "no parent"',
  )
})

// ---- 6. persistence across restarts + corruption handling ----

test('state and timing survive a restart; busy does not', (t) => {
  const clock = makeClock(T0)
  const file = tempFile(t)
  const first = createShareStore({ file, idleHours: 48, now: clock.now })
  first.share('a')
  clock.advance(5_000)
  first.share('b')
  first.setBusy('a', true)
  clock.advance(2_000)

  const second = createShareStore({ file, idleHours: 48, now: clock.now })
  assert.deepEqual(second.list(), [
    { sessionId: 'a', sharedAt: T0, lastActivityAt: T0, busy: false },
    { sessionId: 'b', sharedAt: T0 + 5_000, lastActivityAt: T0 + 5_000, busy: false },
  ])
  // Timing really resumed: advance exactly to 'a's original deadline (its
  // lastActivityAt was T0, and the clock is now T0+7000). Had the table been
  // re-based on restart, 'a' would still be idle for another 7 seconds — and
  // had `busy` been persisted, 'a' would never expire at all.
  clock.advance(IDLE_MS - 7_000)
  assert.deepEqual(second.sweep(), ['a'])
  assert.equal(second.isShared('b'), true, 'b still has 5s of budget left')
})

test('a corrupt file is quarantined as .corrupt-<time> and starts empty', (t) => {
  const clock = makeClock(T0)
  const file = tempFile(t)
  const dir = path.dirname(file)
  fs.writeFileSync(file, '{ this is not json')

  const store = createShareStore({ file, idleHours: 48, now: clock.now })
  assert.deepEqual(store.list(), [], 'corrupt JSON: empty table')
  const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith('shared-sessions.json.corrupt-'))
  assert.equal(quarantined.length, 1, 'exactly one quarantine copy')
  assert.equal(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8'), '{ this is not json')
})

test('wrong version or wrong shape quarantines too', (t) => {
  const clock = makeClock(T0)
  for (const body of [
    JSON.stringify({ version: 2, sessions: { a: { sharedAt: 1, lastActivityAt: 1 } } }),
    JSON.stringify({ version: 1 }),
    JSON.stringify([]),
    'null',
  ]) {
    const file = tempFile(t)
    fs.writeFileSync(file, body)
    const store = createShareStore({ file, idleHours: 48, now: clock.now })
    assert.deepEqual(store.list(), [], `quarantined: ${body}`)
    const dir = path.dirname(file)
    assert.equal(
      fs.readdirSync(dir).filter((name) => name.includes('.corrupt-')).length,
      1,
      `original preserved: ${body}`,
    )
  }
})

test('a single bad record is skipped, good records load', (t) => {
  const clock = makeClock(T0)
  const file = tempFile(t)
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      sessions: {
        good: { sharedAt: 10, lastActivityAt: 20 },
        nan: { sharedAt: 'x', lastActivityAt: 20 },
        infinite: { sharedAt: 1, lastActivityAt: null },
        '': { sharedAt: 1, lastActivityAt: 2 },
        notAnObject: [1, 2],
        missingField: { sharedAt: 1 },
      },
    }),
  )
  const store = createShareStore({ file, idleHours: 48, now: clock.now })
  assert.deepEqual(store.list(), [
    { sessionId: 'good', sharedAt: 10, lastActivityAt: 20, busy: false },
  ])
})

test('a write failure does not throw', (t) => {
  const clock = makeClock(T0)
  // `file` IS an existing directory: rename(file.tmp → file) cannot succeed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-share-store-dir-'))
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    // The failed persist leaves its <file>.tmp staging file NEXT to the
    // directory (i.e. here in os.tmpdir()) — sweep it too.
    fs.rmSync(`${dir}.tmp`, { force: true })
  })
  const store = createShareStore({ file: dir, idleHours: 48, now: clock.now })

  assert.equal(store.share('a'), true, 'the in-memory share still happens')
  assert.equal(store.list().length, 1)
  assert.notEqual(store.lastWriteError, undefined, 'the failure was recorded, not thrown')
})

test('an id of "__proto__" survives the persist round-trip', (t) => {
  const clock = makeClock(T0)
  const file = tempFile(t)
  const first = createShareStore({ file, idleHours: 48, now: clock.now })
  assert.equal(first.share('__proto__'), true, '__proto__ is a valid id (non-empty string, ≤200)')

  // It must exist in the file as an OWN key (a plain-object spread/assign
  // would route it into the prototype and it would never be serialized).
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(Object.hasOwn(persisted.sessions, '__proto__'), true)

  const second = createShareStore({ file, idleHours: 48, now: clock.now })
  assert.equal(second.isShared('__proto__'), true, 'reloaded from the same file')
})

// ---- 7. touch write throttle: at most one disk write per 60s per session ----

test('touch flushes to disk at most once per 60 seconds', (t) => {
  const clock = makeClock(T0)
  const file = tempFile(t)
  const store = createShareStore({ file, idleHours: 48, now: clock.now })
  const flushedAt = () => JSON.parse(fs.readFileSync(file, 'utf8')).sessions.a.lastActivityAt

  store.share('a') // structural write, not throttled: lands immediately
  assert.equal(flushedAt(), T0)

  clock.advance(30_000)
  store.touch('a')
  store.touch('a')
  assert.equal(flushedAt(), T0, 'inside the 60s window: memory updated, disk untouched')

  clock.advance(31_000) // 61s since the share write
  store.touch('a')
  assert.equal(flushedAt(), T0 + 61_000, 'past the window: the next touch writes')

  clock.advance(10_000) // only 10s since the flush above
  store.touch('a')
  assert.equal(flushedAt(), T0 + 61_000, 'throttled again')
})

// ---- 8. listener isolation + unsubscribe ----

test('a throwing listener does not hurt the others or the operation', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })
  const seen = []
  store.subscribe(() => {
    throw new Error('listener bug')
  })
  store.subscribe((event) => seen.push(event))
  const unsubscribe = store.subscribe((event) => seen.push({ echo: event.type }))

  assert.equal(store.share('a'), true, 'the operation succeeded despite the throwing listener')
  assert.deepEqual(seen, [
    { type: 'shared', sessionId: 'a' },
    { echo: 'shared' },
  ])

  unsubscribe()
  store.unshare('a', 'manual')
  assert.deepEqual(seen, [
    { type: 'shared', sessionId: 'a' },
    { echo: 'shared' },
    { type: 'unshared', sessionId: 'a', reason: 'manual' },
  ])
})

// ---- 9. hostile session ids are rejected everywhere ----

test('invalid session ids are rejected by every method', (t) => {
  const clock = makeClock(T0)
  const store = createShareStore({ file: tempFile(t), idleHours: 48, now: clock.now })
  const events = recorder(store)
  const badIds = ['', 'x'.repeat(201), null, undefined, 42, {}]

  for (const id of badIds) {
    assert.equal(store.share(id), false, `share rejects ${typeof id}`)
    assert.equal(store.unshare(id, 'manual'), false)
    assert.equal(store.isShared(id), false)
    assert.equal(store.isAccessible(id, () => 'parent'), false)
    assert.equal(store.remainingMs(id), undefined)
    store.touch(id) // must not throw, must not create
    store.setBusy(id, true)
  }
  assert.deepEqual(store.list(), [], 'nothing leaked into the table')
  assert.deepEqual(events, [], 'no events for hostile ids')
})
