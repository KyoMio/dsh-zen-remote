/**
 * PeerEngine — 本机作为 peer 节点加入虚拟网络的完整生命周期（PG-8，
 * tasks/peer-gateway/PG-8.md）。四件东西在这里接线：
 *
 * 1. **网关 WS 控制连接**：`src/peer/ws-client.ts` 的零依赖 RFC6455 客户端
 *    连 `/peer/v1/ws`，走 challenge → auth 挑战应答握手（口令邀请带
 *    joinKeyProofHex 自动准入；无口令挂 pending 等管理员 REST approve 后
 *    原地升级）。断线指数退避重连（1s 起、2 倍增长、30s 封顶）。
 * 2. **本机独立 TOFU 锚定**：每个对端公告（welcome.peers / peer-joined /
 *    punch-coordinate）先过 `verifyOrPinPeerKey`——返回 `key-mismatch` 就把
 *    该对端标为 `identity-mismatch`：绝不握手、绝不挂载，即便网关状态是
 *    authorized。放行只有一条路：本机用户显式 `trustPeer()`（内部走
 *    `repinPeerKey` 换锚）。
 * 3. **RelayPool 自动编排**：通过 TOFU 且未被本机 `disabledNodes` 忽略的
 *    对端（按公告顺序、最多生效 `maxServers` 台）在 pool 里挂载**内存态**
 *    虚拟服务端条目：`mountVirtual` 的 client 用 `mux.createFetchForPeer()`
 *    当 fetch，于是 intercept / merge-streams / 插件桥 / 文件上传对同网
 *    节点天然生效，而纯 client 模式的 `servers` 列表一字不写。
 * 4. **路径与打洞**：`PeerPunchManager` 先跑 1000ms 优先 UDP 打洞
 *    （`onDirectReady` → mux 路径切 UDP、拓扑记 `lan`/`p2p`）；窗口过期
 *    `onPunchFallback` → mux 起网关 WS 中转握手、路径记 `relay`；直连事后
 *    打通/丢失各自热切换路径，ARQ 在途分片随新路径重传不断流。每 15s 和
 *    任意路径变化向网关发 `path-report` 控制帧（`/topology` 的数据源）。
 */
import type { Socket as DgramSocket } from 'node:dgram';
import type { PeerIdentityKeyPair } from './crypto.js';
import type { PeerNatType } from './punch.js';
import type { RelayPool } from '../relay-pool.js';
export type PeerGatewayState = 'unconfigured' | 'connecting' | 'pending-approval' | 'authorized' | 'mismatch' | 'paused' | 'revoked' | 'offline';
export type PeerMemberState = 'eligible' | 'identity-mismatch' | 'disabled';
export type PeerMemberPath = 'lan' | 'p2p' | 'relay' | 'blocked' | 'none';
export interface PeerEnginePeerStatus {
    nodeId: string;
    name: string;
    state: PeerMemberState;
    path: PeerMemberPath;
    rttMs: number | null;
    mounted: boolean;
}
export interface PeerEngineStatus {
    nodeId: string;
    gatewayState: PeerGatewayState;
    networkId: string | null;
    maxPeers: number | null;
    natType: PeerNatType | null;
    peers: PeerEnginePeerStatus[];
}
export interface PeerEnginePunchTimings {
    punchIntervalMs?: number;
    punchRounds?: number;
    punchWindowMs?: number;
    reprobeIntervalMs?: number;
    keepAliveMs?: number;
    keepAliveLostFrames?: number;
}
export interface PeerEngineOptions {
    /** `zen-remote-state.json`——身份、成员资格、TOFU 锚都在这里。 */
    stateFile: string;
    identity: Pick<PeerIdentityKeyPair, 'publicKeyHex' | 'privateKeyHex' | 'nodeId'>;
    /** 插件的连接池——虚拟服务端条目挂在这里（内存态）。 */
    relayPool: RelayPool;
    /** 本机服务半边的 relayHandler（未挂载时回答 undefined）。 */
    relayHandler: () => ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>) | undefined;
    /** 每条入站虚拟请求盖的本机标记密文。 */
    relaySecret: () => string;
    /** 公告与虚拟条目显示名。 */
    serverName: () => string;
    /** 自带已绑定的打洞 socket（测试防火墙注入）；缺省自建 udp4。 */
    udpSocket?: DgramSocket;
    /** 网关双 UDP 端口（STUN 自查）；null 关闭探测。 */
    udpProbe?: {
        primaryPort: number;
        altPort?: number;
    } | null;
    /** 打洞节奏（缺省全按 PG-7 规格）。 */
    punch?: PeerEnginePunchTimings;
    /** path-report 周期（缺省 15000ms）。 */
    pathReportMs?: number;
    /** WS 重连退避（缺省 1000ms 起、30000ms 封顶）。 */
    wsReconnectBaseMs?: number;
    wsReconnectMaxMs?: number;
    clock?: {
        now(): number;
        setTimeout(fn: () => void, ms: number): unknown;
        clearTimeout(handle: unknown): void;
    };
    log?: (line: string) => void;
}
export interface PeerEngine {
    joinNetwork(inviteUri: string): Promise<{
        ok: true;
    } | {
        ok: false;
        code: string;
    }>;
    leaveNetwork(): void;
    setNodeDisabled(nodeId: string, disabled: boolean): void;
    trustPeer(nodeId: string): boolean;
    reprobePunch(): void;
    status(): PeerEngineStatus;
    stop(): void;
}
export declare function createPeerEngine(options: PeerEngineOptions): PeerEngine;
//# sourceMappingURL=engine.d.ts.map