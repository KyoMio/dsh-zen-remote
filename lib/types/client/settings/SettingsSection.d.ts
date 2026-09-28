/**
 * The dsh-zen-remote plugin row's settings block on the Plugins manager
 * (T15 + T15-fix): the staged row fields (role, gateway & reverse proxy,
 * push, remote sharing) inside the official settings-form frame ending in its
 * one save control, and BELOW the form — outside it, so they still render
 * when the configuration namespace is not served — the instant-operation
 * areas: gateway status line, pairing, device list, push probe and the
 * remote-sharing placeholder. Those POST the same-origin admin routes and
 * re-read `admin/status`; only field edits stage and save through
 * `ZenRemoteSettingsForm`.
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