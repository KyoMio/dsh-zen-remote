/**
 * The remote drop flow's two shared wire names (RD-7), pinned to ONE
 * declaration: the browser→plugin upload route and the DOM CustomEvent
 * type. Both halves of the plugin import this leaf — the host side
 * (client-routes.ts) and the browser side (the drop guard, the invisible
 * composer listener) — so a typo'd second spelling cannot exist (a duplicate
 * literal was mutation-proven silent: one wrong character turned the full
 * test suite 0 red). scripts/check-remote-drop.mjs refuses any re-declared
 * `const` of either name outside this module.
 *
 * Zero imports on purpose: the file must compile in BOTH tsconfig programs
 * (the host one has no `allowImportingTsExtensions`, so client-data — a
 * client-program directory whose imports use `.ts` specifiers — cannot be
 * pulled into it; this leaf follows virtual-id.ts's shared-leaf precedent).
 */

/** The browser→plugin route the drop guard POSTs one dragged file to
 * (client-routes.ts serves it under its CLIENT_* route-name alias). */
export const WORKSPACE_UPLOAD_ROUTE = '/_dsh/zen-remote/client/workspace-upload'

/** The DOM CustomEvent type the drop guard announces each uploaded relPath
 * on; DropMentionListener listens for the same constant. */
export const DROP_MENTION_EVENT = 'zr:drop-mention'
