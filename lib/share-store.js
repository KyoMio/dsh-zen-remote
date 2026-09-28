/**
 * Shared "which sessions have remote enabled" table (2.0.0 remote-session
 * groundwork): pure logic plus a small JSON file under the DSH data dir. The
 * server opens/closes remote per session; a paired desktop client may close
 * but never open; everything else here exists to make one rule survivable
 * across restarts — an idle shared session must put itself away.
 *
 * Three clock rules, all driven by the caller:
 * - `touch()` marks activity (turn start/end, message sent, approval or
 *   question answered — opening a session to look at it is NOT activity).
 * - `setBusy()` marks running/waiting; busy sessions never idle out and the
 *   idle clock restarts from the moment busy ends.
 * - everything else is derived: `sweep()` closes whatever has been idle past
 *   `idleHours`, `remainingMs()` reports the countdown.
 *
 * Accessibility crosses generations: subagent and fork sessions are reachable
 * when any ancestor is shared, without themselves appearing in the table
 * (`isAccessible` walks `parentOf`).
 *
 * Persistence is deliberately dumb: one JSON file, rewritten atomically
 * (tmp + rename) after every operation that changes what the file would say,
 * synchronously, because a crash right after "share" must not silently
 * un-share. `busy` is never persisted — after a restart every session is
 * idle by definition until the caller says otherwise.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const FILE_VERSION = 1;
const DEFAULT_IDLE_HOURS = 48;
/** One year — beyond that an "idle budget" is a typo, not a policy. */
const MAX_IDLE_HOURS = 8760;
const HOUR_MS = 3_600_000;
/** Session ids longer than this are considered hostile, not real. */
const MAX_ID_LENGTH = 200;
/** Same-walkancestor bound for isAccessible: deep subagent chains must not
 * turn into an unbounded walk, and a cycle must not turn into a hang. */
const MAX_ANCESTOR_DEPTH = 16;
/** Disk-write throttle for lastActivityAt (see flushActivity below). */
const ACTIVITY_FLUSH_INTERVAL_MS = 60_000;
function isValidId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH;
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function normalizeIdleHours(hours) {
    return typeof hours === 'number' && Number.isFinite(hours) && hours > 0 && hours <= MAX_IDLE_HOURS
        ? hours
        : DEFAULT_IDLE_HOURS;
}
export function createShareStore(options) {
    const file = options.file;
    const now = options.now ?? Date.now;
    let idleHours = normalizeIdleHours(options.idleHours);
    /** Insertion order = shared order = file key order, so the persisted JSON
     * is stable across reloads as long as nothing is removed. */
    const sessions = new Map();
    /** Per-session time of the last DISK write of lastActivityAt — the
     * throttle state for flushActivity, not the activity itself. */
    const activityFlushedAt = new Map();
    const listeners = new Set();
    /** Set by persist() when the tmp+rename dance failed; undefined after a
     * successful write. Debugging aid only — write failures never throw. */
    let lastWriteError;
    // ---- startup load (synchronous, once) ----
    //
    // Missing file = first run, empty table. Unreadable path (a directory,
    // permissions) also starts empty but is NOT quarantined — renaming
    // something we could not even read could eat a live directory.
    let raw = null;
    try {
        raw = readFileSync(file, 'utf8');
    }
    catch {
        raw = null;
    }
    if (raw !== null) {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            parsed = undefined;
        }
        // Container-level damage (unparseable JSON, wrong version, wrong shape)
        // quarantines the whole file; row-level damage (one bad record) only
        // skips that record — the rest of the table is worth keeping.
        if (isPlainObject(parsed) && parsed.version === FILE_VERSION && isPlainObject(parsed.sessions)) {
            for (const [id, value] of Object.entries(parsed.sessions)) {
                if (!isValidId(id) || !isPlainObject(value))
                    continue;
                const { sharedAt, lastActivityAt } = value;
                if (!isFiniteNumber(sharedAt) || !isFiniteNumber(lastActivityAt))
                    continue;
                sessions.set(id, { sharedAt, lastActivityAt, busy: false });
            }
        }
        else {
            try {
                renameSync(file, `${file}.corrupt-${now()}`);
            }
            catch {
                // Keep the empty table either way; startup must not fail here.
            }
        }
    }
    function emit(event) {
        // Snapshot: a listener may unsubscribe itself (or others) mid-delivery.
        for (const listener of [...listeners]) {
            try {
                listener(event);
            }
            catch {
                // Listeners are bystanders: their failures belong to them.
            }
        }
    }
    function persist() {
        // Null prototype: with a plain {} an id of "__proto__" would hit the
        // prototype setter instead of becoming an own property, so the row would
        // silently vanish from JSON.stringify and from the next load. (Loading is
        // safe the other way round: JSON.parse defines "__proto__" as an own data
        // property, which Object.entries picks up.)
        const fileSessions = Object.create(null);
        for (const [id, row] of sessions) {
            // busy is deliberately absent: restarts always resume as idle.
            fileSessions[id] = { sharedAt: row.sharedAt, lastActivityAt: row.lastActivityAt };
        }
        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(`${file}.tmp`, JSON.stringify({ version: FILE_VERSION, sessions: fileSessions }));
            renameSync(`${file}.tmp`, file);
            lastWriteError = undefined;
        }
        catch (error) {
            lastWriteError = error;
        }
    }
    /**
     * ponytail: lastActivityAt 的写盘按会话节流为最多每 60 秒一次（touch 在
     * 回合中可能每秒都来，每次都落盘太浪费）。内存值永远即时更新，节流只压
     * 写盘，所以进程崩溃后恢复的 lastActivityAt 最多落后真实值 60 秒——闲置
     * 计时因此最多偏差 60 秒，相对 48 小时量级的休眠阈值可以接受。结构性写盘
     * （share / unshare / sweep）不节流。
     */
    function flushActivity(id, t) {
        const flushedAt = activityFlushedAt.get(id);
        if (flushedAt !== undefined && t - flushedAt < ACTIVITY_FLUSH_INTERVAL_MS)
            return;
        activityFlushedAt.set(id, t);
        persist();
    }
    const store = {
        share(sessionId) {
            if (!isValidId(sessionId))
                return false;
            const t = now();
            const existing = sessions.get(sessionId);
            if (existing !== undefined) {
                // "已开启多久"从第一次算起，但重复开启算一次活跃。
                existing.lastActivityAt = t;
                activityFlushedAt.set(sessionId, t);
                persist();
                return false;
            }
            sessions.set(sessionId, { sharedAt: t, lastActivityAt: t, busy: false });
            activityFlushedAt.set(sessionId, t);
            persist();
            emit({ type: 'shared', sessionId });
            return true;
        },
        unshare(sessionId, reason) {
            if (!isValidId(sessionId) || !sessions.has(sessionId))
                return false;
            sessions.delete(sessionId);
            activityFlushedAt.delete(sessionId);
            persist();
            emit({ type: 'unshared', sessionId, reason });
            return true;
        },
        isShared(sessionId) {
            return isValidId(sessionId) && sessions.has(sessionId);
        },
        isAccessible(sessionId, parentOf) {
            if (!isValidId(sessionId))
                return false;
            if (sessions.has(sessionId))
                return true;
            // Subagent/fork sessions never enter the table; their reachability is
            // borrowed from the ancestor chain. Bound the walk (depth) and stop
            // dead on cycles (a repeated id) so a hostile parentOf cannot hang us.
            const seen = new Set([sessionId]);
            let current = sessionId;
            for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
                let parent;
                try {
                    parent = parentOf(current);
                }
                catch {
                    // A throwing parentOf means "no parent from here".
                    return false;
                }
                if (parent === undefined || !isValidId(parent))
                    return false;
                if (seen.has(parent))
                    return false;
                seen.add(parent);
                if (sessions.has(parent))
                    return true;
                current = parent;
            }
            return false;
        },
        touch(sessionId) {
            const row = isValidId(sessionId) ? sessions.get(sessionId) : undefined;
            if (row === undefined)
                return;
            const t = now();
            row.lastActivityAt = t;
            flushActivity(sessionId, t);
        },
        setBusy(sessionId, busy) {
            const row = isValidId(sessionId) ? sessions.get(sessionId) : undefined;
            if (row === undefined || row.busy === busy)
                return;
            row.busy = busy;
            if (!busy) {
                // Busy sessions never count toward idle; the clock restarts from the
                // moment busy ends, which is why this write carries a fresh stamp.
                const t = now();
                row.lastActivityAt = t;
                flushActivity(sessionId, t);
            }
            // busy itself is never persisted; a restart resumes as idle.
        },
        sweep() {
            const t = now();
            const idleMs = idleHours * HOUR_MS;
            const expired = [];
            for (const [id, row] of sessions) {
                if (!row.busy && t - row.lastActivityAt >= idleMs)
                    expired.push(id);
            }
            if (expired.length === 0)
                return expired;
            expired.sort();
            for (const id of expired) {
                sessions.delete(id);
                activityFlushedAt.delete(id);
            }
            persist();
            for (const id of expired)
                emit({ type: 'unshared', sessionId: id, reason: 'idle' });
            return expired;
        },
        remainingMs(sessionId) {
            const row = isValidId(sessionId) ? sessions.get(sessionId) : undefined;
            if (row === undefined)
                return undefined;
            if (row.busy)
                return Infinity;
            return Math.max(0, row.lastActivityAt + idleHours * HOUR_MS - now());
        },
        list() {
            return [...sessions.entries()]
                .map(([id, row]) => ({
                sessionId: id,
                sharedAt: row.sharedAt,
                lastActivityAt: row.lastActivityAt,
                busy: row.busy,
            }))
                .sort((a, b) => a.sharedAt - b.sharedAt || (a.sessionId < b.sessionId ? -1 : 1));
        },
        setIdleHours(hours) {
            if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > MAX_IDLE_HOURS) {
                return;
            }
            idleHours = hours;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
    // Debugging aid, outside the public interface on purpose: when remote
    // state "does not stick", this is where the write error hides.
    Object.defineProperty(store, 'lastWriteError', {
        get: () => lastWriteError,
        enumerable: false,
    });
    return store;
}
//# sourceMappingURL=share-store.js.map