/* dsh-zen-remote · wizard route skeleton (GW-4)
 *
 * The REAL createWizardHandler over a real node:http socket, in front of a
 * mock admit and a mock config/runtime — the same seam the admin-route
 * tests drive. What is pinned here: the wall ORDER (admit → via marker →
 * same-origin → route), the via-gateway 403 on every wizard route (GET
 * included — the wizard has no remote-readable read, unlike admin/status),
 * the 501 placeholders, the status projection on the wire, and the GW-1
 * contract that admin/status answers WITHOUT the ingress fields while
 * wizard/status answers WITH them (both handlers mounted on one server,
 * dispatched longest-prefix-first exactly like the host web server does).
 * The wiring half (host registers the prefix, client never does) drives the
 * BUILT lib/index.js with the executing-inject fake role-wiring uses.
 */
'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { request } = require('./util.cjs')
const fs = require('node:fs')
const os = require('node:os')

const WIZARD_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'wizard', 'routes.js')).href
const ADMIN_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'admin-routes.js')).href
const INDEX_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href

const INGRESS_FIELDS = ['ingressMode', 'ingressDomain', 'ingressHttpsPort', 'ingressAcmeEmail', 'ingressPublicUrl']

let wizard
let admin
let index

/** The resolved-config values shape the handlers read; ingress fields
 * included (what resolveConfig would answer on a wizard-configured row). */
function snapshot() {
  const values = {
    role: 'host', port: 40000, host: '127.0.0.1', targetPort: undefined, rateLimit: 120,
    trustedProxies: '', vapidSubject: 'mailto:a@b.c', lang: 'zh', pushEvents: 'x/y',
    pushDebounceMs: 1, pushSummary: false, pushTurnEnd: false, pushTool: true,
    serverName: 'box', idleHours: 48, autoShareNewSessions: false, pluginBridgeConsent: {},
    ingressMode: 'caddy', ingressDomain: 'dsh.example.com', ingressHttpsPort: 8443,
    ingressAcmeEmail: 'admin@example.com', ingressPublicUrl: 'https://dsh.example.com:8443',
  }
  const sources = {}
  for (const key of Object.keys(values)) sources[key] = 'row'
  return { values, sources }
}

let configReads
let runtimeReads

function wizardOptions(overrides = {}) {
  configReads = 0
  runtimeReads = 0
  return {
    admit: overrides.admit || (() => ({ peer: {} })),
    getConfig: overrides.getConfig || (() => { configReads += 1; return snapshot() }),
    ...(overrides.getRuntime !== undefined
      ? { getRuntime: overrides.getRuntime }
      : { getRuntime: () => { runtimeReads += 1; return { cfTokenConfigured: true, cloudflaredRunning: true, gatewayActualPort: 4088 } } }),
    ...(overrides.verify !== undefined ? { verify: overrides.verify } : {}),
    ...(overrides.tokenStore !== undefined ? { tokenStore: overrides.tokenStore } : {}),
    ...(overrides.caddy !== undefined ? { caddy: overrides.caddy } : {}),
    ...(overrides.tunnel !== undefined ? { tunnel: overrides.tunnel } : {}),
  }
}

function serve(handler) {
  const server = http.createServer((req, res) => { void handler(req, res) })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

const sameOrigin = (port) => ({ origin: `http://127.0.0.1:${port}` })

let wizardServer
let wizardPort

before(async () => {
  wizard = await import(WIZARD_URL)
  admin = await import(ADMIN_URL)
  index = await import(INDEX_URL)
  ;({ server: wizardServer, port: wizardPort } = await serve(wizard.createWizardHandler(wizardOptions())))
})

after(() => new Promise((resolve) => wizardServer.close(resolve)))

test('GET status answers the sanitized projection from live config + runtime', async () => {
  const readsBefore = configReads
  const res = await request(wizardPort, { method: 'GET', path: wizard.WIZARD_STATUS_ROUTE })
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    mode: 'caddy',
    domain: 'dsh.example.com',
    httpsPort: 8443,
    publicUrl: 'https://dsh.example.com:8443',
    cfTokenConfigured: true,
    tunnelTokenConfigured: false,
    caddyRunning: false,
    cloudflaredRunning: true,
    gatewayActualPort: 4088,
    lastHostProbe: null,
    lastExternalVerification: null,
    lastForwardedSource: null,
  })
  assert.ok(configReads > readsBefore, 'the config is resolved per request, not captured at build time')
})

test('a throwing runtime probe degrades to the empty answer, the route still answers', async () => {
  const { server, port } = await serve(wizard.createWizardHandler(wizardOptions({
    getRuntime: () => { throw new Error('probe exploded') },
  })))
  try {
    const res = await request(port, { method: 'GET', path: wizard.WIZARD_STATUS_ROUTE })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.cfTokenConfigured, false)
    assert.equal(body.gatewayActualPort, null)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the via-gateway marker refuses EVERY wizard route, GET included', async () => {
  const via = { 'x-zen-remote-via': 'gateway' }
  const get = await request(wizardPort, { method: 'GET', path: wizard.WIZARD_STATUS_ROUTE, headers: via })
  assert.equal(get.status, 403)
  assert.equal(JSON.parse(get.body).error.code, 'via-gateway')
  const post = await request(wizardPort, {
    method: 'POST',
    path: `${wizard.WIZARD_ROUTE_PREFIX}/caddy/start`,
    headers: { ...via, ...sameOrigin(wizardPort) },
    body: {},
  })
  assert.equal(post.status, 403)
  assert.equal(JSON.parse(post.body).error.code, 'via-gateway')
})

test('admit rejections relay verbatim BEFORE the via wall; via loses to admit (GW-fix-1/L2)', async () => {
  for (const status of [401, 403]) {
    const { server, port } = await serve(wizard.createWizardHandler(wizardOptions({ admit: () => ({ rejection: status }) })))
    try {
      // The via header is deliberately PRESENT: admit is wall 1, so its
      // rejection must win with the plain unauthorized/forbidden envelope —
      // answering `via-gateway` here would mean the walls swapped places.
      const headers = { 'x-zen-remote-via': 'gateway' }
      const get = await request(port, { method: 'GET', path: wizard.WIZARD_STATUS_ROUTE, headers })
      assert.equal(get.status, status)
      assert.equal(JSON.parse(get.body).error.code, status === 401 ? 'unauthorized' : 'forbidden')
      const post = await request(port, { method: 'POST', path: `${wizard.WIZARD_ROUTE_PREFIX}/x`, headers: { ...headers, ...sameOrigin(port) }, body: {} })
      assert.equal(post.status, status)
      assert.equal(JSON.parse(post.body).error.code, status === 401 ? 'unauthorized' : 'forbidden')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  }
})

test('a throwing admit degrades to the JSON 500 envelope, not an unhandled rejection (GW-fix-1/L1)', async () => {
  const { server, port } = await serve(wizard.createWizardHandler(wizardOptions({
    admit: () => { throw new Error('connection service exploded') },
  })))
  try {
    const res = await request(port, { method: 'GET', path: wizard.WIZARD_STATUS_ROUTE })
    assert.equal(res.status, 500)
    assert.equal(JSON.parse(res.body).error.code, 'internal')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a malformed request URL (new URL throws) degrades to the JSON 500 envelope too (GW-fix-1/L1)', async () => {
  const { server, port } = await serve(wizard.createWizardHandler(wizardOptions()))
  try {
    // The one malformed shape WHATWG new URL actually rejects: an invalid
    // IPv6 authority (//bad//url etc. parse fine, they just look odd).
    const res = await request(port, { method: 'GET', path: '//[::z]/' })
    assert.equal(res.status, 500)
    assert.equal(JSON.parse(res.body).error.code, 'internal')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('POST placeholders answer 501 only after same-origin passes; cross-site is 403 first', async () => {
  const ok = await request(wizardPort, {
    method: 'POST',
    path: `${wizard.WIZARD_ROUTE_PREFIX}/elsewhere`,
    headers: sameOrigin(wizardPort),
    body: {},
  })
  assert.equal(ok.status, 501)
  assert.equal(JSON.parse(ok.body).error.code, 'not-implemented')

  const cross = await request(wizardPort, {
    method: 'POST',
    path: `${wizard.WIZARD_ROUTE_PREFIX}/elsewhere`,
    headers: { origin: 'http://evil.example' },
    body: {},
  })
  assert.equal(cross.status, 403)
  assert.equal(JSON.parse(cross.body).error.code, 'origin-rejected')
})

// --- GW-9: the verify routes -------------------------------------------------------

test('verify routes: POST starts, GET polls, the walls hold, unwired is 501', async () => {
  const calls = []
  const { server, port } = await serve(wizard.createWizardHandler(wizardOptions({
    verify: {
      start: async (input) => { calls.push(['start', input]); return { ok: true, pairingCode: 'PAIRCODE', publicUrl: 'https://dsh.example.com', expiresAt: 1 } },
      check: async () => { calls.push(['check']); return { result: 'pending' } },
    },
  })))
  try {
    // POST starts the verification with the body's URL.
    const post = await request(port, {
      method: 'POST',
      path: wizard.WIZARD_VERIFY_ROUTE,
      headers: sameOrigin(port),
      body: { publicUrl: 'https://dsh.example.com' },
    })
    assert.equal(post.status, 200)
    assert.deepEqual(JSON.parse(post.body), { ok: true, pairingCode: 'PAIRCODE', publicUrl: 'https://dsh.example.com', expiresAt: 1 })

    // GET polls (read-only — no same-origin requirement, like any GET).
    const get = await request(port, { method: 'GET', path: wizard.WIZARD_VERIFY_ROUTE })
    assert.equal(get.status, 200)
    assert.deepEqual(JSON.parse(get.body), { result: 'pending' })
    assert.deepEqual(calls, [['start', { publicUrl: 'https://dsh.example.com' }], ['check']])

    // The walls hold on the new route too: cross-site POST first 403s.
    const cross = await request(port, {
      method: 'POST',
      path: wizard.WIZARD_VERIFY_ROUTE,
      headers: { origin: 'http://evil.example' },
      body: { publicUrl: 'https://dsh.example.com' },
    })
    assert.equal(cross.status, 403)
    assert.equal(JSON.parse(cross.body).error.code, 'origin-rejected')
    const via = await request(port, {
      method: 'POST',
      path: wizard.WIZARD_VERIFY_ROUTE,
      headers: { 'x-zen-remote-via': 'gateway', ...sameOrigin(port) },
      body: { publicUrl: 'https://dsh.example.com' },
    })
    assert.equal(via.status, 403)
    assert.equal(JSON.parse(via.body).error.code, 'via-gateway')

    // Malformed body is a typed 400 before the orchestrator runs.
    const bad = await request(port, {
      method: 'POST',
      path: wizard.WIZARD_VERIFY_ROUTE,
      headers: sameOrigin(port),
      body: '{"publicUrl": ',
    })
    assert.equal(bad.status, 400)
    assert.equal(JSON.parse(bad.body).error.code, 'bad-request')
    assert.equal(calls.filter((entry) => entry[0] === 'start').length, 1, 'no start ran for the malformed body')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  // Unwired: the placeholder answer, walls still first.
  const bare = await serve(wizard.createWizardHandler(wizardOptions()))
  try {
    const notWired = await request(bare.port, {
      method: 'POST',
      path: wizard.WIZARD_VERIFY_ROUTE,
      headers: sameOrigin(bare.port),
      body: { publicUrl: 'https://dsh.example.com' },
    })
    assert.equal(notWired.status, 501)
    assert.equal(JSON.parse(notWired.body).error.code, 'not-implemented')
  } finally {
    await new Promise((resolve) => bare.server.close(resolve))
  }
})

test('unknown GET under the prefix is 404; non-GET/POST is 405; GET reads only', async () => {
  const missing = await request(wizardPort, { method: 'GET', path: `${wizard.WIZARD_ROUTE_PREFIX}/elsewhere` })
  assert.equal(missing.status, 404)
  const put = await request(wizardPort, { method: 'PUT', path: `${wizard.WIZARD_ROUTE_PREFIX}/caddy/start`, headers: sameOrigin(wizardPort) })
  assert.equal(put.status, 405)
  assert.equal(put.headers.allow, 'GET, POST')
  // The GET path only reads: config + runtime probes are re-read per request
  // and nothing else exists to reach — there is no mutation surface on GET.
  const before = { configReads, runtimeReads }
  await request(wizardPort, { method: 'GET', path: wizard.WIZARD_STATUS_ROUTE })
  await request(wizardPort, { method: 'GET', path: wizard.WIZARD_STATUS_ROUTE })
  assert.ok(configReads > before.configReads, 'config re-read per request')
  assert.ok(runtimeReads >= before.runtimeReads, 'runtime probed per request (read-only by contract)')
})

// --- the admin/wizard split on one server (longest-prefix dispatch) -------------

test('admin/status never carries the ingress fields; wizard/status does (same server)', async () => {
  const wizardHandler = wizard.createWizardHandler(wizardOptions())
  const adminHandler = admin.createAdminHandler({
    admit: () => ({ peer: {} }),
    // A closed port: the admin status call refuses instantly; config is the point.
    gatewayBase: 'http://127.0.0.1:1',
    getConfig: () => snapshot(),
  })
  const dispatch = (req, res) => {
    const pathname = String(req.url).split('?')[0]
    if (pathname === wizard.WIZARD_ROUTE_PREFIX || pathname.startsWith(`${wizard.WIZARD_ROUTE_PREFIX}/`)) {
      return void wizardHandler(req, res)
    }
    void adminHandler(req, res)
  }
  const { server, port } = await serve(dispatch)
  try {
    const wizardRes = await request(port, { method: 'GET', path: wizard.WIZARD_STATUS_ROUTE })
    assert.equal(wizardRes.status, 200)
    const wizardBody = JSON.parse(wizardRes.body)
    assert.equal(wizardBody.mode, 'caddy', 'wizard/status carries the declared ingress state')
    assert.equal(wizardBody.domain, 'dsh.example.com')

    const adminRes = await request(port, { method: 'GET', path: '/_dsh/zen-remote/admin/status' })
    assert.equal(adminRes.status, 200)
    const adminBody = JSON.parse(adminRes.body)
    assert.ok(adminBody.config.values.serverName, 'ordinary fields still ride admin/status')
    for (const key of INGRESS_FIELDS) {
      assert.ok(!(key in adminBody.config.values), `admin/status config.values must omit ${key}`)
      assert.ok(!(key in adminBody.config.sources), `admin/status config.sources must omit ${key}`)
    }
    assert.ok(!adminRes.body.includes('dsh.example.com'), 'the ingress domain must not leak through admin/status')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// --- the wiring: host registers the prefix, client never does -------------------

/** Executing-inject fake (same shape role-wiring.test.cjs uses): the inject
 * callback runs only when every declared service exists; registered routes
 * are recorded. */
function ctxRecording(services) {
  const routes = []
  services.webServer.register = (route) => { routes.push(route); return () => {} }
  const ctx = {
    plugin() {},
    on() { return () => {} },
    effect(fn) { fn() },
    logger: { warn() {} },
    inject(deps, cb) {
      if (!deps.every((d) => services[d] !== undefined)) return
      const target = { get: (name) => services[name], reflect: { get: (name) => services[name] }, effect: (fn2) => fn2() }
      cb(new Proxy(target, {
        get(t, prop) {
          if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop)
          if (deps.includes(prop)) return services[prop]
          throw new Error(`cannot get property "${String(prop)}" without inject`)
        },
      }))
    },
  }
  return { ctx, routes }
}

test('the wizard prefix registers on the host role only', async () => {
  const makeServices = () => ({
    webServer: {},
    connection: { admit: () => ({ peer: {} }) },
    sessions: { get: () => undefined },
    sessionQuery: {},
  })

  const host = ctxRecording(makeServices())
  index.apply(host.ctx, {})
  const wizardRoutes = host.routes.filter((r) => r.path === wizard.WIZARD_ROUTE_PREFIX)
  assert.equal(wizardRoutes.length, 1, 'the host registers the wizard prefix')
  assert.equal(wizardRoutes[0].kind, 'prefix')
  assert.equal(typeof wizardRoutes[0].handler, 'function')

  const client = ctxRecording(makeServices())
  index.apply(client.ctx, { role: 'client' })
  assert.equal(
    client.routes.filter((r) => String(r.path).startsWith(wizard.WIZARD_ROUTE_PREFIX)).length,
    0,
    'the client role never registers wizard routes',
  )

  // Without the connection service the wizard does not mount either — admit
  // is wall 1 and there is no composition to ask.
  const noConnection = ctxRecording({ webServer: {}, sessions: { get: () => undefined }, sessionQuery: {} })
  index.apply(noConnection.ctx, {})
  assert.equal(
    noConnection.routes.filter((r) => r.path === wizard.WIZARD_ROUTE_PREFIX).length,
    0,
    'no connection service, no wizard prefix',
  )
})

// ---- GW-13a: token store + managed Caddy routes ---------------------------------

/** A token store backed by a REAL file in a temp dir (the 0600 atomic write
 * is the wiring's shape: write through the store, never through payloads). */
function tokenStoreFixture() {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-tokstore-'))
  const file = path.join(dir, 'cf-api-token')
  let tunnelWritten
  return {
    file,
    dir,
    tunnelWritten: () => tunnelWritten,
    store: {
      writeCfToken: (token) => { fs.writeFileSync(file, token, { mode: 0o600 }) },
      deleteCfToken: () => { fs.rmSync(file, { force: true }) },
      cfTokenConfigured: () => { try { return fs.readFileSync(file, 'utf8').trim() !== '' } catch { return false } },
      writeTunnelToken: (token) => { tunnelWritten = token },
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

test('cf-token: POST stores 0600, DELETE removes, the token never echoes (GW-13a)', async () => {
  const fixture = tokenStoreFixture()
  try {
    const { server, port } = await serve(wizard.createWizardHandler(wizardOptions({ tokenStore: fixture.store })))
    try {
      const post = await request(port, {
        method: 'POST',
        path: wizard.WIZARD_CF_TOKEN_ROUTE,
        headers: sameOrigin(port),
        body: { token: 'sekret-cf-token-value' },
      })
      assert.equal(post.status, 200)
      assert.deepEqual(JSON.parse(post.body), { ok: true, configured: true })
      const stored = fs.readFileSync(fixture.file, 'utf8')
      assert.equal(stored, 'sekret-cf-token-value')
      assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o600, '0600 on disk')
      assert.ok(!post.body.includes('sekret-cf-token-value'), 'the token never echoes')

      // Bad bodies are typed 400s before any write.
      for (const body of [{}, { token: '' }, { token: 42 }]) {
        const bad = await request(port, { method: 'POST', path: wizard.WIZARD_CF_TOKEN_ROUTE, headers: sameOrigin(port), body })
        assert.equal(bad.status, 400)
        assert.equal(JSON.parse(bad.body).error.code, 'bad-token')
      }

      // DELETE removes the file.
      const del = await request(port, { method: 'DELETE', path: wizard.WIZARD_CF_TOKEN_ROUTE, headers: sameOrigin(port) })
      assert.equal(del.status, 200)
      assert.deepEqual(JSON.parse(del.body), { ok: true, configured: false })
      assert.ok(!fs.existsSync(fixture.file))

      // Cross-site DELETE is refused like any write.
      fixture.store.writeCfToken('again')
      const cross = await request(port, { method: 'DELETE', path: wizard.WIZARD_CF_TOKEN_ROUTE, headers: { origin: 'http://evil.example' } })
      assert.equal(cross.status, 403)
      assert.equal(JSON.parse(cross.body).error.code, 'origin-rejected')

      // The tunnel-token route writes through the store.
      const tunnel = await request(port, {
        method: 'POST',
        path: wizard.WIZARD_TUNNEL_TOKEN_ROUTE,
        headers: sameOrigin(port),
        body: { token: 'connector-secret' },
      })
      assert.equal(tunnel.status, 200)
      assert.equal(fixture.tunnelWritten(), 'connector-secret')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    fixture.cleanup()
  }
})

test('cf-token unwired is 501; the via wall holds (GW-13a)', async () => {
  const { server, port } = await serve(wizard.createWizardHandler(wizardOptions()))
  try {
    const notWired = await request(port, { method: 'POST', path: wizard.WIZARD_CF_TOKEN_ROUTE, headers: sameOrigin(port), body: { token: 'x' } })
    assert.equal(notWired.status, 501)
    const via = await request(port, {
      method: 'POST',
      path: wizard.WIZARD_CF_TOKEN_ROUTE,
      headers: { 'x-zen-remote-via': 'gateway', ...sameOrigin(port) },
      body: { token: 'x' },
    })
    assert.equal(via.status, 403)
    assert.equal(JSON.parse(via.body).error.code, 'via-gateway')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('caddy routes: start reads the SAVED config, stop and the three-state status (GW-13a)', async () => {
  const calls = []
  const manager = {
    start: async (input) => { calls.push(['start', input]); return { ok: true, binaryPath: '/bin/caddy', caddyfile: '/cf', alreadyRunning: false } },
    stop: () => { calls.push(['stop']) },
    status: () => (calls.some((c) => c[0] === 'start') && !calls.some((c) => c[0] === 'stop') ? 'running' : calls.some((c) => c[0] === 'start') ? 'stopped' : 'never-started'),
  }
  const { server, port } = await serve(wizard.createWizardHandler(wizardOptions({
    caddy: manager,
    getConfig: () => ({
      values: { ingressDomain: 'dsh.example.com', ingressHttpsPort: 8443, port: 3000 },
      sources: {},
    }),
    getRuntime: () => ({ gatewayActualPort: 4088 }),
  })))
  try {
    // Status before anything: never-started.
    const before = await request(port, { method: 'GET', path: wizard.WIZARD_CADDY_STATUS_ROUTE })
    assert.equal(before.status, 200)
    assert.deepEqual(JSON.parse(before.body), { ok: true, state: 'never-started' })

    // Start: the SAVED domain/port + the ACTUAL gateway port; no token anywhere.
    const start = await request(port, { method: 'POST', path: wizard.WIZARD_CADDY_START_ROUTE, headers: sameOrigin(port) })
    assert.equal(start.status, 200)
    assert.equal(JSON.parse(start.body).ok, true)
    assert.deepEqual(calls[0], ['start', { domain: 'dsh.example.com', httpsPort: 8443, gatewayPort: 4088 }])
    assert.ok(!start.body.includes('token'), 'no token material in the answer')

    // Running status.
    const running = await request(port, { method: 'GET', path: wizard.WIZARD_CADDY_STATUS_ROUTE })
    assert.equal(JSON.parse(running.body).state, 'running')

    // Stop.
    const stop = await request(port, { method: 'POST', path: wizard.WIZARD_CADDY_STOP_ROUTE, headers: sameOrigin(port) })
    assert.equal(stop.status, 200)
    assert.deepEqual(JSON.parse(stop.body), { ok: true, state: 'stopped' }, 'started-then-exited reads as degraded/stopped, never as never-started')

    // Start without a saved domain is a typed 400.
    const noDomain = await request(port, {
      method: 'POST',
      path: wizard.WIZARD_CADDY_START_ROUTE,
      headers: sameOrigin(port),
    })
    // getConfig still answers the domain here; force the refusal through a fresh handler.
    const bare = await serve(wizard.createWizardHandler(wizardOptions({
      caddy: manager,
      getConfig: () => ({ values: { ingressDomain: '', ingressHttpsPort: 443, port: 3000 }, sources: {} }),
    })))
    try {
      const refused = await request(bare.port, { method: 'POST', path: wizard.WIZARD_CADDY_START_ROUTE, headers: sameOrigin(bare.port) })
      assert.equal(refused.status, 400)
      assert.equal(JSON.parse(refused.body).error.code, 'no-domain')
    } finally {
      await new Promise((resolve) => bare.server.close(resolve))
    }

    // Cross-site start is refused before the manager runs.
    const before2 = calls.length
    const cross = await request(port, { method: 'POST', path: wizard.WIZARD_CADDY_START_ROUTE, headers: { origin: 'http://evil.example' } })
    assert.equal(cross.status, 403)
    assert.equal(calls.length, before2, 'no start ran')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('caddy routes unwired answer 501 (GW-13a compatibility)', async () => {
  const { server, port } = await serve(wizard.createWizardHandler(wizardOptions()))
  try {
    for (const [method, path] of [['POST', wizard.WIZARD_CADDY_START_ROUTE], ['POST', wizard.WIZARD_CADDY_STOP_ROUTE], ['GET', wizard.WIZARD_CADDY_STATUS_ROUTE]]) {
      const res = await request(port, { method, path, headers: sameOrigin(port) })
      assert.equal(res.status, 501, path)
      assert.equal(JSON.parse(res.body).error.code, 'not-implemented')
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// ---- GW-13b: tunnel routes -------------------------------------------------------

test('tunnel routes: walls, then wiring; setup carries no connector token (GW-13b)', async () => {
  const calls = []
  const { server, port } = await serve(wizard.createWizardHandler(wizardOptions({
    tunnel: {
      checkDomain: async (domain) => { calls.push(['check', domain]); return { ok: true, onCloudflare: true, zoneId: 'z1', accountId: 'a1' } },
      setup: async (input) => { calls.push(['setup', input]); return { ok: true, tunnelId: 't1', publicUrl: 'https://x', tokenFile: '/secret/path' } },
      stop: () => { calls.push(['stop']) },
      status: () => 'running',
    },
  })))
  try {
    // Status (GET, no same-origin needed) and a happy setup.
    const status = await request(port, { method: 'GET', path: wizard.WIZARD_TUNNEL_STATUS_ROUTE })
    assert.equal(status.status, 200)
    assert.deepEqual(JSON.parse(status.body), { ok: true, state: 'running' })

    const setup = await request(port, {
      method: 'POST',
      path: wizard.WIZARD_TUNNEL_SETUP_ROUTE,
      headers: sameOrigin(port),
      body: { domain: 'dsh.example.com' },
    })
    assert.equal(setup.status, 200)
    assert.deepEqual(JSON.parse(setup.body), { ok: true, tunnelId: 't1', publicUrl: 'https://x' })
    assert.ok(!setup.body.includes('/secret/path'), 'the token FILE PATH must not reach the browser either')
    assert.deepEqual(calls[0], ['setup', { domain: 'dsh.example.com', tunnelId: undefined }], 'the orchestrator receives the domain (and the absent adoption)')

    const check = await request(port, {
      method: 'POST',
      path: wizard.WIZARD_TUNNEL_CHECK_ROUTE,
      headers: sameOrigin(port),
      body: { domain: 'dsh.example.com' },
    })
    assert.deepEqual(JSON.parse(check.body), { ok: true, onCloudflare: true, zoneId: 'z1' })

    const stop = await request(port, { method: 'POST', path: wizard.WIZARD_TUNNEL_STOP_ROUTE, headers: sameOrigin(port) })
    assert.equal(JSON.parse(stop.body).state, 'running')

    // A conflict setup relays the same-name list.
    const conflict = await serve(wizard.createWizardHandler(wizardOptions({
      tunnel: {
        checkDomain: async () => ({ ok: true, onCloudflare: true, zoneId: 'z', accountId: 'a' }),
        setup: async () => ({ ok: false, reason: 'tunnel-conflict', existing: [{ id: 'tun-old', name: 'dsh-zen-remote', status: 'down' }] }),
        stop: () => {},
        status: () => 'never-started',
      },
    })))
    try {
      const listed = await request(conflict.port, {
        method: 'POST',
        path: wizard.WIZARD_TUNNEL_SETUP_ROUTE,
        headers: sameOrigin(conflict.port),
        body: { domain: 'dsh.example.com' },
      })
      assert.equal(listed.status, 200)
      assert.equal(JSON.parse(listed.body).reason, 'tunnel-conflict')
      assert.deepEqual(JSON.parse(listed.body).existing, [{ id: 'tun-old', name: 'dsh-zen-remote', status: 'down' }])
    } finally {
      await new Promise((resolve) => conflict.server.close(resolve))
    }

    // The walls hold on the whole tunnel subtree.
    const cross = await request(port, { method: 'POST', path: wizard.WIZARD_TUNNEL_SETUP_ROUTE, headers: { origin: 'http://evil.example' }, body: { domain: 'x' } })
    assert.equal(cross.status, 403)
    const via = await request(port, {
      method: 'POST',
      path: wizard.WIZARD_TUNNEL_SETUP_ROUTE,
      headers: { 'x-zen-remote-via': 'gateway', ...sameOrigin(port) },
      body: { domain: 'x' },
    })
    assert.equal(via.status, 403)
    const put = await request(port, { method: 'PUT', path: wizard.WIZARD_TUNNEL_SETUP_ROUTE, headers: sameOrigin(port) })
    assert.equal(put.status, 405)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  // Unwired: 501 everywhere under the tunnel subtree.
  const bare = await serve(wizard.createWizardHandler(wizardOptions()))
  try {
    for (const [method, path] of [['POST', wizard.WIZARD_TUNNEL_SETUP_ROUTE], ['GET', wizard.WIZARD_TUNNEL_STATUS_ROUTE], ['POST', wizard.WIZARD_TUNNEL_CHECK_ROUTE]]) {
      const res = await request(bare.port, { method, path, headers: sameOrigin(bare.port) })
      assert.equal(res.status, 501, path)
    }
  } finally {
    await new Promise((resolve) => bare.server.close(resolve))
  }
})
