/* dsh-mobile-pwa · touch gestures
 * Touch-first gestures for the DSH Web UI on phones:
 *   - Pinch to resize code / markdown font size
 *
 * Edge-swipe back (history.back) used to live here too; removed (design
 * doc "手势" row, 2026-08-17 fourth revision): history.back() is a no-op
 * against this SPA's own client-side routing, and the 24px left-edge hot
 * zone div (z-index 2147483001, touch-action:none) silently ate every touch
 * that started there — including dsh-mobile-nav's own new left-edge
 * swipe-back gesture (effects/gestures.ts in the dsh-web-mobile plugin),
 * which now owns that same 24px strip and actually does something useful
 * with it (close the open sheet/panel, or return to the session list).
 *
 * Pull-to-refresh used to live here too; it was removed (real-device
 * feedback: any accidental overscroll fired a full page reload, which S1's
 * page-stack rules always land on the conversation *list*, not back on the
 * chat the user was in — trigger-happy and disorienting mid-conversation).
 * app.css still disables the browser's own native overscroll/rubber-band at
 * the document edge on its own merits, independent of this file.
 *
 * Loaded on every device that isn't explicitly marked "desktop" via the
 * injected PWA script. Keeps out of the way on desktop.
 */
(function () {
  'use strict'
  if (window.matchMedia('(pointer: coarse)').matches === false) return

  // ---- Pinch to resize font -------------------------------------------
  const FONT_KEY = 'dsh-pwa-fontscale'
  const SPACES = [10, 11, 12, 13, 14, 15, 16, 17, 18]
  const root = document.documentElement
  let baseScale = parseFloat(localStorage.getItem(FONT_KEY)) || 1
  applyFont(baseScale)

  let pinchStartDist = null
  let pinchStartScale = baseScale
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinchStartDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      )
      pinchStartScale = baseScale
    }
  }, { passive: true })

  document.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || pinchStartDist == null) return
    e.preventDefault()
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    )
    const ratio = d / pinchStartDist
    const candidates = SPACES.map((s) => s * 0.1 * ratio)
    const next = Math.min(1.8, Math.max(0.9, pinchStartScale * ratio))
    // Snap to nearest discrete step to avoid jitter.
    const snapped = snapTo(next)
    if (snapped !== baseScale) {
      baseScale = snapped
      applyFont(baseScale)
      localStorage.setItem(FONT_KEY, String(baseScale))
    }
  }, { passive: false })

  function snapTo(v) {
    const sorted = [...SPACES].sort((a, b) => Math.abs(a - v * 10) - Math.abs(b - v * 10))
    return sorted[0] / 10
  }

  document.addEventListener('touchend', () => { pinchStartDist = null }, { passive: true })

  function applyFont(scale) {
    root.style.setProperty('--dsh-pwa-font-scale', String(scale))
  }

  // Add a small floating reset button when scale != 1.
  if (baseScale !== 1) {
    const reset = document.createElement('button')
    reset.textContent = '字AA'
    reset.style.cssText =
      'position:fixed;right:max(10px,env(safe-area-inset-right));' +
      'bottom:max(110px,calc(env(safe-area-inset-bottom) + 110px));z-index:2147483002;' +
      'background:rgba(76,141,255,.92);color:#fff;border:0;border-radius:999px;' +
      'padding:8px 12px;font:600 12px/1 system-ui;box-shadow:0 6px 20px rgba(0,0,0,.4)'
    reset.addEventListener('click', () => {
      baseScale = 1
      applyFont(1)
      localStorage.setItem(FONT_KEY, '1')
      reset.remove()
    })
    document.body.appendChild(reset)
  }
})()
