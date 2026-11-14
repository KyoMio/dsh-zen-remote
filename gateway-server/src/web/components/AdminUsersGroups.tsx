// 网关管理 · 用户管理 / 用户组双模式面板（GC-10）。
//
// 用户管理：九列数据表（窄屏经 @container 680px 折成 data-label 卡片）、
//   新建用户弹窗（留空密码 = 服务端生成 16 位随机密码，仅本次弹窗明文展示）、
//   编辑用户弹窗（角色 / 启停 / 用户组 / 到期日，自我与最后管理员报错温和展示）、
//   重置临时密码弹窗（一次性展示生成密码）、行内两击确认删除。
// 用户组：卡片列表（默认组徽标 + 四维配额 + 组内人数）、新建 / 编辑弹窗
//  （限速快捷预设 + 任意 64..1048576 KB/s、月流量 MB/GB 或不限）、
//   默认组不可删、仍有成员时删除给明确提示。
//
// 全部变更走注入的 ConsoleClient（管理接口），成功后回调父级补拍对应列表；
// 行内二次确认复用 store 的 ui.confirmTarget（App 的文档级「点外取消」纪律）。
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { copyTextToClipboard } from '../clipboard';
import { computeUsagePercent, formatBytesQuota, formatQuotaExpiry, formatRate, quotaUsageLevel } from '../format';
import type { LocaleKey, TranslateFn } from '../i18n/locales';
import type { AdminUserRow, ConsoleClient, UiLocalState, UserGroup, UserRole } from '../store/console-store';
import { adminErrorToKey, readLocale } from './AdminView';
import { CheckIcon, CopyIcon, EditIcon, PlusIcon, TrashIcon, UsersIcon } from './Icons';
import { Modal } from './Modal';
import { PasswordField } from './LoginView';

export type AdminPanelMode = 'users' | 'groups';

export interface AdminUsersGroupsProps {
  t: TranslateFn;
  mode: AdminPanelMode;
  client: ConsoleClient;
  users: AdminUserRow[];
  currentUserId: string;
  groups: UserGroup[];
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  /** 用户启停：仍走 App 的实现（PATCH 后立即刷新 store 用户切片） */
  onSetUserActive: (userId: string, active: boolean) => void;
  /** 面板变更用户后立即补拍用户列表（父级写入本地覆盖层） */
  onRefreshUsers: () => Promise<void>;
  /** 组 CRUD 后立即补拍组列表 */
  onRefreshGroups: () => Promise<void>;
}

/** 单设备限速快捷预设（KB/s，口径与后端一致：KB/s = 1024 字节/秒） */
const RATE_PRESETS_KBPS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '1 MB/s', value: 1024 },
  { label: '4 MB/s', value: 4096 },
  { label: '16 MB/s', value: 16384 },
  { label: '64 MB/s', value: 65536 },
  { label: '100 MB/s', value: 102400 },
];

/** 日期输入（yyyy-mm-dd）→ ISO 时间戳：按 UTC 当日零点，与 formatQuotaExpiry 的 UTC 展示口径一致 */
function dateToIso(date: string): string {
  return new Date(`${date}T00:00:00Z`).toISOString();
}

/**
 * 4px 配额进度条（.quota-bar 正常/warn/danger 三档，档位与 AccountSettingsModal
 * 的内联 UsageMeter 同一套 format.ts 判定）：limit 为 null（不限）时不渲染。
 */
export function QuotaBar(props: { used: number; limit: number | null; label?: string }) {
  const percent = computeUsagePercent(props.used, props.limit);
  if (percent === null) return null;
  const level = quotaUsageLevel(props.used, props.limit);
  const modifier = level === 'danger' ? ' danger' : level === 'warn' ? ' warn' : '';
  return (
    <div className={`quota-bar${modifier}`} role="img" aria-label={props.label} style={{ marginTop: 4, maxWidth: 180 }}>
      <div className="quota-bar-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------- 一次性明文展示（创建用户 / 重置密码 / Admin API Key 共用）

/**
 * 高对比只读区：完整秘密仅本次渲染，附一键复制（可见已复制态 + 弹窗外 <p role="status"> 状态提示；
 * 若剪贴板被策略阻止则自动选中明文并提示手动 Ctrl+C / ⌘C）。
 * 绝不提供「再次查看」——父组件关闭弹窗后明文即从界面消失。
 */
export function OneTimeSecret(props: {
  label: string;
  hint?: string;
  value: string;
  copyLabel: string;
  copiedLabel?: string;
  copiedHint?: string;
  copyFailedHint?: string;
  doneLabel: string;
  onDone: () => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const codeRef = useRef<HTMLElement | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setCopyState('idle');
  }, [props.value]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const handleCopy = (): void => {
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    void copyTextToClipboard(props.value).then((ok) => {
      if (ok) {
        setCopyState('copied');
        resetTimerRef.current = setTimeout(() => {
          resetTimerRef.current = null;
          setCopyState('idle');
        }, 2500);
        return;
      }
      setCopyState('failed');
      try {
        const selection = window.getSelection?.();
        if (selection && codeRef.current !== null) {
          selection.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(codeRef.current);
          selection.addRange(range);
        }
      } catch {
        // 忽略受限环境下的选区操作异常
      }
    });
  };

  return (
    <div className="modal-body">
      <p className="section-title" style={{ margin: '0 0 6px' }}>
        {props.label}
      </p>
      {props.hint !== undefined && (
        <p className="field-hint" style={{ margin: '0 0 10px' }}>
          {props.hint}
        </p>
      )}
      <div className="secret-reveal">
        <code ref={codeRef} className="mono">
          {props.value}
        </code>
        <button
          type="button"
          className={copyState === 'copied' ? 'btn primary' : 'btn'}
          aria-pressed={copyState === 'copied'}
          title={props.copyLabel}
          onClick={handleCopy}
        >
          {copyState === 'copied' ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          <span>{copyState === 'copied' ? (props.copiedLabel ?? props.copyLabel) : props.copyLabel}</span>
        </button>
      </div>
      {copyState !== 'idle' && (
        <p role="status" className={copyState === 'failed' ? 'form-error' : 'secret-copy-status'}>
          {copyState === 'copied'
            ? (props.copiedHint ?? props.copiedLabel ?? '')
            : (props.copyFailedHint ?? '')}
        </p>
      )}
      <div className="modal-foot">
        <button type="button" className="btn primary" onClick={props.onDone}>
          {props.doneLabel}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 弹窗：新建用户

function CreateUserModal(props: {
  t: TranslateFn;
  client: ConsoleClient;
  groups: UserGroup[];
  onClose: () => void;
  /** 创建流程彻底结束（含一次性密码展示完毕）：关闭弹窗并补拍用户列表 */
  onDone: () => void;
}) {
  const { t, client, groups, onClose, onDone } = props;
  const defaultGroupId = groups.find((g) => g.isDefault)?.id ?? groups[0]?.id ?? '';
  const [email, setEmail] = useState('');
  // 默认随机生成（留空即服务端生成 16 位密码）；关掉开关才显示自填密码框
  const [randomPassword, setRandomPassword] = useState(true);
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [groupId, setGroupId] = useState(defaultGroupId);
  const [expiryDate, setExpiryDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<LocaleKey | null>(null);
  const [generated, setGenerated] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const created = await client.createAdminUser({
        email: email.trim(),
        // 随机生成（或自填留空）都不传 password：后端生成并仅本次响应返回
        ...(randomPassword || password.length === 0 ? {} : { password }),
        role,
        ...(groupId !== '' ? { groupId } : {}),
        ...(expiryDate !== '' ? { groupExpiresAt: dateToIso(expiryDate) } : {}),
      });
      if (created.generatedPassword !== undefined && created.generatedPassword.length > 0) {
        setGenerated(created.generatedPassword); // 弹窗原地切换为一次性密码展示
      } else {
        onDone();
      }
    } catch (err) {
      setErrorKey(adminErrorToKey(err));
    } finally {
      setBusy(false);
    }
  };

  if (generated !== null) {
    return (
      <Modal title={t('admin.newUser')} onClose={onDone}>
        <OneTimeSecret
          label={t('admin.tempPassword')}
          hint={t('admin.tempPasswordOnce')}
          value={generated}
          copyLabel={t('common.copy')}
          copiedLabel={t('common.copied')}
          copiedHint={t('common.secretCopied')}
          copyFailedHint={t('common.secretCopyFailed')}
          doneLabel={t('common.done')}
          onDone={onDone}
        />
      </Modal>
    );
  }

  return (
    <Modal title={t('admin.newUser')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <div className="modal-body">
          <div className="field">
            <label className="field-label" htmlFor="admin-user-email">
              {t('auth.email')}
            </label>
            <input
              id="admin-user-email"
              className="input"
              type="email"
              required
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              placeholder={t('auth.emailPlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="setting-row">
            <span id="admin-user-random-label">{t('admin.randomPassword')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={randomPassword}
              aria-labelledby="admin-user-random-label"
              className={randomPassword ? 'switch on' : 'switch'}
              onClick={() => setRandomPassword((v) => !v)}
            >
              <span className="switch-knob" aria-hidden="true" />
            </button>
          </div>

          {!randomPassword && (
            <PasswordField
              id="admin-user-password"
              label={t('admin.initialPassword')}
              value={password}
              minLength={8}
              autoComplete="new-password"
              onChange={setPassword}
              t={t}
            />
          )}

          <fieldset className="radio-group">
            <legend className="field-label">{t('admin.columnRole')}</legend>
            <label className="radio-row">
              <input type="radio" name="admin-user-role" checked={role === 'user'} onChange={() => setRole('user')} />
              {t('account.role.user')}
            </label>
            <label className="radio-row">
              <input type="radio" name="admin-user-role" checked={role === 'admin'} onChange={() => setRole('admin')} />
              {t('account.role.admin')}
            </label>
          </fieldset>

          {groups.length > 0 && (
            <div className="field">
              <label className="field-label" htmlFor="admin-user-group">
                {t('admin.userGroup')}
              </label>
              <select id="admin-user-group" className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                    {group.isDefault ? ` · ${t('admin.defaultGroupTag')}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="field">
            <label className="field-label" htmlFor="admin-user-expiry">
              {t('admin.expiryDate')}
            </label>
            <input
              id="admin-user-expiry"
              className="input"
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
            />
            <p className="field-hint">
              {expiryDate === ''
                ? t('accountSettings.noExpiry')
                : t('account.groupExpiryAt', {
                    date: expiryDate,
                  })}
            </p>
          </div>

          {errorKey !== null && <p className="form-error">{t(errorKey)}</p>}
          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={busy || (!randomPassword && password.length > 0 && password.length < 8)}
            >
              {t('common.create')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- 弹窗：编辑用户

function EditUserModal(props: {
  t: TranslateFn;
  client: ConsoleClient;
  groups: UserGroup[];
  user: AdminUserRow;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, client, groups, user, isSelf, onClose, onSaved } = props;
  const [role, setRole] = useState<UserRole>(user.role);
  const [active, setActive] = useState(user.active);
  const [groupId, setGroupId] = useState(user.groupId);
  const [expiryDate, setExpiryDate] = useState(user.groupExpiresAt !== null ? user.groupExpiresAt.slice(0, 10) : '');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<LocaleKey | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    // 只提交真正变化的字段：避免无变更 PATCH 触发服务端「至少一个字段」校验
    const patch: Record<string, unknown> = {};
    if (role !== user.role) patch['role'] = role;
    if (!isSelf && active !== user.active) patch['active'] = active;
    if (groups.some((g) => g.id === groupId) && groupId !== user.groupId) patch['groupId'] = groupId;
    const nextExpiry = expiryDate !== '' ? dateToIso(expiryDate) : null;
    if (nextExpiry !== user.groupExpiresAt) patch['groupExpiresAt'] = nextExpiry;
    if (Object.keys(patch).length === 0) {
      onSaved();
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      await client.updateAdminUser(user.id, patch);
      onSaved();
    } catch (err) {
      setErrorKey(adminErrorToKey(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${t('admin.editUser')} · ${user.email}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <div className="modal-body">
          <fieldset className="radio-group">
            <legend className="field-label">{t('admin.columnRole')}</legend>
            <label className="radio-row">
              <input
                type="radio"
                name="admin-edit-role"
                checked={role === 'user'}
                onChange={() => setRole('user')}
                disabled={isSelf}
              />
              {t('account.role.user')}
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="admin-edit-role"
                checked={role === 'admin'}
                onChange={() => setRole('admin')}
                disabled={isSelf}
              />
              {t('account.role.admin')}
            </label>
            {isSelf && (
              <p className="field-hint" style={{ margin: '2px 0 0' }}>
                {t('error.cannotRemoveLastAdmin')}
              </p>
            )}
          </fieldset>

          {!isSelf && (
            <div className="setting-row">
              <span id="admin-edit-active-label">{user.active ? t('admin.disable') : t('admin.enable')}</span>
              <button
                type="button"
                role="switch"
                aria-checked={active}
                aria-labelledby="admin-edit-active-label"
                className={active ? 'switch on' : 'switch'}
                onClick={() => setActive((v) => !v)}
              >
                <span className="switch-knob" aria-hidden="true" />
              </button>
            </div>
          )}

          {groups.length > 0 && (
            <div className="field">
              <label className="field-label" htmlFor="admin-edit-group">
                {t('admin.userGroup')}
              </label>
              <select id="admin-edit-group" className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                {groups.some((g) => g.id === groupId) ? null : (
                  <option value={groupId} disabled>
                    {user.groupName ?? groupId}
                  </option>
                )}
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                    {group.isDefault ? ` · ${t('admin.defaultGroupTag')}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="field">
            <label className="field-label" htmlFor="admin-edit-expiry">
              {t('admin.expiryDate')}
            </label>
            <input
              id="admin-edit-expiry"
              className="input"
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
            />
            <p className="field-hint">
              {expiryDate === ''
                ? t('accountSettings.noExpiry')
                : t('account.groupExpiryAt', {
                    date: expiryDate,
                  })}
            </p>
          </div>

          {errorKey !== null && <p className="form-error">{t(errorKey)}</p>}
          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              {t('common.save')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- 弹窗：重置临时密码

function ResetPasswordModal(props: {
  t: TranslateFn;
  client: ConsoleClient;
  user: AdminUserRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, client, user, onClose, onDone } = props;
  const [generated, setGenerated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<LocaleKey | null>(null);

  const reset = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const result = await client.resetAdminUserPassword(user.id);
      setGenerated(result.generatedPassword ?? null);
    } catch (err) {
      setErrorKey(adminErrorToKey(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${t('admin.resetPassword')} · ${user.email}`} onClose={generated !== null ? onDone : onClose}>
      {generated === null ? (
        <div className="modal-body">
          <p className="field-hint" style={{ margin: '0 0 12px' }}>
            {t('admin.tempPasswordOnce')}
          </p>
          {errorKey !== null && <p className="form-error">{t(errorKey)}</p>}
          <div className="modal-foot">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void reset()}>
              {t('admin.resetPassword')}
            </button>
          </div>
        </div>
      ) : (
        <OneTimeSecret
          label={t('admin.tempPassword')}
          hint={t('admin.tempPasswordOnce')}
          value={generated}
          copyLabel={t('common.copy')}
          copiedLabel={t('common.copied')}
          copiedHint={t('common.secretCopied')}
          copyFailedHint={t('common.secretCopyFailed')}
          doneLabel={t('common.done')}
          onDone={onDone}
        />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- 用户管理面板

function UsersPanel(props: AdminUsersGroupsProps) {
  const { t, client, users, currentUserId, groups, ui, onUi, onSetUserActive, onRefreshUsers, onRefreshGroups } = props;
  const locale = readLocale();
  const [dialog, setDialog] = useState<
    null | { kind: 'create' } | { kind: 'edit'; user: AdminUserRow } | { kind: 'reset'; user: AdminUserRow }
  >(null);
  const [rowError, setRowError] = useState<LocaleKey | null>(null);

  /** 行内两击确认：第一次点击登记目标，再次点击同一按钮才执行（点外自动取消由 App 兜底） */
  const runConfirm = (target: string, action: () => Promise<void>): void => {
    if (ui.confirmTarget === target) {
      onUi({ confirmTarget: null });
      void action();
    } else {
      onUi({ confirmTarget: target });
    }
  };

  const deleteUser = async (user: AdminUserRow): Promise<void> => {
    setRowError(null);
    try {
      await client.deleteAdminUser(user.id);
      await Promise.all([onRefreshUsers(), onRefreshGroups()]);
    } catch (err) {
      setRowError(adminErrorToKey(err));
    }
  };

  return (
    <div>
      <div className="panel-toolbar">
        <p className="section-title" style={{ margin: 0 }}>
          {t('admin.tabUsers')}{' '}
          <span className="muted-count mono">{users.length}</span>
        </p>
        <button type="button" className="btn primary" onClick={() => setDialog({ kind: 'create' })}>
          <PlusIcon /> {t('admin.newUser')}
        </button>
      </div>

      {rowError !== null && (
        <p className="form-error" role="alert">
          {t(rowError)}
        </p>
      )}

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('admin.columnUser')}</th>
              <th scope="col">{t('admin.columnRole')}</th>
              <th scope="col">{t('admin.columnGroup')}</th>
              <th scope="col">{t('admin.columnNetworks')}</th>
              <th scope="col">{t('admin.columnMonthlyTraffic')}</th>
              <th scope="col">{t('admin.columnOnline')}</th>
              <th scope="col">{t('admin.columnRelay')}</th>
              <th scope="col">{t('devices.status')}</th>
              <th scope="col">{t('admin.columnActions')}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === currentUserId;
              const disableTarget = `disable-user:${user.id}`;
              const deleteTarget = `delete-user:${user.id}`;
              return (
                <tr key={user.id} className={user.active ? undefined : 'user-disabled'}>
                  <td data-label={t('admin.columnUser')}>
                    <div className="user-email mono">{user.email}</div>
                  </td>
                  <td data-label={t('admin.columnRole')}>{user.role === 'admin' ? t('account.role.admin') : t('account.role.user')}</td>
                  <td data-label={t('admin.columnGroup')}>
                    {user.effectiveGroupName}
                    {user.groupExpiresAt !== null && (
                      <div className="device-note">
                        {t('account.groupExpiryAt', { date: formatQuotaExpiry(user.groupExpiresAt, locale) })}
                      </div>
                    )}
                    {user.isExpiredFallback && <div className="device-note">{t('account.groupExpired')}</div>}
                  </td>
                  <td data-label={t('admin.columnNetworks')} className="mono">
                    {user.networkCount} / {user.maxNetworks === null ? '∞' : user.maxNetworks}
                  </td>
                  <td data-label={t('admin.columnMonthlyTraffic')} className="mono">
                    {formatBytesQuota(user.monthlyRelayBytes, locale)}
                    {user.monthlyRelayQuotaBytes !== null && (
                      <>
                        {' '}
                        / {formatBytesQuota(user.monthlyRelayQuotaBytes, locale)}
                      </>
                    )}
                    <QuotaBar
                      used={user.monthlyRelayBytes}
                      limit={user.monthlyRelayQuotaBytes}
                      label={t('admin.columnMonthlyTraffic')}
                    />
                  </td>
                  <td data-label={t('admin.columnOnline')} className="mono">
                    {user.onlineDevices}
                  </td>
                  <td data-label={t('admin.columnRelay')} className="mono">
                    {formatRate(user.relayKbps)}
                  </td>
                  <td data-label={t('devices.status')}>
                    {!user.active ? (
                      <span className="dot-row">
                        <span className="dot muted" aria-hidden="true" />
                        {t('admin.disabledTag')}
                      </span>
                    ) : user.emailVerifiedAt === null ? (
                      <span className="dot-row">
                        <span className="dot warn" aria-hidden="true" />
                        {t('admin.emailUnverified')}
                      </span>
                    ) : (
                      <span className="dot-row">
                        <span className="dot ok" aria-hidden="true" />
                        {t('admin.emailVerified')}
                      </span>
                    )}
                  </td>
                  <td data-label={t('admin.columnActions')} className="admin-actions-cell">
                    <button type="button" className="btn" onClick={() => setDialog({ kind: 'edit', user })}>
                      {t('admin.editUser')}
                    </button>
                    <button type="button" className="btn" onClick={() => setDialog({ kind: 'reset', user })}>
                      {t('admin.resetPassword')}
                    </button>
                    {!isSelf &&
                      (user.active ? (
                        <button
                          type="button"
                          data-confirm-trigger
                          className={ui.confirmTarget === disableTarget ? 'btn danger solid' : 'btn danger'}
                          onClick={() =>
                            runConfirm(disableTarget, async () => {
                              setRowError(null);
                              onSetUserActive(user.id, false);
                            })
                          }
                        >
                          {ui.confirmTarget === disableTarget ? t('admin.confirmDisable') : t('admin.disable')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            setRowError(null);
                            onSetUserActive(user.id, true);
                          }}
                        >
                          {t('admin.enable')}
                        </button>
                      ))}
                    {!isSelf && (
                      <button
                        type="button"
                        data-confirm-trigger
                        className={ui.confirmTarget === deleteTarget ? 'btn danger solid' : 'btn danger'}
                        onClick={() =>
                          runConfirm(deleteTarget, async () => {
                            await deleteUser(user);
                          })
                        }
                      >
                        {ui.confirmTarget === deleteTarget ? t('common.confirmDelete') : t('common.delete')}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {dialog?.kind === 'create' && (
        <CreateUserModal
          t={t}
          client={client}
          groups={groups}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void onRefreshUsers();
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <EditUserModal
          t={t}
          client={client}
          groups={groups}
          user={dialog.user}
          isSelf={dialog.user.id === currentUserId}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void onRefreshUsers();
          }}
        />
      )}
      {dialog?.kind === 'reset' && (
        <ResetPasswordModal
          t={t}
          client={client}
          user={dialog.user}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void onRefreshUsers();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 弹窗：新建 / 编辑用户组

/** 月度流量的表单草稿：数值 + 单位（MB/GB），勾「不限」时整组禁用 */
function quotaDraftFromBytes(bytes: number | null): { limited: boolean; value: string; unit: 'MB' | 'GB' } {
  if (bytes === null) return { limited: false, value: '', unit: 'GB' };
  const GB = 1024 * 1024 * 1024;
  if (bytes >= GB && bytes % GB === 0) return { limited: true, value: String(bytes / GB), unit: 'GB' };
  return { limited: true, value: String(bytes / (1024 * 1024)), unit: 'MB' };
}

function GroupFormModal(props: {
  t: TranslateFn;
  client: ConsoleClient;
  group?: UserGroup;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, client, group, onClose, onSaved } = props;
  const editing = group !== undefined;
  const [name, setName] = useState(group?.name ?? '');
  const [code, setCode] = useState(group?.code ?? '');
  const [isDefault, setIsDefault] = useState(group?.isDefault ?? false);
  const [maxNetworks, setMaxNetworks] = useState(String(group?.maxNetworks ?? 5));
  const [maxPeers, setMaxPeers] = useState(String(group?.maxPeersPerNetwork ?? 8));
  const [rateKbps, setRateKbps] = useState(String(group?.relayRateKbps ?? 1024));
  const initialQuota = quotaDraftFromBytes(group?.monthlyRelayQuotaBytes ?? null);
  const [quotaLimited, setQuotaLimited] = useState(editing ? initialQuota.limited : true);
  const [quotaValue, setQuotaValue] = useState(editing ? initialQuota.value : (initialQuota.value || '10'));
  const [quotaUnit, setQuotaUnit] = useState<'MB' | 'GB'>(initialQuota.unit);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<LocaleKey | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    // 数值输入的范围交给原生 min/max 校验挡第一道；这里只做字节换算
    const quotaBytes = quotaLimited ? Math.round(Number(quotaValue) * (quotaUnit === 'GB' ? 1024 ** 3 : 1024 ** 2)) : null;
    setBusy(true);
    setErrorKey(null);
    try {
      if (editing && group !== undefined) {
        await client.updateGroup(group.id, {
          name: name.trim(),
          // 当前默认组不可取消默认（开关已禁用）；非默认组勾上才发 isDefault
          ...(group.isDefault || isDefault ? { isDefault: isDefault } : {}),
          maxNetworks: Number(maxNetworks),
          maxPeersPerNetwork: Number(maxPeers),
          relayRateKbps: Number(rateKbps),
          monthlyRelayQuotaBytes: quotaBytes,
        });
      } else {
        await client.createGroup({
          code: code.trim().toLowerCase(),
          name: name.trim(),
          ...(isDefault ? { isDefault: true } : {}),
          maxNetworks: Number(maxNetworks),
          maxPeersPerNetwork: Number(maxPeers),
          relayRateKbps: Number(rateKbps),
          monthlyRelayQuotaBytes: quotaBytes,
        });
      }
      onSaved();
    } catch (err) {
      setErrorKey(adminErrorToKey(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? `${t('admin.editUser')} · ${group?.name ?? ''}` : t('admin.newGroup')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <div className="modal-body">
          <div className="field">
            <label className="field-label" htmlFor="admin-group-name">
              {t('admin.groupName')}
            </label>
            <input
              id="admin-group-name"
              className="input"
              type="text"
              required
              maxLength={48}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="admin-group-code">
              {t('admin.groupCode')}
            </label>
            <input
              id="admin-group-code"
              className="input mono"
              type="text"
              required
              pattern="[a-z0-9][a-z0-9_-]{0,31}"
              value={code}
              disabled={editing}
              onChange={(e) => setCode(e.target.value.toLowerCase())}
            />
            {editing && <p className="field-hint">{t('admin.groupCodeImmutable')}</p>}
          </div>

          <div className="setting-row">
            <span id="admin-group-default-label">{t('admin.isDefaultGroup')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={isDefault}
              aria-labelledby="admin-group-default-label"
              className={isDefault ? 'switch on' : 'switch'}
              disabled={editing && (group?.isDefault ?? false)}
              onClick={() => setIsDefault((v) => !v)}
            >
              <span className="switch-knob" aria-hidden="true" />
            </button>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="admin-group-networks">
              {t('admin.maxNetworks')}
            </label>
            <input
              id="admin-group-networks"
              className="input input-narrow mono"
              type="number"
              required
              min={1}
              max={100}
              step={1}
              value={maxNetworks}
              onChange={(e) => setMaxNetworks(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="admin-group-peers">
              {t('admin.groupPeerCap')}
            </label>
            <input
              id="admin-group-peers"
              className="input input-narrow mono"
              type="number"
              required
              min={2}
              max={64}
              step={1}
              value={maxPeers}
              onChange={(e) => setMaxPeers(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="admin-group-rate">
              {t('admin.groupRateKbps')}
            </label>
            <input
              id="admin-group-rate"
              className="input input-narrow mono"
              type="number"
              required
              min={64}
              max={1048576}
              step={1}
              value={rateKbps}
              onChange={(e) => setRateKbps(e.target.value)}
            />
            <p className="field-hint" style={{ margin: '6px 0 0' }}>
              {t('admin.ratePresets')}
            </p>
            <div className="preset-row">
              {RATE_PRESETS_KBPS.map((preset) => (
                <button
                  type="button"
                  key={preset.label}
                  className="preset-chip mono"
                  onClick={() => setRateKbps(String(preset.value))}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <p className="field-hint">{t('admin.relayDirectHint')}</p>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="admin-group-quota">
              {t('admin.monthlyQuotaGb')}
            </label>
            <div className="setting-row" style={{ justifyContent: 'flex-start', gap: 12 }}>
              <label className="radio-row" style={{ padding: 0 }}>
                <input
                  type="checkbox"
                  checked={!quotaLimited}
                  onChange={(e) => setQuotaLimited(!e.target.checked)}
                />
                {t('common.unlimited')}
              </label>
              <input
                id="admin-group-quota"
                className="input input-narrow mono"
                type="number"
                required={quotaLimited}
                min={1}
                step={1}
                disabled={!quotaLimited}
                value={quotaLimited ? quotaValue : ''}
                onChange={(e) => setQuotaValue(e.target.value)}
              />
              <select
                className="input input-narrow"
                aria-label={t('admin.monthlyQuotaGb')}
                disabled={!quotaLimited}
                value={quotaUnit}
                onChange={(e) => setQuotaUnit(e.target.value === 'MB' ? 'MB' : 'GB')}
              >
                <option value="MB">MB</option>
                <option value="GB">GB</option>
              </select>
            </div>
            <p className="field-hint">{t('admin.quotaThrottleNote')}</p>
          </div>

          {errorKey !== null && <p className="form-error">{t(errorKey)}</p>}
          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              {editing ? t('common.save') : t('common.create')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- 用户组面板

function GroupsPanel(props: AdminUsersGroupsProps) {
  const { t, client, groups, ui, onUi, onRefreshGroups } = props;
  const locale = readLocale();
  const [dialog, setDialog] = useState<null | { kind: 'create' } | { kind: 'edit'; group: UserGroup }>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, LocaleKey>>({});

  const runConfirm = (target: string, action: () => Promise<void>): void => {
    if (ui.confirmTarget === target) {
      onUi({ confirmTarget: null });
      void action();
    } else {
      onUi({ confirmTarget: target });
    }
  };

  const deleteGroup = async (group: UserGroup): Promise<void> => {
    setCardErrors((prev) => {
      const next = { ...prev };
      delete next[group.id];
      return next;
    });
    try {
      await client.deleteGroup(group.id);
      await onRefreshGroups();
    } catch (err) {
      // 默认组 → CANNOT_DELETE_DEFAULT_GROUP；仍有成员 → GROUP_IN_USE（明确提示）
      setCardErrors((prev) => ({ ...prev, [group.id]: adminErrorToKey(err) }));
    }
  };

  return (
    <div>
      <div className="panel-toolbar">
        <p className="section-title" style={{ margin: 0 }}>
          {t('admin.tabGroups')}{' '}
          <span className="muted-count mono">{groups.length}</span>
        </p>
        <button type="button" className="btn primary" onClick={() => setDialog({ kind: 'create' })}>
          <PlusIcon /> {t('admin.newGroup')}
        </button>
      </div>
      <p className="field-hint" style={{ margin: '0 0 12px' }}>
        {t('admin.groupAdminExemptNote')}
      </p>

      {groups.length === 0 ? (
        <p className="empty-hint">—</p>
      ) : (
        <div className="group-grid">
          {groups.map((group) => {
            const deleteTarget = `delete-group:${group.id}`;
            const confirming = ui.confirmTarget === deleteTarget;
            const cardError = cardErrors[group.id];
            return (
              <div key={group.id} className="group-card">
                <div className="group-card-head">
                  <h3 className="group-name">
                    {group.name}
                    {group.isDefault && <span className="group-badge">{t('admin.defaultGroupTag')}</span>}
                  </h3>
                  <span className="muted mono">{group.code}</span>
                </div>
                <dl className="group-quota-list">
                  <div>
                    <dt>{t('admin.maxNetworks')}</dt>
                    <dd className="mono">{group.maxNetworks}</dd>
                  </div>
                  <div>
                    <dt>{t('admin.groupPeerCap')}</dt>
                    <dd className="mono">{group.maxPeersPerNetwork}</dd>
                  </div>
                  <div>
                    <dt>{t('admin.groupRateKbps')}</dt>
                    <dd className="mono">{formatRate(group.relayRateKbps)}</dd>
                  </div>
                  <div>
                    <dt>{t('admin.monthlyQuotaGb')}</dt>
                    <dd className="mono">{formatBytesQuota(group.monthlyRelayQuotaBytes, locale)}</dd>
                  </div>
                </dl>
                <div className="group-card-foot">
                  <span className="dot-row" title={String(group.userCount)}>
                    <UsersIcon size={12} />
                    <span className="mono">{group.userCount}</span>
                  </span>
                  <div className="group-actions">
                    <button type="button" className="btn" onClick={() => setDialog({ kind: 'edit', group })}>
                      <EditIcon /> {t('admin.editUser')}
                    </button>
                    {!group.isDefault && (
                      <button
                        type="button"
                        data-confirm-trigger
                        className={confirming ? 'btn danger solid' : 'btn danger'}
                        onClick={() =>
                          runConfirm(deleteTarget, async () => {
                            await deleteGroup(group);
                          })
                        }
                      >
                        {confirming ? (
                          <>
                            <TrashIcon /> {t('common.confirmDelete')}
                          </>
                        ) : (
                          <>
                            <TrashIcon /> {t('common.delete')}
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
                {cardError !== undefined && (
                  <p className="form-error" role="alert">
                    {t(cardError)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {dialog?.kind === 'create' && (
        <GroupFormModal
          t={t}
          client={client}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void onRefreshGroups();
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <GroupFormModal
          t={t}
          client={client}
          group={dialog.group}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void onRefreshGroups();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 双模式入口

export function AdminUsersGroups(props: AdminUsersGroupsProps) {
  return props.mode === 'users' ? <UsersPanel {...props} /> : <GroupsPanel {...props} />;
}
