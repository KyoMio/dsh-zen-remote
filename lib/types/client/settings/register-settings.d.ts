/**
 * Settings-page registration for the plugin row — the work that must run
 * BEFORE apply's desktop-shell gate, extracted so the Node-side desktop-gate
 * test can drive it against a fake ctx (src/client/index.tsx is a .tsx: Node
 * cannot import JSX, so apply itself is untestable there).
 *
 * Two constraints shape it:
 * - `configForms` must never join the top-level `export const inject`: in a
 *   composition without the settings service (0.1.x web), a required service
 *   would keep the whole browser half from loading. The lazy
 *   `ctx.inject(['configForms'], …)` below simply never fires there.
 * - The registration (and the dictionaries it needs) must survive the desktop
 *   gate: the desktop app IS the main server, so its Plugins page still shows
 *   this block while the phone shell stays switched off behind the gate.
 *
 * The `plugins.row.config` SlotMap entry and the `configForms` Context member
 * are declared here as structural mirrors: this package does not depend on
 * dsh-client-ui-plugin-manager / dsh-client-ui-settings, whose type-only
 * merges normally provide them (same trick as the local SlotsCompat /
 * UiWorkspaceLike faces elsewhere in this plugin).
 */
import type { ClientContext } from '../compat/types.ts';
import type { SettingsSection } from './SettingsSection.tsx';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        /**
         * The configuration of one row a bundle declares, keyed by
         * `<package name>#<row id>` — structural mirror of the plugin-manager's
         * real declaration (kind keyed, root scope, owner carries the view flag).
         */
        'plugins.row.config': {
            kind: 'keyed';
            scope: 'root';
            owner: {
                readonly view: 'summary' | 'page';
            };
        };
    }
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** The shared per-entry configuration forms (ui-settings service). */
        configForms: import('../../client-data/settings-form.ts').ConfigFormsLike;
    }
}
/** Settings entry (= profile entry id = bundle row id) this page edits. */
export declare const SETTINGS_ENTRY_ID = "dsh-zen-remote";
/** `plugins.row.config` key: <package name>#<row id> as the bundle patch declares the row. */
export declare const SETTINGS_ROW_KEY = "dsh-zen-remote#dsh-zen-remote";
/**
 * Register the dictionaries, the settings stylesheet, and (lazily, only where
 * the settings service exists) the plugin-row configuration block.
 * @param ctx - client root context.
 * @param section - the block component; a parameter so this module stays
 *   JSX-free and importable under Node's type stripping.
 */
export declare function registerSettingsPage(ctx: ClientContext, section: typeof SettingsSection): void;
//# sourceMappingURL=register-settings.d.ts.map