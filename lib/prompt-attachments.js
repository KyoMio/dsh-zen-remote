/**
 * Prompt-attachment materialization on the HOST (2.3.0) — the visible-path
 * counterpart of the official attachment store.
 *
 * WHY this exists (cross-validated against ZCode's
 * `packages/desktop/src/host/remotePromptAttachments.ts`): a remote session's
 * prompt may reference a file that lives on the CLIENT machine. DSH's own
 * answer is the attachment store (`~/.dsh/attachments/v1/…`, content-addressed)
 * plus a receipt bound to one prompt — correct, but the path is opaque and the
 * receipt dies with the prompt. ZCode instead materializes the file at a
 * PRIVATE, VISIBLE path on the remote host and rewrites the prompt text to
 * that path; the agent then reads an ordinary file. That is easier to debug,
 * survives restarts, and matches how the rest of the plugin's workspace-upload
 * flow behaves.
 *
 * WHAT is stored: `<DSH_HOME>/tmp/prompt-attachments/<sessionId>/<stamp>-<nonce>-<name>`.
 * The per-session directory and the file are tightened to 0700/0600 (ZCode
 * does the same with `chmod 700` / `chmod 600`); names go through the same
 * sanitizer the mobile upload route uses; a size cap keeps one request from
 * filling the disk; a failed write removes its half-written file.
 *
 * Stale files (older than 24h, ZCode's janitor window) are swept by
 * {@link cleanupStalePromptAttachments}, called once per host apply.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readdir, rm, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { safeUploadName } from './index.js';
/** Root below the DSH home (DSH_HOME when set, `~/.dsh` otherwise). */
const ROOT_RELATIVE = join('tmp', 'prompt-attachments');
/** The relay's own 500 MiB binary-channel cap, mirrored here. */
export const PROMPT_ATTACHMENT_MAX_BYTES = 500 * 1024 * 1024;
/** ZCode's janitor window. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** The host's prompt-attachment root. */
export function promptAttachmentsRoot(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
    return join(home, ROOT_RELATIVE);
}
/** One session's directory name (never a path: separators and dots are folded). */
function sessionSegment(sessionId) {
    const cleaned = sessionId
        .replace(/[^A-Za-z0-9._-]/gu, '_')
        .replace(/^\.+/u, '')
        .slice(0, 80);
    return cleaned === '' ? 'session' : cleaned;
}
/** `YYYYMMDD-HHmmss`, local time. */
function stampOf(now) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
/**
 * The stored leaf name: time, a short nonce (collision breaker for
 * same-second drops) and the sanitized original name.
 * @param name - the client's display name.
 * @param now - clock, injectable for tests.
 * @param nonce - collision breaker, injectable for tests.
 * @returns one safe leaf name.
 */
export function promptAttachmentFileName(name, now = new Date(), nonce = randomBytes(3).toString('hex')) {
    return `${stampOf(now)}-${nonce}-${safeUploadName(name ?? 'attachment')}`;
}
/** Reject a target that escaped the session directory (defense in depth). */
function assertInside(directory, target) {
    const rel = relative(directory, target);
    if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
        throw new Error('prompt-attachment target escapes its directory');
    }
}
/**
 * Write one uploaded file into the private materialization tree.
 *
 * The directory is created (and tightened) first; the file is opened
 * exclusively with 0600 so a collision can never truncate an earlier
 * attachment. Streams are consumed chunk by chunk under the cap; any failure
 * removes the partial file.
 * @param input - session, display name, body and cancellation.
 * @returns the absolute path and byte count.
 */
export async function savePromptAttachment(input) {
    const root = input.root ?? promptAttachmentsRoot();
    const directory = join(root, sessionSegment(input.sessionId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700).catch(() => { });
    await chmod(directory, 0o700).catch(() => { });
    const cap = input.maxBytes ?? PROMPT_ATTACHMENT_MAX_BYTES;
    const target = resolve(directory, promptAttachmentFileName(input.name));
    assertInside(directory, target);
    const handle = await open(target, 'wx', 0o600);
    let written = 0;
    try {
        if (input.body !== null) {
            const reader = input.body.getReader();
            for (;;) {
                input.signal?.throwIfAborted();
                const next = await reader.read();
                if (next.done)
                    break;
                const chunk = next.value;
                written += chunk.byteLength;
                if (written > cap)
                    throw Object.assign(new Error('payload-too-large'), { code: 'payload-too-large' });
                await handle.write(chunk);
            }
        }
        await handle.sync().catch(() => { });
    }
    catch (error) {
        await handle.close().catch(() => { });
        await unlink(target).catch(() => { });
        throw error;
    }
    await handle.close();
    await chmod(target, 0o600).catch(() => { });
    return { path: target, bytes: written };
}
/**
 * Remove files older than the janitor window (ZCode's 24h) and any directory
 * left empty. Best-effort: a permission problem in one session directory must
 * not fail the host's startup.
 * @param olderThanMs - age threshold.
 * @param root - override for tests.
 * @returns how many files were removed.
 */
export async function cleanupStalePromptAttachments(olderThanMs = STALE_AFTER_MS, root = promptAttachmentsRoot(), now = Date.now()) {
    let removed = 0;
    let sessions;
    try {
        sessions = await readdir(root);
    }
    catch {
        return 0;
    }
    for (const session of sessions) {
        const directory = join(root, session);
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile())
                continue;
            const file = join(directory, entry.name);
            try {
                const info = await stat(file);
                if (now - info.mtimeMs > olderThanMs) {
                    await unlink(file);
                    removed += 1;
                }
            }
            catch {
                // Already gone, or not ours to manage.
            }
        }
        try {
            const left = await readdir(directory);
            if (left.length === 0)
                await rm(directory, { recursive: false });
        }
        catch {
            // Non-empty, busy, or already gone.
        }
    }
    return removed;
}
//# sourceMappingURL=prompt-attachments.js.map