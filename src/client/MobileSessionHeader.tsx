import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronLeftOutline14, IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import { GO_HOME_EVENT, SESSION_INFO_EVENT } from './nav-store.ts'

/** Full props for the session header's back button + view-switch row. */
export type MobileHeaderActionsProps =
  & PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<typeof NS>

/** One tab read off the official (now visually hidden) Chat/Trajectory tablist. */
export interface ViewTabInfo {
  label: string
  active: boolean
  el: HTMLButtonElement
}

/**
 * Reads the official session-header tablist by role/aria only (no hashed
 * classes) — the plan's one sanctioned official-DOM read: ChatStore's view
 * selection has no public setter (design doc Appendix C), so switching
 * views means clicking the official tab button ourselves.
 */
function readViewTabs(): ViewTabInfo[] {
  const list = document.querySelector('header [role="tablist"]')
  if (list === null) return []
  return [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map((el) => ({
    label: el.textContent ?? '',
    active: el.getAttribute('aria-selected') === 'true',
    el,
  }))
}

/**
 * Live view-tab mirror. The tablist mounts/unmounts with the session header
 * and its `aria-selected` flips on every view switch (ours or the suite's
 * own), so a MutationObserver — not a one-time read — keeps the mirror
 * current. Scoped to `document.body` like the existing aionui-compat
 * effects (styles/aionui-compat.ts): the tablist itself may not exist yet
 * at mount time.
 *
 * Exported: MobileSessionInfo.tsx (S4) reuses this exact hook for the info
 * sheet's Chat/Trajectory segmented control instead of re-reading the
 * tablist a second way.
 */
export function useViewTabs(): ViewTabInfo[] {
  const [tabs, setTabs] = useState<ViewTabInfo[]>(() => [])
  useEffect(() => {
    const sync = (): void => setTabs(readViewTabs())
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-selected'],
      childList: true,
    })
    return () => observer.disconnect()
  }, [])
  return tabs
}

/**
 * Session header, left lane: the back button (returns the phone page stack
 * to the session list) plus the "current view + dots" row that mirrors the
 * hidden official tablist. Both render unconditionally; CSS
 * (styles/header.css.ts) keeps them hidden at >= 768px so the tablet drawer
 * and the desktop layout stay exactly as they were.
 */
export function MobileHeaderActions({ t }: MobileHeaderActionsProps) {
  const tabs = useViewTabs()
  const active = tabs.find((tab) => tab.active) ?? tabs[0]
  return (
    <>
      <button
        type="button"
        data-mobile-nav="header-back"
        aria-label={t('backToList')}
        title={t('backToList')}
        onClick={() => window.dispatchEvent(new CustomEvent(GO_HOME_EVENT))}
      >
        <IconChevronLeftOutline14 size={14} />
      </button>
      {tabs.length > 1 && active !== undefined && (
        <button
          type="button"
          data-mobile-nav="header-viewrow"
          aria-label={t('switchView')}
          onClick={() => tabs.find((tab) => !tab.active)?.el.click()}
        >
          <span data-mobile-nav="header-viewrow-label">{active.label}</span>
          <span data-mobile-nav="header-viewrow-dots" aria-hidden="true">
            {tabs.map((tab, index) => (
              <i key={index} data-active={tab.active ? '' : undefined} />
            ))}
          </span>
        </button>
      )}
    </>
  )
}

/** Full props for the session header's right-edge utility buttons. */
export type MobileHeaderUtilitiesProps =
  & PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>

/**
 * Session header, right lane: the session-info entry (S4 owns the actual
 * sheet — this fires a hook event for it to pick up) and the workbench
 * entry, which triggers dsh-better-sidebar's own toggle. There is no public
 * API for "open the panel" (BetterSidebarService.openTab only auto-expands
 * for a content open, not a bare type-only open), so this clicks the
 * plugin's real toggle button through a stable, non-hashed anchor: its root
 * mount marker `[data-dsh-better-sidebar]` plus the `_toggleButton` class
 * suffix (verified live: 2026-08-17). Safe no-op when the plugin, or any
 * other workbench-style plugin sharing that convention, is not installed.
 */
export function MobileHeaderUtilities({ t }: MobileHeaderUtilitiesProps) {
  return (
    <>
      <button
        type="button"
        data-mobile-nav="header-info"
        aria-label={t('sessionInfo')}
        title={t('sessionInfo')}
        onClick={() => window.dispatchEvent(new CustomEvent(SESSION_INFO_EVENT))}
      >
        <span aria-hidden="true">ⓘ</span>
      </button>
      <button
        type="button"
        data-mobile-nav="header-workbench"
        aria-label={t('workbench')}
        title={t('workbench')}
        onClick={() => {
          document.querySelector<HTMLButtonElement>('[data-dsh-better-sidebar] button[class$="_toggleButton"]')?.click()
        }}
      >
        <IconPanelLeftOutline16 size={16} />
      </button>
    </>
  )
}
