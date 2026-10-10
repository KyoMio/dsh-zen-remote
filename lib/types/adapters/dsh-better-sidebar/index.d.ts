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
import type { BridgeAdapter } from '../types.js';
export declare const dshBetterSidebarAdapter: BridgeAdapter;
//# sourceMappingURL=index.d.ts.map