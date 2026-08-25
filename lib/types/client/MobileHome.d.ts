import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client';
import { NS } from './locales.ts';
import type { createNavStore } from './nav-store.ts';
/** Full props for the phone home screen (shell.overlay entry). */
export type MobileHomeProps = PropsRuntime<'shell.overlay'> & PropsStore<ReturnType<typeof createNavStore>> & PropsLocale<typeof NS> & {
    /** Bound ctx.sessions.open(id). */
    openSession: (id: SessionId) => void;
    /** Bound ctx.workspaces.startSession(workspaceId?). */
    startSession: (workspaceId?: WorkspaceId) => void;
    /** Bound ctx.sessionLogDownload.download() — the session-log chip (S5). */
    downloadSessionLog: (id: SessionId) => void;
    /** Bound ctx.workspaces.archiveSession(id) — the row swipe action. */
    archiveSession: (id: SessionId) => Promise<void>;
};
/**
 * Phone home screen: the full-screen session list that owns the first level
 * of the page stack. Renders nothing at or above 768px — the tablet drawer
 * and the desktop layout stay exactly as they were.
 *
 * All data comes from the standard kit (`useSessions` / `useWorkspaces`) and
 * all navigation from the injected official actions; nothing here reads the
 * official DOM.
 */
export declare function MobileHome({ useSessions, useWorkspaces, useStore, actions, openSession, startSession, downloadSessionLog, archiveSession, t, }: MobileHomeProps): import("react").JSX.Element | null;
//# sourceMappingURL=MobileHome.d.ts.map