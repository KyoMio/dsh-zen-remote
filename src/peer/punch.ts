/**
 * Peer-gateway UDP path establishment (PG-7, tasks/peer-gateway/PG-7.md).
 * Three pieces, zero third-party deps (node:dgram / node:os / node:crypto
 * plus `./crypto.js` and `./wire.js` only):
 *
 * 1. `collectLanEndpoints()` — enumerate this machine's non-loopback
 *    IPv4 interfaces (RFC1918 plus the 100.64.0.0/10 CGNAT range that
 *    Tailscale uses) as `ip:port` punch candidates.
 *
 * 2. `probeStunNatType()` — NAT self-check against the gateway's two
 *    UDP ports with ONE local socket: the same mapping seen from two
 *    remote ports proves cone (or plain public when the reflexive ip is
 *    one of ours), different mappings prove symmetric NAT, and missing
 *    answers downgrade to `unknown` so the caller plans accordingly.
 *
 * 3. `PeerPunchManager` — the per-peer 1000ms priority hole punch.
 *    When the relay hands us a peer's candidate endpoints we fire
 *    signed HELLO bursts (one per 100ms, at most 10 rounds) at every
 *    candidate with a fresh X25519 key; any valid HELLO is answered
 *    immediately, and the first bidirectional exchange derives
 *    `PeerSessionCiphers` (PG-1 dual-simplex AEAD). The endpoint that
 *    worked is classified `lan` (RFC1918/CGNAT subnet or loopback match
 *    against our own interfaces) or `p2p`, with a measured RTT. If the
 *    1000ms window expires the caller gets `onPunchFallback` — go use
 *    the gateway WS relay NOW — while a silent reprobe keeps retrying
 *    every 60s and hot-upgrades to direct on the first later success.
 *    Established paths are kept alive with 5s encrypted PING/PONG;
 *    `keepAliveLostFrames` (3) consecutive silent cycles declare the
 *    path lost (`onDirectLost`) and re-enter the reprobe cycle.
 *
 * Wire shapes here are JSON control packets (`zr:1`, Ed25519-signed over
 * a domain-separated canonical line) plus PG-1 sealed frames once
 * ciphers exist. All timing goes through an injectable clock so tests
 * drive the state machine deterministically while real sockets do the
 * I/O.
 */

import dgram from 'node:dgram'
import os from 'node:os'
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto'
import type { Socket as DgramSocket } from 'node:dgram'

import { derivePeerSessionCiphers, generateEphemeralX25519, verifySelfCertifyingNodeId } from './crypto.js'
import type { PeerEphemeralKeyPair, PeerIdentityKeyPair, PeerSessionCiphers } from './crypto.js'
import { PeerFrameType, decodeFrameHeader, packEncryptedFrame, unpackEncryptedFrame } from './wire.js'
import type { PeerFrameHeader } from './wire.js'

// -- shared hex/endpoint plumbing --------------------------------------------------

const NODE_ID_PATTERN = /^[0-9a-f]{8}$/
const NETWORK_ID_PATTERN = /^[0-9a-fA-F]{16}$/
const HEX16 = /^[0-9a-fA-F]{16}$/
const HEX64 = /^[0-9a-fA-F]{64}$/
const HEX128 = /^[0-9a-fA-F]{128}$/

/** 打洞/中转握手控制包的域分隔前缀——UDP 与网关 WS 两条路径共用同一形态。 */
export const STUN_PROBE_DOMAIN = 'zr-stun-probe-v1'
export const PUNCH_DOMAIN = 'zr-punch-v1'

/** `os.networkInterfaces()` entries, loosened so hand-built fixtures type-check. */
export interface LanInterfaceInfo {
  address: string
  family: string | number
  internal: boolean
}

function isIPv4Family(family: string | number): boolean {
  return family === 'IPv4' || family === 4
}

function requireNetworkId(value: unknown): string {
  if (typeof value !== 'string' || !NETWORK_ID_PATTERN.test(value)) {
    throw new TypeError('networkId must be 16 hex characters')
  }
  return value.toLowerCase()
}

function requireIdentity(value: unknown): PeerIdentityKeyPair {
  if (!value || typeof value !== 'object') throw new TypeError('identity must be a PeerIdentityKeyPair')
  const record = value as Record<string, unknown>
  if (typeof record.publicKeyHex !== 'string' || !HEX64.test(record.publicKeyHex)) {
    throw new TypeError('identity.publicKeyHex must be 64 hex characters')
  }
  if (typeof record.privateKeyHex !== 'string' || !HEX64.test(record.privateKeyHex)) {
    throw new TypeError('identity.privateKeyHex must be 64 hex characters')
  }
  if (typeof record.nodeId !== 'string' || !NODE_ID_PATTERN.test(record.nodeId)) {
    throw new TypeError('identity.nodeId must be 8 lowercase hex characters')
  }
  return record as unknown as PeerIdentityKeyPair
}

/** Split `host:port` (v4-shaped candidates only; the punch path is udp4). */
function parseEndpoint(endpoint: string): { host: string; port: number } | null {
  if (typeof endpoint !== 'string') return null
  const colon = endpoint.lastIndexOf(':')
  if (colon <= 0 || colon === endpoint.length - 1) return null
  const host = endpoint.slice(0, colon)
  const portPart = endpoint.slice(colon + 1)
  if (!/^\d+$/.test(portPart)) return null
  const port = Number(portPart)
  if (port < 1 || port > 65535) return null
  if (host.length === 0 || /\s/.test(host)) return null
  return { host, port }
}

/**
 * All non-loopback IPv4 addresses of `interfaces` as `ip:port` punch
 * candidates. Loopback (internal flag) and IPv6 are useless for
 * punching; link-local 169.254/16 is excluded too — it never routes.
 * RFC1918 and the 100.64.0.0/10 CGNAT range (Tailscale) are the
 * interesting cases and ride along with any public ips.
 */
export function collectLanEndpoints(
  interfaces: Record<string, ReadonlyArray<LanInterfaceInfo> | undefined>,
  port: number,
): string[] {
  const endpoints: string[] = []
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (!isIPv4Family(entry.family) || entry.internal) continue
      const address = entry.address
      if (typeof address !== 'string' || address.startsWith('127.') || address.startsWith('169.254.')) continue
      endpoints.push(`${address}:${port}`)
    }
  }
  return endpoints
}

/**
 * Which KIND of path does this endpoint represent? `lan` when it is
 * loopback, one of `localIps` exactly, or a private/CGNAT address that
 * shares a /24 with one of our interfaces — i.e. a same-subnet path we
 * can usually reach without any NAT help. Everything else is `p2p`
 * (public reflexive mapping or foreign private nets). Unparseable
 * candidates answer `p2p` — never promoted on a guess.
 */
export function classifyPunchEndpoint(endpoint: string, localIps: string[]): 'lan' | 'p2p' {
  const parsed = parseEndpoint(endpoint)
  if (!parsed) return 'p2p'
  const ip = parsed.host
  if (ip.startsWith('127.')) return 'lan'
  if (localIps.includes(ip)) return 'lan'
  const isPrivate = ip.startsWith('10.')
    || ip.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  const isCgnat = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)
  if (!isPrivate && !isCgnat) return 'p2p'
  const slash24 = (value: string) => value.split('.').slice(0, 3).join('.')
  return localIps.some((local) => slash24(local) === slash24(ip)) ? 'lan' : 'p2p'
}

// -- dual-port STUN self-check ------------------------------------------------------

export type PeerNatType = 'public' | 'cone' | 'symmetric' | 'unknown'

export interface StunProbeResult {
  /** `ip:port` the gateway's PRIMARY port saw, or null when it never answered. */
  reflexiveEndpoint: string | null
  natType: PeerNatType
}

function isReflexiveIpLocal(ip: string): boolean {
  if (ip.startsWith('127.')) return true
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (isIPv4Family(entry.family) && !entry.internal && entry.address === ip) return true
    }
  }
  return false
}

/**
 * NAT self-check against the gateway's primary port and (when
 * `altPort > 0`) its alternate port. Both ports agree → cone NAT
 * (`public` when the reflexive ip is one of this machine's own
 * addresses — no NAT at all). They disagree → symmetric NAT
 * (per-destination mappings; simple hole punching cannot work). Only
 * the primary answers → `unknown`; nothing answers → `unknown` with a
 * null endpoint.
 *
 * **Socket reuse (PG-8, load-bearing)**: pass `socket` to probe from an
 * ALREADY-BOUND socket — the punch layer's own — instead of a throwaway.
 * The gateway records and re-publishes the REFLEXIVE ENDPOINT it saw, and
 * peers punch at that endpoint; only a probe from the punch socket itself
 * makes the recorded port the one peers can actually reach. A probe from a
 * temporary socket would register a port that is closed the moment the
 * probe returns, and every punch at it would fly into the void. When
 * `socket` is given it is NOT bound or closed here — the punch layer keeps
 * owning it; this function attaches its own `message` listener for the
 * probe's lifetime and removes exactly that listener on the way out (the
 * punch manager's own listeners are untouched, and its `handlePacket`
 * silently ignores non-frame `stun-reply` JSON anyway).
 *
 * Wire format (PG-8, aligned with gateway-server's udp-stun.ts): the
 * probe is `{ type:'stun-probe', networkId, nodeId, publicKeyHex, nonce,
 * timestamp, signatureHex }` signed over
 * `zr-stun-probe-v1|<networkId>|<nodeId>|<nonce>|<timestamp>`; the reply
 * is parsed leniently — the gateway's
 * `{ type:'stun-reply', nonce, reflexiveIp, reflexivePort, serverPortRole }`
 * AND the pre-PG-8 node shape `{ kind:'zr-stun-reply', ip, port }` both
 * count, so a node updated ahead of its gateway (or behind it) keeps
 * classifying.
 */
export async function probeStunNatType(options: {
  primaryHost: string
  primaryPort: number
  altPort?: number
  networkId: string
  identity: PeerIdentityKeyPair
  timeoutMs?: number
  /** Reuse an ALREADY-BOUND socket (the punch layer's own). Not closed here. */
  socket?: DgramSocket
}): Promise<StunProbeResult> {
  const primaryHost = options.primaryHost
  if (typeof primaryHost !== 'string' || primaryHost.length === 0) {
    throw new TypeError('primaryHost must be a non-empty string')
  }
  if (!Number.isInteger(options.primaryPort) || (options.primaryPort as number) < 1 || (options.primaryPort as number) > 65535) {
    throw new RangeError('primaryPort must be an integer in [1, 65535]')
  }
  const altPort = options.altPort ?? 0
  if (!Number.isInteger(altPort) || altPort < 0 || altPort > 65535) {
    throw new RangeError('altPort must be an integer in [0, 65535]')
  }
  const networkId = requireNetworkId(options.networkId)
  const identity = requireIdentity(options.identity)
  const timeoutMs = options.timeoutMs ?? 500
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be an integer ≥ 1')
  const reused = options.socket
  if (reused !== undefined && typeof reused.send !== 'function') {
    throw new TypeError('socket must be a dgram Socket when provided')
  }

  // Reuse path: no bind, no close — the punch layer keeps the socket. Our
  // own `message` listener is tracked so ONLY it is removed on exit.
  let socket: DgramSocket
  let bound = false
  if (reused !== undefined) {
    socket = reused
    try {
      bound = socket.address().port > 0
    } catch {
      bound = false
    }
    if (!bound) {
      // Reused sockets are expected to be bound already (the punch layer
      // binds its own); a stranger unbound socket is still usable — bind it
      // here once, but leave it open (the caller closes what it passed).
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          socket.removeListener('error', onError)
          reject(err)
        }
        socket.once('error', onError)
        socket.bind(0, () => {
          socket.removeListener('error', onError)
          resolve()
        })
      })
    }
  } else {
    socket = dgram.createSocket('udp4')
    socket.on('error', () => {}) // ICMP port-unreachables are routine here; never crash
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        socket.removeListener('error', onError)
        reject(err)
      }
      socket.once('error', onError)
      socket.bind(0, () => {
        socket.removeListener('error', onError)
        resolve()
      })
    })
  }

  const nonce = randomBytes(8).toString('hex')
  const timestamp = Date.now()
  const message = Buffer.from(
    `${STUN_PROBE_DOMAIN}|${networkId}|${identity.nodeId}|${nonce}|${timestamp}`,
    'utf8',
  )
  const packet = Buffer.from(JSON.stringify({
    type: 'stun-probe',
    networkId,
    nodeId: identity.nodeId,
    publicKeyHex: identity.publicKeyHex,
    nonce,
    timestamp,
    signatureHex: ed25519Sign(message, identity),
  }))

  // One socket, two remote ports: the mapping comparison is only
  // meaningful because both probes share the same local endpoint.
  const slots = new Map<number, 'primary' | 'alt'>()
  const replies = new Map<'primary' | 'alt', { ip: string; port: number }>()
  let settleEarly: () => void = () => {}
  const early = new Promise<void>((resolve) => {
    settleEarly = resolve
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  const onMessage = (buf: Buffer, rinfo: { address: string; port: number }): void => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(buf.toString('utf8'))
    } catch {
      return
    }
    // Dual-format reply: the gateway's `type:'stun-reply'` and the legacy
    // node shape `kind:'zr-stun-reply'` both carry (nonce, ip, port) under
    // different names; read whichever is present.
    const kind = parsed.type ?? parsed.kind
    if (kind !== 'stun-reply' && kind !== 'zr-stun-reply') return
    if (parsed.nonce !== nonce) return
    const ip = parsed.reflexiveIp ?? parsed.ip
    const port = parsed.reflexivePort ?? parsed.port
    if (typeof ip !== 'string' || ip.length === 0) return
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) return
    const slot = slots.get(rinfo.port)
    if (!slot || replies.has(slot)) return
    replies.set(slot, { ip, port })
    if (replies.size === slots.size) settleEarly()
  }
  socket.on('message', onMessage)
  const send = (port: number, slot: 'primary' | 'alt'): void => {
    slots.set(port, slot)
    socket.send(packet, port, primaryHost, (err) => {
      if (err) slots.delete(port)
    })
  }
  try {
    send(options.primaryPort, 'primary')
    if (altPort > 0) send(altPort, 'alt')
    await Promise.race([deadline, early])
    clearTimeout(timer)

    const primary = replies.get('primary')
    if (!primary) return { reflexiveEndpoint: null, natType: 'unknown' }
    const reflexiveEndpoint = `${primary.ip}:${primary.port}`
    const alt = replies.get('alt')
    if (!alt) return { reflexiveEndpoint, natType: 'unknown' }
    if (primary.port !== alt.port) return { reflexiveEndpoint, natType: 'symmetric' }
    return { reflexiveEndpoint, natType: isReflexiveIpLocal(primary.ip) ? 'public' : 'cone' }
  } finally {
    clearTimeout(timer)
    // The reuse contract: leave the punch layer's socket exactly as we found
    // it — our listener removed, everything else untouched. The throwaway
    // path (no `socket` given) closes its own.
    socket.removeListener('message', onMessage)
    if (reused === undefined) socket.close()
  }
}

// -- Ed25519 helpers (crypto.ts keeps its JWK round-trips private) -------------------

/** Sign a raw message with the node's long-term identity (64-byte sig → 128 hex). Shared with the mux's WS-relayed control envelopes. */
export function ed25519Sign(message: Buffer, identity: PeerIdentityKeyPair): string {
  const privateKey = createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(identity.publicKeyHex, 'hex').toString('base64url'),
      d: Buffer.from(identity.privateKeyHex, 'hex').toString('base64url'),
    },
    format: 'jwk',
  })
  return sign(null, message, privateKey).toString('hex')
}

/** Verify a raw-message Ed25519 signature against a raw 32-byte public key. Never throws. */
export function ed25519Verify(message: Buffer, publicKeyHex: string, sigHex: string): boolean {
  try {
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyHex, 'hex').toString('base64url') },
      format: 'jwk',
    })
    return verify(null, message, publicKey, Buffer.from(sigHex, 'hex'))
  } catch {
    return false
  }
}

// -- the per-peer punch state machine -----------------------------------------------

export type PunchClock = {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: PunchClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface DirectReadyInfo {
  mode: 'lan' | 'p2p'
  /** The `ip:port` endpoint the successful exchange actually used. */
  endpoint: string
  /** Handshake RTT when we initiated; 0 when we answered passively. */
  rttMs: number
  ciphers: PeerSessionCiphers
}

/** Same frame-sending seam `src/peer/arq.ts` consumes after `onDirectReady`. */
export type PunchFrameSender = (frameType: number, streamId: number, payload: Uint8Array, ack: number) => void

export interface PunchPeerInfo {
  peerNodeId: string
  peerPublicKeyHex: string
  /** The peer's `ip:port` candidates (LAN endpoints, then reflexive). */
  lanEndpoints: string[]
  reflexiveEndpoint?: string | null
}

/** Minimal datagram origin: everything the punch layer needs from a datagram. */
export interface PunchRemoteInfo {
  address: string
  port: number
}

export interface PeerPunchOptions {
  networkId: string
  identity: PeerIdentityKeyPair
  /** Bring your own bound socket; one is created (udp4, random port) otherwise. */
  socket?: DgramSocket
  bindHost?: string
  clock?: PunchClock
  /** Delay between HELLO rounds inside the priority window. */
  punchIntervalMs?: number
  /** HELLO rounds per window (spec: 100ms × 10). */
  punchRounds?: number
  /** The priority window itself (spec: 1000ms). */
  punchWindowMs?: number
  /** Silent background reprobe cadence after a fallback/loss. */
  reprobeIntervalMs?: number
  /** Encrypted PING cadence once direct (spec: 5s). */
  keepAliveMs?: number
  /** Silent keepalive cycles that declare the direct path lost (spec: 3). */
  keepAliveLostFrames?: number
  onDirectReady?: (peerNodeId: string, info: DirectReadyInfo) => void
  onPunchFallback?: (peerNodeId: string) => void
  onDirectLost?: (peerNodeId: string) => void
  /** Opened application frames from the peer (PING/PONG stay internal). */
  onEncryptedFrame?: (header: PeerFrameHeader, plaintext: Uint8Array, rinfo: PunchRemoteInfo) => void
}

type PunchState = 'punching' | 'direct' | 'idle'

interface PunchSession {
  peerNodeId: string
  peerPublicKeyHex: string
  state: PunchState
  myEph: PeerEphemeralKeyPair
  /** Nonce our HELLOs carry and their ACK must echo back. */
  nonce: string
  peerEphPubHex: string | null
  /** Guard so one derived key pair fires onDirectReady exactly once. */
  derivedPair: string | null
  candidates: string[]
  endpoint: string | null
  ciphers: PeerSessionCiphers | null
  rttMs: number | null
  lastHelloSentAt: number | null
  lastPingSentAt: number | null
  lastSeen: number
  timers: Set<unknown>
  /** AEAD frame sequence for THIS peer — one counter, never reused. */
  frameSeq: bigint
}

/**
 * One UDP socket, many peers. See the module doc for the state machine.
 * After `onDirectReady`, hand `frameSenderFor(peerNodeId)` to an ARQ
 * session as its `sendFrame` and route `onEncryptedFrame` into
 * `handleFrame` — frames and keepalive share one monotonic AEAD
 * sequence per direction, exactly what the frame layer's replay window
 * requires.
 */
export class PeerPunchManager {
  private readonly options: PeerPunchOptions
  private readonly clock: PunchClock
  private readonly networkId: string
  private readonly identity: PeerIdentityKeyPair
  private readonly socket: DgramSocket
  private readonly ownsSocket: boolean
  private readonly localIps: string[]
  private readonly sessions = new Map<string, PunchSession>()
  private lanEndpointList: string[] = []
  private closed = false
  private readonly readyPromise: Promise<void>

  constructor(options: PeerPunchOptions) {
    this.options = options
    this.networkId = requireNetworkId(options.networkId)
    this.identity = requireIdentity(options.identity)
    const knob = (value: number | undefined, fallback: number, name: string): number => {
      const resolved = value ?? fallback
      if (!Number.isInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be an integer ≥ 1`)
      return resolved
    }
    knob(options.punchIntervalMs, 100, 'punchIntervalMs')
    knob(options.punchRounds, 10, 'punchRounds')
    knob(options.punchWindowMs, 1000, 'punchWindowMs')
    knob(options.reprobeIntervalMs, 60_000, 'reprobeIntervalMs')
    knob(options.keepAliveMs, 5000, 'keepAliveMs')
    knob(options.keepAliveLostFrames, 3, 'keepAliveLostFrames')
    this.clock = options.clock ?? realClock
    this.localIps = collectLocalIps()

    if (options.socket) {
      this.socket = options.socket
      this.ownsSocket = false
    } else {
      this.socket = dgram.createSocket('udp4')
      this.ownsSocket = true
    }
    // Probing dead ports earns ICMP errors on macOS/Windows; routine, never fatal.
    this.socket.on('error', () => {})
    this.socket.on('message', (buf, rinfo) => this.handlePacket(buf, rinfo))

    let boundPort = 0
    try {
      boundPort = this.socket.address().port
    } catch {
      boundPort = 0
    }
    if (boundPort > 0) {
      this.refreshLanEndpoints(boundPort)
      this.readyPromise = Promise.resolve()
    } else {
      this.readyPromise = new Promise<void>((resolve) => {
        this.socket.once('listening', () => {
          try {
            this.refreshLanEndpoints(this.socket.address().port)
          } finally {
            resolve()
          }
        })
      })
      if (this.ownsSocket) this.socket.bind({ port: 0, address: options.bindHost ?? undefined })
    }
  }

  /** Resolves once the socket has a bound port (immediately for pre-bound sockets). */
  ready(): Promise<void> {
    return this.readyPromise
  }

  /** This machine's non-loopback IPv4 addresses with our bound port. */
  lanEndpoints(): string[] {
    return [...this.lanEndpointList]
  }

  /**
   * Start (or restart) the 1000ms priority punch toward a peer: fresh
   * X25519 key, fresh nonce, HELLOs to every candidate endpoint —
   * round 0 immediately, then one round per `punchIntervalMs` up to
   * `punchRounds` total. On success the window/rounds timers are
   * cancelled; on expiry `onPunchFallback` fires exactly once and the
   * silent reprobe cycle takes over.
   */
  beginPunch(peer: PunchPeerInfo): void {
    if (this.closed) return
    if (typeof peer.peerNodeId !== 'string' || !NODE_ID_PATTERN.test(peer.peerNodeId.toLowerCase())) {
      throw new TypeError('peerNodeId must be 8 hex characters')
    }
    const nodeId = peer.peerNodeId.toLowerCase()
    if (!verifySelfCertifyingNodeId(nodeId, peer.peerPublicKeyHex)) {
      throw new TypeError('peerNodeId is not the self-certifying hash of peerPublicKeyHex')
    }
    if (nodeId === this.identity.nodeId) throw new TypeError('cannot punch ourselves')
    const candidates: string[] = []
    const raw = [...(Array.isArray(peer.lanEndpoints) ? peer.lanEndpoints : [])]
    if (peer.reflexiveEndpoint) raw.push(peer.reflexiveEndpoint)
    for (const endpoint of raw) {
      if (typeof endpoint === 'string' && parseEndpoint(endpoint) && !candidates.includes(endpoint)) {
        candidates.push(endpoint)
      }
    }
    const existing = this.sessions.get(nodeId)
    if (existing) {
      // Preserve an already-confirmed direct UDP session when late control
      // signals (e.g. punch-coordinate) arrive — wiping ciphers mid-flight
      // would drop active ARQ stream frames.
      if (existing.state === 'direct' && existing.peerPublicKeyHex === peer.peerPublicKeyHex && existing.ciphers) {
        for (const ep of candidates) {
          if (!existing.candidates.includes(ep)) existing.candidates.push(ep)
        }
        return
      }
      this.clearSessionTimers(existing)
      this.sessions.delete(nodeId)
    }
    const session = this.createSession(nodeId, peer.peerPublicKeyHex, candidates)
    this.startPunchRounds(session)
  }

  /**
   * Entry point for every datagram on our socket — sealed frames when a
   * session has ciphers, signed JSON control packets otherwise. Public
   * so tests (and unusual socket wirings) can inject datagrams.
   */
  handlePacket(bytes: Uint8Array, rinfo: { address: string; port: number }): void {
    if (this.closed) return
    const header = decodeFrameHeader(bytes)
    if (header) {
      if (header.dstNodeId !== this.identity.nodeId || header.srcNodeId === this.identity.nodeId) return
      const session = this.sessions.get(header.srcNodeId)
      if (!session?.ciphers) return
      const opened = unpackEncryptedFrame(bytes, session.ciphers)
      if (opened) this.onOpenedFrame(session, opened.header, opened.plaintext, rinfo)
      return
    }
    this.handleControlPacket(bytes, rinfo)
  }

  /**
   * The ARQ seam for an established peer: assign the returned function
   * to a `PeerArqSession.sendFrame`. Every frame (application data and
   * this manager's keepalive alike) takes the next value of one
   * monotonic per-peer AEAD sequence, which is exactly what the frame
   * layer's replay window needs.
   */
  frameSenderFor(peerNodeId: string): PunchFrameSender {
    const nodeId = peerNodeId.toLowerCase()
    return (frameType, streamId, payload, ack) => {
      const session = this.sessions.get(nodeId)
      if (!session) throw new Error(`no punch session for ${nodeId}`)
      this.sendEncryptedTo(session, frameType, streamId, payload, ack)
    }
  }

  sessionCiphers(peerNodeId: string): PeerSessionCiphers | null {
    const session = this.sessions.get(peerNodeId.toLowerCase())
    return session?.state === 'direct' ? session.ciphers : null
  }

  /** Last PING→PONG round trip for the peer, or null before the first PONG. */
  sessionRttMs(peerNodeId: string): number | null {
    return this.sessions.get(peerNodeId.toLowerCase())?.rttMs ?? null
  }

  /** Stop everything: per-peer timers cleared, sessions dropped, socket closed. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const session of this.sessions.values()) this.clearSessionTimers(session)
    this.sessions.clear()
    try {
      this.socket.close()
    } catch {
      // already closed — nothing left to do
    }
  }

  // -- internals -------------------------------------------------------------------

  private createSession(nodeId: string, publicKeyHex: string, candidates: string[]): PunchSession {
    const session: PunchSession = {
      peerNodeId: nodeId,
      peerPublicKeyHex: publicKeyHex,
      state: 'punching',
      myEph: generateEphemeralX25519(),
      nonce: randomBytes(8).toString('hex'),
      peerEphPubHex: null,
      derivedPair: null,
      candidates,
      endpoint: null,
      ciphers: null,
      rttMs: null,
      lastHelloSentAt: null,
      lastPingSentAt: null,
      lastSeen: this.clock.now(),
      timers: new Set(),
      frameSeq: 0n,
    }
    this.sessions.set(nodeId, session)
    return session
  }

  private armTimer(session: PunchSession, fn: () => void, ms: number): void {
    const handle = this.clock.setTimeout(() => {
      session.timers.delete(handle)
      fn()
    }, ms)
    session.timers.add(handle)
  }

  private clearSessionTimers(session: PunchSession): void {
    for (const handle of session.timers) this.clock.clearTimeout(handle)
    session.timers.clear()
  }

  private refreshLanEndpoints(port: number): void {
    this.lanEndpointList = collectLanEndpoints(
      os.networkInterfaces() as unknown as Record<string, ReadonlyArray<LanInterfaceInfo> | undefined>,
      port,
    )
  }

  private startPunchRounds(session: PunchSession): void {
    session.state = 'punching'
    // A new round cycle is a new key exchange: invalidate everything
    // derived from the previous ephemeral key.
    session.myEph = generateEphemeralX25519()
    session.nonce = randomBytes(8).toString('hex')
    session.peerEphPubHex = null
    session.derivedPair = null
    session.ciphers = null
    session.rttMs = null
    let round = 0
    const fire = (): void => {
      if (this.closed || session.state !== 'punching') return
      this.sendHellos(session)
      round += 1
      if (round < this.punchRoundsOrDefault()) this.armTimer(session, fire, this.punchIntervalMsOrDefault())
    }
    fire()
    this.armTimer(session, () => this.onPunchWindowExpired(session), this.punchWindowMsOrDefault())
  }

  private punchIntervalMsOrDefault(): number {
    return this.options.punchIntervalMs ?? 100
  }

  private punchRoundsOrDefault(): number {
    return this.options.punchRounds ?? 10
  }

  private punchWindowMsOrDefault(): number {
    return this.options.punchWindowMs ?? 1000
  }

  private reprobeIntervalMsOrDefault(): number {
    return this.options.reprobeIntervalMs ?? 60_000
  }

  private keepAliveMsOrDefault(): number {
    return this.options.keepAliveMs ?? 5000
  }

  private keepAliveLostFramesOrDefault(): number {
    return this.options.keepAliveLostFrames ?? 3
  }

  private onPunchWindowExpired(session: PunchSession): void {
    if (this.closed || session.state !== 'punching') return
    session.state = 'idle'
    this.clearSessionTimers(session) // stop any rounds still armed
    this.options.onPunchFallback?.(session.peerNodeId)
    this.scheduleReprobe(session)
  }

  private scheduleReprobe(session: PunchSession): void {
    if (this.closed) return
    this.armTimer(session, () => {
      if (this.closed || session.state !== 'idle') return
      this.startPunchRounds(session)
    }, this.reprobeIntervalMsOrDefault())
  }

  private startKeepalive(session: PunchSession): void {
    const tick = (): void => {
      if (this.closed || session.state !== 'direct') return
      const silentFor = this.clock.now() - session.lastSeen
      if (silentFor >= this.keepAliveMsOrDefault() * this.keepAliveLostFramesOrDefault()) {
        session.state = 'idle'
        this.options.onDirectLost?.(session.peerNodeId)
        this.scheduleReprobe(session)
        return
      }
      session.lastPingSentAt = this.clock.now()
      try {
        this.sendEncryptedTo(session, PeerFrameType.PING, 0, randomBytes(8), 0)
      } catch {
        // Socket closing or transient datagram failure — keepalive timeout handles lost links cleanly.
      }
      this.armTimer(session, tick, this.keepAliveMsOrDefault())
    }
    this.armTimer(session, tick, this.keepAliveMsOrDefault())
  }

  private sendHellos(session: PunchSession): void {
    const timestamp = this.clock.now()
    session.lastHelloSentAt = timestamp
    const message = Buffer.from(
      `${PUNCH_DOMAIN}|hello|${this.networkId}|${this.identity.nodeId}|${session.myEph.publicKeyHex}|${session.nonce}|${timestamp}`,
      'utf8',
    )
    const packet = Buffer.from(JSON.stringify({
      zr: 1,
      kind: 'zr-hello',
      networkId: this.networkId,
      nodeId: this.identity.nodeId,
      publicKeyHex: this.identity.publicKeyHex,
      ephPubHex: session.myEph.publicKeyHex,
      nonce: session.nonce,
      timestamp,
      sigHex: ed25519Sign(message, this.identity),
    }))
    for (const endpoint of session.candidates) {
      const parsed = parseEndpoint(endpoint)
      if (!parsed) continue
      try {
        this.socket.send(packet, parsed.port, parsed.host)
      } catch {
        // Unroutable or closed UDP socket — skip candidate without crashing host timers.
      }
    }
  }

  private sendHelloAck(session: PunchSession, echoNonce: string, rinfo: { address: string; port: number }): void {
    const timestamp = this.clock.now()
    const message = Buffer.from(
      `${PUNCH_DOMAIN}|ack|${this.networkId}|${this.identity.nodeId}|${session.myEph.publicKeyHex}|${echoNonce}|${timestamp}`,
      'utf8',
    )
    const packet = Buffer.from(JSON.stringify({
      zr: 1,
      kind: 'zr-hello-ack',
      networkId: this.networkId,
      nodeId: this.identity.nodeId,
      publicKeyHex: this.identity.publicKeyHex,
      ephPubHex: session.myEph.publicKeyHex,
      nonce: echoNonce,
      timestamp,
      sigHex: ed25519Sign(message, this.identity),
    }))
    try {
      this.socket.send(packet, rinfo.port, rinfo.address)
    } catch {
      // Closed or unroutable UDP socket.
    }
  }

  private handleControlPacket(bytes: Uint8Array, rinfo: { address: string; port: number }): void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'))
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object' || parsed.zr !== 1) return
    if (parsed.networkId !== this.networkId) return
    const nodeId = typeof parsed.nodeId === 'string' ? parsed.nodeId.toLowerCase() : ''
    if (!NODE_ID_PATTERN.test(nodeId) || nodeId === this.identity.nodeId) return
    if (parsed.kind === 'zr-hello') this.onHello(parsed, rinfo)
    else if (parsed.kind === 'zr-hello-ack') this.onHelloAck(parsed, rinfo)
  }

  private onHello(packet: Record<string, unknown>, rinfo: { address: string; port: number }): void {
    if (typeof packet.publicKeyHex !== 'string' || !HEX64.test(packet.publicKeyHex)) return
    if (typeof packet.ephPubHex !== 'string' || !HEX64.test(packet.ephPubHex)) return
    if (typeof packet.nonce !== 'string' || !HEX16.test(packet.nonce)) return
    if (typeof packet.timestamp !== 'number' || !Number.isInteger(packet.timestamp)) return
    if (typeof packet.sigHex !== 'string' || !HEX128.test(packet.sigHex)) return
    const nodeId = (packet.nodeId as string).toLowerCase()
    if (!verifySelfCertifyingNodeId(nodeId, packet.publicKeyHex)) return
    const message = Buffer.from(
      `${PUNCH_DOMAIN}|hello|${this.networkId}|${nodeId}|${packet.ephPubHex}|${packet.nonce}|${packet.timestamp}`,
      'utf8',
    )
    if (!ed25519Verify(message, packet.publicKeyHex, packet.sigHex)) return
    const session = this.ensureSession(nodeId, packet.publicKeyHex, [`${rinfo.address}:${rinfo.port}`])
    if (!session) return
    // Answer FIRST — the peer's RTT clock is already running.
    this.sendHelloAck(session, packet.nonce, rinfo)
    // An inbound HELLO only proves peer → us UDP reachability, NOT us → peer!
    // Derive ciphers so we can open the peer's follow-up encrypted confirmation
    // frame, but do NOT flip into `direct` until bidirectional reachability is
    // proven (prevents asymmetric NAT/firewall from blackholing outbound replies).
    this.integratePeerEphemeral(session, packet.ephPubHex, rinfo, session.state === 'direct')
  }

  private onHelloAck(packet: Record<string, unknown>, rinfo: { address: string; port: number }): void {
    if (typeof packet.publicKeyHex !== 'string' || !HEX64.test(packet.publicKeyHex)) return
    if (typeof packet.ephPubHex !== 'string' || !HEX64.test(packet.ephPubHex)) return
    if (typeof packet.nonce !== 'string' || !HEX16.test(packet.nonce)) return
    if (typeof packet.timestamp !== 'number' || !Number.isInteger(packet.timestamp)) return
    if (typeof packet.sigHex !== 'string' || !HEX128.test(packet.sigHex)) return
    const nodeId = (packet.nodeId as string).toLowerCase()
    const session = this.sessions.get(nodeId)
    // Key pinning: the ack must come from the identity we set out to reach.
    if (!session || session.peerPublicKeyHex !== packet.publicKeyHex) return
    // The echoed nonce binds this ack to OUR current round; stale rounds die here.
    if (packet.nonce !== session.nonce) return
    const message = Buffer.from(
      `${PUNCH_DOMAIN}|ack|${this.networkId}|${nodeId}|${packet.ephPubHex}|${packet.nonce}|${packet.timestamp}`,
      'utf8',
    )
    if (!ed25519Verify(message, packet.publicKeyHex, packet.sigHex)) return
    if (typeof session.lastHelloSentAt === 'number') {
      session.rttMs = Math.max(0, this.clock.now() - session.lastHelloSentAt)
    }
    this.integratePeerEphemeral(session, packet.ephPubHex, rinfo, true)
    // Immediately send an encrypted PING so the responder confirms round-trip
    // (us → peer HELLO, peer → us ACK, us → peer sealed PING) in 0.5 RTT.
    try {
      session.lastPingSentAt = this.clock.now()
      this.sendEncryptedTo(session, PeerFrameType.PING, 0, randomBytes(8), 0)
    } catch {
      // Transient send failure; keepalive will retry.
    }
  }

  private ensureSession(nodeId: string, publicKeyHex: string, candidates: string[]): PunchSession | null {
    const existing = this.sessions.get(nodeId)
    if (existing) {
      // Key pinning: one nodeId is bound to the key the gateway (or the
      // first valid handshake) told us about. A different key is an
      // impostor — the id is the hash of the key, so both cannot be right.
      return existing.peerPublicKeyHex === publicKeyHex ? existing : null
    }
    return this.createSession(nodeId, publicKeyHex, candidates)
  }

  /**
   * Adopt a peer ephemeral key and (re)derive the session ciphers. The
   * working endpoint is refreshed on every call; derivation happens
   * only when the ephemeral key is actually new, and `derivedPair`
   * keeps the direct-ready callback to one shot per key pair — hot
   * upgrades (a fresh reprobe from the peer) still fire again.
   */
  private integratePeerEphemeral(
    session: PunchSession,
    peerEphPubHex: string,
    rinfo: { address: string; port: number },
    confirmDirect: boolean,
  ): void {
    session.endpoint = `${rinfo.address}:${rinfo.port}`
    if (session.peerEphPubHex !== peerEphPubHex || session.ciphers === null) {
      session.peerEphPubHex = peerEphPubHex
      session.ciphers = derivePeerSessionCiphers({
        networkId: this.networkId,
        myNodeId: this.identity.nodeId,
        peerNodeId: session.peerNodeId,
        myEphPrivateKeyHex: session.myEph.privateKeyHex,
        myEphPublicKeyHex: session.myEph.publicKeyHex,
        peerEphPublicKeyHex: peerEphPubHex,
      })
    }
    if (!confirmDirect || !session.ciphers) return
    const pairKey = `${session.myEph.publicKeyHex}|${peerEphPubHex}`
    if (session.state === 'direct' && session.derivedPair === pairKey) return
    session.derivedPair = pairKey
    this.completeDirect(session, session.ciphers)
  }

  private completeDirect(session: PunchSession, ciphers: PeerSessionCiphers): void {
    session.state = 'direct'
    session.lastSeen = this.clock.now()
    this.clearSessionTimers(session) // punch rounds / window / pending reprobe all die
    this.startKeepalive(session)
    const endpoint = session.endpoint ?? ''
    this.options.onDirectReady?.(session.peerNodeId, {
      mode: classifyPunchEndpoint(endpoint, this.localIps),
      endpoint,
      rttMs: session.rttMs ?? 0,
      ciphers,
    })
  }

  private onOpenedFrame(
    session: PunchSession,
    header: PeerFrameHeader,
    plaintext: Uint8Array,
    rinfo: { address: string; port: number },
  ): void {
    session.lastSeen = this.clock.now()
    // Any authenticated frame refreshes the peer's current endpoint —
    // a roaming phone behind NAT gets followed automatically.
    session.endpoint = `${rinfo.address}:${rinfo.port}`
    // Opening an AEAD-authenticated frame under ciphers derived from our
    // HELLO-ACK proves our HELLO-ACK reached the peer AND their encrypted
    // traffic reaches us: 3-way bidirectional UDP confirmation complete!
    if (session.state !== 'direct' && session.ciphers && session.peerEphPubHex) {
      session.derivedPair = `${session.myEph.publicKeyHex}|${session.peerEphPubHex}`
      this.completeDirect(session, session.ciphers)
    }
    if (header.frameType === PeerFrameType.PING) {
      if (session.state === 'direct') {
        try {
          this.sendEncryptedTo(session, PeerFrameType.PONG, 0, Buffer.from(plaintext), 0)
        } catch {
          // Transient send failure; peer keepalive retries.
        }
      }
      return
    }
    if (header.frameType === PeerFrameType.PONG) {
      if (session.lastPingSentAt !== null) {
        session.rttMs = Math.max(0, this.clock.now() - session.lastPingSentAt)
        session.lastPingSentAt = null
      }
      return
    }
    this.options.onEncryptedFrame?.(header, plaintext, rinfo)
  }

  private sendEncryptedTo(
    session: PunchSession,
    frameType: number,
    streamId: number,
    payload: Uint8Array,
    ack: number,
  ): void {
    if (this.closed) throw new Error('punch manager closed')
    if (!session.ciphers) throw new Error(`no established session for ${session.peerNodeId}`)
    const endpoint = session.endpoint
    if (!endpoint) throw new Error(`no known endpoint for ${session.peerNodeId}`)
    const parsed = parseEndpoint(endpoint)
    if (!parsed) throw new Error(`malformed endpoint ${endpoint}`)
    const seq = session.frameSeq++
    const frame = packEncryptedFrame(
      {
        frameType,
        srcNodeId: this.identity.nodeId,
        dstNodeId: session.peerNodeId,
        streamId,
        seq,
        ack,
      },
      payload,
      session.ciphers,
    )
    try {
      this.socket.send(frame, parsed.port, parsed.host)
    } catch {
      // Closed or unroutable UDP socket; ARQ / keepalive handles packet loss cleanly.
    }
  }
}

function collectLocalIps(): string[] {
  const ips: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (isIPv4Family(entry.family) && !entry.internal) ips.push(entry.address)
    }
  }
  return ips
}
