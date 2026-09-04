// info — session-info bottom sheet (S4, 2026-08-17). Scoped entirely to
// (max-width: 767px) and appended LAST (after composer.css.ts) so its rules
// win the header.css.ts blanket-hide tie (same specificity, later source
// wins — see the comment on the re-show block below) and the shared
// <=1023px block never sees it. 768-1023px / >=1024px: strict no-op, same
// discipline as every other phone-only file in this stylesheet.
//
// Visual language borrowed from styles/home.css.ts's workspace sheet
// (fixed/absolute bottom sheet, 16px top radius, dsh-mobile-nav-fade /
// -sheet-up keyframes from base.css.ts) and styles/composer.css.ts's own
// bottom-sheet technique for the permission/model menus (position: fixed,
// safe-area bottom padding, 48px+ touch rows) — this file reuses both
// rather than inventing a third sheet shape.

export const INFO_CSS = `/* ---------- session-info sheet (< 768px) ---------- */

/* Unconditional render (React, not CSS, decides open/closed) — default
   hidden outside the phone breakpoint so a stray SESSION_INFO_EVENT at
   >=768px (the ⓘ trigger itself is already CSS-hidden there) can never
   paint anything, mirroring header.css.ts's own belt-and-braces list. */
[data-mobile-nav="info-layer"] {
  display: none;
}

@media (max-width: 767px) {
  /* header.css.ts hides every [data-slot="conversation.session.header.utilities"]
     direct child by default (its own ⓘ/workbench buttons are the two named
     exceptions) — this is a second, sibling entry on that same slot, so it
     needs the identical re-show override. Equal specificity
     ([data-slot="…"] > * vs this attribute selector, both one attribute
     selector + !important) means source order decides the tie; this file
     is concatenated after header.css.ts in styles/index.ts, so it wins. */
  [data-phase] header [data-slot="conversation.session.header.utilities"] > [data-mobile-nav="info-layer"] {
    display: block !important;
  }

  /* The sheet renders inside the header, and \`[data-phase] header\` is a
     stacking context of its own (position: relative + z-index: 2, set in
     header.css.ts so the header's fade strip paints over the scroller). A
     child's z-index is scoped to that context, so the z:70 below competes not
     with the page but with the header's own 2 — and the host's composer seat
     (.wSkVaW_composerSeat, z:7, from dsh-client-ui-conversation) outranks
     it. Measured live on DSH 0.1.2, 2026-09-04: with the sheet open, the
     topmost element over the composer band was the composer's own trigger
     button, i.e. the input row painted THROUGH the card.
     Promote the header itself for exactly as long as the sheet is mounted —
     MobileSessionInfo returns null when closed (\`if (!open) return null\`),
     so the header drops back to 2 on close (verified: 70 while open, 2
     after). Descendant :has(), never \`>\`: the utilities slot wrapper is
     \`display: contents\` and the host owns the depth (AGENTS.md — do not
     encode host DOM depth in a selector).
     Not raising the seat's own z-index instead: it belongs to the host and
     is shared with the scroll-to-bottom button and the composer sheets. */
  [data-phase] header:has([data-mobile-nav="info-layer"]) {
    z-index: 70;
  }

  [data-mobile-nav="info-layer"] {
    position: fixed;
    inset: 0;
    /* Above the composer's own bottom sheets (permission/model menus sit at
       z:60, styles/composer.css.ts) and the shell.overlay layer's z:20
       ceiling (AGENTS.md stacking-context pitfall) — this sheet must cover
       both, which is only possible because it renders inside the header's
       own DOM instead of that capped layer. */
    z-index: 70;
  }
  [data-mobile-nav="info-mask"] {
    position: absolute;
    inset: 0;
    border: none;
    background: var(--dsw-alias-bg-mask-3, rgba(0, 0, 0, .45));
    animation: dsh-mobile-nav-fade .18s var(--ds-ease-out, ease-in-out);
  }
  [data-mobile-nav="info-sheet"] {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: calc(var(--mnav-sab) + 8px);
    max-height: 82dvh;
    overflow-y: auto;
    overscroll-behavior: contain;
    box-sizing: border-box;
    padding: 12px;
    border-radius: 16px;
    background: var(--dsw-alias-bg-layer-2, #ffffff);
    box-shadow: 0 8px 32px rgba(0, 0, 0, .28);
    animation: dsh-mobile-nav-sheet-up .22s var(--ds-ease-out, ease-in-out);
  }
  @media (prefers-reduced-motion: reduce) {
    [data-mobile-nav="info-mask"],
    [data-mobile-nav="info-sheet"] {
      animation: none !important;
    }
  }

  /* --- head: Chat/Trajectory segmented control + close --- */
  [data-mobile-nav="info-head"] {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
  }
  [data-mobile-nav="info-tabs"] {
    display: flex;
    gap: 2px;
    padding: 2px;
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
    border-radius: 12px;
  }
  [data-mobile-nav="info-tab"] {
    min-height: 36px;
    padding: 0 14px;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .5));
    font-family: inherit;
    font-size: 14px;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="info-tab"][data-selected] {
    background: var(--dsw-alias-bg-layer-2, #ffffff);
    color: var(--dsw-alias-label-primary, inherit);
    font-weight: 600;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .12);
  }
  [data-mobile-nav="info-close"] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    flex: none;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--dsw-alias-label-secondary, inherit);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="info-close"]:active {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  }

  /* --- badges: agent preset, subagent count, cwd --- */
  [data-mobile-nav="info-badges"] {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
  }
  [data-mobile-nav="info-badge"],
  [data-mobile-nav="info-badge-cwd"] {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .6));
    font-size: 12px;
    line-height: 18px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-mobile-nav="info-badge-cwd"] {
    font-family: var(--dsw-font-mono, ui-monospace, monospace);
  }

  /* --- six-cell stats grid --- */
  [data-mobile-nav="info-stats"] {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-bottom: 12px;
  }
  [data-mobile-nav="info-stat"] {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-height: 48px;
    padding: 8px 4px;
    border-radius: 12px;
    background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, .03));
    text-align: center;
  }
  [data-mobile-nav="info-stat-value"] {
    color: var(--dsw-alias-label-primary, inherit);
    font-size: 17px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }
  [data-mobile-nav="info-stat-label"] {
    color: var(--dsw-alias-label-tertiary, rgba(0, 0, 0, .4));
    font-size: 11px;
    line-height: 1.3;
  }
  [data-mobile-nav="info-stat-sub"] {
    color: var(--dsw-alias-label-tertiary, rgba(0, 0, 0, .4));
    font-size: 10px;
    line-height: 1.2;
  }

  [data-mobile-nav="info-error"] {
    margin-bottom: 8px;
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--dsw-alias-state-warn-bg, rgba(217, 119, 6, .12));
    color: var(--dsw-alias-state-warn-primary, #d97706);
    font-size: 12px;
    line-height: 1.4;
  }

  /* --- action row: export / rename / fork / archive --- */
  [data-mobile-nav="info-actions"] {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
  [data-mobile-nav="info-action"] {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 48px;
    padding: 0 10px;
    border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
    border-radius: 12px;
    background: transparent;
    color: var(--dsw-alias-label-primary, inherit);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="info-action"]:active:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  }
  [data-mobile-nav="info-action"]:disabled {
    opacity: .5;
    cursor: default;
  }
  [data-mobile-nav="info-action"][data-mobile-nav-danger] {
    border-color: var(--dsw-alias-state-warn-primary, #d97706);
    color: var(--dsw-alias-state-warn-primary, #d97706);
  }
}
`
