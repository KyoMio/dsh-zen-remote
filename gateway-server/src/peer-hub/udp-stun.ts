// 双 UDP 端口轻量 STUN 与打洞协调（PG-5）。
//
// 绑定主端口（默认与 HTTP 同号的 19393/udp）与可选辅助端口（默认 19394/udp，
// 传 0 跳过）。节点发来签过名的 JSON 探测包，网关校验自证明签名（防伪造
// 反射更新）后「原路回包」它的反射地址；同一 (networkId, nodeId) 在短窗口内
// 先后命中主、辅两个端口时按端口映射行为分类 NAT：
//
//   两次反射 (ip, port) 完全一致            → 'cone'（与节点上报 lanEndpoints
//                                             完全一致则为 'public'——地址不
//                                             经 NAT，探测只是自我确认）
//   反射 ip 一致而 port 不同（或 ip 也变）  → 'symmetric'（每目标新映射，
//                                             打洞命中率极低，走中继为主）
//
// 判定结果经 onNatDetected 回调交给 ws-hub（更新内存端点与 natType、排入
// 遥测刷盘、推控制台 SSE）。解析失败的包静默丢弃——UDP 上垃圾是常态。
import { createSocket } from 'node:dgram';
import type { RemoteInfo, Socket } from 'node:dgram';

import { normalizeNetworkId, normalizeNodeId, normalizePublicKeyHex, verifyStunProbeSignature } from './peer-crypto.js';

export type ServerPortRole = 'primary' | 'alt';

export interface NatObservation {
  networkId: string;
  nodeId: string;
  natType: 'cone' | 'symmetric' | 'public';
  reflexiveIp: string;
  reflexivePort: number;
  serverPortRole: ServerPortRole;
}

export interface UdpStunOptions {
  /** 主 UDP 端口（0 交由内核分配——测试用） */
  primaryPort: number;
  /** 辅助 UDP 端口：null/undefined = 不开辅助口（单口也能应答，只是判不出
   *  NAT 类型）；0 = 内核分配随机端口；正数 = 固定端口。配置层
   * `udpAltPort === 0 表示关闭` 的语义由组合根映射成 null */
  altPort?: number | null;
  /** 绑定地址，默认 '0.0.0.0' */
  host?: string;
  /** 同一节点主/辅两次探测的最大间隔，默认 10000ms */
  windowMs?: number;
  /** 时间戳新鲜度窗口（±，默认 5 分钟，与入网签名一致） */
  timestampWindowMs?: number;
  now?: () => number;
  /** NAT 判定回调；抛错只记一次判定失败，不影响 UDP 服务 */
  onNatDetected: (record: NatObservation) => void;
  /** Production must bind the hub's live admission check. Omission is standalone
   * stateless STUN mode (also used by isolated protocol tests), not gateway authorization.
   * Return a stable token for this connection, a new token on replacement, or null to deny. */
  admitProbe?: (networkId: string, nodeId: string, publicKeyHex: string) => symbol | null;
  /** 查询节点上报的 lanEndpoints（`ip:port` 字符串数组），用于 public 判定 */
  lanEndpointsLookup?: (networkId: string, nodeId: string) => readonly string[];
}

interface ProbeSlot {
  admission: symbol;
  at: number;
  ip: string;
  port: number;
}

const MAX_PACKET_BYTES = 1024;

export class UdpStunService {
  private readonly options: UdpStunOptions;
  private readonly windowMs: number;
  private readonly timestampWindowMs: number;
  private readonly now: () => number;
  private readonly standaloneAdmission = Symbol();
  private primary: Socket | null = null;
  private alt: Socket | null = null;
  /** (networkId|nodeId) → 主/辅两个端口最近一次探测 */
  private readonly slots = new Map<string, { primary?: ProbeSlot; alt?: ProbeSlot }>();

  constructor(options: UdpStunOptions) {
    this.options = options;
    this.windowMs = options.windowMs ?? 10_000;
    this.timestampWindowMs = options.timestampWindowMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** 绑定两个（或单个）UDP 端口，返回实际端口（port=0 时为内核分配值） */
  async bind(): Promise<{ primaryPort: number; altPort: number | null }> {
    const host = this.options.host ?? '0.0.0.0';
    this.primary = createSocket('udp4');
    this.primary.on('message', (buf, rinfo) => void this.handlePacket(this.primary as Socket, 'primary', buf, rinfo));
    this.primary.on('error', () => {/* 单包错误不影响服务；socket 级错误下次 bind 暴露 */});
    await this.listen(this.primary, this.options.primaryPort, host);
    const altPort = this.options.altPort;
    if (altPort !== null && altPort !== undefined) {
      this.alt = createSocket('udp4');
      this.alt.on('message', (buf, rinfo) => void this.handlePacket(this.alt as Socket, 'alt', buf, rinfo));
      this.alt.on('error', () => {});
      await this.listen(this.alt, altPort, host);
    }
    return {
      primaryPort: this.primary.address().port,
      altPort: this.alt !== null ? this.alt.address().port : null,
    };
  }

  private listen(socket: Socket, port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, host, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
  }

  private async handlePacket(socket: Socket, role: ServerPortRole, buf: Buffer, rinfo: RemoteInfo): Promise<void> {
    if (buf.length > MAX_PACKET_BYTES) return;
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(buf.toString('utf8'));
      if (typeof value !== 'object' || value === null) return;
      parsed = value as Record<string, unknown>;
    } catch {
      return;
    }
    if (parsed['type'] !== 'stun-probe') return;
    const networkId = normalizeNetworkId(parsed['networkId']);
    const nodeId = normalizeNodeId(parsed['nodeId']);
    const publicKeyHex = normalizePublicKeyHex(parsed['publicKeyHex']);
    const nonce = typeof parsed['nonce'] === 'string' ? parsed['nonce'] : null;
    const timestamp = typeof parsed['timestamp'] === 'number' ? parsed['timestamp'] : null;
    const signatureHex = typeof parsed['signatureHex'] === 'string' ? parsed['signatureHex'] : null;
    if (networkId === null || nodeId === null || publicKeyHex === null) return;
    if (nonce === null || timestamp === null || signatureHex === null) return;
    if (!verifyStunProbeSignature({
      networkId,
      nodeId,
      publicKeyHex,
      nonce,
      timestamp,
      signatureHex,
    })) return;
    if (Math.abs(this.now() - timestamp) > this.timestampWindowMs) return;

    const admitted = () => this.options.admitProbe === undefined
      ? this.standaloneAdmission : this.options.admitProbe(networkId, nodeId, publicKeyHex);
    const admission = admitted();
    if (admission === null) return;

    // 先原路回包再分类——反射应答不依赖对方是否探测过另一个端口
    const reply = Buffer.from(JSON.stringify({
      type: 'stun-reply',
      nonce: typeof nonce === 'string' ? nonce.toLowerCase() : nonce,
      reflexiveIp: rinfo.address,
      reflexivePort: rinfo.port,
      serverPortRole: role,
    }));
    await new Promise<void>((resolve) => socket.send(reply, rinfo.port, rinfo.address, () => resolve()));

    // A disable/re-enable or same-identity reconnect invalidates this pending reply.
    if (admitted() !== admission) return;
    this.classify(networkId, nodeId, role, rinfo.address, rinfo.port, admission);
  }

  /** 记录本次探测并与另一端口短窗口内的上次探测比对，判定 NAT 类型 */
  private classify(networkId: string, nodeId: string, role: ServerPortRole, ip: string, port: number, admission: symbol): void {
    const key = `${networkId}|${nodeId}`;
    const entry = this.slots.get(key) ?? {};
    const now = this.now();
    // 惰性清扫：条目一多就顺手裁掉窗口外的，防长期运行内存缓涨
    if (this.slots.size > 1024) {
      for (const [k, v] of this.slots) {
        const fresh = (v.primary !== undefined && now - v.primary.at <= this.windowMs)
          || (v.alt !== undefined && now - v.alt.at <= this.windowMs);
        if (!fresh) this.slots.delete(k);
      }
    }
    entry[role] = { admission, at: now, ip, port };
    this.slots.set(key, entry);

    const otherRole: ServerPortRole = role === 'primary' ? 'alt' : 'primary';
    const other = entry[otherRole];
    if (other === undefined || other.admission !== admission || now - other.at > this.windowMs) return;

    const sameIp = other.ip === ip;
    const samePort = other.port === port;
    let natType: 'cone' | 'symmetric' | 'public';
    if (sameIp && samePort) {
      const lan = this.options.lanEndpointsLookup?.(networkId, nodeId) ?? [];
      natType = lan.includes(`${ip}:${port}`) ? 'public' : 'cone';
    } else {
      natType = 'symmetric';
    }
    try {
      this.options.onNatDetected({
        networkId,
        nodeId,
        natType,
        reflexiveIp: ip,
        reflexivePort: port,
        serverPortRole: role,
      });
    } catch {
      /* 观察方故障不影响 UDP 服务 */
    }
  }

  async close(): Promise<void> {
    const sockets = [this.primary, this.alt].filter((s): s is Socket => s !== null);
    this.primary = null;
    this.alt = null;
    this.slots.clear();
    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.close(() => resolve());
          }),
      ),
    );
  }
}
