/**
 * PortForwardCard (GW-11): the router port-forwarding steps for path A on
 * a non-443 HTTPS port — the certificate rides DNS-01 (no inbound needed
 * for issuance), but the HTTPS service port itself must be reachable.
 */

import type { ReactNode } from 'react'
import type { WizardT } from './TokenCard.tsx'
import { WizardCard } from '../WizardCard.tsx'

export interface PortForwardCardProps {
  t: WizardT
  /** The HTTPS port to forward. */
  port: number
  onClose: () => void
}

const STEPS = ['portForwardStep1', 'portForwardStep2', 'portForwardStep3', 'portForwardStep4'] as const

export function PortForwardCard({ t, port, onClose }: PortForwardCardProps): ReactNode {
  return (
    <WizardCard
      title={t('wizard.card.portForwardTitle')}
      copyText={null}
      copyLabel={t('wizard.card.copy')}
      copiedLabel={t('wizard.card.copied')}
      closeLabel={t('wizard.card.close')}
      onClose={onClose}
    >
      <div className="zr-wizard-cardSteps">
        {STEPS.map((key, index) => (
          <p key={key} className="zr-wizard-cardStep">{`${index + 1}. ${t(`wizard.card.${key}`, { port: String(port) })}`}</p>
        ))}
      </div>
    </WizardCard>
  )
}
