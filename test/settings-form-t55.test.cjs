// dsh-zen-remote · T55 settings-page fixes (src/client-data/settings-form.ts)
//
// The two real-machine defects, driven at the form/derive layer (the same
// surfaces scripts/check-settings-form.mjs pins, imported here the dynamic
// .ts way):
//
// 1. the admin/status baseline outlived its data source — a page that
//    switched to a client row kept the last host page's `config.values`
//    forever (a client page never refreshes admin/status again), so the
//    role dropdown still displayed host. Now the form consults the baseline
//    only while the poll source is not the client one.
// 2. the relay-wired status route answers the RELAY client's `online`
//    verbatim — a word the view vocabulary never listed, so a connected
//    client rendered as 未配对. Now mapped (and `offline` with it), and a
//    consistency sweep proves every state the route can answer keeps its
//    own line.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/client-data/settings-form.ts?' + Math.random())

const NOW = 1_700_000_000_000

/** Fake shared form scope — the same face scripts/check-settings-form.mjs
 * fakes: a snapshot (row document + revision + writable), a mutate recorder,
 * and a listener set the tests fire by hand to simulate a row move. */
function fakeScope(overrides = {}) {
  const state = {
    snapshot: {
      status: 'ready',
      value: {},
      base: {},
      user: {},
      revision: 7,
      writable: true,
    },
    listeners: new Set(),
  }
  if (overrides.value !== undefined) state.snapshot.value = overrides.value
  if (overrides.user !== undefined) state.snapshot.user = overrides.user
  return {
    state,
    scope: {
      getSnapshot: () => state.snapshot,
      subscribe: (listener) => {
        state.listeners.add(listener)
        return () => { state.listeners.delete(listener) }
      },
      mutate: async () => {
        state.snapshot = { ...state.snapshot, revision: state.snapshot.revision + 1 }
        for (const listener of state.listeners) listener()
        return true
      },
    },
  }
}

// ---- T55 #1: the stale admin baseline ----------------------------------------

test('T55: a client data source ignores the stale admin baseline; the admin source keeps it', async () => {
  const { ZenRemoteSettingsForm } = await load()

  // The row now stores role:'client', the page polls the client source, and
  // the kept host page had fed role:'host': the dropdown must show the ROW's
  // client, and fields the row does not store must fall back off the stale
  // baseline instead of showing the old host's effective values.
  const client = fakeScope({ value: { role: 'client' } })
  const clientForm = new ZenRemoteSettingsForm(client.scope)
  clientForm.setBaseline({ role: 'host', port: 4000 })
  assert.equal(clientForm.statusPoll(), 'client')
  assert.equal(clientForm.getSnapshot().role.text, 'client', 'the stale host baseline no longer pins the dropdown')
  assert.equal(clientForm.getSnapshot().port.text, '', 'a field the row does not store falls back off the stale baseline')

  // Under the admin source the baseline still decides, exactly as before:
  // a field the row layer does not store shows the admin effective value.
  const host = fakeScope({ value: { role: 'host' } })
  const hostForm = new ZenRemoteSettingsForm(host.scope)
  hostForm.setBaseline({ role: 'host', port: 4000 })
  assert.equal(hostForm.statusPoll(), 'admin')
  assert.equal(hostForm.getSnapshot().role.text, 'host')
  assert.equal(hostForm.getSnapshot().port.text, '4000')
})

test('T55: a role switch on the LIVE form drops the stale baseline display at once', async () => {
  const { ZenRemoteSettingsForm } = await load()
  // The real sequence: page mounted as host, admin/status fed the baseline,
  // the user saved role:'client', the row moved — the kept status load is
  // stale host data forever. The display must follow the row, not the
  // baseline, the moment the poll source flips.
  const { scope, state } = fakeScope({ value: { role: 'host' } })
  const form = new ZenRemoteSettingsForm(scope)
  form.setBaseline({ role: 'host', port: 4000 })
  assert.equal(form.getSnapshot().role.text, 'host')

  state.snapshot = { ...state.snapshot, value: { role: 'client' } }
  for (const listener of state.listeners) listener()
  assert.equal(form.statusPoll(), 'client')
  assert.equal(form.getSnapshot().role.text, 'client', 'the switched row reads client, not the kept host baseline')
  assert.equal(form.getSnapshot().port.text, '')
})

// ---- T55 #2: the status-route state vocabulary --------------------------------

test('T55: the relay-wired route\'s online state renders as connected, with the server name', async () => {
  const { clientStatusLineOf, deriveClientStatusView } = await load()
  const view = deriveClientStatusView({ state: 'online', serverName: '书房', serverUrl: 'http://192.168.1.10:3088' })
  assert.equal(view.state, 'connected', 'the relay client\'s online is the page\'s connected')
  assert.equal(view.serverName, '书房')
  assert.deepEqual(clientStatusLineOf(view, NOW), { kind: 'connectedName', serverName: '书房' })
})

test('T55: every state the status route can answer keeps its own line — none collapses to unpaired', async () => {
  const { clientStatusLineOf, deriveClientStatusView } = await load()
  // The full wire vocabulary client-routes.ts's status route answers: the
  // relay client's verdicts (online, and the failed-connect path's
  // revoked / unreachable / unpaired / incompatible / unexpected), the probe
  // fallback's (connected / unreachable), and the row's own two
  // (unpaired / invalid-url) — plus `offline`, the relay state word a
  // verdict-carrying answer could ride in. Every one must land on its own
  // display state; only `unpaired` itself may read as unpaired.
  const expected = {
    online: 'connected',
    offline: 'unreachable',
    unpaired: 'unpaired',
    revoked: 'revoked',
    incompatible: 'incompatible',
    'invalid-url': 'invalid-url',
    connected: 'connected',
    unreachable: 'unreachable',
    unexpected: 'unexpected',
  }
  for (const [wire, want] of Object.entries(expected)) {
    const view = deriveClientStatusView({ state: wire, serverUrl: 'http://x.local:1', serverName: '书房' })
    assert.equal(view.state, want, `wire state ${wire}`)
    if (wire !== 'unpaired') {
      assert.notEqual(view.state, 'unpaired', `wire state ${wire} must not read as unpaired`)
    }
  }

  // An offline relay verdict backed by the reconnect ladder renders the
  // offline countdown line, not the unpaired copy.
  const offline = deriveClientStatusView({ state: 'offline', serverUrl: 'http://x.local:1', nextRetryAt: NOW + 5_000 })
  assert.deepEqual(clientStatusLineOf(offline, NOW), { kind: 'offlineRetry', seconds: 5 })
})
