import assert from 'node:assert/strict'
import test from 'node:test'
import { BASE_CSS } from '../src/client/styles/base.css.ts'
import { COMPAT_CSS } from '../src/client/styles/compat.css.ts'
import { CONTENT_CSS } from '../src/client/styles/content.css.ts'
import { INFO_CSS } from '../src/client/styles/info.css.ts'
import { LAYOUT_CSS } from '../src/client/styles/layout.css.ts'
import { MISC_CSS } from '../src/client/styles/misc.css.ts'
import { en, zh } from '../src/client/locales.ts'

const ruleBody = (css, selector, label) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  assert.ok(match, `${label}: rule \`${selector}\` is gone`)
  return match[1]
}

test('tablet safe-area: >=1024px standalone rule and ungated :root variables', () => {
  const rule = /@media\s*\(min-width:\s*1024px\)\s*and\s*\(display-mode:\s*standalone\)\s*\{\s*:has\(\s*>\s*\[data-shell-overlay\]\)\s*\{([^}]*)\}\s*\}/.exec(MISC_CSS)
  assert.ok(rule, 'the >=1024px standalone safe-area rule is missing from MISC_CSS')
  const body = rule[1]
  assert.match(body, /box-sizing:\s*border-box\s*!important/)
  assert.match(body, /padding-top:\s*var\(--mnav-sat\)\s*!important/)
  assert.match(body, /padding-bottom:\s*var\(--mnav-sab\)\s*!important/)
  assert.ok(/min-width:\s*1024px/.test(rule[0]) && /display-mode:\s*standalone/.test(rule[0]))

  const rootVars = /:root\s*\{[^}]*--mnav-sat:\s*env\(safe-area-inset-top,\s*0px\)[^}]*--mnav-sab:\s*env\(safe-area-inset-bottom,\s*0px\)[^}]*\}/.exec(BASE_CSS)
  assert.ok(rootVars, '--mnav-sat/--mnav-sab must stay defined on :root in BASE_CSS')
  assert.ok(!/@media[^{]*\{[^@]*:root\s*\{[^}]*--mnav-sat/.test(BASE_CSS))
})

test('info-sheet stacking promotion and UI-1 turn-tail clock + info-card stat keys', () => {
  const HOST_COMPOSER_SEAT = 7
  const HOST_SCROLL_TO_BOTTOM = 8

  const promotion = /\[data-phase\]\s*header:has\(\[data-mobile-nav="info-layer"\]\)\s*\{([^}]*)\}/.exec(INFO_CSS)
  assert.ok(promotion, 'header-promotion rule missing in INFO_CSS')
  const z = Number(/z-index:\s*(\d+)/.exec(promotion[1])?.[1])
  assert.ok(Number.isFinite(z) && z > HOST_SCROLL_TO_BOTTOM && z > HOST_COMPOSER_SEAT)
  assert.ok(!/header:has\(>\s*\[data-mobile-nav="info-layer"\]\)/.test(INFO_CSS))

  const phone = /@media \(max-width: 767px\) \{/.exec(INFO_CSS)
  assert.ok(phone && promotion.index > phone.index)

  const tailTime = ruleBody(CONTENT_CSS, '[data-chat-flow-kind="turn-tail"] [class$="_actions"] [class$="_timeEnd"]', 'CONTENT_CSS')
  assert.ok(/white-space:\s*nowrap\s*!important/.test(tailTime))
  assert.ok(!/flex-basis:\s*100%/.test(tailTime))
  assert.ok(!/white-space:\s*normal/.test(tailTime))
  assert.ok(/flex:\s*none\s*!important/.test(tailTime))

  const rowTime = ruleBody(LAYOUT_CSS, '[data-phase] [class$="_actions"] [class$="_timeEnd"]', 'LAYOUT_CSS')
  assert.ok(/flex:\s*none\s*!important/.test(rowTime))
  assert.ok(!/min-width:\s*0/.test(rowTime) && !/flex:\s*0 1 auto/.test(rowTime))

  const endInfo = ruleBody(CONTENT_CSS, '[data-chat-flow-kind="turn-tail"] [class$="_actions"] [class$="_endInfo"]', 'CONTENT_CSS')
  assert.ok(/flex:\s*none/.test(endInfo))
  const tailRows = [...CONTENT_CSS.matchAll(/\n\s*\[data-chat-flow-kind="turn-tail"\] \[class\$="_actions"\]\s*\{([^}]*)\}/g)]
  const tailRow = tailRows.map((m) => m[1]).find((body) => /flex-wrap/.test(body))
  assert.ok(tailRow)
  assert.ok(/height:\s*auto\s*!important/.test(tailRow) && /overflow:\s*visible\s*!important/.test(tailRow))

  const contentPhone = /@media \(max-width: 767px\) \{/.exec(CONTENT_CSS)
  assert.ok(contentPhone && CONTENT_CSS.indexOf('[data-chat-flow-kind="turn-tail"]') > contentPhone.index)

  for (const [name, dict] of [['zh', zh], ['en', en]]) {
    for (const key of ['infoStatTurnsSteps', 'infoStatSpeed']) {
      assert.ok(typeof dict[key] === 'string' && dict[key].length > 0, `locales ${name} missing ${key}`)
    }
  }
})

test('dsh-market compat CSS: gated by exact package name, phone-only, close button survives', () => {
  const MARKET = '.dshm-ver[title="@ace-zone/dsh-market"]'
  const sliced = COMPAT_CSS.slice(COMPAT_CSS.indexOf('@ace-zone/dsh-market: modal header'))
  assert.ok(sliced.length > 0)
  const nextDivider = sliced.indexOf('/* ---------- ')
  const section = nextDivider === -1 ? sliced : sliced.slice(0, nextDivider)

  const media = section.match(/@media \(max-width: 767px\) \{([\s\S]*)\n  \}/)
  assert.ok(media)
  const selectors = media[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith(',') || line.endsWith('{'))
    .filter((line) => !line.startsWith('/*') && !line.startsWith('*'))
  assert.ok(selectors.length >= 5)
  for (const selector of selectors) {
    assert.ok(selector.startsWith(`body:has(${MARKET})`), `ungated dsh-market selector: ${selector}`)
  }

  const hidden = section.match(/([\s\S]*?)\{\n      display: none !important/)
  assert.ok(hidden)
  assert.doesNotMatch(hidden[1], /dshm-close/)
  assert.doesNotMatch(hidden[1], /dshm-title/)
  assert.match(hidden[1], /> a\.dshm-viewbtn/)
  assert.match(section, /\.dshm-head > \.dshm-close \{[\s\S]*?flex: 0 0 auto !important/)
  assert.match(section, /\.dshm-head > \.dshm-title \{[\s\S]*?min-width: 0 !important/)
})

test('dsh-vision-router compat CSS: single eye icon, 28px round, phone-only, attribute-gated', () => {
  const sliced = COMPAT_CSS.slice(COMPAT_CSS.indexOf('dsh-vision-router: composer vision toggle'))
  assert.ok(sliced.length > 0)
  const nextDivider = sliced.indexOf('/* ---------- ', 10)
  const section = nextDivider === -1 ? sliced : sliced.slice(0, nextDivider)

  assert.match(section, /\[data-vision-router-mode-toggle\] > span \{\s*display: none !important;/)
  assert.match(section, /\[data-vision-router-mode-toggle\] > svg ~ svg \{\s*display: none !important;/)
  assert.match(section, /\[data-vision-router-mode-toggle\]:has\(svg\)::before \{\s*content: none !important;/)
  assert.match(section, /\[data-vision-router-mode-toggle\]::before \{\s*content: '';/)
  assert.match(section, /width: 28px !important;/)
  assert.match(section, /border-radius: 999px !important;/)
  assert.match(section, /@media \(max-width: 767px\) \{/)

  const selectors = section.match(/^\s{4}\[data-slot=.*$/gm) || []
  assert.ok(selectors.length > 0)
  for (const line of selectors) {
    assert.match(line, /\[data-vision-router-mode-toggle\]/, `ungated selector: ${line.trim()}`)
  }
})
