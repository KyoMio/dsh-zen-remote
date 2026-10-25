import type { ClientContext } from '../compat/types.ts';
/**
 * Phone: collect the composer row's secondary third-party controls behind a
 * `⋯` pill in the dock rail, and move the REAL nodes into a bottom sheet
 * while it is open.
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
 * Restoring on close is not cosmetic. The sheet unmounts when it closes and
 * anything still inside goes with it, so the controls would vanish from the
 * page while their React roots kept updating detached nodes. Every close
 * path — mask tap, ⋯ toggle, Android back gesture (via history-nav), phone
 * breakpoint change, teardown — funnels through `close`.
 *
 * Known narrow window, accepted by design: a control unmounting while the
 * sheet is OPEN (an async update removes it from the row). With the sheet
 * open the mask covers the row, so nothing user-driven can trigger that —
 * only background timers/polls could, and none of today's contributors do.
 * A detached parked node is pruned on the next sync and its anchor removed.
 */
export declare function installModelSheetExtras(ctx: ClientContext): void;
//# sourceMappingURL=model-sheet-extras.d.ts.map