// 网关管理页（GC-10 重构）：页头只读运行态条 + 条件安全告警横幅 +
// 「用户管理 / 用户组 / 网关与发信设置」三标签页工作台。
//
// 数据面（GC-10b 收口）：runtime / settings / groups / users 四张管理切片全部
// 由 App.tsx 统一持有并经 props 注入（进入视图拉取 + 3 秒可见性受控轮询 +
// 面板动作后的补拍都写回 store），本页不再自建 ConsoleClient、不再维护本地
// 影子状态与自己的 ManagedRefreshCycle——App 是唯一请求源，杜绝双客户端
// 各拉各的。面板内的增删改走注入的同一客户端，成功后经 onRefresh* 回调由
// App 补拍对应切片。
//
// 安全红线：安全告警只有非阻塞的 warn-tint 提示横幅，绝不提供
// 「允许不安全连接」开关；运行态展示全部来自 /admin/runtime 的脱敏视图。
import { useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { formatBytes, formatRate } from '../format';
import { LOCALE_STORAGE_KEY, resolveLocale } from '../i18n/locales';
import type { Locale, LocaleKey, TranslateFn } from '../i18n/locales';
import { ConsoleApiError, ConsoleClient } from '../store/console-store';
import type {
  AdminSettingsData,
  AdminSliceKey,
  AdminUserRow,
  GatewayRuntimeStatus,
  SecurityWarning,
  SliceLoadPhase,
  SystemSettings,
  UiLocalState,
  UserGroup,
} from '../store/console-store';
import { AdminGatewaySettings } from './AdminGatewaySettings';
import { AdminUsersGroups } from './AdminUsersGroups';
import { AlertIcon } from './Icons';

export interface AdminViewProps {
  t: TranslateFn;
  /** 控制台客户端（GC-10b 起由 App 注入同一实例，本页不再自建第二请求源） */
  client: ConsoleClient;
  /** 只读运行态（App 3 秒轮询切片）；未拉到前是 null */
  runtime: GatewayRuntimeStatus | null;
  /** 脱敏设置视图（GC-6b 扩展形态，App 进视图拉取 + PATCH 返回值落库）；未拉到前是 null */
  settings: AdminSettingsData | null;
  /** 用户组列表（App 进视图拉取，组 CRUD / 默认组切换后补拍） */
  groups: UserGroup[];
  users: AdminUserRow[];
  /** 四张管理切片各自的加载阶段与末次错误（GC-10b：App 统一持有） */
  adminLoad: Readonly<Record<AdminSliceKey, SliceLoadPhase>>;
  adminError: Readonly<Record<AdminSliceKey, string | null>>;
  currentUserId: string;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  /** 兼容保留（App 接线）：旧四键设置 PATCH 通道；GC-10 起设置面板走本页完整视图 PATCH */
  onPatchSettings: (patch: Partial<SystemSettings>) => void;
  /** 用户启停：仍走 App 的实现（PATCH 后立即刷新 store 用户切片） */
  onSetUserActive: (userId: string, active: boolean) => void;
  /** 面板变更用户后立即补拍用户列表（App 写回 store 用户切片） */
  onRefreshUsers: () => Promise<void>;
  /** 组 CRUD / 默认组切换后立即补拍组列表 */
  onRefreshGroups: () => Promise<void>;
  /** publicUrl 热改后刷新页头运行态条（生效入口与来源标签立即跟随） */
  onRefreshRuntime: () => Promise<void>;
  /** 设置 PATCH / 密钥操作成功：App 用返回的最新脱敏视图整体替换设置切片 */
  onSettingsChanged: (next: AdminSettingsData) => void;
}

/** 浏览器侧读取当前界面语言（formatQuotaExpiry / formatBytesQuota 的入参）；与 Modal.resolveCloseLabel 同源 */
export function readLocale(): Locale {
  try {
    return resolveLocale(localStorage.getItem(LOCALE_STORAGE_KEY), navigator.language);
  } catch {
    return 'zh';
  }
}

/** 管理端接口错误码 → 词典键：自我保护与最后管理员共用一条温和文案 */
export function adminErrorToKey(err: unknown): LocaleKey {
  const code = err instanceof ConsoleApiError ? err.code : '';
  switch (code) {
    case 'CANNOT_REMOVE_LAST_ADMIN':
    case 'CANNOT_DISABLE_SELF':
    case 'CANNOT_DEMOTE_SELF':
    case 'CANNOT_DELETE_SELF':
      return 'error.cannotRemoveLastAdmin';
    case 'CANNOT_DELETE_DEFAULT_GROUP':
    case 'CANNOT_UNSET_DEFAULT_GROUP':
      return 'error.cannotDeleteDefaultGroup';
    case 'GROUP_IN_USE':
      return 'error.groupInUse';
    case 'DUPLICATE_GROUP_CODE':
      return 'error.duplicateGroupCode';
    case 'EMAIL_TAKEN':
      return 'error.emailTaken';
    case 'PEER_LIMIT_EXCEEDED_BY_GROUP':
      return 'error.peerLimitByGroup';
    case 'INVALID_API_KEY':
      return 'error.invalidApiKey';
    case 'SMTP_NOT_CONFIGURED':
      return 'error.smtpNotConfigured';
    case 'SMTP_SEND_FAILED':
      return 'error.smtpSendFailed';
    case 'NETWORK_ERROR':
    case 'NO_TRANSPORT':
      return 'error.network';
    default:
      return 'error.generic';
  }
}

// ---------------------------------------------------------------- 运行态与概览仪表盘

/** 存储引擎的展示名（脱敏：只有引擎名，绝无连接串） */
function storageLabel(driver: 'sqlite' | 'postgres'): string {
  return driver === 'sqlite' ? 'SQLite WAL' : 'PostgreSQL';
}

/** 公网入口来源本地化文案 */
function publicUrlSourceText(source: GatewayRuntimeStatus['publicUrlSource'], t: TranslateFn): string {
  switch (source) {
    case 'env':
      return t('admin.sourceEnv');
    case 'settings':
      return t('admin.sourceSettings');
    case 'request':
      return t('admin.sourceRequest');
    default:
      return String(source);
  }
}

/**
 * 管理端概览仪表盘：
 * 1) 页头标题 + 公开注册 / 邮件发送实时状态徽章
 * 2) 4 张核心 KPI 指标卡（在线设备 / 实时中转 / 累计中转 / 账号概况）
 * 3) 只读技术参数细条（TCP 端口 / 生效公网入口 / UDP 端口 / 存储引擎 / 主密钥来源）
 * runtime 未拉到前整条显示占位破折号，不阻塞标签页渲染。
 */
export function RuntimeStrip(props: {
  t: TranslateFn;
  runtime: GatewayRuntimeStatus | null;
  title?: string;
  usersCount?: number;
  groupsCount?: number;
  allowSignup?: boolean;
  smtpConfigured?: boolean;
}) {
  const { t, runtime, title, usersCount, groupsCount, allowSignup, smtpConfigured } = props;
  const udpText = (() => {
    if (runtime === null || runtime.udpPort === 0) return '—';
    return runtime.udpAltPort > 0 ? `${runtime.udpPort} / ${runtime.udpAltPort}` : `${runtime.udpPort}`;
  })();

  const kpis: Array<{ label: string; value: string; sub?: string; mono?: boolean; accent?: boolean }> = [
    {
      label: t('summary.onlineDevices'),
      value: runtime === null ? '—' : String(runtime.onlineDevices),
      mono: true,
      accent: runtime !== null && runtime.onlineDevices > 0,
    },
    {
      label: t('admin.runtimeRelayRate'),
      value: runtime === null ? '—' : formatRate(runtime.totalLiveRelayKbps),
      mono: true,
    },
    {
      label: t('devices.totalRelay'),
      value: runtime === null ? '—' : formatBytes(runtime.cumulativeRelayBytes),
      mono: true,
    },
    {
      label: t('admin.kpiAccounts'),
      value: usersCount === undefined ? '—' : String(usersCount),
      sub:
        usersCount !== undefined && groupsCount !== undefined
          ? t('admin.kpiAccountsSub', { users: usersCount, groups: groupsCount })
          : undefined,
      mono: true,
    },
  ];

  const metaItems: Array<{ label: string; value: string; source?: string; mono?: boolean }> = [
    { label: t('admin.runtimeTcpPort'), value: runtime === null ? '—' : `:${runtime.listenPort}`, mono: true },
    {
      label: t('admin.publicUrl'),
      value: runtime === null || runtime.publicUrlEffective === '' ? '—' : runtime.publicUrlEffective,
      source: runtime === null ? undefined : publicUrlSourceText(runtime.publicUrlSource, t),
      mono: true,
    },
    { label: t('admin.runtimeUdpPorts'), value: udpText, mono: true },
    { label: t('admin.runtimeStorage'), value: runtime === null ? '—' : storageLabel(runtime.storageDriver) },
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

  const showHeadBar = title !== undefined || allowSignup !== undefined || smtpConfigured !== undefined;

  return (
    <section className="admin-overview" aria-label={title ?? t('view.admin')}>
      {showHeadBar && (
        <div className="admin-head-bar">
          {title !== undefined && <h2 className="page-title">{title}</h2>}
          {(allowSignup !== undefined || smtpConfigured !== undefined) && (
            <div className="admin-head-badges">
              {allowSignup !== undefined && (
                <span className="admin-status-pill">
                  <span className={allowSignup ? 'dot ok' : 'dot muted'} aria-hidden="true" />
                  {t(allowSignup ? 'admin.signupOpen' : 'admin.signupInviteOnly')}
                </span>
              )}
              {smtpConfigured !== undefined && (
                <span className="admin-status-pill">
                  <span className={smtpConfigured ? 'dot ok' : 'dot muted'} aria-hidden="true" />
                  {t(smtpConfigured ? 'admin.smtpConfiguredTag' : 'admin.smtpUnconfiguredTag')}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="admin-kpi-grid">
        {kpis.map((kpi) => (
          <div className="admin-kpi-card" key={kpi.label}>
            <div className="admin-kpi-label">{kpi.label}</div>
            <div className={kpi.mono ? 'admin-kpi-value mono' : 'admin-kpi-value'}>
              {kpi.accent && <span className="dot ok" aria-hidden="true" />}
              <span>{kpi.value}</span>
            </div>
            {kpi.sub !== undefined && <div className="admin-kpi-sub">{kpi.sub}</div>}
          </div>
        ))}
      </div>

      <dl className="admin-meta-strip">
        {metaItems.map((item) => (
          <div className="runtime-item" key={item.label}>
            <dt>{item.label}</dt>
            <dd className={item.mono === true ? 'mono' : undefined}>
              <span className="runtime-val" title={item.value}>
                {item.value}
              </span>
              {item.source !== undefined && <span className="runtime-source">{item.source}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** 非阻塞安全告警横幅（warn-tint）：只提示不锁死，绝无「允许不安全连接」开关 */
function SecurityAdvisories(props: { t: TranslateFn; warnings: SecurityWarning[] }) {
  const { t, warnings } = props;
  if (warnings.length === 0) return null;
  return (
    <>
      {warnings.map((warning) => (
        <div className="warn-banner tint-warn" key={warning} role="status">
          <AlertIcon size={16} />
          <p>{warning === 'PUBLIC_HTTP_PLAINTEXT' ? t('admin.advisoryPublicHttp') : t('admin.advisoryUdpAlt')}</p>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- 三标签页

const TAB_ORDER = ['users', 'groups', 'settings'] as const;
type AdminTab = (typeof TAB_ORDER)[number];

// ---------------------------------------------------------------- 主视图

export function AdminView(props: AdminViewProps) {
  const {
    t,
    client,
    runtime,
    settings,
    groups,
    users,
    adminLoad,
    adminError,
    currentUserId,
    ui,
    onUi,
    onSetUserActive,
    onRefreshUsers,
    onRefreshGroups,
    onRefreshRuntime,
    onSettingsChanged,
  } = props;

  const [tab, setTab] = useState<AdminTab>('users');
  const tabRefs = useRef<Partial<Record<AdminTab, HTMLButtonElement | null>>>({});

  // 任一管理切片末次刷新失败时给一条非阻塞提示：面板显示的是旧数据兜底，
  // 不阻塞标签页（成功补拍后 adminError 归 null，提示自动消失）
  const anySliceError =
    adminError.runtime !== null || adminError.settings !== null || adminError.groups !== null || adminError.users !== null;

  const handleTablistKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const current = TAB_ORDER.indexOf(tab);
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = (current + TAB_ORDER.length - 1) % TAB_ORDER.length;
        break;
      case 'ArrowRight':
        next = (current + 1) % TAB_ORDER.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = TAB_ORDER.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextTab = TAB_ORDER[next];
    if (nextTab === undefined) return;
    setTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  const tabs: Array<{ id: AdminTab; label: string }> = [
    { id: 'users', label: t('admin.tabUsers') },
    { id: 'groups', label: t('admin.tabGroups') },
    { id: 'settings', label: t('admin.tabSettings') },
  ];

  return (
    <section className="admin-view">
      <RuntimeStrip
        t={t}
        runtime={runtime}
        title={t('view.admin')}
        usersCount={users.length}
        groupsCount={groups.length}
        allowSignup={settings?.allowSignup}
        smtpConfigured={settings?.smtp.configured ?? runtime?.smtpConfigured}
      />
      {runtime !== null && <SecurityAdvisories t={t} warnings={runtime.securityWarnings} />}
      {anySliceError && <p className="field-hint">{t('admin.sliceError')}</p>}

      <div className="admin-tabs" role="tablist" aria-label={t('view.admin')} onKeyDown={handleTablistKeyDown}>
        {tabs.map((item) => (
          <button
            type="button"
            key={item.id}
            ref={(el) => {
              tabRefs.current[item.id] = el;
            }}
            role="tab"
            id={`admin-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`admin-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            className="admin-tab"
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="admin-tabpanel" role="tabpanel" id="admin-panel-users" aria-labelledby="admin-tab-users" hidden={tab !== 'users'}>
        <AdminUsersGroups
          t={t}
          mode="users"
          client={client}
          users={users}
          currentUserId={currentUserId}
          groups={groups}
          ui={ui}
          onUi={onUi}
          onSetUserActive={onSetUserActive}
          onRefreshUsers={onRefreshUsers}
          onRefreshGroups={onRefreshGroups}
        />
      </div>

      <div className="admin-tabpanel" role="tabpanel" id="admin-panel-groups" aria-labelledby="admin-tab-groups" hidden={tab !== 'groups'}>
        <AdminUsersGroups
          t={t}
          mode="groups"
          client={client}
          users={users}
          currentUserId={currentUserId}
          groups={groups}
          ui={ui}
          onUi={onUi}
          onSetUserActive={onSetUserActive}
          onRefreshUsers={onRefreshUsers}
          onRefreshGroups={onRefreshGroups}
        />
      </div>

      <div className="admin-tabpanel" role="tabpanel" id="admin-panel-settings" aria-labelledby="admin-tab-settings" hidden={tab !== 'settings'}>
        {settings !== null ? (
          <AdminGatewaySettings
            t={t}
            client={client}
            settings={settings}
            groups={groups}
            runtime={runtime}
            ui={ui}
            onUi={onUi}
            onSettingsChanged={onSettingsChanged}
            onRefreshGroups={onRefreshGroups}
            onRefreshRuntime={onRefreshRuntime}
          />
        ) : adminLoad.settings === 'error' ? (
          <p className="empty-hint">{t('admin.sliceError')}</p>
        ) : (
          <p className="empty-hint">{t('app.loading')}</p>
        )}
      </div>
    </section>
  );
}
