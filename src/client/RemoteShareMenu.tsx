/**
 * Session "…" menu item for remote sharing (T33b entry 1) — one
 * `sidebar.workspaces.session.menu.item` row beside the official
 * pin/rename/fork/archive rows, reading the same shared shares store as the
 * title-row icon and the settings list: 「开启远程」 when the session is not
 * in the table, 「关闭远程」 when it is. No confirmation on either — the
 * menu IS the deliberate action (the confirm lives on the title-row icon).
 * The row closes the menu itself through the slot's `useMenuOpenState`
 * hook, exactly like the official entries do. A refused action alerts the
 * mapped reason (shareFailText).
 *
 * Hidden until the FIRST GET has answered (T33b-fix: an unshared session
 * must not read as 「开启远程」 while the table is still in flight), on a
 * non-host role (the registration wires the store's role from the same
 * two-level decision the settings page makes), and on subagent children:
 * the server refuses to share them alone, and the row can tell from the
 * standard sessions table (`origin: 'subagent'`). The sidebar filters those
 * rows anyway — this is defense in depth.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { IconLinkOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { shareFailText } from '../client-data/shares.ts'
import type { SharesStore } from '../client-data/shares.ts'
import { NS } from './locales.ts'

export interface RemoteShareMenuProps extends PropsRuntime<'sidebar.workspaces.session.menu.item'>, PropsLocale<typeof NS> {
  /** The shared shares store, bound through the registration's inject face. */
  shares: SharesStore
}

export function RemoteShareMenuItem({ sessionId, shares, useSessions, useMenuOpenState, t }: RemoteShareMenuProps) {
  const [, setMenuOpen] = useMenuOpenState()
  const snap = useSyncExternalStore(
    useCallback((onStoreChange: () => void) => shares.subscribe(onStoreChange), [shares]),
    () => shares.getSnapshot(),
  )
  const row = useSessions((sessions) => sessions.byId[sessionId])
  if (!snap.ready || snap.role !== 'host' || row?.origin === 'subagent') return null
  const shared = snap.entries.some((entry) => entry.sessionId === sessionId)
  return (
    <MenuItemButton
      icon={<IconLinkOutlineRegular />}
      separatorBefore
      onSelect={() => {
        setMenuOpen(false)
        const action = shared ? 'unshare' as const : 'share' as const
        void (shared ? shares.unshare(sessionId) : shares.share(sessionId)).then((outcome) => {
          if (!outcome.ok) window.alert(shareFailText(outcome, action, t))
        })
      }}
    >
      {t(shared ? 'shareRemoteOff' : 'shareRemoteOn')}
    </MenuItemButton>
  )
}
