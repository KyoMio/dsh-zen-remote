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
 */
/** The (serverId, serverName) pair a merger virtualizes with. A re-handshake
 * with a different server retargets the SAME merger ({@link retarget}) so the
 * locally observed baseline/order state survives the swap. */
export interface MergerIdentity {
    serverId: string;
    serverName: string;
}
/**
 * The status annotation (T34) appended to every shown remote group's title
 * while the relay is not serving normally. The CALLER (intercept.ts) maps the
 * relay state onto one annotation — `revoked` / `unpaired` outrank `offline`,
 * which outranks `mismatch` — and the merger only renders the suffix it is
 * told to. The suffixes are the CHINESE copy, deliberately hardcoded here:
 * this module is background code with no access to the UI language (the
 * English forms live in src/client/locales.ts, `remoteGroup*` keys).
 */
export type MergerAnnotation = 'none' | 'offline' | 'revoked' | 'unpaired' | 'mismatch';
export interface WorkspaceMergerOptions extends MergerIdentity {
    /** Diagnostics for frames this merger dropped (unknown type or malformed).
     * Optional: without it the drop is silent. */
    onDiagnostic?: (message: string) => void;
}
export interface WorkspaceMerger {
    readonly serverId: string;
    readonly serverName: string;
    /** Feed one frame of the LOCAL workspace/follow stream; returns the frames
     * the UI should see (usually exactly the input, order-merged when remote
     * state exists). */
    onLocal(frame: unknown): unknown[];
    /** Feed one server-filtered frame of the REMOTE stream; returns the frames
     * the UI should see (possibly none — state-only while the local baseline
     * has not passed). A later baseline is DIFFED against what was shown. */
    onRemote(frame: unknown): unknown[];
    /** The remote stream died or the relay went offline (the same server is
     * expected back): emits NOTHING and keeps the shown state — the UI keeps
     * the last projection visible across carrier loss, and a `remove` here
     * would blacklist the virtual ids against revival. */
    onRemoteDown(): unknown[];
    /** The remote side is gone FOR GOOD under THIS identity: a serverId
     * change. (Since T23b2-fix3 an `unpaired` / `revoked` relay is NOT this
     * case — the same serverId comes back on re-pair, so the caller uses
     * {@link onRemoteDown} there.) Removes everything shown from the remote
     * side, resets the remote state. Idempotent — a second call with no
     * remote state returns []. */
    onRemoteGone(): unknown[];
    /** The server was renamed (same serverId — call after {@link retarget}):
     * re-upserts every shown workspace under the new title, nothing else. */
    onServerRenamed(): unknown[];
    /** Record the status annotation (T34) future virtualized titles carry. No
     * frames on its own — pair it with {@link onStatusChanged} to re-upsert the
     * shown groups under the new annotation, or let the next natural upserts
     * (a reconnecting baseline) carry it. */
    setStatus(annotation: MergerAnnotation): void;
    /** Re-upsert every SHOWN workspace under the CURRENT annotation: the whole
     * update when the relay's serving status changed without any remote frame
     * (offline, revoked, unpaired, version mismatch). [] while nothing is
     * shown (no local baseline yet, or no remote state). */
    onStatusChanged(): unknown[];
    /** Point the merger at a (possibly different) server. Local state survives;
     * for a serverId change the remote state must be gone first (onRemoteGone
     * first); for a rename it may stay. */
    retarget(identity: MergerIdentity): void;
}
/**
 * The workspace/follow merger. Remote state is a Map keyed by the ORIGINAL
 * workspace id whose INSERTION ORDER tracks the remote order (baseline sets
 * it, upsert appends new keys, order frames reorder it) — that sequence is
 * what gets appended to every local baseline/order that passes through.
 */
export declare function createWorkspaceMerger(options: WorkspaceMergerOptions): WorkspaceMerger;
export interface ControlMergerOptions {
    serverId: string;
    serverName?: string;
    onDiagnostic?: (message: string) => void;
}
export interface ControlMerger {
    readonly serverId: string;
    readonly serverName: string;
    /** Local control frames pass through untouched; the local BASELINE also
     * flushes anything the remote side buffered before it arrived. */
    onLocal(frame: unknown): unknown[];
    /** Remote baseline → per-session per-key `projection` frames; remote
     * projection updates → virtualized. Unknown types are dropped. Frames
     * arriving before the local baseline are buffered (the host's snapshot
     * stream treats an update before the opening snapshot as a protocol
     * violation and kills the stream). */
    onRemote(frame: unknown): unknown[];
    /** Always [] — a control stream has nothing to remove on a temporary
     * remote end (the workspace merger owns the group). */
    onRemoteDown(): unknown[];
    /** Always [] — leftover projection state for vanished virtual sessions is
     * harmless; the workspace merger removes the group. */
    onRemoteGone(): unknown[];
    /** Always [] — projection frames carry no display name. */
    onServerRenamed(): unknown[];
    /** Accepted and ignored: a status annotation is a TITLE concern, and
     * control projections carry no titles. */
    setStatus(annotation: MergerAnnotation): void;
    /** Always [] — nothing shown here could carry an annotation. */
    onStatusChanged(): unknown[];
    retarget(identity: MergerIdentity): void;
}
/**
 * The session/control merger. The control stream is key-value projection
 * traffic with no ordering constraints between sessions, so it needs no
 * state beyond the pre-baseline buffer: local frames pass through, remote
 * frames get their session id virtualized, and a remote baseline is EXPLODED
 * into one `projection` frame per key (never a second baseline).
 */
export declare function createControlMerger(options: ControlMergerOptions): ControlMerger;
/**
 * Merge one `session/list` result pair (first page only — the caller skips
 * paged requests). Local items keep their order and their pagination fields;
 * the remote items are appended with virtualized session ids — `sessionId`
 * AND `parentSessionId` (CP4): the fork link must point at the VIRTUAL parent
 * id the UI knows, or the fork would sort beside a parent id that exists in
 * no list the UI holds. A missing or malformed remote result means "remote
 * said nothing" — the local result passes back untouched.
 */
export declare function mergeSessionList(localResult: unknown, remoteResult: unknown, serverId: string): unknown;
//# sourceMappingURL=merge-streams.d.ts.map