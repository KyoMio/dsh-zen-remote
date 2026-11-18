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
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { startGateway, startGatewayAt, request, stopAll, freePort } = require('./util.cjs')

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
  // T31-fix: system-assigned so parallel test-run copies cannot collide. The
  // blocker grabs a genuinely free port (the one the gateway must end up on);
  // the upstream port is never dialled by this test, it just needs a number.
  const PORT = await freePort()
  const TARGET_PORT = await freePort()
  // Hold the configured port, start the gateway behind it: the first listen
  // attempt must hit EADDRINUSE and enter the same-port retry loop.
  const blocker = net.createServer(() => {})
  await new Promise((resolve, reject) => { blocker.on('error', reject); blocker.listen(PORT, '127.0.0.1', resolve) })
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

test('T9: gateway writes bound listening port to lan-gate-runtime.json and removes it on clean shutdown', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-runtime-port-'))
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch (e) {} })
  const dummyTarget = net.createServer(() => {})
  await new Promise((resolve) => dummyTarget.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => dummyTarget.close(resolve)))
  const targetPort = dummyTarget.address().port
  const gw = startGatewayAt(home, 0, targetPort)
  try {
    const boundPort = await gw.ready
    assert.ok(boundPort > 0)
    const runtimeFile = path.join(home, 'lan-gate-runtime.json')
    assert.strictEqual(fs.existsSync(runtimeFile), true, 'gateway must write lan-gate-runtime.json with actual bound port')
    const meta = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'))
    assert.strictEqual(meta.port, boundPort)
    assert.strictEqual(meta.pid, gw.child.pid)
    assert.strictEqual(fs.statSync(runtimeFile).mode & 0o777, 0o600)
  } finally {
    await stopAll(null, gw.child)
  }
})
