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
/**
 * The registry. Deliberately small: everything not listed here — plugin and
 * account management, settings, credentials, terminal, `session/create` /
 * `session/fork` (new sessions must auto-share, T31), `subagents/*` (T31
 * re-verifies ownership first), the methods located by other ids
 * (`schedule/update|delete|history`, `goals/*`, `fileReferences/*`,
 * `fileUploads/*`, `workspaceFiles/*` — P4 verifies DSH's ownership checks) —
 * is refused by default.
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
 * share table; DSH validates the parent-child link server-side). Any other
 * kind, or a missing id, makes the method unauthorizable.
 */
function claimedSessionIds(entry, args) {
    // Field-less entries (the global reads) claim nothing by construction —
    // their safety comes from output filtering, and their wire shape is their
    // own (`session/list` takes `_request`, not `request`).
    if (entry.fields.length === 0)
        return { ids: [] };
    if (!isPlainObject(args))
        return { reason: 'no-session' };
    const request = args.request;
    if (!isPlainObject(request))
        return { reason: 'no-session' };
    const ids = [];
    for (const field of entry.fields) {
        if (field === 'request.sessionId') {
            const id = ownedId(request.sessionId);
            if (id === undefined)
                return { reason: 'no-session' };
            ids.push(id);
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