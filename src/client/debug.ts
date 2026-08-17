import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { isViewportSunkBelowStatusBar } from './effects/phone-chrome.ts'
/**
 * Debug badge — ?mobile-nav-debug=1
 * Renders a live state overlay (URL, viewport, media queries, shell chrome,
 * aionui columns, genui cards, captured errors) so a phone-side repro can be
 * diagnosed without guessing. No-op unless the query param is present.
 */
export function installDebugBadge(ctx: ClientContext): void {
  /**
   * Fake safe-area inset — ?mobile-nav-inset=54 or ?mobile-nav-inset=54,34
   * env(safe-area-inset-*) is hard 0 on every desktop browser (CDP included),
   * so notch bugs are invisible until a real phone loads the page — the S2.1
   * hotfix exists because of exactly that. Overriding --mnav-sat / --mnav-sab
   * (see styles/base.css.ts) on the root element reproduces a notch anywhere.
   * No param = the variables keep their env() values = zero behaviour change.
   *
   * One value fakes the TOP inset only (the historic behaviour — every S1-S3
   * verification recipe passes `=54`, and they must keep meaning what they
   * did). A second, comma-separated value fakes the BOTTOM inset too:
   * `=54,34` is the iPhone notch + home-indicator pair. The bottom half was
   * added in S4.1 because the home-bar padding it guards (composer clearance
   * over the indicator) is otherwise untestable off-device for exactly the
   * same reason the top half exists.
   */
  ctx.effect(() => {
    const raw = new URLSearchParams(location.search).get('mobile-nav-inset')
    if (raw === null) return () => {}
    const [topRaw, bottomRaw] = raw.split(',')
    const top = Number(topRaw)
    if (!Number.isFinite(top)) return () => {}
    const root = document.documentElement
    root.style.setProperty('--mnav-sat', `${top}px`)
    const bottom = bottomRaw === undefined ? Number.NaN : Number(bottomRaw)
    if (Number.isFinite(bottom)) root.style.setProperty('--mnav-sab', `${bottom}px`)
    return () => {
      root.style.removeProperty('--mnav-sat')
      root.style.removeProperty('--mnav-sab')
    }
  }, 'dsh-mobile-nav: fake safe-area inset')

  const DEBUG_KEY = 'dsh-mobile-nav.debug'

  /**
   * No-URL toggle — 5 quick taps on the home screen's top bar.
   * A standalone PWA has no address bar, and the paired-device cookie lives
   * in the PWA's own jar (Safari hits the pairing wall instead), so the
   * ?mobile-nav-debug=1 param is unreachable exactly where the badge is
   * needed most.
   *
   * The target is deliberately NOT [data-mobile-nav="ws-switch"] any more:
   * that button opens the workspace sheet on the FIRST tap, so taps 2..5
   * land on the sheet backdrop, `closest()` misses, and the counter never
   * reaches five — the original binding only ever fired by luck, and it left
   * a user stuck inside debug mode with no way back out. The logo img has no
   * click handler at all; the home-top container minus the switch button is
   * the fallback for when the icon 404s and the img is not rendered.
   */
  ctx.effect(() => {
    let taps = 0
    let firstTap = 0
    const onTap = (event: Event) => {
      if (!(event.target instanceof Element)) return
      const inTopBar = event.target.closest('[data-mobile-nav="home-logo"]') !== null
        || (event.target.closest('[data-mobile-nav="home-top"]') !== null
          && event.target.closest('[data-mobile-nav="ws-switch"]') === null)
      if (!inTopBar) return
      const now = Date.now()
      if (now - firstTap > 2500) { taps = 0; firstTap = now }
      taps += 1
      if (taps >= 5) {
        if (localStorage.getItem(DEBUG_KEY) === '1') localStorage.removeItem(DEBUG_KEY)
        else localStorage.setItem(DEBUG_KEY, '1')
        location.reload()
      }
    }
    document.addEventListener('click', onTap, true)
    return () => document.removeEventListener('click', onTap, true)
  }, 'dsh-mobile-nav: debug badge tap toggle')

  ctx.effect(() => {
    const enabled = new URLSearchParams(location.search).has('mobile-nav-debug')
      || localStorage.getItem('dsh-mobile-nav.debug') === '1'
    if (!enabled) return () => {}
    const errors: string[] = []
    const onError = (event: ErrorEvent) => errors.push(`ERR ${event.message.slice(0, 120)}`)
    const onRejection = (event: PromiseRejectionEvent) => errors.push(`REJ ${String(event.reason).slice(0, 120)}`)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)

    /* Probe element: reads the REAL env(safe-area-inset-*) as computed padding
       — the --mnav-* vars can be faked by the inset param, this cannot. */
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;' +
      'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)'
    document.body.appendChild(probe)

    const badge = document.createElement('div')
    badge.style.cssText = [
      /* Sits BELOW the notch on purpose: at the old flat top:40px the badge
         painted into the status-bar strip and covered the session header,
         which read on a screenshot as "the header ran under the notch in
         debug mode" — a measurement artefact that cost a whole round of
         diagnosis. env() here, not --mnav-sat: the badge must stay put even
         when the inset param is faking that variable. */
      'position:fixed', 'top:calc(env(safe-area-inset-top, 0px) + 8px)', 'right:6px', 'z-index:2147483000',
      'background:rgba(0,0,0,.82)', 'color:#fff', 'font:11px/1.5 ui-monospace,monospace',
      'padding:8px 10px', 'border-radius:8px', 'max-width:94vw', 'max-height:70vh',
      /* pointer-events must be auto for the escape hatch below — with `none`
         the badge could only be dismissed by editing localStorage, which is
         not reachable from a standalone PWA. touch-action/user-select keep
         the double tap from being read as zoom or text selection. */
      'overflow:auto', 'white-space:pre-wrap', 'pointer-events:auto',
      'touch-action:manipulation', '-webkit-user-select:none', 'user-select:none',
    ].join(';')
    /* Escape hatch: two taps on the badge within 600ms turn debug off. The
       enable gesture lives on the home screen, which a user deep inside a
       session cannot reach without first getting out of the way of the badge
       — so the off switch belongs on the badge itself. */
    /* The full read-out is tall enough to cover the session list, and with
       pointer-events:auto (required for the escape hatch) it swallowed every
       tap under it — the user could not open a session with debug on. The
       badge therefore starts COLLAPSED (a one-line pill showing vh, the
       number that matters for the viewport-shrink bug) and only expands on
       demand. Single tap toggles collapsed/expanded (deferred 620ms so it
       can be distinguished from the exit gesture); double tap still exits. */
    let lastTap = 0
    let collapsed = true
    let singleTapTimer: ReturnType<typeof setTimeout> | undefined
    const onBadgeTap = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      const now = Date.now()
      if (now - lastTap < 600) {
        if (singleTapTimer !== undefined) clearTimeout(singleTapTimer)
        localStorage.removeItem(DEBUG_KEY)
        const url = new URL(location.href)
        url.searchParams.delete('mobile-nav-debug')
        location.replace(url.toString())
        return
      }
      lastTap = now
      singleTapTimer = setTimeout(() => {
        collapsed = !collapsed
        paint()
      }, 620)
    }
    badge.addEventListener('click', onBadgeTap)

    const read = (): string => {
      const q = (sel: string) => !!document.querySelector(sel)
      const vis = (sel: string) => {
        const el = document.querySelector<HTMLElement>(sel)
        return el === null ? 'absent' : getComputedStyle(el).visibility
      }
      const frame = document.querySelector<HTMLElement>('[data-mobile-nav="frame"]')
      if (collapsed) return `DBG vh ${innerHeight}/${screen.height} ▸ 单击展开 双击关闭`
      return [
        '▾ 单击收起 · 双击关闭 debug',
        `URL ${location.pathname}${location.search}`,
        `W ${innerWidth} x ${innerHeight} dpr ${devicePixelRatio}`,
        `mq≤1023 ${matchMedia('(max-width: 1023px)').matches}  mq≥1024 ${matchMedia('(min-width: 1024px)').matches}`,
        `css ${q('style[data-plugin-css*="mobile"]')}  frame ${!!frame}`,
        `previewCol ${vis('[data-aionui-preview-col]')}  explorerCol ${vis('[data-aionui-explorer-col]')}`,
        `previewOpen ${frame?.hasAttribute('data-aionui-preview-open') ?? '?'}  explorerOpen ${frame?.hasAttribute('data-aionui-explorer-open') ?? '?'}  previewFull ${frame?.hasAttribute('data-mobile-preview-full') ?? '?'}`,
        `header ${vis('[data-phase] header')} h${Math.round(document.querySelector('[data-phase] header')?.getBoundingClientRect().height ?? 0)}  composer ${q('textarea')}`,
        `sat ${getComputedStyle(document.documentElement).getPropertyValue('--mnav-sat').trim() || '?'}  sab ${getComputedStyle(document.documentElement).getPropertyValue('--mnav-sab').trim() || '?'}`,
        (() => {
          /* Bottom-gap forensics: real env values + who ends where. */
          const ps = getComputedStyle(probe)
          const bottomOf = (sel: string): string => {
            const el = document.querySelector(sel)
            return el === null ? '—' : String(Math.round(el.getBoundingClientRect().bottom))
          }
          /* Composer ledger: bottom/gap-to-viewport for every layer between
             the textarea and the screen edge, so a "white band under the
             composer" screenshot says WHICH layer owns it instead of only
             where the textarea ends. Anchors per AGENTS.md: InputBar root is
             the padding carrier, _card is the rounded visual box, _composerSeat
             is the sticky seat, _scrollBody is the real scroll container. */
          const pair = (sel: string): string => {
            const el = document.querySelector(sel)
            if (el === null) return '—'
            const b = el.getBoundingClientRect().bottom
            return `${Math.round(b)}/${Math.round(innerHeight - b)}`
          }
          const barRoot = document.querySelector('[data-slot="conversation.composer.bar"] > [class$="_root"]')
          /* Top-edge forensics: rect.top of the surfaces that consume
             --mnav-sat. These separate the two competing readings of the
             device numbers — a viewport SUNK below the status bar (origin at
             screen y=59, so a working sat padding puts the header at 118 and
             the top gap is doubled) versus a viewport anchored at screen y=0
             that is merely 59px short at the bottom (header at 59, top
             correct, the missing 59 showing as a band under the composer).
             innerHeight alone cannot tell them apart; the viewport ORIGIN can,
             hence screenY / visualViewport offsets / the edge markers. */
          const topOf = (sel: string): string => {
            const el = document.querySelector(sel)
            return el === null ? '—' : String(Math.round(el.getBoundingClientRect().top))
          }
          const framePadTop = frame === null ? '—' : getComputedStyle(frame).paddingTop
          const vv = window.visualViewport
          return [
            `env sat ${ps.paddingTop} sab ${ps.paddingBottom}`,
            `screen ${screen.width}x${screen.height} avail ${screen.availWidth}x${screen.availHeight}`,
            `vh ${innerHeight} vv ${Math.round(vv?.height ?? -1)} outH ${outerHeight}`,
            `scrXY ${screenX},${screenY} vvOff ${Math.round(vv?.offsetTop ?? -1)} vvPage ${Math.round(vv?.pageTop ?? -1)} vvScale ${vv?.scale ?? '?'}`,
            `sunk? ${isViewportSunkBelowStatusBar({
              standalone: matchMedia('(display-mode: standalone)').matches
                || (navigator as Navigator & { standalone?: boolean }).standalone === true,
              screenHeight: screen.height,
              innerHeight,
              envTop: Number.parseFloat(ps.paddingTop) || 0,
            })} standalone ${matchMedia('(display-mode: standalone)').matches}`,
            `frameTop ${topOf('[data-mobile-nav="frame"]')} padTop ${framePadTop} headerTop ${topOf('[data-phase] header')} homeTopY ${topOf('[data-mobile-nav="home-top"]')}`,
            `botFrame ${bottomOf('[data-mobile-nav="frame"]')} composer ${bottomOf('[data-phase] textarea')}`,
            `taB ${pair('[data-phase] textarea')} cardB ${pair('[data-slot="conversation.composer.bar"] [class$="_card"]')}`,
            `barB ${pair('[data-slot="conversation.composer.bar"] > [class$="_root"]')} seatB ${pair('[class$="_composerSeat"]')} scrollB ${pair('[class$="_scrollBody"]')}`,
            `sabPad ${barRoot === null ? '—' : getComputedStyle(barRoot).paddingBottom}`,
            `botList ${bottomOf('[data-mobile-nav="home-list"]')} fab ${bottomOf('[data-mobile-nav="home-fab"]')}`,
            `cssLen ${document.querySelector('style[data-plugin-css*="mobile"]')?.textContent?.length ?? 0}`,
          ].join('\n')
        })(),
        `genui cards ${document.querySelectorAll('[data-genui]').length}  panel ${q('[data-genui-panel]')}`,
        `phase ${document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? '?'}`,
        `errs ${errors.slice(-5).join(' | ') || 'none'}`,
      ].join('\n')
    }
    /* Feedback-loop guards: painting the badge mutates the body subtree the
       observer watches — without these two checks the observer retriggers
       itself forever and freezes the page (the badge was rarely actually
       enabled before, which is how this survived). */
    const paint = (): void => {
      const next = read()
      if (next !== badge.textContent) badge.textContent = next
    }
    paint()
    const observer = new MutationObserver((mutations) => {
      if (mutations.every((m) => m.target === badge || badge.contains(m.target) || m.target === probe)) return
      paint()
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    const timer = setInterval(paint, 1500)
    document.body.appendChild(badge)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      observer.disconnect()
      clearInterval(timer)
      probe.remove()
      badge.remove()
    }
  }, 'dsh-mobile-nav: debug badge')
}
