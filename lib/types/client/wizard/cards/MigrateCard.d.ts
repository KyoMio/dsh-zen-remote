/**
 * MigrateCard (GW-11): the six-step domain-to-Cloudflare walkthrough for
 * the tunnel path's precondition, with the 「重新检查」 button that closes
 * the card so the user re-runs the form's own check.
 */
import type { ReactNode } from 'react';
import type { WizardT } from './TokenCard.tsx';
export interface MigrateCardProps {
    t: WizardT;
    /** Closes the card so the caller can re-run its precondition check. */
    onRecheck: () => void;
    onClose: () => void;
}
export declare function MigrateCard({ t, onRecheck, onClose }: MigrateCardProps): ReactNode;
//# sourceMappingURL=MigrateCard.d.ts.map