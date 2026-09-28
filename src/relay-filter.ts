/**
 * Pure wire-frame filters for the relay's streaming subscriptions (T22b).
 *
 * Two of DSH's subscriptions are GLOBAL — `workspace/follow` and
 * `session/control` carry every workspace and every session of the server,
 * while a paired desktop client may only see shared ones. Frames are filtered
 * HERE, one frame at a time, right before they are written to the client; the
 * upstream subscription stays unfiltered, which is what lets a later
 * share/unshare re-filter already-known state without re-reading anything.
 *
 * Frame shapes mirror the generated codecs in the 0.2.0
 * `lib/typert.remote-client.js` of `@deepseek-ai/dsh-api-workspace-controller`
 * / `-session-controller` / `-job-controller` (verified against the local
 * copies, docs/spike-relay.md §3): `baseline` is the only frame that nests its
 * payload under `value`; every increment frame carries its fields at the TOP
 * level (`{type:'upsert', workspace}`, `{type:'archived',
 * archivedSessionIds}`, …). A frame that does not match a known type is
 * dropped (null) rather than forwarded — an unrecognized frame is either a
 * future protocol or a hostile inject, and neither may reach the client.
 *
 * All functions are pure: the input is never mutated, filtered frames come
 * back as new objects, passthrough frames (`remove` / `order`, accessible
 * `projection`) come back unchanged.
 */

/** The accessibility oracle: true when a session may travel to this client. */
export type Accessibility = (sessionId: string) => boolean

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep the string ids that pass the check. A non-array is a malformed frame
 * (T22b-fix): filter to [] — when the shape cannot be trusted, nothing may
 * travel, not even the junk that happened to be there. */
function accessibleIds(value: unknown, isAccessible: Accessibility): unknown {
  if (!Array.isArray(value)) return []
  return value.filter((id) => typeof id === 'string' && isAccessible(id))
}

/**
 * One workspace with its session list narrowed. The workspace ITSELF always
 * survives: the desktop client must be able to create a session in any
 * server-side workspace, so an empty workspace is a valid, forwardable fact.
 */
function accessibleWorkspace(workspace: unknown, isAccessible: Accessibility): unknown {
  if (!isPlainObject(workspace)) return workspace
  return { ...workspace, sessionIds: accessibleIds(workspace.sessionIds, isAccessible) }
}

/**
 * Filter one `workspace/follow` frame. `baseline` and `upsert` keep every
 * workspace but narrow each `sessionIds`; `archived` / `pinned` narrow their
 * lists; `remove` / `order` carry no session ids and pass through unchanged;
 * anything else is dropped.
 */
export function filterWorkspaceFrame(frame: unknown, isAccessible: Accessibility): Record<string, unknown> | null {
  if (!isPlainObject(frame)) return null
  switch (frame.type) {
    case 'baseline': {
      const value = frame.value
      if (!isPlainObject(value)) return null
      const items = Array.isArray(value.items) ? value.items : []
      return {
        ...frame,
        value: {
          ...value,
          items: items.map((workspace) => accessibleWorkspace(workspace, isAccessible)),
          archivedSessionIds: accessibleIds(value.archivedSessionIds, isAccessible),
          pinnedSessionIds: accessibleIds(value.pinnedSessionIds, isAccessible),
        },
      }
    }
    case 'upsert':
      return { ...frame, workspace: accessibleWorkspace(frame.workspace, isAccessible) }
    case 'remove':
    case 'order':
      return frame
    case 'archived':
      return { ...frame, archivedSessionIds: accessibleIds(frame.archivedSessionIds, isAccessible) }
    case 'pinned':
      return { ...frame, pinnedSessionIds: accessibleIds(frame.pinnedSessionIds, isAccessible) }
    default:
      return null
  }
}

/**
 * Filter one `session/control` frame. Exactly two frame types exist:
 * `baseline{value:{projections: Record<sessionId, {asOfSeq, values}>}}` — the
 * per-session map keeps only accessible keys — and `projection{sessionId, key,
 * value, seq}` — kept whole or dropped by its session id. Anything else is
 * dropped.
 *
 * The baseline record is rebuilt with `defineProperty` because a session id of
 * `__proto__` must become an own data property of the new record, not fire the
 * prototype setter (the same trap share-store.ts documents for its file keys).
 */
export function filterControlFrame(frame: unknown, isAccessible: Accessibility): Record<string, unknown> | null {
  if (!isPlainObject(frame)) return null
  if (frame.type === 'baseline') {
    const value = frame.value
    if (!isPlainObject(value)) return null
    const projections = isPlainObject(value.projections) ? value.projections : {}
    const filtered: Record<string, unknown> = {}
    for (const [sessionId, projection] of Object.entries(projections)) {
      if (!isAccessible(sessionId)) continue
      Object.defineProperty(filtered, sessionId, {
        value: projection,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return { ...frame, value: { ...value, projections: filtered } }
  }
  if (frame.type === 'projection') {
    return typeof frame.sessionId === 'string' && isAccessible(frame.sessionId) ? frame : null
  }
  return null
}

/**
 * Filter one `session/list` result (the invoke route forwards it as the
 * enveloped value): `items` keeps only entries whose `sessionId` is
 * accessible, every other field of the result (and of each kept item) passes
 * through as-is. The result arrives from the same JSON boundary as the frames
 * but it is a RESULT, not a frame — there is no unknown-shape refusal here; a
 * result without an `items` array simply has nothing to filter.
 */
export function filterSessionListResult(result: unknown, isAccessible: Accessibility): unknown {
  if (!isPlainObject(result)) return result
  const items = result.items
  if (!Array.isArray(items)) return { ...result }
  return {
    ...result,
    items: items.filter(
      (item) => isPlainObject(item) && typeof item.sessionId === 'string' && isAccessible(item.sessionId),
    ),
  }
}

/**
 * Filter one `job/list` frame (`{type:'rows', jobs:[…]}` — the only frame type
 * the stream emits). DSH opens every OWNERLESS job to all sessions, so the
 * unfiltered stream would leak server-wide jobs through any shared session;
 * the relay keeps only jobs whose `owner` is exactly the session the client
 * claimed in `request.sessionId`. Ownerless jobs (`owner` absent) are
 * therefore invisible remotely — including for `job/follow` / `job/kill`,
 * which the relay refuses separately (relay-server.ts).
 */
export function filterJobListFrame(frame: unknown, ownerSessionId: string): Record<string, unknown> | null {
  if (!isPlainObject(frame) || frame.type !== 'rows') return null
  const jobs = frame.jobs
  // A non-array jobs field is a malformed frame (T22b-fix): an empty list
  // travels — the frame shape survives, none of the untrusted rows do.
  if (!Array.isArray(jobs)) return { ...frame, jobs: [] }
  return { ...frame, jobs: jobs.filter((job) => isPlainObject(job) && job.owner === ownerSessionId) }
}

/**
 * The unfiltered latest workspace state behind ONE `workspace/follow` relay
 * stream, maintained from the raw upstream frames so a share/unshare can
 * synthesize the frames the client missed (relay-server.ts writes them as if
 * the workspace had just been upserted).
 */
export interface WorkspaceFollowState {
  /** Feed one raw upstream frame (baseline / upsert / remove / order /
   * archived / pinned); unknown frames are ignored. */
  apply(frame: unknown): void
  /**
   * Frames to write after `sessionId` was shared or unshared: one re-filtered
   * `upsert` per workspace currently containing it, plus one `archived` /
   * `pinned` frame when the session sits in those lists. Running the
   * synthesized frames back through {@link filterWorkspaceFrame} keeps their
   * shape identical to real upstream frames — and naturally drops the session
   * after an unshare.
   */
  onShareChange(sessionId: string, isAccessible: Accessibility): Record<string, unknown>[]
}

export function createWorkspaceFollowState(): WorkspaceFollowState {
  /** Insertion order tracks the workspace order (baseline, adjusted by
   * `order` frames), which decides the order of synthesized upserts. */
  const workspaces = new Map<string, Record<string, unknown>>()
  let archived: unknown[] = []
  let pinned: unknown[] = []

  const storeList = (value: unknown): unknown[] => (Array.isArray(value) ? [...(value as unknown[])] : [])

  return {
    apply(frame: unknown): void {
      if (!isPlainObject(frame)) return
      switch (frame.type) {
        case 'baseline': {
          const value = frame.value
          if (!isPlainObject(value)) return
          workspaces.clear()
          if (Array.isArray(value.items)) {
            for (const workspace of value.items) {
              if (isPlainObject(workspace) && typeof workspace.workspaceId === 'string') {
                workspaces.set(workspace.workspaceId, { ...workspace })
              }
            }
          }
          archived = storeList(value.archivedSessionIds)
          pinned = storeList(value.pinnedSessionIds)
          return
        }
        case 'upsert':
          if (isPlainObject(frame.workspace) && typeof frame.workspace.workspaceId === 'string') {
            workspaces.set(frame.workspace.workspaceId, { ...frame.workspace })
          }
          return
        case 'remove':
          if (typeof frame.workspaceId === 'string') workspaces.delete(frame.workspaceId)
          return
        case 'order': {
          if (!Array.isArray(frame.workspaceIds)) return
          const ordered = new Map<string, Record<string, unknown>>()
          for (const id of frame.workspaceIds) {
            const workspace = typeof id === 'string' ? workspaces.get(id) : undefined
            if (workspace !== undefined) ordered.set(id, workspace)
          }
          // Workspaces the order frame did not mention keep their relative
          // order at the end — a partial reorder must not drop anything.
          for (const [id, workspace] of workspaces) {
            if (!ordered.has(id)) ordered.set(id, workspace)
          }
          workspaces.clear()
          for (const [id, workspace] of ordered) workspaces.set(id, workspace)
          return
        }
        case 'archived':
          if (Array.isArray(frame.archivedSessionIds)) archived = [...frame.archivedSessionIds]
          return
        case 'pinned':
          if (Array.isArray(frame.pinnedSessionIds)) pinned = [...frame.pinnedSessionIds]
          return
        default:
          return
      }
    },

    onShareChange(sessionId: string, isAccessible: Accessibility): Record<string, unknown>[] {
      const frames: Record<string, unknown>[] = []
      for (const workspace of workspaces.values()) {
        const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
        if (!sessionIds.includes(sessionId)) continue
        const upsert = filterWorkspaceFrame({ type: 'upsert', workspace: { ...workspace } }, isAccessible)
        if (upsert !== null) frames.push(upsert)
      }
      if (archived.includes(sessionId)) {
        const frame = filterWorkspaceFrame({ type: 'archived', archivedSessionIds: [...archived] }, isAccessible)
        if (frame !== null) frames.push(frame)
      }
      if (pinned.includes(sessionId)) {
        const frame = filterWorkspaceFrame({ type: 'pinned', pinnedSessionIds: [...pinned] }, isAccessible)
        if (frame !== null) frames.push(frame)
      }
      return frames
    },
  }
}
