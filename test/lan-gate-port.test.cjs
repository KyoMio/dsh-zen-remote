/* dsh-zen-remote · lan-gate entry target-port test (T-017 / T-017-fix)
 * The gateway entry (lan-gate.mjs) decides which local port the child
 * gateway should forward to, resolved as:
 *     incoming config (already merged from env > row > file by src/config.ts)
 *       > ctx.webServer.port (host truth) > 3080
 * Since T12-fix the entry receives RESOLVED values, so a config value
 * overrides any host env var unconditionally — a LEGAL env var has already
 * been folded into that config by the resolver, and an illegal one must not
 * get a second vote.
 * These cases run the real apply() against a mocked ctx whose subprocess
 * records the spawn environment instead of starting a process, and pin two
 * review findings: the host port must win whenever nothing overrides it (the
 * service is a declared inject, so apply() runs with the listener ready),
 * and the entry must never mutate the host process.env — every variable is
 * assembled in the child's env copy only.
 * T22a adds two more pinned behaviors: the entry RE-RESOLVES its input exactly
 * like dsh-push does (so a legal env var wins again at the resolver and an
 * illegal one is skipped — `LAN_GATE_TARGET_PORT=xyz` used to leak verbatim
 * into the child and became 127.0.0.1:NaN), and the relay shared secret rides
 * the config into LAN_GATE_RELAY_SECRET, overriding (or deleting) any host
 * value. Both need a hermetic DSH_HOME: re-resolution reads
 * <DSH_HOME>/lan-gate.config.json.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-lan-gate-port-'))
process.env.DSH_HOME = TEMP_HOME
process.on('exit', () => { try { fs.rmSync(TEMP_HOME, { recursive: true, force: true }) } catch { /* best effort */ } })

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

test('lan-gate: re-resolution gives a legal env var its say again, an illegal one none', async () => {
  // T22a (1a): the entry now re-resolves its input exactly like dsh-push —
  // resolveConfig(config, readFileConfig(), process.env) — so a LEGAL env var
  // beats the config object passed in (in the real host flow that config
  // already carries the same env value, so nothing changes there; this is
  // for standalone loads like the old single-row setups), while an ILLEGAL
  // one is skipped by the resolver instead of leaking into the child.
  const { opts } = await spawnWith({ env: { LAN_GATE_TARGET_PORT: '3998' }, config: { targetPort: 3996 }, webServerPort: 3999 })
  assert.equal(opts.env.LAN_GATE_TARGET_PORT, '3998', 'a legal env var wins at the resolver again')

  const illegal = await spawnWith({ env: { LAN_GATE_TARGET_PORT: 'xyz' }, config: { targetPort: 3996 }, webServerPort: 3999 })
  assert.equal(illegal.opts.env.LAN_GATE_TARGET_PORT, '3996', 'an illegal env value is skipped; the config value stands')
})

test('lan-gate: an illegal LAN_GATE_TARGET_PORT falls back to the host port', async () => {
  // T22a (1a) pinned regression: LAN_GATE_TARGET_PORT=xyz used to be passed
  // through verbatim and the child authenticated against 127.0.0.1:NaN. The
  // resolver now skips it, and the child env var is DELETED so the host's
  // real listening port takes over.
  const { opts } = await spawnWith({ env: { LAN_GATE_TARGET_PORT: 'xyz' }, webServerPort: 3999 })
  assert.equal(opts.env.LAN_GATE_TARGET_PORT, '3999')
  assert.ok(opts.env.LAN_GATE_UPSTREAM_TOKEN_URL.includes('127.0.0.1:3999'))
})

test('lan-gate: a standalone row port re-resolves against the env (same as push)', async () => {
  // Old-style single-row setup: the gateway insert carries config {port:
  // 4000} while the environment exports LAN_GATE_PORT=5000. Re-resolution
  // puts env first, so the child gets 5000 — the exact behavior dsh-push
  // already ships.
  const { opts } = await spawnWith({ env: { LAN_GATE_PORT: '5000' }, config: { port: 4000 }, webServerPort: 3999 })
  assert.equal(opts.env.LAN_GATE_PORT, '5000')
})

test('lan-gate: undefined resolved values delete the child env var instead of leaking the host value', async () => {
  // The delete half of the override rule: targetPort is the one CONFIG_ENV
  // field that can resolve to undefined. A host env value that lost at the
  // resolver (here: illegal) must not survive in the child copy when no
  // fallback fires (no webServer port available).
  const { opts } = await spawnWith({ env: { LAN_GATE_TARGET_PORT: 'xyz' } })
  assert.equal(opts.env.LAN_GATE_TARGET_PORT, undefined)
})

test('lan-gate: relaySecret overrides the host env, absence deletes the variable', async () => {
  // T22a: the shared relay secret is minted per apply by the main entry and
  // may never be dictated from the outside — a host env value is overridden
  // unconditionally, and a config without one deletes the variable so the
  // child cannot keep serving a stale secret.
  const minted = await spawnWith({ env: { LAN_GATE_RELAY_SECRET: 'host-forged' }, config: { relaySecret: 'a'.repeat(64) }, webServerPort: 3999 })
  assert.equal(minted.opts.env.LAN_GATE_RELAY_SECRET, 'a'.repeat(64), 'the plugin-minted secret wins, never the host env')

  const absent = await spawnWith({ env: { LAN_GATE_RELAY_SECRET: 'stale' }, config: {}, webServerPort: 3999 })
  assert.equal(absent.opts.env.LAN_GATE_RELAY_SECRET, undefined, 'no config secret means the variable is gone from the child')
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
