import type { ClientContext } from '../compat/types.ts'
import { BETTER_ROOT, OFFICIAL_PANEL, closeOpenSidebar } from '../sidebar-panels.ts'

/** Phone breakpoint — same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)'

/**
 * The file tree's per-row @-reference button: dsh-better-sidebar's
 * `_explorerRef` class suffix (stable across its releases; the hash prefix
 * is not), scoped to the panel hosting the tree so the selector misses
 * entirely when the plugin is not installed. Two hosts: the plugin's own
 * panel under its root marker (≤ 0.18), or DSH 0.1.5's native right panel
 * (0.19+ renders the explorer in there). Covers the search results too:
 * TreePanel renders both through the same row-actions slot.
 */
const REF_SELECTOR = `${OFFICIAL_PANEL} [class$="_explorerRef"], ${BETTER_ROOT} [class$="_explorerRef"]`

/**
 * Phone: an @-file reference tap in the workbench closes the workbench.
 *
 * On a phone the panel is a full-screen surface over the conversation (the
 * host's own native panel on 0.1.5+, better-sidebar's on older combos), so
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
      // closeOpenSidebar re-reads the open state at fire time: the tap's own
      // handler chain (or a second tap) may already have closed the panel —
      // better-sidebar's toggle is a toggle, and blind-clicking it would
      // REOPEN what just closed.
      setTimeout(() => { closeOpenSidebar() }, 0)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, 'dsh-mobile-nav: workbench @-reference closes the panel')
}
