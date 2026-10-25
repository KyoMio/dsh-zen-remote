import type { ClientContext } from '../compat/types.ts'
import { hasLayer, popLayer, pushLayer } from '../history-nav.ts'

/** Phone breakpoint — same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)'

/** The composer bar slot: the scan root, and the layer's home — under the
 * bar means inside #root but outside the official column, so the sheet can
 * never outlive the composer it was opened from. */
const BAR_SELECTOR = '[data-slot="conversation.composer.bar"]'

/**
 * Where a secondary control can legally sit in the composer, as ONE selector
 * list scanned inside the bar. Slots first (input.right / input.left), then
 * the official flex groups, then the row itself — a third party may inject
 * at any of the six (subscriptions and vision-router register into
 * input.right; dsh-workbuddy's credits and dsh-skills-ui's chips hang off
 * _row directly). Every position excludes `[data-mobile-nav]` so this
 * plugin's own nodes (the attach button, its picker, the ⋯ trigger, the
 * layer) are never collected, and the official controls by name, so the
 * whitelist never fights the host. opt-in by marker, never `:not()`-hide
 * unclaimed nodes — the failure direction is "extra control stays visible",
 * never "control hidden from both places".
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
 * in the row and in the sheet alike. It is the styling hook for both halves
 * in composer.css.ts, and it is deliberately what the row's `display: none`
 * keys off: without the marker the controls stay exactly where the host put
 * them, so a version of this file that declines to act — or never runs at
 * all — cannot leave them hidden in the row and absent from the sheet, i.e.
 * unreachable.
 */
const MANAGED = 'data-zen-sheet-extras'

/**
 * On every collected NODE. `""` = managed, hidden in the row while the ⋯
 * sheet is closed; `"open"` = currently parked in the sheet's list. Both
 * states are opt-in (see MANAGED) — the marker's absence never hides
 * anything.
 */
const EXTRA = 'data-zen-composer-extra'

/** history-nav layer id for the sheet (Android back gesture closes it). */
const LAYER_ID = 'composer-more'

/**
 * Is there anything collected that actually costs the row width?
 *
 * The row is one nowrap flex line whose only elastic item is the model pill
 * (composer.css.ts section 1), so entries here are paid for out of the model
 * name. But that is only a problem once something WIDE lands there — today
 * dsh-plugin-subscriptions' speed chip, which renders "速度 · 标准" and eats
 * ~70px. dsh-vision-router's toggle alone is a 28px icon that the row
 * accommodates fine, and moving it on its own would cost a tap (it becomes
 * two: open the sheet, then toggle) to buy width nobody needed.
 *
 * So: move only when the collection holds an entry that is not (or does not
 * contain) the vision toggle. With no such entry — subscriptions not
 * installed, or installed but not contributing on this model — nothing moves
 * and the row keeps its one icon, which is the behaviour asked for (user
 * review, 2026-09-06). Why width rather than sniffing for subscriptions by
 * name: the slot system adds no per-registration marker, so naming the
 * plugin would anchor on a marker we'd have to add to our own fork of it,
 * and the feature would die the day the fork is dropped. The width question
 * is the real question anyway, and this asks it directly.
 *
 * Unlike the pre-#30 design, NOTHING here depends on the official model
 * pill existing: replaced model slots (…codex-ui) and subagent sessions —
 * which have no pill at all — collect and open through the ⋯ trigger and
 * our own sheet exactly like everyone else.
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
 * Phone: collect the composer row's secondary third-party controls behind a
 * `⋯` pill in the dock rail, and move the REAL nodes into a bottom sheet
 * while it is open.
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
 * Restoring on close is not cosmetic. The sheet unmounts when it closes and
 * anything still inside goes with it, so the controls would vanish from the
 * page while their React roots kept updating detached nodes. Every close
 * path — mask tap, ⋯ toggle, Android back gesture (via history-nav), phone
 * breakpoint change, teardown — funnels through `close`.
 *
 * Known narrow window, accepted by design: a control unmounting while the
 * sheet is OPEN (an async update removes it from the row). With the sheet
 * open the mask covers the row, so nothing user-driven can trigger that —
 * only background timers/polls could, and none of today's contributors do.
 * A detached parked node is pruned on the next sync and its anchor removed.
 */
export function installModelSheetExtras(ctx: ClientContext): void {
  ctx.effect(() => {
    const phone = window.matchMedia(PHONE_QUERY)
    /** Parked nodes with the Comment anchoring each one's original spot. */
    let parked: Array<{ node: Element, placeholder: Comment }> = []
    let layer: HTMLElement | null = null
    let list: HTMLElement | null = null
    let trigger: HTMLButtonElement | null = null
    let syntheticDock: HTMLElement | null = null

    const isOpen = (): boolean => layer !== null && layer.isConnected

    /** Collected controls, document order; parked ones appended so the set
     * stays stable while the sheet is open. */
    const collect = (bar: Element): Element[] => {
      const controls = Array.from(bar.querySelectorAll(EXTRAS_SELECTOR))
      for (const { node } of parked) {
        if (node.isConnected && !controls.includes(node)) controls.push(node)
      }
      return controls
    }

    const park = (node: Element): void => {
      if (list === null || node.parentElement === null) return
      const placeholder = document.createComment('zen-composer-extra')
      node.parentElement.insertBefore(placeholder, node)
      node.setAttribute(EXTRA, 'open')
      list.appendChild(node)
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
        node.setAttribute(EXTRA, '')
      }
      parked = []
    }

    const close = (): void => {
      unparkAll()
      layer?.remove()
      layer = null
      list = null
      trigger?.setAttribute('aria-expanded', 'false')
      if (hasLayer(LAYER_ID)) popLayer(LAYER_ID)
    }

    const openSheet = (bar: Element, controls: readonly Element[]): void => {
      if (layer === null) {
        layer = document.createElement('div')
        layer.setAttribute('data-mobile-nav', 'composer-more-layer')
        const mask = document.createElement('div')
        mask.setAttribute('data-mobile-nav', 'composer-more-mask')
        mask.setAttribute('role', 'button')
        mask.tabIndex = -1
        mask.setAttribute('aria-label', '关闭')
        // The ONE close path: rewind history and let popstate run close().
        // Without a layer (history rewound under us) close directly.
        mask.addEventListener('click', () => {
          if (hasLayer(LAYER_ID)) popLayer(LAYER_ID)
          else close()
        })
        const sheet = document.createElement('div')
        sheet.setAttribute('data-mobile-nav', 'composer-more-sheet')
        sheet.setAttribute('role', 'dialog')
        sheet.setAttribute('aria-modal', 'true')
        list = document.createElement('div')
        list.setAttribute('data-mobile-nav', 'composer-more-list')
        list.setAttribute(MANAGED, '')
        sheet.appendChild(list)
        layer.appendChild(mask)
        layer.appendChild(sheet)
        bar.appendChild(layer)
      }
      for (const node of controls) {
        if (!parked.some((entry) => entry.node === node)) park(node)
      }
      trigger?.setAttribute('aria-expanded', 'true')
      if (!hasLayer(LAYER_ID)) pushLayer({ id: LAYER_ID, close })
    }

    /** Everything the effect owns, back to host-placed defaults: parked
     * nodes re-homed, markers dropped, trigger, sheet and synthetic dock
     * gone. Idempotent — teardown and every decline path go through here. */
    const releaseAll = (): void => {
      close()
      trigger?.remove()
      trigger = null
      syntheticDock?.remove()
      syntheticDock = null
      const bar = document.querySelector(BAR_SELECTOR)
      const scope: ParentNode = bar ?? document
      for (const node of scope.querySelectorAll(`[${EXTRA}]`)) node.removeAttribute(EXTRA)
      bar?.querySelector('[data-slot="conversation.input.right"]')?.removeAttribute(MANAGED)
    }

    const toggle = (): void => {
      const bar = document.querySelector(BAR_SELECTOR)
      if (bar === null) return
      if (layer !== null) {
        // Gesture-style close: the exact path a mask tap takes.
        layer.querySelector<HTMLElement>('[data-mobile-nav="composer-more-mask"]')?.click()
        return
      }
      const controls = collect(bar)
      if (worthMoving(controls)) openSheet(bar, controls)
    }

    const ensureTrigger = (bar: Element): HTMLButtonElement => {
      // :not([data-zen-synthetic-dock]) is load-bearing: the synthetic rail
      // is bar's SIBLING carrying the same data-slot, so an unqualified
      // query would find it as the "real" dock on the next sync, delete it
      // as stale, recreate it after — the observer would oscillate forever.
      const dock = bar.parentElement?.querySelector('[data-slot="conversation.input.dock"]:not([data-zen-synthetic-dock])') ?? null
      if (dock === null) {
        // Hero stage: the host has not rendered the dock slot yet. A
        // synthetic rail before the bar gives the trigger a home; the
        // section 7 rail styles apply to it via the same data-slot.
        if (syntheticDock === null || !syntheticDock.isConnected) {
          syntheticDock = document.createElement('div')
          syntheticDock.setAttribute('data-slot', 'conversation.input.dock')
          syntheticDock.setAttribute('data-zen-synthetic-dock', '')
          bar.parentNode?.insertBefore(syntheticDock, bar)
        }
      } else if (syntheticDock !== null) {
        syntheticDock.remove()
        syntheticDock = null
      }
      const home = dock ?? syntheticDock
      if (trigger === null || !trigger.isConnected) {
        trigger = document.createElement('button')
        trigger.type = 'button'
        trigger.setAttribute('data-mobile-nav', 'composer-more')
        trigger.setAttribute('aria-haspopup', 'dialog')
        trigger.setAttribute('aria-expanded', 'false')
        trigger.setAttribute('aria-label', '更多工具')
        trigger.title = '更多工具'
        trigger.textContent = '⋯'
        trigger.addEventListener('click', toggle)
      }
      if (home !== null && trigger.parentElement !== home) {
        // First mount, or the real dock appeared while the trigger lived in
        // the synthetic rail — (re)place it. order: 0 ties resolve by DOM
        // order, so prepend puts it at the rail's left edge, as designed.
        home.prepend(trigger)
      }
      return trigger
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

      for (const node of controls) {
        // Only stamp nodes that have no marker yet: parked ones carry "open"
        // and managed-but-closed ones already carry "", so a steady-state
        // sync performs zero attribute writes.
        if (node.getAttribute(EXTRA) === null) node.setAttribute(EXTRA, '')
      }
      // Nodes the set has outgrown (an uninstalled plugin, a re-render that
      // moved a control into a claimed position) lose their marker and show
      // again.
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

      ensureTrigger(bar)
      if (isOpen()) {
        for (const node of controls) {
          if (!parked.some((entry) => entry.node === node)) park(node)
        }
      }
    }

    // Synchronous in the observer callback, never behind rAF: the callback is
    // a microtask and runs before this frame paints, so markers, trigger and
    // parked nodes are in place the first time their frame is drawn. A rAF
    // would land a frame late (AGENTS.md's "晚一帧" rule). Body-level
    // childList is the same shape modal-back.ts uses. childList only: every
    // state this effect reacts to (controls mounting/unmounting, menus
    // opening, the dock appearing) arrives as node additions or removals —
    // the old aria-expanded attribute watch only ever bought no-op syncs
    // from this effect's own trigger writes. The observer also sees those
    // moves; sync is idempotent, so the extra pass is a no-op.
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    phone.addEventListener('change', sync)
    sync()

    return () => {
      observer.disconnect()
      phone.removeEventListener('change', sync)
      releaseAll()
    }
  }, 'dsh-mobile-nav: composer more sheet extras')
}
