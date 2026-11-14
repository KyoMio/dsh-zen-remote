/* dsh-zen-remote · peer-gateway PG-7 (tasks/peer-gateway/PG-7.md)
 *
 * src/peer/punch.ts — UDP path establishment for the peer network:
 *   - collectLanEndpoints(): non-loopback IPv4 (RFC1918 + CGNAT 100.64/10)
 *     interfaces formatted as `ip:port` candidates;
 *   - probeStunNatType(): ONE local socket probes the gateway's primary
 *     and (optional) alternate UDP ports with a signed `zr-stun-probe`
 *     JSON packet; matching `stun-reply` reflexive ports classify as
 *     public/cone, differing ports as symmetric, missing replies as
 *     unknown;
 *   - PeerPunchManager: per-peer 1000ms priority hole punch — signed
 *     HELLO bursts every 100ms (≤10 rounds) to every candidate endpoint,
 *     X25519 + Ed25519 handshake into PeerSessionCiphers, LAN/P2P path
 *     classification with RTT, onPunchFallback at exactly 1000ms, silent
 *     60s reprobe that hot-upgrades to direct later, 5s encrypted
 *     PING/PONG keepalive with lost-direct detection 15s after the last
 *     authenticated receive (3 silent cycles, decoupled from the PING
 *     tick), and close() that clears every timer and socket handle.
 *
 * Everything here drives the BUILT lib/peer/punch.js like every other
 * wiring test in this repo. The punch tests run REAL loopback UDP
 * sockets against each other; only the state-machine clocks are
 * injected so timing assertions stay deterministic.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } = require('node:crypto')

const {
  probeStunNatType,
  PeerPunchManager,
  collectLanEndpoints,
  classifyPunchEndpoint,
} = require('../lib/peer/punch.js')
const { generatePeerIdentity, buildPeerHandshakeEnvelope } = require('../lib/peer/crypto.js')
const { PeerFrameType } = require('../lib/peer/wire.js')
const { PeerArqSession } = require('../lib/peer/arq.js')

const NET_ID = 'a1b2c3d4e5f60718'

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

async function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} within ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function openSocket(host = '127.0.0.1', port = 0) {
  const socket = dgram.createSocket('udp4')
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err)
    socket.once('error', onError)
    socket.bind({ port, address: host }, () => {
      socket.removeListener('error', onError)
      resolve()
    })
  })
  return socket
}

function waitClose(socket) {
  return new Promise((resolve) => socket.once('close', resolve))
}

function endpointOf(socket) {
  const address = socket.address()
  return `${address.address}:${address.port}`
}

function ed25519PublicFromRaw(publicKeyHex) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyHex, 'hex').toString('base64url') },
    format: 'jwk',
  })
}

function ed25519PrivateFromRaw(identity) {
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

function ed25519VerifyHex(message, publicKeyHex, sigHex) {
  return verify(null, message, ed25519PublicFromRaw(publicKeyHex), Buffer.from(sigHex, 'hex'))
}

function ed25519SignHex(message, identity) {
  return sign(null, message, ed25519PrivateFromRaw(identity)).toString('hex')
}

/** Manager on a real loopback UDP socket with an injected state-machine clock. */
async function makeManager(identity, clock, hooks = {}, port = 0) {
  const socket = await openSocket('127.0.0.1', port)
  const mgr = new PeerPunchManager({ networkId: NET_ID, identity, socket, clock, ...hooks })
  await mgr.ready()
  return { mgr, socket }
}

/**
 * Two managers punching each other over real loopback UDP. A initiates;
 * B answers passively. Returns both managers plus the recorded events.
 * `clockFactory` defaults to the manual clock; pass `() => undefined` to
 * exercise the production `realClock` timer path (PC-04 real-process tests).
 */
async function establishPair(hooksA = {}, hooksB = {}, clockFactory = manualClock) {
  const A = generatePeerIdentity()
  const B = generatePeerIdentity()
  const clockA = clockFactory()
  const clockB = clockFactory()
  const events = { aReady: [], bReady: [], aFallback: 0, bFallback: 0, aLost: [], bLost: [] }
  const aReadyDefer = defer()
  const bReadyDefer = defer()
  const { mgr: mgrA, socket: sockA } = await makeManager(A, clockA, {
    onDirectReady: (id, info) => {
      events.aReady.push({ id, info, at: Date.now() })
      aReadyDefer.resolve({ id, info })
    },
    onPunchFallback: () => { events.aFallback += 1 },
    onDirectLost: (id) => { events.aLost.push({ id, at: Date.now() }) },
    ...hooksA,
  })
  const { mgr: mgrB, socket: sockB } = await makeManager(B, clockB, {
    onDirectReady: (id, info) => {
      events.bReady.push({ id, info, at: Date.now() })
      bReadyDefer.resolve({ id, info })
    },
    onPunchFallback: () => { events.bFallback += 1 },
    onDirectLost: (id) => { events.bLost.push({ id, at: Date.now() }) },
    ...hooksB,
  })
  mgrB.beginPunch({ peerNodeId: A.nodeId, peerPublicKeyHex: A.publicKeyHex, lanEndpoints: [] })
  mgrA.beginPunch({
    peerNodeId: B.nodeId,
    peerPublicKeyHex: B.publicKeyHex,
    lanEndpoints: [endpointOf(sockB)],
    reflexiveEndpoint: null,
  })
  const aReady = await withTimeout(aReadyDefer.promise, 1000, 'A onDirectReady')
  const bReady = await withTimeout(bReadyDefer.promise, 1000, 'B onDirectReady')
  return { A, B, clockA, clockB, mgrA, mgrB, sockA, sockB, events, aReady, bReady }
}

async function closeManager(pair) {
  const closed = waitClose(pair.socket)
  pair.mgr.close()
  await closed
}

/**
 * A scripted STUN gateway speaking the REAL gateway-server wire format
 * (gateway-server/src/peer-hub/udp-stun.ts): request
 * `{type:'stun-probe', …, signatureHex}` signed over
 * `zr-stun-probe-v1|<networkId>|<nodeId>|<nonce>|<timestamp>`, reply
 * `{type:'stun-reply', nonce, reflexiveIp, reflexivePort, serverPortRole}`.
 * The `legacy` flag flips the reply to the pre-PG-8 node shape
 * (`{kind:'zr-stun-reply', ip, port}`) so the node's dual-format reply
 * parsing stays pinned.
 */
async function startFakeStun({ legacy = false, role = 'primary' } = {}) {
  const socket = await openSocket('127.0.0.1')
  const seen = []
  let behavior = (_packet, rinfo) => ({ ip: rinfo.address, port: rinfo.port })
  socket.on('message', (buf, rinfo) => {
    let packet
    try {
      packet = JSON.parse(buf.toString('utf8'))
    } catch {
      return
    }
    let sigOk = false
    try {
      const message = Buffer.from(
        `zr-stun-probe-v1|${packet.networkId}|${packet.nodeId}|${packet.nonce}|${packet.timestamp}`,
        'utf8',
      )
      sigOk = ed25519VerifyHex(message, packet.publicKeyHex, packet.signatureHex)
    } catch {
      sigOk = false
    }
    seen.push({ packet, rinfo, sigOk })
    if (!sigOk) return
    const reply = behavior(packet, rinfo)
    if (!reply) return
    const nonce = reply.nonce ?? packet.nonce
    const out = legacy
      ? Buffer.from(JSON.stringify({ zr: 1, kind: 'zr-stun-reply', nonce, ip: reply.ip, port: reply.port }))
      : Buffer.from(JSON.stringify({
          type: 'stun-reply',
          nonce,
          reflexiveIp: reply.ip,
          reflexivePort: reply.port,
          serverPortRole: role,
        }))
    socket.send(out, rinfo.port, rinfo.address)
  })
  return {
    get port() { return socket.address().port },
    get seen() { return seen },
    set behavior(fn) { behavior = fn },
    async close() {
      socket.close()
      await waitClose(socket)
    },
  }
}

const PROBE_IDENTITY = generatePeerIdentity()

function probeBoth(primary, alt, timeoutMs = 400) {
  return probeStunNatType({
    primaryHost: '127.0.0.1',
    primaryPort: primary.port,
    altPort: alt.port,
    networkId: NET_ID,
    identity: PROBE_IDENTITY,
    timeoutMs,
  })
}

// -- 1. endpoint enumeration + classification --------------------------------------

test('collectLanEndpoints keeps non-loopback IPv4 (RFC1918 + CGNAT + public), drops the rest', () => {
  const interfaces = {
    lo0: [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: '::1', family: 'IPv6', internal: true },
    ],
    en0: [
      { address: '192.168.1.10', family: 'IPv4', internal: false },
      { address: 'fe80::abc', family: 'IPv6', internal: false },
    ],
    utun3: [{ address: '100.64.2.5', family: 'IPv4', internal: false }],
    en1: [{ address: '169.254.9.9', family: 'IPv4', internal: false }],
    en2: [{ address: '203.0.113.5', family: 4, internal: false }], // numeric family accepted too
  }
  assert.deepEqual(collectLanEndpoints(interfaces, 40000), [
    '192.168.1.10:40000',
    '100.64.2.5:40000',
    '203.0.113.5:40000',
  ])
})

test('classifyPunchEndpoint: LAN subnets + loopback + exact local ips → lan, everything else → p2p', () => {
  const localIps = ['192.168.1.10', '100.64.2.5']
  assert.equal(classifyPunchEndpoint('192.168.1.77:1234', localIps), 'lan', 'same /24 RFC1918')
  assert.equal(classifyPunchEndpoint('192.168.9.77:1234', localIps), 'p2p', 'RFC1918 different subnet')
  assert.equal(classifyPunchEndpoint('10.0.0.5:1', ['10.0.0.5']), 'lan', 'exact 10/8 match')
  assert.equal(classifyPunchEndpoint('172.16.5.5:1', ['172.16.5.5']), 'lan', 'exact 172.16/12 match')
  assert.equal(classifyPunchEndpoint('100.64.2.99:1', localIps), 'lan', 'CGNAT same /24 (Tailscale)')
  assert.equal(classifyPunchEndpoint('100.64.99.99:1', localIps), 'p2p', 'CGNAT different subnet')
  assert.equal(classifyPunchEndpoint('127.0.0.1:1', []), 'lan', 'loopback is the most LAN there is')
  assert.equal(classifyPunchEndpoint('8.8.8.8:53', localIps), 'p2p', 'public endpoint')
  assert.equal(classifyPunchEndpoint('203.0.113.9:443', ['203.0.113.9']), 'lan', 'public but exactly our own ip')
  assert.equal(classifyPunchEndpoint('not-an-endpoint', localIps), 'p2p', 'unparseable never classifies as lan')
})

test('manager lanEndpoints(): real interface enumeration carrying the bound port', async () => {
  const identity = generatePeerIdentity()
  const { mgr, socket } = await makeManager(identity, manualClock())
  try {
    const port = socket.address().port
    for (const endpoint of mgr.lanEndpoints()) {
      const match = /^([0-9.]+):(\d+)$/.exec(endpoint)
      assert.ok(match, `endpoint shaped ip:port — got ${endpoint}`)
      assert.ok(!match[1].startsWith('127.'), 'no loopback candidates')
      assert.equal(Number(match[2]), port, 'every candidate carries our bound port')
    }
  } finally {
    await closeManager({ mgr, socket })
  }
})

// -- 2. dual-port STUN self-check ---------------------------------------------------

test('probe: both gateway ports agree + reflexive ip is local → public', async () => {
  const primary = await startFakeStun()
  const alt = await startFakeStun()
  try {
    const result = await probeBoth(primary, alt)
    assert.equal(result.natType, 'public')
    assert.match(result.reflexiveEndpoint, /^127\.0\.0\.1:\d+$/)
    const srcPort = Number(result.reflexiveEndpoint.split(':')[1])
    assert.equal(primary.seen[0].rinfo.port, srcPort, 'primary saw the real source port')
    assert.equal(alt.seen[0].rinfo.port, srcPort, 'same socket → same mapping on the alt port')
    assert.equal(primary.seen[0].sigOk, true, 'probe carried a valid Ed25519 signature')
    assert.equal(primary.seen[0].packet.networkId, NET_ID)
    assert.equal(primary.seen[0].packet.nodeId, PROBE_IDENTITY.nodeId)
  } finally {
    await primary.close()
    await alt.close()
  }
})

test('probe: ports agree but reflexive ip is not local → cone', async () => {
  const primary = await startFakeStun()
  const alt = await startFakeStun()
  primary.behavior = (_packet, rinfo) => ({ ip: '203.0.113.7', port: rinfo.port })
  alt.behavior = (_packet, rinfo) => ({ ip: '203.0.113.7', port: rinfo.port })
  try {
    const result = await probeBoth(primary, alt)
    assert.equal(result.natType, 'cone')
    assert.match(result.reflexiveEndpoint, /^203\.0\.113\.7:\d+$/)
  } finally {
    await primary.close()
    await alt.close()
  }
})

test('probe: primary and alt report different reflexive ports → symmetric', async () => {
  const primary = await startFakeStun()
  const alt = await startFakeStun()
  primary.behavior = (_packet, rinfo) => ({ ip: '198.51.100.9', port: rinfo.port })
  alt.behavior = (_packet, rinfo) => ({ ip: '198.51.100.9', port: rinfo.port + 7 })
  try {
    const result = await probeBoth(primary, alt)
    assert.equal(result.natType, 'symmetric')
    assert.match(result.reflexiveEndpoint, /^198\.51\.100\.9:\d+$/)
    assert.notEqual(
      Number(result.reflexiveEndpoint.split(':')[1]),
      primary.seen[0].rinfo.port + 7,
      'the reported endpoint is the PRIMARY mapping',
    )
  } finally {
    await primary.close()
    await alt.close()
  }
})

test('probe: alt port never answers → unknown, endpoint from the primary', async () => {
  const primary = await startFakeStun()
  const alt = await startFakeStun()
  alt.behavior = () => null
  try {
    const result = await probeBoth(primary, alt, 150)
    assert.deepEqual(result, { reflexiveEndpoint: `127.0.0.1:${primary.seen[0].rinfo.port}`, natType: 'unknown' })
    assert.equal(primary.seen[0].sigOk, true)
  } finally {
    await primary.close()
    await alt.close()
  }
})

test('probe: alt replies with a foreign nonce → ignored, still unknown', async () => {
  const primary = await startFakeStun()
  const alt = await startFakeStun()
  alt.behavior = () => ({ ip: '127.0.0.1', port: 1, nonce: 'ffffffffffffffff' })
  try {
    const result = await probeBoth(primary, alt, 150)
    assert.equal(result.natType, 'unknown')
    assert.ok(result.reflexiveEndpoint.startsWith('127.0.0.1:'))
    assert.equal(alt.seen.length, 1, 'the rogue reply arrived but was not trusted')
  } finally {
    await primary.close()
    await alt.close()
  }
})

test('probe: primary port never answers → null endpoint + unknown', async () => {
  const primary = await startFakeStun()
  const alt = await startFakeStun()
  primary.behavior = () => null
  try {
    const started = Date.now()
    const result = await probeBoth(primary, alt, 200)
    const elapsed = Date.now() - started
    assert.deepEqual(result, { reflexiveEndpoint: null, natType: 'unknown' })
    assert.ok(elapsed >= 180, `waited for the primary timeout (took ${elapsed}ms)`)
    assert.ok(elapsed < 1500, `timeout did not hang (took ${elapsed}ms)`)
  } finally {
    await primary.close()
    await alt.close()
  }
})

test('probe: no altPort configured → primary-only answer classifies as unknown', async () => {
  const primary = await startFakeStun()
  try {
    const result = await probeStunNatType({
      primaryHost: '127.0.0.1',
      primaryPort: primary.port,
      networkId: NET_ID,
      identity: PROBE_IDENTITY,
      timeoutMs: 300,
    })
    assert.equal(result.natType, 'unknown')
    assert.match(result.reflexiveEndpoint, /^127\.0\.0\.1:\d+$/)
  } finally {
    await primary.close()
  }
})

test('probe: malformed arguments throw before any socket work', async () => {
  await assert.rejects(
    () => probeStunNatType({ primaryHost: '', primaryPort: 1, networkId: NET_ID, identity: PROBE_IDENTITY }),
    TypeError,
  )
  await assert.rejects(
    () => probeStunNatType({ primaryHost: '127.0.0.1', primaryPort: 0, networkId: NET_ID, identity: PROBE_IDENTITY }),
    RangeError,
  )
  await assert.rejects(
    () => probeStunNatType({ primaryHost: '127.0.0.1', primaryPort: 1, networkId: 'short', identity: PROBE_IDENTITY }),
    TypeError,
  )
  await assert.rejects(
    () => probeStunNatType({ primaryHost: '127.0.0.1', primaryPort: 1, networkId: NET_ID, identity: { publicKeyHex: 'zz' } }),
    TypeError,
  )
})

test('probe: a REUSED punch socket answers its own port and stays open', async () => {
  const primary = await startFakeStun()
  const socket = await openSocket('127.0.0.1')
  try {
    const result = await probeStunNatType({
      primaryHost: '127.0.0.1',
      primaryPort: primary.port,
      networkId: NET_ID,
      identity: PROBE_IDENTITY,
      socket,
      timeoutMs: 300,
    })
    assert.match(result.reflexiveEndpoint ?? '', new RegExp(`^127\\.0\\.0\\.1:${socket.address().port}$`),
      'the reflexive endpoint must be the REUSED socket\'s own bound port')
    // 单端口探测（无 altPort）本就判不出 NAT 类型：'unknown' 是单端口语义。
    assert.equal(result.natType, 'unknown', 'a single-port probe stays unknown (no alt mapping to compare)')
    // 复用不关闭：socket 仍可用于后续收发（打洞层继续持有）。
    const stillOpen = await new Promise((resolve, reject) => {
      const probe = Buffer.from(JSON.stringify({ ping: 1 }))
      socket.send(probe, primary.port, '127.0.0.1', (err) => resolve(err === null))
      setTimeout(() => resolve(false), 300).unref?.()
    })
    assert.equal(stillOpen, true, 'the reused socket stays open after the probe')
  } finally {
    socket.close()
    await waitClose(socket)
    await primary.close()
  }
})

test('probe: the packet speaks the real gateway-server wire format', async () => {
  const primary = await startFakeStun()
  try {
    await probeBoth(primary, primary, 200)
    const packet = primary.seen[0].packet
    assert.equal(packet.type, 'stun-probe', "the request's type field is 'stun-probe'")
    assert.equal(typeof packet.signatureHex, 'string', 'the signature rides signatureHex (gateway field name)')
    assert.equal(packet.publicKeyHex, PROBE_IDENTITY.publicKeyHex)
    assert.match(packet.nonce, /^[0-9a-f]{16}$/, 'nonce is even-length hex (gateway validator accepts it)')
  } finally {
    await primary.close()
  }
})

test('probe: the legacy {kind:zr-stun-reply, ip, port} reply shape still parses', async () => {
  const primary = await startFakeStun({ legacy: true })
  const alt = await startFakeStun({ legacy: true })
  try {
    const result = await probeBoth(primary, alt)
    assert.equal(result.natType, 'public', 'legacy replies classify identically')
    assert.match(result.reflexiveEndpoint, /^127\.0\.0\.1:\d+$/)
  } finally {
    await primary.close()
    await alt.close()
  }
})

// -- 3. the 1000ms punch state machine on real loopback UDP --------------------------

test('two managers punch through real loopback UDP and derive interop E2EE ciphers < 200ms', async () => {
  const bReceived = defer()
  const pair = await establishPair({}, {
    onEncryptedFrame: (header, plaintext) => bReceived.resolve({ header, plaintext }),
  })
  try {
    const { A, B, mgrA, mgrB, sockB, events, aReady, bReady } = pair
    assert.equal(aReady.id, B.nodeId)
    assert.equal(bReady.id, A.nodeId)
    assert.equal(events.aFallback, 0, 'no fallback on success')
    assert.equal(events.bFallback, 0)
    assert.equal(aReady.info.mode, 'lan', 'loopback classifies as LAN')
    assert.equal(aReady.info.endpoint, endpointOf(sockB))
    assert.equal(typeof aReady.info.rttMs, 'number')
    assert.ok(aReady.info.rttMs >= 0)
    // Self-certifying handshake produced strictly direction-isolated keys.
    const aCiphers = mgrA.sessionCiphers(B.nodeId)
    const bCiphers = mgrB.sessionCiphers(A.nodeId)
    assert.ok(aCiphers, 'A derived session ciphers')
    assert.ok(bCiphers, 'B derived session ciphers (passive side too)')
    assert.equal(aCiphers.txKeyHex, bCiphers.rxKeyHex, 'A tx === B rx')
    assert.equal(aCiphers.rxKeyHex, bCiphers.txKeyHex, 'A rx === B tx')
    // The direct path carries sealed application frames end to end.
    const sender = mgrA.frameSenderFor(B.nodeId)
    sender(PeerFrameType.DATA, 7, Buffer.from('secret payload'), 0)
    const received = await withTimeout(bReceived.promise, 250, 'sealed frame on the direct path')
    assert.equal(Buffer.from(received.plaintext).toString(), 'secret payload')
    assert.equal(received.header.srcNodeId, A.nodeId)
    assert.equal(received.header.streamId, 7)
    // Success cancels the punch window: advancing far past 1000ms fires nothing.
    pair.clockA.advance(10_000)
    assert.equal(events.aFallback, 0, 'window timer was cleared on success')
  } finally {
    await closeManager({ mgr: pair.mgrA, socket: pair.sockA })
    await closeManager({ mgr: pair.mgrB, socket: pair.sockB })
  }
})

test('an ARQ stream rides the punched direct path end to end', async () => {
  let arqA = null
  let arqB = null
  const bParts = []
  const bDone = defer()
  const pair = await establishPair({
    onEncryptedFrame: (header, plaintext) => {
      if (arqA) arqA.handleFrame(header.frameType, header.streamId, plaintext, header.ack)
    },
  }, {
    onEncryptedFrame: (header, plaintext) => {
      if (!arqB) return
      arqB.handleFrame(header.frameType, header.streamId, plaintext, header.ack)
    },
  })
  const { A, B, mgrA, mgrB } = pair
  try {
    arqA = new PeerArqSession({
      sendFrame: mgrA.frameSenderFor(B.nodeId),
      onStreamData: () => {},
    })
    arqB = new PeerArqSession({
      sendFrame: mgrB.frameSenderFor(A.nodeId),
      onStreamData: (_streamId, chunk, final) => {
        bParts.push(Buffer.from(chunk))
        if (final) bDone.resolve(Buffer.concat(bParts))
      },
    })
    const payload = randomBytes(300 * 1024)
    const hash = createHash('sha256').update(payload).digest('hex')
    const send = (async () => {
      for (let offset = 0; offset < payload.length; offset += 16 * 1024) {
        const chunk = payload.subarray(offset, offset + 16 * 1024)
        while (!arqA.tryWrite(1, chunk)) await arqA.waitWritable(1, chunk.length)
      }
      await arqA.finish(1)
    })()
    const [out] = await withTimeout(Promise.all([bDone.promise, send]), 10_000, 'ARQ payload over the direct path')
    assert.equal(out.length, payload.length, 'zero bytes lost over UDP direct')
    assert.equal(createHash('sha256').update(out).digest('hex'), hash, 'SHA-256 identical over the direct path')
  } finally {
    arqA?.closeAll()
    arqB?.closeAll()
    await closeManager({ mgr: pair.mgrA, socket: pair.sockA })
    await closeManager({ mgr: pair.mgrB, socket: pair.sockB })
  }
})

test('punch establishment completes within 200ms wall clock', async () => {
  const A = generatePeerIdentity()
  const B = generatePeerIdentity()
  const ready = defer()
  const { mgr: mgrA, socket: sockA } = await makeManager(A, manualClock(), {
    onDirectReady: (id, info) => ready.resolve({ id, info }),
  })
  const { mgr: mgrB, socket: sockB } = await makeManager(B, manualClock(), {})
  mgrB.beginPunch({ peerNodeId: A.nodeId, peerPublicKeyHex: A.publicKeyHex, lanEndpoints: [] })
  try {
    const t0 = Date.now()
    mgrA.beginPunch({
      peerNodeId: B.nodeId,
      peerPublicKeyHex: B.publicKeyHex,
      lanEndpoints: [endpointOf(sockB)],
      reflexiveEndpoint: null,
    })
    const info = await withTimeout(ready.promise, 200, 'onDirectReady within 200ms')
    assert.ok(Date.now() - t0 < 200, `established in ${Date.now() - t0}ms`)
    assert.equal(info.id, B.nodeId)
  } finally {
    await closeManager({ mgr: mgrA, socket: sockA })
    await closeManager({ mgr: mgrB, socket: sockB })
  }
})

test('beginPunch refuses an identity whose nodeId is not the hash of its key', async () => {
  const identity = generatePeerIdentity()
  const { mgr, socket } = await makeManager(identity, manualClock())
  try {
    const stranger = generatePeerIdentity()
    assert.throws(() => mgr.beginPunch({
      peerNodeId: 'deadbeef',
      peerPublicKeyHex: stranger.publicKeyHex,
      lanEndpoints: ['127.0.0.1:1'],
    }), TypeError, 'forged nodeId/publicKey binding rejected')
    assert.throws(() => mgr.beginPunch({
      peerNodeId: identity.nodeId,
      peerPublicKeyHex: identity.publicKeyHex,
      lanEndpoints: ['127.0.0.1:1'],
    }), TypeError, 'punching yourself rejected')
  } finally {
    await closeManager({ mgr, socket })
  }
})

test('handlePacket drops garbage and cross-network control packets without side effects', async () => {
  const identity = generatePeerIdentity()
  const { mgr, socket } = await makeManager(identity, manualClock())
  const stranger = generatePeerIdentity()
  try {
    mgr.handlePacket(Buffer.from('not json at all'), { address: '127.0.0.1', port: 1 })
    mgr.handlePacket(randomBytes(64), { address: '127.0.0.1', port: 1 })
    mgr.handlePacket(Buffer.from(JSON.stringify({ zr: 1, kind: 'zr-hello' })), { address: '127.0.0.1', port: 1 })
    // A validly signed HELLO for a DIFFERENT network must be ignored.
    mgr.handlePacket(buildPeerHandshakeEnvelope({
      kind: 'hello',
      networkId: '0000000000000000',
      identity: stranger,
      selfEphPubHex: randomBytes(32).toString('hex'),
      peerNodeId: identity.nodeId,
      peerEphPubHex: null,
      nonce: randomBytes(8).toString('hex'),
      timestamp: 12345,
    }), { address: '127.0.0.1', port: 1 })
    assert.equal(mgr.sessionCiphers(stranger.nodeId), null, 'no session materialized')
  } finally {
    await closeManager({ mgr, socket })
  }
})

test('fallback fires exactly once, at exactly 1000ms of virtual time', async () => {
  const identity = generatePeerIdentity()
  const peer = generatePeerIdentity()
  const blocker = await openSocket()
  const deadPort = blocker.address().port
  blocker.close()
  await waitClose(blocker)
  const clock = manualClock()
  const fallbacks = []
  const { mgr, socket } = await makeManager(identity, clock, {
    onPunchFallback: (id) => fallbacks.push(id),
  })
  try {
    mgr.beginPunch({
      peerNodeId: peer.nodeId,
      peerPublicKeyHex: peer.publicKeyHex,
      lanEndpoints: [`127.0.0.1:${deadPort}`],
      reflexiveEndpoint: null,
    })
    clock.advance(999)
    assert.deepEqual(fallbacks, [], 'no fallback before the window expires')
    clock.advance(1)
    assert.deepEqual(fallbacks, [peer.nodeId], 'fallback at exactly 1000ms')
    clock.advance(2000)
    assert.equal(fallbacks.length, 1, 'fallback fires exactly once per window')
    // The 60s reprobe fires at t=61000 and runs its OWN 1000ms window.
    clock.advance(58_000) // → 61000: reprobe HELLOs fly
    assert.equal(fallbacks.length, 1, 'reprobe start is silent')
    clock.advance(999) // → 61999: still inside the reprobe window
    assert.equal(fallbacks.length, 1)
    clock.advance(1) // → 62000
    assert.equal(fallbacks.length, 2, 'the reprobe round has its own window')
  } finally {
    await closeManager({ mgr, socket })
  }
})

test('silent reprobe after fallback upgrades to direct once the endpoint comes alive', async () => {
  const A = generatePeerIdentity()
  const B = generatePeerIdentity()
  const blocker = await openSocket()
  const deadPort = blocker.address().port
  blocker.close()
  await waitClose(blocker)

  const clockA = manualClock()
  const events = { ready: [], fallback: 0 }
  const readyDefer = defer()
  const { mgr: mgrA, socket: sockA } = await makeManager(A, clockA, {
    onDirectReady: (id, info) => {
      events.ready.push({ id, info })
      readyDefer.resolve({ id, info })
    },
    onPunchFallback: () => { events.fallback += 1 },
  })
  await mgrA.ready()
  mgrA.beginPunch({
    peerNodeId: B.nodeId,
    peerPublicKeyHex: B.publicKeyHex,
    lanEndpoints: [`127.0.0.1:${deadPort}`],
    reflexiveEndpoint: null,
  })
  clockA.advance(1000)
  assert.equal(events.fallback, 1, 'fallback fired for the blocked network')

  // "The network unblocks": B's real UDP socket now lives on that exact port.
  const bReady = defer()
  const { mgr: mgrB, socket: sockB } = await makeManager(B, manualClock(), {
    onDirectReady: (id, info) => bReady.resolve({ id, info }),
  }, deadPort)
  mgrB.beginPunch({ peerNodeId: A.nodeId, peerPublicKeyHex: A.publicKeyHex, lanEndpoints: [] })
  assert.equal(sockB.address().port, deadPort)

  // The 60s silent reprobe fires and the fresh HELLO reaches B.
  clockA.advance(60_000)
  const aInfo = await withTimeout(readyDefer.promise, 250, 'reprobe upgraded to direct')
  const bInfo = await withTimeout(bReady.promise, 250, 'B saw the reprobe too')
  assert.equal(events.fallback, 1, 'no extra fallback fired')
  assert.deepEqual(events.ready.map((entry) => entry.id), [B.nodeId])
  assert.equal(aInfo.info.endpoint, endpointOf(sockB))
  assert.equal(bInfo.id, A.nodeId)
  // Ciphers interoperate after the late upgrade.
  assert.equal(mgrA.sessionCiphers(B.nodeId).txKeyHex, mgrB.sessionCiphers(A.nodeId).rxKeyHex)
  await closeManager({ mgr: mgrA, socket: sockA })
  await closeManager({ mgr: mgrB, socket: sockB })
})

test('keepalive: pings are answered; 3 unanswered cycles trigger onDirectLost; reprobe keeps flying', async () => {
  const pair = await establishPair()
  const { A, B, clockA, mgrA, mgrB, sockB, events } = pair
  try {
    // The handshake itself records an RTT (measured hello→ack).
    const handshakeRtt = mgrA.sessionRttMs(B.nodeId)
    assert.ok(typeof handshakeRtt === 'number' && handshakeRtt >= 0, `handshake RTT recorded (got ${handshakeRtt})`)
    // Four ANSWERED keepalive cycles: if the PING/PONG loop were broken,
    // the 4th tick would see 15s of silence and declare the path lost.
    for (let cycle = 1; cycle <= 4; cycle++) {
      clockA.advance(5000)
      await sleep(10) // let B's PONG land on A's socket before judging
      assert.deepEqual(events.aLost, [], `answered cycle ${cycle} must not declare loss`)
    }
    assert.equal(events.aFallback, 0)

    // B goes silent (closed socket → no more PONGs). Exactly three
    // keepalive periods of silence (15s) declare the path lost.
    const bPort = sockB.address().port
    await closeManager({ mgr: mgrB, socket: sockB })
    clockA.advance(5000)
    await sleep(2)
    assert.deepEqual(events.aLost, [], 'one silent period is not enough')
    clockA.advance(5000)
    await sleep(2)
    assert.deepEqual(events.aLost, [], 'two silent periods is not enough')
    clockA.advance(5000)
    assert.deepEqual(events.aLost.map((entry) => entry.id), [B.nodeId], 'three silent periods (15s) declare the direct path lost')
    assert.equal(events.aFallback, 0, 'keepalive loss is not a punch fallback')

    // The background reprobe survives the lost event and keeps flying HELLOs.
    const raw = await openSocket('127.0.0.1', bPort)
    const helloDefer = defer()
    raw.once('message', (buf) => helloDefer.resolve(JSON.parse(buf.toString('utf8'))))
    clockA.advance(60_000)
    const hello = await withTimeout(helloDefer.promise, 250, 'reprobe HELLO after direct lost')
    assert.equal(hello.kind, 'zr-hello')
    assert.equal(hello.nodeId, A.nodeId)
    raw.close()
    await waitClose(raw)
  } finally {
    await closeManager({ mgr: mgrA, socket: pair.sockA })
  }
})

test('close() clears every timer handle, closes the socket, and is idempotent', async () => {
  const identity = generatePeerIdentity()
  const blocker = await openSocket()
  const deadPort = blocker.address().port
  blocker.close()
  await waitClose(blocker)
  const clock = manualClock()
  const events = { ready: 0, fallback: 0, lost: 0 }
  const { mgr, socket } = await makeManager(identity, clock, {
    onDirectReady: () => { events.ready += 1 },
    onPunchFallback: () => { events.fallback += 1 },
    onDirectLost: () => { events.lost += 1 },
  })
  const peer = generatePeerIdentity()
  mgr.beginPunch({
    peerNodeId: peer.nodeId,
    peerPublicKeyHex: peer.publicKeyHex,
    lanEndpoints: [`127.0.0.1:${deadPort}`],
    reflexiveEndpoint: null,
  })
  assert.ok(clock.pendingCount() > 0, 'punch timers are pending before close')
  const closed = waitClose(socket)
  mgr.close()
  await closed
  mgr.close() // idempotent
  assert.equal(clock.pendingCount(), 0, 'zero timer handles after close')
  clock.advance(10 * 60_000)
  assert.deepEqual(events, { ready: 0, fallback: 0, lost: 0 }, 'no callbacks after close')
  mgr.handlePacket(Buffer.from('junk'), { address: '127.0.0.1', port: 1 })
  assert.equal(mgr.sessionCiphers(peer.nodeId), null, 'sessions are gone after close')
})

test('asymmetric one-way UDP (A -> B arrives, B -> A dropped) never puts B into a one-way direct blackhole', async () => {
  const A = generatePeerIdentity()
  const B = generatePeerIdentity()
  const clockA = manualClock()
  const clockB = manualClock()
  const readyA = []
  const readyB = []
  const fallbackA = []
  const dataAtA = []

  const { mgr: mgrA, socket: sockA } = await makeManager(A, clockA, {
    onDirectReady: (id, info) => readyA.push({ id, info }),
    onPunchFallback: (id) => fallbackA.push(id),
    onEncryptedFrame: (header, plaintext) => dataAtA.push({ id: header.srcNodeId, text: Buffer.from(plaintext).toString('utf8') }),
  })
  const { mgr: mgrB, socket: sockB } = await makeManager(B, clockB, {
    onDirectReady: (id, info) => readyB.push({ id, info }),
    onPunchFallback: () => {},
  })
  let blockBtoA = true
  const realSendB = sockB.send.bind(sockB)
  sockB.send = (buf, port, address, cb) => {
    if (blockBtoA && port === sockA.address().port) {
      if (typeof cb === 'function') cb(null)
      return
    }
    return realSendB(buf, port, address, cb)
  }

  try {
    const portA = sockA.address().port
    const portB = sockB.address().port
    mgrB.beginPunch({
      peerNodeId: A.nodeId,
      peerPublicKeyHex: A.publicKeyHex,
      lanEndpoints: [`127.0.0.1:${portA}`],
      reflexiveEndpoint: null,
    })
    mgrA.beginPunch({
      peerNodeId: B.nodeId,
      peerPublicKeyHex: B.publicKeyHex,
      lanEndpoints: [`127.0.0.1:${portB}`],
      reflexiveEndpoint: null,
    })

    // Let A's HELLO reach B while B's HELLO-ACK is dropped by A's firewall/NAT.
    await sleep(30)
    clockA.advance(250)
    await sleep(30)
    clockA.advance(1000)
    await sleep(20)

    assert.deepEqual(fallbackA, [B.nodeId], 'A falls back after 1000ms punch window')
    assert.equal(readyA.length, 0, 'A never received B -> A packets, so A is not direct')
    assert.equal(
      readyB.length,
      0,
      'B MUST NOT enter direct on unconfirmed inbound zr-hello alone (otherwise B blackholes all outbound stream frames!)',
    )

    // Now unblock B -> A and trigger A's reprobe: 3-way confirmation completes on both sides!
    blockBtoA = false
    clockA.advance(60_000)
    await withTimeout(
      (async () => {
        while (readyA.length === 0 || readyB.length === 0) await sleep(10)
      })(),
      500,
      'both A and B enter direct once B -> A UDP is reachable',
    )
    assert.equal(readyA.length, 1)
    assert.equal(readyB.length, 1)

    mgrB.frameSenderFor(A.nodeId)(PeerFrameType.DATA, 7, Buffer.from('live-reply'), 0)
    await withTimeout(
      (async () => {
        while (dataAtA.length === 0) await sleep(5)
      })(),
      250,
      'B -> A encrypted stream frame arrives after 3-way direct confirmation',
    )
    assert.deepEqual(dataAtA, [{ id: B.nodeId, text: 'live-reply' }])
  } finally {
    await closeManager({ mgr: mgrA, socket: sockA })
    await closeManager({ mgr: mgrB, socket: sockB })
  }
})

test('beginPunch on an already-direct peer preserves live session ciphers without dropping frames', async () => {
  const receivedByA = []
  const pair = await establishPair({
    onEncryptedFrame: (_header, plaintext) => receivedByA.push(Buffer.from(plaintext).toString('utf8')),
  })
  try {
    // Simulate gateway punch-coordinate arriving after LAN direct is already live:
    pair.mgrB.beginPunch({
      peerNodeId: pair.A.nodeId,
      peerPublicKeyHex: pair.A.publicKeyHex,
      lanEndpoints: [`127.0.0.1:${pair.sockA.address().port}`],
      reflexiveEndpoint: `203.0.113.9:${pair.sockA.address().port}`,
    })
    assert.notEqual(pair.mgrB.sessionCiphers(pair.A.nodeId), null, 'live direct session ciphers must not be wiped')

    pair.mgrB.frameSenderFor(pair.A.nodeId)(PeerFrameType.DATA, 1, Buffer.from('still-connected'), 0)
    await withTimeout(
      (async () => {
        while (receivedByA.length === 0) await sleep(5)
      })(),
      250,
      'frame delivered over preserved direct session',
    )
    assert.deepEqual(receivedByA, ['still-connected'])
  } finally {
    await closeManager({ mgr: pair.mgrA, socket: pair.sockA })
    await closeManager({ mgr: pair.mgrB, socket: pair.sockB })
  }
})

// -- 4. PC-04: loss deadline = lastSeen + keepAliveMs * keepAliveLostFrames ---------

test('keepalive loss fires at exactly lastSeen+15000 across receive phases, not at the next PING tick', async () => {
  // Phase 1: last valid receive at t=0 (silent from establishment) → loss at exactly 15000.
  {
    const pair = await establishPair()
    const { B, clockA, mgrA, mgrB, sockB, events } = pair
    try {
      await closeManager({ mgr: mgrB, socket: sockB })
      clockA.advance(14_999)
      assert.deepEqual(events.aLost, [], '14999ms after the last receive is not enough')
      clockA.advance(1) // → 15000 = lastSeen + 15000
      assert.deepEqual(events.aLost.map((entry) => entry.id), [B.nodeId], 'loss at exactly lastSeen+15000')
    } finally {
      await closeManager({ mgr: mgrA, socket: pair.sockA })
    }
  }
  // Phase 2: last valid receive at t=2000 (between PING ticks) → loss at exactly 17000.
  {
    const pair = await establishPair()
    const { B, clockA, mgrA, mgrB, sockB, events } = pair
    try {
      clockA.advance(2_000)
      mgrB.frameSenderFor(pair.A.nodeId)(PeerFrameType.DATA, 1, Buffer.from('late-frame'), 0)
      await sleep(10) // the frame lands while the virtual clock sits at 2000 → lastSeen = 2000
      await closeManager({ mgr: mgrB, socket: sockB })
      clockA.advance(14_999) // → 16999, across the 15000 tick; the deadline is 17000
      assert.deepEqual(events.aLost, [], 'not lost before lastSeen+15000 even across a PING tick')
      clockA.advance(1) // → 17000
      assert.deepEqual(events.aLost.map((entry) => entry.id), [B.nodeId], 'loss at exactly lastReceived(2000)+15000, not the 20000 tick')
      clockA.advance(3_000) // → 20000: where the old tick sampling declared loss
      assert.equal(events.aLost.length, 1, 'no duplicate loss at the old 5s tick moment')
    } finally {
      await closeManager({ mgr: mgrA, socket: pair.sockA })
    }
  }
  // Phase 3: last valid receive at t=5200 (just after a PING tick) → loss at exactly 20200.
  {
    const pair = await establishPair()
    const { B, clockA, mgrA, mgrB, sockB, events } = pair
    try {
      clockA.advance(5_200) // the 5000 tick fires and PINGs; B's PONG lands at virtual 5200
      await sleep(10)
      await closeManager({ mgr: mgrB, socket: sockB })
      clockA.advance(14_999) // → 20199, across ticks at 10000/15000/20000 — none may declare loss
      assert.deepEqual(events.aLost, [], 'silent PING ticks before the deadline never declare loss')
      clockA.advance(1) // → 20200 = lastSeen + 15000
      assert.deepEqual(events.aLost.map((entry) => entry.id), [B.nodeId], 'loss at exactly lastReceived(5200)+15000')
    } finally {
      await closeManager({ mgr: mgrA, socket: pair.sockA })
    }
  }
})

test('dropPeer during direct cancels the loss deadline: no late lost fires, no resurrection', async () => {
  const pair = await establishPair()
  const { B, clockA, mgrA, mgrB, sockB, sockA, events } = pair
  try {
    mgrA.dropPeer(B.nodeId)
    await closeManager({ mgr: mgrB, socket: sockB })
    clockA.advance(60_000)
    assert.deepEqual(events.aLost, [], 'dropped peer has no loss deadline left to fire')
    assert.equal(events.aReady.length, 1, 'a dropped session is never re-promoted to direct')
    assert.equal(events.aFallback, 0, 'no punch fallback without an active punch round')
  } finally {
    await closeManager({ mgr: mgrA, socket: sockA })
  }
})

test('a keepalive loss fires exactly once; the silent reprobe never re-enters direct on its own', async () => {
  const pair = await establishPair()
  const { B, clockA, mgrA, mgrB, sockB, sockA, events } = pair
  try {
    await closeManager({ mgr: mgrB, socket: sockB })
    clockA.advance(15_000)
    assert.deepEqual(events.aLost.map((entry) => entry.id), [B.nodeId], 'loss declared once at the deadline')
    clockA.advance(60_000) // → 75000: the silent reprobe fires HELLOs at the dead endpoint
    assert.equal(events.aLost.length, 1, 'loss never fires twice for one direct epoch')
    assert.equal(events.aReady.length, 1, 'no direct re-entry without a successful handshake')
    assert.equal(events.aFallback, 0, 'reprobe HELLOs alone stay silent (window not yet expired)')
  } finally {
    await closeManager({ mgr: mgrA, socket: sockA })
  }
})

/**
 * Real-clock pair (PC-04): both managers run the production `realClock`
 * timer path with the default keepAliveMs=5000 / keepAliveLostFrames=3 —
 * no shortened parameters. `events.aReady[0].at` is the same synchronous
 * block that stamps `lastSeen`, so it anchors the loss deadline exactly.
 */
async function establishPairReal(hooksA = {}, hooksB = {}) {
  return establishPair(hooksA, hooksB, () => undefined)
}

test('real-clock keepalive: healthy session runs past three cycles without a false loss; hard silence trips at lastSeen+15000', async () => {
  const rxAt = []
  const pair = await establishPairReal({
    onEncryptedFrame: () => rxAt.push(Date.now()),
  })
  const { B, mgrA, mgrB, sockB, sockA, events } = pair
  try {
    // Healthy session: real PING/PONG round trips for 16.5s — more than
    // three full keepalive cycles — must never declare a loss.
    await sleep(16_500)
    assert.deepEqual(events.aLost, [], 'a healthy session never false-loses past three keepalive cycles')
    // Anchor the last valid receive with B's final frame (stamped in the
    // same synchronous block as lastSeen), then B goes hard-silent.
    mgrB.frameSenderFor(pair.A.nodeId)(PeerFrameType.DATA, 1, Buffer.from('last-frame'), 0)
    await withTimeout(
      (async () => {
        while (rxAt.length === 0) await sleep(5)
      })(),
      2_000,
      'the last frame reaches A',
    )
    const lastRx = rxAt[0]
    await closeManager({ mgr: mgrB, socket: sockB })
    await withTimeout(
      (async () => {
        while (events.aLost.length === 0) await sleep(20)
      })(),
      20_000,
      'onDirectLost within 20s of hard silence',
    )
    const delay = events.aLost[0].at - lastRx
    assert.equal(events.aLost[0].id, B.nodeId)
    assert.ok(delay >= 15_000, `loss no earlier than lastSeen+15000 (got ${delay}ms)`)
    assert.ok(delay <= 16_000, `loss within 1s scheduling slack of lastSeen+15000 (got ${delay}ms)`)
  } finally {
    await closeManager({ mgr: mgrA, socket: sockA })
  }
})

test('real-clock keepalive: a receive between PING ticks moves the loss to that receive+15000, not the next tick', async () => {
  const rxAt = []
  const pair = await establishPairReal({
    onEncryptedFrame: () => rxAt.push(Date.now()),
  })
  const { mgrA, mgrB, sockB, sockA, events } = pair
  try {
    // One healthy real heartbeat cycle, then B's last frame lands at a
    // non-tick moment; B goes hard-silent right after.
    await sleep(2_000)
    mgrB.frameSenderFor(pair.A.nodeId)(PeerFrameType.DATA, 1, Buffer.from('last-frame'), 0)
    await withTimeout(
      (async () => {
        while (rxAt.length === 0) await sleep(5)
      })(),
      2_000,
      'the last frame reaches A',
    )
    const lastRx = rxAt[0] // stamped in the same synchronous block as lastSeen
    await closeManager({ mgr: mgrB, socket: sockB })
    await withTimeout(
      (async () => {
        while (events.aLost.length === 0) await sleep(20)
      })(),
      20_000,
      'onDirectLost within 20s of hard silence',
    )
    const delay = events.aLost[0].at - lastRx
    assert.ok(delay >= 15_000, `loss no earlier than lastReceive+15000 (got ${delay}ms)`)
    assert.ok(delay <= 16_000, `loss within 1s of lastReceive+15000, not the next 5s tick (got ${delay}ms)`)
  } finally {
    await closeManager({ mgr: mgrA, socket: sockA })
  }
})

test('PC-V1: incoming recovery handshake survives the local reprobe deadline', async () => {
  const { EventEmitter } = require('node:events')
  const A = generatePeerIdentity()
  const B = generatePeerIdentity()
  const clockA = manualClock()
  const clockB = manualClock()
  const packets = []
  const sockets = new Map()
  const socketAt = (port) => {
    const socket = new EventEmitter()
    socket.address = () => ({ address: '127.0.0.1', port })
    socket.send = (bytes, targetPort) => packets.push({ bytes: Buffer.from(bytes), from: port, to: targetPort })
    socket.close = () => socket.removeAllListeners()
    sockets.set(port, socket)
    return socket
  }
  const deliver = () => {
    const packet = packets.shift()
    assert.ok(packet, 'a normal handshake packet is queued')
    sockets.get(packet.to)?.emit('message', packet.bytes, { address: '127.0.0.1', port: packet.from })
  }
  let readyA = 0
  let readyB = 0
  const a = new PeerPunchManager({ networkId: NET_ID, identity: A, clock: clockA, socket: socketAt(41001), onDirectReady: () => readyA++ })
  const b = new PeerPunchManager({ networkId: NET_ID, identity: B, clock: clockB, socket: socketAt(41002), onDirectReady: () => readyB++ })
  try {
    // A has no reachable advertised address for B; B can reach A and A can
    // reply to B's observed source. Both initial windows expire while offline.
    a.beginPunch({ peerNodeId: B.nodeId, peerPublicKeyHex: B.publicKeyHex, lanEndpoints: [] })
    b.beginPunch({ peerNodeId: A.nodeId, peerPublicKeyHex: A.publicKeyHex, lanEndpoints: ['127.0.0.1:41001'] })
    clockA.advance(1000)
    clockB.advance(1000)
    packets.length = 0
    clockA.advance(59_999)
    clockB.advance(60_000)
    deliver() // B's fresh HELLO reaches A just before A's scheduled reprobe.
    deliver() // A's ACK reaches B; B now has a confirmed path.
    assert.equal(readyB, 1)
    clockA.advance(1) // Cross A's old reprobe deadline before B's ACK arrives.
    for (let budget = 30; packets.length > 0; budget--) {
      assert.ok(budget > 0, 'normal handshake exchange is finite')
      deliver()
    }
    assert.equal(readyA, 1, 'A must finish the same exchange instead of discarding its pending challenge')
    assert.ok(a.sessionCiphers(B.nodeId))
    assert.ok(b.sessionCiphers(A.nodeId))
  } finally {
    a.close()
    b.close()
    assert.equal(clockA.pendingCount(), 0)
    assert.equal(clockB.pendingCount(), 0)
  }
})
