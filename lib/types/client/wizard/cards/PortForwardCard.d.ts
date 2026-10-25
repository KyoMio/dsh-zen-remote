/**
 * PortForwardCard (GW-11): the router port-forwarding steps for path A on
 * a non-443 HTTPS port — the certificate rides DNS-01 (no inbound needed
 * for issuance), but the HTTPS service port itself must be reachable.
 */
import type { ReactNode } from 'react';
import type { WizardT } from './TokenCard.tsx';
export interface PortForwardCardProps {
    t: WizardT;
    /** The HTTPS port to forward. */
    port: number;
    onClose: () => void;
}
export declare function PortForwardCard({ t, port, onClose }: PortForwardCardProps): ReactNode;
//# sourceMappingURL=PortForwardCard.d.ts.map