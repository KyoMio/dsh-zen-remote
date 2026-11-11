// 网关管理页（PG-6b，仅管理员）：页头运行状态 + 注册与配额模态框 + 用户表。
// 配额四项「修改即保存」：开关与滑杆即时 PATCH，数字输入失焦/回车提交
// （非法值回滚显示服务端真值）；管理员自己不显示停用按钮。
import { useState } from 'react';

import type { TranslateFn } from '../i18n/locales';
import { formatRate } from '../format';
import { Modal } from './Modal';
import type { AdminUserRow, SystemSettings, UiLocalState } from '../store/console-store';

export interface AdminViewProps {
  t: TranslateFn;
  users: AdminUserRow[];
  /** 系统设置；管理员数据未拉到前是 null */
  settings: SystemSettings | null;
  currentUserId: string;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  onPatchSettings: (patch: Partial<SystemSettings>) => void;
  onSetUserActive: (userId: string, active: boolean) => void;
}

// ---------------------------------------------------------------- 注册与配额模态框

interface QuotaModalProps {
  t: TranslateFn;
  settings: SystemSettings;
  onClose: () => void;
  onPatch: (patch: Partial<SystemSettings>) => void;
}

function QuotaModal({ t, settings, onClose, onPatch }: QuotaModalProps) {
  const [maxNetworksDraft, setMaxNetworksDraft] = useState(String(settings.maxNetworksPerUser));
  const [defaultMaxPeersDraft, setDefaultMaxPeersDraft] = useState(String(settings.defaultMaxPeers));
  const [rateKbps, setRateKbps] = useState(settings.relayRateKbps);

  const submitOnEnter = (event: { key: string; preventDefault: () => void }, commit: () => void): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit();
  };

  const commitMaxNetworks = (): void => {
    const value = Number(maxNetworksDraft);
    if (Number.isInteger(value) && value >= 1 && value <= 50 && value !== settings.maxNetworksPerUser) {
      onPatch({ maxNetworksPerUser: value });
    } else {
      setMaxNetworksDraft(String(settings.maxNetworksPerUser));
    }
  };

  const commitDefaultMaxPeers = (): void => {
    const value = Number(defaultMaxPeersDraft);
    if (Number.isInteger(value) && value >= 2 && value <= 64 && value !== settings.defaultMaxPeers) {
      onPatch({ defaultMaxPeers: value });
    } else {
      setDefaultMaxPeersDraft(String(settings.defaultMaxPeers));
    }
  };

  const commitRate = (): void => {
    const value = Math.round(Number(rateKbps));
    if (Number.isFinite(value) && value >= 512 && value <= 16384 && value !== settings.relayRateKbps) {
      onPatch({ relayRateKbps: value });
    } else {
      setRateKbps(settings.relayRateKbps);
    }
  };

  return (
    <Modal title={t('admin.registrationQuota')} onClose={onClose}>
      <div className="modal-body">
        <div className="setting-row">
          <span id="quota-signup-label">{t('admin.allowSignup')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={settings.allowSignup}
            aria-labelledby="quota-signup-label"
            className={settings.allowSignup ? 'switch on' : 'switch'}
            onClick={() => onPatch({ allowSignup: !settings.allowSignup })}
          >
            <span className="switch-knob" aria-hidden="true" />
          </button>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="quota-max-networks">
            {t('admin.maxNetworks')}
          </label>
          <input
            id="quota-max-networks"
            className="input input-narrow mono"
            type="number"
            min={1}
            max={50}
            step={1}
            value={maxNetworksDraft}
            onChange={(e) => setMaxNetworksDraft(e.target.value)}
            onBlur={commitMaxNetworks}
            onKeyDown={(e) => submitOnEnter(e, commitMaxNetworks)}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="quota-default-max-peers">
            {t('admin.defaultMaxPeers')}
          </label>
          <input
            id="quota-default-max-peers"
            className="input input-narrow mono"
            type="number"
            min={2}
            max={64}
            step={1}
            value={defaultMaxPeersDraft}
            onChange={(e) => setDefaultMaxPeersDraft(e.target.value)}
            onBlur={commitDefaultMaxPeers}
            onKeyDown={(e) => submitOnEnter(e, commitDefaultMaxPeers)}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="quota-relay-rate">
            {t('admin.perDeviceRelayLimit')}
          </label>
          <div className="range-row">
            <input
              id="quota-relay-rate"
              className="range"
              type="range"
              min={512}
              max={16384}
              step={64}
              value={rateKbps}
              onChange={(e) => setRateKbps(Number(e.target.value))}
              onPointerUp={commitRate}
              onKeyUp={commitRate}
              onBlur={commitRate}
            />
            <output className="range-value mono" htmlFor="quota-relay-rate">
              {rateKbps} KB/s
            </output>
          </div>
          <p className="field-hint">{t('admin.relayDirectHint')}</p>
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

// ---------------------------------------------------------------- 主视图

export function AdminView(props: AdminViewProps) {
  const { t, users, settings, currentUserId, ui, onUi, onPatchSettings, onSetUserActive } = props;

  // 页头汇总只统计启用中的账号（停用账号的设备已断开、不再中转）
  const activeUsers = users.filter((user) => user.active);
  const totalOnline = activeUsers.reduce((sum, user) => sum + user.onlineDevices, 0);
  const totalRelayKbps = activeUsers.reduce((sum, user) => sum + user.relayKbps, 0);
  const quotaOpen = ui.dialog === 'admin-quota';

  return (
    <section className="admin-view">
      <div className="admin-head">
        <div>
          <h2 className="page-title">{t('view.admin')}</h2>
          <p className="admin-status">
            <span className="dot ok" aria-hidden="true" />
            {t('admin.statusOk')} · {t('admin.onlineCount', { n: totalOnline })} ·{' '}
            {t('admin.currentRelay', { rate: formatRate(totalRelayKbps) })}
          </p>
        </div>
        <button type="button" className="btn ghost" onClick={() => onUi({ dialog: 'admin-quota' })}>
          <span aria-hidden="true">⚙</span> {t('admin.registrationQuota')}
        </button>
      </div>

      <table className="device-table admin-table">
        <thead>
          <tr>
            <th scope="col">{t('admin.columnUser')}</th>
            <th scope="col">{t('admin.columnRole')}</th>
            <th scope="col">{t('admin.columnNetworks')}</th>
            <th scope="col" className="mono-col">
              {t('admin.columnOnline')}
            </th>
            <th scope="col" className="mono-col">
              {t('admin.columnRelay')}
            </th>
            <th scope="col">{t('admin.columnActions')}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => {
            // 停用是不可逆感较强的操作（立即清会话、断在线设备），与其他危险
            // 按钮共用 ui.confirmTarget 的两击行内确认纪律；启用保持单击
            const disableTarget = `disable-user:${user.id}`;
            const confirmingDisable = ui.confirmTarget === disableTarget;
            return (
              <tr key={user.id} className={user.active ? undefined : 'user-disabled'}>
                <td className="admin-cell-user">
                  <div className="user-email mono">{user.email}</div>
                  {!user.active && <div className="device-note">{t('admin.disabledTag')}</div>}
                </td>
                <td className="admin-cell-role">{user.role === 'admin' ? t('account.role.admin') : t('account.role.user')}</td>
                <td className="admin-cell-networks mono">
                  {user.role === 'admin' ? (
                    <>
                      {user.networkCount} / ∞
                    </>
                  ) : (
                    <>
                      {user.networkCount} / {settings !== null ? settings.maxNetworksPerUser : '—'}
                    </>
                  )}
                </td>
                <td className="admin-cell-online mono">{user.onlineDevices}</td>
                <td className="admin-cell-relay mono">{formatRate(user.relayKbps)}</td>
                <td className="admin-cell-actions">
                  {user.id !== currentUserId &&
                    (user.active ? (
                      <button
                        type="button"
                        data-confirm-trigger
                        className={confirmingDisable ? 'btn danger solid' : 'btn danger'}
                        onClick={() => {
                          if (confirmingDisable) {
                            onUi({ confirmTarget: null });
                            onSetUserActive(user.id, false);
                          } else {
                            onUi({ confirmTarget: disableTarget });
                          }
                        }}
                      >
                        {confirmingDisable ? t('admin.confirmDisable') : t('admin.disable')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          onUi({ confirmTarget: null });
                          onSetUserActive(user.id, true);
                        }}
                      >
                        {t('admin.enable')}
                      </button>
                    ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {quotaOpen && settings !== null && (
        <QuotaModal t={t} settings={settings} onClose={() => onUi({ dialog: null })} onPatch={onPatchSettings} />
      )}
      {quotaOpen && settings === null && (
        <Modal title={t('admin.registrationQuota')} onClose={() => onUi({ dialog: null })}>
          <p className="empty-hint">{t('app.loading')}</p>
        </Modal>
      )}
    </section>
  );
}
