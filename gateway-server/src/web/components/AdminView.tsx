// 网关管理页（GC-10 重构）：页头只读运行态条 + 条件安全告警横幅 +
// 「用户管理 / 用户组 / 网关与发信设置」三标签页工作台。
//
// 数据面：App.tsx 仍按 GC-6b 的接线提供 users（3 秒轮询切片）与 settings
//（进入视图拉取一次）；本页在此基础上用模块级 ConsoleClient 自行补齐
// runtime 轮询（ManagedRefreshCycle，同 PC-20 的忙碌跳过纪律）与用户组列表，
// 面板内的增删改走同一客户端，成功后立即补拍对应列表（补拍结果作为本地
// 覆盖层显示，App 的下一次轮询落库后自动丢弃，恢复以 store 为准）。
//
// 安全红线：安全告警只有非阻塞的 warn-tint 提示横幅，绝不提供
// 「允许不安全连接」开关；运行态展示全部来自 /admin/runtime 的脱敏视图。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { formatBytes, formatRate } from '../format';
import { LOCALE_STORAGE_KEY, resolveLocale } from '../i18n/locales';
import type { Locale, LocaleKey, TranslateFn } from '../i18n/locales';
import { ConsoleApiError, ConsoleClient, ManagedRefreshCycle } from '../store/console-store';
import type {
  AdminSettingsData,
  AdminUserRow,
  GatewayRuntimeStatus,
  SecurityWarning,
  SystemSettings,
  UiLocalState,
  UserGroup,
} from '../store/console-store';
import { AdminGatewaySettings } from './AdminGatewaySettings';
import { AdminUsersGroups } from './AdminUsersGroups';
import { AlertIcon } from './Icons';

export interface AdminViewProps {
  t: TranslateFn;
  users: AdminUserRow[];
  /** 脱敏设置视图（GC-6b 扩展形态）；管理员数据未拉到前是 null */
  settings: AdminSettingsData | null;
  currentUserId: string;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
  /** 兼容保留（App 接线）：旧四键设置 PATCH 通道；GC-10 起设置面板走本页完整视图 PATCH */
  onPatchSettings: (patch: Partial<SystemSettings>) => void;
  /** 用户启停：仍走 App 的实现（PATCH 后立即刷新 store 用户切片） */
  onSetUserActive: (userId: string, active: boolean) => void;
}

/** 运行态轮询周期：与 App 的用户切片轮询同节拍（PC-20） */
const RUNTIME_REFRESH_INTERVAL_MS = 3000;

/** 管理工作台共用的同源客户端（模块级单例，与 App.tsx 同型） */
export const adminClient = new ConsoleClient();

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

// ---------------------------------------------------------------- 运行态条

/** 存储引擎的展示名（脱敏：只有引擎名，绝无连接串） */
function storageLabel(driver: 'sqlite' | 'postgres'): string {
  return driver === 'sqlite' ? 'SQLite WAL' : 'PostgreSQL';
}

/**
 * 页头只读运行态条：监听端口、生效公网入口（带来源标签）、UDP 探测端口、
 * 存储引擎、主密钥来源、在线设备、实时中转速率与累计中转流量。
 * runtime 未拉到前整条显示占位破折号，不阻塞标签页渲染。
 */
export function RuntimeStrip(props: { t: TranslateFn; runtime: GatewayRuntimeStatus | null }) {
  const { t, runtime } = props;
  const udpText = (() => {
    if (runtime === null || runtime.udpPort === 0) return '—';
    return runtime.udpAltPort > 0 ? `${runtime.udpPort} / ${runtime.udpAltPort}` : `${runtime.udpPort}`;
  })();
  const items: Array<{ label: string; value: string; source?: string; mono?: boolean }> = [
    { label: t('admin.runtimeTcpPort'), value: runtime === null ? '—' : `:${runtime.listenPort}`, mono: true },
    {
      label: t('admin.publicUrl'),
      value: runtime === null || runtime.publicUrlEffective === '' ? '—' : runtime.publicUrlEffective,
      source: runtime?.publicUrlSource,
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
    { label: t('summary.onlineDevices'), value: runtime === null ? '—' : String(runtime.onlineDevices), mono: true },
    { label: t('admin.runtimeRelayRate'), value: runtime === null ? '—' : formatRate(runtime.totalLiveRelayKbps), mono: true },
    { label: t('devices.totalRelay'), value: runtime === null ? '—' : formatBytes(runtime.cumulativeRelayBytes), mono: true },
  ];
  return (
    <dl className="runtime-strip">
      {items.map((item) => (
        <div className="runtime-item" key={item.label}>
          <dt>{item.label}</dt>
          <dd className={item.mono === true ? 'mono' : undefined}>
            {item.value}
            {item.source !== undefined && <span className="runtime-source mono">{item.source}</span>}
          </dd>
        </div>
      ))}
    </dl>
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
  const { t, users, settings, currentUserId, ui, onUi, onSetUserActive } = props;

  const [tab, setTab] = useState<AdminTab>('users');
  const [runtime, setRuntime] = useState<GatewayRuntimeStatus | null>(null);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  // 设置的本地镜像：App 进入视图拉一次作为种子；面板内 PATCH 成功后由本页自更新
  const [settingsLocal, setSettingsLocal] = useState<AdminSettingsData | null>(settings);
  // 用户列表的本地补拍：面板变更后立即刷新的覆盖层，App 轮询落库后自动丢弃
  const [usersOverride, setUsersOverride] = useState<AdminUserRow[] | null>(null);
  const tabRefs = useRef<Partial<Record<AdminTab, HTMLButtonElement | null>>>({});

  // props.settings 引用变化（进入视图 / App 重拉）即重新播种本地镜像
  useEffect(() => {
    setSettingsLocal(settings);
  }, [settings]);

  // App 轮询拿到新用户切片即丢弃本地补拍（恢复以 store 为唯一事实）
  useEffect(() => {
    setUsersOverride(null);
  }, [users]);
  const viewUsers = usersOverride ?? users;

  const refreshUsers = useCallback(async (): Promise<void> => {
    try {
      setUsersOverride(await adminClient.listAdminUsers());
    } catch {
      /* 补拍失败不致命：App 的 3 秒轮询兜底 */
    }
  }, []);

  const refreshGroups = useCallback(async (): Promise<void> => {
    try {
      setGroups(await adminClient.listGroups());
    } catch {
      /* 保留旧列表兜底 */
    }
  }, []);

  const refreshRuntime = useCallback(async (): Promise<void> => {
    try {
      setRuntime(await adminClient.getAdminRuntime());
    } catch {
      /* 保留旧值兜底 */
    }
  }, []);

  useEffect(() => {
    void refreshGroups();
  }, [refreshGroups]);

  // 运行态 3 秒轮询：ManagedRefreshCycle（忙碌跳过、卸载停表并 abort 在途拍）
  useEffect(() => {
    const cycle = new ManagedRefreshCycle({
      intervalMs: RUNTIME_REFRESH_INTERVAL_MS,
      timers: {
        interval: (handler, ms) => setInterval(handler, ms),
        cancel: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      },
      load: async (ticket) => {
        try {
          const next = await adminClient.getAdminRuntime(ticket.signal);
          if (ticket.isCurrent()) setRuntime(next);
        } catch {
          /* 单拍失败或被取消不致命 */
        } finally {
          ticket.settle();
        }
      },
    });
    cycle.start();
    return () => cycle.stop();
  }, []);

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
      <h2 className="page-title">{t('view.admin')}</h2>
      <RuntimeStrip t={t} runtime={runtime} />
      {runtime !== null && <SecurityAdvisories t={t} warnings={runtime.securityWarnings} />}

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
          client={adminClient}
          users={viewUsers}
          currentUserId={currentUserId}
          groups={groups}
          ui={ui}
          onUi={onUi}
          onSetUserActive={onSetUserActive}
          onRefreshUsers={refreshUsers}
          onRefreshGroups={refreshGroups}
        />
      </div>

      <div className="admin-tabpanel" role="tabpanel" id="admin-panel-groups" aria-labelledby="admin-tab-groups" hidden={tab !== 'groups'}>
        <AdminUsersGroups
          t={t}
          mode="groups"
          client={adminClient}
          users={viewUsers}
          currentUserId={currentUserId}
          groups={groups}
          ui={ui}
          onUi={onUi}
          onSetUserActive={onSetUserActive}
          onRefreshUsers={refreshUsers}
          onRefreshGroups={refreshGroups}
        />
      </div>

      <div className="admin-tabpanel" role="tabpanel" id="admin-panel-settings" aria-labelledby="admin-tab-settings" hidden={tab !== 'settings'}>
        {settingsLocal !== null ? (
          <AdminGatewaySettings
            t={t}
            client={adminClient}
            settings={settingsLocal}
            groups={groups}
            runtime={runtime}
            ui={ui}
            onUi={onUi}
            onSettingsChanged={setSettingsLocal}
            onRefreshGroups={refreshGroups}
            onRefreshRuntime={refreshRuntime}
          />
        ) : (
          <p className="empty-hint">{t('app.loading')}</p>
        )}
      </div>
    </section>
  );
}
