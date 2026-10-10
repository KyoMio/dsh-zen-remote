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
import type { RelayCompatVerdict } from './fingerprint.js';
/**
 * The clock face the reconnect machinery runs on: wall time, timers and the
 * jitter source. Injectable so tests drive the whole backoff sequence
 * deterministically. The default timers are `unref()`ed — a pending retry
 * must never keep the host process alive on its own.
 */
export interface RelayClock {
    /** Epoch milliseconds. */
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    /** One random sample in [0, 1] — the jitter source. */
    random(): number;
}
/**
 * The default clock: real time, `unref()`ed timers, `Math.random`. Exported
 * so the interceptor's own waits (the merged-stream reopen delays) run on
 * the SAME clock face — one injectable seam for tests instead of two.
 */
export declare const defaultClock: RelayClock;
/** The connection states the settings surface renders (and `subscribe`
 * listeners react to). */
export type RelayState = 'unpaired' | 'connecting' | 'online' | 'offline' | 'revoked' | 'incompatible';
/** The handshake reply, verbatim from `POST relay/v1/handshake`. */
export interface RelayHandshake {
    relayProtocol: number;
    serverId: string;
    serverName: string;
    dshVersion: string;
    fingerprints: Record<string, string>;
    /**
     * The SERVER's record of THIS device's name (T59) — what the pairing
     * registered and renames have since made of it. `undefined` from an older
     * server that does not send the field; the client then keeps whatever it
     * has and pushes nothing.
     */
    deviceName?: string;
}
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
export declare class RelayError extends Error {
    code: string;
    status?: number;
    reason?: string;
    /** The host error's sanitized `details` (invoke path): the UI maps
     *  `details.reason` codes like `MODEL_DOES_NOT_SUPPORT_IMAGES` onto a
     *  user-facing line — absent details stay undefined. */
    details?: Record<string, unknown>;
    constructor(code: string, message?: string, httpStatus?: number, reason?: string, details?: Record<string, unknown>);
}
export interface CreateRelayClientOptions {
    /** The normalized server address (no trailing slash), read live per
     * request; `undefined` counts as unpaired. */
    getServerUrl: () => string | undefined;
    /** The pairing token, read live per request; `undefined` counts as
     * unpaired. */
    getToken: () => string | undefined;
    /** Outbound fetch, defaulting to the global one. */
    fetchImpl?: typeof fetch;
    /** How long a stream may go without receiving ANY line (frames and
     * `ping`s alike) before it is judged dead and aborted; default 45000. */
    idleTimeoutMs?: number;
    /** How long one request/response round-trip (handshake, invoke — and the
     * headers of a stream open) may take; default 15000. */
    requestTimeoutMs?: number;
    /** Clock/timers/jitter for the reconnect backoff; defaults to the real
     * ones (timers `unref()`ed). Tests inject a manual clock. */
    clock?: RelayClock;
    /**
     * How often an ONLINE client re-runs the handshake to refresh the two
     * names (T59, {@link INFO_REFRESH_MS}); `0` disables the periodic refresh
     * — handshake-counting tests inject 0, the refresh test injects a cadence
     * its fake clock can drive.
     */
    infoRefreshMs?: number;
    /** This side's own interface fingerprints (T42), computed after each
     * completed handshake and compared group by group against the handshake's
     * map. May be sync or async; a throw counts as "nothing computed" (an
     * empty map — every group lands `unavailable`). Absent: `compat` stays
     * undefined and no comparison ever runs (the host role's client, tests). */
    computeOwnFingerprints?: () => Promise<Record<string, string>> | Record<string, string>;
}
export interface RelayClient {
    readonly state: RelayState;
    /** The last completed handshake, undefined until one succeeds. */
    readonly handshakeInfo: RelayHandshake | undefined;
    /** Digest ({@link relayCredentialsDigest}) of the address+token the last
     * completed handshake actually used, undefined until one succeeds. The
     * status route compares it against the CURRENT row credentials to keep a
     * cached "online" verdict from outliving the credentials it was earned
     * with. */
    readonly lastHandshakeDigest: string | undefined;
    /** Epoch ms of the next automatic reconnect, or null while none is
     * scheduled (connected, attempting, or in a state that never reconnects).
     * Rendered by the settings page as "离线，将于 N 秒后重试". */
    readonly nextRetryAt: number | null;
    /** The error CODE of the most recent failure ('offline',
     * 'relay-unauthorized', a DSH code, …) — never a message, never a token or
     * URL. Cleared when a request succeeds again. */
    readonly lastError: string | undefined;
    /** The interface-compatibility verdict of the most recent handshake (T42):
     * group names that matched, differed, or could not be compared. Undefined
     * until a first handshake ran WITH `computeOwnFingerprints` wired, and
     * cleared again whenever the link or the credentials move (unpaired,
     * revoked, credentialsChanged) — it describes the credentials it was
     * earned with, never the current ones. */
    readonly compat: RelayCompatVerdict | undefined;
    /** Observe state changes; a throwing listener never blocks the others.
     * The CURRENT state is also broadcast when only the handshake identity
     * moved (the T59 heartbeat names) — listeners re-read the getters. */
    subscribe(listener: (state: RelayState) => void): () => void;
    /** The row's `serverName` was just committed (T59): forward it to the
     * gateway's device table when it differs from the server's record —
     * immediately while online, queued for the next `online` otherwise. A
     * name equal to the server's record is a no-op BY CONTRACT: that is the
     * settings page's server-driven write echoing back, and pushing it would
     * set the two ends overwriting each other. */
    queueDeviceName(name: string): void;
    /** Whether a locally-pushed rename is queued or in flight (T59-fix). The
     * status route answers an EMPTY `deviceName` while this is true — an
     * in-flight answer could still carry the pre-push record, and the page
     * following it would bounce the fresh save back to the old name. */
    readonly deviceNameSyncing: boolean;
    /** Run the handshake; success resolves with it and leaves `online`. */
    connect(): Promise<RelayHandshake>;
    /** One immediate connection attempt from `offline`, resetting the backoff
     * ladder (the settings page's 立即重连). Answers whether an attempt was
     * started — the reconnect route turns a false into a 409. */
    reconnect(): boolean;
    /** Notify that the credentials source may have changed (the loader's
     * volatile-update for the row): a pending reconnect wait is cancelled and,
     * with credentials present, one immediate attempt runs with the new
     * values; without them the client lands `unpaired`. */
    credentialsChanged(): void;
    /** Stop the automatic reconnect machinery (plugin row teardown). Explicit
     * connect() calls still work, but no timer is armed again. */
    stop(): void;
    /** One invoke round-trip; resolves with the unwrapped `value`, throws
     * RelayError otherwise. A caller abort surfaces as `RelayError('aborted')`. */
    invoke(namespace: string, method: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
    /** Close one session's remote access on the SERVER (T34): the original
     * (non-virtual) session id rides `POST relay/v1/unshare`, the server
     * unshares it with reason `'client'`. Resolves on the success envelope;
     * every refusal (`not-shared`, a wall, transport death) throws RelayError.
     * A success proves the link and lifts a stale `offline` back to `online`,
     * exactly like invoke. */
    unshare(sessionId: string, signal?: AbortSignal): Promise<void>;
    /** Answer one forwarded Remote event (T32): `eventId` is the ORIGINAL id
     * (the interceptor swapped the virtual one back), `result` the Remote
     * event OUTCOME, forwarded verbatim — the gateway validates it. The error
     * mapping is invoke's: a success envelope resolves (with the value, in
     * practice undefined), everything else throws RelayError. */
    postEventResult(eventId: string, result: unknown, signal?: AbortSignal): Promise<unknown>;
    /** Open the NDJSON stream route. `frame` lines are yielded, `ping` lines
     * only refresh the idle clock, `end` finishes the iteration, an `error`
     * line throws its RelayError. A caller abort ENDS the iteration normally;
     * `break` aborts the underlying request. */
    openStream(namespace: string, method: string, args: unknown, signal?: AbortSignal): AsyncIterable<unknown>;
    /** One plain-HTTP round-trip (T41b): `route` / `query` name a registered
     * `/api` GET (relay-access's RELAY_HTTP_ROUTES; `query` is the URL-encoded
     * query string with the session id already restored). Resolves with the
     * UPSTREAM answer — its status, content type and body text ride inside the
     * success envelope, so a 404 from the underlying route is a RESOLVED
     * result here, never a RelayError. */
    http(route: string, query: string, signal?: AbortSignal): Promise<RelayHttpResult>;
    /** One binary upload round-trip (T51): `sessionId` is the ORIGINAL
     * session id, `name` the optional display filename, `body` the raw byte
     * stream forwarded verbatim. The upstream answer (its status, content
     * type and body text — the host route answers its business failures as
     * 200-with-envelope, so those ride RESOLVED like `http`'s) comes back in
     * the success envelope; every refusal or link death throws RelayError.
     * The round-trip budget scales with `bytes` (the local request's declared
     * `Content-Length`, when it had one) and a timeout there never moves the
     * connection state — the invoke route's rules (T31-fix). */
    upload(options: RelayUploadOptions, signal?: AbortSignal): Promise<RelayHttpResult>;
}
/** The inputs of one {@link RelayClient.upload} round-trip. */
export interface RelayUploadOptions {
    /** The ORIGINAL (non-virtual) session id, already restored by the caller. */
    sessionId: string;
    /** The file's display name, when the local request carried one. */
    name?: string;
    /** The raw request body. `null` (a bodyless upload — the host route would
     * answer its own empty-stream business failure) forwards as an empty
     * stream. */
    body: ReadableStream<Uint8Array> | null;
    /** The local request's declared byte count, when its `Content-Length` was
     * readable — sizes the round-trip budget and nothing else. */
    bytes?: number;
}
/** The upstream answer one {@link RelayClient.http} round-trip carries. */
export interface RelayHttpResult {
    /** The underlying `/api` route's HTTP status. */
    status: number;
    /** The underlying response's content type, when it sent one. */
    contentType: string | undefined;
    /** The underlying response body, decoded as text (both registered routes
     * answer buffered JSON). */
    body: string;
}
/**
 * The credential digest recorded beside a completed handshake (T23a-fix):
 * sha256 over `url + "\n" + token`, first 16 hex chars. Enough to detect a
 * changed address or a re-pair, without keeping — or ever exposing — a
 * plaintext copy of either value.
 */
export declare function relayCredentialsDigest(serverUrl: string, token: string): string;
/**
 * Whether the loader's `loader/volatile-update` announcement names the
 * device's own field (T59-fix): the announcement rides EVERY volatile
 * commit — an unrelated knob, or the settings page's own follow write — and
 * only a commit that actually moved `serverName` may queue a push. The
 * paths are the loader's changed-field lists (`[['serverName'], …]`).
 */
export declare function volatileUpdateTouchesServerName(paths: unknown): boolean;
/**
 * Build one relay client. Pure state machine + fetch plumbing; the row is
 * only ever seen through the two getters.
 */
export declare function createRelayClient(options: CreateRelayClientOptions): RelayClient;
//# sourceMappingURL=relay-client.d.ts.map