import { useEffect, useRef } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DROP_MENTION_EVENT } from '../remote-drop-contract.ts'
import { isVirtual } from '../virtual-id.ts'
import { appendDraftOf, writeMention } from './attach-upload.ts'

/** Full props for the composer seat this invisible listener occupies. */
export type DropMentionListenerProps = PropsRuntime<'conversation.input.left'>

/**
 * Invisible composer seat (RD-7): the receiver half of the remote drop
 * upload flow. The document-level drop guard (effects/remote-drop.ts)
 * uploads each dragged file to the SERVER session's workspace and dispatches
 * a `zr:drop-mention` CustomEvent per receipt; THIS component turns those
 * events into `@.dsh-uploads/<name>` mentions in the composer draft through
 * the official write path (attach-upload.ts `writeMention`).
 *
 * It renders NOTHING — no UI of its own; the desktop shell keeps its
 * pixel-for-pixel no-op because a host-role desktop never holds a virtual
 * session, so the listener below never even mounts there.
 *
 * Three gates keep a mention from landing in the wrong draft: the seat's
 * own `sessionId` must be a `zr~` virtual id (local sessions have no
 * workspace uploads to mention), the event's `detail.sessionId` must equal
 * THIS seat's session (a guard dispatch from another open window or a stale
 * in-flight upload must not write here), and the relPath must be a
 * non-empty string. Unmounted → listener removed.
 *
 * The draft baseline is MobileAttachButton's: `appendDraft` (DSH
 * 0.2.1-rc.3+) appends after whatever the composer holds, so no rebasing is
 * needed; the `setDraft` fallback takes the WHOLE next draft, so a burst of
 * drop-mentions chains off the last written text — unless `useInput` shows
 * the user typed since, in which case theirs wins.
 */
export function DropMentionListener({ sessionId, useInput, inputActions }: DropMentionListenerProps) {
  const draft = useInput((state) => state.draft)
  // Drop-mentions arrive asynchronously (the uploads are awaited in the
  // guard), so any draft captured at mount goes stale — this ref is
  // refreshed on every render (useInput re-renders us on draft changes),
  // and the handler below rebases onto whatever the composer holds now.
  const liveDraft = useRef(draft)
  liveDraft.current = draft
  // The last draft the setDraft fallback wrote, chained across a burst of
  // mentions that arrive before React re-renders.
  const written = useRef(draft)

  useEffect(() => {
    if (!isVirtual(sessionId)) return
    const onDropMention = (event: Event): void => {
      const detail = (event as CustomEvent).detail as { sessionId?: unknown; relPath?: unknown } | undefined
      if (detail === undefined || detail.sessionId !== sessionId) return
      if (typeof detail.relPath !== 'string' || detail.relPath === '') return
      const appends = appendDraftOf(inputActions) !== undefined
      const base = appends || liveDraft.current === written.current ? written.current : liveDraft.current
      written.current = writeMention(inputActions, base, detail.relPath)
    }
    document.addEventListener(DROP_MENTION_EVENT, onDropMention)
    return () => {
      document.removeEventListener(DROP_MENTION_EVENT, onDropMention)
    }
  }, [sessionId, inputActions])

  // No UI — the seat exists so the runtime hands us sessionId/inputActions.
  return null
}
