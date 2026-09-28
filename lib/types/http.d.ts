/**
 * Shared HTTP plumbing for the host-side route modules: the one JSON response
 * envelope and the one same-origin gate every state-changing browser route
 * applies. Both lived in the main entry until the admin routes (T14) needed
 * the exact same pair; importing the entry from a route module would be an
 * import cycle, so the definitions live here and the entry re-exports the
 * same-origin gate its public surface has carried since S7.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** The one JSON response envelope every host route speaks: no-store (admin
 * surfaces and pairing codes must never sit in a shared cache), nosniff, and
 * a default-src 'none' CSP since no route serves executable content. */
export declare function responseJson(res: ServerResponse, status: number, body: unknown): void;
/**
 * Accept a state-changing request only from this DSH Web application's origin.
 *
 * The gateway half rewrites `Origin`/`Host` to the upstream origin
 * before forwarding (lan-gate-server.cjs `cleanHeaders`), so a phone request
 * that already cleared the pairing wall presents here as same-origin; a
 * request with neither header falls back to the Fetch metadata.
 * @param req - the inbound request.
 * @returns true when the request may mutate the workspace.
 */
export declare function sameOriginPost(req: IncomingMessage): boolean;
//# sourceMappingURL=http.d.ts.map