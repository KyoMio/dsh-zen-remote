/* dsh-zen-remote · gateway entry disposal (lan-gate.mjs)
 *
 * The T11 review found an orphan-process window: start() awaits
 * ctx.subprocess.resolveExecutable('node'), and if the plugin row is torn
 * down during that await (a config change restarting the row), the cleanup
 * function still sees handle === null and has nothing to terminate — then the
 * await returns and the child spawns with nobody owning it (spawned children
 * belong to the subprocess service, not to the caller's plugin lifecycle).
 * The fix is a disposed flag checked after the await, before the spawn. The
 * fake ctx's resolveExecutable returns a promise resolved MANUALLY, so the
 * test can interleave the teardown exactly where the race lives. Nothing
 * here spawns a real process.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// T22a: the entry now re-resolves its config (readFileConfig reads
// <DSH_HOME>/lan-gate.config.json), so this file needs a hermetic home or a
// developer's real config file would flip these expectations machine-by-
// machine. Same isolation role-wiring.test.cjs uses.
const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-lan-gate-dispose-'))
process.env.DSH_HOME = TEMP_HOME
process.on('exit', () => { try { fs.rmSync(TEMP_HOME, { recursive: true, force: true }) } catch { /* best effort */ } })

const FLUSH = () => new Promise((resolve) => setImmediate(resolve))

/** Fake ctx whose resolveExecutable hands out a manually-resolved promise.
 * effect() captures the disposer apply() registers, so the test can trigger
 * the row teardown at an exact moment. */
function makeCtx() {
  let resolveExecutable
  const spawned = []
  const terminated = []
  const disposers = []
  const ctx = {
    get: () => undefined,
    webServer: { port: 3999 },
    connection: { authenticatedUrl: (url) => `${url}?token=t` },
    effect(fn) { disposers.push(fn()) },
    subprocess: {
      resolveExecutable: () => new Promise((resolve) => { resolveExecutable = resolve }),
      spawn(opts) {
        const handle = {
          opts,
          terminate() { terminated.push(1) },
          done: Promise.resolve({ exitCode: 0, signal: null }),
        }
        spawned.push(handle)
        return handle
      },
    },
  }
  return {
    ctx,
    spawned,
    terminated,
    resolveExecutable: (value) => resolveExecutable(value),
    dispose: () => { for (const d of disposers) d() },
  }
}

test('disposing while the executable resolves must leave no orphan child', async () => {
  const entry = await import('../lan-gate.mjs')
  const t = makeCtx()
  entry.apply(t.ctx, {})
  t.dispose() // the row dies while start() is still awaiting resolveExecutable
  t.resolveExecutable('/node') // the await now returns into a disposed apply
  await FLUSH()
  assert.equal(t.spawned.length, 0, 'spawn must not happen after the row was disposed')
  assert.equal(t.terminated.length, 0, 'nothing was ever spawned, so nothing to terminate')
})

test('a normal dispose after the child spawned still terminates it', async () => {
  const entry = await import('../lan-gate.mjs')
  const t = makeCtx()
  entry.apply(t.ctx, {})
  t.resolveExecutable('/node')
  await FLUSH()
  assert.equal(t.spawned.length, 1)
  t.dispose()
  assert.equal(t.terminated.length, 1, 'the running gateway child is terminated')
})

test('a resolved config value overrides even a stale or illegal host env var', async () => {
  // T12-fix: the config arriving here is already resolved (src/config.ts
  // folded every LEGAL env var into it), so a hand-exported LAN_GATE_PORT=abc
  // must not get a second vote over the row. T22a goes one step further: the
  // entry re-resolves its input (same as dsh-push), so an ILLEGAL env var is
  // skipped by the resolver and must not leak verbatim into the child either —
  // with no row value the child gets the default, never the raw 'abc'.
  const entry = await import('../lan-gate.mjs')
  const saved = process.env.LAN_GATE_PORT
  process.env.LAN_GATE_PORT = 'abc'
  try {
    const overridden = makeCtx()
    entry.apply(overridden.ctx, { port: 4000 })
    overridden.resolveExecutable('/node')
    await FLUSH()
    assert.equal(overridden.spawned.length, 1)
    assert.equal(overridden.spawned[0].opts.env.LAN_GATE_PORT, '4000', 'the resolved value must replace the env var, not bow to it')

    const passthrough = makeCtx()
    entry.apply(passthrough.ctx, {})
    passthrough.resolveExecutable('/node')
    await FLUSH()
    assert.equal(passthrough.spawned[0].opts.env.LAN_GATE_PORT, '3088', 'an illegal env value is skipped by the resolver; the child gets the default')
  } finally {
    if (saved === undefined) delete process.env.LAN_GATE_PORT
    else process.env.LAN_GATE_PORT = saved
  }
})
