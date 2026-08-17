import { useEffect } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCloseFill14, IconPaperclipOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import {
  draftWithoutMention,
  leafOf,
  mentionsIn,
  middleEllipsis,
  releaseThumbnailsExcept,
  thumbnailFor,
} from './attach-upload.ts'

/** Full props for the attachment preview row. */
export type MobileAttachChipsProps =
  & PropsRuntime<'conversation.input.dock'>
  & PropsLocale<typeof NS>

/**
 * Attachment preview row (S7.1), in `conversation.input.dock` — the official
 * full-width row above the composer card, which composer.css.ts already lays
 * out as one horizontally scrollable chip line shared with whatever else docks
 * there (the git branch chip, a todo strip). No DOM injection into the
 * official card.
 *
 * **This component owns no state.** It renders whatever
 * `@.dsh-uploads/...` tokens the draft currently holds, so:
 *
 * - uploading appends a token -> a chip appears;
 * - the × removes the token -> the chip disappears;
 * - the user hand-deleting the text -> the chip disappears;
 * - the official send clearing the draft -> every chip disappears.
 *
 * There is no list to keep in sync and nothing to reconcile on session switch.
 * The only side state is the preview-URL map in attach-upload.ts, and the
 * effect below is what keeps it honest: anything no longer mentioned gets its
 * object URL revoked.
 *
 * An image chip is a 48px tile; anything else (and any image whose preview did
 * not survive, see below) is a name pill. The `<img>` is stacked ON TOP of the
 * paperclip rather than swapped for it, so a format the engine cannot decode —
 * HEIC everywhere except WebKit — just fails to paint and reveals the icon,
 * with no error state to track.
 */
export function MobileAttachChips({ t, useInput, inputActions }: MobileAttachChipsProps) {
  const draft = useInput((state) => state.draft)
  const attachments = mentionsIn(draft)

  useEffect(() => {
    releaseThumbnailsExcept(mentionsIn(draft))
  }, [draft])

  if (attachments.length === 0) return null

  return (
    <div data-mobile-nav="attach-chips">
      {attachments.map((relPath) => {
        const name = leafOf(relPath)
        const preview = thumbnailFor(relPath)
        return (
          <span
            key={relPath}
            data-mobile-nav="attach-chip"
            data-kind={preview === undefined ? 'file' : 'image'}
            title={name}
          >
            <span data-mobile-nav="attach-chip-art">
              <IconPaperclipOutline16 size={16} />
              {preview === undefined ? null : <img src={preview} alt="" />}
            </span>
            {preview === undefined ? <span data-mobile-nav="attach-chip-name">{middleEllipsis(name)}</span> : null}
            <button
              type="button"
              data-mobile-nav="attach-chip-remove"
              aria-label={t('attachRemove', { name })}
              onClick={() => inputActions.setDraft(draftWithoutMention(draft, relPath))}
            >
              <IconCloseFill14 size={14} />
            </button>
          </span>
        )
      })}
    </div>
  )
}
