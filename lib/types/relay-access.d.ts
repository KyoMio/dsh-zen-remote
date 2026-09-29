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
 * - every other method registered before T31 carries `request.sessionId`.
 *
 * T31 additions, each verified against the 0.2.0 sources before registering:
 *
 * - `session/create` carries `request.workspaceId` — a WORKSPACE id, never
 *   share-checked (workspaces do not live in the share table): it must be
 *   present, and the relay route validates it against the server's live
 *   workspace list before forwarding (relay-server.ts). The new session is
 *   auto-shared there, which is what makes the entry safe at all.
 * - `session/fork` carries `request.sessionId` (the SOURCE session); the
 *   forked child is auto-shared after the call succeeds.
 * - `subagents/prompt` (`request.parentSessionId`) and
 *   `subagents/interruptByParent` (TOP-LEVEL `parentSessionId`) are judged
 *   by the parent: DSH re-validates the parent-child link itself
 *   (`authorizeLineage` on both delivery paths of prompt; the user-authority
 *   check inside `interrupt`), so an unshared child can no more be reached
 *   than an unshared parent — it is refused server-side by DSH.
 * - `fileUploads/upload` and `fileReferences/list` carry a TOP-LEVEL
 *   `agentId`: the gateway's `agent` lookup resolves it through the agent
 *   registry keyed by SESSION id (dsh-agent registers wire `agentId`,
 *   wireTypeSymbol `SessionId`), so it IS the session id and shares its
 *   check. A shared `request.sessionId` padded next to it buys nothing —
 *   only the registered field is read.
 *
 * T41a additions (the panel long tail where the session id hides in another
 * argument), each verified against the 0.2.0 sources before registering:
 *
 * - the `agentId` group grows: `goals/get|edit|pause|resume|clear`,
 *   `commands/list|execute`, `agentPresets/select`,
 *   `sessionReferenceResolver/candidates` and the whole `terminal/*` agent
 *   half — every one takes `agent` as its first parameter, wire `agentId`,
 *   source `lookup: 'agent'`, wireTypeSymbol `SessionId` (the same shape
 *   T31 verified for fileUploads/fileReferences).
 * - `workspaceFiles/list|changes|read|readBytes|stat` carry a TOP-LEVEL
 *   `workspaceFileScopeId`: the host registers the `workspaceFileScope`
 *   lookup with wireTypeSymbol `SessionId` and resolves it by session —
 *   `sessions.get(sessionId).header.cwd` is only the BASE for relative
 *   paths (dsh-api-workspace-files lib/index.js, the lookup registration),
 *   not a containment: absolute paths anywhere the server process can read
 *   are served (see the registry note below). The field itself is
 *   share-checked like any session id.
 * - `terminal/list` and `terminal/retain` take a plain TOP-LEVEL json
 *   `sessionId` (source `'json'`, not a lookup) — same check.
 * - `sessionFeedback/record` carries `request.sessionId` — a plain B-type.
 * - `sessionReferenceResolver/candidates` (@ mentions) answers with EVERY
 *   server session — title, cwd, and a ready-made `dsh-session:` mention
 *   — so its result travels only through the row filter that drops
 *   inaccessible sessions (relay-server.ts, the session/list discipline).
 * - `subagents/prompt` (`request.parentSessionId` +
 *   `request.childSessionId`) and `subagents/interruptByParent` (TOP-LEVEL
 *   `parentSessionId` + `childSessionId`) now claim BOTH ids: the parent is
 *   share-checked directly, the child through the injected `parentOf`
 *   inheritance (`store.isAccessible(id, parentOf)` — a subagent session
 *   never enters the table, it borrows its ancestor's share). A child that
 *   does not descend from the claimed parent fails its own check, so the
 *   "shared parent + foreign child" decoy refuses here before DSH's own
 *   lineage validation is ever reached.
 *
 * PROMPT TEXT REFERENCES ARE CHECKED TOO: a prompt whose text carries a
 * canonical `dsh-session:<base64url(id)>` address makes DSH inject that
 * session's content (`prepareDirectMessages` → `readSurface`, with no
 * access check of its own), so the relay scans the text blocks of
 * `session/prompt` / `subagents/prompt` and refuses any address naming an
 * inaccessible session (relay-server.ts). The client restores its virtual
 * ids inside those addresses before the call travels (intercept.ts).
 *
 * TERMINALS ARE DELIBERATE (SPEC user story 45, explicit user request):
 * remote terminals open SERVER-side, so a paired desktop client working a
 * shared session gets a real PTY in the server's workspace — a shell
 * running as the server user WITHOUT the agent sandbox or approval
 * restrictions (RT dsh-api-terminal-controller create), the session cwd
 * being only the starting directory. The authorization boundary is exactly
 * the standing one — the session must be shared AND the caller must be a
 * paired desktop application client (the gateway's device auth + relay
 * secret), a TRUSTED DEVICE: the shared-only rule constrains session data,
 * not the machine. No extra switch is added on top; closing the session's
 * remote access closes its terminals with it (the stream route kills
 * `terminal/follow` / `terminal/retain` with `unshared`, like every other
 * session-scoped stream). The terminal ids and attachment ids inside these
 * calls are CLIENT-generated (`WebTerminalId` / `TerminalAttachmentId` type
 * symbols, distinct from `SessionId`) and pass through untouched.
 *
 * Pure functions: no I/O, no clock, the share-table lookup is injected.
 */
/** Which standing filter the caller must apply to a global stream's frames
 * (`src/relay-filter.ts` owns both implementations). */
export type StreamFilter = 'workspace' | 'control';
/** Which standing filter the caller must apply to an invoke result before it
 * travels: `session-list` narrows the unscoped `session/list` items
 * (relay-filter.ts), `session-reference-candidates` drops the @-mention
 * candidate rows whose session is not accessible (relay-server.ts — the host
 * lists EVERY server session with title, cwd and a ready-made mention, so
 * unshared rows must never leave the box). */
export type InvokeFilter = 'session-list' | 'session-reference-candidates';
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
 * the stream and counts viewers with them), or the 403 reason. */
export type StreamDecision = {
    allow: true;
    filter?: StreamFilter;
    sessionIds: string[];
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
//# sourceMappingURL=relay-access.d.ts.map