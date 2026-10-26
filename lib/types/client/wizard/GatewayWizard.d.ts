/**
 * GatewayWizard (GW-10): the unified three-step remote-access & device-pairing
 * guide at the top of the plugin detail page (`plugins.bundle.config`,
 * `key: 'dsh-zen-remote'`).
 *
 * Covers both deployment roles in one entry point:
 * - Server (`host`): choose the ingress method (Caddy / Reverse Proxy /
 *   Cloudflare Tunnel / LAN & Tailscale), configure parameters + server
 *   display name & auto-share, verify connectivity, and pair either a
 *   Phone/Browser (QR code) or another Desktop DSH Client (8-character
 *   desktop pairing code + live paired-client list).
 * - Desktop Client (`client`): enter the server gateway URL + 8-character
 *   desktop pairing code to claim a device token, and verify live
 *   connection & session-sync status.
 */
import type { ReactNode } from 'react';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ZenRemoteSettingsForm } from '../../client-data/settings-form.ts';
import { NS } from '../locales.ts';
export interface GatewayWizardProps extends PropsRuntime<'plugins.bundle.config'>, PropsLocale<typeof NS> {
    /** The row's staged-form controller — saved-role source of truth. */
    config: ZenRemoteSettingsForm;
    /** One atomic row write (the wiring stages through configForms.mutate). */
    saveRowFields: (fields: Record<string, unknown>) => Promise<void>;
}
export declare function GatewayWizard(props: GatewayWizardProps): ReactNode;
//# sourceMappingURL=GatewayWizard.d.ts.map