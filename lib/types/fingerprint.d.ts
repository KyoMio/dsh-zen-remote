/**
 * DSH interface fingerprints (T42, the second of the three version-tolerance
 * layers). The sub-client's UI code comes from ITS OWN App while the data
 * comes from the relay server's DSH — when the two DSH versions disagree
 * about an interface shape, individual calls fail at runtime. The fingerprint
 * lets both ends NOTICE without refusing the link (that is the relay
 * protocol's job, layer one): each side hashes a few groups of interface
 * definitions, the server puts its map into the handshake, the client
 * compares group by group, and the settings page lists the differing groups.
 * Identical maps mean fully compatible — the DSH version numbers themselves
 * are deliberately NOT compared (docs/spike-relay.md §2.3: 0.1.7 and 0.2.0
 * share byte-identical remote interfaces, so a version gate would misreject).
 *
 * What is hashed, per group, in priority order:
 *
 * 1. REGISTRY TIER — `ctx.typert.local.list()`, the descriptors the running
 *    DSH actually registered (dsh-typert-registry's `TypertRegistry.local`:
 *    `list()` returns the committed descriptor objects; shape verified against
 *    dsh-typert-registry 0.1.7-rc.2 / 0.1.0-rc.6 `DescriptorStore.list`).
 *    Descriptors are grouped by their `id` prefix `@deepseek-ai/<package>#`,
 *    then canonicalized exactly like the spike's fp.mjs prototype:
 *    `sourceLocation` keys are dropped (their line/column drift with unrelated
 *    edits), every `create` field (the generated descriptors' codec/result
 *    schema producers — the ONLY functions ever called) is projected to JSON
 *    Schema with `unrepresentable: 'any'`, object keys are sorted recursively
 *    (the schema's `required` arrays alphabetically too — see below), and the
 *    JSON is sha256'd. The instance form
 *    `schema.toJSONSchema({ unrepresentable: 'any' })` is used instead of
 *    importing zod — verified byte-identical to `z.toJSONSchema(schema, …)`,
 *    and it spares this package a zod dependency hunt through the host
 *    closure. Reproducing the spike's recorded values with the
 *    key-sorting-only precursor of this normalization matched exactly
 *    (session-controller `be9ab393695a`, 21 endpoints); the recursive schema
 *    canonicalization below only makes that equality stronger — field
 *    declaration order can no longer move a hash.
 * 2. FILE TIER — the task's documented fallback when no usable typert service
 *    (or schema projection) exists: sha256 over the package's
 *    `lib/typert.remote-client.js` with every `sourceLocation: {…}` fragment
 *    stripped. The file is located through `createRequire` resolving
 *    `@deepseek-ai/<package>/package.json`.
 * 3. `FINGERPRINT_UNAVAILABLE` — the group could not be computed here, OR the
 *    registry answered with zero descriptors for the group: the typert
 *    loader registers package by package asynchronously, so a client that
 *    handshakes a just-restarted server would otherwise read a half-empty
 *    registry as "this DSH really runs no such interfaces" and publish
 *    throwaway hashes. Unavailable is NOT a difference — it only feeds the
 *    diagnostics.
 *
 * Every registry value is prefixed `r:`, every file-tier value `f:`. The
 * two tiers hash different material, so a group whose ends normalized
 * through DIFFERENT tiers compares as unavailable — never as a difference.
 *
 * Every group is computed inside its own try/catch, so one broken group never
 * costs the others; the whole map is meant to be recomputed per handshake
 * (~7 ms measured on a full registry — cheap enough to never go stale) and
 * NOT cached: the registry assembles asynchronously, and a cached map would
 * pin whatever a first handshake happened to see. The `events` group has no
 * generated definitions; its input is `dsh-api-remotes`'s exported
 * `API_REMOTE_FORWARDED_EVENTS` (event name + mode, sorted), resolved through
 * the same anchors — unresolvable means unavailable.
 */
/** The value a group carries when its fingerprint could not be computed. */
export declare const FINGERPRINT_UNAVAILABLE = "unavailable";
/** Group name of the forwarded-events fingerprint (no generated definitions). */
export declare const EVENTS_GROUP = "events";
/**
 * The interface groups the relay actually exercises, mapped to the DSH
 * package whose descriptors define them (docs/spike-relay.md §4.4). Keys are
 * the wire names both ends exchange — stable ASCII, rendered verbatim by the
 * settings page.
 */
export declare const FINGERPRINT_GROUP_PACKAGES: Readonly<Record<string, string>>;
/**
 * The piece of cordis this module needs: the reflection layer's service
 * lookup, used to read `typert` without declaring an inject (a context
 * without the service answers undefined, same as the shares routes' reads).
 * Structural on purpose: the fingerprints compute in compositions this
 * package cannot type against.
 */
export interface FingerprintContext {
    reflect?: {
        get(name: string): unknown;
    };
}
/** Injectable knobs — the resolution anchors, for tests. */
export interface FingerprintOptions {
    /**
     * Package-resolution anchors, HIGHEST priority first. Each anchor seeds a
     * `createRequire` that walks node_modules upward from it. The default puts
     * the host process entry first (`process.argv[1]` — inside the running
     * App's closure) and this plugin second: a link-installed plugin carries
     * devDependency copies of the DSH packages, and reading those would
     * fingerprint a version the host is not actually running.
     */
    anchors?: readonly string[];
}
/** The group-by-group comparison result the relay client stores. */
export interface RelayCompatVerdict {
    /** Groups whose fingerprints match exactly. */
    identical: string[];
    /** Groups whose fingerprints differ — the yellow-hint material. */
    different: string[];
    /** Groups at least one end could not compute — or whose values came out
     * of different normalization tiers and are therefore not comparable.
     * Never a difference. */
    unavailable: string[];
}
/**
 * The canonicalization from the spike's fp.mjs prototype, kept faithful
 * where the spike proved it (sourceLocation dropped, keys sorted, schemas
 * projected with `unrepresentable: 'any'`), tightened in two places: only a
 * field NAMED `create` is treated as a schema producer — the generated
 * descriptors project schemas there and nowhere else, so any other function
 * (`decode`, `encode`, …) collapses to the stable marker `'fn'` WITHOUT
 * being called; and the projection is recursively key-sorted (see
 * {@link canonicalizeJsonSchema}).
 */
export declare function normalizeDescriptorValue(value: unknown, key?: string): unknown;
/**
 * One package group's registry-tier fingerprint over its descriptors, shown
 * as a pure helper (the empty-set decision belongs to
 * {@link groupFingerprint}, which turns an empty subset into
 * `unavailable` instead of a hash of nothing).
 */
export declare function fingerprintDescriptors(descriptors: readonly unknown[]): string;
/**
 * The file-tier fallback: sha256 over the package's generated remote-client
 * definitions with every `sourceLocation: {…}` fragment stripped. The
 * fragments are flat JSON objects (file/line/column), so the brace-bounded
 * match cannot overeat. Throws when the package is not resolvable — the
 * group degrades instead of guessing.
 */
export declare function fingerprintPackageFile(packageName: string, anchors?: readonly string[]): string;
/**
 * The events group's fingerprint over `dsh-api-remotes`'s forwarded-events
 * whitelist: `{event, mode}` rows, sorted by event then mode, hashed. A
 * shape that is not an array of named+moded rows throws — the caller
 * degrades the group rather than hashing a guess.
 */
export declare function fingerprintForwardedEvents(events: unknown): string;
/**
 * Compute every group's fingerprint for the DSH this context runs in.
 * Per-group try/catch throughout: a group that cannot be computed carries
 * {@link FINGERPRINT_UNAVAILABLE} and never costs the others. The result is
 * cheap enough (~7 ms against a full registry) to recompute per handshake —
 * deliberately NOT cached, because the typert registry assembles
 * asynchronously and a cached map would pin whatever a first handshake
 * happened to see.
 */
export declare function computeFingerprints(ctx: FingerprintContext, options?: FingerprintOptions): Promise<Record<string, string>>;
/**
 * Compare the server's handshake fingerprints against this side's own,
 * group by group over the union of both maps. A group either side could
 * not compute (`FINGERPRINT_UNAVAILABLE`, a missing key, a non-string a
 * hostile server substituted) lands in `unavailable` — never in
 * `different`, so a half-blind comparison stays silent instead of crying
 * wolf. The same goes for a group whose two values carry DIFFERENT
 * algorithm prefixes (`r:` vs `f:`): they were normalized from different
 * material and must not be diffed against each other. Pure; unit-tested
 * against injected maps.
 */
export declare function compareFingerprints(server: unknown, own: unknown): RelayCompatVerdict;
//# sourceMappingURL=fingerprint.d.ts.map