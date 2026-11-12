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
 *    candidate with a fresh X25519 key; an admitted peer's valid HELLO is
 *    answered immediately, and its signed ACK to our fresh nonce derives
 *    `PeerSessionCiphers` (PG-1 dual-simplex AEAD). The endpoint that
 *    worked is classified `lan` (RFC1918/CGNAT subnet or loopback match
 *    against our own interfaces) or `p2p`, with a measured RTT. If the
 *    1000ms window expires the caller gets `onPunchFallback` — go use
 *    the gateway WS relay NOW — while a silent reprobe keeps retrying
 *    every 60s and hot-upgrades to direct on the first later success.
 *    Established paths are kept alive with 5s encrypted PING/PONG;
 *    the path is declared lost (`onDirectLost`) exactly `keepAliveMs` *
 *    `keepAliveLostFrames` (15s) after the last authenticated receive —
 *    decoupled from the PING tick — and re-enters the reprobe cycle.
 *
 * Wire shapes here are JSON control packets (`zr:1`, Ed25519-signed over
 * a domain-separated canonical line) plus PG-1 sealed frames once
 * ciphers exist. All timing goes through an injectable clock so tests
 * drive the state machine deterministically while real sockets do the
 * I/O.
 */
import type { Socket as DgramSocket } from 'node:dgram';
import type { PeerIdentityKeyPair, PeerSessionCiphers } from './crypto.js';
import type { PeerFrameHeader } from './wire.js';
/** 打洞/中转握手控制包的域分隔前缀——UDP 与网关 WS 两条路径共用同一形态。 */
export declare const STUN_PROBE_DOMAIN = "zr-stun-probe-v1";
export declare const PUNCH_DOMAIN = "zr-punch-v1";
/** `os.networkInterfaces()` entries, loosened so hand-built fixtures type-check. */
export interface LanInterfaceInfo {
    address: string;
    family: string | number;
    internal: boolean;
}
/**
 * All non-loopback IPv4 addresses of `interfaces` as `ip:port` punch
 * candidates. Loopback (internal flag) and IPv6 are useless for
 * punching; link-local 169.254/16 is excluded too — it never routes.
 * RFC1918 and the 100.64.0.0/10 CGNAT range (Tailscale) are the
 * interesting cases and ride along with any public ips.
 */
export declare function collectLanEndpoints(interfaces: Record<string, ReadonlyArray<LanInterfaceInfo> | undefined>, port: number): string[];
/**
 * Which KIND of path does this endpoint represent? `lan` when it is
 * loopback, one of `localIps` exactly, or a private/CGNAT address that
 * shares a /24 with one of our interfaces — i.e. a same-subnet path we
 * can usually reach without any NAT help. Everything else is `p2p`
 * (public reflexive mapping or foreign private nets). Unparseable
 * candidates answer `p2p` — never promoted on a guess.
 */
export declare function classifyPunchEndpoint(endpoint: string, localIps: string[]): 'lan' | 'p2p';
export type PeerNatType = 'public' | 'cone' | 'symmetric' | 'unknown';
export interface StunProbeResult {
    /** `ip:port` the gateway's PRIMARY port saw, or null when it never answered. */
    reflexiveEndpoint: string | null;
    natType: PeerNatType;
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
export declare function probeStunNatType(options: {
    primaryHost: string;
    primaryPort: number;
    altPort?: number;
    networkId: string;
    identity: PeerIdentityKeyPair;
    timeoutMs?: number;
    /** Reuse an ALREADY-BOUND socket (the punch layer's own). Not closed here. */
    socket?: DgramSocket;
}): Promise<StunProbeResult>;
/** Sign a raw message with the node's long-term identity (64-byte sig → 128 hex). Shared with the mux's WS-relayed control envelopes. */
export declare function ed25519Sign(message: Buffer, identity: PeerIdentityKeyPair): string;
/** Verify a raw-message Ed25519 signature against a raw 32-byte public key. Never throws. */
export declare function ed25519Verify(message: Buffer, publicKeyHex: string, sigHex: string): boolean;
export type PunchClock = {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
};
export interface DirectReadyInfo {
    mode: 'lan' | 'p2p';
    /** The `ip:port` endpoint the successful exchange actually used. */
    endpoint: string;
    /** Handshake RTT when we initiated; 0 when we answered passively. */
    rttMs: number;
    ciphers: PeerSessionCiphers;
}
/** Same frame-sending seam `src/peer/arq.ts` consumes after `onDirectReady`. */
export type PunchFrameSender = (frameType: number, streamId: number, payload: Uint8Array, ack: number) => void;
export interface PunchPeerInfo {
    peerNodeId: string;
    peerPublicKeyHex: string;
    /** The peer's `ip:port` candidates (LAN endpoints, then reflexive). */
    lanEndpoints: string[];
    reflexiveEndpoint?: string | null;
}
/** Minimal datagram origin: everything the punch layer needs from a datagram. */
export interface PunchRemoteInfo {
    address: string;
    port: number;
}
export interface PeerPunchOptions {
    networkId: string;
    identity: PeerIdentityKeyPair;
    /** Bring your own bound socket; one is created (udp4, random port) otherwise. */
    socket?: DgramSocket;
    bindHost?: string;
    clock?: PunchClock;
    /** Delay between HELLO rounds inside the priority window. */
    punchIntervalMs?: number;
    /** HELLO rounds per window (spec: 100ms × 10). */
    punchRounds?: number;
    /** The priority window itself (spec: 1000ms). */
    punchWindowMs?: number;
    /** Silent background reprobe cadence after a fallback/loss. */
    reprobeIntervalMs?: number;
    /** Encrypted PING cadence once direct (spec: 5s). */
    keepAliveMs?: number;
    /** Silent keepalive cycles that declare the direct path lost (spec: 3). */
    keepAliveLostFrames?: number;
    onDirectReady?: (peerNodeId: string, info: DirectReadyInfo) => void;
    onPunchFallback?: (peerNodeId: string) => void;
    onDirectLost?: (peerNodeId: string) => void;
    /** Opened application frames from the peer (PING/PONG stay internal). */
    onEncryptedFrame?: (header: PeerFrameHeader, plaintext: Uint8Array, rinfo: PunchRemoteInfo) => void;
}
/**
 * One UDP socket, many peers. See the module doc for the state machine.
 * After `onDirectReady`, hand `frameSenderFor(peerNodeId)` to an ARQ
 * session as its `sendFrame` and route `onEncryptedFrame` into
 * `handleFrame` — frames and keepalive share one monotonic AEAD
 * sequence per direction, exactly what the frame layer's replay window
 * requires.
 */
export declare class PeerPunchManager {
    private readonly options;
    private readonly clock;
    private readonly networkId;
    private readonly identity;
    private readonly socket;
    private readonly ownsSocket;
    private readonly localIps;
    private readonly sessions;
    private lanEndpointList;
    private closed;
    private readonly readyPromise;
    constructor(options: PeerPunchOptions);
    /** Resolves once the socket has a bound port (immediately for pre-bound sockets). */
    ready(): Promise<void>;
    /** This machine's non-loopback IPv4 addresses with our bound port. */
    lanEndpoints(): string[];
    /**
     * Start (or restart) the 1000ms priority punch toward a peer: fresh
     * X25519 key, fresh nonce, HELLOs to every candidate endpoint —
     * round 0 immediately, then one round per `punchIntervalMs` up to
     * `punchRounds` total. On success the window/rounds timers are
     * cancelled; on expiry `onPunchFallback` fires exactly once and the
     * silent reprobe cycle takes over.
     */
    beginPunch(peer: PunchPeerInfo): void;
    /**
     * Entry point for every datagram on our socket — sealed frames when a
     * session has ciphers, signed JSON control packets otherwise. Public
     * so tests (and unusual socket wirings) can inject datagrams.
     */
    handlePacket(bytes: Uint8Array, rinfo: {
        address: string;
        port: number;
    }): void;
    /**
     * The ARQ seam for an established peer: assign the returned function
     * to a `PeerArqSession.sendFrame`. Every frame (application data and
     * this manager's keepalive alike) takes the next value of one
     * monotonic per-peer AEAD sequence, which is exactly what the frame
     * layer's replay window needs.
     */
    frameSenderFor(peerNodeId: string): PunchFrameSender;
    sessionCiphers(peerNodeId: string): PeerSessionCiphers | null;
    /** Last PING→PONG round trip for the peer, or null before the first PONG. */
    sessionRttMs(peerNodeId: string): number | null;
    /** Revoke gateway/local admission and discard all UDP state for this peer. */
    dropPeer(peerNodeId: string): void;
    /** Stop everything: per-peer timers cleared, sessions dropped, socket closed. */
    close(): void;
    private createSession;
    private armTimer;
    private clearSessionTimers;
    private refreshLanEndpoints;
    private startPunchRounds;
    private punchIntervalMsOrDefault;
    private punchRoundsOrDefault;
    private punchWindowMsOrDefault;
    private reprobeIntervalMsOrDefault;
    private keepAliveMsOrDefault;
    private keepAliveLostFramesOrDefault;
    private onPunchWindowExpired;
    private scheduleReprobe;
    private startKeepalive;
    private sendHellos;
    private sendHelloAck;
    private handleControlPacket;
    private onHello;
    private onHelloAck;
    /**
     * Adopt a peer ephemeral key and (re)derive the session ciphers. The
     * working endpoint is refreshed on every call; derivation happens
     * only when the ephemeral key is actually new, and `derivedPair`
     * keeps the direct-ready callback to one shot per key pair — hot
     * upgrades (a fresh reprobe from the peer) still fire again.
     */
    private integratePeerEphemeral;
    private completeDirect;
    private onOpenedFrame;
    private sendEncryptedTo;
}
//# sourceMappingURL=punch.d.ts.map