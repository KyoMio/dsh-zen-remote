/* dsh-zen-remote · T17b/T17b-fix gateway EADDRINUSE same-port retry
 *
 * A row reload (a settings save touching a restart-required field) asks the
 * OLD gateway child to exit and spawns the new one immediately — so the new
 * child's first listen attempt can hit EADDRINUSE against the port the dying
 * process has not released yet. The old first-error jump to port+1 stranded
 * the new child on a port nothing else targets (admin API and push kept
 * pointing at the configured port). This file boots the REAL gateway child
 * (test/util.cjs) against a placeholder that holds the configured port and
 * pins the contract: the gateway logs the same-port retry, keeps retrying
 * while the port stays busy, and after the port is freed ends up listening
 * exactly there — the log's final port is the configured one, and the
 * loopback admin API answers on it.
 *
 * T17b-fix: the port is NOT freed on a fixed timer — a slow machine could
 * take longer than the delay to reach the first listen attempt, the port
 * would already be free, and the retry path would never execute at all.
 * Instead the test waits for the gateway's own `port N busy, retrying` log
 * line (the observable proof the retry path ran) and only then frees the
 * port, so the scenario holds at any machine speed.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const net = require('node:net')
const { startGateway, request, stopAll } = require('./util.cjs')

const PORT = 39281
const TARGET_PORT = 39282

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await sleep(50)
  }
  assert.ok(fn(), message)
}

test('T17b: a port freed inside the retry window is rebound on the ORIGINAL port', async () => {
  // Hold the configured port, start the gateway behind it: the first listen
  // attempt must hit EADDRINUSE and enter the same-port retry loop.
  const blocker = net.createServer(() => {})
  await new Promise((resolve) => blocker.listen(PORT, '127.0.0.1', resolve))
  const gw = startGateway(PORT, TARGET_PORT)
  try {
    // Free the port only after the retry is OBSERVED: this line is the
    // gateway's own announcement that it is inside the retry loop (one line
    // per 200ms attempt), so the release cannot race the first attempt.
    await waitFor(
      () => gw.logs().includes(`port ${PORT} busy, retrying`),
      8000,
      'the gateway hit EADDRINUSE and logged the same-port retry, logs: ' + gw.logs(),
    )
    await new Promise((resolve) => blocker.close(resolve))

    // gw.ready resolves when "[lan-gate] listening" appears (4s cap; the
    // next retry is at most 200ms away).
    await gw.ready
    const logs = gw.logs()
    assert.ok(
      logs.includes(`port ${PORT} busy, retrying`),
      'the retry log line appeared, logs: ' + logs,
    )
    assert.ok(
      logs.includes('listening on 127.0.0.1:' + PORT),
      'the gateway ended up on the ORIGINAL port, logs: ' + logs,
    )
    assert.ok(
      !logs.includes('falling back to port'),
      'the retry window absorbed the wait; no port walk happened, logs: ' + logs,
    )
    // Not just in the log: the loopback admin API really answers there.
    const res = await request(PORT, { path: '/lan-gate/status' })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(JSON.parse(res.body).port, PORT)
  } finally {
    try { blocker.close(() => {}) } catch (e) {}
    await stopAll(null, gw.child)
  }
})
