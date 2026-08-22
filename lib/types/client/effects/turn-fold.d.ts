import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Whole-row node kinds that are turn *process*, not conversation content.
 * Keys are ChatNodeSeat's own `data-chat-flow-kind` dispatch values
 * (registerChatNodeRenderers, lib/client.js:9322): tool calls, injected
 * context rows, and slash-command rows. Everything else stays visible —
 * `user`/`steering` (the question), `assistant-step` (the prose, folded
 * per-block below), `turn-tail` (the footer with its actions), and the
 * error notices `turn-error` / `turn-max-tokens` / `model-retry`, which are
 * exactly what a reader must not have to hunt for. */
export declare const PROCESS_KINDS: readonly ["context", "tool-call", "command"];
/** ReasoningRow's own marker (lib/client.js:8966) — the Think disclosure
 * rendered inside an assistant-step row, beside that step's prose. */
export declare const THINK = "[data-variant=\"think\"]";
/** Per-item override written while its turn is expanded. */
export declare const OPEN = "data-mnav-fold-open";
/**
 * S8 — collapse a turn's process into one summary row (< 768px by default;
 * every width when the plugin row sets `config.turnFoldDesktop` or a browser
 * opts itself in via `?mobile-nav-turn-fold=1`).
 *
 * Route taken: DOM marking, not the `conversation.chat.node` keyed slot.
 * That slot dispatches on node kind and a second registration at a key
 * SHADOWS the official renderer (dsh-client-ui-slots index.d.ts:542 — the
 * cell's lowest-priority live entry renders, there is no wrapping form and
 * no `children` handle to the shadowed component). Taking `tool-call` would
 * mean re-implementing every tool's presentation, its `t` seat comes from
 * the entry's own declared locale namespace and its services from the
 * registrant's own inject face — neither is reachable from here — and the
 * registration is global, so the desktop no-op would be gone too.
 *
 * The DOM route needs no class names: ChatNodeSeat stamps every row with
 * `data-chat-flow-kind` / `data-chat-flow-key` (lib/client.js:5228) and
 * ReasoningRow stamps `data-variant="think"` — turn grouping is pure
 * structure (the run of rows following one `user` row), never text.
 *
 * ponytail: one rAF-coalesced full rescan per DOM mutation batch, O(rows).
 * If a very long session ever makes streaming feel heavy, narrow the
 * observer to the flow column's own childList and diff instead.
 */
export declare function installTurnFold(ctx: ClientContext): void;
//# sourceMappingURL=turn-fold.d.ts.map