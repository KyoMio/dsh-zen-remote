/* dsh-zen-remote · lan-gate entry target-port test (T-017 / T-017-fix)
 * The gateway entry (lan-gate.mjs) decides which local port the child
 * gateway should forward to, resolved as:
 *     explicit env > cordis config > ctx.webServer.port (host truth) > 3080
 * These cases run the real apply() against a mocked ctx whose subprocess
 * records the spawn environment instead of starting a process, and pin two
 * review findings: the host port must win whenever nothing overrides it (the
 * service is a declared inject, so apply() runs with the listener ready),
 * and the entry must never mutate the host process.env — every variable is
 * assembled in the child's env copy only.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')

/** Runs apply() on a mocked ctx and resolves the spawn options it produced. */
async function spawnWith({ env = {}, config, webServerPort }) {
  const saved = { ...process.env }
  for (const key of ['LAN_GATE_TARGET_PORT', 'LAN_GATE_UPSTREAM_TOKEN_URL']) delete process.env[key]
  Object.assign(process.env, env)
  const spawned = []
  const ctx = {
    // Declared inject: the entry reads ctx.webServer directly (no lazy get).
    webServer: webServerPort === undefined ? undefined : { port: webServerPort },
    get() { return undefined },
    connection: { authenticatedUrl: (url) => `${url}?token=t` },
    effect(fn) { fn(); return () => {} },
    subprocess: {
      resolveExecutable: async () => process.execPath,
      spawn(opts) {
        spawned.push(opts)
        return { done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {} }
      },
    },
  }
  try {
    const entry = await import('../lan-gate.mjs')
    entry.apply(ctx, config)
    // apply() is sync but start() awaits the executable resolution first.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(spawned.length, 1, 'entry must spawn the gateway child exactly once')
    return { opts: spawned[0], hostEnvAfter: { ...process.env } }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

test('lan-gate: inject declares webServer (the port is a required fact)', async () => {
  const entry = await import('../lan-gate.mjs')
  assert.deepEqual(entry.inject, ['subprocess', 'connection', 'webServer'])
})

test('lan-gate: forwards to ctx.webServer.port when nothing overrides it', async () => {
  const { opts } = await spawnWith({ webServerPort: 3999 })
  assert.equal(opts.env.LAN_GATE_TARGET_PORT, '3999')
  assert.ok(opts.env.LAN_GATE_UPSTREAM_TOKEN_URL.includes('127.0.0.1:3999'))
})

test('lan-gate: webServer absent or port undefined falls back to 3080', async () => {
  for (const webServerPort of [undefined]) {
    const { opts } = await spawnWith({ webServerPort })
    assert.equal(opts.env.LAN_GATE_TARGET_PORT, undefined, 'no variable invented for the child')
    assert.ok(opts.env.LAN_GATE_UPSTREAM_TOKEN_URL.includes('127.0.0.1:3080'))
  }
})

test('lan-gate: an explicit env var beats config and the host port', async () => {
  const { opts } = await spawnWith({ env: { LAN_GATE_TARGET_PORT: '3998' }, config: { targetPort: 3996 }, webServerPort: 3999 })
  assert.equal(opts.env.LAN_GATE_TARGET_PORT, '3998')
  assert.ok(opts.env.LAN_GATE_UPSTREAM_TOKEN_URL.includes('127.0.0.1:3998'))
})

test('lan-gate: cordis config beats the host port', async () => {
  const { opts } = await spawnWith({ config: { targetPort: 3997 }, webServerPort: 3999 })
  assert.equal(opts.env.LAN_GATE_TARGET_PORT, '3997')
  assert.ok(opts.env.LAN_GATE_UPSTREAM_TOKEN_URL.includes('127.0.0.1:3997'))
})

test('lan-gate: the host process.env is never written', async () => {
  const { hostEnvAfter } = await spawnWith({ config: { targetPort: 3997, host: '127.0.0.1' }, webServerPort: 3999 })
  assert.equal(hostEnvAfter.LAN_GATE_TARGET_PORT, undefined, 'host env must stay untouched')
  assert.equal(hostEnvAfter.LAN_GATE_HOST, undefined, 'config translation stays in the child copy')
})

test('lan-gate: config variables reach the child env copy', async () => {
  const { opts } = await spawnWith({ config: { host: '0.0.0.0' }, webServerPort: 3999 })
  assert.equal(opts.env.LAN_GATE_HOST, '0.0.0.0')
})
