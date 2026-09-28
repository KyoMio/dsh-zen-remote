/**
 * Title-row remote-status icon (T33b entry 2) — one
 * `conversation.session.header.actions` entry drawn entirely off the shared
 * shares store: grey = not shared, brand colour = shared, brand colour plus
 * a green dot = a desktop client is currently viewing (`viewers > 0`). The
 * native `title` carries the hover prompt (idle time left, or the busy
 * copy); clicking toggles the share behind a `window.confirm` — the desktop
 * app is the main server, and Electron answers confirm (its missing dialog
 * method is prompt, not confirm — the settings page's confirms run there).
 *
 * Renders NOTHING while the table has never answered (no wrong-state flash)
 * and on a `404`-latched deployment: the shares route exists only on the
 * host role, so "no route" is the client-role gate for this part — the
 * sub-client's own remote affordances are T34's.
 *
 * On the phone shell no rule of its own is needed: the mobile stylesheet
 * blanket-hides every `conversation.session.header.actions` entry that is
 * not the phone header's own (styles/header.css.ts), so this icon is a
 * desktop(-browser) surface, exactly like the official jobs pill.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { describeShare } from '../client-data/shares.ts'
import type { SharesStore } from '../client-data/shares.ts'
import { NS } from './locales.ts'

export interface RemoteHeaderIconProps extends PropsRuntime<'conversation.session.header.actions'>, PropsLocale<typeof NS> {
  /** The shared shares store, bound through the registration's inject face. */
  shares: SharesStore
}

export function RemoteHeaderIcon({ sessionId, shares, t }: RemoteHeaderIconProps) {
  const snap = useSyncExternalStore(
    useCallback((onStoreChange: () => void) => shares.subscribe(onStoreChange), [shares]),
    () => shares.getSnapshot(),
  )
  // Hooks stay above the gate: the subscription must exist on every render
  // path, the button only on a host with a ready table.
  if (!snap.ready || !snap.available) return null
  const entry = snap.entries.find((candidate) => candidate.sessionId === sessionId)
  const description = describeShare(entry, Date.now(), t)
  const toggle = (): void => {
    if (entry === undefined) {
      if (window.confirm(t('shareRemoteConfirmOn'))) void shares.share(sessionId)
    } else if (window.confirm(t('shareRemoteConfirmOff'))) {
      void shares.unshare(sessionId)
    }
  }
  return (
    <button
      type="button"
      className="zr-remote-toggle"
      data-zen-remote="remote-toggle"
      data-state={description.state}
      title={description.remainingText}
      aria-label={description.remainingText}
      onClick={toggle}
    >
      <IconGlobeOutlineRegular size={16} />
    </button>
  )
}
