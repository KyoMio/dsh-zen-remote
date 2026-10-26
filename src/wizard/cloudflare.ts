/**
 * Cloudflare API v4 client (GW-7) — the whole tunnel path (路 C) talks to
 * this module: account lookup, zone lookup, tunnel create/list, ingress
 * configuration, the CNAME that points the public hostname at the tunnel,
 * and the composed "is this domain on Cloudflare already" check.
 *
 * Transport rules the ticket pins down:
 *
 *   - Plain `fetch`, no third-party dependency; the token rides the
 *     `Authorization: Bearer` header and is NEVER logged, echoed into an
 *     error, or written into any returned structure.
 *   - Every failure is a typed {@link CloudflareError} whose `code` the UI
 *     classifies on (`cf-auth-failed`, `cf-zone-not-found`,
 *     `cf-tunnel-conflict`, `cf-dns-conflict`, `cf-network`, and the
 *     catch-all `cf-api`). Raw response bodies never pass through — the
 *     message carries only the API's short error summary, truncated,
 *     which is what the design's 「兜底显示原始错误码」 wants.
 *   - The client is stateless: a factory binds the token (plus injectable
 *     `fetchImpl` / `baseUrl` for the mock-server tests); every method
 *     takes the ids it needs. The module-level `cf*` wrappers are one-call
 *     conveniences over the factory.
 *
 * Conflict classification matches the well-known numeric codes where they
 * exist and falls back to the API's error text (`already exists`
 * wordings), so an upstream renumber degrades to the generic envelope
 * instead of a wrong verdict.
 */

import { hostOf } from '../config.js'

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'

export type CloudflareErrorCode =
  | 'cf-auth-failed'
  | 'cf-zone-not-found'
  | 'cf-tunnel-conflict'
  | 'cf-dns-conflict'
  | 'cf-network'
  | 'cf-api'

/**
 * One refused API call. Fields are assigned in the constructor body (the
 * check scripts' strip-only type stripping rejects parameter properties).
 */
export class CloudflareError extends Error {
  readonly code: CloudflareErrorCode
  readonly status: number | null
  /** The API's own numeric error code(s), when the envelope carried any. */
  readonly apiCodes: readonly number[]

  constructor(code: CloudflareErrorCode, message: string, status: number | null = null, apiCodes: readonly number[] = [], options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CloudflareError'
    this.code = code
    this.status = status
    this.apiCodes = apiCodes
  }
}

/** Tunnel name conflict: Cloudflare rejects duplicate names (documented
 * code 10405; deployments also word it in the message text). The text
 * fallback names its SUBJECT — "already exists" alone matches the DNS
 * wording just as well, so the two classifiers must stay scoped. */
function isTunnelConflict(apiCodes: readonly number[], text: string): boolean {
  return apiCodes.includes(10405) || (/tunnel/i.test(text) && /already exists/i.test(text))
}

/** DNS record conflict: the documented codes are 81053 / 81057. */
function isDnsConflict(apiCodes: readonly number[], text: string): boolean {
  return apiCodes.includes(81053) || apiCodes.includes(81057) || (/record/i.test(text) && /already exists/i.test(text))
}

/** The API's error summary: message strings only, joined, truncated —
 * never the raw body, never the request's token. */
function summarize(errors: readonly unknown[], fallback: string): { text: string; codes: number[] } {
  const codes: number[] = []
  const parts: string[] = []
  for (const entry of errors) {
    if (entry !== null && typeof entry === 'object') {
      const record = entry as { code?: unknown; message?: unknown }
      if (typeof record.code === 'number') codes.push(record.code)
      if (typeof record.message === 'string' && record.message !== '') parts.push(record.message)
    }
  }
  return { text: (parts.join('; ') || fallback).slice(0, 200), codes }
}

export interface CloudflareApiOptions {
  token: string
  fetchImpl?: typeof fetch
  baseUrl?: string
}

export interface CloudflareTunnelSummary {
  id: string
  name: string
  status: string
}

export interface CloudflareDomainCheck {
  onCloudflare: boolean
  zoneId: string | null
  accountId: string | null
}

export interface CloudflareApi {
  /** Every account id the token can see. */
  listAccounts(): Promise<string[]>
  /** The zone id whose name EXACTLY equals `domain`, within one account. */
  getZone(accountId: string, domain: string): Promise<string>
  /** One new named tunnel; `token` is the connector secret cloudflared runs with. */
  createTunnel(accountId: string, name: string): Promise<{ id: string; token: string }>
  /** The account's live tunnels (deleted ones filtered server-side). */
  listTunnels(accountId: string): Promise<CloudflareTunnelSummary[]>
  /** The connector token of an EXISTING tunnel (the re-use path of setup). */
  getTunnelToken(accountId: string, tunnelId: string): Promise<string>
  /** Map `domain` → `serviceUrl` in the tunnel's ingress, 404 fallback last. */
  configureIngress(accountId: string, tunnelId: string, domain: string, serviceUrl: string): Promise<void>
  /** One proxied CNAME `subdomain` → `target`; returns the record id. */
  createDnsRecord(zoneId: string, subdomain: string, target: string): Promise<string>
  /** Composed check: does any ancestor of `domain` name a zone on the
   * token's accounts (zones are apexes — `dsh.example.com` lives in the
   * `example.com` zone)? */
  checkDomainOnCloudflare(domain: string): Promise<CloudflareDomainCheck>
}

/** Tunnel names we mint: short, safe in a URL path. */
const TUNNEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/

/** A `service:` URL inside a tunnel ingress: http(s) to host[:port]. */
const SERVICE_URL_PATTERN = /^https?:\/\/[A-Za-z0-9.[\]:-]+$/

/** Path segments are ids we received from the API or names we minted —
 * encoded anyway, so a hostile value cannot change the request shape. */
const seg = (value: string): string => encodeURIComponent(value)

/** Page-size + page ceiling for the two list endpoints: 5 pages of 50 is
 * 250 accounts/tunnels — far past anything a wizard user has, and the hard
 * stop means a broken pagination answer can never loop forever. */
const PAGE_SIZE = 50
const PAGE_LIMIT = 5

/**
 * The ancestor chain of one hostname, itself first: `dsh.example.com` →
 * `dsh.example.com`, `example.com`, `com`. Cloudflare zones are apex
 * domains, so a wizard lookup for `dsh.example.com` must find the zone
 * named `example.com` (GW-fix-2/H1) — exact-name matching walks this chain
 * level by level.
 */
export function ancestorHosts(domain: string): string[] {
  const labels = domain.split('.')
  const chain: string[] = []
  for (let index = 0; index < labels.length; index++) chain.push(labels.slice(index).join('.'))
  return chain
}

export function createCloudflareApi(options: CloudflareApiOptions): CloudflareApi {
  const baseUrl = options.baseUrl ?? CLOUDFLARE_API_BASE
  const fetchImpl = options.fetchImpl ?? fetch
  const token = options.token

  if (typeof token !== 'string' || token === '') {
    throw new CloudflareError('cf-auth-failed', 'no Cloudflare API token')
  }

  /** One authenticated v4 call: Bearer header, envelope unwrapping, typed
   * failures. The token never appears in any error path. Returns the
   * result PLUS the pagination envelope (the list endpoints page). */
  const call = async (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<{ result: unknown; totalPages: number }> => {
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (cause) {
      throw new CloudflareError('cf-network', `the Cloudflare API call failed before an answer arrived (${path})`, null, [], { cause })
    }
    let envelope: { success?: unknown; errors?: unknown; result?: unknown; result_info?: { total_pages?: unknown } }
    try {
      envelope = await response.json()
    } catch {
      throw new CloudflareError('cf-network', `the Cloudflare API answered unparsable JSON (${path})`, response.status)
    }
    const errors = Array.isArray(envelope?.errors) ? envelope.errors : []
    const summary = summarize(errors, `HTTP ${response.status}`)
    if (response.status === 401 || response.status === 403) {
      throw new CloudflareError('cf-auth-failed', summary.text, response.status, summary.codes)
    }
    if (envelope?.success !== true) {
      let code: CloudflareErrorCode = 'cf-api'
      if (isTunnelConflict(summary.codes, summary.text)) code = 'cf-tunnel-conflict'
      else if (isDnsConflict(summary.codes, summary.text)) code = 'cf-dns-conflict'
      throw new CloudflareError(code, summary.text, response.status, summary.codes)
    }
    // A missing or junk total_pages reads as a single page — old mocks and
    // tolerant callers keep working, pagination simply never continues.
    const totalPages = typeof envelope.result_info?.total_pages === 'number' && envelope.result_info.total_pages >= 1
      ? envelope.result_info.total_pages
      : 1
    return { result: envelope.result, totalPages }
  }

  const requireString = (value: unknown, what: string): string => {
    if (typeof value !== 'string' || value === '') throw new CloudflareError('cf-api', `the Cloudflare API answered without ${what}`)
    return value
  }

  const requireId = (value: unknown, what: string): string => {
    if (typeof value !== 'string' || value === '') throw new CloudflareError('cf-api', `${what} is required`)
    return value
  }

  return {
    async listAccounts() {
      const accounts: string[] = []
      for (let page = 1; page <= PAGE_LIMIT; page++) {
        const { result, totalPages } = await call('GET', `/accounts?per_page=${PAGE_SIZE}&page=${page}`)
        if (!Array.isArray(result)) throw new CloudflareError('cf-api', 'the accounts answer had no list')
        accounts.push(...result.map((account) => requireString((account as { id?: unknown })?.id, 'an account id')))
        if (page >= totalPages || result.length === 0) break
      }
      return accounts
    },

    async getZone(accountId, domain) {
      const host = hostOf(domain)
      if (host === undefined) throw new CloudflareError('cf-api', 'the domain is not a bare hostname')
      const id = requireId(accountId, 'the account id')
      const { result } = await call('GET', `/zones?name=${seg(host)}&account.id=${seg(id)}`)
      // Exact-match on the zone NAME client-side: the query filter is
      // advisory, the verdict is ours.
      const zones = Array.isArray(result) ? (result as readonly { name?: unknown; id?: unknown }[]) : []
      const zone = zones.find((candidate) => candidate?.name === host)
      if (zone === undefined) throw new CloudflareError('cf-zone-not-found', `no Cloudflare zone named ${host}`)
      return requireString(zone.id, 'a zone id')
    },

    async createTunnel(accountId, name) {
      const id = requireId(accountId, 'the account id')
      if (typeof name !== 'string' || !TUNNEL_NAME_PATTERN.test(name)) {
        throw new CloudflareError('cf-api', 'the tunnel name is not a safe label')
      }
      // config_src cloudflare makes the create response carry the connector
      // token directly — the second round-trip (GET .../token) is spared.
      const { result } = await call('POST', `/accounts/${seg(id)}/cfd_tunnel`, { name, config_src: 'cloudflare' })
      const record = result as { id?: unknown; token?: unknown }
      return { id: requireString(record?.id, 'a tunnel id'), token: requireString(record?.token, 'a tunnel token') }
    },

    async getTunnelToken(accountId, tunnelId) {
      const id = requireId(accountId, 'the account id')
      const tunnel = requireId(tunnelId, 'the tunnel id')
      const { result } = await call('GET', `/accounts/${seg(id)}/cfd_tunnel/${seg(tunnel)}/token`)
      return requireString((result as { token?: unknown })?.token, 'a tunnel token')
    },

    async listTunnels(accountId) {
      const id = requireId(accountId, 'the account id')
      const tunnels: CloudflareTunnelSummary[] = []
      for (let page = 1; page <= PAGE_LIMIT; page++) {
        const { result, totalPages } = await call('GET', `/accounts/${seg(id)}/cfd_tunnel?is_deleted=false&per_page=${PAGE_SIZE}&page=${page}`)
        if (!Array.isArray(result)) throw new CloudflareError('cf-api', 'the tunnels answer had no list')
        tunnels.push(...result.map((tunnel) => {
          const record = tunnel as { id?: unknown; name?: unknown; status?: unknown }
          return {
            id: requireString(record?.id, 'a tunnel id'),
            name: typeof record?.name === 'string' ? record.name : '',
            status: typeof record?.status === 'string' ? record.status : '',
          }
        }))
        if (page >= totalPages || result.length === 0) break
      }
      return tunnels
    },

    async configureIngress(accountId, tunnelId, domain, serviceUrl) {
      const accountIdSafe = requireId(accountId, 'the account id')
      const tunnelIdSafe = requireId(tunnelId, 'the tunnel id')
      const host = hostOf(domain)
      if (host === undefined) throw new CloudflareError('cf-api', 'the domain is not a bare hostname')
      if (typeof serviceUrl !== 'string' || !SERVICE_URL_PATTERN.test(serviceUrl)) {
        throw new CloudflareError('cf-api', 'the service URL is not a plain http(s) origin')
      }
      await call('PUT', `/accounts/${seg(accountIdSafe)}/cfd_tunnel/${seg(tunnelIdSafe)}/configurations`, {
        config: {
          ingress: [
            { hostname: host, service: serviceUrl },
            { service: 'http_status:404' },
          ],
        },
      })
    },

    async createDnsRecord(zoneId, subdomain, target) {
      const zone = requireId(zoneId, 'the zone id')
      const name = hostOf(subdomain)
      if (name === undefined) throw new CloudflareError('cf-api', 'the record name is not a bare hostname')
      if (typeof target !== 'string' || !/^[A-Za-z0-9-]{32}\.cfargotunnel\.com$/.test(target)) {
        throw new CloudflareError('cf-api', 'the CNAME target is not a tunnel hostname')
      }
      const { result } = await call('POST', `/zones/${seg(zone)}/dns_records`, {
        type: 'CNAME',
        name,
        content: target,
        proxied: true,
        ttl: 1,
      })
      return requireString((result as { id?: unknown })?.id, 'a DNS record id')
    },

    async checkDomainOnCloudflare(domain) {
      const host = hostOf(domain)
      if (host === undefined) throw new CloudflareError('cf-api', 'the domain is not a bare hostname')
      // Zones are APEX domains: the user's `dsh.example.com` lives in the
      // zone named `example.com`, so the exact-name lookup walks the
      // ancestor chain (GW-fix-2/H1). First hit wins.
      const chain = ancestorHosts(host)
      for (const accountId of await this.listAccounts()) {
        for (const candidate of chain) {
          try {
            const zoneId = await this.getZone(accountId, candidate)
            return { onCloudflare: true, zoneId, accountId }
          } catch (error) {
            if (error instanceof CloudflareError && error.code === 'cf-zone-not-found') continue
            throw error
          }
        }
      }
      return { onCloudflare: false, zoneId: null, accountId: null }
    },
  }
}

// --- module-level one-call wrappers (the ticket's cf* naming) ----------------

type CfCallOptions = Partial<Pick<CloudflareApiOptions, 'fetchImpl' | 'baseUrl'>>

export function cfListAccounts(token: string, opts?: CfCallOptions): Promise<string[]> {
  return createCloudflareApi({ token, ...opts }).listAccounts()
}

export function cfGetZone(token: string, accountId: string, domain: string, opts?: CfCallOptions): Promise<string> {
  return createCloudflareApi({ token, ...opts }).getZone(accountId, domain)
}

export function cfCreateTunnel(token: string, accountId: string, name: string, opts?: CfCallOptions): Promise<{ id: string; token: string }> {
  return createCloudflareApi({ token, ...opts }).createTunnel(accountId, name)
}

export function cfListTunnels(token: string, accountId: string, opts?: CfCallOptions): Promise<CloudflareTunnelSummary[]> {
  return createCloudflareApi({ token, ...opts }).listTunnels(accountId)
}

export function cfGetTunnelToken(token: string, accountId: string, tunnelId: string, opts?: CfCallOptions): Promise<string> {
  return createCloudflareApi({ token, ...opts }).getTunnelToken(accountId, tunnelId)
}

export function cfConfigureIngress(
  token: string,
  accountId: string,
  tunnelId: string,
  domain: string,
  serviceUrl: string,
  opts?: CfCallOptions,
): Promise<void> {
  return createCloudflareApi({ token, ...opts }).configureIngress(accountId, tunnelId, domain, serviceUrl)
}

export function cfCreateDnsRecord(token: string, zoneId: string, subdomain: string, target: string, opts?: CfCallOptions): Promise<string> {
  return createCloudflareApi({ token, ...opts }).createDnsRecord(zoneId, subdomain, target)
}

export function cfCheckDomainOnCloudflare(token: string, domain: string, opts?: CfCallOptions): Promise<CloudflareDomainCheck> {
  return createCloudflareApi({ token, ...opts }).checkDomainOnCloudflare(domain)
}
