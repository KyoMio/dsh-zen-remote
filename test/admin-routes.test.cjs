/* dsh-zen-remote · admin routes (src/admin-routes.ts, T14)
 *
 * The settings-surface admin API: the REAL createAdminHandler runs over a
 * real node:http socket, in front of a mock gateway that records everything
 * it is sent (the same seam the gateway tests drive). admit is a stub — the
 * connection service's trust decision is DSH's, not this module's; what this
 * module owns is the wall ORDER (admit → route → via marker → same-origin →
 * body → forward), the pairing-code strip for remote callers, the action
 * whitelist, and the gateway-unreachable envelopes. Every gateway-facing
 * assertion doubles as the "本机直连" contract: no X-Forwarded-*, no Origin,
 * no cookies on the forwarded call. Ports are OS-assigned; DSH_HOME points
 * at an empty temp dir as cheap insurance (getConfig is faked here anyway).
 */
'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { request } = require('./util.cjs')

const ADMIN_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'admin-routes.js')).href

function sendJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(bytes.length) })
  res.end(bytes)
}

/** The gateway's GET /lan-gate/status answer, pairing code live. */
function statusBody() {
  return {
    state: 'running',
    port: 3088,
    target: '127.0.0.1:3080',
    pwa: true,
    upstreamAuth: 'none',
    pairing: { code: 'TESTCODE', expiresAt: Date.now() + 60000, role: 'web' },
    devices: [{ id: 'dev-1', name: 'Test Phone', role: 'web', kind: 'auto', createdAt: 1, lastSeen: 2, ua: 'ua', hasPush: false }],
    pushSubscriptions: 0,
  }
}

/** Mock gateway: records every request, answers the four admin surfaces. */
function startMockGateway() {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const url = String(req.url).split('?')[0]
      seen.push({ method: req.method, url, headers: req.headers, body })
      if (url === '/lan-gate/status') { sendJson(res, 200, statusBody()); return }
      if (url === '/lan-gate/pair') {
        let role = 'web'
        try { if (JSON.parse(body || '{}').role === 'desktop-client') role = 'desktop-client' } catch { /* keep web */ }
        sendJson(res, 200, { ok: true, code: 'PAIRCODE', expiresAt: Date.now() + 60000, role })
        return
      }
      if (url === '/lan-gate/action') { sendJson(res, 200, { ok: true }); return }
      if (url === '/pwa/push/send') { sendJson(res, 200, { ok: true, sent: 1, failed: 0 }); return }
      sendJson(res, 404, { ok: false })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen })))
}

let admin
let gateway
let seen
let gwPort
let adminServer
let adminPort

/** Handler options for one admin server; `configLang` feeds the faked config,
 * other overrides splice options fields (admit / gatewayBase / timeoutMs). */
function makeOptions(gw, overrides = {}) {
  const configLang = overrides.configLang || 'zh'
  return {
    admit: overrides.admit || (() => ({ peer: {} })),
    gatewayBase: overrides.gatewayBase || `http://127.0.0.1:${gw}`,
    getConfig: () => ({
      values: { role: 'host', port: gw, lang: configLang },
      sources: { role: 'default', port: 'default', lang: 'row' },
    }),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  }
}

function startAdminServer(options) {
  const handler = admin.createAdminHandler(options)
  const server = http.createServer((req, res) => { void handler(req, res) })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

/** The origin header a same-origin browser on this admin server would send. */
function sameOrigin(port) {
  return { origin: `http://127.0.0.1:${port}` }
}

test.before(async () => {
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-admin-'))
  admin = await import(ADMIN_URL)
  ;({ server: gateway, seen } = await startMockGateway())
  gwPort = gateway.address().port
  ;({ server: adminServer } = await startAdminServer(makeOptions(gwPort)))
  adminPort = adminServer.address().port
})

test.after(() => new Promise((resolve) => gateway.close(() => adminServer.close(resolve))))

test('admit rejections relay verbatim and never reach the gateway', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden']]) {
    const { server, port } = await startAdminServer(makeOptions(gwPort, { admit: () => ({ rejection: status }) }))
    try {
      const before = seen.length
      const get = await request(port, { method: 'GET', path: admin.ADMIN_STATUS_ROUTE })
      assert.equal(get.status, status)
      assert.equal(JSON.parse(get.body).error.code, code)
      const post = await request(port, { method: 'POST', path: admin.ADMIN_PAIR_ROUTE, headers: sameOrigin(port), body: { role: 'web' } })
      assert.equal(post.status, status)
      assert.equal(JSON.parse(post.body).error.code, code)
      assert.equal(seen.length, before, 'a rejected request must not reach the gateway')
    } finally {
      await closeServer(server)
    }
  }
})

test('GET status relays the gateway payload and adds the live config', async () => {
  const res = await request(adminPort, { method: 'GET', path: admin.ADMIN_STATUS_ROUTE })
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.gatewayReachable, true)
  assert.equal(body.gatewayStatus, 200)
  assert.equal(body.viaGateway, false)
  assert.equal(body.gateway.pairing.code, 'TESTCODE', 'the operator sees the live pairing code')
  assert.equal(body.gateway.devices[0].id, 'dev-1')
  assert.ok(body.config.values, 'config.values present')
  assert.ok(body.config.sources, 'config.sources present')
  assert.equal(body.config.values.lang, 'zh')
})

test('a via-gateway caller may read status (pairing stripped) but never POST', async () => {
  const via = { 'x-zen-remote-via': 'gateway' }
  const res = await request(adminPort, { method: 'GET', path: admin.ADMIN_STATUS_ROUTE, headers: via })
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.viaGateway, true)
  assert.equal(body.gateway.pairing, null, 'the live pairing code must not reach a remote device')
  assert.equal(body.gateway.devices.length, 1, 'the rest of the status payload is untouched')

  const before = seen.length
  const posts = [
    { path: admin.ADMIN_PAIR_ROUTE, body: { role: 'web' } },
    { path: admin.ADMIN_ACTION_ROUTE, body: { action: 'revoke-all' } },
    { path: admin.ADMIN_PUSH_TEST_ROUTE, body: {} },
  ]
  for (const p of posts) {
    const r = await request(adminPort, { method: 'POST', path: p.path, headers: { ...via, ...sameOrigin(adminPort) }, body: p.body })
    assert.equal(r.status, 403, `${p.path} must refuse a via-gateway POST`)
    assert.equal(JSON.parse(r.body).error.code, 'via-gateway')
  }
  assert.equal(seen.length, before, 'no via-gateway POST may reach the gateway')
})

test('POST pair forwards to the gateway as the local machine', async () => {
  const before = seen.length
  const res = await request(adminPort, { method: 'POST', path: admin.ADMIN_PAIR_ROUTE, headers: sameOrigin(adminPort), body: { role: 'desktop-client' } })
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).ok, true)
  assert.equal(JSON.parse(res.body).role, 'desktop-client', 'the gateway answer relays verbatim')
  assert.equal(seen.length, before + 1)
  const call = seen[seen.length - 1]
  assert.equal(call.method, 'POST')
  assert.equal(call.url, '/lan-gate/pair')
  assert.equal(JSON.parse(call.body).role, 'desktop-client')
  const headerNames = Object.keys(call.headers)
  assert.equal(headerNames.filter((k) => k.startsWith('x-forwarded')).length, 0, 'no X-Forwarded-* may leak into the gateway call')
  assert.equal(call.headers.origin, undefined, 'the gateway call carries no browser Origin')
  assert.equal(call.headers.cookie, undefined, 'the gateway call carries no browser cookie')
})

test('POST action forwards only whitelisted verbs', async () => {
  const headers = sameOrigin(adminPort)
  const ok = await request(adminPort, { method: 'POST', path: admin.ADMIN_ACTION_ROUTE, headers, body: { action: 'set-role', id: 'dev-1', role: 'desktop-client' } })
  assert.equal(ok.status, 200)
  assert.equal(JSON.parse(ok.body).ok, true)
  const forwarded = seen[seen.length - 1]
  assert.equal(forwarded.url, '/lan-gate/action')
  assert.equal(JSON.parse(forwarded.body).action, 'set-role')

  for (const action of ['new-code', 'foo']) {
    const before = seen.length
    const bad = await request(adminPort, { method: 'POST', path: admin.ADMIN_ACTION_ROUTE, headers, body: { action, id: 'dev-1' } })
    assert.equal(bad.status, 400, `${action} must be refused locally`)
    assert.equal(JSON.parse(bad.body).error.code, 'bad-action')
    assert.equal(seen.length, before, `${action} must not be forwarded`)
  }
})

test('POST push-test sends the fixed copy through the gateway', async () => {
  const res = await request(adminPort, { method: 'POST', path: admin.ADMIN_PUSH_TEST_ROUTE, headers: sameOrigin(adminPort) })
  assert.equal(res.status, 200)
  const sent = seen[seen.length - 1]
  assert.equal(sent.url, '/pwa/push/send')
  const payload = JSON.parse(sent.body)
  assert.equal(payload.title, 'DSH 测试推送')
  assert.equal(payload.body, '这是一条来自 dsh-zen-remote 设置页的测试通知')
  assert.equal(payload.tag, 'dsh-zen-remote-test')
})

test('push-test copy follows the live config lang, not an apply-time snapshot', async () => {
  let lang = 'zh'
  const { server, port } = await startAdminServer({
    admit: () => ({ peer: {} }),
    gatewayBase: `http://127.0.0.1:${gwPort}`,
    getConfig: () => ({ values: { role: 'host', port: gwPort, lang }, sources: {} }),
  })
  try {
    const zh = await request(port, { method: 'POST', path: admin.ADMIN_PUSH_TEST_ROUTE, headers: sameOrigin(port) })
    assert.equal(zh.status, 200)
    assert.equal(JSON.parse(seen[seen.length - 1].body).title, 'DSH 测试推送')

    // The SAME handler instance: only the row config's lang changed between
    // the two requests — the copy must flip with it (T14-fix item 2).
    lang = 'en'
    const en = await request(port, { method: 'POST', path: admin.ADMIN_PUSH_TEST_ROUTE, headers: sameOrigin(port) })
    assert.equal(en.status, 200)
    const payloadEn = JSON.parse(seen[seen.length - 1].body)
    assert.equal(payloadEn.title, 'DSH Test Push')
    assert.equal(payloadEn.tag, 'dsh-zen-remote-test')
  } finally {
    await closeServer(server)
  }
})

test('bad request bodies are refused before any forward', async () => {
  const headers = sameOrigin(adminPort)
  const cases = [
    { name: 'not JSON', body: 'not json' },
    { name: 'array body', body: '[1,2]' },
    { name: 'oversize body', body: JSON.stringify({ pad: 'x'.repeat(17 * 1024) }) },
  ]
  for (const c of cases) {
    const before = seen.length
    const res = await request(adminPort, { method: 'POST', path: admin.ADMIN_PAIR_ROUTE, headers, body: c.body })
    assert.equal(res.status, 400, c.name)
    assert.equal(JSON.parse(res.body).error.code, 'bad-request', c.name)
    assert.equal(seen.length, before, c.name)
  }
})

test('a cross-site POST is refused before any forward', async () => {
  const before = seen.length
  const res = await request(adminPort, { method: 'POST', path: admin.ADMIN_PAIR_ROUTE, headers: { 'sec-fetch-site': 'cross-site' }, body: { role: 'web' } })
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).error.code, 'origin-rejected')
  assert.equal(seen.length, before)
})

test('an unreachable gateway degrades per route', async () => {
  // A port that was listening a moment ago and is closed now: connection
  // refused, deterministically, without waiting out the 5s timeout.
  const dead = http.createServer()
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
  const deadPort = dead.address().port
  await new Promise((resolve) => dead.close(resolve))

  const { server, port } = await startAdminServer(makeOptions(gwPort, { gatewayBase: `http://127.0.0.1:${deadPort}` }))
  try {
    const status = await request(port, { method: 'GET', path: admin.ADMIN_STATUS_ROUTE })
    assert.equal(status.status, 200)
    const body = JSON.parse(status.body)
    assert.equal(body.ok, true)
    assert.equal(body.gateway, null)
    assert.equal(body.gatewayReachable, false)
    assert.equal(body.gatewayStatus, null, 'no HTTP answer means no status code to report')
    assert.ok(body.config.values, 'config still present when the gateway is down')

    const pair = await request(port, { method: 'POST', path: admin.ADMIN_PAIR_ROUTE, headers: sameOrigin(port), body: { role: 'web' } })
    assert.equal(pair.status, 502)
    assert.equal(JSON.parse(pair.body).error.code, 'gateway-unreachable')
  } finally {
    await closeServer(server)
  }
})

test('a gateway error reply is an error, not "reachable"', async () => {
  // The gateway answered, but in the language of refusals: status gets 403,
  // everything else 500 (T14-fix item 1).
  const refusing = http.createServer((req, res) => {
    const url = String(req.url).split('?')[0]
    if (url === '/lan-gate/status') { sendJson(res, 403, { ok: false }); return }
    sendJson(res, 500, { ok: false })
  })
  await new Promise((resolve) => refusing.listen(0, '127.0.0.1', resolve))
  const { server, port } = await startAdminServer(makeOptions(gwPort, { gatewayBase: `http://127.0.0.1:${refusing.address().port}` }))
  try {
    const status = await request(port, { method: 'GET', path: admin.ADMIN_STATUS_ROUTE })
    assert.equal(status.status, 200)
    const body = JSON.parse(status.body)
    assert.equal(body.gateway, null, 'a 403 status payload must not reach the browser as gateway state')
    assert.equal(body.gatewayReachable, false)
    assert.equal(body.gatewayStatus, 403, 'the refusal status is reported for the frontend hint')

    const pair = await request(port, { method: 'POST', path: admin.ADMIN_PAIR_ROUTE, headers: sameOrigin(port), body: { role: 'web' } })
    assert.equal(pair.status, 502)
    const err = JSON.parse(pair.body).error
    assert.equal(err.code, 'gateway-error')
    assert.equal(err.status, 500)
  } finally {
    await closeServer(server)
    await closeServer(refusing)
  }
})

test('a gateway that answers non-JSON counts as unreachable', async () => {
  const raw = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<html>not the admin api</html>')
  })
  await new Promise((resolve) => raw.listen(0, '127.0.0.1', resolve))
  const { server, port } = await startAdminServer(makeOptions(gwPort, { gatewayBase: `http://127.0.0.1:${raw.address().port}` }))
  try {
    const status = await request(port, { method: 'GET', path: admin.ADMIN_STATUS_ROUTE })
    assert.equal(status.status, 200)
    const body = JSON.parse(status.body)
    assert.equal(body.gateway, null)
    assert.equal(body.gatewayReachable, false)
    assert.equal(body.gatewayStatus, null)

    const pair = await request(port, { method: 'POST', path: admin.ADMIN_PAIR_ROUTE, headers: sameOrigin(port), body: { role: 'web' } })
    assert.equal(pair.status, 502)
    assert.equal(JSON.parse(pair.body).error.code, 'gateway-unreachable')
  } finally {
    await closeServer(server)
    await closeServer(raw)
  }
})

test('a gateway that never answers times out at the injected timeout', async () => {
  const silent = http.createServer(() => { /* hold every request open, answer nothing */ })
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve))
  try {
    const { server, port } = await startAdminServer(makeOptions(gwPort, { gatewayBase: `http://127.0.0.1:${silent.address().port}`, timeoutMs: 200 }))
    try {
      const status = await request(port, { method: 'GET', path: admin.ADMIN_STATUS_ROUTE })
      assert.equal(status.status, 200)
      const body = JSON.parse(status.body)
      assert.equal(body.gateway, null)
      assert.equal(body.gatewayReachable, false)
      assert.equal(body.gatewayStatus, null)

      const pair = await request(port, { method: 'POST', path: admin.ADMIN_PAIR_ROUTE, headers: sameOrigin(port), body: { role: 'web' } })
      assert.equal(pair.status, 502)
      assert.equal(JSON.parse(pair.body).error.code, 'gateway-unreachable')
    } finally {
      await closeServer(server)
    }
  } finally {
    await closeServer(silent)
  }
})

test('a declared oversized body is refused before reading', async () => {
  const before = seen.length
  // Content-Length declares 5 MiB; no bytes are ever written. The handler
  // must answer from the header alone (T14-fix item 3) — reading first would
  // leave the client waiting on a body the server refuses to consume.
  const res = await request(adminPort, {
    method: 'POST',
    path: admin.ADMIN_PAIR_ROUTE,
    headers: { ...sameOrigin(adminPort), 'content-length': String(5 * 1024 * 1024) },
  })
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.body).error.code, 'bad-request')
  assert.equal(seen.length, before)
})
