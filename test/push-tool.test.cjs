/* dsh-mobile-pwa · push_notify model tool (dsh-push.mjs)
 *
 * dsh-push.mjs is a Cordis host plugin, so it's exercised directly (not via
 * a spawned gateway process): a minimal fake ctx stands in for the tool
 * registry (`ctx.get('tools')`) and the Cordis effect scope (`ctx.effect`).
 * The actual encrypted send is out of scope here (covered by push.test.cjs
 * against the real gateway) — global.fetch is mocked so no real push is
 * ever attempted and no device receives anything.
 *
 * Each test re-imports the module with a cache-busting query string, since
 * dsh-push.mjs reads its env/file config into module-top-level constants
 * once per import — tests that flip DSH_PUSH_TOOL / lan-gate.config.json
 * need a fresh module instance to see the new value.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'dsh-push.mjs')).href
let importSeq = 0
function freshImport() {
  importSeq++
  return import(`${MODULE_URL}?t=${importSeq}`)
}

// Fake Cordis context: only what dsh-push.mjs actually touches (ctx.on,
// ctx.get('tools'), ctx.effect). `withTools:false` simulates an environment
// where the tool registry service was never installed.
function makeCtx({ withTools = true } = {}) {
  const registered = []
  const ctx = {
    on: () => {},
    get: (service) => {
      if (service !== 'tools' || !withTools) return undefined
      return { register: (tool) => { registered.push(tool); return () => { const i = registered.indexOf(tool); if (i >= 0) registered.splice(i, 1) } } }
    },
    effect: (fn) => fn()
  }
  return { ctx, registered }
}

function fakeExec(sessionId) {
  return { signal: { throwIfAborted: () => {} }, agent: sessionId === undefined ? undefined : { session: { id: sessionId } } }
}

// Swaps global.fetch for the duration of `fn`, capturing every call
// (url + parsed JSON body) and answering with `responder`'s result.
async function withMockFetch(responder, fn) {
  const original = global.fetch
  const calls = []
  global.fetch = async (url, opts) => {
    const body = opts && opts.body !== undefined ? JSON.parse(opts.body) : undefined
    calls.push({ url, body })
    return responder(calls.length)
  }
  try { return await fn(calls) } finally { global.fetch = original }
}

test('push_notify: registered with the expected name, parameter schema and output schema', async () => {
  const mod = await freshImport()
  const { ctx, registered } = makeCtx()
  mod.apply(ctx)

  assert.strictEqual(registered.length, 1, 'exactly one tool registered')
  const tool = registered[0]
  assert.strictEqual(tool.name, 'push_notify')

  assert.deepStrictEqual(tool.parameters.required, ['title'], 'title is required, body is not')
  assert.strictEqual(tool.parameters.properties.title.type, 'string')
  assert.strictEqual(tool.parameters.properties.body.type, 'string')

  assert.strictEqual(tool.output.schema.type, 'object')
  assert.strictEqual(tool.output.schema.additionalProperties, false)
  assert.deepStrictEqual(tool.output.schema.required, ['delivered'])
  assert.strictEqual(tool.output.schema.properties.delivered.type, 'integer')
  assert.strictEqual(tool.output.schema.properties.throttled.type, 'boolean')

  // Usage discipline must be spelled out for the model: when to use it, and
  // the throttle numbers, so it doesn't call this on every minor step.
  assert.match(tool.description, /Do NOT call this/)
  assert.match(tool.description, /60 seconds/)
  assert.match(tool.description, /20 total per hour/)
})

test('push_notify: handler sends the correct title/body payload to the gateway and reports the delivered count', async () => {
  const mod = await freshImport()
  const { ctx, registered } = makeCtx()
  mod.apply(ctx)
  const tool = registered[0]

  await withMockFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, sent: 3, failed: 1 }) }), async (calls) => {
    const result = await tool.execute({ title: 'Need a decision', body: 'pick A or B' }, fakeExec('s1'))
    assert.deepStrictEqual(result, { delivered: 3 })
    assert.strictEqual(calls.length, 1)
    assert.match(calls[0].url, /\/pwa\/push\/send$/)
    assert.deepStrictEqual(calls[0].body, { title: 'Need a decision', body: 'pick A or B' })
  })
})

test('push_notify: omitted body is sent as "", a failed gateway call yields delivered:0 without throwing', async () => {
  const mod = await freshImport()
  const { ctx, registered } = makeCtx()
  mod.apply(ctx)
  const tool = registered[0]

  await withMockFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, sent: 1, failed: 0 }) }), async (calls) => {
    const result = await tool.execute({ title: 'Only title' }, fakeExec('sA'))
    assert.deepStrictEqual(result, { delivered: 1 })
    assert.strictEqual(calls[0].body.body, '')
  })

  await withMockFetch(() => ({ ok: false, status: 500 }), async () => {
    const result = await tool.execute({ title: 'gateway down' }, fakeExec('sB'))
    assert.deepStrictEqual(result, { delivered: 0 }, 'best-effort: never throws into the host')
  })
})

test('push_notify: throttled to 1 per 60s per session; independent across sessions; resets after the window', async () => {
  const mod = await freshImport()
  const { ctx, registered } = makeCtx()
  mod.apply(ctx)
  const tool = registered[0]

  const realNow = Date.now
  let now = 1_700_000_000_000
  Date.now = () => now
  try {
    await withMockFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, sent: 1, failed: 0 }) }), async (calls) => {
      const r1 = await tool.execute({ title: 'first' }, fakeExec('same-session'))
      assert.deepStrictEqual(r1, { delivered: 1 })

      const r2 = await tool.execute({ title: 'second, too soon' }, fakeExec('same-session'))
      assert.deepStrictEqual(r2, { delivered: 0, throttled: true })
      assert.strictEqual(calls.length, 1, 'the throttled call must never reach the gateway')

      const rOther = await tool.execute({ title: 'different session' }, fakeExec('other-session'))
      assert.deepStrictEqual(rOther, { delivered: 1 }, 'one session\'s throttle does not affect another')

      now += 61_000
      const r3 = await tool.execute({ title: 'after the window' }, fakeExec('same-session'))
      assert.deepStrictEqual(r3, { delivered: 1 }, 'the same session can send again once 60s have passed')
    })
  } finally { Date.now = realNow }
})

test('push_notify: global cap of 20 sends/hour across all sessions', async () => {
  const mod = await freshImport()
  const { ctx, registered } = makeCtx()
  mod.apply(ctx)
  const tool = registered[0]

  const realNow = Date.now
  let now = 1_700_000_000_000
  Date.now = () => now
  try {
    await withMockFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, sent: 1, failed: 0 }) }), async (calls) => {
      for (let i = 0; i < 20; i++) {
        now += 61_000 // clear each session's own 60s window so only the global cap is under test
        const r = await tool.execute({ title: `push ${i}` }, fakeExec(`session-${i}`))
        assert.deepStrictEqual(r, { delivered: 1 }, `push #${i} should be sent`)
      }
      now += 61_000
      const r21 = await tool.execute({ title: 'push 21' }, fakeExec('session-21'))
      assert.deepStrictEqual(r21, { delivered: 0, throttled: true }, 'the 21st push within the hour is dropped by the global cap')
      assert.strictEqual(calls.length, 20)
    })
  } finally { Date.now = realNow }
})

test('push_notify: rejects when called without an initiating agent', async () => {
  const mod = await freshImport()
  const { ctx, registered } = makeCtx()
  mod.apply(ctx)
  const tool = registered[0]
  await assert.rejects(() => tool.execute({ title: 'x' }, fakeExec(undefined)))
})

test('push_notify: not registered when DSH_PUSH_TOOL=0', async () => {
  const original = process.env.DSH_PUSH_TOOL
  process.env.DSH_PUSH_TOOL = '0'
  try {
    const mod = await freshImport()
    const { ctx, registered } = makeCtx()
    mod.apply(ctx)
    assert.strictEqual(registered.length, 0)
  } finally {
    if (original === undefined) delete process.env.DSH_PUSH_TOOL
    else process.env.DSH_PUSH_TOOL = original
  }
})

test('push_notify: not registered when lan-gate.config.json sets {"pushTool": false}', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-pwa-push-tool-cfg-'))
  fs.writeFileSync(path.join(home, 'lan-gate.config.json'), JSON.stringify({ pushTool: false }))
  const originalHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const mod = await freshImport()
    const { ctx, registered } = makeCtx()
    mod.apply(ctx)
    assert.strictEqual(registered.length, 0)
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('push_notify: gracefully skipped (no throw) when the "tools" service is not present', async () => {
  const mod = await freshImport()
  const { ctx, registered } = makeCtx({ withTools: false })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.strictEqual(registered.length, 0)
})
