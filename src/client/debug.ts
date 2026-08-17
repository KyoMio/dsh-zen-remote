import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
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

  ctx.effect(() => {
    if (!new URLSearchParams(location.search).has('mobile-nav-debug')) return () => {}
    const errors: string[] = []
    const onError = (event: ErrorEvent) => errors.push(`ERR ${event.message.slice(0, 120)}`)
    const onRejection = (event: PromiseRejectionEvent) => errors.push(`REJ ${String(event.reason).slice(0, 120)}`)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)

    const badge = document.createElement('div')
    badge.style.cssText = [
      'position:fixed', 'top:40px', 'right:6px', 'z-index:2147483000',
      'background:rgba(0,0,0,.82)', 'color:#fff', 'font:11px/1.5 ui-monospace,monospace',
      'padding:8px 10px', 'border-radius:8px', 'max-width:94vw', 'max-height:70vh',
      'overflow:auto', 'white-space:pre-wrap', 'pointer-events:none',
    ].join(';')

    const read = (): string => {
      const q = (sel: string) => !!document.querySelector(sel)
      const vis = (sel: string) => {
        const el = document.querySelector<HTMLElement>(sel)
        return el === null ? 'absent' : getComputedStyle(el).visibility
      }
      const frame = document.querySelector<HTMLElement>('[data-mobile-nav="frame"]')
      return [
        `URL ${location.pathname}${location.search}`,
        `W ${innerWidth} x ${innerHeight} dpr ${devicePixelRatio}`,
        `mq≤1023 ${matchMedia('(max-width: 1023px)').matches}  mq≥1024 ${matchMedia('(min-width: 1024px)').matches}`,
        `css ${q('style[data-plugin-css*="mobile"]')}  frame ${!!frame}`,
        `previewCol ${vis('[data-aionui-preview-col]')}  explorerCol ${vis('[data-aionui-explorer-col]')}`,
        `previewOpen ${frame?.hasAttribute('data-aionui-preview-open') ?? '?'}  explorerOpen ${frame?.hasAttribute('data-aionui-explorer-open') ?? '?'}  previewFull ${frame?.hasAttribute('data-mobile-preview-full') ?? '?'}`,
        `header ${vis('[data-phase] header')} h${Math.round(document.querySelector('[data-phase] header')?.getBoundingClientRect().height ?? 0)}  composer ${q('textarea')}`,
        `sat ${getComputedStyle(document.documentElement).getPropertyValue('--mnav-sat').trim() || '?'}`,
        `genui cards ${document.querySelectorAll('[data-genui]').length}  panel ${q('[data-genui-panel]')}`,
        `phase ${document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? '?'}`,
        `errs ${errors.slice(-5).join(' | ') || 'none'}`,
      ].join('\n')
    }
    const paint = (): void => { badge.textContent = read() }
    paint()
    const observer = new MutationObserver(paint)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    const timer = setInterval(paint, 1500)
    document.body.appendChild(badge)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      observer.disconnect()
      clearInterval(timer)
      badge.remove()
    }
  }, 'dsh-mobile-nav: debug badge')
}
