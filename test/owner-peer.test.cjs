'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createOwnerPeerSource, withPeer, createSharedApiFetchGetter } = require('../lib/owner-peer.js')

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

test('createSharedApiFetchGetter: dispatches /api with the owner Peer on an rc.3-shaped handler', async () => {
  // dsh-client-connection@0.2.1-rc.3 lib/index.js:826-832: the shared-fetch
  // handler's fetch(request, peer) reads peer.principal DIRECTLY — a missing
  // peer throws TypeError, a non-owner gets 403 — and the dispatch asserts
  // `this === handler`. This fake reproduces exactly that shape.
  const createPeerCalls = []
  const receivedPeers = []
  const handlers = []
  let scope = new AbortController()
  const minted = []
  const connection = {
    createPeer(options) {
      createPeerCalls.push(options)
      scope = new AbortController()
      const peer = { principal: options.principal, interactions: options.interactions, signal: scope.signal }
      minted.push(peer)
      return peer
    },
    createSharedFetchHandler(channel) {
      assert.equal(channel, '/api')
      const handler = {
        fetch(request, peer) {
          assert.equal(this, handler, 'the dispatcher must keep this === handler')
          receivedPeers.push(peer)
          if (peer === undefined) throw new TypeError("Cannot read properties of undefined (reading 'principal')")
          if (peer.principal.kind !== 'owner') return Promise.resolve(new Response('forbidden', { status: 403 }))
          return Promise.resolve(new Response('ok', { status: 200 }))
        },
      }
      handlers.push(handler)
      return handler
    },
  }
  const getApiFetch = createSharedApiFetchGetter(() => new Proxy(connection, {}))
  const fetch = getApiFetch()
  assert.equal(typeof fetch, 'function')
  const response = await fetch(new Request('https://dsh.internal/api/attachment/upload'))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'ok')
  assert.deepEqual(createPeerCalls, [{ principal: { kind: 'owner' }, interactions: 'answer' }])
  assert.equal(handlers.length, 1)
  assert.equal(receivedPeers.length, 1)
  assert.equal(receivedPeers[0], minted[0], 'the handler receives the minted owner Peer itself')
})

test('createSharedApiFetchGetter: a non-owner Peer flows into the rc.3 403 branch', async () => {
  const connection = {
    createSharedFetchHandler(channel) {
      const handler = {
        fetch(request, peer) {
          assert.equal(this, handler)
          if (peer === undefined) throw new TypeError("Cannot read properties of undefined (reading 'principal')")
          if (peer.principal.kind !== 'owner') return Promise.resolve(new Response('forbidden', { status: 403 }))
          return Promise.resolve(new Response('ok', { status: 200 }))
        },
      }
      return handler
    },
  }
  const getApiFetch = createSharedApiFetchGetter(() => connection, () => ({ principal: { kind: 'device' } }))
  const response = await getApiFetch()(new Request('https://dsh.internal/api/session.list'))
  assert.equal(response.status, 403)
})

test('createSharedApiFetchGetter: undefined when the connection is absent, shapeless, or throws', () => {
  assert.equal(createSharedApiFetchGetter(() => undefined)(), undefined)
  assert.equal(createSharedApiFetchGetter(() => null)(), undefined)
  assert.equal(createSharedApiFetchGetter(() => 'not-an-object')(), undefined)
  // No createSharedFetchHandler on the connection.
  assert.equal(createSharedApiFetchGetter(() => ({}))(), undefined)
  // Handler without a fetch member.
  assert.equal(createSharedApiFetchGetter(() => ({ createSharedFetchHandler: () => ({}) }))(), undefined)
  // The reflection-layer read can throw (no inject in this composition).
  assert.equal(createSharedApiFetchGetter(() => { throw new Error('no inject') })(), undefined)
})
