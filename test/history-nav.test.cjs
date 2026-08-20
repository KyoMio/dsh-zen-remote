// Back-gesture layer stack. Android's system back is the browser's back, so
// the page stack has to be mirrored into history or the gesture leaves the
// PWA (see history-nav.ts). These drive the real module against a minimal
// history/window stub — no DOM, no session, no DSH.
const assert = require('node:assert/strict')
const test = require('node:test')

/** Minimal history + popstate wiring, faithful to the ordering that matters. */
function harness() {
  const entries = [{ state: null }]
  let index = 0
  let onPop = null
  global.window = {
    addEventListener: (type, fn) => { if (type === 'popstate') onPop = fn },
    removeEventListener: () => {},
  }
  global.location = { href: 'https://example.test/' }
  global.history = {
    pushState(state) { entries.length = index + 1; entries.push({ state }); index += 1 },
    back() {
      if (index === 0) return
      index -= 1
      onPop && onPop({ state: entries[index].state })
    },
  }
  return { depth: () => index }
}

async function load() {
  // Fresh module per test: the stack is module-level state. Imports the .ts
  // source directly via Node's type stripping, the same way this repo's
  // check-*.mjs self-checks do — the client build inlines everything into one
  // bundle, so there is no standalone module to load.
  const mod = await import('../src/client/history-nav.ts?' + Math.random())
  return mod
}

test('a layer gives the back gesture something to close instead of exiting', async () => {
  const h = harness()
  const { pushLayer, hasLayer, layerDepth } = await load()
  let closed = false
  pushLayer({ id: 'session', close: () => { closed = true } })
  assert.equal(hasLayer('session'), true)
  assert.equal(h.depth(), 1, 'one history entry to spend')
  global.history.back()
  assert.equal(closed, true, 'back closed the layer')
  assert.equal(layerDepth(), 0)
})

test('nested layers close top-down, one gesture each', async () => {
  harness()
  const { pushLayer, layerDepth } = await load()
  const order = []
  pushLayer({ id: 'session', close: () => order.push('session') })
  pushLayer({ id: 'info', close: () => order.push('info') })
  assert.equal(layerDepth(), 2)
  global.history.back()
  assert.deepEqual(order, ['info'], 'the sheet closes first, the session stays')
  global.history.back()
  assert.deepEqual(order, ['info', 'session'])
})

test('popLayer rewinds instead of flipping state, so the two never drift', async () => {
  harness()
  const { pushLayer, popLayer, layerDepth } = await load()
  let closed = 0
  pushLayer({ id: 'info', close: () => { closed += 1 } })
  popLayer('info')
  assert.equal(closed, 1, 'closed exactly once, via popstate')
  assert.equal(layerDepth(), 0, 'history and the stack agree')
})

test('closing out of order does not take the layer above with it', async () => {
  harness()
  const { pushLayer, popLayer, hasLayer } = await load()
  const order = []
  pushLayer({ id: 'session', close: () => order.push('session') })
  pushLayer({ id: 'modal-1', close: () => order.push('modal-1') })
  popLayer('session')
  assert.deepEqual(order, ['session'], 'only the named layer closed')
  assert.equal(hasLayer('modal-1'), true, 'the deeper layer is still open')
})

test('one gesture crossing several entries closes every layer above the target', async () => {
  const h = harness()
  const { pushLayer, layerDepth } = await load()
  const order = []
  pushLayer({ id: 'a', close: () => order.push('a') })
  pushLayer({ id: 'b', close: () => order.push('b') })
  pushLayer({ id: 'c', close: () => order.push('c') })
  // A restored session or a fast double-back can land more than one entry down.
  global.history.back()
  global.history.back()
  assert.deepEqual(order, ['c', 'b'])
  assert.equal(layerDepth(), 1)
  assert.equal(h.depth(), 1)
})

test('a throwing layer does not strand the ones underneath it', async () => {
  harness()
  const { pushLayer, layerDepth } = await load()
  let bottom = false
  pushLayer({ id: 'bottom', close: () => { bottom = true } })
  pushLayer({ id: 'boom', close: () => { throw new Error('nope') } })
  global.history.back()
  global.history.back()
  assert.equal(bottom, true)
  assert.equal(layerDepth(), 0)
})

test('the same id is never stacked twice', async () => {
  harness()
  const { pushLayer, layerDepth } = await load()
  pushLayer({ id: 'info', close: () => {} })
  pushLayer({ id: 'info', close: () => {} })
  assert.equal(layerDepth(), 1)
})
