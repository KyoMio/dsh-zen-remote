/**
 * The exact-fetch-route interception (T51): the sub-client's own DSH process
 * keeps serving its local UI, but the two `/api` routes a REMOTE session's
 * surface reaches must not run against local state:
 *
 * - `/api/session/uploadFileBinary` — a NON-image attachment enters through
 *   dsh-client-file-upload's Web Worker (XHR for Blobs, worker-scoped fetch
 *   for streams — RT dsh-client-file-upload lib/client.js:72-152), so
 *   neither a `window.fetch` wrapper nor the typert interception sees it.
 *   What the worker's request DOES hit is the host's shared fetch-handler
 *   table: `HostConnectionService.fetchRoutes` is a plain Map the shared
 *   handler re-reads per request (`fetchRoutes.get(pathname)` then
 *   `route.fetch(request)`, RT dsh-client-connection lib/index.js:558 and
 *   ~614-617), and the upload registers `requestBody: "streaming"` with a
 *   closure `fetch` (RT dsh-client-file-upload lib/index.js:73, 171-176).
 *   Replacing that entry's `fetch` intercepts every upload at the local
 *   backend. A virtual `sessionId` rides the relay's binary channel to the
 *   server (the staged receipt then resolves under the SAME session the
 *   forwarded `session/prompt` runs against); anything else reaches the
 *   original function untouched.
 * - `/api/session.export` — a remote session's log lives on the SERVER, and
 *   a virtual id on the local route could only fail; the wrap refuses it
 *   with 403 `remote-unsupported` before the local route runs (the UI entry
 *   is hidden remotely too, remote-session.css.ts).
 *
 * EVERY answer the UPLOAD wrapper produces is HTTP 200 + the failure
 * envelope the browser half parses (T51-fix): dsh-client-file-upload's
 * `FileUploadRuntime.upload` throws a bare English transport error on any
 * non-200 status and never reaches `parseFileUploadResult` (RT
 * lib/client.js:190 vs 272-297) — so offline, mismatch and the local
 * oversize refusal all travel as the host's own failure shape, and the
 * Chinese message lands on the attachment card. Only the EXPORT wrapper
 * keeps a real 403: its UI (the export dialog) reads `response.ok` and
 * prints the status.
 *
 * The wrap is gated on a structural shape check like the typert one
 * (intercept-shape.ts): a future DSH without the fetchRoutes Map must leave
 * this install OFF and local uploads exactly as they were. ENTRY-LEVEL facts
 * attach per route (T51-fix): an entry that is absent at install time —
 * session-log-export may register after us — is retried on a bounded timer
 * and on each call of the OTHER wrapper; an entry that is present but
 * misshaped is refused for ITS route only (present-but-wrong never fixes
 * itself — `registerFetchRoute` throws on a duplicate path), and the rest
 * of the install still runs. Uninstall restores an entry only while it
 * still holds OUR wrapper — a later wrapper chained over us keeps working,
 * and ours goes inert instead (the same posture as intercept.ts).
 */

import { RelayError } from './relay-client.js'
import type { RelayClient } from './relay-client.js'
import { fromVirtual } from './virtual-id.js'
import { restoreInvokeBinary } from './invoke-binary.js'
import { MAX_UPLOAD_BYTES } from './relay-server.js'
import { MAX_FILE_MEDIA_BYTES } from './upload-limits.js'

/** The host's upload route, verbatim from its registration (RT
 * dsh-client-file-upload lib/index.js:73). */
export const FILE_UPLOAD_PATH = '/api/session/uploadFileBinary'

/** The host's session-log export route (RT dsh-session-log-export
 * lib/index.js:488). */
export const SESSION_EXPORT_PATH = '/api/session.export'

/** The host's media route (P55-2): how a Markdown image `![a](path)` in a
 * session body actually loads — the renderer resolves the path against the
 * session cwd into an ABSOLUTE server path and the browser's `<img>` asks
 * for `/api/file?path=<encoded>` natively (no `window.fetch`, no
 * `sessionId`), landing in this very table (RT
 * dsh-api-session-controller lib/types/media-references.js:
 * `registerFetchRoute({ path: '/api/file', methods: ['GET','HEAD'],
 * requestBody: 'buffered', … })`). */
export const FILE_MEDIA_PATH = '/api/file'

/** The byte cap one forwarded file may answer with — defined once in
 * src/upload-limits.ts (the one home of every MiB-scale ceiling, per the
 * upload unification and scripts/check-upload-limits.mjs), re-exported
 * here for the consumers the route narrative belongs to. */
export { MAX_FILE_MEDIA_BYTES }

/** The response headers every forwarded file answer carries — the host's
 * own /api/file set (RT lib/types/media-references.js BASE_HEADERS +
 * NO_STORE), so a remote-served image meets exactly the sandbox the local
 * route would have given it. */
const FILE_BASE_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

/** Extension → Content-Type for the forwarded answers. A fixed table (the
 * host routes through `mime-types`; the reply-body vocabulary fits a table)
 * with the same conservative default. */
const FILE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
}

/** The Content-Type one forwarded file answers with, read from its path
 * extension (case-folded; no extension → the stream default). */
function mediaTypeOfPath(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  if (dot === -1) return 'application/octet-stream'
  return FILE_MEDIA_TYPES[filePath.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream'
}

/** The remote upload cap, the relay's own 500 MiB (relay-server.ts explains
 * why the host has no number to mirror). Interpolated into the local
 * oversize refusal so the card names the real limit. */
const UPLOAD_CAP_MIB = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))
const FILE_MEDIA_CAP_MIB = Math.floor(MAX_FILE_MEDIA_BYTES / (1024 * 1024))

export type FetchRouteLang = 'zh' | 'en'

const FETCH_ROUTE_COPY = {
  zh: {
    oversize: `文件超过远程上传上限（${UPLOAD_CAP_MIB} MiB）`,
    fileMediaOversize: `文件超过远程读取上限（${FILE_MEDIA_CAP_MIB} MiB）`,
    offlineUpload: '服务端离线，远程会话暂时无法上传文件',
    mismatch: '此远程会话属于其他主服务端',
    interrupted: `上传中断，文件可能超过远程上传上限（${UPLOAD_CAP_MIB} MiB）或网络不稳定`,
    exportUnsupported: '远程会话不支持导出',
    offlineFile: '服务端离线，远程文件暂时无法读取',
    fileFailed: '远程文件读取失败',
    fileNotFound: '远程与本机都不存在该文件',
    fileForbidden: '远程文件不可读取',
  },
  en: {
    oversize: `File exceeds the remote upload limit (${UPLOAD_CAP_MIB} MiB)`,
    fileMediaOversize: `File exceeds the remote read limit (${FILE_MEDIA_CAP_MIB} MiB)`,
    offlineUpload: 'Server offline — cannot upload files to this remote session right now',
    mismatch: 'This remote session belongs to another server',
    interrupted: `Upload interrupted — the file may exceed the remote upload limit (${UPLOAD_CAP_MIB} MiB) or the connection dropped`,
    exportUnsupported: 'Export is not supported for remote sessions',
    offlineFile: 'Server offline — remote file cannot be read right now',
    fileFailed: 'Failed to read remote file',
    fileNotFound: 'File not found on the server or on this machine',
    fileForbidden: 'Remote file is not readable',
  },
} as const

function resolveFetchRouteLang(lang: FetchRouteLang | (() => FetchRouteLang) | undefined): FetchRouteLang {
  const value = typeof lang === 'function' ? lang() : lang
  return value === 'en' ? 'en' : 'zh'
}

/** Verdict of {@link checkFetchRouteShape}. STRUCTURAL only: `ok` answers
 * "is this a connection service with a fetch-route table at all"; each
 * route's entry findings travel as `notes` — present/absent/misshaped — and
 * the per-route attach decisions are the install's business (T51-fix). */
export type FetchRouteShapeCheck = { ok: true; notes: string[] } | { ok: false; reasons: string[] }

/** One exact-fetch route entry, as `registerFetchRoute` stores it (RT
 * dsh-client-connection lib/index.js:627-631). */
export interface FetchRouteEntry {
  methods: Set<string>
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Whether the FALLBACK install may fire on this tick (SPEC §2, the RD-6
 * machine-local failure: `ctx.inject(['connection','fileUploads'])` silently
 * stays PENDING on some compositions — the callback never runs, the wrap
 * never installs, and every remote upload dies on the local backend with no
 * diagnostic beyond "inject not seen"). All four facts must line up:
 * - `injectSeen === false` — the inject callback has NOT fired (if it had,
 *   the primary path either installed or recorded a refusal itself);
 * - `handleSet === false` — no install happened yet, via EITHER path (the
 *   double-install guard, checked again at the moment of installation);
 * - `refused === false` — no install was refused yet (a refusal is a
 *   verdict, not a pending state; retrying it would only re-learn it);
 * - `servicesPresent` — the reflection layer answers BOTH `connection` and
 *   `fileUploads`, i.e. the services exist and only the inject callback is
 *   stuck. Without them there is nothing to wrap and the inject may still
 *   be legitimately waiting (normal startup ordering) — the fallback keeps
 *   out of the way and inject stays the first choice.
 * Pure judgment over injectable state, so the whole truth table is
 * assertable in Node.
 */
export function shouldFallbackInstall(state: {
  injectSeen: boolean
  handleSet: boolean
  refused: boolean
  servicesPresent: boolean
}): boolean {
  return !state.injectSeen && !state.handleSet && !state.refused && state.servicesPresent
}

/**
 * Check the RAW connection service instance against the shape the wrap
 * depends on. Pure inspection — nothing is mutated, so a failed check
 * leaves every route exactly as it was. Only the structural facts refuse;
 * the entries' facts are described in `notes` (they attach lazily).
 *
 * `probeFileMedia` (P55-2) adds the `/api/file` entry's note and — load-
 * bearing for the legacy probe-count pins — its table READ. It defaults to
 * false so a caller without a `resolveRemoteFileScope` (every pre-P55-2
 * call site and test) touches exactly the two routes it always did.
 */
export function checkFetchRouteShape(connection: unknown, probeFileMedia = false): FetchRouteShapeCheck {
  if (!isRecord(connection) || Array.isArray(connection)) {
    return { ok: false, reasons: ['connection: not an object'] }
  }
  if (!(connection.fetchRoutes instanceof Map)) {
    return { ok: false, reasons: ['fetchRoutes: not a Map'] }
  }
  const routes = connection.fetchRoutes as Map<string, unknown>
  return {
    ok: true,
    notes: [
      describeEntry(routes.get(FILE_UPLOAD_PATH), 'upload', ['POST'], 'streaming'),
      describeEntry(routes.get(SESSION_EXPORT_PATH), 'export', ['GET', 'HEAD'], 'buffered'),
      ...(probeFileMedia ? [describeEntry(routes.get(FILE_MEDIA_PATH), 'file', ['GET', 'HEAD'], 'buffered')] : []),
    ],
  }
}

/** One entry's attach-worthiness, as a human-readable note: what the table
 * held for this route at check time. */
function describeEntry(entry: unknown, label: string, methods: string[], body: string): string {
  if (!isRecord(entry)) return `${label}: absent at check time (the attach retries)`
  const problem = entryProblem(entry, methods, body)
  if (problem !== undefined) return `${label}: present but misshaped (attach refused: ${problem})`
  return `${label}: present and attachable`
}

/** The entry-level facts one route must prove before its wrapper may
 * install, or the reason it may not. */
function entryProblem(entry: unknown, methods: string[], body: string): string | undefined {
  if (!isRecord(entry)) return 'entry is not an object'
  const admitted = entry.methods
  if (!(admitted instanceof Set) || !methods.every((method) => admitted.has(method))) {
    return `methods does not admit ${methods.join('+')}`
  }
  if (typeof entry.fetch !== 'function') return 'fetch is not a function'
  if (entry.requestBody !== body) {
    return `requestBody is ${JSON.stringify(entry.requestBody ?? null)}, expected ${JSON.stringify(body)}`
  }
  return undefined
}

/** One refusal the wrappers answered, in the diagnostics ring. */
export interface FetchRouteFailureRecord {
  /** ISO timestamp of the moment the refusal was answered. */
  time: string
  /** Which wrapper answered it. */
  route: 'upload' | 'export' | 'file'
  code: string
}

/** What the client status route surfaces about this interception: flags,
 * counters and codes only — never a token, never a server address. */
export interface FetchRouteInterceptDiagnostics {
  installed: boolean
  shape: FetchRouteShapeCheck
  /** The upload entry currently holds our wrapper. */
  uploadWrapped: boolean
  /** The export entry currently holds our wrapper (false while absent or
   * refused). */
  exportWrapped: boolean
  /** The upload entry was absent at last check and the attach retry is
   * still running (T51-fix). */
  uploadPending: boolean
  /** The export entry was absent at last check and the attach retry is
   * still running (T51-fix). */
  exportPending: boolean
  /** The upload entry was present but misshaped — attach refused for THIS
   * route only; the reason is stable diagnostics text (T51-fix). */
  uploadAttachRefused: string | undefined
  /** Same, for the export entry. */
  exportAttachRefused: string | undefined
  /** Every upload that entered the wrapper, local passthroughs included. */
  uploadCalls: number
  /** Uploads forwarded through the relay (virtual ids only). */
  uploadForwarded: number
  /** Uploads refused locally (oversize, offline, mismatch, relay
   * refusals, relay transport death). */
  uploadRefused: number
  /** Export requests blocked with `remote-unsupported`. */
  exportBlocked: number
  /** The most recent refusals, oldest first, capped. */
  recentFailures: FetchRouteFailureRecord[]
  // ---- the /api/file media wrap (P55-2) — present ONLY when the wiring
  // handed a resolveRemoteFileScope over; absent otherwise, which is how the
  // legacy diagnostics consumers (and tests) tell the two generations apart.
  /** The media entry currently holds our wrapper. */
  fileWrapped?: boolean
  /** The media entry was absent at last check and the attach retry is still
   * running. */
  filePending?: boolean
  /** The media entry was present but misshaped — attach refused for THIS
   * route only; the reason is stable diagnostics text. */
  fileAttachRefused?: string | undefined
  /** Every media request that entered the wrapper, passthroughs included. */
  fileCalls?: number
  /** Media requests served through the relay. */
  fileForwarded?: number
  /** Media requests refused (offline, mismatch, relay/remote errors,
   * oversize). */
  fileRefused?: number
}

export interface InstallFetchRouteInterceptOptions {
  /** The RAW connection service instance
   * (`ctx.connection[symbols.original]`) — the one whose `fetchRoutes` Map
   * the shared handler reads per request. */
  connection: object
  /** SINGLE-SERVER mode: the client relay client (T23a) the uploads travel
   * through. Required together with {@link getServerId} unless
   * {@link getRelayForServer} is given (MS-5's pool wiring). */
  relay?: RelayClient
  /** SINGLE-SERVER mode: the CURRENT handshake's server id, read live per
   * call; `undefined` makes every remote upload a `remote-offline`. */
  getServerId?: () => string | undefined
  /** MS-4: the relay client serving ONE paired server, looked up by the
   * virtual id's serverId half per upload (the connection pool's
   * `getByServerId`). When given, routing reads it alone: `undefined` (a
   * server the pool does not hold) answers `remote-mismatch`, a held client
   * that is not online `remote-offline`. Absent — the single-server wiring —
   * the upload goes through `relay` exactly when the id belongs to
   * `getServerId()`, with the original verdict order. */
  getRelayForServer?: (serverId: string) => RelayClient | undefined
  /** P55-2: the intercept handle's session-attribution answer (live, so the
   * wiring forwards `interceptHandle?.resolveRemoteFileScope`). Its PRESENCE
   * is the media mount's switch: without it, `/api/file` is never probed,
   * wrapped, or counted — the pre-P55-2 behavior, byte for byte (the
   * legacy probe-count pins depend on this). */
  resolveRemoteFileScope?: (path: string) => { serverId: string; sessionId: string } | undefined
  /** Progress logging, wired to the context logger by index.ts. */
  log?: (format: string, ...args: unknown[]) => void
  /** The lazy-attach retry cadence (T51-fix): how often the table is
   * re-probed for entries that were absent at install, and how many probes
   * before giving up. Defaults 3000 ms × 10; tests shrink both. */
  attachRetryMs?: number
  attachAttempts?: number
  /** Language for error messages (`'zh'` default, `'en'` English). Accepts a
   * getter for live resolution. */
  lang?: FetchRouteLang | (() => FetchRouteLang) | undefined
}

export interface FetchRouteInterceptHandle {
  /** Restore every attached entry — each ONLY while it still holds our
   * wrapper — and stop the attach retry. Idempotent. After it ran, the
   * wrappers stay installed-but-inert if someone had chained over them
   * (same posture as intercept.ts). */
  uninstall(): void
  /** The status-route view. */
  diagnostics(): FetchRouteInterceptDiagnostics
}

/** Longest failure ring kept for the status surface. */
const MAX_FAILURES = 20

/** Default lazy-attach cadence (T51-fix): every 3 s, at most 10 probes —
 * a route registered during the same startup wave lands on the first or
 * second tick, and a composition that never ships the route stops the
 * probe after half a minute. */
const DEFAULT_ATTACH_RETRY_MS = 3_000
const DEFAULT_ATTACH_ATTEMPTS = 10

/** The first value of one repeated query parameter, or `undefined` — the
 * host's own `.get()` reading (RT dsh-client-file-upload lib/index.js:20-22),
 * kept so a weird local request meets the same behavior remotely it would
 * have locally. */
function firstQuery(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name)
  return values[0]
}

/**
 * The failure envelope the browser half parses (RT dsh-client-file-upload
 * lib/client.js:272-297, `parseFileUploadResult`): code AND message AND a
 * record `details`, all required — a details-less error throws in the UI's
 * parser, so every envelope WE construct carries `details: {}`. HTTP 200 on
 * purpose (T51-fix): the host's own route answers business failures with
 * 200 + this envelope (RT lib/index.js:34-55), and a non-200 status would
 * die in `FileUploadRuntime.upload` as a bare English transport error
 * before the envelope was ever read.
 */
function uploadFailure(code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message, details: {} } }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function statusFailure(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message, details: {} } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** The relay codes that mean "the LINK is not usable" — a link fact, not a
 * business answer about one call (still answered as a 200 envelope, see
 * {@link uploadFailure}). */
const LINK_DOWN_CODES: ReadonlySet<string> = new Set(['offline', 'unpaired', 'revoked', 'incompatible'])

/**
 * Install the wrappers over the two fetch-route entries. Assumes
 * {@link checkFetchRouteShape} passed (the wiring gates on it — the gate is
 * structural only); each entry attaches on its own facts, immediately when
 * present and attachable, via the bounded retry when absent, never when
 * present-but-misshaped.
 */
export function installFetchRouteIntercept(options: InstallFetchRouteInterceptOptions): FetchRouteInterceptHandle {
  const { connection, relay, getServerId, getRelayForServer, log } = options
  // Exactly one mode, like installIntercept: the pool face or the single
  // row client — a wiring that passes neither would silently send every
  // remote upload to remote-offline, so it is refused here instead.
  if (getRelayForServer === undefined && (relay === undefined || getServerId === undefined)) {
    throw new Error('installFetchRouteIntercept requires either `relay` + `getServerId` (single server) or `getRelayForServer`')
  }
  // The single-server facts, proven present by the guard above. The
  // single-server code path reads THESE (never the optionals), so the old
  // behavior stays byte-identical without a narrowing dance.
  const singleRelay = relay as RelayClient
  const singleGetServerId = getServerId as () => string | undefined
  const resolveRemoteFileScope = options.resolveRemoteFileScope
  // The media mount's switch (P55-2): its presence probes, wraps and counts
  // `/api/file`; its absence keeps every pre-P55-2 behavior byte-identical —
  // including the exact fetchRoutes probe counts the legacy tests pin.
  const fileMediaEnabled = resolveRemoteFileScope !== undefined
  const attachRetryMs = options.attachRetryMs ?? DEFAULT_ATTACH_RETRY_MS
  const attachAttempts = options.attachAttempts ?? DEFAULT_ATTACH_ATTEMPTS
  const shape = checkFetchRouteShape(connection, fileMediaEnabled)
  const routes = (connection as { fetchRoutes: Map<string, FetchRouteEntry> }).fetchRoutes

  let installed = true
  const failures: FetchRouteFailureRecord[] = []
  const counters = { uploadCalls: 0, uploadForwarded: 0, uploadRefused: 0, exportBlocked: 0, fileCalls: 0, fileForwarded: 0, fileRefused: 0 }

  // The per-route attach state. `undefined` entry = absent so far (the
  // retry may still land it); a refusal string = present-but-misshaped,
  // permanent for this install.
  let uploadEntry: FetchRouteEntry | undefined
  let savedUpload: FetchRouteEntry['fetch'] | undefined
  let uploadAttachRefused: string | undefined
  let exportEntry: FetchRouteEntry | undefined
  let savedExport: FetchRouteEntry['fetch'] | undefined
  let exportAttachRefused: string | undefined
  let fileEntry: FetchRouteEntry | undefined
  let savedFile: FetchRouteEntry['fetch'] | undefined
  let fileAttachRefused: string | undefined

  const copy = () => FETCH_ROUTE_COPY[resolveFetchRouteLang(options.lang)]
  const recordFailure = (route: FetchRouteFailureRecord['route'], code: string): void => {
    if (failures.length >= MAX_FAILURES) failures.shift()
    failures.push({ time: new Date().toISOString(), route, code })
  }

  /** The relay client one virtual id's upload travels through, or the
   * refusal. Single-server mode keeps the original order (offline before
   * mismatch); pool mode (MS-4) asks the pool for the id's own server. */
  const uploadRelayFor = (serverId: string): RelayClient | 'remote-offline' | 'remote-mismatch' => {
    if (getRelayForServer !== undefined) {
      const target = getRelayForServer(serverId)
      if (target === undefined) return 'remote-mismatch'
      return target.state === 'online' ? target : 'remote-offline'
    }
    const current = singleGetServerId()
    if (singleRelay.state !== 'online' || current === undefined) return 'remote-offline'
    if (serverId !== current) return 'remote-mismatch'
    return singleRelay
  }

  const wrappedUpload = async (request: Request): Promise<Response> => {
    counters.uploadCalls += 1
    // The other half may have registered while we were installing: every
    // real call re-probes a still-missing route before doing anything else.
    if (installed && exportEntry === undefined && exportAttachRefused === undefined) attachExport()
    if (installed && fileMediaEnabled && fileEntry === undefined && fileAttachRefused === undefined) attachFile()
    const passthrough = (): Promise<Response> =>
      (savedUpload as FetchRouteEntry['fetch']).call(uploadEntry, request)
    // An uninstalled (chained-over) wrap is INERT, not absent.
    if (!installed) return passthrough()
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return passthrough()
    }
    if (url.pathname !== FILE_UPLOAD_PATH) return passthrough()
    const sessionId = firstQuery(url, 'sessionId')
    // No id, or a LOCAL id: the original route's business, its request body
    // never touched (the pump below is the only consumer).
    const parts = sessionId === undefined || sessionId === '' ? undefined : fromVirtual(sessionId)
    if (parts === undefined) return passthrough()
    // Virtual from here: the local route cannot serve this id, so every
    // outcome is ours to answer.
    // A DECLARED body past the relay's cap is refused locally (T51-fix):
    // the browser's XHR branch always sends Content-Length, so the honest
    // answer travels before a byte moves and a 250 MiB pick can never take
    // the connection for a doomed round-trip.
    const declaredLength = request.headers.get('content-length')
    const declared =
      declaredLength !== null && declaredLength !== '' && /^\d+$/.test(declaredLength) ? Number(declaredLength) : undefined
    if (declared !== undefined && declared > MAX_UPLOAD_BYTES) {
      counters.uploadRefused += 1
      recordFailure('upload', 'payload-too-large')
      log?.('upload for %s refused locally: payload-too-large (%s declared)', sessionId, declaredLength)
      return uploadFailure('payload-too-large', copy().oversize)
    }
    const target = uploadRelayFor(parts.serverId)
    if (target === 'remote-offline') {
      counters.uploadRefused += 1
      recordFailure('upload', 'remote-offline')
      log?.('upload for %s refused: relay not online', sessionId)
      return uploadFailure('remote-offline', copy().offlineUpload)
    }
    if (target === 'remote-mismatch') {
      counters.uploadRefused += 1
      recordFailure('upload', 'remote-mismatch')
      log?.('upload for %s refused: belongs to another server', sessionId)
      return uploadFailure('remote-mismatch', copy().mismatch)
    }
    counters.uploadForwarded += 1
    try {
      // The request's own body stream rides to the server UNREAD by us; the
      // browser's abort signal rides along so a cancelled picker closes the
      // relay round-trip too.
      const result = await target.upload(
        { sessionId: parts.id, name: firstQuery(url, 'name'), body: request.body, bytes: declared },
        request.signal,
      )
      return new Response(result.body, {
        status: result.status,
        headers: {
          'content-type': result.contentType ?? 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    } catch (error) {
      counters.uploadRefused += 1
      const code = error instanceof RelayError ? error.code : 'internal'
      recordFailure('upload', code)
      log?.('upload for %s failed through the relay: %s', sessionId, code)
      if (error instanceof RelayError && LINK_DOWN_CODES.has(error.code)) {
        // A link fact — but still the parseable 200 envelope (T51-fix): the
        // transport error the UI would otherwise show for a non-200 says
        // nothing a user can act on. Within `offline` the two origins must
        // not share a card (T5x): a transport death MID-BODY arrives with no
        // HTTP status at all — the server cut an undeclared oversize upload
        // or the network hiccuped, and this upload route deliberately never
        // judges the link — while a status-carrying `offline` is the relay
        // CHAIN answering 502/503/504, which IS the gateway being down.
        if (error.code === 'offline' && error.status === undefined) {
          return uploadFailure('upload-interrupted', copy().interrupted)
        }
        return uploadFailure('remote-offline', copy().offlineUpload)
      }
      // A business answer — the relay's own refusal (`not-shared`,
      // `payload-too-large`, …) or the upstream route's failure envelope —
      // keeps the host's 200-with-envelope contract, details normalized to
      // the record `parseFileUploadResult` demands.
      const message = error instanceof Error ? error.message : String(error)
      return uploadFailure(code, message)
    }
  }

  const wrappedExport = async (request: Request): Promise<Response> => {
    if (installed && uploadEntry === undefined && uploadAttachRefused === undefined) attachUpload()
    if (installed && fileMediaEnabled && fileEntry === undefined && fileAttachRefused === undefined) attachFile()
    const passthrough = (): Promise<Response> =>
      savedExport !== undefined ? savedExport.call(exportEntry, request) : Promise.resolve(new Response('not found', { status: 404 }))
    if (!installed) return passthrough()
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return passthrough()
    }
    if (url.pathname !== SESSION_EXPORT_PATH) return passthrough()
    const sessionId = firstQuery(url, 'sessionId')
    const parts = sessionId === undefined || sessionId === '' ? undefined : fromVirtual(sessionId)
    if (parts === undefined) return passthrough()
    counters.exportBlocked += 1
    recordFailure('export', 'remote-unsupported')
    return statusFailure(403, 'remote-unsupported', copy().exportUnsupported)
  }

  /** One /api/file answer the relay could not serve, with the honest
   * status. The `<img>` consumer reads the status alone (it renders no
   * error body), so unlike the upload wrap these keep real statuses — a
   * 200-with-envelope here would render a BROKEN image while pretending
   * success. */
  const fetchRemoteFile = async (
    scope: { serverId: string; sessionId: string },
    filePath: string,
    request: Request,
    passthrough: () => Promise<Response>,
  ): Promise<Response> => {
    const target = uploadRelayFor(scope.serverId)
    if (target === 'remote-offline') {
      counters.fileRefused += 1
      recordFailure('file', 'remote-offline')
      return statusFailure(503, 'remote-offline', copy().offlineFile)
    }
    if (target === 'remote-mismatch') {
      counters.fileRefused += 1
      recordFailure('file', 'remote-mismatch')
      return statusFailure(403, 'remote-mismatch', copy().mismatch)
    }
    if (typeof (target as { invoke?: unknown }).invoke !== 'function') {
      counters.fileRefused += 1
      recordFailure('file', 'internal')
      return statusFailure(502, 'internal', copy().fileFailed)
    }
    const mediaType = mediaTypeOfPath(filePath)
    try {
      if (request.method === 'HEAD') {
        // Size only: stat answers `bytes` (RT dsh-api-workspace-files
        // lib/typert.remote-client.js — the result carries
        // absolutePath/version and an OPTIONAL `bytes`).
        const stat = await target.invoke('workspaceFiles', 'stat', { workspaceFileScopeId: scope.sessionId, path: filePath }, request.signal)
        const size = isRecord(stat) && typeof stat.bytes === 'number' ? stat.bytes : undefined
        if (size !== undefined && size > MAX_FILE_MEDIA_BYTES) {
          counters.fileRefused += 1
          return statusFailure(413, 'file-too-large', copy().fileMediaOversize)
        }
        return new Response(null, {
          status: 200,
          headers: {
            ...FILE_BASE_HEADERS,
            'Content-Type': mediaType,
            ...(size !== undefined ? { 'Content-Length': String(size) } : {}),
          },
        })
      }
      // Whole file: readBytes answers a marker-encoded result
      // (`data: {$zr-u8: base64}` on the JSON channel), restored here.
      const raw = await target.invoke(
        'workspaceFiles',
        'readBytes',
        { workspaceFileScopeId: scope.sessionId, path: filePath, options: {} },
        request.signal,
      )
      const restored = restoreInvokeBinary(raw)
      const data = isRecord(restored) && restored.data instanceof Uint8Array ? (restored.data as Uint8Array) : undefined
      if (data === undefined) {
        counters.fileRefused += 1
        recordFailure('file', 'internal')
        return statusFailure(502, 'internal', copy().fileFailed)
      }
      if (data.byteLength > MAX_FILE_MEDIA_BYTES) {
        counters.fileRefused += 1
        return statusFailure(413, 'file-too-large', copy().fileMediaOversize)
      }
      return new Response(data.slice(), {
        status: 200,
        headers: { ...FILE_BASE_HEADERS, 'Content-Type': mediaType, 'Content-Length': String(data.byteLength) },
      })
    } catch (error) {
      const code = error instanceof RelayError ? error.code : 'internal'
      recordFailure('file', code)
      log?.('file %s for %s failed through the relay: %s', filePath, scope.sessionId, code)
      // The file the session cited may exist on BOTH machines (the reply
      // quoted a path the sub-client also has, or the remote record is
      // stale): a not-found answer falls back to the LOCAL route once —
      // its 200 is adopted, anything else becomes our 404.
      if (code === 'workspace-file/not-found' || code === 'FS_NOT_FOUND') {
        const local = await passthrough()
        if (local.status === 200) return local
        counters.fileRefused += 1
        return statusFailure(404, 'file-not-found', copy().fileNotFound)
      }
      counters.fileRefused += 1
      if (code === 'workspace-file/too-large' || code === 'FS_TOO_LARGE') {
        return statusFailure(413, 'file-too-large', copy().fileMediaOversize)
      }
      if (
        code === 'workspace-file/not-regular-file' ||
        code === 'FS_NOT_REGULAR_FILE' ||
        code === 'FS_PERMISSION_DENIED' ||
        code === 'FS_SANDBOX_DENIED' ||
        code === 'not-shared'
      ) {
        return statusFailure(403, code, copy().fileForbidden)
      }
      if (LINK_DOWN_CODES.has(code)) return statusFailure(503, code, copy().offlineFile)
      return statusFailure(502, code, copy().fileFailed)
    }
  }

  const wrappedFile = async (request: Request): Promise<Response> => {
    counters.fileCalls += 1
    // The other halves may have registered while we were installing (the
    // same courtesy the upload and export wrappers pay each other).
    if (installed && uploadEntry === undefined && uploadAttachRefused === undefined) attachUpload()
    if (installed && exportEntry === undefined && exportAttachRefused === undefined) attachExport()
    const passthrough = (): Promise<Response> =>
      savedFile !== undefined ? savedFile.call(fileEntry, request) : Promise.resolve(new Response('not found', { status: 404 }))
    // An uninstalled (chained-over) wrap is INERT, not absent.
    if (!installed) return passthrough()
    if (request.method !== 'GET' && request.method !== 'HEAD') return passthrough()
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return passthrough()
    }
    if (url.pathname !== FILE_MEDIA_PATH) return passthrough()
    const filePath = firstQuery(url, 'path')
    if (filePath === undefined || filePath === '' || filePath.includes('\0')) return passthrough()
    // Which remote session owns this path — an explicit VIRTUAL sessionId
    // in the URL decides on its own (forward-compat for callers that know
    // their session); otherwise the intercept handle attributes by cwd and
    // current-session. `undefined` = the LOCAL route's business.
    const explicit = firstQuery(url, 'sessionId')
    const explicitParts = explicit === undefined || explicit === '' ? undefined : fromVirtual(explicit)
    const scope = explicitParts !== undefined
      ? { serverId: explicitParts.serverId, sessionId: explicitParts.id }
      : resolveRemoteFileScope?.(filePath)
    if (scope === undefined) return passthrough()
    counters.fileForwarded += 1
    return fetchRemoteFile(scope, filePath, request, passthrough)
  }

  // ---- the per-route attach (T51-fix) --------------------------------------

  /** Attach the upload wrapper to its entry, or answer whether the retry
   * should stop: `true` = attached, or permanently refused; `false` = still
   * absent, keep probing. */
  const attachUpload = (): boolean => {
    if (!installed) return true
    if (uploadEntry !== undefined) return true
    const candidate = routes.get(FILE_UPLOAD_PATH)
    if (candidate === undefined) return false
    const problem = entryProblem(candidate, ['POST'], 'streaming')
    if (problem !== undefined) {
      uploadAttachRefused = problem
      log?.('upload route attach refused: %s', problem)
      return true
    }
    uploadEntry = candidate
    savedUpload = uploadEntry.fetch
    uploadEntry.fetch = wrappedUpload
    log?.('upload route attached')
    return true
  }

  /** The export half of {@link attachUpload}. */
  const attachExport = (): boolean => {
    if (!installed) return true
    if (exportEntry !== undefined) return true
    const candidate = routes.get(SESSION_EXPORT_PATH)
    if (candidate === undefined) return false
    const problem = entryProblem(candidate, ['GET', 'HEAD'], 'buffered')
    if (problem !== undefined) {
      exportAttachRefused = problem
      log?.('export route attach refused: %s', problem)
      return true
    }
    exportEntry = candidate
    savedExport = exportEntry.fetch
    exportEntry.fetch = wrappedExport
    log?.('export route attached')
    return true
  }

  /** The media half of {@link attachUpload} (P55-2). Runs only when the
   * wiring handed a `resolveRemoteFileScope` over — without it the route is
   * never probed at all, which is what keeps the legacy installs (and the
   * probe-count pins) byte-identical. */
  const attachFile = (): boolean => {
    if (!fileMediaEnabled || !installed) return true
    if (fileEntry !== undefined) return true
    const candidate = routes.get(FILE_MEDIA_PATH)
    if (candidate === undefined) return false
    const problem = entryProblem(candidate, ['GET', 'HEAD'], 'buffered')
    if (problem !== undefined) {
      fileAttachRefused = problem
      log?.('file media route attach refused: %s', problem)
      return true
    }
    fileEntry = candidate
    savedFile = fileEntry.fetch
    fileEntry.fetch = wrappedFile
    log?.('file media route attached')
    return true
  }

  // First attach, right now: whatever the table already held is wrapped
  // before this returns.
  attachUpload()
  attachExport()
  attachFile()

  // The bounded retry for what was absent (T51-fix): a probe every
  // attachRetryMs, at most attachAttempts of them, stopped early once
  // nothing is pending. `unref()`ed — startup ordering must never hold the
  // process open for a route that may never come.
  let attempts = 1
  let retryTimer: ReturnType<typeof setInterval> | undefined
  const stopRetrying = (): void => {
    if (retryTimer !== undefined) {
      clearInterval(retryTimer)
      retryTimer = undefined
    }
  }
  const stillPending = (): boolean =>
    // A REFUSED route is not a wait (T5x): present-but-wrong never fixes
    // itself, so once a route's attach is refused it must not keep the
    // bounded retry spinning idle past it — only a route that is still
    // genuinely absent counts as pending. (Mirrors the `uploadPending` /
    // `exportPending` / `filePending` diagnostics flags.) The media clause
    // exists only when the scope resolver was handed over (P55-2).
    (fileMediaEnabled && fileEntry === undefined && fileAttachRefused === undefined) ||
    (uploadEntry === undefined && uploadAttachRefused === undefined) ||
    (exportEntry === undefined && exportAttachRefused === undefined)
  if (stillPending() && attempts < attachAttempts) {
    retryTimer = setInterval(() => {
      attempts += 1
      attachUpload()
      attachExport()
      attachFile()
      if (!stillPending() || attempts >= attachAttempts) stopRetrying()
    }, attachRetryMs)
    if (typeof retryTimer.unref === 'function') retryTimer.unref()
  }

  return {
    uninstall() {
      if (!installed) return
      installed = false
      stopRetrying()
      // Only replace while the entry still holds OUR wrapper — a later
      // wrapper chained over us captured this function, and restoring the
      // original would silently drop ITS wrap. Ours goes inert instead.
      if (uploadEntry !== undefined && uploadEntry.fetch === wrappedUpload) uploadEntry.fetch = savedUpload as FetchRouteEntry['fetch']
      if (exportEntry !== undefined && exportEntry.fetch === wrappedExport) exportEntry.fetch = savedExport as FetchRouteEntry['fetch']
      if (fileEntry !== undefined && fileEntry.fetch === wrappedFile) fileEntry.fetch = savedFile as FetchRouteEntry['fetch']
    },
    diagnostics(): FetchRouteInterceptDiagnostics {
      return {
        installed,
        shape,
        uploadWrapped: uploadEntry !== undefined && uploadEntry.fetch === wrappedUpload,
        exportWrapped: exportEntry !== undefined && exportEntry.fetch === wrappedExport,
        uploadPending: installed && uploadEntry === undefined && uploadAttachRefused === undefined,
        exportPending: installed && exportEntry === undefined && exportAttachRefused === undefined,
        uploadAttachRefused,
        exportAttachRefused,
        // The upload/export counters spread verbatim; the file counters and
        // flags stay ABSENT unless the media mount is enabled (P55-2), so a
        // pre-P55-2 diagnostics consumer sees the exact old key set.
        uploadCalls: counters.uploadCalls,
        uploadForwarded: counters.uploadForwarded,
        uploadRefused: counters.uploadRefused,
        exportBlocked: counters.exportBlocked,
        ...(fileMediaEnabled
          ? {
              fileWrapped: fileEntry !== undefined && fileEntry.fetch === wrappedFile,
              filePending: installed && fileEntry === undefined && fileAttachRefused === undefined,
              fileAttachRefused,
              fileCalls: counters.fileCalls,
              fileForwarded: counters.fileForwarded,
              fileRefused: counters.fileRefused,
            }
          : {}),
        recentFailures: [...failures],
      }
    },
  }
}
