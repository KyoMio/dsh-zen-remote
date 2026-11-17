'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const stripJsxComments = (src) => src.replace(/\{\/\*[\s\S]*?\*\//g, '')
const source = stripJsxComments(readFileSync(join(ROOT, 'src', 'client', 'settings', 'SettingsSection.tsx'), 'utf8'))
const wizardSrc = stripJsxComments(readFileSync(join(ROOT, 'src', 'client', 'wizard', 'GatewayWizard.tsx'), 'utf8'))
const css = readFileSync(join(ROOT, 'src', 'client', 'settings', 'settings-css.ts'), 'utf8')
const locales = readFileSync(join(ROOT, 'src', 'client', 'locales.ts'), 'utf8')

function fnBody(name) {
  const at = source.indexOf(`const ${name} = async`)
  assert.notEqual(at, -1, `${name} exists`)
  const next = source.slice(at + 1).search(/\n\s+const /)
  return next === -1 ? source.slice(at) : source.slice(at, at + 1 + next)
}

test('T57: device name renders once in the ROLE card before host-only groups, not in share card', () => {
  const renders = (source.match(/text\(\s*form\.serverName/g) ?? []).length
  assert.equal(renders, 1, `the name field renders exactly once (found ${renders})`)

  const roleTitleAt = source.indexOf("t('settings.roleTitle')")
  const renderAt = source.search(/text\(\s*form\.serverName/)
  const gatewayAt = source.indexOf("t('settings.gatewayTitle')")
  const shareAt = source.indexOf("t('settings.shareTitle')")
  const idleAt = source.indexOf('text(form.idleHours')
  for (const [label, at] of [['roleTitle', roleTitleAt], ['the field', renderAt], ['gatewayTitle', gatewayAt], ['shareTitle', shareAt], ['idleHours', idleAt]]) {
    assert.notEqual(at, -1, `${label} present`)
  }
  assert.ok(renderAt > roleTitleAt && renderAt < gatewayAt)
  assert.ok(shareAt > renderAt && idleAt > shareAt)

  const shareBranch = source.slice(shareAt, source.indexOf('</SettingsForm>', shareAt))
  assert.ok(!shareBranch.includes('form.serverName'))
  assert.ok(source.includes("clientRole ? 'settings.fieldServerNameHintClient' : 'settings.fieldServerNameHint'"))
})

test('T57/T60/MS-7: pairing area has no separate name box, runClaim sends claimDeviceNameOf and does not write row', () => {
  assert.ok(!source.includes('zr-settings-client-name'))
  assert.ok(!source.includes('pairName'))
  assert.ok(!source.includes('shouldFollowServerDeviceName'))
  assert.ok(!source.includes('followServerDeviceName'))
  assert.ok(!source.includes('rowDeviceName'))
  assert.ok(!source.includes('writeDeviceName'))
  assert.ok(!source.includes('config.writeClientPairing('))
  assert.ok(!source.includes('claimWriteFailed'))
  assert.ok(!source.includes('body.token'))
  assert.ok(!locales.includes("'settings.client.deviceName'"))
  assert.ok(!locales.includes("'settings.client.failWrite'"))

  const claimAt = source.indexOf('const claimName = claimDeviceNameOf(')
  assert.notEqual(claimAt, -1)
  const claimLine = source.slice(claimAt, source.indexOf(')', claimAt) + 1)
  assert.ok(claimLine.includes('form.serverName.text'))
  assert.ok(claimLine.includes("'settings.client.deviceNameDefault'"))
  assert.notEqual(source.indexOf('name: claimName,', claimAt), -1)

  const runClaimAt = source.indexOf('const runClaim = async')
  assert.notEqual(runClaimAt, -1)
  const okAt = source.indexOf('body.ok === true', runClaimAt)
  const claimEnd = source.indexOf('const runUnpair', runClaimAt)
  const successBlock = source.slice(okAt, claimEnd)
  assert.ok(successBlock.includes("setPairCode('')"))
  assert.ok(successBlock.includes('loadClientStatus()'))
  const reloadAt = source.indexOf('shouldReloadAfterClientActivation({', runClaimAt)
  assert.notEqual(reloadAt, -1)
  assert.ok(source.slice(runClaimAt, reloadAt).includes('streamInterceptAlreadyActive'))

  const allowedAt = source.indexOf('canSubmitClientPairing({')
  assert.notEqual(allowedAt, -1)
  assert.ok(source.slice(allowedAt, source.indexOf('})', allowedAt)).includes('deviceNameInvalid: form.serverName.invalid'))
  assert.ok(source.includes('limit-reached'))

  const buttonAt = source.indexOf("t('settings.client.pair')}")
  const hintAt = source.indexOf("t('settings.client.fixDeviceName')")
  assert.ok(buttonAt !== -1 && hintAt !== -1 && hintAt > buttonAt)
  assert.ok(source.includes('form.serverName.invalid && <span'))
})

test('T59: backend volatile-update listener broadcasts committed serverName once', () => {
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  const watcherAt = index.indexOf("'dsh-zen-remote: relay credentials watcher'")
  assert.notEqual(watcherAt, -1)
  const effectSource = index.slice(index.indexOf("ctx.on('loader/volatile-update'"), watcherAt)
  assert.ok(effectSource.includes('volatileUpdateTouchesServerName(paths)'))
  assert.ok(effectSource.includes('queueDeviceNameAll'))
  assert.ok(effectSource.includes('unwrapVolatile(row.serverName)'))
  assert.equal(index.split('relayPool.queueDeviceNameAll(').length - 1, 1)
})

test('push switches use Switch and disable dependent switches when pushEnabled is off', () => {
  assert.ok(!source.includes('type="checkbox"'))
  assert.ok(source.includes("const pushOff = form.pushEnabled.text !== 'true'"))
  assert.ok(source.includes("checked={!parentDisabled && state.text === 'true'}"))
  for (const field of ['pushSessionName', 'pushSummary', 'pushTurnEnd', 'pushTool']) {
    assert.match(source, new RegExp(`bool\\(form\\.${field},\\s*'${field}',[^\\n]+,\\s*pushOff\\)`))
  }
})

test('MS-7: pool header, red limit alert, paired-server rows, per-row actions, and diagnostics', () => {
  assert.ok(source.includes("t('settings.client.poolCount'"))
  assert.ok(source.includes("t('settings.client.poolCapNote'"))
  assert.notEqual(source.indexOf('zr-settings-limit-alert'), -1)
  assert.ok(source.includes('limitReached === true'))

  const ruleAt = css.indexOf('.zr-settings-limit-alert')
  assert.notEqual(ruleAt, -1)
  const rule = css.slice(ruleAt, css.indexOf('}', ruleAt))
  assert.ok(rule.includes('font-weight: 700'))
  assert.ok(rule.includes('--dsw-alias-state-error-primary'))
  assert.notEqual(css.indexOf('.zr-settings-badge[data-invalid="true"]'), -1)

  assert.ok(source.includes("t('settings.client.serversTitle'"))
  assert.ok(source.includes("t('settings.client.serversEmpty'"))
  assert.ok(source.includes('className="zr-settings-device" key={server.entryId}'))
  assert.ok(source.includes('clientView?.servers ?? []'))
  assert.ok(source.includes('server.displayName'))
  assert.ok(source.includes('server.serverUrl'))

  const reconnect = fnBody('runEntryReconnect')
  assert.ok(reconnect.includes('CLIENT_RECONNECT_ROUTE'))
  assert.ok(reconnect.includes('JSON.stringify({ entryId })'))
  assert.ok(source.includes('runEntryReconnect(server.entryId)'))
  assert.ok(source.includes('server.nextRetryAt === undefined'))

  const repairAt = source.indexOf('const repurposeServer')
  assert.notEqual(repairAt, -1)
  const repairBlock = source.slice(repairAt, repairAt + 600)
  assert.ok(repairBlock.includes('setPairUrl(server.serverUrl)'))
  assert.ok(repairBlock.includes("setPairCode('')"))
  assert.ok(repairBlock.includes('.focus()'))

  const remove = fnBody('runUnpairEntry')
  assert.ok(remove.includes("window.confirm(t('settings.client.unpairServerConfirm'))"))
  assert.ok(remove.includes('CLIENT_UNPAIR_ROUTE'))
  assert.ok(remove.includes('JSON.stringify({ entryId })'))
  assert.ok(remove.includes('loadClientStatus()'))
  assert.ok(source.includes('runUnpairEntry(server.entryId)'))

  const removeAll = fnBody('runUnpairAllServers')
  assert.ok(removeAll.includes("window.confirm(t('settings.client.unpairAllServersConfirm'))"))
  assert.ok(removeAll.includes('JSON.stringify({ all: true })'))
  assert.ok(source.includes("t('settings.client.unpairAllServers')"))
  assert.ok(source.includes('serverRows.length > 0 && ('))

  assert.ok(source.includes("t('settings.client.diagInterceptInstalled')"))
  assert.ok(source.includes("t('settings.client.diagRemoteDrop'"))
  assert.ok(source.includes("t('settings.client.diagUploadRedirect'"))
  assert.ok(source.includes("t('settings.client.serverDiagTitle'"))
  const diagAt = source.indexOf("t('settings.client.serverDiagTitle'")
  const serverDiagBlock = source.slice(diagAt)
  assert.ok(serverDiagBlock.includes('server.lastError'))
  assert.ok(serverDiagBlock.includes('server.compat'))
  assert.ok(serverDiagBlock.includes('server.pluginBridge'))
  assert.ok(source.includes('legacyTopDiag'))
})

test('PAS-6b & T6: peer revoked banner, email login, logLevel select, no local RTT field in SettingsSection & GatewayWizard', () => {
  assert.equal(source.includes('CLIENT_PEER_DISMISS_REVOKED_ROUTE'), true)
  assert.equal(source.includes('wizard.peer.revokedBanner'), true)
  assert.equal(source.includes('wizard.peer.gatewayEmail'), true)
  assert.equal(source.includes('settings.fieldLogLevel'), true)
  assert.equal(source.includes('settings.fieldPeerDirectMaxRttMs'), false)
  assert.equal(source.includes('wizard.peer.devicePathRelayDemoted'), true)
  assert.equal(wizardSrc.includes('CLIENT_PEER_DISMISS_REVOKED_ROUTE'), true)
  assert.equal(wizardSrc.includes('wizard.peer.revokedBanner'), true)
  assert.equal(wizardSrc.includes('wizard.peer.gatewayEmail'), true)
})
