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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
/** The value a group carries when its fingerprint could not be computed. */
export const FINGERPRINT_UNAVAILABLE = 'unavailable';
/** Wire prefix of a registry-tier fingerprint. */
const REGISTRY_PREFIX = 'r:';
/** Wire prefix of a file-tier fingerprint. */
const FILE_PREFIX = 'f:';
/** Group name of the forwarded-events fingerprint (no generated definitions). */
export const EVENTS_GROUP = 'events';
/**
 * The interface groups the relay actually exercises, mapped to the DSH
 * package whose descriptors define them (docs/spike-relay.md §4.4). Keys are
 * the wire names both ends exchange — stable ASCII, rendered verbatim by the
 * settings page.
 */
export const FINGERPRINT_GROUP_PACKAGES = {
    session: '@deepseek-ai/dsh-api-session-controller',
    workspace: '@deepseek-ai/dsh-api-workspace-controller',
    job: '@deepseek-ai/dsh-api-job-controller',
    files: '@deepseek-ai/dsh-api-workspace-files',
    subagent: '@deepseek-ai/dsh-subagent',
    goal: '@deepseek-ai/dsh-goal',
};
/** Length of a fingerprint hex string (excluding the algorithm prefix). */
const FINGERPRINT_CHARS = 12;
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** sha256, first {@link FINGERPRINT_CHARS} hex chars — one group fingerprint. */
function shortHash(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, FINGERPRINT_CHARS);
}
/** The algorithm prefix of one fingerprint value ('r:', 'f:', or ''). */
function algorithmOf(value) {
    const colon = value.indexOf(':');
    return colon === -1 ? '' : value.slice(0, colon + 1);
}
/** Anything that quacks like a zod 4 schema: it can project itself. */
function isSchemaLike(value) {
    return isPlainObject(value) && typeof value.toJSONSchema === 'function';
}
/**
 * Recursive canonicalization of one projected JSON Schema document: object
 * keys are sorted at every depth, and `required` arrays — whose order zod
 * inherits from field declaration order and carries no meaning — are sorted
 * alphabetically. Every other array keeps its order (tuple/item order IS
 * meaning). This is what makes a fingerprint immune to field order, not just
 * to `sourceLocation` drift.
 */
function canonicalizeJsonSchema(value) {
    if (Array.isArray(value))
        return value.map(canonicalizeJsonSchema);
    if (isPlainObject(value)) {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            const item = value[key];
            out[key] = key === 'required' && Array.isArray(item) ? [...item].sort() : canonicalizeJsonSchema(item);
        }
        return out;
    }
    return value;
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
export function normalizeDescriptorValue(value, key) {
    if (typeof value === 'function') {
        if (key !== 'create')
            return 'fn';
        try {
            const schema = value();
            if (isSchemaLike(schema))
                return canonicalizeJsonSchema(schema.toJSONSchema({ unrepresentable: 'any' }));
        }
        catch {
            // A function that will not project hashes as the stable marker below.
        }
        return 'fn';
    }
    if (Array.isArray(value))
        return value.map((item) => normalizeDescriptorValue(item));
    if (isPlainObject(value)) {
        const out = {};
        for (const childKey of Object.keys(value).sort()) {
            if (childKey === 'sourceLocation')
                continue;
            out[childKey] = normalizeDescriptorValue(value[childKey], childKey);
        }
        return out;
    }
    return value;
}
/**
 * One package group's registry-tier fingerprint over its descriptors, shown
 * as a pure helper (the empty-set decision belongs to
 * {@link groupFingerprint}, which turns an empty subset into
 * `unavailable` instead of a hash of nothing).
 */
export function fingerprintDescriptors(descriptors) {
    return REGISTRY_PREFIX + shortHash(JSON.stringify(descriptors.map((descriptor) => normalizeDescriptorValue(descriptor))));
}
/**
 * The package-resolution anchors, highest priority first: the HOST process
 * entry (`process.argv[1]` — the running App's closure) beats this plugin's
 * own location, whose node_modules may hold link-installed devDependency
 * copies of packages the host ships at different versions.
 */
function defaultAnchors() {
    const anchors = [];
    const entry = process.argv[1];
    if (typeof entry === 'string' && entry !== '') {
        try {
            anchors.push(pathToFileURL(resolve(entry)).href);
        }
        catch {
            // A strange argv[1] is not an anchor; the plugin anchor stands alone.
        }
    }
    anchors.push(import.meta.url);
    return anchors;
}
/** Resolve `@deepseek-ai/<package>/package.json` through the DSH closure,
 * trying each anchor in order. Throws when no anchor resolves it. */
function resolvePackageJson(packageName, anchors) {
    let lastError;
    for (const anchor of anchors) {
        try {
            return createRequire(anchor).resolve(`${packageName}/package.json`);
        }
        catch (error) {
            lastError = error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error(`${packageName} is not resolvable from any anchor`);
}
/**
 * The file-tier fallback: sha256 over the package's generated remote-client
 * definitions with every `sourceLocation: {…}` fragment stripped. The
 * fragments are flat JSON objects (file/line/column), so the brace-bounded
 * match cannot overeat. Throws when the package is not resolvable — the
 * group degrades instead of guessing.
 */
export function fingerprintPackageFile(packageName, anchors) {
    const packageJson = resolvePackageJson(packageName, anchors ?? defaultAnchors());
    const file = join(dirname(packageJson), 'lib', 'typert.remote-client.js');
    const text = readFileSync(file, 'utf8');
    return FILE_PREFIX + shortHash(text.replace(/sourceLocation:\s*\{[^{}]*\}/gu, ''));
}
/**
 * The events group's fingerprint over `dsh-api-remotes`'s forwarded-events
 * whitelist: `{event, mode}` rows, sorted by event then mode, hashed. A
 * shape that is not an array of named+moded rows throws — the caller
 * degrades the group rather than hashing a guess.
 */
export function fingerprintForwardedEvents(events) {
    if (!Array.isArray(events))
        throw new Error('API_REMOTE_FORWARDED_EVENTS is not an array');
    const rows = [];
    for (const entry of events) {
        if (!isPlainObject(entry))
            throw new Error('forwarded event entry is not an object');
        if (typeof entry.event !== 'string' || typeof entry.mode !== 'string') {
            throw new Error('forwarded event entry carries no event/mode strings');
        }
        rows.push({ event: entry.event, mode: entry.mode });
    }
    rows.sort((left, right) => (left.event === right.event ? (left.mode < right.mode ? -1 : 1) : left.event < right.event ? -1 : 1));
    return REGISTRY_PREFIX + shortHash(JSON.stringify(rows));
}
/** The live typert registry's local descriptors, or undefined. */
function localDescriptors(ctx) {
    try {
        const typert = ctx.reflect?.get('typert');
        const local = typert?.local;
        const list = local?.list;
        if (typeof list !== 'function')
            return undefined;
        const descriptors = list.call(local);
        return Array.isArray(descriptors) ? descriptors : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * One package group: registry tier (empty subset → unavailable, see the
 * module comment), file tier, then unavailable.
 */
function groupFingerprint(packageName, descriptors, anchors) {
    if (descriptors !== undefined) {
        try {
            const mine = descriptors.filter((descriptor) => isPlainObject(descriptor) &&
                typeof descriptor.id === 'string' &&
                descriptor.id.startsWith(`${packageName}#`));
            if (mine.length === 0)
                return FINGERPRINT_UNAVAILABLE;
            return fingerprintDescriptors(mine);
        }
        catch {
            // A projection failure inside one group falls to the file tier.
        }
    }
    try {
        return fingerprintPackageFile(packageName, anchors);
    }
    catch {
        return FINGERPRINT_UNAVAILABLE;
    }
}
/** The events group: resolve `dsh-api-remotes` through the anchors, hash the
 * whitelist; anything unresolved degrades to unavailable. */
async function eventsFingerprint(anchors) {
    for (const anchor of anchors) {
        try {
            const entry = createRequire(anchor).resolve('@deepseek-ai/dsh-api-remotes');
            const mod = (await import(pathToFileURL(entry).href));
            return fingerprintForwardedEvents(mod.API_REMOTE_FORWARDED_EVENTS);
        }
        catch {
            // Try the next anchor; exhaustion degrades the group below.
        }
    }
    return FINGERPRINT_UNAVAILABLE;
}
/**
 * Compute every group's fingerprint for the DSH this context runs in.
 * Per-group try/catch throughout: a group that cannot be computed carries
 * {@link FINGERPRINT_UNAVAILABLE} and never costs the others. The result is
 * cheap enough (~7 ms against a full registry) to recompute per handshake —
 * deliberately NOT cached, because the typert registry assembles
 * asynchronously and a cached map would pin whatever a first handshake
 * happened to see.
 */
export async function computeFingerprints(ctx, options) {
    const anchors = options?.anchors ?? defaultAnchors();
    const descriptors = localDescriptors(ctx);
    const out = {};
    for (const [group, packageName] of Object.entries(FINGERPRINT_GROUP_PACKAGES)) {
        out[group] = groupFingerprint(packageName, descriptors, anchors);
    }
    out[EVENTS_GROUP] = await eventsFingerprint(anchors);
    return out;
}
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
export function compareFingerprints(server, own) {
    const serverMap = isPlainObject(server) ? server : {};
    const ownMap = isPlainObject(own) ? own : {};
    const groups = [...new Set([...Object.keys(serverMap), ...Object.keys(ownMap)])].sort();
    const verdict = { identical: [], different: [], unavailable: [] };
    for (const group of groups) {
        const left = serverMap[group];
        const right = ownMap[group];
        if (typeof left !== 'string' ||
            typeof right !== 'string' ||
            left === FINGERPRINT_UNAVAILABLE ||
            right === FINGERPRINT_UNAVAILABLE) {
            verdict.unavailable.push(group);
        }
        else if (algorithmOf(left) !== algorithmOf(right)) {
            verdict.unavailable.push(group);
        }
        else if (left === right) {
            verdict.identical.push(group);
        }
        else {
            verdict.different.push(group);
        }
    }
    return verdict;
}
//# sourceMappingURL=fingerprint.js.map