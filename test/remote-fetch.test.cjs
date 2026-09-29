// dsh-zen-remote · T41b browser fetch wrapper (src/client/remote-fetch.ts)
//
// The rewrite decision is a pure function, so it is driven directly — string
// and URL inputs against a fake location, no DOM. The install/uninstall half
// runs against a fake fetch host and proves the once-only layering and the
// restore semantics (a later wrapper over ours survives our uninstall).
// Imports the .ts directly (Node type stripping, same as history-nav.test.cjs).
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const BASE = 'https://app.test/'
const VIRTUAL_ID = 'zr~abcd1234~session-1'

/** Fresh module per test where layering state matters: the install guard is
 * module-level, so every install test loads its own copy. */
function load() {
  // Fresh module per test: the install guard is module-level state. The
  // cache-busting query is the same trick history-nav.test.cjs uses.
  return import('../src/client/remote-fetch.ts?' + Math.random())
}

test('rewrite: the two exact /api routes with a virtual sessionId rewrite to the relay route', async () => {
  const { CLIENT_HTTP_ROUTE_PREFIX, rewriteRemoteApiUrl } = await load()
  // The deliverables panel builds DOCUMENT-RELATIVE string URLs
  // (`api/changes.summary?...`) — resolved against the page location.
  assert.equal(
    rewriteRemoteApiUrl('api/changes.summary?sessionId=zr~abcd1234~session-1&seq=3', 'GET', BASE),
    `${CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=zr~abcd1234~session-1&seq=3`,
  )
  assert.equal(
    rewriteRemoteApiUrl('/api/changes.diff?sessionId=zr~abcd1234~s~x&seq=3&index=0', 'GET', BASE),
    `${CLIENT_HTTP_ROUTE_PREFIX}changes.diff?sessionId=zr~abcd1234~s~x&seq=3&index=0`,
    'the remainder after the second ~ stays verbatim (virtual-id parsing)',
  )
  // URL inputs rewrite too.
  assert.equal(
    rewriteRemoteApiUrl(new URL('/api/changes.summary?sessionId=zr~abcd1234~session-1&seq=1', BASE), 'GET', BASE),
    `${CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=zr~abcd1234~session-1&seq=1`,
  )
})

test('rewrite: everything else passes through untouched', async () => {
  const { rewriteRemoteApiUrl } = await load()
  const SUMMARY = 'api/changes.summary?sessionId=zr~abcd1234~session-1&seq=1'
  // A LOCAL session id never rewrites (the whole point: the host role is
  // untouched, and a sub-client's local sessions stay local).
  assert.equal(rewriteRemoteApiUrl('api/changes.summary?sessionId=session-local&seq=1', 'GET', BASE), undefined)
  assert.equal(rewriteRemoteApiUrl('api/changes.diff?sessionId=&seq=1', 'GET', BASE), undefined)
  assert.equal(rewriteRemoteApiUrl('api/changes.summary?seq=1', 'GET', BASE), undefined)
  // Other paths, including the deliberately unrelayed /api routes.
  assert.equal(rewriteRemoteApiUrl('api/changes.open?sessionId=zr~abcd1234~session-1&seq=1&index=0', 'GET', BASE), undefined)
  assert.equal(rewriteRemoteApiUrl('api/present.host', 'GET', BASE), undefined)
  assert.equal(rewriteRemoteApiUrl('api/session/page?cursor=x', 'GET', BASE), undefined)
  // Non-GET, cross-origin, and unparseable input.
  assert.equal(rewriteRemoteApiUrl(SUMMARY, 'POST', BASE), undefined)
  assert.equal(rewriteRemoteApiUrl('https://evil.test/api/changes.summary?sessionId=zr~abcd1234~session-1', 'GET', BASE), undefined)
  assert.equal(rewriteRemoteApiUrl(undefined, 'GET', BASE), undefined)
  assert.equal(rewriteRemoteApiUrl(42, 'GET', BASE), undefined)
  assert.equal(rewriteRemoteApiUrl(SUMMARY, 'GET', 'not a url'), undefined)
})

test('rewrite: method matching is case-insensitive, like fetch itself', async () => {
  const { rewriteRemoteApiUrl } = await load()
  assert.ok(rewriteRemoteApiUrl('api/changes.summary?sessionId=zr~abcd1234~session-1&seq=1', 'get', BASE) !== undefined)
})

test('install: virtual calls rewrite once, everything else reaches the original verbatim', async () => {
  const { CLIENT_HTTP_ROUTE_PREFIX, installRemoteApiFetch } = await load()
  const originalCalls = []
  const original = async (input, init) => {
    originalCalls.push({ input, init })
    return { ok: true, url: String(input) }
  }
  const host = { location: { href: BASE }, fetch: original }
  installRemoteApiFetch(host)
  const res = await host.fetch(`api/changes.summary?sessionId=${VIRTUAL_ID}&seq=3`, { signal: 'SIG' })
  assert.equal(res.url, `${CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=${VIRTUAL_ID}&seq=3`)
  assert.deepEqual(originalCalls, [{ input: res.url, init: { signal: 'SIG' } }], 'exactly one hop, init passed through')
  // Local session / cross-origin / POST reach the original VERBATIM.
  await host.fetch('api/changes.summary?sessionId=session-local&seq=1')
  await host.fetch('https://evil.test/api/changes.summary?sessionId=zr~abcd1234~session-1')
  await host.fetch('api/changes.open?sessionId=zr~abcd1234~session-1&seq=1', { method: 'POST' })
  assert.equal(originalCalls.length, 4)
  assert.equal(originalCalls[1].input, 'api/changes.summary?sessionId=session-local&seq=1')
  assert.equal(originalCalls[2].input, 'https://evil.test/api/changes.summary?sessionId=zr~abcd1234~session-1')
  assert.equal(originalCalls[3].input, 'api/changes.open?sessionId=zr~abcd1234~session-1&seq=1')
  assert.equal(originalCalls[3].init.method, 'POST')
})

test('install: a second install layers nothing (the wrap stays one hop deep)', async () => {
  const { CLIENT_HTTP_ROUTE_PREFIX, installRemoteApiFetch } = await load()
  const originalCalls = []
  const host = {
    location: { href: BASE },
    fetch: async (input, init) => {
      originalCalls.push({ input: String(input), init })
      return { url: String(input) }
    },
  }
  installRemoteApiFetch(host)
  installRemoteApiFetch(host)
  installRemoteApiFetch(host)
  await host.fetch(`api/changes.summary?sessionId=${VIRTUAL_ID}&seq=1`)
  assert.equal(originalCalls.length, 1)
  assert.equal(originalCalls[0].input, `${CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=${VIRTUAL_ID}&seq=1`)
})

test('install: uninstall restores the original fetch, and a later wrapper over ours survives it', async () => {
  const { CLIENT_HTTP_ROUTE_PREFIX, installRemoteApiFetch } = await load()
  const original = async (input) => ({ via: 'original', input: String(input) })
  const host = { location: { href: BASE }, fetch: original }
  const uninstall = installRemoteApiFetch(host)
  assert.notEqual(host.fetch, original, 'the wrap is in place')
  const answer = await host.fetch(`api/changes.summary?sessionId=${VIRTUAL_ID}&seq=1`)
  assert.equal(answer.input, `${CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=${VIRTUAL_ID}&seq=1`, 'the virtual call was rewritten')

  // Another plugin wraps OVER ours, keeping a reference to our function.
  const overOurs = host.fetch
  const later = async (input, init) => overOurs(input, init)
  host.fetch = later

  uninstall()
  assert.equal(host.fetch, later, 'a later wrapper is never pulled')

  // A clean reinstall re-wraps the CURRENT fetch (the later wrapper) —
  // never stacking on a stale reference of our own.
  installRemoteApiFetch(host)
  assert.notEqual(host.fetch, later)
  const rewritten = await host.fetch(`api/changes.summary?sessionId=${VIRTUAL_ID}&seq=1`)
  assert.equal(rewritten.input, `${CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=${VIRTUAL_ID}&seq=1`, 'the reinstall rewraps the CURRENT fetch')
})

test('install: a host whose fetch changed underneath keeps the uninstall a guarded no-op', async () => {
  const { installRemoteApiFetch } = await load()
  const original = async (input) => ({ input: String(input) })
  const host = { location: { href: BASE }, fetch: original }
  const uninstall = installRemoteApiFetch(host)
  // Someone restored the original by hand (another uninstall path ran).
  host.fetch = original
  uninstall()
  assert.equal(host.fetch, original, 'no pull, no throw')
})

test('install: a reload interleave (new apply adopts, old dispose cannot undo) keeps the wrap alive', async () => {
  const { CLIENT_HTTP_ROUTE_PREFIX, installRemoteApiFetch } = await load()
  const originalCalls = []
  const original = async (input) => {
    originalCalls.push(String(input))
    return { input: String(input) }
  }
  const host = { location: { href: BASE }, fetch: original }
  // Row generation A installs...
  const disposeA = installRemoteApiFetch(host)
  // ...generation B applies (and adopts the live wrap) BEFORE A disposes —
  // the real cordis row-reload order.
  const disposeB = installRemoteApiFetch(host)
  disposeA()
  // A's uninstall must NOT have undone the wrap B now owns: rewriting still
  // works and the layer depth is unchanged.
  const rewritten = await host.fetch(`api/changes.summary?sessionId=${VIRTUAL_ID}&seq=1`)
  assert.equal(rewritten.input, `${CLIENT_HTTP_ROUTE_PREFIX}changes.summary?sessionId=${VIRTUAL_ID}&seq=1`, 'A dispose left B wrap alone')
  // B's own dispose is the one that unwraps.
  disposeB()
  assert.equal(host.fetch, original)
  const after = await host.fetch(`api/changes.summary?sessionId=${VIRTUAL_ID}&seq=1`)
  assert.equal(after.input, `api/changes.summary?sessionId=${VIRTUAL_ID}&seq=1`)
})

test('install: an uninstalled wrapper still held by an outer wrapper passes through (active flag)', async () => {
  const { installRemoteApiFetch } = await load()
  const originalCalls = []
  const original = async (input) => {
    originalCalls.push(String(input))
    return { input: String(input) }
  }
  const host = { location: { href: BASE }, fetch: original }
  const dispose = installRemoteApiFetch(host)
  // Another plugin wraps over ours, capturing our wrapper function.
  const ours = host.fetch
  host.fetch = async (input, init) => ours(input, init)
  dispose()
  const seen = await host.fetch(`api/changes.summary?sessionId=${VIRTUAL_ID}&seq=1`)
  // The captured wrapper went INERT after the uninstall: the virtual call
  // reaches the original untouched instead of rewriting for a dead install.
  assert.equal(seen.input, `api/changes.summary?sessionId=${VIRTUAL_ID}&seq=1`)
  assert.deepEqual(originalCalls, [`api/changes.summary?sessionId=${VIRTUAL_ID}&seq=1`])
})
