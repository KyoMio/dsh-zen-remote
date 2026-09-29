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
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { RemoteStatusStore } from '../client-data/remote-status.ts';
import { NS } from './locales.ts';
export interface RemoteStatusIconProps extends PropsRuntime<'conversation.session.header.actions'>, PropsLocale<typeof NS> {
    /** The shared remote-status store, bound through the registration's inject
     * face. */
    status: RemoteStatusStore;
}
export declare function RemoteStatusIcon({ sessionId, status, t }: RemoteStatusIconProps): import("react").JSX.Element | null;
//# sourceMappingURL=RemoteStatusIcon.d.ts.map