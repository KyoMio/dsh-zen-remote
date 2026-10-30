import type { ClientContext } from '../compat/types.ts';
/**
 * One suppression state transition, given whether an official group is on
 * the page and whether the fold is currently suppressed. `'enter'`: groups
 * appeared — drop every mark and the ACTIVE_ATTR the stylesheet keys on.
 * `'exit'`: the last group left — re-arm and fold again. `'hold'`: nothing
 * to do. Exported pure so the state machine itself is testable off-DOM
 * (test/fold-suppression.test.cjs); {@link scan} applies it.
 */
export declare function foldSuppressionTransition(officialGroupPresent: boolean, suppressed: boolean): 'enter' | 'exit' | 'hold';
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
/** The DOM surface {@link hasContentOutside} reads — kept this narrow so the
 * verdict is testable off-DOM (test/turn-fold-blank-step.test.cjs). */
export interface ContentNode {
    readonly nodeType: number;
    readonly textContent: string | null;
    readonly childNodes: ArrayLike<ContentNode>;
    readonly tagName?: string;
    matches?(selector: string): boolean;
}
/**
 * True when `node` renders anything a reader could see outside the subtrees
 * that match `skip`: a non-blank text node, or a {@link SELF_VISIBLE} element.
 * Structural, no class names — same discipline as the rest of this effect.
 */
export declare function hasContentOutside(node: ContentNode, skip: string | null): boolean;
/**
 * True when the reasoning rows are the ONLY thing this row renders, so the
 * whole flow item has to go: the flow column is `display: flex` with
 * `gap: 16px`, and an emptied-out flex item still claims its gap — the
 * reader would see the folded steps as a column of blank bands.
 * Structural test, no class names: outside the reasoning rows the row holds
 * nothing visible — only wrappers. Each reasoning block sits in its own
 * ProcessReasoning wrapper, and since DSH 0.2.1-rc.5 a block whose display
 * text is empty once a leading `<signature>…</signature>` is stripped renders
 * its ReasoningRow as null and leaves that wrapper empty; an empty wrapper
 * beside a Think must not keep the row unfolded.
 */
export declare function foldsWholeRow(row: ContentNode, thinks: readonly unknown[]): boolean;
/**
 * True for an assistant-step row that renders nothing at all — no Think, no
 * prose, no image, no notice. DSH 0.2.1-rc.5 produces one for a step whose
 * only reasoning is a `<signature>…</signature>` (ReasoningRow hides itself,
 * the wrappers stay). It is not process to count in the chip, and it is not
 * content either: left alone it is a blank band in the flow (the gap again),
 * so it is hidden on its own marker ({@link BLANK}) that the chip's open
 * override never releases. On 0.2.1-rc.2, which renders such a block as an
 * ordinary Think, the row is not blank and folds exactly as before.
 */
export declare function isBlankStep(row: ContentNode): boolean;
/** Marker of a {@link isBlankStep} row; the stylesheet hides it while the
 * fold is live. Never counted, never opened. */
export declare const BLANK = "data-mnav-blank";
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