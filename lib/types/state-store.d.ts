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
export interface ZenRemoteStateFile {
    version: 1;
    serverId?: string;
    sessions?: Record<string, PersistedShareRow>;
    servers?: PairedServerRecord[];
}
/** The one legal shape of a persisted server id (relay-server.ts mints it). */
export declare function isLegalServerId(value: unknown): value is string;
/**
 * Read and parse the state file. A missing file is the normal first run; a
 * damaged file reads as empty — quarantined as `<file>.corrupt-<now>` UNLESS
 * it still carries a migration source (a legal `serverId`, the one shape the
 * migration paths know how to rescue): renaming that away would silently
 * reset the server identity on the next load, so the file stays put and the
 * salvageable field rides along in the returned state.
 * Never throws.
 */
export declare function readStateFile(filePath: string): ZenRemoteStateFile;
/**
 * The one write door: read the CURRENT file, let `updater` produce the next
 * state from it, then atomically replace the file (tmp at 0600, best-effort
 * chmod, rename). Belt AND braces: the braces are the updaters in this module
 * spreading `current` explicitly; the belt is the merge below — an updater
 * that names only the field it owns must never erase the top-level fields it
 * did not name (the partial-updater shape caught in the MS-phase1 review). A
 * field the updater explicitly sets to `undefined` still goes away, so
 * removal stays expressible. The result is normalized to the four known
 * top-level fields before it reaches disk. Throws on I/O failure; callers
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
 * Add or re-pair one server. A NEW address appends (refused past
 * {@link MAX_PAIRED_SERVERS}); an EXISTING address updates in place — same
 * entry id, same position, same `createdAt`, fresh token and device fields —
 * which is why the cap never blocks a re-pair.
 */
export declare function upsertPairedServer(filePath: string, input: {
    serverUrl: string;
    token: string;
    deviceId?: string;
    deviceName?: string;
    now?: number;
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
//# sourceMappingURL=state-store.d.ts.map