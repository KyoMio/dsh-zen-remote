/**
 * Auto-reload of the plugin row when a "needs restart" config field changes
 * (T17). Every Config field is volatile (src/config.ts — DSH's settings
 * service only surfaces volatile fields), so "this value only takes effect
 * after the row re-runs apply()" can no longer ride the volatility flag.
 * Instead the host half re-resolves the effective config on an interval and
 * compares a fingerprint over exactly the restart-required fields; a changed
 * fingerprint reloads the row via cordis, which re-runs `apply()` and with
 * it the gateway child and the push half.
 *
 * Pure logic — no imports beyond src/config.ts types, and timers only
 * through injectable functions (test/restart-watcher.test.cjs drives every
 * tick from a fake clock, same shape as startSweeper in src/activity.ts).
 */
/** The row fields whose changed value must reload the plugin row to take
 * effect: `role` chooses which halves load; `port` / `host` / `targetPort` /
 * `rateLimit` / `trustedProxies` become the gateway child's runtime shape;
 * `vapidSubject` / `lang` / `pushEvents` / `pushDebounceMs` / `pushSummary` /
 * `pushTurnEnd` / `pushTool` are the push leg's startup values. Everything
 * else (serverName, idleHours, autoShareNewSessions, serverUrl, deviceToken,
 * and the interface-half knobs) is read live per use and needs no reload. */
export const RESTART_FIELDS = [
    'role',
    'port',
    'host',
    'targetPort',
    'rateLimit',
    'trustedProxies',
    'vapidSubject',
    'lang',
    'pushEvents',
    'pushDebounceMs',
    'pushSummary',
    'pushTurnEnd',
    'pushTool',
];
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
 * ponytail: 2 秒轮询是简化做法——loader 目前没有提供 volatile 行字段的变更
 * 事件可订阅；若未来 dsh-settings 暴露了这类事件，应改为订阅推送，去掉这
 * 个定时器。
 *
 * Watch the restart-required fields and call `onChange` (once) when their
 * resolved values diverge from the values {@link startRestartWatcher} was
 * started with. `lan-gate.config.json` and `LAN_GATE_*` / `DSH_PUSH_*`
 * environment changes are picked up by the same poll — getValues re-resolves
 * every layer — which is the desired behavior: the layers below the row are
 * just as invisible to a live read as a restart-required row field. Returns
 * the stop function (the host half hands it to ctx.effect); the underlying
 * timer is unref()ed so the poll alone never keeps the DSH process alive.
 */
export function startRestartWatcher(options) {
    const { getValues, onChange, intervalMs = 2_000 } = options;
    const setIntervalImpl = options.setIntervalImpl ?? ((callback, ms) => setInterval(callback, ms));
    const clearIntervalImpl = options.clearIntervalImpl ?? ((handle) => clearInterval(handle));
    // A failing BASELINE read must not kill the watcher (apply() would fail to
    // load the row): undefined means "not primed yet" — the first successful
    // tick primes it without firing.
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
    const tick = () => {
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
    handle = setIntervalImpl(tick, intervalMs);
    if (typeof handle === 'object' && handle !== null && typeof handle.unref === 'function') {
        ;
        handle.unref();
    }
    return stop;
}
//# sourceMappingURL=restart-watcher.js.map