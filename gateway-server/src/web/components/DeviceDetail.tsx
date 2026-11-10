// 设备详情（PG-6b）：原位替换设备列表。顶部「‹ 全部设备」返回（Esc 同效，
// 弹窗打开时让位给弹窗），标题行带暂停/恢复、移除（行内二次确认）与
// mismatch 专属的红色说明条 + 信任新身份；四个技术元数据字段 + 「到其他
// 设备的连接」表——每一行都是一条固定的平实原因文案，点击整行切换到那台
// 设备的详情。数据全部来自拓扑快照（SSE 实时推送，不另发请求）。
import { useEffect } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { TranslateFn } from '../i18n/locales';
import { classifyLinkPath, displayName, formatBytes, formatLatencyRange, formatRate, memberStatusView } from '../format';
import type { LinkKind, StatusDot } from '../format';
import type {
  MemberAction,
  NatType,
  TopologyLink,
  TopologyMemberRow,
  TopologySnapshot,
  UiLocalState,
} from '../store/console-store';

export interface DeviceDetailProps {
  t: TranslateFn;
  topology: TopologySnapshot;
  member: TopologyMemberRow;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  busy: boolean;
  onBack: () => void;
  /** 点击「到其他设备的连接」的某一行 → 切换到那台设备 */
  onSelectDevice: (nodeId: string) => void;
  onMemberAction: (nodeId: string, action: MemberAction) => void;
  onRemoveMember: (nodeId: string) => void;
}

/** 连接方式行：圆点档位 + 状态词 + 固定平实原因 + 等宽延迟 */
interface ConnRow {
  other: TopologyMemberRow;
  dot: StatusDot;
  kindWord: string;
  reason: string;
  latency: string;
}

function natWord(natType: NatType, t: TranslateFn): string {
  switch (natType) {
    case 'cone':
      return t('nat.cone');
    case 'symmetric':
      return t('nat.symmetric');
    case 'public':
      return t('nat.public');
    case 'unknown':
      return t('nat.unknown');
  }
}

/** 两设备间的路径观测：优先本机自报，缺了看对方上报（路径是双向对称的事实） */
function findLink(links: readonly TopologyLink[], a: string, b: string): TopologyLink | null {
  return (
    links.find((l) => l.srcNodeId === a && l.peerNodeId === b) ??
    links.find((l) => l.srcNodeId === b && l.peerNodeId === a) ??
    null
  );
}

function deriveConnRow(t: TranslateFn, self: TopologyMemberRow, other: TopologyMemberRow, links: readonly TopologyLink[]): ConnRow {
  const link = findLink(links, self.nodeId, other.nodeId);
  const latency = link !== null ? formatLatencyRange([link.rttMs]) : '—';
  const kindFor = (kind: LinkKind): { dot: StatusDot; kindWord: string; reason: string } => {
    switch (kind) {
      case 'lan':
        return { dot: 'ok', kindWord: t('path.lan'), reason: t('device.reasonLan') };
      case 'direct':
        return { dot: 'ok', kindWord: t('path.direct'), reason: t('device.reasonDirect') };
      case 'relay':
        return {
          dot: 'warn',
          kindWord: t('path.relay'),
          reason: t('device.reasonRelay', { rate: formatRate(link?.liveRelayKbps ?? 0) }),
        };
    }
  };

  if (other.status === 'paused') {
    return { other, dot: 'danger', kindWord: t('device.blocked'), reason: t('device.blockedReasonPaused'), latency };
  }
  if (other.status === 'revoked') {
    return { other, dot: 'danger', kindWord: t('device.blocked'), reason: t('device.blockedReasonRevoked'), latency };
  }
  if (link !== null) {
    return { other, latency, ...kindFor(classifyLinkPath(link.path)) };
  }
  if (other.status === 'pending') {
    return { other, dot: 'muted', kindWord: t('device.notConnected'), reason: t('device.notConnectedPending'), latency };
  }
  if (!other.online) {
    return { other, dot: 'muted', kindWord: t('device.notConnected'), reason: t('device.notConnectedOffline'), latency };
  }
  return { other, dot: 'muted', kindWord: t('device.notConnected'), reason: t('device.notConnectedIdle'), latency };
}

export function DeviceDetail(props: DeviceDetailProps) {
  const { t, topology, member, ui, onUi, busy, onBack, onSelectDevice, onMemberAction, onRemoveMember } = props;

  // Esc 返回全部设备；弹窗打开时让位（Modal 自带 Esc 处理，这里不抢）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || ui.dialog !== null) return;
      event.preventDefault();
      onBack();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onBack, ui.dialog]);

  const status = memberStatusView(member.status, member.online, t);
  const confirmTarget = `remove-member:${member.nodeId}`;
  const confirmingRemove = ui.confirmTarget === confirmTarget;
  const rows = topology.members.filter((m) => m.nodeId !== member.nodeId).map((other) => deriveConnRow(t, member, other, topology.links));

  const toggleConfirmRemove = (): void => {
    if (confirmingRemove) {
      onUi({ confirmTarget: null });
      onRemoveMember(member.nodeId);
    } else {
      onUi({ confirmTarget });
    }
  };

  const openByKey = (event: ReactKeyboardEvent<HTMLTableRowElement>, nodeId: string): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectDevice(nodeId);
    }
  };

  return (
    <section className="device-detail">
      <button type="button" className="back-link" onClick={onBack}>
        ‹ {t('devices.back')}
      </button>

      <div className="detail-head">
        <h2 className="detail-name">
          <span className={`dot ${status.dot}`} aria-hidden="true" />
          {displayName(member, t)}
        </h2>
        <div className="detail-actions">
          {member.status === 'mismatch' && (
            <button type="button" className="btn primary" disabled={busy} onClick={() => onMemberAction(member.nodeId, 'repin')}>
              {t('requests.trustNewIdentity')}
            </button>
          )}
          {(member.status === 'authorized' || member.status === 'paused') && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => onMemberAction(member.nodeId, member.status === 'paused' ? 'resume' : 'pause')}
            >
              {member.status === 'paused' ? t('devices.resume') : t('devices.pause')}
            </button>
          )}
          <button
            type="button"
            className={confirmingRemove ? 'btn danger solid' : 'btn danger'}
            disabled={busy}
            onClick={toggleConfirmRemove}
          >
            {confirmingRemove ? t('common.confirmRemove') : t('common.remove')}
          </button>
        </div>
      </div>

      {member.status === 'mismatch' && (
        <div className="detail-alert" role="alert">
          {t('requests.identityChangedHint')}
        </div>
      )}

      <dl className="meta-grid">
        <div className="meta-item">
          <dt>{t('devices.deviceId')}</dt>
          <dd className="mono">{member.nodeId}</dd>
        </div>
        <div className="meta-item">
          <dt>{t('devices.publicAddr')}</dt>
          <dd className="mono">{member.lastIp ?? '—'}</dd>
        </div>
        <div className="meta-item">
          <dt>{t('devices.networkType')}</dt>
          <dd>{natWord(member.natType, t)}</dd>
        </div>
        <div className="meta-item">
          <dt>{t('devices.totalRelay')}</dt>
          <dd className="mono">{formatBytes(member.cumulativeRelayBytes)}</dd>
        </div>
      </dl>

      <h3 className="section-title">{t('devices.connectionsTitle')}</h3>
      {rows.length === 0 ? (
        <p className="empty-hint">{t('devices.emptyHint')}</p>
      ) : (
        <table className="device-table conn-table">
          <thead>
            <tr>
              <th scope="col">{t('network.devices')}</th>
              <th scope="col">{t('devices.path')}</th>
              <th scope="col">{t('devices.reason')}</th>
              <th scope="col" className="mono-col">
                {t('devices.latency')}
              </th>
              <th scope="col" aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.other.nodeId}
                className="device-row"
                tabIndex={0}
                role="button"
                aria-label={`${displayName(row.other, t)} — ${row.kindWord}`}
                onClick={() => onSelectDevice(row.other.nodeId)}
                onKeyDown={(event) => openByKey(event, row.other.nodeId)}
              >
                <td>
                  <div className="device-name">{displayName(row.other, t)}</div>
                  {row.other.note !== null && <div className="device-note">{row.other.note}</div>}
                </td>
                <td>
                  <div className="conn-kind">
                    <span className={`dot ${row.dot}`} aria-hidden="true" />
                    {row.kindWord}
                  </div>
                </td>
                <td className="conn-reason">{row.reason}</td>
                <td className="mono">{row.latency}</td>
                <td className="row-arrow" aria-hidden="true">
                  ›
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
