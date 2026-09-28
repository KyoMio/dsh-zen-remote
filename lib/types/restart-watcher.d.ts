/**
 * Auto-reload of the plugin row when a "needs restart" config field changes
 * (T17). Every Config field is volatile (src/config.ts — DSH's settings
 * service only surfaces volatile fields), so "this value only takes effect
 * after the row re-runs apply()" can no longer ride the volatility flag.
 * Instead the host half re-resolves the effective config and compares a
 * fingerprint over exactly the restart-required fields; a changed fingerprint
 * reloads the row via cordis, which re-runs `apply()` and with it the gateway
 * child and the push half. The comparison runs on two triggers (T17b): the
 * loader's `loader/volatile-update` event (a settings save that only moves
 * volatile fields commits without a restart and announces itself — the
 * immediate path) and a 2s poll (the fallback for lan-gate.config.json and
 * environment changes, which no loader event ever covers).
 *
 * Pure logic — no imports beyond src/restart-fields.ts and src/config.ts
 * types, and timers only through injectable functions
 * (test/restart-watcher.test.cjs drives every tick from a fake clock, same
 * shape as startSweeper in src/activity.ts).
 */
import type { ZenRemoteConfig } from './config.js';
export { RESTART_FIELDS } from './restart-fields.js';
export type { RestartField } from './restart-fields.js';
/**
 * The restart fingerprint of one resolved config: the restart-required
 * fields' values, JSON-stringified under a stable (sorted) key order, so a
 * deep-equal config always yields the same string regardless of key order or
 * the values of every other field. Takes a loose record (the resolved values
 * type satisfies it structurally) because tests feed partial objects; a
 * missing field and an undefined one are the same "not set".
 */
export declare function restartKey(values: {
    [K in keyof ZenRemoteConfig]?: unknown;
}): string;
/** Duck-typed timer halves, exactly like src/activity.ts's sweeper: Node's
 * setInterval/clearInterval at runtime, fakes in tests. */
type StartInterval = (callback: () => void, ms: number) => unknown;
type ClearInterval = (handle: unknown) => void;
export interface RestartWatcherOptions {
    /** Resolve the CURRENT effective config values; called once immediately
     * (the baseline) and once per trigger. A throw is swallowed and retried on
     * the next trigger — the watcher must survive a transient resolution
     * failure. */
    getValues: () => ZenRemoteConfig;
    /** Called at most once, when the fingerprint diverges from the baseline.
     * After the call the watcher is done: it clears its own timer, so a slow
     * or failing reload can never trigger a second one (the reload itself
     * re-runs apply(), which starts a fresh watcher). */
    onChange: () => void;
    /** Poll cadence in ms. Default 2000. */
    intervalMs?: number;
    /** Injectable timer halves (tests drive ticks by hand). */
    setIntervalImpl?: StartInterval;
    clearIntervalImpl?: ClearInterval;
}
/** The two handles {@link startRestartWatcher} gives back: the poll's stop
 * function (the host half hands it to ctx.effect as the disposer) and the
 * immediate check the `loader/volatile-update` listener calls (T17b). */
export interface RestartWatcher {
    stop(): void;
    /** One fingerprint comparison right now, bypassing the poll cadence.
     * Identical semantics to a poll tick that sees a change: fires
     * {@link RestartWatcherOptions.onChange} at most once, then disarms
     * itself. */
    checkNow(): void;
}
/**
 * Watch the restart-required fields and call `onChange` (once) when their
 * resolved values diverge from the values {@link startRestartWatcher} was
 * started with. Two triggers share the one fire-at-most-once guard: the
 * returned `checkNow()` (the loader's `loader/volatile-update` event — a
 * volatile-only settings save commits without a restart and announces itself
 * on the row context, so the fingerprint is re-checked immediately instead
 * of at the next tick, T17b) and the 2s poll, which remains the safety net
 * for the layers no loader event ever covers — `lan-gate.config.json` and
 * `LAN_GATE_*` / `DSH_PUSH_*` environment changes are picked up by the same
 * comparison (getValues re-resolves every layer), which is the desired
 * behavior: those layers below the row are just as invisible to a live read
 * as a restart-required row field. `stop` is the disposer (the host half
 * hands it to ctx.effect); the underlying timer is unref()ed so the poll
 * alone never keeps the DSH process alive.
 */
export declare function startRestartWatcher(options: RestartWatcherOptions): RestartWatcher;
//# sourceMappingURL=restart-watcher.d.ts.map