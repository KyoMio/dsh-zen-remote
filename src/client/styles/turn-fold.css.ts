// turn-fold — the folded turn process and its summary row (S8, 2026-08-17).
// Everything that can hide content lives inside (max-width: 767px); the two
// markers this file reads (data-mnav-fold on a process element,
// data-mobile-nav="turn-fold" on the injected summary row) are only ever
// written by effects/turn-fold.ts, which detaches and wipes them at >= 768px
// — so tablet and desktop are a no-op twice over, by attribute and by media
// query. Appended last in styles/index.ts; it shares no selector with any
// other file, the position just keeps the "phone files come after the shared
// <=1023px block" ordering intact.

export const TURN_FOLD_CSS = `/* ---------- turn process fold (< 768px) ---------- */

/* The summary row never paints outside the phone breakpoint, even if a
   media-query change raced the effect's own cleanup. */
[data-mobile-nav="turn-fold"] {
  display: none;
}

@media (max-width: 767px) {
  /* Folded process: tool-call / context / command rows and the Think
     disclosures inside an assistant step. !important because the official
     flow item and ReasoningRow both set their own display. */
  [data-mnav-fold]:not([data-mnav-fold-open]) {
    display: none !important;
  }

  /* Compact chip, sized like the composer's own pills rather than a button:
     it is a reading affordance in the middle of the message flow, so it has
     to stay quieter than the content around it. The flow column is a flex
     column with gap: 16px (ChatView.module.css) — align-self keeps the chip
     from stretching, and the negative block margin trims that generous gap
     back to something a 26px row can live in. */
  [data-chat-flow] > [data-mobile-nav="turn-fold"] {
    display: inline-flex;
    align-self: flex-start;
    align-items: center;
    gap: 6px;
    margin: -4px 0;
    padding: 0 10px;
    height: 26px;
    border: none;
    border-radius: 13px;
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .55));
    font: inherit;
    font-size: 12px;
    line-height: 26px;
    white-space: nowrap;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  [data-chat-flow] > [data-mobile-nav="turn-fold"]:active {
    background: var(--dsw-alias-interactive-bg-pressed, rgba(0, 0, 0, .1));
  }

  /* Leading dot: idle turns get a quiet mark, a running turn gets the same
     business-primary colour the session header's own status dot uses
     (styles/header.css.ts) plus a breathing pulse. */
  [data-chat-flow] > [data-mobile-nav="turn-fold"]::before {
    content: '';
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    opacity: .45;
  }
  [data-chat-flow] > [data-mobile-nav="turn-fold"][data-running]::before {
    background: var(--dsw-alias-state-business-primary, #4f6ef7);
    opacity: 1;
    animation: dsh-mobile-nav-breathe 1.4s var(--ds-ease-in-out, ease-in-out) infinite;
  }

  /* Chevron drawn from two borders — no icon injection, no mask image, and
     it rotates to point up once the turn is open. */
  [data-chat-flow] > [data-mobile-nav="turn-fold"]::after {
    content: '';
    flex: none;
    width: 5px;
    height: 5px;
    margin-top: -3px;
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: rotate(45deg);
    transition: transform .16s var(--ds-ease-out, ease-in-out);
  }
  [data-chat-flow] > [data-mobile-nav="turn-fold"][data-open]::after {
    margin-top: 3px;
    transform: rotate(-135deg);
  }

  @media (prefers-reduced-motion: reduce) {
    [data-chat-flow] > [data-mobile-nav="turn-fold"][data-running]::before {
      animation: none;
    }
    [data-chat-flow] > [data-mobile-nav="turn-fold"]::after {
      transition: none;
    }
  }
}

@keyframes dsh-mobile-nav-breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: .4; transform: scale(.72); }
}
`
