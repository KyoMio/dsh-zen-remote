/**
 * GatewayWizard (GW-10): the unified three-step remote-access & device-pairing
 * guide at the top of the plugin detail page (`plugins.bundle.config`,
 * `key: 'dsh-zen-remote'`).
 *
 * Covers both deployment roles in one entry point:
 * - Server (`host`): choose the ingress method (Caddy / Reverse Proxy /
 *   Cloudflare Tunnel / LAN & Tailscale), configure parameters + server
 *   display name & auto-share, verify connectivity, and pair either a
 *   Phone/Browser (QR code) or another Desktop DSH Client (8-character
 *   desktop pairing code + live paired-client list).
 * - Desktop Client (`client`): enter the server gateway URL + 8-character
 *   desktop pairing code to claim a device token, and verify live
 *   connection & session-sync status.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AdminStatusBody,
  ClaimRouteBody,
  ClientConnectionView,
  ClientServerView,
  ClientStatusBody,
  SettingsDeviceView,
  ZenRemoteSettingsForm,
} from '../../client-data/settings-form.ts'
import {
  ADMIN_ACTION_ROUTE,
  ADMIN_PAIR_ROUTE,
  ADMIN_STATUS_ROUTE,
  CLIENT_CLAIM_ROUTE,
  CLIENT_CONFIG_ROUTE,
  CLIENT_PEER_JOIN_ROUTE,
  CLIENT_PEER_LEAVE_ROUTE,
  CLIENT_PEER_REPROBE_ROUTE,
  CLIENT_PEER_STATUS_ROUTE,
  CLIENT_PEER_TOGGLE_MOUNT_ROUTE,
  CLIENT_PEER_TRUST_ROUTE,
  CLIENT_RECONNECT_ROUTE,
  CLIENT_STATUS_ROUTE,
  CLIENT_UNPAIR_ROUTE,
  awaitClientStatusReady,
  canSubmitClientPairing,
  claimDeviceNameOf,
  deriveClientStatusView,
  derivePeerStatusView,
  deriveSettingsView,
  normalizePairingCode,
  shouldReloadAfterClientActivation,
  type PeerStatusView,
} from '../../client-data/settings-form.ts'
import { qrMatrix } from '../../client-data/qr.ts'
import {
  WIZARD_CADDY_START_ROUTE,
  WIZARD_CADDY_STATUS_ROUTE,
  WIZARD_CADDY_STOP_ROUTE,
  WIZARD_CF_TOKEN_ROUTE,
  WIZARD_STATUS_ROUTE,
  WIZARD_TUNNEL_CHECK_ROUTE,
  WIZARD_TUNNEL_SETUP_ROUTE,
  WIZARD_TUNNEL_STATUS_ROUTE,
  WIZARD_TUNNEL_STOP_ROUTE,
  WIZARD_VERIFY_ROUTE,
  caddyFailureCopy,
  configureReadiness,
  deriveClientOverviewSummary,
  deriveClientServerLights,
  deriveClientWizardLights,
  derivePeerOverviewSummary,
  derivePeerWizardLights,
  deriveWizardLights,
  formSeedOf,
  initialStep,
  isValidPort,
  isWizardConfigured,
  pairingSecondsLeft,
  stepAfterPick,
  targetHostSaveRole,
  tunnelCheckCopy,
  tunnelFailureCopy,
  upstreamPortOf,
  type CaddyState,
  type PeerDeviceView,
  type TunnelCheckWire,
  type TunnelSetupWire,
  type LightState,
  type WizardPath,
  type WizardRole,
  type WizardStatusBody,
  type WizardStep,
  type WizardVerifyPoll,
  type WizardVerifyStart,
} from '../../client-data/wizard.ts'
import { NS } from '../locales.ts'
import { copyTextToClipboard } from '../clipboard.ts'
import { MigrateCard } from './cards/MigrateCard.tsx'
import { PortForwardCard } from './cards/PortForwardCard.tsx'
import { ProxyCard } from './cards/ProxyCard.tsx'
import { TokenCard } from './cards/TokenCard.tsx'

export interface GatewayWizardProps extends PropsRuntime<'plugins.bundle.config'>, PropsLocale<typeof NS> {
  /** The row's staged-form controller — saved-role source of truth. */
  config: ZenRemoteSettingsForm
  /** One atomic row write (the wiring stages through configForms.mutate). */
  saveRowFields: (fields: Record<string, unknown>, options?: { unset?: readonly string[] }) => Promise<void>
}

type StartFailureKey = 'wizard.startFailedProbe' | 'wizard.startFailedRuntime' | 'wizard.startFailedGateway' | 'wizard.startFailedPair' | 'wizard.startFailedUrl'

/** The start failure's locale key + params, from the wire reason. */
function startFailureCopy(result: Extract<WizardVerifyStart, { ok: false }>): { key: StartFailureKey; params: Record<string, string> } {
  switch (result.reason) {
    case 'bad-public-url':
    case 'no-public-url':
      return { key: 'wizard.startFailedUrl', params: {} }
    case 'runtime-not-ready':
      return { key: 'wizard.startFailedRuntime', params: {} }
    case 'gateway-unreachable':
      return { key: 'wizard.startFailedGateway', params: {} }
    case 'pair-refused':
      return { key: 'wizard.startFailedPair', params: { detail: String(result.detail ?? '') } }
    case 'probe-failed': {
      const detail = result.detail as { kind?: string; root?: string; admin?: string; reason?: string } | undefined
      const shape = detail === undefined || detail.kind !== 'reached'
        ? String(detail?.reason ?? 'network')
        : `root=${detail.root} admin=${detail.admin}`
      return { key: 'wizard.startFailedProbe', params: { detail: shape } }
    }
  }
}

/** The QR code's SVG path: one rect per dark module, pixel-crisp. */
function qrSvgPath(matrix: boolean[][], scale: number): string {
  let path = ''
  matrix.forEach((cells, row) => {
    cells.forEach((dark, col) => {
      if (dark) path += `M${col * scale} ${row * scale}h${scale}v${scale}h-${scale}z`
    })
  })
  return path
}

const LIGHT_ORDER: readonly { key: 'wizard.verify.gateway' | 'wizard.verify.public' | 'wizard.verify.pairing'; light: keyof ReturnType<typeof deriveWizardLights> }[] = [
  { key: 'wizard.verify.gateway', light: 'gateway' },
  { key: 'wizard.verify.public', light: 'publicUrl' },
  { key: 'wizard.verify.pairing', light: 'pairing' },
]

const CLIENT_LIGHT_ORDER: readonly { key: 'wizard.client.lightCredential' | 'wizard.client.lightConnection' | 'wizard.client.lightSync'; light: keyof ReturnType<typeof deriveClientWizardLights> }[] = [
  { key: 'wizard.client.lightCredential', light: 'credential' },
  { key: 'wizard.client.lightConnection', light: 'connection' },
  { key: 'wizard.client.lightSync', light: 'sync' },
]

const LIGHT_LABEL: Record<LightState, 'wizard.light.pass' | 'wizard.light.pending' | 'wizard.light.fail'> = {
  pass: 'wizard.light.pass',
  pending: 'wizard.light.pending',
  fail: 'wizard.light.fail',
}

const STEP_ORDER: readonly WizardStep[] = ['pick', 'configure', 'verify']

const ROLE_OPTIONS = [
  ['host', 'wizard.role.host', 'wizard.role.hostDesc'],
  ['client', 'wizard.role.client', 'wizard.role.clientDesc'],
  ['peer', 'wizard.role.peer', 'wizard.role.peerDesc'],
] as const

/** The peer node's three verification lights, in display order (PG-9). */
const PEER_LIGHT_ORDER: readonly { key: 'wizard.peer.lightIdentity' | 'wizard.peer.lightAdmission' | 'wizard.peer.lightDiscovery'; light: 'identity' | 'admission' | 'discovery' }[] = [
  { key: 'wizard.peer.lightIdentity', light: 'identity' },
  { key: 'wizard.peer.lightAdmission', light: 'admission' },
  { key: 'wizard.peer.lightDiscovery', light: 'discovery' },
]

/** One network device's dot + path copy + tone (PG-9): `pass` on the usable
 * paths, `fail` on a locally blocked identity, `pending` while offline. */
function peerDeviceDot(path: PeerDeviceView['path']): 'pass' | 'pending' | 'fail' {
  if (path === 'lan' || path === 'p2p' || path === 'relay') return 'pass'
  return path === 'mismatch' ? 'fail' : 'pending'
}

function peerDevicePathCopy(path: PeerDeviceView['path'], t: GatewayWizardProps['t']): string {
  switch (path) {
    case 'lan': return t('wizard.peer.devicePathLan')
    case 'p2p': return t('wizard.peer.devicePathP2p')
    case 'relay': return t('wizard.peer.devicePathRelay')
    case 'mismatch': return t('wizard.peer.devicePathMismatch')
    default: return t('wizard.peer.devicePathOffline')
  }
}

/** The gateway admission state's one-line copy on the peer surfaces (PG-9). */
function peerStateCopy(state: string, t: GatewayWizardProps['t']): string {
  switch (state) {
    case 'authorized': return t('wizard.light.pass')
    case 'pending-approval': return t('wizard.peer.pendingApproval')
    case 'connecting': return t('wizard.peer.connecting')
    case 'offline': return t('wizard.peer.offline')
    case 'mismatch': return t('wizard.peer.mismatch')
    case 'paused':
    case 'revoked': return t('wizard.peer.revoked')
    default: return t('wizard.peer.notJoined')
  }
}

/** The join route's failure copy: the route's own codes plus a generic
 * fallback. `invalid-invite` gets the paste-format copy. */
function peerJoinFailCopy(code: string, t: GatewayWizardProps['t']): string {
  switch (code) {
    case 'invalid-invite': return t('wizard.peer.joinInvalid')
    case 'invalid-gateway': return t('wizard.peer.joinGatewayInvalid')
    case 'gateway-unreachable': return t('wizard.peer.joinGatewayUnreachable')
    case 'no-network': return t('wizard.peer.joinNoNetwork')
    case 'manual-disabled': return t('wizard.peer.joinManualDisabled')
    case 'select-network': return t('wizard.peer.selectNetworkHint')
    default: return t('wizard.peer.joinFailed', { reason: code })
  }
}

const PATH_OPTIONS = [
  ['caddy', 'wizard.path.caddy', 'wizard.path.caddyDesc'],
  ['external', 'wizard.path.external', 'wizard.path.externalDesc'],
  ['cloudflared', 'wizard.path.cloudflared', 'wizard.path.cloudflaredDesc'],
  ['lan', 'wizard.path.lan', 'wizard.path.lanDesc'],
] as const

function claimFailCopy(code: string, retryAfterMs: number | undefined, t: GatewayWizardProps['t']): string {
  switch (code) {
    case 'invalid': return t('settings.client.failInvalid')
    case 'insecure-http': return t('settings.client.failInsecureHttp')
    case 'bad-code': return t('settings.client.failBadCode')
    case 'locked': {
      const minutes = Math.max(1, Math.ceil((retryAfterMs ?? 0) / 60000))
      return t('settings.client.failLocked', { minutes })
    }
    case 'unreachable': return t('settings.client.failUnreachable')
    case 'role-mismatch': return t('settings.client.failRoleMismatch')
    case 'limit-reached': return t('settings.client.failLimitReached')
    default: return t('settings.client.failUnexpected')
  }
}

/** The verdicts that will not recover on their own (MS-8): a pool row's dot
 * turns red on these, amber on everything else, green only when connected. */
const SERVER_DEAD_STATES: ReadonlySet<ClientServerView['state']> = new Set(['revoked', 'incompatible', 'invalid-url'])

/** One paired server's dot state in the management surfaces (MS-8). */
function serverDotState(state: ClientServerView['state']): 'pass' | 'pending' | 'fail' {
  if (state === 'connected') return 'pass'
  return SERVER_DEAD_STATES.has(state) ? 'fail' : 'pending'
}

/**
 * One paired server's badge copy + tone (MS-8): the settings page's
 * per-server wording on the same keys, so the wizard's management modal and
 * the settings block cannot drift apart in what a state is CALLED.
 */
function serverBadgeCopy(server: ClientServerView, now: number, t: GatewayWizardProps['t']): { text: string; tone: 'live' | 'warn' | 'invalid' | undefined } {
  switch (server.state) {
    case 'connected': return { text: t('settings.client.serverStateConnected'), tone: 'live' }
    case 'unreachable':
    case 'unexpected': {
      if (server.nextRetryAt === undefined) return { text: t('settings.client.serverStateOffline'), tone: 'warn' }
      const seconds = Math.max(0, Math.ceil((server.nextRetryAt - now) / 1000))
      return {
        text: seconds > 0 ? t('settings.client.serverStateRetry', { seconds }) : t('settings.client.serverStateRetrySoon'),
        tone: 'warn',
      }
    }
    case 'revoked': return { text: t('settings.client.serverStateRevoked'), tone: 'invalid' }
    case 'incompatible': return { text: t('settings.client.serverStateIncompatible'), tone: 'invalid' }
    case 'invalid-url': return { text: t('settings.client.serverStateInvalidUrl'), tone: 'invalid' }
    default: return { text: t('settings.client.serverStateUnpaired'), tone: undefined }
  }
}

export function GatewayWizard(props: GatewayWizardProps): ReactNode {
  const { t, config } = props

  const [modalOpen, setModalOpen] = useState(false)
  const [devicesModalOpen, setDevicesModalOpen] = useState(false)
  const [step, setStep] = useState<WizardStep>('pick')
  const [wizardRole, setWizardRole] = useState<WizardRole>('host')
  const [path, setPath] = useState<WizardPath>('caddy')
  const [domain, setDomain] = useState('')
  const [httpsPort, setHttpsPort] = useState('443')
  const [cfToken, setCfToken] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [hostName, setHostName] = useState('')
  const [autoShare, setAutoShare] = useState(true)
  const [formError, setFormError] = useState<string | null>(null)
  const [savingConfig, setSavingConfig] = useState(false)
  const [hostSavedInSession, setHostSavedInSession] = useState(false)
  const [wizardStatus, setWizardStatus] = useState<WizardStatusBody | undefined>()
  const [gatewayReachable, setGatewayReachable] = useState(false)
  const [viaGateway, setViaGateway] = useState(false) // default local; server wall is the real gate
  const [statusLoaded, setStatusLoaded] = useState(false)
  const [allDevices, setAllDevices] = useState<readonly SettingsDeviceView[]>([])
  const [deviceBusy, setDeviceBusy] = useState(false)
  const [deviceError, setDeviceError] = useState(false)
  const [renamingDevice, setRenamingDevice] = useState<{ id: string; draft: string } | null>(null)
  const [pairTarget, setPairTarget] = useState<'web' | 'desktop-client'>('web')
  const [desktopPairing, setDesktopPairing] = useState<{ code: string; expiresAt: number } | undefined>()
  const [desktopPairBusy, setDesktopPairBusy] = useState(false)
  const [desktopCopied, setDesktopCopied] = useState(false)
  const [startResult, setStartResult] = useState<WizardVerifyStart | undefined>()
  const [probingUrl, setProbingUrl] = useState(false)
  const [webPairRequested, setWebPairRequested] = useState(false)
  const [poll, setPoll] = useState<WizardVerifyPoll | undefined>()
  const [notWired, setNotWired] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [card, setCard] = useState<'proxy' | 'token' | 'migrate' | 'portforward' | undefined>()
  const [tokenNotice, setTokenNotice] = useState<'saved' | 'failed' | undefined>()
  const [caddyState, setCaddyState] = useState<CaddyState | undefined>()
  const [caddyBusy, setCaddyBusy] = useState(false)
  const [caddyStartError, setCaddyStartError] = useState<ReturnType<typeof caddyFailureCopy> | undefined>()
  const [tunnelState, setTunnelState] = useState<CaddyState | undefined>()
  const [tunnelBusy, setTunnelBusy] = useState(false)
  const [tunnelResult, setTunnelResult] = useState<TunnelSetupWire | undefined>()
  const [tunnelCheck, setTunnelCheck] = useState<TunnelCheckWire | undefined>()
  const [adoptTunnelId, setAdoptTunnelId] = useState<string | undefined>()
  // PG-9: the probe keeps the client-config route's whole role answer — a
  // peer row needs it as much as a client row does.
  const [probedRole, setProbedRole] = useState<'host' | 'client' | 'peer' | null>(null)
  // PG-9: the peer node's status view (client/peer/status), its polling and
  // the join / manage surfaces' busy & failure markers.
  const [peerView, setPeerView] = useState<PeerStatusView | undefined>()
  const [peerLoading, setPeerLoading] = useState(false)
  const [peerJoinMode, setPeerJoinMode] = useState<'invite' | 'gateway'>('invite')
  const [peerInvite, setPeerInvite] = useState('')
  const [peerGatewayUrl, setPeerGatewayUrl] = useState('')
  const [peerCandidateNetworks, setPeerCandidateNetworks] = useState<readonly { id: string; name: string }[]>([])
  const [peerSelectedNetId, setPeerSelectedNetId] = useState('')
  const [peerBusy, setPeerBusy] = useState(false)
  const [peerFail, setPeerFail] = useState<string | null>(null)
  const [peerNotice, setPeerNotice] = useState<'trustOk' | undefined>()
  const [peerBusyNode, setPeerBusyNode] = useState<string | null>(null)
  const [peerActionFailed, setPeerActionFailed] = useState(false)
  const [peerDevicesModalOpen, setPeerDevicesModalOpen] = useState(false)
  // PG-9-fix: the role-keep flag. The phone-PWA flows run under
  // wizardRole 'host' — when the user entered them from a PEER surface the
  // channel saves must write `role: 'peer'` (targetHostSaveRole), or the
  // machine leaves its virtual network. A deliberate pick of host on the
  // role cards clears it.
  const [keepPeerRole, setKeepPeerRole] = useState(false)

  const selectPath = useCallback((nextPath: WizardPath): void => {
    setFormError(null)
    setPath((prev) => {
      if (prev !== nextPath) {
        setCaddyStartError(undefined)
        setTunnelResult(undefined)
        setTunnelCheck(undefined)
        setAdoptTunnelId(undefined)
        setStartResult(undefined)
        setPoll(undefined)
        setWebPairRequested(false)
      }
      return nextPath
    })
  }, [])

  const webDeviceCount = useMemo(() => allDevices.filter((d) => d.role === 'web').length, [allDevices])
  const desktopDevices = useMemo(() => allDevices.filter((d) => d.role === 'desktop-client'), [allDevices])

  // Client-mode states
  const [clientDeviceName, setClientDeviceName] = useState('')
  const [clientServerUrl, setClientServerUrl] = useState('')
  const [clientPairCode, setClientPairCode] = useState('')
  const [clientClaimBusy, setClientClaimBusy] = useState(false)
  const [clientClaimFail, setClientClaimFail] = useState<{ code: string; retryAfterMs?: number } | null>(null)
  const [clientView, setClientView] = useState<ClientConnectionView | undefined>()
  const [clientLoading, setClientLoading] = useState(false)
  const [clientUnpairBusy, setClientUnpairBusy] = useState(false)
  // MS-8: the paired-server pool's management surfaces — the 已配对服务端
  // 管理弹窗, the entry the wizard's step 3 is staring at, and the per-entry
  // action busy/failed markers both the modal and step 3 share.
  const [serversModalOpen, setServersModalOpen] = useState(false)
  const [activeClientEntryId, setActiveClientEntryId] = useState<string | undefined>()
  const [serverBusyEntry, setServerBusyEntry] = useState<string | null>(null)
  const [serverActionFailed, setServerActionFailed] = useState(false)

  // The saved role, live.
  const roleSnapshot = useSyncExternalStore(
    useCallback((cb: () => void) => config.subscribe(cb), [config]),
    () => config.getSnapshot(),
  )
  const savedClient = config.savedRoleIsClient()
  const savedPeer = config.savedRoleIsPeer()
  const effectiveClient = savedClient || (probedRole === 'client' && !config.rowRoleKnown())
  const effectivePeer = savedPeer || (probedRole === 'peer' && !config.rowRoleKnown())

  // When the row document carries no role at all, probe the lightweight
  // client-config route (every role registers it).
  useEffect(() => {
    if (config.rowRoleKnown()) return
    let cancelled = false
    fetch(CLIENT_CONFIG_ROUTE)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: { role?: unknown } | undefined) => {
        if (cancelled) return
        setProbedRole(body?.role === 'client' ? 'client' : body?.role === 'peer' ? 'peer' : 'host')
      })
      .catch(() => {
        if (!cancelled) setProbedRole('host')
      })
    return () => { cancelled = true }
  }, [config, roleSnapshot])

  // Seed role & row-stored fields once when the form snapshot settles.
  const rowSeededRef = useRef(false)
  useEffect(() => {
    if (rowSeededRef.current || roleSnapshot.scopeStatus === 'loading') return
    if (!config.rowRoleKnown() && probedRole === null) return
    rowSeededRef.current = true
    const rowName = typeof config.rowValue('serverName') === 'string' ? (config.rowValue('serverName') as string) : ''
    const rowAutoShare = config.rowValue('autoShareNewSessions')
    const rowClientUrl = typeof config.rowValue('serverUrl') === 'string' ? (config.rowValue('serverUrl') as string) : ''
    if (rowName !== '') {
      setHostName(rowName)
      setClientDeviceName(rowName)
    }
    if (typeof rowAutoShare === 'boolean') setAutoShare(rowAutoShare)
    if (rowClientUrl !== '') setClientServerUrl(rowClientUrl)
    if (effectiveClient) {
      setWizardRole('client')
      setStep(roleSnapshot.deviceToken.configured || rowClientUrl !== '' ? 'verify' : 'configure')
    } else if (effectivePeer) {
      // PG-9: the peer overview is resident (not gated on `configured`), so
      // the wizard itself stays at pick — the user opens it to paste an
      // invite or to leave the network.
      setWizardRole('peer')
    } else {
      setWizardRole('host')
    }
  }, [roleSnapshot, probedRole, effectiveClient, effectivePeer, config])

  const loadClientStatus = useCallback(async (): Promise<void> => {
    setClientLoading(true)
    try {
      const response = await fetch(CLIENT_STATUS_ROUTE)
      if (response.ok) {
        const body = (await response.json()) as ClientStatusBody
        setClientView(deriveClientStatusView(body))
      }
    } catch {
      // keep last client view
    } finally {
      setClientLoading(false)
    }
  }, [])

  // PG-9: the peer node's status poll — same shape as the client's, against
  // the peer status route. A non-peer row answers 503; the view then stays
  // undefined and the overview renders the not-joined copy.
  const loadPeerStatus = useCallback(async (): Promise<void> => {
    setPeerLoading(true)
    try {
      const response = await fetch(CLIENT_PEER_STATUS_ROUTE)
      if (response.ok) {
        setPeerView(derivePeerStatusView(await response.json()))
      }
    } catch {
      // keep last peer view
    } finally {
      setPeerLoading(false)
    }
  }, [])

  // PG-9: paste-invite OR gateway-address manual-approval join. Switching a
  // host row into peer mode reloads the plugin first, then the invite or
  // gatewayUrl travels to the peer join route.
  const runPeerJoin = async (): Promise<void> => {
    setFormError(null)
    setPeerFail(null)
    const rawInput = (peerJoinMode === 'gateway' ? peerGatewayUrl : peerInvite).trim()
    if (rawInput === '') {
      setPeerFail(peerJoinMode === 'gateway' ? 'invalid-gateway' : 'invalid-invite')
      return
    }
    setPeerBusy(true)
    const wasEffectivePeer = effectivePeer
    const trimmedName = hostName.trim()
    const currentRowName = typeof config.rowValue('serverName') === 'string' ? (config.rowValue('serverName') as string).trim() : ''
    try {
      if (!wasEffectivePeer) {
        try {
          await props.saveRowFields({
            role: 'peer',
            ...(trimmedName !== '' ? { serverName: trimmedName } : {}),
          })
          // PG-9-fix: poll the peer status route until the reloaded row
          // serves it (the route answers 404/503 while the row restarts) —
          // a fixed wait either sends the join too early (503
          // peer-unavailable) or stalls the fast path.
          for (let i = 0; i < 10; i++) {
            await new Promise((resolve) => setTimeout(resolve, 350))
            try {
              const probe = await fetch(CLIENT_PEER_STATUS_ROUTE)
              if (probe.ok) break
            } catch { /* keep waiting for the reload */ }
          }
        } catch {
          // proceed to the join attempt; the route exists on every
          // connects-role composition
        }
      } else if (trimmedName !== '' && trimmedName !== currentRowName) {
        try {
          await props.saveRowFields({ serverName: trimmedName })
        } catch {
          // non-fatal; join still proceeds with current node name
        }
      }
      const payload = peerJoinMode === 'gateway'
        ? { gatewayUrl: rawInput, ...(peerSelectedNetId !== '' ? { networkId: peerSelectedNetId } : {}) }
        : { inviteUri: rawInput }
      const response = await fetch(CLIENT_PEER_JOIN_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        error?: { code?: string }
        networks?: Array<{ id: string; name: string }>
      }
      if (response.ok && body.ok === true) {
        if (!wasEffectivePeer) {
          // First peer activation: the row just reloaded under the page, and
          // its resident global streams opened unwrapped — the same UX-1
          // reload the client pairing applies (peer installs the intercept
          // half too).
          await awaitClientStatusReady()
          window.location.reload()
          return
        }
        setPeerInvite('')
        setPeerCandidateNetworks([])
        setPeerSelectedNetId('')
        await loadPeerStatus()
        setStep('verify')
      } else if (body?.error?.code === 'select-network' && Array.isArray(body.networks) && body.networks.length > 0) {
        if (peerJoinMode !== 'gateway') {
          setPeerJoinMode('gateway')
          setPeerGatewayUrl(rawInput)
        }
        setPeerCandidateNetworks(body.networks)
        setPeerSelectedNetId(body.networks[0]?.id ?? '')
        setPeerFail(null)
      } else {
        const errCode = body?.error?.code ?? 'unexpected'
        setPeerFail(errCode === 'invalid-invite' && peerJoinMode === 'gateway' ? 'invalid-gateway' : errCode)
      }
    } catch {
      setPeerFail('unexpected')
    } finally {
      setPeerBusy(false)
    }
  }

  // PG-9: leave the network — a confirmed write, then the status poll paints
  // the not-joined overview again.
  const runPeerLeave = async (): Promise<void> => {
    setPeerActionFailed(false)
    try {
      const response = await fetch(CLIENT_PEER_LEAVE_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean }
      setPeerActionFailed(!response.ok || body.ok !== true)
      await loadPeerStatus()
    } catch {
      setPeerActionFailed(true)
    }
  }

  // PG-9: one network-device management action — toggle-mount / trust —
  // keyed by node id; the status refresh repaints the modal either way.
  const runPeerNodeAction = async (route: string, nodeId: string, payload: Record<string, unknown>): Promise<void> => {
    setPeerBusyNode(nodeId)
    setPeerActionFailed(false)
    setPeerNotice(undefined)
    try {
      const response = await fetch(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean }
      if (!response.ok || body.ok !== true) setPeerActionFailed(true)
      if (route === CLIENT_PEER_TRUST_ROUTE && response.ok && body.ok === true) setPeerNotice('trustOk')
    } catch {
      setPeerActionFailed(true)
    } finally {
      setPeerBusyNode(null)
    }
    await loadPeerStatus()
  }

  const hostTicketRef = useRef(0)
  const loadHostStatus = useCallback(async (): Promise<void> => {
    const mine = ++hostTicketRef.current
    try {
      const [wizardResponse, adminResponse] = await Promise.all([fetch(WIZARD_STATUS_ROUTE), fetch(ADMIN_STATUS_ROUTE)])
      if (wizardResponse.ok && mine === hostTicketRef.current) {
        const body = (await wizardResponse.json()) as WizardStatusBody
        if (body?.ok === true) setWizardStatus(body)
      }
      if (adminResponse.ok && mine === hostTicketRef.current) {
        const body = (await adminResponse.json()) as AdminStatusBody
        if (body?.ok === true) {
          setGatewayReachable(body.gatewayReachable === true)
          setViaGateway(body.viaGateway === true)
          const derived = deriveSettingsView(body, { now: Date.now() })
          setAllDevices(derived.devices)
          if (derived.pairing?.role === 'desktop-client' && typeof body.gateway?.pairing?.expiresAt === 'number') {
            setDesktopPairing({ code: derived.pairing.code, expiresAt: body.gateway.pairing.expiresAt })
          }
        }
      }
      if (mine === hostTicketRef.current) setStatusLoaded(true)
    } catch {
      // keep the last ready data
    }
  }, [])

  // Poll the role's own status route: client status on a client, the peer
  // node's network status on a peer (PG-9) — PLUS the host wizard + admin
  // routes, because a peer's lower PWA section renders the gateway /
  // ingress / device facts from exactly those (PG-9-fix); the host wizard +
  // admin routes otherwise.
  useEffect(() => {
    if (effectiveClient) {
      void loadClientStatus()
      const handle = setInterval(() => { void loadClientStatus() }, 5000)
      return () => clearInterval(handle)
    }
    if (effectivePeer) {
      void loadPeerStatus()
      void loadHostStatus()
      const handle = setInterval(() => {
        void loadPeerStatus()
        void loadHostStatus()
      }, 5000)
      return () => clearInterval(handle)
    }
    void loadHostStatus()
    const handle = setInterval(() => { void loadHostStatus() }, 5000)
    return () => clearInterval(handle)
  }, [effectiveClient, effectivePeer, loadClientStatus, loadPeerStatus, loadHostStatus])

  const runDeviceAction = async (payload: Record<string, unknown>): Promise<void> => {
    setDeviceBusy(true)
    setDeviceError(false)
    try {
      const response = await fetch(ADMIN_ACTION_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean }
      if (response.ok && body.ok === true) {
        await loadHostStatus()
      } else {
        setDeviceError(true)
      }
    } catch {
      setDeviceError(true)
    } finally {
      setDeviceBusy(false)
    }
  }

  // Close the wizard modal, either devices modal or the servers modal on Escape when no sub-card is open and not mid-save.
  useEffect(() => {
    if ((!modalOpen && !devicesModalOpen && !serversModalOpen && !peerDevicesModalOpen) || card !== undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !savingConfig && !clientClaimBusy && !deviceBusy && peerBusyNode === null) {
        if (renamingDevice !== null) {
          setRenamingDevice(null)
          return
        }
        if (devicesModalOpen) {
          setDevicesModalOpen(false)
          return
        }
        if (serversModalOpen) {
          setServersModalOpen(false)
          return
        }
        if (peerDevicesModalOpen) {
          setPeerDevicesModalOpen(false)
          return
        }
        setModalOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [modalOpen, devicesModalOpen, serversModalOpen, peerDevicesModalOpen, card, savingConfig, clientClaimBusy, deviceBusy, peerBusyNode, renamingDevice])

  // Seed the entry step AND the configure forms from the FIRST ready
  // wizard status on a host deployment — and on a PEER deployment too
  // (PG-9-fix): its lower PWA section reads the same ingress facts, while
  // the wizard itself stays at pick (the network overview is resident).
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current || wizardStatus === undefined || effectiveClient) return
    seededRef.current = true
    if (!effectivePeer) setStep(initialStep(wizardStatus))
    const seed = formSeedOf(wizardStatus)
    if (seed.path !== undefined) setPath(seed.path)
    else if (wizardStatus.publicUrl !== '') setPath('lan')
    if (seed.domain !== '') setDomain(seed.domain)
    if (seed.httpsPort !== '') setHttpsPort(seed.httpsPort)
    if (seed.serverUrl !== '') {
      setServerUrl(seed.serverUrl)
    } else if (wizardStatus.mode === 'off' && wizardStatus.lanAddress !== undefined && wizardStatus.lanAddress !== '') {
      setServerUrl(`http://${wizardStatus.lanAddress}:${upstreamPortOf(wizardStatus)}`)
    }
  }, [wizardStatus, effectiveClient, effectivePeer])

  // Verification polling: only while a web pairing session is active and could still move.
  const pollVerdict = poll?.result
  useEffect(() => {
    const active = webPairRequested
      && startResult?.ok === true
      && startResult.pairingCode !== ''
      && (pollVerdict === undefined || pollVerdict === 'not-started' || pollVerdict === 'pending')
    if (!active) return
    let cancelled = false
    const beat = async (): Promise<void> => {
      try {
        const response = await fetch(WIZARD_VERIFY_ROUTE)
        if (!response.ok || cancelled) return
        const body = (await response.json()) as WizardVerifyPoll
        if (body?.result !== undefined && !cancelled) setPoll(body)
      } catch {
        // keep the last verdict
      }
    }
    const handle = setInterval(() => { void beat() }, 3000)
    void beat()
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [webPairRequested, startResult, pollVerdict])

  // Countdown ticker while a web or desktop pairing code (or client retry) is active.
  const hasActiveCountdown = (webPairRequested && startResult?.ok === true && startResult.pairingCode !== '')
    || (desktopPairing !== undefined && desktopPairing.expiresAt > now)
    || clientView?.nextRetryAt !== undefined
  useEffect(() => {
    if (!hasActiveCountdown) return
    const handle = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(handle)
  }, [hasActiveCountdown])

  const disabled = !effectiveClient && viaGateway
  const tokenSaved = wizardStatus?.cfTokenConfigured === true || tokenNotice === 'saved'
  const effectiveCfToken = cfToken.trim() !== '' ? cfToken : (tokenSaved ? '__SAVED__' : '')
  const readiness = useMemo(
    () => configureReadiness(path, { domain, httpsPort, cfToken: effectiveCfToken, serverUrl }),
    [path, domain, httpsPort, effectiveCfToken, serverUrl],
  )

  const resolvedVerifyUrl = useMemo(() => {
    if (path === 'external' || path === 'lan') {
      const trimmed = serverUrl.trim()
      if (trimmed !== '') return trimmed
    }
    if (readiness.ok && readiness.publicUrl !== '') return readiness.publicUrl
    if (wizardStatus?.publicUrl !== undefined && wizardStatus.publicUrl !== '') return wizardStatus.publicUrl
    if (path === 'lan') {
      const lanHost = wizardStatus?.lanAddress !== undefined && wizardStatus.lanAddress !== ''
        ? wizardStatus.lanAddress
        : '127.0.0.1'
      return `http://${lanHost}:${upstreamPortOf(wizardStatus)}`
    }
    return ''
  }, [path, serverUrl, readiness, wizardStatus])

  const probeAccessUrl = useCallback(async (urlToProbe: string): Promise<void> => {
    if (urlToProbe === '') return
    setNotWired(false)
    setProbingUrl(true)
    try {
      const sendProbe = () => fetch(WIZARD_VERIFY_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicUrl: urlToProbe, probeOnly: true }),
      })
      let response = await sendProbe()
      // When switching from client to host role, the plugin row reloads and the
      // gateway child process takes a brief moment to bind its port. Retry once
      // or twice before surfacing a transient 404 or gateway-unreachable.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (response.status === 404) {
          await new Promise((resolve) => setTimeout(resolve, 900))
          response = await sendProbe()
          continue
        }
        const clone = (await response.clone().json().catch(() => undefined)) as WizardVerifyStart | undefined
        if (clone !== undefined && !clone.ok && clone.reason === 'gateway-unreachable') {
          await new Promise((resolve) => setTimeout(resolve, 900))
          response = await sendProbe()
          continue
        }
        break
      }
      if (response.status === 501) {
        setNotWired(true)
        return
      }
      const body = (await response.json()) as WizardVerifyStart
      if (body.ok) setGatewayReachable(true)
      setStartResult((prev) => {
        // Keep an active web pairing code on screen if one was already requested and probe passed.
        if (body.ok && prev?.ok === true && prev.pairingCode !== '' && body.pairingCode === '') {
          return prev
        }
        return body
      })
    } catch {
      setStartResult({ ok: false, reason: 'gateway-unreachable' })
    } finally {
      setProbingUrl(false)
    }
  }, [])

  // Automatically test access URL connectivity when the verify step opens (or when
  // managed Caddy / Tunnel transitions to running while on the verify step).
  useEffect(() => {
    if (!modalOpen || step !== 'verify' || wizardRole !== 'host' || disabled) return
    if (resolvedVerifyUrl === '') return
    void probeAccessUrl(resolvedVerifyUrl)
  }, [modalOpen, step, wizardRole, disabled, resolvedVerifyUrl, caddyState, tunnelState, probeAccessUrl])

  const saveTokenValue = async (rawToken: string): Promise<boolean> => {
    try {
      const response = await fetch(WIZARD_CF_TOKEN_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: rawToken }),
      })
      if (response.status === 404 && effectiveClient) {
        // PG-9-fix: this reload path runs on a role switch — keep the role
        // the user came from (a peer configuring its phone channel stays a
        // peer).
        await props.saveRowFields({
          role: targetHostSaveRole(keepPeerRole),
          autoShareNewSessions: autoShare,
          ...(hostName.trim() !== '' ? { serverName: hostName.trim() } : {}),
        })
        setProbedRole(keepPeerRole ? 'peer' : 'host')
        for (let i = 0; i < 6; i++) {
          await new Promise((resolve) => setTimeout(resolve, 650))
          const retry = await fetch(WIZARD_CF_TOKEN_ROUTE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: rawToken }),
          })
          if (retry.status !== 404) {
            const ok = retry.ok
            setTokenNotice(ok ? 'saved' : 'failed')
            if (ok) setCfToken('')
            return ok
          }
        }
      }
      const ok = response.ok
      setTokenNotice(ok ? 'saved' : 'failed')
      if (ok) setCfToken('')
      return ok
    } catch {
      setTokenNotice('failed')
      return false
    }
  }

  const advanceFromConfigure = async (): Promise<void> => {
    setFormError(null)
    if (!readiness.ok) {
      setFormError(readiness.error)
      return
    }
    setSavingConfig(true)
    const wasClient = effectiveClient
    const currentHostSetting = typeof config.rowValue('host') === 'string' ? (config.rowValue('host') as string).trim() : ''
    const needsLanHostBind = path === 'lan' && currentHostSetting !== '0.0.0.0' && currentHostSetting !== '::'
    try {
      try {
        // PG-9-fix: a peer that came here for its phone channel keeps its
        // row role — only a deliberate host pick on the role cards writes
        // 'host' (targetHostSaveRole over the keep flag).
        const baseFields: Record<string, unknown> = {
          role: targetHostSaveRole(keepPeerRole),
          autoShareNewSessions: autoShare,
          ...(hostName.trim() !== '' ? { serverName: hostName.trim() } : {}),
        }
        if (path === 'lan') {
          // LAN / Tailscale direct connections arrive on the machine's LAN or
          // Tailscale interface, so the gateway child binds to `0.0.0.0` (with
          // lan-gate's private-IP wall blocking any unproxied public IP).
          await props.saveRowFields(
            {
              ...baseFields,
              host: '0.0.0.0',
              ingressMode: 'off',
              ...(readiness.publicUrl !== '' ? { ingressPublicUrl: readiness.publicUrl } : {}),
            },
            readiness.publicUrl === '' ? { unset: ['ingressPublicUrl'] } : undefined,
          )
        } else if (path === 'external') {
          await props.saveRowFields({
            ...baseFields,
            ingressMode: 'external',
            ingressPublicUrl: readiness.publicUrl,
          })
        } else {
          // Managed Caddy and Cloudflare Tunnel both run on the same host and
          // connect to the gateway over loopback, so reset `host` back to
          // `127.0.0.1` in case the user previously enabled LAN mode.
          await props.saveRowFields({
            ...baseFields,
            host: '127.0.0.1',
            ingressMode: path,
            ingressDomain: domain.trim(),
            ingressHttpsPort: readiness.httpsPort,
          })
        }
        // If this machine was previously in client mode or just rebound
        // `host` to `0.0.0.0` for LAN access, wait for the restart-watcher to
        // reload the plugin row and respawn the local gateway child process
        // before saving the token or probing.
        if (wasClient || needsLanHostBind) {
          setProbedRole(keepPeerRole ? 'peer' : 'host')
          if (needsLanHostBind && !wasClient) {
            // Give the restart-watcher time to observe the `host` change and
            // restart the gateway child on 0.0.0.0.
            await new Promise((resolve) => setTimeout(resolve, 900))
          }
          for (let i = 0; i < 6; i++) {
            await new Promise((resolve) => setTimeout(resolve, 650))
            try {
              const res = await fetch(ADMIN_STATUS_ROUTE)
              if (res.ok) {
                const body = (await res.json()) as AdminStatusBody
                if (body?.ok === true && body.gatewayReachable === true) break
              }
            } catch {
              // keep waiting for gateway startup
            }
          }
          await loadHostStatus()
        }
      } catch {
        // Even if the row mutation is pending mirror sync, proceed to token save / verify.
      }
      if ((path === 'caddy' || path === 'cloudflared') && cfToken.trim() !== '') {
        const saved = await saveTokenValue(cfToken.trim())
        if (!saved) return
      }
      // Mode-switch process synchronization: stop any managed ingress process
      // that does not belong to the newly saved path so an old tunnel or
      // Caddy child never keeps running across a mode change.
      if (path !== 'caddy') {
        fetch(WIZARD_CADDY_STOP_ROUTE, { method: 'POST' }).catch(() => {})
        setCaddyState('stopped')
        setCaddyStartError(undefined)
      }
      if (path !== 'cloudflared') {
        fetch(WIZARD_TUNNEL_STOP_ROUTE, { method: 'POST' }).catch(() => {})
        setTunnelState('stopped')
        setTunnelResult(undefined)
        setTunnelCheck(undefined)
        setAdoptTunnelId(undefined)
      }
      await loadHostStatus()
      setHostSavedInSession(true)
      setStep('verify')
    } finally {
      setSavingConfig(false)
    }
  }

  const startVerification = async (): Promise<void> => {
    const publicUrl = resolvedVerifyUrl
    setNotWired(false)
    setWebPairRequested(true)
    setProbingUrl(true)
    try {
      const response = await fetch(WIZARD_VERIFY_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicUrl }),
      })
      if (response.status === 501) {
        setNotWired(true)
        return
      }
      const body = (await response.json()) as WizardVerifyStart
      if (body.ok) setGatewayReachable(true)
      setStartResult(body)
      setPoll(body.ok ? { result: 'not-started' } : undefined)
    } catch {
      setStartResult({ ok: false, reason: 'gateway-unreachable' })
      setPoll(undefined)
    } finally {
      setProbingUrl(false)
    }
  }

  const runDesktopPair = async (): Promise<void> => {
    setDesktopPairBusy(true)
    setDesktopCopied(false)
    try {
      const response = await fetch(ADMIN_PAIR_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'desktop-client' }),
      })
      if (response.ok) {
        const body = (await response.json()) as { ok?: unknown; code?: unknown; expiresAt?: unknown }
        if (body?.ok === true && typeof body.code === 'string' && typeof body.expiresAt === 'number') {
          setDesktopPairing({ code: body.code, expiresAt: body.expiresAt })
        }
      }
    } catch {
      // ignore network error; user can retry
    } finally {
      setDesktopPairBusy(false)
    }
  }

  const resolvedHostEndpoint = useMemo(() => {
    if (path === 'external' || path === 'lan') {
      const trimmed = serverUrl.trim()
      if (trimmed !== '') return trimmed
    }
    if (readiness.ok && readiness.publicUrl !== '') return readiness.publicUrl
    if (wizardStatus?.publicUrl !== undefined && wizardStatus.publicUrl !== '') return wizardStatus.publicUrl
    const port = upstreamPortOf(wizardStatus)
    if (wizardStatus?.lanAddress !== undefined && wizardStatus.lanAddress !== '') {
      return `http://${wizardStatus.lanAddress}:${port}`
    }
    return t('wizard.desktop.addressFallback', { port: String(port) })
  }, [path, serverUrl, readiness, wizardStatus, t])

  // Fast 2s poll while waiting on gateway-side manual approval so the
  // verify lights flip to green promptly once the administrator clicks Approve.
  const waitingPeerApproval = modalOpen && step === 'verify' && wizardRole === 'peer' && peerView?.gatewayState === 'pending-approval'
  useEffect(() => {
    if (!waitingPeerApproval) return
    const handle = setInterval(() => { void loadPeerStatus() }, 2000)
    return () => clearInterval(handle)
  }, [waitingPeerApproval, loadPeerStatus])

  const copyDesktopInfo = async (): Promise<void> => {
    if (desktopPairing === undefined) return
    const text = t('wizard.desktop.copiedText', { address: resolvedHostEndpoint, code: desktopPairing.code })
    if (await copyTextToClipboard(text)) {
      setDesktopCopied(true)
    }
  }

  const runClientClaim = async (): Promise<void> => {
    setFormError(null)
    setClientClaimFail(null)
    // UX-1: the facts that decide the post-pairing reload — whether the page
    // opened as an already-effective client, and whether the backend's
    // stream interceptor was already active (from the last client/status
    // diagnostics). Captured BEFORE the role switch and the claim below.
    const wasEffectiveClient = effectiveClient
    const streamInterceptAlreadyActive = clientView?.intercept?.installed === true
    const trimmedUrl = clientServerUrl.trim()
    const normalizedCode = normalizePairingCode(clientPairCode)
    if (trimmedUrl === '' || !/^https?:\/\//i.test(trimmedUrl)) {
      setFormError('bad-client-url')
      return
    }
    if (normalizedCode === '') {
      setFormError('bad-client-code')
      return
    }
    // MS-8: a NEW address at a full pool is refused locally (the button is
    // gated too — this backs it up); an already-paired address still
    // re-pairs its entry in place, which is how a revoked token at 8/8
    // gets back in.
    if (claimGate.blockedByLimit) {
      setClientClaimFail({ code: 'limit-reached' })
      return
    }
    setClientClaimBusy(true)
    try {
      // If the deployment is currently running as 'host', switch role to 'client'
      // first so the backend restart-watcher reloads the plugin into client mode
      // and registers CLIENT_CLAIM_ROUTE.
      if (!effectiveClient) {
        try {
          await props.saveRowFields({
            role: 'client',
            ...(clientDeviceName.trim() !== '' ? { serverName: clientDeviceName.trim() } : {}),
          })
          await new Promise((resolve) => setTimeout(resolve, 1600))
        } catch {
          // proceed to claim attempt
        }
      }
      const deviceName = claimDeviceNameOf(clientDeviceName, t('settings.client.deviceNameDefault'))
      const response = await fetch(CLIENT_CLAIM_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // MS-5 pool mode: the route reads `name` (the settings page's field).
        body: JSON.stringify({
          serverUrl: trimmedUrl,
          code: normalizedCode,
          name: deviceName,
        }),
      })
      const body = (await response.json()) as ClaimRouteBody
      if (body?.ok === true) {
        if (typeof body.entryId === 'string' && body.entryId !== '') {
          // Pool mode: the pairing landed straight in the pool store (the
          // token never rides the answer) — remember WHICH entry the wizard
          // just touched so step 3 opens on it.
          setActiveClientEntryId(body.entryId)
        } else if (typeof body.token === 'string' && body.token !== '') {
          // Legacy single-server route: the token rides the answer and the
          // row is the store.
          const urlToWrite = typeof body.serverUrl === 'string' && body.serverUrl !== '' ? body.serverUrl : trimmedUrl
          const echoed = typeof body.deviceName === 'string' && body.deviceName.trim() !== '' ? body.deviceName.trim() : deviceName
          await config.writeClientPairing(urlToWrite, body.token, echoed)
        }
        if (shouldReloadAfterClientActivation({
          wasEffectiveClient,
          nowClientRole: true,
          savedOrPaired: true,
          streamInterceptAlreadyActive,
        })) {
          // UX-1: this was the FIRST client activation while the page's three
          // resident global streams were opened unwrapped — wait out the
          // backend's row-reload window, then reload so the streams reopen
          // wrapped and the server's shared sessions enter the sidebar.
          await awaitClientStatusReady()
          window.location.reload()
          return
        }
        setClientPairCode('')
        await loadClientStatus()
        setStep('verify')
      } else {
        const failReason = body && typeof body.code === 'string' ? body.code : 'unexpected'
        const retryAfterMs = body && typeof body.retryAfterMs === 'number' ? body.retryAfterMs : undefined
        setClientClaimFail(retryAfterMs === undefined ? { code: failReason } : { code: failReason, retryAfterMs })
      }
    } catch {
      setClientClaimFail({ code: 'unreachable' })
    } finally {
      setClientClaimBusy(false)
    }
  }

  const runClientUnpair = async (): Promise<void> => {
    setClientUnpairBusy(true)
    try {
      await config.clearDeviceToken()
      await loadClientStatus()
      setStep('configure')
    } catch {
      // ignore
    } finally {
      setClientUnpairBusy(false)
    }
  }

  // MS-8: one paired server's management action — the reconnect route's
  // `{ entryId }` shape or the unpair route's. The status refresh runs
  // either way so the surface re-renders on the pool's verdict.
  const runServerAction = async (route: string, entryId: string, payload: Record<string, unknown>): Promise<void> => {
    setServerBusyEntry(entryId)
    setServerActionFailed(false)
    try {
      const response = await fetch(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) setServerActionFailed(true)
    } catch {
      setServerActionFailed(true)
    } finally {
      setServerBusyEntry(null)
    }
    await loadClientStatus()
  }

  // Managed-Caddy & Tunnel controls (GW-13a / GW-13b): keyed strictly off the
  // currently selected `path` so switching away from Tunnel or Caddy never
  // leaves the previous mode's status bar or notices on screen.
  const caddyPath = wizardRole === 'host' && path === 'caddy'
  const tunnelPath = wizardRole === 'host' && path === 'cloudflared'
  const pollIngressState = async (route: string, apply: (state: CaddyState) => void): Promise<void> => {
    try {
      const response = await fetch(route)
      if (!response.ok) return
      const body = (await response.json()) as { state?: unknown }
      if (body?.state === 'running' || body?.state === 'stopped' || body?.state === 'never-started') apply(body.state)
    } catch {
      // keep the last state
    }
  }
  useEffect(() => {
    if (step !== 'verify' || !caddyPath) return
    const beat = (): Promise<void> => pollIngressState(WIZARD_CADDY_STATUS_ROUTE, setCaddyState)
    void beat()
    const handle = setInterval(() => { void beat() }, 3000)
    return () => clearInterval(handle)
  }, [step, caddyPath])
  useEffect(() => {
    if (step !== 'verify' || !tunnelPath) return
    const beat = (): Promise<void> => pollIngressState(WIZARD_TUNNEL_STATUS_ROUTE, setTunnelState)
    void beat()
    const handle = setInterval(() => { void beat() }, 3000)
    return () => clearInterval(handle)
  }, [step, tunnelPath])

  const startCaddy = async (): Promise<void> => {
    setCaddyStartError(undefined)
    setCaddyBusy(true)
    try {
      const parsedPort = Number(httpsPort.trim())
      const response = await fetch(WIZARD_CADDY_START_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: domain.trim(),
          ...(Number.isSafeInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? { httpsPort: parsedPort } : {}),
        }),
      })
      const body = (await response.json()) as { ok?: unknown; error?: unknown; detail?: unknown; installUrl?: unknown }
      if (body?.ok === true) {
        setCaddyState('running')
        setTunnelState('stopped')
        return
      }
      if (response.status === 501) {
        setNotWired(true)
        return
      }
      setCaddyStartError(caddyFailureCopy(String(body?.error ?? ''), typeof body?.detail === 'string' ? body.detail : undefined, typeof body?.installUrl === 'string' ? body.installUrl : undefined))
    } catch {
      setCaddyStartError({ key: 'wizard.caddy.failSpawn', params: {} })
    } finally {
      setCaddyBusy(false)
    }
  }

  const stopCaddy = async (): Promise<void> => {
    try {
      await fetch(WIZARD_CADDY_STOP_ROUTE, { method: 'POST' })
      setCaddyState('stopped')
    } catch {
      // the 3 s poll will correct the label
    }
  }

  // Tunnel path (GW-13b): the check-domain probe (the migration card's
  // re-check) and the full setup. A conflict carries the same-name list —
  // each entry offers adoption, which re-runs setup with its tunnelId.
  const checkDomain = async (): Promise<void> => {
    const targetDomain = path === 'external' ? serverUrl.trim() : domain.trim()
    setTunnelCheck(undefined)
    try {
      const response = await fetch(WIZARD_TUNNEL_CHECK_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: targetDomain }),
      })
      const body = (await response.json()) as TunnelCheckWire
      setTunnelCheck(body)
    } catch {
      setTunnelCheck({ ok: false, reason: 'network' })
    }
  }

  const setupTunnelNow = async (tunnelId?: string): Promise<void> => {
    setTunnelBusy(true)
    try {
      const response = await fetch(WIZARD_TUNNEL_SETUP_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain.trim(), ...(tunnelId !== undefined ? { tunnelId } : {}) }),
      })
      const body = (await response.json()) as TunnelSetupWire
      setTunnelResult(body)
      if (body.ok) {
        setTunnelState('running')
        setCaddyState('stopped')
      }
    } catch {
      setTunnelResult({ ok: false, reason: 'network' })
    } finally {
      setTunnelBusy(false)
    }
  }

  // Only show on the bundle detail page (never on a component row page).
  const subject = (props as { subject?: { kind?: string; pkg?: { name?: string } } }).subject
  if (subject !== undefined && (subject.kind === 'row' || (subject.pkg?.name !== undefined && subject.pkg.name !== 'dsh-zen-remote'))) {
    return null
  }

  const baseHostLights = deriveWizardLights({ gatewayReachable, poll, startResult })
  const lights = pairTarget === 'desktop-client' && desktopDevices.length > 0
    ? { ...baseHostLights, pairing: 'pass' as const }
    : baseHostLights
  const clientLights = deriveClientWizardLights({
    tokenConfigured: roleSnapshot.deviceToken.configured || clientView?.state === 'connected',
    clientState: clientView?.state,
    interceptInstalled: clientView?.intercept?.installed,
  })
  // MS-8: the paired-server pool as the overview grid, wizard steps 2-3 and
  // the management modal all read it. The step-3 selection falls back to the
  // first row (pairing order) when nothing is recorded yet or the recorded
  // entry was removed.
  const serverRows = clientView?.servers ?? []
  const poolSummary = deriveClientOverviewSummary(serverRows, clientView?.maxServers)
  const activeServer = serverRows.find((server) => server.entryId === activeClientEntryId) ?? serverRows[0]
  const serverLights = deriveClientServerLights(activeServer)
  // The pairing form's cap gate (MS-8): blockedByLimit is true only for a NEW
  // address at a full pool — an already-paired address never trips it.
  const claimGate = canSubmitClientPairing({
    pairUrl: clientServerUrl,
    pairCode: clientPairCode,
    servers: serverRows,
    ...(clientView !== undefined ? { maxServers: clientView.maxServers } : {}),
  })
  const verified = poll?.result === 'pass'
  const qr = startResult?.ok === true ? qrMatrix(startResult.publicUrl) : null

  const stepLabel = (name: WizardStep): string => t(name === 'pick' ? 'wizard.step.pick' : name === 'configure' ? 'wizard.step.configure' : 'wizard.step.verify')
  const currentStepIndex = STEP_ORDER.indexOf(step)
  const pathName = (value: WizardPath): string => t(
    value === 'caddy'
      ? 'wizard.path.caddy'
      : value === 'external'
        ? 'wizard.path.external'
        : value === 'cloudflared'
          ? 'wizard.path.cloudflared'
          : 'wizard.path.lan',
  )

  const hasSavedHostConfig = hostSavedInSession
    || config.rowValue('role') === 'host'
    || (typeof config.rowValue('ingressPublicUrl') === 'string' && (config.rowValue('ingressPublicUrl') as string).trim() !== '')
  const configured = isWizardConfigured({
    effectiveClient,
    wizardStatus,
    pairedDeviceCount: webDeviceCount + desktopDevices.length,
    hasSavedHostConfig,
    tokenConfigured: roleSnapshot.deviceToken.configured,
    clientServerUrl,
    clientState: clientView?.state,
    pairedServerCount: serverRows.length,
    // PG-9: a peer deployment renders its resident network overview no
    // matter whether a network is joined yet — the row role alone configures
    // the overview.
    peerConfigured: effectivePeer,
  })

  const statusSummary = (() => {
    if (effectivePeer) {
      // PG-9: the header badge mirrors the network admission state — green
      // once authorized, amber while joining or reconnecting, red on the
      // terminal verdicts.
      const state = peerView?.gatewayState ?? 'unconfigured'
      const light = state === 'authorized' ? 'pass' : state === 'mismatch' || state === 'revoked' || state === 'paused' ? 'fail' : 'pending'
      return {
        state: light as 'pass' | 'pending' | 'fail',
        text: peerView?.configured === true ? peerStateCopy(state, t) : t('wizard.peer.notJoined'),
      }
    }
    if (effectiveClient) {
      if (poolSummary.totalCount > 0) {
        return {
          state: (poolSummary.onlineCount > 0 ? 'pass' : 'pending') as 'pass' | 'pending',
          text: `${t('wizard.role.client')} · ${t('wizard.overview.clientOnlineCount', { online: poolSummary.onlineCount, total: poolSummary.totalCount })}`,
        }
      }
      if (clientView?.state === 'connected') {
        const label = clientView.serverName !== '' ? clientView.serverName : (clientView.serverUrl || t('wizard.role.client'))
        return { state: 'pass' as const, text: `${t('wizard.role.client')} · ${label}` }
      }
      if (roleSnapshot.deviceToken.configured) {
        return { state: 'pending' as const, text: t('wizard.role.client') }
      }
      return { state: 'idle' as const, text: t('settings.client.statusUnpaired') }
    }
    if (wizardStatus === undefined || wizardStatus.mode === 'off') {
      if (configured && gatewayReachable) {
        return { state: 'pass' as const, text: t('wizard.path.lan') }
      }
      return { state: 'idle' as const, text: t('wizard.off') }
    }
    if (wizardStatus.mode === 'caddy') {
      const running = caddyState === 'running' || (caddyState === undefined && wizardStatus.caddyRunning)
      return { state: running ? 'pass' as const : 'pending' as const, text: t(running ? 'wizard.caddy.running' : 'wizard.caddy.stopped') }
    }
    if (wizardStatus.mode === 'cloudflared') {
      const running = tunnelState === 'running' || (tunnelState === undefined && wizardStatus.cloudflaredRunning)
      return { state: running ? 'pass' as const : 'pending' as const, text: t(running ? 'wizard.tunnel.running' : 'wizard.tunnel.stopped') }
    }
    return { state: 'pass' as const, text: wizardStatus.publicUrl || t('wizard.path.external') }
  })()

  // PG-9: the peer node's derived overview + lights, read off the polled
  // peer status view (the view rows are structurally the wizard's
  // PeerDeviceView). The devices light's cap follows the BODY's maxPeers —
  // the gateway's announced cap — defaulting to the pool cap before the
  // first welcome lands.
  const peerDevices: readonly PeerDeviceView[] = peerView?.peers ?? []
  const peerSummary = derivePeerOverviewSummary(peerDevices, peerView?.maxPeers ?? 8)
  const peerLights = derivePeerWizardLights({
    identityReady: (peerView?.nodeId ?? '') !== '',
    gatewayState: peerView?.gatewayState ?? 'unconfigured',
    peerCount: peerSummary.totalCount,
    mismatchCount: peerSummary.mismatchCount,
  })

  const openWizardAt = (targetStep: WizardStep, options?: { role?: WizardRole; target?: 'web' | 'desktop-client'; keepPeerRole?: boolean }): void => {
    setFormError(null)
    if (options?.role !== undefined) setWizardRole(options.role)
    if (options?.target !== undefined) setPairTarget(options.target)
    if (options?.keepPeerRole !== undefined) setKeepPeerRole(options.keepPeerRole)
    setStep(targetStep)
    setModalOpen(true)
  }

  // MS-8: 「+ 添加服务端」 — a BLANK pairing form on step 2, so a stale
  // address or code from an earlier pairing can never ride into the new one.
  const openAddServerWizard = (): void => {
    setClientServerUrl('')
    setClientPairCode('')
    setClientClaimFail(null)
    openWizardAt('configure', { role: 'client' })
  }

  return (
    <div data-zen-remote="wizard">
      <div className="zr-wizard-header">
        <div className="zr-wizard-headerText">
          <p className="zr-wizard-title">{t('wizard.title')}</p>
          <p className="zr-wizard-subtitle">{t('wizard.subtitle')}</p>
        </div>
        <div className="zr-wizard-statusBadge" data-state={statusSummary.state}>
          <span className="zr-wizard-dot" data-state={statusSummary.state === 'pass' ? 'pass' : statusSummary.state === 'fail' ? 'fail' : 'pending'} />
          <span>{statusSummary.text}</span>
        </div>
      </div>

      {statusLoaded && viaGateway && !effectiveClient ? <p className="zr-wizard-notice" data-tone="error">{t('wizard.remoteOnly')}</p> : null}
      {notWired ? <p className="zr-wizard-notice">{t('wizard.notWired')}</p> : null}

      {configured ? (
        effectiveClient ? (
          /* --- the desktop sub-client's overview (MS-6/MS-8) --- */
          <>
            <div className="zr-wizard-overviewGrid">
              <div className="zr-wizard-overviewItem">
                <p className="zr-wizard-overviewLabel">{t('wizard.overview.roleLabel')}</p>
                <p className="zr-wizard-overviewValue">{t('wizard.role.client')}</p>
                <p className="zr-wizard-overviewSub">{clientDeviceName.trim() !== '' ? clientDeviceName : t('settings.client.deviceNameDefault')}</p>
              </div>
              <div className="zr-wizard-overviewItem">
                <p className="zr-wizard-overviewLabel">{t('wizard.overview.clientSyncLabel')}</p>
                <p className="zr-wizard-overviewValue">
                  <span className="zr-wizard-dot" data-state={clientLights.sync} />
                  <span>
                    {clientLights.sync === 'pass'
                      ? t('wizard.overview.syncOk')
                      : clientLights.sync === 'fail'
                        ? t('wizard.overview.syncBad')
                        : t('wizard.overview.syncPending')}
                  </span>
                </p>
                <p className="zr-wizard-overviewSub">{t(LIGHT_LABEL[clientLights.sync])}</p>
              </div>
              <div className="zr-wizard-overviewItem">
                <p className="zr-wizard-overviewLabel">{t('wizard.overview.clientConnLabel')}</p>
                <p className="zr-wizard-overviewValue">
                  <span className="zr-wizard-dot" data-state={poolSummary.connectionLight} />
                  <span>{t('wizard.overview.clientOnlineCount', { online: poolSummary.onlineCount, total: poolSummary.totalCount })}</span>
                </p>
                <p className="zr-wizard-overviewSub">
                  {poolSummary.totalCount === 0
                    ? t('settings.client.statusUnpaired')
                    : poolSummary.offlineCount === 0 && poolSummary.revokedCount === 0
                      ? t('wizard.overview.clientAllOnline')
                      : [
                          poolSummary.offlineCount > 0 ? t('wizard.overview.clientOfflineCount', { count: poolSummary.offlineCount }) : '',
                          poolSummary.revokedCount > 0 ? t('wizard.overview.clientRevokedCount', { count: poolSummary.revokedCount }) : '',
                        ].filter((line) => line !== '').join(' · ')}
                </p>
              </div>
              <div className="zr-wizard-overviewItem">
                <div className="zr-wizard-overviewHead">
                  <p className="zr-wizard-overviewLabel">{t('wizard.overview.clientServersLabel')}</p>
                  <button
                    type="button"
                    className="zr-wizard-linkBtn"
                    onClick={() => {
                      setServerActionFailed(false)
                      setServersModalOpen(true)
                    }}
                  >
                    {t('wizard.overview.manageServers')}
                  </button>
                </div>
                <p className="zr-wizard-overviewValue" data-limit={poolSummary.limitReached ? 'true' : undefined}>
                  <span className="zr-wizard-dot" data-state={poolSummary.serversLight} />
                  <span>
                    {poolSummary.limitReached
                      ? t('wizard.overview.clientPairedFull', { count: poolSummary.totalCount, max: poolSummary.maxServers })
                      : t('settings.client.poolCount', { count: poolSummary.totalCount, max: poolSummary.maxServers })}
                  </span>
                </p>
                <p className="zr-wizard-overviewSub" data-limit={poolSummary.limitReached ? 'true' : undefined}>
                  {poolSummary.limitReached
                    ? t('wizard.overview.limitNote', { max: poolSummary.maxServers })
                    : serverRows.length === 0
                      ? t('settings.client.serversEmpty', { max: poolSummary.maxServers })
                      : t('wizard.overview.clientPairedNames', {
                          names: serverRows.map((server) => (server.displayName !== '' ? server.displayName : server.serverUrl)).join('、'),
                          max: poolSummary.maxServers,
                        })}
                </p>
              </div>
            </div>

            <div className="zr-wizard-footer">
              <div className="zr-wizard-row">
                <button
                  type="button"
                  className="zr-wizard-btn"
                  disabled={clientLoading}
                  onClick={() => { void loadClientStatus() }}
                >
                  {clientLoading ? t('settings.client.statusRefreshing') : t('settings.client.statusRefresh')}
                </button>
                <button
                  type="button"
                  className="zr-wizard-btn"
                  onClick={() => openWizardAt('pick', { role: 'client' })}
                >
                  {t('wizard.overview.reconfigure')}
                </button>
              </div>
              <div className="zr-wizard-row">
                <button
                  type="button"
                  className="zr-wizard-btn"
                  onClick={() => {
                    setServerActionFailed(false)
                    setServersModalOpen(true)
                  }}
                >
                  {t('wizard.overview.manageServers')}
                </button>
                <button
                  type="button"
                  className="zr-wizard-btn zr-wizard-btnPrimary"
                  disabled={poolSummary.limitReached}
                  onClick={openAddServerWizard}
                >
                  {t('wizard.overview.addServer')}
                </button>
              </div>
            </div>
          </>
        ) : effectivePeer ? (
          /* --- the peer node's resident network overview (PG-9): the mesh
              half on top; the phone-PWA half keeps rendering BELOW through
              the shared `!clientRole` settings surfaces, and the wizard's
              own host tiles are simply not this machine's --- */
          <>
            <div className="zr-wizard-overviewGrid">
              <div className="zr-wizard-overviewItem">
                <p className="zr-wizard-overviewLabel">{t('wizard.overview.roleLabel')}</p>
                <p className="zr-wizard-overviewValue">{t('wizard.role.peer')}</p>
                <p className="zr-wizard-overviewSub">{peerView?.configured === true ? peerView.nodeId : t('wizard.peer.notJoined')}</p>
              </div>
              <div className="zr-wizard-overviewItem">
                <p className="zr-wizard-overviewLabel">{t('wizard.overview.peerNetworkLabel')}</p>
                <p className="zr-wizard-overviewValue">
                  <span className="zr-wizard-dot" data-state={peerLights.admission} />
                  <span>{peerView?.configured === true ? peerStateCopy(peerView.gatewayState, t) : t('wizard.overview.peerNetworkNone')}</span>
                </p>
                <p className="zr-wizard-overviewSub">{peerView?.networkId !== undefined ? peerView.networkId : ''}</p>
              </div>
              <div className="zr-wizard-overviewItem">
                <p className="zr-wizard-overviewLabel">{t('wizard.overview.peerConnLabel')}</p>
                <p className="zr-wizard-overviewValue">
                  <span className="zr-wizard-dot" data-state={peerSummary.connectionLight} />
                  <span>
                    {peerSummary.totalCount === 0
                      ? t('wizard.overview.peerConnNone')
                      : t('wizard.overview.peerConnSummary', { direct: String(peerSummary.directCount), relay: String(peerSummary.relayCount) })}
                  </span>
                </p>
                <p className="zr-wizard-overviewSub">
                  {peerSummary.totalCount > 0
                    ? t('wizard.overview.peerDevicesCount', { count: String(peerSummary.mountedCount), max: String(peerSummary.totalCount) })
                    : ''}
                </p>
              </div>
              <div className="zr-wizard-overviewItem">
                <div className="zr-wizard-overviewHead">
                  <p className="zr-wizard-overviewLabel">{t('wizard.overview.peerDevicesLabel')}</p>
                  <button
                    type="button"
                    className="zr-wizard-linkBtn"
                    onClick={() => {
                      setPeerActionFailed(false)
                      setPeerNotice(undefined)
                      setPeerDevicesModalOpen(true)
                    }}
                  >
                    {t('wizard.peer.devicesModalTitle')}
                  </button>
                </div>
                <p className="zr-wizard-overviewValue" data-limit={peerSummary.limitReached ? 'true' : undefined}>
                  <span className="zr-wizard-dot" data-state={peerSummary.devicesLight} />
                  <span>
                    {peerSummary.limitReached
                      ? t('wizard.overview.peerDevicesFull', { max: String(peerSummary.maxPeers) })
                      : t('wizard.overview.peerDevicesCount', { count: String(peerSummary.totalCount), max: String(peerSummary.maxPeers) })}
                  </span>
                </p>
                <p className="zr-wizard-overviewSub" data-limit={peerSummary.limitReached ? 'true' : undefined}>
                  {peerSummary.limitReached
                    ? t('wizard.overview.limitNote', { max: String(peerSummary.maxPeers) })
                    : peerSummary.mismatchCount > 0
                      ? t('wizard.peer.devicePathMismatch')
                      : ''}
                </p>
              </div>
            </div>

            <div className="zr-wizard-footer">
              <div className="zr-wizard-row">
                <button
                  type="button"
                  className="zr-wizard-btn"
                  disabled={peerLoading}
                  onClick={() => { void loadPeerStatus() }}
                >
                  {peerLoading ? t('settings.client.statusRefreshing') : t('settings.client.statusRefresh')}
                </button>
                <button
                  type="button"
                  className="zr-wizard-btn"
                  onClick={() => openWizardAt('pick', { role: 'peer' })}
                >
                  {t('wizard.peer.switchRole')}
                </button>
                <button
                  type="button"
                  className="zr-wizard-btn"
                  onClick={() => {
                    setPeerFail(null)
                    openWizardAt('configure', { role: 'peer' })
                  }}
                >
                  {t('wizard.peer.rejoin')}
                </button>
              </div>
              <div className="zr-wizard-row">
                <button
                  type="button"
                  className="zr-wizard-btn"
                  onClick={() => {
                    setPeerActionFailed(false)
                    setPeerNotice(undefined)
                    setPeerDevicesModalOpen(true)
                  }}
                >
                  {t('wizard.peer.devicesModalTitle')}
                </button>
                <button
                  type="button"
                  className="zr-wizard-btn"
                  disabled={peerView?.configured !== true}
                  onClick={() => {
                    if (!window.confirm(t('wizard.peer.leaveConfirm'))) return
                    void runPeerLeave()
                  }}
                >
                  {t('wizard.peer.leave')}
                </button>
              </div>
            </div>

            {/* PG-9-fix: the peer page's LOWER section — phone / browser
                (PWA) access. This machine still runs the gateway half, so
                the QR pairing, the channel configuration and the device
                management stay reachable; the flows run under wizardRole
                'host' with keepPeerRole set, so every save writes
                `role: 'peer'` (targetHostSaveRole). */}
            <div className="zr-wizard-phoneSection" data-zen-remote="wizard-phone">
              <p className="zr-wizard-sectionTitle">{t('wizard.peer.pwaSectionTitle')}</p>
              <div className="zr-wizard-serviceInfo">
                <span className="zr-wizard-dot" data-state={gatewayReachable ? 'pass' : 'fail'} />
                <span className="zr-wizard-lightName">
                  {gatewayReachable
                    ? t('wizard.overview.gatewayReady', { port: String(upstreamPortOf(wizardStatus)) })
                    : t('wizard.overview.gatewayDown')}
                </span>
                <span className="zr-wizard-hint">{pathName(path)}{resolvedHostEndpoint !== '' ? ` · ${resolvedHostEndpoint}` : ''}</span>
              </div>
              <p className="zr-wizard-hint">
                {allDevices.length > 0
                  ? t('wizard.overview.devicesSummary', { web: String(webDeviceCount), desktop: String(desktopDevices.length) })
                  : t('wizard.overview.devicesNone')}
              </p>
              <div className="zr-wizard-row">
                <button
                  type="button"
                  className="zr-wizard-btn zr-wizard-btnPrimary"
                  disabled={disabled}
                  onClick={() => openWizardAt('verify', { role: 'host', target: 'web', keepPeerRole: true })}
                >
                  {t('wizard.peer.pairPhone')}
                </button>
                <button
                  type="button"
                  className="zr-wizard-btn"
                  disabled={disabled}
                  onClick={() => openWizardAt('configure', { role: 'host', keepPeerRole: true })}
                >
                  {t('wizard.peer.configurePhoneAccess')}
                </button>
                <button
                  type="button"
                  className="zr-wizard-btn"
                  onClick={() => {
                    setDeviceError(false)
                    setRenamingDevice(null)
                    setDevicesModalOpen(true)
                  }}
                >
                  {t('wizard.peer.managePairedDevices')}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="zr-wizard-overviewGrid">
              <div className="zr-wizard-overviewItem">
                <p className="zr-wizard-overviewLabel">{t('wizard.overview.roleLabel')}</p>
                <p className="zr-wizard-overviewValue">{t('wizard.role.host')}</p>
                <p className="zr-wizard-overviewSub">{hostName.trim() !== '' ? hostName : t('settings.sourceDefault')}</p>
              </div>
              <div className="zr-wizard-overviewItem">
                <p className="zr-wizard-overviewLabel">{t('wizard.overview.gatewayLabel')}</p>
                <p className="zr-wizard-overviewValue">
                  <span className="zr-wizard-dot" data-state={gatewayReachable ? 'pass' : 'fail'} />
                  <span>
                    {gatewayReachable
                      ? t('wizard.overview.gatewayReady', { port: String(upstreamPortOf(wizardStatus)) })
                      : t('wizard.overview.gatewayDown')}
                  </span>
                </p>
                <p className="zr-wizard-overviewSub">{autoShare ? t('wizard.autoShare') : t('settings.fieldAutoShare')}</p>
              </div>
              <div className="zr-wizard-overviewItem">
                <p className="zr-wizard-overviewLabel">{t('wizard.overview.ingressLabel')}</p>
                <p className="zr-wizard-overviewValue">
                  <span className="zr-wizard-dot" data-state={statusSummary.state === 'pass' ? 'pass' : 'pending'} />
                  <span>{pathName(path)}</span>
                </p>
                <p className="zr-wizard-overviewSub">{resolvedHostEndpoint}</p>
              </div>
              <div className="zr-wizard-overviewItem">
                <div className="zr-wizard-overviewHead">
                  <p className="zr-wizard-overviewLabel">{t('wizard.overview.devicesLabel')}</p>
                  <button
                    type="button"
                    className="zr-wizard-linkBtn"
                    disabled={disabled}
                    onClick={() => {
                      setDeviceError(false)
                      setRenamingDevice(null)
                      setDevicesModalOpen(true)
                    }}
                  >
                    {t('wizard.overview.manageDevices')}
                  </button>
                </div>
                <p className="zr-wizard-overviewValue">
                  <span className="zr-wizard-dot" data-state={allDevices.length > 0 ? 'pass' : 'pending'} />
                  <span>
                    {allDevices.length > 0
                      ? t('wizard.overview.devicesSummary', { web: String(webDeviceCount), desktop: String(desktopDevices.length) })
                      : t('wizard.overview.devicesNone')}
                  </span>
                </p>
                <p className="zr-wizard-overviewSub">{statusSummary.text}</p>
              </div>
            </div>

            <div className="zr-wizard-footer">
              <div className="zr-wizard-row">
                <button
                  type="button"
                  className="zr-wizard-btn"
                  disabled={disabled}
                  onClick={() => openWizardAt('pick', { role: 'host' })}
                >
                  {t('wizard.overview.reconfigure')}
                </button>
                <button
                  type="button"
                  className="zr-wizard-btn"
                  disabled={disabled}
                  onClick={() => {
                    setDeviceError(false)
                    setRenamingDevice(null)
                    setDevicesModalOpen(true)
                  }}
                >
                  {t('wizard.overview.manageDevices')}
                </button>
              </div>
              <div className="zr-wizard-row">
                <button
                  type="button"
                  className="zr-wizard-btn"
                  disabled={disabled}
                  onClick={() => openWizardAt('verify', { role: 'host', target: 'desktop-client' })}
                >
                  {t('wizard.overview.pairDesktop')}
                </button>
                <button
                  type="button"
                  className="zr-wizard-btn zr-wizard-btnPrimary"
                  disabled={disabled}
                  onClick={() => openWizardAt('verify', { role: 'host', target: 'web' })}
                >
                  {t('wizard.overview.pairPhone')}
                </button>
              </div>
            </div>
          </>
        )
      ) : (
        <div className="zr-wizard-emptyBanner">
          <p className="zr-wizard-emptyText">{t('wizard.overview.emptyIntro')}</p>
          <button
            type="button"
            className="zr-wizard-btn zr-wizard-btnPrimary"
            disabled={disabled}
            onClick={() => openWizardAt('pick')}
          >
            {t('wizard.overview.startSetup')}
          </button>
        </div>
      )}

      {modalOpen ? (
        <div
          data-zen-remote="wizard-modal"
          onClick={() => {
            if (!savingConfig && !clientClaimBusy) setModalOpen(false)
          }}
        >
          <div
            className="zr-wizard-modalDialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('wizard.modal.title')}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="zr-wizard-modalHeader">
              <p className="zr-wizard-modalTitle">{t('wizard.modal.title')}</p>
              <button
                type="button"
                className="zr-wizard-cardCloseIcon"
                aria-label={t('wizard.card.close')}
                disabled={savingConfig || clientClaimBusy}
                onClick={() => setModalOpen(false)}
              >
                ×
              </button>
            </div>

            <ol className="zr-wizard-stepper" aria-label={t('wizard.modal.title')}>
              {STEP_ORDER.map((name, index) => {
                const state = currentStepIndex > index ? 'done' : currentStepIndex === index ? 'current' : 'upcoming'
                return (
                  <li key={name} style={{ display: 'contents' }}>
                    <div className="zr-wizard-stepItem" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
                      <span className="zr-wizard-stepCircle" aria-hidden="true">
                        {state === 'done' ? (
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                            <path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : (
                          index + 1
                        )}
                      </span>
                      <div className="zr-wizard-stepText">
                        <span className="zr-wizard-stepTag">{t('wizard.modal.stepTag', { num: String(index + 1) })}</span>
                        <span className="zr-wizard-stepName">{stepLabel(name)}</span>
                      </div>
                    </div>
                    {index < STEP_ORDER.length - 1 ? (
                      <div className="zr-wizard-stepConnector" data-done={currentStepIndex > index} aria-hidden="true" />
                    ) : null}
                  </li>
                )
              })}
            </ol>

            {step === 'pick' ? (
              <>
                <div className="zr-wizard-modalBody">
                  <p className="zr-wizard-stepIntro">{t('wizard.modal.step1Desc')}</p>
                  <p className="zr-wizard-sectionTitle">{t('wizard.role.sectionTitle')}</p>
                  <div className="zr-wizard-roleGrid" role="radiogroup" aria-label={t('wizard.role.sectionTitle')}>
                    {ROLE_OPTIONS.map(([roleValue, nameKey, descKey]) => {
                      const selected = wizardRole === roleValue
                      return (
                        <button
                          key={roleValue}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          className="zr-wizard-path"
                          data-selected={selected}
                          disabled={disabled}
                          onClick={() => {
                            setFormError(null)
                            setWizardRole(roleValue)
                            // PG-9-fix: a deliberate pick decides the keep flag —
                            // only a peer pick keeps the peer role through the
                            // channel-config saves below.
                            setKeepPeerRole(roleValue === 'peer')
                          }}
                        >
                          <div className="zr-wizard-pathHead">
                            <span className="zr-wizard-pathRadio" data-selected={selected} aria-hidden="true" />
                            <span className="zr-wizard-pathName">{t(nameKey)}</span>
                          </div>
                          <p className="zr-wizard-pathDesc">{t(descKey)}</p>
                        </button>
                      )
                    })}
                  </div>

                  {wizardRole === 'host' ? (
                    <>
                      <p className="zr-wizard-sectionTitle">{t('wizard.ingressSectionTitle')}</p>
                      <div className="zr-wizard-paths" role="radiogroup" aria-label={t('wizard.ingressSectionTitle')}>
                        {PATH_OPTIONS.map(([value, nameKey, descKey]) => {
                          const selected = path === value
                          return (
                            <button
                              key={value}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              className="zr-wizard-path"
                              data-selected={selected}
                              disabled={disabled}
                              onClick={() => {
                                selectPath(value)
                              }}
                              onDoubleClick={() => {
                                if (disabled) return
                                selectPath(value)
                                setStep(stepAfterPick())
                              }}
                            >
                              <div className="zr-wizard-pathHead">
                                <span className="zr-wizard-pathRadio" data-selected={selected} aria-hidden="true" />
                                <span className="zr-wizard-pathName">{t(nameKey)}</span>
                              </div>
                              <p className="zr-wizard-pathDesc">{t(descKey)}</p>
                            </button>
                          )
                        })}
                      </div>
                    </>
                  ) : wizardRole === 'peer' ? (
                    <p className="zr-wizard-notice">{t('wizard.role.peerPickNote')}</p>
                  ) : (
                    <p className="zr-wizard-notice">{t('wizard.role.clientPickNote')}</p>
                  )}
                </div>

                <div className="zr-wizard-modalFooter">
                  <button
                    type="button"
                    className="zr-wizard-btn"
                    onClick={() => setModalOpen(false)}
                  >
                    {t('wizard.modal.cancel')}
                  </button>
                  <div className="zr-wizard-row">
                    <span className="zr-wizard-footerHint">
                      {wizardRole === 'host'
                        ? `${t('wizard.role.host')} · ${pathName(path)}`
                        : wizardRole === 'peer'
                          ? t('wizard.role.peer')
                          : t('wizard.role.client')}
                    </span>
                    <button
                      type="button"
                      className="zr-wizard-btn zr-wizard-btnPrimary"
                      disabled={disabled}
                      onClick={() => {
                        setFormError(null)
                        setStep(stepAfterPick())
                      }}
                    >
                      {t('wizard.next')}
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            {step === 'configure' ? (
              <>
                <div className="zr-wizard-modalBody">
                  <p className="zr-wizard-stepIntro">{t('wizard.modal.step2Desc')}</p>
                  <div className="zr-wizard-selectedBar">
                    <span className="zr-wizard-selectedLabel">
                      {t('wizard.modal.selectedPlan', {
                        plan: wizardRole === 'host'
                          ? `${t('wizard.role.host')} · ${pathName(path)}`
                          : wizardRole === 'peer'
                            ? t('wizard.role.peer')
                            : t('wizard.role.client'),
                      })}
                    </span>
                  </div>

                  {wizardRole === 'host' ? (
                    <>
                      <div className="zr-wizard-formStack">
                        <div className="zr-wizard-field">
                          <label className="zr-wizard-label" htmlFor="zr-wizard-host-name">{t('wizard.hostName')}</label>
                          <input
                            id="zr-wizard-host-name"
                            className="zr-wizard-input"
                            type="text"
                            placeholder={t('wizard.hostNamePlaceholder')}
                            value={hostName}
                            disabled={disabled}
                            onChange={(event) => setHostName(event.target.value)}
                          />
                          <p className="zr-wizard-hint">{t('wizard.hostNameHint')}</p>
                        </div>

                        <label className="zr-wizard-checkRow">
                          <input
                            type="checkbox"
                            checked={autoShare}
                            disabled={disabled}
                            onChange={(event) => setAutoShare(event.target.checked)}
                          />
                          <span>{t('wizard.autoShare')}</span>
                        </label>
                      </div>

                      {path === 'lan' ? (
                        <div className="zr-wizard-field">
                          <label className="zr-wizard-label" htmlFor="zr-wizard-lan-url">{t('wizard.lanUrl')}</label>
                          <input
                            id="zr-wizard-lan-url"
                            className="zr-wizard-input"
                            type="url"
                            placeholder={t('wizard.lanUrlPlaceholder')}
                            value={serverUrl}
                            disabled={disabled}
                            onChange={(event) => setServerUrl(event.target.value)}
                          />
                          <p className="zr-wizard-hint">{t('wizard.lanUrlHint')}</p>
                        </div>
                      ) : path === 'external' ? (
                        <div className="zr-wizard-field">
                          <label className="zr-wizard-label" htmlFor="zr-wizard-server-url">{t('wizard.serverUrl')}</label>
                          <input
                            id="zr-wizard-server-url"
                            className="zr-wizard-input"
                            type="url"
                            placeholder="https://dsh.example.com"
                            value={serverUrl}
                            disabled={disabled}
                            onChange={(event) => setServerUrl(event.target.value)}
                          />
                          <p className="zr-wizard-hint">{t('wizard.serverUrlHint')}</p>
                          <div className="zr-wizard-row">
                            <button type="button" className="zr-wizard-linkBtn" disabled={disabled} onClick={() => setCard('proxy')}>
                              {t('wizard.proxySnippet')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="zr-wizard-formStack">
                          <div className="zr-wizard-formGrid">
                            <div className="zr-wizard-field">
                              <label className="zr-wizard-label" htmlFor="zr-wizard-domain">{t('wizard.domain')}</label>
                              <input
                                id="zr-wizard-domain"
                                className="zr-wizard-input"
                                type="text"
                                placeholder="dsh.example.com"
                                value={domain}
                                disabled={disabled}
                                onChange={(event) => setDomain(event.target.value)}
                              />
                              <p className="zr-wizard-hint">{t('wizard.domainHint')}</p>
                            </div>
                            <div className="zr-wizard-field zr-wizard-fieldPort">
                              <label className="zr-wizard-label" htmlFor="zr-wizard-port">{t('wizard.httpsPort')}</label>
                              <input
                                id="zr-wizard-port"
                                className="zr-wizard-input"
                                type="text"
                                inputMode="numeric"
                                value={httpsPort}
                                disabled={disabled}
                                onChange={(event) => setHttpsPort(event.target.value)}
                              />
                            </div>
                          </div>

                          {path === 'caddy' && isValidPort(httpsPort.trim()) && httpsPort.trim() !== '443' ? (
                            <div className="zr-wizard-row">
                              <button type="button" className="zr-wizard-linkBtn" disabled={disabled} onClick={() => setCard('portforward')}>
                                {t('wizard.portForwardEntry')}
                              </button>
                            </div>
                          ) : null}

                          <div className="zr-wizard-field">
                            <div className="zr-wizard-labelRow">
                              <label className="zr-wizard-label" htmlFor="zr-wizard-token">{t('wizard.cfToken')}</label>
                              {tokenSaved ? <span className="zr-wizard-savedTag">{t('wizard.token.saved')}</span> : null}
                            </div>
                            <input
                              id="zr-wizard-token"
                              className="zr-wizard-input"
                              type="password"
                              placeholder={tokenSaved ? '••••••••••••••••' : ''}
                              value={cfToken}
                              disabled={disabled}
                              onChange={(event) => setCfToken(event.target.value)}
                            />
                            <p className="zr-wizard-hint">{t('wizard.cfTokenHint')}</p>
                            <div className="zr-wizard-row">
                              <button type="button" className="zr-wizard-linkBtn" disabled={disabled} onClick={() => setCard('token')}>
                                {t('wizard.cfTokenHowTo')}
                              </button>
                              {path === 'cloudflared' ? (
                                <button type="button" className="zr-wizard-linkBtn" disabled={disabled} onClick={() => setCard('migrate')}>
                                  {t('wizard.migrateEntry')}
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      )}

                      {tokenNotice === 'failed' ? (
                        <p className="zr-wizard-notice" data-tone="error">
                          {t('wizard.token.saveFailed')}
                        </p>
                      ) : null}
                      {formError !== null ? (
                        <p className="zr-wizard-notice" data-tone="error">
                          {t(formError === 'bad-domain' ? 'wizard.badDomain' : formError === 'bad-port' ? 'wizard.badPort' : formError === 'missing-token' ? 'wizard.missingToken' : 'wizard.badServerUrl')}
                        </p>
                      ) : null}
                    </>
                  ) : wizardRole === 'peer' ? (
                    /* PG-9: the peer branch — supports pasting an invite link
                        OR entering the relay gateway URL for manual approval;
                        the three-light self-check is the VERIFY step. */
                    <>
                      <div className="zr-wizard-formStack">
                        <div className="zr-wizard-field">
                          <label className="zr-wizard-label" htmlFor="zr-wizard-peer-name">{t('wizard.hostName')}</label>
                          <input
                            id="zr-wizard-peer-name"
                            className="zr-wizard-input"
                            type="text"
                            maxLength={40}
                            placeholder={t('wizard.hostNamePlaceholder')}
                            value={hostName}
                            disabled={peerBusy}
                            onChange={(event) => setHostName(event.target.value)}
                          />
                          <p className="zr-wizard-hint">{t('wizard.hostNameHint')}</p>
                        </div>

                        <div className="zr-wizard-targetTabs" role="tablist">
                          <button
                            type="button"
                            role="tab"
                            aria-selected={peerJoinMode === 'invite'}
                            className="zr-wizard-targetTab"
                            data-selected={peerJoinMode === 'invite'}
                            disabled={peerBusy}
                            onClick={() => {
                              setPeerJoinMode('invite')
                              setPeerFail(null)
                            }}
                          >
                            {t('wizard.peer.modeInvite')}
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={peerJoinMode === 'gateway'}
                            className="zr-wizard-targetTab"
                            data-selected={peerJoinMode === 'gateway'}
                            disabled={peerBusy}
                            onClick={() => {
                              setPeerJoinMode('gateway')
                              setPeerFail(null)
                            }}
                          >
                            {t('wizard.peer.modeGateway')}
                          </button>
                        </div>

                        {peerJoinMode === 'invite' ? (
                          <div className="zr-wizard-field">
                            <label className="zr-wizard-label" htmlFor="zr-wizard-peer-invite">{t('wizard.peer.inviteUri')}</label>
                            <input
                              id="zr-wizard-peer-invite"
                              className="zr-wizard-input"
                              type="text"
                              autoComplete="off"
                              spellCheck={false}
                              placeholder={t('wizard.peer.inviteUriPlaceholder')}
                              value={peerInvite}
                              disabled={peerBusy}
                              onChange={(event) => {
                                setPeerInvite(event.target.value)
                                if (peerFail !== null) setPeerFail(null)
                              }}
                            />
                            <p className="zr-wizard-hint">{t('wizard.peer.inviteUriHint')}</p>
                          </div>
                        ) : (
                          <>
                            <div className="zr-wizard-field">
                              <label className="zr-wizard-label" htmlFor="zr-wizard-peer-gateway">{t('wizard.peer.gatewayUrl')}</label>
                              <input
                                id="zr-wizard-peer-gateway"
                                className="zr-wizard-input"
                                type="text"
                                autoComplete="off"
                                spellCheck={false}
                                placeholder={t('wizard.peer.gatewayUrlPlaceholder')}
                                value={peerGatewayUrl}
                                disabled={peerBusy}
                                onChange={(event) => {
                                  setPeerGatewayUrl(event.target.value)
                                  setPeerCandidateNetworks([])
                                  setPeerSelectedNetId('')
                                  if (peerFail !== null) setPeerFail(null)
                                }}
                              />
                              <p className="zr-wizard-hint">{t('wizard.peer.gatewayUrlHint')}</p>
                            </div>
                            {peerCandidateNetworks.length > 1 ? (
                              <div className="zr-wizard-field">
                                <label className="zr-wizard-label" htmlFor="zr-wizard-peer-network">{t('wizard.peer.selectNetwork')}</label>
                                <select
                                  id="zr-wizard-peer-network"
                                  className="zr-wizard-select"
                                  disabled={peerBusy}
                                  value={peerSelectedNetId}
                                  onChange={(event) => setPeerSelectedNetId(event.currentTarget.value)}
                                >
                                  {peerCandidateNetworks.map((net) => (
                                    <option key={net.id} value={net.id}>
                                      {net.name} ({net.id})
                                    </option>
                                  ))}
                                </select>
                                <p className="zr-wizard-hint">{t('wizard.peer.selectNetworkHint')}</p>
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                      {peerFail !== null ? (
                        <p className="zr-wizard-notice" data-tone="error">{peerJoinFailCopy(peerFail, t)}</p>
                      ) : null}
                    </>
                  ) : (
                    <>
                      {/* MS-8: the pool cap is stated on EVERY entry into a
                          new pairing, and a full pool shouts in red. */}
                      <p className="zr-wizard-notice">
                        {t('wizard.client.poolCapNote', { count: serverRows.length, max: poolSummary.maxServers })}
                      </p>
                      {poolSummary.limitReached ? (
                        <p className="zr-wizard-notice" data-tone="error">
                          {t('wizard.overview.limitNote', { max: poolSummary.maxServers })}
                        </p>
                      ) : null}
                      <div className="zr-wizard-formStack">
                        <div className="zr-wizard-field">
                          <label className="zr-wizard-label" htmlFor="zr-wizard-client-device">{t('wizard.client.deviceName')}</label>
                          <input
                            id="zr-wizard-client-device"
                            className="zr-wizard-input"
                            type="text"
                            placeholder={t('wizard.client.deviceNamePlaceholder')}
                            value={clientDeviceName}
                            disabled={clientClaimBusy}
                            onChange={(event) => setClientDeviceName(event.target.value)}
                          />
                          <p className="zr-wizard-hint">{t('wizard.client.deviceNameHint')}</p>
                        </div>

                        <div className="zr-wizard-field">
                          <label className="zr-wizard-label" htmlFor="zr-wizard-client-url">{t('wizard.client.serverUrl')}</label>
                          <input
                            id="zr-wizard-client-url"
                            className="zr-wizard-input"
                            type="url"
                            placeholder={t('wizard.client.serverUrlPlaceholder')}
                            value={clientServerUrl}
                            disabled={clientClaimBusy}
                            onChange={(event) => setClientServerUrl(event.target.value)}
                          />
                          <p className="zr-wizard-hint">{t('wizard.client.serverUrlHint')}</p>
                        </div>

                        <div className="zr-wizard-field">
                          <label className="zr-wizard-label" htmlFor="zr-wizard-client-code">{t('wizard.client.pairingCode')}</label>
                          <input
                            id="zr-wizard-client-code"
                            className="zr-wizard-input"
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={t('wizard.client.pairingCodePlaceholder')}
                            value={clientPairCode}
                            disabled={clientClaimBusy}
                            onChange={(event) => setClientPairCode(normalizePairingCode(event.target.value))}
                          />
                          <p className="zr-wizard-hint">{t('wizard.client.pairingCodeHint')}</p>
                        </div>
                      </div>

                      {formError === 'bad-client-url' ? (
                        <p className="zr-wizard-notice" data-tone="error">{t('settings.client.failInvalid')}</p>
                      ) : null}
                      {formError === 'bad-client-code' ? (
                        <p className="zr-wizard-notice" data-tone="error">{t('settings.client.failBadCode')}</p>
                      ) : null}
                      {clientClaimFail !== null ? (
                        <p className="zr-wizard-notice" data-tone="error">{claimFailCopy(clientClaimFail.code, clientClaimFail.retryAfterMs, t)}</p>
                      ) : null}
                    </>
                  )}
                </div>

                <div className="zr-wizard-modalFooter">
                  <button
                    type="button"
                    className="zr-wizard-btn"
                    disabled={disabled || savingConfig || clientClaimBusy || peerBusy}
                    onClick={() => {
                      setFormError(null)
                      setStep('pick')
                    }}
                  >
                    {t('wizard.back')}
                  </button>
                  {wizardRole === 'host' ? (
                    <button
                      type="button"
                      className="zr-wizard-btn zr-wizard-btnPrimary"
                      disabled={disabled || savingConfig}
                      onClick={() => { void advanceFromConfigure() }}
                    >
                      {t('wizard.modal.saveAndNext')}
                    </button>
                  ) : wizardRole === 'peer' ? (
                    <button
                      type="button"
                      className="zr-wizard-btn zr-wizard-btnPrimary"
                      disabled={peerBusy}
                      onClick={() => { void runPeerJoin() }}
                    >
                      {peerBusy ? t('wizard.peer.joining') : peerJoinMode === 'gateway' ? t('wizard.peer.requestJoin') : t('wizard.peer.join')}
                    </button>
                  ) : (
                    <div className="zr-wizard-row">
                      {roleSnapshot.deviceToken.configured ? (
                        <button type="button" className="zr-wizard-btn" disabled={clientClaimBusy} onClick={() => setStep('verify')}>
                          {t('wizard.client.skipToStatus')}
                        </button>
                      ) : null}
                      {/* MS-8: at a full pool only an already-paired address
                          may pass — the gate lifts the moment the typed URL
                          names one (覆盖重配), so a revoked token at 8/8 can
                          still re-pair its own server. */}
                      <button
                        type="button"
                        className="zr-wizard-btn zr-wizard-btnPrimary"
                        disabled={clientClaimBusy || claimGate.blockedByLimit}
                        onClick={() => { void runClientClaim() }}
                      >
                        {clientClaimBusy ? t('wizard.client.pairingBusy') : t('wizard.client.pairAndConnect')}
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : null}

            {step === 'verify' ? (
              <>
                <div className="zr-wizard-modalBody">
                  <p className="zr-wizard-stepIntro">{t('wizard.modal.step3Desc')}</p>
                  {wizardRole === 'peer' ? (
                    /* PG-9: the peer branch's three-light self-check — the
                        identity, the admission state and device discovery,
                        all read off the polled peer status. */
                    <>
                      <div className="zr-wizard-serviceInfo">
                        <span className="zr-wizard-dot" data-state={peerLights.admission} />
                        <span className="zr-wizard-lightName">{peerView?.configured === true ? peerStateCopy(peerView.gatewayState, t) : t('wizard.peer.notJoined')}</span>
                        <span className="zr-wizard-hint">{peerView?.configured === true && peerView.networkId !== undefined ? peerView.networkId : ''}</span>
                      </div>
                      <ul className="zr-wizard-lights">
                        {PEER_LIGHT_ORDER.map(({ key, light }) => {
                          const state = peerLights[light]
                          // The admission light's amber reads 「等待网络管理
                          // 员批准」 instead of the generic 待验证 when the
                          // gateway said pending.
                          const labelText = light === 'admission' && peerView?.gatewayState === 'pending-approval'
                            ? t('wizard.peer.pendingApproval')
                            : light === 'discovery' && peerSummary.totalCount === 0 && peerView?.gatewayState === 'authorized'
                              ? t('wizard.overview.peerConnNone')
                              : t(LIGHT_LABEL[state])
                          return (
                            <li key={key} className="zr-wizard-light" data-state={state}>
                              <div className="zr-wizard-lightMain">
                                <span className="zr-wizard-dot" data-state={state} />
                                <span className="zr-wizard-lightName">{t(key)}</span>
                              </div>
                              <span className="zr-wizard-lightState" data-state={state}>{labelText}</span>
                            </li>
                          )
                        })}
                      </ul>
                      {peerNotice === 'trustOk' ? (
                        <p className="zr-wizard-notice" data-tone="ok">{t('wizard.peer.trustOk')}</p>
                      ) : null}
                      {peerActionFailed ? (
                        <p className="zr-wizard-notice" data-tone="error">{t('wizard.peer.actionFailed')}</p>
                      ) : null}
                    </>
                  ) : wizardRole === 'host' ? (
                    <>
                      {caddyPath ? (
                        <div className="zr-wizard-serviceBar" data-zen-remote="wizard-caddy-controls">
                          <div className="zr-wizard-serviceInfo">
                            <span className="zr-wizard-dot" data-state={caddyState === 'running' ? 'pass' : 'pending'} />
                            <span className="zr-wizard-label">{t('wizard.ingress')}</span>
                            <span className="zr-wizard-hint">
                              {caddyBusy
                                ? t('wizard.caddy.starting')
                                : t(caddyState === 'running' ? 'wizard.caddy.running' : caddyState === 'stopped' ? 'wizard.caddy.stopped' : 'wizard.caddy.neverStarted')}
                            </span>
                          </div>
                          <div className="zr-wizard-row">
                            <button type="button" className="zr-wizard-btn zr-wizard-btnPrimary" disabled={disabled || caddyBusy || caddyState === 'running'} onClick={() => { void startCaddy() }}>
                              {caddyBusy ? t('wizard.caddy.starting') : t('wizard.caddy.start')}
                            </button>
                            <button type="button" className="zr-wizard-btn" disabled={disabled || caddyBusy || caddyState !== 'running'} onClick={() => { void stopCaddy() }}>
                              {t('wizard.caddy.stop')}
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {tunnelPath ? (
                        <div className="zr-wizard-serviceBar" data-zen-remote="wizard-tunnel-controls">
                          <div className="zr-wizard-serviceInfo">
                            <span className="zr-wizard-dot" data-state={tunnelState === 'running' ? 'pass' : 'pending'} />
                            <span className="zr-wizard-label">{t('wizard.ingress')}</span>
                            <span className="zr-wizard-hint">
                              {t(tunnelState === 'running' ? 'wizard.tunnel.running' : tunnelState === 'stopped' ? 'wizard.tunnel.stopped' : 'wizard.tunnel.neverStarted')}
                            </span>
                          </div>
                          <div className="zr-wizard-row">
                            <button type="button" className="zr-wizard-btn zr-wizard-btnPrimary" disabled={disabled || tunnelBusy} onClick={() => { void setupTunnelNow(adoptTunnelId) }}>
                              {tunnelBusy ? t('wizard.tunnel.checking') : tunnelState === 'running' ? t('wizard.reverify') : t('wizard.tunnel.setup')}
                            </button>
                            <button type="button" className="zr-wizard-btn" disabled={disabled || tunnelState !== 'running'} onClick={() => { void (async () => {
                              try {
                                await fetch(WIZARD_TUNNEL_STOP_ROUTE, { method: 'POST' })
                                setTunnelState('stopped')
                              } catch { /* the poll corrects */ }
                            })() }}>{t('wizard.tunnel.stop')}</button>
                          </div>
                        </div>
                      ) : null}
                      {tunnelPath && tunnelCheck !== undefined ? (() => {
                        const copy = tunnelCheckCopy(tunnelCheck)
                        return <p className="zr-wizard-notice" data-tone={copy.tone === 'error' ? 'error' : undefined}>
                          {copy.key === 'wizard.check.failed'
                            ? t('wizard.check.failed', { reason: tunnelCheck.ok ? '' : String(tunnelCheck.reason) })
                            : t(copy.key as Parameters<typeof t>[0])}
                        </p>
                      })() : null}
                      {tunnelPath && tunnelResult !== undefined && !tunnelResult.ok && tunnelResult.reason === 'tunnel-conflict' && tunnelResult.existing !== undefined ? (
                        <div className="zr-wizard-field">
                          <p className="zr-wizard-label">{t('wizard.tunnel.conflict')}</p>
                          <div className="zr-wizard-row">
                            {tunnelResult.existing.map((tunnel) => (
                              <button key={tunnel.id} type="button" className="zr-wizard-linkBtn" disabled={disabled || tunnelBusy}
                                onClick={() => { setAdoptTunnelId(tunnel.id); void setupTunnelNow(tunnel.id) }}>
                                {t('wizard.tunnel.useExisting')}: {tunnel.name} ({tunnel.status})
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {tunnelPath && tunnelResult !== undefined && tunnelResult.ok ? <p className="zr-wizard-notice">{t('wizard.tunnel.ok')}</p> : null}
                      {tunnelPath && tunnelResult !== undefined && !tunnelResult.ok && tunnelResult.reason !== 'tunnel-conflict' ? (() => {
                        const copy = tunnelFailureCopy(tunnelResult.reason, tunnelResult.detail)
                        return <p className="zr-wizard-notice" data-tone="error">{t(copy.key as Parameters<typeof t>[0], copy.params)}</p>
                      })() : null}
                      {caddyPath && caddyStartError !== undefined ? (
                        <p className="zr-wizard-notice" data-tone="error">
                          {t('wizard.caddy.startFailed', { reason: t(caddyStartError.key as Parameters<typeof t>[0], caddyStartError.params) })}
                          {caddyStartError.installUrl !== undefined ? (
                            <> <a className="zr-wizard-link" href={caddyStartError.installUrl} target="_blank" rel="noreferrer">{caddyStartError.installUrl}</a></>
                          ) : null}
                        </p>
                      ) : null}

                      <ul className="zr-wizard-lights">
                        {LIGHT_ORDER.map(({ key, light }) => {
                          const state = lights[light]
                          const labelText = light === 'publicUrl' && probingUrl
                            ? t('wizard.light.probing')
                            : t(LIGHT_LABEL[state])
                          return (
                            <li key={key} className="zr-wizard-light" data-state={state}>
                              <div className="zr-wizard-lightMain">
                                <span className="zr-wizard-dot" data-state={state} />
                                <span className="zr-wizard-lightName">{t(key)}</span>
                              </div>
                              <span className="zr-wizard-lightState" data-state={state}>{labelText}</span>
                            </li>
                          )
                        })}
                      </ul>

                      {startResult !== undefined && !startResult.ok ? (() => {
                        const copy = startFailureCopy(startResult)
                        return <p className="zr-wizard-notice" data-tone="error">{t('wizard.startFailed', { reason: t(copy.key, copy.params) })}</p>
                      })() : null}

                      <div className="zr-wizard-targetTabs" role="tablist">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={pairTarget === 'web'}
                          className="zr-wizard-targetTab"
                          data-selected={pairTarget === 'web'}
                          disabled={disabled}
                          onClick={() => setPairTarget('web')}
                        >
                          {t('wizard.pairTarget.web')}
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={pairTarget === 'desktop-client'}
                          className="zr-wizard-targetTab"
                          data-selected={pairTarget === 'desktop-client'}
                          disabled={disabled}
                          onClick={() => setPairTarget('desktop-client')}
                        >
                          {t('wizard.pairTarget.desktop')}
                        </button>
                      </div>

                      {pairTarget === 'web' ? (
                        <>
                          {webPairRequested && startResult?.ok === true && startResult.pairingCode !== '' ? (
                            <div className="zr-wizard-pairPanel">
                              <svg
                                className="zr-wizard-qr"
                                data-usable={qr !== null}
                                role="img"
                                aria-label={t('wizard.qrHint')}
                                shapeRendering="crispEdges"
                                viewBox={qr === null ? undefined : `-16 -16 ${(qr.length + 8) * 4} ${(qr.length + 8) * 4}`}
                              >
                                {qr === null ? null : (
                                  <>
                                    <rect x={-16} y={-16} width={(qr.length + 8) * 4} height={(qr.length + 8) * 4} fill="#fff" />
                                    <path d={qrSvgPath(qr, 4)} fill="#000" />
                                  </>
                                )}
                              </svg>
                              <div className="zr-wizard-pairMeta">
                                <span className="zr-wizard-label">{t('wizard.pairingCode')}</span>
                                <p className="zr-wizard-code">{startResult.pairingCode}</p>
                                <p className="zr-wizard-countdown">{t('wizard.pairingSeconds', { seconds: String(pairingSecondsLeft(startResult.expiresAt, now)) })}</p>
                                <p className="zr-wizard-hint">{t('wizard.qrHint')}</p>
                              </div>
                            </div>
                          ) : null}

                          {poll?.result === 'pass' ? <p className="zr-wizard-notice" data-tone="ok">{t('wizard.verifyPass', { deviceId: poll.deviceId })}</p> : null}
                          {poll?.result === 'cookie-insecure' ? <p className="zr-wizard-notice" data-tone="error">{t('wizard.verifyCookieInsecure')}</p> : null}
                          {poll?.result === 'code-expired' ? <p className="zr-wizard-notice" data-tone="error">{t('wizard.verifyExpired')}</p> : null}
                          {poll?.result === 'stale' ? <p className="zr-wizard-notice" data-tone="error">{t('wizard.verifyStale')}</p> : null}
                          {webPairRequested && (poll?.result === 'pending' || poll?.result === 'not-started') ? <p className="zr-wizard-hint">{t('wizard.verifyPending')}</p> : null}
                          {!webPairRequested && poll === undefined ? <p className="zr-wizard-hint">{t('wizard.verifyNotStarted')}</p> : null}
                        </>
                      ) : (
                        <div className="zr-wizard-desktopBox">
                          <p className="zr-wizard-hint">{t('wizard.desktop.guide')}</p>
                          <div className="zr-wizard-field">
                            <span className="zr-wizard-label">{t('wizard.desktop.addressLabel')}</span>
                            <code className="zr-wizard-input">{resolvedHostEndpoint}</code>
                          </div>
                          {desktopPairing !== undefined && desktopPairing.expiresAt > now ? (
                            <div className="zr-wizard-pairMeta">
                              <span className="zr-wizard-label">{t('wizard.pairingCode')}</span>
                              <p className="zr-wizard-code">{desktopPairing.code}</p>
                              <p className="zr-wizard-countdown">
                                {t('wizard.pairingSeconds', { seconds: String(pairingSecondsLeft(desktopPairing.expiresAt, now)) })}
                              </p>
                            </div>
                          ) : null}
                          <div className="zr-wizard-row">
                            <button
                              type="button"
                              className="zr-wizard-btn zr-wizard-btnPrimary"
                              disabled={disabled || desktopPairBusy}
                              onClick={() => { void runDesktopPair() }}
                            >
                              {desktopPairing !== undefined && desktopPairing.expiresAt > now ? t('wizard.desktop.regenerate') : t('wizard.desktop.generate')}
                            </button>
                            {desktopPairing !== undefined && desktopPairing.expiresAt > now ? (
                              <button
                                type="button"
                                className="zr-wizard-btn"
                                disabled={disabled}
                                onClick={() => { void copyDesktopInfo() }}
                              >
                                {desktopCopied ? t('wizard.card.copied') : t('wizard.desktop.copyInfo')}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {/* MS-8: with more than one paired server the step
                          switches between them; the selection defaults to the
                          entry the last pairing (or the management modal)
                          touched. */}
                      {serverRows.length > 1 ? (
                        <div className="zr-wizard-targetTabs" role="tablist" aria-label={t('wizard.client.serverPicker')}>
                          {serverRows.map((server) => {
                            const selected = activeServer?.entryId === server.entryId
                            return (
                              <button
                                key={server.entryId}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                className="zr-wizard-targetTab"
                                data-selected={selected}
                                onClick={() => setActiveClientEntryId(server.entryId)}
                              >
                                {server.displayName !== '' ? server.displayName : server.serverUrl}
                              </button>
                            )
                          })}
                        </div>
                      ) : null}

                      {activeServer !== undefined ? (
                        <div className="zr-wizard-serviceInfo">
                          <span className="zr-wizard-dot" data-state={serverDotState(activeServer.state)} />
                          <span className="zr-wizard-lightName">{activeServer.displayName !== '' ? activeServer.displayName : activeServer.serverUrl}</span>
                          <span className="zr-wizard-hint">{activeServer.serverUrl}</span>
                        </div>
                      ) : null}

                      <ul className="zr-wizard-lights">
                        {CLIENT_LIGHT_ORDER.map(({ key, light }) => (
                          <li key={key} className="zr-wizard-light" data-state={serverLights[light]}>
                            <div className="zr-wizard-lightMain">
                              <span className="zr-wizard-dot" data-state={serverLights[light]} />
                              <span className="zr-wizard-lightName">{t(key)}</span>
                            </div>
                            <span className="zr-wizard-lightState" data-state={serverLights[light]}>{t(LIGHT_LABEL[serverLights[light]])}</span>
                          </li>
                        ))}
                      </ul>

                      {activeServer !== undefined ? (
                        <div className="zr-wizard-row">
                          {activeServer.nextRetryAt !== undefined ? (
                            <button
                              type="button"
                              className="zr-wizard-btn zr-wizard-btnPrimary"
                              disabled={serverBusyEntry !== null}
                              onClick={() => { void runServerAction(CLIENT_RECONNECT_ROUTE, activeServer.entryId, { entryId: activeServer.entryId }) }}
                            >
                              {serverBusyEntry === activeServer.entryId ? t('settings.client.reconnectBusy') : t('settings.client.reconnect')}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="zr-wizard-btn"
                            disabled={serverBusyEntry !== null}
                            onClick={() => {
                              if (!window.confirm(t('settings.client.unpairServerConfirm'))) return
                              const entryId = activeServer.entryId
                              void runServerAction(CLIENT_UNPAIR_ROUTE, entryId, { entryId }).then(() => {
                                setActiveClientEntryId((current) => (current === entryId ? undefined : current))
                              })
                            }}
                          >
                            {t('settings.client.serverRemove')}
                          </button>
                        </div>
                      ) : null}

                      {/* Legacy row-token fallback: a pre-pool pairing kept
                          its token in the row — unpairing it stays possible
                          even with no pool rows on screen. */}
                      {serverRows.length === 0 && roleSnapshot.deviceToken.configured ? (
                        <div className="zr-wizard-row">
                          <button
                            type="button"
                            className="zr-wizard-btn"
                            disabled={clientUnpairBusy}
                            onClick={() => { void runClientUnpair() }}
                          >
                            {clientUnpairBusy ? t('settings.client.unpairBusy') : t('settings.client.unpair')}
                          </button>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>

                <div className="zr-wizard-modalFooter">
                  <button
                    type="button"
                    className="zr-wizard-btn"
                    disabled={disabled}
                    onClick={() => setStep('configure')}
                  >
                    {t('wizard.back')}
                  </button>
                  <div className="zr-wizard-row">
                    {wizardRole === 'host' && resolvedVerifyUrl !== '' ? (
                      <button
                        type="button"
                        className="zr-wizard-btn"
                        disabled={disabled || probingUrl}
                        onClick={() => { void probeAccessUrl(resolvedVerifyUrl) }}
                      >
                        {probingUrl ? t('wizard.light.probing') : t('wizard.devicesModal.retest')}
                      </button>
                    ) : null}
                    {wizardRole === 'host' && pairTarget === 'web' ? (
                      <button
                        type="button"
                        className="zr-wizard-btn zr-wizard-btnPrimary"
                        disabled={disabled || probingUrl}
                        onClick={() => { void startVerification() }}
                      >
                        {verified ? t('wizard.reverify') : t('wizard.startVerify')}
                      </button>
                    ) : null}
                    {wizardRole === 'host' && pairTarget === 'desktop-client' ? (
                      <button
                        type="button"
                        className="zr-wizard-btn zr-wizard-btnPrimary"
                        disabled={disabled || desktopPairBusy}
                        onClick={() => { void runDesktopPair() }}
                      >
                        {desktopPairing !== undefined && desktopPairing.expiresAt > now ? t('wizard.desktop.regenerate') : t('wizard.desktop.generate')}
                      </button>
                    ) : null}
                    {/* PG-9: the peer branch's reprobe — the punch rounds
                        report through the status poll. */}
                    {wizardRole === 'peer' && peerView?.configured === true ? (
                      <>
                        <button
                          type="button"
                          className="zr-wizard-btn zr-wizard-btnPrimary"
                          disabled={peerBusyNode !== null}
                          onClick={() => { void runPeerNodeAction(CLIENT_PEER_REPROBE_ROUTE, '', {}) }}
                        >
                          {t('wizard.devicesModal.retest')}
                        </button>
                        <button
                          type="button"
                          className="zr-wizard-btn"
                          disabled={peerBusyNode !== null}
                          onClick={() => {
                            if (!window.confirm(t('wizard.peer.leaveConfirm'))) return
                            void runPeerLeave().then(() => setModalOpen(false))
                          }}
                        >
                          {t('wizard.peer.leave')}
                        </button>
                      </>
                    ) : null}
                    {/* MS-8: keep adding servers without leaving the wizard —
                        until the pool is full. */}
                    {wizardRole === 'client' && !poolSummary.limitReached ? (
                      <button
                        type="button"
                        className="zr-wizard-btn zr-wizard-btnPrimary"
                        onClick={openAddServerWizard}
                      >
                        {t('wizard.client.continueAdd')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="zr-wizard-btn"
                      onClick={() => setModalOpen(false)}
                    >
                      {t('wizard.modal.finish')}
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {devicesModalOpen ? (
        <div
          data-zen-remote="wizard-modal"
          onClick={() => {
            if (!deviceBusy) setDevicesModalOpen(false)
          }}
        >
          <div
            className="zr-wizard-modalDialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('wizard.devicesModal.title')}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="zr-wizard-modalHeader">
              <div className="zr-wizard-headerText">
                <p className="zr-wizard-modalTitle">{t('wizard.devicesModal.title')}</p>
                <p className="zr-wizard-subtitle">{t('wizard.devicesModal.subtitle')}</p>
              </div>
              <button
                type="button"
                className="zr-wizard-cardCloseIcon"
                aria-label={t('wizard.card.close')}
                disabled={deviceBusy}
                onClick={() => setDevicesModalOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="zr-wizard-modalBody">
              {deviceError ? (
                <p className="zr-wizard-notice" data-tone="error">{t('settings.actionFail')}</p>
              ) : null}

              {allDevices.length === 0 ? (
                <p className="zr-wizard-notice">{t('settings.devicesEmpty')}</p>
              ) : (
                <ul className="zr-wizard-deviceList">
                  {allDevices.map((device) => (
                    <li key={device.id} className="zr-wizard-deviceItem">
                      <div className="zr-wizard-deviceHead">
                        <div className="zr-wizard-deviceTitleRow">
                          <span className="zr-wizard-lightName">{device.name}</span>
                          <span className="zr-wizard-deviceBadge">
                            {device.role === 'web' ? t('settings.deviceRoleWeb') : t('settings.deviceRoleDesktop')}
                          </span>
                          {device.role === 'web' ? (
                            <span className="zr-wizard-deviceBadge">
                              {device.hasPush ? t('settings.devicePushOn') : t('settings.devicePushOff')}
                            </span>
                          ) : null}
                        </div>
                        <span className="zr-wizard-hint">
                          {t('settings.deviceLastSeen', { time: new Date(device.lastSeen).toLocaleString() })}
                        </span>
                      </div>

                      <div className="zr-wizard-deviceActions">
                        {device.role === 'web' ? (
                          <select
                            className="zr-wizard-select"
                            aria-label={t('settings.deviceKindSelect', { name: device.name })}
                            disabled={disabled || deviceBusy}
                            value={device.kind}
                            onChange={(event) => {
                              void runDeviceAction({ action: 'set-kind', id: device.id, kind: event.currentTarget.value })
                            }}
                          >
                            <option value="auto">{t('settings.kindAuto')}</option>
                            <option value="phone">{t('settings.kindPhone')}</option>
                            <option value="desktop">{t('settings.kindDesktop')}</option>
                          </select>
                        ) : null}
                        <button
                          type="button"
                          className="zr-wizard-linkBtn"
                          disabled={disabled || deviceBusy}
                          onClick={() => setRenamingDevice({ id: device.id, draft: device.name })}
                        >
                          {t('settings.deviceRename')}
                        </button>
                        <button
                          type="button"
                          className="zr-wizard-linkBtn"
                          disabled={disabled || deviceBusy}
                          onClick={() => {
                            if (window.confirm(t('settings.revokeConfirm'))) {
                              void runDeviceAction({ action: 'revoke', id: device.id })
                            }
                          }}
                        >
                          {t('settings.deviceRevoke')}
                        </button>
                      </div>

                      {renamingDevice?.id === device.id ? (
                        <div className="zr-wizard-row">
                          <input
                            className="zr-wizard-input"
                            style={{ flex: 1, minWidth: 160 }}
                            aria-label={t('settings.renamePrompt')}
                            maxLength={40}
                            value={renamingDevice.draft}
                            autoFocus
                            onChange={(event) => setRenamingDevice({ id: device.id, draft: event.currentTarget.value })}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                const trimmed = renamingDevice.draft.trim()
                                setRenamingDevice(null)
                                if (trimmed !== '' && trimmed !== device.name) {
                                  void runDeviceAction({ action: 'rename', id: device.id, name: trimmed })
                                }
                              }
                              if (event.key === 'Escape') setRenamingDevice(null)
                            }}
                          />
                          <button
                            type="button"
                            className="zr-wizard-btn zr-wizard-btnPrimary"
                            disabled={deviceBusy}
                            onClick={() => {
                              const trimmed = renamingDevice.draft.trim()
                              setRenamingDevice(null)
                              if (trimmed !== '' && trimmed !== device.name) {
                                void runDeviceAction({ action: 'rename', id: device.id, name: trimmed })
                              }
                            }}
                          >
                            {t('settings.renameSave')}
                          </button>
                          <button
                            type="button"
                            className="zr-wizard-btn"
                            disabled={deviceBusy}
                            onClick={() => setRenamingDevice(null)}
                          >
                            {t('settings.renameCancel')}
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="zr-wizard-modalFooter">
              <div className="zr-wizard-row">
                {allDevices.length > 0 ? (
                  <button
                    type="button"
                    className="zr-wizard-btn"
                    disabled={disabled || deviceBusy}
                    onClick={() => {
                      if (window.confirm(t('settings.revokeAllConfirm'))) {
                        void runDeviceAction({ action: 'revoke-all' })
                      }
                    }}
                  >
                    {t('settings.revokeAll')}
                  </button>
                ) : null}
              </div>
              <div className="zr-wizard-row">
                <button
                  type="button"
                  className="zr-wizard-btn"
                  disabled={disabled || deviceBusy}
                  onClick={() => {
                    setDevicesModalOpen(false)
                    openWizardAt('verify', { role: 'host', target: 'desktop-client' })
                  }}
                >
                  {t('wizard.overview.pairDesktop')}
                </button>
                <button
                  type="button"
                  className="zr-wizard-btn zr-wizard-btnPrimary"
                  disabled={disabled || deviceBusy}
                  onClick={() => {
                    setDevicesModalOpen(false)
                    openWizardAt('verify', { role: 'host', target: 'web' })
                  }}
                >
                  {t('wizard.overview.pairPhone')}
                </button>
                <button
                  type="button"
                  className="zr-wizard-btn"
                  disabled={deviceBusy}
                  onClick={() => setDevicesModalOpen(false)}
                >
                  {t('wizard.card.close')}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {serversModalOpen ? (
        <div
          data-zen-remote="wizard-modal"
          onClick={() => {
            if (serverBusyEntry === null) setServersModalOpen(false)
          }}
        >
          <div
            className="zr-wizard-modalDialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('wizard.serversModal.title')}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="zr-wizard-modalHeader">
              <div className="zr-wizard-headerText">
                <p className="zr-wizard-modalTitle">{t('wizard.serversModal.title')}</p>
                <p className="zr-wizard-subtitle" data-limit={poolSummary.limitReached ? 'true' : undefined}>
                  {t('wizard.serversModal.subtitle', { count: serverRows.length, max: poolSummary.maxServers })}
                </p>
              </div>
              <button
                type="button"
                className="zr-wizard-cardCloseIcon"
                aria-label={t('wizard.card.close')}
                disabled={serverBusyEntry !== null}
                onClick={() => setServersModalOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="zr-wizard-modalBody">
              {/* MS-8: a full pool shouts here too — this is the surface a
                  user at 8/8 lands on when they try to add one more. */}
              {poolSummary.limitReached ? (
                <p className="zr-wizard-notice" data-tone="error">
                  {t('wizard.overview.limitNote', { max: poolSummary.maxServers })}
                </p>
              ) : null}
              {serverActionFailed ? (
                <p className="zr-wizard-notice" data-tone="error">{t('settings.actionFail')}</p>
              ) : null}

              {serverRows.length === 0 ? (
                <p className="zr-wizard-notice">{t('settings.client.serversEmpty', { max: poolSummary.maxServers })}</p>
              ) : (
                <ul className="zr-wizard-deviceList">
                  {serverRows.map((server) => {
                    const badge = serverBadgeCopy(server, now, t)
                    const name = server.displayName !== '' ? server.displayName : server.serverUrl
                    return (
                      <li key={server.entryId} className="zr-wizard-deviceItem">
                        <div className="zr-wizard-deviceHead">
                          <div className="zr-wizard-deviceTitleRow">
                            <span className="zr-wizard-dot" data-state={serverDotState(server.state)} />
                            <span className="zr-wizard-lightName">{name}</span>
                            <span className="zr-wizard-deviceBadge" data-tone={badge.tone}>
                              {badge.text}
                            </span>
                          </div>
                          <span className="zr-wizard-hint">{server.serverUrl}</span>
                        </div>

                        <div className="zr-wizard-deviceActions">
                          <button
                            type="button"
                            className="zr-wizard-linkBtn"
                            disabled={serverBusyEntry !== null}
                            onClick={() => {
                              setServersModalOpen(false)
                              setActiveClientEntryId(server.entryId)
                              openWizardAt('verify', { role: 'client' })
                            }}
                          >
                            {t('wizard.serversModal.viewStatus')}
                          </button>
                          {server.nextRetryAt !== undefined ? (
                            <button
                              type="button"
                              className="zr-wizard-linkBtn"
                              disabled={serverBusyEntry !== null}
                              onClick={() => { void runServerAction(CLIENT_RECONNECT_ROUTE, server.entryId, { entryId: server.entryId }) }}
                            >
                              {serverBusyEntry === server.entryId ? t('settings.client.reconnectBusy') : t('settings.client.reconnect')}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="zr-wizard-linkBtn"
                            disabled={serverBusyEntry !== null}
                            onClick={() => {
                              // 覆盖重配 pre-fills the entry's own address, so
                              // it stays usable at a FULL pool (an already-paired
                              // address never trips the cap).
                              setServersModalOpen(false)
                              setClientServerUrl(server.serverUrl)
                              setClientPairCode('')
                              setClientClaimFail(null)
                              openWizardAt('configure', { role: 'client' })
                            }}
                          >
                            {t('settings.client.repair')}
                          </button>
                          <button
                            type="button"
                            className="zr-wizard-linkBtn"
                            disabled={serverBusyEntry !== null}
                            onClick={() => {
                              if (!window.confirm(t('settings.client.unpairServerConfirm'))) return
                              const entryId = server.entryId
                              void runServerAction(CLIENT_UNPAIR_ROUTE, entryId, { entryId }).then(() => {
                                setActiveClientEntryId((current) => (current === entryId ? undefined : current))
                              })
                            }}
                          >
                            {t('settings.client.serverRemove')}
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <div className="zr-wizard-modalFooter">
              <div className="zr-wizard-row">
                {serverRows.length > 0 ? (
                  <button
                    type="button"
                    className="zr-wizard-btn"
                    disabled={serverBusyEntry !== null}
                    onClick={() => {
                      if (window.confirm(t('settings.client.unpairAllServersConfirm'))) {
                        void runServerAction(CLIENT_UNPAIR_ROUTE, 'all', { all: true }).then(() => {
                          setActiveClientEntryId(undefined)
                        })
                      }
                    }}
                  >
                    {t('settings.client.unpairAllServers')}
                  </button>
                ) : null}
              </div>
              <div className="zr-wizard-row">
                <button
                  type="button"
                  className="zr-wizard-btn zr-wizard-btnPrimary"
                  disabled={poolSummary.limitReached || serverBusyEntry !== null}
                  onClick={() => {
                    setServersModalOpen(false)
                    openAddServerWizard()
                  }}
                >
                  {t('wizard.overview.addServer')}
                </button>
                <button
                  type="button"
                  className="zr-wizard-btn"
                  disabled={serverBusyEntry !== null}
                  onClick={() => setServersModalOpen(false)}
                >
                  {t('wizard.card.close')}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {peerDevicesModalOpen ? (
        <div
          data-zen-remote="wizard-modal"
          onClick={() => {
            if (peerBusyNode === null) setPeerDevicesModalOpen(false)
          }}
        >
          <div
            className="zr-wizard-modalDialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('wizard.peer.devicesModalTitle')}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="zr-wizard-modalHeader">
              <div className="zr-wizard-headerText">
                <p className="zr-wizard-modalTitle">{t('wizard.peer.devicesModalTitle')}</p>
                <p className="zr-wizard-subtitle" data-limit={peerSummary.limitReached ? 'true' : undefined}>
                  {t('wizard.peer.devicesModalSubtitle')}
                </p>
              </div>
              <button
                type="button"
                className="zr-wizard-cardCloseIcon"
                aria-label={t('wizard.card.close')}
                disabled={peerBusyNode !== null}
                onClick={() => setPeerDevicesModalOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="zr-wizard-modalBody">
              {peerSummary.limitReached ? (
                <p className="zr-wizard-notice" data-tone="error">
                  {t('wizard.overview.peerDevicesFull', { max: String(peerSummary.maxPeers) })}
                </p>
              ) : null}
              {peerActionFailed ? (
                <p className="zr-wizard-notice" data-tone="error">{t('wizard.peer.actionFailed')}</p>
              ) : null}
              {peerNotice === 'trustOk' ? (
                <p className="zr-wizard-notice" data-tone="ok">{t('wizard.peer.trustOk')}</p>
              ) : null}

              {peerDevices.length === 0 ? (
                <p className="zr-wizard-notice">{t('wizard.peer.devicesModalEmpty')}</p>
              ) : (
                <ul className="zr-wizard-deviceList">
                  {peerDevices.map((device) => {
                    const dot = peerDeviceDot(device.path)
                    return (
                      <li key={device.nodeId} className="zr-wizard-deviceItem">
                        <div className="zr-wizard-deviceHead">
                          <div className="zr-wizard-deviceTitleRow">
                            <span className="zr-wizard-dot" data-state={dot} />
                            <span className="zr-wizard-lightName">{device.name !== '' ? device.name : device.nodeId}</span>
                            <span className="zr-wizard-deviceBadge" data-tone={device.path === 'mismatch' ? 'invalid' : dot === 'pass' ? 'live' : 'warn'}>
                              {peerDevicePathCopy(device.path, t)}
                            </span>
                            {device.path !== 'mismatch' && device.path !== 'offline' && device.rttMs !== null ? (
                              <span className="zr-wizard-deviceBadge">{t('wizard.peer.deviceRtt', { ms: String(device.rttMs) })}</span>
                            ) : null}
                          </div>
                          <span className="zr-wizard-hint">{device.nodeId}</span>
                        </div>

                        {device.path === 'mismatch' ? (
                          <>
                            <p className="zr-wizard-notice" data-tone="error">{t('wizard.peer.mismatchNote')}</p>
                            <div className="zr-wizard-deviceActions">
                              <button
                                type="button"
                                className="zr-wizard-btn zr-wizard-btnPrimary"
                                disabled={peerBusyNode !== null}
                                onClick={() => { void runPeerNodeAction(CLIENT_PEER_TRUST_ROUTE, device.nodeId, { nodeId: device.nodeId }) }}
                              >
                                {t('wizard.peer.trustNew')}
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="zr-wizard-deviceActions">
                            <label className="zr-wizard-checkRow">
                              <input
                                type="checkbox"
                                checked={device.mounted}
                                disabled={peerBusyNode !== null}
                                onChange={(event) => {
                                  void runPeerNodeAction(CLIENT_PEER_TOGGLE_MOUNT_ROUTE, device.nodeId, { nodeId: device.nodeId, mounted: event.currentTarget.checked })
                                }}
                              />
                              <span>{device.mounted ? t('wizard.peer.deviceMount') : t('wizard.peer.deviceIgnore')}</span>
                            </label>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <div className="zr-wizard-modalFooter">
              <div className="zr-wizard-row">
                <button
                  type="button"
                  className="zr-wizard-btn"
                  disabled={peerBusyNode !== null}
                  onClick={() => { void runPeerNodeAction(CLIENT_PEER_REPROBE_ROUTE, 'all', {}) }}
                >
                  {t('wizard.devicesModal.retest')}
                </button>
                <button
                  type="button"
                  className="zr-wizard-btn"
                  disabled={peerBusyNode !== null}
                  onClick={() => setPeerDevicesModalOpen(false)}
                >
                  {t('wizard.card.close')}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {card === 'proxy' ? (
        <ProxyCard
          t={t}
          domain={(() => {
            if (domain.trim() !== '') return domain.trim()
            try {
              const parsed = new URL(serverUrl.trim())
              if (parsed.hostname !== '') return parsed.hostname
            } catch { /* fall back to placeholder */ }
            return 'dsh.example.com'
          })()}
          upstreamPort={upstreamPortOf(wizardStatus)}
          onCheck={() => {
            setStep('verify')
            void startVerification()
          }}
          onClose={() => setCard(undefined)}
        />
      ) : null}

      {card === 'token' ? (
        <TokenCard
          t={t}
          onUse={(token) => {
            void (async () => {
              await saveTokenValue(token)
              setCard(undefined)
            })()
          }}
          onClose={() => setCard(undefined)}
        />
      ) : null}

      {card === 'migrate' ? (
        <MigrateCard
          t={t}
          onRecheck={() => {
            setCard(undefined)
            void checkDomain()
          }}
          onClose={() => setCard(undefined)}
        />
      ) : null}

      {card === 'portforward' ? (
        <PortForwardCard t={t} port={Number(httpsPort.trim()) || 8443} onClose={() => setCard(undefined)} />
      ) : null}
    </div>
  )
}
