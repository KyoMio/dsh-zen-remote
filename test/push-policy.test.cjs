/* dsh-zen-remote · notification-timing policy (dsh-push.mjs pure layer)
 *
 * The whole point of pulling the decision out into pure functions is that
 * push timing can be tested WITHOUT creating a DSH session or sending a
 * message — a documented workspace hard rule (real tokens). Everything here
 * is `event/state in → {shouldNotify, title, body} out`.
 *
 * Event names and payload shapes below were read off the installed DSH rc.7
 * packages, not guessed:
 *   · session header `delegationDepth`  @deepseek-ai/dsh-session SessionHeader
 *     — ABSENT for top level, parent+1 for a subagent child.
 *   · `assistant/message` content blocks @deepseek-ai/dsh-llm ContentBlockMap
 *     — 'text' vs 'reasoning', both carrying `.text`.
 *   · `tool/call` { turn, step, callId, name, arguments }  @deepseek-ai/dsh-session
 *   · `approval/asked` { id, toolName, callId?, reason? } @deepseek-ai/dsh-user-approval
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'dsh-push.mjs')).href
let seq = 0
const freshImport = () => import(`${MODULE_URL}?policy=${++seq}`)

const CFG = { turnEndEnabled: false, debounceMs: 15000, includeSummary: false }
const cfg = (over) => ({ ...CFG, ...over })
const at = (input) => ({ now: 1_700_000_000_000, lastSent: 0, ...input })

// --- turn end -------------------------------------------------------------

test('turn end: opt-in — off by default, on with turnEndEnabled', async () => {
  const { decideNotification } = await freshImport()

  const off = decideNotification(at({ kind: 'turn-end', delegationDepth: undefined }), cfg())
  assert.strictEqual(off.shouldNotify, false, 'turn end must no longer push by default')
  assert.strictEqual(off.reason, 'turn-end-disabled')

  const on = decideNotification(at({ kind: 'turn-end', delegationDepth: undefined }), cfg({ turnEndEnabled: true }))
  assert.strictEqual(on.shouldNotify, true)
  assert.strictEqual(on.reason, 'turn-end')
  assert.ok(on.title && on.body, 'a turn-end push carries a fixed title and body')
})

test('turn end: only top-level sessions notify; a subagent turn end never does', async () => {
  const { decideNotification } = await freshImport()
  const c = cfg({ turnEndEnabled: true })

  // delegationDepth is ABSENT on a top-level session header, so both undefined
  // and 0 mean "top level" — copying the spec's `=== 0` literally would have
  // silenced every real top-level session.
  assert.strictEqual(decideNotification(at({ kind: 'turn-end', delegationDepth: undefined }), c).shouldNotify, true)
  assert.strictEqual(decideNotification(at({ kind: 'turn-end', delegationDepth: 0 }), c).shouldNotify, true)

  for (const depth of [1, 2, 7]) {
    const d = decideNotification(at({ kind: 'turn-end', delegationDepth: depth }), c)
    assert.strictEqual(d.shouldNotify, false, `depth ${depth} is a subagent`)
    assert.strictEqual(d.reason, 'subagent')
  }
})

test('turn end: debounced, and carries the summary when one was extracted', async () => {
  const { decideNotification } = await freshImport()
  const c = cfg({ turnEndEnabled: true })
  const now = 1_700_000_000_000

  const tooSoon = decideNotification({ kind: 'turn-end', now, lastSent: now - 14_999 }, c)
  assert.strictEqual(tooSoon.shouldNotify, false)
  assert.strictEqual(tooSoon.reason, 'debounced')

  const ok = decideNotification({ kind: 'turn-end', now, lastSent: now - 15_000, summary: '改完了三个文件' }, c)
  assert.strictEqual(ok.shouldNotify, true)
  assert.strictEqual(ok.body, '改完了三个文件')
})

// --- approvals and questions ---------------------------------------------

test('approval: always notifies, at any delegation depth, debounce or not', async () => {
  const { decideNotification } = await freshImport()
  const now = 1_700_000_000_000

  // Squarely inside the debounce window and from a deep subagent: still fires.
  const d = decideNotification({ kind: 'approval', now, lastSent: now - 1, toolName: 'bash', delegationDepth: 3 }, cfg())
  assert.strictEqual(d.shouldNotify, true, 'an approval must never be swallowed by the debounce')
  assert.strictEqual(d.reason, 'approval-pending')
  assert.ok(d.title, 'an approval push carries a title')
  assert.match(d.body, /bash/)

  const noName = decideNotification(at({ kind: 'approval' }), cfg())
  assert.strictEqual(noName.shouldNotify, true)
  assert.ok(noName.body && !/bash/.test(noName.body), 'a nameless approval falls back to a generic body')
})

test('question: always notifies; the question text only leaks with DSH_PUSH_SUMMARY', async () => {
  const { decideNotification } = await freshImport()
  const now = 1_700_000_000_000
  const input = { kind: 'question', now, lastSent: now - 1, question: '要用 A 还是 B？', delegationDepth: 2 }

  const quiet = decideNotification(input, cfg())
  assert.strictEqual(quiet.shouldNotify, true)
  assert.ok(quiet.body && !quiet.body.includes(input.question), 'default body carries no conversation content')

  const loud = decideNotification(input, cfg({ includeSummary: true }))
  assert.strictEqual(loud.body, '要用 A 还是 B？')
})

test('an unknown kind is inert rather than a mystery push', async () => {
  const { decideNotification } = await freshImport()
  const d = decideNotification(at({ kind: 'nonsense' }), cfg({ turnEndEnabled: true }))
  assert.strictEqual(d.shouldNotify, false)
  assert.strictEqual(d.reason, 'unknown-kind')
})

// --- summary extraction (P1: reasoning leaked into the notification body) --

test('summary takes the final TEXT output and never the reasoning that precedes it', async () => {
  const { assistantText, turnSummary } = await freshImport()

  // A single assembled assistant message carries both block kinds.
  const message = {
    content: [
      { type: 'reasoning', text: 'Let me think. Maybe the user wants X, or maybe Y...' },
      { type: 'text', text: '已经修好了，改了 dsh-push.mjs 一个文件。' }
    ]
  }
  assert.strictEqual(assistantText(message), '已经修好了，改了 dsh-push.mjs 一个文件。')

  const events = [
    { type: 'tool/call', data: { turn: 4, step: 0, name: 'bash', arguments: '{}' } },
    { type: 'assistant/message', data: { turn: 4, step: 1, message } }
  ]
  assert.strictEqual(turnSummary(events, 4), '已经修好了，改了 dsh-push.mjs 一个文件。')
})

test('summary falls back to the tool name, never to thinking text', async () => {
  const { turnSummary } = await freshImport()

  const thinkingOnly = [
    { type: 'tool/call', data: { turn: 2, step: 0, name: 'str_replace_editor', arguments: '{}' } },
    { type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'reasoning', text: 'hmm' }] } } }
  ]
  const fallback = turnSummary(thinkingOnly, 2)
  assert.match(fallback, /str_replace_editor/)
  assert.ok(!fallback.includes('hmm'), 'thinking text never becomes the summary')

  assert.strictEqual(turnSummary([], 1), '')
  assert.strictEqual(turnSummary(undefined, 1), '')
})

test('summary stops at the turn boundary and clips to 120 chars', async () => {
  const { turnSummary } = await freshImport()

  const events = [
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'previous turn answer' }] } } },
    { type: 'tool/call', data: { turn: 2, step: 0, name: 'bash', arguments: '{}' } }
  ]
  const summary = turnSummary(events, 2)
  assert.match(summary, /bash/)
  assert.ok(!summary.includes('previous turn answer'), 'must not reach back into turn 1')

  const long = { content: [{ type: 'text', text: 'x'.repeat(500) }] }
  assert.strictEqual(turnSummary([{ type: 'assistant/message', data: { turn: 1, message: long } }], 1).length, 120)
})

test('pendingQuestionText reads the first question out of raw tool arguments', async () => {
  const { pendingQuestionText } = await freshImport()

  const args = JSON.stringify({ questions: [{ id: 'q1', question: '继续吗？' }, { id: 'q2', question: '第二个' }] })
  assert.strictEqual(pendingQuestionText(args), '继续吗？')

  // The model produces this string unparsed — malformed JSON must not throw.
  assert.strictEqual(pendingQuestionText('{not json'), '')
  assert.strictEqual(pendingQuestionText('{"questions":[]}'), '')
  assert.strictEqual(pendingQuestionText(undefined), '')
})

// --- guidance text: one source for the tool description and the prompt -----

test('the push_notify guidance is one shared constant, and says when NOT to call', async () => {
  const mod = await freshImport()
  const { PUSH_NOTIFY_GUIDANCE, PUSH_NOTIFY_SECTION } = mod

  assert.match(PUSH_NOTIFY_GUIDANCE, /Do NOT call this for/, 'listing only the when-to half makes models call it every turn')
  assert.match(PUSH_NOTIFY_GUIDANCE, /ordinary end of turn/)
  assert.ok(PUSH_NOTIFY_SECTION.includes(PUSH_NOTIFY_GUIDANCE), 'session context must embed the same source string')

  // …and so must the tool description, so the two cannot drift.
  const registered = []
  const tools = { register: (t) => { registered.push(t); return () => {} } }
  const ctx = {
    on: () => {},
    inject: (deps, cb) => cb(Object.assign(Object.create(ctx), { tools, systemPrompt: { section: () => () => {} } })),
    effect: (fn) => fn()
  }
  mod.apply(ctx)
  assert.strictEqual(registered.length, 1)
  assert.ok(registered[0].description.includes(PUSH_NOTIFY_GUIDANCE), 'tool description must embed the same source string')
})

test('apply registers the standing prompt section, and survives a host without one', async () => {
  const mod = await freshImport()
  const sections = []
  const tools = { register: () => () => {} }
  const ctx = {
    on: () => {},
    inject: (deps, cb) => cb(Object.assign(Object.create(ctx), {
      tools,
      systemPrompt: { section: (s) => { sections.push(s); return () => {} } }
    })),
    effect: (fn) => fn()
  }
  mod.apply(ctx)
  assert.strictEqual(sections.length, 1)
  assert.strictEqual(sections[0].name, 'dsh-zen-remote-push')
  assert.strictEqual(sections[0].order, 150)
  assert.strictEqual(sections[0].text, mod.PUSH_NOTIFY_SECTION)

  // A host that never provides systemPrompt must not blow up the plugin.
  const bare = { on: () => {}, inject: (deps, cb) => { if (deps.includes('systemPrompt')) return; cb(Object.assign(Object.create(bare), { tools })) }, effect: (fn) => fn() }
  assert.doesNotThrow(() => mod.apply(bare))
})

// --- wiring: the event leg reaches the pure layer with the right kinds -----

test('session/event wiring: a decided approval is not pushed, an undecided one is', async () => {
  // Shrink the grace so the test stays fast; the wiring under test is the same.
  process.env.DSH_PUSH_APPROVAL_GRACE_MS = '200'
  const mod = await freshImport()
  const listeners = new Map()
  const ctx = {
    on: (event, cb) => { listeners.set(event, cb); return () => {} },
    inject: () => {},
    effect: (fn) => fn()
  }
  mod.apply(ctx)
  const onSessionEvent = listeners.get('session/event')
  assert.ok(onSessionEvent, 'the plugin must listen on session/event')

  const sent = []
  const original = global.fetch
  global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ ok: true, sent: 1 }) } }
  try {
    // Auto-resolved approval: asked then immediately decided → no push.
    onSessionEvent({}, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } })
    onSessionEvent({}, { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } })

    // Genuinely pending approval: asked, never decided → pushes after the grace.
    onSessionEvent({}, { type: 'approval/asked', data: { id: 'a2', toolName: 'write_file' } })

    // A question needs no grace period — nothing auto-answers a human.
    onSessionEvent({}, { type: 'tool/call', data: { turn: 1, name: 'ask_user_question', arguments: '{"questions":[{"id":"q","question":"ok?"}]}' } })
    onSessionEvent({}, { type: 'tool/call', data: { turn: 1, name: 'bash', arguments: '{}' } })

    await new Promise((r) => setTimeout(r, 500))
    const titles = sent.map((s) => s.title)
    const titleOf = (kind) => mod.decideNotification({ kind, now: 0, lastSent: 0 }, cfg()).title
    assert.deepStrictEqual(titles, [titleOf('question'), titleOf('approval')], 'question fires immediately, the still-pending approval after its grace period')
    assert.match(sent[1].body, /write_file/)
  } finally { global.fetch = original; delete process.env.DSH_PUSH_APPROVAL_GRACE_MS }
})

test('a machine answerer that takes seconds must not trigger a notification', async () => {
  // The 1500ms window assumed every answerer settles in the same tick. A
  // model-backed one (dsh-auto-approve) takes 2-3s: at 1500ms the timer won
  // the race and pushed "waiting for your approval" for a request that was
  // auto-approved a second later — notification arrived, prompt never did.
  process.env.DSH_PUSH_APPROVAL_GRACE_MS = '400'
  const mod = await freshImport()
  const listeners = new Map()
  mod.apply({ on: (e, cb) => { listeners.set(e, cb); return () => {} }, inject: () => {}, effect: (fn) => fn() })
  const onSessionEvent = listeners.get('session/event')

  const sent = []
  const original = global.fetch
  global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ ok: true, sent: 1 }) } }
  try {
    onSessionEvent({}, { type: 'approval/asked', data: { id: 'slow', toolName: 'bash' } })
    // Answerer takes a while, but still lands inside the grace window.
    await new Promise((r) => setTimeout(r, 250))
    onSessionEvent({}, { type: 'approval/decided', data: { id: 'slow', outcome: 'allowed-once' } })
    await new Promise((r) => setTimeout(r, 400))
    assert.deepStrictEqual(sent, [], 'an approval answered inside the grace window must stay silent')
  } finally { global.fetch = original; delete process.env.DSH_PUSH_APPROVAL_GRACE_MS }
})

test('an answerer slower than the grace still notifies — the window is a bet, not a guarantee', async () => {
  process.env.DSH_PUSH_APPROVAL_GRACE_MS = '150'
  const mod = await freshImport()
  const listeners = new Map()
  mod.apply({ on: (e, cb) => { listeners.set(e, cb); return () => {} }, inject: () => {}, effect: (fn) => fn() })
  const onSessionEvent = listeners.get('session/event')
  const sent = []
  const original = global.fetch
  global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ ok: true, sent: 1 }) } }
  try {
    onSessionEvent({}, { type: 'approval/asked', data: { id: 'tooslow', toolName: 'bash' } })
    await new Promise((r) => setTimeout(r, 350))
    assert.strictEqual(sent.length, 1, 'past the window it notifies — raising the window is the only lever')
  } finally { global.fetch = original; delete process.env.DSH_PUSH_APPROVAL_GRACE_MS }
})

test('turn-end: an unreadable session header stays quiet instead of assuming top level', () => {
  // decideNotification treats undefined as top level, which is correct for a
  // header that simply omits the field. The listener must therefore never
  // hand it an undefined it invented itself — otherwise a subagent turn end
  // with an unexpected payload shape would notify.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'dsh-push.mjs'), 'utf8')
  const listener = src.match(/const onTurnEnd = \(payload\) => \{([\s\S]*?)\n  \}/)
  assert.ok(listener, 'onTurnEnd still present')
  assert.match(listener[1], /if \(!header\) return/, 'bail out before firing when the header is missing')
})
