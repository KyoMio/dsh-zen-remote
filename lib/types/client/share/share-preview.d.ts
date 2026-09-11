import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { NS } from '../locales.ts';
/** Full props: shell.overlay (root scope) gives the standard `useSessions`. */
export type SharePreviewProps = PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS>;
/**
 * Share-card preview panel. Fixed at the top of the overlay layer, scrollable
 * (long transcripts must be inspectable), all-inline-styled like the card —
 * this feature adds no page CSS by design (PLAN §9.4).
 */
export declare function SharePreview({ useSessions, t }: SharePreviewProps): import("react").JSX.Element | null;
//# sourceMappingURL=share-preview.d.ts.map