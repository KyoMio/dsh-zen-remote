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
 * The data source is readSession's SessionLogSnapshot — the COMPLETE raw log
 * in log order (the `agent/inbox/spliced` choreography the steering
 * classification folds only ever exists there). The fixture logs encode every
 * admission rule of the fold (foldRows in src/share-export.ts) as one
 * concrete event, so deepEquals over the responses pin the whole fold
 * (append-origin retention, role/source/block filters, the next-step inbox
 * state machine, and the events that must fall out of a human transcript):
 * fixtureEvents walks every fold rule, steeringEvents replays the exact
 * inbox choreography a real steered session writes (pure insert → cancel →
 * entered claim), forkEvents opens on assistant rows (turn 0), and
 * gappyEvents folds turns to zero blocks.
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

/** One message as the durable Inbox stores it inside `inserted` (the full
 * frozen message, id included — the inbox machine keys on that id). */
function inboxMessage(id, text, source) {
  return { id, role: 'user', content: [{ type: 'text', text }], source }
}

const MODEL_SOURCE = { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }

/** One conversation exercising every fold rule: a tool round, a usage-only
 * assistant event, an injected context, a mixed-block human message, an
 * unknown block type, and a replacement (compaction checkpoint) user message
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

/** The next-step inbox choreography of one steered conversation, replayed in
 * the exact shape the real harness writes (verified against a live session
 * log: pure insert for everything queued mid-turn, `outcome: 'canceled'` for
 * every public cancel, and an outcome-less REMOVING splice for the entered
 * claim at a step boundary):
 *
 *  - seq 1/2: the turn's pending input assembles — plugin instructions into
 *    next-step, the queued human question into NEXT-TURN (whose splices the
 *    classification machine must ignore entirely);
 *  - seq 3: the boundary CLAIMS the plugin message (removing splice, no
 *    outcome) → currentClaimed = {p-1};
 *  - seq 4: the claimed plugin batch logs its user/message — plugin source,
 *    so the fold drops it as a context row (being claimed changes nothing);
 *  - seq 5: the first true question (claimed via next-turn) is NOT in the
 *    next-step claim set → anchors turn 1;
 *  - seq 8/9: mid-turn, two human messages queue into next-step (PURE
 *    inserts — they must not claim anything yet);
 *  - seq 10: the second queued message is CANCELED before any boundary
 *    (removing splice WITH 'canceled') — a cancel never claims, and s-2
 *    never logs a user/message at all;
 *  - seq 11: the boundary claims what is left → currentClaimed = {s-1}
 *    (REPLACING {p-1}: only the current claim classifies);
 *  - seq 12: the steering message logs as user/message s-1, its id claimed
 *    → STEERING: stays in the transcript in place, opens no turn;
 *  - seq 14: the second true question is not in the claim set → anchors
 *    turn 2.
 */
function steeringEvents() {
  return [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [inboxMessage('p-1', 'Verifier tools are available…', { kind: 'plugin', plugin: 'dsh-llm-verifier', form: 'instructions' })] }),
    ev(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [inboxMessage('u-1', 'First question: summarize the repo.', { kind: 'user', rpcId: 'r1' })] }),
    ev(3, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
    ev(4, 'user/message', { id: 'p-1', role: 'user', content: [{ type: 'text', text: 'Verifier tools are available…' }], source: { kind: 'plugin', plugin: 'dsh-llm-verifier', form: 'instructions' } }, 'append'),
    ev(5, 'user/message', { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'First question: summarize the repo.' }], source: { kind: 'user', rpcId: 'r1' } }, 'append'),
    ev(6, 'assistant/message', { turn: 0, step: 0, message: { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
    ev(7, 'step/start', { turn: 0, step: 1 }),
    ev(8, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [inboxMessage('s-1', 'yes, use the other approach.', { kind: 'user', rpcId: 'r2' })] }),
    ev(9, 'agent/inbox/spliced', { target: 'next-step', start: 1, inserted: [inboxMessage('s-2', 'never mind, canceled while queued.', { kind: 'user', rpcId: 'r3' })] }),
    ev(10, 'agent/inbox/spliced', { target: 'next-step', start: 1, removedCount: 1, outcome: 'canceled', inserted: [] }),
    ev(11, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
    ev(12, 'user/message', { id: 's-1', role: 'user', content: [{ type: 'text', text: 'yes, use the other approach.' }], source: { kind: 'user', rpcId: 'r2' } }, 'append'),
    ev(13, 'assistant/message', { turn: 0, step: 1, message: { id: 'a-2', role: 'assistant', content: [{ type: 'text', text: 'Done, switching.' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
    ev(14, 'user/message', { id: 'u-2', role: 'user', content: [{ type: 'text', text: 'Second question: ship it?' }], source: { kind: 'user', rpcId: 'r4' } }, 'append'),
    ev(15, 'assistant/message', { turn: 1, step: 0, message: { id: 'a-3', role: 'assistant', content: [{ type: 'text', text: 'Shipped.' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
  ]
}

const STEERING_ALL = [
  { role: 'user', seq: 5, blocks: [{ kind: 'text', text: 'First question: summarize the repo.' }] },
  { role: 'assistant', seq: 6, blocks: [{ kind: 'text', text: 'Working on it.' }] },
  // The steering row: still a user bubble in the transcript, exactly where
  // the user saw it — but it opened no turn.
  { role: 'user', seq: 12, blocks: [{ kind: 'text', text: 'yes, use the other approach.' }] },
  { role: 'assistant', seq: 13, blocks: [{ kind: 'text', text: 'Done, switching.' }] },
  { role: 'user', seq: 14, blocks: [{ kind: 'text', text: 'Second question: ship it?' }] },
  { role: 'assistant', seq: 15, blocks: [{ kind: 'text', text: 'Shipped.' }] },
]

/** The cancel+insert orchestration (review 07+08): one public next-step
 * mutation with removedCount>0 AND outcome:'canceled' AND a non-empty
 * inserted batch — the in-place replace path. Choreography: the user edits
 * the queued q-2 into q-2b (removed in place, replacement inserted at the
 * same slot) while the aborted half of an already-claimed pair, q-1, returns
 * to the queue; the host coalesces both edits into one splice. The fold must
 * read the combination EXACTLY as cancel + insert separately, and each of
 * the three machine rules is observable in the response body:
 *
 *  - pending 原位替换: after [q-2,q-3] → [q-1,q-2b,q-3], the partial claim at
 *    seq 10 (start 0, two messages) removes exactly [q-2b,q-3] — had the
 *    insert appended instead of replacing in place, the queue would be
 *    [q-3,q-1,q-2b], that claim would take [q-1,q-2b] (q-1 already logged —
 *    classification happens at log time), and q-3 would ANCHOR a turn,
 *    shifting every range=last slice below;
 *  - claimed 减 inserted: q-1 was claimed at seq 5 but re-enters the inbox at
 *    seq 6, so when it logs at seq 8 — before any new claim — it is NOT
 *    steering: it opens turn 2 as a true question;
 *  - 不认领: the splice never becomes a claim itself — the pre-existing
 *    {q-0} half of the seq-5 claim SURVIVES it, so q-0's log at seq 7 stays
 *    a steering row inside turn 1 (a claim would have replaced the set with
 *    {q-2}, and q-0 would have anchored a turn of its own).
 */
function replaceEvents() {
  return [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'user/message', { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'First question: summarize the repo.' }], source: { kind: 'user', rpcId: 'r1' } }, 'append'),
    ev(2, 'assistant/message', { turn: 0, step: 0, message: { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
    ev(3, 'step/start', { turn: 0, step: 1 }),
    // Four questions queue into next-step mid-turn: [q-0, q-1, q-2, q-3].
    ev(4, 'agent/inbox/spliced', {
      target: 'next-step', start: 0,
      inserted: [
        inboxMessage('q-0', 'tweak the summary into bullet points', { kind: 'user', rpcId: 'r2' }),
        inboxMessage('q-1', 'actually, resend this one as its own question', { kind: 'user', rpcId: 'r3' }),
        inboxMessage('q-2', 'an early draft that will be edited', { kind: 'user', rpcId: 'r4' }),
        inboxMessage('q-3', 'one more queued note', { kind: 'user', rpcId: 'r5' }),
      ],
    }),
    // Boundary claims the head pair: claimed={q-0,q-1}, pending=[q-2,q-3].
    ev(5, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 2, inserted: [] }),
    // THE case: the edit of q-2 (removed in place → q-2b) folded together
    // with the aborted q-1 returning to the queue.
    ev(6, 'agent/inbox/spliced', {
      target: 'next-step', start: 0, removedCount: 1, outcome: 'canceled',
      inserted: [
        inboxMessage('q-1', 'actually, resend this one as its own question', { kind: 'user', rpcId: 'r3' }),
        inboxMessage('q-2b', 'the edited replacement of the early draft', { kind: 'user', rpcId: 'r6' }),
      ],
    }),
    // q-0 stayed claimed: its log is STEERING inside turn 1 (不认领).
    ev(7, 'user/message', { id: 'q-0', role: 'user', content: [{ type: 'text', text: 'tweak the summary into bullet points' }], source: { kind: 'user', rpcId: 'r2' } }, 'append'),
    // q-1 re-entered the inbox at seq 6, so its log is NOT steering: it
    // anchors turn 2 as a true question (claimed 减 inserted).
    ev(8, 'user/message', { id: 'q-1', role: 'user', content: [{ type: 'text', text: 'actually, resend this one as its own question' }], source: { kind: 'user', rpcId: 'r3' } }, 'append'),
    // The stale queue entry for the already-logged q-1 is cleared; the queue
    // is [q-2b, q-3].
    ev(9, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, outcome: 'canceled', inserted: [] }),
    // Partial claim from position 0: removes exactly [q-2b, q-3] — the
    // in-place-replace position pin (原位替换).
    ev(10, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 2, inserted: [] }),
    ev(11, 'user/message', { id: 'q-2b', role: 'user', content: [{ type: 'text', text: 'the edited replacement of the early draft' }], source: { kind: 'user', rpcId: 'r6' } }, 'append'),
    ev(12, 'user/message', { id: 'q-3', role: 'user', content: [{ type: 'text', text: 'one more queued note' }], source: { kind: 'user', rpcId: 'r5' } }, 'append'),
    ev(13, 'assistant/message', { turn: 0, step: 1, message: { id: 'a-2', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
    ev(14, 'user/message', { id: 'u-2', role: 'user', content: [{ type: 'text', text: 'Second question: ship it?' }], source: { kind: 'user', rpcId: 'r7' } }, 'append'),
    ev(15, 'assistant/message', { turn: 1, step: 0, message: { id: 'a-3', role: 'assistant', content: [{ type: 'text', text: 'Shipped.' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
  ]
}

const REPLACE_ALL = [
  { role: 'user', seq: 1, blocks: [{ kind: 'text', text: 'First question: summarize the repo.' }] },
  { role: 'assistant', seq: 2, blocks: [{ kind: 'text', text: 'Working on it.' }] },
  // q-0: still claimed through the cancel+insert → steering, inside turn 1.
  { role: 'user', seq: 7, blocks: [{ kind: 'text', text: 'tweak the summary into bullet points' }] },
  // q-1: re-inserted by the cancel+insert → unclaimed when it logs → anchor.
  { role: 'user', seq: 8, blocks: [{ kind: 'text', text: 'actually, resend this one as its own question' }] },
  // q-2b and q-3: claimed by the position-pinning partial claim at seq 10 →
  // steering rows inside turn 2, never anchors.
  { role: 'user', seq: 11, blocks: [{ kind: 'text', text: 'the edited replacement of the early draft' }] },
  { role: 'user', seq: 12, blocks: [{ kind: 'text', text: 'one more queued note' }] },
  { role: 'assistant', seq: 13, blocks: [{ kind: 'text', text: 'Done.' }] },
  { role: 'user', seq: 14, blocks: [{ kind: 'text', text: 'Second question: ship it?' }] },
  { role: 'assistant', seq: 15, blocks: [{ kind: 'text', text: 'Shipped.' }] },
]

/** Fork-inherited history: the log OPENS on an assistant row with no user
 * anchor in front of it (turn 0), then one anchored turn follows. */
function forkEvents() {
  return [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'assistant/message', { turn: 0, step: 0, message: { id: 'a-0', role: 'assistant', content: [{ type: 'text', text: 'Inherited answer from before the fork.' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
    ev(2, 'user/message', { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'Continue from there.' }], source: { kind: 'user', rpcId: 'r1' } }, 'append'),
    ev(3, 'assistant/message', { turn: 0, step: 1, message: { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: 'Continuing.' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
  ]
}

const FORK_ALL = [
  { role: 'assistant', seq: 1, blocks: [{ kind: 'text', text: 'Inherited answer from before the fork.' }] },
  { role: 'user', seq: 2, blocks: [{ kind: 'text', text: 'Continue from there.' }] },
  { role: 'assistant', seq: 3, blocks: [{ kind: 'text', text: 'Continuing.' }] },
]

/** Four turns of which two fold to zero blocks across every row: the
 * seq-1/2 turn (a file-only human message answered by a tool-call-only
 * step) and the seq-6/7 turn (file-only again, reasoning-only answer).
 * The seq-4 tool-call-only step sits INSIDE a contentful turn. */
function gappyEvents() {
  return [
    ev(1, 'user/message', { id: 'u-1', role: 'user', content: [{ type: 'file', attachment: { id: 'file-1' } }], source: { kind: 'user', rpcId: 'r1' } }, 'append'),
    ev(2, 'assistant/message', { turn: 0, step: 0, message: { id: 'a-1', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
    ev(3, 'user/message', { id: 'u-2', role: 'user', content: [{ type: 'text', text: 'What changed?' }], source: { kind: 'user', rpcId: 'r2' } }, 'append'),
    ev(4, 'assistant/message', { turn: 1, step: 0, message: { id: 'a-2', role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
    ev(5, 'assistant/message', { turn: 1, step: 1, message: { id: 'a-3', role: 'assistant', content: [{ type: 'text', text: 'Nothing yet.' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
    ev(6, 'user/message', { id: 'u-3', role: 'user', content: [{ type: 'file', attachment: { id: 'file-2' } }], source: { kind: 'user', rpcId: 'r3' } }, 'append'),
    ev(7, 'assistant/message', { turn: 1, step: 2, message: { id: 'a-4', role: 'assistant', content: [{ type: 'reasoning', text: 'reading the files silently' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
    ev(8, 'user/message', { id: 'u-4', role: 'user', content: [{ type: 'text', text: 'Summarize.' }], source: { kind: 'user', rpcId: 'r4' } }, 'append'),
    ev(9, 'assistant/message', { turn: 2, step: 0, message: { id: 'a-5', role: 'assistant', content: [{ type: 'text', text: 'Two files, no changes.' }], source: MODEL_SOURCE }, stream: [] }, 'append'),
  ]
}

const GAPPY_ALL = [
  { role: 'user', seq: 3, blocks: [{ kind: 'text', text: 'What changed?' }] },
  { role: 'assistant', seq: 5, blocks: [{ kind: 'text', text: 'Nothing yet.' }] },
  { role: 'user', seq: 8, blocks: [{ kind: 'text', text: 'Summarize.' }] },
  { role: 'assistant', seq: 9, blocks: [{ kind: 'text', text: 'Two files, no changes.' }] },
]

/** A log whose ITERATION explodes: the fake service returns it fine, but the
 * route's fold loop (for..of) throws — the exact window between a successful
 * readSession and serialization the catch block must cover with a 500. */
function explosiveEvents() {
  const events = [
    ev(2, 'user/message', { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'never serialized' }], source: { kind: 'user', rpcId: 'r1' } }, 'append'),
  ]
  events[Symbol.iterator] = () => { throw new Error('fold stage exploded') }
  return events
}

/** Fake sessionQuery: readSession serves one detached SessionLogSnapshot per
 * session id — the snapshot shape is plain cloned data with no dispose/
 * retain (the real SessionLogSnapshot declares none, unlike
 * SessionObservation's lease), so there is nothing to release and the old
 * lease-accounting test is gone with it. Reads are recorded in order so the
 * tests can still prove routing went through readSession. */
function makeSessionQuery(sessions) {
  const state = { read: [] }
  const query = {
    async readSession(id) {
      state.read.push(id)
      const session = sessions[id]
      if (session === undefined) {
        const error = new Error(`session "${id}" not found`)
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw error
      }
      return { session: session.session, inheritedEventCount: 0, events: session.events }
    },
  }
  return { query, state }
}

let share, index, server, base, queryState, warned

before(async () => {
  share = await import(SHARE_URL)
  index = await import(INDEX_URL)
  const { query, state } = makeSessionQuery({
    'sess-live': { session: { version: 3, id: 'sess-live', createdAt: CREATED_AT, cwd: '/tmp/x', isSeeded: true }, events: fixtureEvents() },
    'sess-empty': { session: { version: 3, id: 'sess-empty', createdAt: CREATED_AT, isSeeded: false }, events: [] },
    'sess-steer': { session: { version: 3, id: 'sess-steer', createdAt: CREATED_AT, cwd: '/tmp/x', isSeeded: true }, events: steeringEvents() },
    'sess-replace': { session: { version: 3, id: 'sess-replace', createdAt: CREATED_AT, cwd: '/tmp/x', isSeeded: true }, events: replaceEvents() },
    'sess-fork': { session: { version: 3, id: 'sess-fork', createdAt: CREATED_AT, cwd: '/tmp/x', isSeeded: true }, events: forkEvents() },
    'sess-gappy': { session: { version: 3, id: 'sess-gappy', createdAt: CREATED_AT, cwd: '/tmp/x', isSeeded: true }, events: gappyEvents() },
    'sess-boom': { session: { version: 3, id: 'sess-boom', createdAt: CREATED_AT, cwd: '/tmp/x', isSeeded: true }, events: explosiveEvents() },
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

test('range=last&turns=1 returns the final turn, anchor and all', async () => {
  const { status, body } = await get('?session=sess-live&range=last&turns=1')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.truncated, false)
  // sess-live folds into two anchored turns: [user seq2, assistant seq4+7]
  // and [user seq10, assistant seq11]. One from the end keeps the whole
  // second turn — its user anchor plus its assistant row — and nothing
  // before it.
  assert.deepEqual(body.turns, EXPECTED_TURNS.slice(3))
})

test('turns=500 is the valid upper bound; past the count means all', async () => {
  const { status, body } = await get('?session=sess-live&range=last&turns=500')
  assert.equal(status, 200)
  assert.deepEqual(body.turns, EXPECTED_TURNS)
})

test('a steering interjection stays inside its turn and still serializes', async () => {
  const all = await get('?session=sess-steer&range=all')
  assert.equal(all.status, 200)
  assert.deepEqual(all.body.turns, STEERING_ALL)

  // THE fix this route exists for: turn 1 is [u-1 a-1 s-1 a-2] — the steering
  // row stays but must not split it. turns=1 therefore returns ONLY the last
  // question's turn; under the old every-user-is-an-anchor rule this body
  // started at seq 12 (the steering row) instead.
  const last1 = await get('?session=sess-steer&range=last&turns=1')
  assert.equal(last1.status, 200)
  assert.deepEqual(last1.body.turns, STEERING_ALL.slice(4))
  // turns=2 spans both true questions and keeps the steering row inside
  // turn 1 — two turns total, not the three the old anchor rule counted.
  const last2 = await get('?session=sess-steer&range=last&turns=2')
  assert.deepEqual(last2.body.turns, STEERING_ALL)
})

test('a pure insert splice claims nothing and a cancel never claims', async () => {
  const { body } = await get('?session=sess-steer&range=all')
  const transcript = JSON.stringify(body.turns)
  // s-2 was queued by a PURE INSERT (seq 9) then canceled (seq 10): it never
  // logged a user/message, and neither the insert nor the cancel may leave a
  // claim behind — the claim at seq 11 replaced the set with {s-1} alone, so
  // u-2 (seq 14) still opens turn 2 (asserted by the turns=1 slice above).
  assert.ok(!transcript.includes('never mind, canceled while queued.'))
  // p-1 WAS claimed (seq 3) and logged (seq 4), but as an injected context:
  // claimed ≠ transcript material, and its id in the claim set must not leak
  // onto the human question that follows.
  assert.ok(!transcript.includes('Verifier tools are available'))
})

test('a cancel+insert splice replaces pending in place, unclaims the inserted, and claims nothing', async () => {
  // THE review 07+08 case: removedCount>0 + outcome 'canceled' + non-empty
  // inserted must fold exactly as cancel and insert separately. Turn shape is
  // the whole pin (see replaceEvents for which wrong implementation shifts
  // which row): turn 1 = the question + answer + the still-claimed q-0;
  // turn 2 = the re-inserted q-1 (a true question now) + the two
  // position-claimed steering rows + the answer; turn 3 = the closer.
  const all = await get('?session=sess-replace&range=all')
  assert.equal(all.status, 200)
  assert.deepEqual(all.body.turns, REPLACE_ALL)

  // claimed 减 inserted made q-1 an anchor, so turns=1 is exactly the final
  // question's turn — under a fold that kept q-1 claimed, turn 2 would not
  // exist and this slice would start at seq 8 (q-1 folded into turn 1 as
  // steering).
  const last1 = await get('?session=sess-replace&range=last&turns=1')
  assert.deepEqual(last1.body.turns, REPLACE_ALL.slice(7))
  // 原位替换 + 不认领: turns=2 spans the q-1 turn with BOTH seq-10-claimed
  // steering rows inside it (q-3 included); an appended insert would have
  // left q-3 unclaimed, anchoring a fourth turn and pushing it out of this
  // slice — and a splice-turned-claim would have folded q-0 into an anchor,
  // adding a turn in front.
  const last2 = await get('?session=sess-replace&range=last&turns=2')
  assert.deepEqual(last2.body.turns, REPLACE_ALL.slice(3))
  // 不认领, the sharp edge: the pre-existing {q-0} claim must SURVIVE the
  // cancel+insert, so turn 1 keeps THREE rows and turns=3 is the whole
  // transcript. Under a fold where the splice itself claimed (set replaced
  // with {q-2}), q-0 would have anchored its own turn, turn 1 would shrink
  // to [u-1, a-1], and this slice would drop those two rows — the turns=1/2
  // slices alone cannot see that (a later splice re-claims the same ids), so
  // this boundary is pinned explicitly.
  const last3 = await get('?session=sess-replace&range=last&turns=3')
  assert.deepEqual(last3.body.turns, REPLACE_ALL)
})

test('a compaction checkpoint replacement never enters the transcript', async () => {
  const { body } = await get('?session=sess-live&range=all')
  // The checkpoint at seq 12 is an isReplacementSurfaceEvent user/message
  // with source plugin 'compact' — model-only by the append-origin rule (the
  // Chat view's messageDefinition excludes it the same way), while the range
  // it shadowed (seq 2) stays exported.
  const transcript = JSON.stringify(body.turns)
  assert.ok(!transcript.includes('COMPACTED SUMMARY'))
  assert.ok(transcript.includes('What is 2+2?'))
})

test('leading assistant rows with no user anchor form turn 0', async () => {
  const last1 = await get('?session=sess-fork&range=last&turns=1')
  assert.equal(last1.status, 200)
  // The inherited answer is a turn of its own (turn 0), so turns=1 drops it
  // whole — the all↔last difference is never half a turn.
  assert.deepEqual(last1.body.turns, FORK_ALL.slice(1))
  const last2 = await get('?session=sess-fork&range=last&turns=2')
  assert.deepEqual(last2.body.turns, FORK_ALL)
  const all = await get('?session=sess-fork&range=all')
  assert.deepEqual(all.body.turns, FORK_ALL)
})

test('turns folded to zero blocks take no slot and never serialize', async () => {
  const all = await get('?session=sess-gappy&range=all')
  assert.equal(all.status, 200)
  assert.deepEqual(all.body.turns, GAPPY_ALL)
  // turns=2 skips the two fully-emptied turns (seq 1/2 and 6/7) without
  // spending slots on them and still reaches back to the seq-3 turn; the
  // tool-call-only step at seq 4 inside that kept turn stays invisible.
  const last2 = await get('?session=sess-gappy&range=last&turns=2')
  assert.deepEqual(last2.body.turns, GAPPY_ALL)
  const last1 = await get('?session=sess-gappy&range=last&turns=1')
  assert.deepEqual(last1.body.turns, GAPPY_ALL.slice(2))
})

test('query validation', async () => {
  // session is required exactly once, non-empty.
  assert.equal((await get('?range=all')).status, 400)
  assert.equal((await get('?session=')).status, 400)
  assert.equal((await get('?session=a&session=b&range=all')).status, 400)
  // range is all or last, at most once; anything else is a client bug worth
  // a loud 400 over a silent wrong answer.
  assert.equal((await get('?session=sess-live&range=bogus')).status, 400)
  assert.equal((await get('?session=sess-live&range=all&range=all')).status, 400)
  // turns rides with range=last only, exactly once, as a plain integer
  // 1–500: missing, empty, repeated, zero, negative, fractional,
  // exponent-notation, non-numeric, and above-cap values are all 400s.
  assert.equal((await get('?session=sess-live&range=last')).status, 400)
  assert.equal((await get('?session=sess-live&range=last&turns=')).status, 400)
  assert.equal((await get('?session=sess-live&range=last&turns=3&turns=3')).status, 400)
  assert.equal((await get('?session=sess-live&range=last&turns=0')).status, 400)
  assert.equal((await get('?session=sess-live&range=last&turns=-1')).status, 400)
  assert.equal((await get('?session=sess-live&range=last&turns=2.5')).status, 400)
  assert.equal((await get('?session=sess-live&range=last&turns=1e2')).status, 400)
  assert.equal((await get('?session=sess-live&range=last&turns=abc')).status, 400)
  assert.equal((await get('?session=sess-live&range=last&turns=501')).status, 400)
  // turns without range=last is a client bug, not a silent all.
  assert.equal((await get('?session=sess-live&range=all&turns=3')).status, 400)
  assert.equal((await get('?session=sess-live&turns=3')).status, 400)
})

test('only GET is allowed', async () => {
  const response = await fetch(`${base}/_dsh/mobile-nav/share-export?session=sess-live`, { method: 'POST' })
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'GET')
  assert.equal((await response.json()).error.code, 'method-not-allowed')
})

test('every export reads the log through readSession exactly once', async () => {
  // Twenty-one reads so far: twenty 200s (live ×5, empty, steer ×4,
  // replace ×4, fork ×3, gappy ×3) plus the 404 (the fake records the id,
  // then throws); the 16 validation 400s short-circuit before readSession.
  assert.deepEqual(queryState.read, [
    'sess-live', 'sess-live', 'sess-empty', 'sess-gone',
    'sess-live', 'sess-live',
    'sess-steer', 'sess-steer', 'sess-steer', 'sess-steer',
    'sess-replace', 'sess-replace', 'sess-replace', 'sess-replace',
    'sess-live',
    'sess-fork', 'sess-fork', 'sess-fork',
    'sess-gappy', 'sess-gappy', 'sess-gappy',
  ])
})

test('rejections are logged once each, the method guard is not', async () => {
  // 1×404 + 16×400 reached the try block and logged; the 405 answers before
  // it and the 200s (replace's included) never log.
  assert.equal(warned, 17)
})

test('a fold-stage throw after a successful readSession is a clean 500', async () => {
  const warnedBefore = warned
  const { status, body } = await get('?session=sess-boom&range=all')
  // The failure is server-side (not the client's query, not a missing
  // session), so the generic 500/export-failed envelope answers; the snapshot
  // is detached data with no lease, so there is nothing to release — the
  // guard under test is that the catch still owns the response end to end.
  assert.equal(status, 500)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'export-failed')
  assert.match(body.error.message, /fold stage exploded/)
  assert.equal(queryState.read[queryState.read.length - 1], 'sess-boom')
  assert.equal(warned, warnedBefore + 1, 'the failure was logged')
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
