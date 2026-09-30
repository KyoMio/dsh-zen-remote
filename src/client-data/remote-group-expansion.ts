/**
 * T64: the server remote groups' expansion memory, as pure functions — the
 * readable core of the keeper (src/client/remote-group-expansion.ts).
 *
 * WHY this exists: the host's own expansion memory
 * (localStorage `dsh.workspace.view.v5`, key `groupExpansion`) is purged of
 * every key not in the CURRENT workspace list the moment the workspace list
 * goes ready (`retainAccountKeys` — dsh-client-ui-workspace). On a sub-client
 * the LOCAL workspaces go ready before the server groups merge in, so the
 * `zr~<serverId>~<workspaceId>` keys are dropped on every page load and every
 * server group falls back to collapsed (`groupExpansion[key] ??
 * ancestorKeys.has(key)` — unrecorded means collapsed). The plugin therefore
 * keeps its OWN record and re-applies it: while the host still has a record
 * for a group, the host's value wins (the user's latest choice lives there)
 * and syncs into the plugin record; for a group the host has NO record for
 * (exactly the just-purged case) the plugin record — default EXPANDED — is
 * what the group should show, applied by clicking the row once so the host
 * writes its own state back.
 *
 * Everything here is defensive like the rest of client-data: a malformed
 * storage value degrades to an empty record, never a throw.
 */

/** The plugin's own storage key (`{ [virtualWorkspaceId]: boolean }`). */
export const REMOTE_GROUP_EXPANSION_KEY = 'zr.remoteGroupExpansion.v1'

/** The HOST key this module reads (never writes) — dsh-client-ui-workspace's
 * persisted view state. */
export const HOST_WORKSPACE_VIEW_KEY = 'dsh.workspace.view.v5'

/** The record's key cap; past it the OLDEST entries (least recently written)
 * are evicted. One server group is one key — 200 is far past any real
 * sidebar, the cap bounds a long-lived stale record. */
export const REMOTE_GROUP_EXPANSION_LIMIT = 200

/** One server group row's current state, as read from the sidebar DOM. */
export interface GroupRowState {
  /** The group id (the `data-row-key`'s part after `workspace:`) — a virtual
   * id `zr~<serverId>~<workspaceId>`. */
  key: string
  /** The row's current `aria-expanded`. */
  expanded: boolean
}

export interface ExpansionPlan {
  /** Group ids to click, in row order — the rows whose `aria-expanded`
   * disagrees with the wanted state and that the host holds no record for. */
  clicks: string[]
  /** The next plugin record: the host-recorded `zr~` keys synced in (host
   * value wins, recency touched), capped at the limit. Write it back only
   * when it differs from the current one. */
  record: Record<string, boolean>
}

/** Parse one raw read of the plugin record (or the host's `groupExpansion`
 * map): a JSON object whose values are booleans survives; anything else —
 * absent key, broken JSON, non-object, non-boolean values — degrades to an
 * empty record. */
export function parseExpansionRecord(raw: string | null | undefined): Record<string, boolean> {
  if (raw === null || raw === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'boolean') out[key] = value
  }
  return out
}

/** Parse one raw read of the HOST view state (`dsh.workspace.view.v5`) down
 * to just its `groupExpansion` map — same defensiveness as
 * {@link parseExpansionRecord}. */
export function parseHostGroupExpansion(raw: string | null | undefined): Record<string, boolean> {
  if (raw === null || raw === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const expansion = (parsed as { groupExpansion?: unknown }).groupExpansion
  if (typeof expansion !== 'object' || expansion === null || Array.isArray(expansion)) return {}
  const out: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(expansion as Record<string, unknown>)) {
    if (typeof value === 'boolean') out[key] = value
  }
  return out
}

/** One plan step: sync the host-recorded `zr~` keys into the plugin record,
 * then plan the clicks. The four rules the sidebar depends on:
 * - a group the HOST has a record for is the user's latest choice — never
 *   clicked, its value syncs into the plugin record;
 * - a group with no host record and no plugin record defaults to EXPANDED
 *   (the group was showing its sessions before the purge);
 * - a plugin-recorded COLLAPSED group stays collapsed — no click;
 * - non-`zr~` rows are the host's own groups — never touched, never
 *   recorded. */
export function planRemoteGroupExpansion(options: {
  /** The host's current `groupExpansion` map (originals and `zr~` keys
   * mixed — only `zr~` keys matter here). */
  hostRecord: Record<string, boolean>
  /** The plugin's own record, as last persisted. */
  pluginRecord: Record<string, boolean>
  /** The server group rows currently in the sidebar, in DOM order. */
  rows: GroupRowState[]
}): ExpansionPlan {
  const { hostRecord, pluginRecord, rows } = options
  // Recency lives in the record's KEY ORDER (string keys keep insertion
  // order): a touched entry is deleted and re-added so it moves to the end,
  // and the cap evicts from the front.
  const record: Record<string, boolean> = {}
  const touch = (key: string, value: boolean): void => {
    delete record[key]
    record[key] = value
  }
  for (const [key, value] of Object.entries(pluginRecord)) {
    if (key.startsWith('zr~')) record[key] = value
  }
  for (const [key, value] of Object.entries(hostRecord)) {
    // The host record syncs LAST: its value is the user's latest choice and
    // its recency is the freshest fact.
    if (key.startsWith('zr~')) touch(key, value)
  }
  const clicks: string[] = []
  for (const row of rows) {
    if (!row.key.startsWith('zr~')) continue
    if (Object.hasOwn(hostRecord, row.key)) continue
    const wanted = Object.hasOwn(record, row.key) ? record[row.key] : true
    if (row.expanded !== wanted) clicks.push(row.key)
  }
  // Evict oldest past the cap — after the clicks are planned (an evicted
  // key's wanted state was already read).
  const keys = Object.keys(record)
  for (const key of keys.length > REMOTE_GROUP_EXPANSION_LIMIT ? keys.slice(0, keys.length - REMOTE_GROUP_EXPANSION_LIMIT) : []) {
    delete record[key]
  }
  return { clicks, record }
}
