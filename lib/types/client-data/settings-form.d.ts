/**
 * Staged configuration form for the `dsh-zen-remote` plugin row, in the same
 * shape the dsh-llm-verifier page uses (a control stages what the user types,
 * one save writes every staged edit as a single revision-fenced path mutation
 * through the shared `configForms` form). Two pieces, both free of browser
 * imports so tests drive them directly:
 *
 * - `deriveSettingsView(status)` maps the `GET /_dsh/zen-remote/admin/status`
 *   body (T14's same-origin route wrapping the gateway's local admin API) into
 *   what the settings block renders: per-field effective value + source layer,
 *   the device list, the live pairing code with its remaining seconds, and the
 *   `viaGateway` flag that disables every server-local operation.
 * - `ZenRemoteSettingsForm` stages the row-layer field edits and saves them as
 *   one `mutate(ops, expectedRevision)` call.
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
 * The `configForms` service face this plugin uses, mirrored onto the cordis
 * Context. Declared locally (the dsh-client-ui-settings package is not a
 * dependency — same trick as the local `UiWorkspaceLike`): the runtime
 * instance is provided by the host, and the lazy `ctx.inject(['configForms'], …)`
 * in register-settings keeps a composition without the service loadable.
 */
export interface ConfigFormsLike {
    get(entryId: string): SettingsFormScope;
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
    /** `admin/status` reported this field's value locked by an environment variable. */
    locked: boolean;
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
    private readonly scope;
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
     * (`scope` is assigned in the body rather than as a parameter property:
     * scripts/check-settings-form.mjs imports this module through Node's
     * strip-only type stripping, which rejects that syntax.)
     */
    constructor(scope: SettingsFormScope);
    /** @returns the current form snapshot (stable reference until the next change). */
    getSnapshot(): ZenRemoteFormState;
    /** Observe snapshot replacements (the renderer binds this as its store). */
    subscribe(listener: () => void): () => void;
    /** Republish from the current reads (admin/status moved underneath). */
    refresh(): void;
    /** Replace the set of environment-locked fields reported by admin/status. */
    setLockedFields(fields: Iterable<string>): void;
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
     * stores shows the stored raw value verbatim (alongside the invalid-saved
     * note when resolveConfig skipped it); otherwise the effective value wins.
     * Before the first status load the shared form's own effective layer stands
     * in, so drafts behave sensibly even with no admin/status yet.
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