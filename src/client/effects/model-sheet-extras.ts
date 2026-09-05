import type { ClientContext } from '../compat/types.ts'

/** Phone breakpoint — same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)'

/** The model pill's own popup, which section 4 of composer.css.ts turns into a bottom sheet. */
const MENU_SELECTOR = '[data-slot="conversation.input.model"] [class$="_menu"]'

/**
 * The third-party composer controls this effect relocates. Both register into
 * `conversation.input.right`; moving the slot container rather than its
 * children keeps them together and leaves exactly one node to put back.
 */
const EXTRAS_SELECTOR = '[data-slot="conversation.input.right"]'

/**
 * dsh-vision-router's own mount marker. Used here only to answer "is there
 * anything in this slot BESIDES the vision toggle" — see `worthMoving`.
 */
const VISION_SELECTOR = '[data-vision-router-mode-toggle]'

/**
 * Set on the container while this effect manages it, in the row and in the
 * sheet alike. It is the styling hook for both halves in composer.css.ts, and
 * it is deliberately what the row's `display: none` keys off: without the
 * marker the controls stay exactly where the host put them, so a version of
 * this file that declines to act — or never runs at all — cannot leave them
 * hidden in the row and absent from the sheet, i.e. unreachable.
 */
const MANAGED = 'data-zen-sheet-extras'

/**
 * Is the slot holding anything that actually costs the row width?
 *
 * The row is one nowrap flex line whose only elastic item is the model pill
 * (composer.css.ts section 1), so entries here are paid for out of the model
 * name. But that is only a problem once something WIDE lands in the slot —
 * today dsh-plugin-subscriptions' speed chip, which renders "速度 · 标准" and
 * eats ~70px. dsh-vision-router's toggle alone is a 28px icon that the row
 * accommodates fine, and moving it on its own would cost a tap (it becomes
 * two: open the sheet, then toggle) to buy width nobody needed.
 *
 * So: relocate only when the slot holds an entry that is not the vision
 * toggle. With no such entry — subscriptions not installed, or installed but
 * not contributing on this model — nothing moves and the row keeps its one
 * icon, which is the behaviour asked for (user review, 2026-09-06).
 *
 * Why this rather than sniffing for subscriptions by name: the slot system
 * adds no per-registration marker (measured — entries render straight into the
 * container) and subscriptions marks nothing of its own, so naming it would
 * mean adding a marker to our fork of that plugin and anchoring on it. That
 * marker dies the day the fork is dropped, and the feature would go quiet
 * with nothing to catch it. The width question is the real question anyway,
 * and this asks it directly.
 */
function worthMoving(extras: Element): boolean {
  return [...extras.children].some(child => !child.matches(VISION_SELECTOR))
}

/**
 * Phone: park the composer row's third-party controls inside the model sheet.
 *
 * With the speed chip and the vision toggle both present on a GPT model the
 * row runs out of width. Both are model-scoped settings, so the model sheet —
 * which already holds 模型 and 推理等级 — is where they belong (user request,
 * 2026-09-06).
 *
 * Why move the real controls instead of drawing our own rows that drive them:
 * the same reason native-trigger-overlay.ts moves the real trigger. A stand-in
 * has to script the original, which is a road this plugin does not go down —
 * beyond the trusted-input wall that effect documents, our own rows would have
 * to mirror every piece of state (speed tier, disabled, aria-pressed, whether
 * a vision twin exists for the current model) and would rot on the next
 * upstream restyle. Moving the node keeps one source of truth: their React
 * roots go on owning and updating these elements, we only change where they
 * hang.
 *
 * Measured 2026-09-06 (DSH 0.1.2, 390px) before writing this — the two things
 * that would have killed the approach both hold: a relocated control survives
 * host re-renders (typing into the composer re-renders the row and does not
 * yank it back) and stays hit-testable at its new position.
 *
 * Restoring on close is not cosmetic. The sheet unmounts when it closes and
 * anything still inside goes with it, so the controls would vanish from the
 * page while their React roots kept updating detached nodes. The observer
 * therefore watches the menu leaving too, and the parked node is held as a
 * reference rather than looked up — once the menu is detached a document
 * query can no longer find it.
 */
export function installModelSheetExtras(ctx: ClientContext): void {
  ctx.effect(() => {
    const phone = window.matchMedia(PHONE_QUERY)
    /** The container while parked in the sheet, plus where to put it back. */
    let parked: { node: Element, parent: Element, next: Node | null } | null = null

    const park = (node: Element, menu: Element): void => {
      if (parked !== null || node.parentElement === null) return
      parked = { node, parent: node.parentElement, next: node.nextSibling }
      menu.appendChild(node)
    }

    const unpark = (): void => {
      if (parked === null) return
      const { node, parent, next } = parked
      parked = null
      // The menu may already be detached, having taken the container with it.
      // The node itself is still live either way; re-home it only if its old
      // parent is still on the page (when the whole composer went away, the
      // owning React roots rebuild the slot on the next mount).
      if (parent.isConnected) parent.insertBefore(node, next)
    }

    /** Hand the container back to the host, marker and all. */
    const release = (node: Element | null): void => {
      unpark()
      node?.removeAttribute(MANAGED)
    }

    const sync = (): void => {
      const extras = document.querySelector(EXTRAS_SELECTOR)
      if (extras === null) { unpark(); return }
      if (!phone.matches || !worthMoving(extras)) { release(extras); return }
      extras.setAttribute(MANAGED, '')
      const menu = document.querySelector(MENU_SELECTOR)
      if (menu === null) unpark()
      else park(extras, menu)
    }

    // Synchronous in the observer callback, never behind rAF: the callback is
    // a microtask and runs before this frame paints, so the controls are in
    // the sheet the first time it is drawn. A rAF would land a frame late and
    // show one frame of the sheet without them (AGENTS.md's "晚一帧" rule).
    // Body-level childList is the same shape modal-back.ts uses; aria-expanded
    // is watched too so a close that reuses the node still re-syncs.
    const observer = new MutationObserver(sync)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-expanded'],
    })
    phone.addEventListener('change', sync)
    sync()

    return () => {
      observer.disconnect()
      phone.removeEventListener('change', sync)
      release(document.querySelector(EXTRAS_SELECTOR))
    }
  }, 'dsh-mobile-nav: model sheet extras')
}
