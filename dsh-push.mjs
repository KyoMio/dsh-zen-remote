// dsh-zen-remote · dsh-push.mjs — agent-done push host plugin (OPTIONAL)
//
// Sends a mobile push notification (via the gateway's local /pwa/push/send)
// when a DSH agent finishes a turn, and (optionally) registers a
// model-callable push_notify tool. Deliberately minimal and defensive:
//
//   - inject: [] — uses only the Cordis event bus (ctx.on), no services, so
//     0811 strict injection can never block loading. The push_notify tool
//     registration below fetches the "tools" service via ctx.get('tools')
//     (not a hard inject) and no-ops when it isn't present.
//   - Event names are configurable: DSH_PUSH_EVENTS (comma-separated).
//     Default "agent/turn-stopping" — the official turn-close checkpoint
//     ("the turn is about to close: the model owes no response"), payload
//     { agent, turn, signal }, per deepseek-harness docs/subsystems/core
//     and the scoped-events catalog. An unknown name simply never fires.
//   - Debounced: at most one notification per DSH_PUSH_DEBOUNCE_MS (default
//     15s), so event bursts produce a single nudge.
//   - By default the notification carries NO conversation content. Set
//     DSH_PUSH_SUMMARY=1 to include the turn's final assistant message
//     (truncated). The payload is aes128gcm-encrypted end-to-end, so the
//     push service (FCM/APNs/Mozilla) only ever sees ciphertext — the
//     remaining exposure is your own lock screen / notification center.
//   - push_notify (model tool, on by default): lets the agent itself ask for
//     a push mid-task instead of only on turn-close. Set DSH_PUSH_TOOL=0 or
//     {"pushTool": false} in lan-gate.config.json to turn it off. Same
//     encrypted delivery path as above, throttled independently (see
//     registerPushTool below) so a chatty model can't spam the lock screen.
export const name = 'dsh-zen-remote-push'
export const inject = []

import { defineTool } from '@deepseek-ai/dsh-tools'

// Shares the gateway's optional config file <DSH_HOME>/lan-gate.config.json
// (keys: port, pushEvents, pushDebounceMs, pushSummary). Explicit env wins.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
function fileConfig() {
  try {
    const raw = JSON.parse(readFileSync(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'lan-gate.config.json'), 'utf8'))
    return raw !== null && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}
const FILE = fileConfig()
const GATEWAY_PORT = Number(process.env.LAN_GATE_PORT ?? FILE.port ?? 3088)
const EVENTS = String(process.env.DSH_PUSH_EVENTS ?? FILE.pushEvents ?? 'agent/turn-stopping').split(',').map((s) => s.trim()).filter(Boolean)
const DEBOUNCE_MS = Number(process.env.DSH_PUSH_DEBOUNCE_MS ?? FILE.pushDebounceMs ?? 15000)
const INCLUDE_SUMMARY = process.env.DSH_PUSH_SUMMARY !== undefined ? process.env.DSH_PUSH_SUMMARY === '1' : FILE.pushSummary === true || FILE.pushSummary === 1 || FILE.pushSummary === '1'
const PUSH_TOOL_ENABLED = process.env.DSH_PUSH_TOOL !== undefined ? process.env.DSH_PUSH_TOOL !== '0' : FILE.pushTool !== false

// Low-level sender shared by the turn-close notify() below and the
// push_notify tool: POSTs to the gateway's local /pwa/push/send, which does
// the actual VAPID + aes128gcm encrypted delivery to every subscribed
// device and replies { ok, sent, failed }.
async function sendPush(title, body) {
  const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/pwa/push/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body: body || '' })
  })
  if (!res.ok) throw new Error(`push send failed: HTTP ${res.status}`)
  return res.json()
}

// AssistantMessage content may be a plain string or an array of parts.
function messageText(message) {
  if (!message) return ''
  const c = message.content !== undefined ? message.content : message
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : ''))).join(' ').trim()
  }
  return ''
}

// Last `assistant/message` of the closing turn, from the session's
// append-only event log (agent.session.events, see docs/subsystems/session).
function turnSummary(payload) {
  try {
    const events = payload && payload.agent && payload.agent.session && payload.agent.session.events
    if (!events || !events.length) return ''
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev && ev.type === 'assistant/message' && ev.data && (payload.turn === undefined || ev.data.turn === payload.turn)) {
        return messageText(ev.data.message).replace(/\s+/g, ' ').trim().slice(0, 120)
      }
    }
  } catch (e) { /* summary is best-effort */ }
  return ''
}

// Rate limits for the push_notify tool. Fixed on purpose (not config knobs)
// — these exist to keep pushes meaningful, not to be tuned per-deployment.
const PUSH_TOOL_SESSION_WINDOW_MS = 60_000
const PUSH_TOOL_GLOBAL_WINDOW_MS = 60 * 60_000
const PUSH_TOOL_GLOBAL_MAX = 20

// Registers the push_notify model tool against ctx.tools, if present and not
// disabled. Throttle state lives in this closure (fresh per apply() call, so
// tests get isolated state without needing a fresh module import).
function registerPushTool(ctx) {
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
  ctx.inject(['tools'], (toolsCtx) => registerPushToolWith(toolsCtx, toolsCtx.tools))
}

function registerPushToolWith(ctx, tools) {
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
    description: 'Push a notification to the user\'s phone lock screen via the DSH mobile PWA. Reserve this for moments that genuinely need the user\'s attention away from the screen: a decision is required to continue a long-running task, a significant milestone just completed, or an error needs human intervention before you can proceed. Do NOT call this for routine progress updates, minor sub-steps, or anything the user can find by just re-opening the chat — pushes are throttled (at most 1 per 60 seconds in this session, 20 total per hour across all sessions) specifically to keep them meaningful; calling it too often gets it silently dropped instead of sent. `title` must be a short, complete sentence that fits on one lock-screen line; `body` is optional extra detail shown when the notification is expanded. Delivery is end-to-end encrypted (aes128gcm) — the push provider (FCM/APNs/Mozilla) only ever sees ciphertext, and the only exposure is the phone\'s own lock screen / notification center. Sends to every device the user has paired and subscribed; returns how many actually received it, or throttled:true if the rate limit dropped the call before sending.',
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

export function apply(ctx) {
  let lastSent = 0

  const notify = (payload) => {
    const now = Date.now()
    if (now - lastSent < DEBOUNCE_MS) return
    lastSent = now
    const summary = INCLUDE_SUMMARY ? turnSummary(payload) : ''
    // Best-effort; never raise into the host.
    sendPush('DSH 任务完成', summary || '智能体已完成当前回合').catch(() => {})
  }

  for (const event of EVENTS) {
    try {
      ctx.on(event, notify)
    } catch (e) {
      console.warn(`[dsh-zen-remote-push] cannot listen on "${event}": ${String(e && e.message || e)}`)
    }
  }
  console.log(`[dsh-zen-remote-push] listening for: ${EVENTS.join(', ')} (set DSH_PUSH_EVENTS to adjust)`)

  registerPushTool(ctx)
}
