import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Phone chrome: KEEP the system status bar (no fullscreen) and make it
 * blend into the page. On narrow screens:
 * - The viewport meta gains viewport-fit=cover, so env(safe-area-inset-top)
 *   is the real status-bar / notch height and the stylesheet can push every
 *   surface below it (off notched phones, or in a browser tab where the
 *   layout viewport already sits below the status bar, the inset is 0 and
 *   nothing shifts).
 * - A theme-color meta tracks the shell background (the official theme is
 *   toggled by body[data-ds-dark-theme], which flips --dsw-alias-bg-base):
 *   Android then paints the status bar / URL bar with the page's own base
 *   color, so the status bar reads as part of the UI instead of a foreign
 *   strip. The drawer paints the same strip on iOS / notch displays.
 * - gesturestart is suppressed as the legacy-iOS fallback for double-tap
 *   zoom; modern browsers are covered by the stylesheet's
 *   touch-action: manipulation (which keeps pan and pinch zoom).
 */
/**
 * Candidate test for the "sunk viewport" model of the iOS standalone-PWA
 * quirk (S1.2, 2026-08-17). NOT WIRED TO ANY STYLE — deliberately.
 *
 * Real-device numbers (iPhone, standalone PWA, 393x852 screen): innerHeight
 * 793, env top 59 (= 852 - 793), env bottom 34, frame bottom 793 flush.
 * One reading is that the system already pushed the layout viewport below the
 * status bar while env() still reports the full notch, so --mnav-sat pads a
 * second time. But the user reports the session header sits correctly right
 * under the notch, and a ~60px white band at the BOTTOM — which instead fits
 * a viewport anchored at screen y=0 and merely 59px short of the screen
 * bottom. Both models predict the same innerHeight; only the viewport's
 * on-screen ORIGIN separates them, and that is what the debug badge now
 * measures (screenY / visualViewport offsets / the two edge markers).
 *
 * So this stays a pure, tested predicate that the badge merely displays.
 * Wiring it to zero --mnav-sat is a one-liner once the screenshot settles
 * which model is real; doing it now would break a top edge that is correct.
 * See scripts/check-sunk-viewport.mjs — no desktop browser can enter the mode.
 *
 * The `envTop > 0` guard is what keeps every other standalone install out:
 * landscape iPhone (top inset 0, the notch moves to left/right), iPad, and
 * Android — where standalone also loses status-bar height off innerHeight but
 * reports env top 0 — all fall through to false.
 */
export function isViewportSunkBelowStatusBar(input: {
  standalone: boolean
  screenHeight: number
  innerHeight: number
  envTop: number
}): boolean {
  return input.standalone
    && input.envTop > 0
    && input.screenHeight - input.innerHeight >= input.envTop
}

export function installPhoneChrome(ctx: ClientContext): void {
  ctx.effect(() => {
    const narrow = window.matchMedia('(max-width: 1023px)')
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const originalViewport = viewport?.content ?? ''
    const themeMeta = document.createElement('meta')
    themeMeta.name = 'theme-color'
    const bodyBg = (): string => getComputedStyle(document.body).backgroundColor

    const sync = (): void => {
      if (viewport !== null) viewport.content = 'width=device-width, initial-scale=1, viewport-fit=cover'
      themeMeta.content = bodyBg()
      if (themeMeta.parentElement === null) document.head.appendChild(themeMeta)
    }
    const restore = (): void => {
      if (viewport !== null) viewport.content = originalViewport
      themeMeta.remove()
    }
    const onGestureStart = (event: Event) => event.preventDefault()
    if (narrow.matches) sync()
    const onChange = (event: MediaQueryListEvent) => (event.matches ? sync() : restore())
    narrow.addEventListener('change', onChange)
    const observer = new MutationObserver(() => {
      if (narrow.matches) themeMeta.content = bodyBg()
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    document.addEventListener('gesturestart', onGestureStart)
    return () => {
      narrow.removeEventListener('change', onChange)
      observer.disconnect()
      document.removeEventListener('gesturestart', onGestureStart)
      restore()
    }
  }, 'dsh-mobile-nav: status bar theme + viewport + zoom guard')
}
