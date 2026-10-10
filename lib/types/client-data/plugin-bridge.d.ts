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
    plugin: string;
    bridged: boolean;
    reason?: string;
    localVersion: string;
    serverVersion?: string;
}
/** One row of the 诊断区's 插件桥 group: the plugin, its LOCAL version, and
 * the copy key (plus the interpolation value) the locale renders. */
export interface PluginBridgeStatusView {
    plugin: string;
    localVersion: string;
    /** The locale key under `settings.bridge.state*`. */
    stateKey: PluginBridgeStateKey;
    /** The server's version, when the verdict names one (版本不同's copy). */
    serverVersion: string | undefined;
}
export type PluginBridgeStateKey = 'settings.bridge.stateBridged' | 'settings.bridge.stateNotOnServer' | 'settings.bridge.stateVersionMismatch' | 'settings.bridge.stateDeclarationMismatch' | 'settings.bridge.stateConsentOff' | 'settings.bridge.stateOffline' | 'settings.bridge.stateServerTooOld';
/** Tolerant read of one `pluginBridge` wire array into the render rows,
 * input order kept (the route already sorts by plugin name). A malformed
 * entry is skipped, never thrown into the settings page. */
export declare function derivePluginBridgeStatuses(value: unknown): PluginBridgeStatusView[];
/**
 * One consent-toggle click: the NEXT whole-machine-data consent map, staged
 * over the row's `pluginBridgeConsent` field. Only `plugin`'s key moves —
 * every other key (including entries for plugins no longer registered; the
 * settings page deliberately never prunes what it does not render) is
 * carried over verbatim, in its existing key order. An illegal current map
 * (a hand-edited row) reads as the empty map: the toggle then writes exactly
 * one key, and the junk is left for the row validator to keep refusing.
 */
export declare function togglePluginConsent(current: unknown, plugin: string, allow: boolean): Record<string, boolean>;
//# sourceMappingURL=plugin-bridge.d.ts.map