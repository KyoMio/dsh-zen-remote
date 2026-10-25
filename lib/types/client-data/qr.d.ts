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
/**
 * The QR matrix for `text` (UTF-8, byte mode), or null when it does not fit
 * into a version-5-L symbol (106 bytes).
 */
export declare function qrMatrix(text: string): boolean[][] | null;
//# sourceMappingURL=qr.d.ts.map