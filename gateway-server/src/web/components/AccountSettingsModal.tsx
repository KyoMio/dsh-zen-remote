// 账号设置弹窗（GC-8）：面向所有已登录用户（含初始 admin@local），基于
// 升级后的原生 <dialog> Modal 封装。三个区块：
//   1. 配额摘要：当前用户组与到期（含到期回退提醒）、已建网络数、单设备
//      中转限速、本月网关中转流量进度条（formatBytesQuota + computeUsagePercent，
//      ≥80% 高水位 / 超限给明确提示，档位色与 Quota Meter 规范一致）；
//   2. 修改密码：当前密码 + 单个新密码（均带显隐开关），成功后 toast
//      「当前设备保持登录，其他设备已退出」（toast 由 App 统一弹）；
//   3. 更换邮箱：当前密码 + 新邮箱；SMTP 已配置走两步（先向新邮箱发 6 位
//      验证码、60s 冷却重发，再核验换绑），未配置一步直改（方便初装
//      admin@local 换绑真实邮箱）。
// 表单状态全部组件内 useState：弹窗打开期间 SSE 只替换 topology 切片，
// ui 引用不变、弹窗不卸载，正在输入的草稿不会被实时推送冲掉。
// 换绑成功后 App 会重新 fetchMe：顶栏邮箱、配额摘要与本弹窗副标题即时刷新。
import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';

import {
  computeUsagePercent,
  formatBytesQuota,
  formatQuotaExpiry,
  formatRate,
  isQuotaExceeded,
  quotaUsageLevel,
} from '../format';
import type { UsageLevel } from '../format';
import type { Locale, LocaleKey, TranslateFn } from '../i18n/locales';
import { ConsoleApiError } from '../store/console-store';
import type { PublicUser, UserQuotaSummary } from '../store/console-store';
import { OtpInput, PasswordField, useResendCooldown } from './LoginView';
import { Modal } from './Modal';

export interface AccountSettingsModalProps {
  t: TranslateFn;
  /** formatQuotaExpiry / formatBytesQuota 的语言入参 */
  locale: Locale;
  user: PublicUser;
  /** /auth/me 的有效配额视图；登录态恒有，缺了就整段不渲染（防御） */
  quota: UserQuotaSummary | null;
  /** 网关是否配置了发信服务：决定换邮箱走两步验证码还是一步直改 */
  smtpConfigured: boolean;
  onClose: () => void;
  /** 自助改密（PATCH /auth/account/password）；失败抛 ConsoleApiError 由本组件映射文案 */
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** 换绑第一步（POST /auth/account/email/request）；SMTP 未配置时返回 otpRequired: false */
  onRequestEmailChange: (currentPassword: string, newEmail: string) => Promise<{ otpRequired: boolean; cooldownSec: number }>;
  /** 换绑第二步（POST /auth/account/email）；成功后 App 刷新会话并弹 toast */
  onConfirmEmailChange: (currentPassword: string, newEmail: string, otpCode?: string) => Promise<void>;
}

/** 账号自助接口的错误码 → 词典键：改密/换绑的 INVALID_CREDENTIALS 是「当前密码不对」 */
function accountErrorToKey(err: unknown): LocaleKey {
  const code = err instanceof ConsoleApiError ? err.code : '';
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return 'error.currentPasswordWrong';
    case 'EMAIL_TAKEN':
      return 'error.emailTaken';
    case 'RATE_LIMITED':
      return 'error.rateLimited';
    case 'OTP_COOLDOWN':
      return 'error.otpCooldown';
    case 'OTP_INVALID':
      return 'error.otpInvalid';
    case 'OTP_LOCKED':
      return 'error.otpLocked';
    case 'SMTP_NOT_CONFIGURED':
      return 'error.smtpNotConfigured';
    case 'SMTP_SEND_FAILED':
      return 'error.smtpSendFailed';
    case 'NETWORK_ERROR':
      return 'error.network';
    default:
      return 'error.generic';
  }
}

/** 配额进度条的 4px 轨道（白名单内不能改 global.css，内联样式走 CSP 已允许的 style 属性） */
function UsageMeter(props: { percent: number; level: UsageLevel; label: string }) {
  const fill = props.level === 'danger' ? 'var(--danger)' : props.level === 'warn' ? 'var(--warn)' : 'var(--accent)';
  return (
    <div
      role="img"
      aria-label={props.label}
      style={{ height: 4, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden' }}
    >
      <div style={{ height: '100%', width: `${props.percent}%`, borderRadius: 999, background: fill }} />
    </div>
  );
}

// ---------------------------------------------------------------- 区块 1：配额摘要

function QuotaSummarySection(props: { t: TranslateFn; locale: Locale; user: PublicUser; quota: UserQuotaSummary }) {
  const { t, locale, user, quota } = props;
  const percent = computeUsagePercent(quota.usedMonthlyRelayBytes, quota.monthlyRelayQuotaBytes);
  const level = quotaUsageLevel(quota.usedMonthlyRelayBytes, quota.monthlyRelayQuotaBytes);
  const exceeded = isQuotaExceeded(quota.usedMonthlyRelayBytes, quota.monthlyRelayQuotaBytes);
  return (
    <section>
      <dl className="meta-grid" style={{ margin: '0 0 14px' }}>
        <div className="meta-item">
          <dt>{t('accountSettings.myGroup')}</dt>
          <dd>
            {quota.groupName}
            {user.role === 'admin' && <span className="muted"> · {t('account.role.admin')}</span>}
          </dd>
        </div>
        <div className="meta-item">
          <dt>{t('accountSettings.expiresAt')}</dt>
          <dd className="mono">{formatQuotaExpiry(quota.groupExpiresAt, locale)}</dd>
          {quota.isExpiredFallback && <dd className="field-hint">{t('account.groupExpired')}</dd>}
        </div>
        <div className="meta-item">
          <dt>{t('accountSettings.networkUsage')}</dt>
          <dd className="mono">
            {quota.usedNetworks} / {quota.maxNetworks === null ? t('common.unlimited') : quota.maxNetworks}
          </dd>
        </div>
        <div className="meta-item">
          <dt>{t('admin.perDeviceRelayLimit')}</dt>
          <dd className="mono">{formatRate(quota.relayRateKbps)}</dd>
          <dd className="field-hint">{t('admin.relayDirectHint')}</dd>
        </div>
      </dl>

      {user.role === 'admin' && (
        <p className="field-hint" style={{ margin: '-6px 0 12px' }}>
          {t('account.adminQuotaNote')}
        </p>
      )}

      <div className="field-label" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <span>{t('accountSettings.monthlyTraffic')}</span>
        <span className="mono">
          {quota.monthlyRelayQuotaBytes === null
            ? t('common.unlimited')
            : t('common.usedOfLimit', {
                used: formatBytesQuota(quota.usedMonthlyRelayBytes, locale),
                limit: formatBytesQuota(quota.monthlyRelayQuotaBytes, locale),
              })}
        </span>
      </div>
      {percent !== null && (
        <UsageMeter
          percent={percent}
          level={level}
          label={t('common.usedOfLimit', {
            used: formatBytesQuota(quota.usedMonthlyRelayBytes, locale),
            limit: formatBytesQuota(quota.monthlyRelayQuotaBytes, locale),
          })}
        />
      )}
      {exceeded ? (
        <p className="field-hint" style={{ margin: '6px 0 0' }}>
          {t('overview.monthlyTrafficExceeded')}
        </p>
      ) : level === 'warn' && percent !== null ? (
        <p className="field-hint" style={{ margin: '6px 0 0' }}>
          {t('overview.monthlyTrafficNearLimit', { percent })}
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- 区块 2：修改密码

function ChangePasswordSection(props: {
  t: TranslateFn;
  onChangePassword: AccountSettingsModalProps['onChangePassword'];
}) {
  const { t, onChangePassword } = props;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [errorKey, setErrorKey] = useState<LocaleKey | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setErrorKey(null);
    try {
      await onChangePassword(current, next);
      setCurrent('');
      setNext('');
      setFormKey((k) => k + 1);
      setSaved(true);
    } catch (err) {
      setErrorKey(accountErrorToKey(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form key={formKey} onSubmit={(e) => void submit(e)}>
      <p className="section-title" style={{ margin: '0 0 10px' }}>
        {t('accountSettings.changePasswordTitle')}
      </p>
      <PasswordField
        id="account-current-password"
        label={t('accountSettings.currentPassword')}
        value={current}
        required
        autoComplete="current-password"
        onChange={(v) => {
          setCurrent(v);
          setSaved(false);
        }}
        t={t}
      />
      <PasswordField
        id="account-new-password"
        label={t('auth.newPassword')}
        value={next}
        required
        minLength={8}
        autoComplete="new-password"
        onChange={(v) => {
          setNext(v);
          setSaved(false);
        }}
        t={t}
      />
      {errorKey !== null && <p className="form-error">{t(errorKey)}</p>}
      <div className="modal-foot">
        {saved && errorKey === null && (
          <p className="form-status-ok" role="status">
            {t('toast.saved')}
          </p>
        )}
        <button type="submit" className="btn primary" disabled={busy || current.length === 0 || next.length < 8}>
          {t('common.save')}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- 区块 3：更换邮箱

function ChangeEmailSection(props: {
  t: TranslateFn;
  smtpConfigured: boolean;
  onRequestEmailChange: AccountSettingsModalProps['onRequestEmailChange'];
  onConfirmEmailChange: AccountSettingsModalProps['onConfirmEmailChange'];
}) {
  const { t, smtpConfigured, onRequestEmailChange, onConfirmEmailChange } = props;
  const [currentPassword, setCurrentPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpStep, setOtpStep] = useState(false);
  const [codeHint, setCodeHint] = useState<LocaleKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [errorKey, setErrorKey] = useState<LocaleKey | null>(null);
  const cooldown = useResendCooldown();

  const emailTrimmed = newEmail.trim();
  const emailReady = /^[^\s@]+@[^\s@]+$/.test(emailTrimmed);

  /** 成功后清空整张表单（邮箱换成自己时 App 的 fetchMe 会刷新弹窗副标题） */
  const finish = (): void => {
    setOtpStep(false);
    setOtpCode('');
    setCodeHint(null);
    cooldown.reset();
    setCurrentPassword('');
    setNewEmail('');
    setFormKey((k) => k + 1);
    setErrorKey(null);
    setSaved(true);
  };

  /** 换邮箱地址 = 旧的验证码作废：退回第一步并清验证码/倒计时 */
  const handleEmailInput = (value: string): void => {
    setNewEmail(value);
    setSaved(false);
    if (otpStep) {
      setOtpStep(false);
      setOtpCode('');
      setCodeHint(null);
      cooldown.reset();
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setErrorKey(null);
    try {
      if (!smtpConfigured) {
        // 未配发信：凭当前密码一步直改（无验证码步）
        await onConfirmEmailChange(currentPassword, emailTrimmed);
        finish();
      } else if (!otpStep) {
        // 两步第一步：向新邮箱发码（顺带校验当前密码与邮箱可用性）
        const result = await onRequestEmailChange(currentPassword, emailTrimmed);
        if (result.otpRequired) {
          setOtpStep(true);
          setCodeHint('auth.codeSent');
          cooldown.start(result.cooldownSec);
          setOtpCode('');
        } else {
          // 服务端说不需要验证码（理论只在未配 SMTP 时出现）：防御性一步直改
          await onConfirmEmailChange(currentPassword, emailTrimmed);
          finish();
        }
      } else {
        // 两步第二步：核验验证码完成换绑
        await onConfirmEmailChange(currentPassword, emailTrimmed, otpCode);
        finish();
      }
    } catch (err) {
      setErrorKey(accountErrorToKey(err));
    } finally {
      setBusy(false);
    }
  };

  /** 验证码步的重发：重新走第一步（新码覆盖旧码，服务端 OTP_COOLDOWN 兜底） */
  const resend = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const result = await onRequestEmailChange(currentPassword, emailTrimmed);
      setCodeHint('auth.codeSent');
      cooldown.start(result.cooldownSec);
    } catch (err) {
      setErrorKey(accountErrorToKey(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form key={formKey} onSubmit={(e) => void submit(e)}>
      <p className="section-title" style={{ margin: '0 0 10px' }}>
        {t('accountSettings.changeEmailTitle')}
      </p>
      <p className="field-hint" style={{ margin: '0 0 10px' }}>
        {smtpConfigured ? t('accountSettings.emailCodeHint') : t('accountSettings.emailNoSmtpHint')}
      </p>
      <PasswordField
        id="account-email-password"
        label={t('accountSettings.currentPassword')}
        value={currentPassword}
        required
        autoComplete="current-password"
        onChange={setCurrentPassword}
        t={t}
      />
      <div className="field">
        <label className="field-label" htmlFor="account-email-new">
          {t('accountSettings.newEmail')}
        </label>
        <input
          id="account-email-new"
          className="input"
          type="email"
          required
          autoComplete="email"
          spellCheck={false}
          autoCapitalize="none"
          placeholder={t('auth.emailPlaceholder')}
          value={newEmail}
          onChange={(e) => handleEmailInput(e.target.value)}
        />
      </div>

      {smtpConfigured && otpStep && (
        <div className="field">
          <label className="field-label" htmlFor="account-email-otp">
            {t('accountSettings.emailCode')}
          </label>
          <p className="field-hint" style={{ margin: '0 0 4px' }}>
            {t('auth.codeHint')}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <OtpInput id="account-email-otp" value={otpCode} required onChange={setOtpCode} t={t} />
            <button
              type="button"
              className="btn"
              disabled={busy || cooldown.seconds > 0}
              title={cooldown.seconds > 0 ? t('auth.resendCooldown', { n: cooldown.seconds }) : undefined}
              onClick={() => void resend()}
              style={{ flex: 'none', whiteSpace: 'nowrap' }}
            >
              {cooldown.seconds > 0 ? t('auth.resendCooldown', { n: cooldown.seconds }) : t('auth.sendCode')}
            </button>
          </div>
          {codeHint !== null && (
            <p className="login-hint" style={{ margin: '6px 0 0' }}>
              {t(codeHint)}
            </p>
          )}
        </div>
      )}

      {errorKey !== null && <p className="form-error">{t(errorKey)}</p>}
      <div className="modal-foot">
        {saved && errorKey === null && (
          <p className="form-status-ok" role="status">
            {t('toast.saved')}
          </p>
        )}
        <button type="submit" className="btn primary" disabled={busy || !emailReady || (otpStep && otpCode.length !== 6)}>
          {smtpConfigured && !otpStep ? t('auth.sendCode') : t('common.save')}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- 弹窗壳

const separatorStyle: CSSProperties = { margin: '14px 6px' };

export function AccountSettingsModal(props: AccountSettingsModalProps) {
  const { t, locale, user, quota, smtpConfigured, onClose, onChangePassword, onRequestEmailChange, onConfirmEmailChange } = props;
  return (
    <Modal title={t('accountSettings.title')} subtitle={user.email} onClose={onClose}>
      <div className="modal-body">
        {quota !== null && (
          <>
            <QuotaSummarySection t={t} locale={locale} user={user} quota={quota} />
            <div className="menu-sep" style={separatorStyle} aria-hidden="true" />
          </>
        )}
        <ChangePasswordSection t={t} onChangePassword={onChangePassword} />
        <div className="menu-sep" style={separatorStyle} aria-hidden="true" />
        <ChangeEmailSection t={t} smtpConfigured={smtpConfigured} onRequestEmailChange={onRequestEmailChange} onConfirmEmailChange={onConfirmEmailChange} />
      </div>
    </Modal>
  );
}
