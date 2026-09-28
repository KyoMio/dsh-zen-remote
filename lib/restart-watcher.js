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
import { RESTART_FIELDS } from './restart-fields.js';
export { RESTART_FIELDS } from './restart-fields.js';
/**
 * The restart fingerprint of one resolved config: the restart-required
 * fields' values, JSON-stringified under a stable (sorted) key order, so a
 * deep-equal config always yields the same string regardless of key order or
 * the values of every other field. Takes a loose record (the resolved values
 * type satisfies it structurally) because tests feed partial objects; a
 * missing field and an undefined one are the same "not set".
 */
export function restartKey(values) {
    const picked = {};
    for (const field of [...RESTART_FIELDS].sort())
        picked[field] = values[field];
    return JSON.stringify(picked);
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
export function startRestartWatcher(options) {
    const { getValues, onChange, intervalMs = 2_000 } = options;
    const setIntervalImpl = options.setIntervalImpl ?? ((callback, ms) => setInterval(callback, ms));
    const clearIntervalImpl = options.clearIntervalImpl ?? ((handle) => clearInterval(handle));
    // A failing BASELINE read must not kill the watcher (apply() would fail to
    // load the row): undefined means "not primed yet" — the first successful
    // trigger primes it without firing.
    let lastKey;
    try {
        lastKey = restartKey(getValues());
    }
    catch {
        lastKey = undefined;
    }
    let stopped = false;
    // `let`, not `const`: a fake timer may fire the first tick synchronously
    // during setIntervalImpl, before the handle assignment below completes.
    let handle;
    const stop = () => {
        if (stopped)
            return;
        stopped = true;
        clearIntervalImpl(handle);
    };
    // One body for both triggers: an event dispatch and a poll tick are the
    // same comparison, and `stopped` makes either path fire exactly once.
    const checkNow = () => {
        if (stopped)
            return;
        let key;
        try {
            key = restartKey(getValues());
        }
        catch {
            return;
        }
        if (lastKey === undefined) {
            lastKey = key;
            return;
        }
        if (key === lastKey)
            return;
        // Fire exactly once: stop before invoking, so the callback (the row
        // reload) can neither re-trigger nor race a second tick.
        stop();
        onChange();
    };
    handle = setIntervalImpl(checkNow, intervalMs);
    if (typeof handle === 'object' && handle !== null && typeof handle.unref === 'function') {
        ;
        handle.unref();
    }
    return { stop, checkNow };
}
//# sourceMappingURL=restart-watcher.js.map