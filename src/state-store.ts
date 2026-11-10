/**
 * The three-in-one state file (MS-1): `<DSH_HOME>/zen-remote-state.json`
 * holds the server's own identity (`serverId`), the shared-session table
 * (`sessions`) and the list of paired relay servers (`servers`) in ONE file,
 * so the three writers — relay-server.ts's loadServerId, share-store.ts's
 * persist, and the pairing operations below — can never clobber each other's
 * top-level fields. Every write goes through {@link writeStateFile}, which
 * reads the CURRENT file first and hands it to the updater: a share-table
 * write preserves `serverId` and `servers`, an identity write preserves the
 * table and the list.
 *
 * The file is 0600 on purpose: `servers` rows carry pairing tokens. The write
 * is the same atomic tmp+rename dance the share table has always used, with
 * an explicit chmod in front of the rename (writeFileSync's `mode` only
 * applies at creation — a leftover `.tmp` from a crashed run would keep its
 * old mode).
 *
 * Migration (MS-1): the pre-multi-server layout kept three separate files —
 * `zen-remote-server.json` (the identity) and `zen-remote-shares.json` (the
 * table) — and the plugin row carried the one paired server's address+token.
 * {@link ensureStateMigrated} folds all three into the state file exactly
 * once, deleting a legacy file only after its data landed on disk. The
 * migration parts are also exported singly: relay-server.ts runs the identity
 * one at its `loadServerId` entry and share-store.ts runs the table one at
 * its startup load, so each writer is correct even when nothing else called
 * the combined migration first.
 *
 * Pure module discipline: no clocks of its own (`Date.now` at the two call
 * sites that need a timestamp), every read tolerant, nothing throws out of
 * the migration helpers — a damaged file degrades to an empty state, never a
 * dead plugin.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeServerUrl } from './client-pairing.js'
import { generatePeerIdentity, verifySelfCertifyingNodeId } from './peer/crypto.js'

/** The one state file this module owns, always directly under DSH_HOME. */
export const STATE_FILE_NAME = 'zen-remote-state.json'

/** Pre-multi-server identity file, migrated into the state file and deleted. */
export const LEGACY_SERVER_ID_FILE = 'zen-remote-server.json'

/** Pre-multi-server share-table file, migrated into the state file and deleted. */
export const LEGACY_SHARES_FILE = 'zen-remote-shares.json'

/** How many relay servers one sub-client may keep paired at once (MS-2). */
export const MAX_PAIRED_SERVERS = 8

/** The 8-hex short server id shape (`randomBytes(4).toString('hex')`). */
const SERVER_ID_PATTERN = /^[0-9a-f]{8}$/

/** A 32-byte key in 64 lowercase hex chars — the Ed25519 identity keys'
 * persisted shape (PG-2). */
const KEY_HEX_PATTERN = /^[0-9a-f]{64}$/

/** One row of the persisted share table (verbatim from share-store.ts). */
export interface PersistedShareRow {
  sharedAt: number
  lastActivityAt: number
}

export interface PairedServerRecord {
  /** Local stable entry id (8-hex, `randomBytes(4).toString('hex')`). */
  id: string
  /** The server address, normalized by `normalizeServerUrl`. */
  serverUrl: string
  /** The device pairing token — sensitive, 0600 on disk, NEVER echoed into
   * any state response that leaves the process. */
  token: string
  /** The server's 8-hex id as of the last completed handshake; unset until
   * the first one succeeds. */
  serverId?: string
  /** The server's display name as of the last completed handshake. */
  serverName?: string
  /** This device's id on that server, as the pairing registered it. */
  deviceId?: string
  /** This device's name in that server's table, as last confirmed. */
  deviceName?: string
  /** When the pairing was first added (epoch ms) — decides the merged
   * sidebar order and the -1/-2 numbering of duplicate display names. */
  createdAt: number
}

/** This node's long-term peer-network identity (PG-2): a self-certifying
 * Ed25519 key pair whose 8-hex `nodeId` is `sha256(publicKey)` truncated —
 * anyone who sees the pair can verify the binding with one hash. The
 * `privateKeyHex` seed is the most sensitive material in the whole state
 * file; the 0600 mode is not optional. */
export interface PeerIdentityRecord {
  /** 32-byte raw Ed25519 public key, 64 lowercase hex chars. */
  publicKeyHex: string
  /** 32-byte raw Ed25519 private seed, 64 lowercase hex chars. */
  privateKeyHex: string
  /** `sha256(publicKeyHex bytes)` first 8 hex chars. */
  nodeId: string
  /** When the identity was first materialized (epoch ms). */
  createdAt: number
}

/** This node's peer-network membership (PG-2): where the gateway lives,
 * how to re-join, which nodes this machine disabled, and the peer cap the
 * gateway announced. Written by the join flow; absent until joined. */
export interface PeerNetworkRecord {
  /** The `zr-net(s)://…` invite this machine joined through, kept for
   * display/re-join; the join key fragment inside it is sensitive. */
  inviteUri?: string
  /** The gateway's WebSocket endpoint. */
  gatewayWsUrl: string
  /** The gateway's HTTP origin. */
  gatewayHttpOrigin: string
  /** The 16-hex network id. */
  networkId: string
  /** The invite's join key, when this machine is the one who holds it. */
  joinKey?: string
  /** Node ids this machine's user disabled locally (never dial them). */
  disabledNodes?: string[]
  /** The peer cap the gateway announced (`maxPeersFromGateway`); the local
   * `maxServers` config decides whether it wins outright or only lowers. */
  maxPeersFromGateway?: number
  /** When this machine joined (epoch ms). */
  joinedAt: number
}

/** One TOFU-anchored peer public key (PG-2): the first public key this
 * machine ever saw for `nodeId`, pinned on first sight. A later key for the
 * same id is a `key-mismatch` — only an explicit user re-pin moves it. */
export interface PinnedPeerKey {
  /** The anchored 32-byte Ed25519 public key, 64 lowercase hex chars. */
  publicKeyHex: string
  /** When the anchor was first pinned (epoch ms). */
  firstSeenAt: number
  /** When the anchor last moved (a re-pin; epoch ms). */
  updatedAt: number
}

export interface ZenRemoteStateFile {
  version: 1
  serverId?: string
  sessions?: Record<string, PersistedShareRow>
  servers?: PairedServerRecord[]
  /** PG-2: the peer halves' three blocks — identity, network membership,
   * TOFU anchors. `version` stays 1: readers of the older layout see a file
   * whose fields they ignore, and the write belt below preserves fields it
   * does not understand. */
  peerIdentity?: PeerIdentityRecord
  peerNetwork?: PeerNetworkRecord
  pinnedPeers?: Record<string, PinnedPeerKey>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The one legal shape of a persisted server id (relay-server.ts mints it). */
export function isLegalServerId(value: unknown): value is string {
  return typeof value === 'string' && SERVER_ID_PATTERN.test(value)
}

// --- PG-2 field validators (read-time) --------------------------------------
// Row-level validity is each consumer's business for the OLDER fields (the
// share table validates rows, listPairedServers validates records); the peer
// blocks get read-time validators here because they carry KEY MATERIAL: a
// hostile or half-written block must degrade to absent, never load.

/** A persisted identity is reusable only if its binding verifies: the nodeId
 * must be the hash of the key — the whole PKI of the peer network, one line.
 * A hand-edited or corrupted identity regenerates instead of loading. */
function isLegalPeerIdentity(value: unknown): value is PeerIdentityRecord {
  if (!isPlainObject(value)) return false
  const { publicKeyHex, privateKeyHex, nodeId, createdAt } = value
  return (
    typeof publicKeyHex === 'string' && KEY_HEX_PATTERN.test(publicKeyHex)
    && typeof privateKeyHex === 'string' && KEY_HEX_PATTERN.test(privateKeyHex)
    && isLegalServerId(nodeId)
    && isFiniteNumber(createdAt)
    && verifySelfCertifyingNodeId(nodeId, publicKeyHex)
  )
}

function normalizePeerNetwork(value: unknown): PeerNetworkRecord | undefined {
  if (!isPlainObject(value)) return undefined
  const { gatewayWsUrl, gatewayHttpOrigin, networkId, joinedAt } = value
  if (typeof gatewayWsUrl !== 'string' || gatewayWsUrl === '') return undefined
  if (typeof gatewayHttpOrigin !== 'string' || gatewayHttpOrigin === '') return undefined
  if (typeof networkId !== 'string' || networkId === '') return undefined
  if (!isFiniteNumber(joinedAt)) return undefined
  const record: PeerNetworkRecord = { gatewayWsUrl, gatewayHttpOrigin, networkId, joinedAt }
  if (typeof value.inviteUri === 'string' && value.inviteUri !== '') record.inviteUri = value.inviteUri
  if (typeof value.joinKey === 'string' && value.joinKey !== '') record.joinKey = value.joinKey
  if (Array.isArray(value.disabledNodes)) {
    record.disabledNodes = value.disabledNodes.filter(
      (node): node is string => typeof node === 'string' && SERVER_ID_PATTERN.test(node),
    )
  }
  if (
    isFiniteNumber(value.maxPeersFromGateway)
    && Number.isInteger(value.maxPeersFromGateway)
    && value.maxPeersFromGateway >= 1
  ) {
    record.maxPeersFromGateway = value.maxPeersFromGateway
  }
  return record
}

function normalizePinnedPeers(value: unknown): Record<string, PinnedPeerKey> | undefined {
  if (!isPlainObject(value)) return undefined
  const out: Record<string, PinnedPeerKey> = Object.create(null)
  for (const [nodeId, entry] of Object.entries(value)) {
    if (!SERVER_ID_PATTERN.test(nodeId) || !isPlainObject(entry)) continue
    const { publicKeyHex, firstSeenAt, updatedAt } = entry
    if (typeof publicKeyHex !== 'string' || !KEY_HEX_PATTERN.test(publicKeyHex)) continue
    if (!isFiniteNumber(firstSeenAt) || !isFiniteNumber(updatedAt)) continue
    out[nodeId] = { publicKeyHex, firstSeenAt, updatedAt }
  }
  return out
}

/**
 * Read and parse the state file. A missing file is the normal first run; a
 * damaged file reads as empty — quarantined as `<file>.corrupt-<now>` UNLESS
 * it still carries a migration source (a legal `serverId`, the one shape the
 * migration paths know how to rescue): renaming that away would silently
 * reset the server identity on the next load, so the file stays put and the
 * salvageable field rides along in the returned state.
 * Never throws.
 */
export function readStateFile(filePath: string): ZenRemoteStateFile {
  let raw: string | null = null
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return { version: 1 }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (isPlainObject(parsed) && parsed.version === 1) {
    const state: ZenRemoteStateFile = { version: 1 }
    if (isLegalServerId(parsed.serverId)) state.serverId = parsed.serverId
    // Row-level validity is each consumer's business (share-store validates
    // rows, listPairedServers validates records) — a legal container with a
    // bad field just drops the field here. The PG-2 peer blocks are the
    // exception: they carry key material, so a bad one drops at read time.
    if (isPlainObject(parsed.sessions)) state.sessions = parsed.sessions as Record<string, PersistedShareRow>
    if (Array.isArray(parsed.servers)) state.servers = parsed.servers as PairedServerRecord[]
    if (isLegalPeerIdentity(parsed.peerIdentity)) state.peerIdentity = parsed.peerIdentity
    const peerNetwork = normalizePeerNetwork(parsed.peerNetwork)
    if (peerNetwork !== undefined) state.peerNetwork = peerNetwork
    const pinnedPeers = normalizePinnedPeers(parsed.pinnedPeers)
    if (pinnedPeers !== undefined) state.pinnedPeers = pinnedPeers
    return state
  }
  // Not a legal version:1 container. Salvage a bare legal serverId (the
  // identity is the one thing a shape-less state file can still be carrying);
  // anything else gets quarantined with its content preserved.
  if (isPlainObject(parsed) && isLegalServerId(parsed.serverId)) {
    return { version: 1, serverId: parsed.serverId }
  }
  try {
    renameSync(filePath, `${filePath}.corrupt-${Date.now()}`)
  } catch {
    // Keep the empty state either way; startup must not fail here.
  }
  return { version: 1 }
}

/**
 * The one write door: read the CURRENT file, let `updater` produce the next
 * state from it, then atomically replace the file (tmp at 0600, best-effort
 * chmod, rename). Belt AND braces: the braces are the updaters in this module
 * spreading `current` explicitly; the belt is the merge below — an updater
 * that names only the field it owns must never erase the top-level fields it
 * did not name (the partial-updater shape caught in the MS-phase1 review). A
 * field the updater explicitly sets to `undefined` still goes away, so
 * removal stays expressible. The result is normalized to the known
 * top-level fields (identity, table, list, and PG-2's peer blocks) before it
 * reaches disk. Throws on I/O failure; callers
 * decide what that means (share-store records it, loadServerId degrades, the
 * migration helpers swallow it).
 */
export function writeStateFile(filePath: string, updater: (current: ZenRemoteStateFile) => ZenRemoteStateFile): void {
  const current = readStateFile(filePath)
  const next = updater(current)
  const safe: ZenRemoteStateFile = isPlainObject(next) ? (next as ZenRemoteStateFile) : { version: 1 }
  const merged = { ...current, ...safe, version: 1 as const }
  const out: ZenRemoteStateFile = { version: 1 }
  if (isLegalServerId(merged.serverId)) out.serverId = merged.serverId
  if (isPlainObject(merged.sessions)) out.sessions = merged.sessions
  if (Array.isArray(merged.servers)) out.servers = merged.servers
  // The PG-2 peer blocks: write-time passthrough (the read path is the
  // validator), so the three-in-one belt covers them exactly like the rest.
  if (merged.peerIdentity !== undefined) out.peerIdentity = merged.peerIdentity
  if (merged.peerNetwork !== undefined) out.peerNetwork = merged.peerNetwork
  if (merged.pinnedPeers !== undefined) out.pinnedPeers = merged.pinnedPeers
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(`${filePath}.tmp`, JSON.stringify(out), { mode: 0o600 })
  // writeFileSync's mode only applies at creation; a leftover tmp from a
  // crashed run keeps its old mode, so the rename must not trust it.
  try {
    chmodSync(`${filePath}.tmp`, 0o600)
  } catch {
    // Best effort — the fresh-file mode above already covers the common path.
  }
  renameSync(`${filePath}.tmp`, filePath)
}

/**
 * Move a legacy `zen-remote-server.json` identity into the state file — but
 * only when the state file has no legal identity of its own yet. The legacy
 * file is deleted only after the write succeeded; a failed write leaves both
 * files alone so the next start can try again. Never throws.
 */
export function ensureServerIdMigrated(stateFile: string): void {
  try {
    const state = readStateFile(stateFile)
    if (state.serverId !== undefined) return
    const legacyFile = join(dirname(stateFile), LEGACY_SERVER_ID_FILE)
    let legacyId: string | undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(legacyFile, 'utf8'))
      const id = (parsed as { serverId?: unknown } | null)?.serverId
      if (typeof id === 'string' && SERVER_ID_PATTERN.test(id)) legacyId = id
    } catch {
      return
    }
    if (legacyId === undefined) return
    writeStateFile(stateFile, (current) => ({ ...current, version: 1, serverId: legacyId }))
    try {
      unlinkSync(legacyFile)
    } catch {
      // Already gone is fine — the data is in the state file now.
    }
  } catch {
    // Best effort: an unwritable home keeps its legacy files for next time.
  }
}

/** Share-store's row validity, mirrored here so migrated rows load cleanly. */
const MAX_ID_LENGTH = 200

/**
 * Move a legacy `zen-remote-shares.json` table into the state file — but only
 * when the state file carries no sessions yet. Legal rows only; the legacy
 * file is deleted only after the write succeeded. Never throws.
 */
export function ensureSharesMigrated(stateFile: string): void {
  try {
    const state = readStateFile(stateFile)
    if (state.sessions !== undefined) return
    const legacyFile = join(dirname(stateFile), LEGACY_SHARES_FILE)
    let rows: Record<string, PersistedShareRow> | undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(legacyFile, 'utf8'))
      if (isPlainObject(parsed) && parsed.version === 1 && isPlainObject(parsed.sessions)) {
        const out: Record<string, PersistedShareRow> = Object.create(null)
        for (const [id, value] of Object.entries(parsed.sessions)) {
          if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH || !isPlainObject(value)) continue
          const { sharedAt, lastActivityAt } = value
          if (!isFiniteNumber(sharedAt) || !isFiniteNumber(lastActivityAt)) continue
          out[id] = { sharedAt, lastActivityAt }
        }
        rows = out
      }
    } catch {
      return
    }
    if (rows === undefined) return
    writeStateFile(stateFile, (current) => ({ ...current, version: 1, sessions: rows }))
    try {
      unlinkSync(legacyFile)
    } catch {
      // Already gone is fine — the data is in the state file now.
    }
  } catch {
    // Best effort: an unwritable home keeps its legacy files for next time.
  }
}

function newPairedServerRecord(serverUrl: string, token: string, now?: number, deviceId?: string, deviceName?: string): PairedServerRecord {
  return {
    id: randomBytes(4).toString('hex'),
    serverUrl,
    token,
    createdAt: now ?? Date.now(),
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(deviceName !== undefined ? { deviceName } : {}),
  }
}

/** Validate one raw persisted record; anything hostile drops out of the list. */
function normalizeRecord(value: unknown): PairedServerRecord | undefined {
  if (!isPlainObject(value)) return undefined
  const { id, serverUrl, token, createdAt } = value
  if (typeof id !== 'string' || id === '' || id.length > 64) return undefined
  if (typeof serverUrl !== 'string' || serverUrl === '') return undefined
  if (typeof token !== 'string') return undefined
  if (!isFiniteNumber(createdAt)) return undefined
  const record: PairedServerRecord = { id, serverUrl, token, createdAt }
  if (isLegalServerId(value.serverId)) record.serverId = value.serverId
  if (typeof value.serverName === 'string' && value.serverName !== '') record.serverName = value.serverName
  if (typeof value.deviceId === 'string' && value.deviceId !== '') record.deviceId = value.deviceId
  if (typeof value.deviceName === 'string' && value.deviceName !== '') record.deviceName = value.deviceName
  return record
}

/**
 * The paired-servers list, in file (pairing) order, as validated copies.
 * Invalid rows are skipped — one hostile record must not hide the rest.
 */
export function listPairedServers(filePath: string): PairedServerRecord[] {
  const state = readStateFile(filePath)
  if (!Array.isArray(state.servers)) return []
  const records: PairedServerRecord[] = []
  for (const value of state.servers) {
    const record = normalizeRecord(value)
    if (record !== undefined) records.push(record)
  }
  return records
}

/** What {@link upsertPairedServer} answers. */
export type UpsertPairingResult =
  | { ok: true; record: PairedServerRecord; replaced: boolean }
  | { ok: false; code: 'invalid-url' | 'limit-reached' }

/**
 * Add or re-pair one server. A NEW address appends (refused past the
 * effective cap — `input.maxServers` when it is a legal positive integer,
 * {@link MAX_PAIRED_SERVERS} otherwise; PG-2 lets the pool pass its live
 * configured cap here); an EXISTING address updates in place — same
 * entry id, same position, same `createdAt`, fresh token and device fields —
 * which is why the cap never blocks a re-pair.
 */
export function upsertPairedServer(
  filePath: string,
  input: { serverUrl: string; token: string; deviceId?: string; deviceName?: string; now?: number; maxServers?: number },
): UpsertPairingResult {
  const normalized = normalizeServerUrl(input.serverUrl)
  if (!normalized.ok) return { ok: false, code: 'invalid-url' }
  const deviceId = typeof input.deviceId === 'string' && input.deviceId !== '' ? input.deviceId : undefined
  const deviceName = typeof input.deviceName === 'string' && input.deviceName !== '' ? input.deviceName : undefined
  const token = typeof input.token === 'string' ? input.token : ''
  const cap = typeof input.maxServers === 'number' && Number.isInteger(input.maxServers) && input.maxServers >= 1
    ? input.maxServers
    : MAX_PAIRED_SERVERS
  const records = listPairedServers(filePath)
  const existingIndex = records.findIndex((record) => record.serverUrl === normalized.url)
  if (existingIndex !== -1) {
    const updated: PairedServerRecord = {
      ...records[existingIndex],
      token,
      ...(deviceId !== undefined ? { deviceId } : {}),
      ...(deviceName !== undefined ? { deviceName } : {}),
    }
    const nextServers = [...records]
    nextServers[existingIndex] = updated
    writeStateFile(filePath, (current) => ({ ...current, version: 1, servers: nextServers }))
    return { ok: true, record: updated, replaced: true }
  }
  if (records.length >= cap) return { ok: false, code: 'limit-reached' }
  const created = newPairedServerRecord(normalized.url, token, input.now, deviceId, deviceName)
  writeStateFile(filePath, (current) => ({ ...current, version: 1, servers: [...records, created] }))
  return { ok: true, record: created, replaced: false }
}

/**
 * Fold one completed handshake into the record: `serverId`, `serverName` and
 * (when the server speaks it) `deviceName`. The second dedupe layer lives
 * here too: a DIFFERENT entry already carrying the same `serverId` is a stale
 * duplicate (the same server re-paired under a new address) — it is removed
 * from the list and reported in `removedEntryIds`, the handshaking entry
 * kept. A non-8-hex `serverId` is not recorded and dedupes nothing.
 */
export function recordServerHandshake(
  filePath: string,
  entryId: string,
  handshake: { serverId: string; serverName: string; deviceName?: string },
): { removedEntryIds: string[] } {
  if (!isLegalServerId(handshake.serverId)) return { removedEntryIds: [] }
  const records = listPairedServers(filePath)
  if (!records.some((record) => record.id === entryId)) return { removedEntryIds: [] }
  const removed: string[] = []
  const nextServers: PairedServerRecord[] = []
  for (const record of records) {
    if (record.id === entryId) {
      nextServers.push({
        ...record,
        serverId: handshake.serverId,
        ...(typeof handshake.serverName === 'string' && handshake.serverName !== '' ? { serverName: handshake.serverName } : {}),
        ...(typeof handshake.deviceName === 'string' && handshake.deviceName !== '' ? { deviceName: handshake.deviceName } : {}),
      })
      continue
    }
    if (record.serverId === handshake.serverId) {
      removed.push(record.id)
      continue
    }
    nextServers.push(record)
  }
  writeStateFile(filePath, (current) => ({ ...current, version: 1, servers: nextServers }))
  return { removedEntryIds: removed }
}

/** Remove one entry by id; true when it was actually on the list. */
export function removePairedServer(filePath: string, entryId: string): boolean {
  const records = listPairedServers(filePath)
  const next = records.filter((record) => record.id !== entryId)
  if (next.length === records.length) return false
  writeStateFile(filePath, (current) => ({ ...current, version: 1, servers: next }))
  return true
}

/** Empty the list; answers how many records went away. */
export function clearPairedServers(filePath: string): number {
  const records = listPairedServers(filePath)
  if (records.length === 0) return 0
  writeStateFile(filePath, (current) => ({ ...current, version: 1, servers: [] }))
  return records.length
}

/**
 * The third migration: the pre-multi-server row carried exactly one server's
 * address and pairing token. When the state file has no paired servers yet,
 * they become `servers[0]`; the address must pass the claim route's
 * normalizer and the token must be a non-empty string, or nothing is written.
 * Runs at most once in practice — a non-empty list is never re-migrated.
 */
export function migrateLegacyClientIntoServers(
  filePath: string,
  legacyClient: { serverUrl?: unknown; deviceToken?: unknown },
): void {
  if (listPairedServers(filePath).length > 0) return
  const serverUrl = typeof legacyClient?.serverUrl === 'string' ? legacyClient.serverUrl : undefined
  const token = typeof legacyClient?.deviceToken === 'string' ? legacyClient.deviceToken : undefined
  if (serverUrl === undefined || token === undefined || token.trim() === '') return
  const normalized = normalizeServerUrl(serverUrl)
  if (!normalized.ok) return
  writeStateFile(filePath, (current) => ({ ...current, version: 1, servers: [newPairedServerRecord(normalized.url, token)] }))
}

/**
 * The combined one-shot migration for a DSH home: identity, share table and
 * (when handed the row's legacy client credentials) the paired-servers seed.
 * Best effort end to end — any failure leaves the files as they are for the
 * next start.
 */
export function ensureStateMigrated(home: string, legacyClient?: { serverUrl?: unknown; deviceToken?: unknown }): void {
  const stateFile = join(home, STATE_FILE_NAME)
  ensureServerIdMigrated(stateFile)
  ensureSharesMigrated(stateFile)
  if (legacyClient !== undefined) {
    try {
      migrateLegacyClientIntoServers(stateFile, legacyClient)
    } catch {
      // Best effort — the legacy row credentials stay where they are.
    }
  }
}

// ---- PG-2: peer identity, network membership, TOFU pinning --------------------

/** What {@link ensurePeerIdentity} answers: the identity's three fields plus
 * the server id this machine keeps for the RELAY half (which predates the
 * peer network and is deliberately independent of it). */
export interface PeerIdentityWithServerId {
  /** 32-byte raw Ed25519 public key, 64 lowercase hex chars. */
  publicKeyHex: string
  /** 32-byte raw Ed25519 private seed, 64 lowercase hex chars. */
  privateKeyHex: string
  /** The self-certifying 8-hex node id. */
  nodeId: string
  /** The relay half's identity: an already-paired machine's old 8-hex id,
   * or — on a machine that never had one — the nodeId itself. */
  serverId: string
}

/**
 * This node's long-term peer identity, created on first use and reused
 * forever after (PG-2). A stored identity is reused only when it is still
 * LEGAL — the self-certifying binding (`nodeId === sha256(publicKey)` head)
 * must verify, so a corrupted or hostile file regenerates instead of loading.
 *
 * The relay half's `serverId` is NOT replaced by the nodeId: a machine that
 * already carries one keeps it (an upgrade that silently re-identified a
 * paired server would orphan every sub-client's pairing). Only a machine
 * with no `serverId` at all adopts the `nodeId` as one — same 8-hex shape,
 * one less identifier to mint.
 *
 * Writes are atomic and 0600 through {@link writeStateFile}; the belt keeps
 * the share table and the paired list intact.
 */
export function ensurePeerIdentity(filePath: string, now?: number): PeerIdentityWithServerId {
  const current = readStateFile(filePath)
  const existing = current.peerIdentity
  const identity: PeerIdentityRecord = existing !== undefined
    ? { ...existing }
    : { ...generatePeerIdentity(), createdAt: now ?? Date.now() }
  if (existing === undefined || current.serverId === undefined) {
    writeStateFile(filePath, (fresh) => ({
      ...fresh,
      version: 1,
      peerIdentity: identity,
      ...(fresh.serverId === undefined ? { serverId: identity.nodeId } : {}),
    }))
  }
  return {
    publicKeyHex: identity.publicKeyHex,
    privateKeyHex: identity.privateKeyHex,
    nodeId: identity.nodeId,
    serverId: current.serverId ?? identity.nodeId,
  }
}

/** The peer-network membership record, validated at read; absent until a
 * join wrote one. */
export function readPeerNetwork(filePath: string): PeerNetworkRecord | undefined {
  return readStateFile(filePath).peerNetwork
}

/**
 * Write (or clear, with `undefined`) the peer-network membership. The input
 * is the wiring's own validated record; the READ path is what validates, so
 * a hostile file degrades to "not joined" without touching the write door's
 * passthrough contract.
 */
export function writePeerNetwork(filePath: string, net: PeerNetworkRecord | undefined): void {
  writeStateFile(filePath, (current) => ({ ...current, version: 1, peerNetwork: net }))
}

/**
 * Toggle one node id on `peerNetwork.disabledNodes` — the per-machine
 * "never dial this node" list. Idempotent both ways; without a network
 * record there is nothing to toggle, so it is a silent no-op (an
 * un-joined machine disables nobody).
 */
export function setPeerNodeDisabled(filePath: string, nodeId: string, disabled: boolean): void {
  if (!isLegalServerId(nodeId)) return
  writeStateFile(filePath, (current) => {
    const net = current.peerNetwork
    if (net === undefined) return current
    const set = new Set(net.disabledNodes ?? [])
    if (disabled) set.add(nodeId)
    else set.delete(nodeId)
    return { ...current, version: 1, peerNetwork: { ...net, disabledNodes: [...set] } }
  })
}

/** What {@link verifyOrPinPeerKey} answers. */
export type VerifyOrPinPeerKeyResult =
  | { ok: true; status: 'pinned-new' | 'matched' }
  | { ok: false; code: 'invalid-self-cert' | 'key-mismatch'; expectedPublicKeyHex?: string }

/**
 * The local TOFU anchor for one peer's public key (PG-2), the defense
 * against a COMPROMISED GATEWAY feeding this machine a substituted
 * identity: the peer network's self-certifying ids are only as good as the
 * first (nodeId, publicKey) pair this machine chose to believe.
 *
 * First sight pins the key and answers `pinned-new`; an identical key
 * answers `matched` (a read, not a write); a DIFFERENT key for a pinned id
 * answers `key-mismatch` naming the anchored key and NEVER overwrites —
 * moving the anchor is {@link repinPeerKey}'s job, behind an explicit user
 * action only. A key whose hash does not produce `nodeId` is refused as
 * `invalid-self-cert` before anything is read from disk.
 */
export function verifyOrPinPeerKey(
  filePath: string,
  nodeId: string,
  publicKeyHex: string,
  now?: number,
): VerifyOrPinPeerKeyResult {
  if (!verifySelfCertifyingNodeId(nodeId, publicKeyHex)) return { ok: false, code: 'invalid-self-cert' }
  const key = publicKeyHex.toLowerCase()
  const pinned = readStateFile(filePath).pinnedPeers?.[nodeId]
  if (pinned === undefined) {
    const at = now ?? Date.now()
    writeStateFile(filePath, (current) => ({
      ...current,
      version: 1,
      pinnedPeers: { ...current.pinnedPeers, [nodeId]: { publicKeyHex: key, firstSeenAt: at, updatedAt: at } },
    }))
    return { ok: true, status: 'pinned-new' }
  }
  if (pinned.publicKeyHex === key) return { ok: true, status: 'matched' }
  return { ok: false, code: 'key-mismatch', expectedPublicKeyHex: pinned.publicKeyHex }
}

/**
 * Move a TOFU anchor to a NEW key — ONLY for the machine's user explicitly
 * choosing "trust the new identity" after a legitimate re-key (or the
 * `key-mismatch` above). The replacement must itself be self-certifying for
 * the nodeId; anything else is refused and the anchor stays put. Answers
 * whether the anchor moved.
 */
export function repinPeerKey(filePath: string, nodeId: string, newPublicKeyHex: string, now?: number): boolean {
  if (!verifySelfCertifyingNodeId(nodeId, newPublicKeyHex)) return false
  const key = newPublicKeyHex.toLowerCase()
  const at = now ?? Date.now()
  writeStateFile(filePath, (current) => {
    const pins: Record<string, PinnedPeerKey> = { ...current.pinnedPeers }
    const existing = pins[nodeId]
    pins[nodeId] = {
      publicKeyHex: key,
      firstSeenAt: existing !== undefined ? existing.firstSeenAt : at,
      updatedAt: at,
    }
    return { ...current, version: 1, pinnedPeers: pins }
  })
  return true
}
