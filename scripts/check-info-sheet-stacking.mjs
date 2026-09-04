// Self-check for the session-info sheet's stacking promotion (fixed 2026-09-04).
//
// The sheet renders INSIDE `[data-phase] header`, which header.css.ts makes a
// stacking context (position: relative + z-index: 2). A child's z-index is
// scoped to that context, so the layer's own z:70 competes with the header's
// 2 — and the host composer seat (.wSkVaW_composerSeat, z:7, owned by
// dsh-client-ui-conversation) wins, painting the input row through the card.
// The fix promotes the header itself while the sheet is mounted.
//
// This regresses silently: nothing throws, the console stays clean, and the
// card still opens — it just has the composer sitting on top of it. Hence a
// check that fails loudly if the rule is dropped or its value drifts back
// under the host's seat.
// Run: node scripts/check-info-sheet-stacking.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import { INFO_CSS } from '../src/client/styles/info.css.ts'

/** Host z-index values this sheet has to out-rank (dsh-client-ui-conversation). */
const HOST_COMPOSER_SEAT = 7
const HOST_SCROLL_TO_BOTTOM = 8

const promotion = /\[data-phase\]\s*header:has\(\[data-mobile-nav="info-layer"\]\)\s*\{([^}]*)\}/.exec(INFO_CSS)
assert.ok(
  promotion,
  'the header-promotion rule is gone: the info sheet renders inside [data-phase] header, ' +
    'so without it the sheet is trapped at the header z-index (2) and the composer seat ' +
    '(host z:7) paints over the card. See the comment in styles/info.css.ts.',
)

const z = Number(/z-index:\s*(\d+)/.exec(promotion[1])?.[1])
assert.ok(Number.isFinite(z), 'header-promotion rule has no numeric z-index')
assert.ok(
  z > HOST_SCROLL_TO_BOTTOM && z > HOST_COMPOSER_SEAT,
  `header promotion is z-index:${z}, which does not out-rank the host composer seat ` +
    `(${HOST_COMPOSER_SEAT}) and scroll-to-bottom (${HOST_SCROLL_TO_BOTTOM})`,
)

// Depth-agnostic selector: the utilities slot wrapper is `display: contents`
// and the host owns the nesting, so a child combinator would silently stop
// matching on any host reshuffle (AGENTS.md).
assert.ok(
  !/header:has\(>\s*\[data-mobile-nav="info-layer"\]\)/.test(INFO_CSS),
  'header promotion must use a descendant :has(), not `:has(> …)` — the host owns the depth',
)

// Desktop must stay pixel-identical: the promotion has to sit inside the
// phone breakpoint, not at the top level of the sheet.
const phone = /@media \(max-width: 767px\) \{/.exec(INFO_CSS)
assert.ok(phone, 'info.css.ts lost its phone media query')
assert.ok(
  promotion.index > phone.index,
  'the header promotion escaped the (max-width: 767px) block — it would change the desktop layout',
)

console.log('check-info-sheet-stacking: ok')
