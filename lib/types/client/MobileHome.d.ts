import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionId, UsePendingInteractions, WorkspaceId } from './compat/types.ts';
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
    /**
     * 0.1.2 的待处理交互选择器标准 prop；0.1.1 没有这个 prop，运行时读到
     * undefined（见组件里 EMPTY_PENDING_HOOK 兜底）。
     */
    useSessionPendingInteraction?: UsePendingInteractions;
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
export declare function MobileHome({ useSessions, useWorkspaces, useSessionPendingInteraction, useStore, actions, openSession, startSession, downloadSessionLog, archiveSession, t, }: MobileHomeProps): import("react").JSX.Element | null;
//# sourceMappingURL=MobileHome.d.ts.map