/**
 * The right-hand panels a phone session page may need to open or close, and
 * the one place their anchors live (MobileSessionHeader.tsx's header button,
 * gestures.ts's edge swipe-back and workbench-ref-close.ts all used to spell
 * these selectors out separately — test/workbench-ref-close.test.cjs pinned
 * them to each other for exactly that reason).
 *
 * Two backends, mutually exclusive in practice:
 *
 * - **official** — DSH 0.1.5+'s own right sidebar (dsh-client-ui-sidebar-
 *   right). Its panel is always mounted (`data-sidebar-right-panel`, with
 *   `data-sidebar-right-open` while shown), its ExpandButton lives in the
 *   session header corner and UNMOUNTS once open, its collapse control rides
 *   the panel's own strip — so the PANEL is the probe and open/close click
 *   different controls. On a phone the host itself takes this panel full
 *   screen (`data-rightbar-fullscreen` on the frame), and from
 *   dsh-better-sidebar 0.19 on it is where EVERY better-sidebar tab lives
 *   (explorer / git / terminal / browser / third-party `registerTab()`
 *   tabs): 0.19 retired the plugin's own right column and keeps only a
 *   bottom workbench, which the phone never opens (redundant with the full-
 *   screen native panel — issue #11, verified live 2026-09-21 on 0.1.5-rc.2
 *   + better-sidebar 0.19.1).
 * - **legacy better-sidebar** — dsh-better-sidebar ≤ 0.18 drawing its own
 *   right panel under its root mount marker; only reachable on a host
 *   WITHOUT the official panel (DSH < 0.1.5). Anchors are the root marker
 *   plus class suffixes (verified live on 0.15.0, 2026-08-17): the panel's
 *   class ends in "_panel" only while open ("_panelHidden" is appended once
 *   closed), and one toggle button both opens and closes it. On 0.19+ the
 *   same selectors match nothing (the toggle moved into the header
 *   utilities slot as `[data-dsh-bottom-toggle]`, the panel became
 *   `_bottomPanel`) — by design, since that surface is not for the phone.
 */
export declare const OFFICIAL_PANEL = "[data-sidebar-right-panel]";
export declare const OFFICIAL_PANEL_OPEN = "[data-sidebar-right-panel][data-sidebar-right-open]";
export declare const OFFICIAL_EXPAND = "[data-sidebar-right-expand]";
export declare const OFFICIAL_COLLAPSE = "[data-sidebar-right-toggle]";
export declare const BETTER_ROOT = "[data-dsh-better-sidebar]";
export declare const BETTER_TOGGLE = "[data-dsh-better-sidebar] button[class$=\"_toggleButton\"]";
export declare const BETTER_PANEL_OPEN = "[data-dsh-better-sidebar] [class$=\"_panel\"]";
export type SidebarTarget = 'official' | 'better' | null;
/**
 * Which backend this host offers, official first: with 0.1.5's panel on the
 * page the better-sidebar branch is never taken, whatever better-sidebar
 * version is installed (0.19+ has no right panel of its own to open; older
 * ones would draw a second right column over the host's, which is not a
 * phone layout this plugin supports).
 */
export declare function readSidebarTarget(): SidebarTarget;
export declare function officialSidebarOpen(): boolean;
export declare function betterSidebarOpen(): boolean;
/**
 * Toggle whichever panel `target` names by clicking its own control through
 * the stable marker. Synthetic `.click()` fires the React handlers through
 * `display: none` (the tablist precedent this plugin already relies on).
 */
export declare function toggleSidebarTarget(target: SidebarTarget): void;
/**
 * Close whichever right-hand panel is open right now; `false` when none is.
 * Reads the open state at call time (the better-sidebar toggle is a toggle —
 * clicking it blind against a closed panel would REOPEN it).
 */
export declare function closeOpenSidebar(): boolean;
//# sourceMappingURL=sidebar-panels.d.ts.map