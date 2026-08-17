// Self-check for the iOS sunk-viewport detection (S1.2). No desktop browser
// can enter that mode, so the boundary cases are asserted numerically instead.
// Run: node scripts/check-sunk-viewport.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import { isViewportSunkBelowStatusBar as sunk } from '../src/client/effects/phone-chrome.ts'

// The reported device: iPhone 393x852, standalone PWA, viewport already below
// the status bar (852 - 793 = 59) while env still claims the full 59.
assert.equal(sunk({ standalone: true, screenHeight: 852, innerHeight: 793, envTop: 59 }), true)

// Same phone in a Safari tab -> never touch anything.
assert.equal(sunk({ standalone: false, screenHeight: 852, innerHeight: 793, envTop: 59 }), false)

// Standalone with black-translucent actually in effect: content is full-height,
// so the inset is a real, un-paid-for offset and must stay.
assert.equal(sunk({ standalone: true, screenHeight: 852, innerHeight: 852, envTop: 59 }), false)

// Landscape iPhone: the notch moves to the sides, top inset is 0. The height
// difference is large and meaningless -> the envTop guard rejects it.
assert.equal(sunk({ standalone: true, screenHeight: 852, innerHeight: 350, envTop: 0 }), false)

// Android standalone: loses status-bar height off innerHeight but reports no
// top inset -> same guard, no change.
assert.equal(sunk({ standalone: true, screenHeight: 2400, innerHeight: 2316, envTop: 0 }), false)

// Notchless / desktop: nothing to compensate either way.
assert.equal(sunk({ standalone: true, screenHeight: 800, innerHeight: 800, envTop: 0 }), false)

// Partial sink (system ate less than the inset claims) is not this bug —
// zeroing there would under-pad.
assert.equal(sunk({ standalone: true, screenHeight: 852, innerHeight: 832, envTop: 59 }), false)

console.log('SUNK VIEWPORT CHECK OK')
