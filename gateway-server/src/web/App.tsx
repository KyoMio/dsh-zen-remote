// 控制台应用壳（PG-6a）：启动期 /auth/me 探测 → 登录页或顶栏骨架。
// 登录/注册、登出、主题与语言的切换接线都在这里；网络/网关管理两个视图
// 的正文是 PG-6b/PG-6c 的落点，这里只放数据驱动的页面标题占位。
// store 与 client 是模块级单例：组件树任意重挂载都不会丢状态。
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { LoginView } from './components/LoginView';
import { TopBar } from './components/TopBar';
import type { ViewKind } from './components/TopBar';
import { LOCALE_STORAGE_KEY, resolveLocale, translate } from './i18n/locales';
import type { Locale, LocaleKey, TranslateVars } from './i18n/locales';
import { ConsoleApiError, ConsoleClient, ConsoleStore } from './store/console-store';
import type { SessionMeta, UiLocalState } from './store/console-store';

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

export function App() {
  const state = useSyncExternalStore(store.subscribe, store.getState);

  const [locale, setLocale] = useState<Locale>(readStoredLocale);
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [view, setView] = useState<ViewKind>('networks');
  const [selectedNetworkId, setSelectedNetworkId] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<LocaleKey | null>(null);
  const [bootFailed, setBootFailed] = useState(false);

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

  const refreshNetworks = useCallback(async (): Promise<void> => {
    try {
      store.setNetworks(await client.listNetworks());
    } catch {
      /* 列表拉取失败不打断进入；PG-6b 的视图层会补重试与提示 */
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

  const handleUi = useCallback((patch: Partial<UiLocalState>): void => {
    store.patchUi(patch);
  }, []);

  const handleCreateNetwork = useCallback((): void => {
    // 新建网络弹窗是 PG-6b 的落点；这里先把目标记进 ui 切片
    store.patchUi({ dialog: 'new-network' });
  }, []);

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
        onCreateNetwork={handleCreateNetwork}
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
        {view === 'admin' ? (
          <h2 className="page-title">{t('view.admin')}</h2>
        ) : (
          <h2 className="page-title">{selected !== null ? selected.name : t('nav.networks')}</h2>
        )}
      </main>
    </div>
  );
}
