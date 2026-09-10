/* dsh-zen-remote · share-export route (src/share-export.ts)
 *
 * Integration style borrowed from scripts/check-upload-endpoint.mjs: the REAL
 * handler runs over a real node:http socket, with a fake sessionQuery service
 * standing in for the host. The fold helpers (isAppendSurfaceEvent /
 * deriveEventMessage) are the real ones from @deepseek-ai/dsh-session/surface
 * — imported by the module under test, not re-implemented here — so the
 * transcript rules asserted below are the ones production applies. No
 * harness, no session, no message: folding a log is a read.
 *
 * The fixture log below encodes every admission rule of foldShareTurns as one
 * concrete event, so a single deepEqual over the response pins the whole
 * fold (append-origin retention, role/source/block filters, and the events
 * that must fall out of a human transcript).
 */
'use strict'
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const { createServer } = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// The handler is driven from the .ts source (check-upload-endpoint style:
// Node >= 23.6 type stripping, no build needed). apply() is a different
// story: src/index.ts imports './share-export.js' — the extension Node ESM
// needs at runtime — which strip-only cannot map back to a .ts file, so the
// wiring test imports the BUILT lib/index.js (the same committed artifact
// check-client-externals.mjs reads).
const SHARE_URL = pathToFileURL(path.join(__dirname, '..', 'src', 'share-export.ts')).href
const INDEX_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href

const T = 1757500000000
const CREATED_AT = 1757000000000

/** Minimal event factory: seq + time + type + payload, surfaceOp only where
 * the event type is message-producing. */
function ev(seq, type, data, surfaceOp) {
  const event = { type, seq, time: T + seq * 1000, data }
  if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
  return event
}

const MODEL_SOURCE = { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }

/** One conversation exercising every fold rule: a tool round, a usage-only
 * assistant event, an injected context, a mixed-block human message, an
 * unknown block type, and a replacement (compaction-style) user message
 * shadowing the first human turn. */
function fixtureEvents() {
  return [
    ev(0, 'turn/start', { turn: 0 }),
    // system prompt: never part of a shared conversation.
    ev(1, 'system/message', { turn: 0, step: 0, message: { id: 'sys-0', role: 'system', content: [{ type: 'text', text: 'You are DeepSeek Harness.' }], source: { kind: 'plugin', plugin: 'dsh-system-prompt' } } }, 'append'),
    // human turn 1.
    ev(2, 'user/message', { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], source: { kind: 'user', rpcId: 'r1' } }, 'append'),
    // log-only request bookkeeping: no surfaceOp, never transcript material.
    ev(3, 'request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' }),
    // assistant answer with reasoning: only the text block survives.
    ev(4, 'assistant/message', { turn: 0, step: 0, message: { id: 'a-1', role: 'assistant', content: [{ type: 'reasoning', text: 'simple arithmetic' }, { type: 'text', text: '2+2 = 4.' }], source: MODEL_SOURCE }, stream: [], usage: { inputTokens: 10, outputTokens: 5 } }, 'append'),
    // a tool round: the call is log-only, the result is a user-role message
    // whose only block is tool-result — drops to zero blocks, so no row.
    ev(5, 'tool/call', { turn: 0, step: 1, callId: 'c1', name: 'calc', arguments: '{}' }),
    ev(6, 'tool/result', { turn: 0, step: 1, message: { id: 't-1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '4' }], isError: false }], source: { kind: 'tool', callId: 'c1' } } }, 'append'),
    // assistant turn with a tool-call block plus text: text survives.
    ev(7, 'assistant/message', { turn: 0, step: 1, message: { id: 'a-2', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'calc', arguments: '{}' }, { type: 'text', text: 'The calculator says 4.' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
    // usage-only empty assistant message (a max-tokens step's accounting):
    // deriveEventMessage yields null, so no content-less bubble.
    ev(8, 'assistant/message', { turn: 0, step: 2, message: { id: 'a-3', role: 'assistant', content: [], source: MODEL_SOURCE }, stream: [], usage: { inputTokens: 1, outputTokens: 99 } }, 'append'),
    // injected context (file-change notice): user ROLE, but source says a
    // plugin produced it — Chat renders it as a context row, not a bubble.
    ev(9, 'user/message', { id: 'u-2', role: 'user', content: [{ type: 'text', text: '<system-reminder>AGENTS.md changed</system-reminder>' }], source: { kind: 'plugin', plugin: 'agent-instructions', form: 'notice', summary: 'AGENTS.md changed' } }, 'append'),
    // human turn 2: image becomes a placeholder, file attachment drops.
    ev(10, 'user/message', { id: 'u-3', role: 'user', content: [{ type: 'text', text: 'Plot this.' }, { type: 'image', attachment: { id: 'img-1' } }, { type: 'file', attachment: { id: 'file-1' } }], source: { kind: 'user', rpcId: 'r2' } }, 'append'),
    // assistant reply carrying a block type this fold does not know: the
    // unknown block is skipped, the text is kept (merge-extensible union).
    ev(11, 'assistant/message', { turn: 1, step: 0, message: { id: 'a-4', role: 'assistant', content: [{ type: 'hologram' }, { type: 'text', text: 'Here you go.' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
    // a landed replacement (compaction checkpoint): the replacement COPY is
    // model-only and must not appear, while the range it shadowed (seq 2)
    // stays — the human transcript keeps what the user already saw.
    ev(12, 'user/message', { id: 'u-9', role: 'user', content: [{ type: 'text', text: 'COMPACTED SUMMARY' }], source: { kind: 'plugin', plugin: 'compact' } }, { op: 'replace', startSeq: 2, endSeq: 2 }),
  ]
}

const EXPECTED_TURNS = [
  { role: 'user', seq: 2, blocks: [{ kind: 'text', text: 'What is 2+2?' }] },
  { role: 'assistant', seq: 4, blocks: [{ kind: 'text', text: '2+2 = 4.' }] },
  { role: 'assistant', seq: 7, blocks: [{ kind: 'text', text: 'The calculator says 4.' }] },
  { role: 'user', seq: 10, blocks: [{ kind: 'text', text: 'Plot this.' }, { kind: 'image' }] },
  { role: 'assistant', seq: 11, blocks: [{ kind: 'text', text: 'Here you go.' }] },
]

/** Fake sessionQuery: observeSession serves an exact cut per session id and
 * hands out caller-owned leases whose disposals are counted, so the tests can
 * prove the route releases what it acquires. */
function makeSessionQuery(sessions) {
  const state = { observed: [], leases: 0, disposed: 0 }
  const query = {
    async observeSession(id) {
      state.observed.push(id)
      const session = sessions[id]
      if (session === undefined) {
        const error = new Error(`session "${id}" not found`)
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw error
      }
      state.leases += 1
      return {
        source: 'live',
        header: session.header,
        inheritedEventCount: 0,
        events: session.events,
        cursor: session.events.at(-1)?.seq ?? -1,
        retain() { throw new Error('retain is not part of this route') },
        [Symbol.dispose]() { state.leases -= 1; state.disposed += 1 },
      }
    },
  }
  return { query, state }
}

let share, index, server, base, queryState, warned

before(async () => {
  share = await import(SHARE_URL)
  index = await import(INDEX_URL)
  const { query, state } = makeSessionQuery({
    'sess-live': { header: { version: 3, id: 'sess-live', createdAt: CREATED_AT, cwd: '/tmp/x', isSeeded: true }, events: fixtureEvents() },
    'sess-empty': { header: { version: 3, id: 'sess-empty', createdAt: CREATED_AT, isSeeded: false }, events: [] },
  })
  queryState = state
  warned = 0
  const ctx = { sessionQuery: query, logger: { warn: () => { warned += 1 } } }
  server = createServer((req, res) => { void share.handleShareExport(ctx, req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server !== undefined) await new Promise((resolve) => server.close(resolve))
})

async function get(query) {
  const response = await fetch(`${base}/_dsh/mobile-nav/share-export${query}`)
  return { status: response.status, headers: response.headers, body: await response.json() }
}

test('range=all folds the log into the human transcript', async () => {
  const { status, headers, body } = await get('?session=sess-live&range=all')
  assert.equal(status, 200)
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(headers.get('cache-control'), 'no-store')
  assert.equal(headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(body, { ok: true, createdAt: CREATED_AT, turns: EXPECTED_TURNS, truncated: false })
})

test('range is optional and defaults to all', async () => {
  const { status, body } = await get('?session=sess-live')
  assert.equal(status, 200)
  assert.deepEqual(body.turns, EXPECTED_TURNS)
})

test('an empty session exports zero turns, not an error', async () => {
  const { status, body } = await get('?session=sess-empty')
  assert.equal(status, 200)
  assert.deepEqual(body, { ok: true, createdAt: CREATED_AT, turns: [], truncated: false })
})

test('unknown session is a 404 with the shared error envelope', async () => {
  const { status, body } = await get('?session=sess-gone&range=all')
  assert.equal(status, 404)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'session-not-found')
})

test('query validation', async () => {
  // session is required exactly once, non-empty.
  assert.equal((await get('?range=all')).status, 400)
  assert.equal((await get('?session=')).status, 400)
  assert.equal((await get('?session=a&session=b&range=all')).status, 400)
  // range must be 'all' — 'last' arrives with the range-slicing ticket, and
  // anything else is a client bug worth a loud 400 over a silent wrong answer.
  assert.equal((await get('?session=sess-live&range=last&turns=5')).status, 400)
  assert.equal((await get('?session=sess-live&range=bogus')).status, 400)
  assert.equal((await get('?session=sess-live&range=all&range=all')).status, 400)
})

test('only GET is allowed', async () => {
  const response = await fetch(`${base}/_dsh/mobile-nav/share-export?session=sess-live`, { method: 'POST' })
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'GET')
  assert.equal((await response.json()).error.code, 'method-not-allowed')
})

test('every acquired observation lease is disposed', async () => {
  // Three 200s so far (all ×2, empty) → three leases taken and released; the
  // 400s short-circuit before observeSession and the 404 throws before any
  // lease exists, so nothing may be left pinned.
  assert.equal(queryState.disposed, 3)
  assert.equal(queryState.leases, 0)
  assert.deepEqual(queryState.observed, ['sess-live', 'sess-live', 'sess-empty', 'sess-gone'])
})

test('rejections are logged once each, the method guard is not', async () => {
  // 1×404 + 6×400 reached the try block and logged; the 405 answers before it.
  assert.equal(warned, 7)
})

/** Fake Cordis context for apply(): inject runs its callback only when every
 * requested service exists (that IS the no-mount path), effect runs eagerly.
 * Pass webServer:false to simulate a composition with no web server at all. */
function makeApplyCtx({ webServer = true, ...services } = {}) {
  const routes = []
  const all = {
    logger: { warn: () => {} },
    effect: (fn) => fn(),
    ...(webServer ? { webServer: { register: (route) => { routes.push(route); return () => {} } } } : {}),
    ...services,
  }
  const ctx = { ...all, inject: (deps, cb) => { if (deps.every((d) => all[d] !== undefined)) cb(Object.assign(Object.create(ctx), all)) } }
  return { ctx, routes }
}

test('apply mounts the share route only where sessionQuery exists', async () => {
  const sessions = { get: () => undefined }
  const sessionQuery = makeSessionQuery({}).query

  const full = makeApplyCtx({ sessions, sessionQuery })
  index.apply(full.ctx)
  const fullPaths = full.routes.map((r) => r.path)
  assert.ok(fullPaths.includes(share.SHARE_EXPORT_ROUTE))
  assert.ok(fullPaths.includes(index.UPLOAD_ROUTE), 'upload route unaffected')
  assert.ok(fullPaths.includes(index.CLIENT_CONFIG_ROUTE), 'client-config route unaffected')
  const shareRoute = full.routes.find((r) => r.path === share.SHARE_EXPORT_ROUTE)
  assert.equal(shareRoute.kind, 'exact')
  assert.equal(typeof shareRoute.handler, 'function')

  // A composition without sessionQuery (Electron carries neither it nor a
  // webServer): the route never mounts and the other two still do.
  const noQuery = makeApplyCtx({ sessions })
  index.apply(noQuery.ctx)
  assert.ok(!noQuery.routes.some((r) => r.path === share.SHARE_EXPORT_ROUTE))
  assert.ok(noQuery.routes.some((r) => r.path === index.UPLOAD_ROUTE))

  const noWeb = makeApplyCtx({ webServer: false, sessions, sessionQuery })
  index.apply(noWeb.ctx)
  assert.equal(noWeb.routes.length, 0)
})
