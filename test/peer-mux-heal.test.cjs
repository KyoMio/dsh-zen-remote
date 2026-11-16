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
    if (url.endsWith('.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform' }),
      }
    }
    return next(url, context)
  },
})

const { PeerMux } = require('../src/peer/mux.ts')
const { generatePeerIdentity, generateEphemeralX25519, buildPeerHandshakeEnvelope } = require('../src/peer/crypto.ts')
const { encodeFrameHeader, PeerFrameType, PEER_FRAME_MAGIC, PEER_FRAME_VERSION } = require('../src/peer/wire.ts')

const NETWORK_ID = '0123456789abcdef'

function makeFakeClock(initialMs = 1_000_000) {
  let nowMs = initialMs
  let nextId = 1
  const timers = new Map()
  return {
    now: () => nowMs,
    setTimeout(fn, ms) {
      const id = nextId++
      timers.set(id, { id, at: nowMs + ms, fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    advance(ms) {
      const target = nowMs + ms
      for (;;) {
        let earliest = null
        for (const t of timers.values()) {
          if (t.at <= target && (earliest === null || t.at < earliest.at)) earliest = t
        }
        if (earliest === null) break
        timers.delete(earliest.id)
        nowMs = earliest.at
        earliest.fn()
      }
      nowMs = target
    },
    pendingCount: () => timers.size,
  }
}

test('resetSession aborts pending streams immediately, clears ciphers, preserves monotonic streamId, and re-handshakes cleanly', { timeout: 2000 }, async t => {
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const pathEvents = []
  let A, B
  let dropBToA = false

  A = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    sendGatewayBinary: bytes => setImmediate(() => B.handleGatewayFrame(bytes)),
    relayHandler: () => undefined,
    relaySecret: () => 'test-secret',
    onPathChanged: (nodeId, path) => pathEvents.push({ nodeId, path }),
  })
  B = new PeerMux({
    networkId: NETWORK_ID,
    identity: b,
    sendGatewayBinary: bytes => {
      if (dropBToA) return
      setImmediate(() => A.handleGatewayFrame(bytes))
    },
    relayHandler: () => async (req, res) => {
      if (req.url === '/hang') {
        // Never finishes on server side; client stream should reject immediately on resetSession.
        return
      }
      res.end('ok-after-reset')
    },
    relaySecret: () => 'test-secret',
  })
  t.after(() => { A.close(); B.close() })

  A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
  A.enableRelayPath(b.nodeId)

  // Warm up stream 1/2 so streamId advances before reset.
  const firstRes = await A.createFetchForPeer(b.nodeId)('http://peer/warm')
  assert.equal(await firstRes.text(), 'ok-after-reset')
  await new Promise(resolve => setTimeout(resolve, 20))
  const prevStreamId = A.sessions.get(b.nodeId).nextStreamId

  // Open an in-flight hanging stream.
  const pendingFetch = A.createFetchForPeer(b.nodeId)('http://peer/hang')
  pendingFetch.catch(() => {})
  // Wait a tick so the request is serialized into session.streams.
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(A.sessions.get(b.nodeId).streams.size >= 1)

  const startedAt = Date.now()
  A.resetSession(b.nodeId)
  await assert.rejects(pendingFetch, /peer session reset/)
  assert.ok(Date.now() - startedAt < 500, 'pending stream must reject immediately without waiting 45s')

  const resetSession = A.sessions.get(b.nodeId)
  assert.ok(resetSession, 'session must be recreated cleanly')
  assert.equal(resetSession.ciphers, null)
  assert.equal(resetSession.path, 'none')
  assert.ok(resetSession.nextStreamId >= prevStreamId, 'streamId must remain monotonic across reset')
  assert.ok(pathEvents.some(e => e.nodeId === b.nodeId && e.path === 'none'))

  // Reset B as well so both sides cleanly establish new ephemeral keys, then verify request succeeds.
  B.resetSession(a.nodeId)
  A.enableRelayPath(b.nodeId)
  const secondRes = await A.createFetchForPeer(b.nodeId)('http://peer/after')
  assert.equal(await secondRes.text(), 'ok-after-reset')
  assert.ok(A.sessions.get(b.nodeId).nextStreamId > prevStreamId)
})

test('gateway handshake envelope accepts +120s clock skew (within +/-5min) and rejects +360s skew', () => {
  const clock = makeFakeClock(1_700_000_000_000)
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const mux = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    sendGatewayBinary() {},
    relayHandler: () => undefined,
    relaySecret: () => 'test-secret',
    clock,
  })
  try {
    mux.ensureSession(b.nodeId, b.publicKeyHex, 'B')
    mux.enableRelayPath(b.nodeId)
    const state = mux.sessions.get(b.nodeId)
    const eph = generateEphemeralX25519()

    const makeAck = (skewMs) => {
      const payload = buildPeerHandshakeEnvelope({
        kind: 'ack',
        networkId: NETWORK_ID,
        identity: b,
        selfEphPubHex: eph.publicKeyHex,
        peerNodeId: a.nodeId,
        peerEphPubHex: state.myEph.publicKeyHex,
        nonce: state.nonce,
        timestamp: clock.now() + skewMs,
      })
      const header = encodeFrameHeader({
        magic: PEER_FRAME_MAGIC,
        version: PEER_FRAME_VERSION,
        frameType: PeerFrameType.HELLO,
        srcNodeId: b.nodeId,
        dstNodeId: a.nodeId,
        streamId: 0,
        seq: 0n,
        ack: 0,
      })
      return Buffer.concat([header, payload])
    }

    // +360_000ms (6 min) must be rejected.
    mux.handleGatewayFrame(makeAck(360_000))
    assert.equal(state.ciphers, null)
    assert.equal(state.path, 'none')

    // +120_000ms (2 min) must be accepted within +/-5min window.
    mux.handleGatewayFrame(makeAck(120_000))
    assert.notEqual(state.ciphers, null)
    assert.equal(state.path, 'ws')
  } finally {
    mux.close()
  }
})

test('dispatchFrame self-heals beginHello after initial 2.4s retry exhaustion with 2s cooldown', { timeout: 2000 }, async t => {
  const clock = makeFakeClock(1_000_000)
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  let signalingUp = false
  let A, B

  A = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    clock,
    sendGatewayBinary: bytes => {
      if (!signalingUp) return
      B.handleGatewayFrame(bytes)
    },
    relayHandler: () => undefined,
    relaySecret: () => 'test-secret',
  })
  B = new PeerMux({
    networkId: NETWORK_ID,
    identity: b,
    clock,
    sendGatewayBinary: bytes => {
      if (!signalingUp) return
      A.handleGatewayFrame(bytes)
    },
    relayHandler: () => async (_req, res) => { res.end('healed') },
    relaySecret: () => 'test-secret',
  })
  t.after(() => { A.close(); B.close() })

  A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  B.ensureSession(a.nodeId, a.publicKeyHex, 'A')

  // Exhaust all 6 retries (initial send + 6 retries = 7 * 400ms = 2800ms) while signaling is blackholed.
  A.enableRelayPath(b.nodeId)
  clock.advance(2_900)
  const session = A.sessions.get(b.nodeId)
  assert.equal(session.ciphers, null)
  assert.equal(session.helloTimer, null)
  assert.equal(session.nonce, null)

  // Restore signaling and issue a business request -> dispatchFrame should self-heal beginHello.
  signalingUp = true
  const fetchPromise = A.createFetchForPeer(b.nodeId)('http://peer/heal')
  fetchPromise.catch(() => {})
  // Wait microtasks for writeArq -> dispatchFrame -> synchronous loopback handshake.
  await new Promise(resolve => setImmediate(resolve))
  // Advance ARQ RTO so the buffered stream frame retransmits over the newly established ciphers.
  clock.advance(200)
  const res = await Promise.race([
    fetchPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('self-heal fetch timeout')), 300)),
  ])
  assert.equal(await res.text(), 'healed')
})
