/**
 * Session-sharing data for the browser half (T33b + T33b-fix): the
 * shared-session table behind the three entry points (session "…" menu
 * item, title-row remote icon, settings-page shared list).
 * Browser-import-free so scripts/check-shares.mjs drives it directly with a
 * fake fetch:
 *
 * - `parseSharesBody(body, now)` maps the `GET /_dsh/zen-remote/admin/shares`
 *   body (T33a: `{ ok, shares:[{ sessionId, sharedAt, lastActivityAt, busy,
 *   remainingMs(null=忙碌), viewers, title }] }`) into tolerant view entries,
 *   each stamped with the parse time so `describeShare` can let the idle
 *   countdown tick between polls;
 * - `describeShare(entry, now, t?)` maps one entry (or the absence of one)
 *   to the icon's three states — off / on / watched (a desktop client is
 *   viewing) — plus the hover line (idle time left, or the busy copy);
 * - `shareFailText(outcome, action, t)` maps a refused share/unshare to the
 *   one-line `window.alert` copy, keyed by the server's error code;
 * - `createSharesStore(fetchImpl, visibility?, pollMs?)` is the subscription
 *   store every part shares. The ROLE gates everything (T33b-fix): until
 *   the registration wires a role nothing polls and nothing renders; only
 *   a host polls. A failed GET — 404 during a plugin reload, a dropped
 *   connection, anything — fails exactly its own round: the last table
 *   stays on screen and the next tick asks again; no latch, no permanent
 *   shutdown. The poll cadence is visibility-shaped: the timer only runs
 *   while the page is visible, becoming visible pulls once immediately;
 * - `getSharesStore()` is the page-wide singleton the registered components
 *   read, so exactly one poll loop exists no matter how many parts mount.
 */
/** Same-origin admin shares route (host half: T33a, src/admin-routes.ts). */
export declare const ADMIN_SHARES_ROUTE = "/_dsh/zen-remote/admin/shares";
/** One shared session as the parts render it. `asOf` is the parse time that
 * anchors the local countdown decay (the wire has no such field). */
export interface ShareEntryView {
    sessionId: string;
    sharedAt: number;
    lastActivityAt: number;
    busy: boolean;
    /** Idle time left at `asOf`; null = busy (not counting down). */
    remainingMs: number | null;
    viewers: number;
    title: string | null;
    /** When this row was parsed off a GET body (Date.now() of the refresh). */
    asOf: number;
}
/** Everything the parts read off the store, one frozen object per change. */
export interface SharesSnapshot {
    /**
     * The deployment role, wired by the registration from the SAME decision
     * the settings page makes (row document first, client-config probe as the
     * fallback — settings-form.ts's settingsRoleOf). `'unknown'` until that
     * wiring answers: nothing polls, the parts render nothing. `'client'`
     * hides the parts and stops the polling; switching back to host resumes.
     */
    role: 'unknown' | 'host' | 'client';
    /** One GET has answered ok — parts render nothing before this. */
    ready: boolean;
    entries: readonly ShareEntryView[];
}
/** The locale keys `describeShare` needs, as its formatter accepts them. */
export type ShareTextKey = 'shareRemoteStateOff' | 'shareRemoteBusy' | 'shareRemoteRemainingHours' | 'shareRemoteRemainingMinutes';
/** Minimal shape of the framework `t` seat over the plugin's namespace. */
export type ShareTextFormatter = (key: ShareTextKey, params?: Record<string, number>) => string;
/** Default formatter: the plugin's Chinese dictionary (the key-set source of
 * truth). Components pass their real framework `t`, so the default only
 * serves the pure-function callers (check script, non-React reads). */
export declare function createZhShareFormatter(): ShareTextFormatter;
/** The icon's three states and the hover line (T33b spec). */
export interface ShareDescription {
    state: 'off' | 'on' | 'watched';
    remainingText: string;
}
/**
 * Map one entry — or the absence of one — to the remote icon's state and its
 * hover text. The idle countdown decays locally from the entry's `asOf` stamp
 * (a ≤30 s-poll skew beats a frozen number), floors at zero, reads as hours
 * once above the hour and minutes below it, and swaps to the busy copy when
 * the session is not counting down at all. A session with a desktop client
 * watching reads `watched` regardless of the countdown — the countdown stays
 * in the hover text.
 */
export declare function describeShare(entry: ShareEntryView | undefined | null, now: number, t?: ShareTextFormatter): ShareDescription;
/** Parse one GET body tolerantly: a garbage shape is an empty table, a
 * garbage row is dropped — never a throw into the polling loop. */
export declare function parseSharesBody(body: unknown, now: number): ShareEntryView[];
/** How one share/unshare/unshare-all POST ended. A refused action carries
 * the server's error `code` when it sent one (`subagent-session`,
 * `no-session`, …) for the alert copy to key on. */
export type ShareActionOutcome = {
    ok: true;
} | {
    ok: false;
    code?: string;
    message?: string;
};
/** The action verbs the POST route takes (mirror of the server's set). */
export type ShareAction = 'share' | 'unshare' | 'unshare-all';
/** The locale keys `shareFailText` needs. */
export type ShareFailTextKey = 'shareRemoteFailSubagent' | 'shareRemoteFailEmpty' | 'shareRemoteFailGeneric';
export type ShareFailTextFormatter = (key: ShareFailTextKey) => string;
/**
 * The one-line `window.alert` copy for a refused action (T33b-fix): the
 * share-specific server codes map to their reasons, everything else —
 * including every unshare failure — reads as the generic retry line.
 */
export declare function shareFailText(outcome: {
    ok: boolean;
    code?: string;
}, action: ShareAction, t: ShareFailTextFormatter): string;
/** Whether the page is currently visible, plus change notifications — the
 * seam that keeps the poll cadence visibility-shaped while staying
 * testable (the check script injects a controllable source). */
export interface VisibilitySource {
    visible(): boolean;
    subscribe(listener: () => void): () => void;
}
/** The real source: `visibilitychange` off `document` (Node: always visible,
 * never notifying). */
export declare const documentVisibility: VisibilitySource;
/** The store face the three T33b parts share. */
export interface SharesStore {
    /** The current snapshot — a stable frozen reference until the next change. */
    getSnapshot(): SharesSnapshot;
    /** Observe snapshot replacements; polling runs while at least one
     * listener is attached AND the wired role is host AND the page is
     * visible. */
    subscribe(listener: () => void): () => void;
    /** Wire the deployment role (settings-form.ts's settingsRoleOf verdict,
     * re-applied on every configForms snapshot update). Flipping back to host
     * resumes polling with an immediate pull; flipping to client stops it. */
    setRole(role: 'host' | 'client'): void;
    /** GET now (latest-wins). @returns whether an ok body landed. */
    refresh(): Promise<boolean>;
    /** POST share, then refresh immediately. @returns the action's outcome. */
    share(sessionId: string): Promise<ShareActionOutcome>;
    /** POST unshare for one session, then refresh. @returns the outcome. */
    unshare(sessionId: string): Promise<ShareActionOutcome>;
    /** POST unshare-all, then refresh. @returns the outcome. */
    unshareAll(): Promise<ShareActionOutcome>;
}
/** Poll cadence while the page is visible, the role is host, and at least
 * one part is mounted. */
export declare const SHARES_POLL_MS = 30000;
/**
 * Build one store over an injectable fetch and visibility source. The GET is
 * latest-wins (T16's gate): an earlier request answering late never
 * overwrites a newer table. Every GET failure fails its own round only —
 * the last ready table stays up and the next tick retries (a plugin reload
 * serving a few 404s must not blind the page until reload). The timer is
 * real while visible and gone while hidden; becoming visible pulls once
 * immediately. `pollMs` exists for the check script: the shipped cadence is
 * far too slow for a test to observe, so tests run a few cycles at 5 ms.
 */
export declare function createSharesStore(fetchImpl: typeof fetch, visibility?: VisibilitySource, pollMs?: number): SharesStore;
/** The page-wide store every registered part reads — one poll loop no
 * matter how many of the menu items, the header icon and the settings
 * list are mounted at once. Created lazily over the real fetch, so the
 * check script never constructs it. */
export declare function getSharesStore(): SharesStore;
//# sourceMappingURL=shares.d.ts.map