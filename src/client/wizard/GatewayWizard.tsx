/**
 * GatewayWizard (GW-10): the「让手机连上来」three-step flow on the plugin
 * detail page — pick the ingress path, fill its form, verify end to end.
 *
 * Mount-point contract: registered on `plugins.detail.section` BEFORE the
 * desktop gate (the desktop app IS the main server — the wizard is exactly
 * where it is most useful). The subject filter (`kind === 'row'` +
 * `pkg.name === 'dsh-zen-remote'`) and the saved-role check
 * (`config.savedRoleIsClient()`) both render null, so a foreign row, a
 * sub-client deployment and the phone shell all see nothing.
 *
 * Remote-read rule: when `admin/status` answers with `viaGateway: true`
 * (the page is open through the gateway), everything disables behind a
 * notice — the wizard is a server-owner surface, same wall as its routes.
 *
 * Polling discipline (same as the settings block): a failed refresh keeps
 * the last ready data; verification polls stop at a terminal verdict
 * (pass / cookie-insecure / code-expired / stale) and the countdown ticks
 * only while a pairing code is live. The QR code contains the public URL
 * only — never the pairing code, which stays plain text beside it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ZenRemoteSettingsForm } from '../../client-data/settings-form.ts'
import { ADMIN_STATUS_ROUTE, CLIENT_CONFIG_ROUTE } from '../../client-data/settings-form.ts'
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
  deriveWizardLights,
  formSeedOf,
  initialStep,
  isValidPort,
  pairingSecondsLeft,
  tunnelCheckCopy,
  tunnelFailureCopy,
  upstreamPortOf,
  type CaddyState,
  type TunnelCheckWire,
  type TunnelSetupWire,
  type LightState,
  type WizardPath,
  type WizardStatusBody,
  type WizardStep,
  type WizardVerifyPoll,
  type WizardVerifyStart,
} from '../../client-data/wizard.ts'
import { NS } from '../locales.ts'
import { MigrateCard } from './cards/MigrateCard.tsx'
import { PortForwardCard } from './cards/PortForwardCard.tsx'
import { ProxyCard } from './cards/ProxyCard.tsx'
import { TokenCard } from './cards/TokenCard.tsx'

export interface GatewayWizardProps extends PropsRuntime<'plugins.detail.section'>, PropsLocale<typeof NS> {
  /** The row's staged-form controller — saved-role source of truth. */
  config: ZenRemoteSettingsForm
  /** One atomic row write (the wiring stages through configForms.mutate). */
  saveRowFields: (fields: Record<string, unknown>) => Promise<void>
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

const LIGHT_LABEL: Record<LightState, 'wizard.light.pass' | 'wizard.light.pending' | 'wizard.light.fail'> = {
  pass: 'wizard.light.pass',
  pending: 'wizard.light.pending',
  fail: 'wizard.light.fail',
}

export function GatewayWizard(props: GatewayWizardProps): ReactNode {
  const { t, config } = props

  const [step, setStep] = useState<WizardStep>('pick')
  const [path, setPath] = useState<WizardPath>('caddy')
  const [domain, setDomain] = useState('')
  const [httpsPort, setHttpsPort] = useState('443')
  const [cfToken, setCfToken] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [wizardStatus, setWizardStatus] = useState<WizardStatusBody | undefined>()
  const [gatewayReachable, setGatewayReachable] = useState(false)
  const [viaGateway, setViaGateway] = useState(false) // default local; server wall is the real gate
  const [statusLoaded, setStatusLoaded] = useState(false)
  const [startResult, setStartResult] = useState<WizardVerifyStart | undefined>()
  const [poll, setPoll] = useState<WizardVerifyPoll | undefined>()
  const [notWired, setNotWired] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [card, setCard] = useState<'proxy' | 'token' | 'migrate' | 'portforward' | undefined>()
  const [tokenNotice, setTokenNotice] = useState<'saved' | 'failed' | undefined>()
  const [caddyState, setCaddyState] = useState<CaddyState | undefined>()
  const [caddyStartError, setCaddyStartError] = useState<ReturnType<typeof caddyFailureCopy> | undefined>()
  const [tunnelState, setTunnelState] = useState<CaddyState | undefined>()
  const [tunnelBusy, setTunnelBusy] = useState(false)
  const [tunnelResult, setTunnelResult] = useState<TunnelSetupWire | undefined>()
  const [tunnelCheck, setTunnelCheck] = useState<TunnelCheckWire | undefined>()
  const [adoptTunnelId, setAdoptTunnelId] = useState<string | undefined>()
  const [probedClient, setProbedClient] = useState<boolean | null>(null)

  // The saved role, live: a role flip re-renders this away (or back).
  const roleSnapshot = useSyncExternalStore(
    useCallback((cb: () => void) => config.subscribe(cb), [config]),
    () => config.getSnapshot(),
  )
  const savedClient = config.savedRoleIsClient()

  // When the row document carries no role at all, probe the lightweight
  // client-config route (both roles register it) — same fallback the
  // settings block uses.
  useEffect(() => {
    if (config.rowRoleKnown()) return
    let cancelled = false
    fetch(CLIENT_CONFIG_ROUTE)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: { role?: unknown } | undefined) => {
        if (!cancelled) setProbedClient(body?.role === 'client')
      })
      .catch(() => {
        if (!cancelled) setProbedClient(false)
      })
    return () => { cancelled = true }
  }, [config, roleSnapshot])

  // One 5 s beat: the wizard projection (mode/domain/port for the forms)
  // + admin/status (reachability + the viaGateway wall). A failed refresh
  // keeps the last ready data.
  useEffect(() => {
    let ticket = 0
    const load = async (): Promise<void> => {
      const mine = ++ticket
      try {
        const [wizardResponse, adminResponse] = await Promise.all([fetch(WIZARD_STATUS_ROUTE), fetch(ADMIN_STATUS_ROUTE)])
        if (wizardResponse.ok && mine === ticket) {
          const body = (await wizardResponse.json()) as WizardStatusBody
          if (body?.ok === true) setWizardStatus(body)
        }
        if (adminResponse.ok && mine === ticket) {
          const body = (await adminResponse.json()) as { gatewayReachable?: unknown; viaGateway?: unknown }
          setGatewayReachable(body?.gatewayReachable === true)
          setViaGateway(body?.viaGateway !== false)
          // The ingress fields live ONLY on the wizard projection —
          // admin/status strips them (GW-1), so backfill happens in the
          // wizardStatus seed below.
        }
        if (mine === ticket) setStatusLoaded(true)
      } catch {
        // keep the last ready data
      }
    }
    void load()
    const handle = setInterval(() => { void load() }, 5000)
    return () => clearInterval(handle)
  }, [])

  // Seed the entry step AND the configure forms from the FIRST ready
  // wizard status (initialStep + formSeedOf — the projection is the only
  // surface carrying the ingress fields). Later refreshes do not yank the
  // user around.
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current || wizardStatus === undefined) return
    seededRef.current = true
    setStep(initialStep(wizardStatus))
    const seed = formSeedOf(wizardStatus)
    if (seed.path !== undefined) setPath(seed.path)
    if (seed.domain !== '') setDomain(seed.domain)
    if (seed.httpsPort !== '') setHttpsPort(seed.httpsPort)
    if (seed.serverUrl !== '') setServerUrl(seed.serverUrl)
  }, [wizardStatus])

  // Verification polling: only while a session could still move — a
  // terminal verdict stops the loop.
  const pollVerdict = poll?.result
  useEffect(() => {
    const active = startResult?.ok === true && (pollVerdict === undefined || pollVerdict === 'not-started' || pollVerdict === 'pending')
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
  }, [startResult, pollVerdict])

  // The pairing-code countdown ticks only while a code is live.
  useEffect(() => {
    if (startResult?.ok !== true) return
    const handle = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(handle)
  }, [startResult])

  const disabled = viaGateway
  const readiness = useMemo(
    () => configureReadiness(path, { domain, httpsPort, cfToken, serverUrl }),
    [path, domain, httpsPort, cfToken, serverUrl],
  )

  const advanceFromConfigure = async (): Promise<void> => {
    setFormError(null)
    if (!readiness.ok) {
      setFormError(readiness.error)
      return
    }
    if (path === 'external') {
      await props.saveRowFields({ ingressMode: 'external', ingressPublicUrl: readiness.publicUrl })
    } else {
      await props.saveRowFields({ ingressMode: path, ingressDomain: domain.trim(), ingressHttpsPort: readiness.httpsPort })
    }
    setStep('verify')
  }

  const startVerification = async (): Promise<void> => {
    const publicUrl = path === 'external'
      ? serverUrl.trim()
      : (readiness.ok ? readiness.publicUrl : '')
    setNotWired(false)
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
      setStartResult(body)
      setPoll(body.ok ? { result: 'not-started' } : undefined)
    } catch {
      setStartResult({ ok: false, reason: 'gateway-unreachable' })
      setPoll(undefined)
    }
  }

  // Managed-Caddy controls (GW-13a): a 3 s status poll while the verify
  // step shows the caddy path, start/stop through the routes. A start
  // failure maps to locale copy (download failures carry the install URL).
  const caddyPath = wizardStatus?.mode === 'caddy' || path === 'caddy'
  const tunnelPath = wizardStatus?.mode === 'cloudflared' || path === 'cloudflared'
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
    try {
      const response = await fetch(WIZARD_CADDY_START_ROUTE, { method: 'POST' })
      const body = (await response.json()) as { ok?: unknown; error?: unknown; detail?: unknown; installUrl?: unknown }
      if (body?.ok === true) {
        setCaddyState('running')
        return
      }
      if (response.status === 501) {
        setNotWired(true)
        return
      }
      setCaddyStartError(caddyFailureCopy(String(body?.error ?? ''), typeof body?.detail === 'string' ? body.detail : undefined, typeof body?.installUrl === 'string' ? body.installUrl : undefined))
    } catch {
      setCaddyStartError({ key: 'wizard.caddy.failSpawn', params: {} })
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
    const domain = path === 'external' ? serverUrl.trim() : domain2()
    setTunnelCheck(undefined)
    try {
      const response = await fetch(WIZARD_TUNNEL_CHECK_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      })
      const body = (await response.json()) as TunnelCheckWire
      setTunnelCheck(body)
    } catch {
      setTunnelCheck({ ok: false, reason: 'network' })
    }
  }

  const domain2 = (): string => domain.trim()

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
      if (body.ok) setTunnelState('running')
    } catch {
      setTunnelResult({ ok: false, reason: 'network' })
    } finally {
      setTunnelBusy(false)
    }
  }

  // The subject + role gates. Show on BOTH the bundle detail page (kind:
  // 'bundle') and the row detail page (kind: 'row') — the bundle page is
  // one click shallower and where users actually look first.
  const subject = (props as { subject?: { kind?: string; pkg?: { name?: string } } }).subject
  if ((subject?.kind !== 'row' && subject?.kind !== 'bundle') || subject?.pkg?.name !== 'dsh-zen-remote') return null
  const effectiveClient = savedClient || (probedClient === true && !config.rowRoleKnown())
  if (effectiveClient) return null

  const lights = deriveWizardLights({ gatewayReachable, poll })
  const verified = poll?.result === 'pass'
  const qr = startResult?.ok === true ? qrMatrix(startResult.publicUrl) : null

  const stepLabel = (name: WizardStep): string => t(name === 'pick' ? 'wizard.step.pick' : name === 'configure' ? 'wizard.step.configure' : 'wizard.step.verify')

  return (
    <div data-zen-remote="wizard">
      <p className="zr-wizard-title">{t('wizard.title')}</p>
      <p className="zr-wizard-subtitle">{t('wizard.subtitle')}</p>
      {statusLoaded && viaGateway ? <p className="zr-wizard-notice" data-tone="error">{t('wizard.remoteOnly')}</p> : null}
      {notWired ? <p className="zr-wizard-notice">{t('wizard.notWired')}</p> : null}

      <p className="zr-wizard-steps">
        {(['pick', 'configure', 'verify'] as const).map((name, index) => (
          <span key={name}>
            {index > 0 ? ' → ' : ''}
            <span data-current={step === name}>{`${index + 1}. ${stepLabel(name)}`}</span>
          </span>
        ))}
      </p>

      {step === 'pick' ? (
        <fieldset className="zr-wizard-paths">
          {([['caddy', 'wizard.path.caddy', 'wizard.path.caddyDesc'], ['external', 'wizard.path.external', 'wizard.path.externalDesc'], ['cloudflared', 'wizard.path.cloudflared', 'wizard.path.cloudflaredDesc']] as const).map(([value, nameKey, descKey]) => (
            <button
              key={value}
              type="button"
              className="zr-wizard-path"
              data-selected={path === value}
              disabled={disabled}
              onClick={() => setPath(value)}
            >
              <p className="zr-wizard-pathName">{t(nameKey)}</p>
              <p className="zr-wizard-pathDesc">{t(descKey)}</p>
            </button>
          ))}
        </fieldset>
      ) : null}

      {step === 'configure' ? (
        <>
          {path === 'external' ? (
            <div className="zr-wizard-field">
              <label className="zr-wizard-label" htmlFor="zr-wizard-server-url">{t('wizard.serverUrl')}</label>
              <input
                id="zr-wizard-server-url"
                className="zr-wizard-input"
                type="url"
                value={serverUrl}
                disabled={disabled}
                onChange={(event) => setServerUrl(event.target.value)}
              />
              <p className="zr-wizard-hint">{t('wizard.serverUrlHint')}</p>
              <button type="button" className="zr-wizard-link" disabled={disabled} onClick={() => setCard('proxy')}>
                {t('wizard.proxySnippet')}
              </button>
            </div>
          ) : (
            <>
              <div className="zr-wizard-field">
                <label className="zr-wizard-label" htmlFor="zr-wizard-domain">{t('wizard.domain')}</label>
                <input
                  id="zr-wizard-domain"
                  className="zr-wizard-input"
                  type="text"
                  value={domain}
                  disabled={disabled}
                  onChange={(event) => setDomain(event.target.value)}
                />
                <p className="zr-wizard-hint">{t('wizard.domainHint')}</p>
              </div>
              <div className="zr-wizard-field">
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
              <div className="zr-wizard-field">
                <label className="zr-wizard-label" htmlFor="zr-wizard-token">{t('wizard.cfToken')}</label>
                {/* type=password: the token is write-only — no echo, no
                    shoulder-surfing, never persisted in component state
                    beyond this box. */}
                <input
                  id="zr-wizard-token"
                  className="zr-wizard-input"
                  type="password"
                  value={cfToken}
                  disabled={disabled}
                  onChange={(event) => setCfToken(event.target.value)}
                />
                <p className="zr-wizard-hint">{t('wizard.cfTokenHint')}</p>
                <div className="zr-wizard-row">
                  <button type="button" className="zr-wizard-link" disabled={disabled} onClick={() => setCard('token')}>
                    {t('wizard.cfTokenHowTo')}
                  </button>
                  {path === 'cloudflared' ? (
                    <button type="button" className="zr-wizard-link" disabled={disabled} onClick={() => setCard('migrate')}>
                      {t('wizard.migrateEntry')}
                    </button>
                  ) : null}
                </div>
              </div>
            </>
          )}
          {tokenNotice !== undefined ? (
            <p className="zr-wizard-notice" data-tone={tokenNotice === 'saved' ? undefined : 'error'}>
              {t(tokenNotice === 'saved' ? 'wizard.token.saved' : 'wizard.token.saveFailed')}
            </p>
          ) : null}
          {path === 'caddy' && isValidPort(httpsPort.trim()) && httpsPort.trim() !== '443' ? (
            <p className="zr-wizard-hint">
              <button type="button" className="zr-wizard-link" disabled={disabled} onClick={() => setCard('portforward')}>
                {t('wizard.portForwardEntry')}
              </button>
            </p>
          ) : null}
          {formError !== null ? <p className="zr-wizard-notice" data-tone="error">{t(formError === 'bad-domain' ? 'wizard.badDomain' : formError === 'bad-port' ? 'wizard.badPort' : formError === 'missing-token' ? 'wizard.missingToken' : 'wizard.badServerUrl')}</p> : null}
          <div className="zr-wizard-row">
            <button type="button" disabled={disabled} onClick={() => setStep('pick')}>{t('wizard.back')}</button>
            <button type="button" disabled={disabled} onClick={() => { void advanceFromConfigure() }}>{t('wizard.next')}</button>
          </div>
        </>
      ) : null}

      {step === 'verify' ? (
        <>
          {(wizardStatus?.mode === 'caddy' || path === 'caddy') ? (
            <div className="zr-wizard-row" data-zen-remote="wizard-caddy-controls">
              <span className="zr-wizard-label">{t('wizard.ingress')}</span>
              <span className="zr-wizard-hint">
                {t(caddyState === 'running' ? 'wizard.caddy.running' : caddyState === 'stopped' ? 'wizard.caddy.stopped' : 'wizard.caddy.neverStarted')}
              </span>
              <button type="button" disabled={disabled} onClick={() => { void startCaddy() }}>{t('wizard.caddy.start')}</button>
              <button type="button" disabled={disabled || caddyState !== 'running'} onClick={() => { void stopCaddy() }}>{t('wizard.caddy.stop')}</button>
            </div>
          ) : null}
          {tunnelPath ? (
            <div className="zr-wizard-row" data-zen-remote="wizard-tunnel-controls">
              <span className="zr-wizard-label">{t('wizard.ingress')}</span>
              <span className="zr-wizard-hint">
                {t(tunnelState === 'running' ? 'wizard.tunnel.running' : tunnelState === 'stopped' ? 'wizard.tunnel.stopped' : 'wizard.tunnel.neverStarted')}
              </span>
              <button type="button" disabled={disabled || tunnelBusy} onClick={() => { void setupTunnelNow(adoptTunnelId) }}>
                {tunnelState === 'running' ? t('wizard.reverify') : t('wizard.tunnel.setup')}
              </button>
              <button type="button" disabled={disabled || tunnelState !== 'running'} onClick={() => { void (async () => {
                try {
                  await fetch(WIZARD_TUNNEL_STOP_ROUTE, { method: 'POST' })
                  setTunnelState('stopped')
                } catch { /* the poll corrects */ }
              })() }}>{t('wizard.tunnel.stop')}</button>
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
              {tunnelResult.existing.map((tunnel) => (
                <button key={tunnel.id} type="button" className="zr-wizard-link" disabled={disabled || tunnelBusy}
                  onClick={() => { setAdoptTunnelId(tunnel.id); void setupTunnelNow(tunnel.id) }}>
                  {t('wizard.tunnel.useExisting')}：{tunnel.name}（{tunnel.status}）
                </button>
              ))}
            </div>
          ) : null}
          {tunnelPath && tunnelResult !== undefined && tunnelResult.ok ? <p className="zr-wizard-notice">{t('wizard.tunnel.ok')}</p> : null}
          {tunnelPath && tunnelResult !== undefined && !tunnelResult.ok && tunnelResult.reason !== 'tunnel-conflict' ? (() => {
            const copy = tunnelFailureCopy(tunnelResult.reason, tunnelResult.detail)
            return <p className="zr-wizard-notice" data-tone="error">{t(copy.key as Parameters<typeof t>[0], copy.params)}</p>
          })() : null}
          {caddyStartError !== undefined ? (
            <p className="zr-wizard-notice" data-tone="error">
              {t('wizard.caddy.startFailed', { reason: t(caddyStartError.key as Parameters<typeof t>[0], caddyStartError.params) })}
              {caddyStartError.installUrl !== undefined ? (
                <> <a className="zr-wizard-link" href={caddyStartError.installUrl} target="_blank" rel="noreferrer">{caddyStartError.installUrl}</a></>
              ) : null}
            </p>
          ) : null}
          <ul className="zr-wizard-lights">
            {LIGHT_ORDER.map(({ key, light }) => (
              <li key={key} className="zr-wizard-light">
                <span className="zr-wizard-dot" data-state={lights[light]} />
                <span>{t(key)}</span>
                <span>{t(LIGHT_LABEL[lights[light]])}</span>
              </li>
            ))}
          </ul>

          {startResult !== undefined && !startResult.ok ? (() => {
            const copy = startFailureCopy(startResult)
            return <p className="zr-wizard-notice" data-tone="error">{t('wizard.startFailed', { reason: t(copy.key, copy.params) })}</p>
          })() : null}

          {startResult?.ok === true ? (
            <>
              <p className="zr-wizard-code">{startResult.pairingCode}</p>
              <p className="zr-wizard-countdown">{t('wizard.pairingSeconds', { seconds: String(pairingSecondsLeft(startResult.expiresAt, now)) })}</p>
              <svg className="zr-wizard-qr" data-usable={qr !== null} role="img" aria-label={t('wizard.qrHint')} viewBox={qr === null ? undefined : `0 0 ${qr.length * 4} ${qr.length * 4}`}>
                {qr === null ? null : <path d={qrSvgPath(qr, 4)} fill="#000" />}
              </svg>
              <p className="zr-wizard-hint">{t('wizard.qrHint')}</p>
            </>
          ) : null}

          {poll?.result === 'pass' ? <p className="zr-wizard-notice">{t('wizard.verifyPass', { deviceId: poll.deviceId })}</p> : null}
          {poll?.result === 'cookie-insecure' ? <p className="zr-wizard-notice" data-tone="error">{t('wizard.verifyCookieInsecure')}</p> : null}
          {poll?.result === 'code-expired' ? <p className="zr-wizard-notice" data-tone="error">{t('wizard.verifyExpired')}</p> : null}
          {poll?.result === 'stale' ? <p className="zr-wizard-notice" data-tone="error">{t('wizard.verifyStale')}</p> : null}
          {poll?.result === 'pending' || poll?.result === 'not-started' ? <p className="zr-wizard-hint">{t('wizard.verifyPending')}</p> : null}
          {poll === undefined && startResult === undefined ? <p className="zr-wizard-hint">{t('wizard.verifyNotStarted')}</p> : null}

          <div className="zr-wizard-row">
            <button type="button" disabled={disabled} onClick={() => setStep('configure')}>{t('wizard.back')}</button>
            <button type="button" disabled={disabled} onClick={() => { void startVerification() }}>{verified ? t('wizard.reverify') : t('wizard.startVerify')}</button>
          </div>
        </>
      ) : null}

      {card === 'proxy' ? (
        <ProxyCard
          t={t}
          domain={domain.trim() || 'dsh.example.com'}
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
              try {
                const response = await fetch(WIZARD_CF_TOKEN_ROUTE, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ token }),
                })
                setTokenNotice(response.ok ? 'saved' : 'failed')
              } catch {
                setTokenNotice('failed')
              }
              // Either way the paste box is done with the value.
              setCfToken('')
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
