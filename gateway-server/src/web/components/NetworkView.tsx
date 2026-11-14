// 网络视图（PG-6b）：概览三格（网络 / 加入申请·身份异常 / 网关中转）+ 设备
// 列表 + 「网络设置」「新建网络」两个居中模态框。
//
// 第 2 格严格遵守 One Tint Rule：身份异常（--danger-tint）优先于加入申请
// （--warn-tint），无待办不带底色；同一屏只有这一格会带色。
// 设备列表整行可点（Enter/Space 同效）进入原位详情（DeviceDetail）。
// 弹窗开关存 ui 切片——SSE 只替换 topology 切片，打开中的弹窗、行内二次
// 确认与输入中的草稿不会被实时推送冲掉。
import { useEffect, useState } from 'react';

import type { LocaleKey, TranslateFn } from '../i18n/locales';
import { classifyLinkPath, displayName, filterJoinedMembers, formatLatencyRange, formatRate, maskInviteUri, memberStatusView, relativeText, relativeTime } from '../format';
import { Modal } from './Modal';
import { DeviceDetail } from './DeviceDetail';
import type {
  AdmissionMode,
  MemberAction,
  NetworkView as NetworkSummary,
  TopologyLink,
  TopologySnapshot,
  UiLocalState,
} from '../store/console-store';

export interface NetworkPatchInput {
  name?: string;
  admissionMode?: AdmissionMode;
  maxPeers?: number;
}

export interface NetworkViewProps {
  t: TranslateFn;
  /** 当前选中的网络（store.networks 里的那一条） */
  network: NetworkSummary;
  /** store.topology[network.id]，SSE 未首推前是 null */
  topology: TopologySnapshot | null;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  /** 成员/网络动作在途（按钮统一禁用防双击） */
  busy: boolean;
  /** 复制完整邀请链接（App 负责剪贴板与 Toast） */
  onCopyInvite: () => void;
  /** 分项复制（网关地址 / 网络 ID / 入网口令） */
  onCopyField?: (value: string, toastKey: LocaleKey) => void;
  onPatchNetwork: (patch: NetworkPatchInput) => void;
  onDeleteNetwork: () => void;
  onRotateInviteKey: () => void;
  onMemberAction: (nodeId: string, action: MemberAction) => void;
  onRenameMember?: (nodeId: string, name: string) => void;
  onRemoveMember: (nodeId: string) => void;
}

// ---------------------------------------------------------------- 网络设置模态框

interface SettingsModalProps {
  t: TranslateFn;
  network: NetworkSummary;
  busy: boolean;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  onClose: () => void;
  onPatch: (patch: NetworkPatchInput) => void;
  onDelete: () => void;
  onRotate: () => void;
}

function NetworkSettingsModal({ t, network, busy, ui, onUi, onClose, onPatch, onDelete, onRotate }: SettingsModalProps) {
  const [name, setName] = useState(network.name);
  const [maxPeersDraft, setMaxPeersDraft] = useState(String(network.maxPeers));
  // 危险按钮的两击确认统一走 ui.confirmTarget：同一时刻只有一个处于确认态，
  // 且点弹窗外任何位置都会被 App 的 document 级监听取消
  const confirmingRotate = ui.confirmTarget === 'rotate-key';
  const confirmingDelete = ui.confirmTarget === 'delete-network';

  // 名称与上限：失焦或回车提交；非法值回滚显示服务端真值
  const commitName = (): void => {
    const trimmed = name.trim();
    if (trimmed.length >= 1 && trimmed.length <= 32 && trimmed !== network.name) {
      onPatch({ name: trimmed });
    } else {
      setName(network.name);
    }
  };
  const commitMaxPeers = (): void => {
    const value = Number(maxPeersDraft);
    if (Number.isInteger(value) && value >= 2 && value <= 64 && value !== network.maxPeers) {
      onPatch({ maxPeers: value });
    } else {
      setMaxPeersDraft(String(network.maxPeers));
    }
  };
  const submitOnEnter = (event: { key: string; preventDefault: () => void }, commit: () => void): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit();
  };

  return (
    <Modal title={t('network.settingsTitle')} onClose={onClose}>
      <div className="modal-body">
        <div className="field">
          <label className="field-label" htmlFor="network-settings-name">
            {t('network.name')}
          </label>
          <input
            id="network-settings-name"
            className="input"
            type="text"
            maxLength={32}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => submitOnEnter(e, commitName)}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="network-settings-max-peers">
            {t('network.deviceLimit')}
          </label>
          <input
            id="network-settings-max-peers"
            className="input input-narrow mono"
            type="number"
            min={2}
            max={64}
            step={1}
            value={maxPeersDraft}
            onChange={(e) => setMaxPeersDraft(e.target.value)}
            onBlur={commitMaxPeers}
            onKeyDown={(e) => submitOnEnter(e, commitMaxPeers)}
          />
        </div>

        <fieldset className="field radio-group">
          <legend className="field-label">{t('network.admissionMode')}</legend>
          {(
            [
              ['both', t('network.admissionBoth')],
              ['key', t('network.admissionKey')],
              ['manual', t('network.admissionManual')],
            ] as const
          ).map(([mode, label]) => (
            <label key={mode} className="radio-row">
              <input
                type="radio"
                name="admission-mode"
                checked={network.admissionMode === mode}
                onChange={() => {
                  if (network.admissionMode !== mode) onPatch({ admissionMode: mode });
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>

        <div className="danger-zone">
          <p className="danger-title">{t('network.dangerZone')}</p>
          <div className="danger-row">
            <div>
              <span>{t('network.rotateInviteLink')}</span>
              <p className="danger-hint">{t('network.rotateHint')}</p>
            </div>
            <button
              type="button"
              data-confirm-trigger
              className={confirmingRotate ? 'btn danger solid' : 'btn danger'}
              disabled={busy}
              onClick={() => {
                if (confirmingRotate) {
                  onUi({ confirmTarget: null });
                  onRotate();
                } else {
                  onUi({ confirmTarget: 'rotate-key' });
                }
              }}
            >
              {confirmingRotate ? t('common.confirmReset') : t('common.reset')}
            </button>
          </div>
          <div className="danger-row">
            <div>
              <span>{t('network.deleteNetwork')}</span>
              <p className="danger-hint">{t('network.deleteHint')}</p>
            </div>
            <button
              type="button"
              data-confirm-trigger
              className={confirmingDelete ? 'btn danger solid' : 'btn danger'}
              disabled={busy}
              onClick={() => {
                if (confirmingDelete) {
                  onUi({ confirmTarget: null });
                  onDelete();
                } else {
                  onUi({ confirmTarget: 'delete-network' });
                }
              }}
            >
              {confirmingDelete ? t('common.confirmDelete') : t('common.delete')}
            </button>
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            {t('common.done')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- 新建网络模态框（App 也复用）

export interface NewNetworkModalProps {
  t: TranslateFn;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  busy: boolean;
  onCreate: (name: string) => void;
}

export function NewNetworkModal({ t, ui, onUi, busy, onCreate }: NewNetworkModalProps) {
  const name = ui.draftNetworkName.trim();
  const valid = name.length >= 1 && name.length <= 32;
  const close = (): void => onUi({ dialog: null });

  return (
    <Modal title={t('network.newNetworkTitle')} onClose={close}>
      <form
        className="modal-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy) onCreate(ui.draftNetworkName);
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="new-network-name">
            {t('network.name')}
          </label>
          <input
            id="new-network-name"
            className="input"
            type="text"
            required
            maxLength={32}
            placeholder={t('network.namePlaceholder')}
            autoFocus
            value={ui.draftNetworkName}
            onChange={(e) => onUi({ draftNetworkName: e.target.value })}
          />
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!valid || busy}>
            {t('common.create')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- 主视图

export function NetworkView(props: NetworkViewProps) {
  const {
    t,
    network,
    topology,
    ui,
    onUi,
    busy,
    onCopyInvite,
    onCopyField,
    onPatchNetwork,
    onDeleteNetwork,
    onRotateInviteKey,
    onMemberAction,
    onRenameMember,
    onRemoveMember,
  } = props;
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);

  // 切换网络即退出详情：详情属于具体网络
  useEffect(() => {
    setDetailNodeId(null);
  }, [network.id]);

  const members = topology?.members ?? [];
  const links = topology?.links ?? [];
  const summary = topology?.summary ?? null;

  // 设备表只看占席位成员；pending 留在加入申请格，revoked 已移除
  const joinedMembers = filterJoinedMembers(members);
  const mismatched = members.filter((m) => m.status === 'mismatch');
  const pending = members.filter((m) => m.status === 'pending');
  // 席位计数 = 占席位数（authorized + paused + mismatch）/ 设备上限 maxPeers；
  // 拓扑未首推时回落到网络列表里的 totalDevices / maxPeers
  const joinedCount = topology !== null ? joinedMembers.length : network.totalDevices;
  const maxPeers = topology?.network.maxPeers ?? network.maxPeers;
  const seatsFull = joinedCount >= maxPeers;

  // 连接对统计（cell 3）：A→B 与 B→A 是同一条连接
  const pairs = new Map<string, { direct: boolean; blocked: boolean }>();
  for (const link of links) {
    const key = link.srcNodeId < link.peerNodeId ? `${link.srcNodeId}|${link.peerNodeId}` : `${link.peerNodeId}|${link.srcNodeId}`;
    const entry = pairs.get(key) ?? { direct: false, blocked: false };
    // 只有真实直连路径算「直连」：blocked / unknown 既不是直连也不是中转。
    // 任一方向自报 blocked 的对整体不算直连——单向 blocked + 反向正常
    // 不能被「反向能直连」合并成一条正常直连（PC16b）。
    const kind = classifyLinkPath(link.path);
    if (kind === 'lan' || kind === 'direct') entry.direct = true;
    if (kind === 'blocked') entry.blocked = true;
    pairs.set(key, entry);
  }
  const directPairs = [...pairs.values()].filter((p) => p.direct && !p.blocked).length;

  const detailMember = detailNodeId !== null ? (members.find((m) => m.nodeId === detailNodeId) ?? null) : null;
  if (detailMember !== null && topology !== null) {
    return (
      <DeviceDetail
        t={t}
        topology={topology}
        member={detailMember}
        ui={ui}
        onUi={onUi}
        busy={busy}
        onBack={() => setDetailNodeId(null)}
        onSelectDevice={setDetailNodeId}
        onMemberAction={onMemberAction}
        onRenameMember={onRenameMember}
        onRemoveMember={onRemoveMember}
      />
    );
  }

  const selfLinks = (nodeId: string): TopologyLink[] => links.filter((l) => l.srcNodeId === nodeId);

  return (
    <section className="network-view">
      <div className="overview-grid">
        {/* 第 1 格：网络 */}
        <section className="overview-cell cell-network">
          <div className="cell-head">
            <h3 className="network-name">{network.name}</h3>
            <button type="button" className="btn ghost" onClick={() => onUi({ dialog: 'network-settings' })}>
              <span aria-hidden="true">⚙</span> {t('network.settings')}
            </button>
          </div>
          <p className={`device-count mono${seatsFull ? ' full' : ''}`}>
            {t('network.deviceCount', { count: joinedCount, max: maxPeers })}
            {seatsFull && <span className="count-full"> {t('network.capacityFull')}</span>}
          </p>
          <span className="field-label">{t('network.inviteLink')}</span>
          <div className="invite-box">
            <code className="invite-key mono">{maskInviteUri(network.joinUri)}</code>
            <button type="button" className="btn primary" onClick={onCopyInvite}>
              {t('common.copy')}
            </button>
          </div>
          <p className="invite-hint">{t(network.admissionMode === 'manual' ? 'network.inviteHintManual' : 'network.inviteHint')}</p>
          <details className="invite-parts">
            <summary className="invite-parts-summary">{t('network.copyPartsSummary')}</summary>
            <div className="invite-parts-list">
              <div className="invite-part-row">
                <span className="invite-part-label">{t('network.partGatewayUrl')}</span>
                <code className="invite-part-value mono">{network.gatewayUrl || '—'}</code>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={!network.gatewayUrl}
                  onClick={() => onCopyField?.(network.gatewayUrl, 'toast.gatewayUrlCopied')}
                >
                  {t('common.copy')}
                </button>
              </div>
              <div className="invite-part-row">
                <span className="invite-part-label">{t('network.partNetworkId')}</span>
                <code className="invite-part-value mono">{network.id}</code>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => onCopyField?.(network.id, 'toast.networkIdCopied')}
                >
                  {t('common.copy')}
                </button>
              </div>
              <div className="invite-part-row">
                <span className="invite-part-label">{t('network.partJoinPassphrase')}</span>
                {network.admissionMode === 'manual' ? (
                  <span className="invite-part-note">{t('network.partPassphraseManualNote')}</span>
                ) : (
                  <>
                    <code className="invite-part-value mono">••••••••••••</code>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => onCopyField?.(network.joinKey, 'toast.joinPassphraseCopied')}
                    >
                      {t('common.copy')}
                    </button>
                  </>
                )}
              </div>
            </div>
          </details>
        </section>

        {/* 第 2 格：身份异常优先，其次加入申请；都没有则空态（无底色） */}
        {mismatched.length > 0 ? (
          <section className="overview-cell cell-requests tint-danger">
            <p className="cell-label">
              <span className="dot danger" aria-hidden="true" /> {t('overview.actionNeeded')}
            </p>
            {mismatched.map((member) => {
              const target = `remove-member:${member.nodeId}`;
              const confirming = ui.confirmTarget === target;
              return (
                <div key={member.nodeId} className="request-block">
                  <p className="request-title">{t('requests.identityChanged', { name: displayName(member, t) })}</p>
                  <p className="request-hint">{t('requests.identityChangedHint')}</p>
                  <div className="request-actions">
                    <button
                      type="button"
                      data-confirm-trigger
                      className={confirming ? 'btn danger solid' : 'btn danger'}
                      onClick={() => {
                        if (confirming) {
                          onUi({ confirmTarget: null });
                          onRemoveMember(member.nodeId);
                        } else {
                          onUi({ confirmTarget: target });
                        }
                      }}
                    >
                      {confirming ? t('common.confirmRemove') : t('common.remove')}
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy}
                      onClick={() => {
                        onUi({ confirmTarget: null });
                        onMemberAction(member.nodeId, 'repin');
                      }}
                    >
                      {t('requests.trustNewIdentity')}
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        ) : pending.length > 0 ? (
          <section className="overview-cell cell-requests tint-warn">
            <p className="cell-label">
              <span className="dot warn" aria-hidden="true" /> {t('network.joinRequests')}
              <span className="badge mono">{pending.length}</span>
            </p>
            {pending.map((member) => (
              <div key={member.nodeId} className="request-block">
                <p className="request-title">{displayName(member, t)}</p>
                <p className="request-hint">
                  {t('identity.verified')} · {relativeText(t, relativeTime(member.lastSeenAt, Date.now()))}
                </p>
                {seatsFull && <p className="request-hint warn-text">{t('requests.fullHint')}</p>}
                <div className="request-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      onUi({ confirmTarget: null });
                      onMemberAction(member.nodeId, 'reject');
                    }}
                  >
                    {t('requests.reject')}
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy || seatsFull}
                    title={seatsFull ? t('requests.fullHint') : undefined}
                    onClick={() => {
                      onUi({ confirmTarget: null });
                      onMemberAction(member.nodeId, 'approve');
                    }}
                  >
                    {t('requests.approve')}
                  </button>
                </div>
              </div>
            ))}
          </section>
        ) : (
          <section className="overview-cell cell-requests">
            <p className="cell-label">{t('network.joinRequests')}</p>
            <p className="empty-line">{t('overview.requestsEmpty')}</p>
            <p className="invite-hint">{t('overview.requestsEmptyHint')}</p>
          </section>
        )}

        {/* 第 3 格：网关中转 */}
        <section className="overview-cell cell-relay">
          <p className="cell-label">{t('overview.gatewayRelay')}</p>
          <p className="rate mono">{formatRate(summary?.totalLiveRelayKbps ?? 0)}</p>
          <p className="cell-sub">{t('overview.connections', { total: pairs.size, direct: directPairs })}</p>
          <p className="e2ee-note">
            <span aria-hidden="true">🔒</span> {t('overview.e2eeNote')}
          </p>
        </section>
      </div>

      {/* 设备列表 */}
      <div className="device-section">
        <div className="devices-head">
          <h2 className="section-title">
            {t('network.devices')} <span className="muted-count">{joinedMembers.length}</span>
          </h2>
          <p className="section-hint">{t('devices.clickHint')}</p>
        </div>
        {joinedMembers.length === 0 ? (
          <div className="empty-devices">
            <h3>{t('devices.empty')}</h3>
            <p>{t('devices.emptyBody')}</p>
          </div>
        ) : (
          <table className="device-table">
            <thead>
              <tr>
                <th scope="col">{t('network.devices')}</th>
                <th scope="col">{t('devices.status')}</th>
                <th scope="col">{t('devices.connections')}</th>
                <th scope="col" className="mono-col">
                  {t('devices.latency')}
                </th>
                <th scope="col" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {joinedMembers.map((member) => {
                const status = memberStatusView(member.status, member.online, t);
                const own = selfLinks(member.nodeId);
                const ownKinds = own.map((l) => classifyLinkPath(l.path));
                const direct = ownKinds.filter((k) => k === 'lan' || k === 'direct').length;
                const relay = ownKinds.filter((k) => k === 'relay').length;
                const blocked = ownKinds.filter((k) => k === 'blocked').length;
                const latency = formatLatencyRange(own.map((l) => l.rttMs));
                const showConn = member.status === 'authorized' && member.online && own.length > 0;
                return (
                  <tr
                    key={member.nodeId}
                    className={`device-row${member.status === 'paused' ? ' is-paused' : ''}`}
                    tabIndex={0}
                    aria-label={displayName(member, t)}
                    onClick={() => setDetailNodeId(member.nodeId)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setDetailNodeId(member.nodeId);
                      }
                    }}
                  >
                    <td className="device-cell-name">
                      <div className="device-name">{displayName(member, t)}</div>
                      {member.note !== null && <div className="device-note">{member.note}</div>}
                    </td>
                    <td className="device-cell-status">
                      <span className="dot-row">
                        <span className={`dot ${status.dot}`} aria-hidden="true" />
                        {status.word}
                      </span>
                    </td>
                    <td className="conn-summary">
                      {showConn ? (
                        <>
                          {direct > 0 && (
                            <span className="conn-chip">
                              <span className="dot ok" aria-hidden="true" />
                              {t('devices.directCount', { n: direct })}
                            </span>
                          )}
                          {relay > 0 && (
                            <span className="conn-chip">
                              <span className="dot warn" aria-hidden="true" />
                              {t('devices.relayCount', { n: relay })}
                            </span>
                          )}
                          {blocked > 0 && (
                            <span className="conn-chip">
                              <span className="dot danger" aria-hidden="true" />
                              {t('devices.blockedCount', { n: blocked })}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="device-cell-latency mono">{latency}</td>
                    <td className="row-arrow" aria-hidden="true">
                      ›
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {ui.dialog === 'network-settings' && (
        <NetworkSettingsModal
          t={t}
          network={network}
          busy={busy}
          ui={ui}
          onUi={onUi}
          onClose={() => onUi({ dialog: null, confirmTarget: null })}
          onPatch={onPatchNetwork}
          onDelete={onDeleteNetwork}
          onRotate={onRotateInviteKey}
        />
      )}
    </section>
  );
}
