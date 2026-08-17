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

/**
 * Does the layout viewport sit shorter than the screen by at least the top
 * inset env() still claims? (S1.2 predicate, wired in S1.3.)
 *
 * Device numbers (iPhone, iOS 26.5, standalone PWA, 393x852): innerHeight
 * 793, env top 59 (= 852 - 793), env bottom 34, frame bottom 793 flush.
 * The same device in a Safari TAB reads innerHeight 695 with every surface
 * flush and every design value correct, which is what rules our own CSS out.
 *
 * What the true-branch means, settled by S1.2 + S1.3 device evidence: the
 * viewport is anchored at screen y=0 and merely cut 59px short at the BOTTOM
 * — not pushed down below the status bar. So the top inset is paid exactly
 * once and must be left alone, while the bottom inset is a lie: the home
 * indicator lives in the dead strip below the page. installSunkInset() acts
 * on that, and only on --mnav-sab.
 *
 * The `envTop > 0` guard is what keeps every other standalone install out:
 * landscape iPhone (top inset 0, the notch moves to left/right), iPad, and
 * Android — where standalone also loses status-bar height off innerHeight but
 * reports env top 0 — all fall through to false. Kept pure so the boundaries
 * are checkable off-device: scripts/check-sunk-viewport.mjs.
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

/**
 * iOS standalone-PWA keyboard shrink (S1.2, 2026-08-17) — the ~60px white
 * band under the composer AND under the session list.
 *
 * Documented WebKit defect: the first time the software keyboard opens inside
 * a home-screen (standalone) PWA, the layout viewport permanently loses the
 * status-bar height for the rest of the app session. innerHeight,
 * visualViewport.height and 100dvh all report the shrunken value together, so
 * nothing inside the page can see anything wrong — the page simply ends early
 * and the strip below it is system background that no CSS can reach. Reported
 * as 932 -> 873 on an iPhone Pro Max; the user's device reads 852 -> 793.
 * Both are exactly one status bar. See
 * https://dev.to/cederhook/fixing-the-ios-standalone-pwa-keyboard-bug-that-shrinks-your-viewport-for-good-63d
 *
 * This is why the reported symptom is asymmetric and why the earlier
 * "double-counted top inset" reading was wrong: the top edge is genuinely
 * correct (env top 59 is paid once, the viewport starts at screen y=0), the
 * bottom is simply 59px short. It also explains a chat client being hit
 * hardest — the trigger is typing, which happens on the first message.
 *
 * The only known cure is to make WebKit re-measure: drop a full-viewport
 * element out of the box tree and force a synchronous reflow. Two departures
 * from the published recipe:
 * - scrollTop is saved and restored around the toggle. Un-boxing an ancestor
 *   resets every descendant scroller to 0, which in a chat client means the
 *   conversation jumps to its first message. Both happen inside one task, so
 *   no frame is ever painted in between and nothing flickers.
 * - the baseline is the tallest innerHeight this session has actually seen,
 *   not the screen height. On any device where the viewport is legitimately
 *   short, the baseline equals the current height and this never fires.
 *
 * Standalone-gated, so a browser tab (and every desktop, CDP included) is a
 * strict no-op — which is also why the fix cannot be regression-tested here
 * and has to be confirmed on the device.
 */
export function installViewportHeal(ctx: ClientContext): void {
  ctx.effect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true
    /* iOS-only on purpose. The ceiling below leans on screen.height being the
       height the viewport SHOULD have, which holds for an iPhone standalone
       app under viewport-fit=cover and does not hold on Android, where the
       navigation bar makes screen.height permanently larger than any viewport
       and every keyboard dismiss would trigger a pointless reflow. */
    if (!standalone || !/iPad|iPhone|iPod/.test(navigator.userAgent)) return () => {}

    /* Ceiling = the tallest this session has seen, floored at the screen —
       the screen half matters because the shrink outlives a page reload, so a
       PWA reopened into the broken state would otherwise measure 793 as
       "normal" and never heal itself. */
    let tallest = window.innerHeight
    const ceiling = (): number => Math.max(tallest, window.screen.height)
    const onResize = (): void => {
      if (window.innerHeight > tallest) tallest = window.innerHeight
    }

    /* Give up after three ineffective attempts per trigger: on a device whose
       viewport is short for a reason a reflow cannot fix (the iOS 26.x
       standalone regression family) retrying forever buys nothing. The two
       budgets are separate on purpose — the cold-start attempts would
       otherwise spend the whole allowance before the user ever types, and the
       keyboard shrink IS reflow-curable even on a device whose cold start is
       not. */
    const strikes = { boot: 0, blur: 0 }
    const heal = (kind: 'boot' | 'blur'): void => {
      if (strikes[kind] >= 3 || ceiling() - window.innerHeight <= 4) return
      const frame = document.querySelector<HTMLElement>('[data-mobile-nav="frame"]')
      if (frame === null) return
      const scroller = document.querySelector<HTMLElement>('[class$="_scrollBody"]')
      const scrollTop = scroller?.scrollTop ?? 0
      const previous = frame.style.display
      frame.style.display = 'none'
      void frame.offsetHeight /* forces the synchronous reflow that re-measures */
      frame.style.display = previous
      if (scroller !== null) scroller.scrollTop = scrollTop
      strikes[kind] = ceiling() - window.innerHeight > 4 ? strikes[kind] + 1 : 0
    }

    /* Blur is when the keyboard starts closing; the viewport settles a beat
       later. Two attempts because the dismiss animation length is not
       specified anywhere, and a heal that runs too early is a silent no-op. */
    const timers: number[] = []
    const onFocusOut = (event: FocusEvent): void => {
      if (!(event.target instanceof HTMLElement)) return
      if (event.target.matches('textarea, input') !== true) return
      timers.push(window.setTimeout(() => heal('blur'), 300), window.setTimeout(() => heal('blur'), 900))
    }

    /* Cold start (S1.3): the user's iOS 26.5 device is already 59px short on
       a freshly killed-and-reopened app that never saw the keyboard, so the
       keyboard trigger alone is not the whole story. Same reflow, tried once
       the shell has mounted and again after it has settled, plus every return
       to the foreground — iOS re-lays a backgrounded PWA out and that is
       another moment the height can come back wrong. Whether a reflow can win
       against a system-level regression is unknowable off-device; the strike
       budget is what keeps a losing attempt cheap. */
    timers.push(window.setTimeout(() => heal('boot'), 1000), window.setTimeout(() => heal('boot'), 3000))
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      timers.push(window.setTimeout(() => heal('boot'), 300))
    }

    window.addEventListener('resize', onResize)
    document.addEventListener('focusout', onFocusOut, true)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('resize', onResize)
      document.removeEventListener('focusout', onFocusOut, true)
      document.removeEventListener('visibilitychange', onVisible)
      for (const t of timers) clearTimeout(t)
    }
  }, 'dsh-mobile-nav: iOS viewport-shrink heal (boot / foreground / keyboard)')
}

/**
 * Sunk-viewport compensation (S1.3, 2026-08-17) — zeroes --mnav-sab ONLY.
 *
 * When isViewportSunkBelowStatusBar() holds, the layout viewport is 59px
 * shorter than the screen while env() still reports the full pair of insets.
 * The bottom one is then a lie with a cost: the home indicator sits in the
 * dead strip BELOW the page, so the 34px we reserve for it is 34px of blank
 * page stacked on top of an already-blank system band. Zeroing it does not
 * fix the band (nothing in the page can) but stops us widening it.
 *
 * --mnav-sat is deliberately left alone: the top edge is measured correct on
 * the device (header sits right under the notch), and the S1.2 round already
 * burned a cycle on the theory that it was double-counted.
 *
 * Reversible by design. The predicate is re-evaluated on every resize, so a
 * viewport that comes back to full height — the heal above winning, or Apple
 * shipping the fix — drops the override and the normal env() compensation
 * returns without a reload. `data-mnav-sunk` on <html> is what the debug
 * badge reads, so the badge reports the state that is actually in force
 * rather than re-deriving it.
 */
export function installSunkInset(ctx: ClientContext): void {
  ctx.effect(() => {
    /* ?mobile-nav-inset outranks this: both write the same inline property on
       <html>, and the debug param exists precisely to fake insets that this
       would then erase. Param present = stay out entirely, attribute included,
       so the badge shows "n/a" instead of a state nobody is enforcing. */
    if (new URLSearchParams(location.search).has('mobile-nav-inset')) return () => {}
    const root = document.documentElement
    /* env() is only readable through a real element's computed style. */
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;' +
      'padding-top:env(safe-area-inset-top,0px)'
    document.body.appendChild(probe)

    const sync = (): void => {
      const sunk = isViewportSunkBelowStatusBar({
        standalone: window.matchMedia('(display-mode: standalone)').matches
          || (navigator as Navigator & { standalone?: boolean }).standalone === true,
        screenHeight: window.screen.height,
        innerHeight: window.innerHeight,
        envTop: Number.parseFloat(getComputedStyle(probe).paddingTop) || 0,
      })
      root.dataset.mnavSunk = sunk ? '1' : '0'
      if (sunk) root.style.setProperty('--mnav-sab', '0px')
      else root.style.removeProperty('--mnav-sab')
    }
    sync()
    /* resize covers rotation and any height the heal above wins back.
       Deliberately not visualViewport: it fires on every keyboard show/hide
       while innerHeight, the value read here, does not move on iOS. */
    window.addEventListener('resize', sync)
    window.addEventListener('orientationchange', sync)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('orientationchange', sync)
      probe.remove()
      root.style.removeProperty('--mnav-sab')
      delete root.dataset.mnavSunk
    }
  }, 'dsh-mobile-nav: sunk-viewport bottom-inset override')
}
