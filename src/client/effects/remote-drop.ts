import type { ClientContext } from '../compat/types.ts'
import { decideRemoteDrop, decideRemoteIntake, isRemoteSessionId, rewrapFiles } from '../../client-data/remote-drop.ts'
import type { RemoteDropItemDescriptor, RemoteIntakeDescriptor } from '../../client-data/remote-drop.ts'
import { CURRENT_SESSION_STORAGE_KEY, parseCurrentSessionStorage } from '../../client-data/current-session.ts'
import { en, zh } from '../locales.ts'

/**
 * The remote attachment-entry guard (RD-2 + AU-2): document-level CAPTURE-phase
 * listeners on the three entries a desktop file reaches the composer through —
 * the `drop` event, the composer's hidden picker (`change` on the unlabelled
 * `<input type=file multiple hidden>`), and the editor's `paste` — that
 * re-shape each intake landing in a remote session before the host's own
 * handlers see it.
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
 * Gates (all three must pass, decided by RD-1's pure functions): the event
 * is trusted (our redispatch is untrusted — that alone makes the guard
 * loop-free), the Electron bridge exists (phone / plain-browser hosts are
 * already on the upload branch — the mount's capability check declines, so
 * no listener exists at all there), and the current session (`dsh.sessions.
 * current`, read fresh at event time) is a `zr~` virtual id. A missing
 * signal counts as a local session — the conservative direction: the only
 * misfire a stale signal can cause is uploading bytes for a local intake,
 * never losing one. The two NEW entries (picker / paste) additionally
 * intervene only on the zero-copy bad branch — a file that CARRIES a disk
 * path and is NOT an image; pathless and image files already upload bytes
 * and pass through untouched (issue #49: only that branch breaks remotely).
 * Counting is per-entry too: the two NEW entries check the remote gate
 * BEFORE counting, so everyday local picker/paste traffic never shows up in
 * the diagnostics; the drop entry keeps its 2.2.6 behavior, where a local
 * file drop still records one passthrough.
 *
 * Degrades to not-installed when DragEvent / DataTransfer construction is
 * unavailable — back to exactly today's behavior (RD-4's interface.md
 * documents this). Diagnostic counters for the settings-page diagnostics
 * block are exported via {@link remoteDropDiagnostics}.
 */

interface StorageLike {
  getItem(key: string): string | null
}

/** Which entry a counted event came through. */
type IntakeEntry = 'drop' | 'picker' | 'paste'

export interface RemoteDropEntryCounts {
  drop: number
  picker: number
  paste: number
}

export interface RemoteDropDiagnostics {
  /** The listeners are mounted and armed (capability check passed, effect
   * not yet disposed). */
  installed: boolean
  /** Why the capability check declined to install; `undefined` while
   * installed (and after a dispose, which keeps the counters readable). */
  notInstalledReason: string | undefined
  /** Intakes this guard stopped from reaching the host (both the blocked and
   * the redirected kind) — the sum of the three entries below. */
  intercepted: number
  /** Synthetic path-stripped drops actually dispatched (= redirected sum). */
  redispatched: number
  /** Intakes stopped because they carried a folder (toast shown, nothing
   * dispatched) (= blocked sum). */
  blockedDirectories: number
  /** Intakes judged not-ours and released untouched (= passthrough sum). */
  passthrough: number
  /** Redispatches aborted because a re-wrap or a DataTransfer add threw —
   * the original event was released instead (宁坏勿丢). */
  rewrapFailed: number
  /** The same four counters split by entry (AU-2); the scalars above are
   * their sums, so existing readers keep working unchanged. */
  interceptedBy: RemoteDropEntryCounts
  redirectedBy: RemoteDropEntryCounts
  blockedBy: RemoteDropEntryCounts
  passthroughBy: RemoteDropEntryCounts
}

/** Module-level singleton: the bundle has one document, so one guard state.
 * Re-mounting (a plugin row reload) resets it. */
let diagnostics: RemoteDropDiagnostics = freshDiagnostics()

function freshDiagnostics(): RemoteDropDiagnostics {
  return {
    installed: false,
    notInstalledReason: undefined,
    intercepted: 0,
    redispatched: 0,
    blockedDirectories: 0,
    passthrough: 0,
    rewrapFailed: 0,
    interceptedBy: { drop: 0, picker: 0, paste: 0 },
    redirectedBy: { drop: 0, picker: 0, paste: 0 },
    blockedBy: { drop: 0, picker: 0, paste: 0 },
    passthroughBy: { drop: 0, picker: 0, paste: 0 },
  }
}

/** A snapshot for the diagnostics carriers (settings page). Copying keeps
 * callers from holding a live reference into a later mount's state — the
 * per-entry objects are copied too, or a caller would keep counting. */
export function remoteDropDiagnostics(): RemoteDropDiagnostics {
  return {
    ...diagnostics,
    interceptedBy: { ...diagnostics.interceptedBy },
    redirectedBy: { ...diagnostics.redirectedBy },
    blockedBy: { ...diagnostics.blockedBy },
    passthroughBy: { ...diagnostics.passthroughBy },
  }
}

function bump(counts: RemoteDropEntryCounts, entry: IntakeEntry): void {
  counts[entry] += 1
}

/** The contextBridge global's existence only — never touched otherwise
 * (it is deep-frozen and must stay unwrapped). */
function hostPathsOf(): unknown {
  return (globalThis as { __DSH_HOST_PATHS__?: unknown }).__DSH_HOST_PATHS__
}

/** The bridge's `pathFor` — the preload's `webUtils.getPathForFile`. A
 * non-empty string means the File still carries its disk path, the exact
 * fact the host's zero-copy branch keys on. Anything else (bridge shape,
 * non-string answer, a throw) reads as "no path" — the conservative
 * direction: the file is treated as already byte-uploading and stays
 * untouched. */
function bridgePathFor(bridge: unknown, file: File): string {
  if (bridge === null || typeof bridge !== 'object') return ''
  const pathFor = (bridge as { pathFor?: unknown }).pathFor
  if (typeof pathFor !== 'function') return ''
  try {
    const result = (pathFor as (file: File) => unknown).call(bridge, file)
    return typeof result === 'string' ? result : ''
  } catch {
    return ''
  }
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

/** Build the redispatch payload WITHOUT touching any event: re-wrap the files
 * (path-stripped) and pack them into a fresh DataTransfer. `undefined` means
 * the file list was empty (nothing to dispatch — the caller passes through);
 * a throw means a re-wrap or an items.add failed (0-byte / exotic File) and
 * the caller releases the original event untouched (宁坏勿丢). Shared by all
 * three entries — the payload shape is the redispatch contract, and the
 * drop entry's behavior is frozen by its existing tests. */
function buildDropPayload(files: readonly File[]): DataTransfer | undefined {
  const rewrapped = rewrapFiles(files)
  if (rewrapped.length === 0) return undefined
  const payload = new DataTransfer()
  for (const file of rewrapped) payload.items.add(file)
  return payload
}

/** Dispatch the host-shaped synthetic drop on document, bubble phase — the
 * host's own drop handler (mask reset, busy rejection, addFiles) digests it;
 * our capture listener skips it via the isTrusted gate. */
function dispatchSyntheticDrop(payload: DataTransfer): void {
  document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: payload }))
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
        bump(diagnostics.passthroughBy, 'drop')
        return
      }
      if (decision.action === 'block-directories') {
        // A folder cannot be fixed by single-file upload: stop the whole
        // drop, say so, nothing is dispatched.
        event.preventDefault()
        event.stopPropagation()
        dismissHostDropOverlay()
        diagnostics.intercepted += 1
        bump(diagnostics.interceptedBy, 'drop')
        diagnostics.blockedDirectories += 1
        bump(diagnostics.blockedBy, 'drop')
        showToast()
        return
      }
      // redispatch: build the ENTIRE payload before stopping the original
      // event — any failure below releases the original untouched, so the
      // host still receives today's (path-chip) behavior instead of
      // nothing at all.
      try {
        const payload = buildDropPayload(Array.from(transfer.files))
        if (payload === undefined) {
          diagnostics.passthrough += 1
          bump(diagnostics.passthroughBy, 'drop')
          return
        }
        event.preventDefault()
        event.stopPropagation()
        diagnostics.intercepted += 1
        bump(diagnostics.interceptedBy, 'drop')
        // The host's drop handler sits on document, bubble phase (F4): a
        // bubbling synthetic drop on document reaches it. Its own handler
        // does the preventDefault / mask reset / addFiles work; our capture
        // listener skips this event via the isTrusted gate above.
        dispatchSyntheticDrop(payload)
        diagnostics.redispatched += 1
        bump(diagnostics.redirectedBy, 'drop')
      } catch {
        // A re-wrap or a single items.add threw (0-byte / exotic File):
        // count it and let the original event flow — 宁坏勿丢.
        diagnostics.rewrapFailed += 1
      }
    }
    document.addEventListener('drop', onDrop, true)

    // --- the picker entry (AU-2): the composer's hidden file selector -------
    // F1: the host composer's picker is an `input[type=file][multiple][hidden]`
    // with NO accept attribute, and its React onChange feeds intakeFiles →
    // addFiles — the same zero-copy branch the drop entry guards. Judged by
    // STRUCTURE, never by class names (hash classes cannot be anchored): an
    // input with an accept attribute (import / restore pickers), a visible
    // one, or a `webkitdirectory` folder picker (a third-party composition
    // could combine all four) is somebody else's and passes through. The
    // host composer has none of those, so the hit is unchanged.
    const onChange = (event: Event): void => {
      if (!event.isTrusted) return
      const input = event.target
      if (!(input instanceof HTMLInputElement)) return
      if (input.type !== 'file' || !input.multiple || !input.hidden || input.hasAttribute('accept') || input.webkitdirectory) return
      const files = Array.from(input.files ?? [])
      if (files.length === 0) return
      // The remote gate first, BEFORE counting: a local session's everyday
      // picker use must not show up in the diagnostics at all (the counters
      // are a record of what the guard saw in remote sessions).
      if (!isRemoteSessionId(readCurrentSessionId())) return
      const bridge = hostPathsOf()
      const items: RemoteIntakeDescriptor[] = files.map((file) => ({
        entry: 'picker',
        // A picker yields plain files; directories are structurally
        // impossible, so the block-directories branch is unreachable here
        // (defensive passthrough below).
        isDirectory: false,
        hasPath: bridgePathFor(bridge, file) !== '',
        isImage: file.type.startsWith('image/'),
      }))
      const decision = decideRemoteIntake({
        hasHostPaths: bridge !== undefined,
        currentSessionId: readCurrentSessionId(),
        trusted: event.isTrusted,
        items,
      })
      if (decision.action !== 'redirect') {
        // passthrough, or the defensive block branch that cannot happen for
        // a picker — either way zero intervention.
        diagnostics.passthrough += 1
        bump(diagnostics.passthroughBy, 'picker')
        return
      }
      // Build the payload BEFORE stopping the event (宁坏勿丢): a re-wrap
      // failure releases the change untouched — the host keeps today's
      // (path-chip) behavior instead of losing the pick entirely.
      try {
        const payload = buildDropPayload(files)
        if (payload === undefined) {
          diagnostics.passthrough += 1
          bump(diagnostics.passthroughBy, 'picker')
          return
        }
        // stopPropagation keeps the event from reaching React's delegated
        // onChange at the root container (F5); clearing the value lets the
        // SAME file trigger a later change again (the host's own onPickFiles
        // habit, applied here since the host's handler no longer runs).
        event.stopPropagation()
        input.value = ''
        diagnostics.intercepted += 1
        bump(diagnostics.interceptedBy, 'picker')
        dispatchSyntheticDrop(payload)
        diagnostics.redispatched += 1
        bump(diagnostics.redirectedBy, 'picker')
      } catch {
        diagnostics.rewrapFailed += 1
      }
    }
    document.addEventListener('change', onChange, true)

    // --- the paste entry (AU-2): the editor's clipboard files ---------------
    // F2: the composer editor (a contenteditable root) reads file items off
    // clipboardData; a path-carrying non-image lands on the same zero-copy
    // branch. Pasting into any other target (settings fields, search) is not
    // ours. clipboardData is read-only, so a redirect can only re-dispatch
    // — preventDefault keeps the editor from inserting anything.
    const onPaste = (event: ClipboardEvent): void => {
      if (!event.isTrusted) return
      const transfer = event.clipboardData
      if (transfer === null) return
      const firstElement = event.composedPath().find((node): node is Element => node instanceof Element)
      if (firstElement === undefined || firstElement.closest('[contenteditable="true"]') === null) return
      // The remote gate BEFORE any per-item work (same rationale as picker):
      // a local session's paste — including pasted FILES — returns here, so
      // it never runs bridgePathFor per file and never reaches the counters.
      // Everything after this point still runs inside this one synchronous
      // handler, within the dispatch lifetime clipboardData requires.
      if (!isRemoteSessionId(readCurrentSessionId())) return
      const bridge = hostPathsOf()
      const files: File[] = []
      const items: RemoteIntakeDescriptor[] = []
      for (const item of Array.from(transfer.items)) {
        if (item.kind !== 'file') continue
        const file = item.getAsFile()
        if (file === null) continue
        // Directory detection with the host's own default: no entry API
        // reads as "not a directory". Items without a File behind them never
        // reach the descriptors, so a plain-text paste arrives as an empty
        // list — the pure no-files passthrough.
        const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
        files.push(file)
        items.push({
          entry: 'paste',
          isDirectory: entry?.isDirectory === true,
          hasPath: bridgePathFor(bridge, file) !== '',
          isImage: file.type.startsWith('image/'),
        })
      }
      const decision = decideRemoteIntake({
        hasHostPaths: bridge !== undefined,
        currentSessionId: readCurrentSessionId(),
        trusted: event.isTrusted,
        items,
      })
      if (decision.action === 'block-directories') {
        // A folder paste cannot be fixed by single-file upload: same toast
        // semantics as the drop branch (no overlay to dismiss — paste never
        // opened one).
        event.preventDefault()
        event.stopPropagation()
        diagnostics.intercepted += 1
        bump(diagnostics.interceptedBy, 'paste')
        diagnostics.blockedDirectories += 1
        bump(diagnostics.blockedBy, 'paste')
        showToast()
        return
      }
      if (decision.action !== 'redirect') {
        diagnostics.passthrough += 1
        bump(diagnostics.passthroughBy, 'paste')
        return
      }
      try {
        const payload = buildDropPayload(files)
        if (payload === undefined) {
          diagnostics.passthrough += 1
          bump(diagnostics.passthroughBy, 'paste')
          return
        }
        event.preventDefault()
        event.stopPropagation()
        diagnostics.intercepted += 1
        bump(diagnostics.interceptedBy, 'paste')
        dispatchSyntheticDrop(payload)
        diagnostics.redispatched += 1
        bump(diagnostics.redirectedBy, 'paste')
      } catch {
        diagnostics.rewrapFailed += 1
      }
    }
    document.addEventListener('paste', onPaste, true)

    return () => {
      document.removeEventListener('drop', onDrop, true)
      document.removeEventListener('change', onChange, true)
      document.removeEventListener('paste', onPaste, true)
      removeToast()
      // Keep the counters readable after a dispose (the settings page may
      // still be open mid-reload); `installed` is the armed flag only.
      diagnostics.installed = false
    }
  }, 'dsh-zen-remote: remote drop guard')
}
