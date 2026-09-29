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
import type { ClientContext } from '../compat/types.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the renderer declares `ctx.slots` on the cordis Context.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DEVICE_TOKEN_FIELD, ZenRemoteSettingsForm } from '../../client-data/settings-form.ts'
import { getSharesStore } from '../../client-data/shares.ts'
import { NS, en, zh } from '../locales.ts'
import { SETTINGS_CSS } from './settings-css.ts'
import type { SettingsSection } from './SettingsSection.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The configuration of one row a bundle declares, keyed by
     * `<package name>#<row id>` — structural mirror of the plugin-manager's
     * real declaration (kind keyed, root scope, owner carries the view flag).
     */
    'plugins.row.config': {
      kind: 'keyed'
      scope: 'root'
      owner: { readonly view: 'summary' | 'page' }
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The shared per-entry configuration forms (ui-settings service). */
    configForms: import('../../client-data/settings-form.ts').ConfigFormsLike
  }
}

/** Settings entry (= profile entry id = bundle row id) this page edits. */
export const SETTINGS_ENTRY_ID = 'dsh-zen-remote'

/** `plugins.row.config` key: <package name>#<row id> as the bundle patch declares the row. */
export const SETTINGS_ROW_KEY = 'dsh-zen-remote#dsh-zen-remote'

/**
 * Register the dictionaries, the settings stylesheet, and (lazily, only where
 * the settings service exists) the plugin-row configuration block.
 * @param ctx - client root context.
 * @param section - the block component; a parameter so this module stays
 *   JSX-free and importable under Node's type stripping.
 */
export function registerSettingsPage(ctx: ClientContext, section: typeof SettingsSection): void {
  // Dictionaries first: the registration below declares `locale: NS`, and the
  // phone shell (behind the desktop gate) reads the same namespace.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mobile-nav: dictionaries')

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-zen-remote-settings'
    tag.textContent = SETTINGS_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dsh-zen-remote: settings styles')

  // The Configure control exists exactly while the Host serves the entry
  // (whileServed also waits out the mirror's first read). The form controller
  // lives inside this inject: without the service there is nothing to stage
  // over, and the plugin row must still load.
  ctx.inject(['configForms'], (formsCtx) => {
    const scope = formsCtx.configForms.get(SETTINGS_ENTRY_ID)
    // The device token's configured flag rides the describe view's secrets
    // sidecar: the key literal never rides a response, so presence is all
    // the client learns (same seam as dsh-llm-verifier). A token can be
    // written or cleared from elsewhere (pairing runs through the same
    // entry); the scope subscription misses a secrets-only move, so follow
    // the describe mirror too.
    const describe = formsCtx.configForms.describe()
    const secretConfigured = (): boolean => {
      const namespaces = describe.getSnapshot().view?.namespaces ?? []
      const row = namespaces.find((candidate) => candidate.ns === SETTINGS_ENTRY_ID)
      return (row?.secrets ?? []).some(
        (secret) => secret.path.length === 1 && secret.path[0] === DEVICE_TOKEN_FIELD && secret.set,
      )
    }
    const config = new ZenRemoteSettingsForm(scope, secretConfigured)
    // The controller holds a scope subscription; release it (and the
    // describe follow) when the fiber that built it is disposed.
    const offDescribe = describe.subscribe(() => { config.refresh() })
    formsCtx.effect(() => () => { offDescribe(); config.dispose() }, 'dsh-zen-remote: settings form')
    formsCtx.effect(() => formsCtx.configForms.whileServed([SETTINGS_ENTRY_ID], () =>
      formsCtx.slots.inject('plugins.row.config', () => formsCtx.slots.register({
        name: 'plugins.row.config',
        key: SETTINGS_ROW_KEY,
        locale: NS,
        // The T33b shared-session list rides the same shares store singleton
        // as the title-row icon and the session menu — one poll loop total.
        inject: () => ({ config, shares: getSharesStore() }),
      }, section)),
    ), 'dsh-zen-remote: row config page')
  })
}
