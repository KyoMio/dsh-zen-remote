/* PAS-4a: Real multi-tenant gateway-server Path A login, isolation,
 * immediate logout, public HTTPS anti-downgrade, and state-file zero-secret test.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { request } = require('./util.cjs')

const { createClientHandler, CLIENT_PEER_JOIN_ROUTE } = require('../lib/client-routes.js')
const { ensurePeerIdentity, readStateFile } = require('../lib/state-store.js')
const { createPeerEngine } = require('../lib/peer/engine.js')
const { createRelayPool } = require('../lib/relay-pool.js')

const { createGatewayApiServer } = require('../gateway-server/dist/server.js')
const { SqliteStore } = require('../gateway-server/dist/store/sqlite-store.js')
const { deriveMasterKeyFromSecret, hashPassword } = require('../gateway-server/dist/master-key.js')
const { PeerWsHub } = require('../gateway-server/dist/peer-hub/ws-hub.js')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-gw-login-'))
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* best effort */ } })

async function listen(server, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  return server.address().port
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve))
}

async function apiJson(baseUrl, method, urlPath, body, cookie) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : undefined
  const setCookie = res.headers.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : [])
  const rawCookie = setCookie.find((line) => line.startsWith('zr_gw_session='))?.split(';', 1)[0]
  return { status: res.status, json, cookie: rawCookie }
}

test('PAS-4a real multi-tenant gateway: isolates owner networks, logs out immediately before returning, synthesizes both/manual URIs, and never writes secrets to disk', async () => {
  const store = new SqliteStore({
    seed: { allowSignup: false, maxNetworksPerUser: 4, defaultMaxPeers: 8, relayRateKbps: 512 },
  })
  const masterKey = deriveMasterKeyFromSecret('pas-4a-gateway-login-test')
  const hub = new PeerWsHub({ store, masterKey, rateTickMs: null, flushMs: null })
  const gwServer = createGatewayApiServer({ store, masterKey, runtime: hub, hooks: hub.hooks, topology: hub })
  const gwPort = await listen(gwServer)
  hub.attach(gwServer)
  const gwBase = `http://127.0.0.1:${gwPort}`

  // Seed two separate tenant users: Tenant A owns 2 networks (both + manual), Tenant B owns 1 network.
  store.createUser({ email: 'alpha@pas4a.test', passwordHash: await hashPassword('AlphaPass!123'), role: 'user' })
  store.createUser({ email: 'beta@pas4a.test', passwordHash: await hashPassword('BetaPass!123'), role: 'user' })

  const loginA = await apiJson(gwBase, 'POST', '/api/v1/auth/login', { email: 'alpha@pas4a.test', password: 'AlphaPass!123' })
  assert.equal(loginA.status, 200)
  const loginB = await apiJson(gwBase, 'POST', '/api/v1/auth/login', { email: 'beta@pas4a.test', password: 'BetaPass!123' })
  assert.equal(loginB.status, 200)

  const netA1 = (await apiJson(gwBase, 'POST', '/api/v1/networks', { name: 'Alpha-Auto', admissionMode: 'both' }, loginA.cookie)).json.data
  const netA2 = (await apiJson(gwBase, 'POST', '/api/v1/networks', { name: 'Alpha-Manual', admissionMode: 'manual' }, loginA.cookie)).json.data
  const netB1 = (await apiJson(gwBase, 'POST', '/api/v1/networks', { name: 'Beta-Secret-Net', admissionMode: 'both' }, loginB.cookie)).json.data
  assert.ok(netA1.joinUri.includes('#'))
  assert.equal(netA2.joinUri.includes('#'), false)

  // Spy on real outbound fetch calls to capture the transient gateway cookie created inside Path A.
  const seenCookies = []
  const capturedInvites = []
  const stateFile = path.join(ROOT, 'zen-remote-state.json')
  const identity = ensurePeerIdentity(stateFile)
  const pool = createRelayPool({ maxServers: 8 })
  const realEngine = createPeerEngine({
    stateFile,
    identity,
    relayPool: pool,
    relayHandler: () => undefined,
    relaySecret: () => 'pas4a-relay-secret',
    serverName: () => 'PAS4A-Node',
    udpProbe: null,
  })
  const wrappedEngine = {
    ...realEngine,
    joinNetwork: async (uri) => {
      capturedInvites.push(uri)
      return realEngine.joinNetwork(uri)
    },
  }

  const clientHandler = createClientHandler({
    admit: () => ({ ok: true }),
    getRowConfig: () => ({ role: 'peer' }),
    getPeerEngine: () => wrappedEngine,
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init)
      if (String(url).endsWith('/api/v1/auth/login')) {
        const list = response.headers.getSetCookie?.() ?? []
        for (const item of list) {
          const m = /(zr_gw_session=[^;\s,]+)/u.exec(item)
          if (m) seenCookies.push(m[1])
        }
      }
      return response
    },
  })
  const clientServer = http.createServer((req, res) => { void clientHandler(req, res) })
  const clientPort = await listen(clientServer)

  try {
    // 1. Unauthenticated /peer/v1/networks must be gone (404).
    const legacyRes = await fetch(`${gwBase}/peer/v1/networks`)
    assert.equal(legacyRes.status, 404)

    // 2. Wrong password returns 401 auth-failed and leaves zero state changes.
    const badPwRes = await request(clientPort, {
      method: 'POST',
      path: CLIENT_PEER_JOIN_ROUTE,
      headers: { origin: `http://127.0.0.1:${clientPort}`, host: `127.0.0.1:${clientPort}` },
      body: { gatewayUrl: `127.0.0.1:${gwPort}`, email: 'alpha@pas4a.test', password: 'WrongPassword' },
    })
    assert.equal(badPwRes.status, 401)
    assert.equal(JSON.parse(badPwRes.body).error.code, 'auth-failed')

    // 3. Logging in as Alpha against bare loopback address (https probe fails -> falls back to http):
    //    returns 409 select-network containing ONLY Alpha's 2 networks (never Beta-Secret-Net).
    const step1 = await request(clientPort, {
      method: 'POST',
      path: CLIENT_PEER_JOIN_ROUTE,
      headers: { origin: `http://127.0.0.1:${clientPort}`, host: `127.0.0.1:${clientPort}` },
      body: { gatewayUrl: `127.0.0.1:${gwPort}`, email: 'alpha@pas4a.test', password: 'AlphaPass!123' },
    })
    assert.equal(step1.status, 409)
    const step1Body = JSON.parse(step1.body)
    assert.equal(step1Body.error.code, 'select-network')
    assert.equal(step1Body.networks.length, 2)
    assert.deepEqual(step1Body.networks.map((n) => n.id).sort(), [netA1.id, netA2.id].sort())
    assert.equal(step1.body.includes(netB1.id), false)
    assert.equal(step1.body.includes('Beta-Secret-Net'), false)
    assert.equal(seenCookies.length, 1)

    // Crucial security assertion: the transient gateway session must ALREADY be logged out before 409 returns!
    const meAfter409 = await apiJson(gwBase, 'GET', '/api/v1/auth/me', undefined, seenCookies[0])
    assert.equal(meAfter409.status, 200)
    assert.equal(meAfter409.json.data.authenticated, false, 'transient gateway cookie must be logged out immediately after listing')
    const netsAfter409 = await apiJson(gwBase, 'GET', '/api/v1/networks', undefined, seenCookies[0])
    assert.equal(netsAfter409.status, 401, 'transient gateway cookie must be rejected on /api/v1/networks')

    // 4. Selecting netA2 (manual) joins WITHOUT #joinKey using reachable 127.0.0.1:<gwPort> and waits in pending.
    const step2Manual = await request(clientPort, {
      method: 'POST',
      path: CLIENT_PEER_JOIN_ROUTE,
      headers: { origin: `http://127.0.0.1:${clientPort}`, host: `127.0.0.1:${clientPort}` },
      body: { selectionToken: step1Body.selectionToken, networkId: netA2.id },
    })
    assert.equal(step2Manual.status, 200)
    assert.deepEqual(JSON.parse(step2Manual.body), { ok: true, networkId: netA2.id, manualApproval: true })
    assert.equal(capturedInvites[0], `zr-net://127.0.0.1:${gwPort}/${netA2.id}`)
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(realEngine.status().gatewayState, 'pending-approval')

    // 5. Explicitly selecting netA1 (both) authorizes immediately using synthesized #joinKey.
    const explicitBoth = await request(clientPort, {
      method: 'POST',
      path: CLIENT_PEER_JOIN_ROUTE,
      headers: { origin: `http://127.0.0.1:${clientPort}`, host: `127.0.0.1:${clientPort}` },
      body: { gatewayUrl: `127.0.0.1:${gwPort}/${netA1.id}`, email: 'alpha@pas4a.test', password: 'AlphaPass!123' },
    })
    assert.equal(explicitBoth.status, 200)
    assert.deepEqual(JSON.parse(explicitBoth.body), { ok: true, networkId: netA1.id, manualApproval: false })
    assert.ok(capturedInvites[1].includes(`/${netA1.id}#`), 'both mode carries extracted #joinKey')
    for (let i = 0; i < 40 && realEngine.status().gatewayState !== 'authorized'; i += 1) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.equal(realEngine.status().gatewayState, 'authorized')

    // 6. State file on disk must never retain password or zr_gw_session cookie.
    const diskRaw = fs.readFileSync(stateFile, 'utf8')
    assert.equal(diskRaw.includes('AlphaPass!123'), false)
    assert.equal(diskRaw.includes('zr_gw_session'), false)
    assert.equal(readStateFile(stateFile).peerNetwork?.networkId, netA1.id)
  } finally {
    realEngine.stop()
    await closeServer(clientServer)
    await closeServer(gwServer)
  }
})

test('PAS-4a transport hardening: bare public hostname never downgrades to HTTP; explicit HTTP upgrades on 426 TLS_REQUIRED', async () => {
  // 1. Bare public hostname strictly probes HTTPS only (zero HTTP credential transmission).
  {
    const triedUrls = []
    const clientHandler = createClientHandler({
      admit: () => ({ ok: true }),
      getRowConfig: () => ({ role: 'peer' }),
      getPeerEngine: () => ({
        joinNetwork: async () => ({ ok: true }),
        leaveNetwork: async () => ({ ok: true, gatewaySynced: true }),
        dismissRevokedNotice: () => {},
        setNodeDisabled: () => {},
        trustPeer: () => true,
        reprobePunch: () => {},
        status: () => ({ configured: false, nodeId: 'aaaa1111', gatewayState: 'unconfigured', networkId: null, maxPeers: null, natType: 'unknown', peers: [] }),
      }),
      fetchImpl: async (url) => {
        triedUrls.push(String(url))
        throw new Error('TLS handshake failed')
      },
    })
    const clientServer = http.createServer((req, res) => { void clientHandler(req, res) })
    const port = await listen(clientServer)
    try {
      const res = await request(port, {
        method: 'POST',
        path: CLIENT_PEER_JOIN_ROUTE,
        headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` },
        body: { gatewayUrl: 'gw.example.com', email: 'u@example.com', password: 'secret' },
      })
      assert.equal(res.status, 502)
      assert.equal(JSON.parse(res.body).error.code, 'gateway-unreachable')
      assert.deepEqual(triedUrls, ['https://gw.example.com:19393/peer/v1/ping'])
      assert.equal(triedUrls.some((u) => u.startsWith('http://')), false)
    } finally {
      await closeServer(clientServer)
    }
  }

  // 2. Explicit http:// getting 426 TLS_REQUIRED on /peer/v1/ping upgrades to https:// before sending credentials.
  {
    const sentRequests = []
    let joinedUri = ''
    const clientHandler = createClientHandler({
      admit: () => ({ ok: true }),
      getRowConfig: () => ({ role: 'peer' }),
      getPeerEngine: () => ({
        joinNetwork: async (uri) => { joinedUri = uri; return { ok: true } },
        leaveNetwork: async () => ({ ok: true, gatewaySynced: true }),
        dismissRevokedNotice: () => {},
        setNodeDisabled: () => {},
        trustPeer: () => true,
        reprobePunch: () => {},
        status: () => ({ configured: false, nodeId: 'aaaa1111', gatewayState: 'unconfigured', networkId: null, maxPeers: null, natType: 'unknown', peers: [] }),
      }),
      fetchImpl: async (url, init) => {
        sentRequests.push(`${init?.method ?? 'GET'} ${String(url)}`)
        if (String(url) === 'http://gw.example.com:19393/peer/v1/ping') {
          return new Response(JSON.stringify({ ok: false, error: { code: 'TLS_REQUIRED' } }), { status: 426 })
        }
        if (String(url) === 'https://gw.example.com:19393/peer/v1/ping') {
          return new Response(JSON.stringify({ ok: true, data: { gateway: true } }), { status: 200 })
        }
        if (String(url) === 'https://gw.example.com:19393/api/v1/auth/login') {
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'set-cookie': 'zr_gw_session=tlsTok; Path=/' } })
        }
        if (String(url) === 'https://gw.example.com:19393/api/v1/networks') {
          return new Response(JSON.stringify({ ok: true, data: { networks: [{ id: '1234567890abcdef', name: 'TLS-Net', admissionMode: 'manual' }] } }), { status: 200 })
        }
        if (String(url) === 'https://gw.example.com:19393/api/v1/auth/logout') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        throw new Error(`unexpected URL ${url}`)
      },
    })
    const clientServer = http.createServer((req, res) => { void clientHandler(req, res) })
    const port = await listen(clientServer)
    try {
      const res = await request(port, {
        method: 'POST',
        path: CLIENT_PEER_JOIN_ROUTE,
        headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` },
        body: { gatewayUrl: 'http://gw.example.com:19393', email: 'u@example.com', password: 'secret' },
      })
      assert.equal(res.status, 200)
      assert.equal(joinedUri, 'zr-net://gw.example.com:19393/1234567890abcdef')
      assert.deepEqual(sentRequests, [
        'GET http://gw.example.com:19393/peer/v1/ping',
        'GET https://gw.example.com:19393/peer/v1/ping',
        'POST https://gw.example.com:19393/api/v1/auth/login',
        'GET https://gw.example.com:19393/api/v1/networks',
        'POST https://gw.example.com:19393/api/v1/auth/logout',
      ])
    } finally {
      await closeServer(clientServer)
    }
  }
})
