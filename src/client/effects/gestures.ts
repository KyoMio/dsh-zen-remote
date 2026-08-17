import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { GO_HOME_EVENT } from '../nav-store.ts'

/** Phone breakpoint — same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)'

/** This plugin's two dismissible sheets (session-info, home workspace/chips
 * picker — MobileHome.tsx's home-sheet hosts both the workspace switcher and
 * the S5 chip-customize list under the same marker). Official popupSelect
 * menus (permission/model) are deliberately excluded — the design spec
 * leaves those mask-tap-only, and they are the suite's own DOM, not ours to
 * add gesture handling to. */
const SHEET_SELECTOR = '[data-mobile-nav="info-sheet"], [data-mobile-nav="home-sheet"]'

const CLOSE_DISTANCE = 80
/** px/ms — a fast flick closes the sheet even short of CLOSE_DISTANCE. */
const CLOSE_VELOCITY = 0.5
/** Below this the drag is a tap/jitter, not yet a pull — avoids hijacking
 * the very first pixels of an upward scroll inside the sheet. */
const DRAG_COMMIT_PX = 4

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** The sheet's own mask sibling — both this plugin's sheets name theirs
 * with a "-mask" suffix (info-mask, home-sheet-mask) and already wire a
 * click handler that calls the sheet's close(). Reusing that handler (a
 * synthetic click) needs no access to the sheet's React state at all.
 * Shared with the S6.1 edge-swipe-back priority chain below — both "drag
 * down to dismiss" and "swipe back from the edge" close a sheet the exact
 * same way. */
function closeSheet(sheet: HTMLElement): void {
  sheet.parentElement?.querySelector<HTMLElement>('[data-mobile-nav$="-mask"]')?.click()
}

/**
 * S6.2 — sheet drag-to-close: this plugin's two own bottom sheets (session
 * info, home workspace picker) support "drag down to dismiss", mirroring
 * the mask-tap close they already have. Official popupSelect menus
 * (permission/model) are excluded on purpose — the design spec leaves them
 * mask-tap-only, and they are the suite's own DOM, not ours to add gesture
 * handling to.
 *
 * touchmove is registered non-passive (unlike the edge-swipe-back gesture
 * below) because this gesture needs to preventDefault once it takes over, so
 * the sheet's own translateY tracks the finger instead of fighting the
 * scroller's native rubber-band. Before that handoff — while the sheet's
 * inner content isn't scrolled to top — nothing is intercepted at all, so
 * a pull down first scrolls the content as normal (spec requirement).
 */
function installSheetDragClose(ctx: ClientContext): void {
  ctx.effect(() => {
    const narrow = window.matchMedia(PHONE_QUERY)
    interface Drag { sheet: HTMLElement; startY: number; lastY: number; startTime: number; dragging: boolean }
    let drag: Drag | null = null

    const settle = (sheet: HTMLElement, close: boolean): void => {
      if (close) {
        sheet.style.transform = ''
        sheet.style.transition = ''
        closeSheet(sheet)
        return
      }
      if (prefersReducedMotion()) {
        sheet.style.transition = 'none'
        sheet.style.transform = ''
        return
      }
      sheet.style.transition = 'transform .22s var(--ds-ease-out, ease-in-out)'
      sheet.style.transform = ''
      const clear = (): void => {
        sheet.style.transition = ''
        sheet.removeEventListener('transitionend', clear)
      }
      sheet.addEventListener('transitionend', clear)
    }

    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) {
        drag = null
        return
      }
      const touch = event.touches[0]
      const target = event.target
      if (touch === undefined || !(target instanceof Element)) {
        drag = null
        return
      }
      const sheet = target.closest<HTMLElement>(SHEET_SELECTOR)
      if (sheet === null) {
        drag = null
        return
      }
      drag = { sheet, startY: touch.clientY, lastY: touch.clientY, startTime: Date.now(), dragging: false }
    }

    const onTouchMove = (event: TouchEvent): void => {
      if (drag === null) return
      const touch = event.touches[0]
      if (touch === undefined) return
      drag.lastY = touch.clientY
      const dy = touch.clientY - drag.startY
      if (!drag.dragging) {
        if (drag.sheet.scrollTop > 0) return
        if (dy <= DRAG_COMMIT_PX) return
        drag.dragging = true
        drag.sheet.style.transition = 'none'
      }
      event.preventDefault()
      drag.sheet.style.transform = `translateY(${Math.max(0, dy)}px)`
    }

    const finish = (): void => {
      if (drag === null) return
      const { sheet, dragging, startY, lastY, startTime } = drag
      drag = null
      if (!dragging) return
      const dy = Math.max(0, lastY - startY)
      const elapsed = Math.max(1, Date.now() - startTime)
      const velocity = dy / elapsed
      settle(sheet, dy > CLOSE_DISTANCE || velocity > CLOSE_VELOCITY)
    }

    const attach = (): void => {
      document.addEventListener('touchstart', onTouchStart, { passive: true })
      document.addEventListener('touchmove', onTouchMove, { passive: false })
      document.addEventListener('touchend', finish, { passive: true })
      document.addEventListener('touchcancel', finish, { passive: true })
    }
    const detach = (): void => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', finish)
      document.removeEventListener('touchcancel', finish)
      drag = null
    }
    if (narrow.matches) attach()
    const onChange = (event: MediaQueryListEvent): void => (event.matches ? attach() : detach())
    narrow.addEventListener('change', onChange)
    return () => {
      narrow.removeEventListener('change', onChange)
      detach()
    }
  }, 'dsh-mobile-nav: sheet drag-to-close')
}

/** Left-edge start zone for S6.1's swipe-back, in CSS px from the viewport's
 * left edge. This used to be dsh-mobile-pwa's own edge-swipe-back hot zone
 * (history.back, useless against an SPA) — that gesture is removed in the
 * same revision that adds this one, so the 24px strip changes owner instead
 * of staying carved out (design doc "手势" row, 2026-08-17 fourth revision). */
const EDGE_ZONE_PX = 24
const EDGE_SWIPE_MIN_DX = 90
const EDGE_SWIPE_RATIO = 1.6

/**
 * dsh-better-sidebar's panel-open read (AGENTS.md pitfall "第三方浮层的开合
 * 态可以纯 CSS `:has()` 读"): the panel's class ends in "_panel" only while
 * open — "_panelHidden" is appended once closed, so the string no longer
 * ends in "_panel" and this selector stops matching. Same anchor
 * MobileSessionHeader.tsx's workbench button and its own close button use.
 */
function betterSidebarPanelOpen(): boolean {
  return document.querySelector('[data-dsh-better-sidebar] [class$="_panel"]') !== null
}

/**
 * S6.1 — left-edge swipe-back priority chain (design doc "手势" row, fourth
 * revision): a swipe starting in the left {@link EDGE_ZONE_PX} always closes
 * the TOPMOST dismissible surface rather than always navigating, so a user
 * mid-workflow (info card open, workbench panel open) gets "close that"
 * instead of "leave the session" from the same gesture. Checked in the
 * design doc's own order:
 *   1. this plugin's session-info sheet, if open
 *   2. this plugin's home sheet (workspace switcher or S5 chip-customize),
 *      if open
 *   3. dsh-better-sidebar's workbench panel, if open (代点 its own toggle —
 *      same anchor MobileSessionHeader.tsx's workbench/close buttons use)
 *   4. otherwise, GO_HOME_EVENT — but only from the session view; the design
 *      doc calls out "在 home 层→无动作" explicitly, and the phone page
 *      stack's current level is read straight off MobileHome's own
 *      `data-view` attribute (no store handle needed here — effects/*.ts is
 *      already all DOM reads, matching every sibling effect in this file).
 */
function handleEdgeSwipeBack(): void {
  const sheet = document.querySelector<HTMLElement>(SHEET_SELECTOR)
  if (sheet !== null) {
    closeSheet(sheet)
    return
  }
  if (betterSidebarPanelOpen()) {
    document.querySelector<HTMLButtonElement>('[data-dsh-better-sidebar] button[class$="_toggleButton"]')?.click()
    return
  }
  if (document.querySelector('[data-mobile-nav="home"]')?.getAttribute('data-view') === 'session') {
    window.dispatchEvent(new CustomEvent(GO_HOME_EVENT))
  }
}

/**
 * S6.1 — left-edge swipe-back gesture install. Passive throughout (never
 * calls preventDefault) and decided purely from the touchstart/touchend
 * endpoints, exactly like the S6.1-predecessor content-area swipe this
 * revision removes — so it never fights vertical (or, at the 24px strip,
 * horizontal chip-row) scrolling, and needs no mid-drag tracking: the design
 * doc explicitly allows "一步到位" over a followed-finger animation.
 */
function installEdgeSwipeBack(ctx: ClientContext): void {
  ctx.effect(() => {
    const narrow = window.matchMedia(PHONE_QUERY)
    let start: { x: number; y: number; eligible: boolean } | null = null

    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) {
        start = null
        return
      }
      const touch = event.touches[0]
      if (touch === undefined) {
        start = null
        return
      }
      start = { x: touch.clientX, y: touch.clientY, eligible: touch.clientX <= EDGE_ZONE_PX }
    }

    const onTouchEnd = (event: TouchEvent): void => {
      const state = start
      start = null
      if (state === null || !state.eligible) return
      const touch = event.changedTouches[0]
      if (touch === undefined) return
      const dx = touch.clientX - state.x
      const dy = touch.clientY - state.y
      if (dx <= EDGE_SWIPE_MIN_DX || Math.abs(dx) <= EDGE_SWIPE_RATIO * Math.abs(dy)) return
      handleEdgeSwipeBack()
    }

    const attach = (): void => {
      document.addEventListener('touchstart', onTouchStart, { passive: true })
      document.addEventListener('touchend', onTouchEnd, { passive: true })
    }
    const detach = (): void => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchend', onTouchEnd)
      start = null
    }
    if (narrow.matches) attach()
    const onChange = (event: MediaQueryListEvent): void => (event.matches ? attach() : detach())
    narrow.addEventListener('change', onChange)
    return () => {
      narrow.removeEventListener('change', onChange)
      detach()
    }
  }, 'dsh-mobile-nav: left-edge swipe-back')
}

/** S6: the two-gesture set — left-edge swipe-back and sheet drag-to-close.
 * Both install/uninstall their own document listeners on the phone
 * breakpoint's matchMedia change, so at >= 768px this is a true no-op (no
 * listeners attached at all), matching every other effect in this file. */
export function installGestures(ctx: ClientContext): void {
  installEdgeSwipeBack(ctx)
  installSheetDragClose(ctx)
}
