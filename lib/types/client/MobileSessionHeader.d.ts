import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { NS } from './locales.ts';
/** Full props for the session header's back button + view-switch row. */
export type MobileHeaderActionsProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS>;
/** One tab read off the official (now visually hidden) Chat/Trajectory tablist. */
export interface ViewTabInfo {
    label: string;
    active: boolean;
    el: HTMLButtonElement;
}
/**
 * Reads the official session-header tablist by role/aria only (no hashed
 * classes) — the plan's one sanctioned official-DOM read: ChatStore's view
 * selection has no public setter (design doc Appendix C), so switching
 * views means clicking the official tab button ourselves.
 *
 * Exported: effects/gestures.ts (S6) reuses this exact read for the
 * content-area swipe gesture instead of re-querying the tablist a second
 * way — it runs outside React (a document-level touch listener), so it
 * needs the plain function, not the {@link useViewTabs} hook below.
 */
export declare function readViewTabs(): ViewTabInfo[];
/**
 * Live view-tab mirror. The tablist mounts/unmounts with the session header
 * and its `aria-selected` flips on every view switch (ours or the suite's
 * own), so a MutationObserver — not a one-time read — keeps the mirror
 * current. Scoped to `document.body` like the existing aionui-compat
 * effects (styles/aionui-compat.ts): the tablist itself may not exist yet
 * at mount time.
 *
 * Exported: MobileSessionInfo.tsx (S4) reuses this exact hook for the info
 * sheet's Chat/Trajectory segmented control instead of re-reading the
 * tablist a second way.
 */
export declare function useViewTabs(): ViewTabInfo[];
/**
 * Session header, left lane: the back button (returns the phone page stack
 * to the session list) plus the "current view + dots" row that mirrors the
 * hidden official tablist. Both render unconditionally; CSS
 * (styles/header.css.ts) keeps them hidden at >= 768px so the tablet drawer
 * and the desktop layout stay exactly as they were.
 */
export declare function MobileHeaderActions({ sessionId, useSessions, t }: MobileHeaderActionsProps): import("react").JSX.Element;
/** Full props for the session header's right-edge utility buttons. */
export type MobileHeaderUtilitiesProps = PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<typeof NS>;
/**
 * Session header, right lane: the session-info entry (S4 owns the actual
 * sheet — this fires a hook event for it to pick up) and the workbench
 * entry, which triggers dsh-better-sidebar's own toggle. There is no public
 * API for "open the panel" (BetterSidebarService.openTab only auto-expands
 * for a content open, not a bare type-only open), so this clicks the
 * plugin's real toggle button through a stable, non-hashed anchor: its root
 * mount marker `[data-dsh-better-sidebar]` plus the `_toggleButton` class
 * suffix (verified live: 2026-08-17). Safe no-op when the plugin, or any
 * other workbench-style plugin sharing that convention, is not installed.
 */
export declare function MobileHeaderUtilities({ t }: MobileHeaderUtilitiesProps): import("react").JSX.Element;
//# sourceMappingURL=MobileSessionHeader.d.ts.map