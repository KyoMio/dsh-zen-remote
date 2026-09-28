/**
 * Server-side relay routes for the desktop client (T22a, first half of the
 * 2.0.0 remote-session work): authentication, ping, handshake, and the single
 * invoke passthrough. Streaming subscriptions, event forwarding and activity
 * stats are T22b.
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
 * throws errors carrying a string `code`). Declared structurally instead of
 * augmenting `Context`: the providing package is not a devDependency here,
 * and a local augmentation could collide with its own once that changes. */
export interface RelayGateway {
    invoke(call: {
        namespace: string;
        method: string;
        args: unknown;
        signal?: AbortSignal;
    }): Promise<unknown>;
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
    /** The host gateway service invokes go through. */
    gateway: RelayGateway;
    /** Handshake facts. */
    serverInfo: RelayServerInfo;
    /** Ancestor lookup for subagent reachability; defaults to "no parent". */
    parentOf?: (id: string) => string | undefined;
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
 * After the gate, `x-zen-remote-device` is the caller's device id (T22b
 * activity stats hang off it).
 *
 * @param options - secret, share store, gateway service and server facts.
 * @returns a handler owning the full response lifecycle of one request.
 */
export declare function createRelayHandler(options: RelayHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
//# sourceMappingURL=relay-server.d.ts.map