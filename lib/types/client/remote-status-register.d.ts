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
 * part is SUBSCRIBED, and both parts subscribe only for a virtual-id session
 * (the icon and banner render nothing on local sessions) — so a host page
 * never polls, without needing the settings role to tell it apart.
 */
import type { ReactNode } from 'react';
import type { ClientContext } from './compat/types.ts';
import type { RemoteStatusIconProps } from './RemoteStatusIcon.tsx';
import type { RemoteComposerBannerProps } from './RemoteComposerBanner.tsx';
/** The icon component (a .tsx factory result; parameter for Node). */
export type RemoteStatusIconComponent = (props: RemoteStatusIconProps) => ReactNode;
/** The composer banner component (a .tsx factory result; parameter for Node). */
export type RemoteComposerBannerComponent = (props: RemoteComposerBannerProps) => ReactNode;
/**
 * Register the stylesheet and the two status parts. Gate-independent by
 * design — the caller (apply) places this before its desktop gate.
 * @param ctx - client root context.
 * @param icon - the title-row connection icon component.
 * @param banner - the composer banner component.
 */
export declare function registerRemoteStatusUi(ctx: ClientContext, icon: RemoteStatusIconComponent, banner: RemoteComposerBannerComponent): void;
//# sourceMappingURL=remote-status-register.d.ts.map