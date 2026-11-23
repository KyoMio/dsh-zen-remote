'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { once } = require('node:events')
const { createHash } = require('node:crypto')

const { PeerArqSession } = require('../lib/peer/arq.js')
const { PeerMux } = require('../lib/peer/mux.js')
const { generatePeerIdentity, generateEphemeralX25519, buildPeerHandshakeEnvelope } = require('../lib/peer/crypto.js')
const { encodeFrameHeader, packEncryptedFrame, PeerFrameType, PEER_FRAME_MAGIC, PEER_FRAME_VERSION } = require('../lib/peer/wire.js')
const { createRelayHandler } = require('../lib/relay-server.js')
const { createShareStore } = require('../lib/share-store.js')

const NETWORK_ID = '0123456789abcdef'
const immediate = () => new Promise((resolve) => setImmediate(resolve))

function pair(t, handler) {
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const options = { networkId: NETWORK_ID, sendGatewayBinary: null, relaySecret: () => 'test-secret' }
  const A = new PeerMux({ ...options, identity: a, relayHandler: () => undefined })
  const B = new PeerMux({ ...options, identity: b, relayHandler: () => handler })
  A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
  for (const [from, to, identity, target] of [[A, B, a, b], [B, A, b, a]]) {
    from.setDirectPath(target.nodeId, (frameType, streamId, payload, ack) => {
      setImmediate(() => to.handleOpenedFrame({ srcNodeId: identity.nodeId, frameType, streamId, ack }, payload))
    })
  }
  t.after(() => { A.close(); B.close() })
  return { A, B, fetch: A.createFetchForPeer(b.nodeId), sa: A.sessions.get(b.nodeId), sb: B.sessions.get(a.nodeId) }
}

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

async function responseWithin(promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('peer response did not settle')), 500)
    })])
  } finally {
    clearTimeout(timer)
  }
}

// -- 1. backpressure & HTTP response streaming (from peer-backpressure) ---------

for (const method of ['follow', 'control']) {
  test(`peer ${method}: large opening frame does not block later events`, { timeout: 5000 }, async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'zr-backpressure-'))
    t.after(() => rmSync(home, { recursive: true, force: true }))
    const store = createShareStore({ file: join(home, 'shares.json'), idleHours: 48 })
    store.share('session-test')
    const padding = 'x'.repeat(200000)
    const frames = method === 'follow' ? [
      { type: 'snapshot', header: { id: 'session-test' }, records: [], padding },
      { type: 'assistant-stream', frame: { revision: 1, text: 'thinking' } },
      { type: 'event', event: { type: 'tool/result', seq: 1 } },
      { type: 'assistant-stream', frame: { revision: 2, text: 'reply' } },
    ] : [
      { type: 'baseline', value: { projections: { 'session-test': { asOfSeq: 0, values: { padding } } } } },
      { type: 'projection', sessionId: 'session-test', changes: [{ key: 'modelSelection', value: { model: 'changed' } }], seq: 1 },
    ]
    let released = false
    const handler = createRelayHandler({
      secret: 'test-secret', store, heartbeatMs: 10000,
      serverInfo: { serverId: '12345678', serverName: () => 'test', dshVersion: 'test', fingerprints: () => ({}) },
      gateway: { stream: async ({ signal }) => (async function* () {
        try {
          for (const frame of frames) yield frame
          await new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true })))
        } finally {
          released = true
        }
      })() },
    })
    t.after(() => handler.closeAll())
    const { fetch } = pair(t, handler)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    t.after(() => { clearTimeout(timer); controller.abort() })
    const res = await fetch('http://peer/_dsh/zen-remote/relay/v1/stream', {
      method: 'POST', signal: controller.signal,
      body: JSON.stringify({ namespace: 'session', method, args: method === 'follow' ? { request: { address: { kind: 'session', sessionId: 'session-test' } } } : {} }),
    })
    assert.equal(res.status, 200)
    const reader = res.body.getReader()
    const received = []
    let buffer = ''
    try {
      while (received.length < frames.length) {
        const { value, done } = await reader.read()
        assert.equal(done, false)
        buffer += Buffer.from(value).toString()
        let nl
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = JSON.parse(buffer.slice(0, nl))
          buffer = buffer.slice(nl + 1)
          if (line.type === 'frame') received.push(line.frame)
        }
      }
      assert.deepEqual(received, frames)
    } finally {
      controller.abort()
    }
    await immediate()
    await immediate()
    assert.equal(released, true, 'cancellation releases the upstream subscription')
  })
}

for (const status of [204, 205, 304]) {
  test(`peer response: ${status} resolves with a null body`, { timeout: 3000 }, async (t) => {
    const { fetch } = pair(t, async (_req, res) => { res.writeHead(status); res.end() })
    const response = await responseWithin(fetch('http://peer/no-content', { signal: AbortSignal.timeout(1000) }))
    assert.equal(response.status, status)
    assert.equal(response.body, null)
    assert.equal(await response.text(), '')
  })
}

test('peer response: invalid response metadata rejects instead of stranding fetch', { timeout: 3000 }, async (t) => {
  const { fetch } = pair(t, async (_req, res) => {
    res.socket.write('HTTP/1.1 200 OK\r\nbad\u0001name: value\r\n\r\n')
  })
  await assert.rejects(responseWithin(fetch('http://peer/invalid-header', { signal: AbortSignal.timeout(1000) })), /header/i)
})

test('peer response: repeated large writes drain and complete a content-length body', { timeout: 5000 }, async (t) => {
  const chunk = Buffer.alloc(200000, 'x')
  let response
  let drains = 0
  const { fetch } = pair(t, async (_req, res) => {
    response = res
    res.on('drain', () => drains++)
    res.setHeader('content-length', chunk.length * 3)
    for (let i = 0; i < 3; i++) {
      if (!res.write(chunk)) await once(res, 'drain')
    }
    res.end()
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  t.after(() => { clearTimeout(timer); controller.abort() })
  const res = await fetch('http://peer/large-response', { signal: controller.signal })
  assert.equal((await res.arrayBuffer()).byteLength, chunk.length * 3)
  assert.equal(drains, 3)
  response.socket.emit('drain')
  assert.equal(drains, 3, 'ended response must not receive drain')
  response.destroy()
  response.socket?.emit('drain')
  assert.equal(drains, 3, 'destroyed response must not receive drain')
})

// -- 2. flow control, handshake & 8MiB streams (from peer-flow-control) --------

test('signed gateway ACK with low-order DH key cannot throw or replace cipher state', (t) => {
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const mux = new PeerMux({ identity: a, networkId: NETWORK_ID, sendGatewayBinary() {}, relayHandler: () => undefined, relaySecret: () => 'test' })
  t.after(() => mux.close())
  mux.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  mux.enableRelayPath(b.nodeId)
  const nonce = mux.sessions.get(b.nodeId).nonce
  const timestamp = Date.now()
  const ephPubHex = '00'.repeat(32)
  const payload = buildPeerHandshakeEnvelope({
    kind: 'ack',
    networkId: NETWORK_ID,
    identity: b,
    selfEphPubHex: ephPubHex,
    peerNodeId: a.nodeId,
    peerEphPubHex: mux.sessions.get(b.nodeId).myEph.publicKeyHex,
    nonce,
    timestamp,
  })
  const header = encodeFrameHeader({ magic: PEER_FRAME_MAGIC, version: PEER_FRAME_VERSION, frameType: PeerFrameType.HELLO, srcNodeId: b.nodeId, dstNodeId: a.nodeId, streamId: 0, seq: 0n, ack: 0 })
  const previous = { existing: true }
  mux.sessions.get(b.nodeId).ciphers = previous
  assert.doesNotThrow(() => mux.handleGatewayFrame(Buffer.concat([header, payload])))
  assert.equal(mux.sessions.get(b.nodeId).ciphers, previous)
  assert.equal(mux.sessions.get(b.nodeId).peerEphPubHex, null)
})

test('gateway key rotation requires a fresh ACK and cannot roll back via recorded HELLO or consumed ACK', () => {
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const mux = new PeerMux({ identity: a, networkId: NETWORK_ID, sendGatewayBinary() {}, relayHandler: () => undefined, relaySecret: () => 'test' })
  try {
    mux.ensureSession(b.nodeId, b.publicKeyHex, 'B')
    const state = mux.sessions.get(b.nodeId)
    function control(kind, ephPubHex, nonce) {
      const timestamp = Date.now()
      const payload = buildPeerHandshakeEnvelope({
        kind,
        networkId: NETWORK_ID,
        identity: b,
        selfEphPubHex: ephPubHex,
        peerNodeId: a.nodeId,
        peerEphPubHex: kind === 'hello' ? null : state.myEph.publicKeyHex,
        nonce,
        timestamp,
      })
      const header = encodeFrameHeader({ magic: PEER_FRAME_MAGIC, version: PEER_FRAME_VERSION, frameType: PeerFrameType.HELLO, srcNodeId: b.nodeId, dstNodeId: a.nodeId, streamId: 0, seq: 0n, ack: 0 })
      return Buffer.concat([header, payload])
    }
    const k1 = generateEphemeralX25519().publicKeyHex
    const k2 = generateEphemeralX25519().publicKeyHex
    mux.enableRelayPath(b.nodeId)
    const n1 = state.nonce
    const ack1 = control('ack', k1, n1)
    mux.handleGatewayFrame(ack1)
    assert.equal(state.peerEphPubHex, k1)
    mux.handleGatewayFrame(control('hello', k2, 'abcdef0123456789'))
    assert.equal(state.peerEphPubHex, k1, 'HELLO cannot commit a new key')
    const n2 = state.nonce
    assert.notEqual(n2, n1)
    mux.handleGatewayFrame(control('ack', k2, n2))
    const established = state.ciphers
    mux.handleGatewayFrame(control('hello', k1, 'abcdef0123456789'))
    mux.handleGatewayFrame(ack1)
    mux.handleGatewayFrame(control('ack', k1, n2))
    assert.equal(state.peerEphPubHex, k2)
    assert.equal(state.ciphers, established)
  } finally {
    mux.close()
  }
})

for (const simultaneous of [false, true]) {
  test(`gateway fresh handshake converges ${simultaneous ? 'simultaneously' : 'from one initiator'}`, { timeout: 3000 }, async (t) => {
    const a = generatePeerIdentity()
    const b = generatePeerIdentity()
    const common = { networkId: NETWORK_ID, relaySecret: () => 'test' }
    let A, B
    A = new PeerMux({ ...common, identity: a, sendGatewayBinary: (bytes) => setImmediate(() => B.handleGatewayFrame(bytes)), relayHandler: () => undefined })
    B = new PeerMux({ ...common, identity: b, sendGatewayBinary: (bytes) => setImmediate(() => A.handleGatewayFrame(bytes)), relayHandler: () => async (_req, res) => { res.end('via relay') } })
    t.after(() => { A.close(); B.close() })
    A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
    B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
    A.enableRelayPath(b.nodeId)
    if (simultaneous) B.enableRelayPath(a.nodeId)
    assert.equal(await (await A.createFetchForPeer(b.nodeId)('http://peer/ws')).text(), 'via relay')
    assert.equal(A.sessions.get(b.nodeId).nonce, null)
    assert.equal(B.sessions.get(a.nodeId).nonce, null)
  })
}

test('1000 completed HTTP exchanges release mux streams and abort listeners', { timeout: 10000 }, async (t) => {
  const p = pair(t, async (_req, res) => { res.end('ok') })
  const controller = new AbortController()
  let listeners = 0
  const add = controller.signal.addEventListener.bind(controller.signal)
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = (...args) => { listeners++; return add(...args) }
  controller.signal.removeEventListener = (...args) => { listeners--; return remove(...args) }
  for (let i = 0; i < 1000; i++) assert.equal(await (await p.fetch('http://peer/small', { signal: controller.signal })).text(), 'ok')
  for (let i = 0; i < 5; i++) await immediate()
  assert.equal(listeners, 0)
  assert.equal(p.sa.streams.size, 0)
  assert.equal(p.sb.streams.size, 0)
  assert.equal(p.sa.arq.active.size, 0)
  assert.equal(p.sb.arq.active.size, 0)
})

test('send admission is bounded per stream and peer, without one RTT per small write', async (t) => {
  const arq = new PeerArqSession({ sendFrame() {}, maxStreamBytes: 1024, maxSessionBytes: 2048 })
  t.after(() => arq.closeAll())
  assert.equal(typeof arq.tryWrite, 'function')
  for (let i = 0; i < 8; i++) assert.equal(arq.tryWrite(1, Buffer.alloc(100)), true)
  assert.equal(arq.tryWrite(1, Buffer.alloc(300)), false)
  assert.equal(arq.tryWrite(2, Buffer.alloc(800)), true)
  assert.equal(arq.tryWrite(3, Buffer.alloc(800)), false)
  await assert.rejects(arq.write(4, Buffer.alloc(8 * 1024 * 1024)), /capacity|budget/)
})

for (const contentLength of [true, false]) {
  test(`8MiB ${contentLength ? 'content-length' : 'single chunked chunk'} streams with slow consumer and concurrent small response`, { timeout: 15000 }, async (t) => {
    const body = Buffer.alloc(8 * 1024 * 1024, 0x6d)
    let largeFinished = false
    const p = pair(t, async (req, res) => {
      if (req.url === '/small') { res.end('small'); return }
      if (contentLength) res.setHeader('content-length', body.length)
      res.end(body, () => { largeFinished = true })
    })
    const response = await p.fetch('http://peer/large')
    for (let i = 0; i < 100; i++) await immediate()
    assert.equal(largeFinished, false, 'unread consumer propagates backpressure to producer')
    assert.ok(p.sb.arq.bufferedSendBytes() <= 1024 * 1024)
    assert.ok(p.sa.arq.bufferedReceiveBytes() <= 8 * 1024 * 1024)
    assert.equal(await (await p.fetch('http://peer/small')).text(), 'small')
    const digest = createHash('sha256')
    let bytes = 0
    for await (const chunk of response.body) {
      digest.update(chunk)
      bytes += chunk.length
      if (bytes % 65536 < 1100) await immediate()
    }
    assert.equal(bytes, body.length)
    assert.equal(digest.digest('hex'), createHash('sha256').update(body).digest('hex'))
    for (let i = 0; i < 10; i++) await immediate()
    assert.equal(p.sa.streams.size, 0)
    assert.equal(p.sb.streams.size, 0)
  })
}

test('8MiB upload keeps request readable bounded and cancellation releases producer', { timeout: 15000 }, async (t) => {
  const body = Buffer.alloc(8 * 1024 * 1024, 0x5a)
  let request, release
  const gate = new Promise((resolve) => { release = resolve })
  const p = pair(t, async (req, res) => {
    request = req
    await gate
    let size = 0
    const digest = createHash('sha256')
    for await (const chunk of req) { size += chunk.length; digest.update(chunk) }
    res.end(JSON.stringify({ size, hash: digest.digest('hex') }))
  })
  const pending = p.fetch('http://peer/upload', { method: 'POST', body })
  for (let i = 0; i < 100; i++) await immediate()
  assert.ok(request.readableLength <= 65536 + 1100)
  release()
  const result = await (await pending).json()
  assert.equal(result.size, body.length)
  assert.equal(result.hash, createHash('sha256').update(body).digest('hex'))
})

for (const timing of ['immediate', 'read-pending', 'read-completed']) {
  test(`upload ${timing} abort cancels source and releases reader lock`, async (t) => {
    const p = pair(t, async () => {})
    const controller = new AbortController()
    let cancellations = 0
    let sourceController
    const body = new ReadableStream({ start(c) { sourceController = c }, pull() {}, cancel() { cancellations++ } })
    const pending = p.fetch('http://peer/upload', { method: 'POST', body, signal: controller.signal })
    if (timing !== 'immediate') await immediate()
    if (timing === 'read-completed') sourceController.enqueue(new Uint8Array([1]))
    controller.abort()
    await assert.rejects(pending, /abort/)
    await immediate()
    assert.equal(cancellations, 1)
    assert.equal(body.locked, false)
    assert.equal(p.sa.streams.size, 0)
  })
}

test('consumer cancellation bypasses stalled DATA and releases abort listener', { timeout: 5000 }, async (t) => {
  let responseClosed = false
  const p = pair(t, async (_req, res) => {
    res.on('close', () => { responseClosed = true })
    for (let i = 0; i < 1024 && !res.destroyed; i++) if (!res.write(Buffer.alloc(16384))) await once(res, 'drain').catch(() => {})
  })
  const controller = new AbortController()
  let added = 0
  let removed = 0
  const add = controller.signal.addEventListener.bind(controller.signal)
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = (...args) => { added++; return add(...args) }
  controller.signal.removeEventListener = (...args) => { removed++; return remove(...args) }
  const response = await p.fetch('http://peer/live', { signal: controller.signal })
  for (let i = 0; i < 100; i++) await immediate()
  await response.body.cancel()
  for (let i = 0; i < 10; i++) await immediate()
  assert.equal(responseClosed, true)
  assert.equal(added, removed)
  assert.equal(p.sa.streams.size, 0)
  assert.equal(p.sb.streams.size, 0)
})

// -- 3. resetSession, clock skew & cooldown self-heal (from peer-mux-heal) -----

test('resetSession aborts pending streams immediately, clears ciphers, preserves monotonic streamId, and re-handshakes cleanly', { timeout: 2000 }, async (t) => {
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const pathEvents = []
  let A, B
  const dropBToA = false

  A = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    sendGatewayBinary: (bytes) => setImmediate(() => B.handleGatewayFrame(bytes)),
    relayHandler: () => undefined,
    relaySecret: () => 'test-secret',
    onPathChanged: (nodeId, path) => pathEvents.push({ nodeId, path }),
  })
  B = new PeerMux({
    networkId: NETWORK_ID,
    identity: b,
    sendGatewayBinary: (bytes) => {
      if (dropBToA) return
      setImmediate(() => A.handleGatewayFrame(bytes))
    },
    relayHandler: () => async (req, res) => {
      if (req.url === '/hang') return
      res.end('ok-after-reset')
    },
    relaySecret: () => 'test-secret',
  })
  t.after(() => { A.close(); B.close() })

  A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
  A.enableRelayPath(b.nodeId)

  const firstRes = await A.createFetchForPeer(b.nodeId)('http://peer/warm')
  assert.equal(await firstRes.text(), 'ok-after-reset')
  await immediate()
  const prevStreamId = A.sessions.get(b.nodeId).nextStreamId

  const pendingFetch = A.createFetchForPeer(b.nodeId)('http://peer/hang')
  pendingFetch.catch(() => {})
  await immediate()
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
  assert.ok(pathEvents.some((e) => e.nodeId === b.nodeId && e.path === 'none'))

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

    mux.handleGatewayFrame(makeAck(360_000))
    assert.equal(state.ciphers, null)
    assert.equal(state.path, 'none')

    mux.handleGatewayFrame(makeAck(120_000))
    assert.notEqual(state.ciphers, null)
    assert.equal(state.path, 'ws')
  } finally {
    mux.close()
  }
})

test('dispatchFrame self-heals beginHello after initial 2.4s retry exhaustion with 2s cooldown', { timeout: 2000 }, async (t) => {
  const clock = makeFakeClock(1_000_000)
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  let signalingUp = false
  let A, B

  A = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    clock,
    sendGatewayBinary: (bytes) => {
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
    sendGatewayBinary: (bytes) => {
      if (!signalingUp) return
      A.handleGatewayFrame(bytes)
    },
    relayHandler: () => async (_req, res) => { res.end('healed') },
    relaySecret: () => 'test-secret',
  })
  t.after(() => { A.close(); B.close() })

  A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  B.ensureSession(a.nodeId, a.publicKeyHex, 'A')

  A.enableRelayPath(b.nodeId)
  clock.advance(2_900)
  const session = A.sessions.get(b.nodeId)
  assert.equal(session.ciphers, null)
  assert.equal(session.helloTimer, null)
  assert.equal(session.nonce, null)

  signalingUp = true
  const fetchPromise = A.createFetchForPeer(b.nodeId)('http://peer/heal')
  fetchPromise.catch(() => {})
  await immediate()
  clock.advance(200)
  let timer
  try {
    const res = await Promise.race([
      fetchPromise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('self-heal fetch timeout')), 300) }),
    ])
    assert.equal(await res.text(), 'healed')
  } finally {
    clearTimeout(timer)
  }
})

// -- 4. T1 symmetric WS demotion, flushInflight, enableRelayPath & early response RST --

test('T1: PeerMux in udp auto-demotes to ws on newer encrypted WS frame, ignores stale pre-promote seq, and responds over ws', { timeout: 3000 }, async (t) => {
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const aDemoted = []
  const aPathChanges = []
  const aWsSent = []
  const aUdpSent = []
  const bUdpQueue = []
  let dropUdpFromAToB = false

  let A, B
  A = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    sendGatewayBinary: (bytes) => {
      aWsSent.push(Buffer.from(bytes))
      setImmediate(() => B.handleGatewayFrame(bytes))
    },
    relayHandler: () => async (_req, res) => { res.end('ok-via-ws') },
    relaySecret: () => 'test-secret',
    onPathChanged: (nodeId, path) => aPathChanges.push({ nodeId, path }),
    onPeerRelayDemoted: (nodeId) => aDemoted.push(nodeId),
  })
  B = new PeerMux({
    networkId: NETWORK_ID,
    identity: b,
    sendGatewayBinary: (bytes) => {
      setImmediate(() => A.handleGatewayFrame(bytes))
    },
    relayHandler: () => async (_req, res) => { res.end('from-b') },
    relaySecret: () => 'test-secret',
  })
  t.after(() => { A.close(); B.close() })

  A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
  A.enableRelayPath(b.nodeId)
  B.enableRelayPath(a.nodeId)

  // Warm WS exchange so both have ciphers and seq >= 1n
  assert.equal(await (await A.createFetchForPeer(b.nodeId)('http://peer/warm')).text(), 'from-b')
  await immediate()

  // Capture a stale encrypted WS frame from B before direct promotion
  const sa = A.sessions.get(b.nodeId)
  const sb = B.sessions.get(a.nodeId)
  const staleFrame = packEncryptedFrame({
    frameType: PeerFrameType.PING,
    srcNodeId: b.nodeId,
    dstNodeId: a.nodeId,
    streamId: 0,
    seq: sa.lastInboundWsSeq,
    ack: 0,
  }, Buffer.alloc(0), sb.ciphers)

  // Promote both to UDP
  A.setDirectPath(b.nodeId, (frameType, streamId, payload, ack) => {
    aUdpSent.push({ frameType, streamId })
    if (!dropUdpFromAToB) {
      setImmediate(() => B.handleOpenedFrame({ srcNodeId: a.nodeId, frameType, streamId, ack }, payload))
    }
  })
  B.setDirectPath(a.nodeId, (frameType, streamId, payload, ack) => {
    bUdpQueue.push({ frameType, streamId, payload, ack })
    setImmediate(() => A.handleOpenedFrame({ srcNodeId: b.nodeId, frameType, streamId, ack }, payload))
  })
  assert.equal(A.sessionPath(b.nodeId), 'udp')

  // Stale WS frame (seq <= wsSeqAtDirectPromote) must NOT demote A
  A.handleGatewayFrame(staleFrame)
  assert.equal(A.sessionPath(b.nodeId), 'udp')
  assert.deepEqual(aDemoted, [])

  // Exchange one warm UDP request so both sides have confirmed peer direct readiness
  assert.equal(await (await B.createFetchForPeer(a.nodeId)('http://peer/confirm-udp')).text(), 'ok-via-ws')
  await immediate()

  // Now B demotes to WS while A's UDP is dead; B sends request over WS (seq > wsSeqAtDirectPromote)
  dropUdpFromAToB = true
  const udpCountBefore = aUdpSent.length
  const wsCountBefore = aWsSent.length
  B.setRelayPath(a.nodeId)

  const res = await responseWithin(B.createFetchForPeer(a.nodeId)('http://peer/hello-from-b'))
  assert.equal(await res.text(), 'ok-via-ws')
  assert.equal(A.sessionPath(b.nodeId), 'ws')
  assert.deepEqual(aDemoted, [b.nodeId])
  assert.ok(aPathChanges.some((e) => e.nodeId === b.nodeId && e.path === 'ws'))
  assert.equal(aUdpSent.length, udpCountBefore, 'A must not send any frame back over dead UDP after symmetric demotion')
  assert.ok(aWsSent.length > wsCountBefore, 'A must reply over WS')
})

test('staggered direct promotion absorbs pre-promotion WS frames within grace window before peer confirms UDP', async (t) => {
  const clock = makeFakeClock(5_000_000)
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const aDemoted = []
  let dropUdpFromAToB = false

  let A, B
  A = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    clock,
    directPromoteGraceMs: 1_500,
    sendGatewayBinary: (bytes) => {
      setImmediate(() => B.handleGatewayFrame(bytes))
    },
    relayHandler: () => async (_req, res) => { res.end('ok-from-a') },
    relaySecret: () => 'test-secret',
    onPeerRelayDemoted: (nodeId) => aDemoted.push(nodeId),
  })
  B = new PeerMux({
    networkId: NETWORK_ID,
    identity: b,
    clock,
    directPromoteGraceMs: 1_500,
    sendGatewayBinary: (bytes) => {
      setImmediate(() => A.handleGatewayFrame(bytes))
    },
    relayHandler: () => async (_req, res) => { res.end('ok-from-b') },
    relaySecret: () => 'test-secret',
  })
  t.after(() => { A.close(); B.close() })

  A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
  A.enableRelayPath(b.nodeId)
  B.enableRelayPath(a.nodeId)
  assert.equal(await (await A.createFetchForPeer(b.nodeId)('http://peer/warm-ws')).text(), 'ok-from-b')

  // Staggered promotion: A promotes to UDP 30ms before B (still on WS)
  A.setDirectPath(b.nodeId, (frameType, streamId, payload, ack) => {
    if (!dropUdpFromAToB) {
      setImmediate(() => B.handleOpenedFrame({ srcNodeId: a.nodeId, frameType, streamId, ack }, payload))
    }
  })
  clock.advance(30)

  // B is still on WS during the 30ms RTT skew and sends a fresh WS request -> A must deliver it and stay on UDP
  assert.equal(B.sessionPath(a.nodeId), 'ws')
  const skewRes = await responseWithin(B.createFetchForPeer(a.nodeId)('http://peer/during-skew'))
  assert.equal(await skewRes.text(), 'ok-from-a')
  assert.equal(A.sessionPath(b.nodeId), 'udp', 'staggered WS frame within grace window must not demote A')
  assert.deepEqual(aDemoted, [])

  // Now B also promotes to UDP and sends an encrypted UDP request (peerConfirmedDirect = true)
  B.setDirectPath(a.nodeId, (frameType, streamId, payload, ack) => {
    setImmediate(() => A.handleOpenedFrame({ srcNodeId: b.nodeId, frameType, streamId, ack }, payload))
  })
  const directRes = await responseWithin(B.createFetchForPeer(a.nodeId)('http://peer/now-direct'))
  assert.equal(await directRes.text(), 'ok-from-a')
  assert.equal(A.sessionPath(b.nodeId), 'udp')

  // Later, even well within grace window, if B actually falls back to WS, A demotes immediately
  dropUdpFromAToB = true
  B.setRelayPath(a.nodeId)
  const fallbackRes = await responseWithin(B.createFetchForPeer(a.nodeId)('http://peer/post-direct-fallback'))
  assert.equal(await fallbackRes.text(), 'ok-from-a')
  assert.equal(A.sessionPath(b.nodeId), 'ws')
  assert.deepEqual(aDemoted, [b.nodeId])
})

test('T1: setRelayPath from udp to ws flushes inflight immediately, and enableRelayPath resets path to none when ciphers===null', () => {
  const clock = makeFakeClock(1_000_000)
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const wsSent = []
  const mux = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    clock,
    sendGatewayBinary: (bytes) => wsSent.push(Buffer.from(bytes)),
    relayHandler: () => undefined,
    relaySecret: () => 'test-secret',
  })
  try {
    mux.ensureSession(b.nodeId, b.publicKeyHex, 'B')
    const state = mux.sessions.get(b.nodeId)

    // 1. enableRelayPath with ciphers === null while in udp must first reset path to 'none'
    mux.setDirectPath(b.nodeId, () => {})
    assert.equal(mux.sessionPath(b.nodeId), 'udp')
    mux.enableRelayPath(b.nodeId)
    assert.equal(mux.sessionPath(b.nodeId), 'none')

    // 2. Complete WS handshake, promote back to udp, queue inflight via fetch, then setRelayPath
    const eph = generateEphemeralX25519()
    const ackPayload = buildPeerHandshakeEnvelope({
      kind: 'ack',
      networkId: NETWORK_ID,
      identity: b,
      selfEphPubHex: eph.publicKeyHex,
      peerNodeId: a.nodeId,
      peerEphPubHex: state.myEph.publicKeyHex,
      nonce: state.nonce,
      timestamp: clock.now(),
    })
    const ackHdr = encodeFrameHeader({
      magic: PEER_FRAME_MAGIC,
      version: PEER_FRAME_VERSION,
      frameType: PeerFrameType.HELLO,
      srcNodeId: b.nodeId,
      dstNodeId: a.nodeId,
      streamId: 0,
      seq: 0n,
      ack: 0,
    })
    mux.handleGatewayFrame(Buffer.concat([ackHdr, ackPayload]))
    assert.equal(mux.sessionPath(b.nodeId), 'ws')

    mux.setDirectPath(b.nodeId, () => {}) // blackholed UDP
    assert.equal(mux.sessionPath(b.nodeId), 'udp')
    const pending = mux.createFetchForPeer(b.nodeId)('http://peer/inflight')
    pending.catch(() => {})
    const wsBefore = wsSent.length
    assert.ok(state.arq.inflightTotal() > 0)

    mux.setRelayPath(b.nodeId)
    assert.equal(mux.sessionPath(b.nodeId), 'ws')
    assert.ok(wsSent.length > wsBefore, 'setRelayPath from udp->ws must immediately flush inflight over WS without waiting RTO')
  } finally {
    mux.close()
  }
})

test('T1: incoming hello envelope while in udp demotes to ws and invokes onPeerRelayDemoted', () => {
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const demoted = []
  const mux = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    sendGatewayBinary() {},
    relayHandler: () => undefined,
    relaySecret: () => 'test-secret',
    onPeerRelayDemoted: (nodeId) => demoted.push(nodeId),
  })
  try {
    mux.ensureSession(b.nodeId, b.publicKeyHex, 'B')
    mux.enableRelayPath(b.nodeId)
    const state = mux.sessions.get(b.nodeId)
    const k1 = generateEphemeralX25519().publicKeyHex
    const ackPayload = buildPeerHandshakeEnvelope({
      kind: 'ack',
      networkId: NETWORK_ID,
      identity: b,
      selfEphPubHex: k1,
      peerNodeId: a.nodeId,
      peerEphPubHex: state.myEph.publicKeyHex,
      nonce: state.nonce,
      timestamp: Date.now(),
    })
    const hdr = encodeFrameHeader({ magic: PEER_FRAME_MAGIC, version: PEER_FRAME_VERSION, frameType: PeerFrameType.HELLO, srcNodeId: b.nodeId, dstNodeId: a.nodeId, streamId: 0, seq: 0n, ack: 0 })
    mux.handleGatewayFrame(Buffer.concat([hdr, ackPayload]))
    mux.setDirectPath(b.nodeId, () => {})
    assert.equal(mux.sessionPath(b.nodeId), 'udp')

    const k2 = generateEphemeralX25519().publicKeyHex
    const helloPayload = buildPeerHandshakeEnvelope({
      kind: 'hello',
      networkId: NETWORK_ID,
      identity: b,
      selfEphPubHex: k2,
      peerNodeId: a.nodeId,
      peerEphPubHex: null,
      nonce: '1122334455667788',
      timestamp: Date.now(),
    })
    mux.handleGatewayFrame(Buffer.concat([hdr, helloPayload]))
    assert.equal(mux.sessionPath(b.nodeId), 'ws')
    assert.deepEqual(demoted, [b.nodeId])
  } finally {
    mux.close()
  }
})

for (const status of [503, 413]) {
  test(`T1: early ${status} inbound response before request EOF resets upload stream immediately`, { timeout: 2000 }, async (t) => {
    const handler = status === 503 ? undefined : async (_req, res) => {
      res.writeHead(413, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'payload-too-large' } }))
    }
    const p = pair(t, handler)
    let cancelled = false
    let pulls = 0
    const body = new ReadableStream({
      pull(controller) {
        pulls++
        if (pulls <= 40) controller.enqueue(Buffer.alloc(16 * 1024, 0x41))
        // stay open indefinitely unless cancelled
      },
      cancel() {
        cancelled = true
      },
    })
    const res = await responseWithin(p.fetch('http://peer/early-reject', { method: 'POST', body }))
    assert.equal(res.status, status)
    await res.text()
    const deadline = Date.now() + 500
    while ((!cancelled || p.sa.streams.size > 0 || p.sb.streams.size > 0) && Date.now() < deadline) {
      await immediate()
    }
    assert.equal(cancelled, true, 'initiator upload stream must be cancelled promptly without 30s timeout')
    assert.equal(p.sa.streams.size, 0)
    assert.equal(p.sb.streams.size, 0)
  })
}

// -- 5. T3 WS demote beacon, 2000ms reorder drain, safe HELLO, ARQ stall & handler wait --

test('T3: 2000ms reorder drain absorbs old WS frames after UDP confirm, >2000ms normal WS frame demotes for legacy peers', { timeout: 3000 }, async (t) => {
  const clock = makeFakeClock(1_000_000)
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const aDemoted = []
  let holdWsToA = false
  const heldWsToA = []

  let A, B
  A = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    clock,
    directPromoteGraceMs: 6_000,
    sendGatewayBinary: (bytes) => setImmediate(() => B.handleGatewayFrame(bytes)),
    relayHandler: () => async (_req, res) => { res.end('ok-a') },
    relaySecret: () => 'test-secret',
    onPeerRelayDemoted: (nodeId) => aDemoted.push(nodeId),
  })
  B = new PeerMux({
    networkId: NETWORK_ID,
    identity: b,
    clock,
    directPromoteGraceMs: 6_000,
    sendGatewayBinary: (bytes) => {
      const copy = Buffer.from(bytes)
      if (holdWsToA) {
        heldWsToA.push(copy)
        return
      }
      setImmediate(() => A.handleGatewayFrame(copy))
    },
    relayHandler: () => async (_req, res) => { res.end('ok-b') },
    relaySecret: () => 'test-secret',
  })
  t.after(() => { A.close(); B.close() })

  A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
  A.enableRelayPath(b.nodeId)
  B.enableRelayPath(a.nodeId)
  assert.equal(await (await A.createFetchForPeer(b.nodeId)('http://peer/warm')).text(), 'ok-b')
  await immediate()

  const sb = B.sessions.get(a.nodeId)
  // Capture a pre-promotion in-flight WS DATA frame from B (seq > A.wsSeqAtDirectPromote)
  holdWsToA = true
  const inFlightReq = B.createFetchForPeer(a.nodeId)('http://peer/inflight-pre-promote')
  inFlightReq.catch(() => {})
  assert.ok(heldWsToA.length >= 1)
  const prePromoteWsData = heldWsToA.shift()
  holdWsToA = false

  // A promotes to UDP at t = 0
  A.setDirectPath(b.nodeId, () => {})
  assert.equal(A.sessionPath(b.nodeId), 'udp')

  // t = 5ms: UDP frame arrives -> peerConfirmedDirect = true, firstDirectRxAt = t0 + 5
  clock.advance(5)
  A.handleOpenedFrame({ srcNodeId: b.nodeId, frameType: PeerFrameType.ACK, streamId: 0, ack: 0 }, Buffer.alloc(0))
  assert.equal(A.sessions.get(b.nodeId).peerConfirmedDirect, true)

  // t = 1000ms (995ms after firstDirectRxAt, within 2000ms reorder window): old WS DATA frame arrives -> absorbed!
  clock.advance(995)
  A.handleGatewayFrame(prePromoteWsData)
  assert.equal(A.sessionPath(b.nodeId), 'udp', 'old WS frame within 2000ms of firstDirectRxAt must not demote')
  assert.deepEqual(aDemoted, [])

  // t = 2100ms (2095ms after firstDirectRxAt, still inside 6s graceMs): normal WS DATA frame arrives -> demotes for legacy compatibility
  clock.advance(1100)
  const lateWsData = packEncryptedFrame({
    frameType: PeerFrameType.ACK,
    srcNodeId: b.nodeId,
    dstNodeId: a.nodeId,
    streamId: 1,
    seq: sb.seq,
    ack: 0,
  }, Buffer.alloc(0), sb.ciphers)
  sb.seq += 1n
  A.handleGatewayFrame(lateWsData)
  assert.equal(A.sessionPath(b.nodeId), 'ws', 'normal WS frame after 2000ms reorder window must demote even within 6s grace')
  assert.deepEqual(aDemoted, [b.nodeId])
})

test('T3: setRelayPath(id, true) emits PING(streamId=0) beacon when inflight===0 and penetrates 500ms/6s grace in 0ms; false suppresses beacon', { timeout: 3000 }, async (t) => {
  const clock = makeFakeClock(2_000_000)
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const aDemoted = []
  const bWsFrames = []
  let forwardBToA = true

  let A, B
  A = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    clock,
    directPromoteGraceMs: 6_000,
    sendGatewayBinary: (bytes) => B.handleGatewayFrame(bytes),
    relayHandler: () => async (_req, res) => { res.end('ok') },
    relaySecret: () => 'test-secret',
    onPeerRelayDemoted: (nodeId) => aDemoted.push(nodeId),
  })
  B = new PeerMux({
    networkId: NETWORK_ID,
    identity: b,
    clock,
    directPromoteGraceMs: 6_000,
    sendGatewayBinary: (bytes) => {
      const copy = Buffer.from(bytes)
      bWsFrames.push(copy)
      if (forwardBToA) A.handleGatewayFrame(copy)
    },
    relayHandler: () => async (_req, res) => { res.end('ok') },
    relaySecret: () => 'test-secret',
  })
  t.after(() => { A.close(); B.close() })

  A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
  A.enableRelayPath(b.nodeId)
  B.enableRelayPath(a.nodeId)
  assert.notEqual(A.sessions.get(b.nodeId).ciphers, null)
  assert.notEqual(B.sessions.get(a.nodeId).ciphers, null)

  A.setDirectPath(b.nodeId, () => {})
  B.setDirectPath(a.nodeId, () => {})
  assert.equal(B.sessions.get(a.nodeId).arq.inflightTotal(), 0)

  // A receives a UDP frame at t = 5ms, then at t = 15ms (inside 500ms & 6s windows) receives B's demote beacon
  clock.advance(5)
  A.handleOpenedFrame({ srcNodeId: b.nodeId, frameType: PeerFrameType.ACK, streamId: 0, ack: 0 }, Buffer.alloc(0))
  clock.advance(10)

  forwardBToA = false
  const wsBeforeBeacon = bWsFrames.length
  B.setRelayPath(a.nodeId, true)
  assert.equal(B.sessionPath(a.nodeId), 'ws')
  assert.equal(bWsFrames.length, wsBeforeBeacon + 1, 'setRelayPath(id, true) must send exactly 1 demote beacon when inflight===0')

  // Deliver the beacon to A -> 0ms penetration!
  A.handleGatewayFrame(bWsFrames[bWsFrames.length - 1])
  assert.equal(A.sessionPath(b.nodeId), 'ws', 'explicit PING(streamId=0) beacon must demote A in 0ms inside reorder & grace windows')
  assert.deepEqual(aDemoted, [b.nodeId])

  // Re-promote B and demote with sendDemoteBeacon = false -> no beacon sent
  B.setDirectPath(a.nodeId, () => {})
  const wsBeforeSilent = bWsFrames.length
  B.setRelayPath(a.nodeId, false)
  assert.equal(B.sessionPath(a.nodeId), 'ws')
  assert.equal(bWsFrames.length, wsBeforeSilent, 'setRelayPath(id, false) must not emit demote beacon')
})

test('T3: cold-start late HELLO and same-key replay keep udp within grace; re-keying resets seq so new seq=0n WS frame demotes', { timeout: 3000 }, async (t) => {
  const clock = makeFakeClock(3_000_000)
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const aDemoted = []
  const aWsSent = []

  const A = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    clock,
    directPromoteGraceMs: 6_000,
    sendGatewayBinary: (bytes) => aWsSent.push(Buffer.from(bytes)),
    relayHandler: () => undefined,
    relaySecret: () => 'test-secret',
    onPeerRelayDemoted: (nodeId) => aDemoted.push(nodeId),
  })
  t.after(() => A.close())

  A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  const sa = A.sessions.get(b.nodeId)

  function makeControl(kind, ephPubHex, nonce, peerEphPubHex = null) {
    const payload = buildPeerHandshakeEnvelope({
      kind,
      networkId: NETWORK_ID,
      identity: b,
      selfEphPubHex: ephPubHex,
      peerNodeId: a.nodeId,
      peerEphPubHex,
      nonce,
      timestamp: clock.now(),
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

  // 1. A promotes to UDP before WS ciphers exist and before any UDP frame arrives
  A.setDirectPath(b.nodeId, () => {})
  assert.equal(A.sessionPath(b.nodeId), 'udp')
  assert.equal(sa.ciphers, null)
  assert.equal(sa.peerConfirmedDirect, false)

  // 2. Cold-start late HELLO arrives at t = 50ms -> keeps UDP, replies ACK, starts background key exchange
  clock.advance(50)
  const k1 = generateEphemeralX25519()
  A.handleGatewayFrame(makeControl('hello', k1.publicKeyHex, '1111111111111111'))
  assert.equal(A.sessionPath(b.nodeId), 'udp')
  assert.deepEqual(aDemoted, [])
  assert.ok(aWsSent.length >= 1)
  assert.notEqual(sa.nonce, null)

  // Complete background key exchange via ACK(k1) while staying in UDP
  A.handleGatewayFrame(makeControl('ack', k1.publicKeyHex, sa.nonce, sa.myEph.publicKeyHex))
  assert.notEqual(sa.ciphers, null)
  assert.equal(A.sessionPath(b.nodeId), 'udp')

  // 3. Same-key HELLO replay within grace window -> keeps UDP
  clock.advance(50)
  A.handleGatewayFrame(makeControl('hello', k1.publicKeyHex, '2222222222222222'))
  assert.equal(A.sessionPath(b.nodeId), 'udp')
  assert.deepEqual(aDemoted, [])

  // Simulate prior WS seq = 5n received on k1
  const { derivePeerSessionCiphers } = require('../lib/peer/crypto.js')
  const bCiphers1 = derivePeerSessionCiphers({
    networkId: NETWORK_ID,
    myNodeId: b.nodeId,
    peerNodeId: a.nodeId,
    myEphPrivateKeyHex: k1.privateKeyHex,
    myEphPublicKeyHex: k1.publicKeyHex,
    peerEphPublicKeyHex: sa.myEph.publicKeyHex,
  })
  const wsAtSeq5 = packEncryptedFrame({
    frameType: PeerFrameType.ACK,
    srcNodeId: b.nodeId,
    dstNodeId: a.nodeId,
    streamId: 1,
    seq: 5n,
    ack: 0,
  }, Buffer.alloc(0), bCiphers1)
  // Advance past 6s grace so frame5 updates lastInboundWsSeq to 5n (and demotes to ws)
  clock.advance(6_500)
  A.handleGatewayFrame(wsAtSeq5)
  assert.equal(A.sessionPath(b.nodeId), 'ws')
  assert.equal(sa.lastInboundWsSeq, 5n)
  aDemoted.length = 0

  // 4. Re-key with k2: peer restarts and sends HELLO(k2), then ACK(k2). Sequence counters must reset to -1n!
  const k2 = generateEphemeralX25519()
  A.handleGatewayFrame(makeControl('hello', k2.publicKeyHex, '3333333333333333'))
  A.handleGatewayFrame(makeControl('ack', k2.publicKeyHex, sa.nonce, sa.myEph.publicKeyHex))
  assert.equal(sa.peerEphPubHex, k2.publicKeyHex)
  assert.equal(sa.lastInboundWsSeq, -1n)
  assert.equal(sa.wsSeqAtDirectPromote, -1n)

  // Re-promote A to UDP, then peer demotes with a fresh session frame at seq = 0n
  A.setDirectPath(b.nodeId, () => {})
  assert.equal(sa.wsSeqAtDirectPromote, -1n)
  const bCiphers2 = derivePeerSessionCiphers({
    networkId: NETWORK_ID,
    myNodeId: b.nodeId,
    peerNodeId: a.nodeId,
    myEphPrivateKeyHex: k2.privateKeyHex,
    myEphPublicKeyHex: k2.publicKeyHex,
    peerEphPublicKeyHex: sa.myEph.publicKeyHex,
  })
  const freshSeq0Demote = packEncryptedFrame({
    frameType: PeerFrameType.PING,
    srcNodeId: b.nodeId,
    dstNodeId: a.nodeId,
    streamId: 0,
    seq: 0n,
    ack: 0,
  }, Buffer.alloc(0), bCiphers2)
  A.handleGatewayFrame(freshSeq0Demote)
  assert.equal(A.sessionPath(b.nodeId), 'ws', 'seq=0n after re-key must trigger demote instead of being dropped by old seq=5n')
  assert.deepEqual(aDemoted, [b.nodeId])
})

test('T3: ARQ stall reports onDirectStalled with stallSuspectMs promote guard and 10s cooldown', { timeout: 3000 }, async (t) => {
  const clock = makeFakeClock(4_000_000)
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const stalled = []

  const A = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    clock,
    stallSuspectMs: 1_000,
    onDirectStalled: (nodeId) => stalled.push({ nodeId, at: clock.now() }),
    sendGatewayBinary: () => {},
    relayHandler: () => undefined,
    relaySecret: () => 'test-secret',
  })
  t.after(() => A.close())
  A.ensureSession(b.nodeId, b.publicKeyHex, 'B')

  // 1. Start stream before promoting to UDP so inflightSince predates directPromotedAt;
  //    at first RTO after stallSuspectMs, (now - directPromotedAt) < 1_000 -> must NOT report!
  A.enableRelayPath(b.nodeId)
  const sa = A.sessions.get(b.nodeId)
  const k1 = generateEphemeralX25519()
  const ackPayload = buildPeerHandshakeEnvelope({
    kind: 'ack',
    networkId: NETWORK_ID,
    identity: b,
    selfEphPubHex: k1.publicKeyHex,
    peerNodeId: a.nodeId,
    peerEphPubHex: sa.myEph.publicKeyHex,
    nonce: sa.nonce,
    timestamp: clock.now(),
  })
  const hdr = encodeFrameHeader({ magic: PEER_FRAME_MAGIC, version: PEER_FRAME_VERSION, frameType: PeerFrameType.HELLO, srcNodeId: b.nodeId, dstNodeId: a.nodeId, streamId: 0, seq: 0n, ack: 0 })
  A.handleGatewayFrame(Buffer.concat([hdr, ackPayload]))

  const f1 = A.createFetchForPeer(b.nodeId)('http://peer/pre-promote')
  f1.catch(() => {})
  clock.advance(900)
  A.setDirectPath(b.nodeId, () => {}) // directPromotedAt = t0 + 900
  clock.advance(400) // t0 + 1300: inflightSince(0) >= 1000, but now - directPromotedAt = 400 < 1000
  assert.equal(stalled.length, 0, 'must not report stall before stallSuspectMs has elapsed since direct promotion')

  // 2. Fresh direct promotion & stall past stallSuspectMs -> triggers once
  A.setDirectPath(b.nodeId, () => {})
  const f2 = A.createFetchForPeer(b.nodeId)('http://peer/stall-1')
  f2.catch(() => {})
  clock.advance(2_000)
  assert.equal(stalled.length, 1)
  assert.equal(stalled[0].nodeId, b.nodeId)

  // 3. Within 10s cooldown: a second stream stalling must be suppressed
  clock.advance(2_000)
  const f3 = A.createFetchForPeer(b.nodeId)('http://peer/stall-2')
  f3.catch(() => {})
  clock.advance(2_000)
  assert.equal(stalled.length, 1, 'second stall within 10s cooldown must be suppressed')

  // 4. After 10s cooldown expires: another stalled stream reports again
  clock.advance(9_000)
  const f4 = A.createFetchForPeer(b.nodeId)('http://peer/stall-3')
  f4.catch(() => {})
  clock.advance(2_000)
  assert.equal(stalled.length, 2, 'stall after 10s cooldown must report again')
})

test('T3: relayHandlerWaitMs waits for late-mounted relayHandler without 503, default 0 returns 503 immediately, and close cleans timers', { timeout: 3000 }, async (t) => {
  // Part A: relayHandlerWaitMs = 3_000 waits for handler mounted at +150ms
  {
    const clock = makeFakeClock(5_000_000)
    const a = generatePeerIdentity()
    const b = generatePeerIdentity()
    let mountedHandler
    let A, B
    A = new PeerMux({
      networkId: NETWORK_ID,
      identity: a,
      clock,
      sendGatewayBinary: null,
      relayHandler: () => undefined,
      relaySecret: () => 'test-secret',
    })
    B = new PeerMux({
      networkId: NETWORK_ID,
      identity: b,
      clock,
      relayHandlerWaitMs: 3_000,
      sendGatewayBinary: null,
      relayHandler: () => mountedHandler,
      relaySecret: () => 'test-secret',
    })
    t.after(() => { A.close(); B.close() })
    A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
    B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
    A.setDirectPath(b.nodeId, (ft, sid, payload, ack) => setImmediate(() => B.handleOpenedFrame({ srcNodeId: a.nodeId, frameType: ft, streamId: sid, ack }, payload)))
    B.setDirectPath(a.nodeId, (ft, sid, payload, ack) => setImmediate(() => A.handleOpenedFrame({ srcNodeId: b.nodeId, frameType: ft, streamId: sid, ack }, payload)))

    const pending = A.createFetchForPeer(b.nodeId)('http://peer/cold')
    await immediate()
    await immediate()
    clock.advance(100) // still waiting (not 503)
    mountedHandler = async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('warmed-up')
    }
    clock.advance(50)
    const res = await responseWithin(pending)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'warmed-up')
    await immediate()
    assert.equal(clock.pendingCount(), 0)
  }

  // Part B: timeout past relayHandlerWaitMs returns 503; default 0 returns 503 immediately
  for (const waitMs of [0, 200]) {
    const clock = makeFakeClock(6_000_000)
    const a = generatePeerIdentity()
    const b = generatePeerIdentity()
    let A, B
    A = new PeerMux({
      networkId: NETWORK_ID,
      identity: a,
      clock,
      sendGatewayBinary: null,
      relayHandler: () => undefined,
      relaySecret: () => 'test-secret',
    })
    B = new PeerMux({
      networkId: NETWORK_ID,
      identity: b,
      clock,
      ...(waitMs > 0 ? { relayHandlerWaitMs: waitMs } : {}),
      sendGatewayBinary: null,
      relayHandler: () => undefined,
      relaySecret: () => 'test-secret',
    })
    t.after(() => { A.close(); B.close() })
    A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
    B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
    A.setDirectPath(b.nodeId, (ft, sid, payload, ack) => setImmediate(() => B.handleOpenedFrame({ srcNodeId: a.nodeId, frameType: ft, streamId: sid, ack }, payload)))
    B.setDirectPath(a.nodeId, (ft, sid, payload, ack) => setImmediate(() => A.handleOpenedFrame({ srcNodeId: b.nodeId, frameType: ft, streamId: sid, ack }, payload)))

    const pending = A.createFetchForPeer(b.nodeId)('http://peer/unavailable')
    await immediate()
    await immediate()
    if (waitMs > 0) clock.advance(waitMs)
    const res = await responseWithin(pending)
    assert.equal(res.status, 503)
    const json = await res.json()
    assert.equal(json.error?.code, 'relay-unavailable')
    await immediate()
    assert.equal(clock.pendingCount(), 0)
  }

  // Part C: closing / aborting while waiting cleans up all poll timers (zero leaks)
  {
    const clock = makeFakeClock(7_000_000)
    const a = generatePeerIdentity()
    const b = generatePeerIdentity()
    let A, B
    A = new PeerMux({
      networkId: NETWORK_ID,
      identity: a,
      clock,
      sendGatewayBinary: null,
      relayHandler: () => undefined,
      relaySecret: () => 'test-secret',
    })
    B = new PeerMux({
      networkId: NETWORK_ID,
      identity: b,
      clock,
      relayHandlerWaitMs: 3_000,
      sendGatewayBinary: null,
      relayHandler: () => undefined,
      relaySecret: () => 'test-secret',
    })
    t.after(() => { A.close(); B.close() })
    A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
    B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
    A.setDirectPath(b.nodeId, (ft, sid, payload, ack) => setImmediate(() => B.handleOpenedFrame({ srcNodeId: a.nodeId, frameType: ft, streamId: sid, ack }, payload)))
    B.setDirectPath(a.nodeId, (ft, sid, payload, ack) => setImmediate(() => A.handleOpenedFrame({ srcNodeId: b.nodeId, frameType: ft, streamId: sid, ack }, payload)))

    const pending = A.createFetchForPeer(b.nodeId)('http://peer/aborted-wait')
    pending.catch(() => {})
    await immediate()
    await immediate()
    assert.ok(clock.pendingCount() > 0, 'handler wait timer must be armed while waiting')
    B.close()
    A.close()
    assert.equal(clock.pendingCount(), 0, 'closing mux while waiting must clear all handler wait timers')
  }
})

test('Task 3: PeerMux inbound req Readable._read() admits chunk during pull so backpressured >64 KiB body drains without stalling', { timeout: 3000 }, async (t) => {
  const clock = makeFakeClock(8_000_000)
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  // 96 KiB: fits within ARQ window/rx.buffered. With fake clock (no RTO firing),
  // A sends all DATA frames while B's req hits >= 64 KiB highWaterMark and holds
  // the rest in rx.buffered. Without reqPulling, B's req.read(32 KiB) calls
  // _read() before subtracting 32 KiB, sees readableLength >= 64 KiB, refuses
  // the chunk, and deadlocks state.reading=true with zero future DATA frames.
  const payload = Buffer.alloc(96 * 1024, 0x61)

  let reqRef
  let settledBodyResolve
  const bodyPromise = new Promise((resolve) => { settledBodyResolve = resolve })

  let A, B
  A = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    clock,
    sendGatewayBinary: null,
    relayHandler: () => undefined,
    relaySecret: () => 'test-secret',
  })
  B = new PeerMux({
    networkId: NETWORK_ID,
    identity: b,
    clock,
    sendGatewayBinary: null,
    relayHandler: () => async (req, res) => {
      reqRef = req
      const chunks = await bodyPromise
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(String(Buffer.concat(chunks).byteLength))
    },
    relaySecret: () => 'test-secret',
  })
  t.after(() => { A.close(); B.close() })

  A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
  A.setDirectPath(b.nodeId, (ft, sid, p, ack) => setImmediate(() => B.handleOpenedFrame({ srcNodeId: a.nodeId, frameType: ft, streamId: sid, ack }, p)))
  B.setDirectPath(a.nodeId, (ft, sid, p, ack) => setImmediate(() => A.handleOpenedFrame({ srcNodeId: b.nodeId, frameType: ft, streamId: sid, ack }, p)))

  const pendingRes = A.createFetchForPeer(b.nodeId)('http://peer/upload-backpressure', {
    method: 'POST',
    body: payload,
  })
  pendingRes.catch(() => {})

  const sessionB = B.sessions.get(a.nodeId)
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const rx = sessionB.arq.rxStreams.values().next().value
    if (reqRef && reqRef.readableLength >= 64 * 1024 && rx && rx.buffered.size >= 1) {
      break
    }
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.ok(reqRef && reqRef.readableLength >= 64 * 1024, 'expected req to buffer >= 64 KiB before consumer reads')

  // Partial read of 32 KiB: Node Readable calls _read() BEFORE subtracting 32 KiB from state.length!
  const chunks = []
  let ended = false
  const first = reqRef.read(32 * 1024)
  assert.ok(first !== null && first.byteLength === 32 * 1024)
  chunks.push(first)

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`inbound req stalled with readableLength=${reqRef.readableLength}, ended=${ended}`)), 400)
    reqRef.on('readable', () => {
      let c
      while ((c = reqRef.read(32 * 1024)) !== null) {
        chunks.push(c)
      }
    })
    reqRef.on('end', () => {
      ended = true
      clearTimeout(timer)
      resolve()
    })
    reqRef.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    let c
    while ((c = reqRef.read(32 * 1024)) !== null) {
      chunks.push(c)
    }
  })

  settledBodyResolve(chunks)
  const res = await responseWithin(pendingRes)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), String(payload.byteLength))
})

test('Slice 1: PeerMux enables sackCoalesceFrames=6 on ARQ and forwards AIMD fields in setPeerTransportProfile', async (t) => {
  const clock = makeFakeClock(9_000_000)
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const aToBSent = []
  const bToASent = []

  const A = new PeerMux({
    networkId: NETWORK_ID,
    identity: a,
    clock,
    sendGatewayBinary: null,
    relayHandler: () => undefined,
    relaySecret: () => 'test-secret',
  })
  const B = new PeerMux({
    networkId: NETWORK_ID,
    identity: b,
    clock,
    sendGatewayBinary: null,
    relayHandler: () => async (req, res) => {
      for await (const _ of req) { /* drain */ }
      res.end('ok')
    },
    relaySecret: () => 'test-secret',
  })
  t.after(() => { A.close(); B.close() })

  A.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
  A.setDirectPath(b.nodeId, (ft, sid, p, ack) => {
    aToBSent.push({ ft, sid })
    setImmediate(() => B.handleOpenedFrame({ srcNodeId: a.nodeId, frameType: ft, streamId: sid, ack }, p))
  })
  B.setDirectPath(a.nodeId, (ft, sid, p, ack) => {
    bToASent.push({ ft, sid })
    setImmediate(() => A.handleOpenedFrame({ srcNodeId: b.nodeId, frameType: ft, streamId: sid, ack }, p))
  })

  // setPeerTransportProfile forwards initialWindowSize=32 & minWindowSize=16 (AIMD)
  A.setPeerTransportProfile(b.nodeId, { windowSize: 160, initialWindowSize: 32, minWindowSize: 16, rtoMs: 120 })
  const sessionA = A.sessions.get(b.nodeId)
  // Send 60 chunks without forwarding to B so inflight count reflects initialWindowSize=32
  const holdB = A.createFetchForPeer(b.nodeId)('http://peer/hold-aimd', {
    method: 'POST',
    body: Buffer.alloc(60 * 1100, 0x11),
  })
  holdB.catch(() => {})
  await immediate()
  assert.equal(sessionA.arq.inflightTotal(), 32, 'setPeerTransportProfile forwards initialWindowSize=32 to ARQ')

  // Verify B coalesces in-order SACKs when 4 consecutive in-order DATA frames arrive on a new stream
  const sessionB = B.sessions.get(a.nodeId)
  bToASent.length = 0
  const reqHead = Buffer.from(JSON.stringify({ t: 'req', m: 'POST', p: '/coalesce', h: {} }))
  const frame0 = Buffer.alloc(5 + 4 + reqHead.length)
  frame0.writeUInt32BE(0, 1)
  frame0.writeUInt32BE(reqHead.length, 5)
  reqHead.copy(frame0, 9)
  sessionB.arq.handleFrame(PeerFrameType.DATA, 99, frame0, 0)
  for (let seq = 1; seq <= 3; seq++) {
    const f = Buffer.alloc(5 + 10, 0x22)
    f.writeUInt32BE(seq, 1)
    sessionB.arq.handleFrame(PeerFrameType.DATA, 99, f, 0)
  }
  assert.equal(
    bToASent.filter((f) => f.ft === PeerFrameType.SACK && f.sid === 99).length,
    0,
    'PeerMux ARQ coalesces first 4 in-order frames without immediate SACK',
  )
  clock.advance(2)
  assert.equal(
    bToASent.filter((f) => f.ft === PeerFrameType.SACK && f.sid === 99).length,
    1,
    'PeerMux ARQ flushes coalesced SACK after 2ms',
  )
})

test('Slice 4: PeerMux.setPeerTuning live updates sackCoalesceFrames and wsReorderGraceMs', async (t) => {
  const clock = makeFakeClock()
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  const bToASent = []
  let demoted = 0
  const B = new PeerMux({
    networkId: NETWORK_ID,
    identity: b,
    clock,
    sendGatewayBinary: null,
    relayHandler: () => async (req, res) => {
      for await (const _ of req) { /* drain */ }
      res.end('ok')
    },
    relaySecret: () => 'test-secret',
    directPromoteGraceMs: 5000,
    onPeerRelayDemoted: () => { demoted += 1 },
  })
  t.after(() => B.close())

  B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
  B.setDirectPath(a.nodeId, (ft, sid) => {
    bToASent.push({ ft, sid })
  })
  const sessionB = B.sessions.get(a.nodeId)
  B.setPeerTuning({ sackCoalesceFrames: 1, wsReorderGraceMs: 500, stallSuspectMs: 1500 })

  const reqHead = Buffer.from(JSON.stringify({ t: 'req', m: 'POST', p: '/immediate-sack', h: {} }))
  const frame0 = Buffer.alloc(5 + 4 + reqHead.length)
  frame0.writeUInt32BE(0, 1)
  frame0.writeUInt32BE(reqHead.length, 5)
  reqHead.copy(frame0, 9)
  sessionB.arq.handleFrame(PeerFrameType.DATA, 1, frame0, 0)
  assert.equal(
    bToASent.filter((f) => f.ft === PeerFrameType.SACK && f.sid === 1).length,
    1,
    'setPeerTuning(sackCoalesceFrames=1) emits SACK immediately without waiting 2ms',
  )

  const ephA = generateEphemeralX25519()
  const ephB = generateEphemeralX25519()
  const { derivePeerSessionCiphers } = require('../lib/peer/crypto.js')
  const aCiphers = derivePeerSessionCiphers({
    networkId: NETWORK_ID,
    myNodeId: a.nodeId,
    peerNodeId: b.nodeId,
    myEphPrivateKeyHex: ephA.privateKeyHex,
    myEphPublicKeyHex: ephA.publicKeyHex,
    peerEphPublicKeyHex: ephB.publicKeyHex,
  })
  const bCiphers = derivePeerSessionCiphers({
    networkId: NETWORK_ID,
    myNodeId: b.nodeId,
    peerNodeId: a.nodeId,
    myEphPrivateKeyHex: ephB.privateKeyHex,
    myEphPublicKeyHex: ephB.publicKeyHex,
    peerEphPublicKeyHex: ephA.publicKeyHex,
  })
  sessionB.ciphers = bCiphers
  B.handleOpenedFrame({ srcNodeId: a.nodeId, frameType: PeerFrameType.ACK, streamId: 0, ack: 0 }, Buffer.alloc(0))
  clock.advance(700)
  const sealedWs = packEncryptedFrame({
    frameType: PeerFrameType.ACK,
    srcNodeId: a.nodeId,
    dstNodeId: b.nodeId,
    streamId: 0,
    seq: 1n,
    ack: 0,
  }, Buffer.alloc(0), aCiphers)
  B.handleGatewayFrame(sealedWs)
  assert.equal(demoted, 1, 'WS frame after 700ms (> 500ms wsReorderGraceMs) triggers demotion')
})
