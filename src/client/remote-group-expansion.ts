/**
 * T64: the keeper that remembers and restores the SERVER groups' expansion
 * across page loads. The host purges its own expansion record of every key
 * not in the current workspace list the moment that list goes ready
 * (`retainAccountKeys`) — on a sub-client the local workspaces go ready
 * first, so the `zr~…` keys die on every load and every server group comes
 * back collapsed. This module mirrors the host's record into the plugin's
 * OWN storage key while it exists and re-applies it once the host has
 * dropped it, by clicking the group row — a real user click, so the host
 * writes its own state back and the two never disagree.
 *
 * Per tick: sync the host-recorded `zr~` keys into the plugin record
 * (the host's value IS the user's latest choice), then for each server
 * group row the host holds NO record for, click it when its
 * `aria-expanded` disagrees with the wanted state — the plugin record's
 * value, defaulting to EXPANDED (the group was showing its sessions before
 * the purge). A group the host already records is never touched. One group
 * is auto-clicked at most ONCE per page load — if the click did not land
 * (React lag, a lost race with the host's own write), re-clicking would
 * only fight the host. A DOM that does not match the expected shape (no
 * row, no `aria-expanded`) is skipped silently.
 *
 * Runs only in the CLIENT role, via the SAME cached client-config probe as
 * the current-session reporter (T62) — a host has no server groups. The
 * tick cadence is its own 1s interval (the shared shape, not a shared
 * timer): the restore must land right after the workspace list merges,
 * whenever that happens.
 */
import {
  HOST_WORKSPACE_VIEW_KEY,
  REMOTE_GROUP_EXPANSION_KEY,
  parseExpansionRecord,
  parseHostGroupExpansion,
  planRemoteGroupExpansion,
} from '../client-data/remote-group-expansion.ts'
import { probeClientConfigRole } from './remote-share-register.ts'

const CHECK_INTERVAL_MS = 1_000

const ROW_SELECTOR = '[role="treeitem"][data-row-key^="workspace:zr~"]'
const ROW_KEY_PREFIX = 'workspace:'

/** The one row face used: read the two attributes, click like a user. */
interface RowElement {
  getAttribute(name: string): string | null
  click(): void
}

/** The storage face used, narrowed to the two methods (structurally typed:
 * this module compiles under the client tsconfig with DOM lib, but tests
 * inject stubs). */
interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface DocumentLike {
  querySelectorAll(selectors: string): Iterable<Element>
}

/** One matched row: the group id, its current expansion, and the click. */
interface RowHandle {
  key: string
  expanded: boolean
  click(): void
}

export interface RemoteGroupExpansionKeeperOptions {
  /** Both storage reads and writes. Default: the page's localStorage; a
   * broken or absent one makes every tick a no-op. */
  storage?: StorageLike
  /** The role probe. Default: the shared cached client-config probe. */
  probeRole?: () => Promise<'host' | 'client' | undefined>
  /** The sidebar's server group rows. Default: the real DOM query — rows
   * without a readable `aria-expanded` are skipped. Tests inject fake rows
   * with click recorders. */
  queryRows?: () => RowHandle[]
  /** The re-check interval; default 1000ms. */
  intervalMs?: number
}

/**
 * Start the keeper loop. Returns the disposer (interval) the mounting
 * effect calls on teardown.
 */
export function startRemoteGroupExpansionKeeper(options: RemoteGroupExpansionKeeperOptions = {}): () => void {
  const readStorage = (): StorageLike | undefined => {
    const storage = options.storage ?? (globalThis as { localStorage?: StorageLike | null }).localStorage
    return storage !== null && storage !== undefined && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
      ? storage
      : undefined
  }
  const probeRole = options.probeRole ?? probeClientConfigRole
  const queryRows = options.queryRows ?? (() => {
    const doc = (globalThis as { document?: DocumentLike }).document
    if (doc === undefined) return []
    const out: RowHandle[] = []
    for (const el of doc.querySelectorAll(ROW_SELECTOR)) {
      const row = el as unknown as RowElement
      const rowKey = row.getAttribute('data-row-key')
      const expanded = row.getAttribute('aria-expanded')
      if (rowKey === null || expanded === null) continue
      out.push({ key: rowKey.slice(ROW_KEY_PREFIX.length), expanded: expanded === 'true', click: () => row.click() })
    }
    return out
  })

  let role: 'host' | 'client' | undefined
  // One auto-click per group per page load, ever — not per tick.
  const clickedOnce = new Set<string>()
  let inFlight = false

  const tick = async (): Promise<void> => {
    if (role === undefined) {
      const answer = await probeRole()
      // A failed probe changes nothing — the next tick asks again; a
      // definite answer is stable for the page's life.
      if (answer !== undefined) role = answer
    }
    if (role !== 'client') return
    const storage = readStorage()
    if (storage === undefined) return
    // A malformed value on either side degrades to an empty record (the
    // pure layer's rule) — a wiped plugin record then re-applies the
    // default-expanded state, which is the honest reading of "no memory".
    const hostRecord = parseHostGroupExpansion(storage.getItem(HOST_WORKSPACE_VIEW_KEY))
    const pluginRecord = parseExpansionRecord(storage.getItem(REMOTE_GROUP_EXPANSION_KEY))
    const rowHandles = queryRows()
    const plan = planRemoteGroupExpansion({
      hostRecord,
      pluginRecord,
      rows: rowHandles.map(({ key, expanded }) => ({ key, expanded })),
    })
    const nextRecordJson = JSON.stringify(plan.record)
    if (nextRecordJson !== JSON.stringify(pluginRecord)) {
      storage.setItem(REMOTE_GROUP_EXPANSION_KEY, nextRecordJson)
    }
    for (const key of plan.clicks) {
      if (clickedOnce.has(key)) continue
      clickedOnce.add(key)
      rowHandles.find((candidate) => candidate.key === key)?.click()
    }
  }
  const tickOnce = (): void => {
    // One re-check at a time: a slow tick must not pile up parallel tries.
    if (inFlight) return
    inFlight = true
    void tick().finally(() => { inFlight = false })
  }

  const timer = setInterval(() => { tickOnce() }, options.intervalMs ?? CHECK_INTERVAL_MS)
  tickOnce()
  return () => { clearInterval(timer) }
}

/**
 * Mount the keeper as one page-lifetime effect, beside the current-session
 * reporter (T62): before the desktop-shell gate in apply(), same client-role
 * probe, same 1s cadence — its own timer, its own file.
 */
export function mountRemoteGroupExpansionKeeper(ctx: { effect(fn: () => () => void, name: string): void }, options: RemoteGroupExpansionKeeperOptions = {}): void {
  ctx.effect(() => startRemoteGroupExpansionKeeper(options), 'dsh-zen-remote: remote group expansion keeper')
}
