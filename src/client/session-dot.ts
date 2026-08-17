import type { SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Status dot state of one session, matching the official sidebar semantics.
 * Shared by the home-screen row dots (MobileHome.tsx) and the session
 * header's running indicator (effects/header-status.ts), which reads it
 * outside React — see that module for why.
 * @param row - session summary.
 * @returns the dot state, or undefined when the row needs no dot.
 */
export function dotState(row: SessionSummary): StateDotState | undefined {
  if (row.pendingInteraction !== undefined) return 'warning'
  if (row.running) return 'ongoing'
  if (row.completed === true) return 'done'
  return undefined
}
