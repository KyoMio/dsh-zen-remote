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
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeServerUrl } from './client-pairing.js';
/** The one state file this module owns, always directly under DSH_HOME. */
export const STATE_FILE_NAME = 'zen-remote-state.json';
/** Pre-multi-server identity file, migrated into the state file and deleted. */
export const LEGACY_SERVER_ID_FILE = 'zen-remote-server.json';
/** Pre-multi-server share-table file, migrated into the state file and deleted. */
export const LEGACY_SHARES_FILE = 'zen-remote-shares.json';
/** How many relay servers one sub-client may keep paired at once (MS-2). */
export const MAX_PAIRED_SERVERS = 8;
/** The 8-hex short server id shape (`randomBytes(4).toString('hex')`). */
const SERVER_ID_PATTERN = /^[0-9a-f]{8}$/;
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
/** The one legal shape of a persisted server id (relay-server.ts mints it). */
export function isLegalServerId(value) {
    return typeof value === 'string' && SERVER_ID_PATTERN.test(value);
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
export function readStateFile(filePath) {
    let raw = null;
    try {
        raw = readFileSync(filePath, 'utf8');
    }
    catch {
        return { version: 1 };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        parsed = undefined;
    }
    if (isPlainObject(parsed) && parsed.version === 1) {
        const state = { version: 1 };
        if (isLegalServerId(parsed.serverId))
            state.serverId = parsed.serverId;
        // Row-level validity is each consumer's business (share-store validates
        // rows, listPairedServers validates records) — a legal container with a
        // bad field just drops the field here.
        if (isPlainObject(parsed.sessions))
            state.sessions = parsed.sessions;
        if (Array.isArray(parsed.servers))
            state.servers = parsed.servers;
        return state;
    }
    // Not a legal version:1 container. Salvage a bare legal serverId (the
    // identity is the one thing a shape-less state file can still be carrying);
    // anything else gets quarantined with its content preserved.
    if (isPlainObject(parsed) && isLegalServerId(parsed.serverId)) {
        return { version: 1, serverId: parsed.serverId };
    }
    try {
        renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    }
    catch {
        // Keep the empty state either way; startup must not fail here.
    }
    return { version: 1 };
}
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
export function writeStateFile(filePath, updater) {
    const current = readStateFile(filePath);
    const next = updater(current);
    const safe = isPlainObject(next) ? next : { version: 1 };
    const merged = { ...current, ...safe, version: 1 };
    const out = { version: 1 };
    if (isLegalServerId(merged.serverId))
        out.serverId = merged.serverId;
    if (isPlainObject(merged.sessions))
        out.sessions = merged.sessions;
    if (Array.isArray(merged.servers))
        out.servers = merged.servers;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(`${filePath}.tmp`, JSON.stringify(out), { mode: 0o600 });
    // writeFileSync's mode only applies at creation; a leftover tmp from a
    // crashed run keeps its old mode, so the rename must not trust it.
    try {
        chmodSync(`${filePath}.tmp`, 0o600);
    }
    catch {
        // Best effort — the fresh-file mode above already covers the common path.
    }
    renameSync(`${filePath}.tmp`, filePath);
}
/**
 * Move a legacy `zen-remote-server.json` identity into the state file — but
 * only when the state file has no legal identity of its own yet. The legacy
 * file is deleted only after the write succeeded; a failed write leaves both
 * files alone so the next start can try again. Never throws.
 */
export function ensureServerIdMigrated(stateFile) {
    try {
        const state = readStateFile(stateFile);
        if (state.serverId !== undefined)
            return;
        const legacyFile = join(dirname(stateFile), LEGACY_SERVER_ID_FILE);
        let legacyId;
        try {
            const parsed = JSON.parse(readFileSync(legacyFile, 'utf8'));
            const id = parsed?.serverId;
            if (typeof id === 'string' && SERVER_ID_PATTERN.test(id))
                legacyId = id;
        }
        catch {
            return;
        }
        if (legacyId === undefined)
            return;
        writeStateFile(stateFile, (current) => ({ ...current, version: 1, serverId: legacyId }));
        try {
            unlinkSync(legacyFile);
        }
        catch {
            // Already gone is fine — the data is in the state file now.
        }
    }
    catch {
        // Best effort: an unwritable home keeps its legacy files for next time.
    }
}
/** Share-store's row validity, mirrored here so migrated rows load cleanly. */
const MAX_ID_LENGTH = 200;
/**
 * Move a legacy `zen-remote-shares.json` table into the state file — but only
 * when the state file carries no sessions yet. Legal rows only; the legacy
 * file is deleted only after the write succeeded. Never throws.
 */
export function ensureSharesMigrated(stateFile) {
    try {
        const state = readStateFile(stateFile);
        if (state.sessions !== undefined)
            return;
        const legacyFile = join(dirname(stateFile), LEGACY_SHARES_FILE);
        let rows;
        try {
            const parsed = JSON.parse(readFileSync(legacyFile, 'utf8'));
            if (isPlainObject(parsed) && parsed.version === 1 && isPlainObject(parsed.sessions)) {
                const out = Object.create(null);
                for (const [id, value] of Object.entries(parsed.sessions)) {
                    if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH || !isPlainObject(value))
                        continue;
                    const { sharedAt, lastActivityAt } = value;
                    if (!isFiniteNumber(sharedAt) || !isFiniteNumber(lastActivityAt))
                        continue;
                    out[id] = { sharedAt, lastActivityAt };
                }
                rows = out;
            }
        }
        catch {
            return;
        }
        if (rows === undefined)
            return;
        writeStateFile(stateFile, (current) => ({ ...current, version: 1, sessions: rows }));
        try {
            unlinkSync(legacyFile);
        }
        catch {
            // Already gone is fine — the data is in the state file now.
        }
    }
    catch {
        // Best effort: an unwritable home keeps its legacy files for next time.
    }
}
function newPairedServerRecord(serverUrl, token, now, deviceId, deviceName) {
    return {
        id: randomBytes(4).toString('hex'),
        serverUrl,
        token,
        createdAt: now ?? Date.now(),
        ...(deviceId !== undefined ? { deviceId } : {}),
        ...(deviceName !== undefined ? { deviceName } : {}),
    };
}
/** Validate one raw persisted record; anything hostile drops out of the list. */
function normalizeRecord(value) {
    if (!isPlainObject(value))
        return undefined;
    const { id, serverUrl, token, createdAt } = value;
    if (typeof id !== 'string' || id === '' || id.length > 64)
        return undefined;
    if (typeof serverUrl !== 'string' || serverUrl === '')
        return undefined;
    if (typeof token !== 'string')
        return undefined;
    if (!isFiniteNumber(createdAt))
        return undefined;
    const record = { id, serverUrl, token, createdAt };
    if (isLegalServerId(value.serverId))
        record.serverId = value.serverId;
    if (typeof value.serverName === 'string' && value.serverName !== '')
        record.serverName = value.serverName;
    if (typeof value.deviceId === 'string' && value.deviceId !== '')
        record.deviceId = value.deviceId;
    if (typeof value.deviceName === 'string' && value.deviceName !== '')
        record.deviceName = value.deviceName;
    return record;
}
/**
 * The paired-servers list, in file (pairing) order, as validated copies.
 * Invalid rows are skipped — one hostile record must not hide the rest.
 */
export function listPairedServers(filePath) {
    const state = readStateFile(filePath);
    if (!Array.isArray(state.servers))
        return [];
    const records = [];
    for (const value of state.servers) {
        const record = normalizeRecord(value);
        if (record !== undefined)
            records.push(record);
    }
    return records;
}
/**
 * Add or re-pair one server. A NEW address appends (refused past
 * {@link MAX_PAIRED_SERVERS}); an EXISTING address updates in place — same
 * entry id, same position, same `createdAt`, fresh token and device fields —
 * which is why the cap never blocks a re-pair.
 */
export function upsertPairedServer(filePath, input) {
    const normalized = normalizeServerUrl(input.serverUrl);
    if (!normalized.ok)
        return { ok: false, code: 'invalid-url' };
    const deviceId = typeof input.deviceId === 'string' && input.deviceId !== '' ? input.deviceId : undefined;
    const deviceName = typeof input.deviceName === 'string' && input.deviceName !== '' ? input.deviceName : undefined;
    const token = typeof input.token === 'string' ? input.token : '';
    const records = listPairedServers(filePath);
    const existingIndex = records.findIndex((record) => record.serverUrl === normalized.url);
    if (existingIndex !== -1) {
        const updated = {
            ...records[existingIndex],
            token,
            ...(deviceId !== undefined ? { deviceId } : {}),
            ...(deviceName !== undefined ? { deviceName } : {}),
        };
        const nextServers = [...records];
        nextServers[existingIndex] = updated;
        writeStateFile(filePath, (current) => ({ ...current, version: 1, servers: nextServers }));
        return { ok: true, record: updated, replaced: true };
    }
    if (records.length >= MAX_PAIRED_SERVERS)
        return { ok: false, code: 'limit-reached' };
    const created = newPairedServerRecord(normalized.url, token, input.now, deviceId, deviceName);
    writeStateFile(filePath, (current) => ({ ...current, version: 1, servers: [...records, created] }));
    return { ok: true, record: created, replaced: false };
}
/**
 * Fold one completed handshake into the record: `serverId`, `serverName` and
 * (when the server speaks it) `deviceName`. The second dedupe layer lives
 * here too: a DIFFERENT entry already carrying the same `serverId` is a stale
 * duplicate (the same server re-paired under a new address) — it is removed
 * from the list and reported in `removedEntryIds`, the handshaking entry
 * kept. A non-8-hex `serverId` is not recorded and dedupes nothing.
 */
export function recordServerHandshake(filePath, entryId, handshake) {
    if (!isLegalServerId(handshake.serverId))
        return { removedEntryIds: [] };
    const records = listPairedServers(filePath);
    if (!records.some((record) => record.id === entryId))
        return { removedEntryIds: [] };
    const removed = [];
    const nextServers = [];
    for (const record of records) {
        if (record.id === entryId) {
            nextServers.push({
                ...record,
                serverId: handshake.serverId,
                ...(typeof handshake.serverName === 'string' && handshake.serverName !== '' ? { serverName: handshake.serverName } : {}),
                ...(typeof handshake.deviceName === 'string' && handshake.deviceName !== '' ? { deviceName: handshake.deviceName } : {}),
            });
            continue;
        }
        if (record.serverId === handshake.serverId) {
            removed.push(record.id);
            continue;
        }
        nextServers.push(record);
    }
    writeStateFile(filePath, (current) => ({ ...current, version: 1, servers: nextServers }));
    return { removedEntryIds: removed };
}
/** Remove one entry by id; true when it was actually on the list. */
export function removePairedServer(filePath, entryId) {
    const records = listPairedServers(filePath);
    const next = records.filter((record) => record.id !== entryId);
    if (next.length === records.length)
        return false;
    writeStateFile(filePath, (current) => ({ ...current, version: 1, servers: next }));
    return true;
}
/** Empty the list; answers how many records went away. */
export function clearPairedServers(filePath) {
    const records = listPairedServers(filePath);
    if (records.length === 0)
        return 0;
    writeStateFile(filePath, (current) => ({ ...current, version: 1, servers: [] }));
    return records.length;
}
/**
 * The third migration: the pre-multi-server row carried exactly one server's
 * address and pairing token. When the state file has no paired servers yet,
 * they become `servers[0]`; the address must pass the claim route's
 * normalizer and the token must be a non-empty string, or nothing is written.
 * Runs at most once in practice — a non-empty list is never re-migrated.
 */
export function migrateLegacyClientIntoServers(filePath, legacyClient) {
    if (listPairedServers(filePath).length > 0)
        return;
    const serverUrl = typeof legacyClient?.serverUrl === 'string' ? legacyClient.serverUrl : undefined;
    const token = typeof legacyClient?.deviceToken === 'string' ? legacyClient.deviceToken : undefined;
    if (serverUrl === undefined || token === undefined || token.trim() === '')
        return;
    const normalized = normalizeServerUrl(serverUrl);
    if (!normalized.ok)
        return;
    writeStateFile(filePath, (current) => ({ ...current, version: 1, servers: [newPairedServerRecord(normalized.url, token)] }));
}
/**
 * The combined one-shot migration for a DSH home: identity, share table and
 * (when handed the row's legacy client credentials) the paired-servers seed.
 * Best effort end to end — any failure leaves the files as they are for the
 * next start.
 */
export function ensureStateMigrated(home, legacyClient) {
    const stateFile = join(home, STATE_FILE_NAME);
    ensureServerIdMigrated(stateFile);
    ensureSharesMigrated(stateFile);
    if (legacyClient !== undefined) {
        try {
            migrateLegacyClientIntoServers(stateFile, legacyClient);
        }
        catch {
            // Best effort — the legacy row credentials stay where they are.
        }
    }
}
//# sourceMappingURL=state-store.js.map