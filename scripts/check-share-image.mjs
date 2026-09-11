// Self-check for the share-image slicing/rasterizing math (ticket 04, PLAN §5.2;
// ticket 07 adds the single-PNG stitch layer and the unified planning beneath it).
//
// The interesting decisions of the share-image export — slice grouping, width
// lifting for wide content, scale-to-fit for ultra-wide content, the pixel
// ratio fallback ladder, head-dropping truncation (the tail is kept), and the
// physical raster geometry of the SVG document — all live in pure functions
// inside src/client/share/rasterize.ts, so they are asserted numerically here
// without any DOM. The DOM half of rasterize.ts only measures and executes
// these decisions; that split is itself load-bearing and pinned at the bottom
// of this script (rasterize.ts may only import the pure constants module of
// its directory so type stripping can load it, and the template constants the
// width formulas invert live in share-constants.ts, imported by both the
// template and the rasterizer — asserted directly, no source-regex locking).
//
// Run: node scripts/check-share-image.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import {
  MAX_SLICES,
  PIXEL_RATIO_STEPS,
  SLICE_PIXEL_BUDGET,
  ShareRasterizeError,
  buildSvgDocument,
  bucketTurnWidth,
  cardWidthForContent,
  cardWidthForUserBubble,
  planShareSlices,
  planShareSlicesUnified,
  rasterGeometry,
  rasterGeometryStitch,
  ratioChain,
  requiredCardWidth,
  slicePixelCount,
  stitchPixelWidth,
  ultraSliceWidth,
  unifiedCardWidth,
} from '../src/client/share/rasterize.ts'
import {
  IEND_CHUNK,
  MAX_IDAT_CHUNK_BYTES,
  PngStitchWriter,
  crc32,
  ihdrData,
  pngChunk,
  splitIdatBytes,
} from '../src/client/share/png-stitch.ts'
import {
  BASE_CARD_WIDTH,
  USER_BUBBLE_MAX_RATIO,
  USER_BUBBLE_PAD_X,
  WIDE_SLICE_WIDTH,
} from '../src/client/share/share-constants.ts'
import {
  SHARE_EXPORT_ROUTE,
  SHARE_TURNS_PRESETS,
  ShareFetchError,
  buildShareExportQuery,
} from '../src/client/share/fetch-share.ts'
import {
  FALLBACK_SHARE_BASE_NAME,
  SHARE_NAME_MAX,
  sanitizeShareFileName,
  shareImageFileName,
  shareSliceFileName,
} from '../src/client/share/share-flow.ts'
import { parseMarkdown } from '../src/client/share/markdown.ts'

// ---- shipped constants (PLAN §5.2) ------------------------------------------
// The four template constants come from share-constants.ts — the one module
// both share-card.tsx (renders them) and rasterize.ts (inverts them in its
// width formulas) import, so these asserts pin the single source of truth
// that used to be regex-locked against the template's literals.
assert.equal(BASE_CARD_WIDTH, 390)
assert.equal(WIDE_SLICE_WIDTH, 780)
assert.equal(USER_BUBBLE_MAX_RATIO, 0.82)
assert.equal(USER_BUBBLE_PAD_X, 14)
assert.equal(SLICE_PIXEL_BUDGET, 12_000_000, '12M budget = iOS 16.7M canvas cap minus safety margin')
assert.equal(MAX_SLICES, 24)
assert.deepEqual(PIXEL_RATIO_STEPS, [2, 1.5, 1])

// ---- the pixel-ratio ladder --------------------------------------------------
// min(devicePixelRatio, 2) decides where the descending chain starts; the
// chain never comes back empty.
assert.deepEqual(ratioChain(2), [2, 1.5, 1])
assert.deepEqual(ratioChain(3), [2, 1.5, 1])
assert.deepEqual(ratioChain(1.5), [1.5, 1])
assert.deepEqual(ratioChain(1.2), [1])
assert.deepEqual(ratioChain(1), [1])
assert.deepEqual(ratioChain(0.5), [1], 'a nonsensical cap still yields a usable ratio')

// ---- physical pixel arithmetic ------------------------------------------------
// Canvas dimensions round up per side, so 7692 logical px at ratio 2 on a
// 390px card is exactly inside the budget and 7693 is out.
assert.equal(slicePixelCount(390, 7692, 2), 780 * 15384)
assert.ok(slicePixelCount(390, 7692, 2) <= SLICE_PIXEL_BUDGET)
assert.ok(slicePixelCount(390, 7693, 2) > SLICE_PIXEL_BUDGET)
assert.equal(slicePixelCount(780, 4000, 1), 3_120_000)
assert.equal(slicePixelCount(390.5, 100, 2), 781 * 200, 'fractional logical sizes still ceil per side')

// ---- physical raster geometry (P1: svg intrinsic = canvas size) ---------------
// The svg/foreignObject attrs must carry the PHYSICAL target (ceil of logical
// × scale × ratio): logical attrs make WebKit rasterize the SVG-as-image at
// its small intrinsic size and the later drawImage upscale it (blurry on 2x),
// and an unbounded ultra renderWidth would decode an unbounded bitmap before
// any canvas exists.
{
  const g = rasterGeometry(390, 714, 1, 2, SLICE_PIXEL_BUDGET)
  assert.equal(g.width, 780)
  assert.equal(g.height, 1428)
  assert.equal(g.transformScale, 2)
}
{
  // Ultra geometry: composite transform, physical width capped by the wide width.
  const g = rasterGeometry(938, 714, 780 / 938, 2, SLICE_PIXEL_BUDGET)
  assert.equal(g.width, 1560)
  assert.equal(g.height, 1188)
  assert.ok(Math.abs(g.transformScale - (2 * 780) / 938) < 1e-12)
}
{
  // A slice whose fresh-measured size busts the budget clamps back inside it
  // (floor per side, so the product provably fits) — the ultra raster-size
  // guarantee, independent of the planner's estimates.
  const g = rasterGeometry(780, 5000, 1, 2, SLICE_PIXEL_BUDGET)
  assert.equal(g.width, 1368)
  assert.equal(g.height, 8770)
  assert.ok(g.width * g.height <= SLICE_PIXEL_BUDGET)
  assert.ok(g.transformScale < 2)
}

// ---- SVG document: physical intrinsic + scaled logical wrapper ----------------
{
  const svg = buildSvgDocument('<div xmlns="http://www.w3.org/1999/xhtml">hi</div>', {
    renderWidth: 390, logicalHeight: 714, width: 780, height: 1428, transformScale: 2,
  })
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="780" height="1428"><foreignObject width="780" height="1428">'), 'svg and foreignObject carry the physical target')
  assert.ok(svg.includes('<div xmlns="http://www.w3.org/1999/xhtml" style="width:390px;height:714px;transform:scale(2);transform-origin:0 0">'), 'the xhtml wrapper carries the logical size and the scale transform')
  assert.ok(svg.includes('>hi<'), 'the body rides inside the wrapper')
  assert.ok(svg.endsWith('</foreignObject></svg>'))
  // XML-invalid control characters never reach the parser.
  const scrubbed = buildSvgDocument('a\u0000b', { renderWidth: 10, logicalHeight: 10, width: 20, height: 20, transformScale: 2 })
  assert.ok(!scrubbed.includes('\u0000'))
}

// ---- width lifting formulas ----------------------------------------------------
// Assistant rows span the card content box: content + both card paddings.
assert.equal(cardWidthForContent(900, 18), 938)
assert.equal(requiredCardWidth('assistant', 900, 18), 938)
// User rows sit in a bubble capped at 82% of the row plus its own 14px pads —
// the percentage inverts into a division.
assert.equal(cardWidthForUserBubble(900, 18), Math.ceil(928 / 0.82) + 38)
assert.equal(cardWidthForUserBubble(900, 18), 1170)
assert.equal(requiredCardWidth('user', 900, 18), 1170)

// Bucketing rides on the REQUIRED card width (per role), not the raw content
// width — a user pre needs ~1.22x its width in card to clear the bubble cap.
assert.equal(bucketTurnWidth('assistant', 352, 18, 390, 780), 'base')
assert.equal(bucketTurnWidth('assistant', 353, 18, 390, 780), 'wide')
assert.equal(bucketTurnWidth('assistant', 742, 18, 390, 780), 'wide')
assert.equal(bucketTurnWidth('assistant', 743, 18, 390, 780), 'ultra')
assert.equal(bucketTurnWidth('user', 260, 18, 390, 780), 'base')
assert.equal(bucketTurnWidth('user', 261, 18, 390, 780), 'wide')
assert.equal(bucketTurnWidth('user', 580, 18, 390, 780), 'wide')
assert.equal(bucketTurnWidth('user', 581, 18, 390, 780), 'ultra')
assert.equal(bucketTurnWidth('assistant', 0, 18, 390, 780), 'base', 'no overflow stays base')

// Ultra turns render at natural width and shrink geometrically back to the
// wide width on output.
{
  const a = ultraSliceWidth('assistant', 900, 18, 780)
  assert.equal(a.renderWidth, 938)
  assert.ok(Math.abs(a.scale - 780 / 938) < 1e-12)
  assert.ok(a.scale < 1)
  const u = ultraSliceWidth('user', 900, 18, 780)
  assert.equal(u.renderWidth, 1170)
  assert.ok(Math.abs(u.scale - 780 / 1170) < 1e-12)
}

// ---- slice planning -------------------------------------------------------------
// Fixed chrome geometry the planner must reserve for.
const EXTRAS = { gap: 14, paddingY: 36, headerHeight: 90, footerHeight: 60, noteHeight: 40 }
const OPTS = { budgetPx: SLICE_PIXEL_BUDGET, maxSlices: MAX_SLICES, ratios: [2, 1.5, 1] }
const turn = (height, renderWidth = 390, scale = 1) => ({ height, renderWidth, scale })

// Empty card: no slices, no truncation, lowest ratio as the nominal one.
assert.deepEqual(planShareSlices([], EXTRAS, OPTS), { pixelRatio: 1, slices: [], truncated: false, droppedTurns: 0 })

// Short card: one slice at the best ratio, header + footer + gaps accounted.
{
  const plan = planShareSlices([turn(500)], EXTRAS, OPTS)
  assert.equal(plan.pixelRatio, 2)
  assert.equal(plan.slices.length, 1)
  const [s] = plan.slices
  // 36 padding + (90 header + 14 gap) + 500 turn + (14 gap + 60 footer)
  assert.equal(s.height, 714)
  assert.equal(s.outWidth, 390)
  assert.equal(s.outHeight, 714)
  assert.equal(s.lever, 1)
  assert.ok(s.first && s.last && !s.truncated)
  assert.equal(plan.truncated, false)
  assert.equal(plan.droppedTurns, 0)
}

// Two tall turns split at the budget line; header rides slice 0, footer rides
// the last, and neither slice crosses 12M physical pixels.
{
  const plan = planShareSlices([turn(5000), turn(5000)], EXTRAS, OPTS)
  assert.equal(plan.pixelRatio, 2)
  assert.equal(plan.slices.length, 2)
  const [a, b] = plan.slices
  assert.equal(`${a.from}-${a.to}`, '0-0')
  assert.equal(`${b.from}-${b.to}`, '1-1')
  assert.equal(a.height, 36 + 90 + 14 + 5000) // 5140
  assert.equal(b.height, 36 + 5000 + 14 + 60) // 5110
  for (const s of plan.slices) {
    assert.ok(slicePixelCount(s.outWidth, s.outHeight, plan.pixelRatio) <= SLICE_PIXEL_BUDGET)
  }
}

// Degradation ladder. 30 turns of 7600px: at ratio 2 one slice already busts
// the budget with the header attached, at 1.5 still one-per-slice (30 > 24),
// at ratio 1 four turns fit per slice -> 8 slices, no truncation.
{
  const plan = planShareSlices(Array.from({ length: 30 }, () => turn(7600)), EXTRAS, OPTS)
  assert.equal(plan.pixelRatio, 1)
  assert.equal(plan.slices.length, 8)
  assert.equal(plan.truncated, false)
  assert.equal(plan.droppedTurns, 0)
  assert.deepEqual(plan.slices.map((s) => `${s.from}-${s.to}`), [
    '0-3', '4-7', '8-11', '12-15', '16-19', '20-23', '24-27', '28-29',
  ])
  assert.ok(slicePixelCount(plan.slices[0].outWidth, plan.slices[0].outHeight, 1) <= SLICE_PIXEL_BUDGET)
}

// The ladder stops at the FIRST ratio that works: 30 turns of 6500px pair up
// at 1.5 (15 slices) before ratio 1 is ever needed.
{
  const plan = planShareSlices(Array.from({ length: 30 }, () => turn(6500)), EXTRAS, OPTS)
  assert.equal(plan.pixelRatio, 1.5)
  assert.equal(plan.slices.length, 15)
  assert.ok(plan.slices.every((s) => s.lever === 1))
}

// Truncation keeps the TAIL: 120 tall turns still need 30 slices at ratio 1
// -> keep the LAST 24, drop the head, mark the FIRST slice — with range=last
// the user explicitly named the newest turns, which head-keeping would
// discard exactly.
{
  const plan = planShareSlices(Array.from({ length: 120 }, () => turn(7600)), EXTRAS, OPTS)
  assert.equal(plan.pixelRatio, 1)
  assert.equal(plan.slices.length, MAX_SLICES)
  assert.equal(plan.truncated, true)
  assert.equal(plan.droppedTurns, 24)
  assert.equal(plan.slices[0].from, 24, 'the first kept slice starts right after the dropped head')
  assert.equal(plan.slices.at(-1).to, 119, 'the tail runs to the end of the conversation')
  assert.equal(plan.slices[0].truncated, true, 'the marker rides the first kept slice')
  assert.equal(plan.slices[1].truncated, false)
  assert.equal(plan.slices.at(-1).truncated, false)
  // First slice: header + note + 4 turns; last slice: footer + the final turns.
  const first = plan.slices[0]
  assert.equal(first.height, 36 + (90 + 14) + (40 + 14) + 4 * 7600 + 3 * 14)
  const last = plan.slices.at(-1)
  assert.equal(last.height, 36 + 4 * 7600 + 3 * 14 + (14 + 60))
  assert.ok(slicePixelCount(first.outWidth, first.outHeight, 1) <= SLICE_PIXEL_BUDGET)
  assert.ok(slicePixelCount(last.outWidth, last.outHeight, 1) <= SLICE_PIXEL_BUDGET)
}

// Wide-turn isolation: a 780px turn between 390px turns becomes its own slice
// (a slice never mixes widths), with exact per-slice heights.
{
  const plan = planShareSlices([turn(300), turn(250, 780), turn(300)], EXTRAS, OPTS)
  assert.equal(plan.pixelRatio, 2)
  assert.deepEqual(plan.slices.map((s) => s.renderWidth), [390, 780, 390])
  assert.deepEqual(plan.slices.map((s) => s.height), [36 + 104 + 300, 36 + 250, 36 + 74 + 300])
  assert.deepEqual(plan.slices.map((s) => s.first), [true, false, false])
  assert.deepEqual(plan.slices.map((s) => s.last), [false, false, true])
}

// Ultra turn: renders at natural width, shrinks back to ~780 logical on
// output, no extra lever needed.
{
  const plan = planShareSlices([turn(400, 938, 780 / 938)], EXTRAS, OPTS)
  assert.equal(plan.pixelRatio, 2)
  const [s] = plan.slices
  assert.equal(s.renderWidth, 938)
  assert.ok(Math.abs(s.outWidth - 780) < 0.01)
  assert.ok(s.scale < 1 && s.scale > 0.8)
  assert.equal(s.lever, 1)
}

// An un-splittable turn taller than the budget at EVERY ratio (even ratio 1)
// keeps completeness over sharpness: one slice, uniformly shrunk (the lever),
// and the ceiling rounding of the canvas is accounted for — the final physical
// count is genuinely within budget.
{
  const plan = planShareSlices([turn(40000)], EXTRAS, OPTS)
  assert.equal(plan.pixelRatio, 1)
  assert.equal(plan.slices.length, 1)
  assert.equal(plan.truncated, false)
  const [s] = plan.slices
  assert.ok(s.lever < 1)
  assert.ok(s.scale < 0.88)
  assert.ok(slicePixelCount(s.outWidth, s.outHeight, 1) <= SLICE_PIXEL_BUDGET, 'post-lever pixel count fits')
}

// Slices are contiguous and ordered, covering [droppedTurns, n-1] — the tail
// always runs to the very end of the conversation.
{
  const inputs = Array.from({ length: 120 }, () => turn(7600))
  const plan = planShareSlices(inputs, EXTRAS, OPTS)
  let expected = plan.droppedTurns
  for (const s of plan.slices) {
    assert.equal(s.from, expected)
    assert.ok(s.to >= s.from)
    expected = s.to + 1
  }
  assert.equal(expected, inputs.length)
}

// 780-wide slices ride the ratio ladder too: turns of 5000px at width 780
// bust the budget at ratio 2 (1560 × 10072 > 12M) but fit at 1.5 — width
// lifting and ratio degradation compounded in one plan.
{
  const plan = planShareSlices(Array.from({ length: 6 }, () => turn(5000, 780)), EXTRAS, OPTS)
  assert.equal(plan.pixelRatio, 1.5)
  assert.equal(plan.slices.length, 6)
  assert.ok(plan.slices.every((s) => s.renderWidth === 780 && s.lever === 1))
  assert.equal(plan.slices[0].height, 36 + 90 + 14 + 5000)
  assert.equal(plan.slices.at(-1).height, 36 + 5000 + 14 + 60)
  for (const s of plan.slices) {
    assert.ok(slicePixelCount(s.outWidth, s.outHeight, plan.pixelRatio) <= SLICE_PIXEL_BUDGET)
  }
}

// Ultra scale × budget lever compound: a turn whose ultra output still busts
// the budget at EVERY ratio gets the lever stacked on top of the geometric
// downscale (completeness kept; pinch-zoom restores size).
{
  const plan = planShareSlices([turn(45000, 2000, 0.39)], EXTRAS, OPTS)
  assert.equal(plan.pixelRatio, 1)
  assert.equal(plan.slices.length, 1)
  assert.equal(plan.truncated, false)
  const [s] = plan.slices
  assert.ok(s.lever < 1, 'the budget lever stacks onto the ultra scale')
  assert.ok(s.scale < 0.39)
  assert.ok(s.outWidth < 780)
  assert.ok(slicePixelCount(s.outWidth, s.outHeight, 1) <= SLICE_PIXEL_BUDGET)
}

// ---- error surface -----------------------------------------------------------
{
  const err = new ShareRasterizeError('probe-failed', 'blank')
  assert.ok(err instanceof Error)
  assert.equal(err.code, 'probe-failed')
  assert.equal(err.detail, 'blank')
  assert.match(err.message, /probe-failed/)
}

// ---- ticket 05: share fetch query builder + error taxonomy -------------------
assert.equal(SHARE_EXPORT_ROUTE, '/_dsh/mobile-nav/share-export')
assert.deepEqual(SHARE_TURNS_PRESETS, [3, 5, 10], 'PLAN §6: presets only, no free input')
assert.equal(
  buildShareExportQuery('session-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', { kind: 'all' }),
  '/_dsh/mobile-nav/share-export?session=session-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0&range=all',
)
assert.equal(
  buildShareExportQuery('session-abc', { kind: 'last', turns: 5 }),
  '/_dsh/mobile-nav/share-export?session=session-abc&range=last&turns=5',
)
// The session id is URL-encoded: a stray '/' or '?' must not smuggle params.
assert.equal(
  buildShareExportQuery('session-a/b?c=d', { kind: 'all' }),
  `/_dsh/mobile-nav/share-export?session=${encodeURIComponent('session-a/b?c=d')}&range=all`,
)
// range=all never carries turns — the host 400s that pair (rejectStrayTurns).
assert.ok(!buildShareExportQuery('session-x', { kind: 'all' }).includes('turns='))
// The route constant must stay glued to the host module it mirrors.
const hostRouteSrc = readFileSync(new URL('../src/share-export.ts', import.meta.url), 'utf8')
assert.match(hostRouteSrc, new RegExp(`'${SHARE_EXPORT_ROUTE.replace(/\//g, '\\/')}'`), 'client and host must agree on the share-export route')
{
  const err = new ShareFetchError('route-missing', 404, 'no envelope')
  assert.ok(err instanceof Error)
  assert.equal(err.code, 'route-missing')
  assert.equal(err.status, 404)
  assert.match(err.message, /route-missing/)
  const net = new ShareFetchError('network', undefined, 'offline')
  assert.equal(net.status, undefined)
  assert.ok(net instanceof ShareFetchError)
}

// ---- ticket 05: portable filename sanitizer ----------------------------------
assert.equal(sanitizeShareFileName('网关错误率报表'), '网关错误率报表')
assert.equal(sanitizeShareFileName('a/b\\c|d'), 'a b c|d', 'path separators fold into spaces; other punctuation stays')
assert.equal(sanitizeShareFileName('two\n\n  spaces\tand tab'), 'two spaces and tab')
assert.equal(sanitizeShareFileName('\u0000control\u001F\u007Fchars'), 'controlchars', 'C0 controls and DEL are stripped')
// Bidi format characters: zero-width, and they visually reorder the name —
// `photo<LRM|RLM|LRE|RLE|PDF|LRO>…` must not survive into a filename.
assert.equal(sanitizeShareFileName('photo\u202Egpj.png'), 'photogpj.png', 'an RLO (right-to-left override) extension spoof is stripped')
assert.equal(sanitizeShareFileName('a\u200Eb\u200Fc\u202Ad\u202Be\u202Cf\u202Dg'), 'abcdefg', 'LRM/RLM/LRE/RLE/PDF/LRO are stripped too')
assert.equal(sanitizeShareFileName('   '), FALLBACK_SHARE_BASE_NAME)
assert.equal(sanitizeShareFileName('///\\\\'), FALLBACK_SHARE_BASE_NAME, 'separator-only titles fall back')
assert.equal(sanitizeShareFileName(' leading and trailing '), 'leading and trailing')
// The cap counts CODE POINTS (a UTF-16 slice could split a surrogate pair).
{
  const emoji = '😀'.repeat(SHARE_NAME_MAX + 5)
  const capped = sanitizeShareFileName(emoji)
  assert.equal(Array.from(capped).length, SHARE_NAME_MAX)
  assert.ok(!capped.includes('\uFFFD'), 'no lone surrogate may survive the cap')
  const cjk = '汉'.repeat(SHARE_NAME_MAX + 10)
  assert.equal(Array.from(sanitizeShareFileName(cjk)).length, SHARE_NAME_MAX)
}
assert.equal(shareSliceFileName('share-card', 0), 'share-card-01.png')
assert.equal(shareSliceFileName('报表', 11), '报表-12.png')
// Ticket 07: the stitched deliverable is ONE file — plain `<base>.png`, no slice suffix.
assert.equal(shareImageFileName('报表'), '报表.png')
assert.equal(shareImageFileName('share-card'), 'share-card.png')
assert.ok(shareImageFileName(FALLBACK_SHARE_BASE_NAME).endsWith('.png'))

// ---- ticket 07: PNG byte layer — CRC32 + chunk framing -------------------------
// Read a big-endian u32 out of a byte view (length fields and CRCs are both BE).
const be32 = (bytes, off) => ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0
const ENC = new TextEncoder()
assert.equal(crc32(new Uint8Array(0)), 0)
assert.equal(crc32(ENC.encode('123456789')), 0xcbf43926, 'the canonical CRC-32 check value')
assert.equal(crc32(ENC.encode('IEND')), 0xae426082, 'the IEND type CRC — a fixed constant of the PNG ecosystem')
{
  const data = ENC.encode('hello world')
  const chunk = pngChunk('IDAT', data)
  assert.equal(chunk.length, 12 + data.length)
  assert.equal(be32(chunk, 0), data.length, 'data length, big-endian')
  assert.equal(String.fromCharCode(...chunk.slice(4, 8)), 'IDAT')
  const crcInput = new Uint8Array(4 + data.length)
  crcInput.set(chunk.slice(4, 8))
  crcInput.set(data, 4)
  assert.equal(be32(chunk, 8 + data.length), crc32(crcInput), 'CRC covers type+data, never the length field')
  // Multi-byte lengths really are big-endian, not little.
  const wide = pngChunk('odAT', new Uint8Array(0x1234))
  assert.equal(be32(wide, 0), 0x1234)
  assert.equal(wide[2], 0x12, 'high byte first')
  assert.equal(wide[3], 0x34)
  assert.throws(() => pngChunk('TOOLONG', data), /4 ASCII letters/)
}
{
  const d = ihdrData(1560, 12345)
  assert.equal(d.length, 13)
  assert.equal(be32(d, 0), 1560)
  assert.equal(be32(d, 4), 12345)
  assert.deepEqual([...d.slice(8)], [8, 6, 0, 0, 0], '8-bit RGBA (color type 6), deflate, adaptive filter, no interlace')
}
{
  assert.equal(IEND_CHUNK.length, 12)
  assert.equal(be32(IEND_CHUNK, 0), 0)
  assert.equal(String.fromCharCode(...IEND_CHUNK.slice(4, 8)), 'IEND')
  assert.equal(be32(IEND_CHUNK, 8), 0xae426082)
}
{
  const bytes = ENC.encode('x'.repeat(10))
  assert.deepEqual(splitIdatBytes(bytes, 4).map((p) => p.length), [4, 4, 2], 'IDAT payloads split at the ceiling')
  assert.equal(Buffer.concat(splitIdatBytes(bytes, 4).map(Buffer.from)).toString(), 'x'.repeat(10), 'concatenation is the identity')
  assert.deepEqual(splitIdatBytes(new Uint8Array(0), 4).map((p) => p.length), [0], 'empty input still yields one (empty) payload')
  assert.throws(() => splitIdatBytes(bytes, 0), /invalid IDAT chunk size/)
}

// ---- ticket 07: writer emits a spec-shaped PNG (node:zlib round-trip) ------------
// Node 22 has CompressionStream + Blob as globals, so the writer runs for real
// here: every chunk CRC is re-verified and the IDAT stream is inflated back to
// the exact scanline bytes (filter 0 + the rows that were fed).
{
  const W = 3
  const H = 5
  const rows = Array.from({ length: H }, (_, y) => Uint8Array.from({ length: W * 4 }, (_, i) => (y * W * 4 + i) % 251))
  const writer = new PngStitchWriter(W, H)
  for (const row of rows) await writer.writeRow(row)
  const png = new Uint8Array(await (await writer.finish()).arrayBuffer())
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature')
  const chunks = []
  for (let off = 8; off < png.length;) {
    const len = be32(png, off)
    const type = String.fromCharCode(...png.slice(off + 4, off + 8))
    const crcInput = new Uint8Array(4 + len)
    crcInput.set(png.slice(off + 4, off + 8))
    crcInput.set(png.slice(off + 8, off + 8 + len), 4)
    assert.equal(be32(png, off + 8 + len), crc32(crcInput), `${type} chunk CRC`)
    chunks.push({ type, data: png.slice(off + 8, off + 8 + len) })
    off += 12 + len
  }
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND'], 'small image = exactly one IDAT; IHDR first, IEND last')
  assert.equal(be32(chunks[0].data, 0), W)
  assert.equal(be32(chunks[0].data, 4), H, 'IHDR height = the row count fed (Σ slice heights)')
  const raw = inflateSync(Buffer.from(chunks[1].data))
  assert.equal(raw.length, H * (1 + W * 4))
  for (let y = 0; y < H; y++) {
    assert.equal(raw[y * (1 + W * 4)], 0, 'scanline filter byte 0 (None)')
    assert.deepEqual([...raw.subarray(y * (1 + W * 4) + 1, (y + 1) * (1 + W * 4))], [...rows[y]])
  }
  // Row/height accounting guards: IHDR height must equal the rows actually fed.
  const underfed = new PngStitchWriter(W, 2)
  await underfed.writeRow(rows[0])
  await assert.rejects(() => underfed.finish(), /declared 2 rows but 1/)
  const badWidth = new PngStitchWriter(W, 1)
  await assert.rejects(() => badWidth.writeRow(new Uint8Array(3)), /expected 12/)
  const overfed = new PngStitchWriter(W, 1)
  await overfed.writeRow(rows[0])
  await assert.rejects(() => overfed.writeRow(rows[1]), /exceeds the declared height/)
}

// ---- ticket 07: multi-IDAT end-to-end — one zlib stream, many chunks (review 07+08) ----
// The small round-trip above always emits exactly ONE IDAT, so the split path
// was only pinned at the splitIdatBytes unit level. This block fixes the whole
// pipeline end to end: a big image of crypto-random rows (incompressible —
// the deflate stream alone crosses MAX_IDAT_CHUNK_BYTES, like a real
// long-transcript stitch) must emit ≥2 IDAT chunks, every chunk's CRC must
// verify, and — the property every real decoder relies on — the CONCATENATED
// payloads must inflate back to the exact scanline bytes: multiple IDATs are
// one zlib stream in order, never per-chunk streams.
{
  const W = 97
  const H = 8192 // H × (1 + W×4) ≈ 3.19 MB of noise → ≥ 3 compressed MiB → ≥ 4 chunks
  const rowBytes = W * 4
  const rows = Array.from({ length: H }, () => randomBytes(rowBytes))
  const writer = new PngStitchWriter(W, H)
  for (const row of rows) await writer.writeRow(row)
  const png = new Uint8Array(await (await writer.finish()).arrayBuffer())
  const idats = []
  for (let off = 8; off < png.length;) {
    const len = be32(png, off)
    const type = String.fromCharCode(...png.slice(off + 4, off + 8))
    assert.equal(be32(png, off + 8 + len), crc32(png.slice(off + 4, off + 8 + len)), `${type} chunk CRC (type+data, not the length field)`)
    if (type === 'IDAT') idats.push(png.slice(off + 8, off + 8 + len))
    off += 12 + len
  }
  assert.ok(idats.length >= 2, `a ~3 MiB random stream must split into multiple IDATs, got ${idats.length}`)
  for (const [index, payload] of idats.entries()) {
    assert.ok(payload.length <= MAX_IDAT_CHUNK_BYTES, `IDAT ${index} respects the split ceiling`)
    assert.ok(payload.length > 0, `IDAT ${index} is never empty (an empty tail would shift the stream)`)
  }
  const raw = inflateSync(Buffer.concat(idats.map(Buffer.from)))
  assert.equal(raw.length, H * (1 + rowBytes), 'the concatenated IDAT payloads inflate to exactly the scanline byte count')
  const expected = Buffer.alloc(H * (1 + rowBytes))
  for (let y = 0; y < H; y++) {
    expected.writeUint8(0, y * (1 + rowBytes)) // filter byte 0 (None)
    rows[y].copy(expected, y * (1 + rowBytes) + 1)
  }
  assert.ok(raw.equals(expected), 'every byte round-trips: filter 0 + the exact rows fed, in order')
}

// ---- ticket 07: unified planning — one global width, ratio and lever -------------
assert.equal(unifiedCardWidth(false), BASE_CARD_WIDTH)
assert.equal(unifiedCardWidth(true), WIDE_SLICE_WIDTH)
// Short card measured at the global width: one slice at the best ratio.
{
  const plan = planShareSlicesUnified([turn(500, 780)], EXTRAS, OPTS)
  assert.equal(plan.pixelRatio, 2)
  assert.equal(plan.slices.length, 1)
  assert.equal(plan.slices[0].outWidth, 780)
  assert.equal(stitchPixelWidth(plan), 1560)
}
// Degradation ladder + tail-keeping truncation keep their semantics at the
// global width (same inputs the DOM half would produce for a 390 card).
{
  const plan = planShareSlicesUnified(Array.from({ length: 120 }, () => turn(7600)), EXTRAS, OPTS)
  assert.equal(plan.pixelRatio, 1)
  assert.equal(plan.slices.length, MAX_SLICES)
  assert.equal(plan.truncated, true)
  assert.ok(plan.droppedTurns > 0)
  assert.equal(plan.slices[0].from, plan.droppedTurns, 'the first kept slice starts right after the dropped head')
  assert.equal(plan.slices.at(-1).to, 119, 'the tail runs to the end of the conversation')
  assert.equal(plan.slices[0].truncated, true)
}
// GLOBAL lever: one un-splittable giant turn shrinks EVERY slice by the same
// multiplier — uniform output width is the stitch invariant. The legacy planner
// shrinks only the offending slice, which is exactly the per-slice width
// divergence stitching cannot tolerate.
{
  const plan = planShareSlicesUnified([turn(40000), turn(500)], EXTRAS, OPTS)
  assert.equal(plan.pixelRatio, 1)
  assert.equal(plan.slices.length, 2)
  const [giant, normal] = plan.slices
  assert.ok(giant.lever < 1)
  assert.equal(normal.lever, giant.lever, 'the lever is one global multiplier')
  assert.ok(Math.abs(normal.outWidth - giant.outWidth) < 1e-9, 'every slice lands on the same output width')
  assert.ok(slicePixelCount(giant.outWidth, giant.outHeight, 1) <= SLICE_PIXEL_BUDGET)
  const legacy = planShareSlices([turn(40000), turn(500)], EXTRAS, OPTS)
  assert.equal(legacy.slices[1].lever, 1, 'legacy keeps well-behaved slices native — the contrast the unified planner removes')
}
// stitchPixelWidth is THE authoritative width: each slice's own ceil'd arithmetic agrees.
{
  const plan = planShareSlicesUnified([turn(5000, 780), turn(5000, 780)], EXTRAS, OPTS)
  const width = stitchPixelWidth(plan)
  assert.equal(width, 1170, '5000px turns at 780 fit the budget at ratio 1.5 first')
  for (const s of plan.slices) assert.equal(Math.ceil(s.outWidth * plan.pixelRatio), width)
  assert.equal(stitchPixelWidth({ ...plan, slices: [] }), 0, 'empty plans carry no width')
}
// An ultra turn inside a unified plan lands on the same output width by
// construction (renderWidth × W/renderWidth) — no isolation needed for width.
{
  const plan = planShareSlicesUnified([turn(400, 938, 780 / 938), turn(500, 780)], EXTRAS, OPTS)
  assert.equal(plan.pixelRatio, 2)
  assert.equal(stitchPixelWidth(plan), 1560)
  for (const s of plan.slices) assert.ok(Math.abs(s.outWidth - 780) < 1e-9)
}
// rasterGeometryStitch: the width is pinned to the global one; heights ceil;
// the budget clamp floors the height and NEVER moves the width.
{
  const geo = rasterGeometryStitch(780, 714, 1560, SLICE_PIXEL_BUDGET)
  assert.equal(geo.width, 1560)
  assert.equal(geo.height, 1428)
  assert.ok(Math.abs(geo.transformScale - 2) < 1e-12)
  assert.equal(geo.clamped, false)
}
{
  const geo = rasterGeometryStitch(780, 7693, 1560, SLICE_PIXEL_BUDGET)
  assert.equal(geo.width, 1560, 'the stitch width is untouchable')
  assert.equal(geo.height, Math.floor(SLICE_PIXEL_BUDGET / 1560))
  assert.ok(geo.width * geo.height <= SLICE_PIXEL_BUDGET)
  assert.equal(geo.clamped, true)
  const ultra = rasterGeometryStitch(938, 714, 1560, SLICE_PIXEL_BUDGET)
  assert.equal(ultra.width, 1560)
  assert.ok(Math.abs(ultra.transformScale - 1560 / 938) < 1e-12, 'the transform folds ultra fit, lever and ratio into globalWidth/renderWidth')
  assert.equal(ultra.height, Math.ceil(714 * (1560 / 938)))
  assert.throws(() => rasterGeometryStitch(780, 714, 0, SLICE_PIXEL_BUDGET), /invalid stitch width/)
}

// ---- ticket 09: markdown parser — leniency beats strictness ---------------------
// The assistant text renderer feeds off parseMarkdown; every construct below
// pins its block/span shape, and the fallback rule is the point of the design:
// an unclosed/implausible marker must come back as PLAIN TEXT, never as a
// half-parsed span that leaks asterisks into the exported image.
{
  // Empty and blank-only input yields no blocks (renderer renders nothing).
  assert.deepEqual(parseMarkdown(''), [])
  assert.deepEqual(parseMarkdown('\n \n\t\n'), [])

  // Headings: six levels, inline content parsed, text trimmed; 7 hashes and a
  // hash without a space are paragraphs.
  assert.deepEqual(parseMarkdown('# 标题'), [{ kind: 'heading', level: 1, spans: [{ kind: 'text', text: '标题' }] }])
  assert.deepEqual(parseMarkdown('###### 六级 **粗**'), [{
    kind: 'heading',
    level: 6,
    spans: [{ kind: 'text', text: '六级 ' }, { kind: 'bold', spans: [{ kind: 'text', text: '粗' }] }],
  }])
  assert.deepEqual(parseMarkdown('####### 七个'), [{ kind: 'para', spans: [{ kind: 'text', text: '####### 七个' }] }])
  assert.deepEqual(parseMarkdown('#nospace'), [{ kind: 'para', spans: [{ kind: 'text', text: '#nospace' }] }])

  // Paragraphs keep soft line breaks inside one text span (pre-wrap renders them).
  assert.deepEqual(parseMarkdown('第一行\n第二行'), [{ kind: 'para', spans: [{ kind: 'text', text: '第一行\n第二行' }] }])

  // Fenced code: language tag recorded, tilde fences too, unterminated fences
  // still yield their body, empty fences yield an empty block.
  assert.deepEqual(parseMarkdown('```js\nconst x = 1\n```'), [{ kind: 'code', lang: 'js', lines: ['const x = 1'] }])
  assert.deepEqual(parseMarkdown('~~~\nplain\nbody\n~~~'), [{ kind: 'code', lang: undefined, lines: ['plain', 'body'] }])
  assert.deepEqual(parseMarkdown('```ts\nunterminated'), [{ kind: 'code', lang: 'ts', lines: ['unterminated'] }])
  assert.deepEqual(parseMarkdown('```\n```'), [{ kind: 'code', lang: undefined, lines: [] }])

  // Indented code (4 spaces / tab): one indent unit stripped, blank lines
  // between indented lines stay inside, and a paragraph is never interrupted.
  assert.deepEqual(parseMarkdown('    indented\n    more'), [{ kind: 'code', lang: undefined, lines: ['indented', 'more'] }])
  assert.deepEqual(parseMarkdown('    a\n\n    b'), [{ kind: 'code', lang: undefined, lines: ['a', '', 'b'] }])
  assert.deepEqual(parseMarkdown('正文\n    缩进'), [{ kind: 'para', spans: [{ kind: 'text', text: '正文\n    缩进' }] }])

  // Blockquotes: consecutive > lines, prefix stripped, body block-parsed.
  assert.deepEqual(parseMarkdown('> 引用\n> 第二行'), [{
    kind: 'quote',
    children: [{ kind: 'para', spans: [{ kind: 'text', text: '引用\n第二行' }] }],
  }])
  assert.deepEqual(parseMarkdown('> # 标\n> - 项'), [{
    kind: 'quote',
    children: [
      { kind: 'heading', level: 1, spans: [{ kind: 'text', text: '标' }] },
      { kind: 'list', ordered: false, items: [{ spans: [{ kind: 'text', text: '项' }], number: undefined, children: [] }] },
    ],
  }])

  // Lists: mixed bullet markers stay one list; ordered numbers are the ones
  // written; two indent levels (2-space multiples); deeper indents cap onto
  // level two; indented non-marker lines lazily continue the deepest item.
  const li = (text, { number = undefined, children = [] } = {}) => ({ spans: [{ kind: 'text', text }], number, children })
  assert.deepEqual(parseMarkdown('- 甲\n- 乙\n+ 丙'), [{ kind: 'list', ordered: false, items: [li('甲'), li('乙'), li('丙')] }])
  assert.deepEqual(parseMarkdown('1. 甲\n2. 乙'), [{ kind: 'list', ordered: true, items: [li('甲', { number: 1 }), li('乙', { number: 2 })] }])
  assert.deepEqual(parseMarkdown('- 甲\n  - 甲一\n    - 甲二\n- 乙'), [{
    kind: 'list',
    ordered: false,
    items: [
      li('甲', { children: [li('甲一'), li('甲二')] }),
      li('乙'),
    ],
  }])
  assert.deepEqual(parseMarkdown('- 甲\n  续行'), [{ kind: 'list', ordered: false, items: [li('甲\n续行')] }])
  // Loose list: a blank line between same-kind items keeps ONE list; a
  // different marker kind after the blank starts a new one.
  assert.deepEqual(parseMarkdown('- 甲\n\n- 乙'), [{ kind: 'list', ordered: false, items: [li('甲'), li('乙')] }])
  {
    const blocks = parseMarkdown('- 甲\n\n1. 乙')
    assert.equal(blocks.length, 2)
    assert.deepEqual(blocks.map((b) => b.kind), ['list', 'list'])
  }
  // The marker's trailing space is load-bearing: "3.14" is prose.
  assert.deepEqual(parseMarkdown('3.14 是圆周率'), [{ kind: 'para', spans: [{ kind: 'text', text: '3.14 是圆周率' }] }])

  // Tables: alignment row parsed per column, cells inline-parsed, short rows
  // pad to the header width, extra cells drop, and a pipe line WITHOUT a
  // delimiter row stays a paragraph.
  {
    const [table] = parseMarkdown('| A | B | C |\n| :- | :-: | --: |\n| a | b |\n| a | b | c | d |')
    assert.equal(table.kind, 'table')
    assert.deepEqual(table.align, ['left', 'center', 'right'])
    assert.deepEqual(table.header, [
      [{ kind: 'text', text: 'A' }],
      [{ kind: 'text', text: 'B' }],
      [{ kind: 'text', text: 'C' }],
    ])
    assert.deepEqual(table.rows[0], [[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }], []])
    assert.deepEqual(table.rows[1].map((cell) => cell.length), [1, 1, 1])
  }
  {
    const [table] = parseMarkdown('| **粗** | `x` |\n| --- | --- |')
    assert.equal(table.kind, 'table')
    assert.deepEqual(table.header, [
      [{ kind: 'bold', spans: [{ kind: 'text', text: '粗' }] }],
      [{ kind: 'code', text: 'x' }],
    ])
    assert.deepEqual(table.align, [null, null], 'plain --- means unspecified alignment')
  }
  assert.deepEqual(parseMarkdown('a | b'), [{ kind: 'para', spans: [{ kind: 'text', text: 'a | b' }] }])

  // Thematic breaks: 3+ of one char (- * _) with optional spaces; '** **' is
  // one too (stars + spaces only), so the whitespace-emphasis fallback below
  // uses it inside a sentence instead.
  for (const src of ['---', '***', '___', '- - -', '  ----']) {
    assert.deepEqual(parseMarkdown(src), [{ kind: 'hr' }], `hr: ${src.trim()}`)
  }

  // Own-line markdown image becomes a placeholder block (alt/src recorded for
  // a future v2); inline inside a sentence it degrades to '!' + a link span.
  assert.deepEqual(parseMarkdown('![架构](https://e.x/a.png)'), [{ kind: 'image', alt: '架构', src: 'https://e.x/a.png' }])
  assert.deepEqual(parseMarkdown('看 ![图](u) 完'), [{
    kind: 'para',
    spans: [
      { kind: 'text', text: '看 !' },
      { kind: 'link', spans: [{ kind: 'text', text: '图' }], href: 'u' },
      { kind: 'text', text: ' 完' },
    ],
  }])

  // Inline spans of every kind, plus nesting (emphasis inside emphasis, code
  // inside paragraphs protecting its markers, bold link text).
  const inlineOf = (src) => {
    const [block] = parseMarkdown(src)
    assert.equal(block.kind, 'para')
    return block.spans
  }
  assert.deepEqual(inlineOf('**粗**'), [{ kind: 'bold', spans: [{ kind: 'text', text: '粗' }] }])
  assert.deepEqual(inlineOf('*斜*'), [{ kind: 'italic', spans: [{ kind: 'text', text: '斜' }] }])
  assert.deepEqual(inlineOf('***粗斜***'), [{ kind: 'bold', spans: [{ kind: 'italic', spans: [{ kind: 'text', text: '粗斜' }] }] }])
  assert.deepEqual(inlineOf('~~删~~'), [{ kind: 'strike', spans: [{ kind: 'text', text: '删' }] }])
  assert.deepEqual(inlineOf('`码`'), [{ kind: 'code', text: '码' }])
  assert.deepEqual(inlineOf('`*x*`'), [{ kind: 'code', text: '*x*' }])
  assert.deepEqual(inlineOf('[标签](https://e.x)'), [{ kind: 'link', spans: [{ kind: 'text', text: '标签' }], href: 'https://e.x' }])
  assert.deepEqual(inlineOf('[](https://e.x)'), [{ kind: 'link', spans: [{ kind: 'text', text: 'https://e.x' }], href: 'https://e.x' }], 'empty link text shows the URL itself')
  assert.deepEqual(inlineOf('**a *i* c**'), [{
    kind: 'bold',
    spans: [{ kind: 'text', text: 'a ' }, { kind: 'italic', spans: [{ kind: 'text', text: 'i' }] }, { kind: 'text', text: ' c' }],
  }])
  assert.deepEqual(inlineOf('[**粗链**](u)'), [{ kind: 'link', spans: [{ kind: 'bold', spans: [{ kind: 'text', text: '粗链' }] }], href: 'u' }])

  // Escapes: backslash + ASCII punctuation yields the literal char; a
  // backslash before anything else stays a backslash.
  assert.deepEqual(inlineOf('a \\*not em\\* b'), [{ kind: 'text', text: 'a *not em* b' }])
  assert.deepEqual(inlineOf('\\`码\\`'), [{ kind: 'text', text: '`码`' }])
  assert.deepEqual(inlineOf('\\[not a link\\](x)'), [{ kind: 'text', text: '[not a link](x)' }])
  assert.deepEqual(inlineOf('a\\\\b'), [{ kind: 'text', text: 'a\\b' }])

  // THE fallback rule: unclosed or implausible markers are literal text.
  assert.deepEqual(inlineOf('**没闭'), [{ kind: 'text', text: '**没闭' }])
  assert.deepEqual(inlineOf('*没闭'), [{ kind: 'text', text: '*没闭' }])
  assert.deepEqual(inlineOf('`没闭'), [{ kind: 'text', text: '`没闭' }])
  assert.deepEqual(inlineOf('~~没闭'), [{ kind: 'text', text: '~~没闭' }])
  assert.deepEqual(inlineOf('[没闭](u'), [{ kind: 'text', text: '[没闭](u' }])
  assert.deepEqual(inlineOf('[没括号] 后面'), [{ kind: 'text', text: '[没括号] 后面' }])
  assert.deepEqual(inlineOf('a ** ** b'), [{ kind: 'text', text: 'a ** ** b' }], 'whitespace-only emphasis falls back')
  // Flanking: an opener must touch non-space on both ends, so arithmetic and
  // spaced asterisks never italicize.
  assert.deepEqual(inlineOf('5 * 3 = 15'), [{ kind: 'text', text: '5 * 3 = 15' }])
  assert.deepEqual(inlineOf('a * b * c'), [{ kind: 'text', text: 'a * b * c' }])

  // Exact-run closers (review 09, P2): a longer run must NOT close a shorter
  // marker. `*a **b** c*` parses as nested emphasis (the inner bold pair is
  // skipped whole while hunting the outer single-star closer); the adjacent
  // closer families that cannot close cleanly round-trip as literals —
  // leaking mid-content stars into the share image is the one failure this
  // parser must never produce.
  assert.deepEqual(inlineOf('*a **b** c*'), [{
    kind: 'italic',
    spans: [{ kind: 'text', text: 'a ' }, { kind: 'bold', spans: [{ kind: 'text', text: 'b' }] }, { kind: 'text', text: ' c' }],
  }])
  assert.deepEqual(inlineOf('**a *b***'), [{ kind: 'text', text: '**a *b***' }])
  assert.deepEqual(inlineOf('*****x*****'), [{ kind: 'text', text: '*****x*****' }])
  assert.deepEqual(inlineOf('~~a ~~~ b~~'), [{ kind: 'strike', spans: [{ kind: 'text', text: 'a ~~~ b' }] }], 'a ~~~ triple is not a ~~ closer')

  // Totality guards (review 09, P2/P3): nesting carries a depth ceiling and a
  // pathological single paragraph past the inline-length ceiling parses as
  // plain text — both return in milliseconds instead of throwing / scanning
  // quadratic.
  {
    const deep = parseMarkdown('> '.repeat(10_000) + 'x')
    assert.ok(Array.isArray(deep) && deep.length >= 1, 'deep quote chain must not throw')
    const pathological = parseMarkdown(('*a ').repeat(20_000))
    assert.deepEqual(pathological, [{ kind: 'para', spans: [{ kind: 'text', text: ('*a ').repeat(20_000) }] }], 'over-length paragraph downgrades to plain text')
  }
}

// ---- ticket 09: parser output shape snapshot -----------------------------------
// One comprehensive document pinned in full: the renderer switches over this
// tree, so any parser change that reshapes it must be conscious (snapshot and
// renderer move together). This is the drift tripwire the ticket asked for.
assert.deepEqual(parseMarkdown([
  '# 标题一',
  '',
  '段落 **粗** *斜* `码` ~~删~~ [链](https://e.x/a) 转义 \\*星\\*。',
  '',
  '## 标题二',
  '',
  '- 甲',
  '  - 甲一',
  '- 乙',
  '',
  '1. 步一',
  '2. 步二',
  '',
  '> 引用行',
  '> 第二行',
  '',
  '| A | B |',
  '| :- | --: |',
  '| a | b |',
  '',
  '```ts',
  'const x: number = 1',
  '```',
  '',
  '---',
  '',
  '![图](https://e.x/i.png)',
].join('\n')), [
  { kind: 'heading', level: 1, spans: [{ kind: 'text', text: '标题一' }] },
  {
    kind: 'para',
    spans: [
      { kind: 'text', text: '段落 ' },
      { kind: 'bold', spans: [{ kind: 'text', text: '粗' }] },
      { kind: 'text', text: ' ' },
      { kind: 'italic', spans: [{ kind: 'text', text: '斜' }] },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: '码' },
      { kind: 'text', text: ' ' },
      { kind: 'strike', spans: [{ kind: 'text', text: '删' }] },
      { kind: 'text', text: ' ' },
      { kind: 'link', spans: [{ kind: 'text', text: '链' }], href: 'https://e.x/a' },
      { kind: 'text', text: ' 转义 *星*。' },
    ],
  },
  { kind: 'heading', level: 2, spans: [{ kind: 'text', text: '标题二' }] },
  {
    kind: 'list',
    ordered: false,
    items: [
      { spans: [{ kind: 'text', text: '甲' }], number: undefined, children: [{ spans: [{ kind: 'text', text: '甲一' }], number: undefined, children: [] }] },
      { spans: [{ kind: 'text', text: '乙' }], number: undefined, children: [] },
    ],
  },
  {
    kind: 'list',
    ordered: true,
    items: [
      { spans: [{ kind: 'text', text: '步一' }], number: 1, children: [] },
      { spans: [{ kind: 'text', text: '步二' }], number: 2, children: [] },
    ],
  },
  { kind: 'quote', children: [{ kind: 'para', spans: [{ kind: 'text', text: '引用行\n第二行' }] }] },
  {
    kind: 'table',
    align: ['left', 'right'],
    header: [[{ kind: 'text', text: 'A' }], [{ kind: 'text', text: 'B' }]],
    rows: [[[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]]],
  },
  { kind: 'code', lang: 'ts', lines: ['const x: number = 1'] },
  { kind: 'hr' },
  { kind: 'image', alt: '图', src: 'https://e.x/i.png' },
])

// ---- structural contracts the math depends on ---------------------------------
// rasterize.ts may only import the PURE constants module of its directory:
// this script loads it via Node type stripping, which EXECUTES every value
// import (JSX or DOM code would break the check), and the client bundler
// inlines it next to share-preview without new externals. share-constants.ts
// is the single source both the template and the rasterizer consume, so the
// width formulas can never drift from the rendered bubble again.
const rasterizeSrc = readFileSync(new URL('../src/client/share/rasterize.ts', import.meta.url), 'utf8')
const rasterizeImportSpecifiers = [...rasterizeSrc.matchAll(/^\s*import[^;\n]*from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1])
assert.deepEqual(
  rasterizeImportSpecifiers, ['./share-constants.ts'],
  'rasterize.ts may only import this directory\'s pure constants module (type stripping + externals budget)',
)
assert.match(rasterizeSrc, /export (async )?function (rasterizeShareCard|ensureProbe|planShareSlices)/)
assert.match(rasterizeSrc, /drawImage\(img, 0, 0\)/, 'paint must be a 1:1 copy — the SVG intrinsic size already IS the physical target')
assert.match(rasterizeSrc, /已省略前/, 'the default truncation note must count the dropped head turns')

// The constants module itself must stay a pure leaf: an import here would
// execute in this check, and JSX/DOM module scope would break type stripping.
const constantsSrc = readFileSync(new URL('../src/client/share/share-constants.ts', import.meta.url), 'utf8')
assert.doesNotMatch(constantsSrc, /^\s*import/m, 'share-constants.ts must stay import-free (pure leaf both sides consume)')

// png-stitch.ts is held to the same pure-leaf contract — this script imports
// it BY VALUE through type stripping (module scope executes), so it may carry
// no imports at all, and its browser globals (CompressionStream /
// createImageBitmap / document) must stay inside function/class bodies. The
// writer tests above prove the Node-loadable half runs for real.
const stitchSrc = readFileSync(new URL('../src/client/share/png-stitch.ts', import.meta.url), 'utf8')
assert.doesNotMatch(stitchSrc, /^\s*import/m, 'png-stitch.ts must stay import-free (pure leaf loadable by type stripping anywhere)')
assert.match(stitchSrc, /typeof CompressionStream === 'function'/, 'the stitch feature-detect gates on CompressionStream (old browsers fall back to multi-file)')

// The ticket-05 modules ride the same type-stripping constraint: a VALUE
// import (of share-card.tsx's JSX, or of anything touching the DOM at module
// scope) would fail this script's own import above. `import type` is erased
// by both tsc and Node's stripper, so only those are allowed. Constructing
// the error classes above additionally proves the constructor-parameter-
// property syntax (which the stripper rejects) is absent.
for (const mod of ['fetch-share.ts', 'share-flow.ts']) {
  const src = readFileSync(new URL(`../src/client/share/${mod}`, import.meta.url), 'utf8')
  assert.doesNotMatch(src, /^\s*import\s(?!type )/m, `${mod} must only import types (type stripping keeps it loadable here)`)
}

// share-card.tsx must CONSUME the shared constants module — that import is
// what makes the constants above the single source of truth for the bubble
// geometry (the retired regexes used to pin '82%' / '9px 14px' literals; the
// card root's padding/gap need no pin at all, the rasterizer measures them
// off the rendered clone).
const cardSrc = readFileSync(new URL('../src/client/share/share-card.tsx', import.meta.url), 'utf8')
assert.match(cardSrc, /from '\.\/share-constants\.ts'/, 'share-card must import the shared template constants (rasterize inverts them)')
assert.match(cardSrc, /data-share-role=\{turn\.role\}/, 'turn rows must carry data-share-role for role-aware width lifting')
assert.match(cardSrc, /whiteSpace: 'pre'/, 'code-block lines must keep natural width (the width probe depends on it)')
assert.match(cardSrc, /whiteSpace: 'nowrap'/, 'table cells must keep natural width (the width probe depends on it)')
// Ticket 09: assistant text renders through the markdown parser, user text
// keeps the ticket-03 plain-text fold (Chat-view parity), and the card stays
// className-free — the SVG-image render loads no stylesheets.
assert.match(cardSrc, /from '\.\/markdown\.ts'/, 'assistant text must render through the markdown parser')
assert.match(cardSrc, /from '\.\/text-layout\.ts'/, 'user text keeps the ticket-03 plain-text fold')
assert.ok(!/className[=:]/.test(cardSrc), 'share-card must stay className-free (foreignObject rasterization red line)')
// Inheritable-text drift guards: the shadow-root measurement inherits the
// host page's values while the SVG-image render starts from engine defaults,
// so every unpinned inheritable text property is a width-measurement drift
// channel (all pinned values are CSS initial values).
assert.match(cardSrc, /letterSpacing: 'normal'/, 'card root must pin letterSpacing so page and SVG renders agree')
assert.match(cardSrc, /wordBreak: 'normal'/, 'card root must pin wordBreak')
assert.match(cardSrc, /overflowWrap: 'normal'/, 'card root must pin overflowWrap')
assert.match(cardSrc, /hyphens: 'manual'/, 'card root must pin hyphens (initial value)')
assert.match(cardSrc, /textAlign: 'start'/, 'card root must pin textAlign')
assert.match(cardSrc, /textTransform: 'none'/, 'card root must pin textTransform')
assert.match(cardSrc, /tabSize: 8/, 'card root must pin tabSize (engine default 8)')
assert.match(cardSrc, /fontVariantLigatures: 'normal'/, 'card root must pin fontVariantLigatures')

// markdown.ts (ticket 09) rides the same pure-leaf contract as the constants
// module: import-free so this script's own type-stripped import above can load
// it, and the client bundler inlines it with no new externals.
const mdSrc = readFileSync(new URL('../src/client/share/markdown.ts', import.meta.url), 'utf8')
assert.doesNotMatch(mdSrc, /^\s*import/m, 'markdown.ts must stay import-free (pure leaf loadable by type stripping)')

console.log('SHARE IMAGE CHECK OK')
