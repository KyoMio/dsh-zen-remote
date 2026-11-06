/**
 * The multi-server relay connection pool (MS-2): up to {@link MAX_PAIRED_SERVERS}
 * `RelayClient` instances, one per paired server in the state file, replacing
 * the single row-driven client the client role used to keep. The paired
 * list itself lives in `zen-remote-state.json` (src/state-store.ts — MS-1's
 * three-in-one file); this module owns the LIVE half: start, handshake
 * bookkeeping, re-pair, unpair, and the second dedupe layer's teardown.
 *
 * Two bookkeeping paths meet here. When one client's handshake lands, the
 * handshake facts (serverId/serverName/deviceName) are persisted onto its
 * state-file record — `recordServerHandshake` also REMOVES any other record
 * that carries the same serverId (the same server re-paired under a new
 * address), and this module stops that stale entry's client and announces it
 * with `reason: 'dedupe'`. Removals the USER makes go out with
 * `reason: 'unpair'`.
 *
 * Display names: several servers report the same `serverName` (the default is
 * just the hostname), so the merged sidebar would show N identical rows.
 * {@link deriveDisplayServerNames} numbers duplicates in pairing order
 * (`home-1`, `home-2`, …) and leaves unique names bare; a rename that removes
 * the collision removes the suffixes with it, because the derivation is
 * recomputed on every `entries()` read.
 *
 * The clients themselves are the plain T23a relay clients — their getters
 * read the pool's in-memory record per request, so a re-pair only updates
 * that record and calls `credentialsChanged()`. `createClient` is injectable:
 * the tests drive the whole lifecycle without a socket.
 */

import { createRelayClient } from './relay-client.js'
import type { RelayClient, RelayClock, RelayState, CreateRelayClientOptions } from './relay-client.js'
import type { PairedServerRecord } from './state-store.js'
import {
  clearPairedServers,
  listPairedServers,
  MAX_PAIRED_SERVERS,
  migrateLegacyClientIntoServers,
  recordServerHandshake,
  removePairedServer,
  upsertPairedServer,
} from './state-store.js'

/** One entry's name inputs for {@link deriveDisplayServerNames}. */
export interface ServerNameEntry {
  entryId: string
  serverName: string
  serverUrl: string
}

/**
 * The display name of every entry: a trimmed non-empty `serverName` is the
 * base, otherwise the server URL. Bases appearing once keep their name; bases
 * appearing twice or more are numbered `-1`, `-2`, `-3`… in `entries` order
 * (pairing order). Pure — recomputed whenever the pool is asked for entries,
 * so a rename that removes a collision removes the suffixes too.
 */
export function deriveDisplayServerNames(entries: readonly ServerNameEntry[]): Map<string, string> {
  const baseOf = (entry: ServerNameEntry): string =>
    typeof entry.serverName === 'string' && entry.serverName.trim() !== '' ? entry.serverName.trim() : entry.serverUrl
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const base = baseOf(entry)
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  const out = new Map<string, string>()
  for (const entry of entries) {
    const base = baseOf(entry)
    if ((counts.get(base) ?? 0) >= 2) {
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      out.set(entry.entryId, `${base}-${n}`)
    } else {
      out.set(entry.entryId, base)
    }
  }
  return out
}

/** One live pool entry as the callers see it. */
export interface RelayPoolEntryView {
  /** The stable state-file record id. */
  entryId: string
  /** The normalized server address. */
  serverUrl: string
  /** The handshake's server id; the persisted record id until one lands. */
  serverId: string | undefined
  /** The handshake's server name; the persisted name until one lands. */
  serverName: string | undefined
  /** {@link deriveDisplayServerNames} over the current entries. */
  displayName: string
  /** The live client. */
  client: RelayClient
  /** When the pairing was first added (epoch ms). */
  createdAt: number
}

/** Why an entry left the pool: the user removed it, or a handshake proved it
 * a stale duplicate of another entry pointing at the same server. */
export type RelayPoolRemovalReason = 'unpair' | 'dedupe'

export interface RelayPoolOptions {
  /** The state file (`<DSH_HOME>/zen-remote-state.json`). */
  stateFile: string
  /** The row's legacy single-server credentials, read once at startup: when
   * the paired list is still empty they become `servers[0]`. */
  legacySource?: () => { serverUrl?: string; deviceToken?: string } | undefined
  /** This side's own interface fingerprints (T42), handed to every client. */
  computeOwnFingerprints: () => Record<string, string>
  /** Outbound fetch for the clients; defaults to the global one. */
  fetchImpl?: typeof fetch
  /** Clock for the clients' reconnect machinery; defaults to the real one. */
  clock?: RelayClock
  /** The client factory; injectable so tests run without sockets. */
  createClient?: typeof createRelayClient
  /** Every client state change, with the entry it belongs to. */
  onStateChange?: (event: { entryId: string; serverId?: string; state: RelayState; lastError?: string }) => void
  /** Every entry removal, with why it left. */
  onServerRemoved?: (removed: { entryId: string; serverId?: string; reason: RelayPoolRemovalReason }) => void
}

/** One in-memory entry: the record (mutated in place on re-pair/handshake),
 * its client and the state-listener unsubscribe handle. */
interface PoolEntry {
  record: PairedServerRecord
  client: RelayClient
  unsubscribe: () => void
}

export interface RelayPool {
  /** Every entry in pairing order, with fresh display names. */
  entries(): RelayPoolEntryView[]
  /** Locate one entry by its state-file record id. */
  getByEntryId(entryId: string): RelayPoolEntryView | undefined
  /** Locate one entry by its (handshake or persisted) server id. */
  getByServerId(serverId: string): RelayPoolEntryView | undefined
  /** Add or re-pair one server: the record lands on disk first, then the
   * live half follows (re-credentialed in place, or a fresh client). */
  pair(input: { serverUrl: string; token: string; deviceId?: string; deviceName?: string }): Promise<
    { ok: true; entry: RelayPoolEntryView; replaced: boolean } | { ok: false; code: 'invalid-url' | 'limit-reached' }
  >
  /** Stop and remove one entry (disk record included). */
  unpair(entryId: string): boolean
  /** Stop everything and empty the paired list; answers the record count. */
  unpairAll(): number
  /** One entry's immediate reconnect, or every `offline` client's. Answers
   * whether any attempt was started. */
  reconnect(entryId?: string): Promise<boolean>
  /** One authenticated ping per `offline` client; the reachable ones get
   * `networkRestored()` (the controlled fast-path back online). */
  probeAndRestoreAll(): Promise<{ reachable: boolean; reconnected: boolean }>
  /** Forward a device rename to every paired server (T59). */
  queueDeviceNameAll(name: string): void
  /** Stop every client and detach the listeners (row teardown). */
  stop(): void
}

/**
 * Build the pool: one legacy migration pass, then one client per persisted
 * record, each with a fire-and-forget startup connect — a failed first dial
 * is the backoff ladder's business, exactly like the single-client wiring
 * before it.
 */
export function createRelayPool(options: RelayPoolOptions): RelayPool {
  const stateFile = options.stateFile
  const createClientImpl = options.createClient ?? createRelayClient

  /** Insertion order = pairing order = `listPairedServers` order. */
  const pool = new Map<string, PoolEntry>()

  /** The handshake id a view should report: live handshake first, then the
   * persisted record (a fresh entry that never reached the server yet). */
  const effectiveServerId = (entry: PoolEntry): string | undefined =>
    entry.client.handshakeInfo?.serverId ?? entry.record.serverId
  const effectiveServerName = (entry: PoolEntry): string | undefined =>
    entry.client.handshakeInfo?.serverName ?? entry.record.serverName

  const buildView = (entry: PoolEntry, displayName: string): RelayPoolEntryView => ({
    entryId: entry.record.id,
    serverUrl: entry.record.serverUrl,
    serverId: effectiveServerId(entry),
    serverName: effectiveServerName(entry),
    displayName,
    client: entry.client,
    createdAt: entry.record.createdAt,
  })

  const entries = (): RelayPoolEntryView[] => {
    const list = [...pool.values()]
    const names = deriveDisplayServerNames(
      list.map((entry) => ({ entryId: entry.record.id, serverName: effectiveServerName(entry) ?? '', serverUrl: entry.record.serverUrl })),
    )
    return list.map((entry) => buildView(entry, names.get(entry.record.id) ?? entry.record.serverUrl))
  }

  /** The client's credential getters read the CURRENT record per request, so
   * a re-pair (an in-place record swap) reaches the next attempt directly. */
  const createClientFor = (record: PairedServerRecord): RelayClient => {
    const liveRecord = (): PairedServerRecord => pool.get(record.id)?.record ?? record
    const clientOptions: CreateRelayClientOptions = {
      getServerUrl: () => liveRecord().serverUrl,
      getToken: () => liveRecord().token,
      computeOwnFingerprints: options.computeOwnFingerprints,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
    }
    return createClientImpl(clientOptions)
  }

  /** Fold one completed handshake into the record — on disk (whose dedupe
   * may retire stale same-server entries) and in memory — then stop and
   * announce the retired ones. A non-8-hex server id is not handshake
   * material; skip the whole bookkeeping for it. */
  const handleHandshake = (entry: PoolEntry): void => {
    const info = entry.client.handshakeInfo
    if (info === undefined) return
    const result = recordServerHandshake(stateFile, entry.record.id, {
      serverId: info.serverId,
      serverName: info.serverName,
      ...(info.deviceName !== undefined ? { deviceName: info.deviceName } : {}),
    })
    entry.record = {
      ...entry.record,
      serverId: info.serverId,
      ...(info.serverName !== '' ? { serverName: info.serverName } : {}),
      ...(info.deviceName !== undefined ? { deviceName: info.deviceName } : {}),
    }
    for (const removedId of result.removedEntryIds) {
      const stale = pool.get(removedId)
      if (stale !== undefined) {
        stale.unsubscribe()
        stale.client.stop()
        pool.delete(removedId)
      }
      options.onServerRemoved?.({ entryId: removedId, serverId: info.serverId, reason: 'dedupe' })
    }
  }

  const attach = (entry: PoolEntry): void => {
    entry.unsubscribe = entry.client.subscribe((state) => {
      if (state === 'online') handleHandshake(entry)
      options.onStateChange?.({
        entryId: entry.record.id,
        serverId: effectiveServerId(entry),
        state,
        ...(entry.client.lastError !== undefined ? { lastError: entry.client.lastError } : {}),
      })
    })
  }

  const addEntry = (record: PairedServerRecord): void => {
    const entry: PoolEntry = { record, client: createClientFor(record), unsubscribe: () => {} }
    attach(entry)
    pool.set(record.id, entry)
    // Startup dials are fire-and-forget: the failure is the client's own
    // backoff ladder's business, never the wiring's (same as index.ts).
    void entry.client.connect().catch(() => {})
  }

  // Startup: fold the legacy row credentials in (only when the list is still
  // empty), then one client per record.
  const legacy = options.legacySource?.()
  if (legacy !== undefined) {
    try {
      migrateLegacyClientIntoServers(stateFile, legacy)
    } catch {
      // Best effort — the row keeps its credentials for the next start.
    }
  }
  for (const record of listPairedServers(stateFile)) addEntry(record)

  const detach = (entry: PoolEntry): void => {
    entry.unsubscribe()
    entry.client.stop()
    pool.delete(entry.record.id)
  }

  return {
    entries,

    getByEntryId(entryId) {
      return entries().find((view) => view.entryId === entryId)
    },

    getByServerId(serverId) {
      return entries().find((view) => view.serverId === serverId)
    },

    async pair(input) {
      const result = upsertPairedServer(stateFile, input)
      if (!result.ok) return result
      const existing = pool.get(result.record.id)
      if (existing !== undefined) {
        existing.record = result.record
        // The getters read the swapped record per request; this both cancels
        // a pending retry wait and dials the new credentials immediately.
        existing.client.credentialsChanged()
      } else {
        addEntry(result.record)
      }
      // The entry is in the pool by now by construction; entries() also gives
      // it the dedupe-numbered display name the other views would show.
      const view = entries().find((candidate) => candidate.entryId === result.record.id)
      return { ok: true, entry: view as RelayPoolEntryView, replaced: result.replaced }
    },

    unpair(entryId) {
      const entry = pool.get(entryId)
      const removed = removePairedServer(stateFile, entryId)
      if (entry !== undefined) detach(entry)
      if (removed) {
        options.onServerRemoved?.({
          entryId,
          serverId: entry !== undefined ? effectiveServerId(entry) : undefined,
          reason: 'unpair',
        })
      }
      return removed
    },

    unpairAll() {
      const records = listPairedServers(stateFile)
      const count = clearPairedServers(stateFile)
      const onDisk = new Set(records.map((record) => record.id))
      for (const record of records) {
        const entry = pool.get(record.id)
        if (entry !== undefined) detach(entry)
        options.onServerRemoved?.({
          entryId: record.id,
          serverId: entry !== undefined ? effectiveServerId(entry) : record.serverId,
          reason: 'unpair',
        })
      }
      // Memory-only stragglers (a record removed underneath us mid-flight):
      // stop them too — unpairAll means ALL — without a second announcement
      // for the ones the disk pass already reported.
      for (const entry of [...pool.values()]) {
        detach(entry)
        if (!onDisk.has(entry.record.id)) {
          options.onServerRemoved?.({ entryId: entry.record.id, serverId: effectiveServerId(entry), reason: 'unpair' })
        }
      }
      return count
    },

    async reconnect(entryId) {
      if (entryId !== undefined) {
        const entry = pool.get(entryId)
        return entry !== undefined ? entry.client.reconnect() : false
      }
      let any = false
      for (const entry of pool.values()) {
        if (entry.client.state === 'offline') any = entry.client.reconnect() || any
      }
      return any
    },

    async probeAndRestoreAll() {
      let reachable = false
      let reconnected = false
      for (const entry of pool.values()) {
        if (entry.client.state !== 'offline') continue
        if (!(await entry.client.probeHealth())) continue
        reachable = true
        reconnected = entry.client.networkRestored() || reconnected
      }
      return { reachable, reconnected }
    },

    queueDeviceNameAll(name) {
      for (const entry of pool.values()) entry.client.queueDeviceName(name)
    },

    stop() {
      for (const entry of [...pool.values()]) {
        entry.unsubscribe()
        entry.client.stop()
      }
      pool.clear()
    },
  }
}

/** Re-exported so the pool's consumers never import state-store for the cap. */
export { MAX_PAIRED_SERVERS }
