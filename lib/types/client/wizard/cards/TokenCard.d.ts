/**
 * TokenCard (GW-11): the Cloudflare API-token creation walkthrough — eight
 * numbered steps, the permission checklist as a small table, and a
 * paste-in box that hands the token back to the wizard's form (`onUse`).
 * The token never persists in component state beyond the box and never
 * leaves this machine except inside the wizard's own POST.
 */
import type { ReactNode } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { NS } from '../../locales.ts';
/** The wizard's translate function, straight from the shared locale contract. */
export type WizardT = PropsLocale<typeof NS>['t'];
export interface TokenCardProps {
    t: WizardT;
    /** Hands the pasted token back to the wizard's form field. */
    onUse: (token: string) => void;
    onClose: () => void;
}
export declare function TokenCard({ t, onUse, onClose }: TokenCardProps): ReactNode;
//# sourceMappingURL=TokenCard.d.ts.map