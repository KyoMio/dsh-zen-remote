/* dsh-zen-remote · log ring (src/log-ring.ts, CU-1)
 *
 * The debug report's log section source: capacity truncation (oldest
 * dropped), util.format interpolation, the 512-character message cap, and
 * the snapshot contract — a copy, so a caller mutating the returned array
 * or its entries never reaches the ring's own state. Also the apply()
 * wiring's double-writer: createPluginLog reaches the context logger AND
 * the ring, and survives a logger-free fake context.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')

const { createLogRing, createPluginLog } = require('../lib/log-ring.js')

test('capacity truncation keeps the newest entries and drops the oldest', () => {
  const ring = createLogRing(3)
  for (let n = 1; n <= 5; n += 1) ring.push('info', 'line-%d', n)
  const snap = ring.snapshot()
  assert.equal(snap.length, 3)
  assert.deepEqual(snap.map((e) => e.msg), ['line-3', 'line-4', 'line-5'])
})

test('the default capacity is 300', () => {
  const ring = createLogRing()
  for (let n = 1; n <= 305; n += 1) ring.push('info', 'line-%d', n)
  const snap = ring.snapshot()
  assert.equal(snap.length, 300)
  assert.equal(snap[0].msg, 'line-6')
  assert.equal(snap[299].msg, 'line-305')
})

test('messages are interpolated with util.format', () => {
  const ring = createLogRing()
  ring.push('warn', 'relay offline code=%s retry=%d obj=%j', 'timeout', 7, { a: 1 })
  const [entry] = ring.snapshot()
  assert.equal(entry.level, 'warn')
  assert.equal(entry.msg, 'relay offline code=timeout retry=7 obj={"a":1}')
})

test('a plain string without arguments stays verbatim', () => {
  const ring = createLogRing()
  ring.push('info', 'row applied')
  assert.equal(ring.snapshot()[0].msg, 'row applied')
})

test('messages longer than 512 characters are truncated', () => {
  const ring = createLogRing()
  ring.push('info', 'x'.repeat(600))
  assert.equal(ring.snapshot()[0].msg.length, 512)
})

test('every entry carries an ISO timestamp', () => {
  const ring = createLogRing()
  ring.push('info', 'when')
  const { t } = ring.snapshot()[0]
  assert.match(t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  assert.equal(new Date(t).toISOString(), t)
})

test('snapshot returns copies: mutating it never reaches the ring', () => {
  const ring = createLogRing(2)
  ring.push('info', 'first')
  ring.push('warn', 'second')
  const snap = ring.snapshot()
  snap.length = 0
  snap.push({ t: 'tampered', level: 'info', msg: 'tampered' })
  const fresh = ring.snapshot()
  assert.equal(fresh.length, 2)
  assert.equal(fresh[0].msg, 'first')
  assert.equal(fresh[1].msg, 'second')
  // Entry objects are copies too — editing one does not leak into the ring.
  const again = ring.snapshot()
  again[0].msg = 'tampered'
  assert.equal(ring.snapshot()[0].msg, 'first')
})

test('a malformed format string never breaks push', () => {
  const ring = createLogRing()
  ring.push('info', 'percent %d %s trailing')
  assert.equal(ring.snapshot()[0].msg, 'percent %d %s trailing')
  ring.push('info', 'bad %j', undefined)
  assert.equal(ring.snapshot().length, 2)
})

test('createPluginLog double-writes into the logger and the ring', () => {
  const ring = createLogRing()
  const seen = []
  const log = createPluginLog(ring, {
    info: (...args) => seen.push(['info', ...args]),
    warn: (...args) => seen.push(['warn', ...args]),
  })
  log.info('attached via=%s', 'inject')
  log.warn('refused: %s', 'shape')
  assert.deepEqual(seen, [
    ['info', 'attached via=%s', 'inject'],
    ['warn', 'refused: %s', 'shape'],
  ])
  const snap = ring.snapshot()
  assert.equal(snap.length, 2)
  assert.equal(snap[0].level, 'info')
  assert.equal(snap[0].msg, 'attached via=inject')
  assert.equal(snap[1].level, 'warn')
  assert.equal(snap[1].msg, 'refused: shape')
})

test('createPluginLog survives a logger-free fake context and a method-less logger', () => {
  const ring = createLogRing()
  const log = createPluginLog(ring, undefined)
  log.warn('still logged')
  assert.equal(ring.snapshot()[0].msg, 'still logged')
  const log2 = createPluginLog(createLogRing(), {})
  log2.info('no methods')
})
