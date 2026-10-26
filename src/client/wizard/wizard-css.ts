/**
 * Wizard-page CSS (GW-10), scoped end to end under the block's own
 * `data-zen-remote` attributes — the desktop no-op rule in its CSS form:
 * nothing here may reach a selector the wizard does not own, so the
 * Plugins detail page at ≥1024px renders byte-identically whether or not
 * the component mounts. Same transcription discipline as settings-css.ts
 * (host design tokens only, no literal colors).
 */

export const WIZARD_CSS = `
[data-plugin-detail="dsh-zen-remote"] section[data-plugin-config]:empty {
  display: none;
}

[data-zen-remote="wizard"] {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  box-sizing: border-box;
  margin-inline: auto;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-module-platform));
  padding: 18px 20px;
}

[data-zen-remote="wizard"] .zr-wizard-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
[data-zen-remote="wizard"] .zr-wizard-headerText {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
[data-zen-remote="wizard"] .zr-wizard-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-subtitle {
  font-size: 12.5px;
  color: var(--dsw-alias-label-tertiary);
  margin: 0;
  line-height: 1.45;
}
[data-zen-remote="wizard"] .zr-wizard-statusBadge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
[data-zen-remote="wizard"] .zr-wizard-statusBadge[data-state="pass"] {
  color: var(--dsw-alias-label-primary);
}

[data-zen-remote="wizard"] .zr-wizard-notice {
  font-size: 12.5px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 9px 12px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
  color: var(--dsw-alias-label-secondary);
  margin: 0;
  line-height: 1.45;
}
[data-zen-remote="wizard"] .zr-wizard-notice[data-tone="error"] {
  border-color: var(--dsw-alias-state-error-primary, #d5304f);
  color: var(--dsw-alias-state-error-primary, #d5304f);
}
[data-zen-remote="wizard"] .zr-wizard-notice[data-tone="ok"] {
  border-color: var(--dsw-alias-state-success-primary, #16a34a);
  color: var(--dsw-alias-state-success-primary, #16a34a);
}

/* Inline Status Overview Card (2x2 spacious layout, full text visibility) */
[data-zen-remote="wizard"] .zr-wizard-overviewGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
@media (max-width: 560px) {
  [data-zen-remote="wizard"] .zr-wizard-overviewGrid {
    grid-template-columns: 1fr;
  }
}
[data-zen-remote="wizard"] .zr-wizard-overviewItem {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 13px 15px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
  min-width: 0;
}
[data-zen-remote="wizard"] .zr-wizard-overviewHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
[data-zen-remote="wizard"] .zr-wizard-overviewLabel {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-overviewValue {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  margin: 0;
  line-height: 1.45;
  overflow-wrap: anywhere;
  word-break: break-word;
}
[data-zen-remote="wizard"] .zr-wizard-overviewSub {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  margin: 0;
  line-height: 1.45;
  overflow-wrap: anywhere;
  word-break: break-word;
}
[data-zen-remote="wizard"] .zr-wizard-emptyBanner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px 16px;
  border-radius: 10px;
  border: 1px dashed var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
}
[data-zen-remote="wizard"] .zr-wizard-emptyText {
  font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
  line-height: 1.5;
  margin: 0;
  flex: 1;
  min-width: 220px;
}

/* Wizard Modal Dialog (above app chrome, below helper sub-cards) */
[data-zen-remote="wizard-modal"] {
  position: fixed;
  inset: 0;
  z-index: 950;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
}
[data-zen-remote="wizard-modal"] .zr-wizard-modalDialog {
  width: min(680px, calc(100vw - 32px));
  max-height: min(88vh, 760px);
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-module-platform));
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}
[data-zen-remote="wizard-modal"] .zr-wizard-modalHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 22px 14px;
}
[data-zen-remote="wizard-modal"] .zr-wizard-modalTitle {
  font-size: 15.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  margin: 0;
}
[data-zen-remote="wizard-modal"] .zr-wizard-modalBody {
  padding: 18px 22px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
}
[data-zen-remote="wizard-modal"] .zr-wizard-modalFooter {
  padding: 14px 22px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-module-platform));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

/* Non-clickable 3-step visual progress indicator */
[data-zen-remote="wizard"] .zr-wizard-stepper {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 13px 22px;
  margin: 0;
  list-style: none;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
  border-top: 1px solid var(--dsw-alias-border-l2);
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  user-select: none;
  pointer-events: none;
}
[data-zen-remote="wizard"] .zr-wizard-stepItem {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
[data-zen-remote="wizard"] .zr-wizard-stepCircle {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  border: 1.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-module-platform));
  color: var(--dsw-alias-label-tertiary);
  flex: none;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease, box-shadow 160ms ease;
}
[data-zen-remote="wizard"] .zr-wizard-stepItem[data-state="current"] .zr-wizard-stepCircle {
  background: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-2, #fff);
  box-shadow: 0 0 0 3px var(--dsw-alias-border-l2);
}
[data-zen-remote="wizard"] .zr-wizard-stepItem[data-state="done"] .zr-wizard-stepCircle {
  background: var(--dsw-alias-state-success-primary, #16a34a);
  border-color: var(--dsw-alias-state-success-primary, #16a34a);
  color: #fff;
}
[data-zen-remote="wizard"] .zr-wizard-stepText {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
[data-zen-remote="wizard"] .zr-wizard-stepTag {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  line-height: 1.2;
}
[data-zen-remote="wizard"] .zr-wizard-stepItem[data-state="current"] .zr-wizard-stepTag {
  color: var(--dsw-alias-label-secondary);
  font-weight: 500;
}
[data-zen-remote="wizard"] .zr-wizard-stepItem[data-state="done"] .zr-wizard-stepTag {
  color: var(--dsw-alias-state-success-primary, #16a34a);
}
[data-zen-remote="wizard"] .zr-wizard-stepName {
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-zen-remote="wizard"] .zr-wizard-stepItem[data-state="current"] .zr-wizard-stepName {
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
[data-zen-remote="wizard"] .zr-wizard-stepItem[data-state="done"] .zr-wizard-stepName {
  color: var(--dsw-alias-label-secondary);
}
[data-zen-remote="wizard"] .zr-wizard-stepConnector {
  flex: 1;
  height: 2px;
  min-width: 18px;
  border-radius: 2px;
  background: var(--dsw-alias-border-l2);
  transition: background-color 200ms ease;
}
[data-zen-remote="wizard"] .zr-wizard-stepConnector[data-done="true"] {
  background: var(--dsw-alias-state-success-primary, #16a34a);
}
[data-zen-remote="wizard"] .zr-wizard-stepIntro {
  font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
  margin: 0;
  line-height: 1.45;
}

[data-zen-remote="wizard"] .zr-wizard-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* Step 1: 3-column path cards */
[data-zen-remote="wizard"] .zr-wizard-paths {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  border: none;
}
[data-zen-remote="wizard"] .zr-wizard-path {
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
  cursor: pointer;
  font: inherit;
  color: inherit;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
[data-zen-remote="wizard"] .zr-wizard-path:hover:not(:disabled) {
  border-color: var(--dsw-alias-label-secondary);
}
[data-zen-remote="wizard"] .zr-wizard-path[data-selected="true"] {
  border-color: var(--dsw-alias-label-primary);
  box-shadow: 0 0 0 1px var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-module-platform));
}
[data-zen-remote="wizard"] .zr-wizard-path:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
[data-zen-remote="wizard"] .zr-wizard-pathHead {
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-zen-remote="wizard"] .zr-wizard-pathRadio {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1.5px solid var(--dsw-alias-label-tertiary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
[data-zen-remote="wizard"] .zr-wizard-pathRadio[data-selected="true"] {
  border-color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-label-primary);
  box-shadow: inset 0 0 0 2.5px var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-module-platform));
}
[data-zen-remote="wizard"] .zr-wizard-pathName {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-pathDesc {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  margin: 0;
  line-height: 1.45;
}
[data-zen-remote="wizard"] .zr-wizard-sectionTitle {
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-roleGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
[data-zen-remote="wizard"] .zr-wizard-checkRow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  user-select: none;
}
[data-zen-remote="wizard"] .zr-wizard-checkRow input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}

/* Step 2: form controls */
[data-zen-remote="wizard"] .zr-wizard-selectedBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
}
[data-zen-remote="wizard"] .zr-wizard-selectedLabel {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
[data-zen-remote="wizard"] .zr-wizard-formStack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
[data-zen-remote="wizard"] .zr-wizard-formGrid {
  display: grid;
  grid-template-columns: 1fr 120px;
  gap: 12px;
  align-items: start;
}
[data-zen-remote="wizard"] .zr-wizard-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[data-zen-remote="wizard"] .zr-wizard-labelRow {
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-zen-remote="wizard"] .zr-wizard-label {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-savedTag {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-state-success-primary, #16a34a);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
}
[data-zen-remote="wizard"] .zr-wizard-hint {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  margin: 0;
  line-height: 1.4;
}
[data-zen-remote="wizard"] .zr-wizard-input {
  height: 34px;
  font: inherit;
  font-size: 13px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
  color: var(--dsw-alias-label-primary);
  width: 100%;
  box-sizing: border-box;
}
[data-zen-remote="wizard"] code.zr-wizard-input {
  display: flex;
  align-items: center;
  min-height: 36px;
  height: auto;
  padding: 6px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  line-height: 1.4;
  overflow-wrap: anywhere;
  word-break: break-all;
}
[data-zen-remote="wizard"] .zr-wizard-input:focus {
  outline: none;
  border-color: var(--dsw-alias-label-primary);
}
[data-zen-remote="wizard"] .zr-wizard-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
[data-zen-remote="wizard"] .zr-wizard-link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  text-decoration: underline;
}
[data-zen-remote="wizard"] .zr-wizard-link:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}
[data-zen-remote="wizard"] .zr-wizard-linkBtn {
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
[data-zen-remote="wizard"] .zr-wizard-linkBtn:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-secondary);
}

/* Primary & Secondary action buttons + Footer */
[data-zen-remote="wizard"] .zr-wizard-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
[data-zen-remote="wizard"] .zr-wizard-footerHint {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
[data-zen-remote="wizard"] .zr-wizard-btn,
[data-zen-remote="wizard-card"] .zr-wizard-btn {
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  height: 32px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
[data-zen-remote="wizard"] .zr-wizard-btn:hover:not(:disabled),
[data-zen-remote="wizard-card"] .zr-wizard-btn:hover:not(:disabled) {
  border-color: var(--dsw-alias-label-secondary);
}
[data-zen-remote="wizard"] .zr-wizard-btnPrimary,
[data-zen-remote="wizard-card"] .zr-wizard-btnPrimary {
  background: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-2, #fff);
}
[data-zen-remote="wizard"] .zr-wizard-btnPrimary:hover:not(:disabled),
[data-zen-remote="wizard-card"] .zr-wizard-btnPrimary:hover:not(:disabled) {
  opacity: 0.9;
}
[data-zen-remote="wizard"] .zr-wizard-btn:disabled,
[data-zen-remote="wizard-card"] .zr-wizard-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* Step 3: service control bar, 3-column lights, and QR pairing panel */
[data-zen-remote="wizard"] .zr-wizard-serviceBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
}
[data-zen-remote="wizard"] .zr-wizard-serviceInfo {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
[data-zen-remote="wizard"] .zr-wizard-lights {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[data-zen-remote="wizard"] .zr-wizard-light {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
  font-size: 12.5px;
}
[data-zen-remote="wizard"] .zr-wizard-lightMain {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
[data-zen-remote="wizard"] .zr-wizard-lightName {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
[data-zen-remote="wizard"] .zr-wizard-lightState {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
}
[data-zen-remote="wizard"] .zr-wizard-lightState[data-state="pass"] {
  color: var(--dsw-alias-state-success-primary, #16a34a);
}
[data-zen-remote="wizard"] .zr-wizard-lightState[data-state="fail"] {
  color: var(--dsw-alias-state-error-primary, #d5304f);
}

[data-zen-remote="wizard"] .zr-wizard-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary);
  flex: none;
}
[data-zen-remote="wizard"] .zr-wizard-dot[data-state="pass"] {
  background: var(--dsw-alias-state-success-primary, #16a34a);
}
[data-zen-remote="wizard"] .zr-wizard-dot[data-state="fail"] {
  background: var(--dsw-alias-state-error-primary, #d5304f);
}
[data-zen-remote="wizard"] .zr-wizard-dot[data-state="pending"] {
  background: var(--dsw-alias-state-warning-primary, #b8860b);
}

[data-zen-remote="wizard"] .zr-wizard-pairPanel {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
}
[data-zen-remote="wizard"] .zr-wizard-pairMeta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 180px;
}
[data-zen-remote="wizard"] .zr-wizard-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 24px;
  letter-spacing: 4px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  margin: 2px 0;
}
[data-zen-remote="wizard"] .zr-wizard-countdown {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  margin: 0;
}
[data-zen-remote="wizard"] .zr-wizard-qr {
  width: 156px;
  height: 156px;
  image-rendering: pixelated;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: #fff;
  display: block;
  flex: none;
}
[data-zen-remote="wizard"] .zr-wizard-qr[data-usable="false"] {
  display: none;
}
[data-zen-remote="wizard"] .zr-wizard-targetTabs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 6px;
  padding: 4px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
}
[data-zen-remote="wizard"] .zr-wizard-targetTab {
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  padding: 7px 12px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  text-align: center;
}
[data-zen-remote="wizard"] .zr-wizard-targetTab[data-selected="true"] {
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-module-platform));
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
[data-zen-remote="wizard"] .zr-wizard-desktopBox,
[data-zen-remote="wizard"] .zr-wizard-clientBox {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
}
[data-zen-remote="wizard"] .zr-wizard-deviceList {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[data-zen-remote="wizard"] .zr-wizard-deviceItem {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
  font-size: 12.5px;
}
[data-zen-remote="wizard"] .zr-wizard-deviceHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
[data-zen-remote="wizard"] .zr-wizard-deviceTitleRow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
[data-zen-remote="wizard"] .zr-wizard-deviceBadge {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-module-platform));
  color: var(--dsw-alias-label-secondary);
}
[data-zen-remote="wizard"] .zr-wizard-deviceActions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
[data-zen-remote="wizard"] .zr-wizard-select {
  height: 30px;
  font: inherit;
  font-size: 12px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-module-platform));
  color: var(--dsw-alias-label-primary);
}

/* The modal card: a body-level overlay, above the app chrome. */
[data-zen-remote="wizard-card"] {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
[data-zen-remote="wizard-card"] .zr-wizard-cardPanel {
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-module-platform));
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  width: min(560px, calc(100vw - 32px));
  max-height: min(82vh, 660px);
  overflow: auto;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardTitle {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}
[data-zen-remote="wizard-modal"] .zr-wizard-cardCloseIcon,
[data-zen-remote="wizard-card"] .zr-wizard-cardCloseIcon {
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 18px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 6px;
  cursor: pointer;
}
[data-zen-remote="wizard-modal"] .zr-wizard-cardCloseIcon:hover,
[data-zen-remote="wizard-card"] .zr-wizard-cardCloseIcon:hover {
  color: var(--dsw-alias-label-primary);
}
[data-zen-remote="wizard-card"] .zr-wizard-cardBody {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardSteps {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardSubhead {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  margin: 4px 0 0;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardTable {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  overflow: hidden;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardTable td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
[data-zen-remote="wizard-card"] .zr-wizard-cardTable tr:last-child td {
  border-bottom: none;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardPerm {
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardWhy {
  color: var(--dsw-alias-label-tertiary);
}
[data-zen-remote="wizard-card"] .zr-wizard-cardTabs {
  display: flex;
  gap: 6px;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardTab {
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardTab[data-selected="true"] {
  color: var(--dsw-alias-bg-layer-2, #fff);
  background: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-primary);
}
[data-zen-remote="wizard-card"] .zr-wizard-cardStep {
  font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
  margin: 0;
  line-height: 1.45;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardCode {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  white-space: pre;
  background: var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, 0.12));
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 10px 12px;
  overflow: auto;
  max-height: 260px;
  margin: 0;
}
[data-zen-remote="wizard-card"] .zr-wizard-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[data-zen-remote="wizard-card"] .zr-wizard-label {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
[data-zen-remote="wizard-card"] .zr-wizard-input {
  height: 34px;
  font: inherit;
  font-size: 13px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform));
  color: var(--dsw-alias-label-primary);
  width: 100%;
  box-sizing: border-box;
}
[data-zen-remote="wizard-card"] .zr-wizard-cardActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
`
