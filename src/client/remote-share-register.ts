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
 * `conversation.session.header.actions` (order 20, beside the official
 * jobs entry) and the remote toggle on
 * `sidebar.workspaces.session.menu.item` (order 500, under the official
 * archive row, behind a group hairline), plus the one stylesheet both
 * surfaces need. No new service is required — the parts read the shared
 * shares store singleton (src/client-data/shares.ts) over plain fetch, so
 * there is nothing to inject and nothing that can keep the plugin from
 * loading.
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
import type { ReactNode } from 'react'
import type { SessionId } from './compat/types.ts'
import type { ClientContext } from './compat/types.ts'
import { getSharesStore } from '../client-data/shares.ts'
import { NS } from './locales.ts'
import { REMOTE_SHARE_CSS } from './remote-share-css.ts'
import type { RemoteHeaderIconProps } from './RemoteHeaderIcon.tsx'
import type { RemoteShareMenuProps } from './RemoteShareMenu.tsx'

/** The `[open, setOpen]` pair the workspace Menu hands every row entry. */
export type SessionMenuOpenState = readonly [boolean, (open: boolean) => void]

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.workspaces.session.menu.item': {
      kind: 'list'
      scope: 'root'
      owner: { sessionId: SessionId, displayTitle: string }
      hookContext: SessionMenuOpenState
      inject: { hooks: { menuOpenState: (context: unknown) => () => SessionMenuOpenState } }
    }
  }
}

/** The header icon component (a .tsx factory result; parameter for Node). */
export type RemoteHeaderIconComponent = (props: RemoteHeaderIconProps) => ReactNode
/** The menu-item component (a .tsx factory result; parameter for Node). */
export type RemoteShareMenuComponent = (props: RemoteShareMenuProps) => ReactNode

/**
 * Register the stylesheet and the two sharing parts. Gate-independent by
 * design — the caller (apply) places this before its desktop gate.
 * @param ctx - client root context.
 * @param headerIcon - the title-row icon component.
 * @param menuItem - the session-menu toggle component.
 */
export function registerRemoteShareUi(
  ctx: ClientContext,
  headerIcon: RemoteHeaderIconComponent,
  menuItem: RemoteShareMenuComponent,
): void {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-zen-remote-remote-share'
    tag.textContent = REMOTE_SHARE_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dsh-zen-remote: remote-share styles')

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'remote-share-icon',
    order: 20,
    locale: NS,
    inject: () => ({ shares: getSharesStore() }),
  }, headerIcon))

  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'remote-share',
    order: 500,
    locale: NS,
    inject: () => ({ shares: getSharesStore() }),
  }, menuItem))
}
