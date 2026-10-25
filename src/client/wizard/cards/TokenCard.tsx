/**
 * TokenCard (GW-11): the Cloudflare API-token creation walkthrough — eight
 * numbered steps, the permission checklist as a small table, and a
 * paste-in box that hands the token back to the wizard's form (`onUse`).
 * The token never persists in component state beyond the box and never
 * leaves this machine except inside the wizard's own POST.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from '../../locales.ts'
import { WizardCard } from '../WizardCard.tsx'

/** The wizard's translate function, straight from the shared locale contract. */
export type WizardT = PropsLocale<typeof NS>['t']

export interface TokenCardProps {
  t: WizardT
  /** Hands the pasted token back to the wizard's form field. */
  onUse: (token: string) => void
  onClose: () => void
}

const STEPS = ['tokenStep1', 'tokenStep2', 'tokenStep3', 'tokenStep4', 'tokenStep5', 'tokenStep6', 'tokenStep7', 'tokenStep8'] as const

export function TokenCard({ t, onUse, onClose }: TokenCardProps): ReactNode {
  const [pasted, setPasted] = useState('')
  return (
    <WizardCard
      title={t('wizard.card.tokenTitle')}
      copyText={null}
      copyLabel={t('wizard.card.copy')}
      copiedLabel={t('wizard.card.copied')}
      closeLabel={t('wizard.card.close')}
      onClose={onClose}
    >
      {STEPS.map((key, index) => (
        <p key={key} className="zr-wizard-cardStep">{`${index + 1}. ${t(`wizard.card.${key}`)}`}</p>
      ))}
      <p className="zr-wizard-cardStep">{t('wizard.card.tokenPerms')}</p>
      <table className="zr-wizard-cardTable">
        <tbody>
          <tr>
            <td className="zr-wizard-cardPerm">{t('wizard.card.tokenPermDns')}</td>
            <td className="zr-wizard-cardWhy">{t('wizard.card.tokenPermDnsWhy')}</td>
          </tr>
          <tr>
            <td className="zr-wizard-cardPerm">{t('wizard.card.tokenPermTunnel')}</td>
            <td className="zr-wizard-cardWhy">{t('wizard.card.tokenPermTunnelWhy')}</td>
          </tr>
        </tbody>
      </table>
      <label className="zr-wizard-label" htmlFor="zr-wizard-token-paste">{t('wizard.card.tokenPaste')}</label>
      <input
        id="zr-wizard-token-paste"
        className="zr-wizard-input"
        type="password"
        value={pasted}
        onChange={(event) => setPasted(event.target.value)}
      />
      <div className="zr-wizard-cardActions">
        <button type="button" disabled={pasted.trim() === ''} onClick={() => onUse(pasted.trim())}>
          {t('wizard.card.tokenUse')}
        </button>
        <button type="button" onClick={onClose}>{t('wizard.card.close')}</button>
      </div>
    </WizardCard>
  )
}
