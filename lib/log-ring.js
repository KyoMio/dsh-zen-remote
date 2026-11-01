/**
 * CU-1: the plugin's in-process diagnostic log ring (SPEC §方案 C). A bounded
 * FIFO of the plugin row's own log lines, kept in memory only — the desktop
 * app writes no log file, so this is the one artifact the debug report (CU-2)
 * can read on either role. Deliberately NOT a file, and deliberately only
 * this plugin's lines: DSH's own log stream stays untouched.
 *
 * Pure module: no DSH imports, no I/O, no clocks beyond the timestamp it
 * stamps entries with. The wiring lives in src/index.ts, which funnels its
 * `logWarn` / `logInfo` through {@link createPluginLog} so existing call
 * sites enter the ring unchanged (double write: logger first, ring second),
 * and pushes the handful of lifecycle events (row apply/reload, gateway
 * spawn/exit, relay link flips, fetch-route installs) by hand.
 *
 * One discipline the debug report leans on: ring lines carry event codes,
 * id shapes and counters — never payloads. The redactor (debug-redact.ts)
 * is the second layer, not the license to log secrets here.
 */
import { format } from 'node:util';
/** Longest message kept, in characters (UTF-16 code units). Debug lines are
 * codes and shapes, not dumps — anything longer was the wrong thing to log. */
const MAX_MSG_CHARS = 512;
/**
 * Create one bounded log ring. `cap` defaults to 300 entries — a full debug
 * session of lifecycle lines plus a healthy share of warnings, while keeping
 * the report a fixed small size. A cap below 1 is clamped to 1.
 */
export function createLogRing(cap = 300) {
    const capacity = Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : 1;
    const entries = [];
    return {
        push(level, formatText, ...args) {
            let msg;
            try {
                msg = args.length === 0 ? String(formatText) : format(formatText, ...args);
            }
            catch {
                // A malformed format string must never break the caller's flow —
                // keep the raw template as the message.
                msg = String(formatText);
            }
            if (msg.length > MAX_MSG_CHARS)
                msg = msg.slice(0, MAX_MSG_CHARS);
            entries.push({ t: new Date().toISOString(), level, msg });
            if (entries.length > capacity)
                entries.splice(0, entries.length - capacity);
        },
        snapshot() {
            return entries.map((entry) => ({ ...entry }));
        },
    };
}
/** The double-writer the apply() wiring funnels its logging through: every
 * line reaches the context logger (unchanged behavior, unchanged call
 * sites) AND the ring (the debug report's source). A ring failure is
 * swallowed; a logger failure propagates exactly as it did before this
 * module existed. */
export function createPluginLog(ring, logger) {
    return {
        info(formatText, ...args) {
            logger?.info?.(formatText, ...args);
            try {
                ring.push('info', formatText, ...args);
            }
            catch { /* the ring must never break logging */ }
        },
        warn(formatText, ...args) {
            logger?.warn?.(formatText, ...args);
            try {
                ring.push('warn', formatText, ...args);
            }
            catch { /* the ring must never break logging */ }
        },
    };
}
//# sourceMappingURL=log-ring.js.map