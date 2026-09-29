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
export declare const REMOTE_STATUS_CSS = "\nbutton.zr-remote-status[data-zen-remote=\"remote-status\"] {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n  flex-shrink: 0;\n  padding: 0;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  cursor: pointer;\n}\nbutton.zr-remote-status[data-zen-remote=\"remote-status\"]:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\nbutton.zr-remote-status[data-zen-remote=\"remote-status\"][data-state=\"online\"] {\n  color: var(--dsw-alias-state-business-primary, #4f6ef7);\n}\n/* offline: the default grey above is the state; keep the glyph at reduced\n   weight so a dead link reads instantly */\nbutton.zr-remote-status[data-zen-remote=\"remote-status\"][data-state=\"offline\"] {\n  color: var(--dsw-alias-label-tertiary);\n  opacity: 0.75;\n}\nbutton.zr-remote-status[data-zen-remote=\"remote-status\"][data-state=\"mismatch\"] {\n  color: var(--dsw-alias-state-warning-primary, #d97706);\n}\n\n/* The composer banner: a dock entry, so on desktop it is one full-width row\n   of the composer column (the slot anchor is display:contents). Styled after\n   the host's own composer notice, standalone. */\n.zr-remote-banner[data-zen-remote=\"remote-banner\"] {\n  box-sizing: border-box;\n  width: 100%;\n  margin: 0 max(16px, var(--dsh-composer-side-clearance, 16px));\n  border-radius: var(--dsw-radius-md, 8px);\n  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04));\n  color: var(--dsw-alias-label-secondary, inherit);\n  padding: 6px 10px;\n  font-size: 12px;\n  line-height: 18px;\n}\n\n/* The disabled composer: the banner marked the seat (JS traversal, not a\n   structural selector), and only the host-published card inside it dims and\n   stops pointing. The real enforcement is the interceptor's remote-offline\n   refusal \u2014 this is the display half. */\n[data-composer-seat][data-zr-remote-readonly] [data-composer-card] {\n  pointer-events: none;\n  opacity: 0.55;\n}\n[data-composer-seat][data-zr-remote-readonly] [data-composer-card] [contenteditable] {\n  caret-color: transparent;\n}\n";
//# sourceMappingURL=remote-status-css.d.ts.map