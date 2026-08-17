import type { SessionSummary } from '@deepseek-ai/dsh-client-runtime/client';
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives';
/**
 * Status dot state of one session, matching the official sidebar semantics.
 * Shared by the home-screen row dots (MobileHome.tsx) and the session
 * header's running indicator (effects/header-status.ts), which reads it
 * outside React — see that module for why.
 * @param row - session summary.
 * @returns the dot state, or undefined when the row needs no dot.
 */
export declare function dotState(row: SessionSummary): StateDotState | undefined;
//# sourceMappingURL=session-dot.d.ts.map