/**
 * Server-side relay routes for the desktop client (T22a routes, T22b
 * streaming, T32 event forwarding): authentication, ping, handshake, the
 * single invoke passthrough, the NDJSON stream subscription route with
 * share-change synchronization, and the forwarded-event half — the
 * `$zr/events` subscription over the gateway's `$events` wire stream plus
 * the `relay/v1/event-result` answer route. Activity stats remain a later
 * task.
 *
 * Why the secret: the desktop client is a Node process on another machine —
 * it has no DSH login cookie, so the gateway authenticates it with a Bearer
 * pairing token and marks the forwarded request with `x-zen-remote-*` headers.
 * But DSH only listens on 127.0.0.1, where any local process could bypass the
 * gateway and forge those headers. The plugin therefore mints a per-apply
 * secret, hands it to the gateway child through `LAN_GATE_RELAY_SECRET`, the
 * gateway stamps every device-authenticated forward with it, and these routes
 * re-verify it on every request with `timingSafeEqual`.
 *
 * Path dispatch never decodes the request path. The gateway only admits relay
 * paths whose raw and URL-normalized forms are byte-identical, which lets
 * `/_dsh/zen-remote/relay/..%2f..%2fapi` through — decoding it here before
 * matching would reopen the traversal the gateway just closed. Every route is
 * an exact comparison on `new URL(req.url).pathname` as-is; anything else is
 * a 404.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { decideInvoke, decideStream, parseEventResultBody } from './relay-access.js';
import { createWorkspaceFollowState, filterControlFrame, filterJobListFrame, filterSessionListResult, filterWorkspaceFrame, } from './relay-filter.js';
/**
 * Registration prefix on the host webServer. Deliberately WITHOUT the
 * trailing slash: the webserver matches a prefix route as `pathname === p ||
 * pathname.startsWith(p + '/')`, so a trailing slash here would match only
 * `…/relay//…` shapes and never `…/relay/ping`.
 */
export const RELAY_PREFIX = '/_dsh/zen-remote/relay';
/** The one protocol version this file speaks; the handshake reports it. */
const RELAY_PROTOCOL = 1;
/** Request body ceiling for the POST routes other than invoke. */
const MAX_BODY_BYTES = 1024 * 1024;
/**
 * Body ceiling for the invoke route alone: the prompt routes carry inline
 * images in their content blocks (`session/prompt` / `subagents/prompt` take
 * base64 `image` parts; DSH admits one image up to 20 MiB by default —
 * `maxImageBytes`, dsh-attachment-local — which base64 inflates to ~27 MiB),
 * so one full-size inline image plus its envelope needs 32 MiB. It is NOT
 * sized for `fileUploads/upload`: the UI's real file uploads ride the HTTP
 * route `api/session/uploadFileBinary` (T41b), not this JSON relay. The
 * buffer only ever grows to the REAL body size; the cap decides
 * accept/refuse, and a body that outgrows it is drained and answered 413
 * like any other oversized read.
 */
const MAX_INVOKE_BODY_BYTES = 32 * 1024 * 1024;
/** Error messages forwarded to the client are clipped to this many chars. */
const MAX_MESSAGE_CHARS = 500;
/**
 * DSH's own error vocabulary is `namespace/name` (`gateway/cancelled`,
 * `session/unknown-session`, …). Only codes of that exact SHAPE travel to the
 * client with their message — Node's system errors also carry a string
 * `code` (`ENOENT`), and their messages quote server-side absolute paths, so
 * anything not shaped like a DSH code reports `internal` with no message.
 */
const DSH_ERROR_CODE = /^[a-z][a-zA-Z-]*\/[a-zA-Z-]+$/;
/** Concurrent streams one device may hold open (per `x-zen-remote-device`). */
const MAX_STREAMS_PER_DEVICE = 32;
/** Most recent forwarded waterfall events remembered per `$zr/events`
 * subscription (T32-fix): the registry is only an ownership record, so this
 * bounds a pathological burst the same way the job cache does — past the
 * cap the OLDEST entry is dropped (a forwarded-but-forgotten event answers
 * `unknown-event`, which the client surfaces as the same silent ok DSH
 * gives a stale result). */
const EVENT_REGISTRY_LIMIT = 500;
/** Stream heartbeat when the caller does not inject one. */
const DEFAULT_HEARTBEAT_MS = 15_000;
/** How long a stream's finish may wait for a backed-up socket buffer to
 * drain before the response is destroyed (T43-A). */
const DEFAULT_END_DRAIN_TIMEOUT_MS = 5_000;
/** `{"type":"ping"}` as one ready-made NDJSON line. */
const PING_LINE = Buffer.from('{"type":"ping"}\n', 'utf8');
/** Most recent jobs remembered per session for ownership checks (4b): the
 * latest `job/list` frame replaces the whole set, so this only bounds a
 * pathological single frame. */
const JOB_CACHE_LIMIT = 1024;
/** One 8-hex-character short server id: four random bytes, enough to tell a
 * handful of servers apart in a client's server list without leaking anything
 * countable about the deployment. */
const SERVER_ID_PATTERN = /^[0-9a-f]{8}$/;
const SERVER_ID_FILE = 'zen-remote-server.json';
/**
 * Read the persisted server id, creating (and persisting) one on first use.
 * A missing file is the normal first run; an unreadable or damaged file must
 * never take the host down, so every failure degrades to a fresh per-process
 * id that simply is not remembered across restarts.
 */
export function loadServerId(home) {
    const file = join(home, SERVER_ID_FILE);
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        const id = parsed?.serverId;
        if (typeof id === 'string' && SERVER_ID_PATTERN.test(id))
            return id;
    }
    catch {
        // First run, unreadable path, or unparsable JSON — mint a new one below.
    }
    const id = randomBytes(4).toString('hex');
    try {
        // tmp + rename, the same atomic dance the share table uses: a crash
        // mid-write must not leave a half-file that would corrupt the next read.
        mkdirSync(home, { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify({ serverId: id }));
        renameSync(`${file}.tmp`, file);
    }
    catch {
        // Unwritable home: the id stays process-local. Nothing may throw here.
    }
    return id;
}
/**
 * The DSH version reported in the handshake: `DSH_CLIENT_VERSION` when the
 * host sets it, else the version of the `@deepseek-ai/dsh` package resolved
 * from here (compositions without that package installed — tests, Electron —
 * report `'unknown'`). Never throws.
 */
export function resolveDshVersion() {
    const fromEnv = process.env.DSH_CLIENT_VERSION;
    if (typeof fromEnv === 'string' && fromEnv !== '')
        return fromEnv;
    try {
        const require = createRequire(import.meta.url);
        const pkg = require('@deepseek-ai/dsh/package.json');
        if (pkg !== null && typeof pkg === 'object' && typeof pkg.version === 'string')
            return pkg.version;
    }
    catch {
        // Not resolvable in this composition — 'unknown' is an honest answer.
    }
    return 'unknown';
}
function responseJson(res, status, body) {
    const bytes = Buffer.from(JSON.stringify(body));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.writeHead(status);
    res.end(bytes);
}
/** First (and in practice only) value of one request header. */
function headerValue(req, name) {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' ? value : undefined;
}
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
/**
 * Constant-time secret comparison. Different lengths are trivially unequal
 * (timingSafeEqual itself throws on that); an empty configured secret refuses
 * everything, so "the gateway half is off" can never fail open.
 */
function secretsMatch(provided, secret) {
    if (secret === '' || provided === undefined)
        return false;
    const left = Buffer.from(provided, 'utf8');
    const right = Buffer.from(secret, 'utf8');
    if (left.length !== right.length)
        return false;
    return timingSafeEqual(left, right);
}
const PAYLOAD_TOO_LARGE = Object.freeze({ ok: false, error: { code: 'payload-too-large', details: {} } });
/**
 * One readJsonObject plus the two failure answers every POST route shares:
 * an oversized body is 413 `payload-too-large`, unparsable JSON is 400
 * `bad-request` — the two are distinct answers, not one "bad body" pile.
 * `undefined` means the response is already written and the caller returns.
 */
async function readBodyOrRespond(req, res, cap = MAX_BODY_BYTES) {
    const read = await readJsonObject(req, cap);
    if (read.kind === 'too-large') {
        responseJson(res, 413, PAYLOAD_TOO_LARGE);
        return undefined;
    }
    if (read.kind === 'invalid') {
        responseJson(res, 400, { ok: false, error: { code: 'bad-request' } });
        return undefined;
    }
    return read.body;
}
async function readJsonObject(req, cap = MAX_BODY_BYTES) {
    return new Promise((resolve) => {
        const chunks = [];
        // `Number(undefined)` is NaN, and `NaN > cap` is false: a chunked body
        // (no length header) simply falls through to the byte counting below.
        let tooLarge = Number(req.headers['content-length']) > cap;
        let size = 0;
        let done = false;
        const finish = (value) => {
            if (!done) {
                done = true;
                resolve(value);
            }
        };
        req.on('data', (chunk) => {
            if (done || tooLarge)
                return;
            size += chunk.length;
            if (size > cap) {
                tooLarge = true;
                chunks.length = 0;
                return;
            }
            chunks.push(chunk);
            // Past the cap: keep consuming without buffering.
        });
        req.on('end', () => {
            if (done)
                return;
            if (tooLarge) {
                finish({ kind: 'too-large' });
                return;
            }
            if (size === 0) {
                finish({ kind: 'ok', body: {} });
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            }
            catch {
                finish({ kind: 'invalid' });
                return;
            }
            finish(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
                ? { kind: 'ok', body: parsed }
                : { kind: 'invalid' });
        });
        req.on('error', () => finish({ kind: 'invalid' }));
    });
}
/**
 * What may travel to the client about a failed gateway call. DSH's own errors
 * always carry a `namespace/name`-shaped string `code` — those pass through
 * with a clipped message. EVERYTHING else — a plugin bug, or a Node system
 * error whose `code` (`ENOENT`, …) and message (`… '/Users/x/…'`) quote the
 * server's filesystem — reports `internal` and NO message at all (T22a-fix).
 */
function errorOf(error) {
    const code = error !== null && typeof error === 'object' && typeof error.code === 'string'
        ? error.code
        : '';
    if (!DSH_ERROR_CODE.test(code))
        return { code: 'internal' };
    const text = error instanceof Error ? error.message : String(error);
    return { code, message: text.slice(0, MAX_MESSAGE_CHARS) };
}
/**
 * Build the relay route handler mounted under {@link RELAY_PREFIX}. Exported
 * as a factory so the route tests can drive it against a plain node:http
 * server with a fake gateway and a real share store — no harness required.
 *
 * Every request passes the same gate first: gateway secret, then the two
 * marking headers. Failures answer a uniform 401 that does not say WHICH
 * check failed — the difference would only help someone probing the wall.
 * After the gate, `x-zen-remote-device` is the caller's device id (the
 * per-device stream budget hangs off it).
 *
 * @param options - secret, share store, gateway service and server facts.
 * @returns the handler owning the full response lifecycle of one request,
 *   with `viewerCount` alongside for the "who is looking" surface.
 */
export function createRelayHandler(options) {
    const { secret, store, gateway, serverInfo } = options;
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const endDrainTimeoutMs = options.endDrainTimeoutMs ?? DEFAULT_END_DRAIN_TIMEOUT_MS;
    const parentOf = options.parentOf ?? (() => undefined);
    const isAccessible = (sessionId) => store.isAccessible(sessionId, parentOf);
    /** Session-scoped streams currently open, per session (cross-device). */
    const viewers = new Map();
    /** Open streams per device id, for the per-device budget. */
    const streamsByDevice = new Map();
    /** The `$zr/events` subscriptions currently open — the event-result
     * route searches these for every incoming eventId. A closed
     * subscription removes itself; closeAll empties the set. */
    const liveEventSubscriptions = new Set();
    /** Latest `job/list` rows seen per session — the recent-state half of the
     * job ownership check (the other half is a one-shot list on a cache miss).
     * An unshared session's rows are forgotten (T22b-fix): its jobs are none of
     * this client's business anymore. */
    const recentJobs = new Map();
    /**
     * Every share-table listener this handler registered — the ownership
     * cache's unshare sweeper below, plus one per open stream. closeAll
     * detaches them ALL (T43-B): after the handler closed, a share/unshare on
     * the table must never re-enter the dead handler, not even through a
     * stream whose pump is still parked on a full socket buffer.
     */
    const tableUnsubscribers = new Set();
    tableUnsubscribers.add(store.subscribe((event) => {
        if (event.type === 'unshared')
            recentJobs.delete(event.sessionId);
    }));
    /** Kill switches of the streams currently open on THIS handler, and the
     * reason recorded by closeAll — a request that was mid-ownership-probe
     * when closeAll ran reads it just before it would open its upstream. */
    const openStreamKills = new Set();
    let serverClosedReason = null;
    /** Record one raw `job/list` frame into the ownership cache (unfiltered:
     * ownerless entries are remembered too, as "not owned by anyone"). */
    const rememberJobs = (sessionId, frame) => {
        if (!isPlainObject(frame) || frame.type !== 'rows' || !Array.isArray(frame.jobs))
            return;
        const jobs = new Map();
        for (const job of frame.jobs) {
            if (jobs.size >= JOB_CACHE_LIMIT)
                break;
            if (isPlainObject(job) && typeof job.id === 'string' && job.id !== '') {
                jobs.set(job.id, typeof job.owner === 'string' ? job.owner : undefined);
            }
        }
        recentJobs.set(sessionId, jobs);
    };
    /**
     * Whether `jobId` belongs to `sessionId` — the relay-side ownership check
     * for `job/follow` / `job/kill`. DSH opens ownerless jobs to every session,
     * so without this a shared session would be a window onto server-wide
     * processes. The answer comes from the most recent `job/list` rows; on a
     * cache miss, one throwaway `job/list` stream is opened and abandoned. A
     * job the list does not mention is REFUSED: no answer is treated as no
     * permission, never the reverse.
     */
    const ownsJob = async (sessionId, jobId, signal) => {
        const cached = recentJobs.get(sessionId);
        if (cached !== undefined && cached.has(jobId))
            return cached.get(jobId) === sessionId;
        try {
            const iterable = await gateway.stream({
                namespace: 'job',
                method: 'list',
                args: { request: { sessionId } },
                signal,
            });
            for await (const frame of iterable) {
                rememberJobs(sessionId, frame);
                const jobs = recentJobs.get(sessionId);
                // The first frame is the whole recent set; anything the client could
                // have seen lives in it or nowhere.
                return jobs !== undefined && jobs.has(jobId) && jobs.get(jobId) === sessionId;
            }
            return false;
        }
        catch {
            return false;
        }
    };
    /**
     * Whether `workspaceId` names a workspace the server currently has, answered
     * from a one-shot `workspace/follow` baseline (T31 — the only workspace read
     * the gateway exposes; the stream is abandoned after its first frame). Any
     * failure — transport, unexpected first frame, missing entry — is `false`:
     * no answer is not permission. The create route pins the call to the
     * workspace rather than to a path on purpose: with `workspaceId` attached,
     * DSH takes `workspace.path` as the session cwd itself and attaches the new
     * session to the workspace (the group the client created it from).
     */
    const workspaceExists = async (workspaceId, signal) => {
        try {
            const iterable = await gateway.stream({ namespace: 'workspace', method: 'follow', args: {}, signal });
            for await (const frame of iterable) {
                if (!isPlainObject(frame) || frame.type !== 'baseline')
                    return false;
                const value = isPlainObject(frame.value) ? frame.value : undefined;
                const items = value !== undefined && Array.isArray(value.items) ? value.items : [];
                return items.some((item) => isPlainObject(item) && item.workspaceId === workspaceId);
            }
            return false;
        }
        catch {
            return false;
        }
    };
    /**
     * Open THIS server's own `$events` subscription (T32) — through the
     * host's wire adapter, the only door (docs/spike-relay.md §2.1 坑 1:
     * `gw.stream({namespace:'$events'})` refuses with
     * `gateway/invocation-unavailable`). The payload must be exactly
     * `{args:{}}` (gateway `openRemoteEvents`); the uplink is undefined —
     * the endpoint takes none and the host half-closes whatever arrives.
     */
    const openEventsStream = async (signal) => {
        const open = gateway.wireStream?.open;
        if (typeof open !== 'function') {
            throw Object.assign(new Error('forwarded Remote event source is unavailable'), {
                code: 'gateway/service-unavailable',
            });
        }
        const opened = (await open.call(gateway.wireStream, '$events', { args: {} }, undefined, undefined, signal));
        if (opened === null ||
            typeof opened !== 'object' ||
            typeof opened[Symbol.asyncIterator] !== 'function') {
            throw Object.assign(new Error('forwarded Remote event stream did not open'), {
                code: 'gateway/service-unavailable',
            });
        }
        return opened;
    };
    /** Record one forwarded waterfall in the subscription's registry (oldest
     * dropped past the cap), under its ORIGINAL id. */
    const rememberEvent = (sub, eventId, agentId) => {
        if (sub.events.size >= EVENT_REGISTRY_LIMIT) {
            const oldest = sub.events.keys().next().value;
            if (oldest !== undefined)
                sub.events.delete(oldest);
        }
        sub.events.set(eventId, agentId);
    };
    /**
     * The `$zr/events` frame discipline (T32, reworked in T32-fix2), one
     * function for the pump:
     *
     * - READY is recorded (the subscription's clientId, for the answer route)
     *   and forwarded SCRUBBED — the client learns "ready", never the host
     *   facts (`clientId`, `home`) that would let it speak to the gateway
     *   around this relay.
     * - WATERFALL frames whose `agentId` is not reachable right now are
     *   dropped — NOT answered on the sub-client's behalf (see DROPPED
     *   DELIVERIES below). Forwarded ones are registered and rewritten to
     *   `<token>.<eventId>`: the answer route resolves the subscription (and
     *   its device) from the token, so ids never cross subscriptions.
     *   Rewriting to virtual ids for the UI stays the CLIENT's job — it
     *   prefixes the whole thing with `zr~<serverId>~`.
     * - CANCEL frames are forwarded only for events this subscription
     *   forwarded (an unshared session's activity timeline must not leak
     *   through cancels), and the entry goes with the forward.
     * - EMIT frames are dropped entirely (T32-fix): they carry server-wide
     *   state (`api-session/added` summaries and titles, account expirations,
     *   cordis chatter) that is not share-scoped — forwarding them would leak
     *   unshared sessions and feed the sub-client ids it would treat as
     *   local. Everything a sub-client needs about a session's state travels
     *   the workspace/control streams, which ARE share-filtered.
     * - Anything not shaped exactly like a forwardable waterfall or cancel
     *   (T32-fix2, mirroring the client face's `parseRemoteEventFrame`
     *   exact-keys validation) is dropped too: a frame that slipped through
     *   would fail the sub-client's whole `$events` generation and leave it
     *   failing and reconnecting in a loop.
     *
     * DROPPED DELIVERIES STAY PENDING (T32-fix2): a dropped waterfall used to
     * be abstained `next` on behalf. That is gone on purpose. DSH's `next`
     * only retracts the answering client's OWN delivery, and the event
     * settles `next` — falling through to the host's fallback, where
     * `approval/request` resolves `unavailable` (which dsh-user-approval
     * treats as a rejection) and `user-questions/request` throws NO_PROVIDER
     * — only when NO delivery remains (RT dsh-api-gateway
     * `receiveRemoteEventResult`). With the desktop window closed and the
     * phone asleep, the relay IS the only delivery: one abstention would fail
     * every pending approval of the dropped session at once and break the
     * push → wake → approve flow. The price: a waterfall dropped here keeps
     * the relay's delivery pending, so an event the server UI answered `next`
     * waits until the next `$events` client connects — the gateway
     * re-delivers still-pending events to a fresh subscription
     * (`openRemoteEvents`). A wait, never a rejection.
     *
     * KNOWN LIMITATION: an event that arrives while its session is still
     * unshared is dropped; sharing the session later does NOT resurrect it
     * for the sub-client — it only sees such events from the next reconnect
     * onward, when the gateway re-delivers still-pending events to the fresh
     * subscription.
     */
    const filterEventsFrame = (sub, frame) => {
        if (!isPlainObject(frame))
            return null;
        if (frame.type === 'ready') {
            if (typeof frame.clientId === 'string' && frame.clientId !== '')
                sub.clientId = frame.clientId;
            return { type: 'ready' };
        }
        if (frame.type === 'waterfall') {
            if (!isForwardableWaterfall(frame) || !isAccessible(frame.agentId))
                return null;
            rememberEvent(sub, frame.eventId, frame.agentId);
            return { ...frame, eventId: `${sub.token}.${frame.eventId}` };
        }
        if (frame.type === 'cancel') {
            if (!isForwardableCancel(frame) || !sub.events.has(frame.eventId))
                return null;
            sub.events.delete(frame.eventId);
            return { ...frame, eventId: `${sub.token}.${frame.eventId}` };
        }
        return null;
    };
    const handle = async function handleRelay(req, res) {
        if (!secretsMatch(headerValue(req, 'x-zen-remote-secret'), secret) ||
            headerValue(req, 'x-zen-remote-via') !== 'gateway' ||
            headerValue(req, 'x-zen-remote-role') !== 'desktop-client') {
            responseJson(res, 401, { ok: false, error: { code: 'relay-unauthorized' } });
            return;
        }
        // The stream route below budgets concurrent streams per device; other
        // routes do not need the id beyond the gate itself.
        // The pathname EXACTLY as the webserver saw it — never decoded before
        // matching (see the module comment): a decoded match would turn the
        // gateway-admitted `…%2f…` shapes back into a traversal.
        let pathname = '';
        try {
            pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
        }
        catch {
            responseJson(res, 404, { ok: false, error: { code: 'not-found' } });
            return;
        }
        if (req.method === 'GET' && pathname === `${RELAY_PREFIX}/ping`) {
            responseJson(res, 200, { ok: true });
            return;
        }
        if (req.method === 'POST' && pathname === `${RELAY_PREFIX}/v1/handshake`) {
            const body = await readBodyOrRespond(req, res);
            if (body === undefined)
                return;
            // The compute rides its own guard (T42-fix): a throwing fingerprint
            // source answers an empty map and the handshake still succeeds.
            let fingerprints = {};
            try {
                fingerprints = (await serverInfo.fingerprints?.()) ?? {};
            }
            catch {
                fingerprints = {};
            }
            responseJson(res, 200, {
                ok: true,
                relayProtocol: RELAY_PROTOCOL,
                serverId: serverInfo.serverId,
                serverName: serverInfo.serverName(),
                dshVersion: serverInfo.dshVersion,
                // T42: the server's own interface fingerprints (empty when the wiring
                // had nothing to compute — the client judges group by group).
                fingerprints,
            });
            return;
        }
        if (req.method === 'POST' && pathname === `${RELAY_PREFIX}/v1/unshare`) {
            const body = await readBodyOrRespond(req, res);
            if (body === undefined)
                return;
            const sessionId = body.sessionId;
            if (typeof sessionId !== 'string' || sessionId === '') {
                responseJson(res, 400, { ok: false, error: { code: 'bad-request' } });
                return;
            }
            // The TABLE only — isShared, not isAccessible: a subagent or fork
            // session never entered the table, so it cannot be closed alone; it
            // leaves remote access together with its family or not at all.
            if (!store.isShared(sessionId)) {
                responseJson(res, 403, { ok: false, error: { code: 'not-shared' } });
                return;
            }
            store.unshare(sessionId, 'client');
            responseJson(res, 200, { ok: true });
            return;
        }
        if (req.method === 'POST' && pathname === `${RELAY_PREFIX}/v1/event-result`) {
            // The answer half of `$zr/events` (T32): `{eventId, result}`, where
            // `eventId` is the OPAQUE `<token>.<eventId>` string this relay handed
            // the sub-client (wrapped in `zr~<serverId>~` by the client), and
            // `result` is the Remote event OUTCOME, forwarded verbatim.
            const body = await readBodyOrRespond(req, res);
            if (body === undefined)
                return;
            const parsed = parseEventResultBody(body);
            if (parsed === undefined) {
                responseJson(res, 400, { ok: false, error: { code: 'bad-request' } });
                return;
            }
            // Ownership (T32-fix): the token locates the ONE subscription the
            // event was forwarded on — the answer is matched against that sub
            // only, and only from the device that holds it. An unknown token, a
            // foreign device, or an eventId that subscription did not forward is
            // the same refusal (no oracle about which half missed).
            const separator = parsed.eventId.indexOf('.');
            const token = separator === -1 ? '' : parsed.eventId.slice(0, separator);
            const originalEventId = separator === -1 ? '' : parsed.eventId.slice(separator + 1);
            let owner;
            if (token !== '' && originalEventId !== '') {
                const device = headerValue(req, 'x-zen-remote-device') ?? '';
                for (const sub of liveEventSubscriptions) {
                    if (sub.token !== token)
                        continue;
                    if (sub.device !== device)
                        break;
                    const agentId = sub.events.get(originalEventId);
                    if (agentId !== undefined && sub.clientId !== undefined) {
                        owner = { clientId: sub.clientId, agentId };
                    }
                    break;
                }
            }
            if (owner === undefined) {
                responseJson(res, 403, { ok: false, error: { code: 'unknown-event' } });
                return;
            }
            if (!isAccessible(owner.agentId)) {
                responseJson(res, 403, { ok: false, error: { code: 'not-shared' } });
                return;
            }
            const dispatch = gateway.dispatchRpc;
            if (typeof dispatch !== 'function') {
                responseJson(res, 200, {
                    ok: false,
                    error: { code: 'gateway/service-unavailable', message: 'forwarded Remote event source is unavailable' },
                });
                return;
            }
            // A hang-up cancels the answer mid-flight, like invoke's.
            const hangUp = new AbortController();
            const onClientGone = () => {
                if (!res.writableEnded)
                    hangUp.abort();
            };
            res.on('close', onClientGone);
            try {
                // Exactly the gateway's payload contract (parseRemoteEventResult):
                // one `args` field holding `{clientId, eventId, outcome}` — the
                // subscription's OWN clientId (the gateway matches results against
                // the client the event was delivered to) and the ORIGINAL eventId
                // with the token stripped back off; the outcome untouched. The
                // envelope — including the gateway's own
                // `{ok:false, error:{code:'gateway/internal',…}}` for a malformed
                // outcome — rides back as the 200 body.
                const envelope = (await dispatch.call(gateway, '$events/result', { args: { clientId: owner.clientId, eventId: originalEventId, outcome: parsed.result } }, hangUp.signal, undefined));
                responseJson(res, 200, isPlainObject(envelope) ? envelope : { ok: false, error: { code: 'internal' } });
            }
            catch (error) {
                const { code, message } = errorOf(error);
                responseJson(res, 200, message === undefined ? { ok: false, error: { code } } : { ok: false, error: { code, message } });
            }
            finally {
                res.off('close', onClientGone);
            }
            return;
        }
        if (req.method === 'POST' && pathname === `${RELAY_PREFIX}/v1/invoke`) {
            // The prompt-sized cap: a registered invoke may carry inline images in
            // its content blocks (see MAX_INVOKE_BODY_BYTES).
            const body = await readBodyOrRespond(req, res, MAX_INVOKE_BODY_BYTES);
            if (body === undefined)
                return;
            const namespace = body.namespace;
            const method = body.method;
            const args = body.args;
            if (typeof namespace !== 'string' ||
                namespace === '' ||
                typeof method !== 'string' ||
                method === '' ||
                args === null ||
                typeof args !== 'object' ||
                Array.isArray(args)) {
                responseJson(res, 400, { ok: false, error: { code: 'bad-request' } });
                return;
            }
            const decision = decideInvoke(namespace, method, args, isAccessible);
            if (!decision.allow) {
                responseJson(res, 403, { ok: false, error: { code: decision.reason } });
                return;
            }
            // A client hanging up must not leave the host running the call to
            // completion behind a dead socket: the connection's close (arriving
            // before the response ends) cancels the AbortController whose signal
            // rides into gateway.invoke. 'close' also fires AFTER a normal end,
            // so only an unfinished response counts as a hang-up.
            const hangUp = new AbortController();
            const onClientGone = () => {
                if (!res.writableEnded)
                    hangUp.abort();
            };
            res.on('close', onClientGone);
            try {
                // `job/kill` additionally proves the target job belongs to the
                // claimed session (4b): DSH opens ownerless jobs to everyone, so the
                // share-table check alone would let one shared session kill
                // server-wide background jobs.
                if (namespace === 'job' && method === 'kill') {
                    const request = isPlainObject(args) ? args.request : undefined;
                    const jobId = isPlainObject(request) && typeof request.jobId === 'string' && request.jobId !== ''
                        ? request.jobId
                        : undefined;
                    const sessionId = isPlainObject(request) && typeof request.sessionId === 'string' ? request.sessionId : '';
                    if (jobId === undefined || sessionId === '' || !(await ownsJob(sessionId, jobId, hangUp.signal))) {
                        responseJson(res, 403, { ok: false, error: { code: 'forbidden' } });
                        return;
                    }
                    // The ownership probe can take a round trip — remote may have been
                    // closed while it ran (T22b-fix). The decision above is stale the
                    // moment an await happened; re-run the share-table check before
                    // anything is forwarded.
                    if (!isAccessible(sessionId)) {
                        responseJson(res, 403, { ok: false, error: { code: 'not-shared' } });
                        return;
                    }
                }
                // T31-fix: the forwarded create is REBUILT as a whitelist, not
                // trimmed by deletion — exactly `{workspaceId, agentPreset?}` and
                // nothing else, so a hostile or buggy client cannot smuggle extra
                // fields (env, permissionMode, a caller-chosen sessionId, a decoy
                // cwd) through to DSH. The workspace was probed above; the new
                // session's id and cwd are DSH's own business (it mints the id and
                // takes `workspace.path`; a create naming BOTH workspaceId and cwd
                // would be a `gateway/bad-request`).
                if (namespace === 'session' && method === 'create') {
                    const request = isPlainObject(args) ? args.request : undefined;
                    const workspaceId = isPlainObject(request) && typeof request.workspaceId === 'string' && request.workspaceId !== ''
                        ? request.workspaceId
                        : undefined;
                    if (workspaceId === undefined || !(await workspaceExists(workspaceId, hangUp.signal))) {
                        responseJson(res, 403, { ok: false, error: { code: 'workspace/not-found' } });
                        return;
                    }
                    ;
                    args.request = {
                        workspaceId,
                        ...(isPlainObject(request) && typeof request.agentPreset === 'string'
                            ? { agentPreset: request.agentPreset }
                            : {}),
                    };
                }
                const value = await gateway.invoke({ namespace, method, args, signal: hangUp.signal });
                // T31: a session created or forked THROUGH the relay is shared
                // automatically — the client only ever sees shared sessions, so an
                // unshared result would be born unreachable. Re-sharing (a fork the
                // new-session listener already caught) is a table no-op.
                if (namespace === 'session' && (method === 'create' || method === 'fork')) {
                    const created = isPlainObject(value) && typeof value.sessionId === 'string' ? value.sessionId : undefined;
                    if (created !== undefined)
                        store.share(created);
                }
                const travels = decision.filter === 'session-list' ? filterSessionListResult(value, isAccessible) : value;
                responseJson(res, 200, { ok: true, value: travels });
            }
            catch (error) {
                // The gateway's own failures (unknown namespace, absent service) are
                // business answers, not transport errors: they ride a 200 envelope
                // like every other result, with the gateway's string code preserved.
                const { code, message } = errorOf(error);
                responseJson(res, 200, message === undefined ? { ok: false, error: { code } } : { ok: false, error: { code, message } });
            }
            finally {
                res.off('close', onClientGone);
            }
            return;
        }
        if (req.method === 'POST' && pathname === `${RELAY_PREFIX}/v1/stream`) {
            // Body validation identical to invoke: one JSON object naming the
            // method and carrying object args.
            const body = await readBodyOrRespond(req, res);
            if (body === undefined)
                return;
            const namespace = body.namespace;
            const method = body.method;
            const args = body.args;
            if (typeof namespace !== 'string' ||
                namespace === '' ||
                typeof method !== 'string' ||
                method === '' ||
                args === null ||
                typeof args !== 'object' ||
                Array.isArray(args)) {
                responseJson(res, 400, { ok: false, error: { code: 'bad-request' } });
                return;
            }
            const decision = decideStream(namespace, method, args, isAccessible);
            if (!decision.allow) {
                // Refusals are plain JSON: the NDJSON protocol only starts once the
                // stream is allowed, so a 403 here is the same shape invoke answers.
                responseJson(res, 403, { ok: false, error: { code: decision.reason } });
                return;
            }
            const device = headerValue(req, 'x-zen-remote-device') ?? '';
            if ((streamsByDevice.get(device) ?? 0) >= MAX_STREAMS_PER_DEVICE) {
                responseJson(res, 429, { ok: false, error: { code: 'too-many-streams' } });
                return;
            }
            streamsByDevice.set(device, (streamsByDevice.get(device) ?? 0) + 1);
            try {
                // `job/follow` proves job ownership before anything is streamed (4b) —
                // same check, same refusal as `job/kill` on the invoke route.
                if (namespace === 'job' && method === 'follow') {
                    const request = isPlainObject(args) ? args.request : undefined;
                    const jobId = isPlainObject(request) && typeof request.jobId === 'string' && request.jobId !== ''
                        ? request.jobId
                        : undefined;
                    const sessionId = decision.sessionIds[0] ?? '';
                    if (jobId === undefined || sessionId === '' || !(await ownsJob(sessionId, jobId, hangUpOf(res)))) {
                        responseJson(res, 403, { ok: false, error: { code: 'forbidden' } });
                        return;
                    }
                }
                // Headers that keep every intermediary from buffering the line
                // stream: DSH's web server runs a compression middleware that would
                // hold the response until it is complete (it skips responses marked
                // `no-transform`), and nginx keeps buffering unless told otherwise.
                // Flushed immediately, so the client sees 200 + content type before
                // the first upstream frame exists.
                res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store, no-transform');
                res.setHeader('X-Accel-Buffering', 'no');
                res.setHeader('X-Content-Type-Options', 'nosniff');
                res.flushHeaders();
                let clientGone = false;
                let finished = false;
                const hangUp = new AbortController();
                const onClientGone = () => {
                    if (!res.writableEnded) {
                        clientGone = true;
                        hangUp.abort();
                    }
                };
                // 'error' rides along because a write racing a destroyed socket
                // surfaces there first; the reaction is the same as a hang-up.
                res.on('close', onClientGone);
                res.on('error', onClientGone);
                const heartbeat = setInterval(() => {
                    if (!finished && !clientGone)
                        res.write(PING_LINE);
                }, heartbeatMs);
                // The host process must never be kept alive by a heartbeat alone.
                if (typeof heartbeat.unref === 'function')
                    heartbeat.unref();
                /**
                 * One NDJSON line, honoring backpressure: when the socket buffer is
                 * full the write returns false and the caller waits for `drain`
                 * before the next write runs. A line racing a disconnect resolves
                 * without writing (the 'close' leg of the wait). `tail` exempts the
                 * line closeWith is writing from its own finished gate — without it
                 * the end/error line would silence itself.
                 *
                 * Every write goes through ONE promise chain (T22b-fix): share-change
                 * frames are enqueued behind whatever the pump is draining instead of
                 * `void`-ing into the socket buffer in parallel, so a burst of
                 * synthesized frames neither interleaves the pump's write/drain
                 * cycles nor grows the buffer unboundedly.
                 */
                let writeChain = Promise.resolve();
                const writeLine = (value, tail = false) => {
                    const run = writeChain.then(() => {
                        if ((!tail && finished) || clientGone || res.destroyed || res.writableEnded)
                            return;
                        return new Promise((resolve) => {
                            if (res.write(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'))) {
                                resolve();
                                return;
                            }
                            let settle = () => { };
                            const onDrain = () => settle();
                            const onClose = () => settle();
                            settle = () => {
                                res.off('drain', onDrain);
                                res.off('close', onClose);
                                resolve();
                            };
                            res.on('drain', onDrain);
                            res.on('close', onClose);
                        });
                    });
                    writeChain = run.then(() => undefined, () => undefined);
                    return run;
                };
                /**
                 * The one transition into "response over": idempotent, clears the
                 * heartbeat, writes the optional tail line, then ends the response.
                 *
                 * T43-A/fix: a client that stopped reading must not pin the stream —
                 * with it the viewer count and the device budget — forever. The
                 * watchdog starts UNCONDITIONALLY and owns the whole finish: the
                 * response either FINISHES (tail line and end-of-body handed to the
                 * socket — the `finish` event disarms the timer) or is gone
                 * (`close`), or it is destroyed after `endDrainTimeoutMs`. No
                 * branching on `writableNeedDrain`: a write that returned true can
                 * still be sitting in front of a full kernel buffer, and `finish`
                 * is the only honest "it drained" signal.
                 */
                const closeWith = (line) => {
                    if (finished)
                        return;
                    finished = true;
                    clearInterval(heartbeat);
                    let watchdog;
                    const stopWatchdog = () => {
                        res.off('finish', onSettled);
                        res.off('close', onSettled);
                        if (watchdog !== undefined) {
                            clearTimeout(watchdog);
                            watchdog = undefined;
                        }
                    };
                    const onSettled = () => {
                        stopWatchdog();
                    };
                    if (!clientGone && !res.destroyed && !res.writableEnded) {
                        res.once('finish', onSettled);
                        res.once('close', onSettled);
                        watchdog = setTimeout(() => {
                            watchdog = undefined;
                            res.off('finish', onSettled);
                            res.off('close', onSettled);
                            // The tail is somewhere in the buffers but the client never
                            // reads: destroying is the only way this response (and its
                            // counters) ever finishes.
                            try {
                                res.destroy();
                            }
                            catch {
                                // Already gone.
                            }
                        }, endDrainTimeoutMs);
                        // The host process must never be kept alive by a finish alone.
                        if (typeof watchdog.unref === 'function')
                            watchdog.unref();
                    }
                    const tailLine = line === null ? Promise.resolve() : writeLine(line, true);
                    void tailLine.then(() => {
                        if (!clientGone && !res.destroyed && !res.writableEnded)
                            res.end();
                    });
                };
                // ---- share-change synchronization (T22b §4) --------------------
                // The `$zr/events` forwarding bookkeeping (T32): registered for the
                // answer route the moment this stream starts being served, removed
                // in the pump's finally. The token is baked into every forwarded
                // eventId and binds the answers to THIS subscription; the device
                // binds them to THIS connection's pairing.
                const eventsSub = decision.events === true
                    ? { device, token: randomBytes(8).toString('hex'), clientId: undefined, events: new Map() }
                    : undefined;
                if (eventsSub !== undefined)
                    liveEventSubscriptions.add(eventsSub);
                let unsubscribe = () => { };
                let applyToState;
                if (decision.filter === 'workspace') {
                    // Keep the UNFILTERED latest workspace state so share changes can
                    // synthesize exactly the frames the client is now allowed to see.
                    const state = createWorkspaceFollowState();
                    applyToState = (frame) => state.apply(frame);
                    unsubscribe = store.subscribe((event) => {
                        if (event.type !== 'shared' && event.type !== 'unshared')
                            return;
                        if (finished || clientGone)
                            return;
                        for (const frame of state.onShareChange(event.sessionId, isAccessible)) {
                            void writeLine({ type: 'frame', frame });
                        }
                    });
                }
                else if (decision.filter === 'control') {
                    // A newly shared session needs its current projections: fetch
                    // them once and emit one synthesized `projection` frame per key,
                    // shaped exactly like the upstream frames. An unshared session
                    // synthesizes nothing — the client drops it via the workspace
                    // stream's re-filtered upserts.
                    const syncProjections = async (sessionId) => {
                        let result;
                        try {
                            result = await gateway.invoke({
                                namespace: 'session',
                                method: 'projections',
                                args: { request: { sessionId } },
                                signal: hangUp.signal,
                            });
                        }
                        catch {
                            return; // projections unavailable — the next live projection frame will flow anyway
                        }
                        if (!isPlainObject(result) || finished || clientGone || !isAccessible(sessionId))
                            return;
                        const values = isPlainObject(result.values) ? result.values : {};
                        const seq = typeof result.asOfSeq === 'number' ? result.asOfSeq : 0;
                        for (const key of Object.keys(values)) {
                            void writeLine({ type: 'frame', frame: { type: 'projection', sessionId, key, value: values[key], seq } });
                        }
                    };
                    unsubscribe = store.subscribe((event) => {
                        if (event.type !== 'shared' || finished || clientGone)
                            return;
                        void syncProjections(event.sessionId);
                    });
                }
                else if (eventsSub !== undefined) {
                    // `$zr/events` (T32-fix): the share table closing a session must
                    // also close the prompts this subscription is showing for it —
                    // synthesize the same cancel frame the gateway would have sent
                    // and drop the registry entry, so the sub-client closes the
                    // prompt and a late answer refuses unknown-event (which the
                    // client turns into the same silent ok DSH gives a stale
                    // result). The relay's OWN delivery is deliberately NOT abstained
                    // away (T32-fix2, see filterEventsFrame's DROPPED DELIVERIES): it
                    // stays pending at the gateway, still answerable by the server
                    // UI or a future subscriber. Events of still-reachable sessions
                    // are untouched; nothing is synthesized on a share (the known
                    // limitation in filterEventsFrame's comment).
                    unsubscribe = store.subscribe((event) => {
                        if (event.type !== 'unshared' || finished || clientGone)
                            return;
                        for (const [eventId, agentId] of [...eventsSub.events]) {
                            if (isAccessible(agentId))
                                continue;
                            eventsSub.events.delete(eventId);
                            void writeLine({
                                type: 'frame',
                                frame: { type: 'cancel', eventId: `${eventsSub.token}.${eventId}` },
                            });
                        }
                    });
                }
                else {
                    // Session-scoped stream: count its viewers, and die loudly when
                    // a dependency stops being shared — silence would leave the
                    // client reading a session it can no longer reach.
                    for (const id of decision.sessionIds)
                        viewers.set(id, (viewers.get(id) ?? 0) + 1);
                    unsubscribe = store.subscribe((event) => {
                        if (event.type !== 'unshared' || finished || clientGone)
                            return;
                        if (decision.sessionIds.every((id) => isAccessible(id)))
                            return;
                        closeWith({
                            type: 'error',
                            error: {
                                code: 'unshared',
                                message: `shared session ${event.sessionId} was unshared (${event.reason})`,
                            },
                        });
                        hangUp.abort();
                    });
                }
                const filterFrame = eventsSub !== undefined
                    ? (frame) => filterEventsFrame(eventsSub, frame)
                    : decision.filter === 'workspace'
                        ? (frame) => filterWorkspaceFrame(frame, isAccessible)
                        : decision.filter === 'control'
                            ? (frame) => filterControlFrame(frame, isAccessible)
                            : namespace === 'job' && method === 'list'
                                // 4b: ownerless and foreign jobs stay server-side.
                                ? (frame) => filterJobListFrame(frame, ownerSessionIdOf(args))
                                : (frame) => frame;
                // closeAll's kill switch for THIS stream: idempotent, safe to call on
                // an already-finished stream. Registered only while the response is
                // being served; the pump's finally unregisters it.
                const killThisStream = () => {
                    hangUp.abort();
                    const reason = serverClosedReason;
                    closeWith(reason === null || reason === ''
                        ? { type: 'error', error: { code: 'server-restart' } }
                        : { type: 'error', error: { code: 'server-restart', message: reason } });
                };
                openStreamKills.add(killThisStream);
                // Registered beside the kill switch: closeAll detaches the stream's
                // share-table listener synchronously, before the pump's own teardown
                // gets a turn (T43-B).
                tableUnsubscribers.add(unsubscribe);
                // Last gate before anything is opened (T22b-fix): both checks cover
                // the window the ownership probe (or any earlier await) opened — an
                // unshare or a closeAll during that window fires no event this stream
                // could have observed, so the CURRENT state decides.
                const firstInaccessible = decision.sessionIds.find((id) => !isAccessible(id));
                const restartReason = serverClosedReason;
                try {
                    if (restartReason !== null) {
                        // The handler was closed while this request was still deciding —
                        // nothing may open anymore.
                        killThisStream();
                    }
                    else if (firstInaccessible !== undefined) {
                        hangUp.abort();
                        closeWith({
                            type: 'error',
                            error: { code: 'unshared', message: `shared session ${firstInaccessible} is no longer shared` },
                        });
                    }
                    else {
                        // `$zr/events` opens through the wire adapter (the ONLY door to
                        // the forwarded-event stream); every other route is a typert
                        // stream method.
                        const iterable = eventsSub !== undefined
                            ? await openEventsStream(hangUp.signal)
                            : await gateway.stream({ namespace, method, args, signal: hangUp.signal });
                        for await (const frame of iterable) {
                            if (finished || clientGone)
                                break;
                            if (namespace === 'job' && method === 'list')
                                rememberJobs(ownerSessionIdOf(args), frame);
                            applyToState?.(frame);
                            const filtered = filterFrame(frame);
                            if (filtered === null)
                                continue;
                            await writeLine({ type: 'frame', frame: filtered });
                        }
                        closeWith({ type: 'end' });
                    }
                }
                catch (error) {
                    if (hangUp.signal.aborted || clientGone) {
                        // The abort a hang-up (or an unshare kill) sends into the
                        // iterator surfaces as gateway/cancelled — that is the stream's
                        // DOCUMENTED normal end, swallowed whole.
                        closeWith(null);
                    }
                    else {
                        const { code, message } = errorOf(error);
                        closeWith(message === undefined ? { type: 'error', error: { code } } : { type: 'error', error: { code, message } });
                    }
                }
                finally {
                    openStreamKills.delete(killThisStream);
                    clearInterval(heartbeat);
                    unsubscribe();
                    tableUnsubscribers.delete(unsubscribe);
                    if (eventsSub !== undefined) {
                        liveEventSubscriptions.delete(eventsSub);
                        eventsSub.events.clear();
                    }
                    res.off('close', onClientGone);
                    res.off('error', onClientGone);
                    if (decision.filter === undefined) {
                        for (const id of decision.sessionIds) {
                            const remaining = (viewers.get(id) ?? 1) - 1;
                            if (remaining <= 0)
                                viewers.delete(id);
                            else
                                viewers.set(id, remaining);
                        }
                    }
                }
            }
            finally {
                const remaining = (streamsByDevice.get(device) ?? 1) - 1;
                if (remaining <= 0)
                    streamsByDevice.delete(device);
                else
                    streamsByDevice.set(device, remaining);
            }
            return;
        }
        responseJson(res, 404, { ok: false, error: { code: 'not-found' } });
    };
    handle.viewerCount = (sessionId) => viewers.get(sessionId) ?? 0;
    handle.closeAll = (reason) => {
        // Detach EVERY share-table listener first (T43-B): after this point the
        // dead handler must not be reached by any share/unshare — not even by a
        // stream whose pump is parked on a full socket buffer and whose own
        // teardown still awaits the 'close' the kills below cause. Calling an
        // unsubscribe twice is a no-op, so the pumps' finallys stay honest.
        for (const detach of [...tableUnsubscribers])
            detach();
        tableUnsubscribers.clear();
        // The event-forwarding registries go with them (T32): after closeAll no
        // answer may still compose a payload for a dead handler's clientId —
        // the streams' own finallys would clear theirs, but only after their
        // teardown unwinds, and an answer could slip into that window.
        for (const sub of liveEventSubscriptions) {
            sub.clientId = undefined;
            sub.events.clear();
        }
        liveEventSubscriptions.clear();
        // Remember the reason for requests still inside their ownership probe —
        // they read it at the pre-open gate. Killing the open streams runs their
        // normal teardown (error line, res.end, abort), whose finally releases
        // the viewer/device counters and the share-table listeners.
        serverClosedReason = typeof reason === 'string' ? reason : '';
        for (const kill of [...openStreamKills])
            kill();
        openStreamKills.clear();
    };
    return handle;
}
/** The claimed session of a `job/list` subscription — decideStream has
 * already verified it is a non-empty shared id; anything else is '' and the
 * job filter then keeps nothing. */
function ownerSessionIdOf(args) {
    const request = isPlainObject(args) ? args.request : undefined;
    return isPlainObject(request) && typeof request.sessionId === 'string' ? request.sessionId : '';
}
/**
 * A throwaway abort signal for checks that run before the stream's own
 * controller exists (the job ownership probe). Tied to the response: once the
 * client is gone there is no point fetching anything for it.
 */
function hangUpOf(res) {
    const controller = new AbortController();
    res.once('close', () => {
        if (!res.writableEnded)
            controller.abort();
    });
    return controller.signal;
}
//# sourceMappingURL=relay-server.js.map