import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronLeftOutline14, IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import { GO_HOME_EVENT, SESSION_INFO_EVENT } from './nav-store.ts'

/**
 * ic_ds_info_outline_16 — @deepseek-ai/dsh-client-ui-primitives has no
 * info-circle icon (grepped lib/types/icons/index.d.ts, 2026-08-17: 71
 * icons, nearest is IconQuestionOutline14, wrong glyph AND wrong size).
 * Hand-built to the same 16x16 box the rest of the header icon family
 * uses, so the ⓘ button in MobileHeaderUtilities below reads as one
 * family with the workbench button's mirrored IconPanelLeftOutline16
 * (real-device round 2 feedback: "same size (16), same stroke weight").
 */
function IconInfoOutline16({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="8" cy="8" r="6.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="4.7" r="0.95" fill="currentColor" />
      <rect x="7.25" y="6.9" width="1.5" height="4.7" rx="0.75" fill="currentColor" />
    </svg>
  )
}

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
 *
 * Exported: effects/gestures.ts (S6) reuses this exact read for the
 * content-area swipe gesture instead of re-querying the tablist a second
 * way — it runs outside React (a document-level touch listener), so it
 * needs the plain function, not the {@link useViewTabs} hook below.
 */
export function readViewTabs(): ViewTabInfo[] {
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
        <IconChevronLeftOutline14 size={18} />
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
  // Better-sidebar phone close button (S3.1 follow-up, 2026-08-17): the
  // panel's own top-right toggle cluster is hidden below 768px
  // (styles/compat.css.ts) because it duplicates the workbench button
  // below — but that cluster is also the panel's ONLY close control, so
  // hiding it blindly leaves an open panel with no way out. This button is
  // appended straight to document.body, mirroring the existing
  // preview-full-toggle pattern in MobileNavOverlay.tsx (raw DOM, not a
  // React portal — react-dom is not among this plugin's platform-module
  // imports, see AGENTS.md "client import purity"): never inside the
  // panel's own subtree (the third party's React re-renders would wipe
  // it) and never under any transformed/backdrop-filter ancestor (the S4
  // info-card WebKit lesson in AGENTS.md — position:fixed would re-anchor
  // to that ancestor instead of the viewport). It clicks the SAME hidden
  // official toggle the workbench button below uses. Visibility is pure
  // CSS (styles/compat.css.ts: `body:has([data-dsh-better-sidebar]
  // [class$="_panel"])` — the panel's class ends in "_panel" only while
  // open, "_panelHidden" is appended once closed), so this effect only
  // has to guarantee the node exists — no MutationObserver needed to
  // track open/closed state. Icon paths copied verbatim from
  // IconCloseOutline16 (primitives) for the same reason IconInfoOutline16
  // above is hand-built: this button lives outside the React tree, so it
  // cannot render a primitives component directly.
  useEffect(() => {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.mobileNav = 'better-sidebar-close'
    button.setAttribute('aria-label', t('workbenchClose'))
    button.title = t('workbenchClose')
    // Bottom-center labeled pill (real-device follow-up, 2026-08-17): the
    // icon markup is a static trusted string (safe as innerHTML), but the
    // locale label is untrusted-shaped text — built as a real text node via
    // textContent, not string-concatenated into the same innerHTML, so a
    // translation can never be parsed as markup.
    button.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">'
      + '<path d="M14.1168 13.197L13.197 14.1167L1.8833 2.80303L2.80309 1.88324L14.1168 13.197Z" fill="currentColor"/>'
      + '<path d="M13.197 1.88326L14.1168 2.80305L2.80309 14.1168L1.8833 13.197L13.197 1.88326Z" fill="currentColor"/>'
      + '</svg>'
    const label = document.createElement('span')
    label.textContent = t('workbenchClose')
    button.appendChild(label)
    const onClick = (): void => {
      document.querySelector<HTMLButtonElement>('[data-dsh-better-sidebar] button[class$="_toggleButton"]')?.click()
    }
    button.addEventListener('click', onClick)
    document.body.appendChild(button)
    return () => {
      button.removeEventListener('click', onClick)
      button.remove()
    }
  }, [t])

  return (
    <>
      <button
        type="button"
        data-mobile-nav="header-info"
        aria-label={t('sessionInfo')}
        title={t('sessionInfo')}
        onClick={() => window.dispatchEvent(new CustomEvent(SESSION_INFO_EVENT))}
      >
        <IconInfoOutline16 size={20} />
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
        {/* No IconPanelRightOutline16 in primitives (grepped lib/types/
            icons/index.d.ts, 2026-08-17) — mirrored via CSS (styles/
            header.css.ts) instead of hand-drawing a new glyph. The panel
            icon's "left column" reads as "right column" flipped, which is
            exactly the workbench's own right-side-panel semantics. */}
        <IconPanelLeftOutline16 size={20} />
      </button>
    </>
  )
}
