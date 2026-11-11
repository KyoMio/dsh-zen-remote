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
import { createRelayClient } from './relay-client.js';
import { clearPairedServers, listPairedServers, MAX_PAIRED_SERVERS, migrateLegacyClientIntoServers, recordServerHandshake, removePairedServer, upsertPairedServer, } from './state-store.js';
/**
 * The display name of every entry: a trimmed non-empty `serverName` is the
 * base, otherwise the server URL. Bases appearing once keep their name; bases
 * appearing twice or more are numbered `-1`, `-2`, `-3`… in `entries` order
 * (pairing order). Pure — recomputed whenever the pool is asked for entries,
 * so a rename that removes a collision removes the suffixes too.
 */
export function deriveDisplayServerNames(entries) {
    const baseOf = (entry) => typeof entry.serverName === 'string' && entry.serverName.trim() !== '' ? entry.serverName.trim() : entry.serverUrl;
    const counts = new Map();
    for (const entry of entries) {
        const base = baseOf(entry);
        counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    const seen = new Map();
    const out = new Map();
    for (const entry of entries) {
        const base = baseOf(entry);
        if ((counts.get(base) ?? 0) >= 2) {
            const n = (seen.get(base) ?? 0) + 1;
            seen.set(base, n);
            out.set(entry.entryId, `${base}-${n}`);
        }
        else {
            out.set(entry.entryId, base);
        }
    }
    return out;
}
/**
 * Build the pool: one legacy migration pass, then one client per persisted
 * record, each with a fire-and-forget startup connect — a failed first dial
 * is the backoff ladder's business, exactly like the single-client wiring
 * before it.
 */
export function createRelayPool(options) {
    const stateFile = options.stateFile;
    const createClientImpl = options.createClient ?? createRelayClient;
    /** Insertion order = pairing order = `listPairedServers` order. */
    const pool = new Map();
    /** The handshake id a view should report: live handshake first, then the
     * persisted record (a fresh entry that never reached the server yet).
     * Virtual peer entries always report their mounted nodeId/name rather than
     * the remote DSH host's own serverId. */
    const effectiveServerId = (entry) => entry.virtual ? (entry.record.serverId ?? entry.record.id) : (entry.client.handshakeInfo?.serverId ?? entry.record.serverId);
    const effectiveServerName = (entry) => entry.virtual ? entry.record.serverName : (entry.client.handshakeInfo?.serverName ?? entry.record.serverName);
    const buildView = (entry, displayName) => ({
        entryId: entry.record.id,
        serverUrl: entry.record.serverUrl,
        // Virtual entries (PG-8) report the MOUNTED serverId — the peer's
        // nodeId — and ignore the handshake's own serverId: the `zr~<serverId>~`
        // virtual session ids must carry the nodeId that names the peer on the
        // network, not the peer machine's independent relay identity.
        serverId: entry.virtual ? (entry.record.serverId ?? entry.record.id) : effectiveServerId(entry),
        serverName: entry.virtual ? entry.record.serverName : effectiveServerName(entry),
        displayName,
        client: entry.client,
        createdAt: entry.record.createdAt,
    });
    const entries = () => {
        const list = [...pool.values()];
        const names = deriveDisplayServerNames(list.map((entry) => ({ entryId: entry.record.id, serverName: effectiveServerName(entry) ?? '', serverUrl: entry.record.serverUrl })));
        return list.map((entry) => buildView(entry, names.get(entry.record.id) ?? entry.record.serverUrl));
    };
    /** The client's credential getters read the CURRENT record per request, so
     * a re-pair (an in-place record swap) reaches the next attempt directly. */
    const createClientFor = (record, fetchOverride) => {
        const liveRecord = () => pool.get(record.id)?.record ?? record;
        const clientOptions = {
            getServerUrl: () => liveRecord().serverUrl,
            getToken: () => liveRecord().token,
            computeOwnFingerprints: options.computeOwnFingerprints,
            ...(fetchOverride !== undefined
                ? { fetchImpl: fetchOverride }
                : options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
            ...(options.clock !== undefined ? { clock: options.clock } : {}),
        };
        return createClientImpl(clientOptions);
    };
    /** Fold one completed handshake into the record — on disk (whose dedupe
     * may retire stale same-server entries) and in memory — then stop and
     * announce the retired ones. A non-8-hex server id is not handshake
     * material; skip the whole bookkeeping for it. */
    const handleHandshake = (entry) => {
        const info = entry.client.handshakeInfo;
        if (info === undefined)
            return;
        // Virtual entries (PG-8): the handshake still happens over the mux (the
        // peer's relayHandler answers it) and refreshes the DISPLAY name only —
        // the serverId half stays the mounted peer nodeId, and nothing is
        // written to disk or deduped there.
        if (entry.virtual) {
            entry.record = {
                ...entry.record,
                ...(info.deviceName !== undefined && info.deviceName !== '' ? { deviceName: info.deviceName } : {}),
            };
            return;
        }
        const result = recordServerHandshake(stateFile, entry.record.id, {
            serverId: info.serverId,
            serverName: info.serverName,
            ...(info.deviceName !== undefined ? { deviceName: info.deviceName } : {}),
        });
        entry.record = {
            ...entry.record,
            serverId: info.serverId,
            ...(info.serverName !== '' ? { serverName: info.serverName } : {}),
            ...(info.deviceName !== undefined ? { deviceName: info.deviceName } : {}),
        };
        for (const removedId of result.removedEntryIds) {
            const stale = pool.get(removedId);
            if (stale !== undefined) {
                stale.unsubscribe();
                stale.client.stop();
                pool.delete(removedId);
            }
            options.onServerRemoved?.({ entryId: removedId, serverId: info.serverId, reason: 'dedupe' });
        }
    };
    const attach = (entry) => {
        entry.unsubscribe = entry.client.subscribe((state) => {
            if (state === 'online')
                handleHandshake(entry);
            options.onStateChange?.({
                entryId: entry.record.id,
                serverId: effectiveServerId(entry),
                state,
                ...(entry.client.lastError !== undefined ? { lastError: entry.client.lastError } : {}),
            });
        });
    };
    const addEntry = (record) => {
        const entry = { record, client: createClientFor(record), unsubscribe: () => { } };
        attach(entry);
        pool.set(record.id, entry);
        // Startup dials are fire-and-forget: the failure is the client's own
        // backoff ladder's business, never the wiring's (same as index.ts).
        void entry.client.connect().catch(() => { });
    };
    // Startup: fold the legacy row credentials in (only when the list is still
    // empty), then one client per record — skipped in peer mode so non-network
    // paired records stay dormant until switching back to client mode.
    if (options.skipPersistedServers !== true) {
        const legacy = options.legacySource?.();
        if (legacy !== undefined) {
            try {
                migrateLegacyClientIntoServers(stateFile, legacy);
            }
            catch {
                // Best effort — the row keeps its credentials for the next start.
            }
        }
        for (const record of listPairedServers(stateFile))
            addEntry(record);
    }
    const detach = (entry) => {
        entry.unsubscribe();
        entry.client.stop();
        pool.delete(entry.record.id);
    };
    // PG-2: the effective cap, computed per call from the live getters. The
    // gateway cap only speaks in peer mode (a joined network); a sanitizing
    // clamp keeps a hostile `maxPeersFromGateway` inside the config's own
    // 1..64 band before it can raise anything.
    const maxServers = () => {
        const configured = options.getMaxServers?.() ?? MAX_PAIRED_SERVERS;
        const gatewayCap = options.getPeerNetworkCap?.();
        if (typeof gatewayCap !== 'number' || !Number.isInteger(gatewayCap) || gatewayCap < 1)
            return configured;
        const cap = Math.min(64, gatewayCap);
        const source = options.getMaxServersSource?.() ?? 'default';
        // Source 'default' (or its absence): the network's word wins outright.
        if (source === 'default')
            return cap;
        return Math.min(configured, cap);
    };
    return {
        entries,
        maxServers,
        getByEntryId(entryId) {
            return entries().find((view) => view.entryId === entryId);
        },
        getByServerId(serverId) {
            return entries().find((view) => view.serverId === serverId);
        },
        async pair(input) {
            // The cap pair() enforces is the pool's own live answer, so a config
            // change (or a freshly joined network) reaches the very next pairing.
            const result = upsertPairedServer(stateFile, { ...input, maxServers: maxServers() });
            if (!result.ok)
                return result;
            const existing = pool.get(result.record.id);
            if (existing !== undefined) {
                existing.record = result.record;
                // The getters read the swapped record per request; this both cancels
                // a pending retry wait and dials the new credentials immediately.
                existing.client.credentialsChanged();
            }
            else {
                addEntry(result.record);
            }
            // The entry is in the pool by now by construction; entries() also gives
            // it the dedupe-numbered display name the other views would show.
            const view = entries().find((candidate) => candidate.entryId === result.record.id);
            return { ok: true, entry: view, replaced: result.replaced };
        },
        unpair(entryId) {
            const entry = pool.get(entryId);
            if (entry?.virtual === true)
                return this.unmountVirtual(entryId);
            const removed = removePairedServer(stateFile, entryId);
            if (entry !== undefined)
                detach(entry);
            if (removed) {
                options.onServerRemoved?.({
                    entryId,
                    serverId: entry !== undefined ? effectiveServerId(entry) : undefined,
                    reason: 'unpair',
                });
            }
            return removed;
        },
        /** PG-8: one memory-only mount per joined peer; its entryId IS the peer
         * nodeId, its `serverId` the same, its client rides the mux's fetch. */
        mountVirtual(input) {
            const existing = pool.get(input.entryId);
            if (existing !== undefined) {
                return entries().find((view) => view.entryId === input.entryId);
            }
            const record = {
                id: input.entryId,
                // A placeholder origin — the mux's fetch never opens a socket for it.
                serverUrl: `http://zr-peer-${input.serverId}.virtual`,
                token: 'peer-virtual',
                serverId: input.serverId,
                serverName: input.serverName,
                createdAt: Date.now(),
            };
            const entry = {
                record,
                client: createClientFor(record, input.fetchImpl),
                unsubscribe: () => { },
                virtual: true,
            };
            attach(entry);
            pool.set(record.id, entry);
            // The virtual client dials through the mux: a session that is not
            // established YET fails the handshake exactly like a dead network —
            // the client's own ladder retries until the mux path exists.
            void entry.client.connect().catch(() => { });
            const view = entries().find((candidate) => candidate.entryId === record.id);
            return view;
        },
        unmountVirtual(entryId) {
            const entry = pool.get(entryId);
            if (entry === undefined || entry.virtual !== true)
                return false;
            detach(entry);
            options.onServerRemoved?.({ entryId, serverId: entry.record.serverId, reason: 'virtual' });
            return true;
        },
        updateVirtualName(entryId, serverName) {
            const entry = pool.get(entryId);
            const trimmed = typeof serverName === 'string' ? serverName.trim() : '';
            if (entry === undefined || entry.virtual !== true || trimmed === '')
                return false;
            if (entry.record.serverName === trimmed)
                return false;
            entry.record = { ...entry.record, serverName: trimmed };
            options.onStateChange?.({
                entryId: entry.record.id,
                serverId: effectiveServerId(entry),
                state: entry.client.state,
                ...(entry.client.lastError !== undefined ? { lastError: entry.client.lastError } : {}),
            });
            return true;
        },
        isVirtual(entryId) {
            return pool.get(entryId)?.virtual === true;
        },
        unpairAll() {
            const records = listPairedServers(stateFile);
            const count = clearPairedServers(stateFile);
            const onDisk = new Set(records.map((record) => record.id));
            for (const record of records) {
                const entry = pool.get(record.id);
                if (entry !== undefined)
                    detach(entry);
                options.onServerRemoved?.({
                    entryId: record.id,
                    serverId: entry !== undefined ? effectiveServerId(entry) : record.serverId,
                    reason: 'unpair',
                });
            }
            // Memory-only stragglers (a record removed underneath us mid-flight):
            // stop them too — unpairAll means ALL — without a second announcement
            // for the ones the disk pass already reported.
            for (const entry of [...pool.values()]) {
                detach(entry);
                if (!onDisk.has(entry.record.id)) {
                    options.onServerRemoved?.({ entryId: entry.record.id, serverId: effectiveServerId(entry), reason: 'unpair' });
                }
            }
            return count;
        },
        async reconnect(entryId) {
            if (entryId !== undefined) {
                const entry = pool.get(entryId);
                return entry !== undefined ? entry.client.reconnect() : false;
            }
            let any = false;
            for (const entry of pool.values()) {
                if (entry.client.state === 'offline')
                    any = entry.client.reconnect() || any;
            }
            return any;
        },
        async probeAndRestoreAll() {
            let reachable = false;
            let reconnected = false;
            for (const entry of pool.values()) {
                if (entry.client.state !== 'offline')
                    continue;
                if (!(await entry.client.probeHealth()))
                    continue;
                reachable = true;
                reconnected = entry.client.networkRestored() || reconnected;
            }
            return { reachable, reconnected };
        },
        queueDeviceNameAll(name) {
            for (const entry of pool.values())
                entry.client.queueDeviceName(name);
        },
        stop() {
            for (const entry of [...pool.values()]) {
                entry.unsubscribe();
                entry.client.stop();
            }
            pool.clear();
        },
    };
}
/** Re-exported so the pool's consumers never import state-store for the cap. */
export { MAX_PAIRED_SERVERS };
//# sourceMappingURL=relay-pool.js.map