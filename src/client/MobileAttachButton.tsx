import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPaperclipOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'

/** Full props for the composer attachment seat. */
export type MobileAttachButtonProps = PropsRuntime<'conversation.input.left'> & PropsLocale<typeof NS>

/**
 * Composer attachment button (S3 placeholder).
 *
 * Renders into `conversation.input.left`, which CSS orders to the leftmost
 * seat of the phone composer's bottom row. The official file picker opens on
 * the HOST machine, so it is useless over a phone — S7 replaces this no-op
 * with a client-side `<input type="file">` + upload endpoint. Until then the
 * button holds the seat and stays inert on tap (aria-disabled rather than
 * `disabled`, so the label is still announced).
 */
export function MobileAttachButton({ t }: MobileAttachButtonProps) {
  return (
    <button
      type="button"
      data-mobile-nav="attach"
      aria-label={t('attach')}
      aria-disabled="true"
      title={t('attachPending')}
      onClick={(e) => {
        e.preventDefault()
      }}
    >
      <IconPaperclipOutline16 size={16} />
    </button>
  )
}
