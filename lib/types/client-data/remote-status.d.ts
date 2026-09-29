/**
 * Remote-session status data for the browser half (T34): the poll store
 * behind the two sub-client parts — the title-row connection icon and the
 * composer's readonly banner. Built as a mirror of shares.ts (T33b):
 * browser-import-free so the desktop-gate test and check scripts drive it
 * with a fake fetch.
 *
 * - `parseRemoteStatusBody(body, now)` maps the
 *   `GET /_dsh/zen-remote/client/remote-status` body
 *   (`{ state, versionMismatch, serverName, closed }`) into a tolerant view;
 * - `describeRemoteStatus(view)` maps one view to the icon's three states —
 *   online (lit) / offline (grey; `revoked` / `unpaired` count as offline —
 *   the link is not serving either way) / mismatch (yellow, only ever while
 *   online) — plus the hover line;
 * - `bannerText(view, sessionId)` picks the composer banner copy for one
 *   session: the closed reason (idle / manual / client) outranks the offline
 *   line — a closed session stays closed even while the server is down;
 * - `createRemoteStatusStore(fetchImpl, visibility?, pollMs?)` is the
 *   subscription store both parts share. There is NO role gate here (unlike
 *   shares.ts): both roles register the parts, and the parts subscribe only
 *   while a VIRTUAL-id session is on screen — a host page (local sessions
 *   only) never opens a subscription, so nothing polls. A failed GET fails
 *   exactly its own round; the poll cadence is visibility-shaped like the
 *   shares store's;
 * - `getRemoteStatusStore()` is the page-wide singleton.
 */
/** Same-origin client route feeding this store (host half: T34,
 * src/client-routes.ts). */
export declare const REMOTE_STATUS_ROUTE = "/_dsh/zen-remote/client/remote-status";
/** Same-origin client route closing one remote session from this machine. */
export declare const CLIENT_UNSHARE_ROUTE = "/_dsh/zen-remote/client/unshare";
/** The relay's serving state, as the route words it. */
export type RemoteStatusState = 'online' | 'offline' | 'revoked' | 'unpaired';
/** Why the server closed a session's remote access. */
export type RemoteClosedReason = 'manual' | 'client' | 'idle';
/** One parsed status body, stamped with the parse time for future decay. */
export interface RemoteStatusView {
    state: RemoteStatusState;
    versionMismatch: boolean;
    serverName: string;
    closed: Readonly<Record<string, RemoteClosedReason>>;
    /** When this view was parsed off a GET body. */
    asOf: number;
}
/** Everything the parts read off the store, one frozen object per change. */
export interface RemoteStatusSnapshot {
    /** One GET has answered ok — parts render nothing before this. */
    ready: boolean;
    view: RemoteStatusView | undefined;
}
/** Parse one GET body tolerantly: a garbage shape is "not online yet", a
 * garbage field degrades to its default — never a throw into the polling
 * loop. */
export declare function parseRemoteStatusBody(body: unknown, now: number): RemoteStatusView;
/** The locale keys `describeRemoteStatus` needs. */
export type RemoteStatusTextKey = 'remoteStatusOnline' | 'remoteStatusOffline' | 'remoteStatusMismatch' | 'remoteStatusRevoked' | 'remoteStatusUnpaired';
/** Minimal shape of the framework `t` seat over the plugin's namespace. */
export type RemoteStatusFormatter = (key: RemoteStatusTextKey) => string;
/** Default formatter: the plugin's Chinese dictionary. Components pass their
 * real framework `t`; this serves the pure-function callers (tests, check
 * scripts). */
export declare function createZhRemoteStatusFormatter(): RemoteStatusFormatter;
/** The icon's states and its hover line (T34, refined by T34-fix): online
 * (lit), offline (grey, reconnecting), mismatch (yellow, only ever while
 * online — an offline link outranks it), and `revoked` / `unpaired` as
 * states of their OWN (T34-fix) — the hover and the click say the precise
 * word, never "reconnecting", because neither recovers on its own. */
export interface RemoteStatusDescription {
    state: 'online' | 'offline' | 'mismatch' | 'revoked' | 'unpaired';
    hoverText: string;
}
export declare function describeRemoteStatus(view: RemoteStatusView | undefined | null, t?: RemoteStatusFormatter): RemoteStatusDescription;
/** The locale keys `bannerText` needs. */
export type RemoteBannerTextKey = 'remoteBannerOffline' | 'remoteBannerRevoked' | 'remoteBannerUnpaired' | 'remoteBannerClosedIdle' | 'remoteBannerClosedManual' | 'remoteBannerClosedClient';
export type RemoteBannerFormatter = (key: RemoteBannerTextKey) => string;
/**
 * The composer banner copy for one virtual session (T34): the session's
 * closed reason — if the server closed this session — outranks the
 * link-level lines (offline, T41a-fix2's revoked / unpaired); a merely
 * offline link reads the temporarily-readonly copy, and a revoked token or
 * an unpaired client reads the "not coming back on its own" copy — both
 * stand a banner AND disable the input (the component raises its composer
 * block from whatever this returns), since neither recovers without the
 * settings page. `undefined` when nothing applies (online and not closed):
 * no banner.
 */
export declare function bannerText(view: RemoteStatusView | undefined | null, sessionId: string, t?: RemoteBannerFormatter): string | undefined;
/** Whether the page is currently visible — the same seam shares.ts uses to
 * keep the poll cadence visibility-shaped (testable via injection). */
export interface VisibilitySource {
    visible(): boolean;
    subscribe(listener: () => void): () => void;
}
/** The real source: `visibilitychange` off `document` (Node: always visible,
 * never notifying). */
export declare const documentVisibility: VisibilitySource;
/** How one `client/unshare` POST ended. A refused action carries the
 * backend's error `code` when it sent one (`not-shared`, `remote-mismatch`,
 * …). */
export type RemoteUnshareOutcome = {
    ok: true;
} | {
    ok: false;
    code?: string;
    message?: string;
};
/** The store face the two T34 parts share. */
export interface RemoteStatusStore {
    /** The current snapshot — a stable frozen reference until the next change. */
    getSnapshot(): RemoteStatusSnapshot;
    /** Observe snapshot replacements; polling runs while at least one listener
     * is attached AND the page is visible. */
    subscribe(listener: () => void): () => void;
    /** GET now (latest-wins). @returns whether an ok body landed. */
    refresh(): Promise<boolean>;
    /** POST client/unshare for one VIRTUAL session id, then refresh.
     * @returns the action's outcome. */
    unshare(sessionId: string): Promise<RemoteUnshareOutcome>;
}
/** Poll cadence while the page is visible and at least one part is mounted
 * (T34: 15 秒). */
export declare const REMOTE_STATUS_POLL_MS = 15000;
/**
 * Build one store over an injectable fetch and visibility source — the
 * shares-store discipline: latest-wins (an earlier request answering late
 * never overwrites a newer table), every GET failure fails its own round,
 * the timer is real while visible and gone while hidden, and becoming
 * visible pulls once immediately. `pollMs` exists for tests: the shipped
 * cadence is far too slow to observe.
 */
export declare function createRemoteStatusStore(fetchImpl: typeof fetch, visibility?: VisibilitySource, pollMs?: number): RemoteStatusStore;
/** The page-wide store every registered part reads — one poll loop no
 * matter how many of the icon and banner parts are mounted at once. Created
 * lazily over the real fetch, so check scripts never construct it. */
export declare function getRemoteStatusStore(): RemoteStatusStore;
//# sourceMappingURL=remote-status.d.ts.map