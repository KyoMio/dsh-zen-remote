/**
 * CLI-2 IPC client: the CLI half of the local control channel that
 * `src/cli/ipc-server.ts` serves inside the DSH plugin process. Discovery
 * walks the same candidate socket paths the server binds (or a single
 * explicit `--socket` path), pings each existing one with a short 200ms
 * budget, and sorts the answers into three buckets the command layer can
 * speak about: LIVE instances whose `cliProtocolVersion` matches, sockets
 * speaking a DIFFERENT protocol version (the upgrade-prompt case), and paths
 * that refused us with EACCES / EPERM (the "DSH runs as another user, try
 * `sudo -E`" case).
 *
 * The request helper is a thin http-over-Unix-socket (Windows: named pipe)
 * round trip. Transport errors REJECT — a dead socket is a real failure the
 * caller must see — while HTTP error statuses resolve normally: the IPC
 * protocol answers every failure as JSON (`{ ok: false, error: … }`), so a
 * 409 wrong-role or 409 env-shadowed is data, not an exception.
 */

import { request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { statSync } from 'node:fs'
import { CLI_CONFIG_ROUTE, CLI_PING_ROUTE, CLI_PROTOCOL_VERSION, candidateSocketPaths } from './ipc-server.js'
import { CLIENT_DEBUG_REPORT_ROUTE, CLIENT_STATUS_ROUTE } from '../client-routes.js'

/** What a live plugin instance answers `GET /ping` with. Mirrors the body
 * `src/cli/ipc-server.ts` builds (minus `ok`). */
export interface CliPingResponse {
  ok: true
  cliProtocolVersion: number
  pluginVersion: string
  pid: number
  role: 'host' | 'client' | 'peer'
  serves: boolean
  connects: boolean
  serverName: string
  profileName?: string
}

export type DiscoveredLive = CliPingResponse & { socketPath: string }

export interface DiscoveredSockets {
  /** Version-matching live instances, one entry per answering socket. */
  live: DiscoveredLive[]
  /** Sockets that answered but speak another `cliProtocolVersion`. */
  versionMismatch: { socketPath: string; cliProtocolVersion: number | undefined }[]
  /** Paths that refused the probe (or even the stat) with EACCES / EPERM —
   * the cross-user DSH case. */
  permissionDenied: string[]
}

export interface DiscoverCliSocketsOptions {
  dshHome: string
  /** Probe ONLY this path instead of the candidate walk. */
  explicitSocket?: string
  /** Bind-shape override (tests pin both platforms). */
  platform?: NodeJS.Platform
}

export interface CliIpcRequestResult {
  status: number
  body: unknown
  headers: IncomingHttpHeaders
}

export interface CliIpcClient {
  readonly socketPath: string
  ping(): Promise<CliPingResponse>
  getStatus(): Promise<unknown>
  getDebugReport(): Promise<unknown>
  writeConfig(input: { set?: Record<string, unknown>; unset?: readonly string[] }): Promise<CliIpcRequestResult>
  request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<CliIpcRequestResult>
}

/** Discovery ping budget: finding out whether anything answers must stay
 * fast — up to 8 candidates × 200ms is the worst case, and every absent
 * path skips the probe entirely. */
const PING_TIMEOUT_MS = 200
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEBUG_REPORT_TIMEOUT_MS = 30_000

function errnoCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function isDenied(error: unknown): boolean {
  const code = errnoCode(error)
  return code === 'EACCES' || code === 'EPERM'
}

interface IpcAnswer {
  status: number
  headers: IncomingHttpHeaders
  text: string
}

/** One http round trip over the socket. Rejects on transport errors; HTTP
 * error statuses are answers, not failures. */
function ipcRequest(socketPath: string, method: string, route: string, body?: unknown, timeoutMs?: number): Promise<IpcAnswer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers: Record<string, string> = {}
    if (payload !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(payload))
    }
    const req = httpRequest({ socketPath, method, path: route, headers, agent: false, timeout: timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`IPC request timed out after ${timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS}ms: ${method} ${route}`))
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

type ProbeVerdict =
  | { kind: 'live'; ping: CliPingResponse }
  | { kind: 'mismatch'; reportedVersion: number | undefined }
  | { kind: 'denied' }
  | { kind: 'absent' }
  | { kind: 'dead' }

async function probeCandidate(socketPath: string, probeEvenIfAbsent: boolean): Promise<ProbeVerdict> {
  let statDenied = false
  try {
    statSync(socketPath)
  } catch (error) {
    if (isDenied(error)) statDenied = true
    else if (!probeEvenIfAbsent) return { kind: 'absent' }
    // A missing explicit path is still probed below — the connect error tells
    // the same story, and ENOENT is not a permission problem.
  }
  if (statDenied) return { kind: 'denied' }

  let answer: IpcAnswer
  try {
    answer = await ipcRequest(socketPath, 'GET', CLI_PING_ROUTE, undefined, PING_TIMEOUT_MS)
  } catch (error) {
    return isDenied(error) ? { kind: 'denied' } : { kind: 'dead' }
  }
  if (answer.status !== 200) return { kind: 'dead' }
  let parsed: unknown
  try {
    parsed = JSON.parse(answer.text)
  } catch {
    return { kind: 'dead' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'dead' }
  const body = parsed as { ok?: unknown; cliProtocolVersion?: unknown }
  if (body.ok !== true) return { kind: 'dead' }
  const reported = typeof body.cliProtocolVersion === 'number' ? body.cliProtocolVersion : undefined
  if (reported !== CLI_PROTOCOL_VERSION) return { kind: 'mismatch', reportedVersion: reported }
  return { kind: 'live', ping: parsed as CliPingResponse }
}

/**
 * Walk the CLI socket candidates under `dshHome` (or only `explicitSocket`)
 * and classify every answering socket. Absent candidates are skipped without
 * a probe; a dead file that merely squats a candidate name simply answers
 * nothing and lands nowhere.
 */
export async function discoverCliSockets(options: DiscoverCliSocketsOptions): Promise<DiscoveredSockets> {
  const paths = options.explicitSocket !== undefined
    ? [options.explicitSocket]
    : candidateSocketPaths(options.dshHome, options.platform ?? process.platform)
  const found: DiscoveredSockets = { live: [], versionMismatch: [], permissionDenied: [] }
  for (const socketPath of paths) {
    const verdict = await probeCandidate(socketPath, options.explicitSocket !== undefined)
    if (verdict.kind === 'live') found.live.push({ ...verdict.ping, socketPath })
    else if (verdict.kind === 'mismatch') found.versionMismatch.push({ socketPath, cliProtocolVersion: verdict.reportedVersion })
    else if (verdict.kind === 'denied') found.permissionDenied.push(socketPath)
  }
  return found
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * A client bound to one socket path. `request` is the generic escape hatch
 * for routes added in later CLI phases; the named methods cover the routes
 * this phase already drives.
 */
export function createCliIpcClient(socketPath: string): CliIpcClient {
  const request = async (method: string, path: string, body?: unknown, timeoutMs?: number): Promise<CliIpcRequestResult> => {
    const answer = await ipcRequest(socketPath, method, path, body, timeoutMs)
    return { status: answer.status, body: parseBody(answer.text), headers: answer.headers }
  }
  return {
    socketPath,
    ping: async () => {
      const result = await request('GET', CLI_PING_ROUTE, undefined, PING_TIMEOUT_MS)
      return result.body as CliPingResponse
    },
    getStatus: async () => (await request('GET', CLIENT_STATUS_ROUTE)).body,
    getDebugReport: async () => (await request('GET', CLIENT_DEBUG_REPORT_ROUTE, undefined, DEBUG_REPORT_TIMEOUT_MS)).body,
    writeConfig: async (input) => await request('POST', CLI_CONFIG_ROUTE, {
      ...(input.set === undefined ? {} : { set: input.set }),
      ...(input.unset === undefined ? {} : { unset: input.unset }),
    }),
    request,
  }
}
