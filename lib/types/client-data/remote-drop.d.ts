/**
 * Remote-session drag-and-drop decision core (RD-1): the DOM-free, readable
 * half of the document-level drop guard (src/client/effects/remote-drop.ts).
 *
 * Why this exists: the desktop app's attachment pipeline has a same-machine
 * zero-copy fast path — the Electron preload exposes `__DSH_HOST_PATHS__`,
 * and the host's `addFiles` turns a File that still carries a real disk path
 * into an `@/absolute/path` mention chip WITHOUT uploading any bytes. In a
 * remote session (`zr~<serverId>~<id>`) that path names a file on the
 * SUB-CLIENT's machine; the server-side session can never read it, so the
 * mention lands broken. The fix re-shapes the drop before the host sees it:
 * strip the internal path by re-wrapping each File (`new File([f], ...)`) and
 * redispatch a synthetic, untrusted DragEvent carrying them in a fresh
 * DataTransfer. The host's own drop handler then treats it as an ordinary
 * browser drag — the byte-upload branch — which the T51 fetch-route
 * interception already relays to the server for staging.
 *
 * This module only DECIDES; it never touches the DOM:
 * - `isRemoteSessionId` — the current-session gate, judged by the same
 *   `zr~` skeleton (virtual-id.ts) every other remote gate in this plugin
 *   keys on, so the two ends cannot drift;
 * - `decideRemoteDrop` — the three trigger gates plus the directory rule,
 *   as a pure function over injectable data so the whole truth table is
 *   assertable in Node (scripts/check-remote-drop.mjs);
 * - `rewrapFiles` — the File re-wrap itself (Node >= 20 has File).
 *
 * Misjudgement direction is safe by construction: every gate failing open
 * lands on `passthrough` = today's behavior. The only wrong action a stale
 * current-session signal can produce is re-shaping a LOCAL session's drop
 * into an upload — bytes travel that did not have to, but nothing is lost.
 * The reverse (a remote drop reaching the host untouched) is what loses the
 * attachment, which is why all three gates must affirmatively pass.
 */
/** True when the id is one of this plugin's virtual (relay) session ids —
 * the `zr~<serverId>~<id>` form. `undefined` (no readable current-session
 * signal) is deliberately NOT remote: the conservative gate reads a missing
 * signal as a local session and never intervenes. */
export declare function isRemoteSessionId(id: string | undefined): boolean;
/** One drag item, reduced to what the decision needs. `kind` mirrors the
 * DataTransferItem kind — only `file` items can carry attachment bytes.
 * `isDirectory` comes from `webkitGetAsEntry().isDirectory`; a file item
 * whose entry cannot be read counts as NOT a directory (the host applies
 * the same default). */
export interface RemoteDropItemDescriptor {
    kind: 'file' | 'other';
    isDirectory: boolean;
}
/** Everything the decision may look at, injectable so no DOM is needed. */
export interface RemoteDropInput {
    /** `__DSH_HOST_PATHS__` exists — the Electron preload's zero-copy bridge.
     * False on phone / plain-browser hosts, which already upload bytes. */
    hasHostPaths: boolean;
    /** The currently open session id, or `undefined` when no signal. */
    currentSessionId: string | undefined;
    /** `event.isTrusted` — our own redispatched events are untrusted; this
     * gate is the re-entry guard. */
    trusted: boolean;
    /** Descriptor per file-kind drag item. `undefined` means the entry API
     * (`webkitGetAsEntry`) is unavailable, so directories cannot be detected —
     * the host's own semantics treat that as "no directories". */
    items: readonly RemoteDropItemDescriptor[] | undefined;
}
export type RemoteDropAction = 'passthrough' | 'redispatch' | 'block-directories';
/** Stable machine-readable why, one per action branch. Ordered by the gate
 * sequence below. */
export type RemoteDropReason = 'untrusted-event' | 'no-host-paths' | 'not-remote-session' | 'no-entry-api' | 'contains-directory' | 'no-files' | 'remote-files';
export interface RemoteDropDecision {
    action: RemoteDropAction;
    reason: RemoteDropReason;
}
/**
 * The three trigger gates, then the directory rule. Every gate must
 * affirmatively pass before anything is intervened on:
 * 1. `trusted` — synthetic (our own) events pass straight through, which is
 *    what makes the redispatch loop-free;
 * 2. `hasHostPaths` — without the Electron bridge the host is already on
 *    the byte-upload branch and there is nothing to fix;
 * 3. remote session — a missing/failed current-session read counts as local
 *    (conservative: passthrough keeps today's behavior);
 * 4. no entry API — redispatch (no directory knowledge, same default as the
 *    host);
 * 5. any directory — `block-directories`, which takes precedence over
 *    redispatch: a folder cannot be fixed by single-file upload, so the
 *    whole drop is stopped with a toast rather than silently reduced;
 * 6. no file items at all — passthrough (the host's own `Files`-in-types
 *    gate would ignore the drop; there is nothing to re-shape);
 * 7. otherwise — `redispatch`.
 */
export declare function decideRemoteDrop(input: RemoteDropInput): RemoteDropDecision;
/**
 * Re-wrap files so they stop carrying their disk paths. A File the browser
 * constructed from an OS drop keeps a hidden reference the Electron
 * `getPathForFile` can read; `new File([f], ...)` builds a JS-constructed
 * File with no such backing — `getPathForFile` returns "" for it, which
 * sends the host's `addFiles` down the byte-upload branch. name / type /
 * lastModified are preserved so the staged upload keeps its filename.
 */
export declare function rewrapFiles(files: Iterable<File>): File[];
//# sourceMappingURL=remote-drop.d.ts.map