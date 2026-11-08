/**
 * The dsh-zen-remote plugin row's settings block on the Plugins manager
 * (T15 + T15-fix + T16 + T17): the staged row fields inside the official
 * settings-form frame ending in its one save control, and BELOW the form —
 * outside it, so they still render when the configuration namespace is not
 * served — the instant-operation areas. Which areas render follows the row's
 * SAVED role, read from the configForms snapshot's row document — never from
 * a status body (T16-fix 3); when that document carries no role at all (the
 * value lives only in `lan-gate.config.json`), the page probes the
 * lightweight client-config route (both roles register it) for the EFFECTIVE
 * role (T17). A host shows gateway status, pairing, device list and the push
 * probe (POSTing the same-origin admin routes and re-reading `admin/status`);
 * a client shows the server connection form, the connection status line and
 * unpairing (against `client/status`, T16) and NEVER polls `admin/*` — on a
 * client deployment those routes do not exist, and a stale kept body would
 * pin the page to the old role. The poll choice waits out the snapshot's
 * loading state — and the probe, when the row cannot answer — for the same
 * reason. Only field edits stage and save through `ZenRemoteSettingsForm`.
 *
 * Status refreshes never clear what is already on screen (T15-fix 1): a
 * failed refresh keeps the last ready data and says so in a banner — only a
 * failed FIRST load enters the error state, because saving a restart-required
 * field reloads the plugin row (T17) and the first post-save refresh can land
 * inside that reload window (further pulls follow at 1.5s, and for a
 * row-reloading save at 3s and 6s, T17b). Every status request carries a
 * latest-wins ticket (T15-fix 4), so an earlier request that answers late
 * cannot overwrite newer data.
 *
 * Opened through the gateway (`viaGateway`, i.e. on a phone or another
 * browser) the server-local buttons disable and a notice says so — and until
 * one status load answers from the server itself, they count as remote. The
 * summary view renders its one-liner alone and never fetches a thing.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, SettingsForm, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ADMIN_ACTION_ROUTE,
  ADMIN_PAIR_ROUTE,
  ADMIN_PLUGIN_BRIDGE_ROUTE,
  ADMIN_PUSH_TEST_ROUTE,
  ADMIN_STATUS_ROUTE,
  CLIENT_CLAIM_ROUTE,
  CLIENT_CONFIG_ROUTE,
  CLIENT_DEBUG_REPORT_ROUTE,
  CLIENT_RECONNECT_ROUTE,
  CLIENT_STATUS_ROUTE,
  CLIENT_UNPAIR_ROUTE,
  MAX_PAIRED_SERVERS,
  awaitClientStatusReady,
  canSubmitClientPairing,
  claimDeviceNameOf,
  createLatestGate,
  clientStatusLineOf,
  deriveClientStatusView,
  deriveSettingsView,
  localOpsAllowed,
  normalizePairingCode,
  shouldReloadAfterClientActivation,
} from '../../client-data/settings-form.ts'
import { bridgeSectionState, togglePluginConsent } from '../../client-data/plugin-bridge.ts'
import type { PluginBridgeStatusView } from '../../client-data/plugin-bridge.ts'
import { CURRENT_SESSION_STORAGE_KEY, parseCurrentSessionStorage } from '../../client-data/current-session.ts'
import { isRemoteSessionId } from '../../client-data/remote-drop.ts'
import type {
  AdminStatusBody,
  ClaimRouteBody,
  ClientConfigBody,
  ClientConnectionView,
  ClientServerView,
  ClientStatusBody,
  SettingsDeviceView,
  SettingsFieldState,
  SettingsFieldView,
  SettingsPairingView,
  ZenRemoteSettingsForm,
} from '../../client-data/settings-form.ts'
import { NS } from '../locales.ts'
import { remoteDropDiagnostics } from '../effects/remote-drop.ts'
import { describeShare } from '../../client-data/shares.ts'
import type { ShareEntryView, SharesStore } from '../../client-data/shares.ts'

export interface SettingsSectionProps extends PropsRuntime<'plugins.row.config'>, PropsLocale<typeof NS> {
  /** The staged configuration form (injected share). */
  config: ZenRemoteSettingsForm
  /** The shared shares store (injected share, T33b) — the same singleton the
   * title-row icon and the session menu read. */
  shares: SharesStore
}

/** Device roles the pairing picker offers, in display order. */
const PAIR_ROLES = ['web', 'desktop-client'] as const
type PairRole = (typeof PAIR_ROLES)[number]

/** Display layouts a device can be pinned to (the gateway's `kind` field). */
const DEVICE_KINDS = ['auto', 'phone', 'desktop'] as const

/** Longest device name, mirroring the gateway's rename cap. */
const DEVICE_NAME_MAX = 40

type PushTest =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'ok', sent: number, failed: number }
  | { state: 'fail' }

/** One admin-status load's outcome; `error.status` is undefined for network /
 * non-JSON failures. `stale` keeps the last ready body on screen after a
 * failed refresh (T15-fix 1). */
type Load =
  | { state: 'loading' }
  | { state: 'ready', body: AdminStatusBody }
  | { state: 'stale', body: AdminStatusBody }
  | { state: 'error', status: number | undefined }

/** One client-status load's outcome, same stale contract as {@link Load}. */
type ClientLoad =
  | { state: 'loading' }
  | { state: 'ready', view: ClientConnectionView }
  | { state: 'stale', view: ClientConnectionView }
  | { state: 'error' }

/** One pairing attempt's classified failure, rendered by code. */
interface PairFail {
  code: string
  retryAfterMs?: number
}

async function postJson(url: string, payload: Record<string, unknown>): Promise<{ ok: boolean, sent: number, failed: number }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({})) as { ok?: boolean, sent?: unknown, failed?: unknown }
    return {
      ok: res.ok && body.ok === true,
      sent: typeof body.sent === 'number' ? body.sent : 0,
      failed: typeof body.failed === 'number' ? body.failed : 0,
    }
  } catch {
    return { ok: false, sent: 0, failed: 0 }
  }
}

/** CU-4: the export's download name, `zen-remote-debug-<role>-<yyyymmdd-hhmm>.json`,
 * stamped in the browser's local time (the file is for the user's own
 * folder; the report's `_meta.generatedAt` carries the exact UTC instant). */
function debugExportFileName(role: 'host' | 'client', now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `zen-remote-debug-${role}-${stamp}.json`
}

/** CU-4: one transient notice for the export's outcome — the same inline-
 * styled overlay habit the remote-drop guard's folder toast uses (styles
 * stay inline: nothing of this goes into pwa/app.css or the style sheets),
 * one at a time, gone after 3 s, never intercepting taps. */
let debugToast: HTMLDivElement | undefined
let debugToastTimer: number | undefined
function showDebugToast(text: string): void {
  if (debugToastTimer !== undefined) window.clearTimeout(debugToastTimer)
  debugToast?.remove()
  const el = document.createElement('div')
  el.dataset.zenRemote = 'debug-export-toast'
  el.textContent = text
  el.style.cssText = [
    'position:fixed', 'left:50%', 'transform:translateX(-50%)',
    'bottom:calc(env(safe-area-inset-bottom, 0px) + 32px)',
    'z-index:2147483000',
    'background:rgba(0,0,0,.82)', 'color:#fff',
    'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'padding:10px 16px', 'border-radius:10px', 'max-width:90vw', 'text-align:center',
    'pointer-events:none',
  ].join(';')
  document.body.appendChild(el)
  debugToast = el
  debugToastTimer = window.setTimeout(() => {
    el.remove()
    if (debugToast === el) debugToast = undefined
    debugToastTimer = undefined
  }, 3000)
}

export function SettingsSection(props: SettingsSectionProps) {
  // The summary view is a one-liner only — it must not even fetch
  // admin/status, so every hook (and the fetch) lives in the page component.
  if (props.view === 'summary') {
    return (
      <div data-zen-remote="settings">
        <p className="zr-settings-summary">{props.t('settings.summary')}</p>
      </div>
    )
  }
  return <SettingsSectionPage {...props} />
}

/** Fetch error carrying the HTTP status (undefined for network / non-JSON failures). */
class StatusError extends Error {
  readonly status: number | undefined

  constructor(status: number | undefined) {
    super(status === undefined ? 'status unavailable' : `status ${status}`)
    this.name = 'StatusError'
    this.status = status
  }
}

type SectionT = SettingsSectionProps['t']

/** Copy of the client group's connection line (T43): the pure
 * {@link clientStatusLineOf} picks the case; this table only binds copy. */
function clientStatusText(view: ClientConnectionView, now: number, t: SectionT): string {
  const line = clientStatusLineOf(view, now)
  switch (line.kind) {
    case 'connectedName': return t('settings.client.statusConnectedName', { serverName: line.serverName })
    case 'connected': return t('settings.client.statusConnected', { serverUrl: line.serverUrl })
    case 'offlineRetry': return t('settings.client.statusOfflineRetry', { seconds: line.seconds })
    case 'offlineRetrySoon': return t('settings.client.statusOfflineRetrySoon')
    case 'unreachable': return t('settings.client.statusUnreachable')
    case 'revoked': return t('settings.client.statusRevoked')
    case 'incompatible': return t('settings.client.statusIncompatible')
    case 'unexpected': return t('settings.client.statusUnexpected')
    case 'invalidUrl': return t('settings.client.statusInvalidUrl')
    default: return t('settings.client.statusUnpaired')
  }
}

/** Copy of the pairing failure line, one case per claim failure code. The
 * wording is always LOCAL (this build's dictionary), never the server's
 * message — a remote message arrives in the server's language and can leak
 * its internals. */
function pairFailText(fail: PairFail, t: SectionT): string {
  switch (fail.code) {
    case 'invalid': return t('settings.client.failInvalid')
    case 'insecure-http': return t('settings.client.failInsecureHttp')
    case 'bad-code': return t('settings.client.failBadCode')
    case 'locked': {
      const minutes = Math.max(1, Math.ceil((fail.retryAfterMs ?? 0) / 60000))
      return t('settings.client.failLocked', { minutes })
    }
    case 'unreachable': return t('settings.client.failUnreachable')
    case 'role-mismatch': return t('settings.client.failRoleMismatch')
    case 'limit-reached': return t('settings.client.failLimitReached')
    default: return t('settings.client.failUnexpected')
  }
}

/** Whether one paired server has anything for the per-server diagnostics
 * group (MS-7): a last error, a compat block, or bridge verdicts. */
function serverHasDiag(server: ClientServerView): boolean {
  return server.lastError !== '' || server.compat !== undefined || server.pluginBridge.length > 0
}

/** One paired server's state badge (MS-7): copy plus the tone the badge
 * wears — `live` green for connected, `warn` for an offline row (with the
 * retry countdown when one is armed), `invalid` red for a verdict only a
 * re-pair or an upgrade fixes. */
function serverStateBadge(server: ClientServerView, now: number, t: SectionT): { text: string, tone: 'live' | 'warn' | 'invalid' | undefined } {
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

function SettingsSectionPage({ config, shares, t }: SettingsSectionProps) {
  const form = useSyncExternalStore(
    useCallback((cb: () => void) => config.subscribe(cb), [config]),
    () => config.getSnapshot(),
  )

  // Latest-wins gates (T15-fix 4): every status request takes a ticket and
  // only the newest may apply its result.
  const statusGate = useMemo(createLatestGate, [])
  const clientGate = useMemo(createLatestGate, [])

  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [clientLoad, setClientLoad] = useState<ClientLoad>({ state: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  const [pairRole, setPairRole] = useState<PairRole>('web')
  const [pairBusy, setPairBusy] = useState(false)
  const [pairFailed, setPairFailed] = useState(false)
  // The code the pair route just minted, shown before the status refresh
  // lands (and dropped once it does — the refreshed status carries it).
  const [freshPairing, setFreshPairing] = useState<{ code: string, expiresAt: number, role: 'web' | 'desktop-client' } | null>(null)
  const [deviceBusy, setDeviceBusy] = useState(false)
  const [deviceFailed, setDeviceFailed] = useState(false)
  // The device row currently renamed in place (Electron lacks the blocking
  // JS dialog methods, so renames edit inline).
  const [renaming, setRenaming] = useState<{ id: string, draft: string } | null>(null)
  const [pushTest, setPushTest] = useState<PushTest>({ state: 'idle' })
  // CU-4: the debug export's in-flight marker.
  const [debugBusy, setDebugBusy] = useState(false)

  // The client group's pairing form (T16). The address prefills from the row
  // (once the shared form's document is served) until the user types into it;
  // the code normalizes as typed. The registered name is the shared 设备名称
  // field in the role card above (T57) — no separate name box here.
  const [pairUrl, setPairUrl] = useState('')
  const [pairUrlTouched, setPairUrlTouched] = useState(false)
  const [pairCode, setPairCode] = useState('')
  const [claimBusy, setClaimBusy] = useState(false)
  const [claimFail, setClaimFail] = useState<PairFail | null>(null)
  const [unpairBusy, setUnpairBusy] = useState(false)
  const [unpairDone, setUnpairDone] = useState(false)
  // T43: the 立即重连 button's in-flight marker.
  const [reconnectBusy, setReconnectBusy] = useState(false)
  // MS-7: the pool list's in-flight row action — the entry id, or 'all' for
  // the remove-all — and whether the last one failed.
  const [entryBusy, setEntryBusy] = useState<string | null>(null)
  const [entryActionFailed, setEntryActionFailed] = useState(false)
  // MS-7: the 重新配对 action focuses the code box.
  const pairCodeRef = useRef<HTMLInputElement | null>(null)

  const loadStatus = useCallback(() => {
    const ticket = statusGate.next()
    fetch(ADMIN_STATUS_ROUTE)
      .then((res) => {
        if (!res.ok) return Promise.reject(new StatusError(res.status))
        return res.json() as Promise<AdminStatusBody>
      })
      .then((body) => {
        // A 200 whose body is not ok:true is a FAILED load (T16-fix2): it
        // throws into the catch, which keeps the last ready data instead of
        // letting a broken body overwrite it.
        if (body?.ok !== true) throw new StatusError(undefined)
        if (!statusGate.isLatest(ticket)) return
        setLoad({ state: 'ready', body })
        setNow(Date.now())
        setFreshPairing(null)
      })
      .catch((error: unknown) => {
        if (!statusGate.isLatest(ticket)) return
        // T15-fix 1: a failed REFRESH keeps the last ready data on screen and
        // says so; only a failed FIRST load enters the error state. Saving a
        // restart-required field reloads the plugin row (T17), so the first
        // post-save refresh can land inside that reload window — the second
        // pull (1.5s later) then lands the fresh values.
        setLoad((prev) => prev.state === 'ready' || prev.state === 'stale'
          ? { state: 'stale', body: prev.body }
          : { state: 'error', status: error instanceof StatusError ? error.status : undefined })
      })
  }, [statusGate])

  // MS-7: the device name flows ONE way — a saved row serverName is
  // broadcast to every paired server by the backend pool; a server-side
  // record of this device's name never writes back into the row.
  const loadClientStatus = useCallback(() => {
    const ticket = clientGate.next()
    fetch(CLIENT_STATUS_ROUTE)
      .then((res) => {
        if (!res.ok) return Promise.reject(new StatusError(res.status))
        return res.json() as Promise<ClientStatusBody>
      })
      .then((body) => {
        if (!clientGate.isLatest(ticket)) return
        setClientLoad({ state: 'ready', view: deriveClientStatusView(body) })
      })
      .catch(() => {
        if (!clientGate.isLatest(ticket)) return
        setClientLoad((prev) => prev.state === 'ready' || prev.state === 'stale'
          ? { state: 'stale', view: prev.view }
          : { state: 'error' })
      })
  }, [clientGate])

  // The client group's rendered view, hoisted for the countdown ticker and
  // the retry-follow refresh below (T43).
  const clientView = clientLoad.state === 'ready' || clientLoad.state === 'stale' ? clientLoad.view : undefined
  // MS-7: the paired-server pool, in pairing order (empty on a legacy body),
  // and the cap the counters and the red alert read.
  const serverRows: readonly ClientServerView[] = clientView?.servers ?? []
  const maxServers = clientView?.maxServers ?? MAX_PAIRED_SERVERS
  // RD-3: the remote drop guard's browser-side counters, read at render
  // time — no snapshot state of its own: the initial mount, the 15s
  // connected-status poll and the countdown ticker all re-render this page,
  // and each render takes the values as they are right then.
  const dropDiag = remoteDropDiagnostics()
  // MS-7: the SOONEST armed retry across the top level and every pool row —
  // each offline row counts down in its own badge, and the follow refresh
  // below fires after whichever retry comes due first.
  const clientRetryAt = [clientView?.nextRetryAt, ...serverRows.map((server) => server.nextRetryAt)]
    .reduce<number | undefined>((soonest, at) => (at !== undefined && (soonest === undefined || at < soonest) ? at : soonest), undefined)
  const clientCountingDown = clientRetryAt !== undefined
  // MS-7 diagnostics gates: the per-server group, the pre-pool fallback to
  // the top-level mirrors, and whether the section has any line at all.
  const legacyTopDiag = clientView !== undefined && serverRows.length === 0
  const hasServerDiag = serverRows.some(serverHasDiag)
  const diagVisible = clientView !== undefined && (
    clientView.intercept !== undefined
    || clientView.pluginRouteIntercept !== undefined
    || clientView.uploadProbe !== undefined
    || dropDiag.installed
    || dropDiag.notInstalledReason !== undefined
    || hasServerDiag
    || (legacyTopDiag && (clientView.lastError !== '' || clientView.compat !== undefined || (clientView.pluginBridge?.length ?? 0) > 0))
  )

  // Offline with a pending retry: refresh the status shortly after the
  // retry comes due, so a server that came back flips the line to connected
  // without a manual refresh. A still-offline answer carries the NEXT
  // nextRetryAt and re-arms this effect. A HIDDEN page does not fire the
  // refresh: the timer marks the round missed, and becoming visible catches
  // up once (the same visibility-shaped cadence the stores keep).
  useEffect(() => {
    if (!clientCountingDown) return
    let missed = false
    const timer = window.setTimeout(() => {
      if (document.visibilityState === 'hidden') {
        missed = true
        return
      }
      loadClientStatus()
    }, Math.max(0, (clientRetryAt ?? 0) + 1500 - Date.now()))
    const onVisibility = (): void => {
      if (!missed || document.visibilityState !== 'visible') return
      missed = false
      loadClientStatus()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [clientCountingDown, clientRetryAt, loadClientStatus])

  // T43 立即重连: one POST, then refresh now (the state is at least
  // "connecting") and once more after the attempt can have settled.
  const runReconnect = async (): Promise<void> => {
    setReconnectBusy(true)
    try {
      const res = await fetch(CLIENT_RECONNECT_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (res.ok) {
        loadClientStatus()
        refreshTimers.current.push(window.setTimeout(() => { loadClientStatus() }, 1500))
      }
    } catch {
      // The refreshes tell the story; nothing to add here.
    }
    setReconnectBusy(false)
  }

  // The page's role is the SAVED row role from the configForms snapshot —
  // nothing else (T16-fix 3): a client deployment has no admin route at all,
  // so a role judged from admin/status either 404s into host, or — with a
  // stale kept body after a role switch — stays pinned to the old role. The
  // poll choice waits out the snapshot's loading state, so a client row never
  // fires a wasted admin/status; once settled, client polls ONLY
  // client/status.
  const data = load.state === 'ready' || load.state === 'stale'
    ? deriveSettingsView(load.body, { now, rowUser: config.rowUser() })
    : undefined
  const clientRole = config.savedRoleIsClient()

  // The plugin bridge's registered-plugin listing (PB-5), host page only:
  // loaded once per page life and refreshed whenever a save lands (the
  // consent staged by the toggles below rides that very save). Starts in
  // the loading state — the section renders the loading copy until the
  // first answer lands (or the load fails, which is its own state, never
  // the empty one); a composition without the route stays loading.
  // PB-9-fix: the listing is a THREE-state read — loading, failed (an old
  // build, or the page opened through the gateway where the listing is
  // refused), or an answer that carries zero rows. Only the third means
  // "nothing registered"; the first two must not masquerade as it.
  const [bridgeLoad, setBridgeLoad] = useState<{ state: 'loading' | 'error' | 'ready', rows: { plugin: string, version: string, hasServerScope: boolean, consent: boolean }[] }>({ state: 'loading', rows: [] })
  const loadBridge = useCallback(() => {
    setBridgeLoad((prev) => ({ state: 'loading', rows: prev.rows }))
    fetch(ADMIN_PLUGIN_BRIDGE_ROUTE)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(String(res.status)))
        return res.json() as Promise<{ value?: { plugins?: unknown } }>
      })
      .then((body) => {
        const plugins = body?.value?.plugins
        if (!Array.isArray(plugins)) return
        setBridgeLoad({
          state: 'ready',
          rows: plugins.filter((row): row is { plugin: string, version: string, hasServerScope: boolean, consent: boolean } =>
            row !== null && typeof row === 'object' && typeof (row as { plugin?: unknown }).plugin === 'string'),
        })
      })
      .catch(() => { setBridgeLoad((prev) => ({ state: 'error', rows: prev.rows })) })
  }, [])
  useEffect(() => {
    if (!clientRole) loadBridge()
  }, [clientRole, loadBridge])
  const bridgeState = bridgeSectionState(bridgeLoad.state, bridgeLoad.rows)
  const statusPoll = config.statusPoll()

  useEffect(() => {
    if (statusPoll === 'client') loadClientStatus()
    else if (statusPoll === 'admin') loadStatus()
  }, [statusPoll, loadClientStatus, loadStatus])

  // T59: while CONNECTED the status refreshes on a steady 15s cadence (the
  // heartbeat pace) — that is the channel a server-side rename of this
  // device arrives through; offline the retry-follow effect above owns the
  // timing, and unpaired pages simply never arm this.
  const clientConnected = clientView?.state === 'connected'
  useEffect(() => {
    if (!clientConnected) return
    const timer = window.setInterval(() => { loadClientStatus() }, 15_000)
    return () => { window.clearInterval(timer) }
  }, [clientConnected, loadClientStatus])

  // T17: when the row document cannot answer the saved role (the value lives
  // only in lan-gate.config.json), probe the client-config route — registered
  // wherever a webServer exists, on either role — for the EFFECTIVE role. A
  // stored row role always wins, so this only fills the gap; a failed probe
  // keeps the pre-T17 host default. Waits out the mirror's loading phase,
  // like the poll choice above.
  const scopeStatus = form.scopeStatus
  const roleKnown = config.rowRoleKnown()
  useEffect(() => {
    if (scopeStatus === 'loading' || roleKnown) return
    let cancelled = false
    fetch(CLIENT_CONFIG_ROUTE)
      .then((res) => (res.ok ? (res.json() as Promise<ClientConfigBody>) : undefined))
      .then((body) => {
        if (!cancelled) config.setProbedRole(body?.role === 'client' ? 'client' : 'host')
      })
      .catch(() => {
        if (!cancelled) config.setProbedRole('host')
      })
    return () => { cancelled = true }
  }, [scopeStatus, roleKnown, config])

  // Feed the effective values the fields display (and compare drafts against)
  // — but ONLY while the page actually polls the admin source (T55): a role
  // switch leaves the host page's kept status load (and its fed baseline) in
  // place forever, because a client page never refreshes admin/status again.
  // The form also refuses the baseline under a client poll, but the stale
  // values are dropped here as well, so the fields fall back to the row's
  // stored values the moment the row moves.
  useEffect(() => {
    if (statusPoll !== 'admin') {
      config.setBaseline(undefined)
      return
    }
    if (load.state !== 'ready') return
    config.setBaseline(load.body.config?.values)
  }, [load, config, statusPoll])

  // Re-render every second while a pairing code is on screen so the countdown
  // follows; both display paths drop the code once `expiresAt` passes. T43:
  // the same ticker drives the offline "将于 N 秒后重试" countdown.
  const pairingShown = data?.pairing !== null && data?.pairing !== undefined
    || (freshPairing !== null && freshPairing.expiresAt > now)
  useEffect(() => {
    if (!pairingShown && !clientCountingDown) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [pairingShown, clientCountingDown])

  // Environment-locked fields cannot be staged: a written value would be
  // shadowed by the variable anyway. The controller refuses them; this effect
  // keeps its lock set in step with admin/status. The same pass feeds the
  // saved-invalid set (T15-fix 3): those fields keep showing the RAW stored
  // value instead of the resolved one.
  const fieldEntries = data === undefined ? [] : Object.entries(data.fields)
  const lockedKey = fieldEntries
    .filter(([, fv]) => fv.locked)
    .map(([field]) => field)
    .join(',')
  const rowInvalidKey = fieldEntries
    .filter(([, fv]) => fv.savedRowInvalid)
    .map(([field]) => field)
    .join(',')
  useEffect(() => {
    config.setLockedFields(lockedKey === '' ? [] : lockedKey.split(','))
  }, [lockedKey, config])
  useEffect(() => {
    config.setRowInvalidFields(rowInvalidKey === '' ? [] : rowInvalidKey.split(','))
  }, [rowInvalidKey, config])

  // Post-save double refresh (T15-fix 1): once immediately, once after 1.5s —
  // saving a restart-required field reloads the plugin row (T17) and the
  // first refresh can land inside that window. Timers are released if the
  // page unmounts.
  const refreshTimers = useRef<number[]>([])
  useEffect(() => () => {
    for (const timer of refreshTimers.current) window.clearTimeout(timer)
    refreshTimers.current = []
  }, [])

  // Pairing, device management and the push probe are server-local acts: they
  // stay disabled until a status load answers AND it answered as the local
  // machine (a remote device gets viaGateway: true) — localOpsAllowed.
  const localOps = localOpsAllowed(data)
  const localBusy = pairBusy || deviceBusy

  const runPair = async (): Promise<void> => {
    setPairBusy(true)
    setPairFailed(false)
    try {
      const res = await fetch(ADMIN_PAIR_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: pairRole }),
      })
      const body = await res.json().catch(() => ({})) as { ok?: boolean, code?: unknown, expiresAt?: unknown, role?: unknown }
      if (res.ok && body.ok === true && typeof body.code === 'string' && body.code !== '' && typeof body.expiresAt === 'number') {
        setFreshPairing({
          code: body.code,
          expiresAt: body.expiresAt,
          role: body.role === 'desktop-client' ? 'desktop-client' : 'web',
        })
        setNow(Date.now())
        loadStatus()
      } else {
        setPairFailed(true)
      }
    } catch {
      setPairFailed(true)
    }
    setPairBusy(false)
  }

  const runDeviceAction = async (payload: Record<string, unknown>): Promise<void> => {
    setDeviceBusy(true)
    setDeviceFailed(false)
    const result = await postJson(ADMIN_ACTION_ROUTE, payload)
    if (result.ok) loadStatus()
    else setDeviceFailed(true)
    setDeviceBusy(false)
  }

  const commitRename = (device: SettingsDeviceView): void => {
    if (renaming === null || renaming.id !== device.id) return
    const name = renaming.draft.trim()
    setRenaming(null)
    if (name === '' || name === device.name) return
    void runDeviceAction({ action: 'rename', id: device.id, name })
  }

  const runPushTest = async (): Promise<void> => {
    setPushTest({ state: 'busy' })
    const result = await postJson(ADMIN_PUSH_TEST_ROUTE, {})
    setPushTest(result.ok ? { state: 'ok', sent: result.sent, failed: result.failed } : { state: 'fail' })
  }

  // CU-4 导出诊断信息: the backend's redacted report (both roles answer
  // their own), merged with the two facts only THIS page can read — the
  // attachment-entry guard's browser-side counters and whether the session
  // open right now is a remote one — then downloaded as one JSON file. The
  // browser plate carries counters and a boolean, nothing else: no session
  // id, no storage dump.
  const runDebugExport = async (): Promise<void> => {
    setDebugBusy(true)
    try {
      const res = await fetch(CLIENT_DEBUG_REPORT_ROUTE)
      if (!res.ok) throw new StatusError(res.status)
      const report = await res.json() as Record<string, unknown>
      let remote = false
      try {
        const current = parseCurrentSessionStorage(window.localStorage.getItem(CURRENT_SESSION_STORAGE_KEY))
        remote = current.kind === 'open' && isRemoteSessionId(current.sessionId)
      } catch { /* storage unreadable: report not-remote */ }
      const merged = {
        ...report,
        browser: {
          remoteDrop: remoteDropDiagnostics(),
          currentSession: { remote },
        },
      }
      const blob = new Blob([`${JSON.stringify(merged, null, 2)}\n`], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = debugExportFileName(clientRole ? 'client' : 'host', new Date())
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      // Revoked on the next tick: some engines start the download only
      // after the click handler returns.
      window.setTimeout(() => { URL.revokeObjectURL(url) }, 0)
      showDebugToast(t('settings.debug.done'))
    } catch {
      showDebugToast(t('settings.debug.fail'))
    }
    setDebugBusy(false)
  }

  // --- client group (T16) ----------------------------------------------------

  // The address prefill reads the row's stored serverUrl while the user has
  // not typed anything of their own.
  const rowServerUrl = typeof config.rowValue('serverUrl') === 'string' ? config.rowValue('serverUrl') as string : ''
  useEffect(() => {
    if (pairUrlTouched || pairUrl !== '' || rowServerUrl === '') return
    setPairUrl(rowServerUrl)
  }, [pairUrlTouched, pairUrl, rowServerUrl])

  const codeNormalized = normalizePairingCode(pairCode)
  // MS-7: the whole gate is the MS-6 pure truth table — an address and a
  // complete code, a quiet page, a valid device-name draft (T60: a red-boxed
  // name would silently pair under the fallback copy), and the 8-server cap,
  // which blocks only a NEW address: re-entering an already-paired one
  // re-pairs it in place, at 8/8 too.
  const claimVerdict = canSubmitClientPairing({
    pairUrl,
    pairCode: codeNormalized,
    servers: serverRows,
    maxServers,
    busy: claimBusy,
    deviceNameInvalid: form.serverName.invalid,
  })
  const claimAllowed = form.available && form.writable && claimVerdict.allowed

  const runClaim = async (): Promise<void> => {
    setClaimBusy(true)
    setClaimFail(null)
    // UX-1: captured BEFORE the pairing — whether the page ran as client, and
    // whether the backend's stream interceptor was already active per the
    // last client/status diagnostics.
    const wasEffectiveClient = clientRole
    const streamInterceptAlreadyActive = clientView?.intercept?.installed === true
    // T60: the name registers trimmed and legal ({@link claimDeviceNameOf}).
    const claimName = claimDeviceNameOf(form.serverName.text, t('settings.client.deviceNameDefault'))
    try {
      const res = await fetch(CLIENT_CLAIM_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // T57: the name registers under the shared 设备名称 field's current
        // displayed value (a staged draft counts), falling back to the
        // default copy when the field is empty.
        body: JSON.stringify({
          serverUrl: pairUrl.trim(),
          code: codeNormalized,
          name: claimName,
        }),
      })
      const body = await res.json().catch(() => ({})) as ClaimRouteBody
      if (res.ok && body.ok === true) {
        // MS-5/MS-7: the backend landed the pairing straight into
        // zen-remote-state.json (the token never reaches the browser), so
        // there is nothing to write here — only the FIRST activation still
        // reloads, so the page's resident global streams reopen wrapped.
        if (shouldReloadAfterClientActivation({
          wasEffectiveClient,
          nowClientRole: true,
          savedOrPaired: true,
          streamInterceptAlreadyActive,
        })) {
          setClaimBusy(false)
          void awaitClientStatusReady().then(() => window.location.reload())
          return
        }
        setPairCode('')
        if (typeof body.serverUrl === 'string' && body.serverUrl !== '') setPairUrl(body.serverUrl)
        setUnpairDone(false)
        loadClientStatus()
      } else {
        // Every other shape is a failure (T16-fix), shown with the classified
        // code when the route sent one (MS-5 adds `limit-reached`). The
        // body's `message` is ignored: the wording is this build's
        // dictionary (pairFailText).
        const fail: PairFail = { code: typeof body.code === 'string' && body.code !== '' ? body.code : 'unexpected' }
        if (typeof body.retryAfterMs === 'number') fail.retryAfterMs = body.retryAfterMs
        setClaimFail(fail)
      }
    } catch {
      setClaimFail({ code: 'unexpected' })
    }
    setClaimBusy(false)
  }

  const runUnpair = async (): Promise<void> => {
    if (!window.confirm(t('settings.client.unpairConfirm'))) return
    setUnpairBusy(true)
    const landed = await config.clearDeviceToken()
    setUnpairBusy(false)
    if (landed) {
      setUnpairDone(true)
      loadClientStatus()
    }
  }

  /** MS-7: one POST of the pool list's row actions — whether it answered ok. */
  const postClientRoute = async (route: string, payload: string): Promise<boolean> => {
    try {
      const res = await fetch(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
      return res.ok
    } catch {
      return false
    }
  }

  // MS-7 立即重连 for ONE server: refresh now (the state is at least
  // "connecting") and once more after the attempt can have settled — the
  // T43 top-level button's cadence, per entry.
  const runEntryReconnect = async (entryId: string): Promise<void> => {
    setEntryBusy(entryId)
    setEntryActionFailed(false)
    if (await postClientRoute(CLIENT_RECONNECT_ROUTE, JSON.stringify({ entryId }))) {
      loadClientStatus()
      refreshTimers.current.push(window.setTimeout(() => { loadClientStatus() }, 1500))
    } else {
      setEntryActionFailed(true)
    }
    setEntryBusy(null)
  }

  // MS-7 移除: forget one paired server (the server's own device record is
  // untouched — the confirm copy says so).
  const runUnpairEntry = async (entryId: string): Promise<void> => {
    if (!window.confirm(t('settings.client.unpairServerConfirm'))) return
    setEntryBusy(entryId)
    setEntryActionFailed(false)
    if (await postClientRoute(CLIENT_UNPAIR_ROUTE, JSON.stringify({ entryId }))) loadClientStatus()
    else setEntryActionFailed(true)
    setEntryBusy(null)
  }

  // MS-7 全部移除: forget every paired server at once.
  const runUnpairAllServers = async (): Promise<void> => {
    if (!window.confirm(t('settings.client.unpairAllServersConfirm'))) return
    setEntryBusy('all')
    setEntryActionFailed(false)
    if (await postClientRoute(CLIENT_UNPAIR_ROUTE, JSON.stringify({ all: true }))) loadClientStatus()
    else setEntryActionFailed(true)
    setEntryBusy(null)
  }

  // MS-7 重新配对: point the pairing form at this server — its address in the
  // box (an already-paired address passes the cap gate), a blank code, the
  // focus on the code box so the user only types the fresh code.
  const repurposeServer = (server: ClientServerView): void => {
    setPairUrl(server.serverUrl)
    setPairUrlTouched(true)
    setPairCode('')
    setClaimFail(null)
    pairCodeRef.current?.focus()
  }

  const formDisabled = !form.available || !form.writable

  // T17: saving any restart-required field (the role among them) moves the
  // row, and the host half's watcher reloads it — the gateway child restarts
  // with it. T17b narrowed the flag to drafts that would actually change the
  // effective value (a re-typed identical value or an env-locked field no
  // longer promise a reload), so the note appears exactly when a save will
  // move the row, and vanishes on discard or save.
  const reloadPending = form.restartPending

  // The code shown under the pairing controls: the refreshed status's, or the
  // one the pair route just returned while the refresh is in flight.
  const shownPairing: SettingsPairingView | null = data?.pairing
    ?? (freshPairing !== null && freshPairing.expiresAt > now
      ? {
          code: freshPairing.code,
          role: freshPairing.role,
          remainingSeconds: Math.max(0, Math.ceil((freshPairing.expiresAt - now) / 1000)),
        }
      : null)

  const labels: SettingsFormLabels = {
    unavailable: t('settings.unavailable'),
    readOnly: t('settings.readOnly'),
    saveFailed: t('settings.saveFailed'),
    save: t('settings.save'),
    saving: t('settings.saving'),
  }

  /** The per-field source annotations (file badge, env lock, invalid saved value). */
  const annotations = (field: string): ReactNode => {
    const fv: SettingsFieldView | undefined = data?.fields[field as keyof typeof data.fields]
    if (fv === undefined) return null
    return (
      <>
        {fv.fromFile && <p className="zr-settings-hint">{t('settings.sourceFileBadge')}</p>}
        {fv.locked && <p className="zr-settings-hint" data-invalid="true">{t('settings.sourceEnvBadge')}</p>}
        {fv.savedRowInvalid && (
          <p className="zr-settings-hint" data-invalid="true">
            {t('settings.savedInvalid', { source: sourceName(fv.source, t) })}
          </p>
        )}
      </>
    )
  }

  /** The "saving a staged clear reverts to the next layer" hint (T15-fix 2). */
  const clearPreviewNote = (state: SettingsFieldState): ReactNode =>
    state.cleared ? <p className="zr-settings-hint">{t('settings.resetPreview')}</p> : null

  const text = (state: SettingsFieldState, field: string, label: string, hint: string, invalidLabel: string, numeric = false, note?: string) => (
    <div className="zr-settings-field" key={field}>
      <SettingsValueField
        id={`zr-settings-${field}`}
        label={label}
        hint={hint}
        numeric={numeric}
        overriddenLabel={t('settings.overridden')}
        resetLabel={t('settings.reset')}
        invalidLabel={invalidLabel}
        disabled={formDisabled || state.locked}
        text={state.text}
        overridden={state.overridden}
        invalid={state.invalid}
        onEdit={(value) => { config.stage(field, value) }}
        onReset={() => { config.resetField(field) }}
      />
      {note !== undefined && <p className="zr-settings-hint">{note}</p>}
      {clearPreviewNote(state)}
      {annotations(field)}
    </div>
  )

  // One-of control (the shared fields have no select): the shared field chrome, a select body.
  const select = (state: SettingsFieldState, field: string, label: string, hint: string, options: readonly string[], optionLabel: (option: string) => string) => (
    <div className="zr-settings-field" key={field}>
      <div className="zr-settings-head">
        <label htmlFor={`zr-settings-${field}`}>{label}</label>
        {state.overridden && <span className="zr-settings-badge">{t('settings.overridden')}</span>}
        {state.overridden && (
          <button type="button" className="zr-settings-reset" disabled={formDisabled || state.locked} onClick={() => { config.resetField(field) }}>{t('settings.reset')}</button>
        )}
      </div>
      <select
        id={`zr-settings-${field}`}
        className="zr-settings-input"
        disabled={formDisabled || state.locked}
        value={state.text}
        onChange={(e) => { config.stage(field, e.currentTarget.value) }}
      >
        {options.map((option) => <option key={option} value={option}>{optionLabel(option)}</option>)}
      </select>
      {hint !== '' && <p className="zr-settings-hint">{hint}</p>}
      {clearPreviewNote(state)}
      {annotations(field)}
    </div>
  )

  // Boolean control (the shared fields have no checkbox): label row + switch.
  const bool = (state: SettingsFieldState, field: string, label: string, hint: string) => (
    <div className="zr-settings-field" key={field}>
      <div className="zr-settings-head">
        <label htmlFor={`zr-settings-${field}`}>{label}</label>
        {state.overridden && <span className="zr-settings-badge">{t('settings.overridden')}</span>}
        {state.overridden && (
          <button type="button" className="zr-settings-reset" disabled={formDisabled || state.locked} onClick={() => { config.resetField(field) }}>{t('settings.reset')}</button>
        )}
        <span className="zr-settings-check-row">
          <input
            id={`zr-settings-${field}`}
            type="checkbox"
            disabled={formDisabled || state.locked}
            checked={state.text === 'true'}
            onChange={(e) => { config.stage(field, e.currentTarget.checked ? 'true' : 'false') }}
          />
        </span>
      </div>
      <p className="zr-settings-hint">{hint}</p>
      {clearPreviewNote(state)}
      {annotations(field)}
    </div>
  )

  const deviceRow = (device: SettingsDeviceView) => (
    <div className="zr-settings-device" key={device.id}>
      <div className="zr-settings-device-head">
        <span className="zr-settings-device-name">{device.name}</span>
        <span className="zr-settings-badge">{device.role === 'web' ? t('settings.deviceRoleWeb') : t('settings.deviceRoleDesktop')}</span>
        <span className="zr-settings-badge">{device.hasPush ? t('settings.devicePushOn') : t('settings.devicePushOff')}</span>
        <span className="zr-settings-hint">{t('settings.deviceLastSeen', { time: new Date(device.lastSeen).toLocaleString() })}</span>
      </div>
      <div className="zr-settings-device-actions">
        <select
          className="zr-settings-input"
          aria-label={t('settings.deviceRoleSelect', { name: device.name })}
          disabled={!localOps || localBusy}
          value={device.role}
          onChange={(e) => { void runDeviceAction({ action: 'set-role', id: device.id, role: e.currentTarget.value }) }}
        >
          <option value="web">{t('settings.deviceRoleWeb')}</option>
          <option value="desktop-client">{t('settings.deviceRoleDesktop')}</option>
        </select>
        <select
          className="zr-settings-input"
          aria-label={t('settings.deviceKindSelect', { name: device.name })}
          disabled={!localOps || localBusy}
          value={device.kind}
          onChange={(e) => { void runDeviceAction({ action: 'set-kind', id: device.id, kind: e.currentTarget.value }) }}
        >
          {DEVICE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind === 'auto' ? t('settings.kindAuto') : kind === 'phone' ? t('settings.kindPhone') : t('settings.kindDesktop')}
            </option>
          ))}
        </select>
        <Button variant="ghost" size="sm" disabled={!localOps || localBusy} onClick={() => { setRenaming({ id: device.id, draft: device.name }) }}>
          {t('settings.deviceRename')}
        </Button>
        <Button variant="ghost" size="sm" disabled={!localOps || localBusy} onClick={() => {
          if (window.confirm(t('settings.revokeConfirm'))) void runDeviceAction({ action: 'revoke', id: device.id })
        }}>{t('settings.deviceRevoke')}</Button>
      </div>
      {renaming?.id === device.id && (
        <div className="zr-settings-row">
          {/* Electron lacks the blocking JS dialog methods: the rename edits in place. */}
          <input
            className="zr-settings-input"
            aria-label={t('settings.renamePrompt')}
            maxLength={DEVICE_NAME_MAX}
            value={renaming.draft}
            autoFocus
            onChange={(e) => { setRenaming({ id: device.id, draft: e.currentTarget.value }) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename(device)
              if (e.key === 'Escape') setRenaming(null)
            }}
          />
          <Button variant="outline" size="sm" disabled={localBusy} onClick={() => { commitRename(device) }}>{t('settings.renameSave')}</Button>
          <Button variant="ghost" size="sm" disabled={localBusy} onClick={() => { setRenaming(null) }}>{t('settings.renameCancel')}</Button>
        </div>
      )}
    </div>
  )

  // Whether a landed save moved a restart-required field — read BEFORE save()
  // clears the staged drafts (T17b): the projected snapshot's restartPending
  // is exactly "the plan writes a restart-field op" (value actually differs,
  // not env-locked), which is what decides the refresh cadence below.
  const saveReloadsRow = (): boolean => config.getSnapshot().restartPending
  const saveLanded = (reloadsRow: boolean): void => {
    // A landed save that switched the role drops the OTHER role's data right
    // away (T16-fix 3) — a stale device list or connection line must not
    // survive the switch, and the poll effect alone would leave the old
    // body on screen. The delayed pulls re-read the role at fire time: the
    // first pull can land inside a row-restart window.
    if (config.savedRoleIsClient()) setLoad({ state: 'loading' })
    else setClientLoad({ state: 'loading' })
    const refresh = config.savedRoleIsClient() ? loadClientStatus : loadStatus
    refresh()
    // The plugin bridge listing re-reads too (PB-5): the consent toggles
    // stage through the very save that just landed.
    if (!config.savedRoleIsClient()) loadBridge()
    // Immediate pull + 1.5s covers a hot-only save. A save that reloads the
    // plugin row (T17) restarts the row and the gateway child with it — the
    // reload and the gateway's rebinding of its port both take longer than
    // one slot, so two more pulls at 3s and 6s cover the whole window
    // (T17b); each pull re-reads the role in case the switch lands mid-way.
    const pulls: readonly number[] = reloadsRow ? [1500, 3000, 6000] : [1500]
    for (const delay of pulls) {
      refreshTimers.current.push(window.setTimeout(() => {
        if (config.savedRoleIsClient()) loadClientStatus()
        else loadStatus()
      }, delay))
    }
  }

  return (
    <div data-zen-remote="settings">
      {!clientRole && load.state === 'error' && (
        <p className="zr-settings-hint" data-invalid="true">
          {load.status === undefined
            ? t('settings.statusUnknown')
            : t('settings.statusUnavailable', { code: load.status })}
        </p>
      )}
      {!clientRole && load.state === 'stale' && (
        <p className="zr-settings-hint" data-invalid="true">{t('settings.refreshFailed')}</p>
      )}
      {clientRole && clientLoad.state === 'error' && (
        <p className="zr-settings-hint" data-invalid="true">{t('settings.statusUnknown')}</p>
      )}
      {clientRole && clientLoad.state === 'stale' && (
        <p className="zr-settings-hint" data-invalid="true">{t('settings.refreshFailed')}</p>
      )}
      {data?.viaGateway === true && <p className="zr-settings-notice">{t('settings.remoteNotice')}</p>}

      {/* The staged row fields — the only part the settings-form frame owns. */}
      <div className="zr-settings-card">
        <SettingsForm
          labels={labels}
          state={form}
          onSave={() => {
            const reloadsRow = saveReloadsRow()
            // UX-1: captured BEFORE the save — whether the page ran as client,
            // and whether the backend's stream interceptor was already active
            // per the last client/status diagnostics.
            const wasEffectiveClient = clientRole
            const streamInterceptAlreadyActive = clientView?.intercept?.installed === true
            void config.save().then((landed) => {
              if (!landed) return
              if (shouldReloadAfterClientActivation({
                wasEffectiveClient,
                nowClientRole: config.savedRoleIsClient(),
                savedOrPaired: true,
                streamInterceptAlreadyActive,
              })) {
                // UX-1: the save first-activated the client interceptor while
                // this page's resident global streams were opened unwrapped —
                // wait out the row-reload window, then reload so the streams
                // reopen wrapped and the server's sessions enter the sidebar.
                void awaitClientStatusReady().then(() => window.location.reload())
                return
              }
              saveLanded(reloadsRow)
            })
          }}
          onDiscard={() => { config.discard() }}
        >
          <h3 className="zr-settings-card-title">{t('settings.roleTitle')}</h3>
          {select(form.role, 'role', t('settings.role'), t('settings.roleHint'), ['host', 'client'], (option) => (
            option === 'host' ? t('settings.roleHost') : t('settings.roleClient')
          ))}
          {/* T57: the device name — the row's serverName field — lives in the
              role card on BOTH roles: on a host it is the server display name
              other devices' sidebars show; on a client it is the name a
              pairing registers with. The hint is the one role fact that
              differs. */}
          {text(
            form.serverName,
            'serverName',
            t('settings.fieldServerName'),
            t(clientRole ? 'settings.fieldServerNameHintClient' : 'settings.fieldServerNameHint'),
            t('settings.invalidName'),
          )}
          {reloadPending && <p className="zr-settings-status-line">{t('settings.reloadNote')}</p>}

          {!clientRole && (
            <>
              <h3 className="zr-settings-card-title">{t('settings.gatewayTitle')}</h3>
              {text(form.host, 'host', t('settings.fieldHost'), t('settings.fieldHostHint'), '', false, t('settings.fieldHostNote'))}
              {text(form.port, 'port', t('settings.fieldPort'), t('settings.fieldPortHint'), t('settings.invalidPort'), true)}
              {text(form.trustedProxies, 'trustedProxies', t('settings.fieldTrustedProxies'), t('settings.fieldTrustedProxiesHint'), '')}
              {text(form.rateLimit, 'rateLimit', t('settings.fieldRateLimit'), t('settings.fieldRateLimitHint'), t('settings.invalidPositiveInt'), true)}
              {text(form.vapidSubject, 'vapidSubject', t('settings.fieldVapidSubject'), t('settings.fieldVapidSubjectHint'), '')}

              <h3 className="zr-settings-card-title">{t('settings.pushTitle')}</h3>
              {/* P55-1: the master switch and the session-name line lead the
                  group — the off switch below hides nothing visually (the
                  other controls stay renderable) but apply() wires nothing
                  until it is back on. */}
              {bool(form.pushEnabled, 'pushEnabled', t('settings.fieldPushEnabled'), t('settings.fieldPushEnabledHint'))}
              {bool(form.pushSessionName, 'pushSessionName', t('settings.fieldPushSessionName'), t('settings.fieldPushSessionNameHint'))}
              {bool(form.pushSummary, 'pushSummary', t('settings.fieldPushSummary'), t('settings.fieldPushSummaryHint'))}
              {bool(form.pushTurnEnd, 'pushTurnEnd', t('settings.fieldPushTurnEnd'), t('settings.fieldPushTurnEndHint'))}
              {bool(form.pushTool, 'pushTool', t('settings.fieldPushTool'), t('settings.fieldPushToolHint'))}
              {text(form.pushDebounceMs, 'pushDebounceMs', t('settings.fieldPushDebounceMs'), t('settings.fieldPushDebounceMsHint'), t('settings.invalidNonNegativeInt'), true)}
              {select(form.lang, 'lang', t('settings.fieldLang'), t('settings.fieldLangHint'), ['auto', 'zh', 'en'], (option) => (
                option === 'auto' ? t('settings.langAuto') : option === 'zh' ? t('settings.langZh') : t('settings.langEn')
              ))}

              <h3 className="zr-settings-card-title">{t('settings.shareTitle')}</h3>
              {text(form.idleHours, 'idleHours', t('settings.fieldIdleHours'), t('settings.fieldIdleHoursHint'), t('settings.invalidHours'), true)}
              {bool(form.autoShareNewSessions, 'autoShareNewSessions', t('settings.fieldAutoShare'), t('settings.fieldAutoShareHint'))}

              {/* 插件桥 (PB-5): the consent toggles stage the NEXT consent map
                  over the SAME form — one save button, one revision fence —
                  reading the CURRENT map off the staged (or displayed) draft
                  so consecutive toggles compose. */}
              <h3 className="zr-settings-card-title">{t('settings.bridge.title')}</h3>
              {bridgeState === 'loading' && <p className="zr-settings-hint">{t('settings.bridge.loading')}</p>}
              {bridgeState === 'error' && <p className="zr-settings-hint" data-invalid="true">{t('settings.bridge.loadFailed')}</p>}
              {bridgeState === 'empty' && <p className="zr-settings-hint">{t('settings.bridge.empty')}</p>}
              {bridgeLoad.rows.map((row) => {
                let current: Record<string, boolean> = {}
                try {
                  const parsed: unknown = JSON.parse(form.pluginBridgeConsent.text)
                  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    current = parsed as Record<string, boolean>
                  }
                } catch { /* a malformed draft reads as nothing consented */ }
                return (
                  <div className="zr-settings-field" key={row.plugin}>
                    <div className="zr-settings-head">
                      <span className="zr-settings-head-title">{row.plugin}</span>
                      <span className="zr-settings-badge">{row.version}</span>
                    </div>
                    {row.hasServerScope ? (
                      <>
                        <div className="zr-settings-head">
                          <label>{t('settings.bridge.consentToggle')}</label>
                          <Switch
                            checked={current[row.plugin] === true}
                            onChange={(checked) => {
                              config.stage('pluginBridgeConsent', JSON.stringify(togglePluginConsent(current, row.plugin, checked)))
                            }}
                            label={t('settings.bridge.consentToggle')}
                          />
                        </div>
                        <p className="zr-settings-hint">{t('settings.bridge.consentHint')}</p>
                      </>
                    ) : (
                      <p className="zr-settings-hint">{t('settings.bridge.sessionOnly')}</p>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </SettingsForm>
      </div>

      {/* Instant operations — outside the form frame, so pairing, device
          management and the gateway status stay visible even while the
          configuration namespace is unavailable or read-only. */}
      {!clientRole && (
        <div className="zr-settings-card">
          <p className="zr-settings-status-line" data-down={data !== undefined && !data.gatewayReachable && !data.gatewayAbnormal ? 'true' : undefined}>
            {data === undefined
              ? ''
              : data.gatewayAbnormal
                ? t('settings.gatewayAbnormal', { code: data.gatewayStatus })
                : data.gatewayReachable
                  ? t('settings.gatewayRunning', { port: data.gatewayPort ?? '?', target: data.gatewayTarget ?? '?' })
                  : t('settings.gatewayDown')}
          </p>

          <h3 className="zr-settings-card-title">{t('settings.pairingTitle')}</h3>
          <div className="zr-settings-role-cards">
            {PAIR_ROLES.map((role) => (
              <label className="zr-settings-role-card" key={role} data-active={pairRole === role ? 'true' : undefined}>
                <span className="zr-settings-role-card-title">
                  <input
                    type="radio"
                    name="zr-settings-pair-role"
                    checked={pairRole === role}
                    onChange={() => { setPairRole(role) }}
                  />
                  {role === 'web' ? t('settings.deviceRoleWeb') : t('settings.deviceRoleDesktop')}
                </span>
                <span className="zr-settings-hint">
                  {role === 'web' ? t('settings.pairingWebGuide') : t('settings.pairingDesktopGuide')}
                </span>
              </label>
            ))}
          </div>
          <div className="zr-settings-row" style={{ paddingBottom: 12 }}>
            <Button variant="outline" size="sm" disabled={!localOps || pairBusy} onClick={() => { void runPair() }}>
              {pairBusy ? t('settings.pairingGenerating') : t('settings.pairingGenerate')}
            </Button>
            {pairFailed && <span className="zr-settings-hint" data-invalid="true">{t('settings.pairingFail')}</span>}
          </div>
          {shownPairing !== null && (
            <div className="zr-settings-field">
              <div className="zr-settings-head">
                {/* Not a form control anywhere near: a span, not a control-less label. */}
                <span className="zr-settings-head-title">{t('settings.pairingCodeLabel')}</span>
                <span className="zr-settings-badge">{shownPairing.role === 'web' ? t('settings.deviceRoleWeb') : t('settings.deviceRoleDesktop')}</span>
                <span className="zr-settings-badge" data-warn="true">{t('settings.pairingRemaining', { count: shownPairing.remainingSeconds })}</span>
              </div>
              <p className="zr-settings-pair-code">{shownPairing.code}</p>
            </div>
          )}

          <h3 className="zr-settings-card-title">{t('settings.devicesTitle')}</h3>
          {(data?.devices.length ?? 0) === 0 && <p className="zr-settings-hint">{t('settings.devicesEmpty')}</p>}
          {data?.devices.map(deviceRow)}
          {deviceFailed && <p className="zr-settings-hint" data-invalid="true">{t('settings.actionFail')}</p>}
          {(data?.devices.length ?? 0) > 0 && (
            <div className="zr-settings-row" style={{ paddingBottom: 12 }}>
              <Button variant="ghost" size="sm" disabled={!localOps || localBusy} onClick={() => {
                if (window.confirm(t('settings.revokeAllConfirm'))) void runDeviceAction({ action: 'revoke-all' })
              }}>{t('settings.revokeAll')}</Button>
            </div>
          )}

          <div className="zr-settings-field">
            <div className="zr-settings-head">
              {/* The row's control is a Button (not labelable): a span, not a control-less label. */}
              <span className="zr-settings-head-title">{t('settings.pushTestLabel')}</span>
              <span style={{ flex: 1 }} />
              <Button variant="outline" size="sm" disabled={!localOps || pushTest.state === 'busy'} onClick={() => { void runPushTest() }}>
                {pushTest.state === 'busy' ? t('settings.pushTestRunning') : t('settings.pushTestRun')}
              </Button>
            </div>
            {pushTest.state === 'ok' && <p className="zr-settings-hint">{t('settings.pushTestOk', { sent: pushTest.sent, failed: pushTest.failed })}</p>}
            {pushTest.state === 'fail' && <p className="zr-settings-hint" data-invalid="true">{t('settings.pushTestFail')}</p>}
          </div>

          <SharesList shares={shares} t={t} />
        </div>
      )}

      {/* The client group (T16): server connection, connection status and
          unpairing — same outside-the-frame placement as the host's instant
          operations, so they render even while the namespace is read-only. */}
      {clientRole && (
        <div className="zr-settings-card">
          <h3 className="zr-settings-card-title">
            {t('settings.client.connectTitle')}
            <span className="zr-settings-badge" data-invalid={clientView?.limitReached === true ? 'true' : undefined}>{t('settings.client.poolCount', { count: serverRows.length, max: maxServers })}</span>
          </h3>
          <p className="zr-settings-hint" style={{ paddingTop: 4 }}>{t('settings.client.poolCapNote', { max: maxServers })}</p>
          {/* MS-7: the full pool's alert — loud red bold on purpose: a new
              address is refused until a server is removed, while re-entering
              an already-paired address still re-pairs it in place. */}
          {clientView?.limitReached === true && (
            <p className="zr-settings-limit-alert" data-invalid="true">
              {t('settings.client.limitReached', { count: serverRows.length, max: maxServers })}
            </p>
          )}
          <div className="zr-settings-field">
            <div className="zr-settings-head">
              <label htmlFor="zr-settings-client-server">{t('settings.client.serverUrl')}</label>
            </div>
            <input
              id="zr-settings-client-server"
              className="zr-settings-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={pairUrl}
              onChange={(e) => { setPairUrl(e.currentTarget.value); setPairUrlTouched(true) }}
            />
            <p className="zr-settings-hint">{t('settings.client.serverUrlHint')}</p>
          </div>
          <div className="zr-settings-field">
            <div className="zr-settings-head">
              <label htmlFor="zr-settings-client-code">{t('settings.client.pairingCode')}</label>
            </div>
            <input
              id="zr-settings-client-code"
              ref={pairCodeRef}
              className="zr-settings-input zr-settings-code-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              // No maxLength: the draft is normalized (uppercased, spaces and
              // hyphens stripped) on every keystroke, and only the
              // NORMALIZED length gates the pair button — a code pasted with
              // separators must survive pasting intact.
              value={pairCode}
              onChange={(e) => { setPairCode(normalizePairingCode(e.currentTarget.value)) }}
            />
            <p className="zr-settings-hint">{t('settings.client.pairingCodeHint')}</p>
          </div>
          <div className="zr-settings-row" style={{ paddingBottom: 12 }}>
            <Button variant="outline" size="sm" disabled={!claimAllowed} onClick={() => { void runClaim() }}>
              {claimBusy ? t('settings.client.pairing') : t('settings.client.pair')}
            </Button>
            {/* T60: the pairing button is disabled while the device-name
                draft is invalid — this line says why. */}
            {form.serverName.invalid && <span className="zr-settings-hint" data-invalid="true">{t('settings.client.fixDeviceName')}</span>}
            {claimFail !== null && <span className="zr-settings-hint" data-invalid="true">{pairFailText(claimFail, t)}</span>}
          </div>

          {/* MS-7: the paired main servers, in pairing order — one row per
              pool entry with its own state badge and actions. The cap only
              ever gates NEW addresses, so 重新配对 stays usable at 8/8. */}
          <h3 className="zr-settings-card-title">{t('settings.client.serversTitle')}</h3>
          {serverRows.length === 0 && (
            <p className="zr-settings-hint" style={{ padding: '8px 0 12px' }}>{t('settings.client.serversEmpty', { max: maxServers })}</p>
          )}
          {serverRows.map((server) => {
            const badge = serverStateBadge(server, now, t)
            return (
              <div className="zr-settings-device" key={server.entryId}>
                <div className="zr-settings-device-head">
                  <span className="zr-settings-device-name">{server.displayName !== '' ? server.displayName : server.serverUrl}</span>
                  <span
                    className="zr-settings-badge"
                    data-live={badge.tone === 'live' ? 'true' : undefined}
                    data-warn={badge.tone === 'warn' ? 'true' : undefined}
                    data-invalid={badge.tone === 'invalid' ? 'true' : undefined}
                  >
                    {badge.text}
                  </span>
                  <span className="zr-settings-hint">{server.serverUrl}</span>
                </div>
                <div className="zr-settings-device-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={entryBusy !== null || server.nextRetryAt === undefined}
                    onClick={() => { void runEntryReconnect(server.entryId) }}
                  >
                    {entryBusy === server.entryId ? t('settings.client.reconnectBusy') : t('settings.client.reconnect')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={entryBusy !== null} onClick={() => { repurposeServer(server) }}>
                    {t('settings.client.repair')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={entryBusy !== null} onClick={() => { void runUnpairEntry(server.entryId) }}>
                    {t('settings.client.serverRemove')}
                  </Button>
                </div>
              </div>
            )
          })}
          {entryActionFailed && <p className="zr-settings-hint" data-invalid="true">{t('settings.actionFail')}</p>}
          {serverRows.length > 0 && (
            <div className="zr-settings-row" style={{ paddingBottom: 12 }}>
              <Button variant="ghost" size="sm" disabled={entryBusy !== null} onClick={() => { void runUnpairAllServers() }}>
                {t('settings.client.unpairAllServers')}
              </Button>
            </div>
          )}

          <h3 className="zr-settings-card-title">{t('settings.client.statusTitle')}</h3>
          <div className="zr-settings-row" style={{ paddingBottom: 4 }}>
            <p className="zr-settings-status-line" style={{ flex: 1 }} data-down={clientView !== undefined && (clientView.state === 'unreachable' || clientView.state === 'unexpected' || clientView.state === 'revoked' || clientView.state === 'invalid-url' || clientView.state === 'incompatible') ? 'true' : undefined}>
              {clientView === undefined ? '' : clientStatusText(clientView, now, t)}
            </p>
            {/* T43 立即重连: the response carrying a nextRetryAt is the one
                honest "the relay is offline with a retry armed" signal — the
                probe word underneath may be unreachable or unexpected; the
                route 409s anything else anyway (T43-fix). */}
            <Button
              variant="outline"
              size="sm"
              disabled={clientView === undefined || clientView.nextRetryAt === undefined || reconnectBusy}
              onClick={() => { void runReconnect() }}
            >
              {reconnectBusy ? t('settings.client.reconnectBusy') : t('settings.client.reconnect')}
            </Button>
            <Button variant="outline" size="sm" disabled={clientLoad.state === 'loading'} onClick={loadClientStatus}>
              {clientLoad.state === 'loading' ? t('settings.client.statusRefreshing') : t('settings.client.statusRefresh')}
            </Button>
          </div>
          {form.deviceToken.configured && (
            <div className="zr-settings-row" style={{ paddingBottom: 12 }}>
              <span className="zr-settings-badge">{t('settings.client.tokenSet')}</span>
              <Button variant="ghost" size="sm" disabled={!form.available || !form.writable || unpairBusy} onClick={() => { void runUnpair() }}>
                {unpairBusy ? t('settings.client.unpairBusy') : t('settings.client.unpair')}
              </Button>
            </div>
          )}
          {unpairDone && <p className="zr-settings-hint" style={{ paddingBottom: 12 }}>{t('settings.client.unpairDone')}</p>}

          {/* 诊断 (T43): everything on this section comes from the same
              client/status body. The interceptor (T23b) and compat (T42)
              groups render only when the response carried their fields —
              earlier servers answer neither, and the section itself only
              exists when there is at least one line to show. PB-5 adds the
              bridge rows and the rerouting note on the same presence gate.
              MS-7: the interceptor, the attachment-entry guard and the
              upload redirect are GLOBAL (one per machine); the last error,
              the fingerprint groups and the bridge verdicts are PER SERVER
              (the pool group at the bottom). A legacy body without servers[]
              keeps the top-level mirrors (legacyTopDiag). */}
          {diagVisible && clientView !== undefined && (
            <>
              <h3 className="zr-settings-card-title">{t('settings.client.diagTitle')}</h3>
              {legacyTopDiag && clientView.lastError !== '' && (
                <p className="zr-settings-hint" data-invalid={clientView.state === 'unreachable' ? 'true' : undefined}>
                  {t('settings.client.diagLastError', { code: clientView.lastError })}
                </p>
              )}
              {clientView.intercept !== undefined && (
                <>
                  <p className="zr-settings-hint">
                    {clientView.intercept.installed
                      ? t('settings.client.diagInterceptInstalled')
                      : t('settings.client.diagInterceptMissing')}
                  </p>
                  {clientView.intercept.reasons.length > 0 && (
                    <p className="zr-settings-hint" data-invalid="true">
                      {t('settings.client.diagInterceptDisabled')}
                      {clientView.intercept.reasons.map((reason, index) => (
                        <span key={index} className="zr-settings-hint">{reason}</span>
                      ))}
                    </p>
                  )}
                  {clientView.intercept.recentFailures.length > 0 && (
                    <div className="zr-settings-field">
                      <div className="zr-settings-head">
                        <label>{t('settings.client.diagRecentFailures')}</label>
                      </div>
                      {clientView.intercept.recentFailures.map((failure, index) => (
                        <p key={index} className="zr-settings-hint">
                          {new Date(failure.time).toLocaleString()} · {failure.method !== '' ? failure.method : '—'} · {failure.code}
                        </p>
                      ))}
                    </div>
                  )}
                </>
              )}
              {/* RD-3: the attachment-entry guard's own line — installed state
                  plus the five counters, with the per-entry split below it
                  (AU-2: drop / picker / paste). Browser-side values, so unlike
                  the rows above it never rides the client/status body. */}
              {(dropDiag.installed || dropDiag.notInstalledReason !== undefined) && (
                <div className="zr-settings-field">
                  <div className="zr-settings-head">
                    <label>{t('settings.client.diagRemoteDrop')}</label>
                  </div>
                  <p className="zr-settings-hint">
                    {dropDiag.installed
                      ? t('settings.client.diagRemoteDropOk', {
                        intercepted: dropDiag.intercepted,
                        redispatched: dropDiag.redispatched,
                        blocked: dropDiag.blockedDirectories,
                        passthrough: dropDiag.passthrough,
                        failed: dropDiag.rewrapFailed,
                      })
                      : t('settings.client.diagRemoteDropOff', { reason: dropDiag.notInstalledReason ?? '—' })}
                  </p>
                  {dropDiag.installed && (
                    <p className="zr-settings-hint">
                      {t('settings.client.diagRemoteDropEntries', {
                        dropI: dropDiag.interceptedBy.drop,
                        pickerI: dropDiag.interceptedBy.picker,
                        pasteI: dropDiag.interceptedBy.paste,
                        dropP: dropDiag.passthroughBy.drop,
                        pickerP: dropDiag.passthroughBy.picker,
                        pasteP: dropDiag.passthroughBy.paste,
                      })}
                    </p>
                  )}
                </div>
              )}
              {/* RD-6: the upload-redirect (fetch-route intercept) line — rides
                  the client/status body's serviceProbe. One row answers the
                  question this diagnosis was built for: whether the redirect
                  is installed, refused (with the shape reason), or its service
                  inject never fired — and which of the two services is
                  missing when so. */}
              {clientView?.uploadProbe !== undefined && (() => {
                const probe = clientView.uploadProbe as {
                  uploadInjectSeen?: unknown
                  connectionService?: unknown
                  fileUploadsService?: unknown
                  fetchRoute?: { installed?: unknown; uploadWrapped?: unknown; shape?: { reasons?: unknown } }
                }
                const seen = probe.uploadInjectSeen === true
                const refused = seen && probe.fetchRoute?.shape?.reasons instanceof Array && (probe.fetchRoute.shape.reasons as string[]).length > 0
                const wrapped = probe.fetchRoute?.uploadWrapped === true
                const text = wrapped
                  ? t('settings.client.diagUploadRedirectOk')
                  : refused
                    ? t('settings.client.diagUploadRedirectRefused', { reason: (probe.fetchRoute?.shape?.reasons as string[]).join('; ') })
                    : t('settings.client.diagUploadRedirectPending', {
                      connection: typeof probe.connectionService === 'string' ? probe.connectionService : '—',
                      fileUploads: typeof probe.fileUploadsService === 'string' ? probe.fileUploadsService : '—',
                    })
                return (
                  <div className="zr-settings-field">
                    <div className="zr-settings-head">
                      <label>{t('settings.client.diagUploadRedirect')}</label>
                    </div>
                    <p className="zr-settings-hint">{text}</p>
                  </div>
                )
              })()}
              {legacyTopDiag && clientView.compat !== undefined && (
                <>
                  {clientView.compat.mismatchedGroups.length > 0 && (
                    <p className="zr-settings-hint" data-invalid="true">
                      {t('settings.client.diagCompatGroups', { groups: clientView.compat.mismatchedGroups.join(', ') })}
                    </p>
                  )}
                  {clientView.compat.recentCalls.length > 0 && (
                    <div className="zr-settings-field">
                      <div className="zr-settings-head">
                        <label>{t('settings.client.diagCompatCalls')}</label>
                      </div>
                      {clientView.compat.recentCalls.map((failure, index) => (
                        <p key={index} className="zr-settings-hint">
                          {new Date(failure.time).toLocaleString()} · {failure.method !== '' ? failure.method : '—'} · {failure.code}
                        </p>
                      ))}
                    </div>
                  )}
                </>
              )}
              {legacyTopDiag && (clientView.pluginBridge?.length ?? 0) > 0 && clientView.pluginBridge !== undefined && (
                <div className="zr-settings-field">
                  <div className="zr-settings-head">
                    <label>{t('settings.bridge.title')}</label>
                  </div>
                  {clientView.pluginBridge.map((row: PluginBridgeStatusView) => (
                    <p key={row.plugin} className="zr-settings-hint">
                      {row.plugin} · {row.localVersion !== '' ? `v${row.localVersion}` : '—'} ·{' '}
                      {row.stateKey === 'settings.bridge.stateVersionMismatch'
                        ? t(row.stateKey, { version: row.serverVersion ?? '?' })
                        : t(row.stateKey)}
                    </p>
                  ))}
                </div>
              )}
              {clientView.pluginRouteIntercept !== undefined && !clientView.pluginRouteIntercept.installed && (
                <p className="zr-settings-hint" data-invalid="true">
                  {t('settings.bridge.interceptOff', { reason: clientView.pluginRouteIntercept.reasons.join('; ') || '—' })}
                </p>
              )}
              {hasServerDiag && (
                <div className="zr-settings-field">
                  <div className="zr-settings-head">
                    <label>{t('settings.client.serverDiagTitle')}</label>
                  </div>
                  {serverRows.filter(serverHasDiag).map((server) => (
                    <div className="zr-settings-device" key={server.entryId}>
                      <span className="zr-settings-device-name">{server.displayName !== '' ? server.displayName : server.serverUrl}</span>
                      {server.lastError !== '' && (
                        <p className="zr-settings-hint" data-invalid={server.state === 'unreachable' ? 'true' : undefined}>
                          {t('settings.client.diagLastError', { code: server.lastError })}
                        </p>
                      )}
                      {server.compat !== undefined && server.compat.mismatchedGroups.length > 0 && (
                        <p className="zr-settings-hint" data-invalid="true">
                          {t('settings.client.diagCompatGroups', { groups: server.compat.mismatchedGroups.join(', ') })}
                        </p>
                      )}
                      {server.compat?.recentCalls.map((failure, index) => (
                        <p key={index} className="zr-settings-hint">
                          {t('settings.client.diagCompatCalls')} · {new Date(failure.time).toLocaleString()} · {failure.method !== '' ? failure.method : '—'} · {failure.code}
                        </p>
                      ))}
                      {server.pluginBridge.map((row: PluginBridgeStatusView) => (
                        <p key={row.plugin} className="zr-settings-hint">
                          {t('settings.bridge.title')} · {row.plugin} · {row.localVersion !== '' ? `v${row.localVersion}` : '—'} ·{' '}
                          {row.stateKey === 'settings.bridge.stateVersionMismatch'
                            ? t(row.stateKey, { version: row.serverVersion ?? '?' })
                            : t(row.stateKey)}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* CU-4: the diagnostics export — the very bottom of the page, on
          BOTH roles (a host's report has its own value: the gateway plate),
          outside the form frame so it works while the namespace is
          read-only. Existing classes only: no new style rules anywhere. */}
      <div className="zr-settings-card">
        <div className="zr-settings-field">
          <div className="zr-settings-head">
            {/* The row's control is a Button (not labelable): a span, not a control-less label. */}
            <span className="zr-settings-head-title">{t('settings.debug.title')}</span>
            <span style={{ flex: 1 }} />
            <Button variant="outline" size="sm" disabled={debugBusy} onClick={() => { void runDebugExport() }}>
              {debugBusy ? t('settings.debug.exporting') : t('settings.debug.export')}
            </Button>
          </div>
          <p className="zr-settings-hint">{t('settings.debug.hint')}</p>
        </div>
      </div>
    </div>
  )
}

/** Display name of a value's source layer for the invalid-saved-value note. */
function sourceName(source: SettingsFieldView['source'], t: SectionT): string {
  if (source === 'env') return t('settings.sourceEnv')
  if (source === 'file') return t('settings.sourceFile')
  return t('settings.sourceDefault')
}

/**
 * The shared-session list (T33b entry 3), inside the host instant-operations
 * card — outside the settings-form frame like the pairing and device areas,
 * so it renders while the configuration namespace is unavailable or
 * read-only. It reads the SAME shares store singleton as the title-row icon
 * and the session menu (one poll loop for all three, started by this page's
 * subscription while mounted). Renders nothing until the first GET answers
 * and nothing while the store's wired role is not host (T33b-fix: the role
 * comes from the settings page's own two-level decision — this component
 * additionally sits inside the page's `!clientRole` branch, judged the T16
 * way off the saved row role). A failed GET keeps the last table on screen.
 *
 * Unlike pairing and device management these actions are NOT gated by
 * `viaGateway`: toggling shares through the gateway is the T33a-sanctioned
 * exception, so a phone may close a session's remote access.
 */
function SharesList({ shares, t }: { shares: SharesStore, t: SectionT }) {
  const snap = useSyncExternalStore(
    useCallback((onStoreChange: () => void) => shares.subscribe(onStoreChange), [shares]),
    () => shares.getSnapshot(),
  )
  const [shareBusy, setShareBusy] = useState(false)
  const [shareFailed, setShareFailed] = useState(false)

  if (!snap.ready || snap.role !== 'host') return null
  const entries = snap.entries
  // Fresh clock per render — the 30 s poll replaces the snapshot, which is
  // the re-render that keeps every countdown text within one poll of truth.
  const now = Date.now()

  const runUnshare = async (sessionId: string): Promise<void> => {
    setShareBusy(true)
    setShareFailed(false)
    const outcome = await shares.unshare(sessionId)
    if (!outcome.ok) setShareFailed(true)
    setShareBusy(false)
  }

  const runUnshareAll = async (): Promise<void> => {
    if (!window.confirm(t('settings.shareCloseAllConfirm'))) return
    setShareBusy(true)
    setShareFailed(false)
    const outcome = await shares.unshareAll()
    if (!outcome.ok) setShareFailed(true)
    setShareBusy(false)
  }

  const shareRow = (entry: ShareEntryView) => (
    <div className="zr-settings-share-row" key={entry.sessionId}>
      <div className="zr-settings-device-head">
        <span className="zr-settings-device-name">{entry.title ?? entry.sessionId}</span>
        {entry.viewers > 0 && (
          <span className="zr-settings-badge" data-live="true">
            {t('settings.shareViewers', { count: entry.viewers })}
          </span>
        )}
        <span className="zr-settings-hint">{describeShare(entry, now, t).remainingText}</span>
      </div>
      <Button variant="ghost" size="sm" disabled={shareBusy} onClick={() => { void runUnshare(entry.sessionId) }}>
        {t('settings.shareClose')}
      </Button>
    </div>
  )

  return (
    <>
      <h3 className="zr-settings-card-title">{t('settings.shareListTitle')}</h3>
      {entries.length === 0 && <p className="zr-settings-hint">{t('settings.shareListEmpty')}</p>}
      {entries.map(shareRow)}
      {shareFailed && <p className="zr-settings-hint" data-invalid="true">{t('settings.shareActionFail')}</p>}
      {entries.length > 0 && (
        <div className="zr-settings-row" style={{ paddingBottom: 12 }}>
          <Button variant="ghost" size="sm" disabled={shareBusy} onClick={() => { void runUnshareAll() }}>
            {t('settings.shareCloseAll')}
          </Button>
        </div>
      )}
    </>
  )
}
