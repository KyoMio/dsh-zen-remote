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
import type { RelayClient } from './relay-client.js';
import type { CacheClock, SessionHistoryCache } from './session-history-cache.js';
export declare const DEFAULT_PREWARM_TOP_N = 16;
export declare const DEFAULT_PREWARM_IDLE_DELAY_MS = 300;
export declare const DEFAULT_PROACTIVE_LIST_DELAY_MS = 1000;
export interface SessionPrewarmOptions {
    topN?: number;
    idleDelayMs?: number;
    proactiveListDelayMs?: number;
    clock?: CacheClock;
}
export interface PrewarmTarget {
    serverId: string;
    client: RelayClient;
}
export interface SessionPrewarmSchedulerDeps {
    cache: SessionHistoryCache;
    getOnlineTargets: () => readonly PrewarmTarget[];
    isForegroundBusy: (serverId: string) => boolean;
    isSessionActivelyFollowed?: (serverId: string, sessionId: string) => boolean;
    topN?: number;
    idleDelayMs?: number;
    proactiveListDelayMs?: number;
    clock?: CacheClock;
    onError?: (serverId: string, sessionId: string, error: unknown) => void;
}
export interface SessionPrewarmScheduler {
    noteSessionList(serverId: string, rawListResult: unknown): void;
    noteWorkspaceSessions(serverId: string, workspaceId: string, rawSessionIds: readonly string[]): void;
    noteWorkspaceRemoved(serverId: string, workspaceId: string): void;
    noteWorkspaceFrame(serverId: string, frame: unknown): void;
    noteControlFrame(serverId: string, frame: unknown): void;
    noteSessionStatus(serverId: string, sessionId: string, running: boolean): void;
    notifyForegroundBusy(serverId: string, busy: boolean): void;
    onServerOffline(serverId: string): void;
    onServerOnline(serverId: string): void;
    onServerRemoved(serverId: string): void;
    syncTargets(): void;
    dispose(): void;
}
export declare function createSessionPrewarmScheduler(deps: SessionPrewarmSchedulerDeps): SessionPrewarmScheduler;
//# sourceMappingURL=session-prewarm.d.ts.map