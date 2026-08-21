// Self-check for the composer keyboard-avoid lift (S10, issue #1 方案 2).
// The failing environment (小米 + 微信输入法) cannot be reproduced off-device,
// so the boundary cases of the pure geometry are asserted numerically.
// Run: node scripts/check-keyboard-avoid.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import { keyboardLift as lift } from '../src/client/effects/keyboard-avoid.ts'

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

console.log('KEYBOARD AVOID CHECK OK')
