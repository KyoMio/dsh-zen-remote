// dsh-zen-remote · T57 the shared device name on the role card
//
// The 设备名称 input is the row's serverName field relocated: it renders in
// the ROLE card on BOTH roles (host = the server display name, client = the
// name a pairing registers with), the share card and the pairing area lost
// their name boxes, and the claim's name follows the field's displayed value
// (claimDeviceNameOf — behavior pinned in scripts/check-settings-form.mjs).
// The page is .tsx and Node's type stripping rejects JSX, so like
// client-desktop-gate.test.cjs these constraints are pinned textually against
// the component source until a JSX-capable harness exists.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
// The assertions match CODE text, so JSX block comments ({/* ... */}) are
// stripped first — a commented-out control must read as gone.
const source = readFileSync(join(ROOT, 'src', 'client', 'settings', 'SettingsSection.tsx'), 'utf8')
  .replace(/\{\/\*[\s\S]*?\*\//g, '')

test('T57: the device name renders once, in the ROLE card, before the host-only groups', () => {
  // Exactly one rendering of the field…
  const renders = (source.match(/text\(\s*form\.serverName/g) ?? []).length
  assert.equal(renders, 1, `the name field renders exactly once (found ${renders})`)
  // …inside the role card: after the role select, before the host-only
  // gateway group — i.e. on BOTH roles' pages.
  const roleTitleAt = source.indexOf("t('settings.roleTitle')")
  const renderAt = source.search(/text\(\s*form\.serverName/)
  const gatewayAt = source.indexOf("t('settings.gatewayTitle')")
  for (const [label, at] of [['roleTitle', roleTitleAt], ['the field', renderAt], ['gatewayTitle', gatewayAt]]) {
    assert.notEqual(at, -1, `${label} present`)
  }
  assert.ok(renderAt > roleTitleAt, 'the field sits after the role select (inside the role card)')
  assert.ok(renderAt < gatewayAt, 'the field sits BEFORE the host-only groups — a client page renders it too')
  // The hint is the one role fact that differs: the client hint key is chosen
  // per role at render time.
  assert.ok(source.includes("'settings.fieldServerNameHintClient'"), 'the client-specific hint exists')
  assert.ok(source.includes("clientRole ? 'settings.fieldServerNameHintClient' : 'settings.fieldServerNameHint'"), 'the hint switches with the role')
})

test('T57: the share card no longer renders the server name', () => {
  const shareAt = source.indexOf("t('settings.shareTitle')")
  assert.notEqual(shareAt, -1, 'the share card still exists')
  // The field's only rendering sits before the share card (previous test);
  // assert the inverse ordering too, so a second rendering inside the share
  // branch can never slip through with the count accidentally right.
  const renderAt = source.search(/text\(\s*form\.serverName/)
  const idleAt = source.indexOf('text(form.idleHours')
  assert.ok(shareAt > renderAt, 'the share card title comes after the role-card field')
  assert.ok(idleAt > shareAt, 'idleHours still renders in the share card')
  const shareBranch = source.slice(shareAt, source.indexOf('</SettingsForm>', shareAt))
  assert.ok(!shareBranch.includes('form.serverName'), 'no serverName control inside the share card')
})

test('T57: the pairing area has no separate name box — the claim uses the shared field', () => {
  assert.ok(!source.includes('zr-settings-client-name'), 'the client-name input id is gone')
  assert.ok(!source.includes('pairName'), 'the pairName state is gone')
  // The claim body names the device from the shared field, via the pure
  // selector, falling back to the default copy.
  const claimAt = source.indexOf('name: claimDeviceNameOf(')
  assert.notEqual(claimAt, -1, 'runClaim reads the shared field through claimDeviceNameOf')
  const claimLine = source.slice(claimAt, source.indexOf(')', claimAt) + 1)
  assert.ok(claimLine.includes('form.serverName.text'), 'the claim name follows the displayed field value')
  assert.ok(claimLine.includes("'settings.client.deviceNameDefault'"), 'the empty-field fallback is the default copy')
})

test('T57: the locales keep only keys someone uses', () => {
  const locales = readFileSync(join(ROOT, 'src', 'client', 'locales.ts'), 'utf8')
  // The pairing box's own label key died with the box…
  assert.ok(!locales.includes("'settings.client.deviceName'"), 'the unused client.deviceName key is gone')
  // …while both role hints and the fallback default remain, in BOTH languages
  // (each key appears twice: zh + en).
  for (const key of ['settings.fieldServerNameHintClient', 'settings.fieldServerNameHint', 'settings.client.deviceNameDefault']) {
    const count = locales.split(`'${key}'`).length - 1
    assert.equal(count, 2, `${key} exists for zh and en (found ${count})`)
  }
  // The role card label changed meaning with the move: it is the device name
  // now, in both languages.
  const zh = locales.indexOf("'settings.fieldServerName': '设备名称'")
  assert.notEqual(zh, -1, 'zh label is 设备名称')
  const en = locales.indexOf("'settings.fieldServerName': 'Device name'")
  assert.notEqual(en, -1, 'en label is Device name')
})
