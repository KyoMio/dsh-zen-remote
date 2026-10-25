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
import type { ClientContext } from '../compat/types.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the renderer declares `ctx.slots` on the cordis Context.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ZenRemoteSettingsForm } from '../../client-data/settings-form.ts'
import { NS } from '../locales.ts'
import { SETTINGS_ENTRY_ID } from '../settings/register-settings.ts'
import { WIZARD_CSS } from './wizard-css.ts'
import type { GatewayWizard } from './GatewayWizard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One plugin's section on the plugin DETAIL page — a list seat whose
     * entries receive the page's subject (structural mirror of the
     * plugin-manager's declaration).
     */
    'plugins.detail.section': {
      kind: 'list'
      scope: 'root'
      owner: { readonly kind: string; readonly pkg?: { readonly name: string } | null }
    }
  }
}

/** List order on the detail page: below the manager's own header blocks. */
const WIZARD_SECTION_ORDER = 50

/**
 * Register the wizard stylesheet and (lazily, only where the settings
 * service exists) the detail-page section.
 * @param ctx - client root context.
 * @param section - the block component; a parameter so this module stays
 *   JSX-free and importable under Node's type stripping.
 */
export function registerGatewayWizard(ctx: ClientContext, section: typeof GatewayWizard): void {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-zen-remote-wizard'
    tag.textContent = WIZARD_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dsh-zen-remote: wizard styles')

  ctx.inject(['configForms'], (formsCtx) => {
    const scope = formsCtx.configForms.get(SETTINGS_ENTRY_ID)
    // The wizard's OWN form controller (its saved-role read and its row
    // writes live here) — separate from the settings block's instance so
    // neither's staged state can bleed into the other.
    const config = new ZenRemoteSettingsForm(scope, () => false)
    formsCtx.effect(() => () => { config.dispose() }, 'dsh-zen-remote: wizard form')
    // One atomic row write per save: the wizard fields are volatile
    // live-read fields (not in RESTART_FIELDS), so saving reloads nothing.
    const saveRowFields = async (fields: Record<string, unknown>): Promise<void> => {
      const snapshot = scope.getSnapshot()
      await scope.mutate(
        Object.entries(fields).map(([key, value]) => ({ op: 'set' as const, path: [key], value })),
        snapshot.revision,
      )
    }
    formsCtx.effect(() => formsCtx.slots.inject('plugins.detail.section', () => formsCtx.slots.register({
      name: 'plugins.detail.section',
      id: 'zr-wizard',
      order: WIZARD_SECTION_ORDER,
      locale: NS,
      inject: () => ({ config, saveRowFields }),
    }, section)), 'dsh-zen-remote: wizard section')
  })
}
