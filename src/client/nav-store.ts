import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'

/** The two levels of the phone page stack. */
export type MobileView = 'home' | 'session'

/**
 * Session-list workspace filter: a pinned workspace, the explicit "all"
 * choice, or `null` — the untouched default that follows the current
 * session's workspace (resolved in the component, so a workspace that only
 * appears after the first baseline still lands).
 */
export type WorkspaceFilter = WorkspaceId | 'all' | null

/**
 * Phone page-stack store (phone breakpoint only; the tablet/desktop layouts
 * never read it). Deliberately NOT persisted: the spec's launch rule is
 * "always land on the session list", so a reload must reset to `home`.
 *
 * Built by a factory instead of a module-level constant: a module-scope
 * handle is a disguised singleton across plugin reloads (ui-slots docs).
 * @returns a fresh store handle, shared by every registration of one apply().
 */
export function createNavStore() {
  return defineStore({
    init: () => ({ view: 'home' as MobileView, workspace: null as WorkspaceFilter }),
    actions: {
      /**
       * Move the page stack.
       * @param draft - store draft.
       * @param view - target level.
       */
      show: (draft, view: MobileView) => {
        draft.view = view
      },
      /**
       * Pin the session-list workspace filter.
       * @param draft - store draft.
       * @param workspace - workspace id, or 'all'.
       */
      filter: (draft, workspace: WorkspaceFilter) => {
        draft.workspace = workspace
      },
    },
  })
}
