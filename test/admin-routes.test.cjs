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
const { request, startResetServer } = require('./util.cjs')

const ADMIN_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'admin-routes.js')).href

function sendJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(bytes.length) })
  res.end(bytes)
}

/** The gateway's GET /lan-gate/status answer, pairing code live and the
 * GW-5 untrusted-proxy detection set. */
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
    lastForwardedSource: { ip: '198.51.100.7', at: 1698249600000 },
    lastWebClaim: { id: 'dev-1', secure: true, at: 1698249660000 },
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
  server.closeAllConnections?.()
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
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [503, 'service-unavailable']]) {
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
  assert.deepEqual(body.gateway.lastForwardedSource, { ip: '198.51.100.7', at: 1698249600000 }, 'the local operator sees the untrusted-proxy detection (GW-fix-2/L1)')
  assert.deepEqual(body.gateway.lastWebClaim, { id: 'dev-1', secure: true, at: 1698249660000 }, 'the local operator sees the web-claim record (GW-9)')
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
  assert.equal(body.gateway.lastForwardedSource, null, 'the untrusted-proxy detection must not reach a remote device either (GW-fix-2/L1)')
  assert.equal(body.gateway.lastWebClaim, null, 'the web-claim record must not reach a remote device either (GW-9)')
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
  const reset = await startResetServer()
  const { server, port } = await startAdminServer(makeOptions(gwPort, { gatewayBase: `http://127.0.0.1:${reset.port}` }))
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
    await reset.close()
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

// ---- T33a: shares routes ----------------------------------------------------------
//
// These routes are host-native: the table, the typert lookup and the agent
// roster are injected options, so the mock gateway above stays untouched.
// Each test builds its own handler over a fresh store (the module-level
// admin server deliberately has none — the 404 degradation is itself a test).

const { createShareStore } = require('../lib/share-store.js')

/** A shares-capable handler plus its seams. `projection: null` answers the
 * "no such live session" projection; `failTitles` makes those sessions'
 * lookup throw (title null on GET, 502 on share); `subagentIdentity` plants
 * a `values.subagent` in every projection (the dsh-subagent identity object,
 * or null — the no-descriptor answer); `hang` makes invoke wait forever —
 * honouring its cancellation signal, like the real gateway; `sessionHeaders`
 * mounts a sessionQuery fake answering those headers (null = not found,
 * mirroring observeSession's throw), each lease recording its release. */
function makeShareParts(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-admin-shares-'))
  const store = createShareStore({ file: path.join(home, 'shares.json'), idleHours: 48 })
  const invokes = []
  const released = []
  let inFlightProjections = 0
  let maxInFlightProjections = 0
  let syncListThrown = false
  const typert = {
    invoke: (call) => {
      invokes.push(call)
      if (call.namespace === 'session' && call.method === 'list' && overrides.syncListErrorOnce && !syncListThrown) {
        syncListThrown = true
        throw overrides.syncListErrorOnce
      }
      return (async () => {
        if (overrides.hang) {
          return new Promise((_, reject) => {
            call.signal?.addEventListener('abort', () => reject(call.signal.reason))
          })
        }
        if (call.namespace === 'session' && call.method === 'list') {
          if (overrides.onList) return await overrides.onList(call, store)
          if (overrides.listError) throw overrides.listError
          if ('listRaw' in overrides) return overrides.listRaw
          if (overrides.sessionListItems !== undefined) {
            const items = typeof overrides.sessionListItems === 'function'
              ? overrides.sessionListItems(store)
              : overrides.sessionListItems
            return { items }
          }
          const failSet = new Set(overrides.failTitles ?? [])
          return {
            items: store.list()
              .filter((entry) => !failSet.has(entry.sessionId))
              .map((entry) => ({
                sessionId: entry.sessionId,
                projections: {
                  values: {
                    title: `title of ${entry.sessionId}`,
                  },
                },
              })),
          }
        }
        inFlightProjections += 1
        if (inFlightProjections > maxInFlightProjections) maxInFlightProjections = inFlightProjections
        try {
          if (overrides.onProjection) return await overrides.onProjection(call)
          if (overrides.projection === null) return null
          const sessionId = call.args.request.sessionId
          if (overrides.failTitles !== undefined && overrides.failTitles.includes(sessionId)) {
            throw new Error('projection blew up')
          }
          return {
            asOfSeq: 1,
            values: {
              title: `title of ${sessionId}`,
              ...(overrides.subagentIdentity === undefined ? {} : { subagent: overrides.subagentIdentity }),
            },
          }
        } finally {
          inFlightProjections -= 1
        }
      })()
    },
  }
  const sessionQuery = overrides.sessionHeaders === undefined ? undefined : {
    observeSession: async (sessionId) => {
      const header = overrides.sessionHeaders[sessionId]
      if (header === null) throw Object.assign(new Error('no such session'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
      let releasedOnce = false
      return {
        header,
        [Symbol.dispose]() {
          if (!releasedOnce) released.push(sessionId)
          releasedOnce = true
        },
      }
    },
  }
  const options = {
    admit: overrides.admit || (() => ({ peer: {} })),
    gatewayBase: `http://127.0.0.1:${gwPort}`,
    getConfig: () => ({ values: { role: 'host', port: gwPort, lang: 'zh' }, sources: {} }),
    store,
    typert: overrides.typertThrows
      ? () => { throw new Error('typert lookup blew up') }
      : overrides.noTypert ? () => undefined : () => typert,
    listAgents: () => (overrides.roster !== undefined ? overrides.roster : []),
    ...(sessionQuery !== undefined ? { sessionQuery: () => sessionQuery } : {}),
    ...(overrides.viewerCount !== undefined ? { viewerCount: overrides.viewerCount } : {}),
    ...(overrides.projectionTimeoutMs !== undefined ? { projectionTimeoutMs: overrides.projectionTimeoutMs } : {}),
  }
  return {
    store,
    invokes,
    released,
    options,
    get maxInFlightProjections() { return maxInFlightProjections },
    cleanup() { fs.rmSync(home, { recursive: true, force: true }) },
  }
}

async function startShareServer(options) {
  return startAdminServer(options)
}

test('GET shares lists every row with derived fields; busy Infinity serializes as null', async () => {
  const parts = makeShareParts()
  parts.store.share('s-idle')
  parts.store.share('s-busy')
  parts.store.setBusy('s-busy', true)
  const { server, port } = await startShareServer(parts.options)
  try {
    const res = await request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.deepEqual(
      [...body.shares.map((s) => s.sessionId)].sort(),
      ['s-busy', 's-idle'],
      'both rows listed (order is sharedAt-ascending and clock-dependent here)',
    )
    const idle = body.shares.find((s) => s.sessionId === 's-idle')
    const busy = body.shares.find((s) => s.sessionId === 's-busy')
    assert.equal(typeof idle.sharedAt, 'number')
    assert.equal(typeof idle.lastActivityAt, 'number')
    assert.equal(idle.busy, false)
    assert.equal(typeof idle.remainingMs, 'number', 'an idle session reports a finite countdown')
    assert.ok(idle.remainingMs > 0)
    assert.equal(idle.viewers, 0, 'viewers default to zero without an injected counter')
    assert.equal(idle.title, 'title of s-idle')
    assert.equal(busy.busy, true)
    assert.equal(busy.remainingMs, null, 'busy means Infinity in the table, null on the wire')
    // Primary path (Issue #61): a single session/list summary call with
    // `{ _request: {} }` and zero cold-read session/projections calls.
    assert.deepEqual(
      parts.invokes.map((c) => ({ namespace: c.namespace, method: c.method, args: c.args })),
      [{ namespace: 'session', method: 'list', args: { _request: {} } }],
    )
  } finally {
    await closeServer(server)
    parts.cleanup()
  }
})

test('GET shares: one failed title lookup is null and never fails the listing', async () => {
  const parts = makeShareParts({ failTitles: ['s-boom'] })
  parts.store.share('s-ok')
  parts.store.share('s-boom')
  const { server, port } = await startShareServer(parts.options)
  try {
    const res = await request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.shares.find((s) => s.sessionId === 's-ok').title, 'title of s-ok')
    assert.equal(body.shares.find((s) => s.sessionId === 's-boom').title, null)
  } finally {
    await closeServer(server)
  }
})

test('GET shares: an injected viewerCount is consulted per session, a missing typert leaves titles null', async () => {
  const parts = makeShareParts({ noTypert: true, viewerCount: (id) => (id === 's-1' ? 2 : 0) })
  parts.store.share('s-1')
  parts.store.share('s-2')
  const { server, port } = await startShareServer(parts.options)
  try {
    const res = await request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.shares.find((s) => s.sessionId === 's-1').viewers, 2)
    assert.equal(body.shares.find((s) => s.sessionId === 's-2').viewers, 0)
    assert.equal(body.shares.find((s) => s.sessionId === 's-1').title, null, 'no typert gateway, no titles')
    assert.equal(parts.invokes.length, 0)
  } finally {
    await closeServer(server)
  }
})

test('POST share: a live session joins the table; a null projection is 404 no-session', async () => {
  const ok = makeShareParts()
  {
    const { server, port } = await startShareServer(ok.options)
    try {
      const res = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'share', sessionId: 's-live' } })
      assert.equal(res.status, 200)
      assert.deepEqual(JSON.parse(res.body), { ok: true })
      assert.equal(ok.store.isShared('s-live'), true)
      assert.equal(ok.invokes.length, 1, 'the existence check went through projections')
    } finally { await closeServer(server) }
  }
  const gone = makeShareParts({ projection: null })
  {
    const { server, port } = await startShareServer(gone.options)
    try {
      const res = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'share', sessionId: 's-ghost' } })
      assert.equal(res.status, 404)
      assert.equal(JSON.parse(res.body).error.code, 'no-session')
      assert.equal(gone.store.isShared('s-ghost'), false, 'nothing entered the table')
    } finally { await closeServer(server) }
  }
})

test('POST share: a failed lookup is 502, and a successful share restores busy from the roster', async () => {
  const broken = makeShareParts({ failTitles: ['s-1'] })
  {
    const { server, port } = await startShareServer(broken.options)
    try {
      const res = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'share', sessionId: 's-1' } })
      assert.equal(res.status, 502, 'a projection failure is not a "no such session" answer')
      assert.equal(JSON.parse(res.body).error.code, 'gateway-unreachable')
      assert.equal(broken.store.isShared('s-1'), false)
    } finally { await closeServer(server) }
  }
  const running = makeShareParts({ roster: [{ id: 's-new', status: 'running' }, { id: 's-other', status: 'idle' }] })
  {
    const { server, port } = await startShareServer(running.options)
    try {
      const res = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'share', sessionId: 's-new' } })
      assert.equal(res.status, 200)
      const row = running.store.list().find((e) => e.sessionId === 's-new')
      assert.equal(row.busy, true, 'a session whose agent is mid-turn is marked busy right after share')
      assert.equal(running.store.isShared('s-other'), false, 'the rest of the roster is none of the route\'s business')
    } finally { await closeServer(server) }
  }
})

test('POST share without a typert gateway still works, trusting the table alone', async () => {
  const parts = makeShareParts({ noTypert: true })
  const { server, port } = await startShareServer(parts.options)
  try {
    const res = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'share', sessionId: 's-blind' } })
    assert.equal(res.status, 200)
    assert.equal(parts.store.isShared('s-blind'), true)
    assert.equal(parts.invokes.length, 0)
  } finally { await closeServer(server) }
})

test('POST share refuses a subagent session: the projection identity object is 400 subagent-session, null is not', async () => {
  // No sessionQuery on this composition: the projection identity is the only
  // signal left. dsh-subagent's projection answers the identity OBJECT for a
  // child, and null when no valid descriptor exists — null is what an
  // ordinary session carries, so only the object shape may refuse.
  const child = makeShareParts({ subagentIdentity: { mode: 'continuable', label: 'explorer', seq: 12 } })
  {
    const { server, port } = await startShareServer(child.options)
    try {
      const res = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'share', sessionId: 's-child' } })
      assert.equal(res.status, 400)
      assert.equal(JSON.parse(res.body).error.code, 'subagent-session')
      assert.equal(child.store.isShared('s-child'), false, 'a child never enters the table')
    } finally { await closeServer(server) }
  }
  const plain = makeShareParts({ subagentIdentity: null })
  {
    const { server, port } = await startShareServer(plain.options)
    try {
      const res = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'share', sessionId: 's-plain' } })
      assert.equal(res.status, 200, 'subagent: null means no descriptor — an ordinary session')
      assert.equal(plain.store.isShared('s-plain'), true)
    } finally { await closeServer(server) }
  }
})

test('POST share judges subagent sessions off the session HEADER first (T33a2)', async () => {
  // A FORK of a subagent session: its header has no origin (an ordinary
  // user-created session), but forking replayed the source's
  // subagent/descriptor events, so the projection still carries an identity.
  // The header is authoritative — share must succeed.
  const fork = makeShareParts({
    subagentIdentity: { mode: 'continuable', label: 'inherited descriptor', seq: 99 },
    sessionHeaders: { 's-fork-of-child': { version: 4, id: 's-fork-of-child', isSeeded: true, parentSession: 'some-child' } },
  })
  {
    const { server, port } = await startShareServer(fork.options)
    try {
      const res = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'share', sessionId: 's-fork-of-child' } })
      assert.equal(res.status, 200, 'a fork is ordinary no matter what its inherited projection says')
      assert.equal(fork.store.isShared('s-fork-of-child'), true)
      assert.deepEqual(fork.released, ['s-fork-of-child'], 'the observation lease is released after the read')
    } finally { await closeServer(server) }
  }
  // A real child: header origin 'subagent' → 400, even though the
  // (descriptor-corrupt) projection answers null.
  const child = makeShareParts({
    subagentIdentity: null,
    sessionHeaders: { 's-child': { version: 4, id: 's-child', origin: 'subagent', parentSession: 'p' } },
  })
  {
    const { server, port } = await startShareServer(child.options)
    try {
      const res = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'share', sessionId: 's-child' } })
      assert.equal(res.status, 400)
      assert.equal(JSON.parse(res.body).error.code, 'subagent-session')
      assert.equal(child.store.isShared('s-child'), false)
    } finally { await closeServer(server) }
  }
  // Header unreadable (session gone between the two lookups): fall back to
  // the projection identity.
  const degraded = makeShareParts({
    subagentIdentity: { mode: 'one-shot', seq: 3 },
    sessionHeaders: { 's-vanished': null },
  })
  {
    const { server, port } = await startShareServer(degraded.options)
    try {
      const res = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'share', sessionId: 's-vanished' } })
      assert.equal(res.status, 400, 'with no header to read, the projection identity still refuses a child')
      assert.equal(degraded.store.isShared('s-vanished'), false)
    } finally { await closeServer(server) }
  }
})

test('a hung projections call times out per call: titles go null on GET, share refuses with 502', async () => {
  const parts = makeShareParts({ hang: true, projectionTimeoutMs: 30 })
  parts.store.share('s-1')
  const { server, port } = await startShareServer(parts.options)
  try {
    const startedAt = Date.now()
    const get = await request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
    assert.equal(get.status, 200, 'the listing survives a hung title lookup')
    const body = JSON.parse(get.body)
    assert.equal(body.shares.find((s) => s.sessionId === 's-1').title, null, 'the timed-out title is null')
    assert.ok(Date.now() - startedAt < 2000, 'the 30ms timeout — not a 5s default — freed the listing')

    const post = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'share', sessionId: 's-new' } })
    assert.equal(post.status, 502, 'an existence check that cannot answer is a refusal, not a silent share')
    assert.equal(JSON.parse(post.body).error.code, 'gateway-unreachable')
    assert.equal(parts.store.isShared('s-new'), false)
  } finally { await closeServer(server) }
})

test('POST unshare and unshare-all leave the table with reason manual', async () => {
  const parts = makeShareParts()
  parts.store.share('s-1')
  parts.store.share('s-2')
  const reasons = []
  parts.store.subscribe((event) => { if (event.type === 'unshared') reasons.push([event.sessionId, event.reason]) })
  const { server, port } = await startShareServer(parts.options)
  try {
    const one = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'unshare', sessionId: 's-1' } })
    assert.equal(one.status, 200)
    assert.equal(parts.store.isShared('s-1'), false)
    assert.equal(parts.store.isShared('s-2'), true)

    const all = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'unshare-all' } })
    assert.equal(all.status, 200)
    assert.deepEqual(parts.store.list(), [])
    assert.deepEqual(reasons, [['s-1', 'manual'], ['s-2', 'manual']], 'both closes are manual server-side acts')
  } finally { await closeServer(server) }
})

test('POST shares refuses unknown actions and missing session ids before touching the table', async () => {
  const parts = makeShareParts()
  const { server, port } = await startShareServer(parts.options)
  try {
    const bad = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'unshare-everything' } })
    assert.equal(bad.status, 400)
    assert.equal(JSON.parse(bad.body).error.code, 'bad-action')

    const noId = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'share' } })
    assert.equal(noId.status, 400)
    assert.equal(JSON.parse(noId.body).error.code, 'bad-request')

    const emptyId = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'unshare', sessionId: '' } })
    assert.equal(emptyId.status, 400)

    assert.deepEqual(parts.store.list(), [], 'the table never moved')
  } finally { await closeServer(server) }
})

test('shares routes admit gateway-forwarded requests: a via-gateway device may list and toggle', async () => {
  const parts = makeShareParts()
  const { server, port } = await startShareServer(parts.options)
  try {
    // The shape the gateway forwards: its own via marker plus Origin/Host
    // rewritten onto the upstream origin — which passes sameOriginPost.
    const viaHeaders = { 'x-zen-remote-via': 'gateway', ...sameOrigin(port) }
    const get = await request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE, headers: viaHeaders })
    assert.equal(get.status, 200)
    assert.equal(JSON.parse(get.body).ok, true)

    const post = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: viaHeaders, body: { action: 'share', sessionId: 's-remote' } })
    assert.equal(post.status, 200, 'the marker wall does NOT apply to the shares route')
    assert.equal(parts.store.isShared('s-remote'), true)
  } finally { await closeServer(server) }
})

test('shares routes still apply admit and same-origin', async () => {
  const denied = makeShareParts({ admit: () => ({ rejection: 401 }) })
  {
    const { server, port } = await startShareServer(denied.options)
    try {
      const get = await request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
      assert.equal(get.status, 401)
      const post = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'unshare-all' } })
      assert.equal(post.status, 401)
    } finally { await closeServer(server) }
  }
  const parts = makeShareParts()
  const { server, port } = await startShareServer(parts.options)
  try {
    const cross = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: { 'sec-fetch-site': 'cross-site' }, body: { action: 'unshare-all' } })
    assert.equal(cross.status, 403)
    assert.equal(JSON.parse(cross.body).error.code, 'origin-rejected')
    assert.deepEqual(parts.store.list(), [])
  } finally { await closeServer(server) }
})

test('without a store the shares routes answer 404 like any unknown admin path', async () => {
  const { server, port } = await startAdminServer(makeOptions(gwPort))
  try {
    const get = await request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
    assert.equal(get.status, 404)
    const post = await request(port, { method: 'POST', path: admin.ADMIN_SHARES_ROUTE, headers: sameOrigin(port), body: { action: 'share', sessionId: 's' } })
    assert.equal(post.status, 404)
  } finally { await closeServer(server) }
})

function defer() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('GET shares (Issue #61 case 1): 10+ shared sessions use single session/list and zero session/projections', async (t) => {
  const parts = makeShareParts({ viewerCount: (id) => (id === 's-0' ? 4 : 0) })
  t.after(() => parts.cleanup())
  for (let i = 0; i < 12; i += 1) parts.store.share(`s-${i}`)
  parts.store.setBusy('s-0', true)
  const { server, port } = await startShareServer(parts.options)
  t.after(() => closeServer(server))

  const res = await request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.shares.length, 12)
  assert.equal(body.shares.find((s) => s.sessionId === 's-0').busy, true)
  assert.equal(body.shares.find((s) => s.sessionId === 's-0').remainingMs, null)
  assert.equal(body.shares.find((s) => s.sessionId === 's-0').viewers, 4)
  for (let i = 0; i < 12; i += 1) {
    assert.equal(body.shares.find((s) => s.sessionId === `s-${i}`).title, `title of s-${i}`)
  }
  const listCalls = parts.invokes.filter((c) => c.namespace === 'session' && c.method === 'list')
  const projCalls = parts.invokes.filter((c) => c.namespace === 'session' && c.method === 'projections')
  assert.equal(listCalls.length, 1)
  assert.deepEqual(listCalls[0].args, { _request: {} })
  assert.equal(projCalls.length, 0)
})

test('GET shares (Issue #61 case 2): explicit title: null in session/list is preserved with zero projection fallbacks', async (t) => {
  const parts = makeShareParts({
    sessionListItems: [
      { sessionId: 's-unnamed', projections: { values: { title: null } } },
      { sessionId: 's-named', projections: { values: { title: 'Named Session' } } },
    ],
  })
  t.after(() => parts.cleanup())
  parts.store.share('s-unnamed')
  parts.store.share('s-named')
  const { server, port } = await startShareServer(parts.options)
  t.after(() => closeServer(server))

  const res = await request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.shares.find((s) => s.sessionId === 's-unnamed').title, null)
  assert.equal(body.shares.find((s) => s.sessionId === 's-named').title, 'Named Session')
  assert.equal(parts.invokes.filter((c) => c.namespace === 'session' && c.method === 'list').length, 1)
  assert.equal(parts.invokes.filter((c) => c.namespace === 'session' && c.method === 'projections').length, 0)
})

test('GET shares (Issue #61 case 3): partial missing summaries fall back only for missing rows with concurrency <= 3', async (t) => {
  const missingIds = new Set()
  const items = []
  for (let i = 0; i < 20; i += 1) {
    items.push({ sessionId: `s-hit-${i}`, projections: { values: { title: `hit ${i}` } } })
  }
  items.push({ sessionId: 's-null-0', projections: { values: { title: null } } })
  items.push({ sessionId: 's-null-1', projections: { values: { title: null } } })
  for (let i = 0; i < 4; i += 1) {
    const id = `s-no-proj-${i}`
    missingIds.add(id)
    items.push({ sessionId: id })
  }
  for (let i = 0; i < 4; i += 1) {
    const id = `s-no-key-${i}`
    missingIds.add(id)
    items.push({ sessionId: id, projections: { values: {} } })
  }
  for (let i = 0; i < 4; i += 1) {
    missingIds.add(`s-absent-${i}`)
  }

  const parts = makeShareParts({
    sessionListItems: items,
    onProjection: async (call) => {
      await new Promise((r) => setTimeout(r, 15))
      return { asOfSeq: 1, values: { title: `fallback ${call.args.request.sessionId}` } }
    },
  })
  t.after(() => parts.cleanup())
  for (const item of items) parts.store.share(item.sessionId)
  for (let i = 0; i < 4; i += 1) parts.store.share(`s-absent-${i}`)

  const { server, port } = await startShareServer(parts.options)
  t.after(() => closeServer(server))

  const res = await request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.shares.length, 34)
  assert.equal(body.shares.find((s) => s.sessionId === 's-hit-5').title, 'hit 5')
  assert.equal(body.shares.find((s) => s.sessionId === 's-null-0').title, null)
  assert.equal(body.shares.find((s) => s.sessionId === 's-absent-2').title, 'fallback s-absent-2')

  const projCalls = parts.invokes.filter((c) => c.namespace === 'session' && c.method === 'projections')
  const calledIds = projCalls.map((c) => c.args.request.sessionId).sort()
  assert.deepEqual(calledIds, [...missingIds].sort())
  assert.ok(parts.maxInFlightProjections >= 1 && parts.maxInFlightProjections <= 3, `expected max concurrency in [1,3], got ${parts.maxInFlightProjections}`)
})

test('GET shares (Issue #61 case 4): session/list error or invalid shape degrades to capped fallback without failing listing', async (t) => {
  const errParts = makeShareParts({
    listError: new Error('unsupported'),
    failTitles: ['s-3'],
    onProjection: async (call) => {
      await new Promise((r) => setTimeout(r, 15))
      if (call.args.request.sessionId === 's-3') throw new Error('boom')
      return { asOfSeq: 1, values: { title: `fb-${call.args.request.sessionId}` } }
    },
  })
  t.after(() => errParts.cleanup())
  for (let i = 0; i < 7; i += 1) errParts.store.share(`s-${i}`)
  const errSrv = await startShareServer(errParts.options)
  t.after(() => closeServer(errSrv.server))

  const res1 = await request(errSrv.port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  assert.equal(res1.status, 200)
  const body1 = JSON.parse(res1.body)
  assert.equal(body1.shares.find((s) => s.sessionId === 's-3').title, null)
  assert.equal(body1.shares.find((s) => s.sessionId === 's-0').title, 'fb-s-0')
  assert.ok(errParts.maxInFlightProjections <= 3, `got ${errParts.maxInFlightProjections}`)

  const badParts = makeShareParts({
    listRaw: {},
    projectionTimeoutMs: 30,
    onProjection: (call) => {
      if (call.args.request.sessionId === 's-hang') {
        return new Promise((_, reject) => {
          call.signal?.addEventListener('abort', () => reject(call.signal.reason))
        })
      }
      return new Promise((r) => setTimeout(() => r({ asOfSeq: 1, values: { title: `ok-${call.args.request.sessionId}` } }), 10))
    },
  })
  t.after(() => badParts.cleanup())
  badParts.store.share('s-hang')
  for (let i = 0; i < 5; i += 1) badParts.store.share(`s-b-${i}`)
  const badSrv = await startShareServer(badParts.options)
  t.after(() => closeServer(badSrv.server))

  const res2 = await request(badSrv.port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  assert.equal(res2.status, 200)
  const body2 = JSON.parse(res2.body)
  assert.equal(body2.shares.find((s) => s.sessionId === 's-hang').title, null)
  assert.equal(body2.shares.find((s) => s.sessionId === 's-b-0').title, 'ok-s-b-0')
  assert.ok(badParts.maxInFlightProjections <= 3, `got ${badParts.maxInFlightProjections}`)

  // Synchronous throw on first session/list must not poison inFlightSummaryList for the next GET.
  const syncParts = makeShareParts({ syncListErrorOnce: new Error('sync boom') })
  t.after(() => syncParts.cleanup())
  syncParts.store.share('s-sync-1')
  const syncSrv = await startShareServer(syncParts.options)
  t.after(() => closeServer(syncSrv.server))

  const syncFirst = await request(syncSrv.port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  assert.equal(syncFirst.status, 200)
  assert.equal(JSON.parse(syncFirst.body).shares[0].title, 'title of s-sync-1')

  const syncSecond = await request(syncSrv.port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  assert.equal(syncSecond.status, 200)
  assert.equal(JSON.parse(syncSecond.body).shares[0].title, 'title of s-sync-1')
  const syncListCalls = syncParts.invokes.filter((c) => c.namespace === 'session' && c.method === 'list')
  const syncProjCalls = syncParts.invokes.filter((c) => c.namespace === 'session' && c.method === 'projections')
  assert.equal(syncListCalls.length, 2, 'second GET must re-invoke session/list instead of reusing settled error')
  assert.equal(syncProjCalls.length, 1, 'only the first failed GET fell back to session/projections')
})

test('GET shares (Issue #61 case 5): empty table and throwing typert short-circuit with zero invokes', async (t) => {
  const emptyParts = makeShareParts()
  t.after(() => emptyParts.cleanup())
  const emptySrv = await startShareServer(emptyParts.options)
  t.after(() => closeServer(emptySrv.server))

  const r1 = await request(emptySrv.port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  assert.equal(r1.status, 200)
  assert.deepEqual(JSON.parse(r1.body), { ok: true, shares: [] })
  assert.equal(emptyParts.invokes.length, 0)

  const throwParts = makeShareParts({ typertThrows: true })
  t.after(() => throwParts.cleanup())
  throwParts.store.share('s-1')
  const throwSrv = await startShareServer(throwParts.options)
  t.after(() => closeServer(throwSrv.server))

  const r2 = await request(throwSrv.port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  assert.equal(r2.status, 200)
  assert.equal(JSON.parse(r2.body).shares[0].title, null)
  assert.equal(throwParts.invokes.length, 0)
})

test('GET shares (Issue #61 case 6): concurrent GETs coalesce session/list, dedup fallback sessionIds, and cap pool <= 3', async (t) => {
  const listGate = defer()
  t.after(() => listGate.resolve())
  let listEntered = 0
  const parts = makeShareParts({
    onList: async () => {
      listEntered += 1
      await listGate.promise
      return {
        items: [{ sessionId: 's-hit', projections: { values: { title: 'Hit' } } }],
      }
    },
    onProjection: async (call) => {
      await new Promise((r) => setTimeout(r, 20))
      return { asOfSeq: 1, values: { title: `fb-${call.args.request.sessionId}` } }
    },
  })
  t.after(() => parts.cleanup())
  parts.store.share('s-hit')
  for (let i = 0; i < 6; i += 1) parts.store.share(`s-miss-${i}`)
  const { server, port } = await startShareServer(parts.options)
  t.after(() => closeServer(server))

  const reqs = Array.from({ length: 4 }, () => request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE }))
  await waitFor(() => listEntered === 1)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(parts.invokes.filter((c) => c.namespace === 'session' && c.method === 'list').length, 1)

  listGate.resolve()
  const responses = await Promise.all(reqs)
  for (const res of responses) {
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.shares.find((s) => s.sessionId === 's-hit').title, 'Hit')
    assert.equal(body.shares.find((s) => s.sessionId === 's-miss-0').title, 'fb-s-miss-0')
  }
  assert.equal(parts.invokes.filter((c) => c.namespace === 'session' && c.method === 'list').length, 1)
  const projCalls = parts.invokes.filter((c) => c.namespace === 'session' && c.method === 'projections')
  assert.equal(projCalls.length, 6, 'each missing sessionId falls back only once across all 4 concurrent GETs')
  assert.ok(parts.maxInFlightProjections <= 3, `expected max concurrency <= 3, got ${parts.maxInFlightProjections}`)

  // Cross-request shared 3-slot semaphore across DISJOINT missing sessionIds.
  const projGates = new Map()
  const enteredIds = []
  t.after(() => { for (const g of projGates.values()) g.resolve() })
  const crossParts = makeShareParts({
    sessionListItems: [],
    onProjection: async (call) => {
      const id = call.args.request.sessionId
      enteredIds.push(id)
      const gate = projGates.get(id)
      if (gate) await gate.promise
      return { asOfSeq: 1, values: { title: `cross-${id}` } }
    },
  })
  t.after(() => crossParts.cleanup())
  for (const id of ['s-a1', 's-a2', 's-a3', 's-b1', 's-b2']) projGates.set(id, defer())
  crossParts.store.share('s-a1')
  crossParts.store.share('s-a2')
  crossParts.store.share('s-a3')
  const crossSrv = await startShareServer(crossParts.options)
  t.after(() => closeServer(crossSrv.server))

  const getA = request(crossSrv.port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  await waitFor(() => enteredIds.length === 3)
  assert.equal(crossParts.maxInFlightProjections, 3)

  // Add disjoint missing sessions and fire a concurrent GET B while all 3 pool slots are occupied.
  crossParts.store.share('s-b1')
  crossParts.store.share('s-b2')
  const getB = request(crossSrv.port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  await waitFor(() => crossParts.invokes.filter((c) => c.namespace === 'session' && c.method === 'list').length === 2)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(enteredIds.length, 3, 'GET B missing sessionIds must queue behind GET A on the shared 3-slot pool')
  assert.equal(crossParts.maxInFlightProjections, 3)

  // Release one slot from GET A -> exactly one of GET B's items enters, still <= 3 in flight.
  projGates.get('s-a1').resolve()
  await waitFor(() => enteredIds.length === 4)
  assert.equal(crossParts.maxInFlightProjections, 3)

  for (const id of ['s-a2', 's-a3', 's-b1', 's-b2']) projGates.get(id).resolve()
  const [resA, resB] = await Promise.all([getA, getB])
  assert.equal(resA.status, 200)
  assert.equal(resB.status, 200)
  const bodyB = JSON.parse(resB.body)
  assert.equal(bodyB.shares.find((s) => s.sessionId === 's-b1').title, 'cross-s-b1')
  assert.equal(bodyB.shares.find((s) => s.sessionId === 's-b2').title, 'cross-s-b2')
  assert.equal(crossParts.maxInFlightProjections, 3)
})

test('GET shares (Issue #61 case 7): POST share/unshare/unshare-all invalidates in-flight session/list and reflects live store', async (t) => {
  const gate1 = defer()
  const gate3 = defer()
  const gate5 = defer()
  t.after(() => { gate1.resolve(); gate3.resolve(); gate5.resolve() })
  let listCount = 0
  const parts = makeShareParts({
    onList: async () => {
      listCount += 1
      if (listCount === 1) {
        await gate1.promise
        return { items: [{ sessionId: 's-1', projections: { values: { title: 'Title 1' } } }] }
      }
      if (listCount === 2) {
        return {
          items: [
            { sessionId: 's-1', projections: { values: { title: 'Title 1' } } },
            { sessionId: 's-new', projections: { values: { title: 'New Title' } } },
          ],
        }
      }
      if (listCount === 3) {
        await gate3.promise
        return { items: [{ sessionId: 's-1', projections: { values: { title: 'Stale' } } }] }
      }
      if (listCount === 4) {
        return { items: [{ sessionId: 's-new', projections: { values: { title: 'Fresh After Unshare' } } }] }
      }
      if (listCount === 5) {
        await gate5.promise
        return { items: [{ sessionId: 's-new', projections: { values: { title: 'Stale Before Unshare All' } } }] }
      }
      return { items: [{ sessionId: 's-after-all', projections: { values: { title: 'Fresh After Unshare All' } } }] }
    },
  })
  t.after(() => parts.cleanup())
  parts.store.share('s-1')
  const { server, port } = await startShareServer(parts.options)
  t.after(() => closeServer(server))

  // 1) GET #1 hangs on gate1 -> POST share(s-new) -> GET #2 immediately resolves with fresh list.
  const get1Promise = request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  await waitFor(() => listCount === 1)

  const postShare = await request(port, {
    method: 'POST',
    path: admin.ADMIN_SHARES_ROUTE,
    headers: sameOrigin(port),
    body: { action: 'share', sessionId: 's-new' },
  })
  assert.equal(postShare.status, 200)

  const get2Res = await request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  assert.equal(get2Res.status, 200)
  assert.equal(listCount, 2, 'GET #2 started a new session/list after POST share invalidated the in-flight one')
  const body2 = JSON.parse(get2Res.body)
  assert.equal(body2.shares.find((s) => s.sessionId === 's-new').title, 'New Title')

  gate1.resolve()
  const get1Res = await get1Promise
  assert.equal(get1Res.status, 200)

  // 2) GET #3 hangs on gate3 -> POST unshare(s-1) -> GET #4 immediately resolves without s-1.
  const get3Promise = request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  await waitFor(() => listCount === 3)

  const postUnshare = await request(port, {
    method: 'POST',
    path: admin.ADMIN_SHARES_ROUTE,
    headers: sameOrigin(port),
    body: { action: 'unshare', sessionId: 's-1' },
  })
  assert.equal(postUnshare.status, 200)

  const get4Res = await request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  assert.equal(get4Res.status, 200)
  assert.equal(listCount, 4)
  const body4 = JSON.parse(get4Res.body)
  assert.deepEqual(body4.shares.map((s) => s.sessionId), ['s-new'])
  assert.equal(body4.shares[0].title, 'Fresh After Unshare')

  gate3.resolve()
  const get3Res = await get3Promise
  assert.equal(get3Res.status, 200)

  // 3) GET #5 hangs on gate5 -> POST unshare-all -> share s-after-all directly in store -> GET #6 starts a fresh list.
  const get5Promise = request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  await waitFor(() => listCount === 5)

  const postUnshareAll = await request(port, {
    method: 'POST',
    path: admin.ADMIN_SHARES_ROUTE,
    headers: sameOrigin(port),
    body: { action: 'unshare-all' },
  })
  assert.equal(postUnshareAll.status, 200)

  parts.store.share('s-after-all')
  const get6Res = await request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  assert.equal(get6Res.status, 200)
  assert.equal(listCount, 6, 'GET #6 started a new session/list after POST unshare-all invalidated the in-flight one')
  const body6 = JSON.parse(get6Res.body)
  assert.deepEqual(body6.shares.map((s) => s.sessionId), ['s-after-all'])
  assert.equal(body6.shares[0].title, 'Fresh After Unshare All')

  gate5.resolve()
  const get5Res = await get5Promise
  assert.equal(get5Res.status, 200)
})

test('GET shares (Issue #61 case 8): aborting one concurrent GET does not cancel shared queries for peers', async (t) => {
  const listGate = defer()
  const projGate = defer()
  t.after(() => { listGate.resolve(); projGate.resolve() })
  let listEntered = 0
  let projEntered = 0
  const parts = makeShareParts({
    onList: async (call) => {
      listEntered += 1
      await listGate.promise
      assert.equal(call.signal?.aborted, false)
      return { items: [{ sessionId: 's-hit', projections: { values: { title: 'Hit' } } }] }
    },
    onProjection: async (call) => {
      projEntered += 1
      await projGate.promise
      assert.equal(call.signal?.aborted, false)
      return { asOfSeq: 1, values: { title: 'Fallback OK' } }
    },
  })
  t.after(() => parts.cleanup())
  parts.store.share('s-hit')
  parts.store.share('s-miss')
  const { server, port } = await startShareServer(parts.options)
  t.after(() => closeServer(server))

  // Disconnect first client while session/list is in flight.
  const rawReq1 = http.request({ host: '127.0.0.1', port, method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  rawReq1.on('error', () => { /* expected ECONNRESET after destroy */ })
  t.after(() => rawReq1.destroy())
  rawReq1.end()
  await waitFor(() => listEntered === 1)

  const peerGet = request(port, { method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  await new Promise((r) => setTimeout(r, 15))
  rawReq1.destroy()
  await new Promise((r) => setTimeout(r, 15))

  listGate.resolve()
  await waitFor(() => projEntered === 1)

  // Also disconnect a second raw client while fallback session/projections is in flight.
  const rawReq2 = http.request({ host: '127.0.0.1', port, method: 'GET', path: admin.ADMIN_SHARES_ROUTE })
  rawReq2.on('error', () => { /* expected ECONNRESET after destroy */ })
  t.after(() => rawReq2.destroy())
  rawReq2.end()
  await new Promise((r) => setTimeout(r, 15))
  rawReq2.destroy()
  await new Promise((r) => setTimeout(r, 15))

  projGate.resolve()
  const peerRes = await peerGet
  assert.equal(peerRes.status, 200)
  const body = JSON.parse(peerRes.body)
  assert.equal(body.shares.find((s) => s.sessionId === 's-hit').title, 'Hit')
  assert.equal(body.shares.find((s) => s.sessionId === 's-miss').title, 'Fallback OK')
})

// ---- PB-5: the plugin bridge listing -------------------------------------------

async function startBridgeAdmin(options) {
  const bridgeAdmin = await import(ADMIN_URL)
  const handler = bridgeAdmin.createAdminHandler(options)
  const server = http.createServer((req, res) => { void handler(req, res) })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

test('PB-5 GET plugin-bridge: shape, order, hasServerScope, and consent read LIVE', async () => {
  const registry = (await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-bridge.js')).href)).createBridgeRegistry()
  registry.register({ plugin: 'zeta-panel', version: '1.0.0', routes: [{ path: '/z/data', scope: 'session' }] })
  registry.register({ plugin: 'acme-tasks', version: '2.0.0', routes: [{ path: '/a/all', scope: 'server' }, { path: '/a/x', scope: 'session' }] })
  const consentBox = { map: { 'acme-tasks': true } }
  const { server, port } = await startBridgeAdmin({
    ...makeOptions(gwPort),
    pluginBridge: { registry, getConsent: () => consentBox.map },
  })
  try {
    const res = await request(port, { method: 'GET', path: '/_dsh/zen-remote/admin/plugin-bridge' })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    // Sorted by plugin name; hasServerScope from the routes; consent verbatim.
    // PB-11: the adapter mark defaults to false on a wiring that passes no
    // `adaptedPlugins` (none of these entries is adapted).
    assert.deepEqual(body.value.plugins, [
      { plugin: 'acme-tasks', version: '2.0.0', hasServerScope: true, consent: true, adapted: false },
      { plugin: 'zeta-panel', version: '1.0.0', hasServerScope: false, consent: false, adapted: false },
    ])

    // The consent read is LIVE: flipping the row-side map (the volatile
    // knob's stand-in) shows up on the very next request, no re-wiring.
    consentBox.map = {}
    const second = JSON.parse((await request(port, { method: 'GET', path: '/_dsh/zen-remote/admin/plugin-bridge' })).body)
    assert.deepEqual(second.value.plugins.map((p) => [p.plugin, p.consent]), [['acme-tasks', false], ['zeta-panel', false]])
  } finally { await closeServer(server) }
})

test('PB-5 GET plugin-bridge: the existing rules hold — via-gateway refused, non-GET 405, unwired 404', async () => {
  const registry = (await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'plugin-bridge.js')).href)).createBridgeRegistry()
  registry.register({ plugin: 'p', version: '1', routes: [{ path: '/p/x', scope: 'session' }] })
  const { server, port } = await startBridgeAdmin({
    ...makeOptions(gwPort),
    pluginBridge: { registry, getConsent: () => ({}) },
  })
  try {
    // The listing feeds a MANAGEMENT surface, so the pair/action rule
    // applies: a forwarded remote request is refused outright.
    const via = await request(port, { method: 'GET', path: '/_dsh/zen-remote/admin/plugin-bridge', headers: { 'x-zen-remote-via': 'gateway' } })
    assert.equal(via.status, 403)
    assert.equal(JSON.parse(via.body).error.code, 'via-gateway')
    // Read-only: anything but GET answers 405.
    const post = await request(port, { method: 'POST', path: '/_dsh/zen-remote/admin/plugin-bridge', headers: sameOrigin(port) })
    assert.equal(post.status, 405)
  } finally { await closeServer(server) }

  // The wired handler's composition carries NO bridge: the route answers
  // 404 like any unknown admin path.
  const none = await request(adminPort, { method: 'GET', path: '/_dsh/zen-remote/admin/plugin-bridge' })
  assert.equal(none.status, 404)
})
