/**
 * hostPath probe (GW-8): the server machine walks its OWN public URL and
 * classifies what answers, so the wizard can say something sharper than
 * "it didn't work" — the pairing page showing up means TLS + proxying to
 * the gateway both work; the admin surface answering 200 means the proxy
 * is DROPPING the forwarded headers the gateway trusts; a redirect smells
 * like Cloudflare Access or a proxy rewriting to a login page.
 *
 * Split exactly as the ticket asks: the two `classify*Response` functions
 * are pure (the check scripts can drive them), `probeHostPath` owns the
 * fetch I/O — `redirect: 'manual'` so a proxy's 3xx is SEEN, never
 * followed — with the URL admission reusing client-pairing's
 * `normalizeServerUrl` (https anywhere; plain http only for the explicit
 * private-network allowances) and a 10 s ceiling per request.
 */

import { normalizeServerUrl } from '../client-pairing.js'

/** What answered on `GET <publicUrl>/`. */
export type RootClassification =
  | 'gateway-pairing-page'
  | 'unexpected-401'
  | 'unexpected-200'
  | 'redirect'
  | 'unexpected'

/** What answered on `GET <publicUrl>/lan-gate/admin`. */
export type AdminClassification =
  | 'gateway-admin-403'
  | 'admin-exposed'
  | 'proxy-403'
  | 'unexpected'

/**
 * `GET /`: the ONE right answer is the gateway's pairing page — 401,
 * text/html, carrying the claim-endpoint marker the page's own script
 * posts to. A 200 means the URL belongs to something else entirely.
 */
export function classifyRootResponse(status: number, contentType: string, body: string): RootClassification {
  if (status === 401) {
    if (contentType.includes('text/html') && body.includes('/lan-gate/pair/claim')) return 'gateway-pairing-page'
    return 'unexpected-401'
  }
  if (status >= 200 && status < 300) return 'unexpected-200'
  if (status >= 300 && status < 400) return 'redirect'
  return 'unexpected'
}

/**
 * `GET /lan-gate/admin`: right is the gateway's own 403 JSON — a public
 * visitor must not get in. 200 + HTML is the DANGEROUS shape: something
 * answered with a page, meaning the proxy forwarded without the
 * forwarded headers and the gateway's local-only wall never saw a
 * proxied request (the admin page leaked). 403 + HTML smells like
 * Cloudflare Access interposing its own login.
 */
export function classifyAdminResponse(status: number, contentType: string, body: string): AdminClassification {
  const isHtml = contentType.includes('text/html')
  if (status === 403) {
    if (isHtml) return 'proxy-403'
    if (contentType.includes('application/json')) {
      try {
        const parsed: unknown = JSON.parse(body)
        if (parsed !== null && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === false) {
          return 'gateway-admin-403'
        }
      } catch {
        // JSON-shaped header with a non-JSON body: not our gateway's answer.
      }
    }
    return 'unexpected'
  }
  if (status >= 200 && status < 300 && isHtml) return 'admin-exposed'
  return 'unexpected'
}

export interface HostPathReached {
  kind: 'reached'
  root: RootClassification
  admin: AdminClassification
  /** Wall-clock cost of both requests, milliseconds. */
  ms: number
}

export interface HostPathUnreachable {
  kind: 'unreachable'
  /** `invalid-url` / `insecure-http` — the URL never stood a chance;
   * `timeout` — the 10 s ceiling fired; `network` — DNS, refused, reset. */
  reason: 'invalid-url' | 'insecure-http' | 'timeout' | 'network'
  detail?: string
  ms: number
}

export type HostPathOutcome = HostPathReached | HostPathUnreachable

export interface ProbeOptions {
  fetchImpl?: typeof fetch
  /** Per-request ceiling. Default 10 000 ms (the ticket's value). */
  timeoutMs?: number
  /** Clock for the `ms` measurement (tests). */
  now?: () => number
}

/** One manual-redirect GET, classified. Sends a browser-shaped `Accept:
 * text/html` (never `application/json`, which tells `lan-gate-server.cjs`
 * the caller is an XHR/API client and makes `GET /` answer 401 JSON
 * `{"ok":false,"reason":"unpaired"}` instead of the HTML pairing page;
 * `/lan-gate/admin` answers 403 JSON regardless of `Accept`). */
async function probeOnce(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<{ status: number; contentType: string; body: string }> {
  const response = await fetchImpl(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'text/html' },
  })
  const body = await response.text()
  return { status: response.status, contentType: String(response.headers.get('content-type') ?? ''), body }
}

/**
 * Probe the machine's public URL from here: both the root path and the
 * admin surface, never following a redirect. The two requests run
 * concurrently; the answer carries both classifications and the elapsed
 * time. Every failure mode is a VALUE (`kind: 'unreachable'`), never a
 * throw — the wizard routes render whichever verdict arrived.
 */
export async function probeHostPath(publicUrl: unknown, options: ProbeOptions = {}): Promise<HostPathOutcome> {
  const started = (options.now ?? Date.now)()
  const elapsed = () => (options.now ?? Date.now)() - started
  // Same admission the client pairing uses: https anywhere, plain http
  // only into the explicit private-network allowances.
  const normalized = normalizeServerUrl(typeof publicUrl === 'string' ? publicUrl : '')
  if (!normalized.ok) {
    return { kind: 'unreachable', reason: normalized.reason === 'insecure-http' ? 'insecure-http' : 'invalid-url', ms: 0 }
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  try {
    const [root, admin] = await Promise.all([
      probeOnce(fetchImpl, `${normalized.url}/`, timeoutMs),
      probeOnce(fetchImpl, `${normalized.url}/lan-gate/admin`, timeoutMs),
    ])
    return {
      kind: 'reached',
      root: classifyRootResponse(root.status, root.contentType, root.body),
      admin: classifyAdminResponse(admin.status, admin.contentType, admin.body),
      ms: elapsed(),
    }
  } catch (error) {
    const name = (error as Error)?.name
    return {
      kind: 'unreachable',
      reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      detail: String((error as Error)?.message ?? error),
      ms: elapsed(),
    }
  }
}
