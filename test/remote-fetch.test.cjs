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

function loadCluesRule() {
  return import('../src/client/adapter-rules/better-sidebar-clues.ts?' + Math.random())
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

// ---- PB-27 finding 4 & BS34-3: generic block rules + better-sidebar clue rule ----

test('clue block: /sidebar/api/clues.* and the share routes match BETTER_SIDEBAR_CLUES_RULE and block only while remote', async () => {
  const { matchFetchBlockRule, shouldBlockFetchCall } = await load()
  const { BETTER_SIDEBAR_CLUES_RULE, isCluePath } = await loadCluesRule()
  const rules = [BETTER_SIDEBAR_CLUES_RULE]
  // The shape coverage: api methods, the exact root, and the four shares.
  assert.equal(isCluePath('/sidebar/api/clues.list'), true)
  assert.equal(isCluePath('/sidebar/api/clues.saveEdit'), true)
  assert.equal(isCluePath('/sidebar/api/clues'), true)
  for (const p of ['/sidebar/clues/share/export-preview', '/sidebar/clues/share/export', '/sidebar/clues/share/import-preview', '/sidebar/clues/share/import']) {
    assert.equal(isCluePath(p), true, `${p} is a clue path`)
  }
  // NOT clue paths: every other sidebar method, the agent loopback routes
  // (they are the host's own channel, and a local host answers them), and
  // the ordinary /api surface.
  assert.equal(isCluePath('/sidebar/api/fs.tree'), false)
  assert.equal(isCluePath('/sidebar/api/selection.translate'), false)
  assert.equal(isCluePath('/sidebar/agent/clues/read'), false, 'the agent loopback route is not a browser clue call')
  assert.equal(isCluePath('/api/changes.summary'), false)
  assert.equal(matchFetchBlockRule('/sidebar/api/clues.list', BASE, []), undefined)
  assert.equal(matchFetchBlockRule('/sidebar/api/clues.list', BASE, rules), BETTER_SIDEBAR_CLUES_RULE)
  // The decision gates on the remote probe…
  assert.equal(shouldBlockFetchCall('/sidebar/api/clues.list', BASE, true, rules), true)
  assert.equal(shouldBlockFetchCall('/sidebar/api/clues.list', BASE, false, rules), false, 'a local session never blocks')
  // …on same-origin…
  assert.equal(shouldBlockFetchCall('https://evil.test/sidebar/api/clues.list', BASE, true, rules), false, 'cross-origin passes through untouched')
  // …and document-relative URLs resolve against the page.
  assert.equal(shouldBlockFetchCall('sidebar/api/clues.list', BASE, true, rules), true)
  // Request-shaped objects decide by their url.
  assert.equal(shouldBlockFetchCall({ url: `${BASE}sidebar/clues/share/export` }, BASE, true, rules), true)
  // Unparseable input never blocks.
  assert.equal(shouldBlockFetchCall(undefined, BASE, true, rules), false)
  assert.equal(shouldBlockFetchCall(42, BASE, true, rules), false)
})

test('clue block: the wrapper answers the synthetic refusal without touching the network — and the SAME call passes through the moment the session goes local (switch regression)', async () => {
  const { installRemoteApiFetch, setRemoteSessionProbeForTests } = await load()
  const { BETTER_SIDEBAR_CLUES_RULE } = await loadCluesRule()
  const originalCalls = []
  const host = {
    location: { href: BASE },
    fetch: async (input, init) => {
      originalCalls.push(String(input))
      return new Response(JSON.stringify({ ok: true, value: { local: true } }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
  // The session on screen IS remote (the html attribute is set — the probe
  // reads exactly what the stylesheet hiding keys on).
  let remote = true
  setRemoteSessionProbeForTests(() => remote)
  try {
    const uninstall = installRemoteApiFetch(host, {
      blockRules: [BETTER_SIDEBAR_CLUES_RULE],
      shouldAnnotateLocal: () => true,
    })

    const blocked = await host.fetch('/sidebar/api/clues.list', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'ws-1' }),
    })
    assert.equal(blocked.status, 503, 'the blocked call answers the refusal status')
    const blockedBody = await blocked.json()
    assert.equal(blockedBody.ok, false)
    assert.equal(blockedBody.error.code, 'remote-clues-unsupported', 'the envelope carries the wire code the UI degrades on')
    assert.equal(originalCalls.length, 0, 'the call never reached the network')

    // The share window's export call is blocked the same way.
    const share = await host.fetch('/sidebar/clues/share/export', { method: 'POST', body: '{}' })
    assert.equal(share.status, 503)
    assert.equal(originalCalls.length, 0)

    // THE SWITCH REGRESSION (the verdict's finding): the user switches back
    // to a LOCAL session — the attribute comes off in the same frame the
    // panel reads — and the very next clue load must reach the local plugin
    // immediately, not inherit the backend report's 1 s lag. Flip the probe
    // and fire the identical request.
    remote = false
    const local = await host.fetch('/sidebar/api/clues.list', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'ws-1' }),
    })
    assert.equal(local.status, 200, 'the same call passes through the instant the session is local')
    assert.deepEqual(await local.json(), { ok: true, value: { local: true } })
    assert.equal(originalCalls.length, 1, 'it reached the network exactly once')
    assert.equal(originalCalls[0], '/sidebar/api/clues.list')

    // …and switching TO remote re-engages the block at once (the reverse
    // race: a remote panel's clue call must not slip through a stale local
    // value either).
    remote = true
    const again = await host.fetch('/sidebar/api/clues.list', { method: 'POST', body: '{}' })
    assert.equal(again.status, 503)
    assert.equal(originalCalls.length, 1, 'no further network call')

    // Non-clue calls are never blocked even remotely — fs.tree rides the
    // adapter bridge in a remote session, so it must reach the network.
    const tree = await host.fetch('/sidebar/api/fs.tree', { method: 'POST', body: '{}' })
    assert.equal(tree.status, 200)
    assert.equal(originalCalls.length, 2)

    uninstall()
  } finally {
    setRemoteSessionProbeForTests(undefined)
  }
})

test('clue block: with no probe override and no document, nothing is blocked (host-role safety)', async () => {
  const { shouldBlockFetchCall } = await load()
  const { BETTER_SIDEBAR_CLUES_RULE } = await loadCluesRule()
  // The default probe answers false off-DOM (tests, workers, host tooling):
  // isRemote false means the decision never fires.
  assert.equal(shouldBlockFetchCall('/sidebar/api/clues.list', BASE, false, [BETTER_SIDEBAR_CLUES_RULE]), false)
})

test('clue annotate: a LOCAL session\'s clue calls carry the panel-session header when shouldAnnotateLocal allows it; remote and non-clue calls never do', async () => {
  const { installRemoteApiFetch, setRemoteSessionProbeForTests, PANEL_SESSION_HEADER } = await load()
  const { BETTER_SIDEBAR_CLUES_RULE } = await loadCluesRule()
  const originalCalls = []
  const original = async (input, init) => {
    originalCalls.push({ input, init })
    return { ok: true, url: String(input), status: 200, json: async () => ({ ok: true }) }
  }
  const host = { location: { href: BASE }, fetch: original }
  let remote = false
  setRemoteSessionProbeForTests(() => remote)
  try {
    const uninstall = installRemoteApiFetch(host, {
      blockRules: [BETTER_SIDEBAR_CLUES_RULE],
      shouldAnnotateLocal: () => true,
    })
    // Local session: the clue call passes through AND carries the
    // per-request truth the backend deny hook judges before its stale report.
    await host.fetch('/sidebar/api/clues.list', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'ws-1' }),
    })
    assert.equal(originalCalls.length, 1)
    const headers = originalCalls[0].init.headers
    assert.equal(headers[PANEL_SESSION_HEADER], 'local', 'the annotation rides the clue call')
    assert.equal(headers['content-type'], 'application/json', 'the original headers survive')

    // The share routes annotate too.
    await host.fetch('/sidebar/clues/share/export', { method: 'POST', body: '{}' })
    assert.equal(originalCalls[1].init.headers[PANEL_SESSION_HEADER], 'local')

    // Non-clue calls never carry it — fs.tree is session-scoped bridged
    // traffic, the adapter layer's business, not the panel hint's.
    await host.fetch('/sidebar/api/fs.tree', { method: 'POST', body: '{}' })
    assert.equal(originalCalls[2].init?.headers?.[PANEL_SESSION_HEADER], undefined, 'non-clue calls are never annotated')

    // Headers given as an array-of-tuples or a Headers-shaped object still
    // gain the annotation without losing their entries.
    await host.fetch('/sidebar/api/clues.list', {
      method: 'POST', headers: [['x-custom', 'yes']], body: '{}',
    })
    const arrHeaders = originalCalls[3].init.headers
    assert.equal(arrHeaders[PANEL_SESSION_HEADER], 'local')
    assert.equal(arrHeaders['x-custom'], 'yes', 'tuple-form entries survive')

    // Remote: the call is BLOCKED before the network — no annotation, no send.
    remote = true
    const blocked = await host.fetch('/sidebar/api/clues.list', { method: 'POST', body: '{}' })
    assert.equal(blocked.status, 503)
    assert.equal(originalCalls.length, 4, 'blocked remotely: nothing more reached the network')

    uninstall()
  } finally {
    setRemoteSessionProbeForTests(undefined)
  }
})

test('BS34-3: Request input with omitted init preserves Request.headers and adds panel-session header', async () => {
  const { installRemoteApiFetch, setRemoteSessionProbeForTests, PANEL_SESSION_HEADER } = await load()
  const { BETTER_SIDEBAR_CLUES_RULE } = await loadCluesRule()
  const originalCalls = []
  const host = {
    location: { href: 'http://127.0.0.1:3080/' },
    fetch: async (input, init) => {
      originalCalls.push({ input, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    },
  }
  setRemoteSessionProbeForTests(() => false)
  try {
    const uninstall = installRemoteApiFetch(host, {
      blockRules: [BETTER_SIDEBAR_CLUES_RULE],
      shouldAnnotateLocal: () => true,
    })
    const req = new Request('http://127.0.0.1:3080/sidebar/api/clues.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
    })
    await host.fetch(req)
    assert.equal(originalCalls.length, 1)
    const headers = originalCalls[0].init.headers
    assert.equal(headers['content-type'], 'application/json')
    assert.equal(headers['x-custom'], 'yes')
    assert.equal(headers[PANEL_SESSION_HEADER], 'local')
    uninstall()
  } finally {
    setRemoteSessionProbeForTests(undefined)
  }
})

test('BS34-3: case-variant panel-session header in init or Request is normalized and overwritten cleanly', async () => {
  const { annotatePanelHeader, PANEL_SESSION_HEADER } = await load()
  const fromInit = annotatePanelHeader('http://127.0.0.1:3080/sidebar/api/clues.list', {
    method: 'POST',
    headers: { 'X-Zen-Remote-Panel-Session': 'spoof', 'X-Custom': 'v1' },
  })
  const initHeaders = fromInit.headers
  assert.equal(Object.hasOwn(initHeaders, 'X-Zen-Remote-Panel-Session'), false)
  assert.deepEqual(
    Object.keys(initHeaders).filter((k) => k.toLowerCase() === PANEL_SESSION_HEADER),
    [PANEL_SESSION_HEADER],
  )
  assert.equal(initHeaders[PANEL_SESSION_HEADER], 'local')
  assert.equal(initHeaders['x-custom'], 'v1')

  const req = new Request('http://127.0.0.1:3080/sidebar/api/clues.list', {
    method: 'POST',
    headers: { 'X-Zen-Remote-Panel-Session': 'spoof', 'X-From-Req': 'yes' },
  })
  const fromReq = annotatePanelHeader(req, { headers: [['X-Custom', 'v2']] })
  assert.equal(fromReq.headers[PANEL_SESSION_HEADER], 'local')
  assert.equal(fromReq.headers['x-from-req'], 'yes')
  assert.equal(fromReq.headers['x-custom'], 'v2')
  assert.equal(Object.hasOwn(fromReq.headers, 'X-Zen-Remote-Panel-Session'), false)
})

test('BS34-3: shouldAnnotateLocal returning false (host role) passes local clue calls through with init untouched', async () => {
  const { installRemoteApiFetch, setRemoteSessionProbeForTests } = await load()
  const { BETTER_SIDEBAR_CLUES_RULE } = await loadCluesRule()
  const originalCalls = []
  const host = {
    location: { href: BASE },
    fetch: async (input, init) => {
      originalCalls.push({ input, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    },
  }
  setRemoteSessionProbeForTests(() => false)
  try {
    const uninstall = installRemoteApiFetch(host, {
      blockRules: [BETTER_SIDEBAR_CLUES_RULE],
      shouldAnnotateLocal: () => false,
    })
    const rawInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
    await host.fetch('/sidebar/api/clues.list', rawInit)
    await host.fetch('/sidebar/api/clues.list')
    assert.equal(originalCalls.length, 2)
    assert.equal(originalCalls[0].init, rawInit, 'init object passes through untouched')
    assert.equal(originalCalls[0].init.headers['x-zen-remote-panel-session'], undefined)
    assert.equal(originalCalls[1].init, undefined, 'omitted init stays undefined')
    uninstall()
  } finally {
    setRemoteSessionProbeForTests(undefined)
  }
})

test('BS34-3: reload adoption updates active options and final uninstall resets them cleanly', async () => {
  const { installRemoteApiFetch, setRemoteSessionProbeForTests, PANEL_SESSION_HEADER } = await load()
  const { BETTER_SIDEBAR_CLUES_RULE } = await loadCluesRule()
  const originalCalls = []
  const host = {
    location: { href: BASE },
    fetch: async (input, init) => {
      originalCalls.push({ input, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    },
  }
  setRemoteSessionProbeForTests(() => false)
  try {
    const disposeA = installRemoteApiFetch(host, {
      blockRules: [BETTER_SIDEBAR_CLUES_RULE],
      shouldAnnotateLocal: () => false,
    })
    // Generation B adopts the live wrapper with updated options before A disposes.
    const disposeB = installRemoteApiFetch(host, {
      blockRules: [BETTER_SIDEBAR_CLUES_RULE],
      shouldAnnotateLocal: () => true,
    })
    disposeA()
    await host.fetch('/sidebar/api/clues.list', { method: 'POST', body: '{}' })
    assert.equal(originalCalls.length, 1)
    assert.equal(originalCalls[0].init.headers[PANEL_SESSION_HEADER], 'local', 'adopted options from B are active')

    // Final uninstall cleans up options so a bare reinstall does not retain stale rules.
    disposeB()
    const disposeC = installRemoteApiFetch(host)
    await host.fetch('/sidebar/api/clues.list', { method: 'POST', body: '{}' })
    assert.equal(originalCalls[1].init.headers, undefined, 'stale options were cleared on final uninstall')
    disposeC()
  } finally {
    setRemoteSessionProbeForTests(undefined)
  }
})

