// Self-check for the composer keyboard-avoid lift (S10, issue #1 方案 2).
// The failing environment (小米 + 微信输入法) cannot be reproduced off-device,
// so the boundary cases of the pure geometry are asserted numerically.
// Run: node scripts/check-keyboard-avoid.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { composerLift, estimatedLift, keyboardLift as lift, safetyPad } from '../src/client/effects/keyboard-avoid.ts'

// The reported class of bug: keyboard shrinks the visual viewport, browser
// does not pan it — the whole shrink is an occluded band at the bottom.
assert.equal(lift({ innerHeight: 800, vvHeight: 500, offsetTop: 0, scale: 1 }), 300)

// Browser panned the visual viewport fully down to the focused field
// (working Android auto-scroll, and iOS): nothing is occluded.
assert.equal(lift({ innerHeight: 800, vvHeight: 500, offsetTop: 300, scale: 1 }), 0)

// Partial pan leaves a partial band.
assert.equal(lift({ innerHeight: 800, vvHeight: 500, offsetTop: 120, scale: 1 }), 180)

// No keyboard at all.
assert.equal(lift({ innerHeight: 800, vvHeight: 800, offsetTop: 0, scale: 1 }), 0)

// iOS-style: innerHeight itself shrinks with the keyboard, so the
// subtraction is already balanced — must stay a strict no-op.
assert.equal(lift({ innerHeight: 500, vvHeight: 500, offsetTop: 0, scale: 1 }), 0)

// Pinch-zoom shrinks vvHeight without any keyboard: the scale guard wins.
assert.equal(lift({ innerHeight: 800, vvHeight: 400, offsetTop: 100, scale: 2 }), 0)

// Sub-threshold rounding noise (URL-bar animation) never jitters the bar.
assert.equal(lift({ innerHeight: 800, vvHeight: 799, offsetTop: 0, scale: 1 }), 0)

// Fractional CSS pixels round to an integer lift.
assert.equal(lift({ innerHeight: 800, vvHeight: 507.5, offsetTop: 0, scale: 1 }), 293)

// Over-pan (elastic edge) must not produce a negative lift.
assert.equal(lift({ innerHeight: 800, vvHeight: 500, offsetTop: 320, scale: 1 }), 0)

// Dumb-keyboard estimate (issue #1 确诊设备): the reporter's WeType measured
// ~315 CSS px on an 858px viewport — the estimate must clear it, and never
// exceed its 400px cap on tall viewports.
assert.equal(estimatedLift(858), 360)
assert.ok(estimatedLift(858) > 315, 'estimate clears the one measured WeType height')
assert.equal(estimatedLift(2000), 400)
assert.equal(estimatedLift(600), 252)

// Cached verdict (first-focus-only delay): the effect must persist the dumb
// verdict, lift immediately for a convicted browser, and revoke the cache
// the moment a probe sees the viewport move.
const effectSrc = readFileSync(new URL('../src/client/effects/keyboard-avoid.ts', import.meta.url), 'utf8')
assert.match(effectSrc, /'dsh-mobile-nav\.kb-dumb'/, 'verdict cache key exists')
assert.match(effectSrc, /localStorage\.setItem\(DUMB_KEY, '1'\)/, 'verdict is persisted on conviction')
assert.match(effectSrc, /if \(localStorage\.getItem\(DUMB_KEY\) === '1'\) \{\s*estimate = estimatedLift/, 'convicted browser lifts immediately on focus')
assert.match(effectSrc, /if \(moved\(\)\) \{\s*[\s\S]{0,200}localStorage\.removeItem\(DUMB_KEY\)/, 'a moving viewport revokes the verdict')

// The safety pad is ANDROID-ONLY: the under-reporting is an Android IME
// behaviour, and iOS reports its one system keyboard exactly — padding there
// would be a visible gap bought for nothing.
const ANDROID = 'Mozilla/5.0 (Linux; Android 17) AppleWebKit/537.36 Chrome/135 Mobile'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile'
assert.equal(safetyPad(ANDROID), 15)
assert.equal(safetyPad(IPHONE), 0)
assert.equal(safetyPad('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 0)

// Three-source composition. The pad rides on a measured occlusion and stands
// alone when a keyboard is up with nothing occluded on paper, but never
// inflates the (already generous) dumb-keyboard estimate.
const A = safetyPad(ANDROID)
assert.equal(composerLift(300, 0, true, A), 315, 'measured occlusion gets the pad')
assert.equal(composerLift(0, 0, true, A), 15, 'under-reporting IME: pad alone')
assert.equal(composerLift(0, 360, false, A), 360, 'the estimate is never padded')
assert.equal(composerLift(0, 0, false, A), 0, 'no keyboard, no lift')
// A shrunk viewport must not add the pad twice via both paths.
assert.equal(composerLift(300, 360, true, A), 315, 'geometry outranks the estimate')

// Off Android the pad vanishes and every path is exactly the measurement.
const I = safetyPad(IPHONE)
assert.equal(composerLift(300, 0, true, I), 300, 'iOS: measured occlusion, unpadded')
assert.equal(composerLift(0, 0, true, I), 0, 'iOS: a handled keyboard lifts nothing')

// The lift rule must target the slot's _root CHILD: the slot wrapper itself
// is display:contents (no box), a transform there is a silent no-op — the
// exact on-device failure of 2026-08-21.
const composerCss = readFileSync(new URL('../src/client/styles/composer.css.ts', import.meta.url), 'utf8')
assert.match(
  composerCss,
  /html\[data-mnav-kb\] \[data-slot="conversation\.composer\.bar"\] > \[class\$="_root"\]\s*\{\s*transform/,
  'keyboard-avoid transform must hit the box-generating _root child',
)

console.log('KEYBOARD AVOID CHECK OK')
