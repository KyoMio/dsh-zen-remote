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

/** Marks the container while it is parked in the sheet — the styling hook for composer.css.ts. */
const PARKED = 'data-zen-sheet-extras'

/**
 * Phone: park the composer row's third-party controls inside the model sheet.
 *
 * The row is one nowrap flex line and the model pill is its only shrinkable
 * item (composer.css.ts section 1), so every entry a plugin adds to
 * `conversation.input.right` comes straight out of the model name. With
 * dsh-plugin-subscriptions' speed chip ("速度 · 标准", ~70px of text) and
 * dsh-vision-router's 28px vision toggle both present on a GPT model, the row
 * runs out of width. Both are model-scoped settings, so the model sheet —
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
    /** The container while parked, plus where to put it back. */
    let parked: { node: Element, parent: Element, next: Node | null } | null = null

    const park = (menu: Element): void => {
      if (parked !== null) return
      const node = document.querySelector(EXTRAS_SELECTOR)
      // Nothing registered into the slot: leave the sheet exactly as it was.
      if (node === null || node.childElementCount === 0) return
      if (node.parentElement === null) return
      parked = { node, parent: node.parentElement, next: node.nextSibling }
      node.setAttribute(PARKED, '')
      menu.appendChild(node)
    }

    const unpark = (): void => {
      if (parked === null) return
      const { node, parent, next } = parked
      parked = null
      node.removeAttribute(PARKED)
      // The menu may already be detached, having taken the container with it.
      // The node itself is still live either way; re-home it only if its old
      // parent is still on the page (when the whole composer went away, the
      // owning React roots rebuild the slot on the next mount).
      if (parent.isConnected) parent.insertBefore(node, next)
    }

    const sync = (): void => {
      if (!phone.matches) { unpark(); return }
      const menu = document.querySelector(MENU_SELECTOR)
      if (menu === null) unpark()
      else park(menu)
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
      unpark()
    }
  }, 'dsh-mobile-nav: model sheet extras')
}
