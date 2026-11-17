/**
 * Pure visibility predicate for remote workspaces in sidebars (desktop tree
 * and mobile workspace-switcher sheet).
 *
 * Why UI-layer filtering instead of dropping rows from `workspace/follow`:
 * 1. New Session workspace pickers (`conversation.hero.workspace` and
 *    `MobileHome` `new-session` sheet) read directly from `ctx.workspaces.items`,
 *    so empty remote workspaces MUST remain in `ClientWorkspaceModel`.
 * 2. `ClientWorkspaceModel.removedIds` is an append-only blacklist for the
 *    page lifetime — emitting a `remove` frame for an empty workspace would
 *    permanently block future sessions created in that workspace from entering
 *    the sidebar until a full reload.
 */
/** DOM attribute stamped onto hidden remote workspace treeitems in the sidebar. */
export declare const REMOTE_HIDDEN_WORKSPACE_ATTR = "data-zr-hidden-ws";
/** Structural subset of one Workspace entry needed for visibility checks. */
export interface RemoteWorkspaceEntry {
    readonly workspaceId: string;
    readonly sessionIds: readonly string[];
}
/** Structural subset of one Session summary needed for visibility checks. */
export interface RemoteSessionVisibilityInfo {
    readonly blank?: boolean | undefined;
    readonly origin?: string | undefined;
}
/** Inputs needed to decide whether a remote workspace has active sessions. */
export interface RemoteWorkspaceVisibilityState {
    readonly archivedIds: readonly string[];
    readonly sessionsById: Readonly<Record<string, RemoteSessionVisibilityInfo | undefined>>;
    readonly currentSessionId?: string | undefined;
}
/**
 * Return true when a workspace should remain visible in the sidebar when
 * "hide inactive remote workspaces" is enabled:
 * - Local workspaces (non-`zr~` ids) are ALWAYS visible.
 * - A remote workspace hosting `currentSessionId` is visible while open.
 * - Otherwise, at least one session in `sessionIds` must be non-archived and
 *   neither a subagent nor an unopen blank placeholder.
 */
export declare function hasActiveRemoteSession(workspace: RemoteWorkspaceEntry, state: RemoteWorkspaceVisibilityState, archivedSet?: ReadonlySet<string>): boolean;
/**
 * Compute the set of remote `workspaceId`s that have no active shared sessions
 * and should be hidden in the sidebar / workspace filter lists.
 */
export declare function hiddenRemoteWorkspaceIds(workspaces: readonly RemoteWorkspaceEntry[], state: RemoteWorkspaceVisibilityState): ReadonlySet<string>;
//# sourceMappingURL=remote-workspace-visibility.d.ts.map