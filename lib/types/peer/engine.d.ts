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
 *    任意路径变化向网关发 `path-report` 控制帧（`/topology` 的数据源）：
 *    本机 TOFU 阻断的对端如实报 `blocked`，RTT 未知为 null、实测 0 原样
 *    保留，中继路径绝不沿用过期 UDP 延迟（PC-16a）。
 */
import type { Socket as DgramSocket } from 'node:dgram';
import type { PeerIdentityKeyPair } from './crypto.js';
import type { PeerNatType } from './punch.js';
import type { PeerVersionSyncEvaluation } from './version-sync.js';
import type { PeerRevokedNotice } from '../state-store.js';
import type { RelayPool } from '../relay-pool.js';
export type PeerGatewayState = 'unconfigured' | 'connecting' | 'pending-approval' | 'authorized' | 'mismatch' | 'paused' | 'revoked' | 'incompatible' | 'offline';
export type PeerMemberState = 'eligible' | 'identity-mismatch' | 'disabled';
export type PeerMemberPath = 'lan' | 'p2p' | 'relay' | 'blocked' | 'none';
/** Why a direct path sits demoted on relay: smoothed RTT over the gateway cap,
 *  the direct path itself failing (unanswered keepalives / stalled ARQ), or the
 *  peer's WS demote beacon. Only `rtt-cap` may be rendered as "over the cap". */
export type PeerDirectDemoteReason = 'rtt-cap' | 'path-lost' | 'peer-relay';
export interface PeerEnginePeerStatus {
    nodeId: string;
    name: string;
    state: PeerMemberState;
    path: PeerMemberPath;
    rttMs: number | null;
    mounted: boolean;
    /** T5：直连实测 RTT 的 EWMA（α=0.3，四舍五入）；从未测得为 null。
     *  与 `rttMs` 口径不同——它只描述 UDP 链路质量，降级为中转后仍如实上报。 */
    directRttMs: number | null;
    /** T5：直连被降级到中转（RTT 超上限、直连失效或对端降级信标），恢复后回 false。 */
    directDemoted: boolean;
    /** 降级原因；未降级为 null。只有 `rtt-cap` 才能呈现为「超过上限」。 */
    directDemoteReason: PeerDirectDemoteReason | null;
    /** T2：该对端在 welcome.peers / peer-joined 上报的插件版本号，缺省或旧端为 null。 */
    pluginVersion: string | null;
}
export interface PeerEngineStatus {
    nodeId: string;
    gatewayState: PeerGatewayState;
    deniedReason?: string | null;
    revokedNotice?: PeerRevokedNotice | null;
    networkId: string | null;
    maxPeers: number | null;
    natType: PeerNatType | null;
    peers: PeerEnginePeerStatus[];
    /** T4：当前生效的直连 RTT 上限（ms），解析序同 {@link PeerEngineOptions.directMaxRttMs}
     *  ——`0` = 不限制。排障用；判定逻辑读同一解析。 */
    directCapMs: number;
    /** T4：`directCapMs` 的来源——`gateway` = 网关 welcome/network-updated 下发；
     *  `default` = 网关没说过话时的本地值（options 注入或回落 300）。 */
    directCapSource: 'gateway' | 'default';
    /** T2/T6：与网关及同网对端的版本协调状态。 */
    versionSync: PeerVersionSyncEvaluation;
}
export interface PeerEnginePunchTimings {
    punchIntervalMs?: number;
    punchRounds?: number;
    punchWindowMs?: number;
    reprobeIntervalMs?: number;
    reprobeInitialDelaysMs?: readonly [number, number];
    keepAliveMs?: number;
    keepAliveLostFrames?: number;
    fastConfirmDelayMs?: number;
    pingRetryDelayMs?: number;
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
    /** STUN 自查端口三态：缺省（生产）从 authorized welcome 的 `stun` 字段读
     * 网关真实 UDP 端口（PC-01a 起下发；缺字段/形状坏明确降级 unknown）；
     * `null` 明确关闭探测（welcome 也不看）；对象为受控调用者的固定端口
     * 覆盖（welcome 不看）。三态共用同一生命周期：每条网关连接至多一次探测
     * 或降级，连接断开重连即新代次重探（fix1）。 */
    udpProbe?: {
        primaryPort: number;
        altPort?: number;
    } | null;
    /** 打洞节奏（缺省全按 PG-7 规格）。 */
    punch?: PeerEnginePunchTimings;
    /** path-report 周期（缺省 15000ms）。 */
    pathReportMs?: number;
    /** STUN NAT 探测超时（缺省 2000ms）。 */
    stunProbeTimeoutMs?: number;
    /** leaveNetwork HTTP 超时（缺省 3000ms）。 */
    leaveTimeoutMs?: number;
    /** WS 重连退避（缺省 1000ms 起、30000ms 封顶）。 */
    wsReconnectBaseMs?: number;
    wsReconnectMaxMs?: number;
    /** Deadline after WS upgrade for an authentication outcome (default 10000ms). */
    wsAuthTimeoutMs?: number;
    /** Optional HTTP fetch implementation (used for proactive gateway leave sync). */
    fetchImpl?: typeof fetch;
    clock?: {
        now(): number;
        setTimeout(fn: () => void, ms: number): unknown;
        clearTimeout(handle: unknown): void;
    };
    log?: (line: string) => void;
    /** 透传给 mux 的逐请求噪声通道（T3）。 */
    debug?: (line: string) => void;
    /** 直连 RTT 上限（ms）的测试注入通道——生产不接：上限的唯一来源是网关
     *  下发（welcome / network-updated 落 `peerNetwork.peerDirectMaxRttMsFromGateway`）。
     *  解析序 `capFromGateway ?? options.directMaxRttMs?.() ?? 300`；每次样本
     *  现场调用，非法值（非整数、负数、>10000）按 300。上限大于 0 时
     *  onDirectReady 不再立即切 UDP，等保活样本连续达标才升直连；已直连的
     *  会话在「当前样本与 EWMA 双双超限」时才降级回中转；0 = 不限制（保留
     *  旧行为）。 */
    directMaxRttMs?: () => number;
    /** 运行时读取的本机插件版本号（由 src/index.ts 从根 package.json#version 注入）。 */
    pluginVersion?: () => string;
    /** 运行时读取的期望网关版本号（由 src/index.ts 从根 package.json#gatewayVersion 注入）。 */
    recommendedGatewayVersion?: () => string;
    /** 冷启动时 relayHandler 未就绪的等待窗口（ms，传给 PeerMux 默认 3000）。 */
    relayHandlerWaitMs?: number;
}
export interface PeerEngineLeaveResult {
    ok: true;
    gatewaySynced: boolean;
}
export interface PeerEngine {
    joinNetwork(inviteUri: string): Promise<{
        ok: true;
    } | {
        ok: false;
        code: string;
    }>;
    /** PG-9 启动自动恢复：state 文件里已有 peerNetwork 记录时按同一条
     * join 序列（备好打洞 socket 与 mux，再连网关 WS）直接连回，已入网机器
     * 重启 DSH 后无需重新粘贴邀请链接。未入网回答 false，什么也不做。 */
    resumeFromState(): boolean;
    leaveNetwork(): Promise<PeerEngineLeaveResult>;
    dismissRevokedNotice(): void;
    setNodeDisabled(nodeId: string, disabled: boolean): void;
    trustPeer(nodeId: string): boolean;
    /** 向网关宣告本机最新设备显示名，网关落盘并向同网在线节点广播 `peer-renamed`。 */
    announceSelfName(name: string): void;
    reprobePunch(): void;
    /** Re-read the live pool cap and fill free slots; never evict existing mounts. */
    refreshMounts(): void;
    status(): PeerEngineStatus;
    stop(): void;
}
export declare function createPeerEngine(options: PeerEngineOptions): PeerEngine;
//# sourceMappingURL=engine.d.ts.map