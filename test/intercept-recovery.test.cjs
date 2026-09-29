/* dsh-zen-remote · CP4 recovery: the merged global streams reopen on their own
 *
 * Drives the REAL createRelayClient (real HTTP, real NDJSON pump, real
 * reconnect ladder on an injected clock) against a fake relay server, through
 * the REAL installIntercept, and proves the fix for the frozen-group bug: a
 * remote leg that ends while the relay still reads `online` — the server's
 * `error{server-restart}` line, a clean `{type:'end'}`, a 429
 * `too-many-streams` — reopens within the backoff delay instead of parking on
 * `waitOnline` forever (nothing would ever fire it). The server-restart line
 * additionally marks the client offline AT ONCE, so the group annotates
 * （离线） and the reconnect ladder's fresh handshake restores the name.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { installIntercept } = require('../lib/intercept.js')
const { createRelayClient } = require('../lib/relay-client.js')

const SERVER_ID = '5e5a5a5a'
const RW = { workspaceId: 'w-1', path: '/srv/w1', title: '远端一', sessionIds: ['s1'], createdAt: '2026', updatedAt: '2026' }
const REMOTE_BASELINE_FRAME = { type: 'baseline', value: { items: [RW], archivedSessionIds: [], pinnedSessionIds: [] } }
const LOCAL_BASELINE = { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }

/** A manual clock for the ladder AND the reopen backoff: `advance` moves time
 * and fires due timers synchronously; `random` is pinned so the ladder's
 * jitter math is exact. */
function fakeClock() {
  let now = 1_700_000_000_000
  let rng = 0
  const timers = []
  return {
    now: () => now,
    random: () => rng,
    setTimeout(fn, ms) {
      const timer = { fn, at: now + ms }
      timers.push(timer)
      return timer
    },
    clearTimeout(timer) {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
    },
    advance(ms) {
      now += ms
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)
      for (const timer of due) {
        const index = timers.indexOf(timer)
        if (index >= 0) {
          timers.splice(index, 1)
          timer.fn()
        }
      }
    },
    get pending() { return timers.length },
  }
}

/** A fake relay server: the handshake answers `ok` (unless a 502 is wanted),
 * every stream open is recorded as a `{ write, end }` NDJSON gate the test
 * drives, and a scripted refusal answers the NEXT stream open once. */
function createRelayServer() {
  const state = { handshakeOk: true, firstStreamRefusal: null, streams: [] }
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      if (req.url.endsWith('/handshake')) {
        if (!state.handshakeOk) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false })); return }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, relayProtocol: 1, serverId: SERVER_ID, serverName: '主服务端', dshVersion: '0.2.0', fingerprints: {} }))
        return
      }
      if (req.url.endsWith('/stream')) {
        if (state.firstStreamRefusal !== null) {
          const refusal = state.firstStreamRefusal
          state.firstStreamRefusal = null
          res.writeHead(refusal.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(refusal.body))
          return
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        const stream = {
          closed: false,
          write: (object) => { res.write(JSON.stringify(object) + '\n') },
          end: () => { res.end() },
        }
        res.on('close', () => { stream.closed = true })
        state.streams.push(stream)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: {} }))
    })
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        url: `http://127.0.0.1:${srv.address().port}`,
        stop: () => { srv.closeAllConnections?.(); return new Promise((r) => srv.close(r)) },
      })
    })
  })
}

/** One controllable local workspace stream for the fake gateway. */
function createLocalGate(signal) {
  const pending = []
  let wake = () => {}
  let finished = false
  const iterable = (async function* () {
    const onAbort = () => { finished = true; wake() }
    if (signal?.aborted) return
    signal?.addEventListener('abort', onAbort)
    try {
      while (true) {
        if (pending.length > 0) yield pending.shift()
        else if (finished) return
        else await new Promise((resolve) => { wake = resolve })
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  })()
  return {
    iterable,
    push: (frame) => { pending.push(frame); wake() },
    finish: () => { finished = true; wake() },
  }
}

/** Poll until the predicate holds, failing loudly. */
async function waitFor(predicate, ms = 4000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** One wired scenario: real relay client + real intercept + fake server +
 * manual clock, the merged workspace/follow consumer collecting frames, the
 * remote baseline already flowing. */
async function boot(t) {
  const relay = await createRelayServer()
  const clock = fakeClock()
  const client = createRelayClient({ getServerUrl: () => relay.url, getToken: () => 'token-1', clock })
  await client.connect()
  assert.equal(client.state, 'online')

  const localGate = createLocalGate(undefined)
  const gateway = {
    operatorPeer: () => ({ id: 'p' }),
    openWireStream: async function () { return localGate.iterable },
    wireTap: (endpoint, payload, uplink, peer, signal, control) => gateway.openWireStream(endpoint, payload, uplink, peer, control.signal, control),
  }
  const handle = installIntercept({
    raw: gateway,
    relay: client,
    getServerId: () => client.handshakeInfo?.serverId,
    clock,
  })
  t.after(() => { handle.uninstall(); client.stop(); return relay.stop() })

  const merged = await gateway.wireTap('workspace/follow', { args: {} }, undefined, gateway.operatorPeer(), undefined, { signal: undefined })
  const frames = []
  const done = (async () => {
    try { for await (const frame of merged) frames.push(frame) } catch { frames.push({ terminal: true }) }
  })()
  // The local baseline opens the merged stream (the UI's own stream is the
  // base); the pump then dials the relay's filtered stream on its own.
  localGate.push(LOCAL_BASELINE)
  await waitFor(() => frames.length >= 1)
  await waitFor(() => relay.state.streams.length === 1)
  relay.state.streams[0].write({ type: 'frame', frame: REMOTE_BASELINE_FRAME })
  // upsert + order + archived + pinned fold in after the local baseline.
  await waitFor(() => frames.length >= 5)
  return { relay, clock, client, handle, frames, gateway, localGate, done }
}

test('CP4: the server-restart error line marks the client offline at once and the merged stream reopens after the reconnect', async (t) => {
  const { relay, clock, client, frames } = await boot(t)

  // The server app exits cleanly: every NDJSON stream gets the restart line.
  relay.state.streams[0].write({ type: 'error', error: { code: 'server-restart' } })
  relay.state.streams[0].end()
  // IMMEDIATELY offline — before any ladder tick, the state is the restart's
  // verdict (this is what flips the group's （离线） annotation).
  await waitFor(() => client.state === 'offline')
  assert.equal(client.lastError, 'offline')
  assert.equal(client.nextRetryAt, clock.now() + 1000, 'the reconnect ladder armed its first step')
  await waitFor(() => frames.some((frame) => frame.workspace?.title === '主服务端 · 远端一（离线）'))

  // The server is back: the ladder's first due attempt reconnects, the pump
  // wakes on the online transition and reopens the remote leg.
  clock.advance(1000)
  await waitFor(() => client.state === 'online')
  await waitFor(() => relay.state.streams.length === 2)
  relay.state.streams[1].write({ type: 'frame', frame: REMOTE_BASELINE_FRAME })
  await waitFor(() => frames.filter((frame) => frame.type === 'upsert' && frame.workspace?.title === '主服务端 · 远端一').length >= 2)
  assert.equal(frames.some((frame) => frame.terminal), false, 'the consumer never saw an error')
})

test('CP4: a clean stream end while still online reopens after the backoff delay — 1s, doubling empty spins, reset by a served frame', async (t) => {
  const { relay, clock, client, frames } = await boot(t)
  assert.equal(client.state, 'online')

  // First end: {type:'end'} on the wire — the state never moves, so nothing
  // but the backoff can wake the pump. The pump walks real socket I/O before
  // it arms the backoff timer, so every wait below lets the arming land
  // BEFORE advancing the fake clock.
  relay.state.streams[0].write({ type: 'end' })
  relay.state.streams[0].end()
  assert.equal(client.state, 'online')
  // The first spin waits 1s.
  await waitFor(() => clock.pending === 1)
  clock.advance(500)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(relay.state.streams.length, 1, 'no reopen before the delay')
  clock.advance(500)
  await waitFor(() => relay.state.streams.length === 2)

  // Second EMPTY spin (the reopened leg served nothing): the delay doubles
  // to 2s — 1s of advance must not reopen, the next second does.
  relay.state.streams[1].write({ type: 'end' })
  relay.state.streams[1].end()
  await waitFor(() => clock.pending === 1)
  clock.advance(1000)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(relay.state.streams.length, 2, 'the doubled delay is still running')
  clock.advance(1000)
  await waitFor(() => relay.state.streams.length === 3)

  // A stream that SERVED a frame proves the route works: the delay resets,
  // and the next end reopens after 1s again.
  relay.state.streams[2].write({ type: 'frame', frame: { type: 'upsert', workspace: { ...RW, title: '刷新' } } })
  await waitFor(() => frames.some((frame) => frame.workspace?.title === '主服务端 · 刷新'))
  relay.state.streams[2].write({ type: 'end' })
  relay.state.streams[2].end()
  await waitFor(() => clock.pending === 1)
  clock.advance(1000)
  await waitFor(() => relay.state.streams.length === 4, 4000)
  assert.equal(client.state, 'online', 'the state never left online through any of it')
  assert.equal(frames.some((frame) => frame.terminal), false)
})

test('CP4: a 429 too-many-streams refusal keeps the state online and the stream reopens within the delay', async (t) => {
  const { relay, clock, client, handle, frames } = await boot(t)

  // The next stream open is refused once. Kill the current leg cleanly (a
  // plain end — the state must stay online for this scenario).
  relay.state.firstStreamRefusal = { status: 429, body: { ok: false, error: { code: 'too-many-streams' } } }
  relay.state.streams[0].write({ type: 'end' })
  relay.state.streams[0].end()
  await waitFor(() => clock.pending === 1)
  clock.advance(1000)
  // The reopen attempt draws the 429: an ANSWER about the call, the state is
  // untouched, the ring records it, and the pump waits out the doubled delay.
  await waitFor(() => handle.diagnostics().recentFailures.at(-1)?.code === 'too-many-streams')
  assert.equal(client.state, 'online')
  await waitFor(() => clock.pending === 1)
  clock.advance(2000)
  await waitFor(() => relay.state.streams.length === 2, 4000)
  relay.state.streams[1].write({ type: 'frame', frame: { type: 'upsert', workspace: { ...RW, title: '重开' } } })
  await waitFor(() => frames.some((frame) => frame.workspace?.title === '主服务端 · 重开'), 4000)
  assert.equal(frames.some((frame) => frame.terminal), false, 'the 429 never reached the UI as an error')
})
