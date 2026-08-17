import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** S6: the two-gesture set — left-edge swipe-back and sheet drag-to-close.
 * Both install/uninstall their own document listeners on the phone
 * breakpoint's matchMedia change, so at >= 768px this is a true no-op (no
 * listeners attached at all), matching every other effect in this file. */
export declare function installGestures(ctx: ClientContext): void;
//# sourceMappingURL=gestures.d.ts.map