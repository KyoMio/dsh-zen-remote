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
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { RemoteStatusStore } from '../client-data/remote-status.ts';
import { NS } from './locales.ts';
export interface RemoteComposerBannerProps extends PropsRuntime<'conversation.input.dock'>, PropsLocale<typeof NS> {
    /** The shared remote-status store, bound through the registration's inject
     * face. */
    status: RemoteStatusStore;
    /** Raise or clear THIS session's composer block (the host conversation
     * service's `blocks.set`, bound per session by the registration). `undefined`
     * clears. A composition whose conversation service is absent (no composer)
     * gets a no-op binding — the banner still renders, the disable degrades. */
    setComposerBlock: (reason: string | undefined) => void;
}
export declare function RemoteComposerBanner({ sessionId, status, t, setComposerBlock }: RemoteComposerBannerProps): import("react").JSX.Element | null;
//# sourceMappingURL=RemoteComposerBanner.d.ts.map