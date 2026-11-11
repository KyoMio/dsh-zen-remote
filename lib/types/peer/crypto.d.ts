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
export interface PeerIdentityKeyPair {
    /** 32-byte raw Ed25519 public key, 64 lowercase hex chars. */
    publicKeyHex: string;
    /** 32-byte raw Ed25519 private seed, 64 lowercase hex chars. */
    privateKeyHex: string;
    /** `sha256(publicKeyHex bytes)` first 8 hex chars — self-certifying node id. */
    nodeId: string;
}
/** Generate a fresh long-term node identity (crypto-secure, nondeterministic). */
export declare function generatePeerIdentity(): PeerIdentityKeyPair;
/**
 * The self-certifying nodeId for one raw 32-byte public key:
 * `sha256(key bytes)` truncated to 8 lowercase hex chars (32 bits).
 */
export declare function deriveNodeIdFromPublicKey(publicKeyHex: string): string;
/**
 * True iff `nodeId` is a well-formed 8-hex id AND is exactly the hash of
 * `publicKeyHex` — the whole PKI of the peer network in one line.
 */
export declare function verifySelfCertifyingNodeId(nodeId: string, publicKeyHex: string): boolean;
/**
 * A parsed `zr-net://<host[:port]>/<networkId>[#<joinKey>]` invite.
 *
 * `defaultTls` says which transport the SCHEME alone implies ( callers may
 * still connect the other way, e.g. an explicit local test override):
 * - `zr-nets://` forces TLS (wss/https) regardless of the host;
 * - `zr-net+insecure://` forces plaintext (ws/http), for local tests only;
 * - plain `zr-net://` infers from the host: loopback / private v4 / ULA /
 *   link-local / Tailscale CGNAT (100.64.0.0/10) → plaintext, anything
 *   publicly routable → TLS, because a public path needs the reverse
 *   proxy's certificate to be meaningful.
 *
 * `rawHost` is the host token exactly as written (brackets kept for IPv6);
 * `hostname` is the bracket-stripped lowercase address. `port` defaults to
 * 19393 and both URLs carry it explicitly.
 */
export interface ParsedInviteUri {
    rawHost: string;
    hostname: string;
    port: number;
    wsUrl: string;
    httpOrigin: string;
    networkId: string;
    joinKey?: string;
    defaultTls: boolean;
}
export declare const PEER_INVITE_DEFAULT_PORT = 19393;
export declare function isLoopbackOrPrivateHostname(hostname: string): boolean;
/**
 * Parse an invite URI. Returns `null` for ANY malformed input — never
 * throws, because the string arrives from QR codes, copy-paste, and other
 * users. Blank runs are trimmed; schemes are matched case-insensitively;
 * the networkId may be mixed-case hex and is normalized to lowercase; the
 * joinKey is percent-decoded when it decodes, kept raw when it does not.
 */
export declare function parseInviteUri(input: string): ParsedInviteUri | null;
/** Build an invite URI (the inverse of {@link parseInviteUri}). Throws on malformed params — the caller composes it from its own validated state. */
export declare function formatInviteUri(params: {
    host: string;
    networkId: string;
    joinKey?: string;
    scheme?: 'zr-net' | 'zr-nets' | 'zr-net+insecure';
}): string;
export type ParsedGatewayJoinInput = {
    kind: 'invite';
    inviteUri: string;
    parsed: ParsedInviteUri;
} | {
    kind: 'gateway';
    rawHost: string;
    hostname: string;
    port: number;
    schemeMode: 'http' | 'https' | 'auto';
    networkId?: string;
};
/**
 * Parse user input for joining a peer network: either a full `zr-net://...`
 * invite URI OR a gateway address (`http://host[:port]`, `https://host[:port]`,
 * `ws(s)://...`, or bare `host[:port]` defaulting to port 19393, optionally
 * carrying `/<16-hex-networkId>`) for gateway-side manual approval.
 */
export declare function parseGatewayJoinInput(input: string): ParsedGatewayJoinInput | null;
/**
 * Construct a canonical keyless invite URI (`zr-net` / `zr-nets` /
 * `zr-net+insecure`) that round-trips through {@link parseInviteUri} to the
 * exact `tls` transport and `rawHost:port`.
 */
export declare function buildKeylessInviteUri(params: {
    rawHost: string;
    hostname: string;
    port: number;
    tls: boolean;
    networkId: string;
}): string;
/** Sign one gateway admission challenge with the node's long-term identity (64-byte signature → 128 hex). */
export declare function signGatewayChallenge(params: {
    privateKeyHex: string;
    publicKeyHex: string;
    challengeHex: string;
    networkId: string;
    nodeId: string;
    timestamp: number;
}): string;
/**
 * Verify a gateway admission signature. The nodeId/publicKey self-
 * certification is checked BEFORE any signature math, so an identity
 * whose id is not the hash of its key is refused outright. Malformed
 * inputs answer `false` — verification is a boundary, it never throws.
 */
export declare function verifyGatewayChallenge(params: {
    publicKeyHex: string;
    challengeHex: string;
    networkId: string;
    nodeId: string;
    timestamp: number;
    signatureHex: string;
}): boolean;
/**
 * Prove knowledge of the invite join key WITHOUT sending it:
 * HMAC-SHA256(key = joinKey bytes) over the domain-separated challenge
 * context. The gateway recomputes from the join key it holds.
 */
export declare function computeJoinKeyProof(params: {
    joinKey: string;
    challengeHex: string;
    networkId: string;
    nodeId: string;
}): string;
/** Constant-time verification of {@link computeJoinKeyProof} output; malformed input answers `false`. */
export declare function verifyJoinKeyProof(params: {
    joinKey: string;
    challengeHex: string;
    networkId: string;
    nodeId: string;
    proofHex: string;
}): boolean;
export interface PeerEphemeralKeyPair {
    /** 32-byte raw X25519 public key, 64 lowercase hex chars. */
    publicKeyHex: string;
    /** 32-byte raw X25519 private key, 64 lowercase hex chars. */
    privateKeyHex: string;
}
/** Generate one ephemeral X25519 key pair for a PFS session (nondeterministic). */
export declare function generateEphemeralX25519(): PeerEphemeralKeyPair;
export interface PeerHandshakeMessageParams {
    role: 'hello' | 'ack';
    networkId: string;
    srcNodeId: string;
    dstNodeId: string;
    srcEphPubHex: string;
    dstEphPubHex: string;
    timestamp: number;
}
/**
 * Sign one peer handshake message (hello or ack) with the long-term
 * identity, binding it to the network, both node ids, BOTH ephemeral
 * public keys and the timestamp — a replayed or substituted ephemeral
 * key breaks the signature.
 */
export declare function signPeerHandshake(params: PeerHandshakeMessageParams & {
    identityPrivateKeyHex: string;
    identityPublicKeyHex: string;
}): string;
/** Verify a peer handshake; the srcNodeId must be self-certifying for the presented identity. Never throws. */
export declare function verifyPeerHandshake(params: PeerHandshakeMessageParams & {
    identityPublicKeyHex: string;
    signatureHex: string;
}): boolean;
/** One direction of a peer session: seal on the transmit key, open (with its own replay window) on the receive key. */
export interface PeerDirectionCiphers {
    /**
     * Encrypt `plaintext` bound to the 28-byte frame header as AAD.
     * Returns `ciphertext || tag(16B)`. The seq selects the nonce and MUST
     * equal the seq in `header28` — the caller (wire.ts) assembles both.
     */
    seal(header28: Uint8Array, plaintext: Uint8Array, seq: bigint): Uint8Array;
    /**
     * Open a `ciphertext || tag` payload under the same header/seq.
     * Returns the plaintext or `null` for: replayed/too-old seqs (precheck),
     * any AEAD failure, malformed input. The window advances only on
     * success. Never throws.
     */
    open(header28: Uint8Array, sealedPayload: Uint8Array, seq: bigint): Uint8Array | null;
}
/** Both directions of one peer session plus the raw key material for tests/telemetry. */
export interface PeerSessionCiphers extends PeerDirectionCiphers {
    /** The `myNodeId -> peerNodeId` key: what `seal` encrypts with. */
    txKeyHex: string;
    /** The `peerNodeId -> myNodeId` key: what `open` decrypts with. */
    rxKeyHex: string;
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
export declare function derivePeerSessionCiphers(params: {
    networkId: string;
    myNodeId: string;
    peerNodeId: string;
    myEphPrivateKeyHex: string;
    myEphPublicKeyHex: string;
    peerEphPublicKeyHex: string;
}): PeerSessionCiphers;
//# sourceMappingURL=crypto.d.ts.map