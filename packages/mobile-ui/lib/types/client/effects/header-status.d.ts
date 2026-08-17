import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/**
 * Session header running-status dot (S2). No official element exists to
 * reposition (ConversationSessionHeader renders only the crumb title, the
 * actions/utilities slots, and the tablist — dsh-client-ui-conversation
 * lib/client.js:6949-7009), so this reads `ctx.sessions.list` directly
 * (the same feed `useSessions` wraps) and stamps a data attribute the
 * mobile stylesheet turns into a `::after` dot on the title crumb —
 * "read data, self-draw" is the plan's documented fallback for this piece.
 * Kept outside React: the dot must track the CURRENT session regardless of
 * which component the header happens to mount, and a plain attribute +
 * CSS avoids reaching into the official crumb's own DOM subtree.
 */
export declare function installHeaderStatusDot(ctx: ClientContext): void;
//# sourceMappingURL=header-status.d.ts.map