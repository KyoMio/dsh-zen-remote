import { hasPendingInteraction } from './compat/types.ts'
import type { MobileSessionRow } from './compat/types.ts'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Status dot state of one session, matching the official sidebar semantics.
 * Shared by the home-screen row dots (MobileHome.tsx) and the session
 * header's running indicator (effects/header-status.ts), which reads it
 * outside React — see that module for why.
 *
 * Pending interaction has two version-specific sources: `pending` is the
 * 0.1.2 source (the uiSession service / useSessionPendingInteraction map,
 * which this dot's caller resolves), and `hasPendingInteraction(row)` is the
 * 0.1.1 source (the row's own field). Each version hits exactly one of the
 * two: on 0.1.2 the row field is gone so the row check is always false, and
 * on 0.1.1 `pending` is always false because the caller has no uiSession.
 * @param row - session row.
 * @param pending - whether the uiSession pending map has this row (0.1.2).
 * @returns the dot state, or undefined when the row needs no dot.
 */
export function dotState(row: MobileSessionRow, pending?: boolean): StateDotState | undefined {
  if (pending === true || hasPendingInteraction(row)) return 'warning'
  if (row.running) return 'ongoing'
  if (row.completed === true) return 'done'
  return undefined
}
