/**
 * Registration for the T34 sub-client status parts — the work that must run
 * BEFORE apply's desktop gate (a desktop app in the client role has remote
 * sessions too), extracted so the Node-side desktop-gate test can drive it
 * against a fake ctx (the components are .tsx; they arrive as parameters,
 * keeping this module JSX-free and importable under Node's type stripping —
 * the same trick register-settings.ts / remote-share-register.ts use).
 *
 * Registers the title-row connection icon on
 * `conversation.session.header.actions` (order 26, past the T33b share icon
 * at 25 so the two never tie) and the composer banner on
 * `conversation.input.dock` (order 15, between the official todo panel at 0
 * and the queue dock at 20), plus the one stylesheet both surfaces need.
 *
 * The banner's disable rides the HOST's composer-block contract (T34-fix):
 * the inject face hands the component a per-session `setComposerBlock`
 * binding over `ctx.conversation.blocks` (dsh-client-ui-conversation's
 * `ComposerBlocks`, resolved lazily at call time — the row context may still
 * be assembling when this registration runs, and the composer that consumes
 * the block is the conversation plugin's own UI, so the service is there by
 * the time a banner can stand). A composition without the service degrades
 * to a no-op binding: the banner still renders, the disable is simply absent.
 *
 * No role wiring here, unlike the T33b parts: the store only polls while a
 * part is SUBSCRIBED, and both parts gate the subscription itself on the
 * virtual id (remote-status.ts's subscribeIfVirtual — a local session never
 * opens one) — so a host page never polls, without needing the settings
 * role to tell it apart.
 */
import type { ReactNode } from 'react'
import type { ClientContext, SessionId } from './compat/types.ts'
import { getRemoteStatusStore } from '../client-data/remote-status.ts'
import { NS } from './locales.ts'
import { REMOTE_STATUS_CSS } from './remote-status-css.ts'
import type { RemoteStatusIconProps } from './RemoteStatusIcon.tsx'
import type { RemoteComposerBannerProps } from './RemoteComposerBanner.tsx'

/** The icon component (a .tsx factory result; parameter for Node). */
export type RemoteStatusIconComponent = (props: RemoteStatusIconProps) => ReactNode
/** The composer banner component (a .tsx factory result; parameter for Node). */
export type RemoteComposerBannerComponent = (props: RemoteComposerBannerProps) => ReactNode

/**
 * The one face of `ctx.conversation.blocks` (dsh-client-ui-conversation,
 * `contract/composer-blocks.d.ts`) this plugin uses. A structural mirror:
 * the providing package is a peerDependency whose type-only merges the
 * tsconfig paths already pull in for slots, but the service itself is read
 * lazily through `ctx.get` — the mirror keeps this module honest without
 * hard-depending on the host's type layout.
 */
interface ComposerBlocksLike {
  set(sessionId: SessionId, block: { readonly reason: string } | undefined): void
}

/** Resolve the composer-block registry at CALL time, or undefined where the
 * conversation service never arrived (compositions without a composer — or a
 * context shape without the lazy getter at all). */
function composerBlocksOf(ctx: ClientContext): ComposerBlocksLike | undefined {
  if (typeof ctx.get !== 'function') return undefined
  const conversation = ctx.get('conversation') as { blocks?: ComposerBlocksLike } | undefined
  return conversation?.blocks
}

/**
 * Register the stylesheet and the two status parts. Gate-independent by
 * design — the caller (apply) places this before its desktop gate.
 * @param ctx - client root context.
 * @param icon - the title-row connection icon component.
 * @param banner - the composer banner component.
 */
export function registerRemoteStatusUi(
  ctx: ClientContext,
  icon: RemoteStatusIconComponent,
  banner: RemoteComposerBannerComponent,
): void {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-zen-remote-remote-status'
    tag.textContent = REMOTE_STATUS_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dsh-zen-remote: remote-status styles')

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'remote-status-icon',
    order: 26,
    locale: NS,
    inject: () => ({ status: getRemoteStatusStore() }),
  }, icon))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'remote-status-banner',
    order: 15,
    locale: NS,
    inject: (sessionId: SessionId) => ({
      status: getRemoteStatusStore(),
      // Raise/clear THIS session's composer block (undefined clears — the
      // contract's own clear method; `forget` would drop the store
      // entirely and is the host's teardown verb, not ours).
      setComposerBlock: (reason: string | undefined) => {
        composerBlocksOf(ctx)?.set(sessionId, reason === undefined ? undefined : { reason })
      },
    }),
  }, banner))
}
