/**
 * Share-range bottom sheet (ticket 05, PLAN §6): the small picker that opens
 * from the session-info sheet's 分享图 action — whole conversation or one of
 * the last-N-turns presets (3/5/10, no free input).
 *
 * Mounts INSIDE the info layer's DOM as a DIRECT child of
 * `[data-mobile-nav="info-layer"]` — a sibling of the info card, never a
 * child of the card itself (a card-internal mount clipped this sheet's mask
 * to the card's box, anchored its bottom to the card's scrollable area, and
 * let taps outside the card reach the info mask underneath — closing both
 * layers at once and stranding the share layer's history entry; review
 * 2026-09-10). That placement buys three things for free: the ≥768px
 * `display:none` of info.css.ts keeps the desktop pixel-identical no-op
 * (this feature adds no page CSS, PLAN §9.4), the sheet paints in the
 * header's z:70 promotion while the info sheet is open, and the info layer
 * (itself a fixed stacking context, inset:0) is the containing block — so
 * this sheet's own absolute inset:0 overlay is a fullscreen mask and its
 * bottom anchor is the viewport safe area, exactly like the info card's.
 * The back stack is the caller's business: the caller pushes one SHARE_LAYER
 * entry on top of the info layer's, so a back gesture closes exactly this
 * sheet — one layer per press, same discipline as history-nav.ts demands.
 *
 * All-inline styles like everything else in the share feature; theme values
 * read the host CSS variables with the same fallbacks info.css.ts declares,
 * and the entry animations reuse base.css.ts's existing keyframes (referenced
 * from inline `animation`, which adds no stylesheet rules). Reduced-motion is
 * honored by checking the media query at mount — inline styles cannot carry
 * a media query themselves.
 */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCheckOutline16, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../locales.ts'
import { SHARE_TURNS_PRESETS } from './fetch-share.ts'

/** Which range the user picked: everything, or the last N turns. */
export type SharePreset = 'all' | number

/** Props: locale seat + the two callbacks the info sheet wires to its layer stack. */
export type ShareRangeSheetProps =
  & PropsLocale<typeof NS>
  & {
    /** True while fetch → render → rasterize runs: options and confirm lock, confirm copy flips to 生成中. */
    busy: boolean
    /** Confirmed a range — the caller starts the pipeline. */
    onConfirm: (preset: SharePreset) => void
    /** Close request (mask tap, ✕, or the back-driven close). */
    onClose: () => void
  }

/** One-time page-load probe: skip the entry animations when the user asks for less motion. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const MASK_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  border: 'none',
  background: 'var(--dsw-alias-bg-mask-3, rgba(0, 0, 0, .45))',
}

const SHEET_STYLE: CSSProperties = {
  position: 'absolute',
  left: '8px',
  right: '8px',
  bottom: 'calc(var(--mnav-sab, 0px) + 8px)',
  boxSizing: 'border-box',
  padding: '12px',
  borderRadius: '16px',
  background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
  boxShadow: '0 8px 32px rgba(0, 0, 0, .28)',
}

const HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginBottom: 10,
}

const TITLE_STYLE: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary, inherit)',
}

const CLOSE_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 34,
  height: 34,
  flex: 'none',
  padding: 0,
  border: 'none',
  borderRadius: '50%',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, inherit)',
  cursor: 'pointer',
  touchAction: 'manipulation',
  WebkitTapHighlightColor: 'transparent',
}

const OPTION_BASE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  minHeight: 48,
  padding: '0 14px',
  border: 'none',
  borderRadius: 12,
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontFamily: 'inherit',
  fontSize: 14,
  textAlign: 'start',
  cursor: 'pointer',
  touchAction: 'manipulation',
  WebkitTapHighlightColor: 'transparent',
}

const CONFIRM_STYLE: CSSProperties = {
  width: '100%',
  minHeight: 48,
  marginTop: 10,
  padding: '0 14px',
  border: 'none',
  borderRadius: 12,
  background: 'var(--dsw-alias-brand-primary, #0f1115)',
  color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
  fontFamily: 'inherit',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  touchAction: 'manipulation',
  WebkitTapHighlightColor: 'transparent',
}

/** The share-range sheet. Rendered only while open (the caller owns the layer stack). */
export function ShareRangeSheet({ busy, onConfirm, onClose, t }: ShareRangeSheetProps): ReactNode {
  const [preset, setPreset] = useState<SharePreset>('all')
  const [reduced] = useState(prefersReducedMotion)

  const enter = reduced ? undefined : 'dsh-mobile-nav-sheet-up .22s var(--ds-ease-out, ease-in-out)'
  const fade = reduced ? undefined : 'dsh-mobile-nav-fade .18s var(--ds-ease-out, ease-in-out)'

  const options: Array<{ key: string; label: string; value: SharePreset }> = [
    { key: 'all', label: t('sharePickerAll'), value: 'all' },
    ...SHARE_TURNS_PRESETS.map((count) => ({ key: `last-${count}`, label: t('sharePickerLast', { count }), value: count })),
  ]

  return (
    <div data-mobile-nav="share-range-layer" style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
      <div
        data-mobile-nav="share-range-mask"
        role="button"
        tabIndex={-1}
        aria-label={t('infoClose')}
        onClick={onClose}
        style={fade === undefined ? MASK_STYLE : { ...MASK_STYLE, animation: fade }}
      />
      <div
        data-mobile-nav="share-range-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('sharePickerTitle')}
        style={enter === undefined ? SHEET_STYLE : { ...SHEET_STYLE, animation: enter }}
      >
        <div style={HEAD_STYLE}>
          <span style={TITLE_STYLE}>{t('sharePickerTitle')}</span>
          <button type="button" aria-label={t('infoClose')} onClick={onClose} style={CLOSE_STYLE}>
            <IconCloseOutline16 size={16} />
          </button>
        </div>

        {/* A plain radio group: label + options, aria-checked per row. */}
        <div role="radiogroup" aria-label={t('sharePickerTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {options.map((option) => {
            const selected = preset === option.value
            return (
              <button
                key={option.key}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={busy}
                data-selected={selected ? '' : undefined}
                onClick={() => { setPreset(option.value) }}
                style={{
                  ...OPTION_BASE,
                  background: selected ? 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06))' : 'transparent',
                  fontWeight: selected ? 600 : 400,
                }}
              >
                <span>{option.label}</span>
                {selected && (
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', color: 'var(--dsw-alias-label-primary, inherit)' }}>
                    <IconCheckOutline16 size={16} />
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => { onConfirm(preset) }}
          style={{ ...CONFIRM_STYLE, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? t('sharePickerBusy') : t('sharePickerConfirm')}
        </button>
      </div>
    </div>
  )
}
