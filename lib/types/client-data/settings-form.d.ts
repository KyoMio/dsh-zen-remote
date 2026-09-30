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
/** Where a resolved field value came from (mirror of src/config.ts's union; the client half cannot import the host module). */
export type ConfigSource = 'env' | 'row' | 'file' | 'default';
/** One paired gateway device, as the gateway's status payload lists it. */
export interface AdminDevice {
    id: string;
    name: string;
    role: 'web' | 'desktop-client';
    kind: 'auto' | 'phone' | 'desktop';
    createdAt: number;
    lastSeen: number;
    ua?: string;
    hasPush: boolean;
}
/** The one currently-live pairing code, if any. */
export interface AdminPairing {
    code: string;
    expiresAt: number;
    role: 'web' | 'desktop-client';
}
/**
 * The gateway's `/lan-gate/status` reply, relayed verbatim inside
 * `admin/status`'s `gateway` field (see lib/lan-gate-server.cjs's
 * statusHandler — this mirror keeps only what the settings block reads).
 */
export interface GatewayStatus {
    state?: string;
    port?: number;
    target?: string;
    devices?: AdminDevice[];
    pairing?: AdminPairing | null;
    pushSubscriptions?: number;
}
/**
 * The `GET /_dsh/zen-remote/admin/status` body, exactly as src/admin-routes.ts
 * answers it: the gateway payload lives NESTED under `gateway` (null when the
 * gateway did not answer healthily) and `gatewayStatus` is the HTTP status the
 * route saw (`null` when there was no answer at all).
 */
export interface AdminStatusBody {
    ok?: boolean;
    gateway?: GatewayStatus | null;
    gatewayReachable?: boolean;
    gatewayStatus?: number | null;
    config?: {
        values?: Record<string, unknown>;
        sources?: Record<string, string>;
    };
    viaGateway?: boolean;
}
/** Same-origin admin routes the settings block talks to (host half: T14). */
export declare const ADMIN_STATUS_ROUTE = "/_dsh/zen-remote/admin/status";
export declare const ADMIN_PAIR_ROUTE = "/_dsh/zen-remote/admin/pair";
export declare const ADMIN_ACTION_ROUTE = "/_dsh/zen-remote/admin/action";
export declare const ADMIN_PUSH_TEST_ROUTE = "/_dsh/zen-remote/admin/push-test";
/** Same-origin client routes the sub-client block talks to (host half: T16). */
export declare const CLIENT_CLAIM_ROUTE = "/_dsh/zen-remote/client/claim";
export declare const CLIENT_STATUS_ROUTE = "/_dsh/zen-remote/client/status";
/** T43: one immediate reconnect — answered 409 unless the client is offline. */
export declare const CLIENT_RECONNECT_ROUTE = "/_dsh/zen-remote/client/reconnect";
/** The lightweight client-facing config route (host half, both roles): the
 * settings page's FALLBACK role probe (T17) — it registers wherever a
 * webServer exists, and since T17 its body carries the effective `role`
 * (resolveConfig's merged value, nothing sensitive). */
export declare const CLIENT_CONFIG_ROUTE = "/_dsh/mobile-nav/client-config";
/** The body of `GET /_dsh/mobile-nav/client-config` — the interface-half knobs
 * the client bundle reads, plus (T17) the effective role the settings page
 * falls back to. */
export interface ClientConfigBody {
    role?: unknown;
    turnFoldDesktop?: boolean;
    keyboardLiftRatio?: number;
    keyboardLiftMaxPx?: number;
    keyboardSafetyPadPx?: number;
}
/** Field name of the row secret the pairing flow writes (never echoed back
 * anywhere; the describe view's secrets sidecar is the only "is it set"). */
export declare const DEVICE_TOKEN_FIELD = "deviceToken";
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
    state?: string;
    serverUrl?: string;
    serverName?: unknown;
    /** Epoch ms of the relay client's next automatic reconnect (offline only). */
    nextRetryAt?: unknown;
    /** The error code of the last failure — a code, never a message or URL. */
    lastError?: unknown;
    /**
     * The SERVER's record of THIS device's name (T59, presence-gated like the
     * diagnostics fields — older servers answer without it). The settings page
     * follows it into the row while the user is not editing the field.
     */
    deviceName?: unknown;
    /** T23b request-interceptor diagnostics (provisional shape; presence-gated). */
    intercept?: unknown;
    /** T42 relay compat diagnostics: `{ identical: string[], different:
     * string[], unavailable: string[], incompatibleCalls: { time: number,
     * endpoint: string, code: string }[] }` (presence-gated). */
    compat?: unknown;
}
/** One remote-call failure line in the diagnostics lists. `time` is epoch
 * milliseconds — ISO-stamped rings are parsed at derive time; `method`
 * carries the wire's method-or-endpoint name. */
export interface ClientDiagFailureView {
    time: number;
    method: string;
    code: string;
}
/**
 * T23b interceptor diagnostics as the block renders them. The wire field is
 * presence-gated: `undefined` here means the body carried none (an older
 * server), and the whole interceptor group stays hidden.
 */
export interface ClientInterceptView {
    installed: boolean;
    /** Shape-detection failure reasons — non-empty means remote features are off. */
    reasons: string[];
    /** The most recent remote call failures (at most 10). */
    recentFailures: ClientDiagFailureView[];
}
/** T42 compat diagnostics as the block renders them (presence-gated like {@link ClientInterceptView}). */
export interface ClientCompatView {
    /** Names of the groups whose fingerprints differ. */
    mismatchedGroups: string[];
    /** The most recent incompatible calls (at most 10). */
    recentCalls: ClientDiagFailureView[];
}
/** One client connection as the block renders it. */
export interface ClientConnectionView {
    state: 'unpaired' | 'connected' | 'revoked' | 'unreachable' | 'unexpected' | 'invalid-url' | 'incompatible';
    serverUrl: string;
    serverName: string;
    /** Verbatim from the body when it carried a finite number; the countdown
     * math happens at render time against the live clock. */
    nextRetryAt: number | undefined;
    /** The last failure's code, '' when none is reported. */
    lastError: string;
    /** The SERVER's record of this device's name (T59): '' when the body did
     * not carry one — empty means "nothing to follow". */
    deviceName: string;
    intercept: ClientInterceptView | undefined;
    compat: ClientCompatView | undefined;
}
/**
 * Map one `client/status` body into the view the client group renders.
 * Tolerant like {@link deriveSettingsView}: an unexpected shape degrades to
 * "unpaired" instead of throwing into the plugin page.
 */
export declare function deriveClientStatusView(body: ClientStatusBody): ClientConnectionView;
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
export type ClientStatusLine = {
    kind: 'connectedName';
    serverName: string;
} | {
    kind: 'connected';
    serverUrl: string;
} | {
    kind: 'offlineRetry';
    seconds: number;
} | {
    kind: 'offlineRetrySoon';
} | {
    kind: 'unreachable';
} | {
    kind: 'revoked';
} | {
    kind: 'incompatible';
} | {
    kind: 'unexpected';
} | {
    kind: 'invalidUrl';
} | {
    kind: 'unpaired';
};
export declare function clientStatusLineOf(view: ClientConnectionView, now: number): ClientStatusLine;
/** The `POST /_dsh/zen-remote/client/claim` body (T16's pairing round-trip;
 * on success `token` is the gateway-minted device token — it appears exactly
 * once, on its way into the row's secret field). */
export interface ClaimRouteBody {
    ok?: boolean;
    token?: unknown;
    deviceId?: unknown;
    deviceName?: unknown;
    /** The normalized address the backend validated — what the form writes. */
    serverUrl?: unknown;
    code?: string;
    message?: string;
    retryAfterMs?: number;
}
/** What the pairing-code box keeps as its draft: uppercase, no spaces or
 * hyphens (the gateway strips every other character at claim time anyway). */
export declare function normalizePairingCode(input: string): string;
/**
 * Whether the settings page may follow the SERVER's record of this device's
 * name into the row (T59): the body carried a name, it differs from the row
 * (nothing to do otherwise — and this equality is the anti-bounce half: the
 * page's own write echoes back through client/status with both sides equal),
 * and the user has no staged draft in the field (their edit wins until they
 * save — a follow mid-typing would clobber it).
 */
export declare function shouldFollowServerDeviceName(deviceName: string, rowName: string, hasDraft: boolean): boolean;
/**
 * Latest-wins sequencing for the status loads: every request takes a ticket,
 * and only the newest ticket may still apply its result. An earlier request
 * that answers LATE is dropped, so a stale body can never overwrite a fresh
 * one (a revoked device reappearing, an old "no pairing code" answer wiping
 * a just-minted code, an unpair racing a refresh).
 */
export interface LatestGate {
    /** Issue the ticket for one new in-flight request. */
    next(): number;
    /** Whether that ticket is still the newest issued one. */
    isLatest(ticket: number): boolean;
}
export declare function createLatestGate(): LatestGate;
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
export declare function savedRowRole(snapshot: {
    value?: unknown;
    user?: unknown;
}): 'host' | 'client' | undefined;
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
export declare function settingsRoleOf(status: 'loading' | 'ready' | 'unavailable', snapshot: {
    value?: unknown;
    user?: unknown;
}, probed?: 'host' | 'client'): 'unknown' | 'host' | 'client';
/**
 * Which status source the page polls for one scope snapshot —
 * {@link settingsRoleOf} mapped onto poll sources (`'unknown'` polls
 * nothing). See there for the decision.
 */
export declare function settingsPollOf(status: 'loading' | 'ready' | 'unavailable', snapshot: {
    value?: unknown;
    user?: unknown;
}, probed?: 'host' | 'client'): 'none' | 'admin' | 'client';
/**
 * The row fields whose changed value reloads the plugin row after a save —
 * re-exported from src/restart-fields.ts, the single list the host half's
 * restart watcher fingerprints too (T17b collapsed the two copies; the leaf
 * module is dependency-free so the client bundler can inline it). Only the
 * fields this page edits can ever stage a draft here — `targetPort` /
 * `pushEvents` are not page fields — but the list is the full shared set so
 * a host-side change surfaces in the diff.
 */
export { RESTART_FIELDS } from '../restart-fields.ts';
/** One path-addressed edit a save sends (the wire `SettingsPathOpView` shape). */
export type SettingsFormOp = {
    op: 'set';
    path: string[];
    value: unknown;
} | {
    op: 'unset';
    path: string[];
};
/** Structural subset of the shared `ConfigForm` snapshot this form reads. */
export interface SettingsFormScopeSnapshot {
    status: 'loading' | 'ready' | 'unavailable';
    value: Record<string, unknown> | undefined;
    /** Composition layer; what a field reverts to once cleared. */
    base: unknown;
    /** Raw user layer as stored; field PRESENCE here marks an override. */
    user: unknown;
    /** Revision fencing the next write; sent back as `expectedRevision`. */
    revision: number | undefined;
    writable: boolean;
}
/**
 * The form face this controller stages over (structural subset of
 * ui-settings' `ConfigForm` — declared locally because this package does not
 * depend on the ui-settings types).
 */
export interface SettingsFormScope {
    getSnapshot(): SettingsFormScopeSnapshot;
    subscribe(listener: () => void): () => void;
    mutate(ops: readonly SettingsFormOp[], expectedRevision?: number): Promise<boolean>;
}
/**
 * One secret path in the describe view's sidecar: the path plus whether it
 * is set — the VALUE itself never rides any describe surface.
 */
export interface DescribeSecret {
    path: string[];
    set: boolean;
}
/**
 * The `configForms.describe()` mirror (structural, like {@link ConfigFormsLike}
 * — the dsh-client-ui-settings package is not a dependency). Read only for
 * the secrets sidecar: whether the row's `deviceToken` is set.
 */
export interface ConfigFormsDescribe {
    getSnapshot(): {
        view?: {
            namespaces?: ReadonlyArray<{
                ns: string;
                secrets?: ReadonlyArray<DescribeSecret>;
            }>;
        };
    };
    subscribe(listener: () => void): () => void;
}
/**
 * The `configForms` service face this plugin uses, mirrored onto the cordis
 * Context. Declared locally (the dsh-client-ui-settings package is not a
 * dependency — same trick as the local `UiWorkspaceLike`): the runtime
 * instance is provided by the host, and the lazy `ctx.inject(['configForms'], …)`
 * in register-settings keeps a composition without the service loadable.
 */
export interface ConfigFormsLike {
    get(entryId: string): SettingsFormScope;
    describe(): ConfigFormsDescribe;
    whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void;
}
/** The write one staged draft performs when the form is saved. */
export type SettingsFieldWrite = {
    kind: 'set';
    value: unknown;
} | {
    kind: 'clear';
};
/** How one field converts between its stored value and draft text. */
export interface SettingsFieldSpec {
    field: string;
    format(value: unknown): string;
    /** The staged write, or undefined when the draft is not a value this field accepts. */
    parse(text: string): SettingsFieldWrite | undefined;
}
/** Free-text field: an empty draft clears, so the field re-inherits its default. */
export declare function textField(field: string): SettingsFieldSpec;
/** Whole-number field within inclusive bounds; empty clears, anything else out of range blocks the save. */
export declare function intField(field: string, min: number, max: number): SettingsFieldSpec;
/** Finite number in (min, max] — the `idleHours` shape: zero excluded, 8760 allowed. */
export declare function hoursField(field: string, max: number): SettingsFieldSpec;
/** `serverName`: an empty draft clears; a blank-but-nonempty draft or one over
 * the 40-character cap is invalid and blocks the save (src/config.ts clips at
 * resolve time, so an over-long write would silently lose its tail). */
export declare function nameField(field: string, max: number): SettingsFieldSpec;
/**
 * The name one pairing claim registers under (T57): the shared 设备名称
 * field's CURRENT displayed value — a staged draft when one exists — used
 * only when it is a value a save would WRITE ({@link nameField} rules: an
 * empty draft means nothing stored, a blank or over-cap draft is invalid),
 * otherwise the default device-name copy. The fallback is load-bearing since
 * T55: a client page reads no admin baseline, so an unstored name displays
 * EMPTY and the claim must still carry a usable name.
 */
export declare function claimDeviceNameOf(displayText: string, fallback: string): string;
/** One-of field over a fixed vocabulary (rendered as a select). */
export declare function oneOfField(field: string, options: readonly string[]): SettingsFieldSpec;
/** Boolean field staged as 'true'/'false' draft text (rendered as a checkbox). */
export declare function boolField(field: string): SettingsFieldSpec;
/** Names of the row fields the settings page edits, in group order. */
export type SettingsFieldName = 'role' | 'host' | 'port' | 'trustedProxies' | 'rateLimit' | 'vapidSubject' | 'pushSummary' | 'pushTurnEnd' | 'pushTool' | 'pushDebounceMs' | 'lang' | 'serverName' | 'idleHours' | 'autoShareNewSessions';
/** Longest legal `serverName`, mirroring src/config.ts's cap. */
export declare const SERVER_NAME_MAX = 40;
/** Upper bound of `idleHours`, mirroring src/config.ts. */
export declare const IDLE_HOURS_MAX = 8760;
/** The row fields the settings page edits, in render order. */
export declare const SETTINGS_FIELDS: readonly SettingsFieldSpec[];
/**
 * Whether the settings page's server-local operations (pairing, device
 * management, the push probe) are usable: only once a status load answered
 * AND it answered as the local machine (`viaGateway: false`). Everything
 * else — no answer yet, or the page opened through the gateway — keeps them
 * disabled. Pure so the check script pins all three cases.
 */
export declare function localOpsAllowed(view: SettingsView | undefined): boolean;
/** Per-field presentation facts the block renders next to each control. */
export interface SettingsFieldView {
    /** Effective value (the resolved `config.values[field]`). */
    value: unknown;
    /** Layer that supplied the effective value. */
    source: ConfigSource;
    /** `source === 'env'`: shown locked, edits would be shadowed. */
    locked: boolean;
    /** `source === 'file'`: the legacy lan-gate.config.json supplies this. */
    fromFile: boolean;
    /** The row layer stores this field but another layer supplied the value —
     * i.e. the saved value was illegal and resolveConfig skipped it. */
    savedRowInvalid: boolean;
}
/** One device row the block renders. */
export interface SettingsDeviceView {
    id: string;
    name: string;
    role: 'web' | 'desktop-client';
    kind: 'auto' | 'phone' | 'desktop';
    lastSeen: number;
    hasPush: boolean;
}
/** The live pairing code with its countdown, or null when none is active. */
export interface SettingsPairingView {
    code: string;
    role: 'web' | 'desktop-client';
    remainingSeconds: number;
}
/** Everything the settings block renders, derived from one status body. */
export interface SettingsView {
    /** The status route answered ok. */
    available: boolean;
    /** Which half this DSH process runs as (`client` shows only the role group). */
    role: 'host' | 'client';
    /** Opened through the gateway (a remote device): server-local operations disabled. */
    viaGateway: boolean;
    /** Whether the gateway child answers. */
    gatewayReachable: boolean;
    gatewayPort: number | undefined;
    gatewayTarget: string | undefined;
    /** The probe status the admin route saw from the gateway; null = no answer. */
    gatewayStatus: number | null;
    /** `gatewayStatus` is a non-2xx reply: the status line shows the abnormal message instead. */
    gatewayAbnormal: boolean;
    fields: Record<SettingsFieldName, SettingsFieldView>;
    devices: SettingsDeviceView[];
    pairing: SettingsPairingView | null;
}
export interface DeriveSettingsOptions {
    /** Clock for the pairing countdown; defaults to `Date.now()`. */
    now?: number;
    /** The shared form snapshot's raw user layer; field presence marks a row-layer override. */
    rowUser?: unknown;
}
/**
 * Map one `admin/status` body into the view the settings block renders.
 * Tolerant by design: every wire field is optional, an unexpected shape
 * degrades to the conservative rendering (status unavailable, gateway down,
 * no devices, no pairing) instead of throwing into the plugin page.
 */
export declare function deriveSettingsView(status: AdminStatusBody, options?: DeriveSettingsOptions): SettingsView;
/** Card-level state the shared form frame renders. */
export interface SettingsFormShellState {
    available: boolean;
    writable: boolean;
    dirty: boolean;
    invalid: boolean;
    saving: boolean;
    failed: boolean;
}
/** One control's state as its field renders it. */
export interface SettingsFieldState {
    text: string;
    overridden: boolean;
    invalid: boolean;
    /** A clear is staged: the box keeps showing the CURRENT value — the next
     * layer's value only exists after the save — and the field renders the
     * "reverts on save" hint instead of a fake preview. */
    cleared: boolean;
    /** `admin/status` reported this field's value locked by an environment variable. */
    locked: boolean;
}
/** The row secret's face: presence only, never a value. */
export interface SettingsSecretFieldState {
    /** The describe view's secrets sidecar reports `deviceToken` set. */
    configured: boolean;
}
/** The whole staged-form snapshot the page renders. */
export interface ZenRemoteFormState extends SettingsFormShellState {
    /** The shared form's scope sync state, reactively exposed so the page's
     * role probe can wait out the mirror's loading phase. */
    scopeStatus: 'loading' | 'ready' | 'unavailable';
    role: SettingsFieldState;
    host: SettingsFieldState;
    port: SettingsFieldState;
    trustedProxies: SettingsFieldState;
    rateLimit: SettingsFieldState;
    vapidSubject: SettingsFieldState;
    pushSummary: SettingsFieldState;
    pushTurnEnd: SettingsFieldState;
    pushTool: SettingsFieldState;
    pushDebounceMs: SettingsFieldState;
    lang: SettingsFieldState;
    serverName: SettingsFieldState;
    idleHours: SettingsFieldState;
    autoShareNewSessions: SettingsFieldState;
    deviceToken: SettingsSecretFieldState;
    /** A restart-required field ({@link RESTART_FIELDS}) has a staged change a
     * save would actually write: the save will move the row and the host
     * reloads it, briefly restarting the gateway — the page shows the reload
     * note while this is true. Since T17b it is not merely "a draft exists":
     * a draft equal to the displayed effective value is no change at all, an
     * invalid draft blocks the save instead of saving anything, and an
     * env-locked field never stages (nor counts if locked after staging). */
    restartPending: boolean;
}
/**
 * Stages one page's edits over the plugin row's shared form and writes them on
 * save as one atomic, revision-fenced mutation. Fields whose `admin/status`
 * source is `env` are locked via {@link setLockedFields}: they cannot be
 * staged, because a written value would be shadowed by the environment anyway.
 */
export declare class ZenRemoteSettingsForm {
    private readonly listeners;
    private readonly staged;
    private readonly lockedFields;
    /** Fields whose saved row value `admin/status` reported invalid
     * (savedRowInvalid): those display the RAW stored value instead of the
     * resolved one, so the user can see (and fix) what they actually wrote. */
    private readonly rowInvalidFields;
    private readonly scope;
    /** Reads the describe view's secrets sidecar for `deviceToken`'s
     * configured flag; injectable so tests run without a describe mirror. */
    private readonly secretConfigured;
    /** Effective values from `admin/status`'s `config.values` — what a field
     * displays while the row layer does not carry it. Empty until the page's
     * first status load feeds it via {@link setBaseline}. Consulted only while
     * the page is NOT a client page (T55): see {@link displayValue}. */
    private baseline;
    /** The effective role the page probed from the client-config route (T17):
     * the fallback for {@link savedRoleIsClient} / {@link statusPoll} when the
     * row document cannot answer the saved role (role only in
     * lan-gate.config.json). Undefined until that probe answers. */
    private probedRole;
    private saving;
    private failed;
    /** Revision the drafts started from; the save's `expectedRevision` fence. */
    private stagedRevision;
    private cache;
    private readonly unsubscribe;
    /**
     * @param scope - the shared configuration form for the plugin row entry.
     * (`scope` and `secretConfigured` are assigned in the body rather than as
     * parameter properties: scripts/check-settings-form.mjs imports this module
     * through Node's strip-only type stripping, which rejects that syntax.)
     * @param secretConfigured - whether the row's device token is set, read
     * from the describe view's secrets sidecar; defaults to "not set".
     */
    constructor(scope: SettingsFormScope, secretConfigured?: () => boolean);
    /** @returns the current form snapshot (stable reference until the next change). */
    getSnapshot(): ZenRemoteFormState;
    /** Observe snapshot replacements (the renderer binds this as its store). */
    subscribe(listener: () => void): () => void;
    /** Republish from the current reads (admin/status moved underneath). */
    refresh(): void;
    /** Replace the set of environment-locked fields reported by admin/status. */
    setLockedFields(fields: Iterable<string>): void;
    /**
     * Replace the set of fields whose saved row value resolveConfig rejected
     * (admin/status's savedRowInvalid). Those keep showing the RAW stored
     * value — the resolved value belongs to another layer and would hide the
     * mistake the user needs to fix.
     */
    setRowInvalidFields(fields: Iterable<string>): void;
    /**
     * The entry document's stored value for one field (the shared form
     * snapshot's `value` — the redacted section: secrets never ride it). What
     * the client group prefills the server address from, and what the page
     * reads the SAVED role from (the role field's display text also carries
     * staged drafts, which must not flip the page's mode).
     */
    rowValue(field: string): unknown;
    /**
     * The scope sync state as the shared form sees it. The page waits it out
     * before choosing a status source: a 'loading' snapshot cannot answer the
     * role yet (T16-fix 3).
     */
    scopeStatus(): 'loading' | 'ready' | 'unavailable';
    /**
     * Which status source the page should poll right now ({@link settingsPollOf}
     * over the live snapshot): `none` while the mirror loads — and while a row
     * without a stored role waits for the client-config probe — `client` for a
     * client row — never admin there — and `admin` otherwise.
     */
    statusPoll(): 'none' | 'admin' | 'client';
    /**
     * Feed the fallback role the page probed from the client-config route
     * (T17). Only consulted when the row document carries no `role` — a stored
     * row role always wins, so a staged-then-saved switch is never masked by a
     * stale probe.
     */
    setProbedRole(role: 'host' | 'client' | undefined): void;
    /**
     * Whether the SAVED row role is client ({@link savedRowRole} over the live
     * snapshot, falling back to the probed role) — the page mode's single
     * source of truth.
     */
    savedRoleIsClient(): boolean;
    /**
     * Whether the row document answers the saved role at all (T17): false when
     * neither snapshot layer carries one — the page then probes the
     * client-config route for the effective role instead of assuming host.
     */
    rowRoleKnown(): boolean;
    /**
     * One direct write for the pairing flow (T16): the normalized server
     * address and the token just redeemed from the server ride ONE
     * revision-fenced mutate. Not a staged edit — both fields are volatile row
     * settings and apply immediately. @returns whether the write landed.
     */
    writeClientPairing(serverUrl: string, token: string): Promise<boolean>;
    /**
     * One direct write for unpairing: forget the token, keep the address so
     * the next pairing only needs a fresh code.
     */
    clearDeviceToken(): Promise<boolean>;
    /**
     * Whether one field currently has a STAGED edit (a typed draft or a staged
     * clear) — the "the user is mid-edit" fact the T59 server-name follow
     * reads before it may write. Reads the live draft map, so it answers per
     * call; the page re-runs its effect on every republished snapshot.
     */
    hasDraft(field: string): boolean;
    /**
     * One direct write for the T59 name follow: the SERVER's record of this
     * device's name landing in the row's `serverName` (the role card's 设备
     * 名称 field). The page only calls it when the user is not mid-edit —
     * see {@link shouldFollowServerDeviceName} — and the write's own volatile
     * update echoes back to the backend with both sides now equal, so the
     * push path stays silent (no overwrite loop).
     */
    writeDeviceName(name: string): Promise<boolean>;
    /**
     * The shared write path of the two pairing flows. Deliberately does NOT
     * touch the frame's `failed` flag — a refused pairing write surfaces in
     * the client group's own copy, not as a staged-save failure.
     */
    private directWrite;
    /**
     * Feed the effective values (`admin/status`'s `config.values`) the fields
     * display while the row layer does not carry them; also the baseline the
     * "did the user change anything" comparison reads. The page clears it
     * (`undefined`) whenever the poll source is not the admin one (T55): a
     * stale host baseline must not survive a role switch on a client page.
     */
    setBaseline(values: unknown): void;
    /** Stage draft text for one row field; ignored for env-locked fields. */
    stage(field: string, text: string): void;
    /** Stage a clear so the field re-inherits the composition layer; ignored for env-locked fields. */
    resetField(field: string): void;
    /** Drop every staged edit. */
    discard(): void;
    /**
     * The raw user layer as the shared form stores it; a field's presence here
     * marks a row-layer override, which is what `savedRowInvalid` compares
     * against.
     */
    rowUser(): Record<string, unknown>;
    /** Whether a save would do anything and is allowed to run right now. */
    canSave(): boolean;
    /**
     * Write every staged edit as one mutation fenced by the revision the drafts
     * started from. The Host is the only authority on acceptance: a refused
     * save keeps its drafts for correction.
     * @returns whether the save landed.
     */
    save(): Promise<boolean>;
    /** Release the scope subscription. */
    dispose(): void;
    private noteStage;
    /** Whether the user layer currently carries an entry for one field. */
    private stored;
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
    private displayValue;
    private anyInvalid;
    /**
     * Every staged edit a save would send, in field order, mirroring the
     * upstream form model's plan: a draft equal to the field's current value is
     * no change at all; a reset only writes when the user layer actually
     * carries the field; an invalid draft produces none — the save refuses
     * rather than dropping the edit; a locked field never produces one.
     */
    private plan;
    private project;
    private publish;
}
//# sourceMappingURL=settings-form.d.ts.map