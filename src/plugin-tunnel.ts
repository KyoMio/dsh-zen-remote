/**
 * The plugin bridge's WebSocket byte tunnel (PB-10), server half. Per
 * docs/adr/0002 the relay NEVER speaks WebSocket: a bridged upgrade route is
 * carried as ONE NDJSON streaming response (server → client bytes) plus
 * ordinary POSTs per chunk (client → server bytes), both ends treating the
 * payload as OPAQUE BYTES — the WebSocket handshake and every frame are
 * produced by the real plugin route on the server machine and arrive at the
 * browser untouched.
 *
 * Open: `POST relay/v1/plugin-tunnel/open` — the same coordinate headers and
 * the SAME validation chain as `v1/plugin` (shared {@link validatePluginCall};
 * the route must additionally be declared `upgrade: true`), plus a small
 * JSON body carrying exactly the four `sec-websocket-*` headers and the
 * optional early head bytes. On success the relay dials the local web server
 * itself (net/tls, loopback only), writes a hand-built upgrade request with
 * the operator's cookie, and pumps socket bytes downstream line by line.
 * Send/close: `POST relay/v1/plugin-tunnel/{send,close}` — ordered chunks
 * upstream (one in-flight per tunnel, sequence-gated) and idempotent
 * teardown.
 *
 * Every tunnel belongs to the device that opened it; another device's
 * send/close is 404. Budgets, heartbeats and the slow-reader discipline
 * mirror the routes this module sits beside.
 */

import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { pluginBridgeError, responseJson } from './http.js'
import { adapterPathMatches, adapterTailShapeViolation, locateAdapterIds, type NormalizedAdapterRoute } from './plugin-adapter-core.js'
import { routeLocatorOf, routeMaxBodyOf, routeMethodsOf, routePrefixOf, routeUpgradesOf } from './plugin-bridge.js'
import type { BridgeRegistry, NormalizedBridgeRoute, NormalizedDeclaration } from './plugin-bridge.js'
import type { PluginLoopback } from './plugin-loopback.js'

/** The shared validation verdict for the two plugin routes (PB-3, reused by
 * the tunnel open in PB-10): the whole chain from the coordinate headers to
 * the consent wall, minus each route's own extras (the method check for
 * `v1/plugin`, the upgrade mark here). First failure wins, in this order.
 * `bufferedBody` carries a json-body route's request bytes (PB-24: the share
 * check must read the located id, so the body is consumed by validating) —
 * the loopback sends THIS buffer, never a re-read of the request. */
export type PluginCallValidation =
  | { ok: true; declaration: NormalizedDeclaration; route: NormalizedBridgeRoute; params: URLSearchParams; sessionId: string; normalizedQuery: string; bufferedBody?: Buffer }
  | { ok: false; status: number; code: string }

/** The json-body locator's body reader (PB-24): the caller owns the request
 * stream — `v1/plugin` buffers it bounded by the route's `maxBody` (413 past
 * the cap, mirroring the adapter half's discipline), the tunnel open omits
 * the reader entirely (an open request is empty-bodied by contract). Since
 * PB-26b that open-phase gap is fine for an `upgrade: true` route — its ids
 * ride the LATER WebSocket text frames and the send gate share-checks each
 * one — while a NON-upgrade json-body route still refuses at open: nothing
 * would ever own its ids. */
export type PluginCallBodyReader = (maxBody: number) => Promise<
  | { kind: 'body'; buffered: Buffer; parsed?: unknown }
  | { kind: 'over' }
  | { kind: 'corrupt' }
>

/** The cooperative route through the adapter core's matcher (PB-23): the
 * path rule is ONE rule on both halves — {@link adapterPathMatches} decides,
 * fed the declaration route converted to its shape (exact by default;
 * `prefix: true` becomes the adapter's `match: 'prefix'`). A hand-copied
 * predicate here could drift from the adapter segment's rule; the conversion
 * cannot. Only `path` and `match` are actually read by the matcher. */
function asAdapterRoute(route: NormalizedBridgeRoute): NormalizedAdapterRoute {
  return {
    path: route.path,
    match: routePrefixOf(route) ? 'prefix' : 'exact',
    methods: routeMethodsOf(route),
    maxBody: routeMaxBodyOf(route),
    stream: route.stream,
    upgrade: routeUpgradesOf(route),
    locator: routeLocatorOf(route),
    local: false,
  }
}

/** Validate one plugin-bridge call's coordinates — the parse-once query
 * discipline (the re-serialization of THIS parse is the only string the
 * tunnel's upgrade request may carry), the share table with its ancestor
 * walk, and the live consent wall. `bridge.getConsent()` throwing reads as
 * unknown consent, and unknown consent stays home. The share wall reads the
 * route's EFFECTIVE locator (PB-24): the query convention — `sessionParam`
 * folded in by {@link routeLocatorOf} — keeps its exactly-once rule, while a
 * declaration-v2 locator re-locates over the SAME adapter-core rule the
 * sub-client classified with and share-checks EVERY hit; a json-body route's
 * body is consumed by validating (the reader above), and the verdict carries
 * the bytes for the loopback. */
export async function validatePluginCall(
  bridge: { registry: BridgeRegistry; getConsent: () => Record<string, boolean> },
  coords: { pluginName: string; pluginVersion: string; pluginDigest: string; routePath: string; rawQuery: string },
  isAccessible: (sessionId: string) => boolean,
  readJsonBody?: PluginCallBodyReader,
): Promise<PluginCallValidation> {
  const declaration = bridge.registry.get(coords.pluginName)
  if (declaration === undefined) return { ok: false, status: 404, code: 'plugin-unknown' }
  if (declaration.version !== coords.pluginVersion || declaration.digest !== coords.pluginDigest) {
    return { ok: false, status: 409, code: 'plugin-mismatch' }
  }
  // First hit in the declaration's (path-sorted) order wins. PB-23: an
  // exact-declared route matches equality alone; a `prefix: true` route also
  // admits every deeper RAW path (`x-zr-path` is matched undecoded, the
  // module-wide discipline) — the SAME rule the adapter segment applies, so
  // the sub-client's prefix forwarding (PB-21) is checked here against the
  // declaration instead of being trusted.
  const route = declaration.routes.find((candidate) => adapterPathMatches(asAdapterRoute(candidate), coords.routePath))
  if (route === undefined) return { ok: false, status: 404, code: 'route-undeclared' }
  // PB-23b: a prefix hit's variable tail carries the declaration-side shape
  // red lines itself (`?`, `#`, `..` — encoded forms included — and
  // whitespace; the shared rule, the adapter segment's too). 400
  // `bad-request`, the coordinate-shape code this chain already answers.
  if (adapterTailShapeViolation(asAdapterRoute(route), coords.routePath)) {
    return { ok: false, status: 400, code: 'bad-request' }
  }
  let params: URLSearchParams
  try {
    params = new URLSearchParams(coords.rawQuery)
  } catch {
    return { ok: false, status: 400, code: 'bad-query' }
  }
  const locator = routeLocatorOf(route)
  let sessionId: string
  let bufferedBody: Buffer | undefined
  if (locator.in === 'query') {
    const ids = params.getAll(locator.name)
    const queryId = ids.length === 1 ? ids[0] : undefined
    if (queryId === undefined || queryId === '') return { ok: false, status: 400, code: 'bad-query' }
    if (!isAccessible(queryId)) return { ok: false, status: 403, code: 'not-shared' }
    sessionId = queryId
  } else if (locator.in === 'json-body' && readJsonBody === undefined && routeUpgradesOf(route)) {
    // PB-26b: a json-body UPGRADE route's handshake is an empty-bodied GET —
    // the ids ride the JSON text frames the browser sends AFTER the
    // handshake, and the tunnel's send gate share-checks every one of those
    // frames ({@link frameShareVerdict}) before a byte reaches the plugin.
    // The open phase locates nothing and validates no body; the consent
    // wall below still applies, and the tunnel carries the route so the
    // gate can judge the frames.
    sessionId = ''
  } else {
    let parsedBody: unknown
    if (locator.in === 'json-body') {
      if (readJsonBody === undefined) return { ok: false, status: 400, code: 'bad-request' }
      const read = await readJsonBody(routeMaxBodyOf(route))
      if (read.kind === 'over') return { ok: false, status: 413, code: 'body-too-large' }
      if (read.kind === 'corrupt') return { ok: false, status: 400, code: 'bad-query' }
      bufferedBody = read.buffered
      parsedBody = read.parsed
    }
    const hits = locateAdapterIds(asAdapterRoute(route), coords.routePath, params, parsedBody)
    // The sub-client only forwards a classified-remote request, so a v2
    // locator call that locates NOTHING is malformed here — the adapter
    // half's rule verbatim.
    if (hits.length === 0) return { ok: false, status: 400, code: 'bad-request' }
    for (const hit of hits) {
      if (!isAccessible(hit.value)) return { ok: false, status: 403, code: 'not-shared' }
    }
    sessionId = hits[0].value
  }
  if (route.scope === 'server') {
    let consent: Record<string, boolean> = {}
    try {
      consent = bridge.getConsent()
    } catch {
      consent = {}
    }
    if (consent[coords.pluginName] !== true) return { ok: false, status: 403, code: 'consent-off' }
  }
  return { ok: true, declaration, route, params, sessionId, normalizedQuery: params.toString(), ...(bufferedBody !== undefined ? { bufferedBody } : {}) }
}

/** Largest single downstream data LINE (base64 will inflate by 4/3 — the cap
 * is on the RAW bytes carried, and the line stays well under typical proxy
 * line limits this way). */
export const TUNNEL_DOWN_CHUNK_BYTES = 48 * 1024

/** Largest upstream send chunk (the wire body of one `send`). */
export const TUNNEL_UP_CHUNK_BYTES = 64 * 1024

/** Concurrent tunnels per device. */
export const MAX_TUNNELS_PER_DEVICE = 8

// ---- PB-26b: the RFC 6455 frame gate for json-body upgrade routes -----------
//
// A `locator: { in: 'json-body' }` upgrade route carries its session ids in
// the JSON text frames the browser sends AFTER the handshake (the sidechat
// ws watch: `{"op":"watch","threadIds":[...]}`) — the handshake itself is an
// empty-bodied GET, so the open-phase share wall has nothing to judge. The
// gate lives on the SEND path instead: the sub-client's upstream chunks are
// split into frames, and every text frame is located + share-checked before
// a byte of it reaches the plugin. Query-locator upgrade routes never parse
// a frame — their bytes stay a 100% opaque stream (docs/adr/0002).

/** One RFC 6455 frame split off a byte stream. */
export interface Rfc6455Frame {
  opcode: number
  fin: boolean
  /** The payload with the client mask removed (both directions parse; the
   * mask belongs to client frames only and is undone here either way). */
  payload: Buffer
  /** The frame's complete wire bytes, mask included — the verbatim form a
   * validated frame is forwarded in. */
  raw: Buffer
}

/** The frame-size cap the gate parses (per frame, declared length): a
 * browser watch frame is a few KiB at most, and an unbounded declared
 * length would let a broken sender grow the parse buffer forever. */
export const MAX_GATE_FRAME_BYTES = 1024 * 1024

/** Split the COMPLETE frames at the front of `buffer` — client frames
 * (masked) and server frames (unmasked) alike. A partial frame at the tail
 * stays unconsumed for the next chunk; `violated` reports a frame whose
 * DECLARED length exceeds {@link MAX_GATE_FRAME_BYTES} (the caller refuses,
 * never waits for bytes that must not arrive). */
export function parseRfc6455Frames(buffer: Buffer): { frames: Rfc6455Frame[]; consumed: number; violated: boolean } {
  const frames: Rfc6455Frame[] = []
  let offset = 0
  while (true) {
    const remain = buffer.length - offset
    if (remain < 2) break
    const fin = (buffer[offset] & 0x80) !== 0
    const opcode = buffer[offset] & 0x0f
    const masked = (buffer[offset + 1] & 0x80) !== 0
    let length = buffer[offset + 1] & 0x7f
    let headerLength = 2
    if (length === 126) {
      if (remain < 4) break
      length = buffer.readUInt16BE(offset + 2)
      headerLength = 4
    } else if (length === 127) {
      if (remain < 10) break
      const declared = buffer.readBigUInt64BE(offset + 2)
      if (declared > BigInt(MAX_GATE_FRAME_BYTES)) return { frames, consumed: offset, violated: true }
      length = Number(declared)
      headerLength = 10
    }
    if (length > MAX_GATE_FRAME_BYTES) return { frames, consumed: offset, violated: true }
    const maskLength = masked ? 4 : 0
    if (remain < headerLength + maskLength + length) break
    const maskAt = offset + headerLength
    const payloadAt = maskAt + maskLength
    const end = payloadAt + length
    const payload = Buffer.from(buffer.subarray(payloadAt, end))
    if (masked) {
      const mask = buffer.subarray(maskAt, payloadAt)
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
    }
    frames.push({ opcode, fin, payload, raw: Buffer.from(buffer.subarray(offset, end)) })
    offset = end
  }
  return { frames, consumed: offset, violated: false }
}

/** Encode one RFC 6455 frame. `mask: true` produces the CLIENT side's
 * masked form (4 fresh random bytes, payload XORed) — the bytes the sub-
 * client forwards must look like the browser's own. `false` is the server
 * side's plain form (frames toward the browser). `fin` (default true) is
 * the frame's FIN bit — a fragmented frame keeps its fragmentation shape
 * when the gate re-frames it. */
export function encodeRfc6455Frame(opcode: number, payload: Buffer, mask: boolean, fin = true): Buffer {
  const firstByte = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  const maskBit = mask ? 0x80 : 0
  const length = payload.length
  let head: Buffer
  if (length < 126) {
    head = Buffer.from([firstByte, maskBit | length])
  } else if (length < 65536) {
    head = Buffer.alloc(4)
    head[0] = firstByte
    head[1] = maskBit | 126
    head.writeUInt16BE(length, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = firstByte
    head[1] = maskBit | 127
    head.writeBigUInt64BE(BigInt(length), 2)
  }
  if (!mask) return Buffer.concat([head, payload])
  const maskKey = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= maskKey[i % 4]
  return Buffer.concat([head, maskKey, masked])
}

/** The share-wall verdict of ONE client text frame (PB-26b): the frame's
 * JSON is located against the route's OWN locator and every hit is share-
 * checked — the same adapter-core rule the open phase runs for query and
 * body routes. Non-text frames (close/ping/pong/binary) carry no session
 * ids and pass. A frame that locates NOTHING (an empty `threadIds` array —
 * the unsubscribe-all — or a non-object JSON) is admitted: there is no id
 * to check. */
function frameShareVerdict(route: NormalizedBridgeRoute, frame: Rfc6455Frame, isAccessible: (sessionId: string) => boolean): { ok: true } | { ok: false; status: number; code: string } {
  if (frame.opcode !== 0x1) return { ok: true }
  let parsed: unknown
  try {
    parsed = JSON.parse(frame.payload.toString('utf8'))
  } catch {
    return { ok: false, status: 400, code: 'bad-request' }
  }
  let hits
  try {
    hits = locateAdapterIds(asAdapterRoute(route), route.path, new URLSearchParams(), parsed)
  } catch {
    return { ok: false, status: 400, code: 'bad-query' }
  }
  for (const hit of hits) {
    if (!isAccessible(hit.value)) return { ok: false, status: 403, code: 'not-shared' }
  }
  return { ok: true }
}

/** The four WebSocket headers the open body may carry, verbatim. */
const TUNNEL_CLIENT_HEADERS = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Header values must be plain strings — a CR/LF anywhere would inject into
 * the hand-built upgrade request. */
function cleanHeaderValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || /[\r\n]/.test(value)) return undefined
  return value
}

/** One live tunnel. */
interface Tunnel {
  device: string
  upstream: Socket
  /** The open request's NDJSON response — the downstream river. */
  res: ServerResponse
  /** The next upstream sequence the client must send. */
  expectedSeq: number
  heartbeat: ReturnType<typeof setInterval>
  /** PB-26b: the validated route — a json-body upgrade tunnel's send gate
   * reads its locator to judge every upstream text frame. */
  route: NormalizedBridgeRoute
  /** PB-26b: the upstream frame-parse buffer. PRESENT ONLY on a json-body
   * upgrade tunnel (the frame gate is enabled); a query-locator upgrade
   * stays `undefined` — its bytes pass through 100% opaque, zero parsing. */
  upFrameBuffer: Buffer | undefined
}

export interface CreatePluginTunnelOptions {
  bridge: { registry: BridgeRegistry; getConsent: () => Record<string, boolean>; loopback: PluginLoopback }
  /** The loopback web server bind, re-read per tunnel (same live discipline
   * as every target read in this plugin). */
  getTarget: () => { protocol: 'http:' | 'https:'; port: number }
  isAccessible: (sessionId: string) => boolean
  /** Heartbeat interval for the open stream (the ping lines). */
  heartbeatMs: number
}

export interface PluginTunnelRoutes {
  /** `POST relay/v1/plugin-tunnel/open`. */
  open(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** `POST relay/v1/plugin-tunnel/send`. */
  send(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** `POST relay/v1/plugin-tunnel/close`. */
  close(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** Live tunnel count (the settings diagnostics). */
  tunnelCount(): number
}

/** The tunnel table: id → the live entry. Every teardown path removes its
 * own entry exactly once. */
export function createPluginTunnel(options: CreatePluginTunnelOptions): PluginTunnelRoutes {
  const tunnels = new Map<string, Tunnel>()

  /** Teardown, idempotent: end line (when the downstream still wants one
   * and none was written), upstream destroyed, heartbeat cleared, entry
   * gone. */
  const teardown = (tunnel: Tunnel, id: string, reason: 'upstream-closed' | 'upstream-error' | 'client-closed' | null): void => {
    if (tunnels.get(id) !== tunnel) return
    tunnels.delete(id)
    clearInterval(tunnel.heartbeat)
    if (reason !== null && !tunnel.res.writableEnded && !tunnel.res.destroyed) {
      writeLine(tunnel.res, { type: 'end', reason })
    }
    try {
      tunnel.res.end()
    } catch {
      // Already gone.
    }
    try {
      tunnel.upstream.destroy()
    } catch {
      // Already gone.
    }
  }

  const writeLine = (res: ServerResponse, value: Record<string, unknown>): boolean => {
    if (res.destroyed || res.writableEnded) return false
    return res.write(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'))
  }

  const deviceOf = (req: IncomingMessage): string => {
    const raw = req.headers['x-zen-remote-device']
    const value = Array.isArray(raw) ? raw[0] : raw
    return typeof value === 'string' ? value : ''
  }

  /** One coordinate header of the open request. */
  const coordOf = (req: IncomingMessage, name: string): string | undefined => {
    const raw = req.headers[name]
    const value = Array.isArray(raw) ? raw[0] : raw
    return typeof value === 'string' ? value : undefined
  }

  /** PB-26b: run the frame gate over the tunnel's accumulated upstream
   * buffer — split the complete frames, share-check every TEXT one against
   * the route's locator and return the verified wire bytes for the plugin.
   * A refusal returns the verdict and the caller owns the channel (an HTTP
   * status on `send`; an end line on the early head bytes): the refused
   * frame and everything after it NEVER reach upstream. Frames that locate
   * no id (the empty-array unsubscribe) are admitted verbatim. */
  const admitUpstreamFrames = (tunnel: Tunnel, isAccessible: (sessionId: string) => boolean): { ok: true; bytes: Buffer } | { ok: false; status: number; code: string } => {
    const buffer = tunnel.upFrameBuffer!
    const parsed = parseRfc6455Frames(buffer)
    if (parsed.violated) return { ok: false, status: 400, code: 'bad-request' }
    const verified: Buffer[] = []
    for (const frame of parsed.frames) {
      const verdict = frameShareVerdict(tunnel.route, frame, isAccessible)
      if (!verdict.ok) return verdict
      verified.push(frame.raw)
    }
    tunnel.upFrameBuffer = buffer.subarray(parsed.consumed)
    return { ok: true, bytes: Buffer.concat(verified) }
  }

  return {
    tunnelCount() {
      return tunnels.size
    },

    async open(req, res) {
      const bridge = options.bridge
      // The open body is a SMALL JSON object (four headers + optional head);
      // anything past the shared body cap is refused by the reader itself.
      let body: Record<string, unknown>
      try {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += (chunk as Buffer).length
          if (size > 1024 * 1024) {
            pluginBridgeError(res, 413, 'body-too-large')
            return
          }
          chunks.push(Buffer.from(chunk as Uint8Array))
        }
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (!isRecord(parsed)) {
          pluginBridgeError(res, 400, 'bad-request')
          return
        }
        body = parsed
      } catch {
        pluginBridgeError(res, 400, 'bad-request')
        return
      }
      const rawHeaders = isRecord(body.headers) ? body.headers : undefined
      // ALL four headers pass the CR/LF check unconditionally — confining it
      // to the missing-key branch would let a poisoned OPTIONAL header
      // through when key/version are fine, and the hand-built request below
      // would write a literal `undefined` header for it.
      for (const optional of ['sec-websocket-protocol', 'sec-websocket-extensions']) {
        if (rawHeaders?.[optional] !== undefined && cleanHeaderValue(rawHeaders[optional]) === undefined) {
          pluginBridgeError(res, 400, 'bad-request')
          return
        }
      }
      const wsKey = rawHeaders === undefined ? undefined : cleanHeaderValue(rawHeaders['sec-websocket-key'])
      const wsVersion = rawHeaders === undefined ? undefined : cleanHeaderValue(rawHeaders['sec-websocket-version'])
      // The two headers a WebSocket handshake cannot exist without.
      if (wsKey === undefined || wsVersion === undefined) {
        pluginBridgeError(res, 400, 'bad-request')
        return
      }
      let head: Buffer = Buffer.alloc(0)
      if (body.head !== undefined) {
        if (typeof body.head !== 'string') {
          pluginBridgeError(res, 400, 'bad-request')
          return
        }
        head = Buffer.from(body.head, 'base64')
        if (head.length === 0 && body.head !== '') {
          pluginBridgeError(res, 400, 'bad-request')
          return
        }
      }

      const coords = {
        pluginName: coordOf(req, 'x-zr-plugin') ?? '',
        pluginVersion: coordOf(req, 'x-zr-plugin-version') ?? '',
        pluginDigest: coordOf(req, 'x-zr-plugin-digest') ?? '',
        routePath: coordOf(req, 'x-zr-path') ?? '',
        rawQuery: coordOf(req, 'x-zr-query') ?? '',
      }
      if (
        coords.pluginName === '' || coords.pluginVersion === '' || coords.pluginDigest === '' ||
        coords.routePath === '' || !coords.routePath.startsWith('/')
      ) {
        pluginBridgeError(res, 400, 'bad-request')
        return
      }
      // No body reader here: an open request is empty-bodied by contract. A
      // NON-upgrade json-body route answers bad-request inside the shared
      // chain (nothing would ever own its ids); an `upgrade: true` one is
      // admitted with an empty session (PB-26b) — its ids arrive in the
      // later WebSocket frames and the send gate owns them.
      const validation = await validatePluginCall(bridge, coords, options.isAccessible)
      if (!validation.ok) {
        pluginBridgeError(res, validation.status, validation.code)
        return
      }
      // Tunnel routes must be DECLARED as upgrades: an ordinary (HTTP)
      // route has no WebSocket endpoint behind it to dial.
      if (!routeUpgradesOf(validation.route)) {
        pluginBridgeError(res, 404, 'route-undeclared')
        return
      }
      const device = deviceOf(req)
      if (([...tunnels.values()].filter((tunnel) => tunnel.device === device)).length >= MAX_TUNNELS_PER_DEVICE) {
        pluginBridgeError(res, 429, 'busy')
        return
      }

      // Dial the local web server with a hand-built upgrade request. The
      // cookie authenticates as the operator (same loopback discipline as
      // every bridged call); Origin is deliberately NOT written.
      let cookie: string
      try {
        cookie = await bridge.loopback.cookieHeader()
      } catch {
        pluginBridgeError(res, 502, 'loopback-auth')
        return
      }
      const target = options.getTarget()
      let upstream: Socket
      try {
        // Self-signed https on the literal loopback: the dial is the pinned
        // 127.0.0.1, so certificate identity carries no information (the
        // same rule plugin-loopback applies to its own hops).
        upstream =
          target.protocol === 'https:'
            ? tlsConnect({ host: '127.0.0.1', port: target.port, rejectUnauthorized: false, servername: '127.0.0.1' })
            : netConnect({ host: '127.0.0.1', port: target.port })
      } catch {
        pluginBridgeError(res, 502, 'internal')
        return
      }
      const id = (await import('node:crypto')).randomBytes(16).toString('hex')
      const gated = routeUpgradesOf(validation.route) && routeLocatorOf(validation.route).in === 'json-body'
      const tunnel: Tunnel = {
        device,
        upstream,
        res,
        expectedSeq: 0,
        route: validation.route,
        upFrameBuffer: gated ? Buffer.alloc(0) : undefined,
        heartbeat: setInterval(() => {
          writeLine(res, { type: 'ping' })
        }, options.heartbeatMs),
      }
      if (typeof tunnel.heartbeat.unref === 'function') tunnel.heartbeat.unref()
      tunnels.set(id, tunnel)

      // The NDJSON river opens BEFORE the dial can succeed — the open line
      // is the client's signal to stop HTTP-ing and start reading. A dial
      // failure becomes an end line, not a lost connection.
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
      })
      res.write(Buffer.from(`${JSON.stringify({ type: 'open', tunnel: id })}\n`, 'utf8'))

      const query = validation.normalizedQuery
      const requestLines = [
        `GET ${coords.routePath}${query === '' ? '' : `?${query}`} HTTP/1.1`,
        `Host: 127.0.0.1:${target.port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Key: ${wsKey}`,
        `Sec-WebSocket-Version: ${wsVersion}`,
        ...(rawHeaders?.['sec-websocket-protocol'] !== undefined ? [`Sec-WebSocket-Protocol: ${cleanHeaderValue(rawHeaders['sec-websocket-protocol'])}`] : []),
        ...(rawHeaders?.['sec-websocket-extensions'] !== undefined ? [`Sec-WebSocket-Extensions: ${cleanHeaderValue(rawHeaders['sec-websocket-extensions'])}`] : []),
        ...(cookie !== '' ? [`Cookie: ${cookie}`] : []),
        '\r\n',
      ]
      upstream.write(requestLines.join('\r\n'))
      // PB-26b: the gated tunnel admits even its EARLY head bytes through
      // the same per-frame wall — the client half never sends head on a
      // json-body route, so bytes here are a bypass attempt and the tunnel
      // dies with an end line (the river is already open — no HTTP status
      // fits anymore) instead of slipping ids past the share check.
      if (tunnel.upFrameBuffer !== undefined && head.length > 0) {
        tunnel.upFrameBuffer = Buffer.concat([tunnel.upFrameBuffer, head])
        const admitted = admitUpstreamFrames(tunnel, options.isAccessible)
        if (!admitted.ok) {
          teardown(tunnel, id, 'client-closed')
          return
        }
        if (admitted.bytes.length > 0) upstream.write(admitted.bytes)
      } else if (head.length > 0) {
        upstream.write(head)
      }

      // Upstream bytes → downstream data lines, at most 48 KiB PER LINE, with
      // the slow-reader discipline: a full socket pauses the UPSTREAM read, so
      // a stalled client never grows this process's buffers. Whatever arrived
      // is sent NOW — an interactive WebSocket speaks in tens of bytes, and
      // holding a sub-chunk arrival for a fuller buffer would stall the
      // handshake and every early frame (the PB-10 e2e hang).
      let downstreamBuffer: Buffer = Buffer.alloc(0)
      const pumpDownstream = (): void => {
        while (downstreamBuffer.length > 0) {
          const chunk = downstreamBuffer.subarray(0, TUNNEL_DOWN_CHUNK_BYTES)
          downstreamBuffer = downstreamBuffer.subarray(chunk.length)
          if (!writeLine(res, { type: 'data', b64: chunk.toString('base64') })) {
            upstream.pause()
            res.once('drain', () => upstream.resume())
            return
          }
        }
      }
      upstream.on('data', (chunk: Buffer) => {
        downstreamBuffer = Buffer.concat([downstreamBuffer, chunk])
        pumpDownstream()
      })
      upstream.on('close', () => {
        // Whatever bytes remained inside the last (sub-chunk) buffer still
        // travel before the end line.
        if (downstreamBuffer.length > 0 && !res.destroyed && !res.writableEnded) {
          writeLine(res, { type: 'data', b64: downstreamBuffer.toString('base64') })
          downstreamBuffer = Buffer.alloc(0)
        }
        teardown(tunnel, id, 'upstream-closed')
      })
      upstream.on('error', () => {
        teardown(tunnel, id, 'upstream-error')
      })
      res.on('close', () => {
        // The client is gone: no end line can be delivered.
        teardown(tunnel, id, null)
      })
    },

    async send(req, res) {
      const tunnelId = coordOf(req, 'x-zr-tunnel') ?? ''
      const seqRaw = coordOf(req, 'x-zr-seq') ?? ''
      const tunnel = tunnels.get(tunnelId)
      const device = deviceOf(req)
      if (tunnel === undefined || tunnel.device !== device) {
        pluginBridgeError(res, 404, 'tunnel-unknown')
        // Drain the body so the client reads the refusal instead of a reset.
        req.resume()
        return
      }
      if (!/^\d+$/u.test(seqRaw)) {
        pluginBridgeError(res, 400, 'bad-request')
        req.resume()
        return
      }
      const seq = Number(seqRaw)
      if (seq !== tunnel.expectedSeq) {
        // Out of order: the stream's ordering contract is broken — the
        // tunnel closes (client-closed, the sending side's failure).
        pluginBridgeError(res, 409, 'tunnel-out-of-order')
        teardown(tunnel, tunnelId, 'client-closed')
        req.resume()
        return
      }
      const declaredLength = Number(req.headers['content-length'])
      if (Number.isFinite(declaredLength) && declaredLength > TUNNEL_UP_CHUNK_BYTES) {
        pluginBridgeError(res, 413, 'body-too-large')
        req.resume()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      let over = false
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > TUNNEL_UP_CHUNK_BYTES) {
          over = true
          break
        }
        chunks.push(Buffer.from(chunk as Uint8Array))
      }
      if (over) {
        pluginBridgeError(res, 413, 'body-too-large')
        req.resume()
        return
      }
      const bytes = Buffer.concat(chunks)
      tunnel.expectedSeq = seq + 1
      // PB-26b: a json-body upgrade tunnel parses its upstream bytes into
      // RFC 6455 frames FIRST — every text frame is located and share-
      // checked before a byte of it reaches the plugin; a refused frame
      // answers the send's own HTTP status and tears the tunnel down. An
      // opaque (query-locator) tunnel skips the gate entirely.
      let outbound: Buffer = bytes
      if (tunnel.upFrameBuffer !== undefined) {
        tunnel.upFrameBuffer = Buffer.concat([tunnel.upFrameBuffer, bytes])
        const admitted = admitUpstreamFrames(tunnel, options.isAccessible)
        if (!admitted.ok) {
          pluginBridgeError(res, admitted.status, admitted.code)
          teardown(tunnel, tunnelId, 'client-closed')
          return
        }
        outbound = admitted.bytes
      }
      // Backpressure: the answer waits for the upstream socket to take the
      // bytes, so a stalled plugin makes THIS send slow instead of growing
      // buffers here. A gated chunk may hold no complete frame yet — nothing
      // to write, the bytes stay in the parse buffer, the send answers ok.
      if (outbound.length > 0) {
        const flushed = tunnel.upstream.write(outbound)
        if (!flushed) {
          await new Promise<void>((resolve) => {
            const settled = (): void => {
              tunnel.upstream.off('drain', settled)
              tunnel.upstream.off('close', settled)
              tunnel.upstream.off('error', settled)
              resolve()
            }
            tunnel.upstream.once('drain', settled)
            tunnel.upstream.once('close', settled)
            tunnel.upstream.once('error', settled)
          })
        }
      }
      if (tunnels.get(tunnelId) !== tunnel) {
        // The tunnel died while the bytes were draining.
        pluginBridgeError(res, 404, 'tunnel-unknown')
        return
      }
      responseJson(res, 200, { ok: true })
    },

    async close(req, res) {
      const tunnelId = coordOf(req, 'x-zr-tunnel') ?? ''
      const tunnel = tunnels.get(tunnelId)
      const device = deviceOf(req)
      if (tunnel !== undefined && tunnel.device !== device) {
        pluginBridgeError(res, 404, 'tunnel-unknown')
        return
      }
      // Idempotent: a known tunnel closes (end line client-closed — the
      // downstream's owner walked away), an unknown id answers ok.
      if (tunnel !== undefined) {
        teardown(tunnel, tunnelId, 'client-closed')
      }
      responseJson(res, 200, { ok: true })
    },
  }
}
