// home — phone-only app shell (S1, 2026-08-17): the full-screen session list
// and the two-level page stack. Appended LAST so its rules win the ties
// against the shared <=1023px block in layout/compat/misc.
//
// Everything lives inside (max-width: 767px): the tablet range keeps the
// v1.0.0 drawer and the desktop stays a strict no-op.

export const HOME_CSS = `/* ---------- phone app shell (< 768px) ---------- */

@media (max-width: 767px) {
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
    background: var(--dsw-alias-bg-base, #ffffff);
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

  /* Session list: 60px rows, iOS-style inset separators. */
  [data-mobile-nav="home-list"] {
    flex: 1 1 auto;
    min-height: 0;
    margin: 0;
    padding: 0 0 calc(var(--mnav-sab) + 96px);
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
    padding: 8px 16px;
    border: none;
    /* border-l1 is 4% — invisible as a list separator; l2 (10%/12%) is the
       official divider weight and reads in both themes. */
    border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, .1));
    background: transparent;
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
  [data-mobile-nav="home-row-title"] {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 16px;
    line-height: 22px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-mobile-nav="home-row-meta"] {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .5));
    font-size: 13px;
    line-height: 18px;
  }
  [data-mobile-nav="home-empty"] {
    padding: 48px 24px;
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .5));
    font-size: 15px;
    text-align: center;
  }

  /* New-session FAB: tap starts in the shown workspace, long press picks one. */
  [data-mobile-nav="home-fab"] {
    position: absolute;
    right: 18px;
    bottom: calc(var(--mnav-sab) + 22px);
    z-index: 6;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--dsw-alias-state-business-primary, #4f6ef7);
    color: #ffffff;
    cursor: pointer;
    box-shadow: 0 6px 20px rgba(0, 0, 0, .24);
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="home-fab"]:active {
    transform: scale(.94);
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
