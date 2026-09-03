import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPaperclipOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from './compat/types.ts'
import { NS } from './locales.ts'
import { draftWithMention, rememberThumbnail, uploadUrl } from './attach-upload.ts'

/** Full props for the composer attachment seat. */
export type MobileAttachButtonProps =
  & PropsRuntime<'conversation.input.left'>
  & PropsLocale<typeof NS>

/** Shape of the node half's response body (src/index.ts handleUpload). */
type UploadResult = { ok: true; relPath: string } | { ok: false; error: { code: string; message: string } }

/** Post one file to the host route and return the workspace-relative path it landed on. */
async function uploadFile(sessionId: SessionId, file: File): Promise<string> {
  const response = await fetch(uploadUrl(sessionId, file.name), {
    method: 'POST',
    // Same-origin so the gateway half of this plugin's pairing cookie rides along;
    // the body is the raw bytes, no multipart wrapper for the host to parse.
    credentials: 'same-origin',
    headers: { 'Content-Type': file.type === '' ? 'application/octet-stream' : file.type },
    body: file,
  })
  const body = (await response.json()) as UploadResult
  if (!response.ok || !body.ok) {
    throw new Error(body.ok === false ? body.error.message : `HTTP ${response.status}`)
  }
  return body.relPath
}

/**
 * Composer attachment button (S7).
 *
 * Renders into `conversation.input.left`, which CSS orders to the leftmost
 * seat of the phone composer's bottom row (and hides at >= 768px, where the
 * official picker on the host machine is the right answer). Tapping it opens
 * the CLIENT's picker — no `accept` attribute on purpose, so iOS offers the
 * full 相册 / 拍照 / 选取文件 sheet rather than one of them.
 *
 * Every picked file takes the SAME path: upload to the node half, then append
 * `@.dsh-uploads/name` to the draft through `inputActions.setDraft` (the
 * official write path — no DOM value poking). S7.1 removed the split that used
 * to send inlineable images straight into the session with `session.prompt`:
 * one behaviour for every attachment, and the user always presses send.
 * MobileAttachChips renders the preview row off those same draft tokens.
 *
 * Files upload one at a time: a phone uplink gains nothing from parallelism
 * and a serial loop keeps the mentions in pick order.
 */
export function MobileAttachButton({ t, sessionId, useInput, inputActions }: MobileAttachButtonProps) {
  const picker = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draft = useInput((state) => state.draft)
  // Uploads are awaited, so the `draft` captured at pick time goes stale — the
  // user can keep typing while a file is in flight. The ref is refreshed on
  // every render (useInput re-renders us on each draft change), so the loop
  // below can rebase onto whatever the composer holds right now.
  const liveDraft = useRef(draft)
  liveDraft.current = draft

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    // Reset first: picking the same file twice in a row fires no change event
    // otherwise, which reads to the user as "the button stopped working".
    event.target.value = ''
    if (files.length === 0) return

    setBusy(true)
    setError(null)
    // setDraft takes the WHOLE next draft, so each mention is appended to the
    // value we last wrote — unless the ref shows the user has typed since, in
    // which case theirs wins and we append to that instead. (Rebasing on the
    // ref unconditionally would lose a mention whenever React had not yet
    // re-rendered us between two files of the same pick.)
    let written = liveDraft.current
    try {
      for (const file of files) {
        const relPath = await uploadFile(sessionId, file)
        // Local preview for the chip row; a no-op for non-images.
        rememberThumbnail(relPath, file)
        written = draftWithMention(liveDraft.current === written ? written : liveDraft.current, relPath)
        inputActions.setDraft(written)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        data-mobile-nav="attach-picker"
        onChange={(event) => { void pick(event) }}
      />
      <button
        type="button"
        data-mobile-nav="attach"
        data-busy={busy ? '' : undefined}
        aria-label={t('attach')}
        aria-busy={busy}
        title={error ?? (busy ? t('attachBusy') : t('attach'))}
        onClick={() => {
          setError(null)
          picker.current?.click()
        }}
      >
        <IconPaperclipOutline16 size={16} />
        {error === null ? null : (
          <span data-mobile-nav="attach-error" role="status" onClick={(e) => { e.stopPropagation(); setError(null) }}>
            {t('attachFailed')}
          </span>
        )}
      </button>
    </>
  )
}
