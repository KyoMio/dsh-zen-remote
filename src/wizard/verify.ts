/**
 * Final-verification orchestration (GW-9): the wizard's last mile, where
 * 「完成」 means a real phone really paired through the real public URL —
 * never a green light from internal checks alone (设计: 不做已联通的假绿灯).
 *
 * The flow, spread over two entry points the UI drives:
 *
 *   start({ publicUrl }): runtime ready? → walk the public URL
 *   (GW-8's probe; BOTH the pairing page and the admin-403 shape must be
 *   right) → snapshot the gateway's device ids (the baseline) → mint a WEB
 *   pairing code → remember the session IN MEMORY and answer with the
 *   code, the URL and the expiry. The code never touches the row config,
 *   and minting it restarts nothing — trustedProxies changes are what
 *   restart the gateway, and any such change invalidates the session
 *   instead (the config fingerprint below).
 *
 *   check(): re-read the gateway status. A device id the baseline did not
 *   have is a freshly paired phone; the gateway's lastWebClaim record must
 *   name THAT device with secure === true (the proxy passed
 *   X-Forwarded-Proto: https through, so the issued cookie carries the
 *   Secure flag). All green → pass. The claim recorded an insecure cookie →
 *   cookie-insecure. Past the code's expiry → code-expired. Anything else →
 *   pending, keep polling.
 *
 * The session binds to a CONFIG FINGERPRINT (ingressMode, domain,
 * httpsPort, publicUrl, the gateway's ACTUAL port, host, trustedProxies):
 * any of those moving between start and check answers stale and discards
 * the session, because the verification proved a URL that no longer exists.
 * The session is deliberately memory-only — a row reload (which a
 * trustedProxies change causes) builds a fresh manager and the session is
 * gone, exactly the same verdict the fingerprint would have produced.
 */

import type { ZenRemoteConfig } from '../config.js'
import { normalizeServerUrl } from '../client-pairing.js'
import { probeHostPath, type HostPathOutcome } from './probe.js'

export interface VerificationManagerOptions {
  /** Loopback base of the gateway child, `http://127.0.0.1:<port>`. */
  gatewayBase: string
  /** Fresh resolved config values per call (volatile discipline). */
  getValues: () => ZenRemoteConfig
  /** The hostPath probe; injectable for tests (defaults to GW-8's real one). */
  probe?: (publicUrl: string) => Promise<HostPathOutcome>
  /** Whether the ingress processes are alive (Caddy / cloudflared). The
   * wiring supplies this once the process managers are mounted; absent
   * means "checked elsewhere" and only the gateway is probed. */
  runtimeReady?: () => boolean | Promise<boolean>
  fetchImpl?: typeof fetch
  /** Per-gateway-call ceiling. Default 5000 ms. */
  timeoutMs?: number
  /** Clock (tests drive expiry). */
  now?: () => number
}

export type VerificationStartResult =
  | { ok: true; pairingCode: string; publicUrl: string; expiresAt: number }
  | {
    ok: false
    reason: 'no-public-url' | 'bad-public-url' | 'runtime-not-ready' | 'gateway-unreachable' | 'probe-failed' | 'pair-refused'
    /** The probe's classifications for `probe-failed`; the gateway's status
     * code for `pair-refused`; the normalize failure reason for
     * `bad-public-url`. */
    detail?: unknown
  }

export type VerificationCheckResult =
  | { result: 'not-started' }
  | { result: 'stale' }
  | { result: 'code-expired' }
  | { result: 'pending' }
  | { result: 'cookie-insecure'; deviceId: string }
  | { result: 'pass'; deviceId: string; at: number }

/** What the wizard reads off one gateway status answer. */
interface GatewayStatusView {
  deviceIds: string[]
  port: number | null
  lastWebClaim: { id: string; secure: boolean; at: number } | null
}

/**
 * The config fingerprint a session binds to: any drift between start and
 * check means the verified URL is no longer the deployed URL.
 */
export function verificationFingerprint(values: ZenRemoteConfig, gatewayPort: number | null): string {
  return JSON.stringify({
    ingressMode: values.ingressMode,
    ingressDomain: values.ingressDomain,
    ingressHttpsPort: values.ingressHttpsPort,
    ingressPublicUrl: values.ingressPublicUrl,
    gatewayPort,
    host: values.host,
    trustedProxies: values.trustedProxies,
  })
}

interface VerificationSession {
  publicUrl: string
  code: string
  expiresAt: number
  /** Device ids the gateway already had when the code was minted. */
  knownDeviceIds: ReadonlySet<string>
  fingerprint: string
}

export interface VerificationManager {
  start(input: { publicUrl: unknown; probeOnly?: boolean }): Promise<VerificationStartResult>
  check(): Promise<VerificationCheckResult>
  /** Whether a verification session is open (the route surfaces it for the
   * UI's 「待外部验证」 state). */
  hasSession(): boolean
}

export function createVerificationManager(options: VerificationManagerOptions): VerificationManager {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 5000
  const now = options.now ?? Date.now
  let session: VerificationSession | null = null

  /** One loopback gateway call AS the local machine. Answer status+body or
   * null on any failure — every caller degrades, none throws. */
  const callGateway = async (method: 'GET' | 'POST', path: string, payload?: unknown): Promise<{ status: number; body: unknown } | null> => {
    try {
      const response = await fetchImpl(`${options.gatewayBase}${path}`, {
        method,
        headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body: unknown = await response.json()
      return { status: response.status, body }
    } catch {
      return null
    }
  }

  const readStatus = async (): Promise<GatewayStatusView | null> => {
    const reply = await callGateway('GET', '/lan-gate/status')
    if (reply === null || reply.status < 200 || reply.status >= 300) return null
    const body = reply.body as { devices?: unknown; port?: unknown; lastWebClaim?: unknown }
    if (body === null || typeof body !== 'object') return null
    const deviceIds: string[] = Array.isArray(body.devices)
      ? body.devices.map((device) => (device !== null && typeof device === 'object' ? (device as { id?: unknown }).id : undefined))
          .filter((id): id is string => typeof id === 'string')
      : []
    const port = typeof body.port === 'number' ? body.port : null
    const claim = body.lastWebClaim
    const lastWebClaim = claim !== null && typeof claim === 'object'
      ? {
          id: typeof (claim as { id?: unknown }).id === 'string' ? (claim as { id: string }).id : '',
          secure: (claim as { secure?: unknown }).secure === true,
          at: typeof (claim as { at?: unknown }).at === 'number' ? (claim as { at: number }).at : 0,
        }
      : null
    return { deviceIds, port, lastWebClaim }
  }

  return {
    async start({ publicUrl, probeOnly }) {
      if (typeof publicUrl !== 'string' || publicUrl.trim() === '') return { ok: false, reason: 'no-public-url' }
      // Same admission as the probe: https anywhere, plain http only into
      // the private-network allowances. The URL the phone will open must
      // be one this machine is willing to verify at all.
      const normalized = normalizeServerUrl(publicUrl)
      if (!normalized.ok) return { ok: false, reason: 'bad-public-url', detail: normalized.reason }

      if ((await options.runtimeReady?.()) === false) return { ok: false, reason: 'runtime-not-ready' }

      const statusBefore = await readStatus()
      if (statusBefore === null) return { ok: false, reason: 'gateway-unreachable' }

      const outcome = await (options.probe ?? probeHostPath)(normalized.url)
      if (outcome.kind !== 'reached' || outcome.root !== 'gateway-pairing-page' || outcome.admin !== 'gateway-admin-403') {
        return { ok: false, reason: 'probe-failed', detail: outcome }
      }

      if (probeOnly === true) {
        return { ok: true, pairingCode: '', publicUrl: normalized.url, expiresAt: 0 }
      }

      const pair = await callGateway('POST', '/lan-gate/pair', { role: 'web' })
      const pairBody = pair?.body as { ok?: unknown; code?: unknown; expiresAt?: unknown } | undefined
      if (pair === null || pair.status < 200 || pair.status >= 300 || pairBody?.ok !== true || typeof pairBody.code !== 'string' || typeof pairBody.expiresAt !== 'number') {
        return { ok: false, reason: 'pair-refused', detail: pair === null ? null : pair.status }
      }

      session = {
        publicUrl: normalized.url,
        code: pairBody.code,
        expiresAt: pairBody.expiresAt,
        knownDeviceIds: new Set(statusBefore.deviceIds),
        fingerprint: verificationFingerprint(options.getValues(), statusBefore.port),
      }
      return { ok: true, pairingCode: session.code, publicUrl: session.publicUrl, expiresAt: session.expiresAt }
    },

    async check() {
      if (session === null) return { result: 'not-started' }
      const status = await readStatus()
      if (status === null) return { result: 'pending' }
      // The verified URL must still BE the deployed URL: a config or
      // gateway-port drift discards the session outright.
      if (verificationFingerprint(options.getValues(), status.port) !== session.fingerprint) {
        session = null
        return { result: 'stale' }
      }
      // New devices first, expiry second: the claim itself proves the code
      // was still valid when it was redeemed, so a poll that lands moments
      // past the expiry must not swallow a pass.
      const newcomers = status.deviceIds.filter((id) => !session!.knownDeviceIds.has(id))
      if (newcomers.length > 0) {
        const deviceId = newcomers[newcomers.length - 1]
        const claim = status.lastWebClaim
        if (claim !== null && claim.id === deviceId) {
          session = null
          if (!claim.secure) return { result: 'cookie-insecure', deviceId }
          return { result: 'pass', deviceId, at: claim.at }
        }
        // A claim record that has not surfaced (or names a different,
        // later claim): keep polling rather than bless an unverified cookie.
        return { result: 'pending' }
      }
      if (now() >= session.expiresAt) {
        session = null
        return { result: 'code-expired' }
      }
      return { result: 'pending' }
    },

    hasSession: () => session !== null,
  }
}
