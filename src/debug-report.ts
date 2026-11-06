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

import { bindHostShape, redactText, redactValue, serverUrlShape } from './debug-redact.js'
import type { LogRingEntry } from './log-ring.js'

/** The `_meta` plate's scalars, all construction-time facts. */
export interface DebugReportMetaInput {
  /** When the report was assembled (ISO string; the caller stamps it). */
  generatedAt: string
  /** This package's own version (module-load read in src/index.ts). */
  pluginVersion: string
  /** The host DSH's version (`resolveDshVersion`). */
  dshVersion: string
  /** e.g. `darwin arm64` — `process.platform` + `process.arch`. */
  platform: string
  /** The row's effective role: `'host'` or `'client'`. */
  role: string
  /** The profile context's display name, when the composition has one. */
  profileName?: string
}

/** One debug report's input. `configSummary` is the PICKED config subset
 * (field → value); `serverUrl` inside it is special-cased into a shape. */
export interface DebugReportInput {
  meta: DebugReportMetaInput
  configSummary: Record<string, unknown>
  /** The `/client/status` diagnostics body, as the status route would have
   * answered (the assembler only redacts it). */
  statusBody: Record<string, unknown>
  /** The gateway child's summary (host role only): liveness, port, device
   * and share counts — counts, never tokens. */
  gatewaySummary?: Record<string, unknown>
  /** The log ring's snapshot, oldest first. */
  logs: readonly LogRingEntry[]
  /** The user home directory, the redactor's fold point for `~`. */
  home: string
}

/**
 * Assemble the report's five plates: `_meta`, `config`, `status`,
 * `gateway` (only when a summary was supplied), `logs`. Every string is
 * redacted; nothing in the output can carry a path (beyond a leaf), a
 * hostname (beyond its address class), or a secret-shaped run.
 */
export function assembleDebugReport(input: DebugReportInput): Record<string, unknown> {
  const context = { home: input.home }
  const config: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input.configSummary)) {
    if (key === 'serverUrl' || key === 'host') continue
    config[key] = redactValue(value, context)
  }
  // Both addresses are SHAPES, assigned after the deep pass so the shapers'
  // own labels are never re-classified: the bind host keeps only its class
  // (a bare IP must not reach the report), serverUrl its scheme+class+port.
  if ('host' in input.configSummary) config.host = bindHostShape(input.configSummary.host)
  config.serverUrl = serverUrlShape(input.configSummary.serverUrl)
  const status = redactValue(input.statusBody, context) as Record<string, unknown>
  // MS-5: the pool status body's per-server rows each carry a REAL address;
  // every one gets the same shape treatment `config.serverUrl` has — the
  // deep pass would already downgrade a well-formed URL's host, but the
  // shaper's normalization is the contract (scheme-default port omitted,
  // unset → 'unset') and every row must meet it, not merely survive.
  // MS-5-fix: the rebuilt row's BASE is the already-redacted row from the
  // deep pass above (redactValue maps arrays 1:1, so index i aligns) —
  // spreading the RAW input here would silently restore every field the
  // pass had just cleaned, and a hostile handshake-supplied serverName
  // would leak paths and hostnames into the report. Only `serverUrl` is
  // overwritten, and its shape is computed from the RAW value: the redacted
  // address (`http://lan-ip:3080`) no longer parses into scheme/host/port.
  // A non-object raw item keeps its redacted counterpart, never the raw one.
  const rawServers = (input.statusBody as { servers?: unknown }).servers
  if (Array.isArray(rawServers)) {
    const redactedServers = Array.isArray(status.servers) ? status.servers : []
    status.servers = rawServers.map((rawItem, index) => {
      const redacted = redactedServers[index]
      if (rawItem === null || typeof rawItem !== 'object' || Array.isArray(rawItem)) return redacted
      const base = redacted !== null && typeof redacted === 'object' && !Array.isArray(redacted)
        ? (redacted as Record<string, unknown>)
        : (redactValue(rawItem, context) as Record<string, unknown>)
      return { ...base, serverUrl: serverUrlShape((rawItem as Record<string, unknown>).serverUrl) }
    })
  }
  const report: Record<string, unknown> = {
    _meta: {
      generatedAt: redactText(input.meta.generatedAt, context),
      pluginVersion: redactText(input.meta.pluginVersion, context),
      dshVersion: redactText(input.meta.dshVersion, context),
      platform: redactText(input.meta.platform, context),
      role: redactText(input.meta.role, context),
      ...(input.meta.profileName === undefined ? {} : { profile: redactText(input.meta.profileName, context) }),
    },
    config,
    status,
    ...(input.gatewaySummary === undefined ? {} : { gateway: redactValue(input.gatewaySummary, context) }),
    logs: input.logs.map((entry) => ({
      t: entry.t,
      level: entry.level,
      msg: redactText(entry.msg, context),
    })),
  }
  return report
}
