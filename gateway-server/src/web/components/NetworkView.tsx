// 网络视图（PG-6b）：概览三格（网络 / 加入申请·身份异常 / 网关中转）+ 设备
// 列表 + 「网络设置」「新建网络」两个居中模态框。
//
// 第 2 格严格遵守 One Tint Rule：身份异常（--danger-tint）优先于加入申请
// （--warn-tint），无待办不带底色；同一屏只有这一格会带色。
// 设备列表整行可点（Enter/Space 同效）进入原位详情（DeviceDetail）。
// 弹窗开关存 ui 切片——SSE 只替换 topology 切片，打开中的弹窗、行内二次
// 确认与输入中的草稿不会被实时推送冲掉。
//
// GC-9 增强：新建网络弹窗直接可配设备上限（组上限预填与阻断）与入网方式，
// 弹窗副标题展示建网额度；概览格融入当前组限额指标与本月中转流量条（≥80%
// 高水位 / 超限警示，控制连接不受影响）；网络设置弹窗展示组上限/单设备限速，
// 祖父超额存量（历史上限 > 组上限）可维持或缩容、不可上调；分项复制新增
// 第 4 项「无头命令」（界面掩码、复制完整命令，不破坏 joinKey 隐藏约定）；
// 设备列表补最后在线相对时间与实时中转速率。配额视图（quota）是可选 prop：
// App 未接线（或未拉到 /auth/me）时这些增强段整体不渲染，纯名称创建路径
// 与旧行为完全一致。
import { useEffect, useState } from 'react';

import { LOCALE_STORAGE_KEY, resolveLocale } from '../i18n/locales';
import type { Locale, LocaleKey, TranslateFn } from '../i18n/locales';
import {
  buildHeadlessJoinCommand,
  classifyLinkPath,
  computeUsagePercent,
  displayName,
  filterJoinedMembers,
  formatBytesQuota,
  formatLatencyRange,
  formatRate,
  isQuotaExceeded,
  maskInviteUri,
  memberStatusView,
  quotaUsageLevel,
  relativeText,
  relativeTime,
} from '../format';
import type { UsageLevel } from '../format';
import { Modal } from './Modal';
import { ChevronIcon, LockIcon, SettingsIcon } from './Icons';
import { DeviceDetail } from './DeviceDetail';
import type {
  AdmissionMode,
  MemberAction,
  NetworkView as NetworkSummary,
  TopologyLink,
  TopologySnapshot,
  UiLocalState,
  UserQuotaSummary,
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
  /** 分项复制（网关地址 / 网络 ID / 入网口令 / 无头命令） */
  onCopyField?: (value: string, toastKey: LocaleKey) => void;
  /** 当前登录用户的有效配额视图（GC-9 组限额指标与月度流量条）；缺省不渲染增强段 */
  quota?: UserQuotaSummary | null;
  onPatchNetwork: (patch: NetworkPatchInput) => void;
  onDeleteNetwork: () => void;
  onRotateInviteKey: () => void;
  onMemberAction: (nodeId: string, action: MemberAction) => void;
  onRenameMember?: (nodeId: string, name: string) => void;
  onEditNote?: (nodeId: string, note: string) => void;
  onRemoveMember: (nodeId: string) => void;
}

// ---------------------------------------------------------------- 配额小件（GC-9）

/** GC-7b 契约：管理员不受组上限约束（maxNetworks 为 null），单网设备上限可满 64 台 */
function isQuotaUnlimited(quota: UserQuotaSummary | null): boolean {
  return quota !== null && quota.maxNetworks === null;
}

/**
 * 祖父超额存量提示（GC-9）：网络当前上限高于所在用户组上限时展示。locales.ts
 * 在本任务修改白名单之外，词条暂以双语字面量放在组件内——读取当前界面语言
 * 沿用 Modal.resolveCloseLabel 的同一 resolveLocale 先例，后续任务再上移词典。
 */
function grandfatheredPeerCapHint(locale: Locale): string {
  return locale === 'zh'
    ? '当前上限来自历史配置，可继续维持或向下缩容，无法上调超过组上限'
    : 'This limit comes from an earlier configuration — keep it or shrink it, but it cannot be raised past the group cap';
}

function readUiLocale(): Locale {
  try {
    return resolveLocale(localStorage.getItem(LOCALE_STORAGE_KEY), navigator.language);
  } catch {
    return 'zh';
  }
}

/**
 * 配额进度条的 4px 轨道（DESIGN.md Quota Meter；AccountSettingsModal 同款——
 * 白名单内不能改 global.css，内联样式走 CSP 已允许的 style 属性）。
 */
function UsageMeter(props: { percent: number; level: UsageLevel; label: string }) {
  const fill = props.level === 'danger' ? 'var(--danger)' : props.level === 'warn' ? 'var(--warn)' : 'var(--accent)';
  return (
    <div role="img" aria-label={props.label} style={{ height: 4, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${props.percent}%`, borderRadius: 999, background: fill }} />
    </div>
  );
}

/** 无头命令的展示掩码：与 maskInviteUri 同界——# 后的入网口令整体换圆点；复制按钮才给完整命令 */
function maskHeadlessCommand(command: string): string {
  const hashIndex = command.indexOf('#');
  if (hashIndex === -1) return command;
  return `${command.slice(0, hashIndex)}#••••••••"`;
}

// ---------------------------------------------------------------- 网络设置模态框

interface SettingsModalProps {
  t: TranslateFn;
  network: NetworkSummary;
  busy: boolean;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  /** 组上限 / 单设备限速展示与 maxPeers 校验边界（GC-9）；缺省维持旧 2..64 行为 */
  quota: UserQuotaSummary | null;
  onClose: () => void;
  onPatch: (patch: NetworkPatchInput) => void;
  onDelete: () => void;
  onRotate: () => void;
}

function NetworkSettingsModal({ t, network, busy, ui, onUi, quota, onClose, onPatch, onDelete, onRotate }: SettingsModalProps) {
  const [name, setName] = useState(network.name);
  const [maxPeersDraft, setMaxPeersDraft] = useState(String(network.maxPeers));
  // 危险按钮的两击确认统一走 ui.confirmTarget：同一时刻只有一个处于确认态，
  // 且点弹窗外任何位置都会被 App 的 document 级监听取消
  const confirmingRotate = ui.confirmTarget === 'rotate-key';
  const confirmingDelete = ui.confirmTarget === 'delete-network';

  // 组边界（GC-9）：普通用户封顶所在组上限；管理员（组上限不限）可到 64。
  // 祖父超额存量 = 当前上限高于组上限：可保持或缩容（对齐后端 PATCH 的
  // grandfatheredShrink 语义），不得上调超过组上限。
  const unlimitedPeers = isQuotaUnlimited(quota);
  const groupPeerCap = unlimitedPeers || quota === null ? 64 : quota.maxPeersPerNetwork;
  const grandfathered = quota !== null && !unlimitedPeers && network.maxPeers > groupPeerCap;

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
    const withinGroupCap = value <= groupPeerCap;
    const grandfatheredShrink = grandfathered && value <= network.maxPeers;
    if (Number.isInteger(value) && value >= 2 && value <= 64 && value !== network.maxPeers && (withinGroupCap || grandfatheredShrink)) {
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
            max={Math.min(64, Math.max(groupPeerCap, network.maxPeers))}
            step={1}
            value={maxPeersDraft}
            onChange={(e) => setMaxPeersDraft(e.target.value)}
            onBlur={commitMaxPeers}
            onKeyDown={(e) => submitOnEnter(e, commitMaxPeers)}
          />
          {quota !== null && (
            <p className="field-hint">
              {!unlimitedPeers && `${t('network.groupPeerCap', { n: quota.maxPeersPerNetwork })} · `}
              {t('network.groupRateCap', { rate: formatRate(quota.relayRateKbps) })}
            </p>
          )}
          {grandfathered && <p className="field-hint">{grandfatheredPeerCapHint(readUiLocale())}</p>}
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

/** 创建请求的扩展细节（GC-9）：旧调用面只取 name，两项按后端默认落库 */
export interface NewNetworkInput {
  maxPeers: number;
  admissionMode: AdmissionMode;
}

export interface NewNetworkModalProps {
  t: TranslateFn;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  busy: boolean;
  /**
   * 创建网络。扩展形态（GC-9）第二参携带设备上限与入网方式；旧调用面
   * `(name) => void` 依然兼容（TypeScript 参数双变），未接线时上限与方式
   * 按后端默认落库（普通用户即所在组上限，管理员取系统默认上限）。
   */
  onCreate: (name: string, details?: NewNetworkInput) => void;
  /** 登录态有效配额视图：组上限预填、建网额度与超限阻断都依赖它；缺省退回纯名称创建 */
  quota?: UserQuotaSummary | null;
}

export function NewNetworkModal({ t, ui, onUi, busy, onCreate, quota }: NewNetworkModalProps) {
  const quotaView = quota ?? null;
  const unlimited = isQuotaUnlimited(quotaView);
  // 设备上限边界（GC-9）：普通用户封顶所在组上限并默认预填组上限，管理员可满 64 台
  const peerCeiling = unlimited || quotaView === null ? 64 : quotaView.maxPeersPerNetwork;
  const networkLimit = quotaView === null || unlimited ? null : quotaView.maxNetworks;
  const quotaReached = quotaView !== null && networkLimit !== null && quotaView.usedNetworks >= networkLimit;

  // 上限与方式的草稿放组件内 useState：弹窗打开期间 SSE 只替换 topology 切片、
  // 组件不卸载，输入不会被实时推送冲掉；每次打开重新挂载、按当次配额预填。
  const [maxPeersDraft, setMaxPeersDraft] = useState(() => String(peerCeiling >= 64 ? 8 : peerCeiling));
  const [admissionMode, setAdmissionMode] = useState<AdmissionMode>('both');

  const name = ui.draftNetworkName.trim();
  const maxPeers = Number(maxPeersDraft);
  const maxPeersValid = Number.isInteger(maxPeers) && maxPeers >= 2 && maxPeers <= peerCeiling;
  const valid = name.length >= 1 && name.length <= 32 && maxPeersValid && !quotaReached;
  const close = (): void => onUi({ dialog: null });

  // 弹窗上方的建网额度（GC-9）：管理员上限标不限；组名随额度一起展示
  const quotaSubtitle =
    quotaView === null
      ? undefined
      : `${t('account.networkQuotaSummary', {
          used: quotaView.usedNetworks,
          limit: networkLimit === null ? t('common.unlimited') : networkLimit,
        })} · ${quotaView.groupName}`;

  return (
    <Modal title={t('network.newNetworkTitle')} subtitle={quotaSubtitle} onClose={close}>
      <form
        className="modal-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy) onCreate(ui.draftNetworkName, { maxPeers, admissionMode });
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
        <div className="field">
          <label className="field-label" htmlFor="new-network-max-peers">
            {t('network.deviceLimit')}
          </label>
          <input
            id="new-network-max-peers"
            className="input input-narrow mono"
            type="number"
            min={2}
            max={peerCeiling}
            step={1}
            value={maxPeersDraft}
            onChange={(e) => setMaxPeersDraft(e.target.value)}
          />
          <p className="field-hint">{t('network.groupPeerCap', { n: peerCeiling })}</p>
          {!maxPeersValid && <p className="form-error">{t('error.peerLimitByGroup')}</p>}
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
                name="new-network-admission"
                checked={admissionMode === mode}
                onChange={() => setAdmissionMode(mode)}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {quotaReached && (
          <>
            <p className="form-error">{t('account.quotaReached')}</p>
            <p className="field-hint">
              {t('network.groupNetworkCap', { n: networkLimit ?? 0 })}
              {quotaView.isExpiredFallback ? ` · ${t('account.groupExpired')}` : ''}
            </p>
          </>
        )}
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
    quota,
    onPatchNetwork,
    onDeleteNetwork,
    onRotateInviteKey,
    onMemberAction,
    onRenameMember,
    onEditNote,
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

  // 组限额派生（GC-9）：quota 缺省（App 未接线）时全部增强段不渲染
  const quotaView = quota ?? null;
  const unlimitedPeers = isQuotaUnlimited(quotaView);
  const monthlyPercent = quotaView !== null ? computeUsagePercent(quotaView.usedMonthlyRelayBytes, quotaView.monthlyRelayQuotaBytes) : null;
  const monthlyLevel = quotaView !== null ? quotaUsageLevel(quotaView.usedMonthlyRelayBytes, quotaView.monthlyRelayQuotaBytes) : 'ok';
  const monthlyExceeded = quotaView !== null ? isQuotaExceeded(quotaView.usedMonthlyRelayBytes, quotaView.monthlyRelayQuotaBytes) : false;
  const headlessCommand = buildHeadlessJoinCommand(network.joinUri);

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
        onEditNote={onEditNote}
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
              <SettingsIcon size={14} /> {t('network.settings')}
            </button>
          </div>
          <p className={`device-count mono${seatsFull ? ' full' : ''}`}>
            {t('network.deviceCount', { count: joinedCount, max: maxPeers })}
            {seatsFull && <span className="count-full"> {t('network.capacityFull')}</span>}
          </p>
          {quotaView !== null && (
            <p className="invite-hint">
              {!unlimitedPeers && `${t('network.groupPeerCap', { n: quotaView.maxPeersPerNetwork })} · `}
              {t('network.groupRateCap', { rate: formatRate(quotaView.relayRateKbps) })}
            </p>
          )}
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
              {/* 第 4 项（GC-9）：无头接入 CLI 命令。界面只展示掩码（# 后口令
                  换圆点，与 maskInviteUri 同界），复制按钮交完整命令给 App 的
                  分项复制回调——不以明文破坏 joinKey 隐藏约定。 */}
              <div className="invite-part-row">
                <span className="invite-part-label">{t('network.partHeadlessCommand')}</span>
                <code className="invite-part-value mono">{maskHeadlessCommand(headlessCommand)}</code>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => onCopyField?.(headlessCommand, 'toast.headlessCommandCopied')}
                >
                  {t('common.copy')}
                </button>
                <span className="invite-part-note">{t('network.headlessCommandHint')}</span>
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
          {/* 月度流量条（GC-9）：组设了月度上限才出进度条；管理员标不限 */}
          {quotaView !== null && (
            <div style={{ marginTop: 10 }}>
              <div className="field-label" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>{t('overview.monthlyTraffic')}</span>
                <span className="mono">
                  {quotaView.monthlyRelayQuotaBytes === null
                    ? t('common.unlimited')
                    : t('common.usedOfLimit', {
                        // formatBytesQuota 的返回值刻意语言无关（GC-7b），
                        // locale 实参只是调用面契约
                        used: formatBytesQuota(quotaView.usedMonthlyRelayBytes, 'zh'),
                        limit: formatBytesQuota(quotaView.monthlyRelayQuotaBytes, 'zh'),
                      })}
                </span>
              </div>
              {monthlyPercent !== null && (
                <div style={{ marginTop: 6 }}>
                  <UsageMeter
                    percent={monthlyPercent}
                    level={monthlyLevel}
                    label={t('common.usedOfLimit', {
                      used: formatBytesQuota(quotaView.usedMonthlyRelayBytes, 'zh'),
                      limit: formatBytesQuota(quotaView.monthlyRelayQuotaBytes, 'zh'),
                    })}
                  />
                </div>
              )}
              {monthlyExceeded ? (
                <>
                  <p className="invite-hint" style={{ margin: '6px 0 0' }}>
                    {t('overview.monthlyTrafficExceeded')}
                  </p>
                  <p className="invite-hint" style={{ margin: '2px 0 0' }}>
                    {t('admin.quotaThrottleNote')}
                  </p>
                </>
              ) : monthlyLevel === 'warn' && monthlyPercent !== null ? (
                <p className="invite-hint" style={{ margin: '6px 0 0' }}>
                  {t('overview.monthlyTrafficNearLimit', { percent: monthlyPercent })}
                </p>
              ) : null}
            </div>
          )}
          <p className="e2ee-note">
            <LockIcon size={14} /> {t('overview.e2eeNote')}
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
                // 正在经网关中转的设备高亮实时速率（GC-9，作为发送方的自报值）
                const relayingNow = member.online && member.liveRelayKbps > 0;
                // 离线设备补最后在线相对时间（GC-9）
                const lastSeenText = member.online ? null : relativeText(t, relativeTime(member.lastSeenAt, Date.now()));
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
                      {lastSeenText !== null && (
                        <div style={{ marginTop: 2, fontSize: 12, color: 'var(--ink-3)' }}>
                          {t('devices.lastSeen', { time: lastSeenText })}
                        </div>
                      )}
                    </td>
                    <td className="conn-summary">
                      {showConn ? (
                        <>
                          {relayingNow && (
                            <span className="conn-chip">
                              <span className="dot warn" aria-hidden="true" />
                              {t('devices.relayingNow', { rate: formatRate(member.liveRelayKbps) })}
                            </span>
                          )}
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
                      <ChevronIcon direction="right" size={14} />
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
          quota={quotaView}
          onClose={() => onUi({ dialog: null, confirmTarget: null })}
          onPatch={onPatchNetwork}
          onDelete={onDeleteNetwork}
          onRotate={onRotateInviteKey}
        />
      )}
    </section>
  );
}
