// Compat: type re-homing + a structural session-row mirror.
//
// Most of src/client used to `import type { … } from
// '@deepseek-ai/dsh-client-runtime/client'`, a package DSH 0.1.2 removed.
// Type-only imports vanish at runtime, so each moved type just needs a new
// home; keeping those homes here concentrates every import-path swap in one
// file, and a future upstream rename touches only this file again.
//
// The one type that cannot be imported from either version is the session
// row: 0.1.1 declares `SessionSummary` in dsh-client-runtime, 0.1.2 in
// dsh-api-session-controller, and the two field sets differ (0.1.2 dropped
// `agentPreset` and `pendingInteraction`). Mirroring the handful of fields
// this plugin actually reads as a structural type (the same trick
// dsh-plugin-subscriptions' upstream compat.ts uses for RpcResult) lets rows
// from both versions assign in, instead of picking one version's type and
// breaking the other.
import type { Context } from '@deepseek-ai/cordis'
// Canonical homes for the two branded ids are the packages' `./types`
// subpaths. This tsconfig still resolves with node10 `moduleResolution:
// "node"`, which ignores package.json `exports` — the subpath only resolves
// because tsconfig.client.json maps it through `paths` to the exact .d.ts
// files; keep those two entries in sync if either package moves.
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/**
 * Browser-half cordis context. 0.1.1's `dsh-client-runtime` exported
 * `ClientContext` as the bare `Context` type (lib/types/client/index.d.ts:55);
 * 0.1.2 has no such alias. Re-declared here under the same name so the
 * dozen files that used it only change their import path, not the
 * identifier.
 */
export type ClientContext = Context

/** Session id. Both versions ship it in `@deepseek-ai/dsh-session/types`; re-exported to collect import points. */
export type { SessionId }

/** Workspace id. 0.1.2 lives in `@deepseek-ai/dsh-workspace/types`. */
export type { WorkspaceId }

/**
 * Structural mirror of the session-row fields this plugin reads, valid
 * against both versions' `SessionSummary`. Deliberately NOT imported from
 * either version (see the file header): `projectionValues` stays `unknown`
 * rather than copying the host's
 * `Readonly<Partial<SessionProjectionMap>>` — that type differs between
 * versions and fights assignments under `exactOptionalPropertyTypes`. The
 * single read site (MobileHome.tsx:311) already casts.
 *
 * `agentPreset` and `pendingInteraction` are intentionally absent: their
 * real readers (MobileHome.tsx, MobileSessionInfo.tsx) receive rows typed by
 * the host's devDeps (0.1.2), not by this mirror, so fields here would not
 * help them — use {@link agentPresetOf} / {@link hasPendingInteraction}
 * instead.
 */
export interface MobileSessionRow {
  id: SessionId
  title?: string
  displayTitle: string
  cwd?: string
  parentId?: SessionId
  origin?: 'subagent'
  running: boolean
  completed?: boolean
  blank: boolean
  updatedAt: number
  /** 宿主投影值；本插件只读 sessionStats.turns，读的地方自己 cast。 */
  projectionValues?: unknown
}

/**
 * 0.1.1's session row carries `agentPreset`; 0.1.2 dropped it. Reading it
 * must not depend on which version's types are in scope in the current
 * file, so narrow through unknown.
 * @param row - a session row of either version.
 * @returns the agent preset name, or undefined when absent.
 */
export function agentPresetOf(row: unknown): string | undefined {
  const agentPreset = (row as { agentPreset?: unknown } | null | undefined)?.agentPreset
  return typeof agentPreset === 'string' ? agentPreset : undefined
}

/**
 * 0.1.1's session row carries `pendingInteraction` (the pending-interaction
 * state behind the sidebar's yellow dot); 0.1.2 serves it from the
 * uiSession service instead. This answers only "does this row carry a
 * pending interaction".
 * @param row - a session row of either version.
 * @returns true when the row has a pending interaction.
 */
export function hasPendingInteraction(row: unknown): boolean {
  const pending = (row as { pendingInteraction?: unknown } | null | undefined)?.pendingInteraction
  return pending !== undefined && pending !== null
}

/**
 * `ctx.sessions.binding(id)?.session.rename(title)` 的返回值。
 * 两版的包裹类型不同（0.1.1 是 RpcResult、0.1.2 是 RemoteResult），但判别式
 * 联合的形状一致：成功分支带 ok:true（还有个我们不读的 value），失败分支带
 * ok:false + error。这里只镜像本插件真正读到的两个字段（ok、error.message），
 * 两版的真类型都能结构赋值进来。
 */
export type RenameResult = Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly error: { readonly message: string } }
>

/**
 * 待处理交互的选择器 hook（0.1.2 的标准 prop `useSessionPendingInteraction`）；
 * 0.1.1 没有这个 prop，运行时读到 undefined。本地镜像只描述本插件读到的形状
 * （按会话 id 的只读 Map + 选择器调用），不从
 * `@deepseek-ai/dsh-client-ui-session/client` 拿类型——那个包 0.1.1 装不到。
 */
export type UsePendingInteractions =
  <S>(sel: (m: ReadonlyMap<SessionId, unknown>) => S, eq?: (a: S, b: S) => boolean) => S
