/* dsh-zen-remote · peer-gateway PG-7 (tasks/peer-gateway/PG-7.md)
 *
 * src/peer/arq.ts — the sliding-window ARQ that turns the ≤1200B sealed
 * frames of src/peer/wire.ts into a reliable ordered byte stream:
 *   - stream subheader [flags:1B, streamSeq:4B] + data chunk ≤ 1100B,
 *     so every ARQ payload fits the 1156B plaintext budget and every
 *     sealed frame stays ≤ 1200B;
 *   - per-stream send window (default 64 unacked fragments) with
 *     backpressure Promises on write();
 *   - cumulative ack (header `ack` = next expected streamSeq) plus a
 *     64-bit selective bitmap (8B payload, bit i = cumAck + i seen);
 *   - per-fragment RTO timers (default 120ms, ×2 backoff, 1000ms cap);
 *   - FIN half-close riding on the last fragment, RST abort, and
 *     closeAll() that clears every timer and rejects pending writes;
 *   - the physical send function is read at every (re)transmit, so
 *     swapping it mid-flight (gateway WS ↔ UDP direct) retransmits
 *     unacked fragments over the new path with zero byte loss.
 *
 * Everything here drives the BUILT lib/peer/arq.js like every other
 * wiring test in this repo.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash, randomBytes } = require('node:crypto')
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

const {
  PeerArqSession,
  STREAM_HEADER_BYTES,
  STREAM_FLAG_FIN,
  ARQ_CHUNK_MAX_BYTES,
  ARQ_DEFAULT_CHUNK_BYTES,
  ARQ_DEFAULT_WINDOW,
  ARQ_DEFAULT_RTO_MS,
  ARQ_DEFAULT_RTO_MAX_MS,
} = require('../src/peer/arq.ts')
const {
  PeerFrameType,
  packEncryptedFrame,
  unpackEncryptedFrame,
  PEER_MAX_PLAINTEXT_BYTES,
  PEER_MAX_FRAME_BYTES,
  PEER_HEADER_BYTES,
  PEER_AEAD_TAG_BYTES,
} = require('../src/peer/wire.ts')
const {
  generatePeerIdentity,
  generateEphemeralX25519,
  derivePeerSessionCiphers,
} = require('../src/peer/crypto.ts')

// -- harness helpers -------------------------------------------------------------

/** Deterministic virtual clock: timers fire only when advance() is called. */
function manualClock() {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        let best = null
        for (const [id, t] of timers) {
          if (t.at > target) continue
          if (!best || t.at < best.t.at || (t.at === best.t.at && id < best.id)) best = { id, t }
        }
        if (!best) break
        now = Math.max(now, best.t.at)
        timers.delete(best.id)
        best.t.fn()
      }
      now = target
    },
    pendingCount: () => timers.size,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function defer() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A session whose outgoing frames land in a captured list (virtual clock). */
function makeSession(overrides = {}, clock = manualClock()) {
  const sent = []
  const session = new PeerArqSession({
    sendFrame: (frameType, streamId, payload, ack) => {
      sent.push({ frameType, streamId, payload: Buffer.from(payload), ack, at: clock.now() })
    },
    clock,
    ...overrides,
  })
  return { session, sent, clock }
}

/** Decode one ARQ stream subheader: [flags:1B][streamSeq:4B BE][data...]. */
function subheaderOf(payload) {
  return {
    flags: payload[0],
    seq: payload.readUInt32BE(1),
    data: payload.subarray(STREAM_HEADER_BYTES),
  }
}

function emptyBitmap() {
  return Buffer.alloc(8)
}

/** Per-stream assembler collecting ordered onStreamData chunks. */
function makeAssembler() {
  const streams = new Map()
  const finals = new Map()
  return {
    onStreamData(streamId, chunk, final) {
      let entry = streams.get(streamId)
      if (!entry) {
        entry = []
        streams.set(streamId, entry)
      }
      if (chunk.byteLength > 0) entry.push(Buffer.from(chunk))
      if (final) finals.set(streamId, true)
    },
    bytesOf(streamId) {
      return Buffer.concat(streams.get(streamId) ?? [])
    },
    finalOf(streamId) {
      return finals.get(streamId) === true
    },
    chunkCount(streamId) {
      return (streams.get(streamId) ?? []).length
    },
  }
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function nextRandom() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A complete two-node AEAD session for frame-budget interop checks. */
function freshPeerSession(networkId = 'abcdef0123456789') {
  const A = generatePeerIdentity()
  const B = generatePeerIdentity()
  const aEph = generateEphemeralX25519()
  const bEph = generateEphemeralX25519()
  const ciphersA = derivePeerSessionCiphers({
    networkId, myNodeId: A.nodeId, peerNodeId: B.nodeId,
    myEphPrivateKeyHex: aEph.privateKeyHex, myEphPublicKeyHex: aEph.publicKeyHex, peerEphPublicKeyHex: bEph.publicKeyHex,
  })
  const ciphersB = derivePeerSessionCiphers({
    networkId, myNodeId: B.nodeId, peerNodeId: A.nodeId,
    myEphPrivateKeyHex: bEph.privateKeyHex, myEphPublicKeyHex: bEph.publicKeyHex, peerEphPublicKeyHex: aEph.publicKeyHex,
  })
  return { A, B, ciphersA, ciphersB }
}

/** Wire two sessions over an in-memory link: 'perfect' or a lossy RNG path. */
function wireSessions(sessionA, sessionB, rng = null) {
  const link = {
    impl: 'lossy',
    swapped: false,
    forwarded: 0,
    dropped: 0,
    swapAfter: Number.POSITIVE_INFINITY,
  }
  const forward = (to, frameType, streamId, payload, ack) => {
    link.forwarded += 1
    if (link.impl === 'lossy' && link.forwarded > link.swapAfter) {
      link.impl = 'perfect'
      link.swapped = true
    }
    if (link.impl === 'perfect') {
      setImmediate(() => to.handleFrame(frameType, streamId, Buffer.from(payload), ack))
      return
    }
    if (rng && rng() < 0.2) {
      link.dropped += 1
      return
    }
    const delay = rng ? Math.floor(rng() * 15) : 0
    setTimeout(() => to.handleFrame(frameType, streamId, Buffer.from(payload), ack), delay)
  }
  sessionA.sendFrame = (frameType, streamId, payload, ack) => forward(sessionB, frameType, streamId, payload, ack)
  sessionB.sendFrame = (frameType, streamId, payload, ack) => forward(sessionA, frameType, streamId, payload, ack)
  return link
}

// -- 1. constants and frame budget -----------------------------------------------

test('arq constants pin the stream subheader and frame budget math', () => {
  assert.equal(STREAM_HEADER_BYTES, 5)
  assert.equal(STREAM_FLAG_FIN, 0x01)
  assert.equal(ARQ_CHUNK_MAX_BYTES, PEER_MAX_PLAINTEXT_BYTES - 5)
  assert.equal(ARQ_DEFAULT_CHUNK_BYTES, 1100)
  assert.equal(ARQ_DEFAULT_WINDOW, 64)
  assert.equal(ARQ_DEFAULT_RTO_MS, 120)
  assert.equal(ARQ_DEFAULT_RTO_MAX_MS, 1000)
  // Max-chunk frame: 28 header + 5 subheader + 1151 data + 16 tag = 1200.
  assert.equal(PEER_HEADER_BYTES + STREAM_HEADER_BYTES + ARQ_CHUNK_MAX_BYTES + PEER_AEAD_TAG_BYTES, PEER_MAX_FRAME_BYTES)
  // Default-chunk frame fits with room to spare.
  assert.ok(PEER_HEADER_BYTES + STREAM_HEADER_BYTES + ARQ_DEFAULT_CHUNK_BYTES + PEER_AEAD_TAG_BYTES <= PEER_MAX_FRAME_BYTES)
})

test('constructor validates options; malformed streamIds and chunk sizes throw', () => {
  const sendFrame = () => {}
  assert.throws(() => new PeerArqSession({ sendFrame: 'nope' }), TypeError)
  assert.throws(() => new PeerArqSession({ sendFrame, chunkSize: 0 }), RangeError)
  assert.throws(() => new PeerArqSession({ sendFrame, chunkSize: ARQ_CHUNK_MAX_BYTES + 1 }), RangeError)
  assert.throws(() => new PeerArqSession({ sendFrame, windowSize: 0 }), RangeError)
  assert.throws(() => new PeerArqSession({ sendFrame, windowSize: 1.5 }), RangeError)
  assert.throws(() => new PeerArqSession({ sendFrame, rtoMs: 0 }), RangeError)
  assert.throws(() => new PeerArqSession({ sendFrame, rtoMs: 300, rtoMaxMs: 200 }), RangeError)
  // chunkSize exactly at the ceiling is legal (frame = 1200 exactly).
  assert.doesNotThrow(() => new PeerArqSession({ sendFrame, chunkSize: ARQ_CHUNK_MAX_BYTES }))
})

// -- 2. fragmentation and send window ---------------------------------------------

test('write fragments under the chunk budget with sequential streamSeqs', async () => {
  const { session, sent } = makeSession()
  const bytes = Buffer.alloc(2501, 0xab)
  const write = session.write(1, bytes)
  // Synchronous pump: 1100 + 1100 + 301 under the default 1100B chunk.
  assert.equal(sent.length, 3)
  assert.deepEqual(sent.map((f) => f.frameType), [PeerFrameType.DATA, PeerFrameType.DATA, PeerFrameType.DATA])
  assert.deepEqual(sent.map((f) => f.streamId), [1, 1, 1])
  const frags = sent.map((f) => subheaderOf(f.payload))
  assert.deepEqual(frags.map((f) => f.seq), [0, 1, 2])
  assert.deepEqual(frags.map((f) => f.flags), [0, 0, 0])
  assert.deepEqual(frags.map((f) => f.data.length), [1100, 1100, 301])
  assert.ok(frags[2].data.equals(bytes.subarray(2200)))
  // Backpressure promise is pending until every fragment is acked.
  let resolved = false
  write.then(() => { resolved = true })
  await sleep(5)
  assert.equal(resolved, false, 'write pending before acks')
  // Cumulative ack covering all three settles the write.
  session.handleFrame(PeerFrameType.SACK, 1, emptyBitmap(), 3)
  await write
  await sleep(5)
  assert.equal(resolved, true)
  assert.equal(session.inflightTotal(), 0)
  assert.equal(session.queuedTotal(), 0)
})

test('every emitted ARQ payload seals into a ≤1200B frame and reopens intact', () => {
  const { session, sent } = makeSession()
  session.write(9, Buffer.alloc(2501, 0xcd))
  const { A, B, ciphersA, ciphersB } = freshPeerSession()
  sent.forEach((frame, i) => {
    const sealed = packEncryptedFrame(
      {
        frameType: frame.frameType,
        srcNodeId: A.nodeId,
        dstNodeId: B.nodeId,
        streamId: frame.streamId,
        seq: BigInt(i),
        ack: frame.ack,
      },
      frame.payload,
      ciphersA,
    )
    assert.ok(sealed.length <= PEER_MAX_FRAME_BYTES, `frame ${i} fits 1200B budget`)
    const opened = unpackEncryptedFrame(sealed, ciphersB)
    assert.ok(opened, `frame ${i} reopens`)
    assert.ok(Buffer.from(opened.plaintext).equals(frame.payload))
    assert.equal(opened.header.streamId, 9)
  })
})

test('send window caps unacked fragments and write backpressure resolves only when drained', async () => {
  const { session, sent, clock } = makeSession({ windowSize: 3, chunkSize: 100 })
  let maxInflight = 0
  const write = session.write(1, Buffer.alloc(1000, 0x11)) // 10 fragments
  assert.equal(sent.length, 3, 'only window-size fragments sent initially')
  assert.equal(session.queuedTotal(), 7)
  let resolved = false
  write.then(() => { resolved = true })
  maxInflight = Math.max(maxInflight, session.inflightTotal())
  // Walk the window: each cumulative ack frees exactly one slot.
  for (let ack = 1; ack <= 9; ack++) {
    session.handleFrame(PeerFrameType.SACK, 1, emptyBitmap(), ack)
    maxInflight = Math.max(maxInflight, session.inflightTotal())
    if (ack < 10) {
      await sleep(5)
      assert.equal(resolved, false, `write still pending at ack=${ack}`)
    }
  }
  assert.ok(maxInflight <= 3, `inflight never exceeded the window (max ${maxInflight})`)
  assert.equal(resolved, false, 'not resolved before the final ack')
  clock.advance(0) // no-op; keeps the harness honest about timer cleanliness
  session.handleFrame(PeerFrameType.SACK, 1, emptyBitmap(), 10)
  await write
  await sleep(5)
  assert.equal(resolved, true)
  assert.equal(session.inflightTotal(), 0)
  assert.equal(session.queuedTotal(), 0)
})

test('piggybacked ack: outgoing DATA frames carry the receiver-side cumulative progress', () => {
  const { session, sent } = makeSession()
  // Receive four fragments first so the rx side advances to expected=4.
  for (let seq = 0; seq < 4; seq++) {
    const payload = Buffer.alloc(STREAM_HEADER_BYTES + 10)
    payload[0] = 0
    payload.writeUInt32BE(seq, 1)
    session.handleFrame(PeerFrameType.DATA, 5, payload, 0)
  }
  const sackCount = sent.filter((f) => f.frameType === PeerFrameType.SACK).length
  assert.equal(sackCount, 4, 'one SACK per received DATA frame')
  assert.ok(sent.every((f) => f.ack <= 4))
  // Now send on the same bidirectional stream: every DATA piggybacks ack=4.
  sent.length = 0
  session.write(5, Buffer.alloc(100, 0x22))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].ack, 4, 'DATA carries the reverse-direction cumulative ack')
})

// -- 3. receive side: ordered reassembly + SACK bitmap ----------------------------

test('out-of-order fragments buffer, deliver in order, and report a selective bitmap', () => {
  const assembler = makeAssembler()
  const { session, sent } = makeSession({ onStreamData: assembler.onStreamData })
  const frameFor = (seq, byte) => {
    const payload = Buffer.alloc(STREAM_HEADER_BYTES + 3, byte)
    payload.writeUInt32BE(seq, 1)
    return payload
  }
  session.handleFrame(PeerFrameType.DATA, 2, frameFor(0, 0xa0), 0)
  assert.equal(assembler.chunkCount(2), 1, 'seq 0 delivered immediately')
  assert.ok(sent.at(-1).frameType === PeerFrameType.SACK)
  assert.equal(sent.at(-1).ack, 1)
  assert.equal(sent.at(-1).payload[0], 0, 'no gaps yet')

  session.handleFrame(PeerFrameType.DATA, 2, frameFor(2, 0xa2), 0)
  assert.equal(assembler.chunkCount(2), 1, 'seq 2 buffered, not delivered')
  const sack = sent.at(-1)
  assert.equal(sack.ack, 1)
  assert.equal(sack.payload[0], 0b10, 'bitmap bit 1 (seq2 − cumAck1) set, LSB-first')
  assert.equal(sack.payload.length, 8)

  session.handleFrame(PeerFrameType.DATA, 2, frameFor(1, 0xa4), 0)
  assert.equal(assembler.chunkCount(2), 3, 'gap fill flushes 1 and 2')
  assert.deepEqual(assembler.bytesOf(2), Buffer.concat([frameFor(0, 0xa0).subarray(5), frameFor(1, 0xa4).subarray(5), frameFor(2, 0xa2).subarray(5)]))
  const finalSack = sent.at(-1)
  assert.equal(finalSack.ack, 3)
  assert.equal(finalSack.payload[0], 0)
})

test('duplicate and pre-window DATA frames re-ack without double delivery', () => {
  const assembler = makeAssembler()
  const { session, sent } = makeSession({ onStreamData: assembler.onStreamData })
  const frameFor = (seq, byte) => {
    const payload = Buffer.alloc(STREAM_HEADER_BYTES + 3, byte)
    payload.writeUInt32BE(seq, 1)
    return payload
  }
  session.handleFrame(PeerFrameType.DATA, 3, frameFor(0, 0xb0), 0)
  session.handleFrame(PeerFrameType.DATA, 3, frameFor(0, 0xb0), 0) // duplicate
  session.handleFrame(PeerFrameType.DATA, 3, frameFor(0, 0xb0), 0) // duplicate again
  assert.equal(assembler.chunkCount(3), 1, 'delivered exactly once')
  assert.equal(sent.filter((f) => f.frameType === PeerFrameType.SACK).length, 3, 're-acked each time')
})

// -- 4. sender side: cumulative + selective acks, RTO backoff ---------------------

test('cumulative ack settles covered fragments; selective bitmap spares sacked ones', async () => {
  const assembler = makeAssembler()
  const { session: sender, sent, clock } = makeSession({ chunkSize: 100 })
  const { session: receiver, sent: receiverSent } = makeSession({ onStreamData: assembler.onStreamData })
  const write = sender.write(1, Buffer.alloc(500, 0x33)) // 5 fragments: seq 0..4
  assert.equal(sent.length, 5)

  // Fragments 0 and 1 arrive; 2 and 3 are "lost"; 4 arrives out of order.
  for (const i of [0, 1, 4]) {
    receiver.handleFrame(PeerFrameType.DATA, 1, sent[i].payload, 0)
  }
  assert.equal(assembler.chunkCount(1), 2, 'only the contiguous prefix delivered')
  const selective = receiverSent.at(-1)
  assert.equal(selective.ack, 2)
  assert.equal(selective.payload[0], 0b100, 'bit 2 marks seq 4')
  sender.handleFrame(PeerFrameType.SACK, 1, selective.payload, selective.ack)
  assert.equal(sender.inflightTotal(), 2, 'seq 2 and 3 stay inflight; 0/1/4 settled')

  // RTO fires for the two genuinely missing fragments only — seq 4's timer was cleared.
  sent.length = 0
  clock.advance(120)
  assert.deepEqual(
    sent.filter((f) => f.frameType === PeerFrameType.DATA).map((f) => subheaderOf(f.payload).seq),
    [2, 3],
    'exactly the two missing fragments retransmit',
  )

  // Retransmitted 2 arrives; receiver flushes it, keeps 4 buffered, acks 3 + bit for 4.
  receiver.handleFrame(PeerFrameType.DATA, 1, sent[0].payload, 0)
  const ack3 = receiverSent.at(-1)
  assert.equal(ack3.ack, 3)
  assert.equal(ack3.payload[0], 0b10, 'bit 1 marks buffered seq 4')
  sender.handleFrame(PeerFrameType.SACK, 1, ack3.payload, ack3.ack)
  assert.equal(sender.inflightTotal(), 1, 'only seq 3 remains')

  // Retransmitted 3 completes the stream: receiver acks 5, sender drains.
  receiver.handleFrame(PeerFrameType.DATA, 1, sent[1].payload, 0)
  const ack5 = receiverSent.at(-1)
  assert.equal(ack5.ack, 5)
  sender.handleFrame(PeerFrameType.SACK, 1, ack5.payload, ack5.ack)
  assert.equal(sender.inflightTotal(), 0)
  await write
  clock.advance(10000)
  assert.equal(sent.length, 2, 'no stray retransmissions after completion')
  assert.equal(clock.pendingCount(), 0)
})

test('RTO retransmits with exponential backoff capped at rtoMaxMs (virtual clock)', () => {
  const { session, sent, clock } = makeSession({ chunkSize: 1000 })
  session.write(1, Buffer.alloc(2500, 0x44)) // 3 fragments
  const frag0Times = () => sent.filter((f) => subheaderOf(f.payload).seq === 0 && f.streamId === 1).map((f) => f.at)
  assert.deepEqual(frag0Times(), [0])
  clock.advance(120)
  assert.deepEqual(frag0Times(), [0, 120], 'first RTO at 120ms')
  clock.advance(240)
  assert.deepEqual(frag0Times(), [0, 120, 360], 'backoff ×2')
  clock.advance(480)
  assert.deepEqual(frag0Times(), [0, 120, 360, 840])
  clock.advance(960)
  assert.deepEqual(frag0Times(), [0, 120, 360, 840, 1800])
  clock.advance(1000)
  assert.deepEqual(frag0Times(), [0, 120, 360, 840, 1800, 2800], 'cap reached')
  clock.advance(1000)
  assert.deepEqual(frag0Times().at(-1), 3800, 'steady 1000ms cadence under the cap')
  // Custom knobs are honored: rto 50, cap 200.
  const custom = makeSession({ chunkSize: 1000, rtoMs: 50, rtoMaxMs: 200 })
  custom.session.write(1, Buffer.alloc(500, 0x55))
  const times = () => custom.sent.map((f) => f.at)
  custom.clock.advance(50)
  custom.clock.advance(100)
  custom.clock.advance(200)
  custom.clock.advance(200)
  assert.deepEqual(times(), [0, 50, 150, 350, 550])
  // Acked fragments stop retransmitting entirely.
  session.handleFrame(PeerFrameType.SACK, 1, emptyBitmap(), 3)
  const before = sent.length
  clock.advance(10000)
  assert.equal(sent.length, before, 'no timers left after full ack')
  assert.equal(clock.pendingCount(), 0)
})

test('sacked fragments are never retransmitted; their timers are cleared', () => {
  const { session, sent, clock } = makeSession({ chunkSize: 100 })
  session.write(1, Buffer.alloc(300, 0x66)) // fragments 0,1,2
  // Receiver got 0 and 2 (1 lost): cumulative ack=1, bitmap bit1.
  const bitmap = Buffer.alloc(8)
  bitmap[0] = 0b10
  session.handleFrame(PeerFrameType.SACK, 1, bitmap, 1)
  assert.equal(session.inflightTotal(), 1, 'only seq 1 remains inflight')
  sent.length = 0
  clock.advance(120)
  assert.equal(sent.length, 1, 'only the unsacked fragment retransmits')
  assert.equal(subheaderOf(sent[0].payload).seq, 1)
})

// -- 5. FIN half-close ------------------------------------------------------------

test('FIN as its own fragment after the queue drained; receiver sees final=true', async () => {
  const receiverAssembler = makeAssembler()
  const { session, sent } = makeSession()
  const { session: receiver } = makeSession({ onStreamData: receiverAssembler.onStreamData })
  const write = session.write(1, Buffer.alloc(2501, 0x77))
  const finish = session.finish(1)
  // The default window (64) already carried all 3 data fragments, so FIN
  // goes out as a dedicated zero-length fragment consuming seq 3.
  assert.equal(sent.length, 4)
  const fin = subheaderOf(sent[3].payload)
  assert.ok((fin.flags & STREAM_FLAG_FIN) !== 0, 'FIN flag set on the dedicated fragment')
  assert.equal(fin.seq, 3)
  assert.equal(fin.data.length, 0)
  for (const frame of sent) receiver.handleFrame(frame.frameType, frame.streamId, frame.payload, frame.ack)
  assert.equal(receiverAssembler.bytesOf(1).length, 2501)
  assert.equal(receiverAssembler.finalOf(1), true, 'receiver observed the half-close')
  session.handleFrame(PeerFrameType.SACK, 1, emptyBitmap(), 4)
  await Promise.all([write, finish])
  await assert.rejects(() => session.write(1, Buffer.alloc(10)), /finished/)
})

test('FIN merges onto the last queued fragment when writes overflow the window', async () => {
  const receiverAssembler = makeAssembler()
  const { session, sent } = makeSession({ windowSize: 2, chunkSize: 100 })
  const { session: receiver } = makeSession({ onStreamData: receiverAssembler.onStreamData })
  const write = session.write(1, Buffer.alloc(300, 0x11)) // frags 0,1 inflight; frag 2 queued
  const finish = session.finish(1)
  assert.equal(sent.length, 2, 'window full — frag 2 still queued')
  assert.equal(session.queuedTotal(), 1)
  assert.ok((subheaderOf(sent[0].payload).flags & STREAM_FLAG_FIN) === 0)
  assert.ok((subheaderOf(sent[1].payload).flags & STREAM_FLAG_FIN) === 0)
  // Freeing a slot pumps frag 2 with the FIN flag already merged in.
  session.handleFrame(PeerFrameType.SACK, 1, emptyBitmap(), 1)
  assert.equal(sent.length, 3)
  const last = subheaderOf(sent[2].payload)
  assert.equal(last.seq, 2)
  assert.ok((last.flags & STREAM_FLAG_FIN) !== 0, 'FIN merged onto the last queued fragment')
  assert.equal(last.data.length, 100, 'the merged FIN still carries its data chunk')
  for (const frame of sent) receiver.handleFrame(frame.frameType, frame.streamId, frame.payload, frame.ack)
  assert.equal(receiverAssembler.bytesOf(1).length, 300)
  assert.equal(receiverAssembler.finalOf(1), true, 'final=true delivered on the merged fragment')
  session.handleFrame(PeerFrameType.SACK, 1, emptyBitmap(), 3)
  await Promise.all([write, finish])
})

test('standalone FIN (empty stream) delivers a final empty chunk', async () => {
  const assembler = makeAssembler()
  const { session, sent } = makeSession({ onStreamData: assembler.onStreamData })
  const finish = session.finish(2)
  assert.equal(sent.length, 1)
  const fin = subheaderOf(sent[0].payload)
  assert.ok((fin.flags & STREAM_FLAG_FIN) !== 0)
  assert.equal(fin.data.length, 0)
  assert.equal(fin.seq, 0)
  // Receiver side sees the final marker with zero bytes.
  const receiverAssembler = makeAssembler()
  const { session: receiver } = makeSession({ onStreamData: receiverAssembler.onStreamData })
  receiver.handleFrame(PeerFrameType.DATA, 2, sent[0].payload, 0)
  assert.equal(receiverAssembler.finalOf(2), true)
  assert.equal(receiverAssembler.bytesOf(2).length, 0)
  session.handleFrame(PeerFrameType.SACK, 2, emptyBitmap(), 1)
  await finish
  // Idempotent second finish resolves instead of rejecting.
  await session.finish(2)
})

// -- 6. RST abort ------------------------------------------------------------------

test('reset() aborts the send side, rejects pending writes, and the receiver drops state', async () => {
  const assembler = makeAssembler()
  const { session, sent, clock } = makeSession()
  const receiverAssembler = makeAssembler()
  let receiverResetWith = null
  const { session: receiver } = makeSession({
    onStreamData: receiverAssembler.onStreamData,
    onStreamReset: (streamId) => { receiverResetWith = streamId },
  })
  const write = session.write(1, Buffer.alloc(100, 0x88))
  // Receiver holds an out-of-order fragment: seq 1 lands while expected is still 0.
  const gapPayload = Buffer.alloc(STREAM_HEADER_BYTES + 4, 0x98)
  gapPayload.writeUInt32BE(1, 1)
  receiver.handleFrame(PeerFrameType.DATA, 1, gapPayload, 0)
  assert.equal(receiverAssembler.chunkCount(1), 0, 'seq 1 buffered out of order')

  let rejected = false
  write.catch(() => { rejected = true })
  session.reset(1)
  await sleep(5)
  assert.equal(rejected, true, 'pending write rejected by reset')
  const rst = sent.at(-1)
  assert.equal(rst.frameType, PeerFrameType.RST)
  assert.equal(rst.streamId, 1)
  clock.advance(1000)
  assert.ok(sent.length > 2, 'RST retries until acknowledged')
  assert.equal(sent.filter(f => f.frameType === PeerFrameType.DATA).length, 1, 'DATA timers stop on reset')
  session.handleFrame(PeerFrameType.RST, 1, Buffer.from([2]), 0)
  assert.equal(clock.pendingCount(), 0)
  // Receiver tears down: reset callback fired, stale buffered fragment dropped.
  receiver.handleFrame(PeerFrameType.RST, 1, Buffer.alloc(0), 0)
  assert.equal(receiverResetWith, 1)
  assert.equal(receiverAssembler.chunkCount(1), 0, 'buffered fragment discarded by the reset')
  // A stream ID belongs to one epoch for the entire session, including legacy retries.
  receiver.handleFrame(PeerFrameType.DATA, 1, sent[0].payload, 0)
  assert.equal(receiverAssembler.chunkCount(1), 0, 'retired IDs never resurrect')
  session.closeAll(); receiver.closeAll()
})

// -- 7. closeAll -------------------------------------------------------------------

test('closeAll clears every timer and rejects pending writes', async () => {
  const assembler = makeAssembler()
  const { session, sent, clock } = makeSession({ onStreamData: assembler.onStreamData })
  const writeA = session.write(1, Buffer.alloc(3000, 0xaa)) // 3 fragments, all sent
  const writeB = session.write(2, Buffer.alloc(500, 0xbb))
  let rejected = 0
  writeA.catch(() => { rejected += 1 })
  writeB.catch(() => { rejected += 1 })
  session.closeAll()
  await assert.rejects(() => writeA, /closed/)
  await assert.rejects(() => writeB, /closed/)
  assert.equal(rejected, 2)
  assert.equal(clock.pendingCount(), 0, 'all retransmit timers cleared')
  const before = sent.length
  clock.advance(60000)
  assert.equal(sent.length, before, 'no retransmissions after close')
  // Frames arriving after close are ignored.
  const payload = Buffer.alloc(STREAM_HEADER_BYTES + 3, 0xcc)
  payload.writeUInt32BE(0, 1)
  session.handleFrame(PeerFrameType.DATA, 7, payload, 0)
  assert.equal(sent.length, before, 'no SACK emitted after close')
  assert.equal(assembler.chunkCount(7), 0, 'no delivery after close')
  await assert.rejects(() => session.write(3, Buffer.alloc(1)), /closed/)
})

// -- 8. frame hygiene ---------------------------------------------------------------

test('handleFrame ignores foreign frame types, streamId 0, and malformed subheaders', () => {
  const assembler = makeAssembler()
  const { session, sent } = makeSession({ onStreamData: assembler.onStreamData })
  session.handleFrame(PeerFrameType.HELLO, 1, Buffer.from('x'), 0)
  session.handleFrame(PeerFrameType.PING, 1, Buffer.from('x'), 0)
  session.handleFrame(PeerFrameType.PONG, 1, Buffer.from('x'), 0)
  session.handleFrame(PeerFrameType.DATA, 0, Buffer.alloc(10), 0) // keepalive slot
  session.handleFrame(PeerFrameType.DATA, 1, Buffer.alloc(3), 0) // shorter than the subheader
  session.handleFrame(PeerFrameType.SACK, 1, Buffer.alloc(3), 4) // short bitmap is tolerated
  assert.equal(sent.length, 0, 'nothing emitted for any of those')
  assert.equal(assembler.chunkCount(1), 0)
})

test('write validates streamId shape', () => {
  const { session } = makeSession()
  assert.throws(() => session.write(0, Buffer.alloc(4)), RangeError)
  assert.throws(() => session.write(1.5, Buffer.alloc(4)), RangeError)
  assert.throws(() => session.write(2 ** 32, Buffer.alloc(4)), RangeError)
  assert.throws(() => session.write(1, 'not bytes'), TypeError)
})

// -- 9. duplex transfer over a perfect link (real clock) ----------------------------

test('concurrent duplex streams transfer both directions intact over a perfect link', async () => {
  const assemblerB = makeAssembler() // what A receives from B
  const assemblerA = makeAssembler() // what B receives from A
  const sessionA = new PeerArqSession({ onStreamData: assemblerB.onStreamData, sendFrame: () => {} })
  const sessionB = new PeerArqSession({ onStreamData: assemblerA.onStreamData, sendFrame: () => {} })
  const link = wireSessions(sessionA, sessionB)
  link.impl = 'perfect'

  const size = 200 * 1024
  const bufA = randomBytes(size)
  const bufB = randomBytes(size)
  const hashA = createHash('sha256').update(bufA).digest('hex')
  const hashB = createHash('sha256').update(bufB).digest('hex')

  // The SAME streamId carries both directions (bidirectional logical stream).
  const results = await Promise.all([
    sessionA.write(1, bufA),
    sessionA.finish(1),
    sessionB.write(1, bufB),
    sessionB.finish(1),
    (async () => {
      for (;;) {
        if (assemblerB.finalOf(1) && assemblerA.finalOf(1)) return
        await sleep(20)
      }
    })(),
  ])
  void results
  assert.equal(assemblerB.bytesOf(1).length, size)
  assert.equal(createHash('sha256').update(assemblerB.bytesOf(1)).digest('hex'), hashB, 'A received B’s bytes intact')
  assert.equal(assemblerA.bytesOf(1).length, size)
  assert.equal(createHash('sha256').update(assemblerA.bytesOf(1)).digest('hex'), hashA, 'B received A’s bytes intact')
  sessionA.closeAll()
  sessionB.closeAll()
})

// -- 10. the 10 MiB lossy hot-swap acceptance run ------------------------------------

test('10 MiB across two concurrent streams survives 20% loss + reorder and a mid-flight path swap', { skip: false }, async () => {
  const assembler = makeAssembler() // receiver collects both streams
  const sessionA = new PeerArqSession({ sendFrame: () => {} })
  const sessionB = new PeerArqSession({ onStreamData: assembler.onStreamData, sendFrame: () => {} })
  const rng = mulberry32(20261110)
  // Swap the physical path after ~8000 forwarded frames — comfortably
  // mid-transfer (~40% of the ~19k data+ack frames), with fragments that
  // are still unacked at swap time retransmitting over the new path.
  const link = wireSessions(sessionA, sessionB, rng)
  link.swapAfter = 8000

  const SIZE = 5 * 1024 * 1024
  const buf1 = randomBytes(SIZE)
  const buf2 = randomBytes(SIZE)
  const hash1 = createHash('sha256').update(buf1).digest('hex')
  const hash2 = createHash('sha256').update(buf2).digest('hex')

  const finalBoth = (async () => {
    for (;;) {
      if (assembler.finalOf(1) && assembler.finalOf(2)) return
      await sleep(50)
    }
  })()
  async function sendLarge(id, bytes) {
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      const part = bytes.subarray(offset, offset + 16384)
      while (!sessionA.tryWrite(id, part)) await sessionA.waitWritable(id, part.length)
      assert.ok(sessionA.bufferedSendBytes() <= 4 * 1024 * 1024)
    }
    await sessionA.finish(id)
  }
  await Promise.all([sendLarge(1, buf1), sendLarge(2, buf2), finalBoth])

  assert.ok(link.dropped > 0, `loss actually injected (dropped ${link.dropped})`)
  assert.ok(link.forwarded > 8000, `transfer crossed the swap point (${link.forwarded} forwards)`)
  assert.equal(link.swapped, true, 'physical path swapped mid-flight')
  assert.equal(assembler.bytesOf(1).length, SIZE)
  assert.equal(assembler.bytesOf(2).length, SIZE)
  assert.equal(createHash('sha256').update(assembler.bytesOf(1)).digest('hex'), hash1, 'stream 1 SHA-256 identical — zero bytes lost')
  assert.equal(createHash('sha256').update(assembler.bytesOf(2)).digest('hex'), hash2, 'stream 2 SHA-256 identical — zero bytes lost')
  sessionA.closeAll()
  sessionB.closeAll()
})

// -- 11. unready path resilience, flushInflight, queue coalescing & ack=0 SACK ------

test('survives throwing sendFrame while path is none, flushes immediately on flushInflight, coalesces queued small writes, and honors SACK bitmap at ack=0', async () => {
  const assembler = makeAssembler()
  let pathReady = false
  const wire = []
  let sessionB
  const sessionA = new PeerArqSession({
    windowSize: 2,
    chunkSize: 200,
    rtoMs: 500, // deliberately large so flushInflight() proves instant delivery (<80ms)
    sendFrame: (frameType, streamId, payload, ack) => {
      if (!pathReady) throw new Error('no physical path for peer')
      const copy = Buffer.from(payload)
      wire.push({ frameType, streamId, payload: copy, ack })
      queueMicrotask(() => sessionB.handleFrame(frameType, streamId, copy, ack))
    },
  })
  sessionB = new PeerArqSession({
    windowSize: 2,
    chunkSize: 200,
    onStreamData: assembler.onStreamData,
    sendFrame: (frameType, streamId, payload, ack) => {
      if (!pathReady) throw new Error('no physical path for peer')
      const copy = Buffer.from(payload)
      queueMicrotask(() => sessionA.handleFrame(frameType, streamId, copy, ack))
    },
  })

  try {
    // Enqueue 6 small writes while pathReady === false (sendFrame throws!):
    // First 2 enter inflight (seq 0, seq 1); next 4 queue behind windowSize=2 and coalesce!
    const writes = [
      sessionA.write(1, Buffer.from('token-0\n')),
      sessionA.write(1, Buffer.from('token-1\n')),
      sessionA.write(1, Buffer.from('token-2\n')),
      sessionA.write(1, Buffer.from('token-3\n')),
      sessionA.write(1, Buffer.from('token-4\n')),
      sessionA.write(1, Buffer.from('token-5\n')),
      sessionA.finish(1),
    ]

    // Bring path up and call flushInflight(): must deliver well before the 500ms RTO!
    const t0 = Date.now()
    pathReady = true
    sessionA.flushInflight()
    await Promise.all(writes)
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 200, `flushInflight delivered in ${elapsed}ms without waiting 500ms RTO`)
    assert.equal(
      assembler.bytesOf(1).toString('utf8'),
      'token-0\ntoken-1\ntoken-2\ntoken-3\ntoken-4\ntoken-5\n',
    )
    assert.equal(assembler.finalOf(1), true)
    // 2 inflight + 1 coalesced data fragment (tokens 2..5 = 32B <= 200B, with FIN merged by finish) = 3 DATA frames (instead of 7)
    const dataFrames = wire.filter((f) => f.frameType === PeerFrameType.DATA)
    assert.equal(dataFrames.length, 3, `expected 3 coalesced DATA frames, got ${dataFrames.length}`)

    // Verify SACK bitmap when ack === 0 (seq 0 dropped, seq 1 & 2 received):
    const sentSeqs = []
    const sackSender = new PeerArqSession({
      windowSize: 8,
      chunkSize: 50,
      rtoMs: 60,
      sendFrame: (frameType, _streamId, payload) => {
        if (frameType === PeerFrameType.DATA) sentSeqs.push(subheaderOf(payload).seq)
      },
    })
    const p0 = sackSender.write(9, Buffer.from('frag-0'))
    const p1 = sackSender.write(9, Buffer.from('frag-1'))
    const p2 = sackSender.write(9, Buffer.from('frag-2'))
    assert.deepEqual(sentSeqs, [0, 1, 2])
    // Peer lost seq=0 so cumulative ack=0; bitmap bit1 (seq 1) + bit2 (seq 2) = (1 << 1) | (1 << 2) = 0b110 = 6
    const bitmap = Buffer.alloc(16)
    bitmap[0] = (1 << 1) | (1 << 2)
    sackSender.handleFrame(PeerFrameType.SACK, 9, bitmap, 0)
    await Promise.all([p1, p2]) // p1 & p2 MUST settle immediately from the ack=0 SACK bitmap!
    await sleep(80) // Let RTO fire once: ONLY seq 0 should retransmit, NOT seq 1 or 2!
    assert.deepEqual(sentSeqs, [0, 1, 2, 0], 'only lost seq 0 retransmitted; seq 1 & 2 were selectively ACKed at ack=0')
    sackSender.handleFrame(PeerFrameType.SACK, 9, Buffer.alloc(16), 3)
    await p0
    sackSender.closeAll()
  } finally {
    sessionA.closeAll()
    sessionB.closeAll()
  }
})
