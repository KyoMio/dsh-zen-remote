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
 * Pure logic by design: no DSH imports (the one exception is the
 * pure-constants src/upload-limits.ts, itself zero-import), no I/O, no
 * clocks — the digest is
 * the only place node:crypto appears, which is fine because this module only
 * ever runs in the backend process. Nothing here talks to the relay or the
 * network; the handshake side and the request rewrite side are later tasks
 * that consume a {@link BridgeRegistry} through src/index.ts.
 */
import { createHash } from 'node:crypto';
import { MAX_UPLOAD_BYTES } from './upload-limits.js';
/** The HTTP methods a bridged route may forward (PB-9). 2.1 accepted GET
 * only; the write methods arrived with the `methods` field. */
export const BRIDGE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
/** The body cap a route may declare (`maxBody`), in bytes. This is the SAME
 * single 500 MiB ceiling {@link MAX_UPLOAD_BYTES} defines in
 * src/upload-limits.ts, re-exported under the bridge-local name so existing
 * consumers stay untouched: three ceilings that used to be three numbers —
 * the relay's `/v1/upload` route, the sub-client's streaming upload forward
 * (both reading upload-limits.ts directly) and this bridge `maxBody` cap
 * (hand-copied 64 MiB before declaration-v2) — now share one definition, so
 * they can never drift apart again. */
export { MAX_UPLOAD_BYTES as MAX_ROUTE_BODY_BYTES };
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
/** The effective session-id locator of one normalized route. A route that
 * declared none keeps the 2.1 convention: the session id rides the query
 * parameter named by `sessionParam`. */
export function routeLocatorOf(route) {
    return route.locator ?? { in: 'query', name: route.sessionParam };
}
/** The effective prefix mark of one normalized route: does the route admit
 * its variable path tail (sub-paths under `path`)? */
export function routePrefixOf(route) {
    return route.prefix === true;
}
/** The effective remote-deny mark of one normalized route: must this route
 * refuse to serve a REMOTE session (local-only data)? */
export function routeDeniesRemoteOf(route) {
    return route.deny === true;
}
/** The effective id-rewrite mark of one normalized route: does the
 * sub-client rewrite real↔virtual session ids while forwarding? */
export function routeRewritesIdsOf(route) {
    return route.rewriteIds === true;
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
            if (key !== 'path' && key !== 'scope' && key !== 'sessionParam' && key !== 'stream' && key !== 'methods' && key !== 'maxBody' && key !== 'upgrade' && key !== 'locator' && key !== 'prefix' && key !== 'deny' && key !== 'rewriteIds') {
                fail(`routes[${index}].${key}`, 'unknown field (typo guard)');
            }
        }
        const { path, scope, sessionParam, stream, methods, maxBody, upgrade, locator, prefix, deny, rewriteIds } = route;
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
            if (typeof maxBody !== 'number' || !Number.isInteger(maxBody) || maxBody <= 0 || maxBody > MAX_UPLOAD_BYTES) {
                fail(`routes[${index}].maxBody`, `must be a positive integer up to ${MAX_UPLOAD_BYTES}`);
            }
            normalizedMaxBody = maxBody;
        }
        // PB-10: the WebSocket tunnel mark. Only `true` is legal (this is a
        // declaration, not a toggle), it cannot coexist with `stream` (a route
        // is one thing), and it is GET-only — an explicit `methods` naming
        // anything else cannot be an upgrade route.
        // PB-20: `prefix` — a declaration that the route admits its variable
        // path tail (sub-paths under `path`), required by a `path-segment`
        // locator below and refused next to `upgrade` (checked in the upgrade
        // block). Only `true` is legal — this is a declaration, not a toggle.
        let normalizedPrefix;
        if (prefix !== undefined) {
            if (prefix !== true)
                fail(`routes[${index}].prefix`, 'must be true or omitted');
            normalizedPrefix = true;
        }
        let normalizedUpgrade;
        if (upgrade !== undefined) {
            if (upgrade !== true)
                fail(`routes[${index}].upgrade`, 'must be true or omitted');
            if (streamFlag)
                fail(`routes[${index}].upgrade`, 'cannot be combined with stream');
            if (normalizedMethods !== undefined && normalizedMethods.some((entry) => entry !== 'GET')) {
                fail(`routes[${index}].upgrade`, 'upgrade routes are GET-only');
            }
            if (normalizedPrefix === true) {
                fail(`routes[${index}].prefix`, 'cannot be combined with upgrade — a WebSocket tunnel over a prefix route is left for when a need shows up');
            }
            normalizedUpgrade = true;
        }
        // PB-20: `locator` — where the session id lives, REPLACING the
        // query-parameter convention (so the two fields can never coexist; a
        // route without one keeps `sessionParam`'s 2.1 semantics). Shapes and
        // the path-segment/prefix pairing mirror the adapter core's locator
        // (PB-11) so the two ends read identically.
        let normalizedLocator;
        if (locator !== undefined) {
            if (sessionParam !== undefined) {
                fail(`routes[${index}].locator`, 'cannot be combined with sessionParam — a route locates its session id one way');
            }
            if (!isPlainObject(locator))
                fail(`routes[${index}].locator`, 'expected an object');
            if (locator.in === 'query') {
                if (typeof locator.name !== 'string' || !SESSION_PARAM_PATTERN.test(locator.name)) {
                    fail(`routes[${index}].locator.name`, `"${String(locator.name)}" must match ${SESSION_PARAM_PATTERN.source}`);
                }
                normalizedLocator = { in: 'query', name: locator.name };
            }
            else if (locator.in === 'path-segment') {
                if (typeof locator.index !== 'number' || !Number.isInteger(locator.index) || locator.index < 0) {
                    fail(`routes[${index}].locator.index`, 'must be a non-negative integer');
                }
                if (normalizedPrefix !== true) {
                    fail(`routes[${index}].locator`, 'path-segment locating needs prefix: true (the id lives in the variable tail only a prefix route admits)');
                }
                normalizedLocator = { in: 'path-segment', index: locator.index };
            }
            else if (locator.in === 'json-body') {
                if (!Array.isArray(locator.fields) || locator.fields.length === 0 || locator.fields.some((entry) => typeof entry !== 'string' || entry === '')) {
                    fail(`routes[${index}].locator.fields`, 'must be a non-empty array of field names');
                }
                normalizedLocator = { in: 'json-body', fields: [...locator.fields] };
            }
            else {
                fail(`routes[${index}].locator.in`, 'must be "query", "path-segment" or "json-body"');
            }
        }
        // PB-20: `deny` — the route must refuse a REMOTE session (its data is
        // local-only). Only `true` is legal.
        let normalizedDeny;
        if (deny !== undefined) {
            if (deny !== true)
                fail(`routes[${index}].deny`, 'must be true or omitted');
            normalizedDeny = true;
        }
        // PB-20: `rewriteIds` — the sub-client rewrites real↔virtual session
        // ids while forwarding. Never legal on a stream route: a streaming
        // response is never buffered, so there is nothing to rewrite.
        let normalizedRewriteIds;
        if (rewriteIds !== undefined) {
            if (rewriteIds !== true)
                fail(`routes[${index}].rewriteIds`, 'must be true or omitted');
            if (streamFlag)
                fail(`routes[${index}].rewriteIds`, 'cannot be combined with stream — a streaming response is never buffered, so there are no ids to rewrite');
            normalizedRewriteIds = true;
        }
        // Explicit-only (digest rule): the four v2 fields attach to the
        // normalized route ONLY when declared — an absent key, not an
        // `undefined` one, so the canonical form and the deep-equality shape of
        // 2.1-era routes stay byte-for-byte what they were.
        return {
            path,
            scope,
            sessionParam: param,
            stream: streamFlag,
            methods: normalizedMethods,
            maxBody: normalizedMaxBody,
            upgrade: normalizedUpgrade,
            ...(normalizedLocator !== undefined && { locator: normalizedLocator }),
            ...(normalizedPrefix && { prefix: normalizedPrefix }),
            ...(normalizedDeny && { deny: normalizedDeny }),
            ...(normalizedRewriteIds && { rewriteIds: normalizedRewriteIds }),
        };
    });
    normalizedRoutes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // Fixed key order = the canonical form both ends hash; insertion order of
    // the object literal IS the contract, JSON.stringify never sorts. The
    // route entries carry `methods` / `maxBody` / `upgrade` and the four v2
    // fields ONLY when the plugin declared them — `JSON.stringify` drops
    // `undefined` values, but the explicit conditional documents the intent
    // and keeps the PB-1 compatibility visible instead of incidental.
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
            if (route.locator !== undefined)
                entry.locator = route.locator;
            if (route.prefix !== undefined)
                entry.prefix = route.prefix;
            if (route.deny !== undefined)
                entry.deny = route.deny;
            if (route.rewriteIds !== undefined)
                entry.rewriteIds = route.rewriteIds;
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
        registerNormalized(normalized) {
            const replaced = byPlugin.has(normalized.plugin);
            byPlugin.set(normalized.plugin, normalized);
            if (replaced)
                warn?.(`plugin "${normalized.plugin}" re-registered its bridge entry; the earlier one was replaced`);
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