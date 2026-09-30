/**
 * Staged configuration form for the `dsh-zen-remote` plugin row, in the same
 * shape the dsh-llm-verifier page uses (a control stages what the user types,
 * one save writes every staged edit as a single revision-fenced path mutation
 * through the shared `configForms` form). Browser-import-free so tests drive
 * it directly:
 *
 * - `deriveSettingsView(status)` maps the `GET /_dsh/zen-remote/admin/status`
 *   body (T14's same-origin route wrapping the gateway's local admin API) into
 *   what the settings block renders: per-field effective value + source layer,
 *   the device list, the live pairing code with its remaining seconds, and the
 *   `viaGateway` flag that disables every server-local operation.
 * - `deriveClientStatusView(status)` maps the `GET /_dsh/zen-remote/client/status`
 *   body (T16's sub-client probe) into the client group's connection line.
 * - `ZenRemoteSettingsForm` stages the row-layer field edits and saves them as
 *   one `mutate(ops, expectedRevision)` call, and owns the two DIRECT writes
 *   of the client group (pairing write / token clear) plus the device token's
 *   configured flag read from the describe view's secrets sidecar. Since T17
 *   it also carries the page's two-level role decision — the saved row role
 *   first, the client-config probe as fallback — and the `restartPending`
 *   flag behind the "saving reloads the plugin" note.
 *
 * The wire contract lives here because the host half that serves it is a
 * separate task; the shapes mirror `lib/lan-gate-server.cjs`'s status payload
 * (devices / pairing) plus the T14 envelope (ok / gateway / config / viaGateway).
 */

import { RESTART_FIELDS } from '../restart-fields.ts'

// --- wire shapes -----------------------------------------------------------

/** Where a resolved field value came from (mirror of src/config.ts's union; the client half cannot import the host module). */
export type ConfigSource = 'env' | 'row' | 'file' | 'default'

/** One paired gateway device, as the gateway's status payload lists it. */
export interface AdminDevice {
  id: string
  name: string
  role: 'web' | 'desktop-client'
  kind: 'auto' | 'phone' | 'desktop'
  createdAt: number
  lastSeen: number
  ua?: string
  hasPush: boolean
}

/** The one currently-live pairing code, if any. */
export interface AdminPairing {
  code: string
  expiresAt: number
  role: 'web' | 'desktop-client'
}

/**
 * The gateway's `/lan-gate/status` reply, relayed verbatim inside
 * `admin/status`'s `gateway` field (see lib/lan-gate-server.cjs's
 * statusHandler — this mirror keeps only what the settings block reads).
 */
export interface GatewayStatus {
  state?: string
  port?: number
  target?: string
  devices?: AdminDevice[]
  pairing?: AdminPairing | null
  pushSubscriptions?: number
}

/**
 * The `GET /_dsh/zen-remote/admin/status` body, exactly as src/admin-routes.ts
 * answers it: the gateway payload lives NESTED under `gateway` (null when the
 * gateway did not answer healthily) and `gatewayStatus` is the HTTP status the
 * route saw (`null` when there was no answer at all).
 */
export interface AdminStatusBody {
  ok?: boolean
  gateway?: GatewayStatus | null
  gatewayReachable?: boolean
  gatewayStatus?: number | null
  config?: {
    values?: Record<string, unknown>
    sources?: Record<string, string>
  }
  viaGateway?: boolean
}

/** Same-origin admin routes the settings block talks to (host half: T14). */
export const ADMIN_STATUS_ROUTE = '/_dsh/zen-remote/admin/status'
export const ADMIN_PAIR_ROUTE = '/_dsh/zen-remote/admin/pair'
export const ADMIN_ACTION_ROUTE = '/_dsh/zen-remote/admin/action'
export const ADMIN_PUSH_TEST_ROUTE = '/_dsh/zen-remote/admin/push-test'

/** Same-origin client routes the sub-client block talks to (host half: T16). */
export const CLIENT_CLAIM_ROUTE = '/_dsh/zen-remote/client/claim'
export const CLIENT_STATUS_ROUTE = '/_dsh/zen-remote/client/status'
/** T43: one immediate reconnect — answered 409 unless the client is offline. */
export const CLIENT_RECONNECT_ROUTE = '/_dsh/zen-remote/client/reconnect'

/** The lightweight client-facing config route (host half, both roles): the
 * settings page's FALLBACK role probe (T17) — it registers wherever a
 * webServer exists, and since T17 its body carries the effective `role`
 * (resolveConfig's merged value, nothing sensitive). */
export const CLIENT_CONFIG_ROUTE = '/_dsh/mobile-nav/client-config'

/** The body of `GET /_dsh/mobile-nav/client-config` — the interface-half knobs
 * the client bundle reads, plus (T17) the effective role the settings page
 * falls back to. */
export interface ClientConfigBody {
  role?: unknown
  turnFoldDesktop?: boolean
  keyboardLiftRatio?: number
  keyboardLiftMaxPx?: number
  keyboardSafetyPadPx?: number
}

/** Field name of the row secret the pairing flow writes (never echoed back
 * anywhere; the describe view's secrets sidecar is the only "is it set"). */
export const DEVICE_TOKEN_FIELD = 'deviceToken'

// --- client-half wire shapes -------------------------------------------------

/**
 * The `GET /_dsh/zen-remote/client/status` body, exactly as
 * src/client-routes.ts answers it: `serverUrl` is present only once a token
 * exists (the unpaired answer is `{ state: 'unpaired' }` alone). The token
 * itself never rides any status response. The T43 diagnostics fields ride
 * only on a failed live connect of a wired relay client; `intercept` (T23b)
 * and `compat` (T42) are rendered only when the body carries them — earlier
 * servers answer neither.
 */
export interface ClientStatusBody {
  /** The probe vocabulary (`connected` / `unreachable` / `revoked` /
   * `unexpected`), the row's two own answers (`unpaired` / `invalid-url`),
   * the relay verdicts (`revoked` / `incompatible`) — and, since the
   * relay-wired route reports the relay client's own state verbatim, the
   * `online` / `offline` words too ({@link deriveClientStatusView} maps
   * them; T55). */
  state?: string
  serverUrl?: string
  serverName?: unknown
  /** Epoch ms of the relay client's next automatic reconnect (offline only). */
  nextRetryAt?: unknown
  /** The error code of the last failure — a code, never a message or URL. */
  lastError?: unknown
  /**
   * The SERVER's record of THIS device's name (T59, presence-gated like the
   * diagnostics fields — older servers answer without it). The settings page
   * follows it into the row while the user is not editing the field.
   */
  deviceName?: unknown
  /** T23b request-interceptor diagnostics (provisional shape; presence-gated). */
  intercept?: unknown
  /** T42 relay compat diagnostics: `{ identical: string[], different:
   * string[], unavailable: string[], incompatibleCalls: { time: number,
   * endpoint: string, code: string }[] }` (presence-gated). */
  compat?: unknown
}

/** One remote-call failure line in the diagnostics lists. `time` is epoch
 * milliseconds — ISO-stamped rings are parsed at derive time; `method`
 * carries the wire's method-or-endpoint name. */
export interface ClientDiagFailureView {
  time: number
  method: string
  code: string
}

/**
 * T23b interceptor diagnostics as the block renders them. The wire field is
 * presence-gated: `undefined` here means the body carried none (an older
 * server), and the whole interceptor group stays hidden.
 */
export interface ClientInterceptView {
  installed: boolean
  /** Shape-detection failure reasons — non-empty means remote features are off. */
  reasons: string[]
  /** The most recent remote call failures (at most 10). */
  recentFailures: ClientDiagFailureView[]
}

/** T42 compat diagnostics as the block renders them (presence-gated like {@link ClientInterceptView}). */
export interface ClientCompatView {
  /** Names of the groups whose fingerprints differ. */
  mismatchedGroups: string[]
  /** The most recent incompatible calls (at most 10). */
  recentCalls: ClientDiagFailureView[]
}

/** One client connection as the block renders it. */
export interface ClientConnectionView {
  state: 'unpaired' | 'connected' | 'revoked' | 'unreachable' | 'unexpected' | 'invalid-url' | 'incompatible'
  serverUrl: string
  serverName: string
  /** Verbatim from the body when it carried a finite number; the countdown
   * math happens at render time against the live clock. */
  nextRetryAt: number | undefined
  /** The last failure's code, '' when none is reported. */
  lastError: string
  /** The SERVER's record of this device's name (T59): '' when the body did
   * not carry one — empty means "nothing to follow". */
  deviceName: string
  intercept: ClientInterceptView | undefined
  compat: ClientCompatView | undefined
}

const CLIENT_STATES: readonly ClientConnectionView['state'][] = ['unpaired', 'connected', 'revoked', 'unreachable', 'unexpected', 'invalid-url', 'incompatible']

/** Wire `state` words the status route can answer that are NOT the view
 * vocabulary (T55): the relay client's `online` is the page's `connected`,
 * and its `offline` is the probe vocabulary's `unreachable` — the offline
 * line, whose countdown the body's `nextRetryAt` backs when present. */
const WIRE_STATE_ALIASES: Readonly<Record<string, ClientConnectionView['state']>> = {
  online: 'connected',
  offline: 'unreachable',
}

/** At most `cap` strings out of an array-shaped value; anything else is none. */
function stringListOf(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string').slice(0, cap)
}

/**
 * The MOST RECENT 10 diagnostics failure rows out of an array-shaped value
 * (the rings are oldest-first, so the tail is the fresh end). Both wire
 * dialects render: the T42 compat ring stamps epoch-millisecond numbers
 * under `endpoint`, the T23b interceptor ring ISO strings under the same
 * key — times parse leniently either way, and an unparseable value renders
 * as 0 rather than dropping the row.
 */
function failureListOf(value: unknown): ClientDiagFailureView[] {
  if (!Array.isArray(value)) return []
  const rows: ClientDiagFailureView[] = []
  for (const entry of value.slice(-10)) {
    const record = asRecord(entry)
    let time = 0
    if (typeof record.time === 'number' && Number.isFinite(record.time)) time = record.time
    else if (typeof record.time === 'string') {
      const parsed = Date.parse(record.time)
      if (Number.isFinite(parsed)) time = parsed
    }
    rows.push({
      time,
      method: asStringSet(record.method ?? record.endpoint),
      code: asStringSet(record.code),
    })
  }
  return rows
}

/** T23b interceptor block, only when the body carried the field at all. */
function deriveInterceptView(value: unknown): ClientInterceptView | undefined {
  if (value === undefined || value === null) return undefined
  const record = asRecord(value)
  return {
    installed: record.installed === true,
    reasons: stringListOf(record.reasons, 20),
    recentFailures: failureListOf(record.recentFailures),
  }
}

/** T42 compat block, only when the body carried the field at all. The wire
 * names are the status route's (`different` / `incompatibleCalls`); the view
 * keeps the render-side names the block was written against. */
function deriveCompatView(value: unknown): ClientCompatView | undefined {
  if (value === undefined || value === null) return undefined
  const record = asRecord(value)
  return {
    mismatchedGroups: stringListOf(record.different, 20),
    recentCalls: failureListOf(record.incompatibleCalls),
  }
}

/**
 * Map one `client/status` body into the view the client group renders.
 * Tolerant like {@link deriveSettingsView}: an unexpected shape degrades to
 * "unpaired" instead of throwing into the plugin page.
 */
export function deriveClientStatusView(body: ClientStatusBody): ClientConnectionView {
  const safe = body !== null && typeof body === 'object' ? body : {}
  // T55: the route answers TWO vocabularies. The probe fallback speaks the
  // view's own words (connected / unreachable / …, ProbeState), but the
  // relay-wired route reports the RELAY client's state — `online` verbatim
  // (client-routes.ts sends `state: relay.state` on the cached-verdict and
  // fresh-connect paths) — which the view never listed, so a PAIRED, CONNECTED
  // client fell through the unknown-state bucket into "未配对" while the
  // diagnostics below it showed live relay calls. `offline` rides the same
  // mapping to the probe word for it; anything else unknown still degrades
  // to `unpaired`.
  const rawState = typeof safe.state === 'string' ? safe.state : ''
  const state = CLIENT_STATES.includes(rawState as ClientConnectionView['state'])
    ? rawState as ClientConnectionView['state']
    : WIRE_STATE_ALIASES[rawState] ?? 'unpaired'
  const nextRetryAt = typeof safe.nextRetryAt === 'number' && Number.isFinite(safe.nextRetryAt)
    ? safe.nextRetryAt
    : undefined
  return {
    state,
    serverUrl: typeof safe.serverUrl === 'string' ? safe.serverUrl : '',
    serverName: typeof safe.serverName === 'string' ? safe.serverName : '',
    nextRetryAt,
    lastError: typeof safe.lastError === 'string' ? safe.lastError : '',
    deviceName: typeof safe.deviceName === 'string' ? safe.deviceName : '',
    intercept: deriveInterceptView(safe.intercept),
    compat: deriveCompatView(safe.compat),
  }
}

/**
 * Which connection line the block renders (T43 diagnostics wording, chosen
 * as a pure descriptor so the copy table and the countdown math stay
 * testable without a browser): connected prefers the handshake's server
 * name; any verdict the body backs with a `nextRetryAt` is OFFLINE first —
 * the relay client is mid-retry and the line counts down to it, whether the
 * probe classified the failure `unreachable` or `unexpected` (T43-fix);
 * without a `nextRetryAt` the two map one plain copy each. The rest map one
 * state each.
 */
export type ClientStatusLine =
  | { kind: 'connectedName', serverName: string }
  | { kind: 'connected', serverUrl: string }
  | { kind: 'offlineRetry', seconds: number }
  | { kind: 'offlineRetrySoon' }
  | { kind: 'unreachable' }
  | { kind: 'revoked' }
  | { kind: 'incompatible' }
  | { kind: 'unexpected' }
  | { kind: 'invalidUrl' }
  | { kind: 'unpaired' }

export function clientStatusLineOf(view: ClientConnectionView, now: number): ClientStatusLine {
  switch (view.state) {
    case 'connected':
      return view.serverName !== ''
        ? { kind: 'connectedName', serverName: view.serverName }
        : { kind: 'connected', serverUrl: view.serverUrl }
    case 'unreachable':
    case 'unexpected':
      if (view.nextRetryAt !== undefined) {
        const seconds = Math.max(0, Math.ceil((view.nextRetryAt - now) / 1000))
        return seconds > 0 ? { kind: 'offlineRetry', seconds } : { kind: 'offlineRetrySoon' }
      }
      return view.state === 'unexpected' ? { kind: 'unexpected' } : { kind: 'unreachable' }
    case 'revoked': return { kind: 'revoked' }
    case 'incompatible': return { kind: 'incompatible' }
    case 'invalid-url': return { kind: 'invalidUrl' }
    default: return { kind: 'unpaired' }
  }
}

/** The `POST /_dsh/zen-remote/client/claim` body (T16's pairing round-trip;
 * on success `token` is the gateway-minted device token — it appears exactly
 * once, on its way into the row's secret field). */
export interface ClaimRouteBody {
  ok?: boolean
  token?: unknown
  deviceId?: unknown
  deviceName?: unknown
  /** The normalized address the backend validated — what the form writes. */
  serverUrl?: unknown
  code?: string
  message?: string
  retryAfterMs?: number
}

/** What the pairing-code box keeps as its draft: uppercase, no spaces or
 * hyphens (the gateway strips every other character at claim time anyway). */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '')
}

/**
 * Whether the settings page may follow the SERVER's record of this device's
 * name into the row (T59): the body carried a name, it differs from the row
 * (nothing to do otherwise — and this equality is the anti-bounce half: the
 * page's own write echoes back through client/status with both sides equal),
 * and the user has no staged draft in the field (their edit wins until they
 * save — a follow mid-typing would clobber it).
 */
export function shouldFollowServerDeviceName(deviceName: string, rowName: string, hasDraft: boolean): boolean {
  return deviceName !== '' && deviceName !== rowName && !hasDraft
}

/**
 * Latest-wins sequencing for the status loads: every request takes a ticket,
 * and only the newest ticket may still apply its result. An earlier request
 * that answers LATE is dropped, so a stale body can never overwrite a fresh
 * one (a revoked device reappearing, an old "no pairing code" answer wiping
 * a just-minted code, an unpair racing a refresh).
 */
export interface LatestGate {
  /** Issue the ticket for one new in-flight request. */
  next(): number
  /** Whether that ticket is still the newest issued one. */
  isLatest(ticket: number): boolean
}

export function createLatestGate(): LatestGate {
  let current = 0
  return {
    next: () => { current += 1; return current },
    isLatest: (ticket) => ticket === current,
  }
}

// --- T16-fix 3: the page's role and status-source decisions -------------------

/**
 * The SAVED role of the plugin row, read from the configForms snapshot's row
 * document — the settings page's FIRST role signal (T16-fix 3). The resolved
 * role an admin/status body reports is unusable here: a client deployment has
 * no admin route at all, and a stale kept body pinned the page to the old
 * role after a switch. `value` is the schema-resolved section the Host
 * accepted; a row value that only lives in the raw user layer reads from
 * there. Since T17 every row field is volatile, so the form (and this
 * snapshot) carries every stored field — `role` included, with any volatile
 * wrapper already peeled by the host's plainConfig (the dsh-settings
 * describe path calls `value.get()` recursively before the wire).
 *
 * `undefined` when NEITHER layer carries a role: the field's value lives only
 * in a lower layer (`lan-gate.config.json`) or nowhere. That is not "host" —
 * the caller falls back to the effective role the client-config route
 * reports ({@link settingsPollOf}), because a file-layer client row must
 * still render the client page.
 */
export function savedRowRole(snapshot: { value?: unknown, user?: unknown }): 'host' | 'client' | undefined {
  if (asRecord(snapshot.value).role === 'client') return 'client'
  if (asRecord(snapshot.user).role === 'client') return 'client'
  if (asRecord(snapshot.value).role === 'host') return 'host'
  if (asRecord(snapshot.user).role === 'host') return 'host'
  return undefined
}

/**
 * The EFFECTIVE role for one scope snapshot — the shared two-level decision
 * every role-aware surface uses (the settings page via {@link settingsPollOf},
 * the T33b session-sharing parts through the remote-share registration):
 * while the namespace mirror is still loading the role is not knowable
 * (`'unknown'` — a client deployment must never see a wasted `admin/*` 404);
 * a snapshot whose row carries a role decides from it; a row-silent snapshot
 * falls back to `probed`, the effective role fetched from
 * `/_dsh/mobile-nav/client-config` (T17: the route carries the merged role),
 * and stays `'unknown'` until that probe answers.
 */
export function settingsRoleOf(
  status: 'loading' | 'ready' | 'unavailable',
  snapshot: { value?: unknown, user?: unknown },
  probed?: 'host' | 'client',
): 'unknown' | 'host' | 'client' {
  if (status === 'loading') return 'unknown'
  return savedRowRole(snapshot) ?? probed ?? 'unknown'
}

/**
 * Which status source the page polls for one scope snapshot —
 * {@link settingsRoleOf} mapped onto poll sources (`'unknown'` polls
 * nothing). See there for the decision.
 */
export function settingsPollOf(
  status: 'loading' | 'ready' | 'unavailable',
  snapshot: { value?: unknown, user?: unknown },
  probed?: 'host' | 'client',
): 'none' | 'admin' | 'client' {
  const role = settingsRoleOf(status, snapshot, probed)
  if (role === 'unknown') return 'none'
  return role === 'client' ? 'client' : 'admin'
}

// --- T17: the plugin-reload note ------------------------------------------------

/**
 * The row fields whose changed value reloads the plugin row after a save —
 * re-exported from src/restart-fields.ts, the single list the host half's
 * restart watcher fingerprints too (T17b collapsed the two copies; the leaf
 * module is dependency-free so the client bundler can inline it). Only the
 * fields this page edits can ever stage a draft here — `targetPort` /
 * `pushEvents` are not page fields — but the list is the full shared set so
 * a host-side change surfaces in the diff.
 */
export { RESTART_FIELDS } from '../restart-fields.ts'

// --- staged form (row layer) -----------------------------------------------

/** One path-addressed edit a save sends (the wire `SettingsPathOpView` shape). */
export type SettingsFormOp =
  | { op: 'set', path: string[], value: unknown }
  | { op: 'unset', path: string[] }

/** Structural subset of the shared `ConfigForm` snapshot this form reads. */
export interface SettingsFormScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: Record<string, unknown> | undefined
  /** Composition layer; what a field reverts to once cleared. */
  base: unknown
  /** Raw user layer as stored; field PRESENCE here marks an override. */
  user: unknown
  /** Revision fencing the next write; sent back as `expectedRevision`. */
  revision: number | undefined
  writable: boolean
}

/**
 * The form face this controller stages over (structural subset of
 * ui-settings' `ConfigForm` — declared locally because this package does not
 * depend on the ui-settings types).
 */
export interface SettingsFormScope {
  getSnapshot(): SettingsFormScopeSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly SettingsFormOp[], expectedRevision?: number): Promise<boolean>
}

/**
 * One secret path in the describe view's sidecar: the path plus whether it
 * is set — the VALUE itself never rides any describe surface.
 */
export interface DescribeSecret {
  path: string[]
  set: boolean
}

/**
 * The `configForms.describe()` mirror (structural, like {@link ConfigFormsLike}
 * — the dsh-client-ui-settings package is not a dependency). Read only for
 * the secrets sidecar: whether the row's `deviceToken` is set.
 */
export interface ConfigFormsDescribe {
  getSnapshot(): {
    view?: { namespaces?: ReadonlyArray<{ ns: string, secrets?: ReadonlyArray<DescribeSecret> }> }
  }
  subscribe(listener: () => void): () => void
}

/**
 * The `configForms` service face this plugin uses, mirrored onto the cordis
 * Context. Declared locally (the dsh-client-ui-settings package is not a
 * dependency — same trick as the local `UiWorkspaceLike`): the runtime
 * instance is provided by the host, and the lazy `ctx.inject(['configForms'], …)`
 * in register-settings keeps a composition without the service loadable.
 */
export interface ConfigFormsLike {
  get(entryId: string): SettingsFormScope
  describe(): ConfigFormsDescribe
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
}

/** The write one staged draft performs when the form is saved. */
export type SettingsFieldWrite = { kind: 'set', value: unknown } | { kind: 'clear' }

/** How one field converts between its stored value and draft text. */
export interface SettingsFieldSpec {
  field: string
  format(value: unknown): string
  /** The staged write, or undefined when the draft is not a value this field accepts. */
  parse(text: string): SettingsFieldWrite | undefined
}

/** Free-text field: an empty draft clears, so the field re-inherits its default. */
export function textField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'string' ? value : ''),
    parse: (text) => (text === '' ? { kind: 'clear' } : { kind: 'set', value: text }),
  }
}

/** Whole-number field within inclusive bounds; empty clears, anything else out of range blocks the save. */
export function intField(field: string, min: number, max: number): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : ''),
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' }
      const n = Number(text)
      if (!Number.isInteger(n) || n < min || n > max) return undefined
      return { kind: 'set', value: n }
    },
  }
}

/** Finite number in (min, max] — the `idleHours` shape: zero excluded, 8760 allowed. */
export function hoursField(field: string, max: number): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : ''),
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' }
      const n = Number(text)
      if (!Number.isFinite(n) || n <= 0 || n > max) return undefined
      return { kind: 'set', value: n }
    },
  }
}

/** `serverName`: an empty draft clears; a blank-but-nonempty draft or one over
 * the 40-character cap is invalid and blocks the save (src/config.ts clips at
 * resolve time, so an over-long write would silently lose its tail). */
export function nameField(field: string, max: number): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'string' ? value : ''),
    parse: (text) => {
      if (text === '') return { kind: 'clear' }
      if (text.trim() === '' || text.length > max) return undefined
      return { kind: 'set', value: text }
    },
  }
}

/**
 * The name one pairing claim registers under (T57): the shared 设备名称
 * field's CURRENT displayed value — a staged draft when one exists — used
 * only when it is a value a save would WRITE ({@link nameField} rules: an
 * empty draft means nothing stored, a blank or over-cap draft is invalid),
 * otherwise the default device-name copy. The fallback is load-bearing since
 * T55: a client page reads no admin baseline, so an unstored name displays
 * EMPTY and the claim must still carry a usable name.
 */
export function claimDeviceNameOf(displayText: string, fallback: string): string {
  return nameField('serverName', SERVER_NAME_MAX).parse(displayText)?.kind === 'set'
    ? displayText
    : fallback
}

/** One-of field over a fixed vocabulary (rendered as a select). */
export function oneOfField(field: string, options: readonly string[]): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'string' && options.includes(value) ? value : options[0] ?? ''),
    parse: (text) => (options.includes(text) ? { kind: 'set', value: text } : undefined),
  }
}

/** Boolean field staged as 'true'/'false' draft text (rendered as a checkbox). */
export function boolField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (value === true ? 'true' : 'false'),
    parse: (text) => (text === 'true' || text === 'false' ? { kind: 'set', value: text === 'true' } : undefined),
  }
}

/** Names of the row fields the settings page edits, in group order. */
export type SettingsFieldName =
  | 'role'
  | 'host'
  | 'port'
  | 'trustedProxies'
  | 'rateLimit'
  | 'vapidSubject'
  | 'pushSummary'
  | 'pushTurnEnd'
  | 'pushTool'
  | 'pushDebounceMs'
  | 'lang'
  | 'serverName'
  | 'idleHours'
  | 'autoShareNewSessions'

/** Longest legal `serverName`, mirroring src/config.ts's cap. */
export const SERVER_NAME_MAX = 40

/** Upper bound of `idleHours`, mirroring src/config.ts. */
export const IDLE_HOURS_MAX = 8760

/** The row fields the settings page edits, in render order. */
export const SETTINGS_FIELDS: readonly SettingsFieldSpec[] = [
  oneOfField('role', ['host', 'client']),
  textField('host'),
  intField('port', 1, 65535),
  textField('trustedProxies'),
  intField('rateLimit', 1, Number.MAX_SAFE_INTEGER),
  textField('vapidSubject'),
  boolField('pushSummary'),
  boolField('pushTurnEnd'),
  boolField('pushTool'),
  intField('pushDebounceMs', 0, Number.MAX_SAFE_INTEGER),
  oneOfField('lang', ['auto', 'zh', 'en']),
  nameField('serverName', SERVER_NAME_MAX),
  hoursField('idleHours', IDLE_HOURS_MAX),
  boolField('autoShareNewSessions'),
]

// --- the status -> view mapping ---------------------------------------------

/**
 * Whether the settings page's server-local operations (pairing, device
 * management, the push probe) are usable: only once a status load answered
 * AND it answered as the local machine (`viaGateway: false`). Everything
 * else — no answer yet, or the page opened through the gateway — keeps them
 * disabled. Pure so the check script pins all three cases.
 */
export function localOpsAllowed(view: SettingsView | undefined): boolean {
  return view?.viaGateway === false
}

/** Per-field presentation facts the block renders next to each control. */
export interface SettingsFieldView {
  /** Effective value (the resolved `config.values[field]`). */
  value: unknown
  /** Layer that supplied the effective value. */
  source: ConfigSource
  /** `source === 'env'`: shown locked, edits would be shadowed. */
  locked: boolean
  /** `source === 'file'`: the legacy lan-gate.config.json supplies this. */
  fromFile: boolean
  /** The row layer stores this field but another layer supplied the value —
   * i.e. the saved value was illegal and resolveConfig skipped it. */
  savedRowInvalid: boolean
}

/** One device row the block renders. */
export interface SettingsDeviceView {
  id: string
  name: string
  role: 'web' | 'desktop-client'
  kind: 'auto' | 'phone' | 'desktop'
  lastSeen: number
  hasPush: boolean
}

/** The live pairing code with its countdown, or null when none is active. */
export interface SettingsPairingView {
  code: string
  role: 'web' | 'desktop-client'
  remainingSeconds: number
}

/** Everything the settings block renders, derived from one status body. */
export interface SettingsView {
  /** The status route answered ok. */
  available: boolean
  /** Which half this DSH process runs as (`client` shows only the role group). */
  role: 'host' | 'client'
  /** Opened through the gateway (a remote device): server-local operations disabled. */
  viaGateway: boolean
  /** Whether the gateway child answers. */
  gatewayReachable: boolean
  gatewayPort: number | undefined
  gatewayTarget: string | undefined
  /** The probe status the admin route saw from the gateway; null = no answer. */
  gatewayStatus: number | null
  /** `gatewayStatus` is a non-2xx reply: the status line shows the abnormal message instead. */
  gatewayAbnormal: boolean
  fields: Record<SettingsFieldName, SettingsFieldView>
  devices: SettingsDeviceView[]
  pairing: SettingsPairingView | null
}

export interface DeriveSettingsOptions {
  /** Clock for the pairing countdown; defaults to `Date.now()`. */
  now?: number
  /** The shared form snapshot's raw user layer; field presence marks a row-layer override. */
  rowUser?: unknown
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const asStringSet = (value: unknown): string =>
  typeof value === 'string' ? value : ''

/**
 * Map one `admin/status` body into the view the settings block renders.
 * Tolerant by design: every wire field is optional, an unexpected shape
 * degrades to the conservative rendering (status unavailable, gateway down,
 * no devices, no pairing) instead of throwing into the plugin page.
 */
export function deriveSettingsView(status: AdminStatusBody, options: DeriveSettingsOptions = {}): SettingsView {
  const now = options.now ?? Date.now()
  const values = asRecord(status.config?.values)
  const sources = asRecord(status.config?.sources)
  const rowUser = asRecord(options.rowUser)
  // The gateway payload rides NESTED (`gateway` = /lan-gate/status verbatim);
  // null means the gateway did not answer healthily — devices and the pairing
  // code both render as empty then.
  const gateway = status.gateway === null || typeof status.gateway !== 'object' ? undefined : status.gateway

  const fields = {} as Record<SettingsFieldName, SettingsFieldView>
  for (const spec of SETTINGS_FIELDS) {
    const rawSource = sources[spec.field]
    const source: ConfigSource =
      rawSource === 'env' || rawSource === 'row' || rawSource === 'file' || rawSource === 'default'
        ? rawSource
        : 'default'
    fields[spec.field as SettingsFieldName] = {
      value: values[spec.field],
      source,
      locked: source === 'env',
      fromFile: source === 'file',
      // Being shadowed by an environment variable is not "invalid" (the lock
      // badge already says so) — only a skipped row value under a non-env
      // winner marks the saved value as rejected by resolveConfig.
      savedRowInvalid: Object.hasOwn(rowUser, spec.field) && source !== 'row' && source !== 'env',
    }
  }

  const devices: SettingsDeviceView[] = (Array.isArray(gateway?.devices) ? gateway.devices : [])
    .map((device) => {
      const record = asRecord(device)
      const kind = record.kind === 'phone' ? 'phone' as const : record.kind === 'desktop' ? 'desktop' as const : 'auto' as const
      return {
        id: asStringSet(record.id),
        name: asStringSet(record.name),
        role: record.role === 'desktop-client' ? 'desktop-client' as const : 'web' as const,
        kind,
        lastSeen: typeof record.lastSeen === 'number' && Number.isFinite(record.lastSeen) ? record.lastSeen : 0,
        hasPush: record.hasPush === true,
      }
    })
    .filter((device) => device.id !== '')

  const rawPairing = asRecord(gateway?.pairing)
  const code = asStringSet(rawPairing.code)
  const expiresAt = rawPairing.expiresAt
  const pairing: SettingsPairingView | null =
    code !== '' && typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > now
      ? {
          code,
          role: rawPairing.role === 'desktop-client' ? 'desktop-client' : 'web',
          remainingSeconds: Math.max(0, Math.ceil((expiresAt - now) / 1000)),
        }
      : null

  const gatewayStatus = typeof status.gatewayStatus === 'number' && Number.isFinite(status.gatewayStatus)
    ? status.gatewayStatus
    : null
  return {
    available: status.ok === true,
    role: values.role === 'client' ? 'client' : 'host',
    viaGateway: status.viaGateway === true,
    gatewayReachable: status.gatewayReachable === true,
    gatewayPort: typeof gateway?.port === 'number' && Number.isFinite(gateway.port) ? gateway.port : undefined,
    gatewayTarget: typeof gateway?.target === 'string' ? gateway.target : undefined,
    gatewayStatus,
    // A non-null, non-2xx probe reply: the status line swaps to the abnormal message.
    gatewayAbnormal: gatewayStatus !== null && !(gatewayStatus >= 200 && gatewayStatus < 300),
    fields,
    devices,
    pairing,
  }
}

// --- the controller ----------------------------------------------------------

/** Card-level state the shared form frame renders. */
export interface SettingsFormShellState {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}

/** One control's state as its field renders it. */
export interface SettingsFieldState {
  text: string
  overridden: boolean
  invalid: boolean
  /** A clear is staged: the box keeps showing the CURRENT value — the next
   * layer's value only exists after the save — and the field renders the
   * "reverts on save" hint instead of a fake preview. */
  cleared: boolean
  /** `admin/status` reported this field's value locked by an environment variable. */
  locked: boolean
}

/** The row secret's face: presence only, never a value. */
export interface SettingsSecretFieldState {
  /** The describe view's secrets sidecar reports `deviceToken` set. */
  configured: boolean
}

/** The whole staged-form snapshot the page renders. */
export interface ZenRemoteFormState extends SettingsFormShellState {
  /** The shared form's scope sync state, reactively exposed so the page's
   * role probe can wait out the mirror's loading phase. */
  scopeStatus: 'loading' | 'ready' | 'unavailable'
  role: SettingsFieldState
  host: SettingsFieldState
  port: SettingsFieldState
  trustedProxies: SettingsFieldState
  rateLimit: SettingsFieldState
  vapidSubject: SettingsFieldState
  pushSummary: SettingsFieldState
  pushTurnEnd: SettingsFieldState
  pushTool: SettingsFieldState
  pushDebounceMs: SettingsFieldState
  lang: SettingsFieldState
  serverName: SettingsFieldState
  idleHours: SettingsFieldState
  autoShareNewSessions: SettingsFieldState
  deviceToken: SettingsSecretFieldState
  /** A restart-required field ({@link RESTART_FIELDS}) has a staged change a
   * save would actually write: the save will move the row and the host
   * reloads it, briefly restarting the gateway — the page shows the reload
   * note while this is true. Since T17b it is not merely "a draft exists":
   * a draft equal to the displayed effective value is no change at all, an
   * invalid draft blocks the save instead of saving anything, and an
   * env-locked field never stages (nor counts if locked after staging). */
  restartPending: boolean
}

/** One staged draft: typed text, or an explicit clear back to the composition layer. */
type Staged = { text: string } | { clear: true }

/**
 * Stages one page's edits over the plugin row's shared form and writes them on
 * save as one atomic, revision-fenced mutation. Fields whose `admin/status`
 * source is `env` are locked via {@link setLockedFields}: they cannot be
 * staged, because a written value would be shadowed by the environment anyway.
 */
export class ZenRemoteSettingsForm {
  private readonly listeners = new Set<() => void>()
  private readonly staged = new Map<string, Staged>()
  private readonly lockedFields = new Set<string>()
  /** Fields whose saved row value `admin/status` reported invalid
   * (savedRowInvalid): those display the RAW stored value instead of the
   * resolved one, so the user can see (and fix) what they actually wrote. */
  private readonly rowInvalidFields = new Set<string>()
  private readonly scope: SettingsFormScope
  /** Reads the describe view's secrets sidecar for `deviceToken`'s
   * configured flag; injectable so tests run without a describe mirror. */
  private readonly secretConfigured: () => boolean
  /** Effective values from `admin/status`'s `config.values` — what a field
   * displays while the row layer does not carry it. Empty until the page's
   * first status load feeds it via {@link setBaseline}. Consulted only while
   * the page is NOT a client page (T55): see {@link displayValue}. */
  private baseline: Record<string, unknown> = {}
  /** The effective role the page probed from the client-config route (T17):
   * the fallback for {@link savedRoleIsClient} / {@link statusPoll} when the
   * row document cannot answer the saved role (role only in
   * lan-gate.config.json). Undefined until that probe answers. */
  private probedRole: 'host' | 'client' | undefined = undefined
  private saving = false
  private failed = false
  /** Revision the drafts started from; the save's `expectedRevision` fence. */
  private stagedRevision: number | undefined
  private cache: ZenRemoteFormState | undefined
  private readonly unsubscribe: () => void

  /**
   * @param scope - the shared configuration form for the plugin row entry.
   * (`scope` and `secretConfigured` are assigned in the body rather than as
   * parameter properties: scripts/check-settings-form.mjs imports this module
   * through Node's strip-only type stripping, which rejects that syntax.)
   * @param secretConfigured - whether the row's device token is set, read
   * from the describe view's secrets sidecar; defaults to "not set".
   */
  constructor(scope: SettingsFormScope, secretConfigured: () => boolean = () => false) {
    this.scope = scope
    this.secretConfigured = secretConfigured
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  /** @returns the current form snapshot (stable reference until the next change). */
  getSnapshot(): ZenRemoteFormState {
    if (this.cache === undefined) this.cache = this.project()
    return this.cache
  }

  /** Observe snapshot replacements (the renderer binds this as its store). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Republish from the current reads (admin/status moved underneath). */
  refresh(): void {
    this.publish()
  }

  /** Replace the set of environment-locked fields reported by admin/status. */
  setLockedFields(fields: Iterable<string>): void {
    this.lockedFields.clear()
    for (const field of fields) this.lockedFields.add(field)
    this.publish()
  }

  /**
   * Replace the set of fields whose saved row value resolveConfig rejected
   * (admin/status's savedRowInvalid). Those keep showing the RAW stored
   * value — the resolved value belongs to another layer and would hide the
   * mistake the user needs to fix.
   */
  setRowInvalidFields(fields: Iterable<string>): void {
    this.rowInvalidFields.clear()
    for (const field of fields) this.rowInvalidFields.add(field)
    this.publish()
  }

  /**
   * The entry document's stored value for one field (the shared form
   * snapshot's `value` — the redacted section: secrets never ride it). What
   * the client group prefills the server address from, and what the page
   * reads the SAVED role from (the role field's display text also carries
   * staged drafts, which must not flip the page's mode).
   */
  rowValue(field: string): unknown {
    return this.scope.getSnapshot().value?.[field]
  }

  /**
   * The scope sync state as the shared form sees it. The page waits it out
   * before choosing a status source: a 'loading' snapshot cannot answer the
   * role yet (T16-fix 3).
   */
  scopeStatus(): 'loading' | 'ready' | 'unavailable' {
    return this.scope.getSnapshot().status
  }

  /**
   * Which status source the page should poll right now ({@link settingsPollOf}
   * over the live snapshot): `none` while the mirror loads — and while a row
   * without a stored role waits for the client-config probe — `client` for a
   * client row — never admin there — and `admin` otherwise.
   */
  statusPoll(): 'none' | 'admin' | 'client' {
    const snap = this.scope.getSnapshot()
    return settingsPollOf(snap.status, snap, this.probedRole)
  }

  /**
   * Feed the fallback role the page probed from the client-config route
   * (T17). Only consulted when the row document carries no `role` — a stored
   * row role always wins, so a staged-then-saved switch is never masked by a
   * stale probe.
   */
  setProbedRole(role: 'host' | 'client' | undefined): void {
    this.probedRole = role
    this.publish()
  }

  /**
   * Whether the SAVED row role is client ({@link savedRowRole} over the live
   * snapshot, falling back to the probed role) — the page mode's single
   * source of truth.
   */
  savedRoleIsClient(): boolean {
    return (savedRowRole(this.scope.getSnapshot()) ?? this.probedRole ?? 'host') === 'client'
  }

  /**
   * Whether the row document answers the saved role at all (T17): false when
   * neither snapshot layer carries one — the page then probes the
   * client-config route for the effective role instead of assuming host.
   */
  rowRoleKnown(): boolean {
    return savedRowRole(this.scope.getSnapshot()) !== undefined
  }

  /**
   * One direct write for the pairing flow (T16): the normalized server
   * address and the token just redeemed from the server ride ONE
   * revision-fenced mutate. Not a staged edit — both fields are volatile row
   * settings and apply immediately. @returns whether the write landed.
   */
  async writeClientPairing(serverUrl: string, token: string): Promise<boolean> {
    return this.directWrite([
      { op: 'set', path: ['serverUrl'], value: serverUrl },
      { op: 'set', path: [DEVICE_TOKEN_FIELD], value: token },
    ])
  }

  /**
   * One direct write for unpairing: forget the token, keep the address so
   * the next pairing only needs a fresh code.
   */
  async clearDeviceToken(): Promise<boolean> {
    return this.directWrite([{ op: 'unset', path: [DEVICE_TOKEN_FIELD] }])
  }

  /**
   * Whether one field currently has a STAGED edit (a typed draft or a staged
   * clear) — the "the user is mid-edit" fact the T59 server-name follow
   * reads before it may write. Reads the live draft map, so it answers per
   * call; the page re-runs its effect on every republished snapshot.
   */
  hasDraft(field: string): boolean {
    return this.staged.has(field)
  }

  /**
   * One direct write for the T59 name follow: the SERVER's record of this
   * device's name landing in the row's `serverName` (the role card's 设备
   * 名称 field). The page only calls it when the user is not mid-edit —
   * see {@link shouldFollowServerDeviceName} — and the write's own volatile
   * update echoes back to the backend with both sides now equal, so the
   * push path stays silent (no overwrite loop).
   */
  async writeDeviceName(name: string): Promise<boolean> {
    return this.directWrite([{ op: 'set', path: ['serverName'], value: name }])
  }

  /**
   * The shared write path of the two pairing flows. Deliberately does NOT
   * touch the frame's `failed` flag — a refused pairing write surfaces in
   * the client group's own copy, not as a staged-save failure.
   */
  private async directWrite(ops: SettingsFormOp[]): Promise<boolean> {
    const snap = this.scope.getSnapshot()
    if (snap.status !== 'ready' || !snap.writable || this.saving) return false
    this.saving = true
    this.publish()
    try {
      const landed = await this.scope.mutate(ops, snap.revision)
      if (!landed) return false
      // The row moved underneath any staged drafts: their revision fence is
      // stale, so the next save fences from the fresh revision instead of
      // being refused by a conflict it did not cause.
      this.stagedRevision = undefined
      return true
    } catch {
      return false
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /**
   * Feed the effective values (`admin/status`'s `config.values`) the fields
   * display while the row layer does not carry them; also the baseline the
   * "did the user change anything" comparison reads. The page clears it
   * (`undefined`) whenever the poll source is not the admin one (T55): a
   * stale host baseline must not survive a role switch on a client page.
   */
  setBaseline(values: unknown): void {
    this.baseline = asRecord(values)
    this.publish()
  }

  /** Stage draft text for one row field; ignored for env-locked fields. */
  stage(field: string, text: string): void {
    if (this.lockedFields.has(field)) return
    this.staged.set(field, { text })
    this.noteStage()
  }

  /** Stage a clear so the field re-inherits the composition layer; ignored for env-locked fields. */
  resetField(field: string): void {
    if (this.lockedFields.has(field)) return
    this.staged.set(field, { clear: true })
    this.noteStage()
  }

  /** Drop every staged edit. */
  discard(): void {
    if (this.staged.size === 0 && !this.failed) return
    this.staged.clear()
    this.stagedRevision = undefined
    this.failed = false
    this.publish()
  }

  /**
   * The raw user layer as the shared form stores it; a field's presence here
   * marks a row-layer override, which is what `savedRowInvalid` compares
   * against.
   */
  rowUser(): Record<string, unknown> {
    return asRecord(this.scope.getSnapshot().user)
  }

  /** Whether a save would do anything and is allowed to run right now. */
  canSave(): boolean {
    const snap = this.scope.getSnapshot()
    return snap.status === 'ready'
      && snap.writable
      && !this.saving
      && this.plan().length > 0
      && !this.anyInvalid()
  }

  /**
   * Write every staged edit as one mutation fenced by the revision the drafts
   * started from. The Host is the only authority on acceptance: a refused
   * save keeps its drafts for correction.
   * @returns whether the save landed.
   */
  async save(): Promise<boolean> {
    const ops = this.plan()
    const snap = this.scope.getSnapshot()
    if (ops.length === 0 || this.saving || snap.status !== 'ready' || !snap.writable || this.anyInvalid()) return false
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const landed = await this.scope.mutate(ops, this.stagedRevision ?? snap.revision)
      if (!landed) {
        this.failed = true
        return false
      }
      this.staged.clear()
      this.stagedRevision = undefined
      return true
    } catch {
      this.failed = true
      return false
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /** Release the scope subscription. */
  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  private noteStage(): void {
    if (this.stagedRevision === undefined) this.stagedRevision = this.scope.getSnapshot().revision
    this.failed = false
    this.publish()
  }

  /** Whether the user layer currently carries an entry for one field. */
  private stored(field: string): boolean {
    return Object.hasOwn(asRecord(this.scope.getSnapshot().user), field)
  }

  /**
   * The value one field DISPLAYS, which is also the baseline a draft must
   * differ from to count as a change: an env-locked field shows the effective
   * value (a written one would be shadowed anyway); a field the row layer
   * stores shows the RESOLVED value from admin/status — resolveConfig
   * normalizes stored shapes (a trustedProxies array becomes the comma
   * string, pushTool 1 becomes true) and the box must match what a save
   * writes — EXCEPT when the saved row value was rejected (savedRowInvalid):
   * then the raw stored value shows, so the user sees the mistake; before
   * the first status load the stored raw value stands in, and otherwise the
   * shared form's own effective layer does, so drafts behave sensibly even
   * with no admin/status yet.
   *
   * T55: the admin/status baseline counts only while the page is not a CLIENT
   * page. A role switch leaves the host page's kept status load (and with it
   * the last-fed baseline) in place forever — a client page never refreshes
   * admin/status again — so reading the baseline there would pin every field,
   * the role dropdown included, to the old role. Under a client poll the
   * fields fall back to the row's stored values (the page stops feeding the
   * baseline too, {@link setBaseline}).
   */
  private displayValue(field: string): unknown {
    const staleAdmin = this.statusPoll() === 'client'
    if (this.lockedFields.has(field)) {
      // Lock sets only ever arrive from an admin/status load; while a stale
      // set lingers after a switch, the row document stands in.
      return staleAdmin ? this.scope.getSnapshot().value?.[field] : this.baseline[field]
    }
    const user = asRecord(this.scope.getSnapshot().user)
    const rowStored = Object.hasOwn(user, field)
    if (rowStored && this.rowInvalidFields.has(field)) return user[field]
    if (!staleAdmin && Object.hasOwn(this.baseline, field)) return this.baseline[field]
    if (rowStored) return user[field]
    return this.scope.getSnapshot().value?.[field]
  }

  private anyInvalid(): boolean {
    return SETTINGS_FIELDS.some((spec) => {
      const draft = this.staged.get(spec.field)
      return draft !== undefined && 'text' in draft && spec.parse(draft.text) === undefined
    })
  }

  /**
   * Every staged edit a save would send, in field order, mirroring the
   * upstream form model's plan: a draft equal to the field's current value is
   * no change at all; a reset only writes when the user layer actually
   * carries the field; an invalid draft produces none — the save refuses
   * rather than dropping the edit; a locked field never produces one.
   */
  private plan(): SettingsFormOp[] {
    const ops: SettingsFormOp[] = []
    for (const spec of SETTINGS_FIELDS) {
      if (this.lockedFields.has(spec.field)) continue
      const draft = this.staged.get(spec.field)
      if (draft === undefined) continue
      if ('clear' in draft) {
        if (this.stored(spec.field)) ops.push({ op: 'unset', path: [spec.field] })
        continue
      }
      if (draft.text === spec.format(this.displayValue(spec.field))) continue
      const write = spec.parse(draft.text)
      if (write === undefined) continue
      ops.push(write.kind === 'clear'
        ? { op: 'unset', path: [spec.field] }
        : { op: 'set', path: [spec.field], value: write.value })
    }
    return ops
  }

  private project(): ZenRemoteFormState {
    const snap = this.scope.getSnapshot()
    const user = asRecord(snap.user)
    const fields = {} as Record<SettingsFieldName, SettingsFieldState>
    for (const spec of SETTINGS_FIELDS) {
      const draft = this.staged.get(spec.field)
      const stagedClear = draft !== undefined && 'clear' in draft
      const stagedText = draft !== undefined && 'text' in draft ? draft.text : undefined
      // A staged clear keeps showing the CURRENT value: the next layer's
      // value does not exist yet (and base is empty for a plugin row), so
      // there is nothing honest to preview — the field instead renders the
      // "reverts on save" hint off `cleared`.
      const text = stagedText ?? spec.format(this.displayValue(spec.field))
      const overridden = draft === undefined
        ? Object.hasOwn(user, spec.field)
        : 'clear' in draft
          ? false
          : spec.parse(draft.text)?.kind === 'set'
      const invalid = stagedText !== undefined && spec.parse(stagedText) === undefined
      fields[spec.field as SettingsFieldName] = {
        text,
        overridden,
        invalid,
        cleared: stagedClear,
        locked: this.lockedFields.has(spec.field),
      }
    }
    // One plan drives both flags: dirty is "any write at all", and
    // restartPending (T17b) is "a write touching a restart-required field" —
    // derived from plan()'s own op decisions (T17b-fix), never restated, so
    // the reload note can never disagree with what a save would actually
    // send: an identical draft, an invalid draft, a locked field and a clear
    // of a field the row layer does not carry all plan no op here either.
    const ops = this.plan()
    const restartFields = RESTART_FIELDS as readonly string[]
    return {
      available: snap.status === 'ready',
      writable: snap.writable,
      scopeStatus: snap.status,
      dirty: ops.length > 0,
      invalid: this.anyInvalid(),
      saving: this.saving,
      failed: this.failed,
      restartPending: ops.some((op) => op.path[0] !== undefined && restartFields.includes(op.path[0])),
      ...fields,
      deviceToken: { configured: this.secretConfigured() },
    }
  }

  private publish(): void {
    this.cache = this.project()
    for (const listener of this.listeners) listener()
  }
}
