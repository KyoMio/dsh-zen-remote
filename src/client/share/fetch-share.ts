/**
 * Share-export fetching (ticket 05, PLAN §5.3): the ONE typed fetch over
 * GET /_dsh/mobile-nav/share-export, shared by the real share flow
 * (MobileSessionInfo) and the debug preview (?mobile-nav-share-preview=1)
 * so query assembly and error handling never fork into two copies.
 *
 * Module-shape rules (same reason as rasterize.ts): the share-image check
 * script imports this file through Node type stripping, which rejects JSX
 * and runs no browser API — so every import of a JSX-bearing module is
 * `import type` (fully erased) and browser globals appear only inside
 * function bodies. The query builder and the error taxonomy below are pure
 * and pinned there.
 */

// Type-only (erased both by tsc and by Node type stripping — see file
// header): share-card.tsx carries JSX, which the check script cannot execute.
import type { ShareTurn } from './share-card.tsx'

/** Route the host registers (mirror of src/share-export.ts — the client cannot import host code). */
export const SHARE_EXPORT_ROUTE = '/_dsh/mobile-nav/share-export'

/**
 * Which slice of the transcript to export — exactly the `range`/`turns` pair
 * the route validates (src/share-export.ts: `turns` next to `range=all` is a
 * 400, so it is only ever appended for `range=last`).
 */
export type ShareRange = { kind: 'all' } | { kind: 'last'; turns: number }

/** Preset turn counts the range sheet offers (PLAN §6: presets, no free input). */
export const SHARE_TURNS_PRESETS: readonly number[] = [3, 5, 10]

/**
 * Machine-readable fetch failure. `code` picks the localized copy; `status`
 * is the HTTP status when a response existed (undefined = the request never
 * completed). Fields are assigned in the constructor body, not declared as
 * parameter properties — Node type stripping rejects that syntax (same
 * reason as ShareRasterizeError / ShareExportError).
 */
export type ShareFetchErrorCode =
  /** 404 without the route's JSON envelope: this DSH never mounted the route (too old). */
  | 'route-missing'
  /** 404 + the route's own session-not-found code: the session is gone. */
  | 'session-not-found'
  /** 400: malformed query the client should not have built. */
  | 'bad-request'
  /** Any other non-ok status (route error, gateway 502, …). */
  | 'server'
  /** fetch() itself threw (offline, connection reset). */
  | 'network'
  /** 2xx but the body is not the agreed shape. */
  | 'bad-body'

/** Localizable fetch failure; ticket 05 maps `code` to locales shareErr*. */
export class ShareFetchError extends Error {
  readonly code: ShareFetchErrorCode
  readonly status: number | undefined

  constructor(code: ShareFetchErrorCode, status: number | undefined, detail: string) {
    super(`share-fetch/${code}${status === undefined ? '' : ` (HTTP ${status})`}: ${detail}`)
    this.name = 'ShareFetchError'
    this.code = code
    this.status = status
  }
}

/** A validated export payload (the route's 200 body minus the envelope). */
export interface ShareExportData {
  turns: ShareTurn[]
  createdAt: number | undefined
}

/**
 * Pure: assemble the route query. The session id arrives in its branded
 * `session-<uuid>` form (useSessions row / session-scoped slot prop) and is
 * passed through encodeURIComponent — a bare uuid would 404 (PLAN §2 note).
 */
export function buildShareExportQuery(session: string, range: ShareRange): string {
  const params = [`session=${encodeURIComponent(session)}`]
  params.push(range.kind === 'last' ? `range=last&turns=${range.turns}` : 'range=all')
  return `${SHARE_EXPORT_ROUTE}?${params.join('&')}`
}

/* ---- response validation ---------------------------------------------------- */

/** Loose shape of the route's error envelope ({ ok:false, error:{code,message} }). */
interface ErrorEnvelope { ok?: boolean; error?: { code?: unknown; message?: unknown } }

/** Loose shape of the route's success body before validation. */
interface SuccessBody { ok?: unknown; createdAt?: unknown; turns?: unknown }

function isShareBlockShape(block: unknown): block is { kind: 'text'; text: string } | { kind: 'image' } {
  if (typeof block !== 'object' || block === null) return false
  const kind = (block as { kind?: unknown }).kind
  if (kind === 'image') return true
  return kind === 'text' && typeof (block as { text?: unknown }).text === 'string'
}

function isShareTurnShape(turn: unknown): turn is ShareTurn {
  if (typeof turn !== 'object' || turn === null) return false
  const { role, seq, blocks } = turn as { role?: unknown; seq?: unknown; blocks?: unknown }
  return (role === 'user' || role === 'assistant')
    && typeof seq === 'number' && Number.isFinite(seq)
    && Array.isArray(blocks) && blocks.every(isShareBlockShape)
}

/**
 * Fetch one export and classify every failure.
 *
 * Error mapping (the reason a 404 is split in two): this plugin's route
 * answers 404 + `{error:{code:'session-not-found'}}` for an unknown session,
 * while a DSH old enough to lack the route answers the web server's own 404
 * — a different copy (“需要新版 DSH”) than “会话不存在”, decided by whether
 * our envelope is present.
 */
export async function fetchShareExport(session: string, range: ShareRange): Promise<ShareExportData> {
  let res: Response
  try {
    res = await fetch(buildShareExportQuery(session, range), { cache: 'no-store' })
  } catch (err) {
    throw new ShareFetchError('network', undefined, err instanceof Error ? err.message : String(err))
  }

  if (!res.ok) {
    let envelope: ErrorEnvelope | undefined
    try {
      envelope = await res.json() as ErrorEnvelope
    } catch {
      // Not JSON — an old DSH's plain 404 page or a gateway error page.
      envelope = undefined
    }
    const code = envelope?.error?.code
    const detail = typeof envelope?.error?.message === 'string' ? envelope.error.message : `HTTP ${res.status}`
    if (res.status === 404 && code === 'session-not-found') {
      throw new ShareFetchError('session-not-found', res.status, detail)
    }
    if (res.status === 404) {
      throw new ShareFetchError('route-missing', res.status, detail)
    }
    if (res.status === 400) {
      throw new ShareFetchError('bad-request', res.status, detail)
    }
    throw new ShareFetchError('server', res.status, detail)
  }

  let body: SuccessBody
  try {
    body = await res.json() as SuccessBody
  } catch (err) {
    throw new ShareFetchError('bad-body', res.status, err instanceof Error ? err.message : String(err))
  }
  if (body.ok !== true || !Array.isArray(body.turns) || !body.turns.every(isShareTurnShape)) {
    // Loud over lenient: silently dropping malformed rows would ship a
    // truncated transcript that LOOKS complete — the worst failure mode for
    // a share image.
    throw new ShareFetchError('bad-body', res.status, 'body is not a valid share-export payload')
  }
  return {
    turns: body.turns,
    createdAt: typeof body.createdAt === 'number' && Number.isFinite(body.createdAt) ? body.createdAt : undefined,
  }
}
