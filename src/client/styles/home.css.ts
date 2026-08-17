// home — phone-only app shell (S1, 2026-08-17): the full-screen session list
// and the two-level page stack. Appended LAST so its rules win the ties
// against the shared <=1023px block in layout/compat/misc.
//
// Everything lives inside (max-width: 767px): the tablet range keeps the
// v1.0.0 drawer and the desktop stays a strict no-op.

export const HOME_CSS = `/* ---------- phone app shell (< 768px) ---------- */

@media (max-width: 767px) {
  /* --- the document never scrolls (S1.1, 2026-08-17) ---
     Real-device symptom: the workspace title bar, the session header, the
     composer and the FAB all slid with the finger — every fixed surface
     "followed the drag". They are not misplaced; the whole DOCUMENT was
     rubber-banding under them (they are absolute/in-flow inside the frame,
     so a document-level bounce moves them all as one).

     After the S2.1 box-sizing fix the document has no overflow at all
     (scrollHeight === clientHeight, measured with ?mobile-nav-inset=54), so
     this is not scrolling — it is iOS's elastic overscroll, which happens on
     an unscrollable document too, and which an inner scroller chains into as
     soon as it hits its own end.

     overscroll-behavior: none on the viewport kills both halves at once: the
     document itself gets no bounce, and overscroll chained up from the
     message flow / session list is absorbed without moving anything.
     overflow: hidden then hard-locks the document scroller so future content
     can never reintroduce a real scroll. Set on html AND body: the spec
     propagates the viewport's value from html, but engines have historically
     read body, and neither is a scroll container we ever want.

     Deliberately NOT position: fixed on body — the app shell does not need
     it, and it is the variant that strands iOS's fixed elements behind the
     on-screen keyboard. With plain overflow: hidden, iOS still pans the
     visual viewport to reveal a focused textarea, so the composer stays
     visible while typing without any visualViewport JS. */
  html,
  body {
    overflow: hidden !important;
    overscroll-behavior: none !important;
  }

  /* The message flow is the one scroller that regularly hits its end under a
     finger. Root-level \`none\` already absorbs the chain, but containing it
     at the source keeps the guarantee if the root rule is ever weakened
     (the home list and both sheets already declare it). */
  [data-phase] [class$="_scrollBody"] {
    overscroll-behavior: contain !important;
  }

  /* The official sidebar is no longer a drawer on a phone — the home screen
     replaced it. Hidden outright (not translated off-screen) so it cannot
     capture taps or hold layout. */
  [data-mobile-nav="frame"] > :first-child {
    display: none !important;
  }
  /* The header's drawer toggle opened that sidebar; with it gone the button
     has nothing to open. (S2 owns the rest of the header layout —
     styles/header.css.ts — including the Files button's replacement.) */
  [data-mobile-nav="toggle"] {
    display: none !important;
  }

  /* --- level 1: the session list ---
     Renders inside the shell overlay layer (absolute, pointer-events: none),
     so the page re-enables pointer events for itself. The layer's containing
     block is the frame's padding box, which still starts under the status
     bar — hence the safe-area padding here. */
  [data-mobile-nav="home"] {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    pointer-events: auto;
    /* dsw-specific-sidebar-fill, not an alias bg-layer-* token (real-device
       round 2 follow-up, 2026-08-17): fetched and diffed the live theme
       CSS (both light/dark blocks in /assets/index-*.css) because computed
       values, not source-read guesses, are what actually matter here —
       --dsw-alias-bg-base/-layer-1/-layer-2 all resolve to the exact same
       color in the LIGHT theme (neutral-bluish-00, i.e. plain white); they
       only diverge in dark mode. A layer-* token would have made the page
       and its cards indistinguishable in light mode specifically — the
       opposite of what was asked. --dsw-specific-sidebar-fill differs from
       bg-base in BOTH themes (bluish-50 vs -00 light, bluish-900 vs -950
       dark) and is the exact token dsh-better-sidebar's own panel already
       uses for this same "secondary surface next to bg-base content"
       role, so it is the correct reuse rather than a new hardcoded gray. */
    background: var(--dsw-specific-sidebar-fill, #f5f5f5);
    color: var(--dsw-alias-label-primary, inherit);
    padding-top: var(--mnav-sat);
    transform: translateX(0);
    opacity: 1;
    transition:
      transform .3s var(--ds-ease-in-out, ease-in-out),
      opacity .3s var(--ds-ease-in-out, ease-in-out);
  }
  /* Push transition: the list slides out to the left as the session takes
     the screen, and comes back from the left. It stays mounted (visibility,
     not display) so the slide has something to animate; the delayed
     visibility keeps it non-interactive the moment the transition ends. */
  [data-mobile-nav="home"][data-view="session"] {
    transform: translateX(-100%);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition:
      transform .3s var(--ds-ease-in-out, ease-in-out),
      opacity .3s var(--ds-ease-in-out, ease-in-out),
      visibility 0s .3s;
  }
  @media (prefers-reduced-motion: reduce) {
    [data-mobile-nav="home"],
    [data-mobile-nav="home"][data-view="session"] {
      transition: none !important;
    }
  }

  /* Title bar: the workspace name IS the switcher. */
  [data-mobile-nav="home-top"] {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    min-height: 52px;
    padding: 4px 16px 6px;
  }
  /* Site logo (real-device round 2, 2026-08-17): rendered only when
     document.head actually has a <link rel="icon"> (MobileHome.tsx never
     ships a placeholder box), so this rule only ever needs to size the
     image, not reserve space for its absence. */
  [data-mobile-nav="home-logo"] {
    width: 24px;
    height: 24px;
    margin-right: 6px;
    flex: none;
    border-radius: 6px;
    object-fit: contain;
  }
  [data-mobile-nav="ws-switch"] {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 44px;
    max-width: 100%;
    padding: 0 6px 0 0;
    border: none;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 22px;
    font-weight: 600;
    line-height: 1.2;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="ws-switch"] > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-mobile-nav="ws-switch"] > svg {
    flex: none;
    opacity: .55;
  }
  [data-mobile-nav="ws-switch"]:active {
    opacity: .6;
  }

  /* Session list: rounded cards, not bordered rows (real-device round 2
     follow-up, 2026-08-17 — reference: Claude Code mobile app's session
     list). \`gap\` on the flex column IS the inter-card spacing; no
     per-row margin bookkeeping. */
  [data-mobile-nav="home-list"] {
    flex: 1 1 auto;
    min-height: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 16px calc(var(--mnav-sab) + 96px);
    list-style: none;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  [data-mobile-nav="home-row"] {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 60px;
    padding: 14px 16px;
    border: none;
    border-radius: 22px;
    background: var(--dsw-alias-bg-base, #ffffff);
    color: inherit;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="home-row"]:active {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  }
  [data-mobile-nav="home-row"][data-current] [data-mobile-nav="home-row-title"] {
    font-weight: 600;
  }
  /* Avatar: a running/warning/done session shows its existing StateDot
     (same component, same semantics as the old inline dot — just bigger
     and re-homed); otherwise the title's own first character stands in
     for it, so every row has a mark even when idle. interactive-bg-hover,
     not a bg-layer-* token: same reason as the page background above —
     bg-layer-2 is IDENTICAL to the card's own bg-base in light theme
     (verified against the live theme CSS), so it would render invisible
     there. interactive-bg-hover is a translucent rgba tint rather than a
     solid layer color, so it always reads as "a shade over the card" in
     both themes regardless of what the card's base color resolves to. */
  [data-mobile-nav="home-row-avatar"] {
    flex: none;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .55));
    font-size: 16px;
    font-weight: 600;
  }
  [data-mobile-nav="home-row-body"] {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  [data-mobile-nav="home-row-title"] {
    font-size: 16px;
    line-height: 21px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-mobile-nav="home-row-status"] {
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .5));
    font-size: 12.5px;
    line-height: 17px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-mobile-nav="home-row-time"] {
    flex: none;
    align-self: flex-start;
    color: var(--dsw-alias-label-tertiary, rgba(0, 0, 0, .4));
    font-size: 12.5px;
    line-height: 18px;
  }
  [data-mobile-nav="home-empty"] {
    margin: 12px 16px;
    padding: 48px 24px;
    border-radius: 22px;
    background: var(--dsw-alias-bg-base, #ffffff);
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .5));
    font-size: 15px;
    text-align: center;
  }

  /* New-session FAB: a labeled pill (real-device round 2 follow-up), not a
     bare circle — tap starts in the shown workspace, long press picks
     one. Inverted-surface tokens (not a hardcoded accent color): the same
     pair the official git-commit button in dsh-better-sidebar uses for
     its own solid CTA. */
  [data-mobile-nav="home-fab"] {
    position: absolute;
    right: 18px;
    bottom: calc(var(--mnav-sab) + 22px);
    z-index: 6;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 48px;
    padding: 0 20px 0 16px;
    border: none;
    border-radius: 999px;
    background: var(--dsw-alias-button-primary-fill, #1a1a1a);
    color: var(--dsw-alias-label-primary-inverted, #ffffff);
    font-family: inherit;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 6px 20px rgba(0, 0, 0, .24);
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="home-fab"]:active {
    transform: scale(.96);
  }

  /* Workspace sheet (switcher and long-press New Session share it). */
  [data-mobile-nav="home-sheet-layer"] {
    position: absolute;
    inset: 0;
    z-index: 7;
  }
  [data-mobile-nav="home-sheet-mask"] {
    position: absolute;
    inset: 0;
    background: var(--dsw-alias-bg-mask-3, rgba(0, 0, 0, .45));
    border: none;
    animation: dsh-mobile-nav-fade .18s var(--ds-ease-out, ease-in-out);
  }
  [data-mobile-nav="home-sheet"] {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: calc(var(--mnav-sab) + 8px);
    max-height: 70%;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px;
    border-radius: 16px;
    /* layer-2, not bg-base: in dark mode the sheet must lift off a page that
       shares bg-base, or only the shadow separates them. */
    background: var(--dsw-alias-bg-layer-2, #ffffff);
    box-shadow: 0 8px 32px rgba(0, 0, 0, .28);
    animation: dsh-mobile-nav-sheet-up .22s var(--ds-ease-out, ease-in-out);
  }
  @media (prefers-reduced-motion: reduce) {
    [data-mobile-nav="home-sheet-mask"],
    [data-mobile-nav="home-sheet"] {
      animation: none !important;
    }
  }
  [data-mobile-nav="home-sheet-title"] {
    padding: 10px 12px 6px;
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .5));
    font-size: 13px;
  }
  [data-mobile-nav="home-sheet-item"] {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 48px;
    padding: 0 12px;
    border: none;
    border-radius: 12px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 16px;
    text-align: left;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="home-sheet-item"][data-selected] {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
    font-weight: 600;
  }
  [data-mobile-nav="home-sheet-item"]:active {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  }

  /* --- hero fallback back button ---
     The hero (new blank session) page renders no conversation.session.header,
     so the header-slot back button (S2) does not exist there. This floating
     fallback covers that page and hides itself as soon as the real header
     back mounts. */
  [data-mobile-nav="hero-back"] {
    position: absolute;
    top: calc(var(--mnav-sat) + 8px);
    left: 8px;
    z-index: 6;
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border: none;
    border-radius: 14px;
    background: transparent;
    color: var(--dsw-alias-label-secondary, inherit);
    pointer-events: auto;
  }
  [data-mobile-nav="hero-back"]:active {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  }
  [data-mobile-nav="frame"]:has([data-mobile-nav="header-back"]) ~ [data-mobile-nav="hero-back"],
  body:has([data-mobile-nav="header-back"]) [data-mobile-nav="hero-back"] {
    display: none;
  }
}
`
