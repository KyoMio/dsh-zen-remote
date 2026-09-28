/* dsh-zen-remote · restart watcher (src/restart-watcher.ts → lib/restart-watcher.js)
 *
 * T17: every Config field is volatile, so the "needs restart" semantics ride
 * a fingerprint comparison instead of the volatility flag. T17b gave that
 * comparison two triggers sharing one fire-at-most-once guard: the returned
 * checkNow() — which the host half wires to the loader's
 * `loader/volatile-update` event, so a volatile-only settings save re-checks
 * immediately instead of waiting out the poll — and the 2s poll, kept as the
 * fallback for lan-gate.config.json and environment changes.
 * These tests pin the pure pieces — restartKey's sensitivity
 * (restart-required fields only, stable key order) and startRestartWatcher's
 * lifecycle (fires exactly once across EITHER trigger, stops after firing,
 * survives a throwing getValues, honors cleanup) — against a fake clock, the
 * same injectable-timer shape test/activity.test.cjs uses for the idle
 * sweeper. Drives the BUILT lib/restart-watcher.js like the other
 * lib-driving tests (src/ uses relative specifiers Node's strip-only type
 * stripping cannot map).
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const WATCHER_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'restart-watcher.js')).href
const load = () => import(WATCHER_URL)

/** Fake timer halves: ticks run only when driven, and record whether the
 * watcher cleared its handle. */
function fakeTimers() {
  const timers = []
  return {
    setIntervalImpl: (cb, ms) => {
      const timer = { cb, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearIntervalImpl: (timer) => { timer.cleared = true },
    tick: () => { for (const timer of timers) if (!timer.cleared) timer.cb() },
    anyCleared: () => timers.some((timer) => timer.cleared),
    lastMs: () => timers[timers.length - 1].ms,
  }
}

// --- restartKey -------------------------------------------------------------

test('restartKey is sensitive to exactly the restart-required fields', async () => {
  const { restartKey, RESTART_FIELDS } = await load()
  const base = {
    role: 'host', port: 3088, host: '127.0.0.1', targetPort: undefined, rateLimit: 120,
    trustedProxies: '', vapidSubject: 'mailto:admin@localhost', lang: 'auto',
    pushEvents: 'agent/turn-stopping', pushDebounceMs: 15000, pushSummary: false,
    pushTurnEnd: false, pushTool: true,
    // The live-read fields: changing any of these must NOT move the key.
    serverName: 'box', idleHours: 48, autoShareNewSessions: false,
    serverUrl: 'https://gw.example', deviceToken: 'tok',
    turnFoldDesktop: true, maxUploadBytes: 1024,
  }
  const baseline = restartKey(base)

  // Every live-read field can change freely.
  assert.equal(restartKey({ ...base, serverName: 'renamed' }), baseline, 'serverName is live-read')
  assert.equal(restartKey({ ...base, idleHours: 24 }), baseline, 'idleHours is live-read')
  assert.equal(restartKey({ ...base, autoShareNewSessions: true }), baseline, 'autoShareNewSessions is live-read')
  assert.equal(restartKey({ ...base, serverUrl: 'http://other' }), baseline, 'serverUrl is live-read')
  assert.equal(restartKey({ ...base, deviceToken: 'tok2' }), baseline, 'deviceToken is live-read')
  assert.equal(restartKey({ ...base, turnFoldDesktop: false }), baseline, 'turnFoldDesktop is live-read')
  assert.equal(restartKey({ ...base, maxUploadBytes: 1 }), baseline, 'maxUploadBytes is live-read')

  // Every restart-required field moves the key.
  const flips = {
    role: 'client', port: 4000, host: '0.0.0.0', targetPort: 3080, rateLimit: 1,
    trustedProxies: '10.0.0.1', vapidSubject: 'mailto:x@y.z', lang: 'zh',
    pushEvents: 'other/event', pushDebounceMs: 1, pushSummary: true,
    pushTurnEnd: true, pushTool: false,
  }
  assert.deepEqual(Object.keys(flips).sort(), [...RESTART_FIELDS].sort(), 'the flip table covers the whole set')
  for (const [field, value] of Object.entries(flips)) {
    assert.notEqual(restartKey({ ...base, [field]: value }), baseline, `${field} must move the key`)
  }
})

test('restartKey is independent of key order and of extra unknown fields', async () => {
  const { restartKey } = await load()
  assert.equal(restartKey({ port: 1, role: 'host' }), restartKey({ role: 'host', port: 1 }), 'sorted key order')
  assert.equal(restartKey({ port: 1, role: 'host', extra: 'x' }), restartKey({ role: 'host', port: 1 }), 'unknown fields ignored')
})

// --- startRestartWatcher: the poll trigger -----------------------------------

test('the watcher polls at the configured interval and fires only on a restart-field change', async () => {
  const { startRestartWatcher } = await load()
  const clock = fakeTimers()
  const values = { port: 3088, serverName: 'before' }
  let fires = 0
  const { stop } = startRestartWatcher({
    getValues: () => values,
    onChange: () => { fires += 1 },
    intervalMs: 2000,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
  })
  assert.equal(clock.lastMs(), 2000)

  clock.tick() // unchanged
  assert.equal(fires, 0)
  values.serverName = 'after' // live-read field: the fingerprint must not move
  clock.tick()
  assert.equal(fires, 0, 'a serverName change never triggers')

  values.port = 4000
  clock.tick()
  assert.equal(fires, 1, 'a port change triggers exactly once')

  // After firing, the poll is done: more ticks, more changes — nothing.
  values.port = 4001
  clock.tick()
  clock.tick()
  assert.equal(fires, 1, 'the watcher stops after firing')

  stop()
  assert.equal(clock.anyCleared(), true, 'the timer was cleared')
})

test('a changed non-restart field never fires; cleanup silences later changes', async () => {
  const { startRestartWatcher } = await load()
  const clock = fakeTimers()
  const values = { port: 3088, serverName: 'a', lang: 'auto' }
  let fires = 0
  const { stop } = startRestartWatcher({
    getValues: () => values,
    onChange: () => { fires += 1 },
    intervalMs: 2000,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
  })

  // Cleanup before anything changed: later restart-field moves must not fire.
  stop()
  values.port = 4000
  values.lang = 'zh'
  clock.tick()
  clock.tick()
  assert.equal(fires, 0, 'no tick runs after cleanup')
})

test('a throwing getValues is swallowed and retried on the next tick', async () => {
  const { startRestartWatcher } = await load()
  const clock = fakeTimers()
  const values = { port: 3088 }
  let fail = true
  let fires = 0
  const { stop } = startRestartWatcher({
    getValues: () => {
      if (fail) throw new Error('resolution hiccup')
      return values
    },
    onChange: () => { fires += 1 },
    intervalMs: 2000,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
  })
  clock.tick() // throws inside getValues — must not propagate
  assert.equal(fires, 0)

  fail = false
  clock.tick() // baseline for this round: same port → no fire
  assert.equal(fires, 0)

  values.port = 4000
  clock.tick()
  assert.equal(fires, 1, 'recovers and fires on the next real change')

  stop()
})

test('the watcher fires exactly once even when the change lands across two ticks', async () => {
  const { startRestartWatcher } = await load()
  const clock = fakeTimers()
  const values = { port: 3088 }
  let fires = 0
  const { stop } = startRestartWatcher({
    getValues: () => values,
    onChange: () => { fires += 1 },
    intervalMs: 2000,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
  })
  values.port = 4000
  clock.tick()
  values.port = 4001
  clock.tick()
  assert.equal(fires, 1, 'the second tick is already disarmed')
  stop()
})

// --- startRestartWatcher: the immediate trigger (T17b) ------------------------

test('checkNow fires without waiting for a poll tick (the loader/volatile-update path)', async () => {
  const { startRestartWatcher } = await load()
  const clock = fakeTimers()
  const values = { port: 3088 }
  let fires = 0
  const { stop, checkNow } = startRestartWatcher({
    getValues: () => values,
    onChange: () => { fires += 1 },
    intervalMs: 2000,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
  })

  // The change lands and the event dispatches BEFORE any tick: the immediate
  // check must do all the work.
  values.port = 4000
  checkNow()
  assert.equal(fires, 1, 'fired synchronously, no tick driven')
  assert.equal(clock.anyCleared(), true, 'the poll was disarmed by the immediate fire')

  // Exactly once: neither further dispatches nor leftover ticks re-fire.
  values.port = 4001
  checkNow()
  clock.tick()
  assert.equal(fires, 1)

  stop()
})

test('checkNow ignores live-read-only changes and waits for the poll to cover file/env layers', async () => {
  const { startRestartWatcher } = await load()
  const clock = fakeTimers()
  const values = { port: 3088, serverName: 'before' }
  let fires = 0
  const { stop, checkNow } = startRestartWatcher({
    getValues: () => values,
    onChange: () => { fires += 1 },
    intervalMs: 2000,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
  })

  // A volatile-only save that touched a live-read field announces itself,
  // but the restart fingerprint did not move: no reload.
  values.serverName = 'after'
  checkNow()
  assert.equal(fires, 0, 'a live-read-only change never fires')
  assert.equal(clock.anyCleared(), false, 'the poll stays armed')

  // The poll trigger still works afterwards.
  values.port = 4000
  clock.tick()
  assert.equal(fires, 1, 'the poll fires on the restart-field move')

  stop()
})

test('checkNow shares the baseline: a change seen by either trigger fires exactly once', async () => {
  const { startRestartWatcher } = await load()
  const clock = fakeTimers()
  const values = { port: 3088 }
  let fires = 0
  const { stop, checkNow } = startRestartWatcher({
    getValues: () => values,
    onChange: () => { fires += 1 },
    intervalMs: 2000,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
  })

  values.port = 4000
  clock.tick() // the poll sees it first
  assert.equal(fires, 1)
  checkNow() // a late event dispatch for the same change
  assert.equal(fires, 1, 'the immediate check is already disarmed')
  clock.tick()
  assert.equal(fires, 1)

  stop()
})

test('checkNow swallows a throwing getValues like the poll does', async () => {
  const { startRestartWatcher } = await load()
  const clock = fakeTimers()
  const values = { port: 3088 }
  let fail = false
  let fires = 0
  const { stop, checkNow } = startRestartWatcher({
    getValues: () => {
      if (fail) throw new Error('resolution hiccup')
      return values
    },
    onChange: () => { fires += 1 },
    intervalMs: 2000,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
  })

  fail = true
  checkNow() // must not propagate
  assert.equal(fires, 0)
  fail = false
  checkNow() // unchanged: same baseline, no fire
  assert.equal(fires, 0)
  values.port = 4000
  checkNow()
  assert.equal(fires, 1, 'recovers on the next successful comparison')

  stop()
})
