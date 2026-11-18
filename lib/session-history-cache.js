/**
 * Pure in-memory cache for remote session snapshots and immutable `session/page`
 * windows (T2: `session-history-store`).
 *
 * Zero disk I/O and zero dependency on DSH internals:
 * - Four-tier quotas: global total bytes (`64 MiB`, snapshots + pages),
 *   per-server snapshot bytes (`24 MiB`), per-session snapshot admission cap
 *   (`8 MiB`, oversized snapshots bypass without evicting warm entries),
 *   per-server session count (`32`), and an independent `session/page`
 *   sub-budget (`16 MiB` / `128` pages, `4 MiB` single-page cap).
 * - Dual-tier LRU: `prewarmed` snapshots are always evicted before `visited`
 *   snapshots; a `visited` session refreshed by prewarm never downgrades.
 * - Contiguous live-stream appending with turn- and `sourceEventSeqs`-safe
 *   prefix trimming at `maxRecordsPerSession` (`600`).
 * - Injectable clock for offline server TTL (`30 min`) and one-shot handoff
 *   slots (`2,000 ms`) that auto-close unconsumed upstream iterators.
 */
export const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_BYTES_PER_SERVER = 24 * 1024 * 1024;
export const DEFAULT_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_PAGE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_SINGLE_PAGE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_PAGES = 128;
export const DEFAULT_MAX_SESSIONS_PER_SERVER = 32;
export const DEFAULT_MAX_RECORDS_PER_SESSION = 600;
export const DEFAULT_OFFLINE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_HANDOFF_TTL_MS = 2_000;
const defaultClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        if (typeof timer.unref === 'function')
            timer.unref();
        return timer;
    },
    clearTimeout: (handle) => {
        clearTimeout(handle);
    },
};
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Normalize a string sessionId or DSH address object (`session` / `subagent`)
 * into a collision-free key while preserving `sessionId` and `parentSessionId`.
 */
export function normalizeSessionAddress(input) {
    if (typeof input === 'string') {
        if (input === '')
            return undefined;
        return {
            kind: 'session',
            sessionId: input,
            addressKey: `session:${input}`,
        };
    }
    if (!isRecord(input))
        return undefined;
    if (input.kind === 'session') {
        if (typeof input.sessionId !== 'string' || input.sessionId === '')
            return undefined;
        return {
            kind: 'session',
            sessionId: input.sessionId,
            addressKey: `session:${input.sessionId}`,
        };
    }
    if (input.kind === 'subagent') {
        if (typeof input.parentSessionId !== 'string' ||
            input.parentSessionId === '' ||
            typeof input.childSessionId !== 'string' ||
            input.childSessionId === '') {
            return undefined;
        }
        const mode = typeof input.mode === 'string' && input.mode !== '' ? input.mode : undefined;
        return {
            kind: 'subagent',
            sessionId: input.childSessionId,
            parentSessionId: input.parentSessionId,
            ...(mode !== undefined ? { mode } : {}),
            addressKey: `subagent:${JSON.stringify([input.parentSessionId, input.childSessionId, mode ?? ''])}`,
        };
    }
    return undefined;
}
/**
 * Approximate in-memory weight of an arbitrary JSON-like JS value without
 * paying `JSON.stringify` CPU cost. Protects against cycles and extreme depth.
 */
export function estimateValueBytes(value, maxDepth = 32) {
    const seen = new WeakSet();
    const walk = (node, depth) => {
        if (node === null || node === undefined)
            return 8;
        const t = typeof node;
        if (t === 'string')
            return node.length * 2 + 24;
        if (t === 'number' || t === 'boolean' || t === 'symbol' || t === 'function')
            return 8;
        if (t === 'bigint')
            return 16;
        if (typeof node !== 'object')
            return 8;
        const obj = node;
        if (obj instanceof ArrayBuffer)
            return obj.byteLength + 32;
        if (ArrayBuffer.isView(obj))
            return obj.byteLength + 32;
        if (depth >= maxDepth)
            return 64;
        if (seen.has(obj))
            return 8;
        seen.add(obj);
        if (Array.isArray(obj)) {
            let total = 32 + obj.length * 8;
            for (let i = 0; i < obj.length; i += 1) {
                total += walk(obj[i], depth + 1);
            }
            return total;
        }
        let total = 48;
        const entries = Object.entries(obj);
        for (let i = 0; i < entries.length; i += 1) {
            const [key, val] = entries[i];
            total += key.length * 2 + 24 + walk(val, depth + 1);
        }
        return total;
    };
    return walk(value, 0);
}
function compositeKey(serverId, addressKey) {
    return JSON.stringify([serverId, addressKey]);
}
function pageCompositeKey(serverId, addressKey, params) {
    return JSON.stringify([
        serverId,
        addressKey,
        params.beforeSeq ?? null,
        params.maxMessages ?? null,
        params.minMessages ?? null,
        params.minTurns ?? null,
    ]);
}
function isValidSnapshotShape(raw) {
    return (raw.type === 'snapshot' &&
        typeof raw.cursor === 'number' &&
        Number.isSafeInteger(raw.cursor) &&
        raw.cursor >= -1 &&
        Array.isArray(raw.records));
}
function sanitizeSnapshotFrame(raw) {
    const records = raw.records.slice();
    const cursor = raw.cursor;
    const hasMore = Boolean(raw.hasMore);
    const out = {
        ...raw,
        type: 'snapshot',
        cursor,
        records,
        hasMore,
    };
    if ('assistantStream' in raw && raw.assistantStream !== undefined) {
        out.assistantStream = { revision: 0 };
    }
    return out;
}
function snapshotOverheadBytes(frame) {
    const { records: _records, ...rest } = frame;
    return estimateValueBytes(rest);
}
function unwrapRecordEvent(record) {
    if (!isRecord(record))
        return undefined;
    if (record.type === 'event' && isRecord(record.event))
        return record.event;
    return record;
}
function normalizeWireRecord(record) {
    if (!isRecord(record))
        return undefined;
    if (record.type === 'event' && isRecord(record.event)) {
        return { wire: record, event: record.event };
    }
    return { wire: { type: 'event', event: record }, event: record };
}
function isTurnStartRecord(record) {
    const ev = unwrapRecordEvent(record);
    return ev !== undefined && ev.type === 'turn/start';
}
function seqOfRecord(record) {
    const ev = unwrapRecordEvent(record);
    if (ev === undefined)
        return undefined;
    return typeof ev.seq === 'number' && Number.isSafeInteger(ev.seq) ? ev.seq : undefined;
}
function sourceSeqBoundsOf(record) {
    let maxOwn = -Infinity;
    let minDep = Infinity;
    const ev = unwrapRecordEvent(record);
    if (ev === undefined)
        return { maxOwn, minDep };
    if (typeof ev.seq === 'number' && Number.isFinite(ev.seq)) {
        maxOwn = Math.max(maxOwn, ev.seq);
    }
    if (Array.isArray(ev.sourceEventSeqs)) {
        for (const item of ev.sourceEventSeqs) {
            if (typeof item === 'number' && Number.isFinite(item)) {
                maxOwn = Math.max(maxOwn, item);
                minDep = Math.min(minDep, item);
            }
        }
    }
    return { maxOwn, minDep };
}
function unrefTimer(handle) {
    if (handle !== null && typeof handle === 'object' && typeof handle.unref === 'function') {
        ;
        handle.unref();
    }
}
function runHandoffCleanup(payload) {
    if (typeof payload.cleanup === 'function') {
        try {
            void Promise.resolve(payload.cleanup()).catch(() => { });
        }
        catch {
            // Best-effort cleanup.
        }
    }
    const iter = payload.upstreamIterator ?? payload.iterator ?? payload.upstream;
    if (iter !== undefined && typeof iter.return === 'function') {
        try {
            void Promise.resolve(iter.return()).catch(() => { });
        }
        catch {
            // Best-effort iterator return.
        }
    }
}
export function createSessionHistoryCache(options = {}) {
    const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const maxBytesPerServer = options.maxBytesPerServer ?? DEFAULT_MAX_BYTES_PER_SERVER;
    const maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
    const maxPageBytes = options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES;
    const maxSinglePageBytes = options.maxSinglePageBytes ?? DEFAULT_MAX_SINGLE_PAGE_BYTES;
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const maxSessionsPerServer = options.maxSessionsPerServer ?? DEFAULT_MAX_SESSIONS_PER_SERVER;
    const maxRecordsPerSession = options.maxRecordsPerSession ?? DEFAULT_MAX_RECORDS_PER_SESSION;
    const offlineTtlMs = options.offlineTtlMs ?? DEFAULT_OFFLINE_TTL_MS;
    const handoffTtlMs = options.handoffTtlMs ?? DEFAULT_HANDOFF_TTL_MS;
    const clock = options.clock ?? defaultClock;
    // Insertion order encodes exact LRU recency (delete + set moves to MRU tail).
    const snapshots = new Map();
    const serverSnapshotMaps = new Map();
    const serverBytes = new Map();
    const pages = new Map();
    const handoffs = new Map();
    const offlineTimers = new Map();
    let snapshotBytesTotal = 0;
    let pageBytesTotal = 0;
    let prewarmedCount = 0;
    let visitedCount = 0;
    function touchSnapshotLru(entry) {
        snapshots.delete(entry.key);
        snapshots.set(entry.key, entry);
        const srvMap = serverSnapshotMaps.get(entry.serverId);
        if (srvMap !== undefined) {
            srvMap.delete(entry.key);
            srvMap.set(entry.key, entry);
        }
    }
    function touchPageLru(entry) {
        pages.delete(entry.key);
        pages.set(entry.key, entry);
    }
    function removeSnapshot(entry) {
        if (!snapshots.delete(entry.key))
            return;
        snapshotBytesTotal -= entry.byteLength;
        if (entry.tier === 'prewarmed')
            prewarmedCount -= 1;
        else
            visitedCount -= 1;
        const srvMap = serverSnapshotMaps.get(entry.serverId);
        if (srvMap !== undefined) {
            srvMap.delete(entry.key);
            if (srvMap.size === 0)
                serverSnapshotMaps.delete(entry.serverId);
        }
        const nextSrvBytes = (serverBytes.get(entry.serverId) ?? 0) - entry.byteLength;
        if (nextSrvBytes <= 0)
            serverBytes.delete(entry.serverId);
        else
            serverBytes.set(entry.serverId, nextSrvBytes);
    }
    function removePage(entry) {
        if (!pages.delete(entry.key))
            return;
        pageBytesTotal -= entry.byteLength;
    }
    function findEvictableSnapshot(map, tier, protectedKey) {
        for (const entry of map.values()) {
            if (entry.key !== protectedKey && entry.tier === tier)
                return entry;
        }
        return undefined;
    }
    function findEvictablePage(protectedKey) {
        for (const entry of pages.values()) {
            if (entry.key !== protectedKey)
                return entry;
        }
        return undefined;
    }
    function evictOneFromServer(serverId, protectedKey) {
        const srvMap = serverSnapshotMaps.get(serverId);
        if (srvMap === undefined)
            return false;
        const victim = findEvictableSnapshot(srvMap, 'prewarmed', protectedKey) ??
            findEvictableSnapshot(srvMap, 'visited', protectedKey);
        if (victim === undefined)
            return false;
        removeSnapshot(victim);
        return true;
    }
    function enforceServerSnapshotQuotas(serverId, protectedKey) {
        while ((serverSnapshotMaps.get(serverId)?.size ?? 0) > maxSessionsPerServer) {
            if (!evictOneFromServer(serverId, protectedKey))
                break;
        }
        while ((serverBytes.get(serverId) ?? 0) > maxBytesPerServer) {
            if (!evictOneFromServer(serverId, protectedKey))
                break;
        }
    }
    function enforcePageSubBudget(protectedPageKey) {
        while (pages.size > maxPages || pageBytesTotal > maxPageBytes) {
            const victim = findEvictablePage(protectedPageKey);
            if (victim === undefined)
                break;
            removePage(victim);
        }
    }
    function enforceGlobalQuota(protectedSnapshotKey, protectedPageKey) {
        while (snapshotBytesTotal + pageBytesTotal > maxTotalBytes) {
            const prewarmVictim = findEvictableSnapshot(snapshots, 'prewarmed', protectedSnapshotKey);
            if (prewarmVictim !== undefined) {
                removeSnapshot(prewarmVictim);
                continue;
            }
            const pageVictim = findEvictablePage(protectedPageKey);
            if (pageVictim !== undefined) {
                removePage(pageVictim);
                continue;
            }
            const visitedVictim = findEvictableSnapshot(snapshots, 'visited', protectedSnapshotKey);
            if (visitedVictim !== undefined) {
                removeSnapshot(visitedVictim);
                continue;
            }
            break;
        }
    }
    function adjustSnapshotBytes(entry, deltaBytes) {
        if (deltaBytes === 0)
            return;
        entry.byteLength += deltaBytes;
        snapshotBytesTotal += deltaBytes;
        const nextSrvBytes = (serverBytes.get(entry.serverId) ?? 0) + deltaBytes;
        if (nextSrvBytes <= 0)
            serverBytes.delete(entry.serverId);
        else
            serverBytes.set(entry.serverId, nextSrvBytes);
    }
    /**
     * Trim prefix records when `records.length > maxRecordsPerSession` along the
     * earliest `turn/start` that does not sever `sourceEventSeqs` references of
     * retained records; falls back to the earliest `sourceEventSeqs`-safe cut if
     * the whole window belongs to a single turn, or `minDrop` as last resort.
     */
    function trimEntryRecords(entry) {
        const records = entry.snapshot.records;
        const len = records.length;
        if (len <= maxRecordsPerSession)
            return;
        const minDrop = len - maxRecordsPerSession;
        const prefixMaxSeq = new Array(len);
        let runningMax = -Infinity;
        for (let i = 0; i < len; i += 1) {
            const { maxOwn } = sourceSeqBoundsOf(records[i]);
            if (maxOwn > runningMax)
                runningMax = maxOwn;
            prefixMaxSeq[i] = runningMax;
        }
        const suffixMinDep = new Array(len);
        let runningMin = Infinity;
        for (let i = len - 1; i >= 0; i -= 1) {
            const { minDep } = sourceSeqBoundsOf(records[i]);
            if (minDep < runningMin)
                runningMin = minDep;
            suffixMinDep[i] = runningMin;
        }
        const isSafeCut = (cut) => suffixMinDep[cut] > prefixMaxSeq[cut - 1];
        let chosenCut = -1;
        for (let cut = minDrop; cut < len; cut += 1) {
            if (isTurnStartRecord(records[cut]) && isSafeCut(cut)) {
                chosenCut = cut;
                break;
            }
        }
        if (chosenCut === -1) {
            for (let cut = minDrop; cut < len; cut += 1) {
                if (isSafeCut(cut)) {
                    chosenCut = cut;
                    break;
                }
            }
        }
        if (chosenCut === -1) {
            chosenCut = minDrop;
            entry.truncatedUnsafe = true;
        }
        let removedBytes = 0;
        for (let i = 0; i < chosenCut; i += 1) {
            removedBytes += entry.recordSizes[i] ?? 0;
        }
        entry.snapshot.records = records.slice(chosenCut);
        entry.recordSizes = entry.recordSizes.slice(chosenCut);
        entry.snapshot.hasMore = true;
        adjustSnapshotBytes(entry, -removedBytes);
    }
    function snapshotView(entry) {
        return {
            serverId: entry.serverId,
            addressKey: entry.addressKey,
            sessionId: entry.sessionId,
            ...(entry.parentSessionId !== undefined ? { parentSessionId: entry.parentSessionId } : {}),
            tier: entry.tier,
            cursor: entry.cursor,
            stale: entry.stale,
            truncatedUnsafe: entry.truncatedUnsafe,
            byteLength: entry.byteLength,
            snapshot: {
                ...entry.snapshot,
                records: entry.snapshot.records.slice(),
            },
        };
    }
    function putSnapshot(serverId, address, rawSnapshot, tier) {
        if (typeof serverId !== 'string' || serverId === '' || !isRecord(rawSnapshot) || !isValidSnapshotShape(rawSnapshot)) {
            return false;
        }
        const norm = normalizeSessionAddress(address);
        if (norm === undefined)
            return false;
        const sanitized = sanitizeSnapshotFrame(rawSnapshot);
        const overheadBytes = snapshotOverheadBytes(sanitized);
        const recordSizes = new Array(sanitized.records.length);
        let recordsBytes = 0;
        for (let i = 0; i < sanitized.records.length; i += 1) {
            const sz = estimateValueBytes(sanitized.records[i]);
            recordSizes[i] = sz;
            recordsBytes += sz;
        }
        const byteLength = overheadBytes + recordsBytes;
        const key = compositeKey(serverId, norm.addressKey);
        const existing = snapshots.get(key);
        if (byteLength > maxSnapshotBytes || byteLength > maxBytesPerServer || byteLength > maxTotalBytes) {
            // Remove any stale prior snapshot for this same session, but never evict other sessions.
            if (existing !== undefined)
                removeSnapshot(existing);
            return false;
        }
        let effectiveTier = tier;
        if (existing !== undefined) {
            // Visited sessions refreshed by prewarm never downgrade.
            if (existing.tier === 'visited')
                effectiveTier = 'visited';
            removeSnapshot(existing);
        }
        const entry = {
            key,
            serverId,
            addressKey: norm.addressKey,
            sessionId: norm.sessionId,
            ...(norm.parentSessionId !== undefined ? { parentSessionId: norm.parentSessionId } : {}),
            tier: effectiveTier,
            cursor: sanitized.cursor,
            stale: false,
            truncatedUnsafe: false,
            overheadBytes,
            recordSizes,
            byteLength,
            snapshot: sanitized,
        };
        snapshots.set(key, entry);
        let srvMap = serverSnapshotMaps.get(serverId);
        if (srvMap === undefined) {
            srvMap = new Map();
            serverSnapshotMaps.set(serverId, srvMap);
        }
        srvMap.set(key, entry);
        serverBytes.set(serverId, (serverBytes.get(serverId) ?? 0) + byteLength);
        snapshotBytesTotal += byteLength;
        if (effectiveTier === 'prewarmed')
            prewarmedCount += 1;
        else
            visitedCount += 1;
        enforceServerSnapshotQuotas(serverId, key);
        enforceGlobalQuota(key, undefined);
        return true;
    }
    function getSnapshot(serverId, address, opts) {
        const norm = normalizeSessionAddress(address);
        if (norm === undefined)
            return undefined;
        const entry = snapshots.get(compositeKey(serverId, norm.addressKey));
        if (entry === undefined)
            return undefined;
        if (opts?.promoteToVisited === true && entry.tier === 'prewarmed') {
            entry.tier = 'visited';
            prewarmedCount -= 1;
            visitedCount += 1;
        }
        touchSnapshotLru(entry);
        return snapshotView(entry);
    }
    function peekSnapshotMeta(serverId, address) {
        const norm = normalizeSessionAddress(address);
        if (norm === undefined)
            return undefined;
        const entry = snapshots.get(compositeKey(serverId, norm.addressKey));
        if (entry === undefined)
            return undefined;
        return { cursor: entry.cursor, stale: entry.stale, tier: entry.tier };
    }
    function appendRecord(serverId, address, event) {
        const norm = normalizeSessionAddress(address);
        if (norm === undefined)
            return false;
        const entry = snapshots.get(compositeKey(serverId, norm.addressKey));
        if (entry === undefined || entry.stale)
            return false;
        const normalized = normalizeWireRecord(event);
        const seq = normalized !== undefined ? seqOfRecord(normalized.wire) : undefined;
        if (normalized === undefined || seq === undefined) {
            entry.stale = true;
            return false;
        }
        if (seq <= entry.cursor) {
            // Idempotent ignore of already-applied sequence numbers.
            return true;
        }
        if (seq > entry.cursor + 1) {
            entry.stale = true;
            return false;
        }
        const recSize = estimateValueBytes(normalized.wire);
        entry.snapshot.records.push(normalized.wire);
        entry.recordSizes.push(recSize);
        entry.cursor = seq;
        entry.snapshot.cursor = seq;
        adjustSnapshotBytes(entry, recSize);
        trimEntryRecords(entry);
        if (entry.byteLength > maxSnapshotBytes || entry.byteLength > maxBytesPerServer || entry.byteLength > maxTotalBytes) {
            removeSnapshot(entry);
            return false;
        }
        enforceServerSnapshotQuotas(serverId, entry.key);
        enforceGlobalQuota(entry.key, undefined);
        return true;
    }
    function applyDelta(serverId, address, delta) {
        const norm = normalizeSessionAddress(address);
        if (norm === undefined)
            return undefined;
        const entry = snapshots.get(compositeKey(serverId, norm.addressKey));
        if (entry === undefined || entry.stale)
            return undefined;
        if (delta.baseCursor > entry.cursor) {
            entry.stale = true;
            return undefined;
        }
        for (const rec of delta.records) {
            const normalized = normalizeWireRecord(rec);
            const seq = normalized !== undefined ? seqOfRecord(normalized.wire) : undefined;
            if (normalized === undefined || seq === undefined) {
                entry.stale = true;
                return undefined;
            }
            if (seq <= entry.cursor)
                continue;
            if (seq > entry.cursor + 1) {
                entry.stale = true;
                return undefined;
            }
            const recSize = estimateValueBytes(normalized.wire);
            entry.snapshot.records.push(normalized.wire);
            entry.recordSizes.push(recSize);
            entry.cursor = seq;
            entry.snapshot.cursor = seq;
            adjustSnapshotBytes(entry, recSize);
        }
        if (delta.cursor > entry.cursor) {
            entry.cursor = delta.cursor;
            entry.snapshot.cursor = delta.cursor;
        }
        const firstSeqAfter = entry.snapshot.records.length > 0 ? seqOfRecord(entry.snapshot.records[0]) : undefined;
        if (firstSeqAfter === 0)
            entry.snapshot.hasMore = false;
        else if (delta.hasMore === true)
            entry.snapshot.hasMore = true;
        else if (delta.hasMore === false && !entry.snapshot.hasMore)
            entry.snapshot.hasMore = false;
        if (delta.projections !== undefined) {
            entry.snapshot.projections = delta.projections;
        }
        if ('assistantStream' in delta && delta.assistantStream !== undefined) {
            entry.snapshot.assistantStream = { revision: 0 };
        }
        const nextOverhead = snapshotOverheadBytes(entry.snapshot);
        adjustSnapshotBytes(entry, nextOverhead - entry.overheadBytes);
        entry.overheadBytes = nextOverhead;
        trimEntryRecords(entry);
        if (entry.byteLength > maxSnapshotBytes || entry.byteLength > maxBytesPerServer || entry.byteLength > maxTotalBytes) {
            removeSnapshot(entry);
            return undefined;
        }
        touchSnapshotLru(entry);
        enforceServerSnapshotQuotas(serverId, entry.key);
        enforceGlobalQuota(entry.key, undefined);
        return snapshotView(entry).snapshot;
    }
    function updateProjections(serverId, address, projections) {
        const norm = normalizeSessionAddress(address);
        if (norm === undefined)
            return false;
        const entry = snapshots.get(compositeKey(serverId, norm.addressKey));
        if (entry === undefined)
            return false;
        entry.snapshot.projections = projections;
        const nextOverhead = snapshotOverheadBytes(entry.snapshot);
        adjustSnapshotBytes(entry, nextOverhead - entry.overheadBytes);
        entry.overheadBytes = nextOverhead;
        if (entry.byteLength > maxSnapshotBytes || entry.byteLength > maxBytesPerServer || entry.byteLength > maxTotalBytes) {
            removeSnapshot(entry);
            return false;
        }
        enforceServerSnapshotQuotas(serverId, entry.key);
        enforceGlobalQuota(entry.key, undefined);
        return true;
    }
    function markStale(serverId, address) {
        const norm = normalizeSessionAddress(address);
        if (norm === undefined)
            return;
        const entry = snapshots.get(compositeKey(serverId, norm.addressKey));
        if (entry !== undefined)
            entry.stale = true;
    }
    function getPage(serverId, address, params) {
        const norm = normalizeSessionAddress(address);
        if (norm === undefined)
            return undefined;
        const entry = pages.get(pageCompositeKey(serverId, norm.addressKey, params));
        if (entry === undefined)
            return undefined;
        touchPageLru(entry);
        return entry.value;
    }
    function putPage(serverId, address, params, value) {
        if (typeof serverId !== 'string' || serverId === '')
            return false;
        const norm = normalizeSessionAddress(address);
        if (norm === undefined)
            return false;
        const byteLength = estimateValueBytes(value);
        if (byteLength > maxSinglePageBytes || byteLength > maxPageBytes || byteLength > maxTotalBytes) {
            return false;
        }
        const key = pageCompositeKey(serverId, norm.addressKey, params);
        const existing = pages.get(key);
        if (existing !== undefined)
            removePage(existing);
        const entry = {
            key,
            serverId,
            addressKey: norm.addressKey,
            sessionId: norm.sessionId,
            ...(norm.parentSessionId !== undefined ? { parentSessionId: norm.parentSessionId } : {}),
            byteLength,
            value,
        };
        pages.set(key, entry);
        pageBytesTotal += byteLength;
        enforcePageSubBudget(key);
        enforceGlobalQuota(undefined, key);
        return true;
    }
    function clearOfflineTimer(serverId) {
        const existing = offlineTimers.get(serverId);
        if (existing !== undefined) {
            clock.clearTimeout(existing);
            offlineTimers.delete(serverId);
        }
    }
    function markServerOffline(serverId) {
        if (typeof serverId !== 'string' || serverId === '')
            return;
        clearOfflineTimer(serverId);
        const timer = clock.setTimeout(() => {
            offlineTimers.delete(serverId);
            deleteServer(serverId);
        }, offlineTtlMs);
        unrefTimer(timer);
        offlineTimers.set(serverId, timer);
    }
    function markServerOnline(serverId) {
        clearOfflineTimer(serverId);
    }
    function removeHandoffSlot(slot, cleanup) {
        if (!handoffs.delete(slot.key))
            return;
        clock.clearTimeout(slot.timer);
        if (cleanup)
            runHandoffCleanup(slot.payload);
    }
    function parkHandoff(serverId, address, payload) {
        const norm = normalizeSessionAddress(address);
        if (typeof serverId !== 'string' || serverId === '' || norm === undefined) {
            runHandoffCleanup(payload);
            return;
        }
        const key = compositeKey(serverId, norm.addressKey);
        const existing = handoffs.get(key);
        if (existing !== undefined)
            removeHandoffSlot(existing, true);
        let slot;
        const timer = clock.setTimeout(() => {
            if (handoffs.get(key) !== slot)
                return;
            removeHandoffSlot(slot, true);
        }, handoffTtlMs);
        unrefTimer(timer);
        slot = {
            key,
            serverId,
            addressKey: norm.addressKey,
            sessionId: norm.sessionId,
            ...(norm.parentSessionId !== undefined ? { parentSessionId: norm.parentSessionId } : {}),
            payload,
            timer,
        };
        handoffs.set(key, slot);
    }
    function takeHandoff(serverId, address) {
        const norm = normalizeSessionAddress(address);
        if (norm === undefined)
            return undefined;
        const key = compositeKey(serverId, norm.addressKey);
        const slot = handoffs.get(key);
        if (slot === undefined)
            return undefined;
        removeHandoffSlot(slot, false);
        return slot.payload;
    }
    function deleteSessionFamily(serverId, rootOrChildId, childrenOf) {
        if (typeof rootOrChildId !== 'string' || rootOrChildId === '')
            return;
        const familyIds = new Set([rootOrChildId]);
        if (childrenOf !== undefined) {
            const queue = [rootOrChildId];
            while (queue.length > 0) {
                const current = queue.shift();
                const children = childrenOf(current);
                if (children === undefined)
                    continue;
                for (const child of children) {
                    if (typeof child === 'string' && child !== '' && !familyIds.has(child)) {
                        familyIds.add(child);
                        queue.push(child);
                    }
                }
            }
        }
        const matchesFamily = (item) => item.serverId === serverId &&
            (familyIds.has(item.sessionId) || (item.parentSessionId !== undefined && familyIds.has(item.parentSessionId)));
        const srvMap = serverSnapshotMaps.get(serverId);
        if (srvMap !== undefined) {
            for (const entry of [...srvMap.values()]) {
                if (matchesFamily(entry))
                    removeSnapshot(entry);
            }
        }
        for (const page of [...pages.values()]) {
            if (matchesFamily(page))
                removePage(page);
        }
        for (const slot of [...handoffs.values()]) {
            if (matchesFamily(slot))
                removeHandoffSlot(slot, true);
        }
    }
    function deleteServer(serverId) {
        clearOfflineTimer(serverId);
        const srvMap = serverSnapshotMaps.get(serverId);
        if (srvMap !== undefined) {
            for (const entry of [...srvMap.values()]) {
                removeSnapshot(entry);
            }
        }
        for (const page of [...pages.values()]) {
            if (page.serverId === serverId)
                removePage(page);
        }
        for (const slot of [...handoffs.values()]) {
            if (slot.serverId === serverId)
                removeHandoffSlot(slot, true);
        }
    }
    function clearAll() {
        for (const serverId of [...offlineTimers.keys()]) {
            clearOfflineTimer(serverId);
        }
        for (const slot of [...handoffs.values()]) {
            removeHandoffSlot(slot, true);
        }
        snapshots.clear();
        serverSnapshotMaps.clear();
        serverBytes.clear();
        pages.clear();
        snapshotBytesTotal = 0;
        pageBytesTotal = 0;
        prewarmedCount = 0;
        visitedCount = 0;
    }
    function stats() {
        return {
            totalBytes: snapshotBytesTotal + pageBytesTotal,
            snapshotBytes: snapshotBytesTotal,
            pageBytes: pageBytesTotal,
            snapshotCount: snapshots.size,
            pageCount: pages.size,
            handoffCount: handoffs.size,
            serverCount: serverSnapshotMaps.size,
            prewarmedCount,
            visitedCount,
        };
    }
    return {
        putSnapshot,
        getSnapshot,
        peekSnapshotMeta,
        appendRecord,
        applyDelta,
        updateProjections,
        markStale,
        getPage,
        putPage,
        markServerOffline,
        markServerOnline,
        deleteSessionFamily,
        deleteServer,
        clearAll,
        parkHandoff,
        takeHandoff,
        stats,
    };
}
//# sourceMappingURL=session-history-cache.js.map