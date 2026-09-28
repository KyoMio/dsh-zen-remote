/**
 * Config resolution for dsh-zen-remote: one flat key space, four layers.
 *
 * 2.0.0 moved the settings surface to the DSH plugin row (the loader-owned
 * `Config` schema below), while long-time users keep their
 * `<DSH_HOME>/lan-gate.config.json`. The agreed contract is resolve-time
 * fallback — nothing is ever written back — and per field the first LEGAL
 * value wins in this order:
 *
 *   1. environment variables (`LAN_GATE_*` / `DSH_PUSH_*`, historic names)
 *   2. the plugin row (what the loader hands `apply()`)
 *   3. `lan-gate.config.json`
 *   4. defaults
 *
 * A value that fails its field's check (type, range, enum) makes that layer
 * transparent, as if it had never been set — a hand-edited `port: "abc"` in
 * the row therefore surfaces the file's port, not an error. Legal ranges are
 * enforced HERE and nowhere else. The loader's `Config` schema below is
 * deliberately not a validator: every field is `z.any()` (secret/volatile
 * markers aside), because a schemastery type mismatch makes the loader reject
 * the WHOLE row and the plugin never loads at all — violating the T11 design
 * that a botched `role` degrades to host instead of breaking the plugin.
 * `Config` only tells the settings form WHICH fields exist, which one is a
 * secret, and which are volatile; `resolveConfig` owns every legality rule.
 *
 * Pure logic: no writes, no `process.env` mutation. The one deliberate read
 * is `os.hostname()` for the `serverName` default, which the DEFAULTS table
 * is specified to embed.
 */
import z from '@deepseek-ai/schemastery';
/** Where a resolved field value came from, in resolution order. */
export type ConfigSource = 'env' | 'row' | 'file' | 'default';
/** The effective configuration one resolved value set, defaults included. */
export interface ZenRemoteConfig {
    /** Which half of the plugin runs in this DSH process; anything the layers
     * leave unresolved means `'host'` (see {@link resolveRole}). */
    role: 'host' | 'client';
    /** Port the gateway child listens on. */
    port: number;
    /** Bind address of the gateway child. */
    host: string;
    /** Port of the local DSH Web UI the gateway forwards to; undefined means
     * "discover the host's real listening port at gateway start". */
    targetPort: number | undefined;
    /** Remote requests per minute per pairing before 429. */
    rateLimit: number;
    /** Comma-separated proxy IPs the gateway trusts for X-Forwarded-*. */
    trustedProxies: string;
    /** VAPID subject (a `mailto:` or `https:` URL identifying the push sender). */
    vapidSubject: string;
    /** Notification/UI language: `'auto'` defers to the requester's signal. */
    lang: 'auto' | 'zh' | 'en';
    /** Comma-separated session events the push leg treats as turn end. */
    pushEvents: string;
    /** Minimum milliseconds between two pushes (approval/question legs exempt). */
    pushDebounceMs: number;
    /** Include the turn's final text (or pending question) in push bodies. */
    pushSummary: boolean;
    /** Push when a top-level turn ends (opt-in: finishing is not an alarm). */
    pushTurnEnd: boolean;
    /** Register the model-facing `push_notify` tool. */
    pushTool: boolean;
    /** Server display name, at most {@link SERVER_NAME_MAX} characters. */
    serverName: string;
    /** Idle-sleep window of a remote-enabled session: after this many hours
     * without new activity the remote connection closes on its own; running or
     * waiting sessions never count. (0, 8760]. */
    idleHours: number;
    /** Auto-share every newly created session to the paired phone (T16). */
    autoShareNewSessions: boolean;
}
/** Defaults, one per field — exactly what layer 4 hands back. */
export declare const DEFAULTS: ZenRemoteConfig;
/**
 * Peel the loader's volatile wrapper off a row value. Schemastery hands
 * `.volatile()` fields to apply() as cosmokit `{ get() }` reference objects,
 * NOT as the value itself — a wrapper run through a validator unchecked would
 * fail every check and the row layer would silently never win for those
 * fields. Anything with a callable `get` is unwrapped; everything else passes
 * through (the same duck-typing the verifier plugin's settingsOf uses, so no
 * dependency on the wrapper's symbol protocol). Later tasks that read live
 * settings at operation time use this too.
 */
export declare function unwrapVolatile(value: unknown): unknown;
/**
 * The effective configuration: every field resolved through the four layers.
 * @param row - the plugin row config as `apply()` received it (loosely typed
 *   because the loader's parsed shape and hand-edited YAML differ).
 * @param file - the parsed `lan-gate.config.json`, `{}` when absent.
 * @param env - environment carrying the optional `LAN_GATE_*` / `DSH_PUSH_*`
 *   variables.
 * @returns the merged values plus, per field, the layer it came from.
 */
export declare function resolveConfig(row: unknown, file: Record<string, unknown>, env: NodeJS.ProcessEnv): {
    values: ZenRemoteConfig;
    sources: Record<keyof ZenRemoteConfig, ConfigSource>;
};
/**
 * Read `<DSH_HOME>/lan-gate.config.json` (DSH_HOME defaulting to `~/.dsh`).
 * Missing file, unparsable JSON, or a non-object root (arrays included) all
 * yield `{}` — a broken file must degrade to defaults, never take the host
 * process down. Never writes.
 * @param env - environment providing DSH_HOME; defaults to `process.env`.
 */
export declare function readFileConfig(env?: NodeJS.ProcessEnv): Record<string, unknown>;
/**
 * The normalized role behind a row's `role` knob. Anything but the exact
 * string `'client'` means host, so a typo degrades to the full plugin rather
 * than silently dropping the gateway and push halves. Resolution-order note:
 * {@link resolveConfig} validates each layer against the two-member enum
 * first, so an invalid row role can still be rescued by the file layer; this
 * function answers the final merged value. Kept on the main entry's export
 * surface for test/role-wiring.test.cjs.
 */
export declare function resolveRole(row: unknown): 'host' | 'client';
/**
 * The DSH loader's config schema for the plugin row: what the settings form
 * renders and what it hands `apply()`. Every field is `z.any()` on purpose —
 * legality is entirely {@link resolveConfig}'s job. A schemastery type
 * mismatch (`z.number()` meeting `port: "abc"`) makes the loader throw away
 * the whole row and the plugin never loads, which would break the T11
 * promise that a botched `role` degrades to host instead of killing the
 * plugin. So this schema only declares: WHICH fields exist (the form's
 * field list), WHICH one is a secret (`deviceToken`, redacted from every
 * settings wire surface), and that every field is volatile (live).
 *
 * No `.default()` anywhere: a schema default would be written into every row
 * at load and `lan-gate.config.json`'s fallback would never get a turn — the
 * real defaults live in {@link DEFAULTS}.
 *
 * EVERY field is volatile, and that is not an optimization: DSH 0.2.0's
 * settings service builds the form from volatile fields ONLY (its
 * `volatileForm` drops non-volatile ones, and a `mutate` outside the volatile
 * subtree is refused), so a non-volatile field is invisible in the settings
 * page and unsaveable from it — T12 made the restart-required fields
 * non-volatile and the whole settings surface went dark for them. The cost
 * is that the loader hands every volatile field to `apply()` as a `{ get() }`
 * wrapper instead of the value, so EVERY row read goes through
 * {@link unwrapVolatile} at use time (or through {@link resolveConfig},
 * which unwraps per field). "Changed value requires a restart" therefore
 * cannot ride the volatility flag: the fields in
 * `RESTART_FIELDS` (src/restart-watcher.ts) are re-resolved on a 2-second
 * poll and reload the plugin row when their fingerprint moves — a row reload
 * re-runs `apply()`, which restarts the gateway child and the push half.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    role: z<any, any, "volatile">;
    port: z<any, any, "volatile">;
    host: z<any, any, "volatile">;
    targetPort: z<any, any, "volatile">;
    rateLimit: z<any, any, "volatile">;
    trustedProxies: z<any, any, "volatile">;
    vapidSubject: z<any, any, "volatile">;
    lang: z<any, any, "volatile">;
    pushEvents: z<any, any, "volatile">;
    pushDebounceMs: z<any, any, "volatile">;
    pushSummary: z<any, any, "volatile">;
    pushTurnEnd: z<any, any, "volatile">;
    pushTool: z<any, any, "volatile">;
    serverName: z<any, any, "volatile">;
    idleHours: z<any, any, "volatile">;
    autoShareNewSessions: z<any, any, "volatile">;
    serverUrl: z<any, any, "volatile">;
    deviceToken: z<string, string, "volatile">;
    turnFoldDesktop: z<any, any, "volatile">;
    keyboardLiftRatio: z<any, any, "volatile">;
    keyboardLiftMaxPx: z<any, any, "volatile">;
    keyboardSafetyPadPx: z<any, any, "volatile">;
    maxUploadBytes: z<any, any, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    role: z<any, any, "volatile">;
    port: z<any, any, "volatile">;
    host: z<any, any, "volatile">;
    targetPort: z<any, any, "volatile">;
    rateLimit: z<any, any, "volatile">;
    trustedProxies: z<any, any, "volatile">;
    vapidSubject: z<any, any, "volatile">;
    lang: z<any, any, "volatile">;
    pushEvents: z<any, any, "volatile">;
    pushDebounceMs: z<any, any, "volatile">;
    pushSummary: z<any, any, "volatile">;
    pushTurnEnd: z<any, any, "volatile">;
    pushTool: z<any, any, "volatile">;
    serverName: z<any, any, "volatile">;
    idleHours: z<any, any, "volatile">;
    autoShareNewSessions: z<any, any, "volatile">;
    serverUrl: z<any, any, "volatile">;
    deviceToken: z<string, string, "volatile">;
    turnFoldDesktop: z<any, any, "volatile">;
    keyboardLiftRatio: z<any, any, "volatile">;
    keyboardLiftMaxPx: z<any, any, "volatile">;
    keyboardSafetyPadPx: z<any, any, "volatile">;
    maxUploadBytes: z<any, any, "volatile">;
}>>, "plain">;
//# sourceMappingURL=config.d.ts.map