import type { ClientContext } from '../compat/types.ts';
/**
 * Phone: park the composer row's third-party controls inside the model sheet.
 *
 * The row is one nowrap flex line and the model pill is its only shrinkable
 * item (composer.css.ts section 1), so every entry a plugin adds to
 * `conversation.input.right` comes straight out of the model name. With
 * dsh-plugin-subscriptions' speed chip ("速度 · 标准", ~70px of text) and
 * dsh-vision-router's 28px vision toggle both present on a GPT model, the row
 * runs out of width. Both are model-scoped settings, so the model sheet —
 * which already holds 模型 and 推理等级 — is where they belong (user request,
 * 2026-09-06).
 *
 * Why move the real controls instead of drawing our own rows that drive them:
 * the same reason native-trigger-overlay.ts moves the real trigger. A stand-in
 * has to script the original, which is a road this plugin does not go down —
 * beyond the trusted-input wall that effect documents, our own rows would have
 * to mirror every piece of state (speed tier, disabled, aria-pressed, whether
 * a vision twin exists for the current model) and would rot on the next
 * upstream restyle. Moving the node keeps one source of truth: their React
 * roots go on owning and updating these elements, we only change where they
 * hang.
 *
 * Measured 2026-09-06 (DSH 0.1.2, 390px) before writing this — the two things
 * that would have killed the approach both hold: a relocated control survives
 * host re-renders (typing into the composer re-renders the row and does not
 * yank it back) and stays hit-testable at its new position.
 *
 * Restoring on close is not cosmetic. The sheet unmounts when it closes and
 * anything still inside goes with it, so the controls would vanish from the
 * page while their React roots kept updating detached nodes. The observer
 * therefore watches the menu leaving too, and the parked node is held as a
 * reference rather than looked up — once the menu is detached a document
 * query can no longer find it.
 */
export declare function installModelSheetExtras(ctx: ClientContext): void;
//# sourceMappingURL=model-sheet-extras.d.ts.map