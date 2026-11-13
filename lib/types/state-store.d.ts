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
 * The file is 0600 on purpose: `servers` rows carry pairing tokens and the
 * peer identity carries the private seed. The write is the same atomic
 * tmp+rename dance the share table has always used, with a MANDATORY chmod
 * in front of the rename (writeFileSync's `mode` only applies at creation —
 * a leftover `.tmp` from a crashed run would keep its old mode): a chmod
 * that fails aborts the write, removes the tmp and surfaces the error, so a
 * state file is never replaced by one of unknown mode (PC-13). The 0600 is a
 * POSIX promise — on Windows chmodSync can only move the read-only
 * attribute, and nothing here claims ACL equivalence.
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
/** The one state file this module owns, always directly under DSH_HOME. */
export declare const STATE_FILE_NAME = "zen-remote-state.json";
/** Pre-multi-server identity file, migrated into the state file and deleted. */
export declare const LEGACY_SERVER_ID_FILE = "zen-remote-server.json";
/** Pre-multi-server share-table file, migrated into the state file and deleted. */
export declare const LEGACY_SHARES_FILE = "zen-remote-shares.json";
/** How many relay servers one sub-client may keep paired at once (MS-2). */
export declare const MAX_PAIRED_SERVERS = 8;
/** One row of the persisted share table (verbatim from share-store.ts). */
export interface PersistedShareRow {
    sharedAt: number;
    lastActivityAt: number;
}
export interface PairedServerRecord {
    /** Local stable entry id (8-hex, `randomBytes(4).toString('hex')`). */
    id: string;
    /** The server address, normalized by `normalizeServerUrl`. */
    serverUrl: string;
    /** The device pairing token — sensitive, 0600 on disk, NEVER echoed into
     * any state response that leaves the process. */
    token: string;
    /** The server's 8-hex id as of the last completed handshake; unset until
     * the first one succeeds. */
    serverId?: string;
    /** The server's display name as of the last completed handshake. */
    serverName?: string;
    /** This device's id on that server, as the pairing registered it. */
    deviceId?: string;
    /** This device's name in that server's table, as last confirmed. */
    deviceName?: string;
    /** When the pairing was first added (epoch ms) — decides the merged
     * sidebar order and the -1/-2 numbering of duplicate display names. */
    createdAt: number;
}
/** This node's long-term peer-network identity (PG-2): a self-certifying
 * Ed25519 key pair whose 8-hex `nodeId` is `sha256(publicKey)` truncated —
 * anyone who sees the pair can verify the binding with one hash. The
 * `privateKeyHex` seed is the most sensitive material in the whole state
 * file; the 0600 mode is not optional. */
export interface PeerIdentityRecord {
    /** 32-byte raw Ed25519 public key, 64 lowercase hex chars. */
    publicKeyHex: string;
    /** 32-byte raw Ed25519 private seed, 64 lowercase hex chars. */
    privateKeyHex: string;
    /** `sha256(publicKeyHex bytes)` first 8 hex chars. */
    nodeId: string;
    /** When the identity was first materialized (epoch ms). */
    createdAt: number;
}
/** This node's peer-network membership (PG-2): where the gateway lives,
 * how to re-join, which nodes this machine disabled, and the peer cap the
 * gateway announced. Written by the join flow; absent until joined. */
export interface PeerNetworkRecord {
    /** The `zr-net(s)://…` invite this machine joined through, kept for
     * display/re-join; the join key fragment inside it is sensitive. */
    inviteUri?: string;
    /** The gateway's WebSocket endpoint. */
    gatewayWsUrl: string;
    /** The gateway's HTTP origin. */
    gatewayHttpOrigin: string;
    /** The 16-hex network id. */
    networkId: string;
    /** The invite's join key, when this machine is the one who holds it. */
    joinKey?: string;
    /** Node ids this machine's user disabled locally (never dial them). */
    disabledNodes?: string[];
    /** The peer cap the gateway announced (`maxPeersFromGateway`); the local
     * `maxServers` config decides whether it wins outright or only lowers. */
    maxPeersFromGateway?: number;
    /** When this machine joined (epoch ms). */
    joinedAt: number;
}
/** One TOFU-anchored peer public key (PG-2): the first public key this
 * machine ever saw for `nodeId`, pinned on first sight. A later key for the
 * same id is a `key-mismatch` — only an explicit user re-pin moves it. */
export interface PinnedPeerKey {
    /** The anchored 32-byte Ed25519 public key, 64 lowercase hex chars. */
    publicKeyHex: string;
    /** When the anchor was first pinned (epoch ms). */
    firstSeenAt: number;
    /** When the anchor last moved (a re-pin; epoch ms). */
    updatedAt: number;
}
export interface ZenRemoteStateFile {
    version: 1;
    serverId?: string;
    sessions?: Record<string, PersistedShareRow>;
    servers?: PairedServerRecord[];
    /** PG-2: the peer halves' three blocks — identity, network membership,
     * TOFU anchors. `version` stays 1: readers of the older layout see a file
     * whose fields they ignore, and the write belt below preserves fields it
     * does not understand. */
    peerIdentity?: PeerIdentityRecord;
    peerNetwork?: PeerNetworkRecord;
    pinnedPeers?: Record<string, PinnedPeerKey>;
}
/** The one legal shape of a persisted server id (relay-server.ts mints it). */
export declare function isLegalServerId(value: unknown): value is string;
/**
 * The tolerant read most callers want: identical to {@link readStateFileStrict}
 * except that storage failures degrade to an empty state too. Never throws —
 * a damaged or unreadable file degrades, never a dead plugin. Writers use the
 * strict variant instead: overwriting a file they could not read is how
 * state silently disappears (PC-13).
 */
export declare function readStateFile(filePath: string): ZenRemoteStateFile;
/**
 * The one write door: read the CURRENT file, let `updater` produce the next
 * state from it, then atomically replace the file (tmp at 0600, mandatory
 * chmod, rename). Belt AND braces: the braces are the updaters in this module
 * spreading `current` explicitly; the belt is the merge below — an updater
 * that names only the field it owns must never erase the top-level fields it
 * did not name (the partial-updater shape caught in the MS-phase1 review). A
 * field the updater explicitly sets to `undefined` still goes away, so
 * removal stays expressible. The result is normalized to the known
 * top-level fields (identity, table, list, and PG-2's peer blocks) before it
 * reaches disk. The read is the STRICT one (PC-13): an existing file that
 * cannot be read makes the write throw, never rename a fresh state over
 * data the writer never saw. Throws on I/O failure; callers
 * decide what that means (share-store records it, loadServerId degrades, the
 * migration helpers swallow it).
 */
export declare function writeStateFile(filePath: string, updater: (current: ZenRemoteStateFile) => ZenRemoteStateFile): void;
/**
 * Move a legacy `zen-remote-server.json` identity into the state file — but
 * only when the state file has no legal identity of its own yet. The legacy
 * file is deleted only after the write succeeded; a failed write leaves both
 * files alone so the next start can try again. Never throws.
 */
export declare function ensureServerIdMigrated(stateFile: string): void;
/**
 * Move a legacy `zen-remote-shares.json` table into the state file — but only
 * when the state file carries no sessions yet. Legal rows only; the legacy
 * file is deleted only after the write succeeded. Never throws.
 */
export declare function ensureSharesMigrated(stateFile: string): void;
/**
 * The paired-servers list, in file (pairing) order, as validated copies.
 * Invalid rows are skipped — one hostile record must not hide the rest.
 */
export declare function listPairedServers(filePath: string): PairedServerRecord[];
/** What {@link upsertPairedServer} answers. */
export type UpsertPairingResult = {
    ok: true;
    record: PairedServerRecord;
    replaced: boolean;
} | {
    ok: false;
    code: 'invalid-url' | 'limit-reached';
};
/**
 * Add or re-pair one server. A NEW address appends (refused past the
 * effective cap — `input.maxServers` when it is a legal positive integer,
 * {@link MAX_PAIRED_SERVERS} otherwise; PG-2 lets the pool pass its live
 * configured cap here); an EXISTING address updates in place — same
 * entry id, same position, same `createdAt`, fresh token and device fields —
 * which is why the cap never blocks a re-pair.
 */
export declare function upsertPairedServer(filePath: string, input: {
    serverUrl: string;
    token: string;
    deviceId?: string;
    deviceName?: string;
    now?: number;
    maxServers?: number;
}): UpsertPairingResult;
/**
 * Fold one completed handshake into the record: `serverId`, `serverName` and
 * (when the server speaks it) `deviceName`. The second dedupe layer lives
 * here too: a DIFFERENT entry already carrying the same `serverId` is a stale
 * duplicate (the same server re-paired under a new address) — it is removed
 * from the list and reported in `removedEntryIds`, the handshaking entry
 * kept. A non-8-hex `serverId` is not recorded and dedupes nothing.
 */
export declare function recordServerHandshake(filePath: string, entryId: string, handshake: {
    serverId: string;
    serverName: string;
    deviceName?: string;
}): {
    removedEntryIds: string[];
};
/** Remove one entry by id; true when it was actually on the list. */
export declare function removePairedServer(filePath: string, entryId: string): boolean;
/** Empty the list; answers how many records went away. */
export declare function clearPairedServers(filePath: string): number;
/**
 * The third migration: the pre-multi-server row carried exactly one server's
 * address and pairing token. When the state file has no paired servers yet,
 * they become `servers[0]`; the address must pass the claim route's
 * normalizer and the token must be a non-empty string, or nothing is written.
 * Runs at most once in practice — a non-empty list is never re-migrated.
 */
export declare function migrateLegacyClientIntoServers(filePath: string, legacyClient: {
    serverUrl?: unknown;
    deviceToken?: unknown;
}): void;
/**
 * The combined one-shot migration for a DSH home: identity, share table and
 * (when handed the row's legacy client credentials) the paired-servers seed.
 * Best effort end to end — any failure leaves the files as they are for the
 * next start.
 */
export declare function ensureStateMigrated(home: string, legacyClient?: {
    serverUrl?: unknown;
    deviceToken?: unknown;
}): void;
/** What {@link ensurePeerIdentity} answers: the identity's three fields plus
 * the server id this machine keeps for the RELAY half (which predates the
 * peer network and is deliberately independent of it). */
export interface PeerIdentityWithServerId {
    /** 32-byte raw Ed25519 public key, 64 lowercase hex chars. */
    publicKeyHex: string;
    /** 32-byte raw Ed25519 private seed, 64 lowercase hex chars. */
    privateKeyHex: string;
    /** The self-certifying 8-hex node id. */
    nodeId: string;
    /** The relay half's identity: an already-paired machine's old 8-hex id,
     * or — on a machine that never had one — the nodeId itself. */
    serverId: string;
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
 *
 * PC-13: the pure-reuse path below performs NO write, so a wide mode on an
 * already-valid identity file would never be touched again — the mode is
 * checked and repaired to 0600 BEFORE reading, and a failed repair (or an
 * unreadable file, via the strict read) throws here. It must never be read
 * as "no identity": that would mint a fresh private key and rename it over
 * the old one.
 */
export declare function ensurePeerIdentity(filePath: string, now?: number): PeerIdentityWithServerId;
/** The peer-network membership record, validated at read; absent until a
 * join wrote one. */
export declare function readPeerNetwork(filePath: string): PeerNetworkRecord | undefined;
/**
 * Write (or clear, with `undefined`) the peer-network membership. The input
 * is the wiring's own validated record; the READ path is what validates, so
 * a hostile file degrades to "not joined" without touching the write door's
 * passthrough contract.
 */
export declare function writePeerNetwork(filePath: string, net: PeerNetworkRecord | undefined): void;
/**
 * Toggle one node id on `peerNetwork.disabledNodes` — the per-machine
 * "never dial this node" list. Idempotent both ways; without a network
 * record there is nothing to toggle, so it is a silent no-op (an
 * un-joined machine disables nobody).
 */
export declare function setPeerNodeDisabled(filePath: string, nodeId: string, disabled: boolean): void;
/** What {@link verifyOrPinPeerKey} answers. */
export type VerifyOrPinPeerKeyResult = {
    ok: true;
    status: 'pinned-new' | 'matched';
} | {
    ok: false;
    code: 'invalid-self-cert' | 'key-mismatch';
    expectedPublicKeyHex?: string;
};
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
export declare function verifyOrPinPeerKey(filePath: string, nodeId: string, publicKeyHex: string, now?: number): VerifyOrPinPeerKeyResult;
/**
 * Move a TOFU anchor to a NEW key — ONLY for the machine's user explicitly
 * choosing "trust the new identity" after a legitimate re-key (or the
 * `key-mismatch` above). The replacement must itself be self-certifying for
 * the nodeId; anything else is refused and the anchor stays put. Answers
 * whether the anchor moved.
 */
export declare function repinPeerKey(filePath: string, nodeId: string, newPublicKeyHex: string, now?: number): boolean;
//# sourceMappingURL=state-store.d.ts.map