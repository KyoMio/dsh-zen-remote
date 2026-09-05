// composer — phone-only composer reflow (S3, 2026-08-17).
//
// Appended after home/header so its < 768px rules win the ties against the
// shared <= 1023px block in layout/compat/misc (which keeps the v1.0.0
// composer treatment alive for the 768-1023px tablet range).
//
// Official structure this file reshapes (verified live at 390px, see the S3
// report): InputBar renders
//   _card > _row > [_tools > (_add, _modes > PermissionSelect, input.left)]
//                  [_trailing > (input.right, input.model, ContextMeter, _primary)]
// with `_tools` / `_trailing` as inner flex groups. Flattening both to
// `display: contents` turns every control into a direct flex item of `_row`,
// which is what makes a pure `order` reflow possible without touching a
// single official component.

/** The composer input card's bottom control row (the only `_row` that is a direct card child — the ContextMeter panel also has `_row` descendants). */
const ROW = '[data-slot="conversation.composer.bar"] [class$="_card"] > [class$="_row"]'
/** The model seat's own root inside the trailing group (long form so it beats the <=1023px pill rules in layout.css.ts). */
const MODEL = `${ROW} > [class$="_trailing"] > [data-slot="conversation.input.model"] > [class$="_root"]`
/** The permission select's trigger button (structure only — the PermissionSelect hashed classes are never named). */
const PERM = `${ROW} > [class$="_tools"] > [class$="_modes"]`

export const COMPOSER_CSS = `/* ---------- phone composer (< 768px) ---------- */

/* The file picker the attachment button drives (S7) — hidden at EVERY width,
   deliberately OUTSIDE the phone media block below. A bare <input type="file">
   renders as a native "Choose Files" control, and the slot wrapper around it is
   \`display: contents\`, so an un-hidden one becomes a flex item of the official
   tool row. Scoping this to < 768px once put that control in the DESKTOP
   composer (caught on a live deploy, 2026-08-17): the button that drives it is
   phone-only, but the input it drives is in the DOM at all widths. */
[data-mobile-nav="attach-picker"] {
  display: none !important;
}

@media (max-width: 767px) {
  /* --- 1. flatten the two official groups ---
     \`_tools\` and \`_trailing\` only exist to cluster controls left/right.
     display:contents dissolves them into \`_row\`, so the six leaf controls
     become siblings in one flex line and \`order\` alone drives the layout:
     [attach · + · permission · model] …elastic gap… [context ring · send]. */
  ${ROW} {
    justify-content: flex-start !important;
    gap: 5px !important;
    padding: 2px 8px 8px !important;
    /* One line, always: the model pill is the only shrinkable item (its
       label ellipsizes), so wrapping would only ever push the send button
       to a second row (real-device report, 2026-08-25). */
    flex-wrap: nowrap !important;
  }
  ${ROW} > [class$="_tools"],
  ${ROW} > [class$="_trailing"] {
    display: contents !important;
  }

  /* --- 2. the running order ---
     The attachment button (S3 placeholder, S7 wires it up) sits leftmost;
     the official "+" command menu keeps its seat right next to it, where
     the two "insert something" affordances read as one cluster. */
  ${ROW} [data-mobile-nav="attach"] {
    order: 1 !important;
  }
  ${ROW} > [class$="_tools"] > [class$="_add"] {
    order: 2 !important;
  }
  ${ROW} > [class$="_tools"] > [class$="_modes"] {
    order: 3 !important;
    /* Rigid on purpose. This seat holds the permission chip, whose own
       wrapper (the plugin's element inside _modes) is \`flex: 0 0 auto\` and
       will NOT follow the seat down — so a shrinkable seat does not make the
       chip narrower, it just slices the seat out from under a chip that
       stays 44px wide, and the overflow lands on top of the model pill.
       Measured 2026-09-04 on DSH 0.1.2 at 390px: seat 90-120 (29.7px) with
       the chip still 90-134, model starting at 125 — a 9px overlap, exactly
       the "the two chips touch" report. With the seat rigid: seat 90-134,
       model 139-246, overlap 0; and at 320px the model pill shrinks to 52px
       and still nothing overlaps.
       This also restores what section 1 says out loud — the model pill is
       the ONLY shrinkable item in the row. \`min-width: 0\` is gone with the
       shrink: it only ever mattered as the companion of \`flex: 0 1\`. */
    flex: 0 0 auto !important;
    gap: 6px !important;
  }
  /* The elastic gap used to live here as \`margin-right: auto\`, which broke
     the moment a session had no model pill: a subagent session has none, so
     the gap vanished and the stop / send buttons bunched up in the middle of
     the row instead of sitting at the right edge (reported 2026-09-06). The
     gap belongs to the RIGHT group, not to the last item of the left one —
     see the two rules below the order list. */
  ${MODEL} {
    order: 4 !important;
    /* A definite flex-basis (not auto) breaks the circular sizing between
       this seat and the trigger's max-width:100%: the seat's width comes
       from flex resolution, the trigger fills up to it, the label
       ellipsizes inside. Under nowrap pressure this is the only
       min-width:0 seat, so it absorbs all shrink. */
    flex: 0 1 min(48vw, 200px) !important;
    min-width: 0 !important;
    max-width: min(48vw, 200px) !important;
  }
  /* Third-party input.right entries park next to the ring rather than
     landing at order 0 (= far left) once the groups are flattened. */
  ${ROW} > [class$="_trailing"] > [data-slot="conversation.input.right"] > * {
    order: 5 !important;
  }
  /* ContextMeter — the only \`span\` ending in _root inside the row. */
  ${ROW} > [class$="_trailing"] > span[class$="_root"] {
    order: 6 !important;
    flex: none !important;
  }
  ${ROW} > [class$="_trailing"] > [class$="_primary"] {
    order: 7 !important;
  }
  /* The elastic gap. It sits in front of whichever of the two right-hand
     items comes first, so the group hugs the right edge no matter what the
     left side happens to contain — with a model pill, without one (subagent
     sessions), with or without the third-party entries at order 5.
     Both get \`margin-left: auto\` and the last rule takes it back off the
     send button whenever a ring precedes it: two auto margins would SHARE
     the free space and open a second gap between the ring and send. A
     sibling combinator answers "is there a ring before me" without assuming
     anything about the host's nesting. */
  ${ROW} > [class$="_trailing"] > span[class$="_root"],
  ${ROW} > [class$="_trailing"] > [class$="_primary"] {
    margin-left: auto !important;
  }
  ${ROW} > [class$="_trailing"] > span[class$="_root"] ~ [class$="_primary"] {
    margin-left: 0 !important;
  }

  /* --- 3. permission as icon-only pill; model as name+effort pill ---
     (real-device round 2, 2026-08-17; model pill reworked 2026-08-25:
     the user wants to SEE which model/effort is active, so only the
     permission trigger stays icon-only — its label is hidden and it
     collapses to a plain ~44x30 icon button. This AGREES with (rather than fights) the official
     container query (\`@container (width <= 460px) { .trigger:has(.triggerIcon)
     .triggerLabel { display: none } }\`) that S3 had to override — no need
     to override it back. Accessible name is unaffected: both official
     triggers already ship a descriptive aria-label independent of the
     visible text (PermissionSelect: t('input.accessMode', {name}); the
     model trigger: t('trigger.aria'/'trigger.ariaEffort')) — verified live
     in dsh-client-ui-conversation / dsh-client-ui-model-selection lib/
     client.js, 2026-08-17 — so hiding the label costs nothing for screen
     readers. The permission trigger only renders an icon for the
     "read-only" / "workspace-write" presets (permissionGlyphs in
     dsh-client-ui-conversation) — "Full access" and any host-configured
     preset name fall back to chevron-only, a known gap in the official
     markup this plugin cannot fill without inventing new icon meaning.
     The model trigger never renders an icon at all (only label + optional
     effort text + chevron), so its ::before below draws one from a
     primitives icon path (Sparkle — the closest existing "model" glyph) as
     a CSS-only pseudo-element: it survives React re-renders for free
     (unlike a DOM-injected node, which would need a MutationObserver, see
     the preview-full-toggle pitfall in AGENTS.md) and does not touch
     accessible-name computation (empty generated content). S3's
     rtl-ellipsis trick on the model label is simply inert under
     display:none now; left alone rather than unpicked. */
  ${PERM} [class$="_triggerLabel"] {
    display: none !important;
  }
  ${PERM} button[class$="_trigger"] {
    background: var(--dsw-specific-selector, rgba(127, 127, 127, .12)) !important;
    width: 44px !important;
    height: 30px !important;
    max-width: none !important;
    min-width: 0 !important;
    padding: 0 !important;
    gap: 2px !important;
    justify-content: center !important;
    border-radius: 999px !important;
    touch-action: manipulation !important;
  }
  /* Model trigger: name + effort pill (2026-08-25 user request — the
     icon-only form hid which model was active). The effort text must stay
     whole; the model NAME is the elastic part and ellipsizes. max-width
     caps the pill so the row's elastic gap survives extreme model ids;
     the label rules below override the <=1023px grow rules in
     layout.css.ts (flex 1 1 auto) that would otherwise pad the pill. */
  ${MODEL} > [class$="_trigger"] {
    background: var(--dsw-specific-selector, rgba(127, 127, 127, .12)) !important;
    height: 30px !important;
    width: auto !important;
    max-width: 100% !important;
    min-width: 0 !important;
    padding: 0 10px !important;
    gap: 4px !important;
    justify-content: flex-start !important;
    border-radius: 999px !important;
    touch-action: manipulation !important;
    font-size: 12px !important;
  }
  ${MODEL} > [class$="_trigger"] > [class$="_triggerLabel"] {
    display: block !important;
    flex: 0 1 auto !important;
    min-width: 0 !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }
  ${MODEL} > [class$="_trigger"] > [class$="_triggerEffort"] {
    display: block !important;
    flex: none !important;
    white-space: nowrap !important;
  }
  /* PermissionSelect wraps its trigger in the Menu primitive's root span,
     which must shrink to the icon button's fixed width. */
  ${PERM} > span:has(> button[class$="_trigger"]) {
    flex: 0 0 auto !important;
    min-width: 0 !important;
  }
  /* (2026-08-25) The model trigger's CSS-only Sparkle ::before icon is gone:
     the pill now shows the model name + effort text itself, so an icon would
     just eat label width. */

  /* --- 4. both menus become bottom sheets ---
     The permission menu is the Menu primitive (role=menu, absolute, side=top)
     and the model menu is ModelSelect's own \`_menu\` (absolute, bottom+right).
     Neither has a transformed ancestor between it and the viewport, so
     position:fixed re-anchors both to the screen edge. Only the shell moves —
     the items, the two-level model panes and every selection handler stay
     official. */
  ${PERM} [role="menu"],
  ${MODEL} > [class$="_menu"] {
    position: fixed !important;
    left: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    top: auto !important;
    transform: none !important;
    width: 100% !important;
    min-width: 0 !important;
    max-width: none !important;
    max-height: min(70dvh, 520px) !important;
    box-sizing: border-box !important;
    border-radius: 16px 16px 0 0 !important;
    border-bottom: none !important;
    padding: 8px 8px calc(8px + var(--mnav-sab)) !important;
    z-index: 60 !important;
    box-shadow: 0 -8px 32px rgba(0, 0, 0, .18) !important;
  }
  /* 44pt+ rows in both sheets (Menu items, model options, and the model
     sheet's two root cells that drill into the model / effort panes). */
  ${PERM} [role="menu"] [role="menuitem"],
  ${MODEL} > [class$="_menu"] [class$="_option"],
  ${MODEL} > [class$="_menu"] [class$="_cell"] {
    min-height: 48px !important;
    border-radius: 12px !important;
    font-size: 15px !important;
  }
  /* --- 4a. third-party composer entries live in the model sheet ---
     effects/model-sheet-extras.ts parks the \`conversation.input.right\`
     container inside the model menu while that menu is open and puts it back
     when it closes; these rules are the two halves of that trip.

     In the row: hidden, but ONLY once the effect has marked the container as
     one it manages. Keying the hide off the marker rather than off "not
     currently parked" is what makes the failure direction safe — if the
     effect declines to act (nothing in the slot but the vision toggle, so
     nothing worth moving) or never runs at all, the marker is absent, this
     rule does not match, and the controls stay exactly where the host put
     them. The inverse spelling hid them in the row whenever they were not in
     the sheet, which in those same cases left them reachable from neither
     place (caught in review, 2026-09-06).
     Hiding by ancestor rather than by a display rule on the container itself
     is what lets the parked copy style itself freely — same element, two
     homes, two rule sets. \`!important\` because the slot container carries an
     inline \`display: contents\`. */
  ${ROW} > [class$="_trailing"] > [data-slot="conversation.input.right"][data-zen-sheet-extras] {
    display: none !important;
  }
  /* Parked in the sheet: a column of full-width rows in the sheet's own
     language, so a relocated control reads as a sibling of 模型 and 推理等级
     rather than a chip that wandered in. */
  ${MODEL} > [class$="_menu"] > [data-zen-sheet-extras] {
    display: flex !important;
    flex-direction: column !important;
    gap: 2px !important;
    width: 100% !important;
  }
  /* Undo the row's compaction on every parked control: back to full width and
     the 48px the sheet's own cells use. \`> * > *\` reaches both shapes without
     naming either plugin — subscriptions wraps its trigger in a positioning
     div, vision-router puts its button straight in the slot. */
  ${MODEL} > [class$="_menu"] > [data-zen-sheet-extras] > *,
  ${MODEL} > [class$="_menu"] > [data-zen-sheet-extras] > * > button {
    width: 100% !important;
    max-width: none !important;
    min-width: 0 !important;
    justify-content: flex-start !important;
  }
  ${MODEL} > [class$="_menu"] > [data-zen-sheet-extras] button {
    box-sizing: border-box !important;
    min-height: 48px !important;
    height: auto !important;
    padding: 0 12px !important;
    gap: 10px !important;
    border-radius: 12px !important;
    border: none !important;
    background: transparent !important;
    font-size: 15px !important;
    /* Both plugins center their chip label, which is right for a pill in the
       row and wrong for a full-width row: the sheet's own cells start their
       label at the left edge. justify-content covers the flex triggers,
       text-align the ones that are not flex containers. */
    text-align: left !important;
    justify-content: flex-start !important;
  }
  /* Order comes from the row (compat.css.ts puts the vision toggle at 5 so it
     parks beside the context ring), and that rule still matches in here — the
     sheet is a DOM descendant of the composer bar even though it paints as a
     fixed layer. Reset it so the sheet follows DOM order instead of
     inheriting a decision that was about a different layout. */
  ${MODEL} > [class$="_menu"] > [data-zen-sheet-extras] > * {
    order: 0 !important;
  }
  /* The vision toggle is squeezed to a 28px icon in the row (compat.css.ts);
     in the sheet it is a row, so its label comes back and the icon leads. */
  ${MODEL} > [class$="_menu"] > [data-zen-sheet-extras] [data-vision-router-mode-toggle] > span {
    display: inline !important;
  }
  ${MODEL} > [class$="_menu"] > [data-zen-sheet-extras] [data-vision-router-mode-toggle] > svg:first-of-type {
    width: 18px !important;
    height: 18px !important;
  }
  /* The speed chip opens a menu of its own, anchored \`bottom: 100%\` to its
     trigger. Inside the sheet — which is \`overflow: hidden\` so its rounded
     top clips its content — that menu would be cut off. Same escape section 4
     uses for the host's two menus: position: fixed leaves the clip behind
     (the sheet sets \`transform: none\`, so nothing between here and the
     viewport captures fixed positioning) and it lands as its own sheet on top
     of this one. */
  ${MODEL} > [class$="_menu"] > [data-zen-sheet-extras] [role="menu"] {
    position: fixed !important;
    left: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    top: auto !important;
    margin: 0 !important;
    width: 100% !important;
    min-width: 0 !important;
    max-width: none !important;
    max-height: min(70dvh, 520px) !important;
    box-sizing: border-box !important;
    border-radius: 16px 16px 0 0 !important;
    border-bottom: none !important;
    padding: 8px 8px calc(8px + var(--mnav-sab)) !important;
    /* Above the model sheet it sits on (60, section 4), below the session-info
       sheet's 70 (info.css.ts) — it is a child of the model sheet, not a peer
       of the page's own layers. */
    z-index: 61 !important;
    box-shadow: 0 -8px 32px rgba(0, 0, 0, .18) !important;
  }
  ${MODEL} > [class$="_menu"] > [data-zen-sheet-extras] [role="menu"] [role="menuitemradio"] {
    min-height: 48px !important;
    border-radius: 12px !important;
    font-size: 15px !important;
  }

  /* --- 4b. the official scroll-to-bottom button must not poke through the
     sheet (real-device follow-up, 2026-08-17) ---
     ChatView's own "jump to latest" button (aria-label t("chat.toBottom"))
     is \`position: sticky; z-index: 8\` inside the message column, not
     \`position: fixed\` — it never escapes to the same top-level stacking
     context our sheets get promoted to, so raising the sheet's z-index
     further does nothing (measured live: it still rendered on top at
     z-index 60 vs 8). Rather than chase engine-specific stacking-context
     semantics (Chromium and WebKit do not always agree here — see AGENTS.md
     CDP/document.hidden lesson for another instance of that), this hides
     the button outright while either sheet is open and lets it reappear on
     close: a plain \`display: none\` behind a live \`:has()\` read is correct
     regardless of which stacking rules the engine happens to apply.
     Selector: no hashed classes (dsh-client-ui-conversation lib/client.js,
     verified 2026-08-17) — \`data-chat-flow\` is the one stable attribute on
     the message column, and the button's wrapper is its only sibling
     (ChatView only ever renders the column and, conditionally, this one
     slot), so the adjacent-sibling combinator pins it precisely. */
  body:has(${PERM} [role="menu"]) [data-chat-flow] + div,
  body:has(${MODEL} > [class$="_menu"]) [data-chat-flow] + div {
    display: none !important;
  }
  /* --- 5. input box: two lines minimum, five lines maximum ---
     The official autosizer drives the box off the hidden mirror's height, so
     a min-height on the mirror IS the min-height of the field; the scroll cap
     rides the official custom property. 52px = 2 x 24px line box + 4px pad,
     124px = 5 lines. The hero card keeps its own one-line collapse (misc.css
     pins _scroll/_grow while the placeholder shows). */
  [data-slot="conversation.composer.bar"] [class$="_card"] [class$="_mirror"] {
    min-height: 52px !important;
  }
  [class$="_composerSeat"] {
    --dsh-composer-text-max-height: 124px;
  }
  /* Pull the text in from the card's left border. Upstream insets the editing
     host by 16px while the control row below it starts 8px in (row padding,
     section 1), so the placeholder sat noticeably further out than the
     buttons under it and the field read as over-padded on a phone (reported
     2026-09-06). 12px squares it with the 12px of clear space on the right,
     giving the text a symmetric box, and closes most of the gap with the
     button row. Anchored on the editing host's own contract attribute rather
     than a hashed class. */
  [data-slot="conversation.composer.bar"] [data-composer-input] {
    padding-left: 12px !important;
  }

  /* --- 6. no divider above OR below the message list ---
     Instead of a rule the messages butt against, they fade near both edges.
     This used to be ONE mask-image on the message scroller; iOS WebKit
     turned that into fog over the header (user report 2026-08-23): a mask
     on a scroll container is applied in CONTENT coordinates there (the fade
     bands scroll away with the messages) and, worse, it breaks the
     container's own overflow clipping — content scrolled out of view keeps
     painting, straight over the header and status bar. Engine bug with no
     iOS escape hatch (every iOS browser is WebKit), so the fades moved off
     the scroller entirely:

     - fade-IN under the header: the header's own ::after, restyled into a
       20px gradient strip — styles/header.css.ts ("no header bottom line").
     - fade-OUT above the composer: nothing of ours. The official composer
       seat already carries \`background: linear-gradient(transparent 0,
       bg 36px)\` on its sticky self (dsh-client-ui-conversation lib/
       client.js .wSkVaW_composerSeat) and that is the entire visible
       effect; the mask's own bottom band landed inside the safe-area
       padding below the card and painted nothing. If the bottom edge ever
       reads harsh, hang a ::before strip off the seat the same way the
       header does — do NOT put a mask back on the scroller.

     Painted strips instead of a mask is a fair trade only because the page
     background is one flat color — which it is (--dsw-alias-bg-base). */
  [class$="_composerSeat"],
  [class$="_composerStack"] {
    border-top: none !important;
  }

  /* --- 7. dock entries become mini chips above the input card ---
     conversation.input.dock is display:contents (inline style), so its
     entries are stacked rows of the composer column. Forcing the slot itself
     to flex turns them into ONE scrollable chip line outside and above the
     card. Written against the slot, not against any particular plugin's chip
     (the git branch chip and the todo panel are third-party and may not be
     installed at all). */
  [data-slot="conversation.input.dock"] {
    display: flex !important;
    flex-flow: row nowrap !important;
    align-items: center !important;
    gap: 6px !important;
    min-width: 0 !important;
    margin: 0 16px !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    scrollbar-width: none !important;
    /* The dock is itself a flex ITEM of the composer stack, and the
       new-session hero pins that stack to a fixed height. overflow-x:auto
       above makes this a scroll container, which drops a flex item's
       automatic minimum size to 0 — so the hero squeezed the dock to ~5px
       and the attachment chips slid under the card drawn after it (only the
       top sliver of a thumbnail showed; reported from a real phone,
       2026-08-26). Refuse the squeeze: natural height, the stack centers a
       few px lower instead. In-chat the column is not height-pinned and this
       is a no-op. */
    flex-shrink: 0 !important;
  }
  [data-slot="conversation.input.dock"]::-webkit-scrollbar {
    display: none !important;
  }
  [data-slot="conversation.input.dock"] > * {
    flex: 0 0 auto !important;
    max-width: 70% !important;
    min-height: 26px !important;
    max-height: 26px !important;
    border-radius: 999px !important;
    font-size: 11.5px !important;
    line-height: 18px !important;
    overflow: hidden !important;
  }
  /* The git-graph chip carries a 34px tablet target from misc.css; that
     selector is more specific, so restate it at the phone breakpoint. */
  [data-slot="conversation.input.dock"] [data-gitgraph-chip-anchor] [data-gitgraph-chip] {
    min-height: 26px !important;
    padding: 0 10px !important;
    font-size: 11.5px !important;
  }
  /* --- 7a. the native to-do card opts OUT of the 26px pill cage ---
     conversation.input.dock is not only a chip rail: DSH's own TodoPanel
     (dsh-client-ui-conversation) registers here, and it is an expandable
     card, not a pill — tapping its header renders the to-do list INSIDE
     itself. The cage's max-height:26px + overflow:hidden left that list
     rendered but clipped to nothing, so on a phone the bar looked dead:
     aria-expanded flipped, 8 rows mounted at 216px, and the card still
     painted 26px tall (measured live, 2026-08-20). Give it the official
     geometry back — full row, natural height, 12px radius. Its list caps
     itself at 180px with its own scroller, so this cannot run into the
     composer. Anchored on the official data-testid, a stable contract
     marker rather than a hashed class name. */
  [data-slot="conversation.input.dock"] > [data-testid="todo-panel"] {
    /* A whole line to itself. It shared line 0 with the pills until the goal
       bar turned up (2026-09-06): two full-width things on one nowrap line
       meant the to-do header shrank to a stub and the goal bar ran off the
       right edge. Both are status strips you read at a glance, so they stack
       — see the line policy in 7c. */
    flex: 1 0 100% !important;
    order: 1 !important;
    min-width: 0 !important;
    max-width: none !important;
    min-height: 0 !important;
    max-height: none !important;
    overflow: visible !important;
    border-radius: 12px !important;
    /* The cage shrinks dock text to 11.5px/18px; the card's rows inherit it
       and turn cramped. Restore the official 13px body scale. */
    font-size: 13px !important;
    line-height: normal !important;
  }

  /* --- 7b. attachment chips (S7.1) ---
     Our own dock entry opts OUT of the 26px pill cage above: an image chip is
     a 48px tile. The row sits tight under the card's top edge, so the chips
     read as part of the composer rather than as a floating strip.

     It also takes the LAST line of its own (line policy in 7c): a 48px tile
     beside the to-do chip on one nowrap line squeezed that chip down to an
     unreadable stub, with a long file name pushing the rest off-screen
     (reported 2026-08-22). Its own chips wrap rather than overflow, so
     several attachments stack instead of scrolling out of reach. */
  [data-slot="conversation.input.dock"] > [data-mobile-nav="attach-chips"] {
    display: flex !important;
    flex: 1 0 100% !important;
    flex-wrap: wrap !important;
    order: 4 !important;
    align-items: center !important;
    gap: 6px !important;
    max-width: none !important;
    min-height: 0 !important;
    max-height: none !important;
    border-radius: 0 !important;
    overflow: visible !important;
    margin-bottom: -2px;
  }

  /* --- 7c. the queue strip opts OUT of the cage, on a line of its own ---
     Third entry that is not a pill. conversation.input.dock is a \`list\` slot
     and DSH's own QueueDock registers into it at order 20 (id \`queue\`,
     dsh-client-ui-conversation) — a 36px row per queued message, or a
     collapsible "N 条排队消息" header once there is more than one. The 26px
     cage above clipped it to a sliver: on a phone a queued message showed as
     a grey stub poking out from behind the input card, unreadable and with
     its edit / delete / send buttons cut off (reported 2026-08-22, same
     failure the to-do card hit in 7a).

     Two things are restored. Geometry: the official row height back, and the
     dock's own composer-column sizing dropped — its width/max-width are
     calc()s over the composer card variables and its bottom margin is
     negative by design (upstream tucks the strip UNDER the card), none of
     which survives being a flex item of our chip rail.

     Layout — the line policy for the whole rail, now that three things want
     room on it. The pills (the to-do card, a branch chip, whatever else
     registers) keep order 0 and share the top line, still scrolling
     horizontally. The queue takes the next line (order 1). The attachment
     chips take the last one (order 2, 7b), so what the user is about to send
     sits closest to the input it will be sent from. The rail only wraps
     while one of the two full-width entries exists, so a session with
     neither keeps the original single scrolling chip line. */
  [data-slot="conversation.input.dock"]:has(> [data-queue-dock], > [data-mobile-nav="attach-chips"], > [data-testid="todo-panel"], > [data-goal-bar]) {
    flex-wrap: wrap !important;
  }
  [data-slot="conversation.input.dock"] > [data-queue-dock] {
    flex: 1 0 100% !important;
    order: 3 !important;
    max-width: none !important;
    min-height: 0 !important;
    max-height: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border-radius: 0 !important;
    overflow: visible !important;
    font-size: 13px !important;
    line-height: normal !important;
  }
  /* dsh-client-ui-goal's status strip (its own \`data-goal-bar\` marker; it
     registers into this dock at order 10). Fourth thing here that is not a
     pill: a row carrying the objective text plus pause / edit / delete
     buttons, so the 26px cage clipped its buttons off the right edge and the
     nowrap line pushed what was left off screen (reported 2026-09-06). Same
     treatment the queue gets — a line of its own, official geometry back. */
  [data-slot="conversation.input.dock"] > [data-goal-bar] {
    flex: 1 0 100% !important;
    order: 2 !important;
    max-width: none !important;
    min-height: 0 !important;
    max-height: none !important;
    border-radius: 12px !important;
    overflow: visible !important;
    font-size: 13px !important;
    line-height: normal !important;
  }

  /* The panel is the dock's only child; upstream rounds its top corners only
     and drops the bottom border, because there it is half-hidden behind the
     card. On its own line it is a free-standing strip, so close it up. */
  [data-slot="conversation.input.dock"] > [data-queue-dock] > * {
    border-radius: 12px !important;
  }
  [data-slot="conversation.input.dock"] > [data-queue-dock] > *::after {
    border-bottom: 1px solid var(--dsw-alias-border-l1) !important;
  }

  [data-mobile-nav="attach-chip"] {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    max-width: 62vw;
    background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12));
    color: var(--dsw-alias-label-primary, inherit);
  }
  [data-mobile-nav="attach-chip"][data-kind="file"] {
    height: 26px;
    padding: 0 4px 0 8px;
    border-radius: 999px;
    font-size: 11.5px;
    line-height: 18px;
  }
  /* An image chip is the thumbnail: no name line, the filename lives in the
     title attribute (and in the draft text right below). */
  [data-mobile-nav="attach-chip"][data-kind="image"] {
    width: 48px;
    height: 48px;
    padding: 0;
    border-radius: 10px;
    overflow: hidden;
  }
  [data-mobile-nav="attach-chip-art"] {
    position: relative;
    display: grid;
    place-items: center;
    flex: none;
    overflow: hidden;
  }
  [data-kind="file"] > [data-mobile-nav="attach-chip-art"] {
    width: 16px;
    height: 16px;
    opacity: .7;
  }
  [data-kind="image"] > [data-mobile-nav="attach-chip-art"] {
    width: 100%;
    height: 100%;
  }
  /* The <img> is stacked over the paperclip, not swapped for it: a format the
     engine cannot decode (HEIC outside WebKit) simply paints nothing and the
     icon shows through — no onError state to carry. */
  [data-mobile-nav="attach-chip-art"] img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .18));
  }
  [data-mobile-nav="attach-chip-name"] {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  [data-mobile-nav="attach-chip-remove"] {
    display: grid;
    place-items: center;
    flex: none;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    touch-action: manipulation;
  }
  /* On a tile the × floats in the corner over the picture, so it needs its own
     ground to stay legible against an arbitrary photo. */
  [data-kind="image"] > [data-mobile-nav="attach-chip-remove"] {
    position: absolute;
    top: 2px;
    right: 2px;
    background: rgba(0, 0, 0, .55);
    color: #fff;
  }
  [data-mobile-nav="attach-chip-remove"]:active {
    transform: scale(.9);
  }

  /* --- 8. the official stats strip leaves the composer ---
     Its data moves into the session info card (S4). The row is the composer
     dock's own \`_root\` entry; the slot itself stays live for later entries. */
  [data-slot="conversation.composer.dock"] > [class$="_root"] {
    display: none !important;
  }

  /* --- 9. the attachment button (S7; its file input is hidden at the top of
     this file, at every width) --- */
  [data-mobile-nav="attach"] {
    position: relative;
    width: 28px !important;
    height: 28px !important;
    flex: none !important;
    display: grid !important;
    place-items: center !important;
    padding: 0 !important;
    border: none !important;
    border-radius: 999px !important;
    background: var(--dsw-specific-selector, rgba(127, 127, 127, .12));
    color: var(--dsw-alias-label-primary, inherit);
    cursor: pointer;
    touch-action: manipulation;
  }
  [data-mobile-nav="attach"]:active {
    transform: scale(.94);
    transition: transform .12s;
  }
  /* Busy: a ring sweeps around the paperclip. Drawn with a conic gradient in
     a pseudo-element rather than a spinner node, so the official React tree
     around us has nothing extra to re-render (same reasoning as the model
     pill's mask icon, S3.1). */
  [data-mobile-nav="attach"][data-busy]::after {
    content: "";
    position: absolute;
    inset: -2px;
    border-radius: 999px;
    background: conic-gradient(from 0deg, transparent 0 65%, currentColor 100%);
    mask: radial-gradient(closest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
    -webkit-mask: radial-gradient(closest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
    animation: mnav-attach-spin .9s linear infinite;
    pointer-events: none;
  }
  @keyframes mnav-attach-spin {
    to { transform: rotate(1turn); }
  }
  @media (prefers-reduced-motion: reduce) {
    [data-mobile-nav="attach"][data-busy]::after {
      animation-duration: 3s;
    }
  }
  /* Failure note: one line above the button, tap-to-dismiss. Sits on the
     composer card (z 2) rather than in an overlay layer — nothing here needs
     to clear the permission/model sheets. */
  [data-mobile-nav="attach-error"] {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 2;
    max-width: 62vw;
    padding: 5px 8px;
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, .82));
    color: var(--dsw-alias-label-primary, #fff);
    box-shadow: 0 2px 8px rgba(0, 0, 0, .24);
  }

  /* --- 9. home-indicator clearance (S4.1, 2026-08-17) ---
     Owned HERE, not by the gateway half. That plugin used to carry
       [data-slot="conversation.composer"] { padding-bottom: max(env(safe-area-inset-bottom), 8px) }
     in both pwa/app.css and the gateway's inline DEVICE_CSS. Both were
     INERT and had always been: that slot element is \`display: contents\`
     (measured 2026-08-17 — the slot wrapper generates no box, so padding on
     it is discarded), which is why raising it never moved anything. The rule
     is deleted on the PWA side and restated here on an element that actually
     lays out, reading --mnav-sab so ?mobile-nav-inset=54,34 can regress it
     off-device (env() is hard 0 on desktop — the whole reason S2.1 exists).

     Target: the card should look EQUALLY inset on all four sides. This same
     element carries the card's side inset (\`padding: 0 16px\` officially,
     measured 16px left and 16px right at 390px), so the bottom gap is simply
     capped at that same 16px. Clearing the FULL 34px inset — the naive
     max(sab, 8px) — is what read as "too thick": it is more than double the
     side margin, so the card looked shoved up off the bottom edge.

     clamp() says all three requirements at once:
       - floor 8px  -> a device with no home indicator (sab: 0) keeps the
                       official 8px exactly, so this is a strict no-op there;
       - track sab  -> a shallower inset than 16px is honoured as-is;
       - cap 16px   -> a full-size indicator (sab: 34) lands on 16px, equal
                       to the side inset, which is the look being asked for.
     Keep the 16px in step with the side padding above if that ever changes;
     that equality IS the spec here, not a coincidence. */
  [data-slot="conversation.composer.bar"] > [class$="_root"] {
    padding-bottom: clamp(8px, var(--mnav-sab), 16px) !important;
  }

  /* S10 keyboard avoid: effects/keyboard-avoid.ts mirrors the band of the
     layout viewport hidden behind the software keyboard into --mnav-kb-lift
     and stamps the html attribute while (and only while) it is non-zero —
     a resting transform, even translateY(0), would silently become the
     containing block for any fixed-position descendant of the bar. In every
     environment where the browser's own focus-reveal works the attribute is
     simply never set.
     The target is the slot's _root CHILD, not the slot wrapper: the wrapper
     is display:contents — it generates no box, so a transform on it is a
     silent no-op (found live on-device via CDP, 2026-08-21; the variable and
     attribute were set and nothing moved). */
  html[data-mnav-kb] [data-slot="conversation.composer.bar"] > [class$="_root"] {
    transform: translateY(calc(-1 * var(--mnav-kb-lift, 0px)));
  }
}

/* The attachment button and its preview row only exist for the phone shell.
   Both render at every width (the slots are not breakpoint-aware), so both
   need hiding here — the dock-row rules that shape the chips live in the
   < 768px block and would otherwise leave a bare, unstyled chip line in the
   desktop composer. */
@media (min-width: 768px) {
  [data-mobile-nav="attach"],
  [data-mobile-nav="attach-chips"] {
    display: none !important;
  }
}
`
