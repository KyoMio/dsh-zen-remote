// 登录注册页（PG-6a）：居中卡片 + 品牌标识 + 双标签（仅开放注册时显示）。
// 表单草稿（邮箱/密码/当前标签）全部存 store 的 ui 切片——实时推送只动
// topology 切片，绝不冲掉正在输入的表单字段。
import type { FormEvent } from 'react';

import type { LocaleKey, TranslateFn } from '../i18n/locales';
import type { SessionMeta, UiLocalState } from '../store/console-store';

export interface LoginViewProps {
  t: TranslateFn;
  meta: SessionMeta;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  busy: boolean;
  errorKey: LocaleKey | null;
  onSubmit: (mode: 'login' | 'signup', email: string, password: string) => void;
}

export function LoginView({ t, meta, ui, onUi, busy, errorKey, onSubmit }: LoginViewProps) {
  const signupAllowed = meta.allowSignup === true;
  const isSignup = signupAllowed && ui.loginMode === 'signup';

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSubmit(isSignup ? 'signup' : 'login', ui.loginEmail, ui.loginPassword);
  };

  return (
    <div className="login-view">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
              <path d="M8 16 16 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <circle cx="7" cy="17" r="3" fill="currentColor" />
              <circle cx="17" cy="7" r="3" fill="currentColor" />
            </svg>
          </span>
          <span className="login-brand-title">{t('app.title')}</span>
        </div>

        <form onSubmit={handleSubmit}>
          {signupAllowed && (
            <div className="tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={!isSignup}
                className="tab"
                onClick={() => onUi({ loginMode: 'login' })}
              >
                {t('auth.login')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={isSignup}
                className="tab"
                onClick={() => onUi({ loginMode: 'signup' })}
              >
                {t('auth.signup')}
              </button>
            </div>
          )}

          {isSignup && <p className="login-hint">{t('auth.signupQuotaHint', { n: meta.maxNetworksPerUser })}</p>}

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
              placeholder={t('auth.emailPlaceholder')}
              value={ui.loginEmail}
              onChange={(e) => onUi({ loginEmail: e.target.value })}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="login-password">
              {t('auth.password')}
            </label>
            <input
              id="login-password"
              className="input"
              type="password"
              required
              minLength={8}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              value={ui.loginPassword}
              onChange={(e) => onUi({ loginPassword: e.target.value })}
            />
          </div>

          <button type="submit" className="btn primary block" disabled={busy}>
            {isSignup ? t('auth.signup') : t('auth.login')}
          </button>

          {errorKey !== null && <p className="form-error">{t(errorKey)}</p>}
        </form>
      </div>
    </div>
  );
}
