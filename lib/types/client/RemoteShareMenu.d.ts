/**
 * Session "…" menu item for remote sharing (T33b entry 1) — one
 * `sidebar.workspaces.session.menu.item` row beside the official
 * pin/rename/fork/archive rows, reading the same shared shares store as the
 * title-row icon and the settings list: 「开启远程」 when the session is not
 * in the table, 「关闭远程」 when it is. No confirmation on either — the
 * menu IS the deliberate action (the confirm lives on the title-row icon).
 * The row closes the menu itself through the slot's `useMenuOpenState`
 * hook, exactly like the official entries do.
 *
 * Hidden on client deployments (`available` latches false on the route's
 * 404 — the shares route exists only on the host role) and on subagent
 * children: the server refuses to share them alone, and the row can tell
 * from the standard sessions table (`origin: 'subagent'`). The sidebar
 * filters those rows anyway — this is defense in depth.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SharesStore } from '../client-data/shares.ts';
import { NS } from './locales.ts';
export interface RemoteShareMenuProps extends PropsRuntime<'sidebar.workspaces.session.menu.item'>, PropsLocale<typeof NS> {
    /** The shared shares store, bound through the registration's inject face. */
    shares: SharesStore;
}
export declare function RemoteShareMenuItem({ sessionId, shares, useSessions, useMenuOpenState, t }: RemoteShareMenuProps): import("react").JSX.Element | null;
//# sourceMappingURL=RemoteShareMenu.d.ts.map