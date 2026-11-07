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

import { qrMatrix } from '../client-data/qr.js'

const QUIET_ZONE_MODULES = 2

export function renderTerminalQr(text: string): string | null {
  const matrix = qrMatrix(text)
  if (matrix === null) return null
  const size = matrix.length
  const dim = size + QUIET_ZONE_MODULES * 2

  // Padded matrix: quiet zone (light) + the symbol itself.
  const dark: boolean[][] = Array.from({ length: dim }, () => new Array<boolean>(dim).fill(false))
  for (let row = 0; row < size; row += 1) {
    const source = matrix[row]
    const target = dark[row + QUIET_ZONE_MODULES]
    if (source === undefined || target === undefined) continue
    for (let col = 0; col < size; col += 1) target[col + QUIET_ZONE_MODULES] = source[col] ?? false
  }

  const lines: string[] = []
  for (let row = 0; row < dim; row += 2) {
    const top = dark[row] ?? []
    const bottom = dark[row + 1] ?? []
    let line = ''
    for (let col = 0; col < dim; col += 1) {
      const topDark = top[col] ?? false
      const bottomDark = bottom[col] ?? false
      line += topDark && bottomDark ? '█' : topDark ? '▀' : bottomDark ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}
