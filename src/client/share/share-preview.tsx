/**
 * Debug preview for the share-card template (ticket 03) + PNG export entry
 * (ticket 04, single long image since ticket 07): ?mobile-nav-share-preview=1
 * renders the card at the top of the page so the layout can be eyeballed at
 * any viewport, and the caption bar's 导出 PNG button drives the full
 * slice→rasterize→stitch pipeline, downloading ONE stitched PNG — the
 * acceptance path before ticket 05 wires the real UI.
 *
 * Debug-surface conventions follow debug.ts: the entry only mounts with the
 * URL param (the slot entry is not even registered without it — zero impact
 * otherwise, the same exemption ?mobile-nav-inset= enjoys), and its chrome
 * copy is hardcoded Chinese rather than locale keys, because it never ships
 * to end users. Only the card's own baked-in strings go through `t`.
 *
 * Data comes through fetch-share.ts (ticket 05) — the same typed fetch,
 * query builder and error taxonomy the real share flow uses; only the error
 * SURFACE differs (this panel folds any failure back to the fixture and
 * prints the code, the real UI maps codes to locale copy).
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { agentPresetOf } from '../compat/types.ts'
import { NS } from '../locales.ts'
import { fetchShareExport } from './fetch-share.ts'
import { ShareFetchError } from './fetch-share.ts'
import { stitchSliceBlobs, supportsPngStitch } from './png-stitch.ts'
import { rasterizeShareCard } from './rasterize.ts'
import { ShareCard } from './share-card.tsx'
import type { ShareCardCopy, ShareTurn } from './share-card.tsx'
import { downloadBlobSequence, shareSliceFileName } from './share-flow.ts'

/** Full props: shell.overlay (root scope) gives the standard `useSessions`. */
export type SharePreviewProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>

/* ---- fixture ---------------------------------------------------------------
 * Exercises every block kind the template knows, and since ticket 09 every
 * Markdown construct the assistant path renders: headings, inline emphasis /
 * code / links / escapes, fenced code with a language tag and a deliberately
 * over-long line (wide-content acceptance), an aligned pipe table, block
 * quote, ordered + nested unordered lists, thematic break, indented code, a
 * Markdown image line, and image placeholders. Fixed timestamp so the header
 * is deterministic between reloads. */

const FIXTURE_CREATED_AT = Date.UTC(2026, 8, 10, 4, 0) // 2026-09-10 12:00 +08:00

const FIXTURE_TITLE = '示例会话 · 网关错误率报表'

const FIXTURE_TURNS: ShareTurn[] = [
  {
    role: 'user',
    seq: 1,
    blocks: [{ kind: 'text', text: '帮我把这份原始日志清洗成表格，算出每个服务的错误率，再给一个可以复用的脚本。' }],
  },
  {
    role: 'assistant',
    seq: 2,
    blocks: [
      {
        kind: 'text',
        text: [
          '清洗结果如下（错误率 = 错误 / 请求），口径见 [统计说明](#stats)：',
          '',
          '## 服务错误率',
          '',
          '| 服务 | 请求 | 错误 | 错误率 | 备注 |',
          '| :--- | ---: | ---: | :---: | --- |',
          '| lan-gate | 12040 | 36 | 0.30% | 配对墙拦截计入 |',
          '| api-gateway | 98213 | 121 | 0.12% | 5xx 全量 |',
          '| web-ui-static | 330912 | 2 | 0.00% | CDN 回源 |',
          '',
          '复用脚本（长行不裁剪，超出卡片宽是预期行为，切片宽度自适应交给栅格化）：',
          '',
          '```python',
          'def error_rate(total_requests: int, errors: int) -> float:',
          '    return errors / total_requests if total_requests else 0.0',
          'print(f"{error_rate(98213, 121):.2%}")  # -> 0.12%',
          '```',
          '',
          '### 排版要点',
          '',
          '行内支持 **粗体**、*斜体*、***粗斜体***、~~删除线~~、`行内代码`、[链接着色](https://example.com/docs) 与转义 \\*字面星号\\*。',
          '',
          '无序清单（两级缩进）：',
          '',
          '- 只取近 24 小时的聚合数据',
          '  - 请求量不足 1000 的服务不参与排名',
          '  - 按错误率降序输出',
          '- 长行项目照常参与宽度测量',
          '',
          '有序步骤：',
          '',
          '1. 拉取聚合指标',
          '2. 计算错误率',
          '   1. 过滤零流量服务',
          '   2. 保留两位小数',
          '3. 输出报表',
          '',
          '> 引用块：以上口径与 [监控面板](https://example.com/monitor) 一致，',
          '> 以 5 分钟粒度聚合，空窗期按 0 处理。',
          '',
          '---',
          '',
          '另外附一个历史口径的配置片段（缩进代码）：',
          '',
          '    window_seconds = 86400',
          '    min_requests = 1000',
          '',
          '架构示意图：',
          '',
          '![部署架构图](https://example.com/arch.png)',
        ].join('\n'),
      },
    ],
  },
  {
    role: 'user',
    seq: 3,
    blocks: [
      { kind: 'text', text: '很好。再把现在的部署架构画一张图给我。' },
      { kind: 'image' },
    ],
  },
  {
    role: 'assistant',
    seq: 4,
    blocks: [
      { kind: 'text', text: '架构图放在这里了（分享图 v1 中图片附件以占位呈现）：' },
      { kind: 'image' },
      { kind: 'text', text: '需要我把表格导出成 CSV 的话说一声。' },
    ],
  },
]

/** What the card currently shows. */
interface PreviewState {
  source: 'fixture' | 'live'
  turns: ShareTurn[]
  createdAt: number | undefined
  /** Why a live fetch fell back to the fixture (debug affordance). */
  error: string | null
}

const FIXTURE_STATE: PreviewState = {
  source: 'fixture',
  turns: FIXTURE_TURNS,
  createdAt: FIXTURE_CREATED_AT,
  error: null,
}

/**
 * Share-card preview panel. Fixed at the top of the overlay layer, scrollable
 * (long transcripts must be inspectable), all-inline-styled like the card —
 * this feature adds no page CSS by design (PLAN §9.4).
 */
export function SharePreview({ useSessions, t }: SharePreviewProps) {
  const [gone, setGone] = useState(false)
  const [state, setState] = useState<PreviewState>(FIXTURE_STATE)
  const [exportBusy, setExportBusy] = useState<string | null>(null)
  const [exportNote, setExportNote] = useState<string | null>(null)
  const cardHostRef = useRef<HTMLDivElement>(null)

  const currentId = useSessions((s) => s.current)
  const row = useSessions((s) => (s.current === undefined ? undefined : s.byId[s.current]))

  // Try the real route whenever a session is open; any failure (route not
  // mounted on this host, network, bad body) silently reverts to the fixture
  // — the preview must always render something. The fetch itself is the
  // production one (fetch-share.ts), so this exercises the exact query and
  // validation the real share flow sends.
  useEffect(() => {
    if (currentId === undefined) {
      setState(FIXTURE_STATE)
      return
    }
    let cancelled = false
    fetchShareExport(currentId, { kind: 'all' })
      .then((data) => {
        if (cancelled) return
        setState({ source: 'live', turns: data.turns, createdAt: data.createdAt, error: null })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // Debug affordance: the typed code (+HTTP status) says WHICH path
        // failed; the real UI maps these codes to locale copy instead.
        const detail = err instanceof ShareFetchError
          ? `${err.code}${err.status === undefined ? '' : ` (HTTP ${err.status})`}`
          : err instanceof Error ? err.message : String(err)
        setState({ ...FIXTURE_STATE, error: detail })
      })
    return () => {
      cancelled = true
    }
  }, [currentId])

  if (gone) return null

  // Full pipeline on the live card element: probe → measure → plan (unified
  // when the browser can stitch) → paint → stitch, then a single long-image
  // download (ticket 07 — the caption notes the final dimensions); browsers
  // without CompressionStream keep the per-slice downloads.
  const runExport = async (): Promise<void> => {
    const card = cardHostRef.current?.querySelector<HTMLElement>('[data-share-card]') ?? null
    if (card === null) {
      setExportNote('导出失败：未找到分享卡元素')
      return
    }
    setExportBusy('0/?')
    setExportNote(null)
    try {
      const stitch = supportsPngStitch()
      const result = await rasterizeShareCard(card, {
        pixelRatioCap: Math.min(window.devicePixelRatio || 1, 2),
        truncatedNote: (droppedTurns) => t('shareTruncatedNote', { count: droppedTurns }),
        onProgress: (done, total) => setExportBusy(`${done}/${total}`),
        unified: stitch,
      })
      const tail = result.truncated ? `，已省略前 ${result.droppedTurns} 轮` : ''
      if (stitch && result.stitchWidth !== undefined) {
        const png = await stitchSliceBlobs(result.slices, result.stitchWidth)
        const height = result.slices.reduce((sum, slice) => sum + slice.height, 0)
        await downloadBlobSequence([{ blob: png, name: 'share-card.png' }])
        setExportNote(`已导出长图 ${result.stitchWidth}×${height}（${result.slices.length} 片拼接，像素比 ${result.pixelRatio}${tail}）`)
      } else {
        // The same paced anchor-download sequence the real delivery falls
        // back to (review 07+08 cleanup — this was a third inline copy).
        await downloadBlobSequence(
          result.slices.map((slice, index) => ({ blob: slice.blob, name: shareSliceFileName('share-card', index) })),
        )
        setExportNote(`已导出 ${result.slices.length} 张分片（浏览器不支持拼接，像素比 ${result.pixelRatio}${tail}）`)
      }
      console.info('[share-preview] rasterized', result)
    } catch (err) {
      console.error('[share-preview] PNG export failed', err)
      setExportNote(`导出失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setExportBusy(null)
    }
  }

  const copy: ShareCardCopy = {
    turnsLabel: (count: number) => t('shareCardTurns', { count }),
    generatedBy: t('shareCardGeneratedBy'),
    image: t('shareCardImage'),
  }
  const preset = agentPresetOf(row)

  return (
    <div style={PANEL_STYLE}>
      <div style={CAPTION_STYLE}>
        <span>
          分享卡预览（?mobile-nav-share-preview=1） · {state.source === 'live' ? '会话数据' : 'fixture 数据'}
          {state.error !== null ? ` · 拉取失败：${state.error}` : ''}
        </span>
        <button
          type="button"
          style={EXPORT_STYLE}
          disabled={exportBusy !== null}
          onClick={() => { void runExport() }}
        >
          {exportBusy !== null ? `导出中 ${exportBusy}` : '导出 PNG'}
        </button>
        {exportNote !== null
          ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{exportNote}</span>
          : null}
        <button type="button" style={CLOSE_STYLE} onClick={() => setGone(true)}>
          ✕
        </button>
      </div>
      <div ref={cardHostRef} style={{ padding: '16px', display: 'flex', justifyContent: 'center', minHeight: '120px' }}>
        <ShareCard
          title={state.source === 'live' ? (row?.displayTitle ?? FIXTURE_TITLE) : FIXTURE_TITLE}
          {...(preset !== undefined ? { subtitle: preset } : {})}
          {...(state.createdAt !== undefined ? { createdAt: state.createdAt } : {})}
          turns={state.turns}
          copy={copy}
        />
      </div>
    </div>
  )
}

/* Debug chrome styles (inline like everything else in this feature). */

const PANEL_STYLE: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  maxHeight: '100%',
  overflow: 'auto',
  zIndex: 30,
  // The shell overlay layer is pointer-events:none with pointer-events:auto
  // restored on children; explicit keeps this panel usable regardless.
  pointerEvents: 'auto',
  background: 'rgba(20, 22, 26, 0.08)',
}

const CAPTION_STYLE: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '6px 12px',
  background: 'rgba(15, 17, 21, 0.82)',
  color: '#fff',
  font: '12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
}

const CLOSE_STYLE: CSSProperties = {
  marginLeft: '8px',
  border: 'none',
  borderRadius: '6px',
  background: 'rgba(255, 255, 255, 0.14)',
  color: '#fff',
  font: 'inherit',
  lineHeight: 1,
  padding: '4px 8px',
  cursor: 'pointer',
}

const EXPORT_STYLE: CSSProperties = {
  marginLeft: 'auto',
  border: 'none',
  borderRadius: '6px',
  background: 'rgba(255, 255, 255, 0.22)',
  color: '#fff',
  font: 'inherit',
  lineHeight: 1,
  padding: '4px 8px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
