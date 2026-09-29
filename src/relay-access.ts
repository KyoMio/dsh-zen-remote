/**
 * Pure access control for the relay invoke and stream routes (2.0.0
 * desktop-client).
 *
 * PER-METHOD ALLOWLIST, not a generic id scan. The first draft extracted
 * whatever session ids it could find in `args.request` and checked those —
 * which a hostile client defeats with a DECOY: DSH's gateway validates only
 * the top-level argument names (`assertExactArguments`) and zod silently
 * strips unknown fields inside `request`, so padding the arguments with an
 * extra shared `sessionId` gets through the share-table check while the
 * method's REAL ownership field (`agentId`, `request.parentSessionId`, …)
 * goes unchecked. The fix: every invokable method is registered below with
 * EXACTLY the fields that locate its session, authorization looks at those
 * fields and nothing else, and any method not in the table is refused
 * (`forbidden-method`) before an id is ever read. The stream route
 * ({@link decideStream}) reads the SAME table: only `stream: true` entries
 * may ride it, and the field rules are identical.
 *
 * Field verification (T22a-fix, against the 0.2.0-rc.1 wire inventory in the
 * review's keys.txt and the local `typert.remote-client.js` — the spike
 * proved those files byte-identical across 0.1.7/0.2.0, docs/spike-relay.md
 * §2.3):
 *
 * - `request.address` exists only on `session/follow` and `session/page`;
 *   its zod schema is a union of EXACTLY two shapes —
 *   `{kind:'session', sessionId}` and `{kind:'subagent', parentSessionId,
 *   childSessionId, mode}` — and DSH's `validateAddress` re-checks that the
 *   child belongs to the parent, so judging a subagent call by the parent id
 *   is authoritative. Any other kind, or a missing id, is a refusal.
 * - every other method registered before T31 carries `request.sessionId`.
 *
 * T31 additions, each verified against the 0.2.0 sources before registering:
 *
 * - `session/create` carries `request.workspaceId` — a WORKSPACE id, never
 *   share-checked (workspaces do not live in the share table): it must be
 *   present, and the relay route validates it against the server's live
 *   workspace list before forwarding (relay-server.ts). The new session is
 *   auto-shared there, which is what makes the entry safe at all.
 * - `session/fork` carries `request.sessionId` (the SOURCE session); the
 *   forked child is auto-shared after the call succeeds.
 * - `subagents/prompt` (`request.parentSessionId`) and
 *   `subagents/interruptByParent` (TOP-LEVEL `parentSessionId`) are judged
 *   by the parent: DSH re-validates the parent-child link itself
 *   (`authorizeLineage` on both delivery paths of prompt; the user-authority
 *   check inside `interrupt`), so an unshared child can no more be reached
 *   than an unshared parent — it is refused server-side by DSH.
 * - `fileUploads/upload` and `fileReferences/list` carry a TOP-LEVEL
 *   `agentId`: the gateway's `agent` lookup resolves it through the agent
 *   registry keyed by SESSION id (dsh-agent registers wire `agentId`,
 *   wireTypeSymbol `SessionId`), so it IS the session id and shares its
 *   check. A shared `request.sessionId` padded next to it buys nothing —
 *   only the registered field is read.
 *
 * T41a additions (the panel long tail where the session id hides in another
 * argument), each verified against the 0.2.0 sources before registering:
 *
 * - the `agentId` group grows: `goals/get|edit|pause|resume|clear`,
 *   `commands/list|execute`, `agentPresets/select`,
 *   `sessionReferenceResolver/candidates` and the whole `terminal/*` agent
 *   half — every one takes `agent` as its first parameter, wire `agentId`,
 *   source `lookup: 'agent'`, wireTypeSymbol `SessionId` (the same shape
 *   T31 verified for fileUploads/fileReferences).
 * - `workspaceFiles/list|changes|read|readBytes|stat` carry a TOP-LEVEL
 *   `workspaceFileScopeId`: the host registers the `workspaceFileScope`
 *   lookup with wireTypeSymbol `SessionId` and resolves it by session —
 *   `sessions.get(sessionId).header.cwd` is only the BASE for relative
 *   paths (dsh-api-workspace-files lib/index.js, the lookup registration),
 *   not a containment: absolute paths anywhere the server process can read
 *   are served (see the registry note below). The field itself is
 *   share-checked like any session id.
 * - `terminal/list` and `terminal/retain` take a plain TOP-LEVEL json
 *   `sessionId` (source `'json'`, not a lookup) — same check.
 * - `sessionFeedback/record` carries `request.sessionId` — a plain B-type.
 * - `sessionReferenceResolver/candidates` (@ mentions) answers with EVERY
 *   server session — title, cwd, and a ready-made `dsh-session:` mention
 *   — so its result travels only through the row filter that drops
 *   inaccessible sessions (relay-server.ts, the session/list discipline).
 * - `subagents/prompt` (`request.parentSessionId` +
 *   `request.childSessionId`) and `subagents/interruptByParent` (TOP-LEVEL
 *   `parentSessionId` + `childSessionId`) now claim BOTH ids: the parent is
 *   share-checked directly, the child through the injected `parentOf`
 *   inheritance (`store.isAccessible(id, parentOf)` — a subagent session
 *   never enters the table, it borrows its ancestor's share). A child that
 *   does not descend from the claimed parent fails its own check, so the
 *   "shared parent + foreign child" decoy refuses here before DSH's own
 *   lineage validation is ever reached.
 *
 * PROMPT TEXT REFERENCES ARE CHECKED TOO: a prompt whose text carries a
 * canonical `dsh-session:<base64url(id)>` address makes DSH inject that
 * session's content (`prepareDirectMessages` → `readSurface`, with no
 * access check of its own), so the relay refuses any address naming an
 * inaccessible session wherever such a text can enter (relay-server.ts,
 * scanning by the shared rule in session-reference.ts, T41a-fix2): the
 * `session/prompt` / `subagents/prompt` content, a `session/updateQueue`
 * EDIT's replacement content, and EVERY string of a `commands/execute`
 * call (a command handler steers its raw input in as a user message —
 * `/plan <text>` does exactly that). The client restores its virtual ids
 * inside those same positions before the call travels (intercept.ts).
 *
 * TERMINALS ARE DELIBERATE (SPEC user story 45, explicit user request):
 * remote terminals open SERVER-side, so a paired desktop client working a
 * shared session gets a real PTY in the server's workspace — a shell
 * running as the server user WITHOUT the agent sandbox or approval
 * restrictions (RT dsh-api-terminal-controller create), the session cwd
 * being only the starting directory. The authorization boundary is exactly
 * the standing one — the session must be shared AND the caller must be a
 * paired desktop application client (the gateway's device auth + relay
 * secret), a TRUSTED DEVICE: the shared-only rule constrains session data,
 * not the machine. No extra switch is added on top; closing the session's
 * remote access closes its terminals with it (the stream route kills
 * `terminal/follow` / `terminal/retain` with `unshared`, like every other
 * session-scoped stream). The terminal ids and attachment ids inside these
 * calls are CLIENT-generated (`WebTerminalId` / `TerminalAttachmentId` type
 * symbols, distinct from `SessionId`) and pass through untouched.
 *
 * Pure functions: no I/O, no clock, the share-table lookup is injected.
 */

/**
 * The argument fields that can locate a session, as registered per method.
 * A field named without a dot is TOP-LEVEL (`agentId`, `parentSessionId`,
 * `childSessionId`, `sessionId`, `workspaceFileScopeId`); the `request.*`
 * forms live inside the `request` object. Every field except
 * `request.workspaceId` must yield an id that passes the share-table check
 * (top-level `sessionId` / `workspaceFileScopeId` ARE session ids — the
 * wire type symbols say so — and inherit ancestor shares like any other);
 * `request.workspaceId` must merely be present (its validation is the relay
 * route's workspace probe, not this table).
 */
type SessionField =
  | 'request.sessionId'
  | 'request.address'
  | 'request.parentSessionId'
  | 'request.childSessionId'
  | 'request.workspaceId'
  | 'parentSessionId'
  | 'childSessionId'
  | 'sessionId'
  | 'workspaceFileScopeId'
  | 'agentId'

/** Which standing filter the caller must apply to a global stream's frames
 * (`src/relay-filter.ts` owns both implementations; the `$zr/events`
 * forwarding subscription is filtered by relay-server.ts itself — it needs
 * the per-eventId registry, not a pure frame function). */
export type StreamFilter = 'workspace' | 'control'

/** Which standing filter the caller must apply to an invoke result before it
 * travels: `session-list` narrows the unscoped `session/list` items
 * (relay-filter.ts), `session-reference-candidates` drops the @-mention
 * candidate rows whose session is not accessible (relay-server.ts — the host
 * lists EVERY server session with title, cwd and a ready-made mention, so
 * unshared rows must never leave the box), and `model-catalog` empties the
 * `session/modelCatalog` `failures` array (T52-fix — relay-filter.ts: the
 * host's per-group error texts may carry endpoint or credential details, and
 * the client discards `failures` anyway). */
export type InvokeFilter = 'session-list' | 'session-reference-candidates' | 'model-catalog'

interface RelayMethod {
  /** Every field that carries session ownership for this method. ALL of
   * them must exist, be strings, and pass the share-table check. Global
   * entries (`workspace/follow`, `session/control`, `session/list`,
   * `session/modelCatalog`) own no field — reachability is enforced by
   * filtering their output instead (for modelCatalog that filter only
   * scrubs the `failures` array; the groups themselves carry no session
   * data). */
  fields: SessionField[]
  /** Stream-delivered methods (`mode: 'stream'` in the wire inventory):
   * callable ONLY through the streaming route — an invoke carrying one is
   * refused, and so is a stream carrying a non-stream method. */
  stream?: boolean
  /** Set on the two GLOBAL streams: every frame of such a subscription must
   * go through the named filter before it is written. */
  streamFilter?: StreamFilter
  /** Set on the invoke methods whose RESULT needs a standing filter. */
  resultFilter?: InvokeFilter
  /** The one EVENT-FORWARDING entry (T32, `$zr/events`): the stream route
   * opens the gateway's `$events` wire stream (never `gw.stream`, spike §2.1
   * 坑 1) and filters frames by the waterfall's `agentId`; the answer route
   * matches `eventId`s against what was forwarded. Like the global reads it
   * claims no session field — access is judged per frame / per answer. */
  events?: true
}

/**
 * The registry. Deliberately small: everything not listed here — plugin and
 * account management, settings, credentials, the methods located by other
 * ids (`schedule/update|delete|history`, `goals/create|complete`,
 * `fileUploads/list|resolve`, `agentPresets/list|read`,
 * `permissionPresets/*`, `officeToPdf/*`, `dynamicCordisRunner/*`) — is
 * refused by default.
 *
 * T31 registered the five session-creating / agent-scoped calls after
 * verifying their ownership story (see the field notes above): creations
 * auto-share their result (relay-server.ts), the subagents calls are judged
 * by the parent DSH itself re-validates, and the two `agentId` methods are
 * located by the session id that name resolves to. T41a grew the agentId
 * family and added the workspaceFiles / terminal / feedback / goals /
 * commands / preset-switch groups on the same verified shape.
 *
 * The unscoped reads are registered as FILTERED controlled paths (T22b):
 * `workspace/follow` and `session/control` stream globally but every frame
 * passes `streamFilter` first; `session/list` invokes but its items pass
 * `resultFilter` first. Nothing unlisted ever reaches the gateway.
 */
const RELAY_METHODS: Record<string, RelayMethod> = {
  // session/* — ownership via the address envelope
  'session/follow': { fields: ['request.address'], stream: true },
  'session/page': { fields: ['request.address'] },
  // session/* — ownership via request.sessionId
  'session/projections': { fields: ['request.sessionId'] },
  'session/prompt': { fields: ['request.sessionId'] },
  'session/cancel': { fields: ['request.sessionId'] },
  'session/rename': { fields: ['request.sessionId'] },
  'session/selectModel': { fields: ['request.sessionId'] },
  'session/updateQueue': { fields: ['request.sessionId'] },
  'session/attachment': { fields: ['request.sessionId'] },
  // session/* — creation and forking (T31): the route validates the workspace
  // / source session and auto-shares the NEW session from the result
  'session/create': { fields: ['request.workspaceId'] },
  'session/fork': { fields: ['request.sessionId'] },
  // subagents (T31, both ids since T41a) — the parent locates the call and
  // DSH re-validates the parent-child link on every path; the child id is
  // ALSO share-checked through the parentOf inheritance, so a foreign child
  // refuses before DSH is ever asked
  'subagents/prompt': { fields: ['request.parentSessionId', 'request.childSessionId'] },
  'subagents/interruptByParent': { fields: ['parentSessionId', 'childSessionId'] },
  // attachments and @ references (T31) — the top-level agentId resolves
  // through the agent registry keyed by session id, so it IS the session id
  'fileUploads/upload': { fields: ['agentId'] },
  'fileReferences/list': { fields: ['agentId'] },
  // goal panel (T41a) — top-level agentId, same lookup shape as fileUploads;
  // goals/create|complete stay closed (the UI's goal bar uses only these five)
  'goals/get': { fields: ['agentId'] },
  'goals/edit': { fields: ['agentId'] },
  'goals/pause': { fields: ['agentId'] },
  'goals/resume': { fields: ['agentId'] },
  'goals/clear': { fields: ['agentId'] },
  // slash commands + the preset switches they drive (T41a) — top-level agentId
  'commands/list': { fields: ['agentId'] },
  'commands/execute': { fields: ['agentId'] },
  'agentPresets/select': { fields: ['agentId'] },
  // The @ resolver's answer lists EVERY server session with title, cwd and a
  // ready-made mention — it travels only through the row filter that drops
  // inaccessible sessions (relay-server.ts), like session/list.
  'sessionReferenceResolver/candidates': { fields: ['agentId'], resultFilter: 'session-reference-candidates' },
  // session feedback (T41a) — plain request.sessionId
  'sessionFeedback/record': { fields: ['request.sessionId'] },
  // file tree and previews (T41a) — the top-level workspaceFileScopeId IS the
  // session id (host lookup wireTypeSymbol SessionId), but the session cwd is
  // only the BASE for relative paths: an absolute path is served whenever the
  // server process can read it, with no containment to the workspace (RT
  // dsh-api-workspace-files lib/index.js ~168-170 "including paths outside the
  // workspace … not a read-containment restriction", ~420 / ~479 "files
  // outside it are allowed"). That exposure matches the terminal trust
  // premise below (SPEC user story 45) and is deliberately accepted.
  // changes is the tree's live stream.
  'workspaceFiles/list': { fields: ['workspaceFileScopeId'] },
  'workspaceFiles/changes': { fields: ['workspaceFileScopeId'], stream: true },
  'workspaceFiles/read': { fields: ['workspaceFileScopeId'] },
  'workspaceFiles/readBytes': { fields: ['workspaceFileScopeId'] },
  'workspaceFiles/stat': { fields: ['workspaceFileScopeId'] },
  // terminal (T41a) — opens SERVER-side by explicit user request (SPEC story
  // 45). What the client gets is a shell running AS THE SERVER USER, WITHOUT
  // the agent sandbox or approval restrictions (RT dsh-api-terminal-controller
  // create: "Allocate a user shell … without Agent sandbox or approval
  // restrictions"); the session cwd is only the starting directory. "Only
  // shared sessions are accessible" constrains SESSION data, not this machine
  // — a paired desktop application client is treated as a trusted device, and
  // no extra switch is added on top. follow/retain are streams; the terminal
  // and attachment ids in these calls are client-generated and pass through.
  'terminal/environment': { fields: ['agentId'] },
  'terminal/shells': { fields: ['agentId'] },
  'terminal/create': { fields: ['agentId'] },
  'terminal/write': { fields: ['agentId'] },
  'terminal/resize': { fields: ['agentId'] },
  'terminal/rename': { fields: ['agentId'] },
  'terminal/close': { fields: ['agentId'] },
  'terminal/follow': { fields: ['agentId'], stream: true },
  // the retain/list half locates by a plain top-level json sessionId
  'terminal/list': { fields: ['sessionId'] },
  'terminal/retain': { fields: ['sessionId'], stream: true },
  // session/* — the global control stream and the unscoped list
  'session/control': { fields: [], stream: true, streamFilter: 'control' },
  'session/list': { fields: [], resultFilter: 'session-list' },
  // T52: the global model catalog — NO parameters at all (RT
  // dsh-api-session-controller lib/typert.remote-client.js:1014-1027,
  // `parameters: []`), and its result is the server's provider directory
  // `{default, routableProviders, groups, failures}` — group/model ids and
  // display names only, nothing session-scoped (the schema is at
  // lib/typert.remote-client.js:489-518). Field-less like session/list; the
  // result filter (T52-fix) only EMPTIES `failures` — the host's per-group
  // error texts may carry endpoint or credential details the client never
  // shows (it keeps its own local failures instead).
  'session/modelCatalog': { fields: [], resultFilter: 'model-catalog' },
  // job/*
  'job/list': { fields: ['request.sessionId'], stream: true },
  'job/follow': { fields: ['request.sessionId'], stream: true },
  'job/kill': { fields: ['request.sessionId'] },
  // skills, message feedback
  'skills/list': { fields: ['request.sessionId'] },
  'messageFeedback/list': { fields: ['request.sessionId'] },
  'messageFeedback/put': { fields: ['request.sessionId'] },
  'messageFeedback/delete': { fields: ['request.sessionId'] },
  // schedule (list only — update/delete/history wait for P4)
  'schedule/list': { fields: ['request.sessionId'] },
  // workspace session-scoped mutations
  'workspace/pinSession': { fields: ['request.sessionId'] },
  'workspace/unpinSession': { fields: ['request.sessionId'] },
  'workspace/archiveSession': { fields: ['request.sessionId'] },
  'workspace/unarchiveSession': { fields: ['request.sessionId'] },
  // workspace — the global follow stream
  'workspace/follow': { fields: [], stream: true, streamFilter: 'workspace' },
  // the forwarded-event subscription (T32): special entry, no session fields —
  // its frames are judged per `agentId`, its answers per forwarded `eventId`
  '$zr/events': { fields: [], stream: true, events: true },
}

/** One invoke decision: allow (optionally through a standing result filter),
 * or the reason that goes into the 403 body. */
export type InvokeDenyReason = 'no-session' | 'not-shared' | 'forbidden-method'

export type InvokeDecision = { allow: true; filter?: InvokeFilter } | { allow: false; reason: InvokeDenyReason }

/** One stream decision: allow (global streams carry a `streamFilter`, scoped
 * streams list the session ids the subscription depends on — the relay kills
 * the stream and counts viewers with them, and the event subscription sets
 * `events`), or the 403 reason. */
export type StreamDecision =
  | { allow: true; filter?: StreamFilter; sessionIds: string[]; events?: true }
  | { allow: false; reason: InvokeDenyReason }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An OWNED session id: present and a non-empty string, anything else means
 * "the field does not locate a session" (an empty id is garbage, not one). */
function ownedId(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The session ids one registered method's arguments claim, read STRICTLY
 * along the registered fields (this replaces the old generic
 * `extractSessionIds` scan — that scan is exactly the decoy hole).
 *
 * `request.address` contributes its session id by kind: `session` →
 * `sessionId`, `subagent` → `parentSessionId` (the child never enters the
 * share table; DSH validates the parent-child link server-side). The
 * top-level fields (`agentId`, `parentSessionId`, `childSessionId`,
 * `sessionId`, `workspaceFileScopeId`) read the argument object itself —
 * all of them are session ids on the wire and share-check alike.
 * `request.workspaceId` contributes NO id — it must be present, but its
 * authorization is the route's workspace probe plus the auto-share of
 * the created session, not this table. Any other kind, or a missing id,
 * makes the method unauthorizable.
 */
const TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set([
  'agentId',
  'parentSessionId',
  'childSessionId',
  'sessionId',
  'workspaceFileScopeId',
])

function claimedSessionIds(entry: RelayMethod, args: unknown): { ids: string[] } | { reason: InvokeDenyReason } {
  // Field-less entries (the global reads) claim nothing by construction —
  // their safety comes from output filtering, and their wire shape is their
  // own (`session/list` takes `_request`, not `request`).
  if (entry.fields.length === 0) return { ids: [] }
  if (!isPlainObject(args)) return { reason: 'no-session' }
  const ids: string[] = []
  for (const field of entry.fields) {
    // Top-level fields read the argument object itself.
    if (TOP_LEVEL_FIELDS.has(field)) {
      const id = ownedId(args[field])
      if (id === undefined) return { reason: 'no-session' }
      ids.push(id)
      continue
    }
    const request = args.request
    if (!isPlainObject(request)) return { reason: 'no-session' }
    if (field === 'request.sessionId' || field === 'request.parentSessionId' || field === 'request.childSessionId') {
      const id = ownedId(request[field.slice('request.'.length)])
      if (id === undefined) return { reason: 'no-session' }
      ids.push(id)
      continue
    }
    if (field === 'request.workspaceId') {
      // Present and a non-empty string, but never share-checked — see the
      // SessionField note.
      if (ownedId(request.workspaceId) === undefined) return { reason: 'no-session' }
      continue
    }
    // 'request.address'
    const address = request.address
    if (!isPlainObject(address)) return { reason: 'no-session' }
    if (address.kind === 'session') {
      const id = ownedId(address.sessionId)
      if (id === undefined) return { reason: 'no-session' }
      ids.push(id)
    } else if (address.kind === 'subagent') {
      const id = ownedId(address.parentSessionId)
      if (id === undefined) return { reason: 'no-session' }
      ids.push(id)
    } else {
      // Unknown kind — not an address DSH would accept either.
      return { reason: 'no-session' }
    }
  }
  return { ids }
}

/**
 * Decide one relayed invoke against the per-method allowlist:
 *
 * 1. the method must be registered AND invoke-delivered (a `stream: true`
 *    entry refuses the invoke route) — anything else is `forbidden-method`;
 * 2. its registered fields must all yield an owned session id — else
 *    `no-session`;
 * 3. every claimed id must pass `isAccessible` — one unreachable id refuses
 *    the whole call (`not-shared`): an unshared session must not become
 *    readable through a shared one riding in the same arguments.
 *
 * A method registered with `resultFilter` allows with that marker attached;
 * the caller filters the result before it travels (never the reverse — the
 * filter is an OUTPUT discipline, the access check above stays input-only).
 */
export function decideInvoke(
  namespace: string,
  method: string,
  args: unknown,
  isAccessible: (sessionId: string) => boolean,
): InvokeDecision {
  const entry = RELAY_METHODS[`${namespace}/${method}`]
  if (entry === undefined || entry.stream === true) return { allow: false, reason: 'forbidden-method' }
  const claimed = claimedSessionIds(entry, args)
  if ('reason' in claimed) return { allow: false, reason: claimed.reason }
  for (const id of claimed.ids) {
    if (!isAccessible(id)) return { allow: false, reason: 'not-shared' }
  }
  return entry.resultFilter !== undefined ? { allow: true, filter: entry.resultFilter } : { allow: true }
}

/**
 * Decide one relayed STREAM subscription against the same table:
 *
 * 1. the method must be registered AND stream-delivered — an invoke-only
 *    method riding the stream route is `forbidden-method`, exactly like a
 *    stream method riding the invoke route;
 * 2. a global entry (`streamFilter` set) allows unconditionally — its frames
 *    are filtered per frame, so there is nothing to check up front;
 * 3. any other entry follows the {@link decideInvoke} field rules verbatim:
 *    all registered fields must yield owned ids and every id must be
 *    accessible, and the claimed ids ride back to the caller, which kills the
 *    subscription when one of them stops being shared.
 */
export function decideStream(
  namespace: string,
  method: string,
  args: unknown,
  isAccessible: (sessionId: string) => boolean,
): StreamDecision {
  const entry = RELAY_METHODS[`${namespace}/${method}`]
  if (entry === undefined || entry.stream !== true) return { allow: false, reason: 'forbidden-method' }
  if (entry.streamFilter !== undefined) return { allow: true, filter: entry.streamFilter, sessionIds: [] }
  if (entry.events === true) return { allow: true, sessionIds: [], events: true }
  const claimed = claimedSessionIds(entry, args)
  if ('reason' in claimed) return { allow: false, reason: claimed.reason }
  for (const id of claimed.ids) {
    if (!isAccessible(id)) return { allow: false, reason: 'not-shared' }
  }
  return { allow: true, sessionIds: claimed.ids }
}

/**
 * The `$events/result` answer body (T32), as the client sends it:
 * `{ eventId, result }`. `result` is the Remote event OUTCOME and travels
 * VERBATIM — dsh-api-gateway's `parseRemoteEventResult` is the validator
 * (exactly `{clientId,eventId,outcome}` up there; kinds `next` / `result`
 * with optional JSON `value` / `rejected` with `{name,message,code?,details?}`),
 * and a malformed one comes back as the gateway's own 200 error envelope, so
 * re-validating here would only invent a second dialect for the same refusal.
 * `eventId` ownership (forwarded on a live subscription, session still
 * reachable) is the ROUTE's check — it needs the handler's registry.
 */
export interface EventResultBody {
  eventId: string
  result: Record<string, unknown>
}

export function parseEventResultBody(body: unknown): EventResultBody | undefined {
  if (!isPlainObject(body)) return undefined
  const { eventId, result } = body
  if (typeof eventId !== 'string' || eventId === '') return undefined
  if (!isPlainObject(result)) return undefined
  return { eventId, result }
}

/**
 * The plain-HTTP panel long tail (T41b): the session-page surfaces that do
 * NOT ride the typert gateway but GET `/api/...` routes registered as exact
 * Fetch routes on the host's connection service (RT
 * dsh-client-ui-deliverables/lib/index.js — `ctx.connection.fetch.register`
 * at ~49-58 and ~84-90; the shared handler they dispatch through is
 * `createSharedFetchHandler('/api')`, dsh-client-connection/lib/index.js
 * ~608-637). Each entry names the query parameter that locates the session —
 * the same per-route registration discipline as RELAY_METHODS, and the same
 * refusal defaults: a route not in this table answers `unknown-route`
 * (404) before any id is read, and a registered route is judged ONLY along
 * its declared field.
 *
 * Deliberately ABSENT (the known limitations of the HTTP interception, kept
 * beside the registry that makes the contrast true):
 *
 * - `/api/session/uploadFileBinary` (attachment upload, RT
 *   dsh-client-ui-file-upload) — its Blob/stream branch runs inside a Web
 *   Worker over XHR / Worker-scoped fetch, which a `window.fetch` wrapper on
 *   the main page never sees. Attaching a NON-image file in a remote session
 *   therefore fails; inline images ride `session/prompt` content blocks and
 *   work.
 * - `/api/session.export` (session log download) — an anchor-click download,
 *   not a fetch call at all. Exporting from a remote session errors.
 * - `/api/present.host` — takes NO parameters and reports the machine the
 *   SERVER process runs on; forwarding it would read server-desktop facts
 *   into a panel whose actions stay hidden remotely, so it is not relayed.
 * - `/api/changes.open` and `/api/present.open` — POST actions that open
 *   files ON THE SERVER MACHINE (Finder / applications); meaningless from a
 *   sub-client, so the UI entries are hidden remotely (remote-session.css)
 *   and the routes are not registered here.
 */
export interface RelayHttpRoute {
  /** The query parameter carrying the owning session id. */
  sessionField: 'sessionId'
}

export const RELAY_HTTP_ROUTES: Readonly<Record<string, RelayHttpRoute>> = {
  'changes.summary': { sessionField: 'sessionId' },
  'changes.diff': { sessionField: 'sessionId' },
}

/** One plain-HTTP decision: allow — carrying the NORMALIZED query string
 * that is the only thing the caller may put on the synthetic Request URL —
 * or the reason for the answer: `unknown-route` (not in
 * {@link RELAY_HTTP_ROUTES}) answers 404, `no-session` (the field is missing
 * or duplicated) and `bad-query` (a whitelisted coordinate repeats or is not
 * a decimal non-negative integer string) answer 400, and `not-shared`
 * answers 403 like every other session-scoped refusal. */
export type HttpDenyReason = 'unknown-route' | 'no-session' | 'bad-query' | 'not-shared'

export type HttpDecision = { allow: true; query: string } | { allow: false; reason: HttpDenyReason }

/** True only for OWN registry keys: a bare route string from the wire is
 * indexed into a plain object, so `constructor` / `__proto__` must never
 * resolve through the prototype chain the way a bare `table[route]` would. */
function isRegisteredHttpRoute(route: string): boolean {
  return Object.prototype.hasOwnProperty.call(RELAY_HTTP_ROUTES, route)
}

/** A decimal non-negative integer string, exactly what the serving routes'
 * own coordinate parser accepts (RT dsh-client-ui-deliverables
 * lib/index.js `NUMERIC`). */
const DECIMAL = /^\d+$/

/**
 * The one value of a whitelisted query parameter, or `null` when it repeats
 * or is not a decimal non-negative integer string (a 400, not a pass-through
 * of whichever duplicate the URL parser happens to keep). `undefined` = the
 * parameter is legitimately absent.
 */
function singleCoordinate(params: URLSearchParams, name: string): string | undefined | null {
  const values = params.getAll(name)
  if (values.length === 0) return undefined
  const value = values.length === 1 ? values[0] : undefined
  if (value === undefined || !DECIMAL.test(value)) return null
  return value
}

/**
 * Decide one relayed `/api` GET against the per-route allowlist, and
 * NORMALIZE the query. The two halves of this route used to disagree about
 * parsing: `URLSearchParams` keeps `\t` / `\r` / `\n` inside key names
 * (`session\tId` is one parameter here) while the WHATWG URL parser strips
 * control characters before the request URL is built — so a query whose
 * checkable `sessionId` named a shared session could DISPATCH as two
 * parameters, with the serving route's own `get('sessionId')` reading the
 * first one, a secret (reviewer-confirmed 200). The fix is structural: this
 * function parses ONCE, takes only the whitelisted parameters — `sessionId`
 * exactly once (its id must pass the share table), `seq` / `index` at most
 * once each and decimal non-negative integers — and returns the rebuilt,
 * fixed-order query string; the caller composes the synthetic URL from THAT
 * string alone, never from raw input. Unknown parameters are dropped.
 */
export function decideHttpRoute(
  route: unknown,
  query: unknown,
  isAccessible: (sessionId: string) => boolean,
): HttpDecision {
  if (typeof route !== 'string' || !isRegisteredHttpRoute(route)) return { allow: false, reason: 'unknown-route' }
  if (typeof query !== 'string') return { allow: false, reason: 'no-session' }
  const raw = new URLSearchParams(query)
  const values = raw.getAll('sessionId')
  const id = values.length === 1 ? values[0] : undefined
  if (id === undefined || id === '') return { allow: false, reason: 'no-session' }
  const seq = singleCoordinate(raw, 'seq')
  const index = singleCoordinate(raw, 'index')
  if (seq === null || index === null) return { allow: false, reason: 'bad-query' }
  if (!isAccessible(id)) return { allow: false, reason: 'not-shared' }
  const normalized = new URLSearchParams()
  normalized.set('sessionId', id)
  if (seq !== undefined) normalized.set('seq', seq)
  if (index !== undefined) normalized.set('index', index)
  return { allow: true, query: normalized.toString() }
}
