import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionFace, SessionId } from '@deepseek-ai/dsh-client-runtime/client';
import { NS } from './locales.ts';
/** Full props for the session-info sheet (header.utilities, second entry). */
export type MobileSessionInfoProps = PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<typeof NS> & {
    /** Bound ctx.sessions.fork({sessionId}). */
    forkSession: (sessionId: SessionId) => Promise<SessionId>;
    /** Bound ctx.sessions.open(id) — lands on the freshly forked session. */
    openSession: (id: SessionId) => void;
    /** Bound ctx.sessions.binding(id)?.session.rename(title); undefined when the binding is gone. */
    renameSession: (sessionId: SessionId, title: string) => ReturnType<SessionFace['rename']> | undefined;
    /** Bound ctx.workspaces.archiveSession(sessionId). */
    archiveSession: (sessionId: SessionId) => Promise<void>;
    /** Bound ctx.sessionLogDownload.download(sessionId) — owns its own progress/result modal. */
    downloadSessionLog: (sessionId: SessionId) => Promise<void>;
};
/**
 * Session-info sheet: the bottom sheet that gathers everything S3 pulled off
 * the composer (the official stats strip) and everything S2 left out of the
 * header (Chat/Trajectory as a real control, badges, session actions).
 *
 * Registered as a SECOND entry on `conversation.session.header.utilities` —
 * session scope, sibling to the ⓘ button that opens it
 * (MobileSessionHeader.tsx dispatches {@link SESSION_INFO_EVENT}).
 *
 * Mount-point choice (the plan's own tradeoff to weigh): this needs
 * `useProjection`/`sessionId` for the stats grid, and those are
 * session-scope-only standard props — `header.utilities` has them,
 * `shell.overlay` (S1's other option) does not. `shell.overlay` would have
 * gained nothing in exchange (GlobalStandardProps — `useSessions` for the
 * badges/subagent-count — is unconditional on every slot per
 * `PropsRuntime`, so this component gets it here for free too) while
 * running into a real problem: shell.overlay content renders inside the
 * `pI_x6G_overlayLayer`, a z-index:20 stacking context (AGENTS.md), and the
 * composer's own permission/model bottom sheets sit at z:60 — a
 * shell.overlay-hosted info sheet would render BEHIND an open composer
 * menu. Mounting inside the header's own DOM (outside that capped layer)
 * lets this sheet's z-index clear every other phone-shell float.
 */
export declare function MobileSessionInfo({ sessionId, useSessions, useProjection, forkSession, openSession, renameSession, archiveSession, downloadSessionLog, t, }: MobileSessionInfoProps): import("react").JSX.Element | null;
//# sourceMappingURL=MobileSessionInfo.d.ts.map