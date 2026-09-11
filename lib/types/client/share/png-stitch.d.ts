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
/**
 * CRC-32 (PNG variant: no init/xor toggling beyond the standard reflected
 * form — init 0xFFFFFFFF, final XOR 0xFFFFFFFF). Known answers pinned by the
 * check script: crc32('123456789') === 0xCBF43926, crc32('IEND') === 0xAE426082.
 */
export declare function crc32(bytes: Uint8Array): number;
/** The 8-byte PNG file signature. */
export declare const PNG_SIGNATURE: Uint8Array<ArrayBuffer>;
/**
 * One PNG chunk frame: 4-byte big-endian data length, the type, the data, and
 * the big-endian CRC32 over TYPE+DATA (never the length field).
 */
export declare function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer>;
/** IHDR payload: width/height big-endian, 8 bits/channel, RGBA (color type 6), deflate, filter 0, no interlace. */
export declare function ihdrData(width: number, height: number): Uint8Array<ArrayBuffer>;
/** The IEND chunk is a constant: empty payload, CRC 0xAE426082. */
export declare const IEND_CHUNK: Uint8Array<ArrayBuffer>;
/**
 * IDAT payload split ceiling (1 MiB): a single IDAT may legally be any size,
 * but decoders appreciate modest chunks — and splitting keeps the multi-IDAT
 * path honest since most exports stay under it and emit exactly one.
 */
export declare const MAX_IDAT_CHUNK_BYTES: number;
/** Split compressed bytes into consecutive IDAT payloads (multi-chunk IDAT is legal and order-significant). */
export declare function splitIdatBytes(data: Uint8Array<ArrayBuffer>, maxBytes: number): Uint8Array<ArrayBuffer>[];
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
export declare class PngStitchWriter {
    readonly width: number;
    readonly height: number;
    private rowsWritten;
    private closed;
    private readonly writer;
    private readonly drained;
    constructor(width: number, height: number);
    /** Feed one scanline (`width × 4` RGBA bytes). The bytes must stay untouched until the returned promise resolves. */
    writeRow(rgba: Uint8Array<ArrayBuffer>): Promise<void>;
    /** Close the stream and assemble the file. Rejects unless exactly `height` rows were fed. */
    finish(): Promise<Blob>;
}
/**
 * Feature probe for the stitch path (ticket 07): CompressionStream gates the
 * whole mechanism (Safari gained it in 16.4, alongside createImageBitmap and
 * Blob — the trio is checked anyway because each is independently load-bearing).
 * Unavailable → the caller falls back to the legacy multi-file delivery.
 */
export declare function supportsPngStitch(): boolean;
/** One stitched slice: its painted PNG and its physical height. */
export interface StitchSlicePart {
    blob: Blob;
    /** Physical px height of the slice (the count of scanlines it contributes). */
    height: number;
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
export declare function stitchSliceBlobs(parts: readonly StitchSlicePart[], width: number): Promise<Blob>;
//# sourceMappingURL=png-stitch.d.ts.map