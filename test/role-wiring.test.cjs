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
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

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
 * config), no-ops inject/effect like the route tests do. Neither sub-plugin
 * is executed — the namespace objects are only inspected. */
function makeCtx() {
  const calls = []
  const ctx = {
    plugin(module, config) { calls.push({ module, config }) },
    inject() {},
    effect() {},
    logger: { warn() {} },
  }
  return { ctx, calls }
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
  // T12: the halves get the RESOLVED values object, not the raw row — one
  // shared object, defaults filled in (row/file/env are all empty here).
  assert.equal(calls[0].config, calls[1].config)
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
  assert.equal(calls[0].config, calls[1].config)
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
    effect(fn) { fn() },
    inject(deps, cb) { if (deps.every((d) => services[d] !== undefined)) cb(Object.assign(Object.create(ctx), services)) },
  }
  index.apply(ctx, { role: 'client' })
  assert.equal(pluginCalls.length, 0, 'the client role must not load the gateway or push halves')
  assert.deepEqual(
    routes.map((r) => r.path).sort(),
    [index.UPLOAD_ROUTE, index.CLIENT_CONFIG_ROUTE, share.SHARE_EXPORT_ROUTE].sort(),
  )

  // Same wiring under the host role: the routes AND both sub-plugins.
  const hostRoutes = []
  const hostServices = { ...services, webServer: { register: (route) => { hostRoutes.push(route); return () => {} } } }
  const hostCtx = {
    plugin: (module, config) => { pluginCalls.push({ module, config }) },
    effect(fn) { fn() },
    inject(deps, cb) { if (deps.every((d) => hostServices[d] !== undefined)) cb(Object.assign(Object.create(hostCtx), hostServices)) },
  }
  index.apply(hostCtx, {})
  assert.equal(pluginCalls.length, 2, 'the host role loads gateway and push on top of the routes')
  assert.equal(hostRoutes.length, 3)
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
