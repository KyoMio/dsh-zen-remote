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
 * - `zr-net+insecure://` explicitly selects plaintext for gateways without TLS;
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
    nonce: string;
    timestamp: number;
}
/**
 * Sign one peer handshake message (hello or ack) with the long-term
 * identity, binding it to the network, both node ids, BOTH ephemeral
 * public keys, the challenge nonce and the timestamp — a replayed or
 * substituted ephemeral key or nonce breaks the signature.
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
/** HELLO 里「应答方临时钥未知」的显式占位：64 个 '0'，是 v2 串中的普通 hex 字段。 */
export declare const PEER_HS_ZERO_EPH_PUB: string;
export interface PeerHandshakeEnvelopeParams {
    kind: 'hello' | 'ack';
    networkId: string;
    identity: PeerIdentityKeyPair;
    /** 本端一次性 X25519 公钥（= v2 串的 srcEphPubHex）。 */
    selfEphPubHex: string;
    /** 本信封指名的对端 nodeId（HELLO=应答方；ACK=被应答的发起方）。 */
    peerNodeId: string;
    /**
     * HELLO 必须传 `null`（函数内落零占位——调用方没有机会「假装已知」）；
     * ACK 必须传被应答 HELLO 的临时钥原样值。
     */
    peerEphPubHex: string | null;
    nonce: string;
    timestamp: number;
}
/**
 * 构造 v2 握手信封（HELLO/ACK 通吃）：全部字段纳入 `zr-peer-hs-v2` 单一签名
 * `sigHex`，并带 `hs: 2` 版本标记。
 */
export declare function buildPeerHandshakeEnvelope(params: PeerHandshakeEnvelopeParams): Buffer;
export interface PeerHandshakeEnvelopeParseOptions {
    /** 本机网络的 16 hex id；信封 networkId 必须与之完全相等（含大小写）。 */
    networkId: string;
    /** 本机 nodeId：拒绝自源信封，并作为 v2 信封指名对象（peerNodeId）的核对基准。 */
    selfNodeId: string;
    nowMs: number;
    /**
     * 时间戳新鲜度窗半宽（毫秒）。WS 中转路径传 30_000（既有值不变）；UDP 打洞
     * 路径传 0 = 不检查新鲜度（timestamp 只进签名）。
     */
    timeWindowMs: number;
}
export interface ParsedPeerHandshakeEnvelope {
    kind: 'hello' | 'ack';
    networkId: string;
    /** 发送方 nodeId（小写化；自证明绑定已核验）。 */
    nodeId: string;
    /** 发送方长期 Ed25519 公钥（小写化）。 */
    publicKeyHex: string;
    /** 发送方一次性 X25519 公钥（小写化）。 */
    ephPubHex: string;
    /** 16 位挑战 nonce（小写化）。 */
    nonce: string;
    timestamp: number;
    /** 指名对象（恒等于接收方本机 nodeId，小写化）。 */
    peerNodeId: string;
    /** HELLO 的零占位 / ACK 回绑的发起方临时钥（小写化）。 */
    peerEphPubHex: string;
}
/**
 * 解析并验证一个 v2 握手信封（UDP 数据报与 WS 中转帧共用；WS 侧补零在函数内
 * 剥除）。返回 null 的情形：JSON/形状坏、缺 `hs: 2`、networkId 不符、自源或
 * 非指名本机、nodeId 非自证明、HELLO/ACK 对端临时钥占位不符、时间窗外（仅当
 * `timeWindowMs > 0`），或 `zr-peer-hs-v2` 验签失败——绝不降级。从不抛异常。
 */
export declare function parsePeerHandshakeEnvelope(bytes: Uint8Array, options: PeerHandshakeEnvelopeParseOptions): ParsedPeerHandshakeEnvelope | null;
//# sourceMappingURL=crypto.d.ts.map