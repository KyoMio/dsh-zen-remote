/**
 * The dsh-better-sidebar adapter (PB-12), written against EXACTLY
 * version 0.25.0. Everything it knows about the plugin came off
 * `/tmp/bs-versions/0.25.0/lib/index.js` (the installed copy at
 * `~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar` is the same
 * build); the method table lives in `methods.ts` beside this file, and the
 * test suite re-extracts the plugin's real method-name set to catch a
 * silently drifted version.
 *
 * Product decisions (2026-10-10): reads AND writes both forward — a
 * bridged better-sidebar is whole-server disk access, git writes, and
 * model spend (commit-message generation), documented as such; NO path
 * fencing; `open.external` refuses for a remote session; `settings.*` and
 * `/sidebar/bundle` stay local; the adapter registers as whole-machine
 * data (consent per plugin, default off).
 *
 * The `cwd` handling is the one subtle part: better-sidebar resolves a
 * request's working directory as the session's own `header.cwd` first and
 * only falls back to a `cwd` field the CLIENT supplied (lib/index.js:6295,
 * 6075-6099). A remote panel must not steer the server by path, so the
 * server hook strips `cwd` — from the JSON body (`/sidebar/api`) and from
 * the query (`/sidebar/file`, `/sidebar/upload`) — and lets the backend
 * resolve from the (validated, real) session id.
 */
import { isVirtual } from '../../virtual-id.js';
import { SIDEBAR_METHODS, sidebarMethodNameOf } from './methods.js';
/** The relay's upload budget (`MAX_UPLOAD_BYTES` in lib/relay-server.js).
 * Inlined rather than imported — an adapter may only lean on pure utility
 * modules — and pinned to the original by a test in
 * test/adapter-better-sidebar.test.cjs, which fails the pair apart when
 * either side moves. */
const RELAY_UPLOAD_CAP_BYTES = 100 * 1024 * 1024;
/** better-sidebar's own JSON body bound (lib/index.js:863
 * `MAX_BODY_BYTES = 1 << 20`) — the adapter forwards at most what the
 * backend would accept anyway. */
const SIDEBAR_MAX_BODY_BYTES = 1024 * 1024;
/** The method name out of a `/sidebar/api/*` pathname, or `''`. */
const apiMethodOf = (pathname) => sidebarMethodNameOf(pathname) ?? '';
export const dshBetterSidebarAdapter = {
    plugin: 'dsh-better-sidebar',
    versions: ['0.25.0'],
    routes: [
        {
            // The JSON API: the method name rides the path tail, the session
            // fields ride the body top level (sessionId / rootSessionId /
            // childId — the sidechat calls).
            path: '/sidebar/api',
            match: 'prefix',
            methods: ['POST'],
            maxBody: SIDEBAR_MAX_BODY_BYTES,
            locator: { in: 'json-body', fields: ['sessionId', 'rootSessionId', 'childId'] },
            deny: ({ pathname, currentSessionId }) => {
                const name = apiMethodOf(pathname);
                if (name === '')
                    return undefined;
                // Side chat: refused WHOLESALE for now (remote or local — the
                // feature is not ready to cross the bridge); PB-13 decides.
                if (name.startsWith('sidechat.'))
                    return 'adapter-sidechat-pending';
                // Opening apps/URLs on the HOST is a remote-panel no: refused when
                // the browser is currently looking at a REMOTE session (the
                // request body carries no session field of its own — client.js
                // 9383-9392 — so the classify step could never tell). A LOCAL
                // session's open.external never reaches here as a refusal and
                // stays on the local machine, exactly as without zen-remote.
                if (name === 'open.external' && currentSessionId !== undefined && isVirtual(currentSessionId)) {
                    return 'remote-open-unsupported';
                }
                return undefined;
            },
        },
        // The media route: better-sidebar registers a PREFIX, the adapter only
        // claims the EXACT documented path — a sub-path (if a future version
        // grows one) stays local rather than being guessed at.
        { path: '/sidebar/file', match: 'exact', methods: ['GET'], locator: { in: 'query', name: 'sessionId' } },
        // The archive download (lib/index.js:6949-6985).
        { path: '/sidebar/archive', match: 'exact', methods: ['GET'], locator: { in: 'query', name: 'sessionId' } },
        // The raw upload (lib/index.js:6905-6948): binary bytes, capped by the
        // relay's own upload budget.
        { path: '/sidebar/upload', match: 'exact', methods: ['POST'], maxBody: RELAY_UPLOAD_CAP_BYTES, locator: { in: 'query', name: 'sessionId' } },
        // The HTML preview (lib/index.js:7026+): the session id is the FIRST
        // path segment after the prefix; the rest of the segments are the
        // preview file's relative path. Same-prefix relative resources ride
        // along (they hit the same prefix route with the same segment layout).
        { path: '/sidebar/html', match: 'prefix', methods: ['GET'], locator: { in: 'path-segment', index: 0 } },
        // Lazy chunks: client code, session-independent, LOCAL forever.
        { path: '/sidebar/bundle', match: 'prefix', methods: ['GET'], locator: { in: 'query', name: 'sessionId' }, local: true },
    ],
    client: {
        request: (ctx) => {
            const name = apiMethodOf(ctx.pathname);
            // Belt over the deny hook's suspenders: a refused method refuses
            // even if a future plugin version starts carrying session fields
            // on it (which would flip it into the remote branch).
            if (name === 'open.external')
                return { allow: false, reason: 'remote-open-unsupported' };
            if (name.startsWith('sidechat.'))
                return { allow: false, reason: 'adapter-sidechat-pending' };
            // Unknown method: refuse — never guess what a drifted version means.
            if (name !== '' && SIDEBAR_METHODS[name] === undefined)
                return { allow: false, reason: 'adapter-method-unknown' };
            return { allow: true };
        },
        response: (ctx) => {
            const name = apiMethodOf(ctx.pathname);
            if (name === '')
                return ctx.body;
            const spec = SIDEBAR_METHODS[name];
            if (spec === undefined || spec.rewrite === undefined)
                return ctx.body;
            return spec.rewrite(ctx.body, ctx);
        },
    },
    server: {
        request: (ctx) => {
            // Strip the client-supplied cwd: the backend resolves the working
            // directory from the (already validated) session id's own header,
            // falling back to the persisted record — a remote panel never
            // steers the server by path.
            if (ctx.pathname === '/sidebar/file' || ctx.pathname === '/sidebar/upload') {
                if (ctx.query.get('cwd') !== null) {
                    const stripped = new URLSearchParams(ctx.query);
                    stripped.delete('cwd');
                    return { allow: true, query: stripped };
                }
                return { allow: true };
            }
            if (ctx.route.path === '/sidebar/api' && ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body) && 'cwd' in ctx.body) {
                const stripped = { ...ctx.body };
                delete stripped.cwd;
                return { allow: true, body: stripped };
            }
            return { allow: true };
        },
    },
};
//# sourceMappingURL=index.js.map