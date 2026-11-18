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
export declare const DEFAULT_MAX_TOTAL_BYTES: number;
export declare const DEFAULT_MAX_BYTES_PER_SERVER: number;
export declare const DEFAULT_MAX_SNAPSHOT_BYTES: number;
export declare const DEFAULT_MAX_PAGE_BYTES: number;
export declare const DEFAULT_MAX_SINGLE_PAGE_BYTES: number;
export declare const DEFAULT_MAX_PAGES = 128;
export declare const DEFAULT_MAX_SESSIONS_PER_SERVER = 32;
export declare const DEFAULT_MAX_RECORDS_PER_SESSION = 600;
export declare const DEFAULT_OFFLINE_TTL_MS: number;
export declare const DEFAULT_HANDOFF_TTL_MS = 2000;
export type CacheTier = 'visited' | 'prewarmed';
export interface CacheClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
export type SessionAddressInput = string | {
    kind: 'session';
    sessionId: string;
} | {
    kind: 'subagent';
    parentSessionId: string;
    childSessionId: string;
    mode?: string;
};
export interface NormalizedSessionAddress {
    addressKey: string;
    sessionId: string;
    parentSessionId?: string;
    kind: 'session' | 'subagent';
    mode?: string;
}
export interface CachedSnapshotFrame {
    type: 'snapshot';
    header?: unknown;
    cursor: number;
    records: unknown[];
    hasMore: boolean;
    projections?: unknown;
    assistantStream?: {
        revision: number;
    };
    [key: string]: unknown;
}
export interface CachedSnapshotEntry {
    serverId: string;
    addressKey: string;
    sessionId: string;
    parentSessionId?: string;
    tier: CacheTier;
    cursor: number;
    stale: boolean;
    truncatedUnsafe: boolean;
    byteLength: number;
    snapshot: CachedSnapshotFrame;
}
export interface PageCacheKeyParams {
    beforeSeq?: number;
    maxMessages?: number;
    minMessages?: number;
    minTurns?: number;
}
export interface SnapshotDeltaInput {
    baseCursor: number;
    cursor: number;
    records: unknown[];
    hasMore?: boolean;
    projections?: unknown;
    assistantStream?: unknown;
}
export interface ClosableIterator {
    return?: () => unknown;
}
export interface HandoffPayload {
    snapshot: unknown;
    upstreamIterator?: ClosableIterator;
    iterator?: ClosableIterator;
    upstream?: ClosableIterator;
    cleanup?: () => unknown;
    [key: string]: unknown;
}
export interface SessionHistoryCacheStats {
    totalBytes: number;
    snapshotBytes: number;
    pageBytes: number;
    snapshotCount: number;
    pageCount: number;
    handoffCount: number;
    serverCount: number;
    prewarmedCount: number;
    visitedCount: number;
}
export interface SessionHistoryCacheOptions {
    maxTotalBytes?: number;
    maxBytesPerServer?: number;
    maxSnapshotBytes?: number;
    maxPageBytes?: number;
    maxSinglePageBytes?: number;
    maxPages?: number;
    maxSessionsPerServer?: number;
    maxRecordsPerSession?: number;
    offlineTtlMs?: number;
    handoffTtlMs?: number;
    clock?: CacheClock;
}
export interface SessionHistoryCache {
    putSnapshot(serverId: string, address: SessionAddressInput, rawSnapshot: unknown, tier: CacheTier): boolean;
    getSnapshot(serverId: string, address: SessionAddressInput, options?: {
        promoteToVisited?: boolean;
    }): CachedSnapshotEntry | undefined;
    peekSnapshotMeta(serverId: string, address: SessionAddressInput): {
        cursor: number;
        stale: boolean;
        tier: CacheTier;
    } | undefined;
    appendRecord(serverId: string, address: SessionAddressInput, event: unknown): boolean;
    applyDelta(serverId: string, address: SessionAddressInput, delta: SnapshotDeltaInput): CachedSnapshotFrame | undefined;
    updateProjections(serverId: string, address: SessionAddressInput, projections: unknown): boolean;
    markStale(serverId: string, address: SessionAddressInput): void;
    getPage(serverId: string, address: SessionAddressInput, params: PageCacheKeyParams): unknown | undefined;
    putPage(serverId: string, address: SessionAddressInput, params: PageCacheKeyParams, value: unknown): boolean;
    markServerOffline(serverId: string): void;
    markServerOnline(serverId: string): void;
    deleteSessionFamily(serverId: string, rootOrChildId: string, childrenOf?: (id: string) => Iterable<string> | undefined): void;
    deleteServer(serverId: string): void;
    clearAll(): void;
    parkHandoff(serverId: string, address: SessionAddressInput, payload: HandoffPayload): void;
    takeHandoff(serverId: string, address: SessionAddressInput): HandoffPayload | undefined;
    stats(): SessionHistoryCacheStats;
}
/**
 * Normalize a string sessionId or DSH address object (`session` / `subagent`)
 * into a collision-free key while preserving `sessionId` and `parentSessionId`.
 */
export declare function normalizeSessionAddress(input: unknown): NormalizedSessionAddress | undefined;
/**
 * Approximate in-memory weight of an arbitrary JSON-like JS value without
 * paying `JSON.stringify` CPU cost. Protects against cycles and extreme depth.
 */
export declare function estimateValueBytes(value: unknown, maxDepth?: number): number;
export declare function createSessionHistoryCache(options?: SessionHistoryCacheOptions): SessionHistoryCache;
//# sourceMappingURL=session-history-cache.d.ts.map