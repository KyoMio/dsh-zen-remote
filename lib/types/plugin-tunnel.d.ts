/**
 * The plugin bridge's WebSocket byte tunnel (PB-10), server half. Per
 * docs/adr/0002 the relay NEVER speaks WebSocket: a bridged upgrade route is
 * carried as ONE NDJSON streaming response (server → client bytes) plus
 * ordinary POSTs per chunk (client → server bytes), both ends treating the
 * payload as OPAQUE BYTES — the WebSocket handshake and every frame are
 * produced by the real plugin route on the server machine and arrive at the
 * browser untouched.
 *
 * Open: `POST relay/v1/plugin-tunnel/open` — the same coordinate headers and
 * the SAME validation chain as `v1/plugin` (shared {@link validatePluginCall};
 * the route must additionally be declared `upgrade: true`), plus a small
 * JSON body carrying exactly the four `sec-websocket-*` headers and the
 * optional early head bytes. On success the relay dials the local web server
 * itself (net/tls, loopback only), writes a hand-built upgrade request with
 * the operator's cookie, and pumps socket bytes downstream line by line.
 * Send/close: `POST relay/v1/plugin-tunnel/{send,close}` — ordered chunks
 * upstream (one in-flight per tunnel, sequence-gated) and idempotent
 * teardown.
 *
 * Every tunnel belongs to the device that opened it; another device's
 * send/close is 404. Budgets, heartbeats and the slow-reader discipline
 * mirror the routes this module sits beside.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BridgeRegistry, NormalizedBridgeRoute, NormalizedDeclaration } from './plugin-bridge.js';
import type { PluginLoopback } from './plugin-loopback.js';
/** The shared validation verdict for the two plugin routes (PB-3, reused by
 * the tunnel open in PB-10): the whole chain from the coordinate headers to
 * the consent wall, minus each route's own extras (the method check for
 * `v1/plugin`, the upgrade mark here). First failure wins, in this order.
 * `bufferedBody` carries a json-body route's request bytes (PB-24: the share
 * check must read the located id, so the body is consumed by validating) —
 * the loopback sends THIS buffer, never a re-read of the request. */
export type PluginCallValidation = {
    ok: true;
    declaration: NormalizedDeclaration;
    route: NormalizedBridgeRoute;
    params: URLSearchParams;
    sessionId: string;
    normalizedQuery: string;
    bufferedBody?: Buffer;
} | {
    ok: false;
    status: number;
    code: string;
};
/** The json-body locator's body reader (PB-24): the caller owns the request
 * stream — `v1/plugin` buffers it bounded by the route's `maxBody` (413 past
 * the cap, mirroring the adapter half's discipline), the tunnel open omits
 * the reader entirely (an open request is empty-bodied by contract, so a
 * body-locating upgrade route can never be validated and refuses). */
export type PluginCallBodyReader = (maxBody: number) => Promise<{
    kind: 'body';
    buffered: Buffer;
    parsed?: unknown;
} | {
    kind: 'over';
} | {
    kind: 'corrupt';
}>;
/** Validate one plugin-bridge call's coordinates — the parse-once query
 * discipline (the re-serialization of THIS parse is the only string the
 * tunnel's upgrade request may carry), the share table with its ancestor
 * walk, and the live consent wall. `bridge.getConsent()` throwing reads as
 * unknown consent, and unknown consent stays home. The share wall reads the
 * route's EFFECTIVE locator (PB-24): the query convention — `sessionParam`
 * folded in by {@link routeLocatorOf} — keeps its exactly-once rule, while a
 * declaration-v2 locator re-locates over the SAME adapter-core rule the
 * sub-client classified with and share-checks EVERY hit; a json-body route's
 * body is consumed by validating (the reader above), and the verdict carries
 * the bytes for the loopback. */
export declare function validatePluginCall(bridge: {
    registry: BridgeRegistry;
    getConsent: () => Record<string, boolean>;
}, coords: {
    pluginName: string;
    pluginVersion: string;
    pluginDigest: string;
    routePath: string;
    rawQuery: string;
}, isAccessible: (sessionId: string) => boolean, readJsonBody?: PluginCallBodyReader): Promise<PluginCallValidation>;
/** Largest single downstream data LINE (base64 will inflate by 4/3 — the cap
 * is on the RAW bytes carried, and the line stays well under typical proxy
 * line limits this way). */
export declare const TUNNEL_DOWN_CHUNK_BYTES: number;
/** Largest upstream send chunk (the wire body of one `send`). */
export declare const TUNNEL_UP_CHUNK_BYTES: number;
/** Concurrent tunnels per device. */
export declare const MAX_TUNNELS_PER_DEVICE = 8;
export interface CreatePluginTunnelOptions {
    bridge: {
        registry: BridgeRegistry;
        getConsent: () => Record<string, boolean>;
        loopback: PluginLoopback;
    };
    /** The loopback web server bind, re-read per tunnel (same live discipline
     * as every target read in this plugin). */
    getTarget: () => {
        protocol: 'http:' | 'https:';
        port: number;
    };
    isAccessible: (sessionId: string) => boolean;
    /** Heartbeat interval for the open stream (the ping lines). */
    heartbeatMs: number;
}
export interface PluginTunnelRoutes {
    /** `POST relay/v1/plugin-tunnel/open`. */
    open(req: IncomingMessage, res: ServerResponse): Promise<void>;
    /** `POST relay/v1/plugin-tunnel/send`. */
    send(req: IncomingMessage, res: ServerResponse): Promise<void>;
    /** `POST relay/v1/plugin-tunnel/close`. */
    close(req: IncomingMessage, res: ServerResponse): Promise<void>;
    /** Live tunnel count (the settings diagnostics). */
    tunnelCount(): number;
}
/** The tunnel table: id → the live entry. Every teardown path removes its
 * own entry exactly once. */
export declare function createPluginTunnel(options: CreatePluginTunnelOptions): PluginTunnelRoutes;
//# sourceMappingURL=plugin-tunnel.d.ts.map