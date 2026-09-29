/**
 * The composer's remote-status banner for the sub-client (T34) — one
 * `conversation.input.dock` entry, the official full-width row ABOVE the
 * input card (the slot anchor is display:contents, so this renders as one
 * row of the composer column, ahead of the card). When the open session is a
 * remote one and the server is offline, the token is revoked, the pairing
 * is gone, or the server closed this session's remote access (T41a-fix2
 * added the revoked / unpaired lines), the banner names why.
 *
 * The INPUT itself is disabled through the host's own component capability
 * (T34-fix): `ctx.conversation.blocks.set(sessionId, { reason })` — the
 * composer-block contract (`contract/composer-blocks.d.ts` in
 * dsh-client-ui-conversation, "the registry face other plugins reach through
 * `ctx.conversation.blocks`"). A raised block makes InputBar's `blocked`
 * path disable the editor, the send button and the model controls, and
 * shows the block's `reason` as the placeholder text; `set(id, undefined)`
 * clears it. While the banner stands the block is raised with the banner's
 * own copy, and the cleanup clears it — so a restored link re-enables the
 * composer without any host DOM touching.
 *
 * Renders NOTHING on a local session, before the store's first answered GET,
 * and whenever neither the offline nor a closed reason applies (then the
 * block is cleared too). A local session also never SUBSCRIBES
 * (subscribeIfVirtual): the subscription is what keeps the store polling,
 * so a page showing only local sessions never sends a remote-status
 * request.
 */

import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { bannerText, subscribeIfVirtual } from '../client-data/remote-status.ts'
import type { RemoteStatusStore } from '../client-data/remote-status.ts'
import { isVirtual } from '../virtual-id.js'
import { NS } from './locales.ts'

export interface RemoteComposerBannerProps extends PropsRuntime<'conversation.input.dock'>, PropsLocale<typeof NS> {
  /** The shared remote-status store, bound through the registration's inject
   * face. */
  status: RemoteStatusStore
  /** Raise or clear THIS session's composer block (the host conversation
   * service's `blocks.set`, bound per session by the registration). `undefined`
   * clears. A composition whose conversation service is absent (no composer)
   * gets a no-op binding — the banner still renders, the disable degrades. */
  setComposerBlock: (reason: string | undefined) => void
}

export function RemoteComposerBanner({ sessionId, status, t, setComposerBlock }: RemoteComposerBannerProps) {
  // The subscription is virtual-id gated (subscribeIfVirtual) — hooks stay
  // above the render gate.
  const snap = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => subscribeIfVirtual(status, sessionId, onStoreChange),
      [status, sessionId],
    ),
    () => status.getSnapshot(),
  )
  const virtual = isVirtual(sessionId)
  const text = virtual && snap.ready ? bannerText(snap.view, sessionId, t) : undefined
  // Raise the block in the same commit that draws the banner (layout effect:
  // before paint). The cleanup is what restores the composer — when the
  // link recovers, the session closes, or the component unmounts, the block
  // goes with it.
  useLayoutEffect(() => {
    if (text === undefined) return
    setComposerBlock(text)
    return () => {
      setComposerBlock(undefined)
    }
  }, [text, sessionId, setComposerBlock])
  if (!virtual || !snap.ready || text === undefined) return null
  return (
    <div className="zr-remote-banner" data-zen-remote="remote-banner" role="status">
      {text}
    </div>
  )
}
