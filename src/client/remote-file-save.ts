/**
 * Saving one workspace file onto THIS machine (2.2.6, remote artifact
 * download).
 *
 * DSH has no download surface at all: a produced file's card only PREVIEWS it
 * through the document preview (`workspaceFiles/readBytes`), and the
 * native-open controls (`present.open`, `changes.open`,
 * `open-in-app`) act on the machine the DSH process runs on — which is why
 * the remote-session stylesheet hides them. So on a paired desktop
 * sub-client, a file the HOST produced in its workspace had no way to reach
 * the client's disk. This module is the missing read+save half:
 *
 * - bytes come from the SAME relayed `workspaceFiles/readBytes` the preview
 *   already uses (relay-access.ts registers the method; invoke-binary.ts
 *   carries its `data` Uint8Array across the JSON channel),
 * - they come in byte windows because the host's read window is capped
 *   (`dsh-api-workspace-files` Config.maxBytes, 2 MiB by default): a full
 *   read without a range is capped separately at `maxFileBytes` (32 MiB), so
 *   ranged reads are the only shape that works for ANY produced file. A
 *   `workspace-file/too-large` refusal carries the host's own limit in
 *   `details.limit`, so the window adapts down instead of failing,
 * - the assembled bytes become a Blob and a synthetic `<a download>` click,
 *   the one save path a browser/webview gives a page without asking the
 *   desktop shell for a native dialog.
 *
 * The pure half (`collectRemoteFile`, `downloadFileNameOf`) takes an injected
 * reader and is driven directly by test/remote-file-save.test.cjs — no DOM,
 * no DSH imports.
 */
import type { ClientContext, SessionId } from './compat/types.ts'

/** The byte window one relayed read asks for. Matches the host default
 * (`Config.maxBytes` 2 MiB) exactly: one round trip per window, and a host
 * configured smaller self-corrects through the too-large branch below. */
export const DOWNLOAD_CHUNK_BYTES = 2 * 1024 * 1024

/** A hard ceiling on windows per file (4 GiB at the default size) — the
 * guard against a reader that never advances (a host ignoring `range` and
 * answering the same bytes forever) hanging the button in `busy`. */
const MAX_DOWNLOAD_CHUNKS = 2048

/** One byte window's answer, as the client Remote face delivers it. Only the
 * fields this module reads are mirrored. */
export type RemoteByteWindow =
  | { ok: true; value: { data: Uint8Array; eof: boolean } }
  | { ok: false; error: { code?: string; details?: { limit?: number } } }

/** One ranged read bound to (session, path); the caller owns the closure. */
export type RemoteByteRead = (range: { offset: number; length: number }) => Promise<RemoteByteWindow>

/**
 * The last path segment, as the browser download name. Slash- and
 * backslash-separated paths both occur (the host may be Windows); an empty
 * tail falls back to a fixed name so `download` is never blank.
 * @param path - the file's absolute path on the host.
 * @returns the name to save under.
 */
export function downloadFileNameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = (cut === -1 ? path : path.slice(cut + 1)).trim()
  return name === '' ? 'download' : name
}

/** The three DOM reads {@link downloadPathFromCard} performs — structural so
 * tests can pass fake nodes (a real Element satisfies it). */
export interface DownloadCardNode {
  closest(selector: string): DownloadCardNode | null
  querySelector(selector: string): DownloadCardNode | null
  getAttribute(name: string): string | null
}

/**
 * The file path a produced-file card carries, read off the host's own
 * rendered contract: the card root is `[data-presented-file]`, and its
 * preview button's `title` is the resolved workspace path (RT
 * dsh-client-ui-deliverables PresentedFileCard: `title:
 * resolveWorkspacePath(cwd, file.path)`). The action button mounts inside
 * that card, so `closest` picks THIS card, never a neighbouring one.
 * @param button - the download action's own DOM node.
 * @returns the path, or undefined when the card shape is not there (a future
 * host): the caller then reports failure instead of guessing a path.
 */
export function downloadPathFromCard(button: DownloadCardNode | null): string | undefined {
  const card = button?.closest('[data-presented-file]')
  if (card === null || card === undefined) return undefined
  // Prefer the DIRECT child: the card's preview overlay is the first child
  // button, while this action (and open-in-app's control) live deeper in the
  // actions cell — and this action carries a `title` of its own, so a broad
  // `querySelector('button[title]')` could match ITSELF on a host whose card
  // markup differs. `:scope` narrows the match to the card's own children.
  let preview: DownloadCardNode | null = null
  try {
    preview = card.querySelector(':scope > button[title]')
  } catch {
    preview = null
  }
  preview ??= card.querySelector('button[title]')
  const title = preview?.getAttribute('title')?.trim()
  return title === undefined || title === '' ? undefined : title
}

/**
 * Read one file window by window and return its complete bytes.
 *
 * The window starts at `chunkBytes` and adapts DOWN when the host refuses a
 * window as too large (`workspace-file/too-large` + `details.limit`), so a
 * host configured below the default still completes. The loop ends at the
 * host's own `eof` flag, or on an empty window (never spin on a server that
 * reports neither).
 * @param read - one ranged read, already bound to the session and path.
 * @param chunkBytes - the first window size; tests inject a small one.
 * @returns the complete file bytes, in one buffer.
 * @throws when a read is refused (the code rides the message) or the reader
 * keeps advancing past {@link MAX_DOWNLOAD_CHUNKS} windows.
 */
export async function collectRemoteFile(
  read: RemoteByteRead,
  chunkBytes = DOWNLOAD_CHUNK_BYTES,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let offset = 0
  let size = Math.max(1, Math.floor(chunkBytes))
  for (;;) {
    if (chunks.length >= MAX_DOWNLOAD_CHUNKS) throw new Error('workspace-file/too-many-chunks')
    const result = await read({ offset, length: size })
    if (!result.ok) {
      const limit = result.error.details?.limit
      if (
        result.error.code === 'workspace-file/too-large' &&
        typeof limit === 'number' &&
        Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit < size
      ) {
        // The host's own window cap is below ours: take its number and retry
        // the SAME offset — nothing was read.
        size = limit
        continue
      }
      throw new Error(result.error.code === undefined ? 'workspace-file/read-failed' : result.error.code)
    }
    const data = result.value.data
    chunks.push(data)
    offset += data.byteLength
    if (result.value.eof || data.byteLength === 0) break
  }
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/** Save one file from a remote session to this machine. */
export type SaveRemoteFile = (sessionId: SessionId, path: string) => Promise<void>

/** The slice of the client `remote` service this module needs (the real one
 * carries the whole workspaceFiles namespace; only readBytes is used). */
interface RemoteFilesFace {
  readBytes(
    sessionId: SessionId,
    path: string,
    options: { range?: { offset: number; length: number } },
    signal?: AbortSignal,
  ): Promise<RemoteByteWindow>
}

/** Hand a finished byte array to the browser's download machinery. */
function saveBytes(data: Uint8Array, fileName: string): void {
  // `new Uint8Array(length)` always owns a plain ArrayBuffer; the cast only
  // satisfies the BlobPart union in DOM typings that predate generic views.
  const blob = new Blob([data as unknown as BlobPart], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = downloadFileNameOf(fileName)
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 60_000)
}

/**
 * Bind the save capability the download buttons share to the client context.
 *
 * The `remote.workspaceFiles` service is looked up at CLICK time, not at
 * registration time: a host without the service (an older DSH) must not
 * break the plugin's apply, and the buttons only ever mount for a virtual
 * session — where the service exists by construction.
 * @param ctx - client root context.
 * @returns the save function the injected `saveFile` prop carries.
 */
export function createSaveRemoteFile(ctx: ClientContext): SaveRemoteFile {
  return async (sessionId, path) => {
    // The namespace is BOTH a service of its own (`remote.workspaceFiles`) and
    // reachable through the `remote` service's namespace proxy; ask for the
    // exact service first and fall back to the proxy, so a composition that
    // only provides one of the two still works.
    const direct = ctx.get('remote.workspaceFiles') as RemoteFilesFace | undefined
    const remote = ctx.get('remote') as { workspaceFiles?: RemoteFilesFace } | undefined
    const files = direct ?? remote?.workspaceFiles
    if (files === undefined) throw new Error('remote-unavailable')
    let data: Uint8Array
    try {
      data = await collectRemoteFile((range) => files.readBytes(sessionId, path, { range }, undefined))
    } catch (error) {
      throw new Error(`read: ${describeError(error)}`, { cause: error })
    }
    try {
      saveBytes(data, path)
    } catch (error) {
      throw new Error(`save: ${describeError(error)}`, { cause: error })
    }
  }
}

/** A short, user-visible reason: an error's message (the relay's failures
 * carry their code as the message), else the thrown value's text. Kept short
 * because it is rendered INSIDE the card's button. */
function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const trimmed = text.trim()
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed === '' ? 'unknown' : trimmed
}
