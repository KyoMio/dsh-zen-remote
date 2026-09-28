/**
 * Pure pairing/probe logic for the sub-client half (T16): the address
 * normalizer the claim route validates user input with, and the two
 * classifiers that turn one HTTP round-trip each into a shape the settings
 * block can render. No I/O, no clocks, no process reads — the route module
 * owns the sockets and the timeouts, this module owns the decisions.
 *
 * IPv4/IPv6 range checks are hand-rolled because the address arrives as a
 * STRING inside an already-parsed URL and the point is to keep the private-
 * network allowance of `normalizeServerUrl` exactly as narrow as specified
 * (172.16/12, 100.64/10 etc. — off-by-one range bugs here would either lock
 * LAN users out or open plain-http pairing to the public internet).
 */
/** The gateway claim endpoint, resolved against the normalized server URL. */
export const CLAIM_PATH = '/lan-gate/pair/claim-desktop';
/** The relay ping path the client backend probes (the gateway admits this
 * prefix for desktop-client devices and forwards to the host relay route). */
export const RELAY_PING_PATH = '/_dsh/zen-remote/relay/ping';
/** One private-network allowance for plain http, as (label, predicate). IPv4
 * ranges are `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
 * `100.64.0.0/10` (CGNAT/Tailscale), `127.0.0.0/8`; IPv6: `::1`, `fc00::/7`,
 * `fe80::/10`; plus the hostnames `localhost` and `*.local`. */
function isHttpAllowedHost(hostname) {
    if (hostname === 'localhost' || hostname.endsWith('.local'))
        return true;
    if (hostname.includes(':'))
        return isAllowedIpv6(hostname);
    return isAllowedIpv4(hostname);
}
/** Dotted-quad check against the allowed ranges. The hostname comes from a
 * parsed URL, so it is already canonical (the WHATWG parser folds exotic
 * spellings like `010.0x0A.0.3` into plain decimal before we ever see it). */
function isAllowedIpv4(hostname) {
    const parts = hostname.split('.');
    if (parts.length !== 4)
        return false;
    const bytes = [];
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part))
            return false;
        const value = Number(part);
        if (value > 255)
            return false;
        bytes.push(value);
    }
    const [a, b] = bytes;
    if (a === 10 || a === 127)
        return true; // 10.0.0.0/8, 127.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31)
        return true; // 172.16.0.0/12
    if (a === 192 && b === 168)
        return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127)
        return true; // 100.64.0.0/10
    return false;
}
/** IPv6 check against `::1`, `fc00::/7` and `fe80::/10`. Hostnames of parsed
 * URLs keep the square brackets; the zone suffix (`%25…`) is rejected —
 * link-local with a zone id is a machine-local spelling anyway. */
function isAllowedIpv6(bracketed) {
    const host = bracketed.startsWith('[') && bracketed.endsWith(']') ? bracketed.slice(1, -1) : bracketed;
    if (!host.includes('%') && host === '::1')
        return true;
    const groups = ipv6Groups(host);
    if (groups === undefined)
        return false;
    const first = groups[0];
    return (first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf);
}
/** Expand an IPv6 string into its 8 numeric groups, honoring one `::`.
 * Anything malformed — a second `::`, a non-hex or over-long group, more
 * than 8 groups without `::` — is rejected (undefined), never guessed. */
function ipv6Groups(host) {
    const halves = host.split('::');
    if (halves.length > 2)
        return undefined;
    const parseGroups = (text) => {
        if (text === '')
            return [];
        const groups = [];
        for (const raw of text.split(':')) {
            if (!/^[0-9a-fA-F]{1,4}$/.test(raw))
                return undefined;
            groups.push(parseInt(raw, 16));
        }
        return groups;
    };
    const head = parseGroups(halves[0]);
    if (head === undefined)
        return undefined;
    const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
    if (tail === undefined)
        return undefined;
    const missing = 8 - head.length - tail.length;
    if (missing < 0 || (halves.length === 1 && missing !== 0))
        return undefined;
    return [...head, ...new Array(missing).fill(0), ...tail];
}
/**
 * Normalize one user-typed server address to the exact string the client
 * stores and probes: surrounding whitespace and trailing slashes gone, no
 * path (beyond `/`), no query, no fragment, no embedded credentials, and a
 * scheme of `http:` (private hosts only) or `https:` (always).
 */
export function normalizeServerUrl(input) {
    if (typeof input !== 'string')
        return { ok: false, reason: 'invalid' };
    let parsed;
    try {
        parsed = new URL(input.trim().replace(/\/+$/u, ''));
    }
    catch {
        return { ok: false, reason: 'invalid' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return { ok: false, reason: 'invalid' };
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '')
        return { ok: false, reason: 'invalid' };
    if (parsed.username !== '' || parsed.password !== '')
        return { ok: false, reason: 'invalid' };
    if (parsed.protocol === 'http:' && !isHttpAllowedHost(parsed.hostname)) {
        return { ok: false, reason: 'insecure-http' };
    }
    return { ok: true, url: parsed.origin };
}
/** First string value of a possibly-unknown field, for the success shape. */
function stringOf(value) {
    return typeof value === 'string' ? value : '';
}
/**
 * Classify one claim round-trip. `body` may be anything the server returned
 * (including unparsable garbage — the route passes `undefined` then): only
 * the exact happy shape counts as success, everything else lands in the four
 * refusal buckets the settings block has copy for.
 */
export function classifyClaimResponse(status, body) {
    const record = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? body
        : {};
    if (status >= 200 && status < 300 && record.ok === true) {
        const token = stringOf(record.token);
        if (token === '')
            return { ok: false, code: 'unexpected' };
        return {
            ok: true,
            token,
            deviceId: stringOf(record.id),
            deviceName: stringOf(record.name),
        };
    }
    if (status === 403 && record.reason === 'role-mismatch') {
        const message = stringOf(record.message);
        return message === '' ? { ok: false, code: 'role-mismatch' } : { ok: false, code: 'role-mismatch', message };
    }
    if (status === 403 && record.reason === 'bad-code')
        return { ok: false, code: 'bad-code' };
    if (status === 429 && record.reason === 'locked') {
        const retryAfterMs = typeof record.retryAfterMs === 'number' && Number.isFinite(record.retryAfterMs)
            ? Math.max(0, record.retryAfterMs)
            : 0;
        return { ok: false, code: 'locked', retryAfterMs };
    }
    return { ok: false, code: 'unexpected' };
}
/**
 * Classify one probe of `<serverUrl>${RELAY_PING_PATH}`:
 *
 * - no HTTP answer at all → `unreachable` (down, wrong address, timeout);
 * - 401 → `revoked` — the gateway treats an invalid or revoked desktop-client
 *   token as unpaired and answers its 401 wall;
 * - 403 with `reason: 'relay-only'` → `unexpected`: the token was ACCEPTED
 *   but the server refuses the relay prefix — only possible when the server
 *   is not running the 2.0.0 gateway;
 * - any other status (200 ping ok, 404 from a pre-relay server, even 3xx)
 *   means the gateway accepted the token → `connected`.
 */
export function classifyProbe(result) {
    if (result.kind === 'error')
        return 'unreachable';
    if (result.status === 401)
        return 'revoked';
    if (result.status === 403) {
        const reason = result.body !== null && typeof result.body === 'object' && !Array.isArray(result.body)
            ? result.body.reason
            : undefined;
        if (reason === 'relay-only')
            return 'unexpected';
    }
    return 'connected';
}
//# sourceMappingURL=client-pairing.js.map