/**
 * Peer-gateway node crypto (PG-1, tasks/peer-gateway/PG-1.md). Pure
 * functions over `node:crypto` only — no I/O, no third-party deps, every
 * public function deterministic except the key generators.
 *
 * Three layers, each independent:
 *
 * 1. Self-certifying Ed25519 identity. A node's id is NOT chosen — it is
 *    `sha256(publicKey)[0..8]`, so anyone who sees a (nodeId, publicKey)
 *    pair can verify the binding with one hash and no PKI. Impersonation
 *    would require finding a key whose hash matches the victim's id
 *    (birthday-bound at 32 bits against offline enumeration, and useless
 *    without the private key anyway).
 *
 * 2. Gateway admission. A node joins a network by answering a gateway
 *    challenge with an Ed25519 signature over a domain-separated message
 *    and proving knowledge of the invite's join key with an HMAC — the
 *    key never travels, only its proof does.
 *
 * 3. Forward-secret peer sessions. Two nodes exchange ONE ephemeral
 *    X25519 key pair each (signed by their long-term identities), derive
 *    HKDF from the DH shared secret into TWO direction keys, and talk
 *    aes-256-gcm (natively hardware-accelerated in both Node OpenSSL and
 *    Electron BoringSSL, where EVP_get_cipherbyname lacks chacha20-poly1305).
 *    Strict dual-simplex: what A uses to encrypt is
 *    exactly what B uses to decrypt and never anything else, so a key is
 *    never used in both directions. The receiver keeps a WireGuard-style
 *    64-entry sliding replay window whose state ONLY advances on an
 *    authenticated packet — a forged packet can never push the window
 *    forward and lock out the legitimate high-water mark.
 *
 * Canonicalization: every hex string that flows into a signed/HMAC'd
 * message is lowercased first. Two honest sides that disagree on letter
 * case would otherwise sign different byte strings; lowercasing makes
 * the message a function of the VALUE, not of its spelling.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, sign, timingSafeEqual, verify, } from 'node:crypto';
// -- shared hex plumbing ---------------------------------------------------------
const LOWER_HEX = /^[0-9a-f]+$/;
/** 8 lowercase hex chars — the `nodeId` shape everywhere. */
const NODE_ID_PATTERN = /^[0-9a-f]{8}$/;
/** 16 lowercase hex chars (either case accepted on input) — the `networkId` shape. */
const NETWORK_ID_PATTERN = /^[0-9a-fA-F]{16}$/;
/** Validate `value` as exactly `bytes` bytes of hex (any case) and return it lowercased. */
function requireHex(value, bytes, name) {
    if (typeof value !== 'string' || value.length !== bytes * 2 || !LOWER_HEX.test(value.toLowerCase())) {
        throw new TypeError(`${name} must be ${bytes * 2} hex characters (${bytes} bytes)`);
    }
    return value.toLowerCase();
}
function requireNodeId(value, name) {
    return requireHex(value, 4, name);
}
function requireNetworkId(value, name) {
    if (typeof value !== 'string' || !NETWORK_ID_PATTERN.test(value)) {
        throw new TypeError(`${name} must be 16 hex characters`);
    }
    return value.toLowerCase();
}
/** A hex string of arbitrary even length ≥ 2 (challenge material), lowercased. */
function requireChallengeHex(value, name) {
    if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0 || !LOWER_HEX.test(value.toLowerCase())) {
        throw new TypeError(`${name} must be a non-empty even-length hex string`);
    }
    return value.toLowerCase();
}
function requireTimestamp(value, name) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new TypeError(`${name} must be an integer number of milliseconds`);
    }
    return value;
}
/** Zero-copy Buffer view over any Uint8Array (wire frames arrive as views). */
function asBufferView(bytes) {
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
/** Decode a validated 32-byte raw hex key into bytes. */
function rawKeyBytes(hex) {
    return Buffer.from(hex, 'hex');
}
function ed25519PublicFromRaw(publicKeyHex) {
    // JWK round-trip is the only raw↔KeyObject path node:crypto offers for
    // OKP keys; `x` is the 32-byte raw public key in base64url.
    return createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: rawKeyBytes(publicKeyHex).toString('base64url') },
        format: 'jwk',
    });
}
function ed25519PrivateFromRaw(publicKeyHex, privateKeyHex) {
    // The JWK importer requires BOTH `d` (seed) and `x` (public) for a
    // private OKP key — `d` alone throws ERR_INVALID_ARG_TYPE. That is why
    // every signing API here takes the public key alongside the seed.
    return createPrivateKey({
        key: {
            kty: 'OKP',
            crv: 'Ed25519',
            x: rawKeyBytes(publicKeyHex).toString('base64url'),
            d: rawKeyBytes(privateKeyHex).toString('base64url'),
        },
        format: 'jwk',
    });
}
/** Generate a fresh long-term node identity (crypto-secure, nondeterministic). */
export function generatePeerIdentity() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' });
    const seedJwk = privateKey.export({ format: 'jwk' });
    const publicKeyHex = Buffer.from(jwk.x, 'base64url').toString('hex');
    const privateKeyHex = Buffer.from(seedJwk.d, 'base64url').toString('hex');
    return { publicKeyHex, privateKeyHex, nodeId: deriveNodeIdFromPublicKey(publicKeyHex) };
}
/**
 * The self-certifying nodeId for one raw 32-byte public key:
 * `sha256(key bytes)` truncated to 8 lowercase hex chars (32 bits).
 */
export function deriveNodeIdFromPublicKey(publicKeyHex) {
    const raw = requireHex(publicKeyHex, 32, 'publicKeyHex');
    return createHash('sha256').update(Buffer.from(raw, 'hex')).digest('hex').slice(0, 8);
}
/**
 * True iff `nodeId` is a well-formed 8-hex id AND is exactly the hash of
 * `publicKeyHex` — the whole PKI of the peer network in one line.
 */
export function verifySelfCertifyingNodeId(nodeId, publicKeyHex) {
    if (typeof nodeId !== 'string' || !NODE_ID_PATTERN.test(nodeId))
        return false;
    if (typeof publicKeyHex !== 'string')
        return false;
    try {
        return deriveNodeIdFromPublicKey(publicKeyHex) === nodeId;
    }
    catch {
        return false;
    }
}
export const PEER_INVITE_DEFAULT_PORT = 19393;
const INVITE_SCHEME_PATTERN = /^(zr-net\+insecure|zr-nets|zr-net):\/\//;
/** Plain hostname: letters/digits/dots/hyphens/underscores, no colons (IPv6 must be bracketed). */
const HOSTNAME_PATTERN = /^[A-Za-z0-9._\-]+$/;
const BRACKETED_IPV6_PATTERN = /^\[[0-9A-Fa-f:.]+\]$/;
const PORT_PATTERN = /^\d+$/;
export function isLoopbackOrPrivateHostname(hostname) {
    const h = hostname.toLowerCase();
    if (h === 'localhost')
        return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (v4) {
        const [a, b] = v4.slice(1).map((part) => Number(part));
        if (a > 255 || b > 255)
            return false; // other octets checked by shape only — inference, not routing
        if (a === 127 || a === 10)
            return true; // loopback, RFC1918 10/8
        if (a === 192 && b === 168)
            return true;
        if (a === 172 && b >= 16 && b <= 31)
            return true;
        if (a === 169 && b === 254)
            return true; // link-local
        if (a === 100 && b >= 64 && b <= 127)
            return true; // CGNAT 100.64.0.0/10 (Tailscale)
        return false;
    }
    if (h === '::1')
        return true;
    if (h.startsWith('fc') || h.startsWith('fd'))
        return true; // IPv6 ULA fc00::/7
    if (h.startsWith('fe80'))
        return true; // IPv6 link-local
    return false;
}
/**
 * Split the invite authority into (rawHost, hostname, port). `null` for
 * anything malformed: unclosed brackets, empty host, port 0/65536+/non-
 * numeric, or unbracketed multi-colon IPv6 (ambiguous with host:port —
 * rejected, never guessed).
 */
function parseInviteAuthority(authority, defaultPort = PEER_INVITE_DEFAULT_PORT) {
    let rawHost;
    let portPart;
    if (authority.startsWith('[')) {
        const close = authority.indexOf(']');
        if (close === -1)
            return null;
        rawHost = authority.slice(0, close + 1);
        const rest = authority.slice(close + 1);
        if (rest !== '') {
            if (!rest.startsWith(':'))
                return null;
            portPart = rest.slice(1);
        }
        const inner = rawHost.slice(1, -1);
        if (inner.length === 0 || !BRACKETED_IPV6_PATTERN.test(rawHost))
            return null;
        return { rawHost, hostname: inner.toLowerCase(), port: parsePortOr(portPart, defaultPort) };
    }
    const colons = authority.split(':').length - 1;
    if (colons > 1)
        return null; // unbracketed IPv6 — ambiguous, reject
    if (colons === 1) {
        const colon = authority.indexOf(':');
        rawHost = authority.slice(0, colon);
        portPart = authority.slice(colon + 1);
    }
    else {
        rawHost = authority;
    }
    if (rawHost.length === 0 || !HOSTNAME_PATTERN.test(rawHost))
        return null;
    return { rawHost, hostname: rawHost.toLowerCase(), port: parsePortOr(portPart, defaultPort) };
}
function parsePortOr(portPart, defaultPort = PEER_INVITE_DEFAULT_PORT) {
    // Only a fully ABSENT `:port` falls back to the default; an explicit
    // empty port (`host:/id`) is malformed, never guessed.
    if (portPart === undefined)
        return defaultPort;
    if (!PORT_PATTERN.test(portPart))
        return -1; // sentinel: invalid, caught by the caller's range check
    return Number(portPart);
}
/**
 * Parse an invite URI. Returns `null` for ANY malformed input — never
 * throws, because the string arrives from QR codes, copy-paste, and other
 * users. Blank runs are trimmed; schemes are matched case-insensitively;
 * the networkId may be mixed-case hex and is normalized to lowercase; the
 * joinKey is percent-decoded when it decodes, kept raw when it does not.
 */
export function parseInviteUri(input) {
    if (typeof input !== 'string')
        return null;
    const trimmed = input.trim();
    const schemeMatch = INVITE_SCHEME_PATTERN.exec(trimmed);
    if (!schemeMatch)
        return null;
    const scheme = schemeMatch[1].toLowerCase();
    const rest = trimmed.slice(schemeMatch[0].length);
    const slash = rest.indexOf('/');
    if (slash === -1)
        return null;
    const authority = rest.slice(0, slash);
    const tail = rest.slice(slash + 1);
    if (authority.length === 0)
        return null;
    const address = parseInviteAuthority(authority);
    if (!address || address.port < 1 || address.port > 65535)
        return null;
    // tail = `<networkId>[#<joinKey>]` — no further path segments allowed.
    const hash = tail.indexOf('#');
    const networkIdPart = hash === -1 ? tail : tail.slice(0, hash);
    const joinKeyPart = hash === -1 ? undefined : tail.slice(hash + 1);
    if (!NETWORK_ID_PATTERN.test(networkIdPart))
        return null;
    const networkId = networkIdPart.toLowerCase();
    let joinKey;
    if (joinKeyPart !== undefined && joinKeyPart !== '') {
        try {
            joinKey = decodeURIComponent(joinKeyPart);
        }
        catch {
            joinKey = joinKeyPart; // keep the raw string; never lose a key to a stray '%'
        }
    }
    const defaultTls = scheme === 'zr-nets'
        ? true
        : scheme === 'zr-net+insecure'
            ? false
            : !isLoopbackOrPrivateHostname(address.hostname);
    return {
        rawHost: address.rawHost,
        hostname: address.hostname,
        port: address.port,
        networkId,
        joinKey,
        defaultTls,
        wsUrl: `${defaultTls ? 'wss' : 'ws'}://${address.rawHost}:${address.port}`,
        httpOrigin: `${defaultTls ? 'https' : 'http'}://${address.rawHost}:${address.port}`,
    };
}
/** Build an invite URI (the inverse of {@link parseInviteUri}). Throws on malformed params — the caller composes it from its own validated state. */
export function formatInviteUri(params) {
    const scheme = params.scheme ?? 'zr-net';
    if (scheme !== 'zr-net' && scheme !== 'zr-nets' && scheme !== 'zr-net+insecure') {
        throw new TypeError(`unknown invite scheme: ${String(params.scheme)}`);
    }
    const host = params.host;
    const bracketed = typeof host === 'string' && host.startsWith('[') && BRACKETED_IPV6_PATTERN.test(host);
    if (typeof host !== 'string' || host.length === 0 || (!bracketed && !HOSTNAME_PATTERN.test(host))) {
        throw new TypeError('host must be a plain hostname or a bracketed IPv6 address');
    }
    const networkId = requireNetworkId(params.networkId, 'networkId');
    const fragment = params.joinKey === undefined || params.joinKey === '' ? '' : `#${encodeURIComponent(params.joinKey)}`;
    return `${scheme}://${host}/${networkId}${fragment}`;
}
const GATEWAY_URL_SCHEME_PATTERN = /^(https?|wss?):\/\//i;
/**
 * Parse user input for joining a peer network: either a full `zr-net://...`
 * invite URI OR a gateway address (`http://host[:port]`, `https://host[:port]`,
 * `ws(s)://...`, or bare `host[:port]` defaulting to port 19393, optionally
 * carrying `/<16-hex-networkId>`) for gateway-side manual approval.
 */
export function parseGatewayJoinInput(input) {
    if (typeof input !== 'string')
        return null;
    const trimmed = input.trim();
    if (trimmed === '')
        return null;
    const asInvite = parseInviteUri(trimmed);
    if (asInvite !== null) {
        return { kind: 'invite', inviteUri: trimmed, parsed: asInvite };
    }
    // Reject unknown schemes (e.g. `ftp://`, malformed `zr-net://` missing networkId).
    const schemeMatch = GATEWAY_URL_SCHEME_PATTERN.exec(trimmed);
    if (!schemeMatch && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
        return null;
    }
    let schemeMode = 'auto';
    let defaultPort = PEER_INVITE_DEFAULT_PORT;
    let rest = trimmed;
    if (schemeMatch) {
        const proto = schemeMatch[1].toLowerCase();
        const isTls = proto === 'https' || proto === 'wss';
        schemeMode = isTls ? 'https' : 'http';
        defaultPort = isTls ? 443 : 80;
        rest = trimmed.slice(schemeMatch[0].length);
    }
    // Strip empty trailing `#` (common when copying console SPA URLs), reject non-empty query/hash.
    if (rest.includes('?'))
        return null;
    const hashIdx = rest.indexOf('#');
    if (hashIdx !== -1) {
        if (rest.slice(hashIdx + 1).trim() !== '')
            return null;
        rest = rest.slice(0, hashIdx);
    }
    const slashIdx = rest.indexOf('/');
    const authority = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    let pathPart = slashIdx === -1 ? '' : rest.slice(slashIdx + 1);
    if (authority === '')
        return null;
    const address = parseInviteAuthority(authority, defaultPort);
    if (!address || address.port < 1 || address.port > 65535)
        return null;
    pathPart = pathPart.replace(/\/+$/u, '');
    if (pathPart.toLowerCase() === 'peer/v1/ws') {
        pathPart = '';
    }
    let networkId;
    if (pathPart !== '') {
        if (!NETWORK_ID_PATTERN.test(pathPart))
            return null;
        networkId = pathPart.toLowerCase();
    }
    return {
        kind: 'gateway',
        rawHost: address.rawHost,
        hostname: address.hostname,
        port: address.port,
        schemeMode,
        ...(networkId !== undefined ? { networkId } : {}),
    };
}
/**
 * Construct a canonical keyless invite URI (`zr-net` / `zr-nets` /
 * `zr-net+insecure`) that round-trips through {@link parseInviteUri} to the
 * exact `tls` transport and `rawHost:port`.
 */
export function buildKeylessInviteUri(params) {
    const networkId = requireNetworkId(params.networkId, 'networkId');
    const isPrivate = isLoopbackOrPrivateHostname(params.hostname);
    const scheme = params.tls
        ? (isPrivate ? 'zr-nets' : 'zr-net')
        : (isPrivate ? 'zr-net' : 'zr-net+insecure');
    return `${scheme}://${params.rawHost}:${params.port}/${networkId}`;
}
// -- 3. gateway challenge + join-key proof -----------------------------------------
const GATEWAY_AUTH_DOMAIN = 'zr-gw-auth-v1';
const JOIN_PROOF_DOMAIN = 'zr-join-v1';
/** The canonical byte string both gateway sides sign/verify over. */
function gatewayAuthMessage(params) {
    const networkId = requireNetworkId(params.networkId, 'networkId');
    const nodeId = requireHex(params.nodeId, 4, 'nodeId');
    const challengeHex = requireChallengeHex(params.challengeHex, 'challengeHex');
    const timestamp = requireTimestamp(params.timestamp, 'timestamp');
    return Buffer.from(`${GATEWAY_AUTH_DOMAIN}|${networkId}|${nodeId}|${challengeHex}|${timestamp}`, 'utf8');
}
/** Sign one gateway admission challenge with the node's long-term identity (64-byte signature → 128 hex). */
export function signGatewayChallenge(params) {
    const privateKey = ed25519PrivateFromRaw(requireHex(params.publicKeyHex, 32, 'publicKeyHex'), requireHex(params.privateKeyHex, 32, 'privateKeyHex'));
    const message = gatewayAuthMessage(params);
    return sign(null, message, privateKey).toString('hex');
}
/**
 * Verify a gateway admission signature. The nodeId/publicKey self-
 * certification is checked BEFORE any signature math, so an identity
 * whose id is not the hash of its key is refused outright. Malformed
 * inputs answer `false` — verification is a boundary, it never throws.
 */
export function verifyGatewayChallenge(params) {
    if (!verifySelfCertifyingNodeId(params.nodeId, params.publicKeyHex))
        return false;
    if (typeof params.signatureHex !== 'string' || !LOWER_HEX.test(params.signatureHex.toLowerCase())
        || params.signatureHex.length !== 128)
        return false;
    if (typeof params.timestamp !== 'number' || !Number.isInteger(params.timestamp))
        return false;
    try {
        const message = gatewayAuthMessage(params);
        const publicKey = ed25519PublicFromRaw(requireHex(params.publicKeyHex, 32, 'publicKeyHex'));
        return verify(null, message, publicKey, Buffer.from(params.signatureHex, 'hex'));
    }
    catch {
        return false;
    }
}
function joinKeyProofMessage(params) {
    const networkId = requireNetworkId(params.networkId, 'networkId');
    const nodeId = requireHex(params.nodeId, 4, 'nodeId');
    const challengeHex = requireChallengeHex(params.challengeHex, 'challengeHex');
    return Buffer.from(`${JOIN_PROOF_DOMAIN}|${networkId}|${nodeId}|${challengeHex}`, 'utf8');
}
/**
 * Prove knowledge of the invite join key WITHOUT sending it:
 * HMAC-SHA256(key = joinKey bytes) over the domain-separated challenge
 * context. The gateway recomputes from the join key it holds.
 */
export function computeJoinKeyProof(params) {
    if (typeof params.joinKey !== 'string')
        throw new TypeError('joinKey must be a string');
    const message = joinKeyProofMessage(params);
    return createHmac('sha256', Buffer.from(params.joinKey, 'utf8')).update(message).digest('hex');
}
/** Constant-time verification of {@link computeJoinKeyProof} output; malformed input answers `false`. */
export function verifyJoinKeyProof(params) {
    if (typeof params.joinKey !== 'string')
        return false;
    if (typeof params.proofHex !== 'string' || params.proofHex.length !== 64 || !LOWER_HEX.test(params.proofHex.toLowerCase()))
        return false;
    try {
        const actual = createHmac('sha256', Buffer.from(params.joinKey, 'utf8')).update(joinKeyProofMessage(params)).digest();
        return timingSafeEqual(actual, Buffer.from(params.proofHex.toLowerCase(), 'hex'));
    }
    catch {
        return false;
    }
}
// -- 4. PFS handshake + dual-simplex AEAD ------------------------------------------
const PEER_HS_DOMAIN = 'zr-peer-hs-v2';
/** HKDF salt carries the canonical (low,high) node pair + their ephemeral keys; info splits the output. */
const PEER_KDF_SALT_DOMAIN = 'zr-peer-kdf-v1';
const PEER_KDF_INFO = Buffer.from('zr-peer-txrx-v1', 'utf8');
const KEY_BYTES = 32;
const PEER_KDF_OUTPUT_BYTES = 64;
const REPLAY_WINDOW_BITS = 64n;
const REPLAY_WINDOW_MASK = (1n << REPLAY_WINDOW_BITS) - 1n;
/** seq is a u64: nonce = 4 zero bytes + big-endian seq (12 bytes total for aes-256-gcm). */
const SEQ_MAX = (1n << 64n) - 1n;
const HEADER_BYTES = 28;
const AEAD_TAG_BYTES = 16;
function x25519PublicFromRaw(publicKeyHex) {
    return createPublicKey({
        key: { kty: 'OKP', crv: 'X25519', x: rawKeyBytes(publicKeyHex).toString('base64url') },
        format: 'jwk',
    });
}
function x25519PrivateFromRaw(publicKeyHex, privateKeyHex) {
    return createPrivateKey({
        key: {
            kty: 'OKP',
            crv: 'X25519',
            x: rawKeyBytes(publicKeyHex).toString('base64url'),
            d: rawKeyBytes(privateKeyHex).toString('base64url'),
        },
        format: 'jwk',
    });
}
/** Generate one ephemeral X25519 key pair for a PFS session (nondeterministic). */
export function generateEphemeralX25519() {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const jwk = publicKey.export({ format: 'jwk' });
    const privJwk = privateKey.export({ format: 'jwk' });
    return {
        publicKeyHex: Buffer.from(jwk.x, 'base64url').toString('hex'),
        privateKeyHex: Buffer.from(privJwk.d, 'base64url').toString('hex'),
    };
}
function peerHandshakeMessage(params) {
    if (params.role !== 'hello' && params.role !== 'ack') {
        throw new TypeError(`role must be 'hello' or 'ack', got ${String(params.role)}`);
    }
    const networkId = requireNetworkId(params.networkId, 'networkId');
    const srcNodeId = requireHex(params.srcNodeId, 4, 'srcNodeId');
    const dstNodeId = requireHex(params.dstNodeId, 4, 'dstNodeId');
    const srcEphPubHex = requireHex(params.srcEphPubHex, 32, 'srcEphPubHex');
    // `hello` carries the all-zero placeholder before the peer's ephemeral
    // key is known; it is an ordinary hex field here, not a special case.
    const dstEphPubHex = requireHex(params.dstEphPubHex, 32, 'dstEphPubHex');
    const nonce = requireHex(params.nonce, 8, 'nonce');
    const timestamp = requireTimestamp(params.timestamp, 'timestamp');
    return Buffer.from(`${PEER_HS_DOMAIN}|${params.role}|${networkId}|${srcNodeId}|${dstNodeId}|${srcEphPubHex}|${dstEphPubHex}|${nonce}|${timestamp}`, 'utf8');
}
/**
 * Sign one peer handshake message (hello or ack) with the long-term
 * identity, binding it to the network, both node ids, BOTH ephemeral
 * public keys, the challenge nonce and the timestamp — a replayed or
 * substituted ephemeral key or nonce breaks the signature.
 */
export function signPeerHandshake(params) {
    const privateKey = ed25519PrivateFromRaw(requireHex(params.identityPublicKeyHex, 32, 'identityPublicKeyHex'), requireHex(params.identityPrivateKeyHex, 32, 'identityPrivateKeyHex'));
    const message = peerHandshakeMessage(params);
    return sign(null, message, privateKey).toString('hex');
}
/** Verify a peer handshake; the srcNodeId must be self-certifying for the presented identity. Never throws. */
export function verifyPeerHandshake(params) {
    if (!verifySelfCertifyingNodeId(params.srcNodeId, params.identityPublicKeyHex))
        return false;
    if (typeof params.signatureHex !== 'string' || params.signatureHex.length !== 128
        || !LOWER_HEX.test(params.signatureHex.toLowerCase()))
        return false;
    if (typeof params.timestamp !== 'number' || !Number.isInteger(params.timestamp))
        return false;
    try {
        const message = peerHandshakeMessage(params);
        const publicKey = ed25519PublicFromRaw(requireHex(params.identityPublicKeyHex, 32, 'identityPublicKeyHex'));
        return verify(null, message, publicKey, Buffer.from(params.signatureHex, 'hex'));
    }
    catch {
        return false;
    }
}
/**
 * WireGuard-style sliding replay window over u64 sequence numbers, at
 * most 64 packets back from the highest AUTHENTICATED seq. `admit` is the
 * precheck (already-seen / too-old → reject BEFORE spending CPU on AEAD);
 * `commit` marks a seq received and slides the window — it runs ONLY
 * after the auth tag verified, so an attacker spraying forged packets
 * with huge seqs can never move the window or mark anything.
 */
class ReplayWindow {
    /** Highest authenticated seq so far; `null` until the first packet authenticates. */
    highest = null;
    /** Bit `i` set = `highest - i` was received (i in 0..63). */
    bits = 0n;
    admit(seq) {
        if (this.highest === null)
            return true;
        if (seq > this.highest)
            return true;
        const delta = this.highest - seq;
        if (delta >= REPLAY_WINDOW_BITS)
            return false;
        return ((this.bits >> delta) & 1n) === 0n;
    }
    commit(seq) {
        if (this.highest === null) {
            this.highest = seq;
            this.bits = 1n;
            return;
        }
        if (seq > this.highest) {
            const shift = seq - this.highest;
            this.bits = (shift >= REPLAY_WINDOW_BITS ? 0n : (this.bits << shift) & REPLAY_WINDOW_MASK) | 1n;
            this.highest = seq;
            return;
        }
        this.bits |= 1n << (this.highest - seq);
    }
}
function requireSeq(seq, name) {
    if (typeof seq !== 'bigint' || seq < 0n || seq > SEQ_MAX) {
        throw new TypeError(`${name} must be a bigint in [0, 2^64)`);
    }
    return seq;
}
function nonceFor(seq) {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(seq, 4);
    return nonce;
}
/**
 * Derive the two strictly direction-isolated session keys from one
 * ephemeral X25519 exchange. Both sides run this symmetrically: the node
 * pair is sorted lexicographically into (low, high) and the salt carries
 * the canonical pair plus each side's ephemeral public key, so A and B
 * compute byte-identical HKDF input and split the 64-byte output into a
 * low→high key and a high→low key. Result: A's txKey === B's rxKey and
 * vice versa, and (for distinct node ids) txKey !== rxKey — no key ever
 * encrypts in both directions.
 */
export function derivePeerSessionCiphers(params) {
    const networkId = requireNetworkId(params.networkId, 'networkId');
    const myNodeId = requireNodeId(params.myNodeId, 'myNodeId');
    const peerNodeId = requireNodeId(params.peerNodeId, 'peerNodeId');
    const myEphPrivateKeyHex = requireHex(params.myEphPrivateKeyHex, 32, 'myEphPrivateKeyHex');
    const myEphPublicKeyHex = requireHex(params.myEphPublicKeyHex, 32, 'myEphPublicKeyHex');
    const peerEphPublicKeyHex = requireHex(params.peerEphPublicKeyHex, 32, 'peerEphPublicKeyHex');
    const shared = diffieHellman({
        privateKey: x25519PrivateFromRaw(myEphPublicKeyHex, myEphPrivateKeyHex),
        publicKey: x25519PublicFromRaw(peerEphPublicKeyHex),
    });
    if (shared.length !== KEY_BYTES)
        throw new Error('X25519 shared secret has unexpected length');
    // An all-zero shared secret means a degenerate/low-order peer key —
    // refuse rather than derive a key an attacker could also derive.
    if (shared.every((byte) => byte === 0))
        throw new Error('X25519 shared secret is all zeros (low-order peer key)');
    const [lowId, highId] = [myNodeId, peerNodeId].sort();
    const lowPub = myNodeId === lowId ? myEphPublicKeyHex : peerEphPublicKeyHex;
    const highPub = myNodeId === lowId ? peerEphPublicKeyHex : myEphPublicKeyHex;
    const salt = Buffer.from(`${PEER_KDF_SALT_DOMAIN}|${networkId}|${lowId}|${highId}|${lowPub}|${highPub}`, 'utf8');
    const okm = Buffer.from(hkdfSync('sha256', shared, salt, PEER_KDF_INFO, PEER_KDF_OUTPUT_BYTES));
    // First half = low→high direction, second half = high→low direction.
    const lowToHigh = okm.subarray(0, KEY_BYTES);
    const highToLow = okm.subarray(KEY_BYTES, PEER_KDF_OUTPUT_BYTES);
    const txKey = myNodeId === lowId ? lowToHigh : highToLow;
    const rxKey = myNodeId === lowId ? highToLow : lowToHigh;
    const txKeyHex = txKey.toString('hex');
    const rxKeyHex = rxKey.toString('hex');
    const rxWindow = new ReplayWindow();
    const requireHeader = (header28) => {
        if (!ArrayBuffer.isView(header28) || header28.byteLength !== HEADER_BYTES) {
            throw new TypeError(`header28 must be exactly ${HEADER_BYTES} bytes`);
        }
        return asBufferView(header28);
    };
    return {
        txKeyHex,
        rxKeyHex,
        seal(header28, plaintext, seq) {
            const header = requireHeader(header28);
            requireSeq(seq, 'seq');
            const payload = asBufferView(plaintext);
            const cipher = createCipheriv('aes-256-gcm', Buffer.from(txKeyHex, 'hex'), nonceFor(seq), { authTagLength: AEAD_TAG_BYTES });
            cipher.setAAD(header);
            const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
            return Buffer.concat([ciphertext, cipher.getAuthTag()]);
        },
        open(header28, sealedPayload, seq) {
            let header;
            try {
                header = requireHeader(header28);
                requireSeq(seq, 'seq');
                const sealed = asBufferView(sealedPayload);
                if (sealed.byteLength < AEAD_TAG_BYTES)
                    return null;
                // Replay precheck BEFORE any decryption work: the window stays
                // untouched on every failure path below, so forged junk with a
                // huge seq cannot push `highest` forward.
                if (!rxWindow.admit(seq))
                    return null;
                const tag = sealed.subarray(sealed.byteLength - AEAD_TAG_BYTES);
                const ciphertext = sealed.subarray(0, sealed.byteLength - AEAD_TAG_BYTES);
                const decipher = createDecipheriv('aes-256-gcm', Buffer.from(rxKeyHex, 'hex'), nonceFor(seq), { authTagLength: AEAD_TAG_BYTES });
                decipher.setAAD(header);
                decipher.setAuthTag(tag);
                const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
                rxWindow.commit(seq);
                return new Uint8Array(plaintext);
            }
            catch {
                return null;
            }
        },
    };
}
// -- 5. handshake envelope contract (zr-peer-hs-v2) --------------------------------
//
// UDP 打洞（punch.ts）与网关 WS 中转（mux.ts）共用这一份 v2 握手信封契约：
// 每个 HELLO/ACK 只发单一签名 `sigHex`（`zr-peer-hs-v2`，绑定角色、网络、
// 双方 nodeId、双方临时钥、挑战 nonce 与时间戳），线上传输零未签名字段，绝不
// 降级旧版。
/** HELLO 里「应答方临时钥未知」的显式占位：64 个 '0'，是 v2 串中的普通 hex 字段。 */
export const PEER_HS_ZERO_EPH_PUB = '0'.repeat(64);
/**
 * 构造 v2 握手信封（HELLO/ACK 通吃）：全部字段纳入 `zr-peer-hs-v2` 单一签名
 * `sigHex`，并带 `hs: 2` 版本标记。
 */
export function buildPeerHandshakeEnvelope(params) {
    if (params.kind !== 'hello' && params.kind !== 'ack') {
        throw new TypeError(`kind must be 'hello' or 'ack', got ${String(params.kind)}`);
    }
    const networkId = requireNetworkId(params.networkId, 'networkId');
    const publicKeyHex = requireHex(params.identity.publicKeyHex, 32, 'identity.publicKeyHex');
    const privateKeyHex = requireHex(params.identity.privateKeyHex, 32, 'identity.privateKeyHex');
    const nodeId = requireNodeId(params.identity.nodeId, 'identity.nodeId');
    if (deriveNodeIdFromPublicKey(publicKeyHex) !== nodeId) {
        throw new TypeError('identity.nodeId is not the self-certifying hash of identity.publicKeyHex');
    }
    const selfEphPubHex = requireHex(params.selfEphPubHex, 32, 'selfEphPubHex');
    const peerNodeId = requireNodeId(params.peerNodeId, 'peerNodeId');
    if (peerNodeId === nodeId)
        throw new TypeError('peerNodeId must differ from the local nodeId');
    const nonce = requireHex(params.nonce, 8, 'nonce');
    const timestamp = requireTimestamp(params.timestamp, 'timestamp');
    let peerEphPubHex;
    if (params.kind === 'hello') {
        if (params.peerEphPubHex !== null) {
            throw new TypeError('hello envelopes must pass peerEphPubHex: null — the answering side ephemeral is not known yet');
        }
        peerEphPubHex = PEER_HS_ZERO_EPH_PUB;
    }
    else {
        if (params.peerEphPubHex === null) {
            throw new TypeError('ack envelopes must bind the answered HELLO ephemeral in peerEphPubHex');
        }
        peerEphPubHex = requireHex(params.peerEphPubHex, 32, 'peerEphPubHex');
        if (peerEphPubHex === PEER_HS_ZERO_EPH_PUB) {
            throw new TypeError('ack peerEphPubHex must be a real ephemeral key, not the zero placeholder');
        }
    }
    const sigHex = signPeerHandshake({
        role: params.kind,
        networkId,
        srcNodeId: nodeId,
        dstNodeId: peerNodeId,
        srcEphPubHex: selfEphPubHex,
        dstEphPubHex: peerEphPubHex,
        nonce,
        timestamp,
        identityPrivateKeyHex: privateKeyHex,
        identityPublicKeyHex: publicKeyHex,
    });
    return Buffer.from(JSON.stringify({
        zr: 1,
        hs: 2,
        kind: params.kind === 'hello' ? 'zr-hello' : 'zr-hello-ack',
        networkId,
        nodeId,
        peerNodeId,
        publicKeyHex,
        ephPubHex: selfEphPubHex,
        peerEphPubHex,
        nonce,
        timestamp,
        sigHex,
    }), 'utf8');
}
const ENVELOPE_HEX64 = /^[0-9a-fA-F]{64}$/;
const ENVELOPE_HEX16 = /^[0-9a-fA-F]{16}$/;
const ENVELOPE_HEX128 = /^[0-9a-fA-F]{128}$/;
/**
 * 解析并验证一个 v2 握手信封（UDP 数据报与 WS 中转帧共用；WS 侧补零在函数内
 * 剥除）。返回 null 的情形：JSON/形状坏、缺 `hs: 2`、networkId 不符、自源或
 * 非指名本机、nodeId 非自证明、HELLO/ACK 对端临时钥占位不符、时间窗外（仅当
 * `timeWindowMs > 0`），或 `zr-peer-hs-v2` 验签失败——绝不降级。从不抛异常。
 */
export function parsePeerHandshakeEnvelope(bytes, options) {
    try {
        const text = Buffer.from(asBufferView(bytes)).toString('utf8').replace(/\x00+$/, '');
        const obj = JSON.parse(text);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj))
            return null;
        const fields = obj;
        if (fields.zr !== 1 || fields.hs !== 2)
            return null;
        const kind = fields.kind === 'zr-hello' ? 'hello' : fields.kind === 'zr-hello-ack' ? 'ack' : null;
        if (kind === null)
            return null;
        if (fields.networkId !== options.networkId)
            return null;
        const nodeId = typeof fields.nodeId === 'string' ? fields.nodeId.toLowerCase() : '';
        if (!NODE_ID_PATTERN.test(nodeId) || nodeId === options.selfNodeId)
            return null;
        const publicKeyHex = typeof fields.publicKeyHex === 'string' ? fields.publicKeyHex.toLowerCase() : '';
        const ephPubHex = typeof fields.ephPubHex === 'string' ? fields.ephPubHex.toLowerCase() : '';
        const nonce = typeof fields.nonce === 'string' ? fields.nonce.toLowerCase() : '';
        const peerNodeId = typeof fields.peerNodeId === 'string' ? fields.peerNodeId.toLowerCase() : '';
        const peerEphPubHex = typeof fields.peerEphPubHex === 'string' ? fields.peerEphPubHex.toLowerCase() : '';
        const timestamp = typeof fields.timestamp === 'number' ? fields.timestamp : Number.NaN;
        const sigHex = typeof fields.sigHex === 'string' ? fields.sigHex : '';
        if (!ENVELOPE_HEX64.test(publicKeyHex) || !ENVELOPE_HEX64.test(ephPubHex)
            || !ENVELOPE_HEX16.test(nonce) || !NODE_ID_PATTERN.test(peerNodeId)
            || !ENVELOPE_HEX64.test(peerEphPubHex) || !Number.isInteger(timestamp)
            || !ENVELOPE_HEX128.test(sigHex))
            return null;
        if (peerNodeId !== options.selfNodeId)
            return null;
        if (ephPubHex === PEER_HS_ZERO_EPH_PUB)
            return null;
        if (kind === 'hello' && peerEphPubHex !== PEER_HS_ZERO_EPH_PUB)
            return null;
        if (kind === 'ack' && peerEphPubHex === PEER_HS_ZERO_EPH_PUB)
            return null;
        if (!verifySelfCertifyingNodeId(nodeId, publicKeyHex))
            return null;
        if (options.timeWindowMs > 0 && Math.abs(options.nowMs - timestamp) > options.timeWindowMs)
            return null;
        const verified = verifyPeerHandshake({
            role: kind,
            networkId: options.networkId,
            srcNodeId: nodeId,
            dstNodeId: peerNodeId,
            srcEphPubHex: ephPubHex,
            dstEphPubHex: peerEphPubHex,
            nonce,
            timestamp,
            identityPublicKeyHex: publicKeyHex,
            signatureHex: sigHex,
        });
        if (!verified)
            return null;
        return {
            kind,
            networkId: options.networkId,
            nodeId,
            publicKeyHex,
            ephPubHex,
            nonce,
            timestamp,
            peerNodeId,
            peerEphPubHex,
        };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=crypto.js.map