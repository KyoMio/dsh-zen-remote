/**
 * 零依赖 RFC6455 WebSocket 客户端（PG-8）。基于 `node:http` / `node:https`
 * 的 `upgrade` 事件实现，只支持 engine 需要的最小面：
 *
 *   - 连接 `ws://` 与 `wss://` URL（Basic 路径 + 可选额外请求头）；
 *   - 发送文本与二进制帧（客户端帧必须掩码）；
 *   - 接收文本 / 二进制 / ping / close（含分片重组；服务端帧不掩码）；
 *   - 干净关闭（发 close 帧后等对端，超时强拆）。
 *
 * 为什么不用 `globalThis.WebSocket`（Node ≥21 自带）：它走 Node 的 undici
 * 全局 dispatcher，会被系统的 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量劫持——
 * peer 网关是局域网/自建地址，绝不该被代理；undici 代理失败还会把报错
 * 归结成玄学 `TypeError: fetch failed`。也不引第三方 `ws`（根包零依赖纪律）。
 * 这里 17p 量级的实现换来「任何 Node 18+、任何代理环境」下的确定性。
 */

import http from 'node:http'
import https from 'node:https'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 一个客户端帧头（payload ≤ 64KB 用 16 位长度；更大用 64 位）。 */
function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3]
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}

export type WsClientState = 'connecting' | 'open' | 'closed'

export interface WsClientEvents {
  open: []
  message: [data: Buffer, isBinary: boolean]
  close: [code: number, reason: string]
  error: [err: Error]
}

/**
 * 一个最小 WebSocket 连接。`send` 仅在 `open` 后合法；close 走 RFC6455
 * 关闭握手（1000ms 内对端不回应就强拆 TCP）。事件经 EventEmitter 派发
 * （`open` / `message` / `close` / `error`）。
 */
export class WsClient extends EventEmitter {
  readonly url: string
  state: WsClientState = 'connecting'

  private socket: import('node:stream').Duplex | null = null
  private parseBuf = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentOpcode = 0
  private closeSent = false
  private gotClose = false
  private closeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(url: string, headers: Record<string, string> = {}) {
    super()
    this.url = url
    const parsed = new URL(url)
    const secure = parsed.protocol === 'wss:'
    if (parsed.protocol !== 'ws:' && !secure) throw new TypeError(`ws client: unsupported protocol ${parsed.protocol}`)
    const port = parsed.port !== '' ? Number(parsed.port) : secure ? 443 : 80
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError(`ws client: bad port ${parsed.port}`)
    const key = randomBytes(16).toString('base64')
    const req = (secure ? https : http).request({
      host: parsed.hostname,
      port,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        host: `${parsed.hostname}:${port}`,
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
        ...headers,
      },
      // 桌面/局域网自签证书路径：引擎自己的 TLS 决策留给未来任务，这里
      // 与网关自托管最常见的形态对齐（本地测试网关不持有效证书）。
      ...(secure ? { rejectUnauthorized: false } : {}),
    })
    req.on('upgrade', (res, socket, head) => {
      const expect = createHash('sha1').update(`${key}${WS_MAGIC_GUID}`).digest('base64')
      if (res.headers.upgrade?.toLowerCase() !== 'websocket' || res.headers['sec-websocket-accept'] !== expect) {
        socket.destroy()
        this.fail(new Error('ws client: invalid upgrade response'))
        return
      }
      this.socket = socket
      socket.on('data', (chunk: Buffer) => this.onData(chunk))
      socket.on('error', (err: Error) => this.fail(err))
      socket.on('close', () => this.onSocketClosed())
      this.state = 'open'
      if (head.length > 0) this.onData(head)
      this.emit('open')
    })
    req.on('response', (res) => {
      // 非 101：网关（或反代）拒绝升级——读完错误体让 socket 收尾。
      res.resume()
      this.fail(new Error(`ws client: upgrade refused with status ${res.statusCode ?? '?'}`))
    })
    req.on('error', (err) => this.fail(err))
    req.end()
  }

  /** 文本或二进制消息：字符串发 TEXT 帧，字节发 BINARY 帧（引擎的控制面靠
   * 文本/二进制分流——发错帧型网关会把 auth 当中转载荷丢掉）。 */
  send(data: string | Uint8Array): void {
    if (this.state !== 'open' || this.socket === null) throw new Error('ws client: not open')
    if (typeof data === 'string') {
      this.socket.write(encodeClientFrame(0x1, Buffer.from(data, 'utf8')))
      return
    }
    this.socket.write(encodeClientFrame(0x2, Buffer.from(data)))
  }

  /** 发起关闭握手；对端 1000ms 内不回应即强拆。幂等。 */
  close(code = 1000, reason = ''): void {
    if (this.state === 'closed') return
    if (this.state === 'connecting') {
      try { this.socket?.destroy() } catch { /* not connected yet */ }
      this.state = 'closed'
      return
    }
    if (!this.closeSent) {
      this.closeSent = true
      const body = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'))
      body.writeUInt16BE(code, 0)
      body.write(reason, 2, 'utf8')
      try { this.socket?.write(encodeClientFrame(0x8, body)) } catch { /* dying anyway */ }
    }
    if (this.closeTimer === null) {
      this.closeTimer = setTimeout(() => {
        try { this.socket?.destroy() } catch { /* gone */ }
      }, 1000)
      this.closeTimer.unref?.()
    }
  }

  private onData(chunk: Buffer): void {
    this.parseBuf = Buffer.concat([this.parseBuf, chunk])
    for (;;) {
      if (this.parseBuf.length < 2) return
      const fin = (this.parseBuf[0] & 0x80) !== 0
      const opcode = this.parseBuf[0] & 0x0f
      const masked = (this.parseBuf[1] & 0x80) !== 0
      let len = this.parseBuf[1] & 0x7f
      let offset = 2
      if (len === 126) {
        if (this.parseBuf.length < 4) return
        len = this.parseBuf.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (this.parseBuf.length < 10) return
        const big = this.parseBuf.readBigUInt64BE(2)
        if (big > BigInt(64 * 1024 * 1024)) {
          this.fail(new Error('ws client: frame exceeds 64MiB'))
          return
        }
        len = Number(big)
        offset = 10
      }
      const maskLen = masked ? 4 : 0
      if (this.parseBuf.length < offset + maskLen + len) return
      const payload = Buffer.from(this.parseBuf.subarray(offset + maskLen, offset + maskLen + len))
      if (masked) {
        const maskKey = this.parseBuf.subarray(offset, offset + 4)
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]
      }
      this.parseBuf = this.parseBuf.subarray(offset + maskLen + len)
      this.onFrame(fin, opcode, payload)
    }
  }

  private onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      // close：读出码与原因，回 close 帧，收尾。
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
      this.gotClose = true
      if (!this.closeSent) {
        this.closeSent = true
        try { this.socket?.write(encodeClientFrame(0x8, Buffer.alloc(0))) } catch { /* dying */ }
      }
      this.finish(code, reason)
      return
    }
    if (opcode === 0x9) {
      // ping → pong（回显载荷）。
      try { this.socket?.write(encodeClientFrame(0xa, payload)) } catch { /* dying */ }
      return
    }
    if (opcode === 0xa) return // pong：无保活时钟，忽略即可
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) {
        this.deliver(opcode, payload)
        return
      }
      this.fragmentOpcode = opcode
      this.fragments = [payload]
      return
    }
    if (opcode === 0x0) {
      // continuation：并入当前分片流。
      this.fragments.push(payload)
      if (fin) {
        const whole = Buffer.concat(this.fragments)
        const kind = this.fragmentOpcode
        this.fragments = []
        this.fragmentOpcode = 0
        this.deliver(kind, whole)
      }
    }
  }

  private deliver(opcode: number, payload: Buffer): void {
    if (this.state !== 'open') return
    this.emit('message', payload, opcode === 0x2)
  }

  private onSocketClosed(): void {
    if (this.state === 'closed') return
    this.finish(this.gotClose ? 1000 : 1006, '')
  }

  private fail(err: Error): void {
    if (this.state === 'closed') return
    this.emit('error', err)
    try { this.socket?.destroy() } catch { /* gone */ }
    this.finish(1006, '')
  }

  private finish(code: number, reason: string): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    try { this.socket?.destroy() } catch { /* gone */ }
    this.socket = null
    this.emit('close', code, reason)
  }
}
