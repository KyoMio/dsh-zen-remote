// Behaviour check for the self-written store compat layer
// (src/client/compat/store.ts): workspaceTitleOf edge cases, snapshot-store
// update/subscribe semantics, defineStore handle/actions wiring, and
// whole-value persistence against a fake localStorage.
//
// Run: node scripts/check-compat-store.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import {
  createSnapshotStore,
  defineStore,
  workspaceTitleOf,
} from '../src/client/compat/store.ts'

// ---- 1. workspaceTitleOf ---------------------------------------------------
assert.equal(workspaceTitleOf('/a/b/c'), 'c')
assert.equal(workspaceTitleOf('/a/b/c/'), 'c')
assert.equal(workspaceTitleOf('C:\\x\\y'), 'y')
assert.equal(workspaceTitleOf('/'), '')

// ---- 2. createSnapshotStore basics ------------------------------------------
const init = { n: 1 }
const store = createSnapshotStore(init)
const initialRef = store.getSnapshot()
assert.deepEqual(initialRef, { n: 1 })
assert.equal(store.getSnapshot(), initialRef, 'getSnapshot must return the same reference until an update')

let calls = 0
const unsubscribe = store.subscribe(() => { calls += 1 })
store.update((draft) => { draft.n = 2 })
assert.equal(store.getSnapshot().n, 2, 'update must apply the mutation')
assert.notEqual(store.getSnapshot(), initialRef, 'update must swap in a new reference')
assert.equal(calls, 1, 'subscriber must be called exactly once per update')
assert.deepEqual(init, { n: 1 }, 'the shallow copy must protect the initial state from the mutator')

unsubscribe()
store.update((draft) => { draft.n = 3 })
assert.equal(calls, 1, 'unsubscribed callbacks must not be called again')

// ---- 3. defineStore basics ---------------------------------------------------
// Same declaration shape as nav-store.ts: flat { view, workspace } state.
const decl = {
  init: () => ({ view: 'home', workspace: null }),
  actions: {
    show: (draft, view) => {
      draft.view = view
    },
  },
}
const handle = defineStore(decl)
assert.equal(handle.spec, decl, 'handle carries the declaration as its spec')
const instance = handle.create()
assert.equal(typeof instance.getSnapshot, 'function')
assert.equal(typeof instance.store.getSnapshot, 'function', 'instance must carry the raw snapshot store')
let viewCalls = 0
const off = instance.subscribe(() => { viewCalls += 1 })
instance.actions.show('session')
assert.equal(instance.getSnapshot().view, 'session', 'baked action must move the view')
assert.equal(viewCalls, 1, 'baked action must notify exactly once')
off()

// ---- 4. persistence against a fake localStorage -------------------------------
const memory = new Map()
let failWrites = false
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => {
    if (failWrites) throw new Error('quota exceeded')
    memory.set(key, String(value))
  },
  removeItem: (key) => {
    memory.delete(key)
  },
}

const persisted = defineStore({
  persist: 'k',
  init: () => ({ view: 'home', workspace: null }),
  actions: {
    show: (draft, view) => {
      draft.view = view
    },
  },
})
const pInstance = persisted.create()
pInstance.actions.show('session')
assert.deepEqual(JSON.parse(memory.get('k')), { view: 'session', workspace: null },
  'the persisted value must be the whole state as JSON, not a spread object')

const scoped = persisted.create('sess-1')
scoped.actions.show('session')
assert.ok(memory.has('k'), 'the root-scope key must still be stored')
assert.deepEqual(JSON.parse(memory.get('k.sess-1')), { view: 'session', workspace: null },
  'a scoped instance must persist under `${decl.persist}.${scopeKey}`')

scoped.clearPersisted()
assert.ok(!memory.has('k.sess-1'), 'clearPersisted must drop exactly the scoped key')
assert.ok(memory.has('k'), 'clearPersisted must not touch other keys')

// A throwing setItem (quota / private mode) must not break the store. The
// store logs the failure through console.error by design; silence it so the
// check output stays readable.
failWrites = true
const realError = console.error
console.error = () => {}
try {
  assert.doesNotThrow(() => { pInstance.actions.show('home') }, 'a failed persistence write must not throw')
} finally {
  console.error = realError
}
assert.equal(pInstance.getSnapshot().view, 'home', 'the in-memory update still applies when persisting fails')
failWrites = false

console.log('check-compat-store: ok')
