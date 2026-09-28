/**
 * Server-side relay routes for the desktop client (T22a routes, T22b
 * streaming): authentication, ping, handshake, the single invoke passthrough,
 * and the NDJSON stream subscription route with share-change synchronization.
 * Event forwarding (`$events`) and activity stats are later tasks.
 *
 * Why the secret: the desktop client is a Node process on another machine —
 * it has no DSH login cookie, so the gateway authenticates it with a Bearer
 * pairing token and marks the forwarded request with `x-zen-remote-*` headers.
 * But DSH only listens on 127.0.0.1, where any local process could bypass the
 * gateway and forge those headers. The plugin therefore mints a per-apply
 * secret, hands it to the gateway child through `LAN_GATE_RELAY_SECRET`, the
 * gateway stamps every device-authenticated forward with it, and these routes
 * re-verify it on every request with `timingSafeEqual`.
 *
 * Path dispatch never decodes the request path. The gateway only admits relay
 * paths whose raw and URL-normalized forms are byte-identical, which lets
 * `/_dsh/zen-remote/relay/..%2f..%2fapi` through — decoding it here before
 * matching would reopen the traversal the gateway just closed. Every route is
 * an exact comparison on `new URL(req.url).pathname` as-is; anything else is
 * a 404.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShareStore } from './share-store.js';
/**
 * Registration prefix on the host webServer. Deliberately WITHOUT the
 * trailing slash: the webserver matches a prefix route as `pathname === p ||
 * pathname.startsWith(p + '/')`, so a trailing slash here would match only
 * `…/relay//…` shapes and never `…/relay/ping`.
 */
export declare const RELAY_PREFIX = "/_dsh/zen-remote/relay";
/** Shape of the `typertGateway` service this route needs (measured live,
 * docs/spike-relay.md §2.1: invoke returns the unwrapped business value and
 * throws errors carrying a string `code`; stream opens one `mode: 'stream'`
 * method and resolves to an async iterable of its frames). Declared
 * structurally instead of augmenting `Context`: the providing package is not
 * a devDependency here, and a local augmentation could collide with its own
 * once that changes. */
export interface RelayGateway {
    invoke(call: {
        namespace: string;
        method: string;
        args: unknown;
        signal?: AbortSignal;
    }): Promise<unknown>;
    stream(call: {
        namespace: string;
        method: string;
        args: unknown;
        signal?: AbortSignal;
    }): Promise<AsyncIterable<unknown>>;
}
/** What the handshake reports about this server. `serverName` is a CALLBACK
 * on purpose: the row value is a volatile (`{ get() }` wrapped) setting that
 * can change without restarting the plugin row, so it must be recomputed at
 * handshake time, not snapshotted at registration. */
export interface RelayServerInfo {
    serverId: string;
    serverName: () => string;
    dshVersion: string;
}
export interface RelayHandlerOptions {
    /** The per-apply shared secret; an empty one refuses every request. */
    secret: string;
    /** The shared-session table deciding reachability. */
    store: ShareStore;
    /** The host gateway service invokes and streams go through. */
    gateway: RelayGateway;
    /** Handshake facts. */
    serverInfo: RelayServerInfo;
    /** Ancestor lookup for subagent reachability; defaults to "no parent". */
    parentOf?: (id: string) => string | undefined;
    /** Stream heartbeat interval in ms (a `{"type":"ping"}` line that keeps
     * reverse proxies from timing the idle stream away); defaults to 15000.
     * Tests inject a small value. */
    heartbeatMs?: number;
}
/**
 * The relay route handler plus its introspection surface. A function WITH
 * properties on purpose: the webServer registration wants exactly a request
 * handler, and the "who is looking" badge (a later UI task) wants the
 * per-session viewer counts — while the row-reload path (T22b-fix) needs to
 * tear every open stream down with the handler that owns it.
 */
export interface RelayHandler {
    (req: IncomingMessage, res: ServerResponse): Promise<void>;
    /** How many session-scoped relay streams currently reference the session
     * (across all devices). */
    viewerCount(sessionId: string): number;
    /** End every currently open stream: each client gets one
     * `error{code:'server-restart'}` line, then the response ends, the upstream
     * subscription aborts and every counter/listener cleans up. A plugin row
     * reload builds a new handler and share table; without this the streams of
     * the OLD handler would keep pushing, unreachable by any unshare. */
    closeAll(reason: string): void;
}
/**
 * Read the persisted server id, creating (and persisting) one on first use.
 * A missing file is the normal first run; an unreadable or damaged file must
 * never take the host down, so every failure degrades to a fresh per-process
 * id that simply is not remembered across restarts.
 */
export declare function loadServerId(home: string): string;
/**
 * The DSH version reported in the handshake: `DSH_CLIENT_VERSION` when the
 * host sets it, else the version of the `@deepseek-ai/dsh` package resolved
 * from here (compositions without that package installed — tests, Electron —
 * report `'unknown'`). Never throws.
 */
export declare function resolveDshVersion(): string;
/**
 * Build the relay route handler mounted under {@link RELAY_PREFIX}. Exported
 * as a factory so the route tests can drive it against a plain node:http
 * server with a fake gateway and a real share store — no harness required.
 *
 * Every request passes the same gate first: gateway secret, then the two
 * marking headers. Failures answer a uniform 401 that does not say WHICH
 * check failed — the difference would only help someone probing the wall.
 * After the gate, `x-zen-remote-device` is the caller's device id (the
 * per-device stream budget hangs off it).
 *
 * @param options - secret, share store, gateway service and server facts.
 * @returns the handler owning the full response lifecycle of one request,
 *   with `viewerCount` alongside for the "who is looking" surface.
 */
export declare function createRelayHandler(options: RelayHandlerOptions): RelayHandler;
//# sourceMappingURL=relay-server.d.ts.map