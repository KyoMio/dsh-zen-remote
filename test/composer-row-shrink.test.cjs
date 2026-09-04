const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const composer = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'client', 'styles', 'composer.css.ts'),
  'utf8',
)

/*
 * The phone composer row is one nowrap flex line. Section 1 states the
 * contract out loud: the model pill is the ONLY shrinkable item, because it
 * is the only one whose label can ellipsize.
 *
 * The permission seat (_modes) broke that contract by also being `flex: 0 1
 * auto; min-width: 0`. Shrinking it does not make the permission chip
 * narrower — the chip's own wrapper inside it is `flex: 0 0 auto` and stays
 * 44px — it just slices the seat out from under the chip, and the leftover
 * chip lands on top of the model pill (measured 2026-09-04, DSH 0.1.2,
 * 390px: seat 29.7px, chip still 44px, 9px of overlap).
 *
 * Nothing throws when this regresses; two chips just touch. Hence the test.
 */
const section = composer.slice(composer.indexOf('--- 1. flatten the two official groups'))
assert.ok(section.length > 0, 'the composer row section must exist')

const modesRule = /\$\{ROW\} > \[class\$="_tools"\] > \[class\$="_modes"\] \{([\s\S]*?)\n  \}/.exec(section)
assert.ok(modesRule, 'the permission seat (_modes) rule must exist')
/* Declarations only: these rules carry long comments that quote the very
   values being asserted against ("…the companion of `flex: 0 1`"), so a raw
   slice matches its own prose. */
const decls = (block) => block.replace(/\/\*[\s\S]*?\*\//g, '')
const modes = decls(modesRule[1])

test('the permission seat does not shrink — its chip cannot follow it down', () => {
  assert.match(modes, /flex: 0 0 auto !important;/)
  assert.doesNotMatch(modes, /flex: 0 1/)
})

test('and carries no min-width:0, which only ever paired with that shrink', () => {
  assert.doesNotMatch(modes, /min-width: 0/)
})

const modelRule = /\$\{MODEL\} \{([\s\S]*?)\n  \}/.exec(section)
assert.ok(modelRule, 'the model seat rule must exist')

test('the model seat stays the one shrinkable item', () => {
  assert.match(decls(modelRule[1]), /flex: 0 1 /)
  assert.match(decls(modelRule[1]), /min-width: 0 !important;/)
})

test('the row is still one nowrap line', () => {
  assert.match(section, /flex-wrap: nowrap !important;/)
})
