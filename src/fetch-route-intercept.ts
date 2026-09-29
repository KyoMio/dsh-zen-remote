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
 *   with 403 `remote-unsupported` before the local route runs (the UI
 *   entry is hidden remotely too, remote-session.css.ts).
 *
 * The wrap is gated on a shape check like the typert one (intercept-shape
 * .ts): a future DSH that reshapes the entry must leave this install OFF
 * and local uploads exactly as they were. Uninstall restores an entry only
 * while it still holds OUR wrapper — a later wrapper chained over us keeps
 * working, and ours goes inert instead (the same posture as intercept.ts).
 */

import { RelayError } from './relay-client.js'
import type { RelayClient } from './relay-client.js'
import { fromVirtual } from './virtual-id.js'

/** The host's upload route, verbatim from its registration (RT
 * dsh-client-file-upload lib/index.js:73). */
export const FILE_UPLOAD_PATH = '/api/session/uploadFileBinary'

/** The host's session-log export route (RT dsh-session-log-export
 * lib/index.js:488). */
export const SESSION_EXPORT_PATH = '/api/session.export'

/** Verdict of {@link checkFetchRouteShape}. `notes` record non-fatal facts —
 * the export entry missing at install time only means the export refusal is
 * not installed (the upload wrap is the load-bearing half). */
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
 * Check the RAW connection service instance against the shape the wrap
 * depends on. Pure inspection — nothing is mutated, so a failed check
 * leaves every route exactly as it was. The upload entry is REQUIRED (all
 * three facts the pump relies on); the export entry is OPTIONAL — its
 * absence is a note, not a refusal, because the export refusal is a
 * convenience over the upload channel, not its prerequisite.
 */
export function checkFetchRouteShape(connection: unknown): FetchRouteShapeCheck {
  if (!isRecord(connection) || Array.isArray(connection)) {
    return { ok: false, reasons: ['connection: not an object'] }
  }
  if (!(connection.fetchRoutes instanceof Map)) {
    return { ok: false, reasons: ['fetchRoutes: not a Map'] }
  }
  const routes = connection.fetchRoutes as Map<string, unknown>
  const reasons: string[] = []
  const notes: string[] = []
  const upload = routes.get(FILE_UPLOAD_PATH)
  if (!isRecord(upload)) {
    reasons.push(`upload: no "${FILE_UPLOAD_PATH}" entry in fetchRoutes`)
  } else {
    if (!(upload.methods instanceof Set) || !upload.methods.has('POST')) {
      reasons.push('upload: methods does not admit POST')
    }
    if (typeof upload.fetch !== 'function') reasons.push('upload: fetch is not a function')
    if (upload.requestBody !== 'streaming') {
      reasons.push(`upload: requestBody is ${JSON.stringify(upload.requestBody ?? null)}, expected "streaming"`)
    }
  }
  const exported = routes.get(SESSION_EXPORT_PATH)
  if (!isRecord(exported)) {
    notes.push(`export: no "${SESSION_EXPORT_PATH}" entry at install time — the remote-export refusal is not installed`)
  } else if (typeof exported.fetch !== 'function') {
    notes.push('export: fetch is not a function — the remote-export refusal is not installed')
  }
  if (reasons.length > 0) return { ok: false, reasons }
  return { ok: true, notes }
}

/** One refusal the wrappers answered, in the diagnostics ring. */
export interface FetchRouteFailureRecord {
  /** ISO timestamp of the moment the refusal was answered. */
  time: string
  /** Which wrapper answered it. */
  route: 'upload' | 'export'
  code: string
}

/** What the client status route surfaces about this interception: flags,
 * counters and codes only — never a token, never a server address. */
export interface FetchRouteInterceptDiagnostics {
  installed: boolean
  shape: FetchRouteShapeCheck
  /** The upload entry currently holds our wrapper. */
  uploadWrapped: boolean
  /** The export entry currently holds our wrapper (false when the entry was
   * absent or misshaped at install time). */
  exportWrapped: boolean
  /** Every upload that entered the wrapper, local passthroughs included. */
  uploadCalls: number
  /** Uploads forwarded through the relay (virtual ids only). */
  uploadForwarded: number
  /** Uploads refused locally (offline, mismatch, relay refusals, relay
   * transport death). */
  uploadRefused: number
  /** Export requests blocked with `remote-unsupported`. */
  exportBlocked: number
  /** The most recent refusals, oldest first, capped. */
  recentFailures: FetchRouteFailureRecord[]
}

export interface InstallFetchRouteInterceptOptions {
  /** The RAW connection service instance
   * (`ctx.connection[symbols.original]`) — the one whose `fetchRoutes` Map
   * the shared handler reads per request. */
  connection: object
  /** The client relay client (T23a) the uploads travel through. */
  relay: RelayClient
  /** The CURRENT handshake's server id, read live per call; `undefined`
   * makes every remote upload a `remote-offline`. */
  getServerId: () => string | undefined
  /** Progress logging, wired to the context logger by index.ts. */
  log?: (format: string, ...args: unknown[]) => void
}

export interface FetchRouteInterceptHandle {
  /** Restore both entries — each ONLY while it still holds our wrapper.
   * Idempotent. After it ran, the wrappers stay installed-but-inert if
   * someone had chained over them (same posture as intercept.ts). */
  uninstall(): void
  /** The status-route view. */
  diagnostics(): FetchRouteInterceptDiagnostics
}

/** Longest failure ring kept for the status surface. */
const MAX_FAILURES = 20

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
 * parser, so every envelope WE construct carries `details: {}`.
 */
function uploadFailure(code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message, details: {} } }), {
    // The host's own route answers business failures with HTTP 200 + this
    // envelope (RT lib/index.js:34-55) — the shape `parseFileUploadResult`
    // turns back into a RemoteError — so a relayed refusal keeps that
    // contract and only LINK-level facts surface as real status codes.
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

/** The relay codes that mean "the LINK is not usable" — 503, not a business
 * envelope (the same four the T41b http wrapper answers remote-offline
 * for). */
const LINK_DOWN_CODES: ReadonlySet<string> = new Set(['offline', 'unpaired', 'revoked', 'incompatible'])

/**
 * Install the wrappers over the two fetch-route entries. Assumes
 * {@link checkFetchRouteShape} passed (the wiring gates on it) — the export
 * half additionally consults the verdict's `notes` to know whether its
 * entry was wrappable at all.
 */
export function installFetchRouteIntercept(options: InstallFetchRouteInterceptOptions): FetchRouteInterceptHandle {
  const { connection, relay, getServerId, log } = options
  const shape = checkFetchRouteShape(connection)
  const routes = (connection as { fetchRoutes: Map<string, FetchRouteEntry> }).fetchRoutes
  const uploadEntry = routes.get(FILE_UPLOAD_PATH) as FetchRouteEntry
  const exportEntry = routes.get(SESSION_EXPORT_PATH)
  const exportWrappable = shape.ok && exportEntry !== undefined && typeof exportEntry.fetch === 'function'
  const savedUpload = uploadEntry.fetch
  const savedExport = exportWrappable ? (exportEntry as FetchRouteEntry).fetch : undefined

  let installed = true
  const failures: FetchRouteFailureRecord[] = []
  const counters = { uploadCalls: 0, uploadForwarded: 0, uploadRefused: 0, exportBlocked: 0 }

  const recordFailure = (route: FetchRouteFailureRecord['route'], code: string): void => {
    if (failures.length >= MAX_FAILURES) failures.shift()
    failures.push({ time: new Date().toISOString(), route, code })
  }

  const wrappedUpload = async (request: Request): Promise<Response> => {
    counters.uploadCalls += 1
    const passthrough = (): Promise<Response> => savedUpload.call(uploadEntry, request)
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
    const serverId = getServerId()
    if (relay.state !== 'online' || serverId === undefined) {
      counters.uploadRefused += 1
      recordFailure('upload', 'remote-offline')
      log?.('upload for %s refused: relay not online', sessionId)
      return statusFailure(503, 'remote-offline', '服务端离线，远程会话暂时无法上传文件')
    }
    if (parts.serverId !== serverId) {
      counters.uploadRefused += 1
      recordFailure('upload', 'remote-mismatch')
      log?.('upload for %s refused: belongs to another server', sessionId)
      return statusFailure(400, 'remote-mismatch', '此远程会话属于其他主服务端')
    }
    counters.uploadForwarded += 1
    try {
      const declaredLength = request.headers.get('content-length')
      const bytes =
        declaredLength !== null && declaredLength !== '' && /^\d+$/.test(declaredLength)
          ? Number(declaredLength)
          : undefined
      // The request's own body stream rides to the server UNREAD by us; the
      // browser's abort signal rides along so a cancelled picker closes the
      // relay round-trip too.
      const result = await relay.upload(
        { sessionId: parts.id, name: firstQuery(url, 'name'), body: request.body, bytes },
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
        return statusFailure(503, 'remote-offline', '服务端离线，远程会话暂时无法上传文件')
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
    return statusFailure(403, 'remote-unsupported', '远程会话不支持导出')
  }

  uploadEntry.fetch = wrappedUpload
  if (exportWrappable) (exportEntry as FetchRouteEntry).fetch = wrappedExport
  log?.(
    'fetch-route intercept installed (upload wrapped, export %s)',
    exportWrappable ? 'wrapped' : 'not present at install time',
  )

  return {
    uninstall() {
      if (!installed) return
      installed = false
      // Only replace while the entry still holds OUR wrapper — a later
      // wrapper chained over us captured this function, and restoring the
      // original would silently drop ITS wrap. Ours goes inert instead.
      if (uploadEntry.fetch === wrappedUpload) uploadEntry.fetch = savedUpload
      if (exportWrappable && (exportEntry as FetchRouteEntry).fetch === wrappedExport) {
        ;(exportEntry as FetchRouteEntry).fetch = savedExport as FetchRouteEntry['fetch']
      }
    },
    diagnostics(): FetchRouteInterceptDiagnostics {
      return {
        installed,
        shape,
        uploadWrapped: uploadEntry.fetch === wrappedUpload,
        exportWrapped: exportWrappable && (exportEntry as FetchRouteEntry).fetch === wrappedExport,
        ...counters,
        recentFailures: [...failures],
      }
    },
  }
}
