/**
 * PeerMux — 虚拟 HTTP-over-E2EE 多路复用（PG-8，tasks/peer-gateway/PG-8.md）。
 * 每个 engine 一个 {@link PeerMux}：对每个对端在**一套** ARQ 会话上跑多条
 * 双向流，并把普通 `fetch(url, init)` 的两端适配上去，让原生 `RelayClient`
 * 把远端 peer 的 `relayHandler` 当作一个 HTTP 源站访问。
 *
 * 路径无关（本模块的承重墙）：每个帧都从 `PeerArqSession` 的唯一 `sendFrame`
 * 接缝发出，而该接缝在**每次（重）发送时**读取会话的当前路径：
 *
 *   - `udp` — 打洞层的 `frameSenderFor`（帧用打洞握手的密码器封口；对端的
 *     punch 用同一套密码器开封后把明文交给 mux）；
 *   - `ws`  — mux 用「网关中转握手」的密码器自己封口，网关按 28B 明文头路由、
 *     永远看不到载荷明文。
 *
 * 1000ms 打洞失败（或之后的 `onDirectLost`）把路径切到 `ws`；UDP 随后打通时
 * 路径切回，在途 ARQ 分片直接沿新物理路径重传——流毫无察觉。物理路径重建、
 * 新握手尚未完成的瞬态里，底层发送可能未就绪：这里**捕获并丢弃该次发送**，
 * 由 ARQ 重传定时器在路径恢复后自动补发，绝不让同步抛错崩掉流。
 *
 * 网关中转握手沿用 UDP 路径的同一套已签名 `zr-punch-v1` hello/ack JSON，
 * 外面套 28B 路由头（`HELLO`，streamId 0，明文载荷）让网关能路由而无需解密。
 * DATA/SACK/ACK/RST/PING/PONG 永远走密封载荷——`(HELLO, streamId 0)` 形态因此
 * 无歧义。载荷不足 44B（网关中转的最小帧）时补零，接收侧剥掉。
 *
 * 流内协议（一条 ARQ 流内）：
 *
 *     发起方 → 应答方   分片 0：`{"t":"req","m":method,"p":path,"h":{…}}`
 *                       分片 1+：请求体原始字节，FIN 结束
 *     应答方 → 发起方   分片 0：`{"t":"res","s":status,"st":statusText,"h":{…}}`
 *                       分片 1+：响应体原始字节，FIN 结束
 *     任意一侧 RST 即中止该流（对端 req/res 被销毁）
 *
 * 两端都可能发起 fetch：nodeId 字典序较小的一方分配奇数 streamId，较大一方
 * 分配偶数，永不冲突。双向 FIN 或 RST 之后流表条目立即清理，不长期驻留。
 */
import { randomBytes } from 'node:crypto';
import { ServerResponse } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { PeerArqSession } from './arq.js';
import { derivePeerSessionCiphers, generateEphemeralX25519, verifySelfCertifyingNodeId, } from './crypto.js';
import { ed25519Sign, ed25519Verify, PUNCH_DOMAIN } from './punch.js';
import { decodeFrameHeader, encodeFrameHeader, packEncryptedFrame, PEER_FRAME_MAGIC, PEER_FRAME_VERSION, PeerFrameType, unpackEncryptedFrame, } from './wire.js';
const NODE_ID_PATTERN = /^[0-9a-f]{8}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
/** hello/ack envelope 的时间戳新鲜度窗口。 */
const ENVELOPE_TTL_MS = 30_000;
/** 网关中转的最小帧长：28B 头 + 16B（AEAD tag 起步）。明文 envelope 也必须够长。 */
const GATEWAY_MIN_FRAME_BYTES = 44;
/** WS hello envelope 的重发节奏（TCP 可靠，这里只兜握手竞态与迟到坐标）。 */
const HELLO_RETRY_MS = 400;
const HELLO_RETRY_MAX = 6;
const BODY_HIGH_WATER_BYTES = 64 * 1024;
const ADMISSION_CHUNK_BYTES = 16 * 1024;
const MAX_META_BYTES = 65_536;
const realClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
};
export class PeerMux {
    options;
    clock;
    sessions = new Map();
    /** 对端会话拆建后延续单调递增的 streamId，避免复用对端已退休的 streamId。 */
    nextStreamIds = new Map();
    closed = false;
    constructor(options) {
        this.options = options;
        this.clock = options.clock ?? realClock;
    }
    // ------------------------------------------------------------ 会话
    /** 为一个已通过 TOFU 的对端建立（或复用）mux 会话。 */
    ensureSession(nodeId, peerPublicKeyHex, peerName) {
        const id = nodeId.toLowerCase();
        if (this.closed)
            return;
        if (this.sessions.has(id))
            return;
        if (!NODE_ID_PATTERN.test(id))
            throw new TypeError('nodeId must be 8 hex characters');
        if (!verifySelfCertifyingNodeId(id, peerPublicKeyHex)) {
            throw new TypeError('peerNodeId is not the self-certifying hash of peerPublicKeyHex');
        }
        const session = {
            nodeId: id,
            peerPublicKeyHex,
            peerName,
            path: 'none',
            ciphers: null,
            myEph: null,
            nonce: null,
            peerEphPubHex: null,
            seq: 0n,
            envelopeSeq: 0n,
            arq: new PeerArqSession({
                sendFrame: (frameType, streamId, payload, ack) => this.dispatchFrame(session, frameType, streamId, payload, ack),
                onStreamData: (streamId, chunk, final) => this.onStreamData(session, streamId, chunk, final),
                clock: this.clock,
                onAdmissionClosed: error => this.options.log?.(`mux: ${session.nodeId}: ${error.message}`),
                onStreamClosed: (streamId, error) => {
                    const stream = session.streams.get(streamId);
                    if (!stream)
                        return;
                    stream.removeAbortListener?.();
                    stream.removeAbortListener = null;
                    if (error)
                        this.abortStream(session, stream, error);
                    else
                        session.streams.delete(streamId);
                },
            }),
            punchSender: null,
            streams: new Map(),
            // 奇偶发起权：nodeId 字典序较小一方用奇数流 id，较大一方用偶数；若同进程内曾拆掉过会话则接着涨。
            nextStreamId: this.nextStreamIds.get(id) ?? (id < this.options.identity.nodeId ? 1 : 2),
            helloTimer: null,
            helloTries: 0,
            closed: false,
        };
        this.sessions.set(id, session);
    }
    /** 更新已建会话记录的对端设备名（入站虚拟请求 x-zen-remote-device-name 跟随最新名称）。 */
    setPeerName(nodeId, peerName) {
        const session = this.sessions.get(nodeId.toLowerCase());
        if (session && peerName.trim() !== '')
            session.peerName = peerName.trim();
    }
    /** 拆掉一个对端的会话（peer-left / mismatch / 本机禁用）：流中止、表清理。 */
    dropSession(nodeId) {
        const session = this.sessions.get(nodeId.toLowerCase());
        if (!session)
            return;
        this.nextStreamIds.set(session.nodeId, session.nextStreamId);
        this.clearHelloTimer(session);
        session.closed = true;
        session.arq.closeAll();
        for (const stream of [...session.streams.values()]) {
            this.abortStream(session, stream, new Error('peer session closed'));
        }
        session.streams.clear();
        this.sessions.delete(session.nodeId);
        if (session.path !== 'none') {
            session.path = 'none';
            this.options.onPathChanged?.(session.nodeId, 'none');
        }
    }
    hasSession(nodeId) {
        return this.sessions.has(nodeId.toLowerCase());
    }
    sessionPath(nodeId) {
        return this.sessions.get(nodeId.toLowerCase())?.path ?? 'none';
    }
    /** 存活会话 id（诊断用）。 */
    sessionIds() {
        return [...this.sessions.keys()];
    }
    /** 拆掉全部会话并拒绝所有在途交换（engine stop / 退网）。 */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const nodeId of [...this.sessions.keys()])
            this.dropSession(nodeId);
    }
    // ------------------------------------------------------------ 路径与握手
    /**
     * 打洞窗口过期（或直连路径事后失效）：把 WS 中转路径备好——还没有中转
     * 密码器就现在跑网关中转握手；已有则直接把路径落在 `ws`。
     */
    enableRelayPath(nodeId) {
        const session = this.sessions.get(nodeId.toLowerCase());
        if (!session || session.closed || this.closed)
            return;
        if (session.ciphers !== null) {
            if (session.path !== 'ws') {
                const before = session.path;
                session.path = 'ws';
                if (before === 'none')
                    session.arq.flushInflight();
                this.options.onPathChanged?.(session.nodeId, 'ws');
            }
            return;
        }
        this.beginHello(session);
    }
    /** 打洞握手完成：接上打洞层的发送接缝，路径切到 UDP。 */
    setDirectPath(nodeId, sender) {
        const session = this.sessions.get(nodeId.toLowerCase());
        if (!session || session.closed || this.closed)
            return;
        session.punchSender = sender;
        const before = session.path;
        session.path = 'udp';
        if (before === 'none')
            session.arq.flushInflight();
        if (before !== 'udp')
            this.options.onPathChanged?.(session.nodeId, 'udp');
    }
    /** 直连路径死亡（keepalive 掉线）：帧改走网关 WS 中转。 */
    setRelayPath(nodeId) {
        const session = this.sessions.get(nodeId.toLowerCase());
        if (!session || session.closed || this.closed)
            return;
        const before = session.path;
        session.path = session.ciphers !== null ? 'ws' : 'none';
        if (session.path === 'none')
            this.beginHello(session);
        else if (before === 'none')
            session.arq.flushInflight();
        if (before !== session.path)
            this.options.onPathChanged?.(session.nodeId, session.path);
    }
    // ------------------------------------------------------------ 帧入口
    /**
     * UDP 路径的一个**已开封**帧（punch 层用它自己的握手密码器开完才交进来）。
     * UDP 路径上的 hello/ack 由 punch 自己消化，永远到不了这里——这里只有
     * ARQ 层的帧。
     */
    handleOpenedFrame(header, plaintext) {
        const session = this.sessions.get(header.srcNodeId);
        if (!session || session.closed)
            return;
        try {
            session.arq.handleFrame(header.frameType, header.streamId, plaintext, header.ack);
        }
        catch {
            // ARQ 内部的重发可能撞上未就绪路径（dispatchFrame 抛错）——RTO 定时器
            // 会重试，单帧丢失可恢复；绝不能让同步抛错穿回 punch 的事件层。
        }
    }
    /**
     * 网关 WS 中转的一个二进制帧。两种形态：
     *  - (HELLO, streamId 0)：明文 `zr-punch-v1` 控制信封——WS 中转握手的半边；
     *  - 其余：中转握手密码器密封的帧，在这里开封。
     */
    handleGatewayFrame(bytes) {
        const header = decodeFrameHeader(bytes);
        if (header === null)
            return;
        const session = this.sessions.get(header.srcNodeId);
        if (!session || session.closed)
            return;
        if (header.frameType === PeerFrameType.HELLO && header.streamId === 0) {
            this.handleEnvelope(session, bytes.subarray(28));
            return;
        }
        if (session.ciphers === null)
            return;
        const opened = unpackEncryptedFrame(bytes, session.ciphers);
        if (opened === null)
            return;
        try {
            session.arq.handleFrame(opened.header.frameType, opened.header.streamId, opened.plaintext, opened.header.ack);
        }
        catch {
            // 同 handleOpenedFrame：重发撞上未就绪路径可由 RTO 恢复，不外抛。
        }
    }
    // ------------------------------------------------------------ fetch 适配
    /**
     * 出站虚拟 HTTP 适配：绑定一个对端的原生 `fetch(url, init)`。应答带
     * `ReadableStream` 体；`init.signal` 中止会对远端流发 RST。
     */
    createFetchForPeer(nodeId) {
        const id = nodeId.toLowerCase();
        return (url, init) => {
            const session = this.sessions.get(id);
            if (!session || session.closed || this.closed) {
                return Promise.reject(new Error(`no peer mux session for ${id}`));
            }
            const urlString = url instanceof globalThis.Request ? url.url : String(url);
            let parsed;
            try {
                parsed = new URL(urlString);
            }
            catch {
                return Promise.reject(new Error(`peer mux fetch: malformed url ${urlString}`));
            }
            const pathWithQuery = `${parsed.pathname}${parsed.search}`;
            const method = (init?.method ?? (url instanceof globalThis.Request ? url.method : 'GET') ?? 'GET').toUpperCase();
            const headers = flattenHeaders(init?.headers);
            const streamId = session.nextStreamId;
            session.nextStreamId += 2;
            const stream = newStream(streamId, true);
            session.streams.set(streamId, stream);
            let settled = false;
            return new Promise((resolve, reject) => {
                stream.responseResolve = (meta) => {
                    if (settled)
                        return;
                    try {
                        const resHeaders = new Headers();
                        for (const [name, value] of Object.entries(meta.headers)) {
                            // Response 自己管传输编码与长度；逐跳头不进适配层。
                            if (name === 'transfer-encoding' || name === 'content-length' || name === 'connection' || name === 'keep-alive')
                                continue;
                            resHeaders.set(name, value);
                        }
                        const body = method === 'HEAD' || [204, 205, 304].includes(meta.status) ? null : new ReadableStream({
                            start: (controller) => {
                                stream.bodyController = controller;
                            },
                            pull: () => { session.arq.resume(streamId); },
                            cancel: () => {
                                this.resetStream(session, stream);
                            },
                        }, { highWaterMark: BODY_HIGH_WATER_BYTES, size: chunk => chunk.byteLength });
                        const response = new Response(body, { status: meta.status, statusText: meta.statusText, headers: resHeaders });
                        // Commit only after validation: constructor failures must reject fetch.
                        settled = true;
                        stream.responseResolved = true;
                        resolve(response);
                    }
                    catch (error) {
                        this.resetStream(session, stream, error instanceof Error ? error : new Error(String(error)));
                    }
                };
                stream.responseReject = (err) => {
                    if (settled)
                        return;
                    settled = true;
                    reject(err);
                };
                const body = init?.body ?? (url instanceof globalThis.Request ? url.body : null);
                if (body && typeof body.getReader === 'function')
                    stream.bodySource = body;
                const onAbort = () => {
                    this.resetStream(session, stream, new Error('the caller aborted the request'));
                    if (stream.bodyController !== null) {
                        try {
                            stream.bodyController.error(new Error('aborted'));
                        }
                        catch { /* already errored */ }
                    }
                };
                const signal = init?.signal;
                if (signal !== undefined && signal !== null) {
                    if (signal.aborted) {
                        onAbort();
                        return;
                    }
                    signal.addEventListener('abort', onAbort, { once: true });
                    stream.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
                }
                const run = async () => {
                    const metaBytes = Buffer.from(`${JSON.stringify({ t: 'req', m: method, p: pathWithQuery, h: headers })}\n`, 'utf8');
                    await this.writeArq(session, stream, metaBytes);
                    if (session.streams.get(streamId) !== stream)
                        throw new Error('upload aborted before body admission');
                    if (body !== null && body !== undefined) {
                        if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) {
                            const bytes = typeof body === 'string' ? Buffer.from(body) : body instanceof Uint8Array ? body : new Uint8Array(body);
                            await this.writeArq(session, stream, bytes);
                        }
                        else {
                            const source = typeof body.getReader === 'function'
                                ? body : new Response(body).body;
                            stream.bodySource = source;
                            const reader = source.getReader();
                            stream.bodyReader = reader;
                            try {
                                for (;;) {
                                    const { done, value } = await reader.read();
                                    if (session.streams.get(streamId) !== stream)
                                        throw new Error('upload aborted during read');
                                    if (done)
                                        break;
                                    await this.writeArq(session, stream, value);
                                }
                            }
                            finally {
                                reader.releaseLock();
                                stream.bodyReader = null;
                                stream.bodySource = null;
                            }
                        }
                    }
                    if (!stream.outboundFinished && session.streams.get(streamId) === stream) {
                        stream.outboundFinished = true;
                        await session.arq.finish(streamId);
                    }
                };
                run().catch((err) => {
                    this.resetStream(session, stream, err instanceof Error ? err : new Error(String(err)));
                });
            });
        };
    }
    // ------------------------------------------------------------ 内部
    /** Pipeline into a bounded byte budget; await capacity, never each frame's RTT. */
    async writeArq(session, stream, bytes) {
        for (let offset = 0; offset < bytes.byteLength; offset += ADMISSION_CHUNK_BYTES) {
            const part = bytes.subarray(offset, offset + ADMISSION_CHUNK_BYTES);
            for (;;) {
                if (session.closed || session.streams.get(stream.streamId) !== stream)
                    throw new Error('mux stream closed');
                if (session.arq.tryWrite(stream.streamId, part))
                    break;
                await session.arq.waitWritable(stream.streamId, part.byteLength);
            }
        }
    }
    /**
     * ARQ 的 sendFrame 接缝：发送时读取当前路径。UDP → punch 层封口；WS →
     * mux 用中转握手密码器封口经网关发出；两者都未就绪 → 抛错（上层捕获丢弃）。
     */
    dispatchFrame(session, frameType, streamId, payload, ack) {
        if (session.closed || this.closed)
            throw new Error('mux session closed');
        if (session.path === 'udp' && session.punchSender !== null) {
            session.punchSender(frameType, streamId, payload, ack);
            return;
        }
        if (session.ciphers !== null) {
            const seq = session.seq;
            session.seq = seq + 1n;
            const frame = packEncryptedFrame({
                frameType,
                srcNodeId: this.options.identity.nodeId,
                dstNodeId: session.nodeId,
                streamId,
                seq,
                ack,
            }, payload, session.ciphers);
            this.options.sendGatewayBinary?.(frame);
            return;
        }
        throw new Error(`no path ready for peer ${session.nodeId}`);
    }
    // ---- 网关中转握手（zr-punch-v1 hello/ack 明文信封） -----------------
    beginHello(session) {
        if (session.closed || this.closed)
            return;
        if (session.helloTimer !== null)
            return; // 握手已在途
        ensureMyEphemeral(session);
        if (session.nonce === null)
            session.nonce = randomBytes(8).toString('hex');
        session.helloTries = 0;
        const tick = () => {
            session.helloTimer = null;
            if (session.closed || this.closed || session.nonce === null)
                return;
            session.helloTries += 1;
            if (session.helloTries > HELLO_RETRY_MAX) {
                session.nonce = null;
                return;
            }
            session.helloTimer = this.clock.setTimeout(tick, HELLO_RETRY_MS);
            this.sendHelloEnvelope(session);
        };
        // Arm before sending: synchronous test/loopback delivery may consume nonce.
        session.helloTimer = this.clock.setTimeout(tick, HELLO_RETRY_MS);
        this.sendHelloEnvelope(session);
    }
    clearHelloTimer(session) {
        if (session.helloTimer !== null) {
            this.clock.clearTimeout(session.helloTimer);
            session.helloTimer = null;
        }
    }
    /** `28B 头（HELLO, streamId 0）+ 签名 zr-punch-v1 hello JSON`，网关原样路由。 */
    sendHelloEnvelope(session) {
        const myEph = session.myEph;
        const nonce = session.nonce;
        if (myEph === null || nonce === null)
            return;
        const timestamp = this.clock.now();
        const message = Buffer.from(`${PUNCH_DOMAIN}|hello|${this.options.networkId}|${this.options.identity.nodeId}|${myEph.publicKeyHex}|${nonce}|${timestamp}`, 'utf8');
        this.sendEnvelope(session, Buffer.from(JSON.stringify({
            zr: 1,
            kind: 'zr-hello',
            networkId: this.options.networkId,
            nodeId: this.options.identity.nodeId,
            publicKeyHex: this.options.identity.publicKeyHex,
            ephPubHex: myEph.publicKeyHex,
            nonce,
            timestamp,
            sigHex: ed25519Sign(message, this.options.identity),
        }), 'utf8'));
    }
    sendHelloAckEnvelope(session, echoNonce) {
        const myEph = session.myEph;
        if (myEph === null)
            return;
        const timestamp = this.clock.now();
        const message = Buffer.from(`${PUNCH_DOMAIN}|ack|${this.options.networkId}|${this.options.identity.nodeId}|${myEph.publicKeyHex}|${echoNonce}|${timestamp}`, 'utf8');
        this.sendEnvelope(session, Buffer.from(JSON.stringify({
            zr: 1,
            kind: 'zr-hello-ack',
            networkId: this.options.networkId,
            nodeId: this.options.identity.nodeId,
            publicKeyHex: this.options.identity.publicKeyHex,
            ephPubHex: myEph.publicKeyHex,
            nonce: echoNonce,
            timestamp,
            sigHex: ed25519Sign(message, this.options.identity),
        }), 'utf8'));
    }
    sendEnvelope(session, payload) {
        const seq = session.envelopeSeq;
        session.envelopeSeq = seq + 1n;
        const header = encodeFrameHeader({
            magic: PEER_FRAME_MAGIC,
            version: PEER_FRAME_VERSION,
            frameType: PeerFrameType.HELLO,
            srcNodeId: this.options.identity.nodeId,
            dstNodeId: session.nodeId,
            streamId: 0,
            seq,
            ack: 0,
        });
        // 网关只路由不解密，但最小帧长必须满足（28+16）；不足补零，接收侧剥掉。
        const pad = Math.max(0, GATEWAY_MIN_FRAME_BYTES - header.length - payload.length);
        this.options.sendGatewayBinary?.(Buffer.concat([header, payload, Buffer.alloc(pad)]));
    }
    /** 一个入站 envelope（HELLO, streamId 0）：hello→应答+整合；ack→整合。 */
    handleEnvelope(session, payloadBytes) {
        let parsed;
        try {
            const text = Buffer.from(payloadBytes).toString('utf8').replace(/\x00+$/, '');
            parsed = JSON.parse(text);
        }
        catch {
            return;
        }
        if (!parsed || parsed.zr !== 1)
            return;
        const nodeId = typeof parsed.nodeId === 'string' ? parsed.nodeId.toLowerCase() : '';
        const publicKeyHex = typeof parsed.publicKeyHex === 'string' ? parsed.publicKeyHex : '';
        // 键锚定：信封必须来自我们会话锚定的那把钥。
        if (nodeId !== session.nodeId || !HEX64.test(publicKeyHex) || publicKeyHex !== session.peerPublicKeyHex)
            return;
        if (parsed.networkId !== this.options.networkId)
            return;
        const ephPubHex = typeof parsed.ephPubHex === 'string' ? parsed.ephPubHex : '';
        const nonce = typeof parsed.nonce === 'string' ? parsed.nonce : '';
        const timestamp = typeof parsed.timestamp === 'number' ? parsed.timestamp : 0;
        const sigHex = typeof parsed.sigHex === 'string' ? parsed.sigHex : '';
        if (!HEX64.test(ephPubHex) || nonce === '' || !Number.isInteger(timestamp) || !HEX128.test(sigHex))
            return;
        if (Math.abs(this.clock.now() - timestamp) > ENVELOPE_TTL_MS)
            return;
        if (parsed.kind === 'zr-hello') {
            const message = Buffer.from(`${PUNCH_DOMAIN}|hello|${this.options.networkId}|${nodeId}|${ephPubHex}|${nonce}|${timestamp}`, 'utf8');
            if (!ed25519Verify(message, publicKeyHex, sigHex))
                return;
            // 先应答——对端正等着 ack 完成握手。
            ensureMyEphemeral(session);
            this.sendHelloAckEnvelope(session, nonce);
            // HELLO is replayable within its TTL. Only a fresh challenge response
            // may replace the working key; keep our DH key stable for old peers.
            if (session.peerEphPubHex !== ephPubHex || session.ciphers === null)
                this.beginHello(session);
            return;
        }
        if (parsed.kind === 'zr-hello-ack') {
            // 回显 nonce 把 ack 绑定到我们在途的那一轮 hello。
            if (session.nonce === null || nonce !== session.nonce)
                return;
            const message = Buffer.from(`${PUNCH_DOMAIN}|ack|${this.options.networkId}|${nodeId}|${ephPubHex}|${nonce}|${timestamp}`, 'utf8');
            if (!ed25519Verify(message, publicKeyHex, sigHex))
                return;
            this.integratePeerEphemeral(session, ephPubHex);
        }
    }
    /** 采用对端临时钥：每个新 (my, peer) 对只派生一次中转密码器。 */
    integratePeerEphemeral(session, peerEphPubHex) {
        if (session.closed)
            return;
        if (session.peerEphPubHex === peerEphPubHex && session.ciphers !== null) {
            session.nonce = null;
            this.clearHelloTimer(session);
            return;
        }
        const myEph = session.myEph;
        if (myEph === null)
            return; // 不会发生：hello/ack 两侧都有各自的临时钥
        let ciphers;
        try {
            ciphers = derivePeerSessionCiphers({
                networkId: this.options.networkId,
                myNodeId: this.options.identity.nodeId,
                peerNodeId: session.nodeId,
                myEphPrivateKeyHex: myEph.privateKeyHex,
                myEphPublicKeyHex: myEph.publicKeyHex,
                peerEphPublicKeyHex: peerEphPubHex,
            });
        }
        catch {
            return; // Signed but invalid/low-order DH key; retain the established cipher.
        }
        session.peerEphPubHex = peerEphPubHex;
        session.ciphers = ciphers;
        session.nonce = null; // consume only after successful derivation
        this.clearHelloTimer(session);
        this.options.log?.(`mux: relay handshake complete for ${session.nodeId} (path=${session.path})`);
        if (session.path === 'none') {
            session.path = 'ws';
            session.arq.flushInflight();
            this.options.onPathChanged?.(session.nodeId, 'ws');
        }
    }
    // ---- ARQ → 流 ------------------------------------------------------
    /** ARQ 顺序送达的一个入站分片（0 = 元数据，1+ = 体，fin = 结束）。 */
    onStreamData(session, streamId, chunk, final) {
        const stream = session.streams.get(streamId);
        if (!stream) {
            this.openInbound(session, streamId, chunk, final);
            return true;
        }
        // Refuse BEFORE any parse/enqueue/push side effect. push(false) itself
        // accepts bytes, so only the next delivery is stalled.
        if (stream.inboundMetaDone && chunk.byteLength > 0) {
            if (stream.bodyController && (stream.bodyController.desiredSize ?? 0) < chunk.byteLength)
                return false;
            if (stream.req && stream.req.readableLength >= BODY_HIGH_WATER_BYTES)
                return false;
        }
        this.onFragment(session, stream, chunk, final);
        return true;
    }
    /** 单个入站分片的按向处理（ARQ 已保证顺序，元数据支持跨分片与换行定界）。 */
    onFragment(session, stream, chunk, final) {
        if (stream.initiator) {
            // 应答方 → 发起方：首段为响应元数据（以 \n 定界，兼容旧单包无 \n JSON），其余为响应体。
            if (!stream.inboundMetaDone) {
                stream.inboundMetaBuf = stream.inboundMetaBuf.length === 0
                    ? Buffer.from(chunk)
                    : Buffer.concat([stream.inboundMetaBuf, chunk]);
                const nl = stream.inboundMetaBuf.indexOf(0x0a);
                let meta = null;
                let remainder = Buffer.alloc(0);
                if (nl >= 0) {
                    meta = parseResponseMeta(stream.inboundMetaBuf.subarray(0, nl));
                    remainder = stream.inboundMetaBuf.subarray(nl + 1);
                    if (meta === null) {
                        this.resetStream(session, stream, new Error('malformed peer response metadata'));
                        return;
                    }
                }
                else {
                    meta = parseResponseMeta(stream.inboundMetaBuf);
                    if (meta === null) {
                        if (final || stream.inboundMetaBuf.length > MAX_META_BYTES) {
                            this.resetStream(session, stream, new Error('malformed peer response metadata'));
                        }
                        return;
                    }
                }
                stream.inboundMetaDone = true;
                stream.inboundMetaBuf = Buffer.alloc(0);
                stream.responseResolve?.(meta);
                stream.responseResolve = null;
                if (remainder.length > 0 && stream.bodyController !== null) {
                    enqueueInto(stream.bodyController, remainder);
                }
            }
            else if (stream.bodyController !== null && chunk.byteLength > 0) {
                enqueueInto(stream.bodyController, chunk);
            }
            if (final) {
                stream.inboundFinished = true;
                closeController(stream.bodyController);
                stream.bodyController = null;
            }
            return;
        }
        // 发起方 → 应答方：首段为请求元数据（以 \n 定界，兼容旧单包无 \n JSON），其余为请求体。
        if (!stream.inboundMetaDone) {
            stream.inboundMetaBuf = stream.inboundMetaBuf.length === 0
                ? Buffer.from(chunk)
                : Buffer.concat([stream.inboundMetaBuf, chunk]);
            const nl = stream.inboundMetaBuf.indexOf(0x0a);
            let meta = null;
            let remainder = Buffer.alloc(0);
            if (nl >= 0) {
                meta = parseRequestMeta(stream.inboundMetaBuf.subarray(0, nl));
                remainder = stream.inboundMetaBuf.subarray(nl + 1);
                if (meta === null) {
                    this.resetStream(session, stream);
                    return;
                }
            }
            else {
                meta = parseRequestMeta(stream.inboundMetaBuf);
                if (meta === null) {
                    if (final || stream.inboundMetaBuf.length > MAX_META_BYTES) {
                        this.resetStream(session, stream);
                    }
                    return;
                }
            }
            stream.inboundMetaDone = true;
            stream.inboundMetaBuf = Buffer.alloc(0);
            this.options.log?.(`mux: inbound request ${meta.m} ${meta.p} from ${session.nodeId} on stream ${stream.streamId}`);
            this.materializeInboundRequest(session, stream, meta);
            if (remainder.length > 0 && stream.req !== null) {
                stream.req.push(Buffer.from(remainder));
            }
        }
        else if (stream.req !== null && chunk.byteLength > 0) {
            stream.req.push(Buffer.from(chunk));
        }
        if (final && stream.req !== null && !stream.inboundFinished) {
            stream.inboundFinished = true;
            stream.req.push(null); // 请求体完——relayHandler 的读体结束
        }
    }
    /** 杀掉一条流的本地表面并从流表移除（双向 FIN/RST 后不留驻内存）。 */
    abortStream(session, stream, err) {
        session.streams.delete(stream.streamId);
        stream.removeAbortListener?.();
        stream.removeAbortListener = null;
        if (stream.bodyReader) {
            void stream.bodyReader.cancel(err).catch(() => { });
            stream.bodyReader.releaseLock();
        }
        else if (stream.bodySource && !stream.bodySource.locked) {
            void stream.bodySource.cancel(err).catch(() => { });
        }
        stream.bodyReader = null;
        stream.bodySource = null;
        stream.responseReject?.(err);
        stream.responseReject = null;
        stream.responseResolve = null;
        stream.captureBody = Buffer.alloc(0);
        if (stream.bodyController !== null) {
            try {
                stream.bodyController.error(err);
            }
            catch { /* already closed */ }
            stream.bodyController = null;
        }
        if (stream.req !== null) {
            stream.req.destroy(err);
            stream.req = null;
        }
        if (stream.res !== null) {
            try {
                stream.res.destroy();
            }
            catch { /* gone */ }
            stream.res = null;
        }
        session.streams.delete(stream.streamId);
    }
    /** 向对端发 RST（本侧中止方向）。 */
    resetStream(session, stream, error = new Error('mux stream reset')) {
        this.abortStream(session, stream, error);
        if (!session.closed) {
            try {
                session.arq.reset(stream.streamId);
            }
            catch {
                // 会话已不存在——无需通知对端。
            }
        }
        stream.responseResolve = null;
        session.streams.delete(stream.streamId);
    }
    /** 对端发起了一条流：建流并交给 onFragment 累积/解析请求元数据与体。 */
    openInbound(session, streamId, chunk, final) {
        const stream = newStream(streamId, false);
        session.streams.set(stream.streamId, stream);
        this.onFragment(session, stream, chunk, final);
    }
    /** 构造虚拟 `req`/`res` 并直接调用本机 relayHandler。 */
    materializeInboundRequest(session, stream, meta) {
        const req = new Readable({ highWaterMark: BODY_HIGH_WATER_BYTES, read: () => { session.arq.resume(stream.streamId); } });
        Object.assign(req, {
            method: meta.m,
            url: meta.p,
            httpVersion: '1.1',
            httpVersionMajor: 1,
            httpVersionMinor: 1,
            rawHeaders: [],
            // 密码学认证后的标记头（PG-8）：E2EE 会话本身就是认证——mux 盖上与网关
            // 标记等价的头，relayHandler 的密钥门照常应答。
            headers: {
                ...meta.h,
                'x-zen-remote-secret': this.options.relaySecret(),
                'x-zen-remote-via': 'gateway',
                'x-zen-remote-role': 'desktop-client',
                'x-zen-remote-device': `peer:${session.nodeId}`,
                // 设备名可能是任意文字（对端机器名），头字段只收 latin-1：与网关
                // 的标记纪律一致先百分号编码，relayHandler 的读取侧统一解码。
                'x-zen-remote-device-name': encodeURIComponent(session.peerName),
            },
        });
        const socket = new Writable({
            highWaterMark: BODY_HIGH_WATER_BYTES,
            write: (chunk, _enc, cb) => {
                void this.parseCapture(session, stream, chunk).then(() => cb(), error => {
                    this.resetStream(session, stream, error instanceof Error ? error : new Error(String(error)));
                    cb(error instanceof Error ? error : new Error(String(error)));
                });
            },
            // 响应被销毁（handler 死亡）时 'close' 必须能看到——relayHandler 的
            // 清理路径挂在 res 'close' 上，而 res 'close' 源自 socket 'close'。
            emitClose: true,
        });
        Object.assign(req, { socket, connection: socket });
        const res = new ServerResponse(req);
        res.assignSocket(socket);
        // A real http.Server forwards socket drain to its response; assignSocket
        // alone does not. Without this, a large snapshot reaches the peer but
        // relayHandler waits forever before pulling the next live frame.
        socket.on('drain', () => {
            if (!res.destroyed && !res.writableEnded && res.writableLength === 0) {
                res.emit('drain');
            }
        });
        stream.req = req;
        stream.res = res;
        socket.on('error', () => { }); // errors already terminate the ARQ stream above
        res.on('finish', () => {
            this.finishResponse(session, stream);
        });
        res.on('close', () => {
            // 未完成即销毁（handler 死亡 / 行重载）：对端收 RST——finish 路径已 FIN 的除外。
            if (!stream.outboundFinished && session.streams.get(stream.streamId) === stream) {
                this.resetStream(session, stream);
            }
        });
        req.on('error', () => {
            if (!stream.outboundFinished && session.streams.get(stream.streamId) === stream) {
                this.resetStream(session, stream);
            }
        });
        req.on('end', () => this.options.log?.(`mux: inbound req body ended for ${session.nodeId} stream ${stream.streamId}`));
        req.on('error', (e) => this.options.log?.(`mux: inbound req error ${String(e)}`));
        const handler = this.options.relayHandler();
        if (handler === undefined) {
            // 服务半边未挂载（无 webServer 的组合）：如实应答并收尾。
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: { code: 'relay-unavailable' } }));
            return;
        }
        void handler(req, res).catch(() => {
            try {
                if (!res.writableEnded)
                    res.destroy();
            }
            catch { /* gone */ }
        });
    }
    /** Decode bounded slices, including partial HTTP chunks; never accumulate a body. */
    async parseCapture(session, stream, input) {
        // The producer owns input until its socket callback fires. No full-input copy;
        // only the current 16KiB slice and an incomplete bounded header are retained.
        for (let offset = 0; offset < input.length; offset += ADMISSION_CHUNK_BYTES) {
            if (session.streams.get(stream.streamId) !== stream)
                throw new Error('mux stream closed');
            let buf = input.subarray(offset, offset + ADMISSION_CHUNK_BYTES);
            if (stream.captureBody.length)
                buf = Buffer.concat([stream.captureBody, buf]);
            stream.captureBody = Buffer.alloc(0);
            if (stream.captureHead === null) {
                const end = buf.indexOf('\r\n\r\n');
                if (end < 0) {
                    if (buf.length > MAX_META_BYTES)
                        throw new Error('virtual response head too large');
                    stream.captureBody = Buffer.from(buf);
                    continue;
                }
                if (end > MAX_META_BYTES)
                    throw new Error('virtual response head too large');
                const lines = buf.subarray(0, end).toString('utf8').split('\r\n');
                const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines.shift() ?? '');
                if (!match)
                    throw new Error('malformed virtual response head');
                const headers = {};
                for (const line of lines) {
                    const colon = line.indexOf(':');
                    if (colon > 0)
                        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
                }
                stream.captureHead = { status: Number(match[1]), statusText: match[2] ?? '', headers };
                await this.writeArq(session, stream, Buffer.from(`${JSON.stringify({ t: 'res', s: Number(match[1]), st: match[2] ?? '', h: headers })}\n`));
                buf = buf.subarray(end + 4);
            }
            const headers = stream.captureHead.headers;
            if (!/\bchunked\b/i.test(headers['transfer-encoding'] ?? '')) {
                if (buf.length)
                    await this.writeArq(session, stream, buf);
                continue;
            }
            while (buf.length) {
                if (stream.captureChunkState === 'idle' || stream.captureChunkState === 'size') {
                    const end = buf.indexOf('\r\n');
                    if (end < 0) {
                        if (buf.length > MAX_META_BYTES)
                            throw new Error('chunk header too large');
                        stream.captureBody = Buffer.from(buf);
                        break;
                    }
                    const hex = buf.subarray(0, end).toString('ascii').split(';')[0];
                    if (!/^[0-9a-f]+$/i.test(hex))
                        throw new Error('malformed chunk size');
                    const size = Number.parseInt(hex, 16);
                    if (!Number.isSafeInteger(size))
                        throw new Error('invalid chunk size');
                    buf = buf.subarray(end + 2);
                    stream.captureChunkSize = size;
                    stream.captureChunkState = size === 0 ? 'done' : 'data';
                }
                else if (stream.captureChunkState === 'data') {
                    const size = Math.min(buf.length, stream.captureChunkSize);
                    await this.writeArq(session, stream, buf.subarray(0, size));
                    buf = buf.subarray(size);
                    stream.captureChunkSize -= size;
                    if (stream.captureChunkSize === 0)
                        stream.captureChunkState = 'crlf';
                }
                else if (stream.captureChunkState === 'crlf') {
                    if (buf.length < 2) {
                        stream.captureBody = Buffer.from(buf);
                        break;
                    }
                    if (buf[0] !== 13 || buf[1] !== 10)
                        throw new Error('malformed chunk delimiter');
                    buf = buf.subarray(2);
                    stream.captureChunkState = 'size';
                }
                else
                    break; // trailers have no HTTP body bytes
            }
        }
    }
    finishResponse(session, stream) {
        if (session.streams.get(stream.streamId) !== stream || stream.outboundFinished)
            return;
        stream.outboundFinished = true;
        void session.arq.finish(stream.streamId).catch(error => {
            this.resetStream(session, stream, error instanceof Error ? error : new Error(String(error)));
        });
    }
}
// -- 模块级形态 ---------------------------------------------------------------------------
function newStream(streamId, initiator) {
    return {
        streamId,
        initiator,
        inboundMetaDone: false,
        inboundMetaBuf: Buffer.alloc(0),
        inboundFinished: false,
        responseResolved: false,
        responseResolve: null,
        responseReject: null,
        bodyController: null,
        req: null,
        res: null,
        outboundFinished: false,
        removeAbortListener: null,
        bodyReader: null,
        bodySource: null,
        captureHead: null,
        captureBody: Buffer.alloc(0),
        captureChunkSize: 0,
        captureChunkState: 'idle',
    };
}
/** 确保本侧已有网关中转握手用的临时钥（收到 hello 但尚未发起过的应答侧也要有）。 */
function ensureMyEphemeral(session) {
    if (session.myEph === null) {
        session.myEph = generateEphemeralX25519();
        session.nonce = randomBytes(8).toString('hex');
    }
}
function flattenHeaders(init) {
    const out = {};
    if (init === undefined)
        return out;
    if (Array.isArray(init)) {
        for (const [name, value] of init)
            out[name.toLowerCase()] = value;
        return out;
    }
    if (init instanceof Headers) {
        init.forEach((value, name) => { out[name.toLowerCase()] = value; });
        return out;
    }
    for (const [name, value] of Object.entries(init)) {
        out[name.toLowerCase()] = value;
    }
    return out;
}
function parseRequestMeta(bytes) {
    try {
        const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        const record = parsed;
        if (record.t !== 'req')
            return null;
        const m = record.m;
        const p = record.p;
        if (typeof m !== 'string' || typeof p !== 'string' || p === '' || !p.startsWith('/'))
            return null;
        const headers = {};
        if (typeof record.h === 'object' && record.h !== null) {
            for (const [name, value] of Object.entries(record.h)) {
                if (typeof value === 'string')
                    headers[name.toLowerCase()] = value;
            }
        }
        return { m: m.toUpperCase(), p, h: headers };
    }
    catch {
        return null;
    }
}
function parseResponseMeta(bytes) {
    try {
        const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        const record = parsed;
        if (record.t !== 'res')
            return null;
        const status = record.s;
        if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599)
            return null;
        const headers = {};
        if (typeof record.h === 'object' && record.h !== null) {
            for (const [name, value] of Object.entries(record.h)) {
                if (typeof value === 'string')
                    headers[name.toLowerCase()] = value;
            }
        }
        return { status, statusText: typeof record.st === 'string' ? record.st : '', headers };
    }
    catch {
        return null;
    }
}
function enqueueInto(controller, bytes) {
    try {
        controller.enqueue(new Uint8Array(bytes));
    }
    catch {
        // 消费方已取消——reset 路径负责收尾。
    }
}
function closeController(controller) {
    if (controller === null)
        return;
    try {
        controller.close();
    }
    catch {
        // 已关闭或已出错。
    }
}
//# sourceMappingURL=mux.js.map