/**
 * PeerMux — 虚拟 HTTP-over-E2EE 多路复用（PG-8，tasks/peer-gateway/PG-8.md）。
 * 每个 engine 一个 {@link PeerMux}：对每个对端在**一套** ARQ 会话上跑多条
 * 双向流，并把普通 `fetch(url, init)` 的两端适配上去，让原生 `RelayClient`
 * 把远端 peer 的 `relayHandler` 当作一个 HTTP 源站访问。
 *
 * 路径无关（本模块的承重墙）：每个帧都从 `PeerArqSession` 的唯一 `sendFrame`
 * 接缝发出，而该接缝在**每次（重）发送时**读取会话的当前路径：
 *
 *   - `udp` — 打洞层的 `frameSenderFor`（帧用打洞握手的密码器封口；对端的
 *     punch 用同一套密码器开封后把明文交给 mux）；
 *   - `ws`  — mux 用「网关中转握手」的密码器自己封口，网关按 28B 明文头路由、
 *     永远看不到载荷明文。
 *
 * 1000ms 打洞失败（或之后的 `onDirectLost`）把路径切到 `ws`；UDP 随后打通时
 * 路径切回，在途 ARQ 分片直接沿新物理路径重传——流毫无察觉。物理路径重建、
 * 新握手尚未完成的瞬态里，底层发送可能未就绪：这里**捕获并丢弃该次发送**，
 * 由 ARQ 重传定时器在路径恢复后自动补发，绝不让同步抛错崩掉流。
 *
 * 网关中转握手沿用 UDP 路径的同一套已签名 `zr-punch-v1` hello/ack JSON，
 * 外面套 28B 路由头（`HELLO`，streamId 0，明文载荷）让网关能路由而无需解密。
 * DATA/SACK/ACK/RST/PING/PONG 永远走密封载荷——`(HELLO, streamId 0)` 形态因此
 * 无歧义。载荷不足 44B（网关中转的最小帧）时补零，接收侧剥掉。
 *
 * 流内协议（一条 ARQ 流内）：
 *
 *     发起方 → 应答方   分片 0：`{"t":"req","m":method,"p":path,"h":{…}}`
 *                       分片 1+：请求体原始字节，FIN 结束
 *     应答方 → 发起方   分片 0：`{"t":"res","s":status,"st":statusText,"h":{…}}`
 *                       分片 1+：响应体原始字节，FIN 结束
 *     任意一侧 RST 即中止该流（对端 req/res 被销毁）
 *
 * 两端都可能发起 fetch：nodeId 字典序较小的一方分配奇数 streamId，较大一方
 * 分配偶数，永不冲突。双向 FIN 或 RST 之后流表条目立即清理，不长期驻留。
 */

import { randomBytes } from 'node:crypto'
import { ServerResponse } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { Readable, Writable } from 'node:stream'

import { PeerArqSession } from './arq.js'
import {
  derivePeerSessionCiphers,
  generateEphemeralX25519,
  verifySelfCertifyingNodeId,
} from './crypto.js'
import type { PeerEphemeralKeyPair, PeerIdentityKeyPair, PeerSessionCiphers } from './crypto.js'
import { ed25519Sign, ed25519Verify, PUNCH_DOMAIN } from './punch.js'
import type { PunchFrameSender } from './punch.js'
import {
  decodeFrameHeader,
  encodeFrameHeader,
  packEncryptedFrame,
  PEER_FRAME_MAGIC,
  PEER_FRAME_VERSION,
  PeerFrameType,
  unpackEncryptedFrame,
} from './wire.js'
import type { PeerFrameHeader } from './wire.js'

const NODE_ID_PATTERN = /^[0-9a-f]{8}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
/** hello/ack envelope 的时间戳新鲜度窗口。 */
const ENVELOPE_TTL_MS = 30_000
/** 网关中转的最小帧长：28B 头 + 16B（AEAD tag 起步）。明文 envelope 也必须够长。 */
const GATEWAY_MIN_FRAME_BYTES = 44
/** WS hello envelope 的重发节奏（TCP 可靠，这里只兜握手竞态与迟到坐标）。 */
const HELLO_RETRY_MS = 400
const HELLO_RETRY_MAX = 6

/** 会话当前可用的物理路径。 */
export type PeerPath = 'none' | 'udp' | 'ws'

interface RequestMeta {
  m: string
  p: string
  h: Record<string, string>
}

interface ResponseMeta {
  status: number
  statusText: string
  headers: Record<string, string>
}

/** 一条双向流的全部本地状态（initiator 与 responder 两半共用一张表）。 */
interface MuxStream {
  streamId: number
  initiator: boolean
  /** 入站方向已解析元数据（fragment 0 已处理）。 */
  inboundMetaDone: boolean
  inboundFinished: boolean
  /** initiator 侧：响应元数据（fragment 0）已到达。 */
  responseResolved: boolean
  responseResolve: ((meta: ResponseMeta) => void) | null
  responseReject: ((err: Error) => void) | null
  bodyController: ReadableStreamDefaultController<Uint8Array> | null
  /** responder 侧：虚拟请求对象与捕获型响应。 */
  req: Readable | null
  res: ServerResponse | null
  /** 出站方向：响应元数据（fragment 0）是否已发出（responder）。 */
  resMetaSent: boolean
  /** 出站方向是否已 FIN（各自方向恰好一次）。 */
  outboundFinished: boolean
  /** 严格的出站写序（ARQ 顺序由同一链保证）。 */
  writeChain: Promise<void>
  /** ServerResponse 的原始捕获字节与增量 HTTP/1.1 解析状态。 */
  captureParts: Buffer[]
  captureHead: { status: number; statusText: string; headers: Record<string, string> } | null
  captureBody: Buffer
  captureChunkSize: number
  captureChunkState: 'idle' | 'size' | 'data' | 'trailer' | 'done'
}

interface MuxSession {
  nodeId: string
  peerPublicKeyHex: string
  peerName: string
  path: PeerPath
  /** 网关中转握手的密码器（该握手完成前为 null）。 */
  ciphers: PeerSessionCiphers | null
  myEph: PeerEphemeralKeyPair | null
  nonce: string | null
  peerEphPubHex: string | null
  /** WS 密封帧的 AEAD 序列——每会话一个计数器，永不回绕复用。 */
  seq: bigint
  /** 明文 envelope 头的序列（只需唯一）。 */
  envelopeSeq: bigint
  arq: PeerArqSession
  punchSender: PunchFrameSender | null
  streams: Map<number, MuxStream>
  /** 已被 RST 的流 id：其后迟到的 DATA 分片不得把流入站半边复活。 */
  deadStreams: Set<number>
  nextStreamId: number
  helloTimer: unknown
  helloTries: number
  closed: boolean
}

export interface PeerMuxOptions {
  networkId: string
  identity: PeerIdentityKeyPair
  /** 经网关 WS 中转发出一帧二进制（28B 头框架是 mux 的职责）；网关断链时为 null。 */
  sendGatewayBinary: ((bytes: Uint8Array) => void) | null
  /** 本机服务半边的 relayHandler；未挂载（无 webServer 的组合）时回答 undefined。 */
  relayHandler: () => ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  /** 每条入站虚拟请求都要盖上的本机标记密文（relayHandler 自己的门）。 */
  relaySecret: () => string
  clock?: MuxClock
  /** 会话有效路径变化时回调（engine 由此发 path-report）。 */
  onPathChanged?: (nodeId: string, path: PeerPath) => void
  log?: (line: string) => void
}

export interface MuxClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: MuxClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class PeerMux {
  private readonly options: PeerMuxOptions
  private readonly clock: MuxClock
  private readonly sessions = new Map<string, MuxSession>()
  private closed = false

  constructor(options: PeerMuxOptions) {
    this.options = options
    this.clock = options.clock ?? realClock
  }

  // ------------------------------------------------------------ 会话

  /** 为一个已通过 TOFU 的对端建立（或复用）mux 会话。 */
  ensureSession(nodeId: string, peerPublicKeyHex: string, peerName: string): void {
    const id = nodeId.toLowerCase()
    if (this.closed) return
    if (this.sessions.has(id)) return
    if (!NODE_ID_PATTERN.test(id)) throw new TypeError('nodeId must be 8 hex characters')
    if (!verifySelfCertifyingNodeId(id, peerPublicKeyHex)) {
      throw new TypeError('peerNodeId is not the self-certifying hash of peerPublicKeyHex')
    }
    const session: MuxSession = {
      nodeId: id,
      peerPublicKeyHex,
      peerName,
      path: 'none',
      ciphers: null,
      myEph: null,
      nonce: null,
      peerEphPubHex: null,
      seq: 0n,
      envelopeSeq: 0n,
      arq: new PeerArqSession({
        sendFrame: (frameType, streamId, payload, ack) => this.dispatchFrame(session, frameType, streamId, payload, ack),
        onStreamData: (streamId, chunk, final) => this.onStreamData(session, streamId, chunk, final),
        onStreamReset: (streamId) => this.onStreamReset(session, streamId),
      }),
      punchSender: null,
      streams: new Map(),
      deadStreams: new Set(),
      // 奇偶发起权：nodeId 字典序较小一方用奇数流 id，较大一方用偶数。
      nextStreamId: id < this.options.identity.nodeId ? 1 : 2,
      helloTimer: null,
      helloTries: 0,
      closed: false,
    }
    this.sessions.set(id, session)
  }

  /** 拆掉一个对端的会话（peer-left / mismatch / 本机禁用）：流中止、表清理。 */
  dropSession(nodeId: string): void {
    const session = this.sessions.get(nodeId.toLowerCase())
    if (!session) return
    this.clearHelloTimer(session)
    session.closed = true
    session.arq.closeAll()
    for (const stream of [...session.streams.values()]) {
      this.abortStream(session, stream, new Error('peer session closed'))
    }
    session.streams.clear()
    session.deadStreams.clear()
    this.sessions.delete(session.nodeId)
    if (session.path !== 'none') {
      session.path = 'none'
      this.options.onPathChanged?.(session.nodeId, 'none')
    }
  }

  hasSession(nodeId: string): boolean {
    return this.sessions.has(nodeId.toLowerCase())
  }

  sessionPath(nodeId: string): PeerPath {
    return this.sessions.get(nodeId.toLowerCase())?.path ?? 'none'
  }

  /** 存活会话 id（诊断用）。 */
  sessionIds(): string[] {
    return [...this.sessions.keys()]
  }

  /** 拆掉全部会话并拒绝所有在途交换（engine stop / 退网）。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const nodeId of [...this.sessions.keys()]) this.dropSession(nodeId)
  }

  // ------------------------------------------------------------ 路径与握手

  /**
   * 打洞窗口过期（或直连路径事后失效）：把 WS 中转路径备好——还没有中转
   * 密码器就现在跑网关中转握手；已有则直接把路径落在 `ws`。
   */
  enableRelayPath(nodeId: string): void {
    const session = this.sessions.get(nodeId.toLowerCase())
    if (!session || session.closed || this.closed) return
    if (session.ciphers !== null) {
      if (session.path !== 'ws') {
        session.path = 'ws'
        this.options.onPathChanged?.(session.nodeId, 'ws')
      }
      return
    }
    this.beginHello(session)
  }

  /** 打洞握手完成：接上打洞层的发送接缝，路径切到 UDP。 */
  setDirectPath(nodeId: string, sender: PunchFrameSender): void {
    const session = this.sessions.get(nodeId.toLowerCase())
    if (!session || session.closed || this.closed) return
    session.punchSender = sender
    const before = session.path
    session.path = 'udp'
    if (before !== 'udp') this.options.onPathChanged?.(session.nodeId, 'udp')
  }

  /** 直连路径死亡（keepalive 掉线）：帧改走网关 WS 中转。 */
  setRelayPath(nodeId: string): void {
    const session = this.sessions.get(nodeId.toLowerCase())
    if (!session || session.closed || this.closed) return
    const before = session.path
    session.path = session.ciphers !== null ? 'ws' : 'none'
    if (session.path === 'none') this.beginHello(session)
    if (before !== session.path) this.options.onPathChanged?.(session.nodeId, session.path)
  }

  // ------------------------------------------------------------ 帧入口

  /**
   * UDP 路径的一个**已开封**帧（punch 层用它自己的握手密码器开完才交进来）。
   * UDP 路径上的 hello/ack 由 punch 自己消化，永远到不了这里——这里只有
   * ARQ 层的帧。
   */
  handleOpenedFrame(header: PeerFrameHeader, plaintext: Uint8Array): void {
    const session = this.sessions.get(header.srcNodeId)
    if (!session || session.closed) return
    try {
      session.arq.handleFrame(header.frameType, header.streamId, plaintext, header.ack)
    } catch {
      // ARQ 内部的重发可能撞上未就绪路径（dispatchFrame 抛错）——RTO 定时器
      // 会重试，单帧丢失可恢复；绝不能让同步抛错穿回 punch 的事件层。
    }
  }

  /**
   * 网关 WS 中转的一个二进制帧。两种形态：
   *  - (HELLO, streamId 0)：明文 `zr-punch-v1` 控制信封——WS 中转握手的半边；
   *  - 其余：中转握手密码器密封的帧，在这里开封。
   */
  handleGatewayFrame(bytes: Uint8Array): void {
    const header = decodeFrameHeader(bytes)
    if (header === null) return
    const session = this.sessions.get(header.srcNodeId)
    if (!session || session.closed) return
    if (header.frameType === PeerFrameType.HELLO && header.streamId === 0) {
      this.handleEnvelope(session, bytes.subarray(28))
      return
    }
    if (session.ciphers === null) return
    const opened = unpackEncryptedFrame(bytes, session.ciphers)
    if (opened === null) return
    try {
      session.arq.handleFrame(opened.header.frameType, opened.header.streamId, opened.plaintext, opened.header.ack)
    } catch {
      // 同 handleOpenedFrame：重发撞上未就绪路径可由 RTO 恢复，不外抛。
    }
  }

  // ------------------------------------------------------------ fetch 适配

  /**
   * 出站虚拟 HTTP 适配：绑定一个对端的原生 `fetch(url, init)`。应答带
   * `ReadableStream` 体；`init.signal` 中止会对远端流发 RST。
   */
  createFetchForPeer(nodeId: string): typeof fetch {
    const id = nodeId.toLowerCase()
    return (url: string | URL | globalThis.Request, init?: VirtualFetchInit): Promise<Response> => {
      const session = this.sessions.get(id)
      if (!session || session.closed || this.closed) {
        return Promise.reject(new Error(`no peer mux session for ${id}`))
      }
      const urlString = url instanceof globalThis.Request ? url.url : String(url)
      let parsed: URL
      try {
        parsed = new URL(urlString)
      } catch {
        return Promise.reject(new Error(`peer mux fetch: malformed url ${urlString}`))
      }
      const pathWithQuery = `${parsed.pathname}${parsed.search}`
      const method = (init?.method ?? (url instanceof globalThis.Request ? url.method : 'GET') ?? 'GET').toUpperCase()
      const headers = flattenHeaders(init?.headers)
      const streamId = session.nextStreamId
      session.nextStreamId += 2

      const stream = newStream(streamId, true)
      session.streams.set(streamId, stream)

      let settled = false
      return new Promise<Response>((resolve, reject) => {
        stream.responseResolve = (meta) => {
          if (settled) return
          settled = true
          stream.responseResolved = true
          const resHeaders = new Headers()
          for (const [name, value] of Object.entries(meta.headers)) {
            // Response 自己管传输编码与长度；逐跳头不进适配层。
            if (name === 'transfer-encoding' || name === 'content-length' || name === 'connection' || name === 'keep-alive') continue
            resHeaders.set(name, value)
          }
          const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
              stream.bodyController = controller
            },
            cancel: () => {
              this.resetStream(session, stream)
            },
          })
          resolve(new Response(body, { status: meta.status, statusText: meta.statusText, headers: resHeaders }))
        }
        stream.responseReject = (err) => {
          if (settled) return
          settled = true
          reject(err)
        }

        const onAbort = (): void => {
          this.resetStream(session, stream)
          stream.responseReject?.(new Error('the caller aborted the request'))
          if (stream.bodyController !== null) {
            try { stream.bodyController.error(new Error('aborted')) } catch { /* already errored */ }
          }
        }
        const signal = init?.signal
        if (signal !== undefined && signal !== null) {
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }

        const run = async (): Promise<void> => {
          await this.writeArq(session, stream, Buffer.from(JSON.stringify({ t: 'req', m: method, p: pathWithQuery, h: headers }), 'utf8'))
          const body = init?.body ?? (url instanceof globalThis.Request ? url.body : null)
          if (body !== null && body !== undefined) {
            if (typeof body === 'string') {
              await this.writeArq(session, stream, Buffer.from(body, 'utf8'))
            } else if (body instanceof Uint8Array) {
              await this.writeArq(session, stream, body)
            } else if (body instanceof ArrayBuffer) {
              await this.writeArq(session, stream, new Uint8Array(body))
            } else if (typeof (body as ReadableStream).getReader === 'function') {
              const reader = (body as ReadableStream<Uint8Array>).getReader()
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                await this.writeArq(session, stream, value)
              }
            } else {
              const asText = await new Response(body as BodyInit).text()
              await this.writeArq(session, stream, Buffer.from(asText, 'utf8'))
            }
          }
          if (!stream.outboundFinished) {
            stream.outboundFinished = true
            const fin = stream.writeChain.then(() => session.arq.finish(streamId))
            stream.writeChain = fin.catch(() => {})
            await fin
          }
        }
        run().catch((err) => {
          this.resetStream(session, stream)
          stream.responseReject?.(err instanceof Error ? err : new Error(String(err)))
        })
      })
    }
  }

  // ------------------------------------------------------------ 内部

  /** 一次顺序 ARQ 写；路径未就绪的抛错在这里吞掉——ARQ 重传定时器补发。 */
  private writeArq(session: MuxSession, stream: MuxStream, bytes: Uint8Array): Promise<void> {
    const step = session.arq.write(stream.streamId, bytes).catch(() => {})
    stream.writeChain = stream.writeChain.then(() => step)
    return step
  }

  /**
   * ARQ 的 sendFrame 接缝：发送时读取当前路径。UDP → punch 层封口；WS →
   * mux 用中转握手密码器封口经网关发出；两者都未就绪 → 抛错（上层捕获丢弃）。
   */
  private dispatchFrame(
    session: MuxSession,
    frameType: number,
    streamId: number,
    payload: Uint8Array,
    ack: number,
  ): void {
    if (session.closed || this.closed) throw new Error('mux session closed')
    if (session.path === 'udp' && session.punchSender !== null) {
      session.punchSender(frameType, streamId, payload, ack)
      return
    }
    if (session.ciphers !== null) {
      const seq = session.seq
      session.seq = seq + 1n
      const frame = packEncryptedFrame(
        {
          frameType,
          srcNodeId: this.options.identity.nodeId,
          dstNodeId: session.nodeId,
          streamId,
          seq,
          ack,
        },
        payload,
        session.ciphers,
      )
      this.options.sendGatewayBinary?.(frame)
      return
    }
    throw new Error(`no path ready for peer ${session.nodeId}`)
  }

  // ---- 网关中转握手（zr-punch-v1 hello/ack 明文信封） -----------------

  private beginHello(session: MuxSession): void {
    if (session.closed || this.closed) return
    if (session.helloTimer !== null) return // 握手已在途
    if (session.ciphers !== null) return
    ensureMyEphemeral(session)
    session.helloTries = 0
    this.sendHelloEnvelope(session)
    const tick = (): void => {
      session.helloTimer = null
      if (session.closed || this.closed || session.ciphers !== null) return
      session.helloTries += 1
      if (session.helloTries > HELLO_RETRY_MAX) return // 下一次坐标/路径事件再武装
      this.sendHelloEnvelope(session)
      session.helloTimer = this.clock.setTimeout(tick, HELLO_RETRY_MS)
    }
    session.helloTimer = this.clock.setTimeout(tick, HELLO_RETRY_MS)
  }

  private clearHelloTimer(session: MuxSession): void {
    if (session.helloTimer !== null) {
      this.clock.clearTimeout(session.helloTimer)
      session.helloTimer = null
    }
  }

  /** `28B 头（HELLO, streamId 0）+ 签名 zr-punch-v1 hello JSON`，网关原样路由。 */
  private sendHelloEnvelope(session: MuxSession): void {
    const myEph = session.myEph
    const nonce = session.nonce
    if (myEph === null || nonce === null) return
    const timestamp = this.clock.now()
    const message = Buffer.from(
      `${PUNCH_DOMAIN}|hello|${this.options.networkId}|${this.options.identity.nodeId}|${myEph.publicKeyHex}|${nonce}|${timestamp}`,
      'utf8',
    )
    this.sendEnvelope(session, Buffer.from(JSON.stringify({
      zr: 1,
      kind: 'zr-hello',
      networkId: this.options.networkId,
      nodeId: this.options.identity.nodeId,
      publicKeyHex: this.options.identity.publicKeyHex,
      ephPubHex: myEph.publicKeyHex,
      nonce,
      timestamp,
      sigHex: ed25519Sign(message, this.options.identity),
    }), 'utf8'))
  }

  private sendHelloAckEnvelope(session: MuxSession, echoNonce: string): void {
    const myEph = session.myEph
    if (myEph === null) return
    const timestamp = this.clock.now()
    const message = Buffer.from(
      `${PUNCH_DOMAIN}|ack|${this.options.networkId}|${this.options.identity.nodeId}|${myEph.publicKeyHex}|${echoNonce}|${timestamp}`,
      'utf8',
    )
    this.sendEnvelope(session, Buffer.from(JSON.stringify({
      zr: 1,
      kind: 'zr-hello-ack',
      networkId: this.options.networkId,
      nodeId: this.options.identity.nodeId,
      publicKeyHex: this.options.identity.publicKeyHex,
      ephPubHex: myEph.publicKeyHex,
      nonce: echoNonce,
      timestamp,
      sigHex: ed25519Sign(message, this.options.identity),
    }), 'utf8'))
  }

  private sendEnvelope(session: MuxSession, payload: Buffer): void {
    const seq = session.envelopeSeq
    session.envelopeSeq = seq + 1n
    const header = encodeFrameHeader({
      magic: PEER_FRAME_MAGIC,
      version: PEER_FRAME_VERSION,
      frameType: PeerFrameType.HELLO,
      srcNodeId: this.options.identity.nodeId,
      dstNodeId: session.nodeId,
      streamId: 0,
      seq,
      ack: 0,
    })
    // 网关只路由不解密，但最小帧长必须满足（28+16）；不足补零，接收侧剥掉。
    const pad = Math.max(0, GATEWAY_MIN_FRAME_BYTES - header.length - payload.length)
    this.options.sendGatewayBinary?.(Buffer.concat([header, payload, Buffer.alloc(pad)]))
  }

  /** 一个入站 envelope（HELLO, streamId 0）：hello→应答+整合；ack→整合。 */
  private handleEnvelope(session: MuxSession, payloadBytes: Uint8Array): void {
    let parsed: Record<string, unknown>
    try {
      const text = Buffer.from(payloadBytes).toString('utf8').replace(/\x00+$/, '')
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    if (!parsed || parsed.zr !== 1) return
    const nodeId = typeof parsed.nodeId === 'string' ? parsed.nodeId.toLowerCase() : ''
    const publicKeyHex = typeof parsed.publicKeyHex === 'string' ? parsed.publicKeyHex : ''
    // 键锚定：信封必须来自我们会话锚定的那把钥。
    if (nodeId !== session.nodeId || !HEX64.test(publicKeyHex) || publicKeyHex !== session.peerPublicKeyHex) return
    if (parsed.networkId !== this.options.networkId) return
    const ephPubHex = typeof parsed.ephPubHex === 'string' ? parsed.ephPubHex : ''
    const nonce = typeof parsed.nonce === 'string' ? parsed.nonce : ''
    const timestamp = typeof parsed.timestamp === 'number' ? parsed.timestamp : 0
    const sigHex = typeof parsed.sigHex === 'string' ? parsed.sigHex : ''
    if (!HEX64.test(ephPubHex) || nonce === '' || !Number.isInteger(timestamp) || !HEX128.test(sigHex)) return
    if (Math.abs(this.clock.now() - timestamp) > ENVELOPE_TTL_MS) return

    if (parsed.kind === 'zr-hello') {
      const message = Buffer.from(
        `${PUNCH_DOMAIN}|hello|${this.options.networkId}|${nodeId}|${ephPubHex}|${nonce}|${timestamp}`,
        'utf8',
      )
      if (!ed25519Verify(message, publicKeyHex, sigHex)) return
      // 先应答——对端正等着 ack 完成握手。
      ensureMyEphemeral(session)
      this.sendHelloAckEnvelope(session, nonce)
      this.integratePeerEphemeral(session, ephPubHex)
      return
    }
    if (parsed.kind === 'zr-hello-ack') {
      // 回显 nonce 把 ack 绑定到我们在途的那一轮 hello。
      if (session.nonce === null || nonce !== session.nonce) return
      const message = Buffer.from(
        `${PUNCH_DOMAIN}|ack|${this.options.networkId}|${nodeId}|${ephPubHex}|${nonce}|${timestamp}`,
        'utf8',
      )
      if (!ed25519Verify(message, publicKeyHex, sigHex)) return
      this.integratePeerEphemeral(session, ephPubHex)
    }
  }

  /** 采用对端临时钥：每个新 (my, peer) 对只派生一次中转密码器。 */
  private integratePeerEphemeral(session: MuxSession, peerEphPubHex: string): void {
    if (session.closed) return
    if (session.peerEphPubHex === peerEphPubHex && session.ciphers !== null) return
    const myEph = session.myEph
    if (myEph === null) return // 不会发生：hello/ack 两侧都有各自的临时钥
    const ciphers = derivePeerSessionCiphers({
      networkId: this.options.networkId,
      myNodeId: this.options.identity.nodeId,
      peerNodeId: session.nodeId,
      myEphPrivateKeyHex: myEph.privateKeyHex,
      myEphPublicKeyHex: myEph.publicKeyHex,
      peerEphPublicKeyHex: peerEphPubHex,
    })
    session.peerEphPubHex = peerEphPubHex
    session.ciphers = ciphers
    this.clearHelloTimer(session)
    this.options.log?.(`mux: relay handshake complete for ${session.nodeId} (path=${session.path})`)
    if (session.path !== 'ws') {
      session.path = 'ws'
      this.options.onPathChanged?.(session.nodeId, 'ws')
    }
  }

  // ---- ARQ → 流 ------------------------------------------------------

  /** ARQ 顺序送达的一个入站分片（0 = 元数据，1+ = 体，fin = 结束）。 */
  private onStreamData(session: MuxSession, streamId: number, chunk: Uint8Array, final: boolean): void {
    const stream = session.streams.get(streamId)
    if (!stream) {
      if (session.deadStreams.has(streamId)) return // RST 之后迟到的分片不得复活流
      this.openInbound(session, streamId, chunk, final)
      return
    }
    this.onFragment(session, stream, chunk, final)
  }

  /** 单个入站分片的按向处理（ARQ 已保证顺序，无需重排缓冲）。 */
  private onFragment(session: MuxSession, stream: MuxStream, chunk: Uint8Array, final: boolean): void {
    if (stream.initiator) {
      // 应答方 → 发起方：分片 0 = 响应元数据，1+ = 响应体。
      if (!stream.inboundMetaDone) {
        stream.inboundMetaDone = true
        const meta = parseResponseMeta(chunk)
        if (meta === null) {
          this.abortStream(session, stream, new Error('malformed peer response metadata'))
          return
        }
        stream.responseResolve?.(meta)
        stream.responseResolve = null
      } else if (stream.bodyController !== null) {
        enqueueInto(stream.bodyController, chunk)
      }
      if (final) {
        stream.inboundFinished = true
        closeController(stream.bodyController)
        stream.bodyController = null
        session.streams.delete(stream.streamId)
      }
      return
    }
    // 发起方 → 应答方：分片 0 = 请求元数据，1+ = 请求体。
    if (!stream.inboundMetaDone) {
      stream.inboundMetaDone = true
      const meta = parseRequestMeta(chunk)
      if (meta === null) {
        this.resetStream(session, stream)
        session.deadStreams.add(stream.streamId)
        return
      }
      this.materializeInboundRequest(session, stream, meta)
    } else if (stream.req !== null) {
      stream.req.push(Buffer.from(chunk))
    }
    if (final && stream.req !== null && !stream.inboundFinished) {
      stream.inboundFinished = true
      stream.req.push(null) // 请求体完——relayHandler 的读体结束
    }
  }

  /** 对端对本流发了 RST：本地各件按「连接被切」销毁。 */
  private onStreamReset(session: MuxSession, streamId: number): void {
    session.deadStreams.add(streamId)
    const stream = session.streams.get(streamId)
    if (!stream) return
    this.abortStream(session, stream, new Error('stream reset by peer'))
  }

  /** 杀掉一条流的本地表面并从流表移除（双向 FIN/RST 后不留驻内存）。 */
  private abortStream(session: MuxSession, stream: MuxStream, err: Error): void {
    stream.responseReject?.(err)
    stream.responseReject = null
    if (stream.bodyController !== null) {
      try { stream.bodyController.error(err) } catch { /* already closed */ }
      stream.bodyController = null
    }
    if (stream.req !== null) {
      stream.req.destroy(err)
      stream.req = null
    }
    if (stream.res !== null) {
      try { stream.res.destroy() } catch { /* gone */ }
      stream.res = null
    }
    session.streams.delete(stream.streamId)
  }

  /** 向对端发 RST（本侧中止方向）。 */
  private resetStream(session: MuxSession, stream: MuxStream): void {
    session.deadStreams.add(stream.streamId)
    if (!session.closed) {
      try {
        session.arq.reset(stream.streamId)
      } catch {
        // 会话已不存在——无需通知对端。
      }
    }
    stream.responseResolve = null
    session.streams.delete(stream.streamId)
  }

  /** 对端发起了一条流：解析请求元数据并派发进本机 relayHandler。 */
  private openInbound(session: MuxSession, streamId: number, chunk: Uint8Array, final: boolean): void {
    const meta = parseRequestMeta(chunk)
    if (meta === null) {
      if (!session.closed) {
        try { session.arq.reset(streamId) } catch { /* 会话没了 */ }
      }
      session.deadStreams.add(streamId)
      return
    }
    const stream = newStream(streamId, false)
    // 首包元数据已在上面解析成 meta——置位后后续分片才走「请求体」分支，
    // 否则 body 分片会被误当元数据再次解析、resetStream 杀掉整条流。
    stream.inboundMetaDone = true
    session.streams.set(stream.streamId, stream)
    this.options.log?.(`mux: inbound request ${meta.m} ${meta.p} from ${session.nodeId} on stream ${streamId}`)
    this.materializeInboundRequest(session, stream, meta)
    if (final && stream.req !== null) {
      stream.inboundFinished = true
      stream.req.push(null)
    }
  }

  /** 构造虚拟 `req`/`res` 并直接调用本机 relayHandler。 */
  private materializeInboundRequest(
    session: MuxSession,
    stream: MuxStream,
    meta: RequestMeta,
  ): void {
    const req = new Readable({ read() {} })
    Object.assign(req, {
      method: meta.m,
      url: meta.p,
      httpVersion: '1.1',
      rawHeaders: [] as string[],
      // 密码学认证后的标记头（PG-8）：E2EE 会话本身就是认证——mux 盖上与网关
      // 标记等价的头，relayHandler 的密钥门照常应答。
      headers: {
        ...meta.h,
        'x-zen-remote-secret': this.options.relaySecret(),
        'x-zen-remote-via': 'gateway',
        'x-zen-remote-role': 'desktop-client',
        'x-zen-remote-device': `peer:${session.nodeId}`,
        'x-zen-remote-device-name': session.peerName,
      } as Record<string, string>,
    })
    const socket = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        stream.captureParts.push(Buffer.from(chunk))
        this.parseCapture(session, stream)
        cb()
      },
      // 响应被销毁（handler 死亡）时 'close' 必须能看到——relayHandler 的
      // 清理路径挂在 res 'close' 上，而 res 'close' 源自 socket 'close'。
      emitClose: true,
    })
    Object.assign(req, { socket, connection: socket })
    const res = new ServerResponse(req as never)
    res.assignSocket(socket as never)
    stream.req = req
    stream.res = res

    res.on('finish', () => {
      this.options.log?.(`mux: virtual response finished for ${session.nodeId} stream ${stream.streamId} (captured=${stream.captureParts.length} parts, head=${stream.captureHead !== null})`)
      // 状态行、头、体全部捕获完毕；解析器已把能发的都发了——补发残尾并 FIN。
      this.parseCapture(session, stream, true)
      this.finishResponse(session, stream)
    })
    res.on('close', () => {
      // 未完成即销毁（handler 死亡 / 行重载）：对端收 RST——finish 路径已 FIN 的除外。
      if (!stream.outboundFinished && session.streams.get(stream.streamId) === stream) {
        this.resetStream(session, stream)
      }
    })
    req.on('error', () => {
      if (!stream.outboundFinished && session.streams.get(stream.streamId) === stream) {
        this.resetStream(session, stream)
      }
    })

    req.on('end', () => this.options.log?.(`mux: inbound req body ended for ${session.nodeId} stream ${stream.streamId}`))
    req.on('error', (e) => this.options.log?.(`mux: inbound req error ${String(e)}`))
    const handler = this.options.relayHandler()
    if (handler === undefined) {
      // 服务半边未挂载（无 webServer 的组合）：如实应答并收尾。
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'relay-unavailable' } }))
      return
    }
    void handler(req as never, res).catch(() => {
      try {
        if (!res.writableEnded) res.destroy()
      } catch { /* gone */ }
    })
  }

  /** 对捕获的 ServerResponse 原始字节做增量 HTTP/1.1 响应解析。 */
  private parseCapture(session: MuxSession, stream: MuxStream, final = false): void {
    if (stream.captureParts.length === 0) return
    let buf = Buffer.concat(stream.captureParts)
    stream.captureParts = []
    if (stream.captureHead === null) {
      const headEnd = buf.indexOf('\r\n\r\n')
      if (headEnd === -1) {
        if (buf.length > 0) stream.captureParts.push(buf)
        return
      }
      const head = buf.subarray(0, headEnd).toString('utf8')
      const lines = head.split('\r\n')
      const statusLine = lines.shift() ?? ''
      const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine)
      if (match === null) {
        this.abortStream(session, stream, new Error('malformed virtual response head'))
        return
      }
      const headers: Record<string, string> = {}
      for (const line of lines) {
        const colon = line.indexOf(':')
        if (colon <= 0) continue
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      stream.captureHead = { status: Number(match[1]), statusText: match[2] ?? '', headers }
      buf = buf.subarray(headEnd + 4)
      // 元数据尽早出站：流式响应的头先走，体随后。
      this.writeResponseMetaAndBody(session, stream, Buffer.alloc(0), false)
    }
    stream.captureBody = Buffer.concat([stream.captureBody, buf])
    const contentLength = stream.captureHead.headers['content-length'] !== undefined
      ? Number(stream.captureHead.headers['content-length'])
      : null
    if (contentLength !== null && Number.isInteger(contentLength) && contentLength >= 0) {
      // 缓冲型路由：等齐 content-length 一次性发（体通常就是一段小 JSON）。
      if (stream.captureBody.length < contentLength) return
      const chunk = stream.captureBody.subarray(0, contentLength)
      stream.captureBody = Buffer.alloc(0)
      this.writeResponseMetaAndBody(session, stream, chunk, true)
      stream.captureChunkState = 'done'
      return
    }
    // Chunked：逐块增量解码（流式 NDJSON 路由）。
    for (;;) {
      if (stream.captureChunkState === 'idle' || stream.captureChunkState === 'size') {
        const idx = stream.captureBody.indexOf('\r\n')
        if (idx === -1) break
        const size = parseInt(stream.captureBody.subarray(0, idx).toString('utf8').split(';')[0], 16)
        stream.captureBody = stream.captureBody.subarray(idx + 2)
        if (!Number.isInteger(size) || Number.isNaN(size) || size < 0) {
          this.abortStream(session, stream, new Error('malformed chunked virtual response'))
          return
        }
        if (size === 0) {
          stream.captureChunkState = 'trailer'
          continue
        }
        stream.captureChunkSize = size
        stream.captureChunkState = 'data'
        continue
      }
      if (stream.captureChunkState === 'data') {
        if (stream.captureBody.length < stream.captureChunkSize + 2) break
        const chunk = stream.captureBody.subarray(0, stream.captureChunkSize)
        stream.captureBody = stream.captureBody.subarray(stream.captureChunkSize + 2) // 块 + CRLF
        this.writeResponseMetaAndBody(session, stream, chunk, false)
        stream.captureChunkState = 'size'
        continue
      }
      if (stream.captureChunkState === 'trailer') {
        // 零长度块已见：体完结（尾部头无论什么形态都不再关心）。
        this.writeResponseMetaAndBody(session, stream, Buffer.alloc(0), true)
        stream.captureChunkState = 'done'
        return
      }
      if (stream.captureChunkState === 'done') return
    }
    // finish 而无终止零块（理论不该发生）：仍照常收尾。字符串比较绕开
    // TS 在循环出口处的联合类型收窄（收窄后的状态本来就到不了 'done'）。
    if (final && (stream.captureChunkState as string) !== 'done') {
      this.writeResponseMetaAndBody(session, stream, Buffer.alloc(0), true)
    }
  }

  /** 响应元数据只发一次，其后是体分片，完结时 FIN。 */
  private writeResponseMetaAndBody(session: MuxSession, stream: MuxStream, chunk: Buffer, fin: boolean): void {
    if (session.closed || session.streams.get(stream.streamId) !== stream) return
    if (!stream.resMetaSent) {
      stream.resMetaSent = true
      const meta = stream.captureHead
      this.options.log?.(`mux: response meta → ${session.nodeId} stream ${stream.streamId} status=${meta?.status}`)
      const metaJson = Buffer.from(JSON.stringify({
        t: 'res',
        s: meta?.status ?? 200,
        st: meta?.statusText ?? '',
        h: meta?.headers ?? {},
      }), 'utf8')
      const step = session.arq
        .write(stream.streamId, metaJson)
        .then(() => (chunk.length > 0 ? session.arq.write(stream.streamId, chunk) : Promise.resolve()))
        .then(() => {
          if (fin && !stream.outboundFinished) {
            stream.outboundFinished = true
            return session.arq.finish(stream.streamId)
          }
          return undefined
        })
        .catch(() => {})
      stream.writeChain = stream.writeChain.then(() => step)
      return
    }
    if (chunk.length > 0) {
      const step = session.arq.write(stream.streamId, chunk).catch(() => {})
      stream.writeChain = stream.writeChain.then(() => step)
    }
    if (fin && !stream.outboundFinished) {
      stream.outboundFinished = true
      const step = stream.writeChain.then(() => session.arq.finish(stream.streamId)).catch(() => {})
      stream.writeChain = step
    }
  }

  /** res finish：补发残尾并 FIN（幂等，outboundFinished 守住）。 */
  private finishResponse(session: MuxSession, stream: MuxStream): void {
    if (session.streams.get(stream.streamId) !== stream) return
    if (stream.captureParts.length > 0) this.parseCapture(session, stream, true)
    if (!stream.outboundFinished) {
      stream.outboundFinished = true
      const step = stream.writeChain.then(() => session.arq.finish(stream.streamId)).catch(() => {})
      stream.writeChain = step
    }
  }
}

// -- 模块级形态 ---------------------------------------------------------------------------

function newStream(streamId: number, initiator: boolean): MuxStream {
  return {
    streamId,
    initiator,
    inboundMetaDone: false,
    inboundFinished: false,
    responseResolved: false,
    responseResolve: null,
    responseReject: null,
    bodyController: null,
    req: null,
    res: null,
    resMetaSent: false,
    outboundFinished: false,
    writeChain: Promise.resolve(),
    captureParts: [],
    captureHead: null,
    captureBody: Buffer.alloc(0),
    captureChunkSize: 0,
    captureChunkState: 'idle',
  }
}

/** 确保本侧已有网关中转握手用的临时钥（收到 hello 但尚未发起过的应答侧也要有）。 */
function ensureMyEphemeral(session: MuxSession): void {
  if (session.myEph === null) {
    session.myEph = generateEphemeralX25519()
    session.nonce = randomBytes(8).toString('hex')
  }
}

function flattenHeaders(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (init === undefined) return out
  if (Array.isArray(init)) {
    for (const [name, value] of init) out[name.toLowerCase()] = value
    return out
  }
  if (init instanceof Headers) {
    init.forEach((value, name) => { out[name.toLowerCase()] = value })
    return out
  }
  for (const [name, value] of Object.entries(init as Record<string, string>)) {
    out[name.toLowerCase()] = value
  }
  return out
}

function parseRequestMeta(bytes: Uint8Array): RequestMeta | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.t !== 'req') return null
    const m = record.m
    const p = record.p
    if (typeof m !== 'string' || typeof p !== 'string' || p === '' || !p.startsWith('/')) return null
    const headers: Record<string, string> = {}
    if (typeof record.h === 'object' && record.h !== null) {
      for (const [name, value] of Object.entries(record.h as Record<string, unknown>)) {
        if (typeof value === 'string') headers[name.toLowerCase()] = value
      }
    }
    return { m: m.toUpperCase(), p, h: headers }
  } catch {
    return null
  }
}

function parseResponseMeta(bytes: Uint8Array): ResponseMeta | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.t !== 'res') return null
    const status = record.s
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return null
    const headers: Record<string, string> = {}
    if (typeof record.h === 'object' && record.h !== null) {
      for (const [name, value] of Object.entries(record.h as Record<string, unknown>)) {
        if (typeof value === 'string') headers[name.toLowerCase()] = value
      }
    }
    return { status, statusText: typeof record.st === 'string' ? record.st : '', headers }
  } catch {
    return null
  }
}

function enqueueInto(controller: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array): void {
  try {
    controller.enqueue(new Uint8Array(bytes))
  } catch {
    // 消费方已取消——reset 路径负责收尾。
  }
}

function closeController(controller: ReadableStreamDefaultController<Uint8Array> | null): void {
  if (controller === null) return
  try {
    controller.close()
  } catch {
    // 已关闭或已出错。
  }
}

/** mux 的 fetch 入参里允许的 body 形态（BodyInit 的窄化）。 */
export interface VirtualFetchInit {
  method?: string
  headers?: HeadersInit
  body?: BodyInit | null
  signal?: AbortSignal | null
}
