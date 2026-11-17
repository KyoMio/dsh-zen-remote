import type { ClientContext } from '../compat/types.ts';
export interface RemoteWorkspaceVisibilityOptions {
    /** Override role probe (tests). */
    probeRole?: () => Promise<'host' | 'client' | 'peer' | undefined>;
    /** Override client config reader (tests). */
    readConfig?: () => Promise<{
        hideInactiveRemoteWorkspaces: boolean;
    }>;
}
/**
 * Mark inactive remote workspace treeitems in the sidebar with
 * `data-zr-hidden-ws="1"` so CSS (`remote-session.css.ts`) hides them without
 * removing them from `ctx.workspaces` (keeping New Session workspace pickers
 * intact and avoiding `ClientWorkspaceModel.removedIds` blacklisting).
 *
 * Must be registered before the `isDesktopShell()` gate: client/peer nodes run
 * inside Electron as well as browsers. Inactive on `'host'` and when the
 * setting is false.
 */
export declare function installRemoteWorkspaceVisibility(ctx: ClientContext, options?: RemoteWorkspaceVisibilityOptions): void;
//# sourceMappingURL=remote-workspace-visibility.d.ts.map