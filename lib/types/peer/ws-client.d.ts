/**
 * 零依赖 RFC6455 WebSocket 客户端（PG-8）。基于 `node:http` / `node:https`
 * 的 `upgrade` 事件实现，只支持 engine 需要的最小面：
 *
 *   - 连接 `ws://` 与 `wss://` URL（Basic 路径 + 可选额外请求头）；
 *   - 发送文本与二进制帧（客户端帧必须掩码）；
 *   - 接收文本 / 二进制 / ping / close（含分片重组；服务端帧不掩码）；
 *   - 干净关闭（发 close 帧后等对端，超时强拆）。
 *
 * 为什么不用 `globalThis.WebSocket`（Node ≥21 自带）：它走 Node 的 undici
 * 全局 dispatcher，会被系统的 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量劫持——
 * peer 网关是局域网/自建地址，绝不该被代理；undici 代理失败还会把报错
 * 归结成玄学 `TypeError: fetch failed`。也不引第三方 `ws`（根包零依赖纪律）。
 * 这里 17p 量级的实现换来「任何 Node 18+、任何代理环境」下的确定性。
 */
import { EventEmitter } from 'node:events';
export type WsClientState = 'connecting' | 'open' | 'closed';
export interface WsClientEvents {
    open: [];
    message: [data: Buffer, isBinary: boolean];
    close: [code: number, reason: string];
    error: [err: Error];
}
/**
 * 一个最小 WebSocket 连接。`send` 仅在 `open` 后合法；close 走 RFC6455
 * 关闭握手（1000ms 内对端不回应就强拆 TCP）。事件经 EventEmitter 派发
 * （`open` / `message` / `close` / `error`）。
 */
export declare class WsClient extends EventEmitter {
    readonly url: string;
    state: WsClientState;
    private socket;
    private parseBuf;
    private fragments;
    private fragmentOpcode;
    private closeSent;
    private gotClose;
    private closeTimer;
    private request;
    private handshakeTimer;
    constructor(url: string, headers?: Record<string, string>, options?: {
        handshakeTimeoutMs?: number;
    });
    /** 文本或二进制消息：字符串发 TEXT 帧，字节发 BINARY 帧（引擎的控制面靠
     * 文本/二进制分流——发错帧型网关会把 auth 当中转载荷丢掉）。 */
    send(data: string | Uint8Array, control?: boolean): void;
    /** 发起关闭握手；对端 1000ms 内不回应即强拆。幂等。 */
    close(code?: number, reason?: string): void;
    private onData;
    private onFrame;
    private deliver;
    private onSocketClosed;
    private fail;
    private clearHandshake;
    private finish;
}
//# sourceMappingURL=ws-client.d.ts.map