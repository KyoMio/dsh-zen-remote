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
import dgram from 'node:dgram';
import os from 'node:os';
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { derivePeerSessionCiphers, generateEphemeralX25519, verifySelfCertifyingNodeId } from './crypto.js';
import { PeerFrameType, decodeFrameHeader, packEncryptedFrame, unpackEncryptedFrame } from './wire.js';
// -- shared hex/endpoint plumbing --------------------------------------------------
const NODE_ID_PATTERN = /^[0-9a-f]{8}$/;
const NETWORK_ID_PATTERN = /^[0-9a-fA-F]{16}$/;
const HEX16 = /^[0-9a-fA-F]{16}$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const HEX128 = /^[0-9a-fA-F]{128}$/;
const STUN_PROBE_DOMAIN = 'zr-stun-v1';
const PUNCH_DOMAIN = 'zr-punch-v1';
function isIPv4Family(family) {
    return family === 'IPv4' || family === 4;
}
function requireNetworkId(value) {
    if (typeof value !== 'string' || !NETWORK_ID_PATTERN.test(value)) {
        throw new TypeError('networkId must be 16 hex characters');
    }
    return value.toLowerCase();
}
function requireIdentity(value) {
    if (!value || typeof value !== 'object')
        throw new TypeError('identity must be a PeerIdentityKeyPair');
    const record = value;
    if (typeof record.publicKeyHex !== 'string' || !HEX64.test(record.publicKeyHex)) {
        throw new TypeError('identity.publicKeyHex must be 64 hex characters');
    }
    if (typeof record.privateKeyHex !== 'string' || !HEX64.test(record.privateKeyHex)) {
        throw new TypeError('identity.privateKeyHex must be 64 hex characters');
    }
    if (typeof record.nodeId !== 'string' || !NODE_ID_PATTERN.test(record.nodeId)) {
        throw new TypeError('identity.nodeId must be 8 lowercase hex characters');
    }
    return record;
}
/** Split `host:port` (v4-shaped candidates only; the punch path is udp4). */
function parseEndpoint(endpoint) {
    if (typeof endpoint !== 'string')
        return null;
    const colon = endpoint.lastIndexOf(':');
    if (colon <= 0 || colon === endpoint.length - 1)
        return null;
    const host = endpoint.slice(0, colon);
    const portPart = endpoint.slice(colon + 1);
    if (!/^\d+$/.test(portPart))
        return null;
    const port = Number(portPart);
    if (port < 1 || port > 65535)
        return null;
    if (host.length === 0 || /\s/.test(host))
        return null;
    return { host, port };
}
/**
 * All non-loopback IPv4 addresses of `interfaces` as `ip:port` punch
 * candidates. Loopback (internal flag) and IPv6 are useless for
 * punching; link-local 169.254/16 is excluded too — it never routes.
 * RFC1918 and the 100.64.0.0/10 CGNAT range (Tailscale) are the
 * interesting cases and ride along with any public ips.
 */
export function collectLanEndpoints(interfaces, port) {
    const endpoints = [];
    for (const list of Object.values(interfaces)) {
        for (const entry of list ?? []) {
            if (!isIPv4Family(entry.family) || entry.internal)
                continue;
            const address = entry.address;
            if (typeof address !== 'string' || address.startsWith('127.') || address.startsWith('169.254.'))
                continue;
            endpoints.push(`${address}:${port}`);
        }
    }
    return endpoints;
}
/**
 * Which KIND of path does this endpoint represent? `lan` when it is
 * loopback, one of `localIps` exactly, or a private/CGNAT address that
 * shares a /24 with one of our interfaces — i.e. a same-subnet path we
 * can usually reach without any NAT help. Everything else is `p2p`
 * (public reflexive mapping or foreign private nets). Unparseable
 * candidates answer `p2p` — never promoted on a guess.
 */
export function classifyPunchEndpoint(endpoint, localIps) {
    const parsed = parseEndpoint(endpoint);
    if (!parsed)
        return 'p2p';
    const ip = parsed.host;
    if (ip.startsWith('127.'))
        return 'lan';
    if (localIps.includes(ip))
        return 'lan';
    const isPrivate = ip.startsWith('10.')
        || ip.startsWith('192.168.')
        || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
    const isCgnat = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
    if (!isPrivate && !isCgnat)
        return 'p2p';
    const slash24 = (value) => value.split('.').slice(0, 3).join('.');
    return localIps.some((local) => slash24(local) === slash24(ip)) ? 'lan' : 'p2p';
}
function isReflexiveIpLocal(ip) {
    if (ip.startsWith('127.'))
        return true;
    for (const list of Object.values(os.networkInterfaces())) {
        for (const entry of list ?? []) {
            if (isIPv4Family(entry.family) && !entry.internal && entry.address === ip)
                return true;
        }
    }
    return false;
}
/**
 * NAT self-check from ONE freshly bound UDP socket against the
 * gateway's primary port and (when `altPort > 0`) its alternate port.
 * Both ports agree → cone NAT (`public` when the reflexive ip is one
 * of this machine's own addresses — no NAT at all). They disagree →
 * symmetric NAT (per-destination mappings; simple hole punching cannot
 * work). Only the primary answers → `unknown`; nothing answers →
 * `unknown` with a null endpoint.
 */
export async function probeStunNatType(options) {
    const primaryHost = options.primaryHost;
    if (typeof primaryHost !== 'string' || primaryHost.length === 0) {
        throw new TypeError('primaryHost must be a non-empty string');
    }
    if (!Number.isInteger(options.primaryPort) || options.primaryPort < 1 || options.primaryPort > 65535) {
        throw new RangeError('primaryPort must be an integer in [1, 65535]');
    }
    const altPort = options.altPort ?? 0;
    if (!Number.isInteger(altPort) || altPort < 0 || altPort > 65535) {
        throw new RangeError('altPort must be an integer in [0, 65535]');
    }
    const networkId = requireNetworkId(options.networkId);
    const identity = requireIdentity(options.identity);
    const timeoutMs = options.timeoutMs ?? 500;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
        throw new RangeError('timeoutMs must be an integer ≥ 1');
    const socket = dgram.createSocket('udp4');
    socket.on('error', () => { }); // ICMP port-unreachables are routine here; never crash
    try {
        await new Promise((resolve, reject) => {
            const onError = (err) => {
                socket.removeListener('error', onError);
                reject(err);
            };
            socket.once('error', onError);
            socket.bind(0, () => {
                socket.removeListener('error', onError);
                resolve();
            });
        });
        const nonce = randomBytes(8).toString('hex');
        const timestamp = Date.now();
        const message = Buffer.from(`${STUN_PROBE_DOMAIN}|probe|${networkId}|${identity.nodeId}|${nonce}|${timestamp}`, 'utf8');
        const packet = Buffer.from(JSON.stringify({
            zr: 1,
            kind: 'zr-stun-probe',
            networkId,
            nodeId: identity.nodeId,
            publicKeyHex: identity.publicKeyHex,
            nonce,
            timestamp,
            sigHex: ed25519Sign(message, identity),
        }));
        // One socket, two remote ports: the mapping comparison is only
        // meaningful because both probes share the same local endpoint.
        const slots = new Map();
        const replies = new Map();
        let settleEarly = () => { };
        const early = new Promise((resolve) => {
            settleEarly = resolve;
        });
        let timer;
        const deadline = new Promise((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
        });
        socket.on('message', (buf, rinfo) => {
            let parsed;
            try {
                parsed = JSON.parse(buf.toString('utf8'));
            }
            catch {
                return;
            }
            if (!parsed || parsed.zr !== 1 || parsed.kind !== 'zr-stun-reply')
                return;
            if (parsed.nonce !== nonce)
                return;
            const ip = parsed.ip;
            const port = parsed.port;
            if (typeof ip !== 'string' || ip.length === 0)
                return;
            if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535)
                return;
            const slot = slots.get(rinfo.port);
            if (!slot || replies.has(slot))
                return;
            replies.set(slot, { ip, port });
            if (replies.size === slots.size)
                settleEarly();
        });
        const send = (port, slot) => {
            slots.set(port, slot);
            socket.send(packet, port, primaryHost, (err) => {
                if (err)
                    slots.delete(port);
            });
        };
        send(options.primaryPort, 'primary');
        if (altPort > 0)
            send(altPort, 'alt');
        await Promise.race([deadline, early]);
        clearTimeout(timer);
        const primary = replies.get('primary');
        if (!primary)
            return { reflexiveEndpoint: null, natType: 'unknown' };
        const reflexiveEndpoint = `${primary.ip}:${primary.port}`;
        const alt = replies.get('alt');
        if (!alt)
            return { reflexiveEndpoint, natType: 'unknown' };
        if (primary.port !== alt.port)
            return { reflexiveEndpoint, natType: 'symmetric' };
        return { reflexiveEndpoint, natType: isReflexiveIpLocal(primary.ip) ? 'public' : 'cone' };
    }
    finally {
        socket.close();
    }
}
// -- Ed25519 helpers (crypto.ts keeps its JWK round-trips private) -------------------
function ed25519Sign(message, identity) {
    const privateKey = createPrivateKey({
        key: {
            kty: 'OKP',
            crv: 'Ed25519',
            x: Buffer.from(identity.publicKeyHex, 'hex').toString('base64url'),
            d: Buffer.from(identity.privateKeyHex, 'hex').toString('base64url'),
        },
        format: 'jwk',
    });
    return sign(null, message, privateKey).toString('hex');
}
function ed25519Verify(message, publicKeyHex, sigHex) {
    try {
        const publicKey = createPublicKey({
            key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyHex, 'hex').toString('base64url') },
            format: 'jwk',
        });
        return verify(null, message, publicKey, Buffer.from(sigHex, 'hex'));
    }
    catch {
        return false;
    }
}
const realClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
};
/**
 * One UDP socket, many peers. See the module doc for the state machine.
 * After `onDirectReady`, hand `frameSenderFor(peerNodeId)` to an ARQ
 * session as its `sendFrame` and route `onEncryptedFrame` into
 * `handleFrame` — frames and keepalive share one monotonic AEAD
 * sequence per direction, exactly what the frame layer's replay window
 * requires.
 */
export class PeerPunchManager {
    options;
    clock;
    networkId;
    identity;
    socket;
    ownsSocket;
    localIps;
    sessions = new Map();
    lanEndpointList = [];
    closed = false;
    readyPromise;
    constructor(options) {
        this.options = options;
        this.networkId = requireNetworkId(options.networkId);
        this.identity = requireIdentity(options.identity);
        const knob = (value, fallback, name) => {
            const resolved = value ?? fallback;
            if (!Number.isInteger(resolved) || resolved < 1)
                throw new RangeError(`${name} must be an integer ≥ 1`);
            return resolved;
        };
        knob(options.punchIntervalMs, 100, 'punchIntervalMs');
        knob(options.punchRounds, 10, 'punchRounds');
        knob(options.punchWindowMs, 1000, 'punchWindowMs');
        knob(options.reprobeIntervalMs, 60_000, 'reprobeIntervalMs');
        knob(options.keepAliveMs, 5000, 'keepAliveMs');
        knob(options.keepAliveLostFrames, 3, 'keepAliveLostFrames');
        this.clock = options.clock ?? realClock;
        this.localIps = collectLocalIps();
        if (options.socket) {
            this.socket = options.socket;
            this.ownsSocket = false;
        }
        else {
            this.socket = dgram.createSocket('udp4');
            this.ownsSocket = true;
        }
        // Probing dead ports earns ICMP errors on macOS/Windows; routine, never fatal.
        this.socket.on('error', () => { });
        this.socket.on('message', (buf, rinfo) => this.handlePacket(buf, rinfo));
        let boundPort = 0;
        try {
            boundPort = this.socket.address().port;
        }
        catch {
            boundPort = 0;
        }
        if (boundPort > 0) {
            this.refreshLanEndpoints(boundPort);
            this.readyPromise = Promise.resolve();
        }
        else {
            this.readyPromise = new Promise((resolve) => {
                this.socket.once('listening', () => {
                    try {
                        this.refreshLanEndpoints(this.socket.address().port);
                    }
                    finally {
                        resolve();
                    }
                });
            });
            if (this.ownsSocket)
                this.socket.bind({ port: 0, address: options.bindHost ?? undefined });
        }
    }
    /** Resolves once the socket has a bound port (immediately for pre-bound sockets). */
    ready() {
        return this.readyPromise;
    }
    /** This machine's non-loopback IPv4 addresses with our bound port. */
    lanEndpoints() {
        return [...this.lanEndpointList];
    }
    /**
     * Start (or restart) the 1000ms priority punch toward a peer: fresh
     * X25519 key, fresh nonce, HELLOs to every candidate endpoint —
     * round 0 immediately, then one round per `punchIntervalMs` up to
     * `punchRounds` total. On success the window/rounds timers are
     * cancelled; on expiry `onPunchFallback` fires exactly once and the
     * silent reprobe cycle takes over.
     */
    beginPunch(peer) {
        if (this.closed)
            return;
        if (typeof peer.peerNodeId !== 'string' || !NODE_ID_PATTERN.test(peer.peerNodeId.toLowerCase())) {
            throw new TypeError('peerNodeId must be 8 hex characters');
        }
        const nodeId = peer.peerNodeId.toLowerCase();
        if (!verifySelfCertifyingNodeId(nodeId, peer.peerPublicKeyHex)) {
            throw new TypeError('peerNodeId is not the self-certifying hash of peerPublicKeyHex');
        }
        if (nodeId === this.identity.nodeId)
            throw new TypeError('cannot punch ourselves');
        const existing = this.sessions.get(nodeId);
        if (existing) {
            this.clearSessionTimers(existing);
            this.sessions.delete(nodeId);
        }
        const candidates = [];
        const raw = [...(Array.isArray(peer.lanEndpoints) ? peer.lanEndpoints : [])];
        if (peer.reflexiveEndpoint)
            raw.push(peer.reflexiveEndpoint);
        for (const endpoint of raw) {
            if (typeof endpoint === 'string' && parseEndpoint(endpoint) && !candidates.includes(endpoint)) {
                candidates.push(endpoint);
            }
        }
        const session = this.createSession(nodeId, peer.peerPublicKeyHex, candidates);
        this.startPunchRounds(session);
    }
    /**
     * Entry point for every datagram on our socket — sealed frames when a
     * session has ciphers, signed JSON control packets otherwise. Public
     * so tests (and unusual socket wirings) can inject datagrams.
     */
    handlePacket(bytes, rinfo) {
        if (this.closed)
            return;
        const header = decodeFrameHeader(bytes);
        if (header) {
            if (header.dstNodeId !== this.identity.nodeId || header.srcNodeId === this.identity.nodeId)
                return;
            const session = this.sessions.get(header.srcNodeId);
            if (!session?.ciphers)
                return;
            const opened = unpackEncryptedFrame(bytes, session.ciphers);
            if (opened)
                this.onOpenedFrame(session, opened.header, opened.plaintext, rinfo);
            return;
        }
        this.handleControlPacket(bytes, rinfo);
    }
    /**
     * The ARQ seam for an established peer: assign the returned function
     * to a `PeerArqSession.sendFrame`. Every frame (application data and
     * this manager's keepalive alike) takes the next value of one
     * monotonic per-peer AEAD sequence, which is exactly what the frame
     * layer's replay window needs.
     */
    frameSenderFor(peerNodeId) {
        const nodeId = peerNodeId.toLowerCase();
        return (frameType, streamId, payload, ack) => {
            const session = this.sessions.get(nodeId);
            if (!session)
                throw new Error(`no punch session for ${nodeId}`);
            this.sendEncryptedTo(session, frameType, streamId, payload, ack);
        };
    }
    sessionCiphers(peerNodeId) {
        return this.sessions.get(peerNodeId.toLowerCase())?.ciphers ?? null;
    }
    /** Last PING→PONG round trip for the peer, or null before the first PONG. */
    sessionRttMs(peerNodeId) {
        return this.sessions.get(peerNodeId.toLowerCase())?.rttMs ?? null;
    }
    /** Stop everything: per-peer timers cleared, sessions dropped, socket closed. */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const session of this.sessions.values())
            this.clearSessionTimers(session);
        this.sessions.clear();
        try {
            this.socket.close();
        }
        catch {
            // already closed — nothing left to do
        }
    }
    // -- internals -------------------------------------------------------------------
    createSession(nodeId, publicKeyHex, candidates) {
        const session = {
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
        };
        this.sessions.set(nodeId, session);
        return session;
    }
    armTimer(session, fn, ms) {
        const handle = this.clock.setTimeout(() => {
            session.timers.delete(handle);
            fn();
        }, ms);
        session.timers.add(handle);
    }
    clearSessionTimers(session) {
        for (const handle of session.timers)
            this.clock.clearTimeout(handle);
        session.timers.clear();
    }
    refreshLanEndpoints(port) {
        this.lanEndpointList = collectLanEndpoints(os.networkInterfaces(), port);
    }
    startPunchRounds(session) {
        session.state = 'punching';
        // A new round cycle is a new key exchange: invalidate everything
        // derived from the previous ephemeral key.
        session.myEph = generateEphemeralX25519();
        session.nonce = randomBytes(8).toString('hex');
        session.peerEphPubHex = null;
        session.derivedPair = null;
        session.ciphers = null;
        session.rttMs = null;
        let round = 0;
        const fire = () => {
            if (this.closed || session.state !== 'punching')
                return;
            this.sendHellos(session);
            round += 1;
            if (round < this.punchRoundsOrDefault())
                this.armTimer(session, fire, this.punchIntervalMsOrDefault());
        };
        fire();
        this.armTimer(session, () => this.onPunchWindowExpired(session), this.punchWindowMsOrDefault());
    }
    punchIntervalMsOrDefault() {
        return this.options.punchIntervalMs ?? 100;
    }
    punchRoundsOrDefault() {
        return this.options.punchRounds ?? 10;
    }
    punchWindowMsOrDefault() {
        return this.options.punchWindowMs ?? 1000;
    }
    reprobeIntervalMsOrDefault() {
        return this.options.reprobeIntervalMs ?? 60_000;
    }
    keepAliveMsOrDefault() {
        return this.options.keepAliveMs ?? 5000;
    }
    keepAliveLostFramesOrDefault() {
        return this.options.keepAliveLostFrames ?? 3;
    }
    onPunchWindowExpired(session) {
        if (this.closed || session.state !== 'punching')
            return;
        session.state = 'idle';
        this.clearSessionTimers(session); // stop any rounds still armed
        this.options.onPunchFallback?.(session.peerNodeId);
        this.scheduleReprobe(session);
    }
    scheduleReprobe(session) {
        if (this.closed)
            return;
        this.armTimer(session, () => {
            if (this.closed || session.state !== 'idle')
                return;
            this.startPunchRounds(session);
        }, this.reprobeIntervalMsOrDefault());
    }
    startKeepalive(session) {
        const tick = () => {
            if (this.closed || session.state !== 'direct')
                return;
            const silentFor = this.clock.now() - session.lastSeen;
            if (silentFor >= this.keepAliveMsOrDefault() * this.keepAliveLostFramesOrDefault()) {
                session.state = 'idle';
                this.options.onDirectLost?.(session.peerNodeId);
                this.scheduleReprobe(session);
                return;
            }
            session.lastPingSentAt = this.clock.now();
            this.sendEncryptedTo(session, PeerFrameType.PING, 0, randomBytes(8), 0);
            this.armTimer(session, tick, this.keepAliveMsOrDefault());
        };
        this.armTimer(session, tick, this.keepAliveMsOrDefault());
    }
    sendHellos(session) {
        const timestamp = this.clock.now();
        session.lastHelloSentAt = timestamp;
        const message = Buffer.from(`${PUNCH_DOMAIN}|hello|${this.networkId}|${this.identity.nodeId}|${session.myEph.publicKeyHex}|${session.nonce}|${timestamp}`, 'utf8');
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
        }));
        for (const endpoint of session.candidates) {
            const parsed = parseEndpoint(endpoint);
            if (!parsed)
                continue;
            this.socket.send(packet, parsed.port, parsed.host);
        }
    }
    sendHelloAck(session, echoNonce, rinfo) {
        const timestamp = this.clock.now();
        const message = Buffer.from(`${PUNCH_DOMAIN}|ack|${this.networkId}|${this.identity.nodeId}|${session.myEph.publicKeyHex}|${echoNonce}|${timestamp}`, 'utf8');
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
        }));
        this.socket.send(packet, rinfo.port, rinfo.address);
    }
    handleControlPacket(bytes, rinfo) {
        let parsed;
        try {
            parsed = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'));
        }
        catch {
            return;
        }
        if (!parsed || typeof parsed !== 'object' || parsed.zr !== 1)
            return;
        if (parsed.networkId !== this.networkId)
            return;
        const nodeId = typeof parsed.nodeId === 'string' ? parsed.nodeId.toLowerCase() : '';
        if (!NODE_ID_PATTERN.test(nodeId) || nodeId === this.identity.nodeId)
            return;
        if (parsed.kind === 'zr-hello')
            this.onHello(parsed, rinfo);
        else if (parsed.kind === 'zr-hello-ack')
            this.onHelloAck(parsed, rinfo);
    }
    onHello(packet, rinfo) {
        if (typeof packet.publicKeyHex !== 'string' || !HEX64.test(packet.publicKeyHex))
            return;
        if (typeof packet.ephPubHex !== 'string' || !HEX64.test(packet.ephPubHex))
            return;
        if (typeof packet.nonce !== 'string' || !HEX16.test(packet.nonce))
            return;
        if (typeof packet.timestamp !== 'number' || !Number.isInteger(packet.timestamp))
            return;
        if (typeof packet.sigHex !== 'string' || !HEX128.test(packet.sigHex))
            return;
        const nodeId = packet.nodeId.toLowerCase();
        if (!verifySelfCertifyingNodeId(nodeId, packet.publicKeyHex))
            return;
        const message = Buffer.from(`${PUNCH_DOMAIN}|hello|${this.networkId}|${nodeId}|${packet.ephPubHex}|${packet.nonce}|${packet.timestamp}`, 'utf8');
        if (!ed25519Verify(message, packet.publicKeyHex, packet.sigHex))
            return;
        const session = this.ensureSession(nodeId, packet.publicKeyHex, [`${rinfo.address}:${rinfo.port}`]);
        if (!session)
            return;
        // Answer FIRST — the peer's RTT clock is already running.
        this.sendHelloAck(session, packet.nonce, rinfo);
        this.integratePeerEphemeral(session, packet.ephPubHex, rinfo);
    }
    onHelloAck(packet, rinfo) {
        if (typeof packet.publicKeyHex !== 'string' || !HEX64.test(packet.publicKeyHex))
            return;
        if (typeof packet.ephPubHex !== 'string' || !HEX64.test(packet.ephPubHex))
            return;
        if (typeof packet.nonce !== 'string' || !HEX16.test(packet.nonce))
            return;
        if (typeof packet.timestamp !== 'number' || !Number.isInteger(packet.timestamp))
            return;
        if (typeof packet.sigHex !== 'string' || !HEX128.test(packet.sigHex))
            return;
        const nodeId = packet.nodeId.toLowerCase();
        const session = this.sessions.get(nodeId);
        // Key pinning: the ack must come from the identity we set out to reach.
        if (!session || session.peerPublicKeyHex !== packet.publicKeyHex)
            return;
        // The echoed nonce binds this ack to OUR current round; stale rounds die here.
        if (packet.nonce !== session.nonce)
            return;
        const message = Buffer.from(`${PUNCH_DOMAIN}|ack|${this.networkId}|${nodeId}|${packet.ephPubHex}|${packet.nonce}|${packet.timestamp}`, 'utf8');
        if (!ed25519Verify(message, packet.publicKeyHex, packet.sigHex))
            return;
        if (typeof session.lastHelloSentAt === 'number') {
            session.rttMs = Math.max(0, this.clock.now() - session.lastHelloSentAt);
        }
        this.integratePeerEphemeral(session, packet.ephPubHex, rinfo);
    }
    ensureSession(nodeId, publicKeyHex, candidates) {
        const existing = this.sessions.get(nodeId);
        if (existing) {
            // Key pinning: one nodeId is bound to the key the gateway (or the
            // first valid handshake) told us about. A different key is an
            // impostor — the id is the hash of the key, so both cannot be right.
            return existing.peerPublicKeyHex === publicKeyHex ? existing : null;
        }
        return this.createSession(nodeId, publicKeyHex, candidates);
    }
    /**
     * Adopt a peer ephemeral key and (re)derive the session ciphers. The
     * working endpoint is refreshed on every call; derivation happens
     * only when the ephemeral key is actually new, and `derivedPair`
     * keeps the direct-ready callback to one shot per key pair — hot
     * upgrades (a fresh reprobe from the peer) still fire again.
     */
    integratePeerEphemeral(session, peerEphPubHex, rinfo) {
        session.endpoint = `${rinfo.address}:${rinfo.port}`;
        if (session.peerEphPubHex === peerEphPubHex)
            return;
        session.peerEphPubHex = peerEphPubHex;
        const ciphers = derivePeerSessionCiphers({
            networkId: this.networkId,
            myNodeId: this.identity.nodeId,
            peerNodeId: session.peerNodeId,
            myEphPrivateKeyHex: session.myEph.privateKeyHex,
            myEphPublicKeyHex: session.myEph.publicKeyHex,
            peerEphPublicKeyHex: peerEphPubHex,
        });
        session.ciphers = ciphers;
        const pairKey = `${session.myEph.publicKeyHex}|${peerEphPubHex}`;
        if (session.derivedPair === pairKey)
            return;
        session.derivedPair = pairKey;
        this.completeDirect(session, ciphers);
    }
    completeDirect(session, ciphers) {
        session.state = 'direct';
        session.lastSeen = this.clock.now();
        this.clearSessionTimers(session); // punch rounds / window / pending reprobe all die
        this.startKeepalive(session);
        const endpoint = session.endpoint ?? '';
        this.options.onDirectReady?.(session.peerNodeId, {
            mode: classifyPunchEndpoint(endpoint, this.localIps),
            endpoint,
            rttMs: session.rttMs ?? 0,
            ciphers,
        });
    }
    onOpenedFrame(session, header, plaintext, rinfo) {
        session.lastSeen = this.clock.now();
        // Any authenticated frame refreshes the peer's current endpoint —
        // a roaming phone behind NAT gets followed automatically.
        session.endpoint = `${rinfo.address}:${rinfo.port}`;
        if (header.frameType === PeerFrameType.PING) {
            if (session.state === 'direct') {
                this.sendEncryptedTo(session, PeerFrameType.PONG, 0, Buffer.from(plaintext), 0);
            }
            return;
        }
        if (header.frameType === PeerFrameType.PONG) {
            if (session.lastPingSentAt !== null) {
                session.rttMs = Math.max(0, this.clock.now() - session.lastPingSentAt);
                session.lastPingSentAt = null;
            }
            return;
        }
        this.options.onEncryptedFrame?.(header, plaintext, rinfo);
    }
    sendEncryptedTo(session, frameType, streamId, payload, ack) {
        if (this.closed)
            throw new Error('punch manager closed');
        if (!session.ciphers)
            throw new Error(`no established session for ${session.peerNodeId}`);
        const endpoint = session.endpoint;
        if (!endpoint)
            throw new Error(`no known endpoint for ${session.peerNodeId}`);
        const parsed = parseEndpoint(endpoint);
        if (!parsed)
            throw new Error(`malformed endpoint ${endpoint}`);
        const seq = session.frameSeq++;
        const frame = packEncryptedFrame({
            frameType,
            srcNodeId: this.identity.nodeId,
            dstNodeId: session.peerNodeId,
            streamId,
            seq,
            ack,
        }, payload, session.ciphers);
        this.socket.send(frame, parsed.port, parsed.host);
    }
}
function collectLocalIps() {
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const entry of list ?? []) {
            if (isIPv4Family(entry.family) && !entry.internal)
                ips.push(entry.address);
        }
    }
    return ips;
}
//# sourceMappingURL=punch.js.map