import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
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

const EXTRAS = { gap: 14, paddingY: 36, headerHeight: 90, footerHeight: 60, noteHeight: 40 }
const OPTS = { budgetPx: SLICE_PIXEL_BUDGET, maxSlices: MAX_SLICES, ratios: [2, 1.5, 1] }
const turn = (height, renderWidth = 390, scale = 1) => ({ height, renderWidth, scale })
const be32 = (bytes, off) => ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0

test('share constants, ratio ladder, pixel arithmetic, rasterGeometry, SVG, and width formulas', () => {
  assert.equal(BASE_CARD_WIDTH, 390)
  assert.equal(WIDE_SLICE_WIDTH, 780)
  assert.equal(USER_BUBBLE_MAX_RATIO, 0.82)
  assert.equal(USER_BUBBLE_PAD_X, 14)
  assert.equal(SLICE_PIXEL_BUDGET, 12_000_000)
  assert.equal(MAX_SLICES, 24)
  assert.deepEqual(PIXEL_RATIO_STEPS, [2, 1.5, 1])

  assert.deepEqual(ratioChain(2), [2, 1.5, 1])
  assert.deepEqual(ratioChain(3), [2, 1.5, 1])
  assert.deepEqual(ratioChain(1.5), [1.5, 1])
  assert.deepEqual(ratioChain(1.2), [1])
  assert.deepEqual(ratioChain(1), [1])
  assert.deepEqual(ratioChain(0.5), [1])

  assert.equal(slicePixelCount(390, 7692, 2), 780 * 15384)
  assert.ok(slicePixelCount(390, 7692, 2) <= SLICE_PIXEL_BUDGET)
  assert.ok(slicePixelCount(390, 7693, 2) > SLICE_PIXEL_BUDGET)
  assert.equal(slicePixelCount(780, 4000, 1), 3_120_000)
  assert.equal(slicePixelCount(390.5, 100, 2), 781 * 200)

  {
    const g = rasterGeometry(390, 714, 1, 2, SLICE_PIXEL_BUDGET)
    assert.equal(g.width, 780)
    assert.equal(g.height, 1428)
    assert.equal(g.transformScale, 2)
  }
  {
    const g = rasterGeometry(938, 714, 780 / 938, 2, SLICE_PIXEL_BUDGET)
    assert.equal(g.width, 1560)
    assert.equal(g.height, 1188)
    assert.ok(Math.abs(g.transformScale - (2 * 780) / 938) < 1e-12)
  }
  {
    const g = rasterGeometry(780, 5000, 1, 2, SLICE_PIXEL_BUDGET)
    assert.equal(g.width, 1368)
    assert.equal(g.height, 8770)
    assert.ok(g.width * g.height <= SLICE_PIXEL_BUDGET)
    assert.ok(g.transformScale < 2)
  }

  {
    const svg = buildSvgDocument('<div xmlns="http://www.w3.org/1999/xhtml">hi</div>', {
      renderWidth: 390, logicalHeight: 714, width: 780, height: 1428, transformScale: 2,
    })
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="780" height="1428"><foreignObject width="780" height="1428">'))
    assert.ok(svg.includes('<div xmlns="http://www.w3.org/1999/xhtml" style="width:390px;height:714px;transform:scale(2);transform-origin:0 0">'))
    assert.ok(svg.includes('>hi<'))
    assert.ok(svg.endsWith('</foreignObject></svg>'))
    const scrubbed = buildSvgDocument('a\u0000b', { renderWidth: 10, logicalHeight: 10, width: 20, height: 20, transformScale: 2 })
    assert.ok(!scrubbed.includes('\u0000'))
  }

  assert.equal(cardWidthForContent(900, 18), 938)
  assert.equal(requiredCardWidth('assistant', 900, 18), 938)
  assert.equal(cardWidthForUserBubble(900, 18), Math.ceil(928 / 0.82) + 38)
  assert.equal(cardWidthForUserBubble(900, 18), 1170)
  assert.equal(requiredCardWidth('user', 900, 18), 1170)

  assert.equal(bucketTurnWidth('assistant', 352, 18, 390, 780), 'base')
  assert.equal(bucketTurnWidth('assistant', 353, 18, 390, 780), 'wide')
  assert.equal(bucketTurnWidth('assistant', 742, 18, 390, 780), 'wide')
  assert.equal(bucketTurnWidth('assistant', 743, 18, 390, 780), 'ultra')
  assert.equal(bucketTurnWidth('user', 260, 18, 390, 780), 'base')
  assert.equal(bucketTurnWidth('user', 261, 18, 390, 780), 'wide')
  assert.equal(bucketTurnWidth('user', 580, 18, 390, 780), 'wide')
  assert.equal(bucketTurnWidth('user', 581, 18, 390, 780), 'ultra')
  assert.equal(bucketTurnWidth('assistant', 0, 18, 390, 780), 'base')

  {
    const a = ultraSliceWidth('assistant', 900, 18, 780)
    assert.equal(a.renderWidth, 938)
    assert.ok(Math.abs(a.scale - 780 / 938) < 1e-12)
    assert.ok(a.scale < 1)
    const u = ultraSliceWidth('user', 900, 18, 780)
    assert.equal(u.renderWidth, 1170)
    assert.ok(Math.abs(u.scale - 780 / 1170) < 1e-12)
  }
})

test('planShareSlices and planShareSlicesUnified', () => {
  assert.deepEqual(planShareSlices([], EXTRAS, OPTS), { pixelRatio: 1, slices: [], truncated: false, droppedTurns: 0 })

  {
    const plan = planShareSlices([turn(500)], EXTRAS, OPTS)
    assert.equal(plan.pixelRatio, 2)
    assert.equal(plan.slices.length, 1)
    const [s] = plan.slices
    assert.equal(s.height, 714)
    assert.equal(s.outWidth, 390)
    assert.equal(s.outHeight, 714)
    assert.equal(s.lever, 1)
    assert.ok(s.first && s.last && !s.truncated)
    assert.equal(plan.truncated, false)
    assert.equal(plan.droppedTurns, 0)
  }

  {
    const plan = planShareSlices([turn(5000), turn(5000)], EXTRAS, OPTS)
    assert.equal(plan.pixelRatio, 2)
    assert.equal(plan.slices.length, 2)
    const [a, b] = plan.slices
    assert.equal(`${a.from}-${a.to}`, '0-0')
    assert.equal(`${b.from}-${b.to}`, '1-1')
    assert.equal(a.height, 5140)
    assert.equal(b.height, 5110)
    for (const s of plan.slices) {
      assert.ok(slicePixelCount(s.outWidth, s.outHeight, plan.pixelRatio) <= SLICE_PIXEL_BUDGET)
    }
  }

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

  {
    const plan = planShareSlices(Array.from({ length: 30 }, () => turn(6500)), EXTRAS, OPTS)
    assert.equal(plan.pixelRatio, 1.5)
    assert.equal(plan.slices.length, 15)
    assert.ok(plan.slices.every((s) => s.lever === 1))
  }

  {
    const plan = planShareSlices(Array.from({ length: 120 }, () => turn(7600)), EXTRAS, OPTS)
    assert.equal(plan.pixelRatio, 1)
    assert.equal(plan.slices.length, MAX_SLICES)
    assert.equal(plan.truncated, true)
    assert.equal(plan.droppedTurns, 24)
    assert.equal(plan.slices[0].from, 24)
    assert.equal(plan.slices.at(-1).to, 119)
    assert.equal(plan.slices[0].truncated, true)
    assert.equal(plan.slices[1].truncated, false)
    assert.equal(plan.slices.at(-1).truncated, false)
    const first = plan.slices[0]
    assert.equal(first.height, 36 + (90 + 14) + (40 + 14) + 4 * 7600 + 3 * 14)
    const last = plan.slices.at(-1)
    assert.equal(last.height, 36 + 4 * 7600 + 3 * 14 + (14 + 60))
    assert.ok(slicePixelCount(first.outWidth, first.outHeight, 1) <= SLICE_PIXEL_BUDGET)
    assert.ok(slicePixelCount(last.outWidth, last.outHeight, 1) <= SLICE_PIXEL_BUDGET)
  }

  {
    const plan = planShareSlices([turn(300), turn(250, 780), turn(300)], EXTRAS, OPTS)
    assert.equal(plan.pixelRatio, 2)
    assert.deepEqual(plan.slices.map((s) => s.renderWidth), [390, 780, 390])
    assert.deepEqual(plan.slices.map((s) => s.height), [36 + 104 + 300, 36 + 250, 36 + 74 + 300])
    assert.deepEqual(plan.slices.map((s) => s.first), [true, false, false])
    assert.deepEqual(plan.slices.map((s) => s.last), [false, false, true])
  }

  {
    const plan = planShareSlices([turn(400, 938, 780 / 938)], EXTRAS, OPTS)
    assert.equal(plan.pixelRatio, 2)
    const [s] = plan.slices
    assert.equal(s.renderWidth, 938)
    assert.ok(Math.abs(s.outWidth - 780) < 0.01)
    assert.ok(s.scale < 1 && s.scale > 0.8)
    assert.equal(s.lever, 1)
  }

  {
    const plan = planShareSlices([turn(40000)], EXTRAS, OPTS)
    assert.equal(plan.pixelRatio, 1)
    assert.equal(plan.slices.length, 1)
    assert.equal(plan.truncated, false)
    const [s] = plan.slices
    assert.ok(s.lever < 1)
    assert.ok(s.scale < 0.88)
    assert.ok(slicePixelCount(s.outWidth, s.outHeight, 1) <= SLICE_PIXEL_BUDGET)
  }

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

  {
    const plan = planShareSlices([turn(45000, 2000, 0.39)], EXTRAS, OPTS)
    assert.equal(plan.pixelRatio, 1)
    assert.equal(plan.slices.length, 1)
    assert.equal(plan.truncated, false)
    const [s] = plan.slices
    assert.ok(s.lever < 1)
    assert.ok(s.scale < 0.39)
    assert.ok(s.outWidth < 780)
    assert.ok(slicePixelCount(s.outWidth, s.outHeight, 1) <= SLICE_PIXEL_BUDGET)
  }

  {
    const err = new ShareRasterizeError('probe-failed', 'blank')
    assert.ok(err instanceof Error)
    assert.equal(err.code, 'probe-failed')
    assert.equal(err.detail, 'blank')
    assert.match(err.message, /probe-failed/)
  }

  assert.equal(unifiedCardWidth(false), BASE_CARD_WIDTH)
  assert.equal(unifiedCardWidth(true), WIDE_SLICE_WIDTH)
  {
    const plan = planShareSlicesUnified([turn(500, 780)], EXTRAS, OPTS)
    assert.equal(plan.pixelRatio, 2)
    assert.equal(plan.slices.length, 1)
    assert.equal(plan.slices[0].outWidth, 780)
    assert.equal(stitchPixelWidth(plan), 1560)
  }
  {
    const plan = planShareSlicesUnified(Array.from({ length: 120 }, () => turn(7600)), EXTRAS, OPTS)
    assert.equal(plan.pixelRatio, 1)
    assert.equal(plan.slices.length, MAX_SLICES)
    assert.equal(plan.truncated, true)
    assert.ok(plan.droppedTurns > 0)
    assert.equal(plan.slices[0].from, plan.droppedTurns)
    assert.equal(plan.slices.at(-1).to, 119)
    assert.equal(plan.slices[0].truncated, true)
  }
  {
    const plan = planShareSlicesUnified([turn(40000), turn(500)], EXTRAS, OPTS)
    assert.equal(plan.pixelRatio, 1)
    assert.equal(plan.slices.length, 2)
    const [giant, normal] = plan.slices
    assert.ok(giant.lever < 1)
    assert.equal(normal.lever, giant.lever)
    assert.ok(Math.abs(normal.outWidth - giant.outWidth) < 1e-9)
    assert.ok(slicePixelCount(giant.outWidth, giant.outHeight, 1) <= SLICE_PIXEL_BUDGET)
    const legacy = planShareSlices([turn(40000), turn(500)], EXTRAS, OPTS)
    assert.equal(legacy.slices[1].lever, 1)
  }
  {
    const plan = planShareSlicesUnified([turn(5000, 780), turn(5000, 780)], EXTRAS, OPTS)
    const width = stitchPixelWidth(plan)
    assert.equal(width, 1170)
    for (const s of plan.slices) assert.equal(Math.ceil(s.outWidth * plan.pixelRatio), width)
    assert.equal(stitchPixelWidth({ ...plan, slices: [] }), 0)
  }
  {
    const plan = planShareSlicesUnified([turn(400, 938, 780 / 938), turn(500, 780)], EXTRAS, OPTS)
    assert.equal(plan.pixelRatio, 2)
    assert.equal(stitchPixelWidth(plan), 1560)
    for (const s of plan.slices) assert.ok(Math.abs(s.outWidth - 780) < 1e-9)
  }
  {
    const geo = rasterGeometryStitch(780, 714, 1560, SLICE_PIXEL_BUDGET)
    assert.equal(geo.width, 1560)
    assert.equal(geo.height, 1428)
    assert.ok(Math.abs(geo.transformScale - 2) < 1e-12)
    assert.equal(geo.clamped, false)
  }
  {
    const geo = rasterGeometryStitch(780, 7693, 1560, SLICE_PIXEL_BUDGET)
    assert.equal(geo.width, 1560)
    assert.equal(geo.height, Math.floor(SLICE_PIXEL_BUDGET / 1560))
    assert.ok(geo.width * geo.height <= SLICE_PIXEL_BUDGET)
    assert.equal(geo.clamped, true)
    const ultra = rasterGeometryStitch(938, 714, 1560, SLICE_PIXEL_BUDGET)
    assert.equal(ultra.width, 1560)
    assert.ok(Math.abs(ultra.transformScale - 1560 / 938) < 1e-12)
    assert.equal(ultra.height, Math.ceil(714 * (1560 / 938)))
    assert.throws(() => rasterGeometryStitch(780, 714, 0, SLICE_PIXEL_BUDGET), /invalid stitch width/)
  }
})

test('fetch-share query builder, error taxonomy, and filename sanitizer', () => {
  assert.equal(SHARE_EXPORT_ROUTE, '/_dsh/mobile-nav/share-export')
  assert.deepEqual(SHARE_TURNS_PRESETS, [3, 5, 10])
  assert.equal(
    buildShareExportQuery('session-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', { kind: 'all' }),
    '/_dsh/mobile-nav/share-export?session=session-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0&range=all',
  )
  assert.equal(
    buildShareExportQuery('session-abc', { kind: 'last', turns: 5 }),
    '/_dsh/mobile-nav/share-export?session=session-abc&range=last&turns=5',
  )
  assert.equal(
    buildShareExportQuery('session-a/b?c=d', { kind: 'all' }),
    `/_dsh/mobile-nav/share-export?session=${encodeURIComponent('session-a/b?c=d')}&range=all`,
  )
  assert.ok(!buildShareExportQuery('session-x', { kind: 'all' }).includes('turns='))
  const hostRouteSrc = readFileSync(new URL('../src/share-export.ts', import.meta.url), 'utf8')
  assert.match(hostRouteSrc, new RegExp(`'${SHARE_EXPORT_ROUTE.replace(/\//g, '\\/')}'`))

  const err = new ShareFetchError('route-missing', 404, 'no envelope')
  assert.ok(err instanceof Error)
  assert.equal(err.code, 'route-missing')
  assert.equal(err.status, 404)
  assert.match(err.message, /route-missing/)
  const net = new ShareFetchError('network', undefined, 'offline')
  assert.equal(net.status, undefined)
  assert.ok(net instanceof ShareFetchError)

  assert.equal(sanitizeShareFileName('网关错误率报表'), '网关错误率报表')
  assert.equal(sanitizeShareFileName('a/b\\c|d'), 'a b c|d')
  assert.equal(sanitizeShareFileName('two\n\n  spaces\tand tab'), 'two spaces and tab')
  assert.equal(sanitizeShareFileName('\u0000control\u001F\u007Fchars'), 'controlchars')
  assert.equal(sanitizeShareFileName('photo\u202Egpj.png'), 'photogpj.png')
  assert.equal(sanitizeShareFileName('a\u200Eb\u200Fc\u202Ad\u202Be\u202Cf\u202Dg'), 'abcdefg')
  assert.equal(sanitizeShareFileName('   '), FALLBACK_SHARE_BASE_NAME)
  assert.equal(sanitizeShareFileName('///\\\\'), FALLBACK_SHARE_BASE_NAME)
  assert.equal(sanitizeShareFileName(' leading and trailing '), 'leading and trailing')

  const emoji = '😀'.repeat(SHARE_NAME_MAX + 5)
  const capped = sanitizeShareFileName(emoji)
  assert.equal(Array.from(capped).length, SHARE_NAME_MAX)
  assert.ok(!capped.includes('\uFFFD'))
  const cjk = '汉'.repeat(SHARE_NAME_MAX + 10)
  assert.equal(Array.from(sanitizeShareFileName(cjk)).length, SHARE_NAME_MAX)

  assert.equal(shareSliceFileName('share-card', 0), 'share-card-01.png')
  assert.equal(shareSliceFileName('报表', 11), '报表-12.png')
  assert.equal(shareImageFileName('报表'), '报表.png')
  assert.equal(shareImageFileName('share-card'), 'share-card.png')
  assert.ok(shareImageFileName(FALLBACK_SHARE_BASE_NAME).endsWith('.png'))
})

test('PNG byte layer and PngStitchWriter single & multi-IDAT round-trips', async () => {
  const ENC = new TextEncoder()
  assert.equal(crc32(new Uint8Array(0)), 0)
  assert.equal(crc32(ENC.encode('123456789')), 0xcbf43926)
  assert.equal(crc32(ENC.encode('IEND')), 0xae426082)
  {
    const data = ENC.encode('hello world')
    const chunk = pngChunk('IDAT', data)
    assert.equal(chunk.length, 12 + data.length)
    assert.equal(be32(chunk, 0), data.length)
    assert.equal(String.fromCharCode(...chunk.slice(4, 8)), 'IDAT')
    const crcInput = new Uint8Array(4 + data.length)
    crcInput.set(chunk.slice(4, 8))
    crcInput.set(data, 4)
    assert.equal(be32(chunk, 8 + data.length), crc32(crcInput))
    const wide = pngChunk('odAT', new Uint8Array(0x1234))
    assert.equal(be32(wide, 0), 0x1234)
    assert.equal(wide[2], 0x12)
    assert.equal(wide[3], 0x34)
    assert.throws(() => pngChunk('TOOLONG', data), /4 ASCII letters/)
  }
  {
    const d = ihdrData(1560, 12345)
    assert.equal(d.length, 13)
    assert.equal(be32(d, 0), 1560)
    assert.equal(be32(d, 4), 12345)
    assert.deepEqual([...d.slice(8)], [8, 6, 0, 0, 0])
  }
  {
    assert.equal(IEND_CHUNK.length, 12)
    assert.equal(be32(IEND_CHUNK, 0), 0)
    assert.equal(String.fromCharCode(...IEND_CHUNK.slice(4, 8)), 'IEND')
    assert.equal(be32(IEND_CHUNK, 8), 0xae426082)
  }
  {
    const bytes = ENC.encode('x'.repeat(10))
    assert.deepEqual(splitIdatBytes(bytes, 4).map((p) => p.length), [4, 4, 2])
    assert.equal(Buffer.concat(splitIdatBytes(bytes, 4).map(Buffer.from)).toString(), 'x'.repeat(10))
    assert.deepEqual(splitIdatBytes(new Uint8Array(0), 4).map((p) => p.length), [0])
    assert.throws(() => splitIdatBytes(bytes, 0), /invalid IDAT chunk size/)
  }

  // Small single-IDAT round-trip + row/height guards
  {
    const W = 3
    const H = 5
    const rows = Array.from({ length: H }, (_, y) => Uint8Array.from({ length: W * 4 }, (_, i) => (y * W * 4 + i) % 251))
    const writer = new PngStitchWriter(W, H)
    for (const row of rows) await writer.writeRow(row)
    const png = new Uint8Array(await (await writer.finish()).arrayBuffer())
    assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
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
    assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND'])
    assert.equal(be32(chunks[0].data, 0), W)
    assert.equal(be32(chunks[0].data, 4), H)
    const raw = inflateSync(Buffer.from(chunks[1].data))
    assert.equal(raw.length, H * (1 + W * 4))
    for (let y = 0; y < H; y++) {
      assert.equal(raw[y * (1 + W * 4)], 0)
      assert.deepEqual([...raw.subarray(y * (1 + W * 4) + 1, (y + 1) * (1 + W * 4))], [...rows[y]])
    }

    const underfed = new PngStitchWriter(W, 2)
    await underfed.writeRow(rows[0])
    await assert.rejects(() => underfed.finish(), /declared 2 rows but 1/)
    const badWidth = new PngStitchWriter(W, 1)
    await assert.rejects(() => badWidth.writeRow(new Uint8Array(3)), /expected 12/)
    const overfed = new PngStitchWriter(W, 1)
    await overfed.writeRow(rows[0])
    await assert.rejects(() => overfed.writeRow(rows[1]), /exceeds the declared height/)
  }

  // Multi-IDAT end-to-end: wide rows keep row-count small (~192 awaits vs 8192)
  // while crossing MAX_IDAT_CHUNK_BYTES (>=2 IDAT chunks) in < 50ms.
  {
    const W = 4096
    const H = 192
    const rowBytes = W * 4
    const rows = Array.from({ length: H }, () => randomBytes(rowBytes))
    const writer = new PngStitchWriter(W, H)
    for (const row of rows) await writer.writeRow(row)
    const png = new Uint8Array(await (await writer.finish()).arrayBuffer())
    const idats = []
    for (let off = 8; off < png.length;) {
      const len = be32(png, off)
      const type = String.fromCharCode(...png.slice(off + 4, off + 8))
      assert.equal(be32(png, off + 8 + len), crc32(png.slice(off + 4, off + 8 + len)), `${type} chunk CRC`)
      if (type === 'IDAT') idats.push(png.slice(off + 8, off + 8 + len))
      off += 12 + len
    }
    assert.ok(idats.length >= 2, `expected >=2 IDAT chunks, got ${idats.length}`)
    for (const [index, payload] of idats.entries()) {
      assert.ok(payload.length <= MAX_IDAT_CHUNK_BYTES, `IDAT ${index} respects the split ceiling`)
      assert.ok(payload.length > 0, `IDAT ${index} is never empty`)
    }
    const raw = inflateSync(Buffer.concat(idats.map(Buffer.from)))
    assert.equal(raw.length, H * (1 + rowBytes))
    const expected = Buffer.alloc(H * (1 + rowBytes))
    for (let y = 0; y < H; y++) {
      expected.writeUint8(0, y * (1 + rowBytes))
      rows[y].copy(expected, y * (1 + rowBytes) + 1)
    }
    assert.ok(raw.equals(expected))
  }
})

test('markdown parser: leniency, fallback, totality guards, and full snapshot', () => {
  assert.deepEqual(parseMarkdown(''), [])
  assert.deepEqual(parseMarkdown('\n \n\t\n'), [])

  assert.deepEqual(parseMarkdown('# 标题'), [{ kind: 'heading', level: 1, spans: [{ kind: 'text', text: '标题' }] }])
  assert.deepEqual(parseMarkdown('###### 六级 **粗**'), [{
    kind: 'heading',
    level: 6,
    spans: [{ kind: 'text', text: '六级 ' }, { kind: 'bold', spans: [{ kind: 'text', text: '粗' }] }],
  }])
  assert.deepEqual(parseMarkdown('####### 七个'), [{ kind: 'para', spans: [{ kind: 'text', text: '####### 七个' }] }])
  assert.deepEqual(parseMarkdown('#nospace'), [{ kind: 'para', spans: [{ kind: 'text', text: '#nospace' }] }])
  assert.deepEqual(parseMarkdown('第一行\n第二行'), [{ kind: 'para', spans: [{ kind: 'text', text: '第一行\n第二行' }] }])

  assert.deepEqual(parseMarkdown('```js\nconst x = 1\n```'), [{ kind: 'code', lang: 'js', lines: ['const x = 1'] }])
  assert.deepEqual(parseMarkdown('~~~\nplain\nbody\n~~~'), [{ kind: 'code', lang: undefined, lines: ['plain', 'body'] }])
  assert.deepEqual(parseMarkdown('```ts\nunterminated'), [{ kind: 'code', lang: 'ts', lines: ['unterminated'] }])
  assert.deepEqual(parseMarkdown('```\n```'), [{ kind: 'code', lang: undefined, lines: [] }])

  assert.deepEqual(parseMarkdown('    indented\n    more'), [{ kind: 'code', lang: undefined, lines: ['indented', 'more'] }])
  assert.deepEqual(parseMarkdown('    a\n\n    b'), [{ kind: 'code', lang: undefined, lines: ['a', '', 'b'] }])
  assert.deepEqual(parseMarkdown('正文\n    缩进'), [{ kind: 'para', spans: [{ kind: 'text', text: '正文\n    缩进' }] }])

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

  const li = (text, { number = undefined, children = [] } = {}) => ({ spans: [{ kind: 'text', text }], number, children })
  assert.deepEqual(parseMarkdown('- 甲\n- 乙\n+ 丙'), [{ kind: 'list', ordered: false, items: [li('甲'), li('乙'), li('丙')] }])
  assert.deepEqual(parseMarkdown('1. 甲\n2. 乙'), [{ kind: 'list', ordered: true, items: [li('甲', { number: 1 }), li('乙', { number: 2 })] }])
  assert.deepEqual(parseMarkdown('- 甲\n  - 甲一\n    - 甲二\n- 乙'), [{
    kind: 'list',
    ordered: false,
    items: [li('甲', { children: [li('甲一'), li('甲二')] }), li('乙')],
  }])
  assert.deepEqual(parseMarkdown('- 甲\n  续行'), [{ kind: 'list', ordered: false, items: [li('甲\n续行')] }])
  assert.deepEqual(parseMarkdown('- 甲\n\n- 乙'), [{ kind: 'list', ordered: false, items: [li('甲'), li('乙')] }])
  {
    const blocks = parseMarkdown('- 甲\n\n1. 乙')
    assert.equal(blocks.length, 2)
    assert.deepEqual(blocks.map((b) => b.kind), ['list', 'list'])
  }
  assert.deepEqual(parseMarkdown('3.14 是圆周率'), [{ kind: 'para', spans: [{ kind: 'text', text: '3.14 是圆周率' }] }])

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
    assert.deepEqual(table.align, [null, null])
  }
  assert.deepEqual(parseMarkdown('a | b'), [{ kind: 'para', spans: [{ kind: 'text', text: 'a | b' }] }])

  for (const src of ['---', '***', '___', '- - -', '  ----']) {
    assert.deepEqual(parseMarkdown(src), [{ kind: 'hr' }])
  }

  assert.deepEqual(parseMarkdown('![架构](https://e.x/a.png)'), [{ kind: 'image', alt: '架构', src: 'https://e.x/a.png' }])
  assert.deepEqual(parseMarkdown('看 ![图](u) 完'), [{
    kind: 'para',
    spans: [
      { kind: 'text', text: '看 !' },
      { kind: 'link', spans: [{ kind: 'text', text: '图' }], href: 'u' },
      { kind: 'text', text: ' 完' },
    ],
  }])

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
  assert.deepEqual(inlineOf('[](https://e.x)'), [{ kind: 'link', spans: [{ kind: 'text', text: 'https://e.x' }], href: 'https://e.x' }])
  assert.deepEqual(inlineOf('**a *i* c**'), [{
    kind: 'bold',
    spans: [{ kind: 'text', text: 'a ' }, { kind: 'italic', spans: [{ kind: 'text', text: 'i' }] }, { kind: 'text', text: ' c' }],
  }])
  assert.deepEqual(inlineOf('[**粗链**](u)'), [{ kind: 'link', spans: [{ kind: 'bold', spans: [{ kind: 'text', text: '粗链' }] }], href: 'u' }])

  assert.deepEqual(inlineOf('a \\*not em\\* b'), [{ kind: 'text', text: 'a *not em* b' }])
  assert.deepEqual(inlineOf('\\`码\\`'), [{ kind: 'text', text: '`码`' }])
  assert.deepEqual(inlineOf('\\[not a link\\](x)'), [{ kind: 'text', text: '[not a link](x)' }])
  assert.deepEqual(inlineOf('a\\\\b'), [{ kind: 'text', text: 'a\\b' }])

  assert.deepEqual(inlineOf('**没闭'), [{ kind: 'text', text: '**没闭' }])
  assert.deepEqual(inlineOf('*没闭'), [{ kind: 'text', text: '*没闭' }])
  assert.deepEqual(inlineOf('`没闭'), [{ kind: 'text', text: '`没闭' }])
  assert.deepEqual(inlineOf('~~没闭'), [{ kind: 'text', text: '~~没闭' }])
  assert.deepEqual(inlineOf('[没闭](u'), [{ kind: 'text', text: '[没闭](u' }])
  assert.deepEqual(inlineOf('[没括号] 后面'), [{ kind: 'text', text: '[没括号] 后面' }])
  assert.deepEqual(inlineOf('a ** ** b'), [{ kind: 'text', text: 'a ** ** b' }])
  assert.deepEqual(inlineOf('5 * 3 = 15'), [{ kind: 'text', text: '5 * 3 = 15' }])
  assert.deepEqual(inlineOf('a * b * c'), [{ kind: 'text', text: 'a * b * c' }])

  assert.deepEqual(inlineOf('*a **b** c*'), [{
    kind: 'italic',
    spans: [{ kind: 'text', text: 'a ' }, { kind: 'bold', spans: [{ kind: 'text', text: 'b' }] }, { kind: 'text', text: ' c' }],
  }])
  assert.deepEqual(inlineOf('**a *b***'), [{ kind: 'text', text: '**a *b***' }])
  assert.deepEqual(inlineOf('*****x*****'), [{ kind: 'text', text: '*****x*****' }])
  assert.deepEqual(inlineOf('~~a ~~~ b~~'), [{ kind: 'strike', spans: [{ kind: 'text', text: 'a ~~~ b' }] }])

  {
    const deep = parseMarkdown('> '.repeat(10_000) + 'x')
    assert.ok(Array.isArray(deep) && deep.length >= 1)
    const pathological = parseMarkdown(('*a ').repeat(20_000))
    assert.deepEqual(pathological, [{ kind: 'para', spans: [{ kind: 'text', text: ('*a ').repeat(20_000) }] }])
  }

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
})

test('share-card and rasterize SVG/className-free structural guards', () => {
  const rasterizeSrc = readFileSync(new URL('../src/client/share/rasterize.ts', import.meta.url), 'utf8')
  assert.match(rasterizeSrc, /export (async )?function (rasterizeShareCard|ensureProbe|planShareSlices)/)
  assert.match(rasterizeSrc, /drawImage\(img, 0, 0\)/)
  assert.match(rasterizeSrc, /已省略前/)

  const stitchSrc = readFileSync(new URL('../src/client/share/png-stitch.ts', import.meta.url), 'utf8')
  assert.match(stitchSrc, /typeof CompressionStream === 'function'/)

  const cardSrc = readFileSync(new URL('../src/client/share/share-card.tsx', import.meta.url), 'utf8')
  assert.match(cardSrc, /from '\.\/share-constants\.ts'/)
  assert.match(cardSrc, /data-share-role=\{turn\.role\}/)
  assert.match(cardSrc, /whiteSpace: 'pre'/)
  assert.match(cardSrc, /whiteSpace: 'nowrap'/)
  assert.match(cardSrc, /from '\.\/markdown\.ts'/)
  assert.match(cardSrc, /from '\.\/text-layout\.ts'/)
  assert.ok(!/className[=:]/.test(cardSrc), 'share-card must stay className-free (foreignObject rasterization red line)')
  assert.match(cardSrc, /letterSpacing: 'normal'/)
  assert.match(cardSrc, /wordBreak: 'normal'/)
  assert.match(cardSrc, /overflowWrap: 'normal'/)
  assert.match(cardSrc, /hyphens: 'manual'/)
  assert.match(cardSrc, /textAlign: 'start'/)
  assert.match(cardSrc, /textTransform: 'none'/)
  assert.match(cardSrc, /tabSize: 8/)
  assert.match(cardSrc, /fontVariantLigatures: 'normal'/)
})
