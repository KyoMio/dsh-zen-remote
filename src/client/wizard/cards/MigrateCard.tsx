/**
 * MigrateCard (GW-11): the six-step domain-to-Cloudflare walkthrough for
 * the tunnel path's precondition, with the 「重新检查」 button that closes
 * the card so the user re-runs the form's own check.
 */

import type { ReactNode } from 'react'
import type { WizardT } from './TokenCard.tsx'
import { WizardCard } from '../WizardCard.tsx'

export interface MigrateCardProps {
  t: WizardT
  /** Closes the card so the caller can re-run its precondition check. */
  onRecheck: () => void
  onClose: () => void
}

const STEPS = ['migrateStep1', 'migrateStep2', 'migrateStep3', 'migrateStep4', 'migrateStep5', 'migrateStep6'] as const

export function MigrateCard({ t, onRecheck, onClose }: MigrateCardProps): ReactNode {
  return (
    <WizardCard
      title={t('wizard.card.migrateTitle')}
      copyText={null}
      copyLabel={t('wizard.card.copy')}
      copiedLabel={t('wizard.card.copied')}
      closeLabel={t('wizard.card.close')}
      onClose={onClose}
    >
      {STEPS.map((key, index) => (
        <p key={key} className="zr-wizard-cardStep">{`${index + 1}. ${t(`wizard.card.${key}`)}`}</p>
      ))}
      <div className="zr-wizard-cardActions">
        <button type="button" onClick={onRecheck}>{t('wizard.card.migrateRecheck')}</button>
        <button type="button" onClick={onClose}>{t('wizard.card.close')}</button>
      </div>
    </WizardCard>
  )
}
