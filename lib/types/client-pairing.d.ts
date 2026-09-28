/**
 * Pure pairing/probe logic for the sub-client half (T16): the address
 * normalizer the claim route validates user input with, and the two
 * classifiers that turn one HTTP round-trip each into a shape the settings
 * block can render. No I/O, no clocks, no process reads — the route module
 * owns the sockets and the timeouts, this module owns the decisions.
 *
 * IPv4/IPv6 range checks are hand-rolled because the address arrives as a
 * STRING inside an already-parsed URL and the point is to keep the private-
 * network allowance of `normalizeServerUrl` exactly as narrow as specified
 * (172.16/12, 100.64/10 etc. — off-by-one range bugs here would either lock
 * LAN users out or open plain-http pairing to the public internet).
 */
/** The gateway claim endpoint, resolved against the normalized server URL. */
export declare const CLAIM_PATH = "/lan-gate/pair/claim-desktop";
/** The relay ping path the client backend probes (the gateway admits this
 * prefix for desktop-client devices and forwards to the host relay route). */
export declare const RELAY_PING_PATH = "/_dsh/zen-remote/relay/ping";
/** Why an address did not normalize: unparseable / wrong shape, or a plain
 * `http:` URL whose host is not one of the private-network allowances. */
export type NormalizeFailure = 'invalid' | 'insecure-http';
export type NormalizeResult = {
    ok: true;
    url: string;
} | {
    ok: false;
    reason: NormalizeFailure;
};
/**
 * Normalize one user-typed server address to the exact string the client
 * stores and probes: surrounding whitespace and trailing slashes gone, no
 * path (beyond `/`), no query, no fragment, no embedded credentials, and a
 * scheme of `http:` (private hosts only) or `https:` (always).
 */
export declare function normalizeServerUrl(input: string): NormalizeResult;
/** The gateway claim reply, exactly as lib/lan-gate-server.cjs answers
 * `/lan-gate/pair/claim-desktop` for a desktop client. */
export interface ClaimSuccessBody {
    ok: true;
    id?: unknown;
    name?: unknown;
    token?: unknown;
}
/** What the claim route forwards to the browser (and what it maps every
 * gateway refusal to). `message` rides through for role-mismatch — the
 * gateway's copy is localized server-side and meant to be shown as-is. */
export type ClaimOutcome = {
    ok: true;
    token: string;
    deviceId: string;
    deviceName: string;
} | {
    ok: false;
    code: 'role-mismatch';
    message?: string;
} | {
    ok: false;
    code: 'bad-code';
} | {
    ok: false;
    code: 'locked';
    retryAfterMs: number;
} | {
    ok: false;
    code: 'unexpected';
};
/**
 * Classify one claim round-trip. `body` may be anything the server returned
 * (including unparsable garbage — the route passes `undefined` then): only
 * the exact happy shape counts as success, everything else lands in the four
 * refusal buckets the settings block has copy for.
 */
export declare function classifyClaimResponse(status: number, body: unknown): ClaimOutcome;
/** One probe round-trip handed to {@link classifyProbe}: either the transport
 * failed before any HTTP answer existed (refused, reset, timeout) or a
 * response arrived with its status and best-effort parsed body. */
export type ProbeResult = {
    kind: 'error';
} | {
    kind: 'response';
    status: number;
    body: unknown;
};
/** The connection states the settings block renders. */
export type ProbeState = 'unreachable' | 'revoked' | 'unexpected' | 'connected';
/**
 * Classify one probe of `<serverUrl>${RELAY_PING_PATH}`:
 *
 * - no HTTP answer at all → `unreachable` (down, wrong address, timeout);
 * - 401 → `revoked` — the gateway treats an invalid or revoked desktop-client
 *   token as unpaired and answers its 401 wall;
 * - 403 with `reason: 'relay-only'` → `unexpected`: the token was ACCEPTED
 *   but the server refuses the relay prefix — only possible when the server
 *   is not running the 2.0.0 gateway;
 * - any other status (200 ping ok, 404 from a pre-relay server, even 3xx)
 *   means the gateway accepted the token → `connected`.
 */
export declare function classifyProbe(result: ProbeResult): ProbeState;
//# sourceMappingURL=client-pairing.d.ts.map