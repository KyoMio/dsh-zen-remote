/**
 * Pure access control for the relay invoke and stream routes (2.0.0
 * desktop-client).
 *
 * PER-METHOD ALLOWLIST, not a generic id scan. The first draft extracted
 * whatever session ids it could find in `args.request` and checked those —
 * which a hostile client defeats with a DECOY: DSH's gateway validates only
 * the top-level argument names (`assertExactArguments`) and zod silently
 * strips unknown fields inside `request`, so padding the arguments with an
 * extra shared `sessionId` gets through the share-table check while the
 * method's REAL ownership field (`agentId`, `request.parentSessionId`, …)
 * goes unchecked. The fix: every invokable method is registered below with
 * EXACTLY the fields that locate its session, authorization looks at those
 * fields and nothing else, and any method not in the table is refused
 * (`forbidden-method`) before an id is ever read. The stream route
 * ({@link decideStream}) reads the SAME table: only `stream: true` entries
 * may ride it, and the field rules are identical.
 *
 * Field verification (T22a-fix, against the 0.2.0-rc.1 wire inventory in the
 * review's keys.txt and the local `typert.remote-client.js` — the spike
 * proved those files byte-identical across 0.1.7/0.2.0, docs/spike-relay.md
 * §2.3):
 *
 * - `request.address` exists only on `session/follow` and `session/page`;
 *   its zod schema is a union of EXACTLY two shapes —
 *   `{kind:'session', sessionId}` and `{kind:'subagent', parentSessionId,
 *   childSessionId, mode}` — and DSH's `validateAddress` re-checks that the
 *   child belongs to the parent, so judging a subagent call by the parent id
 *   is authoritative. Any other kind, or a missing id, is a refusal.
 * - every other registered method carries `request.sessionId`.
 *
 * Pure functions: no I/O, no clock, the share-table lookup is injected.
 */
/** Which standing filter the caller must apply to a global stream's frames
 * (`src/relay-filter.ts` owns both implementations; the `$zr/events`
 * forwarding subscription is filtered by relay-server.ts itself — it needs
 * the per-eventId registry, not a pure frame function). */
export type StreamFilter = 'workspace' | 'control';
/** Which standing filter the caller must apply to an invoke result before it
 * travels (currently only the unscoped `session/list`). */
export type InvokeFilter = 'session-list';
/** One invoke decision: allow (optionally through a standing result filter),
 * or the reason that goes into the 403 body. */
export type InvokeDenyReason = 'no-session' | 'not-shared' | 'forbidden-method';
export type InvokeDecision = {
    allow: true;
    filter?: InvokeFilter;
} | {
    allow: false;
    reason: InvokeDenyReason;
};
/** One stream decision: allow (global streams carry a `streamFilter`, scoped
 * streams list the session ids the subscription depends on — the relay kills
 * the stream and counts viewers with them, and the event subscription sets
 * `events`), or the 403 reason. */
export type StreamDecision = {
    allow: true;
    filter?: StreamFilter;
    sessionIds: string[];
    events?: true;
} | {
    allow: false;
    reason: InvokeDenyReason;
};
/**
 * Decide one relayed invoke against the per-method allowlist:
 *
 * 1. the method must be registered AND invoke-delivered (a `stream: true`
 *    entry refuses the invoke route) — anything else is `forbidden-method`;
 * 2. its registered fields must all yield an owned session id — else
 *    `no-session`;
 * 3. every claimed id must pass `isAccessible` — one unreachable id refuses
 *    the whole call (`not-shared`): an unshared session must not become
 *    readable through a shared one riding in the same arguments.
 *
 * A method registered with `resultFilter` allows with that marker attached;
 * the caller filters the result before it travels (never the reverse — the
 * filter is an OUTPUT discipline, the access check above stays input-only).
 */
export declare function decideInvoke(namespace: string, method: string, args: unknown, isAccessible: (sessionId: string) => boolean): InvokeDecision;
/**
 * Decide one relayed STREAM subscription against the same table:
 *
 * 1. the method must be registered AND stream-delivered — an invoke-only
 *    method riding the stream route is `forbidden-method`, exactly like a
 *    stream method riding the invoke route;
 * 2. a global entry (`streamFilter` set) allows unconditionally — its frames
 *    are filtered per frame, so there is nothing to check up front;
 * 3. any other entry follows the {@link decideInvoke} field rules verbatim:
 *    all registered fields must yield owned ids and every id must be
 *    accessible, and the claimed ids ride back to the caller, which kills the
 *    subscription when one of them stops being shared.
 */
export declare function decideStream(namespace: string, method: string, args: unknown, isAccessible: (sessionId: string) => boolean): StreamDecision;
/**
 * The `$events/result` answer body (T32), as the client sends it:
 * `{ eventId, result }`. `result` is the Remote event OUTCOME and travels
 * VERBATIM — dsh-api-gateway's `parseRemoteEventResult` is the validator
 * (exactly `{clientId,eventId,outcome}` up there; kinds `next` / `result`
 * with optional JSON `value` / `rejected` with `{name,message,code?,details?}`),
 * and a malformed one comes back as the gateway's own 200 error envelope, so
 * re-validating here would only invent a second dialect for the same refusal.
 * `eventId` ownership (forwarded on a live subscription, session still
 * reachable) is the ROUTE's check — it needs the handler's registry.
 */
export interface EventResultBody {
    eventId: string;
    result: Record<string, unknown>;
}
export declare function parseEventResultBody(body: unknown): EventResultBody | undefined;
//# sourceMappingURL=relay-access.d.ts.map