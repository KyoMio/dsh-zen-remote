/**
 * The plugin bridge's settings-page pure pieces (PB-5): the status → copy
 * mapping the 子客户端诊断区 renders, and the consent-toggle arithmetic the
 * 主服务端插件桥 section stages. Pure by the settings-form discipline — no
 * fetch, no clock, no context — so scripts/check-plugin-bridge-ui.mjs pins
 * every copy and every toggle shape.
 *
 * Deliberately import-free: this file rides the BROWSER bundle, and the
 * bridge's own module (src/plugin-bridge.ts) drags node:crypto in. The
 * status shape is therefore restated structurally here — it mirrors
 * lib/plugin-bridge.js's `BridgeStatus` verbatim, and a drifted wire is
 * handled by the tolerant mapping, not by the type system.
 */

/** One plugin's bridge verdict, exactly the shape `client/status`'s
 * `pluginBridge` array carries (PB-2). */
export interface PluginBridgeStatusLike {
  plugin: string
  bridged: boolean
  reason?: string
  localVersion: string
  serverVersion?: string
}

/** One row of the 诊断区's 插件桥 group: the plugin, its LOCAL version, and
 * the copy key (plus the interpolation value) the locale renders. */
export interface PluginBridgeStatusView {
  plugin: string
  localVersion: string
  /** The locale key under `settings.bridge.state*`. */
  stateKey: PluginBridgeStateKey
  /** The server's version, when the verdict names one (版本不同's copy). */
  serverVersion: string | undefined
}

export type PluginBridgeStateKey =
  | 'settings.bridge.stateBridged'
  | 'settings.bridge.stateNotOnServer'
  | 'settings.bridge.stateVersionMismatch'
  | 'settings.bridge.stateDeclarationMismatch'
  | 'settings.bridge.stateConsentOff'
  | 'settings.bridge.stateOffline'
  | 'settings.bridge.stateServerTooOld'

/** The reason → copy-key table, one entry per BridgeReason plus the
 * everything-else fallback (an unknown reason from a newer server reads as
 * 未桥接-generic — the offline copy, honest without inventing a claim). */
const REASON_KEYS: Readonly<Record<string, PluginBridgeStateKey>> = {
  'not-on-server': 'settings.bridge.stateNotOnServer',
  'version-mismatch': 'settings.bridge.stateVersionMismatch',
  'declaration-mismatch': 'settings.bridge.stateDeclarationMismatch',
  'consent-off': 'settings.bridge.stateConsentOff',
  offline: 'settings.bridge.stateOffline',
  'server-too-old': 'settings.bridge.stateServerTooOld',
}

/** Tolerant read of one `pluginBridge` wire array into the render rows,
 * input order kept (the route already sorts by plugin name). A malformed
 * entry is skipped, never thrown into the settings page. */
export function derivePluginBridgeStatuses(value: unknown): PluginBridgeStatusView[] {
  if (!Array.isArray(value)) return []
  const rows: PluginBridgeStatusView[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.plugin !== 'string' || record.plugin === '') continue
    const bridged = record.bridged === true
    const reason = typeof record.reason === 'string' ? record.reason : undefined
    rows.push({
      plugin: record.plugin,
      localVersion: typeof record.localVersion === 'string' ? record.localVersion : '',
      stateKey: bridged
        ? 'settings.bridge.stateBridged'
        : reason !== undefined && REASON_KEYS[reason] !== undefined
          ? REASON_KEYS[reason]
          : 'settings.bridge.stateOffline',
      serverVersion: typeof record.serverVersion === 'string' ? record.serverVersion : undefined,
    })
  }
  return rows
}

/**
 * The three-state resolution for the host settings page's 插件桥 list
 * (PB-9-fix): a fetch that has not answered is LOADING, a failed or
 * refused fetch is an ERROR — and only a successful answer with zero rows
 * means "no plugin has registered a bridge". Collapsing the first two into
 * the empty copy would tell the user nothing is bridged while the answer is
 * simply not in yet (or the page was opened through the gateway, where the
 * listing is refused). Pure so the check pins all four outcomes.
 */
export function bridgeSectionState(load: 'loading' | 'error' | 'ready', rows: unknown): 'loading' | 'error' | 'empty' | 'plugins' {
  if (load === 'loading') return 'loading'
  if (load === 'error') return 'error'
  return Array.isArray(rows) && rows.length > 0 ? 'plugins' : 'empty'
}

/**
 * One consent-toggle click: the NEXT whole-machine-data consent map, staged
 * over the row's `pluginBridgeConsent` field. Only `plugin`'s key moves —
 * every other key (including entries for plugins no longer registered; the
 * settings page deliberately never prunes what it does not render) is
 * carried over verbatim, in its existing key order. An illegal current map
 * (a hand-edited row) reads as the empty map: the toggle then writes exactly
 * one key, and the junk is left for the row validator to keep refusing.
 */
export function togglePluginConsent(current: unknown, plugin: string, allow: boolean): Record<string, boolean> {
  const next: Record<string, boolean> = {}
  if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (typeof value === 'boolean') next[key] = value
    }
  }
  next[plugin] = allow
  return next
}

/** One row of the host settings page's 插件桥 list, as the admin listing
 * answers it (PB-5: plugin/version/hasServerScope/consent; PB-11 adds the
 * adapter mark). */
export interface AdminBridgeRowView {
  plugin: string
  version: string
  hasServerScope: boolean
  consent: boolean
  /** True when zen-remote's own adapter stands in for this plugin (the
   * row renders「由 zen-remote 适配」); a wiring that predates adapters
   * never sets it. */
  adapted: boolean
}

/**
 * Tolerant read of one admin listing row into the render shape (PB-11).
 * A malformed row is `undefined`, never a throw — the settings page skips
 * it the same way {@link derivePluginBridgeStatuses} skips a bad verdict.
 * `adapted` defaults to false: an older server's answer simply reads as
 * "nothing is adapted".
 */
export function readAdminBridgeRow(row: unknown): AdminBridgeRowView | undefined {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined
  const record = row as Record<string, unknown>
  if (typeof record.plugin !== 'string' || record.plugin === '') return undefined
  return {
    plugin: record.plugin,
    version: typeof record.version === 'string' ? record.version : '',
    hasServerScope: record.hasServerScope === true,
    consent: record.consent === true,
    adapted: record.adapted === true,
  }
}
