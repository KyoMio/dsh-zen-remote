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
import type { ClientServerView } from './settings-form.ts'

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

/** The peer node's overview counters and two lights (PG-9): the 第 3 格
 * 「直连 / 中转连接」 summarizes the usable paths, the 第 4 格 「网内设备」
 * counts `N / M 台` with {@link PeerOverviewSummary.devicesLight} turning
 * red exactly at the cap (满额) or on a locally blocked identity. */
export interface PeerOverviewSummary {
  totalCount: number
  /** `lan` + `p2p` — the devices whose sessions flow without the gateway. */
  directCount: number
  /** `relay` — reachable, but every frame rides the gateway. */
  relayCount: number
  /** Locally blocked identities awaiting the 信任新身份 decision. */
  mismatchCount: number
  offlineCount: number
  /** Devices whose shared sessions are currently mounted. */
  mountedCount: number
  maxPeers: number
  limitReached: boolean
  connectionLight: LightState
  devicesLight: LightState
}

/**
 * Derive the peer overview summary off the status route's device rows
 * ({@link PeerDeviceView}): the connection light is green when every device
 * is on a usable path, red the moment one locally blocked identity waits
 * for a trust decision, amber otherwise (empty network, all offline); the
 * device light follows the cap — red exactly at `totalCount >= maxPeers`
 * — and shares the mismatch red. Both stay amber on an empty network.
 */
export function derivePeerOverviewSummary(
  peers: readonly PeerDeviceView[],
  maxPeers: number,
): PeerOverviewSummary {
  let directCount = 0
  let relayCount = 0
  let mismatchCount = 0
  let offlineCount = 0
  let mountedCount = 0
  for (const peer of peers) {
    if (peer.path === 'lan' || peer.path === 'p2p') directCount += 1
    else if (peer.path === 'relay') relayCount += 1
    else if (peer.path === 'mismatch') mismatchCount += 1
    else offlineCount += 1
    if (peer.mounted) mountedCount += 1
  }
  const totalCount = peers.length
  const usable = directCount + relayCount
  const limitReached = totalCount >= maxPeers
  const connectionLight: LightState = mismatchCount > 0
    ? 'fail'
    : totalCount === 0 || usable === 0
      ? 'pending'
      : usable === totalCount ? 'pass' : 'pending'
  const devicesLight: LightState = totalCount === 0
    ? 'pending'
    : limitReached || mismatchCount > 0 ? 'fail' : 'pass'
  return {
    totalCount,
    directCount,
    relayCount,
    mismatchCount,
    offlineCount,
    mountedCount,
    maxPeers,
    limitReached,
    connectionLight,
    devicesLight,
  }
}

/** The peer node's three wizard lights (PG-9): ① 本机身份已就绪, ② 网络准入
 * 状态 (authorized green, pending-approval amber — the 「等待网络管理员批准」
 * copy), ③ 设备发现与会话同步. */
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
 * `mismatch` / `revoked` / `paused`); discovery is green once devices ride
 * the network, red when a local TOFU mismatch blocks one of them, amber on
 * an empty or not-yet-authorized network.
 */
export function derivePeerWizardLights(input: {
  identityReady: boolean
  gatewayState: string
  peerCount: number
  mismatchCount: number
}): PeerWizardLights {
  const authorized = input.gatewayState === 'authorized'
  const admission: LightState = authorized
    ? 'pass'
    : PEER_ADMISSION_DEAD_STATES.has(input.gatewayState) ? 'fail' : 'pending'
  const discovery: LightState = !authorized
    ? 'pending'
    : input.mismatchCount > 0 ? 'fail' : input.peerCount > 0 ? 'pass' : 'pending'
  return {
    identity: input.identityReady ? 'pass' : 'pending',
    admission,
    discovery,
  }
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
