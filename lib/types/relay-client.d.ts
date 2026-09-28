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
    /** Observe state changes; a throwing listener never blocks the others. */
    subscribe(listener: (state: RelayState) => void): () => void;
    /** Run the handshake; success resolves with it and leaves `online`. */
    connect(): Promise<RelayHandshake>;
    /** One invoke round-trip; resolves with the unwrapped `value`, throws
     * RelayError otherwise. A caller abort surfaces as `RelayError('aborted')`. */
    invoke(namespace: string, method: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
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