// 控制台应用壳（PG-6b）：登录/注册 + 顶栏 + 网络视图 / 网关管理视图。
// App 是唯一与 ConsoleClient 对话的地方：REST 动作完成后刷新 networks /
// topology 切片；SSE 订阅跟随选中网络——实时推送只进 topology 切片，绝不
// 碰 ui 切片（弹窗/菜单/行内二次确认/表单草稿）。Toast 是底部提示条，
// 2.6s 自动消失，只承载「已复制/已保存」这类非阻塞反馈。
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { AdminView } from './components/AdminView';
import { LoginView } from './components/LoginView';
import { NetworkView, NewNetworkModal } from './components/NetworkView';
import type { NetworkPatchInput } from './components/NetworkView';
import { TopBar } from './components/TopBar';
import type { ViewKind } from './components/TopBar';
import { LOCALE_STORAGE_KEY, resolveLocale, translate } from './i18n/locales';
import type { Locale, LocaleKey, TranslateVars } from './i18n/locales';
import { ConsoleApiError, ConsoleClient, ConsoleStore } from './store/console-store';
import type { MemberAction, SessionMeta, SystemSettings, UiLocalState } from './store/console-store';

const client = new ConsoleClient();
const store = new ConsoleStore();

const THEME_STORAGE_KEY = 'zen-remote-console.theme';
type Theme = 'light' | 'dark';

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

/** 服务端错误码 → 词典键；未知码一律「出了点问题」 */
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
    case 'NETWORK_ERROR':
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

  // 网关管理页数据：进入视图拉一次；之后的刷新由各动作回调负责
  const isAdmin = state.session !== null && state.session.user.role === 'admin';
  useEffect(() => {
    if (view !== 'admin' || !isAdmin) return;
    let cancelled = false;
    void (async () => {
      try {
        const [settings, users] = await Promise.all([client.adminGetSettings(), client.adminListUsers()]);
        if (!cancelled) {
          store.applyAdminSettings(settings);
          store.applyAdminUsers(users);
        }
      } catch {
        /* 下次进入视图再拉 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, isAdmin]);

  const handleAuth = useCallback(
    async (mode: 'login' | 'signup', email: string, password: string): Promise<void> => {
      setAuthBusy(true);
      setAuthError(null);
      try {
        const result = mode === 'login' ? await client.login(email, password) : await client.signup(email, password);
        const meta: SessionMeta = {
          allowSignup: result.allowSignup,
          maxNetworksPerUser: result.maxNetworksPerUser,
        };
        store.setSession(result.user, meta);
        store.patchUi({ loginPassword: '' }); // 密码不留在草稿里
        await refreshNetworks();
      } catch (err) {
        setAuthError(authErrorToKey(err));
      } finally {
        setAuthBusy(false);
      }
    },
    [refreshNetworks],
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

  // ---------------------------------------------------------------- 动作回调

  const handleMemberAction = useCallback(
    async (networkId: string, nodeId: string, action: MemberAction): Promise<void> => {
      setActionBusy(true);
      try {
        await client.memberTransition(networkId, nodeId, action);
        store.patchUi({ confirmTarget: null });
        await refreshTopology(networkId);
        void refreshNetworks();
      } catch {
        showToast('error.generic');
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
      } catch {
        showToast('error.generic');
      } finally {
        setActionBusy(false);
      }
    },
    [refreshTopology, refreshNetworks, showToast],
  );

  const handlePatchNetwork = useCallback(
    async (networkId: string, patch: NetworkPatchInput): Promise<void> => {
      setActionBusy(true);
      try {
        await client.patchNetwork(networkId, patch);
        await refreshTopology(networkId);
        await refreshNetworks();
        showToast('toast.saved');
      } catch {
        showToast('error.generic');
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
      } catch {
        showToast('error.generic');
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
        showToast('toast.networkDeleted');
      } catch {
        showToast('error.generic');
      } finally {
        setActionBusy(false);
      }
    },
    [refreshNetworks, showToast],
  );

  const handleCreateNetwork = useCallback(
    async (name: string): Promise<void> => {
      setActionBusy(true);
      try {
        const created = await client.createNetwork({ name: name.trim() });
        store.patchUi({ dialog: null, draftNetworkName: '' });
        await refreshNetworks();
        setSelectedNetworkId(created.id);
      } catch {
        showToast('error.generic');
      } finally {
        setActionBusy(false);
      }
    },
    [refreshNetworks, showToast],
  );

  const handleCopyInvite = useCallback(
    (joinUri: string): void => {
      void navigator.clipboard
        .writeText(joinUri)
        .then(() => showToast('toast.inviteCopied'))
        .catch(() => showToast('toast.copyFailed'));
    },
    [showToast],
  );

  const handlePatchSettings = useCallback(
    async (patch: Partial<SystemSettings>): Promise<void> => {
      try {
        const updated = await client.adminPatchSettings(patch);
        store.applyAdminSettings(updated);
        showToast('toast.saved');
      } catch {
        showToast('error.generic');
      }
    },
    [showToast],
  );

  const handleSetUserActive = useCallback(
    async (userId: string, active: boolean): Promise<void> => {
      try {
        await client.adminSetUserActive(userId, active);
        store.applyAdminUsers(await client.adminListUsers());
      } catch {
        showToast('error.generic');
      }
    },
    [showToast],
  );

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
        ui={state.ui}
        onUi={handleUi}
        busy={authBusy}
        errorKey={authError ?? (bootFailed ? 'error.network' : null)}
        onSubmit={(mode, email, password) => void handleAuth(mode, email, password)}
      />
    );
  }

  const selected = state.networks.find((n) => n.id === selectedNetworkId) ?? null;

  return (
    <div className="app-shell">
      <TopBar
        t={t}
        user={state.session.user}
        networks={state.networks}
        selectedNetworkId={selectedNetworkId}
        onSelectNetwork={setSelectedNetworkId}
        onCreateNetwork={handleCreateNetworkOpen}
        view={view}
        onChangeView={setView}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onToggleLocale={handleToggleLocale}
        onLogout={() => void handleLogout()}
        ui={state.ui}
        onUi={handleUi}
      />
      <main className="app-content">
        {view === 'admin' && isAdmin ? (
          <AdminView
            t={t}
            users={state.adminUsers}
            settings={state.adminSettings}
            currentUserId={state.session.user.id}
            ui={state.ui}
            onUi={handleUi}
            onPatchSettings={(patch) => void handlePatchSettings(patch)}
            onSetUserActive={(userId, active) => void handleSetUserActive(userId, active)}
          />
        ) : selected !== null ? (
          <NetworkView
            t={t}
            network={selected}
            topology={state.topology[selected.id] ?? null}
            ui={state.ui}
            onUi={handleUi}
            busy={actionBusy}
            onCopyInvite={() => handleCopyInvite(selected.joinUri)}
            onPatchNetwork={(patch) => void handlePatchNetwork(selected.id, patch)}
            onDeleteNetwork={() => void handleDeleteNetwork(selected.id)}
            onRotateInviteKey={() => void handleRotateInviteKey(selected.id)}
            onMemberAction={(nodeId, action) => void handleMemberAction(selected.id, nodeId, action)}
            onRemoveMember={(nodeId) => void handleRemoveMember(selected.id, nodeId)}
          />
        ) : (
          <section className="empty-state">
            <p className="empty-title">{t('network.emptyTitle')}</p>
            <p className="empty-hint">{t('network.emptyHint')}</p>
          </section>
        )}
      </main>

      {state.ui.dialog === 'new-network' && (
        <NewNetworkModal
          t={t}
          ui={state.ui}
          onUi={handleUi}
          busy={actionBusy}
          onCreate={(name) => void handleCreateNetwork(name)}
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
