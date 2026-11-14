// 控制台应用壳（PG-6b）：登录/注册 + 顶栏 + 网络视图 / 网关管理视图。
// App 是唯一与 ConsoleClient 对话的地方：REST 动作完成后刷新 networks /
// topology 切片；SSE 订阅跟随选中网络——实时推送只进 topology 切片，绝不
// 碰 ui 切片（弹窗/菜单/行内二次确认/表单草稿）。Toast 是底部提示条，
// 2.6s 自动消失，只承载「已复制/已保存」这类非阻塞反馈。
// GC-8：登录页三态（登录 / 注册 / 找回密码，含 OTP 与主题/语言切换）、账号
// 设置弹窗（改密 / 换绑邮箱）、全量错误码映射与 admin 视图防越权守卫都由
// 这里接线。
// GC-10b：App 成为管理四切片（runtime / settings / groups / users）的唯一
// 持有者与唯一请求源——进入 admin 视图独立拉取四张切片，3 秒可见性受控
// 轮询只轻刷 users 与 runtime（settings / groups 是编辑中的草稿，轮询回写
// 会冲掉表单）；任一管理请求 401 视为会话失效：清空全部管理切片并回
// /auth/me 核对会话态；切出 admin 视图同样彻底清场。网络侧补齐设备备注
// 编辑、建网额度透传（maxPeers / admissionMode）、空态建网 CTA 与配额
// 门槛，管理变更成功后联动刷新会话配额与网络列表（publicUrl 热改后的
// joinUri）。
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { AccountSettingsModal } from './components/AccountSettingsModal';
import { AdminView } from './components/AdminView';
import { copyTextToClipboard } from './clipboard';
import { LoginView } from './components/LoginView';
import type { LoginMode } from './components/LoginView';
import { NetworkView, NewNetworkModal } from './components/NetworkView';
import type { NetworkPatchInput, NewNetworkInput } from './components/NetworkView';
import { TopBar } from './components/TopBar';
import type { ViewKind } from './components/TopBar';
import { LOCALE_STORAGE_KEY, resolveLocale, translate } from './i18n/locales';
import type { Locale, LocaleKey, TranslateVars } from './i18n/locales';
import { ConsoleApiError, ConsoleClient, ConsoleStore, ManagedRefreshCycle } from './store/console-store';
import type { AdminSliceKey, AdminSettingsData, MemberAction, SystemSettings, UiLocalState } from './store/console-store';

const client = new ConsoleClient();
const store = new ConsoleStore();

const THEME_STORAGE_KEY = 'zen-remote-console.theme';
type Theme = 'light' | 'dark';

/** 管理页在线数/速率的 REST 刷新周期（PC-20） */
const ADMIN_REFRESH_INTERVAL_MS = 3000;

/** markAdminError 的消息入参：只要可读的失败原因，无 Error 形态时给占位 */
function adminErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

/** 任一被拒绝的请求是不是 401（会话失效 / 权限被收回的管理请求分诊） */
function isUnauthorized(err: unknown): boolean {
  return err instanceof ConsoleApiError && err.status === 401;
}

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* localStorage 不可用（隐私模式等）时跟随系统 */
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStoredLocale(): Locale {
  try {
    return resolveLocale(localStorage.getItem(LOCALE_STORAGE_KEY), navigator.language);
  } catch {
    return 'zh';
  }
}

/** 服务端错误码 → 词典键；未知码一律「出了点问题」。GC-8 起覆盖全部
 * OTP / 限流 / 配额 / SMTP / 管理约束错误码，不再全兜底成「出了点问题」。 */
function authErrorToKey(err: unknown): LocaleKey {
  const code = err instanceof ConsoleApiError ? err.code : '';
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return 'error.invalidCredentials';
    case 'ACCOUNT_DISABLED':
      return 'error.accountDisabled';
    case 'SIGNUP_DISABLED':
      return 'error.signupDisabled';
    case 'EMAIL_TAKEN':
      return 'error.emailTaken';
    // OTP 三态与限流（GC-2/GC-5）
    case 'OTP_COOLDOWN':
      return 'error.otpCooldown';
    case 'OTP_INVALID':
      return 'error.otpInvalid';
    case 'OTP_LOCKED':
      return 'error.otpLocked';
    case 'RATE_LIMITED':
      return 'error.rateLimited';
    // SMTP（发信未配置 / 发送失败）
    case 'SMTP_NOT_CONFIGURED':
      return 'error.smtpNotConfigured';
    case 'SMTP_SEND_FAILED':
      return 'error.smtpSendFailed';
    // 配额（建网超额 / 单网设备上限）
    case 'QUOTA_EXCEEDED':
      return 'account.quotaReached';
    case 'LIMIT_REACHED':
    case 'PEER_LIMIT_EXCEEDED_BY_GROUP':
      return 'error.peerLimitByGroup';
    // 管理约束（最后管理员 / 自我保护 / 默认组 / 组占用 / 组标识码 / API Key）
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
    case 'INVALID_API_KEY':
      return 'error.invalidApiKey';
    // 设备备注超长（GC-10b 起备注编辑接线）
    case 'NOTE_TOO_LONG':
      return 'error.noteTooLong';
    case 'NETWORK_ERROR':
    case 'NO_TRANSPORT':
      return 'error.network';
    default:
      return 'error.generic';
  }
}

/** Toast 存留时长；at 戳让连续弹同一条提示也重新计时 */
const TOAST_TTL_MS = 2600;

export function App() {
  const state = useSyncExternalStore(store.subscribe, store.getState);

  const [locale, setLocale] = useState<Locale>(readStoredLocale);
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [view, setView] = useState<ViewKind>('networks');
  const [selectedNetworkId, setSelectedNetworkId] = useState<string | null>(null);
  const [homeEpoch, setHomeEpoch] = useState(0);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<LocaleKey | null>(null);
  const [bootFailed, setBootFailed] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [toast, setToast] = useState<{ key: LocaleKey; at: number } | null>(null);

  const t = useCallback((key: LocaleKey, vars?: TranslateVars) => translate(locale, key, vars), [locale]);

  // 主题落到 <html data-theme>，global.css 的变量整套切换
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* 持久化失败不致命 */
    }
  }, [theme]);

  // 语言落到 <html lang>（屏幕阅读器发音）与标签页标题
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    document.title = t('app.title');
  }, [locale, t]);

  // 行内二次确认的「点任意别处即取消」：确认态存在时，凡点击不在带
  // data-confirm-trigger 的按钮上（含确认按钮自己），一律取消确认态。
  // 点击确认按钮本身时 React 的 onClick 先于这里的 document 级监听执行。
  const confirmTarget = state.ui.confirmTarget;
  useEffect(() => {
    if (confirmTarget === null) return;
    const onClick = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-confirm-trigger]')) return;
      store.patchUi({ confirmTarget: null });
    };
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('click', onClick);
    };
  }, [confirmTarget]);

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => {
      setToast((current) => (current !== null && current.at === toast.at ? null : current));
    }, TOAST_TTL_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const showToast = useCallback((key: LocaleKey): void => {
    setToast({ key, at: Date.now() });
  }, []);

  const handleUi = useCallback((patch: Partial<UiLocalState>): void => {
    store.patchUi(patch);
  }, []);

  const refreshNetworks = useCallback(async (): Promise<void> => {
    try {
      store.setNetworks(await client.listNetworks());
    } catch {
      /* 列表拉取失败不打断视图；下一次动作或 SSE 会补 */
    }
  }, []);

  const refreshTopology = useCallback(async (networkId: string): Promise<void> => {
    try {
      const snapshot = await client.fetchTopology(networkId);
      if (snapshot !== null) store.applyTopologySnapshot(snapshot);
    } catch {
      /* SSE 推送会补 */
    }
  }, []);

  // 启动：会话探测 → 已登录顺手拉网络列表
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await client.fetchMe();
        if (cancelled) return;
        store.init(me);
        if (me.authenticated) await refreshNetworks();
      } catch {
        if (!cancelled) {
          setBootFailed(true);
          store.init({ authenticated: false, allowSignup: false, maxNetworksPerUser: 3 });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshNetworks]);

  // 选中网络：默认选第一个；被删除的网络自动回落
  useEffect(() => {
    if (state.session === null) return;
    if (selectedNetworkId !== null && state.networks.some((n) => n.id === selectedNetworkId)) return;
    setSelectedNetworkId(state.networks[0]?.id ?? null);
  }, [state.session, state.networks, selectedNetworkId]);

  // SSE 订阅跟随选中网络：先 REST 拉一次快照，再订阅增量（退订随网络切换）
  const signedIn = state.session !== null;
  useEffect(() => {
    if (!signedIn || selectedNetworkId === null) return;
    let cancelled = false;
    void refreshTopology(selectedNetworkId);
    const unsubscribe = client.subscribeTopology(selectedNetworkId, (snapshot) => {
      if (!cancelled) store.applyTopologySnapshot(snapshot);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [signedIn, selectedNetworkId, refreshTopology]);

  // ------------------------------------------------- 管理四切片（GC-10b 收口）

  const isAdmin = state.session !== null && state.session.user.role === 'admin';

  /** 重新拉 /auth/me 落库：换绑邮箱成功后顶栏邮箱、配额摘要与弹窗即时刷新 */
  const refreshSession = useCallback(async (): Promise<void> => {
    const me = await client.fetchMe();
    store.init(me);
  }, []);

  /** 管理变更后的联动刷新：/auth/me 落库（当前管理员配额与 publicPolicy）+
   * 网络列表（publicUrl 热改后的 joinUri）。两段各自兜底，失败不致命。 */
  const refreshSessionAndNetworks = useCallback(async (): Promise<void> => {
    try {
      await refreshSession();
    } catch {
      /* 会话刷新失败不致命：下一次动作或轮询会补 */
    }
    try {
      store.setNetworks(await client.listNetworks());
    } catch {
      /* 列表刷新失败不致命 */
    }
  }, [refreshSession]);

  /** 任一管理请求 401：会话已失效或权限被收回——立刻清空全部管理敏感切片
   * （零残留），再回 /auth/me 核对会话态（后端对失效会话返回匿名策略，
   * store.init 会自然切回登录前状态；/auth/me 自身失败时切片已清空，
   * 留给下一次轮询/动作再核对）。 */
  const handleAdminUnauthorized = useCallback((): void => {
    store.clearAdminSlices();
    void refreshSession().catch(() => {
      /* 会话核对失败不致命 */
    });
  }, [refreshSession]);

  /** 管理请求失败分诊：401 走清场路径；其余只记本切片错误态、保留旧数据兜底 */
  const handleAdminFetchError = useCallback(
    (key: AdminSliceKey, err: unknown): void => {
      if (isUnauthorized(err)) {
        handleAdminUnauthorized();
        return;
      }
      store.markAdminError(key, adminErrorMessage(err));
    },
    [handleAdminUnauthorized],
  );

  /** 用户列表补拍（面板建/改/删用户成功后调用）：写回 store 用户切片；
   * 用户变更可能涉及当前管理员自己的组/角色，联动刷新会话配额与网络列表 */
  const refreshAdminUsers = useCallback(async (): Promise<void> => {
    try {
      store.applyAdminUsers(await client.listAdminUsers());
    } catch (err) {
      handleAdminFetchError('users', err);
      return;
    }
    void refreshSessionAndNetworks();
  }, [handleAdminFetchError, refreshSessionAndNetworks]);

  /** 用户组列表补拍（组 CRUD / 默认组切换成功后调用）：写回 store 组切片 */
  const refreshAdminGroups = useCallback(async (): Promise<void> => {
    try {
      store.applyAdminGroups(await client.listGroups());
    } catch (err) {
      handleAdminFetchError('groups', err);
      return;
    }
    void refreshSessionAndNetworks();
  }, [handleAdminFetchError, refreshSessionAndNetworks]);

  /** 运行态条补拍（publicUrl 热改后调用）：写回 store 运行态切片 */
  const refreshAdminRuntime = useCallback(async (): Promise<void> => {
    try {
      store.applyAdminRuntime(await client.getAdminRuntime());
    } catch (err) {
      handleAdminFetchError('runtime', err);
    }
  }, [handleAdminFetchError]);

  /** 设置面板 PATCH / 密钥操作成功：返回的最新脱敏视图整体落库，并联动刷新
   * 会话配额（allowSignup / 默认组同步会改 publicPolicy）与网络列表（publicUrl
   * 热改后的 joinUri）。 */
  const handleSettingsChanged = useCallback(
    (next: AdminSettingsData): void => {
      store.applyAdminSettings(next);
      void refreshSessionAndNetworks();
    },
    [refreshSessionAndNetworks],
  );

  // 路由防越权守卫 + 管理切片清场（GC-8/GC-10b）：切出 admin 视图或失去管理员
  // 身份（被降级 / 登出 / 会话失效）时，彻底清掉管理员敏感切片（runtime /
  // settings / groups / users 与各自加载、错误态）；普通用户停在 admin 视图
  //（本地残留状态）一律弹回网络视图。
  useEffect(() => {
    if (view !== 'admin' || !isAdmin) {
      if (view === 'admin') setView('networks');
      store.clearAdminSlices();
    }
  }, [view, isAdmin]);

  // 进入管理视图：四张管理切片独立并行拉取（单张失败只记自己的错误态并保留
  // 旧数据，互不阻塞）。settings / groups 是慢变配置，只在进入视图拉一次，
  // 之后的更新由面板 PATCH 的返回值负责（fix1 R1：轮询回写会让正在编辑的
  // 开关/输入在两次击键之间被服务端旧值冲掉）。
  useEffect(() => {
    if (view !== 'admin' || !isAdmin) return;
    let cancelled = false;
    void (async () => {
      store.markAdminLoading('runtime');
      store.markAdminLoading('settings');
      store.markAdminLoading('groups');
      store.markAdminLoading('users');
      const [runtime, settings, groups, users] = await Promise.allSettled([
        client.getAdminRuntime(),
        client.getAdminSettings(),
        client.listGroups(),
        client.listAdminUsers(),
      ]);
      if (cancelled) return;
      // 任一请求 401 = 会话失效：不再落库任何切片，直接清场并核对会话态
      const settled = [runtime, settings, groups, users];
      if (settled.some((r) => r.status === 'rejected' && isUnauthorized(r.reason))) {
        handleAdminUnauthorized();
        return;
      }
      if (runtime.status === 'fulfilled') store.applyAdminRuntime(runtime.value);
      else handleAdminFetchError('runtime', runtime.reason);
      if (settings.status === 'fulfilled') store.applyAdminSettings(settings.value);
      else handleAdminFetchError('settings', settings.reason);
      if (groups.status === 'fulfilled') store.applyAdminGroups(groups.value);
      else handleAdminFetchError('groups', groups.reason);
      if (users.status === 'fulfilled') store.applyAdminUsers(users.value);
      else handleAdminFetchError('users', users.reason);
    })();
    return () => {
      cancelled = true;
    };
  }, [view, isAdmin, handleAdminUnauthorized, handleAdminFetchError]);

  // 管理页热切片 3 秒轮询（PC-20 fix1）：当前视图 + document 可见 + 已登录管理员
  // 时，固定 3 秒格点并行轻刷 users 与 runtime 两张实时数据——绝不轮询 settings
  // 与 groups（编辑中的草稿会被服务端旧值回写冲掉）。单张失败保留旧数据只记
  // 错误态；任一请求 401 清空管理切片并核对会话态。原生 interval + 忙碌跳过，
  // 慢响应不打漂节拍、不叠加；隐藏/离开视图/退出登录停表并 abort 在途请求
  //（旧请求不能永久留在后台）；世代守卫兜底不可取消的迟响应。回到可见立即
  // 补一次再恢复固定节拍。
  useEffect(() => {
    if (view !== 'admin' || !isAdmin) return;
    const cycle = new ManagedRefreshCycle({
      intervalMs: ADMIN_REFRESH_INTERVAL_MS,
      timers: {
        interval: (handler, ms) => setInterval(handler, ms),
        cancel: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      },
      load: async (ticket) => {
        try {
          const [users, runtime] = await Promise.allSettled([
            client.listAdminUsers(ticket.signal),
            client.getAdminRuntime(ticket.signal),
          ]);
          if (!ticket.isCurrent()) return;
          const settled = [users, runtime];
          if (settled.some((r) => r.status === 'rejected' && isUnauthorized(r.reason))) {
            handleAdminUnauthorized();
            return;
          }
          if (users.status === 'fulfilled') store.applyAdminUsers(users.value);
          else handleAdminFetchError('users', users.reason);
          if (runtime.status === 'fulfilled') store.applyAdminRuntime(runtime.value);
          else handleAdminFetchError('runtime', runtime.reason);
        } finally {
          ticket.settle();
        }
      },
    });
    const syncToVisibility = (): void => {
      if (document.visibilityState === 'visible') cycle.start();
      else cycle.stop();
    };
    syncToVisibility();
    document.addEventListener('visibilitychange', syncToVisibility);
    return () => {
      document.removeEventListener('visibilitychange', syncToVisibility);
      cycle.stop();
    };
  }, [view, isAdmin, handleAdminUnauthorized, handleAdminFetchError]);

  /** 登录 / 注册 / 找回重置（GC-8 三态）；返回是否成功，LoginView 据此整理本页状态 */
  const handleAuth = useCallback(
    async (mode: LoginMode, email: string, password: string, otpCode?: string): Promise<boolean> => {
      setAuthBusy(true);
      setAuthError(null);
      try {
        if (mode === 'forgot') {
          await client.resetPassword({ email, otpCode: otpCode ?? '', newPassword: password });
          return true;
        }
        const result =
          mode === 'login' ? await client.login(email, password) : await client.signup(email, password, otpCode);
        // session + meta + quota + publicPolicy 一次落库（GC-7b 响应体同构）
        store.applySessionPayload(result);
        store.patchUi({ loginPassword: '' }); // 密码不留在草稿里
        await refreshNetworks();
        return true;
      } catch (err) {
        setAuthError(authErrorToKey(err));
        return false;
      } finally {
        setAuthBusy(false);
      }
    },
    [refreshNetworks],
  );

  /** 发送 6 位验证码（注册 / 找回）；失败返回 null，错因已写入 authError（GC-8） */
  const handleSendOtp = useCallback(
    async (
      purpose: 'signup' | 'reset_password',
      email: string,
    ): Promise<{ sent: boolean; cooldownSec: number } | null> => {
      setAuthBusy(true);
      setAuthError(null);
      try {
        return await client.sendOtp({ email, purpose, locale });
      } catch (err) {
        setAuthError(authErrorToKey(err));
        return null;
      } finally {
        setAuthBusy(false);
      }
    },
    [locale],
  );

  const handleLogout = useCallback(async (): Promise<void> => {
    try {
      await client.logout();
    } catch {
      /* 会话清理失败也照常回登录页 */
    }
    store.logout(store.getState().meta);
    setSelectedNetworkId(null);
    setView('networks');
    setToast(null);
  }, []);

  const handleToggleTheme = useCallback((): void => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const handleToggleLocale = useCallback((): void => {
    setLocale((prev) => {
      const next: Locale = prev === 'zh' ? 'en' : 'zh';
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, next);
      } catch {
        /* 持久化失败不致命 */
      }
      return next;
    });
  }, []);

  const handleCreateNetworkOpen = useCallback((): void => {
    store.patchUi({ dialog: 'new-network' });
  }, []);

  // ---------------------------------------------------------- 账号设置（GC-8）

  const handleOpenAccountSettings = useCallback((): void => {
    store.patchUi({ dialog: 'account-settings' });
  }, []);

  const handleCloseAccountSettings = useCallback((): void => {
    store.patchUi({ dialog: null });
  }, []);

  // 表单回调不吞错：失败原样抛回给弹窗映射成字段文案，成功才在这里 toast
  const handleChangeMyPassword = useCallback(
    async (currentPassword: string, newPassword: string): Promise<void> => {
      await client.changeMyPassword({ currentPassword, newPassword });
      showToast('accountSettings.passwordSaved');
    },
    [showToast],
  );

  const handleRequestEmailChange = useCallback(
    async (currentPassword: string, newEmail: string): Promise<{ otpRequired: boolean; cooldownSec: number }> => {
      return client.requestEmailChange({ currentPassword, newEmail, locale });
    },
    [locale],
  );

  const handleConfirmEmailChange = useCallback(
    async (currentPassword: string, newEmail: string, otpCode?: string): Promise<void> => {
      await client.confirmEmailChange({
        currentPassword,
        newEmail,
        ...(otpCode !== undefined ? { otpCode } : {}),
      });
      await refreshSession();
      showToast('accountSettings.emailChanged');
    },
    [locale, refreshSession, showToast],
  );

  // ---------------------------------------------------------------- 动作回调

  const handleMemberAction = useCallback(
    async (networkId: string, nodeId: string, action: MemberAction): Promise<void> => {
      setActionBusy(true);
      try {
        await client.memberTransition(networkId, nodeId, action);
        store.patchUi({ confirmTarget: null });
        await refreshTopology(networkId);
        void refreshNetworks();
      } catch (err) {
        showToast(authErrorToKey(err));
      } finally {
        setActionBusy(false);
      }
    },
    [refreshTopology, refreshNetworks, showToast],
  );

  const handleRemoveMember = useCallback(
    async (networkId: string, nodeId: string): Promise<void> => {
      setActionBusy(true);
      try {
        await client.removeMember(networkId, nodeId);
        store.patchUi({ confirmTarget: null });
        await refreshTopology(networkId);
        void refreshNetworks();
      } catch (err) {
        showToast(authErrorToKey(err));
      } finally {
        setActionBusy(false);
      }
    },
    [refreshTopology, refreshNetworks, showToast],
  );

  const handleRenameMember = useCallback(
    async (networkId: string, nodeId: string, name: string): Promise<void> => {
      setActionBusy(true);
      try {
        await client.patchMember(networkId, nodeId, { name });
        await refreshTopology(networkId);
        showToast('toast.saved');
      } catch (err) {
        showToast(authErrorToKey(err));
      } finally {
        setActionBusy(false);
      }
    },
    [refreshTopology, showToast],
  );

  /** 设备备注编辑（GC-10b 接线，SPEC 5.5）：复用 PATCH members 的 note 字段 */
  const handleEditMemberNote = useCallback(
    async (networkId: string, nodeId: string, note: string): Promise<void> => {
      setActionBusy(true);
      try {
        await client.patchMember(networkId, nodeId, { note });
        await refreshTopology(networkId);
        showToast('toast.saved');
      } catch (err) {
        showToast(authErrorToKey(err));
      } finally {
        setActionBusy(false);
      }
    },
    [refreshTopology, showToast],
  );

  const handlePatchNetwork = useCallback(
    async (networkId: string, patch: NetworkPatchInput): Promise<void> => {
      setActionBusy(true);
      try {
        await client.patchNetwork(networkId, patch);
        await refreshTopology(networkId);
        await refreshNetworks();
        showToast('toast.saved');
      } catch (err) {
        showToast(authErrorToKey(err));
      } finally {
        setActionBusy(false);
      }
    },
    [refreshTopology, refreshNetworks, showToast],
  );

  const handleRotateInviteKey = useCallback(
    async (networkId: string): Promise<void> => {
      setActionBusy(true);
      try {
        await client.rotateInviteKey(networkId);
        store.patchUi({ confirmTarget: null });
        await refreshNetworks();
        showToast('toast.inviteReset');
      } catch (err) {
        showToast(authErrorToKey(err));
      } finally {
        setActionBusy(false);
      }
    },
    [refreshNetworks, showToast],
  );

  const handleDeleteNetwork = useCallback(
    async (networkId: string): Promise<void> => {
      setActionBusy(true);
      try {
        await client.deleteNetwork(networkId);
        store.patchUi({ dialog: null, confirmTarget: null });
        setSelectedNetworkId(null);
        await refreshNetworks();
        // 删网后 usedNetworks 变化：/auth/me 落库让顶栏与新建弹窗额度即时刷新
        try {
          await refreshSession();
        } catch {
          /* 会话刷新失败不致命 */
        }
        showToast('toast.networkDeleted');
      } catch (err) {
        showToast(authErrorToKey(err));
      } finally {
        setActionBusy(false);
      }
    },
    [refreshNetworks, refreshSession, showToast],
  );

  /** 创建网络（GC-9 弹窗扩展形态）：第二参透传设备上限与入网方式，未传按
   * 后端默认落库；成功后拉 /auth/me 让建网额度（quota.usedNetworks）即时刷新 */
  const handleCreateNetwork = useCallback(
    async (name: string, details?: NewNetworkInput): Promise<void> => {
      setActionBusy(true);
      try {
        const created = await client.createNetwork({
          name: name.trim(),
          ...(details !== undefined ? { maxPeers: details.maxPeers, admissionMode: details.admissionMode } : {}),
        });
        store.patchUi({ dialog: null, draftNetworkName: '' });
        await refreshNetworks();
        try {
          await refreshSession();
        } catch {
          /* 会话刷新失败不致命 */
        }
        setSelectedNetworkId(created.id);
      } catch (err) {
        showToast(authErrorToKey(err));
      } finally {
        setActionBusy(false);
      }
    },
    [refreshNetworks, refreshSession, showToast],
  );

  const handleCopyField = useCallback(
    (value: string, toastKey: LocaleKey): void => {
      void copyTextToClipboard(value).then((copied) => {
        showToast(copied ? toastKey : 'toast.copyFailed');
      });
    },
    [showToast],
  );

  const handleCopyInvite = useCallback(
    (joinUri: string): void => {
      handleCopyField(joinUri, 'toast.inviteCopied');
    },
    [handleCopyField],
  );

  const handlePatchSettings = useCallback(
    async (patch: Partial<SystemSettings>): Promise<void> => {
      try {
        const updated = await client.adminPatchSettings(patch);
        store.applyAdminSettings(updated);
        void refreshSessionAndNetworks();
        showToast('toast.saved');
      } catch (err) {
        showToast(authErrorToKey(err));
      }
    },
    [refreshSessionAndNetworks, showToast],
  );

  const handleSetUserActive = useCallback(
    async (userId: string, active: boolean): Promise<void> => {
      try {
        await client.adminSetUserActive(userId, active);
        store.applyAdminUsers(await client.listAdminUsers());
        void refreshSessionAndNetworks();
      } catch (err) {
        showToast(authErrorToKey(err));
      }
    },
    [refreshSessionAndNetworks, showToast],
  );

  /** 点击左上角品牌标识一键回到默认主页面：第一个网络概览（无网络时回空态引导页） */
  const handleGoHome = useCallback((): void => {
    setView('networks');
    setSelectedNetworkId(state.networks[0]?.id ?? null);
    setHomeEpoch((n) => n + 1);
    store.patchUi({
      networkSwitcherOpen: false,
      accountMenuOpen: false,
      confirmTarget: null,
    });
  }, [state.networks]);

  // ---------------------------------------------------------------- 渲染

  if (state.boot === 'loading') {
    return (
      <div className="boot-splash">
        <span className="dot warn" aria-hidden="true" />
      </div>
    );
  }

  if (state.session === null) {
    return (
      <LoginView
        t={t}
        meta={state.meta}
        policy={state.publicPolicy}
        ui={state.ui}
        onUi={handleUi}
        busy={authBusy}
        errorKey={authError ?? (bootFailed ? 'error.network' : null)}
        onDismissError={() => setAuthError(null)}
        onSubmit={handleAuth}
        onSendOtp={handleSendOtp}
        theme={theme}
        locale={locale}
        onToggleTheme={handleToggleTheme}
        onToggleLocale={handleToggleLocale}
      />
    );
  }

  const selected = state.networks.find((n) => n.id === selectedNetworkId) ?? null;
  // 空态建网 CTA 的门槛（GC-10b）：普通用户建网数达所在组上限时禁用；
  // 管理员组上限不限（maxNetworks === null）永远可建
  const quotaCreateBlocked =
    !isAdmin && state.quota !== null && state.quota.maxNetworks !== null && state.quota.usedNetworks >= state.quota.maxNetworks;

  return (
    <div className="app-shell">
      <TopBar
        t={t}
        locale={locale}
        user={state.session.user}
        quota={state.quota}
        networks={state.networks}
        topology={state.topology}
        selectedNetworkId={selectedNetworkId}
        onSelectNetwork={setSelectedNetworkId}
        onCreateNetwork={handleCreateNetworkOpen}
        onGoHome={handleGoHome}
        view={view}
        onChangeView={setView}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onToggleLocale={handleToggleLocale}
        onLogout={() => void handleLogout()}
        onOpenAccountSettings={handleOpenAccountSettings}
        ui={state.ui}
        onUi={handleUi}
      />
      <main className="app-content">
        {view === 'admin' && isAdmin ? (
          <AdminView
            t={t}
            client={client}
            runtime={state.adminRuntime}
            settings={state.adminSettings}
            groups={state.adminGroups}
            users={state.adminUsers}
            adminLoad={state.adminLoad}
            adminError={state.adminError}
            currentUserId={state.session.user.id}
            ui={state.ui}
            onUi={handleUi}
            onPatchSettings={(patch) => void handlePatchSettings(patch)}
            onSetUserActive={(userId, active) => void handleSetUserActive(userId, active)}
            onRefreshUsers={() => refreshAdminUsers()}
            onRefreshGroups={() => refreshAdminGroups()}
            onRefreshRuntime={() => refreshAdminRuntime()}
            onSettingsChanged={handleSettingsChanged}
          />
        ) : selected !== null ? (
          <NetworkView
            key={`${selected.id}:${homeEpoch}`}
            t={t}
            network={selected}
            topology={state.topology[selected.id] ?? null}
            ui={state.ui}
            onUi={handleUi}
            busy={actionBusy}
            onCopyInvite={() => handleCopyInvite(selected.joinUri)}
            onCopyField={handleCopyField}
            quota={state.quota}
            locale={locale}
            onPatchNetwork={(patch) => void handlePatchNetwork(selected.id, patch)}
            onDeleteNetwork={() => void handleDeleteNetwork(selected.id)}
            onRotateInviteKey={() => void handleRotateInviteKey(selected.id)}
            onMemberAction={(nodeId, action) => void handleMemberAction(selected.id, nodeId, action)}
            onRenameMember={(nodeId, name) => void handleRenameMember(selected.id, nodeId, name)}
            onEditNote={(nodeId, note) => void handleEditMemberNote(selected.id, nodeId, note)}
            onRemoveMember={(nodeId) => void handleRemoveMember(selected.id, nodeId)}
          />
        ) : (
          <section className="empty-state">
            <p className="empty-title">{t('network.emptyTitle')}</p>
            <p className="empty-hint">{t('network.emptyHint')}</p>
            {/* 空态建网 CTA（GC-10b / SPEC 5.5）：达组上限禁用并说明当前组上限
                （含到期回退说明）；管理员与未达限用户可直接开建 */}
            <button type="button" className="btn primary" disabled={quotaCreateBlocked} onClick={handleCreateNetworkOpen}>
              + {t('network.createNew')}
            </button>
            {quotaCreateBlocked && state.quota !== null && (
              <p className="empty-hint">
                {t('network.groupNetworkCap', { n: state.quota.maxNetworks ?? 0 })}
                {state.quota.isExpiredFallback ? ` · ${t('account.groupExpired')}` : ''}
              </p>
            )}
          </section>
        )}
      </main>

      {state.ui.dialog === 'new-network' && (
        <NewNetworkModal
          t={t}
          ui={state.ui}
          onUi={handleUi}
          busy={actionBusy}
          quota={state.quota}
          onCreate={(name, details) => void handleCreateNetwork(name, details)}
        />
      )}

      {state.ui.dialog === 'account-settings' && (
        <AccountSettingsModal
          t={t}
          locale={locale}
          user={state.session.user}
          quota={state.quota}
          smtpConfigured={state.publicPolicy.smtpConfigured}
          onClose={handleCloseAccountSettings}
          onChangePassword={handleChangeMyPassword}
          onRequestEmailChange={handleRequestEmailChange}
          onConfirmEmailChange={handleConfirmEmailChange}
        />
      )}

      {toast !== null && (
        <div className="toast" role="status">
          {t(toast.key)}
        </div>
      )}
    </div>
  );
}
