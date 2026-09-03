/**
 * Lay each official header trigger transparently over the activity pill that
 * stands in for it, so a real finger tap lands on the official element.
 *
 * Why not just forward the tap (what this replaced): DSH 0.1.1's subagent
 * trigger only reacts to TRUSTED input. Measured on device 2026-08-21 —
 * `.click()`, and synthetic `pointerdown`/`mousedown`/`pointerup`, all leave
 * `aria-expanded` at "false"; a CDP-dispatched real touch at the same point
 * opens it. That was verified with every plugin style override stripped off
 * the trigger, so it is the event path, not our CSS. Any design that scripts
 * the click is therefore dead, and this one moves the real control instead.
 *
 * Why this is now cheap: in 0.1.1 the popover portals to <body> as a
 * `position: fixed` layer (`ZKlsPq_menu`, z-index 100) and positions itself
 * from the trigger's viewport rect — measured 336px wide, fully on screen.
 * So placing the trigger over the pill also lands the popover at the pill,
 * and none of the old "park an anchor, re-anchor the menu" CSS is needed.
 *
 * The pill keeps the visuals (icon, count, state dot); the invisible official
 * trigger on top keeps the behaviour. Pills are `pointer-events: none` so a
 * tap can only ever reach the real thing — no double handling.
 */

import type { ClientContext } from '../compat/types.ts'

const PHONE = '(max-width: 767px)'
const HEADER = '[data-phase] header'

/** Pill → the official trigger it fronts. Same ARIA split the pills use. */
const PAIRS: ReadonlyArray<{ pill: string, trigger: string }> = [
  { pill: '[data-activity-kind="subagent"]', trigger: `${HEADER} button[aria-haspopup="tree"]` },
  { pill: '[data-activity-kind="job"]', trigger: `${HEADER} button[class$="_trigger"]:not([aria-haspopup])` },
]

/** Marks a trigger we have taken over, so cleanup can find it again. */
const TAKEN = 'data-zen-overlay'

function place(trigger: HTMLElement, pill: Element): void {
  const r = pill.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return
  trigger.setAttribute(TAKEN, '')
  // Fixed, not absolute: the header's containing block is not the pill's, and
  // fixed rects are exactly what the portalled popover measures against.
  trigger.style.setProperty('position', 'fixed', 'important')
  trigger.style.setProperty('left', `${r.left}px`, 'important')
  trigger.style.setProperty('top', `${r.top}px`, 'important')
  trigger.style.setProperty('width', `${r.width}px`, 'important')
  trigger.style.setProperty('height', `${r.height}px`, 'important')
  trigger.style.setProperty('margin', '0', 'important')
  trigger.style.setProperty('padding', '0', 'important')
  trigger.style.setProperty('border', '0', 'important')
  trigger.style.setProperty('opacity', '0', 'important')
  trigger.style.setProperty('overflow', 'hidden', 'important')
  trigger.style.setProperty('pointer-events', 'auto', 'important')
  trigger.style.setProperty('z-index', '3', 'important')
}

function release(trigger: HTMLElement): void {
  trigger.removeAttribute(TAKEN)
  trigger.style.cssText = ''
}

export function installNativeTriggerOverlay(ctx: ClientContext): void {
  ctx.effect(() => {
    const phone = window.matchMedia(PHONE)
    let frame = 0

    const sync = (): void => {
      for (const { pill, trigger } of PAIRS) {
        const t = document.querySelector<HTMLElement>(trigger)
        if (t === null) continue
        const p = document.querySelector(pill)
        // No pill (count zero, or desktop): hand the trigger back untouched.
        if (!phone.matches || p === null) {
          if (t.hasAttribute(TAKEN)) release(t)
          continue
        }
        place(t, p)
      }
    }
    /* Layout settles a frame late after a re-render, and a stale rect would
       leave the tap target next to the pill instead of on it. */
    const schedule = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => { frame = 0; sync() })
    }

    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-activity-state', 'data-phase'] })
    window.addEventListener('resize', schedule)
    phone.addEventListener('change', schedule)
    schedule()

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      phone.removeEventListener('change', schedule)
      for (const t of document.querySelectorAll<HTMLElement>(`[${TAKEN}]`)) release(t)
    }
  }, 'dsh-zen-remote: native trigger overlay')
}
