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
 * The rules, mirroring tasks/T23b2.md:
 * - local frames pass through, except that `baseline` / `order` get the
 *   remote workspaces APPENDED to their order (remote groups sort after
 *   local) and the `archived` / `pinned` lists merge local + remote;
 * - a remote baseline NEVER travels as a second baseline — it would wipe the
 *   local data. It becomes one virtualized `upsert` per remote workspace,
 *   then the merged `order` / `archived` / `pinned`;
 * - remote frames that arrive before the local baseline are CACHED as state
 *   only — the UI has seen nothing yet, so emitting them would order
 *   workspaces the local baseline would immediately erase;
 * - `onRemoteGone` (relay down, unpaired, server changed) removes exactly
 *   what the UI was shown: one `remove` per known remote workspace plus the
 *   remote-free `order` / `archived` / `pinned`.
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
     * has not passed). */
    onRemote(frame: unknown): unknown[];
    /** The remote leg died or the server changed: remove everything the UI was
     * shown from the remote side and reset the remote state. Idempotent — a
     * second call with no remote state returns []. */
    onRemoteGone(): unknown[];
    /** Point the merger at a (possibly different) server. Local state survives;
     * remote state must be gone before this runs (onRemoteGone first). */
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
    /** Local control frames pass through untouched. */
    onLocal(frame: unknown): unknown[];
    /** Remote baseline → per-session per-key `projection` frames; remote
     * projection updates → virtualized. Unknown types are dropped. */
    onRemote(frame: unknown): unknown[];
    /** Always [] — the workspace merger removes the group; leftover projection
     * state for vanished virtual sessions is harmless. */
    onRemoteGone(): unknown[];
    retarget(identity: MergerIdentity): void;
}
/**
 * The session/control merger. The control stream is key-value projection
 * traffic with no ordering constraints between sessions, so it needs no
 * caching and no baseline bookkeeping: local frames pass through, remote
 * frames get their session id virtualized, and a remote baseline is EXPLODED
 * into one `projection` frame per key (never a second baseline).
 */
export declare function createControlMerger(options: ControlMergerOptions): ControlMerger;
/**
 * Merge one `session/list` result pair (first page only — the caller skips
 * paged requests). Local items keep their order and their pagination fields;
 * the remote items are appended with virtualized session ids. A missing or
 * malformed remote result means "remote said nothing" — the local result
 * passes back untouched.
 */
export declare function mergeSessionList(localResult: unknown, remoteResult: unknown, serverId: string): unknown;
//# sourceMappingURL=merge-streams.d.ts.map