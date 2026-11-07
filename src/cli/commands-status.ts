/**
 * CLI-3: the `status` command — one identity read (ping) plus whatever the
 * role actually answers, rendered either as pretty JSON (`--json`) or as
 * bilingual terminal lines. `--debug` is its own branch: fetch the plugin
 * process's redacted diagnostic report over IPC and write it to a file
 * (explicit path or a `zen-remote-debug-<role>-<yyyymmdd-hhmm>.json` in the
 * working directory).
 *
 * Per SPEC the IPC channel only carries structured data — every terminal
 * string is rendered here through the translator. The per-server line
 * renderer is shared with `commands-client.ts` (`client list` prints the
 * same rows), so the two surfaces cannot drift.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADMIN_STATUS_ROUTE, ADMIN_SHARES_ROUTE } from '../admin-routes.js'
import { WIZARD_STATUS_ROUTE } from '../wizard/routes.js'
import { CLIENT_STATUS_ROUTE } from '../client-routes.js'
import type { CliIpcRequestResult } from './ipc-client.js'
import type { CliPingResponse } from './ipc-client.js'
import type { CliTranslator } from './i18n.js'
import type { CliExecutionContext } from './context.js'

/** One pool `servers` row (client/status), defensively typed — the command
 * layer renders whatever shape arrived, it never trusts it. */
export type ServerRow = Record<string, unknown>

/**
 * Fetch one JSON object over IPC; every failure mode (transport error,
 * error status, non-object body) is `null` — a broken surface means "no
 * information" for a status view, never a failed command.
 */
export async function fetchBody(run: () => Promise<CliIpcRequestResult>): Promise<ServerRow | null> {
  try {
    const result = await run()
    if (result.status < 200 || result.status >= 300) return null
    return plainOf(result.body)
  } catch {
    return null
  }
}

/** One plain JSON object, or null. */
export function plainOf(value: unknown): ServerRow | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ServerRow)
    : null
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

// ===========================================================================
// Shared row rendering (status + client list)
// ===========================================================================

/** The connection-state label: the three common states translated, the rest
 * (revoked / incompatible / unpaired) each with their own word. */
export function stateLabelOf(t: CliTranslator, value: unknown): string {
  switch (value) {
    case 'online': return t('status.online')
    case 'connecting': return t('status.connecting')
    case 'offline': return t('status.offline')
    case 'revoked': return t('status.state.revoked')
    case 'incompatible': return t('status.state.incompatible')
    case 'unpaired': return t('status.unpaired')
    default: return stringOf(value) === '' ? t('status.offline') : String(value)
  }
}

/** The fingerprint-compat half of the compat/bridge column. */
export function compatLabelOf(t: CliTranslator, value: unknown): string {
  const compat = plainOf(value)
  if (compat === null) return t('status.client.compatUnavailable')
  const different = arrayOf(compat.different).length
  if (different > 0) return t('status.client.compatDiff', { count: different })
  if (arrayOf(compat.unavailable).length > 0) return t('status.client.compatUnavailable')
  return t('status.client.compatOk')
}

/** The bridged-plugin half: how many of the row's plugins are bridged. */
export function bridgeLabelOf(t: CliTranslator, value: unknown): string {
  const plugins = arrayOf(value)
  const bridged = plugins.filter((entry) => plainOf(entry)?.bridged === true).length
  return t('status.client.bridgeCount', { count: bridged })
}

/** One paired-host row, the exact shape both surfaces print:
 * `[entryId] displayName  serverUrl  state  compat/bridge`. */
export function serverLineText(t: CliTranslator, row: ServerRow): string {
  const name = stringOf(row.displayName) !== '' ? stringOf(row.displayName) : stringOf(row.serverName)
  return `[${stringOf(row.entryId)}] ${name}  ${stringOf(row.serverUrl)}  ${stateLabelOf(t, row.state)}  ${compatLabelOf(t, row.compat)} · ${bridgeLabelOf(t, row.pluginBridge)}`
}

// ===========================================================================
// The status command
// ===========================================================================

function defaultDebugPath(role: string, now: Date, cwd: string): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return join(cwd, `zen-remote-debug-${role}-${stamp}.json`)
}

/** The `--debug` branch: fetch the redacted report and land it in a file.
 * With `--json` the answer also prints as `{ ok, path, report }`; the
 * bilingual completion line prints either way. */
async function debugReportFlow(ctx: CliExecutionContext, ping: CliPingResponse): Promise<number> {
  const { t, ipc, args } = ctx
  const out = ctx.stdout
  let report: unknown
  try {
    report = await ipc.getDebugReport()
  } catch (error) {
    out.write(`${t('status.debugFailed', { error: error instanceof Error ? error.message : String(error) })}\n`)
    return 1
  }
  // The route answers HTTP error statuses as JSON envelopes ({ ok: false,
  // error }) — a 503 no-handler or a 404 must never land in a file dressed
  // up as a report (CLI-3-fix). Only a real report shape proceeds to disk.
  const reportRecord = plainOf(report)
  if (reportRecord === null || reportRecord.ok === false || !('_meta' in reportRecord)) {
    const error = plainOf(reportRecord?.error)
    const detail = typeof error?.code === 'string'
      ? error.code
      : reportRecord === null ? 'not an object' : 'missing _meta'
    out.write(`${t('status.debugFailed', { error: detail })}\n`)
    return 1
  }
  const outPath = args.options.debugPath ?? defaultDebugPath(ping.role, ctx.now?.() ?? new Date(), ctx.cwd ?? process.cwd())
  try {
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch (error) {
    out.write(`${t('status.debugWriteFailed', { error: error instanceof Error ? error.message : String(error) })}\n`)
    return 1
  }
  if (args.options.json) {
    out.write(`${JSON.stringify({ ok: true, path: outPath, report }, null, 2)}\n`)
  }
  out.write(`${t('status.debugWritten', { path: outPath })}\n`)
  return 0
}

/** The `host` JSON section: sanitized summary of admin/status + wizard/status
 * + the share count. */
function hostJsonSection(admin: ServerRow | null, wizard: ServerRow | null, shares: ServerRow | null): ServerRow {
  const gateway = admin === null ? null : plainOf(admin.gateway)
  const reachable = admin?.gatewayReachable === true
  const port = typeof gateway?.port === 'number'
    ? gateway.port
    : typeof wizard?.gatewayActualPort === 'number' ? wizard.gatewayActualPort : null
  const devices = gateway === null ? [] : arrayOf(gateway.devices)
  const deviceList = devices
    .map((device) => plainOf(device))
    .filter((device): device is ServerRow => device !== null)
    .map((device) => ({ name: stringOf(device.name), role: stringOf(device.role) }))
  return {
    gateway: { reachable, port },
    ingress: {
      mode: stringOf(wizard?.mode) === '' ? 'off' : stringOf(wizard?.mode),
      publicUrl: stringOf(wizard?.publicUrl),
      caddyRunning: wizard?.caddyRunning === true,
      cloudflaredRunning: wizard?.cloudflaredRunning === true,
    },
    devices: { count: deviceList.length, list: deviceList },
    sharedSessions: arrayOf(shares?.shares).length,
  }
}

/** The terminal host section. Every read is defensive: a surface that failed
 * to answer simply prints nothing instead of a broken line. */
function renderHostSection(t: CliTranslator, admin: ServerRow | null, wizard: ServerRow | null, shares: ServerRow | null): string[] {
  const lines: string[] = [t('status.host.title')]
  const gateway = admin === null ? null : plainOf(admin.gateway)
  if (admin?.gatewayReachable === true && gateway !== null) {
    const port = typeof gateway.port === 'number' ? gateway.port : wizard?.gatewayActualPort
    lines.push(`  ${typeof port === 'number' ? t('status.host.gatewayUp', { port }) : t('status.host.gatewayUpNoPort')}`)
  } else {
    lines.push(`  ${t('status.host.gatewayDown')}`)
  }
  const mode = stringOf(wizard?.mode) === '' ? 'off' : stringOf(wizard?.mode)
  lines.push(`  ${t('status.host.ingress', { mode })}`)
  const publicUrl = stringOf(wizard?.publicUrl)
  if (publicUrl !== '') lines.push(`  ${t('status.host.publicUrl', { publicUrl })}`)
  if (mode === 'caddy') {
    lines.push(`  ${t('status.host.processCaddy', { state: wizard?.caddyRunning === true ? t('status.process.running') : t('status.process.stopped') })}`)
  }
  if (mode === 'cloudflared') {
    lines.push(`  ${t('status.host.processTunnel', { state: wizard?.cloudflaredRunning === true ? t('status.process.running') : t('status.process.stopped') })}`)
  }
  const devices = gateway === null ? [] : arrayOf(gateway.devices)
  lines.push(`  ${t('status.host.devices', { count: devices.length })}`)
  for (const device of devices) {
    const record = plainOf(device)
    if (record === null) continue
    const name = stringOf(record.name)
    if (name === '') continue
    lines.push(t('status.host.deviceLine', { name, deviceRole: stringOf(record.role) }))
  }
  lines.push(`  ${t('status.host.sharedSessions', { count: arrayOf(shares?.shares).length })}`)
  return lines
}

/** The terminal client section: the count line, the limit warning at 8/8,
 * one row per paired host, and the last error of a troubled row. */
function renderClientSection(t: CliTranslator, client: ServerRow): string[] {
  const lines: string[] = [t('status.client.title')]
  const servers = arrayOf(client.servers)
    .map((row) => plainOf(row))
    .filter((row): row is ServerRow => row !== null)
  const max = typeof client.maxServers === 'number' ? client.maxServers : 8
  lines.push(`  ${t('status.client.pairedCount', { count: servers.length, max })}`)
  if (servers.length >= max) lines.push(`  ${t('client.limitReached')}`)
  for (const row of servers) {
    lines.push(`  ${serverLineText(t, row)}`)
    const lastError = stringOf(row.lastError)
    if (lastError !== '') lines.push(`      ${t('status.client.lastError', { error: lastError })}`)
  }
  return lines
}

/** The `--json` body: identity always, the sections the role answers. */
function statusJsonBody(
  ping: CliPingResponse,
  admin: ServerRow | null,
  wizard: ServerRow | null,
  shares: ServerRow | null,
  client: ServerRow | null,
): ServerRow {
  const body: ServerRow = {
    experimental: true,
    role: ping.role,
    pluginVersion: ping.pluginVersion,
    pid: ping.pid,
    serverName: ping.serverName,
  }
  if (ping.serves) body.host = hostJsonSection(admin, wizard, shares)
  if (ping.connects && client !== null) {
    body.client = { maxServers: typeof client.maxServers === 'number' ? client.maxServers : 8, servers: arrayOf(client.servers) }
  }
  return body
}

/**
 * `dsh-zen-remote status [--json] [--debug [outPath]]`. Identity from one
 * ping; the host surfaces (admin status, wizard status, share list) and the
 * client pool status each fetched only when the role answers them. Exit
 * codes: 0 on any answered status, 1 when the ping itself or the debug
 * round-trip failed.
 */
export async function runStatusCommand(ctx: CliExecutionContext): Promise<number> {
  const { t, ipc, args } = ctx
  const out = ctx.stdout
  let ping: CliPingResponse
  try {
    ping = await ipc.ping()
  } catch {
    out.write(`${t('status.notRunning')}\n`)
    return 1
  }

  if (args.options.debug || args.options.debugPath !== undefined) {
    return await debugReportFlow(ctx, ping)
  }

  // The role decides which surfaces exist; fetches run concurrently and any
  // failure degrades to "no information" rather than failing the command.
  const [admin, wizard, shares, client] = await Promise.all([
    ping.serves ? fetchBody(() => ipc.request('GET', ADMIN_STATUS_ROUTE)) : Promise.resolve(null),
    ping.serves ? fetchBody(() => ipc.request('GET', WIZARD_STATUS_ROUTE)) : Promise.resolve(null),
    ping.serves ? fetchBody(() => ipc.request('GET', ADMIN_SHARES_ROUTE)) : Promise.resolve(null),
    ping.connects ? fetchBody(() => ipc.request('GET', CLIENT_STATUS_ROUTE)) : Promise.resolve(null),
  ])

  if (args.options.json) {
    out.write(`${JSON.stringify(statusJsonBody(ping, admin, wizard, shares, client), null, 2)}\n`)
    return 0
  }

  const lines = [
    t('status.line.role', { role: t(`status.role.${ping.role}`) }),
    t('status.machineName', { name: ping.serverName }),
    t('status.pluginVersion', { version: ping.pluginVersion }),
  ]
  if (ping.profileName !== undefined) lines.push(t('status.profile', { profile: ping.profileName }))
  if (ping.serves) lines.push(...renderHostSection(t, admin, wizard, shares))
  if (ping.connects && client !== null) lines.push(...renderClientSection(t, client))
  out.write(`${lines.join('\n')}\n`)
  return 0
}
