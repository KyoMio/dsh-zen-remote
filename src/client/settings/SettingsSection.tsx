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
import { Button, SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ADMIN_ACTION_ROUTE,
  ADMIN_PAIR_ROUTE,
  ADMIN_PUSH_TEST_ROUTE,
  ADMIN_STATUS_ROUTE,
  CLIENT_CLAIM_ROUTE,
  CLIENT_CONFIG_ROUTE,
  CLIENT_RECONNECT_ROUTE,
  CLIENT_STATUS_ROUTE,
  createLatestGate,
  clientStatusLineOf,
  deriveClientStatusView,
  deriveSettingsView,
  localOpsAllowed,
  normalizePairingCode,
} from '../../client-data/settings-form.ts'
import type {
  AdminStatusBody,
  ClaimRouteBody,
  ClientConfigBody,
  ClientConnectionView,
  ClientStatusBody,
  SettingsDeviceView,
  SettingsFieldState,
  SettingsFieldView,
  SettingsPairingView,
  ZenRemoteSettingsForm,
} from '../../client-data/settings-form.ts'
import { NS } from '../locales.ts'
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
    default: return t('settings.client.failUnexpected')
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

  // The client group's pairing form (T16). The address prefills from the row
  // (once the shared form's document is served) until the user types into it;
  // the name defaults to the display copy; the code normalizes as typed.
  const [pairUrl, setPairUrl] = useState('')
  const [pairUrlTouched, setPairUrlTouched] = useState(false)
  const [pairName, setPairName] = useState(() => t('settings.client.deviceNameDefault'))
  const [pairCode, setPairCode] = useState('')
  const [claimBusy, setClaimBusy] = useState(false)
  const [claimFail, setClaimFail] = useState<PairFail | null>(null)
  const [claimWriteFailed, setClaimWriteFailed] = useState(false)
  const [unpairBusy, setUnpairBusy] = useState(false)
  const [unpairDone, setUnpairDone] = useState(false)
  // T43: the 立即重连 button's in-flight marker.
  const [reconnectBusy, setReconnectBusy] = useState(false)

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
  const clientRetryAt = clientView?.nextRetryAt
  const clientCountingDown = clientRetryAt !== undefined

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
  const statusPoll = config.statusPoll()

  useEffect(() => {
    if (statusPoll === 'client') loadClientStatus()
    else if (statusPoll === 'admin') loadStatus()
  }, [statusPoll, loadClientStatus, loadStatus])

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

  // Feed the effective values the fields display (and compare drafts against).
  useEffect(() => {
    if (load.state !== 'ready') return
    config.setBaseline(load.body.config?.values)
  }, [load, config])

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

  // --- client group (T16) ----------------------------------------------------

  // The address prefill reads the row's stored serverUrl while the user has
  // not typed anything of their own.
  const rowServerUrl = typeof config.rowValue('serverUrl') === 'string' ? config.rowValue('serverUrl') as string : ''
  useEffect(() => {
    if (pairUrlTouched || pairUrl !== '' || rowServerUrl === '') return
    setPairUrl(rowServerUrl)
  }, [pairUrlTouched, pairUrl, rowServerUrl])

  const codeNormalized = normalizePairingCode(pairCode)
  const claimAllowed = form.available && form.writable && !claimBusy && codeNormalized.length === 8

  const runClaim = async (): Promise<void> => {
    setClaimBusy(true)
    setClaimFail(null)
    setClaimWriteFailed(false)
    try {
      const res = await fetch(CLIENT_CLAIM_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverUrl: pairUrl.trim(), code: codeNormalized, name: pairName.trim() }),
      })
      const body = await res.json().catch(() => ({})) as ClaimRouteBody
      if (res.ok && body.ok === true && typeof body.token === 'string' && body.token !== '') {
        // The backend echoes the address it validated; write both through ONE
        // mutate, then clear the code and re-read the connection state.
        const urlToWrite = typeof body.serverUrl === 'string' && body.serverUrl !== '' ? body.serverUrl : pairUrl.trim()
        const landed = await config.writeClientPairing(urlToWrite, body.token)
        if (landed) {
          setPairCode('')
          setPairUrl(urlToWrite)
          setUnpairDone(false)
          loadClientStatus()
        } else {
          setClaimWriteFailed(true)
        }
      } else {
        // Every other shape is a failure (T16-fix): a non-OK status, a body
        // whose `ok` is not true, a missing token — shown with the classified
        // code when the route sent one. The body's `message` is ignored: the
        // wording is this build's dictionary (pairFailText).
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
            void config.save().then((landed) => { if (landed) saveLanded(reloadsRow) })
          }}
          onDiscard={() => { config.discard() }}
        >
          <h3 className="zr-settings-card-title">{t('settings.roleTitle')}</h3>
          {select(form.role, 'role', t('settings.role'), t('settings.roleHint'), ['host', 'client'], (option) => (
            option === 'host' ? t('settings.roleHost') : t('settings.roleClient')
          ))}
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
              {bool(form.pushSummary, 'pushSummary', t('settings.fieldPushSummary'), t('settings.fieldPushSummaryHint'))}
              {bool(form.pushTurnEnd, 'pushTurnEnd', t('settings.fieldPushTurnEnd'), t('settings.fieldPushTurnEndHint'))}
              {bool(form.pushTool, 'pushTool', t('settings.fieldPushTool'), t('settings.fieldPushToolHint'))}
              {text(form.pushDebounceMs, 'pushDebounceMs', t('settings.fieldPushDebounceMs'), t('settings.fieldPushDebounceMsHint'), t('settings.invalidNonNegativeInt'), true)}
              {select(form.lang, 'lang', t('settings.fieldLang'), t('settings.fieldLangHint'), ['auto', 'zh', 'en'], (option) => (
                option === 'auto' ? t('settings.langAuto') : option === 'zh' ? t('settings.langZh') : t('settings.langEn')
              ))}

              <h3 className="zr-settings-card-title">{t('settings.shareTitle')}</h3>
              {text(form.serverName, 'serverName', t('settings.fieldServerName'), t('settings.fieldServerNameHint'), t('settings.invalidName'))}
              {text(form.idleHours, 'idleHours', t('settings.fieldIdleHours'), t('settings.fieldIdleHoursHint'), t('settings.invalidHours'), true)}
              {bool(form.autoShareNewSessions, 'autoShareNewSessions', t('settings.fieldAutoShare'), t('settings.fieldAutoShareHint'))}
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
          <h3 className="zr-settings-card-title">{t('settings.client.connectTitle')}</h3>
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
              <label htmlFor="zr-settings-client-name">{t('settings.client.deviceName')}</label>
            </div>
            <input
              id="zr-settings-client-name"
              className="zr-settings-input"
              type="text"
              maxLength={DEVICE_NAME_MAX}
              value={pairName}
              onChange={(e) => { setPairName(e.currentTarget.value) }}
            />
          </div>
          <div className="zr-settings-field">
            <div className="zr-settings-head">
              <label htmlFor="zr-settings-client-code">{t('settings.client.pairingCode')}</label>
            </div>
            <input
              id="zr-settings-client-code"
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
            {claimFail !== null && <span className="zr-settings-hint" data-invalid="true">{pairFailText(claimFail, t)}</span>}
            {claimWriteFailed && <span className="zr-settings-hint" data-invalid="true">{t('settings.client.failWrite')}</span>}
          </div>

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
              exists when there is at least one line to show. */}
          {clientView !== undefined && (clientView.lastError !== '' || clientView.intercept !== undefined || clientView.compat !== undefined) && (
            <>
              <h3 className="zr-settings-card-title">{t('settings.client.diagTitle')}</h3>
              {clientView.lastError !== '' && (
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
              {clientView.compat !== undefined && (
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
            </>
          )}
        </div>
      )}
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
