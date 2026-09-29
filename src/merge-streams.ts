/**
 * Pure mergers for the three GLOBAL calls (T23b-2): `workspace/follow` and
 * `session/control` are STREAMS whose frames carry no session-locating
 * argument, and `session/list` is an unscoped invoke — the sidebar reads all
 * three to render its tree, so a sub-client must see the server's shared
 * sessions merged INTO the local answer instead of in place of it.
 *
 * Frame and result shapes are the generated 0.2.0 codecs, field by field:
 * `workspace_follow_result` (baseline / upsert / remove / order / archived /
 * pinned), `session_control_result` (exactly two frame types: `baseline`
 * nesting `value.projections`, and one-key `projection` updates), and
 * `session_list_result` (`{ items }` — no cursor field). The same shapes the
 * server filters by (relay-filter.ts); remote frames arriving here have
 * ALREADY been narrowed to the shared sessions and carry ORIGINAL ids.
 *
 * The rules, mirroring tasks/T23b2.md:
 * - local frames pass through, except that `baseline` / `order` get the
 *   remote workspaces APPENDED to their order (remote groups sort after
 *   local) and the `archived` / `pinned` lists merge local + remote;
 * - a remote baseline NEVER travels as a second baseline — it would wipe the
 *   local data. It becomes one virtualized `upsert` per remote workspace,
 *   then the merged `order` / `archived` / `pinned`;
 * - remote frames that arrive before the local baseline are CACHED as state
 *   only — the UI has seen nothing yet, so emitting them would order
 *   workspaces the local baseline would immediately erase;
 * - `onRemoteGone` (relay down, unpaired, server changed) removes exactly
 *   what the UI was shown: one `remove` per known remote workspace plus the
 *   remote-free `order` / `archived` / `pinned`.
 *
 * Everything here is a pure state machine: no DSH imports, no network, no
 * clocks — the virtual-id arithmetic is the one dependency (virtual-id.ts).
 * Shapes are read defensively like relay-filter.ts does: a malformed frame is
 * dropped (diagnosed through the optional hook), never forwarded.
 */

import { toVirtual } from './virtual-id.js'

/** The (serverId, serverName) pair a merger virtualizes with. A re-handshake
 * with a different server retargets the SAME merger ({@link retarget}) so the
 * locally observed baseline/order state survives the swap. */
export interface MergerIdentity {
  serverId: string
  serverName: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The string prefix of a wire list — a malformed frame degrades to []. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** The local workspace-id order of a baseline `value.items` / order frame. */
function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const item of value) {
    if (isPlainObject(item) && typeof item.workspaceId === 'string') ids.push(item.workspaceId)
    else if (typeof item === 'string') ids.push(item)
  }
  return ids
}

/** One workspace record rewritten for the UI: ids virtualized, the title
 * prefixed with the server name, `path` untouched (a server-side display
 * path). Values are copied — the caller's frame is never mutated. */
function virtualizeWorkspace(record: Record<string, unknown>, identity: MergerIdentity): Record<string, unknown> {
  const virtualize = (id: string): string => toVirtual(identity.serverId, id)
  const out: Record<string, unknown> = { ...record }
  if (typeof record.workspaceId === 'string') out.workspaceId = virtualize(record.workspaceId)
  if (typeof record.title === 'string') out.title = `${identity.serverName} · ${record.title}`
  if (Array.isArray(record.sessionIds)) {
    out.sessionIds = record.sessionIds.map((id) => (typeof id === 'string' ? virtualize(id) : id))
  }
  return out
}

export interface WorkspaceMergerOptions extends MergerIdentity {
  /** Diagnostics for frames this merger dropped (unknown type or malformed).
   * Optional: without it the drop is silent. */
  onDiagnostic?: (message: string) => void
}

export interface WorkspaceMerger {
  readonly serverId: string
  readonly serverName: string
  /** Feed one frame of the LOCAL workspace/follow stream; returns the frames
   * the UI should see (usually exactly the input, order-merged when remote
   * state exists). */
  onLocal(frame: unknown): unknown[]
  /** Feed one server-filtered frame of the REMOTE stream; returns the frames
   * the UI should see (possibly none — state-only while the local baseline
   * has not passed). */
  onRemote(frame: unknown): unknown[]
  /** The remote leg died or the server changed: remove everything the UI was
   * shown from the remote side and reset the remote state. Idempotent — a
   * second call with no remote state returns []. */
  onRemoteGone(): unknown[]
  /** Point the merger at a (possibly different) server. Local state survives;
   * remote state must be gone before this runs (onRemoteGone first). */
  retarget(identity: MergerIdentity): void
}

/**
 * The workspace/follow merger. Remote state is a Map keyed by the ORIGINAL
 * workspace id whose INSERTION ORDER tracks the remote order (baseline sets
 * it, upsert appends new keys, order frames reorder it) — that sequence is
 * what gets appended to every local baseline/order that passes through.
 */
export function createWorkspaceMerger(options: WorkspaceMergerOptions): WorkspaceMerger {
  const onDiagnostic = options.onDiagnostic
  let identity: MergerIdentity = { serverId: options.serverId, serverName: options.serverName }

  // The locally observed truth, updated from every local baseline / order /
  // archived / pinned frame. Required to rebuild remote-free frames on
  // onRemoteGone and to merge remote ids INTO local order frames.
  let localSeen = false
  let localOrder: string[] = []
  let localArchived: string[] = []
  let localPinned: string[] = []

  // The remote truth in ORIGINAL ids; insertion order = remote order.
  const remote = new Map<string, Record<string, unknown>>()
  let remoteArchived: string[] = []
  let remotePinned: string[] = []

  const virtualize = (id: string): string => toVirtual(identity.serverId, id)
  const remoteIds = (): string[] => [...remote.keys()].map(virtualize)
  const remoteArchivedVirtual = (): string[] => remoteArchived.map(virtualize)
  const remotePinnedVirtual = (): string[] => remotePinned.map(virtualize)

  const virtualWorkspaces = (): Record<string, unknown>[] =>
    [...remote.values()].map((record) => virtualizeWorkspace(record, identity))
  const upsertFrames = (): unknown[] => virtualWorkspaces().map((workspace) => ({ type: 'upsert', workspace }))
  const mergedOrderFrame = (): unknown => ({ type: 'order', workspaceIds: [...localOrder, ...remoteIds()] })
  const mergedArchivedFrame = (): unknown => ({
    type: 'archived',
    archivedSessionIds: [...localArchived, ...remoteArchivedVirtual()],
  })
  const mergedPinnedFrame = (): unknown => ({
    type: 'pinned',
    pinnedSessionIds: [...localPinned, ...remotePinnedVirtual()],
  })

  /** Learn from a local frame without emitting anything. */
  function observeLocal(frame: Record<string, unknown>): void {
    if (frame.type === 'baseline') {
      const value = isPlainObject(frame.value) ? frame.value : {}
      localOrder = idList(value.items)
      localArchived = stringList(value.archivedSessionIds)
      localPinned = stringList(value.pinnedSessionIds)
      localSeen = true
      return
    }
    if (frame.type === 'order') {
      localOrder = stringList(frame.workspaceIds)
      return
    }
    if (frame.type === 'archived') {
      localArchived = stringList(frame.archivedSessionIds)
      return
    }
    if (frame.type === 'pinned') {
      localPinned = stringList(frame.pinnedSessionIds)
    }
  }

  function drop(message: string): void {
    onDiagnostic?.(message)
  }

  return {
    get serverId(): string {
      return identity.serverId
    },
    get serverName(): string {
      return identity.serverName
    },

    retarget(next: MergerIdentity): void {
      identity = { serverId: next.serverId, serverName: next.serverName }
    },

    onLocal(frame: unknown): unknown[] {
      if (!isPlainObject(frame)) return [frame]
      observeLocal(frame)
      // The local order carries the remote groups at its tail ONLY once
      // remote state exists — before that every local frame is verbatim.
      if (frame.type === 'baseline') {
        if (remote.size === 0 && remoteArchived.length === 0 && remotePinned.length === 0) return [frame]
        const value = isPlainObject(frame.value) ? frame.value : {}
        const items = Array.isArray(value.items) ? value.items : []
        // The baseline's own order already shows the remote groups; the
        // upserts that follow restate their content (the cached-remote path
        // never emits a separate order frame).
        return [
          {
            ...frame,
            value: {
              ...value,
              items: [...items, ...virtualWorkspaces()],
              archivedSessionIds: [...localArchived, ...remoteArchivedVirtual()],
              pinnedSessionIds: [...localPinned, ...remotePinnedVirtual()],
            },
          },
          ...upsertFrames(),
        ]
      }
      if (frame.type === 'order') {
        if (remote.size === 0) return [frame]
        return [mergedOrderFrame()]
      }
      if (frame.type === 'archived') {
        if (remoteArchived.length === 0) return [frame]
        return [mergedArchivedFrame()]
      }
      if (frame.type === 'pinned') {
        if (remotePinned.length === 0) return [frame]
        return [mergedPinnedFrame()]
      }
      // upsert / remove / anything else local: purely local facts.
      return [frame]
    },

    onRemote(frame: unknown): unknown[] {
      if (!isPlainObject(frame)) {
        drop('dropped a non-object workspace/follow frame from the relay')
        return []
      }
      switch (frame.type) {
        case 'baseline': {
          const value = isPlainObject(frame.value) ? frame.value : undefined
          remote.clear()
          if (value !== undefined && Array.isArray(value.items)) {
            for (const item of value.items) {
              if (isPlainObject(item) && typeof item.workspaceId === 'string') remote.set(item.workspaceId, { ...item })
            }
          }
          remoteArchived = value === undefined ? [] : stringList(value.archivedSessionIds)
          remotePinned = value === undefined ? [] : stringList(value.pinnedSessionIds)
          // Never a second baseline: the UI has either seen local data (which
          // it must keep) or nothing (cache only).
          if (!localSeen) return []
          return [...upsertFrames(), mergedOrderFrame(), mergedArchivedFrame(), mergedPinnedFrame()]
        }
        case 'upsert': {
          if (!isPlainObject(frame.workspace) || typeof frame.workspace.workspaceId !== 'string') {
            drop('dropped a workspace upsert without a workspaceId')
            return []
          }
          const workspace: Record<string, unknown> = frame.workspace
          const id = workspace.workspaceId as string
          const isNew = !remote.has(id)
          remote.set(id, { ...workspace })
          if (!localSeen) return []
          const out: unknown[] = [{ type: 'upsert', workspace: virtualizeWorkspace(workspace, identity) }]
          // A workspace the UI has not seen needs a position too.
          if (isNew) out.push(mergedOrderFrame())
          return out
        }
        case 'remove': {
          const id = typeof frame.workspaceId === 'string' ? frame.workspaceId : undefined
          if (id === undefined) {
            drop('dropped a workspace remove without a workspaceId')
            return []
          }
          // A remove of a workspace this merger never knew is a no-op: the UI
          // was never shown it.
          if (!remote.delete(id)) return []
          if (!localSeen) return []
          return [{ type: 'remove', workspaceId: virtualize(id) }, mergedOrderFrame()]
        }
        case 'order': {
          if (!Array.isArray(frame.workspaceIds)) {
            drop('dropped a workspace order frame without a workspaceIds array')
            return []
          }
          // Same reorder rule as the server's own state (relay-filter.ts):
          // mentioned ids first in frame order, unmentioned ones keep their
          // relative order behind them — a partial reorder drops nothing.
          const reordered = new Map<string, Record<string, unknown>>()
          for (const id of frame.workspaceIds) {
            if (typeof id !== 'string') continue
            const workspace = remote.get(id)
            if (workspace !== undefined) reordered.set(id, workspace)
          }
          for (const [id, workspace] of remote) {
            if (!reordered.has(id)) reordered.set(id, workspace)
          }
          remote.clear()
          for (const [id, workspace] of reordered) remote.set(id, workspace)
          if (!localSeen) return []
          return [mergedOrderFrame()]
        }
        case 'archived':
          remoteArchived = stringList(frame.archivedSessionIds)
          if (!localSeen) return []
          return [mergedArchivedFrame()]
        case 'pinned':
          remotePinned = stringList(frame.pinnedSessionIds)
          if (!localSeen) return []
          return [mergedPinnedFrame()]
        default:
          drop(`dropped a workspace/follow frame of unknown type ${String(frame.type)}`)
          return []
      }
    },

    onRemoteGone(): unknown[] {
      const hadAny = remote.size > 0 || remoteArchived.length > 0 || remotePinned.length > 0
      const out: unknown[] = []
      // The UI only ever SAW remote data when the local baseline had passed —
      // cached pre-baseline state is discarded silently instead.
      if (localSeen && hadAny) {
        for (const id of remote.keys()) out.push({ type: 'remove', workspaceId: virtualize(id) })
        out.push({ type: 'order', workspaceIds: [...localOrder] })
        out.push({ type: 'archived', archivedSessionIds: [...localArchived] })
        out.push({ type: 'pinned', pinnedSessionIds: [...localPinned] })
      }
      remote.clear()
      remoteArchived = []
      remotePinned = []
      return out
    },
  }
}

export interface ControlMergerOptions {
  serverId: string
  serverName?: string
  onDiagnostic?: (message: string) => void
}

export interface ControlMerger {
  readonly serverId: string
  readonly serverName: string
  /** Local control frames pass through untouched. */
  onLocal(frame: unknown): unknown[]
  /** Remote baseline → per-session per-key `projection` frames; remote
   * projection updates → virtualized. Unknown types are dropped. */
  onRemote(frame: unknown): unknown[]
  /** Always [] — the workspace merger removes the group; leftover projection
   * state for vanished virtual sessions is harmless. */
  onRemoteGone(): unknown[]
  retarget(identity: MergerIdentity): void
}

/**
 * The session/control merger. The control stream is key-value projection
 * traffic with no ordering constraints between sessions, so it needs no
 * caching and no baseline bookkeeping: local frames pass through, remote
 * frames get their session id virtualized, and a remote baseline is EXPLODED
 * into one `projection` frame per key (never a second baseline).
 */
export function createControlMerger(options: ControlMergerOptions): ControlMerger {
  const onDiagnostic = options.onDiagnostic
  let identity: MergerIdentity = { serverId: options.serverId, serverName: options.serverName ?? '' }
  const virtualize = (id: string): string => toVirtual(identity.serverId, id)

  return {
    get serverId(): string {
      return identity.serverId
    },
    get serverName(): string {
      return identity.serverName
    },

    retarget(next: MergerIdentity): void {
      identity = { serverId: next.serverId, serverName: next.serverName }
    },

    onLocal(frame: unknown): unknown[] {
      return [frame]
    },

    onRemote(frame: unknown): unknown[] {
      if (!isPlainObject(frame)) {
        onDiagnostic?.('dropped a non-object session/control frame from the relay')
        return []
      }
      if (frame.type === 'baseline') {
        const value = isPlainObject(frame.value) ? frame.value : undefined
        const projections = value !== undefined && isPlainObject(value.projections) ? value.projections : {}
        const out: unknown[] = []
        for (const [sessionId, projection] of Object.entries(projections)) {
          if (!isPlainObject(projection)) continue
          const values = isPlainObject(projection.values) ? projection.values : {}
          // The baseline gives one sequence number per projection record
          // (`asOfSeq`) — every key of that record rides it.
          const seq = typeof projection.asOfSeq === 'number' ? projection.asOfSeq : 0
          for (const key of Object.keys(values)) {
            out.push({ type: 'projection', sessionId: virtualize(sessionId), key, value: values[key], seq })
          }
        }
        return out
      }
      if (frame.type === 'projection') {
        if (typeof frame.sessionId !== 'string') {
          onDiagnostic?.('dropped a session/control projection frame without a sessionId')
          return []
        }
        return [{ ...frame, sessionId: virtualize(frame.sessionId) }]
      }
      onDiagnostic?.(`dropped a session/control frame of unknown type ${String(frame.type)}`)
      return []
    },

    onRemoteGone(): unknown[] {
      return []
    },
  }
}

/**
 * Merge one `session/list` result pair (first page only — the caller skips
 * paged requests). Local items keep their order and their pagination fields;
 * the remote items are appended with virtualized session ids. A missing or
 * malformed remote result means "remote said nothing" — the local result
 * passes back untouched.
 */
export function mergeSessionList(localResult: unknown, remoteResult: unknown, serverId: string): unknown {
  if (!isPlainObject(localResult)) return localResult
  if (!isPlainObject(remoteResult) || !Array.isArray(remoteResult.items)) return localResult
  const localItems = Array.isArray(localResult.items) ? localResult.items : []
  const virtualize = (id: string): string => toVirtual(serverId, id)
  const remoteItems = remoteResult.items.map((item) => {
    if (!isPlainObject(item) || typeof item.sessionId !== 'string') return item
    return { ...item, sessionId: virtualize(item.sessionId) }
  })
  return { ...localResult, items: [...localItems, ...remoteItems] }
}
