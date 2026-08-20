// content — chat markdown readability on phones (2026-08-18). Shares no
// selector with any other file; appended last in styles/index.ts.

export const CONTENT_CSS = `/* ---------- chat markdown content (< 768px) ---------- */

@media (max-width: 767px) {
  /* Inline code: upstream renders it display:inline-flex — an atomic inline
     box that can never wrap across lines, so one long code span walks off
     the right edge of the screen. Plain inline keeps the background pill
     per line fragment and lets long tokens break anywhere. Deliberately
     unscoped (any :not(pre) > code, not just the _markdown_ module):
     inline code also renders outside that container (user bubbles,
     reasoning rows), and on a phone there is no width at which an
     unwrappable inline box is right. !important beats the upstream
     display:inline-flex on specificity ties. */
  :not(pre) > code {
    display: inline !important;
    overflow-wrap: anywhere;
    /* iOS WebKit: overflow-wrap alone still failed to break long tokens in
       inline code on a real iPhone (screenshot-verified 2026-08-18, li >
       code path case) while desktop Chromium broke them fine. break-all is
       the everywhere-supported hammer; acceptable for code pills. */
    word-break: break-all;
  }
  /* Belt-and-suspenders for engines that compute soft-wrap opportunities
     from the block container rather than the inline itself (historical
     WebKit behavior): inherit anywhere through the whole transcript so the
     block side agrees. Prose is untouched until something would overflow;
     the table is already pinned wide by min-width: max-content below. */
  [data-chat-flow],
  [class*="_markdown_"] {
    overflow-wrap: anywhere;
  }

  /* Transcript density (2026-08-20): the desktop prose rhythm is 28px of
     leading on 15px text — a 1.87 ratio that reads generously on a wide
     column but wastes a phone screen, where the same paragraph is three
     times as many lines. Unitless 1.65 so nested blocks (code, quotes,
     lists) recompute from their OWN font-size instead of inheriting a fixed
     28px that is far too loose for 12-13px chrome text. 1.65 is the floor I
     am willing to go to for mixed CJK/Latin: the glyphs are full-height with
     no descender relief, so tighter starts to look stacked. Phone only —
     the desktop column keeps the official rhythm. */
  [class*="_markdown_"] {
    line-height: 1.65;
  }
  /* Paragraph rhythm. Each paragraph is its own markdown block and the
     separation comes from the flex container's row-gap, not from margins —
     at the stock 16px the paragraph baseline step was 40.75px against a
     24.75px line step, i.e. 1.65x, which is what reads as airy. 12px brings
     the step to ~36.75px: still clearly more than one line so paragraphs
     never run together, but noticeably denser. Scoped by :has() to
     containers that actually hold prose blocks, so tool cards and other
     flex bodies with the same hashed suffix keep their own spacing. */
  [data-phase] [class$="_body"]:has(> [class*="_markdown_"]) {
    row-gap: 12px !important;
  }

  /* Markdown tables: the official _tableScroll_ wrapper is already a
     horizontal scroll viewport around a width:max-content table, but its
     cells are capped at min(30vw, 320px) — barely 120px on a phone, which
     crushes every column into a vertical word-stack. Let columns size to
     their content instead and read the overflow by scrolling the wrapper.
     480px (not a vw cap — 85vw was ~320px on a 375px phone and still
     wrapped mid-length cells) keeps typical cells on one line; only truly
     prose-heavy cells wrap, instead of dragging the table kilometers
     wide. */
  [class*="_tableScroll_"] th,
  [class*="_tableScroll_"] td {
    max-width: 480px !important;
  }

  /* iOS WebKit fallback: upstream's own table { width: max-content } is what
     keeps the table at its natural width inside the scroll wrapper, but
     WebKit's max-content support on table boxes is incomplete — on a real
     iPhone the table fell back to shrink-to-fit and every column got
     crushed to its min-width (the "ra/nk" vertical-word-stack screenshot,
     2026-08-18). Redeclare the natural-width intent with both width and
     min-width so whichever keyword the engine honors wins; the wrapper
     already scrolls the overflow. */
  [class*="_tableScroll_"] table {
    width: max-content !important;
    min-width: max-content !important;
    max-width: none !important;
  }

  /* Turn-tail metadata (2026-08-18): the timing stats ("18:06 · 用时 29秒 ·
     首 token 0.9秒 · 163 tok/s") are desktop-hover-revealed (official
     [data-time-hover-root] gate holds them at opacity 0 until :hover /
     :focus-within) — a phone never hovers, so they were simply invisible;
     and even ignoring that, the row is nowrap + overflow:hidden (plus this
     plugin's own legacy ellipsis clamp in layout.css.ts), which clipped the
     text. On phones: always visible, own full-width line under the action
     icons, wrapping freely, one type size down. !important + the extra
     [class$="_actions"] hop out-specifies both upstream and layout.css.ts. */
  /* Pin the tail row's width chain before allowing wrap: with wrap enabled
     the row's intrinsic (shrink-to-fit) width collapses to its widest
     single icon, taking the whole tail down to ~16px. */
  [data-chat-flow-kind="turn-tail"] [class$="_root"],
  [data-chat-flow-kind="turn-tail"] [class$="_actions"] {
    width: 100%;
  }
  [data-chat-flow-kind="turn-tail"] [class$="_actions"] {
    flex-wrap: wrap;
    row-gap: 2px;
  }
  /* Wide companion to the rule below: mirrors the upstream hover-gate
     selector shape directly, with no assumptions about the tail's DOM
     structure, so the stats can't stay invisible even if the phone's tail
     renders differently than desktop. */
  [data-time-hover-root] [class$="_timeEnd"],
  [data-time-hover-root] [class$="_timeStart"] {
    opacity: 1 !important;
    transition: none !important;
  }
  [data-chat-flow-kind="turn-tail"] [class$="_actions"] [class$="_timeEnd"] {
    opacity: 1 !important;
    flex-basis: 100% !important;
    white-space: normal !important;
    overflow: visible !important;
    text-overflow: clip !important;
    padding-left: 0 !important;
    font-size: 12px;
    line-height: 18px;
  }
}
`
