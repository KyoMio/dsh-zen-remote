/**
 * CLI-2 terminal QR rendering, zero dependencies: reuse the repo's own
 * minimal encoder (`src/client-data/qr.ts`) and draw the module matrix with
 * Unicode half-block characters — two module ROWS per terminal line, so the
 * symbol stays square on screen (terminal cells are roughly twice as tall as
 * they are wide):
 *
 *   dark top + dark bottom → `█`   dark top + light bottom → `▀`
 *   light top + dark bottom → `▄`  light top + light bottom → ` `
 *
 * A 2-module quiet zone of light modules surrounds the symbol on every side
 * (ISO 18004 recommendance) — without it many scanners refuse to lock on.
 * Text too long for the encoder (over 106 UTF-8 bytes, its version-5-L
 * capacity) returns `null`; the caller shows the plain URL instead.
 */
export declare function renderTerminalQr(text: string): string | null;
//# sourceMappingURL=qr-terminal.d.ts.map