'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createOwnerPeerSource, withPeer } = require('../lib/owner-peer.js')

test('createOwnerPeerSource: createPeer once as owner/answer, cached until disposed', () => {
  const calls = []
  let scope = new AbortController()
  const connection = {
    createPeer(options) { calls.push(options); scope = new AbortController(); return { id: calls.length, signal: scope.signal } },
  }
  // A fresh proxy per read, like ctx.reflect.get('connection') — identity
  // must NOT be the cache key.
  const get = createOwnerPeerSource(() => new Proxy(connection, {}))
  const a = get()
  assert.deepEqual(calls[0], { principal: { kind: 'owner' }, interactions: 'answer' })
  assert.equal(get(), a, 'the SAME Peer answers $events/result')
  scope.abort()
  const b = get()
  assert.notEqual(b, a, 'a disposed Peer is replaced')
  assert.equal(calls.length, 2)
})

test('createOwnerPeerSource: browserPeer fallback, undefined on pre-alpha.3 hosts', () => {
  const browserPeer = { id: 'browser' }
  assert.equal(createOwnerPeerSource(() => ({ browserPeer }))(), browserPeer)
  assert.equal(createOwnerPeerSource(() => ({ operator: { id: 'op' } }))(), undefined)
  assert.equal(createOwnerPeerSource(() => undefined)(), undefined)
  assert.equal(createOwnerPeerSource(() => { throw new Error('no inject') })(), undefined)
})

test('withPeer: attaches only when a Peer exists', () => {
  const req = { namespace: 'a', method: 'b', args: {} }
  assert.equal(withPeer(req, undefined), req)
  assert.equal(withPeer(req, () => undefined), req)
  assert.deepEqual(withPeer(req, () => 'P'), { ...req, peer: 'P' })
})
