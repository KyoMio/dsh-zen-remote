import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPaperclipOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionFace, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-remotes/client'
import { NS } from './locales.ts'
import { buildImageParts, bytesToBase64, draftWithMention, promptImageType, uploadUrl } from './attach-upload.ts'
import type { PickedImage } from './attach-upload.ts'

/** Full props for the composer attachment seat. */
export type MobileAttachButtonProps =
  & PropsRuntime<'conversation.input.left'>
  & PropsLocale<typeof NS>
  & {
    /** Bound ctx.sessions.binding(id)?.session.prompt(parts, 'queue'); undefined when the binding is gone. */
    promptImages: (sessionId: SessionId, content: PromptContentPart[]) => ReturnType<SessionFace['prompt']> | undefined
  }

/** Shape of the node half's success body (src/index.ts handleUpload). */
interface UploadOk {
  ok: true
  relPath: string
}

interface UploadFail {
  ok: false
  error: { code: string; message: string }
}

/** Post one file to the host route and return the workspace-relative path it landed on. */
async function uploadFile(sessionId: SessionId, file: File): Promise<string> {
  const response = await fetch(uploadUrl(sessionId, file.name), {
    method: 'POST',
    // Same-origin so the dsh-mobile-pwa gateway's pairing cookie rides along;
    // the body is the raw bytes, no multipart wrapper for the host to parse.
    credentials: 'same-origin',
    headers: { 'Content-Type': file.type === '' ? 'application/octet-stream' : file.type },
    body: file,
  })
  const body = (await response.json()) as UploadOk | UploadFail
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
 * Picked files split down two paths, because DSH publishes no upload API and
 * only one public browser->host byte channel:
 *
 * - an inlineable image (png/jpeg/webp/gif) becomes a `PromptContentPart` and
 *   goes through `session.prompt(parts, 'queue')` — which SENDS the batch as
 *   a turn, carrying the current draft as its text so a typed caption is not
 *   stranded behind the photo;
 * - anything else (HEIC, PDF, zip, …) is POSTed to the node half's route,
 *   lands in the session workspace, and its `@path` is appended to the draft
 *   for the user to send when they are ready.
 *
 * Files upload one at a time: a phone uplink gains nothing from parallelism
 * and a serial loop keeps the `@path` mentions in pick order.
 */
export function MobileAttachButton({ t, sessionId, useInput, inputActions, promptImages }: MobileAttachButtonProps) {
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
    const images: PickedImage[] = []
    // setDraft takes the WHOLE next draft, so each mention is appended to the
    // value we last wrote — unless the ref shows the user has typed since,
    // in which case theirs wins and we append to that instead. (Rebasing on
    // the ref unconditionally would lose a mention whenever React had not yet
    // re-rendered us between two files of the same pick.)
    let written = liveDraft.current
    const base = () => (liveDraft.current === written ? written : liveDraft.current)
    try {
      for (const file of files) {
        const mediaType = promptImageType(file.type)
        if (mediaType !== undefined) {
          images.push({ name: file.name, mediaType, base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())) })
          continue
        }
        written = draftWithMention(base(), await uploadFile(sessionId, file))
        inputActions.setDraft(written)
      }
      if (images.length > 0) {
        const text = base()
        const sent = await promptImages(sessionId, buildImageParts(images, text))
        if (sent === undefined || !sent.ok) throw new Error(t('attachFailed'))
        // prompt() consumed the draft as the batch's text — clear what it took
        // so the caption is not sent a second time.
        if (text.trim() !== '') inputActions.setDraft('')
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
