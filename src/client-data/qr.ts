/**
 * Minimal QR encoder (GW-10): byte mode, versions 1–5, ECC level L, fixed
 * mask 0 — enough for any sane origin URL (106 bytes at v5) while keeping
 * the whole implementation single-block (no interleave) and reviewable.
 * Returns the module matrix (true = dark) or null when the text does not
 * fit. Pure: the check script verifies it at decoder level (RS syndromes
 * all-zero + data recovery + format-info BCH), which is stronger than any
 * memorized reference vector.
 *
 * Standard QR constants only: sizes 21/25/29/33/37, data codewords
 * 19/34/55/80/108, ECC codewords 7/10/15/20/26, alignment centers
 * [6,18]/[6,22]/[6,26]/[6,30], Galois field 0x11d, format-info generator
 * 0x537 XOR-mask 0x5412.
 */

interface QrVersion {
  readonly size: number
  readonly dataCodewords: number
  readonly eccCodewords: number
  /** Alignment-pattern centers; v1 has none. */
  readonly alignment: readonly number[] | null
  /** Byte-mode payload capacity (data codewords minus mode+len header). */
  readonly capacity: number
}

const VERSIONS: readonly QrVersion[] = [
  { size: 21, dataCodewords: 19, eccCodewords: 7, alignment: null, capacity: 17 },
  { size: 25, dataCodewords: 34, eccCodewords: 10, alignment: [6, 18], capacity: 32 },
  { size: 29, dataCodewords: 55, eccCodewords: 15, alignment: [6, 22], capacity: 53 },
  { size: 33, dataCodewords: 80, eccCodewords: 20, alignment: [6, 26], capacity: 78 },
  { size: 37, dataCodewords: 108, eccCodewords: 26, alignment: [6, 30], capacity: 106 },
]

// --- Galois field GF(256), polynomial 0x11d -----------------------------------

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let value = 1
  for (let exponent = 0; exponent < 255; exponent++) {
    EXP[exponent] = value
    LOG[value] = exponent
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let exponent = 255; exponent < 512; exponent++) EXP[exponent] = EXP[exponent - 255] ?? 0
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  const la = LOG[a]
  const lb = LOG[b]
  if (la === undefined || lb === undefined) return 0
  return EXP[la + lb] ?? 0
}

/** Reed–Solomon remainder of `data` under the generator for `eccLen` check
 * codewords (LFSR division). The generator is ∏(x − α^i), i = 0…eccLen−1,
 * coefficients high-order first; g[j]·x lands at index j, g[j]·α^i at
 * index j+1. */
function rsRemainder(data: Uint8Array, eccLen: number): Uint8Array {
  let generator: number[] = [1]
  for (let i = 0; i < eccLen; i++) {
    const next = new Array<number>(generator.length + 1).fill(0)
    for (let j = 0; j < generator.length; j++) {
      const coefficient = generator[j]
      if (coefficient === undefined) continue
      const low = next[j] ?? 0
      const high = next[j + 1] ?? 0
      next[j] = low ^ coefficient
      next[j + 1] = high ^ gfMul(coefficient, EXP[i] ?? 0)
    }
    generator = next
  }
  const remainder = new Uint8Array(eccLen)
  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0)
    remainder.copyWithin(0, 1)
    remainder[eccLen - 1] = 0
    if (factor !== 0) {
      for (let i = 0; i < eccLen; i++) {
        remainder[i] = (remainder[i] ?? 0) ^ gfMul(generator[i + 1] ?? 0, factor)
      }
    }
  }
  return remainder
}

// --- bit assembly --------------------------------------------------------------

class BitBuffer {
  readonly bits: number[] = []

  push(value: number, length: number): void {
    for (let shift = length - 1; shift >= 0; shift--) this.bits.push((value >>> shift) & 1)
  }
}

function buildCodewords(text: Uint8Array, version: QrVersion): Uint8Array {
  const buffer = new BitBuffer()
  buffer.push(0b0100, 4) // byte mode
  buffer.push(text.length, 8)
  for (const byte of text) buffer.push(byte, 8)
  // Terminator (up to 4 zero bits), then pad to a byte boundary.
  buffer.push(0, Math.min(4, version.dataCodewords * 8 - buffer.bits.length))
  while (buffer.bits.length % 8 !== 0) buffer.push(0, 1)
  const bytes: number[] = []
  for (let i = 0; i < buffer.bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (buffer.bits[i + j] ?? 0)
    bytes.push(byte)
  }
  // Pad alternately 0xEC / 0x11 to the data capacity.
  for (let pad = 0; bytes.length < version.dataCodewords; pad++) bytes.push(pad % 2 === 0 ? 0xec : 0x11)
  const remainder = rsRemainder(Uint8Array.from(bytes), version.eccCodewords)
  return Uint8Array.from([...bytes, ...remainder])
}

// --- matrix ---------------------------------------------------------------------

type Grid = (boolean | null)[][]

function blankGrid(size: number): Grid {
  return Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null))
}

function placeFinder(grid: Grid, row: number, col: number): void {
  const n = grid.length
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const r = row + dr
      const c = col + dc
      if (r < 0 || r >= n || c < 0 || c >= n) continue
      const inRing = dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)
      const inRing2 = dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)
      const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4
      const target = grid[r]
      if (target !== undefined) target[c] = inRing || inRing2 || inCore
    }
  }
}

function placeAlignment(grid: Grid, centers: readonly number[]): void {
  for (const row of centers) {
    for (const col of centers) {
      // Skip the centers that sit inside a finder's 7×7 (only possible at
      // the three corners; versions 2–5 have none).
      let overlapsFinder = false
      for (const [fr, fc] of [[0, 0], [0, grid.length - 7], [grid.length - 7, 0]] as const) {
        if (row >= fr - 1 && row <= fr + 7 && col >= fc - 1 && col <= fc + 7) overlapsFinder = true
      }
      if (overlapsFinder) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const target = grid[row + dr]
          if (target !== undefined) target[col + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
        }
      }
    }
  }
}

function reserveFormatAreas(grid: Grid): void {
  const n = grid.length
  // `false` marks RESERVED (kept from the data placer, overwritten by the
  // real format bits later); null stays "free for data".
  const put = (row: number, col: number, value: boolean): void => {
    const target = grid[row]
    if (target !== undefined) target[col] = value
  }
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) put(8, i, false)
    if (i !== 6) put(i, 8, false)
  }
  for (let i = 0; i < 8; i++) {
    put(n - 1 - i, 8, false)
    // NOTE: unlike the first copy there is NO skip here — the second copy
    // crosses no timing pattern, and leaving one cell unreserved (the
    // first-copy rule pasted over) would let a data bit land inside it and
    // desynchronize the whole stream (v2+).
    put(8, n - 1 - i, false)
  }
  put(n - 8, 8, true) // the fixed dark module
}

function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask // ECC level L
  let rem = data << 10
  for (let i = 4; i >= 0; i--) {
    if ((rem >>> (i + 10)) & 1) rem ^= 0x537 << i
  }
  return ((data << 10) | rem) ^ 0x5412
}

function placeFormat(grid: Grid, mask: number): void {
  const n = grid.length
  const bits = formatBits(mask)
  const put = (row: number, col: number, value: boolean): void => {
    const target = grid[row]
    if (target !== undefined) target[col] = value
  }
  for (let i = 0; i <= 5; i++) put(8, i, ((bits >>> i) & 1) === 1)
  put(8, 7, ((bits >>> 6) & 1) === 1)
  put(8, 8, ((bits >>> 7) & 1) === 1)
  put(7, 8, ((bits >>> 8) & 1) === 1)
  for (let i = 9; i <= 14; i++) put(14 - i, 8, ((bits >>> i) & 1) === 1)
  for (let i = 0; i <= 6; i++) put(n - 1 - i, 8, ((bits >>> i) & 1) === 1)
  for (let i = 7; i <= 14; i++) put(8, n - 15 + i, ((bits >>> i) & 1) === 1)
}

function placeData(grid: Grid, codewords: Uint8Array): void {
  const n = grid.length
  // Fixed mask 0: (row + col) even flips. Any mask decodes; the penalty
  // optimization is optional and this keeps the implementation small.
  const maskFlips = (row: number, col: number): boolean => (row + col) % 2 === 0
  let bitIndex = 7
  let byteIndex = 0
  let increment = -1
  let row = n - 1
  // The standard two-column zigzag: from the bottom-right corner upward,
  // column PAIR by column PAIR, skipping the timing column pair (6).
  for (let right = n - 1; right >= 0; right -= 2) {
    if (right === 6) right = 5
    // Fill the pair top-to-bottom or bottom-to-top until the edge.
    while (true) {
      const cells = grid[row]
      // `row` is always in range here (the while loop flips before that can
      // change); the guard only keeps a future invariant break non-fatal.
      if (cells === undefined) break
      for (let col = right; col >= right - 1; col--) {
        const current = cells[col]
        if (current !== true && current !== false) {
          let dark = false
          const byte = codewords[byteIndex]
          if (byte !== undefined && byteIndex < codewords.length) dark = ((byte >>> bitIndex) & 1) === 1
          if (maskFlips(row, col)) dark = !dark
          cells[col] = dark
          bitIndex -= 1
          if (bitIndex === -1) {
            byteIndex += 1
            bitIndex = 7
          }
        }
      }
      row += increment
      if (row < 0 || row >= n) {
        row -= increment
        increment = -increment
        break
      }
    }
  }
}

/**
 * The QR matrix for `text` (UTF-8, byte mode), or null when it does not fit
 * into a version-5-L symbol (106 bytes).
 */
export function qrMatrix(text: string): boolean[][] | null {
  const bytes = new TextEncoder().encode(text)
  const version = VERSIONS.find((candidate) => candidate.capacity >= bytes.length)
  if (version === undefined) return null
  const grid = blankGrid(version.size)
  placeFinder(grid, 0, 0)
  placeFinder(grid, 0, version.size - 7)
  placeFinder(grid, version.size - 7, 0)
  if (version.alignment !== null) placeAlignment(grid, version.alignment)
  // Timing patterns.
  for (let i = 8; i < version.size - 8; i++) {
    const timingRow = grid[6]
    const column = grid[i]
    if (timingRow !== undefined && timingRow[i] === null) timingRow[i] = i % 2 === 0
    if (column !== undefined && column[6] === null) column[6] = i % 2 === 0
  }
  reserveFormatAreas(grid)
  const codewords = buildCodewords(bytes, version)
  placeData(grid, codewords)
  placeFormat(grid, 0)
  return grid.map((row) => row.map((cell) => cell === true))
}
