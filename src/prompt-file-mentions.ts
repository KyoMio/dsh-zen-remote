/**
 * Materialize client-local `@file` mentions into real attachments when a
 * prompt is forwarded to the relay server (2.2.8).
 *
 * WHY: DSH's composer prefers a path reference over an upload whenever the
 * desktop shell can name a dropped file's absolute path (RT
 * dsh-client-ui-conversation `addFiles`: `hostPathBridge().pathFor(file)` —
 * a non-empty path becomes `@<path>` text). Locally that is correct. In a
 * REMOTE session the path is on the machine showing the UI while the agent
 * runs on the server, so the prompt arrives as unreadable text
 * (`@C:\Users\me\Desktop\日志.txt`) and the model never sees the file. The
 * same happens when a user types or pastes such a path by hand.
 *
 * WHAT: before forwarding `session/prompt`, scan the text parts for `@`
 * mentions that are ABSOLUTE paths existing as files on THIS machine. For
 * each one the server does not already have (a relayed `workspaceFiles/stat`
 * probe), upload the bytes through the relay's binary channel — the host
 * stages a receipt exactly as it does for a normal attachment — and replace
 * the mention text with a `{type:'file', receiptId}` content block. The
 * model then receives the file itself.
 *
 * The mention grammar mirrors `@path` / `@"path with spaces"` (the form
 * dsh-file-reference writes). Only absolute paths are considered: relative
 * mentions are workspace-relative and already resolve on the server. Every
 * failure is non-fatal — the prompt forwards untouched.
 *
 * Pure decision helpers (`fileMentionsIn`, `isAbsolutePathMention`) are
 * exported for tests; `materializeLocalFileMentions` takes the relay face so
 * tests can drive it with fakes.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import type { RelayClient } from './relay-client.js'

/** One `@path` occurrence in a text part. */
export interface FileMention {
  /** Offset of the leading `@`. */
  start: number
  /** Offset just past the mention (exclusive). */
  end: number
  /** The mention's path, quotes stripped. */
  path: string
}

/** Uploads are bounded by the relay's own 500 MiB binary channel. */
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024
/** More than this many locales paths in one prompt is a paste accident, not intent. */
const MAX_MENTIONS = 8

/** Absolute in either spelling the Host accepts: POSIX, Windows drive, UNC. */
export function isAbsolutePathMention(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\/u.test(path)
}

/**
 * Every absolute-path `@` mention in one text part, in order.
 *
 * A mention starts at `@` unless the preceding character could be part of an
 * ASCII identifier local-part — `邮箱@example.com` / `foo@/root/x` must not
 * become paths, while a CJK character or prose punctuation immediately before
 * the `@` does open one (dragging a file into a half-typed Chinese sentence
 * inserts `吗@C:\...` with no space). The quoted form
 * `@"…"` ends at the closing quote; the bare form ends at whitespace. A
 * trailing `)`, `]`, `}` or `）` is trimmed because prose wraps paths in
 * them; a bare token with none of those follows.
 * @param text - one prompt text part.
 * @returns the mention ranges and their paths.
 */
export function fileMentionsIn(text: string): FileMention[] {
  const mentions: FileMention[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '@') continue
    const previous = index === 0 ? '' : text[index - 1] ?? ''
    // Only an ASCII identifier character blocks the mention (email/URI local
    // parts). Everything else — whitespace, brackets, CJK letters and CJK
    // punctuation — is prose around a dropped file.
    if (/[A-Za-z0-9._%+-]/u.test(previous)) continue
    if (text[index + 1] === '"') {
      const close = text.indexOf('"', index + 2)
      if (close === -1) continue
      const path = text.slice(index + 2, close)
      if (isAbsolutePathMention(path)) mentions.push({ start: index, end: close + 1, path })
      index = close
      continue
    }
    let cursor = index + 1
    while (cursor < text.length && !/\s/u.test(text[cursor] ?? '')) cursor += 1
    let path = text.slice(index + 1, cursor)
    while (path.length > 0 && /[)\]}）,、。；;：:!?！？]/u.test(path[path.length - 1] ?? '')) {
      path = path.slice(0, -1)
    }
    if (path.length > 0 && isAbsolutePathMention(path)) {
      mentions.push({ start: index, end: index + 1 + path.length, path })
    }
    index = cursor - 1
  }
  return mentions
}

/** The relay face this module needs (invoke for the host probe, the two
 * binary channels for bytes). */
export interface MentionRelay {
  invoke(namespace: string, method: string, args: unknown, signal?: AbortSignal): Promise<unknown>
  upload(
    options: { sessionId: string; name?: string; body: ReadableStream<Uint8Array> | null; bytes?: number },
    signal?: AbortSignal,
  ): Promise<{ status: number; body: string }>
  /** Visible-path upload (2.3.0); absent on an older client wiring. */
  promptAttachment?(
    options: { sessionId: string; name?: string; body: ReadableStream<Uint8Array> | null; bytes?: number },
    signal?: AbortSignal,
  ): Promise<{ path: string }>
}

/** The content blocks a prompt carries (mirror of the wire union). */
type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }
  | { type: 'file'; receiptId: string }

/** True when the server already serves this path in the session's scope. */
async function hostHasPath(relay: MentionRelay, sessionId: string, path: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await relay.invoke('workspaceFiles', 'stat', { workspaceFileScopeId: sessionId, path }, signal)
    return true
  } catch {
    return false
  }
}

/** How many glued trailing characters a bare mention may be trimmed by. */
const MAX_SUFFIX_TRIM = 24

/**
 * The longest PREFIX of a syntactic mention that is a real local file.
 *
 * The composer inserts `@<path>` at the caret, so a drop into a half-typed
 * sentence reads `…吗@C:\Users\me\Desktop\日志.txt`; a path followed by
 * CJK prose punctuation glues that punctuation onto our whitespace-delimited
 * token (`@…\b.txt）里`). The token's own trailing-punctuation trim cannot
 * fix the second case, so the FILE SYSTEM decides: try the token, then drop
 * one trailing character at a time (bounded) and take the longest existing
 * file. Only missing paths pay this cost.
 * @param raw - the syntactic token from {@link fileMentionsIn}.
 * @returns the existing file path and its length in code units, or undefined.
 */
async function resolveLocalFile(raw: string): Promise<{ path: string; length: number } | undefined> {
  const first = await isLocalFile(raw)
  if (first !== undefined) return { path: raw, length: raw.length }
  const floor = Math.max(1, raw.length - MAX_SUFFIX_TRIM)
  for (let length = raw.length - 1; length >= floor; length -= 1) {
    const candidate = raw.slice(0, length)
    if (await isLocalFile(candidate) !== undefined) return { path: candidate, length }
  }
  return undefined
}

async function isLocalFile(path: string): Promise<unknown | undefined> {
  try {
    const info = await stat(path)
    return info.isFile() ? info : undefined
  } catch {
    return undefined
  }
}

/** One local file staged on the host, or undefined when it must stay text. */
type StagedFile =
  /** Visible path on the server: rewrite the mention to it. */
  | { kind: 'path'; path: string; length: number }
  /** Official attachment receipt: prepend a file block, drop the mention. */
  | { kind: 'receipt'; receiptId: string; length: number }

async function stageLocalFile(
  relay: MentionRelay,
  sessionId: string,
  path: string,
  signal?: AbortSignal,
): Promise<StagedFile | undefined> {
  const resolved = await resolveLocalFile(path)
  if (resolved === undefined) return undefined
  path = resolved.path
  const info = (await isLocalFile(path)) as { size: number } | undefined
  if (info === undefined || info.size > MAX_UPLOAD_BYTES) return undefined
  if (await hostHasPath(relay, sessionId, path, signal)) return undefined
  // Prefer the visible-path materialization (ZCode's model): the prompt keeps
  // an `@<server path>` the agent reads with ordinary tools. An older host
  // answers 501 here (or lacks the method), and the attachment-receipt branch
  // below still delivers the bytes.
  if (relay.promptAttachment !== undefined) {
    try {
      const body = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>
      const uploaded = await relay.promptAttachment({ sessionId, name: basename(path), body, bytes: info.size }, signal)
      if (typeof uploaded.path === 'string' && uploaded.path !== '') {
        return { kind: 'path', path: uploaded.path, length: resolved.length }
      }
    } catch {
      // Fall through to the receipt channel.
    }
  }
  try {
    const body = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>
    const result = await relay.upload({ sessionId, name: basename(path), body, bytes: info.size }, signal)
    if (result.status !== 200) return undefined
    const parsed: unknown = JSON.parse(result.body)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const envelope = parsed as { ok?: unknown; value?: { receiptId?: unknown } }
    if (envelope.ok !== true || typeof envelope.value?.receiptId !== 'string') return undefined
    return { kind: 'receipt', receiptId: envelope.value.receiptId, length: resolved.length }
  } catch {
    return undefined
  }
}

/**
 * Rewrite one forwarded prompt's locale-path mentions into file receipts.
 *
 * @param args - the invoke arguments (`{ request: { sessionId, content } }`);
 *   mutated in place only when at least one mention was staged.
 * @param relay - the relay face (host probe + binary upload).
 * @param signal - the call's cancellation.
 * @returns the same arguments object, possibly rewritten.
 */
export async function materializeLocalFileMentions(
  args: unknown,
  relay: MentionRelay,
  signal?: AbortSignal,
): Promise<unknown> {
  if (typeof args !== 'object' || args === null) return args
  const request = (args as { request?: unknown }).request
  if (typeof request !== 'object' || request === null) return args
  const scope = request as { sessionId?: unknown; content?: unknown }
  if (typeof scope.sessionId !== 'string' || !Array.isArray(scope.content)) return args

  const staged: PromptBlock[] = []
  const blocks: unknown[] = []
  let changed = false
  let stagedCount = 0

  for (const raw of scope.content) {
    if (typeof raw !== 'object' || raw === null) {
      blocks.push(raw)
      continue
    }
    const block = raw as Partial<PromptBlock> & { type?: unknown }
    if (block.type !== 'text' || typeof (block as { text?: unknown }).text !== 'string') {
      blocks.push(raw)
      continue
    }
    const text = (block as { text: string }).text
    const mentions = fileMentionsIn(text)
    if (mentions.length === 0 || stagedCount >= MAX_MENTIONS) {
      blocks.push(raw)
      continue
    }
    let next = text
    for (let index = mentions.length - 1; index >= 0; index -= 1) {
      const mention = mentions[index]
      if (mention === undefined || stagedCount >= MAX_MENTIONS) continue
      const stagedFile = await stageLocalFile(relay, scope.sessionId, mention.path, signal)
      if (stagedFile === undefined) continue
      stagedCount += 1
      const before = next.slice(0, mention.start)
      const after = next.slice(mention.start + 1 + stagedFile.length)
      if (stagedFile.kind === 'path') {
        // Keep the mention, point it at the server-side copy: `@<remote path>`.
        next = `${before}@${stagedFile.path}${after}`
      } else {
        staged.unshift({ type: 'file', receiptId: stagedFile.receiptId })
        next = `${before}${after}`
      }
      changed = true
    }
    blocks.push(next === text ? raw : { ...(raw as object), text: next })
  }

  if (!changed) return args
  scope.content = [...staged, ...blocks]
  return args
}
