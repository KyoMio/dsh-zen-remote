/* dsh-zen-remote · role wiring (src/index.ts apply/resolveRole)
 *
 * 2.0.0 collapsed the bundle patch from three plugin rows to one: the main
 * entry reads the row's `role` knob and mounts the gateway and push halves
 * itself via ctx.plugin(). These tests drive the BUILT lib/index.js (same
 * reason as share-export-endpoint.test.cjs: src/index.ts imports relative
 * specifiers Node's strip-only mode cannot map) with a fake context that
 * only records — neither sub-plugin's apply ever runs, so nothing here
 * spawns processes or touches the network. The cordis.patch.yml parse is a
 * plain text check that the bundle really collapsed to the one insert row,
 * because a leftover row would load the sub-plugins a second time.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const INDEX_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href
const PATCH_PATH = path.join(__dirname, '..', 'cordis.patch.yml')

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

test('apply loads both sub-plugins with the row config on the default role', async () => {
  const index = await import(INDEX_URL)
  const { ctx, calls } = makeCtx()
  const config = { maxUploadBytes: 1024 }
  index.apply(ctx, config)
  assert.equal(calls.length, 2)
  // Same order as the rows used to sit in the bundle patch: gateway, push.
  assert.equal(calls[0].module.name, 'dsh-zen-remote-gateway')
  assert.equal(calls[1].module.name, 'dsh-zen-remote-push')
  // The sub-plugins receive the exact object apply received, so a profile
  // cannot fork the config between the row and its halves.
  assert.equal(calls[0].config, config)
  assert.equal(calls[1].config, config)
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
  assert.equal(calls[0].config, config)
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
  const ids = [...readFileSync(PATCH_PATH, 'utf8').matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1])
  assert.deepEqual(ids, ['dsh-zen-remote'])
})
