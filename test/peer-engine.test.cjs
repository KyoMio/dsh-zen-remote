'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const dgram = require('node:dgram')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')

const { createPeerEngine, arqProfileForPath, parsePeerTuning, DEFAULT_PEER_TUNING } = require('../lib/peer/engine.js')
const { PeerPunchManager } = require('../lib/peer/punch.js')
const { generatePeerIdentity } = require('../lib/peer/crypto.js')
const { PeerFrameType, decodeFrameHeader } = require('../lib/peer/wire.js')
const { PeerMux } = require('../lib/peer/mux.js')
const { createRelayPool } = require('../lib/relay-pool.js')
const {
  ensurePeerIdentity,
  readPeerNetwork,
  readPeerRevokedNotice,
  writePeerNetwork,
  writePeerRevokedNotice,
} = require('../lib/state-store.js')
const {
  PEER_WIRE_COMPAT_LEVEL,
  INFERRED_LEGACY_GATEWAY_VERSION,
  parseSemver,
  compareSemver,
  evaluatePeerVersionSync,
  sanitizeConsoleOrigin,
  versionDismissKey,
} = require('../lib/peer/version-sync.js')

const INDEX_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href
const NET_ID = '0123456789abcdef'
const KEEPALIVE_MS = 3500
const PONG_DELAY_MS = 10

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex')

async function waitFor(predicate, label = 'condition', ms = 3000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(5)
  }
  assert.ok(await predicate(), `${label} within ${ms}ms`)
}

function manualClock(initialMs = 0) {
  let now = initialMs
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
    advanceUntil(predicate, maxMs) {
      const target = now + maxMs
      while (!predicate()) {
        let best = null
        for (const [id, t] of timers) {
          if (t.at > target) continue
          if (!best || t.at < best.t.at || (t.at === best.t.at && id < best.id)) best = { id, t }
        }
        if (!best) { now = target; break }
        now = Math.max(now, best.t.at)
        timers.delete(best.id)
        best.t.fn()
      }
      return predicate()
    },
    pendingCount: () => timers.size,
  }
}

function recordingClock() {
  const timers = []
  return {
    timers,
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const handle = { fn, ms }
      timers.push(handle)
      return handle
    },
    clearTimeout(handle) {
      const index = timers.indexOf(handle)
      if (index >= 0) timers.splice(index, 1)
    },
  }
}

function fakePool() {
  return {
    mounted: [],
    maxServers: () => 8,
    mountVirtual(entry) {
      this.mounted.push(entry.entryId)
      return { displayName: entry.serverName }
    },
    unmountVirtual(entryId) {
      this.mounted = this.mounted.filter((id) => id !== entryId)
    },
  }
}

function readClientFrame(buf) {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let off = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    off = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    off = 10
  }
  const maskLen = masked ? 4 : 0
  if (buf.length < off + maskLen + len) return null
  let payload = buf.subarray(off + maskLen, off + maskLen + len)
  if (masked) {
    const mask = buf.subarray(off, off + 4)
    const out = Buffer.alloc(len)
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]
    payload = out
  }
  return { opcode, payload, rest: buf.subarray(off + maskLen + len) }
}

function wsFrame(value) {
  const body = Buffer.from(JSON.stringify(value))
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body])
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(body.length, 2)
  return Buffer.concat([header, body])
}

async function openUdp() {
  const socket = dgram.createSocket('udp4')
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err)
    socket.once('error', onError)
    socket.bind({ port: 0, address: '127.0.0.1' }, () => {
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
  const a = socket.address()
  return `${a.address}:${a.port}`
}

// -- 1. resumeFromState, joinNetwork & PAS-3 leaveNetwork (from peer-resume) -----

function buildResumeEngine(home, overrides = {}) {
  const stateFile = path.join(home, 'zen-remote-state.json')
  const socket = dgram.createSocket('udp4')
  socket.unref?.()
  const clock = recordingClock()
  const engine = createPeerEngine({
    stateFile,
    identity: ensurePeerIdentity(stateFile),
    relayPool: overrides.pool ?? fakePool(),
    relayHandler: () => undefined,
    relaySecret: () => 'secret',
    serverName: () => '测试机',
    udpSocket: socket,
    udpProbe: null,
    clock,
    log: overrides.log ?? (() => {}),
    ...(overrides.extra ?? {}),
  })
  return { engine, clock, socket, stateFile }
}

test('resumeFromState: unconfigured returns false; configured resumes; stop prevents resume', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-peer-resume-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  {
    const { engine, clock } = buildResumeEngine(home)
    assert.equal(engine.resumeFromState(), false)
    assert.equal(engine.status().gatewayState, 'unconfigured')
    assert.equal(engine.status().networkId, null)
    assert.deepEqual(clock.timers, [], 'no reconnect timer may arm without a network')
    engine.stop()
  }

  {
    const { engine, clock, socket, stateFile } = buildResumeEngine(home)
    writePeerNetwork(stateFile, {
      gatewayWsUrl: 'ws://127.0.0.1:9',
      gatewayHttpOrigin: 'http://127.0.0.1:9',
      networkId: NET_ID,
      joinedAt: 1,
    })
    assert.equal(engine.resumeFromState(), true)
    assert.equal(engine.status().networkId, NET_ID)
    await waitFor(() => clock.timers.length > 0, 'reconnect backoff armed')
    const state = engine.status().gatewayState
    assert.ok(state === 'connecting' || state === 'offline', `gatewayState advanced past unconfigured (got ${state})`)
    engine.stop()
    assert.equal(clock.timers.length, 0, 'stop() clears every armed timer')
    assert.ok(socket._handle === null || socket._handle === undefined, 'injected socket closed by stop()')
  }

  {
    const { engine, stateFile } = buildResumeEngine(home)
    writePeerNetwork(stateFile, {
      gatewayWsUrl: 'ws://127.0.0.1:9',
      gatewayHttpOrigin: 'http://127.0.0.1:9',
      networkId: NET_ID,
      joinedAt: 1,
    })
    engine.stop()
    assert.equal(engine.resumeFromState(), false)
  }
})

test('joinNetwork: repeated rejoin and leave+rejoin do not hang on self-managed UDP socket', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-peer-rejoin-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const stateFile = path.join(home, 'zen-remote-state.json')
  const clock = recordingClock()
  const engine = createPeerEngine({
    stateFile,
    identity: ensurePeerIdentity(stateFile),
    relayPool: fakePool(),
    relayHandler: () => undefined,
    relaySecret: () => 'secret',
    serverName: () => '测试机',
    udpProbe: null,
    clock,
    log: () => {},
  })
  t.after(() => engine.stop())

  const withJoinTimeout = async (promise, label) => {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1500) }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const first = await withJoinTimeout(engine.joinNetwork('zr-net+insecure://127.0.0.1:9/0123456789abcdef#key-1'), 'first join')
  assert.deepEqual(first, { ok: true })
  assert.equal(engine.status().networkId, '0123456789abcdef')

  const second = await withJoinTimeout(engine.joinNetwork('zr-net+insecure://127.0.0.1:9/fedcba9876543210#key-2'), 'second join')
  assert.deepEqual(second, { ok: true })
  assert.equal(engine.status().networkId, 'fedcba9876543210')

  await engine.leaveNetwork()
  assert.equal(engine.status().gatewayState, 'unconfigured', 'stale ws close must not overwrite unconfigured after leaveNetwork')

  const third = await withJoinTimeout(engine.joinNetwork('zr-net+insecure://127.0.0.1:9/1111222233334444#key-3'), 'third join')
  assert.deepEqual(third, { ok: true })
  assert.equal(engine.status().networkId, '1111222233334444')
})

test('PAS-3: everAdmitted/peerRevokedNotice persistence and leaveNetwork syncs or tolerates offline gateway', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-pas3-state-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const stateFile = path.join(home, 'zen-remote-state.json')
  const id = ensurePeerIdentity(stateFile)

  writePeerNetwork(stateFile, {
    gatewayWsUrl: 'ws://127.0.0.1:9',
    gatewayHttpOrigin: 'http://127.0.0.1:9',
    networkId: NET_ID,
    everAdmitted: true,
    joinedAt: 100,
  })
  assert.equal(readPeerNetwork(stateFile)?.everAdmitted, true)

  const notice = {
    deviceName: 'MacBook-Test',
    gatewayHost: 'http://127.0.0.1:19393',
    networkId: NET_ID,
    reason: 'removed from network',
    revokedAt: 200,
  }
  writePeerRevokedNotice(stateFile, notice)
  assert.deepEqual(readPeerRevokedNotice(stateFile), notice)
  assert.equal(readPeerNetwork(stateFile)?.everAdmitted, true)

  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  raw.peerRevokedNotice = { deviceName: '   ', gatewayHost: 123 }
  fs.writeFileSync(stateFile, JSON.stringify(raw))
  assert.equal(readPeerRevokedNotice(stateFile), undefined)

  const postedUrls = []
  const engineOnline = createPeerEngine({
    stateFile,
    identity: id,
    relayPool: fakePool(),
    relayHandler: () => undefined,
    relaySecret: () => 'secret',
    serverName: () => 'MacBook-Test',
    udpProbe: null,
    clock: recordingClock(),
    fetchImpl: async (url, init) => {
      postedUrls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ ok: true, data: { removed: true } }), { status: 200 })
    },
  })
  try {
    const leavePromise = engineOnline.leaveNetwork()
    assert.equal(readPeerNetwork(stateFile), undefined, 'synchronous state clear before await')
    assert.equal(engineOnline.status().gatewayState, 'unconfigured')
    const res = await leavePromise
    assert.deepEqual(res, { ok: true, gatewaySynced: true })
    assert.equal(postedUrls.length, 1)
    assert.equal(postedUrls[0].url, 'http://127.0.0.1:9/peer/v1/leave')
    assert.equal(postedUrls[0].body.nodeId, id.nodeId)
    assert.equal(typeof postedUrls[0].body.signatureHex, 'string')
  } finally {
    engineOnline.stop()
  }

  writePeerNetwork(stateFile, {
    gatewayWsUrl: 'ws://127.0.0.1:9',
    gatewayHttpOrigin: 'http://127.0.0.1:9',
    networkId: NET_ID,
    everAdmitted: true,
    joinedAt: 300,
  })
  const engineOffline = createPeerEngine({
    stateFile,
    identity: id,
    relayPool: fakePool(),
    relayHandler: () => undefined,
    relaySecret: () => 'secret',
    serverName: () => 'MacBook-Test',
    udpProbe: null,
    clock: recordingClock(),
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  try {
    const res = await engineOffline.leaveNetwork()
    assert.deepEqual(res, { ok: true, gatewaySynced: false })
    assert.equal(readPeerNetwork(stateFile), undefined)
    assert.equal(engineOffline.status().gatewayState, 'unconfigured')
  } finally {
    engineOffline.stop()
  }
})

// -- 2. capacity, network-updated & index volatile-update (from peer-capacity) --

async function setupCapacity(t, { cap = 8, count = 3, gatewayCap = 16, configSource = 'default' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-capacity-test-'))
  const stateFile = path.join(home, 'state.json')
  const identity = ensurePeerIdentity(stateFile)
  const peers = Array.from({ length: count }, (_, i) => ({ ...generatePeerIdentity(), name: `peer-${i}`, lanEndpoints: [] }))
  const sockets = new Set()
  let upstream
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => {}) })
  server.on('upgrade', (req, socket) => {
    upstream = socket
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const parsed = readClientFrame(buf)
        if (!parsed) break
        buf = parsed.rest
        if (parsed.opcode === 8) { socket.end(Buffer.from([0x88, 0])); return }
        if (parsed.opcode === 9 && parsed.payload.length < 126) {
          socket.write(Buffer.concat([Buffer.from([0x8a, parsed.payload.length]), parsed.payload]))
        }
      }
    })
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.write(wsFrame({
      type: 'welcome',
      status: 'authorized',
      maxPeers: gatewayCap,
      peers: peers.map(({ nodeId, publicKeyHex, name, lanEndpoints }) => ({ nodeId, publicKeyHex, name, lanEndpoints })),
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `127.0.0.1:${server.address().port}`
  writePeerNetwork(stateFile, { gatewayWsUrl: `ws://${origin}`, gatewayHttpOrigin: `http://${origin}`, networkId: NET_ID, joinedAt: 1 })
  let localCap = cap
  const pool = createRelayPool({
    stateFile,
    skipPersistedServers: true,
    getMaxServers: () => localCap,
    getMaxServersSource: () => configSource,
    getPeerNetworkCap: () => readPeerNetwork(stateFile)?.maxPeersFromGateway,
    computeOwnFingerprints: () => ({}),
    createClient: () => ({ state: 'online', subscribe: () => () => {}, connect: async () => {}, stop() {} }),
  })
  const mounts = []
  const mountVirtual = pool.mountVirtual
  pool.mountVirtual = function (entry) { mounts.push(entry.entryId); return mountVirtual.call(this, entry) }
  const engine = createPeerEngine({
    stateFile,
    identity,
    relayPool: pool,
    relayHandler: () => undefined,
    relaySecret: () => 'test-only',
    serverName: () => 'test',
    udpProbe: null,
    clock: recordingClock(),
  })
  t.after(async () => {
    engine.stop()
    pool.stop()
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  })
  engine.resumeFromState()
  await waitFor(() => engine.status().gatewayState === 'authorized', 'capacity authorized')
  return { engine, pool, peers, mounts, stateFile, send: (value) => upstream.write(wsFrame(value)), setCap: (value) => { localCap = value } }
}

test('welcome capacity > 8 mounts, departure refills, disabling refills, growth/shrink & stop', async (t) => {
  {
    const { engine, pool, stateFile } = await setupCapacity(t, { count: 9, gatewayCap: 16 })
    assert.equal(readPeerNetwork(stateFile).maxPeersFromGateway, 16)
    assert.equal(engine.status().maxPeers, 16)
    assert.equal(pool.maxServers(), 15, 'network member count includes this node')
    assert.equal(pool.entries().length, 9)
  }
  {
    const { engine, pool, peers, send } = await setupCapacity(t, { cap: 1, count: 2, configSource: 'row' })
    assert.equal(pool.entries()[0].entryId, peers[0].nodeId)
    send({ type: 'peer-left', nodeId: peers[0].nodeId })
    await waitFor(() => engine.status().peers.length === 1, 'peer-left applied')
    assert.deepEqual(pool.entries().map((entry) => entry.entryId), [peers[1].nodeId])
  }
  {
    const { engine, pool, peers } = await setupCapacity(t, { cap: 1, count: 3, configSource: 'row' })
    engine.setNodeDisabled(peers[1].nodeId, true)
    engine.setNodeDisabled(peers[0].nodeId, true)
    assert.deepEqual(pool.entries().map((entry) => entry.entryId), [peers[2].nodeId])
  }
  {
    const { engine, pool, setCap } = await setupCapacity(t, { cap: 1, count: 3, configSource: 'row' })
    assert.equal(pool.entries().length, 1)
    setCap(2)
    engine.refreshMounts()
    assert.equal(pool.entries().length, 2)
    setCap(1)
    engine.refreshMounts()
    assert.equal(pool.maxServers(), 1)
    assert.equal(pool.entries().length, 2)
    engine.stop()
    engine.refreshMounts()
    assert.equal(pool.entries().length, 0)
  }
})

test('actual index apply(ctx, row) volatile-update subscription reconciles live maxServers edit', async (t) => {
  const index = await import(INDEX_URL)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-index-cap-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const sockets = new Set()
  const peers = Array.from({ length: 3 }, (_, i) => ({ ...generatePeerIdentity(), name: `peer-${i}`, lanEndpoints: [] }))
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  server.on('connection', (s) => { sockets.add(s); s.on('error', () => {}) })
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {})
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.write(wsFrame({
      type: 'welcome',
      status: 'authorized',
      maxPeers: 16,
      peers: peers.map(({ nodeId, publicKeyHex, name, lanEndpoints }) => ({ nodeId, publicKeyHex, name, lanEndpoints })),
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `127.0.0.1:${server.address().port}`
  const stateFile = path.join(home, 'zen-remote-state.json')
  ensurePeerIdentity(stateFile)
  writePeerNetwork(stateFile, { gatewayWsUrl: `ws://${origin}`, gatewayHttpOrigin: `http://${origin}`, networkId: NET_ID, joinedAt: 1 })

  const listeners = []
  const effects = []
  const ctx = {
    plugin() {},
    provide() { return () => {} },
    on(event, listener) { listeners.push({ event, listener }); return () => {} },
    inject() {},
    effect(fn) { effects.push(fn()) },
    logger: { warn() {} },
  }
  t.after(async () => {
    for (const d of effects) if (typeof d === 'function') d()
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    for (const s of sockets) s.destroy()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  })

  let cap = 1
  const row = {
    role: 'peer',
    maxServers: { get: () => cap },
  }
  index.apply(ctx, row)
  const engine = index.getPeerEngine()
  const pool = index.getRelayPool()
  assert.ok(engine && pool, 'peer mode apply mounts engine and pool')
  await waitFor(() => engine.status().gatewayState === 'authorized', 'real index peer engine authorized')
  assert.equal(pool.entries().length, 1)

  const volatileListeners = listeners.filter((l) => l.event === 'loader/volatile-update')
  assert.ok(volatileListeners.length >= 1, 'real index subscribes loader/volatile-update')

  cap = 2
  for (const { listener } of volatileListeners) listener([['maxServers']])
  assert.equal(pool.entries().length, 2, 'production callback reconciles capacity growth')

  cap = 1
  for (const { listener } of volatileListeners) listener([['maxServers']])
  assert.equal(pool.entries().length, 2, 'ordinary shrink retains mounted peers')
})

test('capacity authorization revocation, reconciliation, growth/shrink, mismatch & invalid cap', async (t) => {
  for (const status of ['pending', 'mismatch', 'denied']) {
    const { engine, pool, peers, mounts, send, setCap } = await setupCapacity(t, { cap: 2, count: 3, configSource: 'row' })
    assert.equal(pool.entries().length, 2)
    const initialMounts = [...mounts]
    send(status === 'denied' ? { type: 'denied', reason: 'revoked' } : { type: 'welcome', status, maxPeers: 16, peers })
    const expected = status === 'pending' ? 'pending-approval' : status === 'denied' ? 'revoked' : status
    await waitFor(() => engine.status().gatewayState === expected, `state ${expected}`)
    assert.equal(pool.entries().length, 0)
    assert.equal(engine.status().peers.length, 0)
    assert.deepEqual(mounts, initialMounts)
    setCap(8)
    engine.refreshMounts()
    assert.equal(pool.entries().length, 0)
  }

  {
    const { engine, pool, peers, send } = await setupCapacity(t, { cap: 1, count: 3, configSource: 'row' })
    send({ type: 'welcome', status: 'authorized', maxPeers: 16, peers: peers.slice(1) })
    await waitFor(() => engine.status().peers.length === 2, 'departed freed')
    assert.deepEqual(pool.entries().map((entry) => entry.entryId), [peers[1].nodeId])
  }

  {
    const { engine, pool, peers, send, stateFile } = await setupCapacity(t, { count: 3, gatewayCap: 2 })
    assert.equal(pool.entries().length, 1)
    send({ type: 'welcome', status: 'authorized', maxPeers: 4, peers })
    await waitFor(() => engine.status().maxPeers === 4, 'growth 4')
    assert.equal(pool.entries().length, 3)
    send({ type: 'welcome', status: 'authorized', maxPeers: 2, peers })
    await waitFor(() => engine.status().maxPeers === 2, 'shrink 2')
    assert.equal(pool.maxServers(), 1)
    assert.equal(pool.entries().length, 3)
    send({ type: 'welcome', status: 'authorized', maxPeers: -1, peers: peers.slice(1) })
    await waitFor(() => engine.status().peers.length === 2, 'invalid cap ignored')
    assert.equal(engine.status().maxPeers, 2)
    assert.equal(readPeerNetwork(stateFile).maxPeersFromGateway, 2)
  }

  {
    const { engine, pool, peers, send } = await setupCapacity(t, { cap: 1, count: 2, configSource: 'row' })
    send({ type: 'peer-joined', ...peers[0], publicKeyHex: peers[1].publicKeyHex })
    await waitFor(() => engine.status().peers[0].state === 'identity-mismatch', 'mismatch')
    assert.deepEqual(pool.entries().map((entry) => entry.entryId), [peers[1].nodeId])
  }

  {
    const { pool, engine, stateFile } = await setupCapacity(t, { cap: 4, count: 1, gatewayCap: 1, configSource: 'row' })
    assert.equal(pool.maxServers(), 4)
    assert.equal(pool.entries().length, 1)
    assert.equal(engine.status().maxPeers, null)
    assert.equal(readPeerNetwork(stateFile).maxPeersFromGateway, undefined)
  }
})

test('PC-08b network-updated: rise, shrink+freed slot, min with local cap, idempotent & validation', async (t) => {
  {
    const { engine, pool, send, stateFile } = await setupCapacity(t, { count: 3, gatewayCap: 2 })
    send({ type: 'network-updated', networkId: NET_ID, maxPeers: 4 })
    await waitFor(() => engine.status().maxPeers === 4, 'rise to 4')
    assert.equal(readPeerNetwork(stateFile).maxPeersFromGateway, 4)
    assert.equal(pool.maxServers(), 3)
    assert.equal(pool.entries().length, 3)
  }
  {
    const { engine, pool, peers, send, stateFile } = await setupCapacity(t, { count: 3, gatewayCap: 16 })
    send({ type: 'network-updated', networkId: NET_ID, maxPeers: 2 })
    await waitFor(() => engine.status().maxPeers === 2, 'shrink to 2')
    assert.equal(readPeerNetwork(stateFile).maxPeersFromGateway, 2)
    assert.equal(pool.entries().length, 3)
    engine.setNodeDisabled(peers[0].nodeId, true)
    assert.equal(pool.entries().length, 2)
    engine.setNodeDisabled(peers[0].nodeId, false)
    assert.equal(pool.entries().length, 2)
    send({ type: 'network-updated', networkId: NET_ID, maxPeers: 4 })
    await waitFor(() => pool.entries().length === 3, 'refill at 4')
    assert.equal(pool.entries().some((entry) => entry.entryId === peers[0].nodeId), true)
  }
  {
    const { engine, pool, send, stateFile } = await setupCapacity(t, { cap: 1, count: 3, gatewayCap: 16, configSource: 'row' })
    send({ type: 'network-updated', networkId: NET_ID, maxPeers: 64 })
    await waitFor(() => engine.status().maxPeers === 64, 'gateway 64')
    assert.equal(readPeerNetwork(stateFile).maxPeersFromGateway, 64)
    assert.equal(pool.maxServers(), 1)
    assert.equal(pool.entries().length, 1)
  }
  {
    const { engine, pool, mounts, send, stateFile } = await setupCapacity(t, { count: 2, gatewayCap: 4 })
    const inoBefore = fs.statSync(stateFile).ino
    const diskBefore = fs.readFileSync(stateFile, 'utf8')
    const mountsBefore = mounts.length
    send({ type: 'network-updated', networkId: NET_ID, maxPeers: 4 })
    await sleep(30)
    assert.equal(fs.statSync(stateFile).ino, inoBefore, 'same-value update must not rewrite state file')
    assert.equal(fs.readFileSync(stateFile, 'utf8'), diskBefore)
    assert.equal(mounts.length, mountsBefore)
    send({ type: 'network-updated', networkId: NET_ID, maxPeers: 6 })
    await waitFor(() => engine.status().maxPeers === 6, 'changed maxPeers 6')
    assert.notEqual(fs.statSync(stateFile).ino, inoBefore, 'changed value persists atomically')
    assert.equal(pool.maxServers(), 5)
  }
  {
    const { engine, pool, mounts, send, stateFile } = await setupCapacity(t, { count: 2, gatewayCap: 8 })
    const diskBefore = fs.readFileSync(stateFile, 'utf8')
    const mountsBefore = mounts.length
    for (const message of [
      { type: 'network-updated', networkId: 'ffffffffffffffff', maxPeers: 32 },
      { type: 'network-updated', maxPeers: 9 },
      { type: 'network-updated', networkId: NET_ID },
      { type: 'network-updated', networkId: NET_ID, maxPeers: 1 },
      { type: 'network-updated', networkId: NET_ID, maxPeers: 65 },
      { type: 'network-updated', networkId: NET_ID, maxPeers: 2.5 },
      { type: 'network-updated', networkId: NET_ID, maxPeers: NaN },
      { type: 'network-updated', networkId: NET_ID, maxPeers: '9' },
    ]) {
      send(message)
    }
    await sleep(30)
    assert.equal(engine.status().maxPeers, 8)
    assert.equal(fs.readFileSync(stateFile, 'utf8'), diskBefore)
    assert.equal(mounts.length, mountsBefore)
    assert.equal(pool.entries().length, 2)
    send({ type: 'network-updated', networkId: NET_ID, maxPeers: 3 })
    await waitFor(() => engine.status().maxPeers === 3, 'valid message still lands')
    assert.equal(readPeerNetwork(stateFile).maxPeersFromGateway, 3)
  }
})

// -- 3. RTT cap, demotion/promotion, unanswered PINGs, re-anchoring & connSeq (from peer-rtt-cap) --

function makeGate(realSocket) {
  const pending = new Set()
  const gate = {
    pongDelayMs: PONG_DELAY_MS,
    dropAll: false,
    dropPongs: false,
    dropFirstPing: true,
    onPing: null,
    send(buf, offset, length, port, host, cb) {
      if (typeof length === 'string') {
        cb = port; host = length; port = offset; offset = 0; length = buf.length
      }
      const isPong = length >= 4 && buf[offset + 3] === PeerFrameType.PONG
      if (gate.dropAll || (isPong && gate.dropPongs)) {
        if (typeof cb === 'function') cb()
        return
      }
      if (isPong && gate.pongDelayMs > 0) {
        const packet = Buffer.from(buf.slice(offset, offset + length))
        const dstPort = port
        const dstHost = host
        const timer = setTimeout(() => {
          pending.delete(timer)
          if (!gate.dropAll) realSocket.send(packet, 0, packet.length, dstPort, dstHost)
        }, gate.pongDelayMs)
        pending.add(timer)
        if (typeof cb === 'function') cb()
        return
      }
      realSocket.send(buf, offset, length, port, host, cb)
    },
    on(event, listener) {
      if (event !== 'message') return realSocket.on(event, listener)
      return realSocket.on('message', (buf, rinfo) => {
        if (buf.length >= 4 && buf[3] === PeerFrameType.PING) {
          if (gate.dropFirstPing) {
            gate.dropFirstPing = false
            return
          }
          gate.onPing?.()
        }
        listener(buf, rinfo)
      })
    },
    once: (...args) => realSocket.once(...args),
    removeListener: (...args) => realSocket.removeListener(...args),
    address: () => realSocket.address(),
    unref: () => realSocket.unref(),
    ref: () => realSocket.ref(),
    bind: (...args) => realSocket.bind(...args),
    close() {
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
      realSocket.close()
    },
  }
  return gate
}

function makePingSniffer(realSocket, clock) {
  const sniff = {
    lastPingAt: -1,
    send(buf, offset, length, port, host, cb) {
      if (typeof length === 'string') {
        cb = port; host = length; port = offset; offset = 0; length = buf.length
      }
      if (length >= 4 && buf[offset + 3] === PeerFrameType.PING) sniff.lastPingAt = clock.now()
      realSocket.send(buf, offset, length, port, host, cb)
    },
    on: (...args) => realSocket.on(...args),
    once: (...args) => realSocket.once(...args),
    removeListener: (...args) => realSocket.removeListener(...args),
    address: () => realSocket.address(),
    unref: () => realSocket.unref(),
    ref: () => realSocket.ref(),
    bind: (...args) => realSocket.bind(...args),
    close: () => realSocket.close(),
  }
  return sniff
}

async function startRttGateway({ peers, rttCap }) {
  const server = http.createServer()
  const sockets = []
  server.on('upgrade', (req, socket) => {
    sockets.push(socket)
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const parsed = readClientFrame(buf)
        if (parsed === null) break
        buf = parsed.rest
        if (parsed.opcode === 8) { socket.end(); return }
        if (parsed.opcode === 9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, parsed.payload.length]), parsed.payload]))
          continue
        }
        if (parsed.opcode !== 1) continue
        let msg
        try { msg = JSON.parse(parsed.payload.toString('utf8')) } catch { continue }
        if (msg?.type === 'auth') {
          socket.write(wsFrame({
            type: 'welcome',
            status: 'authorized',
            maxPeers: 8,
            ...(rttCap !== undefined ? { peerDirectMaxRttMs: rttCap } : {}),
            peers: peers(),
          }))
        }
      }
    })
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    const response = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    socket.write(Buffer.concat([Buffer.from(response), wsFrame({ type: 'challenge', challengeHex: 'a1b2c3d4e5f60718' })]))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    httpPort: port,
    wsUrl: `ws://127.0.0.1:${port}`,
    send: (value) => {
      const frame = wsFrame(value)
      for (const socket of sockets) socket.write(frame)
    },
    dropConnections: () => {
      for (const socket of sockets.splice(0)) socket.destroy()
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function buildRttPair(t, { cap, rttCap }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-rtt-cap-'))
  const clock = manualClock()
  const logs = []
  const capRef = { value: cap }
  const stateFileA = path.join(home, 'a-state.json')
  const socketA = await openUdp()
  const sniffA = makePingSniffer(socketA, clock)
  let pongCount = 0
  let pongWaiter = null
  socketA.on('message', (buf) => {
    if (buf.length >= 4 && buf[3] === PeerFrameType.PONG) {
      pongCount += 1
      const w = pongWaiter
      if (w) { pongWaiter = null; w() }
    }
  })
  const identityA = ensurePeerIdentity(stateFileA)
  const socketB = await openUdp()
  const gateB = makeGate(socketB)
  const identityB = generatePeerIdentity()
  const gateway = await startRttGateway({
    rttCap,
    peers: () => [{
      nodeId: identityB.nodeId,
      publicKeyHex: identityB.publicKeyHex,
      name: 'peer-B',
      lanEndpoints: [endpointOf(socketB)],
    }],
  })
  const reconnectCalls = []
  const engine = createPeerEngine({
    stateFile: stateFileA,
    identity: identityA,
    relayPool: {
      maxServers: () => 8,
      mountVirtual: (input) => ({ entryId: input.entryId, serverId: input.serverId, serverName: input.serverName, displayName: input.serverName }),
      unmountVirtual: () => true,
      updateVirtualName: () => true,
      reconnect: (id) => { reconnectCalls.push(id); return Promise.resolve(true) },
    },
    relayHandler: () => undefined,
    relaySecret: () => 'test',
    serverName: () => 'node-A',
    udpSocket: sniffA,
    udpProbe: null,
    clock,
    log: (line) => logs.push(line),
    directMaxRttMs: () => capRef.value,
    punch: {
      keepAliveMs: KEEPALIVE_MS,
      keepAliveLostFrames: 3,
      reprobeInitialDelaysMs: [5_000, 15_000],
      reprobeIntervalMs: 800,
      fastConfirmDelayMs: 0,
    },
  })
  const mgrB = new PeerPunchManager({
    networkId: NET_ID,
    identity: identityB,
    socket: gateB,
    clock,
    keepAliveMs: KEEPALIVE_MS,
    keepAliveLostFrames: 3,
    reprobeInitialDelaysMs: [5_000, 15_000],
    reprobeIntervalMs: 800,
  })
  await mgrB.ready()
  writePeerNetwork(stateFileA, {
    gatewayWsUrl: gateway.wsUrl,
    gatewayHttpOrigin: `http://127.0.0.1:${gateway.httpPort}`,
    networkId: NET_ID,
    joinedAt: 1,
  })
  t.after(async () => {
    const closingB = waitClose(socketB)
    const closingA = waitClose(socketA)
    mgrB.close()
    engine.stop()
    await closingB
    await closingA
    await gateway.close()
    fs.rmSync(home, { recursive: true, force: true })
  })
  engine.resumeFromState()
  mgrB.beginPunch({ peerNodeId: identityA.nodeId, peerPublicKeyHex: identityA.publicKeyHex, lanEndpoints: [] })

  const peerOf = () => engine.status().peers.find((peer) => peer.nodeId === identityB.nodeId)
  const waitReady = async () => {
    await waitFor(() => logs.some((line) => line.includes('direct ready')), 'A direct ready log')
  }
  const waitLost = async () => {
    await waitFor(() => peerOf()?.path === 'relay', 'A onDirectLost applied')
  }

  // Event-gated sample(): advanceUntil stops at the exact PING tick with 0ms overshoot.
  const sample = async (rtt) => {
    assert.ok(rtt < KEEPALIVE_MS, 'scripted rtt must stay under one keepalive interval')
    for (let attempt = 0; attempt < 4; attempt++) {
      const pongsBefore = pongCount
      const before = sniffA.lastPingAt
      let pingSeen = false
      gateB.onPing = () => { pingSeen = true }
      clock.advanceUntil(() => sniffA.lastPingAt !== before, KEEPALIVE_MS * 2)
      assert.ok(sniffA.lastPingAt !== before, 'keepalive ping sent')
      await waitFor(() => pingSeen, 'B receives PING', 500)
      gateB.onPing = null
      const delta = sniffA.lastPingAt + rtt - clock.now()
      if (delta > 0) clock.advance(delta)
      if (pongCount === pongsBefore) {
        await new Promise((resolve, reject) => {
          const tmr = setTimeout(() => { pongWaiter = null; reject(new Error('pong timeout')) }, 500)
          pongWaiter = () => { clearTimeout(tmr); resolve() }
        }).catch(() => {})
      }
      if (pongCount > pongsBefore) return
    }
    assert.fail('the delayed PONG after 4 keepalive ticks')
  }

  const drain = async (ms, step = 1000) => {
    for (let left = ms; left > 0; left -= step) {
      clock.advance(Math.min(step, left))
      await sleep(2)
    }
  }

  return { engine, mgrB, gateB, gateway, clock, logs, capRef, peerOf, waitReady, waitLost, sample, drain, identityB, identityA, socketB, stateFileA, reconnectCalls }
}

test('RTT cap: cap 0 promotes immediately; cap > 0 enforces 2-sample promotion streak and reset', async (t) => {
  {
    const env = await buildRttPair(t, { cap: 0 })
    await env.waitReady()
    assert.equal(env.peerOf().path, 'lan')
    await env.sample(40)
    const after = env.peerOf()
    assert.equal(after.path, 'lan')
    assert.equal(after.directRttMs, 40)
    assert.equal(after.directDemoted, false)
  }
  {
    const env = await buildRttPair(t, { cap: 300 })
    await env.waitReady()
    assert.equal(env.peerOf().path, 'relay')
    await env.sample(100)
    assert.equal(env.peerOf().path, 'relay', 'one sample does not promote')
    await env.sample(250) // between cap*0.7 (210) and cap (300) resets streak
    assert.equal(env.peerOf().path, 'relay')
    assert.equal(env.peerOf().directDemoted, false)
    await env.sample(100)
    assert.equal(env.peerOf().path, 'relay')
    await env.sample(100)
    const peer = env.peerOf()
    assert.equal(peer.path, 'lan')
    assert.equal(typeof peer.rttMs, 'number')
  }
})

test('RTT cap: single spike vs sustained highs demotion, recovery streak & live cap 0 flip', async (t) => {
  {
    const env = await buildRttPair(t, { cap: 300 })
    await env.waitReady()
    await env.sample(50)
    await env.sample(50)
    assert.equal(env.peerOf().path, 'lan')
    await env.sample(2000) // EWMA 50*0.7 + 2000*0.3 = 635, pre-update baseline 50 <= 300 -> no demotion
    assert.equal(env.peerOf().path, 'lan')
    assert.equal(env.peerOf().directDemoted, false)
    assert.equal(env.peerOf().directRttMs, 635)
    await env.sample(2000) // sustained high -> demotes
    const demoted = env.peerOf()
    assert.equal(demoted.path, 'relay')
    assert.equal(demoted.directDemoted, true)
    assert.equal(demoted.directDemoteReason, 'rtt-cap')
    assert.equal(demoted.rttMs, null)
  }
  {
    const env = await buildRttPair(t, { cap: 300 })
    await env.waitReady()
    await env.sample(3000)
    assert.equal(env.peerOf().path, 'relay')
    assert.equal(env.peerOf().directDemoted, true)
    assert.equal(env.peerOf().directDemoteReason, 'rtt-cap')
    assert.ok(env.logs.some((line) => /direct .+ rtt 3000ms over cap 300ms/.test(line)))
    await env.sample(100)
    await env.sample(900) // breaks recovery streak
    await env.sample(100)
    assert.equal(env.peerOf().path, 'relay')
    await env.sample(100)
    assert.equal(env.peerOf().path, 'lan')
    assert.equal(env.peerOf().directDemoted, false)
  }
  {
    const env = await buildRttPair(t, { cap: 300 })
    await env.waitReady()
    await env.sample(3000)
    assert.equal(env.peerOf().path, 'relay')
    env.capRef.value = 0
    await env.sample(900)
    assert.equal(env.peerOf().path, 'lan')
    assert.equal(env.peerOf().directDemoted, false)
  }
})

test('RTT cap is gateway-owned: welcome wins, network-updated applies live, invalid ignored, resume seeds', async (t) => {
  {
    const env = await buildRttPair(t, { cap: 0, rttCap: 100 })
    await env.waitReady()
    assert.equal(env.engine.status().directCapMs, 100)
    assert.equal(env.engine.status().directCapSource, 'gateway')
    await waitFor(() => readPeerNetwork(env.stateFileA)?.peerDirectMaxRttMsFromGateway === 100, 'cap persisted')
    await env.sample(50)
    assert.equal(env.peerOf().path, 'relay')
    await env.sample(50)
    assert.equal(env.peerOf().path, 'lan')

    const engine2 = createPeerEngine({
      stateFile: env.stateFileA,
      identity: env.identityA,
      relayPool: { maxServers: () => 8, mountVirtual: (i) => ({ entryId: i.entryId, serverId: i.serverId, serverName: i.serverName }), unmountVirtual: () => true, updateVirtualName: () => true },
      relayHandler: () => undefined,
      relaySecret: () => 'test',
      serverName: () => 'node-A',
      udpProbe: null,
      clock: env.clock,
      log: () => {},
      directMaxRttMs: () => 0,
      punch: { keepAliveMs: KEEPALIVE_MS, keepAliveLostFrames: 3, reprobeIntervalMs: 800 },
    })
    t.after(() => engine2.stop())
    assert.equal(engine2.status().directCapMs, 0)
    engine2.resumeFromState()
    assert.equal(engine2.status().directCapMs, 100)
    assert.equal(engine2.status().directCapSource, 'gateway')
  }
  {
    const env = await buildRttPair(t, { cap: undefined })
    await env.waitReady()
    assert.equal(env.engine.status().directCapMs, 300)
    assert.equal(env.engine.status().directCapSource, 'default')
  }
  {
    const env = await buildRttPair(t, { cap: 300 })
    await env.waitReady()
    await env.sample(250)
    assert.equal(env.peerOf().path, 'relay')
    env.gateway.send({ type: 'network-updated', networkId: NET_ID, maxPeers: 8, peerDirectMaxRttMs: 400 })
    await waitFor(() => readPeerNetwork(env.stateFileA)?.peerDirectMaxRttMsFromGateway === 400, 'live cap persisted')
    assert.equal(env.engine.status().directCapMs, 400)
    await env.sample(250)
    assert.equal(env.peerOf().path, 'relay')
    await env.sample(250)
    assert.equal(env.peerOf().path, 'lan')

    env.gateway.send({ type: 'network-updated', networkId: NET_ID, maxPeers: 12, peerDirectMaxRttMs: -5 })
    await waitFor(() => env.engine.status().maxPeers === 12, 'maxPeers updated')
    assert.equal(env.engine.status().directCapMs, 400)
  }
})

test('RTT cap: two unanswered PINGs demote; loss wipes flag and re-gates re-established session', async (t) => {
  const env = await buildRttPair(t, { cap: 300 })
  await env.waitReady()
  await env.sample(50)
  await env.sample(50)
  assert.equal(env.peerOf().path, 'lan')

  env.gateB.pongDelayMs = 0
  env.gateB.dropPongs = true
  await env.drain(11000)
  assert.equal(env.peerOf().path, 'relay')
  assert.equal(env.peerOf().directDemoted, true)
  // A healthy-RTT path that stops answering is a lost path, not "over the cap".
  assert.equal(env.peerOf().directDemoteReason, 'path-lost')
  assert.equal(env.peerOf().directRttMs, 50)
  assert.ok(env.logs.some((line) => /direct .+ keepalive unanswered ×2 — relaying/.test(line)))

  env.gateB.dropPongs = false
  env.gateB.dropAll = true
  await env.drain(14000)
  await env.waitLost()
  const lostAt = env.clock.now()
  assert.equal(env.peerOf().path, 'relay')
  assert.equal(env.peerOf().directDemoted, false)
  assert.equal(env.peerOf().directDemoteReason, null)

  env.gateB.dropAll = false
  env.gateB.pongDelayMs = PONG_DELAY_MS
  env.gateB.dropFirstPing = true
  env.logs.length = 0
  env.clock.advance(5000)
  await env.waitReady()
  assert.equal(env.peerOf().path, 'relay')
  // Slice 1: demoteDirect (30s) + onDirectLost (60s) arms exponential relay hold; stay relay until hold expires
  while (env.clock.now() + KEEPALIVE_MS + 100 < lostAt + 55_000) {
    await env.sample(150)
    assert.equal(env.peerOf().path, 'relay')
  }
  while (env.clock.now() < lostAt + 65_000) {
    await env.sample(150)
  }
  if (env.peerOf().path !== 'lan') await env.sample(150)
  if (env.peerOf().path !== 'lan') await env.sample(150)
  assert.equal(env.peerOf().path, 'lan')
  assert.equal(env.peerOf().directRttMs, 150)
})

test('re-anchoring: changed endpoints re-anchor, unchanged/additive STUN preserve direct, WS reconnect clears reflexive', async (t) => {
  {
    const env = await buildRttPair(t, { cap: 300 })
    await env.waitReady()
    await env.sample(50)
    await env.sample(50)
    assert.equal(env.peerOf().path, 'lan')

    let oldEpFrames = 0
    env.socketB.on('message', () => { oldEpFrames += 1 })
    env.logs.length = 0
    env.gateway.send({
      type: 'punch-coordinate',
      peerNodeId: env.identityB.nodeId,
      publicKeyHex: env.identityB.publicKeyHex,
      lanEndpoints: ['127.0.0.1:1'],
      reflexiveEndpoint: null,
    })
    await waitFor(() => env.logs.some((line) => line.includes('re-anchored')), 're-anchored log')
    assert.equal(env.peerOf().path, 'relay')
    assert.equal(env.peerOf().directRttMs, null)
    env.clock.advance(1200)
    await waitFor(() => env.logs.some((line) => /punch fallback .+ \(window expired\)/.test(line)), 'window expired fallback')

    const socketB2 = await openUdp()
    const mgrB2 = new PeerPunchManager({
      networkId: NET_ID, identity: env.identityB, socket: makeGate(socketB2), clock: env.clock,
      keepAliveMs: KEEPALIVE_MS, keepAliveLostFrames: 3, reprobeIntervalMs: 800,
    })
    await mgrB2.ready()
    t.after(async () => { const c = waitClose(socketB2); mgrB2.close(); await c })
    mgrB2.beginPunch({ peerNodeId: env.identityA.nodeId, peerPublicKeyHex: env.identityA.publicKeyHex, lanEndpoints: [] })
    env.gateway.send({
      type: 'punch-coordinate',
      peerNodeId: env.identityB.nodeId,
      publicKeyHex: env.identityB.publicKeyHex,
      lanEndpoints: [endpointOf(socketB2)],
      reflexiveEndpoint: null,
    })
    await env.waitReady()
    const framesAfterReady = oldEpFrames
    env.clock.advance(6000)
    await sleep(30)
    assert.equal(oldEpFrames, framesAfterReady)
  }

  {
    const env = await buildRttPair(t, { cap: 0 })
    await env.waitReady()
    assert.equal(env.peerOf().path, 'lan')
    env.logs.length = 0
    env.gateway.send({
      type: 'punch-coordinate',
      peerNodeId: env.identityB.nodeId,
      publicKeyHex: env.identityB.publicKeyHex,
      lanEndpoints: [endpointOf(env.socketB)],
      reflexiveEndpoint: '203.0.113.5:4000',
    })
    await sleep(40)
    assert.equal(env.peerOf().path, 'lan')
    assert.equal(env.logs.some((line) => line.includes('re-anchored')), false)

    env.logs.length = 0
    env.reconnectCalls.length = 0
    env.gateB.dropAll = true
    env.gateway.dropConnections()
    await waitFor(() => env.engine.status().gatewayState === 'offline', 'ws offline')
    env.clock.advance(1100)
    await waitFor(() => env.engine.status().gatewayState === 'authorized', 'ws reconnected')
    assert.ok(env.logs.some((l) => l.includes('re-anchored')))
    const bpLog = env.logs.filter((l) => l.includes(`beginPunch(${env.identityB.nodeId})`)).at(-1)
    assert.match(bpLog, /candidates=1 /, 'stale reflexiveEndpoint cleared on explicit null')
    env.gateB.dropAll = false
    env.clock.advance(5000)
    await waitFor(() => env.peerOf().path === 'lan', 'direct recovers')
    assert.ok(env.reconnectCalls.includes(env.identityB.nodeId))
  }
})

test('T3: pure UDP rebind preserves MuxSession while connSeq/WS reconnect reset it; networkId switch isolates state', async (t) => {
  let currentPeerConnSeq = 10
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-t3-seq-'))
  const clock = manualClock()
  const logs = []
  const stateFileA = path.join(home, 'a-state.json')
  const socketA = await openUdp()
  const identityA = ensurePeerIdentity(stateFileA)
  const socketB = await openUdp()
  const identityB = generatePeerIdentity()
  const sockets = []
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    sockets.push(socket)
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const parsed = readClientFrame(buf)
        if (!parsed) break
        buf = parsed.rest
        if (parsed.opcode === 8) { socket.end(); return }
        if (parsed.opcode === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, parsed.payload.length]), parsed.payload])); continue }
        if (parsed.opcode !== 1) continue
        let msg
        try { msg = JSON.parse(parsed.payload.toString('utf8')) } catch { continue }
        if (msg?.type === 'auth') {
          socket.write(wsFrame({
            type: 'welcome', status: 'authorized', connSeq: 1, maxPeers: 8,
            peers: [{ nodeId: identityB.nodeId, publicKeyHex: identityB.publicKeyHex, name: 'peer-B', lanEndpoints: [endpointOf(socketB)], reflexiveEndpoint: null, connSeq: currentPeerConnSeq }],
          }))
        }
      }
    })
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`), wsFrame({ type: 'challenge', challengeHex: 'a1b2c3d4e5f60718' })]))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  let mountedFetch = null
  const engine = createPeerEngine({
    stateFile: stateFileA, identity: identityA,
    relayPool: {
      maxServers: () => 8,
      mountVirtual: (input) => { mountedFetch = input.fetchImpl; return { entryId: input.entryId, serverId: input.serverId, serverName: input.serverName, displayName: input.serverName } },
      unmountVirtual: () => true, updateVirtualName: () => true, reconnect: () => Promise.resolve(true),
    },
    relayHandler: () => undefined, relaySecret: () => 'test', serverName: () => 'node-A',
    udpSocket: socketA, udpProbe: null, clock, log: (line) => logs.push(line), directMaxRttMs: () => 0,
    punch: { keepAliveMs: KEEPALIVE_MS, keepAliveLostFrames: 3, reprobeIntervalMs: 800 },
  })
  const mgrB = new PeerPunchManager({ networkId: NET_ID, identity: identityB, socket: socketB, clock, keepAliveMs: KEEPALIVE_MS, keepAliveLostFrames: 3, reprobeIntervalMs: 800 })
  await mgrB.ready()
  writePeerNetwork(stateFileA, { gatewayWsUrl: `ws://127.0.0.1:${port}`, gatewayHttpOrigin: `http://127.0.0.1:${port}`, networkId: NET_ID, joinedAt: 1 })
  t.after(async () => {
    mgrB.close(); engine.stop()
    for (const s of sockets) s.destroy()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  })
  mgrB.beginPunch({ peerNodeId: identityA.nodeId, peerPublicKeyHex: identityA.publicKeyHex, lanEndpoints: [] })
  engine.resumeFromState()
  await waitFor(() => logs.some((l) => l.includes('direct ready')), 'initial direct ready')

  let hangingSettled = false
  const hangingFetch = mountedFetch('http://peer/hang')
  hangingFetch.then(() => { hangingSettled = true }, () => { hangingSettled = true })
  await sleep(10)

  for (const s of sockets) if (!s.destroyed) s.write(wsFrame({ type: 'punch-coordinate', peerNodeId: identityB.nodeId, publicKeyHex: identityB.publicKeyHex, lanEndpoints: ['127.0.0.1:19999'], reflexiveEndpoint: null, connSeq: 10 }))
  await waitFor(() => logs.some((l) => l.includes('re-anchored') && l.includes('endpoints changed')), 'pure UDP rebind')
  assert.equal(hangingSettled, false)

  currentPeerConnSeq = 11
  for (const s of sockets) if (!s.destroyed) s.write(wsFrame({ type: 'punch-coordinate', peerNodeId: identityB.nodeId, publicKeyHex: identityB.publicKeyHex, lanEndpoints: [endpointOf(socketB)], reflexiveEndpoint: null, connSeq: 11 }))
  await assert.rejects(hangingFetch, /peer session reset/)

  const hangingFetchAfterWs = mountedFetch('http://peer/hang-ws')
  hangingFetchAfterWs.catch(() => {})
  await sleep(10)
  for (const s of sockets) s.destroy()
  await waitFor(() => engine.status().gatewayState === 'offline', 'ws offline')
  clock.advance(1100)
  await waitFor(() => engine.status().gatewayState === 'authorized', 'ws reconnected')
  await assert.rejects(hangingFetchAfterWs, /peer session reset/)

  // Network switch clears disabledNodes / gateway caps.
  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-t3-netiso-'))
  t.after(() => fs.rmSync(otherHome, { recursive: true, force: true }))
  const otherState = path.join(otherHome, 'state.json')
  const otherPool = createRelayPool({ stateFile: otherState, skipPersistedServers: true, computeOwnFingerprints: () => ({}), createClient: () => ({ state: 'online', subscribe: () => () => {}, connect: async () => {}, stop() {} }) })
  const isoEngine = createPeerEngine({ stateFile: otherState, identity: ensurePeerIdentity(otherState), relayPool: otherPool, relayHandler: () => undefined, relaySecret: () => 'test', serverName: () => 'iso', udpProbe: null })
  t.after(() => { isoEngine.stop(); otherPool.stop() })
  writePeerNetwork(otherState, { gatewayWsUrl: 'ws://127.0.0.1:1', gatewayHttpOrigin: 'http://127.0.0.1:1', networkId: '1111111111111111', joinedAt: 1, disabledNodes: ['deadbeef'], maxPeersFromGateway: 12, peerDirectMaxRttMsFromGateway: 80 })
  assert.deepEqual(await isoEngine.joinNetwork('zr-net://127.0.0.1:1/2222222222222222#secret'), { ok: true })
  const afterOther = readPeerNetwork(otherState)
  assert.equal(afterOther.disabledNodes, undefined)
  assert.equal(afterOther.maxPeersFromGateway, undefined)
  assert.equal(afterOther.peerDirectMaxRttMsFromGateway, undefined)
  assert.equal(isoEngine.status().directCapMs, 300)
})

// -- 4. STUN probing lifecycle & gateway control signaling (from peer-production-stun + signaling unit tests) --

async function startFakeWsGateway() {
  const sockets = []
  let welcome = null
  let upgrades = 0
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, data: { removed: true } }))
  })
  server.on('upgrade', (req, socket) => {
    upgrades += 1
    sockets.push(socket)
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const parsed = readClientFrame(buf)
        if (!parsed) break
        buf = parsed.rest
        if (parsed.opcode === 8) { socket.end(Buffer.from([0x88, 0])); return }
        if (parsed.opcode === 9 && parsed.payload.length < 126) {
          socket.write(Buffer.concat([Buffer.from([0x8a, parsed.payload.length]), parsed.payload]))
        }
      }
    })
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    if (welcome !== null) socket.write(wsFrame(welcome))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  return {
    port: server.address().port,
    set welcome(value) { welcome = value },
    upgradeCount: () => upgrades,
    send(msg) { const s = sockets.at(-1); if (s && !s.destroyed) s.write(wsFrame(msg)) },
    dropCurrentConnection() { sockets.at(-1)?.destroy() },
    resendWelcome() { const s = sockets.at(-1); if (s && welcome !== null) s.write(wsFrame(welcome)) },
    close: async () => { for (const s of sockets.splice(0)) s.destroy(); await new Promise((resolve) => server.close(resolve)) },
  }
}

async function startProbeListener() {
  const packets = []
  const sock = dgram.createSocket('udp4')
  sock.on('message', (buf, rinfo) => {
    let parsed = null
    try { parsed = JSON.parse(buf.toString('utf8')) } catch { /* ignore */ }
    packets.push({ parsed, rinfo })
  })
  await new Promise((resolve, reject) => {
    sock.once('error', reject)
    sock.bind(0, '127.0.0.1', () => { sock.removeAllListeners('error'); resolve() })
  })
  const replyNonce = (nonce, reflexivePort = 40000) => {
    const hit = packets.find((p) => p.parsed?.type === 'stun-probe' && p.parsed.nonce === nonce)
    if (!hit) return false
    sock.send(Buffer.from(JSON.stringify({ type: 'stun-reply', nonce, reflexiveIp: '127.0.0.1', reflexivePort, serverPortRole: 'primary' })), hit.rinfo.port, hit.rinfo.address, () => {})
    return true
  }
  return { port: sock.address().port, packets, replyNonce, close: () => new Promise((resolve) => sock.close(resolve)) }
}

async function startBareNode(t, gateway, { udpProbe } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-bare-node-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const stateFile = path.join(home, 'zen-remote-state.json')
  const identity = ensurePeerIdentity(stateFile)
  const networkId = randomHex(8)
  writePeerNetwork(stateFile, {
    gatewayWsUrl: `ws://127.0.0.1:${gateway.port}`,
    gatewayHttpOrigin: `http://127.0.0.1:${gateway.port}`,
    networkId,
    joinedAt: 1,
  })
  const logs = []
  const engine = createPeerEngine({
    stateFile,
    identity,
    relayPool: { maxServers: () => 8 },
    relayHandler: () => undefined,
    relaySecret: () => 'test',
    serverName: () => 'bare',
    stunProbeTimeoutMs: 120,
    wsReconnectBaseMs: 40,
    ...(udpProbe === undefined ? {} : { udpProbe }),
    log: (line) => logs.push(line),
  })
  t.after(() => engine.stop())
  engine.resumeFromState()
  return { engine, logs, networkId, stateFile }
}

const authorizedWelcome = (extra = {}) => ({ type: 'welcome', status: 'authorized', maxPeers: 8, peers: [], ...extra })

test('PC-01b: missing/malformed welcome stun degrades to unknown; explicit udpProbe null/object overrides work', async (t) => {
  const gateway = await startFakeWsGateway()
  const listener = await startProbeListener()
  t.after(async () => { await listener.close(); await gateway.close() })

  gateway.welcome = authorizedWelcome()
  const n1 = await startBareNode(t, gateway)
  await waitFor(() => n1.engine.status().gatewayState === 'authorized', 'n1 auth')
  await waitFor(() => n1.engine.status().natType === 'unknown', 'n1 unknown')
  await sleep(30)
  assert.equal(listener.packets.length, 0)
  assert.ok(n1.logs.some((l) => /stun/i.test(l)))
  n1.engine.stop()

  for (const bad of ['x', 42, [], {}, { primaryPort: 0 }, { primaryPort: 70000 }, { primaryPort: 8080.5 }, { primaryPort: '8080' }, { primaryPort: 8080, altPort: 0 }, { primaryPort: 8080, altPort: 'x' }]) {
    gateway.welcome = authorizedWelcome({ stun: bad })
    const nb = await startBareNode(t, gateway)
    await waitFor(() => nb.engine.status().natType === 'unknown', `bad stun ${JSON.stringify(bad)}`)
    nb.engine.stop()
  }
  assert.equal(listener.packets.length, 0)

  gateway.welcome = authorizedWelcome({ stun: { primaryPort: listener.port, altPort: null } })
  const nNull = await startBareNode(t, gateway, { udpProbe: null })
  await waitFor(() => nNull.engine.status().gatewayState === 'authorized', 'nNull auth')
  await sleep(30)
  assert.equal(listener.packets.length, 0)
  assert.equal(nNull.engine.status().natType, null)
  nNull.engine.stop()

  const welcomeListener = await startProbeListener()
  t.after(() => welcomeListener.close())
  gateway.welcome = authorizedWelcome({ stun: { primaryPort: welcomeListener.port, altPort: null } })
  const nOverride = await startBareNode(t, gateway, { udpProbe: { primaryPort: listener.port, altPort: 0 } })
  await waitFor(() => listener.packets.length >= 1, 'explicit udpProbe receives packet')
  await sleep(30)
  assert.equal(welcomeListener.packets.length, 0)
  assert.equal(listener.packets[0].parsed.type, 'stun-probe')
  assert.equal(listener.packets[0].parsed.networkId, nOverride.networkId)
})

test('PC-01b/fix1: STUN follows WS connection generation, deduplicates resend, drops stale replies & honors leave/stop/rejoin', async (t) => {
  const gateway = await startFakeWsGateway()
  const listener1 = await startProbeListener()
  const listener2 = await startProbeListener()
  t.after(async () => { await listener2.close(); await listener1.close(); await gateway.close() })

  gateway.welcome = authorizedWelcome({ stun: { primaryPort: listener1.port, altPort: listener2.port } })
  const node = await startBareNode(t, gateway)
  await waitFor(() => listener1.packets.length >= 1 && listener2.packets.length >= 1, 'initial probe')
  const staleNonce1 = listener1.packets[0].parsed.nonce
  const staleNonce2 = listener2.packets[0].parsed.nonce

  gateway.welcome = authorizedWelcome({ stun: { primaryPort: listener2.port, altPort: null } })
  gateway.dropCurrentConnection()
  await waitFor(() => node.engine.status().gatewayState === 'offline', 'offline observed')
  await waitFor(() => node.engine.status().gatewayState === 'authorized', 're-authorized')
  assert.equal(gateway.upgradeCount(), 2)
  await waitFor(() => listener2.packets.length >= 2, 're-probed on new port')

  gateway.resendWelcome()
  await sleep(40)
  assert.equal(listener2.packets.length, 2, 'duplicate welcome on same WS does not re-probe')

  await waitFor(() => node.engine.status().natType === 'unknown', 'fresh probe times out at 120ms')
  listener1.replyNonce(staleNonce1, 43000)
  listener2.replyNonce(staleNonce2, 44000)
  await sleep(40)
  assert.equal(node.engine.status().natType, 'unknown', 'stale probe reply ignored')

  // Rejoin with legacy zr-net+insecure:// and leaveNetwork/stop expiry protection.
  const newNet = randomHex(8)
  gateway.welcome = authorizedWelcome({ stun: { primaryPort: listener1.port, altPort: listener2.port } })
  await node.engine.joinNetwork(`zr-net+insecure://127.0.0.1:${gateway.port}/${newNet}#legacy-key`)
  await waitFor(() => node.engine.status().gatewayState === 'authorized', 'joined new network')
  await waitFor(() => listener1.packets.some((p) => p.parsed.nonce !== staleNonce1), 'fresh probe after rejoin')
  await node.engine.leaveNetwork()
  assert.equal(node.engine.status().natType, null)
  await sleep(160) // past 120ms stunProbeTimeoutMs
  assert.equal(node.engine.status().natType, null, 'late leave result does not land')
})

test('gateway control signaling: manual pending, paused/resume & denied/removed revocation notice', async (t) => {
  const gateway = await startFakeWsGateway()
  t.after(() => gateway.close())

  gateway.welcome = { type: 'welcome', status: 'pending', maxPeers: 8, peers: [] }
  const node = await startBareNode(t, gateway, { udpProbe: null })
  await waitFor(() => node.engine.status().gatewayState === 'pending-approval', 'pending-approval')

  gateway.send({ type: 'welcome', status: 'authorized', maxPeers: 8, peers: [] })
  await waitFor(() => node.engine.status().gatewayState === 'authorized', 'approved to authorized')

  gateway.send({ type: 'paused' })
  await waitFor(() => node.engine.status().gatewayState === 'paused', 'paused via control message')

  gateway.send({ type: 'welcome', status: 'authorized', maxPeers: 4, peers: [] })
  await waitFor(() => node.engine.status().gatewayState === 'authorized', 'resumed to authorized')
  assert.equal(node.engine.status().maxPeers, 4)

  gateway.send({ type: 'denied', reason: 'removed' })
  await waitFor(() => node.engine.status().gatewayState === 'revoked', 'revoked')
  assert.ok(readPeerRevokedNotice(node.stateFile), 'revoked notice persisted')
})

function makeP2pNatSocket(realSocket, clock) {
  const pingSends = []
  const origOn = realSocket.on.bind(realSocket)
  const wrapper = {
    pingSends,
    send(buf, offset, length, port, host, cb) {
      if (typeof length === 'string') {
        cb = port; host = length; port = offset; offset = 0; length = buf.length
      }
      const actualHost = host === '203.0.113.2' ? '127.0.0.1' : host
      if (length >= 4 && buf[offset + 3] === PeerFrameType.PING) pingSends.push(clock.now())
      realSocket.send(buf, offset, length, port, actualHost, cb)
    },
    on(event, listener) {
      if (event === 'message') {
        return origOn('message', (buf, rinfo) => {
          listener(buf, { ...rinfo, address: rinfo.address === '127.0.0.1' ? '203.0.113.2' : rinfo.address })
        })
      }
      return origOn(event, listener)
    },
    once: (...args) => realSocket.once(...args),
    removeListener: (...args) => realSocket.removeListener(...args),
    address: () => realSocket.address(),
    unref: () => realSocket.unref(),
    ref: () => realSocket.ref(),
    bind: (...args) => realSocket.bind(...args),
    close: () => realSocket.close(),
  }
  return wrapper
}

test('T2: onPeerRelayDemoted syncs member state, restores relay ARQ profile, and preserves UDP ciphers; resetPeerForReanchor(false) restores relay ARQ profile', async (t) => {

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-t2-engine-'))
  const clock = manualClock(Date.now())
  const logs = []
  const stateFileA = path.join(home, 'a-state.json')
  const identityA = ensurePeerIdentity(stateFileA)
  const identityB = generatePeerIdentity()
  const rawSocketA = await openUdp()
  const natSocketA = makeP2pNatSocket(rawSocketA, clock)
  const socketB = await openUdp()
  const gateB = makeGate(socketB)

  const wsSockets = []
  let onBinaryFromEngine = null
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    wsSockets.push(socket)
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const parsed = readClientFrame(buf)
        if (!parsed) break
        buf = parsed.rest
        if (parsed.opcode === 8) { socket.end(); return }
        if (parsed.opcode === 9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, parsed.payload.length]), parsed.payload]))
          continue
        }
        if (parsed.opcode === 2) {
          onBinaryFromEngine?.(Buffer.from(parsed.payload))
          continue
        }
        if (parsed.opcode !== 1) continue
        let msg
        try { msg = JSON.parse(parsed.payload.toString('utf8')) } catch { continue }
        if (msg?.type === 'auth') {
          socket.write(wsFrame({
            type: 'welcome', status: 'authorized', connSeq: 1, maxPeers: 8,
            peers: [{
              nodeId: identityB.nodeId,
              publicKeyHex: identityB.publicKeyHex,
              name: 'peer-B',
              lanEndpoints: [`203.0.113.2:${socketB.address().port}`],
              reflexiveEndpoint: null,
              connSeq: 1,
            }],
          }))
        }
      }
    })
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(Buffer.concat([
      Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
      wsFrame({ type: 'challenge', challengeHex: 'a1b2c3d4e5f60718' }),
    ]))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const sendWsBinaryToEngine = (bytes) => {
    const payload = Buffer.from(bytes)
    let hdr
    if (payload.length < 126) hdr = Buffer.from([0x82, payload.length])
    else {
      hdr = Buffer.alloc(4)
      hdr[0] = 0x82; hdr[1] = 126; hdr.writeUInt16BE(payload.length, 2)
    }
    for (const s of wsSockets) if (!s.destroyed) s.write(Buffer.concat([hdr, payload]))
  }

  let dropBInboundFromA = false
  let holdBDataFrames = false
  const heldDataFrames = []
  let mountedFetch = null
  let engine = null
  let muxB = null

  const engineRelayFrames = []
  onBinaryFromEngine = (bytes) => {
    const h = decodeFrameHeader(bytes)
    if (h && h.frameType === PeerFrameType.DATA) {
      engineRelayFrames.push(h)
      if (holdBDataFrames) {
        heldDataFrames.push(bytes)
        return
      }
    }
    muxB?.handleGatewayFrame(bytes)
  }

  muxB = new PeerMux({
    networkId: NET_ID,
    identity: identityB,
    clock,
    sendGatewayBinary: (bytes) => sendWsBinaryToEngine(bytes),
    relayHandler: () => async (req, res) => {
      for await (const _ of req) { /* drain */ }
      res.end('ok-from-b')
    },
    relaySecret: () => 'test',
  })
  muxB.ensureSession(identityA.nodeId, identityA.publicKeyHex, 'node-A')

  const mgrB = new PeerPunchManager({
    networkId: NET_ID,
    identity: identityB,
    socket: gateB,
    clock,
    keepAliveMs: KEEPALIVE_MS,
    keepAliveLostFrames: 3,
    reprobeIntervalMs: 800,
    onEncryptedFrame: (header, plaintext) => {
      if (!dropBInboundFromA) muxB.handleOpenedFrame(header, plaintext)
    },
  })
  await mgrB.ready()

  engine = createPeerEngine({
    stateFile: stateFileA,
    identity: identityA,
    relayPool: {
      maxServers: () => 8,
      mountVirtual: (input) => { mountedFetch = input.fetchImpl; return { entryId: input.entryId, serverId: input.serverId, serverName: input.serverName, displayName: input.serverName } },
      unmountVirtual: () => true,
      updateVirtualName: () => true,
      reconnect: () => Promise.resolve(true),
    },
    relayHandler: () => async (req, res) => {
      for await (const _ of req) { /* drain */ }
      res.end('ok-from-a')
    },
    relaySecret: () => 'test',
    serverName: () => 'node-A',
    udpSocket: natSocketA,
    udpProbe: null,
    clock,
    log: (line) => logs.push(line),
    directMaxRttMs: () => 0,
    punch: { keepAliveMs: KEEPALIVE_MS, keepAliveLostFrames: 3, reprobeIntervalMs: 800 },
  })
  writePeerNetwork(stateFileA, {
    gatewayWsUrl: `ws://127.0.0.1:${port}`,
    gatewayHttpOrigin: `http://127.0.0.1:${port}`,
    networkId: NET_ID,
    joinedAt: 1,
  })
  t.after(async () => {
    mgrB.close(); muxB.close(); engine.stop()
    for (const s of wsSockets) s.destroy()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  })

  // Establish WS relay ciphers first, then direct UDP 'p2p' path
  mgrB.beginPunch({ peerNodeId: identityA.nodeId, peerPublicKeyHex: identityA.publicKeyHex, lanEndpoints: [] })
  engine.resumeFromState()
  await waitFor(() => engine.status().peers[0]?.path === 'p2p', 'initial p2p path')
  await waitFor(() => wsSockets.length >= 1, 'engine ws connected')
  muxB.enableRelayPath(identityA.nodeId)
  await waitFor(() => muxB.sessionPath(identityA.nodeId) !== 'none' && muxB.sessions.get(identityA.nodeId)?.ciphers !== null, 'muxB WS ciphers ready')
  muxB.setDirectPath(identityA.nodeId, mgrB.frameSenderFor(identityA.nodeId))
  clock.advance(500)

  // Part 1: resetPeerForReanchor(..., false) must restore relay ARQ window=64 (not leave p2p window=16)
  for (const s of wsSockets) {
    if (!s.destroyed) {
      s.write(wsFrame({
        type: 'punch-coordinate',
        peerNodeId: identityB.nodeId,
        publicKeyHex: identityB.publicKeyHex,
        lanEndpoints: ['203.0.113.2:19999'],
        reflexiveEndpoint: null,
        connSeq: 1,
      }))
    }
  }
  await waitFor(() => logs.some((l) => l.includes('re-anchored') && l.includes('endpoints changed')), 'pure UDP rebind')
  assert.equal(engine.status().peers[0].path, 'relay')

  engineRelayFrames.length = 0
  holdBDataFrames = true
  const reanchorUpload = mountedFetch('http://peer/burst-1', { method: 'POST', body: Buffer.alloc(25 * 1100, 0x41) })
  reanchorUpload.catch(() => {})
  await waitFor(() => engineRelayFrames.length >= 16, 'burst frames sent over WS')
  await sleep(30)
  assert.ok(engineRelayFrames.length >= 25, `resetPeerForReanchor(false) must restore relay window=64, sent ${engineRelayFrames.length}`)
  holdBDataFrames = false
  for (const f of heldDataFrames.splice(0)) muxB.handleGatewayFrame(f)
  assert.equal(await (await reanchorUpload).text(), 'ok-from-b')

  // Part 2: Re-promote to p2p, then B unilaterally demotes to WS while A->B UDP is blackholed
  const socketB2 = await openUdp()
  const gateB2 = makeGate(socketB2)
  mgrB.close()
  const mgrB2 = new PeerPunchManager({
    networkId: NET_ID,
    identity: identityB,
    socket: gateB2,
    clock,
    keepAliveMs: KEEPALIVE_MS,
    keepAliveLostFrames: 3,
    reprobeIntervalMs: 800,
    onEncryptedFrame: (header, plaintext) => {
      if (!dropBInboundFromA) muxB.handleOpenedFrame(header, plaintext)
    },
  })
  await mgrB2.ready()
  t.after(() => mgrB2.close())
  mgrB2.beginPunch({ peerNodeId: identityA.nodeId, peerPublicKeyHex: identityA.publicKeyHex, lanEndpoints: [`127.0.0.1:${rawSocketA.address().port}`] })
  for (const s of wsSockets) {
    if (!s.destroyed) {
      s.write(wsFrame({
        type: 'punch-coordinate',
        peerNodeId: identityB.nodeId,
        publicKeyHex: identityB.publicKeyHex,
        lanEndpoints: [`203.0.113.2:${socketB2.address().port}`],
        reflexiveEndpoint: null,
        connSeq: 1,
      }))
    }
  }
  await waitFor(
    () => engine.status().peers[0]?.path === 'p2p' && mgrB2.peerState(identityA.nodeId)?.state === 'direct',
    'both sides promoted to direct p2p',
  )
  muxB.setDirectPath(identityA.nodeId, mgrB2.frameSenderFor(identityA.nodeId))
  // Advance past the 400ms direct promotion grace window so B's subsequent WS fallback is treated as genuine
  clock.advance(500)

  // B unilaterally switches to WS and sends request while A's UDP is dead
  gateB2.dropAll = true
  dropBInboundFromA = true
  muxB.setRelayPath(identityA.nodeId)
  const bRes = await muxB.createFetchForPeer(identityA.nodeId)('http://peer/from-b')
  assert.equal(await bRes.text(), 'ok-from-a')

  const peerAfter = engine.status().peers[0]
  assert.equal(peerAfter.path, 'relay')
  assert.equal(peerAfter.directDemoted, true)
  assert.equal(peerAfter.directDemoteReason, 'peer-relay')
  assert.equal(peerAfter.rttMs, null)

  // UDP keepalive & ciphers on A must stay alive (never wiping ciphers into a blackhole)
  const pingsBefore = natSocketA.pingSends.length
  clock.advance(KEEPALIVE_MS)
  await sleep(10)
  assert.ok(natSocketA.pingSends.length > pingsBefore, 'onPeerRelayDemoted must preserve UDP session & keepalive')

  // ARQ window must also be restored to 64 (not stuck at p2p's 16)
  engineRelayFrames.length = 0
  holdBDataFrames = true
  const afterDemoteUpload = mountedFetch('http://peer/burst-2', { method: 'POST', body: Buffer.alloc(25 * 1100, 0x42) })
  afterDemoteUpload.catch(() => {})
  await waitFor(() => engineRelayFrames.length >= 16, 'burst-2 frames sent over WS')
  await sleep(30)
  assert.ok(engineRelayFrames.length >= 25, `onPeerRelayDemoted must restore relay window=64, sent ${engineRelayFrames.length}`)
  holdBDataFrames = false
  for (const f of heldDataFrames.splice(0)) muxB.handleGatewayFrame(f)
  assert.equal(await (await afterDemoteUpload).text(), 'ok-from-b')

  // Late UDP frames from B must still decrypt cleanly on A without blackholing
  gateB2.dropAll = false
  dropBInboundFromA = false
  muxB.setDirectPath(identityA.nodeId, mgrB2.frameSenderFor(identityA.nodeId))
  const ac = new AbortController()
  const guard = setTimeout(() => ac.abort(new Error('late UDP request timed out')), 2_000)
  try {
    const lateUdpRes = await muxB.createFetchForPeer(identityA.nodeId)('http://peer/late-udp-after-demote', { signal: ac.signal })
    assert.equal(await lateUdpRes.text(), 'ok-from-a')
  } finally {
    clearTimeout(guard)
  }
  assert.equal(engine.status().peers[0]?.path, 'relay', 'A keeps replying over WS without blackholing inbound UDP')
})

test('T1 version-sync: parseSemver, compareSemver (with prerelease), evaluatePeerVersionSync, and sanitizeConsoleOrigin', () => {
  assert.equal(PEER_WIRE_COMPAT_LEVEL, 1)
  assert.equal(INFERRED_LEGACY_GATEWAY_VERSION, '0.1.0')

  // Invalid semver rejected by parseSemver
  assert.equal(parseSemver(null), null)
  assert.equal(parseSemver(''), null)
  assert.equal(parseSemver('1.2'), null)
  assert.equal(parseSemver('01.2.3'), null)
  assert.equal(parseSemver('1.2.3.4'), null)
  assert.equal(parseSemver('not-a-version'), null)

  // Valid semver & prerelease ordering
  assert.equal(compareSemver('0.1.0', '0.2.0'), -1)
  assert.equal(compareSemver('0.2.0', '0.1.0'), 1)
  assert.equal(compareSemver('0.2.0', '0.2.0'), 0)
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-1'), 1)
  assert.equal(compareSemver('1.0.0-1', '1.0.0-alpha'), -1)
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1)
  assert.equal(compareSemver('1.0.0-beta', '1.0.0'), -1)
  assert.equal(compareSemver('2.5.1+build.9', '2.5.1'), 0)

  // Missing gatewayVersion infers legacy 0.1.0 and sets gatewayOutdated
  const legacySync = evaluatePeerVersionSync({
    pluginVersion: '2.5.1',
    recommendedGatewayVersion: '0.2.0',
    gatewayVersion: null,
    recommendedPluginVersion: null,
    maxPeerPluginVersion: null,
    gatewayWireCompatLevel: null,
  })
  assert.equal(legacySync.gatewayVersion, '0.1.0')
  assert.equal(legacySync.inferredLegacyGateway, true)
  assert.equal(legacySync.gatewayOutdated, true)
  assert.equal(legacySync.pluginOutdated, false)
  assert.equal(legacySync.newerPluginVersion, null)
  assert.equal(legacySync.wireCompatLevel, 1)

  // Plugin patch bump does NOT falsely trigger gatewayOutdated when gateway matches recommendedGatewayVersion
  const patchPluginSync = evaluatePeerVersionSync({
    pluginVersion: '2.5.2',
    recommendedGatewayVersion: '0.2.0',
    gatewayVersion: '0.2.0',
    recommendedPluginVersion: '2.5.1',
    maxPeerPluginVersion: '2.5.2',
    gatewayWireCompatLevel: 1,
  })
  assert.equal(patchPluginSync.gatewayVersion, '0.2.0')
  assert.equal(patchPluginSync.inferredLegacyGateway, false)
  assert.equal(patchPluginSync.gatewayOutdated, false)
  assert.equal(patchPluginSync.pluginOutdated, false)
  assert.equal(patchPluginSync.newerPluginVersion, null)

  // Higher peer or recommended plugin version triggers pluginOutdated and picks max
  const newerPeerSync = evaluatePeerVersionSync({
    pluginVersion: '2.5.1',
    recommendedGatewayVersion: '0.2.0',
    gatewayVersion: '0.2.0',
    recommendedPluginVersion: '2.5.2',
    maxPeerPluginVersion: '2.6.0',
    gatewayWireCompatLevel: 1,
  })
  assert.equal(newerPeerSync.pluginOutdated, true)
  assert.equal(newerPeerSync.newerPluginVersion, '2.6.0')
  assert.equal(newerPeerSync.gatewayOutdated, false)

  // sanitizeConsoleOrigin strips path, query, credentials, and #joinKey; rejects non-http(s)
  assert.equal(
    sanitizeConsoleOrigin('https://user:pass@gw.example.com:8443/networks/abc?foo=1#superSecretJoinKey'),
    'https://gw.example.com:8443',
  )
  assert.equal(sanitizeConsoleOrigin('http://192.168.1.50:19393/#key'), 'http://192.168.1.50:19393')
  assert.equal(sanitizeConsoleOrigin('javascript:alert(1)'), null)
  assert.equal(sanitizeConsoleOrigin('data:text/html,hi'), null)
  assert.equal(sanitizeConsoleOrigin('ws://127.0.0.1:19393'), null)
  assert.equal(sanitizeConsoleOrigin('not a url'), null)

  // versionDismissKey scopes by kind, sanitized origin, and target version
  const k1 = versionDismissKey('gateway', 'https://gw.example.com/path#joinKey', '0.2.0')
  const k2 = versionDismissKey('gateway', 'https://gw.example.com', '0.3.0')
  assert.notEqual(k1, k2)
  assert.ok(!k1.includes('joinKey'))
})

test('T2 ws-version-handshake: legacy 0.1.0 inference, peer-joined pluginOutdated, and version-incompatible stops reconnect', async (t) => {
  const gateway = await startFakeWsGateway()
  t.after(() => gateway.close())

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-t2-engine-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const stateFile = path.join(home, 'zen-remote-state.json')
  const identity = ensurePeerIdentity(stateFile)
  const networkId = randomHex(8)
  writePeerNetwork(stateFile, {
    gatewayWsUrl: `ws://127.0.0.1:${gateway.port}`,
    gatewayHttpOrigin: `http://127.0.0.1:${gateway.port}`,
    networkId,
    joinedAt: 1,
  })

  // 1. Legacy gateway welcome omits gatewayVersion -> inferred 0.1.0 & gatewayOutdated=true
  gateway.welcome = authorizedWelcome()
  const mounted = new Map()
  const engine = createPeerEngine({
    stateFile,
    identity,
    pluginVersion: () => '2.5.1',
    recommendedGatewayVersion: () => '0.2.0',
    relayPool: {
      maxServers: () => 8,
      mountVirtual: (entry) => mounted.set(entry.id, entry),
      unmountVirtual: (id) => mounted.delete(id),
      updateVirtualName: () => {},
      reconnect: () => {},
    },
    relayHandler: () => undefined,
    relaySecret: () => 'test',
    serverName: () => 't2-node',
    udpProbe: null,
    wsReconnectBaseMs: 30,
  })
  t.after(() => engine.stop())
  engine.resumeFromState()
  await waitFor(() => engine.status().gatewayState === 'authorized', 'legacy gateway authorized')
  const legacyStatus = engine.status()
  assert.equal(legacyStatus.versionSync.gatewayVersion, '0.1.0')
  assert.equal(legacyStatus.versionSync.inferredLegacyGateway, true)
  assert.equal(legacyStatus.versionSync.gatewayOutdated, true)
  assert.equal(legacyStatus.versionSync.pluginOutdated, false)

  // 2. Upgraded gateway sends gatewayVersion 0.2.0 + peer-joined sends pluginVersion 2.6.0
  gateway.welcome = authorizedWelcome({
    gatewayVersion: '0.2.0',
    recommendedPluginVersion: null,
    wireCompatLevel: 1,
  })
  gateway.dropCurrentConnection()
  await waitFor(() => engine.status().versionSync.gatewayVersion === '0.2.0', 'new gateway version seen')
  assert.equal(engine.status().versionSync.inferredLegacyGateway, false)
  assert.equal(engine.status().versionSync.gatewayOutdated, false)

  const peerId = generatePeerIdentity()
  gateway.send({
    type: 'peer-joined',
    nodeId: peerId.nodeId,
    publicKeyHex: peerId.publicKeyHex,
    name: 'newer-peer',
    lanEndpoints: [],
    reflexiveEndpoint: null,
    pluginVersion: '2.6.0',
    connSeq: 1,
  })
  await waitFor(() => engine.status().peers.length === 1, 'peer-joined recorded')
  const afterJoin = engine.status()
  assert.equal(afterJoin.peers[0].pluginVersion, '2.6.0')
  assert.equal(afterJoin.versionSync.pluginOutdated, true)
  assert.equal(afterJoin.versionSync.newerPluginVersion, '2.6.0')

  // 3. version-incompatible:* sets gatewayState='incompatible' and disables reconnect
  const upgradesBefore = gateway.upgradeCount()
  gateway.send({
    type: 'denied',
    reason: 'version-incompatible:plugin-too-old',
    gatewayVersion: '0.5.0',
  })
  await waitFor(() => engine.status().gatewayState === 'incompatible', 'gatewayState incompatible')
  assert.equal(engine.status().deniedReason, 'version-incompatible:plugin-too-old')
  assert.equal(engine.status().peers.length, 0)
  await sleep(100)
  assert.equal(gateway.upgradeCount(), upgradesBefore, 'version-incompatible must not auto-reconnect')
})

test('fast 200ms follow-up RTT probe promotes under cap=300 without waiting 5s keepalive, and 6s grace absorbs asymmetric peer keepalive skew', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-fast-promote-'))
  const clock = manualClock(Date.now())
  const stateFileA = path.join(home, 'a-state.json')
  const identityA = ensurePeerIdentity(stateFileA)
  const identityB = generatePeerIdentity()
  const socketA = await openUdp()
  const socketB = await openUdp()
  const gateB = makeGate(socketB)
  gateB.dropFirstPing = false
  gateB.pongDelayMs = 10

  const wsSockets = []
  let onBinaryFromEngine = null
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    wsSockets.push(socket)
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const parsed = readClientFrame(buf)
        if (!parsed) break
        buf = parsed.rest
        if (parsed.opcode === 8) { socket.end(); return }
        if (parsed.opcode === 9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, parsed.payload.length]), parsed.payload]))
          continue
        }
        if (parsed.opcode === 2) {
          onBinaryFromEngine?.(Buffer.from(parsed.payload))
          continue
        }
        if (parsed.opcode !== 1) continue
        let msg
        try { msg = JSON.parse(parsed.payload.toString('utf8')) } catch { continue }
        if (msg?.type === 'auth') {
          socket.write(wsFrame({
            type: 'welcome', status: 'authorized', connSeq: 1, maxPeers: 8,
            peers: [{
              nodeId: identityB.nodeId,
              publicKeyHex: identityB.publicKeyHex,
              name: 'peer-B',
              lanEndpoints: [`127.0.0.1:${socketB.address().port}`],
              reflexiveEndpoint: null,
              connSeq: 1,
            }],
          }))
        }
      }
    })
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(Buffer.concat([
      Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
      wsFrame({ type: 'challenge', challengeHex: 'a1b2c3d4e5f60718' }),
    ]))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const sendWsBinaryToEngine = (bytes) => {
    const payload = Buffer.from(bytes)
    let hdr
    if (payload.length < 126) hdr = Buffer.from([0x82, payload.length])
    else {
      hdr = Buffer.alloc(4)
      hdr[0] = 0x82; hdr[1] = 126; hdr.writeUInt16BE(payload.length, 2)
    }
    for (const s of wsSockets) if (!s.destroyed) s.write(Buffer.concat([hdr, payload]))
  }

  let muxB = null
  const engine = createPeerEngine({
    stateFile: stateFileA,
    identity: identityA,
    relayPool: {
      maxServers: () => 8,
      mountVirtual: (input) => ({ entryId: input.entryId, serverId: input.serverId, serverName: input.serverName, displayName: input.serverName }),
      unmountVirtual: () => true,
      updateVirtualName: () => true,
      reconnect: () => Promise.resolve(true),
    },
    relayHandler: () => async (req, res) => {
      for await (const _ of req) { /* drain */ }
      res.end('ok-from-a')
    },
    relaySecret: () => 'test',
    serverName: () => 'node-A',
    udpSocket: socketA,
    udpProbe: null,
    clock,
    directMaxRttMs: () => 300,
    punch: { keepAliveMs: 5_000, keepAliveLostFrames: 3 },
  })
  const mgrB = new PeerPunchManager({
    networkId: NET_ID,
    identity: identityB,
    socket: gateB,
    clock,
    keepAliveMs: 5_000,
    keepAliveLostFrames: 3,
    onEncryptedFrame: (header, plaintext) => {
      muxB?.handleOpenedFrame(header, plaintext)
    },
  })
  await mgrB.ready()
  muxB = new PeerMux({
    networkId: NET_ID,
    identity: identityB,
    clock,
    sendGatewayBinary: (bytes) => sendWsBinaryToEngine(bytes),
    relayHandler: () => undefined,
    relaySecret: () => 'test',
  })
  muxB.ensureSession(identityA.nodeId, identityA.publicKeyHex, 'node-A')
  onBinaryFromEngine = (bytes) => muxB.handleGatewayFrame(bytes)

  writePeerNetwork(stateFileA, {
    gatewayWsUrl: `ws://127.0.0.1:${port}`,
    gatewayHttpOrigin: `http://127.0.0.1:${port}`,
    networkId: NET_ID,
    joinedAt: 1,
  })
  t.after(async () => {
    mgrB.close(); muxB.close(); engine.stop()
    for (const s of wsSockets) s.destroy()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  })

  engine.resumeFromState()
  await waitFor(() => wsSockets.length >= 1 && engine.status().gatewayState === 'authorized', 'engine ws connected')
  mgrB.beginPunch({ peerNodeId: identityA.nodeId, peerPublicKeyHex: identityA.publicKeyHex, lanEndpoints: [`127.0.0.1:${socketA.address().port}`] })
  muxB.enableRelayPath(identityA.nodeId)
  await waitFor(() => muxB.sessionPath(identityA.nodeId) !== 'none', 'muxB WS relay ready')
  await waitFor(() => mgrB.peerState(identityA.nodeId)?.state === 'direct', 'both punch managers direct')
  await sleep(30)

  // Even if initiator's immediate PING hit the cipher-derivation race, two 220ms virtual ticks (<500ms << 5000ms keepalive) complete both RTT samples and promote to lan
  clock.advance(220)
  await sleep(30)
  clock.advance(220)
  await waitFor(() => engine.status().peers[0]?.path === 'lan', 'promoted within <500ms virtual time via fast follow-up probe')

  // Peer stays on WS for 2500ms (> old 400ms, < new 6000ms cap-aware grace): must absorb WS traffic without bouncing back to relay
  clock.advance(2_500)
  const ac = new AbortController()
  const guard = setTimeout(() => ac.abort(new Error('skew-ws fetch timed out')), 2_000)
  try {
    const res = await muxB.createFetchForPeer(identityA.nodeId)('http://peer/skew-ws', { signal: ac.signal })
    assert.equal(await res.text(), 'ok-from-a')
  } finally {
    clearTimeout(guard)
  }
  assert.equal(engine.status().peers[0]?.path, 'lan', '6s grace absorbs asymmetric peer keepalive skew without demoting')
})

function makeControllableUdp(realSocket, shouldDropSend) {
  return {
    send(buf, offset, length, port, host, cb) {
      if (typeof length === 'string') {
        cb = port; host = length; port = offset; offset = 0; length = buf.length
      }
      const slice = buf.subarray(offset, offset + length)
      const hdr = decodeFrameHeader(slice)
      if (shouldDropSend(slice, hdr)) {
        if (typeof cb === 'function') cb()
        return
      }
      realSocket.send(buf, offset, length, port, host, cb)
    },
    on: (...args) => realSocket.on(...args),
    once: (...args) => realSocket.once(...args),
    removeListener: (...args) => realSocket.removeListener(...args),
    address: () => realSocket.address(),
    unref: () => realSocket.unref(),
    ref: () => realSocket.ref(),
    bind: (...args) => realSocket.bind(...args),
    close: () => realSocket.close(),
  }
}

async function buildDualEnginePair(t, { directCap = 300, bHandlerReadyInitially = true, relayHandlerWaitMs } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-t5-dual-'))
  const clock = manualClock(Date.now())
  const logsA = []
  const logsB = []
  const stateFileA = path.join(home, 'a-state.json')
  const stateFileB = path.join(home, 'b-state.json')
  const identityA = ensurePeerIdentity(stateFileA)
  const identityB = ensurePeerIdentity(stateFileB)
  const rawSocketA = await openUdp()
  const rawSocketB = await openUdp()

  const netFilter = {
    dropAtoB: false,
    dropBtoA: false,
    dropBtoAPongs: false,
    dropUdpData: false,
  }

  const udpA = makeControllableUdp(rawSocketA, (_slice, hdr) => {
    if (netFilter.dropAtoB) return true
    if (netFilter.dropUdpData && hdr && hdr.frameType === PeerFrameType.DATA) return true
    return false
  })
  const udpB = makeControllableUdp(rawSocketB, (_slice, hdr) => {
    if (netFilter.dropBtoA) return true
    if (netFilter.dropBtoAPongs && hdr && hdr.frameType === PeerFrameType.PONG) return true
    if (netFilter.dropUdpData && hdr && hdr.frameType === PeerFrameType.DATA) return true
    return false
  })

  const wsSockets = new Set()
  const wsByNode = new Map()
  const writeWsBinary = (socket, bytes) => {
    if (!socket || socket.destroyed) return
    const payload = Buffer.from(bytes)
    let hdr
    if (payload.length < 126) hdr = Buffer.from([0x82, payload.length])
    else {
      hdr = Buffer.alloc(4)
      hdr[0] = 0x82; hdr[1] = 126; hdr.writeUInt16BE(payload.length, 2)
    }
    socket.write(Buffer.concat([hdr, payload]))
  }

  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    wsSockets.add(socket)
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const parsed = readClientFrame(buf)
        if (!parsed) break
        buf = parsed.rest
        if (parsed.opcode === 8) { socket.end(); return }
        if (parsed.opcode === 9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, parsed.payload.length]), parsed.payload]))
          continue
        }
        if (parsed.opcode === 2) {
          const hdr = decodeFrameHeader(parsed.payload)
          if (hdr) {
            const dst = wsByNode.get(hdr.dstNodeId.toLowerCase())
            writeWsBinary(dst, parsed.payload)
          }
          continue
        }
        if (parsed.opcode !== 1) continue
        let msg
        try { msg = JSON.parse(parsed.payload.toString('utf8')) } catch { continue }
        if (msg?.type === 'auth' && typeof msg.nodeId === 'string') {
          const nid = msg.nodeId.toLowerCase()
          wsByNode.set(nid, socket)
          const other = nid === identityA.nodeId
            ? {
                nodeId: identityB.nodeId,
                publicKeyHex: identityB.publicKeyHex,
                name: 'node-B',
                lanEndpoints: [endpointOf(rawSocketB)],
                reflexiveEndpoint: null,
                connSeq: 1,
                pluginVersion: '2.5.3',
              }
            : {
                nodeId: identityA.nodeId,
                publicKeyHex: identityA.publicKeyHex,
                name: 'node-A',
                lanEndpoints: [endpointOf(rawSocketA)],
                reflexiveEndpoint: null,
                connSeq: 1,
                pluginVersion: '2.5.3',
              }
          socket.write(wsFrame({
            type: 'welcome',
            status: 'authorized',
            connSeq: 1,
            maxPeers: 8,
            peerDirectMaxRttMs: directCap,
            gatewayVersion: '0.2.0',
            wireCompatLevel: 1,
            peers: [other],
          }))
        }
      }
    })
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(Buffer.concat([
      Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
      wsFrame({ type: 'challenge', challengeHex: 'a1b2c3d4e5f60718' }),
    ]))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  let fetchAtoB = null
  let fetchBtoA = null
  const defaultHandlerA = async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.end('ok-from-a')
  }
  const defaultHandlerB = async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.end('ok-from-b')
  }
  let activeHandlerB = bHandlerReadyInitially ? defaultHandlerB : undefined

  const engineA = createPeerEngine({
    stateFile: stateFileA,
    identity: identityA,
    pluginVersion: () => '2.5.3',
    recommendedGatewayVersion: () => '0.2.0',
    relayPool: {
      maxServers: () => 8,
      mountVirtual: (input) => { fetchAtoB = input.fetchImpl; return { entryId: input.entryId, serverId: input.serverId, serverName: input.serverName, displayName: input.serverName } },
      unmountVirtual: () => true,
      updateVirtualName: () => true,
      reconnect: () => Promise.resolve(true),
    },
    relayHandler: () => defaultHandlerA,
    relaySecret: () => 'test',
    serverName: () => 'node-A',
    udpSocket: udpA,
    udpProbe: null,
    clock,
    log: (line) => logsA.push(line),
    directMaxRttMs: () => directCap,
    ...(relayHandlerWaitMs !== undefined ? { relayHandlerWaitMs } : {}),
    punch: { keepAliveMs: 5_000, keepAliveLostFrames: 3 },
  })

  const engineB = createPeerEngine({
    stateFile: stateFileB,
    identity: identityB,
    pluginVersion: () => '2.5.3',
    recommendedGatewayVersion: () => '0.2.0',
    relayPool: {
      maxServers: () => 8,
      mountVirtual: (input) => { fetchBtoA = input.fetchImpl; return { entryId: input.entryId, serverId: input.serverId, serverName: input.serverName, displayName: input.serverName } },
      unmountVirtual: () => true,
      updateVirtualName: () => true,
      reconnect: () => Promise.resolve(true),
    },
    relayHandler: () => activeHandlerB,
    relaySecret: () => 'test',
    serverName: () => 'node-B',
    udpSocket: udpB,
    udpProbe: null,
    clock,
    log: (line) => logsB.push(line),
    directMaxRttMs: () => directCap,
    ...(relayHandlerWaitMs !== undefined ? { relayHandlerWaitMs } : {}),
    punch: { keepAliveMs: 5_000, keepAliveLostFrames: 3 },
  })

  for (const sf of [stateFileA, stateFileB]) {
    writePeerNetwork(sf, {
      gatewayWsUrl: `ws://127.0.0.1:${port}`,
      gatewayHttpOrigin: `http://127.0.0.1:${port}`,
      networkId: NET_ID,
      joinedAt: 1,
    })
  }

  t.after(async () => {
    const cA = waitClose(rawSocketA)
    const cB = waitClose(rawSocketB)
    engineA.stop()
    engineB.stop()
    await Promise.all([cA, cB])
    for (const s of wsSockets) s.destroy()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  })

  engineA.resumeFromState()
  engineB.resumeFromState()
  await waitFor(
    () => wsByNode.size === 2 && logsA.some((l) => l.includes('direct ready')) && logsB.some((l) => l.includes('direct ready')),
    'both engines connected and direct ready',
  )

  const stepClock = async (totalMs, stepMs = 100) => {
    for (let left = totalMs; left > 0; left -= stepMs) {
      clock.advance(Math.min(stepMs, left))
      await sleep(6)
    }
  }

  const sendControlTo = (nodeId, msg) => {
    const s = wsByNode.get(nodeId.toLowerCase())
    if (s && !s.destroyed) s.write(wsFrame(msg))
  }

  return {
    clock,
    stepClock,
    engineA,
    engineB,
    identityA,
    identityB,
    rawSocketA,
    rawSocketB,
    netFilter,
    logsA,
    logsB,
    sendControlTo,
    getFetchAtoB: () => fetchAtoB,
    getFetchBtoA: () => fetchBtoA,
    enableHandlerB: () => { activeHandlerB = defaultHandlerB },
  }
}

test('T5: punch-coordinate preserves pluginVersion, re-anchor suppresses demote beacon, and local/peer 30s cooldown prevents ping-pong until expiry', async (t) => {
  const env = await buildDualEnginePair(t, { directCap: 300 })

  // Both engines converge to direct 'lan' within < 600ms virtual time
  await env.stepClock(500, 100)
  await waitFor(
    () => env.engineA.status().peers[0]?.path === 'lan' && env.engineB.status().peers[0]?.path === 'lan',
    'initial dual direct promotion',
  )
  assert.equal(env.engineA.status().peers[0].pluginVersion, '2.5.3')
  assert.equal(env.engineB.status().peers[0].pluginVersion, '2.5.3')

  // Case 3a: punch-coordinate omitting pluginVersion must preserve existing '2.5.3'
  env.sendControlTo(env.identityA.nodeId, {
    type: 'punch-coordinate',
    peerNodeId: env.identityB.nodeId,
    publicKeyHex: env.identityB.publicKeyHex,
    lanEndpoints: [endpointOf(env.rawSocketB), '127.0.0.1:19999'],
    reflexiveEndpoint: null,
    connSeq: 1,
  })
  await sleep(20)
  assert.equal(env.engineA.status().peers[0].pluginVersion, '2.5.3', 'missing pluginVersion on punch-coordinate must not wipe version')

  // Case 3b: endpoint removal triggers resetPeerForReanchor(..., false) which must NOT send WS demote beacon to B
  env.sendControlTo(env.identityA.nodeId, {
    type: 'punch-coordinate',
    peerNodeId: env.identityB.nodeId,
    publicKeyHex: env.identityB.publicKeyHex,
    lanEndpoints: [endpointOf(env.rawSocketB)],
    reflexiveEndpoint: null,
    connSeq: 1,
  })
  await waitFor(() => env.logsA.some((l) => l.includes('re-anchored') && l.includes('endpoints changed')), 'A re-anchored')
  await sleep(30)
  assert.equal(env.engineB.status().peers[0].directDemoted, false, 're-anchor on A must not send WS demote beacon that marks B demoted')
  assert.equal(env.logsB.some((l) => l.includes('demoted to relay')), false, 'B must not receive peer relay demotion from A re-anchor')
  // Both sides immediately re-promote within <500ms without a 30s peerRelayHoldUntil cooldown
  await waitFor(
    () => env.logsA.filter((l) => l.includes('direct ready')).length >= 2,
    'A direct ready after re-anchor',
  )
  await env.stepClock(450, 100)
  await waitFor(
    () => env.engineA.status().peers[0]?.path === 'lan' && env.engineB.status().peers[0]?.path === 'lan',
    'both A and B re-promote in <500ms after re-anchor without 30s hold',
  )

  // Advance to t=5400ms (just before the 5000ms keepalive tick at t=5500ms after the t=500ms re-anchor)
  await env.stepClock(4_450, 200)
  await waitFor(
    () => env.engineA.status().peers[0]?.path === 'lan' && env.engineB.status().peers[0]?.path === 'lan',
    'both back on lan before asymmetric demotion',
  )

  // Case 1: Induce active demotion on A (drop B->A PONGs for 1 cycle -> ~3s pingRetry demotes A and sends WS beacon to B)
  env.netFilter.dropBtoAPongs = true
  await env.stepClock(3_300, 150)
  await waitFor(
    () => env.engineA.status().peers[0]?.path === 'relay' && env.engineB.status().peers[0]?.path === 'relay',
    'A demoted and B synced to relay with 30s hold',
  )
  assert.equal(env.engineB.status().peers[0].directDemoted, true)

  // Restore UDP and advance 10s (still well inside 30s PEER_RELAY_HOLD_MS cooldown):
  // Neither A nor B may ping-pong back to direct during the 30s cooldown.
  env.netFilter.dropBtoAPongs = false
  await env.stepClock(10_000, 150)
  assert.equal(env.engineA.status().peers[0]?.path, 'relay', 'A must remain on relay during 30s local cooldown')
  assert.equal(env.engineB.status().peers[0]?.path, 'relay', 'B must remain on relay during 30s peer cooldown')

  // Advance past the remaining 30s hold (~25s + keepalive + fast probe): both recover to lan
  await env.stepClock(25_000, 150)
  await waitFor(
    () => env.engineA.status().peers[0]?.path === 'lan' && env.engineB.status().peers[0]?.path === 'lan',
    'both A and B recover to lan once 30s cooldown expires',
  )
  assert.equal(env.engineA.status().peers[0].directDemoted, false)
  assert.equal(env.engineB.status().peers[0].directDemoted, false)
})

test('T5: one-way UDP blackhole and Ping-ok/Data-blackhole both demote symmetrically in ~3-4s via WS demote beacon and recover bidirectional HTTP', async (t) => {
  // Part (a): One-way UDP loss (B -> A dropped while A -> B still reaches B)
  {
    const env = await buildDualEnginePair(t, { directCap: 300 })
    await env.stepClock(500, 100)
    await waitFor(
      () => env.engineA.status().peers[0]?.path === 'lan' && env.engineB.status().peers[0]?.path === 'lan',
      'both promoted to lan',
    )

    // Advance to just before the 5000ms keepalive tick, then blackhole B -> A UDP
    await env.stepClock(4_400, 200)
    env.netFilter.dropBtoA = true

    // Advance 3_300ms (t=5000 tick -> +1500ms retry miss#1 -> +1500ms miss#2 at t=8000, ~3.0s after tick)
    await env.stepClock(3_300, 150)
    await waitFor(
      () => env.engineA.status().peers[0]?.path === 'relay' && env.engineB.status().peers[0]?.path === 'relay',
      'both A and B demote to relay within ~3s of keepalive tick despite one-way A->B UDP keeping B lastSeen fresh',
    )

    const resA = await env.getFetchAtoB()('http://peer/after-oneway-a')
    assert.equal(await resA.text(), 'ok-from-b')
    const resB = await env.getFetchBtoA()('http://peer/after-oneway-b')
    assert.equal(await resB.text(), 'ok-from-a')
  }

  // Part (b): Small PING/PONG pass, but DATA frames are blackholed on UDP + cold-start relayHandlerWaitMs
  {
    const env = await buildDualEnginePair(t, { directCap: 300, bHandlerReadyInitially: false })
    await env.stepClock(500, 100)
    await waitFor(
      () => env.engineA.status().peers[0]?.path === 'lan' && env.engineB.status().peers[0]?.path === 'lan',
      'both promoted to lan',
    )

    // Cold-start request arrives while B's relayHandler is still undefined, then B mounts handler 150ms later
    const coldReq = env.getFetchAtoB()('http://peer/cold-start')
    await env.stepClock(150, 50)
    env.enableHandlerB()
    await env.stepClock(100, 50)
    const coldRes = await coldReq
    assert.equal(coldRes.status, 200, 'engine default relayHandlerWaitMs=3000 waits for cold-start handler instead of returning 503')
    assert.equal(await coldRes.text(), 'ok-from-b')

    // Now drop only UDP DATA frames (PING/PONG continue passing)
    env.netFilter.dropUdpData = true
    const stalledReq = env.getFetchAtoB()('http://peer/data-blackhole')
    // Advance ~4.2s for ARQ zero-SACK stall detection (stallSuspectMs=3500; with Karn SRTT ~50ms stepClock granularity RTO=160->4120ms)
    await env.stepClock(4_200, 100)
    await waitFor(
      () => env.engineA.status().peers[0]?.path === 'relay' && env.engineB.status().peers[0]?.path === 'relay',
      'ARQ stall on A demotes both A and B to relay within ~3.8s',
    )
    assert.ok(env.logsA.some((l) => l.includes('direct arq stalled')), 'A logged direct arq stalled')
    assert.equal(env.engineA.status().peers[0].directDemoteReason, 'path-lost', 'an ARQ stall is a lost path, not an RTT-cap demotion')
    assert.equal(await (await stalledReq).text(), 'ok-from-b', 'in-flight stalled request transparently flushes over WS')

    const reverseRes = await env.getFetchBtoA()('http://peer/reverse-after-stall')
    assert.equal(await reverseRes.text(), 'ok-from-a')
  }
})

test('Task 4: relay ARQ profile uses window=160 (p2p stays 16) and onPunchFallback applies relay profile', async (t) => {
  const clock = manualClock(Date.now())
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-t4-fallback-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stateFile = path.join(dir, 'peer.json')
  const identityA = ensurePeerIdentity(stateFile)
  const identityB = generatePeerIdentity()

  const wsSockets = []
  let wsDataFrames = 0
  let muxB
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    wsSockets.push(socket)
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const parsed = readClientFrame(buf)
        if (!parsed) break
        buf = parsed.rest
        if (parsed.opcode === 8) { socket.end(); return }
        if (parsed.opcode === 2) {
          const frameBuf = Buffer.from(parsed.payload)
          const hdr = decodeFrameHeader(frameBuf)
          if (hdr !== null && hdr.frameType === PeerFrameType.HELLO) {
            muxB?.handleGatewayFrame(frameBuf)
          } else if (hdr !== null && hdr.frameType === PeerFrameType.DATA) {
            wsDataFrames += 1
          }
          continue
        }
        if (parsed.opcode !== 1) continue
        let msg
        try { msg = JSON.parse(parsed.payload.toString('utf8')) } catch { continue }
        if (msg?.type === 'auth') {
          socket.write(wsFrame({
            type: 'welcome',
            status: 'authorized',
            connSeq: 1,
            maxPeers: 8,
            gatewayVersion: '0.2.0',
            wireCompatLevel: 1,
            directMaxRttMs: 300,
            peers: [{
              nodeId: identityB.nodeId,
              publicKeyHex: identityB.publicKeyHex,
              name: 'B',
              lanEndpoints: ['203.0.113.99:19999'],
              reflexiveEndpoint: null,
              connSeq: 1,
            }],
          }))
        }
      }
    })
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(Buffer.concat([
      Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
      wsFrame({ type: 'challenge', challengeHex: 'a1b2c3d4e5f60718' }),
    ]))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  writePeerNetwork(stateFile, {
    networkId: NET_ID,
    gatewayWsUrl: `ws://127.0.0.1:${port}`,
    gatewayHttpOrigin: `http://127.0.0.1:${port}`,
    joinedAt: 1,
  })
  t.after(async () => {
    for (const s of wsSockets) s.destroy()
    await new Promise((resolve) => server.close(resolve))
  })

  muxB = new PeerMux({
    networkId: NET_ID,
    identity: identityB,
    clock,
    sendGatewayBinary: (bytes) => {
      const payload = Buffer.from(bytes)
      const hdr = payload.length < 126
        ? Buffer.from([0x82, payload.length])
        : Buffer.from([0x82, 126, (payload.length >> 8) & 0xff, payload.length & 0xff])
      for (const s of wsSockets) if (!s.destroyed) s.write(Buffer.concat([hdr, payload]))
    },
    relayHandler: () => async (_req, res) => { res.end('ok') },
    relaySecret: () => 'secret',
  })
  muxB.ensureSession(identityA.nodeId, identityA.publicKeyHex, 'node-A')
  t.after(() => muxB.close())

  let mountedFetch
  const engine = createPeerEngine({
    stateFile,
    identity: identityA,
    clock,
    relayHandler: () => async (_req, res) => { res.end('ok') },
    relaySecret: () => 'secret',
    serverName: () => 'node-A',
    udpProbe: null,
    relayPool: {
      maxServers: () => 8,
      mountVirtual: (input) => {
        mountedFetch = input.fetchImpl
        return { entryId: input.entryId, serverId: input.serverId, serverName: input.serverName, displayName: input.serverName }
      },
      unmountVirtual: () => true,
      updateVirtualName: () => true,
      reconnect: () => Promise.resolve(true),
    },
    punch: { punchWindowMs: 200 },
  })
  t.after(() => engine.stop())
  engine.resumeFromState()
  await waitFor(() => wsSockets.length >= 1 && mountedFetch !== undefined, 'engine mounted peer')

  // Advance past punchWindowMs so onPunchFallback fires and applies relay ARQ profile (window=160)
  clock.advance(250)
  await waitFor(() => engine.status().peers[0]?.path === 'relay', 'punch fallback to relay')
  await waitFor(() => muxB.sessions.get(identityA.nodeId)?.ciphers !== null, 'WS handshake completed')

  // Burst 100 chunks (~110 KiB) without forwarding DATA frames to muxB (no SACKs).
  // Old window=64 caps at 64 DATA frames; relay window=160 pumps >=100 DATA frames!
  wsDataFrames = 0
  const burstPromise = mountedFetch('http://peer/burst-160', { method: 'POST', body: Buffer.alloc(100 * 1100, 0x55) })
  burstPromise.catch(() => {})
  await sleep(60)
  assert.ok(wsDataFrames >= 100, `expected >=100 inflight DATA frames under relay window=160, got ${wsDataFrames}`)
})

test('Task 5: demoteDirect enforces 30s local cooldown and ACK(0) probe does not clear peerRelayHoldUntil or triggerFastProbe', async (t) => {
  const env = await buildRttPair(t, { cap: 300 })
  await env.waitReady()
  await env.sample(50)
  await env.sample(50)
  assert.equal(env.peerOf().path, 'lan')

  // Induce local demoteDirect via sustained RTT > cap
  await env.sample(2000)
  await env.sample(2000)
  assert.equal(env.peerOf().path, 'relay')
  assert.equal(env.peerOf().directDemoteReason, 'rtt-cap')
  const demotedAt = env.clock.now()

  // Simulate peer sending an encrypted ACK(streamId=0) probe while local 30s cooldown is active:
  // onEncryptedFrame must NOT clear peerRelayHoldUntil or trigger fast probe, and good RTT samples
  // inside 30s must NOT promote.
  let fastProbePing = false
  env.gateB.onPing = () => { fastProbePing = true }
  const senderB = env.mgrB.frameSenderFor(env.identityA.nodeId)
  senderB(PeerFrameType.ACK, 0, Buffer.alloc(0), 0)
  await sleep(30)
  env.gateB.onPing = null
  assert.equal(fastProbePing, false, 'ACK(0) probe during active cooldown must not triggerFastProbe')

  // Good RTT samples strictly inside the 30s hold must keep path on relay
  let insideHoldSamples = 0
  while (env.clock.now() + KEEPALIVE_MS + 100 < demotedAt + 30_000) {
    await env.sample(40)
    insideHoldSamples += 1
    assert.equal(env.peerOf().path, 'relay', `must stay on relay during 30s hold (sample ${insideHoldSamples})`)
  }
  assert.ok(insideHoldSamples >= 5, `expected >= 5 samples inside 30s hold, got ${insideHoldSamples}`)

  // Cross demotedAt + 30s, then 2 good RTT samples promote back to lan
  while (env.clock.now() < demotedAt + 30_000) {
    await env.sample(40)
  }
  await env.sample(40)
  if (env.peerOf().path !== 'lan') await env.sample(40)
  assert.equal(env.peerOf().path, 'lan', 'must allow recovery once 30s cooldown expires')
})

test('Slice 1: arqProfileForPath sets p2p AIMD (160/32/16), lan fixed (160), and relay AIMD (384/160/32)', () => {
  assert.equal(typeof arqProfileForPath, 'function', 'arqProfileForPath exported for profile contract')
  assert.deepEqual(arqProfileForPath('lan', 25), { windowSize: 160, rtoMs: 120 })
  assert.deepEqual(arqProfileForPath('relay', 80), {
    windowSize: 384,
    initialWindowSize: 160,
    minWindowSize: 32,
    rtoMs: 120,
  })
  assert.deepEqual(arqProfileForPath('p2p', null), {
    windowSize: 160,
    initialWindowSize: 32,
    minWindowSize: 16,
    rtoMs: 150,
  })
  assert.deepEqual(arqProfileForPath('p2p', 100), {
    windowSize: 160,
    initialWindowSize: 32,
    minWindowSize: 16,
    rtoMs: 250,
  })
})

test('Slice 1: onDirectLost arms relay hold and onDirectReady preserves cooldown', async (t) => {
  const env = await buildRttPair(t, { cap: 300 })
  await env.waitReady()
  await env.sample(50)
  await env.sample(50)
  assert.equal(env.peerOf().path, 'lan')

  // Drop all UDP traffic so keepalive times out -> demoteDirect (30s) then onDirectLost (60s)
  env.gateB.dropAll = true
  await env.drain(14_000)
  await env.waitLost()
  const lostAt = env.clock.now()
  assert.equal(env.peerOf().path, 'relay')

  // Restore UDP; onDirectReady fires while hold from onDirectLost is active
  env.gateB.dropAll = false
  env.gateB.dropFirstPing = true
  env.logs.length = 0
  env.clock.advance(5_000)
  await env.waitReady()
  assert.equal(env.peerOf().path, 'relay', 'onDirectReady during onDirectLost hold must stay relay')

  // Good RTT samples before hold expires must NOT promote (onDirectReady must not wipe peerRelayHoldUntil)
  while (env.clock.now() + KEEPALIVE_MS + 100 < lostAt + 55_000) {
    await env.sample(40)
    assert.equal(env.peerOf().path, 'relay', 'must stay relay until hold expires')
  }

  // Advance past hold expiry, then 2 good samples promote back to lan
  while (env.clock.now() < lostAt + 65_000) {
    await env.sample(40)
  }
  if (env.peerOf().path !== 'lan') await env.sample(40)
  if (env.peerOf().path !== 'lan') await env.sample(40)
  assert.equal(env.peerOf().path, 'lan', 'must promote once hold from onDirectLost expires')
})

test('Slice 1: directCap() === 0 honors active peerRelayHoldUntil in onDirectReady and onRttSample', async (t) => {
  const env = await buildRttPair(t, { cap: 300 })
  await env.waitReady()
  await env.sample(50)
  await env.sample(50)
  assert.equal(env.peerOf().path, 'lan')

  // Induce demoteDirect -> 30s hold, then switch cap to 0 (unlimited)
  await env.sample(2000)
  await env.sample(2000)
  assert.equal(env.peerOf().path, 'relay')
  env.capRef.value = 0

  // Sample during active 30s hold must still stay on relay even though directCap() === 0
  await env.sample(40)
  assert.equal(env.peerOf().path, 'relay', 'cap=0 must still honor active peerRelayHoldUntil in onRttSample')

  // Trigger onDirectLost + onDirectReady while hold active and cap=0 -> must remain relay
  env.gateB.dropAll = true
  await env.drain(14_000)
  await env.waitLost()
  const lostAt = env.clock.now()
  env.gateB.dropAll = false
  env.gateB.dropFirstPing = true
  env.logs.length = 0
  env.clock.advance(5_000)
  await env.waitReady()
  assert.equal(env.peerOf().path, 'relay', 'onDirectReady with cap=0 during hold must stay relay')

  // Samples while inside 60s hold stay relay; once 60s hold expires, cap=0 promotes immediately on next sample
  while (env.clock.now() + KEEPALIVE_MS + 100 < lostAt + 55_000) {
    await env.sample(40)
    assert.equal(env.peerOf().path, 'relay', 'cap=0 must stay relay during onDirectLost hold')
  }
  while (env.clock.now() < lostAt + 65_000) {
    await env.sample(40)
  }
  if (env.peerOf().path !== 'lan') await env.sample(40)
  assert.equal(env.peerOf().path, 'lan', 'cap=0 promotes once hold expires')
})

test('Slice 1: onEncryptedFrame triggers fast-probe when cap <= 0 after cooldown expires', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-fast-probe-cap0-'))
  const clock = manualClock()
  const logs = []
  const capRef = { value: 300 }
  const stateFileA = path.join(home, 'a-state.json')
  const socketA = await openUdp()
  const identityA = ensurePeerIdentity(stateFileA)
  const socketB = await openUdp()
  const gateB = makeGate(socketB)
  gateB.pongDelayMs = 2
  gateB.dropFirstPing = false
  const identityB = generatePeerIdentity()
  const gateway = await startRttGateway({
    peers: () => [{
      nodeId: identityB.nodeId,
      publicKeyHex: identityB.publicKeyHex,
      name: 'peer-B',
      lanEndpoints: [endpointOf(socketB)],
    }],
  })
  const engine = createPeerEngine({
    stateFile: stateFileA,
    identity: identityA,
    relayPool: {
      maxServers: () => 8,
      mountVirtual: (i) => ({ entryId: i.entryId, serverId: i.serverId, serverName: i.serverName, displayName: i.serverName }),
      unmountVirtual: () => true,
      updateVirtualName: () => true,
      reconnect: () => Promise.resolve(true),
    },
    relayHandler: () => undefined,
    relaySecret: () => 'test',
    serverName: () => 'node-A',
    udpSocket: socketA,
    udpProbe: null,
    clock,
    log: (line) => logs.push(line),
    directMaxRttMs: () => capRef.value,
    punch: {
      keepAliveMs: KEEPALIVE_MS,
      keepAliveLostFrames: 4,
      reprobeInitialDelaysMs: [5_000, 15_000],
      reprobeIntervalMs: 800,
      fastConfirmDelayMs: 50,
    },
  })
  const mgrB = new PeerPunchManager({
    networkId: NET_ID,
    identity: identityB,
    socket: gateB,
    clock,
    keepAliveMs: KEEPALIVE_MS,
    keepAliveLostFrames: 4,
    reprobeInitialDelaysMs: [5_000, 15_000],
    reprobeIntervalMs: 800,
  })
  await mgrB.ready()
  writePeerNetwork(stateFileA, {
    gatewayWsUrl: gateway.wsUrl,
    gatewayHttpOrigin: `http://127.0.0.1:${gateway.httpPort}`,
    networkId: NET_ID,
    joinedAt: 1,
  })
  t.after(async () => {
    const closingB = waitClose(socketB)
    const closingA = waitClose(socketA)
    mgrB.close()
    engine.stop()
    await closingB
    await closingA
    await gateway.close()
    fs.rmSync(home, { recursive: true, force: true })
  })
  engine.resumeFromState()
  mgrB.beginPunch({ peerNodeId: identityA.nodeId, peerPublicKeyHex: identityA.publicKeyHex, lanEndpoints: [] })
  const peerOf = () => engine.status().peers.find((p) => p.nodeId === identityB.nodeId)
  await waitFor(() => logs.some((l) => l.includes('direct ready')), 'ready')

  // Advance keepalives with real PONGs flowing so it promotes to lan
  for (let i = 0; i < 4 && peerOf()?.path !== 'lan'; i++) {
    clock.advance(KEEPALIVE_MS)
    await sleep(15)
  }
  assert.equal(peerOf()?.path, 'lan', 'promoted to lan initially')

  // Drop PONGs for 2 keepalives (< 4 keepAliveLostFrames) -> demoteDirect (30s hold)
  gateB.dropPongs = true
  for (let i = 0; i < 3 && peerOf()?.path === 'lan'; i++) {
    clock.advance(KEEPALIVE_MS)
    await sleep(15)
  }
  assert.equal(peerOf()?.path, 'relay', 'demoted to relay via missed pings')
  gateB.dropPongs = false
  capRef.value = 0

  // Keep keepalives answered for 8 ticks (28s < 30s hold; next keepalive is at 31.5s)
  for (let i = 0; i < 8; i++) {
    clock.advance(KEEPALIVE_MS)
    await sleep(10)
  }
  assert.equal(peerOf()?.path, 'relay', 'cap=0 stays relay during 30s hold')
  // Advance 2.5s to 30.5s (past 30s hold, before 31.5s keepalive)
  clock.advance(2_500)
  assert.equal(peerOf()?.path, 'relay', 'still relay before ACK(0) fast-probe')

  let fastProbePing = false
  gateB.onPing = () => { fastProbePing = true }
  mgrB.frameSenderFor(identityA.nodeId)(PeerFrameType.ACK, 0, Buffer.alloc(0), 0)
  await waitFor(() => fastProbePing, 'onEncryptedFrame triggers fast-probe with cap=0 after cooldown', 500)
  gateB.onPing = null
  await waitFor(() => peerOf()?.path === 'lan', 'cap=0 promotes from fast-probe PONG', 500)
})

test('Slice 1: exponential backoff (30s -> 60s -> 120s -> 240s -> 300s) and 120s stable direct reset', async (t) => {
  const env = await buildRttPair(t, { cap: 300 })
  await env.waitReady()

  const induceDemoteAndMeasureHold = async (expectedHoldMs) => {
    // Promote to lan first
    while (env.peerOf().path !== 'lan') {
      await env.sample(40)
    }
    // Demote via sustained high RTT
    await env.sample(2000)
    await env.sample(2000)
    assert.equal(env.peerOf().path, 'relay')
    const demotedAt = env.clock.now()

    // Stay in relay right up to expectedHoldMs - KEEPALIVE_MS
    while (env.clock.now() + KEEPALIVE_MS + 100 < demotedAt + expectedHoldMs) {
      await env.sample(40)
      assert.equal(env.peerOf().path, 'relay', `must stay relay before ${expectedHoldMs}ms hold expires`)
    }

    // Cross expectedHoldMs and verify recovery
    while (env.clock.now() < demotedAt + expectedHoldMs) {
      await env.sample(40)
    }
    await env.sample(40)
    if (env.peerOf().path !== 'lan') await env.sample(40)
    assert.equal(env.peerOf().path, 'lan', `must recover after ${expectedHoldMs}ms hold`)
  }

  // Step 0 -> 30s, Step 1 -> 60s, Step 2 -> 120s, Step 3 -> 240s, Step 4 -> 300s
  await induceDemoteAndMeasureHold(30_000)
  await induceDemoteAndMeasureHold(60_000)
  await induceDemoteAndMeasureHold(120_000)
  await induceDemoteAndMeasureHold(240_000)
  await induceDemoteAndMeasureHold(300_000)

  // Stay stable in direct mode >= 120s (keepalive pings keep direct alive) -> resets step back to 0 (30s)
  const promotedAt = env.clock.now()
  while (env.clock.now() - promotedAt < 125_000) {
    await env.sample(40)
  }
  assert.equal(env.peerOf().path, 'lan')
  await induceDemoteAndMeasureHold(30_000)
})

test('Slice 3: welcome forceRelay=true skips STUN & beginPunch and immediately enables relay; live network-updated toggles true/false', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-force-relay-'))
  const clock = manualClock()
  const logs = []
  const stateFileA = path.join(home, 'a-state.json')
  const socketA = await openUdp()
  const identityA = ensurePeerIdentity(stateFileA)
  const socketB = await openUdp()
  const gateB = makeGate(socketB)
  gateB.pongDelayMs = 2
  gateB.dropFirstPing = false
  const identityB = generatePeerIdentity()

  const stunSock = await openUdp()
  let stunPackets = 0
  stunSock.on('message', () => { stunPackets += 1 })

  let sendWelcomeForceRelay = true
  const wsSockets = []
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    wsSockets.push(socket)
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const parsed = readClientFrame(buf)
        if (parsed === null) break
        buf = parsed.rest
        if (parsed.opcode === 8) { socket.end(); return }
        if (parsed.opcode !== 1) continue
        let msg
        try { msg = JSON.parse(parsed.payload.toString('utf8')) } catch { continue }
        if (msg?.type === 'auth') {
          socket.write(wsFrame({
            type: 'welcome',
            status: 'authorized',
            maxPeers: 8,
            peerDirectMaxRttMs: 0,
            forceRelay: sendWelcomeForceRelay,
            ...(sendWelcomeForceRelay ? {} : { stun: { primaryPort: stunSock.address().port, altPort: null } }),
            peers: [{
              nodeId: identityB.nodeId,
              publicKeyHex: identityB.publicKeyHex,
              name: 'peer-B',
              lanEndpoints: sendWelcomeForceRelay ? [] : [endpointOf(socketB)],
              reflexiveEndpoint: null,
              connSeq: 1,
            }],
          }))
        }
      }
    })
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(Buffer.concat([
      Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
      wsFrame({ type: 'challenge', challengeHex: 'a1b2c3d4e5f60718' }),
    ]))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const engine = createPeerEngine({
    stateFile: stateFileA,
    identity: identityA,
    relayPool: {
      maxServers: () => 8,
      mountVirtual: (i) => ({ entryId: i.entryId, serverId: i.serverId, serverName: i.serverName, displayName: i.serverName }),
      unmountVirtual: () => true,
      updateVirtualName: () => true,
      reconnect: () => Promise.resolve(true),
    },
    relayHandler: () => undefined,
    relaySecret: () => 'test',
    serverName: () => 'node-A',
    udpSocket: socketA,
    stunProbeTimeoutMs: 50,
    clock,
    log: (line) => logs.push(line),
    punch: {
      keepAliveMs: KEEPALIVE_MS,
      keepAliveLostFrames: 3,
      reprobeInitialDelaysMs: [5_000, 15_000],
      reprobeIntervalMs: 800,
      fastConfirmDelayMs: 0,
    },
  })
  const mgrB = new PeerPunchManager({
    networkId: NET_ID,
    identity: identityB,
    socket: gateB,
    clock,
    keepAliveMs: KEEPALIVE_MS,
    keepAliveLostFrames: 3,
    reprobeInitialDelaysMs: [5_000, 15_000],
    reprobeIntervalMs: 800,
  })
  await mgrB.ready()
  writePeerNetwork(stateFileA, {
    gatewayWsUrl: `ws://127.0.0.1:${port}`,
    gatewayHttpOrigin: `http://127.0.0.1:${port}`,
    networkId: NET_ID,
    joinedAt: 1,
  })
  t.after(async () => {
    const closingB = waitClose(socketB)
    const closingA = waitClose(socketA)
    const closingStun = waitClose(stunSock)
    mgrB.close()
    engine.stop()
    try { stunSock.close() } catch {}
    for (const s of wsSockets) s.destroy()
    server.closeAllConnections?.()
    await Promise.all([
      closingB,
      closingA,
      closingStun,
      new Promise((resolve) => server.close(resolve)),
    ])
    fs.rmSync(home, { recursive: true, force: true })
  })

  // 1. welcome with forceRelay=true skips STUN & beginPunch, exposes status().forceRelay === true, and enables relay path
  engine.resumeFromState()
  await waitFor(() => engine.status().gatewayState === 'authorized', 'authorized with forceRelay=true')
  assert.equal(engine.status().forceRelay, true)
  assert.equal(engine.status().peers[0]?.path, 'relay')
  assert.equal(stunPackets, 0, 'forceRelay=true must skip STUN probe')
  assert.equal(logs.some((l) => l.includes('beginPunch(')), false, 'forceRelay=true must skip beginPunch')

  // Even if punch-coordinate arrives while forceRelay=true, it must not start punching
  for (const s of wsSockets) {
    s.write(wsFrame({
      type: 'punch-coordinate',
      peerNodeId: identityB.nodeId,
      publicKeyHex: identityB.publicKeyHex,
      lanEndpoints: [endpointOf(socketB)],
      reflexiveEndpoint: null,
      connSeq: 1,
    }))
  }
  await sleep(30)
  assert.equal(logs.some((l) => l.includes('beginPunch(')), false, 'punch-coordinate suppressed during forceRelay=true')
  assert.equal(engine.status().peers[0]?.path, 'relay')

  // 2. Live network-updated forceRelay=false with stun re-runs STUN probe and restores direct punch
  mgrB.beginPunch({ peerNodeId: identityA.nodeId, peerPublicKeyHex: identityA.publicKeyHex, lanEndpoints: [] })
  for (const s of wsSockets) {
    s.write(wsFrame({
      type: 'network-updated',
      networkId: NET_ID,
      maxPeers: 8,
      peerDirectMaxRttMs: 0,
      forceRelay: false,
      stun: { primaryPort: stunSock.address().port, altPort: null },
    }))
  }
  await waitFor(() => engine.status().forceRelay === false, 'forceRelay flipped to false')
  await waitFor(() => stunPackets >= 1, 'STUN probe triggered after forceRelay=false')
  // Gateway re-emits punch-coordinate right after network-updated(forceRelay=false)
  for (const s of wsSockets) {
    s.write(wsFrame({
      type: 'punch-coordinate',
      peerNodeId: identityB.nodeId,
      publicKeyHex: identityB.publicKeyHex,
      lanEndpoints: [endpointOf(socketB)],
      reflexiveEndpoint: null,
      connSeq: 1,
    }))
  }
  await waitFor(() => logs.some((l) => l.includes('beginPunch(')), 'beginPunch triggered after forceRelay=false')
  await waitFor(() => engine.status().peers[0]?.path === 'lan', 'promoted to direct lan after forceRelay=false')

  // 3. Live network-updated forceRelay=true drops active UDP punch and switches immediately to relay
  logs.length = 0
  for (const s of wsSockets) {
    s.write(wsFrame({
      type: 'network-updated',
      networkId: NET_ID,
      maxPeers: 8,
      peerDirectMaxRttMs: 0,
      forceRelay: true,
    }))
  }
  await waitFor(() => engine.status().forceRelay === true && engine.status().peers[0]?.path === 'relay', 'switched immediately to relay on forceRelay=true')
  assert.equal(engine.status().peers[0]?.directDemoted, false)

  // Subsequent punch-coordinate while forceRelay=true must remain suppressed
  for (const s of wsSockets) {
    s.write(wsFrame({
      type: 'punch-coordinate',
      peerNodeId: identityB.nodeId,
      publicKeyHex: identityB.publicKeyHex,
      lanEndpoints: [endpointOf(socketB)],
      reflexiveEndpoint: null,
      connSeq: 1,
    }))
  }
  await sleep(30)
  assert.equal(engine.status().peers[0]?.path, 'relay')

  // 4. Live network-updated forceRelay=false again with cached endpoints triggers beginPunch immediately without new punch-coordinate
  logs.length = 0
  const stunBefore = stunPackets
  mgrB.beginPunch({ peerNodeId: identityA.nodeId, peerPublicKeyHex: identityA.publicKeyHex, lanEndpoints: [] })
  for (const s of wsSockets) {
    s.write(wsFrame({
      type: 'network-updated',
      networkId: NET_ID,
      forceRelay: false,
      stun: { primaryPort: stunSock.address().port, altPort: null },
    }))
  }
  await waitFor(() => stunPackets > stunBefore, 'STUN re-probed on second forceRelay=false')
  await waitFor(() => logs.some((l) => l.includes('beginPunch(')), 'beginPunch triggered directly from cached endpoints')
  await waitFor(() => engine.status().peers[0]?.path === 'lan', 're-promoted to direct lan')
})

test('Slice 4: parsePeerTuning sanitizes bounds/cross-field invariants and welcome/network-updated.peerTuning apply live', async (t) => {
  // 1. parsePeerTuning clamps bounds & enforces cross-field invariants
  assert.deepEqual(parsePeerTuning(undefined), DEFAULT_PEER_TUNING)
  const sanitized = parsePeerTuning({
    p2pWindowMax: 64,
    p2pWindowInitial: 100, // > p2pWindowMax -> clamped to 64
    p2pWindowMin: 80, // > p2pWindowInitial -> clamped to 64 (and 8..64 -> 64)
    relayWindowMax: 90,
    relayWindowInitial: 200, // > relayWindowMax -> clamped to 90
    relayHoldBaseMs: 80_000,
    relayHoldMaxMs: 50_000, // < relayHoldBaseMs -> clamped to 80_000
    directPromoteRatio: 0.755, // rounded 2 decimals -> 0.76
    sackCoalesceFrames: 'bad', // invalid type -> default 6
  })
  assert.equal(sanitized.p2pWindowMax, 64)
  assert.equal(sanitized.p2pWindowInitial, 64)
  assert.equal(sanitized.p2pWindowMin, 64)
  assert.equal(sanitized.relayWindowMax, 90)
  assert.equal(sanitized.relayWindowInitial, 90)
  assert.equal(sanitized.relayHoldBaseMs, 80_000)
  assert.equal(sanitized.relayHoldMaxMs, 80_000)
  assert.equal(sanitized.directPromoteRatio, 0.76)
  assert.equal(sanitized.sackCoalesceFrames, DEFAULT_PEER_TUNING.sackCoalesceFrames)

  // 2. arqProfileForPath consumes custom PeerTuningConfig
  const customProfile = arqProfileForPath('p2p', 50, {
    ...DEFAULT_PEER_TUNING,
    p2pWindowMax: 200,
    p2pWindowInitial: 48,
    p2pWindowMin: 24,
  })
  assert.deepEqual(customProfile, { windowSize: 200, initialWindowSize: 48, minWindowSize: 24, rtoMs: 150 })

  // 3. Live welcome.peerTuning + network-updated.peerTuning apply directPromoteStreak/Ratio & relayHoldBaseMs
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-peer-tuning-'))
  const clock = manualClock()
  const stateFileA = path.join(home, 'a-state.json')
  const socketA = await openUdp()
  const identityA = ensurePeerIdentity(stateFileA)
  const socketB = await openUdp()
  const gateB = makeGate(socketB)
  gateB.pongDelayMs = 60
  gateB.dropFirstPing = false
  const identityB = generatePeerIdentity()
  const mgrB = new PeerPunchManager({
    networkId: NET_ID,
    identity: identityB,
    socket: socketB,
    clock,
    onDirectReady: () => {},
    onPunchFallback: () => {},
    onDirectLost: () => {},
  })
  await mgrB.ready()
  const wsSockets = []
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    wsSockets.push(socket)
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const parsed = readClientFrame(buf)
        if (parsed === null) break
        buf = parsed.rest
        if (parsed.opcode === 8) { socket.end(); return }
        if (parsed.opcode !== 1) continue
        let msg
        try { msg = JSON.parse(parsed.payload.toString('utf8')) } catch { continue }
        if (msg?.type === 'auth') {
          socket.write(wsFrame({
            type: 'welcome',
            status: 'authorized',
            connSeq: 1,
            maxPeers: 8,
            peerDirectMaxRttMs: 100,
            peerTuning: {
              ...DEFAULT_PEER_TUNING,
              directPromoteStreak: 3,
              directPromoteRatio: 0.5,
              relayHoldBaseMs: 10_000,
              relayHoldMaxMs: 30_000,
            },
            peers: [{
              nodeId: identityB.nodeId,
              publicKeyHex: identityB.publicKeyHex,
              name: 'peer-b',
              lanEndpoints: [endpointOf(socketB)],
              reflexiveEndpoint: null,
              connSeq: 1,
            }],
          }))
          mgrB.beginPunch({
            peerNodeId: identityA.nodeId,
            peerPublicKeyHex: identityA.publicKeyHex,
            lanEndpoints: [endpointOf(socketA)],
          })
        }
      }
    })
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(Buffer.concat([
      Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
      wsFrame({ type: 'challenge', challengeHex: randomHex(32) }),
    ]))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const pool = createRelayPool({ maxServers: 4, log: () => {} })
  const engine = createPeerEngine({
    stateFile: stateFileA,
    identity: identityA,
    relayPool: pool,
    relayHandler: () => undefined,
    relaySecret: () => 'sec',
    serverName: () => 'A',
    udpSocket: socketA,
    udpProbe: null,
    clock,
    punch: { keepAliveMs: KEEPALIVE_MS, fastConfirmDelayMs: 0, pingRetryDelayMs: 0 },
  })
  t.after(async () => {
    engine.stop()
    mgrB.close()
    for (const s of wsSockets) s.destroy()
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
    try { socketA.close() } catch {}
    try { socketB.close() } catch {}
    fs.rmSync(home, { recursive: true, force: true })
  })

  writePeerNetwork(stateFileA, {
    networkId: NET_ID,
    gatewayWsUrl: `ws://127.0.0.1:${port}`,
    gatewayHttpOrigin: `http://127.0.0.1:${port}`,
    joinKey: 'jk',
    joinedAt: 1,
  })
  engine.resumeFromState()
  await waitFor(() => engine.status().gatewayState === 'authorized', 'authorized with welcome.peerTuning')
  assert.equal(engine.status().peerTuning.directPromoteStreak, 3)
  assert.equal(engine.status().peerTuning.directPromoteRatio, 0.5)
  assert.equal(engine.status().peerTuning.relayHoldBaseMs, 10_000)

  // With cap=100 & directPromoteRatio=0.5, threshold is 50ms: 60ms RTT samples must stay relay
  await waitFor(() => engine.status().peers[0]?.directRttMs !== null, 'first RTT sample recorded')
  clock.advance(KEEPALIVE_MS)
  await sleep(10)
  assert.equal(engine.status().peers[0]?.path, 'relay', '60ms RTT stays relay under directPromoteRatio=0.5')

  // Live network-updated.peerTuning updates ratio=0.85 & streak=1 -> next sample promotes to lan!
  for (const s of wsSockets) {
    s.write(wsFrame({
      type: 'network-updated',
      networkId: NET_ID,
      peerTuning: {
        ...DEFAULT_PEER_TUNING,
        directPromoteStreak: 1,
        directPromoteRatio: 0.85,
        sackCoalesceFrames: 2,
      },
    }))
  }
  await waitFor(
    () => engine.status().peerTuning.directPromoteStreak === 1 && engine.status().peerTuning.sackCoalesceFrames === 2,
    'live network-updated.peerTuning applied',
  )
  assert.equal(engine.status().peerTuning.directPromoteRatio, 0.85)
  clock.advance(KEEPALIVE_MS)
  await waitFor(() => engine.status().peers[0]?.path === 'lan', 'promotes to lan once directPromoteRatio=0.85 & streak=1')
})
