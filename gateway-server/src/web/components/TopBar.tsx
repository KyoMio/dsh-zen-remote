// 顶栏（PG-6a）：56px sticky，左侧品牌 + 网络切换下拉（管理视图换成标题），
// 右侧唯一控件是账号按钮。两个菜单共用一套行为：
//   ↑/↓ 在菜单项间循环移动焦点、Esc 关闭并把焦点还给触发按钮、点击外部关闭。
// 菜单开关状态存 store 的 ui 切片——SSE 合并不动这个切片，打开中的菜单
// 不会被实时推送冲掉。样式受 Single Lift Rule 约束：只有菜单带投影。
// GC-8：图标统一换 Icons.tsx 的 1.5px 线性矢量（裸 ▾ ✓ 与旧 <svg> 品牌标记
// 全部替换）；账号菜单身份区展示当前用户组与到期（含到期回退提醒），并新增
// 「账号设置…」入口（打开 AccountSettingsModal）；「网关管理」入口严格仅
// role === 'admin' 渲染，普通用户不可见、不可点。
// GC-10b：切换菜单底部展示当前用户组建网额度摘要（管理员显示「不限」），
// 普通用户达组上限时禁用「新建网络…」并以 title 提示组上限；↑/↓ 焦点循环
// 与打开预聚焦均跳过禁用项（:not([disabled])），键盘导航不会卡死。
import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';

import { effectiveNetworkMaxPeers, formatQuotaExpiry } from '../format';
import type { Locale, TranslateFn } from '../i18n/locales';
import { deriveNetworkCounts } from '../store/console-store';
import type { NetworkView, PublicUser, TopologySnapshot, UiLocalState, UserQuotaSummary } from '../store/console-store';
import { CheckIcon, ChevronIcon, ServerIcon } from './Icons';

export type ViewKind = 'networks' | 'admin';

export interface TopBarProps {
  t: TranslateFn;
  /** formatQuotaExpiry 的语言入参 */
  locale: Locale;
  user: PublicUser;
  /** 当前登录用户的有效配额视图（账号菜单身份区展示用户组与到期） */
  quota: UserQuotaSummary | null;
  networks: NetworkView[];
  /** 全部拓扑切片（PC-20）：当前网络的计数改由它的 SSE 快照事实派生，其余网络回落 REST 值 */
  topology: Readonly<Record<string, TopologySnapshot>>;
  selectedNetworkId: string | null;
  onSelectNetwork: (id: string) => void;
  onCreateNetwork: () => void;
  view: ViewKind;
  onChangeView: (view: ViewKind) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onToggleLocale: () => void;
  onLogout: () => void;
  /** 打开「账号设置」弹窗（App 据 ui.dialog === 'account-settings' 渲染） */
  onOpenAccountSettings: () => void;
  ui: UiLocalState;
  onUi: (patch: Partial<UiLocalState>) => void;
}

/** 菜单项焦点循环：↑/↓ 移动，越过首尾回绕；被禁用的菜单项（GC-10b 建网达上限）
 * 不参与循环——`:not([disabled])` 过滤，↑/↓ 不会把焦点卡死在禁用按钮上 */
function cycleMenuFocus(menu: HTMLElement | null, offset: 1 | -1): void {
  if (menu === null) return;
  const items = Array.from(menu.querySelectorAll<HTMLElement>('[data-menu-item]:not([disabled])'));
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

/** 两个菜单共用的行为：触发器/菜单引用、打开即聚焦首项、键盘导航、点击外部关闭 */
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

  // 打开即聚焦首个可用项：菜单与本次 effect 同一轮提交，DOM 已就绪，直接 focus
  // 即可（↑/↓ 的焦点循环从 document.activeElement 出发，预聚焦让键盘路径从首项
  // 开始；同样跳过禁用项，达上限时键盘用户从网络行开始而不是卡在禁用的新建项）
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[data-menu-item]:not([disabled])')?.focus();
  }, [open]);

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

/** 品牌标识：统一矢量图标集里的网关机架（GC-8 起不再手写裸 <svg>） */
function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <ServerIcon size={14} />
    </span>
  );
}

export function TopBar(props: TopBarProps) {
  const { t, locale, user, quota, networks, topology, selectedNetworkId, onSelectNetwork, onCreateNetwork, view, onChangeView } = props;
  const { theme, onToggleTheme, onToggleLocale, onLogout, onOpenAccountSettings, ui, onUi } = props;

  const closeSwitcher = useCallback(() => onUi({ networkSwitcherOpen: false }), [onUi]);
  const closeAccount = useCallback(() => onUi({ accountMenuOpen: false }), [onUi]);

  // 两菜单互斥展开：打开其一先关掉另一个（menu 只有一处阴影与一处浮层，视觉上也只允许一个）
  const toggleSwitcher = useCallback(
    (): void => onUi({ networkSwitcherOpen: !ui.networkSwitcherOpen, accountMenuOpen: false }),
    [onUi, ui.networkSwitcherOpen],
  );
  const toggleAccount = useCallback(
    (): void => onUi({ accountMenuOpen: !ui.accountMenuOpen, networkSwitcherOpen: false }),
    [onUi, ui.accountMenuOpen],
  );

  const switcher = useMenuBehavior(ui.networkSwitcherOpen, closeSwitcher);
  const account = useMenuBehavior(ui.accountMenuOpen, closeAccount);

  const selected = networks.find((n) => n.id === selectedNetworkId) ?? null;

  // PC-20：当前网络的计数跟随它的 SSE 快照事实（SSE 合并只进 topology 切片，
  // 这里按既有字段口径现算，不回写 networks）；没快照的网络保持 REST 值。
  const selectedSnapshot = selectedNetworkId !== null ? topology[selectedNetworkId] : undefined;

  /** 一行的计数与上限：选中网络用快照派生，其余网络保持 REST 拉到的值 */
  const rowCounts = (network: NetworkView): { totalDevices: number; maxPeers: number } => {
    const snapshot = network.id === selectedNetworkId ? selectedSnapshot : undefined;
    const counts = deriveNetworkCounts(network, snapshot);
    const rawMax = snapshot?.network.maxPeers ?? network.maxPeers;
    return {
      totalDevices: counts.totalDevices,
      maxPeers: effectiveNetworkMaxPeers(rawMax, user.role === 'admin' ? null : quota),
    };
  };
  const selectedCounts = selected !== null ? rowCounts(selected) : null;

  // 建网门槛（GC-10b / ui-ux-spec §3.1）：普通用户建网数达所在组上限时禁用
  // 「新建网络…」；管理员组上限不限（maxNetworks === null）永远可建。
  const quotaCreateBlocked =
    user.role !== 'admin' && quota !== null && quota.maxNetworks !== null && quota.usedNetworks >= quota.maxNetworks;

  return (
    <header className="topbar">
      <BrandMark />
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
            onClick={toggleSwitcher}
          >
            <span className="net-switcher-name">{selected !== null ? selected.name : t('nav.networks')}</span>
            {selected !== null && selectedCounts !== null && (
              <span className="net-switcher-count mono" title={`${t('network.devices')} / ${t('network.deviceLimit')}`}>
                {selectedCounts.totalDevices}/{selectedCounts.maxPeers}
              </span>
            )}
            <span className="chevron" aria-hidden="true">
              <ChevronIcon size={12} />
            </span>
          </button>

          {ui.networkSwitcherOpen && (
            <div className="menu menu-switcher" role="menu" ref={switcher.menuRef} onKeyDown={switcher.onKeyDown}>
              {networks.map((network) => {
                const isCurrent = network.id === selectedNetworkId;
                const counts = rowCounts(network);
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
                      {isCurrent ? <CheckIcon size={12} /> : ''}
                    </span>
                    <span className="menu-item-name">{network.name}</span>
                    <span
                      className="menu-item-count mono"
                      title={`${t('network.devices')} / ${t('network.deviceLimit')}`}
                    >
                      {counts.totalDevices}/{counts.maxPeers}
                    </span>
                  </button>
                );
              })}
              <div className="menu-sep" aria-hidden="true" />
              {/* 建网额度摘要（GC-10b / ui-ux-spec §3.1）：额度行不是菜单项，
                  不参与 ↑/↓ 焦点循环；管理员上限不限时显示「不限」 */}
              {quota !== null && (
                <div role="presentation" style={{ padding: '2px 10px 6px', fontSize: 12.5, color: 'var(--ink-3)' }}>
                  {t('account.networkQuotaSummary', {
                    used: quota.usedNetworks,
                    limit: quota.maxNetworks === null ? t('common.unlimited') : quota.maxNetworks,
                  })}
                  {' · '}
                  {quota.groupName}
                </div>
              )}
              <button
                type="button"
                role="menuitem"
                data-menu-item
                className="menu-item"
                disabled={quotaCreateBlocked}
                title={
                  quotaCreateBlocked && quota !== null && quota.maxNetworks !== null
                    ? `${t('network.groupNetworkCap', { n: quota.maxNetworks })}${quota.isExpiredFallback ? ` · ${t('account.groupExpired')}` : ''}`
                    : undefined
                }
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
          onClick={toggleAccount}
        >
          <span className="avatar" aria-hidden="true">
            {avatarInitial(user.email)}
          </span>
          <span className="account-email">{user.email}</span>
          <span className="chevron" aria-hidden="true">
            <ChevronIcon size={12} />
          </span>
        </button>

        {ui.accountMenuOpen && (
          <div className="menu menu-account" role="menu" ref={account.menuRef} onKeyDown={account.onKeyDown}>
            <div className="account-identity">
              <div className="account-email">{user.email}</div>
              <div className="account-role">
                {user.role === 'admin' ? t('account.role.admin') : t('account.role.user')}
              </div>
              {/* 当前用户组与到期（GC-8）：到期回退默认组时给明确提醒 */}
              {quota !== null && (
                <div className="account-role">
                  {t('account.groupLabel')}：{quota.groupName}
                  {quota.isExpiredFallback
                    ? ` · ${t('account.groupExpired')}`
                    : quota.groupExpiresAt !== null
                      ? ` · ${t('account.groupExpiryAt', { date: formatQuotaExpiry(quota.groupExpiresAt, locale) })}`
                      : ''}
                </div>
              )}
            </div>
            <div className="menu-sep" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              data-menu-item
              className="menu-item"
              onClick={() => {
                onOpenAccountSettings();
                closeAccount();
              }}
            >
              <span className="menu-check" aria-hidden="true" />
              {t('account.settings')}
            </button>
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
                {view === 'networks' ? <CheckIcon size={12} /> : ''}
              </span>
              {t('view.networks')}
            </button>
            {/* 网关管理入口严格仅管理员渲染：普通用户不可见、不可点（GC-8 权限收口） */}
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
                  {view === 'admin' ? <CheckIcon size={12} /> : ''}
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
