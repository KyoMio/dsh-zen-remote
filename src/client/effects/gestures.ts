import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { readViewTabs } from '../MobileSessionHeader.tsx'

/** Phone breakpoint — same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)'

/** The official message scroll region (AGENTS.md: the real scroller behind
 * `data-chat-flow`, not ChatView's own `.scroll` which the suite forces to
 * `overflow: visible`). Scoped with `[data-phase]` exactly like every other
 * reader of this element in styles/layout.css.ts and styles/home.css.ts. */
const CONTENT_SELECTOR = '[data-phase] [class$="_scrollBody"]'

/** The sticky composer footer lives INSIDE the scroll body (AGENTS.md
 * S4.1 pitfall); a horizontal drag started on the input itself must not be
 * read as a page-turn gesture. */
const COMPOSER_SEAT_SELECTOR = '[class$="_composerSeat"]'

/** This plugin's two dismissible sheets (session-info, home workspace
 * picker). Official popupSelect menus (permission/model) are deliberately
 * excluded — the design spec leaves those mask-tap-only. */
const SHEET_SELECTOR = '[data-mobile-nav="info-sheet"], [data-mobile-nav="home-sheet"]'

/** Every dismissible surface this plugin or the official suite can have
 * open at once. Content-area swipe must not fight a control underneath one
 * of these — both of our own sheets render unconditionally (React returns
 * null when closed, see MobileSessionInfo.tsx / MobileHome.tsx), so their
 * presence in the DOM IS their open state, no extra tracking needed. */
function anyOverlayOpen(): boolean {
  return document.querySelector(
    '[data-mobile-nav="info-layer"], [data-mobile-nav="home-sheet-layer"], [role="menu"], [aria-modal="true"]',
  ) !== null
}

/**
 * Walks from `el` up to (not including) `boundary`, true if any ancestor
 * can itself scroll horizontally — code blocks, wide tables, the stats
 * strip's own horizontal scroller. Generic scrollWidth/overflow-x check
 * rather than hardcoding selectors: covers every "chip row" and markdown
 * element in this stylesheet without keeping a duplicate list in sync.
 */
function hasHorizontalScrollAncestor(el: Element, boundary: Element): boolean {
  let node: Element | null = el
  while (node !== null && node !== boundary) {
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflowX = getComputedStyle(node).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll') return true
    }
    node = node.parentElement
  }
  return false
}

const SWIPE_MIN_DX = 60
const SWIPE_RATIO = 1.6
/** pwa's edge-swipe-back hot zone (dsh-mobile-pwa touch-gestures.js) — never ours to take. */
const EDGE_GUARD = 24

/**
 * S6.1 — content-area swipe: a horizontal drag across the message scroll
 * region switches Chat/Trajectory by clicking the official (hidden)
 * tablist, the same "no public setView" workaround MobileSessionHeader.tsx
 * already uses for the header's own view row (design doc Appendix C).
 *
 * Passive, and this never calls preventDefault — the whole gesture is
 * decided from the touchstart/touchend endpoints, never mid-drag, so
 * vertical scrolling of the message list is completely unaffected. With
 * exactly two views, "the other tab" is the only possible target regardless
 * of swipe direction, so direction never needs to be computed — this
 * mirrors MobileHeaderActions' own `tabs.find((tab) => !tab.active)`.
 */
function installContentSwipe(ctx: ClientContext): void {
  ctx.effect(() => {
    const narrow = window.matchMedia(PHONE_QUERY)
    let start: { x: number; y: number; eligible: boolean } | null = null

    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) {
        start = null
        return
      }
      const touch = event.touches[0]
      const target = event.target
      if (touch === undefined || !(target instanceof Element)) {
        start = null
        return
      }
      const contentEl = target.closest(CONTENT_SELECTOR)
      const eligible = contentEl !== null
        && touch.clientX >= EDGE_GUARD
        && target.closest(COMPOSER_SEAT_SELECTOR) === null
        && !anyOverlayOpen()
        && !hasHorizontalScrollAncestor(target, contentEl)
      start = { x: touch.clientX, y: touch.clientY, eligible }
    }

    const onTouchEnd = (event: TouchEvent): void => {
      const state = start
      start = null
      if (state === null || !state.eligible) return
      const touch = event.changedTouches[0]
      if (touch === undefined) return
      const dx = touch.clientX - state.x
      const dy = touch.clientY - state.y
      if (Math.abs(dx) <= SWIPE_MIN_DX || Math.abs(dx) <= SWIPE_RATIO * Math.abs(dy)) return
      readViewTabs().find((tab) => !tab.active)?.el.click()
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
  }, 'dsh-mobile-nav: content-area swipe (Chat/Trajectory)')
}

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
 * synthetic click) needs no access to the sheet's React state at all. */
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
 * touchmove is registered non-passive (unlike the content swipe above)
 * because this gesture needs to preventDefault once it takes over, so the
 * sheet's own translateY tracks the finger instead of fighting the
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

/** S6: the two-gesture set — content-area swipe and sheet drag-to-close.
 * Both install/uninstall their own document listeners on the phone
 * breakpoint's matchMedia change, so at >= 768px this is a true no-op (no
 * listeners attached at all), matching every other effect in this file. */
export function installGestures(ctx: ClientContext): void {
  installContentSwipe(ctx)
  installSheetDragClose(ctx)
}
