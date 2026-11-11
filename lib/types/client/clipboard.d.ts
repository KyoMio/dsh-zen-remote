/**
 * Browser clipboard helper with plain-HTTP (non-secure context) fallback.
 *
 * `navigator.clipboard` is `undefined` on `http://<lan-ip>:<port>` in modern
 * browsers; falling back to an offscreen read-only `<textarea>` +
 * `document.execCommand('copy')` keeps copy buttons working without throwing.
 */
export declare function copyTextToClipboard(text: string): Promise<boolean>;
//# sourceMappingURL=clipboard.d.ts.map