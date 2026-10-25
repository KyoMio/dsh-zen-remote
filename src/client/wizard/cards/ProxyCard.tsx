/**
 * ProxyCard (GW-11): the reverse-proxy snippets for the user's OWN proxy,
 * tabbed nginx / Caddy / Lucky, with the snippet copy button and the
 * 「我配好了，检查」 button that hands control back to the wizard's
 * verification step.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { caddySnippetText, luckyStepTexts, nginxSnippetText, SNIPPET_KINDS, type SnippetKind } from '../../../client-data/wizard.ts'
import type { WizardT } from './TokenCard.tsx'
import { WizardCard } from '../WizardCard.tsx'

export interface ProxyCardProps {
  t: WizardT
  /** Snippet inputs — the domain as typed, the gateway's ACTUAL port. */
  domain: string
  upstreamPort: number
  /** 「我配好了，检查」: closes the card and starts the verification. */
  onCheck: () => void
  onClose: () => void
}

export function ProxyCard({ t, domain, upstreamPort, onCheck, onClose }: ProxyCardProps): ReactNode {
  const [tab, setTab] = useState<SnippetKind>('nginx')
  const input = { domain, upstreamHost: '127.0.0.1', upstreamPort }
  const text = tab === 'nginx'
    ? nginxSnippetText(input)
    : tab === 'caddy' ? caddySnippetText(input) : (luckyStepTexts(input) ?? []).join('\n')
  return (
    <WizardCard
      title={t('wizard.card.proxyTitle')}
      copyText={text}
      copyLabel={t('wizard.card.copy')}
      copiedLabel={t('wizard.card.copied')}
      closeLabel={t('wizard.card.close')}
      onClose={onClose}
    >
      <div className="zr-wizard-cardTabs">
        {SNIPPET_KINDS.map((kind) => (
          <button key={kind} type="button" className="zr-wizard-cardTab" data-selected={tab === kind} onClick={() => setTab(kind)}>
            {kind}
          </button>
        ))}
      </div>
      {text === null
        ? <p className="zr-wizard-cardStep">{t('wizard.badDomain')}</p>
        : <pre className="zr-wizard-cardCode">{text}</pre>}
      <div className="zr-wizard-cardActions">
        <button type="button" onClick={() => { onCheck(); onClose() }}>{t('wizard.card.proxyCheck')}</button>
        <button type="button" onClick={onClose}>{t('wizard.card.close')}</button>
      </div>
    </WizardCard>
  )
}
