/**
 * Background cold-safe prewarm scheduler for connected remote servers (T5).
 *
 * - Discovers shared root sessions via `session/list` (or a single proactive
 *   fallback pull when an online target supports `fetchSessionSnapshot`),
 *   excluding `subagent` children and sorting by `updatedAt` descending.
 * - Maintains strict `concurrency = 1` per `serverId` across the Top `16`
 *   root sessions, using `fetchSessionSnapshot` (cold-safe single-frame pull).
 * - Immediately aborts any in-flight prewarm when foreground RPC/stream setup
 *   starts (`notifyForegroundBusy(serverId, true)`), and waits `idleDelayMs`
 *   (`300 ms`) after foreground goes idle before resuming.
 * - Tracks `workspace/follow` disappearances (unshared sessions) to purge cache
 *   immediately, and refreshes stale/dirty cached sessions when `running`
 *   flips `true -> false` or `session/control` advances past `cached.cursor`.
 */
import { RelayError } from './relay-client.js';
export const DEFAULT_PREWARM_TOP_N = 16;
export const DEFAULT_PREWARM_IDLE_DELAY_MS = 300;
export const DEFAULT_PROACTIVE_LIST_DELAY_MS = 1000;
const PREWARM_MAX_MESSAGES = 500;
const PREWARM_TURN_WINDOW = { minMessages: 50, minTurns: 2 };
const defaultClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        if (typeof timer.unref === 'function')
            timer.unref();
        return timer;
    },
    clearTimeout: (handle) => {
        clearTimeout(handle);
    },
};
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseUpdatedAtMs(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw))
        return raw;
    if (typeof raw === 'string' && raw !== '') {
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return 0;
}
function unrefTimer(handle) {
    if (handle !== null && typeof handle === 'object' && typeof handle.unref === 'function') {
        ;
        handle.unref();
    }
}
function supportsSnapshotEndpoint(client) {
    return typeof client.fetchSessionSnapshot === 'function';
}
export function createSessionPrewarmScheduler(deps) {
    const { cache, getOnlineTargets, isForegroundBusy, isSessionActivelyFollowed, onError } = deps;
    const topN = deps.topN ?? DEFAULT_PREWARM_TOP_N;
    const idleDelayMs = deps.idleDelayMs ?? DEFAULT_PREWARM_IDLE_DELAY_MS;
    const proactiveListDelayMs = deps.proactiveListDelayMs ?? DEFAULT_PROACTIVE_LIST_DELAY_MS;
    const clock = deps.clock ?? defaultClock;
    const servers = new Map();
    let disposed = false;
    function getOrCreateState(serverId) {
        let state = servers.get(serverId);
        if (state === undefined) {
            state = {
                candidates: new Map(),
                workspaceSessions: new Map(),
                knownWorkspaceUnion: new Set(),
                hasReceivedList: false,
                proactiveListSent: false,
                proactiveListTimer: undefined,
                idleResumeTimer: undefined,
                scheduledMicrotask: false,
                inFlight: undefined,
                paused: false,
                unsupportedClient: undefined,
                oversizedCursorBySession: new Map(),
                failedSessions: new Set(),
            };
            servers.set(serverId, state);
        }
        return state;
    }
    function clearTimer(handle) {
        if (handle !== undefined)
            clock.clearTimeout(handle);
    }
    function clearServerTimers(state) {
        clearTimer(state.proactiveListTimer);
        state.proactiveListTimer = undefined;
        clearTimer(state.idleResumeTimer);
        state.idleResumeTimer = undefined;
    }
    function findOnlineTarget(serverId) {
        for (const target of getOnlineTargets()) {
            if (target.serverId === serverId && target.client.state === 'online')
                return target;
        }
        return undefined;
    }
    function ensureProactiveListTimer(serverId, state) {
        if (disposed || state.paused || state.hasReceivedList || state.proactiveListSent)
            return;
        if (state.proactiveListTimer !== undefined || isForegroundBusy(serverId))
            return;
        const target = findOnlineTarget(serverId);
        if (target === undefined || !supportsSnapshotEndpoint(target.client))
            return;
        const timer = clock.setTimeout(() => {
            state.proactiveListTimer = undefined;
            if (disposed || state.paused || state.hasReceivedList || state.proactiveListSent)
                return;
            if (isForegroundBusy(serverId))
                return;
            const liveTarget = findOnlineTarget(serverId);
            if (liveTarget === undefined || !supportsSnapshotEndpoint(liveTarget.client))
                return;
            state.proactiveListSent = true;
            void liveTarget.client.invoke('session', 'list', { _request: {} }, undefined).then((value) => {
                if (!disposed && servers.get(serverId) === state)
                    noteSessionList(serverId, value);
            }, () => {
                // Best-effort proactive seed: passive callers still feed noteSessionList.
            });
        }, proactiveListDelayMs);
        unrefTimer(timer);
        state.proactiveListTimer = timer;
    }
    function pickNextTask(serverId, state) {
        const sorted = [...state.candidates.values()].sort((a, b) => {
            if (a.hasListMeta !== b.hasListMeta)
                return a.hasListMeta ? -1 : 1;
            return b.updatedAtMs - a.updatedAtMs;
        });
        const topCandidates = sorted.slice(0, topN);
        for (const c of topCandidates) {
            if (isSessionActivelyFollowed?.(serverId, c.sessionId))
                continue;
            if (state.failedSessions.has(c.sessionId))
                continue;
            const cached = cache.peekSnapshotMeta(serverId, c.sessionId);
            if (cached !== undefined)
                continue;
            const oversizedCursor = state.oversizedCursorBySession.get(c.sessionId);
            if (oversizedCursor !== undefined && (c.observedSeq === undefined || c.observedSeq <= oversizedCursor)) {
                continue;
            }
            return { kind: 'cold', candidate: c };
        }
        for (const c of topCandidates) {
            if (isSessionActivelyFollowed?.(serverId, c.sessionId))
                continue;
            if (state.failedSessions.has(c.sessionId))
                continue;
            if (c.running)
                continue;
            const cached = cache.peekSnapshotMeta(serverId, c.sessionId);
            if (cached === undefined)
                continue;
            const needsRefresh = c.dirty ||
                cached.stale ||
                (c.observedSeq !== undefined && c.observedSeq > cached.cursor && c.observedSeq > (c.lastSyncedSeq ?? -1));
            if (!needsRefresh)
                continue;
            const oversizedCursor = state.oversizedCursorBySession.get(c.sessionId);
            if (oversizedCursor !== undefined && (c.observedSeq === undefined || c.observedSeq <= oversizedCursor)) {
                continue;
            }
            return {
                kind: 'refresh',
                candidate: c,
                ...(cached.stale ? {} : { knownCursor: cached.cursor }),
            };
        }
        return undefined;
    }
    function scheduleServer(serverId) {
        if (disposed)
            return;
        const state = servers.get(serverId);
        if (state === undefined || state.paused || state.inFlight !== undefined)
            return;
        if (state.idleResumeTimer !== undefined || isForegroundBusy(serverId))
            return;
        const target = findOnlineTarget(serverId);
        if (target === undefined || !supportsSnapshotEndpoint(target.client))
            return;
        if (state.unsupportedClient === target.client)
            return;
        ensureProactiveListTimer(serverId, state);
        if (state.scheduledMicrotask)
            return;
        state.scheduledMicrotask = true;
        queueMicrotask(() => {
            state.scheduledMicrotask = false;
            void runNext(serverId);
        });
    }
    async function runNext(serverId) {
        if (disposed)
            return;
        const state = servers.get(serverId);
        if (state === undefined || state.paused || state.inFlight !== undefined)
            return;
        if (state.idleResumeTimer !== undefined || isForegroundBusy(serverId))
            return;
        const target = findOnlineTarget(serverId);
        if (target === undefined || !supportsSnapshotEndpoint(target.client))
            return;
        if (state.unsupportedClient === target.client)
            return;
        const task = pickNextTask(serverId, state);
        if (task === undefined)
            return;
        const candidate = task.candidate;
        const sessionId = candidate.sessionId;
        const abort = new AbortController();
        const flight = { sessionId, abort };
        state.inFlight = flight;
        let retryAfterDelay = false;
        try {
            const res = await target.client.fetchSessionSnapshot({
                address: { kind: 'session', sessionId },
                maxMessages: PREWARM_MAX_MESSAGES,
                turnWindow: PREWARM_TURN_WINDOW,
                assistantStream: true,
                ...(task.knownCursor !== undefined ? { knownCursor: task.knownCursor } : {}),
            }, abort.signal);
            if (disposed || servers.get(serverId) !== state || abort.signal.aborted)
                return;
            if (!res.ok) {
                if (res.reason === 'unsupported') {
                    state.unsupportedClient = target.client;
                }
                return;
            }
            if (res.mode === 'full') {
                const snapCursor = isRecord(res.snapshot) && typeof res.snapshot.cursor === 'number'
                    ? res.snapshot.cursor
                    : (candidate.observedSeq ?? 0);
                const admitted = cache.putSnapshot(serverId, sessionId, res.snapshot, 'prewarmed');
                if (!admitted) {
                    state.oversizedCursorBySession.set(sessionId, Math.max(snapCursor, candidate.observedSeq ?? 0));
                }
                else {
                    candidate.lastSyncedSeq = Math.max(snapCursor, candidate.observedSeq ?? -1);
                }
                candidate.dirty = false;
            }
            else if (res.mode === 'unchanged') {
                if (res.projections !== undefined) {
                    cache.updateProjections(serverId, sessionId, res.projections);
                }
                const cachedNow = cache.peekSnapshotMeta(serverId, sessionId);
                candidate.lastSyncedSeq = Math.max(candidate.observedSeq ?? -1, cachedNow?.cursor ?? -1);
                candidate.dirty = false;
            }
            else if (res.mode === 'delta') {
                const merged = cache.applyDelta(serverId, sessionId, {
                    baseCursor: res.baseCursor,
                    cursor: res.cursor,
                    records: res.records,
                    hasMore: res.hasMore,
                    projections: res.projections,
                    assistantStream: res.assistantStream,
                });
                if (merged === undefined) {
                    if (cache.peekSnapshotMeta(serverId, sessionId) === undefined) {
                        state.oversizedCursorBySession.set(sessionId, Math.max(res.cursor, candidate.observedSeq ?? 0));
                    }
                    else {
                        cache.markStale(serverId, sessionId);
                    }
                }
                else {
                    candidate.lastSyncedSeq = Math.max(res.cursor, candidate.observedSeq ?? -1);
                    candidate.dirty = false;
                }
            }
        }
        catch (error) {
            if (abort.signal.aborted || (error instanceof RelayError && error.code === 'aborted')) {
                // Preempted by foreground or cancellation: keep candidate eligible for next idle window.
                return;
            }
            if (error instanceof RelayError && (error.code === 'not-shared' || error.code === 'unshared')) {
                cache.deleteSessionFamily(serverId, sessionId);
                state.candidates.delete(sessionId);
                return;
            }
            if (error instanceof RelayError && error.code === 'too-many-snapshots') {
                retryAfterDelay = true;
                return;
            }
            state.failedSessions.add(sessionId);
            onError?.(serverId, sessionId, error);
        }
        finally {
            if (state.inFlight === flight)
                state.inFlight = undefined;
            if (!disposed && servers.get(serverId) === state && !state.paused && !isForegroundBusy(serverId)) {
                if (retryAfterDelay) {
                    armIdleResume(serverId, state);
                }
                else {
                    scheduleServer(serverId);
                }
            }
        }
    }
    function armIdleResume(serverId, state) {
        clearTimer(state.idleResumeTimer);
        state.idleResumeTimer = undefined;
        const target = findOnlineTarget(serverId);
        if (target === undefined || !supportsSnapshotEndpoint(target.client) || state.unsupportedClient === target.client) {
            return;
        }
        if (pickNextTask(serverId, state) === undefined && (state.hasReceivedList || state.proactiveListSent)) {
            return;
        }
        const timer = clock.setTimeout(() => {
            state.idleResumeTimer = undefined;
            if (disposed || servers.get(serverId) !== state)
                return;
            if (state.paused || isForegroundBusy(serverId))
                return;
            scheduleServer(serverId);
        }, idleDelayMs);
        unrefTimer(timer);
        state.idleResumeTimer = timer;
    }
    function reconcileWorkspaceUnion(serverId, state) {
        const nextUnion = new Set();
        for (const ids of state.workspaceSessions.values()) {
            for (const id of ids)
                nextUnion.add(id);
        }
        for (const oldId of state.knownWorkspaceUnion) {
            if (!nextUnion.has(oldId)) {
                cache.deleteSessionFamily(serverId, oldId);
                state.candidates.delete(oldId);
                state.oversizedCursorBySession.delete(oldId);
                state.failedSessions.delete(oldId);
                if (state.inFlight?.sessionId === oldId) {
                    state.inFlight.abort.abort();
                }
            }
        }
        for (const id of nextUnion) {
            if (!state.candidates.has(id)) {
                state.candidates.set(id, {
                    sessionId: id,
                    updatedAtMs: 0,
                    running: false,
                    dirty: false,
                    hasListMeta: false,
                });
            }
        }
        state.knownWorkspaceUnion = nextUnion;
        scheduleServer(serverId);
    }
    function noteSessionList(serverId, rawListResult) {
        if (disposed || typeof serverId !== 'string' || serverId === '')
            return;
        const target = findOnlineTarget(serverId);
        if (target !== undefined && !supportsSnapshotEndpoint(target.client))
            return;
        const state = getOrCreateState(serverId);
        state.hasReceivedList = true;
        clearTimer(state.proactiveListTimer);
        state.proactiveListTimer = undefined;
        const items = isRecord(rawListResult) && Array.isArray(rawListResult.items) ? rawListResult.items : [];
        for (const item of items) {
            if (!isRecord(item) || typeof item.sessionId !== 'string' || item.sessionId === '')
                continue;
            if (item.origin === 'subagent')
                continue;
            if (typeof item.parentSession === 'string' && item.parentSession !== '')
                continue;
            const updatedAtMs = parseUpdatedAtMs(item.updatedAt ?? item.lastActivityAt ?? item.createdAt);
            const running = item.running === true;
            const existing = state.candidates.get(item.sessionId);
            if (existing !== undefined) {
                existing.updatedAtMs = Math.max(existing.updatedAtMs, updatedAtMs);
                existing.running = running;
                existing.hasListMeta = true;
            }
            else {
                state.candidates.set(item.sessionId, {
                    sessionId: item.sessionId,
                    updatedAtMs,
                    running,
                    dirty: false,
                    hasListMeta: true,
                });
            }
        }
        scheduleServer(serverId);
    }
    function noteWorkspaceSessions(serverId, workspaceId, rawSessionIds) {
        if (disposed || serverId === '' || workspaceId === '')
            return;
        const state = getOrCreateState(serverId);
        const set = new Set();
        for (const id of rawSessionIds) {
            if (typeof id === 'string' && id !== '')
                set.add(id);
        }
        state.workspaceSessions.set(workspaceId, set);
        reconcileWorkspaceUnion(serverId, state);
    }
    function noteWorkspaceRemoved(serverId, workspaceId) {
        if (disposed || serverId === '' || workspaceId === '')
            return;
        const state = servers.get(serverId);
        if (state === undefined)
            return;
        if (state.workspaceSessions.delete(workspaceId)) {
            reconcileWorkspaceUnion(serverId, state);
        }
    }
    function noteWorkspaceFrame(serverId, frame) {
        if (disposed || !isRecord(frame) || typeof serverId !== 'string' || serverId === '')
            return;
        if (frame.type === 'baseline' && isRecord(frame.value) && Array.isArray(frame.value.items)) {
            const state = getOrCreateState(serverId);
            state.workspaceSessions.clear();
            for (const ws of frame.value.items) {
                if (!isRecord(ws) || typeof ws.workspaceId !== 'string' || ws.workspaceId === '')
                    continue;
                const ids = Array.isArray(ws.sessionIds) ? ws.sessionIds.filter((id) => typeof id === 'string' && id !== '') : [];
                state.workspaceSessions.set(ws.workspaceId, new Set(ids));
            }
            reconcileWorkspaceUnion(serverId, state);
            return;
        }
        if (frame.type === 'upsert' && isRecord(frame.workspace) && typeof frame.workspace.workspaceId === 'string') {
            const ids = Array.isArray(frame.workspace.sessionIds)
                ? frame.workspace.sessionIds.filter((id) => typeof id === 'string' && id !== '')
                : [];
            noteWorkspaceSessions(serverId, frame.workspace.workspaceId, ids);
            return;
        }
        if (frame.type === 'remove' && typeof frame.workspaceId === 'string') {
            noteWorkspaceRemoved(serverId, frame.workspaceId);
        }
    }
    function noteControlWatermark(serverId, sessionId, seq) {
        if (!Number.isSafeInteger(seq))
            return;
        const state = getOrCreateState(serverId);
        let candidate = state.candidates.get(sessionId);
        if (candidate === undefined) {
            candidate = {
                sessionId,
                updatedAtMs: 0,
                running: false,
                observedSeq: seq,
                dirty: false,
                hasListMeta: false,
            };
            state.candidates.set(sessionId, candidate);
        }
        else if (candidate.observedSeq === undefined || seq > candidate.observedSeq) {
            candidate.observedSeq = seq;
        }
        state.failedSessions.delete(sessionId);
        if (isSessionActivelyFollowed?.(serverId, sessionId))
            return;
        const cached = cache.peekSnapshotMeta(serverId, sessionId);
        if (cached !== undefined && seq > cached.cursor) {
            candidate.dirty = true;
            if (!candidate.running)
                scheduleServer(serverId);
        }
    }
    function noteControlFrame(serverId, frame) {
        if (disposed || !isRecord(frame) || typeof serverId !== 'string' || serverId === '')
            return;
        if (frame.type === 'baseline' && isRecord(frame.value) && isRecord(frame.value.projections)) {
            for (const [sessionId, proj] of Object.entries(frame.value.projections)) {
                if (sessionId !== '' && isRecord(proj) && typeof proj.asOfSeq === 'number') {
                    noteControlWatermark(serverId, sessionId, proj.asOfSeq);
                }
            }
            return;
        }
        if (frame.type === 'projection' && typeof frame.sessionId === 'string' && typeof frame.seq === 'number') {
            noteControlWatermark(serverId, frame.sessionId, frame.seq);
        }
    }
    function noteSessionStatus(serverId, sessionId, running) {
        if (disposed || serverId === '' || sessionId === '')
            return;
        const state = getOrCreateState(serverId);
        let candidate = state.candidates.get(sessionId);
        const wasRunning = candidate?.running === true;
        if (candidate === undefined) {
            candidate = {
                sessionId,
                updatedAtMs: 0,
                running,
                dirty: false,
                hasListMeta: false,
            };
            state.candidates.set(sessionId, candidate);
        }
        else {
            candidate.running = running;
        }
        if (wasRunning && !running && !isSessionActivelyFollowed?.(serverId, sessionId)) {
            if (cache.peekSnapshotMeta(serverId, sessionId) !== undefined) {
                candidate.dirty = true;
                scheduleServer(serverId);
            }
        }
    }
    function notifyForegroundBusy(serverId, busy) {
        if (disposed || serverId === '')
            return;
        const state = getOrCreateState(serverId);
        if (busy) {
            clearTimer(state.proactiveListTimer);
            state.proactiveListTimer = undefined;
            clearTimer(state.idleResumeTimer);
            state.idleResumeTimer = undefined;
            if (state.inFlight !== undefined) {
                state.inFlight.abort.abort();
            }
        }
        else if (!state.paused) {
            armIdleResume(serverId, state);
        }
    }
    function onServerOffline(serverId) {
        const state = servers.get(serverId);
        if (state === undefined)
            return;
        state.paused = true;
        clearServerTimers(state);
        state.inFlight?.abort.abort();
    }
    function onServerOnline(serverId) {
        if (disposed || serverId === '')
            return;
        const state = getOrCreateState(serverId);
        state.paused = false;
        state.unsupportedClient = undefined;
        state.failedSessions.clear();
        scheduleServer(serverId);
    }
    function onServerRemoved(serverId) {
        const state = servers.get(serverId);
        if (state === undefined)
            return;
        clearServerTimers(state);
        state.inFlight?.abort.abort();
        servers.delete(serverId);
    }
    function syncTargets() {
        if (disposed)
            return;
        for (const target of getOnlineTargets()) {
            if (target.client.state === 'online' && supportsSnapshotEndpoint(target.client)) {
                const state = getOrCreateState(target.serverId);
                state.paused = false;
                scheduleServer(target.serverId);
            }
        }
    }
    function dispose() {
        disposed = true;
        for (const state of servers.values()) {
            clearServerTimers(state);
            state.inFlight?.abort.abort();
        }
        servers.clear();
    }
    return {
        noteSessionList,
        noteWorkspaceSessions,
        noteWorkspaceRemoved,
        noteWorkspaceFrame,
        noteControlFrame,
        noteSessionStatus,
        notifyForegroundBusy,
        onServerOffline,
        onServerOnline,
        onServerRemoved,
        syncTargets,
        dispose,
    };
}
//# sourceMappingURL=session-prewarm.js.map