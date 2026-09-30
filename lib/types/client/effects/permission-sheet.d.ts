import type { ClientContext } from '../compat/types.ts';
/** The DOM face the two pure decisions below read — structural, so the
 * tests drive them with plain objects instead of a DOM. */
export interface PermissionSheetCandidate {
    matches(selectors: string): boolean;
    getAttribute(name: string): string | null;
    /** A truthy `closest` result means the click started in the seat. */
    closest(selectors: string): unknown;
}
/**
 * Whether ONE body-level node is a portal menu that does not yet carry the
 * sheet marker. Pure over the node's own methods: `matches` answers the
 * body-level role=menu shape, `getAttribute` the marker.
 */
export declare function isUnmarkedPortalMenu(node: PermissionSheetCandidate): boolean;
/**
 * Whether one click event's target arms the marking window: the phone shell
 * only, and only a click that started inside the permission seat's trigger.
 * Any other button — the sidebar's 「…」, a copy button — never arms, so
 * the menus they open are never marked.
 */
export declare function clickArmsPermissionSheet(target: PermissionSheetCandidate | null | undefined, phoneMatches: boolean): boolean;
/**
 * T70: turn the portaled permission menu into the bottom sheet composer.css
 * section 4 promises, on DSH 0.2.0. Up to 0.1.7 the permission menu rendered
 * inside the permission seat and the stylesheet's descendant selectors
 * reached it; 0.2.0 portals it to body (`portal: true` on the Menu), the
 * selectors stopped matching, and the phone got a tiny floating popup. The
 * host offers no stable attribute to key the portal off — the anchor is a
 * per-instance useId, there is no id and no aria-controls — so this effect
 * marks it: the trigger's click arms a window, the observer stamps the next
 * body-level menu with `data-zen-sheet="perm"`, and the stylesheet (which
 * only the phone shell loads) turns THAT into the sheet. The portal menu
 * unmounts on close, so the marker's lifetime is exactly the menu's; the
 * 0.1.7 inline structure keeps working through the untouched descendant
 * selectors, and the desktop shell never loads this stylesheet at all.
 */
export declare function installPermissionSheet(ctx: ClientContext): void;
//# sourceMappingURL=permission-sheet.d.ts.map