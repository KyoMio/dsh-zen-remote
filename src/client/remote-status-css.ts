/**
 * Styles for the T34 sub-client status parts — the title-row connection
 * icon's states and the composer's readonly banner. Injected as one
 * `<style data-plugin="dsh-zen-remote-remote-status">` tag BEFORE apply's
 * desktop gate (a desktop app in the client role has remote sessions too; on
 * a host the parts render nothing for local sessions, so the desktop stays
 * pixel-identical).
 *
 * T34-fix: the input itself is disabled through the HOST's component
 * capability — `ctx.conversation.blocks.set(sessionId, { reason })`, the
 * composer-block contract — not through any CSS override; what remains here
 * is scoped under the parts' own attributes and can reach nothing but them.
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
/* offline / revoked / unpaired: the default grey is the state, dimmed a
   little so a dead or unpaired link reads instantly */
button.zr-remote-status[data-zen-remote="remote-status"][data-state="offline"],
button.zr-remote-status[data-zen-remote="remote-status"][data-state="revoked"],
button.zr-remote-status[data-zen-remote="remote-status"][data-state="unpaired"] {
  color: var(--dsw-alias-label-tertiary);
  opacity: 0.75;
}
button.zr-remote-status[data-zen-remote="remote-status"][data-state="mismatch"] {
  color: var(--dsw-alias-state-warning-primary, #d97706);
}

/* The composer banner: a dock entry, so on desktop it is one full-width row
   of the composer column (the slot anchor is display:contents and the
   composer column is a flex column — the item stretches to the column
   width WITHOUT an explicit width, which would stack with the side margins
   and overflow the input column, T34-fix). Styled after the host's own
   composer notice, standalone. */
.zr-remote-banner[data-zen-remote="remote-banner"] {
  box-sizing: border-box;
  margin: 0 max(16px, var(--dsh-composer-side-clearance, 16px));
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04));
  color: var(--dsw-alias-label-secondary, inherit);
  padding: 6px 10px;
  font-size: 12px;
  line-height: 18px;
}
`
