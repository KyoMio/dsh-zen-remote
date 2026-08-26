import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** Phone breakpoint — same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)'

/**
 * The file tree's per-row @-reference button (dsh-better-sidebar's
 * `_explorerRef` class suffix — same anchoring convention as every other
 * better-sidebar hook in this plugin: the plugin's own root marker plus a
 * stable class suffix, so the selector misses entirely when the plugin is
 * not installed). Covers the search results too: TreePanel renders both
 * through the same row-actions slot.
 */
const REF_SELECTOR = '[data-dsh-better-sidebar] [class$="_explorerRef"]'

/** The panel's own (phone-hidden) toggle — the one official way to close it.
 * Same anchor gestures.ts and MobileSessionHeader.tsx already use. */
const TOGGLE_SELECTOR = '[data-dsh-better-sidebar] button[class$="_toggleButton"]'

/** Open-state read, shared convention with gestures.ts: the class ends in
 * "_panel" only while open ("_panelHidden" is appended once closed). */
const PANEL_OPEN_SELECTOR = '[data-dsh-better-sidebar] [class$="_panel"]'

/**
 * Phone: an @-file reference tap in the workbench closes the workbench.
 *
 * On a phone the panel is a full-screen surface over the conversation, so
 * after tapping a row's @ button the user is still looking at the file tree
 * — the ONLY feedback for the tap is a draft change on a composer they
 * cannot see (real-device report, 2026-08-26: reads as "nothing happened",
 * and the close pill can end up behind the software keyboard on top of it).
 * Closing the panel IS the feedback: the conversation comes back with the
 * fresh `@path` sitting in the composer.
 *
 * Capture phase on document, deliberately: the button's own React handler
 * calls stopPropagation() (its row would otherwise open the file), so a
 * bubble listener never hears the tap. Capture runs on the way DOWN, before
 * the target handler and its stopPropagation can matter — the aionui-compat
 * chevron listener set this precedent.
 *
 * The close is deferred one macrotask so the reference lands first: the
 * button's handler (which appends `@path` to the draft) runs at target
 * phase, synchronously inside this same event dispatch — by the time the
 * timeout fires the draft is written and the toggle click only changes what
 * is on screen. Desktop is untouched (checked per tap, not at install: a
 * resize mid-session must not leave a stale arm either way), where the
 * panel is a docked column and closing it after every reference would be
 * hostile to multi-file referencing.
 */
export function installWorkbenchRefClose(ctx: ClientContext): void {
  ctx.effect(() => {
    const phone = window.matchMedia(PHONE_QUERY)
    const onClick = (event: Event): void => {
      if (!phone.matches) return
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(REF_SELECTOR) === null) return
      setTimeout(() => {
        // Re-check open state at fire time: the tap's own handler chain (or
        // a second tap) may already have closed the panel — the toggle is a
        // toggle, and blind-clicking it would REOPEN what just closed.
        if (document.querySelector(PANEL_OPEN_SELECTOR) === null) return
        document.querySelector<HTMLButtonElement>(TOGGLE_SELECTOR)?.click()
      }, 0)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, 'dsh-mobile-nav: workbench @-reference closes the panel')
}
