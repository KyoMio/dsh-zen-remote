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
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { request } = require('./util.cjs')

const ROUTES_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'client-routes.js')).href
const { RelayError, relayCredentialsDigest } = require('../lib/relay-client.js')

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
  }
}

function startClientServer(row, overrides = {}) {
  const handler = routes.createClientHandler({
    admit: overrides.admit || (() => ({ peer: {} })),
    getRowConfig: overrides.getRowConfig || (() => row),
    ...(overrides.fetchImpl !== undefined ? { fetchImpl: overrides.fetchImpl } : {}),
    ...(overrides.getRelayClient !== undefined ? { getRelayClient: overrides.getRelayClient } : {}),
    ...(overrides.getIntercept !== undefined ? { getIntercept: overrides.getIntercept } : {}),
    ...(overrides.remoteStatusOnly !== undefined ? { remoteStatusOnly: overrides.remoteStatusOnly } : {}),
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
    assert.deepEqual(JSON.parse(res.body), { state: 'unpaired' })
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
    assert.deepEqual(connectedBody, { state: 'connected', serverUrl: gwUrl })
    // The probe presented the row's token as a Bearer header.
    const probe = gwSeen[gwSeen.length - 1]
    assert.equal(probe.url, '/_dsh/zen-remote/relay/ping')
    assert.equal(probe.headers.authorization, 'Bearer tok-row')

    gwState.pingReply = () => [401, { ok: false, reason: 'unpaired' }]
    const revoked = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.deepEqual(revoked, { state: 'revoked', serverUrl: gwUrl })

    gwState.pingReply = () => [403, { ok: false, reason: 'relay-only' }]
    const unexpected = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.deepEqual(unexpected, { state: 'unexpected', serverUrl: gwUrl })

    const dead = http.createServer()
    await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const deadPort = dead.address().port
    await new Promise((resolve) => dead.close(resolve))
    const deadRow = makeRow({ serverUrl: `http://127.0.0.1:${deadPort}` })
    const deadServer = await startClientServer(deadRow)
    try {
      const unreachable = JSON.parse((await request(deadServer.port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
      assert.deepEqual(unreachable, { state: 'unreachable', serverUrl: `http://127.0.0.1:${deadPort}` })
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
    assert.deepEqual(JSON.parse(res.body), { state: 'invalid-url' })
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
    assert.deepEqual(JSON.parse(res.body), { state: 'invalid-url' })
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
    assert.deepEqual(JSON.parse(res.body), { state: 'online', serverName: '书房服务器', serverUrl: gwUrl, deviceName: '' }, 'no deviceName on the handshake → empty, nothing to follow')
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
    assert.deepEqual(JSON.parse(res.body), { state: 'unpaired' })
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
    assert.deepEqual(JSON.parse(res.body), { state: 'invalid-url' })
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
    assert.deepEqual(body, { state: 'online', serverName: '现场握手', serverUrl: gwUrl, deviceName: '' })
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
      assert.deepEqual(body, { state: expected, serverUrl: gwUrl }, error.code)
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
    assert.deepEqual(body, { state: 'unreachable', serverUrl: gwUrl })
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
    assert.deepEqual(unexpected, { state: 'unexpected', serverUrl: gwUrl })

    gwState.pingReply = () => [401, { ok: false, reason: 'unpaired' }]
    const revoked = JSON.parse((await request(port, { method: 'GET', path: routes.CLIENT_STATUS_ROUTE })).body)
    assert.deepEqual(revoked, { state: 'revoked', serverUrl: gwUrl })
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
    assert.deepEqual(JSON.parse(first.body), { state: 'online', serverName: '并发握手', serverUrl: gwUrl, deviceName: '' })
    assert.deepEqual(JSON.parse(second.body), { state: 'online', serverName: '并发握手', serverUrl: gwUrl, deviceName: '' })
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
    assert.deepEqual(body, { state: 'online', serverName: '新地址的名字', serverUrl: newUrl, deviceName: '' }, 'the fresh connect answers, never the stale cache')
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

const { toVirtual } = require('../lib/virtual-id.js')
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
    assert.deepEqual(body, { state: 'unpaired', versionMismatch: false, serverName: '', closed: {} })
  } finally { await closeServer(server) }

  const relay = fakeRelay({ state: 'offline', handshakeInfo: INFO('断线服务器'), lastHandshakeDigest: 'd' })
  const second = await startClientServer(row, { getRelayClient: () => relay })
  try {
    const body = JSON.parse((await request(second.port, { method: 'GET', path: routes.CLIENT_REMOTE_STATUS_ROUTE })).body)
    assert.equal(body.state, 'offline')
    assert.equal(body.versionMismatch, false, 'no compat verdict — no mismatch claim')
  } finally { await closeServer(second.server) }
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
    assert.deepEqual(JSON.parse(status.body), { state: 'unpaired', versionMismatch: false, serverName: '', closed: {} })
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
