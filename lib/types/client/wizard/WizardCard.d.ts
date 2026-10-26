/**
 * WizardCard (GW-10): the modal popup for steps the user must perform
 * ELSEWHERE — creating the Cloudflare token, configuring their own
 * reverse proxy. Numbered steps in the page locale, copy-to-clipboard for
 * the value or snippet at hand, Esc / backdrop / button to close. Scoped
 * under `[data-zen-remote="wizard-card"]`.
 *
 * Deliberately NO react-dom portal: `react-dom` is not a seed word of the
 * host browser module table (GW-fix-4 — `check-client-externals` gates the
 * allowlist), so the overlay renders IN PLACE as a `position: fixed`
 * layer. That keeps the plugin version-agnostic; the z-index floor of
 * 1000 clears the Plugins page chrome, and no ancestor of the detail page
 * establishes a containing block that could clip it.
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
    /** Optional primary action button rendered alongside the close button. */
    primaryAction?: ReactNode;
    onClose: () => void;
}
export declare function WizardCard({ title, children, copyText, copyLabel, copiedLabel, closeLabel, primaryAction, onClose }: WizardCardProps): ReactNode;
//# sourceMappingURL=WizardCard.d.ts.map