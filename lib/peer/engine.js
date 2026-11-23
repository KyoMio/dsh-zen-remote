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
import { createSocket } from 'node:dgram';
import { hostname as osHostname } from 'node:os';
import { computeJoinKeyProof, parseInviteUri, signGatewayChallenge, signGatewayLeave, } from './crypto.js';
import { probeStunNatType } from './punch.js';
import { PeerPunchManager } from './punch.js';
import { PeerMux } from './mux.js';
import { decodeFrameHeader, PeerFrameType } from './wire.js';
import { evaluatePeerVersionSync, maxSemver, parseSemver, PEER_WIRE_COMPAT_LEVEL, } from './version-sync.js';
import { readPeerNetwork, readPeerRevokedNotice, repinPeerKey, setPeerNodeDisabled, verifyOrPinPeerKey, writePeerNetwork, writePeerRevokedNotice, } from '../state-store.js';
import { WsClient } from './ws-client.js';
const realClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
};
// T5：直连 RTT 上限策略常数——EWMA 权重、降级恢复阈值（cap 的 0.7 倍）与
// 恢复所需的连续样本数。
const DIRECT_EWMA_ALPHA = 0.3;
const DIRECT_PROMOTE_RATIO = 0.7;
const DIRECT_PROMOTE_STREAK = 2;
const PEER_RELAY_HOLD_MS = 30_000;
/** 公告端点集的可比形态：lanEndpoints ∪ reflexiveEndpoint，排序去重成串。 */
const canonicalEndpoints = (lan, reflexive) => {
    const set = new Set();
    for (const ep of lan)
        if (typeof ep === 'string' && ep !== '')
            set.add(ep);
    if (typeof reflexive === 'string' && reflexive !== '')
        set.add(reflexive);
    return [...set].sort().join(' ');
};
const hasRemovedOrReplacedEndpoint = (oldLan, oldReflexive, newLan, newReflexive) => {
    const nextSet = new Set();
    for (const ep of newLan)
        if (typeof ep === 'string' && ep !== '')
            nextSet.add(ep);
    if (typeof newReflexive === 'string' && newReflexive !== '')
        nextSet.add(newReflexive);
    for (const ep of oldLan) {
        if (typeof ep === 'string' && ep !== '' && !nextSet.has(ep))
            return true;
    }
    if (typeof oldReflexive === 'string' && oldReflexive !== '' && !nextSet.has(oldReflexive))
        return true;
    return false;
};
const parseConnSeq = (value) => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
const arqProfileForPath = (mode, smoothedRttMs) => {
    if (mode === 'relay')
        return { windowSize: 160, rtoMs: 120 };
    if (mode !== 'p2p')
        return { windowSize: 64, rtoMs: 120 };
    const rtt = smoothedRttMs ?? 50;
    const rtoMs = Math.min(1000, Math.max(120, Math.ceil(rtt * 2 + 50)));
    return { windowSize: 16, rtoMs };
};
/**
 * authorized welcome 的可选 `stun` 字段（PC-01a 网关契约：真实 UDP bind
 * 端口，`{ primaryPort, altPort }`，altPort 为实际端口或 null）。welcome 是
 * 网络边界上的外来数据：主口必须是 1..65535 的整数，辅助口必须是合法端口
 * 或 null，形状不符一律回答 null——调用方据此明确降级 unknown，绝不拿垃圾
 * 端口发包。
 */
const parseWelcomeStun = (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    const stun = value;
    const primaryPort = stun['primaryPort'];
    if (typeof primaryPort !== 'number' || !Number.isInteger(primaryPort) || primaryPort < 1 || primaryPort > 65535)
        return null;
    const altPort = stun['altPort'];
    if (altPort !== null && (typeof altPort !== 'number' || !Number.isInteger(altPort) || altPort < 1 || altPort > 65535))
        return null;
    return { primaryPort, altPort };
};
export function createPeerEngine(options) {
    const clock = options.clock ?? realClock;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const log = options.log ?? (() => { });
    const TRANSIENT_DENIED_REASONS = new Set([
        'gateway storage unavailable',
        'timestamp out of range',
        'admission changed',
    ]);
    const identity = {
        publicKeyHex: options.identity.publicKeyHex,
        privateKeyHex: options.identity.privateKeyHex,
        nodeId: options.identity.nodeId.toLowerCase(),
    };
    const stateFile = options.stateFile;
    const pathReportMs = options.pathReportMs ?? 15_000;
    const wsBase = options.wsReconnectBaseMs ?? 1_000;
    const wsMax = options.wsReconnectMaxMs ?? 30_000;
    const wsAuthTimeoutMs = options.wsAuthTimeoutMs ?? 10_000;
    if (!Number.isInteger(wsAuthTimeoutMs) || wsAuthTimeoutMs < 1 || wsAuthTimeoutMs > 2_147_483_647) {
        throw new TypeError('peer engine: invalid wsAuthTimeoutMs');
    }
    let stopped = false;
    let networkId = null;
    let gatewayState = 'unconfigured';
    let deniedReason = null;
    let maxPeers = null;
    let natType = null;
    /** T4：网关下发的直连 RTT 上限快照（welcome / network-updated 现场更新，
     *  joinNetwork / resumeFromState 从落盘的 peerNetwork 记录恢复）。会话级
     *  事实——resetActiveSession 不清它（换代只拆连接，网络事实留到下一次
     *  join 或 leave 才换代），null = 网关（旧版）没说过话。 */
    let capFromGateway = null;
    /** 网关连接/授权代次：每次连接结束（WS close / resetActiveSession）或授权
     * 事实被撤销（PC-03 在线被暂停）即 +1。STUN 的「探测一次」以当前已获准的
     * 代次为单位，不是整个 joinNetwork 生命周期——网关侧重连即全新 ConnState
     * （reflexive 置 null、STUN 准入绑定本次连接 token），不重探新连接就没有
     * reflexiveEndpoint；暂停期间网关拒绝探测准入，恢复沿用同一 WS 但授权/反射
     * 端点事实已重建，必须重探；网关重启换 UDP 端口或旧网关升级出 stun 字段
     * 也靠重连后的重探恢复。 */
    let connEpoch = 0;
    /** 当前连接代次已做过的唯一一次探测（或降级）；-1 = 从未。同连接重复
     * authorized welcome 不重发；暂停换代（PC-03）后旧值失效，恢复 welcome
     * 触发重探。 */
    let stunProbedAtEpoch = -1;
    let ws = null;
    let wsAttempt = 0;
    let wsReconnectTimer = null;
    let wsAuthTimer = null;
    let wsReconnectable = true;
    let wsHadOpen = false;
    let wsClosedAfterOpen = false;
    let selfWsReanchorEpoch = 0;
    let selfLanReanchorEpoch = 0;
    let lastSelfLanKey = null;
    let punch = null;
    /** 打洞与 STUN 共用的 socket：注入的（引擎不关）或自建的（引擎关）。 */
    let punchSocket;
    let mux = null;
    let pathReportTimer = null;
    let hasReceivedWelcome = false;
    let gatewayVersionFromGateway = null;
    let recommendedPluginVersionFromGateway = null;
    let gatewayWireCompatLevel = null;
    /** 挂载顺序即公告顺序；每项是 pool entryId（= 对端 nodeId）。 */
    const members = new Map();
    const sendGatewayBinary = (bytes) => {
        if (ws === null || ws.state !== 'open')
            return;
        try {
            ws.send(bytes, bytes[3] !== PeerFrameType.DATA);
        }
        catch (err) {
            if (err instanceof Error && 'code' in err && err.code === 'ERR_PEER_BACKPRESSURE')
                return;
            log(`peer engine: gateway ws send failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const sendControl = (message) => {
        if (ws === null || ws.state !== 'open')
            return;
        try {
            ws.send(JSON.stringify(message));
        }
        catch {
            // 控制面失败等下一拍重连兜底。
        }
    };
    // ------------------------------------------------------------ 挂载与卸载
    const mountCount = () => {
        let count = 0;
        for (const member of members.values())
            if (member.mounted)
                count += 1;
        return count;
    };
    const mountPeer = (member) => {
        if (member.mounted || mux === null)
            return;
        const cap = options.relayPool.maxServers();
        if (mountCount() >= cap) {
            log(`peer engine: mount cap ${cap} reached, ${member.nodeId} stays unmounted`);
            return;
        }
        const entry = options.relayPool.mountVirtual({
            entryId: member.nodeId,
            serverId: member.nodeId,
            serverName: member.name,
            fetchImpl: mux.createFetchForPeer(member.nodeId),
        });
        member.mounted = true;
        log(`peer engine: mounted virtual server for ${member.nodeId} (${entry.displayName})`);
    };
    const refreshMounts = () => {
        if (stopped || gatewayState !== 'authorized')
            return;
        for (const member of members.values()) {
            if (mountCount() >= options.relayPool.maxServers())
                break;
            if (member.state === 'eligible')
                mountPeer(member);
        }
    };
    const unmountPeer = (member) => {
        if (!member.mounted)
            return;
        member.mounted = false;
        options.relayPool.unmountVirtual(member.nodeId);
    };
    const markMismatch = (member) => {
        member.state = 'identity-mismatch';
        member.path = 'blocked'; // PC-16a：本机身份阻断是真实观测，如实上报，不停留旧值伪装 relay/offline
        unmountPeer(member);
        mux?.dropSession(member.nodeId);
        punch?.dropPeer(member.nodeId);
        schedulePathReport();
        log(`peer engine: TOFU key-mismatch for ${member.nodeId} — blocked locally until trustPeer()`);
    };
    const selfLanIpSignature = () => {
        if (punch === null)
            return '';
        const ips = new Set();
        for (const ep of punch.lanEndpoints()) {
            const colon = ep.lastIndexOf(':');
            if (colon > 0)
                ips.add(ep.slice(0, colon));
        }
        return [...ips].sort().join(' ');
    };
    const syncSelfLanKey = () => {
        if (punch === null)
            return false;
        const cur = selfLanIpSignature();
        if (lastSelfLanKey === null) {
            lastSelfLanKey = cur;
            return false;
        }
        if (cur !== lastSelfLanKey) {
            lastSelfLanKey = cur;
            selfLanReanchorEpoch += 1;
            return true;
        }
        return false;
    };
    const resetPeerForReanchor = (member, reason, resetMux) => {
        punch?.dropPeer(member.nodeId);
        if (resetMux) {
            mux?.resetSession(member.nodeId);
        }
        member.path = 'relay';
        member.directMode = null;
        member.directSmoothedRtt = null;
        member.directGoodStreak = 0;
        member.directDemoted = false;
        member.directDemoteReason = null;
        member.directActive = false;
        member.directMissedPings = 0;
        member.lastArqWindow = null;
        member.lastArqRtoMs = null;
        member.peerRelayHoldUntil = 0;
        if (resetMux) {
            mux?.enableRelayPath(member.nodeId);
        }
        else {
            applyArqProfile(member, 'relay', true);
            mux?.setRelayPath(member.nodeId, false);
        }
        log(`peer engine: re-anchored ${member.nodeId} (${reason})`);
        schedulePathReport();
    };
    /** 一条对端公告（welcome.peers / peer-joined / punch-coordinate 共用）。 */
    const announcePeer = (info) => {
        if (stopped || networkId === null)
            return;
        const nodeId = info.nodeId.toLowerCase();
        if (nodeId === identity.nodeId)
            return;
        if (mux === null)
            return;
        const selfLanChanged = syncSelfLanKey();
        const net = readPeerNetwork(stateFile);
        const disabled = net?.disabledNodes?.includes(nodeId) === true;
        let member = members.get(nodeId);
        const isNewMember = member === undefined;
        const oldLan = member !== undefined ? member.lastLanEndpoints : [];
        const oldReflexive = member !== undefined ? member.lastReflexive : null;
        const oldEndpointSet = !isNewMember
            ? canonicalEndpoints(oldLan, oldReflexive)
            : null;
        if (member === undefined) {
            member = {
                nodeId,
                publicKeyHex: info.publicKeyHex,
                name: typeof info.name === 'string' && info.name.trim() !== '' ? info.name.trim() : `peer-${nodeId}`,
                state: 'eligible',
                path: 'none',
                mounted: false,
                lastLanEndpoints: [],
                lastReflexive: null,
                directMode: null,
                directSmoothedRtt: null,
                directGoodStreak: 0,
                directDemoted: false,
                directDemoteReason: null,
                directActive: false,
                directMissedPings: 0,
                lastConnSeq: null,
                reanchoredAtSelfWsEpoch: selfWsReanchorEpoch,
                reanchoredAtSelfLanEpoch: selfLanReanchorEpoch,
                lastArqWindow: null,
                lastArqRtoMs: null,
                pluginVersion: null,
                peerRelayHoldUntil: 0,
            };
            members.set(nodeId, member);
        }
        if (typeof info.name === 'string' && info.name.trim() !== '')
            member.name = info.name.trim();
        if ('pluginVersion' in info && info.pluginVersion !== undefined) {
            member.pluginVersion = parseSemver(info.pluginVersion)?.normalized ?? null;
        }
        member.lastLanEndpoints = Array.isArray(info.lanEndpoints) ? info.lanEndpoints.filter((e) => typeof e === 'string') : member.lastLanEndpoints;
        if ('reflexiveEndpoint' in info && info.reflexiveEndpoint !== undefined) {
            member.lastReflexive = typeof info.reflexiveEndpoint === 'string' && info.reflexiveEndpoint !== ''
                ? info.reflexiveEndpoint
                : null;
        }
        const incomingConnSeq = parseConnSeq(info.connSeq);
        const connSeqChanged = !isNewMember && incomingConnSeq !== null && member.lastConnSeq !== null && incomingConnSeq !== member.lastConnSeq;
        if (incomingConnSeq !== null)
            member.lastConnSeq = incomingConnSeq;
        const selfWsEpochChanged = !isNewMember && member.reanchoredAtSelfWsEpoch !== selfWsReanchorEpoch;
        const selfLanEpochChanged = !isNewMember && member.reanchoredAtSelfLanEpoch !== selfLanReanchorEpoch;
        member.reanchoredAtSelfWsEpoch = selfWsReanchorEpoch;
        member.reanchoredAtSelfLanEpoch = selfLanReanchorEpoch;
        const endpointsChanged = oldEndpointSet !== null
            && canonicalEndpoints(member.lastLanEndpoints, member.lastReflexive) !== oldEndpointSet;
        if (disabled) {
            member.state = 'disabled';
            unmountPeer(member);
            mux.dropSession(nodeId);
            punch?.dropPeer(nodeId);
            if (!info.deferMount)
                refreshMounts();
            return;
        }
        // 本机独立 TOFU：锚定不一致立刻阻断，绝不握手、绝不挂载。
        const tofu = verifyOrPinPeerKey(stateFile, nodeId, info.publicKeyHex);
        if (!tofu.ok) {
            member.publicKeyHex = info.publicKeyHex;
            markMismatch(member);
            if (!info.deferMount)
                refreshMounts();
            return;
        }
        member.publicKeyHex = info.publicKeyHex;
        member.state = 'eligible';
        mux.ensureSession(nodeId, info.publicKeyHex, member.name);
        mux.setPeerName(nodeId, member.name);
        if (member.mounted)
            options.relayPool.updateVirtualName(nodeId, member.name);
        if (!info.deferMount)
            refreshMounts();
        if (info.startPunch && punch !== null) {
            const keepAliveMs = options.punch?.keepAliveMs ?? 5_000;
            const pState = punch.peerState(nodeId);
            const keepDirectOrPunching = pState !== null &&
                (pState.state === 'punching' ||
                    (pState.state === 'direct' && pState.recentRxAgeMs !== null && pState.recentRxAgeMs <= keepAliveMs));
            const endpointReplacedOrRemoved = endpointsChanged
                && hasRemovedOrReplacedEndpoint(oldLan, oldReflexive, member.lastLanEndpoints, member.lastReflexive);
            const shouldReanchor = selfWsEpochChanged
                || selfLanEpochChanged
                || connSeqChanged
                || endpointReplacedOrRemoved
                || (endpointsChanged && pState?.state === 'direct' && !keepDirectOrPunching);
            if (shouldReanchor) {
                const reason = connSeqChanged
                    ? 'connSeq changed'
                    : selfWsEpochChanged || selfLanEpochChanged
                        ? 'local network changed'
                        : 'endpoints changed';
                const resetMux = connSeqChanged || selfWsEpochChanged;
                resetPeerForReanchor(member, reason, resetMux);
            }
            try {
                punch.beginPunch({
                    peerNodeId: nodeId,
                    peerPublicKeyHex: info.publicKeyHex,
                    lanEndpoints: member.lastLanEndpoints,
                    ...(member.lastReflexive !== null ? { reflexiveEndpoint: member.lastReflexive } : {}),
                });
                log(`peer engine: beginPunch(${nodeId}) candidates=${member.lastLanEndpoints.length + (member.lastReflexive !== null ? 1 : 0)} ours=${punch.lanEndpoints().length}`);
            }
            catch (err) {
                log(`peer engine: beginPunch refused for ${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        if (selfLanChanged && !info.deferMount && punch !== null) {
            for (const other of members.values()) {
                if (other === member || other.state !== 'eligible' || other.reanchoredAtSelfLanEpoch === selfLanReanchorEpoch)
                    continue;
                other.reanchoredAtSelfLanEpoch = selfLanReanchorEpoch;
                resetPeerForReanchor(other, 'local network changed', false);
                try {
                    punch.beginPunch({
                        peerNodeId: other.nodeId,
                        peerPublicKeyHex: other.publicKeyHex,
                        lanEndpoints: other.lastLanEndpoints,
                        ...(other.lastReflexive !== null ? { reflexiveEndpoint: other.lastReflexive } : {}),
                    });
                }
                catch { /* next coordinate will retry */ }
            }
        }
    };
    /** 对端离线/被暂停/被移除：卸载 + 拆会话 + 忘掉成员（锚点在盘上保留）。 */
    const memberGone = (nodeId) => {
        const member = members.get(nodeId.toLowerCase());
        if (member === undefined)
            return;
        unmountPeer(member);
        mux?.dropSession(member.nodeId);
        punch?.dropPeer(member.nodeId);
        members.delete(member.nodeId);
        schedulePathReport();
    };
    // ------------------------------------------------------------ WS 控制面
    const clearAuthDeadline = () => {
        if (wsAuthTimer !== null)
            clock.clearTimeout(wsAuthTimer);
        wsAuthTimer = null;
    };
    const connectWs = () => {
        if (stopped || ws !== null)
            return;
        const net = readPeerNetwork(stateFile);
        if (net === undefined) {
            gatewayState = 'unconfigured';
            return;
        }
        networkId = net.networkId;
        gatewayState = 'connecting';
        let client;
        try {
            // 邀请链接的 wsUrl 只有 scheme://host:port——网关的 WS 挂载路径是
            // 固定的 /peer/v1/ws（gateway-server/src/peer-hub/ws-hub.ts 的 WS_PATH）。
            client = new WsClient(`${net.gatewayWsUrl.replace(/\/+$/, '')}/peer/v1/ws`);
        }
        catch (err) {
            log(`peer engine: ws dial failed: ${err instanceof Error ? err.message : String(err)}`);
            gatewayState = 'offline';
            scheduleReconnect();
            return;
        }
        ws = client;
        let authTimedOut = false;
        client.on('open', () => {
            if (ws !== client)
                return;
            if (wsClosedAfterOpen) {
                wsClosedAfterOpen = false;
                selfWsReanchorEpoch += 1;
            }
            wsHadOpen = true;
            // Upgrade head may already contain a valid welcome before open fires.
            if (gatewayState !== 'connecting')
                return;
            wsAuthTimer = clock.setTimeout(() => {
                if (stopped || ws !== client || gatewayState !== 'connecting')
                    return;
                clearAuthDeadline();
                authTimedOut = true;
                gatewayState = 'offline';
                log('peer engine: gateway authentication timeout');
                client.close(1000, 'authentication timeout');
            }, wsAuthTimeoutMs);
        });
        client.on('message', (data, isBinary) => {
            if (ws !== client || authTimedOut)
                return;
            if (isBinary) {
                // 二进制帧只属于已入网连接；网关对挂起连接本来就不路由，这里再
                // 过一遍 TOFU 闸：非 eligible 成员的帧一律不进 mux。
                if (gatewayState !== 'authorized' || mux === null)
                    return;
                const header = decodeFrameHeader(data);
                if (header === null)
                    return;
                const member = members.get(header.srcNodeId);
                if (member === undefined || member.state !== 'eligible')
                    return;
                mux.handleGatewayFrame(data);
                return;
            }
            let message;
            try {
                const parsed = JSON.parse(data.toString('utf8'));
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
                    return;
                message = parsed;
            }
            catch {
                return;
            }
            handleControl(message);
        });
        client.on('close', (code, reason) => {
            log(`peer engine: gateway ws closed (code=${code} reason=${reason || '—'} state=${gatewayState})`);
            if (ws !== client)
                return;
            clearAuthDeadline();
            ws = null;
            if (wsHadOpen)
                wsClosedAfterOpen = true;
            // 连接结束即换代（PC-01b fix1）：本连接在途探测的迟到结果随之作废，
            // 重连后的新连接按新代次重新探测登记反射端点。
            connEpoch += 1;
            if (stopped)
                return;
            // PC-03：paused 不再豁免重连——暂停期间保持的是受限控制连接，断线后
            // 沿既有有界退避恢复控制通道（auth 时按网关最新授权决定挂起或放行）。
            // 旧网关 deny 出的 paused 由 wsReconnectable=false 兜底，不在此重连。
            if (wsReconnectable && gatewayState !== 'revoked' && gatewayState !== 'unconfigured') {
                gatewayState = 'offline';
                scheduleReconnect();
            }
        });
        client.on('error', (err) => {
            log(`peer engine: gateway ws error: ${err.message}`);
        });
    };
    const scheduleReconnect = () => {
        if (stopped || !wsReconnectable || wsReconnectTimer !== null)
            return;
        const delay = Math.min(wsBase * 2 ** wsAttempt, wsMax);
        wsAttempt += 1;
        wsReconnectTimer = clock.setTimeout(() => {
            wsReconnectTimer = null;
            if (!stopped)
                connectWs();
        }, delay);
    };
    const handleControl = (message) => {
        const type = message['type'];
        if (type === 'challenge') {
            const net = readPeerNetwork(stateFile);
            const challengeHex = message['challengeHex'];
            if (net === undefined || typeof challengeHex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(challengeHex))
                return;
            const timestamp = clock.now();
            const selfPluginVer = parseSemver(options.pluginVersion?.())?.normalized;
            const recGwVer = parseSemver(options.recommendedGatewayVersion?.())?.normalized;
            sendControl({
                type: 'auth',
                networkId: net.networkId,
                nodeId: identity.nodeId,
                publicKeyHex: identity.publicKeyHex,
                name: options.serverName(),
                lanEndpoints: punch?.lanEndpoints() ?? [],
                // PC-03 能力位：被暂停时请求保留受限控制连接（等待管理员 resume 原地
                // 恢复）。旧网关忽略未知字段，仍按 deny + 关闭处理。
                pauseHold: true,
                // PAS-3：仅当网关曾放行入网（everAdmitted: true）时标定自动重连，
                // 让网关在离线被移除/拒绝时彻底阻断旧口令自动复活。
                reconnect: net.everAdmitted === true,
                wireCompatLevel: PEER_WIRE_COMPAT_LEVEL,
                ...(selfPluginVer !== undefined ? { pluginVersion: selfPluginVer } : {}),
                ...(recGwVer !== undefined ? { recommendedGatewayVersion: recGwVer } : {}),
                timestamp,
                signatureHex: signGatewayChallenge({
                    privateKeyHex: identity.privateKeyHex,
                    publicKeyHex: identity.publicKeyHex,
                    challengeHex,
                    networkId: net.networkId,
                    nodeId: identity.nodeId,
                    timestamp,
                }),
                ...(net.joinKey !== undefined
                    ? { joinKeyProofHex: computeJoinKeyProof({ joinKey: net.joinKey, challengeHex, networkId: net.networkId, nodeId: identity.nodeId }) }
                    : {}),
            });
            return;
        }
        if (type === 'welcome') {
            const status = message['status'];
            if (status !== 'authorized' && status !== 'pending' && status !== 'mismatch' && status !== 'paused')
                return;
            if (wsClosedAfterOpen) {
                wsClosedAfterOpen = false;
                selfWsReanchorEpoch += 1;
            }
            wsHadOpen = true;
            wsAttempt = 0;
            clearAuthDeadline();
            deniedReason = null;
            hasReceivedWelcome = true;
            gatewayVersionFromGateway = parseSemver(message['gatewayVersion'])?.normalized ?? null;
            recommendedPluginVersionFromGateway = parseSemver(message['recommendedPluginVersion'])?.normalized ?? null;
            gatewayWireCompatLevel =
                typeof message['wireCompatLevel'] === 'number' && Number.isInteger(message['wireCompatLevel'])
                    ? message['wireCompatLevel']
                    : null;
            const announcedCap = message['maxPeers'];
            const validCap = typeof announcedCap === 'number' && Number.isSafeInteger(announcedCap) && announcedCap >= 2
                ? announcedCap
                : undefined;
            if (validCap !== undefined)
                maxPeers = validCap;
            // T4：直连 RTT 上限同样随 welcome 下发（四种 status 共用这段解析）。
            // 旧版网关不带字段 → 保留旧值/缺省（解析序 options ?? 300 兜住）。
            const announcedRtt = message['peerDirectMaxRttMs'];
            const validRtt = typeof announcedRtt === 'number' && Number.isSafeInteger(announcedRtt) && announcedRtt >= 0 && announcedRtt <= 10_000
                ? announcedRtt
                : undefined;
            if (validRtt !== undefined)
                capFromGateway = validRtt;
            const markAdmitted = status === 'authorized' || status === 'paused';
            const net = readPeerNetwork(stateFile);
            if (net !== undefined) {
                const needCap = validCap !== undefined && net.maxPeersFromGateway !== validCap;
                const needRtt = validRtt !== undefined && net.peerDirectMaxRttMsFromGateway !== validRtt;
                const needAdmit = markAdmitted && net.everAdmitted !== true;
                if (needCap || needRtt || needAdmit) {
                    writePeerNetwork(stateFile, {
                        ...net,
                        ...(validCap !== undefined ? { maxPeersFromGateway: validCap } : {}),
                        ...(validRtt !== undefined ? { peerDirectMaxRttMsFromGateway: validRtt } : {}),
                        ...(markAdmitted ? { everAdmitted: true } : {}),
                    });
                }
            }
            if (markAdmitted && readPeerRevokedNotice(stateFile) !== undefined) {
                writePeerRevokedNotice(stateFile, undefined);
            }
            if (status === 'authorized') {
                gatewayState = 'authorized';
                syncSelfLanKey();
                const livePeerIds = new Set();
                for (const peer of Array.isArray(message['peers']) ? message['peers'] : []) {
                    if (typeof peer?.nodeId !== 'string' || typeof peer?.publicKeyHex !== 'string')
                        continue;
                    const pid = peer.nodeId.toLowerCase();
                    livePeerIds.add(pid);
                    announcePeer({
                        nodeId: peer.nodeId,
                        publicKeyHex: peer.publicKeyHex,
                        name: typeof peer.name === 'string' ? peer.name : null,
                        lanEndpoints: Array.isArray(peer.lanEndpoints) ? peer.lanEndpoints : null,
                        reflexiveEndpoint: typeof peer.reflexiveEndpoint === 'string' ? peer.reflexiveEndpoint : null,
                        connSeq: parseConnSeq(peer.connSeq),
                        pluginVersion: parseSemver(peer.pluginVersion)?.normalized ?? null,
                        startPunch: true,
                        deferMount: true,
                    });
                }
                // 差集清理：断线期间离网、暂停或被移除的旧设备不再出现在 welcome.peers，
                // 必须同步卸载并删除虚拟条目，否则会继续占名（-1/-2）并留下删不掉的工作区。
                for (const existingId of [...members.keys()]) {
                    if (!livePeerIds.has(existingId))
                        memberGone(existingId);
                }
                refreshMounts();
                // PC-01b：STUN 端口来自本条 authorized welcome 的 stun 字段（生产缺省
                // 路径；显式 udpProbe 在引擎内另行覆盖/关闭）。
                runStunProbeOnce(message['stun']);
                armPathReport();
                schedulePathReport();
            }
            else {
                for (const existingId of [...members.keys()])
                    memberGone(existingId);
                if (status === 'pending') {
                    gatewayState = 'pending-approval';
                }
                else if (status === 'mismatch') {
                    gatewayState = 'mismatch';
                }
                else {
                    // PC-03：暂停挂起（断线重连/重启后 auth，成员仍是 paused）——
                    // 清空业务，保留这条受限控制连接与重连能力，等管理员 resume 后
                    // 同一条连接上的 welcome authorized 原地恢复。
                    gatewayState = 'paused';
                }
            }
            return;
        }
        if (type === 'denied') {
            clearAuthDeadline();
            // 拒绝在握手前后都可能到达（挂起时被踢 / 入网后被暂停）——必须在
            // authorized 闸之前处理，否则挂在 connecting/pending 的连接会把拒绝
            // 静默吞掉，永远停在旧状态；同时卸载全部已挂载的远端工作区。
            const reason = typeof message['reason'] === 'string' ? message['reason'] : '';
            if (reason.startsWith('version-incompatible:')) {
                deniedReason = reason;
                wsReconnectable = false;
                gatewayState = 'incompatible';
                const gwVer = parseSemver(message['gatewayVersion'])?.normalized ?? null;
                if (gwVer !== null)
                    gatewayVersionFromGateway = gwVer;
                for (const existingId of [...members.keys()])
                    memberGone(existingId);
                log(`peer engine: gateway version incompatible (${reason}) — stopping reconnect`);
                try {
                    ws?.close();
                }
                catch { /* dying */ }
                return;
            }
            if (reason.includes('paused')) {
                deniedReason = reason !== '' ? reason : null;
                wsReconnectable = false;
                gatewayState = 'paused';
                for (const existingId of [...members.keys()])
                    memberGone(existingId);
                log(`peer engine: gateway paused (${reason})`);
                try {
                    ws?.close();
                }
                catch { /* dying */ }
                return;
            }
            if (TRANSIENT_DENIED_REASONS.has(reason)) {
                deniedReason = reason;
                wsReconnectable = true;
                gatewayState = 'offline';
                for (const existingId of [...members.keys()])
                    memberGone(existingId);
                log(`peer engine: gateway transient denial (${reason}) — retaining credentials for retry`);
                try {
                    ws?.close();
                }
                catch { /* dying */ }
                return;
            }
            // PAS-3：区分“从未入网首次遭拒”与“已入网后遭撤销/移除”：
            // 两者都要断开全部对端并清除本地 peerNetwork 凭据防重启复活，但仅后者写入
            // 非凭据的撤销横幅供设置页/向导提示（“设备 xxx 网关已撤销授权”）。
            const prevNet = readPeerNetwork(stateFile);
            const wasAdmitted = prevNet?.everAdmitted === true ||
                gatewayState === 'authorized' ||
                gatewayState === 'paused' ||
                gatewayState === 'mismatch';
            if (wasAdmitted) {
                const deviceName = options.serverName().trim() || osHostname().trim() || identity.nodeId;
                writePeerRevokedNotice(stateFile, {
                    deviceName,
                    gatewayHost: prevNet?.gatewayHttpOrigin ?? '',
                    networkId: prevNet?.networkId ?? networkId ?? '',
                    reason: reason || 'revoked',
                    revokedAt: clock.now(),
                });
            }
            resetActiveSession();
            networkId = null;
            writePeerNetwork(stateFile, undefined);
            deniedReason = reason !== '' ? reason : null;
            gatewayState = 'revoked';
            log(`peer engine: gateway denied (${reason || 'no reason'})`);
            return;
        }
        if (type === 'paused') {
            // PC-03：在线被暂停（新网关 + pauseHold 能力位）。与 denied 不同：
            // 这条受限控制连接保留，仅承载状态/恢复通知。业务即刻清空（对端直连、
            // 中转会话与挂载全部拆除）；授权事实被撤销即换代——暂停前在途探测的
            // 迟到结果作废，恢复 welcome 触发必要重探（同连接重复 welcome 的
            // 不重探闸不被误挡）。
            if (gatewayState !== 'authorized')
                return;
            connEpoch += 1;
            natType = null;
            gatewayState = 'paused';
            for (const existingId of [...members.keys()])
                memberGone(existingId);
            log('peer engine: paused by gateway — control connection held for resume');
            return;
        }
        if (gatewayState !== 'authorized')
            return; // peer-*/path 事件只在入网后有意义
        if (type === 'peer-joined') {
            if (typeof message['nodeId'] !== 'string' || typeof message['publicKeyHex'] !== 'string')
                return;
            announcePeer({
                nodeId: message['nodeId'],
                publicKeyHex: message['publicKeyHex'],
                name: typeof message['name'] === 'string' ? message['name'] : null,
                lanEndpoints: Array.isArray(message['lanEndpoints']) ? message['lanEndpoints'] : null,
                reflexiveEndpoint: typeof message['reflexiveEndpoint'] === 'string' ? message['reflexiveEndpoint'] : null,
                connSeq: parseConnSeq(message['connSeq']),
                pluginVersion: parseSemver(message['pluginVersion'])?.normalized ?? null,
                startPunch: true,
            });
            return;
        }
        if (type === 'peer-renamed') {
            if (typeof message['nodeId'] !== 'string' || typeof message['name'] !== 'string')
                return;
            const rid = message['nodeId'].toLowerCase();
            const newName = message['name'].trim();
            if (newName === '')
                return;
            const member = members.get(rid);
            if (member !== undefined) {
                member.name = newName;
                mux?.setPeerName(rid, newName);
                options.relayPool.updateVirtualName(rid, newName);
            }
            return;
        }
        if (type === 'peer-left') {
            if (typeof message['nodeId'] === 'string')
                memberGone(message['nodeId']);
            refreshMounts();
            return;
        }
        if (type === 'peer-paused') {
            if (typeof message['nodeId'] === 'string')
                memberGone(message['nodeId']);
            refreshMounts();
            return;
        }
        if (type === 'punch-coordinate') {
            if (typeof message['peerNodeId'] !== 'string' || typeof message['publicKeyHex'] !== 'string')
                return;
            const ver = parseSemver(message['pluginVersion'])?.normalized;
            announcePeer({
                nodeId: message['peerNodeId'],
                publicKeyHex: message['publicKeyHex'],
                name: null,
                lanEndpoints: Array.isArray(message['lanEndpoints']) ? message['lanEndpoints'] : null,
                reflexiveEndpoint: typeof message['reflexiveEndpoint'] === 'string' ? message['reflexiveEndpoint'] : null,
                connSeq: parseConnSeq(message['connSeq']),
                ...(ver !== undefined ? { pluginVersion: ver } : {}),
                startPunch: true,
            });
            return;
        }
        if (type === 'network-updated') {
            // PC-08b：网关管理员改容量的增量广播（PC-08a REST PATCH → ws-hub）。
            // 只消费当前网络；maxPeers 要 2..64 的有限整数、peerDirectMaxRttMs 要
            // 0..10000 的有限整数（T4，两字段独立判——一个形状坏不挡另一个）。
            // 跨网络的旧消息一律忽略——不改内存状态、不落盘、不重排挂载。同值幂等：
            // welcome 已把该值写进 peerNetwork.*FromGateway 时直接早退，不重复写盘
            // 也不重排挂载。落盘复用 welcome 的同一事实源；pool.maxServers() 每次
            // 调用现场读它，升容后 refreshMounts 立即补位，缩容不踢既有挂载
            // （mountPeer 的上限闸只挡新增），本机显式 maxServers 由 pool 的 min
            // 规则继续压住。RTT 上限现场生效：directCap() 每个样本都重新解析，
            // 新值从下一个样本起参与判定。
            if (message['networkId'] !== networkId)
                return;
            const announced = message['maxPeers'];
            const capOk = typeof announced === 'number' && Number.isSafeInteger(announced) && announced >= 2 && announced <= 64;
            const announcedRtt = message['peerDirectMaxRttMs'];
            const rttOk = typeof announcedRtt === 'number' && Number.isSafeInteger(announcedRtt) && announcedRtt >= 0 && announcedRtt <= 10_000;
            if (!capOk && !rttOk)
                return;
            const capChanged = capOk && announced !== maxPeers;
            const rttChanged = rttOk && announcedRtt !== capFromGateway;
            if (!capChanged && !rttChanged)
                return;
            if (capChanged)
                maxPeers = announced;
            if (rttChanged)
                capFromGateway = announcedRtt;
            const net = readPeerNetwork(stateFile);
            if (net !== undefined && net.networkId === networkId) {
                const needCap = capChanged && net.maxPeersFromGateway !== announced;
                const needRtt = rttChanged && net.peerDirectMaxRttMsFromGateway !== announcedRtt;
                if (needCap || needRtt) {
                    writePeerNetwork(stateFile, {
                        ...net,
                        ...(needCap ? { maxPeersFromGateway: announced } : {}),
                        ...(needRtt ? { peerDirectMaxRttMsFromGateway: announcedRtt } : {}),
                    });
                }
            }
            refreshMounts();
            return;
        }
        // 其余类型（含已认证后再来的 challenge）忽略。
    };
    // ------------------------------------------------------------ STUN 与 path-report
    const runStunProbeOnce = (welcomeStun) => {
        if (stopped || punch === null)
            return;
        if (options.udpProbe === null)
            return; // 显式关闭：受控调用者的既有语义，welcome 也不看
        if (stunProbedAtEpoch === connEpoch)
            return; // 本连接代次已处理（探测或降级）
        stunProbedAtEpoch = connEpoch;
        const epoch = connEpoch;
        const explicit = options.udpProbe;
        const probe = explicit !== undefined
            ? { primaryPort: explicit.primaryPort, altPort: explicit.altPort ?? null }
            : parseWelcomeStun(welcomeStun);
        if (probe === null || probe.primaryPort < 1) {
            if (explicit === undefined) {
                // 生产缺省：authorized welcome 无可用 stun 端口（旧网关缺字段或形状
                // 坏）——明确降级 unknown：不异常逃逸、不假报探测成功。本连接代次内
                // 不重发；重连后的新连接重新评估（网关升级出有效字段即恢复探测）。
                natType = 'unknown';
                log('peer engine: STUN probe degraded to unknown — authorized welcome carries no usable stun ports');
            }
            return;
        }
        const net = readPeerNetwork(stateFile);
        if (net === undefined)
            return;
        let hostname = '127.0.0.1';
        try {
            hostname = new URL(net.gatewayHttpOrigin).hostname;
        }
        catch { /* keep the fallback */ }
        void probeStunNatType({
            primaryHost: hostname,
            primaryPort: probe.primaryPort,
            ...(probe.altPort !== null && probe.altPort > 0 ? { altPort: probe.altPort } : {}),
            networkId: networkId ?? net.networkId,
            identity,
            // 承重墙（PG-8）：从打洞层自己的 socket 发探测——网关记录并广播的
            // reflexiveEndpoint 必须是 peers 真能打到的那个端口。临时探测 socket
            // 一关，反射端口就成了黑洞，同机回环与真实 cone NAT 都打不通。
            ...(punchSocket !== undefined ? { socket: punchSocket } : {}),
            timeoutMs: options.stunProbeTimeoutMs ?? 2000,
        })
            .then((result) => {
            // 过期防护：stop、连接断开（换代）或换网/leave 之后的迟到结果一律
            // 丢弃，不许覆盖新连接（或已清空的）探测状态。
            if (stopped || epoch !== connEpoch)
                return;
            natType = result.natType;
            log(`peer engine: STUN probe → ${result.natType} (${result.reflexiveEndpoint ?? 'no reflexive answer'})`);
        })
            .catch(() => {
            if (stopped || epoch !== connEpoch)
                return;
            natType = 'unknown';
        });
    };
    /**
     * 当前路径 RTT 的唯一选择口径（PC-16a fix1）：`status()` 与 path-report
     * 共用同一份 RTT 事实——只在 UDP 直连（lan/p2p）路径读 punch 会话测量
     * （HELLO-ACK / PING→PONG，实测 0 合法保留，未测得 null）；中继/未定
     * （relay/none）、本机阻断（blocked）与非成员态（disabled）没有当前路径
     * 的测量，一律 null。直连降中继后 punch 会话里残留的过期 UDP 值不得从
     * 任何出口漏出去；不改 punch 内部诊断缓存，也不新增中继测速。
     */
    const currentPathRttMs = (member) => {
        if (member.state !== 'eligible')
            return null;
        if (member.path !== 'lan' && member.path !== 'p2p')
            return null;
        return punch?.sessionRttMs(member.nodeId) ?? null;
    };
    /**
     * path-report 行的生产口径（PC-16a）。每行是 `{ peerNodeId, path, rttMs }`：
     * - eligible 成员：路径 lan/p2p（UDP 直连）或 relay（'none' 归一为中转面可用）；
     *   RTT 按 currentPathRttMs 的口径取值。
     * - identity-mismatch 成员：path 'blocked'、RTT null——本机 TOFU 阻断是
     *   对端仍在线时的真实观测，如实上报（不伪装 relay/offline，也不整行隐藏）。
     * - disabled 成员：不上报——本机显式停用，不进拓扑遥测。
     * - self 不在 members 里，天然不出现在表中。
     */
    const currentPeerPaths = () => {
        const out = [];
        for (const member of members.values()) {
            if (member.state === 'identity-mismatch') {
                out.push({ peerNodeId: member.nodeId, path: 'blocked', rttMs: currentPathRttMs(member) });
                continue;
            }
            if (member.state !== 'eligible')
                continue;
            let path = member.path;
            if (path === 'none')
                path = 'relay'; // 打洞在途/等待降级——中转面仍可用
            out.push({ peerNodeId: member.nodeId, path, rttMs: currentPathRttMs(member) });
        }
        return out;
    };
    const sendPathReport = () => {
        if (stopped || gatewayState !== 'authorized' || ws === null || ws.state !== 'open')
            return;
        sendControl({ type: 'path-report', peers: currentPeerPaths() });
    };
    const pathReportArmed = { timer: null };
    const schedulePathReport = () => {
        if (stopped || pathReportArmed.timer !== null)
            return;
        pathReportArmed.timer = clock.setTimeout(() => {
            pathReportArmed.timer = null;
            sendPathReport();
        }, 200);
    };
    const armPathReport = () => {
        if (pathReportTimer !== null || stopped)
            return;
        pathReportTimer = clock.setTimeout(function tick() {
            pathReportTimer = null;
            sendPathReport();
            if (!stopped && gatewayState === 'authorized') {
                pathReportTimer = clock.setTimeout(tick, pathReportMs);
            }
        }, pathReportMs);
    };
    // ------------------------------------------------------------ 打洞回调
    const applyArqProfile = (member, mode, force = false) => {
        if (mux === null)
            return;
        const profile = arqProfileForPath(mode, member.directSmoothedRtt);
        if (!force
            && member.lastArqWindow === profile.windowSize
            && member.lastArqRtoMs !== null
            && Math.abs(profile.rtoMs - member.lastArqRtoMs) < 25) {
            return;
        }
        member.lastArqWindow = profile.windowSize;
        member.lastArqRtoMs = profile.rtoMs;
        mux.setPeerTransportProfile(member.nodeId, profile);
    };
    const onDirectReady = (nodeId, info) => {
        log(`peer engine: direct ready ${nodeId} via ${info.mode} ${info.endpoint} rtt=${info.rttMs}`);
        const member = members.get(nodeId);
        if (member === undefined)
            return;
        // T5：新会话重走测量——握手自报 RTT 只反映 HELLO/ACK 单程，不信它；
        // 等保活样本判定。directActive 置 false：上限 >0 时 mux 还没切到 UDP，
        // 切的时候 promoteDirect 自己置 true。
        member.directMode = info.mode;
        member.directSmoothedRtt = null;
        member.directGoodStreak = 0;
        member.directDemoted = false;
        member.directDemoteReason = null;
        member.directActive = false;
        member.directMissedPings = 0;
        member.lastArqWindow = null;
        member.lastArqRtoMs = null;
        member.peerRelayHoldUntil = 0;
        if (directCap() <= 0) {
            // 上限关闭：与旧行为一致，打通即直连。
            member.path = info.mode;
            member.directActive = true;
            applyArqProfile(member, info.mode, true);
            if (mux !== null && punch !== null) {
                mux.setDirectPath(nodeId, punch.frameSenderFor(nodeId));
            }
        }
        else {
            // 上限开启：先保证中转可用（握手在途时 beginHello，已有会话则
            // 切回 ws 路径），path 口径钉死 relay——实际还走着中转，等连续
            // 两个达标样本升直连。
            member.path = 'relay';
            applyArqProfile(member, 'relay', true);
            mux?.enableRelayPath(nodeId);
        }
        schedulePathReport();
    };
    const onPunchFallback = (nodeId) => {
        log(`peer engine: punch fallback ${nodeId} (window expired)`);
        const member = members.get(nodeId);
        if (member === undefined)
            return;
        member.path = 'relay';
        applyArqProfile(member, 'relay', true);
        mux?.enableRelayPath(nodeId);
        schedulePathReport();
    };
    /** 直连 RTT 上限的单一解析点：网关下发值优先（T4），options 注入是
     *  测试通道（生产不传），都没有回落 300——网关侧建网默认与 PATCH 校验
     *  共用同一默认。每次样本现场解析，network-updated 的新值下个样本即生效；
     *  注入值非法（非整数、负数、>10000）按 300。0 表示不限制。 */
    const directCap = () => {
        if (capFromGateway !== null)
            return capFromGateway;
        const raw = options.directMaxRttMs?.();
        return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= 10_000 ? raw : 300;
    };
    /** 升直连：mux 切 UDP、路径回填握手模式、清降级标记。 */
    const promoteDirect = (member) => {
        if (mux === null || punch === null)
            return;
        const mode = member.directMode ?? 'p2p';
        applyArqProfile(member, mode, true);
        const sender = punch.frameSenderFor(member.nodeId);
        mux.setDirectPath(member.nodeId, sender);
        try {
            sender(PeerFrameType.ACK, 0, Buffer.alloc(0), 0);
        }
        catch {
            // Transient send failure; subsequent traffic or keepalive will follow.
        }
        member.path = mode;
        member.directActive = true;
        member.directDemoted = false;
        member.directDemoteReason = null;
        member.directGoodStreak = 0;
        log(`peer engine: direct ${member.nodeId} rtt ok — switching to ${member.path}`);
        schedulePathReport();
    };
    /** 降级回中转的单一出口：超上限样本与连 miss 都走这里。 */
    const demoteDirect = (member, reason, why) => {
        applyArqProfile(member, 'relay', true);
        mux?.setRelayPath(member.nodeId, true);
        member.path = 'relay';
        member.directActive = false;
        member.directDemoted = true;
        member.directDemoteReason = reason;
        member.directGoodStreak = 0;
        member.peerRelayHoldUntil = clock.now() + PEER_RELAY_HOLD_MS;
        log(`peer engine: direct ${member.nodeId} ${why} — relaying`);
        schedulePathReport();
    };
    /** 连续 ≥2 个未回 PING 按一次超上限样本处理：直连中直接降级，
     *  未激活/升级计数中清 streak。 */
    const onPingUnanswered = (nodeId) => {
        const member = members.get(nodeId.toLowerCase());
        if (member === undefined || member.state !== 'eligible')
            return;
        member.directMissedPings += 1;
        if (member.directMissedPings < 2)
            return;
        if (member.directActive) {
            demoteDirect(member, 'path-lost', 'keepalive unanswered ×2');
        }
        else {
            member.directGoodStreak = 0;
        }
    };
    /** T5：保活 PONG 样本驱动上限策略。成员不存在或非 eligible 忽略；
     *  EWMA 永远更新（降级中也采样），降级判断用的是更新前的平滑值——
     *  单个尖峰只把 EWMA 推过线一次，下一次样本前它仍是旧基线。 */
    const onRttSample = (nodeId, rtt) => {
        const member = members.get(nodeId.toLowerCase());
        if (member === undefined || member.state !== 'eligible')
            return;
        member.directMissedPings = 0; // 匹配 PONG 到达即证明链路活着，连 miss 归零
        const prevSmoothed = member.directSmoothedRtt;
        member.directSmoothedRtt =
            prevSmoothed === null ? rtt : prevSmoothed * (1 - DIRECT_EWMA_ALPHA) + rtt * DIRECT_EWMA_ALPHA;
        const cap = directCap();
        if (cap <= 0) {
            if (!member.directActive)
                promoteDirect(member);
            else if (member.directMode === 'p2p')
                applyArqProfile(member, 'p2p', false);
            return;
        }
        if (member.directActive) {
            if (rtt > cap && prevSmoothed !== null && prevSmoothed > cap) {
                demoteDirect(member, 'rtt-cap', `rtt ${rtt}ms over cap ${cap}ms`);
                return;
            }
            if (member.directMode === 'p2p')
                applyArqProfile(member, 'p2p', false);
            return;
        }
        // 未激活（首样本期或已降级）统一口径：连续 DIRECT_PROMOTE_STREAK 个
        // 样本 ≤ cap×0.7 才升直连；超 cap 的样本记降级并把 streak 归零，
        // 介于阈值与 cap 之间的只重置 streak。若刚因对端切回中转触发冷却，
        // 抑止重新晋升直连。
        if (clock.now() < member.peerRelayHoldUntil) {
            member.directGoodStreak = 0;
            return;
        }
        if (rtt <= cap * DIRECT_PROMOTE_RATIO) {
            member.directGoodStreak += 1;
            if (member.directGoodStreak >= DIRECT_PROMOTE_STREAK) {
                promoteDirect(member);
            }
            else {
                punch?.triggerFastProbe(member.nodeId, false);
            }
            return;
        }
        member.directGoodStreak = 0;
        if (!member.directDemoted && rtt > cap) {
            member.directDemoted = true;
            member.directDemoteReason = 'rtt-cap';
            member.path = 'relay';
            log(`peer engine: direct ${member.nodeId} rtt ${rtt}ms over cap ${cap}ms — relaying`);
            schedulePathReport();
        }
    };
    const onDirectLost = (nodeId) => {
        const member = members.get(nodeId);
        if (member === undefined)
            return;
        log(`peer engine: direct lost ${nodeId} — relaying`);
        member.path = 'relay';
        applyArqProfile(member, 'relay', true);
        mux?.setRelayPath(nodeId, true);
        // T5：旧会话的测量与降级状态一起作废，重打通后重走首样本判定。
        member.directMode = null;
        member.directSmoothedRtt = null;
        member.directGoodStreak = 0;
        member.directDemoted = false;
        member.directDemoteReason = null;
        member.directActive = false;
        member.directMissedPings = 0;
        member.peerRelayHoldUntil = 0;
        schedulePathReport();
    };
    // ------------------------------------------------------------ 引擎 API
    const buildPunch = () => {
        if (stopped)
            return null;
        if (punch !== null)
            return punch;
        const net = readPeerNetwork(stateFile);
        if (net === undefined)
            return null;
        // Socket 归一（PG-8）：打洞与 STUN 探测必须共用同一个已绑定的 UDP
        // socket——网关记录并广播的 reflexiveEndpoint 只有在探测帧真的出自
        // 打洞 socket 时才指向 peers 可达的端口。注入 socket（测试/防火墙包装）
        // 未绑定时这里代绑；没有注入时引擎自建一个并持有（stop 时关闭），
        // punch 管理器因此永远走「自带 socket」的路径（ownsSocket=false）。
        if (options.udpSocket !== undefined && punchSocket === undefined) {
            let bound = true;
            try {
                bound = options.udpSocket.address().port > 0;
            }
            catch {
                bound = false;
            }
            if (bound) {
                punchSocket = options.udpSocket;
            }
            else {
                try {
                    options.udpSocket.bind({ port: 0, address: '0.0.0.0' }, () => { });
                    punchSocket = options.udpSocket;
                }
                catch {
                    // 前一轮 resetActiveSession 中 PeerPunchManager.close() 已关闭注入的 socket，
                    // dgram.Socket 关闭后不可重绑（ERR_SOCKET_DGRAM_NOT_RUNNING），回退自建新 socket。
                    punchSocket = undefined;
                }
            }
        }
        if (punchSocket === undefined) {
            const socket = createSocket('udp4');
            socket.unref?.();
            socket.bind({ port: 0, address: '0.0.0.0' }, () => { });
            punchSocket = socket;
        }
        const fastConfirmDelayMs = options.punch?.fastConfirmDelayMs ?? 200;
        const keepAliveMs = options.punch?.keepAliveMs ?? 5_000;
        punch = new PeerPunchManager({
            networkId: net.networkId,
            identity,
            socket: punchSocket,
            clock,
            reprobeInitialDelaysMs: [3_000, 8_000],
            reprobeIntervalMs: 25_000,
            fastConfirmDelayMs,
            ...(options.punch?.pingRetryDelayMs === undefined && fastConfirmDelayMs > 0
                ? { pingRetryDelayMs: Math.min(1_500, Math.floor(keepAliveMs * 0.4)) }
                : {}),
            ...(options.punch ?? {}),
            onDirectReady,
            onPunchFallback,
            onDirectLost,
            onRttSample,
            onPingUnanswered,
            onEncryptedFrame: (header, plaintext) => {
                const m = members.get(header.srcNodeId.toLowerCase());
                mux?.handleOpenedFrame(header, plaintext);
                if (m !== undefined) {
                    const cap = directCap();
                    if (cap > 0 &&
                        !m.directActive &&
                        clock.now() >= m.peerRelayHoldUntil &&
                        (m.directSmoothedRtt === null || m.directSmoothedRtt <= cap * DIRECT_PROMOTE_RATIO)) {
                        punch?.triggerFastProbe(m.nodeId, true);
                    }
                }
            },
        });
        return punch;
    };
    const buildMux = () => {
        if (mux !== null)
            return mux;
        const net = readPeerNetwork(stateFile);
        mux = new PeerMux({
            networkId: net?.networkId ?? '0000000000000000',
            identity,
            sendGatewayBinary,
            relayHandler: options.relayHandler,
            relaySecret: options.relaySecret,
            clock,
            relayHandlerWaitMs: options.relayHandlerWaitMs ?? 3_000,
            directPromoteGraceMs: () => directCap() > 0
                ? Math.max(6_000, (options.punch?.keepAliveMs ?? 5_000) + 1_000)
                : 400,
            onDirectStalled: (peerNodeId) => {
                if (stopped)
                    return;
                const m = members.get(peerNodeId.toLowerCase());
                if (m !== undefined && m.state === 'eligible' && m.directActive) {
                    demoteDirect(m, 'path-lost', 'direct arq stalled');
                }
            },
            onPathChanged: (peerNodeId, path) => {
                if (path === 'ws' || path === 'udp') {
                    void options.relayPool.reconnect?.(peerNodeId);
                }
            },
            onPeerRelayDemoted: (peerNodeId) => {
                if (stopped)
                    return;
                const member = members.get(peerNodeId.toLowerCase());
                if (member === undefined)
                    return;
                member.path = 'relay';
                member.directActive = false;
                member.directDemoted = true;
                member.directDemoteReason = 'peer-relay';
                member.directGoodStreak = 0;
                member.peerRelayHoldUntil = clock.now() + PEER_RELAY_HOLD_MS;
                applyArqProfile(member, 'relay', true);
                schedulePathReport();
                log(`peer engine: peer ${member.nodeId} demoted to relay — syncing local path`);
            },
            log,
            debug: options.debug,
        });
        return mux;
    };
    const resetActiveSession = () => {
        clearAuthDeadline();
        for (const member of [...members.values()]) {
            unmountPeer(member);
            mux?.dropSession(member.nodeId);
            punch?.dropPeer(member.nodeId);
        }
        members.clear();
        if (wsReconnectTimer !== null) {
            clock.clearTimeout(wsReconnectTimer);
            wsReconnectTimer = null;
        }
        if (pathReportTimer !== null) {
            clock.clearTimeout(pathReportTimer);
            pathReportTimer = null;
        }
        if (pathReportArmed.timer !== null) {
            clock.clearTimeout(pathReportArmed.timer);
            pathReportArmed.timer = null;
        }
        wsReconnectable = false;
        wsHadOpen = false;
        wsClosedAfterOpen = false;
        selfWsReanchorEpoch = 0;
        selfLanReanchorEpoch = 0;
        lastSelfLanKey = null;
        try {
            ws?.close();
        }
        catch { /* dying */ }
        ws = null;
        mux?.close();
        mux = null;
        punch?.close();
        punch = null;
        // PeerPunchManager.close() 关闭了底层 dgram socket；引擎自建的 punchSocket
        // 必须清空引用，下一轮 joinNetwork 的 buildPunch() 才会重建已绑定新 socket，
        // 避免在已关闭 socket 上等待 ready() 永久挂起。
        if (punchSocket !== undefined && punchSocket !== options.udpSocket) {
            try {
                punchSocket.close();
            }
            catch { /* already closed */ }
        }
        punchSocket = undefined;
        // 换代：resetActiveSession 先把 ws 置 null，旧连接的 close 事件因此不会
        // 走到 close 回调里的换代（ws !== client 早退）——这里必须自己换代，
        // 换网/leave 之后在途探测的迟到结果才不会写进新会话。
        connEpoch += 1;
        natType = null;
        maxPeers = null;
        deniedReason = null;
        hasReceivedWelcome = false;
        gatewayVersionFromGateway = null;
        recommendedPluginVersionFromGateway = null;
        gatewayWireCompatLevel = null;
    };
    return {
        async joinNetwork(invite) {
            if (stopped)
                return { ok: false, code: 'stopped' };
            const parsed = parseInviteUri(invite);
            if (parsed === null)
                return { ok: false, code: 'invalid-invite' };
            const existing = readPeerNetwork(stateFile);
            const sameNet = existing?.networkId === parsed.networkId;
            // 切换网络或重填地址重新入网时，先拆掉上一轮挂起/在线的 WS、mux 与打洞器。
            resetActiveSession();
            writePeerRevokedNotice(stateFile, undefined);
            writePeerNetwork(stateFile, {
                inviteUri: invite,
                gatewayWsUrl: parsed.wsUrl,
                gatewayHttpOrigin: parsed.httpOrigin,
                networkId: parsed.networkId,
                joinedAt: clock.now(),
                ...(parsed.joinKey !== undefined ? { joinKey: parsed.joinKey } : {}),
                ...(sameNet && existing?.disabledNodes !== undefined ? { disabledNodes: existing.disabledNodes } : {}),
                ...(sameNet && existing?.maxPeersFromGateway !== undefined ? { maxPeersFromGateway: existing.maxPeersFromGateway } : {}),
                ...(sameNet && existing?.peerDirectMaxRttMsFromGateway !== undefined ? { peerDirectMaxRttMsFromGateway: existing.peerDirectMaxRttMsFromGateway } : {}),
            });
            capFromGateway = sameNet ? (existing?.peerDirectMaxRttMsFromGateway ?? null) : null;
            networkId = parsed.networkId;
            wsReconnectable = true;
            wsAttempt = 0;
            // 先备好打洞 socket（lanEndpoints 要随 auth 上送）与 mux，再连网关。
            const manager = buildPunch();
            if (manager !== null)
                await manager.ready();
            buildMux();
            connectWs();
            return { ok: true };
        },
        resumeFromState() {
            if (stopped)
                return false;
            const net = readPeerNetwork(stateFile);
            if (net === undefined)
                return false;
            capFromGateway = net.peerDirectMaxRttMsFromGateway ?? null;
            networkId = net.networkId;
            wsReconnectable = true;
            wsAttempt = 0;
            // joinNetwork 的同一条序列，只是不落盘（记录已在）：apply 是同步的，
            // 打洞 socket 的 ready 在后台等待，auth 帧晚一拍上送没有影响——
            // challenge 本来就要等网关回应才发。
            void (async () => {
                try {
                    const manager = buildPunch();
                    if (manager !== null)
                        await manager.ready();
                    if (stopped || punch !== manager)
                        return;
                    buildMux();
                    connectWs();
                }
                catch (err) {
                    log(`peer engine: resumeFromState failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            })();
            return true;
        },
        leaveNetwork() {
            // 必须在首个 await 之前同步完成本地拆除与凭据抹除：保留既往调用方的
            // 同步断言与并发 joinNetwork 安全，再尽最大努力通知网关注销本机成员。
            const prevNet = readPeerNetwork(stateFile);
            resetActiveSession();
            networkId = null;
            gatewayState = 'unconfigured';
            writePeerNetwork(stateFile, undefined);
            if (prevNet === undefined)
                return Promise.resolve({ ok: true, gatewaySynced: true });
            return (async () => {
                try {
                    const timestamp = clock.now();
                    const signatureHex = signGatewayLeave({
                        privateKeyHex: identity.privateKeyHex,
                        publicKeyHex: identity.publicKeyHex,
                        networkId: prevNet.networkId,
                        nodeId: identity.nodeId,
                        timestamp,
                    });
                    const leaveUrl = `${prevNet.gatewayHttpOrigin.replace(/\/+$/, '')}/peer/v1/leave`;
                    const res = await fetchImpl(leaveUrl, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                            networkId: prevNet.networkId,
                            nodeId: identity.nodeId,
                            publicKeyHex: identity.publicKeyHex,
                            timestamp,
                            signatureHex,
                        }),
                        signal: AbortSignal.timeout(options.leaveTimeoutMs ?? 3000),
                    });
                    return { ok: true, gatewaySynced: res.ok };
                }
                catch {
                    return { ok: true, gatewaySynced: false };
                }
            })();
        },
        dismissRevokedNotice() {
            writePeerRevokedNotice(stateFile, undefined);
            if (networkId === null && gatewayState === 'revoked') {
                gatewayState = 'unconfigured';
                deniedReason = null;
            }
        },
        setNodeDisabled(nodeId, disabled) {
            const id = nodeId.toLowerCase();
            setPeerNodeDisabled(stateFile, id, disabled);
            const member = members.get(id);
            if (disabled) {
                if (member !== undefined) {
                    member.state = 'disabled';
                    member.path = 'none';
                    unmountPeer(member);
                    mux?.dropSession(id);
                    punch?.dropPeer(id);
                    refreshMounts();
                    schedulePathReport();
                }
            }
            else if (member !== undefined && gatewayState === 'authorized') {
                announcePeer({
                    nodeId: id,
                    publicKeyHex: member.publicKeyHex,
                    name: member.name,
                    lanEndpoints: member.lastLanEndpoints,
                    reflexiveEndpoint: member.lastReflexive,
                    startPunch: true,
                });
                if (member.state === 'eligible')
                    mux?.enableRelayPath(id);
                schedulePathReport();
            }
        },
        announceSelfName(name) {
            if (stopped)
                return;
            const trimmed = typeof name === 'string' ? name.trim().slice(0, 64) : '';
            if (trimmed === '')
                return;
            if (gatewayState === 'authorized' || gatewayState === 'pending-approval') {
                sendControl({ type: 'rename', name: trimmed });
            }
        },
        trustPeer(nodeId) {
            const id = nodeId.toLowerCase();
            const member = members.get(id);
            if (member === undefined)
                return false;
            const moved = repinPeerKey(stateFile, id, member.publicKeyHex);
            if (!moved)
                return false;
            // 换锚成功：按一条全新公告放行（挂载 + WS 中转握手 + 重新打洞）。
            announcePeer({
                nodeId: id,
                publicKeyHex: member.publicKeyHex,
                name: member.name,
                lanEndpoints: member.lastLanEndpoints,
                reflexiveEndpoint: member.lastReflexive,
                startPunch: true,
            });
            mux?.enableRelayPath(id);
            schedulePathReport(); // PC-16a：blocked→放行是路径事实变化，及时顶掉旧边
            return true;
        },
        reprobePunch() {
            if (punch === null || stopped)
                return;
            for (const member of members.values()) {
                if (member.state !== 'eligible')
                    continue;
                try {
                    punch.beginPunch({
                        peerNodeId: member.nodeId,
                        peerPublicKeyHex: member.publicKeyHex,
                        lanEndpoints: member.lastLanEndpoints,
                        ...(member.lastReflexive !== null ? { reflexiveEndpoint: member.lastReflexive } : {}),
                    });
                }
                catch {
                    // 候选无效——下一轮坐标再试。
                }
            }
        },
        refreshMounts,
        status() {
            const peers = [];
            const peerVersions = [];
            for (const member of members.values()) {
                peerVersions.push(member.pluginVersion);
                peers.push({
                    nodeId: member.nodeId,
                    name: member.name,
                    state: member.state,
                    path: member.path,
                    rttMs: currentPathRttMs(member),
                    mounted: member.mounted,
                    directRttMs: member.directSmoothedRtt === null ? null : Math.round(member.directSmoothedRtt),
                    directDemoted: member.directDemoted,
                    directDemoteReason: member.directDemoted ? member.directDemoteReason : null,
                    pluginVersion: member.pluginVersion,
                });
            }
            const selfPluginVersion = parseSemver(options.pluginVersion?.())?.normalized ?? (options.pluginVersion?.() ?? '');
            const recommendedGatewayVersion = parseSemver(options.recommendedGatewayVersion?.())?.normalized ?? (options.recommendedGatewayVersion?.() ?? '');
            const maxPeerPluginVersion = maxSemver(...peerVersions);
            const versionSync = hasReceivedWelcome || gatewayVersionFromGateway !== null
                ? evaluatePeerVersionSync({
                    pluginVersion: selfPluginVersion,
                    recommendedGatewayVersion,
                    gatewayVersion: gatewayVersionFromGateway,
                    recommendedPluginVersion: recommendedPluginVersionFromGateway,
                    maxPeerPluginVersion,
                    gatewayWireCompatLevel,
                })
                : {
                    pluginVersion: selfPluginVersion,
                    gatewayVersion: null,
                    recommendedGatewayVersion,
                    wireCompatLevel: gatewayWireCompatLevel ?? PEER_WIRE_COMPAT_LEVEL,
                    gatewayOutdated: false,
                    pluginOutdated: parseSemver(selfPluginVersion) !== null &&
                        maxSemver(recommendedPluginVersionFromGateway, maxPeerPluginVersion) !== null &&
                        evaluatePeerVersionSync({
                            pluginVersion: selfPluginVersion,
                            recommendedGatewayVersion,
                            gatewayVersion: recommendedGatewayVersion || '0.0.0',
                            recommendedPluginVersion: recommendedPluginVersionFromGateway,
                            maxPeerPluginVersion,
                            gatewayWireCompatLevel,
                        }).pluginOutdated,
                    newerPluginVersion: parseSemver(selfPluginVersion) !== null
                        ? evaluatePeerVersionSync({
                            pluginVersion: selfPluginVersion,
                            recommendedGatewayVersion,
                            gatewayVersion: recommendedGatewayVersion || '0.0.0',
                            recommendedPluginVersion: recommendedPluginVersionFromGateway,
                            maxPeerPluginVersion,
                            gatewayWireCompatLevel,
                        }).newerPluginVersion
                        : null,
                    inferredLegacyGateway: false,
                };
            return {
                nodeId: identity.nodeId,
                gatewayState,
                deniedReason,
                revokedNotice: readPeerRevokedNotice(stateFile) ?? null,
                networkId,
                maxPeers,
                natType,
                peers,
                directCapMs: directCap(),
                directCapSource: capFromGateway === null ? 'default' : 'gateway',
                versionSync,
            };
        },
        stop() {
            if (stopped)
                return;
            stopped = true;
            clearAuthDeadline();
            deniedReason = null;
            for (const member of [...members.values()])
                unmountPeer(member);
            members.clear();
            if (wsReconnectTimer !== null) {
                clock.clearTimeout(wsReconnectTimer);
                wsReconnectTimer = null;
            }
            if (pathReportTimer !== null) {
                clock.clearTimeout(pathReportTimer);
                pathReportTimer = null;
            }
            if (pathReportArmed.timer !== null) {
                clock.clearTimeout(pathReportArmed.timer);
                pathReportArmed.timer = null;
            }
            try {
                ws?.close();
            }
            catch { /* dying */ }
            ws = null;
            mux?.close();
            mux = null;
            punch?.close();
            punch = null;
            // 自建 socket 在这里收口；注入的 socket 归调用方，引擎不代关。
            if (punchSocket !== undefined && punchSocket !== options.udpSocket) {
                try {
                    punchSocket.close();
                }
                catch { /* already closed */ }
            }
            punchSocket = undefined;
            gatewayState = 'unconfigured';
        },
    };
}
//# sourceMappingURL=engine.js.map