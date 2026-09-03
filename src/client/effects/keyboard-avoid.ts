import type { ClientContext } from '../compat/types.ts'
import { clientConfig, KEYBOARD_DEFAULTS, type KeyboardTuning } from '../client-config.ts'

/** Phone breakpoint — same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)'

/** Root CSS variable composer.css.ts turns into a composer lift. */
const LIFT_VAR = '--mnav-kb-lift'

/** Root attribute gating the transform rule. Present only while lifting:
 * a transform — even translateY(0) — makes the bar the containing block for
 * any fixed-position descendant, so the rule must not exist at rest. */
const LIFT_ATTR = 'data-mnav-kb'

/** Ignore sub-pixel / rounding noise so the composer never jitters. */
const MIN_LIFT_PX = 2

/** Above this visualViewport scale the geometry is pinch-zoom, not keyboard. */
const MAX_SCALE = 1.01

/** Extra clearance whenever the keyboard is up AND the browser reacted to it.
 * Third-party IMEs routinely under-report their height — the toolbar strip
 * above the keys is left out of what they hand the system, so the viewport
 * shrinks by less than the keyboard actually covers and the composer lands
 * slightly under it (搜狗 ~30px is a documented case; one reporter saw the
 * same with 微信输入法 after the viewport DID shrink). Deliberately small:
 * it only has to clear a toolbar strip, not a keyboard.
 *
 * ANDROID ONLY ({@link safetyPad}). The under-reporting is an Android IME
 * behaviour; iOS has one system keyboard whose height WebKit reports exactly,
 * so padding there would be a visible gap bought for nothing.
 *
 * The 15px default is what shipped; a device whose IME hides more of the
 * composer than that can raise it through the plugin row's
 * `config.keyboardSafetyPadPx` ({@link KeyboardTuning}). */
const SAFETY_PAD_PX = KEYBOARD_DEFAULTS.safetyPadPx

/** The safety pad this platform gets: the configured clearance, or nothing
 * off Android. UA sniffing is the right tool here — the target is a platform
 * defect, not a feature that could be detected.
 * @param padPx - the row's clearance; defaults to the shipped 15px. */
export function safetyPad(userAgent: string, padPx: number = SAFETY_PAD_PX): number {
  return /Android/iu.test(userAgent) ? padPx : 0
}

/** A viewport that lost at least this much against its no-keyboard baseline
 * has a keyboard up. Comfortably above the ~56px a collapsing URL bar moves,
 * comfortably below any real keyboard. */
const KEYBOARD_MIN_SHRINK_PX = 100

/** The official composer slot wrapper (same marker keyboard-guard reads). */
const COMPOSER = '[data-slot="conversation.composer.bar"]'

/** Dumb-keyboard probe: after a touch-granted focus, the viewport gets this
 * long to move before the keyboard is declared invisible to the browser. */
const PROBE_TOTAL_MS = 1200
const PROBE_INTERVAL_MS = 120

/** Per-browser cache of the probe's verdict. Once a keyboard has proven
 * invisible, later focuses lift IMMEDIATELY instead of sitting through the
 * probe again — the probe still runs in the background on every focus, and
 * any viewport movement it sees revokes the cache (IME switched, engine
 * fixed), returning the browser to the pure geometric path. */
const DUMB_KEY = 'dsh-mobile-nav.kb-dumb'
/** Any viewport movement beyond this during the probe means the browser can
 * see the keyboard (or is panning) — the geometric path owns the job then. */
const PROBE_EPSILON_PX = 8

/**
 * Fallback lift for a keyboard the browser cannot see (issue #1 确诊根因:
 * 微信输入法在该设备上不向系统 insets 上报键盘高度, Chrome 键盘高度恒 0).
 * There is no signal to measure, so this is an estimate: the reporter's
 * measured WeType is ~315 CSS px on a 858px viewport (~37%); 42% capped at
 * 400px covers taller IME toolbars without stranding the composer mid-screen.
 *
 * Both numbers are a guess about someone else's hardware, so both are knobs:
 * `config.keyboardLiftRatio` / `config.keyboardLiftMaxPx` on the plugin row
 * ({@link KeyboardTuning}). The shipped pair stays the default — an install
 * that never touches them behaves exactly as before.
 *
 * @param tuning - the row's tuning; defaults to the shipped estimate.
 */
export function estimatedLift(innerHeight: number, tuning: KeyboardTuning = KEYBOARD_DEFAULTS): number {
  return Math.min(Math.round(innerHeight * tuning.liftRatio), tuning.liftMaxPx)
}

/** One visualViewport reading, in CSS pixels. */
export interface ViewportReading {
  /** Layout viewport height (window.innerHeight). */
  innerHeight: number
  /** visualViewport.height. */
  vvHeight: number
  /** visualViewport.offsetTop. */
  offsetTop: number
  /** visualViewport.scale. */
  scale: number
}

/**
 * How far the composer must rise so its bottom edge sits on the visual
 * viewport's bottom edge (issue #1, 方案 2 of
 * docs/research-ime-keyboard-occlusion.md).
 *
 * The composer is sticky at the LAYOUT viewport's bottom; the keyboard
 * shrinks only the VISUAL viewport (Chrome 108+ resizes-visual). When the
 * browser also pans the visual viewport down to reveal the focused field —
 * iOS, and Android when its auto-scroll works — the occluded band is zero
 * and this stays a no-op. When it shrinks without panning (the reported
 * class of bug), the difference is exactly the hidden band.
 *
 * Pinch-zoom shrinks vvHeight too; the scale guard keeps zooming from
 * flinging the composer around.
 */
export function keyboardLift(reading: ViewportReading): number {
  if (reading.scale > MAX_SCALE) return 0
  const occluded = reading.innerHeight - reading.vvHeight - reading.offsetTop
  return occluded >= MIN_LIFT_PX ? Math.round(occluded) : 0
}

/**
 * The lift the composer actually gets, from the three sources in priority
 * order.
 * @param geometric - {@link keyboardLift} of the current reading.
 * @param estimate - the dumb-keyboard estimate, 0 when not in that mode.
 * @param keyboardShrunk - the viewport lost {@link KEYBOARD_MIN_SHRINK_PX}
 *   or more against its no-keyboard baseline, i.e. the browser reacted.
 * @param pad - this platform's safety clearance, from {@link safetyPad}.
 * @returns pixels to translate the composer up by.
 */
export function composerLift(
  geometric: number,
  estimate: number,
  keyboardShrunk: boolean,
  pad: number,
): number {
  // Measured occlusion, plus clearance for the strip the IME did not declare.
  if (geometric > 0) return geometric + pad
  // The estimate is a generous fraction already; padding it would strand the
  // composer mid-screen.
  if (estimate > 0) return estimate
  // Nothing occluded on paper, but a keyboard IS up and the browser handled
  // it: the only thing that can still cover the composer is an under-reported
  // toolbar, so clear exactly that.
  return keyboardShrunk ? pad : 0
}

/**
 * S10 — keep the composer above the software keyboard (< 768px).
 *
 * The shell deliberately relies on the browser's own focus-reveal behaviour
 * (home.css.ts: plain overflow:hidden so iOS pans the visual viewport, no
 * visualViewport JS). Issue #1 (小米 + 微信输入法) showed one environment
 * where that chain can break while the viewport still shrinks. This effect
 * is the increment that covers it: mirror the occluded band into a root CSS
 * variable, and let the stylesheet translate the composer up by it. In every
 * environment where the browser already handles the keyboard the band
 * computes to zero and nothing changes.
 *
 * `scroll` is listened to as well as `resize`: panning the visual viewport
 * changes offsetTop without a resize (CSSOM View §13.2), and both sides of
 * the subtraction must stay fresh.
 *
 * Second layer (2026-08-21, after on-device confirmation): the reporter's
 * 小米 + 微信输入法 keyboard is INVISIBLE to Chrome — vv.height stayed 859/858
 * with the keyboard open, so no event ever fires and the geometry above is
 * honestly zero. For that class only, a touch-granted composer focus starts a
 * short probe; if the viewport has not moved at all by the end, the composer
 * gets an ESTIMATED lift until blur. Guards against false positives:
 * - probe only after a recent touch pointerdown (a hardware-keyboard focus
 *   never lifts anything);
 * - any viewport movement ≥ {@link PROBE_EPSILON_PX} cancels the probe — a
 *   browser that shows any reaction owns the reveal itself (iOS pans,
 *   working Android resizes);
 * - a non-zero geometric lift always wins over the estimate.
 *
 * Third layer: an IME that under-reports its height (toolbar strip left out
 * of what it declares) makes the browser shrink the viewport by less than the
 * keyboard covers — every number the page can read is self-consistent, so no
 * occlusion is computable. Whenever a keyboard is up and the browser DID
 * react, the composer therefore also gets {@link safetyPad} of clearance —
 * Android only, where the under-reporting happens.
 * See {@link composerLift} for how the three sources compose.
 */
export function installKeyboardAvoid(ctx: ClientContext): void {
  ctx.effect(() => {
    const vv = window.visualViewport
    if (vv === null || vv === undefined) return () => {}
    const viewport = vv
    const narrow = window.matchMedia(PHONE_QUERY)
    const root = document.documentElement
    let frame = 0
    let applied = 0
    let attached = false
    /** Estimated lift while a browser-invisible keyboard is up; 0 otherwise. */
    let estimate = 0
    let probeTimer = 0
    let lastTouch = 0
    /** Viewport height with no keyboard up, the shrink is measured against
     * it. Re-read on every sync that finds the composer unfocused, so a
     * rotation or a URL-bar change rebases it without extra listeners. */
    let baseline = 0
    /** Row tuning for the estimate path. Starts on the shipped defaults and
     * is replaced once the config request lands (a few ms into the page, and
     * always long before a touch focus can raise a keyboard) — no re-sync is
     * forced, the next focus or viewport event picks the new values up. */
    let tuning = KEYBOARD_DEFAULTS
    let pad = safetyPad(navigator.userAgent)
    void clientConfig().then((loaded) => {
      tuning = loaded.keyboard
      pad = safetyPad(navigator.userAgent, tuning.safetyPadPx)
    })

    const composerTextarea = (node: unknown): boolean =>
      node instanceof HTMLElement && node.tagName === 'TEXTAREA' && node.closest(COMPOSER) !== null

    const sync = (): void => {
      const focused = composerTextarea(document.activeElement)
      if (!focused) baseline = viewport.height
      const geometric = keyboardLift({
        innerHeight: window.innerHeight,
        vvHeight: viewport.height,
        offsetTop: viewport.offsetTop,
        scale: viewport.scale,
      })
      const shrunk = focused && baseline - viewport.height >= KEYBOARD_MIN_SHRINK_PX
      const lift = composerLift(geometric, estimate, shrunk, pad)
      if (lift === applied) return
      applied = lift
      if (lift === 0) {
        root.style.removeProperty(LIFT_VAR)
        root.removeAttribute(LIFT_ATTR)
      } else {
        root.style.setProperty(LIFT_VAR, `${lift}px`)
        root.setAttribute(LIFT_ATTR, '')
      }
    }
    const schedule = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        sync()
      })
    }

    const stopProbe = (): void => {
      if (probeTimer !== 0) window.clearTimeout(probeTimer)
      probeTimer = 0
    }
    /** End the estimated lift AND close the keyboard (blur), keeping the two
     * in one coherent state. Only ever called while an estimate is active, so
     * healthy environments never feel it. */
    const retract = (): void => {
      stopProbe()
      if (estimate !== 0) {
        estimate = 0
        sync()
      }
      const el = document.activeElement
      if (composerTextarea(el) && el instanceof HTMLElement) el.blur()
    }
    /** True when a touch outside the composer means "the reader moved on". */
    const outside = (target: EventTarget | null): boolean =>
      estimate !== 0 && target instanceof Element && target.closest(COMPOSER) === null
    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') lastTouch = Date.now()
      // An invisible keyboard also closes invisibly (system back / the IME's
      // own collapse chevron keep the textarea focused), so blur alone cannot
      // end the estimate. A tap OR a scroll outside the composer is the
      // reader moving on — retract and dismiss the keyboard together, the
      // same gesture mainstream chat apps use.
      // ponytail: collapse-then-just-read keeps the lift until the next
      // touch; a real close signal does not exist in this class.
      if (outside(event.target)) retract()
    }
    const onTouchMove = (event: TouchEvent): void => {
      if (outside(event.target)) retract()
    }
    const onFocusIn = (event: FocusEvent): void => {
      if (!composerTextarea(event.target)) return
      // Focus not born from a touch (hardware keyboard, programmatic) raises
      // no on-screen keyboard — never estimate for it.
      if (Date.now() - lastTouch > 1000) return
      stopProbe()
      // A browser already convicted by an earlier probe lifts right away —
      // the probe below still runs and revokes the verdict if the viewport
      // turns out to react after all.
      if (localStorage.getItem(DUMB_KEY) === '1') {
        estimate = estimatedLift(window.innerHeight, tuning)
        sync()
      }
      const h0 = viewport.height
      const t0 = viewport.offsetTop
      const i0 = window.innerHeight
      const deadline = Date.now() + PROBE_TOTAL_MS
      const moved = (): boolean =>
        Math.abs(viewport.height - h0) >= PROBE_EPSILON_PX
        || Math.abs(viewport.offsetTop - t0) >= PROBE_EPSILON_PX
        || Math.abs(window.innerHeight - i0) >= PROBE_EPSILON_PX
      const step = (): void => {
        probeTimer = 0
        if (moved()) {
          // The browser can see this keyboard: the geometric path owns the
          // reveal. Drop any stale verdict and estimated lift.
          localStorage.removeItem(DUMB_KEY)
          if (estimate !== 0) {
            estimate = 0
            sync()
          }
          return
        }
        if (Date.now() < deadline) {
          probeTimer = window.setTimeout(step, PROBE_INTERVAL_MS)
          return
        }
        // Keyboard is up (touch focus on a phone) yet the viewport never
        // reacted: the browser cannot see it. Estimate until blur, and
        // remember the verdict so the next focus skips the wait.
        if (!composerTextarea(document.activeElement)) return
        localStorage.setItem(DUMB_KEY, '1')
        estimate = estimatedLift(window.innerHeight, tuning)
        sync()
      }
      probeTimer = window.setTimeout(step, PROBE_INTERVAL_MS)
    }
    const onFocusOut = (event: FocusEvent): void => {
      if (!composerTextarea(event.target)) return
      stopProbe()
      if (estimate === 0) return
      estimate = 0
      sync()
    }

    const attach = (): void => {
      if (attached) return
      attached = true
      viewport.addEventListener('resize', schedule)
      viewport.addEventListener('scroll', schedule)
      document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
      document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true })
      document.addEventListener('focusin', onFocusIn, true)
      document.addEventListener('focusout', onFocusOut, true)
      sync()
    }
    const detach = (): void => {
      if (!attached) return
      attached = false
      viewport.removeEventListener('resize', schedule)
      viewport.removeEventListener('scroll', schedule)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('touchmove', onTouchMove, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      stopProbe()
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      applied = 0
      estimate = 0
      baseline = 0
      root.style.removeProperty(LIFT_VAR)
      root.removeAttribute(LIFT_ATTR)
    }

    if (narrow.matches) attach()
    const onChange = (event: MediaQueryListEvent): void => (event.matches ? attach() : detach())
    narrow.addEventListener('change', onChange)
    return () => {
      narrow.removeEventListener('change', onChange)
      detach()
    }
  }, 'dsh-mobile-nav: composer keyboard avoid')
}
