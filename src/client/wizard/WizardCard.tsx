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

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface WizardCardProps {
  title: string
  /** The card's body — numbered steps and/or a config snippet. */
  children: ReactNode
  /** The copy button's payload; absent means no copy button. */
  copyText?: string | null
  copyLabel: string
  copiedLabel: string
  closeLabel: string
  onClose: () => void
}

export function WizardCard({ title, children, copyText, copyLabel, copiedLabel, closeLabel, onClose }: WizardCardProps): ReactNode {
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current)
    }
  }, [onClose])

  const copy = async (): Promise<void> => {
    if (copyText === undefined || copyText === null || copyText === '') return
    try {
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
      if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard denial (permissions, non-secure context): the snippet is
      // selectable text anyway.
    }
  }

  return (
    <div data-zen-remote="wizard-card" onClick={onClose}>
      <div className="zr-wizard-cardPanel" onClick={(event) => event.stopPropagation()}>
        <p className="zr-wizard-cardTitle">{title}</p>
        {children}
        <div className="zr-wizard-cardActions">
          {copyText !== undefined && copyText !== null && copyText !== '' ? (
            <button type="button" onClick={() => { void copy() }}>{copied ? copiedLabel : copyLabel}</button>
          ) : null}
          <button type="button" onClick={onClose}>{closeLabel}</button>
        </div>
      </div>
    </div>
  )
}
