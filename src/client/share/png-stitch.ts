/**
 * Streaming PNG long-image stitcher (ticket 07, PLAN §4.5).
 *
 * The rasterizer still paints slice-by-slice (each slice stays under the iOS
 * canvas budget), but the DELIVERABLE is one PNG: this module concatenates the
 * slices' scanlines into a single image — PNG signature + IHDR (whole-image
 * size, 8-bit RGBA) + IDAT (zlib stream, scanline filter 0) + IEND, CRC32
 * computed against a self-carried table, compression via the platform's
 * `CompressionStream('deflate')` whose output already IS the zlib-wrapped
 * deflate stream the PNG IDAT chunk requires.
 *
 * Streaming discipline (the whole point of a custom stitcher): slices are
 * decoded one at a time (createImageBitmap → offscreen canvas getImageData →
 * per-row writeRow → release) so the raw pixels of the WHOLE image are never
 * held; only the compressed output accumulates, as a Blob.
 *
 * Module contract (same one share-flow.ts honors): scripts/check-share-image.mjs
 * imports this file through Node type stripping, which EXECUTES module scope —
 * so everything here is pure math at module scope, and every browser global
 * (CompressionStream, createImageBitmap, document, Blob) is touched only
 * inside function/class bodies. The file is an import-free leaf.
 */

/* ============================================================================
 * PURE BYTES — CRC32 + chunk framing (runs in Node for the check script)
 * ========================================================================== */

/** Standard CRC-32 table (reflected, polynomial 0xEDB88320). */
const CRC_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256)
  for (let n = 0; n < 256; n++) {
    let c: number = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/**
 * CRC-32 (PNG variant: no init/xor toggling beyond the standard reflected
 * form — init 0xFFFFFFFF, final XOR 0xFFFFFFFF). Known answers pinned by the
 * check script: crc32('123456789') === 0xCBF43926, crc32('IEND') === 0xAE426082.
 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0
  }
  return (c ^ 0xffffffff) >>> 0
}

/** The 8-byte PNG file signature. */
export const PNG_SIGNATURE: Uint8Array<ArrayBuffer> = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** ASCII bytes of a chunk type string (types are always 4 ASCII letters). */
function ascii(value: string): Uint8Array {
  const out = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff
  return out
}

function writeU32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff
  target[offset + 1] = (value >>> 16) & 0xff
  target[offset + 2] = (value >>> 8) & 0xff
  target[offset + 3] = value & 0xff
}

/**
 * One PNG chunk frame: 4-byte big-endian data length, the type, the data, and
 * the big-endian CRC32 over TYPE+DATA (never the length field).
 */
export function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const typeBytes = ascii(type)
  if (typeBytes.length !== 4) throw new Error(`png-stitch: chunk type must be 4 ASCII letters, got ${JSON.stringify(type)}`)
  const out = new Uint8Array(12 + data.length)
  writeU32BE(out, 0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  const crcInput = new Uint8Array(4 + data.length)
  crcInput.set(typeBytes, 0)
  crcInput.set(data, 4)
  writeU32BE(out, 8 + data.length, crc32(crcInput))
  return out
}

/** IHDR payload: width/height big-endian, 8 bits/channel, RGBA (color type 6), deflate, filter 0, no interlace. */
export function ihdrData(width: number, height: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(13)
  writeU32BE(data, 0, width)
  writeU32BE(data, 4, height)
  data[8] = 8 // bit depth
  data[9] = 6 // color type: truecolor + alpha
  data[10] = 0 // compression: deflate
  data[11] = 0 // filter: adaptive (per scanline byte)
  data[12] = 0 // interlace: none
  return data
}

/** The IEND chunk is a constant: empty payload, CRC 0xAE426082. */
export const IEND_CHUNK: Uint8Array<ArrayBuffer> = pngChunk('IEND', new Uint8Array(0))

/**
 * IDAT payload split ceiling (1 MiB): a single IDAT may legally be any size,
 * but decoders appreciate modest chunks — and splitting keeps the multi-IDAT
 * path honest since most exports stay under it and emit exactly one.
 */
export const MAX_IDAT_CHUNK_BYTES = 1 << 20

/** Split compressed bytes into consecutive IDAT payloads (multi-chunk IDAT is legal and order-significant). */
export function splitIdatBytes(data: Uint8Array<ArrayBuffer>, maxBytes: number): Uint8Array<ArrayBuffer>[] {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error(`png-stitch: invalid IDAT chunk size ${maxBytes}`)
  if (data.length === 0) return [new Uint8Array(0)]
  const parts: Uint8Array<ArrayBuffer>[] = []
  for (let offset = 0; offset < data.length; offset += maxBytes) {
    parts.push(data.subarray(offset, Math.min(offset + maxBytes, data.length)))
  }
  return parts
}

/* ============================================================================
 * STREAMING WRITER — rows in, Blob out (works in Node 22 too: the check
 * script produces real PNGs and verifies them with node:zlib)
 * ========================================================================== */

/** Scanline filter type 0 (None) — the single filter byte every row carries. */
const FILTER_NONE = new Uint8Array([0])

/**
 * Row-by-row PNG assembler for one already-known raster size.
 *
 * Backpressure: the compressed readable side is drained by a loop started in
 * the constructor — without a concurrent reader the transform stalls once its
 * buffers fill and every writeRow would deadlock. Row bytes are NOT copied:
 * writeRow's awaited write resolves only after the compressor has consumed the
 * chunk, and the rasterizer feeds disjoint subarrays of an ImageData buffer
 * that is never mutated after getImageData, so no staging buffer is needed.
 */
export class PngStitchWriter {
  readonly width: number
  readonly height: number
  private rowsWritten = 0
  private closed = false
  private readonly writer: WritableStreamDefaultWriter<BufferSource>
  private readonly drained: Promise<Uint8Array<ArrayBuffer>>

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || width <= 0) throw new Error(`png-stitch: invalid width ${width}`)
    if (!Number.isInteger(height) || height <= 0) throw new Error(`png-stitch: invalid height ${height}`)
    this.width = width
    this.height = height
    const compressor = new CompressionStream('deflate')
    this.writer = compressor.writable.getWriter()
    const reader = compressor.readable.getReader()
    this.drained = (async () => {
      const chunks: Uint8Array[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done === true) break
        if (value !== undefined) chunks.push(value)
      }
      let total = 0
      for (const chunk of chunks) total += chunk.length
      const out = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      return out
    })()
    // The drain loop starts here and may reject before finish() ever awaits
    // it (a writeRow error abandons the writer mid-stream) — mark it handled
    // from birth so the rejection surfaces only through finish(), never as an
    // unhandled promise rejection. The derived promise resolves; the original
    // still rejects for the awaiter.
    void this.drained.catch(() => {})
  }

  /** Feed one scanline (`width × 4` RGBA bytes). The bytes must stay untouched until the returned promise resolves. */
  async writeRow(rgba: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.closed) throw new Error('png-stitch: writer already finished')
    if (this.rowsWritten >= this.height) throw new Error(`png-stitch: row ${this.rowsWritten} exceeds the declared height ${this.height}`)
    if (rgba.length !== this.width * 4) {
      throw new Error(`png-stitch: row is ${rgba.length} bytes, expected ${this.width * 4} (width ${this.width} × RGBA)`)
    }
    await this.writer.write(FILTER_NONE)
    await this.writer.write(rgba)
    this.rowsWritten += 1
  }

  /** Close the stream and assemble the file. Rejects unless exactly `height` rows were fed. */
  async finish(): Promise<Blob> {
    if (this.closed) throw new Error('png-stitch: writer already finished')
    if (this.rowsWritten !== this.height) {
      throw new Error(`png-stitch: declared ${this.height} rows but ${this.rowsWritten} were written — IHDR height must equal Σ slice heights`)
    }
    this.closed = true
    await this.writer.close()
    const compressed = await this.drained
    const parts: BlobPart[] = [PNG_SIGNATURE, pngChunk('IHDR', ihdrData(this.width, this.height))]
    for (const payload of splitIdatBytes(compressed, MAX_IDAT_CHUNK_BYTES)) {
      parts.push(pngChunk('IDAT', payload))
    }
    parts.push(IEND_CHUNK)
    return new Blob(parts)
  }
}

/* ============================================================================
 * BROWSER ORCHESTRATION — slice blobs in, single PNG Blob out
 * (never executed by the check script; Node has no createImageBitmap)
 * ========================================================================== */

/**
 * Feature probe for the stitch path (ticket 07): CompressionStream gates the
 * whole mechanism (Safari gained it in 16.4, alongside createImageBitmap and
 * Blob — the trio is checked anyway because each is independently load-bearing).
 * Unavailable → the caller falls back to the legacy multi-file delivery.
 */
export function supportsPngStitch(): boolean {
  return typeof CompressionStream === 'function' && typeof createImageBitmap === 'function' && typeof Blob === 'function'
}

/** One stitched slice: its painted PNG and its physical height. */
export interface StitchSlicePart {
  blob: Blob
  /** Physical px height of the slice (the count of scanlines it contributes). */
  height: number
}

/**
 * Stitch painted slices into one PNG of the shared physical width.
 *
 * Per slice: createImageBitmap → draw onto a throwaway canvas → getImageData →
 * writeRow per scanline → zero the canvas and close the bitmap before the next
 * slice. getImageData un-premultiplies alpha, which is lossy for translucent
 * pixels — the share card paints on an opaque background (alpha 255), so the
 * round-trip is exact here. Every slice must decode at exactly the global
 * width and its declared height; a mismatch means a painting bug, and the
 * writer's row accounting would corrupt the file, so it fails loudly instead.
 */
export async function stitchSliceBlobs(parts: readonly StitchSlicePart[], width: number): Promise<Blob> {
  if (parts.length === 0) throw new Error('png-stitch: no slices to stitch')
  if (!Number.isInteger(width) || width <= 0) throw new Error(`png-stitch: invalid stitch width ${width}`)
  const totalHeight = parts.reduce((sum, part) => sum + part.height, 0)
  const writer = new PngStitchWriter(width, totalHeight)
  for (const part of parts) {
    const bitmap = await createImageBitmap(part.blob)
    try {
      if (bitmap.width !== width) {
        throw new Error(`png-stitch: slice decoded ${bitmap.width}px wide, expected the global ${width}px — cannot concatenate scanlines`)
      }
      if (bitmap.height !== part.height) {
        throw new Error(`png-stitch: slice decoded ${bitmap.height}px tall, planned ${part.height}px`)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = part.height
      try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (ctx === null) throw new Error('png-stitch: 2d context unavailable')
        ctx.drawImage(bitmap, 0, 0)
      const image = ctx.getImageData(0, 0, width, part.height)
      const bytesPerRow = width * 4
      for (let y = 0; y < part.height; y++) {
        // Zero-copy row view over the ImageData buffer (its data is a
        // Uint8ClampedArray; a same-offset Uint8Array view shares the bytes).
        const row = new Uint8Array(image.data.buffer, image.data.byteOffset + y * bytesPerRow, bytesPerRow)
        await writer.writeRow(row)
      }
      } finally {
        canvas.width = 0
        canvas.height = 0
      }
    } finally {
      bitmap.close()
    }
  }
  return writer.finish()
}
