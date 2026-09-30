/**
 * Registration for the T33b session-sharing parts — the work that must run
 * BEFORE apply's desktop-shell gate (the desktop app IS the main server:
 * its title row and session menus are exactly where these parts live),
 * extracted so the Node-side desktop-gate test can drive it against a fake
 * ctx (the components are .tsx; they arrive as parameters, keeping this
 * module JSX-free and importable under Node's type stripping — the same
 * trick register-settings.ts uses).
 *
 * Registers the title-row remote icon on
 * `conversation.session.header.actions` (order 25, past the official jobs
 * entry at 20 so the two never tie) and the remote toggle on
 * `sidebar.workspaces.session.menu.item` (order 500, under the official
 * archive row, behind a group hairline), plus the one stylesheet both
 * surfaces need.
 *
 * The parts render and poll only on the HOST role (T33b-fix): this module
 * wires the shares store's role from the SAME two-level decision the
 * settings page makes (settings-form.ts's shared `settingsRoleOf`) — the
 * configForms row document first, and while the row is silent the effective
 * role probed from `/_dsh/mobile-nav/client-config` (T17: the route carries
 * the merged role). The decision re-runs on every scope snapshot update, so
 * a snapshot that resolves late — or a row whose role appears after the
 * probe already answered — re-decides, and a deployment switched back to
 * host recovers. The wiring hangs off a lazy `ctx.inject(['configForms'], …)`;
 * where the settings service never arrives, one fallback probe wires the
 * role on its own (guarded: a snapshot answer always wins over it).
 *
 * The `sidebar.workspaces.session.menu.item` SlotMap entry is declared here
 * as a structural mirror: this package does not depend on
 * dsh-client-ui-workspace (the slot's owner), whose type-only merges would
 * normally provide it. The mirror records what the workspace browser
 * actually hands its entries: the row props (`sessionId`, `displayTitle`),
 * the `[open, setOpen]` pair it passes as the render occurrence's
 * hookContext, and the list-level inject whose `menuOpenState` hook factory
 * binds that pair — official rows call it `useMenuOpenState` and close the
 * menu with it.
 */
import type { ReactNode } from 'react';
import type { SessionId } from './compat/types.ts';
import type { ClientContext } from './compat/types.ts';
import type { SharesStore } from '../client-data/shares.ts';
import type { RemoteHeaderIconProps } from './RemoteHeaderIcon.tsx';
import type { RemoteShareMenuProps } from './RemoteShareMenu.tsx';
/** The `[open, setOpen]` pair the workspace Menu hands every row entry. */
export type SessionMenuOpenState = readonly [boolean, (open: boolean) => void];
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        'sidebar.workspaces.session.menu.item': {
            kind: 'list';
            scope: 'root';
            owner: {
                sessionId: SessionId;
                displayTitle: string;
            };
            hookContext: SessionMenuOpenState;
            inject: {
                hooks: {
                    menuOpenState: (context: unknown) => () => SessionMenuOpenState;
                };
            };
        };
    }
}
/** The header icon component (a .tsx factory result; parameter for Node). */
export type RemoteHeaderIconComponent = (props: RemoteHeaderIconProps) => ReactNode;
/** The menu-item component (a .tsx factory result; parameter for Node). */
export type RemoteShareMenuComponent = (props: RemoteShareMenuProps) => ReactNode;
export declare function probeClientConfigRole(refetch?: boolean): Promise<'host' | 'client' | undefined>;
/** How one probe is issued — the real route reader, or the check/test
 * double. `refetch` mirrors {@link probeClientConfigRole}: true drops any
 * cached answer and asks again. */
export type ClientConfigProbe = (refetch?: boolean) => Promise<'host' | 'client' | undefined>;
export interface WireSharesRoleOptions {
    /** Called once a definite verdict was applied (the no-configForms
     * fallback checks this before trusting its own probe). */
    onVerdict?: () => void;
    /** The probe to consult while the row document is silent. Defaults to
     * the real client-config reader; tests inject a controllable double so
     * they never depend on module-level probe state. */
    probe?: ClientConfigProbe;
}
/**
 * Wire a shares store's role off one configForms scope: the saved row role
 * wins (settingsRoleOf), while the row is silent the client-config probe
 * fills the gap, and every scope update re-decides. Verdicts of
 * `'unknown'` — snapshot still loading, probe pending or FAILED — leave
 * the store untouched: nothing polls and nothing renders (never a guessed
 * host). A scope STATUS change (loading→ready, a mirror resync) drops the
 * probe answer and probes again, the same two signals the settings page's
 * probe effect re-runs on.
 * @param scope - the plugin row's shared configuration form scope.
 * @param store - the shares store whose role this wiring drives.
 * @param options - verdict callback and probe injection.
 * @returns disposer releasing the scope subscription.
 */
export declare function wireSharesRole(scope: {
    getSnapshot(): {
        status: 'loading' | 'ready' | 'unavailable';
        value?: unknown;
        user?: unknown;
    };
    subscribe(listener: () => void): () => void;
}, store: Pick<SharesStore, 'setRole'>, options?: WireSharesRoleOptions): () => void;
/**
 * Register the stylesheet and the two sharing parts. Gate-independent by
 * design — the caller (apply) places this before its desktop gate.
 * @param ctx - client root context.
 * @param headerIcon - the title-row icon component.
 * @param menuItem - the session-menu toggle component.
 */
export declare function registerRemoteShareUi(ctx: ClientContext, headerIcon: RemoteHeaderIconComponent, menuItem: RemoteShareMenuComponent): void;
//# sourceMappingURL=remote-share-register.d.ts.map