/**
 * Wizard registration for the plugin DETAIL page — the piece that must
 * run BEFORE apply's desktop-shell gate (same discipline as
 * register-settings.ts, and for the same reason: the desktop app IS the
 * main server, and the wizard is exactly where it is most useful).
 *
 * The `plugins.detail.section` SlotMap entry is a structural mirror: this
 * package does not depend on dsh-client-ui-plugin-manager, whose type-only
 * merges normally declare the slot (same trick as `plugins.row.config` in
 * register-settings.ts). The component itself filters its subject
 * (`kind === 'row'` + `pkg.name === 'dsh-zen-remote'`) and the saved row
 * role, so a foreign section, a sub-client deployment and the phone shell
 * all render nothing.
 *
 * `configForms` never joins the top-level inject: a composition without
 * the settings service keeps the whole browser half loadable, and the lazy
 * `ctx.inject(['configForms'], …)` below simply never fires there — a
 * composition that cannot stage row edits has no use for a wizard that
 * writes rows.
 */
import type { ClientContext } from '../compat/types.ts';
import type { GatewayWizard } from './GatewayWizard.tsx';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        /**
         * One plugin's section on the plugin DETAIL page — a list seat whose
         * entries receive the page's subject (structural mirror of the
         * plugin-manager's declaration).
         */
        'plugins.detail.section': {
            kind: 'list';
            scope: 'root';
            owner: {
                readonly kind: string;
                readonly pkg?: {
                    readonly name: string;
                } | null;
            };
        };
    }
}
/**
 * Register the wizard stylesheet and (lazily, only where the settings
 * service exists) the detail-page section.
 * @param ctx - client root context.
 * @param section - the block component; a parameter so this module stays
 *   JSX-free and importable under Node's type stripping.
 */
export declare function registerGatewayWizard(ctx: ClientContext, section: typeof GatewayWizard): void;
//# sourceMappingURL=register-wizard.d.ts.map