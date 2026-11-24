/**
 * Shared upstream browser-auth token URL resolver for `lan-gate.mjs` and the
 * plugin-bridge loopback executor.
 *
 * DSH <= 0.2.2-rc.1 exposes `connection.authenticatedUrl(baseUrl)`.
 * DSH >= 0.2.2-rc.2 removed that method; `host-authentication-token` instead
 * publishes signed entry URLs synchronously via `'webserver/entry-url'`.
 */
function readConnection(ctx) {
    if (!ctx)
        return undefined;
    let conn;
    try {
        if (typeof ctx.get === 'function')
            conn = ctx.get('connection');
    }
    catch {
        conn = undefined;
    }
    if (conn === undefined) {
        try {
            if (typeof ctx.reflect?.get === 'function')
                conn = ctx.reflect.get('connection');
        }
        catch {
            conn = undefined;
        }
    }
    if (conn === undefined) {
        try {
            conn = ctx.connection;
        }
        catch {
            conn = undefined;
        }
    }
    return conn !== null && typeof conn === 'object' ? conn : undefined;
}
/**
 * Resolve an authenticated upstream entry URL for `baseUrl` on both legacy
 * (`connection.authenticatedUrl`) and `0.2.2-rc.2+` (`webserver/entry-url`) hosts.
 * @param ctx - plugin or inject context carrying `connection` / `emit`.
 * @param webServer - active `webServer` instance passed as `thisArg` to `webserver/entry-url`.
 * @param baseUrl - clean origin or base URL without credentials.
 * @returns validated entry URL with a single non-empty `token`, or `undefined`.
 */
export function resolveUpstreamTokenUrl(ctx, webServer, baseUrl) {
    const connection = readConnection(ctx);
    if (typeof connection?.authenticatedUrl === 'function') {
        const legacyUrl = connection.authenticatedUrl(baseUrl);
        return typeof legacyUrl === 'string' && legacyUrl !== '' ? legacyUrl : undefined;
    }
    let emitFn;
    try {
        emitFn = ctx?.emit;
    }
    catch {
        emitFn = undefined;
    }
    if (typeof emitFn !== 'function' || webServer === undefined)
        return undefined;
    let root;
    try {
        root = new URL(baseUrl);
    }
    catch {
        return undefined;
    }
    const entries = [];
    emitFn.call(ctx, webServer, 'webserver/entry-url', baseUrl, entries);
    for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || typeof entry.url !== 'string')
            continue;
        try {
            const parsed = new URL(entry.url);
            if (parsed.origin !== root.origin || parsed.pathname !== root.pathname)
                continue;
            const tokens = parsed.searchParams.getAll('token');
            if (tokens.length !== 1 || !tokens[0])
                continue;
            return entry.url;
        }
        catch {
            continue;
        }
    }
    return undefined;
}
//# sourceMappingURL=upstream-token.js.map