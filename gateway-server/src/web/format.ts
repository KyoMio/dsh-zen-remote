// 控制台纯格式化函数（PG-6b）：速率、字节、延迟区间、相对时间、连接路径
// 分类与成员状态展示。零 DOM 依赖：后端 tsc 编译进 dist/web/（测试可 import），
// 浏览器半边经 tsconfig.web.json 类型检查——两边共享同一份实现。

import type { TranslateFn } from './i18n/locales.js';
import type { MemberStatus, TopologyLink, TopologyMemberRow } from './store/console-store.js';

/**
 * 实时中转速率：'0 KB/s'、'12 KB/s'、'1.5 MB/s'（任务单要求等宽大字展示）。
 * 入参单位契约（PC-17）：KB/s = 1024 字节/秒——即拓扑 API 里 liveRelayKbps /
 * totalLiveRelayKbps / relayKbps 字段的数值（kilobytes，不是 kilobits），
 * 与 relayRateKbps 配置同单位；字段名的 kbps 后缀只是历史拼写，不乘 8。
 */
export function formatRate(kbps: number): string {
  if (!Number.isFinite(kbps) || kbps <= 0) return '0 KB/s';
  if (kbps < 1024) return `${Math.round(kbps)} KB/s`;
  const mbps = kbps / 1024;
  return `${mbps >= 100 ? Math.round(mbps) : Math.round(mbps * 10) / 10} MB/s`;
}

/** 累计中转字节：'0 KB'、'800 KB'、'64.2 MB'、'1.3 GB' */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const kb = bytes / 1024;
  if (kb < 1) return `${Math.round(bytes)} B`;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
  const gb = mb / 1024;
  return `${gb >= 100 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

/**
 * 延迟读数：单值 '12 ms'，区间取最值 '12–30 ms'，无数据 '—'。
 * null（未知——中继/阻断路径没有测速协议）与实测 0 是两种观测：先滤掉
 * null 与契约外的 junk 值（负数等）再取最值，绝不走 Math.min(null)=0 的
 * 强转老路；实测 0 是真实数字，原样显示 '0 ms'。
 */
export function formatLatencyRange(rttMsValues: readonly (number | null)[]): string {
  const known = rttMsValues.filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0);
  if (known.length === 0) return '—';
  const round = (v: number): number => Math.round(v * 10) / 10;
  const min = round(Math.min(...known));
  const max = round(Math.max(...known));
  return min === max ? `${min} ms` : `${min}–${max} ms`;
}

// ---------------------------------------------------------------- 相对时间

export type RelativeTime =
  | { kind: 'now' }
  | { kind: 'minutes'; minutes: number }
  | { kind: 'hours'; hours: number }
  | { kind: 'days'; days: number };

/** ISO 时间 → 相对时间档位（组件据此选 time.* 词条）；无效/null 一律按「刚刚」 */
export function relativeTime(iso: string | null, now: number): RelativeTime {
  if (iso === null) return { kind: 'now' };
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return { kind: 'now' };
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return { kind: 'now' };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { kind: 'minutes', minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: 'hours', hours };
  return { kind: 'days', days: Math.floor(hours / 24) };
}

/** 相对时间 → 本地化文案（配 time.* 词条） */
export function relativeText(t: TranslateFn, rt: RelativeTime): string {
  switch (rt.kind) {
    case 'now':
      return t('time.justNow');
    case 'minutes':
      return t('time.minutesAgo', { n: rt.minutes });
    case 'hours':
      return t('time.hoursAgo', { n: rt.hours });
    case 'days':
      return t('time.daysAgo', { n: rt.days });
  }
}

// ---------------------------------------------------------------- 连接路径

/**
 * 节点自报路径 → 五类连接（lan=局域网直连 / direct=直连 / relay=经网关中转 /
 * blocked=节点本机阻断 / unknown=白名单外未知）。blocked 与 unknown 各自独立：
 * 阻断不是中转，未知也不伪装成任何已知连接方式（PC16b）。
 */
export type LinkKind = 'lan' | 'direct' | 'relay' | 'blocked' | 'unknown';

export function classifyLinkPath(path: string): LinkKind {
  if (path === 'lan') return 'lan';
  if (path === 'p2p' || path === 'direct') return 'direct';
  if (path === 'relay') return 'relay';
  if (path === 'blocked') return 'blocked';
  return 'unknown';
}

// ---------------------------------------------------------------- 成员状态展示

/** 设备展示名：无名字的设备落「未命名设备」 */
export function displayName(member: TopologyMemberRow, t: TranslateFn): string {
  return member.name ?? t('devices.unnamed');
}

export type StatusDot = 'ok' | 'warn' | 'danger' | 'muted';

/** 成员五态 + 在线位 → 圆点档位与状态词（Dot Rule：圆点只这四档；Warn 只留给中转连接点与加入申请） */
export function memberStatusView(status: MemberStatus, online: boolean, t: TranslateFn): { dot: StatusDot; word: string } {
  switch (status) {
    case 'authorized':
      return online ? { dot: 'ok', word: t('status.online') } : { dot: 'muted', word: t('status.offline') };
    case 'pending':
      return { dot: 'warn', word: t('status.pending') };
    case 'paused':
      return { dot: 'muted', word: t('status.paused') };
    case 'mismatch':
      return { dot: 'danger', word: t('status.mismatch') };
    case 'revoked':
      return { dot: 'muted', word: t('status.revoked') };
  }
}

// ---------------------------------------------------------------- 邀请链接掩码

/**
 * 邀请链接只掩入网口令：保留 # 之前的 zr-net://<host>/<networkId>（设备名、
 * 网络标识要看得见），# 之后整体换成圆点；不含 # 时原样返回。
 */
export function maskInviteUri(joinUri: string): string {
  const hashIndex = joinUri.indexOf('#');
  if (hashIndex === -1) return joinUri;
  return `${joinUri.slice(0, hashIndex)}#••••••••`;
}

// ---------------------------------------------------------------- 占席位成员

/**
 * 底部设备表与设备详情连接表只看占席位成员（authorized / paused / mismatch）：
 * pending 只出现在概览「加入申请」格，revoked 已移除，都不该混进设备列表。
 */
export function filterJoinedMembers(members: readonly TopologyMemberRow[]): TopologyMemberRow[] {
  return members.filter((m) => m.status === 'authorized' || m.status === 'paused' || m.status === 'mismatch');
}

// ---------------------------------------------------------------- 设备间连接行

/** 「到其他设备的连接」表的一行：圆点档位 + 连接方式词 + 固定平实原因 + 等宽延迟 */
export interface PeerConnRow {
  dot: StatusDot;
  kindWord: string;
  reason: string;
  latency: string;
}

/** 两设备间的全部路径观测（每个方向各一条自报，两条都算事实） */
function linksBetween(links: readonly TopologyLink[], a: string, b: string): TopologyLink[] {
  return links.filter(
    (l) => (l.srcNodeId === a && l.peerNodeId === b) || (l.srcNodeId === b && l.peerNodeId === a),
  );
}

/**
 * 固定原因文案表（对齐 ui-ux-spec §3.5）：身份异常阻断最优先，其次对方暂停 /
 * 本机暂停 / 离线，再才是链路观测（节点本机阻断 / 局域网 / 直连 / 中转 /
 * 未知路径），最后是空闲未连接。判序即语义：有链路但任一方离线时仍显示
 * 「设备当前离线」。
 */
export function derivePeerConnRow(
  t: TranslateFn,
  self: TopologyMemberRow,
  other: TopologyMemberRow,
  links: readonly TopologyLink[],
): PeerConnRow {
  const notConnected = (reason: string): PeerConnRow => ({
    dot: 'muted',
    kindWord: t('device.notConnected'),
    reason,
    latency: '—',
  });

  if (self.status === 'mismatch' || other.status === 'mismatch') {
    return { dot: 'danger', kindWord: t('device.blocked'), reason: t('device.reasonMismatchBlocked'), latency: '—' };
  }
  if (other.status === 'paused') {
    return notConnected(t('device.reasonPeerPaused'));
  }
  if (self.status === 'paused') {
    return notConnected(t('device.blockedReasonPaused'));
  }
  if (!self.online || !other.online) {
    return notConnected(t('device.notConnectedOffline'));
  }

  const pairLinks = linksBetween(links, self.nodeId, other.nodeId);
  // 任一方向自报 blocked（节点本机 TOFU 阻断，双方在网关侧仍是正常成员）就按
  // 阻断呈现——单向 blocked + 反向正常不能被「优选直连」合并掩盖。阻断路径没有
  // 测速，延迟一律未知：不用反向链路或旧 last RTT 冒充当前阻断延迟。
  if (pairLinks.some((l) => classifyLinkPath(l.path) === 'blocked')) {
    return { dot: 'danger', kindWord: t('device.blocked'), reason: t('device.reasonNodeBlocked'), latency: '—' };
  }
  const link =
    pairLinks.find((l) => classifyLinkPath(l.path) === 'lan') ??
    pairLinks.find((l) => classifyLinkPath(l.path) === 'direct') ??
    pairLinks.find((l) => classifyLinkPath(l.path) === 'relay') ??
    pairLinks.find((l) => classifyLinkPath(l.path) === 'unknown');
  if (link !== undefined) {
    if (classifyLinkPath(link.path) === 'unknown') {
      // 白名单外的自报：如实显示「未知」，不伪装成任何已知连接方式
      return { dot: 'muted', kindWord: t('path.unknown'), reason: t('device.reasonUnknownPath'), latency: '—' };
    }
    const latency = formatLatencyRange([link.rttMs]);
    switch (classifyLinkPath(link.path)) {
      case 'lan':
        return { dot: 'ok', kindWord: t('path.lan'), reason: t('device.reasonLan'), latency };
      case 'direct':
        return { dot: 'ok', kindWord: t('path.direct'), reason: t('device.reasonDirect'), latency };
      case 'relay': {
        const rate = formatRate(link.liveRelayKbps);
        const reason =
          self.natType === 'symmetric'
            ? t('device.reasonRelaySelf', { rate })
            : other.natType === 'symmetric'
              ? t('device.reasonRelayPeer', { rate })
              : t('device.reasonRelay', { rate });
        return { dot: 'warn', kindWord: t('path.relay'), reason, latency };
      }
      case 'blocked':
      case 'unknown':
        // blocked 已在上面统一返回，这两个分支只为穷尽联合类型的兜底（不可达）
        return { dot: 'muted', kindWord: t('path.unknown'), reason: t('device.reasonUnknownPath'), latency: '—' };
    }
  }
  return notConnected(t('device.notConnectedIdle'));
}
