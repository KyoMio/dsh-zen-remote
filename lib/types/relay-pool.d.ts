/**
 * The multi-server relay connection pool (MS-2): up to {@link MAX_PAIRED_SERVERS}
 * `RelayClient` instances, one per paired server in the state file, replacing
 * the single row-driven client the client role used to keep. The paired
 * list itself lives in `zen-remote-state.json` (src/state-store.ts — MS-1's
 * three-in-one file); this module owns the LIVE half: start, handshake
 * bookkeeping, re-pair, unpair, and the second dedupe layer's teardown.
 *
 * Two bookkeeping paths meet here. When one client's handshake lands, the
 * handshake facts (serverId/serverName/deviceName) are persisted onto its
 * state-file record — `recordServerHandshake` also REMOVES any other record
 * that carries the same serverId (the same server re-paired under a new
 * address), and this module stops that stale entry's client and announces it
 * with `reason: 'dedupe'`. Removals the USER makes go out with
 * `reason: 'unpair'`.
 *
 * Display names: several servers report the same `serverName` (the default is
 * just the hostname), so the merged sidebar would show N identical rows.
 * {@link deriveDisplayServerNames} numbers duplicates in pairing order
 * (`home-1`, `home-2`, …) and leaves unique names bare; a rename that removes
 * the collision removes the suffixes with it, because the derivation is
 * recomputed on every `entries()` read.
 *
 * The clients themselves are the plain T23a relay clients — their getters
 * read the pool's in-memory record per request, so a re-pair only updates
 * that record and calls `credentialsChanged()`. `createClient` is injectable:
 * the tests drive the whole lifecycle without a socket.
 */
import type { ConfigSource } from './config.js';
import { createRelayClient } from './relay-client.js';
import type { RelayClient, RelayClock, RelayState } from './relay-client.js';
import { MAX_PAIRED_SERVERS } from './state-store.js';
/** One entry's name inputs for {@link deriveDisplayServerNames}. */
export interface ServerNameEntry {
    entryId: string;
    serverName: string;
    serverUrl: string;
}
/**
 * The display name of every entry: a trimmed non-empty `serverName` is the
 * base, otherwise the server URL. Bases appearing once keep their name; bases
 * appearing twice or more are numbered `-1`, `-2`, `-3`… in `entries` order
 * (pairing order). Pure — recomputed whenever the pool is asked for entries,
 * so a rename that removes a collision removes the suffixes too.
 */
export declare function deriveDisplayServerNames(entries: readonly ServerNameEntry[]): Map<string, string>;
/** One live pool entry as the callers see it. */
export interface RelayPoolEntryView {
    /** The stable state-file record id. */
    entryId: string;
    /** The normalized server address. */
    serverUrl: string;
    /** The handshake's server id; the persisted record id until one lands. */
    serverId: string | undefined;
    /** The handshake's server name; the persisted name until one lands. */
    serverName: string | undefined;
    /** {@link deriveDisplayServerNames} over the current entries. */
    displayName: string;
    /** The live client. */
    client: RelayClient;
    /** When the pairing was first added (epoch ms). */
    createdAt: number;
}
/** Why an entry left the pool: the user removed it, a handshake proved it
 * a stale duplicate of another entry pointing at the same server — or it
 * was a peer-network virtual mount the engine unmounted (PG-8). */
export type RelayPoolRemovalReason = 'unpair' | 'dedupe' | 'virtual';
export interface RelayPoolOptions {
    /** The state file (`<DSH_HOME>/zen-remote-state.json`). */
    stateFile: string;
    /** The row's legacy single-server credentials, read once at startup: when
     * the paired list is still empty they become `servers[0]`. */
    legacySource?: () => {
        serverUrl?: string;
        deviceToken?: string;
    } | undefined;
    /** This side's own interface fingerprints (T42), handed to every client.
     * May be async (the real wiring computes against the typert registry,
     * which loads package by package); the clients await it per handshake. */
    computeOwnFingerprints: () => Record<string, string> | Promise<Record<string, string>>;
    /** Outbound fetch for the clients; defaults to the global one. */
    fetchImpl?: typeof fetch;
    /** Clock for the clients' reconnect machinery; defaults to the real one. */
    clock?: RelayClock;
    /** The client factory; injectable so tests run without sockets. */
    createClient?: typeof createRelayClient;
    /** Every client state change, with the entry it belongs to. */
    onStateChange?: (event: {
        entryId: string;
        serverId?: string;
        state: RelayState;
        lastError?: string;
    }) => void;
    /** Every entry removal, with why it left. */
    onServerRemoved?: (removed: {
        entryId: string;
        serverId?: string;
        reason: RelayPoolRemovalReason;
    }) => void;
    /** The locally configured cap (`resolveConfig`'s `maxServers`), live.
     * Missing answers {@link MAX_PAIRED_SERVERS}. */
    getMaxServers?: () => number;
    /** Which config layer supplied the current `maxServers` (live). Only
     * `'default'` lets the network's cap win OUTRIGHT; a user-chosen value is
     * only lowered by it, never raised. Missing behaves like `'default'`. */
    getMaxServersSource?: () => ConfigSource | undefined;
    /** The gateway's announced total member cap, INCLUDING this node (peer mode:
     * the state file's `peerNetwork.maxPeersFromGateway`), live. Missing or invalid
     * (<2) means "no network cap known" and local configuration answers alone. */
    getPeerNetworkCap?: () => number | undefined;
    /** Peer mode: do not load or migrate persisted `client`-mode paired servers
     * from `zen-remote-state.json` — only virtual network mounts belong in the
     * pool while running as `peer`, so old non-network records never occupy
     * display names (`-1`/`-2`) or leave stale sidebar workspaces. */
    skipPersistedServers?: boolean;
}
export interface RelayPool {
    /** Every entry in pairing order, with fresh display names. */
    entries(): RelayPoolEntryView[];
    /** The EFFECTIVE pairing cap right now (PG-2): the locally configured
     * `maxServers` (its getter is live), except in peer mode under a network-
     * reported `maxPeersFromGateway`, where a default-layer config takes the
     * gateway's remote capacity (total minus self) and a user-chosen one is only
     * lowered by it. */
    maxServers(): number;
    /** Locate one entry by its state-file record id. */
    getByEntryId(entryId: string): RelayPoolEntryView | undefined;
    /** Locate one entry by its (handshake or persisted) server id. */
    getByServerId(serverId: string): RelayPoolEntryView | undefined;
    /** Add or re-pair one server: the record lands on disk first, then the
     * live half follows (re-credentialed in place, or a fresh client). */
    pair(input: {
        serverUrl: string;
        token: string;
        deviceId?: string;
        deviceName?: string;
    }): Promise<{
        ok: true;
        entry: RelayPoolEntryView;
        replaced: boolean;
    } | {
        ok: false;
        code: 'invalid-url' | 'limit-reached';
    }>;
    /** Stop and remove one entry (disk record included). */
    unpair(entryId: string): boolean;
    /** Stop everything and empty the paired list; answers the record count. */
    unpairAll(): number;
    /** Mount one MEMORY-ONLY virtual entry (PG-8, PeerEngine): its client
     * reaches a joined peer through the mux's `fetchImpl` — the E2EE virtual
     * HTTP adapter — and its `serverId` is the peer's nodeId, which is what
     * the `zr~<serverId>~` virtual session ids carry. Never touches the state
     * file, never runs the handshake dedupe, never counts against `pair()`'s
     * disk cap. */
    mountVirtual(input: {
        entryId: string;
        serverId: string;
        serverName: string;
        fetchImpl: typeof fetch;
    }): RelayPoolEntryView;
    /** Unmount one virtual entry (peer left / mismatch / disabled). */
    unmountVirtual(entryId: string): boolean;
    /** Update one mounted virtual entry's serverName (peer rename) and notify
     * pool listeners so merged workspace titles refresh immediately. */
    updateVirtualName(entryId: string, serverName: string): boolean;
    /** Whether an entry id is currently a mounted virtual entry. */
    isVirtual(entryId: string): boolean;
    /** One entry's immediate reconnect, or every `offline` client's. Answers
     * whether any attempt was started. */
    reconnect(entryId?: string): Promise<boolean>;
    /** One authenticated ping per `offline` client; the reachable ones get
     * `networkRestored()` (the controlled fast-path back online). */
    probeAndRestoreAll(): Promise<{
        reachable: boolean;
        reconnected: boolean;
    }>;
    /** Forward a device rename to every paired server (T59). */
    queueDeviceNameAll(name: string): void;
    /** Stop every client and detach the listeners (row teardown). */
    stop(): void;
}
/**
 * Build the pool: one legacy migration pass, then one client per persisted
 * record, each with a fire-and-forget startup connect — a failed first dial
 * is the backoff ladder's business, exactly like the single-client wiring
 * before it.
 */
export declare function createRelayPool(options: RelayPoolOptions): RelayPool;
/** Re-exported so the pool's consumers never import state-store for the cap. */
export { MAX_PAIRED_SERVERS };
//# sourceMappingURL=relay-pool.d.ts.map