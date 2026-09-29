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
 *   route therefore awaits the local original too and hands the host back a
 *   promise of the merged iterable, the same shape the real method returns.
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
};
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
 * `subagent` → `parentSessionId` (the child id is already the server's
 * original and passes through untouched). Unknown kinds own no slot.
 */
function forEachRegisteredSlot(fields, args, visit) {
    if (!isPlainObject(args))
        return;
    const request = args.request;
    if (!isPlainObject(request))
        return;
    for (const field of fields) {
        if (field === 'request.sessionId') {
            visit(request, 'sessionId');
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
 * - everything else in the table (`session/page`, `session/projections`,
 *   `session/prompt|cancel|rename|selectModel|updateQueue|attachment`,
 *   `job/kill`, `skills/list`, `schedule/list`) has NO
 *   session id in its result — verified, and passed through untouched.
 */
function mapStrings(value, map) {
    if (!Array.isArray(value))
        return value;
    return value.map((item) => (typeof item === 'string' ? map(item) : item));
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
    if (endpoint === 'messageFeedback/list' || endpoint === 'messageFeedback/put' || endpoint === 'messageFeedback/delete') {
        if (!isPlainObject(value) || value.ok !== false || !isPlainObject(value.error))
            return value;
        const error = value.error;
        if (typeof error.sessionId !== 'string')
            return value;
        return { ...value, error: { ...error, sessionId: virtualize(error.sessionId) } };
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
/** Longest failure ring kept for the status surface. */
const MAX_FAILURES = 20;
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
 * is the consumer's error. A remote death (error or clean end) and a
 * merely offline relay emit NOTHING and keep the shown state (T23b2-fix):
 * the UI blacklists removed virtual ids forever, so a disconnect remove
 * would make the group un-revivable — the reconnecting baseline is diffed
 * against what was shown instead. Only a serverId change or the relay
 * entering `unpaired` / `revoked` removes the whole group, and a rename
 * re-upserts the shown groups under the new title without a reopen.
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
    /** The relay's state moves. `online` re-evaluates the server identity (a
     * serverId change cuts the in-flight stream so the pump re-opens; a rename
     * re-upserts the shown groups under the new title); `unpaired` /
     * `revoked` end the remote group for good. Anything thrown here must
     * never escape into the relay's listener loop. */
    const onState = (state) => {
        try {
            if (state === 'unpaired' || state === 'revoked') {
                // Permanent remote end: the whole virtual group leaves (those
                // prefixes never come back, so the UI's remove-blacklist cannot be
                // hit by a revival under them). No reopen until a re-pair lands.
                for (const frame of merger.onRemoteGone())
                    channel.push(frame);
                currentController?.abort();
                return;
            }
            if (state !== 'online')
                return;
            const next = relayIdentityOf(relay);
            if (next === undefined)
                return;
            if (next.serverId !== merger.serverId) {
                // A different server: cut the in-flight stream so the pump's loop
                // re-evaluates (it emits the old group's removals and retargets).
                if (currentController !== undefined) {
                    reopenNow = true;
                    currentController.abort();
                }
                return;
            }
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
                    // observed local state survives the swap.
                    for (const frame of merger.onRemoteGone())
                        channel.push(frame);
                    merger.retarget(identity);
                }
                const controller = new AbortController();
                currentController = controller;
                try {
                    const stream = relay.openStream(namespace, method, {}, controller.signal);
                    for await (const frame of stream) {
                        if (!alive)
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
    async function forwardInvoke(endpoint, args, virtuals, signal) {
        const verdict = validate(endpoint, virtuals);
        if (!verdict.ok)
            return failEnvelope(endpoint, verdict.code, verdict.message);
        const serverId = verdict.serverId;
        const slash = endpoint.indexOf('/');
        const namespace = slash === -1 ? endpoint : endpoint.slice(0, slash);
        const method = slash === -1 ? '' : endpoint.slice(slash + 1);
        try {
            const clone = structuredClone(args);
            restoreRegisteredFields(CLIENT_METHOD_FIELDS[endpoint], clone);
            const value = await relay.invoke(namespace, method, clone, signal);
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
    async function* rewriteUpstream(endpoint, upstream, serverId) {
        try {
            for await (const frame of upstream) {
                yield rewriteFrame(endpoint, frame, serverId);
            }
        }
        catch (error) {
            // Same marker discipline as the refusals: a RelayError rising out of
            // the relay's pump (unshared, offline, …) keeps its code; anything
            // else travels as `internal`. Both are remote-call failures and land
            // in the diagnostics ring.
            const code = error instanceof RelayError ? error.code : 'internal';
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
        return rewriteUpstream(endpoint, upstream, serverId);
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