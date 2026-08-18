import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/**
 * S9 — keep the phone keyboard down until the user asks for it.
 *
 * dsh-client-ui-conversation focuses the composer textarea on every
 * sessionId change (lib/client.js:3423 — el.focus({preventScroll:true}) in a
 * [locked, sessionId] effect). Sensible on desktop; on a phone it pops the
 * software keyboard over half the screen every time a session opens.
 *
 * Rule: focus on the composer textarea survives only when the user asked for
 * it — a tap on the textarea itself or typing on a hardware keyboard.
 * Anything else (session-open autofocus, push-deep-link opens, the refocus
 * side effects of the other composer buttons — slash-command toggle, attach,
 * send) is blurred.
 *
 * Two triggers, because one is not enough:
 * - focusin catches the autofocus the moment it happens;
 * - a body MutationObserver re-runs the check after transcript swaps
 *   (opening a session re-renders the flow but may reuse the same textarea,
 *   and a focus that landed before this plugin loaded never fired focusin
 *   for us at all).
 * Once focus is user-granted it stays granted until the textarea blurs, so
 * the observer never yanks a keyboard the user opened (e.g. while the agent
 * streams and the user pauses typing).
 */
export declare function installKeyboardGuard(ctx: ClientContext): void;
//# sourceMappingURL=keyboard-guard.d.ts.map