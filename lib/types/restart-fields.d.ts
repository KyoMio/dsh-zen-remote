/**
 * The plugin row fields whose changed value must reload the row to take
 * effect (T17): `role` chooses which halves load; `port` / `host` /
 * `targetPort` / `rateLimit` / `trustedProxies` become the gateway child's
 * runtime shape; `vapidSubject` / `lang` / `pushEvents` / `pushDebounceMs` /
 * `pushSummary` / `pushTurnEnd` / `pushTool` are the push leg's startup
 * values. Everything else (serverName, idleHours, autoShareNewSessions,
 * serverUrl, deviceToken, and the interface-half knobs) is read live per use
 * and needs no reload.
 *
 * Single source shared by both halves: the host's restart watcher
 * (src/restart-watcher.ts) fingerprints exactly these fields, and the
 * settings page (src/client-data/settings-form.ts) shows the "saving reloads
 * the plugin" note while one of them has a staged change. Deliberately
 * dependency-free — the client bundler inlines every reachable module, so
 * this file must never import node builtins or schemastery, which is why the
 * list does not live in src/config.ts (T17b).
 */
export declare const RESTART_FIELDS: readonly ["role", "port", "host", "targetPort", "rateLimit", "trustedProxies", "vapidSubject", "lang", "pushEvents", "pushDebounceMs", "pushSummary", "pushTurnEnd", "pushTool"];
/** One field of {@link RESTART_FIELDS}. */
export type RestartField = (typeof RESTART_FIELDS)[number];
//# sourceMappingURL=restart-fields.d.ts.map