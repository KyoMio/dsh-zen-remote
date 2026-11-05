import type { ClientContext } from '../compat/types.ts';
/** The DOM face the pure decisions below read — structural, so the tests
 * drive them with plain objects instead of a DOM. */
export interface PermissionSheetCandidate {
    matches(selectors: string): boolean;
    getAttribute(name: string): string | null;
    /** A truthy `closest` result means the click started inside the seat. */
    closest(selectors: string): unknown;
}
/**
 * Whether ONE body-level node is a portal menu that does not yet carry the
 * sheet marker. Pure over the node's own methods: `matches` answers the
 * body-level role=menu shape, `getAttribute` the marker.
 */
export declare function isUnmarkedPortalMenu(node: PermissionSheetCandidate): boolean;
/** Which bottom sheet a trigger click arms. */
export type SheetKind = 'perm' | 'workspace';
/**
 * Which sheet ONE click event's target arms: the phone shell only. The
 * permission seat's trigger arms `perm` (T70); the hero page's two
 * workspace triggers arm `workspace` (UX-3). Any other button — the
 * sidebar's 「…」, a copy button — arms nothing, so the menus they open are
 * never marked.
 */
export declare function sheetKindForTrigger(target: PermissionSheetCandidate | null | undefined, phoneMatches: boolean): SheetKind | null;
/**
 * UX-3: whether a pointerdown landed inside a WORKSPACE trigger — the only
 * triggers whose open/close suffers the outside-pointerdown + toggle-click
 * race (the Menu closes the portaled sheet on the outside pointerdown, and
 * the trigger's own click would flip it straight back open). The permission
 * trigger toggles by click alone and is never suppressed.
 */
export declare function pointerdownOnWorkspaceTrigger(target: PermissionSheetCandidate | null | undefined): boolean;
/**
 * UX-3: whether a click started on a workspace item inside the MARKED
 * workspace sheet — the pick that starts the switch lock. Keyed on the
 * `workspace` marker value, so a permission option can never lock the
 * composer.
 */
export declare function menuitemClickStartsWorkspaceSwitch(target: PermissionSheetCandidate | null | undefined): boolean;
/** What the release check reads, injected so the tests stay DOM-free. */
export interface WorkspaceSwitchProbe {
    /** The conversation root's current `data-conversation-session` value (null = none mounted). */
    currentSessionValue(): string | null;
    /** Whether the hero's "choose a workspace" placeholder card is mounted. */
    placeholderOpen(): boolean;
}
/**
 * Whether the workspace switch has settled: the conversation root now names
 * a DIFFERENT session than the one the lock was taken on, and the no-workspace
 * placeholder card is gone (the optimistic `pendingWorkspaceId` display alone
 * is not enough — the remount resets it).
 */
export declare function workspaceSwitchSettled(probe: WorkspaceSwitchProbe, lockedSessionValue: string | null): boolean;
/**
 * T70: turn the portaled permission menu into the bottom sheet composer.css
 * section 4 promises, on DSH 0.2.0. Up to 0.1.7 the permission menu rendered
 * inside the permission seat and the stylesheet's descendant selectors
 * reached it; 0.2.0 portals it to body (`portal: true` on the Menu), the
 * selectors stopped matching, and the phone got a tiny floating popup. The
 * host offers no stable attribute to key the portal off — the anchor is a
 * per-instance useId, there is no id and no aria-controls — so this effect
 * marks it: the trigger's click arms a short window, the observer stamps the
 * next body-level menu with `data-zen-sheet`, and the stylesheet (which
 * only the phone shell loads) turns THAT into the sheet. The portal menu
 * unmounts on close, so the marker's lifetime is exactly the menu's; the
 * 0.1.7 inline structure keeps working through the untouched descendant
 * selectors, and the desktop shell never loads this stylesheet at all.
 *
 * UX-3 extends the same machinery to the hero page's workspace menu:
 * - the two workspace triggers arm a `data-zen-sheet="workspace"` sheet;
 * - a pointerdown on a workspace trigger while a marked sheet is up
 *   suppresses the trigger's own click, so one tap reliably CLOSES (the
 *   host's outside-pointerdown close stands instead of being undone by the
 *   toggle click);
 * - a pick inside the workspace sheet locks the composer for the length of
 *   the `selectWorkspace` remount (see SWITCH_MARKER above).
 */
export declare function installPermissionSheet(ctx: ClientContext): void;
//# sourceMappingURL=permission-sheet.d.ts.map