import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client';
/** The two levels of the phone page stack. */
export type MobileView = 'home' | 'session';
/**
 * Session-list workspace filter: a pinned workspace, the explicit "all"
 * choice, or `null` — the untouched default that follows the current
 * session's workspace (resolved in the component, so a workspace that only
 * appears after the first baseline still lands).
 */
export type WorkspaceFilter = WorkspaceId | 'all' | null;
/**
 * `window` event a `conversation.session.header.*` slot (session scope)
 * fires to move the ROOT-scope nav store back to `home` — see
 * {@link GO_HOME_EVENT} below for why a store handle cannot cross this
 * particular scope boundary directly.
 */
export declare const GO_HOME_EVENT = "dsh-mobile-nav:go-home";
/**
 * `window` event the header's ⓘ button (`conversation.session.header.utilities`,
 * session scope) fires to open the session-info sheet (S4, MobileSessionInfo.tsx)
 * — a second, sibling entry on the SAME slot. Not a store handle for the same
 * reason {@link GO_HOME_EVENT} isn't: two independent registrations sharing
 * one scope could hold a common handle instead, but keeping the info sheet's
 * open/closed state fully local (a plain `useState`) is simpler than adding a
 * second store, and the event is one line either way.
 */
export declare const SESSION_INFO_EVENT = "dsh-mobile-nav:session-info";
/**
 * Phone page-stack store (phone breakpoint only; the tablet/desktop layouts
 * never read it). Deliberately NOT persisted: the spec's launch rule is
 * "always land on the session list", so a reload must reset to `home`.
 *
 * Built by a factory instead of a module-level constant: a module-scope
 * handle is a disguised singleton across plugin reloads (ui-slots docs).
 *
 * One handle IS shared by every registration of one apply() — but only
 * within the SAME slot scope. This handle mounts at `shell.overlay`, a
 * ROOT-scope slot (MobileHome.tsx); declaring the identical handle on a
 * SESSION-scope slot (e.g. `conversation.session.header.actions`) throws at
 * runtime ("store handle mounted under ... is already mounted under scope
 * ...", confirmed 2026-08-17) — the framework creates one live instance per
 * (handle, scope), and root/session are different scopes even for the same
 * handle. A session-scope registration that needs to move the page stack
 * (the S2 header back button) cannot hold `actions.show` directly; it
 * dispatches {@link GO_HOME_EVENT} instead, and MobileHome — already
 * mounted with this store — is the one that calls `actions.show('home')`.
 * @returns a fresh store handle, shared by every SAME-SCOPE registration of
 * one apply().
 */
export declare function createNavStore(): import("@deepseek-ai/dsh-client-runtime/client").EngineStoreHandle<{
    view: MobileView;
    workspace: WorkspaceFilter;
}, {
    /**
     * Move the page stack.
     * @param draft - store draft.
     * @param view - target level.
     */
    show: (draft: {
        view: MobileView;
        workspace: WorkspaceFilter;
    }, view: MobileView) => void;
    /**
     * Pin the session-list workspace filter.
     * @param draft - store draft.
     * @param workspace - workspace id, or 'all'.
     */
    filter: (draft: {
        view: MobileView;
        workspace: WorkspaceFilter;
    }, workspace: WorkspaceFilter) => void;
}>;
//# sourceMappingURL=nav-store.d.ts.map