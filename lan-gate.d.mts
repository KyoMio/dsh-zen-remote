/**
 * Type surface of lan-gate.mjs (the `dsh-zen-remote-gateway` sub-plugin),
 * which ships as plain JavaScript at the package root. Hand-written and
 * minimal on purpose: just enough for the main entry's
 * `ctx.plugin(gateway, …)` to typecheck — the .mjs itself is never compiled
 * (no allowJs) and every member is re-read from the real module at runtime.
 */
export const name: string
export const inject: string[]
export function apply(ctx: unknown, config?: unknown): void
