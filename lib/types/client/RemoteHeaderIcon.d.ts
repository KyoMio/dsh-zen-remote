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
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SharesStore } from '../client-data/shares.ts';
import { NS } from './locales.ts';
export interface RemoteHeaderIconProps extends PropsRuntime<'conversation.session.header.actions'>, PropsLocale<typeof NS> {
    /** The shared shares store, bound through the registration's inject face. */
    shares: SharesStore;
}
export declare function RemoteHeaderIcon({ sessionId, shares, t }: RemoteHeaderIconProps): import("react").JSX.Element | null;
//# sourceMappingURL=RemoteHeaderIcon.d.ts.map