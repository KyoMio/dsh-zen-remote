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
/** Severity of one ring entry. The ring only distinguishes what the report
 * renders: info lines and warnings. */
export type LogLevel = 'info' | 'warn';
/** One ring entry: ISO timestamp, level, fully interpolated message. */
export interface LogRingEntry {
    t: string;
    level: LogLevel;
    msg: string;
}
/** The ring's face. `push` never throws and never returns anything; callers
 * log through it exactly like they would through the context logger. */
export interface LogRing {
    push(level: LogLevel, formatText: string, ...args: unknown[]): void;
    /** Oldest-last copy of the ring. Mutating the returned array or its
     * entries never reaches the ring's own state. */
    snapshot(): LogRingEntry[];
}
/**
 * Create one bounded log ring. `cap` defaults to 300 entries — a full debug
 * session of lifecycle lines plus a healthy share of warnings, while keeping
 * the report a fixed small size. A cap below 1 is clamped to 1.
 */
export declare function createLogRing(cap?: number): LogRing;
/** The logger face this module needs: the cordis context logger's two
 * methods, each optional (test fakes carry none). */
export interface PluginLogLike {
    info?(format: string, ...args: unknown[]): void;
    warn?(format: string, ...args: unknown[]): void;
}
/** The double-writer the apply() wiring funnels its logging through: every
 * line reaches the context logger (unchanged behavior, unchanged call
 * sites) AND the ring (the debug report's source). A ring failure is
 * swallowed; a logger failure propagates exactly as it did before this
 * module existed. */
export declare function createPluginLog(ring: LogRing, logger: PluginLogLike | undefined): {
    info(format: string, ...args: unknown[]): void;
    warn(format: string, ...args: unknown[]): void;
};
//# sourceMappingURL=log-ring.d.ts.map