// dsh-zen-remote · MS-7 the component detail page's multi-server card
//
// The settings page's client group becomes multi-server: the connect card
// carries a paired-count badge and the 8-cap red alert, the pool list renders
// one row per paired server with per-row reconnect / re-pair / remove (plus
// remove-all), the claim writes NOTHING into the row anymore (the backend
// lands the pairing straight into zen-remote-state.json since MS-5), and the
// reverse device-name write-back (T59) is gone — the local name only flows
// OUT to the servers. The page is .tsx and Node's type stripping rejects
// JSX, so like settings-device-name.test.cjs these constraints are pinned
// textually against the component source until a JSX-capable harness exists.
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
const css = readFileSync(join(ROOT, 'src', 'client', 'settings', 'settings-css.ts'), 'utf8')
const locales = readFileSync(join(ROOT, 'src', 'client', 'locales.ts'), 'utf8')

// ---- the reverse device-name write-back is gone (MS-7 change 1) ------------

test('MS-7: the reverse device-name write-back is gone from the settings page', () => {
  assert.ok(!source.includes('shouldFollowServerDeviceName'), 'the follow helper is no longer imported or called')
  assert.ok(!source.includes('followServerDeviceName'), 'the follow callback is gone')
  assert.ok(!source.includes('config.writeDeviceName'), 'no write lands a server-side name back into the row')
})

// ---- the claim lands in the backend only (MS-7 change 2) --------------------

test('MS-7: runClaim no longer writes the row — the backend persists the pairing', () => {
  assert.ok(!source.includes('config.writeClientPairing'), 'the row write is gone (token never reaches the browser)')
  assert.ok(!source.includes('claimWriteFailed'), 'the write-failed state is gone with the write')
  assert.ok(!locales.includes("'settings.client.failWrite'"), 'the dead failWrite key left both dictionaries')
  // The success path: clear the pairing code and refresh the status.
  const claimAt = source.indexOf('const runClaim = async')
  assert.notEqual(claimAt, -1, 'runClaim exists')
  const okAt = source.indexOf('body.ok === true', claimAt)
  const claimEnd = source.indexOf('const runUnpair', claimAt)
  const successBlock = source.slice(okAt, claimEnd)
  assert.ok(successBlock.includes("setPairCode('')"), 'a landed claim clears the pairing code')
  assert.ok(successBlock.includes('loadClientStatus()'), 'a landed claim refreshes the client status')
  // The FIRST-activation reload decision survives (UX-1).
  const reloadAt = source.indexOf('shouldReloadAfterClientActivation({', claimAt)
  assert.notEqual(reloadAt, -1, 'the first-activation reload decision still gates the claim')
  assert.ok(source.slice(claimAt, reloadAt).includes('streamInterceptAlreadyActive'), 'the interceptor snapshot still feeds the decision')
})

test('MS-7: the pair button gates through canSubmitClientPairing — full pool still re-pairs a known address', () => {
  assert.ok(source.includes('canSubmitClientPairing({'), 'the gate runs the MS-6 pure truth table')
  assert.ok(source.includes('deviceNameInvalid: form.serverName.invalid'), 'the device-name draft validity rides the same gate (T60)')
  assert.ok(source.includes('limit-reached'), 'the route limit-reached failure is classified for display')
})

// ---- the card head: count badge, cap note, red limit alert -------------------

test('MS-7: the card head carries the paired-count badge and the cap note', () => {
  assert.ok(source.includes("t('settings.client.poolCount'"), 'the badge renders the paired count')
  assert.ok(source.includes("t('settings.client.poolCapNote'"), 'the note names the 8-server cap')
})

test('MS-7: the limit alert renders red and bold when the pool is full', () => {
  const alertAt = source.indexOf('zr-settings-limit-alert')
  assert.notEqual(alertAt, -1, 'the alert line exists')
  // The alert rides the limitReached flag.
  assert.ok(source.includes('limitReached === true'), 'the alert is gated on the derived limitReached flag')
  // The rule in the stylesheet: visible red, bold — the hard requirement.
  const ruleAt = css.indexOf('.zr-settings-limit-alert')
  assert.notEqual(ruleAt, -1, 'the stylesheet styles the alert')
  const rule = css.slice(ruleAt, css.indexOf('}', ruleAt))
  assert.ok(rule.includes('font-weight: 700'), 'the alert copy is bold')
  assert.ok(rule.includes('--dsw-alias-state-error-primary'), 'the alert copy is red (the error alias)')
  // The badge for a bad server state reads red too.
  const badgeAt = css.indexOf('.zr-settings-badge[data-invalid="true"]')
  assert.notEqual(badgeAt, -1, 'bad-state badges have a red rule')
})

// ---- the paired-server list (MS-7 change 3) ---------------------------------

test('MS-7: the paired-server list renders empty state and per-server rows', () => {
  assert.ok(source.includes("t('settings.client.serversTitle'"), 'the list section exists')
  assert.ok(source.includes("t('settings.client.serversEmpty'"), 'the empty state exists')
  assert.ok(source.includes('className="zr-settings-device" key={server.entryId}'), 'the rows reuse the device-row chrome, keyed by entry')
  assert.ok(source.includes('clientView?.servers ?? []'), 'the rows come from the pool list')
  assert.ok(source.includes('server.displayName'), 'each row names the server by its deduplicated display name')
  assert.ok(source.includes('server.serverUrl'), 'each row shows the server address')
})

test('MS-7: each row offers reconnect / re-pair / remove; remove-all sits below the list', () => {
  /** One `const <name> = async` function's body, up to the next `const `. */
  const fnBody = (name) => {
    const at = source.indexOf(`const ${name} = async`)
    assert.notEqual(at, -1, `${name} exists`)
    return source.slice(at, source.indexOf('\n  const ', at + 1))
  }
  // Reconnect targets ONE entry and is offered only when a retry is armed.
  const reconnect = fnBody('runEntryReconnect')
  assert.ok(reconnect.includes('CLIENT_RECONNECT_ROUTE'), 'the row reconnect hits the reconnect route')
  assert.ok(reconnect.includes('JSON.stringify({ entryId })'), 'the row reconnect posts the entry id')
  assert.ok(source.includes('runEntryReconnect(server.entryId)'), 'each row reconnects its own entry')
  assert.ok(source.includes('server.nextRetryAt === undefined'), 'the row reconnect is disabled without a pending retry')
  // Re-pair: fills the address box, clears the code, focuses the code input.
  const repairAt = source.indexOf('const repurposeServer')
  assert.notEqual(repairAt, -1, 'the re-pair action exists')
  const repairBlock = source.slice(repairAt, repairAt + 600)
  assert.ok(repairBlock.includes('setPairUrl(server.serverUrl)'), 're-pair fills the address box')
  assert.ok(repairBlock.includes("setPairCode('')"), 're-pair clears the code')
  assert.ok(repairBlock.includes('.focus()'), 're-pair focuses the code input')
  // Remove: confirm, then unpair that entry.
  const remove = fnBody('runUnpairEntry')
  assert.ok(remove.includes("window.confirm(t('settings.client.unpairServerConfirm'))"), 'remove confirms first')
  assert.ok(remove.includes('CLIENT_UNPAIR_ROUTE'), 'remove hits the unpair route')
  assert.ok(remove.includes('JSON.stringify({ entryId })'), 'remove posts the entry id')
  assert.ok(remove.includes('loadClientStatus()'), 'remove refreshes the status')
  assert.ok(source.includes('runUnpairEntry(server.entryId)'), 'each row removes its own entry')
  // Remove all: confirm, then unpair every entry.
  const removeAll = fnBody('runUnpairAllServers')
  assert.ok(removeAll.includes("window.confirm(t('settings.client.unpairAllServersConfirm'))"), 'remove-all confirms first')
  assert.ok(removeAll.includes('JSON.stringify({ all: true })'), 'remove-all posts the all flag')
  assert.ok(source.includes("t('settings.client.unpairAllServers')"), 'the remove-all button exists')
  assert.ok(source.includes('serverRows.length > 0 && ('), 'remove-all renders only under a non-empty list')
})

// ---- the diagnostics area adapts to the pool (MS-7 change 4) -----------------

test('MS-7: diagnostics keep the global rows and add a per-server group', () => {
  assert.ok(source.includes("t('settings.client.diagInterceptInstalled')"), 'the global interceptor line stays')
  assert.ok(source.includes("t('settings.client.diagRemoteDrop'"), 'the attachment-entry guard line stays')
  assert.ok(source.includes("t('settings.client.diagUploadRedirect'"), 'the upload-redirect line stays')
  assert.ok(source.includes("t('settings.client.serverDiagTitle'"), 'the per-server diagnostics group exists')
  // The per-server loop feeds each server's own lastError through the shared copy.
  const diagAt = source.indexOf("t('settings.client.serverDiagTitle'")
  const serverDiagBlock = source.slice(diagAt, source.length)
  assert.ok(serverDiagBlock.includes('server.lastError'), 'each server shows its own last error')
  assert.ok(serverDiagBlock.includes('server.compat'), 'each server shows its fingerprint-difference groups')
  assert.ok(serverDiagBlock.includes('server.pluginBridge'), 'each server shows its bridge verdicts')
  // A legacy body without servers[] keeps rendering the top-level mirrors.
  assert.ok(source.includes('legacyTopDiag'), 'the pre-pool fallback keeps the top-level diagnostics')
})

// ---- the dictionaries stay key-symmetric --------------------------------------

test('MS-7: the new keys exist in BOTH dictionaries, the dead key in neither', () => {
  const newKeys = [
    'settings.client.poolCount',
    'settings.client.poolCapNote',
    'settings.client.limitReached',
    'settings.client.failLimitReached',
    'settings.client.serversTitle',
    'settings.client.serversEmpty',
    'settings.client.repair',
    'settings.client.serverRemove',
    'settings.client.unpairServerConfirm',
    'settings.client.unpairAllServers',
    'settings.client.unpairAllServersConfirm',
    'settings.client.serverStateConnected',
    'settings.client.serverStateRetry',
    'settings.client.serverStateRetrySoon',
    'settings.client.serverStateOffline',
    'settings.client.serverStateRevoked',
    'settings.client.serverStateIncompatible',
    'settings.client.serverStateInvalidUrl',
    'settings.client.serverStateUnpaired',
    'settings.client.serverDiagTitle',
  ]
  for (const key of newKeys) {
    const count = locales.split(`'${key}'`).length - 1
    assert.equal(count, 2, `${key} exists for zh and en (found ${count})`)
  }
})
