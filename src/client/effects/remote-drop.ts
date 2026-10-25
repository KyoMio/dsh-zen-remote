import type { ClientContext } from '../compat/types.ts'
import { decideRemoteDrop, rewrapFiles } from '../../client-data/remote-drop.ts'
import type { RemoteDropItemDescriptor } from '../../client-data/remote-drop.ts'
import { CURRENT_SESSION_STORAGE_KEY, parseCurrentSessionStorage } from '../../client-data/current-session.ts'
import { en, zh } from '../locales.ts'

/**
 * The remote-session drop guard (RD-2): a document-level CAPTURE-phase drop
 * listener that re-shapes file drops landing in a remote session before the
 * host's own (bubble-phase, F4) handler sees them.
 *
 * The desktop app's zero-copy fast path is the problem: a File dragged from
 * the OS keeps its disk path, the host turns it into an `@/absolute/path`
 * mention chip without uploading bytes, and in a remote session that path
 * names a file on THIS machine — the server-side session can never read it.
 * The bridge global (`__DSH_HOST_PATHS__`) is contextBridge-exposed and
 * deep-frozen, so it cannot be wrapped; instead the drop event itself is
 * re-shaped: each File is re-wrapped (path-stripped, RD-1) into a fresh
 * DataTransfer and redispatched as a synthetic DragEvent. The host's own
 * pipeline then classifies it as a browser drag — the byte-upload branch —
 * which the T51 fetch-route interception relays to the server. Mask
 * cleanup, busy rejection, directory detection and the addFiles branch all
 * stay the host's own code; nothing downstream is reimplemented here.
 *
 * Gates (all three must pass, decided by RD-1's pure function): the event
 * is trusted (our redispatch is untrusted — that alone makes the guard
 * loop-free), the Electron bridge exists (phone / plain-browser hosts are
 * already on the upload branch), and the current session (`dsh.sessions.
 * current`, read fresh at event time) is a `zr~` virtual id. A missing
 * signal counts as a local session — the conservative direction: the only
 * misfire a stale signal can cause is uploading bytes for a local drop,
 * never losing one.
 *
 * Degrades to not-installed when DragEvent / DataTransfer construction is
 * unavailable — back to exactly today's behavior (RD-4's interface.md
 * documents this). Diagnostic counters for the settings-page diagnostics
 * block are exported via {@link remoteDropDiagnostics}.
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
   * the redispatched kind). */
  intercepted: number
  /** Synthetic path-stripped drops actually dispatched. */
  redispatched: number
  /** Drops stopped because they carried a folder (toast shown, nothing
   * dispatched). */
  blockedDirectories: number
  /** Drops judged not-ours and released untouched. */
  passthrough: number
  /** Redispatches aborted because a re-wrap or a DataTransfer add threw —
   * the original event was released instead (宁坏勿丢). */
  rewrapFailed: number
}

/** Module-level singleton: the bundle has one document, so one guard state.
 * Re-mounting (a plugin row reload) resets it. */
let diagnostics: RemoteDropDiagnostics = freshDiagnostics()

function freshDiagnostics(): RemoteDropDiagnostics {
  return { installed: false, notInstalledReason: undefined, intercepted: 0, redispatched: 0, blockedDirectories: 0, passthrough: 0, rewrapFailed: 0 }
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

/** The toast copy in the page's language (the plugin's namespace carries
 * both dictionaries; the framework `t` seat is not reachable from a
 * non-React effect — same pick as the bridge note). */
function toastText(language: string | undefined): string {
  const key = 'remoteDropFolderBlocked' as const
  return typeof language === 'string' && language.startsWith('zh') ? zh[key] : en[key]
}

/** Take the host's「拖拽文件到此处添加」drop overlay back down after this
 * guard has stopped a drop outright. The overlay's own state machine
 * (`dsh-client-ui-attachment` drop-events.ts) closes on the reset() inside
 * its DOCUMENT-level bubble `drop` handler — which this guard's capture
 * stopPropagation deliberately prevents from running — or on `dragend` at
 * `window` level, a channel it reads without isTrust-checking. An OS-file
 * drag never delivers a native dragend (the drag source is the OS, not a
 * page element), so a branch that eats the drop must fire a synthetic one
 * itself or the overlay stays up forever. Only the folder-block branch
 * calls this: the redispatch branch's synthetic drop reaches the host's
 * bubble handler, whose own reset brings the overlay down. */
function dismissHostDropOverlay(): void {
  try {
    window.dispatchEvent(new Event('dragend'))
  } catch {
    // No window / Event in this host: the overlay is the only casualty.
  }
}

export function mountRemoteDropGuard(ctx: ClientContext): void {
  ctx.effect(() => {
    // Fresh state per mount: a plugin reload re-runs apply() and must not
    // inherit the previous mount's counters or installed flag.
    diagnostics = freshDiagnostics()

    // Capability self-check — anything missing means "not installed",
    // back to today's behavior. Counted, not thrown: the diagnostics
    // block explains why the guard is absent.
    if (typeof DragEvent !== 'function') {
      diagnostics.notInstalledReason = 'drag-event-unavailable'
      return () => {}
    }
    try {
      new DataTransfer()
    } catch {
      diagnostics.notInstalledReason = 'datatransfer-unavailable'
      return () => {}
    }
    if (hostPathsOf() === undefined) {
      // Phone / plain-browser hosts: the bridge is absent and the host is
      // already on the byte-upload branch — nothing to fix here.
      diagnostics.notInstalledReason = 'host-paths-unavailable'
      return () => {}
    }
    diagnostics.installed = true

    // --- toast (folder-blocked notice), inline styles per the CSS split ---
    let toast: HTMLDivElement | undefined
    let toastTimer: ReturnType<typeof setTimeout> | undefined
    const removeToast = (): void => {
      if (toastTimer !== undefined) clearTimeout(toastTimer)
      toastTimer = undefined
      toast?.remove()
      toast = undefined
    }
    const showToast = (): void => {
      // Restart the window on rapid re-drops rather than stacking toasts.
      removeToast()
      const el = document.createElement('div')
      el.dataset.zenRemote = 'remote-drop-toast'
      el.textContent = toastText(navigator.language)
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

    const onDrop = (event: DragEvent): void => {
      // Self-reentry guard first: the redispatched event is untrusted, and
      // this capture listener would otherwise see it again.
      if (!event.isTrusted) return
      const transfer = event.dataTransfer
      if (transfer === null || !transfer.types.includes('Files')) return
      // Not a file drag: the host's own Files-in-types gate ignores the
      // drop anyway — not a candidate, not counted.
      const decision = decideRemoteDrop({
        hasHostPaths: hostPathsOf() !== undefined,
        currentSessionId: readCurrentSessionId(),
        trusted: event.isTrusted,
        items: collectItems(transfer),
      })
      if (decision.action === 'passthrough') {
        diagnostics.passthrough += 1
        return
      }
      if (decision.action === 'block-directories') {
        // A folder cannot be fixed by single-file upload: stop the whole
        // drop, say so, nothing is dispatched.
        event.preventDefault()
        event.stopPropagation()
        dismissHostDropOverlay()
        diagnostics.intercepted += 1
        diagnostics.blockedDirectories += 1
        showToast()
        return
      }
      // redispatch: build the ENTIRE payload before stopping the original
      // event — any failure below releases the original untouched, so the
      // host still receives today's (path-chip) behavior instead of
      // nothing at all.
      try {
        const rewrapped = rewrapFiles(Array.from(transfer.files))
        if (rewrapped.length === 0) {
          diagnostics.passthrough += 1
          return
        }
        const payload = new DataTransfer()
        for (const file of rewrapped) payload.items.add(file)
        event.preventDefault()
        event.stopPropagation()
        diagnostics.intercepted += 1
        // The host's drop handler sits on document, bubble phase (F4): a
        // bubbling synthetic drop on document reaches it. Its own handler
        // does the preventDefault / mask reset / addFiles work; our capture
        // listener skips this event via the isTrusted gate above.
        document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: payload }))
        diagnostics.redispatched += 1
      } catch {
        // A re-wrap or a single items.add threw (0-byte / exotic File):
        // count it and let the original event flow — 宁坏勿丢.
        diagnostics.rewrapFailed += 1
      }
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
