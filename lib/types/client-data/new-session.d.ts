/**
 * UX-3 — what tapping the phone home screen's "+ 新建会话" FAB should do.
 *
 * Entering a blank session with NO workspace leaves the phone dangling in
 * the hero's inert "choose a workspace" state (the host's `marshal-main`
 * belongs to no workspace, so the "all" filter often resolves to
 * `undefined`). Decide BEFORE entering:
 *
 * - a workspace is already selected → start there;
 * - exactly one workspace exists (or none at all) → start with it
 *   (`undefined` keeps a no-workspace host usable);
 * - several workspaces and none selected → the FAB opens the same
 *   bottom-sheet workspace drawer the title bar uses, and the session only
 *   starts once one is picked.
 *
 * Pure: no DOM, no imports — MobileHome calls it inside the FAB's onClick
 * and test/permission-sheet.test.cjs drives it directly.
 */
export type NewSessionAction<W extends string> = {
    kind: 'start';
    workspaceId: W | undefined;
} | {
    kind: 'pick-workspace';
};
export declare function decideNewSessionAction<W extends string>(selectedWorkspaceId: W | undefined, workspaceIds: readonly W[]): NewSessionAction<W>;
//# sourceMappingURL=new-session.d.ts.map