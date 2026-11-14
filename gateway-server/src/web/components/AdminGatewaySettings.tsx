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
import type { FormEvent } from 'react';

import { ConsoleApiError } from '../store/console-store';
import type {
  AdminSettingsData,
  AdminSettingsPatch,
  AdminSmtpDraft,
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
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  /** PATCH / 生成 / 吊销成功后：父级用返回的最新脱敏视图整体替换设置镜像 */
  onSettingsChanged: (next: AdminSettingsData) => void;
  /** 默认组可能被设置面板切换，补拍组列表同步用户组标签页 */
  onRefreshGroups: () => Promise<void>;
  /** publicUrl 热改后刷新页头运行态条（生效入口与来源标签立即跟随） */
  onRefreshRuntime: () => Promise<void>;
}

// ---------------------------------------------------------------- 区块 1：网关热配置

function HotConfigForm(props: {
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
            <p className="field-hint" style={{ margin: '0 auto 0 0', alignSelf: 'center' }}>
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
          <span id="admin-smtp-reject-label" className="mono">
            rejectUnauthorized
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
            <p className="field-hint" style={{ margin: '0 auto 0 0', alignSelf: 'center' }}>
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

function ApiKeySection(props: {
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
            doneLabel={t('common.done')}
            onDone={closeReveal}
          />
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 区块 4：只读运行态说明区

function EnvReadonlyStrip(props: { t: TranslateFn; runtime: GatewayRuntimeStatus | null }) {
  const { t, runtime } = props;
  const udpText = (() => {
    if (runtime === null || runtime.udpPort === 0) return '—';
    return runtime.udpAltPort > 0 ? `${runtime.udpPort} / ${runtime.udpAltPort}` : `${runtime.udpPort}`;
  })();
  const items: Array<{ label: string; value: string }> = [
    { label: t('admin.runtimeTcpPort'), value: runtime === null ? '—' : `:${runtime.listenPort}` },
    { label: t('admin.runtimeUdpPorts'), value: udpText },
    {
      label: t('admin.runtimeStorage'),
      value: runtime === null ? '—' : runtime.storageDriver === 'sqlite' ? 'SQLite WAL' : 'PostgreSQL',
    },
    {
      label: t('admin.runtimeMasterKey'),
      value:
        runtime === null
          ? '—'
          : runtime.secretSource === 'env'
            ? t('admin.masterKeyFromEnv')
            : t('admin.masterKeyFromFile'),
    },
  ];
  return (
    <dl className="runtime-strip compact">
      {items.map((item) => (
        <div className="runtime-item" key={item.label}>
          <dt>{item.label}</dt>
          <dd className="mono">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- 面板壳

export function AdminGatewaySettings(props: AdminGatewaySettingsProps) {
  const { t, client, settings, groups, runtime, ui, onUi, onSettingsChanged, onRefreshGroups, onRefreshRuntime } = props;
  return (
    <div className="settings-stack">
      <section className="settings-section">
        <HotConfigForm
          t={t}
          client={client}
          settings={settings}
          groups={groups}
          runtime={runtime}
          onSettingsChanged={onSettingsChanged}
          onRefreshGroups={onRefreshGroups}
          onRefreshRuntime={onRefreshRuntime}
        />
      </section>

      <section className="settings-section">
        <p className="section-title" style={{ margin: '0 0 10px' }}>
          {t('admin.smtpTitle')}
        </p>
        <SmtpForm t={t} client={client} settings={settings} onSettingsChanged={onSettingsChanged} />
        <div className="menu-sep" style={{ margin: '16px 0 14px' }} aria-hidden="true" />
        <SmtpTestForm t={t} client={client} settings={settings} />
      </section>

      <section className="settings-section">
        <ApiKeySection t={t} client={client} settings={settings} ui={ui} onUi={onUi} onSettingsChanged={onSettingsChanged} />
      </section>

      <section className="settings-section">
        <EnvReadonlyStrip t={t} runtime={runtime} />
      </section>
    </div>
  );
}
