'use strict'
// dsh-zen-remote · PG-9 启动自动恢复（PeerEngine.resumeFromState）的单元级用例。
//
// 不起真实网关：state 文件里已存 peerNetwork 记录的引擎，resumeFromState()
// 走与 joinNetwork 相同的序列（备打洞 socket + mux，再连网关 WS）；指向一个
// 必然拒绝的端口，让重连退避被注入的 clock 捕获——断言的是同步可见的事实
// （返回值、networkId、状态迁移与未入网时的拒绝），以及 stop() 的清理。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dgram = require('node:dgram')

const { ensurePeerIdentity, writePeerNetwork } = require('../lib/state-store.js')
const { createPeerEngine } = require('../lib/peer/engine.js')

const NETWORK_ID = '0123456789abcdef'

function fakePool() {
  return {
    mounted: [],
    maxServers: () => 8,
    mountVirtual(entry) {
      this.mounted.push(entry.entryId)
      return { displayName: entry.serverName }
    },
    unmountVirtual(entryId) {
      this.mounted = this.mounted.filter((id) => id !== entryId)
    },
  }
}

/** setTimeout 全部记进数组、绝不真触发：重连退避与 path-report 定时器都被
 * 测试握在手里，进程结束时没有悬挂的真实定时器。 */
function fakeClock() {
  const timers = []
  return {
    timers,
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const handle = { fn, ms }
      timers.push(handle)
      return handle
    },
    clearTimeout(handle) {
      const index = timers.indexOf(handle)
      if (index >= 0) timers.splice(index, 1)
    },
  }
}

function buildEngine(home, overrides = {}) {
  const stateFile = path.join(home, 'zen-remote-state.json')
  const socket = dgram.createSocket('udp4')
  socket.unref?.()
  const clock = fakeClock()
  const engine = createPeerEngine({
    stateFile,
    identity: ensurePeerIdentity(stateFile),
    relayPool: overrides.pool ?? fakePool(),
    relayHandler: () => undefined,
    relaySecret: () => 'secret',
    serverName: () => '测试机',
    udpSocket: socket,
    udpProbe: null,
    clock,
    log: overrides.log ?? (() => {}),
    ...(overrides.extra ?? {}),
  })
  return { engine, clock, socket, stateFile }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('resumeFromState: 未入网时回答 false 且什么也不启动', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-peer-resume-'))
  try {
    const { engine, clock } = buildEngine(home)
    assert.equal(engine.resumeFromState(), false)
    assert.equal(engine.status().gatewayState, 'unconfigured')
    assert.equal(engine.status().networkId, null)
    assert.deepEqual(clock.timers, [], 'no reconnect timer may arm without a network')
    engine.stop()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resumeFromState: 已入网记录按 join 序列连回，无需重新粘贴邀请链接', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-peer-resume-'))
  try {
    const { engine, clock, socket, stateFile } = buildEngine(home)
    writePeerNetwork(stateFile, {
      gatewayWsUrl: 'ws://127.0.0.1:9',
      gatewayHttpOrigin: 'http://127.0.0.1:9',
      networkId: NETWORK_ID,
      joinedAt: 1,
    })
    assert.equal(engine.resumeFromState(), true)
    // 同步可见：networkId 已恢复，状态正走向 connecting（connectWs 同步置位；
    // 对必拒端口的拨号随后失败 → offline，退避定时器被注入 clock 捕获）。
    assert.equal(engine.status().networkId, NETWORK_ID)
    await sleep(120)
    const state = engine.status().gatewayState
    assert.ok(state === 'connecting' || state === 'offline', `gatewayState advanced past unconfigured (got ${state})`)
    assert.ok(clock.timers.length > 0, 'the reconnect backoff armed through the injected clock')
    engine.stop()
    assert.ok(clock.timers.length === 0, 'stop() clears every armed timer')
    assert.ok(socket._handle === null || socket._handle === undefined, 'the injected socket was closed by stop()')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resumeFromState: stop 之后不再恢复', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-peer-resume-'))
  try {
    const { engine, stateFile } = buildEngine(home)
    writePeerNetwork(stateFile, {
      gatewayWsUrl: 'ws://127.0.0.1:9',
      gatewayHttpOrigin: 'http://127.0.0.1:9',
      networkId: NETWORK_ID,
      joinedAt: 1,
    })
    engine.stop()
    assert.equal(engine.resumeFromState(), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('joinNetwork: 自管 UDP socket 连续多次改链接重连或 leave 后再入网不会因关闭旧 socket 而挂死', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zen-remote-peer-rejoin-'))
  try {
    const stateFile = path.join(home, 'zen-remote-state.json')
    const clock = fakeClock()
    // 真实生产接线（src/index.ts）不传 udpSocket，由引擎自建自管
    const engine = createPeerEngine({
      stateFile,
      identity: ensurePeerIdentity(stateFile),
      relayPool: fakePool(),
      relayHandler: () => undefined,
      relaySecret: () => 'secret',
      serverName: () => '测试机',
      udpProbe: null,
      clock,
      log: () => {},
    })
    try {
      const withTimeout = (promise, label) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out (hung on closed punchSocket)`)), 1500).unref?.()),
      ])
      const first = await withTimeout(engine.joinNetwork('zr-net+insecure://127.0.0.1:9/0123456789abcdef#key-1'), 'first join')
      assert.deepEqual(first, { ok: true })
      assert.equal(engine.status().networkId, '0123456789abcdef')

      const second = await withTimeout(engine.joinNetwork('zr-net+insecure://127.0.0.1:9/fedcba9876543210#key-2'), 'second join after modifying link')
      assert.deepEqual(second, { ok: true })
      assert.equal(engine.status().networkId, 'fedcba9876543210')

      engine.leaveNetwork()
      await sleep(80)
      assert.equal(engine.status().gatewayState, 'unconfigured', 'stale ws close must not overwrite unconfigured after leaveNetwork')

      const third = await withTimeout(engine.joinNetwork('zr-net+insecure://127.0.0.1:9/1111222233334444#key-3'), 'third join after leave')
      assert.deepEqual(third, { ok: true })
      assert.equal(engine.status().networkId, '1111222233334444')
    } finally {
      engine.stop()
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
