import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/**
 * Phone: an @-file reference tap in the workbench closes the workbench.
 *
 * On a phone the panel is a full-screen surface over the conversation, so
 * after tapping a row's @ button the user is still looking at the file tree
 * — the ONLY feedback for the tap is a draft change on a composer they
 * cannot see (real-device report, 2026-08-26: reads as "nothing happened",
 * and the close pill can end up behind the software keyboard on top of it).
 * Closing the panel IS the feedback: the conversation comes back with the
 * fresh `@path` sitting in the composer.
 *
 * Capture phase on document, deliberately: the button's own React handler
 * calls stopPropagation() (its row would otherwise open the file), so a
 * bubble listener never hears the tap. Capture runs on the way DOWN, before
 * the target handler and its stopPropagation can matter — the aionui-compat
 * chevron listener set this precedent.
 *
 * The close is deferred one macrotask so the reference lands first: the
 * button's handler (which appends `@path` to the draft) runs at target
 * phase, synchronously inside this same event dispatch — by the time the
 * timeout fires the draft is written and the toggle click only changes what
 * is on screen. Desktop is untouched (checked per tap, not at install: a
 * resize mid-session must not leave a stale arm either way), where the
 * panel is a docked column and closing it after every reference would be
 * hostile to multi-file referencing.
 */
export declare function installWorkbenchRefClose(ctx: ClientContext): void;
//# sourceMappingURL=workbench-ref-close.d.ts.map