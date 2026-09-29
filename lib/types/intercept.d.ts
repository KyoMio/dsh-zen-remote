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
 *   fields are read, the same decoy discipline the server applies. The
 *   three field-less GLOBAL reads therefore never refuse on their arguments:
 *   a stray id in them is unowned data, they pass through untouched, and
 *   merging their state is T23b-2.
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
 */
import type { RelayClient } from './relay-client.js';
import type { GatewayShapeCheck } from './intercept-shape.js';
/** The session-locating argument fields, as registered per method. Identical
 * in name and meaning to relay-access.ts's `SessionField`. */
export type SessionField = 'request.sessionId' | 'request.address';
/**
 * The client-side half of the server's `RELAY_METHODS` registry: which
 * argument field locates the session for each method. METHODS AND FIELDS
 * MUST stay identical to the server table (test/intercept.test.cjs pins the
 * equality by reading relay-access's table directly) — a method the server
 * does not serve would answer `forbidden-method` forever, and a field the
 * server does not check would strand a virtual id un-rewritten.
 *
 * The three global reads carry no field: nothing in their arguments is
 * session-scoped, so this module never forwards them (merging their state
 * is T23b-2) — a virtual id smuggled into their arguments deep-scans to a
 * refusal, same as any unregistered method.
 */
export declare const CLIENT_METHOD_FIELDS: Readonly<Record<string, readonly SessionField[]>>;
/** `dispatchRpc`'s failure shape as the UI mandates it: dsh-client-connection's
 * server-response parser (`invalid server-response failure`) and the gateway's
 * rpcErrorSchema both demand `code` AND `message` as strings AND `details` as
 * an object — a details-less refusal crashes the client's parser, so every
 * envelope WE construct carries `details: {}` (the host rpcFailure's
 * fallback). */
export type DispatchEnvelope = {
    ok: true;
    value: unknown;
} | {
    ok: false;
    error: {
        code: string;
        message?: string;
        details: Record<string, unknown>;
    };
};
/** One remote-call failure in the diagnostics ring. */
export interface InterceptFailureRecord {
    /** ISO timestamp of the moment the failure was recorded. */
    time: string;
    endpoint: string;
    code: string;
}
/**
 * One INCOMPATIBLE remote call (T42): a forwarded call the SERVER refused
 * because the two DSH versions disagree about the interface — the runtime
 * symptom layer three of the version-tolerance design watches for (see
 * {@link INCOMPATIBLE_CALL_CODES} for exactly which codes qualify). Only
 * that one panel errors; the record feeds the settings page's diagnostics
 * so the mismatch is explainable. `time` is epoch milliseconds — the number
 * form the settings view's failure rows render directly.
 */
export interface IncompatibleCallRecord {
    time: number;
    endpoint: string;
    code: string;
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
export declare const INCOMPATIBLE_CALL_CODES: ReadonlySet<string>;
/** The behavior self-check's verdict (spike §4.1 check 4). */
export type SelfCheckResult = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** What the client status route surfaces about the interception. Contains
 * only shapes, counters and codes — never a token. */
export interface InterceptDiagnostics {
    installed: boolean;
    shape: GatewayShapeCheck;
    /** Set once the wiring's startup self-check ran; undefined while it is
     * still in flight. */
    selfCheck?: SelfCheckResult;
    /** The most recent remote-call failures, oldest first, capped at 20. */
    recentFailures: InterceptFailureRecord[];
    /** The most recent VALIDATION-refused remote calls (T42), oldest first,
     * capped at 50 — the runtime-degradation half of the version-tolerance
     * diagnostics. */
    incompatibleCalls: IncompatibleCallRecord[];
}
export interface InstallInterceptOptions {
    /** The RAW gateway instance (`ctx.typertGateway[symbols.original]`), not
     * the cordis proxy — own properties on the proxy are ignored by everyone. */
    raw: object;
    /** The client relay client (T23a) the calls travel through. */
    relay: RelayClient;
    /** The CURRENT handshake's server id, read live per call; `undefined`
     * (never handshook) makes every remote call a `remote-mismatch`. */
    getServerId: () => string | undefined;
    /** Progress logging, wired to the context logger by index.ts. */
    log?: (format: string, ...args: unknown[]) => void;
}
export interface InterceptHandle {
    /** Remove both own properties, restoring exactly what was installed over
     * (another wrapper's value, or nothing). Idempotent. */
    uninstall(): void;
    /** The status-route view: installed flag, the shape verdict recorded at
     * install time, the self-check verdict, the failure ring. */
    diagnostics(): InterceptDiagnostics;
    /** How many calls entered each wrapper (local passthroughs included) —
     * the behavior self-check's "the wrap was reached" proof. */
    wrappedCalls(): {
        openWireStream: number;
        dispatchRpc: number;
    };
    /** Record the wiring's self-check verdict (and uninstall + log on
     * failure — the wiring owns that decision, this only records). */
    noteSelfCheck(result: SelfCheckResult): void;
}
/** Rewrite one stream frame's session ids to virtual form. */
export declare function rewriteFrame(endpoint: string, frame: unknown, serverId: string): unknown;
/** Rewrite one invoke result's session ids to virtual form. */
export declare function rewriteResult(endpoint: string, value: unknown, serverId: string): unknown;
/**
 * Install the two own-property wrappers on the raw gateway. Assumes
 * {@link checkGatewayShape} passed (the wiring gates on it) — this function
 * records the verdict but does not re-gate, so it stays usable in tests
 * that install over deliberately odd shapes.
 */
export declare function installIntercept(options: InstallInterceptOptions): InterceptHandle;
export interface SelfCheckOptions {
    /** How long the probe may wait for its first frame; default 5000 ms. */
    timeoutMs?: number;
}
/**
 * The startup behavior self-check (spike §4.1 check 4): open the one stream
 * the shape check cannot prove — that the wrap is actually REACHED — through
 * `wireStream.open('workspace/follow', …)` and demand a `baseline` first
 * frame whose `value.items` is an array (the real workspace baseline's
 * shape). The caller decides what "the wrap was reached" means by comparing
 * `wrappedCalls()` before/after — {@link runSelfCheck} owns that policy.
 */
export declare function behaviorSelfCheck(raw: object, options?: SelfCheckOptions): Promise<SelfCheckResult>;
export interface RunSelfCheckOptions {
    /** The handle whose self-check verdict, uninstall and call counters are
     * driven. */
    handle: Pick<InterceptHandle, 'noteSelfCheck' | 'uninstall' | 'wrappedCalls'>;
    /** How long to wait before the single retry; default 3000 ms. */
    retryDelayMs?: number;
    /** Failure logging, wired to the context logger by index.ts. */
    log?: (format: string, ...args: unknown[]) => void;
}
/**
 * Run the behavior self-check with the wiring's failure policy: ONE retry
 * after a pause (a transiently unready upstream must not cost the whole
 * interception), and only a second failure uninstalls and records. "The
 * wrap was reached" is a COUNTER DELTA, not an absolute count: the UI or
 * another plugin may open streams of its own while the probe waits for its
 * first frame, so the check demands at least one wrapper entry above the
 * pre-probe baseline, never exactly one.
 */
export declare function runSelfCheck(raw: object, options: RunSelfCheckOptions): Promise<SelfCheckResult>;
//# sourceMappingURL=intercept.d.ts.map