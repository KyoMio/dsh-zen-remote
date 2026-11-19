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
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { pathToFileURL } = require('node:url')

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'dsh-push.mjs')).href
let pushPromise
const freshImport = () => (pushPromise ??= import(MODULE_URL))

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

  const ok = decideNotification({ kind: 'turn-end', now, lastSent: now - 15_000, summary: '改完了三个文件' }, cfg({ turnEndEnabled: true, includeSummary: true }))
  assert.strictEqual(ok.shouldNotify, true)
  assert.strictEqual(ok.body, '改完了三个文件')
})

// --- language --------------------------------------------------------------

test('notification copy follows DSH_PUSH_LANG; zh is the default', async () => {
  const zh = await freshImport()
  assert.match(zh.decideNotification(at({ kind: 'approval', toolName: 'bash' }), cfg()).body, /需要授权/)
  assert.match(zh.turnSummary([{ type: 'tool/call', data: { turn: 1, name: 'bash', arguments: '{}' } }], 1), /^最后执行了/)

  process.env.DSH_PUSH_LANG = 'en'
  try {
    const en = await freshImport()
    assert.match(en.decideNotification(at({ kind: 'approval', toolName: 'bash' }), cfg()).body, /needs approval/)
    assert.match(en.turnSummary([{ type: 'tool/call', data: { turn: 1, name: 'bash', arguments: '{}' } }], 1), /^Last executed/)
  } finally { delete process.env.DSH_PUSH_LANG }
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

test('session/event wiring: a decided approval is not pushed, an undecided one is', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
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

    t.mock.timers.tick(200)
    await Promise.resolve()
    const titles = sent.map((s) => s.title)
    const titleOf = (kind) => mod.decideNotification({ kind, now: 0, lastSent: 0 }, cfg()).title
    assert.deepStrictEqual(titles, [titleOf('question'), titleOf('approval')], 'question fires immediately, the still-pending approval after its grace period')
    assert.match(sent[1].body, /write_file/)
  } finally { global.fetch = original; delete process.env.DSH_PUSH_APPROVAL_GRACE_MS }
})

test('a machine answerer that takes seconds must not trigger a notification', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
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
    t.mock.timers.tick(250)
    onSessionEvent({}, { type: 'approval/decided', data: { id: 'slow', outcome: 'allowed-once' } })
    t.mock.timers.tick(400)
    await Promise.resolve()
    assert.deepStrictEqual(sent, [], 'an approval answered inside the grace window must stay silent')
  } finally { global.fetch = original; delete process.env.DSH_PUSH_APPROVAL_GRACE_MS }
})

test('an answerer slower than the grace still notifies — the window is a bet, not a guarantee', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
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
    t.mock.timers.tick(150)
    await Promise.resolve()
    assert.strictEqual(sent.length, 1, 'past the window it notifies — raising the window is the only lever')
  } finally { global.fetch = original; delete process.env.DSH_PUSH_APPROVAL_GRACE_MS }
})

test('apply(ctx, {}) re-resolves config: DSH_PUSH_TURN_END=1 still lands', async () => {
  // T12-fix: an old-style caller passing an empty row object must not mask
  // the env and file layers — apply re-resolves whatever it receives, and
  // re-resolving an already-resolved values object is a no-op. (Env wins over
  // any real ~/.dsh file too, so this stays machine-independent.)
  process.env.DSH_PUSH_TURN_END = '1'
  const mod = await freshImport()
  const listeners = new Map()
  mod.apply({
    on: (e, cb) => { listeners.set(e, cb); return () => {} },
    inject: () => {},
    effect: (fn) => fn()
  }, {})
  const onTurnEnd = listeners.get('agent/turn-stopping')
  assert.ok(onTurnEnd, 'turn-end leg still wired')

  const sent = []
  const original = global.fetch
  global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ ok: true, sent: 1 }) } }
  try {
    onTurnEnd({ agent: { session: { header: {} } } })
    await Promise.resolve()
    assert.strictEqual(sent.length, 1, 'the env layer must survive an empty config object')
  } finally { global.fetch = original; delete process.env.DSH_PUSH_TURN_END }
})

test('turn-end: an unreadable session header stays quiet instead of assuming top level', () => {
  // decideNotification treats undefined as top level, which is correct for a
  // header that simply omits the field. The listener must therefore never
  // hand it an undefined it invented itself — otherwise a subagent turn end
  // with an unexpected payload shape would notify.
  const src = fs.readFileSync(path.join(__dirname, '..', 'dsh-push.mjs'), 'utf8')
  const listener = src.match(/const onTurnEnd = \(payload\) => \{([\s\S]*?)\n  \}/)
  assert.ok(listener, 'onTurnEnd still present')
  assert.match(listener[1], /if \(!header\) return/, 'bail out before firing when the header is missing')
})

// --- session title (P55-1) ---------------------------------------------------

test('sessionTitle extracts the newest session/title, skips blank titles, clips to 40', async () => {
  const { sessionTitle } = await freshImport()

  // Scanned from the end: the LAST title event wins, whitespace collapsed.
  const events = [
    { type: 'session/title', data: { title: 'First name' } },
    { type: 'assistant/message', data: { turn: 1 } },
    { type: 'session/title', data: { title: '  Renamed \n later ' } },
  ]
  assert.strictEqual(sessionTitle(events), 'Renamed later')

  // A blank title does not win — an older named one still answers.
  assert.strictEqual(
    sessionTitle([{ type: 'session/title', data: { title: '   ' } }, { type: 'session/title', data: { title: 'real' } }]),
    'real',
  )
  assert.strictEqual(sessionTitle([{ type: 'session/title', data: { title: '\n\t' } }]), '')

  // Clipped to SESSION_TITLE_MAX (40) characters.
  assert.strictEqual(sessionTitle([{ type: 'session/title', data: { title: 'x'.repeat(60) } }]).length, 40)

  // Garbage in, '' out.
  assert.strictEqual(sessionTitle(undefined), '')
  assert.strictEqual(sessionTitle('nope'), '')
  assert.strictEqual(sessionTitle([]), '')
  assert.strictEqual(sessionTitle([{ type: 'tool/call', data: { name: 'bash' } }]), '')
  assert.strictEqual(sessionTitle([{ type: 'session/title', data: { title: 42 } }]), '')
})

test('pushEnabled:false skips every kind as push-disabled; absent cfg field stays on', async () => {
  const { decideNotification } = await freshImport()
  const c = cfg({ pushEnabled: false, turnEndEnabled: true })
  for (const kind of ['turn-end', 'approval', 'question']) {
    const d = decideNotification(at({ kind, toolName: 'bash', question: 'q?', summary: 's', delegationDepth: 0 }), c)
    assert.strictEqual(d.shouldNotify, false, `${kind} must be skipped when the master switch is off`)
    assert.strictEqual(d.reason, 'push-disabled')
    assert.strictEqual(d.title, '')
    assert.strictEqual(d.body, '')
  }
  // Backward compat: policy tests (and old callers) build cfg without the
  // field — absent must read as "on", never as disabled.
  assert.strictEqual(decideNotification(at({ kind: 'approval', toolName: 'bash' }), cfg()).shouldNotify, true)
})

test('includeSessionName prefixes a second body line on every kind; titles unchanged in all four quadrants', async () => {
  const mod = await freshImport()
  const { decideNotification } = mod

  const NAME = '重构登录模块'
  const named = (over) => cfg({ includeSessionName: true, ...over })
  const unnamed = (over) => cfg(over)
  const input = (over) => at({ sessionName: NAME, toolName: 'bash', question: '要用 A 还是 B？', summary: '改完了', delegationDepth: 0, ...over })

  // --- turn-end (opt-in on, not debounced) ---
  const turnEndTitle = decideNotification(input({ kind: 'turn-end' }), unnamed({ turnEndEnabled: true })).title
  assert.strictEqual(turnEndTitle, 'DSH 任务完成')
  const quads = [
    { name: false, summary: false, body: '智能体已完成当前回合' },
    { name: true, summary: false, body: `来源会话：${NAME}\n智能体已完成当前回合` },
    { name: false, summary: true, body: '改完了' },
    { name: true, summary: true, body: `来源会话：${NAME}\n改完了` },
  ]
  for (const q of quads) {
    const d = decideNotification(input({ kind: 'turn-end' }), unnamed({ turnEndEnabled: true, includeSummary: q.summary, includeSessionName: q.name }))
    assert.strictEqual(d.shouldNotify, true)
    assert.strictEqual(d.title, turnEndTitle, 'the turn-end title must not change with the session-name switch')
    assert.strictEqual(d.body, q.body, `turn-end quadrant name:${q.name} summary:${q.summary}`)
  }

  // --- approval ---
  const approvalTitle = decideNotification(input({ kind: 'approval' }), unnamed()).title
  assert.strictEqual(approvalTitle, 'DSH 等你授权')
  const approvalQuads = [
    { name: false, summary: false, body: 'bash 需要授权才能继续' },
    { name: true, summary: false, body: `来源会话：${NAME}\nbash 需要授权才能继续` },
  ]
  for (const q of approvalQuads) {
    const d = decideNotification(input({ kind: 'approval' }), unnamed({ includeSummary: q.summary, includeSessionName: q.name }))
    assert.strictEqual(d.shouldNotify, true)
    assert.strictEqual(d.title, approvalTitle, 'the approval title must not change with the session-name switch')
    assert.strictEqual(d.body, q.body, `approval quadrant name:${q.name} summary:${q.summary}`)
  }

  // --- question ---
  const questionTitle = decideNotification(input({ kind: 'question' }), unnamed()).title
  assert.strictEqual(questionTitle, 'DSH 等你回答')
  const questionQuads = [
    { name: false, summary: false, body: '智能体提了一个问题，正在等你回答' },
    { name: true, summary: false, body: `来源会话：${NAME}\n智能体提了一个问题，正在等你回答` },
    { name: false, summary: true, body: '要用 A 还是 B？' },
    { name: true, summary: true, body: `来源会话：${NAME}\n要用 A 还是 B？` },
  ]
  for (const q of questionQuads) {
    const d = decideNotification(input({ kind: 'question' }), unnamed({ includeSummary: q.summary, includeSessionName: q.name }))
    assert.strictEqual(d.shouldNotify, true)
    assert.strictEqual(d.title, questionTitle, 'the question title must not change with the session-name switch')
    assert.strictEqual(d.body, q.body, `question quadrant name:${q.name} summary:${q.summary}`)
  }
})

test('sessionName: English copy reads "Session: <name>", a blank or non-string name degrades to one line', async () => {
  process.env.DSH_PUSH_LANG = 'en'
  try {
    const { decideNotification } = await freshImport()
    const enNamed = decideNotification(at({ kind: 'approval', toolName: 'bash', sessionName: 'refactor login' }), cfg({ includeSessionName: true }))
    assert.strictEqual(enNamed.body, 'Session: refactor login\nbash needs approval to continue')

    // A whitespace-only name is clipped to '' — no empty prefix line.
    const blank = decideNotification(at({ kind: 'approval', toolName: 'bash', sessionName: '   ' }), cfg({ includeSessionName: true }))
    assert.strictEqual(blank.body, 'bash needs approval to continue')

    // A non-string sessionName (the field never made it into the fire input)
    // degrades to the plain single-line body.
    const absent = decideNotification(at({ kind: 'approval', toolName: 'bash', sessionName: undefined }), cfg({ includeSessionName: true }))
    assert.strictEqual(absent.body, 'bash needs approval to continue')

    // A legacy caller without includeSessionName at all stays single-line.
    const legacy = decideNotification(at({ kind: 'approval', toolName: 'bash', sessionName: 'refactor login' }), cfg())
    assert.strictEqual(legacy.body, 'bash needs approval to continue')
  } finally { delete process.env.DSH_PUSH_LANG }
})

test('wiring: sessionName rides fire() into the body, resolved from the session event log', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  process.env.DSH_PUSH_APPROVAL_GRACE_MS = '60'
  const mod = await freshImport()
  const listeners = new Map()
  mod.apply({
    on: (e, cb) => { listeners.set(e, cb); return () => {} },
    inject: () => {},
    effect: (fn) => fn()
  }, { pushSessionName: true, pushSummary: false, lang: 'zh' })
  const onSessionEvent = listeners.get('session/event')
  assert.ok(onSessionEvent, 'the plugin still listens on session/event')

  const sent = []
  const original = global.fetch
  global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ ok: true, sent: 1 }) } }
  try {
    const session = { id: 's-named', events: [{ type: 'session/title', data: { title: '  排查 \n 推送 ' } }] }
    // Question leg fires immediately — no grace timer involved.
    onSessionEvent(session, { type: 'tool/call', data: { name: 'ask_user_question', arguments: '{"questions":[{"question":"继续吗？"}]}' } })
    // Approval leg fires after the (shrunk) grace period.
    onSessionEvent(session, { type: 'approval/asked', data: { id: 'w-named', toolName: 'bash' } })
    t.mock.timers.tick(60)
    await Promise.resolve()
    assert.strictEqual(sent.length, 2, 'both legs fired')
    assert.strictEqual(sent[0].body, '来源会话：排查 推送\n智能体提了一个问题，正在等你回答')
    assert.strictEqual(sent[1].body, '来源会话：排查 推送\nbash 需要授权才能继续')
  } finally { global.fetch = original; delete process.env.DSH_PUSH_APPROVAL_GRACE_MS }
})

// ---- sessionEvents: the turn-summary event log read, both DSH versions (merged from push.test.cjs) ----

test('sessionEvents: 0.1.1 array form feeds turnSummary identically to a bare array', async () => {
  const { sessionEvents, turnSummary } = await freshImport()
  const events = [
    { type: 'tool/call', data: { turn: 7, step: 0, name: 'bash', arguments: '{}' } },
    { type: 'assistant/message', data: { turn: 7, step: 1, message: { content: [{ type: 'text', text: '改完收工' }] } } }
  ]
  const direct = turnSummary(events, 7)
  const viaGetter = turnSummary(sessionEvents({ events }), 7)
  assert.strictEqual(viaGetter, direct)
  assert.match(viaGetter, /改完收工/)
})

test('sessionEvents: 0.1.2 method form produces the exact same summary as the array form', async () => {
  const { sessionEvents, turnSummary } = await freshImport()
  const events = [
    { type: 'tool/call', data: { turn: 7, step: 0, name: 'bash', arguments: '{}' } },
    { type: 'assistant/message', data: { turn: 7, step: 1, message: { content: [{ type: 'text', text: '改完收工' }] } } }
  ]
  const direct = turnSummary(events, 7)
  const viaMethod = turnSummary(sessionEvents({ snapshotEvents: () => events }), 7)
  assert.strictEqual(viaMethod, direct, 'both DSH readers must yield byte-identical summaries')
})

test('sessionEvents: no reader available ({} or undefined) yields [] → empty summary', async () => {
  const { sessionEvents, turnSummary } = await freshImport()
  assert.deepStrictEqual(sessionEvents({}), [])
  assert.deepStrictEqual(sessionEvents(undefined), [])
  assert.strictEqual(turnSummary(sessionEvents({}), 7), '')
  assert.strictEqual(turnSummary(sessionEvents(undefined), 7), '')
})

test('T9: dsh-push honors lan-gate-runtime.json port, rejects NaN approval grace, bounds titlesBySession and clears armed timers on dispose', async (t) => {

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-push-t9-'))
  const prevHome = process.env.DSH_HOME
  const prevGrace = process.env.DSH_PUSH_APPROVAL_GRACE_MS
  process.env.DSH_HOME = home
  process.env.DSH_PUSH_APPROVAL_GRACE_MS = 'not-a-number'
  t.after(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevGrace === undefined) delete process.env.DSH_PUSH_APPROVAL_GRACE_MS
    else process.env.DSH_PUSH_APPROVAL_GRACE_MS = prevGrace
    try { fs.rmSync(home, { recursive: true, force: true }) } catch (e) {}
  })

  // Start mock gateway push receiver on ephemeral port while configured port is different
  const received = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      received.push(JSON.parse(body || '{}'))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, sent: 1, failed: 0 }))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const actualPort = srv.address().port
  t.after(() => new Promise((r) => srv.close(r)))

  fs.writeFileSync(path.join(home, 'lan-gate-runtime.json'), JSON.stringify({ pid: process.pid, port: actualPort }), 'utf8')

  const listeners = []
  const cleanups = []
  const ctx = {
    on: (ev, fn) => { listeners.push({ ev, fn }); return () => {} },
    inject: () => {},
    effect: (fn) => {
      const stop = fn()
      if (typeof stop === 'function') cleanups.push(stop)
      return stop
    },
  }
  const { apply } = await freshImport()
  apply(ctx, { port: 19999, pushEnabled: true, pushTurnEnd: true })

  const sessionListener = listeners.find((l) => l.ev === 'session/event')?.fn
  assert.ok(sessionListener)

  // With NaN DSH_PUSH_APPROVAL_GRACE_MS, approval/asked must NOT fire immediately (1ms fallback of NaN)
  sessionListener({ id: 's-grace' }, { type: 'approval/asked', data: { id: 'req-1', toolName: 'bash' } })
  await new Promise((r) => setTimeout(r, 40))
  assert.strictEqual(received.length, 0, 'invalid DSH_PUSH_APPROVAL_GRACE_MS must fall back to 5000ms, not fire in 1ms as NaN')

  // Disposal clears pending armed timers
  for (const stop of cleanups) stop()

  // Question event still uses actualPort from lan-gate-runtime.json instead of stale configured 19999
  sessionListener({ id: 's-q' }, { type: 'tool/call', data: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ question: 'ok?' }] }) } })
  await new Promise((r) => setTimeout(r, 60))
  assert.strictEqual(received.length, 1, 'push must reach actual listening port from lan-gate-runtime.json')
})

// ---- Issue #61 T3: push-event-snapshot-avoidance --------------------------

function makePushTestCtx(t, options = {}) {
  const listeners = new Map()
  const cleanups = []
  const sent = []
  const prevFetch = global.fetch
  global.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body))
    return { ok: true, status: 200, json: async () => ({ ok: true, sent: 1 }) }
  }
  t.after(() => {
    for (const stop of cleanups) {
      try { stop() } catch { /* ignore */ }
    }
    global.fetch = prevFetch
  })
  const services = options.services || {}
  const ctx = {
    on: (ev, cb) => { listeners.set(ev, cb); return () => {} },
    inject: () => {},
    effect: (fn) => {
      const stop = fn()
      if (typeof stop === 'function') cleanups.push(stop)
      return stop
    },
    ...(options.withReflect === false ? {} : { reflect: { get: (name) => services[name] } }),
  }
  return { ctx, listeners, sent }
}

test('T3 push: pushTurnEnd:false with pushSessionName:true makes 0 snapshotEvents() calls', async (t) => {
  const mod = await freshImport()
  const { ctx, listeners, sent } = makePushTestCtx(t)
  mod.apply(ctx, { pushEnabled: true, pushTurnEnd: false, pushSummary: true, pushSessionName: true, pushTool: false })

  let snapshotCalls = 0
  const session = {
    id: 's-off',
    header: {},
    snapshotEvents: () => { snapshotCalls += 1; return [] },
  }
  listeners.get('agent/turn-stopping')({ turn: 1, agent: { session } })
  await Promise.resolve()
  assert.strictEqual(snapshotCalls, 0)
  assert.strictEqual(sent.length, 0)
})

test('T3 push: subagent turn-end and debounce window short-circuit with 0 snapshotEvents() calls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 })
  const mod = await freshImport()
  const { ctx, listeners, sent } = makePushTestCtx(t)
  mod.apply(ctx, {
    pushEnabled: true,
    pushTurnEnd: true,
    pushDebounceMs: 15000,
    pushSummary: true,
    pushSessionName: true,
    pushTool: false,
    lang: 'zh',
  })

  const onTurnEnd = listeners.get('agent/turn-stopping')
  let subCalls = 0
  onTurnEnd({
    turn: 1,
    agent: {
      session: {
        id: 's-sub',
        header: { delegationDepth: 1 },
        snapshotEvents: () => { subCalls += 1; return [] },
      },
    },
  })
  assert.strictEqual(subCalls, 0)
  assert.strictEqual(sent.length, 0)

  // First top-level turn-end sends and arms debounce clock.
  let topCalls = 0
  const topSession = {
    id: 's-top',
    header: {},
    snapshotEvents: () => {
      topCalls += 1
      return [{ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '完成' }] } } }]
    },
  }
  onTurnEnd({ turn: 1, agent: { session: topSession } })
  await Promise.resolve()
  assert.strictEqual(topCalls, 1)
  assert.strictEqual(sent.length, 1)

  // Second turn-end inside debounce window must short-circuit BEFORE snapshotEvents().
  t.mock.timers.tick(5000)
  onTurnEnd({ turn: 2, agent: { session: topSession } })
  await Promise.resolve()
  assert.strictEqual(topCalls, 1, 'debounced turn-end must not call snapshotEvents()')
  assert.strictEqual(sent.length, 1)
})

test('T3 push: pushTurnEnd:true, pushSummary:false with cached title makes 0 snapshotEvents() calls', async (t) => {
  const mod = await freshImport()
  const { ctx, listeners, sent } = makePushTestCtx(t)
  mod.apply(ctx, {
    pushEnabled: true,
    pushTurnEnd: true,
    pushDebounceMs: 0,
    pushSummary: false,
    pushSessionName: true,
    pushTool: false,
    lang: 'zh',
  })

  let snapshotCalls = 0
  const session = {
    id: 's-cached',
    header: {},
    snapshotEvents: () => { snapshotCalls += 1; return [] },
  }
  listeners.get('session/event')(session, { type: 'session/title', data: { title: '缓存标题' } })
  listeners.get('agent/turn-stopping')({ turn: 1, agent: { session } })
  await Promise.resolve()
  assert.strictEqual(snapshotCalls, 0)
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0].body, '来源会话：缓存标题\n智能体已完成当前回合')
})

test('T3 push: ctx.reflect.get("sessionProjections") resolves title or explicit null with 0 snapshotEvents() calls', async (t) => {
  const mod = await freshImport()
  const projCalls = []
  const sessionProjections = {
    cachedSnapshot: (session, keys) => {
      projCalls.push(['cachedSnapshot', session.id, keys])
      if (session.id === 's-proj-hit') return { asOfSeq: 1, values: { title: '投影标题' } }
      return undefined
    },
    snapshot: (session, keys) => {
      projCalls.push(['snapshot', session.id, keys])
      if (session.id === 's-proj-null') return { asOfSeq: 1, values: { title: null } }
      return { asOfSeq: 1, values: {} }
    },
  }
  const { ctx, listeners, sent } = makePushTestCtx(t, { services: { sessionProjections } })
  mod.apply(ctx, {
    pushEnabled: true,
    pushTurnEnd: true,
    pushDebounceMs: 0,
    pushSummary: false,
    pushSessionName: true,
    pushTool: false,
    lang: 'zh',
  })

  let snapshotCalls = 0
  const hitSession = { id: 's-proj-hit', header: {}, snapshotEvents: () => { snapshotCalls += 1; return [] } }
  const nullSession = { id: 's-proj-null', header: {}, snapshotEvents: () => { snapshotCalls += 1; return [] } }

  listeners.get('agent/turn-stopping')({ turn: 1, agent: { session: hitSession } })
  listeners.get('agent/turn-stopping')({ turn: 1, agent: { session: nullSession } })
  await Promise.resolve()

  assert.strictEqual(snapshotCalls, 0)
  assert.strictEqual(sent.length, 2)
  assert.strictEqual(sent[0].body, '来源会话：投影标题\n智能体已完成当前回合')
  assert.strictEqual(sent[1].body, '智能体已完成当前回合')
  assert.deepStrictEqual(projCalls, [
    ['cachedSnapshot', 's-proj-hit', ['title']],
    ['cachedSnapshot', 's-proj-null', ['title']],
    ['snapshot', 's-proj-null', ['title']],
  ])
})

test('T3 push: negative title cache avoids repeated snapshotEvents(); blank title never erases cached title', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 })
  process.env.DSH_PUSH_APPROVAL_GRACE_MS = '50'
  t.after(() => { delete process.env.DSH_PUSH_APPROVAL_GRACE_MS })

  const mod = await freshImport()
  const { ctx, listeners, sent } = makePushTestCtx(t, { withReflect: false })
  mod.apply(ctx, {
    pushEnabled: true,
    pushTurnEnd: false,
    pushSummary: false,
    pushSessionName: true,
    pushTool: false,
    lang: 'zh',
  })

  let snapshotCalls = 0
  const session = {
    id: 's-neg',
    snapshotEvents: () => {
      snapshotCalls += 1
      return [{ type: 'assistant/message', data: { turn: 1 } }]
    },
  }
  const onEvent = listeners.get('session/event')
  // First question scans once and negative-caches ''.
  onEvent(session, { type: 'tool/call', data: { name: 'ask_user_question', arguments: '{"questions":[{"question":"q1?"}]}' } })
  // Second question + approval hit negative cache -> 0 additional snapshotEvents() calls.
  onEvent(session, { type: 'tool/call', data: { name: 'ask_user_question', arguments: '{"questions":[{"question":"q2?"}]}' } })
  onEvent(session, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } })
  t.mock.timers.tick(50)
  await Promise.resolve()

  assert.strictEqual(snapshotCalls, 1, 'untitled session should only scan event log once via negative cache')
  assert.strictEqual(sent.length, 3)
  assert.strictEqual(sent[0].body, '智能体提了一个问题，正在等你回答')

  // Non-empty session/title refreshes cache; blank session/title must NOT erase it.
  onEvent(session, { type: 'session/title', data: { title: '新标题' } })
  onEvent(session, { type: 'session/title', data: { title: '   \n  ' } })
  onEvent(session, { type: 'tool/call', data: { name: 'ask_user_question', arguments: '{"questions":[{"question":"q3?"}]}' } })
  await Promise.resolve()

  assert.strictEqual(snapshotCalls, 1)
  assert.strictEqual(sent.length, 4)
  assert.strictEqual(sent[3].body, '来源会话：新标题\n智能体提了一个问题，正在等你回答')
})

test('T3 push: pushSummary:true + pushSessionName:true with cache/projection miss copies snapshotEvents() only once', async (t) => {
  const mod = await freshImport()
  const { ctx, listeners, sent } = makePushTestCtx(t, { withReflect: false })
  mod.apply(ctx, {
    pushEnabled: true,
    pushTurnEnd: true,
    pushDebounceMs: 0,
    pushSummary: true,
    pushSessionName: true,
    pushTool: false,
    lang: 'zh',
  })

  let snapshotCalls = 0
  const session = {
    id: 's-both',
    header: {},
    snapshotEvents: () => {
      snapshotCalls += 1
      return [
        { type: 'session/title', data: { title: '双开会话' } },
        { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '全部完成' }] } } },
      ]
    },
  }
  listeners.get('agent/turn-stopping')({ turn: 2, agent: { session } })
  await Promise.resolve()

  assert.strictEqual(snapshotCalls, 1)
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0].body, '来源会话：双开会话\n全部完成')
})
