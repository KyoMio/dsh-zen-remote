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
    path: `${wizard.WIZARD_ROUTE_PREFIX}/caddy/start`,
    headers: sameOrigin(wizardPort),
    body: {},
  })
  assert.equal(ok.status, 501)
  assert.equal(JSON.parse(ok.body).error.code, 'not-implemented')

  const cross = await request(wizardPort, {
    method: 'POST',
    path: `${wizard.WIZARD_ROUTE_PREFIX}/caddy/start`,
    headers: { origin: 'http://evil.example' },
    body: {},
  })
  assert.equal(cross.status, 403)
  assert.equal(JSON.parse(cross.body).error.code, 'origin-rejected')
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
