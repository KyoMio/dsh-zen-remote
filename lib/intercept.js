/**
 * The local gateway interception (T23b-1): a sub-client's own DSH process
 * keeps serving its local UI, but calls that mention a remote session must
 * travel to the relay server instead. Installed directly on the RAW gateway
 * instance (`ctx.typertGateway[symbols.original]`) as own properties — the
 * load-bearing fact from docs/spike-relay.md §2.2 is that the gateway's
 * constructor registers arrow functions which look `openWireStream` /
 * `dispatchRpc` up on the instance at EVERY call, so an own property
 * shadows the prototype method. `checkGatewayShape` (intercept-shape.ts)
 * proves that property before anything is installed.
 *
 * Forwarding rules, mirroring the server side (relay-access.ts) so the two
 * ends disagree on nothing:
 *
 * - a call is "remote" only when a REGISTERED field of its method carries a
 *   virtual id (`zr~<serverId>~<id>`, virtual-id.ts). Methods outside the
 *   table get one defensive deep scan instead — a virtual id found anywhere
 *   must never reach the local DSH, so the call is refused
 *   (`remote-unsupported`); for registered methods only the registered
 *   fields are read, the same decoy discipline the server applies. The three
 *   field-less GLOBAL reads (`workspace/follow`, `session/control`,
 *   `session/list`) never refuse on their arguments either — since T23b-2
 *   they are MERGED instead: the local answer passes through and the relay's
 *   filtered answer is folded in by src/merge-streams.ts (remote workspaces
 *   appear as `zr~`-prefixed groups after the local ones; a remote baseline
 *   never reaches the UI as a second baseline).
 * - before forwarding, the call's virtual ids must all belong to ONE server
 *   AND to the server this relay client is handshook with (`remote-mismatch`);
 *   with no handshake at all the answer is `remote-offline`.
 * - a registered method forwards via `relay.invoke` / `relay.openStream`
 *   with the registered fields restored to original ids (`request.address`
 *   maps by kind: `session` → `sessionId`, `subagent` → `parentSessionId`;
 *   the childSessionId is already the server's own id and passes through).
 *   Results and stream frames are rewritten field by field — never by whole
 *   string replacement, event bodies keep their own ids — per the verified
 *   0.2.0-rc.1 wire inventory (see the per-method notes on
 *   {@link rewriteFrame} / {@link rewriteResult}).
 * - the wire shapes the host MANDATES are honored: every failure envelope
 *   carries `error.details` as an object (dsh-client-connection refuses a
 *   failure without one), every uplink the multiplex channel hands us is
 *   released and the stream forwarded anyway (the mux always passes an
 *   UplinkInbox — refusing uplinks would refuse every remote stream), and
 *   every error THROWN on the stream route is marked `isDSHRemoteError` with
 *   a string `code` (dsh-typert-protocol's remoteErrorOf folds unmarked
 *   errors into `gateway/internal`, losing the code).
 * - the 0.2.0 `openWireStream` is an ASYNC method — the host's mux does
 *   `await this.open(...)` and then `for await` over the result. The merge
 *   routes therefore await the local original too and hands the host back a
 *   promise of the merged iterable, the same shape the real method returns.
 *
 * T32 adds the forwarded-event pair, mirroring the server side:
 *
 * - `openWireStream('$events', …)` stays the stream the UI opened — local
 *   frames pass through untouched — while a relay `$zr/events` leg, reopened
 *   for as long as the relay is online, folds the SERVER's approval/question
 *   waterfalls in. Remote frames are rewritten before the UI ever sees them:
 *   `agentId` and `eventId` become `zr~<serverId>~…` virtual ids (those are
 *   the ONLY session ids a forwarded waterfall carries — the request bodies
 *   are tool/question data, verified against dsh-tools/dsh-user-questions),
 *   and the remote `ready`/`emit` frames are DROPPED: the client face of the
 *   gateway (dsh-api-gateway lib/client.js) accepts a ready frame only as
 *   the FIRST frame of the stream and would fail the stream on a second one,
 *   and emit events broadcast server-wide state the UI must not mistake for
 *   local sessions. Prompts this leg showed are closed when the leg dies —
 *   each gets a synthesized `cancel` — so a disconnect cannot leave an
 *   approval on screen that no server can settle anymore (T32-fix).
 * - `dispatchRpc('$events/result', …)` splits on the eventId: a virtual id
 *   is swapped back to the original and answered through the relay's
 *   `postEventResult` (the server composes the gateway payload with its own
 *   clientId — the local payload's clientId is the local stream's and is
 *   discarded); anything else reaches the local gateway verbatim. A relay
 *   refusal that means "this event is already over" (`unknown-event`,
 *   `not-shared` — the route's 403 refusals) is answered as silent
 *   success — exactly how DSH treats a stale result — because a thrown
 *   answer fails the UI's whole `$events`
 *   generation (client face: pumpEvents aborts on answer failures).
 */
import { RelayError } from './relay-client.js';
import { checkGatewayShape } from './intercept-shape.js';
import { fromVirtual, toVirtual } from './virtual-id.js';
import { createControlMerger, createWorkspaceMerger, mergeSessionList } from './merge-streams.js';
/**
 * The client-side half of the server's `RELAY_METHODS` registry: which
 * argument field locates the session for each method. METHODS AND FIELDS
 * MUST stay identical to the server table (test/intercept.test.cjs pins the
 * equality by reading relay-access's table directly) — a method the server
 * does not serve would answer `forbidden-method` forever, and a field the
 * server does not check would strand a virtual id un-rewritten.
 *
 * The three global reads carry no field: nothing in their arguments is
 * session-scoped, so they are never REFUSED on their arguments — a stray
 * virtual id there is unowned data. Instead the T23b-2 routes merge their
 * answers with the relay's filtered ones (merge-streams.ts).
 */
export const CLIENT_METHOD_FIELDS = {
    // session/* — ownership via the address envelope
    'session/follow': ['request.address'],
    'session/page': ['request.address'],
    // session/* — ownership via request.sessionId
    'session/projections': ['request.sessionId'],
    'session/prompt': ['request.sessionId'],
    'session/cancel': ['request.sessionId'],
    'session/rename': ['request.sessionId'],
    'session/selectModel': ['request.sessionId'],
    'session/updateQueue': ['request.sessionId'],
    'session/attachment': ['request.sessionId'],
    // session/* — creation and forking (T31): a create is spotted by its VIRTUAL
    // workspace id and forwarded with that id restored; the client never lets a
    // remote create name its own session id (deleted before forwarding), and
    // create/fork results get the new session id virtualized (rewriteResult).
    'session/create': ['request.workspaceId'],
    'session/fork': ['request.sessionId'],
    // subagents (T31, both slots since T41a) — the parent locates the call and
    // DSH re-validates the parent-child link; the child id arrives from server
    // frames VIRTUALIZED (session/follow snapshots carry it in header.id), so
    // it is restored like the parent before forwarding
    'subagents/prompt': ['request.parentSessionId', 'request.childSessionId'],
    'subagents/interruptByParent': ['parentSessionId', 'childSessionId'],
    // attachments and @ references (T31) — the top-level agentId IS the session
    // id (the gateway's agent lookup resolves it through the session-keyed
    // agent registry).
    'fileUploads/upload': ['agentId'],
    'fileReferences/list': ['agentId'],
    // goal panel (T41a) — top-level agentId, same shape as fileUploads;
    // goals/create|complete stay unregistered (not in the UI's goal bar)
    'goals/get': ['agentId'],
    'goals/edit': ['agentId'],
    'goals/pause': ['agentId'],
    'goals/resume': ['agentId'],
    'goals/clear': ['agentId'],
    // slash commands + the preset switches they drive (T41a)
    'commands/list': ['agentId'],
    'commands/execute': ['agentId'],
    'agentPresets/select': ['agentId'],
    'sessionReferenceResolver/candidates': ['agentId'],
    // session feedback (T41a) — plain request.sessionId
    'sessionFeedback/record': ['request.sessionId'],
    // file tree and previews (T41a) — the top-level workspaceFileScopeId IS the
    // session id, but the session cwd is only the base for relative paths:
    // absolute paths anywhere the server process can read are served (RT
    // dsh-api-workspace-files: "including paths outside the workspace … not a
    // read-containment restriction") — the same trust premise as the
    // server-side terminals (SPEC story 45), deliberately accepted. changes is
    // the tree's live stream.
    'workspaceFiles/list': ['workspaceFileScopeId'],
    'workspaceFiles/changes': ['workspaceFileScopeId'],
    'workspaceFiles/read': ['workspaceFileScopeId'],
    'workspaceFiles/readBytes': ['workspaceFileScopeId'],
    'workspaceFiles/stat': ['workspaceFileScopeId'],
    // terminal (T41a) — opens SERVER-side by explicit user request (SPEC story
    // 45); the boundary is the standing one (shared session + paired desktop
    // client), no extra switch. The terminal and attachment ids in these calls
    // are client-generated (distinct wire type symbols) and pass through.
    'terminal/environment': ['agentId'],
    'terminal/shells': ['agentId'],
    'terminal/create': ['agentId'],
    'terminal/write': ['agentId'],
    'terminal/resize': ['agentId'],
    'terminal/rename': ['agentId'],
    'terminal/close': ['agentId'],
    'terminal/follow': ['agentId'],
    // the retain/list half locates by a plain top-level json sessionId
    'terminal/list': ['sessionId'],
    'terminal/retain': ['sessionId'],
    // session/* — the global control stream and the unscoped list: merged with
    // the relay's filtered answer by the T23b-2 routes below (never refused on
    // arguments — a stray id in them is unowned data).
    'session/control': [],
    'session/list': [],
    // job/*
    'job/list': ['request.sessionId'],
    'job/follow': ['request.sessionId'],
    'job/kill': ['request.sessionId'],
    // skills, message feedback
    'skills/list': ['request.sessionId'],
    'messageFeedback/list': ['request.sessionId'],
    'messageFeedback/put': ['request.sessionId'],
    'messageFeedback/delete': ['request.sessionId'],
    // schedule (list only, mirroring the server table)
    'schedule/list': ['request.sessionId'],
    // workspace session-scoped mutations
    'workspace/pinSession': ['request.sessionId'],
    'workspace/unpinSession': ['request.sessionId'],
    'workspace/archiveSession': ['request.sessionId'],
    'workspace/unarchiveSession': ['request.sessionId'],
    // workspace — the global follow stream, merged like the two session/* reads
    'workspace/follow': [],
    // The forwarded-event subscription (T32): the client reaches it through
    // relay.openStream('$zr','events') directly, never through the local
    // gateway — the empty fields entry exists to keep the two tables pinned
    // method-for-method identical (the test below reads the server table).
    '$zr/events': [],
};
/**
 * The READ methods of the client registry (T34, whitelist form per T34-fix):
 * the methods allowed through while the relay is not `online`. Everything in
 * {@link CLIENT_METHOD_FIELDS} NOT listed here is a WRITE and is refused
 * locally with `remote-offline` while offline — a write can only fail out
 * there, and the honest local answer beats a dead round-trip. Maintaining
 * the READ side keeps the failure mode safe: a future table entry nobody
 * classified lands on the write side (refused offline), never silently
 * forwarded into a dead link.
 *
 * The read list, method by method:
 *
 * - every `stream: true` entry of the server table — a subscription
 *   observes, it never mutates: `session/follow`, `session/control`,
 *   `job/list`, `job/follow`, `workspace/follow`, and the T32
 *   `$zr/events` pair entry (never client-dialed, listed for the table
 *   guard);
 * - `session/list` — the unscoped first-page read the merge route folds in;
 * - `session/page` (history read), `session/projections` (control-key
 *   read), `session/attachment` — verified against RT: it READS one durable
 *   image back (base64), it does not attach anything;
 * - `skills/list`, `messageFeedback/list`, `schedule/list` — list reads;
 * - `fileReferences/list` (T31) — the @-reference listing; its put/delete
 *   siblings would be writes, but only this listing is in the table.
 *
 * Everything else — `session/prompt|cancel|rename|selectModel|updateQueue`
 * (send, cancel, rename, model switch, inbox mutation), `session/create` /
 * `session/fork` (T31: new sessions on the server), `subagents/prompt` /
 * `subagents/interruptByParent` (T31: prompt/interrupt a remote subagent),
 * `fileUploads/upload` (T31: attachments into a remote session), `job/kill`,
 * `messageFeedback/put|delete`, the workspace session-list mutations, and
 * the T41a mutations (`goals/edit|pause|resume|clear`, `commands/execute`,
 * `agentPresets/select`, `sessionFeedback/record`,
 * `terminal/create|write|resize|rename|close|follow`) — is a write.
 * `terminal/follow` joined the write side (T41a-fix2): its attachment is
 * NOT a pure read — RT dsh-api-terminal-controller follow: "Attach with
 * exclusive input control; an older attachment becomes read-only" — so a
 * follow flips which follower owns the terminal's input, and offline it
 * must refuse like every other mutation instead of silently stealing
 * control from a connection that is not there.
 */
export const REMOTE_READ_METHODS = new Set([
    'session/follow',
    'session/control',
    'job/list',
    'job/follow',
    'workspace/follow',
    '$zr/events',
    'session/list',
    'session/page',
    'session/projections',
    'session/attachment',
    'skills/list',
    'messageFeedback/list',
    'schedule/list',
    'fileReferences/list',
    // T41a reads: the goal bar read, the slash-command catalog, the @-session
    // candidates, workspace file listing / reads / stats and their change
    // stream, the terminal environment/shell catalog, the session's terminal
    // list and its keep-alive stream. `terminal/follow` is NOT here
    // (T41a-fix2): its attachment takes over the terminal's input control
    // ("an older attachment becomes read-only", RT dsh-api-terminal-controller
    // follow), which is a state change — it sits on the write side and is
    // refused remote-offline like every other mutation.
    'goals/get',
    'commands/list',
    'sessionReferenceResolver/candidates',
    'workspaceFiles/list',
    'workspaceFiles/changes',
    'workspaceFiles/read',
    'workspaceFiles/readBytes',
    'workspaceFiles/stat',
    'terminal/environment',
    'terminal/shells',
    'terminal/list',
    'terminal/retain',
]);
/** Whether `endpoint` (a client-table method) is a remote WRITE: anything
 * the read whitelist does not name (T34-fix). */
export function isRemoteWrite(endpoint) {
    return !REMOTE_READ_METHODS.has(endpoint);
}
/** The refusal a write gets while the relay is not serving (T34). */
const WRITE_OFFLINE_MESSAGE = '服务端离线，远程会话暂时只读';
/**
 * The error shape the host's stream channel forwards intact: only errors
 * with `isDSHRemoteError === true` and a string `code` keep their identity
 * across the wire (dsh-typert-protocol's remoteErrorOf) — anything else is
 * folded into `gateway/internal`. This local class reproduces that shape
 * without importing the host package.
 */
class CodedStreamError extends Error {
    code;
    details;
    isDSHRemoteError = true;
    constructor(code, message) {
        super(message);
        this.name = 'RemoteError';
        this.code = code;
        this.details = {};
    }
}
/**
 * Half-close one uplink without consuming it — the host's own move for
 * streams that take no uplink items (`$events`: gateway releaseUplink). The
 * multiplexed wire channel ALWAYS passes a `UplinkInbox` here, never
 * undefined; leaving it unreleased is cleaned up by the pump's teardown, but
 * releasing is the polite half-close and costs nothing. Every step is
 * tolerant: an uplink without an async iterator (or one whose `return`
 * rejects) must never fail the stream we are about to forward.
 */
function releaseUplink(uplink) {
    try {
        const source = uplink;
        const iterator = source?.[Symbol.asyncIterator]?.();
        if (iterator?.return === undefined)
            return;
        void Promise.resolve(iterator.return()).catch(() => { });
    }
    catch {
        // A non-iterable uplink has nothing to release.
    }
}
/**
 * The gateway error codes that count as version-mismatch symptoms, verified
 * against dsh-api-gateway 0.2.0-rc.1 (`lib/index.js`):
 * `gateway/arguments-invalid` — the args fields do not match the endpoint's
 * descriptor; `gateway/input-invalid` — a wire field failed the codec's
 * boundary parse; `gateway/invocation-unavailable` — no active Remote method
 * exports the endpoint at all (the client called an interface an older
 * server does not have). Other gateway codes answer different questions
 * (a cancelled call, a missing service binding) and are NOT version
 * symptoms. Deliberately ABSENT: `gateway/result-invalid` — despite the
 * name it only means "a stream Remote method did not return an iterable"
 * (a server implementation bug class); the gateway does NOT schema-validate
 * results, so a result-shape disagreement between versions is invisible
 * here and stays the fingerprint layer's job.
 */
export const INCOMPATIBLE_CALL_CODES = new Set([
    'gateway/arguments-invalid',
    'gateway/input-invalid',
    'gateway/invocation-unavailable',
]);
/** Longest incompatible-call ring kept for the status surface (T42). */
const MAX_INCOMPATIBLE_CALLS = 50;
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Non-empty string — the client face's `isRemoteEventId` /
 * `isRemoteEventAgentId` / `validRemoteEventName` (dsh-api-gateway
 * lib/client.js). */
function isEventId(value) {
    return typeof value === 'string' && value !== '';
}
function isForwardableWaterfall(frame) {
    return (Reflect.ownKeys(frame).length === 5 &&
        ['type', 'event', 'eventId', 'agentId', 'request'].every((key) => Object.hasOwn(frame, key)) &&
        isEventId(frame.event) &&
        isEventId(frame.eventId) &&
        isEventId(frame.agentId) &&
        isPlainObject(frame.request) &&
        !Object.hasOwn(frame.request, 'agent') &&
        !Object.hasOwn(frame.request, 'signal'));
}
function isForwardableCancel(frame) {
    return (Reflect.ownKeys(frame).length === 2 &&
        Object.hasOwn(frame, 'type') &&
        Object.hasOwn(frame, 'eventId') &&
        isEventId(frame.eventId));
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** `payload` rides in as `{ args }`; anything else means "no arguments". */
function argsOf(payload) {
    if (!isPlainObject(payload))
        return undefined;
    return payload.args;
}
/**
 * Visit every argument slot a method's registered fields locate. The slot's
 * CONTAINER and KEY are handed over so the same walk serves both scanning
 * (read `container[key]`) and rewriting (write it) — one definition of "the
 * field this method owns", shared by both directions.
 *
 * `request.address` contributes one slot by kind: `session` → `sessionId`,
 * `subagent` → `parentSessionId` (the child id in an address is already the
 * server's original and passes through untouched). Unknown kinds own no
 * slot. The top-level fields (`agentId`, `parentSessionId`, `childSessionId`,
 * `sessionId`, `workspaceFileScopeId`) live on the argument object itself;
 * `request.workspaceId` / `request.parentSessionId` / `request.childSessionId`
 * on the request object.
 */
const TOP_LEVEL_FIELDS = new Set([
    'agentId',
    'parentSessionId',
    'childSessionId',
    'sessionId',
    'workspaceFileScopeId',
]);
const REQUEST_FIELDS = new Set(['sessionId', 'parentSessionId', 'childSessionId']);
function forEachRegisteredSlot(fields, args, visit) {
    if (!isPlainObject(args))
        return;
    for (const field of fields) {
        if (TOP_LEVEL_FIELDS.has(field)) {
            visit(args, field);
            continue;
        }
        const request = args.request;
        if (!isPlainObject(request))
            continue;
        const short = field.slice('request.'.length);
        if (REQUEST_FIELDS.has(short)) {
            visit(request, short);
            continue;
        }
        if (field === 'request.workspaceId') {
            visit(request, 'workspaceId');
            continue;
        }
        const address = request.address;
        if (!isPlainObject(address))
            continue;
        if (address.kind === 'session')
            visit(address, 'sessionId');
        else if (address.kind === 'subagent')
            visit(address, 'parentSessionId');
    }
}
/** Depth-bounded walk collecting every virtual-id-shaped string — the
 * defensive scan for methods OUTSIDE the table, where the registered fields
 * are unknown by definition. A virtual id may never ride into the local
 * gateway, wherever it hides. */
function deepScanVirtualIds(value, depth, into) {
    if (depth <= 0)
        return;
    if (typeof value === 'string') {
        const parts = fromVirtual(value);
        if (parts !== undefined)
            into.push(parts);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value)
            deepScanVirtualIds(item, depth - 1, into);
        return;
    }
    if (isPlainObject(value)) {
        for (const item of Object.values(value))
            deepScanVirtualIds(item, depth - 1, into);
    }
}
/**
 * Every virtual id this call claims, as parsed parts. Registered methods
 * are read STRICTLY along their registered fields; unregistered methods get
 * the deep scan. The result decides passthrough (empty) vs validation.
 */
function collectVirtuals(fields, args) {
    if (fields === undefined) {
        const found = [];
        deepScanVirtualIds(args, 10, found);
        return found;
    }
    if (fields.length === 0)
        return [];
    const found = [];
    forEachRegisteredSlot(fields, args, (container, key) => {
        const parts = fromVirtual(container[key]);
        if (parts !== undefined)
            found.push(parts);
    });
    return found;
}
/**
 * Restore registered fields on an args CLONE from virtual to original ids.
 * Only slots actually holding virtual ids are touched; every collected
 * virtual has already been verified to belong to one server.
 */
function restoreRegisteredFields(fields, args) {
    forEachRegisteredSlot(fields, args, (container, key) => {
        const parts = fromVirtual(container[key]);
        if (parts !== undefined)
            container[key] = parts.id;
    });
}
/** The result-side session-id inventory, VERIFIED field by field against the
 * 0.2.0-rc.1 generated definitions (`lib/typert.remote-client.js`, identical
 * across 0.1.7/0.2.0 per spike §2.3):
 *
 * - `session/follow` frames are a 3-variant union: `snapshot` carries the
 *   session identity in `header.id` (and `header.parentSession` for
 *   subagent sessions); `event` and `assistant-stream` frames carry no
 *   session id outside event bodies, which are never rewritten.
 * - `job/list` frames are `{type:'rows', jobs:[…]}`, each job's `owner` is
 *   its owning session id; `job/follow` frames are `opened{job}` /
 *   `status{job}` / `output{chunks}` (0.2.0 job-controller descriptors) and
 *   the first two carry the SAME job record — `job.owner` rewritten, the
 *   output frame has no job and passes through.
 * - `workspace/pin|unpinSession` return the workspace's `pinnedSessionIds`,
 *   `archive|unarchiveSession` its `archivedSessionIds` — all server-side
 *   session ids (the whole result comes from the server, so mapping every
 *   entry is consistent, and a forwarded result can never contain local ids).
 * - `messageFeedback/list|put|delete` succeed with no ids at all; only
 *   their `{ok:false, error:{code:'session-not-found', sessionId}}` variant
 *   carries one.
 * - `session/create` (T31) answers `{sessionId, agentPreset?}` and
 *   `session/fork` answers `{sessionId}` — both carry the NEW session's id,
 *   minted server-side, and both get it virtualized (the sessions were
 *   auto-shared by the relay, so the id is immediately usable).
 * - `sessionReferenceResolver/candidates` (T41a) answers one row per @
 *   candidate. The relay server keeps only rows whose session passes the
 *   share table (relay-server.ts), and the client virtualizes what travels:
 *   the row's `sessionId` and the `dsh-session:` URI inside its `mention`,
 *   so a picked candidate rides back through the follow/prompt routes as a
 *   virtual id and the prompt-text restore can decode it again.
 * - `sessionFeedback/record` (T41a) succeeds with no ids; only its
 *   `{ok:false, error:{code:'session-not-found', sessionId}}` variant
 *   carries one — same shape as the messageFeedback half.
 * - `workspaceFiles/changes` frames are `{kind:'ready'}` /
 *   `{kind:'change', change:{absolutePath, …}}` and the terminal frames
 *   (`terminal/follow` snapshot/output/state, `terminal/retain` retained)
 *   carry terminal ids, attachment ids and controller ids — client-side
 *   identity, never session ids — so all three T41a streams pass through
 *   `rewriteFrame` untouched.
 * - everything else in the table (`session/page`, `session/projections`,
 *   `session/prompt|cancel|rename|selectModel|updateQueue|attachment`,
 *   `job/kill`, `skills/list`, `schedule/list`, `subagents/prompt`
 *   (`{messageId}`), `subagents/interruptByParent` (`{accepted}`),
 *   `fileUploads/upload` (receipt + attachment ids, not session ids),
 *   `fileReferences/list` (`{path,kind}` rows), `goals/get|edit|pause|resume|
 *   clear` (GoalView/GoalRef ids are GOAL ids), `commands/list|execute`
 *   (`commandId` is a command id), `agentPresets/select` (a preset id
 *   string), `workspaceFiles/list|read|readBytes|stat` (paths, versions,
 *   text/bytes), `terminal/*` (terminal ids, attachment ids, controller ids
 *   — client-side identity, never session ids)) has NO
 *   session id in its result — verified, and passed through untouched.
 */
function mapStrings(value, map) {
    if (!Array.isArray(value))
        return value;
    return value.map((item) => (typeof item === 'string' ? map(item) : item));
}
// The `dsh-session:` codec and the shared scan rule (T41a-fix2): ONE module
// serves both ends — the relay server scans these same positions
// (relay-server.ts), so where a reference can hide is decided in exactly
// one place.
import { SESSION_REFERENCE_URI, decodeSessionReferenceUri, encodeSessionReferenceUri, mapReferenceTexts, } from './session-reference.js';
/**
 * Swap the canonical URI inside one `@[label](dsh-session:…)` mention for
 * `target`'s id, or `undefined` when the mention carries no decodable
 * (canonical) URI — a malformed mention travels untouched and fails, if at
 * all, in the host's own parser.
 */
function rewriteMentionUri(mention, target) {
    const match = /\((dsh-session:[^\s)]*)\)\s*$/.exec(mention);
    if (match === null || match[1] === undefined)
        return undefined;
    if (decodeSessionReferenceUri(match[1]) === undefined)
        return undefined;
    const head = mention.slice(0, match.index);
    const tail = mention.slice(match.index + match[0].length);
    return `${head}(${encodeSessionReferenceUri(target)})${tail}`;
}
/**
 * The prompt-text half of the reference discipline (T41a-fix, widened by
 * T41a-fix2): DSH injects whatever a canonical `dsh-session:` address in an
 * injectable text names (prepareDirectMessages → readSurface, no access
 * check of its own), and the relay server refuses addresses naming a session
 * off its share table. WHERE those texts live is the shared rule
 * (session-reference.ts — prompt content, a queue EDIT's replacement
 * content, every string of a commands/execute call): the same rule the
 * server scans by, so the ends cannot drift. Before a call travels, every
 * address carrying a virtual id of THIS server is restored to the original
 * id — and an address naming anything else (a LOCAL session of this
 * sub-client, another server's virtual id) is a refusal: the server does
 * not have that session. Non-canonical tokens are left alone — the host
 * parser throws its own business error on those. Returns the args to
 * forward (clone-on-write) and whether the call may travel at all.
 */
function restoreSessionReferences(args, namespace, method, serverId) {
    let ok = true;
    const mapped = mapReferenceTexts(namespace, method, args, (text) => {
        const pieces = [];
        let last = 0;
        let changed = false;
        for (const match of text.matchAll(SESSION_REFERENCE_URI)) {
            const uri = match[1] ?? match[2];
            const start = match.index ?? 0;
            pieces.push(text.slice(last, start));
            const id = uri === undefined ? undefined : decodeSessionReferenceUri(uri);
            if (uri === undefined || id === undefined) {
                // Not a reference the host would accept either — pass through.
                pieces.push(match[0]);
            }
            else {
                const parts = fromVirtual(id);
                if (parts === undefined || parts.serverId !== serverId) {
                    ok = false;
                    pieces.push(match[0]);
                }
                else {
                    changed = true;
                    const restored = uri === match[0] ? encodeSessionReferenceUri(parts.id) : `${match[0].slice(0, match[0].length - uri.length - 1)}${encodeSessionReferenceUri(parts.id)})`;
                    pieces.push(restored);
                }
            }
            last = start + match[0].length;
        }
        if (!changed)
            return text;
        pieces.push(text.slice(last));
        return pieces.join('');
    });
    return { args: mapped, ok };
}
/** Rewrite one stream frame's session ids to virtual form. */
export function rewriteFrame(endpoint, frame, serverId) {
    const virtualize = (id) => toVirtual(serverId, id);
    if (endpoint === 'session/follow') {
        if (!isPlainObject(frame) || frame.type !== 'snapshot' || !isPlainObject(frame.header))
            return frame;
        const header = { ...frame.header };
        if (typeof header.id === 'string')
            header.id = virtualize(header.id);
        if (typeof header.parentSession === 'string')
            header.parentSession = virtualize(header.parentSession);
        return { ...frame, header };
    }
    if (endpoint === 'job/list') {
        if (!isPlainObject(frame) || frame.type !== 'rows' || !Array.isArray(frame.jobs))
            return frame;
        return {
            ...frame,
            jobs: frame.jobs.map((job) => isPlainObject(job) && typeof job.owner === 'string' ? { ...job, owner: virtualize(job.owner) } : job),
        };
    }
    if (endpoint === 'job/follow') {
        // `opened{job}` and `status{job}` carry the job record; `output` has no
        // job and falls through the guard untouched.
        if (!isPlainObject(frame) || !isPlainObject(frame.job) || typeof frame.job.owner !== 'string')
            return frame;
        return { ...frame, job: { ...frame.job, owner: virtualize(frame.job.owner) } };
    }
    return frame;
}
/** Rewrite one invoke result's session ids to virtual form. */
export function rewriteResult(endpoint, value, serverId) {
    const virtualize = (id) => toVirtual(serverId, id);
    if (endpoint === 'session/create' || endpoint === 'session/fork') {
        // The one session id the result carries is the NEW session's, minted
        // server-side (create: `{sessionId, agentPreset?}`, fork: `{sessionId}`).
        if (!isPlainObject(value) || typeof value.sessionId !== 'string')
            return value;
        return { ...value, sessionId: virtualize(value.sessionId) };
    }
    if (endpoint === 'messageFeedback/list' || endpoint === 'messageFeedback/put' || endpoint === 'messageFeedback/delete') {
        if (!isPlainObject(value) || value.ok !== false || !isPlainObject(value.error))
            return value;
        const error = value.error;
        if (typeof error.sessionId !== 'string')
            return value;
        return { ...value, error: { ...error, sessionId: virtualize(error.sessionId) } };
    }
    if (endpoint === 'sessionFeedback/record') {
        // Same result shape as the messageFeedback half: only the
        // session-not-found failure variant carries a session id.
        if (!isPlainObject(value) || value.ok !== false || !isPlainObject(value.error))
            return value;
        const error = value.error;
        if (typeof error.sessionId !== 'string')
            return value;
        return { ...value, error: { ...error, sessionId: virtualize(error.sessionId) } };
    }
    if (endpoint === 'sessionReferenceResolver/candidates') {
        // One row per @ candidate. The relay server already DROPPED every row
        // whose session is not on its share table (relay-server.ts, the
        // session/list discipline) — what travels here names accessible sessions
        // only, and each row's `sessionId` and `mention` URI are virtualized so
        // a picked candidate rides back through the follow/prompt routes as a
        // virtual id and the prompt-text restore can decode it again.
        if (!Array.isArray(value))
            return value;
        return value.map((row) => {
            if (!isPlainObject(row) || typeof row.sessionId !== 'string')
                return row;
            const virtual = virtualize(row.sessionId);
            let next = { ...row, sessionId: virtual };
            if (typeof row.mention === 'string') {
                const rewritten = rewriteMentionUri(row.mention, virtual);
                if (rewritten !== undefined)
                    next = { ...next, mention: rewritten };
            }
            return next;
        });
    }
    if (endpoint === 'workspace/pinSession' || endpoint === 'workspace/unpinSession') {
        if (!isPlainObject(value))
            return value;
        return { ...value, pinnedSessionIds: mapStrings(value.pinnedSessionIds, virtualize) };
    }
    if (endpoint === 'workspace/archiveSession' || endpoint === 'workspace/unarchiveSession') {
        if (!isPlainObject(value))
            return value;
        return { ...value, archivedSessionIds: mapStrings(value.archivedSessionIds, virtualize) };
    }
    return value;
}
/**
 * Rewrite one SERVER-side `$events` frame for the local UI (T32), or `null`
 * to drop it. Wire shapes verified against dsh-api-gateway (frames:
 * `openRemoteEvents`/`broadcastRemoteEvent`/`startRemoteEvent`/
 * `finishRemoteEvent`; consumer validation: lib/client.js
 * `parseRemoteEventFrame` — every variant demands EXACT keys, so rewriting
 * must rename in place and never add or remove a field):
 *
 * - `waterfall`: `{type, event, eventId, agentId, request}` — `eventId` and
 *   `agentId` become virtual; `request` passes verbatim (the projection the
 *   gateway already stripped `agent`/`signal` from carries no session id:
 *   approval requests are `{toolName, callId, reason?, displayReason?}`,
 *   question requests `{questions:[…]}` — dsh-tools / dsh-user-questions).
 *   The server already prefixed the eventId with its per-subscription token
 *   (`<token>.<eventId>`); this layer treats that as opaque and wraps the
 *   whole thing in `zr~<serverId>~`.
 * - `cancel`: `{type, eventId}` — the correlation id goes virtual so the UI
 *   can match it against the waterfall it showed and close the prompt.
 * - everything else — `ready`, `emit`, non-objects, unknown types, and any
 *   waterfall/cancel failing the client face's exact-keys shape — is
 *   DROPPED (T32-fix2 mirrors the server side). `ready` and `emit` carry
 *   facts the UI must never see (the local stream opened with ITS ready
 *   frame; emit broadcasts server-wide state); a malformed frame that
 *   slipped through would fail `parseRemoteEventFrame` and take the UI's
 *   whole `$events` generation down with it, failing and reconnecting in a
 *   loop. Mirrors the server's own forwardable-shape gate, so the two ends
 *   disagree on nothing.
 */
export function rewriteRemoteEventFrame(frame, serverId) {
    const virtualize = (id) => toVirtual(serverId, id);
    if (!isPlainObject(frame))
        return null;
    if (frame.type === 'ready')
        return null;
    if (frame.type === 'emit')
        return null;
    if (frame.type === 'waterfall') {
        if (!isForwardableWaterfall(frame))
            return null;
        return { ...frame, eventId: virtualize(frame.eventId), agentId: virtualize(frame.agentId) };
    }
    if (frame.type === 'cancel') {
        if (!isForwardableCancel(frame))
            return null;
        return { ...frame, eventId: virtualize(frame.eventId) };
    }
    return null;
}
/** Longest failure ring kept for the status surface. */
const MAX_FAILURES = 20;
/** Longest closed-session registry kept for the status surface (T34). */
const MAX_CLOSED_SESSIONS = 200;
/** The close reasons the server's structured field may name; anything else
 * (an older server without the field) degrades to the manual close. */
function closedReasonOf(error) {
    return error.reason === 'client' || error.reason === 'idle' ? error.reason : 'manual';
}
// ---- the global reads (T23b-2): merge-stream routes -----------------------
function isAsyncIterable(value) {
    if (value === null || typeof value !== 'object')
        return false;
    return typeof value[Symbol.asyncIterator] === 'function';
}
/** The (serverId, serverName) the current handshake names — the identity a
 * merge route virtualizes with and watches for changes. */
function relayIdentityOf(client) {
    const info = client.handshakeInfo;
    if (info === undefined || info.serverId === '')
        return undefined;
    return { serverId: info.serverId, serverName: info.serverName };
}
/**
 * One delivery queue between the two pump tasks and the consumer: frames
 * leave in arrival order, the first failure wins, `end`/`fail` after `end`
 * are no-ops. Single consumer, single-reader — exactly the merged stream's
 * shape.
 */
function createFrameChannel() {
    const items = [];
    let waiter;
    let ended = false;
    let failure;
    return {
        push(frame) {
            if (ended)
                return;
            if (waiter !== undefined) {
                const pending = waiter;
                waiter = undefined;
                pending.resolve({ value: frame, done: false });
                return;
            }
            items.push(frame);
        },
        end() {
            if (ended)
                return;
            ended = true;
            if (waiter !== undefined) {
                const pending = waiter;
                waiter = undefined;
                pending.resolve({ value: undefined, done: true });
            }
        },
        fail(error) {
            if (ended)
                return;
            ended = true;
            if (waiter !== undefined) {
                const pending = waiter;
                waiter = undefined;
                pending.reject(error);
                return;
            }
            failure = { error };
        },
        next() {
            if (items.length > 0)
                return Promise.resolve({ value: items.shift(), done: false });
            if (failure !== undefined) {
                const stored = failure;
                failure = undefined;
                return Promise.reject(stored.error);
            }
            if (ended)
                return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve, reject) => {
                waiter = { resolve, reject };
            });
        },
    };
}
/**
 * The merged global stream: the local frames and the relay's filtered
 * frames interleave in arrival order, each side fed through its merger
 * (merge-streams.ts). The local stream is the stream the UI actually
 * opened — its end ends everything (remote leg aborted first), its error
 * is the consumer's error. A remote death (error or clean end), a merely
 * offline relay, AND the relay entering `unpaired` / `revoked` emit NOTHING
 * and keep the shown state (T23b2-fix + T23b2-fix3): the UI blacklists
 * removed virtual ids forever, so any remove of a still-valid prefix would
 * make the group un-revivable — and the server PERSISTS its serverId
 * (relay-server.ts loadServerId), so a re-pair to the same server reuses the
 * prefix and revives the group through the reconnecting baseline's diff.
 * Only a serverId CHANGE removes the whole group (a new prefix), and a
 * rename re-upserts the shown groups under the new title without a reopen.
 */
async function* mergedGlobalStream(deps) {
    const { endpoint, namespace, method, local, relay, signal, recordFailure, log } = deps;
    // An already-aborted caller has nothing to merge — end both legs (neither
    // has started) immediately instead of letting the local stream open into
    // a dead iteration.
    if (signal?.aborted === true)
        return;
    const onDiagnostic = (message) => {
        log?.('client merge dropped a frame on %s: %s', endpoint, message);
    };
    const initial = relayIdentityOf(relay);
    // Created eagerly so the local leg is observed from its first frame on.
    // The empty identity is a placeholder: the remote pump retargets before
    // any remote frame is ever fed (it only runs under a real handshake).
    let merger = endpoint === 'session/control'
        ? createControlMerger({ serverId: initial?.serverId ?? '', serverName: initial?.serverName ?? '', onDiagnostic })
        : createWorkspaceMerger({ serverId: initial?.serverId ?? '', serverName: initial?.serverName ?? '', onDiagnostic });
    /**
     * The status annotation (T34) the CURRENT relay state maps onto, applied
     * only while the server identity is unchanged (a changed serverId is the
     * removal path, titles do not matter). Priority: revoked / unpaired >
     * offline > version mismatch — while the link is down the mismatch cannot
     * even be evaluated honestly (the verdict may predate the outage), so
     * `offline` wins; `connecting` / `incompatible` count as offline (both are
     * "not serving, recovery pending"). Back `online` the annotation is
     * recomputed from the live state (T34-fix), with one caveat (T41a-fix2):
     * the compat verdict itself is re-evaluated only on the RE-HANDSHAKE path
     * (relay-client.ts connect() compares fingerprints just before its online
     * transition) — an online flip that did not run a handshake (a stream or
     * ping answering 200) keeps the stored verdict as-is. So a mismatch that
     * survives the outage keeps its annotation either way, but a stale
     * `none`/`mismatch` is corrected only when the recovery went through a
     * real handshake — whichever way the annotation moves, the change emits
     * its title upserts right away, because the remote leg may NOT reopen at
     * all (a 502/503/504 on some other call flips the state offline while the
     * workspace/follow stream stays open; back online nothing reopens and no
     * baseline would ever restore the titles).
     */
    const annotationOf = (state) => {
        if (state === 'revoked')
            return 'revoked';
        if (state === 'unpaired')
            return 'unpaired';
        if (state !== 'online')
            return 'offline';
        const different = relay.compat?.different;
        return different !== undefined && different.length > 0 ? 'mismatch' : 'none';
    };
    let currentAnnotation = annotationOf(relay.state);
    merger.setStatus(currentAnnotation);
    /** Apply a new annotation and emit its title upserts (workspace merger
     * only — the control merger ignores annotations). CLEARING emits too
     * (T34-fix): the upserts are the only restore path when the stream never
     * died, and a harmless content refresh when it did reopen. */
    const applyAnnotation = (next) => {
        if (next === currentAnnotation)
            return;
        currentAnnotation = next;
        merger.setStatus(next);
        for (const frame of merger.onStatusChanged())
            channel.push(frame);
    };
    const channel = createFrameChannel();
    let alive = true;
    let currentController;
    // Set by the state listener when a re-handshake aborted the in-flight
    // remote stream: the pump must reopen WITHOUT waiting for another online
    // event (the transition that fired the abort already happened).
    let reopenNow = false;
    const onlineWaiters = [];
    const flushWaiters = () => {
        for (const wake of onlineWaiters.splice(0))
            wake();
    };
    /** The relay's state moves. `unpaired` / `revoked` follow the remote-death
     * rule (keep the shown state — the server persists its serverId, so a
     * re-pair to the same server revives the group through the reconnect diff)
     * and annotate the group titles (T34: 令牌已吊销 / 已解除配对); every other
     * non-online state annotates 离线; back `online` the annotation is
     * recomputed (T34-fix) and any change emits its title upserts at once —
     * the stream may have survived the flap, so the reopened baseline cannot
     * be relied on. (The verdict behind a `mismatch` is re-evaluated only on
     * the re-handshake path — T41a-fix2.) A serverId change cuts the
     * in-flight stream so the pump re-opens; a rename re-upserts the shown
     * groups under the new title.
     * Anything thrown here must never escape into the relay's listener loop. */
    const onState = (state) => {
        try {
            if (state === 'unpaired' || state === 'revoked') {
                // T23b2-fix3: NOT a permanent remote end any more. The serverId is
                // persisted server-side, so a re-pair to the SAME server keeps the
                // virtual prefix — and the UI's removedIds blacklist never clears
                // during a page's life, so a remove here would make the group
                // un-revivable. Handle it exactly like a remote death: keep the
                // shown state, cut the in-flight leg; the re-pair lands as `online`
                // and the pump's wait resumes under the SAME identity.
                applyAnnotation(annotationOf(state));
                merger.onRemoteDown();
                currentController?.abort();
                return;
            }
            if (state !== 'online') {
                // Offline / connecting / incompatible (T34): the group stays, its
                // title says 离线. No leg to cut — the pump only runs under
                // `online` and is already parked on waitOnline().
                applyAnnotation(annotationOf(state));
                return;
            }
            const next = relayIdentityOf(relay);
            if (next === undefined)
                return;
            if (next.serverId !== merger.serverId) {
                // A different server: cut the in-flight stream so the pump's loop
                // re-evaluates (it emits the old group's removals and retargets).
                // The annotation dies with the old identity — the pump resets it
                // from the fresh identity's state (below, and at the reopen).
                currentAnnotation = 'none';
                if (currentController !== undefined) {
                    reopenNow = true;
                    currentController.abort();
                }
                return;
            }
            // Same server back online (T34-fix): the annotation is RECOMPUTED from
            // the live state — when the recovery went through a re-handshake, the
            // relay client re-evaluated compat before this transition landed, so a
            // surviving mismatch keeps its annotation and a cleared one loses it;
            // an online flip WITHOUT a handshake (a stream/ping 200) keeps the
            // stored verdict (T41a-fix2). Whatever changed emits its title upserts
            // NOW: the remote leg may not reopen at all (the stream can survive a
            // state flap), so the reopened baseline cannot be relied on to restore
            // anything. When the leg DOES reopen, its baseline's upserts are a
            // harmless refresh. A rename still rides its own path below.
            applyAnnotation(annotationOf(state));
            if (next.serverName !== merger.serverName) {
                // Rename: same server, new display name — no reopen, no removals;
                // every shown workspace is re-upserted under the new title and the
                // stream keeps running.
                merger.retarget(next);
                for (const frame of merger.onServerRenamed())
                    channel.push(frame);
            }
        }
        catch (error) {
            log?.('client merge state handler failed on %s: %s', endpoint, messageOf(error));
        }
        finally {
            flushWaiters();
        }
    };
    let offState;
    try {
        offState = relay.subscribe(onState);
    }
    catch (error) {
        // Remote-side setup failed: degrade to a pure local passthrough so the
        // UI's own stream is untouched and the remote leg never starts.
        log?.('client merge on %s degraded to local-only: %s', endpoint, messageOf(error));
        yield* localOnly(local);
        return;
    }
    const onExternalAbort = () => {
        alive = false;
        currentController?.abort();
        flushWaiters();
        channel.end();
    };
    if (signal !== undefined)
        signal.addEventListener('abort', onExternalAbort);
    /** Wait for the next relay state event. Registered in the same
     * synchronous step as the caller's state check — an event either ran
     * before the check (the state read saw it) or resolves this waiter. */
    const waitOnline = async () => {
        await new Promise((resolve) => {
            onlineWaiters.push(resolve);
        });
    };
    const localIterator = local[Symbol.asyncIterator]();
    const pumpLocal = async () => {
        try {
            while (alive) {
                const result = await localIterator.next();
                if (result.done === true)
                    break;
                for (const frame of merger.onLocal(result.value))
                    channel.push(frame);
            }
        }
        catch (error) {
            // The local stream is the one the UI opened: its failure is the
            // merged stream's failure (a remote death never is).
            if (alive)
                channel.fail(error);
            return;
        }
        if (!alive)
            return;
        // Local stream over → the whole merged stream is over; the remote leg
        // goes first (its pump unwinds), then the consumer sees `done`.
        alive = false;
        currentController?.abort();
        flushWaiters();
        channel.end();
    };
    const pumpRemote = async () => {
        // The whole pump body is guarded: ANY escape stops the REMOTE leg only —
        // the local stream the UI opened must never notice.
        try {
            while (alive) {
                const identity = relayIdentityOf(relay);
                if (identity === undefined || relay.state !== 'online') {
                    await waitOnline();
                    continue;
                }
                if (identity.serverId !== merger.serverId) {
                    // The server changed (a rename is handled in the state listener —
                    // reaching here means serverId differs): remove the old server's
                    // groups, then point the SAME merger at the new server; the
                    // observed local state survives the swap. The annotation resets
                    // with the identity (a stale suffix must not outlive its server).
                    for (const frame of merger.onRemoteGone())
                        channel.push(frame);
                    merger.retarget(identity);
                    currentAnnotation = annotationOf(relay.state);
                    merger.setStatus(currentAnnotation);
                }
                const controller = new AbortController();
                currentController = controller;
                try {
                    const stream = relay.openStream(namespace, method, {}, controller.signal);
                    for await (const frame of stream) {
                        // `signal.aborted` too (T23b2-fix3): after an abort (server
                        // change, unpair/revocation, teardown) the transport may still
                        // hand over lines it had already decoded — they must not reach
                        // the merger, which the abort just declared dead for this
                        // generation.
                        if (!alive || controller.signal.aborted)
                            break;
                        for (const out of merger.onRemote(frame))
                            channel.push(out);
                    }
                }
                catch (error) {
                    // A transport fault is a diagnostics-ring failure — but an abort
                    // of OUR OWN controller (server change, unpair, teardown) is not:
                    // the generation signal tells them apart.
                    if (alive && !controller.signal.aborted && signal?.aborted !== true) {
                        recordFailure(endpoint, error instanceof RelayError ? error.code : 'internal');
                    }
                }
                finally {
                    if (currentController === controller)
                        currentController = undefined;
                }
                if (!alive)
                    return;
                // Remote over — error or clean end: NOTHING is emitted and the shown
                // state stays (T23b2-fix): the UI keeps the last projection visible
                // while the carrier reconnects, and a remove here would blacklist
                // the virtual ids against revival. The reconnecting baseline diffs.
                merger.onRemoteDown();
                if (reopenNow) {
                    reopenNow = false;
                    continue;
                }
                await waitOnline();
            }
        }
        catch (error) {
            if (alive)
                onDiagnostic(`remote leg stopped: ${messageOf(error)}`);
        }
    };
    void pumpLocal();
    // The body above is fully guarded; the .catch is for the guard itself (a
    // throwing logger must not become an unhandled rejection).
    void pumpRemote().catch(() => { });
    try {
        while (true) {
            const result = await channel.next();
            if (result.done === true)
                break;
            yield result.value;
        }
    }
    finally {
        alive = false;
        offState();
        if (signal !== undefined)
            signal.removeEventListener('abort', onExternalAbort);
        currentController?.abort();
        flushWaiters();
        // Best-effort half-close of the local stream the consumer walked away
        // from — never awaited: an upstream that ignores return() must not
        // hang the teardown.
        void Promise.resolve(localIterator.return?.(undefined)).catch(() => { });
    }
}
/** Pure local passthrough for the degraded (setup-failed) path: local errors
 * propagate to the consumer, a consumer return() unwinds the upstream. */
async function* localOnly(local) {
    for await (const frame of local)
        yield frame;
}
/**
 * The merged `$events` stream (T32): the UI's own subscription is the base —
 * its frames (including its ready frame) pass untouched, its end ends
 * everything, its error is the consumer's error — and one relay
 * `$zr/events` leg folds the server's forwarded events in, rewritten by
 * {@link rewriteRemoteEventFrame}. The remote leg follows the T23b-2
 * discipline: any remote death or a merely offline relay emits NOTHING and
 * keeps the stream open, a later `online` reopens it (the server
 * re-delivers still-pending waterfalls to the new subscription, so a
 * prompt that was up when the link dropped comes back), and
 * `unpaired`/`revoked` end the leg until a re-pair. A handshake that names
 * a DIFFERENT server cuts the in-flight leg so the next one opens against
 * the new server's ids.
 *
 * T32-fix, orphan prompts: the leg records the virtual eventIds it has
 * shown, deduplicates repeats within the leg, and — when the leg dies for
 * ANY reason (disconnect, server change, unpair) — closes each one with a
 * synthesized `cancel` before the wait, so no approval stays on screen
 * with no server left to settle it. DSH re-delivers still-pending events
 * to the reopened subscription, so a prompt closed by a mere disconnect
 * comes back; one the SERVER already settled travels its real cancel
 * first, which removes it from the record.
 */
async function* mergedEventsStream(deps) {
    const { local, relay, signal, recordFailure, log } = deps;
    if (signal?.aborted === true)
        return;
    const channel = createFrameChannel();
    let alive = true;
    let currentController;
    /** The server the current/last leg was opened against — a NEW handshake
     * naming a different server aborts the leg so the pump re-targets. */
    let legServerId;
    /** Virtual eventIds this leg has pushed to the UI and not yet seen a
     * cancel for — the orphan-close record, cleared at every leg end. */
    let shownEvents = new Set();
    const onlineWaiters = [];
    const flushWaiters = () => {
        for (const wake of onlineWaiters.splice(0))
            wake();
    };
    /** Relay state moves. Every transition flushes the pump's wait (it
     * re-reads the state); `online` additionally cuts a leg aimed at another
     * server, and `unpaired`/`revoked` cut it for good. Nothing thrown here
     * may escape into the relay's listener loop. */
    const onState = (state) => {
        try {
            if (state === 'unpaired' || state === 'revoked') {
                currentController?.abort();
                return;
            }
            if (state !== 'online')
                return;
            const next = relayIdentityOf(relay);
            if (next === undefined)
                return;
            if (next.serverId !== legServerId)
                currentController?.abort();
        }
        catch (error) {
            log?.('client events merge state handler failed: %s', messageOf(error));
        }
        finally {
            flushWaiters();
        }
    };
    let offState;
    try {
        offState = relay.subscribe(onState);
    }
    catch (error) {
        // Remote-side setup failed: degrade to a pure local passthrough so the
        // UI's own event stream is untouched and the remote leg never starts.
        log?.('client events merge degraded to local-only: %s', messageOf(error));
        yield* localOnly(local);
        return;
    }
    const onExternalAbort = () => {
        alive = false;
        currentController?.abort();
        flushWaiters();
        channel.end();
    };
    if (signal !== undefined)
        signal.addEventListener('abort', onExternalAbort);
    const waitOnline = async () => {
        await new Promise((resolve) => {
            onlineWaiters.push(resolve);
        });
    };
    const localIterator = local[Symbol.asyncIterator]();
    const pumpLocal = async () => {
        try {
            while (alive) {
                const result = await localIterator.next();
                if (result.done === true)
                    break;
                channel.push(result.value);
            }
        }
        catch (error) {
            // The local stream is the one the UI opened: its failure is the
            // merged stream's failure (a remote death never is).
            if (alive)
                channel.fail(error);
            return;
        }
        if (!alive)
            return;
        alive = false;
        currentController?.abort();
        flushWaiters();
        channel.end();
    };
    const pumpRemote = async () => {
        // The whole pump body is guarded: ANY escape stops the REMOTE leg only —
        // the local stream the UI opened must never notice.
        try {
            while (alive) {
                const identity = relayIdentityOf(relay);
                if (identity === undefined || relay.state !== 'online') {
                    await waitOnline();
                    continue;
                }
                legServerId = identity.serverId;
                const controller = new AbortController();
                currentController = controller;
                try {
                    const stream = relay.openStream('$zr', 'events', {}, controller.signal);
                    for await (const frame of stream) {
                        if (!alive)
                            break;
                        const rewritten = rewriteRemoteEventFrame(frame, identity.serverId);
                        if (rewritten === null)
                            continue;
                        // The orphan-close bookkeeping rides the two id-carrying frame
                        // types: waterfalls enter the record (once per leg — a repeat
                        // is not re-shown), cancels leave it.
                        const eventId = isPlainObject(rewritten) && typeof rewritten.eventId === 'string' ? rewritten.eventId : undefined;
                        if (eventId !== undefined) {
                            if (isPlainObject(frame) && frame.type === 'waterfall') {
                                if (shownEvents.has(eventId))
                                    continue;
                                shownEvents.add(eventId);
                            }
                            else if (isPlainObject(frame) && frame.type === 'cancel') {
                                shownEvents.delete(eventId);
                            }
                        }
                        channel.push(rewritten);
                    }
                }
                catch (error) {
                    // A transport fault is a diagnostics-ring failure — but an abort
                    // of OUR OWN controller (server change, unpair, teardown) is not:
                    // the generation signal tells them apart.
                    if (alive && !controller.signal.aborted && signal?.aborted !== true) {
                        recordFailure('$zr/events', error instanceof RelayError ? error.code : 'internal');
                    }
                }
                finally {
                    if (currentController === controller)
                        currentController = undefined;
                }
                // The leg is over — error, clean end, or a cut for the next server.
                // Close every prompt it opened: with the leg gone nothing can ever
                // settle them, and a synthesized `cancel` is exactly the frame the
                // UI's client face closes a waterfall prompt on. A disconnect is
                // not a verdict — the reopen's re-delivery shows still-pending
                // events again under fresh ids.
                for (const eventId of shownEvents)
                    channel.push({ type: 'cancel', eventId });
                shownEvents = new Set();
                if (!alive)
                    return;
                // Remote over — error or clean end: nothing is emitted and the shown
                // state stays; the reopen re-delivers pending events. A server
                // change skips the wait — the cut above already aimed us elsewhere.
                const next = relayIdentityOf(relay);
                if (next !== undefined && next.serverId !== legServerId)
                    continue;
                await waitOnline();
            }
        }
        catch (error) {
            if (alive)
                log?.('client events remote leg stopped: %s', messageOf(error));
        }
    };
    void pumpLocal();
    // The body above is fully guarded; the .catch is for the guard itself (a
    // throwing logger must not become an unhandled rejection).
    void pumpRemote().catch(() => { });
    try {
        while (true) {
            const result = await channel.next();
            if (result.done === true)
                break;
            yield result.value;
        }
    }
    finally {
        alive = false;
        offState();
        if (signal !== undefined)
            signal.removeEventListener('abort', onExternalAbort);
        currentController?.abort();
        flushWaiters();
        // Best-effort half-close of the local stream the consumer walked away
        // from — never awaited: an upstream that ignores return() must not
        // hang the teardown.
        void Promise.resolve(localIterator.return?.(undefined)).catch(() => { });
    }
}
/**
 * Install the two own-property wrappers on the raw gateway. Assumes
 * {@link checkGatewayShape} passed (the wiring gates on it) — this function
 * records the verdict but does not re-gate, so it stays usable in tests
 * that install over deliberately odd shapes.
 */
export function installIntercept(options) {
    const { raw, relay, getServerId, log } = options;
    const gateway = raw;
    const shape = checkGatewayShape(raw);
    const counters = { openWireStream: 0, dispatchRpc: 0 };
    const failures = [];
    const incompatible = [];
    // The closed-session registry (T34): insertion-ordered, capped, virtual-id
    // keyed. Entries live until THEIR session proves reachable again (a
    // succeeding call for it) — a reconnect clears nothing (T34-fix): a link
    // that flapped under a still-standing closure would make the banner flicker
    // away and back.
    const closedSessions = new Map();
    const registerClosed = (sessionId, reason) => {
        closedSessions.delete(sessionId);
        if (closedSessions.size >= MAX_CLOSED_SESSIONS) {
            const oldest = closedSessions.keys().next();
            if (oldest.done !== true)
                closedSessions.delete(oldest.value);
        }
        closedSessions.set(sessionId, reason);
    };
    const clearClosed = (virtuals) => {
        for (const parts of virtuals)
            closedSessions.delete(toVirtual(parts.serverId, parts.id));
    };
    let installed = true;
    let selfCheck;
    // Save the CURRENT value per property (possibly another plugin's wrapper —
    // shape note "own-property"), falling back to the prototype method only
    // when the current value is not callable. Uninstall restores the saved
    // own state verbatim: value if there was one, absence if not.
    const saved = {};
    const chainTarget = {};
    for (const name of ['openWireStream', 'dispatchRpc']) {
        const existed = Object.prototype.hasOwnProperty.call(gateway, name);
        const value = existed ? gateway[name] : undefined;
        saved[name] = { existed, value };
        chainTarget[name] = typeof value === 'function' ? value : Object.getPrototypeOf(raw)?.[name];
    }
    // Filled in below, once the wrapper functions exist: uninstall may only
    // touch a property that still holds OUR wrapper.
    const wrappers = {};
    const recordFailure = (endpoint, code) => {
        if (failures.length >= MAX_FAILURES)
            failures.shift();
        failures.push({ time: new Date().toISOString(), endpoint, code });
        // T42: validation-shaped refusals additionally land in the incompatible
        // ring — every remote failure funnels through this one function, so the
        // classification cannot drift between the invoke and stream routes.
        if (!INCOMPATIBLE_CALL_CODES.has(code))
            return;
        if (incompatible.length >= MAX_INCOMPATIBLE_CALLS)
            incompatible.shift();
        incompatible.push({ time: Date.now(), endpoint, code });
    };
    const failEnvelope = (endpoint, code, text) => {
        recordFailure(endpoint, code);
        // `details: {}` is load-bearing: the UI's server-response parser throws
        // `invalid server-response failure` on a details-less error (and the
        // gateway's rpcErrorSchema demands the same shape).
        return { ok: false, error: { code, message: text, details: {} } };
    };
    function validate(endpoint, virtuals) {
        const first = virtuals[0].serverId;
        const current = getServerId();
        if (current === undefined)
            return { ok: false, code: 'remote-offline', message: '尚未连接到服务端' };
        if (virtuals.some((parts) => parts.serverId !== first) || current !== first) {
            return { ok: false, code: 'remote-mismatch', message: '此远程会话属于其他主服务端' };
        }
        if (CLIENT_METHOD_FIELDS[endpoint] === undefined) {
            return { ok: false, code: 'remote-unsupported', message: '此功能暂不支持远程会话' };
        }
        return { ok: true, serverId: first };
    }
    /**
     * The T32 `$events/result` split: an answer whose eventId is VIRTUAL
     * belongs to a forwarded remote event and must NOT reach the local
     * gateway (its own `$events` never delivered it — the local dispatcher
     * would answer with its `no active event stream` failure). The virtual
     * id goes back to the original, the local payload's clientId (the local
     * stream's own) is discarded — the relay server composes the gateway
     * payload from ITS subscription's clientId — and the outcome rides
     * verbatim. Anything else, including a malformed payload, is the local
     * gateway's business.
     */
    function forwardEventResult(payload, signal, peer) {
        const args = argsOf(payload);
        const eventId = isPlainObject(args) ? args.eventId : undefined;
        const virtual = fromVirtual(eventId);
        if (virtual === undefined) {
            return chainTarget.dispatchRpc.call(raw, '$events/result', payload, signal, peer);
        }
        const endpoint = '$events/result';
        const current = getServerId();
        // Offline (T34-fix): a refusal envelope would RESTART the UI's whole
        // `$events` generation — the client face's answer() throws on a
        // `!response.ok` body and the pump treats that as a delivery failure
        // (RT dsh-api-gateway lib/client.js: `if (!response.ok) throw new
        // Error(response.error.message)` feeding `failed.abort(error)`), and the
        // synthesized cancels the dying leg already sent have closed these
        // prompts anyway. Answer the silent ok DSH itself gives a stale result,
        // and record the refusal in the diagnostics ring instead — the
        // non-online write-refusal message, so the banner's word matches.
        if (current === undefined || relay.state !== 'online') {
            failEnvelope(endpoint, 'remote-offline', WRITE_OFFLINE_MESSAGE);
            return { ok: true, value: undefined };
        }
        if (virtual.serverId !== current)
            return failEnvelope(endpoint, 'remote-mismatch', '此远程会话属于其他主服务端');
        return (async () => {
            try {
                await relay.postEventResult(virtual.id, isPlainObject(args) ? args.outcome : undefined, signal);
                return { ok: true, value: undefined };
            }
            catch (error) {
                const code = error instanceof RelayError ? error.code : 'internal';
                // "This event is already over" — settled or cancelled server-side
                // (its registry entry went with the forwarded cancel), or the
                // session just closed. DSH itself answers a stale result with a
                // silent ok (receiveRemoteEventResult no-ops), so the UI gets
                // exactly that instead of a thrown answer — a thrown one would
                // fail the UI's whole `$events` generation and restart the stream
                // (client face: pumpEvents aborts on answer failures). The route's
                // documented refusal is a 403 (relay-server.ts event-result), so
                // the mapping additionally demands `status === 403`: the same code
                // string arriving on any other status is a different fault. Not a
                // call failure, so the diagnostics ring stays out of it. Every
                // OTHER code is a real fault and keeps the refusal envelope.
                if (error instanceof RelayError &&
                    error.status === 403 &&
                    (code === 'unknown-event' || code === 'not-shared')) {
                    return { ok: true, value: undefined };
                }
                recordFailure(endpoint, code);
                return { ok: false, error: { code, message: messageOf(error), details: {} } };
            }
        })();
    }
    async function forwardInvoke(endpoint, args, virtuals, signal) {
        const verdict = validate(endpoint, virtuals);
        if (!verdict.ok)
            return failEnvelope(endpoint, verdict.code, verdict.message);
        // A WRITE while the relay is not serving (T34, whitelist rule per
        // T34-fix): refused here, never sent — the call could only fail out
        // there, and the read paths answer for themselves (forwarded as today,
        // failing with their own transport error).
        if (isRemoteWrite(endpoint) && relay.state !== 'online') {
            return failEnvelope(endpoint, 'remote-offline', WRITE_OFFLINE_MESSAGE);
        }
        const serverId = verdict.serverId;
        const slash = endpoint.indexOf('/');
        const namespace = slash === -1 ? endpoint : endpoint.slice(0, slash);
        const method = slash === -1 ? '' : endpoint.slice(slash + 1);
        try {
            let clone = structuredClone(args);
            restoreRegisteredFields(CLIENT_METHOD_FIELDS[endpoint], clone);
            // A remote create never names its own session id: DSH mints one, and
            // adopting a caller-chosen id (create's idempotent-adopt path) could
            // resurrect or hijack a server-side session. The relay deletes the
            // field too — this is the client-side half of the same rule.
            if (endpoint === 'session/create') {
                const request = isPlainObject(clone) ? clone.request : undefined;
                if (isPlainObject(request))
                    delete request.sessionId;
            }
            // T41a-fix2: wherever an injectable text can carry canonical
            // `dsh-session:` addresses — prompt content, a queue EDIT's
            // replacement content, any string of a commands/execute call (the
            // shared rule, session-reference.ts) — DSH injects what they name and
            // the relay refuses any address off its share table. Restore virtual
            // ids inside those addresses; a reference to a LOCAL session (or any
            // other server's) refuses the whole call — the server does not have
            // that session.
            const references = restoreSessionReferences(clone, namespace, method, serverId);
            clone = references.args;
            if (!references.ok) {
                return failEnvelope(endpoint, 'remote-unsupported', '引用的会话不在服务端上，无法转发');
            }
            const value = await relay.invoke(namespace, method, clone, signal);
            // The session answered: any closed-session entry for it is stale
            // (re-shared and served again) — the banner may go.
            clearClosed(virtuals);
            return { ok: true, value: rewriteResult(endpoint, value, serverId) };
        }
        catch (error) {
            const code = error instanceof RelayError ? error.code : 'internal';
            recordFailure(endpoint, code);
            return { ok: false, error: { code, message: messageOf(error), details: {} } };
        }
    }
    /** Record the failure, then raise it as a coded stream error. The host's
     * stream channel forwards an error's code across the wire ONLY when it is
     * marked `isDSHRemoteError === true` with a string code
     * (dsh-typert-protocol's remoteErrorOf) — an unmarked error (a bare
     * RelayError included) is folded into `gateway/internal` before the UI
     * ever sees it, so every throw on this route carries the marker. */
    function throwRecorded(endpoint, code, text) {
        failEnvelope(endpoint, code, text);
        throw new CodedStreamError(code, text);
    }
    async function* rewriteUpstream(endpoint, upstream, serverId, claimed) {
        let first = true;
        try {
            for await (const frame of upstream) {
                if (first) {
                    first = false;
                    // Frames are flowing: the session is being served again — a
                    // closed-session entry for it is stale (T34).
                    clearClosed(claimed);
                }
                yield rewriteFrame(endpoint, frame, serverId);
            }
        }
        catch (error) {
            // Same marker discipline as the refusals: a RelayError rising out of
            // the relay's pump (unshared, offline, …) keeps its code; anything
            // else travels as `internal`. Both are remote-call failures and land
            // in the diagnostics ring.
            const code = error instanceof RelayError ? error.code : 'internal';
            // The server is no longer serving this session (T34): an `unshared`
            // frame is the mid-stream closure with its structured reason; a
            // `not-shared` refusal is the closure that happened before this page
            // even opened — no event was observed, so the reason degrades to
            // manual (T34-fix).
            if (error instanceof RelayError && (code === 'unshared' || code === 'not-shared')) {
                for (const parts of claimed)
                    registerClosed(toVirtual(parts.serverId, parts.id), closedReasonOf(error));
            }
            recordFailure(endpoint, code);
            throw new CodedStreamError(code, messageOf(error));
        }
    }
    /**
     * The T23b-2 `session/list` route: the local answer stays the base (its
     * pagination fields rule), the relay's filtered FIRST page is appended with
     * virtualized session ids. Paged requests, an offline relay, a non-ok local
     * envelope and a failed remote call all answer the local result untouched —
     * only a remote failure is recorded.
     */
    async function mergedSessionListCall(endpoint, payload, args, signal, peer) {
        const localEnvelope = (await chainTarget.dispatchRpc.call(raw, endpoint, payload, signal, peer));
        // A local failure is the answer — there is nothing to merge into.
        if (!isPlainObject(localEnvelope) || localEnvelope.ok !== true)
            return localEnvelope;
        // Only the first page merges: a cursor pages the local list alone.
        const request = isPlainObject(args) ? args._request : undefined;
        if (isPlainObject(request) && request.cursor !== undefined)
            return localEnvelope;
        const identity = relayIdentityOf(relay);
        if (identity === undefined || relay.state !== 'online')
            return localEnvelope;
        try {
            const remote = await relay.invoke('session', 'list', isPlainObject(args) ? args : {}, signal);
            return { ok: true, value: mergeSessionList(localEnvelope.value, remote, identity.serverId) };
        }
        catch (error) {
            recordFailure(endpoint, error instanceof RelayError ? error.code : 'internal');
            return localEnvelope;
        }
    }
    const wrappedDispatch = function wrappedDispatch(endpoint, payload, signal, peer) {
        // An uninstalled wrap is INERT, not absent: another plugin may have
        // wrapped over us and kept a reference to this very function, so it must
        // degrade to a plain passthrough instead of forwarding anything.
        if (!installed) {
            return chainTarget.dispatchRpc.call(raw, endpoint, payload, signal, peer);
        }
        counters.dispatchRpc += 1;
        // The T32 answer split comes FIRST: the outcome value may legitimately
        // contain id-shaped strings, and the deep scan below must never turn a
        // valid remote answer into a refusal.
        if (endpoint === '$events/result')
            return forwardEventResult(payload, signal, peer);
        const args = argsOf(payload);
        const fields = CLIENT_METHOD_FIELDS[endpoint];
        const virtuals = collectVirtuals(fields, args);
        if (virtuals.length === 0) {
            if (endpoint === 'session/list') {
                return mergedSessionListCall(endpoint, payload, args, signal, peer);
            }
            return chainTarget.dispatchRpc.call(raw, endpoint, payload, signal, peer);
        }
        return forwardInvoke(endpoint, args, virtuals, signal);
    };
    const wrappedOpen = function wrappedOpenWireStream(endpoint, payload, uplink, peer, signal, control) {
        if (!installed) {
            return chainTarget.openWireStream.call(raw, endpoint, payload, uplink, peer, signal, control);
        }
        counters.openWireStream += 1;
        // The behavior self-check's probe payload — recognized by identity, so
        // only a wrap that actually served THIS call vouches for it.
        const probe = isPlainObject(payload) ? probePayloads.get(payload) : undefined;
        if (probe !== undefined)
            probe.entered = true;
        // The T32 events merge comes before any field scan: `$events` carries no
        // session-locating fields, and its merge keeps the UI's own stream as
        // the base (the host's `$events` leg releases the uplink itself).
        if (endpoint === '$events') {
            const open = chainTarget.openWireStream;
            return (async () => {
                const local = await open.call(raw, endpoint, payload, uplink, peer, signal, control);
                if (!isAsyncIterable(local))
                    return local;
                return mergedEventsStream({ local, relay, signal, recordFailure, log });
            })();
        }
        const args = argsOf(payload);
        const fields = CLIENT_METHOD_FIELDS[endpoint];
        const virtuals = collectVirtuals(fields, args);
        if (virtuals.length === 0) {
            if (endpoint === 'workspace/follow' || endpoint === 'session/control') {
                // The startup self-check probe wants the LOCAL baseline only — no
                // remote leg, no merge (its payload is registered in probePayloads).
                if (probe !== undefined) {
                    return chainTarget.openWireStream.call(raw, endpoint, payload, uplink, peer, signal, control);
                }
                // The T23b-2 global merge. The 0.2.0 openWireStream is an ASYNC
                // method — the host's mux awaits the result and then for-awaits it —
                // so this route awaits the local original too and hands back a
                // promise of the merged iterable, the shape the real method returns.
                const slash = endpoint.indexOf('/');
                const namespace = slash === -1 ? endpoint : endpoint.slice(0, slash);
                const method = slash === -1 ? '' : endpoint.slice(slash + 1);
                const open = chainTarget.openWireStream;
                return (async () => {
                    // The uplink rides to the LOCAL method verbatim (it may consume
                    // it); the remote leg carries no uplink.
                    const local = await open.call(raw, endpoint, payload, uplink, peer, signal, control);
                    if (!isAsyncIterable(local))
                        return local;
                    return mergedGlobalStream({
                        endpoint,
                        namespace,
                        method,
                        local,
                        relay,
                        signal,
                        recordFailure,
                        log,
                    });
                })();
            }
            return chainTarget.openWireStream.call(raw, endpoint, payload, uplink, peer, signal, control);
        }
        const verdict = validate(endpoint, virtuals);
        if (!verdict.ok)
            throwRecorded(endpoint, verdict.code, verdict.message);
        // The multiplexed wire channel ALWAYS hands us an UplinkInbox here —
        // never undefined. Remote streams consume no uplink items, so the uplink
        // is half-closed and the stream forwarded (the host's own move for its
        // `$events` subscription, gateway releaseUplink). Rejecting uplinks
        // would reject every remote stream the UI opens.
        releaseUplink(uplink);
        const serverId = verdict.serverId;
        const slash = endpoint.indexOf('/');
        const namespace = slash === -1 ? endpoint : endpoint.slice(0, slash);
        const method = slash === -1 ? '' : endpoint.slice(slash + 1);
        let upstream;
        try {
            const clone = structuredClone(args);
            restoreRegisteredFields(CLIENT_METHOD_FIELDS[endpoint], clone);
            // Eager on purpose: an unpaired or offline relay fails at CALL time,
            // exactly like the real openWireStream fails on a bad endpoint.
            upstream = relay.openStream(namespace, method, clone, signal);
        }
        catch (error) {
            const code = error instanceof RelayError ? error.code : 'internal';
            throwRecorded(endpoint, code, messageOf(error));
        }
        // RelayError raised DURING iteration (unshared, offline, …) flows out of
        // the generator with its code attached, which is how the host's stream
        // channel hands the failure to the UI.
        return rewriteUpstream(endpoint, upstream, serverId, virtuals);
    };
    gateway.openWireStream = wrappedOpen;
    gateway.dispatchRpc = wrappedDispatch;
    wrappers.openWireStream = wrappedOpen;
    wrappers.dispatchRpc = wrappedDispatch;
    log?.('intercept installed (shape notes: %s)', shape.ok ? shape.notes.join('; ') || 'none' : 'n/a');
    return {
        uninstall() {
            if (!installed)
                return;
            installed = false;
            for (const name of ['openWireStream', 'dispatchRpc']) {
                // Only replace/delete while the property still holds OUR wrapper.
                // A later plugin may have wrapped OVER us: its wrapper captured this
                // function, and pulling the property would silently drop ITS wrap.
                // Instead ours goes inert (installed === false → plain passthrough)
                // and stays reachable underneath theirs.
                if (gateway[name] !== wrappers[name])
                    continue;
                if (saved[name].existed)
                    gateway[name] = saved[name].value;
                else
                    delete gateway[name];
            }
        },
        diagnostics() {
            return {
                installed,
                shape,
                ...(selfCheck !== undefined ? { selfCheck } : {}),
                recentFailures: [...failures],
                incompatibleCalls: [...incompatible],
                closedSessions: [...closedSessions].map(([sessionId, reason]) => ({ sessionId, reason })),
            };
        },
        wrappedCalls() {
            return { ...counters };
        },
        noteSelfCheck(result) {
            selfCheck = result;
        },
    };
}
/**
 * The behavior self-check registers its probe payload here before the call,
 * and {@link installIntercept}'s wrapper flags the exact object when it sees
 * it — identity, not a counter. `wrappedCalls()` counts EVERY entry, so a
 * stream the UI opens while the probe waits would vouch for a wire adapter
 * that actually routes around the wrapper; the marked payload lets each
 * self-check attempt be judged on its own.
 */
const probePayloads = new WeakMap();
/**
 * The startup behavior self-check (spike §4.1 check 4): open the one stream
 * the shape check cannot prove — that the wrap is actually REACHED — through
 * `wireStream.open('workspace/follow', …)` and demand a `baseline` first
 * frame whose `value.items` is an array (the real workspace baseline's
 * shape). The probe payload is marked in {@link probePayloads} before the
 * call and the wrapper flags that exact object, so the verdict covers both
 * faults at once: frames that are not a workspace feed, and a wire adapter
 * that routes around the wrapper. The real gateway's `openWireStream` is
 * `async` (RT dsh-api-gateway), so the adapter's `open()` returns a PROMISE
 * of the stream — the await sits inside the same timeout race as the
 * first-frame wait, so an upstream that never settles fails the check
 * instead of hanging startup.
 */
export async function behaviorSelfCheck(raw, options) {
    const gateway = raw;
    const wireStream = gateway.wireStream;
    const open = isPlainObject(wireStream) ? wireStream.open : undefined;
    if (typeof open !== 'function')
        return { ok: false, reason: 'wireStream.open disappeared before the self-check' };
    const operatorPeer = typeof gateway.operatorPeer === 'function' ? gateway.operatorPeer : undefined;
    const controller = new AbortController();
    // NOT unref'd: an unref'd timer lets the process exit (or a test runner
    // judge the loop empty) before the timeout ever fires when this probe is
    // the only pending work — exactly the hang it exists to prevent. Five
    // seconds of keepalive during startup is harmless.
    const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 5_000);
    let iterator;
    const payload = { args: {} };
    const entered = { entered: false };
    probePayloads.set(payload, entered);
    try {
        // One abort-gated rejector shared by both waits: settling the open and
        // settling the first frame are bounded by the SAME deadline.
        const timeout = new Promise((_, reject) => {
            const onAbort = () => reject(new RelayError('aborted', 'the self-check exceeded its timeout'));
            if (controller.signal.aborted)
                onAbort();
            else
                controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        // A sync wrapper hands back the stream, an async one a Promise of it —
        // normalize through Promise.resolve and await INSIDE the race.
        const opened = await Promise.race([
            Promise.resolve(open.call(wireStream, 'workspace/follow', payload, undefined, typeof operatorPeer === 'function' ? operatorPeer.call(raw) : undefined, controller.signal)),
            timeout,
        ]);
        iterator = opened[Symbol.asyncIterator]();
        // The abort must also bound the WAIT, not only the signal: an upstream
        // that ignores its signal must not hang startup forever.
        const first = await Promise.race([iterator.next(), timeout]);
        await iterator.return?.(undefined);
        if (first.done === true)
            return { ok: false, reason: 'the self-check stream ended without a frame' };
        const frame = first.value;
        if (!isPlainObject(frame) || frame.type !== 'baseline') {
            return { ok: false, reason: `the self-check's first frame type is ${typeof frame === 'object' && frame !== null ? String(frame.type) : typeof frame}, expected "baseline"` };
        }
        // The workspace baseline nests its list under `value` (spike §4.1):
        // a baseline without an items array is not a workspace feed, whatever
        // it is.
        const value = isPlainObject(frame) ? frame.value : undefined;
        if (!isPlainObject(value) || !Array.isArray(value.items)) {
            return { ok: false, reason: 'the self-check baseline frame carries no value.items array' };
        }
        if (!entered.entered)
            return { ok: false, reason: 'the self-check stream bypassed the wrapper' };
        return { ok: true };
    }
    catch (error) {
        // Best-effort close of an upstream the timeout may have interrupted —
        // never awaited, a signal-ignoring upstream must not hang the teardown.
        void Promise.resolve(iterator?.return?.(undefined)).catch(() => { });
        return { ok: false, reason: `the self-check stream failed: ${messageOf(error)}` };
    }
    finally {
        clearTimeout(timer);
        controller.abort();
    }
}
/**
 * Run the behavior self-check with the wiring's failure policy: ONE retry
 * after a pause (a transiently unready upstream must not cost the whole
 * interception), and only a second failure uninstalls and records. Each
 * attempt is judged on its own — the probe payload is recognized inside the
 * wrapper by identity, so streams the UI opens during the check change
 * nothing. The plugin may be disposed while a check is in flight (a row
 * reload during startup), so the handle's installed state is re-read before
 * the retry and after every attempt: an uninstalled check exits silently —
 * no further probe, no verdict, no "interception removed" warning (that
 * removal was not ours to announce, and a post-uninstall probe would run
 * against the unwrapped gateway and fail spuriously).
 */
export async function runSelfCheck(raw, options) {
    const { handle, log } = options;
    const retryDelayMs = options.retryDelayMs ?? 3_000;
    const stillInstalled = () => handle.diagnostics().installed;
    let result = await behaviorSelfCheck(raw);
    if (!result.ok && stillInstalled()) {
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, retryDelayMs);
            // A disposed plugin must not hold the process (or a test runner's
            // loop-empty judgement) open for the retry delay.
            if (typeof timer.unref === 'function')
                timer.unref();
        });
        if (stillInstalled())
            result = await behaviorSelfCheck(raw);
    }
    if (!stillInstalled())
        return result;
    handle.noteSelfCheck(result);
    if (result.ok)
        return result;
    handle.uninstall();
    log?.('client intercept self-check failed (%s), interception removed', result.reason);
    return result;
}
//# sourceMappingURL=intercept.js.map