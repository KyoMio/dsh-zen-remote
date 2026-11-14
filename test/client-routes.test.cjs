/* dsh-zen-remote · client routes (src/client-routes.ts, T16)
 *
 * The sub-client backend API: the REAL createClientHandler runs over a real
 * node:http socket, in front of a mock SERVER gateway that records every
 * claim and answers the relay ping per scenario (the same seam the admin
 * route tests drive). admit is a stub — the connection service's trust
 * decision is DSH's; what this module owns is the wall order (admit → route
 * → same-origin → body), the claim forwarding and its classification, and
 * the status probe's five states. One scenario also drives the row through
 * the loader's volatile `{ get() }` wrappers to prove serverUrl/deviceToken
 * are read PER REQUEST, never snapshotted. T17-cl pins the outbound-fetch
 * header discipline: no hand-set content-length (DSH's bundled undici
 * dispatcher refuses it with UND_ERR_INVALID_ARG), nor host/connection/
 * transfer-encoding.
 */
'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { request } = require('./util.cjs')

const ROUTES_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'client-routes.js')).href
const { RelayError, relayCredentialsDigest } = require('../lib/relay-client.js')
// Loaded synchronously before test.before's import(ROUTES_URL) pulls it in as an
// ESM dependency: a later require() of a half-loaded module throws
// ERR_REQUIRE_ESM_RACE_CONDITION on Node 24.
const { toVirtual } = require('../lib/virtual-id.js')

function sendJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(bytes.length) })
  res.end(bytes)
}

/**
 * Mock server gateway: records every request. `claimReply` and `pingReply`
 * are functions (or plain values) so each scenario can stage its own answer;
 * the claim endpoint mirrors lib/lan-gate-server.cjs's /lan-gate/pair/claim-desktop.
 */
function startMockGateway() {
  const seen = []
  const state = { claimReply: () => [200, { ok: true, id: 'dev1', name: '台式机', token: 'tok-gateway' }], pingReply: () => [200, { ok: true }] }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({ method: req.method, url: String(req.url).split('?')[0], headers: req.headers, body })
      if (req.url === '/lan-gate/pair/claim-desktop') {
        const [status, payload] = state.claimReply()
        sendJson(res, status, payload)
        return
      }
      if (req.url === '/_dsh/zen-remote/relay/ping') {
        const [status, payload] = state.pingReply()
        sendJson(res, status, payload)
        return
      }
      sendJson(res, 404, { ok: false })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, state })))
}

let routes
let gateway
let gwSeen
let gwState
let gwPort
let gwUrl

/** A row the loader might have handed apply(): plain values by default, or
 * `{ get() }` wrappers whose return values the test can age. */
function makeRow(overrides = {}) {
  return {
    serverUrl: overrides.serverUrl !== undefined ? overrides.serverUrl : gwUrl,
    deviceToken: overrides.deviceToken !== undefined ? overrides.deviceToken : 'tok-row',
    role: 'client',
    // PG-2: the row layer of maxServers, for the debug report's config plate.
    ...(overrides.maxServers !== undefined ? { maxServers: overrides.maxServers } : {}),
  }
}

function startClientServer(row, overrides = {}) {
  const handler = routes.createClientHandler({
    admit: overrides.admit || (() => ({ peer: {} })),
    getRowConfig: overrides.getRowConfig || (() => row),
    ...(overrides.fetchImpl !== undefined ? { fetchImpl: overrides.fetchImpl } : {}),
    ...(overrides.getRelayClient !== undefined ? { getRelayClient: overrides.getRelayClient } : {}),
    ...(overrides.pool !== undefined ? { pool: overrides.pool } : {}),
    ...(overrides.getPluginBridgeStatusForServer !== undefined ? { getPluginBridgeStatusForServer: overrides.getPluginBridgeStatusForServer } : {}),
    ...(overrides.getIntercept !== undefined ? { getIntercept: overrides.getIntercept } : {}),
    ...(overrides.getPluginBridgeStatus !== undefined ? { getPluginBridgeStatus: overrides.getPluginBridgeStatus } : {}),
    ...(overrides.remoteStatusOnly !== undefined ? { remoteStatusOnly: overrides.remoteStatusOnly } : {}),
    ...(overrides.onCurrentSession !== undefined ? { onCurrentSession: overrides.onCurrentSession } : {}),
    // CU-3: the debug-report route's inputs.
    ...(overrides.getLogSnapshot !== undefined ? { getLogSnapshot: overrides.getLogSnapshot } : {}),
    ...(overrides.getGatewaySummary !== undefined ? { getGatewaySummary: overrides.getGatewaySummary } : {}),
    ...(overrides.getProfileName !== undefined ? { getProfileName: overrides.getProfileName } : {}),
    ...(overrides.getPluginVersion !== undefined ? { getPluginVersion: overrides.getPluginVersion } : {}),
    // PG-2: the live maxServers cap the status/claim routes read per request.
    ...(overrides.getMaxServers !== undefined ? { getMaxServers: overrides.getMaxServers } : {}),
    // PG-9: the peer engine (peer role only) and the joined network's HTTP
    // origin, both read live per request.
    ...(overrides.getPeerEngine !== undefined ? { getPeerEngine: overrides.getPeerEngine } : {}),
    ...(overrides.getPeerIdentityError !== undefined ? { getPeerIdentityError: overrides.getPeerIdentityError } : {}),
    ...(overrides.getPeerNetworkOrigin !== undefined ? { getPeerNetworkOrigin: overrides.getPeerNetworkOrigin } : {}),
  })
  const server = http.createServer((req, res) => { void handler(req, res) })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

/** The origin header a same-origin browser on this client server would send. */
function sameOrigin(port) {
  return { origin: `http://127.0.0.1:${port}` }
}

test.before(async () => {
  routes = await import(ROUTES_URL)
  ;({ server: gateway, seen: gwSeen, state: gwState } = await startMockGateway())
  gwPort = gateway.address().port
  gwUrl = `http://127.0.0.1:${gwPort}`
})

test.after(() => new Promise((resolve) => gateway.close(resolve)))

test('a successful claim forwards {code, name} and returns the token plus the normalized address', async () => {
  const row = makeRow()
  const { server, port } = await startClientServer(row)
  try {
    const before = gwSeen.length
    const res = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CLAIM_ROUTE,
      headers: sameOrigin(port),
      body: { serverUrl: `${gwUrl}/`, code: '  ab-cd 12ef ', name: '书房电脑' },
    })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.token, 'tok-gateway')
    assert.equal(body.deviceId, 'dev1')
    assert.equal(body.deviceName, '台式机')
    assert.equal(body.serverUrl, gwUrl, 'the response echoes the NORMALIZED address')
    assert.equal(gwSeen.length, before + 1)
    const forwarded = gwSeen[gwSeen.length - 1]
    assert.equal(forwarded.method, 'POST')
    assert.equal(forwarded.url, '/lan-gate/pair/claim-desktop')
    // The code is forwarded VERBATIM: normalizing is the browser's job
    // (normalizePairingCode) and the gateway strips leftovers at claim time.
    assert.deepEqual(JSON.parse(forwarded.body), { code: '  ab-cd 12ef ', name: '书房电脑' })
    assert.equal(forwarded.headers.authorization, undefined, 'the claim carries no Authorization header')
  } finally {
    await closeServer(server)
  }
})

// ---- T17-cl: no hand-set transport headers on the outbound fetches ----------

test('T17-cl: the claim fetch hands fetchImpl no content-length (nor host/connection/transfer-encoding)', async () => {
  // DSH's dsh-http-proxy replaces the global fetch dispatcher with its
  // bundled undici 8.x, which REFUSES a fetch carrying a hand-set
  // content-length (UND_ERR_INVALID_ARG → the claim always answered
  // "unreachable"). The header must not be set at all — the dispatcher
  // computes it from the body. Checked case-insensitively, and extended to
  // the other transport-owned headers the same class of dispatcher forbids.
  const inits = []
  const recordingFetch = (url, init = {}) => {
    inits.push(init)
    return fetch(url, init)
  }
  const { server, port } = await startClientServer(makeRow(), { fetchImpl: recordingFetch })
  try {
    const res = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CLAIM_ROUTE,
      headers: sameOrigin(port),
      body: { serverUrl: gwUrl, code: 'AAAAAA11', name: 'n' },
    })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).ok, true, 'the claim round-trip succeeded')
    assert.equal(inits.length, 1, 'exactly one outbound fetch (the claim forward)')
    const headers = inits[0].headers ?? {}
    const forbidden = ['content-length', 'host', 'connection', 'transfer-encoding']
    const offenders = Object.keys(headers).filter((name) => forbidden.includes(name.toLowerCase()))
    assert.deepEqual(offenders, [], `none of ${forbidden.join('/')} may be hand-set, got ${JSON.stringify(Object.keys(headers))}`)
    assert.equal(headers['content-type'], 'application/json; charset=utf-8', 'the content-type survives')
  } finally {
    await closeServer(server)
  }
})

/** The regression leg needs the undici PACKAGE (setGlobalDispatcher) to
 * mimic what DSH's dsh-http-proxy does at boot. This repo does not depend on
 * undici (Node ships one internally, unresolvable from here), so wherever
 * `require('undici')` fails — every plain checkout — the leg is skipped with
 * that note; inside an environment that has undici (e.g. against DSH's own
 * node_modules) it runs for real. */
let undici = null
try { undici = require('undici') } catch { /* left null — the leg below skips */ }

test('T17-cl: under a swapped undici global dispatcher the claim still round-trips', { skip: undici === null && 'undici is not resolvable in this environment; run where DSH-style undici is installed' }, async () => {
  const previous = undici.getGlobalDispatcher()
  // What dsh-http-proxy does at DSH boot: a fresh Agent over the global
  // fetch. Under the old hand-set content-length this fetch failed with
  // UND_ERR_INVALID_ARG and the claim answered unreachable.
  undici.setGlobalDispatcher(new undici.Agent())
  const { server, port } = await startClientServer(makeRow())
  try {
    const res = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CLAIM_ROUTE,
      headers: sameOrigin(port),
      body: { serverUrl: gwUrl, code: 'AAAAAA22', name: 'n' },
    })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true, 'the dispatcher accepted the claim fetch')
    assert.equal(body.token, 'tok-gateway', 'the pairing round-trip completed end to end')
  } finally {
    undici.setGlobalDispatcher(previous)
    await closeServer(server)
  }
})

test('claim failures classify in place: role mismatch (message kept), bad code, lockout', async () => {
  const row = makeRow()
  const { server, port } = await startClientServer(row)
  try {
    const headers = sameOrigin(port)

    gwState.claimReply = () => [403, { ok: false, reason: 'role-mismatch', expected: 'web', message: '该配对码仅适用于 Web 应用端' }]
    const mismatch = await request(port, { method: 'POST', path: routes.CLIENT_CLAIM_ROUTE, headers, body: { serverUrl: gwUrl, code: 'AAAAAAAA', name: 'n' } })
    assert.deepEqual(JSON.parse(mismatch.body), { ok: false, code: 'role-mismatch', message: '该配对码仅适用于 Web 应用端' })

    gwState.claimReply = () => [403, { ok: false, reason: 'bad-code' }]
    const badCode = await request(port, { method: 'POST', path: routes.CLIENT_CLAIM_ROUTE, headers, body: { serverUrl: gwUrl, code: 'AAAAAAAA', name: 'n' } })
    assert.deepEqual(JSON.parse(badCode.body), { ok: false, code: 'bad-code' })

    gwState.claimReply = () => [429, { ok: false, reason: 'locked', retryAfterMs: 900000 }]
    const locked = await request(port, { method: 'POST', path: routes.CLIENT_CLAIM_ROUTE, headers, body: { serverUrl: gwUrl, code: 'AAAAAAAA', name: 'n' } })
    assert.deepEqual(JSON.parse(locked.body), { ok: false, code: 'locked', retryAfterMs: 900000 })

    gwState.claimReply = () => [500, { ok: false }]
    const unexpected = await request(port, { method: 'POST', path: routes.CLIENT_CLAIM_ROUTE, headers, body: { serverUrl: gwUrl, code: 'AAAAAAAA', name: 'n' } })
    assert.deepEqual(JSON.parse(unexpected.body), { ok: false, code: 'unexpected' })

    // The browser only ever sees the classified envelope — never a raw
    // gateway body, and no token can appear in a failure.
    for (const payload of [mismatch, badCode, locked, unexpected]) {
      assert.equal(JSON.parse(payload.body).token, undefined)
    }
  } finally {
    gwState.claimReply = () => [200, { ok: true, id: 'dev1', name: '台式机', token: 'tok-gateway' }]
    await closeServer(server)
  }
})

test('a server that does not answer yields 502 unreachable', async () => {
  // A port that was listening a moment ago and is closed now: connection
  // refused, deterministically, without waiting out the 10s timeout.
  const dead = http.createServer()
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
  const deadPort = dead.address().port
  await new Promise((resolve) => dead.close(resolve))

  const { server, port } = await startClientServer(makeRow())
  try {
    const res = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CLAIM_ROUTE,
      headers: sameOrigin(port),
      body: { serverUrl: `http://127.0.0.1:${deadPort}`, code: 'AAAAAAAA', name: 'n' },
    })
    assert.equal(res.status, 502)
    assert.deepEqual(JSON.parse(res.body), { ok: false, code: 'unreachable' })
  } finally {
    await closeServer(server)
  }
})

test('an illegal address is refused locally with 400 and never forwarded', async () => {
  const { server, port } = await startClientServer(makeRow())
  try {
    const before = gwSeen.length
    const insecure = await request(port, {
      method: 'POST', path: routes.CLIENT_CLAIM_ROUTE, headers: sameOrigin(port),
      body: { serverUrl: 'http://8.8.8.8:3088', code: 'AAAAAAAA', name: 'n' },
    })
    assert.equal(insecure.status, 400)
    assert.deepEqual(JSON.parse(insecure.body), { ok: false, code: 'insecure-http' })

    const invalid = await request(port, {
      method: 'POST', path: routes.CLIENT_CLAIM_ROUTE, headers: sameOrigin(port),
      body: { serverUrl: 'not a url', code: 'AAAAAAAA', name: 'n' },
    })
    assert.equal(invalid.status, 400)
    assert.deepEqual(JSON.parse(invalid.body), { ok: false, code: 'invalid' })

    const pathy = await request(port, {
      method: 'POST', path: routes.CLIENT_CLAIM_ROUTE, headers: sameOrigin(port),
      body: { serverUrl: 'https://dsh.example.com/app', code: 'AAAAAAAA', name: 'n' },
    })
    assert.equal(pathy.status, 400)
    assert.equal(JSON.parse(pathy.body).code, 'invalid')
    assert.equal(gwSeen.length, before, 'nothing reached the gateway')
  } finally {
    await closeServer(server)
  }
})

test('admit rejections relay verbatim on both routes and never reach the gateway', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden']]) {
    const { server, port } = await startClientServer(makeRow(), { admit: () => ({ rejection: status }) })
    try {
      const before = gwSeen.length
      const claim = await request(port, { method: 'POST', path: routes.CLIENT_CLAIM_ROUTE, headers: sameOrigin(port), body: { serverUrl: gwUrl, code: 'AAAAAAAA', name: 'n' } })
      assert.equal(claim.status, status)
      assert.equal(JSON.parse(claim.body).error.code, code)
      const statusRes = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
      assert.equal(statusRes.status, status)
      assert.equal(JSON.parse(statusRes.body).error.code, code)
      assert.equal(gwSeen.length, before, 'a rejected request must not reach the gateway')
    } finally {
      await closeServer(server)
    }
  }
})

test('a cross-site claim POST is refused before any forward', async () => {
  const { server, port } = await startClientServer(makeRow())
  try {
    const before = gwSeen.length
    const res = await request(port, {
      method: 'POST', path: routes.CLIENT_CLAIM_ROUTE,
      headers: { 'sec-fetch-site': 'cross-site' },
      body: { serverUrl: gwUrl, code: 'AAAAAAAA', name: 'n' },
    })
    assert.equal(res.status, 403)
    assert.equal(JSON.parse(res.body).error.code, 'origin-rejected')
    assert.equal(gwSeen.length, before)
  } finally {
    await closeServer(server)
  }
})

test('wrong methods answer 405 with Allow', async () => {
  const { server, port } = await startClientServer(makeRow())
  try {
    const claim = await request(port, { method: 'GET', path: routes.CLIENT_CLAIM_ROUTE })
    assert.equal(claim.status, 405)
    assert.equal(claim.headers.allow, 'POST')
    const status = await request(port, { method: 'POST', path: routes.CLIENT_STATUS_ROUTE, headers: sameOrigin(port), body: {} })
    assert.equal(status.status, 405)
    assert.equal(status.headers.allow, 'GET')
  } finally {
    await closeServer(server)
  }
})

test('a bad claim body is refused locally: not JSON, not an object, oversized', async () => {
  const { server, port } = await startClientServer(makeRow())
  try {
    const headers = sameOrigin(port)
    const cases = [
      { name: 'not JSON', body: 'not json' },
      { name: 'array body', body: '[1]' },
      { name: 'oversize', body: JSON.stringify({ pad: 'x'.repeat(17 * 1024) }) },
    ]
    for (const c of cases) {
      const before = gwSeen.length
      const res = await request(port, { method: 'POST', path: routes.CLIENT_CLAIM_ROUTE, headers, body: c.body })
      assert.equal(res.status, 400, c.name)
      assert.equal(JSON.parse(res.body).error.code, 'bad-request', c.name)
      assert.equal(gwSeen.length, before, c.name)
    }
  } finally {
    await closeServer(server)
  }
})

// ---- status ------------------------------------------------------------------

test('status: no token in the row means unpaired and probes nothing', async () => {
  const { server, port } = await startClientServer(makeRow({ deviceToken: '' }))
  try {
    const before = gwSeen.length
    const res = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { state: 'unpaired', pluginBridge: [] })
    assert.equal(gwSeen.length, before, 'nothing was probed')
  } finally {
    await closeServer(server)
  }
})

test('status: the probe drives the state — connected (404), revoked (401), unexpected (relay-only), unreachable (dead)', async () => {
  const { server, port } = await startClientServer(makeRow())
  try {
    // 404 from the ping path: the gateway accepted the token, no relay route
    // behind it — still "connected".
    gwState.pingReply = () => [404, { ok: false }]
    const connected = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    assert.equal(connected.status, 200)
    const connectedBody = JSON.parse(connected.body)
    assert.deepEqual(connectedBody, { state: 'connected', serverUrl: gwUrl, pluginBridge: [] })
    // The probe presented the row's token as a Bearer header.
    const probe = gwSeen[gwSeen.length - 1]
    assert.equal(probe.url, '/_dsh/zen-remote/relay/ping')
    assert.equal(probe.headers.authorization, 'Bearer tok-row')

    gwState.pingReply = () => [401, { ok: false, reason: 'unpaired' }]
    const revoked = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.deepEqual(revoked, { state: 'revoked', serverUrl: gwUrl, pluginBridge: [] })

    gwState.pingReply = () => [403, { ok: false, reason: 'relay-only' }]
    const unexpected = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.deepEqual(unexpected, { state: 'unexpected', serverUrl: gwUrl, pluginBridge: [] })

    const dead = http.createServer()
    await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const deadPort = dead.address().port
    await new Promise((resolve) => dead.close(resolve))
    const deadRow = makeRow({ serverUrl: `http://127.0.0.1:${deadPort}` })
    const deadServer = await startClientServer(deadRow)
    try {
      const unreachable = JSON.parse((await request(deadServer.port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
      assert.deepEqual(unreachable, { state: 'unreachable', serverUrl: `http://127.0.0.1:${deadPort}`, pluginBridge: [] })
    } finally {
      await closeServer(deadServer.server)
    }
  } finally {
    gwState.pingReply = () => [200, { ok: true }]
    await closeServer(server)
  }
})

test('status: the response body never carries the token', async () => {
  const TOKEN = 'super-secret-token-value'
  const row = makeRow({ deviceToken: TOKEN })
  const { server, port } = await startClientServer(row)
  try {
    for (const reply of [
      [200, { ok: true }],
      [401, { ok: false, reason: 'unpaired' }],
      [403, { ok: false, reason: 'relay-only' }],
    ]) {
      gwState.pingReply = () => reply
      const res = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
      assert.equal(res.status, 200)
      assert.equal(res.body.includes(TOKEN), false, `the token must not appear in a ${reply[0]} status body`)
      assert.equal(JSON.parse(res.body).token, undefined)
    }
  } finally {
    gwState.pingReply = () => [200, { ok: true }]
    await closeServer(server)
  }
})

test('T16-fix: a stored plain-http PUBLIC address answers invalid-url and probes NOTHING', async () => {
  // The row is hand-editable YAML; a public http address written there must
  // never receive the pairing token in cleartext.
  const row = makeRow({ serverUrl: 'http://8.8.8.8' })
  const { server, port } = await startClientServer(row)
  try {
    const before = gwSeen.length
    const res = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { state: 'invalid-url', pluginBridge: [] })
    assert.equal(gwSeen.length, before, 'the mock gateway must not see a single request')
  } finally {
    await closeServer(server)
  }
})

test('T16-fix: a stored address with a path also fails re-validation, a trailing slash still works', async () => {
  const row = makeRow({ serverUrl: `${gwUrl}/lan-gate` })
  const a = await startClientServer(row)
  try {
    const before = gwSeen.length
    const res = await request(a.port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    assert.deepEqual(JSON.parse(res.body), { state: 'invalid-url', pluginBridge: [] })
    assert.equal(gwSeen.length, before)
  } finally {
    await closeServer(a.server)
  }

  // A stored address the normalizer ACCEPTS probes with the normalized form.
  const slashy = await startClientServer(makeRow({ serverUrl: `${gwUrl}/` }))
  try {
    const ok = JSON.parse((await request(slashy.port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(ok.state, 'connected')
    assert.equal(ok.serverUrl, gwUrl, 'the normalized address is echoed')
  } finally {
    await closeServer(slashy.server)
  }
})

test('T16-fix: a claim redirect is not followed — any 3xx classifies as unexpected', async () => {
  const followed = []
  const redirecting = http.createServer((req, res) => {
    followed.push(req.url)
    if (req.url === '/lan-gate/pair/claim-desktop') {
      res.writeHead(302, { location: '/elsewhere' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true,"token":"leaked"}')
  })
  await new Promise((resolve) => redirecting.listen(0, '127.0.0.1', resolve))
  const { server, port } = await startClientServer(makeRow())
  try {
    const res = await request(port, {
      method: 'POST', path: routes.CLIENT_CLAIM_ROUTE, headers: sameOrigin(port),
      body: { serverUrl: `http://127.0.0.1:${redirecting.address().port}`, code: 'AAAAAAAA', name: 'n' },
    })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: false, code: 'unexpected' }, 'the 302 answer is a refusal, never success')
    assert.deepEqual(followed, ['/lan-gate/pair/claim-desktop'], 'the redirect target must not be requested')
  } finally {
    await closeServer(server)
    await new Promise((resolve) => redirecting.close(resolve))
  }
})

test('T16-fix: a bug answers a bare 500 internal without echoing a message', async () => {
  const { server, port } = await startClientServer(makeRow(), {
    getRowConfig: () => { throw new Error('boom with /absolute/paths') },
  })
  try {
    const res = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    assert.equal(res.status, 500)
    const body = JSON.parse(res.body)
    assert.equal(body.error.code, 'internal')
    assert.equal(body.error.message, undefined, 'internal error text never reaches the browser')
    assert.equal(res.body.includes('boom'), false)
    // The known refusals still carry their message.
    const bad = await request(port, { method: 'POST', path: routes.CLIENT_CLAIM_ROUTE, headers: sameOrigin(port), body: 'not json' })
    assert.equal(bad.status, 400)
    assert.equal(JSON.parse(bad.body).error.code, 'bad-request')
    assert.notEqual(JSON.parse(bad.body).error.message, undefined)
  } finally {
    await closeServer(server)
  }
})

test('status reads the volatile row PER REQUEST: a re-pair without re-apply is visible immediately', async () => {
  // The loader hands apply() volatile fields as { get() } references; only
  // re-reading the SAME row object per request can see an aged value.
  let url = gwUrl
  let token = 'tok-first'
  const row = {
    serverUrl: { get: () => url },
    deviceToken: { get: () => token },
  }
  // A loopback port that was listening a moment ago and is closed now: the
  // aged row points there, deterministically refusing (and never at any real
  // network address — tests only talk to OS-assigned loopback ports).
  const dead = http.createServer()
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
  const deadPort = dead.address().port
  await new Promise((resolve) => dead.close(resolve))

  const { server, port } = await startClientServer(row)
  try {
    const first = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(first.state, 'connected')
    assert.equal(gwSeen[gwSeen.length - 1].headers.authorization, 'Bearer tok-first')

    token = 'tok-second'
    const second = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(second.state, 'connected')
    assert.equal(gwSeen[gwSeen.length - 1].headers.authorization, 'Bearer tok-second', 'the token is re-read per request')

    url = `http://127.0.0.1:${deadPort}`
    const third = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(third.serverUrl, `http://127.0.0.1:${deadPort}`, 'the fresh row value is probed, not the apply-time snapshot')
    assert.equal(third.state, 'unreachable')
  } finally {
    await closeServer(server)
  }
})

// ---- T23a-fix: the status route over a relay client ----------------------------

// T59: the handshake info may carry the device's own name (undefined from
  // an older server — the status answer degrades it to '').
  // eslint-disable-next-line no-unused-vars
const INFO = (name, deviceName) => {
  const info = { relayProtocol: 1, serverId: 'abcd1234', serverName: name, dshVersion: '2.0.0', fingerprints: {} }
  if (deviceName !== undefined) info.deviceName = deviceName
  return info
}

/** A relay-client stand-in with exactly the surface the status route reads
 * (state / handshakeInfo / lastHandshakeDigest / connect); every test wires
 * its own behavior. The default connect mirrors the REAL client's contract
 * (T23a-fix2): a call racing an unsettled attempt joins it. */
function fakeRelay(overrides = {}) {
  const relay = {
    state: 'unpaired',
    handshakeInfo: undefined,
    lastHandshakeDigest: undefined,
    // T59-fix: the status route answers an empty deviceName while a
    // locally-pushed rename is queued or in flight; tests override this.
    deviceNameSyncing: false,
    connectCount: 0,
    connectError: undefined,
    connectResult: undefined,
    connectDelay: 0,
    digest: undefined,
    inFlight: undefined,
    subscribe: () => () => {},
    invoke: async () => { throw new Error('fake relay: invoke not wired') },
    openStream: () => { throw new Error('fake relay: openStream not wired') },
    ...overrides,
  }
  relay.connect = overrides.connect ?? (() => {
    if (relay.inFlight !== undefined) return relay.inFlight
    relay.connectCount += 1
    relay.inFlight = (async () => {
      try {
        // Always a real await (even for 0): the in-flight slot must be
        // VISIBLE to concurrent callers, which a fully synchronous body
        // would race past.
        await new Promise((resolve) => setTimeout(resolve, relay.connectDelay))
        if (relay.connectError !== undefined) throw relay.connectError
        if (relay.connectResult === undefined) throw new Error('fake relay: no connect wiring')
        relay.state = 'online'
        relay.handshakeInfo = relay.connectResult
        relay.lastHandshakeDigest = relay.digest
        return relay.connectResult
      } finally {
        relay.inFlight = undefined
      }
    })()
    return relay.inFlight
  })
  return relay
}

test('T23a-fix status: an online relay over UNCHANGED credentials answers state + serverName and never probes', async () => {
  const row = makeRow()
  const relay = fakeRelay({
    state: 'online',
    handshakeInfo: INFO('书房服务器'),
    lastHandshakeDigest: relayCredentialsDigest(gwUrl, 'tok-row'),
  })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const before = gwSeen.length
    const res = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { state: 'online', serverName: '书房服务器', serverUrl: gwUrl, deviceName: '', pluginBridge: [] }, 'no deviceName on the handshake → empty, nothing to follow')
    assert.equal(gwSeen.length, before, 'the cached verdict short-circuits — nothing left the box')
    assert.equal(relay.connectCount, 0, 'no live connect either')
  } finally {
    await closeServer(server)
  }
})

test('T23a-fix status: an online relay whose credentials changed does NOT leak the cached verdict — it reconnects', async () => {
  let token = 'tok-row'
  const row = { serverUrl: { get: () => gwUrl }, deviceToken: { get: () => token } }
  const relay = fakeRelay({
    // A verdict earned under a DIFFERENT token: the digest cannot match.
    state: 'online',
    handshakeInfo: INFO('旧名字'),
    lastHandshakeDigest: 'stale-digest-from-another-life',
    digest: relayCredentialsDigest(gwUrl, 'tok-row'),
    connectResult: INFO('新名字'),
  })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const body = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(body.state, 'online')
    assert.equal(body.serverName, '新名字', 'the FRESH handshake name, never the stale cached one')
    assert.equal(relay.connectCount, 1, 'a live connect ran for the changed credentials')
    // Aging the token flips the digest again — the next answer reconnects.
    token = 'tok-fresh'
    const again = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(again.serverName, '新名字')
    assert.equal(relay.connectCount, 2)
  } finally {
    await closeServer(server)
  }
})

test('T23a-fix status: a cleared token answers unpaired and connects nothing', async () => {
  const row = makeRow({ deviceToken: '' })
  const relay = fakeRelay({
    state: 'online',
    handshakeInfo: INFO('不应被采用'),
    lastHandshakeDigest: relayCredentialsDigest(gwUrl, 'tok-row'),
  })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const before = gwSeen.length
    const res = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    assert.deepEqual(JSON.parse(res.body), { state: 'unpaired', pluginBridge: [] })
    assert.equal(gwSeen.length, before, 'nothing was probed')
    assert.equal(relay.connectCount, 0, 'nothing was connected')
  } finally {
    await closeServer(server)
  }
})

test('T23a-fix status: an invalid stored address answers invalid-url and sends nothing', async () => {
  const row = makeRow({ serverUrl: 'http://8.8.8.8' })
  const relay = fakeRelay({ state: 'online', handshakeInfo: INFO('x'), lastHandshakeDigest: 'digest' })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const res = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    assert.deepEqual(JSON.parse(res.body), { state: 'invalid-url', pluginBridge: [] })
    assert.equal(relay.connectCount, 0)
  } finally {
    await closeServer(server)
  }
})

test('T23a-fix status: a relay that never connected gets a live connect on the spot', async () => {
  const row = makeRow()
  const relay = fakeRelay({
    state: 'unpaired',
    handshakeInfo: undefined,
    lastHandshakeDigest: undefined,
    digest: relayCredentialsDigest(gwUrl, 'tok-row'),
    connectResult: INFO('现场握手'),
  })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const body = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.deepEqual(body, { state: 'online', serverName: '现场握手', serverUrl: gwUrl, deviceName: '', pluginBridge: [] })
    assert.equal(relay.connectCount, 1)
  } finally {
    await closeServer(server)
  }
})

test('T23a-fix status: live-connect failures map — relay-unauthorized is unexpected, only unpaired is revoked (T43: incompatible is its own word)', async () => {
  const row = makeRow()
  const cases = [
    [new RelayError('relay-unauthorized', 'server secret mismatch', 401), 'unexpected'],
    [new RelayError('revoked', 'unpaired wall', 401), 'revoked'],
    [new RelayError('offline', 'connection refused'), 'unreachable'],
    // T43: the protocol mismatch is rendered with its own "upgrade both
    // ends" copy, so the route answers the dedicated word now.
    [new RelayError('incompatible', 'not a 2.0.0 relay'), 'incompatible'],
  ]
  for (const [error, expected] of cases) {
    const relay = fakeRelay({
      state: 'offline',
      connectError: error,
    })
    const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
    try {
      const body = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
      assert.deepEqual(body, { state: expected, serverUrl: gwUrl, pluginBridge: [] }, error.code)
    } finally {
      await closeServer(server)
    }
  }
})

// ---- T43: the diagnostics readout + the reconnect route ----------------------

test('T43 status: a failed live connect carries nextRetryAt + lastError, never the token', async () => {
  const TOKEN = 'super-secret-token-value'
  const row = makeRow({ deviceToken: TOKEN })
  const failing = fakeRelay({
    state: 'offline',
    connectError: new RelayError('offline', 'connection refused'),
    nextRetryAt: 1234567890123,
    lastError: 'offline',
  })
  const failServer = await startClientServer(row, { getRelayClient: () => failing })
  try {
    const body = JSON.parse((await request(failServer.port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(body.state, 'unreachable')
    assert.equal(body.nextRetryAt, 1234567890123)
    assert.equal(body.lastError, 'offline')
    assert.equal(JSON.stringify(body).includes(TOKEN), false, 'the token must not appear')
  } finally {
    await closeServer(failServer.server)
  }

  // An online verdict carries neither field.
  const online = fakeRelay({
    state: 'online',
    handshakeInfo: INFO('在线'),
    lastHandshakeDigest: relayCredentialsDigest(gwUrl, TOKEN),
  })
  const okServer = await startClientServer(row, { getRelayClient: () => online })
  try {
    const body = JSON.parse((await request(okServer.port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(body.state, 'online')
    assert.equal(body.nextRetryAt, undefined)
    assert.equal(body.lastError, undefined)
    assert.equal(JSON.stringify(body).includes(TOKEN), false)
  } finally {
    await closeServer(okServer.server)
  }
})

test('T43 reconnect: wrong method 405, cross-site 403, unadmitted 401, missing relay client 503', async () => {
  const { server, port } = await startClientServer(makeRow())
  try {
    const method = await request(port, { method: 'GET', path: routes.CLIENT_RECONNECT_ROUTE })
    assert.equal(method.status, 405)
    assert.equal(method.headers.allow, 'POST')

    const cross = await request(port, { method: 'POST', path: routes.CLIENT_RECONNECT_ROUTE, headers: { 'sec-fetch-site': 'cross-site' }, body: {} })
    assert.equal(cross.status, 403)
    assert.equal(JSON.parse(cross.body).error.code, 'origin-rejected')

    const unadmitted = await startClientServer(makeRow(), { admit: () => ({ rejection: 401 }) })
    try {
      const rejected = await request(unadmitted.port, { method: 'POST', path: routes.CLIENT_RECONNECT_ROUTE, headers: sameOrigin(unadmitted.port), body: {} })
      assert.equal(rejected.status, 401)
      assert.equal(JSON.parse(rejected.body).error.code, 'unauthorized')
    } finally {
      await closeServer(unadmitted.server)
    }

    const bare = await startClientServer(makeRow(), { getRelayClient: undefined })
    try {
      const missing = await request(bare.port, { method: 'POST', path: routes.CLIENT_RECONNECT_ROUTE, headers: sameOrigin(bare.port), body: {} })
      assert.equal(missing.status, 503)
      assert.equal(JSON.parse(missing.body).error.code, 'unavailable')
    } finally {
      await closeServer(bare.server)
    }
  } finally {
    await closeServer(server)
  }
})

test('T43 reconnect: 409 while not offline, and one fired attempt while offline', async () => {
  const online = fakeRelay({ state: 'online', handshakeInfo: INFO('在线'), lastHandshakeDigest: 'd' })
  const onlineServer = await startClientServer(makeRow(), { getRelayClient: () => online })
  try {
    const conflict = await request(onlineServer.port, { method: 'POST', path: routes.CLIENT_RECONNECT_ROUTE, headers: sameOrigin(onlineServer.port), body: {} })
    assert.equal(conflict.status, 409)
    assert.equal(JSON.parse(conflict.body).error.code, 'not-offline')
  } finally {
    await closeServer(onlineServer.server)
  }

  // offline: the route fires ONE immediate attempt (never awaits it) and
  // answers ok.
  const attempts = []
  const offline = fakeRelay({
    state: 'offline',
    reconnect: () => {
      attempts.push(1)
      offline.state = 'online'
      return true
    },
  })
  const offlineServer = await startClientServer(makeRow(), { getRelayClient: () => offline })
  try {
    const fired = await request(offlineServer.port, { method: 'POST', path: routes.CLIENT_RECONNECT_ROUTE, headers: sameOrigin(offlineServer.port), body: {} })
    assert.equal(fired.status, 200)
    assert.deepEqual(JSON.parse(fired.body), { ok: true })
    assert.equal(attempts.length, 1, 'exactly one attempt was fired')
    // Now online again — a second press is a 409.
    const again = await request(offlineServer.port, { method: 'POST', path: routes.CLIENT_RECONNECT_ROUTE, headers: sameOrigin(offlineServer.port), body: {} })
    assert.equal(again.status, 409)
    assert.equal(attempts.length, 1)
  } finally {
    await closeServer(offlineServer.server)
  }
})

test('T23a-fix status: a live connect that exceeds the probe timeout answers unreachable', async () => {
  const row = makeRow()
  const relay = fakeRelay({
    state: 'offline',
    connect: () => new Promise(() => {}), // never settles
  })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const body = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.deepEqual(body, { state: 'unreachable', serverUrl: gwUrl, pluginBridge: [] })
  } finally {
    await closeServer(server)
  }
})

test('T23a-fix status: the token (and its digest) never appear in a relay answer', async () => {
  const TOKEN = 'super-secret-token-value'
  const digest = relayCredentialsDigest(gwUrl, TOKEN)
  const row = makeRow({ deviceToken: TOKEN })
  const online = fakeRelay({
    state: 'online',
    handshakeInfo: INFO('令牌测试'),
    lastHandshakeDigest: digest,
  })
  const failing = fakeRelay({ state: 'offline', connectError: new RelayError('revoked', 'wall', 401) })
  for (const [name, relay] of [['fast path', online], ['live failure', failing]]) {
    const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
    try {
      const res = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
      assert.equal(res.status, 200, name)
      assert.equal(res.body.includes(TOKEN), false, `${name}: the token must not appear`)
      assert.equal(res.body.includes(digest), false, `${name}: even the one-way digest is not echoed`)
    } finally {
      await closeServer(server)
    }
  }
})

test('T23a-fix probe: a 401 relay-unauthorized classifies as unexpected — only the unpaired wall is revoked', async () => {
  const { server, port } = await startClientServer(makeRow())
  try {
    gwState.pingReply = () => [401, { ok: false, error: { code: 'relay-unauthorized' } }]
    const unexpected = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.deepEqual(unexpected, { state: 'unexpected', serverUrl: gwUrl, pluginBridge: [] })

    gwState.pingReply = () => [401, { ok: false, reason: 'unpaired' }]
    const revoked = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.deepEqual(revoked, { state: 'revoked', serverUrl: gwUrl, pluginBridge: [] })
  } finally {
    gwState.pingReply = () => [200, { ok: true }]
    await closeServer(server)
  }
})

// ---- T23a-fix2 ----------------------------------------------------------------

test('T23a-fix2 status: a second status during an unsettled connect joins it — one connect, both answer online', async () => {
  const row = makeRow()
  const relay = fakeRelay({
    digest: relayCredentialsDigest(gwUrl, 'tok-row'),
    connectResult: INFO('并发握手'),
    connectDelay: 300,
  })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const [first, second] = await Promise.all([
      request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE }),
      request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE }),
    ])
    assert.deepEqual(JSON.parse(first.body), { state: 'online', serverName: '并发握手', serverUrl: gwUrl, deviceName: '', pluginBridge: [] })
    assert.deepEqual(JSON.parse(second.body), { state: 'online', serverName: '并发握手', serverUrl: gwUrl, deviceName: '', pluginBridge: [] })
    assert.equal(relay.connectCount, 1, 'the second status joined the in-flight connect')
  } finally {
    await closeServer(server)
  }
})

test('T23a-fix2 status: a changed ADDRESS (token unchanged) never serves the cached verdict — it reconnects', async () => {
  // A legal but already-dead local address plays the "new address": the row
  // check passes, the relay's digest (earned under the OLD address) cannot
  // match it, and the fake connect means nothing ever dials it.
  const dead = http.createServer()
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
  const newPort = dead.address().port
  await new Promise((resolve) => dead.close(resolve))
  const newUrl = `http://127.0.0.1:${newPort}`

  const row = makeRow({ serverUrl: newUrl })
  const relay = fakeRelay({
    state: 'online',
    handshakeInfo: INFO('旧地址的名字'),
    lastHandshakeDigest: relayCredentialsDigest(gwUrl, 'tok-row'),
    digest: relayCredentialsDigest(newUrl, 'tok-row'),
    connectResult: INFO('新地址的名字'),
  })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const body = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.deepEqual(body, { state: 'online', serverName: '新地址的名字', serverUrl: newUrl, deviceName: '', pluginBridge: [] }, 'the fresh connect answers, never the stale cache')
    assert.equal(relay.connectCount, 1, 'the digest mismatch forced a live connect')
  } finally {
    await closeServer(server)
  }
})

test('an unknown route under the prefix answers 404', async () => {
  const { server, port } = await startClientServer(makeRow())
  try {
    const res = await request(port, { method: 'GET', path: '/_dsh/zen-remote/client/nothing' })
    assert.equal(res.status, 404)
    assert.equal(JSON.parse(res.body).error.code, 'not-found')
  } finally {
    await closeServer(server)
  }
})

test('an injected fetch sees the exact probe request: bearer header, ping path, no redirects followed', async () => {
  const { server, port } = await startClientServer(makeRow(), {
    fetchImpl: async (url, init) => {
      assert.equal(String(url), `${gwUrl}/_dsh/zen-remote/relay/ping`)
      assert.equal(init.method, 'GET')
      assert.deepEqual(init.headers, { authorization: 'Bearer tok-row' })
      assert.equal(init.redirect, 'manual')
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  try {
    const body = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(body.state, 'connected')
  } finally {
    await closeServer(server)
  }
})

// ---- T42: the compat diagnostics ----------------------------------------------

const { createRelayClient } = require('../lib/relay-client.js')

/**
 * A dedicated relay-handshake server answering ONLY the handshake route with
 * the injected fingerprints — the "server side" of the injected-fingerprint
 * e2e below, with no other machinery in the way.
 */
async function startHandshakeServer(fingerprints) {
  const seen = []
  const state = { fingerprints }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ url: String(req.url).split('?')[0] })
      if (String(req.url).split('?')[0] === '/_dsh/zen-remote/relay/v1/handshake') {
        sendJson(res, 200, { ok: true, relayProtocol: 1, serverId: 'abcd1234', serverName: '指纹服务器', dshVersion: '0.0.0-t42', fingerprints: state.fingerprints })
        return
      }
      sendJson(res, 404, { ok: false, error: { code: 'not-found' } })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, seen, state, stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}

test('T42 e2e: server and client with DIFFERENT fingerprints — status lists the groups', async () => {
  const relayServer = await startHandshakeServer({ session: 'aaa111', workspace: 'bbb222', events: 'ccc333' })
  const client = createRelayClient({
    getServerUrl: () => `http://127.0.0.1:${relayServer.port}`,
    getToken: () => 'tok-t42',
    computeOwnFingerprints: () => ({ session: 'aaa111', workspace: 'zzz999', events: 'ccc333' }),
  })
  try {
    await client.connect()
    const row = makeRow({ serverUrl: `http://127.0.0.1:${relayServer.port}`, deviceToken: 'tok-t42' })
    const { server, port } = await startClientServer(row, { getRelayClient: () => client })
    const body = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(body.state, 'online')
    assert.deepEqual(body.compat, {
      identical: ['events', 'session'],
      different: ['workspace'],
      unavailable: [],
      incompatibleCalls: [],
    })
    await closeServer(server)
  } finally { await client.stop(); await relayServer.stop() }
})

test('T42 e2e: identical fingerprints — status compat.different is empty', async () => {
  const same = { session: 'aaa111', workspace: 'bbb222', events: 'ccc333' }
  const relayServer = await startHandshakeServer(same)
  const client = createRelayClient({
    getServerUrl: () => `http://127.0.0.1:${relayServer.port}`,
    getToken: () => 'tok-t42',
    computeOwnFingerprints: () => ({ ...same }),
  })
  try {
    await client.connect()
    const row = makeRow({ serverUrl: `http://127.0.0.1:${relayServer.port}`, deviceToken: 'tok-t42' })
    const { server, port } = await startClientServer(row, { getRelayClient: () => client })
    const body = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(body.state, 'online')
    assert.deepEqual(body.compat.different, [], 'nothing differs — no yellow hint material')
    assert.deepEqual(body.compat.identical, ['events', 'session', 'workspace'])
    await closeServer(server)
  } finally { await client.stop(); await relayServer.stop() }
})

test('T42 status: nothing to report — the compat field stays absent', async () => {
  const client = createRelayClient({ getServerUrl: () => undefined, getToken: () => undefined })
  const row = makeRow({ serverUrl: '', deviceToken: '' })
  const { server, port } = await startClientServer(row, { getRelayClient: () => client })
  try {
    const body = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(body.state, 'unpaired')
    assert.equal(body.compat, undefined, 'no verdict and no incompatible calls — no compat field')
  } finally { await client.stop(); await closeServer(server) }
})

test('T42 status: the interceptor\u2019s incompatible calls flow into compat', async () => {
  const row = makeRow({ serverUrl: '', deviceToken: '' })
  const { server, port } = await startClientServer(row, {
    getIntercept: () => ({
      installed: true,
      shape: { ok: true, notes: [] },
      recentFailures: [{ time: '2026-09-29T00:00:00.000Z', endpoint: 'session/page', code: 'remote-offline' }],
      incompatibleCalls: [{ time: 1_700_000_000_000, endpoint: 'session/follow', code: 'gateway/arguments-invalid' }],
    }),
  })
  try {
    const body = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.deepEqual(body.compat.incompatibleCalls, [
      { time: 1_700_000_000_000, endpoint: 'session/follow', code: 'gateway/arguments-invalid' },
    ])
    assert.deepEqual(body.compat.different, [], 'no relay client verdict — no differences claimed')
  } finally { await closeServer(server) }
})

// ---- T34: remote-status + client/unshare -----------------------------------------

const T34_SERVER_ID = 'abcd1234'
const T34_VIRTUAL = toVirtual(T34_SERVER_ID, 'session-a')

test('T34 remote-status: unadmitted is 401, wrong method is 405', async () => {
  const row = makeRow()
  const unadmitted = await startClientServer(row, {
    admit: () => ({ rejection: 401 }),
    getRelayClient: () => fakeRelay({ state: 'online', handshakeInfo: INFO('x'), lastHandshakeDigest: 'd' }),
  })
  try {
    const res = await request(unadmitted.port, { method: 'GET', path: routes.CLIENT_REMOTE_STATUS_ROUTE })
    assert.equal(res.status, 401)
  } finally { await closeServer(unadmitted.server) }

  const { server, port } = await startClientServer(row, {
    getRelayClient: () => fakeRelay({ state: 'online', handshakeInfo: INFO('x'), lastHandshakeDigest: 'd' }),
  })
  try {
    const methods = await request(port, { method: 'POST', path: routes.CLIENT_REMOTE_STATUS_ROUTE, headers: sameOrigin(port) })
    assert.equal(methods.status, 405)
    assert.equal(methods.headers.allow, 'GET')
  } finally { await closeServer(server) }
})

test('T34 remote-status: the body carries state/compat/name/closed — and never a token or a server address', async () => {
  const row = makeRow()
  const relay = fakeRelay({
    state: 'online',
    handshakeInfo: INFO('书房服务器'),
    lastHandshakeDigest: relayCredentialsDigest(gwUrl, 'tok-row'),
    compat: { identical: ['session'], different: ['workspace'], unavailable: [] },
  })
  const intercept = {
    installed: true,
    shape: { ok: true, notes: [] },
    recentFailures: [],
    incompatibleCalls: [],
    closedSessions: [{ sessionId: T34_VIRTUAL, reason: 'idle' }, { sessionId: toVirtual(T34_SERVER_ID, 'b'), reason: 'client' }],
  }
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay, getIntercept: () => intercept })
  try {
    const res = await request(port, { method: 'GET', path: routes.CLIENT_REMOTE_STATUS_ROUTE })
    const body = JSON.parse(res.body)
    assert.deepEqual(body, {
      state: 'online',
      versionMismatch: true,
      serverName: '书房服务器',
      closed: { [T34_VIRTUAL]: 'idle', [toVirtual(T34_SERVER_ID, 'b')]: 'client' },
      // PB-2: no verdict source wired on this mount → the empty bridge list.
      bridgedPlugins: [],
    })
    assert.ok(!res.body.includes('tok-row'), 'no token anywhere in the body')
    assert.ok(!res.body.includes(gwUrl), 'no server address in the body')
  } finally { await closeServer(server) }
})

test('T34 remote-status: no relay client reads unpaired; an offline relay reads offline', async () => {
  const row = makeRow()
  const { server, port } = await startClientServer(row)
  try {
    const body = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_REMOTE_STATUS_ROUTE })).body)
    assert.deepEqual(body, { state: 'unpaired', versionMismatch: false, serverName: '', closed: {}, bridgedPlugins: [] })
  } finally { await closeServer(server) }

  const relay = fakeRelay({ state: 'offline', handshakeInfo: INFO('断线服务器'), lastHandshakeDigest: 'd' })
  const second = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const body = JSON.parse((await request(second.port, { method: 'GET', path: routes.CLIENT_REMOTE_STATUS_ROUTE })).body)
    assert.equal(body.state, 'offline')
    assert.equal(body.versionMismatch, false, 'no compat verdict — no mismatch claim')
  } finally { await closeServer(second.server) }
})

// ---- PB-2: the plugin bridge fields on the two status routes ------------------

test('PB-2 status: pluginBridge rides EVERY answer and is computed live per request', async () => {
  const row = makeRow()
  // A verdict source that ages between two reads — the route must re-ask it
  // per request, never cache the first answer.
  let verdicts = [{ plugin: 'stale-one', bridged: false, reason: 'offline', localVersion: '1.0.0' }]
  const { server, port } = await startClientServer(row, { getPluginBridgeStatus: () => verdicts })
  try {
    const first = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(first.state, 'connected')
    assert.deepEqual(first.pluginBridge, [{ plugin: 'stale-one', bridged: false, reason: 'offline', localVersion: '1.0.0' }])

    verdicts = [
      { plugin: 'a-bridged', bridged: true, localVersion: '2.0.0', serverVersion: '2.0.0' },
      { plugin: 'b-consent', bridged: false, reason: 'consent-off', localVersion: '1.0.0', serverVersion: '1.0.0' },
    ]
    const second = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.deepEqual(second.pluginBridge, verdicts, 'the next request reads the fresh verdict, verbatim')
  } finally { await closeServer(server) }

  // No verdict source wired (old mounts, tests): the empty array, not a
  // missing field — every status answer carries the field.
  const bare = await startClientServer(row)
  try {
    const body = JSON.parse((await request(bare.port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.deepEqual(body.pluginBridge, [])
  } finally { await closeServer(bare.server) }
})

test('PB-2 remote-status: bridgedPlugins lists ONLY the bridged names, sorted; the host mount reads []', async () => {
  const row = makeRow()
  const verdicts = [
    { plugin: 'zeta-panel', bridged: false, reason: 'version-mismatch', localVersion: '1', serverVersion: '2' },
    // The two BRIDGED names sit in reverse order on purpose: the field's
    // sorted shape is pinned — dropping the implementation's .sort() fails
    // this assertion with ['beta-notes', 'alpha-tasks'].
    { plugin: 'beta-notes', bridged: true, localVersion: '1', serverVersion: '1' },
    { plugin: 'mid-consent', bridged: false, reason: 'consent-off', localVersion: '1', serverVersion: '1' },
    { plugin: 'alpha-tasks', bridged: true, localVersion: '1', serverVersion: '1' },
  ]
  const { server, port } = await startClientServer(row, {
    getRelayClient: () => fakeRelay({ state: 'online', handshakeInfo: INFO('书房服务器'), lastHandshakeDigest: relayCredentialsDigest(gwUrl, 'tok-row') }),
    getPluginBridgeStatus: () => verdicts,
  })
  try {
    const body = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_REMOTE_STATUS_ROUTE })).body)
    assert.deepEqual(body.bridgedPlugins, ['alpha-tasks', 'beta-notes'], 'only bridged plugins, name-sorted')
  } finally { await closeServer(server) }

  // The host mount (remoteStatusOnly): no verdict source is ever wired there,
  // and the field still answers — the empty list.
  const host = await startClientServer(row, { remoteStatusOnly: true })
  try {
    const body = JSON.parse((await request(host.port, { method: 'GET', path: routes.CLIENT_REMOTE_STATUS_ROUTE })).body)
    assert.deepEqual(body.bridgedPlugins, [], 'the host mount answers the empty bridge list')
  } finally { await closeServer(host.server) }
})

test('T34 client/unshare: the wall order holds (401 unadmitted, 405 wrong method, 403 cross-site)', async () => {
  const row = makeRow()
  const unadmitted = await startClientServer(row, { admit: () => ({ rejection: 401 }) })
  try {
    const res = await request(unadmitted.port, { method: 'POST', path: routes.CLIENT_UNSHARE_ROUTE, headers: sameOrigin(unadmitted.port), body: { sessionId: T34_VIRTUAL } })
    assert.equal(res.status, 401)
  } finally { await closeServer(unadmitted.server) }

  const { server, port } = await startClientServer(row)
  try {
    const methods = await request(port, { method: 'GET', path: routes.CLIENT_UNSHARE_ROUTE })
    assert.equal(methods.status, 405)
    assert.equal(methods.headers.allow, 'POST')
    const cross = await request(port, { method: 'POST', path: routes.CLIENT_UNSHARE_ROUTE, headers: { origin: 'http://evil.example' }, body: { sessionId: T34_VIRTUAL } })
    assert.equal(cross.status, 403)
  } finally { await closeServer(server) }
})

test('T34 client/unshare: a non-virtual id is 400 and nothing is forwarded', async () => {
  const row = makeRow()
  const relay = fakeRelay({ state: 'online', handshakeInfo: INFO('x'), lastHandshakeDigest: 'd' })
  const unshared = []
  relay.unshare = async (id) => { unshared.push(id) }
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    for (const bad of ['session-712828e2', 'zr~short', 'zr~zzzzzzzz~not-hex-server', '']) {
      const res = await request(port, { method: 'POST', path: routes.CLIENT_UNSHARE_ROUTE, headers: sameOrigin(port), body: { sessionId: bad } })
      assert.equal(res.status, 400, bad)
      assert.equal(JSON.parse(res.body).error.code, 'not-virtual')
    }
    assert.deepEqual(unshared, [])
  } finally { await closeServer(server) }
})

test('T34 client/unshare: the ORIGINAL id rides to relay.unshare; a foreign server answers remote-mismatch without forwarding', async () => {
  const row = makeRow()
  const relay = fakeRelay({ state: 'online', handshakeInfo: INFO('x'), lastHandshakeDigest: 'd' })
  const unshared = []
  relay.unshare = async (id) => { unshared.push(id) }
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const ok = await request(port, { method: 'POST', path: routes.CLIENT_UNSHARE_ROUTE, headers: sameOrigin(port), body: { sessionId: T34_VIRTUAL } })
    assert.equal(ok.status, 200)
    assert.deepEqual(JSON.parse(ok.body), { ok: true })
    assert.deepEqual(unshared, ['session-a'], 'the virtual prefix was stripped before the relay call')
  } finally { await closeServer(server) }

  const foreign = toVirtual('ffffffff', 'session-elsewhere')
  relay.unshare = async () => { throw new Error('must not be reached') }
  const second = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const res = await request(second.port, { method: 'POST', path: routes.CLIENT_UNSHARE_ROUTE, headers: sameOrigin(second.port), body: { sessionId: foreign } })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).error.code, 'remote-mismatch')
  } finally { await closeServer(second.server) }
})

test('T34 client/unshare: a relay failure travels with its code', async () => {
  const row = makeRow()
  const relay = fakeRelay({ state: 'online', handshakeInfo: INFO('x'), lastHandshakeDigest: 'd' })
  relay.unshare = async () => { throw new RelayError('not-shared', 'the session is not shared', 403) }
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const res = await request(port, { method: 'POST', path: routes.CLIENT_UNSHARE_ROUTE, headers: sameOrigin(port), body: { sessionId: T34_VIRTUAL } })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'not-shared')
  } finally { await closeServer(server) }
})

test('T41a-fix2 remoteStatusOnly: the host mount serves remote-status alone — the pairing routes answer 404', async () => {
  const row = makeRow()
  // The remote-status route stays (the T34 parts poll it on either role),
  // admission still runs first, and its empty no-relay conclusion is intact.
  const { server, port } = await startClientServer(row, { remoteStatusOnly: true })
  try {
    const status = await request(port, { method: 'GET', path: routes.CLIENT_REMOTE_STATUS_ROUTE })
    assert.equal(status.status, 200)
    assert.deepEqual(JSON.parse(status.body), { state: 'unpaired', versionMismatch: false, serverName: '', closed: {}, bridgedPlugins: [] })
  } finally { await closeServer(server) }

  const unadmitted = await startClientServer(row, { remoteStatusOnly: true, admit: () => ({ rejection: 401 }) })
  try {
    const refused = await request(unadmitted.port, { method: 'GET', path: routes.CLIENT_REMOTE_STATUS_ROUTE })
    assert.equal(refused.status, 401, 'admit still runs before the route gate')
  } finally { await closeServer(unadmitted.server) }

  // Every other route under the prefix answers the unknown-path 404 — the
  // claim surface in particular must not exist on a host.
  const second = await startClientServer(row, { remoteStatusOnly: true })
  try {
    for (const [method, route, body] of [
      ['POST', routes.CLIENT_CLAIM_ROUTE, { serverUrl: gwUrl, code: '123456', name: 'x' }],
      ['GET', routes.CLIENT_STATUS_ROUTE],
      ['POST', routes.CLIENT_RECONNECT_ROUTE, {}],
      ['POST', routes.CLIENT_UNSHARE_ROUTE, { sessionId: T34_VIRTUAL }],
    ]) {
      const res = await request(second.port, { method, path: route, headers: sameOrigin(second.port), ...(body !== undefined ? { body } : {}) })
      assert.equal(res.status, 404, `${method} ${route}`)
      assert.equal(JSON.parse(res.body).error.code, 'not-found')
    }
  } finally { await closeServer(second.server) }
})

// ---- T41b: the plain-HTTP relay route (client/http/<route>) --------------------

/** A virtual id shaped for the fake relay's server id (INFO's abcd1234). */
const VIRTUAL = 'zr~abcd1234~session-1'

test('T41b http: an unadmitted request is refused before anything else', async () => {
  const relay = fakeRelay({ state: 'online', handshakeInfo: INFO('书房'), http: async () => ({ status: 200, contentType: 'application/json', body: '{}' }) })
  const { server, port } = await startClientServer(makeRow(), {
    admit: () => ({ rejection: 401 }),
    getRelayClient: () => relay,
  })
  try {
    const res = await request(port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}changes.diff?sessionId=${VIRTUAL}&seq=1&index=0` })
    assert.equal(res.status, 401)
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: 'unauthorized' } })
  } finally {
    await closeServer(server)
  }
})

test('T41b http: an unregistered route is 404, a non-virtual or missing sessionId is 400', async () => {
  const relay = fakeRelay({ state: 'online', handshakeInfo: INFO('书房'), http: async () => ({ status: 200, contentType: 'application/json', body: '{}' }) })
  const { server, port } = await startClientServer(makeRow(), { getRelayClient: () => relay })
  try {
    const unknown = await request(port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}session.export?sessionId=${VIRTUAL}&v=1` })
    assert.equal(unknown.status, 404)
    assert.deepEqual(JSON.parse(unknown.body), { ok: false, error: { code: 'unknown-route' } })
    const proto = await request(port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}constructor?sessionId=${VIRTUAL}` })
    assert.equal(proto.status, 404, 'a prototype key name is not a route')
    const local = await request(port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=session-local&seq=1` })
    assert.equal(local.status, 400)
    assert.deepEqual(JSON.parse(local.body), { ok: false, error: { code: 'not-virtual', message: 'sessionId is not a remote session id' } })
    const missing = await request(port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}changes.summary?seq=1` })
    assert.equal(missing.status, 400)
    assert.deepEqual(JSON.parse(missing.body), { ok: false, error: { code: 'bad-request', message: 'sessionId is required exactly once' } })
  } finally {
    await closeServer(server)
  }
})

test('T41b http: a relay that is not online answers 503 remote-offline, a foreign server id 400', async () => {
  const offline = fakeRelay({ state: 'offline', handshakeInfo: INFO('书房') })
  const { server, port } = await startClientServer(makeRow(), { getRelayClient: () => offline })
  try {
    const res = await request(port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=${VIRTUAL}&seq=1` })
    assert.equal(res.status, 503)
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: 'remote-offline' } })
  } finally {
    await closeServer(server)
  }
  const other = fakeRelay({ state: 'online', handshakeInfo: { relayProtocol: 1, serverId: 'ffffffff', serverName: '别台', dshVersion: '2.0.0', fingerprints: {} } })
  const second = await startClientServer(makeRow(), { getRelayClient: () => other })
  try {
    const res = await request(second.port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=${VIRTUAL}&seq=1` })
    assert.equal(res.status, 400)
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: 'remote-mismatch', message: '此远程会话属于其他主服务端' } })
  } finally {
    await closeServer(second.server)
  }
})

test('T41b http: success relays with the ORIGINAL id restored and passes status/content-type/body through', async () => {
  const calls = []
  const relay = fakeRelay({
    state: 'online',
    handshakeInfo: INFO('书房'),
    http: async (route, query, signal) => {
      calls.push({ route, query, signal })
      return { status: 200, contentType: 'application/json; charset=utf-8', body: '{"turn":3,"files":[],"total":0,"added":0,"deleted":0}' }
    },
  })
  const { server, port } = await startClientServer(makeRow(), { getRelayClient: () => relay })
  try {
    const res = await request(port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=${encodeURIComponent(VIRTUAL)}&seq=3` })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
    assert.deepEqual(JSON.parse(res.body), { turn: 3, files: [], total: 0, added: 0, deleted: 0 })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].route, 'changes.summary')
    assert.equal(calls[0].query, 'sessionId=session-1&seq=3', 'the virtual id was swapped back, the rest verbatim')
    assert.ok(calls[0].signal instanceof AbortSignal || calls[0].signal === undefined, 'the abort signal rides along')
  } finally {
    await closeServer(server)
  }
})

test('T41b http: relay refusals keep their status (an unshared session is the relay 403), a link failure is 503', async () => {
  const refused = new RelayError('not-shared', undefined, 403)
  const relay = fakeRelay({ state: 'online', handshakeInfo: INFO('书房'), http: async () => { throw refused } })
  const { server, port } = await startClientServer(makeRow(), { getRelayClient: () => relay })
  try {
    const res = await request(port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}changes.diff?sessionId=${VIRTUAL}&seq=1&index=0` })
    assert.equal(res.status, 403)
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: 'not-shared' } })
  } finally {
    await closeServer(server)
  }
  const dead = fakeRelay({ state: 'online', handshakeInfo: INFO('书房'), http: async () => { throw new RelayError('offline', 'chain down') } })
  const second = await startClientServer(makeRow(), { getRelayClient: () => dead })
  try {
    const res = await request(second.port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}changes.diff?sessionId=${VIRTUAL}&seq=1&index=0` })
    assert.equal(res.status, 503)
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: 'remote-offline' } })
  } finally {
    await closeServer(second.server)
  }
})

test('T41b-fix http: only application/json keeps its content type; anything else downgrades to inert text/plain', async () => {
  const relay = fakeRelay({
    state: 'online',
    handshakeInfo: INFO('书房'),
    http: async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body: '<script>alert(1)</script>' }),
  })
  const { server, port } = await startClientServer(makeRow(), { getRelayClient: () => relay })
  try {
    const res = await request(port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=${VIRTUAL}&seq=1` })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8', 'a scriptable type never lands on this same-origin path')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
  } finally {
    await closeServer(server)
  }
  // JSON keeps its own type, whatever the parameter spelling or case.
  for (const contentType of ['application/json', 'APPLICATION/JSON', 'application/json;charset=utf-8', 'application/json; charset=UTF-8']) {
    const jsonRelay = fakeRelay({ state: 'online', handshakeInfo: INFO('书房'), http: async () => ({ status: 200, contentType, body: '{}' }) })
    const second = await startClientServer(makeRow(), { getRelayClient: () => jsonRelay })
    try {
      const res = await request(second.port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=${VIRTUAL}&seq=1` })
      assert.equal(res.headers['content-type'], contentType, contentType)
    } finally {
      await closeServer(second.server)
    }
  }
  // A missing content type downgrades too.
  const bare = fakeRelay({ state: 'online', handshakeInfo: INFO('书房'), http: async () => ({ status: 200, contentType: undefined, body: '{}' }) })
  const third = await startClientServer(makeRow(), { getRelayClient: () => bare })
  try {
    const res = await request(third.port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=${VIRTUAL}&seq=1` })
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8')
  } finally {
    await closeServer(third.server)
  }
})

test('T59 status: the device\'s own name rides the online answer from the handshake record', async () => {
  const row = makeRow()
  const relay = fakeRelay({
    state: 'online',
    handshakeInfo: INFO('书房服务器', '书房的台式机'),
    lastHandshakeDigest: relayCredentialsDigest(gwUrl, 'tok-row'),
  })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const body = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(body.state, 'online')
    assert.equal(body.deviceName, '书房的台式机', 'the SERVER\'s record of this device — what the settings page follows')

    // The fresh-connect path answers it too.
    const relay2 = fakeRelay({
      state: 'offline',
      lastHandshakeDigest: 'stale',
      digest: relayCredentialsDigest(gwUrl, 'tok-row'),
      connectResult: INFO('书房服务器', '重连后的名字'),
    })
    const { server: server2, port: port2 } = await startClientServer(row, { getRelayClient: () => relay2 })
    try {
      const again = JSON.parse((await request(port2, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
      assert.equal(again.state, 'online')
      assert.equal(again.deviceName, '重连后的名字')
    } finally {
      await closeServer(server2)
    }
  } finally {
    await closeServer(server)
  }
})

test('T59-fix status: an in-flight or queued rename answers an EMPTY deviceName — the page must not follow', async () => {
  const row = makeRow()
  const relay = fakeRelay({
    state: 'online',
    handshakeInfo: INFO('书房服务器', '书房的台式机'),
    lastHandshakeDigest: relayCredentialsDigest(gwUrl, 'tok-row'),
  })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    // While the push is queued or in flight, the answer could predate it —
    // the name is forced empty so the page has nothing to follow.
    relay.deviceNameSyncing = true
    const during = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(during.deviceName, '', 'syncing forces the follow field empty')

    // Once the push settles (and the handshake record carries the pushed
    // name), the answer carries it and the page follows THAT.
    relay.deviceNameSyncing = false
    relay.handshakeInfo = INFO('书房服务器', 'B')
    const after = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(after.deviceName, 'B', 'after the push the fresh record travels')
  } finally {
    await closeServer(server)
  }
})

// -- T62: the current-session report route ------------------------------------------

test('T62 current-session: a same-origin POST stores the report — an id opens, null clears', async () => {
  const row = makeRow()
  const seen = []
  const { server, port } = await startClientServer(row, { onCurrentSession: (read) => seen.push(read) })
  try {
    const open = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CURRENT_SESSION_ROUTE,
      headers: sameOrigin(port),
      body: { sessionId: 'zr~721b94fb~session-a' },
    })
    assert.equal(open.status, 200)
    assert.deepEqual(JSON.parse(open.body), { ok: true })
    const none = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CURRENT_SESSION_ROUTE,
      headers: sameOrigin(port),
      body: { sessionId: null },
    })
    assert.equal(none.status, 200)
    assert.deepEqual(seen, [
      { kind: 'open', sessionId: 'zr~721b94fb~session-a' },
      { kind: 'none' },
    ])
  } finally {
    await closeServer(server)
  }
})

test('T62 current-session: GET, cross-origin, missing, wrong-type, blank and over-long reports are refused', async () => {
  const row = makeRow()
  const seen = []
  const { server, port } = await startClientServer(row, { onCurrentSession: (read) => seen.push(read) })
  try {
    const get = await request(port, { method: 'GET', path: routes.CLIENT_CURRENT_SESSION_ROUTE })
    assert.equal(get.status, 405)

    const cross = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CURRENT_SESSION_ROUTE,
      headers: { origin: 'http://evil.example' },
      body: { sessionId: 'zr~721b94fb~session-a' },
    })
    assert.equal(cross.status, 403)
    assert.equal(JSON.parse(cross.body).error.code, 'origin-rejected')

    for (const body of [{}, { sessionId: 42 }, { sessionId: '' }, { sessionId: 'x'.repeat(513) }]) {
      const bad = await request(port, {
        method: 'POST',
        path: routes.CLIENT_CURRENT_SESSION_ROUTE,
        headers: sameOrigin(port),
        body,
      })
      assert.equal(bad.status, 400, `sessionId ${JSON.stringify(body.sessionId)} must be refused`)
      assert.equal(JSON.parse(bad.body).error.code, 'bad-request')
    }
    assert.deepEqual(seen, [], 'nothing reached the sink')
    // The 512-char cap is a bound, not a squeeze: a 512-char id passes.
    const edge = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CURRENT_SESSION_ROUTE,
      headers: sameOrigin(port),
      body: { sessionId: 's'.repeat(512) },
    })
    assert.equal(edge.status, 200)
    assert.deepEqual(seen, [{ kind: 'open', sessionId: 's'.repeat(512) }])
  } finally {
    await closeServer(server)
  }
})

test('T62 current-session: no sink (host role / remoteStatusOnly, or a sinkless client mount) answers 404', async () => {
  const row = makeRow()
  // Host mount: the remoteStatusOnly wall 404s the route before anything else.
  const host = await startClientServer(row, { remoteStatusOnly: true, onCurrentSession: () => {} })
  try {
    const hostRes = await request(host.port, {
      method: 'POST',
      path: routes.CLIENT_CURRENT_SESSION_ROUTE,
      headers: sameOrigin(host.port),
      body: { sessionId: 'x' },
    })
    assert.equal(hostRes.status, 404)
  } finally {
    await closeServer(host.server)
  }
  // A client mount without the sink answers the unknown-path 404 too.
  const sinkless = await startClientServer(row)
  try {
    const res = await request(sinkless.port, {
      method: 'POST',
      path: routes.CLIENT_CURRENT_SESSION_ROUTE,
      headers: sameOrigin(sinkless.port),
      body: { sessionId: 'x' },
    })
    assert.equal(res.status, 404)
    assert.equal(JSON.parse(res.body).error.code, 'not-found')
  } finally {
    await closeServer(sinkless.server)
  }
})

// ---- PR29: client/network-hint ---------------------------------------------------
//
// The network-restored fast path's glue: the browser POSTs a hint, the route
// asks the relay client's probeHealth() (one authenticated GET /ping) and
// only a reachable host earns networkRestored(). The fakes below give the
// handler exactly that surface — the same wiring the T34 remote-status tests
// use.

test('PR29 network-hint: the wall order holds — GET is 405 + Allow: POST, a cross-site POST is 403', async () => {
  const row = makeRow()
  let probes = 0
  const relay = fakeRelay({
    state: 'offline',
    probeHealth: async () => { probes += 1; return true },
    networkRestored: () => true,
  })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const get = await request(port, { method: 'GET', path: routes.CLIENT_NETWORK_HINT_ROUTE })
    assert.equal(get.status, 405)
    assert.equal(get.headers.allow, 'POST')

    const cross = await request(port, {
      method: 'POST',
      path: routes.CLIENT_NETWORK_HINT_ROUTE,
      headers: { origin: 'http://evil.example' },
      body: {},
    })
    assert.equal(cross.status, 403)
    assert.equal(JSON.parse(cross.body).error.code, 'origin-rejected')
    assert.equal(probes, 0, 'nothing got past the walls — the relay was never asked')
  } finally { await closeServer(server) }
})

test('PR29 network-hint: no relay client reads 503 unavailable', async () => {
  const row = makeRow()
  const { server, port } = await startClientServer(row)
  try {
    const res = await request(port, { method: 'POST', path: routes.CLIENT_NETWORK_HINT_ROUTE, headers: sameOrigin(port), body: {} })
    assert.equal(res.status, 503)
    assert.equal(JSON.parse(res.body).error.code, 'unavailable')
  } finally { await closeServer(server) }
})

test('PR29 network-hint: a failed probe answers reachable:false and NEVER reconnects', async () => {
  const row = makeRow()
  let restoredCalls = 0
  const relay = fakeRelay({
    state: 'offline',
    probeHealth: async () => false,
    networkRestored: () => { restoredCalls += 1; return true },
  })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const res = await request(port, { method: 'POST', path: routes.CLIENT_NETWORK_HINT_ROUTE, headers: sameOrigin(port), body: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true, reachable: false, reconnected: false })
    assert.equal(restoredCalls, 0, 'an unreachable host earns NO reconnect — the sentinel branch')
  } finally { await closeServer(server) }
})

test('PR29 network-hint: a reachable host plus an accepted hint answers reconnected:true', async () => {
  const row = makeRow()
  let restoredCalls = 0
  const relay = fakeRelay({
    state: 'offline',
    probeHealth: async () => true,
    networkRestored: () => { restoredCalls += 1; return true },
  })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const res = await request(port, { method: 'POST', path: routes.CLIENT_NETWORK_HINT_ROUTE, headers: sameOrigin(port), body: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true, reachable: true, reconnected: true })
    assert.equal(restoredCalls, 1, 'exactly one networkRestored round')
  } finally { await closeServer(server) }
})

test('PR29 network-hint: a reachable host but a refused hint (the 3s gap) answers reconnected:false', async () => {
  const row = makeRow()
  const relay = fakeRelay({
    state: 'offline',
    probeHealth: async () => true,
    networkRestored: () => false,
  })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const res = await request(port, { method: 'POST', path: routes.CLIENT_NETWORK_HINT_ROUTE, headers: sameOrigin(port), body: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true, reachable: true, reconnected: false }, 'the refusal is honest — reachable, just gapped')
  } finally { await closeServer(server) }
})

test('PR29 network-hint: the route reads the relay client LIVE — the getter is asked per request', async () => {
  const row = makeRow()
  let relay
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay })
  try {
    // Undefined now: the same mount answers 503...
    const missing = await request(port, { method: 'POST', path: routes.CLIENT_NETWORK_HINT_ROUTE, headers: sameOrigin(port), body: {} })
    assert.equal(missing.status, 503)
    // ...and the NEXT request sees the client that appeared in between.
    relay = { probeHealth: async () => true, networkRestored: () => true }
    const appeared = await request(port, { method: 'POST', path: routes.CLIENT_NETWORK_HINT_ROUTE, headers: sameOrigin(port), body: {} })
    assert.deepEqual(JSON.parse(appeared.body), { ok: true, reachable: true, reconnected: true })
  } finally { await closeServer(server) }
})

// ---- CU-3: the debug-report route ------------------------------------------------

test('CU-2 drift pin: the redactor address classes agree with the pairing normalizer ranges', () => {
  // src/debug-redact.ts restates the private ranges (it must import nothing
  // under the check scripts' strip-only type stripping); this lib-level test
  // keeps the two verdicts from drifting apart.
  const { isPrivateNetworkHost } = require('../lib/client-pairing.js')
  const { serverUrlShape } = require('../lib/debug-redact.js')
  const table = [
    ['127.0.0.1', 'loopback'], ['localhost', 'loopback'], ['[::1]', 'loopback'],
    ['10.0.0.5', 'lan-ip'], ['172.16.1.1', 'lan-ip'], ['192.168.1.10', 'lan-ip'], ['100.64.0.9', 'lan-ip'],
    ['1.2.3.4', 'public-ip'],
    // S4: the range edges just outside 172.16/12 and 100.64/10.
    ['172.15.0.1', 'public-ip'], ['100.128.0.1', 'public-ip'],
    ['myserver.example.com', 'domain'], ['nas.local', 'domain'],
  ]
  for (const [host, cls] of table) {
    const shape = serverUrlShape(`http://${host}`)
    assert.equal(shape, `http://${cls}`, host)
    // The redactor names mDNS names `domain` on purpose (they are NAMES, not
    // IP addresses), while the pairing predicate admits `*.local` as plain-
    // http private hosts — that one bucket is intentionally wider there, so
    // it is pinned separately below instead of in this agreement loop.
    if (host.endsWith('.local')) continue
    const privateHost = isPrivateNetworkHost(host.replace(/^\[/u, '').replace(/\]$/u, ''))
    assert.equal(
      privateHost,
      cls === 'loopback' || cls === 'lan-ip',
      `${host}: the redactor class and the pairing predicate must agree`,
    )
  }
  assert.equal(isPrivateNetworkHost('nas.local'), true, 'the pairing predicate still admits mDNS names for plain http')
})

test('CU-3 debug-report: 200 with every plate — and no token, hostname or path survives', async () => {
  const row = makeRow({ deviceToken: 'tok-0123456789abcdef0123456789abcdef0123456789abcdef' })
  const logRing = [
    { t: '2026-11-01T12:00:00.000Z', level: 'info', msg: 'row apply: role=client plugin=2.3.6 dsh=0.2.1-rc.5' },
    { t: '2026-11-01T12:00:01.000Z', level: 'warn', msg: 'refused: /Users/alice/work/x.txt' },
  ]
  const { server, port } = await startClientServer(row, {
    getLogSnapshot: () => logRing,
    getProfileName: () => 'default',
    getPluginVersion: () => '2.3.6',
  })
  try {
    const res = await request(port, { method: 'GET', path: routes.CLIENT_DEBUG_REPORT_ROUTE })
    assert.equal(res.status, 200)
    const report = JSON.parse(res.body)
    assert.deepEqual(Object.keys(report), ['_meta', 'config', 'status', 'logs'], 'all plates, gateway absent on a client mount')
    assert.equal(report._meta.role, 'client')
    assert.equal(report._meta.pluginVersion, '2.3.6')
    assert.equal(report._meta.profile, 'default')
    assert.equal(typeof report._meta.dshVersion, 'string')
    assert.equal(typeof report._meta.platform, 'string')
    assert.equal(typeof report._meta.generatedAt, 'string')
    assert.equal(report.config.serverUrl, `http://loopback:${gwPort}`, 'serverUrl is a shape, never the address')
    assert.equal(report.status.state, 'connected', 'the status plate is the live status body')
    assert.equal(report.status.serverUrl, `http://loopback:${gwPort}`, 'the status body\u2019s serverUrl degrades too')
    assert.equal(report.logs.length, 2)
    assert.equal(report.logs[0].msg, 'row apply: role=client plugin=2.3.6 dsh=0.2.1-rc.5', 'a clean line passes verbatim')
    assert.ok(report.logs[1].msg.includes('<路径:x.txt>'), 'a log path keeps only its leaf')
    assert.ok(!res.body.includes('/Users/alice'), 'the log path\u2019s directories are gone')
    assert.ok(!res.body.includes('127.0.0.1'), 'no raw address anywhere in the report')
    assert.ok(!res.body.includes('tok-0123456789abcdef'), 'the row token never reaches the report')
  } finally { await closeServer(server) }
})

test('CU-3 debug-report: the host mount answers its own report; without wiring it 404s', async () => {
  const row = makeRow({ serverUrl: '', deviceToken: '' })
  const wired = await startClientServer(row, {
    remoteStatusOnly: true,
    getLogSnapshot: () => [],
    getGatewaySummary: async () => ({ reachable: false, shareCount: 0 }),
    getPluginVersion: () => '2.3.6',
  })
  try {
    const res = await request(wired.port, { method: 'GET', path: routes.CLIENT_DEBUG_REPORT_ROUTE })
    assert.equal(res.status, 200)
    const report = JSON.parse(res.body)
    assert.deepEqual(Object.keys(report), ['_meta', 'config', 'status', 'gateway', 'logs'], 'the host mount carries the gateway plate')
    assert.equal(report.gateway.reachable, false)
    assert.equal(report.config.serverUrl, 'unset', 'a host row without credentials shapes to unset')
    assert.equal(report.status.state, 'unpaired', 'the host status plate reads unpaired')
  } finally { await closeServer(wired.server) }

  const unwired = await startClientServer(row, { remoteStatusOnly: true })
  try {
    const res = await request(unwired.port, { method: 'GET', path: routes.CLIENT_DEBUG_REPORT_ROUTE })
    assert.equal(res.status, 404, 'no log snapshot wired — the route does not exist')
    assert.equal(JSON.parse(res.body).error.code, 'not-found')
  } finally { await closeServer(unwired.server) }
})

test('CU-3 debug-report: admit first, then the via wall, before any dispatch', async () => {
  const row = makeRow()
  // The via wall: a gateway-forwarded request is refused with via-gateway —
  // even on the host mount (whose other routes 404 long before).
  const mounted = await startClientServer(row, {
    remoteStatusOnly: true,
    getLogSnapshot: () => [],
  })
  try {
    const via = await request(mounted.port, { method: 'GET', path: routes.CLIENT_DEBUG_REPORT_ROUTE, headers: { 'x-zen-remote-via': 'gateway' } })
    assert.equal(via.status, 403)
    assert.equal(JSON.parse(via.body).error.code, 'via-gateway')
    // Admit still runs FIRST: an unadmitted request is DSH's 401, via or not.
    const unadmitted = await startClientServer(row, {
      admit: () => ({ rejection: 401 }),
      getLogSnapshot: () => [],
    })
    try {
      const refused = await request(unadmitted.port, { method: 'GET', path: routes.CLIENT_DEBUG_REPORT_ROUTE, headers: { 'x-zen-remote-via': 'gateway' } })
      assert.equal(refused.status, 401, 'admit is wall 1')
    } finally { await closeServer(unadmitted.server) }
  } finally { await closeServer(mounted.server) }
})

test('CU-3 debug-report: non-GET is 405 with the Allow header', async () => {
  const row = makeRow()
  const { server, port } = await startClientServer(row, { getLogSnapshot: () => [] })
  try {
    const res = await request(port, { method: 'POST', path: routes.CLIENT_DEBUG_REPORT_ROUTE, headers: sameOrigin(port), body: {} })
    assert.equal(res.status, 405)
    assert.equal(res.headers.allow, 'GET')
  } finally { await closeServer(server) }
})

test('CU-3 debug-report: a status lastError with an embedded path comes out redacted', async () => {
  const row = makeRow()
  const relay = fakeRelay({
    state: 'offline',
    lastError: 'ECONNREFUSED at /Users/alice/secret/tunnel.dump',
    connect: async () => { throw new RelayError('offline', 'connect failed') },
  })
  const { server, port } = await startClientServer(row, { getRelayClient: () => relay, getLogSnapshot: () => [] })
  try {
    const res = await request(port, { method: 'GET', path: routes.CLIENT_DEBUG_REPORT_ROUTE })
    assert.equal(res.status, 200)
    const report = JSON.parse(res.body)
    assert.equal(report.status.state, 'unreachable')
    assert.ok(report.status.lastError.includes('<路径:tunnel.dump>'), 'the embedded path keeps only its leaf')
    assert.ok(!res.body.includes('/Users/alice'), 'the path\u2019s directories are gone')
    assert.ok(!res.body.includes('127.0.0.1'), 'the serverUrl degraded to its shape')
  } finally { await closeServer(server) }
})

test('CU-fix S2: a rejected upload reaches the log ring through the warn the route hands in', async () => {
  // Required BEFORE the dynamic import below pulls lib/ in as ESM (the
  // ERR_REQUIRE_ESM_RACE_CONDITION note at the top of this file).
  const { createLogRing, createPluginLog } = require('../lib/log-ring.js')
  const { handleUpload } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href)
  const ring = createLogRing()
  const loggerLines = []
  const log = createPluginLog(ring, { warn: (...args) => { loggerLines.push(args) } })
  // No live session: the upload is refused with 404 session-not-found — the
  // rejection path. The context logger throws if touched: with a warn handed
  // in, the line must go through it (logger + ring), never around it.
  const ctx = {
    sessions: { get: () => undefined },
    logger: { warn: () => { throw new Error('the bare context logger must not be used when warn is passed') } },
  }
  const server = http.createServer((req, res) => { void handleUpload(ctx, 1024, req, res, undefined, log.warn) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const res = await request(server.address().port, { method: 'POST', path: '/_dsh/mobile-nav/upload?session=nope&name=x.txt', body: 'hello', headers: { 'content-type': 'application/octet-stream' } })
    assert.equal(res.status, 404)
    assert.equal(loggerLines.length, 1, 'the context logger still gets the line (double write)')
    const entries = ring.snapshot()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].level, 'warn')
    assert.match(entries[0].msg, /^dsh-mobile-nav upload rejected: live Session not found: nope$/u)
  } finally { await closeServer(server) }

  // Wiring pin: the production upload route hands apply()'s double-writer in.
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8')
  const anchor = source.indexOf("'dsh-mobile-nav: upload route'")
  assert.notEqual(anchor, -1, 'the upload route registration is the anchor')
  const call = source.slice(source.lastIndexOf('return handleUpload(', anchor), anchor)
  assert.match(call, /admit\(admitReq\),\s*logWarn,\s*\)/u, 'the route passes logWarn as the warn argument')
})

// ---- MS-5: the pool mode (multi-server sub-client) ----------------------------

const UNPAIR_ROUTE = '/_dsh/zen-remote/client/unpair'

test('MS-5: the unpair route constant sits under the client prefix', async () => {
  assert.equal(routes.CLIENT_UNPAIR_ROUTE, UNPAIR_ROUTE)
})

/** A RelayPool stand-in with exactly the surface the client routes consume,
 * recording every mutating call. `entries` is the live array the getters
 * read; `overrides` replaces any method for one scenario. PC-14a adds the
 * virtual-mount discrimination (`virtualIds` + `isVirtual`) the sync facts
 * read — a scenario stages its virtual mounts there, plain paired entries
 * stay non-virtual exactly like the real pool's records. */
function fakePool(entries, overrides = {}) {
  const calls = { pair: [], unpair: [], unpairAll: 0, reconnect: [], probeRestore: 0, deviceName: [] }
  const virtualIds = new Set(overrides.virtualIds ?? [])
  const pool = {
    calls,
    virtualIds,
    entries: () => entries,
    getByEntryId: (entryId) => entries.find((entry) => entry.entryId === entryId),
    getByServerId: (serverId) => entries.find((entry) => entry.serverId === serverId),
    isVirtual: (entryId) => virtualIds.has(entryId),
    pair: async (input) => {
      calls.pair.push(input)
      const existing = entries.find((entry) => entry.serverUrl === input.serverUrl)
      if (existing !== undefined) return { ok: true, entry: existing, replaced: true }
      // The fake's own cap mirrors the real pool's pair(): the DYNAMIC cap
      // (overrides.pairCap, default the historic 8), not a constant.
      if (entries.length >= (typeof overrides.pairCap === 'number' ? overrides.pairCap : 8)) return { ok: false, code: 'limit-reached' }
      const view = {
        entryId: `fresh-${entries.length + 1}`,
        serverUrl: input.serverUrl,
        serverId: undefined,
        serverName: undefined,
        displayName: input.serverUrl,
        client: fakeRelay({ state: 'connecting' }),
        createdAt: 1,
      }
      entries.push(view)
      return { ok: true, entry: view, replaced: false }
    },
    unpair: (entryId) => {
      calls.unpair.push(entryId)
      const index = entries.findIndex((entry) => entry.entryId === entryId)
      if (index === -1) return false
      entries.splice(index, 1)
      return true
    },
    unpairAll: () => {
      calls.unpairAll += 1
      const count = entries.length
      entries.length = 0
      return count
    },
    reconnect: async (entryId) => {
      calls.reconnect.push(entryId ?? null)
      if (entryId !== undefined) {
        const entry = entries.find((candidate) => candidate.entryId === entryId)
        return entry !== undefined && entry.client.reconnect() === true
      }
      let any = false
      for (const entry of entries) {
        if (entry.client.state === 'offline') any = entry.client.reconnect() || any
      }
      return any
    },
    probeAndRestoreAll: async () => {
      calls.probeRestore += 1
      return { reachable: true, reconnected: true }
    },
    queueDeviceNameAll: (name) => { calls.deviceName.push(name) },
    stop: () => {},
    ...overrides,
  }
  return pool
}

/** One pool entry view with a fake relay client. */
function makeEntry(entryId, serverId, serverUrl, name, clientOverrides = {}) {
  const client = fakeRelay({ state: 'online', handshakeInfo: { relayProtocol: 1, serverId, serverName: name, dshVersion: '2.0.0', fingerprints: {} }, ...clientOverrides })
  if (client.nextRetryAt === undefined) client.nextRetryAt = null
  return {
    entryId,
    serverUrl,
    serverId: clientOverrides.serverIdView !== undefined ? clientOverrides.serverIdView : serverId,
    serverName: clientOverrides.serverNameView !== undefined ? clientOverrides.serverNameView : name,
    displayName: clientOverrides.displayName ?? name,
    client,
    createdAt: 1,
  }
}

test('MS-5 claim pool mode: the pairing lands in the pool, the response carries NO token', async () => {
  const pool = fakePool([])
  const { server, port } = await startClientServer(makeRow(), { pool })
  try {
    const before = gwSeen.length
    const res = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CLAIM_ROUTE,
      headers: sameOrigin(port),
      body: { serverUrl: gwUrl, code: 'AAAAAA33', name: '书房电脑' },
    })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.deepEqual(body, { ok: true, entryId: 'fresh-1', deviceId: 'dev1', deviceName: '台式机', serverUrl: gwUrl }, 'entryId + the normalized address, never the token')
    assert.equal(body.token, undefined)
    assert.equal(pool.calls.pair.length, 1)
    assert.deepEqual(pool.calls.pair[0], { serverUrl: gwUrl, token: 'tok-gateway', deviceId: 'dev1', deviceName: '台式机' }, 'the gateway token went straight into the pool')
    assert.equal(gwSeen.length, before + 1, 'the claim round-trip still reached the gateway')
  } finally {
    await closeServer(server)
  }
})

test('MS-5 claim pool mode: the 8-server cap refuses a NEW address BEFORE any network request', async () => {
  const entries = []
  for (let i = 0; i < 8; i += 1) entries.push(makeEntry(`e${i}`, `0000000${i}`, `http://10.0.0.${i + 1}:3080`, `srv-${i}`))
  const pool = fakePool(entries)
  const { server, port } = await startClientServer(makeRow(), { pool })
  try {
    const before = gwSeen.length
    const res = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CLAIM_ROUTE,
      headers: sameOrigin(port),
      body: { serverUrl: 'http://10.9.9.9:3080', code: 'AAAAAA44', name: '新台' },
    })
    assert.equal(res.status, 409)
    assert.deepEqual(JSON.parse(res.body), { ok: false, code: 'limit-reached' })
    assert.equal(gwSeen.length, before, 'the refusal is local — the gateway never saw the pairing code')
    assert.equal(pool.calls.pair.length, 0, 'nothing was paired')
  } finally {
    await closeServer(server)
  }
})

test('MS-5 claim pool mode: an ALREADY-paired address re-pairs fine at 8/8 (token refresh)', async () => {
  const entries = []
  for (let i = 0; i < 7; i += 1) entries.push(makeEntry(`e${i}`, `0000000${i}`, `http://10.0.0.${i + 1}:3080`, `srv-${i}`))
  // The already-paired address is the MOCK gateway's: the re-pair really
  // redeems a fresh code there, at the cap too.
  entries.push(makeEntry('e7', '00000007', gwUrl, 'srv-7'))
  const target = entries[7]
  const pool = fakePool(entries)
  const { server, port } = await startClientServer(makeRow(), { pool })
  try {
    const res = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CLAIM_ROUTE,
      headers: sameOrigin(port),
      body: { serverUrl: target.serverUrl, code: 'AAAAAA55', name: '覆盖重配' },
    })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.entryId, target.entryId, 'the same address keeps its entry')
    assert.equal(body.token, undefined)
    assert.equal(pool.calls.pair.length, 1)
    assert.equal(pool.calls.pair[0].serverUrl, target.serverUrl)
  } finally {
    await closeServer(server)
  }
})

test('MS-5 claim pool mode: a gateway refusal classifies as before and never touches the pool', async () => {
  const pool = fakePool([])
  const { server, port } = await startClientServer(makeRow(), { pool })
  try {
    gwState.claimReply = () => [403, { ok: false, reason: 'bad-code' }]
    const res = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CLAIM_ROUTE,
      headers: sameOrigin(port),
      body: { serverUrl: gwUrl, code: 'AAAAAAAA', name: 'n' },
    })
    assert.deepEqual(JSON.parse(res.body), { ok: false, code: 'bad-code' })
    assert.equal(pool.calls.pair.length, 0, 'a failed redemption pairs nothing')
  } finally {
    gwState.claimReply = () => [200, { ok: true, id: 'dev1', name: '台式机', token: 'tok-gateway' }]
    await closeServer(server)
  }
})

test('MS-5 unpair: the wall order holds and the two shapes route to unpair/unpairAll', async () => {
  const entries = [makeEntry('e1', 'abcd1234', 'http://10.0.0.1:3080', 'A'), makeEntry('e2', 'ffffffff', 'http://10.0.0.2:3080', 'B')]
  const pool = fakePool(entries)
  const { server, port } = await startClientServer(makeRow(), { pool })
  const headers = sameOrigin(port)
  try {
    const unadmitted = await startClientServer(makeRow(), { pool: fakePool([]), admit: () => ({ rejection: 401 }) })
    const r401 = await request(unadmitted.port, { method: 'POST', path: UNPAIR_ROUTE, headers: sameOrigin(unadmitted.port), body: { all: true } })
    assert.equal(r401.status, 401)
    await closeServer(unadmitted.server)

    const crossSite = await request(port, { method: 'POST', path: UNPAIR_ROUTE, headers: { origin: 'http://evil.example' }, body: { all: true } })
    assert.equal(crossSite.status, 403)

    const wrongMethod = await request(port, { method: 'GET', path: UNPAIR_ROUTE, headers })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.allow, 'POST')

    const badParams = await request(port, { method: 'POST', path: UNPAIR_ROUTE, headers, body: {} })
    assert.equal(badParams.status, 400, 'neither all nor entryId is a bad request')
    const blankId = await request(port, { method: 'POST', path: UNPAIR_ROUTE, headers, body: { entryId: '' } })
    assert.equal(blankId.status, 400)
    const wrongType = await request(port, { method: 'POST', path: UNPAIR_ROUTE, headers, body: { entryId: 42 } })
    assert.equal(wrongType.status, 400)

    const one = await request(port, { method: 'POST', path: UNPAIR_ROUTE, headers, body: { entryId: 'e1' } })
    assert.equal(one.status, 200)
    assert.deepEqual(JSON.parse(one.body), { ok: true, removed: 1 })
    assert.deepEqual(pool.calls.unpair, ['e1'])

    const gone = await request(port, { method: 'POST', path: UNPAIR_ROUTE, headers, body: { entryId: 'nope' } })
    assert.deepEqual(JSON.parse(gone.body), { ok: true, removed: 0 }, 'an unknown entry answers removed: 0')

    const all = await request(port, { method: 'POST', path: UNPAIR_ROUTE, headers, body: { all: true } })
    assert.deepEqual(JSON.parse(all.body), { ok: true, removed: 1 }, 'the one entry left after the removal above')
    assert.equal(pool.calls.unpairAll, 1)
  } finally {
    await closeServer(server)
  }
})

test('MS-5 unpair: without a pool the route does not exist', async () => {
  const { server, port } = await startClientServer(makeRow())
  try {
    const res = await request(port, { method: 'POST', path: UNPAIR_ROUTE, headers: sameOrigin(port), body: { all: true } })
    assert.equal(res.status, 404)
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: 'not-found', message: 'Unknown client route' } })
  } finally {
    await closeServer(server)
  }
})

test('MS-5 reconnect pool mode: no body reconnects every OFFLINE server, entryId targets one', async () => {
  const offlineTries = []
  const entries = [
    makeEntry('e1', 'abcd1234', 'http://10.0.0.1:3080', 'A'),
    makeEntry('e2', 'ffffffff', 'http://10.0.0.2:3080', 'B', { state: 'offline', reconnect: () => { offlineTries.push('e2'); return true } }),
    makeEntry('e3', '1234abcd', 'http://10.0.0.3:3080', 'C', { state: 'offline', reconnect: () => { offlineTries.push('e3'); return true } }),
  ]
  const pool = fakePool(entries)
  const { server, port } = await startClientServer(makeRow(), { pool })
  const headers = sameOrigin(port)
  try {
    const emptyBody = await request(port, { method: 'POST', path: routes.CLIENT_RECONNECT_ROUTE, headers, body: {} })
    assert.equal(emptyBody.status, 200)
    assert.deepEqual(JSON.parse(emptyBody.body), { ok: true, started: true })
    assert.deepEqual(offlineTries.sort(), ['e2', 'e3'], 'only the offline entries were reconnected')

    offlineTries.length = 0
    const targeted = await request(port, { method: 'POST', path: routes.CLIENT_RECONNECT_ROUTE, headers, body: { entryId: 'e2' } })
    assert.equal(targeted.status, 200)
    assert.deepEqual(JSON.parse(targeted.body), { ok: true })
    assert.deepEqual(offlineTries, ['e2'], 'exactly the named entry')

    const onlineTarget = await request(port, { method: 'POST', path: routes.CLIENT_RECONNECT_ROUTE, headers, body: { entryId: 'e1' } })
    assert.equal(onlineTarget.status, 409)
    assert.deepEqual(JSON.parse(onlineTarget.body), { ok: false, error: { code: 'not-offline', message: 'The client is not offline' } })

    const unknown = await request(port, { method: 'POST', path: routes.CLIENT_RECONNECT_ROUTE, headers, body: { entryId: 'nope' } })
    assert.equal(unknown.status, 404)
    assert.deepEqual(JSON.parse(unknown.body), { ok: false, error: { code: 'not-found', message: 'No such paired server' } })

    const allOnline = fakePool([makeEntry('e1', 'abcd1234', 'http://10.0.0.1:3080', 'A')])
    const second = await startClientServer(makeRow(), { pool: allOnline })
    try {
      const quiet = await request(second.port, { method: 'POST', path: routes.CLIENT_RECONNECT_ROUTE, headers: sameOrigin(second.port), body: {} })
      assert.equal(quiet.status, 200)
      assert.deepEqual(JSON.parse(quiet.body), { ok: true, started: false }, 'nothing offline, nothing started')
    } finally {
      await closeServer(second.server)
    }
  } finally {
    await closeServer(server)
  }
})

test('MS-5 status pool mode: servers array in pairing order, no token anywhere, top level mirrors the first', async () => {
  const entries = [
    makeEntry('e1', 'abcd1234', 'http://10.0.0.1:3080', 'A', {
      handshakeInfo: { relayProtocol: 1, serverId: 'abcd1234', serverName: 'A', dshVersion: '2.0.0', fingerprints: {}, deviceName: '台式机A' },
      compat: { identical: ['g1'], different: ['g2'], unavailable: [] },
    }),
    makeEntry('e2', undefined, 'http://10.0.0.2:3080', 'B', {
      state: 'offline',
      nextRetryAt: 1234567890123,
      serverIdView: 'ffffffff',
      serverNameView: '旧名B',
      displayName: 'B-1',
    }),
  ]
  entries[1].client.lastError = 'offline'
  const bridgeFor = (serverId, client) => [{ plugin: `bridge-${serverId ?? 'none'}-${client.state}`, bridged: true }]
  const pool = fakePool(entries)
  const { server, port } = await startClientServer(makeRow(), { pool, getPluginBridgeStatusForServer: bridgeFor })
  try {
    const res = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.maxServers, 8)
    assert.equal(body.state, 'online', 'the top level keeps the FIRST entry\'s state')
    assert.equal(body.serverUrl, 'http://10.0.0.1:3080')
    assert.equal(body.serverName, 'A')
    assert.equal(body.deviceName, '台式机A')
    assert.deepEqual(body.servers, [
      {
        entryId: 'e1',
        serverId: 'abcd1234',
        serverUrl: 'http://10.0.0.1:3080',
        serverName: 'A',
        displayName: 'A',
        state: 'online',
        nextRetryAt: null,
        compat: { identical: ['g1'], different: ['g2'], unavailable: [] },
        pluginBridge: [{ plugin: 'bridge-abcd1234-online', bridged: true }],
      },
      {
        entryId: 'e2',
        serverId: 'ffffffff',
        serverUrl: 'http://10.0.0.2:3080',
        serverName: '旧名B',
        displayName: 'B-1',
        state: 'offline',
        nextRetryAt: 1234567890123,
        lastError: 'offline',
        pluginBridge: [{ plugin: 'bridge-ffffffff-offline', bridged: true }],
      },
    ])
    assert.equal(JSON.parse(res.body).token, undefined)
    assert.ok(!res.body.includes('tok'), 'no credential material anywhere in the body')
    // Diagnostics fields stay at the top level, per-server compat/pluginBridge ride the items.
    assert.deepEqual(body.pluginBridge, [{ plugin: 'bridge-abcd1234-online', bridged: true }], 'top-level pluginBridge mirrors the first entry')
    assert.deepEqual(body.compat, { identical: ['g1'], different: ['g2'], unavailable: [], incompatibleCalls: [] })
  } finally {
    await closeServer(server)
  }
})

test('MS-5 status pool mode: an empty pool answers unpaired with maxServers', async () => {
  const pool = fakePool([])
  const { server, port } = await startClientServer(makeRow(), { pool })
  try {
    const res = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.state, 'unpaired')
    assert.equal(body.maxServers, 8)
    assert.deepEqual(body.servers, [])
    assert.deepEqual(body.pluginBridge, [])
  } finally {
    await closeServer(server)
  }
})

// ---- PG-2: the status/claim routes read the LIVE maxServers --------------------

test('PG-2 status pool mode: maxServers follows the live getter, not the constant', async () => {
  let configured = 16
  const pool = fakePool([])
  const { server, port } = await startClientServer(makeRow(), { pool, getMaxServers: () => configured })
  try {
    const first = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    assert.equal(JSON.parse(first.body).maxServers, 16, 'the getter answer rides the status body')

    // The getter is live: a config change (LAN_GATE_MAX_SERVERS edited, a
    // peerNetwork cap) shows up on the very next request without any reload.
    configured = 4
    const second = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    assert.equal(JSON.parse(second.body).maxServers, 4)
  } finally {
    await closeServer(server)
  }
})

test('PG-2 claim pool mode: a raised cap admits the 9th pairing; the refusal stays local', async () => {
  const entries = []
  for (let i = 0; i < 8; i += 1) entries.push(makeEntry(`e${i}`, `0000000${i}`, `http://10.0.0.${i + 1}:3080`, `srv-${i}`))
  const pool = fakePool(entries, { pairCap: 16 })
  const { server, port } = await startClientServer(makeRow(), { pool, getMaxServers: () => 16 })
  try {
    const before = gwSeen.length
    // The ninth NEW address is the mock gateway's own — the point is that
    // the route PROCEEDS to the round-trip instead of refusing locally.
    const res = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CLAIM_ROUTE,
      headers: sameOrigin(port),
      body: { serverUrl: gwUrl, code: 'AAAAAA55', name: '第九台' },
    })
    assert.equal(res.status, 200, 'under a 16 cap the ninth NEW address is NOT refused locally')
    assert.equal(gwSeen.length, before + 1, 'the claim round-trip reached the gateway')
    assert.equal(pool.calls.pair.length, 1, 'the pairing landed in the pool')
    assert.equal(JSON.parse(res.body).entryId, 'fresh-9', 'the ninth entry joined the pool')
  } finally {
    await closeServer(server)
  }
})

test('PG-2 claim pool mode: a lowered cap refuses below 8 too', async () => {
  const entries = []
  for (let i = 0; i < 4; i += 1) entries.push(makeEntry(`e${i}`, `0000000${i}`, `http://10.0.0.${i + 1}:3080`, `srv-${i}`))
  const pool = fakePool(entries)
  const { server, port } = await startClientServer(makeRow(), { pool, getMaxServers: () => 4 })
  try {
    const before = gwSeen.length
    const res = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CLAIM_ROUTE,
      headers: sameOrigin(port),
      body: { serverUrl: 'http://10.9.9.9:3080', code: 'AAAAAA66', name: '第五台' },
    })
    assert.equal(res.status, 409)
    assert.deepEqual(JSON.parse(res.body), { ok: false, code: 'limit-reached' })
    assert.equal(gwSeen.length, before, 'the tightened cap is still a local refusal')
  } finally {
    await closeServer(server)
  }
})

// ---- PG-2-fix: status / claim pre-check follow pool.maxServers(), not the raw config ----
// The pool's maxServers() is the ONE synthesis point that folds the peer
// mode's network-reported maxPeersFromGateway into the configured value, and
// pool.pair() enforces exactly that number. The routes must answer the same
// number — a config-raw read would split the cap into two truths in peer
// mode (the pre-check admits what pair refuses, or the reverse).

test('PG-2-fix status: maxServers reports pool.maxServers() over a diverging config value', async () => {
  // Config getter says 8, the pool synthesizes 12 (peer mode, gateway cap).
  const wide = fakePool([], { maxServers: () => 12 })
  const { server, port } = await startClientServer(makeRow(), { pool: wide, getMaxServers: () => 8 })
  try {
    const res = await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    assert.equal(JSON.parse(res.body).maxServers, 12, 'the pool synthesis wins over the raw config 8')
  } finally { await closeServer(server) }

  // Reversed: config says 16, the pool synthesizes 4 — the tight one wins.
  const tight = fakePool([], { maxServers: () => 4 })
  const { server: server2, port: port2 } = await startClientServer(makeRow(), { pool: tight, getMaxServers: () => 16 })
  try {
    const res = await request(port2, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })
    assert.equal(JSON.parse(res.body).maxServers, 4, 'the pool synthesis wins over the raw config 16')
  } finally { await closeServer(server2) }
})

test('PG-2-fix claim: a pool cap HIGHER than the config admits the pairing', async () => {
  // 8 entries, config cap 8 (would refuse), pool synthesis 12 (must admit):
  // the pre-check must follow the pool — the same cap pair() will enforce.
  const entries = []
  for (let i = 0; i < 8; i += 1) entries.push(makeEntry(`e${i}`, `0000000${i}`, `http://10.0.0.${i + 1}:3080`, `srv-${i}`))
  const pool = fakePool(entries, { pairCap: 12, maxServers: () => 12 })
  const { server, port } = await startClientServer(makeRow(), { pool, getMaxServers: () => 8 })
  try {
    const before = gwSeen.length
    const res = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CLAIM_ROUTE,
      headers: sameOrigin(port),
      body: { serverUrl: gwUrl, code: 'AAAAAA77', name: '第九台' },
    })
    assert.equal(res.status, 200, 'the pool cap 12 admits the ninth despite the config cap 8')
    assert.equal(gwSeen.length, before + 1, 'the claim round-trip reached the gateway')
    assert.equal(pool.calls.pair.length, 1, 'the pairing landed in the pool')
  } finally { await closeServer(server) }
})

test('PG-2-fix claim: a pool cap LOWER than the config refuses locally', async () => {
  // 4 entries, config cap 16 (would admit), pool synthesis 4 (must refuse):
  // the local pre-check spends no claim code on the wire.
  const entries = []
  for (let i = 0; i < 4; i += 1) entries.push(makeEntry(`e${i}`, `0000000${i}`, `http://10.0.0.${i + 1}:3080`, `srv-${i}`))
  const pool = fakePool(entries, { pairCap: 4, maxServers: () => 4 })
  const { server, port } = await startClientServer(makeRow(), { pool, getMaxServers: () => 16 })
  try {
    const before = gwSeen.length
    const res = await request(port, {
      method: 'POST',
      path: routes.CLIENT_CLAIM_ROUTE,
      headers: sameOrigin(port),
      body: { serverUrl: 'http://10.9.9.9:3080', code: 'AAAAAA88', name: '第五台' },
    })
    assert.equal(res.status, 409, 'the pool cap 4 refuses the fifth despite the config cap 16')
    assert.deepEqual(JSON.parse(res.body), { ok: false, code: 'limit-reached' })
    assert.equal(gwSeen.length, before, 'the refusal is local — the gateway never saw the code')
    assert.equal(pool.calls.pair.length, 0, 'nothing was paired')
  } finally { await closeServer(server) }
})

test('PG-2 debug report: the config plate names the resolved maxServers', async () => {
  const row = makeRow({ maxServers: 12 })
  const { server, port } = await startClientServer(row, {
    getLogSnapshot: () => [],
    getPluginVersion: () => '2.3.6',
  })
  try {
    const res = await request(port, { method: 'GET', path: routes.CLIENT_DEBUG_REPORT_ROUTE })
    assert.equal(res.status, 200)
    const report = JSON.parse(res.body)
    assert.equal(report.config.maxServers, 12, 'the row layer value reached the config plate')
  } finally { await closeServer(server) }

  // Without a row value the plate carries the default 8.
  const { server: server2, port: port2 } = await startClientServer(makeRow(), {
    getLogSnapshot: () => [],
    getPluginVersion: () => '2.3.6',
  })
  try {
    const res = await request(port2, { method: 'GET', path: routes.CLIENT_DEBUG_REPORT_ROUTE })
    assert.equal(JSON.parse(res.body).config.maxServers, 8)
  } finally { await closeServer(server2) }
})

test('MS-5 status pool mode: the row credentials are never consulted, the pool is the truth', async () => {
  // A pool-mode mount with an EMPTY row: the old route would answer
  // unpaired-from-the-row and probe nothing; the pool mode answers from the
  // pool's paired list even so.
  const pool = fakePool([makeEntry('e1', 'abcd1234', gwUrl, 'A')])
  const { server, port } = await startClientServer(makeRow({ serverUrl: '', deviceToken: '' }), { pool })
  try {
    const before = gwSeen.length
    const body = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.equal(body.state, 'online')
    assert.equal(body.servers.length, 1)
    assert.equal(gwSeen.length, before, 'no ping probe — the live client is the source')
  } finally {
    await closeServer(server)
  }
})

test('MS-5 remote-status pool mode: per-serverId map with state/versionMismatch/serverName/bridgedPlugins', async () => {
  const entries = [
    makeEntry('e1', 'abcd1234', 'http://10.0.0.1:3080', 'A', {
      compat: { identical: [], different: ['g9'], unavailable: [] },
    }),
    makeEntry('e2', 'ffffffff', 'http://10.0.0.2:3080', 'B', { state: 'revoked', serverNameView: 'B' }),
    makeEntry('e3', undefined, 'http://10.0.0.3:3080', 'C', { state: 'connecting', serverIdView: undefined, serverNameView: 'C' }),
  ]
  const bridgeFor = (serverId) => (
    serverId === 'abcd1234'
      ? [{ plugin: 'zzz-later', bridged: true }, { plugin: 'aaa-first', bridged: true }, { plugin: 'not-bridged', bridged: false }]
      : []
  )
  const interceptDiagnostics = { installed: true, shape: { ok: true, reasons: [], notes: [] }, recentFailures: [], incompatibleCalls: [], closedSessions: [{ sessionId: 'zr~abcd1234~s9', reason: 'closed' }] }
  const pool = fakePool(entries)
  const { server, port } = await startClientServer(makeRow(), { pool, getPluginBridgeStatusForServer: bridgeFor, getIntercept: () => interceptDiagnostics })
  try {
    const res = await request(port, { method: 'GET', path: routes.CLIENT_REMOTE_STATUS_ROUTE })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.deepEqual(body.servers, {
      abcd1234: { state: 'online', versionMismatch: true, serverName: 'A', bridgedPlugins: ['aaa-first', 'zzz-later'] },
      ffffffff: { state: 'revoked', versionMismatch: false, serverName: 'B', bridgedPlugins: [] },
    }, 'an entry without a handshake serverId is not addressable and is skipped')
    // The top-level compatibility fields survive, mirroring the FIRST entry.
    assert.equal(body.state, 'online')
    assert.equal(body.versionMismatch, true)
    assert.equal(body.serverName, 'A')
    assert.deepEqual(body.closed, { 'zr~abcd1234~s9': 'closed' })
    assert.deepEqual(body.bridgedPlugins, ['aaa-first', 'zzz-later'])
  } finally {
    await closeServer(server)
  }
})

test('MS-5 unshare pool mode: the session id\'s serverId picks the client, a foreign server refuses locally', async () => {
  const unshared = []
  const a = makeEntry('e1', 'abcd1234', 'http://10.0.0.1:3080', 'A', { unshare: async (id) => { unshared.push(['a', id]) } })
  const b = makeEntry('e2', 'ffffffff', 'http://10.0.0.2:3080', 'B', { unshare: async (id) => { unshared.push(['b', id]) } })
  const pool = fakePool([a, b])
  const { server, port } = await startClientServer(makeRow(), { pool })
  const headers = sameOrigin(port)
  try {
    const toB = await request(port, { method: 'POST', path: routes.CLIENT_UNSHARE_ROUTE, headers, body: { sessionId: 'zr~ffffffff~session-b' } })
    assert.equal(toB.status, 200)
    assert.deepEqual(JSON.parse(toB.body), { ok: true })
    const toA = await request(port, { method: 'POST', path: routes.CLIENT_UNSHARE_ROUTE, headers, body: { sessionId: 'zr~abcd1234~session-a' } })
    assert.deepEqual(JSON.parse(toA.body), { ok: true })
    assert.deepEqual(unshared, [['b', 'session-b'], ['a', 'session-a']], 'each virtual id reached ITS OWN server with the ORIGINAL id')

    const foreign = await request(port, { method: 'POST', path: routes.CLIENT_UNSHARE_ROUTE, headers, body: { sessionId: 'zr~99999999~session-x' } })
    assert.equal(foreign.status, 200)
    assert.deepEqual(JSON.parse(foreign.body), { ok: false, error: { code: 'remote-mismatch', message: '此远程会话属于其他主服务端' } })
    assert.equal(unshared.length, 2, 'the unheld server saw nothing')
  } finally {
    await closeServer(server)
  }
})

test('MS-5 http pool mode: per-server routing, offline reads remote-offline, unheld reads remote-mismatch', async () => {
  const calls = []
  const a = makeEntry('e1', 'abcd1234', 'http://10.0.0.1:3080', 'A', {
    http: async (route, query) => { calls.push(['a', route, query]); return { status: 200, contentType: 'application/json', body: '{"from":"a"}' } },
  })
  const b = makeEntry('e2', 'ffffffff', 'http://10.0.0.2:3080', 'B', { state: 'offline' })
  const pool = fakePool([a, b])
  const { server, port } = await startClientServer(makeRow(), { pool })
  try {
    const ok = await request(port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=${encodeURIComponent('zr~abcd1234~session-1')}&seq=3` })
    assert.equal(ok.status, 200)
    assert.deepEqual(JSON.parse(ok.body), { from: 'a' })
    assert.deepEqual(calls, [['a', 'changes.summary', 'sessionId=session-1&seq=3']])

    const offline = await request(port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=${encodeURIComponent('zr~ffffffff~session-2')}` })
    assert.equal(offline.status, 503)
    assert.deepEqual(JSON.parse(offline.body), { ok: false, error: { code: 'remote-offline' } })

    const foreign = await request(port, { method: 'GET', path: `${routes.CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=${encodeURIComponent('zr~99999999~session-3')}` })
    assert.equal(foreign.status, 400)
    assert.deepEqual(JSON.parse(foreign.body), { ok: false, error: { code: 'remote-mismatch', message: '此远程会话属于其他主服务端' } })
  } finally {
    await closeServer(server)
  }
})

test('MS-5 network-hint pool mode: one probe-and-restore sweep answers the hint', async () => {
  const pool = fakePool([makeEntry('e1', 'abcd1234', 'http://10.0.0.1:3080', 'A')])
  const { server, port } = await startClientServer(makeRow(), { pool })
  try {
    const res = await request(port, { method: 'POST', path: routes.CLIENT_NETWORK_HINT_ROUTE, headers: sameOrigin(port), body: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true, reachable: true, reconnected: true })
    assert.equal(pool.calls.probeRestore, 1)
  } finally {
    await closeServer(server)
  }
})

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
      leaveNetwork: () => { calls.push(['leave']) },
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
// (temporary) state file — under .scratch/pc-11a, never /tmp — drives BOTH
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
  const scratchRoot = path.join(__dirname, '..', '.scratch', 'pc-11a')
  fs.mkdirSync(scratchRoot, { recursive: true })
  const dir = fs.mkdtempSync(path.join(scratchRoot, 'real-pool-'))
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
  const scratchRoot = path.join(__dirname, '..', '.scratch', 'pc-14a')
  fs.mkdirSync(scratchRoot, { recursive: true })
  const dir = fs.mkdtempSync(path.join(scratchRoot, 'sync-'))
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
  const scratchRoot = path.join(__dirname, '..', '.scratch', 'pc-14a')
  fs.mkdirSync(scratchRoot, { recursive: true })
  const dir = fs.mkdtempSync(path.join(scratchRoot, 'impersonation-'))
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
    ]) {
      const res = await request(port, { method: 'POST', path, headers: sameOrigin(port), body })
      assert.equal(res.status, 503, path)
      assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: 'peer-unavailable' } }, path)
    }
  } finally {
    await closeServer(server)
  }
})

test('peer join by gatewayUrl: single-network auto-join, multi-network 409 select-network, and plain-HTTP public host', async () => {
  // 1. Single network on plain-HTTP public IP -> synthesizes zr-net://…?tls=0 and returns manualApproval: true.
  {
    const { engine, calls } = makePeerEngine()
    const fetchCalls = []
    const fetchImpl = async (url) => {
      fetchCalls.push(String(url))
      return new Response(
        JSON.stringify({ ok: true, data: { networks: [{ id: '1122334455667788', name: 'Office Mesh' }], totalNetworks: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine, fetchImpl })
    try {
      const res = await request(port, {
        method: 'POST',
        path: PEER_JOIN_PATH,
        headers: sameOrigin(port),
        body: { gatewayUrl: 'http://203.0.113.99:19393' },
      })
      assert.equal(res.status, 200)
      assert.deepEqual(JSON.parse(res.body), {
        ok: true,
        networkId: '1122334455667788',
        manualApproval: true,
      })
      assert.deepEqual(fetchCalls, ['http://203.0.113.99:19393/peer/v1/networks'])
      assert.deepEqual(calls, [['join', 'zr-net://203.0.113.99:19393/1122334455667788?tls=0']])
    } finally {
      await closeServer(server)
    }
  }

  // 2. Multiple networks -> first POST returns 409 select-network + networks[]; second POST with networkId joins.
  {
    const { engine, calls } = makePeerEngine()
    const fetchImpl = async () => new Response(
      JSON.stringify({
        ok: true,
        data: {
          networks: [
            { id: 'aaaa111122223333', name: 'Home' },
            { id: 'bbbb444455556666', name: 'Studio' },
          ],
          totalNetworks: 2,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine, fetchImpl })
    try {
      const first = await request(port, {
        method: 'POST',
        path: PEER_JOIN_PATH,
        headers: sameOrigin(port),
        body: { gatewayUrl: 'http://192.168.1.20:19393' },
      })
      assert.equal(first.status, 409)
      const firstBody = JSON.parse(first.body)
      assert.equal(firstBody.error.code, 'select-network')
      assert.equal(firstBody.networks.length, 2)
      assert.equal(calls.length, 0)

      const second = await request(port, {
        method: 'POST',
        path: PEER_JOIN_PATH,
        headers: sameOrigin(port),
        body: { gatewayUrl: 'http://192.168.1.20:19393', networkId: 'bbbb444455556666' },
      })
      assert.equal(second.status, 200)
      assert.deepEqual(calls, [['join', 'zr-net://192.168.1.20:19393/bbbb444455556666']])
    } finally {
      await closeServer(server)
    }
  }

  // 3. Key-only gateway -> 400 manual-disabled; unreachable gateway -> 502 gateway-unreachable.
  {
    const { engine } = makePeerEngine()
    const fetchKeyOnly = async () => new Response(
      JSON.stringify({ ok: true, data: { networks: [], totalNetworks: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    const { server, port } = await startClientServer(makeRow(), { getPeerEngine: () => engine, fetchImpl: fetchKeyOnly })
    try {
      const res = await request(port, {
        method: 'POST',
        path: PEER_JOIN_PATH,
        headers: sameOrigin(port),
        body: { gatewayUrl: 'http://192.168.1.20:19393' },
      })
      assert.equal(res.status, 400)
      assert.equal(JSON.parse(res.body).error.code, 'manual-disabled')
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
        body: { gatewayUrl: 'http://192.168.1.20:19393' },
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
