// 中继限速与实时速率统计（PG-5）。纯内存、零 I/O；时钟可注入以便测试。
//
// 1. 令牌桶：按 (networkId, nodeId) 各一桶，速率实时取调用方传入的
//    relayRateKbps * 1024 bytes/s（每次 tryRelay 现算，管理员改设置即刻生效），
//    突发桶容量 = 1 秒的量。超限丢弃（背压从发送方 ACK 缺口自然回传），
//    不做排队——排队只会把打满的带宽延迟变成堆积的内存。
// 2. 5 秒滑动窗口速率：每次成功转发记一条 (时刻, 字节, 归属) 事件，写入与
//    读数时都裁掉窗口外的事件（PC-18：无人订阅读取也保持持有量有界）。
//    PC-17 单位契约：各 liveRelayKbps* 读数（含
//    API 字段 liveRelayKbps / totalLiveRelayKbps / relayKbps）数值都是
//    KB/s = 1024 字节/秒（kilobytes，不是 kilobits），与 relayRateKbps
//    配置和界面 KB/s 文案同单位：读数 = 窗口字节 / (窗口秒) / 1024，不乘 8。
//    支持按全网 / 单节点 / 无序节点对聚合，供 /topology 与 GatewayRuntimeStats。
// 3. pendingRelayBytes：自上次 drain 起每成员累计的中转字节，由 ws-hub 的
//    定时刷盘经 store.flushMemberTelemetry 落库后清零。
export interface RelayScope {
  networkId: string;
  nodeId: string;
  /** 可选：转发目标，供节点对聚合 */
  peerNodeId?: string;
}

export interface RateLimiterOptions {
  /** 滑动窗口宽度，默认 5000ms */
  windowMs?: number;
  /** 时钟注入，默认 Date.now */
  now?: () => number;
}

interface WindowEvent {
  at: number;
  bytes: number;
  networkId: string;
  nodeId: string;
  peerNodeId: string | undefined;
}

interface TokenBucket {
  tokens: number;
  updatedAt: number;
}

interface MemberKey {
  networkId: string;
  nodeId: string;
}

const memberKey = (m: MemberKey): string => `${m.networkId}|${m.nodeId}`;
const pairKey = (networkId: string, a: string, b: string): string =>
  a < b ? `${networkId}|${a}|${b}` : `${networkId}|${b}|${a}`;

export class PeerRateLimiter {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly pending = new Map<string, { member: MemberKey; bytes: number }>();
  private readonly events: WindowEvent[] = [];
  /** events[head] 起为窗口内事件；head 之前的死引用由摊销压缩统一释放 */
  private head = 0;

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 5000;
    this.now = options.now ?? Date.now;
  }

  /**
   * 尝试按令牌桶放行一次转发。速率每次现取（bytes/s = rateKbps * 1024），
   * 成功时记滑窗事件并累加 pending 字节；桶不够直接丢弃返回 false。
   */
  tryRelay(scope: RelayScope, bytes: number, rateKbps: number): boolean {
    if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(rateKbps) || rateKbps <= 0) return false;
    const now = this.now();
    const rateBytesPerSec = rateKbps * 1024;
    const capacity = rateBytesPerSec; // 突发 = 1 秒量
    const key = memberKey(scope);
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updatedAt: now };
    const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * rateBytesPerSec);
    bucket.updatedAt = now;
    if (bucket.tokens < bytes) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= bytes;
    this.buckets.set(key, bucket);
    this.events.push({ at: now, bytes, networkId: scope.networkId, nodeId: scope.nodeId, peerNodeId: scope.peerNodeId });
    this.pruneWindow(); // PC-18：写入路径同样淘汰窗口外事件，无人读取也保持有界
    const pending = this.pending.get(key) ?? { member: { networkId: scope.networkId, nodeId: scope.nodeId }, bytes: 0 };
    pending.bytes += bytes;
    this.pending.set(key, pending);
    return true;
  }

  /**
   * 裁掉滑窗外的旧事件（读路径与写路径共用）。头游标前移跳过过期事件——每个
   * 事件一生只被跳过一次，无逐包拷贝；死前缀过半时一次性摊销压缩（splice 把
   * 活事件搬到表头），过期事件引用随之释放，持有量始终有界（约 ≤ 2× 单窗口
   * 内容），无人订阅持续转发也不会无限增长。
   */
  private pruneWindow(): void {
    const cutoff = this.now() - this.windowMs;
    let head = this.head;
    while (head < this.events.length && (this.events[head] as WindowEvent).at <= cutoff) head++;
    this.head = head;
    if (head > 0 && head * 2 >= this.events.length) {
      this.events.splice(0, head);
      this.head = 0;
    }
  }

  private sumWhere(filter: (e: WindowEvent) => boolean): number {
    this.pruneWindow();
    let total = 0;
    for (let i = this.head; i < this.events.length; i++) {
      const e = this.events[i] as WindowEvent;
      if (filter(e)) total += e.bytes;
    }
    return total;
  }

  /** 全网关实时中转速率（KB/s，1024 字节/秒；字段名沿用 kbps 后缀保持 API 兼容） */
  liveRelayKbpsTotal(): number {
    return this.kbPerSec(this.sumWhere(() => true));
  }

  /** 单个虚拟网络的实时中转速率（KB/s，1024 字节/秒） */
  liveRelayKbpsByNetwork(networkId: string): number {
    return this.kbPerSec(this.sumWhere((e) => e.networkId === networkId));
  }

  /** 单成员（作为发送方）的实时速率（KB/s，1024 字节/秒） */
  liveRelayKbpsByNode(networkId: string, nodeId: string): number {
    return this.kbPerSec(this.sumWhere((e) => e.networkId === networkId && e.nodeId === nodeId));
  }

  /** 无序节点对的实时速率（KB/s，1024 字节/秒）：A→B 与 B→A 合并计 */
  liveRelayKbpsPair(networkId: string, a: string, b: string): number {
    const wanted = pairKey(networkId, a, b);
    return this.kbPerSec(
      this.sumWhere((e) => e.networkId === networkId && pairKey(networkId, e.nodeId, e.peerNodeId ?? '') === wanted),
    );
  }

  /** 窗口字节 → KB/s（1024 字节/秒）。绝不乘 8：那是把单位变成 kilobits 的老错 */
  private kbPerSec(windowBytes: number): number {
    return windowBytes / (this.windowMs / 1000) / 1024;
  }

  /** 自上次 drain 起某成员累计的中转字节 */
  pendingRelayBytes(networkId: string, nodeId: string): number {
    return this.pending.get(memberKey({ networkId, nodeId }))?.bytes ?? 0;
  }

  /** 取走全部待刷盘字节并清零（由 ws-hub 定时经 flushMemberTelemetry 落库） */
  drainAllPending(): Array<{ networkId: string; nodeId: string; bytes: number }> {
    const out = [...this.pending.values()].map((p) => ({ networkId: p.member.networkId, nodeId: p.member.nodeId, bytes: p.bytes }));
    this.pending.clear();
    return out;
  }
}
