/**
 * GatewayWizard (GW-10): the「让手机连上来」three-step flow on the plugin
 * detail page — pick the ingress path, fill its form, verify end to end.
 *
 * Mount-point contract: registered on `plugins.detail.section` BEFORE the
 * desktop gate (the desktop app IS the main server — the wizard is exactly
 * where it is most useful). The subject filter (`kind === 'row'` +
 * `pkg.name === 'dsh-zen-remote'`) and the saved-role check
 * (`config.savedRoleIsClient()`) both render null, so a foreign row, a
 * sub-client deployment and the phone shell all see nothing.
 *
 * Remote-read rule: when `admin/status` answers with `viaGateway: true`
 * (the page is open through the gateway), everything disables behind a
 * notice — the wizard is a server-owner surface, same wall as its routes.
 *
 * Polling discipline (same as the settings block): a failed refresh keeps
 * the last ready data; verification polls stop at a terminal verdict
 * (pass / cookie-insecure / code-expired / stale) and the countdown ticks
 * only while a pairing code is live. The QR code contains the public URL
 * only — never the pairing code, which stays plain text beside it.
 */
import type { ReactNode } from 'react';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ZenRemoteSettingsForm } from '../../client-data/settings-form.ts';
import { NS } from '../locales.ts';
export interface GatewayWizardProps extends PropsRuntime<'plugins.detail.section'>, PropsLocale<typeof NS> {
    /** The row's staged-form controller — saved-role source of truth. */
    config: ZenRemoteSettingsForm;
    /** One atomic row write (the wiring stages through configForms.mutate). */
    saveRowFields: (fields: Record<string, unknown>) => Promise<void>;
}
export declare function GatewayWizard(props: GatewayWizardProps): ReactNode;
//# sourceMappingURL=GatewayWizard.d.ts.map