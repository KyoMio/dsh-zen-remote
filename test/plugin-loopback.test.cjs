/* dsh-zen-remote · the plugin bridge's loopback executor (PB-3)
 *
 * Drives the BUILT lib/plugin-loopback.js against a local node:http fake
 * DSH — the shape the production loopback dials: `GET /?token=<good>`
 * answers 303 with a set-cookie (the gateway courier's dance, lib/
 * lan-gate-server.cjs attemptAuthExchange), and plugin routes demand that
 * cookie and a loopback Host. Covers every branch of the executor: the
 * first exchange, cookie reuse (no second exchange), the 401 → re-exchange
 * → retry ladder (exactly ONE extra exchange per staleness), a 401 after
 * the fresh cookie traveling VERBATIM, both `loopback-auth` failures (a
 * refused token / no token URL at all), the caller abort reaching the fake
 * server as a closed connection, and a chunked answer arriving in order.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createPluginLoopback, LoopbackAuthError } = require('../lib/plugin-loopback.js')

/**
 * The fake DSH. `validCookie` is READ LIVE per request, so a test can
 * rotate it mid-flight and make the executor's cached cookie stale. The
 * plugin routes record their hit facts (Host, cookie, raw query) and can
 * hold a chunked response open for the streaming/abort observables.
 */
function startFakeDsh({ token = 'token-good', initialCookie = 'dsh-auth=good', routeCookie } = {}) {
  const state = {
    validCookie: initialCookie,
    // The cookie the PLUGIN routes demand — defaults to the exchange's, but
    // a test can split them to build a 401 that survives a fresh exchange.
    routeCookie: routeCookie ?? initialCookie,
    tokenHits: 0,
    pluginHits: 0,
    aborted: false,
    lastQuery: '',
    lastHost: '',
    lastCookie: '',
  }
  let hold
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    if (url.pathname === '/') {
      state.tokenHits += 1
      if (url.searchParams.get('token') !== token) {
        // A wrong token: DSH answers the homepage (200), no cookie — the
        // exchange's honest failure shape.
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html>login</html>')
        return
      }
      res.writeHead(303, { 'set-cookie': `${state.validCookie}; Path=/; HttpOnly`, location: '/' })
      res.end()
      return
    }
    state.pluginHits += 1
    state.lastQuery = req.url ?? ''
    state.lastHost = String(req.headers.host ?? '')
    state.lastCookie = String(req.headers.cookie ?? '')
    if (state.lastCookie !== state.routeCookie) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end(`unauthorized (cookie: ${state.lastCookie})`)
      return
    }
    if (url.pathname === '/panel/hold') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('chunk-1\n')
      hold = { release: (line) => res.write(line), finish: () => res.end() }
      req.on('close', () => { state.aborted = true })
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, path: url.pathname, query: url.search }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        server,
        state,
        release: (line) => hold?.release(line),
        finish: () => hold?.finish(),
        stop: () => new Promise((done) => {
          // The loopback rides Node 19+'s keep-alive global agent: without
          // this the pooled sockets would hold server.close() open forever.
          server.closeAllConnections()
          server.close(done)
        }),
        target: () => ({ protocol: 'http:', port }),
        tokenUrl: () => `http://127.0.0.1:${port}/?token=${token}`,
      })
    })
  })
}

/** One buffered loopback GET (the streaming/abort tests drive `get` directly). */
async function bufferedGet(loopback, path, query) {
  const response = await loopback.get(path, query, {}, new AbortController().signal)
  const chunks = []
  for await (const chunk of response.stream) chunks.push(Buffer.from(chunk))
  return { ...response, body: Buffer.concat(chunks).toString('utf8') }
}

test('the first call exchanges the cookie once, and later calls reuse it', async () => {
  const dsh = await startFakeDsh()
  try {
    const loopback = createPluginLoopback({ getTarget: dsh.target, getTokenUrl: dsh.tokenUrl })
    const first = await bufferedGet(loopback, '/panel/data', 'sessionId=s1')
    assert.equal(first.status, 200)
    assert.deepEqual(JSON.parse(first.body), { ok: true, path: '/panel/data', query: '?sessionId=s1' })
    assert.equal(dsh.state.tokenHits, 1, 'exactly one exchange ran')
    assert.equal(dsh.state.lastCookie, 'dsh-auth=good', 'the exchanged cookie rode the plugin request')
    assert.equal(dsh.state.lastHost, `127.0.0.1:${dsh.target().port}`, 'the Host header is the loopback authority')

    // The cookie is kept: the next call goes straight to the plugin.
    const second = await bufferedGet(loopback, '/panel/data', 'sessionId=s2')
    assert.equal(second.status, 200)
    assert.equal(dsh.state.tokenHits, 1, 'no second exchange')
    assert.equal(dsh.state.pluginHits, 3, 'two hits from the first call (401 + 200), one from this one')
  } finally {
    await dsh.stop()
  }
})

test('a stale cookie triggers exactly ONE re-exchange and a retry', async () => {
  const dsh = await startFakeDsh()
  try {
    const loopback = createPluginLoopback({ getTarget: dsh.target, getTokenUrl: dsh.tokenUrl })
    assert.equal((await bufferedGet(loopback, '/panel/data', 'sessionId=s1')).status, 200)
    assert.equal(dsh.state.pluginHits, 2, 'the cold call hit the route twice: one 401, one 200')

    // The server rotates its signing cookie: the executor's copy is stale.
    dsh.state.validCookie = 'dsh-auth=rotated'
    dsh.state.routeCookie = 'dsh-auth=rotated'
    const retry = await bufferedGet(loopback, '/panel/data', 'sessionId=s1')
    assert.equal(retry.status, 200, 'the 401 → re-exchange → retry ladder ends in success')
    assert.equal(dsh.state.tokenHits, 2, 'exactly one extra exchange per staleness')
    assert.equal(dsh.state.pluginHits, 4, 'the stale call was a second cold call: one 401, one 200')

    // And the freshly exchanged cookie is reused again without a third hit.
    assert.equal((await bufferedGet(loopback, '/panel/data', 'sessionId=s1')).status, 200)
    assert.equal(dsh.state.tokenHits, 2)
    assert.equal(dsh.state.pluginHits, 5)
  } finally {
    await dsh.stop()
  }
})

test('a 401 that survives the fresh cookie is returned verbatim, never an error', async () => {
  // The exchange hands out cookie A while the PLUGIN route demands cookie B:
  // the retry's 401 is the plugin's own answer and must travel untouched —
  // a resolved 401 with its body, never a thrown error.
  const dsh = await startFakeDsh({ initialCookie: 'dsh-auth=a', routeCookie: 'dsh-auth=b' })
  try {
    const loopback = createPluginLoopback({ getTarget: dsh.target, getTokenUrl: dsh.tokenUrl })
    const response = await loopback.get('/panel/data', 'sessionId=s1', {}, new AbortController().signal)
    assert.equal(response.status, 401, 'the verbatim 401 status — a plugin answer, not a relay wall')
    assert.equal(dsh.state.tokenHits, 1, 'exactly one re-exchange ran for the first 401')
    const body = await new Promise((resolve) => {
      const chunks = []
      response.stream.on('data', (c) => chunks.push(Buffer.from(c)))
      response.stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    assert.match(body, /^unauthorized/, 'the verbatim 401 body')
  } finally {
    await dsh.stop()
  }
})

test('a failed exchange throws LoopbackAuthError: refused token, and no token URL at all', async () => {
  // The token the fake refuses: the exchange answers the homepage (200,
  // no cookie) — an honest exchange failure.
  const dsh = await startFakeDsh({ token: 'the-real-one' })
  try {
    const loopback = createPluginLoopback({
      getTarget: dsh.target,
      getTokenUrl: () => `${dsh.tokenUrl().split('?')[0]}?token=forged`,
    })
    await assert.rejects(
      () => loopback.get('/panel/data', 'sessionId=s1', {}, new AbortController().signal),
      (error) => error instanceof LoopbackAuthError,
      'a homepage answer (no cookie) is an exchange failure',
    )
    assert.equal(dsh.state.pluginHits, 1, 'the route was reached once (its 401), never retried after the failed exchange')

    // No token URL (a 0.1.1 host): the exchange cannot even start.
    const bare = createPluginLoopback({ getTarget: dsh.target, getTokenUrl: () => undefined })
    await assert.rejects(
      () => bare.get('/panel/data', 'sessionId=s1', {}, new AbortController().signal),
      (error) => error instanceof LoopbackAuthError,
    )
  } finally {
    await dsh.stop()
  }
})

test('a caller abort tears the loopback request down — the fake server sees the connection close', async () => {
  const dsh = await startFakeDsh()
  try {
    const loopback = createPluginLoopback({ getTarget: dsh.target, getTokenUrl: dsh.tokenUrl })
    const controller = new AbortController()
    // get() resolves once the plugin's response HEADERS arrive; the abort
    // has to reach the still-open body stream below.
    const response = await loopback.get('/panel/hold', 'sessionId=s1', {}, controller.signal)
    assert.equal(response.status, 200)
    assert.equal(dsh.state.pluginHits, 2, 'the route is mid-response (cold call: one 401, one held 200)')
    const streamDone = new Promise((resolve, reject) => {
      // The abort IS the expected ending: an ECONNRESET-flavored error or a
      // plain close both mean the loopback stream died with the caller.
      response.stream.on('error', () => resolve())
      response.stream.on('close', resolve)
      response.stream.on('end', resolve)
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    await streamDone
    // The abort must cross the socket: the fake's request 'close' fires.
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(dsh.state.aborted, true, 'the fake server saw its connection close')
    dsh.finish() // release the held response so server.close() can complete
  } finally {
    await dsh.stop()
  }
})

test('a chunked plugin answer streams in order with its whitelisted headers', async () => {
  const dsh = await startFakeDsh()
  try {
    const loopback = createPluginLoopback({ getTarget: dsh.target, getTokenUrl: dsh.tokenUrl })
    const response = await loopback.get('/panel/hold', 'sessionId=s1', {}, new AbortController().signal)
    assert.equal(response.status, 200)
    assert.equal(response.contentType, 'application/x-ndjson')
    const seen = []
    const done = new Promise((resolve) => {
      response.stream.on('data', (chunk) => seen.push(chunk.toString('utf8')))
      response.stream.on('end', resolve)
    })
    dsh.release('chunk-2\n')
    dsh.release('chunk-3\n')
    dsh.finish()
    await done
    assert.deepEqual(seen, ['chunk-1\n', 'chunk-2\n', 'chunk-3\n'], 'the chunks arrive in wire order')
  } finally {
    await dsh.stop()
  }
})
