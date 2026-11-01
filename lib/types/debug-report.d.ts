/**
 * CU-2: the debug report's assembler (SPEC 方案 C). Pure module — no DSH
 * imports, no I/O: everything dynamic (the log ring's snapshot, the resolved
 * config, the status route's body, the gateway's summary, the profile name)
 * arrives as plain input, so the check script and the tests can drive it
 * with poisoned fixtures and assert nothing recoverable comes out.
 *
 * Two redaction layers meet here, per SPEC:
 *  1. construction — the report's own fields are picked by NAME; nothing is
 *     ever spread into it. (The wiring in client-routes.ts picks the config
 *     summary fields; a secret that sneaks into `configSummary` anyway is
 *     still caught by layer 2.)
 *  2. output — every string, at any depth, runs through `redactText`
 *     (debug-redact.ts). The two exceptions are `config.serverUrl` and
 *     `config.host`, which are not strings but SHAPES (`https://domain`,
 *     `http://lan-ip:3080`, `loopback`, `wildcard`) — assigning them after
 *     the deep pass keeps the shapers' own labels from being re-classified.
 */
import type { LogRingEntry } from './log-ring.js';
/** The `_meta` plate's scalars, all construction-time facts. */
export interface DebugReportMetaInput {
    /** When the report was assembled (ISO string; the caller stamps it). */
    generatedAt: string;
    /** This package's own version (module-load read in src/index.ts). */
    pluginVersion: string;
    /** The host DSH's version (`resolveDshVersion`). */
    dshVersion: string;
    /** e.g. `darwin arm64` — `process.platform` + `process.arch`. */
    platform: string;
    /** The row's effective role: `'host'` or `'client'`. */
    role: string;
    /** The profile context's display name, when the composition has one. */
    profileName?: string;
}
/** One debug report's input. `configSummary` is the PICKED config subset
 * (field → value); `serverUrl` inside it is special-cased into a shape. */
export interface DebugReportInput {
    meta: DebugReportMetaInput;
    configSummary: Record<string, unknown>;
    /** The `/client/status` diagnostics body, as the status route would have
     * answered (the assembler only redacts it). */
    statusBody: Record<string, unknown>;
    /** The gateway child's summary (host role only): liveness, port, device
     * and share counts — counts, never tokens. */
    gatewaySummary?: Record<string, unknown>;
    /** The log ring's snapshot, oldest first. */
    logs: readonly LogRingEntry[];
    /** The user home directory, the redactor's fold point for `~`. */
    home: string;
}
/**
 * Assemble the report's five plates: `_meta`, `config`, `status`,
 * `gateway` (only when a summary was supplied), `logs`. Every string is
 * redacted; nothing in the output can carry a path (beyond a leaf), a
 * hostname (beyond its address class), or a secret-shaped run.
 */
export declare function assembleDebugReport(input: DebugReportInput): Record<string, unknown>;
//# sourceMappingURL=debug-report.d.ts.map