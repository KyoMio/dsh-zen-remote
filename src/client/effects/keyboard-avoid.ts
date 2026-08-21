import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

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
 * S10 — keep the composer above the software keyboard (< 768px).
 *
 * The shell deliberately relies on the browser's own focus-reveal behaviour
 * (home.css.ts: plain overflow:hidden so iOS pans the visual viewport, no
 * visualViewport JS). Issue #1 (小米 + 微信输入法) showed one environment
 * where that chain can break while the viewport still shrinks. This effect
 * is the increment that covers it: mirror the occluded band into a root CSS
 * variable, and let the stylesheet translate the composer up by it. In every
 * environment where the browser already handles the keyboard the band
 * computes to zero and nothing changes; if the IME reports no height at all
 * (the research's候选 1/2) no event fires and this is inert — that class
 * needs the polling fallback, deliberately not built until confirmed.
 *
 * `scroll` is listened to as well as `resize`: panning the visual viewport
 * changes offsetTop without a resize (CSSOM View §13.2), and both sides of
 * the subtraction must stay fresh.
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

    const sync = (): void => {
      const lift = keyboardLift({
        innerHeight: window.innerHeight,
        vvHeight: viewport.height,
        offsetTop: viewport.offsetTop,
        scale: viewport.scale,
      })
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

    const attach = (): void => {
      if (attached) return
      attached = true
      viewport.addEventListener('resize', schedule)
      viewport.addEventListener('scroll', schedule)
      sync()
    }
    const detach = (): void => {
      if (!attached) return
      attached = false
      viewport.removeEventListener('resize', schedule)
      viewport.removeEventListener('scroll', schedule)
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      applied = 0
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
