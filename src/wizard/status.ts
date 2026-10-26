/**
 * Wizard status projection (GW-1): declared ingress config + observed
 * runtime facts → one sanitized JSON shape the browser may see.
 *
 * This module is the SECURITY BOUNDARY for everything the wizard surfaces
 * on `GET /_dsh/zen-remote/admin/wizard/status`. The two properties it must
 * hold, regardless of what the callers hand it:
 *
 *   1. No secret material. The Cloudflare API token and the cloudflared
 *      tunnel token never enter this module — the runtime side reports only
 *      `*Configured` booleans (the files live 0600 under
 *      `<DSH_HOME>/zen-remote-ingress/`, and their contents stay there).
 *   2. No file paths. The runtime side knows where binaries, token files
 *      and the Caddyfile live; the projection carries none of it — every
 *      output field is built from a whitelist below, and input objects are
 *      never spread through.
 *
 * Pure logic on purpose: zero imports, so the check scripts and the tests
 * can drive it through Node's strip-only type stripping, and the wizard
 * routes can call it per request without re-resolving anything.
 *
 * Every input is coerced defensively. The declared side normally arrives
 * from `resolveConfig(...).values` (already legal), but the projection is
 * also the last line of defense for the wire: an off-enum mode answers
 * `'off'`, a junk port answers the 443 default, a non-string domain answers
 * `''` — same transparency discipline as the config resolver, applied at
 * the rendering edge.
 */

/** The ingress modes `resolveConfig` can legally produce. */
export const WIZARD_INGRESS_MODES = ['off', 'caddy', 'external', 'cloudflared'] as const

export type WizardIngressMode = (typeof WIZARD_INGRESS_MODES)[number]

/**
 * The declared slice of the resolved config. Loose (`unknown`) on purpose:
 * the projection is what guarantees the wire shape, not the caller's typing.
 */
export interface WizardDeclaredInput {
  ingressMode?: unknown
  ingressDomain?: unknown
  ingressHttpsPort?: unknown
  ingressPublicUrl?: unknown
}

/**
 * One probe / verification memory the wizard back-end keeps. Only these
 * three fields are recognized; everything else on the record (URLs probed,
 * error details, headers) is dropped at the boundary.
 */
export interface WizardRecordInput {
  result?: unknown
  deviceId?: unknown
  at?: unknown
}

/**
 * The gateway's own detection of an untrusted reverse proxy (GW-5): the
 * socket peer of the last request that carried proxy headers from an IP
 * outside `trustedProxies` — almost certainly the user's own proxy, and
 * the one IP the trust-proxy flow offers to add. Whitelist-projected like
 * everything else.
 */
export interface WizardForwardedSourceInput {
  ip?: unknown
  at?: unknown
}

/**
 * Runtime facts the wizard back-end observes live. Everything is optional —
 * a composition that has not started any ingress process simply omits the
 * fields. Token presence is reported as booleans only; port as the gateway
 * child's ACTUAL listening port (it may differ from the configured one).
 */
export interface WizardRuntimeInput {
  cfTokenConfigured?: unknown
  tunnelTokenConfigured?: unknown
  caddyRunning?: unknown
  cloudflaredRunning?: unknown
  gatewayActualPort?: unknown
  lanAddress?: unknown
  lastHostProbe?: WizardRecordInput | null
  lastExternalVerification?: WizardRecordInput | null
  lastForwardedSource?: WizardForwardedSourceInput | null
}

/** One projected probe / verification memory, or null when there is none. */
export interface WizardStatusRecord {
  result: string
  deviceId: string | null
  at: number | null
}

/** One projected untrusted-proxy detection, or null when none is pending. */
export interface WizardStatusForwardedSource {
  ip: string
  at: number
}

/** The full sanitized status the wizard status route answers with. */
export interface WizardStatus {
  ok: true
  mode: WizardIngressMode
  domain: string
  httpsPort: number
  publicUrl: string
  cfTokenConfigured: boolean
  tunnelTokenConfigured: boolean
  caddyRunning: boolean
  cloudflaredRunning: boolean
  gatewayActualPort: number | null
  lanAddress?: string
  lastHostProbe: WizardStatusRecord | null
  lastExternalVerification: WizardStatusRecord | null
  lastForwardedSource: WizardStatusForwardedSource | null
}

function modeOf(value: unknown): WizardIngressMode {
  return typeof value === 'string' && (WIZARD_INGRESS_MODES as readonly string[]).includes(value)
    ? (value as WizardIngressMode)
    : 'off'
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function portOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null
}

/**
 * Project one probe / verification memory down to its three wire fields.
 * A record without a string `result` is not a memory — it answers null, so
 * a corrupt runtime entry can never render as a half-valid verdict.
 */
function recordOf(input: WizardRecordInput | null | undefined): WizardStatusRecord | null {
  if (input === null || input === undefined || typeof input !== 'object') return null
  const { result, deviceId, at } = input
  if (typeof result !== 'string' || result === '') return null
  return {
    result,
    deviceId: typeof deviceId === 'string' && deviceId !== '' ? deviceId : null,
    at: typeof at === 'number' && Number.isFinite(at) ? at : null,
  }
}

/** Project one untrusted-proxy detection down to its two wire fields. */
function forwardedSourceOf(input: WizardForwardedSourceInput | null | undefined): WizardStatusForwardedSource | null {
  if (input === null || input === undefined || typeof input !== 'object') return null
  const { ip, at } = input
  if (typeof ip !== 'string' || ip === '') return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  return { ip, at }
}

/**
 * Build the sanitized wizard status. Both arguments are optional so a
 * composition can answer before anything is configured; the all-empty
 * answer is the honest "wizard not started" state (`mode: 'off'`, no ports,
 * no tokens configured, no memories).
 */
export function projectWizardStatus(declared: WizardDeclaredInput = {}, runtime: WizardRuntimeInput = {}): WizardStatus {
  return {
    ok: true,
    mode: modeOf(declared.ingressMode),
    domain: stringOf(declared.ingressDomain),
    httpsPort: portOf(declared.ingressHttpsPort) ?? 443,
    publicUrl: stringOf(declared.ingressPublicUrl),
    cfTokenConfigured: runtime.cfTokenConfigured === true,
    tunnelTokenConfigured: runtime.tunnelTokenConfigured === true,
    caddyRunning: runtime.caddyRunning === true,
    cloudflaredRunning: runtime.cloudflaredRunning === true,
    gatewayActualPort: portOf(runtime.gatewayActualPort),
    ...(typeof runtime.lanAddress === 'string' && runtime.lanAddress !== '' ? { lanAddress: runtime.lanAddress } : {}),
    lastHostProbe: recordOf(runtime.lastHostProbe),
    lastExternalVerification: recordOf(runtime.lastExternalVerification),
    lastForwardedSource: forwardedSourceOf(runtime.lastForwardedSource),
  }
}
