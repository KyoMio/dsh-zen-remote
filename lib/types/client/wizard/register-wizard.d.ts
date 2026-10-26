/**
 * Wizard registration for the plugin DETAIL page — the piece that must
 * run BEFORE apply's desktop-shell gate (same discipline as
 * register-settings.ts, and for the same reason: the desktop app IS the
 * main server, and the wizard is exactly where it is most useful).
 *
 * Registered on `plugins.bundle.config` (keyed by `'dsh-zen-remote'`), which
 * `PackageDetail` renders as the FIRST section at the top of the bundle
 * detail page (above `RowsSection`「插件组件」and `SourceSection`「来源」),
 * and which `RowDetail` (the component detail page) never renders.
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
         * One bundle's top configuration block on the plugin DETAIL page — a
         * keyed seat (`key = pkg.name`) rendered at the top of `PackageDetail`
         * above the component rows and source sections, and absent from
         * `RowDetail` (structural mirror of the plugin-manager's declaration).
         */
        'plugins.bundle.config': {
            kind: 'keyed';
            scope: 'root';
            owner: {
                readonly view: 'page';
            };
        };
    }
}
/** `plugins.bundle.config` key: the bundle's package name. */
export declare const WIZARD_BUNDLE_KEY = "dsh-zen-remote";
export interface SaveRowFieldsOptions {
    /** Field names to remove (`op: 'unset'`) in the same atomic mutation. */
    unset?: readonly string[];
}
/**
 * Register the wizard stylesheet and (lazily, only where the settings
 * service exists) the bundle detail-page top block.
 * @param ctx - client root context.
 * @param section - the block component; a parameter so this module stays
 *   JSX-free and importable under Node's type stripping.
 */
export declare function registerGatewayWizard(ctx: ClientContext, section: typeof GatewayWizard): void;
//# sourceMappingURL=register-wizard.d.ts.map