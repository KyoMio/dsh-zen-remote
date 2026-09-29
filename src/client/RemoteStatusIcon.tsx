/**
 * Title-row remote CONNECTION icon for the sub-client (T34) — one
 * `conversation.session.header.actions` entry beside the T33b share icon,
 * drawn entirely off the shared remote-status store: lit (brand colour) =
 * the relay is online, grey = the link is down (offline / connecting /
 * incompatible, and also `revoked` / `unpaired` — the group title carries
 * the precise word), yellow = online but the interface fingerprints differ.
 * The native `title` carries the hover prompt; clicking closes the session's
 * remote access from THIS machine behind a `window.confirm` (the backend
 * forwards it to the server as an unshare with reason `client`). While the
 * link is down the click only explains itself — there is nothing to reach.
 *
 * Renders NOTHING on a local session (the id is not a virtual id), so the
 * two roles' icons never appear at once, and nothing before the store's
 * first answered GET.
 *
 * On the phone shell no rule of its own is needed: the mobile stylesheet
 * blanket-hides every `conversation.session.header.actions` entry that is
 * not the phone header's own (styles/header.css.ts), so this icon is a
 * desktop(-browser) surface, exactly like the T33b share icon beside it.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { describeRemoteStatus } from '../client-data/remote-status.ts'
import type { RemoteStatusStore, RemoteUnshareOutcome } from '../client-data/remote-status.ts'
import { isVirtual } from '../virtual-id.js'
import { NS } from './locales.ts'

export interface RemoteStatusIconProps extends PropsRuntime<'conversation.session.header.actions'>, PropsLocale<typeof NS> {
  /** The shared remote-status store, bound through the registration's inject
   * face. */
  status: RemoteStatusStore
}

/** The one-line alert for a refused close (T34): the generic copy plus the
 * backend's error code when it named one — short, and diagnosable. */
function unshareFailText(outcome: RemoteUnshareOutcome, text: string): string {
  return outcome.ok || outcome.code === undefined ? text : `${text}（${outcome.code}）`
}

export function RemoteStatusIcon({ sessionId, status, t }: RemoteStatusIconProps) {
  const snap = useSyncExternalStore(
    useCallback((onStoreChange: () => void) => status.subscribe(onStoreChange), [status]),
    () => status.getSnapshot(),
  )
  // Hooks stay above the gate: the subscription exists on every render path,
  // the button only for a virtual-id session with an answered GET. (The
  // subscription is also what keeps the store polling — a page showing only
  // local sessions never subscribes, so a host never polls.)
  if (!isVirtual(sessionId) || !snap.ready) return null
  const description = describeRemoteStatus(snap.view, t)
  const close = (): void => {
    if (description.state === 'offline') {
      window.alert(t('remoteStatusOfflineClick'))
      return
    }
    if (!window.confirm(t('remoteStatusUnshareConfirm'))) return
    void status.unshare(sessionId).then((outcome) => {
      if (!outcome.ok) window.alert(unshareFailText(outcome, t('remoteStatusUnshareFail')))
    })
  }
  return (
    <button
      type="button"
      className="zr-remote-status"
      data-zen-remote="remote-status"
      data-state={description.state}
      title={description.hoverText}
      aria-label={description.hoverText}
      onClick={close}
    >
      <IconGlobeOutlineRegular size={16} />
    </button>
  )
}
