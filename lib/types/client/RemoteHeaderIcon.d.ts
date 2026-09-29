/**
 * Title-row remote-status icon (T33b entry 2) — one
 * `conversation.session.header.actions` entry drawn entirely off the shared
 * shares store: grey = not shared, brand colour = shared, brand colour plus
 * a green dot = a desktop client is currently viewing (`viewers > 0`). The
 * native `title` carries the hover prompt (idle time left, or the busy
 * copy); clicking toggles the share behind a `window.confirm` — the desktop
 * app is the main server, and Electron answers confirm (its missing dialog
 * method is prompt, not confirm — the settings page's confirms run there).
 * A refused action (subagent child, contentless session, anything else)
 * alerts the mapped reason (shareFailText).
 *
 * Renders NOTHING while the table has never answered, on a non-host role
 * (the registration wires the store's role from the same two-level decision
 * the settings page makes — row document first, client-config probe as the
 * fallback), and on a subagent session, which the server refuses to share
 * alone (T33b-fix: same rule as the menu item).
 *
 * On the phone shell (a non-desktop-shell viewport at or under 767px) the
 * mobile stylesheet blanket-hides every `conversation.session.header.actions`
 * entry that is not the phone header's own (styles/header.css.ts), so this
 * icon would never be seen — it does not SUBSCRIBE there either
 * (subscribeIfNotPhoneShell): the subscription is what keeps the shares
 * store polling, so the phone shell never sends the 30 s admin/shares GET
 * through the gateway. On a desktop shell the phone CSS never applies
 * (apply's gate returns before installing it), so the icon stays a live
 * surface at any window width there.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SharesStore } from '../client-data/shares.ts';
import { NS } from './locales.ts';
export interface RemoteHeaderIconProps extends PropsRuntime<'conversation.session.header.actions'>, PropsLocale<typeof NS> {
    /** The shared shares store, bound through the registration's inject face. */
    shares: SharesStore;
}
export declare function RemoteHeaderIcon({ sessionId, shares, useSessions, t }: RemoteHeaderIconProps): import("react").JSX.Element | null;
//# sourceMappingURL=RemoteHeaderIcon.d.ts.map