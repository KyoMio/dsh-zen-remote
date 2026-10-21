/**
 * Make a dropped file an ATTACHMENT in a remote session (2.2.6, follow-up).
 *
 * DSH's composer prefers a *path reference* over an upload whenever the
 * desktop shell exposes its host-path bridge: `addFiles` reads
 * `globalThis.__DSH_HOST_PATHS__` (RT dsh-client-ui-conversation
 * `hostPathBridge()` / `addFiles` ~19942-19970) and, for every non-image
 * file, inserts `@<absolute path>` into the draft instead of uploading the
 * bytes. That is correct when the UI and the DSH backend run on the same
 * machine — the agent can read the path.
 *
 * In a REMOTE session it is wrong: the path is on the machine showing the
 * UI, while the agent runs on the host. The draft ends up carrying e.g.
 * `@C:\Users\me\Desktop\日志.txt`, the prompt reaches the host as plain
 * text, and the file never exists there — exactly the "uploaded a file but
 * the agent cannot read it" failure.
 *
 * The bridge is read through the global on every composer inject, and
 * `pathFor(file)` is called per dropped file, so one Proxy is enough: while
 * the session on screen is virtual (the plugin's own
 * `data-zr-remote-session` marker, maintained by effects/remote-session.ts),
 * `pathFor` answers `undefined`. The composer's own next branch then treats
 * the file as an ordinary upload (`uploads.push(file)`), which the plugin's
 * T51 interception already relays to the host — the file becomes a real
 * attachment receipt on the server and the agent can read it.
 *
 * Everything else on the bridge passes through untouched, and outside a
 * remote session `pathFor` delegates to the shell's original. No bridge
 * (the web UI, or a shell without it) means nothing to do.
 */
/** True while the page shows a remote (virtual) session. */
export declare function remoteSessionOnScreen(): boolean;
/**
 * Wrap the shell's host-path bridge so a remote session's dropped files
 * upload instead of becoming client-local path mentions.
 * @param isRemote - reads the current session kind; injectable for tests.
 * @returns the uninstaller (restores the original only while still ours).
 */
export declare function installHostPathBridgeGuard(isRemote?: () => boolean): () => void;
//# sourceMappingURL=host-path-bridge.d.ts.map