import type { ClientContext } from '../compat/types.ts';
/**
 * S9 — keep the phone keyboard down until the user asks for it.
 *
 * dsh-client-ui-conversation focuses the composer's editing host on every
 * sessionId change (0.1.2: `el.focus({preventScroll:true})` on the textarea;
 * 0.1.5: the same on the Lexical contenteditable). Sensible on desktop; on a
 * phone it pops the software keyboard over half the screen every time a
 * session opens.
 *
 * Rule: focus on the composer field survives only when the user asked for
 * it — a tap on the field itself or typing on a hardware keyboard. Anything
 * else (session-open autofocus, push-deep-link opens, the refocus side
 * effects of the other composer buttons — the official attach paperclip's
 * `keepFocus` mousedown, the slash-command toggle, send) is blurred. That
 * attach case is not hypothetical: 0.1.5's official paperclip refocuses the
 * editor on MOUSEDOWN, and while this guard was blind to the contenteditable
 * (2026-09-11 report) every tap on it popped the keyboard and shoved the
 * composer up the screen.
 *
 * Two triggers, because one is not enough:
 * - focusin catches the autofocus the moment it happens;
 * - a body MutationObserver re-runs the check after transcript swaps
 *   (opening a session re-renders the flow but may reuse the same field,
 *   and a focus that landed before this plugin loaded never fired focusin
 *   for us at all).
 * Once focus is user-granted it stays granted until the field blurs, so
 * the observer never yanks a keyboard the user opened (e.g. while the agent
 * streams and the user pauses typing).
 */
export declare function installKeyboardGuard(ctx: ClientContext): void;
//# sourceMappingURL=keyboard-guard.d.ts.map