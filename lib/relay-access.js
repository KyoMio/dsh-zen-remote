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
 * Pure functions: no I/O, no clock, the share-table lookup is injected.
 */
/**
 * The registry. Deliberately small: everything not listed here — plugin and
 * account management, settings, credentials, terminal, the methods located
 * by other ids (`schedule/update|delete|history`, `goals/*`,
 * `fileUploads/list|resolve`, `workspaceFiles/*`) — is refused by default.
 *
 * T31 registered the five session-creating / agent-scoped calls after
 * verifying their ownership story (see the field notes above): creations
 * auto-share their result (relay-server.ts), the subagents calls are judged
 * by the parent DSH itself re-validates, and the two `agentId` methods are
 * located by the session id that name resolves to.
 *
 * The unscoped reads are registered as FILTERED controlled paths (T22b):
 * `workspace/follow` and `session/control` stream globally but every frame
 * passes `streamFilter` first; `session/list` invokes but its items pass
 * `resultFilter` first. Nothing unlisted ever reaches the gateway.
 */
const RELAY_METHODS = {
    // session/* — ownership via the address envelope
    'session/follow': { fields: ['request.address'], stream: true },
    'session/page': { fields: ['request.address'] },
    // session/* — ownership via request.sessionId
    'session/projections': { fields: ['request.sessionId'] },
    'session/prompt': { fields: ['request.sessionId'] },
    'session/cancel': { fields: ['request.sessionId'] },
    'session/rename': { fields: ['request.sessionId'] },
    'session/selectModel': { fields: ['request.sessionId'] },
    'session/updateQueue': { fields: ['request.sessionId'] },
    'session/attachment': { fields: ['request.sessionId'] },
    // session/* — creation and forking (T31): the route validates the workspace
    // / source session and auto-shares the NEW session from the result
    'session/create': { fields: ['request.workspaceId'] },
    'session/fork': { fields: ['request.sessionId'] },
    // subagents (T31) — judged by the PARENT session; DSH re-validates that the
    // addressed child belongs to it on every path
    'subagents/prompt': { fields: ['request.parentSessionId'] },
    'subagents/interruptByParent': { fields: ['parentSessionId'] },
    // attachments and @ references (T31) — the top-level agentId resolves
    // through the agent registry keyed by session id, so it IS the session id
    'fileUploads/upload': { fields: ['agentId'] },
    'fileReferences/list': { fields: ['agentId'] },
    // session/* — the global control stream and the unscoped list
    'session/control': { fields: [], stream: true, streamFilter: 'control' },
    'session/list': { fields: [], resultFilter: 'session-list' },
    // job/*
    'job/list': { fields: ['request.sessionId'], stream: true },
    'job/follow': { fields: ['request.sessionId'], stream: true },
    'job/kill': { fields: ['request.sessionId'] },
    // skills, message feedback
    'skills/list': { fields: ['request.sessionId'] },
    'messageFeedback/list': { fields: ['request.sessionId'] },
    'messageFeedback/put': { fields: ['request.sessionId'] },
    'messageFeedback/delete': { fields: ['request.sessionId'] },
    // schedule (list only — update/delete/history wait for P4)
    'schedule/list': { fields: ['request.sessionId'] },
    // workspace session-scoped mutations
    'workspace/pinSession': { fields: ['request.sessionId'] },
    'workspace/unpinSession': { fields: ['request.sessionId'] },
    'workspace/archiveSession': { fields: ['request.sessionId'] },
    'workspace/unarchiveSession': { fields: ['request.sessionId'] },
    // workspace — the global follow stream
    'workspace/follow': { fields: [], stream: true, streamFilter: 'workspace' },
};
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** An OWNED session id: present and a non-empty string, anything else means
 * "the field does not locate a session" (an empty id is garbage, not one). */
function ownedId(value) {
    return typeof value === 'string' && value !== '' ? value : undefined;
}
/**
 * The session ids one registered method's arguments claim, read STRICTLY
 * along the registered fields (this replaces the old generic
 * `extractSessionIds` scan — that scan is exactly the decoy hole).
 *
 * `request.address` contributes its session id by kind: `session` →
 * `sessionId`, `subagent` → `parentSessionId` (the child never enters the
 * share table; DSH validates the parent-child link server-side). The
 * top-level fields (`agentId`, `parentSessionId`) read the argument object
 * itself. `request.workspaceId` contributes NO id — it must be present, but
 * its authorization is the route's workspace probe plus the auto-share of
 * the created session, not this table. Any other kind, or a missing id,
 * makes the method unauthorizable.
 */
function claimedSessionIds(entry, args) {
    // Field-less entries (the global reads) claim nothing by construction —
    // their safety comes from output filtering, and their wire shape is their
    // own (`session/list` takes `_request`, not `request`).
    if (entry.fields.length === 0)
        return { ids: [] };
    if (!isPlainObject(args))
        return { reason: 'no-session' };
    const ids = [];
    for (const field of entry.fields) {
        // Top-level fields read the argument object itself.
        if (field === 'agentId' || field === 'parentSessionId') {
            const id = ownedId(args[field]);
            if (id === undefined)
                return { reason: 'no-session' };
            ids.push(id);
            continue;
        }
        const request = args.request;
        if (!isPlainObject(request))
            return { reason: 'no-session' };
        if (field === 'request.sessionId') {
            const id = ownedId(request.sessionId);
            if (id === undefined)
                return { reason: 'no-session' };
            ids.push(id);
            continue;
        }
        if (field === 'request.parentSessionId') {
            const id = ownedId(request.parentSessionId);
            if (id === undefined)
                return { reason: 'no-session' };
            ids.push(id);
            continue;
        }
        if (field === 'request.workspaceId') {
            // Present and a non-empty string, but never share-checked — see the
            // SessionField note.
            if (ownedId(request.workspaceId) === undefined)
                return { reason: 'no-session' };
            continue;
        }
        // 'request.address'
        const address = request.address;
        if (!isPlainObject(address))
            return { reason: 'no-session' };
        if (address.kind === 'session') {
            const id = ownedId(address.sessionId);
            if (id === undefined)
                return { reason: 'no-session' };
            ids.push(id);
        }
        else if (address.kind === 'subagent') {
            const id = ownedId(address.parentSessionId);
            if (id === undefined)
                return { reason: 'no-session' };
            ids.push(id);
        }
        else {
            // Unknown kind — not an address DSH would accept either.
            return { reason: 'no-session' };
        }
    }
    return { ids };
}
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
export function decideInvoke(namespace, method, args, isAccessible) {
    const entry = RELAY_METHODS[`${namespace}/${method}`];
    if (entry === undefined || entry.stream === true)
        return { allow: false, reason: 'forbidden-method' };
    const claimed = claimedSessionIds(entry, args);
    if ('reason' in claimed)
        return { allow: false, reason: claimed.reason };
    for (const id of claimed.ids) {
        if (!isAccessible(id))
            return { allow: false, reason: 'not-shared' };
    }
    return entry.resultFilter !== undefined ? { allow: true, filter: entry.resultFilter } : { allow: true };
}
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
export function decideStream(namespace, method, args, isAccessible) {
    const entry = RELAY_METHODS[`${namespace}/${method}`];
    if (entry === undefined || entry.stream !== true)
        return { allow: false, reason: 'forbidden-method' };
    if (entry.streamFilter !== undefined)
        return { allow: true, filter: entry.streamFilter, sessionIds: [] };
    const claimed = claimedSessionIds(entry, args);
    if ('reason' in claimed)
        return { allow: false, reason: claimed.reason };
    for (const id of claimed.ids) {
        if (!isAccessible(id))
            return { allow: false, reason: 'not-shared' };
    }
    return { allow: true, sessionIds: claimed.ids };
}
//# sourceMappingURL=relay-access.js.map