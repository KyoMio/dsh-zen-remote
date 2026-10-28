/**
 * The dsh-better-sidebar adapter (PB-12), written against EXACTLY
 * versions 0.25.0, 0.26.0, 0.26.1, 0.28.0-alpha.0, 0.28.0, 0.28.1 and 0.28.2 (PB-15 widened the list; 0.26.1 is a
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
import type { BridgeAdapter } from '../types.js';
export declare const dshBetterSidebarAdapter: BridgeAdapter;
//# sourceMappingURL=index.d.ts.map