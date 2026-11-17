'use strict'
const { test, before } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { startResetServer } = require('./util.cjs')

const load = (rel) => import(pathToFileURL(path.join(__dirname, '..', 'lib', rel)).href)

let probe
let verify

before(async () => {
  probe = await load('wizard/probe.js')
  verify = await load('wizard/verify.js')
})

const PAIRING_PAGE = '<!doctype html><html><script>fetch("/lan-gate/pair/claim"'
const GOOD_PROBE = { kind: 'reached', root: 'gateway-pairing-page', admin: 'gateway-admin-403', ms: 5 }

function serve(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

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

// --- hostPath probe (GW-8) ----------------------------------------------------

test('classifyRootResponse and classifyAdminResponse cover every branch', () => {
  const pairingBody = '<!doctype html><html><body>fetch("/lan-gate/pair/claim",...)</body></html>'
  assert.equal(probe.classifyRootResponse(401, 'text/html; charset=utf-8', pairingBody), 'gateway-pairing-page')
  assert.equal(probe.classifyRootResponse(401, 'text/html; charset=utf-8', '<html>login</html>'), 'unexpected-401')
  assert.equal(probe.classifyRootResponse(401, 'application/json', pairingBody), 'unexpected-401')
  assert.equal(probe.classifyRootResponse(200, 'text/html', '<html>hello</html>'), 'unexpected-200')
  assert.equal(probe.classifyRootResponse(302, 'text/html', ''), 'redirect')
  assert.equal(probe.classifyRootResponse(301, '', ''), 'redirect')
  assert.equal(probe.classifyRootResponse(500, 'text/plain', 'boom'), 'unexpected')

  assert.equal(probe.classifyAdminResponse(403, 'application/json; charset=utf-8', '{"ok":false}'), 'gateway-admin-403')
  assert.equal(probe.classifyAdminResponse(200, 'text/html; charset=utf-8', '<html>gateway admin</html>'), 'admin-exposed')
  assert.equal(probe.classifyAdminResponse(403, 'text/html; charset=utf-8', '<html>Access denied</html>'), 'proxy-403')
  assert.equal(probe.classifyAdminResponse(403, 'application/json', '<html>not json</html>'), 'unexpected')
  assert.equal(probe.classifyAdminResponse(403, 'application/json', '{"ok":true}'), 'unexpected')
  assert.equal(probe.classifyAdminResponse(500, 'text/plain', 'boom'), 'unexpected')
})

test('probeHostPath: happy pairing page + admin 403, exposed admin, manual redirect, LAN http, invalid inputs, reset & timeout', async (t) => {
  const happy = await serve((req, res) => {
    if (req.url === '/lan-gate/admin') {
      const body = '{"ok":false}'
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.length) })
      res.end(body)
      return
    }
    if (String(req.headers.accept || '').includes('application/json')) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end('{"ok":false,"reason":"unpaired"}')
      return
    }
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAIRING_PAGE)
  })
  t.after(() => new Promise((resolve) => happy.server.close(resolve)))
  const happyOutcome = await probe.probeHostPath(`http://127.0.0.1:${happy.port}`)
  assert.equal(happyOutcome.kind, 'reached')
  assert.equal(happyOutcome.root, 'gateway-pairing-page')
  assert.equal(happyOutcome.admin, 'gateway-admin-403')
  assert.ok(typeof happyOutcome.ms === 'number' && happyOutcome.ms >= 0)

  const exposed = await serve((req, res) => {
    if (req.url === '/lan-gate/admin') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html>gateway admin</html>')
      return
    }
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAIRING_PAGE)
  })
  t.after(() => new Promise((resolve) => exposed.server.close(resolve)))
  const exposedOutcome = await probe.probeHostPath(`http://127.0.0.1:${exposed.port}`)
  assert.equal(exposedOutcome.kind, 'reached')
  assert.equal(exposedOutcome.admin, 'admin-exposed')

  const redir = await serve((req, res) => {
    res.writeHead(302, { Location: 'https://elsewhere.example/login' })
    res.end()
  })
  t.after(() => new Promise((resolve) => redir.server.close(resolve)))
  const redirOutcome = await probe.probeHostPath(`http://127.0.0.1:${redir.port}`)
  assert.equal(redirOutcome.kind, 'reached')
  assert.equal(redirOutcome.root, 'redirect')
  assert.equal(redirOutcome.admin, 'unexpected')

  for (const bad of ['not a url', 'ftp://x', 'https://x/path', 'https://x?q=1']) {
    assert.deepEqual(await probe.probeHostPath(bad), { kind: 'unreachable', reason: 'invalid-url', ms: 0 }, bad)
  }
  assert.deepEqual(await probe.probeHostPath('http://dsh.example.com'), { kind: 'unreachable', reason: 'insecure-http', ms: 0 })
  for (const bad of [undefined, null, 42, '', '   ']) {
    const outcome = await probe.probeHostPath(bad)
    assert.equal(outcome.kind, 'unreachable')
    assert.equal(outcome.reason, 'invalid-url')
  }

  const lanOutcome = await probe.probeHostPath(`http://127.0.0.1:${happy.port}/`)
  assert.equal(lanOutcome.kind, 'reached')

  const reset = await startResetServer()
  t.after(() => reset.close())
  const network = await probe.probeHostPath(`http://127.0.0.1:${reset.port}`)
  assert.equal(network.kind, 'unreachable')
  assert.equal(network.reason, 'network')

  const slow = await serve(() => {})
  t.after(() => new Promise((resolve) => slow.server.close(resolve)))
  const timeout = await probe.probeHostPath(`http://127.0.0.1:${slow.port}`, { timeoutMs: 40 })
  assert.equal(timeout.kind, 'unreachable')
  assert.equal(timeout.reason, 'timeout')
})

// --- final verification (GW-9) ------------------------------------------------

test('start: the full happy chain answers the pairing material and mints exactly one code', async (t) => {
  const gw = await startMockGateway({ devices: [{ id: 'dev-old' }] })
  t.after(() => new Promise((resolve) => gw.server.close(resolve)))
  const { manager, probeCalls } = makeManager(gw.port)
  const result = await manager.start({ publicUrl: 'https://dsh.example.com' })
  assert.deepEqual(result, { ok: true, pairingCode: 'VERIFCODE', publicUrl: 'https://dsh.example.com', expiresAt: result.ok ? result.expiresAt : 0 })
  assert.ok(result.ok && result.expiresAt > Date.now())
  assert.equal(probeCalls.length, 1)
  assert.equal(probeCalls[0], 'https://dsh.example.com')
  assert.equal(manager.hasSession(), true)
  assert.deepEqual(gw.state.calls.map((c) => `${c.method} ${c.url}`), ['GET /lan-gate/status', 'POST /lan-gate/pair'])
  assert.equal(JSON.parse(gw.state.calls[1].body).role, 'web')
})

test('start refusals: no url, bad url, runtime gate, dead gateway, failed probe', async (t) => {
  const gw = await startMockGateway()
  t.after(() => new Promise((resolve) => gw.server.close(resolve)))
  const { manager } = makeManager(gw.port)
  assert.equal((await manager.start({ publicUrl: '   ' })).reason, 'no-public-url')
  assert.equal((await manager.start({ publicUrl: 'https://x/path' })).reason, 'bad-public-url')
  assert.equal((await manager.start({ publicUrl: 'http://dsh.example.com' })).reason, 'bad-public-url')
  assert.equal(gw.state.calls.length, 0)
  assert.equal(manager.hasSession(), false)

  const gated = makeManager(gw.port, { runtimeReady: () => false })
  assert.equal((await gated.manager.start({ publicUrl: 'https://dsh.example.com' })).reason, 'runtime-not-ready')

  const reset = await startResetServer()
  t.after(() => reset.close())
  const unreachable = makeManager(reset.port)
  assert.equal((await unreachable.manager.start({ publicUrl: 'https://dsh.example.com' })).reason, 'gateway-unreachable')

  const wrongPage = makeManager(gw.port, { probeResult: { kind: 'reached', root: 'redirect', admin: 'gateway-admin-403', ms: 1 } })
  const failed = await wrongPage.manager.start({ publicUrl: 'https://dsh.example.com' })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'probe-failed')
  assert.deepEqual(failed.detail, { kind: 'reached', root: 'redirect', admin: 'gateway-admin-403', ms: 1 })
  assert.ok(!gw.state.calls.some((c) => c.url === '/lan-gate/pair'))
})

test('check: pending until newcomer, cookie verdict, expiry, fingerprint drift, LAN http, probeOnly, read-only poll, allowUnprobed', async (t) => {
  const gw = await startMockGateway({ devices: [{ id: 'dev-old' }] })
  t.after(() => new Promise((resolve) => gw.server.close(resolve)))

  // pending -> pass -> not-started
  {
    const { manager } = makeManager(gw.port)
    assert.deepEqual(await manager.check(), { result: 'not-started' })
    assert.equal((await manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)
    assert.deepEqual(await manager.check(), { result: 'pending' })
    assert.deepEqual(await manager.check(), { result: 'pending' })
    gw.state.devices.push({ id: 'dev-new' })
    gw.state.lastWebClaim = { id: 'dev-new', secure: true, at: 1698249660000 }
    assert.deepEqual(await manager.check(), { result: 'pass', deviceId: 'dev-new', at: 1698249660000 })
    assert.equal(manager.hasSession(), false)
    assert.deepEqual(await manager.check(), { result: 'not-started' })
  }

  // insecure claim / missing claim / different device
  {
    gw.state.devices = []
    gw.state.lastWebClaim = null
    const { manager } = makeManager(gw.port)
    assert.equal((await manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)
    gw.state.devices.push({ id: 'dev-new' })
    gw.state.lastWebClaim = { id: 'dev-new', secure: false, at: 1 }
    assert.deepEqual(await manager.check(), { result: 'cookie-insecure', deviceId: 'dev-new' })

    const second = makeManager(gw.port)
    assert.equal((await second.manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)
    gw.state.lastWebClaim = null
    assert.deepEqual(await second.manager.check(), { result: 'pending' })

    const third = makeManager(gw.port)
    assert.equal((await third.manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)
    gw.state.lastWebClaim = { id: 'dev-someone-else', secure: true, at: 2 }
    assert.deepEqual(await third.manager.check(), { result: 'pending' })
  }

  // expiry
  {
    gw.state.pairExpiresAt = Date.now() - 1
    const { manager } = makeManager(gw.port)
    assert.equal((await manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)
    assert.deepEqual(await manager.check(), { result: 'code-expired' })
    assert.equal(manager.hasSession(), false)
    gw.state.pairExpiresAt = undefined
  }

  // config-fingerprint drift
  {
    const { manager } = makeManager(gw.port)
    assert.equal((await manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)
    gw.state.port = 4088
    assert.deepEqual(await manager.check(), { result: 'stale' })
    assert.equal(manager.hasSession(), false)
    assert.deepEqual(await manager.check(), { result: 'not-started' })

    const second = makeManager(gw.port)
    assert.equal((await second.manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)
    second.values.trustedProxies = '198.51.100.7'
    assert.deepEqual(await second.manager.check(), { result: 'stale' })
  }

  // plain http LAN pairing
  {
    gw.state.devices = [{ id: 'dev-old' }]
    gw.state.lastWebClaim = null
    const { manager } = makeManager(gw.port)
    const started = await manager.start({ publicUrl: 'http://192.168.1.10:3088' })
    assert.equal(started.ok, true)
    assert.equal(started.publicUrl, 'http://192.168.1.10:3088')
    gw.state.devices.push({ id: 'dev-lan' })
    gw.state.lastWebClaim = { id: 'dev-lan', secure: false, at: 1700000005000 }
    assert.deepEqual(await manager.check(), { result: 'pass', deviceId: 'dev-lan', at: 1700000005000 })
  }

  // probeOnly + read-only poll
  {
    gw.state.calls.length = 0
    const { manager, probeCalls } = makeManager(gw.port)
    const result = await manager.start({ publicUrl: 'https://dsh.example.com', probeOnly: true })
    assert.deepEqual(result, { ok: true, pairingCode: '', publicUrl: 'https://dsh.example.com', expiresAt: 0 })
    assert.equal(probeCalls.length, 1)
    assert.equal(manager.hasSession(), false)
    assert.deepEqual(gw.state.calls.map((c) => `${c.method} ${c.url}`), ['GET /lan-gate/status'])

    assert.equal((await manager.start({ publicUrl: 'https://dsh.example.com' })).ok, true)
    gw.state.calls.length = 0
    await manager.check()
    await manager.check()
    await manager.check()
    assert.deepEqual(
      gw.state.calls.map((c) => `${c.method} ${c.url}`),
      ['GET /lan-gate/status', 'GET /lan-gate/status', 'GET /lan-gate/status'],
    )
  }

  // allowUnprobed + desktop-client newcomer
  {
    gw.state.devices = [{ id: 'dev-old', role: 'web' }]
    const failedProbe = { kind: 'unreachable', reason: 'network', detail: 'ECONNREFUSED', ms: 2 }
    const { manager } = makeManager(gw.port, { probeResult: failedProbe })
    const result = await manager.start({ publicUrl: 'http://100.64.0.10:3088', allowUnprobed: true })
    assert.equal(result.ok, true)
    assert.equal(result.pairingCode, 'VERIFCODE')
    assert.deepEqual(result.probeWarning, failedProbe)
    assert.equal(manager.hasSession(), true)

    gw.state.devices.push({ id: 'dev-desktop', role: 'desktop-client' })
    const checked = await manager.check()
    assert.equal(checked.result, 'pass')
    assert.equal(checked.deviceId, 'dev-desktop')
  }
})
