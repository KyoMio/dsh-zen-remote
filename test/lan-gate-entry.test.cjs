/* dsh-zen-remote · lan-gate entry (lan-gate.mjs): port resolution, env isolation & disposal */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-lan-gate-entry-'))
process.env.DSH_HOME = TEMP_HOME
process.on('exit', () => { try { fs.rmSync(TEMP_HOME, { recursive: true, force: true }) } catch { /* best effort */ } })

const FLUSH = () => new Promise((resolve) => setImmediate(resolve))
const loadEntry = () => import('../lan-gate.mjs')

/** Runs apply() on a mocked ctx and resolves the spawn options it produced. */
async function spawnWith({ env = {}, config, webServerPort }) {
  const saved = { ...process.env }
  for (const key of ['LAN_GATE_TARGET_PORT', 'LAN_GATE_UPSTREAM_TOKEN_URL']) delete process.env[key]
  Object.assign(process.env, env)
  const spawned = []
  const ctx = {
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
    const entry = await loadEntry()
    entry.apply(ctx, config)
    await FLUSH()
    assert.equal(spawned.length, 1, 'entry must spawn the gateway child exactly once')
    return { opts: spawned[0], hostEnvAfter: { ...process.env } }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

/** Fake ctx whose resolveExecutable hands out a manually-resolved promise. */
function makeDisposableCtx() {
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

test('lan-gate: inject declares webServer (the port is a required fact)', async () => {
  const entry = await loadEntry()
  assert.deepEqual(entry.inject, ['subprocess', 'connection', 'webServer'])
})

test('lan-gate: forwards to ctx.webServer.port when nothing overrides it', async () => {
  const { opts } = await spawnWith({ webServerPort: 3999 })
  assert.equal(opts.env.LAN_GATE_TARGET_PORT, '3999')
  assert.ok(opts.env.LAN_GATE_UPSTREAM_TOKEN_URL.includes('127.0.0.1:3999'))
})

test('lan-gate: webServer absent or port undefined falls back to 3080', async () => {
  const { opts } = await spawnWith({ webServerPort: undefined })
  assert.equal(opts.env.LAN_GATE_TARGET_PORT, undefined, 'no variable invented for the child')
  assert.ok(opts.env.LAN_GATE_UPSTREAM_TOKEN_URL.includes('127.0.0.1:3080'))
})

test('lan-gate: re-resolution gives a legal env var its say again, an illegal one none', async () => {
  const { opts } = await spawnWith({ env: { LAN_GATE_TARGET_PORT: '3998' }, config: { targetPort: 3996 }, webServerPort: 3999 })
  assert.equal(opts.env.LAN_GATE_TARGET_PORT, '3998', 'a legal env var wins at the resolver again')

  const illegal = await spawnWith({ env: { LAN_GATE_TARGET_PORT: 'xyz' }, config: { targetPort: 3996 }, webServerPort: 3999 })
  assert.equal(illegal.opts.env.LAN_GATE_TARGET_PORT, '3996', 'an illegal env value is skipped; the config value stands')
})

test('lan-gate: an illegal LAN_GATE_TARGET_PORT falls back to the host port', async () => {
  const { opts } = await spawnWith({ env: { LAN_GATE_TARGET_PORT: 'xyz' }, webServerPort: 3999 })
  assert.equal(opts.env.LAN_GATE_TARGET_PORT, '3999')
  assert.ok(opts.env.LAN_GATE_UPSTREAM_TOKEN_URL.includes('127.0.0.1:3999'))
})

test('lan-gate: a standalone row port re-resolves against the env (same as push)', async () => {
  const { opts } = await spawnWith({ env: { LAN_GATE_PORT: '5000' }, config: { port: 4000 }, webServerPort: 3999 })
  assert.equal(opts.env.LAN_GATE_PORT, '5000')
})

test('lan-gate: undefined resolved values delete the child env var instead of leaking the host value', async () => {
  const { opts } = await spawnWith({ env: { LAN_GATE_TARGET_PORT: 'xyz' } })
  assert.equal(opts.env.LAN_GATE_TARGET_PORT, undefined)
})

test('lan-gate: relaySecret overrides the host env, absence deletes the variable', async () => {
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

test('lan-gate: Windows .cmd/.bat wrapper from resolveExecutable falls back to real binary with ELECTRON_RUN_AS_NODE=1', async () => {
  const spawned = []
  const ctx = {
    webServer: { port: 3999 },
    get() { return undefined },
    connection: { authenticatedUrl: (url) => `${url}?token=t` },
    effect(fn) { fn(); return () => {} },
    subprocess: {
      resolveExecutable: async () => 'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\bin\\node.cmd',
      spawn(opts) {
        spawned.push(opts)
        return { done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {} }
      },
    },
  }
  const entry = await loadEntry()
  entry.apply(ctx, {})
  await FLUSH()
  assert.equal(spawned.length, 1)
  assert.ok(!spawned[0].argv[0].endsWith('.cmd'), 'must not pass .cmd batch file to CreateProcessW')
  assert.equal(spawned[0].argv[0], process.env.DSH_DESKTOP_NODE_EXECUTABLE || process.execPath)
  assert.equal(spawned[0].env.ELECTRON_RUN_AS_NODE, '1')
})

test('disposing while the executable resolves must leave no orphan child', async () => {
  const entry = await loadEntry()
  const t = makeDisposableCtx()
  entry.apply(t.ctx, {})
  t.dispose()
  t.resolveExecutable('/node')
  await FLUSH()
  assert.equal(t.spawned.length, 0, 'spawn must not happen after the row was disposed')
  assert.equal(t.terminated.length, 0, 'nothing was ever spawned, so nothing to terminate')
})

test('a normal dispose after the child spawned still terminates it', async () => {
  const entry = await loadEntry()
  const t = makeDisposableCtx()
  entry.apply(t.ctx, {})
  t.resolveExecutable('/node')
  await FLUSH()
  assert.equal(t.spawned.length, 1)
  t.dispose()
  assert.equal(t.terminated.length, 1, 'the running gateway child is terminated')
})

test('a resolved config value overrides even a stale or illegal host env var', async () => {
  const entry = await loadEntry()
  const saved = process.env.LAN_GATE_PORT
  process.env.LAN_GATE_PORT = 'abc'
  try {
    const overridden = makeDisposableCtx()
    entry.apply(overridden.ctx, { port: 4000 })
    overridden.resolveExecutable('/node')
    await FLUSH()
    assert.equal(overridden.spawned.length, 1)
    assert.equal(overridden.spawned[0].opts.env.LAN_GATE_PORT, '4000', 'the resolved value must replace the env var, not bow to it')

    const passthrough = makeDisposableCtx()
    entry.apply(passthrough.ctx, {})
    passthrough.resolveExecutable('/node')
    await FLUSH()
    assert.equal(passthrough.spawned[0].opts.env.LAN_GATE_PORT, '3088', 'an illegal env value is skipped by the resolver; the child gets the default')
  } finally {
    if (saved === undefined) delete process.env.LAN_GATE_PORT
    else process.env.LAN_GATE_PORT = saved
  }
})

test('D23-3: resolveUpstreamTokenUrl prefers authenticatedUrl and filters webserver/entry-url entries', async () => {
  const { resolveUpstreamTokenUrl } = await import('../lib/upstream-token.js')
  const ws = { port: 3999 }

  // 1. Legacy host (0.1.2 ~ 0.2.2-rc.1): authenticatedUrl wins without emitting.
  let emitted = 0
  const legacyUrl = resolveUpstreamTokenUrl({
    connection: { authenticatedUrl: (base) => `${base}?token=legacy` },
    emit: () => { emitted += 1 },
  }, ws, 'http://127.0.0.1:3999')
  assert.equal(legacyUrl, 'http://127.0.0.1:3999?token=legacy')
  assert.equal(emitted, 0)

  // 2. DSH >=0.2.2-rc.2: emits webserver/entry-url with webServer as thisArg and filters candidates.
  let seenThis
  let seenBase
  const resolved = resolveUpstreamTokenUrl({
    connection: {},
    emit(thisArg, event, baseUrl, entries) {
      seenThis = thisArg
      seenBase = baseUrl
      assert.equal(event, 'webserver/entry-url')
      entries.push(
        null,
        { url: 123 },
        { url: 'not a valid url' },
        { url: 'http://evil.example:3999/?token=wrong-origin' },
        { url: 'http://127.0.0.1:3999/other?token=wrong-path' },
        { url: 'http://127.0.0.1:3999/' },
        { url: 'http://127.0.0.1:3999/?token=' },
        { url: 'http://127.0.0.1:3999/?token=a&token=b' },
        { label: 'dsh web', url: 'http://127.0.0.1:3999/?token=good-tok&open=1', open: true },
        { label: 'second', url: 'http://127.0.0.1:3999/?token=second-tok' },
      )
    },
  }, ws, 'http://127.0.0.1:3999')
  assert.equal(seenThis, ws)
  assert.equal(seenBase, 'http://127.0.0.1:3999')
  assert.equal(resolved, 'http://127.0.0.1:3999/?token=good-tok&open=1')
})

test('D23-3: lan-gate awaits loader.await() when webserver/entry-url is registered asynchronously and aborts if disposed during wait', async () => {
  const entry = await loadEntry()
  const savedToken = process.env.LAN_GATE_UPSTREAM_TOKEN_URL
  delete process.env.LAN_GATE_UPSTREAM_TOKEN_URL
  try {
    // Case A: host-authentication-token registers webserver/entry-url before loader.await() resolves.
    let resolveLoader
    let resolveExecCalls = 0
    let listenerRegistered = false
    const spawned = []
    const ws = { port: 3999, protocol: 'http:', host: '127.0.0.1' }
    const ctx = {
      webServer: ws,
      connection: {},
      get: (name) => (name === 'loader' ? { await: () => new Promise((r) => { resolveLoader = r }) } : undefined),
      emit(thisArg, event, baseUrl, entries) {
        if (thisArg === ws && event === 'webserver/entry-url' && listenerRegistered) {
          entries.push({ label: 'dsh web', url: `${baseUrl}/?token=late-token`, open: true })
        }
      },
      effect(fn) { return fn() },
      subprocess: {
        resolveExecutable: async () => { resolveExecCalls += 1; return process.execPath },
        spawn(opts) {
          spawned.push(opts)
          return { done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {} }
        },
      },
    }

    // apply() stays synchronous and does not spawn while loader.await() is pending.
    entry.apply(ctx, {})
    await FLUSH()
    assert.equal(spawned.length, 0)
    assert.equal(resolveExecCalls, 0)

    listenerRegistered = true
    resolveLoader()
    await FLUSH()
    await FLUSH()
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].env.LAN_GATE_UPSTREAM_TOKEN_URL, 'http://127.0.0.1:3999/?token=late-token')

    // Case B: disposed while loader.await() is pending -> never resolves executable or spawns.
    let resolveLoaderB
    let execCalledB = 0
    const spawnedB = []
    const disposersB = []
    const ctxB = {
      webServer: ws,
      connection: {},
      get: (name) => (name === 'loader' ? { await: () => new Promise((r) => { resolveLoaderB = r }) } : undefined),
      emit() {},
      effect(fn) { disposersB.push(fn()) },
      subprocess: {
        resolveExecutable: async () => { execCalledB += 1; return process.execPath },
        spawn(opts) {
          spawnedB.push(opts)
          return { done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {} }
        },
      },
    }
    entry.apply(ctxB, {})
    await FLUSH()
    for (const d of disposersB) d()
    resolveLoaderB()
    await FLUSH()
    assert.equal(execCalledB, 0, 'disposed during loader.await() must abort before resolveExecutable')
    assert.equal(spawnedB.length, 0, 'disposed during loader.await() must never spawn')

    // Case C: 0.2.2-rc.2+ host with no token entry logs one warning.
    const warns = []
    const spawnedC = []
    const ctxC = {
      webServer: ws,
      connection: {},
      logger: { warn: (...args) => warns.push(args) },
      get: (name) => (name === 'loader' ? { await: () => Promise.resolve() } : undefined),
      emit() {},
      effect(fn) { return fn() },
      subprocess: {
        resolveExecutable: async () => process.execPath,
        spawn(opts) {
          spawnedC.push(opts)
          return { done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {} }
        },
      },
    }
    entry.apply(ctxC, {})
    await FLUSH()
    await FLUSH()
    assert.equal(spawnedC.length, 1)
    assert.equal(spawnedC[0].env.LAN_GATE_UPSTREAM_TOKEN_URL, undefined)
    assert.equal(warns.length, 1)
    assert.match(String(warns[0][0]), /webserver\/entry-url/)
  } finally {
    if (savedToken === undefined) delete process.env.LAN_GATE_UPSTREAM_TOKEN_URL
    else process.env.LAN_GATE_UPSTREAM_TOKEN_URL = savedToken
  }
})
