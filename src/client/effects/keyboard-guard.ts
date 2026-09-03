import type { ClientContext } from '../compat/types.ts'

/** Phone breakpoint — same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)'

/** The official composer slot wrapper (same marker composer.css.ts styles). */
const COMPOSER = '[data-slot="conversation.composer.bar"]'

/** A tap/keystroke older than this no longer explains a focus. */
const INTENT_WINDOW_MS = 1000

/**
 * S9 — keep the phone keyboard down until the user asks for it.
 *
 * dsh-client-ui-conversation focuses the composer textarea on every
 * sessionId change (lib/client.js:3423 — el.focus({preventScroll:true}) in a
 * [locked, sessionId] effect). Sensible on desktop; on a phone it pops the
 * software keyboard over half the screen every time a session opens.
 *
 * Rule: focus on the composer textarea survives only when the user asked for
 * it — a tap on the textarea itself or typing on a hardware keyboard.
 * Anything else (session-open autofocus, push-deep-link opens, the refocus
 * side effects of the other composer buttons — slash-command toggle, attach,
 * send) is blurred.
 *
 * Two triggers, because one is not enough:
 * - focusin catches the autofocus the moment it happens;
 * - a body MutationObserver re-runs the check after transcript swaps
 *   (opening a session re-renders the flow but may reuse the same textarea,
 *   and a focus that landed before this plugin loaded never fired focusin
 *   for us at all).
 * Once focus is user-granted it stays granted until the textarea blurs, so
 * the observer never yanks a keyboard the user opened (e.g. while the agent
 * streams and the user pauses typing).
 */
export function installKeyboardGuard(ctx: ClientContext): void {
  ctx.effect(() => {
    const narrow = window.matchMedia(PHONE_QUERY)
    let lastIntent = 0
    let granted = false
    let observer: MutationObserver | null = null
    let frame = 0

    const composerTextarea = (node: unknown): HTMLElement | null =>
      node instanceof HTMLElement && node.tagName === 'TEXTAREA' && node.closest(COMPOSER) !== null
        ? node
        : null

    const onPointerDown = (event: PointerEvent): void => {
      // Only the textarea itself grants the keyboard. A tap on any other
      // composer control (slash-command toggle, attach, model menu, send)
      // must not: several of them refocus the input as a side effect, which
      // popped the keyboard on every command-button tap.
      if (composerTextarea(event.target) !== null) {
        lastIntent = Date.now()
        granted = true
      }
    }
    const onKeyDown = (): void => {
      lastIntent = Date.now()
      if (composerTextarea(document.activeElement) !== null) granted = true
    }
    const sweep = (): void => {
      const el = composerTextarea(document.activeElement)
      if (el === null) return
      if (granted || Date.now() - lastIntent < INTENT_WINDOW_MS) {
        granted = true
        return
      }
      el.blur()
    }
    const onFocusIn = (event: FocusEvent): void => {
      if (composerTextarea(event.target) === null) return
      sweep()
    }
    const onFocusOut = (event: FocusEvent): void => {
      if (composerTextarea(event.target) === null) return
      granted = false
    }
    const schedule = (): void => {
      if (observer === null || frame !== 0) return
      // setTimeout, not requestAnimationFrame: rAF pauses in hidden/
      // backgrounded pages, where the autofocus still happens — the sweep
      // must run there too or the keyboard pops when the page is foregrounded.
      frame = window.setTimeout(() => {
        frame = 0
        sweep()
      }, 100)
    }

    const attach = (): void => {
      if (observer !== null) return
      document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
      document.addEventListener('keydown', onKeyDown, { capture: true, passive: true })
      document.addEventListener('focusin', onFocusIn, true)
      document.addEventListener('focusout', onFocusOut, true)
      observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      sweep()
    }
    const detach = (): void => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      observer?.disconnect()
      observer = null
      if (frame !== 0) window.clearTimeout(frame)
      frame = 0
      granted = false
    }

    if (narrow.matches) attach()
    const onChange = (event: MediaQueryListEvent): void => (event.matches ? attach() : detach())
    narrow.addEventListener('change', onChange)
    return () => {
      narrow.removeEventListener('change', onChange)
      detach()
    }
  }, 'dsh-mobile-nav: composer keyboard guard')
}
