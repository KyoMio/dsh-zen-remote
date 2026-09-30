import type { ClientContext } from '../compat/types.ts'

/** Phone breakpoint — the same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)'

/**
 * The permission trigger, addressed the way composer.css.ts addresses the
 * whole permission seat: a structured slot plus the build-suffix trigger
 * class (DSH 0.2.0 keeps both). The trigger carries NO aria-expanded and
 * NO aria-controls on 0.2.0 (the Menu primitive portals its list to body
 * and links nothing back), so the click is the only open signal there is.
 */
const TRIGGER_SELECTOR = '[data-slot="conversation.input.permission"] button[class$="_trigger"]'

/**
 * What the Menu primitive portals on 0.2.0: a `role=menu` div DIRECTLY under
 * body, carrying `data-menu-material` and a randomized `--dsh-menu-anchor`
 * (a per-instance useId) but NO id and no back-reference from the trigger —
 * there is no pure-CSS way to pick OUR menu out of the portal crowd: the
 * host has MANY `portal: true` Menus (agent-preset, chat preference rows,
 * the Enter-behavior row, the workspace sidebar's 「…」, open-in-app,
 * deliverables, the copy button's confirm, …), and none of them may become
 * a bottom sheet. That is why this effect exists: a click on the permission
 * trigger arms a short window and the next body-level menu to land is OURS
 * to mark — while a marked menu still on the page (the close click) keeps
 * the window shut.
 */
const PORTAL_MENU_SELECTOR = 'body > div[role="menu"]'

/** The marker composer.css.ts section 4 styles into the bottom sheet. */
const SHEET_MARKER = 'data-zen-sheet'
const SHEET_VALUE = 'perm'

/** The DOM face the two pure decisions below read — structural, so the
 * tests drive them with plain objects instead of a DOM. */
export interface PermissionSheetCandidate {
  matches(selectors: string): boolean
  getAttribute(name: string): string | null
  /** A truthy `closest` result means the click started in the seat. */
  closest(selectors: string): unknown
}

/**
 * Whether ONE body-level node is a portal menu that does not yet carry the
 * sheet marker. Pure over the node's own methods: `matches` answers the
 * body-level role=menu shape, `getAttribute` the marker.
 */
export function isUnmarkedPortalMenu(node: PermissionSheetCandidate): boolean {
  return node.matches(PORTAL_MENU_SELECTOR) && node.getAttribute(SHEET_MARKER) === null
}

/**
 * Whether one click event's target arms the marking window: the phone shell
 * only, and only a click that started inside the permission seat's trigger.
 * Any other button — the sidebar's 「…」, a copy button — never arms, so
 * the menus they open are never marked.
 */
export function clickArmsPermissionSheet(target: PermissionSheetCandidate | null | undefined, phoneMatches: boolean): boolean {
  if (!phoneMatches) return false
  const seat = target?.closest(TRIGGER_SELECTOR)
  return seat !== undefined && seat !== null
}

/**
 * How long an OPEN click stays armed. The portal lands in the same React
 * commit as the state flip, so milliseconds of real latency; the window is
 * consumed by the menu that opens with it, or expires on its own — the
 * close path never arms at all (the marked menu is still on the page, see
 * the guard in onCaptureClick), so the ceiling's only job is retiring a
 * window whose menu never came.
 */
const ARM_MS = 1_500

/**
 * T70: turn the portaled permission menu into the bottom sheet composer.css
 * section 4 promises, on DSH 0.2.0. Up to 0.1.7 the permission menu rendered
 * inside the permission seat and the stylesheet's descendant selectors
 * reached it; 0.2.0 portals it to body (`portal: true` on the Menu), the
 * selectors stopped matching, and the phone got a tiny floating popup. The
 * host offers no stable attribute to key the portal off — the anchor is a
 * per-instance useId, there is no id and no aria-controls — so this effect
 * marks it: the trigger's click arms a window, the observer stamps the next
 * body-level menu with `data-zen-sheet="perm"`, and the stylesheet (which
 * only the phone shell loads) turns THAT into the sheet. The portal menu
 * unmounts on close, so the marker's lifetime is exactly the menu's; the
 * 0.1.7 inline structure keeps working through the untouched descendant
 * selectors, and the desktop shell never loads this stylesheet at all.
 */
export function installPermissionSheet(ctx: ClientContext): void {
  ctx.effect(() => {
    const phone = window.matchMedia(PHONE_QUERY)
    let armed = false
    let armTimer: ReturnType<typeof setTimeout> | undefined

    const disarm = (): void => {
      armed = false
      if (armTimer !== undefined) {
        clearTimeout(armTimer)
        armTimer = undefined
      }
    }

    const onCaptureClick = (event: Event): void => {
      const target = event.target instanceof Element ? event.target : null
      if (!clickArmsPermissionSheet(target, phone.matches)) return
      // T70-fix: the trigger TOGGLES. A click that CLOSES the menu lands
      // while the marked menu is still in the DOM (capture runs before the
      // host's own handler unmounts it) — arming there would leave a live
      // 1.5 s window with no menu coming to consume it, and any unrelated
      // body-level menu opening inside that window would be mis-marked as
      // ours. A marked menu present at click time means this click can only
      // be the close (or a no-op re-open), never an opening we must catch.
      if (document.querySelector(`${PORTAL_MENU_SELECTOR}[${SHEET_MARKER}="${SHEET_VALUE}"]`) !== null) return
      armed = true
      if (armTimer !== undefined) clearTimeout(armTimer)
      armTimer = setTimeout(disarm, ARM_MS)
    }

    /** Mark it if this tick is armed; one menu consumes the arm. */
    const markIfArmed = (root: Element): void => {
      if (!armed) return
      disarm()
      root.setAttribute(SHEET_MARKER, SHEET_VALUE)
    }

    // Capture phase: the host's own handlers may stop the click's bubble
    // (the trigger toggles `open` itself), so listen on the document in
    // capture and never depend on propagation reaching us.
    document.addEventListener('click', onCaptureClick, true)
    const observer = new MutationObserver((records) => {
      if (!armed) return
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && isUnmarkedPortalMenu(node)) markIfArmed(node)
        }
      }
    })
    observer.observe(document.body, { childList: true })

    return () => {
      document.removeEventListener('click', onCaptureClick, true)
      observer.disconnect()
      disarm()
      // A still-open marked menu outliving this effect keeps its marker only
      // until the user closes it (the element unmounts); scrubbing here
      // would fight a React commit mid-flight for no visual gain.
    }
  }, 'dsh-mobile-nav: permission sheet marker')
}
