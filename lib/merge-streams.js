/**
 * Pure mergers for the three GLOBAL calls (T23b-2): `workspace/follow` and
 * `session/control` are STREAMS whose frames carry no session-locating
 * argument, and `session/list` is an unscoped invoke — the sidebar reads all
 * three to render its tree, so a sub-client must see the server's shared
 * sessions merged INTO the local answer instead of in place of it.
 *
 * Frame and result shapes are the generated 0.2.0 codecs, field by field:
 * `workspace_follow_result` (baseline / upsert / remove / order / archived /
 * pinned), `session_control_result` (exactly two frame types: `baseline`
 * nesting `value.projections`, and one-key `projection` updates), and
 * `session_list_result` (`{ items }` — no cursor field). The same shapes the
 * server filters by (relay-filter.ts); remote frames arriving here have
 * ALREADY been narrowed to the shared sessions and carry ORIGINAL ids.
 *
 * The rules, mirroring tasks/T23b2.md as corrected by tasks/T23b2-fix.md:
 * - local frames pass through, except that `baseline` / `order` get the
 *   remote workspaces APPENDED to their order (remote groups sort after
 *   local) and the `archived` / `pinned` lists merge local + remote;
 * - a remote baseline NEVER travels as a second baseline — it would wipe the
 *   local data. It becomes one virtualized `upsert` per remote workspace,
 *   then the merged `order` / `archived` / `pinned`;
 * - remote frames that arrive before the local baseline are CACHED as state
 *   only — the UI has seen nothing yet, so emitting them would order
 *   workspaces the local baseline would immediately erase;
 * - a remote stream that died (or a merely offline relay) emits NOTHING and
 *   keeps the shown state ({@link WorkspaceMerger.onRemoteDown}): the UI's
 *   `ClientWorkspaceModel.remove()` records ids in a never-cleared blacklist
 *   and both `upsert` and baseline replacement drop blacklisted ids, so one
 *   `remove` for a virtual id would make that group un-revivable on
 *   reconnect — while the UI itself keeps the last complete projection
 *   visible across carrier loss (its `handleCarrierFailure`);
 * - a NEW remote baseline on the same server is DIFFED against the shown
 *   set: still present → fresh `upsert` (content from the new baseline),
 *   absent (deleted server-side / no longer shared) → `remove`, then the
 *   merged `order` / `archived` / `pinned`;
 * - a server RENAME (same serverId) re-upserts the shown groups under the
 *   new title — no removals ({@link WorkspaceMerger.onServerRenamed});
 * - only a serverId CHANGE removes the whole group
 *   ({@link WorkspaceMerger.onRemoteGone}): the new prefix is fresh, so it
 *   can never collide with the UI's blacklist. The relay entering
 *   `unpaired` / `revoked` is NOT this case (T23b2-fix3): the server
 *   persists its serverId (relay-server.ts loadServerId), so a re-pair to
 *   the same server reuses the prefix and is handled as a remote death
 *   ({@link WorkspaceMerger.onRemoteDown}) — the reconnect diff revives
 *   the group;
 * - a relay status that is not serving normally (T34: offline, unpaired,
 *   revoked, interface mismatch) only ANNOTATES TITLES: setStatus +
 *   onStatusChanged re-upsert the shown groups under the annotated titles,
 *   and the reconnecting baseline (which always upserts) restores them.
 * - a session the SERVER stopped serving (remote closed / idle-slept / its
 *   fork parent closed → the filtered workspace upsert drops it from
 *   `sessionIds`) keeps a TOMBSTONE in the group it was last seen in (CP4,
 *   reworked by CP4-client-fix2): the merger remembers the workspace each
 *   session id was last carried by, and the forwarded record for THAT
 *   workspace still lists the id (appended at the end of `sessionIds`). The
 *   UI's session store keeps the merged projection/list entry and nothing
 *   ever removes it, so without this the sidebar would park the session in
 *   「未分组」 forever — and hiding it in the merged `archived` frame instead
 *   (what CP4-client first did) makes the RT navigation guard
 *   `clearArchivedCurrent` (dsh-client-ui-workspace `watchNavigation`) kick
 *   the OPEN session page back to the home page before its 「远程已关闭」
 *   banner can show. A re-share (the id back in some workspace's
 *   `sessionIds`) renders it live again and clears the tombstone; the
 *   tombstone dies with its workspace (a remove) and with the identity
 *   (onRemoteGone).
 *
 * Two KNOWN LIMITATIONS, both rooted in the UI's `removedIds` blacklist
 * never clearing during a page's life (a reload rebuilds the model from
 * scratch, which is why a reload fixes both):
 * - switch to a DIFFERENT server and later back to the SAME old one: the
 *   switch-away removed the old prefix, so the returning group's upserts
 *   are dropped by the blacklist and it stays invisible until the page is
 *   reloaded;
 * - the server deletes a workspace and later shares a NEW workspace under
 *   the SAME id: the deletion's remove blacklists the id, and the new
 *   workspace's upserts are dropped the same way.
 *
 * Everything here is a pure state machine: no DSH imports, no network, no
 * clocks — the virtual-id arithmetic is the one dependency (virtual-id.ts).
 * Shapes are read defensively like relay-filter.ts does: a malformed frame is
 * dropped (diagnosed through the optional hook), never forwarded.
 *
 * T52 adds two RESULT-side pure helpers on the same principles:
 * {@link mergeModelCatalogs} folds the relay's `session/modelCatalog` answer
 * into the local one (the catalog is the model-selection dropdown's data), and
 * {@link virtualizeModelSelectionValue} rewrites a `modelSelection` projection
 * value's provider ids to virtual group ids so the UI can find the current
 * model's display name in the merged catalog.
 */
import { toVirtual } from './virtual-id.js';
const ANNOTATION_SUFFIX = {
    offline: '（离线）',
    revoked: '（令牌已吊销）',
    unpaired: '（已解除配对）',
    mismatch: '（版本有差异）',
};
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** The string prefix of a wire list — a malformed frame degrades to []. */
function stringList(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string');
}
/** The local workspace-id order of a baseline `value.items` / order frame. */
function idList(value) {
    if (!Array.isArray(value))
        return [];
    const ids = [];
    for (const item of value) {
        if (isPlainObject(item) && typeof item.workspaceId === 'string')
            ids.push(item.workspaceId);
        else if (typeof item === 'string')
            ids.push(item);
    }
    return ids;
}
/** One workspace record rewritten for the UI: ids virtualized, the title
 * prefixed with the server name and — while an annotation is set — suffixed
 * with its status copy. Values are copied — the caller's frame is never
 * mutated. */
function virtualizeWorkspace(record, identity, annotation) {
    const virtualize = (id) => toVirtual(identity.serverId, id);
    const out = { ...record };
    if (typeof record.workspaceId === 'string')
        out.workspaceId = virtualize(record.workspaceId);
    if (typeof record.title === 'string') {
        const suffix = annotation === 'none' ? '' : ANNOTATION_SUFFIX[annotation];
        out.title = `${identity.serverName} · ${record.title}${suffix}`;
    }
    if (Array.isArray(record.sessionIds)) {
        out.sessionIds = record.sessionIds.map((id) => (typeof id === 'string' ? virtualize(id) : id));
    }
    return out;
}
/**
 * The workspace/follow merger. Remote state is a Map keyed by the ORIGINAL
 * workspace id whose INSERTION ORDER tracks the remote order (baseline sets
 * it, upsert appends new keys, order frames reorder it) — that sequence is
 * what gets appended to every local baseline/order that passes through.
 */
export function createWorkspaceMerger(options) {
    const onDiagnostic = options.onDiagnostic;
    let identity = { serverId: options.serverId, serverName: options.serverName };
    // The locally observed truth, updated from every local baseline / order /
    // archived / pinned frame. Required to rebuild remote-free frames on
    // onRemoteGone and to merge remote ids INTO local order frames.
    let localSeen = false;
    let localOrder = [];
    let localArchived = [];
    let localPinned = [];
    // The remote truth in ORIGINAL ids; insertion order = remote order. Once
    // the local baseline has passed this doubles as "what the UI has been
    // shown" — the diff baseline for a reconnecting remote baseline, and the
    // removal set for a permanent remote end.
    let remote = new Map();
    let remoteArchived = [];
    let remotePinned = [];
    // The tombstone registry (CP4-client-fix2): every session id any remote
    // workspace has ever carried for this identity (original ids) → the
    // original workspace id that LAST carried it. A session the server stopped
    // serving (remote closed → the filtered workspace upsert drops it from
    // `sessionIds`) keeps its UI entry, so the forwarded record of its last
    // workspace still lists it. Entries die when the session is carried again
    // (re-shared, anywhere — the home moves with it), when its workspace is
    // removed, and with the identity (onRemoteGone).
    let sessionHome = new Map();
    // The status annotation every virtualized title currently carries (T34).
    let annotation = 'none';
    const virtualize = (id) => toVirtual(identity.serverId, id);
    const remoteIds = () => [...remote.keys()].map(virtualize);
    const remoteArchivedVirtual = () => remoteArchived.map(virtualize);
    const remotePinnedVirtual = () => remotePinned.map(virtualize);
    /** Learn the session ids one remote workspace record carries: each id is
     * remembered under THIS workspace as its last home (originals, cumulative). */
    function learnSessions(record, workspaceId) {
        if (!Array.isArray(record.sessionIds))
            return;
        for (const id of record.sessionIds)
            if (typeof id === 'string')
                sessionHome.set(id, workspaceId);
    }
    /** Drop the ids whose last home was this workspace — tombstones die with
     * their group (a server remove / a workspace diffed away; a session that
     * moved on lives under its NEW home and survives this). */
    function forgetWorkspace(workspaceId) {
        for (const [id, home] of sessionHome)
            if (home === workspaceId)
                sessionHome.delete(id);
    }
    /** One workspace record as the UI should see it: virtualized, PLUS the
     * tombstones — ids whose last home is this workspace but that the server's
     * record no longer carries — appended at the end of `sessionIds`
     * (CP4-client-fix2). Liveness is judged against the record's ORIGINAL
     * sessionIds (the registry stores originals; the forwarded copy is
     * virtualized). */
    function forwardWorkspace(record) {
        const out = virtualizeWorkspace(record, identity, annotation);
        const workspaceId = typeof record.workspaceId === 'string' ? record.workspaceId : undefined;
        const live = stringList(record.sessionIds);
        if (workspaceId === undefined || !Array.isArray(out.sessionIds))
            return out;
        for (const [id, home] of sessionHome) {
            if (home === workspaceId && !live.includes(id))
                out.sessionIds.push(virtualize(id));
        }
        return out;
    }
    const virtualWorkspaces = () => [...remote.values()].map(forwardWorkspace);
    const upsertFrames = () => virtualWorkspaces().map((workspace) => ({ type: 'upsert', workspace }));
    const mergedOrderFrame = () => ({ type: 'order', workspaceIds: [...localOrder, ...remoteIds()] });
    /** The merged archived set: local, then remote-archived, deduplicated in
     * that order. Closed sessions are NOT archived-hidden here — they keep
     * their group slot as tombstones (CP4-client-fix2), and the RT navigation
     * guard keys on exactly this list. */
    function mergedArchivedIds() {
        const seen = new Set();
        const out = [];
        const add = (ids) => {
            for (const id of ids) {
                if (seen.has(id))
                    continue;
                seen.add(id);
                out.push(id);
            }
        };
        add(localArchived);
        add(remoteArchivedVirtual());
        return out;
    }
    const mergedArchivedFrame = () => ({ type: 'archived', archivedSessionIds: mergedArchivedIds() });
    const mergedPinnedFrame = () => ({
        type: 'pinned',
        pinnedSessionIds: [...localPinned, ...remotePinnedVirtual()],
    });
    /** Learn from a local frame without emitting anything. */
    function observeLocal(frame) {
        if (frame.type === 'baseline') {
            const value = isPlainObject(frame.value) ? frame.value : {};
            localOrder = idList(value.items);
            localArchived = stringList(value.archivedSessionIds);
            localPinned = stringList(value.pinnedSessionIds);
            localSeen = true;
            return;
        }
        if (frame.type === 'order') {
            localOrder = stringList(frame.workspaceIds);
            return;
        }
        if (frame.type === 'archived') {
            localArchived = stringList(frame.archivedSessionIds);
            return;
        }
        if (frame.type === 'pinned') {
            localPinned = stringList(frame.pinnedSessionIds);
        }
    }
    function drop(message) {
        onDiagnostic?.(message);
    }
    return {
        get serverId() {
            return identity.serverId;
        },
        get serverName() {
            return identity.serverName;
        },
        retarget(next) {
            identity = { serverId: next.serverId, serverName: next.serverName };
        },
        onLocal(frame) {
            if (!isPlainObject(frame))
                return [frame];
            observeLocal(frame);
            // The local order carries the remote groups at its tail ONLY once
            // remote state exists — before that every local frame is verbatim.
            if (frame.type === 'baseline') {
                if (remote.size === 0 && remoteArchived.length === 0 && remotePinned.length === 0 && sessionHome.size === 0) {
                    return [frame];
                }
                const value = isPlainObject(frame.value) ? frame.value : {};
                const items = Array.isArray(value.items) ? value.items : [];
                // The baseline's own order already shows the remote groups; the
                // upserts that follow restate their content (the cached-remote path
                // never emits a separate order frame).
                return [
                    {
                        ...frame,
                        value: {
                            ...value,
                            items: [...items, ...virtualWorkspaces()],
                            archivedSessionIds: mergedArchivedIds(),
                            pinnedSessionIds: [...localPinned, ...remotePinnedVirtual()],
                        },
                    },
                    ...upsertFrames(),
                ];
            }
            if (frame.type === 'order') {
                if (remote.size === 0)
                    return [frame];
                return [mergedOrderFrame()];
            }
            if (frame.type === 'archived') {
                if (remoteArchived.length === 0)
                    return [frame];
                return [mergedArchivedFrame()];
            }
            if (frame.type === 'pinned') {
                if (remotePinned.length === 0)
                    return [frame];
                return [mergedPinnedFrame()];
            }
            // upsert / remove / anything else local: purely local facts.
            return [frame];
        },
        onRemote(frame) {
            if (!isPlainObject(frame)) {
                drop('dropped a non-object workspace/follow frame from the relay');
                return [];
            }
            switch (frame.type) {
                case 'baseline': {
                    const value = isPlainObject(frame.value) ? frame.value : undefined;
                    // Build the new remote truth beside the shown one, then DIFF
                    // (T23b2-fix): a reconnecting baseline must not blindly re-add —
                    // the upserts refresh content, and the only removes it synthesizes
                    // are workspaces the server dropped (deleted / no longer shared).
                    const next = new Map();
                    if (value !== undefined && Array.isArray(value.items)) {
                        for (const item of value.items) {
                            if (isPlainObject(item) && typeof item.workspaceId === 'string')
                                next.set(item.workspaceId, { ...item });
                        }
                    }
                    const nextArchived = value === undefined ? [] : stringList(value.archivedSessionIds);
                    const nextPinned = value === undefined ? [] : stringList(value.pinnedSessionIds);
                    // The session inventory is cumulative — a baseline only ever adds
                    // known session ids (each under the workspace now carrying it).
                    for (const [id, record] of next)
                        learnSessions(record, id);
                    // Never a second baseline: the UI has either seen local data (which
                    // it must keep) or nothing (cache only).
                    if (!localSeen) {
                        remote = next;
                        remoteArchived = nextArchived;
                        remotePinned = nextPinned;
                        return [];
                    }
                    const out = [];
                    for (const [id, record] of next)
                        out.push({ type: 'upsert', workspace: forwardWorkspace(record) });
                    for (const id of remote.keys()) {
                        if (!next.has(id)) {
                            forgetWorkspace(id);
                            out.push({ type: 'remove', workspaceId: virtualize(id) });
                        }
                    }
                    remote = next;
                    remoteArchived = nextArchived;
                    remotePinned = nextPinned;
                    out.push(mergedOrderFrame(), mergedArchivedFrame(), mergedPinnedFrame());
                    return out;
                }
                case 'upsert': {
                    if (!isPlainObject(frame.workspace) || typeof frame.workspace.workspaceId !== 'string') {
                        drop('dropped a workspace upsert without a workspaceId');
                        return [];
                    }
                    const workspace = frame.workspace;
                    const id = workspace.workspaceId;
                    const isNew = !remote.has(id);
                    remote.set(id, { ...workspace });
                    learnSessions(workspace, id);
                    if (!localSeen)
                        return [];
                    // The tombstone-padded upsert is the whole update; a workspace the
                    // UI has not seen additionally needs a position.
                    const out = [{ type: 'upsert', workspace: forwardWorkspace(workspace) }];
                    if (isNew)
                        out.push(mergedOrderFrame());
                    return out;
                }
                case 'remove': {
                    const id = typeof frame.workspaceId === 'string' ? frame.workspaceId : undefined;
                    if (id === undefined) {
                        drop('dropped a workspace remove without a workspaceId');
                        return [];
                    }
                    // A remove of a workspace this merger never knew is a no-op: the UI
                    // was never shown it.
                    const removed = remote.get(id);
                    if (removed === undefined)
                        return [];
                    remote.delete(id);
                    // The group's tombstones die with it (CP4-client-fix2).
                    forgetWorkspace(id);
                    if (!localSeen)
                        return [];
                    return [{ type: 'remove', workspaceId: virtualize(id) }, mergedOrderFrame()];
                }
                case 'order': {
                    if (!Array.isArray(frame.workspaceIds)) {
                        drop('dropped a workspace order frame without a workspaceIds array');
                        return [];
                    }
                    // Same reorder rule as the server's own state (relay-filter.ts):
                    // mentioned ids first in frame order, unmentioned ones keep their
                    // relative order behind them — a partial reorder drops nothing.
                    const reordered = new Map();
                    for (const id of frame.workspaceIds) {
                        if (typeof id !== 'string')
                            continue;
                        const workspace = remote.get(id);
                        if (workspace !== undefined)
                            reordered.set(id, workspace);
                    }
                    for (const [id, workspace] of remote) {
                        if (!reordered.has(id))
                            reordered.set(id, workspace);
                    }
                    remote.clear();
                    for (const [id, workspace] of reordered)
                        remote.set(id, workspace);
                    if (!localSeen)
                        return [];
                    return [mergedOrderFrame()];
                }
                case 'archived':
                    remoteArchived = stringList(frame.archivedSessionIds);
                    if (!localSeen)
                        return [];
                    return [mergedArchivedFrame()];
                case 'pinned':
                    remotePinned = stringList(frame.pinnedSessionIds);
                    if (!localSeen)
                        return [];
                    return [mergedPinnedFrame()];
                default:
                    drop(`dropped a workspace/follow frame of unknown type ${String(frame.type)}`);
                    return [];
            }
        },
        onRemoteDown() {
            // Deliberately nothing: the shown state STAYS (the UI keeps the last
            // projection visible while the carrier is gone), so the reconnecting
            // baseline can diff against it instead of re-adding through the UI's
            // remove-blacklist. Pre-baseline cached state stays cached.
            return [];
        },
        onServerRenamed() {
            // The caller has already retarget()ed to the new name; re-upserting the
            // shown workspaces under the CURRENT identity is the whole update.
            if (!localSeen || remote.size === 0)
                return [];
            return upsertFrames();
        },
        setStatus(next) {
            annotation = next;
        },
        onStatusChanged() {
            if (!localSeen || remote.size === 0)
                return [];
            return upsertFrames();
        },
        onRemoteGone() {
            const hadAny = remote.size > 0 || sessionHome.size > 0 || remoteArchived.length > 0 || remotePinned.length > 0;
            const out = [];
            // The UI only ever SAW remote data when the local baseline had passed —
            // cached pre-baseline state is discarded silently instead.
            if (localSeen && hadAny) {
                for (const id of remote.keys())
                    out.push({ type: 'remove', workspaceId: virtualize(id) });
                out.push({ type: 'order', workspaceIds: [...localOrder] });
                out.push({ type: 'archived', archivedSessionIds: [...localArchived] });
                out.push({ type: 'pinned', pinnedSessionIds: [...localPinned] });
            }
            remote.clear();
            remoteArchived = [];
            remotePinned = [];
            // The tombstone registry dies with the identity (a new server mints new
            // ids); the archived frame above already restored the local-only set.
            sessionHome = new Map();
            return out;
        },
    };
}
/**
 * The session/control merger. The control stream is key-value projection
 * traffic with no ordering constraints between sessions, so it needs no
 * state beyond the pre-baseline buffer: local frames pass through, remote
 * frames get their session id virtualized, and a remote baseline is EXPLODED
 * into one `projection` frame per key (never a second baseline).
 */
export function createControlMerger(options) {
    const onDiagnostic = options.onDiagnostic;
    let identity = { serverId: options.serverId, serverName: options.serverName ?? '' };
    const virtualize = (id) => toVirtual(identity.serverId, id);
    // Remote output converted but not yet shown: the UI's snapshot stream
    // throws `emitted an update before its opening snapshot` — a protocol
    // violation that permanently fails the stream — so nothing may leave
    // before the local baseline has passed.
    let localSeen = false;
    let buffered = [];
    /** Convert one remote control frame into the projection frames the UI
     * understands (empty for anything malformed). */
    function convert(frame) {
        if (frame.type === 'baseline') {
            const value = isPlainObject(frame.value) ? frame.value : undefined;
            const projections = value !== undefined && isPlainObject(value.projections) ? value.projections : {};
            const out = [];
            for (const [sessionId, projection] of Object.entries(projections)) {
                if (!isPlainObject(projection))
                    continue;
                const values = isPlainObject(projection.values) ? projection.values : {};
                const asOfSeq = projection.asOfSeq;
                // A zero-event session's asOfSeq is -1, and the UI's SessionSeq
                // THROWS on a negative seq — one such frame would permanently stop
                // the whole control stream. Skip the record (one diagnostic) instead
                // of clamping: the UI compares `seq <= held → drop`, so a clamped 0
                // would swallow the real seq-0 entry when it arrives.
                if (typeof asOfSeq !== 'number' || !Number.isSafeInteger(asOfSeq) || asOfSeq < 0) {
                    onDiagnostic?.(`skipped control projections for ${sessionId}: asOfSeq ${String(asOfSeq)} is not a usable sequence number`);
                    continue;
                }
                for (const key of Object.keys(values)) {
                    // The baseline gives one sequence number per projection record
                    // (`asOfSeq`) — every key of that record rides it. A modelSelection
                    // value additionally gets its provider ids virtualized (T52) so the
                    // UI matches it against the merged catalog's virtual groups.
                    out.push({
                        type: 'projection',
                        sessionId: virtualize(sessionId),
                        key,
                        value: key === 'modelSelection' ? virtualizeModelSelectionValue(values[key], identity.serverId) : values[key],
                        seq: asOfSeq,
                    });
                }
            }
            return out;
        }
        if (frame.type === 'projection') {
            if (typeof frame.sessionId !== 'string') {
                onDiagnostic?.('dropped a session/control projection frame without a sessionId');
                return [];
            }
            if (typeof frame.seq !== 'number' || !Number.isSafeInteger(frame.seq) || frame.seq < 0) {
                // Same SessionSeq hazard on live updates (a server reboot resets the
                // counters — a -1 or fractional seq must not kill the stream).
                onDiagnostic?.(`dropped a session/control projection frame with unusable seq ${String(frame.seq)}`);
                return [];
            }
            return [
                {
                    ...frame,
                    sessionId: virtualize(frame.sessionId),
                    // The modelSelection update's providers go virtual with the session
                    // id (T52) — same rewrite as the exploded baseline above.
                    ...(frame.key === 'modelSelection'
                        ? { value: virtualizeModelSelectionValue(frame.value, identity.serverId) }
                        : {}),
                },
            ];
        }
        onDiagnostic?.(`dropped a session/control frame of unknown type ${String(frame.type)}`);
        return [];
    }
    return {
        get serverId() {
            return identity.serverId;
        },
        get serverName() {
            return identity.serverName;
        },
        // TODO(seq-epoch): the server owns `seq` and restarts it from 0 on
        // reboot, while the UI drops any projection whose seq is ≤ the value it
        // already holds — so after a server restart every remote session's
        // projections stay frozen at their pre-restart values until the live seq
        // climbs past them. A fix would offset each remote stream generation's
        // seq (e.g. by a per-generation epoch base) and shift the forwarded
        // `session/projections` results by the same offset so both routes agree.
        // Deliberately out of scope for T23b2-fix; recorded here where the seq
        // conversion happens.
        retarget(next) {
            identity = { serverId: next.serverId, serverName: next.serverName };
        },
        onLocal(frame) {
            if (isPlainObject(frame) && frame.type === 'baseline' && !localSeen) {
                localSeen = true;
                // The baseline opens the stream; the buffered remote output follows.
                const out = [frame, ...buffered];
                buffered = [];
                return out;
            }
            return [frame];
        },
        onRemote(frame) {
            if (!isPlainObject(frame)) {
                onDiagnostic?.('dropped a non-object session/control frame from the relay');
                return [];
            }
            const converted = convert(frame);
            if (!localSeen) {
                buffered.push(...converted);
                return [];
            }
            return converted;
        },
        onRemoteDown() {
            return [];
        },
        onRemoteGone() {
            // Buffered pre-baseline remote output dies with the remote leg; the UI
            // never saw it.
            buffered = [];
            return [];
        },
        onServerRenamed() {
            return [];
        },
        setStatus(_annotation) { },
        onStatusChanged() {
            return [];
        },
    };
}
/**
 * Merge one `session/list` result pair (first page only — the caller skips
 * paged requests). Local items keep their order and their pagination fields;
 * the remote items are appended with virtualized session ids — `sessionId`
 * AND `parentSessionId` (CP4): the fork link must point at the VIRTUAL parent
 * id the UI knows, or the fork would sort beside a parent id that exists in
 * no list the UI holds. A missing or malformed remote result means "remote
 * said nothing" — the local result passes back untouched.
 */
export function mergeSessionList(localResult, remoteResult, serverId) {
    if (!isPlainObject(localResult))
        return localResult;
    if (!isPlainObject(remoteResult) || !Array.isArray(remoteResult.items))
        return localResult;
    const localItems = Array.isArray(localResult.items) ? localResult.items : [];
    const virtualize = (id) => toVirtual(serverId, id);
    const remoteItems = remoteResult.items.map((item) => {
        if (!isPlainObject(item) || typeof item.sessionId !== 'string')
            return item;
        const out = { ...item, sessionId: virtualize(item.sessionId) };
        if (typeof item.parentSessionId === 'string')
            out.parentSessionId = virtualize(item.parentSessionId);
        return out;
    });
    return { ...localResult, items: [...localItems, ...remoteItems] };
}
/**
 * Fold the relay's `session/modelCatalog` answer into the local one (T52).
 * The result shape is RT dsh-api-session-controller
 * `session_modelCatalog_result$schema` (lib/typert.remote-client.js:489-518):
 * `{default, routableProviders, groups, failures}` — provider group ids and
 * display names only, no session data anywhere, so no output filter guards it
 * server-side and nothing here needs narrowing.
 *
 * - server groups are APPENDED after the local ones (the dropdown sorts
 *   `deepseek-account` / `deepseek-official` first and keeps the rest in
 *   order, RT dsh-client-ui-model-selection lib/client.js:510 — appended
 *   groups render last); each group id becomes the virtual group id
 *   `zr~<serverId>~<original>` and its name is prefixed
 *   `${serverName} · ${name}` — the same workspace title discipline the
 *   merger uses;
 * - `default` and `failures` stay LOCAL untouched: the default drives what a
 *   blank LOCAL session would run (a remote session's current model comes
 *   from its projection instead), and the UI renders every failure as a
 *   prominent warning row whose Retry reloads the WHOLE catalog
 *   (lib/client.js:816-827) — a server-side group failure is not retryable
 *   from here and would put a permanent alarm on every dropdown, so it does
 *   not travel (dsh-vision-router's settings read the same result and shows
 *   an error state exactly when groups are empty AND failures exist,
 *   lib/client.js:635-647 — dropping remote failures keeps that honest);
 * - `routableProviders` mirrors the group ids by construction host-side
 *   (RT dsh-api-session-controller lib/index.js:544 — literally
 *   `groups.map(g => g.id)`); no client UI reads it (the dropdown's
 *   routable verdict comes from the groups themselves, lib/client.js:334),
 *   so appending the virtual ids is a consistency move: the merged catalog
 *   keeps the invariant the Host maintains, whatever reads it next.
 *
 * A malformed local or remote value means "one side said nothing" — the
 * local result passes back untouched, like {@link mergeSessionList}.
 */
export function mergeModelCatalogs(localValue, remoteValue, identity) {
    if (!isPlainObject(localValue))
        return localValue;
    if (!isPlainObject(remoteValue) || !Array.isArray(remoteValue.groups))
        return localValue;
    const localGroups = Array.isArray(localValue.groups) ? localValue.groups : [];
    const virtualGroups = [];
    const virtualIds = [];
    for (const group of remoteValue.groups) {
        if (!isPlainObject(group) || typeof group.id !== 'string' || group.id === '')
            continue;
        const id = toVirtual(identity.serverId, group.id);
        virtualIds.push(id);
        virtualGroups.push({
            ...group,
            id,
            ...(typeof group.name === 'string' ? { name: `${identity.serverName} · ${group.name}` } : {}),
        });
    }
    if (virtualGroups.length === 0)
        return localValue;
    return {
        ...localValue,
        groups: [...localGroups, ...virtualGroups],
        routableProviders: [...stringList(localValue.routableProviders), ...virtualIds],
    };
}
/**
 * Virtualize the provider ids inside one `modelSelection` projection value —
 * `{lastUsed: {provider, model, reasoningEffort?} | null, next: …}` (RT
 * dsh-api-session-controller lib/types/model-selection-projection.js:12-15,
 * wire shapes at lib/typert.remote-client.js:83-94). The UI resolves the
 * current model's display name by matching `(provider, model)` against the
 * catalog groups (dsh-client-ui-model-selection lib/client.js:334, 520); for
 * a remote session the provider is a SERVER group id, so it must become the
 * virtual group id to be found in the merged catalog — and while the relay
 * serves, the merged catalog always carries it, so the composer trigger
 * shows the model NAME instead of the raw `provider/model` fallback string
 * (lib/client.js:700). Nulls and malformed entries pass through untouched;
 * `model` and `reasoningEffort` are group-agnostic ids and stay as they are.
 */
export function virtualizeModelSelectionValue(value, serverId) {
    if (!isPlainObject(value))
        return value;
    const out = { ...value };
    for (const key of ['lastUsed', 'next']) {
        const selection = value[key];
        if (isPlainObject(selection) && typeof selection.provider === 'string') {
            out[key] = { ...selection, provider: toVirtual(serverId, selection.provider) };
        }
    }
    return out;
}
//# sourceMappingURL=merge-streams.js.map