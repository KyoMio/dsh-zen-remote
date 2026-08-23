/**
 * Lay each official header trigger transparently over the activity pill that
 * stands in for it, so a real finger tap lands on the official element.
 *
 * Why not just forward the tap (what this replaced): DSH 0.1.1's subagent
 * trigger only reacts to TRUSTED input. Measured on device 2026-08-21 —
 * `.click()`, and synthetic `pointerdown`/`mousedown`/`pointerup`, all leave
 * `aria-expanded` at "false"; a CDP-dispatched real touch at the same point
 * opens it. That was verified with every plugin style override stripped off
 * the trigger, so it is the event path, not our CSS. Any design that scripts
 * the click is therefore dead, and this one moves the real control instead.
 *
 * Why this is now cheap: in 0.1.1 the popover portals to <body> as a
 * `position: fixed` layer (`ZKlsPq_menu`, z-index 100) and positions itself
 * from the trigger's viewport rect — measured 336px wide, fully on screen.
 * So placing the trigger over the pill also lands the popover at the pill,
 * and none of the old "park an anchor, re-anchor the menu" CSS is needed.
 *
 * The pill keeps the visuals (icon, count, state dot); the invisible official
 * trigger on top keeps the behaviour. Pills are `pointer-events: none` so a
 * tap can only ever reach the real thing — no double handling.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
export declare function installNativeTriggerOverlay(ctx: ClientContext): void;
//# sourceMappingURL=native-trigger-overlay.d.ts.map