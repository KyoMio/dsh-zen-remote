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
 * 网关中转握手沿用 UDP 路径的同一套已签名 `zr-peer-hs-v2` hello/ack JSON，
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
import { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { PeerIdentityKeyPair } from './crypto.js';
import type { PunchFrameSender } from './punch.js';
import type { PeerFrameHeader } from './wire.js';
/** 会话当前可用的物理路径。 */
export type PeerPath = 'none' | 'udp' | 'ws';
export interface PeerMuxOptions {
    networkId: string;
    identity: PeerIdentityKeyPair;
    /** 经网关 WS 中转发出一帧二进制（28B 头框架是 mux 的职责）；网关断链时为 null。 */
    sendGatewayBinary: ((bytes: Uint8Array) => void) | null;
    /** 本机服务半边的 relayHandler；未挂载（无 webServer 的组合）时回答 undefined。 */
    relayHandler: () => ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
    /** 每条入站虚拟请求都要盖上的本机标记密文（relayHandler 自己的门）。 */
    relaySecret: () => string;
    clock?: MuxClock;
    /** 会话有效路径变化时回调（engine 由此发 path-report）。 */
    onPathChanged?: (nodeId: string, path: PeerPath) => void;
    log?: (line: string) => void;
}
export interface MuxClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
export declare class PeerMux {
    private readonly options;
    private readonly clock;
    private readonly sessions;
    /** 对端会话拆建后延续单调递增的 streamId，避免复用对端已退休的 streamId。 */
    private readonly nextStreamIds;
    private closed;
    constructor(options: PeerMuxOptions);
    /** 为一个已通过 TOFU 的对端建立（或复用）mux 会话。 */
    ensureSession(nodeId: string, peerPublicKeyHex: string, peerName: string): void;
    /** 更新已建会话记录的对端设备名（入站虚拟请求 x-zen-remote-device-name 跟随最新名称）。 */
    setPeerName(nodeId: string, peerName: string): void;
    /** 拆掉一个对端的会话（peer-left / mismatch / 本机禁用）：流中止、表清理。 */
    dropSession(nodeId: string): void;
    hasSession(nodeId: string): boolean;
    sessionPath(nodeId: string): PeerPath;
    /** 存活会话 id（诊断用）。 */
    sessionIds(): string[];
    /** 拆掉全部会话并拒绝所有在途交换（engine stop / 退网）。 */
    close(): void;
    /**
     * 打洞窗口过期（或直连路径事后失效）：把 WS 中转路径备好——还没有中转
     * 密码器就现在跑网关中转握手；已有则直接把路径落在 `ws`。
     */
    enableRelayPath(nodeId: string): void;
    /** 打洞握手完成：接上打洞层的发送接缝，路径切到 UDP。 */
    setDirectPath(nodeId: string, sender: PunchFrameSender): void;
    /** 直连路径死亡（keepalive 掉线）：帧改走网关 WS 中转。 */
    setRelayPath(nodeId: string): void;
    /**
     * UDP 路径的一个**已开封**帧（punch 层用它自己的握手密码器开完才交进来）。
     * UDP 路径上的 hello/ack 由 punch 自己消化，永远到不了这里——这里只有
     * ARQ 层的帧。
     */
    handleOpenedFrame(header: PeerFrameHeader, plaintext: Uint8Array): void;
    /**
     * 网关 WS 中转的一个二进制帧。两种形态：
     *  - (HELLO, streamId 0)：明文 `zr-peer-hs-v2` 控制信封——WS 中转握手的半边；
     *  - 其余：中转握手密码器密封的帧，在这里开封。
     */
    handleGatewayFrame(bytes: Uint8Array): void;
    /**
     * 出站虚拟 HTTP 适配：绑定一个对端的原生 `fetch(url, init)`。应答带
     * `ReadableStream` 体；`init.signal` 中止会对远端流发 RST。
     */
    createFetchForPeer(nodeId: string): typeof fetch;
    /** Pipeline into a bounded byte budget; await capacity, never each frame's RTT. */
    private writeArq;
    /**
     * ARQ 的 sendFrame 接缝：发送时读取当前路径。UDP → punch 层封口；WS →
     * mux 用中转握手密码器封口经网关发出；两者都未就绪 → 抛错（上层捕获丢弃）。
     */
    private dispatchFrame;
    private beginHello;
    private clearHelloTimer;
    /** `28B 头（HELLO, streamId 0）+ v2 握手信封 JSON`，网关原样路由（只读路由头）。 */
    private sendHelloEnvelope;
    private sendHelloAckEnvelope;
    private sendEnvelope;
    /** 一个入站 envelope（HELLO, streamId 0）：hello→应答+整合；ack→整合。 */
    private handleEnvelope;
    /** 采用对端临时钥：每个新 (my, peer) 对只派生一次中转密码器。 */
    private integratePeerEphemeral;
    /** ARQ 顺序送达的一个入站分片（0 = 元数据，1+ = 体，fin = 结束）。 */
    private onStreamData;
    /** 单个入站分片的按向处理（ARQ 已保证顺序，元数据支持跨分片与换行定界）。 */
    private onFragment;
    /** 杀掉一条流的本地表面并从流表移除（双向 FIN/RST 后不留驻内存）。 */
    private abortStream;
    /** 向对端发 RST（本侧中止方向）。 */
    private resetStream;
    /** 对端发起了一条流：建流并交给 onFragment 累积/解析请求元数据与体。 */
    private openInbound;
    /** 构造虚拟 `req`/`res` 并直接调用本机 relayHandler。 */
    private materializeInboundRequest;
    /** Decode bounded slices, including partial HTTP chunks; never accumulate a body. */
    private parseCapture;
    private finishResponse;
}
/** mux 的 fetch 入参里允许的 body 形态（BodyInit 的窄化）。 */
export interface VirtualFetchInit {
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | null;
    signal?: AbortSignal | null;
}
//# sourceMappingURL=mux.d.ts.map