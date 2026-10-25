/**
 * ProxyCard (GW-11): the reverse-proxy snippets for the user's OWN proxy,
 * tabbed nginx / Caddy / Lucky, with the snippet copy button and the
 * 「我配好了，检查」 button that hands control back to the wizard's
 * verification step.
 */
import type { ReactNode } from 'react';
import type { WizardT } from './TokenCard.tsx';
export interface ProxyCardProps {
    t: WizardT;
    /** Snippet inputs — the domain as typed, the gateway's ACTUAL port. */
    domain: string;
    upstreamPort: number;
    /** 「我配好了，检查」: closes the card and starts the verification. */
    onCheck: () => void;
    onClose: () => void;
}
export declare function ProxyCard({ t, domain, upstreamPort, onCheck, onClose }: ProxyCardProps): ReactNode;
//# sourceMappingURL=ProxyCard.d.ts.map