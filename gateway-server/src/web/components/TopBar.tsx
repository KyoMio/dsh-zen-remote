// 顶栏（PG-6a）：56px sticky，左侧品牌 + 网络切换下拉（管理视图换成标题），
// 右侧唯一控件是账号按钮。两个菜单共用一套行为：
//   ↑/↓ 在菜单项间循环移动焦点、Esc 关闭并把焦点还给触发按钮、点击外部关闭。
// 菜单开关状态存 store 的 ui 切片——SSE 合并不动这个切片，打开中的菜单
// 不会被实时推送冲掉。样式受 Single Lift Rule 约束：只有菜单带投影。
import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';

import type { TranslateFn } from '../i18n/locales';
import type { NetworkView, PublicUser, UiLocalState } from '../store/console-store';

export type ViewKind = 'networks' | 'admin';

export interface TopBarProps {
  t: TranslateFn;
  user: PublicUser;
  networks: NetworkView[];
  selectedNetworkId: string | null;
  onSelectNetwork: (id: string) => void;
  onCreateNetwork: () => void;
  view: ViewKind;
  onChangeView: (view: ViewKind) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onToggleLocale: () => void;
  onLogout: () => void;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
}

/** 菜单项焦点循环：↑/↓ 移动，越过首尾回绕 */
function cycleMenuFocus(menu: HTMLElement | null, offset: 1 | -1): void {
  if (menu === null) return;
  const items = Array.from(menu.querySelectorAll<HTMLElement>('[data-menu-item]'));
  if (items.length === 0) return;
  const current = document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
  let next: number;
  if (current === -1) {
    next = offset === 1 ? 0 : items.length - 1;
  } else {
    next = (current + offset + items.length) % items.length;
  }
  items[next]?.focus();
}

/** 两个菜单共用的行为：触发器/菜单引用、键盘导航、点击外部关闭 */
function useMenuBehavior(open: boolean, close: () => void) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, close]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        triggerRef.current?.focus();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        cycleMenuFocus(menuRef.current, 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        cycleMenuFocus(menuRef.current, -1);
      }
    },
    [close],
  );

  return { triggerRef, menuRef, onKeyDown };
}

function avatarInitial(email: string): string {
  return (email.charAt(0) || '?').toUpperCase();
}

export function TopBar(props: TopBarProps) {
  const { t, user, networks, selectedNetworkId, onSelectNetwork, onCreateNetwork, view, onChangeView } = props;
  const { theme, onToggleTheme, onToggleLocale, onLogout, ui, onUi } = props;

  const closeSwitcher = useCallback(() => onUi({ networkSwitcherOpen: false }), [onUi]);
  const closeAccount = useCallback(() => onUi({ accountMenuOpen: false }), [onUi]);

  const switcher = useMenuBehavior(ui.networkSwitcherOpen, closeSwitcher);
  const account = useMenuBehavior(ui.accountMenuOpen, closeAccount);

  const selected = networks.find((n) => n.id === selectedNetworkId) ?? null;

  return (
    <header className="topbar">
      <span className="brand-mark" aria-hidden="true">
        Z
      </span>
      <span className="brand-title">{t('app.title')}</span>
      <span className="topbar-divider" aria-hidden="true" />

      {view === 'admin' ? (
        <h1 className="topbar-title">{t('view.admin')}</h1>
      ) : (
        <div className="switcher-wrap">
          <button
            type="button"
            ref={switcher.triggerRef}
            className="net-switcher"
            aria-haspopup="menu"
            aria-expanded={ui.networkSwitcherOpen}
            onClick={() => onUi({ networkSwitcherOpen: !ui.networkSwitcherOpen })}
          >
            <span className="net-switcher-name">{selected !== null ? selected.name : t('nav.networks')}</span>
            {selected !== null && (
              <span className="net-switcher-count mono">
                {selected.onlineDevices}/{selected.totalDevices}
              </span>
            )}
            <span className="chevron" aria-hidden="true">
              ▾
            </span>
          </button>

          {ui.networkSwitcherOpen && (
            <div className="menu menu-switcher" role="menu" ref={switcher.menuRef} onKeyDown={switcher.onKeyDown}>
              {networks.map((network) => {
                const isCurrent = network.id === selectedNetworkId;
                return (
                  <button
                    key={network.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isCurrent}
                    data-menu-item
                    className="menu-item"
                    onClick={() => {
                      onSelectNetwork(network.id);
                      closeSwitcher();
                    }}
                  >
                    <span className="menu-check" aria-hidden="true">
                      {isCurrent ? '✓' : ''}
                    </span>
                    <span className="menu-item-name">{network.name}</span>
                    <span
                      className="menu-item-count mono"
                      title={`${t('summary.onlineDevices')} / ${t('network.devices')}`}
                    >
                      {network.onlineDevices}/{network.totalDevices}
                    </span>
                  </button>
                );
              })}
              <div className="menu-sep" aria-hidden="true" />
              <button
                type="button"
                role="menuitem"
                data-menu-item
                className="menu-item"
                onClick={() => {
                  onCreateNetwork();
                  closeSwitcher();
                }}
              >
                <span className="menu-check" aria-hidden="true" />
                <span className="menu-item-name">+ {t('network.createNew')}</span>
              </button>
            </div>
          )}
        </div>
      )}

      <span className="topbar-spacer" />

      <div className="switcher-wrap">
        <button
          type="button"
          ref={account.triggerRef}
          className="account-button"
          aria-haspopup="menu"
          aria-expanded={ui.accountMenuOpen}
          onClick={() => onUi({ accountMenuOpen: !ui.accountMenuOpen })}
        >
          <span className="avatar" aria-hidden="true">
            {avatarInitial(user.email)}
          </span>
          <span className="account-email">{user.email}</span>
          <span className="chevron" aria-hidden="true">
            ▾
          </span>
        </button>

        {ui.accountMenuOpen && (
          <div className="menu menu-account" role="menu" ref={account.menuRef} onKeyDown={account.onKeyDown}>
            <div className="account-identity">
              <div className="account-email">{user.email}</div>
              <div className="account-role">
                {user.role === 'admin' ? t('account.role.admin') : t('account.role.user')}
              </div>
            </div>
            <div className="menu-sep" aria-hidden="true" />
            <button
              type="button"
              role="menuitemradio"
              aria-checked={view === 'networks'}
              data-menu-item
              className="menu-item"
              onClick={() => {
                onChangeView('networks');
                closeAccount();
              }}
            >
              <span className="menu-check" aria-hidden="true">
                {view === 'networks' ? '✓' : ''}
              </span>
              {t('view.networks')}
            </button>
            {user.role === 'admin' && (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={view === 'admin'}
                data-menu-item
                className="menu-item"
                onClick={() => {
                  onChangeView('admin');
                  closeAccount();
                }}
              >
                <span className="menu-check" aria-hidden="true">
                  {view === 'admin' ? '✓' : ''}
                </span>
                {t('view.admin')}
              </button>
            )}
            <div className="menu-sep" aria-hidden="true" />
            <button type="button" role="menuitem" data-menu-item className="menu-item" onClick={onToggleTheme}>
              <span className="menu-item-label">{t('account.darkMode')}</span>
              <span className="menu-item-state">{theme === 'dark' ? t('account.on') : t('account.off')}</span>
            </button>
            <button type="button" role="menuitem" data-menu-item className="menu-item" onClick={onToggleLocale}>
              <span className="menu-item-label">{t('account.language')}</span>
            </button>
            <div className="menu-sep" aria-hidden="true" />
            <button type="button" role="menuitem" data-menu-item className="menu-item" onClick={onLogout}>
              <span className="menu-check" aria-hidden="true" />
              {t('account.logout')}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
