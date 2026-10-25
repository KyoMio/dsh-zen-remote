import type { ClientContext } from '../compat/types.ts'
import { decideRemoteDrop } from '../../client-data/remote-drop.ts'
import type { RemoteDropItemDescriptor } from '../../client-data/remote-drop.ts'
import { DROP_MENTION_EVENT, WORKSPACE_UPLOAD_ROUTE } from '../../remote-drop-contract.ts'
import { CURRENT_SESSION_STORAGE_KEY, parseCurrentSessionStorage } from '../../client-data/current-session.ts'
import { en, zh } from '../locales.ts'

/**
 * The remote-session drop guard (RD-2, reworked in RD-7): a document-level
 * CAPTURE-phase drop listener that intercepts file drops landing in a remote
 * session before the host's own (bubble-phase, F4) handler sees them.
 *
 * The desktop app's zero-copy fast path is the problem: a File dragged from
 * the OS keeps its disk path, the host turns it into an `@/absolute/path`
 * mention chip without uploading bytes, and in a remote session that path
 * names a file on THIS machine — the server-side session can never read it.
 *
 * Why the guard cannot hand the drop back to the host's own upload pipeline
 * (the RD-2..4 synthetic-DragEvent redispatch, REMOVED): the official
 * composer's file upload runs a native XHR inside a Web Worker — straight
 * to the host route, never through `connection.fetchRoutes`, the table the
 * T51 interception wraps (2026-10-24 empirical, rc.3 source). No re-shaping
 * of a DragEvent can route those bytes through this plugin on the desktop
 * app. The guard therefore uploads the files ITSELF: one POST per file to
 * this plugin's `client/workspace-upload` route (same-origin, so the
 * pairing cookie rides along), which relays the bytes to the SERVER
 * session's workspace `.dsh-uploads/` and answers the receipt; each
 * receipt's relPath travels a `zr:drop-mention` CustomEvent to the
 * invisible composer-slot listener (DropMentionListener.tsx), which inserts
 * the `@.dsh-uploads/<name>` mention through the official write path.
 *
 * Gates (all three must pass, decided by RD-1's pure function): the event
 * is trusted, the Electron bridge exists (phone / plain-browser hosts are
 * already on the upload branch), and the current session (`dsh.sessions.
 * current`, read fresh at event time) is a `zr~` virtual id. A missing
 * signal counts as a local session — the conservative direction: the only
 * misfire a stale signal can cause is uploading bytes for a local drop,
 * never losing one.
 *
 * The original event is stopped only after the upload parameters are fully
 * built — building cannot fail (Files and strings), and once stopped there
 * is no host pipeline to fall back to. Upload failures are expressed with a
 * toast, never by releasing the event. Dragging a FOLDER is still blocked
 * whole (a folder cannot be fixed by single-file upload). Diagnostic
 * counters for the settings-page diagnostics block are exported via
 * {@link remoteDropDiagnostics}.
 */

interface StorageLike {
  getItem(key: string): string | null
}

export interface RemoteDropDiagnostics {
  /** The listener is mounted and armed (capability check passed, effect
   * not yet disposed). */
  installed: boolean
  /** Why the capability check declined to install; `undefined` while
   * installed (and after a dispose, which keeps the counters readable). */
  notInstalledReason: string | undefined
  /** Drops this guard stopped from reaching the host (both the blocked and
   * the uploaded kind). */
  intercepted: number
  /** Files that reached the server workspace and had their mention
   * dispatched. */
  uploaded: number
  /** Files whose upload failed (the toast carries the code; the event stays
   * stopped — there is no host pipeline to fall back to). */
  failed: number
  /** Drops stopped because they carried a folder (toast shown, nothing
   * uploaded). */
  blockedDirectories: number
  /** Drops judged not-ours and released untouched. */
  passthrough: number
}

/** Module-level singleton: the bundle has one document, so one guard state.
 * Re-mounting (a plugin row reload) resets it. */
let diagnostics: RemoteDropDiagnostics = freshDiagnostics()

function freshDiagnostics(): RemoteDropDiagnostics {
  return { installed: false, notInstalledReason: undefined, intercepted: 0, uploaded: 0, failed: 0, blockedDirectories: 0, passthrough: 0 }
}

/** A snapshot for the diagnostics carriers (settings page). Copying keeps
 * callers from holding a live reference into a later mount's state. */
export function remoteDropDiagnostics(): RemoteDropDiagnostics {
  return { ...diagnostics }
}

/** The contextBridge global's existence only — never touched otherwise
 * (it is deep-frozen and must stay unwrapped). */
function hostPathsOf(): unknown {
  return (globalThis as { __DSH_HOST_PATHS__?: unknown }).__DSH_HOST_PATHS__
}

/** The current-session signal, read AT EVENT TIME (the selection changes
 * while the page is open; a mount-time snapshot would go stale). Any
 * storage failure reads as "no signal" = local session = passthrough. */
function readCurrentSessionId(): string | undefined {
  let raw: string | null
  try {
    const storage = (globalThis as { localStorage?: StorageLike | null }).localStorage
    raw = storage === null || storage === undefined ? null : storage.getItem(CURRENT_SESSION_STORAGE_KEY)
  } catch {
    return undefined
  }
  const report = parseCurrentSessionStorage(raw)
  return report.kind === 'open' ? report.sessionId : undefined
}

/** Reduce the drop's items to RD-1's descriptors. `undefined` when the
 * entry API is missing entirely — directories cannot be detected, and the
 * host's own semantics treat that as "no directories". Directory entries
 * surface as file-kind items (their bytes are unreadable), which is what
 * the block-directories branch keys on. */
function collectItems(transfer: DataTransfer): RemoteDropItemDescriptor[] | undefined {
  const out: RemoteDropItemDescriptor[] = []
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== 'file') continue
    if (typeof item.webkitGetAsEntry !== 'function') return undefined
    const entry = item.webkitGetAsEntry()
    out.push({ kind: 'file', isDirectory: entry?.isDirectory === true })
  }
  return out
}

/**
 * Take the host's「拖拽文件到此处添加」drop overlay back down after the
 * guard has stopped a drop. The overlay's own state machine
 * (`dsh-client-ui-attachment` drop-events.ts) closes on the reset() inside
 * its DOCUMENT-level bubble `drop` handler — which this guard's capture
 * stopPropagation deliberately prevents from running — or on `dragend` at
 * `window` level, a channel it does not read the event object for and does
 * not isTrust-check. An OS-file drag never delivers a native dragend (the
 * drag source is the OS, not a page element), so after eating the drop the
 * guard fires that synthetic one itself: the overlay dismisses through the
 * host's own reset, exactly as if the drag had ended. Both intercept
 * branches (upload and folder-block) must call this the moment they stop
 * the event, or the overlay stays up forever.
 */
function dismissHostDropOverlay(): void {
  window.dispatchEvent(new Event('dragend'))
}

/** The toast copy in the page's language (the plugin's namespace carries
 * both dictionaries; the framework `t` seat is not reachable from a
 * non-React effect — same pick as the bridge note), with `{name}`-style
 * placeholders filled from `params`. */
type DropToastKey = 'remoteDropFolderBlocked' | 'remoteDropUploading' | 'remoteDropInserted' | 'remoteDropFailed'

function toastText(language: string | undefined, key: DropToastKey, params?: Record<string, string>): string {
  const template = typeof language === 'string' && language.startsWith('zh') ? zh[key] : en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => params[name] ?? whole)
}

/** One uploaded file's dispatch record. */
interface PendingUpload {
  file: File
  url: string
}

export function mountRemoteDropGuard(ctx: ClientContext): void {
  ctx.effect(() => {
    // Fresh state per mount: a plugin reload re-runs apply() and must not
    // inherit the previous mount's counters or installed flag.
    diagnostics = freshDiagnostics()

    // Capability self-check — anything missing means "not installed",
    // back to today's behavior. Counted, not thrown: the diagnostics
    // block explains why the guard is absent. (The desktop bridge is the
    // one gate: without it the host is already on the byte-upload branch
    // and a guard would only double-upload.)
    if (hostPathsOf() === undefined) {
      diagnostics.notInstalledReason = 'host-paths-unavailable'
      return () => {}
    }
    diagnostics.installed = true

    // --- toast, inline styles per the CSS split ---
    let toast: HTMLDivElement | undefined
    let toastTimer: ReturnType<typeof setTimeout> | undefined
    const removeToast = (): void => {
      if (toastTimer !== undefined) clearTimeout(toastTimer)
      toastTimer = undefined
      toast?.remove()
      toast = undefined
    }
    const showToast = (text: string): void => {
      // Restart the window on rapid re-drops rather than stacking toasts.
      removeToast()
      const el = document.createElement('div')
      el.dataset.zenRemote = 'remote-drop-toast'
      el.textContent = text
      el.style.cssText = [
        'position:fixed', 'left:50%', 'transform:translateX(-50%)',
        // Safe-area habit shared with the overlay effects: keep clear of the
        // home indicator, degrade to a plain 32px offset where env() is 0.
        'bottom:calc(env(safe-area-inset-bottom, 0px) + 32px)',
        'z-index:2147483000',
        'background:rgba(0,0,0,.82)', 'color:#fff',
        'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'padding:10px 16px', 'border-radius:10px', 'max-width:90vw', 'text-align:center',
        // Purely informational: never intercepts the taps under it.
        'pointer-events:none',
      ].join(';')
      document.body.appendChild(el)
      toast = el
      toastTimer = setTimeout(removeToast, 3000)
    }

    /** Upload the intercepted files one by one and speak the outcome in
     * toasts. Each success dispatches its `zr:drop-mention` immediately, so
     * a mid-batch failure still mentions the files that made it; the first
     * failure stops the loop and names its code. */
    const uploadAll = async (sessionId: string, uploads: PendingUpload[]): Promise<void> => {
      const lang = navigator.language
      showToast(toastText(lang, 'remoteDropUploading'))
      const inserted: string[] = []
      let failure: string | undefined
      for (const { file, url } of uploads) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            // Same-origin so the pairing cookie rides along (the attach
            // button's habit; also the fetch default, made explicit).
            credentials: 'same-origin',
            headers: { 'content-type': 'application/octet-stream' },
            body: file,
          })
          const body: unknown = await response.json().catch(() => undefined)
          const record = body !== null && typeof body === 'object' && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : {}
          const relPath = typeof record.relPath === 'string' ? record.relPath : undefined
          if (!response.ok || record.ok !== true || relPath === undefined) {
            const error = record.error !== null && typeof record.error === 'object' && !Array.isArray(record.error)
              ? (record.error as Record<string, unknown>)
              : {}
            failure = typeof error.code === 'string' && error.code !== '' ? error.code : `http-${response.status}`
            diagnostics.failed += 1
            break
          }
          diagnostics.uploaded += 1
          inserted.push(file.name)
          document.dispatchEvent(new CustomEvent(DROP_MENTION_EVENT, { detail: { sessionId, relPath } }))
        } catch {
          // Transport death (the sub-client backend unreachable): a code the
          // toast can name, like the status route's own vocabulary.
          failure = 'offline'
          diagnostics.failed += 1
          break
        }
      }
      if (failure !== undefined) showToast(toastText(lang, 'remoteDropFailed', { code: failure }))
      else if (inserted.length > 0) {
        showToast(toastText(lang, 'remoteDropInserted', { name: inserted.join(lang.startsWith('zh') ? '、' : ', ') }))
      }
    }

    const onDrop = (event: DragEvent): void => {
      // Self-reentry guard: only events the OS originated are ours to judge.
      if (!event.isTrusted) return
      const transfer = event.dataTransfer
      if (transfer === null || !transfer.types.includes('Files')) return
      // Not a file drag: the host's own Files-in-types gate ignores the
      // drop anyway — not a candidate, not counted.
      const currentSessionId = readCurrentSessionId()
      const decision = decideRemoteDrop({
        hasHostPaths: hostPathsOf() !== undefined,
        currentSessionId,
        trusted: event.isTrusted,
        items: collectItems(transfer),
      })
      if (decision.action === 'passthrough') {
        diagnostics.passthrough += 1
        return
      }
      if (decision.action === 'block-directories') {
        // A folder cannot be fixed by single-file upload: stop the whole
        // drop, say so, nothing is uploaded.
        event.preventDefault()
        event.stopPropagation()
        dismissHostDropOverlay()
        diagnostics.intercepted += 1
        diagnostics.blockedDirectories += 1
        showToast(toastText(navigator.language, 'remoteDropFolderBlocked'))
        return
      }
      // workspace-upload: build EVERYTHING before stopping the original
      // event. Building cannot fail (a File list and strings), so from here
      // the event stays stopped — 宁坏勿丢 no longer means releasing it,
      // because there is no host pipeline these bytes could fall back to;
      // an upload failure is a toast, not an un-eaten event.
      const sessionId = currentSessionId ?? ''
      const uploads: PendingUpload[] = Array.from(transfer.files).map((file) => ({
        file,
        url: `${WORKSPACE_UPLOAD_ROUTE}?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(file.name)}`,
      }))
      if (uploads.length === 0) {
        diagnostics.passthrough += 1
        return
      }
      event.preventDefault()
      event.stopPropagation()
      dismissHostDropOverlay()
      diagnostics.intercepted += 1
      void uploadAll(sessionId, uploads)
    }
    document.addEventListener('drop', onDrop, true)

    return () => {
      document.removeEventListener('drop', onDrop, true)
      removeToast()
      // Keep the counters readable after a dispose (the settings page may
      // still be open mid-reload); `installed` is the armed flag only.
      diagnostics.installed = false
    }
  }, 'dsh-zen-remote: remote drop guard')
}
