/**
 * The dsh-better-sidebar adapter (PB-12), written against EXACTLY
 * versions 0.25.0, 0.26.0, 0.26.1, 0.28.0-alpha.0 and 0.28.0 (PB-15 widened the list; 0.26.1 is a
 * perf-only patch with the same wire surface as 0.26.0; 0.26.0 is a JSON-api
 * superset of 0.25.0 — it grows fs.readPage and the sidechat dequeue/model/
 * models methods, and moves fs.write's content onto the new raw-text
 * /sidebar/write route). Everything the adapter knows about the plugin came
 * off `/tmp/bs-versions/{0.25.0,0.26.0}/lib/index.js`; the method table
 * lives in `methods.ts` beside this file, and the test suite re-extracts
 * the plugin's real method-name set (the two-version UNION) to catch a
 * silently drifted version.
 *
 * Product decisions (2026-10-10): reads AND writes both forward — a
 * bridged better-sidebar is whole-server disk access, git writes, and
 * model spend (commit-message generation), documented as such; NO path
 * fencing; `open.external` refuses for a remote session; `settings.*` and
 * `/sidebar/bundle` stay local; the adapter registers as whole-machine
 * data (consent per plugin, default off). PB-15: the 0.26.0 WebSocket
 * `/sidebar/ws/sidechat` is deliberately NOT declared (not bridged).
 *
 * The `cwd` handling is the one subtle part: better-sidebar resolves a
 * request's working directory as the session's own `header.cwd` first and
 * only falls back to a `cwd` field the CLIENT supplied (0.25.0
 * lib/index.js:6295, 6075-6099; 0.26.0 resolves /sidebar/write's cwd the
 * same way, lib/index.js:7902). A remote panel must not steer the server
 * by path, so the server hook strips `cwd` — from the JSON body
 * (`/sidebar/api`) and from the query (`/sidebar/file`, `/sidebar/upload`,
 * `/sidebar/write`) — and lets the backend resolve from the (validated,
 * real) session id.
 */

import type { BridgeAdapter } from '../types.js'
import { isVirtual } from '../../virtual-id.js'
import { SIDEBAR_METHODS, sidebarMethodNameOf } from './methods.js'

/** The relay's upload budget (`MAX_UPLOAD_BYTES` in lib/relay-server.js).
 * Inlined rather than imported — an adapter may only lean on pure utility
 * modules — and pinned to the original by a test in
 * test/adapter-better-sidebar.test.cjs, which fails the pair apart when
 * either side moves. */
const RELAY_UPLOAD_CAP_BYTES = 100 * 1024 * 1024

/** better-sidebar's own JSON body bound (lib/index.js:863
 * `MAX_BODY_BYTES = 1 << 20`) — the adapter forwards at most what the
 * backend would accept anyway. */
const SIDEBAR_MAX_BODY_BYTES = 1024 * 1024

/** The method name out of a `/sidebar/api/*` pathname, or `''`. */
const apiMethodOf = (pathname: string): string => sidebarMethodNameOf(pathname) ?? ''

export const dshBetterSidebarAdapter: BridgeAdapter = {
  plugin: 'dsh-better-sidebar',
  // 0.26.1 (perf patch): JSON-api method set, routes and WebSocket paths
  // identical to 0.26.0's wire surface (verified against the npm build;
  // lib/index.js itself differs — a perf refactor, not byte-identical).
  // 0.28.0-alpha.0 (DSH 0.2.1-alpha.5+): same routes and WebSockets; the
  // JSON api grows `git.graph` (session-scoped read, no ids in the answer);
  // `changes.ops` gains a `wait: true` long-poll (parks up to 25 s), which
  // the server hook below strips — see there. Routes now admit through the
  // host's `ctx.connection.requestRejection` (Host fence + signed cookie),
  // which the loopback courier already satisfies (127.0.0.1 + cookie).
  // 0.28.0 (stable, DSH 0.2.1-rc.1+): lib/index.js byte-identical to
  // 0.28.0-alpha.0; the client bundles differ only in CSS-module map order
  // and the service version string. alpha.0 stays for DSH 0.2.1-alpha.5.
  versions: ['0.25.0', '0.26.0', '0.26.1', '0.28.0-alpha.0', '0.28.0'],
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
        const name = apiMethodOf(pathname)
        if (name === '') return undefined
        // Opening apps/URLs on the HOST is a remote-panel no: refused when
        // the browser is currently looking at a REMOTE session (the
        // request body carries no session field of its own — client.js
        // 9383-9392 — so the classify step could never tell). A LOCAL
        // session's open.external never reaches here as a refusal and
        // stays on the local machine, exactly as without zen-remote.
        // (The sidechat methods left this hook in PB-13: their child
        // sessions inherit the parent's share through `meta.parentSession`,
        // so they forward like everything else.)
        if (name === 'open.external' && currentSessionId !== undefined && isVirtual(currentSessionId)) {
          return 'remote-open-unsupported'
        }
        return undefined
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
    // The raw text write (0.26.0, lib/index.js:7875-7919): the document IS
    // the POST body (text/plain — no JSON escaping layer), the session id,
    // path and a client cwd ride the QUERY. The plugin caps the body at
    // WRITE_BODY_GUARD_BYTES = 8 MiB (lib/index.js:6854); the adapter takes
    // 10 MiB — headroom over the plugin's own guard, under the relay's
    // 100 MiB upload budget.
    { path: '/sidebar/write', match: 'exact', methods: ['POST'], maxBody: 10 * 1024 * 1024, locator: { in: 'query', name: 'sessionId' } },
    // The HTML preview (lib/index.js:7026+): the session id is the FIRST
    // path segment after the prefix; the rest of the segments are the
    // preview file's relative path. Same-prefix relative resources ride
    // along (they hit the same prefix route with the same segment layout).
    { path: '/sidebar/html', match: 'prefix', methods: ['GET'], locator: { in: 'path-segment', index: 0 } },
    // Lazy chunks: client code, session-independent, LOCAL forever.
    { path: '/sidebar/bundle', match: 'prefix', methods: ['GET'], locator: { in: 'query', name: 'sessionId' }, local: true },
    // The two WebSockets (PB-13, both `registerUpgrade` EXACT registrations
    // in lib/index.js:7066-7091): the agent-opens push feed and the
    // file-tree watch. Both carry the session id in the query; both ride
    // PB-10's byte tunnel untouched — neither side parses frames, and the
    // messages need no rewriting (agent-opens pushes carry the server-real
    // sessionId but the browser never reads it — client.js:23618-23640
    // uses its own connect-time id for the scope; fs-watch frames carry
    // file paths, not session ids).
    { path: '/sidebar/ws/agent-opens', match: 'exact', methods: ['GET'], upgrade: true, locator: { in: 'query', name: 'sessionId' } },
    { path: '/sidebar/ws/fs-watch', match: 'exact', methods: ['GET'], upgrade: true, locator: { in: 'query', name: 'sessionId' } },
  ],
  client: {
    request: (ctx) => {
      const name = apiMethodOf(ctx.pathname)
      // Belt over the deny hook's suspenders: a refused method refuses
      // even if a future plugin version starts carrying session fields
      // on it (which would flip it into the remote branch).
      if (name === 'open.external') return { allow: false, reason: 'remote-open-unsupported' }
      // Unknown method: refuse — never guess what a drifted version means.
      if (name !== '' && SIDEBAR_METHODS[name] === undefined) return { allow: false, reason: 'adapter-method-unknown' }
      return { allow: true }
    },
    response: (ctx) => {
      const name = apiMethodOf(ctx.pathname)
      if (name === '') return ctx.body
      const spec = SIDEBAR_METHODS[name]
      if (spec === undefined || spec.rewrite === undefined) return ctx.body
      return spec.rewrite(ctx.body, ctx)
    },
  },
  server: {
    request: (ctx) => {
      // Strip the client-supplied cwd: the backend resolves the working
      // directory from the (already validated) session id's own header,
      // falling back to the persisted record — a remote panel never
      // steers the server by path.
      if (ctx.pathname === '/sidebar/file' || ctx.pathname === '/sidebar/upload' || ctx.pathname === '/sidebar/write') {
        if (ctx.query.get('cwd') !== null) {
          const stripped = new URLSearchParams(ctx.query)
          stripped.delete('cwd')
          return { allow: true, query: stripped }
        }
        return { allow: true }
      }
      if (ctx.route.path === '/sidebar/api' && ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body)) {
        const record = ctx.body as Record<string, unknown>
        // 0.28.0-alpha.0: a primed `changes.ops` asks with `wait: true` and the
        // backend parks it up to 25 s — longer than the relay's 15 s header
        // wait, so every bridged long-poll would die as request-timeout. The
        // client polls on a fixed 2.5 s interval with an in-flight guard
        // either way, so dropping `wait` degrades a remote session to the
        // 0.26 cadence (same precedent as the unbridged ws/sidechat push).
        const stripWait = apiMethodOf(ctx.pathname) === 'changes.ops' && 'wait' in record
        if ('cwd' in record || stripWait) {
          const stripped = { ...record }
          delete stripped.cwd
          if (stripWait) delete stripped.wait
          return { allow: true, body: stripped }
        }
      }
      return { allow: true }
    },
  },
}
