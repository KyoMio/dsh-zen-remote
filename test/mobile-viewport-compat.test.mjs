import assert from 'node:assert/strict'
import test from 'node:test'
import { isViewportSunkBelowStatusBar as sunk } from '../src/client/effects/phone-chrome.ts'
import { composerLift, estimatedLift, keyboardLift as lift, safetyPad } from '../src/client/effects/keyboard-avoid.ts'
import { KEYBOARD_DEFAULTS, parseClientConfig } from '../src/client/client-config.ts'
import { COMPOSER_CSS } from '../src/client/styles/composer.css.ts'
import { createSnapshotStore, defineStore, workspaceTitleOf } from '../src/client/compat/store.ts'
import { mainSessionIdOf } from '../src/client/compat/types.ts'
import { isDesktopShell } from '../src/client/compat/desktop.ts'
import { clamped } from '../lib/index.js'

test('isViewportSunkBelowStatusBar: standalone iOS sunk viewport vs Safari, black-translucent, landscape, Android, partial', () => {
  assert.equal(sunk({ standalone: true, screenHeight: 852, innerHeight: 793, envTop: 59 }), true)
  assert.equal(sunk({ standalone: false, screenHeight: 852, innerHeight: 793, envTop: 59 }), false)
  assert.equal(sunk({ standalone: true, screenHeight: 852, innerHeight: 852, envTop: 59 }), false)
  assert.equal(sunk({ standalone: true, screenHeight: 852, innerHeight: 350, envTop: 0 }), false)
  assert.equal(sunk({ standalone: true, screenHeight: 2400, innerHeight: 2316, envTop: 0 }), false)
  assert.equal(sunk({ standalone: true, screenHeight: 800, innerHeight: 800, envTop: 0 }), false)
  assert.equal(sunk({ standalone: true, screenHeight: 852, innerHeight: 832, envTop: 59 }), false)
})

test('keyboard-avoid geometry, safetyPad, composerLift, CSS _root transform target, and clamped config', () => {
  assert.equal(lift({ innerHeight: 800, vvHeight: 500, offsetTop: 0, scale: 1 }), 300)
  assert.equal(lift({ innerHeight: 800, vvHeight: 500, offsetTop: 300, scale: 1 }), 0)
  assert.equal(lift({ innerHeight: 800, vvHeight: 500, offsetTop: 120, scale: 1 }), 180)
  assert.equal(lift({ innerHeight: 800, vvHeight: 800, offsetTop: 0, scale: 1 }), 0)
  assert.equal(lift({ innerHeight: 500, vvHeight: 500, offsetTop: 0, scale: 1 }), 0)
  assert.equal(lift({ innerHeight: 800, vvHeight: 400, offsetTop: 100, scale: 2 }), 0)
  assert.equal(lift({ innerHeight: 800, vvHeight: 799, offsetTop: 0, scale: 1 }), 0)
  assert.equal(lift({ innerHeight: 800, vvHeight: 507.5, offsetTop: 0, scale: 1 }), 293)
  assert.equal(lift({ innerHeight: 800, vvHeight: 500, offsetTop: 320, scale: 1 }), 0)

  assert.equal(estimatedLift(858), 360)
  assert.ok(estimatedLift(858) > 315)
  assert.equal(estimatedLift(2000), 400)
  assert.equal(estimatedLift(600), 252)

  const ANDROID = 'Mozilla/5.0 (Linux; Android 17) AppleWebKit/537.36 Chrome/135 Mobile'
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile'
  assert.equal(safetyPad(ANDROID), 15)
  assert.equal(safetyPad(IPHONE), 0)
  assert.equal(safetyPad('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 0)

  const A = safetyPad(ANDROID)
  assert.equal(composerLift(300, 0, true, A), 315)
  assert.equal(composerLift(0, 0, true, A), 15)
  assert.equal(composerLift(0, 360, false, A), 360)
  assert.equal(composerLift(0, 0, false, A), 0)
  assert.equal(composerLift(300, 360, true, A), 315)

  const I = safetyPad(IPHONE)
  assert.equal(composerLift(300, 0, true, I), 300)
  assert.equal(composerLift(0, 0, true, I), 0)

  assert.match(
    COMPOSER_CSS,
    /html\[data-mnav-kb\] \[data-slot="conversation\.composer\.bar"\] > \[class\$="_root"\]\s*\{\s*transform/,
    'keyboard-avoid transform must hit the box-generating _root child',
  )

  assert.deepEqual(KEYBOARD_DEFAULTS, { liftRatio: 0.42, liftMaxPx: 400, safetyPadPx: 15 })
  assert.equal(estimatedLift(858, KEYBOARD_DEFAULTS), estimatedLift(858))
  assert.equal(safetyPad(ANDROID, KEYBOARD_DEFAULTS.safetyPadPx), safetyPad(ANDROID))

  assert.equal(estimatedLift(700, { liftRatio: 0.5, liftMaxPx: 400, safetyPadPx: 15 }), 350)
  assert.equal(estimatedLift(858, { liftRatio: 0.5, liftMaxPx: 500, safetyPadPx: 15 }), 429)
  assert.equal(estimatedLift(858, { liftRatio: 0.5, liftMaxPx: 380, safetyPadPx: 15 }), 380)
  assert.equal(safetyPad(ANDROID, 40), 40)
  assert.equal(safetyPad(IPHONE, 40), 0)

  for (const body of [undefined, null, {}, 'not json', { keyboardLiftRatio: 'big' }, { keyboardLiftRatio: NaN }]) {
    assert.deepEqual(parseClientConfig(body).keyboard, KEYBOARD_DEFAULTS)
  }
  assert.equal(parseClientConfig({ keyboardLiftRatio: 0.5 }).keyboard.liftRatio, 0.5)
  assert.equal(parseClientConfig({ keyboardSafetyPadPx: 0 }).keyboard.safetyPadPx, 0)
  assert.equal(parseClientConfig({ turnFoldDesktop: true }).turnFoldDesktop, true)

  assert.deepEqual(clamped('keyboardLiftRatio', 5, 0, 1), { keyboardLiftRatio: 1 })
  assert.deepEqual(clamped('keyboardLiftRatio', -2, 0, 1), { keyboardLiftRatio: 0 })
  assert.deepEqual(clamped('keyboardLiftMaxPx', 9000, 0, 2000), { keyboardLiftMaxPx: 2000 })
  assert.deepEqual(clamped('keyboardLiftRatio', undefined, 0, 1), {})
  for (const bad of [Number.NaN, Infinity, '0.5', null]) {
    assert.deepEqual(clamped('keyboardLiftRatio', bad, 0, 1), {})
  }
})

test('compat store: workspaceTitleOf, createSnapshotStore, defineStore, and localStorage persistence', (t) => {
  assert.equal(workspaceTitleOf('/a/b/c'), 'c')
  assert.equal(workspaceTitleOf('/a/b/c/'), 'c')
  assert.equal(workspaceTitleOf('C:\\x\\y'), 'y')
  assert.equal(workspaceTitleOf('/'), '')

  const init = { n: 1 }
  const store = createSnapshotStore(init)
  const initialRef = store.getSnapshot()
  assert.deepEqual(initialRef, { n: 1 })
  assert.equal(store.getSnapshot(), initialRef)

  let calls = 0
  const unsubscribe = store.subscribe(() => { calls += 1 })
  store.update((draft) => { draft.n = 2 })
  assert.equal(store.getSnapshot().n, 2)
  assert.notEqual(store.getSnapshot(), initialRef)
  assert.equal(calls, 1)
  assert.deepEqual(init, { n: 1 })
  unsubscribe()
  store.update((draft) => { draft.n = 3 })
  assert.equal(calls, 1)

  const decl = {
    init: () => ({ view: 'home', workspace: null }),
    actions: { show: (draft, view) => { draft.view = view } },
  }
  const handle = defineStore(decl)
  assert.equal(handle.spec, decl)
  const instance = handle.create()
  assert.equal(typeof instance.getSnapshot, 'function')
  assert.equal(typeof instance.store.getSnapshot, 'function')
  let viewCalls = 0
  const off = instance.subscribe(() => { viewCalls += 1 })
  instance.actions.show('session')
  assert.equal(instance.getSnapshot().view, 'session')
  assert.equal(viewCalls, 1)
  off()

  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  t.after(() => {
    if (prevStorage === undefined) delete globalThis.localStorage
    else Object.defineProperty(globalThis, 'localStorage', prevStorage)
  })

  const memory = new Map()
  let failWrites = false
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => {
      if (failWrites) throw new Error('quota exceeded')
      memory.set(key, String(value))
    },
    removeItem: (key) => { memory.delete(key) },
  }

  const persisted = defineStore({
    persist: 'k',
    init: () => ({ view: 'home', workspace: null }),
    actions: { show: (draft, view) => { draft.view = view } },
  })
  const pInstance = persisted.create()
  pInstance.actions.show('session')
  assert.deepEqual(JSON.parse(memory.get('k')), { view: 'session', workspace: null })

  const scoped = persisted.create('sess-1')
  scoped.actions.show('session')
  assert.ok(memory.has('k'))
  assert.deepEqual(JSON.parse(memory.get('k.sess-1')), { view: 'session', workspace: null })

  scoped.clearPersisted()
  assert.ok(!memory.has('k.sess-1'))
  assert.ok(memory.has('k'))

  failWrites = true
  const realError = console.error
  console.error = () => {}
  try {
    assert.doesNotThrow(() => { pInstance.actions.show('home') })
  } finally {
    console.error = realError
  }
  assert.equal(pInstance.getSnapshot().view, 'home')
})

test('T017: mainSessionIdOf and isDesktopShell', () => {
  assert.equal(mainSessionIdOf({}), undefined)
  assert.equal(mainSessionIdOf({ a: { id: 'a', retainedBy: {} }, b: { id: 'b', retainedBy: { mainView: 0 } } }), undefined)
  assert.equal(mainSessionIdOf({ a: { id: 'session-a', retainedBy: {} }, b: { id: 'session-b', retainedBy: { mainView: 1 } } }), 'session-b')
  assert.equal(mainSessionIdOf({ b: { id: 'session-b', retainedBy: { mainView: 2 } } }), 'session-b')

  const byId = { first: { id: 'session-first', retainedBy: { mainView: 1 } }, second: { id: 'session-second', retainedBy: { mainView: 1 } } }
  const picks = new Set([mainSessionIdOf(byId), mainSessionIdOf(byId), mainSessionIdOf(byId)])
  assert.equal(picks.size, 1)
  assert.equal(picks.has('session-first'), true)

  assert.equal(isDesktopShell({ dshDesktop: { protocolVersion: 1 } }), true)
  assert.equal(isDesktopShell({}), false)
  assert.equal(isDesktopShell({ dshDesktop: {} }), true)
})
