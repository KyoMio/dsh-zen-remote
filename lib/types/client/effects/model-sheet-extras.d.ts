import type { ClientContext } from '../compat/types.ts';
/**
 * Phone: move the composer row's secondary third-party controls into a
 * 26px horizontally-scrollable strip inside the dock rail above the card —
 * always visible, one tap from anywhere, no sheet in between.
 *
 * Why move the real controls instead of drawing our own rows that drive
 * them: the same reason native-trigger-overlay.ts moves the real trigger. A
 * stand-in has to script the original, which is a road this plugin does not
 * go down — beyond the trusted-input wall that effect documents, our own
 * rows would have to mirror every piece of state (speed tier, disabled,
 * aria-pressed, whether a vision twin exists for the current model) and
 * would rot on the next upstream restyle. Moving the node keeps one source
 * of truth: their React roots go on owning and updating these elements, we
 * only change where they hang — never cloneNode, and the move is anchored
 * with a Comment at the original spot so `unparkAll` can put each node back
 * exactly where React left it.
 *
 * Measured 2026-09-06 (DSH 0.1.2, 390px) before the original version of
 * this effect — the two things that would have killed the approach both
 * hold: a relocated control survives host re-renders (typing into the
 * composer re-renders the row and does not yank it back) and stays
 * hit-testable at its new position.
 *
 * Known hazard, inherent to relocating React-owned nodes: a control whose
 * REGISTRATION unmounts while parked (plugin disabled, slot re-keyed) is
 * removed by React through its ORIGINAL parent — `parent.removeChild(child)`
 * throws when the child moved, and the exception lands in React's commit.
 * Updates that keep the registration mounted (state-driven re-renders,
 * text/attribute changes, a control's own inner nodes unmounting) are safe:
 * those removals run inside the parked subtree, where every parent-child
 * link React recorded still holds. Parking is also fully reversible — any
 * decline path (desktop, nothing worth moving, teardown) hands every node
 * back before anything is removed.
 */
export declare function installModelSheetExtras(ctx: ClientContext): void;
//# sourceMappingURL=model-sheet-extras.d.ts.map