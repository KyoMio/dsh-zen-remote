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
 *   configured flag read from the describe view's secrets sidecar.
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
/** Field name of the row secret the pairing flow writes (never echoed back
 * anywhere; the describe view's secrets sidecar is the only "is it set"). */
export declare const DEVICE_TOKEN_FIELD = "deviceToken";
/** The `GET /_dsh/zen-remote/client/status` body, exactly as
 * src/client-routes.ts answers it: `serverUrl` is present only once a token
 * exists (the unpaired answer is `{ state: 'unpaired' }` alone). The token
 * itself never rides any status response. */
export interface ClientStatusBody {
    state?: string;
    serverUrl?: string;
}
/** One client connection as the block renders it. */
export interface ClientConnectionView {
    state: 'unpaired' | 'connected' | 'revoked' | 'unreachable' | 'unexpected' | 'invalid-url';
    serverUrl: string;
}
/**
 * Map one `client/status` body into the view the client group renders.
 * Tolerant like {@link deriveSettingsView}: an unexpected shape degrades to
 * "unpaired" instead of throwing into the plugin page.
 */
export declare function deriveClientStatusView(body: ClientStatusBody): ClientConnectionView;
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
 * document — the settings page's ONLY role signal (T16-fix 3). The resolved
 * role an admin/status body reports is unusable here: a client deployment has
 * no admin route at all, and a stale kept body pinned the page to the old
 * role after a switch. `value` is the schema-resolved section the Host
 * accepted; a row value that only lives in the raw user layer reads from
 * there. Anything but the exact string `'client'` — an empty row included —
 * means host, matching resolveRole.
 */
export declare function savedRowRole(snapshot: {
    value?: unknown;
    user?: unknown;
}): 'host' | 'client';
/**
 * Which status source the page polls for one scope snapshot. While the
 * namespace mirror is still loading the role is not knowable and NOTHING is
 * polled — a client deployment must never see a wasted `admin/status` 404;
 * once settled, a client row polls ONLY `client/status` and a host row
 * `admin/status`.
 */
export declare function settingsPollOf(status: 'loading' | 'ready' | 'unavailable', snapshot: {
    value?: unknown;
    user?: unknown;
}): 'none' | 'admin' | 'client';
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
     * first status load feeds it via {@link setBaseline}. */
    private baseline;
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
     * over the live snapshot): `none` while the mirror loads, `client` for a
     * client row — never admin there — and `admin` otherwise.
     */
    statusPoll(): 'none' | 'admin' | 'client';
    /**
     * Whether the SAVED row role is client ({@link savedRowRole} over the live
     * snapshot) — the page mode's single source of truth.
     */
    savedRoleIsClient(): boolean;
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
     * The shared write path of the two pairing flows. Deliberately does NOT
     * touch the frame's `failed` flag — a refused pairing write surfaces in
     * the client group's own copy, not as a staged-save failure.
     */
    private directWrite;
    /**
     * Feed the effective values (`admin/status`'s `config.values`) the fields
     * display while the row layer does not carry them; also the baseline the
     * "did the user change anything" comparison reads.
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