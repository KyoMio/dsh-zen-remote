import type { ClientContext } from '../compat/types.ts'

/** Phone breakpoint — same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)'

/** The official composer slot wrapper (same marker composer.css.ts styles). */
const COMPOSER = '[data-slot="conversation.composer.bar"]'

/**
 * T72: the model sheet's search input on DSH 0.2.0-rc.2 — a `role=searchbox`
 * `<input>` inside the portaled model menu (composer.css.ts's MODEL_MENU
 * body form; on rc.2 the model pane portals as `role=group` with the search
 * row inside). The host focuses it the moment the user drills into the
 * model pane, which pops the phone keyboard over the sheet.
 */
const MODEL_MENU_ROOT = 'body > [id$="-menu"]'
const MODEL_SEARCH = `${MODEL_MENU_ROOT} [role="searchbox"]`
/** The focus target when the search's autofocus must be retracted: the
 * currently selected model row, the exact element the host's own arrow-key
 * navigation focuses first (model-selection-client.js moveFocus). */
const SELECTED_OPTION = '[role="menuitemradio"][aria-checked="true"]:not([disabled])'
/** The host's fallback when no row is checked (filtered/empty list): the
 * first selectable option row. */
const ANY_OPTION = '[role="menuitemradio"]:not([disabled])'

/** A tap/keystroke older than this no longer explains a focus. */
const INTENT_WINDOW_MS = 1000

/**
 * S9 — keep the phone keyboard down until the user asks for it.
 *
 * dsh-client-ui-conversation focuses the composer's editing host on every
 * sessionId change (0.1.2: `el.focus({preventScroll:true})` on the textarea;
 * 0.1.5: the same on the Lexical contenteditable). Sensible on desktop; on a
 * phone it pops the software keyboard over half the screen every time a
 * session opens.
 *
 * Rule: focus on the composer field survives only when the user asked for
 * it — a tap on the field itself or typing on a hardware keyboard. Anything
 * else (session-open autofocus, push-deep-link opens, the refocus side
 * effects of the other composer buttons — the official attach paperclip's
 * `keepFocus` mousedown, the slash-command toggle, send) is blurred. That
 * attach case is not hypothetical: 0.1.5's official paperclip refocuses the
 * editor on MOUSEDOWN, and while this guard was blind to the contenteditable
 * (2026-09-11 report) every tap on it popped the keyboard and shoved the
 * composer up the screen.
 *
 * Two triggers, because one is not enough:
 * - focusin catches the autofocus the moment it happens;
 * - a body MutationObserver re-runs the check after transcript swaps
 *   (opening a session re-renders the flow but may reuse the same field,
 *   and a focus that landed before this plugin loaded never fired focusin
 *   for us at all).
 * Once focus is user-granted it stays granted until the field blurs, so
 * the observer never yanks a keyboard the user opened (e.g. while the agent
 * streams and the user pauses typing).
 */
export function installKeyboardGuard(ctx: ClientContext): void {
  ctx.effect(() => {
    const narrow = window.matchMedia(PHONE_QUERY)
    let lastIntent = 0
    let granted = false
    // T72: the search field's own grant — separate from the composer's,
    // cleared when the field blurs, so a later programmatic focus (drilling
    // back into the pane) is retracted again.
    let searchGranted = false
    let observer: MutationObserver | null = null
    let frame = 0

    /** The composer's editing host: the `data-composer-input` contenteditable
     * DSH 0.1.5 binds Lexical to, or the textarea older hosts rendered (the
     * attribute also sat on that textarea — both spellings match both hosts,
     * belt and braces). Also matches descendants of the contenteditable, as
     * mobile browsers frequently report inner text nodes / spans / paragraphs
     * as the event target or activeElement. */
    const composerField = (node: unknown): HTMLElement | null => {
      if (!(node instanceof HTMLElement)) return null
      if (node.closest(COMPOSER) === null) return null
      const editable = node.closest<HTMLElement>('[data-composer-input]')
      if (editable !== null) return editable
      return node.tagName === 'TEXTAREA' ? node : null
    }

    /**
     * T72: the model sheet's search input. Unlike the composer field this
     * one is NOT blurred to the body — the model menu's root has an onBlur
     * that CLOSES the menu when the focus leaves root and menu (rc.2 model-
     * selection-client.js: `relatedTarget` outside both → `close()`), so
     * blurring would slam the sheet shut. The focus moves INSIDE the menu
     * instead: to the selected model row, the element the host's own
     * keyboard navigation focuses first. Phone keyboards have no arrow keys,
     * so the host's search-focus-follows-highlight logic losing focus costs
     * nothing there.
     */
    const modelSearchField = (node: unknown): HTMLElement | null => {
      if (!(node instanceof HTMLElement)) return null
      if (node.getAttribute('role') !== 'searchbox') return null
      return node.closest(MODEL_SEARCH)
    }

    /** Retract the search autofocus WITHOUT closing the menu (see above). */
    const retractSearchFocus = (field: HTMLElement): void => {
      const menu = field.closest(MODEL_MENU_ROOT)
      const selected = menu?.querySelector<HTMLElement>(SELECTED_OPTION) ?? menu?.querySelector<HTMLElement>(ANY_OPTION)
      if (selected !== null && selected !== undefined) selected.focus()
      else field.blur()
    }

    const onPointerDown = (event: PointerEvent): void => {
      // Only the textarea itself grants the keyboard. A tap on any other
      // composer control (slash-command toggle, attach, model menu, send)
      // must not: several of them refocus the input as a side effect, which
      // popped the keyboard on every command-button tap.
      if (composerField(event.target) !== null) {
        lastIntent = Date.now()
        granted = true
      }
      // T72: a tap ON the search field is the user asking for the keyboard
      // — typing to filter models must work.
      if (modelSearchField(event.target) !== null) searchGranted = true
    }
    const onKeyDown = (): void => {
      lastIntent = Date.now()
      if (composerField(document.activeElement) !== null) granted = true
    }
    const sweep = (): void => {
      // The search field is judged on its own grant, and a retracted focus
      // never leaves the menu (see modelSearchField — blur would close it).
      const search = modelSearchField(document.activeElement)
      if (search !== null) {
        if (searchGranted) return
        retractSearchFocus(search)
        return
      }
      const el = composerField(document.activeElement)
      if (el === null) return
      if (granted || Date.now() - lastIntent < INTENT_WINDOW_MS) {
        granted = true
        return
      }
      el.blur()
    }
    const onFocusIn = (event: FocusEvent): void => {
      if (composerField(event.target) === null && modelSearchField(event.target) === null) return
      sweep()
    }
    const onFocusOut = (event: FocusEvent): void => {
      // T72: the search field's grant dies with its focus — the next
      // programmatic focus is retracted again.
      if (modelSearchField(event.target) !== null) {
        searchGranted = false
        return
      }
      if (composerField(event.target) === null) return
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
      searchGranted = false
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
