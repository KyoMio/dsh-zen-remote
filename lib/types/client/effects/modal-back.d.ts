/**
 * Give Android's back gesture something to close for modals this plugin does
 * NOT own — the official settings/export dialogs, the composer's permission
 * and model sheets, third-party panels like dsh-better-sidebar's workbench.
 *
 * Those all keep their open state in their own React components with no
 * public setter, so there is nothing to call. What they do share is a
 * contract the DOM exposes: while open they are `[aria-modal="true"]`, and
 * they close on Escape (the standard dismissal every one of these primitives
 * implements). So: watch for one appearing, stack a history layer, and close
 * it by sending Escape.
 *
 * Anchored on the ARIA contract rather than on any hashed class or plugin
 * name, so a modal from a plugin nobody has written compat for still gets a
 * working back gesture.
 *
 * Phone only. On desktop the back gesture is not a thing and the official
 * dialogs keep their own behaviour untouched (the repo's desktop no-op rule).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
export declare function installModalBack(ctx: ClientContext): void;
//# sourceMappingURL=modal-back.d.ts.map