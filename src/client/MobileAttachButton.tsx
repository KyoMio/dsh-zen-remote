import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPaperclipOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from './compat/types.ts'
import { NS } from './locales.ts'
import { appendDraftOf, rememberThumbnail, uploadUrl, writeMention } from './attach-upload.ts'

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
 * DSH 0.1.5 gave the official tool row its own paperclip, and this button
 * used to stand down whenever that flow's hidden `<input type="file">` was
 * probed in the composer (that probe file is deleted with #31), keeping one
 * attach control per composer. DSH 0.2.x then removed the standalone
 * paperclip (the file action moved into the `+` command menu) while KEEPING
 * the hidden input, so the probe matched on every host and the phone composer
 * was left with no attach affordance at all. The phone shell now always
 * renders this button — its picker is the CLIENT's (相册 / 拍照 / 选取文件),
 * and every attachment takes the same `@.dsh-uploads/` draft-token path on
 * every DSH version. On DSH ≤ 0.1.5, which still ships the second official
 * paperclip, composer.css.ts hides it below 768px so the row keeps exactly
 * one attach control. Subagent sessions stay buttonless, mirroring the host:
 * the official InputBar disables its own file input while
 * `subagent !== null`.
 *
 * Every picked file takes the SAME path: upload to the node half, then append
 * `@.dsh-uploads/name` to the draft through the official write path — no DOM
 * value poking: `inputActions.appendDraft` where the running DSH exposes it
 * (0.2.1-rc.3+ editor runtime; keeps the user's text and inline references),
 * else `inputActions.setDraft` with the whole next draft (attach-upload.ts
 * `writeMention`). S7.1 removed the split that used
 * to send inlineable images straight into the session with `session.prompt`:
 * one behaviour for every attachment, and the user always presses send.
 * MobileAttachChips renders the preview row off those same draft tokens.
 *
 * Files upload one at a time: a phone uplink gains nothing from parallelism
 * and a serial loop keeps the mentions in pick order.
 */
export function MobileAttachButton({ t, sessionId, useInput, inputActions, useSessions }: MobileAttachButtonProps) {
  const picker = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draft = useInput((state) => state.draft)
  // Same session-row read the share icon/menu use (RemoteHeaderIcon.tsx):
  // `origin: 'subagent'` is the only subagent signal that reaches slot
  // registrants — the InputBar's own `subagent` prop does not.
  const row = useSessions((sessions) => sessions.byId[sessionId])
  // Uploads are awaited, so the `draft` captured at pick time goes stale — the
  // user can keep typing while a file is in flight. The ref is refreshed on
  // every render (useInput re-renders us on each draft change), so the loop
  // below can rebase onto whatever the composer holds right now.
  const liveDraft = useRef(draft)
  liveDraft.current = draft

  // Subagent sessions get no attach affordance, mirroring the host (its own
  // file input is disabled while a subagent session is open). All hooks stay
  // above this line.
  if (row?.origin === 'subagent') return null

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    // Reset first: picking the same file twice in a row fires no change event
    // otherwise, which reads to the user as "the button stopped working".
    event.target.value = ''
    if (files.length === 0) return

    setBusy(true)
    setError(null)
    // appendDraft (DSH 0.2.1-rc.3+) appends after whatever the composer holds
    // right now, so no rebasing is needed. The setDraft fallback takes the
    // WHOLE next draft, so each mention is appended to the value we last
    // wrote — unless the ref shows the user has typed since, in which case
    // theirs wins and we append to that instead. (Rebasing on the ref
    // unconditionally would lose a mention whenever React had not yet
    // re-rendered us between two files of the same pick.)
    const appends = appendDraftOf(inputActions) !== undefined
    let written = liveDraft.current
    try {
      for (const file of files) {
        const relPath = await uploadFile(sessionId, file)
        // Local preview for the chip row; a no-op for non-images.
        rememberThumbnail(relPath, file)
        written = writeMention(inputActions, (appends || liveDraft.current === written) ? written : liveDraft.current, relPath)
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
        <IconPaperclipOutlineRegular size={16} />
        {error === null ? null : (
          <span data-mobile-nav="attach-error" role="status" onClick={(e) => { e.stopPropagation(); setError(null) }}>
            {t('attachFailed')}
          </span>
        )}
      </button>
    </>
  )
}
