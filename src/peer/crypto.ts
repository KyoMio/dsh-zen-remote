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

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'

// -- shared hex plumbing ---------------------------------------------------------

const LOWER_HEX = /^[0-9a-f]+$/
/** 8 lowercase hex chars — the `nodeId` shape everywhere. */
const NODE_ID_PATTERN = /^[0-9a-f]{8}$/
/** 16 lowercase hex chars (either case accepted on input) — the `networkId` shape. */
const NETWORK_ID_PATTERN = /^[0-9a-fA-F]{16}$/

/** Validate `value` as exactly `bytes` bytes of hex (any case) and return it lowercased. */
function requireHex(value: unknown, bytes: number, name: string): string {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !LOWER_HEX.test(value.toLowerCase())) {
    throw new TypeError(`${name} must be ${bytes * 2} hex characters (${bytes} bytes)`)
  }
  return value.toLowerCase()
}

function requireNodeId(value: unknown, name: string): string {
  return requireHex(value, 4, name)
}

function requireNetworkId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !NETWORK_ID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be 16 hex characters`)
  }
  return value.toLowerCase()
}

/** A hex string of arbitrary even length ≥ 2 (challenge material), lowercased. */
function requireChallengeHex(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0 || !LOWER_HEX.test(value.toLowerCase())) {
    throw new TypeError(`${name} must be a non-empty even-length hex string`)
  }
  return value.toLowerCase()
}

function requireTimestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer number of milliseconds`)
  }
  return value
}

/** Zero-copy Buffer view over any Uint8Array (wire frames arrive as views). */
function asBufferView(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Decode a validated 32-byte raw hex key into bytes. */
function rawKeyBytes(hex: string): Buffer {
  return Buffer.from(hex, 'hex')
}

// -- 1. Ed25519 identity ---------------------------------------------------------

export interface PeerIdentityKeyPair {
  /** 32-byte raw Ed25519 public key, 64 lowercase hex chars. */
  publicKeyHex: string
  /** 32-byte raw Ed25519 private seed, 64 lowercase hex chars. */
  privateKeyHex: string
  /** `sha256(publicKeyHex bytes)` first 8 hex chars — self-certifying node id. */
  nodeId: string
}

function ed25519PublicFromRaw(publicKeyHex: string): KeyObject {
  // JWK round-trip is the only raw↔KeyObject path node:crypto offers for
  // OKP keys; `x` is the 32-byte raw public key in base64url.
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: rawKeyBytes(publicKeyHex).toString('base64url') },
    format: 'jwk',
  })
}

function ed25519PrivateFromRaw(publicKeyHex: string, privateKeyHex: string): KeyObject {
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
  })
}

/** Generate a fresh long-term node identity (crypto-secure, nondeterministic). */
export function generatePeerIdentity(): PeerIdentityKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string }
  const seedJwk = privateKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; d: string }
  const publicKeyHex = Buffer.from(jwk.x, 'base64url').toString('hex')
  const privateKeyHex = Buffer.from(seedJwk.d, 'base64url').toString('hex')
  return { publicKeyHex, privateKeyHex, nodeId: deriveNodeIdFromPublicKey(publicKeyHex) }
}

/**
 * The self-certifying nodeId for one raw 32-byte public key:
 * `sha256(key bytes)` truncated to 8 lowercase hex chars (32 bits).
 */
export function deriveNodeIdFromPublicKey(publicKeyHex: string): string {
  const raw = requireHex(publicKeyHex, 32, 'publicKeyHex')
  return createHash('sha256').update(Buffer.from(raw, 'hex')).digest('hex').slice(0, 8)
}

/**
 * True iff `nodeId` is a well-formed 8-hex id AND is exactly the hash of
 * `publicKeyHex` — the whole PKI of the peer network in one line.
 */
export function verifySelfCertifyingNodeId(nodeId: string, publicKeyHex: string): boolean {
  if (typeof nodeId !== 'string' || !NODE_ID_PATTERN.test(nodeId)) return false
  if (typeof publicKeyHex !== 'string') return false
  try {
    return deriveNodeIdFromPublicKey(publicKeyHex) === nodeId
  } catch {
    return false
  }
}

// -- 2. invite URIs ---------------------------------------------------------------

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
  rawHost: string
  hostname: string
  port: number
  wsUrl: string
  httpOrigin: string
  networkId: string
  joinKey?: string
  defaultTls: boolean
}

export const PEER_INVITE_DEFAULT_PORT = 19393

const INVITE_SCHEME_PATTERN = /^(zr-net\+insecure|zr-nets|zr-net):\/\//
/** Plain hostname: letters/digits/dots/hyphens/underscores, no colons (IPv6 must be bracketed). */
const HOSTNAME_PATTERN = /^[A-Za-z0-9._\-]+$/
const BRACKETED_IPV6_PATTERN = /^\[[0-9A-Fa-f:.]+\]$/
const PORT_PATTERN = /^\d+$/

export function isLoopbackOrPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = v4.slice(1).map((part) => Number(part))
    if (a > 255 || b > 255) return false // other octets checked by shape only — inference, not routing
    if (a === 127 || a === 10) return true // loopback, RFC1918 10/8
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true // link-local
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10 (Tailscale)
    return false
  }
  if (h === '::1') return true
  if (h.startsWith('fc') || h.startsWith('fd')) return true // IPv6 ULA fc00::/7
  if (h.startsWith('fe80')) return true // IPv6 link-local
  return false
}

/**
 * Split the invite authority into (rawHost, hostname, port). `null` for
 * anything malformed: unclosed brackets, empty host, port 0/65536+/non-
 * numeric, or unbracketed multi-colon IPv6 (ambiguous with host:port —
 * rejected, never guessed).
 */
function parseInviteAuthority(authority: string, defaultPort: number = PEER_INVITE_DEFAULT_PORT): { rawHost: string; hostname: string; port: number } | null {
  let rawHost: string
  let portPart: string | undefined
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']')
    if (close === -1) return null
    rawHost = authority.slice(0, close + 1)
    const rest = authority.slice(close + 1)
    if (rest !== '') {
      if (!rest.startsWith(':')) return null
      portPart = rest.slice(1)
    }
    const inner = rawHost.slice(1, -1)
    if (inner.length === 0 || !BRACKETED_IPV6_PATTERN.test(rawHost)) return null
    return { rawHost, hostname: inner.toLowerCase(), port: parsePortOr(portPart, defaultPort) }
  }
  const colons = authority.split(':').length - 1
  if (colons > 1) return null // unbracketed IPv6 — ambiguous, reject
  if (colons === 1) {
    const colon = authority.indexOf(':')
    rawHost = authority.slice(0, colon)
    portPart = authority.slice(colon + 1)
  } else {
    rawHost = authority
  }
  if (rawHost.length === 0 || !HOSTNAME_PATTERN.test(rawHost)) return null
  return { rawHost, hostname: rawHost.toLowerCase(), port: parsePortOr(portPart, defaultPort) }
}

function parsePortOr(portPart: string | undefined, defaultPort: number = PEER_INVITE_DEFAULT_PORT): number {
  // Only a fully ABSENT `:port` falls back to the default; an explicit
  // empty port (`host:/id`) is malformed, never guessed.
  if (portPart === undefined) return defaultPort
  if (!PORT_PATTERN.test(portPart)) return -1 // sentinel: invalid, caught by the caller's range check
  return Number(portPart)
}

/**
 * Parse an invite URI. Returns `null` for ANY malformed input — never
 * throws, because the string arrives from QR codes, copy-paste, and other
 * users. Blank runs are trimmed; schemes are matched case-insensitively;
 * the networkId may be mixed-case hex and is normalized to lowercase; the
 * joinKey is percent-decoded when it decodes, kept raw when it does not.
 */
export function parseInviteUri(input: string): ParsedInviteUri | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  const schemeMatch = INVITE_SCHEME_PATTERN.exec(trimmed)
  if (!schemeMatch) return null
  const scheme = schemeMatch[1].toLowerCase()
  const rest = trimmed.slice(schemeMatch[0].length)
  const slash = rest.indexOf('/')
  if (slash === -1) return null
  const authority = rest.slice(0, slash)
  const tail = rest.slice(slash + 1)
  if (authority.length === 0) return null
  const address = parseInviteAuthority(authority)
  if (!address || address.port < 1 || address.port > 65535) return null
  // tail = `<networkId>[#<joinKey>]` — no further path segments allowed.
  const hash = tail.indexOf('#')
  const networkIdPart = hash === -1 ? tail : tail.slice(0, hash)
  const joinKeyPart = hash === -1 ? undefined : tail.slice(hash + 1)
  if (!NETWORK_ID_PATTERN.test(networkIdPart)) return null
  const networkId = networkIdPart.toLowerCase()
  let joinKey: string | undefined
  if (joinKeyPart !== undefined && joinKeyPart !== '') {
    try {
      joinKey = decodeURIComponent(joinKeyPart)
    } catch {
      joinKey = joinKeyPart // keep the raw string; never lose a key to a stray '%'
    }
  }
  const defaultTls = scheme === 'zr-nets'
    ? true
    : scheme === 'zr-net+insecure'
      ? false
      : !isLoopbackOrPrivateHostname(address.hostname)
  return {
    rawHost: address.rawHost,
    hostname: address.hostname,
    port: address.port,
    networkId,
    joinKey,
    defaultTls,
    wsUrl: `${defaultTls ? 'wss' : 'ws'}://${address.rawHost}:${address.port}`,
    httpOrigin: `${defaultTls ? 'https' : 'http'}://${address.rawHost}:${address.port}`,
  }
}

/** Build an invite URI (the inverse of {@link parseInviteUri}). Throws on malformed params — the caller composes it from its own validated state. */
export function formatInviteUri(params: {
  host: string
  networkId: string
  joinKey?: string
  scheme?: 'zr-net' | 'zr-nets' | 'zr-net+insecure'
}): string {
  const scheme = params.scheme ?? 'zr-net'
  if (scheme !== 'zr-net' && scheme !== 'zr-nets' && scheme !== 'zr-net+insecure') {
    throw new TypeError(`unknown invite scheme: ${String(params.scheme)}`)
  }
  const host = params.host
  const bracketed = typeof host === 'string' && host.startsWith('[') && BRACKETED_IPV6_PATTERN.test(host)
  if (typeof host !== 'string' || host.length === 0 || (!bracketed && !HOSTNAME_PATTERN.test(host))) {
    throw new TypeError('host must be a plain hostname or a bracketed IPv6 address')
  }
  const networkId = requireNetworkId(params.networkId, 'networkId')
  const fragment = params.joinKey === undefined || params.joinKey === '' ? '' : `#${encodeURIComponent(params.joinKey)}`
  return `${scheme}://${host}/${networkId}${fragment}`
}

export type ParsedGatewayJoinInput =
  | { kind: 'invite'; inviteUri: string; parsed: ParsedInviteUri }
  | {
      kind: 'gateway'
      rawHost: string
      hostname: string
      port: number
      schemeMode: 'http' | 'https' | 'auto'
      networkId?: string
    }

const GATEWAY_URL_SCHEME_PATTERN = /^(https?|wss?):\/\//i

/**
 * Parse user input for joining a peer network: either a full `zr-net://...`
 * invite URI OR a gateway address (`http://host[:port]`, `https://host[:port]`,
 * `ws(s)://...`, or bare `host[:port]` defaulting to port 19393, optionally
 * carrying `/<16-hex-networkId>`) for gateway-side manual approval.
 */
export function parseGatewayJoinInput(input: string): ParsedGatewayJoinInput | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed === '') return null

  const asInvite = parseInviteUri(trimmed)
  if (asInvite !== null) {
    return { kind: 'invite', inviteUri: trimmed, parsed: asInvite }
  }

  // Reject unknown schemes (e.g. `ftp://`, malformed `zr-net://` missing networkId).
  const schemeMatch = GATEWAY_URL_SCHEME_PATTERN.exec(trimmed)
  if (!schemeMatch && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    return null
  }

  let schemeMode: 'http' | 'https' | 'auto' = 'auto'
  let defaultPort = PEER_INVITE_DEFAULT_PORT
  let rest = trimmed
  if (schemeMatch) {
    const proto = schemeMatch[1].toLowerCase()
    const isTls = proto === 'https' || proto === 'wss'
    schemeMode = isTls ? 'https' : 'http'
    defaultPort = isTls ? 443 : 80
    rest = trimmed.slice(schemeMatch[0].length)
  }

  // Strip empty trailing `#` (common when copying console SPA URLs), reject non-empty query/hash.
  if (rest.includes('?')) return null
  const hashIdx = rest.indexOf('#')
  if (hashIdx !== -1) {
    if (rest.slice(hashIdx + 1).trim() !== '') return null
    rest = rest.slice(0, hashIdx)
  }

  const slashIdx = rest.indexOf('/')
  const authority = slashIdx === -1 ? rest : rest.slice(0, slashIdx)
  let pathPart = slashIdx === -1 ? '' : rest.slice(slashIdx + 1)
  if (authority === '') return null

  const address = parseInviteAuthority(authority, defaultPort)
  if (!address || address.port < 1 || address.port > 65535) return null

  pathPart = pathPart.replace(/\/+$/u, '')
  if (pathPart.toLowerCase() === 'peer/v1/ws') {
    pathPart = ''
  }
  let networkId: string | undefined
  if (pathPart !== '') {
    if (!NETWORK_ID_PATTERN.test(pathPart)) return null
    networkId = pathPart.toLowerCase()
  }

  return {
    kind: 'gateway',
    rawHost: address.rawHost,
    hostname: address.hostname,
    port: address.port,
    schemeMode,
    ...(networkId !== undefined ? { networkId } : {}),
  }
}

/**
 * Construct a canonical keyless invite URI (`zr-net` / `zr-nets` /
 * `zr-net+insecure`) that round-trips through {@link parseInviteUri} to the
 * exact `tls` transport and `rawHost:port`.
 */
export function buildKeylessInviteUri(params: {
  rawHost: string
  hostname: string
  port: number
  tls: boolean
  networkId: string
}): string {
  const networkId = requireNetworkId(params.networkId, 'networkId')
  const isPrivate = isLoopbackOrPrivateHostname(params.hostname)
  const scheme: 'zr-net' | 'zr-nets' | 'zr-net+insecure' = params.tls
    ? (isPrivate ? 'zr-nets' : 'zr-net')
    : (isPrivate ? 'zr-net' : 'zr-net+insecure')
  return `${scheme}://${params.rawHost}:${params.port}/${networkId}`
}

// -- 3. gateway challenge + join-key proof -----------------------------------------

const GATEWAY_AUTH_DOMAIN = 'zr-gw-auth-v1'
const JOIN_PROOF_DOMAIN = 'zr-join-v1'

interface GatewayChallengeMessageParams {
  networkId: string
  nodeId: string
  challengeHex: string
  timestamp: number
}

/** The canonical byte string both gateway sides sign/verify over. */
function gatewayAuthMessage(params: GatewayChallengeMessageParams): Buffer {
  const networkId = requireNetworkId(params.networkId, 'networkId')
  const nodeId = requireHex(params.nodeId, 4, 'nodeId')
  const challengeHex = requireChallengeHex(params.challengeHex, 'challengeHex')
  const timestamp = requireTimestamp(params.timestamp, 'timestamp')
  return Buffer.from(`${GATEWAY_AUTH_DOMAIN}|${networkId}|${nodeId}|${challengeHex}|${timestamp}`, 'utf8')
}

/** Sign one gateway admission challenge with the node's long-term identity (64-byte signature → 128 hex). */
export function signGatewayChallenge(params: {
  privateKeyHex: string
  publicKeyHex: string
  challengeHex: string
  networkId: string
  nodeId: string
  timestamp: number
}): string {
  const privateKey = ed25519PrivateFromRaw(
    requireHex(params.publicKeyHex, 32, 'publicKeyHex'),
    requireHex(params.privateKeyHex, 32, 'privateKeyHex'),
  )
  const message = gatewayAuthMessage(params)
  return sign(null, message, privateKey).toString('hex')
}

/**
 * Verify a gateway admission signature. The nodeId/publicKey self-
 * certification is checked BEFORE any signature math, so an identity
 * whose id is not the hash of its key is refused outright. Malformed
 * inputs answer `false` — verification is a boundary, it never throws.
 */
export function verifyGatewayChallenge(params: {
  publicKeyHex: string
  challengeHex: string
  networkId: string
  nodeId: string
  timestamp: number
  signatureHex: string
}): boolean {
  if (!verifySelfCertifyingNodeId(params.nodeId, params.publicKeyHex)) return false
  if (typeof params.signatureHex !== 'string' || !LOWER_HEX.test(params.signatureHex.toLowerCase())
    || params.signatureHex.length !== 128) return false
  if (typeof params.timestamp !== 'number' || !Number.isInteger(params.timestamp)) return false
  try {
    const message = gatewayAuthMessage(params)
    const publicKey = ed25519PublicFromRaw(requireHex(params.publicKeyHex, 32, 'publicKeyHex'))
    return verify(null, message, publicKey, Buffer.from(params.signatureHex, 'hex'))
  } catch {
    return false
  }
}

function joinKeyProofMessage(params: { networkId: string; nodeId: string; challengeHex: string }): Buffer {
  const networkId = requireNetworkId(params.networkId, 'networkId')
  const nodeId = requireHex(params.nodeId, 4, 'nodeId')
  const challengeHex = requireChallengeHex(params.challengeHex, 'challengeHex')
  return Buffer.from(`${JOIN_PROOF_DOMAIN}|${networkId}|${nodeId}|${challengeHex}`, 'utf8')
}

/**
 * Prove knowledge of the invite join key WITHOUT sending it:
 * HMAC-SHA256(key = joinKey bytes) over the domain-separated challenge
 * context. The gateway recomputes from the join key it holds.
 */
export function computeJoinKeyProof(params: {
  joinKey: string
  challengeHex: string
  networkId: string
  nodeId: string
}): string {
  if (typeof params.joinKey !== 'string') throw new TypeError('joinKey must be a string')
  const message = joinKeyProofMessage(params)
  return createHmac('sha256', Buffer.from(params.joinKey, 'utf8')).update(message).digest('hex')
}

/** Constant-time verification of {@link computeJoinKeyProof} output; malformed input answers `false`. */
export function verifyJoinKeyProof(params: {
  joinKey: string
  challengeHex: string
  networkId: string
  nodeId: string
  proofHex: string
}): boolean {
  if (typeof params.joinKey !== 'string') return false
  if (typeof params.proofHex !== 'string' || params.proofHex.length !== 64 || !LOWER_HEX.test(params.proofHex.toLowerCase())) return false
  try {
    const actual = createHmac('sha256', Buffer.from(params.joinKey, 'utf8')).update(joinKeyProofMessage(params)).digest()
    return timingSafeEqual(actual, Buffer.from(params.proofHex.toLowerCase(), 'hex'))
  } catch {
    return false
  }
}

// -- 4. PFS handshake + dual-simplex AEAD ------------------------------------------

const PEER_HS_DOMAIN = 'zr-peer-hs-v1'
/** HKDF salt carries the canonical (low,high) node pair + their ephemeral keys; info splits the output. */
const PEER_KDF_SALT_DOMAIN = 'zr-peer-kdf-v1'
const PEER_KDF_INFO = Buffer.from('zr-peer-txrx-v1', 'utf8')
const KEY_BYTES = 32
const PEER_KDF_OUTPUT_BYTES = 64
const REPLAY_WINDOW_BITS = 64n
const REPLAY_WINDOW_MASK = (1n << REPLAY_WINDOW_BITS) - 1n
/** seq is a u64: nonce = 4 zero bytes + big-endian seq (12 bytes total for aes-256-gcm). */
const SEQ_MAX = (1n << 64n) - 1n
const HEADER_BYTES = 28
const AEAD_TAG_BYTES = 16

export interface PeerEphemeralKeyPair {
  /** 32-byte raw X25519 public key, 64 lowercase hex chars. */
  publicKeyHex: string
  /** 32-byte raw X25519 private key, 64 lowercase hex chars. */
  privateKeyHex: string
}

function x25519PublicFromRaw(publicKeyHex: string): KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: rawKeyBytes(publicKeyHex).toString('base64url') },
    format: 'jwk',
  })
}

function x25519PrivateFromRaw(publicKeyHex: string, privateKeyHex: string): KeyObject {
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'X25519',
      x: rawKeyBytes(publicKeyHex).toString('base64url'),
      d: rawKeyBytes(privateKeyHex).toString('base64url'),
    },
    format: 'jwk',
  })
}

/** Generate one ephemeral X25519 key pair for a PFS session (nondeterministic). */
export function generateEphemeralX25519(): PeerEphemeralKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string }
  const privJwk = privateKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; d: string }
  return {
    publicKeyHex: Buffer.from(jwk.x, 'base64url').toString('hex'),
    privateKeyHex: Buffer.from(privJwk.d, 'base64url').toString('hex'),
  }
}

export interface PeerHandshakeMessageParams {
  role: 'hello' | 'ack'
  networkId: string
  srcNodeId: string
  dstNodeId: string
  srcEphPubHex: string
  dstEphPubHex: string
  timestamp: number
}

function peerHandshakeMessage(params: PeerHandshakeMessageParams): Buffer {
  if (params.role !== 'hello' && params.role !== 'ack') {
    throw new TypeError(`role must be 'hello' or 'ack', got ${String(params.role)}`)
  }
  const networkId = requireNetworkId(params.networkId, 'networkId')
  const srcNodeId = requireHex(params.srcNodeId, 4, 'srcNodeId')
  const dstNodeId = requireHex(params.dstNodeId, 4, 'dstNodeId')
  const srcEphPubHex = requireHex(params.srcEphPubHex, 32, 'srcEphPubHex')
  // `hello` carries the all-zero placeholder before the peer's ephemeral
  // key is known; it is an ordinary hex field here, not a special case.
  const dstEphPubHex = requireHex(params.dstEphPubHex, 32, 'dstEphPubHex')
  const timestamp = requireTimestamp(params.timestamp, 'timestamp')
  return Buffer.from(
    `${PEER_HS_DOMAIN}|${params.role}|${networkId}|${srcNodeId}|${dstNodeId}|${srcEphPubHex}|${dstEphPubHex}|${timestamp}`,
    'utf8',
  )
}

/**
 * Sign one peer handshake message (hello or ack) with the long-term
 * identity, binding it to the network, both node ids, BOTH ephemeral
 * public keys and the timestamp — a replayed or substituted ephemeral
 * key breaks the signature.
 */
export function signPeerHandshake(params: PeerHandshakeMessageParams & {
  identityPrivateKeyHex: string
  identityPublicKeyHex: string
}): string {
  const privateKey = ed25519PrivateFromRaw(
    requireHex(params.identityPublicKeyHex, 32, 'identityPublicKeyHex'),
    requireHex(params.identityPrivateKeyHex, 32, 'identityPrivateKeyHex'),
  )
  const message = peerHandshakeMessage(params)
  return sign(null, message, privateKey).toString('hex')
}

/** Verify a peer handshake; the srcNodeId must be self-certifying for the presented identity. Never throws. */
export function verifyPeerHandshake(params: PeerHandshakeMessageParams & {
  identityPublicKeyHex: string
  signatureHex: string
}): boolean {
  if (!verifySelfCertifyingNodeId(params.srcNodeId, params.identityPublicKeyHex)) return false
  if (typeof params.signatureHex !== 'string' || params.signatureHex.length !== 128
    || !LOWER_HEX.test(params.signatureHex.toLowerCase())) return false
  if (typeof params.timestamp !== 'number' || !Number.isInteger(params.timestamp)) return false
  try {
    const message = peerHandshakeMessage(params)
    const publicKey = ed25519PublicFromRaw(requireHex(params.identityPublicKeyHex, 32, 'identityPublicKeyHex'))
    return verify(null, message, publicKey, Buffer.from(params.signatureHex, 'hex'))
  } catch {
    return false
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
  private highest: bigint | null = null
  /** Bit `i` set = `highest - i` was received (i in 0..63). */
  private bits = 0n

  admit(seq: bigint): boolean {
    if (this.highest === null) return true
    if (seq > this.highest) return true
    const delta = this.highest - seq
    if (delta >= REPLAY_WINDOW_BITS) return false
    return ((this.bits >> delta) & 1n) === 0n
  }

  commit(seq: bigint): void {
    if (this.highest === null) {
      this.highest = seq
      this.bits = 1n
      return
    }
    if (seq > this.highest) {
      const shift = seq - this.highest
      this.bits = (shift >= REPLAY_WINDOW_BITS ? 0n : (this.bits << shift) & REPLAY_WINDOW_MASK) | 1n
      this.highest = seq
      return
    }
    this.bits |= 1n << (this.highest - seq)
  }
}

/** One direction of a peer session: seal on the transmit key, open (with its own replay window) on the receive key. */
export interface PeerDirectionCiphers {
  /**
   * Encrypt `plaintext` bound to the 28-byte frame header as AAD.
   * Returns `ciphertext || tag(16B)`. The seq selects the nonce and MUST
   * equal the seq in `header28` — the caller (wire.ts) assembles both.
   */
  seal(header28: Uint8Array, plaintext: Uint8Array, seq: bigint): Uint8Array
  /**
   * Open a `ciphertext || tag` payload under the same header/seq.
   * Returns the plaintext or `null` for: replayed/too-old seqs (precheck),
   * any AEAD failure, malformed input. The window advances only on
   * success. Never throws.
   */
  open(header28: Uint8Array, sealedPayload: Uint8Array, seq: bigint): Uint8Array | null
}

/** Both directions of one peer session plus the raw key material for tests/telemetry. */
export interface PeerSessionCiphers extends PeerDirectionCiphers {
  /** The `myNodeId -> peerNodeId` key: what `seal` encrypts with. */
  txKeyHex: string
  /** The `peerNodeId -> myNodeId` key: what `open` decrypts with. */
  rxKeyHex: string
}

function requireSeq(seq: unknown, name: string): bigint {
  if (typeof seq !== 'bigint' || seq < 0n || seq > SEQ_MAX) {
    throw new TypeError(`${name} must be a bigint in [0, 2^64)`)
  }
  return seq
}

function nonceFor(seq: bigint): Buffer {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64BE(seq, 4)
  return nonce
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
export function derivePeerSessionCiphers(params: {
  networkId: string
  myNodeId: string
  peerNodeId: string
  myEphPrivateKeyHex: string
  myEphPublicKeyHex: string
  peerEphPublicKeyHex: string
}): PeerSessionCiphers {
  const networkId = requireNetworkId(params.networkId, 'networkId')
  const myNodeId = requireNodeId(params.myNodeId, 'myNodeId')
  const peerNodeId = requireNodeId(params.peerNodeId, 'peerNodeId')
  const myEphPrivateKeyHex = requireHex(params.myEphPrivateKeyHex, 32, 'myEphPrivateKeyHex')
  const myEphPublicKeyHex = requireHex(params.myEphPublicKeyHex, 32, 'myEphPublicKeyHex')
  const peerEphPublicKeyHex = requireHex(params.peerEphPublicKeyHex, 32, 'peerEphPublicKeyHex')
  const shared = diffieHellman({
    privateKey: x25519PrivateFromRaw(myEphPublicKeyHex, myEphPrivateKeyHex),
    publicKey: x25519PublicFromRaw(peerEphPublicKeyHex),
  })
  if (shared.length !== KEY_BYTES) throw new Error('X25519 shared secret has unexpected length')
  // An all-zero shared secret means a degenerate/low-order peer key —
  // refuse rather than derive a key an attacker could also derive.
  if (shared.every((byte) => byte === 0)) throw new Error('X25519 shared secret is all zeros (low-order peer key)')
  const [lowId, highId] = [myNodeId, peerNodeId].sort()
  const lowPub = myNodeId === lowId ? myEphPublicKeyHex : peerEphPublicKeyHex
  const highPub = myNodeId === lowId ? peerEphPublicKeyHex : myEphPublicKeyHex
  const salt = Buffer.from(`${PEER_KDF_SALT_DOMAIN}|${networkId}|${lowId}|${highId}|${lowPub}|${highPub}`, 'utf8')
  const okm = Buffer.from(hkdfSync('sha256', shared, salt, PEER_KDF_INFO, PEER_KDF_OUTPUT_BYTES))
  // First half = low→high direction, second half = high→low direction.
  const lowToHigh = okm.subarray(0, KEY_BYTES)
  const highToLow = okm.subarray(KEY_BYTES, PEER_KDF_OUTPUT_BYTES)
  const txKey = myNodeId === lowId ? lowToHigh : highToLow
  const rxKey = myNodeId === lowId ? highToLow : lowToHigh
  const txKeyHex = txKey.toString('hex')
  const rxKeyHex = rxKey.toString('hex')
  const rxWindow = new ReplayWindow()

  const requireHeader = (header28: Uint8Array): Buffer => {
    if (!ArrayBuffer.isView(header28) || header28.byteLength !== HEADER_BYTES) {
      throw new TypeError(`header28 must be exactly ${HEADER_BYTES} bytes`)
    }
    return asBufferView(header28)
  }

  return {
    txKeyHex,
    rxKeyHex,
    seal(header28: Uint8Array, plaintext: Uint8Array, seq: bigint): Uint8Array {
      const header = requireHeader(header28)
      requireSeq(seq, 'seq')
      const payload = asBufferView(plaintext)
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(txKeyHex, 'hex'), nonceFor(seq), { authTagLength: AEAD_TAG_BYTES })
      cipher.setAAD(header)
      const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()])
      return Buffer.concat([ciphertext, cipher.getAuthTag()])
    },
    open(header28: Uint8Array, sealedPayload: Uint8Array, seq: bigint): Uint8Array | null {
      let header: Buffer
      try {
        header = requireHeader(header28)
        requireSeq(seq, 'seq')
        const sealed = asBufferView(sealedPayload)
        if (sealed.byteLength < AEAD_TAG_BYTES) return null
        // Replay precheck BEFORE any decryption work: the window stays
        // untouched on every failure path below, so forged junk with a
        // huge seq cannot push `highest` forward.
        if (!rxWindow.admit(seq)) return null
        const tag = sealed.subarray(sealed.byteLength - AEAD_TAG_BYTES)
        const ciphertext = sealed.subarray(0, sealed.byteLength - AEAD_TAG_BYTES)
        const decipher = createDecipheriv('aes-256-gcm', Buffer.from(rxKeyHex, 'hex'), nonceFor(seq), { authTagLength: AEAD_TAG_BYTES })
        decipher.setAAD(header)
        decipher.setAuthTag(tag)
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
        rxWindow.commit(seq)
        return new Uint8Array(plaintext)
      } catch {
        return null
      }
    },
  }
}
