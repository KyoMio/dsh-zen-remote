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
 */

/** Wizard route constants — mirror of src/wizard/routes.ts. */
export const WIZARD_STATUS_ROUTE = '/_dsh/zen-remote/admin/wizard/status'
export const WIZARD_VERIFY_ROUTE = '/_dsh/zen-remote/admin/wizard/verify'

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

/** The three wizard steps: pick a path, fill its form, verify end to end. */
export type WizardStep = 'pick' | 'configure' | 'verify'

/** The three public-ingress paths (the row's `ingressMode` minus `'off'`). */
export type WizardPath = 'caddy' | 'external' | 'cloudflared'

/** Where the wizard opens: a configured ingress jumps straight to verify. */
export function initialStep(status: WizardStatusBody | undefined): WizardStep {
  return status !== undefined && status.mode !== 'off' ? 'verify' : 'pick'
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
}): WizardLights {
  const poll = input.poll
  const publicFail = poll !== undefined && poll.result !== 'pass' && !VERIFY_PENDING_RESULTS.has(poll.result)
  return {
    gateway: input.gatewayReachable ? 'pass' : 'fail',
    publicUrl: poll?.result === 'pass' ? 'pass' : publicFail ? 'fail' : 'pending',
    pairing: poll?.result === 'pass' ? 'pass' : poll?.result === 'cookie-insecure' ? 'fail' : 'pending',
  }
}

/** Pairing-code countdown, whole seconds, never negative. */
export function pairingSecondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

// --- the reverse-proxy snippet templates (mirror of proxy-snippets.ts) -----------

export interface SnippetInput {
  domain: string
  upstreamHost: string
  upstreamPort: number
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
  return [
    '# 这段放在 http {} 层（若已有同名 map 则跳过）',
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
    '        client_max_body_size 128m;',
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
  return [
    '在 Lucky 的「Web 服务」里新建一条规则，监听 443 端口，绑定你的域名。',
    `后端（反代目标）填 http://${parts.upstream}:${parts.port}，开启 WebSocket 支持。`,
    '打开「万事大吉」开关（放行全部路径），保存即可生效。',
  ]
}

/** The snippet kinds the reverse-proxy card tabs over, in tab order. */
export const SNIPPET_KINDS = ['nginx', 'caddy', 'lucky'] as const
export type SnippetKind = (typeof SNIPPET_KINDS)[number]
