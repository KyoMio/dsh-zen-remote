import type { ClientContext } from '../compat/types.ts';
/**
 * The heading text a group section renders, across the two DSH layouts:
 * 0.1.7 points `aria-labelledby` at a heading div (id `<useId>-<group.id>`);
 * 0.2.0's MenuGroup points it at its own useId heading — which is also the
 * first `[data-menu-group-heading]` child — and its first child is an
 * id-less position sentinel span. Falls through in that order, then to the
 * first id-bearing child (0.1.7's heading, should `aria-labelledby` ever be
 * dropped), and gives up with `null`.
 */
export declare function headingTextOf(section: Element, getElementById: (id: string) => Element | null): string | null;
export declare function installModelGroupSide(ctx: ClientContext): void;
//# sourceMappingURL=model-group-side.d.ts.map