/**
 * The dsh-zen-remote plugin row's settings block on the Plugins manager
 * (T15 + T15-fix + T16): the staged row fields inside the official
 * settings-form frame ending in its one save control, and BELOW the form —
 * outside it, so they still render when the configuration namespace is not
 * served — the instant-operation areas. Which areas render follows the row's
 * SAVED role, read from the configForms snapshot's row document — never from
 * a status body (T16-fix 3): a host shows gateway status, pairing, device
 * list and the push probe (POSTing the same-origin admin routes and
 * re-reading `admin/status`); a client shows the server connection form, the
 * connection status line and unpairing (against `client/status`, T16) and
 * NEVER polls `admin/*` — on a client deployment those routes do not exist,
 * and a stale kept body would pin the page to the old role. The poll choice
 * waits out the snapshot's loading state for the same reason. Only field
 * edits stage and save through `ZenRemoteSettingsForm`.
 *
 * Status refreshes never clear what is already on screen (T15-fix 1): a
 * failed refresh keeps the last ready data and says so in a banner — only a
 * failed FIRST load enters the error state, because saving a non-hot field
 * restarts the plugin row and the first post-save refresh can land inside
 * that restart window (a second pull follows 1.5s later). Every status
 * request carries a latest-wins ticket (T15-fix 4), so an earlier request
 * that answers late cannot overwrite newer data.
 *
 * Opened through the gateway (`viaGateway`, i.e. on a phone or another
 * browser) the server-local buttons disable and a notice says so — and until
 * one status load answers from the server itself, they count as remote. The
 * summary view renders its one-liner alone and never fetches a thing.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ZenRemoteSettingsForm } from '../../client-data/settings-form.ts';
import { NS } from '../locales.ts';
export interface SettingsSectionProps extends PropsRuntime<'plugins.row.config'>, PropsLocale<typeof NS> {
    /** The staged configuration form (injected share). */
    config: ZenRemoteSettingsForm;
}
export declare function SettingsSection(props: SettingsSectionProps): import("react").JSX.Element;
//# sourceMappingURL=SettingsSection.d.ts.map