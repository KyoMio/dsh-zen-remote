// dsh-zen-remote · dsh-push.mjs — mobile push host plugin (OPTIONAL)
//
// Two-legged notification policy (docs/push-policy.md):
//
//   Event leg (deterministic, always fires) — the things that BLOCK the user:
//     · a tool approval is waiting on a human  (session event `approval/asked`
//       with no `approval/decided` within APPROVAL_PENDING_MS)
//     · a question is waiting on a human       (session event `tool/call` for
//       `ask_user_question`)
//   Model leg (judgement call) — the `push_notify` tool.
//   Turn end is OPT-IN (DSH_PUSH_TURN_END=1). Finishing a turn is not by
//   itself a reason to buzz someone's pocket.
//
// Deliberately minimal and defensive:
//   - inject: [] — only the Cordis event bus (ctx.on), no hard service deps,
//     so 0811 strict injection can never block loading. The push_notify tool
//     and the system-prompt reinforcement are attached via ctx.inject() and
//     no-op when the host provides no such service.
//   - Only top-level sessions notify on turn end: the session header's
//     `delegationDepth` is ABSENT for a top-level session and parent+1 for a
//     subagent child (see @deepseek-ai/dsh-session SessionHeader), so the test
//     is `(delegationDepth ?? 0) === 0`. Subagent turn ends never push.
//   - Debounced (DSH_PUSH_DEBOUNCE_MS, default 15s) across the turn-end and
//     model legs. Approval/question notifications are NEVER swallowed by it —
//     those are exactly the ones you cannot afford to miss.
//   - By default the notification carries NO conversation content. Set
//     DSH_PUSH_SUMMARY=1 to include the turn's final TEXT output (reasoning
//     excluded) or the pending question. The payload is aes128gcm-encrypted
//     end-to-end, so the push service (FCM/APNs/Mozilla) only ever sees
//     ciphertext — the remaining exposure is your own lock screen.
export const name = 'dsh-zen-remote-push'
export const inject = []

import { defineTool } from '@deepseek-ai/dsh-tools'

// Shares the gateway's optional config file <DSH_HOME>/lan-gate.config.json
// (keys: port, pushEvents, pushDebounceMs, pushSummary, pushTurnEnd, pushTool).
// Explicit env wins.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
function fileConfig() {
  try {
    const raw = JSON.parse(readFileSync(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'lan-gate.config.json'), 'utf8'))
    return raw !== null && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}
const truthy = (v) => v === true || v === 1 || v === '1'
const FILE = fileConfig()
const GATEWAY_PORT = Number(process.env.LAN_GATE_PORT ?? FILE.port ?? 3088)
const EVENTS = String(process.env.DSH_PUSH_EVENTS ?? FILE.pushEvents ?? 'agent/turn-stopping').split(',').map((s) => s.trim()).filter(Boolean)
const DEBOUNCE_MS = Number(process.env.DSH_PUSH_DEBOUNCE_MS ?? FILE.pushDebounceMs ?? 15000)
const INCLUDE_SUMMARY = process.env.DSH_PUSH_SUMMARY !== undefined ? process.env.DSH_PUSH_SUMMARY === '1' : truthy(FILE.pushSummary)
const TURN_END_ENABLED = process.env.DSH_PUSH_TURN_END !== undefined ? process.env.DSH_PUSH_TURN_END === '1' : truthy(FILE.pushTurnEnd)
const PUSH_TOOL_ENABLED = process.env.DSH_PUSH_TOOL !== undefined ? process.env.DSH_PUSH_TOOL !== '0' : FILE.pushTool !== false

// The model-facing tool of @deepseek-ai/dsh-tool-ask-user. Its `tool/call`
// session event is appended BEFORE dispatch (dsh-agent-loop appendToolCall),
// and the call then blocks in ctx.userQuestions.ask() until a human answers —
// so the call event IS the "a question is pending" signal.
const ASK_USER_TOOL = 'ask_user_question'

// @deepseek-ai/dsh-user-approval appends `approval/asked` before consulting
// the answerer chain and `approval/decided` after — so only an ask still
// undecided after this grace period is actually waiting on a human.
//
// The window used to be 1500ms on the assumption that "a policy-resolved or
// hook-answered request settles in the same tick". That held while every
// answerer was synchronous. A model-backed answerer (dsh-auto-approve and
// anything like it) takes seconds: measured 2.4s average, 3.4s worst on a
// small model, and more on a slower one. At 1500ms the timer won the race and
// pushed "waiting for your approval" for requests that were auto-approved a
// second later — the notification arrived, the prompt never did.
//
// 5000ms covers a machine answerer with margin while still reaching a phone
// promptly when a human really is needed. Raise it if your answerer is slower
// than that; the cost of a longer window is only that genuine prompts notify
// later.
const APPROVAL_PENDING_MS = Number(
  process.env.DSH_PUSH_APPROVAL_GRACE_MS ?? FILE.pushApprovalGraceMs ?? 5000
)

// Low-level sender shared by every leg: POSTs to the gateway's local
// /pwa/push/send, which does the actual VAPID + aes128gcm encrypted delivery
// to every subscribed device and replies { ok, sent, failed }.
async function sendPush(title, body) {
  const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/pwa/push/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body: body || '' })
  })
  if (!res.ok) throw new Error(`push send failed: HTTP ${res.status}`)
  return res.json()
}

const SUMMARY_MAX = 120
const clip = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX)

// ---------------------------------------------------------------------------
// Pure decision layer. Everything below this line up to `apply()` is a pure
// function of its arguments — that is the only way to test push timing
// without creating a real DSH session (workspace hard rule). See
// test/push-policy.test.cjs.
// ---------------------------------------------------------------------------

// Model-facing TEXT of one assistant message: `type: 'text'` blocks only.
// Reasoning arrives as `{ type: 'reasoning', text }` blocks on the very same
// message (@deepseek-ai/dsh-llm ContentBlockMap) — taking every part that
// happens to own a `.text` is what made DSH_PUSH_SUMMARY quote the model's
// thinking instead of its answer.
export function assistantText(message) {
  const c = message && message.content !== undefined ? message.content : message
  if (typeof c === 'string') return clip(c)
  if (!Array.isArray(c)) return ''
  const parts = []
  for (const p of c) {
    if (typeof p === 'string') parts.push(p)
    else if (p && p.type === 'text' && typeof p.text === 'string') parts.push(p.text)
  }
  return clip(parts.join(' '))
}

// Summary of the closing turn, from the session's append-only event log:
// the LAST assistant message that produced real text, or — when the whole
// turn was tool work with no prose — the last tool name. Never thinking text.
export function turnSummary(events, turn) {
  if (!Array.isArray(events)) return ''
  let lastTool = ''
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev || !ev.data) continue
    // Stop at the turn boundary instead of reaching back into older turns.
    if (turn !== undefined && ev.data.turn !== undefined && ev.data.turn !== turn) break
    if (ev.type === 'assistant/message') {
      const text = assistantText(ev.data.message)
      if (text) return text
    } else if (!lastTool && ev.type === 'tool/call' && typeof ev.data.name === 'string') {
      lastTool = ev.data.name
    }
  }
  return lastTool ? `最后执行了 ${lastTool}` : ''
}

// First question of an ask_user_question call, from the raw (unparsed)
// arguments string the model produced. Best-effort: garbage in, '' out.
export function pendingQuestionText(rawArguments) {
  try {
    const q = JSON.parse(String(rawArguments)).questions
    return Array.isArray(q) && q[0] && typeof q[0].question === 'string' ? clip(q[0].question) : ''
  } catch { return '' }
}

const skip = (reason) => ({ shouldNotify: false, title: '', body: '', reason })

/**
 * The whole notification policy, as one pure function.
 *
 * @param {object} input
 *   kind            'turn-end' | 'approval' | 'question'
 *   now             current epoch ms
 *   lastSent        epoch ms of the previous push (0 for none)
 *   delegationDepth session header's delegationDepth (undefined = top level)
 *   summary         already-extracted turn summary  ('turn-end')
 *   toolName        tool awaiting approval          ('approval')
 *   question        pending question text           ('question')
 * @param {object} cfg { turnEndEnabled, debounceMs, includeSummary }
 * @returns {{shouldNotify: boolean, title: string, body: string, reason: string}}
 */
export function decideNotification(input, cfg) {
  const debounced = (input.now - input.lastSent) < cfg.debounceMs

  switch (input.kind) {
    // Event leg. Exempt from the debounce on purpose: "a tool is waiting for
    // your OK" is the one notification that must never be swallowed.
    case 'approval':
      return {
        shouldNotify: true,
        title: 'DSH 等你授权',
        body: input.toolName ? `${input.toolName} 需要授权才能继续` : '有操作需要授权才能继续',
        reason: 'approval-pending'
      }
    case 'question':
      return {
        shouldNotify: true,
        title: 'DSH 等你回答',
        body: (cfg.includeSummary && input.question) || '智能体提了一个问题，正在等你回答',
        reason: 'question-pending'
      }

    // Turn end. Opt-in, top-level only, debounced.
    case 'turn-end':
      if (!cfg.turnEndEnabled) return skip('turn-end-disabled')
      if ((input.delegationDepth ?? 0) !== 0) return skip('subagent')
      if (debounced) return skip('debounced')
      return { shouldNotify: true, title: 'DSH 任务完成', body: input.summary || '智能体已完成当前回合', reason: 'turn-end' }

    default:
      return skip('unknown-kind')
  }
}

// ---------------------------------------------------------------------------
// push_notify (model leg)
// ---------------------------------------------------------------------------

// THE single source of "when should you notify me". Both the tool description
// and the system-prompt reinforcement below embed this exact string, so the
// two can never drift apart. Listing only the when-to-call half is what turns
// push_notify into a per-turn reflex — the when-NOT-to half is load-bearing.
export const PUSH_NOTIFY_GUIDANCE =
  'Notify the user when: (1) they asked to be told once something is finished or a result is ready; ' +
  '(2) you cannot go on without them — a question that needs answering, an operation that needs ' +
  'authorization, a call only they can make; (3) something happened they almost certainly want to know ' +
  'immediately — the task failed, or you hit a blocker you cannot route around. ' +
  'Do NOT call this for: an ordinary end of turn, progress or status reports, intermediate milestones, ' +
  'or anything you can keep making headway on by yourself. Finishing a turn is not by itself a reason ' +
  'to buzz someone\'s phone.'

const PUSH_NOTIFY_DESCRIPTION =
  'Push a notification to the user\'s phone lock screen via the DSH mobile PWA. ' +
  PUSH_NOTIFY_GUIDANCE +
  ' Pushes are throttled (at most 1 per 60 seconds in this session, 20 total per hour across all sessions) ' +
  'specifically to keep them meaningful; calling it too often gets it silently dropped instead of sent. ' +
  '`title` must be a short, complete sentence that fits on one lock-screen line; `body` is optional extra ' +
  'detail shown when the notification is expanded. Delivery is end-to-end encrypted (aes128gcm) — the push ' +
  'provider (FCM/APNs/Mozilla) only ever sees ciphertext, and the only exposure is the phone\'s own lock ' +
  'screen / notification center. Sends to every device the user has paired and subscribed; returns how many ' +
  'actually received it, or throttled:true if the rate limit dropped the call before sending.'

// Same guidance, restated as standing context: a tool description sitting far
// up a long conversation gets diluted, and the failure mode that costs the
// user is a model that quietly stops notifying at all.
export const PUSH_NOTIFY_SECTION =
  'Reaching the user away from the screen: this deployment can push to the user\'s phone lock screen ' +
  'with the `push_notify` tool. ' + PUSH_NOTIFY_GUIDANCE +
  ' The harness already pushes on its own whenever a tool is waiting for authorization or an ' +
  '`ask_user_question` is unanswered, so you never need `push_notify` for those two.'

// Rate limits for the push_notify tool. Fixed on purpose (not config knobs)
// — these exist to keep pushes meaningful, not to be tuned per-deployment.
const PUSH_TOOL_SESSION_WINDOW_MS = 60_000
const PUSH_TOOL_GLOBAL_WINDOW_MS = 60 * 60_000
const PUSH_TOOL_GLOBAL_MAX = 20

// Registers the push_notify model tool against ctx.tools, if present and not
// disabled. Throttle state lives in this closure (fresh per apply() call, so
// tests get isolated state without needing a fresh module import).
function registerPushTool(ctx, gate) {
  if (!PUSH_TOOL_ENABLED) {
    console.log('[dsh-zen-remote-push] push_notify disabled (DSH_PUSH_TOOL=0 / pushTool:false)')
    return
  }
  // ctx.inject, NOT ctx.get: the tools service may be provided by a plugin
  // that loads AFTER this one, and get() reads the registry at call time —
  // measured live 2026-08-17: get() came back empty and the tool was never
  // registered. inject() defers the callback until the service exists (the
  // same pattern vision-toolkit uses for webServer) and still degrades
  // gracefully: hosts without a tools service simply never fire it.
  ctx.inject(['tools'], (toolsCtx) => registerPushToolWith(toolsCtx, toolsCtx.tools, gate))

  // Standing reinforcement of the same guidance. Order 150 is the documented
  // tool-guidance band (@deepseek-ai/dsh-system-prompt PromptSection.order).
  ctx.inject(['systemPrompt'], (promptCtx) => {
    if (!promptCtx.systemPrompt) return
    try {
      promptCtx.systemPrompt.section({ name: 'dsh-zen-remote-push', order: 150, text: PUSH_NOTIFY_SECTION })
      console.log('[dsh-zen-remote-push] notification guidance added to the system prompt')
    } catch (e) {
      console.warn(`[dsh-zen-remote-push] cannot register prompt section: ${String(e && e.message || e)}`)
    }
  })
}

function registerPushToolWith(ctx, tools, gate) {
  if (!tools) {
    console.log('[dsh-zen-remote-push] "tools" service not present — push_notify not registered')
    return
  }

  const lastSentBySession = new Map() // sessionId -> timestamp of last accepted call
  let globalSends = [] // timestamps of accepted calls within the last hour

  const isThrottled = (sessionId, now) => {
    const last = lastSentBySession.get(sessionId)
    if (last !== undefined && now - last < PUSH_TOOL_SESSION_WINDOW_MS) return true
    globalSends = globalSends.filter((t) => now - t < PUSH_TOOL_GLOBAL_WINDOW_MS)
    return globalSends.length >= PUSH_TOOL_GLOBAL_MAX
  }
  const reserve = (sessionId, now) => {
    lastSentBySession.set(sessionId, now)
    globalSends.push(now)
  }

  ctx.effect(() => tools.register(defineTool({
    name: 'push_notify',
    description: PUSH_NOTIFY_DESCRIPTION,
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'Short, complete-sentence notification title that fits on one lock-screen line (roughly 40-60 characters). This is the only part guaranteed visible without expanding the notification.'
      },
      body: {
        type: 'string',
        description: 'Optional extra detail shown below the title once the notification is expanded. Omit for a title-only push.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: {
            type: 'integer',
            required: true,
            description: 'Number of subscribed devices that actually received the push. 0 if nothing is subscribed, delivery failed, or the call was throttled.'
          },
          throttled: {
            type: 'boolean',
            description: 'Present and true only when the rate limiter dropped the call instead of sending it.'
          }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.throttled
          ? 'push_notify: not sent — rate limit hit (max 1 per 60s per session, 20/hour total).'
          : `push_notify: delivered to ${value.delivered} device(s).`
      }]
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      if (exec.agent === undefined) throw new Error('push_notify requires an initiating agent')
      const sessionId = exec.agent.session.id
      const now = Date.now()
      if (isThrottled(sessionId, now)) return { delivered: 0, throttled: true }
      reserve(sessionId, now)
      // Counts toward the shared debounce clock, so an automatic turn-end
      // push landing right behind this one is suppressed. Not gated BY it:
      // this leg's own 1-per-60s-per-session limit is already stricter than
      // the 15s window, and stacking both would only make the tool lie about
      // why it dropped a call.
      gate.arm(now)
      try {
        const result = await sendPush(args.title, args.body)
        return { delivered: (result && typeof result.sent === 'number') ? result.sent : 0 }
      } catch (e) {
        console.warn(`[dsh-zen-remote-push] push_notify send failed: ${String(e && e.message || e)}`)
        return { delivered: 0 }
      }
    }
  })))
  console.log('[dsh-zen-remote-push] push_notify tool registered')
}

// ---------------------------------------------------------------------------

export function apply(ctx) {
  const cfg = { turnEndEnabled: TURN_END_ENABLED, debounceMs: DEBOUNCE_MS, includeSummary: INCLUDE_SUMMARY }

  // The one piece of mutable state: when the last push went out. Wrapped so
  // every leg runs the same pure decision and shares the same debounce clock.
  let lastSent = 0
  const gate = {
    decide(input) {
      const decision = decideNotification({ ...input, now: Date.now(), lastSent }, cfg)
      if (decision.shouldNotify) lastSent = Date.now()
      return decision
    },
    arm(now) { lastSent = now }
  }
  const fire = (input) => {
    const decision = gate.decide(input)
    // Best-effort; never raise into the host.
    if (decision.shouldNotify) sendPush(decision.title, decision.body).catch(() => {})
    return decision
  }

  // --- Turn-end leg (opt-in) -----------------------------------------------
  const onTurnEnd = (payload) => {
    const session = payload && payload.agent && payload.agent.session
    const header = session && session.header
    // An ABSENT delegationDepth on a PRESENT header means top level, and the
    // decision function reads it that way. A missing header is a different
    // thing entirely — "could not tell whose turn this was" — and passing its
    // undefined through would be read as top level too, failing OPEN and
    // letting subagent turn ends back in. Turn-end is the low-value leg, so
    // when the session cannot be identified, stay quiet.
    if (!header) return
    fire({
      kind: 'turn-end',
      delegationDepth: header && header.delegationDepth,
      summary: INCLUDE_SUMMARY ? turnSummary(session && session.events, payload && payload.turn) : ''
    })
  }
  for (const event of EVENTS) {
    try {
      ctx.on(event, onTurnEnd)
    } catch (e) {
      console.warn(`[dsh-zen-remote-push] cannot listen on "${event}": ${String(e && e.message || e)}`)
    }
  }

  // --- Event leg: approvals and questions ----------------------------------
  // `session/event` is the post-commit append feed for EVERY session, subagent
  // children included — those notify through here, they just never notify on
  // turn end.
  const armed = new Map() // ApprovalRequestId -> grace timer
  try {
    ctx.on('session/event', (_session, event) => {
      if (!event || !event.data) return
      if (event.type === 'approval/asked') {
        const id = event.data.id
        const toolName = event.data.toolName
        const timer = setTimeout(() => {
          armed.delete(id)
          fire({ kind: 'approval', toolName })
        }, APPROVAL_PENDING_MS)
        if (typeof timer.unref === 'function') timer.unref()
        armed.set(id, timer)
      } else if (event.type === 'approval/decided') {
        const timer = armed.get(event.data.id)
        if (timer !== undefined) { clearTimeout(timer); armed.delete(event.data.id) }
      } else if (event.type === 'tool/call' && event.data.name === ASK_USER_TOOL) {
        fire({ kind: 'question', question: pendingQuestionText(event.data.arguments) })
      }
    })
  } catch (e) {
    console.warn(`[dsh-zen-remote-push] cannot listen on "session/event": ${String(e && e.message || e)}`)
  }

  console.log(`[dsh-zen-remote-push] approval/question notifications on (approval grace ${APPROVAL_PENDING_MS}ms); turn-end (${EVENTS.join(', ')}) ${TURN_END_ENABLED ? 'on' : 'off — set DSH_PUSH_TURN_END=1 to enable'}`)

  registerPushTool(ctx, gate)
}
