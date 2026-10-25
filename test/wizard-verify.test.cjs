/* dsh-zen-remote · final verification (GW-9)
 *
 * The REAL createVerificationManager over a real local mock gateway: the
 * start chain (runtime gate → gateway status baseline → probe → web
 * pairing code), the poll chain (newcomer detection, the cookie-Secure
 * verdict, expiry, config-fingerprint staleness), the memory-only session
 * rule, and the "minting a code restarts nothing" rule (the mock records
 * every call — after start, only GET /lan-gate/status may fly).
 */
'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const load = (rel) => import(pathToFileURL(path.join(__dirname, '..', 'lib', rel)).href)

let verify

before(async () => {
  verify = await load('wizard/verify.js')
})

after(() => new Promise((resolve) => setImmediate(resolve)))

/** A mock gateway carrying the two surfaces verification reads: a mutable
 * device list + lastWebClaim, and a web pairing-code minter. Every call
 * is recorded so tests can pin the request SEQUENCE. */
function startMockGateway(opts = {}) {
  const state = {
    devices: [...(opts.devices ?? [])],
    lastWebClaim: opts.lastWebClaim ?? null,
    port: 3088,
    pairExpiresAt: opts.pairExpiresAt,
    up: opts.up !== false,
    calls: [],
  }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      state.calls.push({ method: req.method, url: String(req.url).split('?')[0], body })
      if (!state.up) { res.writeHead(500); res.end(); return }
      if (String(req.url).split('?')[0] === '/lan-gate/status') {
        const payload = { state: 'running', port: state.port, devices: state.devices, lastWebClaim: state.lastWebClaim }
        const bytes = Buffer.from(JSON.stringify(payload))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
        return
      }
      if (String(req.url).split('?')[0] === '/lan-gate/pair' && req.method === 'POST') {
        const payload = { ok: true, code: 'VERIFCODE', expiresAt: state.pairExpiresAt ?? Date.now() + 600_000, role: 'web' }
        const bytes = Buffer.from(JSON.stringify(payload))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) })
        res.end(bytes)
        return
      }
      res.writeHead(404)
      res.end('{"ok":false}')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })))
}

const GOOD_PROBE = { kind: 'reached', root: 'gateway-pairing-page', admin: 'gateway-admin-403', ms: 5 }

/** One manager over the mock gateway; `values` is shared with the test so
 * fingerprint drift is a one-field edit. */
function makeManager(gatewayPort, opts = {}) {
  const values = {
    role: 'host', port: gatewayPort, host: '127.0.0.1', ingressMode: 'caddy',
    ingressDomain: 'dsh.example.com', ingressHttpsPort: 8443, ingressPublicUrl: '', trustedProxies: '',
  }
  const probeCalls = []
  const manager = verify.createVerificationManager({
    gatewayBase: `http://127.0.0.1:${gatewayPort}`,
    getValues: () => values,
    probe: async (url) => {
      probeCalls.push(url)
      return opts.probeResult ?? GOOD_PROBE
    },
    ...(opts.runtimeReady !== undefined ? { runtimeReady: opts.runtimeReady } : {}),
  })
  return { manager, values, probeCalls }
}

test('start: the full happy chain answers the pairing material and mints exactly one code', async () => {
  const gw = await startMockGateway({ devices: [{ id: 'dev-old' }] })
  try {
    const { manager, probeCalls } = makeManager(gw.port)
    const result = await manager.start({ publicUrl: 'https://dsh.example.com' })
    assert.deepEqual(result, { ok: true, pairingCode: 'VERIFCODE', publicUrl: 'https://dsh.example.com', expiresAt: result.ok ? result.expiresAt : 0 })
    assert.ok(result.ok && result.expiresAt > Date.now())
    assert.equal(probeCalls.length, 1)
    assert.equal(probeCalls[0], 'https://dsh.example.com')
    assert.equal(manager.hasSession(), true)
    // Call sequence: the status baseline read happens BEFORE the pair POST.
    assert.deepEqual(gw.state.calls.map((c) => `${c.method} ${c.url}`), ['GET /lan-gate/status', 'POST /lan-gate/pair'])
    assert.equal(JSON.parse(gw.state.calls[1].body).role, 'web', 'the web-app pairing role')
  } finally {
    await new Promise((resolve) => gw.server.close(resolve))
  }
})

test('start refusals: no url, bad url, runtime gate, dead gateway, failed probe', async () => {
  // no-public-url / bad-public-url.
  const gw = await startMockGateway()
  try {
    const { manager } = makeManager(gw.port)
    assert.equal((await manager.start({ publicUrl: '   ' })).reason, 'no-public-url')
    assert.equal((await manager.start({ publicUrl: 'https://x/path' })).reason, 'bad-public-url')
    assert.equal((await manager.start({ publicUrl: 'http://dsh.example.com' })).reason, 'bad-public-url', 'public plain http never verifies')
    assert.equal(gw.state.calls.length, 0, 'the refusals never reached the gateway')
    assert.equal(manager.hasSession(), false)

    // runtime-not-ready (the injected ingress-process gate).
    const gated = makeManager(gw.port, { runtimeReady: () => false })
    assert.equal((await gated.manager.start({ publicUrl: 'https://dsh.example.com' })).reason, 'runtime-not-ready')

    // gateway-unreachable: a dead port.
    const dead = http.createServer()
    await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const deadPort = dead.address().port
    await new Promise((resolve) => dead.close(resolve))
    const unreachable = makeManager(deadPort)
    assert.equal((await unreachable.manager.start({ publicUrl: 'https://dsh.example.com' })).reason, 'gateway-unreachable')

    // probe-failed carries the classifications that missed.
    const wrongPage = makeManager(gw.port, { probeResult: { kind: 'reached', root: 'redirect', admin: 'gateway-admin-403', ms: 1 } })
    const failed = await wrongPage.manager.start({ publicUrl: 'https://dsh.example.com' })
    assert.equal(failed.ok, false)
    assert.equal(failed.reason, 'probe-failed')
    assert.deepEqual(failed.detail, { kind: 'reached', root: 'redirect', admin: 'gateway-admin-403', ms: 1 })
    // No pairing code was minted on a failed probe.
    assert.ok(!gw.state.calls.some((c) => c.url === '/lan-gate/pair'), 'the code is minted only after the probe passes')
  } finally {
    await new Promise((resolve) => gw.server.close(resolve))
  }
})

test('check: pending until a newcomer appears, then the cookie verdict decides', async () => {
  const gw = await startMockGateway({ devices: [{ id: 'dev-old' }] })
  try {
    const { manager } = makeManager(gw.port)
    assert.deepEqual(await manager.check(), { result: 'not-started' })
    assert.equal((await manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)

    // No newcomer yet.
    assert.deepEqual(await manager.check(), { result: 'pending' })
    assert.deepEqual(await manager.check(), { result: 'pending' })

    // A phone pairs: newcomer + secure claim → PASS, session consumed.
    gw.state.devices.push({ id: 'dev-new' })
    gw.state.lastWebClaim = { id: 'dev-new', secure: true, at: 1698249660000 }
    assert.deepEqual(await manager.check(), { result: 'pass', deviceId: 'dev-new', at: 1698249660000 })
    assert.equal(manager.hasSession(), false)

    // After a verdict the session is gone — the next poll is not-started.
    assert.deepEqual(await manager.check(), { result: 'not-started' })
  } finally {
    await new Promise((resolve) => gw.server.close(resolve))
  }
})

test('check: an insecure claim is surfaced, not blessed; a missing claim keeps polling', async () => {
  const gw = await startMockGateway({ devices: [] })
  try {
    const { manager } = makeManager(gw.port)
    assert.equal((await manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)
    gw.state.devices.push({ id: 'dev-new' })
    gw.state.lastWebClaim = { id: 'dev-new', secure: false, at: 1 }
    assert.deepEqual(await manager.check(), { result: 'cookie-insecure', deviceId: 'dev-new' }, 'the proxy dropped X-Forwarded-Proto')

    // No claim record at all (an older gateway, a racing read): pending.
    const second = makeManager(gw.port)
    assert.equal((await second.manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)
    gw.state.lastWebClaim = null
    assert.deepEqual(await second.manager.check(), { result: 'pending' })

    // A claim naming a DIFFERENT device: pending too, never a pass.
    const third = makeManager(gw.port)
    assert.equal((await third.manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)
    gw.state.lastWebClaim = { id: 'dev-someone-else', secure: true, at: 2 }
    assert.deepEqual(await third.manager.check(), { result: 'pending' })
  } finally {
    await new Promise((resolve) => gw.server.close(resolve))
  }
})

test('check: expiry answers code-expired and clears the session', async () => {
  const gw = await startMockGateway({ pairExpiresAt: Date.now() - 1 })
  try {
    const { manager } = makeManager(gw.port)
    assert.equal((await manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true, 'start itself does not judge expiry')
    assert.deepEqual(await manager.check(), { result: 'code-expired' })
    assert.equal(manager.hasSession(), false)
  } finally {
    await new Promise((resolve) => gw.server.close(resolve))
  }
})

test('check: a config-fingerprint drift answers stale and discards the session', async () => {
  const gw = await startMockGateway()
  try {
    const { manager, values } = makeManager(gw.port)
    assert.equal((await manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)
    // ANY of the bound fields moving invalidates: try the gateway port…
    gw.state.port = 4088
    assert.deepEqual(await manager.check(), { result: 'stale' })
    assert.equal(manager.hasSession(), false)
    assert.deepEqual(await manager.check(), { result: 'not-started' })

    // …and trustedProxies (the trust-proxy click mid-verification case).
    const second = makeManager(gw.port)
    assert.equal((await second.manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)
    second.values.trustedProxies = '198.51.100.7'
    assert.deepEqual(await second.manager.check(), { result: 'stale' })
  } finally {
    await new Promise((resolve) => gw.server.close(resolve))
  }
})

test('minting the code restarts nothing: after start, only status reads fly', async () => {
  const gw = await startMockGateway()
  try {
    const { manager } = makeManager(gw.port)
    assert.equal((await manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)
    gw.state.calls.length = 0
    await manager.check()
    await manager.check()
    await manager.check()
    assert.deepEqual(
      gw.state.calls.map((c) => `${c.method} ${c.url}`),
      ['GET /lan-gate/status', 'GET /lan-gate/status', 'GET /lan-gate/status'],
      'polling is read-only — no action, no new-code, no pair',
    )
  } finally {
    await new Promise((resolve) => gw.server.close(resolve))
  }
})
