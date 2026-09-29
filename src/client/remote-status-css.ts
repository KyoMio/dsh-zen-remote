/**
 * Styles for the T34 sub-client status parts — the title-row connection
 * icon's three states and the composer's readonly banner + disabled card.
 * Injected as one `<style data-plugin="dsh-zen-remote-remote-status">` tag
 * BEFORE apply's desktop gate (a desktop app in the client role has remote
 * sessions too; on a host the parts render nothing for local sessions, so
 * the desktop stays pixel-identical).
 *
 * Selectors are scoped under the parts' own attributes and the two
 * host-published contract markers (`data-composer-seat`,
 * `data-composer-card`) — no hashed class names, no layer-count
 * assumptions. The disabled-card rule only ever fires when the banner
 * component marked the seat itself (`data-zr-remote-readonly`, set by JS
 * traversal from the banner's own DOM position, per the AGENTS.md rule
 * against guessing host DOM depth with selectors).
 */

export const REMOTE_STATUS_CSS = `
button.zr-remote-status[data-zen-remote="remote-status"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
button.zr-remote-status[data-zen-remote="remote-status"]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
button.zr-remote-status[data-zen-remote="remote-status"][data-state="online"] {
  color: var(--dsw-alias-state-business-primary, #4f6ef7);
}
/* offline: the default grey above is the state; keep the glyph at reduced
   weight so a dead link reads instantly */
button.zr-remote-status[data-zen-remote="remote-status"][data-state="offline"] {
  color: var(--dsw-alias-label-tertiary);
  opacity: 0.75;
}
button.zr-remote-status[data-zen-remote="remote-status"][data-state="mismatch"] {
  color: var(--dsw-alias-state-warning-primary, #d97706);
}

/* The composer banner: a dock entry, so on desktop it is one full-width row
   of the composer column (the slot anchor is display:contents). Styled after
   the host's own composer notice, standalone. */
.zr-remote-banner[data-zen-remote="remote-banner"] {
  box-sizing: border-box;
  width: 100%;
  margin: 0 max(16px, var(--dsh-composer-side-clearance, 16px));
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04));
  color: var(--dsw-alias-label-secondary, inherit);
  padding: 6px 10px;
  font-size: 12px;
  line-height: 18px;
}

/* The disabled composer: the banner marked the seat (JS traversal, not a
   structural selector), and only the host-published card inside it dims and
   stops pointing. The real enforcement is the interceptor's remote-offline
   refusal — this is the display half. */
[data-composer-seat][data-zr-remote-readonly] [data-composer-card] {
  pointer-events: none;
  opacity: 0.55;
}
[data-composer-seat][data-zr-remote-readonly] [data-composer-card] [contenteditable] {
  caret-color: transparent;
}
`
