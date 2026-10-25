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
import type { ClientContext, SessionId } from './compat/types.ts';
/** The byte window one relayed read asks for. Matches the host default
 * (`Config.maxBytes` 2 MiB) exactly: one round trip per window, and a host
 * configured smaller self-corrects through the too-large branch below. */
export declare const DOWNLOAD_CHUNK_BYTES: number;
/** One byte window's answer, as the client Remote face delivers it. Only the
 * fields this module reads are mirrored. */
export type RemoteByteWindow = {
    ok: true;
    value: {
        data: Uint8Array;
        eof: boolean;
    };
} | {
    ok: false;
    error: {
        code?: string;
        details?: {
            limit?: number;
        };
    };
};
/** One ranged read bound to (session, path); the caller owns the closure. */
export type RemoteByteRead = (range: {
    offset: number;
    length: number;
}) => Promise<RemoteByteWindow>;
/**
 * The last path segment, as the browser download name. Slash- and
 * backslash-separated paths both occur (the host may be Windows); an empty
 * tail falls back to a fixed name so `download` is never blank.
 * @param path - the file's absolute path on the host.
 * @returns the name to save under.
 */
export declare function downloadFileNameOf(path: string): string;
/** The three DOM reads {@link downloadPathFromCard} performs — structural so
 * tests can pass fake nodes (a real Element satisfies it). */
export interface DownloadCardNode {
    closest(selector: string): DownloadCardNode | null;
    querySelector(selector: string): DownloadCardNode | null;
    getAttribute(name: string): string | null;
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
export declare function downloadPathFromCard(button: DownloadCardNode | null): string | undefined;
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
export declare function collectRemoteFile(read: RemoteByteRead, chunkBytes?: number): Promise<Uint8Array>;
/** Save one file from a remote session to this machine. */
export type SaveRemoteFile = (sessionId: SessionId, path: string) => Promise<void>;
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
export declare function createSaveRemoteFile(ctx: ClientContext): SaveRemoteFile;
//# sourceMappingURL=remote-file-save.d.ts.map