/**
 * Give Android's back gesture something to close for modals this plugin does
 * NOT own — the official settings/export dialogs, the composer's permission
 * and model sheets, third-party panels like dsh-better-sidebar's workbench.
 *
 * Those all keep their open state in their own React components with no
 * public setter, so there is nothing to call. What they do share is a
 * contract the DOM exposes: while open they are `[aria-modal="true"]`, and
 * they close on Escape (the standard dismissal every one of these primitives
 * implements). So: watch for one appearing, stack a history layer, and close
 * it by sending Escape.
 *
 * Anchored on the ARIA contract rather than on any hashed class or plugin
 * name, so a modal from a plugin nobody has written compat for still gets a
 * working back gesture.
 *
 * Phone only. On desktop the back gesture is not a thing and the official
 * dialogs keep their own behaviour untouched (the repo's desktop no-op rule).
 */

import type { ClientContext } from '../compat/types.ts'
import { hasLayer, popLayer, pushLayer } from '../history-nav.ts'

const PHONE = '(max-width: 767px)'
/**
 * Modals this plugin does NOT own. Every surface the plugin builds itself
 * carries a `data-mobile-nav` marker and registers its own layer with a real
 * close callback, so excluding them here is what keeps a sheet from being
 * counted twice.
 *
 * It was counted twice once (2026-08-20, caught on-device): the info card
 * pushed its own layer AND matched here, so one back press unwound two
 * entries, the history landed at the root while the session view stayed on
 * screen, and the next press did nothing at all.
 */
const MODAL = '[aria-modal="true"]:not([data-mobile-nav])'
/** One id per open modal, so nesting (a dialog over a sheet) still stacks. */
let seq = 0

function escapeTo(el: Element): void {
  const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }
  el.dispatchEvent(new KeyboardEvent('keydown', init))
  el.dispatchEvent(new KeyboardEvent('keyup', init))
}

export function installModalBack(ctx: ClientContext): void {
  ctx.effect(() => {
    const phone = window.matchMedia(PHONE)
    /** Modal element -> the layer id standing in for it. */
    const tracked = new Map<Element, string>()

    const sync = (): void => {
      if (!phone.matches) {
        // Leaving the phone breakpoint: drop the layers, keep the modals.
        for (const id of tracked.values()) if (hasLayer(id)) popLayer(id)
        tracked.clear()
        return
      }
      const open = new Set(document.querySelectorAll(MODAL))

      for (const el of open) {
        if (tracked.has(el)) continue
        seq += 1
        const id = `modal-${seq}`
        tracked.set(el, id)
        pushLayer({
          id,
          close: () => {
            tracked.delete(el)
            // Only meaningful while it is still mounted; a modal the user
            // already dismissed just consumes its entry silently.
            if (el.isConnected) escapeTo(el)
          },
        })
      }

      for (const [el, id] of [...tracked]) {
        if (open.has(el)) continue
        // Closed by its own affordance (X, backdrop, Escape). Spend the entry
        // so the next back press moves the page stack instead of no-opping.
        tracked.delete(el)
        if (hasLayer(id)) popLayer(id)
      }
    }

    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] })
    phone.addEventListener('change', sync)
    sync()

    return () => {
      observer.disconnect()
      phone.removeEventListener('change', sync)
      for (const id of tracked.values()) if (hasLayer(id)) popLayer(id)
      tracked.clear()
    }
  }, 'dsh-zen-remote: modal back gesture')
}
