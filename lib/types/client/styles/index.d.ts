/**
 * All mobile styles, concatenated in the exact order of the original
 * single-file stylesheet (base → layout → compat → misc, where misc keeps
 * composer → tablet → desktop), followed by the phone app shell (home), the
 * session-header reflow (header), the composer reflow (composer), and the
 * session-info sheet (info, which must come last of all: it re-shows a
 * header.utilities child header.css.ts hides by default, so its rule has to
 * win that tie too), the turn-process fold (turn-fold, S8, which shares no
 * selector with any of them), and finally the chips row / settings entry /
 * portal fix (chips, S5) — all appended in this order so their <768px rules
 * win ties against the shared <=1023px block, then the chat markdown
 * readability overrides (content, which shares no selector with any of
 * them). Injected as ONE <style data-plugin> tag — do not reorder.
 */
export declare const MOBILE_CSS: string;
//# sourceMappingURL=index.d.ts.map