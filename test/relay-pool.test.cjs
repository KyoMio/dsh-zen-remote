/* dsh-zen-remote · relay-pool (src/relay-pool.ts → lib/relay-pool.js)
 *
 * MS-2: up to 8 RelayClient instances over the paired-servers list in the
 * state file, plus the display-name numbering for the merged sidebar. The
 * tests drive the BUILT lib/relay-pool.js with an INJECTED client factory
 (`createClient`), so no socket ever opens: the fakes answer handshakes from
 * a table the test controls, and the pool's real disk behavior (handshake
 * persistence, dedupe removal, unpair) is asserted against a real state file
 * under os.tmpdir().
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'relay-pool.js')).href

let mod
test.before(async () => {
  mod = await import(MODULE_URL)
})

function tempStateFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-pool-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'zen-remote-state.json')
}

/** Let the pool's fire-and-forget connect() promises settle. */
async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/**
 * A fake createRelayClient: credentials are read through the same getters the
 * real client uses; the handshake answers from `env` keyed `url|token` (a
 * miss means transport failure → offline). Every created client is recorded.
 */
function makeFakeClientFactory(env) {
  const created = []
  const factory = (options) => {
    const client = {
      options,
      state: 'unpaired',
      handshakeInfo: undefined,
      lastError: undefined,
      nextRetryAt: null,
      compat: undefined,
      deviceNameSyncing: false,
      stopped: false,
      credentialsChangedCalls: 0,
      deviceNames: [],
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
        const url = this.options.getServerUrl()
        const token = this.options.getToken()
        const answer = env.get(`${url}|${token}`)
        if (answer === undefined) {
          this.state = 'offline'
          this.lastError = 'offline'
          this.notify()
          throw new Error('offline')
        }
        this.handshakeInfo = {
          relayProtocol: 1,
          serverId: answer.serverId,
          serverName: answer.serverName,
          dshVersion: 'test',
          fingerprints: {},
        }
        this.state = 'online'
        this.notify()
        return this.handshakeInfo
      },
      reconnect() {
        if (this.state !== 'offline' || this.stopped) return false
        void this.connect().catch(() => {})
        return true
      },
      async probeHealth() {
        return env.has(`${this.options.getServerUrl()}|${this.options.getToken()}`)
      },
      networkRestored() {
        if (this.state !== 'offline' || this.stopped) return false
        void this.connect().catch(() => {})
        return true
      },
      credentialsChanged() {
        this.credentialsChangedCalls += 1
        void this.connect().catch(() => {})
      },
      queueDeviceName(name) {
        this.deviceNames.push(name)
      },
      stop() {
        this.stopped = true
      },
    }
    created.push(client)
    return client
  }
  return { created, factory }
}

function baseOptions(stateFile, overrides = {}) {
  return {
    stateFile,
    computeOwnFingerprints: () => ({}),
    ...overrides,
  }
}

// ---- 1. deriveDisplayServerNames ------------------------------------------

test('deriveDisplayServerNames: unique names stay bare; duplicates get -1/-2/-3 in entry order', async () => {
  const { deriveDisplayServerNames } = mod

  const unique = deriveDisplayServerNames([
    { entryId: 'a', serverName: 'home', serverUrl: 'http://10.0.0.1:3088' },
    { entryId: 'b', serverName: 'office', serverUrl: 'http://10.0.0.2:3088' },
    { entryId: 'c', serverName: '', serverUrl: 'http://10.0.0.3:3088' },
  ])
  assert.deepEqual(
    [...unique.entries()],
    [
      ['a', 'home'],
      ['b', 'office'],
      ['c', 'http://10.0.0.3:3088'],
    ],
    'an empty name falls back to the URL as its base',
  )

  const duplicated = deriveDisplayServerNames([
    { entryId: 'a', serverName: 'home', serverUrl: 'http://10.0.0.1:3088' },
    { entryId: 'b', serverName: ' home ', serverUrl: 'http://10.0.0.2:3088' },
    { entryId: 'c', serverName: 'home', serverUrl: 'http://10.0.0.3:3088' },
    { entryId: 'd', serverName: 'other', serverUrl: 'http://10.0.0.4:3088' },
  ])
  assert.deepEqual(
    [...duplicated.entries()],
    [
      ['a', 'home-1'],
      ['b', 'home-2'],
      ['c', 'home-3'],
      ['d', 'other'],
    ],
    'trimmed-equal bases count as duplicates, numbered in pairing order',
  )
})

test('deriveDisplayServerNames: fixing a duplicate removes the suffix', async () => {
  const { deriveDisplayServerNames } = mod
  const renamed = deriveDisplayServerNames([
    { entryId: 'a', serverName: 'home', serverUrl: 'http://10.0.0.1:3088' },
    { entryId: 'b', serverName: 'renamed', serverUrl: 'http://10.0.0.2:3088' },
  ])
  assert.deepEqual(
    [...renamed.entries()],
    [
      ['a', 'home'],
      ['b', 'renamed'],
    ],
    'no duplicate, no suffix',
  )
})

// ---- 2. the pool lifecycle --------------------------------------------------

test('the pool migrates the legacy row client at startup and handshakes persist into the state file', async (t) => {
  const stateFile = tempStateFile(t)
  const env = new Map([['http://10.0.0.1:3088|tok-1', { serverId: 'aaa11111', serverName: 'home' }]])
  const { factory } = makeFakeClientFactory(env)
  const stateChanges = []
  const pool = mod.createRelayPool(
    baseOptions(stateFile, {
      legacySource: () => ({ serverUrl: 'http://10.0.0.1:3088', deviceToken: 'tok-1' }),
      createClient: factory,
      onStateChange: (event) => stateChanges.push(event),
    }),
  )

  await settle()
  const entries = pool.entries()
  assert.equal(entries.length, 1, 'the legacy row client became exactly one entry')
  assert.equal(entries[0].serverUrl, 'http://10.0.0.1:3088')
  assert.equal(entries[0].serverId, 'aaa11111', 'the handshake id is visible on the view')
  assert.equal(entries[0].serverName, 'home')
  assert.equal(entries[0].displayName, 'home')
  assert.equal(entries[0].client.state, 'online')
  assert.equal(typeof entries[0].createdAt, 'number')

  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(onDisk.servers[0].serverId, 'aaa11111', 'the handshake was persisted')
  assert.equal(onDisk.servers[0].serverName, 'home')
  assert.ok(
    stateChanges.some((event) => event.entryId === entries[0].entryId && event.state === 'online' && event.serverId === 'aaa11111'),
    'state changes carry the entry id and server id',
  )
  pool.stop()
})

test('pair adds an entry, re-pairing the same URL reuses the entry and calls credentialsChanged', async (t) => {
  const stateFile = tempStateFile(t)
  const env = new Map([
    ['http://10.0.0.1:3088|tok-1', { serverId: 'aaa11111', serverName: 'home' }],
    ['http://10.0.0.1:3088|tok-2', { serverId: 'aaa11111', serverName: 'home' }],
    // The new address IS the same server — its handshake reports the SAME
    // serverId, which is what fires the dedupe below.
    ['https://dsh.example.com|tok-3', { serverId: 'aaa11111', serverName: 'home' }],
  ])
  const { created, factory } = makeFakeClientFactory(env)
  const removed = []
  const pool = mod.createRelayPool(
    baseOptions(stateFile, {
      createClient: factory,
      onServerRemoved: (event) => removed.push(event),
    }),
  )
  await settle()

  const first = await pool.pair({ serverUrl: 'http://10.0.0.1:3088', token: 'tok-1', deviceId: 'dev-1', deviceName: 'phone' })
  assert.equal(first.ok, true)
  assert.equal(first.replaced, false)
  await settle()
  assert.equal(pool.entries().length, 1)
  assert.equal(created.length, 1, 'one client for one entry')

  // Same URL, fresh token: the SAME client is re-credentialed, not replaced.
  const repair = await pool.pair({ serverUrl: 'http://10.0.0.1:3088/', token: 'tok-2' })
  assert.equal(repair.ok, true)
  assert.equal(repair.replaced, true)
  assert.equal(repair.entry.entryId, first.entry.entryId, 'the entry id is stable across a re-pair')
  assert.equal(created.length, 1, 'no second client was created')
  assert.equal(created[0].credentialsChangedCalls, 1, 'credentialsChanged triggered the reconnect')
  await settle()
  assert.equal(created[0].state, 'online', 'the re-paired client is online again under the new token')
  assert.equal(pool.entries().length, 1)

  // A different URL at the same server id: once ITS handshake lands, the old
  // entry loses the dedupe and is removed everywhere.
  const moved = await pool.pair({ serverUrl: 'https://dsh.example.com', token: 'tok-3' })
  assert.equal(moved.ok, true)
  assert.equal(moved.replaced, false)
  await settle()
  const entries = pool.entries()
  assert.equal(entries.length, 1, 'the stale same-server entry was removed')
  assert.equal(entries[0].entryId, moved.entry.entryId, 'the new entry survived')
  assert.equal(entries[0].serverId, 'aaa11111')
  assert.equal(created[0].stopped, true, 'the deduped client was stopped')
  assert.equal(fs.existsSync(stateFile), true)
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(onDisk.servers.length, 1, 'and gone from the state file')
  assert.deepEqual(
    removed,
    [{ entryId: first.entry.entryId, serverId: 'aaa11111', reason: 'dedupe' }],
    'the dedupe removal was announced',
  )
  pool.stop()
})

test('pair refuses an invalid URL and the limit-reached cap; getByEntryId/getByServerId locate entries', async (t) => {
  const stateFile = tempStateFile(t)
  const env = new Map()
  for (let i = 1; i <= 8; i += 1) {
    env.set(`http://10.0.0.${i}:3088|t${i}`, { serverId: String(i).repeat(8), serverName: `s${i}` })
  }
  const { factory } = makeFakeClientFactory(env)
  const pool = mod.createRelayPool(baseOptions(stateFile, { createClient: factory }))

  assert.deepEqual(await pool.pair({ serverUrl: 'nope', token: 't' }), { ok: false, code: 'invalid-url' })
  for (let i = 1; i <= 8; i += 1) {
    const result = await pool.pair({ serverUrl: `http://10.0.0.${i}:3088`, token: `t${i}` })
    assert.equal(result.ok, true)
  }
  await settle()
  assert.deepEqual(
    await pool.pair({ serverUrl: 'http://10.0.1.1:3088', token: 't9' }),
    { ok: false, code: 'limit-reached' },
  )
  assert.equal(pool.entries().length, 8)

  const target = pool.entries()[2]
  assert.equal(pool.getByEntryId(target.entryId).entryId, target.entryId)
  assert.equal(pool.getByEntryId('nonesuch'), undefined)
  const record = JSON.parse(fs.readFileSync(stateFile, 'utf8')).servers[2]
  assert.equal(record.serverId, '33333333', 'the handshake id was persisted on the record')
  assert.equal(pool.getByServerId(record.serverId).entryId, target.entryId, 'the persisted handshake id locates the entry')
  assert.equal(pool.getByServerId('ffffffff'), undefined)
  pool.stop()
})

test('unpair stops and removes one entry; unpairAll empties everything and announces each removal', async (t) => {
  const stateFile = tempStateFile(t)
  const env = new Map([
    ['http://10.0.0.1:3088|t1', { serverId: 'aaa11111', serverName: 'home' }],
    ['http://10.0.0.2:3088|t2', { serverId: 'bbb22222', serverName: 'office' }],
  ])
  const { created, factory } = makeFakeClientFactory(env)
  const removed = []
  const pool = mod.createRelayPool(
    baseOptions(stateFile, {
      legacySource: () => ({ serverUrl: 'http://10.0.0.1:3088', deviceToken: 't1' }),
      createClient: factory,
      onServerRemoved: (event) => removed.push(event),
    }),
  )
  await settle()
  await pool.pair({ serverUrl: 'http://10.0.0.2:3088', token: 't2' })
  await settle()
  assert.equal(pool.entries().length, 2)

  const officeId = pool.getByServerId('bbb22222').entryId
  assert.equal(pool.unpair(officeId), true)
  assert.equal(pool.unpair(officeId), false, 'a second unpair of the same id answers false')
  assert.equal(pool.entries().length, 1)
  assert.equal(created[1].stopped, true, 'the unpaired client was stopped')
  assert.deepEqual(
    removed,
    [{ entryId: officeId, serverId: 'bbb22222', reason: 'unpair' }],
  )
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(onDisk.servers.length, 1, 'the unpaired record is gone from disk')

  const count = pool.unpairAll()
  assert.equal(count, 1, 'the number of cleared records')
  assert.deepEqual(pool.entries(), [], 'the pool is empty')
  assert.equal(created[0].stopped, true, 'every remaining client was stopped')
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).servers.length, 0, 'the state file list is empty')
  assert.equal(removed.length, 2, 'every removal was announced')
  assert.equal(removed[1].reason, 'unpair')
  pool.stop()
})

test('queueDeviceNameAll broadcasts; reconnect and probeAndRestoreAll target offline clients', async (t) => {
  const stateFile = tempStateFile(t)
  const env = new Map([
    ['http://10.0.0.1:3088|t1', { serverId: 'aaa11111', serverName: 'home' }],
    // The second server is unreachable — its client lands offline.
  ])
  const { created, factory } = makeFakeClientFactory(env)
  const pool = mod.createRelayPool(
    baseOptions(stateFile, {
      legacySource: () => ({ serverUrl: 'http://10.0.0.1:3088', deviceToken: 't1' }),
      createClient: factory,
    }),
  )
  await settle()
  await pool.pair({ serverUrl: 'http://10.0.0.2:3088', token: 't2' })
  await settle()

  pool.queueDeviceNameAll('desk')
  assert.deepEqual(created.map((client) => client.deviceNames), [['desk'], ['desk']], 'every client got the name')

  const offline = created.find((client) => client.state === 'offline')
  assert.ok(offline, 'the unreachable server is offline')
  const reconnected = await pool.reconnect()
  assert.equal(reconnected, true, 'an offline client accepted the reconnect')
  await settle()
  assert.equal(offline.state, 'offline', 'the fake still cannot reach it — but an attempt ran')

  const probe = await pool.probeAndRestoreAll()
  assert.deepEqual(probe, { reachable: false, reconnected: false }, 'nothing is reachable while the server is down')
  env.set('http://10.0.0.2:3088|t2', { serverId: 'bbb22222', serverName: 'office' })
  const restored = await pool.probeAndRestoreAll()
  assert.deepEqual(restored, { reachable: true, reconnected: true }, 'the probe confirms and networkRestored dials')
  await settle()
  assert.equal(offline.state, 'online')

  // reconnect(entryId) targets ONE client; an unknown id answers false.
  const onlineId = pool.entries()[0].entryId
  assert.equal(await pool.reconnect(onlineId), false, 'an online client has nothing to reconnect')
  offline.state = 'offline'
  assert.equal(await pool.reconnect(pool.entries()[1].entryId), true)
  assert.equal(await pool.reconnect('nonesuch'), false)
  pool.stop()
  assert.equal(created.every((client) => client.stopped), true, 'stop() tears every client down')
})

// ---- PG-2: the dynamic maxServers cap -----------------------------------------

test('pool.maxServers(): default 8, the live getter wins, and pair() forwards the dynamic cap', async (t) => {
  const stateFile = tempStateFile(t)
  const env = new Map()
  const { factory } = makeFakeClientFactory(env)
  let configured = 8
  const pool = mod.createRelayPool(baseOptions(stateFile, {
    createClient: factory,
    getMaxServers: () => configured,
  }))

  assert.equal(pool.maxServers(), 8, 'the getter starts at the default 8')
  assert.equal(mod.MAX_PAIRED_SERVERS, 8, 'the re-exported constant stays 8')

  // Fill to 8/8 through pair() — the cap the getter reports is the cap pair
  // enforces.
  for (let i = 1; i <= 8; i += 1) {
    const url = `http://10.0.0.${i}:3088`
    env.set(`${url}|t${i}`, { serverId: String(i).padStart(8, '0'), serverName: `s${i}` })
    const result = await pool.pair({ serverUrl: url, token: `t${i}` })
    assert.equal(result.ok, true, `server ${i} fits`)
  }
  await settle()
  assert.deepEqual(
    await pool.pair({ serverUrl: 'http://10.0.1.1:3088', token: 't9' }),
    { ok: false, code: 'limit-reached' },
    'the ninth is refused at 8/8',
  )

  // The getter is LIVE (the volatile-field discipline): raising it to 16
  // without any reload lets the ninth through immediately.
  configured = 16
  assert.equal(pool.maxServers(), 16)
  env.set('http://10.0.1.1:3088|t9', { serverId: '99999999', serverName: 's9' })
  const ninth = await pool.pair({ serverUrl: 'http://10.0.1.1:3088', token: 't9' })
  assert.equal(ninth.ok, true, 'the raised cap admits the ninth server without a reload')
  await settle()
  assert.equal(pool.entries().length, 9)

  // Lowering it again re-tightens the cap for the NEXT new address.
  configured = 9
  assert.deepEqual(
    await pool.pair({ serverUrl: 'http://10.0.1.2:3088', token: 't10' }),
    { ok: false, code: 'limit-reached' },
  )
  // A re-pair of an existing address still works over the cap.
  const repair = await pool.pair({ serverUrl: 'http://10.0.0.1:3088', token: 't1' })
  assert.equal(repair.ok, true)
  assert.equal(repair.replaced, true)
  pool.stop()
})

test('pool.maxServers(): no getters at all answers the module default', async (t) => {
  const stateFile = tempStateFile(t)
  const { factory } = makeFakeClientFactory(new Map())
  const pool = mod.createRelayPool(baseOptions(stateFile, { createClient: factory }))
  assert.equal(pool.maxServers(), 8, 'the plain pool keeps the historic 8')
  pool.stop()
})

test('pool.maxServers(): the gateway cap applies only in peer mode, per the config source (PG-2)', async (t) => {
  const stateFile = tempStateFile(t)
  const { factory } = makeFakeClientFactory(new Map())
  const mk = (overrides) => {
    const pool = mod.createRelayPool(baseOptions(stateFile, { createClient: factory, ...overrides }))
    const value = pool.maxServers()
    pool.stop()
    return value
  }

  // No network cap known: the configured value answers.
  assert.equal(mk({ getMaxServers: () => 16 }), 16)

  // The gateway count includes this node; the pool reports remote capacity.
  assert.equal(mk({ getMaxServers: () => 8, getPeerNetworkCap: () => 12 }), 11, 'source default → maxPeersFromGateway - self')
  // The source getter missing behaves like default (the peer wiring always
  // passes it; the omission is a test-only composition).
  assert.equal(mk({ getPeerNetworkCap: () => 12 }), 11)

  // A user-configured cap (env/row/file): the TIGHTER of the two wins.
  assert.equal(mk({ getMaxServers: () => 16, getPeerNetworkCap: () => 12, getMaxServersSource: () => 'env' }), 11, 'configured 16 under gateway 12 → 11 remotes')
  assert.equal(mk({ getMaxServers: () => 10, getPeerNetworkCap: () => 12, getMaxServersSource: () => 'row' }), 10, 'configured 10 under gateway 12 → 10')
  assert.equal(mk({ getMaxServers: () => 20, getPeerNetworkCap: () => 4, getMaxServersSource: () => 'file' }), 3)
  assert.equal(mk({ getMaxServers: () => 8, getPeerNetworkCap: () => 1 }), 8, 'invalid network count ignored')

  // No gateway cap (peerNetwork absent → undefined): configured wins even in
  // peer mode.
  assert.equal(mk({ getMaxServers: () => 16, getPeerNetworkCap: () => undefined, getMaxServersSource: () => 'default' }), 16)

  // The cap getter is consulted per call, never snapshotted at construction.
  let configured = 8
  let gatewayCap
  const pool = mod.createRelayPool(baseOptions(stateFile, {
    createClient: factory,
    getMaxServers: () => configured,
    getPeerNetworkCap: () => gatewayCap,
    getMaxServersSource: () => 'default',
  }))
  assert.equal(pool.maxServers(), 8)
  gatewayCap = 12
  assert.equal(pool.maxServers(), 11, 'the network record arriving later changes the answer')
  configured = 5
  gatewayCap = undefined
  assert.equal(pool.maxServers(), 5, 'and falling back moves with the live getter too')
  pool.stop()
})

test('pool.pair() forwards the pool.maxServers() cap to the state store (PG-2)', async (t) => {
  const stateFile = tempStateFile(t)
  const env = new Map()
  const { factory } = makeFakeClientFactory(env)
  const pool = mod.createRelayPool(baseOptions(stateFile, {
    createClient: factory,
    getMaxServers: () => 2,
  }))
  for (let i = 1; i <= 2; i += 1) {
    env.set(`http://10.4.0.${i}:3088|t${i}`, { serverId: String(i).padStart(8, '0'), serverName: `s${i}` })
    assert.equal((await pool.pair({ serverUrl: `http://10.4.0.${i}:3088`, token: `t${i}` })).ok, true)
  }
  await settle()
  assert.deepEqual(
    await pool.pair({ serverUrl: 'http://10.4.0.3:3088', token: 't3' }),
    { ok: false, code: 'limit-reached' },
    'pair enforces the configured cap, not the constant',
  )
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(onDisk.servers.length, 2)
  pool.stop()
})
