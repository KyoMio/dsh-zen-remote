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
 * back. Everything else — undeclared routes, local sessions — flows to the
 * original route untouched.
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