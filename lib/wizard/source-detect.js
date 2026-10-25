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
 * Extract the untrusted-proxy detection from one `/lan-gate/status` body.
 * Returns null when the gateway predates the field or the field is
 * malformed — a missing detection is the common case, never an error.
 */
export function detectForwardedSource(gatewayStatus) {
    if (gatewayStatus === null || typeof gatewayStatus !== 'object')
        return null;
    const source = gatewayStatus.lastForwardedSource;
    if (source === null || typeof source !== 'object')
        return null;
    const { ip, at } = source;
    if (typeof ip !== 'string' || ip === '')
        return null;
    if (typeof at !== 'number' || !Number.isFinite(at))
        return null;
    return { ip, at };
}
/**
 * One trust-list entry: an IP literal, normalized the way the gateway
 * normalizes socket peers (`::ffff:` IPv4-in-IPv6 unwrapped). Refuses
 * anything that is not a plausible IPv4/IPv6 literal — the value goes
 * into persisted config and later into an exact string comparison
 * against socket peers, where a hostname or a CIDR would silently never
 * match.
 */
export function normalizeTrustedIp(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const value = raw.trim();
    if (value === '')
        return undefined;
    // IPv4-in-IPv6 form the gateway itself strips from socket peers.
    const unwrapped = value.toLowerCase().startsWith('::ffff:') ? value.slice(7) : value;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(unwrapped)) {
        return unwrapped.split('.').every((part) => Number(part) <= 255) ? unwrapped : undefined;
    }
    // IPv6: hex groups and colons only, at least one colon, no zone index.
    if (/^[0-9a-f:]+$/i.test(unwrapped) && unwrapped.includes(':') && !unwrapped.includes('%')) {
        return unwrapped.toLowerCase();
    }
    return undefined;
}
/** Split the comma-separated trustedProxies value into entries. */
export function parseProxyList(value) {
    if (typeof value !== 'string')
        return [];
    return value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
}
/**
 * Append one IP to the comma-separated list, preserving order, skipping
 * duplicates (the trust-proxy route answers "already trusted" instead of
 * rewriting). Normalization is the caller's job — the route normalizes
 * before merging.
 */
export function mergeProxyList(current, ip) {
    const entries = parseProxyList(current);
    if (entries.includes(ip))
        return entries.join(',');
    return [...entries, ip].join(',');
}
//# sourceMappingURL=source-detect.js.map