/**
 * The plugin bridge's registration and comparison half (PB-1).
 *
 * Other DSH plugins can hand zen-remote a "bridge declaration": the list of
 * THEIR OWN HTTP routes that may be forwarded to the main server inside a
 * remote session (docs/adr/0001). A plugin counts as "bridged" only when
 * BOTH ends agree on the plugin name, the exact version AND the declaration
 * digest — everything here is the pure logic behind that agreement: the
 * declaration shape and its validation ({@link normalizeDeclaration}), the
 * per-process registry backing the `zenRemote` service
 * ({@link createBridgeRegistry}), and the local-vs-server comparison that a
 * later task feeds handshake data into ({@link compareBridges}).
 *
 * Pure logic by design: no DSH imports, no I/O, no clocks — the digest is
 * the only place node:crypto appears, which is fine because this module only
 * ever runs in the backend process. Nothing here talks to the relay or the
 * network; the handshake side and the request rewrite side are later tasks
 * that consume a {@link BridgeRegistry} through src/index.ts.
 */
/** Where a bridged route's caller supplies the session id. `'session'` — the
 * data is scoped to one session, forwarded after the server checks the share.
 * `'server'` — whole-machine data (e.g. every zcode task), which the server
 * owner must consent to per plugin (the `pluginBridgeConsent` row knob). */
export type BridgeScope = 'session' | 'server';
/** The HTTP methods a bridged route may forward (PB-9). 2.1 accepted GET
 * only; the write methods arrived with the `methods` field. */
export declare const BRIDGE_METHODS: readonly ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
/** The body cap a route may declare (`maxBody`), in bytes: 64 MiB. */
export declare const MAX_ROUTE_BODY_BYTES: number;
/** The body cap a route gets when it declares none: 1 MiB. */
export declare const DEFAULT_ROUTE_BODY_BYTES: number;
/** One forwardable route as a plugin declares it. `sessionParam` names the
 * URL query parameter carrying the session id (default `'sessionId'`);
 * `stream` marks routes answered as an event stream rather than one JSON
 * body. `methods` (PB-9) lists the forwardable HTTP methods — uppercase
 * members of {@link BRIDGE_METHODS}, deduplicated and sorted at
 * normalization; omitted means `['GET']` (the 2.1 behavior). `maxBody`
 * (PB-9) caps the forwarded request body in bytes; omitted means
 * {@link DEFAULT_ROUTE_BODY_BYTES}. `upgrade` (PB-10) marks the route as a
 * WebSocket endpoint carried over the byte tunnel — GET-only, mutually
 * exclusive with `stream`. */
export interface BridgeRoute {
    path: string;
    scope: BridgeScope;
    sessionParam?: string;
    stream?: boolean;
    methods?: readonly string[];
    maxBody?: number;
    upgrade?: boolean;
}
/** What a plugin hands `zenRemote.bridge(...)` — the raw, unvalidated shape. */
export interface BridgeDeclaration {
    plugin: string;
    version: string;
    routes: BridgeRoute[];
}
/** A route after validation: every scalar field filled, `methods`,
 * `maxBody` and `upgrade` present ONLY when the plugin declared them
 * explicitly — the distinction is load-bearing for the digest (see the
 * canonical form in {@link normalizeDeclaration}), while consumers read the
 * EFFECTIVE values through {@link routeMethodsOf} / {@link routeMaxBodyOf}
 * / {@link routeUpgradesOf}. */
export interface NormalizedBridgeRoute {
    path: string;
    scope: BridgeScope;
    sessionParam: string;
    stream: boolean;
    methods: string[] | undefined;
    maxBody: number | undefined;
    upgrade: boolean | undefined;
}
/** The effective upgrade mark of one normalized route. */
export declare function routeUpgradesOf(route: NormalizedBridgeRoute): boolean;
/** The effective forwardable methods of one normalized route. */
export declare function routeMethodsOf(route: NormalizedBridgeRoute): string[];
/** The effective body cap of one normalized route, in bytes. */
export declare function routeMaxBodyOf(route: NormalizedBridgeRoute): number;
/** A declaration after validation: every route field filled, routes sorted
 * by path, and the 16-hex-char digest both ends will compare. */
export interface NormalizedDeclaration {
    plugin: string;
    version: string;
    routes: NormalizedBridgeRoute[];
    digest: string;
}
/**
 * Validate one declaration and fold it into its comparable form.
 *
 * Route paths must be plain absolute paths (start with `/`, no `?`, `#`,
 * `..` or whitespace) and must stay off the two prefixes zen-remote does not
 * own: `/_dsh/` (the plugin's own surface) and `/api` (the host's shared
 * fetch channel) — bridging either would let a third plugin put words in the
 * host's mouth. The `/api` check is the literal string prefix, so a plugin
 * route like `/apifoo` is refused too; that overreach is deliberate, the
 * rule must stay trivially predictable on both ends.
 *
 * The digest is sha256 over a canonical JSON of `{plugin, version, routes}`
 * with a fixed key order, hex, first 16 characters — route ORDER is not part
 * of it (two ends listing the same routes in different orders still match),
 * any field VALUE is.
 * @throws with a field-naming message on any illegal shape.
 */
export declare function normalizeDeclaration(input: unknown): NormalizedDeclaration;
/** The service provided on the row context as `zenRemote`, both roles. Other
 * plugins reach it with `ctx.inject(['zenRemote'], (c) => …)`; when
 * zen-remote is not installed the inject never fires, so dependents need no
 * conditional code. Exported as a TYPE only — no Context augmentation, so
 * nothing here leaks into compositions without this plugin. */
export interface ZenRemoteService {
    /** Register this process's bridge declaration. Throws on an illegal
     * declaration (nothing is registered); on success returns the dispose that
     * removes exactly this registration. */
    bridge(declaration: BridgeDeclaration): () => void;
}
/** How `register` reports a same-plugin overwrite. Injectable so tests (and
 * src/index.ts, via the context logger) can observe it; absent = silent. */
export interface CreateBridgeRegistryOptions {
    warn?: (message: string) => void;
}
/** The per-process declaration table behind the `zenRemote` service. */
export interface BridgeRegistry {
    /** Validate and record one declaration (throws pass through, nothing is
     * registered). A same-plugin registration REPLACES the earlier one and
     * reports through `warn`. The returned dispose removes only the
     * registration it came from — after an overwrite the STALE dispose is a
     * no-op and must not remove the replacement. */
    register(input: unknown): () => void;
    /** All live declarations, sorted by plugin name. */
    list(): NormalizedDeclaration[];
    get(plugin: string): NormalizedDeclaration | undefined;
    /** Fires once per successful register and per effective removal (an
     * overwritten stale dispose fires nothing). Returns the unsubscribe. */
    onChange(listener: () => void): () => void;
}
/**
 * Create the registry one DSH process (one plugin row) owns.
 *
 * Overwrite bookkeeping is identity-based, not flag-based: each dispose
 * closes over the exact declaration object it registered and only deletes
 * the table entry while it is STILL that object — a stale dispose meeting a
 * newer registration finds someone else's identity and does nothing.
 */
export declare function createBridgeRegistry(options?: CreateBridgeRegistryOptions): BridgeRegistry;
/** Why a plugin is NOT bridged. The order of the cases below is the order
 * {@link compareBridges} judges them in. */
export type BridgeReason = 'not-on-server' | 'version-mismatch' | 'declaration-mismatch' | 'consent-off' | 'offline' | 'server-too-old';
/** One plugin's bridge verdict on this device. */
export interface BridgeStatus {
    plugin: string;
    bridged: boolean;
    reason?: BridgeReason;
    localVersion: string;
    serverVersion?: string;
}
/** What the server reports about one plugin at handshake time (a later task
 * carries it in the relay handshake). `serverScopeConsent` records whether
 * the server owner consented to this plugin's whole-machine-data routes. */
export interface ServerPluginEntry {
    version: string;
    digest: string;
    serverScopeConsent: boolean;
}
/**
 * Compare the local registry against the server's handshake table — one
 * {@link BridgeStatus} per LOCAL declaration, in the input order.
 *
 * Judged in this order, first hit wins: offline → the server predates the
 * plugins handshake field (`undefined`, so nothing can match) → the plugin
 * is absent server-side → version differs → version equal but digest
 * differs (same release, different declaration — a skew worth naming) → a
 * `scope:'server'` route without the server owner's consent → bridged.
 *
 * Consent is judged `!== true` on purpose, not `=== false`: an entry without
 * the field (an older server that learned the field later) means UNKNOWN
 * consent, and whole-machine data must stay home until the server says yes.
 */
export declare function compareBridges(local: NormalizedDeclaration[], server: Record<string, ServerPluginEntry> | undefined, online: boolean): BridgeStatus[];
//# sourceMappingURL=plugin-bridge.d.ts.map