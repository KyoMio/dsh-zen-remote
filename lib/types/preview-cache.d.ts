/**
 * Pure in-memory LRU cache for conditional `v1/invoke` binary previews
 * (`workspaceFiles/readBytes`, `officeToPdf/render`, `officeKit/render`).
 *
 * Zero DSH imports, zero disk/network I/O. Stored and returned values are
 * cloned (including isolated `Uint8Array` copies) so caller mutations cannot
 * corrupt cached entries.
 */
export declare const IF_VERSION_HEADER = "x-zr-if-version";
export declare const DEFAULT_PREVIEW_CACHE_MAX_BYTES: number;
export declare const DEFAULT_PREVIEW_CACHE_MAX_ENTRY_BYTES: number;
export declare const DEFAULT_PREVIEW_CACHE_MAX_ENTRIES = 32;
export interface PreviewCacheOptions {
    maxBytes?: number;
    maxEntryBytes?: number;
    maxEntries?: number;
}
export interface PreviewCacheEntry {
    version: string;
    value: unknown;
    byteLength: number;
}
export interface PreviewCacheStats {
    entries: number;
    bytes: number;
    maxBytes: number;
    maxEntryBytes: number;
    maxEntries: number;
}
export declare function estimateValueBytes(value: unknown, depth?: number): number;
export declare function canonicalJson(value: unknown, depth?: number): string;
export declare class PreviewCache {
    private readonly maxBytes;
    private readonly maxEntryBytes;
    private readonly maxEntries;
    private readonly entries;
    private totalBytes;
    constructor(options?: PreviewCacheOptions);
    get(key: string): PreviewCacheEntry | undefined;
    set(key: string, version: string, value: unknown): boolean;
    delete(key: string): boolean;
    clear(): void;
    stats(): PreviewCacheStats;
}
//# sourceMappingURL=preview-cache.d.ts.map