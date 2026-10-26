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
import type { ClientContext } from '../compat/types.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the renderer declares `ctx.slots` on the cordis Context.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DEVICE_TOKEN_FIELD, ZenRemoteSettingsForm } from '../../client-data/settings-form.ts'
import { NS } from '../locales.ts'
import { SETTINGS_ENTRY_ID } from '../settings/register-settings.ts'
import { WIZARD_CSS } from './wizard-css.ts'
import type { GatewayWizard } from './GatewayWizard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One bundle's top configuration block on the plugin DETAIL page — a
     * keyed seat (`key = pkg.name`) rendered at the top of `PackageDetail`
     * above the component rows and source sections, and absent from
     * `RowDetail` (structural mirror of the plugin-manager's declaration).
     */
    'plugins.bundle.config': {
      kind: 'keyed'
      scope: 'root'
      owner: { readonly view: 'page' }
    }
  }
}

/** `plugins.bundle.config` key: the bundle's package name. */
export const WIZARD_BUNDLE_KEY = 'dsh-zen-remote'

/**
 * Register the wizard stylesheet and (lazily, only where the settings
 * service exists) the bundle detail-page top block.
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
    // Follow the describe sidecar when available so client-mode pairing can
    // see whether `deviceToken` is configured (degrades to false in minimal
    // test harnesses that omit `describe`).
    const describe = typeof formsCtx.configForms.describe === 'function' ? formsCtx.configForms.describe() : undefined
    const secretConfigured = (): boolean => {
      const namespaces = describe?.getSnapshot().view?.namespaces ?? []
      const row = namespaces.find((candidate) => candidate.ns === SETTINGS_ENTRY_ID)
      return (row?.secrets ?? []).some(
        (secret) => secret.path.length === 1 && secret.path[0] === DEVICE_TOKEN_FIELD && secret.set,
      )
    }
    const config = new ZenRemoteSettingsForm(scope, secretConfigured)
    const offDescribe = describe !== undefined ? describe.subscribe(() => { config.refresh() }) : () => {}
    formsCtx.effect(() => () => { offDescribe(); config.dispose() }, 'dsh-zen-remote: wizard form')
    // One atomic row write per save: the wizard fields are volatile
    // live-read fields (not in RESTART_FIELDS), so saving reloads nothing.
    const saveRowFields = async (fields: Record<string, unknown>): Promise<void> => {
      const snapshot = scope.getSnapshot()
      await scope.mutate(
        Object.entries(fields).map(([key, value]) => ({ op: 'set' as const, path: [key], value })),
        snapshot.revision,
      )
    }
    formsCtx.effect(() => formsCtx.slots.inject('plugins.bundle.config', () => formsCtx.slots.register({
      name: 'plugins.bundle.config',
      key: WIZARD_BUNDLE_KEY,
      locale: NS,
      inject: () => ({ config, saveRowFields }),
    }, section)), 'dsh-zen-remote: wizard section')
  })
}
