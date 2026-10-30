/**
 * The plugin bridge's route interception (PB-4): the sub-client's local
 * DSH process owns a webServer whose `match(pathname)` every request goes
 * through (RT dsh-host-webserver lib/index.js:350-364 — `handle` computes
 * the RAW, undecoded pathname and calls `this.match`). Overriding that one
 * method intercepts every route lookup — including routes registered AFTER
 * us, because the host re-reads the instance method per request. A request
 * aimed at a BRIDGED plugin's declared route, carrying a VIRTUAL session id,
 * cannot be served locally (the session lives on the server): the surrogate
 * handler forwards it through `relay.pluginRequest` (PB-3's
 * `relay/v1/plugin`) with the real id restored, and streams the answer
 * back (PB-21: where the id lives is the route's own declaration — the 2.1
 * query parameter, or a declaration-v2 locator in a prefix route's path
 * segment or the JSON body; the v2 shapes ride the SAME adapter-core
 * locate → classify → rewrite functions the adapters run, and a
 * `prefix: true` route forwards its full matched, rewritten path).
 * Everything else — undeclared routes, local sessions — flows to the
 * original route untouched.
 *
 * PB-22 gives the two remaining declaration-v2 flags their client meaning:
 * a `deny: true` route answers the uniform 503 with reason `route-denied`
 * whenever a REMOTE context touches it — the request locating a virtual id,
 * or the browser's CURRENT session being one (T62's signal) — while a local
 * session passes through exactly as before; a `rewriteIds: true` route's
 * JSON answer is buffered (the 8 MB adapter cap) and deep-scanned, every
 * string EXACTLY equal to one of the request's own real session ids
 * rewritten to its virtual form (`zr~` carries the real id inside, so the
 * request's own hits ARE the read-only mapping — no table is consulted or
 * written), unknown strings passing through untouched.
 *
 * PB-25a adds the position form: `rewriteIds: { fields }` declares the dot
 * paths where the response's NEWLY-CREATED session ids sit (a creation
 * route's `childId` was never in the request, so no value scan can catch
 * it). On top of the value scan, each declared path's non-empty, non-virtual
 * string gains the virtual shell of THIS request's server id; missing paths
 * are no-ops and nothing is ever guessed beyond the declared positions.
 *
 * PB-25b widens the value scan's lookup from the request-local mapping to
 * the request-local mapping UNION the KNOWN-real-session inventory: the
 * merged global streams report every real id the sub-client currently holds
 * (the sidebar's `zr~` rows — subagents.live's object keys, workflows.list
 * rows: ids in the browser's view but not in THIS request), and a string
 * exactly equal to one of those is rewritten too, in the same request-sourced
 * virtual shell. The inventory is READ-ONLY consumption — the scan never
 * touches merge state — and it is read live per answer: a stream refresh
 * replaces its share, and the next answer sees the fresh union (ids that
 * appear between two refreshes wait for the next refresh — the documented
 * ceiling). Without the option the scan is exactly the PB-22 behavior.
 *
 * The un-bridged refusals answer a UNIFORM 503 shape (header
 * `x-zen-remote: unbridged`, JSON body naming the reason) — and, decisive
 * for the security posture, they answer WITHOUT the local plugin handler
 * ever running: a remote session must never execute a plugin route against
 * local state, not even when the bridge is down (docs/adr/0001).
 *
 * The wrap is gated on a structural shape check like the typert and
 * fetch-route ones; uninstall restores `match` only while the instance
 * still holds OUR wrapper — a later wrapper chained over us keeps working,
 * and ours goes inert instead (the same posture as intercept.ts and
 * fetch-route-intercept.ts).
 */
import type { BridgeRegistry, BridgeStatus } from './plugin-bridge.js';
import type { RelayClient } from './relay-client.js';
import type { NormalizedAdapter } from './plugin-adapter-core.js';
/** Structural verdict of {@link checkWebServerShape}: the facts the wrap
 * reads per request — the `match` function the host's handle calls, the two
 * route tables, and (PB-10) the `upgrades` table the host's upgrade handler
 * reads `this.upgrades.get(pathname)` from (both Maps, RT
 * lib/index.js:467-478 and 298-308; the probe verified them on real
 * 0.2.0-rc.2 / 0.2.1-alpha.2 instances). */
export type WebServerShapeCheck = {
    ok: true;
} | {
    ok: false;
    reasons: string[];
};
/** Pure inspection of the RAW webServer instance — nothing is mutated, so a
 * failed check leaves every route exactly as it was. */
export declare function checkWebServerShape(webServer: unknown): WebServerShapeCheck;
/** One failure of the bridge answered to a browser, in the diagnostics
 * ring. The query NEVER travels — only the plugin name and the reason. */
export interface PluginRouteFailureRecord {
    time: string;
    plugin: string;
    reason: string;
}
/** What the client status route surfaces about this interception. */
export interface PluginRouteInterceptDiagnostics {
    installed: boolean;
    shape: WebServerShapeCheck;
    /** Requests forwarded through the relay (virtual ids on declared routes,
     * everything green). */
    forwarded: number;
    /** Requests answered with the uniform unbridged 503. */
    refused: number;
    /** The refusals keyed by reason. */
    refusalsByReason: Record<string, number>;
    /** The most recent refusals, oldest first, capped — time, plugin, reason
     * only, never a query, never a session id. */
    recentFailures: PluginRouteFailureRecord[];
    /** PB-10: tunnels live RIGHT NOW. */
    tunnelsCurrent: number;
    /** PB-10: tunnels opened / torn down since the install. */
    tunnelsOpened: number;
    tunnelsClosed: number;
    /** PB-11: adapter requests forwarded through the relay. */
    adapterForwarded: number;
    /** PB-11: adapter JSON answers rewritten by a `client.response` hook, and
     * answers that passed through UNTOUCHED because the buffer cap (8 MB) or
     * a parse failure made a rewrite impossible. */
    adapterResponseRewrites: number;
    adapterResponsePassthroughs: number;
}
export interface InstallPluginRouteInterceptOptions {
    /** The RAW webServer instance (`ctx.webServer[symbols.original]`). */
    webServer: object;
    /** The local declaration registry (the `zenRemote` service's table). */
    registry: BridgeRegistry;
    /** The client relay client; `pluginRequest` is the forwarding door. */
    relay: RelayClient;
    /** The CURRENT handshake's server id, read live per call; a virtual id
     * minted for another server (or before any handshake) refuses
     * `server-changed`. */
    getServerId: () => string | undefined;
    /** The PB-2 bridge verdicts, computed live per call; a plugin that is
     * not bridged right now refuses with the status's own reason. */
    getStatus: () => BridgeStatus[];
    /** The validated adapters (PB-11), as the wiring registered them.
     * Absent/empty — the pluggable default — means no adapter routes exist
     * and this interception behaves exactly as before. */
    adapters?: readonly NormalizedAdapter[];
    /** The session id the browser is CURRENTLY looking at (T62's report,
     * read live per call). A VIRTUAL id means a remote session's panel is
     * the request's origin — the signal an adapter route's `deny` hook uses
     * to refuse requests (like better-sidebar's `open.external`) that carry
     * no session field of their own, and (PB-22) the same-origin wall a
     * cooperative route's `deny: true` raises. Absent → deny judges
     * conservatively (only the request's own ids speak). */
    getCurrentSession?: () => string | undefined;
    /** PB-25b: the KNOWN real session ids of this sub-client — the merged
     * global streams' session inventories, unioned by the wiring. Read LIVE
     * per rewriteIds answer, not captured at install: the streams report after
     * the intercept installs, and a stream refresh replaces its share
     * replace-style, so a getter is the only form that sees the fresh union —
     * the same live-read discipline as getServerId/getStatus/getCurrentSession
     * above. A rewriteIds route's value scan rewrites a string exactly equal
     * to a member even when THIS request never carried it (the id already sits
     * in the browser's view — subagents.live's object keys, workflows.list
     * rows), wrapped in THIS request's virtual shell. The set is READ-ONLY
     * consumption: nothing here mutates merge state. Absent → the scan is
     * exactly the request-local PB-22 behavior. */
    getKnownRealIds?: () => ReadonlySet<string>;
    /** PB-26a: called with the virtual session ids a response rewrite
     * PRODUCED — a `rewriteIds.fields` route's wrapped positions, or the ids
     * an adapter's `client.response` hook passed through `virtualize` (e.g.
     * better-sidebar's `sidechat.start` childId) — so the session-summary
     * sync can announce subagent/sidechat rows that never appear in
     * workspace/follow. At most once per answer, deduped, only when there is
     * something to report; a throwing callback never fails the answer. */
    onMintedVirtualIds?: (virtualIds: readonly string[]) => void;
    /** Progress logging, wired to the context logger by index.ts. */
    log?: (format: string, ...args: unknown[]) => void;
}
export interface PluginRouteInterceptHandle {
    /** Restore `match` — ONLY while the instance still holds our wrapper
     * (chained-over wraps go inert instead). Idempotent. */
    uninstall(): void;
    diagnostics(): PluginRouteInterceptDiagnostics;
}
export declare function installPluginRouteIntercept(options: InstallPluginRouteInterceptOptions): PluginRouteInterceptHandle;
//# sourceMappingURL=plugin-route-intercept.d.ts.map