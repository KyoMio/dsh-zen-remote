// 登录 / 注册 / 找回密码三态视图（GC-8）：
//   - 右上角常驻轻量「语言 / 深浅色」切换：调用与主界面同一份 theme/locale
//     状态（App 落 localStorage 与 <html data-theme>，/theme-init.js 约定不变）；
//   - 登录 / 注册双标签（仅 allowSignup 时显示注册）；忘记密码是第三态——
//     smtpConfigured === false 时入口只给明确提示不空转；
//   - 密码一律单框 + aria-pressed 显隐开关（绝不「两次输入确认」双框）；
//     注册（requireEmailVerification 时）与找回带单框 6 位验证码 + 60s 冷却
//     重发（倒计时只是 UI 预估，服务端 OTP_COOLDOWN 才是权威）。
// 表单草稿（邮箱/密码/当前标签）仍存 store 的 ui 切片；验证码、倒计时、
// 找回态是本页本地状态——未登录没有 SSE，组件不卸载就不会被冲掉。
//
// 本文件还导出 PasswordField / OtpInput / useResendCooldown 三个小共用件：
// GC-8 文件白名单只允许改 4 个文件，无法新增共享模块，账号设置弹窗
// （AccountSettingsModal.tsx）直接从这里 import 同一份实现。
import { useEffect, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';

import type { Locale, LocaleKey, TranslateFn } from '../i18n/locales';
import type { PublicAuthMeta, SessionMeta, UiLocalState } from '../store/console-store';
import { EyeIcon, EyeOffIcon, GlobeIcon, MoonIcon, ServerIcon, SunIcon } from './Icons';

export type LoginMode = 'login' | 'signup' | 'forgot';

export interface LoginViewProps {
  t: TranslateFn;
  meta: SessionMeta;
  /** /auth/me 公开策略：requireEmailVerification 决定注册是否带验证码步，smtpConfigured 决定找回入口 */
  policy: PublicAuthMeta;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  busy: boolean;
  errorKey: LocaleKey | null;
  /** 切换标签/模式时清掉 App 持有的上一态错误，不让错因挂在另一张表单上 */
  onDismissError: () => void;
  /** 提交登录 / 注册 / 重置密码；返回是否成功（找回成功由本组件展示 resetDone 并回登录态） */
  onSubmit: (mode: LoginMode, email: string, password: string, otpCode?: string) => Promise<boolean>;
  /** 发送 6 位验证码（POST /auth/send-otp）；失败返回 null（错因已写入 errorKey） */
  onSendOtp: (purpose: 'signup' | 'reset_password', email: string) => Promise<{ sent: boolean; cooldownSec: number } | null>;
  theme: 'light' | 'dark';
  locale: Locale;
  onToggleTheme: () => void;
  onToggleLocale: () => void;
}

// ---------------------------------------------------------------- 共用小件（AccountSettingsModal 复用）

/**
 * 秒级倒计时：验证码重发冷却的 UI 预估，每秒递减到 0 自停。
 */
export function useResendCooldown(): { seconds: number; start: (n: number) => void; reset: () => void } {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = setTimeout(() => setSeconds((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearTimeout(timer);
  }, [seconds]);
  return {
    seconds,
    start: (n: number) => setSeconds(Math.max(1, Math.round(n))),
    reset: () => setSeconds(0),
  };
}

/** 显隐开关按钮在输入框内的定位（GC-8 白名单内不能改 global.css，内联样式走 CSP 已允许的 style 属性） */
const revealButtonStyle: CSSProperties = {
  position: 'absolute',
  right: 3,
  top: 3,
  width: 28,
  height: 28,
  padding: 0,
  border: 'none',
  background: 'none',
  color: 'var(--ink-3)',
  cursor: 'pointer',
  display: 'grid',
  placeItems: 'center',
};

/**
 * 带显隐开关的单行密码框：单个输入框 + aria-pressed 眼睛按钮，
 * 绝不做「两次输入确认密码」的双框写法（GC-8 拍板）。
 */
export function PasswordField(props: {
  id: string;
  label: string;
  value: string;
  autoComplete: 'current-password' | 'new-password';
  required?: boolean;
  minLength?: number;
  onChange: (value: string) => void;
  t: TranslateFn;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="field">
      <label className="field-label" htmlFor={props.id}>
        {props.label}
      </label>
      <div style={{ position: 'relative' }}>
        <input
          id={props.id}
          className="input"
          type={visible ? 'text' : 'password'}
          required={props.required}
          minLength={props.minLength}
          autoComplete={props.autoComplete}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          style={{ paddingRight: 36 }}
        />
        <button
          type="button"
          aria-pressed={visible}
          aria-label={visible ? props.t('auth.passwordHide') : props.t('auth.passwordShow')}
          title={visible ? props.t('auth.passwordHide') : props.t('auth.passwordShow')}
          onClick={() => setVisible((v) => !v)}
          style={revealButtonStyle}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    </div>
  );
}

/**
 * 单框 6 位数字验证码输入（DESIGN.md「Auth, OTP & Settings Forms」）：
 * 绝不拆成 6 个单字符框，也不用 type=number；非数字输入就地滤除。
 */
export function OtpInput(props: { id: string; value: string; required?: boolean; onChange: (value: string) => void; t: TranslateFn }) {
  return (
    <input
      id={props.id}
      className="input mono"
      type="text"
      inputMode="numeric"
      pattern="[0-9]{6}"
      maxLength={6}
      required={props.required}
      autoComplete="one-time-code"
      placeholder={props.t('auth.codePlaceholder')}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      style={{ letterSpacing: '0.35em', fontSize: 'max(1rem, 16px)' }}
    />
  );
}

/** 宽松的邮箱形态检查：只拦「@ 两边都要有东西」，格式对错交给服务端与原生校验 */
function emailLooksComplete(email: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(email.trim());
}

// ---------------------------------------------------------------- 主视图

export function LoginView(props: LoginViewProps) {
  const {
    t,
    meta,
    policy,
    ui,
    onUi,
    busy,
    errorKey,
    onDismissError,
    onSubmit,
    onSendOtp,
    theme,
    locale,
    onToggleTheme,
    onToggleLocale,
  } = props;

  const signupAllowed = meta.allowSignup === true;
  // 找回是第三态：store 的 ui.loginMode 只有 'login' | 'signup' 两键（类型不动），本页用本地布尔扩展
  const [forgot, setForgot] = useState(false);
  const mode: LoginMode = forgot ? 'forgot' : ui.loginMode === 'signup' && signupAllowed ? 'signup' : 'login';
  const needsOtp = (mode === 'signup' && policy.requireEmailVerification) || mode === 'forgot';

  const [otpCode, setOtpCode] = useState('');
  const [codeHint, setCodeHint] = useState<LocaleKey | null>(null);
  const cooldown = useResendCooldown();
  const [newPassword, setNewPassword] = useState('');
  const [resetDone, setResetDone] = useState(false);
  const [forgotNotice, setForgotNotice] = useState<LocaleKey | null>(null);

  const email = ui.loginEmail;

  /** 切态整理：验证码/倒计时/已发送提示/找回草稿跟着当前态作废（服务端冷却仍兜底） */
  const resetTransients = (): void => {
    setOtpCode('');
    setCodeHint(null);
    cooldown.reset();
    setNewPassword('');
    setForgotNotice(null);
    onDismissError();
  };

  const switchTab = (tab: 'login' | 'signup'): void => {
    if (tab === mode) return;
    setForgot(false);
    setResetDone(false);
    resetTransients();
    onUi({ loginMode: tab });
  };

  const enterForgot = (): void => {
    setForgot(true);
    setResetDone(false);
    resetTransients();
  };

  /** 回登录态；resetDone 提示由调用方在其后设置（这里不清） */
  const exitForgot = (): void => {
    setForgot(false);
    resetTransients();
  };

  /** 换邮箱 = 换收件地址：旧验证码、已发送提示与冷却一并作废 */
  const handleEmailInput = (value: string): void => {
    if (codeHint !== null) setCodeHint(null);
    if (cooldown.seconds > 0) cooldown.reset();
    if (otpCode !== '') setOtpCode('');
    onUi({ loginEmail: value });
  };

  const handleSendCode = async (): Promise<void> => {
    const result = await onSendOtp(mode === 'forgot' ? 'reset_password' : 'signup', email);
    if (result !== null) {
      setCodeHint('auth.codeSent');
      cooldown.start(result.cooldownSec);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const ok = await onSubmit(mode, email, mode === 'forgot' ? newPassword : ui.loginPassword, needsOtp ? otpCode : undefined);
    if (ok && mode === 'forgot') {
      // 重置成功：清草稿回登录页，并给一句明确的下一步提示
      exitForgot();
      onUi({ loginPassword: '' });
      setResetDone(true);
    }
  };

  // 邮箱框三态共用（找回模式下右侧多一个发码按钮的是验证码框，不是邮箱框）
  const emailField = (
    <div className="field">
      <label className="field-label" htmlFor="login-email">
        {t('auth.email')}
      </label>
      <input
        id="login-email"
        className="input"
        type="email"
        required
        autoComplete="username"
        spellCheck={false}
        autoCapitalize="none"
        placeholder={t('auth.emailPlaceholder')}
        value={email}
        onChange={(e) => handleEmailInput(e.target.value)}
      />
    </div>
  );

  const otpSection = needsOtp ? (
    <div className="field">
      <label className="field-label" htmlFor="login-otp">
        {t('auth.codeLabel')}
      </label>
      {/* 提示文字放在输入框上方：手机键盘与自动填充气泡不会遮住它（DESIGN.md） */}
      <p className="field-hint" style={{ margin: '0 0 4px' }}>
        {t('auth.codeHint')}
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <OtpInput id="login-otp" value={otpCode} required onChange={setOtpCode} t={t} />
        <button
          type="button"
          className="btn"
          disabled={busy || !emailLooksComplete(email) || cooldown.seconds > 0}
          title={cooldown.seconds > 0 ? t('auth.resendCooldown', { n: cooldown.seconds }) : undefined}
          onClick={() => void handleSendCode()}
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
  ) : null;

  return (
    <div className="login-view">
      {/* 登录前右上角轻控件：语言 + 主题，与主界面共用同一份状态（GC-8） */}
      <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 10, display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="btn ghost"
          aria-label={t('account.language')}
          title={t('account.language')}
          onClick={onToggleLocale}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <GlobeIcon />
          <span>{locale === 'zh' ? 'EN' : '中文'}</span>
        </button>
        <button
          type="button"
          className="btn ghost"
          aria-label={t('account.darkMode')}
          title={t('account.darkMode')}
          onClick={onToggleTheme}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, padding: 0 }}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>

      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            <ServerIcon size={16} />
          </span>
          <span className="login-brand-title">{t('app.title')}</span>
        </div>

        {forgot ? (
          <form onSubmit={(e) => void handleSubmit(e)}>
            <div style={{ marginBottom: 12 }}>
              <p className="section-title" style={{ margin: 0 }}>
                {t('auth.forgotTitle')}
              </p>
              <p className="login-hint" style={{ margin: '4px 0 0' }}>
                {t('auth.forgotHint')}
              </p>
            </div>
            {emailField}
            {otpSection}
            <PasswordField
              id="forgot-new-password"
              label={t('auth.newPassword')}
              value={newPassword}
              required
              minLength={8}
              autoComplete="new-password"
              onChange={setNewPassword}
              t={t}
            />
            <button type="submit" className="btn primary block" disabled={busy}>
              {t('auth.resetPassword')}
            </button>
            {errorKey !== null && <p className="form-error">{t(errorKey)}</p>}
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <button type="button" className="back-link" onClick={exitForgot}>
                {t('auth.backToLogin')}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)}>
            {resetDone && <p className="login-hint">{t('auth.resetDone')}</p>}
            {signupAllowed && (
              <div className="tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'login'}
                  className="tab"
                  onClick={() => switchTab('login')}
                >
                  {t('auth.login')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'signup'}
                  className="tab"
                  onClick={() => switchTab('signup')}
                >
                  {t('auth.signup')}
                </button>
              </div>
            )}

            {mode === 'signup' && (
              <p className="login-hint">
                {t('auth.signupQuotaHint', { n: meta.maxNetworksPerUser })}
                {policy.requireEmailVerification ? ` ${t('auth.signupNeedsVerification')}` : ''}
              </p>
            )}

            {emailField}

            {mode === 'login' && (
              <>
                <PasswordField
                  id="login-password"
                  label={t('auth.password')}
                  value={ui.loginPassword}
                  required
                  autoComplete="current-password"
                  onChange={(v) => onUi({ loginPassword: v })}
                  t={t}
                />
                {/* 忘记密码入口：未配发信时只给明确提示，不进空转的找回流程（GC-8） */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '-8px 0 14px' }}>
                  <button
                    type="button"
                    className="back-link"
                    onClick={() => {
                      if (policy.smtpConfigured) {
                        enterForgot();
                      } else {
                        setForgotNotice('error.smtpNotConfigured');
                      }
                    }}
                  >
                    {t('auth.forgotPassword')}
                  </button>
                </div>
                {forgotNotice !== null && (
                  <p className="form-error" style={{ margin: '0 0 14px' }}>
                    {t(forgotNotice)}
                  </p>
                )}
              </>
            )}

            {mode === 'signup' && (
              <PasswordField
                id="signup-password"
                label={t('auth.password')}
                value={ui.loginPassword}
                required
                minLength={8}
                autoComplete="new-password"
                onChange={(v) => onUi({ loginPassword: v })}
                t={t}
              />
            )}

            <button type="submit" className="btn primary block" disabled={busy}>
              {mode === 'signup' ? t('auth.signup') : t('auth.login')}
            </button>
            {errorKey !== null && <p className="form-error">{t(errorKey)}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
