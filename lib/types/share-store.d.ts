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
/** One row of the table, as `list()` reports it. */
export interface ShareEntry {
    sessionId: string;
    /** When remote was first enabled (repeat `share` does not move it). */
    sharedAt: number;
    /** Last activity the caller announced via `touch()` (or busy-end). */
    lastActivityAt: number;
    /** Memory-only: never persisted, always false after a restart. */
    busy: boolean;
}
/** Why a session left the table. `manual` = server-side close, `client` =
 * desktop-client close, `idle` = automatic idle shutdown. */
export type UnshareReason = 'manual' | 'client' | 'idle';
export type ShareEvent = {
    type: 'shared';
    sessionId: string;
} | {
    type: 'unshared';
    sessionId: string;
    reason: UnshareReason;
};
export interface ShareStoreOptions {
    /** Absolute path of the persistence file. */
    file: string;
    /** Idle budget in hours; must be 0 < x ≤ 8760, anything else falls back
     * to 48. Changeable later via `setIdleHours`. */
    idleHours: number;
    /** Injectable clock; defaults to Date.now. */
    now?: () => number;
}
export interface ShareStore {
    /** Enable remote for a session. True when newly shared; false when it was
     * already shared (sharedAt stays put, lastActivityAt refreshes to now). */
    share(sessionId: string): boolean;
    /** Remove a session from the table. True when it was actually removed. */
    unshare(sessionId: string, reason: UnshareReason): boolean;
    /** Whether the session itself is in the table (inheritance NOT applied). */
    isShared(sessionId: string): boolean;
    /** Whether the session is reachable for remote access: itself shared, or
     * some ancestor within 16 `parentOf` hops shared. */
    isAccessible(sessionId: string, parentOf: (id: string) => string | undefined): boolean;
    /** Announce activity. No-op for sessions not in the table. */
    touch(sessionId: string): void;
    /** Announce running/waiting state. No-op for sessions not in the table.
     * busy true→false restarts the idle clock from now. */
    setBusy(sessionId: string, busy: boolean): void;
    /** Close every expired session now. Returns the closed ids, sorted. */
    sweep(): string[];
    /** undefined when not shared; Infinity while busy; otherwise how many ms
     * are left before this session would idle out (never negative). */
    remainingMs(sessionId: string): number | undefined;
    /** Snapshot of the table, sharedAt ascending (ties broken by id). */
    list(): ShareEntry[];
    /** Replace the idle budget. Invalid values are ignored; takes effect
     * immediately for subsequent sweep/remainingMs calls. */
    setIdleHours(hours: number): void;
    /** Observe share/unshare events. Listener errors are swallowed. Returns
     * an unsubscribe function. */
    subscribe(listener: (event: ShareEvent) => void): () => void;
}
export declare function createShareStore(options: ShareStoreOptions): ShareStore;
//# sourceMappingURL=share-store.d.ts.map