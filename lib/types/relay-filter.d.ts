/**
 * Pure wire-frame filters for the relay's streaming subscriptions (T22b).
 *
 * Two of DSH's subscriptions are GLOBAL — `workspace/follow` and
 * `session/control` carry every workspace and every session of the server,
 * while a paired desktop client may only see shared ones. Frames are filtered
 * HERE, one frame at a time, right before they are written to the client; the
 * upstream subscription stays unfiltered, which is what lets a later
 * share/unshare re-filter already-known state without re-reading anything.
 *
 * Frame shapes mirror the generated codecs in the 0.2.0
 * `lib/typert.remote-client.js` of `@deepseek-ai/dsh-api-workspace-controller`
 * / `-session-controller` / `-job-controller` (verified against the local
 * copies, docs/spike-relay.md §3): `baseline` is the only frame that nests its
 * payload under `value`; every increment frame carries its fields at the TOP
 * level (`{type:'upsert', workspace}`, `{type:'archived',
 * archivedSessionIds}`, …). A frame that does not match a known type is
 * dropped (null) rather than forwarded — an unrecognized frame is either a
 * future protocol or a hostile inject, and neither may reach the client.
 *
 * All functions are pure: the input is never mutated, filtered frames come
 * back as new objects, passthrough frames (`remove` / `order`, accessible
 * `projection`) come back unchanged.
 */
/** The accessibility oracle: true when a session may travel to this client. */
export type Accessibility = (sessionId: string) => boolean;
/**
 * Filter one `workspace/follow` frame. `baseline` and `upsert` keep every
 * workspace but narrow each `sessionIds`; `archived` / `pinned` narrow their
 * lists; `remove` / `order` carry no session ids and pass through unchanged;
 * anything else is dropped.
 */
export declare function filterWorkspaceFrame(frame: unknown, isAccessible: Accessibility): Record<string, unknown> | null;
/**
 * Filter one `session/control` frame. Exactly two frame types exist:
 * `baseline{value:{projections: Record<sessionId, {asOfSeq, values}>}}` — the
 * per-session map keeps only accessible keys — and `projection{sessionId, key,
 * value, seq}` — kept whole or dropped by its session id. Anything else is
 * dropped.
 *
 * The baseline record is rebuilt with `defineProperty` because a session id of
 * `__proto__` must become an own data property of the new record, not fire the
 * prototype setter (the same trap share-store.ts documents for its file keys).
 */
export declare function filterControlFrame(frame: unknown, isAccessible: Accessibility): Record<string, unknown> | null;
/**
 * Filter one `session/list` result (the invoke route forwards it as the
 * enveloped value): `items` keeps only entries whose `sessionId` is
 * accessible, every other field of the result (and of each kept item) passes
 * through as-is — except a `parentSessionId` naming a session the share table
 * cannot reach (CP4): that field is dropped while the row stays, so the id of
 * a hidden session never travels, not even as a dangling parent link. The
 * result arrives from the same JSON boundary as the frames but it is a
 * RESULT, not a frame — there is no unknown-shape refusal here; a result
 * without an `items` array simply has nothing to filter.
 */
export declare function filterSessionListResult(result: unknown, isAccessible: Accessibility): unknown;
/**
 * Scrub one `session/modelCatalog` result (T52-fix): the `failures` array is
 * emptied in place-shaped fashion — the whole result otherwise passes through
 * — because a provider group's failure text is the HOST's own error for that
 * group (adapter names, endpoint URLs, credential states; RT
 * dsh-api-session-controller `lib/index.js` builds `failures` from each
 * adapter's load error). The sub-client discards `failures` anyway
 * (intercept.ts mergeModelCatalogs keeps the LOCAL failures only), so
 * forwarding the server's texts would spend real detail for nothing a client
 * can show. The result arrives from the same JSON boundary as the frames; a
 * result without a recognizable shape passes untouched (the merge on the far
 * side re-guards it).
 */
export declare function filterModelCatalogResult(value: unknown): unknown;
/**
 * Filter one `job/list` frame (`{type:'rows', jobs:[…]}` — the only frame type
 * the stream emits). DSH opens every OWNERLESS job to all sessions, so the
 * unfiltered stream would leak server-wide jobs through any shared session;
 * the relay keeps only jobs whose `owner` is exactly the session the client
 * claimed in `request.sessionId`. Ownerless jobs (`owner` absent) are
 * therefore invisible remotely — including for `job/follow` / `job/kill`,
 * which the relay refuses separately (relay-server.ts).
 */
export declare function filterJobListFrame(frame: unknown, ownerSessionId: string): Record<string, unknown> | null;
/**
 * The unfiltered latest workspace state behind ONE `workspace/follow` relay
 * stream, maintained from the raw upstream frames so a share/unshare can
 * synthesize the frames the client missed (relay-server.ts writes them as if
 * the workspace had just been upserted).
 */
export interface WorkspaceFollowState {
    /** Feed one raw upstream frame (baseline / upsert / remove / order /
     * archived / pinned); unknown frames are ignored. */
    apply(frame: unknown): void;
    /**
     * Frames to write after `sessionId` was shared or unshared: one re-filtered
     * `upsert` per workspace currently containing it, plus one `archived` /
     * `pinned` frame when the session sits in those lists. Running the
     * synthesized frames back through {@link filterWorkspaceFrame} keeps their
     * shape identical to real upstream frames — and naturally drops the session
     * after an unshare.
     */
    onShareChange(sessionId: string, isAccessible: Accessibility): Record<string, unknown>[];
}
export declare function createWorkspaceFollowState(): WorkspaceFollowState;
//# sourceMappingURL=relay-filter.d.ts.map