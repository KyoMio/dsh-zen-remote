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
}
/**
 * One relay failure. `code` is the mapped reason (the contract's state
 * vocabulary, a server refusal like `not-shared`, or a DSH error code from
 * a 200 `{ok:false}` envelope); `status` carries the HTTP status when a
 * response existed. Fields are assigned in the constructor body rather than
 * declared as parameter properties: Node's strip-only type mode rejects
 * that syntax (the same rule as UploadError in index.ts).
 */
export declare class RelayError extends Error {
    code: string;
    status?: number;
    constructor(code: string, message?: string, httpStatus?: number);
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
    /** Observe state changes; a throwing listener never blocks the others. */
    subscribe(listener: (state: RelayState) => void): () => void;
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
}
/**
 * The credential digest recorded beside a completed handshake (T23a-fix):
 * sha256 over `url + "\n" + token`, first 16 hex chars. Enough to detect a
 * changed address or a re-pair, without keeping — or ever exposing — a
 * plaintext copy of either value.
 */
export declare function relayCredentialsDigest(serverUrl: string, token: string): string;
/**
 * Build one relay client. Pure state machine + fetch plumbing; the row is
 * only ever seen through the two getters.
 */
export declare function createRelayClient(options: CreateRelayClientOptions): RelayClient;
//# sourceMappingURL=relay-client.d.ts.map