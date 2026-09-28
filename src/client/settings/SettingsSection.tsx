/**
 * The dsh-zen-remote plugin row's settings block on the Plugins manager
 * (T15 + T15-fix): the staged row fields (role, gateway & reverse proxy,
 * push, remote sharing) inside the official settings-form frame ending in its
 * one save control, and BELOW the form — outside it, so they still render
 * when the configuration namespace is not served — the instant-operation
 * areas: gateway status line, pairing, device list, push probe and the
 * remote-sharing placeholder. Those POST the same-origin admin routes and
 * re-read `admin/status`; only field edits stage and save through
 * `ZenRemoteSettingsForm`.
 *
 * Opened through the gateway (`viaGateway`, i.e. on a phone or another
 * browser) the server-local buttons disable and a notice says so — and until
 * one status load answers from the server itself, they count as remote. The
 * summary view renders its one-liner alone and never fetches a thing.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ADMIN_ACTION_ROUTE,
  ADMIN_PAIR_ROUTE,
  ADMIN_PUSH_TEST_ROUTE,
  ADMIN_STATUS_ROUTE,
  deriveSettingsView,
} from '../../client-data/settings-form.ts'
import type {
  AdminStatusBody,
  SettingsDeviceView,
  SettingsFieldState,
  SettingsFieldView,
  SettingsPairingView,
  ZenRemoteSettingsForm,
} from '../../client-data/settings-form.ts'
import { NS } from '../locales.ts'

export interface SettingsSectionProps extends PropsRuntime<'plugins.row.config'>, PropsLocale<typeof NS> {
  /** The staged configuration form (injected share). */
  config: ZenRemoteSettingsForm
}

/** Device roles the pairing picker offers, in display order. */
const PAIR_ROLES = ['web', 'desktop-client'] as const
type PairRole = (typeof PAIR_ROLES)[number]

/** Display layouts a device can be pinned to (the gateway's `kind` field). */
const DEVICE_KINDS = ['auto', 'phone', 'desktop'] as const

type PushTest =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'ok', sent: number, failed: number }
  | { state: 'fail' }

/** One status load's outcome; `error.status` is undefined for network / non-JSON failures. */
type Load =
  | { state: 'loading' }
  | { state: 'ready', body: AdminStatusBody }
  | { state: 'error', status: number | undefined }

/** Longest device name, mirroring the gateway's rename cap. */
const DEVICE_NAME_MAX = 40

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

function SettingsSectionPage({ config, t }: SettingsSectionProps) {
  const form = useSyncExternalStore(
    useCallback((cb: () => void) => config.subscribe(cb), [config]),
    () => config.getSnapshot(),
  )

  const [load, setLoad] = useState<Load>({ state: 'loading' })
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

  const loadStatus = useCallback(() => {
    fetch(ADMIN_STATUS_ROUTE)
      .then((res) => {
        if (!res.ok) return Promise.reject(new StatusError(res.status))
        return res.json() as Promise<AdminStatusBody>
      })
      .then((body) => {
        if (body?.ok !== true) throw new StatusError(undefined)
        setLoad({ state: 'ready', body })
        setNow(Date.now())
        setFreshPairing(null)
      })
      .catch((error: unknown) => {
        setLoad({ state: 'error', status: error instanceof StatusError ? error.status : undefined })
      })
  }, [])
  useEffect(loadStatus, [loadStatus])

  // Feed the effective values the fields display (and compare drafts against).
  useEffect(() => {
    if (load.state !== 'ready') return
    config.setBaseline(load.body.config?.values)
  }, [load, config])

  const data = load.state === 'ready' ? deriveSettingsView(load.body, { now, rowUser: config.rowUser() }) : undefined

  // Re-render every second while a pairing code is on screen so the countdown
  // follows; both display paths drop the code once `expiresAt` passes.
  const pairingShown = data?.pairing !== null && data?.pairing !== undefined
    || (freshPairing !== null && freshPairing.expiresAt > now)
  useEffect(() => {
    if (!pairingShown) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [pairingShown])

  // Environment-locked fields cannot be staged: a written value would be
  // shadowed by the variable anyway. The controller refuses them; this effect
  // keeps its lock set in step with admin/status.
  const lockedKey = data === undefined ? '' : Object.entries(data.fields)
    .filter(([, fv]) => fv.locked)
    .map(([field]) => field)
    .join(',')
  useEffect(() => {
    config.setLockedFields(lockedKey === '' ? [] : lockedKey.split(','))
  }, [lockedKey, config])

  // Pairing, device management and the push probe are server-local acts: they
  // stay disabled until a status load answers AND it answered as the local
  // machine (a remote device gets viaGateway: true).
  const localOps = data?.viaGateway === false
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

  const formDisabled = !form.available || !form.writable
  const clientRole = data?.role === 'client'
  const roleChanged = form.role.text !== (data?.role ?? 'host')

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
          aria-label={`${device.name} · role`}
          disabled={!localOps || localBusy}
          value={device.role}
          onChange={(e) => { void runDeviceAction({ action: 'set-role', id: device.id, role: e.currentTarget.value }) }}
        >
          <option value="web">{t('settings.deviceRoleWeb')}</option>
          <option value="desktop-client">{t('settings.deviceRoleDesktop')}</option>
        </select>
        <select
          className="zr-settings-input"
          aria-label={`${device.name} · layout`}
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

  return (
    <div data-zen-remote="settings">
      {load.state === 'error' && (
        <p className="zr-settings-hint" data-invalid="true">
          {load.status === undefined
            ? t('settings.statusUnknown')
            : t('settings.statusUnavailable', { code: load.status })}
        </p>
      )}
      {data?.viaGateway === true && <p className="zr-settings-notice">{t('settings.remoteNotice')}</p>}

      {/* The staged row fields — the only part the settings-form frame owns. */}
      <div className="zr-settings-card">
        <SettingsForm
          labels={labels}
          state={form}
          onSave={() => { void config.save().then((landed) => { if (landed) loadStatus() }) }}
          onDiscard={() => { config.discard() }}
        >
          <h3 className="zr-settings-card-title">{t('settings.roleTitle')}</h3>
          {select(form.role, 'role', t('settings.role'), t('settings.roleHint'), ['host', 'client'], (option) => (
            option === 'host' ? t('settings.roleHost') : t('settings.roleClient')
          ))}
          {roleChanged && <p className="zr-settings-status-line">{t('settings.roleRestartNote')}</p>}
          {clientRole && <p className="zr-settings-hint" style={{ paddingBottom: 12 }}>{t('settings.clientOnlyNote')}</p>}

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
                <label>{t('settings.pairingCodeLabel')}</label>
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
              <label>{t('settings.pushTestLabel')}</label>
              <span style={{ flex: 1 }} />
              <Button variant="outline" size="sm" disabled={!localOps || pushTest.state === 'busy'} onClick={() => { void runPushTest() }}>
                {pushTest.state === 'busy' ? t('settings.pushTestRunning') : t('settings.pushTestRun')}
              </Button>
            </div>
            {pushTest.state === 'ok' && <p className="zr-settings-hint">{t('settings.pushTestOk', { sent: pushTest.sent, failed: pushTest.failed })}</p>}
            {pushTest.state === 'fail' && <p className="zr-settings-hint" data-invalid="true">{t('settings.pushTestFail')}</p>}
          </div>

          <p className="zr-settings-hint" style={{ paddingBottom: 12 }}>{t('settings.sharePlaceholder')}</p>
        </div>
      )}
    </div>
  )
}

/** Display name of a value's source layer for the invalid-saved-value note. */
function sourceName(source: SettingsFieldView['source'], t: SettingsSectionProps['t']): string {
  if (source === 'env') return t('settings.sourceEnv')
  if (source === 'file') return t('settings.sourceFile')
  return t('settings.sourceDefault')
}
