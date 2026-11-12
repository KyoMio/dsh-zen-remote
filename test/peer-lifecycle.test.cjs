'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { registerHooks, stripTypeScriptTypes } = require('node:module')
const { existsSync, readFileSync } = require('node:fs')
const { fileURLToPath } = require('node:url')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (existsSync(url)) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform' }) }
    return next(url, context)
  },
})
const { PeerArqSession } = require('../src/peer/arq.ts')
const { PeerFrameType: F } = require('../src/peer/wire.ts')
function clock() {
  let now = 0, id = 0
  const timers = new Map()
  return { now: () => now, setTimeout(fn, ms) { timers.set(++id, { at: now + ms, fn }); return id }, clearTimeout(id) { timers.delete(id) },
    advance(ms) { const end = now + ms; for (;;) { const next = [...timers].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at)[0]; if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].fn() } now = end }, count: () => timers.size }
}
function frame(seq, text = '', fin = false) { const b = Buffer.alloc(5 + Buffer.byteLength(text)); b[0] = +fin; b.writeUInt32BE(seq, 1); b.write(text, 5); return b }
function session(options = {}) { const c = clock(), sent = []; const arq = new PeerArqSession({ clock: c, sendFrame: (...f) => sent.push(f), ...options }); return { arq, c, sent } }

test('blocked expected DATA and out-of-order FIN are never selectively acknowledged', () => {
  const { arq, sent } = session({ onStreamData: () => false })
  arq.handleFrame(F.DATA, 1, frame(0, 'a'), 0)
  arq.handleFrame(F.DATA, 1, frame(1, '', true), 0)
  assert.equal(sent.at(-1)[3], 0)
  assert.equal(sent.at(-1)[2][0], 0, 'neither unaccepted expected data nor undelivered FIN is SACKed')
  arq.closeAll()
})

test('FIN promise requires cumulative ACK even when peer SACK bitmap includes FIN', async () => {
  const { arq } = session()
  let finished = false
  const p = arq.finish(1).then(() => { finished = true })
  arq.handleFrame(F.SACK, 1, Buffer.from([1]), 0)
  await Promise.resolve()
  assert.equal(finished, false)
  arq.handleFrame(F.ACK, 1, Buffer.alloc(0), 1)
  await p
  arq.closeAll()
})

test('lost RST and RST ACK retry without loops, then release all timers', () => {
  const a = session({ retryTimeoutMs: 1000 }), b = session()
  let resets = 0
  b.arq.onStreamReset = () => resets++
  a.arq.reset(1) // drop first RST
  a.c.advance(120)
  assert.equal(a.sent.filter(f => f[0] === F.RST).length, 2)
  let req = a.sent.at(-1)
  assert.equal(req[2][0], 1)
  b.arq.handleFrame(...req) // drop first ACK
  a.c.advance(240)
  req = a.sent.at(-1)
  b.arq.handleFrame(...req)
  assert.equal(b.sent.at(-1)[2][0], 2)
  a.arq.handleFrame(...b.sent.at(-1))
  const count = a.sent.length
  a.c.advance(10000)
  assert.equal(a.sent.length, count)
  assert.equal(a.c.count(), 0)
  assert.equal(resets, 1)
  a.arq.closeAll(); b.arq.closeAll()
})

test('retired stream never resurrects after final ACK cache expiry or many later streams', () => {
  let delivered = 0
  const { arq, c } = session({ onStreamData: () => { delivered++ } })
  arq.reset(1)
  for (let id = 3; id < 2200; id += 2) arq.reset(id)
  c.advance(120000)
  arq.handleFrame(F.DATA, 1, frame(0, 'late legacy retry'), 0)
  assert.equal(delivered, 0)
  arq.closeAll()
})

test('DATA no-progress expires but idle live stream does not', async () => {
  const closed = []
  const { arq, c } = session({ retryTimeoutMs: 1000, onStreamClosed: (...args) => closed.push(args) })
  const p = arq.write(1, Buffer.from('lost'))
  c.advance(1100)
  assert.equal(closed.length, 1)
  await assert.rejects(p, /progress|timeout/)
  const q = arq.write(2, Buffer.from('ok'))
  arq.handleFrame(F.ACK, 2, Buffer.alloc(0), 1)
  await q
  c.advance(120000)
  assert.equal(closed.length, 1)
  arq.closeAll()
})

test('lost final ACK is recovered from terminal cache after receiver released live state', async () => {
  const a = session(), b = session()
  const pa = a.arq.finish(1), pb = b.arq.finish(1)
  b.arq.handleFrame(...a.sent[0])
  a.arq.handleFrame(...b.sent[0])
  // Deliver ACK only to B. B is now closed and A must retransmit its FIN.
  b.arq.handleFrame(...a.sent.at(-1))
  await pb
  assert.equal(b.arq.active.size, 0)
  a.c.advance(120)
  b.arq.handleFrame(...a.sent.at(-1))
  a.arq.handleFrame(...b.sent.at(-1))
  await pa
  assert.equal(a.arq.active.size, 0)
  a.arq.closeAll(); b.arq.closeAll()
})

test('progressing transfers outlive retry timeout while fresh writes cannot extend a blackhole', async () => {
  const { arq, c } = session({ retryTimeoutMs: 1000 })
  for (let seq = 0; seq < 100; seq++) {
    const p = arq.write(1, Buffer.alloc(1))
    c.advance(900)
    arq.handleFrame(F.ACK, 1, Buffer.alloc(0), seq + 1)
    await p
  }
  assert.ok(arq.active.has(1), '90 second active stream is healthy')
  const lost = arq.write(2, Buffer.from('lost'))
  for (let i = 0; i < 11; i++) { void arq.write(2, Buffer.alloc(1)).catch(() => {}); c.advance(100) }
  await assert.rejects(lost, /no-progress/)
  arq.closeAll()
})

test('terminal capacity reserves active streams and never evicts fresh ACK or retired ranges', async () => {
  const { arq, c } = session({ maxTerminalRecords: 2, maxRetiredRanges: 3, terminalTtlMs: 1000, retryTimeoutMs: 500 })
  const a = arq.write(1, Buffer.alloc(1)), b = arq.write(5, Buffer.alloc(1))
  await assert.rejects(arq.write(9, Buffer.alloc(1)), /capacity/)
  arq.reset(1); arq.reset(5)
  await assert.rejects(a); await assert.rejects(b)
  await assert.rejects(arq.write(9, Buffer.alloc(1)), /capacity/)
  c.advance(1100)
  arq.reset(9)
  c.advance(1100)
  for (let id = 13; id < 1000; id += 4) arq.handleFrame(F.DATA, id, frame(0, 'rejected'), 0)
  assert.equal(arq.retired[1].length, 3)
  assert.equal(arq.active.size, 0)
  arq.closeAll()
})

for (const cancel of [true, false]) test(`capacity-${cancel ? 'cancelled' : 'rejected'} ID stays retired after capacity recovers`, () => {
  const received = []
  const { arq, sent } = session({ maxStreams: 1, onStreamData: id => { received.push(id) } })
  arq.handleFrame(F.DATA, 1, frame(0, 'active'), 0)
  arq.handleFrame(cancel ? F.RST : F.DATA, 3, cancel ? Buffer.from([1]) : frame(0, 'refused'), 0)
  assert.equal(sent.at(-1)[0], F.RST)
  arq.reset(1)
  arq.handleFrame(F.DATA, 3, frame(0, 'late'), 0)
  assert.deepEqual(received, [1])
  arq.closeAll()
})

test('exhausted retirement history permanently rejects new IDs while active stream can finish', async () => {
  const received = [], errors = []
  const { arq, c, sent } = session({ maxStreams: 1, maxRetiredRanges: 2, onStreamData: id => { received.push(id) }, onAdmissionClosed: error => errors.push(error.message) })
  arq.handleFrame(F.DATA, 1, frame(0, 'head'), 0)
  arq.handleFrame(F.RST, 5, Buffer.from([1]), 0)
  arq.handleFrame(F.RST, 9, Buffer.from([1]), 0)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /rejoin/)
  arq.handleFrame(F.DATA, 1, frame(1, 'still active'), 0)
  const finish = arq.finish(1)
  arq.handleFrame(F.DATA, 1, frame(2, '', true), 1)
  await finish
  assert.equal(arq.active.size, 0)
  arq.handleFrame(F.DATA, 1, frame(2, '', true), 1)
  assert.equal(sent.at(-1)[0], F.SACK, 'existing stream final ACK recovery survives closed admission')
  assert.equal(sent.at(-1)[3], 3)
  c.advance(120000)
  for (let id = 5; id < 4000; id += 4) arq.handleFrame(F.DATA, id, frame(0, 'late'), 0)
  assert.deepEqual(received, [1, 1, 1])
  await assert.rejects(arq.write(4001, Buffer.alloc(1)), /rejoin/)
  assert.throws(() => arq.tryWrite(4001, Buffer.alloc(1)), /rejoin/)
  assert.ok(arq.retired[0].length + arq.retired[1].length <= 2)
  assert.equal(errors.length, 1)
  arq.closeAll()
})

test('synchronous resume during delivery never delivers the same frame twice', () => {
  let calls = 0
  const { arq } = session({ onStreamData: id => { calls++; if (calls < 3) arq.resume(id) } })
  arq.handleFrame(F.DATA, 1, frame(0, 'x'), 0)
  assert.equal(calls, 1)
  arq.closeAll()
})

test('out-of-order traffic cannot consume space reserved for the missing expected frame', () => {
  const received = []
  const { arq } = session({ maxSessionBytes: 32, maxStreams: 2, onStreamData: (id, bytes) => received.push([id, bytes.length]) })
  arq.handleFrame(F.DATA, 1, frame(1, 'x'.repeat(16)), 0)
  arq.handleFrame(F.DATA, 2, frame(1, 'y'.repeat(16)), 0)
  arq.handleFrame(F.DATA, 1, frame(0, 'head'), 0)
  arq.handleFrame(F.DATA, 2, frame(0, 'head'), 0)
  assert.ok(received.some(([id]) => id === 1) && received.some(([id]) => id === 2), 'both missing heads can make progress')
  assert.ok(arq.bufferedReceiveBytes() <= 32)
  arq.closeAll()
})

test('1000 graceful duplex closes release live state and late FIN is re-ACKed', async () => {
  const closed = []
  const { arq, sent } = session({ onStreamClosed: id => closed.push(id) })
  for (let id = 1; id <= 1000; id++) {
    const p = arq.finish(id)
    arq.handleFrame(F.DATA, id, frame(0, '', true), 1)
    await p
  }
  assert.equal(closed.length, 1000)
  assert.equal(arq.txStreams.size, 0)
  assert.equal(arq.rxStreams.size, 0)
  arq.handleFrame(F.DATA, 1, frame(0, '', true), 0)
  assert.equal(sent.at(-1)[0], F.SACK)
  assert.equal(sent.at(-1)[3], 1)
  arq.closeAll()
})
