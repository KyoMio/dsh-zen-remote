/**
 * Relay client for the sub-client half (T23a): the `client`-role side of the
 * 2.0.0 relay protocol. A DSH process on another machine pairs with a relay
 * server's gateway (Bearer device token, T16) and reaches the server's
 * shared sessions through `POST relay/v1/handshake|invoke|stream` — this
 * module speaks that wire from the far end, with no dependencies beyond the
 * Node 18+ standard library and the global `fetch`.
 *
 * Every call re-reads the credentials through the injected getters, so a
 * re-pair in the settings page applies to the NEXT request without touching
 * this module (the same volatile-row discipline src/client-routes.ts keeps).
 * Missing credentials never touch the network: the client reports
 * `unpaired` and every entry point throws immediately.
 *
 * Two wire details are load-bearing. `accept: application/json` — the
 * gateway answers its pairing wall as a JSON 401 `{reason:'unpaired'}` only
 * to requests that accept JSON; without the header a revoked token would
 * draw the HTML pairing page and be unclassifiable. `redirect: 'manual'` —
 * a wrong or hijacked server must not walk the pairing token through a
 * redirect chain (the same rule src/client-routes.ts probes with).
 *
 * State moves only where the contract says so: `offline` on transport
 * failure, `revoked` on the gateway's unpaired wall, `incompatible` on the
 * relay-only wall or a handshake protocol mismatch, and back to `online` on
 * any success envelope. Everything else — the per-call refusals
 * (`not-shared` / `no-session` / `forbidden-method`), a 200 `{ok:false}`
 * envelope, the gateway's own `relay-unauthorized` — is an ANSWER about the
 * call, not about the link, and leaves the state alone.
 *
 * Since T43 the client also reconnects on its own: an `offline` client walks
 * a 1s → 2s → 5s → 10s → 30s ladder (0–20% jitter per wait) until a success
 * lifts it back to `online`; `unpaired`, `revoked` and `incompatible` never
 * reconnect on their own — they need a user action, which arrives as
 * `credentialsChanged()` (or a fresh `connect()`). The wait is observable as
 * `nextRetryAt`, the last failure code as `lastError`; both carry no
 * credential material.
 *
 * Since T42 the client also judges INTERFACE compatibility: when the wiring
 * injects `computeOwnFingerprints`, every completed handshake is followed by
 * a group-by-group comparison of the server's `fingerprints` map against the
 * locally computed one, stored as `compat` ({@link RelayCompatVerdict}).
 * Groups either side could not compute land in `unavailable` — never in
 * `different` — so a partial view stays silent. The verdict is read live by
 * the status route; listeners additionally hear about it through the same
 * notification channel the state changes use.
 */
import { createHash } from 'node:crypto';
import { compareFingerprints } from './fingerprint.js';
/** The one protocol version this client speaks; the handshake verifies it. */
const RELAY_PROTOCOL = 1;
const HANDSHAKE_PATH = '/_dsh/zen-remote/relay/v1/handshake';
const INVOKE_PATH = '/_dsh/zen-remote/relay/v1/invoke';
const STREAM_PATH = '/_dsh/zen-remote/relay/v1/stream';
const UNSHARE_PATH = '/_dsh/zen-remote/relay/v1/unshare';
const EVENT_RESULT_PATH = '/_dsh/zen-remote/relay/v1/event-result';
const HTTP_PATH = '/_dsh/zen-remote/relay/v1/http';
const UPLOAD_PATH = '/_dsh/zen-remote/relay/v1/upload';
/** T59: a desktop-client device renaming ITSELF in the gateway's table. */
const DEVICE_NAME_PATH = '/_dsh/zen-remote/relay/v1/device/name';
/** How long a stream may stay line-silent before it is judged dead. */
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
/** How long one request/response round-trip may take in full. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/**
 * The invoke round-trip budget (T31-fix): the configured request timeout
 * plus 2 s per MiB of request body, capped at five minutes. The large
 * bodies are the prompt routes' INLINE images — `session/prompt` /
 * `subagents/prompt` content blocks carry base64 `image` data, one image up
 * to 20 MiB by default (`maxImageBytes`, dsh-attachment-local) or ~27 MiB
 * encoded — so a full-size picture over a slow link gets minutes, not the
 * base seconds. The cap never lands below the configured base timeout.
 */
const INVOKE_TIMEOUT_PER_MIB_MS = 2_000;
const INVOKE_TIMEOUT_CAP_MS = 300_000;
/**
 * How often an ONLINE client re-runs the handshake purely to refresh the two
 * names (T59): the server's display name and this device's name in its
 * table. The stream heartbeat covers the server name mid-stream, but a
 * device-side rename (an admin edit in the gateway's list) only reaches the
 * server→client direction when THIS side sends a request — the handshake's
 * marking header is always the gateway's freshest record. Deliberately quiet:
 * a failed refresh changes nothing (the heartbeat/idle clocks judge the
 * link), and the state never leaves `online`.
 */
const INFO_REFRESH_MS = 30_000;
/**
 * The budget one size-backed exchange gets (invoke since T31-fix, upload
 * since T51): whole MiB only (floored), so a small call keeps the plain
 * base budget. The upload's size is the DECLARED `Content-Length` of the
 * local request when it carried one; an unknown size (a chunked body has no
 * length header, and this process's undici forbids hand-set length headers)
 * gets the full cap — the honest budget for an upload whose end is not in
 * sight.
 */
function sizeBackedTimeoutMs(requestTimeoutMs, bytes) {
    const mib = bytes === undefined ? Number.POSITIVE_INFINITY : Math.floor(bytes / (1024 * 1024));
    return Math.min(requestTimeoutMs + INVOKE_TIMEOUT_PER_MIB_MS * mib, Math.max(requestTimeoutMs, INVOKE_TIMEOUT_CAP_MS));
}
/** The budget one invoke exchange gets, from its serialized body size. */
function invokeTimeoutMs(requestTimeoutMs, bodyJson) {
    return sizeBackedTimeoutMs(requestTimeoutMs, Buffer.byteLength(bodyJson, 'utf8'));
}
/** 0 or less disables the periodic refresh entirely (tests that count
 * handshakes inject 0; the T59 refresh test injects the real cadence). */
function infoRefreshDelay(options) {
    return options.infoRefreshMs ?? INFO_REFRESH_MS;
}
/**
 * The automatic reconnect ladder (T43): after the client lands `offline` it
 * retries after 1s, 2s, 5s, 10s, 30s — and then every 30s until the link
 * comes back. Each wait gains 0–20% of random jitter so a fleet of clients
 * that lost the same server does not retry in lockstep. A success back to
 * `online` resets the ladder to the first step.
 */
const RETRY_STEPS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Upper bound of the jitter fraction added to one retry delay (0–20%). */
const RETRY_JITTER = 0.2;
/**
 * The default clock: real time, `unref()`ed timers, `Math.random`. Exported
 * so the interceptor's own waits (the merged-stream reopen delays) run on
 * the SAME clock face — one injectable seam for tests instead of two.
 */
export const defaultClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        if (typeof handle.unref === 'function')
            handle.unref();
        return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle),
    random: () => Math.random(),
};
/**
 * One relay failure. `code` is the mapped reason (the contract's state
 * vocabulary, a server refusal like `not-shared`, or a DSH error code from
 * a 200 `{ok:false}` envelope); `status` carries the HTTP status when a
 * response existed. `reason` is the OPTIONAL structured detail some error
 * frames carry beside the message — today only the server's `unshared`
 * stream-closure frame, whose `reason` ('manual' | 'client' | 'idle', T34)
 * the interceptor's closed-session display keys on. Fields are assigned in
 * the constructor body rather than declared as parameter properties: Node's
 * strip-only type mode rejects that syntax (the same rule as UploadError in
 * index.ts).
 */
export class RelayError extends Error {
    code;
    status;
    reason;
    constructor(code, message, httpStatus, reason) {
        super(message === undefined ? code : message);
        this.name = 'RelayError';
        this.code = code;
        if (httpStatus !== undefined)
            this.status = httpStatus;
        if (reason !== undefined)
            this.reason = reason;
    }
}
/**
 * The credential digest recorded beside a completed handshake (T23a-fix):
 * sha256 over `url + "\n" + token`, first 16 hex chars. Enough to detect a
 * changed address or a re-pair, without keeping — or ever exposing — a
 * plaintext copy of either value.
 */
export function relayCredentialsDigest(serverUrl, token) {
    return createHash('sha256').update(`${serverUrl}\n${token}`).digest('hex').slice(0, 16);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Whether the loader's `loader/volatile-update` announcement names the
 * device's own field (T59-fix): the announcement rides EVERY volatile
 * commit — an unrelated knob, or the settings page's own follow write — and
 * only a commit that actually moved `serverName` may queue a push. The
 * paths are the loader's changed-field lists (`[['serverName'], …]`).
 */
export function volatileUpdateTouchesServerName(paths) {
    return Array.isArray(paths) && paths.some((entry) => Array.isArray(entry) && entry[0] === 'serverName');
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * One response body, parsed leniently. Reading the text is allowed to
 * REJECT (a connection cut mid-body is a transport failure the caller maps
 * to `offline`); only the JSON step is lenient — an HTML wall or any other
 * non-JSON body becomes `undefined`, which the classifier then treats as
 * "no usable body".
 */
async function readPayload(response) {
    const text = await response.text();
    if (text === '')
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/** A string field of an info line, or undefined — absent, blank or not a string. */
function infoString(value) {
    return typeof value === 'string' && value !== '' ? value : undefined;
}
function classifyLine(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return { kind: 'none' }; // a damaged line is skipped, never fatal
    }
    if (!isRecord(parsed))
        return { kind: 'none' };
    if (parsed.type === 'frame' && 'frame' in parsed)
        return { kind: 'frame', frame: parsed.frame };
    if (parsed.type === 'end')
        return { kind: 'end' };
    if (parsed.type === 'error') {
        const detail = isRecord(parsed.error) ? parsed.error : {};
        const code = typeof detail.code === 'string' && detail.code !== '' ? detail.code : 'internal';
        const message = typeof detail.message === 'string' ? detail.message : undefined;
        // The structured detail beside the message (T34): today only the
        // `unshared` frame carries one. An absent or non-string reason stays
        // undefined — the consumer degrades to its own default.
        const reason = typeof detail.reason === 'string' ? detail.reason : undefined;
        return { kind: 'error', error: new RelayError(code, message, undefined, reason) };
    }
    // T59: a ping may carry the names as of NOW (`serverName` — the server's
    // display name; `deviceName` — this device's name in its table). An old
    // server's bare `{"type":"ping"}` carries neither and stays `none`.
    if (parsed.type === 'ping') {
        const serverName = infoString(parsed.serverName);
        const deviceName = infoString(parsed.deviceName);
        if (serverName !== undefined || deviceName !== undefined)
            return { kind: 'info', serverName, deviceName };
    }
    // Any shape the protocol does not define — ignored.
    return { kind: 'none' };
}
/**
 * Build one relay client. Pure state machine + fetch plumbing; the row is
 * only ever seen through the two getters.
 */
export function createRelayClient(options) {
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    const clock = options.clock ?? defaultClock;
    let state = 'unpaired';
    let handshakeInfo;
    let compat;
    let lastHandshakeDigest;
    let connectInFlight;
    // T43 reconnect machinery: the armed timer handle, how many consecutive
    // attempts have failed (the ladder index), when the armed timer fires, the
    // code of the most recent failure, and whether the row teardown stopped
    // the machinery.
    let retryTimer;
    let retryAttempt = 0;
    let nextRetryAt = null;
    let lastError;
    let stopped = false;
    // Digest of the credentials the machinery last SAW — the change detector
    // behind credentialsChanged().
    const initialCredentials = currentCredentials();
    let credentialsDigest = initialCredentials === undefined ? undefined : relayCredentialsDigest(initialCredentials.url, initialCredentials.token);
    const listeners = new Set();
    /** One broadcast of the CURRENT state to every subscriber; a throwing
     * listener never blocks the rest. State transitions are the only trigger —
     * including the handshake's connecting→online pair, which is how the T42
     * compat verdict (stored just before `online`) reaches the settings
     * surface: woken listeners read the getter fresh. */
    function notify() {
        for (const listener of [...listeners]) {
            try {
                listener(state);
            }
            catch {
                // One broken listener never blocks the rest.
            }
        }
    }
    function setState(next) {
        if (state === next)
            return;
        state = next;
        // The reconnect hooks ride the transitions (T43): landing offline arms
        // the next wait; online resets the ladder; the three user-action states
        // never reconnect and drop any pending wait; an attempt start leaves the
        // ladder alone but the wait display is fireRetry's business.
        if (next === 'offline')
            scheduleRetry();
        else if (next === 'online') {
            resetRetry();
            // T59: a server confirmation retires the local push authority (the
            // handshake/stream/invoke that just landed saw the table as it is),
            // the periodic name refresh arms, and a rename queued while offline
            // goes out now.
            deviceNameAuthoritative = false;
            armInfoRefresh();
            flushPendingDeviceName();
        }
        else if (next === 'unpaired' || next === 'revoked' || next === 'incompatible')
            cancelRetry();
        // A compat verdict describes the server the CURRENT credentials pointed
        // at. Unpairing (or a revocation — the same "this server is gone" wall)
        // invalidates that answer, so the verdict goes with the link (T42-fix).
        if (next === 'unpaired' || next === 'revoked')
            compat = undefined;
        notify();
    }
    /**
     * The live credentials, or undefined — the requireCredentials logic
     * without the announcement, shared with credentialsChanged's change
     * detection.
     */
    function currentCredentials() {
        const url = options.getServerUrl();
        const token = options.getToken();
        if (url === undefined || url.trim() === '' || token === undefined || token === '')
            return undefined;
        // The getter contract delivers a normalized address; stripping stray
        // trailing slashes anyway keeps a hand-edited row from silently producing
        // `…/relay//v1/…`, which no route would ever match.
        return { url: url.trim().replace(/\/+$/u, ''), token };
    }
    /**
     * The live credentials, or the unpaired failure. Never a request without
     * both halves — and the unpaired state is (re)announced, so a row whose
     * address or token was cleared later shows up as unpaired too.
     */
    function requireCredentials() {
        const creds = currentCredentials();
        if (creds === undefined) {
            setState('unpaired');
            throw new RelayError('unpaired', 'no server address or pairing token is configured');
        }
        credentialsDigest = relayCredentialsDigest(creds.url, creds.token);
        return creds;
    }
    // ---- the reconnect ladder (T43) ------------------------------------------
    function cancelRetry() {
        if (retryTimer !== undefined) {
            clock.clearTimeout(retryTimer);
            retryTimer = undefined;
        }
        retryAttempt = 0;
        nextRetryAt = null;
    }
    function resetRetry() {
        cancelRetry();
        lastError = undefined;
    }
    function scheduleRetry() {
        // One wait at a time — a second offline entry while a timer is armed
        // (e.g. a status-route connect failing between two ticks) leaves the
        // armed timer in charge.
        if (stopped || retryTimer !== undefined)
            return;
        const base = RETRY_STEPS_MS[Math.min(retryAttempt, RETRY_STEPS_MS.length - 1)];
        const delay = Math.round(base * (1 + clock.random() * RETRY_JITTER));
        retryAttempt += 1;
        nextRetryAt = clock.now() + delay;
        retryTimer = clock.setTimeout(fireRetry, delay);
    }
    function fireRetry() {
        retryTimer = undefined;
        nextRetryAt = null;
        if (stopped || state !== 'offline')
            return;
        // The attempt's own outcome drives the machine: success → online (ladder
        // reset), a still-offline failure → scheduleRetry armed the next step,
        // a wall (revoked/incompatible/unpaired) → cancelRetry ran.
        void connect().catch(() => { });
    }
    /**
     * The error-code vocabulary the diagnostics readout accepts (T43-fix):
     * short, alphanumeric with / _ - separators. A server that answers a
     * "code" quoting URLs or anything stranger does not get to write it into
     * the client's state — it degrades to `unexpected`.
     */
    function sanitizeCode(code) {
        return /^[a-z0-9/_-]{1,64}$/i.test(code) ? code : 'unexpected';
    }
    /** Record the failing call's code for the diagnostics surface (the CODE
     * only — messages quote URLs, and codes never carry credentials). */
    function noteFailure(code) {
        lastError = sanitizeCode(code);
    }
    function subscribe(listener) {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }
    // ---- the T59 device-name sync ----------------------------------------------
    /**
     * True while THIS side's `deviceName` is the authority: a rename this
     * client pushed that the gateway just answered OK to. In-flight stream
     * heartbeats still carry the OLD name (their marking header was written
     * when the stream opened), and without this flag those pings would pull
     * `handshakeInfo` back to the stale name — and the settings page would
     * then "follow" it straight over the user's fresh save. The next server
     * confirmation (handshake or refresh) retires the flag: the answer there
     * IS the table's current record.
     */
    let deviceNameAuthoritative = false;
    /** A rename waiting for the link: queued while offline (or before the
     * first handshake), flushed once `online` lands. */
    let pendingDeviceName;
    // T59-fix: a push that is IN FLIGHT right now, plus a sequence counter
    // bumped at every push start AND settle. An info-refresh answer that
    // overlapped a push (seq moved, or a push is still queued) carries the
    // PRE-push record and must not win — see {@link refreshInfo}.
    let deviceNamePushBusy = false;
    let deviceNamePushSeq = 0;
    /**
     * Whether a locally-pushed rename is queued or in flight (T59-fix). The
     * status route answers an EMPTY `deviceName` while this is true: an
     * in-flight status answer could still carry the pre-push record, and a
     * page that followed it would bounce the user's fresh save straight back
     * to the old name.
     */
    function deviceNameSyncing() {
        return deviceNamePushBusy || pendingDeviceName !== undefined;
    }
    /** The periodic info-refresh's armed timer (see {@link INFO_REFRESH_MS}). */
    let infoTimer;
    /** Fold one heartbeat's names into the stored handshake (T59). */
    function applyInfoDelta(serverName, deviceName) {
        if (handshakeInfo === undefined)
            return;
        const next = { ...handshakeInfo };
        let changed = false;
        if (serverName !== undefined && serverName !== next.serverName) {
            next.serverName = serverName;
            changed = true;
        }
        // A locally-pushed rename outranks the stream heartbeat until the server
        // confirms it — see {@link deviceNameAuthoritative}; a push IN FLIGHT is
        // equally authoritative for the same reason (T59-fix): the heartbeat's
        // name was stamped before our rename reached the table.
        if (deviceName !== undefined && deviceName !== next.deviceName && !deviceNameAuthoritative && !deviceNamePushBusy) {
            next.deviceName = deviceName;
            changed = true;
        }
        if (!changed)
            return;
        handshakeInfo = next;
        // The state itself did not move, but the identity did: subscribers (the
        // interceptor's rename path above all) must see the new names. The
        // current-state broadcast is exactly that — no reconnect can come from
        // it, because only setState moves the machine.
        notify();
    }
    /**
     * Push one name to the gateway's `device/name` endpoint (T59): the gateway
     * renames the CALLING device's own record. Resolves `true` when the table
     * now carries `name` (the push answered OK) or when no push was needed;
     * a failed push queues the name for the next `online` and resolves false.
     * Never touches the connection state — a refused rename is not a dead
     * link.
     */
    async function pushDeviceName(name) {
        const creds = currentCredentials();
        if (creds === undefined) {
            pendingDeviceName = name;
            return false;
        }
        // T59-fix: the busy window covers the whole round-trip (the status route
        // answers an empty deviceName while it lasts), and the sequence counter
        // lets an overlapping info refresh know its answer is stale.
        const digestAtStart = credentialsDigest;
        deviceNamePushBusy = true;
        deviceNamePushSeq += 1;
        let payload;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
            if (typeof timer.unref === 'function')
                timer.unref();
            try {
                const response = await fetchImpl(`${creds.url}${DEVICE_NAME_PATH}`, {
                    ...requestInit(creds.token, JSON.stringify({ name })),
                    signal: controller.signal,
                });
                if (response.ok)
                    payload = await readPayload(response);
            }
            finally {
                clearTimeout(timer);
            }
        }
        catch {
            payload = undefined;
        }
        deviceNamePushBusy = false;
        deviceNamePushSeq += 1;
        // T59-fix: judge the answer only if the world stood still — a re-pair to
        // another server (the credential digest moved) or a dropped link makes
        // this answer a fact about a table we may no longer be talking to.
        if (stopped || state !== 'online' || credentialsDigest !== digestAtStart)
            return false;
        const confirmed = isRecord(payload) && payload.ok === true && infoString(payload.name) === name;
        if (!confirmed) {
            pendingDeviceName = name;
            return false;
        }
        // The table took the new name: remember it locally (without a state
        // announcement — nothing but the name moved) and mark it authoritative
        // until the server's own answer says the same.
        if (handshakeInfo !== undefined && handshakeInfo.deviceName !== name) {
            handshakeInfo = { ...handshakeInfo, deviceName: name };
        }
        deviceNameAuthoritative = true;
        pendingDeviceName = undefined;
        return true;
    }
    /** Flush a queued rename against the fresh online state (T59). */
    function flushPendingDeviceName() {
        if (pendingDeviceName === undefined)
            return;
        const name = pendingDeviceName;
        pendingDeviceName = undefined;
        if (handshakeInfo === undefined) {
            pendingDeviceName = name;
            return;
        }
        if (name === (handshakeInfo.deviceName ?? ''))
            return;
        void pushDeviceName(name);
    }
    /**
     * The backend's one entry point (T59): the row's `serverName` was just
     * committed. Online with a handshake, the name travels to the gateway only
     * when it DIFFERS from the server's record — the settings page's
     * server-driven write lands here with both sides equal, which is exactly
     * what keeps the two ends from overwriting each other. Offline (or not yet
     * handshaken), the name queues for the next `online`.
     */
    function queueDeviceName(name) {
        const trimmed = name.trim();
        if (trimmed === '')
            return;
        if (state !== 'online' || handshakeInfo === undefined) {
            pendingDeviceName = trimmed;
            return;
        }
        if (trimmed === (handshakeInfo.deviceName ?? '')) {
            pendingDeviceName = undefined;
            return;
        }
        void pushDeviceName(trimmed);
    }
    /**
     * One QUIET handshake re-run (T59): refreshes the two names while online —
     * no state announcement, no ladder movement, failures silent (the next
     * tick retries; the idle and heartbeat clocks own the link's verdict).
     * The reply carries the gateway's freshest record of BOTH names (its
     * marking headers are written per forward), so this is also how a rename
     * an admin made on the server reaches an otherwise-idle client.
     */
    async function refreshInfo() {
        if (stopped || state !== 'online' || connectInFlight !== undefined)
            return;
        const creds = currentCredentials();
        if (creds === undefined)
            return;
        // T59-fix: remember the world at request time — the answer only counts
        // if we are still the same online client (the credential digest catches
        // a re-pair to another server), and a name push that overlapped the
        // round-trip makes the answer's deviceName a PRE-push record.
        const digestAtStart = credentialsDigest;
        const pushSeqAtStart = deviceNamePushSeq;
        let payload;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
            if (typeof timer.unref === 'function')
                timer.unref();
            try {
                const response = await fetchImpl(`${creds.url}${HANDSHAKE_PATH}`, {
                    ...requestInit(creds.token, '{}'),
                    signal: controller.signal,
                });
                if (!response.ok)
                    return;
                payload = await readPayload(response);
            }
            finally {
                clearTimeout(timer);
            }
        }
        catch {
            return;
        }
        if (stopped || state !== 'online' || credentialsDigest !== digestAtStart)
            return;
        if (!isRecord(payload) || payload.ok !== true || payload.relayProtocol !== RELAY_PROTOCOL)
            return;
        // T59-fix: NAMES ONLY. serverId / dshVersion / fingerprints belong to the
        // real handshake (the compat verdict is computed there, on both maps
        // fresh); a quiet refresh never disturbs them.
        const previous = handshakeInfo;
        if (previous === undefined)
            return;
        const serverName = typeof payload.serverName === 'string' ? payload.serverName : previous.serverName;
        const serverDeviceName = infoString(payload.deviceName);
        // A push that overlapped this round-trip — STARTED before it (the seq
        // moved by the settle), still IN FLIGHT, or still QUEUED — makes the
        // answer's deviceName a pre-push record: dropped, and the local
        // authority stays; the next clean refresh confirms instead.
        const pushedDuringRefresh = deviceNamePushSeq !== pushSeqAtStart || deviceNamePushBusy || pendingDeviceName !== undefined;
        const deviceName = pushedDuringRefresh ? undefined : serverDeviceName;
        if (deviceName !== undefined)
            deviceNameAuthoritative = false;
        let changed = previous.serverName !== serverName;
        if (deviceName !== undefined && deviceName !== previous.deviceName)
            changed = true;
        if (!changed)
            return;
        handshakeInfo = { ...previous, serverName, ...(deviceName !== undefined ? { deviceName } : {}) };
        notify();
    }
    /** Arm one refresh tick; re-arms itself while the client stays online. */
    function armInfoRefresh() {
        const delay = infoRefreshDelay(options);
        if (delay <= 0 || infoTimer !== undefined || stopped)
            return;
        infoTimer = clock.setTimeout(() => {
            infoTimer = undefined;
            void refreshInfo().then(() => {
                if (state === 'online' && !stopped)
                    armInfoRefresh();
            });
        }, delay);
    }
    /** The shared request face of every route. ONLY endpoint headers live
     * here — content-length, host, connection and transfer-encoding are the
     * dispatcher's business and must never be set by hand: DSH's process
     * swaps the global fetch dispatcher for its own undici, which rejects a
     * manual content-length outright (fetch failed / UND_ERR_INVALID_ARG).
     * The JSON body arrives PRE-SERIALIZED: the invoke caller needs the JSON
     * once for its size-based timeout, so every route stringifies exactly
     * one. */
    function requestInit(token, bodyJson) {
        return {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                // Load-bearing (module comment): without it the gateway's pairing
                // wall arrives as HTML and a revocation cannot be classified.
                accept: 'application/json',
            },
            body: bodyJson,
            // A wrong server must not walk the pairing token through a redirect.
            redirect: 'manual',
        };
    }
    /**
     * The binary upload's init (T51): the same endpoint-headers-only
     * discipline as {@link requestInit} — the body rides as the raw byte
     * stream with `content-type: application/octet-stream` (the ONE header
     * the host's upload route mandates, RT dsh-client-file-upload
     * lib/index.js:18) and no content-length: DSH's undici refuses a hand-set
     * length outright, so a stream body goes chunked and the server's
     * streaming byte count is the size gate. `duplex: 'half'` is what a
     * streaming request body requires.
     */
    function uploadInit(token, body) {
        const init = {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/octet-stream',
                accept: 'application/json',
            },
            body,
            redirect: 'manual',
        };
        init.duplex = 'half';
        return init;
    }
    /**
     * Map one non-success response onto the RelayError (and state) contract.
     * Only the two walls move the state — the gateway's unpaired 401 means
     * the token died (`revoked`), the relay-only 403 means the far end is not
     * a 2.0.0 relay server (`incompatible`). The 401 `relay-unauthorized`
     * deliberately does NOT become `revoked`: the gateway ACCEPTED the token
     * and the server's internal secret disagrees — a server-side fault, and
     * unpairing a valid device would be the wrong lesson.
     */
    function failureOf(status, payload) {
        const body = isRecord(payload) ? payload : {};
        const error = isRecord(body.error) ? body.error : {};
        const code = typeof error.code === 'string' && error.code !== '' ? error.code : undefined;
        const message = typeof error.message === 'string' ? error.message : undefined;
        const reason = typeof body.reason === 'string' ? body.reason : undefined;
        if (status === 401) {
            if (reason === 'unpaired') {
                setState('revoked');
                return new RelayError('revoked', 'the pairing token was rejected by the server gateway', 401);
            }
            if (code === 'relay-unauthorized')
                return new RelayError('relay-unauthorized', message, 401);
        }
        if (status === 403) {
            if (reason === 'relay-only') {
                setState('incompatible');
                return new RelayError('incompatible', 'the server refused the relay prefix — it is not running the 2.0.0 relay', 403);
            }
            if (code === 'not-shared' || code === 'no-session' || code === 'forbidden-method') {
                return new RelayError(code, message, 403);
            }
        }
        // 200 {ok:false} envelopes, 400/404/429 answers and anything else
        // unheard-of: the body's error code is the answer, the state is not
        // touched.
        if (code !== undefined)
            return new RelayError(code, message, status);
        // The bad-gateway band carries no relay body of its own — it is what a
        // reverse proxy answers when the gateway behind it is down (nginx: an
        // HTML 502). That IS the offline case, and the e2e contract expects it.
        if (status === 502 || status === 503 || status === 504) {
            noteFailure('offline');
            setState('offline');
            return new RelayError('offline', `the relay chain answered ${status} — the gateway is unreachable`, status);
        }
        return new RelayError(`http-${status}`, `unexpected relay response with status ${status}`, status);
    }
    /**
     * The server-restart stream line (the server App exits cleanly or reloads
     * its plugin row: relay-server.ts's closeAll ends every NDJSON stream with
     * `error{code:'server-restart'}`) is a LINK fact, not an answer about one
     * call — the whole server is going down. Mark the client offline exactly
     * like a transport death would: the reconnect ladder arms, the merged
     * streams' offline annotations apply, and the eventual reconnect runs a
     * fresh handshake that picks up the (possibly changed) server name. The
     * thrown RelayError keeps the specific code for the diagnostics ring.
     */
    function noteServerRestart(error) {
        if (error.code !== 'server-restart')
            return;
        noteFailure('offline');
        setState('offline');
    }
    /** `aborted` — a caller's signal, not a transport fault. */
    function abortedError() {
        return new RelayError('aborted', 'the caller aborted the request');
    }
    /**
     * One request/response exchange (handshake, invoke, upload) with the
     * shared timeout wiring. The URL and the RequestInit arrive PREBUILT —
     * the JSON routes compose theirs from {@link requestInit}, the upload
     * from {@link uploadInit} — so the body shape (serialized string or byte
     * stream) stays the caller's business. Resolves only on a success
     * envelope — 2xx plus `ok:true` — and then lifts a stale `offline` back
     * to `online`, because a success proves the link. EVERY other outcome
     * throws the mapped RelayError; transport failures (fetch rejection,
     * mid-body cut, timeout) set `offline` first — EXCEPT on a route that
     * opted out (`timeoutSetsOffline: false`, the invoke and upload routes):
     * a slow call — a 28 MiB inline-image prompt or a 100 MiB attachment
     * crawling up a slow link — and, since T51-fix, an upload CUT MID-STREAM
     * (a reset under a huge body is the size gate and the drain doing their
     * job, not a dead link) both fail THIS call and leave the connection
     * state exactly where it was; the diagnostics still record the failure
     * code. Only the handshake / stream-header legs and real network-layer
     * failures on the opted-in routes judge the link.
     */
    async function exchangeRequest(url, init, signal, applySuccessState, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
        const timeoutSetsOffline = opts.timeoutSetsOffline ?? true;
        // The transport-failure opt-out (T51-fix) is SEPARATE from the timeout
        // one: the invoke route opts out of the timeout judging the link but
        // keeps real transport deaths offline (the T43 reconnect ladder hangs
        // off them); the upload route opts out of BOTH — a reset under a huge
        // body is the size gate doing its job, not a dead link.
        const transportSetsOffline = opts.transportSetsOffline ?? true;
        const controller = new AbortController();
        const onExternalAbort = () => {
            controller.abort();
        };
        let timedOut = false;
        if (signal !== undefined) {
            if (signal.aborted)
                controller.abort();
            else
                signal.addEventListener('abort', onExternalAbort);
        }
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        if (typeof timer.unref === 'function')
            timer.unref();
        try {
            let response;
            try {
                response = await fetchImpl(url, { ...init, signal: controller.signal });
            }
            catch (error) {
                if (signal?.aborted)
                    throw abortedError();
                if (timedOut && !timeoutSetsOffline) {
                    noteFailure('request-timeout');
                    throw new RelayError('request-timeout', `no response within ${timeoutMs} ms`);
                }
                noteFailure('offline');
                if (transportSetsOffline)
                    setState('offline');
                throw new RelayError('offline', timedOut ? `no response within ${timeoutMs} ms` : messageOf(error));
            }
            let payload;
            try {
                payload = await readPayload(response);
            }
            catch (error) {
                if (signal?.aborted)
                    throw abortedError();
                noteFailure('offline');
                if (transportSetsOffline)
                    setState('offline');
                throw new RelayError('offline', messageOf(error));
            }
            if (response.status >= 200 && response.status < 300 && isRecord(payload) && payload.ok === true) {
                // A success answers the link question: the last failure is superseded.
                lastError = undefined;
                if (applySuccessState)
                    setState('online');
                return payload;
            }
            throw failureOf(response.status, payload);
        }
        finally {
            clearTimeout(timer);
            if (signal !== undefined)
                signal.removeEventListener('abort', onExternalAbort);
        }
    }
    /** The JSON routes' one exchange: path + pre-serialized body over
     * {@link exchangeRequest}. */
    async function exchange(pathName, bodyJson, signal, applySuccessState, creds, opts = {}) {
        return exchangeRequest(`${creds.url}${pathName}`, requestInit(creds.token, bodyJson), signal, applySuccessState, opts);
    }
    function connect() {
        // A connect already running IS the answer (T23a-fix2): a caller that
        // raced one — the status route abandons its wait after 5s while the
        // attempt keeps going — joins the SAME promise instead of stacking a
        // second handshake on the wire. The slot clears the moment the attempt
        // settles, so a later connect is a genuinely fresh one.
        if (connectInFlight !== undefined)
            return connectInFlight;
        const attempt = (async () => {
            // Fail before 'connecting' is announced when nothing is configured —
            // an unpaired client must never look like it is trying.
            const creds = requireCredentials();
            const previous = state;
            setState('connecting');
            let payload;
            try {
                payload = await exchange(HANDSHAKE_PATH, '{}', undefined, false, creds);
            }
            catch (error) {
                // The two walls keep the state the mapping gave them (revoked /
                // incompatible). Every OTHER failure is an answer the contract says
                // must not move the state — but the entry into this attempt already
                // announced 'connecting', and a refusal would leave it stuck there
                // forever, so the entry state is restored instead (T23a-fix). One
                // correction (T23a-fix2): `unpaired` is reserved for "no credentials
                // configured" — this attempt HAD them, so a restored first attempt
                // lands on `offline`, the honest "configured but not reached".
                if (state === 'connecting')
                    setState(previous === 'unpaired' ? 'offline' : previous);
                // Whatever the failure was, its code is the diagnostics answer — even
                // when the restore left the state untouched (e.g. an online verdict
                // surviving an unmapped handshake failure). Server-supplied codes go
                // through the sanitizer first (T43-fix).
                if (error instanceof RelayError)
                    lastError = sanitizeCode(error.code);
                throw error;
            }
            // The protocol gate runs BEFORE the online transition: an incompatible
            // server must end `incompatible`, never flicker through online.
            if (payload.relayProtocol !== RELAY_PROTOCOL) {
                setState('incompatible');
                lastError = 'incompatible';
                throw new RelayError('incompatible', `the server speaks relay protocol ${String(payload.relayProtocol)}, this client speaks ${RELAY_PROTOCOL}`);
            }
            handshakeInfo = {
                relayProtocol: RELAY_PROTOCOL,
                serverId: typeof payload.serverId === 'string' ? payload.serverId : '',
                serverName: typeof payload.serverName === 'string' ? payload.serverName : '',
                dshVersion: typeof payload.dshVersion === 'string' ? payload.dshVersion : '',
                fingerprints: isRecord(payload.fingerprints) ? payload.fingerprints : {},
                // T59: the gateway's record of THIS device's name, when the server
                // speaks the field at all (an older server omits it and the client
                // keeps whatever it had).
                ...(infoString(payload.deviceName) !== undefined ? { deviceName: infoString(payload.deviceName) } : {}),
            };
            // Interface compatibility (T42): compare the handshake's group map
            // against this side's own, right here where both are fresh. A compute
            // failure degrades to "nothing computed" — every group lands in
            // `unavailable`, which the comparison contract keeps away from
            // `different`. The verdict is stored BEFORE the online transition, so
            // every subscriber woken by it reads the getter fresh.
            if (options.computeOwnFingerprints !== undefined) {
                let own = {};
                try {
                    own = (await options.computeOwnFingerprints()) ?? {};
                }
                catch {
                    // Own fingerprints unavailable — the verdict says so, honestly.
                }
                compat = compareFingerprints(handshakeInfo.fingerprints, own);
            }
            // Digest of exactly the credentials this handshake used — never the
            // plaintext values (T23a-fix).
            lastHandshakeDigest = relayCredentialsDigest(creds.url, creds.token);
            setState('online');
            return handshakeInfo;
        })();
        connectInFlight = attempt;
        const clear = () => {
            if (connectInFlight === attempt)
                connectInFlight = undefined;
        };
        attempt.then(clear, clear);
        return attempt;
    }
    /** One immediate attempt, ladder reset to the first step (T43). Only an
     * `offline` client has anything to reconnect. */
    function reconnect() {
        if (stopped || state !== 'offline')
            return false;
        cancelRetry();
        void connect().catch(() => { });
        return true;
    }
    /**
     * The credentials source moved (a pairing write, an unpair, a hand edit
     * committed by the loader): drop any pending wait — the ladder belongs to
     * the OLD credentials — clear the stored compat verdict (it describes the
     * server the OLD credentials pointed at, T23b2-fix3) and dial the new
     * values at once. Nothing configured lands `unpaired`, exactly like a
     * request would. A connect already running joined in with the old values
     * (its getters were read at its start); when it settles, ONE follow-up
     * goes out with the new values — skipped if a still-newer change
     * superseded this one.
     */
    function credentialsChanged() {
        const creds = currentCredentials();
        const digest = creds === undefined ? undefined : relayCredentialsDigest(creds.url, creds.token);
        if (digest === credentialsDigest)
            return;
        credentialsDigest = digest;
        // Same invalidation rule as setState's unpaired/revoked branch: a
        // verdict the current credentials never earned must not stay visible —
        // even when the very next handshake lands online, there is a window
        // between the change and that handshake.
        compat = undefined;
        cancelRetry();
        if (stopped)
            return;
        if (creds === undefined) {
            setState('unpaired');
            return;
        }
        const inFlight = connectInFlight;
        if (inFlight === undefined) {
            void connect().catch(() => { });
            return;
        }
        // The running attempt is the old credentials' dial. Joining it would be
        // a no-op (T23a-fix2 dedupe) AND answer nothing about the new values —
        // the follow-up below is the new dial (T43-fix).
        void inFlight.catch(() => { }).then(() => {
            if (stopped)
                return;
            const latest = currentCredentials();
            if (latest === undefined || relayCredentialsDigest(latest.url, latest.token) !== digest)
                return;
            void connect().catch(() => { });
        });
    }
    function stop() {
        stopped = true;
        cancelRetry();
        if (infoTimer !== undefined) {
            clock.clearTimeout(infoTimer);
            infoTimer = undefined;
        }
    }
    async function invoke(namespace, method, args, signal) {
        const creds = requireCredentials();
        // One serialization, two uses: the body on the wire and the size the
        // round-trip budget scales with. The timeout deliberately does NOT move
        // the connection state — a slow prompt is a slow call, not a dead link.
        const bodyJson = JSON.stringify({ namespace, method, args });
        const payload = await exchange(INVOKE_PATH, bodyJson, signal, true, creds, {
            timeoutMs: invokeTimeoutMs(requestTimeoutMs, bodyJson),
            timeoutSetsOffline: false,
        });
        return payload.value;
    }
    async function postEventResult(eventId, result, signal) {
        const creds = requireCredentials();
        const payload = await exchange(EVENT_RESULT_PATH, JSON.stringify({ eventId, result }), signal, true, creds);
        return payload.value;
    }
    async function unshare(sessionId, signal) {
        const creds = requireCredentials();
        await exchange(UNSHARE_PATH, JSON.stringify({ sessionId }), signal, true, creds);
    }
    async function http(route, query, signal) {
        const creds = requireCredentials();
        const payload = await exchange(HTTP_PATH, JSON.stringify({ route, query }), signal, true, creds);
        const value = payload.value;
        if (!isRecord(value) ||
            typeof value.status !== 'number' ||
            !Number.isSafeInteger(value.status) ||
            typeof value.body !== 'string') {
            throw new RelayError('internal', 'the relay http answer carries no upstream response');
        }
        return {
            status: value.status,
            contentType: typeof value.contentType === 'string' ? value.contentType : undefined,
            body: value.body,
        };
    }
    async function upload(options, signal) {
        const creds = requireCredentials();
        const params = new URLSearchParams();
        params.set('sessionId', options.sessionId);
        if (options.name !== undefined)
            params.set('name', options.name);
        // The empty-body upload still rides a (closed) stream: the wire route
        // always speaks a request body, and a missing one would be a transport
        // error, not the host's own empty-upload business failure.
        const body = options.body ??
            new ReadableStream({
                start: (controller) => {
                    controller.close();
                },
            });
        // The budget scales with the DECLARED size (T31-fix's rule); a timeout
        // deliberately does not move the connection state — a slow upload is a
        // slow call, not a dead link.
        const payload = await exchangeRequest(`${creds.url}${UPLOAD_PATH}?${params.toString()}`, uploadInit(creds.token, body), signal, true, { timeoutMs: sizeBackedTimeoutMs(requestTimeoutMs, options.bytes), timeoutSetsOffline: false, transportSetsOffline: false });
        const value = payload.value;
        if (!isRecord(value) ||
            typeof value.status !== 'number' ||
            !Number.isSafeInteger(value.status) ||
            typeof value.body !== 'string') {
            throw new RelayError('internal', 'the relay upload answer carries no upstream response');
        }
        return {
            status: value.status,
            contentType: typeof value.contentType === 'string' ? value.contentType : undefined,
            body: value.body,
        };
    }
    function openStream(namespace, method, args, signal) {
        // Eager, not generator-lazy: an unconfigured client fails at CALL time,
        // exactly like connect/invoke, instead of hiding the error inside the
        // first next().
        requireCredentials();
        return streamLines(namespace, method, args, signal);
    }
    /**
     * The NDJSON body pump. The request is owned by `controller`, which three
     * things may abort: the caller's signal (→ the iteration ends normally),
     * the idle clock (no line of any kind within `idleTimeoutMs` → offline),
     * and the generator's own exit — `break`, a thrown error line, normal
     * end — which tears the request down so the server's upstream does not
     * keep pumping behind a consumer that left.
     */
    async function* streamLines(namespace, method, args, signal) {
        if (signal?.aborted)
            return;
        // Re-checked: the generator body runs at the first next(), so the
        // credentials may have vanished since openStream validated them.
        const { url, token } = requireCredentials();
        const controller = new AbortController();
        const onExternalAbort = () => {
            controller.abort();
        };
        if (signal !== undefined)
            signal.addEventListener('abort', onExternalAbort);
        let idleFired = false;
        let headersTimedOut = false;
        let idleTimer;
        const armIdle = () => {
            if (idleTimer !== undefined)
                clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                idleFired = true;
                controller.abort();
            }, idleTimeoutMs);
            if (typeof idleTimer.unref === 'function')
                idleTimer.unref();
        };
        const disarmIdle = () => {
            if (idleTimer !== undefined) {
                clearTimeout(idleTimer);
                idleTimer = undefined;
            }
        };
        // Headers get the request timeout; the BODY is governed by the idle
        // clock alone — a healthy stream stays silent for hours. The timer is
        // disarmed the moment the response HEADERS arrive (it is cleared again
        // in the finally for the pre-header failure paths), or it would abort
        // every stream still alive past requestTimeoutMs (T23a-fix).
        const headerTimer = setTimeout(() => {
            headersTimedOut = true;
            controller.abort();
        }, requestTimeoutMs);
        if (typeof headerTimer.unref === 'function')
            headerTimer.unref();
        // Hoisted for the teardown below: even a fetchImpl that ignores the
        // signal must have its response body released (T23a-fix).
        let reader;
        try {
            let response;
            try {
                response = await fetchImpl(`${url}${STREAM_PATH}`, {
                    ...requestInit(token, JSON.stringify({ namespace, method, args })),
                    signal: controller.signal,
                });
            }
            catch (error) {
                if (signal?.aborted)
                    return;
                noteFailure('offline');
                setState('offline');
                throw new RelayError('offline', headersTimedOut ? `no response within ${requestTimeoutMs} ms` : messageOf(error));
            }
            if (!response.ok) {
                // The NDJSON protocol only starts once the stream is allowed — a
                // refusal is the same JSON the invoke route answers, mapped the
                // same way. The header clock keeps guarding this leg: a server that
                // answers 4xx headers but never sends the body must not hang the
                // stream forever (T23a-fix2) — the abort lands here as offline.
                let payload;
                try {
                    payload = await readPayload(response);
                }
                catch (error) {
                    if (signal?.aborted)
                        return;
                    noteFailure('offline');
                    setState('offline');
                    throw new RelayError('offline', messageOf(error));
                }
                throw failureOf(response.status, payload);
            }
            // The 200 itself is a successful response: the link works. Only NOW
            // is the header phase truly over and its clock disarmed.
            clearTimeout(headerTimer);
            setState('online');
            if (response.body === null)
                return;
            armIdle();
            const decoder = new TextDecoder();
            let buffer = '';
            reader = response.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                armIdle(); // bytes arrived — any line content refreshes the clock
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                let idx;
                while ((idx = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 1);
                    const verdict = classifyLine(line);
                    if (verdict.kind === 'frame') {
                        // The idle clock measures TRANSPORT silence, not the consumer's
                        // processing time: it is paused across the yield and re-armed
                        // when the value is pulled.
                        disarmIdle();
                        yield verdict.frame;
                        armIdle();
                    }
                    else if (verdict.kind === 'end') {
                        return;
                    }
                    else if (verdict.kind === 'error') {
                        noteServerRestart(verdict.error);
                        throw verdict.error;
                    }
                    else if (verdict.kind === 'info') {
                        // T59: the heartbeat's names, folded in quietly — a state-sparing
                        // notify wakes the interceptor's rename path without any reconnect.
                        applyInfoDelta(verdict.serverName, verdict.deviceName);
                    }
                }
            }
            // Tolerant tail: a final line without its newline still counts.
            buffer += decoder.decode();
            if (buffer.trim() !== '') {
                const verdict = classifyLine(buffer);
                if (verdict.kind === 'frame') {
                    disarmIdle();
                    yield verdict.frame;
                }
                else if (verdict.kind === 'end') {
                    return;
                }
                else if (verdict.kind === 'error') {
                    noteServerRestart(verdict.error);
                    throw verdict.error;
                }
                else if (verdict.kind === 'info') {
                    applyInfoDelta(verdict.serverName, verdict.deviceName);
                }
            }
        }
        catch (error) {
            if (signal?.aborted)
                return;
            if (error instanceof RelayError)
                throw error;
            // Anything else escaping the body read is the transport dying.
            noteFailure('offline');
            setState('offline');
            throw new RelayError('offline', idleFired ? `no line received for ${idleTimeoutMs} ms` : messageOf(error));
        }
        finally {
            disarmIdle();
            clearTimeout(headerTimer);
            if (signal !== undefined)
                signal.removeEventListener('abort', onExternalAbort);
            // Release the body even if a custom fetchImpl ignored the signal —
            // an in-flight reader keeps the connection's buffers alive. Cancel
            // may reject on an already-dead stream; that is fine.
            if (reader !== undefined)
                reader.cancel().catch(() => { });
            // However we left the body — break, error line, normal end, caller
            // abort — the request itself must not linger: the server aborts its
            // upstream when the socket closes. Aborting a finished request is a
            // no-op.
            controller.abort();
        }
    }
    return {
        get state() {
            return state;
        },
        get handshakeInfo() {
            return handshakeInfo;
        },
        get lastHandshakeDigest() {
            return lastHandshakeDigest;
        },
        get nextRetryAt() {
            return nextRetryAt;
        },
        get lastError() {
            return lastError;
        },
        get compat() {
            return compat;
        },
        get deviceNameSyncing() {
            return deviceNameSyncing();
        },
        subscribe,
        queueDeviceName,
        connect,
        reconnect,
        credentialsChanged,
        stop,
        invoke,
        unshare,
        postEventResult,
        openStream,
        http,
        upload,
    };
}
//# sourceMappingURL=relay-client.js.map