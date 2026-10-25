/**
 * Reverse-proxy source detection (GW-5), pure logic — the browser-facing
 * half of the 「检测到反代从 {ip} 连过来，自动信任？」flow.
 *
 * The gateway (lib/lan-gate-server.cjs) records the last request that
 * carried proxy headers from a socket it does NOT trust — almost always
 * the user's own reverse proxy whose IP never made it into
 * `trustedProxies` — as `lastForwardedSource: { ip, at }` in its
 * `/lan-gate/status` answer. {@link detectForwardedSource} lifts that
 * field out (defensively: the gateway may be old and send nothing), and
 * {@link mergeProxyList} / {@link normalizeTrustedIp} build the merged
 * trust list the trust-proxy route persists.
 *
 * Pure: no imports, no I/O — the check scripts can drive it directly.
 */
/**
 * The recognized shape of the gateway's `lastForwardedSource`. Everything
 * else — missing field (an older gateway), junk values — reads as "no
 * detection".
 */
export interface ForwardedSourceInput {
    ip?: unknown;
    at?: unknown;
}
export interface DetectedForwardedSource {
    ip: string;
    at: number;
}
/**
 * Extract the untrusted-proxy detection from one `/lan-gate/status` body.
 * Returns null when the gateway predates the field or the field is
 * malformed — a missing detection is the common case, never an error.
 */
export declare function detectForwardedSource(gatewayStatus: unknown): DetectedForwardedSource | null;
/**
 * One trust-list entry: an IP literal, normalized the way the gateway
 * normalizes socket peers (`::ffff:` IPv4-in-IPv6 unwrapped). Refuses
 * anything that is not a plausible IPv4/IPv6 literal — the value goes
 * into persisted config and later into an exact string comparison
 * against socket peers, where a hostname or a CIDR would silently never
 * match.
 */
export declare function normalizeTrustedIp(raw: unknown): string | undefined;
/** Split the comma-separated trustedProxies value into entries. */
export declare function parseProxyList(value: unknown): string[];
/**
 * Append one IP to the comma-separated list, preserving order, skipping
 * duplicates (the trust-proxy route answers "already trusted" instead of
 * rewriting). Normalization is the caller's job — the route normalizes
 * before merging.
 */
export declare function mergeProxyList(current: unknown, ip: string): string;
//# sourceMappingURL=source-detect.d.ts.map