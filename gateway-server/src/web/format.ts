// 控制台纯格式化函数（PG-6b）：速率、字节、延迟区间、相对时间、连接路径
// 分类与成员状态展示。零 DOM 依赖：后端 tsc 编译进 dist/web/（测试可 import），
// 浏览器半边经 tsconfig.web.json 类型检查——两边共享同一份实现。

import type { TranslateFn } from './i18n/locales.js';
import type { MemberStatus, TopologyMemberRow } from './store/console-store.js';

/** 实时中转速率：'0 KB/s'、'12 KB/s'、'1.5 MB/s'（任务单要求等宽大字展示） */
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

/** 延迟读数：单值 '12 ms'，区间取最值 '12–30 ms'，无数据 '—' */
export function formatLatencyRange(rttMsValues: readonly number[]): string {
  if (rttMsValues.length === 0) return '—';
  const round = (v: number): number => Math.round(v * 10) / 10;
  const min = round(Math.min(...rttMsValues));
  const max = round(Math.max(...rttMsValues));
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

/** 节点自报路径 → 三类连接（lan=局域网直连 / direct=直连 / relay=经网关中转） */
export type LinkKind = 'lan' | 'direct' | 'relay';

export function classifyLinkPath(path: string): LinkKind {
  if (path === 'lan') return 'lan';
  if (path === 'p2p' || path === 'direct') return 'direct';
  return 'relay';
}

// ---------------------------------------------------------------- 成员状态展示

/** 设备展示名：无名字的设备落「未命名设备」 */
export function displayName(member: TopologyMemberRow, t: TranslateFn): string {
  return member.name ?? t('devices.unnamed');
}

export type StatusDot = 'ok' | 'warn' | 'danger' | 'muted';

/** 成员五态 + 在线位 → 圆点档位与状态词（Dot Rule：圆点只这四档） */
export function memberStatusView(status: MemberStatus, online: boolean, t: TranslateFn): { dot: StatusDot; word: string } {
  switch (status) {
    case 'authorized':
      return online ? { dot: 'ok', word: t('status.online') } : { dot: 'muted', word: t('status.offline') };
    case 'pending':
      return { dot: 'warn', word: t('status.pending') };
    case 'paused':
      return { dot: 'warn', word: t('status.paused') };
    case 'mismatch':
      return { dot: 'danger', word: t('status.mismatch') };
    case 'revoked':
      return { dot: 'muted', word: t('status.revoked') };
  }
}
