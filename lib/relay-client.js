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
 */
import { createHash } from 'node:crypto';
/** The one protocol version this client speaks; the handshake verifies it. */
const RELAY_PROTOCOL = 1;
const HANDSHAKE_PATH = '/_dsh/zen-remote/relay/v1/handshake';
const INVOKE_PATH = '/_dsh/zen-remote/relay/v1/invoke';
const STREAM_PATH = '/_dsh/zen-remote/relay/v1/stream';
/** How long a stream may stay line-silent before it is judged dead. */
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
/** How long one request/response round-trip may take in full. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/**
 * One relay failure. `code` is the mapped reason (the contract's state
 * vocabulary, a server refusal like `not-shared`, or a DSH error code from
 * a 200 `{ok:false}` envelope); `status` carries the HTTP status when a
 * response existed. Fields are assigned in the constructor body rather than
 * declared as parameter properties: Node's strip-only type mode rejects
 * that syntax (the same rule as UploadError in index.ts).
 */
export class RelayError extends Error {
    code;
    status;
    constructor(code, message, httpStatus) {
        super(message === undefined ? code : message);
        this.name = 'RelayError';
        this.code = code;
        if (httpStatus !== undefined)
            this.status = httpStatus;
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
        return { kind: 'error', error: new RelayError(code, message) };
    }
    // `ping` and any shape the protocol does not define — ignored.
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
    let state = 'unpaired';
    let handshakeInfo;
    let lastHandshakeDigest;
    let connectInFlight;
    const listeners = new Set();
    function setState(next) {
        if (state === next)
            return;
        state = next;
        for (const listener of [...listeners]) {
            try {
                listener(next);
            }
            catch {
                // One broken listener never blocks the rest.
            }
        }
    }
    function subscribe(listener) {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }
    /**
     * The live credentials, or the unpaired failure. Never a request without
     * both halves — and the unpaired state is (re)announced, so a row whose
     * address or token was cleared later shows up as unpaired too.
     */
    function requireCredentials() {
        const url = options.getServerUrl();
        const token = options.getToken();
        if (url === undefined || url.trim() === '' || token === undefined || token === '') {
            setState('unpaired');
            throw new RelayError('unpaired', 'no server address or pairing token is configured');
        }
        // The getter contract delivers a normalized address; stripping stray
        // trailing slashes anyway keeps a hand-edited row from silently producing
        // `…/relay//v1/…`, which no route would ever match.
        return { url: url.trim().replace(/\/+$/u, ''), token };
    }
    /** The shared request face of every route. ONLY endpoint headers live
     * here — content-length, host, connection and transfer-encoding are the
     * dispatcher's business and must never be set by hand: DSH's process
     * swaps the global fetch dispatcher for its own undici, which rejects a
     * manual content-length outright (fetch failed / UND_ERR_INVALID_ARG). */
    function requestInit(token, body) {
        return {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                // Load-bearing (module comment): without it the gateway's pairing
                // wall arrives as HTML and a revocation cannot be classified.
                accept: 'application/json',
            },
            body: JSON.stringify(body),
            // A wrong server must not walk the pairing token through a redirect.
            redirect: 'manual',
        };
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
            setState('offline');
            return new RelayError('offline', `the relay chain answered ${status} — the gateway is unreachable`, status);
        }
        return new RelayError(`http-${status}`, `unexpected relay response with status ${status}`, status);
    }
    /** `aborted` — a caller's signal, not a transport fault. */
    function abortedError() {
        return new RelayError('aborted', 'the caller aborted the request');
    }
    /**
     * One request/response exchange (handshake, invoke) with the shared
     * timeout wiring. The CALLER resolves the credentials first and passes
     * them in — connect() must know exactly which address+token its handshake
     * used, for the digest it records. Resolves only on a success envelope —
     * 2xx plus `ok:true` — and then lifts a stale `offline` back to `online`,
     * because a success proves the link. EVERY other outcome throws the
     * mapped RelayError; transport failures (fetch rejection, mid-body cut,
     * timeout) set `offline` first.
     */
    async function exchange(pathName, body, signal, applySuccessState, creds) {
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
        }, requestTimeoutMs);
        if (typeof timer.unref === 'function')
            timer.unref();
        try {
            const url = creds.url;
            const token = creds.token;
            let response;
            try {
                response = await fetchImpl(`${url}${pathName}`, { ...requestInit(token, body), signal: controller.signal });
            }
            catch (error) {
                if (signal?.aborted)
                    throw abortedError();
                setState('offline');
                throw new RelayError('offline', timedOut ? `no response within ${requestTimeoutMs} ms` : messageOf(error));
            }
            let payload;
            try {
                payload = await readPayload(response);
            }
            catch (error) {
                if (signal?.aborted)
                    throw abortedError();
                setState('offline');
                throw new RelayError('offline', messageOf(error));
            }
            if (response.status >= 200 && response.status < 300 && isRecord(payload) && payload.ok === true) {
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
                payload = await exchange(HANDSHAKE_PATH, {}, undefined, false, creds);
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
                throw error;
            }
            // The protocol gate runs BEFORE the online transition: an incompatible
            // server must end `incompatible`, never flicker through online.
            if (payload.relayProtocol !== RELAY_PROTOCOL) {
                setState('incompatible');
                throw new RelayError('incompatible', `the server speaks relay protocol ${String(payload.relayProtocol)}, this client speaks ${RELAY_PROTOCOL}`);
            }
            handshakeInfo = {
                relayProtocol: RELAY_PROTOCOL,
                serverId: typeof payload.serverId === 'string' ? payload.serverId : '',
                serverName: typeof payload.serverName === 'string' ? payload.serverName : '',
                dshVersion: typeof payload.dshVersion === 'string' ? payload.dshVersion : '',
                fingerprints: isRecord(payload.fingerprints) ? payload.fingerprints : {},
            };
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
    async function invoke(namespace, method, args, signal) {
        const creds = requireCredentials();
        const payload = await exchange(INVOKE_PATH, { namespace, method, args }, signal, true, creds);
        return payload.value;
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
                    ...requestInit(token, { namespace, method, args }),
                    signal: controller.signal,
                });
            }
            catch (error) {
                if (signal?.aborted)
                    return;
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
                        throw verdict.error;
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
                    throw verdict.error;
                }
            }
        }
        catch (error) {
            if (signal?.aborted)
                return;
            if (error instanceof RelayError)
                throw error;
            // Anything else escaping the body read is the transport dying.
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
        subscribe,
        connect,
        invoke,
        openStream,
    };
}
//# sourceMappingURL=relay-client.js.map