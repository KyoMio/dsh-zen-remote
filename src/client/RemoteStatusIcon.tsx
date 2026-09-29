/**
 * Title-row remote CONNECTION icon for the sub-client (T34) — one
 * `conversation.session.header.actions` entry beside the T33b share icon,
 * drawn entirely off the shared remote-status store: lit (brand colour) =
 * the relay is online, grey = the link is down (offline / connecting /
 * incompatible), dim grey = `revoked` / `unpaired` — states of their own
 * (T34-fix): the hover and the click say the precise word, never
 * "reconnecting", because neither recovers without a user action — and
 * yellow = online but the interface fingerprints differ. The native `title`
 * carries the hover prompt; clicking closes the session's remote access from
 * THIS machine behind a `window.confirm` (the backend forwards it to the
 * server as an unshare with reason `client`). While the link is not serving
 * the click only explains itself — there is nothing to reach.
 *
 * Renders NOTHING on a local session (the id is not a virtual id), so the
 * two roles' icons never appear at once, and nothing before the store's
 * first answered GET. A local session also never SUBSCRIBES
 * (subscribeIfVirtual): the subscription is what keeps the store polling,
 * so a page showing only local sessions never sends a remote-status
 * request.
 *
 * On the phone shell no rule of its own is needed: the mobile stylesheet
 * blanket-hides every `conversation.session.header.actions` entry that is
 * not the phone header's own (styles/header.css.ts), so this icon is a
 * desktop(-browser) surface, exactly like the T33b share icon beside it.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { describeRemoteStatus, subscribeIfVirtual } from '../client-data/remote-status.ts'
import type { RemoteStatusStore } from '../client-data/remote-status.ts'
import { isVirtual } from '../virtual-id.js'
import { NS } from './locales.ts'

export interface RemoteStatusIconProps extends PropsRuntime<'conversation.session.header.actions'>, PropsLocale<typeof NS> {
  /** The shared remote-status store, bound through the registration's inject
   * face. */
  status: RemoteStatusStore
}

export function RemoteStatusIcon({ sessionId, status, t }: RemoteStatusIconProps) {
  // The subscription is virtual-id gated (subscribeIfVirtual) — hooks stay
  // above the render gate; the button additionally waits for a remote
  // session and the store's first answered GET.
  const snap = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => subscribeIfVirtual(status, sessionId, onStoreChange),
      [status, sessionId],
    ),
    () => status.getSnapshot(),
  )
  // The explicit virtual-id gate stays: the page-wide store's snapshot can
  // still be ready from a PREVIOUS remote session when a local one opens.
  if (!isVirtual(sessionId) || !snap.ready) return null
  const description = describeRemoteStatus(snap.view, t)
  const close = (): void => {
    // Offline recovers on its own; revoked / unpaired do not (T34-fix) —
    // each says its own word instead of "reconnecting".
    if (description.state === 'offline') {
      window.alert(t('remoteStatusOfflineClick'))
      return
    }
    if (description.state === 'revoked' || description.state === 'unpaired') {
      window.alert(description.hoverText)
      return
    }
    if (!window.confirm(t('remoteStatusUnshareConfirm'))) return
    void status.unshare(sessionId).then((outcome) => {
      if (outcome.ok) return
      // A refused close names the backend's error code when it sent one —
      // the locale line carries the placeholder (each language its own
      // brackets), never a hardcoded concatenation.
      if (outcome.code === undefined) window.alert(t('remoteStatusUnshareFail'))
      else window.alert(t('remoteStatusUnshareFailCode', { code: outcome.code }))
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
