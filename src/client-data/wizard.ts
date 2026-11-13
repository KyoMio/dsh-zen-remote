/**
 * Wizard UI pure logic (GW-10): route constants, wire types, the step
 * state machine, form validation and the derived lights — everything the
 * React components need that a test can drive without a DOM. Mirrors of
 * the host half's shapes (src/wizard/routes.ts / verify.ts /
 * proxy-snippets.ts) live HERE because the browser bundle cannot import
 * those modules (they transitively import node builtins through
 * config.ts); the check script cross-checks the snippet templates against
 * the host's so the two cannot drift.
 *
 * Validation mirrors src/config.ts's `hostOf` for the same reason — the
 * row layer applies the same rule when the fields land there, so a client
 * that accepts something the resolver would silently drop would only set
 * the user up for a mystery.
 *
 * MS-6 adds the paired-pool overview pieces: the pool count is a first-class
 * "configured" signal (MS-5 pairs straight into the pool store, not the
 * row), and {@link deriveClientOverviewSummary} derives the overview card's
 * counters and its two lights (connection health / pool fill) off the
 * `client/status` pool list.
 */

import { MAX_PAIRED_SERVERS } from './settings-form.ts'
import type { ClientServerView, PeerSyncReadinessView } from './settings-form.ts'

/** Wizard route constants — mirror of src/wizard/routes.ts. */
export const WIZARD_STATUS_ROUTE = '/_dsh/zen-remote/admin/wizard/status'
export const WIZARD_VERIFY_ROUTE = '/_dsh/zen-remote/admin/wizard/verify'
export const WIZARD_CF_TOKEN_ROUTE = '/_dsh/zen-remote/admin/wizard/cf-token'
export const WIZARD_TUNNEL_TOKEN_ROUTE = '/_dsh/zen-remote/admin/wizard/tunnel-token'
export const WIZARD_CADDY_START_ROUTE = '/_dsh/zen-remote/admin/wizard/caddy/start'
export const WIZARD_CADDY_STOP_ROUTE = '/_dsh/zen-remote/admin/wizard/caddy/stop'
export const WIZARD_CADDY_STATUS_ROUTE = '/_dsh/zen-remote/admin/wizard/caddy/status'
export const WIZARD_TUNNEL_CHECK_ROUTE = '/_dsh/zen-remote/admin/wizard/tunnel/check-domain'
export const WIZARD_TUNNEL_SETUP_ROUTE = '/_dsh/zen-remote/admin/wizard/tunnel/setup'
export const WIZARD_TUNNEL_STOP_ROUTE = '/_dsh/zen-remote/admin/wizard/tunnel/stop'
export const WIZARD_TUNNEL_STATUS_ROUTE = '/_dsh/zen-remote/admin/wizard/tunnel/status'

/** Wire mirror of src/wizard/routes.ts's CaddyProcessState. */
export type CaddyState = 'running' | 'stopped' | 'never-started'

/** Wire mirror of src/wizard/tunnel-orchestrator.ts's results. */
export interface TunnelExisting {
  id: string
  name: string
  status: string
}

export type TunnelSetupWire =
  | { ok: true; tunnelId: string; publicUrl: string }
  | { ok: false; reason: string; detail?: string; existing?: TunnelExisting[] }

export type TunnelCheckWire =
  | { ok: true; onCloudflare: boolean; zoneId: string | null }
  | { ok: false; reason: string; detail?: string }

/** The tunnel setup failure's locale key (plus params). Pure. */
export function tunnelFailureCopy(reason: string, detail?: string): { key: string; params: Record<string, string> } {
  switch (reason) {
    case 'tunnel-conflict':
      return { key: 'wizard.tunnel.conflict', params: {} }
    case 'zone-not-found':
      return { key: 'wizard.tunnel.zoneNotFound', params: {} }
    case 'dns-conflict':
      return { key: 'wizard.tunnel.dnsConflict', params: { detail: detail ?? '' } }
    case 'auth':
      return { key: 'wizard.tunnel.auth', params: {} }
    case 'network':
      return { key: 'wizard.tunnel.network', params: {} }
    case 'no-token':
      return { key: 'wizard.tunnel.noToken', params: {} }
    case 'bad-domain':
      return { key: 'wizard.tunnel.badDomain', params: {} }
    case 'spawn-failed':
      return { key: 'wizard.tunnel.spawnFailed', params: { detail: detail ?? '' } }
    default:
      return { key: 'wizard.tunnel.api', params: { detail: detail ?? reason } }
  }
}

/** The domain check's copy (the migration card's re-check). Pure. */
export function tunnelCheckCopy(result: TunnelCheckWire): { key: string; tone: 'ok' | 'error' } {
  if (result.ok) {
    return result.onCloudflare
      ? { key: 'wizard.check.okOnCf', tone: 'ok' }
      : { key: 'wizard.check.okNotOnCf', tone: 'error' }
  }
  return { key: 'wizard.check.failed', tone: 'error' }
}

/** Wire mirror of src/wizard/status.ts's WizardStatus. */
export interface WizardStatusBody {
  ok: true
  mode: 'off' | 'caddy' | 'external' | 'cloudflared'
  domain: string
  httpsPort: number
  publicUrl: string
  cfTokenConfigured: boolean
  tunnelTokenConfigured: boolean
  caddyRunning: boolean
  cloudflaredRunning: boolean
  gatewayActualPort: number | null
  lanAddress?: string
  lastHostProbe: { result: string; deviceId: string | null; at: number | null } | null
  lastExternalVerification: { result: string; deviceId: string | null; at: number | null } | null
  lastForwardedSource: { ip: string; at: number } | null
}

/** Wire mirror of src/wizard/verify.ts's poll result. */
export type WizardVerifyPoll =
  | { result: 'not-started' }
  | { result: 'stale' }
  | { result: 'code-expired' }
  | { result: 'pending' }
  | { result: 'cookie-insecure'; deviceId: string }
  | { result: 'pass'; deviceId: string; at: number }

/** Wire mirror of src/wizard/verify.ts's start result. */
export type WizardVerifyStart =
  | { ok: true; pairingCode: string; publicUrl: string; expiresAt: number }
  | { ok: false; reason: 'no-public-url' | 'bad-public-url' | 'runtime-not-ready' | 'gateway-unreachable' | 'probe-failed' | 'pair-refused'; detail?: unknown }

// --- the step state machine ----------------------------------------------------

/** The deployment role the unified wizard configures: server (`host`),
 * desktop sub-client (`client`) or peer node (`peer`, PG-9 — joins a device
 * network for two-way session access while keeping the phone-PWA half). */
export type WizardRole = 'host' | 'client' | 'peer'

/**
 * The row role a channel-config save writes (PG-9-fix): the phone-PWA
 * flows (Caddy / Cloudflare Tunnel / reverse proxy / LAN) run under
 * `wizardRole: 'host'`, and a peer that opened them from its lower PWA
 * section must keep its row role — writing `'host'` there would kick the
 * machine out of its virtual network. `keepPeerRole` is set exactly when
 * the user ENTERED the host-flow from a peer surface; a deliberate pick of
 * 「作为主服务端」 on the role cards clears it.
 */
export function targetHostSaveRole(keepPeerRole: boolean): 'host' | 'peer' {
  return keepPeerRole ? 'peer' : 'host'
}

/** The three wizard steps: pick a path, fill its form, verify end to end. */
export type WizardStep = 'pick' | 'configure' | 'verify'

/** The four server-ingress paths (the three public ones plus LAN-only `'lan'`). */
export type WizardPath = 'caddy' | 'external' | 'cloudflared' | 'lan'

/** Where the wizard opens: a configured ingress jumps straight to verify. */
export function initialStep(status: WizardStatusBody | undefined): WizardStep {
  return status !== undefined && status.mode !== 'off' ? 'verify' : 'pick'
}

/**
 * Whether the inline overview card should render the configured status
 * dashboard instead of the first-time setup prompt. MS-6: the paired pool's
 * size is the client's first-class signal — since MS-5 a claim lands in the
 * pool store and never touches the row's `serverUrl` / `deviceToken`, so a
 * freshly multi-paired machine with an empty row must still read as
 * configured. `> 0` answers true no matter what the other inputs say; the
 * field is optional and an omitted one (or a zero) changes nothing.
 */
export function isWizardConfigured(input: {
  effectiveClient: boolean
  wizardStatus: WizardStatusBody | undefined
  pairedDeviceCount: number
  hasSavedHostConfig: boolean
  tokenConfigured: boolean
  clientServerUrl: string
  clientState: string | undefined
  pairedServerCount?: number
  /** PG-9: the peer engine reports a joined network. True answers
   * configured no matter what the host/client signals say (a peer row has
   * neither a wizard ingress nor paired servers, yet its overview renders). */
  peerConfigured?: boolean
}): boolean {
  if (input.peerConfigured === true) return true
  if ((input.pairedServerCount ?? 0) > 0) return true
  if (input.effectiveClient) {
    return input.tokenConfigured || input.clientServerUrl.trim() !== '' || input.clientState === 'connected'
  }
  if (input.wizardStatus !== undefined && (input.wizardStatus.mode !== 'off' || input.wizardStatus.publicUrl !== '')) {
    return true
  }
  return input.pairedDeviceCount > 0 || input.hasSavedHostConfig
}

export interface WizardFormSeed {
  domain: string
  httpsPort: string
  serverUrl: string
  path: WizardPath | undefined
}

/**
 * The configure-form seed from one wizard status projection (GW-fix-3/M1):
 * the projection (wizard/status) is the ONLY surface that carries the
 * ingress fields — admin/status strips them by design, so the form must
 * seed from here. Empty values leave the form untouched.
 */
export function formSeedOf(status: WizardStatusBody | undefined): WizardFormSeed {
  if (status === undefined || status.mode === 'off') {
    return { domain: '', httpsPort: '', serverUrl: '', path: undefined }
  }
  return {
    domain: status.domain,
    httpsPort: String(status.httpsPort),
    serverUrl: status.publicUrl,
    path: status.mode,
  }
}

/**
 * The reverse-proxy snippet's upstream port: the gateway's ACTUAL port as
 * the wizard runtime reports it, falling back to the configured default
 * 3088 when no status has landed yet (GW-fix-3/M2).
 */
export function upstreamPortOf(status: WizardStatusBody | undefined): number {
  return typeof status?.gatewayActualPort === 'number' && status.gatewayActualPort >= 1 && status.gatewayActualPort <= 65535
    ? status.gatewayActualPort
    : 3088
}

/** The step AFTER pick, given the user's path choice. */
export function stepAfterPick(): WizardStep {
  return 'configure'
}

/** Hostname shape (mirror of src/config.ts hostOf): bare letters/digits/
 * dots/inner hyphens, labels ≤ 63, total ≤ 253, no scheme/path/port/
 * whitespace. IP literals pass. */
const HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/

export function isValidHostname(value: string): boolean {
  return value.length <= 253 && HOSTNAME_PATTERN.test(value)
}

/** Port strings: [1, 65535]. */
export function isValidPort(value: string): boolean {
  if (!/^\d+$/.test(value)) return false
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
}

/** The public origin a verified domain+port answers on (443 hides the port). */
export function publicUrlFrom(domain: string, httpsPort: number): string {
  return httpsPort === 443 ? `https://${domain}` : `https://${domain}:${httpsPort}`
}

/** Which configure form is complete enough to advance. */
export function configureReadiness(
  path: WizardPath,
  form: { domain: string; httpsPort: string; cfToken: string; serverUrl: string },
): { ok: true; publicUrl: string; httpsPort: number } | { ok: false; error: 'bad-domain' | 'bad-port' | 'missing-token' | 'bad-server-url' } {
  if (path === 'lan') {
    const trimmed = form.serverUrl.trim().replace(/\/+$/u, '')
    if (trimmed === '') return { ok: true, publicUrl: '', httpsPort: 443 }
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return { ok: false, error: 'bad-server-url' }
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || (parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search !== '' || parsed.hash !== '') {
      return { ok: false, error: 'bad-server-url' }
    }
    return { ok: true, publicUrl: parsed.origin, httpsPort: 443 }
  }
  if (path === 'external') {
    // The user's own reverse proxy: the public origin is the one thing to
    // get right (same admission the probe applies — https, root path).
    const trimmed = form.serverUrl.trim().replace(/\/+$/u, '')
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return { ok: false, error: 'bad-server-url' }
    }
    if (parsed.protocol !== 'https:' || (parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search !== '' || parsed.hash !== '') {
      return { ok: false, error: 'bad-server-url' }
    }
    return { ok: true, publicUrl: parsed.origin, httpsPort: 443 }
  }
  if (!isValidHostname(form.domain.trim())) return { ok: false, error: 'bad-domain' }
  if (!isValidPort(form.httpsPort.trim())) return { ok: false, error: 'bad-port' }
  const port = Number(form.httpsPort.trim())
  if ((path === 'caddy' || path === 'cloudflared') && form.cfToken.trim() === '') return { ok: false, error: 'missing-token' }
  return { ok: true, publicUrl: publicUrlFrom(form.domain.trim(), port), httpsPort: port }
}

// --- the verification lights -----------------------------------------------------

export type LightState = 'pass' | 'pending' | 'fail'

export interface WizardLights {
  /** The gateway child answers on this machine. */
  gateway: LightState
  /** The public URL walks back to this gateway. */
  publicUrl: LightState
  /** A phone actually paired through it. */
  pairing: LightState
}

/** Pending-but-started states the lights stay amber on. */
const VERIFY_PENDING_RESULTS: ReadonlySet<string> = new Set(['not-started', 'pending', 'stale', 'code-expired'])

/**
 * The three progress lights, derived from the admin/status reachability
 * plus the verification poll result. Before a session is started the poll
 * answers `not-started`, which is a pending state — the public and pairing
 * lights stay amber (nothing has been tried, so red would just shout);
 * once started, an amber poll keeps them amber, a wrong-shape answer
 * (redirect, someone else's server) turns the public light red, and an
 * insecure cookie turns the pairing light red without ever passing.
 */
export function deriveWizardLights(input: {
  gatewayReachable: boolean
  poll: WizardVerifyPoll | undefined
  startResult?: WizardVerifyStart | undefined
}): WizardLights {
  const { poll, startResult } = input
  const startProbeFailed = startResult !== undefined && !startResult.ok
    && (startResult.reason === 'probe-failed' || startResult.reason === 'bad-public-url' || startResult.reason === 'no-public-url')
  const startProbePassed = startResult?.ok === true && poll?.result !== 'stale' && poll?.result !== 'cookie-insecure'
  const publicFail = startProbeFailed || (poll !== undefined && poll.result !== 'pass' && !VERIFY_PENDING_RESULTS.has(poll.result))
  return {
    gateway: input.gatewayReachable ? 'pass' : 'fail',
    publicUrl: (poll?.result === 'pass' || startProbePassed) ? 'pass' : publicFail ? 'fail' : 'pending',
    pairing: poll?.result === 'pass' ? 'pass' : poll?.result === 'cookie-insecure' ? 'fail' : 'pending',
  }
}

export interface ClientWizardLights {
  /** Whether a desktop-client token is saved on this machine. */
  credential: LightState
  /** Whether the client can reach and authenticate with the server. */
  connection: LightState
  /** Whether the session-sync and plugin-bridge interceptors are active. */
  sync: LightState
}

const CLIENT_FAIL_STATES: ReadonlySet<string> = new Set([
  'unreachable',
  'revoked',
  'incompatible',
  'invalid-url',
  'unexpected',
])

/**
 * The view states that will NOT come back on their own (MS-6): a revoked
 * token, an incompatible interface, an address that no longer parses — each
 * needs the settings page before that server serves again. They turn the
 * overview's connection light red; a merely `unreachable` server is mid-retry
 * and stays amber.
 */
const CLIENT_DEAD_STATES: ReadonlySet<string> = new Set(['revoked', 'incompatible', 'invalid-url'])

/** The overview card's derived counters and lights (MS-6): the 第 3 格
 * 「连接状态」 shows `M / N 台在线` with {@link WizardOverviewSummary.connectionLight}
 * summarizing the pool's health, and the 第 4 格 「已配对服务端」 shows
 * `已配对 N / maxServers 台` with {@link WizardOverviewSummary.serversLight}
 * turning red exactly at the cap. Input is the DERIVED pool list
 * ({@link ClientServerView} — the view vocabulary's state words), in pairing
 * order; order never matters to the counts. */
export interface WizardOverviewSummary {
  totalCount: number
  onlineCount: number
  /** Everything that is neither connected nor revoked (unreachable,
   * unexpected, incompatible, invalid-url, …). */
  offlineCount: number
  revokedCount: number
  maxServers: number
  limitReached: boolean
  connectionLight: LightState
  serversLight: LightState
}

/**
 * Derive the sub-client overview summary off one derived pool list: green
 * only when EVERY paired server is connected; red when any server is in a
 * state that will not recover on its own (revoked / incompatible /
 * invalid-url) or when the pool is FULL — the cap is a servers fact, so a
 * full pool of healthy connections still shows a red servers light while its
 * connection light stays green; amber for the rest (nothing paired yet, or
 * servers the retry ladder is still working on).
 */
export function deriveClientOverviewSummary(
  servers: readonly ClientServerView[],
  maxServers: number = MAX_PAIRED_SERVERS,
): WizardOverviewSummary {
  const totalCount = servers.length
  let onlineCount = 0
  let revokedCount = 0
  let deadCount = 0
  for (const server of servers) {
    if (server.state === 'connected') onlineCount += 1
    if (server.state === 'revoked') revokedCount += 1
    if (CLIENT_DEAD_STATES.has(server.state)) deadCount += 1
  }
  const offlineCount = totalCount - onlineCount - revokedCount
  const limitReached = totalCount >= maxServers
  const connectionLight: LightState = totalCount === 0
    ? 'pending'
    : onlineCount === totalCount
      ? 'pass'
      : deadCount > 0 ? 'fail' : 'pending'
  const serversLight: LightState = limitReached ? 'fail' : totalCount > 0 ? 'pass' : 'pending'
  return { totalCount, onlineCount, offlineCount, revokedCount, maxServers, limitReached, connectionLight, serversLight }
}

/**
 * Derive the three status lights for the desktop sub-client verification
 * step (`role === 'client'`).
 */
export function deriveClientWizardLights(input: {
  tokenConfigured: boolean
  clientState: string | undefined
  interceptInstalled?: boolean | undefined
}): ClientWizardLights {
  const connected = input.clientState === 'connected'
  const failed = input.clientState !== undefined && CLIENT_FAIL_STATES.has(input.clientState)
  return {
    credential: (input.tokenConfigured || connected) ? 'pass' : input.clientState === 'revoked' ? 'fail' : 'pending',
    connection: connected ? 'pass' : failed ? 'fail' : 'pending',
    sync: connected ? (input.interceptInstalled === false ? 'fail' : 'pass') : 'pending',
  }
}

/**
 * The wizard step-3's three lights for ONE selected paired server (MS-8):
 * the credential is green by the row's own existence (the token lives in the
 * pool store, never in the row) and red only when the server refused it
 * (`revoked`); the connection follows the same fail-set the global lights
 * use (an offline server mid-retry is red here too — the step is staring at
 * THAT one server, not the pool); sync is green on a connected row whose
 * interface groups all match, red on a compat mismatch, amber otherwise.
 * `undefined` (nothing paired, or nothing selected yet) keeps all three
 * amber.
 */
export function deriveClientServerLights(server: ClientServerView | undefined): ClientWizardLights {
  if (server === undefined) return { credential: 'pending', connection: 'pending', sync: 'pending' }
  const connected = server.state === 'connected'
  return {
    credential: server.state === 'revoked' ? 'fail' : 'pass',
    connection: connected ? 'pass' : CLIENT_FAIL_STATES.has(server.state) ? 'fail' : 'pending',
    sync: connected ? ((server.compat?.mismatchedGroups.length ?? 0) > 0 ? 'fail' : 'pass') : 'pending',
  }
}

// --- the peer node's pieces (PG-9) -----------------------------------------------

/**
 * One network device's connection path, in the VIEW vocabulary the peer
 * status route answers: the three usable paths (`lan` 局域网直连 / `p2p`
 * 直连 / `relay` 经网关中转), a locally blocked identity (`mismatch` — the
 * device's public key moved under the same node id) and `offline` (not
 * connected right now, or locally ignored).
 */
export type PeerDevicePath = 'lan' | 'p2p' | 'relay' | 'mismatch' | 'offline'

/** One row of the peer status body's `peers` (PG-9). */
export interface PeerDeviceView {
  nodeId: string
  name: string
  mounted: boolean
  path: PeerDevicePath
  /** Round-trip time of the current path in ms; `null` when not connected. */
  rttMs: number | null
}

/**
 * The peer/status body's mount-capacity facts, verbatim from the
 * `derivePeerStatusView` view's PC-11a fields (the wizard and the settings
 * section both hand these over). Any field left out — or `undefined` — means
 * that fact is UNKNOWN downstream; nothing here guesses a default. Two
 * vocabularies that must never be conflated: `maxPeers` is the RAW network
 * device cap INCLUDING this machine, while `maxServers` is this machine's
 * EFFECTIVE remote-mount cap, and `mountedCount` counts this machine's
 * mounted remotes — never the discovered rows (`peers.length`) and never
 * the network's occupied seats.
 */
export interface PeerCapacityFacts {
  /** This machine's effective remote-mount cap (undefined = unknown). */
  maxServers?: number | undefined
  /** This machine's actually mounted remotes (undefined = unknown). */
  mountedCount?: number | undefined
  /** `mountedCount >= maxServers` once BOTH are known; undefined otherwise. */
  limitReached?: boolean | undefined
  /** The network's raw device cap including this node (undefined = unknown). */
  maxPeers?: number | undefined
}

/** The peer node's overview counters and two lights (PG-9): the 第 3 格
 * 「直连 / 中转连接」 summarizes the usable paths, the 第 4 格 「网内设备」
 * shows 本机已挂载 N / M 台远端设备 with {@link PeerOverviewSummary.devicesLight}
 * turning red exactly at the LOCAL mount cap (满额, PC-11a's tri-state) or
 * on a locally blocked identity — amber while the capacity facts are unknown
 * (an old body), never green on a guess. */
export interface PeerOverviewSummary {
  totalCount: number
  /** `lan` + `p2p` — the devices whose sessions flow without the gateway. */
  directCount: number
  /** `relay` — reachable, but every frame rides the gateway. */
  relayCount: number
  /** Locally blocked identities awaiting the 信任新身份 decision. */
  mismatchCount: number
  offlineCount: number
  /** PC-11a: this machine's mounted remotes, verbatim from the body — NOT
   * the discovered count and never derived from the rows here (unknown
   * stays unknown). */
  mountedCount: number | undefined
  /** PC-11a: this machine's effective mount cap (undefined = unknown). */
  maxServers: number | undefined
  /** The network's raw device cap including this node (undefined =
   * unknown). Annotation-only: the mount display never divides by it. */
  maxPeers: number | undefined
  /** PC-11a tri-state: `true` at (or over) the local mount cap — an
   * over-cap stock after a downscale stays `true` with the count shown
   * unclamped — and `undefined` while the cap or the count is unknown
   * (`false` would claim room that may not exist). */
  limitReached: boolean | undefined
  connectionLight: LightState
  devicesLight: LightState
}

/**
 * Derive the peer overview summary off the status route's device rows
 * ({@link PeerDeviceView}) and the body's capacity facts
 * ({@link PeerCapacityFacts}): the connection light is green when every
 * device is on a usable path, red the moment one locally blocked identity
 * waits for a trust decision, amber otherwise (empty network, all offline);
 * the device light follows the LOCAL mount cap — red exactly when
 * `limitReached` is true, amber while it is unknown — and shares the
 * mismatch red. The capacity facts pass through verbatim; when the flag is
 * missing but both counts are known it is re-derived by the PC-11a
 * definition (`mountedCount >= maxServers`), so a caller that carries the
 * raw numbers cannot disagree with the route's own verdict.
 */
export function derivePeerOverviewSummary(
  peers: readonly PeerDeviceView[],
  capacity: PeerCapacityFacts = {},
  options?: { includeSelf?: boolean },
): PeerOverviewSummary {
  let directCount = 0
  let relayCount = 0
  let mismatchCount = 0
  let offlineCount = 0
  for (const peer of peers) {
    if (peer.path === 'lan' || peer.path === 'p2p') directCount += 1
    else if (peer.path === 'relay') relayCount += 1
    else if (peer.path === 'mismatch') mismatchCount += 1
    else offlineCount += 1
  }
  const peerCount = peers.length
  const totalCount = peerCount + (options?.includeSelf ? 1 : 0)
  const usable = directCount + relayCount
  const mountedCount = capacity.mountedCount
  const maxServers = capacity.maxServers
  const limitReached = capacity.limitReached !== undefined
    ? capacity.limitReached
    : mountedCount !== undefined && maxServers !== undefined
      ? mountedCount >= maxServers
      : undefined
  const connectionLight: LightState = mismatchCount > 0
    ? 'fail'
    : peerCount === 0 || usable === 0
      ? 'pending'
      : usable === peerCount ? 'pass' : 'pending'
  const devicesLight: LightState = mismatchCount > 0 || limitReached === true
    ? 'fail'
    : limitReached === false && totalCount > 0 ? 'pass' : 'pending'
  return {
    totalCount,
    directCount,
    relayCount,
    mismatchCount,
    offlineCount,
    mountedCount,
    maxServers,
    maxPeers: capacity.maxPeers,
    limitReached,
    connectionLight,
    devicesLight,
  }
}

/** The third light's copy vocabulary (PC-14a) — exactly the locale keys the
 * derived verdicts may render, kept as a literal union so the component's
 * typed `t` accepts it and a typo fails the build instead of rendering
 * #MISSING. Every key here exists in BOTH dictionaries. */
export type PeerDiscoveryCopyKey =
  | 'wizard.peer.syncReady'
  | 'wizard.peer.syncWaitingPeers'
  | 'wizard.peer.syncIgnored'
  | 'wizard.peer.syncPartialReady'
  | 'wizard.peer.syncBlocked'
  | 'wizard.peer.syncNotMounted'
  | 'wizard.peer.syncNotOnline'
  | 'wizard.peer.syncGatewayHold'
  | 'wizard.peer.syncUnknown'
  | 'wizard.peer.notJoined'

/** The third peer wizard light's verdict (PC-14a): the light word plus the
 * locale key (and its params) the rendered state line reads from — the
 * copy explains WHY the light is what it is, derived once here so the
 * component only renders. */
export interface PeerDiscoveryLightView {
  light: LightState
  copyKey: PeerDiscoveryCopyKey
  copyParams?: Record<string, string>
}

/** The `not-ready` reason word's copy key: the unmounted word is the NEUTRAL
 * one (fix1 — a fresh announcement, a pending punch, a full cap and a failed
 * mount all look identical, so no capacity claim), gateway admission words
 * fold into the network-not-ready copy (the admission light next to this one
 * carries the specific gateway state), an unknown word degrades to unknown. */
function peerNotReadyCopyKey(reason: string): PeerDiscoveryCopyKey {
  switch (reason) {
    case 'peers-not-mounted': return 'wizard.peer.syncNotMounted'
    case 'peers-not-online': return 'wizard.peer.syncNotOnline'
    case 'identity-mismatch': return 'wizard.peer.syncBlocked'
    case 'gateway-connecting':
    case 'gateway-pending-approval':
    case 'gateway-mismatch':
    case 'gateway-paused':
    case 'gateway-revoked':
    case 'gateway-offline':
      return 'wizard.peer.syncGatewayHold'
    default: return 'wizard.peer.syncUnknown'
  }
}

/**
 * The third peer wizard light (设备发现与会话同步) off the body's OWN sync
 * facts (PC-14a): `ready` under an authorized gateway is the ONLY green —
 * never a non-empty peers list, a lan path or a mounted count. `partial` is
 * honestly pending (its KNOWN ready/candidate counts ride the copy; unknown
 * counts never guess 0); a blocked identity — and any locally known
 * mismatch, which is a LOCAL fact that survives even an old body — is red;
 * everything else is amber. An old body without the sync block (or with an
 * unknown state word) reads the explicit UNKNOWN copy: the decided fallback,
 * never "peers non-empty is green". The copy speaks of handshakes completed
 * and syncing MAY START — never that any concrete session data has finished
 * synchronizing.
 */
export function derivePeerDiscoveryLight(input: {
  gatewayState: string
  mismatchCount: number
  sync?: PeerSyncReadinessView | undefined
}): PeerDiscoveryLightView {
  const { sync } = input
  const mismatchBlocked = input.mismatchCount > 0
  // An old body (or junk): the light stays amber with the explicit unknown
  // copy — the ONE locally known fact that still fails is a TOFU mismatch.
  if (sync === undefined || sync.state === undefined) {
    return mismatchBlocked
      ? { light: 'fail', copyKey: 'wizard.peer.syncBlocked' }
      : { light: 'pending', copyKey: 'wizard.peer.syncUnknown' }
  }
  if (sync.state === 'unconfigured') {
    return { light: 'pending', copyKey: 'wizard.peer.notJoined' }
  }
  // The gateway admission fact gates every green: a stale `ready` word under
  // a dead/revoked gateway never passes (no cached-online bypass).
  if (input.gatewayState !== 'authorized') {
    if (mismatchBlocked) return { light: 'fail', copyKey: 'wizard.peer.syncBlocked' }
    return { light: 'pending', copyKey: 'wizard.peer.syncGatewayHold' }
  }
  if (sync.state === 'blocked' || mismatchBlocked) {
    return { light: 'fail', copyKey: 'wizard.peer.syncBlocked' }
  }
  switch (sync.state) {
    case 'ready':
      return { light: 'pass', copyKey: 'wizard.peer.syncReady' }
    case 'waiting-peers':
      return { light: 'pending', copyKey: 'wizard.peer.syncWaitingPeers' }
    case 'ignored':
      return { light: 'pending', copyKey: 'wizard.peer.syncIgnored' }
    case 'partial': {
      const ready = sync.readyCount
      const total = sync.candidateCount
      return ready !== undefined && total !== undefined
        ? { light: 'pending', copyKey: 'wizard.peer.syncPartialReady', copyParams: { ready: String(ready), total: String(total) } }
        : { light: 'pending', copyKey: 'wizard.peer.syncUnknown' }
    }
    case 'not-ready':
      return { light: 'pending', copyKey: peerNotReadyCopyKey(sync.reason ?? '') }
    default:
      return { light: 'pending', copyKey: 'wizard.peer.syncUnknown' }
  }
}

/** The peer node's three wizard lights (PG-9 + PC-14a): ① 本机身份已就绪,
 * ② 网络准入状态 (authorized green, pending-approval amber — the
 * 「等待网络管理员批准」copy), ③ 设备发现与会话同步 — the third light reads
 * the body's sync facts through {@link derivePeerDiscoveryLight}; without
 * them (an old body) it stays pending with the explicit unknown copy. */
export interface PeerWizardLights {
  identity: LightState
  admission: LightState
  discovery: LightState
}

/** The admission verdicts that need the network administrator or a local
 * repair before they come back — red, never amber. */
const PEER_ADMISSION_DEAD_STATES: ReadonlySet<string> = new Set(['mismatch', 'revoked', 'paused'])

/**
 * Derive the peer node's three lights off the peer status facts: identity is
 * green once the engine reports a node id (amber while the engine is not
 * wired); admission maps the gateway state (green `authorized`, amber
 * `pending-approval` / `connecting` / `offline` / unconfigured, red
 * `mismatch` / `revoked` / `paused`); discovery follows the sync facts per
 * {@link derivePeerDiscoveryLight}.
 */
export function derivePeerWizardLights(input: {
  identityReady: boolean
  gatewayState: string
  mismatchCount: number
  sync?: PeerSyncReadinessView | undefined
}): PeerWizardLights {
  const authorized = input.gatewayState === 'authorized'
  const admission: LightState = authorized
    ? 'pass'
    : PEER_ADMISSION_DEAD_STATES.has(input.gatewayState) ? 'fail' : 'pending'
  return {
    identity: input.identityReady ? 'pass' : 'pending',
    admission,
    discovery: derivePeerDiscoveryLight({
      gatewayState: input.gatewayState,
      mismatchCount: input.mismatchCount,
      ...(input.sync !== undefined ? { sync: input.sync } : {}),
    }).light,
  }
}

// --- the advanced split-fill's invite assembler (PC-15) ---------------------------

/**
 * PC-15: assembles a full `zr-net…://` invite from the wizard's advanced
 * split-fill (gateway address + 16-hex network ID + optional passphrase) so
 * the join flow can reuse the EXISTING invite branch unchanged.
 *
 * This module rides in the browser bundle, so it CANNOT import
 * src/peer/crypto.ts (node:crypto). Everything below is a hand mirror of
 * that module's parsing rules — `parseGatewayJoinInput` for the address
 * grammar and scheme handling, `parseInviteAuthority` for host[:port],
 * `isLoopbackOrPrivateHostname` for the private/public inference, and
 * `buildKeylessInviteUri`'s scheme table — with
 * `scripts/check-wizard-ui.mjs` round-tripping positive samples through the
 * REAL parser so the two cannot drift. No cryptography is duplicated: the
 * join key is opaque text, percent-encoded and decoded by the existing
 * parser on the consuming side.
 */
export type PeerAdvancedJoinError = 'bad-adv-gateway' | 'bad-adv-network-id' | 'bad-adv-join-key'

/** Mirror of src/peer/crypto.ts PEER_INVITE_DEFAULT_PORT. */
const PEER_ADV_DEFAULT_PORT = 19393
/** Mirror of src/peer/crypto.ts NETWORK_ID_PATTERN (16 hex, any case). */
const PEER_ADV_NETWORK_ID_PATTERN = /^[0-9a-fA-F]{16}$/
/** Mirror of src/peer/crypto.ts HOSTNAME_PATTERN (IPv6 must be bracketed). */
const PEER_ADV_HOSTNAME_PATTERN = /^[A-Za-z0-9._\-]+$/
/** Mirror of src/peer/crypto.ts BRACKETED_IPV6_PATTERN. */
const PEER_ADV_IPV6_PATTERN = /^\[[0-9A-Fa-f:.]+\]$/
/** Mirror of src/peer/crypto.ts GATEWAY_URL_SCHEME_PATTERN. */
const PEER_ADV_SCHEME_PATTERN = /^(https?|wss?):\/\//i

/** Mirror of src/peer/crypto.ts isLoopbackOrPrivateHostname (the transport
 * inference for a plain `zr-net://` scheme; inference only, never routing). */
function isLoopbackOrPrivatePeerHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4 !== null) {
    const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    const [a, b] = octets
    if (a === undefined || b === undefined) return false
    if (a > 255 || b > 255) return false
    if (a === 127 || a === 10) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (h === '::1') return true
  if (h.startsWith('fc') || h.startsWith('fd')) return true
  if (h.startsWith('fe80')) return true
  return false
}

/** One gateway address's parsed authority — `null` for anything malformed. */
interface PeerAdvGateway {
  rawHost: string
  hostname: string
  port: number
  /** `true`/`false` = the address carried an explicit TLS/plain scheme;
   * `null` = bare host (the assembled plain `zr-net://` infers transport). */
  explicitTls: boolean | null
}

/**
 * Mirror of parseGatewayJoinInput's address half (src/peer/crypto.ts): an
 * optional http/https/ws/wss prefix, then `host[:port]` with the peer rules —
 * bracketed IPv6 accepted, an unbracketed multi-colon address rejected as
 * ambiguous, port 1-65535, an explicit empty port malformed (never guessed),
 * query refused, only an empty trailing `#` or an empty (or `/peer/v1/ws`)
 * path tolerated.
 */
function peerAdvGatewayOf(raw: string): PeerAdvGateway | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  let rest = trimmed
  let explicitTls: boolean | null = null
  // An explicit scheme carries its own default port (https/wss → 443,
  // http/ws → 80); a bare host defaults to the peer port.
  let defaultPort = PEER_ADV_DEFAULT_PORT
  const schemeMatch = PEER_ADV_SCHEME_PATTERN.exec(trimmed)
  if (schemeMatch !== null) {
    const proto = (schemeMatch[1] ?? '').toLowerCase()
    explicitTls = proto === 'https' || proto === 'wss'
    defaultPort = explicitTls ? 443 : 80
    rest = trimmed.slice(schemeMatch[0].length)
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    return null // an unknown scheme (ftp://, malformed zr-net://) — refused
  }
  if (rest.includes('?')) return null
  const hashIdx = rest.indexOf('#')
  if (hashIdx !== -1) {
    if (rest.slice(hashIdx + 1).trim() !== '') return null
    rest = rest.slice(0, hashIdx)
  }
  const slashIdx = rest.indexOf('/')
  const authority = slashIdx === -1 ? rest : rest.slice(0, slashIdx)
  if (slashIdx !== -1) {
    const pathPart = rest.slice(slashIdx + 1).replace(/\/+$/u, '')
    if (pathPart !== '' && pathPart.toLowerCase() !== 'peer/v1/ws') return null
  }
  if (authority === '') return null
  // The authority split — mirror of parseInviteAuthority.
  let rawHost: string
  let portPart: string | undefined
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']')
    if (close === -1) return null
    rawHost = authority.slice(0, close + 1)
    const tail = authority.slice(close + 1)
    if (tail !== '') {
      if (!tail.startsWith(':')) return null
      portPart = tail.slice(1)
    }
    const inner = rawHost.slice(1, -1)
    if (inner.length === 0 || !PEER_ADV_IPV6_PATTERN.test(rawHost)) return null
    const hostname = inner.toLowerCase()
    return { rawHost, hostname, port: peerAdvPortOf(portPart, defaultPort), explicitTls }
  }
  if ((authority.split(':').length - 1) > 1) return null // unbracketed IPv6 — ambiguous
  const colon = authority.indexOf(':')
  if (colon === -1) {
    rawHost = authority
  } else {
    rawHost = authority.slice(0, colon)
    portPart = authority.slice(colon + 1)
  }
  if (rawHost.length === 0 || !PEER_ADV_HOSTNAME_PATTERN.test(rawHost)) return null
  return { rawHost, hostname: rawHost.toLowerCase(), port: peerAdvPortOf(portPart, defaultPort), explicitTls }
}

/** Mirror of parsePortOr: absent → the scheme's default; explicit → 1-65535. */
function peerAdvPortOf(portPart: string | undefined, defaultPort: number): number {
  if (portPart === undefined) return defaultPort
  if (!/^\d+$/.test(portPart)) return -1
  return Number(portPart)
}

/**
 * Assemble the invite. The network ID is normalized to lowercase (the same
 * normalization parseInviteUri applies); the passphrase rides verbatim — no
 * trimming, every typed character is meaningful, and the empty string means
 * NO key (the byte-equivalent of the route's own keyless manual-approval
 * invite). A malformed part is refused locally; the caller never sends it.
 */
export function assemblePeerInviteUri(input: {
  gatewayAddress: string
  networkId: string
  joinKey?: string
}): { ok: true; inviteUri: string } | { ok: false; error: PeerAdvancedJoinError } {
  const gateway = peerAdvGatewayOf(input.gatewayAddress)
  if (gateway === null || gateway.port < 1 || gateway.port > 65535) return { ok: false, error: 'bad-adv-gateway' }
  // PC-15 fix1 R2: a grammar-valid authority is not yet a VALID URL — the
  // characters-only bracket check would accept `[aa]`, and an IPv4 octet
  // over 255 passes the digit shape. One standard-URL construction (pure,
  // no network) is the gate: whatever fails `new URL` here would fail the
  // same way as the engine's ws URL / the manual-approval http origin, so a
  // refused address can never become an unusable dial target. The handwritten
  // parser above stays exactly as mirrored — this only ADDS the standard
  // semantics, never loosens them.
  try {
    // eslint-disable-next-line no-new -- the throw IS the check
    new URL(`http://${gateway.rawHost}:${gateway.port}/`)
  } catch {
    return { ok: false, error: 'bad-adv-gateway' }
  }
  const networkId = input.networkId.trim().toLowerCase()
  if (!PEER_ADV_NETWORK_ID_PATTERN.test(networkId)) return { ok: false, error: 'bad-adv-network-id' }
  // The scheme table (mirror of buildKeylessInviteUri + an explicit scheme's
  // carry): explicit TLS forces zr-nets; explicit plain keeps the peer rule's
  // public plaintext via zr-net+insecure; bare host stays plain zr-net and
  // lets the parser infer the transport from the host.
  const scheme = gateway.explicitTls === true
    ? 'zr-nets'
    : gateway.explicitTls === false
      ? (isLoopbackOrPrivatePeerHost(gateway.hostname) ? 'zr-net' : 'zr-net+insecure')
      : 'zr-net'
  const key = input.joinKey ?? ''
  // PC-15 fix1 R3: encodeURIComponent throws URIError on a lone UTF-16
  // surrogate — DOMString does NOT prevent one from reaching this point.
  // Answer a LOCAL refusal (the component shows its copy, the request never
  // starts) instead of an unhandled rejection; the key is never rewritten
  // (a partial or replaced encoding would silently corrupt the secret) and
  // never echoed into the error.
  let fragment: string
  try {
    fragment = key === '' ? '' : `#${encodeURIComponent(key)}`
  } catch {
    return { ok: false, error: 'bad-adv-join-key' }
  }
  return { ok: true, inviteUri: `${scheme}://${gateway.rawHost}:${gateway.port}/${networkId}${fragment}` }
}

/** Pairing-code countdown, whole seconds, never negative. */
export function pairingSecondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

/**
 * The managed-Caddy start-failure copy: maps the wire error code to a
 * locale key (+params / manual-install link). Pure — the check script pins
 * every mapping.
 */
export function caddyFailureCopy(
  error: string,
  detail?: string,
  installUrl?: string,
): { key: string; params: Record<string, string>; installUrl?: string } {
  switch (error) {
    case 'missing-token':
      return { key: 'wizard.caddy.failMissingToken', params: {} }
    case 'already-running':
      return { key: 'wizard.caddy.failAlreadyRunning', params: {} }
    case 'bad-config':
      return { key: 'wizard.caddy.failBadConfig', params: { detail: detail ?? '' } }
    case 'download-failed':
      return { key: 'wizard.caddy.failDownload', params: {}, ...(installUrl !== undefined ? { installUrl } : {}) }
    case 'validate-failed':
      return { key: 'wizard.caddy.failValidate', params: {} }
    default:
      return { key: 'wizard.caddy.failSpawn', params: {} }
  }
}

// --- the reverse-proxy snippet templates (mirror of proxy-snippets.ts) -----------

export interface SnippetInput {
  domain: string
  upstreamHost: string
  upstreamPort: number
  lang?: 'zh' | 'en' | undefined
}

/** Same grammar the row layer and the host half enforce. */
function valid(input: SnippetInput): { domain: string; upstream: string; port: number } | null {
  if (!isValidHostname(input.domain)) return null
  if (!isValidHostname(input.upstreamHost)) return null
  if (!Number.isInteger(input.upstreamPort) || input.upstreamPort < 1 || input.upstreamPort > 65535) return null
  return { domain: input.domain, upstream: input.upstreamHost, port: input.upstreamPort }
}

export function nginxSnippetText(input: SnippetInput): string | null {
  const parts = valid(input)
  if (parts === null) return null
  const headerComment = input.lang === 'en'
    ? '# Place this in the http {} block (skip if you already have this map)'
    : '# 这段放在 http {} 层（若已有同名 map 则跳过）'
  return [
    headerComment,
    'map $http_upgrade $connection_upgrade {',
    '    default upgrade;',
    "    ''      close;",
    '}',
    '',
    'server {',
    '    listen 443 ssl;',
    `    server_name ${parts.domain};`,
    '',
    '    location / {',
    `        proxy_pass http://${parts.upstream}:${parts.port};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Upgrade $http_upgrade;',
    '        proxy_set_header Connection $connection_upgrade;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '        proxy_buffering off;',
    '        client_max_body_size 512m;',
    '        proxy_read_timeout 3600s;',
    '        proxy_send_timeout 3600s;',
    '    }',
    '}',
    '',
  ].join('\n')
}

export function caddySnippetText(input: SnippetInput): string | null {
  const parts = valid(input)
  if (parts === null) return null
  return `${parts.domain} {\n    reverse_proxy ${parts.upstream}:${parts.port}\n}\n`
}

/** The Lucky steps (mirror of proxy-snippets.ts luckySteps). */
export function luckyStepTexts(input: SnippetInput): string[] | null {
  const parts = valid(input)
  if (parts === null) return null
  if (input.lang === 'en') {
    return [
      'In Lucky "Web Service", create a new rule listening on port 443 and bind your domain.',
      `Set the backend (reverse proxy target) to http://${parts.upstream}:${parts.port} and enable WebSocket support.`,
      'Turn on the catch-all switch to allow all paths, then save.',
    ]
  }
  return [
    '在 Lucky 的「Web 服务」里新建一条规则，监听 443 端口，绑定你的域名。',
    `后端（反代目标）填 http://${parts.upstream}:${parts.port}，开启 WebSocket 支持。`,
    '打开「万事大吉」开关（放行全部路径），保存即可生效。',
  ]
}

/** The snippet kinds the reverse-proxy card tabs over, in tab order. */
export const SNIPPET_KINDS = ['nginx', 'caddy', 'lucky'] as const
export type SnippetKind = (typeof SNIPPET_KINDS)[number]
