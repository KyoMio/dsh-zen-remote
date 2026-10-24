/**
 * The "save this file to THIS machine" action for a REMOTE session (2.2.6).
 *
 * DSH's produced-file surfaces only ever OPEN a file: the deliverable card's
 * overlay previews it in the document panel, and open-in-app's split button
 * hands the path to the machine the DSH process runs on. On a paired desktop
 * sub-client both of those are the HOST's machine, which is why the
 * remote-session stylesheet hides the open controls — leaving a produced
 * Word/PDF/zip with no way to reach the client's disk at all. This action
 * fills exactly that gap: it reads the file through the relayed
 * `workspaceFiles/readBytes` channel (src/client/remote-file-save.ts) and
 * hands the bytes to the browser's download machinery, so the file lands on
 * the machine whose screen the user is looking at.
 *
 * Two surfaces, one button:
 *
 * - `deliverables.file.actions` — the file card of a closing turn. The slot
 *   deliberately hands its entries only the open-route coordinates
 *   (`actionUrl`), NOT the path; the card's own preview button carries the
 *   resolved absolute path in its `title` attribute (RT
 *   dsh-client-ui-deliverables PresentedFileCard: `title:
 *   resolveWorkspacePath(cwd, file.path)`), and the entry mounts INSIDE that
 *   card (`[data-presented-file]`), so the button reads the same host-rendered
 *   contract the plugin's stylesheets already anchor on. A card without the
 *   attribute (a future host) simply renders no path and the button reports
 *   the failure instead of guessing.
 * - `sidebar.right.tab.document.actions` — the document preview header, where
 *   the owner hands `absolutePath` directly (RT
 *   dsh-client-ui-sidebar-documentpreview TextPreview `fileOwner`), so the
 *   same file can be saved without hunting for the card again.
 *
 * Both registrations are unconditional; both COMPONENTS return null for a
 * local session (`isVirtual`), so a host-role deployment — and every local
 * session on a client deployment — renders exactly nothing.
 */
import { useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from './compat/types.ts'
import { isVirtual } from '../virtual-id.js'
import { NS } from './locales.ts'
import { downloadPathFromCard } from './remote-file-save.ts'
import type { SaveRemoteFile } from './remote-file-save.ts'

/**
 * Structural mirrors of the two host slot contracts. This package does not
 * depend on dsh-client-ui-deliverables / dsh-client-ui-sidebar-documentpreview
 * (the owners' type-only merges would normally provide these), so the mirror
 * records ONLY what this action reads: both slots are session-scoped lists;
 * the card carries the open-route coordinates, the document header carries
 * the resolved absolute path.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'deliverables.file.actions': {
      kind: 'list'
      scope: 'session'
      owner: {
        actionUrl: string
        available: boolean
        pending: boolean
        onAction: (action: string, application?: string) => unknown
      }
    }
    'sidebar.right.tab.document.actions': {
      kind: 'list'
      scope: 'session'
      owner: { absolutePath: string }
    }
  }
}

type DownloadPhase = 'idle' | 'busy' | 'error'

/** Translate seat of this plugin's namespace. */
type Translate = PropsLocale<typeof NS>['t']

/** The button's own inputs: the framework session id, the bound save
 * capability, the copy, and — only on the document header — the absolute
 * path; the card surface resolves its path from the card DOM. */
interface DownloadButtonProps {
  sessionId: SessionId
  t: Translate
  saveFile: SaveRemoteFile
  absolutePath?: string | undefined
}

/**
 * The save control. One download at a time; the label carries the three
 * states (idle / saving / failed) so a failure is visible on the card instead
 * of a silent no-op.
 * @param props - session, copy, save capability and (header only) the path.
 * @returns the button.
 */
function DownloadButton({ sessionId, t, saveFile, absolutePath }: DownloadButtonProps) {
  const [phase, setPhase] = useState<DownloadPhase>('idle')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const onClick = async (): Promise<void> => {
    if (phase === 'busy') return
    const path = absolutePath ?? downloadPathFromCard(buttonRef.current)
    setFailure(undefined)
    if (path === undefined) {
      setFailure('no-path')
      setPhase('error')
      return
    }
    setPhase('busy')
    try {
      await saveFile(sessionId, path)
      setPhase('idle')
    } catch (error) {
      // The reason is rendered INSIDE the button (short) and logged for the
      // console: without it a failed download on a client we cannot debug is
      // a dead end.
      const reason = (error instanceof Error ? error.message : String(error)).trim()
      console.error('[dsh-zen-remote] remote download failed:', path, error)
      setFailure(reason === '' ? 'unknown' : reason.slice(0, 22))
      setPhase('error')
    }
  }
  const label = phase === 'busy' ? t('downloadBusy') : phase === 'error' ? (failure === undefined ? t('downloadFailed') : `${t('downloadFailed')} (${failure})`) : t('downloadToLocal')
  return (
    <button
      ref={buttonRef}
      type="button"
      className="zr-download-action"
      data-phase={phase}
      aria-label={t('downloadToLocal')}
      title={failure === undefined ? t('downloadToLocal') : `${t('downloadToLocal')} — ${failure}`}
      onClick={() => {
        void onClick()
      }}
    >
      {label}
    </button>
  )
}

/** Props the delivered-file card entry receives. */
export interface DeliverableDownloadProps
  extends PropsRuntime<'deliverables.file.actions'>, PropsLocale<typeof NS> {
  /** Bound by this plugin's registration: the relayed read+save capability. */
  saveFile: SaveRemoteFile
}

/**
 * The deliverable card entry. Renders nothing on a local session.
 * @param props - the card slot's owner props plus the injected save
 * capability and copy.
 * @returns the save button, or null.
 */
export function DeliverableDownload({ sessionId, t, saveFile }: DeliverableDownloadProps) {
  if (!isVirtual(sessionId)) return null
  return <DownloadButton sessionId={sessionId} t={t} saveFile={saveFile} />
}

/** Props the document-preview header entry receives. */
export interface DocumentDownloadProps
  extends PropsRuntime<'sidebar.right.tab.document.actions'>, PropsLocale<typeof NS> {
  /** Bound by this plugin's registration: the relayed read+save capability. */
  saveFile: SaveRemoteFile
}

/**
 * The document preview header entry. Renders nothing on a local session.
 * @param props - the document slot's owner props plus the injected save
 * capability and copy.
 * @returns the save button, or null.
 */
export function DocumentDownload({ sessionId, t, saveFile, absolutePath }: DocumentDownloadProps) {
  if (!isVirtual(sessionId)) return null
  return <DownloadButton sessionId={sessionId} t={t} saveFile={saveFile} absolutePath={absolutePath} />
}
