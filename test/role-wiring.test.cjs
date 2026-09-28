/* dsh-zen-remote · role wiring (src/index.ts apply + src/config.ts resolveConfig)
 *
 * 2.0.0 collapsed the bundle patch from three plugin rows to one: the main
 * entry reads the row's `role` knob and mounts the gateway and push halves
 * itself via ctx.plugin(). Since T12 the halves receive the RESOLVED config
 * (env > row > lan-gate.config.json > defaults) rather than the raw row, so
 * these tests pin the values that actually arrive. They drive the BUILT
 * lib/index.js (same reason as share-export-endpoint.test.cjs: src/index.ts
 * imports relative specifiers Node's strip-only mode cannot map) with a fake
 * context that only records — neither sub-plugin's apply ever runs, so
 * nothing here spawns processes or touches the network. DSH_HOME points at
 * an empty temp dir so resolution can never read the developer's real
 * ~/.dsh/lan-gate.config.json. The cordis.patch.yml parse is a plain text
 * check that the bundle really collapsed to the one insert row, because a
 * leftover row would load the sub-plugins a second time.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { request } = require('./util.cjs')

const INDEX_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href
const SHARE_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'share-export.js')).href
const PATCH_PATH = path.join(__dirname, '..', 'cordis.patch.yml')

// Hermetic resolution: an empty DSH_HOME means readFileConfig() finds nothing
// (the directory is never written to), so every expected value below comes
// from the layer the test itself provided.
const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-role-wiring-'))
process.env.DSH_HOME = TEMP_HOME
process.on('exit', () => { try { fs.rmSync(TEMP_HOME, { recursive: true, force: true }) } catch { /* best effort */ } })

// T12-fix test isolation: a LAN_GATE_* / DSH_PUSH_* variable exported in the
// developer's shell would flow through apply()'s resolveConfig and flip the
// expected sub-plugin config values machine-dependently. Clear them all for
// the duration of the file; node --test gives this file its own process.
const SAVED_ENV = {}
test.before(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(?:LAN_GATE|DSH_PUSH)_/.test(key)) {
      SAVED_ENV[key] = process.env[key]
      delete process.env[key]
    }
  }
})
test.after(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) process.env[key] = value
})

/** Fake Cordis context: records every plugin() call (module namespace +
 * config) and every ctx.on subscription + ctx.effect return, no-ops
 * inject/effect like the route tests do. Neither sub-plugin is executed —
 * the namespace objects are only inspected. The `on` record and the effect
 * returns are what the T22c wiring test asserts on. */
function makeCtx() {
  const calls = []
  const listeners = []
  const effects = []
  const ctx = {
    plugin(module, config) { calls.push({ module, config }) },
    on(event, listener) { listeners.push({ event, listener }) },
    inject() {},
    effect(fn) { effects.push(fn()) },
    logger: { warn() {} },
  }
  return { ctx, calls, listeners, effects }
}

test('apply loads both sub-plugins with the resolved values on the default role', async () => {
  const index = await import(INDEX_URL)
  const { ctx, calls } = makeCtx()
  const config = { maxUploadBytes: 1024 }
  index.apply(ctx, config)
  assert.equal(calls.length, 2)
  // Same order as the rows used to sit in the bundle patch: gateway, push.
  assert.equal(calls[0].module.name, 'dsh-zen-remote-gateway')
  assert.equal(calls[1].module.name, 'dsh-zen-remote-push')
  // T22a: the gateway additionally carries the per-apply relay secret, so the
  // two configs are no longer the same object — push sees the identical
  // resolved values MINUS the secret (omitted via destructuring so the key
  // really disappears instead of sitting there as undefined).
  const { relaySecret: _gatewaySecret, ...gatewayValues } = calls[0].config
  assert.deepEqual(gatewayValues, calls[1].config)
  assert.match(calls[0].config.relaySecret, /^[0-9a-f]{64}$/, 'the secret is 64 hex chars (32 random bytes)')
  assert.equal(calls[0].config.port, 3088)
  assert.equal(calls[0].config.role, 'host')
  // Their own inject declarations ride along on the namespace, which is what
  // cordis reads when the sub-plugin loads — pinned here so a refactor of
  // the .mjs files cannot drop them silently.
  assert.deepEqual(calls[0].module.inject, ['subprocess', 'connection', 'webServer'])
  assert.deepEqual(calls[1].module.inject, [])
  assert.equal(typeof calls[0].module.apply, 'function')
  assert.equal(typeof calls[1].module.apply, 'function')
})

test("apply loads both sub-plugins for role 'host'", async () => {
  const index = await import(INDEX_URL)
  const { ctx, calls } = makeCtx()
  const config = { role: 'host' }
  index.apply(ctx, config)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].module.name, 'dsh-zen-remote-gateway')
  assert.equal(calls[1].module.name, 'dsh-zen-remote-push')
  const { relaySecret: _hostSecret, ...hostGatewayValues } = calls[0].config
  assert.deepEqual(hostGatewayValues, calls[1].config)
  assert.equal(calls[0].config.role, 'host')
})

test("apply loads nothing extra for role 'client'", async () => {
  const index = await import(INDEX_URL)
  const { ctx, calls } = makeCtx()
  index.apply(ctx, { role: 'client' })
  assert.equal(calls.length, 0)
})

test("invalid role values fall back to the host role", async () => {
  const index = await import(INDEX_URL)
  for (const role of ['server', 'client ', 123, true, null]) {
    const { ctx, calls } = makeCtx()
    index.apply(ctx, { role })
    assert.equal(calls.length, 2, `role ${JSON.stringify(role)} must mean host`)
    assert.equal(calls[0].module.name, 'dsh-zen-remote-gateway')
    assert.equal(calls[1].module.name, 'dsh-zen-remote-push')
  }
})

test('sub-plugins receive the resolved config: a row port wins, an illegal one falls to default', async () => {
  const index = await import(INDEX_URL)
  const withRow = makeCtx()
  index.apply(withRow.ctx, { port: 4000 })
  assert.equal(withRow.calls[0].config.port, 4000, 'the gateway sees the row port')
  assert.equal(withRow.calls[1].config.port, 4000, 'so does push')

  const badRow = makeCtx()
  index.apply(badRow.ctx, { port: 'abc' })
  assert.equal(badRow.calls[0].config.port, 3088, 'an illegal row value is skipped, not surfaced')
})

test("role 'client' mounts all three routes through a real inject and never calls plugin()", async () => {
  const index = await import(INDEX_URL)
  const share = await import(SHARE_URL)
  const pluginCalls = []
  const routes = []
  const services = {
    logger: { warn() {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    sessions: { get: () => undefined },
    sessionQuery: {},
  }
  // Unlike makeCtx, this fake EXECUTES the inject callbacks (when their
  // services exist), so the route registrations really run — the T11 review
  // wanted proof the client role still serves the phone's three routes.
  const ctx = {
    plugin: (module, config) => { pluginCalls.push({ module, config }) },
    on() {},
    effect(fn) { fn() },
    inject(deps, cb) { if (deps.every((d) => services[d] !== undefined)) cb(Object.assign(Object.create(ctx), services)) },
  }
  index.apply(ctx, { role: 'client' })
  assert.equal(pluginCalls.length, 0, 'the client role must not load the gateway or push halves')
  assert.deepEqual(
    routes.map((r) => r.path).sort(),
    [index.UPLOAD_ROUTE, index.CLIENT_CONFIG_ROUTE, share.SHARE_EXPORT_ROUTE].sort(),
  )

  // Same wiring under the host role: the routes AND both sub-plugins. The
  // relay route is absent here only because this fake carries no
  // typertGateway service (its inject never fires) — the dedicated test
  // below covers the composition that has one.
  const hostRoutes = []
  const hostServices = { ...services, webServer: { register: (route) => { hostRoutes.push(route); return () => {} } } }
  const hostCtx = {
    plugin: (module, config) => { pluginCalls.push({ module, config }) },
    on() {},
    effect(fn) { fn() },
    inject(deps, cb) { if (deps.every((d) => hostServices[d] !== undefined)) cb(Object.assign(Object.create(hostCtx), hostServices)) },
  }
  index.apply(hostCtx, {})
  assert.equal(pluginCalls.length, 2, 'the host role loads gateway and push on top of the routes')
  assert.equal(hostRoutes.length, 3)
})

test('admin routes register on the host role only', async () => {
  const index = await import(INDEX_URL)
  const PREFIX = '/_dsh/zen-remote/admin'

  // A fake context whose inject EXECUTES whenever every service exists —
  // including `connection`, which only the admin routes (T14) need. The
  // earlier three-route test runs WITHOUT a connection service, which is the
  // Electron shape: there the admin routes stay unmounted on either role,
  // so the role gate is only observable with the service present.
  function ctxRecording(routes) {
    const services = {
      logger: { warn() {} },
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      sessions: { get: () => undefined },
      sessionQuery: {},
      connection: { admit: () => ({ peer: {} }) },
    }
    const ctx = {
      plugin() {},
      on() {},
      effect(fn) { fn() },
      inject(deps, cb) { if (deps.every((d) => services[d] !== undefined)) cb(Object.assign(Object.create(ctx), services)) },
    }
    return ctx
  }

  const clientRoutes = []
  index.apply(ctxRecording(clientRoutes), { role: 'client' })
  assert.equal(clientRoutes.filter((r) => String(r.path).startsWith(PREFIX)).length, 0, "the client role must not register admin routes")

  const hostRoutes = []
  index.apply(ctxRecording(hostRoutes), {})
  const adminRoutes = hostRoutes.filter((r) => String(r.path).startsWith(PREFIX))
  assert.equal(adminRoutes.length, 1, 'the host role registers the admin prefix route')
  assert.equal(adminRoutes[0].kind, 'prefix')
})

test('T16: client routes register on the client role only', async () => {
  const index = await import(INDEX_URL)
  const CLIENT_PREFIX = '/_dsh/zen-remote/client'
  const ADMIN_PREFIX = '/_dsh/zen-remote/admin'

  // Same executing-inject fake as the admin test above: the client routes
  // need webServer + connection, so this is the composition where the role
  // gate is observable at all.
  function ctxRecording(routes) {
    const services = {
      logger: { warn() {} },
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      sessions: { get: () => undefined },
      sessionQuery: {},
      connection: { admit: () => ({ peer: {} }) },
    }
    const ctx = {
      plugin() {},
      effect(fn) { fn() },
      inject(deps, cb) { if (deps.every((d) => services[d] !== undefined)) cb(Object.assign(Object.create(ctx), services)) },
    }
    return ctx
  }

  const clientRoutes = []
  index.apply(ctxRecording(clientRoutes), { role: 'client' })
  const clientPrefix = clientRoutes.filter((r) => String(r.path).startsWith(CLIENT_PREFIX))
  assert.equal(clientPrefix.length, 1, "the client role registers the client prefix route")
  assert.equal(clientPrefix[0].kind, 'prefix')
  assert.equal(clientRoutes.filter((r) => String(r.path).startsWith(ADMIN_PREFIX)).length, 0, 'still no admin routes on the client role')

  const hostRoutes = []
  index.apply(ctxRecording(hostRoutes), {})
  assert.equal(hostRoutes.filter((r) => String(r.path).startsWith(CLIENT_PREFIX)).length, 0, 'the host role must not register client routes')
  assert.equal(hostRoutes.filter((r) => String(r.path).startsWith(ADMIN_PREFIX)).length, 1, 'the host keeps its admin prefix route')
})

test('the admin handler resolves config per request, volatile fields included', async () => {
  const index = await import(INDEX_URL)
  // A port that is closed NOW, so the handler's status call refuses instantly
  // and this test only watches config.values — it must never reach a real
  // gateway on 3088.
  const dead = http.createServer()
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
  const deadPort = dead.address().port
  await new Promise((resolve) => dead.close(resolve))

  let serverName = 'Name-Before'
  const row = {
    port: deadPort,
    // The loader wraps volatile fields in { get() } references before apply()
    // ever sees the row (src/config.ts unwrapVolatile) — this is that shape,
    // with the returned value mutable so the test can age it mid-stream.
    serverName: { get: () => serverName },
  }
  const routes = []
  const services = {
    logger: { warn() {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    sessions: { get: () => undefined },
    sessionQuery: {},
    connection: { admit: () => ({ peer: {} }) },
  }
  const ctx = {
    plugin() {},
    on() {},
    effect(fn) { fn() },
    inject(deps, cb) { if (deps.every((d) => services[d] !== undefined)) cb(Object.assign(Object.create(ctx), services)) },
  }
  index.apply(ctx, row)

  const adminRoute = routes.find((r) => String(r.path).startsWith('/_dsh/zen-remote/admin'))
  assert.ok(adminRoute, 'the host role registers the admin route')
  const server = http.createServer((req, res) => { void adminRoute.handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    const first = JSON.parse((await request(port, { method: 'GET', path: '/_dsh/zen-remote/admin/status' })).body)
    assert.equal(first.config.values.serverName, 'Name-Before')

    // Same process, same handler, same row object: only the volatile getter's
    // return value changed. An apply-time snapshot would keep answering the
    // old name (T14-fix item 4).
    serverName = 'Name-After'
    const second = JSON.parse((await request(port, { method: 'GET', path: '/_dsh/zen-remote/admin/status' })).body)
    assert.equal(second.config.values.serverName, 'Name-After', 'config must be resolved per request')
    assert.equal(second.config.sources.serverName, 'row')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// ---- T22a: relay wiring -------------------------------------------------------

const RELAY_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'relay-server.js')).href

/** Fake ctx like the one above, plus a typertGateway service, so the relay
 * inject actually fires and the route registration can be inspected. */
function makeWiringCtx(record) {
  const services = {
    logger: { warn() {} },
    webServer: { register: (route) => { record.routes.push(route); return () => {} } },
    sessions: { get: () => undefined },
    sessionQuery: {},
    typertGateway: { invoke: async () => ({}) },
  }
  const ctx = {
    plugin: (module, config) => { record.plugins.push({ module, config }) },
    on() {},
    effect(fn) { fn() },
    inject(deps, cb) { if (deps.every((d) => services[d] !== undefined)) cb(Object.assign(Object.create(ctx), services)) },
  }
  return ctx
}

test('T22a: the host role registers the relay prefix route and mints a fresh 64-hex relaySecret per apply', async () => {
  const index = await import(INDEX_URL)
  const { RELAY_PREFIX } = await import(RELAY_URL)
  const first = { plugins: [], routes: [] }
  index.apply(makeWiringCtx(first), {})
  const relay = first.routes.find((r) => r.kind === 'prefix')
  assert.ok(relay, 'the relay route is registered as a prefix route')
  assert.equal(relay.path, RELAY_PREFIX)
  assert.equal(relay.path, '/_dsh/zen-remote/relay')
  assert.equal(typeof relay.handler, 'function')
  const gwConfig = first.plugins.find((c) => c.module.name === 'dsh-zen-remote-gateway').config
  assert.match(gwConfig.relaySecret, /^[0-9a-f]{64}$/, 'the gateway sub-plugin carries a 64-hex relaySecret')
  const pushConfig = first.plugins.find((c) => c.module.name === 'dsh-zen-remote-push').config
  assert.equal(pushConfig.relaySecret, undefined, 'the push half never sees the secret')

  const second = { plugins: [], routes: [] }
  index.apply(makeWiringCtx(second), {})
  const secondSecret = second.plugins.find((c) => c.module.name === 'dsh-zen-remote-gateway').config.relaySecret
  assert.match(secondSecret, /^[0-9a-f]{64}$/)
  assert.notEqual(secondSecret, gwConfig.relaySecret, 'every apply mints a NEW secret')
})

test("T22a: role 'client' registers no relay route even with typertGateway available", async () => {
  const index = await import(INDEX_URL)
  const share = await import(SHARE_URL)
  const record = { plugins: [], routes: [] }
  index.apply(makeWiringCtx(record), { role: 'client' })
  assert.equal(record.plugins.length, 0)
  assert.deepEqual(
    record.routes.map((r) => r.path).sort(),
    [index.UPLOAD_ROUTE, index.CLIENT_CONFIG_ROUTE, share.SHARE_EXPORT_ROUTE].sort(),
    'exactly the three phone routes — no relay prefix',
  )
  assert.ok(!record.routes.some((r) => r.kind === 'prefix'), 'no prefix route at all on the client role')
})

// A minimal ServerResponse stand-in: responseJson only sets headers, writes
// the status and ends with the body bytes.
function fakeRes() {
  return {
    status: 0,
    body: '',
    setHeader() {},
    writeHead(code) { this.status = code },
    end(bytes) { if (bytes !== undefined) this.body = bytes.toString() },
    on() {},
    off() {},
  }
}

test('T22a-fix: the minted relaySecret opens the registered relay handler, a wrong one does not', async () => {
  const index = await import(INDEX_URL)
  const record = { plugins: [], routes: [] }
  index.apply(makeWiringCtx(record), {})
  const relayRoute = record.routes.find((r) => r.kind === 'prefix')
  const secret = record.plugins.find((c) => c.module.name === 'dsh-zen-remote-gateway').config.relaySecret
  const call = (requestSecret) => {
    const headers = {
      'x-zen-remote-via': 'gateway',
      'x-zen-remote-role': 'desktop-client',
      'x-zen-remote-device': 'dev-1',
    }
    if (requestSecret !== undefined) headers['x-zen-remote-secret'] = requestSecret
    const res = fakeRes()
    return relayRoute.handler({ method: 'GET', url: '/_dsh/zen-remote/relay/ping', headers }, res).then(() => res)
  }

  const ok = await call(secret)
  assert.equal(ok.status, 200, 'the secret handed to the gateway sub-plugin is THE relay secret')
  assert.equal(JSON.parse(ok.body).ok, true)

  const wrong = await call('f'.repeat(64))
  assert.equal(wrong.status, 401, 'any other secret is refused')
  const absent = await call(undefined)
  assert.equal(absent.status, 401, 'no secret is refused')
})

// ---- T22c: activity tracking wiring ------------------------------------------

test('T22c: the host role subscribes session/event and registers the sweeper stop; the client role does neither', async () => {
  const index = await import(INDEX_URL)

  const host = makeCtx()
  index.apply(host.ctx, {})
  assert.deepEqual(
    host.listeners.map((l) => l.event),
    ['session/event'],
    'the host role subscribes exactly the session/event feed',
  )
  assert.equal(typeof host.listeners[0].listener, 'function')
  // The sweeper is registered through ctx.effect, whose callback returns the
  // stop function Cordis calls on disposal — captured here as the effect's
  // return value. makeCtx's no-op inject never fires, so the ONLY effect on
  // this ctx is the sweeper.
  assert.equal(host.effects.length, 1, 'the host role starts exactly the idle sweeper')
  assert.equal(typeof host.effects[0], 'function', 'the effect returned a stop function')
  host.effects[0]() // calling it right away must be safe (and stops the real 60s timer)

  const client = makeCtx()
  index.apply(client.ctx, { role: 'client' })
  assert.equal(client.listeners.length, 0, "the client role never subscribes session/event")
  assert.equal(client.effects.length, 0, "the client role never starts the sweeper")
})

test('T22c-fix: the captured session/event listener refreshes the shared table and ignores id-less sessions', async () => {
  const index = await import(INDEX_URL)
  // The store is born inside apply() reading <DSH_HOME>/zen-remote-shares.json,
  // so the test pre-seeds session 'x' with an hour-old stamp BEFORE apply and
  // watches that file afterwards: the first touch after a load is written
  // through immediately (share-store's 60s throttle only caps REPEAT writes).
  const sharesFile = path.join(TEMP_HOME, 'zen-remote-shares.json')
  const oldStamp = Date.now() - 3_600_000
  fs.writeFileSync(sharesFile, JSON.stringify({
    version: 1,
    sessions: { x: { sharedAt: oldStamp, lastActivityAt: oldStamp } },
  }))
  const { ctx, listeners } = makeCtx()
  index.apply(ctx, {})
  const listener = listeners.find((l) => l.event === 'session/event').listener

  // A session-shaped stub carrying the DSH header fields the parent index
  // reads (validateSessionHeader: origin only ever 'subagent', parentSession
  // a string). The event must reach the table's clock for 'x'.
  listener({ id: 'x', header: { origin: 'subagent', parentSession: 'p' } }, { type: 'user/message' })
  const after = JSON.parse(fs.readFileSync(sharesFile, 'utf8'))
  assert.ok(after.sessions.x.lastActivityAt > oldStamp, 'the event refreshed the shared session clock')

  listener({}, { type: 'user/message' })
  assert.deepEqual(
    JSON.parse(fs.readFileSync(sharesFile, 'utf8')),
    after,
    'an id-less session is ignored end to end — the file does not move',
  )
})

test('resolveRole normalizes to host or client', async () => {
  const index = await import(INDEX_URL)
  assert.equal(index.resolveRole(undefined), 'host')
  assert.equal(index.resolveRole({}), 'host')
  assert.equal(index.resolveRole({ role: 'host' }), 'host')
  assert.equal(index.resolveRole({ role: 'client' }), 'client')
  // Any non-'client' value — typo, wrong type — degrades to host.
  assert.equal(index.resolveRole({ role: 'x' }), 'host')
  assert.equal(index.resolveRole({ role: 'Host' }), 'host')
  assert.equal(index.resolveRole({ role: 123 }), 'host')
})

test('cordis.patch.yml carries exactly one insert row: the main entry', () => {
  const ids = [...fs.readFileSync(PATCH_PATH, 'utf8').matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1])
  assert.deepEqual(ids, ['dsh-zen-remote'])
})
