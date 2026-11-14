'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { registerHooks, stripTypeScriptTypes } = require('node:module')
const { existsSync, readFileSync } = require('node:fs')
const { fileURLToPath } = require('node:url')
const { once } = require('node:events')
const { createHash } = require('node:crypto')
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
const { PeerMux } = require('../src/peer/mux.ts')
const { generatePeerIdentity, generateEphemeralX25519, buildPeerHandshakeEnvelope } = require('../src/peer/crypto.ts')
const { encodeFrameHeader, PeerFrameType, PEER_FRAME_MAGIC, PEER_FRAME_VERSION } = require('../src/peer/wire.ts')
const immediate = () => new Promise(resolve => setImmediate(resolve))
function pair(t, handler) {
  const a = generatePeerIdentity(), b = generatePeerIdentity()
  const options = { networkId: '0123456789abcdef', sendGatewayBinary: null, relaySecret: () => 'test-secret' }
  const A = new PeerMux({ ...options, identity: a, relayHandler: () => undefined })
  const B = new PeerMux({ ...options, identity: b, relayHandler: () => handler })
  A.ensureSession(b.nodeId, b.publicKeyHex, 'B'); B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
  for (const [from,to,id,target] of [[A,B,a,b],[B,A,b,a]]) from.setDirectPath(target.nodeId, (...frame) => setImmediate(() => to.handleOpenedFrame({ srcNodeId: id.nodeId, frameType: frame[0], streamId: frame[1], ack: frame[3] }, frame[2])))
  t.after(() => { A.close(); B.close() })
  return { A, B, fetch: A.createFetchForPeer(b.nodeId), sa: A.sessions.get(b.nodeId), sb: B.sessions.get(a.nodeId) }
}

test('signed gateway ACK with low-order DH key cannot throw or replace cipher state', t => {
  const a = generatePeerIdentity(), b = generatePeerIdentity(), networkId = '0123456789abcdef'
  const mux = new PeerMux({ identity: a, networkId, sendGatewayBinary() {}, relayHandler: () => undefined, relaySecret: () => 'test' })
  t.after(() => mux.close())
  mux.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  mux.enableRelayPath(b.nodeId)
  const nonce = mux.sessions.get(b.nodeId).nonce, timestamp = Date.now(), ephPubHex = '00'.repeat(32)
  const payload = buildPeerHandshakeEnvelope({
    kind: 'ack',
    networkId,
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

test('gateway key rotation requires a fresh ACK and cannot roll back via recorded HELLO or consumed ACK', t => {
  const a = generatePeerIdentity(), b = generatePeerIdentity(), networkId = '0123456789abcdef'
  const mux = new PeerMux({ identity: a, networkId, sendGatewayBinary() {}, relayHandler: () => undefined, relaySecret: () => 'test' })
  t.after(() => mux.close())
  mux.ensureSession(b.nodeId, b.publicKeyHex, 'B')
  const state = mux.sessions.get(b.nodeId)
  function control(kind, ephPubHex, nonce) {
    const timestamp = Date.now()
    const payload = buildPeerHandshakeEnvelope({
      kind,
      networkId,
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
  const k1 = generateEphemeralX25519().publicKeyHex, k2 = generateEphemeralX25519().publicKeyHex
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
})

for (const simultaneous of [false, true]) test(`gateway fresh handshake converges ${simultaneous ? 'simultaneously' : 'from one initiator'}`, { timeout: 3000 }, async t => {
  const a = generatePeerIdentity(), b = generatePeerIdentity()
  const common = { networkId: '0123456789abcdef', relaySecret: () => 'test' }
  let A, B
  A = new PeerMux({ ...common, identity: a, sendGatewayBinary: bytes => setImmediate(() => B.handleGatewayFrame(bytes)), relayHandler: () => undefined })
  B = new PeerMux({ ...common, identity: b, sendGatewayBinary: bytes => setImmediate(() => A.handleGatewayFrame(bytes)), relayHandler: () => async (_req,res) => { res.end('via relay') } })
  t.after(() => { A.close(); B.close() })
  A.ensureSession(b.nodeId, b.publicKeyHex, 'B'); B.ensureSession(a.nodeId, a.publicKeyHex, 'A')
  A.enableRelayPath(b.nodeId)
  if (simultaneous) B.enableRelayPath(a.nodeId)
  assert.equal(await (await A.createFetchForPeer(b.nodeId)('http://peer/ws')).text(), 'via relay')
  assert.equal(A.sessions.get(b.nodeId).nonce, null)
  assert.equal(B.sessions.get(a.nodeId).nonce, null)
})

test('1000 completed HTTP exchanges release mux streams and abort listeners', { timeout: 10000 }, async t => {
  const p = pair(t, async (_req,res) => { res.end('ok') })
  const controller = new AbortController()
  let listeners = 0
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = (...args) => { listeners++; return add(...args) }
  controller.signal.removeEventListener = (...args) => { listeners--; return remove(...args) }
  for (let i = 0; i < 1000; i++) assert.equal(await (await p.fetch('http://peer/small', { signal: controller.signal })).text(), 'ok')
  for (let i = 0; i < 5; i++) await immediate()
  assert.equal(listeners, 0)
  assert.equal(p.sa.streams.size, 0); assert.equal(p.sb.streams.size, 0)
  assert.equal(p.sa.arq.active.size, 0); assert.equal(p.sb.arq.active.size, 0)
})

test('send admission is bounded per stream and peer, without one RTT per small write', async t => {
  const arq = new PeerArqSession({ sendFrame() {}, maxStreamBytes: 1024, maxSessionBytes: 2048 })
  t.after(() => arq.closeAll())
  assert.equal(typeof arq.tryWrite, 'function')
  for (let i = 0; i < 8; i++) assert.equal(arq.tryWrite(1, Buffer.alloc(100)), true)
  assert.equal(arq.tryWrite(1, Buffer.alloc(300)), false)
  assert.equal(arq.tryWrite(2, Buffer.alloc(800)), true)
  assert.equal(arq.tryWrite(3, Buffer.alloc(800)), false)
  await assert.rejects(arq.write(4, Buffer.alloc(8 * 1024 * 1024)), /capacity|budget/)
})

for (const contentLength of [true, false]) test(`8MiB ${contentLength ? 'content-length' : 'single chunked chunk'} streams with slow consumer and concurrent small response`, { timeout: 15000 }, async t => {
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
  assert.ok(p.sb.arq.bufferedSendBytes() <= 256 * 1024)
  assert.ok(p.sa.arq.bufferedReceiveBytes() <= 4 * 1024 * 1024)
  assert.equal(await (await p.fetch('http://peer/small')).text(), 'small')
  const digest = createHash('sha256'); let bytes = 0
  for await (const chunk of response.body) { digest.update(chunk); bytes += chunk.length; if (bytes % 65536 < 1100) await immediate() }
  assert.equal(bytes, body.length)
  assert.equal(digest.digest('hex'), createHash('sha256').update(body).digest('hex'))
  for (let i = 0; i < 10; i++) await immediate()
  assert.equal(p.sa.streams.size, 0); assert.equal(p.sb.streams.size, 0)
})

test('8MiB upload keeps request readable bounded and cancellation releases producer', { timeout: 15000 }, async t => {
  const body = Buffer.alloc(8 * 1024 * 1024, 0x5a)
  let request, release
  const gate = new Promise(resolve => { release = resolve })
  const p = pair(t, async (req,res) => {
    request = req
    await gate
    let size = 0; const digest = createHash('sha256')
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

for (const timing of ['immediate', 'read-pending', 'read-completed']) test(`upload ${timing} abort cancels source and releases reader lock`, async t => {
  const p = pair(t, async () => {})
  const controller = new AbortController()
  let cancellations = 0, sourceController
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

test('consumer cancellation bypasses stalled DATA and releases abort listener', { timeout: 5000 }, async t => {
  let responseClosed = false
  const p = pair(t, async (_req,res) => {
    res.on('close', () => { responseClosed = true })
    for (let i = 0; i < 1024 && !res.destroyed; i++) if (!res.write(Buffer.alloc(16384))) await once(res, 'drain').catch(() => {})
  })
  const controller = new AbortController()
  let added = 0, removed = 0
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = (...args) => { added++; return add(...args) }
  controller.signal.removeEventListener = (...args) => { removed++; return remove(...args) }
  const response = await p.fetch('http://peer/live', { signal: controller.signal })
  for (let i = 0; i < 100; i++) await immediate()
  await response.body.cancel()
  for (let i = 0; i < 10; i++) await immediate()
  assert.equal(responseClosed, true)
  assert.equal(added, removed)
  assert.equal(p.sa.streams.size, 0); assert.equal(p.sb.streams.size, 0)
})
