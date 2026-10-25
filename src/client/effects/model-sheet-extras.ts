import type { ClientContext } from '../compat/types.ts'

/** Phone breakpoint — same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)'

/** The composer bar slot: the scan root, and the anchor the synthetic dock
 * rail hangs beside (hero stage). */
const BAR_SELECTOR = '[data-slot="conversation.composer.bar"]'

/**
 * Where a secondary control can legally sit in the composer, as ONE selector
 * list scanned inside the bar. Slots first (input.right / input.left), then
 * the official flex groups, then the row itself — a third party may inject
 * at any of the six (subscriptions and vision-router register into
 * input.right; dsh-workbuddy's credits and dsh-skills-ui's chips hang off
 * _row directly). Every position excludes `[data-mobile-nav]` so this
 * plugin's own nodes (the strip itself, and anything else we mount) are
 * never collected, and the official controls by name, so the whitelist
 * never fights the host. opt-in by marker, never `:not()`-hide unclaimed
 * nodes — the failure direction is "extra control stays visible", never
 * "control hidden from both places".
 */
const EXTRAS_SELECTOR = [
  '[data-slot="conversation.input.right"] > *:not([data-mobile-nav])',
  '[data-slot="conversation.input.left"] > *:not([data-mobile-nav])',
  '[class$="_tools"] > *:not(button[class$="_add"]):not(input[type="file"]):not([class$="_modes"]):not([data-slot="conversation.input.left"]):not([data-mobile-nav])',
  '[class$="_standardControls"] > *:not([data-slot="conversation.input.model"]):not([data-slot="conversation.input.right"]):not([data-mobile-nav])',
  '[class$="_trailing"] > *:not([class$="_standardControls"]):not([class$="_activity"]):not([class$="_primary"]):not([data-mobile-nav])',
  '[class$="_row"] > *:not([class$="_tools"]):not([class$="_trailing"]):not([data-mobile-nav])',
].join(', ')

/**
 * dsh-vision-router's own mount marker. Used only to answer "is the single
 * collected control the vision toggle" — see `worthMoving`.
 */
const VISION_SELECTOR = '[data-vision-router-mode-toggle]'

/**
 * On the input.right CONTAINER while the effect manages any of its children,
 * and on the strip itself. It is the styling hook for both halves in
 * composer.css.ts (the emptied container hides without leaving a flex gap;
 * an inline `[role="menu"]` opened by a parked chip escapes the strip's
 * overflow clip through it). It is deliberately what the row's
 * `display: none` keys off: without the marker the controls stay exactly
 * where the host put them, so a version of this file that declines to act —
 * or never runs at all — cannot leave them hidden in the row and absent from
 * the strip, i.e. unreachable.
 */
const MANAGED = 'data-zen-sheet-extras'

/**
 * On every collected NODE while it is parked in the strip. Purely opt-in:
 * the marker's absence never hides anything, and `releaseAll` removes it —
 * an unmarked control is the host's own business again.
 */
const EXTRA = 'data-zen-composer-extra'

/**
 * Is there anything collected that actually costs the row width?
 *
 * The row is one nowrap flex line whose only elastic item is the model pill
 * (composer.css.ts section 1), so entries here are paid for out of the model
 * name. But that is only a problem once something WIDE lands there — today
 * dsh-plugin-subscriptions' speed chip, which renders "速度 · 标准" and eats
 * ~70px. dsh-vision-router's toggle alone is a 28px icon that the row
 * accommodates fine, and moving it on its own would cost nothing visually
 * but would hide a one-tap control behind a scroll (user review, 2026-09-06).
 *
 * So: move only when the collection holds an entry that is not (or does not
 * contain) the vision toggle. With no such entry — subscriptions not
 * installed, or installed but not contributing on this model — nothing moves
 * and the row keeps its one icon. Why width rather than sniffing for
 * subscriptions by name: the slot system adds no per-registration marker, so
 * naming the plugin would anchor on a marker we'd have to add to our own
 * fork of it, and the feature would die the day the fork is dropped. The
 * width question is the real question anyway, and this asks it directly.
 *
 * Unlike the pre-#30 design, NOTHING here depends on the official model
 * pill existing: replaced model slots (…codex-ui) and subagent sessions —
 * which have no pill at all — collect and relocate exactly like everyone
 * else.
 */
function worthMoving(controls: readonly Element[]): boolean {
  if (controls.length === 0) return false
  if (controls.length === 1) {
    const child = controls[0]
    if (child === undefined) return false
    // "is or contains" — some plugins wrap their toggle in a positioning node.
    if (child.matches(VISION_SELECTOR) || child.querySelector(VISION_SELECTOR) !== null) return false
  }
  return true
}

/**
 * Phone: move the composer row's secondary third-party controls into a
 * 26px horizontally-scrollable strip inside the dock rail above the card —
 * always visible, one tap from anywhere, no sheet in between.
 *
 * Why move the real controls instead of drawing our own rows that drive
 * them: the same reason native-trigger-overlay.ts moves the real trigger. A
 * stand-in has to script the original, which is a road this plugin does not
 * go down — beyond the trusted-input wall that effect documents, our own
 * rows would have to mirror every piece of state (speed tier, disabled,
 * aria-pressed, whether a vision twin exists for the current model) and
 * would rot on the next upstream restyle. Moving the node keeps one source
 * of truth: their React roots go on owning and updating these elements, we
 * only change where they hang — never cloneNode, and the move is anchored
 * with a Comment at the original spot so `unparkAll` can put each node back
 * exactly where React left it.
 *
 * Measured 2026-09-06 (DSH 0.1.2, 390px) before the original version of
 * this effect — the two things that would have killed the approach both
 * hold: a relocated control survives host re-renders (typing into the
 * composer re-renders the row and does not yank it back) and stays
 * hit-testable at its new position.
 *
 * Known hazard, inherent to relocating React-owned nodes: a control whose
 * REGISTRATION unmounts while parked (plugin disabled, slot re-keyed) is
 * removed by React through its ORIGINAL parent — `parent.removeChild(child)`
 * throws when the child moved, and the exception lands in React's commit.
 * Updates that keep the registration mounted (state-driven re-renders,
 * text/attribute changes, a control's own inner nodes unmounting) are safe:
 * those removals run inside the parked subtree, where every parent-child
 * link React recorded still holds. Parking is also fully reversible — any
 * decline path (desktop, nothing worth moving, teardown) hands every node
 * back before anything is removed.
 */
export function installModelSheetExtras(ctx: ClientContext): void {
  ctx.effect(() => {
    const phone = window.matchMedia(PHONE_QUERY)
    /** Parked nodes with the Comment anchoring each one's original spot. */
    let parked: Array<{ node: Element, placeholder: Comment }> = []
    let syntheticDock: HTMLElement | null = null

    /** Collected controls, document order; parked ones appended so the set
     * stays stable while they live in the strip. */
    const collect = (bar: Element): Element[] => {
      const controls = Array.from(bar.querySelectorAll(EXTRAS_SELECTOR))
      for (const { node } of parked) {
        if (node.isConnected && !controls.includes(node)) controls.push(node)
      }
      return controls
    }

    const park = (node: Element, strip: HTMLElement): void => {
      if (node.parentElement === null) return
      const placeholder = document.createComment('zen-composer-extra')
      node.parentElement.insertBefore(placeholder, node)
      node.setAttribute(EXTRA, 'open')
      strip.appendChild(node)
      parked.push({ node, placeholder })
    }

    const unparkAll = (): void => {
      for (const { node, placeholder } of parked) {
        // Re-home only while the anchor still marks the spot AND that home
        // is on the page — when the whole composer went away, the owning
        // React roots rebuild the slot on the next mount.
        if (placeholder.parentNode !== null && placeholder.parentNode.isConnected) {
          placeholder.parentNode.insertBefore(node, placeholder)
        }
        placeholder.remove()
        node.removeAttribute(EXTRA)
      }
      parked = []
    }

    /** Everything the effect owns, back to host-placed defaults: parked
     * nodes re-homed, strip, synthetic rail and every marker gone.
     * Idempotent — teardown and every decline path go through here. */
    const releaseAll = (): void => {
      unparkAll()
      document.querySelector('[data-mobile-nav="composer-chips"]')?.remove()
      syntheticDock?.remove()
      syntheticDock = null
      const bar = document.querySelector(BAR_SELECTOR)
      const scope: ParentNode = bar ?? document
      for (const node of scope.querySelectorAll(`[${EXTRA}]`)) node.removeAttribute(EXTRA)
      bar?.querySelector('[data-slot="conversation.input.right"]')?.removeAttribute(MANAGED)
    }

    /** The rail the strip lives in — the host's own dock, or a synthetic
     * stand-in while the hero composer has rendered none yet. */
    const adoptDock = (bar: Element): Element => {
      // :not([data-zen-synthetic-dock]) is load-bearing: the synthetic rail
      // is bar's SIBLING carrying the same data-slot, so an unqualified
      // query would find it as the "real" dock, delete it as stale, recreate
      // it after — the observer would oscillate forever.
      const dock = bar.parentElement?.querySelector('[data-slot="conversation.input.dock"]:not([data-zen-synthetic-dock])') ?? null
      if (dock !== null) {
        if (syntheticDock !== null) {
          // Real dock appeared: hand every parked node back before the
          // synthetic rail (and the strip inside it) is destroyed — removing
          // a rail full of React-owned controls would detach them from the
          // page. sync re-parks them into the new strip right after.
          unparkAll()
          syntheticDock.remove()
          syntheticDock = null
        }
        return dock
      }
      if (syntheticDock === null || !syntheticDock.isConnected) {
        syntheticDock = document.createElement('div')
        syntheticDock.setAttribute('data-slot', 'conversation.input.dock')
        syntheticDock.setAttribute('data-zen-synthetic-dock', '')
        bar.parentNode?.insertBefore(syntheticDock, bar)
      }
      return syntheticDock
    }

    const ensureStrip = (home: Element): HTMLElement => {
      let strip = home.querySelector<HTMLElement>('[data-mobile-nav="composer-chips"]')
      if (strip === null) {
        strip = document.createElement('div')
        strip.setAttribute('data-mobile-nav', 'composer-chips')
        strip.setAttribute(MANAGED, '')
        // Document-order first; CSS `order: 0` keeps it the rail's leftmost
        // pill line among the order-0 ties.
        home.prepend(strip)
      }
      return strip
    }

    const sync = (): void => {
      const bar = document.querySelector(BAR_SELECTOR)
      if (bar === null) { releaseAll(); return }
      // A parked node its own React root unmounted is dead weight; drop it
      // and its anchor before collecting, so it neither blocks nor hides.
      parked = parked.filter(({ node, placeholder }) => {
        if (node.isConnected) return true
        placeholder.remove()
        return false
      })
      const controls = collect(bar)
      if (!phone.matches || !worthMoving(controls)) { releaseAll(); return }

      const home = adoptDock(bar)
      const strip = ensureStrip(home)

      // Parked entries the set has outgrown (an uninstalled plugin, a
      // re-render that moved a control into a claimed position) go home and
      // lose their marker.
      parked = parked.filter(({ node, placeholder }) => {
        if (controls.includes(node) && node.isConnected) return true
        if (node.isConnected && placeholder.parentNode !== null && placeholder.parentNode.isConnected) {
          placeholder.parentNode.insertBefore(node, placeholder)
        }
        placeholder.remove()
        node.removeAttribute(EXTRA)
        return false
      })
      for (const node of controls) {
        if (!parked.some((entry) => entry.node === node)) park(node, strip)
      }
      // Stale markers anywhere in the bar — parked ones are in `controls`,
      // so they survive this sweep.
      for (const node of bar.querySelectorAll(`[${EXTRA}]`)) {
        if (!controls.includes(node)) node.removeAttribute(EXTRA)
      }
      const right = bar.querySelector('[data-slot="conversation.input.right"]')
      if (right !== null) {
        const rightManaged = right.children.length > 0 ||
          parked.some(({ placeholder }) => placeholder.parentNode === right)
        if (rightManaged) right.setAttribute(MANAGED, '')
        else right.removeAttribute(MANAGED)
      }
    }

    // Synchronous in the observer callback, never behind rAF: the callback is
    // a microtask and runs before this frame paints, so the strip and the
    // parked nodes are in place the first time their frame is drawn. A rAF
    // would land a frame late (AGENTS.md's "晚一帧" rule). Body-level
    // childList is the same shape modal-back.ts uses. The observer also sees
    // this effect's own moves; sync is idempotent, so the extra pass is a
    // no-op.
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    phone.addEventListener('change', sync)
    sync()

    return () => {
      observer.disconnect()
      phone.removeEventListener('change', sync)
      releaseAll()
    }
  }, 'dsh-mobile-nav: composer chips extras')
}
