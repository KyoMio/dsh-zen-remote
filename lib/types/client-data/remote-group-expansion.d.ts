/**
 * T64: the server remote groups' expansion memory, as pure functions — the
 * readable core of the keeper (src/client/remote-group-expansion.ts).
 *
 * WHY this exists: the host's own expansion memory
 * (localStorage `dsh.workspace.view.v5`, key `groupExpansion`) is purged of
 * every key not in the CURRENT workspace list the moment the workspace list
 * goes ready (`retainAccountKeys` — dsh-client-ui-workspace). On a sub-client
 * the LOCAL workspaces go ready before the server groups merge in, so the
 * `zr~<serverId>~<workspaceId>` keys are dropped on every page load and every
 * server group falls back to collapsed (`groupExpansion[key] ??
 * ancestorKeys.has(key)` — unrecorded means collapsed). The plugin therefore
 * keeps its OWN record and re-applies it: while the host still has a record
 * for a group, the host's value wins (the user's latest choice lives there)
 * and syncs into the plugin record; for a group the host has NO record for
 * (exactly the just-purged case) the plugin record — default EXPANDED — is
 * what the group should show, applied by clicking the row once so the host
 * writes its own state back.
 *
 * Everything here is defensive like the rest of client-data: a malformed
 * storage value degrades to an empty record, never a throw.
 */
/** The plugin's own storage key (`{ [virtualWorkspaceId]: boolean }`). */
export declare const REMOTE_GROUP_EXPANSION_KEY = "zr.remoteGroupExpansion.v1";
/** The HOST key this module reads (never writes) — dsh-client-ui-workspace's
 * persisted view state. */
export declare const HOST_WORKSPACE_VIEW_KEY = "dsh.workspace.view.v5";
/** The record's key cap; past it the OLDEST entries (least recently written)
 * are evicted. One server group is one key — 200 is far past any real
 * sidebar, the cap bounds a long-lived stale record. */
export declare const REMOTE_GROUP_EXPANSION_LIMIT = 200;
/** One server group row's current state, as read from the sidebar DOM. */
export interface GroupRowState {
    /** The group id (the `data-row-key`'s part after `workspace:`) — a virtual
     * id `zr~<serverId>~<workspaceId>`. */
    key: string;
    /** The row's current `aria-expanded`. */
    expanded: boolean;
}
export interface ExpansionPlan {
    /** Group ids to click, in row order — the rows whose `aria-expanded`
     * disagrees with the wanted state and that the host holds no record for. */
    clicks: string[];
    /** The next plugin record: the host-recorded `zr~` keys synced in (host
     * value wins, recency touched), capped at the limit. Write it back only
     * when it differs from the current one. */
    record: Record<string, boolean>;
}
/** Parse one raw read of the plugin record (or the host's `groupExpansion`
 * map): a JSON object whose values are booleans survives; anything else —
 * absent key, broken JSON, non-object, non-boolean values — degrades to an
 * empty record. */
export declare function parseExpansionRecord(raw: string | null | undefined): Record<string, boolean>;
/** Parse one raw read of the HOST view state (`dsh.workspace.view.v5`) down
 * to just its `groupExpansion` map — same defensiveness as
 * {@link parseExpansionRecord}. */
export declare function parseHostGroupExpansion(raw: string | null | undefined): Record<string, boolean>;
/** One plan step: sync the host-recorded `zr~` keys into the plugin record,
 * then plan the clicks. The four rules the sidebar depends on:
 * - a group the HOST has a record for is the user's latest choice — never
 *   clicked, its value syncs into the plugin record;
 * - a group with no host record and no plugin record defaults to EXPANDED
 *   (the group was showing its sessions before the purge);
 * - a plugin-recorded COLLAPSED group stays collapsed — no click;
 * - non-`zr~` rows are the host's own groups — never touched, never
 *   recorded. */
export declare function planRemoteGroupExpansion(options: {
    /** The host's current `groupExpansion` map (originals and `zr~` keys
     * mixed — only `zr~` keys matter here). */
    hostRecord: Record<string, boolean>;
    /** The plugin's own record, as last persisted. */
    pluginRecord: Record<string, boolean>;
    /** The server group rows currently in the sidebar, in DOM order. */
    rows: GroupRowState[];
}): ExpansionPlan;
//# sourceMappingURL=remote-group-expansion.d.ts.map