/**
 * Share-image transcript route (issue #7): fold one session's raw event log
 * into the flat user/assistant transcript the phone rasterizes into shareable
 * PNG cards.
 *
 * Why a host route at all: the Chat view is a paged window over a surface the
 * compactor rewrites, so the browser DOM never holds the whole conversation
 * and cloning it cannot work. The whole-log source of truth is the host-side
 * `sessionQuery` service (standard dsh-base composition), which no browser
 * half can reach.
 *
 * Why the RAW log (`readSession`) and not the observed surface: the surface
 * deliberately shadows replaced ranges, so once a replacement lands it shows
 * LESS than the user already saw — wrong source for a human transcript (the
 * official trap note on `isAppendSurfaceEvent`: append-origin events are the
 * transcript's durable source material). The raw log additionally carries the
 * `agent/inbox/spliced` bookkeeping the steering classification below folds —
 * it never exists on the surface. The fold keeps every append-origin message
 * in log order and never applies the shadows, so a steered or compacted
 * session still exports everything the user saw.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls in the `Context.sessionQuery` augmentation. The service
// itself is provided by the composition; this plugin never imports its code.
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// The two pure projection helpers are the canonical per-node rules from the
// session package's browser-safe subpath. Duplicating them here would be a
// second fold that silently drifts from the one every other consumer uses.
import { deriveEventMessage, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'

/** Exact route the browser GETs a session's share transcript from. */
export const SHARE_EXPORT_ROUTE = '/_dsh/mobile-nav/share-export'

/** Upper bound on `turns` for `range=last` (PLAN §4). 500 exchanges is
 * already more wall of text than any share card wants, and the cap keeps a
 * careless `turns=99999999` from quietly meaning "the whole log". */
export const MAX_SHARE_TURNS = 500

/** One exportable content block of a transcript row. */
export type ShareBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image' }

/** One transcript row. `seq` is the source event's log position — stable
 * across re-renders and usable as a React key; a range=last body keeps whole
 * turns, so its seqs always arrive turn-contiguous. */
export interface ShareTurn {
  role: 'user' | 'assistant'
  seq: number
  blocks: ShareBlock[]
}

/**
 * Internal fold row: a {@link ShareTurn} plus the turn-anchor verdict. Only
 * rows the inbox machine classifies as a TRUE question anchor — not steering
 * — open a new turn; the flag never reaches a response body (the serializers
 * below strip it), so the wire contract stays exactly `ShareTurn`.
 */
interface FoldedRow extends ShareTurn {
  /** True when this row opens a turn: a user row not claimed as steering. */
  anchor: boolean
}

/** Response body of a successful export (PLAN §4 contract). */
export interface ShareExportBody {
  ok: true
  /** Session creation time (Unix epoch ms) from the observed header. */
  createdAt: number
  turns: ShareTurn[]
  /** Constant false while the server never truncates; the client's slice
   * budget is the only truncation that exists. */
  truncated: false
}

/**
 * One rejection carrying the status the client should see.
 *
 * Fields are assigned in the body rather than declared as constructor
 * parameter properties: the check scripts import this module through Node's
 * strip-only type stripping, which rejects that syntax (same reason as
 * UploadError in index.ts).
 */
class ShareExportError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ShareExportError'
    this.status = status
    this.code = code
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Identical envelope to index.ts's responseJson — kept local so this route
 * module stays importable without a cycle back into the entry file. */
function responseJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  res.writeHead(status)
  res.end(bytes)
}

function singleQuery(url: URL, key: string): string {
  const values = url.searchParams.getAll(key)
  const value = values[0]
  if (values.length !== 1 || value === undefined || value === '') {
    throw new ShareExportError(400, 'bad-request', `${key} is required exactly once`)
  }
  return value
}

/** One parsed `range` query: the whole transcript, or the tail N
 * contentful turns (count already validated). */
type ShareRange = { kind: 'all' } | { kind: 'last'; turns: number }

/**
 * Validate the `range`/`turns` pair. Absent `range` means `all`; `last`
 * must carry exactly one `turns` that is a plain integer 1–500 — the phone
 * only offers presets, so a fractional/negative/oversized/repeated value is
 * a hand-typed URL or a client bug, and a loud 400 beats slicing to a
 * guessed intent. `turns` next to any other range (or to none) is rejected
 * rather than ignored: silently dropping it would answer a different
 * question than the URL asks.
 */
function parseRange(url: URL): ShareRange {
  const values = url.searchParams.getAll('range')
  const value = values[0]
  if (values.length === 0) return { kind: 'all' }
  if (values.length !== 1 || value === undefined || value === '') {
    throw new ShareExportError(400, 'bad-request', 'range is allowed at most once')
  }
  if (value === 'all') return { kind: 'all' }
  if (value !== 'last') {
    throw new ShareExportError(400, 'bad-request', `unsupported range: ${value}`)
  }
  const turnsList = url.searchParams.getAll('turns')
  const turns = turnsList[0]
  if (turnsList.length !== 1 || turns === undefined || turns === '') {
    throw new ShareExportError(400, 'bad-request', 'turns is required exactly once when range=last')
  }
  const count = /^[0-9]+$/.test(turns) ? Number(turns) : Number.NaN
  if (!Number.isInteger(count) || count < 1 || count > MAX_SHARE_TURNS) {
    throw new ShareExportError(400, 'bad-request', `turns must be an integer between 1 and ${MAX_SHARE_TURNS}`)
  }
  return { kind: 'last', turns: count }
}

/** Reject a `turns` parameter on a request that is not range=last. */
function rejectStrayTurns(url: URL): void {
  if (url.searchParams.has('turns')) {
    throw new ShareExportError(400, 'bad-request', 'turns is only valid with range=last')
  }
}

/** `SESSION_QUERY_SESSION_NOT_FOUND`, read structurally: the error class
 * lives in a package this module only knows by type, and the taxonomy string
 * is the stable contract either side can be checked against. */
function isSessionNotFound(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'SESSION_QUERY_SESSION_NOT_FOUND'
}

/**
 * Data of one `agent/inbox/spliced` event, as the AgentLoop's durable Inbox
 * writes it (dsh-agent-loop `ReactLoopInbox.mutate`, closure 0.1.5-rc.2):
 * `{ target, start, removedCount?, inserted: Message[], outcome? }` —
 * `removedCount` is omitted for pure inserts, and `outcome: 'canceled'` marks
 * every public-API removal (cancel/remove/replace); only an entered CLAIM
 * (the boundary consuming the pending batch) removes without an outcome.
 *
 * The plugin's pinned dsh-session 0.1.2-rc.1 predates this event type, so the
 * SessionEvent union cannot narrow it — the guard below widens the same
 * runtime object. Shape is guaranteed upstream: `readSession` replay-validates
 * the log and the standard inbox projection rejects an invalid splice history.
 */
interface InboxSpliceData {
  target: string
  start: number
  removedCount?: number
  inserted: readonly { id: string | number }[]
  outcome?: string
}

/** `agent/inbox/spliced` for the NEXT-STEP inbox, or null for anything else
 * (including next-turn splices: the Chat classifier reads only the next-step
 * node, and turn claiming is none of this fold's business). */
function nextStepSpliceOf(event: SessionEvent): InboxSpliceData | null {
  // The double cast widens deliberately: the 0.1.2-rc.1 union cannot even
  // NAME the newer event type, so a same-type cast would keep narrowing the
  // literal and reject the comparison outright.
  const widened = event as unknown as { type: string; data: InboxSpliceData }
  return widened.type === 'agent/inbox/spliced' && widened.data.target === 'next-step'
    ? widened.data
    : null
}

/** State of the next-step Inbox fold — the machine the host Chat view uses to
 * tell a true question from a steering interjection. */
interface NextStepInboxState {
  /** Pending next-step message ids in inbox order. */
  pending: string[]
  /** Ids claimed by the most recent entered claim: the user/message events
   * logging these ids are steering (mid-turn interjections, e.g. an
   * authorization reply), not new turns. */
  currentClaimed: ReadonlySet<string>
}

const NO_CLAIM: ReadonlySet<string> = new Set()

/**
 * Apply one next-step splice, replicated from the host Chat client's
 * conversation-node fold (`nextStepInboxDefinition` → `applySplice` /
 * `materializePending` / `withoutInserted` in dsh-client-ui-chat lib/client.js,
 * closure @deepseek-ai/dsh-client-ui-chat 0.1.5-rc.2 — re-pin and re-verify
 * that block when the harness version moves):
 *
 * - a REMOVING splice with no `canceled` outcome is an entered claim: the
 *   pending list loses the removed ids (an insert/cancel chain is materialized
 *   first, since the host keeps pending lazily) and `currentClaimed` is
 *   REPLACED by exactly the removed ids — the comment there: "An entered claim
 *   logs its complete message batch before another claim; a rejected claim
 *   logs no messages, so only the current claim can classify a later
 *   `user/message`";
 * - a pure insert or a cancel (including a cancel that also inserts — the
 *   in-place replace path) leaves the claim verdict alone except that any
 *   INSERTED id leaves the claimed set: a message back in the inbox is pending
 *   again, not steering.
 *
 * Deviations from the closure source, none observable in the fold result: the
 * pending list is an eager array (the host's lazy splice chain only defers the
 * same materialization), and ids are `String()`-normalized on BOTH sides (the
 * host stores raw inserted ids and String()-coerces only the lookup key —
 * identical while message ids are strings, which `MessageId` brands them to
 * be).
 */
function applyNextStepSplice(previous: NextStepInboxState, splice: InboxSpliceData): NextStepInboxState {
  const insertedIds = splice.inserted.map((identity) => String(identity.id))
  const removedCount = splice.removedCount ?? 0
  const pending = previous.pending.slice()
  const removedIds = pending.splice(splice.start, removedCount, ...insertedIds).map(String)
  if (removedCount > 0 && splice.outcome !== 'canceled') {
    return { pending, currentClaimed: new Set(removedIds) }
  }
  const currentClaimed = new Set(previous.currentClaimed)
  for (const id of insertedIds) currentClaimed.delete(id)
  return { pending, currentClaimed }
}

/**
 * Fold one session's complete raw event log into transcript rows, in log order.
 *
 * Row admission, in the order the filters run:
 * - `agent/inbox/spliced` (next-step) events are not rows at all: they only
 *   advance the Inbox state that classifies the user rows below;
 * - append-origin surface events only (`isAppendSurfaceEvent`): a replacement
 *   copy is model-only and must not add itself to the transcript — this also
 *   keeps a compaction checkpoint (`isReplacementSurfaceEvent` user/message
 *   with `source.plugin === 'compact'`) out, exactly as the Chat view's
 *   `messageDefinition` excludes it — while the ranges a replacement shadowed
 *   stay in place; that is what makes this a human transcript rather than the
 *   model surface;
 * - `deriveEventMessage` drops events that produce no message, which covers
 *   turn/step boundaries AND the usage-only empty assistant message;
 * - system never renders in a shared conversation;
 * - user rows must be human-authored (`source.kind === 'user'`): injected
 *   contexts (file notices, skill content, …) are also user-role messages,
 *   and the Chat view renders them as context rows, not conversation — a
 *   share card shows the words people exchanged, not the machinery;
 * - a human user row then gets its turn verdict from the Inbox state: claimed
 *   (`currentClaimed.has(id)`, `String()`-normalized like the host) means
 *   STEERING — it stays in the transcript and in its turn as an ordinary
 *   user bubble, but never anchors a new one; unclaimed means a true question
 *   that opens the next turn;
 * - blocks: text passes verbatim, image becomes a `{kind:'image'}` placeholder
 *   (attachments live on the host disk and stay out of v1), everything else —
 *   reasoning (folded on the phone anyway), tool-call/tool-result, file, and
 *   block types this fold does not know — is dropped;
 * - a row that survives every filter above but yields no exportable block
 *   (a file-only human message, a tool-call-only assistant step) is KEPT
 *   here with `blocks: []`: the turn grouping below needs the conversation's
 *   true anchor shape, and only the serializers drop the empties.
 * @param events - complete raw log, contiguous ascending seq.
 * @returns the admitted rows in conversation order, empty ones included.
 */
function foldRows(events: readonly SessionEvent[]): FoldedRow[] {
  const rows: FoldedRow[] = []
  let inbox: NextStepInboxState = { pending: [], currentClaimed: NO_CLAIM }
  for (const event of events) {
    const splice = nextStepSpliceOf(event)
    if (splice !== null) {
      inbox = applyNextStepSplice(inbox, splice)
      continue
    }
    if (!isAppendSurfaceEvent(event)) continue
    const msg = deriveEventMessage(event)
    if (msg === null) continue
    if (msg.role !== 'user' && msg.role !== 'assistant') continue
    if (msg.role === 'user' && msg.source.kind !== 'user') continue
    const blocks: ShareBlock[] = []
    for (const block of msg.content) {
      if (block.type === 'text') blocks.push({ kind: 'text', text: block.text })
      else if (block.type === 'image') blocks.push({ kind: 'image' })
    }
    rows.push({
      role: msg.role,
      seq: event.seq,
      blocks,
      // Assistant rows are never anchors; a user row anchors unless the Inbox
      // state claims its id as steering.
      anchor: msg.role === 'user' && !inbox.currentClaimed.has(String(msg.id)),
    })
  }
  return rows
}

/**
 * Rows with at least one exportable block — an empty bubble is not worth
 * shipping, so every serializer (the all-body and the last-N tail) drops
 * them and strips the internal anchor flag through this one helper, leaving
 * the plain `ShareTurn` wire shape.
 */
function serializeRows(rows: readonly FoldedRow[]): ShareTurn[] {
  return rows.flatMap(({ anchor: _anchor, ...turn }) => (turn.blocks.length > 0 ? [turn] : []))
}

/**
 * Group folded rows into conversation turns (PLAN §4.5): one turn is a true
 * question — a user row the Inbox state left unclaimed — plus everything up
 * to the next question. A steering row never opens a turn: it belongs to the
 * turn it interrupted, exactly where the user saw it. Assistant rows before
 * the FIRST question form turn 0: a fork inherits history that begins
 * mid-conversation, and those rows belong to no anchor yet.
 */
function groupRowsIntoTurns(rows: readonly FoldedRow[]): FoldedRow[][] {
  const groups: FoldedRow[][] = []
  let current: FoldedRow[] = []
  for (const row of rows) {
    // An empty `current` on an anchor means the log OPENED on this anchor:
    // nothing was inherited, so turn 0 simply does not exist here.
    if (row.anchor && current.length > 0) {
      groups.push(current)
      current = []
    }
    current.push(row)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * The `range=last&turns=N` body: the transcript of the last N turns that
 * fold to at least one block, counted in the true-question sense above.
 * Walked from the end so a turn whose every row went empty (a file-only
 * message answered by tool-call-only steps — the exchange happened, but a
 * share card has nothing to show) is skipped WITHOUT eating one of the N
 * slots; rows that went empty INSIDE a kept turn still never serialize.
 * Only the selected tail is returned — the cut head never reaches the
 * response body.
 */
function sliceLastTurns(rows: readonly FoldedRow[], count: number): ShareTurn[] {
  const groups = groupRowsIntoTurns(rows)
  const selected: FoldedRow[] = []
  let remaining = count
  for (let i = groups.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const group = groups[i]
    if (group.every((row) => row.blocks.length === 0)) continue
    selected.unshift(...group)
    remaining -= 1
  }
  return serializeRows(selected)
}

/**
 * Handle one `GET {@link SHARE_EXPORT_ROUTE}?session=<id>&range=all|last&turns=N`
 * request.
 *
 * Exported so an integration test can drive it with a plain node:http server
 * and a fake sessionQuery service instead of booting a harness.
 * @param ctx - host context carrying the sessionQuery service and logger.
 * @param req - inbound request; no body is read.
 * @param res - the response this call owns end to end.
 */
export async function handleShareExport(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } })
    return
  }
  try {
    const url = new URL(req.url ?? SHARE_EXPORT_ROUTE, 'http://dsh.internal')
    const sessionId = singleQuery(url, 'session')
    const range = parseRange(url)
    if (range.kind === 'all') rejectStrayTurns(url)
    // readSession (not observeSession): the fold needs the COMPLETE raw log in
    // log order — the surface observation is model-ordered, shadows replaced
    // ranges, and never carries `agent/inbox/spliced`. The returned
    // SessionLogSnapshot is detached and fully cloned: unlike
    // SessionObservation it declares no dispose/retain (checked against
    // @deepseek-ai/dsh-session-query 0.1.2-rc.1 types), so there is no lease
    // to release — its replay validation is what guarantees the contiguous
    // ascending events the fold and the Inbox machine rely on.
    const snapshot: SessionLogSnapshot = await ctx.sessionQuery.readSession(sessionId as SessionId)
    // One fold of the whole log (the last N turns cannot be found from the
    // tail alone); the range decides which slice of it is serialized.
    const rows = foldRows(snapshot.events)
    const body: ShareExportBody = {
      ok: true,
      createdAt: snapshot.session.createdAt,
      turns: range.kind === 'last' ? sliceLastTurns(rows, range.turns) : serializeRows(rows),
      truncated: false,
    }
    responseJson(res, 200, body)
  } catch (error) {
    const status = error instanceof ShareExportError ? error.status : isSessionNotFound(error) ? 404 : 500
    const code = error instanceof ShareExportError ? error.code : isSessionNotFound(error) ? 'session-not-found' : 'export-failed'
    ctx.logger.warn('dsh-mobile-nav share-export rejected: %s', message(error))
    responseJson(res, status, { ok: false, error: { code, message: message(error) } })
  }
}
