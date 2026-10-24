import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** Full props for the composer seat this invisible listener occupies. */
export type DropMentionListenerProps = PropsRuntime<'conversation.input.left'>;
/**
 * Invisible composer seat (RD-7): the receiver half of the remote drop
 * upload flow. The document-level drop guard (effects/remote-drop.ts)
 * uploads each dragged file to the SERVER session's workspace and dispatches
 * a `zr:drop-mention` CustomEvent per receipt; THIS component turns those
 * events into `@.dsh-uploads/<name>` mentions in the composer draft through
 * the official write path (attach-upload.ts `writeMention`).
 *
 * It renders NOTHING — no UI of its own; the desktop shell keeps its
 * pixel-for-pixel no-op because a host-role desktop never holds a virtual
 * session, so the listener below never even mounts there.
 *
 * Three gates keep a mention from landing in the wrong draft: the seat's
 * own `sessionId` must be a `zr~` virtual id (local sessions have no
 * workspace uploads to mention), the event's `detail.sessionId` must equal
 * THIS seat's session (a guard dispatch from another open window or a stale
 * in-flight upload must not write here), and the relPath must be a
 * non-empty string. Unmounted → listener removed.
 *
 * The draft baseline is MobileAttachButton's: `appendDraft` (DSH
 * 0.2.1-rc.3+) appends after whatever the composer holds, so no rebasing is
 * needed; the `setDraft` fallback takes the WHOLE next draft, so a burst of
 * drop-mentions chains off the last written text — unless `useInput` shows
 * the user typed since, in which case theirs wins.
 */
export declare function DropMentionListener({ sessionId, useInput, inputActions }: DropMentionListenerProps): null;
//# sourceMappingURL=DropMentionListener.d.ts.map