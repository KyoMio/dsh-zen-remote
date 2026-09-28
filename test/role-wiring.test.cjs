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
 * returns are what the T22c wiring test asserts on; `warns` captures
 * logger.warn calls (the T33a-fix listener-swallow test reads them). */
function makeCtx() {
  const calls = []
  const listeners = []
  const effects = []
  const warns = []
  const ctx = {
    plugin(module, config) { calls.push({ module, config }) },
    on(event, listener) { listeners.push({ event, listener }) },
    inject() {},
    effect(fn) { effects.push(fn()) },
    logger: { warn: (...args) => warns.push(args) },
  }
  return { ctx, calls, listeners, effects, warns }
}

/** Cordis-faithful `inject` for fakes that EXECUTE their callbacks. The
 * callback context exposes ONLY the services the inject declares — any
 * other property read throws the same error the real proxy throws (RT
 * cordis ReflectService.handler.get: `cannot get property "X" without
 * inject`) — plus `get(name)` / `reflect.get(name)`, the reflection-layer
 * store lookup that answers the service or undefined WITHOUT the inject
 * requirement. Production wiring must use the lookup, never property
 * access, for services outside its declaration list; these fakes hold it
 * to that. */
function tightInject(services) {
  return (deps, cb) => {
    if (!deps.every((d) => services[d] !== undefined)) return
    const target = {
      get: (name) => services[name],
      reflect: { get: (name) => services[name] },
      effect: (fn) => {
        const out = fn()
        // When the fake provides an `effectReturns` array, disposer returns
        // land there — the T33a2 test drives the relay teardown from it.
        if (Array.isArray(services.effectReturns)) services.effectReturns.push(out)
        return out
      },
    }
    const scoped = new Proxy(target, {
      get(t, prop) {
        if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop)
        if (deps.includes(prop)) return services[prop]
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
    })
    cb(scoped)
  }
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
    // T17: the upload and share-export routes additionally need the
    // connection service (their admission wall) to mount at all.
    connection: { admit: () => ({ peer: {} }) },
  }
  // Unlike makeCtx, this fake EXECUTES the inject callbacks (when their
  // services exist), so the route registrations really run — the T11 review
  // wanted proof the client role still serves the phone's three routes.
  const ctx = {
    plugin: (module, config) => { pluginCalls.push({ module, config }) },
    on() {},
    effect(fn) { fn() },
    inject: tightInject(services),
  }
  index.apply(ctx, { role: 'client' })
  assert.equal(pluginCalls.length, 0, 'the client role must not load the gateway or push halves')
  // T17: with a connection service present, the client routes (T16) mount as
  // well — the three phone routes plus the client prefix route.
  assert.deepEqual(
    routes.map((r) => r.path).sort(),
    [index.UPLOAD_ROUTE, index.CLIENT_CONFIG_ROUTE, share.SHARE_EXPORT_ROUTE, '/_dsh/zen-remote/client'].sort(),
  )

  // Same wiring under the host role: the routes AND both sub-plugins. The
  // relay route is absent here only because this fake carries no
  // typertGateway service (its inject never fires) — the dedicated test
  // below covers the composition that has one. The admin prefix (T14) does
  // mount: this fake carries a connection service.
  const hostRoutes = []
  const hostServices = { ...services, webServer: { register: (route) => { hostRoutes.push(route); return () => {} } } }
  const hostCtx = {
    plugin: (module, config) => { pluginCalls.push({ module, config }) },
    on() {},
    effect(fn) { fn() },
    inject: tightInject(hostServices),
  }
  index.apply(hostCtx, {})
  assert.equal(pluginCalls.length, 2, 'the host role loads gateway and push on top of the routes')
  assert.equal(hostRoutes.length, 4)
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
      inject: tightInject(services),
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
      // The host role (since T22c) subscribes to session/event and warns
      // through ctx.logger if that fails; both must exist on this fake.
      on() { return () => {} },
      logger: { warn() {} },
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
    inject: tightInject(services),
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
 * inject actually fires and the route registration can be inspected. The
 * connection service is present too (T17): the upload and share-export
 * routes mount only where it exists. */
function makeWiringCtx(record) {
  const services = {
    logger: { warn() {} },
    webServer: { register: (route) => { record.routes.push(route); return () => {} } },
    sessions: { get: () => undefined },
    sessionQuery: {},
    typertGateway: { invoke: async () => ({}) },
    connection: { admit: () => ({ peer: {} }) },
  }
  const ctx = {
    plugin: (module, config) => { record.plugins.push({ module, config }) },
    on() {},
    effect(fn) { fn() },
    inject: tightInject(services),
  }
  return ctx
}

test('T22a: the host role registers the relay prefix route and mints a fresh 64-hex relaySecret per apply', async () => {
  const index = await import(INDEX_URL)
  const { RELAY_PREFIX } = await import(RELAY_URL)
  const first = { plugins: [], routes: [] }
  index.apply(makeWiringCtx(first), {})
  // T17: makeWiringCtx carries a connection service, so the admin prefix
  // route registers too — the relay is picked by PATH, not by being the only
  // prefix.
  const relay = first.routes.find((r) => r.path === RELAY_PREFIX)
  assert.ok(relay, 'the relay route is registered as a prefix route')
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
  // T17: the connection service in this fake also mounts the client routes
  // (T16) — the phone routes plus that prefix, still no relay anywhere.
  assert.deepEqual(
    record.routes.map((r) => r.path).sort(),
    [index.UPLOAD_ROUTE, index.CLIENT_CONFIG_ROUTE, share.SHARE_EXPORT_ROUTE, '/_dsh/zen-remote/client'].sort(),
    'exactly the phone routes and the client prefix — no relay prefix',
  )
  assert.ok(!record.routes.some((r) => r.path === '/_dsh/zen-remote/relay'), 'no relay route on the client role')
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
  // By path: T17 gave this fake a connection service, so the admin prefix
  // registers alongside the relay's.
  const relayRoute = record.routes.find((r) => r.path === '/_dsh/zen-remote/relay')
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

test('T22c + T17: the host role subscribes session/event and starts sweeper + restart watcher; the client role only the watcher', async () => {
  const index = await import(INDEX_URL)

  const host = makeCtx()
  index.apply(host.ctx, {})
  assert.deepEqual(
    host.listeners.map((l) => l.event),
    // T33a adds the fresh-creation feed right behind the activity feed; T17b
    // adds the loader's volatile-update signal (the restart watcher's
    // immediate trigger) with the watcher effect.
    ['session/event', 'agent/created', 'loader/volatile-update'],
    'the host role subscribes the session/event and agent/created feeds plus the volatile-update signal',
  )
  assert.equal(typeof host.listeners[0].listener, 'function')
  // The sweeper is registered through ctx.effect, whose callback returns the
  // stop function Cordis calls on disposal — captured here as the effect's
  // return value. makeCtx's no-op inject never fires, so the only effects on
  // this ctx are the sweeper (T22c) and the T17 restart watcher, in
  // registration order.
  assert.equal(host.effects.length, 2, 'the host role starts the idle sweeper and the restart watcher')
  assert.equal(typeof host.effects[0], 'function', 'the sweeper effect returned a stop function')
  assert.equal(typeof host.effects[1], 'function', 'the restart watcher effect returned a stop function')
  host.effects[0]() // calling it right away must be safe (and stops the real 60s timer)
  host.effects[1]() // same for the 2s poll

  const client = makeCtx()
  index.apply(client.ctx, { role: 'client' })
  assert.deepEqual(
    client.listeners.map((l) => l.event),
    ['loader/volatile-update'],
    'the client role never subscribes the session feeds but still watches for volatile updates',
  )
  // The client role has two effects: the restart watcher (T17) and the relay
  // client's disposal (T23a-fix), which clears the module slot — never the
  // sweeper, which stays host-only.
  assert.equal(client.effects.length, 2, 'the client role starts the restart watcher and the relay client disposal')
  for (const stop of client.effects) assert.equal(typeof stop, 'function', 'each effect returned a stop function')
  assert.notEqual(index.getRelayClient(), undefined, 'the client role installs its relay client in the module slot')
  for (const stop of client.effects) stop()
  assert.equal(index.getRelayClient(), undefined, 'the disposal clears the module slot')

  // A row switching from client to host clears the stale instance too.
  const reinstall = makeCtx()
  index.apply(reinstall.ctx, { role: 'client' })
  assert.notEqual(index.getRelayClient(), undefined, 'a fresh client apply installs a new instance')
  const switched = makeCtx()
  index.apply(switched.ctx, {})
  assert.equal(index.getRelayClient(), undefined, 'a host-role apply clears any stale client instance')
  for (const stop of [...reinstall.effects, ...switched.effects]) stop()
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

// ---- T33a: share-ops wiring -----------------------------------------------------

test('T33a: the host role restores busy on startup, auto-shares fresh top-level sessions, follows forks, and skips children; the client role does none of it', async () => {
  const index = await import(INDEX_URL)
  const sharesFile = path.join(TEMP_HOME, 'zen-remote-shares.json')

  // A wiring ctx whose inject EXECUTES whenever every service exists — the
  // admin routes need connection, the busy restore needs agents, the relay
  // (registered as a side effect here) needs typertGateway. The callback
  // contexts are the TIGHT fakes: only declared services resolve as
  // properties, everything else throws like cordis does.
  function makeFullCtx(routes, agentRoster) {
    const listeners = []
    const effectReturns = []
    const services = {
      logger: { warn() {} },
      // The fake unregister is MARKED so the test can tell it apart from the
      // real teardown disposers among the captured effect returns.
      webServer: { register: (route) => { const unregister = () => {}; unregister.isFakeUnregister = true; routes.push(route); return unregister } },
      sessions: { get: () => undefined },
      sessionQuery: {},
      connection: { admit: () => ({ peer: {} }) },
      typertGateway: { invoke: async () => ({ values: {} }) },
      agents: { list: () => agentRoster },
      effectReturns,
    }
    const ctx = {
      plugin() {},
      on(event, listener) { listeners.push({ event, listener }) },
      effect(fn) { fn() },
      inject: tightInject(services),
    }
    return { ctx, listeners, effectReturns }
  }

  // A minimal async-iterable JSON request the route handlers can drain.
  const jsonReq = (method, url, headers, body) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    let i = 0
    return {
      method,
      url,
      headers,
      [Symbol.asyncIterator]() {
        return { next: () => Promise.resolve(i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
      },
    }
  }

  // The store is born inside apply() reading the shares file, so the busy
  // restore has something to find: one shared session whose agent is
  // "running", one whose agent is idle.
  const stamp = Date.now()
  fs.writeFileSync(sharesFile, JSON.stringify({
    version: 1,
    sessions: {
      'live-1': { sharedAt: stamp, lastActivityAt: stamp },
      'idle-1': { sharedAt: stamp, lastActivityAt: stamp },
    },
  }))
  const routes = []
  const { ctx, listeners, effectReturns } = makeFullCtx(routes, [{ id: 'live-1', status: 'running' }, { id: 'idle-1', status: 'idle' }])
  index.apply(ctx, { autoShareNewSessions: true })

  // Startup busy restore: the running one is busy again, the idle one is not.
  const adminRoute = routes.find((r) => String(r.path).startsWith('/_dsh/zen-remote/admin'))
  assert.ok(adminRoute, 'the host role registered the admin route carrying the shares surface')
  const res = { status: 0, body: '', setHeader() {}, writeHead(code) { this.status = code }, end(bytes) { if (bytes !== undefined) this.body = bytes.toString() } }
  await adminRoute.handler({ method: 'GET', url: '/_dsh/zen-remote/admin/shares', headers: {} }, res)
  assert.equal(res.status, 200)
  const listed = JSON.parse(res.body)
  assert.equal(listed.ok, true)
  const live = listed.shares.find((s) => s.sessionId === 'live-1')
  const idle = listed.shares.find((s) => s.sessionId === 'idle-1')
  assert.equal(live.busy, true, 'the restore re-marked the running session busy')
  assert.equal(live.remainingMs, null, 'busy serializes as null remaining')
  assert.equal(idle.busy, false)

  // Regression (T33a-fix): the same tight-context wiring must also carry a
  // POST share through — before the fix the handler read typertGateway/
  // agents by PROPERTY access on an inject scope that never declared them,
  // and every shares request died in a 500.
  const postRes = { status: 0, body: '', setHeader() {}, writeHead(code) { this.status = code }, end(bytes) { if (bytes !== undefined) this.body = bytes.toString() } }
  await adminRoute.handler(
    jsonReq('POST', '/_dsh/zen-remote/admin/shares', { 'sec-fetch-site': 'same-origin' }, { action: 'share', sessionId: 'posted-1' }),
    postRes,
  )
  assert.equal(postRes.status, 200, 'POST share survives the tight context (reflect.get lookup)')
  assert.equal(JSON.parse(postRes.body).ok, true)
  assert.ok(JSON.parse(fs.readFileSync(sharesFile, 'utf8')).sessions['posted-1'], 'the posted session entered the table')
  const postListed = { status: 0, body: '', setHeader() {}, writeHead(code) { this.status = code }, end(bytes) { if (bytes !== undefined) this.body = bytes.toString() } }
  await adminRoute.handler({ method: 'GET', url: '/_dsh/zen-remote/admin/shares', headers: {} }, postListed)
  assert.equal(JSON.parse(postListed.body).shares.some((s) => s.sessionId === 'posted-1'), true, 'GET shares (non-empty table) works end to end')

  // Viewer counts (T33a2): the admin route reads them through the LIVE relay
  // handler — the same object the relay prefix registered. No relay stream is
  // open here, so everything answers 0; stubbing the handler's viewerCount
  // (what T22b drives when a stream opens) shows up in the next GET.
  const relayRoute = routes.find((r) => r.path === '/_dsh/zen-remote/relay')
  assert.ok(relayRoute, 'the host role registered the relay prefix in this composition too')
  const fetchShares = async () => {
    const r = { status: 0, body: '', setHeader() {}, writeHead(code) { this.status = code }, end(bytes) { if (bytes !== undefined) this.body = bytes.toString() } }
    await adminRoute.handler({ method: 'GET', url: '/_dsh/zen-remote/admin/shares', headers: {} }, r)
    return JSON.parse(r.body)
  }
  assert.equal((await fetchShares()).shares.find((s) => s.sessionId === 'live-1').viewers, 0, 'no relay stream, zero viewers')
  relayRoute.handler.viewerCount = (id) => (id === 'live-1' ? 3 : 0)
  const withViewers = await fetchShares()
  assert.equal(withViewers.shares.find((s) => s.sessionId === 'live-1').viewers, 3, 'the relay handler answer flows into the listing')
  assert.equal(withViewers.shares.find((s) => s.sessionId === 'idle-1').viewers, 0, 'per session, not global')
  delete relayRoute.handler.viewerCount

  // The teardown clears the pointer: after the relay effect's disposer runs
  // (closeAll + unregister + pointer clear), the same admin handler falls
  // back to zero viewers instead of reading a dead handler. The disposer is
  // the effect callback's return, captured by the fake's effectReturns —
  // the only captured return that is not a fake webServer unregister.
  const relayTeardown = effectReturns.find((d) => typeof d === 'function' && !d.isFakeUnregister)
  assert.equal(typeof relayTeardown, 'function', 'the relay registration carries a teardown')
  relayTeardown()
  assert.equal((await fetchShares()).shares.find((s) => s.sessionId === 'live-1').viewers, 0, 'a disposed relay handler reads as zero viewers, not a crash')

  // The creation feed: a fresh top-level session is auto-shared (row knob on).
  const created = listeners.find((l) => l.event === 'agent/created').listener
  const startup = (id, header) => created({ agent: { id, session: { header: { version: 4, id, createdAt: stamp, isSeeded: false, ...header } } }, source: 'startup' })
  startup('auto-1')
  const after = JSON.parse(fs.readFileSync(sharesFile, 'utf8'))
  assert.ok(after.sessions['auto-1'], 'a fresh top-level session entered the table (autoShare on)')

  // Resume is NOT a fresh creation: a resumed session stays out.
  created({ agent: { id: 'resumed-1', session: { header: { version: 4, id: 'resumed-1', createdAt: stamp, isSeeded: false } } }, source: 'resume' })
  const afterResume = JSON.parse(fs.readFileSync(sharesFile, 'utf8'))
  assert.equal(afterResume.sessions['resumed-1'], undefined, "source 'resume' never shares")

  // A subagent child never enters the table — not even under autoShare.
  startup('child-1', { origin: 'subagent', parentSession: 'auto-1' })
  assert.equal(JSON.parse(fs.readFileSync(sharesFile, 'utf8')).sessions['child-1'], undefined)

  // A fork of a shared source follows it into the table; a fork of an
  // unknown source follows the autoShare knob instead (T33a-fix: a fork is
  // an ordinary new session) — and this row has the knob ON.
  startup('fork-1', { parentSession: 'auto-1', isSeeded: true })
  assert.ok(JSON.parse(fs.readFileSync(sharesFile, 'utf8')).sessions['fork-1'], 'the fork of a shared source is shared')
  startup('fork-2', { parentSession: 'never-heard-of', isSeeded: true })
  assert.ok(JSON.parse(fs.readFileSync(sharesFile, 'utf8')).sessions['fork-2'], 'an unreachable fork still follows autoShare (knob on here)')
  // And a fresh top-level resume-shaped event is still ignored.
  created({ agent: { id: 'resumed-2', session: { header: { version: 4, id: 'resumed-2', createdAt: stamp, isSeeded: true, parentSession: 'also-unknown' } } }, source: 'resume' })
  assert.equal(JSON.parse(fs.readFileSync(sharesFile, 'utf8')).sessions['resumed-2'], undefined, "source 'resume' never shares, fork header or not")

  // Same wiring, client role: no creation feed, no admin prefix — the
  // service being present changes nothing.
  const clientRoutes = []
  const client = makeFullCtx(clientRoutes, [])
  index.apply(client.ctx, { role: 'client' })
  assert.equal(client.listeners.filter((l) => l.event === 'agent/created').length, 0, "the client role never subscribes agent/created")
  assert.equal(clientRoutes.filter((r) => String(r.path).startsWith('/_dsh/zen-remote/admin')).length, 0, 'no admin prefix on the client role')
})

test('T33a-fix: a throwing agent/created listener is swallowed and warned, never propagated', async () => {
  const index = await import(INDEX_URL)
  // The feed dispatches SERIALLY: a rejection rolls the whole session
  // creation back, so the listener must contain its own failures.
  fs.rmSync(path.join(TEMP_HOME, 'zen-remote-shares.json'), { force: true })
  const { ctx, listeners, warns } = makeCtx()
  index.apply(ctx, { autoShareNewSessions: true })
  const created = listeners.find((l) => l.event === 'agent/created').listener

  // An agent whose session read explodes mid-flight (a hostile getter, the
  // simplest faithful stand-in for any bookkeeping failure below).
  assert.doesNotThrow(() => created({
    agent: { id: 'hostile', get session() { throw new Error('probe') } },
    source: 'startup',
  }), 'the listener must not let the error escape')
  assert.ok(
    warns.some((args) => String(args[0]).includes('cannot share new session')),
    'the failure is warned through the logger',
  )

  // And it survives: the next well-formed creation still shares.
  created({
    agent: { id: 'after-boom', session: { header: { version: 4, id: 'after-boom', createdAt: 1, isSeeded: false } } },
    source: 'startup',
  })
  assert.ok(
    JSON.parse(fs.readFileSync(path.join(TEMP_HOME, 'zen-remote-shares.json'), 'utf8')).sessions['after-boom'],
    'the listener keeps working after a swallowed failure',
  )
})

// ---- T17: live volatile reads, restart watcher, admission walls ---------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await sleep(50)
  }
  assert.ok(fn(), message)
}

/** Fake ctx with an EXECUTING inject over exactly the given services, for
 * grabbing the routes apply() registers (same shape as the admin test's
 * ctxRecording, parameterized). */
function ctxExecuting(services) {
  const routes = []
  const all = {
    logger: { warn() {} },
    plugin() {},
    on() {},
    effect(fn) { fn() },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    ...services,
  }
  const ctx = { ...all, inject(deps, cb) { if (deps.every((d) => all[d] !== undefined)) cb(Object.assign(Object.create(ctx), all)) } }
  return { ctx, routes }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve))
}

test('T17: the client-config route re-reads volatile row fields and the effective role per request', async () => {
  const index = await import(INDEX_URL)
  let turnFold = false
  let liftRatio
  const row = {
    role: 'host',
    // The loader wraps volatile fields in { get() } references — this is
    // that shape, with mutable returns so the test can age them mid-stream.
    turnFoldDesktop: { get: () => turnFold },
    keyboardLiftRatio: { get: () => liftRatio },
  }
  const { ctx, routes } = ctxExecuting({})
  index.apply(ctx, row)
  const route = routes.find((r) => r.path === index.CLIENT_CONFIG_ROUTE)
  assert.ok(route, 'the client-config route mounts with just a webServer')
  const server = http.createServer((req, res) => { void route.handler(req, res) })
  const base = await listen(server)
  try {
    const first = JSON.parse((await request(server.address().port, { method: 'GET', path: '/_dsh/mobile-nav/client-config' })).body)
    assert.equal(first.role, 'host', 'the effective role rides the response (T17 role probe)')
    assert.equal(first.turnFoldDesktop, false)
    assert.ok(!('keyboardLiftRatio' in first), 'an unset knob is omitted, not zeroed')

    // Same process, same route, same row object: only the volatile getters
    // moved. An apply-time snapshot would keep answering the old values.
    turnFold = true
    liftRatio = 0.9
    row.role = 'client'
    const second = JSON.parse((await request(server.address().port, { method: 'GET', path: '/_dsh/mobile-nav/client-config' })).body)
    assert.equal(second.turnFoldDesktop, true)
    assert.equal(second.keyboardLiftRatio, 0.9)
    assert.equal(second.role, 'client', 'the role follows the row without a reload')
  } finally {
    await close(server)
  }
})

test('T17: the upload and share-export routes stay unmounted without a connection service', async () => {
  const index = await import(INDEX_URL)
  const share = await import(SHARE_URL)
  const { ctx, routes } = ctxExecuting({
    sessions: { get: () => undefined },
    sessionQuery: {},
  })
  index.apply(ctx, {})
  const paths = routes.map((r) => r.path)
  assert.ok(!paths.includes(index.UPLOAD_ROUTE), 'no upload route without connection')
  assert.ok(!paths.includes(share.SHARE_EXPORT_ROUTE), 'no share-export route without connection')
  assert.ok(paths.includes(index.CLIENT_CONFIG_ROUTE), 'client-config needs no connection and still mounts')
})

test('T17: the upload route refuses an unadmitted request and passes an admitted one', async () => {
  const index = await import(INDEX_URL)
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-t17-upload-'))
  try {
    for (const admission of [{ rejection: 401 }, { rejection: 403 }]) {
      const { ctx, routes } = ctxExecuting({
        sessions: { get: (id) => (id === 's' ? { header: { cwd: workspace } } : undefined) },
        connection: { admit: () => admission },
      })
      index.apply(ctx, {})
      const route = routes.find((r) => r.path === index.UPLOAD_ROUTE)
      const server = http.createServer((req, res) => { void route.handler(req, res) })
      const base = await listen(server)
      try {
        const response = await fetch(`${base}${index.UPLOAD_ROUTE}?session=s&name=a.txt`, {
          method: 'POST',
          headers: { origin: base },
          body: 'x',
        })
        assert.equal(response.status, admission.rejection)
        const body = await response.json()
        assert.equal(body.ok, false)
        assert.equal(body.error.code, admission.rejection === 401 ? 'unauthorized' : 'forbidden')
      } finally {
        await close(server)
      }
    }

    // An admitting connection service changes nothing else: 201, bytes on
    // disk, same envelope as before T17.
    const { ctx, routes } = ctxExecuting({
      sessions: { get: (id) => (id === 's' ? { header: { cwd: workspace } } : undefined) },
      connection: { admit: () => ({ peer: {} }) },
    })
    index.apply(ctx, {})
    const route = routes.find((r) => r.path === index.UPLOAD_ROUTE)
    const server = http.createServer((req, res) => { void route.handler(req, res) })
    const base = await listen(server)
    try {
      const response = await fetch(`${base}${index.UPLOAD_ROUTE}?session=s&name=ok.txt`, {
        method: 'POST',
        headers: { origin: base },
        body: 'payload',
      })
      assert.equal(response.status, 201)
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.bytes, 7)
    } finally {
      await close(server)
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('T17: a restart-required row change reloads the row exactly once; a live-read change never does', async () => {
  const index = await import(INDEX_URL)
  const restarts = []
  const { ctx } = makeCtx()
  // cordis 4.0.4: ctx.fiber is the row's own Fiber and restart() its public
  // dispose-and-reload entry — this fake stands in for it.
  ctx.fiber = { restart: () => { restarts.push(1); return Promise.resolve() } }
  const row = { port: 4000, serverName: 'before' }
  index.apply(ctx, row)
  assert.equal(restarts.length, 0)

  // A live-read field alone never triggers, even across a full poll window.
  row.serverName = 'after'
  await sleep(2300)
  assert.equal(restarts.length, 0, 'a serverName change never reloads the row')

  // A restart-required field triggers exactly one reload; the watcher is
  // then disarmed (the reload's fresh apply() starts a new one).
  row.port = 4001
  await waitFor(() => restarts.length === 1, 5000, 'the port change reloads the row')
  row.port = 4002
  await sleep(2300)
  assert.equal(restarts.length, 1, 'the watcher stopped after firing')
})

test('T17b: a loader/volatile-update dispatch reloads the row immediately, without waiting for the poll', async () => {
  const index = await import(INDEX_URL)
  const restarts = []
  const { ctx, listeners } = makeCtx()
  ctx.fiber = { restart: () => { restarts.push(1); return Promise.resolve() } }
  const row = { port: 4000, serverName: 'before' }
  index.apply(ctx, row)
  const update = listeners.find((l) => l.event === 'loader/volatile-update')
  assert.ok(update, 'apply subscribes loader/volatile-update on the row context')

  // A volatile-only save lands and the loader announces it — dispatched
  // synchronously, BEFORE any 2s poll tick can run. The restart must not
  // wait for the poll.
  row.port = 4001
  update.listener()
  assert.equal(restarts.length, 1, 'the dispatch reloaded the row on the spot')
  // Exactly once: later dispatches and the (already stopped) poll stay quiet.
  row.port = 4002
  update.listener()
  await sleep(2300)
  assert.equal(restarts.length, 1, 'the watcher is disarmed after the event fired')
})

test('T17b: a volatile-update dispatch touching only live-read fields never reloads', async () => {
  const index = await import(INDEX_URL)
  const restarts = []
  const { ctx, listeners } = makeCtx()
  ctx.fiber = { restart: () => { restarts.push(1); return Promise.resolve() } }
  const row = { port: 4000, serverName: 'before' }
  index.apply(ctx, row)
  const update = listeners.find((l) => l.event === 'loader/volatile-update')
  row.serverName = 'after'
  update.listener()
  assert.equal(restarts.length, 0, 'the fingerprint did not move: no reload')
  // The watcher stays armed: a real restart-field move still reloads.
  row.port = 4001
  update.listener()
  assert.equal(restarts.length, 1, 'the same watcher still catches the restart-field move')
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
  // T17b: since every field is volatile, the row hands over `{ get() }`
  // live references — resolveRole must unwrap before comparing, or a client
  // row would always answer host.
  assert.equal(index.resolveRole({ role: { get: () => 'client' } }), 'client', 'the volatile wrapper is unwrapped')
  assert.equal(index.resolveRole({ role: { get: () => 'host' } }), 'host')
  assert.equal(index.resolveRole({ role: { get: () => 'x' } }), 'host')
})

test('cordis.patch.yml carries exactly one insert row: the main entry', () => {
  const ids = [...fs.readFileSync(PATCH_PATH, 'utf8').matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1])
  assert.deepEqual(ids, ['dsh-zen-remote'])
})
