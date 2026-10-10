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
import { createHash } from 'node:crypto';
/** The HTTP methods a bridged route may forward (PB-9). 2.1 accepted GET
 * only; the write methods arrived with the `methods` field. */
export const BRIDGE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
/** The body cap a route may declare (`maxBody`), in bytes: 64 MiB. */
export const MAX_ROUTE_BODY_BYTES = 64 * 1024 * 1024;
/** The body cap a route gets when it declares none: 1 MiB. */
export const DEFAULT_ROUTE_BODY_BYTES = 1024 * 1024;
/** The effective upgrade mark of one normalized route. */
export function routeUpgradesOf(route) {
    return route.upgrade === true;
}
/** The effective forwardable methods of one normalized route. */
export function routeMethodsOf(route) {
    return route.methods ?? ['GET'];
}
/** The effective body cap of one normalized route, in bytes. */
export function routeMaxBodyOf(route) {
    return route.maxBody ?? DEFAULT_ROUTE_BODY_BYTES;
}
/** Longest legal `plugin` — the npm package name cap. */
const MAX_PLUGIN_LENGTH = 214;
/** Most routes one declaration may carry. */
const MAX_ROUTES = 64;
/** npm package name shape: lowercase, URL-safe run of `[a-z0-9._-]` that
 * starts with a letter or digit, optionally `@scope/name` with the same body
 * rules on both halves. Not the full official validator (reserved names,
 * edge punctuation) — enough that a typo'd string cannot masquerade as a
 * package name and that the two ends normalize identically. */
const PLUGIN_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
/** Query-parameter name carrying the session id. */
const SESSION_PARAM_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Every rejection says WHICH field failed and why. */
function fail(field, detail) {
    throw new Error(`invalid bridge declaration, ${field}: ${detail}`);
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
export function normalizeDeclaration(input) {
    if (!isPlainObject(input))
        fail('declaration', 'expected an object');
    for (const key of Object.keys(input)) {
        if (key !== 'plugin' && key !== 'version' && key !== 'routes')
            fail(key, 'unknown field (typo guard)');
    }
    const { plugin, version, routes } = input;
    if (typeof plugin !== 'string' || plugin === '')
        fail('plugin', 'must be a non-empty string');
    if (plugin.length > MAX_PLUGIN_LENGTH)
        fail('plugin', `longer than ${MAX_PLUGIN_LENGTH} characters`);
    if (!PLUGIN_PATTERN.test(plugin))
        fail('plugin', `"${plugin}" is not an npm package name`);
    if (typeof version !== 'string' || version.trim() === '')
        fail('version', 'must be a non-empty string');
    if (!Array.isArray(routes) || routes.length === 0)
        fail('routes', 'must be a non-empty array');
    if (routes.length > MAX_ROUTES)
        fail('routes', `${routes.length} routes exceeds the ${MAX_ROUTES} cap`);
    const seen = new Set();
    const normalizedRoutes = routes.map((route, index) => {
        if (!isPlainObject(route))
            fail(`routes[${index}]`, 'expected an object');
        for (const key of Object.keys(route)) {
            if (key !== 'path' && key !== 'scope' && key !== 'sessionParam' && key !== 'stream' && key !== 'methods' && key !== 'maxBody' && key !== 'upgrade') {
                fail(`routes[${index}].${key}`, 'unknown field (typo guard)');
            }
        }
        const { path, scope, sessionParam, stream, methods, maxBody, upgrade } = route;
        if (typeof path !== 'string' || path === '')
            fail(`routes[${index}].path`, 'must be a non-empty string');
        if (!path.startsWith('/'))
            fail(`routes[${index}].path`, `"${path}" must start with "/"`);
        if (path.includes('?'))
            fail(`routes[${index}].path`, `"${path}" must not contain "?"`);
        if (path.includes('#'))
            fail(`routes[${index}].path`, `"${path}" must not contain "#"`);
        if (path.includes('..'))
            fail(`routes[${index}].path`, `"${path}" must not contain ".."`);
        if (/\s/u.test(path))
            fail(`routes[${index}].path`, `"${path}" must not contain whitespace`);
        if (path.startsWith('/_dsh/') || path.startsWith('/api')) {
            fail(`routes[${index}].path`, `"${path}" starts with a host-owned prefix (/_dsh/ or /api) and cannot be bridged`);
        }
        if (scope !== 'session' && scope !== 'server') {
            fail(`routes[${index}].scope`, 'must be "session" or "server"');
        }
        const param = sessionParam === undefined ? 'sessionId' : sessionParam;
        if (typeof param !== 'string' || !SESSION_PARAM_PATTERN.test(param)) {
            fail(`routes[${index}].sessionParam`, `"${String(param)}" must match ${SESSION_PARAM_PATTERN.source}`);
        }
        const streamFlag = stream === undefined ? false : stream;
        if (typeof streamFlag !== 'boolean')
            fail(`routes[${index}].stream`, 'must be a boolean');
        if (seen.has(path))
            fail(`routes[${index}].path`, `duplicate path "${path}"`);
        seen.add(path);
        // PB-9: the forwardable methods — uppercase members of the fixed
        // vocabulary only (method names are case-sensitive on the wire; a
        // lowercase or mixed-case entry is exactly the typo the strictness
        // exists to catch), deduplicated and sorted so order never moves the
        // digest. Omitted stays `undefined` — the digest-preserving choice: a
        // 2.1-era declaration must hash EXACTLY as it did before this field
        // existed, so defaults never enter the canonical form.
        let normalizedMethods;
        if (methods !== undefined) {
            if (!Array.isArray(methods) || methods.length === 0) {
                fail(`routes[${index}].methods`, 'must be a non-empty array of HTTP methods');
            }
            const upper = [];
            for (const entry of methods) {
                if (typeof entry !== 'string' || !BRIDGE_METHODS.includes(entry)) {
                    fail(`routes[${index}].methods`, `${JSON.stringify(entry ?? null)} is not one of ${BRIDGE_METHODS.join(', ')}`);
                }
                if (!upper.includes(entry))
                    upper.push(entry);
            }
            upper.sort();
            normalizedMethods = upper;
        }
        // PB-9: the body cap — a positive integer, at most
        // {@link MAX_ROUTE_BODY_BYTES}. Same digest rule as `methods`: only an
        // EXPLICIT maxBody enters the canonical form, even when it equals the
        // default.
        let normalizedMaxBody;
        if (maxBody !== undefined) {
            if (typeof maxBody !== 'number' || !Number.isInteger(maxBody) || maxBody <= 0 || maxBody > MAX_ROUTE_BODY_BYTES) {
                fail(`routes[${index}].maxBody`, `must be a positive integer up to ${MAX_ROUTE_BODY_BYTES}`);
            }
            normalizedMaxBody = maxBody;
        }
        // PB-10: the WebSocket tunnel mark. Only `true` is legal (this is a
        // declaration, not a toggle), it cannot coexist with `stream` (a route
        // is one thing), and it is GET-only — an explicit `methods` naming
        // anything else cannot be an upgrade route.
        let normalizedUpgrade;
        if (upgrade !== undefined) {
            if (upgrade !== true)
                fail(`routes[${index}].upgrade`, 'must be true or omitted');
            if (streamFlag)
                fail(`routes[${index}].upgrade`, 'cannot be combined with stream');
            if (normalizedMethods !== undefined && normalizedMethods.some((entry) => entry !== 'GET')) {
                fail(`routes[${index}].upgrade`, 'upgrade routes are GET-only');
            }
            normalizedUpgrade = true;
        }
        return { path, scope, sessionParam: param, stream: streamFlag, methods: normalizedMethods, maxBody: normalizedMaxBody, upgrade: normalizedUpgrade };
    });
    normalizedRoutes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // Fixed key order = the canonical form both ends hash; insertion order of
    // the object literal IS the contract, JSON.stringify never sorts. The
    // route entries carry `methods` / `maxBody` ONLY when the plugin declared
    // them — `JSON.stringify` drops `undefined` values, but the explicit
    // conditional documents the intent and keeps the PB-1 compatibility
    // visible instead of incidental.
    const canonical = JSON.stringify({
        plugin,
        version,
        routes: normalizedRoutes.map((route) => {
            const entry = {
                path: route.path,
                scope: route.scope,
                sessionParam: route.sessionParam,
                stream: route.stream,
            };
            if (route.methods !== undefined)
                entry.methods = route.methods;
            if (route.maxBody !== undefined)
                entry.maxBody = route.maxBody;
            if (route.upgrade !== undefined)
                entry.upgrade = route.upgrade;
            return entry;
        }),
    });
    const digest = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
    return { plugin, version, routes: normalizedRoutes, digest };
}
/**
 * Create the registry one DSH process (one plugin row) owns.
 *
 * Overwrite bookkeeping is identity-based, not flag-based: each dispose
 * closes over the exact declaration object it registered and only deletes
 * the table entry while it is STILL that object — a stale dispose meeting a
 * newer registration finds someone else's identity and does nothing.
 */
export function createBridgeRegistry(options = {}) {
    const byPlugin = new Map();
    const listeners = new Set();
    const warn = options.warn;
    // A throwing listener must not break the register/remove that invoked it —
    // registration is bookkeeping other plugins depend on, a bad observer is
    // that observer's problem. Failures surface through warn when there is one.
    const emit = () => {
        for (const listener of [...listeners]) {
            try {
                listener();
            }
            catch (error) {
                warn?.(`a zenRemote onChange listener failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    };
    return {
        register(input) {
            const normalized = normalizeDeclaration(input);
            const replaced = byPlugin.has(normalized.plugin);
            byPlugin.set(normalized.plugin, normalized);
            if (replaced)
                warn?.(`plugin "${normalized.plugin}" re-registered its bridge declaration; the earlier one was replaced`);
            emit();
            return () => {
                if (byPlugin.get(normalized.plugin) !== normalized)
                    return;
                byPlugin.delete(normalized.plugin);
                emit();
            };
        },
        list() {
            return [...byPlugin.values()].sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0));
        },
        get(plugin) {
            return byPlugin.get(plugin);
        },
        onChange(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
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
export function compareBridges(local, server, online) {
    return local.map((declaration) => {
        const localStatus = { plugin: declaration.plugin, bridged: false, localVersion: declaration.version };
        if (!online)
            return { ...localStatus, reason: 'offline' };
        if (server === undefined)
            return { ...localStatus, reason: 'server-too-old' };
        const entry = server[declaration.plugin];
        if (typeof entry !== 'object' || entry === null)
            return { ...localStatus, reason: 'not-on-server' };
        const record = entry;
        const serverVersion = typeof record.version === 'string' ? record.version : undefined;
        if (serverVersion !== declaration.version)
            return { ...localStatus, reason: 'version-mismatch', serverVersion };
        if (record.digest !== declaration.digest)
            return { ...localStatus, reason: 'declaration-mismatch', serverVersion };
        const hasServerScopeRoute = declaration.routes.some((route) => route.scope === 'server');
        if (hasServerScopeRoute && record.serverScopeConsent !== true) {
            return { ...localStatus, reason: 'consent-off', serverVersion };
        }
        return { plugin: declaration.plugin, bridged: true, localVersion: declaration.version, serverVersion };
    });
}
//# sourceMappingURL=plugin-bridge.js.map