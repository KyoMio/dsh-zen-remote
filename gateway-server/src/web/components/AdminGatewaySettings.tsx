// 网关管理 · 网关与发信设置面板（GC-10）。四个区块：
//   1. 网关热配置：publicUrl（清空复位回环境变量推断，env 覆盖时给只读徽标）、
//      allowSignup、requireEmailVerification（未配 SMTP 时禁用并说明）、
//      sessionTtlDays（1..90）、新用户默认组；提交走 PATCH /admin/settings。
//   2. 发信服务（SMTP）：完整表单 + 「发送测试邮件」即时回执/脱敏错误；
//      密码只显示「已保存，留空保持不变」，显隐开关复用 LoginView 同款交互。
//   3. 管理接口密钥（Admin API Key）：生成/轮换后明文仅本次弹窗展示 + 一键复制，
//      平时只展示前缀与创建时间，吊销行走内两击确认。
//   4. 只读运行态说明区：监听端口 / UDP / 存储引擎 / 密钥来源（脱敏，绝无密码或路径）。
// 表单草稿全部本地 state；settings 引用变化（父级补拍）时重新播种，
// PATCH 成功后经 onSettingsChanged 用返回的脱敏视图整体替换。
import { useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

import { copyTextToClipboard } from '../clipboard';
import { ConsoleApiError } from '../store/console-store';
import type {
  AdminSettingsData,
  AdminSettingsPatch,
  AdminSmtpDraft,
  AdminTlsView,
  AdminUpdateView,
  ConsoleClient,
  GatewayRuntimeStatus,
  SmtpSecurity,
  UiLocalState,
  UserGroup,
} from '../store/console-store';
import { adminErrorToKey, readLocale } from './AdminView';
import type { LocaleKey, TranslateFn } from '../i18n/locales';
import { EyeIcon, EyeOffIcon } from './Icons';
import { Modal } from './Modal';
import { OneTimeSecret } from './AdminUsersGroups';

export interface AdminGatewaySettingsProps {
  t: TranslateFn;
  client: ConsoleClient;
  settings: AdminSettingsData;
  groups: UserGroup[];
  runtime: GatewayRuntimeStatus | null;
  tls: AdminTlsView | null;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  /** PATCH / 生成 / 吊销成功后：父级用返回的最新脱敏视图整体替换设置镜像 */
  onSettingsChanged: (next: AdminSettingsData) => void;
  /** TLS 启停 / 选证 / 上传 / 重载成功后：父级更新 TLS 状态切片 */
  onTlsChanged: (next: AdminTlsView) => void;
  /** 默认组可能被设置面板切换，补拍组列表同步用户组标签页 */
  onRefreshGroups: () => Promise<void>;
  /** publicUrl 热改后刷新页头运行态条（生效入口与来源标签立即跟随） */
  onRefreshRuntime: () => Promise<void>;
}

// ---------------------------------------------------------------- 区块 1：网关热配置

export function HotConfigForm(props: {
  t: TranslateFn;
  client: ConsoleClient;
  settings: AdminSettingsData;
  groups: UserGroup[];
  runtime: GatewayRuntimeStatus | null;
  onSettingsChanged: AdminGatewaySettingsProps['onSettingsChanged'];
  onRefreshGroups: AdminGatewaySettingsProps['onRefreshGroups'];
  onRefreshRuntime: AdminGatewaySettingsProps['onRefreshRuntime'];
}) {
  const { t, client, settings, groups, runtime, onSettingsChanged, onRefreshGroups, onRefreshRuntime } = props;
  const [publicUrlDraft, setPublicUrlDraft] = useState(settings.publicUrl ?? '');
  const [allowSignup, setAllowSignup] = useState(settings.allowSignup);
  const [requireVerification, setRequireVerification] = useState(settings.requireEmailVerification);
  const [defaultGroupId, setDefaultGroupId] = useState(settings.defaultGroupId);
  const [ttlDraft, setTtlDraft] = useState(String(settings.sessionTtlDays));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errorKey, setErrorKey] = useState<LocaleKey | null>(null);

  // settings 引用变化（进入视图 / PATCH 返回值落回）时重新播种全部草稿
  useEffect(() => {
    setPublicUrlDraft(settings.publicUrl ?? '');
    setAllowSignup(settings.allowSignup);
    setRequireVerification(settings.requireEmailVerification);
    setDefaultGroupId(settings.defaultGroupId);
    setTtlDraft(String(settings.sessionTtlDays));
  }, [settings]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    // 只提交真正变化的字段（服务端拒绝空补丁）
    const patch: AdminSettingsPatch = {};
    const trimmedUrl = publicUrlDraft.trim();
    if (trimmedUrl !== (settings.publicUrl ?? '')) patch['publicUrl'] = trimmedUrl === '' ? null : trimmedUrl;
    if (allowSignup !== settings.allowSignup) patch['allowSignup'] = allowSignup;
    if (requireVerification !== settings.requireEmailVerification) patch['requireEmailVerification'] = requireVerification;
    if (groups.some((g) => g.id === defaultGroupId) && defaultGroupId !== settings.defaultGroupId) {
      patch['defaultGroupId'] = defaultGroupId;
    }
    const ttl = Number(ttlDraft);
    if (Number.isInteger(ttl) && ttl !== settings.sessionTtlDays) patch['sessionTtlDays'] = ttl;
    if (Object.keys(patch).length === 0) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const updated = await client.updateAdminSettings(patch);
      onSettingsChanged(updated);
      void onRefreshRuntime();
      void onRefreshGroups();
      setSaved(true);
    } catch (err) {
      setErrorKey(adminErrorToKey(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        void submit(e);
      }}
    >
      <div className="modal-body">
        <div className="field">
          <label className="field-label" htmlFor="admin-public-url" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {t('admin.publicUrl')}
            {/* env 覆盖只读提示：当前生效值来自环境变量，控制台留空即回退该值 */}
            {settings.publicUrl === null && runtime?.publicUrlSource === 'env' && (
              <span className="badge">{t('admin.masterKeyFromEnv')}</span>
            )}
          </label>
          <input
            id="admin-public-url"
            className="input mono"
            type="url"
            spellCheck={false}
            autoCapitalize="none"
            placeholder="https://gw.example.com"
            value={publicUrlDraft}
            onChange={(e) => {
              setPublicUrlDraft(e.target.value);
              setSaved(false);
            }}
          />
          <p className="field-hint">{t('admin.publicUrlHint')}</p>
          {settings.publicUrl === null && runtime !== null && (
            <p className="field-hint">{t('admin.publicUrlFallback', { url: runtime.publicUrlEffective === '' ? '—' : runtime.publicUrlEffective })}</p>
          )}
        </div>

        <div className="setting-row">
          <span id="admin-allow-signup-label">{t('admin.allowSignup')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={allowSignup}
            aria-labelledby="admin-allow-signup-label"
            className={allowSignup ? 'switch on' : 'switch'}
            onClick={() => {
              setAllowSignup((v) => !v);
              setSaved(false);
            }}
          >
            <span className="switch-knob" aria-hidden="true" />
          </button>
        </div>

        <div className="setting-row">
          <span id="admin-require-verification-label">{t('admin.requireEmailVerification')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={requireVerification}
            aria-labelledby="admin-require-verification-label"
            className={requireVerification ? 'switch on' : 'switch'}
            disabled={!settings.smtp.configured}
            title={settings.smtp.configured ? undefined : t('admin.requireEmailVerificationNeedsSmtp')}
            onClick={() => {
              setRequireVerification((v) => !v);
              setSaved(false);
            }}
          >
            <span className="switch-knob" aria-hidden="true" />
          </button>
        </div>
        {!settings.smtp.configured && (
          <p className="field-hint" style={{ margin: '-8px 0 14px' }}>
            {t('admin.requireEmailVerificationNeedsSmtp')}
          </p>
        )}

        {groups.length > 0 && (
          <div className="field">
            <label className="field-label" htmlFor="admin-default-group">
              {t('admin.newUserDefaultGroup')}
            </label>
            <select
              id="admin-default-group"
              className="input"
              value={defaultGroupId}
              onChange={(e) => {
                setDefaultGroupId(e.target.value);
                setSaved(false);
              }}
            >
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
          <label className="field-label" htmlFor="admin-session-ttl">
            {t('admin.sessionTtlDays')}
          </label>
          <input
            id="admin-session-ttl"
            className="input input-narrow mono"
            type="number"
            required
            min={1}
            max={90}
            step={1}
            value={ttlDraft}
            onChange={(e) => {
              setTtlDraft(e.target.value);
              setSaved(false);
            }}
          />
        </div>

        {errorKey !== null && <p className="form-error">{t(errorKey)}</p>}
        <div className="modal-foot">
          {saved && errorKey === null && (
            <p className="form-status-ok" role="status">
              {t('toast.saved')}
            </p>
          )}
          <button type="submit" className="btn primary" disabled={busy}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- 区块 2：发信服务（SMTP）

function SmtpForm(props: {
  t: TranslateFn;
  client: ConsoleClient;
  settings: AdminSettingsData;
  onSettingsChanged: AdminGatewaySettingsProps['onSettingsChanged'];
}) {
  const { t, client, settings, onSettingsChanged } = props;
  const smtp = settings.smtp;
  const [host, setHost] = useState(smtp.host);
  const [portDraft, setPortDraft] = useState(smtp.port > 0 ? String(smtp.port) : '');
  const [security, setSecurity] = useState<SmtpSecurity>(smtp.security);
  const [username, setUsername] = useState(smtp.username);
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [fromAddress, setFromAddress] = useState(smtp.fromAddress);
  const [fromName, setFromName] = useState(smtp.fromName);
  const [rejectUnauthorized, setRejectUnauthorized] = useState(smtp.rejectUnauthorized);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errorKey, setErrorKey] = useState<LocaleKey | null>(null);

  useEffect(() => {
    setHost(smtp.host);
    setPortDraft(smtp.port > 0 ? String(smtp.port) : '');
    setSecurity(smtp.security);
    setUsername(smtp.username);
    setPassword('');
    setFromAddress(smtp.fromAddress);
    setFromName(smtp.fromName);
    setRejectUnauthorized(smtp.rejectUnauthorized);
  }, [smtp]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    // password 留空 = 沿用库中已存密码（后端回填），绝不回传原文
    const draft: AdminSmtpDraft = {
      host: host.trim(),
      port: Number(portDraft),
      security,
      fromAddress: fromAddress.trim(),
      rejectUnauthorized,
      ...(username.trim() !== '' ? { username: username.trim() } : {}),
      ...(password !== '' ? { password } : {}),
      ...(fromName.trim() !== '' ? { fromName: fromName.trim() } : {}),
    };
    setBusy(true);
    setErrorKey(null);
    try {
      const updated = await client.updateAdminSettings({ smtp: draft });
      onSettingsChanged(updated);
      setSaved(true);
    } catch (err) {
      setErrorKey(adminErrorToKey(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        void submit(e);
      }}
    >
      <div className="modal-body">
        <div className="field-grid">
          <div className="field">
            <label className="field-label" htmlFor="admin-smtp-host">
              {t('admin.smtpHost')}
            </label>
            <input
              id="admin-smtp-host"
              className="input mono"
              type="text"
              required
              spellCheck={false}
              autoCapitalize="none"
              placeholder="smtp.example.com"
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
                setSaved(false);
              }}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="admin-smtp-port">
              {t('admin.smtpPort')}
            </label>
            <input
              id="admin-smtp-port"
              className="input input-narrow mono"
              type="number"
              required
              min={1}
              max={65535}
              step={1}
              placeholder="587"
              value={portDraft}
              onChange={(e) => {
                setPortDraft(e.target.value);
                setSaved(false);
              }}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="admin-smtp-security">
              {t('admin.smtpEncryption')}
            </label>
            <select
              id="admin-smtp-security"
              className="input"
              value={security}
              onChange={(e) => {
                const value = e.target.value;
                if (value === 'tls' || value === 'starttls' || value === 'none') {
                  setSecurity(value);
                  setSaved(false);
                }
              }}
            >
              <option value="tls">{t('admin.smtpTls')}</option>
              <option value="starttls">{t('admin.smtpStartTls')}</option>
              <option value="none">{t('admin.smtpPlaintext')}</option>
            </select>
          </div>
        </div>

        <div className="field-grid">
          <div className="field">
            <label className="field-label" htmlFor="admin-smtp-username">
              {t('admin.smtpUser')}
            </label>
            <input
              id="admin-smtp-username"
              className="input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setSaved(false);
              }}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="admin-smtp-password">
              {t('admin.smtpPassword')}
            </label>
            <div style={{ position: 'relative' }}>
              <input
                id="admin-smtp-password"
                className="input"
                type={passwordVisible ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder={smtp.hasPassword ? t('admin.smtpPasswordKeep') : undefined}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setSaved(false);
                }}
                style={{ paddingRight: 36 }}
              />
              <button
                type="button"
                aria-pressed={passwordVisible}
                aria-label={passwordVisible ? t('auth.passwordHide') : t('auth.passwordShow')}
                title={passwordVisible ? t('auth.passwordHide') : t('auth.passwordShow')}
                onClick={() => setPasswordVisible((v) => !v)}
                style={{
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
                }}
              >
                {passwordVisible ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
            {smtp.hasPassword && <p className="field-hint">{t('admin.smtpPasswordKeep')}</p>}
          </div>
        </div>

        <div className="field-grid">
          <div className="field">
            <label className="field-label" htmlFor="admin-smtp-from">
              {t('admin.smtpFromEmail')}
            </label>
            <input
              id="admin-smtp-from"
              className="input mono"
              type="email"
              required
              spellCheck={false}
              autoCapitalize="none"
              placeholder="gateway@example.com"
              value={fromAddress}
              onChange={(e) => {
                setFromAddress(e.target.value);
                setSaved(false);
              }}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="admin-smtp-from-name">
              {t('admin.smtpFromName')}
            </label>
            <input
              id="admin-smtp-from-name"
              className="input"
              type="text"
              value={fromName}
              onChange={(e) => {
                setFromName(e.target.value);
                setSaved(false);
              }}
            />
          </div>
        </div>

        <div className="setting-row">
          <span id="admin-smtp-reject-label">
            {t('admin.smtpVerifyCert')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={rejectUnauthorized}
            aria-labelledby="admin-smtp-reject-label"
            className={rejectUnauthorized ? 'switch on' : 'switch'}
            onClick={() => {
              setRejectUnauthorized((v) => !v);
              setSaved(false);
            }}
          >
            <span className="switch-knob" aria-hidden="true" />
          </button>
        </div>

        {errorKey !== null && <p className="form-error">{t(errorKey)}</p>}
        <div className="modal-foot">
          {saved && errorKey === null && (
            <p className="form-status-ok" role="status">
              {t('toast.saved')}
            </p>
          )}
          <button type="submit" className="btn primary" disabled={busy}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </form>
  );
}

/** 「发送测试邮件」小表单：输入收件邮箱即时调 smtp-test，展示真实回执或脱敏错误 */
function SmtpTestForm(props: {
  t: TranslateFn;
  client: ConsoleClient;
  settings: AdminSettingsData;
}) {
  const { t, client, settings } = props;
  const locale = readLocale();
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | { ok: boolean; text: string }>(null);

  const send = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      await client.sendSmtpTest({ toEmail: to.trim(), locale });
      setResult({ ok: true, text: t('toast.smtpTestOk') });
    } catch (err) {
      // 脱敏错误：服务端只透出错误类别码（含在 message 括号里），绝不透出账号密码
      const message = err instanceof ConsoleApiError ? err.message : '';
      setResult({ ok: false, text: t('admin.smtpTestFailed', { message }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="smtp-test"
      onSubmit={(e) => {
        void send(e);
      }}
    >
      <div className="field" style={{ marginBottom: 10 }}>
        <label className="field-label" htmlFor="admin-smtp-test-to">
          {t('admin.smtpTestRecipient')}
        </label>
        <input
          id="admin-smtp-test-to"
          className="input"
          type="email"
          required
          spellCheck={false}
          autoCapitalize="none"
          placeholder={t('auth.emailPlaceholder')}
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setResult(null);
          }}
        />
      </div>
      {result !== null && (
        <p className={result.ok ? 'field-hint' : 'form-error'} style={{ margin: '0 0 10px' }} role="status">
          {result.text}
        </p>
      )}
      <button type="submit" className="btn" disabled={busy || settings.smtp.host === ''}>
        {t('admin.smtpTestSend')}
      </button>
      {settings.smtp.host === '' && (
        <p className="field-hint" style={{ margin: '6px 0 0' }}>
          {t('error.smtpNotConfigured')}
        </p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------- 区块 3：管理接口密钥（Admin API Key）

export function ApiKeySection(props: {
  t: TranslateFn;
  client: ConsoleClient;
  settings: AdminSettingsData;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  onSettingsChanged: AdminGatewaySettingsProps['onSettingsChanged'];
}) {
  const { t, client, settings, ui, onUi, onSettingsChanged } = props;
  const apiKey = settings.adminApiKey;
  const [revealed, setRevealed] = useState<null | { apiKey: string; prefix: string; createdAt: string }>(null);
  const [revokedNotice, setRevokedNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<LocaleKey | null>(null);

  const rotate = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setErrorKey(null);
    try {
      setRevealed(await client.rotateAdminApiKey());
    } catch (err) {
      setErrorKey(adminErrorToKey(err));
    } finally {
      setBusy(false);
    }
  };

  /** 关闭一次性展示后立即补拍设置视图：前缀与创建时间回到脱敏形态 */
  const closeReveal = (): void => {
    setRevealed(null);
    void client
      .getAdminSettings()
      .then((next) => onSettingsChanged(next))
      .catch(() => {
        /* 下次动作补拍 */
      });
  };

  const revokeTarget = 'revoke-api-key';
  const confirmingRevoke = ui.confirmTarget === revokeTarget;
  const runConfirm = (): void => {
    if (confirmingRevoke) {
      onUi({ confirmTarget: null });
      void (async () => {
        setBusy(true);
        setErrorKey(null);
        try {
          await client.revokeAdminApiKey();
          setRevokedNotice(true);
          onSettingsChanged(await client.getAdminSettings());
        } catch (err) {
          setErrorKey(adminErrorToKey(err));
        } finally {
          setBusy(false);
        }
      })();
    } else {
      onUi({ confirmTarget: revokeTarget });
    }
  };

  return (
    <div>
      <p className="section-title" style={{ margin: '0 0 6px' }}>
        {t('admin.apiKeyTitle')}
      </p>
      <p className="field-hint" style={{ margin: '0 0 12px' }}>
        {t('admin.apiKeyHint')}
      </p>

      <dl className="group-quota-list" style={{ marginBottom: 12 }}>
        <div>
          <dt>{t('admin.apiKeyPrefixLabel')}</dt>
          <dd className="mono">{apiKey.configured && apiKey.prefix !== null ? apiKey.prefix : '—'}</dd>
        </div>
        <div>
          <dt>{t('admin.apiKeyCreatedAt')}</dt>
          <dd className="mono">{apiKey.configured && apiKey.createdAt !== null ? apiKey.createdAt.slice(0, 10) : '—'}</dd>
        </div>
      </dl>

      {errorKey !== null && (
        <p className="form-error" role="alert">
          {t(errorKey)}
        </p>
      )}
      {revokedNotice && !apiKey.configured && (
        <p className="field-hint" style={{ margin: '0 0 10px' }} role="status">
          {t('admin.apiKeyRevoked')}
        </p>
      )}

      <div className="group-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={() => void rotate()}>
          {apiKey.configured ? t('admin.apiKeyRegenerate') : t('admin.apiKeyGenerate')}
        </button>
        {apiKey.configured && (
          <button
            type="button"
            data-confirm-trigger
            className={confirmingRevoke ? 'btn danger solid' : 'btn danger'}
            disabled={busy}
            onClick={runConfirm}
          >
            {confirmingRevoke ? t('common.confirmDelete') : t('admin.apiKeyRevoke')}
          </button>
        )}
      </div>

      {revealed !== null && (
        <Modal title={t('admin.apiKeyTitle')} onClose={closeReveal}>
          <OneTimeSecret
            label={t('admin.apiKeyTitle')}
            hint={t('admin.apiKeyOnce')}
            value={revealed.apiKey}
            copyLabel={t('common.copy')}
            copiedLabel={t('common.copied')}
            copiedHint={t('common.secretCopied')}
            copyFailedHint={t('common.secretCopyFailed')}
            doneLabel={t('common.done')}
            onDone={closeReveal}
          />
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 面板壳

function formatTlsDate(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  try {
    return new Intl.DateTimeFormat(readLocale() === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts));
  } catch {
    return iso;
  }
}

function tlsCertDaysLeft(validToIso: string): number {
  const ts = Date.parse(validToIso);
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, Math.ceil((ts - Date.now()) / 86_400_000));
}

function isSafeHttpsUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https:\/\/[^\s]+$/i.test(url);
}

/** 区块 2：原生单端口 TLS 与证书管理（状态卡片 / 目录选证与开关 / 上传粘贴 PEM） */
export function TlsCertSection(props: {
  t: TranslateFn;
  client: ConsoleClient;
  tls: AdminTlsView | null;
  onTlsChanged: AdminGatewaySettingsProps['onTlsChanged'];
}) {
  const { t, client, tls, onTlsChanged } = props;

  const [enabledDraft, setEnabledDraft] = useState(tls?.enabled ?? false);
  const [certFileDraft, setCertFileDraft] = useState(tls?.certFile ?? 'fullchain.pem');
  const [keyFileDraft, setKeyFileDraft] = useState(tls?.keyFile ?? 'privkey.pem');
  const [selectBusy, setSelectBusy] = useState(false);
  const [reloadBusy, setReloadBusy] = useState(false);
  const [selectErrorKey, setSelectErrorKey] = useState<LocaleKey | null>(null);
  const [selectStatusText, setSelectStatusText] = useState<string | null>(null);

  const [certPem, setCertPem] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadErrorKey, setUploadErrorKey] = useState<LocaleKey | null>(null);
  const [uploadStatusText, setUploadStatusText] = useState<string | null>(null);

  const [suggestedHttpsUrl, setSuggestedHttpsUrl] = useState<string | null>(null);

  useEffect(() => {
    if (tls === null) return;
    setEnabledDraft(tls.enabled);
    setCertFileDraft(tls.certFile);
    setKeyFileDraft(tls.keyFile);
  }, [tls]);

  if (tls === null) {
    return (
      <div>
        <p className="section-title" style={{ margin: '0 0 8px' }}>
          {t('admin.tlsSectionTitle')}
        </p>
        <p className="field-hint">{t('app.loading')}</p>
      </div>
    );
  }

  const certOptions = Array.from(
    new Set([
      ...(certFileDraft !== '' ? [certFileDraft] : []),
      ...tls.availableFiles.filter((f) => f.kind === 'cert').map((f) => f.name),
    ]),
  );
  const keyOptions = Array.from(
    new Set([
      ...(keyFileDraft !== '' ? [keyFileDraft] : []),
      ...tls.availableFiles.filter((f) => f.kind === 'key').map((f) => f.name),
    ]),
  );

  const maybeTrackHttpsRedirect = (nextUrl: string | null | undefined, nextActive: boolean): void => {
    if (isSafeHttpsUrl(nextUrl) && (typeof window === 'undefined' || window.location.protocol === 'http:')) {
      setSuggestedHttpsUrl(nextUrl);
    } else if (!nextActive) {
      setSuggestedHttpsUrl(null);
    }
  };

  const submitSelect = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (selectBusy || reloadBusy) return;
    setSelectBusy(true);
    setSelectErrorKey(null);
    setSelectStatusText(null);
    try {
      const updated = await client.updateAdminTls({
        enabled: enabledDraft,
        certFile: certFileDraft,
        keyFile: keyFileDraft,
      });
      onTlsChanged(updated);
      maybeTrackHttpsRedirect(updated.suggestedHttpsUrl, updated.tlsActive);
      setSelectStatusText(t('admin.tlsSavedToast'));
    } catch (err) {
      setSelectErrorKey(adminErrorToKey(err));
    } finally {
      setSelectBusy(false);
    }
  };

  const handleReloadNow = async (): Promise<void> => {
    if (reloadBusy || selectBusy) return;
    setReloadBusy(true);
    setSelectErrorKey(null);
    setSelectStatusText(null);
    try {
      const updated = await client.reloadAdminTls();
      onTlsChanged(updated);
      setSelectStatusText(t('admin.tlsReloadedToast'));
    } catch (err) {
      setSelectErrorKey(adminErrorToKey(err));
    } finally {
      setReloadBusy(false);
    }
  };

  const handlePickPemFile = (target: 'cert' | 'key') => async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    try {
      const text = await file.text();
      if (target === 'cert') setCertPem(text);
      else setKeyPem(text);
      setUploadErrorKey(null);
      setUploadStatusText(null);
    } finally {
      event.target.value = '';
    }
  };

  const submitUpload = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (uploadBusy) return;
    const submitter = (event.nativeEvent as SubmitEvent | undefined)?.submitter;
    const enableTls = submitter instanceof HTMLButtonElement && submitter.dataset['enableTls'] === 'true';
    setUploadBusy(true);
    setUploadErrorKey(null);
    setUploadStatusText(null);
    try {
      const updated = await client.uploadAdminTlsCertificate({
        certPem,
        keyPem,
        certFile: certFileDraft || 'fullchain.pem',
        keyFile: keyFileDraft || 'privkey.pem',
        enableTls,
      });
      onTlsChanged(updated);
      maybeTrackHttpsRedirect(updated.suggestedHttpsUrl, updated.tlsActive);
      setUploadStatusText(t('admin.tlsSavedToast'));
      setCertPem('');
      setKeyPem('');
    } catch (err) {
      setUploadErrorKey(adminErrorToKey(err));
    } finally {
      setUploadBusy(false);
    }
  };

  const cert = tls.activeCert;
  const daysLeft = cert !== null ? tlsCertDaysLeft(cert.validTo) : 0;
  const reloadErrorText =
    tls.lastReloadError === null
      ? null
      : `${t(adminErrorToKey(new ConsoleApiError(400, tls.lastReloadError.code, tls.lastReloadError.message)))} (${tls.lastReloadError.code})`;

  return (
    <div>
      <div className="tls-status-head">
        <p className="section-title" style={{ margin: 0 }}>
          {t('admin.tlsSectionTitle')}
        </p>
        <span className="admin-status-pill">
          <span className={tls.tlsActive ? 'dot ok' : 'dot muted'} aria-hidden="true" />
          {t(tls.tlsActive ? 'admin.tlsStateOn' : 'admin.tlsStateOff')}
        </span>
      </div>
      <p className="field-hint">{t('admin.tlsSectionDesc')}</p>
      <p className="field-hint">{t(tls.certDirWritable ? 'admin.tlsMountDirHint' : 'admin.tlsDirReadonlyHint')}</p>

      {isSafeHttpsUrl(suggestedHttpsUrl) && (
        <div className="tls-https-cta" role="status">
          <p>{t('admin.tlsSwitchHttpsBanner')}</p>
          <a className="btn primary" href={suggestedHttpsUrl}>
            {t('admin.tlsSwitchHttpsCta')}
          </a>
        </div>
      )}

      <div className="tls-status-card">
        <p className="field-label" style={{ margin: 0 }}>
          {t('admin.tlsActiveCert')}
        </p>
        {cert === null ? (
          <p className="field-hint" style={{ marginTop: 6 }}>
            {t('admin.tlsNoActiveCert')}
          </p>
        ) : (
          <dl className="tls-meta-grid">
            <div>
              <dt>{t('admin.tlsDomains')}</dt>
              <dd className="mono">{cert.san.length > 0 ? cert.san.join(', ') : cert.subject || '—'}</dd>
            </div>
            <div>
              <dt>{t('admin.tlsIssuer')}</dt>
              <dd>{cert.issuer || '—'}</dd>
            </div>
            <div>
              <dt>{t('admin.tlsValidUntil')}</dt>
              <dd>
                <span className="mono">{formatTlsDate(cert.validTo)}</span>
                <span className="tls-cert-badges">
                  {!cert.expired && <span>{t('admin.tlsDaysLeft', { n: daysLeft })}</span>}
                  {cert.expired && <span className="badge danger">{t('admin.tlsExpiredBadge')}</span>}
                  {!cert.expired && cert.expiringSoon && <span className="badge">{t('admin.tlsExpiringSoonBadge')}</span>}
                </span>
              </dd>
            </div>
            <div>
              <dt>{t('admin.tlsFingerprint')}</dt>
              <dd className="mono">{cert.fingerprint256}</dd>
            </div>
          </dl>
        )}
        <dl className="tls-meta-grid">
          <div>
            <dt>{t('admin.tlsCertFileLabel')}</dt>
            <dd className="mono">{tls.certFile}</dd>
          </div>
          <div>
            <dt>{t('admin.tlsKeyFileLabel')}</dt>
            <dd className="mono">{tls.keyFile}</dd>
          </div>
          <div>
            <dt>{t('admin.tlsLastReload')}</dt>
            <dd className="mono">{tls.lastReloadAt !== null ? formatTlsDate(tls.lastReloadAt) : '—'}</dd>
          </div>
        </dl>
        {reloadErrorText !== null && (
          <p className="form-error" role="status">
            {t('admin.tlsReloadErrorLabel')}: {reloadErrorText}
          </p>
        )}
      </div>

      <form
        aria-labelledby="tls-select-form-title"
        onSubmit={(e) => {
          void submitSelect(e);
        }}
      >
        <h3 className="tls-sub-title" id="tls-select-form-title">
          {t('admin.tlsSelectFormTitle')}
        </h3>
        <div className="setting-row">
          <span id="admin-tls-enable-label">{t('admin.tlsEnableLabel')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabledDraft}
            aria-labelledby="admin-tls-enable-label"
            className={enabledDraft ? 'switch on' : 'switch'}
            onClick={() => {
              setEnabledDraft((v) => !v);
              setSelectStatusText(null);
            }}
          >
            <span className="switch-knob" aria-hidden="true" />
          </button>
        </div>

        <div className="field-grid">
          <div className="field">
            <label className="field-label" htmlFor="admin-tls-cert-select">
              {t('admin.tlsCertFileLabel')}
            </label>
            <select
              id="admin-tls-cert-select"
              className="input mono"
              value={certFileDraft}
              onChange={(e) => {
                setCertFileDraft(e.target.value);
                setSelectStatusText(null);
              }}
            >
              {certOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="admin-tls-key-select">
              {t('admin.tlsKeyFileLabel')}
            </label>
            <select
              id="admin-tls-key-select"
              className="input mono"
              value={keyFileDraft}
              onChange={(e) => {
                setKeyFileDraft(e.target.value);
                setSelectStatusText(null);
              }}
            >
              {keyOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {tls.availableFiles.length === 0 && <p className="field-hint">{t('admin.tlsNoFilesHint')}</p>}
        {selectErrorKey !== null && <p className="form-error">{t(selectErrorKey)}</p>}
        <div className="tls-actions-row">
          {selectStatusText !== null && selectErrorKey === null && (
            <p className="form-status-ok" role="status">
              {selectStatusText}
            </p>
          )}
          <button type="button" className="btn" disabled={reloadBusy || selectBusy} onClick={() => void handleReloadNow()}>
            {t('admin.tlsReloadNowButton')}
          </button>
          <button type="submit" className="btn primary" disabled={selectBusy || reloadBusy}>
            {t('admin.tlsApplySwitchButton')}
          </button>
        </div>
      </form>

      <div className="menu-sep" style={{ margin: '16px 0 14px' }} aria-hidden="true" />

      <form
        aria-labelledby="tls-upload-form-title"
        onSubmit={(e) => {
          void submitUpload(e);
        }}
      >
        <h3 className="tls-sub-title" id="tls-upload-form-title" style={{ marginTop: 0 }}>
          {t('admin.tlsUploadFormTitle')}
        </h3>
        <p className="field-hint" style={{ marginBottom: 10 }}>
          {t('admin.tlsUploadFileHint')}
        </p>
        <div className="field-grid">
          <div className="field">
            <label className="field-label" htmlFor="admin-tls-cert-file-input">
              {t('admin.tlsPickCertFile')}
            </label>
            <input
              id="admin-tls-cert-file-input"
              className="tls-file-input"
              type="file"
              accept=".pem,.crt,.cer,.key"
              disabled={uploadBusy}
              onChange={(e) => {
                void handlePickPemFile('cert')(e);
              }}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="admin-tls-key-file-input">
              {t('admin.tlsPickKeyFile')}
            </label>
            <input
              id="admin-tls-key-file-input"
              className="tls-file-input"
              type="file"
              accept=".pem,.crt,.cer,.key"
              disabled={uploadBusy}
              onChange={(e) => {
                void handlePickPemFile('key')(e);
              }}
            />
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="admin-tls-cert-pem">
            {t('admin.tlsCertPemLabel')}
          </label>
          <textarea
            id="admin-tls-cert-pem"
            className="input tls-pem-input mono"
            rows={5}
            required
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder={'-----BEGIN CERTIFICATE-----\n...'}
            value={certPem}
            onChange={(e) => {
              setCertPem(e.target.value);
              setUploadStatusText(null);
            }}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="admin-tls-key-pem">
            {t('admin.tlsKeyPemLabel')}
          </label>
          <textarea
            id="admin-tls-key-pem"
            className="input tls-pem-input mono"
            rows={5}
            required
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder={'-----BEGIN PRIVATE KEY-----\n...'}
            value={keyPem}
            onChange={(e) => {
              setKeyPem(e.target.value);
              setUploadStatusText(null);
            }}
          />
        </div>

        {uploadErrorKey !== null && <p className="form-error">{t(uploadErrorKey)}</p>}
        <div className="tls-actions-row">
          {uploadStatusText !== null && uploadErrorKey === null && (
            <p className="form-status-ok" role="status">
              {uploadStatusText}
            </p>
          )}
          <button
            type="submit"
            className="btn"
            data-enable-tls="false"
            disabled={uploadBusy}
          >
            {t('admin.tlsUploadSaveButton')}
          </button>
          <button
            type="submit"
            className="btn primary"
            data-enable-tls="true"
            disabled={uploadBusy}
          >
            {t('admin.tlsUploadEnableButton')}
          </button>
        </div>
      </form>
    </div>
  );
}

export function SmtpSettingsSection(props: {
  t: TranslateFn;
  client: ConsoleClient;
  settings: AdminSettingsData;
  onSettingsChanged: AdminGatewaySettingsProps['onSettingsChanged'];
}) {
  const { t, client, settings, onSettingsChanged } = props;
  return (
    <div>
      <p className="section-title" style={{ margin: '0 0 10px' }}>
        {t('admin.smtpTitle')}
      </p>
      <SmtpForm t={t} client={client} settings={settings} onSettingsChanged={onSettingsChanged} />
      <div className="menu-sep" style={{ margin: '16px 0 14px' }} aria-hidden="true" />
      <SmtpTestForm t={t} client={client} settings={settings} />
    </div>
  );
}

export function UpdateSettingsSection(props: {
  t: TranslateFn;
  client: ConsoleClient;
  settings: AdminSettingsData;
  runtime: GatewayRuntimeStatus | null;
  updateView: AdminUpdateView | null;
  applyingUpdate: boolean;
  restartingVersion: string | null;
  onUpdateViewChanged: (next: AdminUpdateView) => void;
  onSettingsChanged: AdminGatewaySettingsProps['onSettingsChanged'];
  onApplyUpdate: () => Promise<void>;
}) {
  const {
    t,
    client,
    settings,
    runtime,
    updateView,
    applyingUpdate,
    restartingVersion,
    onUpdateViewChanged,
    onSettingsChanged,
    onApplyUpdate,
  } = props;
  const [checking, setChecking] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const summary = updateView ?? runtime?.update ?? null;
  const upgradeCommand = updateView?.upgradeCommand ?? 'docker compose pull && docker compose up -d';

  const handleToggleAutoUpdate = async (): Promise<void> => {
    if (toggleBusy) return;
    setToggleBusy(true);
    setErrorText(null);
    try {
      const nextSettings = await client.updateAdminSettings({
        autoUpdateEnabled: !settings.autoUpdateEnabled,
      });
      onSettingsChanged(nextSettings);
      const refreshed = await client.getAdminUpdate().catch(() => null);
      if (refreshed !== null) onUpdateViewChanged(refreshed);
    } catch (err) {
      setErrorText(t(adminErrorToKey(err)));
    } finally {
      setToggleBusy(false);
    }
  };

  const handleCheckNow = async (): Promise<void> => {
    if (checking) return;
    setChecking(true);
    setErrorText(null);
    try {
      const nextView = await client.checkAdminUpdate();
      onUpdateViewChanged(nextView);
    } catch (err) {
      setErrorText(err instanceof ConsoleApiError ? err.message : t('error.network'));
    } finally {
      setChecking(false);
    }
  };

  const handleCopyCommand = async (): Promise<void> => {
    if (await copyTextToClipboard(upgradeCommand)) {
      setCopiedCommand(true);
      setTimeout(() => setCopiedCommand(false), 1800);
    }
  };

  const currentVersionLabel = summary?.currentVersion ? `v${summary.currentVersion}` : '—';
  const baseVersionLabel = summary?.baseVersion ? `v${summary.baseVersion}` : '—';
  const sourceLabel =
    summary?.activeSource === 'hot-update' ? t('admin.updateSourceHot') : t('admin.updateSourceBase');
  const canHotApply =
    summary !== null &&
    summary.updateAvailable &&
    summary.compatibility === 'compatible' &&
    summary.supervisorManaged;
  const needsPull =
    summary !== null &&
    summary.updateAvailable &&
    (summary.compatibility !== 'compatible' || !summary.supervisorManaged);

  return (
    <div>
      <p className="section-title" style={{ margin: '0 0 10px' }}>
        {t('admin.updateSectionTitle')}
      </p>
      <div className="setting-form">
        <dl className="meta-grid update-meta-grid">
          <div className="meta-item">
            <dt>{t('admin.updateCurrentVersion')}</dt>
            <dd className="mono">{currentVersionLabel}</dd>
          </div>
          <div className="meta-item">
            <dt>{t('admin.updateBaseVersion')}</dt>
            <dd className="mono">{baseVersionLabel}</dd>
          </div>
          <div className="meta-item">
            <dt>{t('admin.updateSourceLabel')}</dt>
            <dd>{sourceLabel}</dd>
          </div>
          <div className="meta-item">
            <dt>{t('admin.updateSupervisorLabel')}</dt>
            <dd>{summary?.supervisorManaged ? t('admin.updateSupervisorOn') : t('admin.updateSupervisorOff')}</dd>
          </div>
        </dl>

        <div className="setting-row">
          <div>
            <span id="admin-auto-update-label">{t('admin.updateAutoToggle')}</span>
            <p className="field-hint">{t('admin.updateAutoToggleHint')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.autoUpdateEnabled}
            aria-labelledby="admin-auto-update-label"
            className={settings.autoUpdateEnabled ? 'switch on' : 'switch'}
            disabled={toggleBusy}
            onClick={() => {
              void handleToggleAutoUpdate();
            }}
          >
            <span className="switch-knob" aria-hidden="true" />
          </button>
        </div>

        <div className="update-actions-row">
          <button
            type="button"
            className="btn"
            disabled={checking || applyingUpdate || restartingVersion !== null}
            onClick={() => {
              void handleCheckNow();
            }}
          >
            {checking ? t('admin.updateChecking') : t('admin.updateCheckNowButton')}
          </button>
          {canHotApply && (
            <button
              type="button"
              className="btn primary"
              disabled={applyingUpdate || restartingVersion !== null}
              onClick={() => {
                void onApplyUpdate();
              }}
            >
              {applyingUpdate ? t('admin.updateApplying') : t('admin.updateNowButton')}
            </button>
          )}
          <span className="field-hint">
            {t('admin.updateLastChecked')}:{' '}
            {updateView?.lastCheckedAt
              ? new Intl.DateTimeFormat(
                  document.documentElement.lang || (readLocale() === 'zh' ? 'zh-CN' : 'en-US'),
                  { dateStyle: 'medium', timeStyle: 'short' },
                ).format(new Date(updateView.lastCheckedAt))
              : t('admin.updateNeverChecked')}
          </span>
        </div>

        {updateView?.lastCheckError && (
          <p className="form-error">{t('admin.updateCheckFailed', { reason: updateView.lastCheckError })}</p>
        )}
        {errorText !== null && <p className="form-error">{errorText}</p>}

        {summary !== null && !summary.updateAvailable && updateView?.lastCheckedAt && !updateView.lastCheckError && (
          <p className="form-status-ok" role="status">
            {t('admin.updateUpToDate')}
          </p>
        )}

        {summary?.offlinePeerRecommendedVersion && (
          <p className="field-hint">
            {t('admin.updateOfflinePeerHint', { version: `v${summary.offlinePeerRecommendedVersion}` })}
          </p>
        )}

        {updateView?.notesSummary && (
          <div className="update-notes-box">
            <span className="field-label">{t('admin.updateNotesLabel')}</span>
            <p className="field-hint" style={{ whiteSpace: 'pre-line' }}>
              {updateView.notesSummary}
            </p>
          </div>
        )}

        {needsPull && (
          <div className="update-command-box">
            <p className="field-hint">
              {t('admin.updateBannerPullRequired', { version: `v${summary.latestVersion ?? ''}` })}
            </p>
            <div className="invite-box">
              <code className="invite-key mono">{upgradeCommand}</code>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void handleCopyCommand();
                }}
              >
                {copiedCommand ? t('admin.updateCommandCopied') : t('admin.updateCopyCommand')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
