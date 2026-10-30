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
import { CONTENT_CSS } from '../src/client/styles/content.css.ts'
import { LAYOUT_CSS } from '../src/client/styles/layout.css.ts'
import { en, zh } from '../src/client/locales.ts'

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

// ---- UI-1 (2026-10-30): turn-tail clock + info-card stat cells -------------
// Lives here rather than in its own script because package.json's test line
// is an explicit list, and the info-card half of UI-1 is this sheet's own
// content. Both halves regress silently (CSS still parses, the card still
// opens), so they get the same loud-failure treatment as the stacking rule.

/** Body of the single rule whose selector line matches `selector` exactly. */
const ruleBody = (css, selector, label) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  assert.ok(match, `${label}: rule \`${selector}\` is gone`)
  return match[1]
}

// DSH 0.2.x wraps the usage button and the 24h clock in one non-wrapping
// inline-flex _endInfo. The 0.1.x-era rule (flex-basis: 100% + white-space:
// normal on the clock) squeezed "18:06" onto two lines inside it.
const tailTime = ruleBody(
  CONTENT_CSS,
  '[data-chat-flow-kind="turn-tail"] [class$="_actions"] [class$="_timeEnd"]',
  'content.css.ts',
)
assert.ok(
  /white-space:\s*nowrap\s*!important/.test(tailTime),
  'turn-tail _timeEnd must declare white-space: nowrap !important — the clock may never break mid-"18:06"',
)
assert.ok(
  !/flex-basis:\s*100%/.test(tailTime),
  'turn-tail _timeEnd still carries flex-basis: 100% — the 0.1.x "own line" clamp that squeezes the clock inside _endInfo',
)
assert.ok(
  !/white-space:\s*normal/.test(tailTime),
  'turn-tail _timeEnd still carries white-space: normal — this is what let the clock wrap',
)
assert.ok(
  /flex:\s*none\s*!important/.test(tailTime),
  'turn-tail _timeEnd must be flex: none — a shrinkable clock is the squeeze itself',
)

// The other half of the root cause: layout.css.ts used to make the clock a
// shrinkable flex item (flex: 0 1 auto + min-width: 0) for every message row.
const rowTime = ruleBody(LAYOUT_CSS, '[data-phase] [class$="_actions"] [class$="_timeEnd"]', 'layout.css.ts')
assert.ok(/flex:\s*none\s*!important/.test(rowTime), 'layout.css.ts _timeEnd must be flex: none !important')
assert.ok(
  !/min-width:\s*0/.test(rowTime) && !/flex:\s*0 1 auto/.test(rowTime),
  'layout.css.ts _timeEnd is shrinkable again (min-width: 0 / flex: 0 1 auto) — the clock will be squeezed inside _endInfo',
)

// _endInfo wraps as a unit, and the row may grow instead of clipping.
const endInfo = ruleBody(
  CONTENT_CSS,
  '[data-chat-flow-kind="turn-tail"] [class$="_actions"] [class$="_endInfo"]',
  'content.css.ts',
)
assert.ok(/flex:\s*none/.test(endInfo), 'turn-tail _endInfo must be flex: none so the usage + clock group wraps whole')
const tailRows = [...CONTENT_CSS.matchAll(/\n\s*\[data-chat-flow-kind="turn-tail"\] \[class\$="_actions"\]\s*\{([^}]*)\}/g)]
const tailRow = tailRows.map((m) => m[1]).find((body) => /flex-wrap/.test(body))
assert.ok(tailRow, 'content.css.ts lost the wrapping turn-tail _actions rule')
assert.ok(
  /height:\s*auto\s*!important/.test(tailRow) && /overflow:\s*visible\s*!important/.test(tailRow),
  'turn-tail _actions must release the host fixed height (height: auto) and layout.css.ts overflow: hidden (overflow: visible), or a wrapped second line is cut off',
)

// Desktop no-op: every turn-tail rule above has to sit inside the phone block.
const contentPhone = /@media \(max-width: 767px\) \{/.exec(CONTENT_CSS)
assert.ok(contentPhone, 'content.css.ts lost its phone media query')
assert.ok(
  CONTENT_CSS.indexOf('[data-chat-flow-kind="turn-tail"]') > contentPhone.index,
  'a turn-tail rule escaped the (max-width: 767px) block — it would change the desktop layout',
)

// Info-card stat cells: turns + steps merged into one cell, output speed in
// the freed slot. Both dictionaries must carry the keys or t() prints the key.
for (const [name, dict] of [['zh', zh], ['en', en]]) {
  for (const key of ['infoStatTurnsSteps', 'infoStatSpeed']) {
    assert.ok(
      typeof dict[key] === 'string' && dict[key].length > 0,
      `locales.ts ${name} is missing '${key}' — the info card would render the raw key as a label`,
    )
  }
}

console.log('check-info-sheet-stacking: ok')
