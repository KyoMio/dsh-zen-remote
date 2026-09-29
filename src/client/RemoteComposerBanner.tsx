/**
 * The composer's remote-status banner for the sub-client (T34) — one
 * `conversation.input.dock` entry, the official full-width row ABOVE the
 * input card (the slot anchor is display:contents, so this renders as one
 * row of the composer column, ahead of the card). When the open session is a
 * remote one and the server is offline, or the server closed this session's
 * remote access, the banner names why; while it shows, the composer card is
 * disabled.
 *
 * Why the disable is a CSS override instead of a slot/component capability:
 * the host composer's own disabled machinery (`blocked` /
 * ComposerBlockRegistry in dsh-client-ui-conversation) is module-internal —
 * created inside the conversation plugin's fiber, unreachable from another
 * plugin's context, and InputBar's `disabled` prop is computed by
 * ConversationRoot from its own state. What the host DOES publish is two
 * stable contract markers: `data-composer-seat` around the composer and
 * `data-composer-card` on the input card. The banner marks the SEAT — found
 * by walking UP from its own DOM position (`closest`), never by guessing
 * host layer counts (AGENTS.md) — and the remote-status stylesheet dims and
 * de-pointers that seat's card. The interceptor's `remote-offline` refusal
 * remains the real enforcement; this is the display half, so a one-frame
 * tolerance is honest here and the marking runs in a layout effect (before
 * paint — no flash of an enabled composer).
 *
 * Renders NOTHING on a local session, before the store's first answered GET,
 * and whenever neither the offline nor a closed reason applies.
 */

import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { bannerText } from '../client-data/remote-status.ts'
import type { RemoteStatusStore } from '../client-data/remote-status.ts'
import { isVirtual } from '../virtual-id.js'
import { NS } from './locales.ts'

export interface RemoteComposerBannerProps extends PropsRuntime<'conversation.input.dock'>, PropsLocale<typeof NS> {
  /** The shared remote-status store, bound through the registration's inject
   * face. */
  status: RemoteStatusStore
}

export function RemoteComposerBanner({ sessionId, status, t }: RemoteComposerBannerProps) {
  const snap = useSyncExternalStore(
    useCallback((onStoreChange: () => void) => status.subscribe(onStoreChange), [status]),
    () => status.getSnapshot(),
  )
  const rootRef = useRef<HTMLDivElement | null>(null)
  const virtual = isVirtual(sessionId)
  const text = virtual && snap.ready ? bannerText(snap.view, sessionId, t) : undefined
  // Mark the composer seat for the stylesheet while the banner stands.
  // Layout effect: the attribute lands in the same commit, before paint.
  useLayoutEffect(() => {
    if (text === undefined) return
    const seat = rootRef.current?.closest('[data-composer-seat]')
    if (seat === null || seat === undefined) return
    seat.setAttribute('data-zr-remote-readonly', '')
    return () => {
      seat.removeAttribute('data-zr-remote-readonly')
    }
  }, [text, sessionId])
  if (!virtual || !snap.ready || text === undefined) return null
  return (
    <div ref={rootRef} className="zr-remote-banner" data-zen-remote="remote-banner" role="status">
      {text}
    </div>
  )
}
