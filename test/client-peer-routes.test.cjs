'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { request } = require('./util.cjs')
const { RelayError, relayCredentialsDigest } = require('../lib/relay-client.js')
const { toVirtual } = require('../lib/virtual-id.js')
const {
  closeServer,
  sameOrigin,
  INFO,
  fakeRelay,
  fakePool,
  makeEntry,
  startResetServer,
  createClientRoutesHarness,
} = require('./helpers/client-routes-harness.cjs')

const harness = createClientRoutesHarness()
let routes, gateway, gwSeen, gwState, gwPort, gwUrl
test.before(async () => {
  ;({ routes, gateway, gwSeen, gwState, gwPort, gwUrl } = await harness.start())
})
test.after(() => harness.stop())
const makeRow = (overrides) => harness.makeRow(overrides)
const startClientServer = (row, overrides) => harness.startClientServer(row, overrides)

// ---------------------------------------------------------------------------
// PG-9: the peer management routes (/client/peer/*). Every route sits behind
// the SAME walls the client prefix has always applied — admit (above), the
// via-marker wall BEFORE dispatch (a remote device must never read or write
// this machine's peer state), same-origin for the POSTs — and never echoes
// key material (privateKeyHex, joinKey). A fake PeerEngine records the calls.
// ---------------------------------------------------------------------------

const PEER_STATUS_PATH = '/_dsh/zen-remote/client/peer/status'
const PEER_JOIN_PATH = '/_dsh/zen-remote/client/peer/join'
const PEER_LEAVE_PATH = '/_dsh/zen-remote/client/peer/leave'
const PEER_TOGGLE_MOUNT_PATH = '/_dsh/zen-remote/client/peer/toggle-mount'
const PEER_TRUST_PATH = '/_dsh/zen-remote/client/peer/trust'
const PEER_REPROBE_PATH = '/_dsh/zen-remote/client/peer/reprobe'
const PEER_DISMISS_REVOKED_PATH = '/_dsh/zen-remote/client/peer/dismiss-revoked'

/** A PeerEngine double: records every management call, answers a fixed
 * status() unless the scenario overrides it. */
function makePeerEngine(overrides = {}) {
  const calls = []
  return {
    calls,
    engine: {
      joinNetwork: async (invite) => {
        calls.push(['join', invite])
        return overrides.joinResult ?? { ok: true }
      },
      leaveNetwork: () => {
        calls.push(['leave'])
        return overrides.leaveResult
      },
      dismissRevokedNotice: () => { calls.push(['dismissRevoked']) },
      setNodeDisabled: (nodeId, disabled) => { calls.push(['disable', nodeId, disabled]) },
      trustPeer: (nodeId) => { calls.push(['trust', nodeId]); return overrides.trustResult ?? true },
      reprobePunch: () => { calls.push(['reprobe']) },
      status: () => overrides.status ?? {
        nodeId: 'abcd1234',
        gatewayState: 'authorized',
        networkId: '0123456789abcdef',
        maxPeers: 8,
        natType: 'cone',
        peers: [
          { nodeId: 'aaaa1111', name: '书房电脑', state: 'eligible', path: 'lan', rttMs: 3, mounted: true },
          { nodeId: 'bbbb2222', name: '客厅电脑', state: 'eligible', path: 'none', rttMs: null, mounted: false },
          { nodeId: 'cccc3333', name: '换了钥的机器', state: 'identity-mismatch', path: 'blocked', rttMs: null, mounted: false },
          { nodeId: 'dddd4444', name: '被我忽略的机器', state: 'disabled', path: 'none', rttMs: null, mounted: false },
        ],
      },
    },
  }
}

test('PG-9 route constants name the six peer paths under the client prefix', async () => {
  assert.equal(routes.CLIENT_PEER_PREFIX, '/_dsh/zen-remote/client/peer')
  assert.equal(routes.CLIENT_PEER_STATUS_ROUTE, PEER_STATUS_PATH)
  assert.equal(routes.CLIENT_PEER_JOIN_ROUTE, PEER_JOIN_PATH)
  assert.equal(routes.CLIENT_PEER_LEAVE_ROUTE, PEER_LEAVE_PATH)
  assert.equal(routes.CLIENT_PEER_TOGGLE_MOUNT_ROUTE, PEER_TOGGLE_MOUNT_PATH)
  assert.equal(routes.CLIENT_PEER_TRUST_ROUTE, PEER_TRUST_PATH)
  assert.equal(routes.CLIENT_PEER_REPROBE_ROUTE, PEER_REPROBE_PATH)
  assert.equal(routes.CLIENT_PEER_DISMISS_REVOKED_ROUTE, PEER_DISMISS_REVOKED_PATH)
})

test('PG-9 via wall: a gateway-marked request is refused BEFORE dispatch on every peer route', async () => {
  const { engine, calls } = makePeerEngine()
  const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine })
  try {
    const viaHeaders = { 'x-zen-remote-via': 'gateway' }
    const status = await request(port, { method: 'GET', path: PEER_STATUS_PATH, headers: viaHeaders })
    assert.equal(status.status, 403)
    assert.equal(JSON.parse(status.body).error.code, 'via-gateway')
    for (const [path, body] of [
      [PEER_JOIN_PATH, { inviteUri: 'zr-net://10.0.0.1:4088/0123456789abcdef' }],
      [PEER_LEAVE_PATH, {}],
      [PEER_TOGGLE_MOUNT_PATH, { nodeId: 'aaaa1111', mounted: false }],
      [PEER_TRUST_PATH, { nodeId: 'cccc3333' }],
      [PEER_REPROBE_PATH, {}],
      [PEER_DISMISS_REVOKED_PATH, {}],
    ]) {
      const res = await request(port, { method: 'POST', path, headers: { ...sameOrigin(port), ...viaHeaders }, body })
      assert.equal(res.status, 403, path)
      assert.equal(JSON.parse(res.body).error.code, 'via-gateway', path)
    }
    assert.deepEqual(calls, [], 'no engine call may fire behind the wall')
  } finally {
    await closeServer(server)
  }
})

test('PG-9 status: the mapped peer list rides without any key material', async () => {
  const { engine, calls } = makePeerEngine()
  const { server, port } = await startClientServer(
    makeRow(),
    { getPeerEngine: () => engine, getPeerNetworkOrigin: () => 'http://10.0.0.1:4088' },
  )
  try {
    const res = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), {
      configured: true,
      nodeId: 'abcd1234',
      gatewayState: 'authorized',
      networkId: '0123456789abcdef',
      gatewayOrigin: 'http://10.0.0.1:4088',
      maxPeers: 8,
      maxServers: 8,
      mountedCount: 1,
      limitReached: false,
      peers: [
        { nodeId: 'aaaa1111', name: '书房电脑', mounted: true, path: 'lan', rttMs: 3 },
        { nodeId: 'bbbb2222', name: '客厅电脑', mounted: false, path: 'offline', rttMs: null },
        { nodeId: 'cccc3333', name: '换了钥的机器', mounted: false, path: 'mismatch', rttMs: null },
        { nodeId: 'dddd4444', name: '被我忽略的机器', mounted: false, path: 'offline', rttMs: null },
      ],
    })
    const raw = res.body
    assert.ok(!raw.includes('privateKeyHex'), 'the private key never rides any peer answer')
    assert.ok(!raw.includes('joinKey'), 'the join key never rides any peer answer')
    assert.ok(!/[0-9a-f]{64}/.test(raw), 'no 64-hex key material anywhere in the body')
    assert.deepEqual(calls, [], 'status is a pure read of the engine snapshot')
  } finally {
    await closeServer(server)
  }
})

test('PG-9 status: an engine with no network answers configured:false and no network fields', async () => {
  const { engine } = makePeerEngine({
    status: { nodeId: 'abcd1234', gatewayState: 'unconfigured', networkId: null, maxPeers: null, natType: null, peers: [] },
  })
  const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine })
  try {
    const res = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.configured, false)
    assert.equal(body.nodeId, 'abcd1234')
    assert.equal(body.gatewayState, 'unconfigured')
    assert.ok(!('networkId' in body), 'no network id when unconfigured')
    assert.ok(!('gatewayOrigin' in body), 'no gateway origin when unconfigured')
    // PC-11a: the LOCAL mount facts stay precise even with no network — the
    // local cap (the historic default without a pool), zero mounts, open limit.
    assert.equal(body.maxPeers, null, 'the raw network count stays unknown while unjoined')
    assert.equal(body.maxServers, 8)
    assert.equal(body.mountedCount, 0)
    assert.equal(body.limitReached, false)
  } finally {
    await closeServer(server)
  }
})

// ---- PC-11a: the capacity facts (maxServers / mountedCount / limitReached) -----
// peer/status joins client/status in reporting the SAME effective mount cap —
// `effectiveMaxServers`, i.e. pool.maxServers(), the one synthesis point —
// while `maxPeers` keeps its raw network-total meaning (includes this node).
// mountedCount counts THIS machine's actual mounts (the engine's own mounted
// flags), never the discovered-online rows and never the network's seats.

test('PC-11a status: maxServers matches client/status over the same pool', async () => {
  const { engine } = makePeerEngine()
  // The pool synthesizes 12 (peer mode, gateway cap) while the config says 8 —
  // the production-same-style seam the PG-2-fix tests already pin for the
  // client/status side; BOTH routes must answer the pool's number.
  const wide = fakePool([], { maxServers: () => 12 })
  const { server, port } = await startClientServer(makeRow(), { pool: wide, getMaxServers: () => 8, getPeerEngine: () => engine })
  try {
    const client = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    const peer = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
    assert.equal(JSON.parse(client.body).maxServers, 12, 'client/status reads the pool synthesis')
    assert.equal(JSON.parse(peer.body).maxServers, 12, 'peer/status reads the very same synthesis')
    assert.equal(JSON.parse(peer.body).maxPeers, 8, 'raw maxPeers keeps the network total including self')
  } finally {
    await closeServer(server)
  }

  // Reversed: config says 16, the pool synthesizes 4 — the tight one wins on both.
  const tight = fakePool([], { maxServers: () => 4 })
  const { server: server2, port: port2 } = await startClientServer(makeRow(), { pool: tight, getMaxServers: () => 16, getPeerEngine: () => engine })
  try {
    const client = await request(port2, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    const peer = await request(port2, { method: 'GET', path: PEER_STATUS_PATH })
    assert.equal(JSON.parse(client.body).maxServers, 4)
    assert.equal(JSON.parse(peer.body).maxServers, 4)
  } finally {
    await closeServer(server2)
  }
})

test('PC-11a status: mountedCount counts actual mounts, not the discovered rows', async () => {
  const { engine } = makePeerEngine({
    status: {
      nodeId: 'abcd1234',
      gatewayState: 'authorized',
      networkId: '0123456789abcdef',
      maxPeers: 8,
      natType: 'cone',
      peers: [
        { nodeId: 'aaaa1111', name: '书房电脑', state: 'eligible', path: 'lan', rttMs: 3, mounted: true },
        // discovered and online-ish, but NOT mounted — no seat on this machine
        { nodeId: 'bbbb2222', name: '客厅电脑', state: 'eligible', path: 'relay', rttMs: null, mounted: false },
        // the path fell offline, yet the mount itself is still up — still mounted
        { nodeId: 'cccc3333', name: '断线还挂着的机器', state: 'eligible', path: 'none', rttMs: null, mounted: true },
        { nodeId: 'dddd4444', name: '被我忽略的机器', state: 'disabled', path: 'none', rttMs: null, mounted: false },
      ],
    },
  })
  const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine })
  try {
    const res = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.peers.length, 4, 'all four devices are discovered')
    assert.equal(body.mountedCount, 2, 'exactly the two mounted flags count — not the two eligible rows')
    assert.equal(body.maxServers, 8)
    assert.equal(body.limitReached, false, '2 of 8 — room left')
  } finally {
    await closeServer(server)
  }
})

test('PC-11a status: limitReached follows the live pool cap; an over-cap stock stays visible', async () => {
  const { engine } = makePeerEngine({
    status: {
      nodeId: 'abcd1234',
      gatewayState: 'authorized',
      networkId: '0123456789abcdef',
      maxPeers: 8,
      natType: 'cone',
      peers: [
        { nodeId: 'aaaa1111', name: '书房电脑', state: 'eligible', path: 'lan', rttMs: 3, mounted: true },
        { nodeId: 'cccc3333', name: '客厅电脑', state: 'eligible', path: 'p2p', rttMs: 9, mounted: true },
      ],
    },
  })
  let cap = 2
  const pool = fakePool([], { maxServers: () => cap })
  const { server, port } = await startClientServer(makeRow(), { pool, getPeerEngine: () => engine })
  try {
    const full = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
    assert.equal(JSON.parse(full.body).limitReached, true, '2 mounts of a 2 cap — full')
    assert.equal(JSON.parse(full.body).mountedCount, 2)

    // The cap is read per request: a hot config change (or a network cap
    // broadcast) reaches the very next status answer without any reload.
    cap = 5
    const grown = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
    assert.equal(JSON.parse(grown.body).maxServers, 5)
    assert.equal(JSON.parse(grown.body).limitReached, false, 'the same 2 mounts now have room')

    // A downscale never evicts the mounted stock (mountPeer only gates new
    // mounts) — the excess stock stays visible and still reads as reached.
    cap = 1
    const shrunk = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
    assert.equal(JSON.parse(shrunk.body).maxServers, 1)
    assert.equal(JSON.parse(shrunk.body).mountedCount, 2, 'both mounts survive the shrink')
    assert.equal(JSON.parse(shrunk.body).limitReached, true, '2 >= 1 — over-cap stock reads as reached')
  } finally {
    await closeServer(server)
  }
})

test('PG-9 status: no engine wired answers 503 peer-unavailable', async () => {
  const { server, port } = await startClientServer(makeRow())
  try {
    const res = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
    assert.equal(res.status, 503)
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: 'peer-unavailable' } })
  } finally {
    await closeServer(server)
  }
})

// ---- PC-11a-fix1: the capacity facts over a REAL RelayPool ---------------------
// The fakePool getter overrides prove delegation; only a REAL createRelayPool
// proves the production synthesis itself. One real pool over a real
// (temporary) state file under os.tmpdir() drives BOTH
// routes: every capacity number must equal the pool's own live answer, never
// a preset. The fake engine snapshot still carries the mounted rows and the
// RAW network total; the fake relay clients are the same seam
// relay-pool.test.cjs drives pair() with.

/** A compact fake createRelayClient: the handshake answers from `env` keyed
 * `url|token` (a miss means transport failure → offline). Same shape the
 * real pool's pair()/status paths consume. */
function makeRealPoolClientFactory(env) {
  return (options) => ({
    options,
    state: 'unpaired',
    handshakeInfo: undefined,
    lastError: undefined,
    nextRetryAt: null,
    compat: undefined,
    deviceNameSyncing: false,
    stopped: false,
    listeners: new Set(),
    subscribe(listener) {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    },
    notify() {
      for (const listener of [...this.listeners]) listener(this.state)
    },
    async connect() {
      if (this.stopped) throw new Error('stopped')
      const answer = env.get(`${this.options.getServerUrl()}|${this.options.getToken()}`)
      if (answer === undefined) {
        this.state = 'offline'
        this.lastError = 'offline'
        this.notify()
        throw new Error('offline')
      }
      this.handshakeInfo = { relayProtocol: 1, serverId: answer.serverId, serverName: answer.serverName, dshVersion: 'test', fingerprints: {} }
      this.state = 'online'
      this.notify()
      return this.handshakeInfo
    },
    reconnect() {
      if (this.state !== 'offline' || this.stopped) return false
      void this.connect().catch(() => {})
      return true
    },
    probeHealth() {
      return env.has(`${this.options.getServerUrl()}|${this.options.getToken()}`)
    },
    networkRestored() {
      if (this.state !== 'offline' || this.stopped) return false
      void this.connect().catch(() => {})
      return true
    },
    credentialsChanged() {
      void this.connect().catch(() => {})
    },
    queueDeviceName() {},
    stop() {
      this.stopped = true
    },
    // PC-14a: simulate a dropped link (or a re-dial caught mid-flight) — the
    // observable effect a dead mux path has on the real client: the state
    // word leaves `online`, the handshake fact goes away, listeners hear it.
    drop(nextState = 'offline') {
      this.state = nextState
      this.handshakeInfo = undefined
      this.lastError = nextState
      this.notify()
    },
  })
}

/** Let the real pool's fire-and-forget connect() promises settle. */
async function settlePool(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

test('PC-11a-fix1 status: a real pool drives both routes to the same capacity facts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zr-pc11a-'))
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ }
  })

  const poolMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'relay-pool.js')).href)
  const env = new Map([['http://10.7.0.1:3088|tok-real', { serverId: 'real0001', serverName: '书房' }]])
  let configured = 8
  let source = 'default'
  let gatewayCap
  const pool = poolMod.createRelayPool({
    stateFile: path.join(dir, 'zen-remote-state.json'),
    computeOwnFingerprints: () => ({}),
    createClient: makeRealPoolClientFactory(env),
    getMaxServers: () => configured,
    getMaxServersSource: () => source,
    getPeerNetworkCap: () => gatewayCap,
  })
  t.after(() => pool.stop())
  const paired = await pool.pair({ serverUrl: 'http://10.7.0.1:3088', token: 'tok-real' })
  assert.equal(paired.ok, true, 'the real pool paired the one server')
  await settlePool()
  assert.equal(pool.entries().length, 1, 'the paired entry landed in the real pool')

  // The fake engine snapshot carries the mounted rows and the RAW network
  // total (12, self included); the mount CAP itself comes from the real pool.
  const { engine } = makePeerEngine({
    status: {
      nodeId: 'abcd1234',
      gatewayState: 'authorized',
      networkId: '0123456789abcdef',
      maxPeers: 12,
      natType: 'cone',
      peers: [
        { nodeId: 'aaaa1111', name: '书房电脑', state: 'eligible', path: 'lan', rttMs: 3, mounted: true },
        { nodeId: 'bbbb2222', name: '客厅电脑', state: 'eligible', path: 'none', rttMs: null, mounted: false },
      ],
    },
  })
  const { server, port } = await startClientServer(makeRow(), { pool, getMaxServers: () => configured, getPeerEngine: () => engine })
  t.after(() => closeServer(server))
  const both = async () => {
    const client = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    const peer = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
    return [JSON.parse(client.body), JSON.parse(peer.body)]
  }

  // Default-layer config under a 12-member network: the pool synthesizes
  // 12 - self = 11; BOTH routes answer the pool's own live number.
  gatewayCap = 12
  let [client, peer] = await both()
  assert.equal(peer.maxPeers, 12, 'raw maxPeers keeps the network total including self')
  assert.equal(pool.maxServers(), 11, 'the real pool synthesizes network cap minus self')
  assert.equal(client.maxServers, pool.maxServers(), 'client/status rides the real synthesis')
  assert.equal(peer.maxServers, pool.maxServers(), 'peer/status rides the very same synthesis')
  assert.equal(peer.mountedCount, 1)
  assert.equal(peer.limitReached, false, '1 of 11 — room left')

  // A user-chosen row cap is only lowered by the network: min(8, 11) = 8.
  source = 'row'
  ;[client, peer] = await both()
  assert.equal(pool.maxServers(), 8, 'the explicit cap wins while tighter')
  assert.equal(client.maxServers, pool.maxServers())
  assert.equal(peer.maxServers, pool.maxServers())

  // Hot network shrink (12 → 6, default layer): 6 - self = 5 on the very
  // next read of BOTH routes; the mounted stock stays counted.
  source = 'default'
  gatewayCap = 6
  ;[client, peer] = await both()
  assert.equal(pool.maxServers(), 5, 'the live network change reached the pool synthesis')
  assert.equal(client.maxServers, pool.maxServers())
  assert.equal(peer.maxServers, pool.maxServers())
  assert.equal(peer.mountedCount, 1, 'the mount stock survives the shrink')
  assert.equal(peer.limitReached, false)
})

// ---- PC-14a: the sync-readiness facts (the third light's data) ------------------
// peer/status grows one additive `sync` object derived from the facts the
// engine and the pool ALREADY hold: which discovered peers are eligible
// candidates, how many of them have a REAL pool mount (entryId = nodeId, the
// mountVirtual seam — never an old client pairing that happens to carry the
// same serverId), and how many of those mounts' clients have actually
// completed the remote handshake (`client.state === 'online'`). `ready` means
// "every candidate is handshake-online and nothing is blocked" — the LICENSE
// to sync, never a claim that any concrete session data finished
// synchronizing (a peer sharing zero sessions is still perfectly ready), so
// there is deliberately no `synced` field.

test('PC-14a status: a real pool drives the sync facts live over the HTTP route (online ↔ offline/connecting)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zr-pc14a-sync-'))
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ }
  })

  const poolMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'relay-pool.js')).href)
  // Handshake answers keyed `url|token` — the virtual mounts' placeholder
  // origins (`http://zr-peer-<nodeId>.virtual|peer-virtual`). bbbb2222 has
  // none, so its mount's handshake fails exactly like a dead network.
  const env = new Map([['http://zr-peer-aaaa1111.virtual|peer-virtual', { serverId: 'aaaa1111', serverName: '书房电脑' }]])
  const pool = poolMod.createRelayPool({
    stateFile: path.join(dir, 'zen-remote-state.json'),
    computeOwnFingerprints: () => ({}),
    createClient: makeRealPoolClientFactory(env),
    skipPersistedServers: true,
  })
  t.after(() => pool.stop())

  const { engine } = makePeerEngine({
    status: {
      nodeId: 'abcd1234',
      gatewayState: 'authorized',
      networkId: '0123456789abcdef',
      maxPeers: 8,
      natType: 'cone',
      peers: [
        { nodeId: 'aaaa1111', name: '书房电脑', state: 'eligible', path: 'lan', rttMs: 3, mounted: true },
        { nodeId: 'bbbb2222', name: '客厅电脑', state: 'eligible', path: 'none', rttMs: null, mounted: true },
        { nodeId: 'dddd4444', name: '被我忽略的机器', state: 'disabled', path: 'none', rttMs: null, mounted: false },
      ],
    },
  })
  // The engine's own mount seam (mountPeer verbatim): memory-only virtual
  // entries keyed by the peer nodeId.
  const throwFetch = async () => { throw new Error('the fake client never dials a socket') }
  pool.mountVirtual({ entryId: 'aaaa1111', serverId: 'aaaa1111', serverName: '书房电脑', fetchImpl: throwFetch })
  pool.mountVirtual({ entryId: 'bbbb2222', serverId: 'bbbb2222', serverName: '客厅电脑', fetchImpl: throwFetch })
  await settlePool()
  assert.equal(pool.isVirtual('aaaa1111') && pool.isVirtual('bbbb2222'), true, 'both mounts are virtual pool entries')

  const { server, port } = await startClientServer(makeRow(), { pool, getPeerEngine: () => engine })
  t.after(() => closeServer(server))
  const syncOf = async () => {
    const res = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
    assert.equal(res.status, 200)
    return JSON.parse(res.body).sync
  }

  // aaaa1111's mount handshake-online through the real pool client;
  // bbbb2222's handshake fails → its mount sits offline. Both mounts are counted
  // in mountedCandidateCount (PS-3a five-count contract).
  assert.deepEqual(await syncOf(), {
    readyCount: 1,
    mountedCandidateCount: 2,
    candidateCount: 2,
    ignoredCount: 1,
    mismatchCount: 0,
  })
  assert.ok(!('synced' in (await syncOf())), 'no fabricated sync-completed signal exists')
  assert.ok(!('state' in (await syncOf())), 'no derived state enum exists')
  assert.ok(!('reason' in (await syncOf())), 'no derived reason enum exists')
  assert.ok(!('unmountedCount' in (await syncOf())), 'no redundant unmountedCount exists')

  // The second mount recovers (its network came back): readyCount reaches 2.
  env.set('http://zr-peer-bbbb2222.virtual|peer-virtual', { serverId: 'bbbb2222', serverName: '客厅电脑' })
  assert.equal(pool.getByEntryId('bbbb2222').client.reconnect(), true, 'the offline mount redials')
  await settlePool()
  assert.deepEqual(await syncOf(), {
    readyCount: 2,
    mountedCandidateCount: 2,
    candidateCount: 2,
    ignoredCount: 1,
    mismatchCount: 0,
  })

  // The first link drops (mux path dies): readyCount drops immediately.
  pool.getByEntryId('aaaa1111').client.drop('offline')
  assert.deepEqual(await syncOf(), {
    readyCount: 1,
    mountedCandidateCount: 2,
    candidateCount: 2,
    ignoredCount: 1,
    mismatchCount: 0,
  })

  // A re-dial caught mid-flight (`connecting`) drops readyCount to 0.
  pool.getByEntryId('bbbb2222').client.drop('connecting')
  assert.deepEqual(await syncOf(), {
    readyCount: 0,
    mountedCandidateCount: 2,
    candidateCount: 2,
    ignoredCount: 1,
    mismatchCount: 0,
  })

  // Recovery rides the SAME real client: back to 1 ready.
  assert.equal(pool.getByEntryId('aaaa1111').client.reconnect(), true)
  await settlePool()
  const recovered = await syncOf()
  assert.equal(recovered.mountedCandidateCount, 2)
  assert.equal(recovered.readyCount, 1)
})

test('PS-3a status: the 5-count sync object over the engine snapshot and pool client states', async () => {
  const peer = (nodeId, name, state, mounted) => ({ nodeId, name, state, path: mounted ? 'lan' : 'none', rttMs: mounted ? 2 : null, mounted })
  const entryOf = (nodeId, name, state) => ({
    entryId: nodeId,
    serverId: nodeId,
    serverName: name,
    serverUrl: `http://zr-peer-${nodeId}.virtual`,
    displayName: name,
    client: fakeRelay({ state }),
    createdAt: 1,
  })
  const engineOf = (peers, gatewayState = 'authorized', networkId = '0123456789abcdef') =>
    makePeerEngine({ status: { nodeId: 'abcd1234', gatewayState, networkId, maxPeers: 8, natType: 'cone', peers } }).engine
  const read = async (engine, entries = [], virtualIds = []) => {
    const pool = fakePool(entries, { virtualIds })
    const { server, port } = await startClientServer(makeRow(), { pool, getPeerEngine: () => engine })
    try {
      const res = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
      assert.equal(res.status, 200)
      return JSON.parse(res.body).sync
    } finally {
      await closeServer(server)
    }
  }

  // 1. Not joined: zero everything.
  assert.deepEqual(await read(engineOf([], 'unconfigured', null)), {
    readyCount: 0, mountedCandidateCount: 0, candidateCount: 0, ignoredCount: 0, mismatchCount: 0,
  })
  // 2. Joined and authorized, empty network.
  assert.deepEqual(await read(engineOf([])), {
    readyCount: 0, mountedCandidateCount: 0, candidateCount: 0, ignoredCount: 0, mismatchCount: 0,
  })
  // 3. Every discovered device actively ignored.
  assert.deepEqual(
    await read(engineOf([peer('aaaa1111', '书房电脑', 'disabled', false), peer('bbbb2222', '客厅电脑', 'disabled', false)])),
    { readyCount: 0, mountedCandidateCount: 0, candidateCount: 0, ignoredCount: 2, mismatchCount: 0 },
  )
  // 4. Eligible peers without real mounts: candidateCount=2, mountedCandidateCount=0.
  assert.deepEqual(
    await read(engineOf([peer('aaaa1111', '书房电脑', 'eligible', false), peer('bbbb2222', '客厅电脑', 'eligible', false)])),
    { readyCount: 0, mountedCandidateCount: 0, candidateCount: 2, ignoredCount: 0, mismatchCount: 0 },
  )
  // 5. Every candidate mounted and handshake-online.
  assert.deepEqual(
    await read(
      engineOf([peer('aaaa1111', '书房电脑', 'eligible', true), peer('bbbb2222', '客厅电脑', 'eligible', true)]),
      [entryOf('aaaa1111', '书房电脑', 'online'), entryOf('bbbb2222', '客厅电脑', 'online')],
      ['aaaa1111', 'bbbb2222'],
    ),
    { readyCount: 2, mountedCandidateCount: 2, candidateCount: 2, ignoredCount: 0, mismatchCount: 0 },
  )
  // 6. Mixed: both mounted, one online, one offline.
  assert.deepEqual(
    await read(
      engineOf([peer('aaaa1111', '书房电脑', 'eligible', true), peer('bbbb2222', '客厅电脑', 'eligible', true)]),
      [entryOf('aaaa1111', '书房电脑', 'online'), entryOf('bbbb2222', '客厅电脑', 'offline')],
      ['aaaa1111', 'bbbb2222'],
    ),
    { readyCount: 1, mountedCandidateCount: 2, candidateCount: 2, ignoredCount: 0, mismatchCount: 0 },
  )
  // 6b. One candidate mounted and online, another candidate unmounted (e.g. maxServers reached or unselected).
  assert.deepEqual(
    await read(
      engineOf([peer('aaaa1111', '书房电脑', 'eligible', true), peer('bbbb2222', '客厅电脑', 'eligible', false)]),
      [entryOf('aaaa1111', '书房电脑', 'online')],
      ['aaaa1111'],
    ),
    { readyCount: 1, mountedCandidateCount: 1, candidateCount: 2, ignoredCount: 0, mismatchCount: 0 },
  )
  // 7. A local TOFU mismatch counts in mismatchCount alongside mounted candidate counts.
  assert.deepEqual(
    await read(
      engineOf([peer('aaaa1111', '书房电脑', 'eligible', true), peer('cccc3333', '换了钥的机器', 'identity-mismatch', false)]),
      [entryOf('aaaa1111', '书房电脑', 'online')],
      ['aaaa1111'],
    ),
    { readyCount: 1, mountedCandidateCount: 1, candidateCount: 1, ignoredCount: 0, mismatchCount: 1 },
  )
  // 8. Pure counts stay factual regardless of gatewayState (gatewayState gates light/exit separately).
  assert.deepEqual(
    await read(
      engineOf([peer('aaaa1111', '书房电脑', 'eligible', true)], 'offline'),
      [entryOf('aaaa1111', '书房电脑', 'online')],
      ['aaaa1111'],
    ),
    { readyCount: 1, mountedCandidateCount: 1, candidateCount: 1, ignoredCount: 0, mismatchCount: 0 },
  )
})

test('PC-14a status: only real virtual mounts count — an old client pairing never impersonates a peer', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zr-pc14a-imp-'))
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ }
  })

  const poolMod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'relay-pool.js')).href)
  // A persisted DSH pairing whose handshake reports serverId 'aaaa1111' —
  // the SAME word as the peer nodeId. Persisted record ids are
  // randomBytes(4).hex (the same SHAPE as a nodeId), so only the virtual-flag
  // discrimination can tell the two apart.
  const env = new Map([
    ['http://10.7.0.9:3088|tok-old', { serverId: 'aaaa1111', serverName: '旧配对' }],
  ])
  const pool = poolMod.createRelayPool({
    stateFile: path.join(dir, 'zen-remote-state.json'),
    computeOwnFingerprints: () => ({}),
    createClient: makeRealPoolClientFactory(env),
  })
  t.after(() => pool.stop())
  const paired = await pool.pair({ serverUrl: 'http://10.7.0.9:3088', token: 'tok-old' })
  assert.equal(paired.ok, true)
  const mounted = pool.mountVirtual({ entryId: 'aaaa1111', serverId: 'aaaa1111', serverName: '书房电脑', fetchImpl: async () => { throw new Error('unused') } })
  await settlePool()
  assert.equal(pool.getByEntryId('aaaa1111').entryId, 'aaaa1111', 'the entryId seam resolves the VIRTUAL mount, not the paired record')
  assert.equal(pool.isVirtual('aaaa1111'), true)
  assert.notEqual(paired.entry.entryId, 'aaaa1111', 'the paired record keeps its own random id')
  assert.equal(paired.entry.client.state, 'online', 'the old pairing is handshake-online — exactly the impersonation bait')
  assert.equal(mounted.client.state, 'offline', 'the virtual mount has no network yet')

  const { engine } = makePeerEngine({
    status: {
      nodeId: 'abcd1234',
      gatewayState: 'authorized',
      networkId: '0123456789abcdef',
      maxPeers: 8,
      natType: 'cone',
      peers: [{ nodeId: 'aaaa1111', name: '书房电脑', state: 'eligible', path: 'none', rttMs: null, mounted: true }],
    },
  })
  const { server, port } = await startClientServer(makeRow(), { pool, getPeerEngine: () => engine })
  t.after(() => closeServer(server))
  const res = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
  assert.equal(res.status, 200)
  // The ONLINE old pairing must not impersonate the offline peer mount:
  // readyCount reads the virtual client (offline -> 0), mountedCandidateCount is 1.
  assert.deepEqual(JSON.parse(res.body).sync, {
    readyCount: 0,
    mountedCandidateCount: 1,
    candidateCount: 1,
    ignoredCount: 0,
    mismatchCount: 0,
  })
})

test('PC-14a status: no pool wired keeps the old body shape (no sync facts, no guessing)', async () => {
  const { engine } = makePeerEngine()
  const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine })
  try {
    const res = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal('sync' in body, false, 'without a pool there is no honest readiness fact — the field stays absent')
  } finally {
    await closeServer(server)
  }
})

test('PG-9 join: a valid invite reaches joinNetwork verbatim; a bad one never leaves the route', async () => {
  const { engine, calls } = makePeerEngine()
  const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine })
  try {
    const ok = await request(port, {
      method: 'POST',
      path: PEER_JOIN_PATH,
      headers: sameOrigin(port),
      body: { inviteUri: 'zr-net://10.0.0.1:4088/0123456789abcdef#secret-key' },
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(JSON.parse(ok.body), { ok: true })
    assert.deepEqual(calls, [['join', 'zr-net://10.0.0.1:4088/0123456789abcdef#secret-key']])

    // Missing / wrong-type inviteUri is a local 400 before the engine is called.
    const bad = await request(port, { method: 'POST', path: PEER_JOIN_PATH, headers: sameOrigin(port), body: { inviteUri: 42 } })
    assert.equal(bad.status, 400)
    assert.equal(JSON.parse(bad.body).error.code, 'bad-request')
    const empty = await request(port, { method: 'POST', path: PEER_JOIN_PATH, headers: sameOrigin(port), body: {} })
    assert.equal(empty.status, 400)
    assert.equal(calls.length, 1, 'only the valid join reached the engine')

    // GET on a POST route answers 405.
    const wrongMethod = await request(port, { method: 'GET', path: PEER_JOIN_PATH })
    assert.equal(wrongMethod.status, 405)
  } finally {
    await closeServer(server)
  }
})

test('PG-9 join: the engine refusal keeps its code as a 400', async () => {
  const { engine } = makePeerEngine({ joinResult: { ok: false, code: 'invalid-invite' } })
  const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine })
  try {
    const res = await request(port, {
      method: 'POST',
      path: PEER_JOIN_PATH,
      headers: sameOrigin(port),
      body: { inviteUri: 'zr-net://10.0.0.1:4088/bad' },
    })
    assert.equal(res.status, 400)
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: 'invalid-invite' } })
  } finally {
    await closeServer(server)
  }
})

test('PG-9 join: a cross-site origin is refused before the engine runs', async () => {
  const { engine, calls } = makePeerEngine()
  const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine })
  try {
    const res = await request(port, {
      method: 'POST',
      path: PEER_JOIN_PATH,
      headers: { origin: 'https://evil.example' },
      body: { inviteUri: 'zr-net://10.0.0.1:4088/0123456789abcdef' },
    })
    assert.equal(res.status, 403)
    assert.equal(JSON.parse(res.body).error.code, 'origin-rejected')
    assert.deepEqual(calls, [])
  } finally {
    await closeServer(server)
  }
})

test('PG-9 leave: reaches leaveNetwork with no body requirements', async () => {
  const { engine, calls } = makePeerEngine()
  const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine })
  try {
    const res = await request(port, { method: 'POST', path: PEER_LEAVE_PATH, headers: sameOrigin(port), body: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true })
    assert.deepEqual(calls, [['leave']])
  } finally {
    await closeServer(server)
  }
})

test('PG-9 toggle-mount: mounted:false disables the node, mounted:true re-enables it', async () => {
  const { engine, calls } = makePeerEngine()
  const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine })
  try {
    const off = await request(port, {
      method: 'POST', path: PEER_TOGGLE_MOUNT_PATH, headers: sameOrigin(port),
      body: { nodeId: 'AAAA1111', mounted: false },
    })
    assert.equal(off.status, 200)
    assert.deepEqual(JSON.parse(off.body), { ok: true })
    const on = await request(port, {
      method: 'POST', path: PEER_TOGGLE_MOUNT_PATH, headers: sameOrigin(port),
      body: { nodeId: 'aaaa1111', mounted: true },
    })
    assert.equal(on.status, 200)
    assert.deepEqual(calls, [['disable', 'aaaa1111', true], ['disable', 'aaaa1111', false]], 'the node id is normalized, disabled = !mounted')
    // Junk bodies refuse locally.
    for (const body of [{ nodeId: 'aaaa1111' }, { mounted: false }, { nodeId: '', mounted: true }, { nodeId: 'aaaa1111', mounted: 'no' }]) {
      const bad = await request(port, { method: 'POST', path: PEER_TOGGLE_MOUNT_PATH, headers: sameOrigin(port), body })
      assert.equal(bad.status, 400)
    }
  } finally {
    await closeServer(server)
  }
})

test('PG-9 trust: success answers ok; an unknown peer answers 404 unknown-peer', async () => {
  const { engine, calls } = makePeerEngine()
  const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine })
  try {
    const ok = await request(port, { method: 'POST', path: PEER_TRUST_PATH, headers: sameOrigin(port), body: { nodeId: 'cccc3333' } })
    assert.equal(ok.status, 200)
    assert.deepEqual(JSON.parse(ok.body), { ok: true })
    assert.deepEqual(calls, [['trust', 'cccc3333']])
  } finally {
    await closeServer(server)
  }
  const unknown = makePeerEngine({ trustResult: false })
  const { server: s2, port: p2 } = await startClientServer(makeRow(), { getPeerEngine: () => unknown.engine })
  try {
    const res = await request(p2, { method: 'POST', path: PEER_TRUST_PATH, headers: sameOrigin(p2), body: { nodeId: 'ffffffff' } })
    assert.equal(res.status, 404)
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: 'unknown-peer' } })
  } finally {
    await closeServer(s2)
  }
})

test('PG-9 reprobe: fires the punch re-probe and answers ok', async () => {
  const { engine, calls } = makePeerEngine()
  const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine })
  try {
    const res = await request(port, { method: 'POST', path: PEER_REPROBE_PATH, headers: sameOrigin(port), body: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true })
    assert.deepEqual(calls, [['reprobe']])
  } finally {
    await closeServer(server)
  }
})

test('PG-9 POSTs without an engine answer 503 peer-unavailable', async () => {
  const { server, port } = await startClientServer(makeRow())
  try {
    for (const [path, body] of [
      [PEER_JOIN_PATH, { inviteUri: 'zr-net://10.0.0.1:4088/0123456789abcdef' }],
      [PEER_LEAVE_PATH, {}],
      [PEER_TOGGLE_MOUNT_PATH, { nodeId: 'aaaa1111', mounted: true }],
      [PEER_TRUST_PATH, { nodeId: 'cccc3333' }],
      [PEER_REPROBE_PATH, {}],
      [PEER_DISMISS_REVOKED_PATH, {}],
    ]) {
      const res = await request(port, { method: 'POST', path, headers: sameOrigin(port), body })
      assert.equal(res.status, 503, path)
      assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: 'peer-unavailable' } }, path)
    }
  } finally {
    await closeServer(server)
  }
})

test('PAS-4a peer/status revokedNotice, dismiss-revoked, and leave gatewaySynced passthrough', async () => {
  const notice = { networkId: '0123456789abcdef', deviceName: 'Office-Mac', reason: 'removed from network', at: '2026-11-15T00:00:00.000Z' }
  const { engine, calls } = makePeerEngine({
    status: {
      nodeId: 'abcd1234',
      gatewayState: 'revoked',
      deniedReason: 'removed from network',
      revokedNotice: notice,
      networkId: null,
      maxPeers: null,
      natType: 'unknown',
      peers: [],
    },
    leaveResult: { ok: true, gatewaySynced: false },
  })
  const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine })
  try {
    const statusRes = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
    assert.equal(statusRes.status, 200)
    const statusBody = JSON.parse(statusRes.body)
    assert.equal(statusBody.configured, false)
    assert.deepEqual(statusBody.revokedNotice, notice)

    const dismissRes = await request(port, { method: 'POST', path: PEER_DISMISS_REVOKED_PATH, headers: sameOrigin(port), body: {} })
    assert.equal(dismissRes.status, 200)
    assert.deepEqual(JSON.parse(dismissRes.body), { ok: true })
    assert.equal(calls.some((c) => c[0] === 'dismissRevoked'), true)

    const leaveRes = await request(port, { method: 'POST', path: PEER_LEAVE_PATH, headers: sameOrigin(port), body: {} })
    assert.equal(leaveRes.status, 200)
    assert.deepEqual(JSON.parse(leaveRes.body), { ok: true, gatewaySynced: false })
  } finally {
    await closeServer(server)
  }
})

test('PAS-4a peer join by gatewayUrl (Path A): credentials required, ephemeral login+logout, selectionToken, and scheme safety', async () => {
  // 1. Missing email/password returns 400 credentials-required without hitting network.
  {
    const { engine, calls } = makePeerEngine()
    const fetchCalls = []
    const { server, port } = await startClientServer(makeRow(), {
      getPeerEngine: () => engine,
      fetchImpl: async (url) => { fetchCalls.push(String(url)); throw new Error('should not fetch') },
    })
    try {
      const res = await request(port, {
        method: 'POST',
        path: PEER_JOIN_PATH,
        headers: sameOrigin(port),
        body: { gatewayUrl: 'http://203.0.113.99:19393' },
      })
      assert.equal(res.status, 400)
      assert.equal(JSON.parse(res.body).error.code, 'credentials-required')
      assert.deepEqual(fetchCalls, [])
      assert.deepEqual(calls, [])
    } finally {
      await closeServer(server)
    }
  }

  // 2. Single manual network on explicit HTTP -> ping -> login -> networks -> logout (never leaks joinKey).
  {
    const { engine, calls } = makePeerEngine()
    const fetchCalls = []
    const fetchImpl = async (url, init) => {
      fetchCalls.push(`${init?.method ?? 'GET'} ${String(url)}`)
      if (String(url).endsWith('/peer/v1/ping')) {
        return new Response(JSON.stringify({ ok: true, data: { gateway: true } }), { status: 200 })
      }
      if (String(url).endsWith('/api/v1/auth/login')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'set-cookie': 'zr_gw_session=tok1; HttpOnly; Path=/' },
        })
      }
      if (String(url).endsWith('/api/v1/networks')) {
        assert.equal(init?.headers?.cookie, 'zr_gw_session=tok1')
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              networks: [{ id: '1122334455667788', name: 'Office Mesh', admissionMode: 'manual', joinUri: 'zr-net://ignored:19393/1122334455667788' }],
            },
          }),
          { status: 200 },
        )
      }
      if (String(url).endsWith('/api/v1/auth/logout')) {
        assert.equal(init?.headers?.cookie, 'zr_gw_session=tok1')
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
    const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine, fetchImpl })
    try {
      const res = await request(port, {
        method: 'POST',
        path: PEER_JOIN_PATH,
        headers: sameOrigin(port),
        body: { gatewayUrl: 'http://203.0.113.99:19393', email: 'u@example.com', password: 'pw' },
      })
      assert.equal(res.status, 200)
      assert.deepEqual(JSON.parse(res.body), {
        ok: true,
        networkId: '1122334455667788',
        manualApproval: true,
      })
      assert.deepEqual(fetchCalls, [
        'GET http://203.0.113.99:19393/peer/v1/ping',
        'POST http://203.0.113.99:19393/api/v1/auth/login',
        'GET http://203.0.113.99:19393/api/v1/networks',
        'POST http://203.0.113.99:19393/api/v1/auth/logout',
      ])
      assert.deepEqual(calls, [['join', 'zr-net://203.0.113.99:19393/1122334455667788?tls=0']])
    } finally {
      await closeServer(server)
    }
  }

  // 3. Multiple networks -> 409 select-network + selectionToken (logout already ran, joinKey stripped);
  //    second POST consumes selectionToken without re-authenticating.
  {
    const { engine, calls } = makePeerEngine()
    let logoutCount = 0
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/peer/v1/ping')) {
        if (String(url).startsWith('https://')) throw new Error('ECONNREFUSED')
        return new Response(JSON.stringify({ ok: true, data: { gateway: true } }), { status: 200 })
      }
      if (String(url).endsWith('/api/v1/auth/login')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'set-cookie': 'zr_gw_session=tok2; Path=/' } })
      }
      if (String(url).endsWith('/api/v1/networks')) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              networks: [
                { id: 'aaaa111122223333', name: 'Home', admissionMode: 'both', joinUri: 'zr-net://x:19393/aaaa111122223333#secretA' },
                { id: 'bbbb444455556666', name: 'Studio', admissionMode: 'manual', joinUri: 'zr-net://x:19393/bbbb444455556666' },
              ],
            },
          }),
          { status: 200 },
        )
      }
      if (String(url).endsWith('/api/v1/auth/logout')) {
        logoutCount += 1
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
    const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine, fetchImpl })
    try {
      const first = await request(port, {
        method: 'POST',
        path: PEER_JOIN_PATH,
        headers: sameOrigin(port),
        body: { gatewayUrl: '192.168.1.20:19393', email: 'u@example.com', password: 'pw' },
      })
      assert.equal(first.status, 409)
      const firstBody = JSON.parse(first.body)
      assert.equal(firstBody.error.code, 'select-network')
      assert.equal(typeof firstBody.selectionToken, 'string')
      assert.ok(firstBody.selectionToken.length >= 16)
      assert.equal(firstBody.networks.length, 2)
      assert.equal(first.body.includes('secretA'), false, '409 payload must not expose joinKey')
      assert.equal(logoutCount, 1, 'logout must complete in finally before returning 409')
      assert.equal(calls.length, 0)

      const second = await request(port, {
        method: 'POST',
        path: PEER_JOIN_PATH,
        headers: sameOrigin(port),
        body: { selectionToken: firstBody.selectionToken, networkId: 'aaaa111122223333' },
      })
      assert.equal(second.status, 200)
      assert.deepEqual(JSON.parse(second.body), { ok: true, networkId: 'aaaa111122223333', manualApproval: false })
      assert.deepEqual(calls, [['join', 'zr-net://192.168.1.20:19393/aaaa111122223333#secretA']])

      // Consumed selectionToken cannot be replayed.
      const replay = await request(port, {
        method: 'POST',
        path: PEER_JOIN_PATH,
        headers: sameOrigin(port),
        body: { selectionToken: firstBody.selectionToken, networkId: 'bbbb444455556666' },
      })
      assert.equal(replay.status, 400)
      assert.equal(JSON.parse(replay.body).error.code, 'selection-expired')
    } finally {
      await closeServer(server)
    }
  }

  // 4. Empty account networks -> 404 no-network; unreachable gateway -> 502 gateway-unreachable.
  {
    const { engine } = makePeerEngine()
    const fetchEmpty = async (url) => {
      if (String(url).endsWith('/peer/v1/ping')) return new Response(JSON.stringify({ ok: true, data: { gateway: true } }), { status: 200 })
      if (String(url).endsWith('/api/v1/auth/login')) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'set-cookie': 'zr_gw_session=tok3; Path=/' } })
      if (String(url).endsWith('/api/v1/networks')) return new Response(JSON.stringify({ ok: true, data: { networks: [] } }), { status: 200 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine, fetchImpl: fetchEmpty })
    try {
      const res = await request(port, {
        method: 'POST',
        path: PEER_JOIN_PATH,
        headers: sameOrigin(port),
        body: { gatewayUrl: 'http://192.168.1.20:19393', email: 'u@example.com', password: 'pw' },
      })
      assert.equal(res.status, 404)
      assert.equal(JSON.parse(res.body).error.code, 'no-network')
    } finally {
      await closeServer(server)
    }

    const fetchDown = async () => { throw new Error('ECONNREFUSED') }
    const { server: s2, port: p2 } = await startClientServer(makeRow(), { getPeerEngine: () => engine, fetchImpl: fetchDown })
    try {
      const res = await request(p2, {
        method: 'POST',
        path: PEER_JOIN_PATH,
        headers: sameOrigin(p2),
        body: { gatewayUrl: 'http://192.168.1.20:19393', email: 'u@example.com', password: 'pw' },
      })
      assert.equal(res.status, 502)
      assert.equal(JSON.parse(res.body).error.code, 'gateway-unreachable')
    } finally {
      await closeServer(s2)
    }
  }
})

test('PS-2: identity-error exposes sanitized peer/status and answers 503 identity-error on mutations', async () => {
  const { server, port } = await startClientServer(makeRow({ maxServers: 6 }), {
    getMaxServers: () => 6,
    getPeerEngine: () => undefined,
    getPeerIdentityError: () => 'state-file-unreadable',
  })
  try {
    const statusRes = await request(port, { method: 'GET', path: PEER_STATUS_PATH })
    assert.equal(statusRes.status, 200)
    const statusBody = JSON.parse(statusRes.body)
    assert.deepEqual(statusBody, {
      configured: false,
      nodeId: '',
      gatewayState: 'identity-error',
      identityError: 'state-file-unreadable',
      maxPeers: null,
      maxServers: 6,
      mountedCount: 0,
      limitReached: false,
      peers: [],
    })
    assert.equal(statusRes.body.includes('/'), false, 'zero OS path leakage in status body')

    const postStatus = await request(port, { method: 'POST', path: PEER_STATUS_PATH, headers: sameOrigin(port), body: {} })
    assert.equal(postStatus.status, 405)

    for (const [path, body] of [
      [PEER_JOIN_PATH, { inviteUri: 'zr-net://10.0.0.1:4088/0123456789abcdef' }],
      [PEER_LEAVE_PATH, {}],
      [PEER_TOGGLE_MOUNT_PATH, { nodeId: 'aaaa1111', mounted: false }],
      [PEER_TRUST_PATH, { nodeId: 'cccc3333' }],
      [PEER_REPROBE_PATH, {}],
      [PEER_DISMISS_REVOKED_PATH, {}],
    ]) {
      const res = await request(port, { method: 'POST', path, headers: sameOrigin(port), body })
      assert.equal(res.status, 503, path)
      assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: 'identity-error' } }, path)
    }
  } finally {
    await closeServer(server)
  }
})

test('PS-4a peer join mode=advanced: assembles invite server-side and returns typed 400 errors on bad fields', async () => {
  const { engine, calls } = makePeerEngine()
  const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine })
  try {
    // Valid split fields with leading/trailing spaces preserved in joinKey.
    const keyed = await request(port, {
      method: 'POST',
      path: PEER_JOIN_PATH,
      headers: sameOrigin(port),
      body: { mode: 'advanced', gatewayAddress: '10.0.0.1:4088', networkId: '0123456789ABCDEF', joinKey: ' padded key ' },
    })
    assert.equal(keyed.status, 200)
    assert.deepEqual(JSON.parse(keyed.body), { ok: true })
    assert.deepEqual(calls.pop(), ['join', 'zr-net://10.0.0.1:4088/0123456789abcdef#%20padded%20key%20'])

    // Valid keyless manual-approval split fields.
    const keyless = await request(port, {
      method: 'POST',
      path: PEER_JOIN_PATH,
      headers: sameOrigin(port),
      body: { mode: 'advanced', gatewayAddress: 'gw.example.com', networkId: '0123456789abcdef' },
    })
    assert.equal(keyless.status, 200)
    assert.deepEqual(calls.pop(), ['join', 'zr-net://gw.example.com:19393/0123456789abcdef'])

    // Invalid gateway / networkId / lone surrogate joinKey return 400 with exact codes and zero engine calls.
    for (const [body, expectedCode] of [
      [{ mode: 'advanced', gatewayAddress: 'bad host', networkId: '0123456789abcdef' }, 'bad-adv-gateway'],
      [{ mode: 'advanced', gatewayAddress: 123, networkId: '0123456789abcdef' }, 'bad-adv-gateway'],
      [{ mode: 'advanced', gatewayAddress: '10.0.0.1:4088', networkId: 'short' }, 'bad-adv-network-id'],
      [{ mode: 'advanced', gatewayAddress: '10.0.0.1:4088', networkId: null }, 'bad-adv-network-id'],
      [{ mode: 'advanced', gatewayAddress: '10.0.0.1:4088', networkId: '0123456789abcdef', joinKey: 42 }, 'bad-adv-join-key'],
    ]) {
      const res = await request(port, { method: 'POST', path: PEER_JOIN_PATH, headers: sameOrigin(port), body })
      assert.equal(res.status, 400, expectedCode)
      assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: expectedCode } }, expectedCode)
    }
    assert.equal(calls.length, 0)
  } finally {
    await closeServer(server)
  }
})
