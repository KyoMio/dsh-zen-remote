/* dsh-zen-remote · peer-gateway PG-1 (tasks/peer-gateway/PG-1.md)
 *
 * Two pure host-side modules, zero third-party deps, no I/O:
 *   - src/peer/crypto.ts  self-certifying Ed25519 identity, invite URIs,
 *     gateway challenge signing, join-key HMAC, ephemeral X25519 handshake
 *     with HKDF-derived dual-simplex AEAD ciphers and a 64-entry replay
 *     window that only ever advances on an AUTHENTICATED packet.
 *   - src/peer/wire.ts    the 28-byte big-endian routing header and the
 *     ≤1200B chacha20-poly1305 sealed frame built on those ciphers (the
 *     header rides as AAD, so a relay that only reads the plaintext
 *     header cannot flip a single routing bit undetected).
 *
 * Everything here drives the BUILT lib/peer/*.js like every other wiring
 * test in this repo.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash, createHmac } = require('node:crypto')

const {
  generatePeerIdentity,
  deriveNodeIdFromPublicKey,
  verifySelfCertifyingNodeId,
  parseInviteUri,
  formatInviteUri,
  parseGatewayJoinInput,
  buildKeylessInviteUri,
  signGatewayChallenge,
  verifyGatewayChallenge,
  computeJoinKeyProof,
  verifyJoinKeyProof,
  generateEphemeralX25519,
  signPeerHandshake,
  verifyPeerHandshake,
  derivePeerSessionCiphers,
} = require('../lib/peer/crypto.js')
const {
  PEER_FRAME_MAGIC,
  PEER_FRAME_VERSION,
  PEER_HEADER_BYTES,
  PEER_AEAD_TAG_BYTES,
  PEER_MAX_FRAME_BYTES,
  PEER_MAX_PLAINTEXT_BYTES,
  PeerFrameType,
  encodeFrameHeader,
  decodeFrameHeader,
  packEncryptedFrame,
  unpackEncryptedFrame,
} = require('../lib/peer/wire.js')

const HEX64 = /^[0-9a-f]{64}$/

function looksLikeHex(value, length) {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value)
}

/**
 * A complete two-node session with fresh identities and ephemerals. The
 * replay window lives inside each side's rx cipher and PERSISTS across
 * opens, so every test that exercises window behavior must derive its own
 * session — a shared SESSION would leak committed seqs between tests.
 */
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
  return { A, B, aEph, bEph, networkId, ciphersA, ciphersB }
}

// -- 1. Ed25519 self-certifying identity ---------------------------------------

test('identity: raw 32B key halves + 8-hex self-certifying nodeId', () => {
  const id = generatePeerIdentity()
  assert.equal(typeof id.publicKeyHex, 'string')
  assert.equal(typeof id.privateKeyHex, 'string')
  assert.ok(looksLikeHex(id.publicKeyHex, 64), 'publicKeyHex is 64 lowercase hex chars')
  assert.ok(looksLikeHex(id.privateKeyHex, 64), 'privateKeyHex is 64 lowercase hex chars')
  assert.ok(looksLikeHex(id.nodeId, 8), 'nodeId is 8 lowercase hex chars')
  // Self-certifying: nodeId = sha256(raw public key bytes), first 8 hex.
  const expected = createHash('sha256').update(Buffer.from(id.publicKeyHex, 'hex')).digest('hex').slice(0, 8)
  assert.equal(id.nodeId, expected)
})

test('identity: two generations differ', () => {
  const a = generatePeerIdentity()
  const b = generatePeerIdentity()
  assert.notEqual(a.publicKeyHex, b.publicKeyHex)
  assert.notEqual(a.nodeId, b.nodeId)
})

test('deriveNodeIdFromPublicKey: matches sha256 and rejects malformed input', () => {
  const id = generatePeerIdentity()
  assert.equal(deriveNodeIdFromPublicKey(id.publicKeyHex), id.nodeId)
  // Malformed input must throw TypeError, never return a nodeId.
  assert.throws(() => deriveNodeIdFromPublicKey('not hex'), TypeError)
  assert.throws(() => deriveNodeIdFromPublicKey('abcd'), TypeError) // too short
  assert.throws(() => deriveNodeIdFromPublicKey(`${id.publicKeyHex}00`), TypeError) // too long
  assert.throws(() => deriveNodeIdFromPublicKey(`${id.publicKeyHex.slice(0, 63)}g`), TypeError) // non-hex
  assert.throws(() => deriveNodeIdFromPublicKey(undefined), TypeError)
  assert.throws(() => deriveNodeIdFromPublicKey(null), TypeError)
})

test('verifySelfCertifyingNodeId: accepts the true pair, rejects tampering', () => {
  const id = generatePeerIdentity()
  assert.equal(verifySelfCertifyingNodeId(id.nodeId, id.publicKeyHex), true)
  // Forged nodeId (valid shape, wrong binding).
  assert.equal(verifySelfCertifyingNodeId('deadbeef', id.publicKeyHex), false)
  assert.equal(verifySelfCertifyingNodeId('00000000', id.publicKeyHex), false)
  // Tampered public key (one bit flipped keeps the shape, breaks the binding).
  const flipped = (BigInt('0x' + id.publicKeyHex) ^ 1n).toString(16).padStart(64, '0')
  assert.equal(verifySelfCertifyingNodeId(id.nodeId, flipped), false)
  // Shape violations.
  assert.equal(verifySelfCertifyingNodeId('ABCDEF01', id.publicKeyHex), false) // not lowercase
  assert.equal(verifySelfCertifyingNodeId(id.nodeId, 'zz'), false)
  assert.equal(verifySelfCertifyingNodeId('', id.publicKeyHex), false)
  assert.equal(verifySelfCertifyingNodeId(id.nodeId, ''), false)
})

// -- 2. invite URI parse/format -------------------------------------------------

test('parseInviteUri: public domain defaults to wss/https on port 19393', () => {
  const p = parseInviteUri('zr-net://peer.example.com/0123456789abcdef')
  assert.ok(p, 'parses')
  assert.equal(p.rawHost, 'peer.example.com')
  assert.equal(p.hostname, 'peer.example.com')
  assert.equal(p.port, 19393)
  assert.equal(p.networkId, '0123456789abcdef')
  assert.equal(p.defaultTls, true)
  assert.equal(p.wsUrl, 'wss://peer.example.com:19393')
  assert.equal(p.httpOrigin, 'https://peer.example.com:19393')
  assert.equal(p.joinKey, undefined)
})

test('parseInviteUri: private LAN IP defaults to ws/http', () => {
  const p = parseInviteUri('zr-net://192.168.1.10/0123456789abcdef')
  assert.ok(p)
  assert.equal(p.defaultTls, false)
  assert.equal(p.wsUrl, 'ws://192.168.1.10:19393')
  assert.equal(p.httpOrigin, 'http://192.168.1.10:19393')
})

test('parseInviteUri: localhost, loopback IPv6 and Tailscale CGNAT default to ws/http', () => {
  for (const host of ['localhost', '127.0.0.1', '10.0.0.2', '172.16.5.5', '100.64.1.2']) {
    const p = parseInviteUri(`zr-net://${host}/0123456789abcdef`)
    assert.ok(p, host)
    assert.equal(p.defaultTls, false, host)
  }
  const v6 = parseInviteUri('zr-net://[::1]:19999/0123456789abcdef')
  assert.ok(v6)
  assert.equal(v6.rawHost, '[::1]')
  assert.equal(v6.hostname, '::1')
  assert.equal(v6.port, 19999)
  assert.equal(v6.defaultTls, false)
  assert.equal(v6.wsUrl, 'ws://[::1]:19999')
})

test('parseInviteUri: custom port, joinKey, uppercase networkId normalized', () => {
  const p = parseInviteUri('  zr-net://peer.example.com:8443/ABCDEF0123456789#s3cret-key  ')
  assert.ok(p, 'parses with surrounding whitespace')
  assert.equal(p.port, 8443)
  assert.equal(p.networkId, 'abcdef0123456789', 'networkId normalized to lowercase')
  assert.equal(p.joinKey, 's3cret-key')
  assert.equal(p.wsUrl, 'wss://peer.example.com:8443')
})

test('parseInviteUri: zr-nets forces TLS even for private hosts', () => {
  const p = parseInviteUri('zr-nets://192.168.1.10/0123456789abcdef')
  assert.ok(p)
  assert.equal(p.defaultTls, true)
  assert.equal(p.wsUrl, 'wss://192.168.1.10:19393')
  assert.equal(p.httpOrigin, 'https://192.168.1.10:19393')
})

test('parseInviteUri: zr-net+insecure forces plaintext even for public domains', () => {
  const p = parseInviteUri('zr-net+insecure://peer.example.com/0123456789abcdef')
  assert.ok(p)
  assert.equal(p.defaultTls, false)
  assert.equal(p.wsUrl, 'ws://peer.example.com:19393')
  assert.equal(p.httpOrigin, 'http://peer.example.com:19393')
})

test('parseInviteUri: joinKey percent-decoding with raw fallback, empty # is no key', () => {
  assert.equal(parseInviteUri('zr-net://h.co/0123456789abcdef#my%20key').joinKey, 'my key')
  assert.equal(parseInviteUri('zr-net://h.co/0123456789abcdef#').joinKey, undefined, 'empty fragment means no joinKey')
  assert.equal(parseInviteUri('zr-net://h.co/0123456789abcdef#a%2zb').joinKey, 'a%2zb', 'decodeURIComponent failure keeps raw')
})

test('parseInviteUri: invalid inputs return null, never throw', () => {
  const bad = [
    '',
    'not a uri',
    'https://peer.example.com/0123456789abcdef', // wrong scheme
    'zr-net://peer.example.com', // no path
    'zr-net:///0123456789abcdef', // empty host
    'zr-net://peer.example.com', // (no networkId segment)
    'zr-net://peer.example.com/short', // networkId too short
    'zr-net://peer.example.com/0123456789abcdef0', // networkId too long
    'zr-net://peer.example.com/0123456789abcg', // non-hex networkId
    'zr-net://peer.example.com/0123456789abcdef/extra', // extra path segment
    'zr-net://peer.example.com:0/0123456789abcdef', // port 0
    'zr-net://peer.example.com:65536/0123456789abcdef', // port too big
    'zr-net://peer.example.com:abc/0123456789abcdef', // non-numeric port
    'zr-net://peer.example.com:/0123456789abcdef', // empty port
    'zr-net://peer example.com/0123456789abcdef', // space inside host
    'zr-net://[::1/0123456789abcdef', // unclosed bracket
  ]
  for (const input of bad) {
    assert.equal(parseInviteUri(input), null, JSON.stringify(input))
  }
  assert.equal(parseInviteUri(undefined), null)
  assert.equal(parseInviteUri(42), null)
})

test('formatInviteUri: round-trips through parseInviteUri', () => {
  const uri = formatInviteUri({ host: 'peer.example.com', networkId: 'ABCDEF0123456789', joinKey: 's3cret/key?' })
  assert.equal(uri, 'zr-net://peer.example.com/abcdef0123456789#s3cret%2Fkey%3F')
  const p = parseInviteUri(uri)
  assert.ok(p)
  assert.equal(p.rawHost, 'peer.example.com')
  assert.equal(p.networkId, 'abcdef0123456789')
  assert.equal(p.joinKey, 's3cret/key?')
  // No joinKey → no fragment at all.
  assert.equal(formatInviteUri({ host: '10.0.0.2', networkId: '0123456789abcdef' }), 'zr-net://10.0.0.2/0123456789abcdef')
  // Explicit scheme passthrough.
  assert.equal(
    formatInviteUri({ host: 'peer.example.com', networkId: '0123456789abcdef', scheme: 'zr-nets' }),
    'zr-nets://peer.example.com/0123456789abcdef',
  )
  assert.equal(
    formatInviteUri({ host: 'peer.example.com', networkId: '0123456789abcdef', scheme: 'zr-net+insecure' }),
    'zr-net+insecure://peer.example.com/0123456789abcdef',
  )
  // Programmer errors throw (parse must never throw; format is call-site driven).
  assert.throws(() => formatInviteUri({ host: 'peer.example.com', networkId: 'short' }), TypeError)
  assert.throws(() => formatInviteUri({ host: '', networkId: '0123456789abcdef' }), TypeError)
})

// -- 3. gateway challenge signature + join-key HMAC ------------------------------

const GW = (() => {
  const identity = generatePeerIdentity()
  const params = {
    privateKeyHex: identity.privateKeyHex,
    publicKeyHex: identity.publicKeyHex,
    challengeHex: 'aabbccdd00112233',
    networkId: 'abcdef0123456789',
    nodeId: identity.nodeId,
    timestamp: 1700000000000,
  }
  return { identity, params }
})()

test('signGatewayChallenge/verifyGatewayChallenge: round-trips', () => {
  const signatureHex = signGatewayChallenge(GW.params)
  assert.ok(looksLikeHex(signatureHex, 128), 'Ed25519 signature is 128 lowercase hex chars')
  assert.equal(verifyGatewayChallenge({ ...GW.params, signatureHex }), true)
})

test('verifyGatewayChallenge: deterministic and rejects every tampered field', () => {
  const signatureHex = signGatewayChallenge(GW.params)
  assert.equal(signatureHex, signGatewayChallenge(GW.params), 'deterministic')
  assert.equal(verifyGatewayChallenge({ ...GW.params, challengeHex: 'ffffffff00112233', signatureHex }), false)
  assert.equal(verifyGatewayChallenge({ ...GW.params, networkId: '0000000000000000', signatureHex }), false)
  assert.equal(verifyGatewayChallenge({ ...GW.params, nodeId: 'deadbeef', signatureHex }), false, 'forged nodeId')
  assert.equal(verifyGatewayChallenge({ ...GW.params, timestamp: GW.params.timestamp + 1, signatureHex }), false)
  // Flip the last hex digit to its complement — guaranteed different, same length.
  const flippedSig = signatureHex.slice(0, 127) + (signatureHex.endsWith('0') ? '1' : '0')
  assert.notEqual(flippedSig, signatureHex)
  assert.equal(verifyGatewayChallenge({ ...GW.params, signatureHex: flippedSig }), false)
  assert.equal(verifyGatewayChallenge({ ...GW.params, signatureHex: 'zz' }), false, 'malformed signature')
  // The verifier must refuse identities whose nodeId is NOT self-certifying
  // for the given public key — that check comes before signature math.
  const other = generatePeerIdentity()
  assert.equal(
    verifyGatewayChallenge({ ...GW.params, publicKeyHex: other.publicKeyHex, signatureHex }),
    false,
    'nodeId/publicKey binding broken',
  )
})

test('computeJoinKeyProof/verifyJoinKeyProof: HMAC-SHA256 as specified', () => {
  const { joinKey, challengeHex, networkId, nodeId } = { joinKey: 'hunter2', challengeHex: GW.params.challengeHex, networkId: GW.params.networkId, nodeId: GW.params.nodeId }
  const proofHex = computeJoinKeyProof({ joinKey, challengeHex, networkId, nodeId })
  assert.ok(looksLikeHex(proofHex, 64), 'SHA-256 HMAC is 64 lowercase hex chars')
  const expected = createHmac('sha256', Buffer.from(joinKey, 'utf8'))
    .update(`zr-join-v1|${networkId}|${nodeId}|${challengeHex}`, 'utf8')
    .digest('hex')
  assert.equal(proofHex, expected, 'exact message and key per spec')
  assert.equal(verifyJoinKeyProof({ joinKey, challengeHex, networkId, nodeId, proofHex }), true)
  assert.equal(verifyJoinKeyProof({ joinKey: 'hunter3', challengeHex, networkId, nodeId, proofHex }), false)
  assert.equal(verifyJoinKeyProof({ joinKey, challengeHex: 'ff' + challengeHex.slice(2), networkId, nodeId, proofHex }), false)
  assert.equal(verifyJoinKeyProof({ joinKey, challengeHex, networkId, nodeId, proofHex: 'z'.repeat(64) }), false)
  assert.equal(verifyJoinKeyProof({ joinKey, challengeHex, networkId, nodeId, proofHex: 'aa' }), false, 'wrong length')
  assert.equal(verifyJoinKeyProof({ joinKey, challengeHex, networkId, nodeId, proofHex: undefined }), false)
})

// -- 4. PFS handshake + dual-simplex AEAD ciphers --------------------------------

const SESSION = (() => {
  const A = generatePeerIdentity()
  const B = generatePeerIdentity()
  const aEph = generateEphemeralX25519()
  const bEph = generateEphemeralX25519()
  const ZERO_EPH = '0'.repeat(64)
  const netId = 'abcdef0123456789'
  const helloSig = signPeerHandshake({
    role: 'hello', identityPrivateKeyHex: A.privateKeyHex, identityPublicKeyHex: A.publicKeyHex,
    networkId: netId, srcNodeId: A.nodeId, dstNodeId: B.nodeId,
    srcEphPubHex: aEph.publicKeyHex, dstEphPubHex: ZERO_EPH, timestamp: 1700000000000,
  })
  const ackSig = signPeerHandshake({
    role: 'ack', identityPrivateKeyHex: B.privateKeyHex, identityPublicKeyHex: B.publicKeyHex,
    networkId: netId, srcNodeId: B.nodeId, dstNodeId: A.nodeId,
    srcEphPubHex: bEph.publicKeyHex, dstEphPubHex: aEph.publicKeyHex, timestamp: 1700000000001,
  })
  const ciphersA = derivePeerSessionCiphers({
    networkId: netId, myNodeId: A.nodeId, peerNodeId: B.nodeId,
    myEphPrivateKeyHex: aEph.privateKeyHex, myEphPublicKeyHex: aEph.publicKeyHex, peerEphPublicKeyHex: bEph.publicKeyHex,
  })
  const ciphersB = derivePeerSessionCiphers({
    networkId: netId, myNodeId: B.nodeId, peerNodeId: A.nodeId,
    myEphPrivateKeyHex: bEph.privateKeyHex, myEphPublicKeyHex: bEph.publicKeyHex, peerEphPublicKeyHex: aEph.publicKeyHex,
  })
  return { A, B, aEph, bEph, ZERO_EPH, netId, helloSig, ackSig, ciphersA, ciphersB }
})()

test('generateEphemeralX25519: 32B raw halves, fresh per call', () => {
  const a = generateEphemeralX25519()
  const b = generateEphemeralX25519()
  assert.ok(looksLikeHex(a.publicKeyHex, 64))
  assert.ok(looksLikeHex(a.privateKeyHex, 64))
  assert.notEqual(a.publicKeyHex, b.publicKeyHex)
})

test('peer handshake: hello (zero dstEph) and ack verify with the right identity', () => {
  assert.equal(
    verifyPeerHandshake({
      role: 'hello', identityPublicKeyHex: SESSION.A.publicKeyHex,
      networkId: SESSION.netId, srcNodeId: SESSION.A.nodeId, dstNodeId: SESSION.B.nodeId,
      srcEphPubHex: SESSION.aEph.publicKeyHex, dstEphPubHex: SESSION.ZERO_EPH, timestamp: 1700000000000,
      signatureHex: SESSION.helloSig,
    }),
    true,
  )
  assert.equal(
    verifyPeerHandshake({
      role: 'ack', identityPublicKeyHex: SESSION.B.publicKeyHex,
      networkId: SESSION.netId, srcNodeId: SESSION.B.nodeId, dstNodeId: SESSION.A.nodeId,
      srcEphPubHex: SESSION.bEph.publicKeyHex, dstEphPubHex: SESSION.aEph.publicKeyHex, timestamp: 1700000000001,
      signatureHex: SESSION.ackSig,
    }),
    true,
  )
})

test('peer handshake: tampered fields, wrong role, wrong identity all fail verification', () => {
  const hello = (over) => verifyPeerHandshake({
    role: 'hello', identityPublicKeyHex: SESSION.A.publicKeyHex,
    networkId: SESSION.netId, srcNodeId: SESSION.A.nodeId, dstNodeId: SESSION.B.nodeId,
    srcEphPubHex: SESSION.aEph.publicKeyHex, dstEphPubHex: SESSION.ZERO_EPH, timestamp: 1700000000000,
    signatureHex: SESSION.helloSig, ...over,
  })
  assert.equal(hello({ role: 'ack' }), false, 'role swap')
  assert.equal(hello({ networkId: '0000000000000000' }), false)
  assert.equal(hello({ dstNodeId: SESSION.A.nodeId }), false)
  assert.equal(hello({ srcEphPubHex: SESSION.bEph.publicKeyHex }), false)
  assert.equal(hello({ dstEphPubHex: SESSION.bEph.publicKeyHex }), false)
  assert.equal(hello({ timestamp: 1700000000009 }), false)
  assert.equal(hello({ signatureHex: SESSION.ackSig }), false)
  assert.equal(hello({ identityPublicKeyHex: SESSION.B.publicKeyHex }), false, 'wrong signer identity')
  assert.equal(hello({ signatureHex: 'ff' + SESSION.helloSig.slice(2) }), false)
})

test('dual-simplex ciphers: A.tx === B.rx, B.tx === A.rx, tx !== rx', () => {
  const { ciphersA, ciphersB } = SESSION
  assert.ok(looksLikeHex(ciphersA.txKeyHex, 64))
  assert.ok(looksLikeHex(ciphersA.rxKeyHex, 64))
  assert.equal(ciphersA.txKeyHex, ciphersB.rxKeyHex, 'A transmit key is exactly B receive key')
  assert.equal(ciphersA.rxKeyHex, ciphersB.txKeyHex, 'B transmit key is exactly A receive key')
  assert.notEqual(ciphersA.txKeyHex, ciphersA.rxKeyHex, 'directions are strictly isolated')
  // Deterministic: re-deriving the same session yields the same keys.
  const again = derivePeerSessionCiphers({
    networkId: SESSION.netId, myNodeId: SESSION.A.nodeId, peerNodeId: SESSION.B.nodeId,
    myEphPrivateKeyHex: SESSION.aEph.privateKeyHex, myEphPublicKeyHex: SESSION.aEph.publicKeyHex,
    peerEphPublicKeyHex: SESSION.bEph.publicKeyHex,
  })
  assert.equal(again.txKeyHex, ciphersA.txKeyHex)
  // A different peer ephemeral key yields entirely different keys.
  const other = derivePeerSessionCiphers({
    networkId: SESSION.netId, myNodeId: SESSION.A.nodeId, peerNodeId: SESSION.B.nodeId,
    myEphPrivateKeyHex: SESSION.aEph.privateKeyHex, myEphPublicKeyHex: SESSION.aEph.publicKeyHex,
    peerEphPublicKeyHex: SESSION.aEph.publicKeyHex,
  })
  assert.notEqual(other.txKeyHex, ciphersA.txKeyHex)
  // Malformed ephemeral keys must throw, not silently derive garbage.
  assert.throws(() => derivePeerSessionCiphers({
    networkId: SESSION.netId, myNodeId: SESSION.A.nodeId, peerNodeId: SESSION.B.nodeId,
    myEphPrivateKeyHex: 'zz', myEphPublicKeyHex: SESSION.aEph.publicKeyHex,
    peerEphPublicKeyHex: SESSION.bEph.publicKeyHex,
  }), TypeError)
  assert.throws(() => derivePeerSessionCiphers({
    networkId: SESSION.netId, myNodeId: 'nothex!', peerNodeId: SESSION.B.nodeId,
    myEphPrivateKeyHex: SESSION.aEph.privateKeyHex, myEphPublicKeyHex: SESSION.aEph.publicKeyHex,
    peerEphPublicKeyHex: SESSION.bEph.publicKeyHex,
  }), TypeError)
})

// -- 5. wire: 28B header codec ----------------------------------------------------

test('wire constants match the spec', () => {
  assert.equal(PEER_FRAME_MAGIC, 0x5a52)
  assert.equal(PEER_FRAME_VERSION, 0x01)
  assert.equal(PEER_HEADER_BYTES, 28)
  assert.equal(PEER_AEAD_TAG_BYTES, 16)
  assert.equal(PEER_MAX_FRAME_BYTES, 1200)
  assert.equal(PEER_MAX_PLAINTEXT_BYTES, 1200 - 28 - 16)
  assert.deepEqual(PeerFrameType, { HELLO: 0x01, ACK: 0x02, DATA: 0x03, SACK: 0x04, PING: 0x05, PONG: 0x06, RST: 0x07 })
})

const SAMPLE_HEADER = {
  magic: 0x5a52,
  version: 0x01,
  frameType: 0x03,
  srcNodeId: 'a1b2c3d4',
  dstNodeId: '000000ff',
  streamId: 0x10203040,
  seq: 0x01020304050607a0n,
  ack: 7,
}

test('encodeFrameHeader: exact 28-byte big-endian layout', () => {
  const buf = encodeFrameHeader(SAMPLE_HEADER)
  assert.ok(Buffer.isBuffer(buf))
  assert.equal(buf.length, 28)
  assert.equal(buf[0], 0x5a)
  assert.equal(buf[1], 0x52)
  assert.equal(buf[2], 0x01)
  assert.equal(buf[3], 0x03)
  assert.equal(buf.subarray(4, 8).toString('hex'), 'a1b2c3d4')
  assert.equal(buf.subarray(8, 12).toString('hex'), '000000ff')
  assert.equal(buf.readUInt32BE(12), 0x10203040)
  assert.equal(buf.readBigUInt64BE(16), 0x01020304050607a0n)
  assert.equal(buf.readUInt32BE(24), 7)
})

test('encodeFrameHeader: round-trips and normalizes uppercase nodeIds', () => {
  const decoded = decodeFrameHeader(encodeFrameHeader({ ...SAMPLE_HEADER, srcNodeId: 'A1B2C3D4' }))
  assert.deepEqual(decoded, { ...SAMPLE_HEADER, srcNodeId: 'a1b2c3d4' })
  assert.deepEqual(decodeFrameHeader(encodeFrameHeader(SAMPLE_HEADER)), SAMPLE_HEADER)
})

test('encodeFrameHeader: rejects invalid fields', () => {
  assert.throws(() => encodeFrameHeader({ ...SAMPLE_HEADER, magic: 0x1234 }), TypeError)
  assert.throws(() => encodeFrameHeader({ ...SAMPLE_HEADER, version: 2 }), TypeError)
  assert.throws(() => encodeFrameHeader({ ...SAMPLE_HEADER, frameType: 0 }), RangeError)
  assert.throws(() => encodeFrameHeader({ ...SAMPLE_HEADER, frameType: 8 }), RangeError)
  assert.throws(() => encodeFrameHeader({ ...SAMPLE_HEADER, frameType: 3.5 }), RangeError)
  assert.throws(() => encodeFrameHeader({ ...SAMPLE_HEADER, srcNodeId: 'nothex!' }), TypeError)
  assert.throws(() => encodeFrameHeader({ ...SAMPLE_HEADER, dstNodeId: 'a1b2c3' }), TypeError)
  assert.throws(() => encodeFrameHeader({ ...SAMPLE_HEADER, streamId: -1 }), RangeError)
  assert.throws(() => encodeFrameHeader({ ...SAMPLE_HEADER, streamId: 2 ** 32 }), RangeError)
  assert.throws(() => encodeFrameHeader({ ...SAMPLE_HEADER, seq: -1n }), RangeError)
  assert.throws(() => encodeFrameHeader({ ...SAMPLE_HEADER, seq: 2n ** 64n }), RangeError)
  assert.throws(() => encodeFrameHeader({ ...SAMPLE_HEADER, ack: 2 ** 32 }), RangeError)
})

test('decodeFrameHeader: never throws, null on any malformed prefix', () => {
  const good = encodeFrameHeader(SAMPLE_HEADER)
  assert.equal(decodeFrameHeader(good.subarray(0, 27)), null, 'short buffer')
  assert.equal(decodeFrameHeader(new Uint8Array(0)), null)
  const badMagic = Buffer.from(good)
  badMagic[0] = 0x00
  assert.equal(decodeFrameHeader(badMagic), null)
  const badVersion = Buffer.from(good)
  badVersion[2] = 0x02
  assert.equal(decodeFrameHeader(badVersion), null)
  const badType = Buffer.from(good)
  badType[3] = 0x08
  assert.equal(decodeFrameHeader(badType), null, 'unknown frameType')
  const zeroType = Buffer.from(good)
  zeroType[3] = 0x00
  assert.equal(decodeFrameHeader(zeroType), null)
  assert.equal(decodeFrameHeader('not bytes'), null, 'non-buffer input')
})

// -- 5/6. sealed frames: AAD integrity + replay window ----------------------------

const ROUTING_HEADER = (over) => ({
  frameType: PeerFrameType.DATA,
  srcNodeId: SESSION.A.nodeId,
  dstNodeId: SESSION.B.nodeId,
  streamId: 42,
  seq: 0n,
  ack: 0,
  ...over,
})

test('pack/unpack round-trip; oversized plaintext throws RangeError; 1200B exact max', () => {
  const greeting = Buffer.from('hello peer')
  const frame = packEncryptedFrame(ROUTING_HEADER({ seq: 1n }), greeting, SESSION.ciphersA)
  assert.equal(frame.length, PEER_HEADER_BYTES + greeting.length + PEER_AEAD_TAG_BYTES)
  const out = unpackEncryptedFrame(frame, SESSION.ciphersB)
  assert.ok(out)
  assert.equal(Buffer.from(out.plaintext).toString(), 'hello peer')
  assert.equal(out.header.frameType, PeerFrameType.DATA)
  assert.equal(out.header.streamId, 42)
  assert.equal(out.header.seq, 1n)
  // Maximum legal plaintext: exactly 1156 → frame exactly 1200.
  const maxFrame = packEncryptedFrame(ROUTING_HEADER({ seq: 2n }), Buffer.alloc(PEER_MAX_PLAINTEXT_BYTES, 7), SESSION.ciphersA)
  assert.equal(maxFrame.length, PEER_MAX_FRAME_BYTES)
  const maxOut = unpackEncryptedFrame(maxFrame, SESSION.ciphersB)
  assert.ok(maxOut)
  assert.deepEqual(Buffer.from(maxOut.plaintext), Buffer.alloc(PEER_MAX_PLAINTEXT_BYTES, 7))
  assert.throws(() => packEncryptedFrame(ROUTING_HEADER({ seq: 3n }), Buffer.alloc(PEER_MAX_PLAINTEXT_BYTES + 1), SESSION.ciphersA), RangeError)
  // Empty plaintext is legal (pure-ack style frames).
  const empty = packEncryptedFrame(ROUTING_HEADER({ seq: 4n }), new Uint8Array(0), SESSION.ciphersA)
  assert.equal(empty.length, 44)
  assert.deepEqual(unpackEncryptedFrame(empty, SESSION.ciphersB).plaintext, new Uint8Array(0))
})

test('unpackEncryptedFrame: null on malformed envelope, never throws', () => {
  const frame = packEncryptedFrame(ROUTING_HEADER({ seq: 5n }), Buffer.from('x'), SESSION.ciphersA)
  assert.equal(unpackEncryptedFrame(frame.subarray(0, 43), SESSION.ciphersB), null, 'below 44 bytes')
  assert.equal(unpackEncryptedFrame(new Uint8Array(PEER_MAX_FRAME_BYTES + 1), SESSION.ciphersB), null, 'above 1200 bytes')
  assert.equal(unpackEncryptedFrame(frame, SESSION.ciphersA), null, 'opened with the WRONG direction (A rx is a different key)')
  const garbage = Buffer.from(frame)
  garbage[30] ^= 0xff // flip one ciphertext byte
  assert.equal(unpackEncryptedFrame(garbage, SESSION.ciphersB), null, 'tampered ciphertext')
})

test('AAD integrity: any tampered header byte fails to open, legit frame still opens', () => {
  // Tampered copies are opened BEFORE the legit one so the null answer can
  // only come from AEAD failure — the rx window has never seen seq yet.
  const frame = packEncryptedFrame(ROUTING_HEADER({ seq: 10n }), Buffer.from('payload'), SESSION.ciphersA)
  const tamper = (index) => {
    const copy = Buffer.from(frame)
    copy[index] ^= 0x01
    return copy
  }
  const dstIndex = 8 // dstNodeId first byte
  const streamIndex = 12 // streamId first byte
  const typeIndex = 3 // frameType
  assert.equal(unpackEncryptedFrame(tamper(dstIndex), SESSION.ciphersB), null, 'tampered dstNodeId')
  assert.equal(unpackEncryptedFrame(tamper(streamIndex), SESSION.ciphersB), null, 'tampered streamId')
  assert.equal(unpackEncryptedFrame(tamper(typeIndex), SESSION.ciphersB), null, 'tampered frameType')
  // The relay can READ the plaintext header for routing...
  const routed = decodeFrameHeader(frame)
  assert.equal(routed.srcNodeId, SESSION.A.nodeId)
  assert.equal(routed.dstNodeId, SESSION.B.nodeId)
  // ...but flipping a routing bit mid-flight is still detected on open.
  const legit = unpackEncryptedFrame(frame, SESSION.ciphersB)
  assert.ok(legit)
  assert.equal(Buffer.from(legit.plaintext).toString(), 'payload')
})

test('replay window: sequential + in-window reorder OK, replay/expiry null, forgery cannot poison the window', () => {
  // Fresh session: the shared SESSION's rx window already committed seqs
  // in the round-trip tests above, and a window that has seen a seq MUST
  // answer null for it — that is the replay guarantee working.
  const session = freshPeerSession()
  const rx = session.ciphersB
  const send = (seq) => packEncryptedFrame(
    ROUTING_HEADER({ srcNodeId: session.A.nodeId, dstNodeId: session.B.nodeId, seq: BigInt(seq) }),
    Buffer.from(`msg-${seq}`),
    session.ciphersA,
  )
  const recv = (seq) => {
    const out = unpackEncryptedFrame(send(seq), rx)
    return out ? Buffer.from(out.plaintext).toString() : null
  }
  // Sequential.
  for (let seq = 0; seq <= 5; seq++) assert.equal(recv(seq), `msg-${seq}`, `sequential seq=${seq}`)
  // The classic reorder: a jump to 10 lands first, then the still-unseen
  // seq=7 arrives from behind and opens (in-window gap fill).
  assert.equal(recv(10), 'msg-10')
  assert.equal(recv(7), 'msg-7', 'in-window reorder')
  // Replay of an already-received packet.
  assert.equal(recv(7), null, 'replayed seq=7')
  // Forged future packet: garbage ciphertext under seq=999999 must NOT open
  // AND must not advance/mark the window — the very next legit packet flows.
  const forged = Buffer.from(packEncryptedFrame(
    ROUTING_HEADER({ srcNodeId: session.A.nodeId, dstNodeId: session.B.nodeId, seq: 999999n }),
    Buffer.from('evil'),
    session.ciphersA,
  ))
  forged[30] ^= 0xff
  assert.equal(unpackEncryptedFrame(forged, rx), null, 'forged seq=999999 rejected')
  assert.equal(recv(11), 'msg-11', 'legit seq=11 unaffected by the forgery attempt')
  // Big legitimate jump moves the window; the far-behind packet is now expired.
  assert.equal(recv(100), 'msg-100')
  assert.equal(recv(20), null, 'seq=20 is below highest(100)-64')
  // And a duplicate of the new highest is still a replay.
  assert.equal(recv(100), null)
})

test('replay window: first-ever packet with a huge seq does not lock out later small seqs', () => {
  // A dedicated session so no earlier window state interferes: if the very
  // first AUTHENTICATED packet were seq=999999, that becomes the baseline —
  // but a FORGED one must leave the baseline untouched (same guarantee as
  // above, exercised from the pristine state).
  const session = freshPeerSession('1234567890abcdef')
  const tx = session.ciphersA
  const rx = session.ciphersB
  const forgeAt = (seq) => {
    const f = Buffer.from(packEncryptedFrame(
      ROUTING_HEADER({ srcNodeId: session.A.nodeId, dstNodeId: session.B.nodeId, seq }),
      Buffer.from('evil'),
      tx,
    ))
    f[30] ^= 0xff
    return f
  }
  assert.equal(unpackEncryptedFrame(forgeAt(999999n), rx), null)
  assert.equal(unpackEncryptedFrame(forgeAt(500n), rx), null)
  const legit = unpackEncryptedFrame(packEncryptedFrame(
    ROUTING_HEADER({ srcNodeId: session.A.nodeId, dstNodeId: session.B.nodeId, seq: 0n }),
    Buffer.from('first'),
    tx,
  ), rx)
  assert.ok(legit, 'pristine window still accepts legit seq=0 after forgeries')
  assert.equal(Buffer.from(legit.plaintext).toString(), 'first')
})

test('dual-simplex interop: A→B and B→A both round-trip through sealed frames', () => {
  const session = freshPeerSession()
  const ab = packEncryptedFrame(
    ROUTING_HEADER({ srcNodeId: session.A.nodeId, dstNodeId: session.B.nodeId, seq: 0n }),
    Buffer.from('from A'),
    session.ciphersA,
  )
  const atB = unpackEncryptedFrame(ab, session.ciphersB)
  assert.ok(atB)
  assert.equal(Buffer.from(atB.plaintext).toString(), 'from A')
  const ba = packEncryptedFrame(
    ROUTING_HEADER({ srcNodeId: session.B.nodeId, dstNodeId: session.A.nodeId, seq: 0n, ack: 1 }),
    Buffer.from('from B'),
    session.ciphersB,
  )
  const atA = unpackEncryptedFrame(ba, session.ciphersA)
  assert.ok(atA)
  assert.equal(Buffer.from(atA.plaintext).toString(), 'from B')
  assert.equal(atA.header.srcNodeId, session.B.nodeId)
})

test('parseGatewayJoinInput & buildKeylessInviteUri: supports gateway addresses and plain-HTTP public hosts', () => {
  const invite = parseGatewayJoinInput('zr-net://192.168.1.10:19393/0123456789abcdef#secret')
  assert.equal(invite?.kind, 'invite')

  const httpPub = parseGatewayJoinInput('http://203.0.113.10:19393/')
  assert.deepEqual(httpPub, {
    kind: 'gateway',
    rawHost: '203.0.113.10',
    hostname: '203.0.113.10',
    port: 19393,
    schemeMode: 'http',
  })

  // Plain-HTTP on a public IP MUST synthesize zr-net+insecure:// so parseInviteUri uses ws:// rather than wss://.
  const pubKeyless = buildKeylessInviteUri({
    rawHost: '203.0.113.10',
    hostname: '203.0.113.10',
    port: 19393,
    tls: false,
    networkId: '0123456789abcdef',
  })
  assert.equal(pubKeyless, 'zr-net+insecure://203.0.113.10:19393/0123456789abcdef')
  const roundTripped = parseInviteUri(pubKeyless)
  assert.equal(roundTripped?.wsUrl, 'ws://203.0.113.10:19393')
  assert.equal(roundTripped?.joinKey, undefined)

  // HTTPS without explicit port defaults to 443, optionally carrying /<16-hex>.
  const httpsDom = parseGatewayJoinInput('https://zr.example.com/ABCDEF0123456789#')
  assert.deepEqual(httpsDom, {
    kind: 'gateway',
    rawHost: 'zr.example.com',
    hostname: 'zr.example.com',
    port: 443,
    schemeMode: 'https',
    networkId: 'abcdef0123456789',
  })

  // Bare host defaults to port 19393 and auto schemeMode.
  const bare = parseGatewayJoinInput('192.168.1.50')
  assert.deepEqual(bare, {
    kind: 'gateway',
    rawHost: '192.168.1.50',
    hostname: '192.168.1.50',
    port: 19393,
    schemeMode: 'auto',
  })

  // Malformed paths / schemes are rejected.
  for (const bad of ['', '   ', 'http://gw.example.com/not-a-net-id', 'ftp://gw.example.com', 'zr-net://gw/bad']) {
    assert.equal(parseGatewayJoinInput(bad), null, `should reject ${bad}`)
  }
})
