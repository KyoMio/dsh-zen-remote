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
 * The rules, mirroring tasks/T23b2.md as corrected by tasks/T23b2-fix.md:
 * - local frames pass through, except that `baseline` / `order` get the
 *   remote workspaces APPENDED to their order (remote groups sort after
 *   local) and the `archived` / `pinned` lists merge local + remote;
 * - a remote baseline NEVER travels as a second baseline — it would wipe the
 *   local data. It becomes one virtualized `upsert` per remote workspace,
 *   then the merged `order` / `archived` / `pinned`;
 * - remote frames that arrive before the local baseline are CACHED as state
 *   only — the UI has seen nothing yet, so emitting them would order
 *   workspaces the local baseline would immediately erase;
 * - a remote stream that died (or a merely offline relay) emits NOTHING and
 *   keeps the shown state ({@link WorkspaceMerger.onRemoteDown}): the UI's
 *   `ClientWorkspaceModel.remove()` records ids in a never-cleared blacklist
 *   and both `upsert` and baseline replacement drop blacklisted ids, so one
 *   `remove` for a virtual id would make that group un-revivable on
 *   reconnect — while the UI itself keeps the last complete projection
 *   visible across carrier loss (its `handleCarrierFailure`);
 * - a NEW remote baseline on the same server is DIFFED against the shown
 *   set: still present → fresh `upsert` (content from the new baseline),
 *   absent (deleted server-side / no longer shared) → `remove`, then the
 *   merged `order` / `archived` / `pinned`;
 * - a server RENAME (same serverId) re-upserts the shown groups under the
 *   new title — no removals ({@link WorkspaceMerger.onServerRenamed});
 * - only a serverId CHANGE removes the whole group
 *   ({@link WorkspaceMerger.onRemoteGone}): the new prefix is fresh, so it
 *   can never collide with the UI's blacklist. The relay entering
 *   `unpaired` / `revoked` is NOT this case (T23b2-fix3): the server
 *   persists its serverId (relay-server.ts loadServerId), so a re-pair to
 *   the same server reuses the prefix and is handled as a remote death
 *   ({@link WorkspaceMerger.onRemoteDown}) — the reconnect diff revives
 *   the group;
 * - a relay status that is not serving normally (T34: offline, unpaired,
 *   revoked, interface mismatch) only ANNOTATES TITLES: setStatus +
 *   onStatusChanged re-upsert the shown groups under the annotated titles,
 *   and the reconnecting baseline (which always upserts) restores them.
 * - a session the SERVER stopped serving (remote closed / idle-slept / its
 *   fork parent closed → the filtered workspace upsert drops it from
 *   `sessionIds`) keeps a TOMBSTONE in the group it was last seen in (CP4,
 *   reworked by CP4-client-fix2): the merger remembers the workspace each
 *   session id was last carried by, and the forwarded record for THAT
 *   workspace still lists the id (appended at the end of `sessionIds`). The
 *   UI's session store keeps the merged projection/list entry and nothing
 *   ever removes it, so without this the sidebar would park the session in
 *   「未分组」 forever — and hiding it in the merged `archived` frame instead
 *   (what CP4-client first did) makes the RT navigation guard
 *   `clearArchivedCurrent` (dsh-client-ui-workspace `watchNavigation`) kick
 *   the OPEN session page back to the home page before its 「远程已关闭」
 *   banner can show. A re-share (the id back in some workspace's
 *   `sessionIds`) renders it live again and clears the tombstone; the
 *   tombstone dies with its workspace (a remove) and with the identity
 *   (onRemoteGone).
 * - T58 reworks the tombstone's VISIBILITY, reshaped by T65: a closed-remote
 *   session is HIDDEN — moved into the merged `archived` set (the host's
 *   `sessionVisible` hides archived ids under the default filter) — while
 *   STAYING in its group's forwarded `sessionIds`: under「显示已归档」it
 *   renders in place, and it can never resurface as a 「未分组」 stray. The
 *   one exception is the session the user currently has OPEN: it is not
 *   hidden at all (the page must keep its 「远程已关闭」 banner), and once
 *   the caller reports a different current session
 *   ({@link WorkspaceMerger.setCurrentSession}) it moves into `archived`
 *   too. `archived` is exactly what the host's navigation guard
 *   `clearArchivedCurrent` acts on, so the CURRENT session may never enter
 *   it — and an unreadable current-session signal falls back to the
 *   conservative tombstone behavior (nothing is hidden). Because the
 *   browser's report can lag the user's switch by up to a poll interval, a
 *   JUST-created tombstone is not hidden for a short grace (T65, injectable
 *   clock): the 1s poll re-judges with the fresh report afterwards — the
 *   session the user really switched to keeps its tombstone, anything else
 *   hides. Re-sharing the session takes it back out of `archived`
 *   (live-carried ids never count as hidden). Since hiding moves only the
 *   archived set, hide/reveal updates are exactly one merged archived frame
 *   — no group content changes, no ordering dance; the current session
 *   never enters the set by construction. The hidden ids are sticky: they
 *   survive even the death of their home workspace until a re-share or the
 *   identity ends.
 * - a workspace with NOTHING to show is not shown at all (T56): the server
 *   keeps every workspace and only narrows `sessionIds` (relay-filter.ts),
 *   so a workspace where nothing is shared would arrive as an empty group
 *   and render as a bare 「服务端名 · 工作区名」 heading. A workspace the UI
 *   has never seen is therefore held back — no baseline item, no upsert, no
 *   order entry — until its forwarded `sessionIds` (live sessions or
 *   tombstones it must carry) first gains content. From that first forward
 *   on it counts as SHOWN and stays shown even when the sessions leave
 *   again: a `remove` would blacklist the id in the UI's ClientWorkspaceModel
 *   and make the group un-revivable, so an emptied group keeps its (empty)
 *   display until the page reload rebuilds the model and this rule hides it
 *   again. Every removal path — the reconnecting baseline diff, an explicit
 *   server remove, {@link WorkspaceMerger.onRemoteGone} — emits a `remove`
 *   only for shown workspaces; never-shown ones leave the state silently.
 *
 * Two KNOWN LIMITATIONS, both rooted in the UI's `removedIds` blacklist
 * never clearing during a page's life (a reload rebuilds the model from
 * scratch, which is why a reload fixes both):
 * - switch to a DIFFERENT server and later back to the SAME old one: the
 *   switch-away removed the old prefix, so the returning group's upserts
 *   are dropped by the blacklist and it stays invisible until the page is
 *   reloaded;
 * - the server deletes a workspace and later shares a NEW workspace under
 *   the SAME id: the deletion's remove blacklists the id, and the new
 *   workspace's upserts are dropped the same way.
 *
 * Everything here is a pure state machine: no DSH imports, no network, no
 * clocks — the virtual-id arithmetic is the one dependency (virtual-id.ts).
 * Shapes are read defensively like relay-filter.ts does: a malformed frame is
 * dropped (diagnosed through the optional hook), never forwarded.
 *
 * T52 adds two RESULT-side pure helpers on the same principles:
 * {@link mergeModelCatalogs} folds the relay's `session/modelCatalog` answer
 * into the local one (the catalog is the model-selection dropdown's data), and
 * {@link virtualizeModelSelectionValue} rewrites a `modelSelection` projection
 * value's provider ids to virtual group ids so the UI can find the current
 * model's display name in the merged catalog.
 *
 * T52-fix2 made that rewrite CONDITIONAL on the server catalog listing the
 * provider; T52-fix3 reverts it to UNCONDITIONAL, and the revert is final:
 * the host's projection store is FIRST-WRITE-WINS per sequence number
 * (dsh-api-session-controller lib/client.js:986-994 —
 * `if (row?.kind === "sequenced" && seq <= row.seq) return`, and the
 * seed / list blocks take the same road). A projection rewritten ORIGINAL
 * while the catalog had not landed yet occupies its seq; when the catalog
 * arrives, the same seq's VIRTUAL value is dropped as stale — the server
 * group never gets its check mark, and resubmitting a reasoning effort
 * echoes the ORIGINAL provider back, which `session/selectModel`'s routing
 * refuses ("请选择「服务端 · …」分组里的模型"). The rewrite of ONE provider
 * must therefore not depend on when the catalog happened to arrive. The
 * accepted cost: a provider absent from the server's OWN catalog renders the
 * `zr~<serverId>~provider/model` fallback string (the pre-fix2 display).
 */

import { fromVirtual, isVirtual, toVirtual } from './virtual-id.js'

/** The (serverId, serverName) pair a merger virtualizes with. A re-handshake
 * with a different server retargets the SAME merger ({@link retarget}) so the
 * locally observed baseline/order state survives the swap. */
export interface MergerIdentity {
  serverId: string
  serverName: string
}

/**
 * The status annotation (T34) appended to every shown remote group's title
 * while the relay is not serving normally. The CALLER (intercept.ts) maps the
 * relay state onto one annotation — `revoked` / `unpaired` outrank `offline`,
 * which outranks `mismatch` — and the merger only renders the suffix it is
 * told to. The suffixes are the CHINESE copy, deliberately hardcoded here:
 * this module is background code with no access to the UI language (the
 * English forms live in src/client/locales.ts, `remoteGroup*` keys).
 */
export type MergerAnnotation = 'none' | 'offline' | 'revoked' | 'unpaired' | 'mismatch'

const ANNOTATION_SUFFIX: Record<Exclude<MergerAnnotation, 'none'>, string> = {
  offline: '（离线）',
  revoked: '（令牌已吊销）',
  unpaired: '（已解除配对）',
  mismatch: '（版本有差异）',
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
 * prefixed with the server name and — while an annotation is set — suffixed
 * with its status copy. Values are copied — the caller's frame is never
 * mutated. */
function virtualizeWorkspace(
  record: Record<string, unknown>,
  identity: MergerIdentity,
  annotation: MergerAnnotation,
): Record<string, unknown> {
  const virtualize = (id: string): string => toVirtual(identity.serverId, id)
  const out: Record<string, unknown> = { ...record }
  if (typeof record.workspaceId === 'string') out.workspaceId = virtualize(record.workspaceId)
  if (typeof record.title === 'string') {
    const suffix = annotation === 'none' ? '' : ANNOTATION_SUFFIX[annotation]
    out.title = `${identity.serverName} · ${record.title}${suffix}`
  }
  if (Array.isArray(record.sessionIds)) {
    out.sessionIds = record.sessionIds.map((id) => (typeof id === 'string' ? virtualize(id) : id))
  }
  return out
}

export interface WorkspaceMergerOptions extends MergerIdentity {
  /** Diagnostics for frames this merger dropped (unknown type or malformed).
   * Optional: without it the drop is silent. */
  onDiagnostic?: (message: string) => void
  /** T65: the clock the tombstone hide-grace runs on. Default Date.now;
   * tests advance an injectable fake to cross the grace. */
  now?: () => number
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
   * has not passed). A later baseline is DIFFED against what was shown. */
  onRemote(frame: unknown): unknown[]
  /** The remote stream died or the relay went offline (the same server is
   * expected back): emits NOTHING and keeps the shown state — the UI keeps
   * the last projection visible across carrier loss, and a `remove` here
   * would blacklist the virtual ids against revival. */
  onRemoteDown(): unknown[]
  /** The remote side is gone FOR GOOD under THIS identity: a serverId
   * change. (Since T23b2-fix3 an `unpaired` / `revoked` relay is NOT this
   * case — the same serverId comes back on re-pair, so the caller uses
   * {@link onRemoteDown} there.) Removes everything shown from the remote
   * side, resets the remote state. Idempotent — a second call with no
   * remote state returns []. */
  onRemoteGone(): unknown[]
  /** The server was renamed (same serverId — call after {@link retarget}):
   * re-upserts every shown workspace under the new title, nothing else. */
  onServerRenamed(): unknown[]
  /** Record the status annotation (T34) future virtualized titles carry. No
   * frames on its own — pair it with {@link onStatusChanged} to re-upsert the
   * shown groups under the new annotation, or let the next natural upserts
   * (a reconnecting baseline) carry it. */
  setStatus(annotation: MergerAnnotation): void
  /** Re-upsert every SHOWN workspace under the CURRENT annotation: the whole
   * update when the relay's serving status changed without any remote frame
   * (offline, revoked, unpaired, version mismatch). [] while nothing is
   * shown (no local baseline yet, or no remote state). */
  onStatusChanged(): unknown[]
  /** Record the session id the UI currently has OPEN (T58) — the raw id as
   * the UI knows it (a virtual id for a remote session, a local id
   * otherwise); `undefined` means a READABLE signal says no session is
   * open. An UNREADABLE signal is expressed by not calling this at all —
   * the merger then keeps every tombstone (the conservative fallback).
   * Returns the frames that apply the resulting hide transitions ([] when
   * nothing changed). */
  setCurrentSession(sessionId: string | undefined): unknown[]
  /** Whether some closed-remote session is being kept visible — it is the
   * current session (waiting for the user to navigate away), or the current
   * session was never readable (conservative fallback). While true the
   * caller should keep polling {@link setCurrentSession} at ≥1s intervals. */
  readonly hasPendingHide: boolean
  /** Point the merger at a (possibly different) server. Local state survives;
   * for a serverId change the remote state must be gone first (onRemoteGone
   * first); for a rename it may stay. */
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

  // The remote truth in ORIGINAL ids; insertion order = remote order. A
  // reconnecting baseline diffs its content against this; what the UI has
  // ever been SHOWN is tracked beside it (the `shown` set, T56).
  let remote = new Map<string, Record<string, unknown>>()
  let remoteArchived: string[] = []
  let remotePinned: string[] = []
  // The tombstone registry (CP4-client-fix2): every session id any remote
  // workspace has ever carried for this identity (original ids) → the
  // original workspace id that LAST carried it. A session the server stopped
  // serving (remote closed → the filtered workspace upsert drops it from
  // `sessionIds`) keeps its UI entry, so the forwarded record of its last
  // workspace still lists it. Entries die when the session is carried again
  // (re-shared, anywhere — the home moves with it), when its workspace is
  // removed, and with the identity (onRemoteGone).
  let sessionHome = new Map<string, string>()
  // T56: the workspace ids (originals) the UI has EVER been shown. The UI's
  // ClientWorkspaceModel blacklists removed ids for the page's whole life, so
  // only a shown workspace may ever receive a `remove` — and a workspace the
  // UI never saw stays invisible while its forwarded sessionIds (live
  // sessions + tombstones) is empty, instead of rendering as an empty
  // 「服务端名 · 工作区名」 group. Once shown, a workspace stays shown even
  // when its last session leaves (no remove — the blacklist would make the
  // id un-revivable); the page reload rebuilds the model and the emptied
  // group then never comes back.
  const shown = new Set<string>()
  // T58: the raw session id the UI currently has open, exactly as read from
  // the host's persisted selection store — a virtual id for a remote
  // session, a local id otherwise. The CALLER distinguishes an UNREADABLE
  // signal (no usable storage) from a readable "no session is open" by not
  // calling {@link setCurrentSession} at all in the former case — so
  // `currentReadable` is what gates the conservative fallback, and
  // `currentRaw === undefined` once readable means a real "nothing open".
  // Devirtualized on use, so a rename needs no re-write and a foreign/local
  // id naturally means "no remote session of ours is current".
  let currentRaw: string | undefined = undefined
  let currentReadable = false
  // T58: the original session ids this merger moved into the merged
  // `archived` set because their remote closed while they were not the
  // current session. STICKY: entries survive even the death of their home
  // workspace (a hidden session whose group is deleted must not resurface
  // as a 「未分组」 stray) until the session is live-carried again (re-share)
  // or the identity ends (onRemoteGone). Never contains the current
  // session — the host's clearArchivedCurrent would kick its open page.
  const hiddenSessions = new Set<string>()
  // T65: when each tombstone was CREATED (the moment a close frame dropped a
  // live id), for the hide grace below. Entries die with the tombstone: a
  // re-carried id leaves, a forgotten workspace takes its ids, the identity
  // end clears the rest.
  const closedAt = new Map<string, number>()
  // The status annotation every virtualized title currently carries (T34).
  let annotation: MergerAnnotation = 'none'
  const now = options.now ?? Date.now

  const virtualize = (id: string): string => toVirtual(identity.serverId, id)
  // Only SHOWN workspaces travel in order frames (T56): a hidden group has no
  // position the UI knows about.
  const remoteIds = (): string[] => [...remote.keys()].filter((id) => shown.has(id)).map(virtualize)
  const remoteArchivedVirtual = (): string[] => remoteArchived.map(virtualize)
  const remotePinnedVirtual = (): string[] => remotePinned.map(virtualize)

  /** Learn the session ids one remote workspace record carries: each id is
   * remembered under THIS workspace as its last home (originals, cumulative). */
  function learnSessions(record: Record<string, unknown>, workspaceId: string): void {
    if (!Array.isArray(record.sessionIds)) return
    for (const id of record.sessionIds) if (typeof id === 'string') sessionHome.set(id, workspaceId)
  }

  /** Drop the ids whose last home was this workspace — tombstones die with
   * their group (a server remove / a workspace diffed away; a session that
   * moved on lives under its NEW home and survives this). */
  function forgetWorkspace(workspaceId: string): void {
    for (const [id, home] of sessionHome) {
      if (home === workspaceId) {
        sessionHome.delete(id)
        closedAt.delete(id)
      }
    }
  }

  /** T65: stamp the ids that JUST left a workspace's live list (their
   * tombstones were created by this frame) and clear the ones that came
   * back. The grace window is judged from these stamps. */
  function noteClosedTransitions(prevRecord: Record<string, unknown> | undefined, nextRecord: Record<string, unknown>): void {
    const prevLive = prevRecord === undefined ? [] : stringList(prevRecord.sessionIds)
    const nextLive = stringList(nextRecord.sessionIds)
    const stamp = now()
    for (const id of prevLive) {
      if (!nextLive.includes(id)) closedAt.set(id, stamp)
    }
    for (const id of nextLive) {
      if (closedAt.has(id)) closedAt.delete(id)
    }
  }

  /** The CURRENT session as an ORIGINAL id of THIS server — undefined when
   * no readable current is known, it is a local session, or it belongs to
   * another server. All three mean "no remote session of ours is open". */
  function currentOriginal(): string | undefined {
    if (currentRaw === undefined) return undefined
    const parts = fromVirtual(currentRaw)
    return parts !== undefined && parts.serverId === identity.serverId ? parts.id : undefined
  }

  /** The hide grace (T65): a freshly closed session is not hidden for this
   * long, because the browser's current-session report can lag the user's
   * switch by up to a poll interval — a close frame naming the session the
   * user JUST opened would read the stale value and archive the open page
   * (the host's clearArchivedCurrent kicks it home). The 1s poll re-judges
   * with the fresh report once the grace passes. */
  const TOMBSTONE_HIDE_GRACE_MS = 2_000

  /** T58: whether the tombstone of `id` is HIDDEN (moved into the merged
   * archived set) rather than kept visible in its group. Only an actually
   * readable current-session signal hides anything: before the first
   * {@link WorkspaceMerger.setCurrentSession} call, every tombstone stays
   * (the conservative fallback) — and a JUST-created tombstone stays for
   * the grace regardless (T65). */
  function hideTombstone(id: string): boolean {
    if (!currentReadable) return false
    const closed = closedAt.get(id)
    if (closed !== undefined && now() - closed < TOMBSTONE_HIDE_GRACE_MS) return false
    return currentOriginal() !== id
  }

  /** T58: re-derive {@link hiddenSessions} from the live tombstone set —
   * tombstones hide unless they ARE the current session (or no readable
   * current is known, or the tombstone is inside the T65 hide grace);
   * live-carried ids and ids that (re-)became the current session leave the
   * set. Since T65 the hide/reveal transitions move ONLY the archived set —
   * the session stays in its group's forwarded copy either way — so the
   * caller emits just the merged archived frame when anything changed. */
  function syncHiddenSessions(): { hidden: string[]; revealed: string[] } {
    const hidden: string[] = []
    const revealed: string[] = []
    for (const [id, home] of sessionHome) {
      const record = remote.get(home)
      if (record === undefined) continue
      if (stringList(record.sessionIds).includes(id)) {
        if (hiddenSessions.delete(id)) revealed.push(id)
        continue
      }
      if (hideTombstone(id)) {
        if (!hiddenSessions.has(id)) {
          hiddenSessions.add(id)
          hidden.push(id)
        }
      } else if (hiddenSessions.delete(id)) {
        revealed.push(id)
      }
    }
    return { hidden, revealed }
  }

  /** One workspace record as the UI should see it: virtualized, PLUS the
   * tombstones — ids whose last home is this workspace but that the server's
   * record no longer carries — appended at the end of `sessionIds`
   * (CP4-client-fix2). Liveness is judged against the record's ORIGINAL
   * sessionIds (the registry stores originals; the forwarded copy is
   * virtualized). Since T65 a HIDDEN tombstone rides the group too: the
   * session stays in its group so the host's「显示已归档」filter can show it
   * in place — hiding is purely the archived set. */
  function forwardWorkspace(record: Record<string, unknown>): Record<string, unknown> {
    const out = virtualizeWorkspace(record, identity, annotation)
    const workspaceId = typeof record.workspaceId === 'string' ? record.workspaceId : undefined
    const live = stringList(record.sessionIds)
    if (workspaceId === undefined || !Array.isArray(out.sessionIds)) return out
    for (const [id, home] of sessionHome) {
      if (home === workspaceId && !live.includes(id)) out.sessionIds.push(virtualize(id))
    }
    return out
  }
  /** T56: the forwarded record when the UI may see this workspace, else
   * undefined — a never-shown workspace is forwarded only once its forwarded
   * sessionIds first carries VISIBLE content, and forwarding it marks it
   * shown for good. Only call on paths that actually emit (after the local
   * baseline has passed): a mark here is a claim that the UI now holds the
   * group. Visible means NOT hidden (T65): the host draws a group heading
   * even when every member is archived-invisible under the default filter,
   * so a group whose members are all hidden must not be first-shown —
   * the forwarded copy itself still carries the hidden ids. */
  function forwardVisible(record: Record<string, unknown>): Record<string, unknown> | undefined {
    const id = typeof record.workspaceId === 'string' ? record.workspaceId : undefined
    if (id !== undefined && shown.has(id)) return forwardWorkspace(record)
    const out = forwardWorkspace(record)
    const ids = Array.isArray(out.sessionIds) ? out.sessionIds : []
    let visible = false
    for (const virtualId of ids) {
      const parts = fromVirtual(virtualId)
      if (parts !== undefined && parts.serverId === identity.serverId && hiddenSessions.has(parts.id)) continue
      visible = true
      break
    }
    if (!visible) return undefined
    if (id !== undefined) shown.add(id)
    return out
  }
  const virtualWorkspaces = (): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = []
    for (const record of remote.values()) {
      const forwarded = forwardVisible(record)
      if (forwarded !== undefined) out.push(forwarded)
    }
    return out
  }
  const upsertFrames = (): unknown[] => virtualWorkspaces().map((workspace) => ({ type: 'upsert', workspace }))
  const mergedOrderFrame = (): unknown => ({ type: 'order', workspaceIds: [...localOrder, ...remoteIds()] })
  /** The merged archived set: local, then remote-archived, then the T58
   * hidden closed-remote sessions, deduplicated in that order. Closed
   * sessions that are NOT hidden keep their group slot as tombstones
   * (CP4-client-fix2), and the RT navigation guard keys on exactly this
   * list — which is why the CURRENT session never enters it. */
  function mergedArchivedIds(): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    const add = (ids: string[]): void => {
      for (const id of ids) {
        if (seen.has(id)) continue
        seen.add(id)
        out.push(id)
      }
    }
    add(localArchived)
    add(remoteArchivedVirtual())
    add([...hiddenSessions].map(virtualize))
    return out
  }
  const mergedArchivedFrame = (): unknown => ({ type: 'archived', archivedSessionIds: mergedArchivedIds() })
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
        // T58: the cached tombstones become decidable at the flush — sync
        // BEFORE building, so the baseline's items (hidden tombstones
        // dropped) and its archived list (hidden ids added) agree atomically
        // in the one frame.
        syncHiddenSessions()
        const shownWorkspaces = virtualWorkspaces()
        // Nothing VISIBLE (T56 — a remote full of hidden empty groups counts
        // as nothing) and no lists to merge: the frame passes verbatim.
        if (
          shownWorkspaces.length === 0 &&
          remoteArchived.length === 0 &&
          remotePinned.length === 0 &&
          sessionHome.size === 0 &&
          hiddenSessions.size === 0
        ) {
          return [frame]
        }
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
              items: [...items, ...shownWorkspaces],
              archivedSessionIds: mergedArchivedIds(),
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
        // T58-fix: with hidden sessions around, the local list must travel
        // merged — verbatim it would WIPE the hidden ids from the UI's
        // archived set and flush them back as 「未分组」 strays.
        if (remoteArchived.length === 0 && hiddenSessions.size === 0) return [frame]
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
          // Build the new remote truth beside the shown one, then DIFF
          // (T23b2-fix): a reconnecting baseline must not blindly re-add —
          // the upserts refresh content, and the only removes it synthesizes
          // are workspaces the server dropped (deleted / no longer shared).
          const next = new Map<string, Record<string, unknown>>()
          if (value !== undefined && Array.isArray(value.items)) {
            for (const item of value.items) {
              if (isPlainObject(item) && typeof item.workspaceId === 'string') next.set(item.workspaceId, { ...item })
            }
          }
          const nextArchived = value === undefined ? [] : stringList(value.archivedSessionIds)
          const nextPinned = value === undefined ? [] : stringList(value.pinnedSessionIds)
          // The session inventory is cumulative — a baseline only ever adds
          // known session ids (each under the workspace now carrying it).
          for (const [id, record] of next) learnSessions(record, id)
          // Never a second baseline: the UI has either seen local data (which
          // it must keep) or nothing (cache only).
          if (!localSeen) {
            remote = next
            remoteArchived = nextArchived
            remotePinned = nextPinned
            return []
          }
          const out: unknown[] = []
          // The remote truth moves FIRST (the sync and every frame below are
          // built against the NEW records; close stamps start the grace per
          // dropped id — T65), then the diffed upserts / removes and the
          // canonical order / archived / pinned. The trailing archived frame
          // covers any hide/reveal the new records caused: since T65 hiding
          // moves only the archived set, nothing can flash in between.
          const prev = remote
          remote = next
          remoteArchived = nextArchived
          remotePinned = nextPinned
          for (const [id, record] of next) noteClosedTransitions(prev.get(id), record)
          syncHiddenSessions()
          for (const [, record] of next) {
            const forwarded = forwardVisible(record)
            if (forwarded !== undefined) out.push({ type: 'upsert', workspace: forwarded })
          }
          for (const id of prev.keys()) {
            if (next.has(id)) continue
            forgetWorkspace(id)
            // Only a workspace the UI was SHOWN may receive a remove (T56) —
            // the model blacklists the id forever; a never-shown one is
            // unknown to the UI and leaves silently.
            if (shown.has(id)) out.push({ type: 'remove', workspaceId: virtualize(id) })
          }
          out.push(mergedOrderFrame(), mergedArchivedFrame(), mergedPinnedFrame())
          return out
        }
        case 'upsert': {
          if (!isPlainObject(frame.workspace) || typeof frame.workspace.workspaceId !== 'string') {
            drop('dropped a workspace upsert without a workspaceId')
            return []
          }
          const workspace: Record<string, unknown> = frame.workspace
          const id = workspace.workspaceId as string
          // T65: stamp the close first — the ids the OLD record carried live
          // and this one drops just became tombstones (the grace starts now).
          const prevRecord = remote.get(id)
          remote.set(id, { ...workspace })
          learnSessions(workspace, id)
          noteClosedTransitions(prevRecord, workspace)
          if (!localSeen) return []
          // T65: hide/reveal moves only the archived set (the session keeps
          // its group slot), so the group's upsert and the archived frame no
          // longer race — one trailing archived frame after the group's own
          // update covers both directions.
          const changed = syncHiddenSessions()
          // The tombstone-padded upsert is the whole update; a workspace the
          // UI has not seen (new, or hidden until now — T56) additionally
          // needs a position.
          const wasShown = shown.has(id)
          const forwarded = forwardVisible(workspace)
          const out: unknown[] = []
          if (forwarded !== undefined) {
            out.push({ type: 'upsert', workspace: forwarded })
            if (!wasShown) out.push(mergedOrderFrame())
          }
          if (changed.hidden.length > 0 || changed.revealed.length > 0) out.push(mergedArchivedFrame())
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
          const removed = remote.get(id)
          if (removed === undefined) return []
          remote.delete(id)
          // The group's tombstones die with it (CP4-client-fix2).
          forgetWorkspace(id)
          if (!localSeen) return []
          // T56: a workspace the UI was never shown must not receive a
          // remove — the model would blacklist the id against any future
          // re-share of the same workspace id.
          if (!shown.has(id)) return []
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

    onRemoteDown(): unknown[] {
      // Deliberately nothing: the shown state STAYS (the UI keeps the last
      // projection visible while the carrier is gone), so the reconnecting
      // baseline can diff against it instead of re-adding through the UI's
      // remove-blacklist. Pre-baseline cached state stays cached.
      return []
    },

    onServerRenamed(): unknown[] {
      // The caller has already retarget()ed to the new name; re-upserting the
      // shown workspaces under the CURRENT identity is the whole update.
      if (!localSeen || remote.size === 0) return []
      return upsertFrames()
    },

    setStatus(next: MergerAnnotation): void {
      annotation = next
    },

    onStatusChanged(): unknown[] {
      if (!localSeen || remote.size === 0) return []
      return upsertFrames()
    },

    setCurrentSession(sessionId: string | undefined): unknown[] {
      currentRaw = sessionId
      currentReadable = true
      if (!localSeen) return []
      // T65: hide/reveal moves ONLY the archived set — the session keeps its
      // group slot either way, so the whole update is the merged archived
      // frame (no group upserts, no ordering dance; the current session can
      // never enter the set, and a re-share removes its id from it).
      const changed = syncHiddenSessions()
      if (changed.hidden.length === 0 && changed.revealed.length === 0) return []
      return [mergedArchivedFrame()]
    },

    get hasPendingHide(): boolean {
      // Some tombstone is being kept visible: it is not in the hidden set
      // (either it IS the current session, or no readable current made any
      // decision yet) — the caller keeps polling until it hides.
      for (const [id, home] of sessionHome) {
        if (hiddenSessions.has(id)) continue
        const record = remote.get(home)
        if (record !== undefined && !stringList(record.sessionIds).includes(id)) return true
      }
      return false
    },

    onRemoteGone(): unknown[] {
      const out: unknown[] = []
      // The UI only ever SAW remote data when the local baseline had passed —
      // cached pre-baseline state is discarded silently instead. And only
      // SHOWN workspaces may leave via a remove (T56): a never-shown one is
      // unknown to the UI and just leaves the state. The archived/pinned
      // restore still rides along whenever remote sessions reached those
      // lists (session lists merge independently of workspace visibility).
      const removedIds = [...remote.keys()].filter((id) => shown.has(id))
      // T58-fix: hidden sessions alone also demand the restore — their ids
      // sit in the UI's archived set and must leave it with the identity.
      if (localSeen && (removedIds.length > 0 || remoteArchived.length > 0 || remotePinned.length > 0 || hiddenSessions.size > 0)) {
        for (const id of removedIds) out.push({ type: 'remove', workspaceId: virtualize(id) })
        out.push({ type: 'order', workspaceIds: [...localOrder] })
        out.push({ type: 'archived', archivedSessionIds: [...localArchived] })
        out.push({ type: 'pinned', pinnedSessionIds: [...localPinned] })
      }
      remote.clear()
      remoteArchived = []
      remotePinned = []
      // The tombstone registry dies with the identity (a new server mints new
      // ids); the archived frame above already restored the local-only set.
      sessionHome = new Map()
      // So do the T65 close stamps, the T58 hidden sessions and the
      // current-session knowledge (a NEW server may reuse original
      // workspace/session ids, and a stale entry would forward or mis-hide
      // the new server's sessions).
      closedAt.clear()
      hiddenSessions.clear()
      currentRaw = undefined
      currentReadable = false
      // So does the shown set: a NEW server may reuse original workspace ids,
      // and a stale entry would forward the new server's empty groups.
      shown.clear()
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
  /** Local control frames pass through untouched; the local BASELINE also
   * flushes anything the remote side buffered before it arrived. */
  onLocal(frame: unknown): unknown[]
  /** Remote baseline → per-session per-key `projection` frames; remote
   * projection updates → virtualized. Unknown types are dropped. Frames
   * arriving before the local baseline are buffered (the host's snapshot
   * stream treats an update before the opening snapshot as a protocol
   * violation and kills the stream). */
  onRemote(frame: unknown): unknown[]
  /** Always [] — a control stream has nothing to remove on a temporary
   * remote end (the workspace merger owns the group). */
  onRemoteDown(): unknown[]
  /** Always [] — leftover projection state for vanished virtual sessions is
   * harmless; the workspace merger removes the group. */
  onRemoteGone(): unknown[]
  /** Always [] — projection frames carry no display name. */
  onServerRenamed(): unknown[]
  /** Accepted and ignored: a status annotation is a TITLE concern, and
   * control projections carry no titles. */
  setStatus(annotation: MergerAnnotation): void
  /** Always [] — nothing shown here could carry an annotation. */
  onStatusChanged(): unknown[]
  /** Accepted and ignored; always answers []. */
  setCurrentSession(sessionId: string | undefined): unknown[]
  /** Always false — the control merger hides nothing. */
  readonly hasPendingHide: boolean
  retarget(identity: MergerIdentity): void
}

/**
 * The session/control merger. The control stream is key-value projection
 * traffic with no ordering constraints between sessions, so it needs no
 * state beyond the pre-baseline buffer: local frames pass through, remote
 * frames get their session id virtualized, and a remote baseline is EXPLODED
 * into one `projection` frame per key (never a second baseline).
 */
export function createControlMerger(options: ControlMergerOptions): ControlMerger {
  const onDiagnostic = options.onDiagnostic
  let identity: MergerIdentity = { serverId: options.serverId, serverName: options.serverName ?? '' }
  const virtualize = (id: string): string => toVirtual(identity.serverId, id)
  // Remote output converted but not yet shown: the UI's snapshot stream
  // throws `emitted an update before its opening snapshot` — a protocol
  // violation that permanently fails the stream — so nothing may leave
  // before the local baseline has passed.
  let localSeen = false
  let buffered: unknown[] = []

  /** Convert one remote control frame into the projection frames the UI
   * understands (empty for anything malformed). */
  function convert(frame: Record<string, unknown>): unknown[] {
    if (frame.type === 'baseline') {
      const value = isPlainObject(frame.value) ? frame.value : undefined
      const projections = value !== undefined && isPlainObject(value.projections) ? value.projections : {}
      const out: unknown[] = []
      for (const [sessionId, projection] of Object.entries(projections)) {
        if (!isPlainObject(projection)) continue
        const values = isPlainObject(projection.values) ? projection.values : {}
        const asOfSeq = projection.asOfSeq
        // A zero-event session's asOfSeq is -1, and the UI's SessionSeq
        // THROWS on a negative seq — one such frame would permanently stop
        // the whole control stream. Skip the record (one diagnostic) instead
        // of clamping: the UI compares `seq <= held → drop`, so a clamped 0
        // would swallow the real seq-0 entry when it arrives.
        if (typeof asOfSeq !== 'number' || !Number.isSafeInteger(asOfSeq) || asOfSeq < 0) {
          onDiagnostic?.(
            `skipped control projections for ${sessionId}: asOfSeq ${String(asOfSeq)} is not a usable sequence number`,
          )
          continue
        }
        for (const key of Object.keys(values)) {
          // The baseline gives one sequence number per projection record
          // (`asOfSeq`) — every key of that record rides it. A modelSelection
          // value additionally gets its provider ids virtualized (T52) so the
          // UI matches it against the merged catalog's virtual groups —
          // UNCONDITIONALLY (T52-fix3): the host's projection store is
          // first-write-wins per seq, so a catalog-gated original value would
          // occupy the seq and the later virtual rewrite could never land.
          out.push({
            type: 'projection',
            sessionId: virtualize(sessionId),
            key,
            value: key === 'modelSelection' ? virtualizeModelSelectionValue(values[key], identity.serverId) : values[key],
            seq: asOfSeq,
          })
        }
      }
      return out
    }
    if (frame.type === 'projection') {
      if (typeof frame.sessionId !== 'string') {
        onDiagnostic?.('dropped a session/control projection frame without a sessionId')
        return []
      }
      if (typeof frame.seq !== 'number' || !Number.isSafeInteger(frame.seq) || frame.seq < 0) {
        // Same SessionSeq hazard on live updates (a server reboot resets the
        // counters — a -1 or fractional seq must not kill the stream).
        onDiagnostic?.(`dropped a session/control projection frame with unusable seq ${String(frame.seq)}`)
        return []
      }
      return [
        {
          ...frame,
          sessionId: virtualize(frame.sessionId),
          // The modelSelection update's providers go virtual with the session
          // id (T52) — same unconditional rewrite as the exploded baseline
          // above (T52-fix3: first-write-wins per seq forbids a catalog gate).
          ...(frame.key === 'modelSelection'
            ? { value: virtualizeModelSelectionValue(frame.value, identity.serverId) }
            : {}),
        },
      ]
    }
    onDiagnostic?.(`dropped a session/control frame of unknown type ${String(frame.type)}`)
    return []
  }

  return {
    get serverId(): string {
      return identity.serverId
    },
    get serverName(): string {
      return identity.serverName
    },

    // TODO(seq-epoch): the server owns `seq` and restarts it from 0 on
    // reboot, while the UI drops any projection whose seq is ≤ the value it
    // already holds — so after a server restart every remote session's
    // projections stay frozen at their pre-restart values until the live seq
    // climbs past them. A fix would offset each remote stream generation's
    // seq (e.g. by a per-generation epoch base) and shift the forwarded
    // `session/projections` results by the same offset so both routes agree.
    // Deliberately out of scope for T23b2-fix; recorded here where the seq
    // conversion happens.

    retarget(next: MergerIdentity): void {
      identity = { serverId: next.serverId, serverName: next.serverName }
    },

    onLocal(frame: unknown): unknown[] {
      if (isPlainObject(frame) && frame.type === 'baseline' && !localSeen) {
        localSeen = true
        // The baseline opens the stream; the buffered remote output follows.
        const out = [frame, ...buffered]
        buffered = []
        return out
      }
      return [frame]
    },

    onRemote(frame: unknown): unknown[] {
      if (!isPlainObject(frame)) {
        onDiagnostic?.('dropped a non-object session/control frame from the relay')
        return []
      }
      const converted = convert(frame)
      if (!localSeen) {
        buffered.push(...converted)
        return []
      }
      return converted
    },

    onRemoteDown(): unknown[] {
      return []
    },

    onRemoteGone(): unknown[] {
      // Buffered pre-baseline remote output dies with the remote leg; the UI
      // never saw it.
      buffered = []
      return []
    },

    onServerRenamed(): unknown[] {
      return []
    },

    setStatus(_annotation: MergerAnnotation): void {},

    onStatusChanged(): unknown[] {
      return []
    },

    setCurrentSession(_sessionId: string | undefined): unknown[] {
      return []
    },

    get hasPendingHide(): boolean {
      return false
    },
  }
}

/**
 * Merge one `session/list` result pair (first page only — the caller skips
 * paged requests). Local items keep their order and their pagination fields;
 * the remote items are appended with virtualized session ids — `sessionId`
 * AND `parentSessionId` (CP4): the fork link must point at the VIRTUAL parent
 * id the UI knows, or the fork would sort beside a parent id that exists in
 * no list the UI holds — and a T52-fix rewrite of the row's own projections
 * block: a list row carries `{kind:'cached'|'sequenced', asOfSeq, values}`
 * (RT dsh-api-session-controller lib/typert.remote-client.js:381-428) and the
 * client face applies it PER SESSION (lib/client.js:2633 → applyListBlock
 * :2842-2855) — a `sequenced` modelSelection lands under higher-seq-wins
 * (lib/client.js:986-995, `seq <= row.seq` rejects), and the control stream's
 * REWRITTEN frame rides that projection's OWN seq, so an original-provider
 * value left in a row would poison the store forever: the remote session's
 * dropdown would show the raw `provider/model` fallback with no check mark.
 * The rewrite is UNCONDITIONAL (T52-fix3): first-write-wins per seq forbids
 * a catalog gate — a row rewritten while the catalog was missing would
 * occupy the seq forever. A missing or malformed remote result means "remote
 * said nothing" — the local result passes back untouched.
 */
export function mergeSessionList(localResult: unknown, remoteResult: unknown, serverId: string): unknown {
  if (!isPlainObject(localResult)) return localResult
  if (!isPlainObject(remoteResult) || !Array.isArray(remoteResult.items)) return localResult
  const localItems = Array.isArray(localResult.items) ? localResult.items : []
  const virtualize = (id: string): string => toVirtual(serverId, id)
  const remoteItems = remoteResult.items.map((item) => {
    if (!isPlainObject(item) || typeof item.sessionId !== 'string') return item
    const out: Record<string, unknown> = { ...item, sessionId: virtualize(item.sessionId) }
    if (typeof item.parentSessionId === 'string') out.parentSessionId = virtualize(item.parentSessionId)
    if (
      isPlainObject(item.projections) &&
      isPlainObject(item.projections.values) &&
      Object.hasOwn(item.projections.values, 'modelSelection')
    ) {
      const values: Record<string, unknown> = { ...item.projections.values }
      values.modelSelection = virtualizeModelSelectionValue(values.modelSelection, serverId)
      out.projections = { ...item.projections, values }
    }
    return out
  })
  return { ...localResult, items: [...localItems, ...remoteItems] }
}

/**
 * Fold the relay's `session/modelCatalog` answer into the local one (T52).
 * The result shape is RT dsh-api-session-controller
 * `session_modelCatalog_result$schema` (lib/typert.remote-client.js:489-518):
 * `{default, routableProviders, groups, failures}` — provider group ids and
 * display names only, no session data anywhere, so no output filter guards it
 * server-side and nothing here needs narrowing.
 *
 * - server groups are APPENDED after the local ones (the dropdown sorts
 *   `deepseek-account` / `deepseek-official` first and keeps the rest in
 *   order, RT dsh-client-ui-model-selection lib/client.js:510 — appended
 *   groups render last); each group id becomes the virtual group id
 *   `zr~<serverId>~<original>` and its name is prefixed
 *   `${serverName} · ${name}` — the same workspace title discipline the
 *   merger uses;
 * - `default` and `failures` stay LOCAL untouched: the default drives what a
 *   blank LOCAL session would run (a remote session's current model comes
 *   from its projection instead), and the UI renders every failure as a
 *   prominent warning row whose Retry reloads the WHOLE catalog
 *   (lib/client.js:816-827) — a server-side group failure is not retryable
 *   from here and would put a permanent alarm on every dropdown, so it does
 *   not travel (dsh-vision-router's settings read the same result and shows
 *   an error state exactly when groups are empty AND failures exist,
 *   lib/client.js:635-647 — dropping remote failures keeps that honest).
 *   KNOWN BOUNDARY (pre-T52 behavior, unchanged): a NEW server session's
 *   projection `next` is null until its first selection or turn, so the UI
 *   shows `catalog.value.default` — the LOCAL default — as that session's
 *   current model (RT dsh-client-ui-model-selection lib/client.js:316,
 *   `projected?.next ?? catalog.value?.default`), which may differ from what
 *   the server would actually run until its first selection lands.
 * - `routableProviders` mirrors the group ids by construction host-side
 *   (RT dsh-api-session-controller lib/index.js:544 — literally
 *   `groups.map(g => g.id)`); no client UI reads it (the dropdown's
 *   routable verdict comes from the groups themselves, lib/client.js:334),
 *   so appending the virtual ids is a consistency move: the merged catalog
 *   keeps the invariant the Host maintains, whatever reads it next.
 *
 * A malformed local or remote value means "one side said nothing" — the
 * local result passes back untouched, like {@link mergeSessionList}.
 */
export function mergeModelCatalogs(localValue: unknown, remoteValue: unknown, identity: MergerIdentity): unknown {
  if (!isPlainObject(localValue)) return localValue
  if (!isPlainObject(remoteValue) || !Array.isArray(remoteValue.groups)) return localValue
  const localGroups = Array.isArray(localValue.groups) ? localValue.groups : []
  const virtualGroups: unknown[] = []
  const virtualIds: string[] = []
  for (const group of remoteValue.groups) {
    if (!isPlainObject(group) || typeof group.id !== 'string' || group.id === '') continue
    const id = toVirtual(identity.serverId, group.id)
    virtualIds.push(id)
    virtualGroups.push({
      ...group,
      id,
      ...(typeof group.name === 'string' ? { name: `${identity.serverName} · ${group.name}` } : {}),
    })
  }
  if (virtualGroups.length === 0) return localValue
  return {
    ...localValue,
    groups: [...localGroups, ...virtualGroups],
    routableProviders: [...stringList(localValue.routableProviders), ...virtualIds],
  }
}

/**
 * Virtualize the provider ids inside one `modelSelection` projection value —
 * `{lastUsed: {provider, model, reasoningEffort?} | null, next: …}` (RT
 * dsh-api-session-controller lib/types/model-selection-projection.js:12-15,
 * wire shapes at lib/typert.remote-client.js:83-94). The UI resolves the
 * current model's display name by matching `(provider, model)` against the
 * catalog groups (dsh-client-ui-model-selection lib/client.js:334, 520); for
 * a remote session the provider is a SERVER group id, so it must become the
 * virtual group id to be found in the merged catalog — and while the relay
 * serves, the merged catalog always carries it, so the composer trigger
 * shows the model NAME instead of the raw `provider/model` fallback string
 * (lib/client.js:700).
 *
 * UNCONDITIONAL by decision (T52-fix3, reverting T52-fix2's catalog gate):
 * the host's projection store is first-write-wins per sequence number
 * (lib/client.js:986-994), so whether a value is rewritten may not depend on
 * WHEN the catalog happened to arrive — an original written pre-catalog
 * occupies the seq and the later virtual value is dropped, leaving the
 * server group unchecked and the next reasoning-effort submit refused.
 * Accepted cost: a provider the server's own catalog does not list renders
 * the `zr~<serverId>~provider/model` fallback string. Nulls and malformed
 * entries pass through untouched; `model` and `reasoningEffort` are
 * group-agnostic ids and stay as they are.
 */
export function virtualizeModelSelectionValue(value: unknown, serverId: string): unknown {
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = { ...value }
  for (const key of ['lastUsed', 'next'] as const) {
    const selection = value[key]
    if (isPlainObject(selection) && typeof selection.provider === 'string') {
      out[key] = { ...selection, provider: toVirtual(serverId, selection.provider) }
    }
  }
  return out
}

/**
 * T63: the virtual session ids a set of FORWARDED workspace frames carries —
 * the `sessionIds` of `upsert` records and of baseline `value.items`. The
 * workspace route feeds these to the summary sync, which announces list rows
 * for ids the UI has no summary for yet (the sidebar drops a group member
 * without one — RT dsh-client-ui-workspace orderByRecency / groupByWorkspace).
 * Reading the FORWARDED output (not the merger's raw state) is the point:
 * T56 already withheld empty groups and T58 already dropped hidden sessions,
 * so a hidden closed-remote session never reaches here and is never
 * announced. Only virtual ids count — local baseline content rides these
 * frames verbatim and its rows already have summaries.
 */
export function virtualSessionIdsInWorkspaceFrames(frames: readonly unknown[]): string[] {
  const out = new Set<string>()
  const collect = (record: unknown): void => {
    if (!isPlainObject(record) || !Array.isArray(record.sessionIds)) return
    for (const id of record.sessionIds) {
      if (typeof id === 'string' && isVirtual(id)) out.add(id)
    }
  }
  for (const frame of frames) {
    if (!isPlainObject(frame)) continue
    if (frame.type === 'upsert') collect(frame.workspace)
    if (frame.type === 'baseline') {
      const value = isPlainObject(frame.value) ? frame.value : undefined
      if (value !== undefined && Array.isArray(value.items)) for (const item of value.items) collect(item)
    }
  }
  return [...out]
}

/**
 * T63: the synthesized `api-session/added` emit frames for one relay
 * `session/list` answer — one `{type:'emit', event:'api-session/added',
 * args:[row]}` frame per row. This is the host's own mechanism for adding a
 * list row without a re-pull (RT dsh-api-session-controller: the client face
 * subscribes `api-session/added` → handleSessionAdded → mergeSummary →
 * applyMutation's upsert, which ADDS an unknown row and fills an existing
 * one — idempotent), and the emit frame shape is the client face's
 * exact-keys `{type, event, args}` with args a JSON array
 * (dsh-api-gateway lib/client.js parseRemoteEventFrame) — the same shape the
 * T52 catalog-refresh frame uses. The rows are virtualized by
 * {@link mergeSessionList} itself, so a synthesized row carries exactly what
 * the merged `session/list` route would have answered: the session id AND
 * the fork parent virtualized, and the projections' modelSelection providers
 * rewritten (a row's `sequenced` block must not poison the projection store
 * against the control stream's rewritten frames — T52-fix3). A malformed
 * remote result means "the server said nothing" — no frames.
 */
export function sessionSummaryAddedFrames(remoteResult: unknown, serverId: string): unknown[] {
  if (!isPlainObject(remoteResult) || !Array.isArray(remoteResult.items)) return []
  const merged = mergeSessionList({ items: [] }, remoteResult, serverId)
  if (!isPlainObject(merged) || !Array.isArray(merged.items)) return []
  const frames: unknown[] = []
  for (const row of merged.items) {
    // mergeSessionList passes a malformed row through as-is; the UI's
    // applyMutation would file it under `byId[undefined]`, so only a
    // well-formed row (plain object, string sessionId — the shape
    // handleSessionAdded's mergeSummary keys on) becomes a frame.
    if (!isPlainObject(row) || typeof row.sessionId !== 'string' || row.sessionId === '') continue
    frames.push({ type: 'emit', event: 'api-session/added', args: [row] })
  }
  return frames
}
