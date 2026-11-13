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
  PEER_PUNCH_V1_DOMAIN,
  PEER_HS_ZERO_EPH_PUB,
  peerPunchV1Message,
  buildPeerHandshakeEnvelope,
  parsePeerHandshakeEnvelope,
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

test('Electron BoringSSL AEAD compatibility: session seal/open uses aes-256-gcm (BoringSSL lacks chacha20-poly1305)', () => {
  const crypto = require('node:crypto')
  const session = freshPeerSession()
  const plaintext = Buffer.from('boringssl-safe-frame', 'utf8')
  const frame = packEncryptedFrame(
    ROUTING_HEADER({
      srcNodeId: session.A.nodeId,
      dstNodeId: session.B.nodeId,
      seq: 7n,
    }),
    plaintext,
    session.ciphersA,
  )
  const header = frame.subarray(0, PEER_HEADER_BYTES)
  const sealed = frame.subarray(PEER_HEADER_BYTES)

  // Must match native aes-256-gcm (present in both Node OpenSSL and Electron BoringSSL,
  // whereas chacha20-poly1305 throws ERR_CRYPTO_UNKNOWN_CIPHER under Electron 44 BoringSSL).
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64BE(7n, 4)
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(session.ciphersA.txKeyHex, 'hex'), nonce, { authTagLength: 16 })
  decipher.setAAD(Buffer.from(header))
  decipher.setAuthTag(Buffer.from(sealed.subarray(sealed.byteLength - 16)))
  const openedByAesGcm = Buffer.concat([
    decipher.update(Buffer.from(sealed.subarray(0, sealed.byteLength - 16))),
    decipher.final(),
  ])
  assert.deepEqual(openedByAesGcm, plaintext)
})

// -- 7. handshake envelope contract: dual-signature transition (PC-12) -----------
//
// PC-12 用户裁定（tasks/peer-gateway/completion/PC-12-implementation.md）：
//   - 双签名过渡：新端一律发 dual 信封（v1 旧串逐字节兼容 + v2 完整绑定）；
//   - UDP 不新增时间窗（timeWindowMs=0），WS 保持 ±30s——差异以路径参数表达；
//   - 只有真正不含新证明字段的旧格式可以走 v1；新证明字段一旦出现必须完整、
//     形状正确且验签通过，否则按正常验证失败处理，绝不回退 v1；
//   - 单独 hs 声明不作为可信能力依据，不把不完整新信封当旧端。
//
// 全部为正常契约/兼容用例；旧端信封用文件内冻结的 v1 模板现签构造（等价旧端
// 发送方），不构造任何攻击场景。

const { sign: edSign, verify: edVerify } = require('node:crypto')

/** 冻结的旧端签名配方（与已发布 lib/peer/punch.js 的 ed25519Sign 逐字节一致）。 */
function legacySign(message, identity) {
  return edSign(null, message, createPrivateKeyJwk(identity)).toString('hex')
}

function createPrivateKeyJwk(identity) {
  const { createPrivateKey } = require('node:crypto')
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(identity.publicKeyHex, 'hex').toString('base64url'),
      d: Buffer.from(identity.privateKeyHex, 'hex').toString('base64url'),
    },
    format: 'jwk',
  })
}

function createPublicKeyJwk(publicKeyHex) {
  const { createPublicKey } = require('node:crypto')
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyHex, 'hex').toString('base64url') },
    format: 'jwk',
  })
}

/** 冻结的旧端验证配方。 */
function legacyVerify(message, publicKeyHex, sigHex) {
  try {
    return edVerify(null, message, createPublicKeyJwk(publicKeyHex), Buffer.from(sigHex, 'hex'))
  } catch {
    return false
  }
}

/** 冻结的旧端 v1 串模板（PC-12 前 punch.ts/mux.ts 的逐字节线格式）。 */
function legacyV1String(role, networkId, nodeId, ephPubHex, nonce, timestamp) {
  return `zr-punch-v1|${role}|${networkId}|${nodeId}|${ephPubHex}|${nonce}|${timestamp}`
}

/** 确定性地改写十六进制串首字节（异或 1）——与原值必然不同，夹具不受随机前缀影响。 */
function corruptFirstHexByte(hex) {
  return (parseInt(hex[0], 16) ^ 1).toString(16) + hex.slice(1)
}

/** 按已发布代码的字段表手工构造一个纯 v1 信封（旧端发送方模拟）。 */
function legacyEnvelope({ kind, networkId, identity, ephPubHex, nonce, timestamp }) {
  const role = kind === 'zr-hello' ? 'hello' : 'ack'
  const message = Buffer.from(legacyV1String(role, networkId, identity.nodeId, ephPubHex, nonce, timestamp), 'utf8')
  return Buffer.from(JSON.stringify({
    zr: 1,
    kind,
    networkId,
    nodeId: identity.nodeId,
    publicKeyHex: identity.publicKeyHex,
    ephPubHex,
    nonce,
    timestamp,
    sigHex: legacySign(message, identity),
  }), 'utf8')
}

const ENV = (() => {
  const A = generatePeerIdentity()
  const B = generatePeerIdentity()
  const C = generatePeerIdentity()
  const aEph = generateEphemeralX25519()
  const bEph = generateEphemeralX25519()
  const networkId = 'a1b2c3d4e5f60718'
  const nonce = 'aabbccdd00112233'
  const timestamp = 1_700_000_000_000
  return { A, B, C, aEph, bEph, networkId, nonce, timestamp, ZERO: '0'.repeat(64) }
})();

function parseAs(bytes, selfNodeId, { nowMs = ENV.timestamp, timeWindowMs = 30_000, networkId = ENV.networkId } = {}) {
  return parsePeerHandshakeEnvelope(bytes, { networkId, selfNodeId, nowMs, timeWindowMs })
}

test('PC-12: v1 domain constant and legacy message builder are byte-exact with the frozen wire format', () => {
  assert.equal(PEER_PUNCH_V1_DOMAIN, 'zr-punch-v1')
  assert.equal(PEER_HS_ZERO_EPH_PUB, '0'.repeat(64))
  const helloMsg = peerPunchV1Message({
    role: 'hello', networkId: ENV.networkId, nodeId: ENV.A.nodeId,
    ephPubHex: ENV.aEph.publicKeyHex, nonce: ENV.nonce, timestamp: ENV.timestamp,
  })
  assert.equal(
    helloMsg.toString('utf8'),
    legacyV1String('hello', ENV.networkId, ENV.A.nodeId, ENV.aEph.publicKeyHex, ENV.nonce, ENV.timestamp),
    'hello v1 string matches the frozen template byte for byte',
  )
  const ackMsg = peerPunchV1Message({
    role: 'ack', networkId: ENV.networkId, nodeId: ENV.B.nodeId,
    ephPubHex: ENV.bEph.publicKeyHex, nonce: ENV.nonce, timestamp: ENV.timestamp,
  })
  assert.equal(
    ackMsg.toString('utf8'),
    legacyV1String('ack', ENV.networkId, ENV.B.nodeId, ENV.bEph.publicKeyHex, ENV.nonce, ENV.timestamp),
    'ack v1 string matches the frozen template byte for byte',
  )
  // A signature produced by the FROZEN legacy recipe verifies over the shared builder's message.
  assert.equal(
    legacyVerify(helloMsg, ENV.A.publicKeyHex, legacySign(helloMsg, ENV.A)),
    true,
    'legacy-signed hello verifies over the shared v1 message',
  )
})

test('PC-12 build: dual HELLO keeps the legacy v1 fields/signature byte-compatible and adds the full-binding proof', () => {
  const bytes = buildPeerHandshakeEnvelope({
    kind: 'hello',
    networkId: ENV.networkId,
    identity: ENV.A,
    selfEphPubHex: ENV.aEph.publicKeyHex,
    peerNodeId: ENV.B.nodeId,
    peerEphPubHex: null,
    nonce: ENV.nonce,
    timestamp: ENV.timestamp,
  })
  const hello = JSON.parse(bytes.toString('utf8'))
  // Legacy fields keep their published values (old receivers read exactly these).
  assert.equal(hello.zr, 1)
  assert.equal(hello.kind, 'zr-hello')
  assert.equal(hello.networkId, ENV.networkId)
  assert.equal(hello.nodeId, ENV.A.nodeId)
  assert.equal(hello.publicKeyHex, ENV.A.publicKeyHex)
  assert.equal(hello.ephPubHex, ENV.aEph.publicKeyHex)
  assert.equal(hello.nonce, ENV.nonce)
  assert.equal(hello.timestamp, ENV.timestamp)
  // New fields: informational marker + named recipient + explicit unknown-eph placeholder + v2 proof.
  assert.equal(hello.hs, 2)
  assert.equal(hello.peerNodeId, ENV.B.nodeId)
  assert.equal(hello.peerEphPubHex, PEER_HS_ZERO_EPH_PUB, 'HELLO carries the explicit zero placeholder')
  assert.ok(looksLikeHex(hello.sigHex, 128))
  assert.ok(looksLikeHex(hello.sig2Hex, 128))
  // sigHex verifies over the FROZEN legacy string — old endpoints accept the envelope unchanged.
  const legacyMessage = Buffer.from(
    legacyV1String('hello', ENV.networkId, ENV.A.nodeId, ENV.aEph.publicKeyHex, ENV.nonce, ENV.timestamp),
    'utf8',
  )
  assert.equal(legacyVerify(legacyMessage, ENV.A.publicKeyHex, hello.sigHex), true, 'sigHex is the legacy v1 signature')
  // sig2Hex is the v2 full-binding signature with the zero placeholder in dstEph.
  assert.equal(
    verifyPeerHandshake({
      role: 'hello', identityPublicKeyHex: ENV.A.publicKeyHex,
      networkId: ENV.networkId, srcNodeId: ENV.A.nodeId, dstNodeId: ENV.B.nodeId,
      srcEphPubHex: ENV.aEph.publicKeyHex, dstEphPubHex: PEER_HS_ZERO_EPH_PUB, timestamp: ENV.timestamp,
      signatureHex: hello.sig2Hex,
    }),
    true,
    'sig2Hex is the v2 full-binding signature',
  )
  // A HELLO cannot pretend the peer ephemeral is known.
  assert.throws(() => buildPeerHandshakeEnvelope({
    kind: 'hello',
    networkId: ENV.networkId,
    identity: ENV.A,
    selfEphPubHex: ENV.aEph.publicKeyHex,
    peerNodeId: ENV.B.nodeId,
    peerEphPubHex: ENV.bEph.publicKeyHex,
    nonce: ENV.nonce,
    timestamp: ENV.timestamp,
  }), TypeError)
})

test('PC-12 build: dual ACK binds both node ids, both ephemerals and the echoed nonce', () => {
  const bytes = buildPeerHandshakeEnvelope({
    kind: 'ack',
    networkId: ENV.networkId,
    identity: ENV.B,
    selfEphPubHex: ENV.bEph.publicKeyHex,
    peerNodeId: ENV.A.nodeId,
    peerEphPubHex: ENV.aEph.publicKeyHex,
    nonce: ENV.nonce,
    timestamp: ENV.timestamp,
  })
  const ack = JSON.parse(bytes.toString('utf8'))
  assert.equal(ack.kind, 'zr-hello-ack')
  assert.equal(ack.nodeId, ENV.B.nodeId)
  assert.equal(ack.peerNodeId, ENV.A.nodeId)
  assert.equal(ack.peerEphPubHex, ENV.aEph.publicKeyHex, 'ACK binds the answered HELLO ephemeral verbatim')
  assert.equal(ack.nonce, ENV.nonce, 'ACK echoes the answered HELLO nonce (v1 semantics)')
  // Legacy receivers verify sigHex over the frozen ack string with the echoed nonce.
  const legacyMessage = Buffer.from(
    legacyV1String('ack', ENV.networkId, ENV.B.nodeId, ENV.bEph.publicKeyHex, ENV.nonce, ENV.timestamp),
    'utf8',
  )
  assert.equal(legacyVerify(legacyMessage, ENV.B.publicKeyHex, ack.sigHex), true)
  assert.equal(
    verifyPeerHandshake({
      role: 'ack', identityPublicKeyHex: ENV.B.publicKeyHex,
      networkId: ENV.networkId, srcNodeId: ENV.B.nodeId, dstNodeId: ENV.A.nodeId,
      srcEphPubHex: ENV.bEph.publicKeyHex, dstEphPubHex: ENV.aEph.publicKeyHex, timestamp: ENV.timestamp,
      signatureHex: ack.sig2Hex,
    }),
    true,
  )
  // An ACK must bind a real ephemeral — null and the zero placeholder are both rejected.
  assert.throws(() => buildPeerHandshakeEnvelope({
    kind: 'ack', networkId: ENV.networkId, identity: ENV.B, selfEphPubHex: ENV.bEph.publicKeyHex,
    peerNodeId: ENV.A.nodeId, peerEphPubHex: null, nonce: ENV.nonce, timestamp: ENV.timestamp,
  }), TypeError)
  assert.throws(() => buildPeerHandshakeEnvelope({
    kind: 'ack', networkId: ENV.networkId, identity: ENV.B, selfEphPubHex: ENV.bEph.publicKeyHex,
    peerNodeId: ENV.A.nodeId, peerEphPubHex: PEER_HS_ZERO_EPH_PUB, nonce: ENV.nonce, timestamp: ENV.timestamp,
  }), TypeError)
})

test('PC-12 four quadrants: new→new classifies v2 on both sides; legacy envelopes classify v1', () => {
  // 新→新：A 的 dual HELLO 在 B 侧分类 v2；B 的 dual ACK 在 A 侧分类 v2 且回绑 A 的当前 eph。
  const helloBytes = buildPeerHandshakeEnvelope({
    kind: 'hello', networkId: ENV.networkId, identity: ENV.A, selfEphPubHex: ENV.aEph.publicKeyHex,
    peerNodeId: ENV.B.nodeId, peerEphPubHex: null, nonce: ENV.nonce, timestamp: ENV.timestamp,
  })
  const parsedHello = parseAs(helloBytes, ENV.B.nodeId)
  assert.ok(parsedHello, 'B accepts the dual HELLO')
  assert.equal(parsedHello.contract, 'v2')
  assert.equal(parsedHello.kind, 'hello')
  assert.equal(parsedHello.nodeId, ENV.A.nodeId)
  assert.equal(parsedHello.ephPubHex, ENV.aEph.publicKeyHex)
  assert.equal(parsedHello.peerNodeId, ENV.B.nodeId)
  assert.equal(parsedHello.peerEphPubHex, PEER_HS_ZERO_EPH_PUB)

  const ackBytes = buildPeerHandshakeEnvelope({
    kind: 'ack', networkId: ENV.networkId, identity: ENV.B, selfEphPubHex: ENV.bEph.publicKeyHex,
    peerNodeId: ENV.A.nodeId, peerEphPubHex: parsedHello.ephPubHex, nonce: parsedHello.nonce, timestamp: ENV.timestamp,
  })
  const parsedAck = parseAs(ackBytes, ENV.A.nodeId)
  assert.ok(parsedAck, 'A accepts the dual ACK')
  assert.equal(parsedAck.contract, 'v2')
  assert.equal(parsedAck.kind, 'ack')
  assert.equal(parsedAck.nodeId, ENV.B.nodeId)
  assert.equal(parsedAck.peerNodeId, ENV.A.nodeId)
  assert.equal(parsedAck.peerEphPubHex, ENV.aEph.publicKeyHex, 'ACK v2 binds the initiator current ephemeral')

  // 旧→新：纯 v1 HELLO/ACK（冻结模板现签）在新端分类 v1，互通通道保持。
  const legacyHello = legacyEnvelope({
    kind: 'zr-hello', networkId: ENV.networkId, identity: ENV.C,
    ephPubHex: ENV.aEph.publicKeyHex, nonce: ENV.nonce, timestamp: ENV.timestamp,
  })
  const parsedLegacyHello = parseAs(legacyHello, ENV.B.nodeId)
  assert.ok(parsedLegacyHello, 'legacy HELLO accepted')
  assert.equal(parsedLegacyHello.contract, 'v1', 'genuinely old format goes v1')
  assert.equal(parsedLegacyHello.nodeId, ENV.C.nodeId)
  assert.equal(parsedLegacyHello.peerNodeId, null, 'v1 result carries no v2 binding fields')
  assert.equal(parsedLegacyHello.peerEphPubHex, null)

  const legacyAck = legacyEnvelope({
    kind: 'zr-hello-ack', networkId: ENV.networkId, identity: ENV.B,
    ephPubHex: ENV.bEph.publicKeyHex, nonce: ENV.nonce, timestamp: ENV.timestamp,
  })
  const parsedLegacyAck = parseAs(legacyAck, ENV.A.nodeId)
  assert.ok(parsedLegacyAck)
  assert.equal(parsedLegacyAck.contract, 'v1', 'legacy-only ACK (new→old link) classifies v1 — no full-binding claim')
  assert.equal(parsedLegacyAck.peerEphPubHex, null)

  // 新→旧方向的反向验证：dual 信封的 v1 半部被旧配方原样接受（字节兼容）。
  const dualHelloJson = JSON.parse(helloBytes.toString('utf8'))
  assert.equal(
    legacyVerify(
      Buffer.from(legacyV1String('hello', ENV.networkId, ENV.A.nodeId, ENV.aEph.publicKeyHex, ENV.nonce, ENV.timestamp), 'utf8'),
      ENV.A.publicKeyHex,
      dualHelloJson.sigHex,
    ),
    true,
    'old receiver-side recipe verifies the dual HELLO v1 half',
  )
  // HELLO 指名他人（peerNodeId ≠ 本机）时本机不采信为 v2。
  assert.equal(parseAs(helloBytes, ENV.C.nodeId), null, 'HELLO addressed to another node is not accepted as v2 here')
})

test('PC-12 no-fallback: present-but-invalid new proof fails verification, never downgrades to v1', () => {
  const dualHello = buildPeerHandshakeEnvelope({
    kind: 'hello', networkId: ENV.networkId, identity: ENV.A, selfEphPubHex: ENV.aEph.publicKeyHex,
    peerNodeId: ENV.B.nodeId, peerEphPubHex: null, nonce: ENV.nonce, timestamp: ENV.timestamp,
  })
  const mutate = (over) => {
    const obj = JSON.parse(dualHello.toString('utf8'))
    return Buffer.from(JSON.stringify({ ...obj, ...over }), 'utf8')
  }
  // sig2 验签失败 → 正常验证失败（null），不是 v1。
  const helloObj = JSON.parse(dualHello.toString('utf8'))
  const badSig2 = mutate({ sig2Hex: corruptFirstHexByte(helloObj.sig2Hex) })
  const parsed = parseAs(badSig2, ENV.B.nodeId)
  assert.equal(parsed, null, 'invalid sig2Hex is a verification failure, not a v1 downgrade')
  // 不完整新信封（hs 在场、证明缺席）不当旧端。
  assert.equal(parseAs(mutate({ sig2Hex: undefined }), ENV.B.nodeId), null, 'hs-only envelope is not treated as a legacy peer')
  // 任何新字段在场但证明不完整 → null。
  const partial = JSON.parse(dualHello.toString('utf8'))
  const legacyShaped = Buffer.from(JSON.stringify({
    zr: 1, kind: 'zr-hello', networkId: ENV.networkId, nodeId: ENV.A.nodeId,
    publicKeyHex: ENV.A.publicKeyHex, ephPubHex: ENV.aEph.publicKeyHex,
    peerNodeId: ENV.B.nodeId, peerEphPubHex: PEER_HS_ZERO_EPH_PUB,
    nonce: ENV.nonce, timestamp: ENV.timestamp, sigHex: partial.sigHex,
  }), 'utf8')
  assert.equal(parseAs(legacyShaped, ENV.B.nodeId), null, 'binding fields without the v2 proof fail verification')
  // v2 一致性：HELLO 的 dstEph 必须是零占位；指名对象必须是本机。
  assert.equal(parseAs(mutate({ peerEphPubHex: ENV.bEph.publicKeyHex }), ENV.B.nodeId), null, 'HELLO claiming a known peer eph is not v2')
  assert.equal(parseAs(mutate({ peerNodeId: ENV.C.nodeId }), ENV.B.nodeId), null, 'HELLO addressed elsewhere is not v2')
  // ACK 同规则：零占位/证明缺失都失败。
  const dualAck = buildPeerHandshakeEnvelope({
    kind: 'ack', networkId: ENV.networkId, identity: ENV.B, selfEphPubHex: ENV.bEph.publicKeyHex,
    peerNodeId: ENV.A.nodeId, peerEphPubHex: ENV.aEph.publicKeyHex, nonce: ENV.nonce, timestamp: ENV.timestamp,
  })
  const ackObj = JSON.parse(dualAck.toString('utf8'))
  assert.equal(parseAs(Buffer.from(JSON.stringify({ ...ackObj, peerEphPubHex: PEER_HS_ZERO_EPH_PUB }), 'utf8'), ENV.A.nodeId), null, 'ACK with the zero placeholder is not v2')
  const ackNoSig2 = { ...ackObj }
  delete ackNoSig2.sig2Hex
  assert.equal(parseAs(Buffer.from(JSON.stringify(ackNoSig2), 'utf8'), ENV.A.nodeId), null, 'ACK without the v2 proof fails, not v1')
  // 新证明字段在场时，动了任何一个被绑定字段，两种签名都失效 → null（同一份解析结果）。
  assert.equal(parseAs(mutate({ timestamp: ENV.timestamp + 1 }), ENV.B.nodeId), null, 'timestamp change breaks both signatures')
  assert.equal(parseAs(mutate({ ephPubHex: ENV.bEph.publicKeyHex }), ENV.B.nodeId), null, 'eph swap breaks both signatures')
  // 纯 v1 信封签名坏 → null（v1 必要条件）。
  const legacyHello = JSON.parse(legacyEnvelope({
    kind: 'zr-hello', networkId: ENV.networkId, identity: ENV.A,
    ephPubHex: ENV.aEph.publicKeyHex, nonce: ENV.nonce, timestamp: ENV.timestamp,
  }).toString('utf8'))
  const badLegacySig = Buffer.from(JSON.stringify({ ...legacyHello, sigHex: corruptFirstHexByte(legacyHello.sigHex) }), 'utf8')
  assert.equal(parseAs(badLegacySig, ENV.B.nodeId), null, 'broken v1 signature fails verification')
})

test('PC-12 time window: WS keeps ±30s via the path parameter, UDP keeps no window (0)', () => {
  const helloBytes = buildPeerHandshakeEnvelope({
    kind: 'hello', networkId: ENV.networkId, identity: ENV.A, selfEphPubHex: ENV.aEph.publicKeyHex,
    peerNodeId: ENV.B.nodeId, peerEphPubHex: null, nonce: ENV.nonce, timestamp: ENV.timestamp,
  })
  // WS 政策（±30s，既有数值不变）。
  assert.ok(parseAs(helloBytes, ENV.B.nodeId, { nowMs: ENV.timestamp - 29_000 }), '29s old is inside the WS window')
  assert.ok(parseAs(helloBytes, ENV.B.nodeId, { nowMs: ENV.timestamp + 29_000 }), '29s ahead is inside the WS window')
  assert.equal(parseAs(helloBytes, ENV.B.nodeId, { nowMs: ENV.timestamp - 31_000 }), null, '31s old is outside the WS window')
  assert.equal(parseAs(helloBytes, ENV.B.nodeId, { nowMs: ENV.timestamp + 31_000 }), null, '31s ahead is outside the WS window')
  // UDP 政策（用户裁定：不新增时间窗；timestamp 只进签名，不做新鲜度检查）。
  assert.ok(
    parseAs(helloBytes, ENV.B.nodeId, { nowMs: ENV.timestamp + 10 * 60_000, timeWindowMs: 0 }),
    'UDP path (timeWindowMs=0) accepts aged-but-signed envelopes exactly like today',
  )
  // 纯 v1 信封在 WS 窗外同样被拒（既有 WS 行为）。
  const legacyHello = legacyEnvelope({
    kind: 'zr-hello', networkId: ENV.networkId, identity: ENV.C,
    ephPubHex: ENV.aEph.publicKeyHex, nonce: ENV.nonce, timestamp: ENV.timestamp,
  })
  assert.equal(parseAs(legacyHello, ENV.B.nodeId, { nowMs: ENV.timestamp - 31_000 }), null)
  assert.ok(parseAs(legacyHello, ENV.B.nodeId, { nowMs: ENV.timestamp + 10 * 60_000, timeWindowMs: 0 }))
})

test('PC-12 parse: malformed input returns null and never throws; WS zero-padding is stripped', () => {
  const good = buildPeerHandshakeEnvelope({
    kind: 'hello', networkId: ENV.networkId, identity: ENV.A, selfEphPubHex: ENV.aEph.publicKeyHex,
    peerNodeId: ENV.B.nodeId, peerEphPubHex: null, nonce: ENV.nonce, timestamp: ENV.timestamp,
  })
  // 网关中转的信封帧补零到最小帧长——接收侧剥尾零后必须等价。
  const padded = Buffer.concat([good, Buffer.alloc(20)])
  const unpadded = parseAs(good, ENV.B.nodeId)
  assert.deepEqual(parseAs(padded, ENV.B.nodeId), unpadded)
  // 形形色色的坏输入：null、不抛。
  assert.equal(parseAs(Buffer.alloc(0), ENV.B.nodeId), null)
  assert.equal(parseAs(Buffer.from('not json at all', 'utf8'), ENV.B.nodeId), null)
  assert.equal(parseAs(Buffer.from('[]', 'utf8'), ENV.B.nodeId), null)
  assert.equal(parseAs(Buffer.from('"a string"', 'utf8'), ENV.B.nodeId), null)
  assert.equal(parseAs(Buffer.from('null', 'utf8'), ENV.B.nodeId), null)
  assert.equal(parseAs(Buffer.from(JSON.stringify({ zr: 1, kind: 'zr-hello' }), 'utf8'), ENV.B.nodeId), null, 'missing fields')
  assert.equal(parseAs(Buffer.from(JSON.stringify({ zr: 2, kind: 'zr-hello' }), 'utf8'), ENV.B.nodeId), null, 'wrong protocol marker')
  assert.equal(parseAs(good, ENV.A.nodeId), null, 'self-sourced envelope dropped (nodeId === selfNodeId)')
  assert.equal(parseAs(good, ENV.B.nodeId, { networkId: '0000000000000000' }), null, 'cross-network envelope dropped')
})

test('PC-12 size: a real dual ACK measures inside the 1200B gateway frame budget with margin', () => {
  // 用真实生成的身份与临时钥按正常编码测量（不是估算）。
  const bytes = buildPeerHandshakeEnvelope({
    kind: 'ack', networkId: ENV.networkId, identity: ENV.B, selfEphPubHex: ENV.bEph.publicKeyHex,
    peerNodeId: ENV.A.nodeId, peerEphPubHex: ENV.aEph.publicKeyHex, nonce: ENV.nonce, timestamp: ENV.timestamp,
  })
  const helloBytes = buildPeerHandshakeEnvelope({
    kind: 'hello', networkId: ENV.networkId, identity: ENV.A, selfEphPubHex: ENV.aEph.publicKeyHex,
    peerNodeId: ENV.B.nodeId, peerEphPubHex: null, nonce: ENV.nonce, timestamp: ENV.timestamp,
  })
  // 网关真正的约束是 1200B 整帧（28B 路由头 + 载荷，超长整帧被当垃圾丢弃），
  // 不是 WS 的 64KB 上限。
  assert.ok(bytes.length + 28 <= 1200, `dual ACK (${bytes.length}B) + 28B header fits the 1200B frame budget`)
  assert.ok(bytes.length <= 900, `dual ACK measures ${bytes.length}B — ≥272B headroom under the 1172B payload budget`)
  assert.ok(helloBytes.length <= bytes.length, 'HELLO is no larger than ACK')
})
