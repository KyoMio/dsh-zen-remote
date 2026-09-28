/**
 * Session-sharing data for the browser half (T33b): the shared-session table
 * behind the three entry points (session "…" menu item, title-row remote
 * icon, settings-page shared list). Browser-import-free so
 * scripts/check-shares.mjs drives it directly with a fake fetch:
 *
 * - `parseSharesBody(body, now)` maps the `GET /_dsh/zen-remote/admin/shares`
 *   body (T33a: `{ ok, shares:[{ sessionId, sharedAt, lastActivityAt, busy,
 *   remainingMs(null=忙碌), viewers, title }] }`) into tolerant view entries,
 *   each stamped with the parse time so `describeShare` can let the idle
 *   countdown tick between polls;
 * - `describeShare(entry, now, t?)` maps one entry (or the absence of one)
 *   to the icon's three states — off / on / watched (a desktop client is
 *   viewing) — plus the hover line (idle time left, or the busy copy);
 * - `createSharesStore(fetchImpl)` is the subscription store every part
 *   shares: latest-wins GETs, visibility-aware polling (fetch once on
 *   becoming visible, then every 30 s; paused while hidden; started by the
 *   first subscriber, stopped by the last), and the three POST actions that
 *   refresh immediately after landing. A 404 latches `available: false` and
 *   stops the polling for good — the shares route exists only on the host
 *   role, so that latch is the client-role gate for the T33b parts;
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
    /** One GET has answered ok — parts render nothing before this. */
    ready: boolean;
    /** The shares route exists here (host role). A 404 latches this false. */
    available: boolean;
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
/** The store face the three T33b parts share. */
export interface SharesStore {
    /** The current snapshot — a stable frozen reference until the next change. */
    getSnapshot(): SharesSnapshot;
    /** Observe snapshot replacements; the FIRST subscriber starts the poll
     * loop, the LAST unsubscriber stops it. */
    subscribe(listener: () => void): () => void;
    /** GET now (latest-wins). @returns whether an ok body landed. */
    refresh(): Promise<boolean>;
    /** POST share, then refresh immediately. @returns whether the POST landed. */
    share(sessionId: string): Promise<boolean>;
    /** POST unshare for one session, then refresh. @returns POST outcome. */
    unshare(sessionId: string): Promise<boolean>;
    /** POST unshare-all, then refresh. @returns POST outcome. */
    unshareAll(): Promise<boolean>;
}
/** Poll cadence while the page is visible and at least one part is mounted. */
export declare const SHARES_POLL_MS = 30000;
/**
 * Build one store over an injectable fetch. The GET is latest-wins (T16's
 * gate): an earlier request answering late never overwrites a newer table.
 * A 404 — the shares route does not exist here, i.e. this deployment is not
 * the host — latches `available: false` and retires the poll loop; every
 * other failure keeps the last ready table on screen.
 */
export declare function createSharesStore(fetchImpl: typeof fetch): SharesStore;
/** The page-wide store every registered part reads — one poll loop no
 * matter how many of the menu items, the header icon and the settings
 * list are mounted at once. Created lazily over the real fetch, so the
 * check script never constructs it. */
export declare function getSharesStore(): SharesStore;
//# sourceMappingURL=shares.d.ts.map