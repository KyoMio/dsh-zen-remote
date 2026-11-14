'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { registerHooks, stripTypeScriptTypes } = require('node:module')
const { existsSync, readFileSync } = require('node:fs')
const { fileURLToPath } = require('node:url')
// Exercise source without building the installed plugin.
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
const { PeerPunchManager, ed25519Sign } = require('../src/peer/punch.ts')
const { generatePeerIdentity, generateEphemeralX25519, derivePeerSessionCiphers, buildPeerHandshakeEnvelope } = require('../src/peer/crypto.ts')
const { packEncryptedFrame, unpackEncryptedFrame, PeerFrameType } = require('../src/peer/wire.ts')
const NET = '1234567890abcdef'
const origin = { address: '127.0.0.1', port: 55556 }
const clock = { now: () => 1000, setTimeout: () => 1, clearTimeout() {} }
class Datagram extends EventEmitter {
  sent = []
  address() { return { address: '127.0.0.1', port: 55555 } }
  send(bytes) { this.sent.push(Buffer.from(bytes)) }
  close() {}
}
function control(identity, ephPubHex, peerNodeId, kind = 'hello', nonce = '0123456789abcdef', peerEphPubHex = null) {
  return buildPeerHandshakeEnvelope({
    kind,
    networkId: NET,
    identity,
    selfEphPubHex: ephPubHex,
    peerNodeId,
    peerEphPubHex: kind === 'hello' ? null : peerEphPubHex,
    nonce,
    timestamp: 1,
  })
}
function legacyV1Control(identity, ephPubHex, kind = 'hello', nonce = '0123456789abcdef') {
  const timestamp = 1
  const sigHex = ed25519Sign(Buffer.from(`zr-punch-v1|${kind}|${NET}|${identity.nodeId}|${ephPubHex}|${nonce}|${timestamp}`), identity)
  return Buffer.from(JSON.stringify({ zr: 1, kind: kind === 'hello' ? 'zr-hello' : 'zr-hello-ack', networkId: NET, nodeId: identity.nodeId, publicKeyHex: identity.publicKeyHex, ephPubHex, nonce, timestamp, sigHex }))
}
function packets(socket, kind) {
  return socket.sent.filter(b => b[0] === 123).map(b => JSON.parse(b)).filter(p => p.kind === kind)
}
function fixture() {
  const local = generatePeerIdentity(), peer = generatePeerIdentity(), socket = new Datagram(), accepted = []
  const manager = new PeerPunchManager({ networkId: NET, identity: local, socket, clock, onEncryptedFrame: (_h, p) => accepted.push(Buffer.from(p).toString()) })
  const admit = () => manager.beginPunch({ peerNodeId: peer.nodeId, peerPublicKeyHex: peer.publicKeyHex, lanEndpoints: ['127.0.0.1:55556'] })
  const receive = b => socket.emit('message', b, origin)
  const confirm = eph => {
    receive(control(peer, eph.publicKeyHex, local.nodeId))
    const challenge = packets(socket, 'zr-hello').at(-1)
    const ack = control(peer, eph.publicKeyHex, local.nodeId, 'ack', challenge.nonce, challenge.ephPubHex)
    receive(ack)
    return { ack, ciphers: derivePeerSessionCiphers({ networkId: NET, myNodeId: peer.nodeId, peerNodeId: local.nodeId, myEphPrivateKeyHex: eph.privateKeyHex, myEphPublicKeyHex: eph.publicKeyHex, peerEphPublicKeyHex: challenge.ephPubHex }) }
  }
  return { local, peer, socket, manager, admit, receive, confirm, accepted }
}
test('unannounced signed HELLO cannot create a UDP session or trigger an ACK', () => {
  const f = fixture()
  try {
    f.receive(control(f.peer, generateEphemeralX25519().publicKeyHex, f.local.nodeId))
    assert.equal(f.socket.sent.length, 0)
    assert.equal(f.manager.sessionCiphers(f.peer.nodeId), null)
  } finally { f.manager.close() }
})
test('admitted low-order DH HELLO and ACK cannot escape the socket callback or poison a live session', () => {
  const f = fixture()
  try {
    f.admit()
    f.confirm(generateEphemeralX25519())
    const live = f.manager.sessionCiphers(f.peer.nodeId)
    // All-zero sender ephemeral key is rejected cleanly at parse before ACK construction.
    assert.doesNotThrow(() => f.receive(control(f.peer, '00'.repeat(32), f.local.nodeId)))
    assert.equal(packets(f.socket, 'zr-ack').length, 0)
    // Non-zero order-2 Curve25519 point (u = 1, little-endian) passes envelope parse
    // and exercises the low-order DH check in integratePeerEphemeral without poisoning.
    const lowOrder = '01' + '00'.repeat(31)
    assert.doesNotThrow(() => f.receive(control(f.peer, lowOrder, f.local.nodeId)))
    const challenge = packets(f.socket, 'zr-hello').at(-1)
    assert.doesNotThrow(() => f.receive(control(f.peer, '00'.repeat(32), f.local.nodeId, 'ack', challenge.nonce, challenge.ephPubHex)))
    assert.doesNotThrow(() => f.receive(control(f.peer, lowOrder, f.local.nodeId, 'ack', challenge.nonce, challenge.ephPubHex)))
    assert.equal(f.manager.sessionCiphers(f.peer.nodeId), live)
  } finally { f.manager.close() }
})
test('captured HELLO + ACK + DATA cannot roll back keys or replay window after peer restart', () => {
  const f = fixture(), e1 = generateEphemeralX25519(), e2 = generateEphemeralX25519()
  try {
    f.admit()
    const first = f.confirm(e1)
    const frame = packEncryptedFrame({ frameType: PeerFrameType.DATA, srcNodeId: f.peer.nodeId, dstNodeId: f.local.nodeId, streamId: 1, seq: 7n, ack: 0 }, Buffer.from('once'), first.ciphers)
    f.receive(frame); f.receive(frame)
    assert.deepEqual(f.accepted, ['once'])
    const old = f.manager.sessionCiphers(f.peer.nodeId)
    f.receive(control(f.peer, e2.publicKeyHex, f.local.nodeId))
    assert.equal(f.manager.sessionCiphers(f.peer.nodeId), old, 'HELLO alone must preserve live keys')
    f.confirm(e2)
    const current = f.manager.sessionCiphers(f.peer.nodeId)
    assert.notEqual(current.txKeyHex, old.txKeyHex)
    f.receive(control(f.peer, e1.publicKeyHex, f.local.nodeId)); f.receive(first.ack); f.receive(frame)
    assert.equal(f.manager.sessionCiphers(f.peer.nodeId), current)
    assert.deepEqual(f.accepted, ['once'])
  } finally { f.manager.close() }
})
test('duplicate and reordered HELLOs retain one challenge; lost ACK recovers without key rollback', () => {
  const f = fixture(), e1 = generateEphemeralX25519(), e2 = generateEphemeralX25519()
  try {
    f.admit(); const first = f.confirm(e1)
    f.receive(control(f.peer, e2.publicKeyHex, f.local.nodeId))
    const challenge = packets(f.socket, 'zr-hello').at(-1)
    for (const eph of [e2, e1, e2, e2]) f.receive(control(f.peer, eph.publicKeyHex, f.local.nodeId))
    assert.equal(packets(f.socket, 'zr-hello').at(-1).nonce, challenge.nonce)
    f.receive(first.ack)
    f.receive(control(f.peer, e2.publicKeyHex, f.local.nodeId, 'ack', challenge.nonce, challenge.ephPubHex))
    const live = f.manager.sessionCiphers(f.peer.nodeId)
    assert.ok(live)
    f.receive(first.ack)
    assert.equal(f.manager.sessionCiphers(f.peer.nodeId), live)
  } finally { f.manager.close() }
})

// Queue datagrams to deterministically reorder/drop controls while using real crypto.
function linkedPair() {
  const ids = [generatePeerIdentity(), generatePeerIdentity()]
  const sockets = [new Datagram(), new Datagram()]
  const queue = [], managers = [], received = [[], []]
  sockets.forEach((socket, i) => { socket.send = bytes => queue.push({ from: i, bytes: Buffer.from(bytes) }) })
  function start(i) {
    managers[i] = new PeerPunchManager({ networkId: NET, identity: ids[i], socket: sockets[i], clock,
      onEncryptedFrame: (_h, p) => received[i].push(Buffer.from(p).toString()) })
    managers[i].beginPunch({ peerNodeId: ids[1 - i].nodeId, peerPublicKeyHex: ids[1 - i].publicKeyHex, lanEndpoints: ['127.0.0.1:55556'] })
  }
  function drain(reverse = false) {
    let remaining = 100
    while (queue.length) {
      assert.ok(remaining--, 'handshake must converge without an endless HELLO exchange')
      // Alternate newest/oldest so controls are reordered without starving ACKs.
      const { from, bytes } = reverse && remaining % 2 === 0 ? queue.pop() : queue.shift()
      managers[1 - from].handlePacket(bytes, origin)
    }
  }
  function exchange(label) {
    managers.forEach((m, i) => m.frameSenderFor(ids[1 - i].nodeId)(PeerFrameType.DATA, 1, Buffer.from(label), 0))
    drain()
    for (const frames of received) assert.equal(frames.at(-1), label)
  }
  start(0); start(1)
  return { ids, managers, queue, start, drain, exchange, close: () => managers.forEach(m => m.close()) }
}
test('simultaneous handshakes and repeated single-end restarts converge with reordered datagrams', () => {
  const p = linkedPair()
  try {
    p.drain(); p.exchange('initial')
    for (const i of [0, 0, 1, 0, 1]) {
      p.managers[i].close(); p.start(i)
      p.drain(true); p.exchange(`restart-${i}`)
    }
  } finally { p.close() }
})

test('legacy v1 packets without hs: 2 are rejected; v2 single-end restart converges cleanly', () => {
  const f = fixture()
  try {
    f.admit()
    const sentBefore = f.socket.sent.length
    const legacyEph = generateEphemeralX25519()
    const initialChallenge = packets(f.socket, 'zr-hello').at(-1)
    f.receive(legacyV1Control(f.peer, legacyEph.publicKeyHex, 'hello'))
    assert.equal(packets(f.socket, 'zr-hello-ack').length, 0, 'legacy v1 HELLO triggers no ACK')
    f.receive(legacyV1Control(f.peer, legacyEph.publicKeyHex, 'ack', initialChallenge.nonce))
    assert.equal(f.manager.sessionCiphers(f.peer.nodeId), null, 'legacy v1 ACK derives no ciphers')
    assert.equal(f.socket.sent.length, sentBefore)

    for (const label of ['v2-initial', 'v2-restarted']) {
      const eph = generateEphemeralX25519()
      const { ciphers } = f.confirm(eph)
      f.receive(packEncryptedFrame({ frameType: PeerFrameType.DATA, srcNodeId: f.peer.nodeId, dstNodeId: f.local.nodeId, streamId: 1, seq: 1n, ack: 0 }, Buffer.from(label), ciphers))
      assert.equal(f.accepted.at(-1), label)
      f.manager.frameSenderFor(f.peer.nodeId)(PeerFrameType.DATA, 1, Buffer.from(label), 0)
      assert.equal(Buffer.from(unpackEncryptedFrame(f.socket.sent.at(-1), ciphers).plaintext).toString(), label)
    }
  } finally { f.manager.close() }
})

test('revoking a peer drops ciphers and prevents late handshake resurrection', () => {
  const f = fixture(), eph = generateEphemeralX25519()
  try {
    f.admit(); const old = f.confirm(eph)
    f.manager.dropPeer(f.peer.nodeId)
    f.receive(control(f.peer, eph.publicKeyHex, f.local.nodeId)); f.receive(old.ack)
    assert.equal(f.manager.sessionCiphers(f.peer.nodeId), null)
  } finally { f.manager.close() }
})
