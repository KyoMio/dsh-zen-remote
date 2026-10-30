/**
 * The plugin bridge's adapter core (PB-11) — the framework half of the
 * pluggable adapters. A cooperative plugin registers its OWN bridge
 * declaration (PB-1); an adapter is zen-remote-internal code, written
 * against one third-party plugin's EXACT version, that locates the session
 * ids in that plugin's requests and rewrites them both ways (GLOSSARY:
 * 适配器). This module owns everything the framework needs to run one:
 * the route/locator shapes, their validation, the locate → classify →
 * rewrite pipeline, and the digest the adapter registers under.
 *
 * Deliberately OUTSIDE `src/adapters/`: the pluggability contract
 * (test/adapters-pluggable.test.cjs) is that deleting that directory breaks
 * ONLY the wiring import in src/index.ts. The adapter-author face — the
 * `BridgeAdapter` interface — lives in `src/adapters/types.ts` ON TOP of
 * the shapes defined here (it re-exports them), so the framework never
 * imports a single thing from `src/adapters/`.
 *
 * Pure logic: no DSH, no I/O. The id semantics ride src/virtual-id.ts —
 * a request counts as REMOTE exactly when every id the route's locator
 * finds is a `zr~` virtual id, and the rewrite swaps each for its real
 * half before the request leaves for the relay (docs/adr/0001: the
 * sub-client never lets a remote session's request reach a local plugin).
 */
import { createHash } from 'node:crypto';
import { isVirtual, fromVirtual } from './virtual-id.js';
import { MAX_UPLOAD_BYTES } from './upload-limits.js';
import { BRIDGE_METHODS, DEFAULT_ROUTE_BODY_BYTES } from './plugin-bridge.js';
export { fromVirtual };
/** The npm package name of an adapter's target, same shape the cooperative
 * declarations validate. */
const PLUGIN_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const MAX_ROUTES = 64;
/** The body cap an ADAPTER route may declare: the relay's own upload
 * budget (`MAX_UPLOAD_BYTES` in upload-limits.ts), which the better-sidebar
 * upload route rides. The same 500 MiB the cooperative declaration's
 * maxBody allows — both read the one constant since PB-20; raw media
 * uploads are exactly what an adapter exists to carry. */
export const MAX_ADAPTER_BODY_BYTES = MAX_UPLOAD_BYTES;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(field, detail) {
    throw new Error(`invalid adapter, ${field}: ${detail}`);
}
/** Validate one adapter's route table and fold it, together with the
 * INSTALLED plugin version, into the registry-ready form.
 *
 * Route paths follow the cooperative declaration's rules verbatim (plain
 * absolute paths, off the host-owned `/_dsh/` and `/api` prefixes) — an
 * adapter must not be able to reach anything a declaration cannot. The
 * installed version must be listed EXACTLY (`versions` are what the
 * adapter was written against) — with ONE out (PB-19): a version outside
 * the list is admitted anyway when `options.surfaceDigest` — the wiring's
 * extraction of the INSTALLED build's wire surface — is a key of the
 * adapter's `surfaces` table; the registration then carries the installed
 * version with the usual route-table digest, so two machines on the same
 * unlisted-but-surface-identical release still agree. A miss refuses with
 * the digest and the table's size in the message, for the logs.
 * @throws with a field-naming message on any illegal shape.
 */
export function normalizeAdapter(input, installedVersion, options) {
    if (!isRecord(input))
        fail('adapter', 'expected an object');
    for (const key of Object.keys(input)) {
        if (key !== 'plugin' && key !== 'versions' && key !== 'routes' && key !== 'client' && key !== 'server' && key !== 'surfaces') {
            fail(key, 'unknown field (typo guard)');
        }
    }
    const { plugin, versions, routes } = input;
    if (typeof plugin !== 'string' || plugin === '' || plugin.length > 214 || !PLUGIN_PATTERN.test(plugin)) {
        fail('plugin', `"${String(plugin)}" is not an npm package name`);
    }
    if (!Array.isArray(versions) || versions.length === 0 || versions.some((v) => typeof v !== 'string' || v === '')) {
        fail('versions', 'must be a non-empty array of version strings');
    }
    // The surfaces table is validated whenever present, listed version or not
    // (a malformed credential must not lurk until the one version that needs it).
    if (input.surfaces !== undefined) {
        if (!isRecord(input.surfaces))
            fail('surfaces', 'expected an object (digest16 → remark)');
        for (const [key, value] of Object.entries(input.surfaces)) {
            if (!/^[0-9a-f]{16}$/u.test(key))
                fail(`surfaces.${key}`, 'the key must be a 16-hex surface digest');
            if (typeof value !== 'string' || value === '')
                fail(`surfaces.${key}`, 'the remark must be a non-empty string');
        }
    }
    if (!versions.includes(installedVersion)) {
        const surfaceDigest = options?.surfaceDigest;
        const surfaces = input.surfaces;
        if (!(surfaceDigest !== undefined && surfaces !== undefined && Object.hasOwn(surfaces, surfaceDigest))) {
            fail('versions', `installed version "${installedVersion}" is not among the adapter's versions (surface ${surfaceDigest ?? 'not computed'} vs ${surfaces === undefined ? 0 : Object.keys(surfaces).length} listed)`);
        }
    }
    if (!Array.isArray(routes) || routes.length === 0)
        fail('routes', 'must be a non-empty array');
    if (routes.length > MAX_ROUTES)
        fail('routes', `${routes.length} routes exceeds the ${MAX_ROUTES} cap`);
    const seen = new Set();
    const normalized = routes.map((route, index) => {
        if (!isRecord(route))
            fail(`routes[${index}]`, 'expected an object');
        for (const key of Object.keys(route)) {
            if (key !== 'path' && key !== 'match' && key !== 'methods' && key !== 'maxBody' && key !== 'stream' && key !== 'upgrade' && key !== 'locator' && key !== 'local' && key !== 'deny') {
                fail(`routes[${index}].${key}`, 'unknown field (typo guard)');
            }
        }
        const { path, match, methods, maxBody, stream, upgrade, locator, local, deny } = route;
        if (typeof path !== 'string' || path === '' || !path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('..') || /\s/u.test(path)) {
            fail(`routes[${index}].path`, `"${String(path)}" must be a plain absolute path`);
        }
        if (path.startsWith('/_dsh/') || path.startsWith('/api')) {
            fail(`routes[${index}].path`, `"${path}" starts with a host-owned prefix (/_dsh/ or /api)`);
        }
        if (match !== 'exact' && match !== 'prefix')
            fail(`routes[${index}].match`, 'must be "exact" or "prefix"');
        if (seen.has(path))
            fail(`routes[${index}].path`, `duplicate path "${path}"`);
        seen.add(path);
        let normalizedMethods;
        if (methods === undefined) {
            normalizedMethods = ['GET'];
        }
        else {
            if (!Array.isArray(methods) || methods.length === 0)
                fail(`routes[${index}].methods`, 'must be a non-empty array of HTTP methods');
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
        const normalizedMaxBody = maxBody === undefined ? DEFAULT_ROUTE_BODY_BYTES : maxBody;
        if (typeof normalizedMaxBody !== 'number' || !Number.isInteger(normalizedMaxBody) || normalizedMaxBody <= 0 || normalizedMaxBody > MAX_ADAPTER_BODY_BYTES) {
            fail(`routes[${index}].maxBody`, `must be a positive integer up to ${MAX_ADAPTER_BODY_BYTES}`);
        }
        const normalizedStream = stream === undefined ? false : stream;
        if (typeof normalizedStream !== 'boolean')
            fail(`routes[${index}].stream`, 'must be a boolean');
        const normalizedUpgrade = upgrade === undefined ? false : upgrade;
        if (typeof normalizedUpgrade !== 'boolean')
            fail(`routes[${index}].upgrade`, 'must be a boolean');
        if (normalizedUpgrade) {
            if (normalizedStream)
                fail(`routes[${index}].upgrade`, 'cannot be combined with stream');
            if (normalizedMethods.some((entry) => entry !== 'GET'))
                fail(`routes[${index}].upgrade`, 'upgrade routes are GET-only');
        }
        if (!isRecord(locator))
            fail(`routes[${index}].locator`, 'expected an object');
        if (locator.in === 'query') {
            if (typeof locator.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(locator.name)) {
                fail(`routes[${index}].locator.name`, 'must be a query parameter name');
            }
        }
        else if (locator.in === 'path-segment') {
            if (typeof locator.index !== 'number' || !Number.isInteger(locator.index) || locator.index < 0) {
                fail(`routes[${index}].locator.index`, 'must be a non-negative integer');
            }
            if (match !== 'prefix')
                fail(`routes[${index}].locator`, 'path-segment locating needs a prefix route');
        }
        else if (locator.in === 'json-body') {
            if (!Array.isArray(locator.fields) || locator.fields.length === 0 || locator.fields.some((f) => typeof f !== 'string' || f === '')) {
                fail(`routes[${index}].locator.fields`, 'must be a non-empty array of top-level field names');
            }
        }
        else {
            fail(`routes[${index}].locator.in`, 'must be "query", "path-segment" or "json-body"');
        }
        if (local !== undefined && local !== true && local !== false)
            fail(`routes[${index}].local`, 'must be a boolean');
        const normalizedLocal = local === true;
        if (deny !== undefined && typeof deny !== 'function')
            fail(`routes[${index}].deny`, 'must be a function or omitted');
        return {
            path,
            match,
            methods: normalizedMethods,
            maxBody: normalizedMaxBody,
            stream: normalizedStream,
            upgrade: normalizedUpgrade,
            locator: locator,
            local: normalizedLocal,
            ...(deny !== undefined && typeof deny === 'function' ? { deny: deny } : {}),
        };
    });
    normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const digest = adapterDigestOf(plugin, installedVersion, normalized);
    // The registry entry: server-scope routes only (an adapter is whole-machine
    // data by definition — the consent wall applies per plugin, default off),
    // local routes left out (they never forward, so the server half must never
    // see them).
    const declaration = {
        plugin,
        version: installedVersion,
        routes: normalized
            .filter((route) => !route.local)
            .map((route) => ({
            path: route.path,
            scope: 'server',
            sessionParam: 'sessionId',
            stream: route.stream,
            methods: route.methods.length === 1 && route.methods[0] === 'GET' ? undefined : [...route.methods],
            maxBody: route.maxBody === DEFAULT_ROUTE_BODY_BYTES ? undefined : route.maxBody,
            upgrade: route.upgrade ? true : undefined,
            // PB-26b: an upgrade route whose ids do NOT ride the query keeps its
            // locator on the registry entry — the tunnel's validation and the
            // client's upgrade surrogate read where the ids actually arrive (the
            // sidechat ws watch carries them in the post-handshake JSON frames).
            // A query route's declaration stays EXACTLY the 2.1 shape — no
            // locator key — so every older consumer and digest is untouched
            // (the adapter digest always covered route.locator and never
            // covered the declaration routes' shape).
            ...(route.upgrade && route.locator.in !== 'query' ? { locator: route.locator } : {}),
        })),
        digest,
    };
    const hooks = {};
    if (isRecord(input.client) || input.client === undefined) {
        const client = input.client;
        if (client !== undefined && (typeof client.request === 'function' || typeof client.response === 'function')) {
            hooks.client = {
                ...(typeof client.request === 'function' ? { request: (ctx) => client.request(ctx) } : {}),
                ...(typeof client.response === 'function' ? { response: (ctx) => client.response(ctx) } : {}),
            };
        }
    }
    if (isRecord(input.server) || input.server === undefined) {
        const server = input.server;
        if (server !== undefined && typeof server.request === 'function') {
            hooks.server = { request: (ctx) => server.request(ctx) };
        }
    }
    return { plugin, versions: [...versions], routes: normalized, digest, declaration, hooks };
}
/** The digest of one adapter's route table: sha256 over a canonical JSON of
 * `{plugin, version, routes}` — the locator and the match mode INCLUDED (a
 * different locating rule is a different adapter), hex, first 16 chars.
 * Routes arrive path-sorted, so order never moves the hash. */
export function adapterDigestOf(plugin, version, routes) {
    const canonical = JSON.stringify({
        plugin,
        version,
        routes: routes.map((route) => ({
            path: route.path,
            match: route.match,
            methods: route.methods,
            maxBody: route.maxBody,
            stream: route.stream,
            upgrade: route.upgrade,
            locator: route.locator,
            local: route.local,
        })),
    });
    return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}
/** The prefix-match rule, shared verbatim by both halves: equality, or any
 * deeper sub-path (`startsWith(path + '/')`), on the RAW undecoded pathname. */
export function adapterPathMatches(route, pathname) {
    if (route.match === 'exact')
        return pathname === route.path;
    return pathname === route.path || pathname.startsWith(`${route.path}/`);
}
/** The prefix TAIL's shape red line (PB-23b): the part of the RAW pathname
 * AFTER a matched prefix path — the variable tail prefix matching admits —
 * refuses `?`, `#`, `..` and whitespace. Exact equality inherited these
 * declaration-side red lines structurally (the declared path itself passed
 * them at registration); a prefix hit forwards an arbitrary tail straight
 * into the loopback request line, so the tail carries them itself. A `?`
 * would break the parse-once query discipline (the loopback appends ITS
 * `?query`, and a host splits at the FIRST `?` — the unchecked part would
 * ride in as query); a `#` is fragment garbage in the request line;
 * whitespace mirrors the declaration rule. `..` is refused RAW and in its
 * `%2e`/`%2E` encoding — ANY encoded dot, not just the `%2e%2e` pair, since
 * a mixed form like `.%2e.` decodes to dot-dot and would slip a pair-only
 * check. The verdict deliberately runs on the RAW bytes (reject-on-sight),
 * not decode-then-check: `.` is RFC 3986-unreserved, so no legitimate
 * encoder — including this module's own `encodeURIComponent` rewrite — ever
 * produces `%2e`, while a decoded verdict would depend on the decode depth
 * (`%252e%252e` survives one decode) and on malformed-escape handling,
 * i.e. on exactly the host-decoder behavior this red line exists because it
 * is NOT pinned. The check is tail-only because a declaration may legally
 * carry `%` (only these four shapes are refused at registration) — judging
 * the whole pathname would retro-illegalize blessed declarations. Both
 * halves answer the refusal with 400 `bad-request`, the coordinate-shape
 * code the entries already use (no client classifies on it). */
const TAIL_SHAPE_VIOLATION = /[?#\s]|\.\.|%2e/iu;
/** Whether {@link adapterPathMatches} hit via a deeper tail whose shape
 * breaks the red line — `false` for a non-match (the caller's routing
 * refusal answers first) and for an equality hit (no tail at all). */
export function adapterTailShapeViolation(route, pathname) {
    if (!adapterPathMatches(route, pathname))
        return false;
    if (pathname === route.path)
        return false;
    return TAIL_SHAPE_VIOLATION.test(pathname.slice(route.path.length));
}
/** The adapter route a forwarded request hit, or `undefined`. `local`
 * routes never match here — they stay on the sub-client's own machine in
 * both directions, so the server half must never see (nor serve) them. */
export function matchAdapterRoute(adapters, pathname) {
    if (adapters === undefined)
        return undefined;
    for (const adapter of adapters) {
        for (const route of adapter.routes) {
            if (route.local)
                continue;
            if (adapterPathMatches(route, pathname))
                return { adapter, route };
        }
    }
    return undefined;
}
/** Thrown when a query parameter the locator reads appears with MORE than
 * one value: the cooperative bridge refuses such requests as `bad-query`
 * (a duplicated id is a shape violation, never a forward of whichever
 * duplicate a parser happens to keep), and so does the adapter (PB-12
 * review note — the old behavior silently collapsed to `set`, rewriting
 * only one of the values). Callers catch this and answer 503/400
 * `bad-query`. */
export class AdapterMultiValueQueryError extends Error {
    constructor(name) {
        super(`query parameter "${name}" appears more than once`);
        this.name = 'AdapterMultiValueQueryError';
    }
}
/** Locate the session ids one request carries for one route. A query
 * parameter counts once per value it appears with; a JSON body field counts
 * when present with a non-empty string value; a path segment counts when
 * the segment exists (decoded once off the wire). */
export function locateAdapterIds(route, pathname, search, body) {
    const hits = [];
    const locator = route.locator;
    if (locator.in === 'query') {
        const values = search.getAll(locator.name);
        if (values.length > 1)
            throw new AdapterMultiValueQueryError(locator.name);
        for (const value of values) {
            if (value !== '')
                hits.push({ kind: 'query', key: locator.name, value });
        }
    }
    else if (locator.in === 'path-segment') {
        // `index` counts the segments AFTER the declared path: /p/api + open/X
        // → index 0 is "open", index 1 is "X". In split('/') terms the prefix
        // occupies subscripts 1..prefixDepth, so the target sits one past it.
        const prefixDepth = route.path.split('/').length - 1;
        const segments = pathname.split('/');
        const at = prefixDepth + 1 + locator.index;
        if (at < segments.length && segments[at] !== '') {
            let decoded = segments[at];
            try {
                decoded = decodeURIComponent(segments[at]);
            }
            catch {
                // A malformed escape stays verbatim — the value simply will not be
                // a session id.
            }
            hits.push({ kind: 'path-segment', key: undefined, value: decoded });
        }
    }
    else {
        if (isRecord(body)) {
            for (const field of locator.fields) {
                const value = body[field];
                if (typeof value === 'string' && value !== '')
                    hits.push({ kind: 'json-body', key: field, value });
                // PB-26b: a field may carry a LIST of ids — better-sidebar's sidechat
                // ws watch frame sends `{"op":"watch","threadIds":[...]}`. Every
                // non-empty string element is one hit under the same field key, so
                // classify/rewrite treat the batch exactly like repeated query
                // values: every id virtual → remote, one mixed in → refuse.
                else if (Array.isArray(value)) {
                    for (const item of value) {
                        if (typeof item === 'string' && item !== '')
                            hits.push({ kind: 'json-body', key: field, value: item });
                    }
                }
            }
        }
    }
    return hits;
}
export function classifyAdapterRequest(route, pathname, search, body) {
    const hits = locateAdapterIds(route, pathname, search, body);
    if (hits.length === 0)
        return { kind: 'local' };
    const virtual = hits.map((hit) => isVirtual(hit.value));
    if (virtual.every(Boolean))
        return { kind: 'remote', hits };
    if (virtual.every((entry) => !entry))
        return { kind: 'local' };
    return { kind: 'mixed' };
}
/** Swap every located virtual id for its real half (the pure client-half
 * rewrite): the query is re-serialized, the path segment re-encoded, the
 * JSON body re-serialized. The re-encode direction is the wire contract —
 * `encodeURIComponent` of the real id is what the server decodes again. */
export function rewriteAdapterRequest(route, pathname, search, body, hits, realIdOf) {
    const rewrittenQuery = new URLSearchParams(search);
    let rewrittenPathname = pathname;
    let bodyText;
    // The body copy is made ONCE: several fields of one body can locate ids,
    // and re-copying per hit would drop every earlier field's rewrite.
    let bodyCopy;
    for (const hit of hits) {
        const parts = fromVirtual(hit.value);
        if (parts === undefined)
            continue;
        const real = realIdOf(hit.value);
        if (hit.kind === 'query') {
            rewrittenQuery.set(hit.key, real);
        }
        else if (hit.kind === 'path-segment') {
            const prefixDepth = route.path.split('/').length - 1;
            const segments = rewrittenPathname.split('/');
            segments[prefixDepth + 1 + route.locator.index] = encodeURIComponent(real);
            rewrittenPathname = segments.join('/');
        }
        else {
            if (bodyCopy === undefined && isRecord(body))
                bodyCopy = { ...body };
            if (bodyCopy !== undefined) {
                const current = bodyCopy[hit.key];
                // PB-26b: an array field rewrites IN PLACE, element for element —
                // only the entries equal to this hit's located value swap for their
                // real halves, so a mixed batch of ids keeps its shape and order.
                if (Array.isArray(current)) {
                    bodyCopy[hit.key] = current.map((item) => (item === hit.value ? real : item));
                }
                else {
                    bodyCopy[hit.key] = real;
                }
                bodyText = JSON.stringify(bodyCopy);
            }
        }
    }
    return { pathname: rewrittenPathname, query: rewrittenQuery, bodyText };
}
/** Whether the adapter still owns its plugin's registry entry, or a
 * cooperative declaration (the plugin's OWN `zenRemote.bridge(...)`, which
 * always wins) has taken the seat since: an entry with a different digest
 * means the adapter yielded. */
export function adapterOwnsRegistryEntry(adapter, registryEntry) {
    return registryEntry !== undefined && registryEntry.digest === adapter.digest && registryEntry.version === adapter.declaration.version;
}
/** The largest JSON answer the client half will buffer for a response
 * rewrite: past this the body passes through untouched (8 MB). */
export const MAX_ADAPTER_RESPONSE_BUFFER_BYTES = 8 * 1024 * 1024;
/** Response headers an ADAPTER answer may carry through VERBATIM, beyond
 * the three every bridged forward passes (content-type, content-length,
 * cache-control): the better-sidebar HTML preview ships a `content-
 * security-policy` sandbox and downloads carry `content-disposition` —
 * stripping those breaks the very panels the adapter exists to serve.
 * Cooperative declaration routes keep the three-header behavior. */
export const ADAPTER_RESPONSE_HEADER_ALLOWLIST = [
    'content-security-policy',
    'content-disposition',
    'etag',
    'last-modified',
    'accept-ranges',
    'content-range',
];
//# sourceMappingURL=plugin-adapter-core.js.map