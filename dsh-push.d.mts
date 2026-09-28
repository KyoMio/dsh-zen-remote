/**
 * Type surface of dsh-push.mjs (the `dsh-zen-remote-push` sub-plugin), which
 * ships as plain JavaScript at the package root. Hand-written and minimal on
 * purpose: just enough for the main entry's `ctx.plugin(push, …)` to
 * typecheck — the .mjs itself is never compiled (no allowJs) and every member
 * is re-read from the real module at runtime. The pure decision helpers this
 * file omits (turnSummary, decideNotification, …) are exercised directly
 * from the .mjs by test/push-policy.test.cjs.
 */
export const name: string
export const inject: string[]
export function apply(ctx: unknown, config?: unknown): void
