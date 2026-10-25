/**
 * WizardCard (GW-10): the modal popup for steps the user must perform
 * ELSEWHERE — creating the Cloudflare token, configuring their own
 * reverse proxy. Numbered steps in the page locale, copy-to-clipboard for
 * the value or snippet at hand, Esc / backdrop / button to close. Scoped
 * under `[data-zen-remote="wizard-card"]`; rendered through a DOM portal
 * so the Plugins page's stacking contexts cannot clip it.
 */
import type { ReactNode } from 'react';
export interface WizardCardProps {
    title: string;
    /** The card's body — numbered steps and/or a config snippet. */
    children: ReactNode;
    /** The copy button's payload; absent means no copy button. */
    copyText?: string | null;
    copyLabel: string;
    copiedLabel: string;
    closeLabel: string;
    onClose: () => void;
}
export declare function WizardCard({ title, children, copyText, copyLabel, copiedLabel, closeLabel, onClose }: WizardCardProps): ReactNode;
//# sourceMappingURL=WizardCard.d.ts.map