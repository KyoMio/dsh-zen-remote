/**
 * Share-card pure template (ticket 03, PLAN §5.1): renders the share-export
 * transcript JSON as one self-styled card — header strip, user bubbles,
 * assistant prose, brand footer.
 *
 * Hard rule for this file: EVERY element carries only an inline `style`, no
 * `className`, no style-module imports. The ticket-04 rasterizer deep-clones
 * this tree into an SVG `<foreignObject>` and paints it as an image — an
 * image loads no stylesheets, so the card must be fully self-describing. The
 * same rule is why wide content (long code lines, pipe tables) renders at
 * natural width with `overflow` left visible: hiding or clipping it here
 * would silently drop it from the exported PNG (adaptive slice width is
 * ticket 04's job; this template just must never lie about content width).
 */
import type { CSSProperties, ReactNode } from 'react'
import { segmentShareText } from './text-layout.ts'
import type { ShareTextSegment } from './text-layout.ts'
import { parseMarkdown } from './markdown.ts'
import type { MdAlign, MdBlock, MdListItem, MdSpan } from './markdown.ts'
import { BASE_CARD_WIDTH, USER_BUBBLE_MAX_RATIO, USER_BUBBLE_PAD_X } from './share-constants.ts'

/* ---- wire types ----------------------------------------------------------
 * Local mirror of the GET /_dsh/mobile-nav/share-export response contract
 * (src/share-export.ts). NOT imported from there: that module transitively
 * requires node-only code, and the client bundle may only require the four
 * host-seeded externals (scripts/check-client-externals.mjs). The JSON shape
 * is the contract; the two definitions drift together only through the
 * integration test on the host side. */

/** One exportable content block of a transcript row. */
export type ShareBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image' }

/** One transcript row; `seq` (log position) doubles as the React key. */
export interface ShareTurn {
  role: 'user' | 'assistant'
  seq: number
  blocks: ShareBlock[]
}

/* ---- theme ----------------------------------------------------------------
 * The host theme (dsh-client-ui-theme) defines --dsw-alias-* on <body> (light)
 * and <body[data-ds-dark-theme]> (dark) — NOT on :root — so the probe below
 * reads body first; documentElement is only a fallback for other hosts.
 * Values are resolved to concrete colors by getComputedStyle (custom-property
 * computed values substitute var() references), then written into the inline
 * styles, which makes the exported card follow the live light/dark theme.
 * Defaults are the host light palette (resolved from dsh-client-ui-theme
 * 0.1.5-rc.2) so the card still renders sanely where the variables are
 * unreadable. */

/** Concrete colors/fonts the template bakes into its inline styles. */
export interface ShareTheme {
  /** Primary prose color (--dsw-alias-label-primary). */
  text: string
  /** Header meta / secondary text (--dsw-alias-label-secondary). */
  textSecondary: string
  /** Footer / caption text (--dsw-alias-label-tertiary). */
  textTertiary: string
  /** Card background (--dsw-alias-bg-base). */
  cardBg: string
  /** Code/table block background (--dsw-alias-markdown-code-block). */
  codeBg: string
  /** User-bubble fill (--dsw-alias-brand-primary). */
  bubbleBg: string
  /** User-bubble text (--dsw-alias-label-primary-foreground). */
  bubbleText: string
  /** Brand accent (--dsw-alias-state-business-primary, DeepSeek blue). */
  accent: string
  /** Hairline color (--dsw-alias-border-l2). */
  border: string
  /** Sans font stack (--dsw-font-family). */
  fontFamily: string
  /** Mono font stack (--ds-font-family-code). */
  monoFamily: string
}

/** Light-palette fallback (resolved values from the host theme package). */
export const DEFAULT_SHARE_THEME: ShareTheme = {
  text: '#0f1115',
  textSecondary: '#61666b',
  textTertiary: '#81858c',
  cardBg: '#ffffff',
  codeBg: '#f9fafb',
  bubbleBg: '#0f1115',
  bubbleText: '#ffffff',
  accent: '#4176e6',
  border: 'rgba(0, 0, 0, 0.1)',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  monoFamily: '"SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, Courier, monospace',
}

/**
 * Read the host theme once (per render call). A raw value that still contains
 * `var(` means the engine returned it un-substituted — treated as missing so
 * the default palette wins over a broken declaration.
 * @returns concrete theme values for this render.
 */
export function readShareTheme(): ShareTheme {
  const fallback = DEFAULT_SHARE_THEME
  if (typeof document === 'undefined') return fallback
  // body first (see file header), then documentElement as a generic fallback.
  const sources = [getComputedStyle(document.body), getComputedStyle(document.documentElement)]
  const read = (name: string): string | undefined => {
    for (const computed of sources) {
      const raw = computed.getPropertyValue(name).trim()
      if (raw !== '' && !raw.includes('var(')) return raw
    }
    return undefined
  }
  return {
    text: read('--dsw-alias-label-primary') ?? fallback.text,
    textSecondary: read('--dsw-alias-label-secondary') ?? fallback.textSecondary,
    textTertiary: read('--dsw-alias-label-tertiary') ?? fallback.textTertiary,
    cardBg: read('--dsw-alias-bg-base') ?? fallback.cardBg,
    codeBg: read('--dsw-alias-markdown-code-block') ?? fallback.codeBg,
    bubbleBg: read('--dsw-alias-brand-primary') ?? fallback.bubbleBg,
    bubbleText: read('--dsw-alias-label-primary-foreground') ?? fallback.bubbleText,
    accent: read('--dsw-alias-state-business-primary') ?? fallback.accent,
    border: read('--dsw-alias-border-l2') ?? fallback.border,
    fontFamily: read('--dsw-font-family') ?? fallback.fontFamily,
    monoFamily: read('--ds-font-family-code') ?? fallback.monoFamily,
  }
}

/** Localizable strings baked into the shared image (via locales `t`). */
export interface ShareCardCopy {
  /** Header turn count, e.g. "3 轮对话". */
  turnsLabel: (count: number) => string
  /** Footer attribution, e.g. "由 DeepSeek Harness 生成". */
  generatedBy: string
  /** Image-attachment placeholder caption. */
  image: string
}

/** ShareCard props. All style decisions are internal; data in, pixels out. */
export interface ShareCardProps {
  /** Session display title (header strip). */
  title: string
  /** Optional second header line (agent preset / model). */
  subtitle?: string
  /** Session creation time (epoch ms); omitted from the header when missing. */
  createdAt?: number
  /** Transcript rows in conversation order. */
  turns: readonly ShareTurn[]
  /** Logical width in px (default 390; ticket 04 passes wider for wide slices). */
  width?: number
  /** Localized strings, see {@link ShareCardCopy}. */
  copy: ShareCardCopy
}

/**
 * The bubble-width cap as the CSS percentage string the template renders —
 * `Math.round` guards the float multiply (0.82 × 100), and the value comes
 * from share-constants.ts so the rasterizer's width formulas invert exactly
 * this number (see USER_BUBBLE_MAX_RATIO).
 */
const USER_BUBBLE_MAX_WIDTH = `${Math.round(USER_BUBBLE_MAX_RATIO * 100)}%`

/** Locale-following short date+time; the share image is dated content. */
function formatStamp(ms: number): string {
  const date = new Date(ms)
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ')
  }
}

/**
 * The share card. A pure template: no hooks, no effects, no context — the
 * same JSX must render identically inside the page (preview) and inside a
 * cloned `<foreignObject>` (rasterize).
 */
export function ShareCard({ title, subtitle, createdAt, turns, width, copy }: ShareCardProps): ReactNode {
  const theme = readShareTheme()
  const logicalWidth = width ?? BASE_CARD_WIDTH
  // "N 轮" counts user anchors (one exchange = user prompt + its answers),
  // matching how the host route counts turns for range=last.
  const turnCount = turns.filter((turn) => turn.role === 'user').length
  const stamp = createdAt !== undefined && Number.isFinite(createdAt) ? formatStamp(createdAt) : undefined
  const metaParts = [
    ...(subtitle !== undefined && subtitle !== '' ? [subtitle] : []),
    ...(stamp !== undefined ? [stamp] : []),
    copy.turnsLabel(turnCount),
  ]

  return (
    <div
      data-share-card=""
      style={{
        width: `${logicalWidth}px`,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '20px 18px 16px',
        background: theme.cardBg,
        color: theme.text,
        fontFamily: theme.fontFamily,
        fontSize: '15px',
        lineHeight: 1.65,
        // Pin the INHERITABLE typography so the page render (the preview and
        // the rasterizer's measuring clones live in a shadow root, which still
        // inherits these from the host cascade) and the SVG-image render (a
        // fresh context at engine defaults) lay out identically — any unpinned
        // property is a channel for host-style drift to change text wrapping
        // between measurement and raster, invalidating the rasterizer's
        // numbers. Every value below is the CSS initial value.
        letterSpacing: 'normal',
        wordBreak: 'normal',
        overflowWrap: 'normal',
        hyphens: 'manual',
        textAlign: 'start',
        textTransform: 'none',
        tabSize: 8,
        fontVariantLigatures: 'normal',
        // Never hide horizontal content: wide code/tables must stay visible
        // (and measurable by ticket 04) — see the file header.
        overflow: 'visible',
      }}
    >
      <div data-share-header="" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ fontSize: '17px', fontWeight: 600, lineHeight: 1.4 }}>{title}</div>
        <div style={{ fontSize: '12px', lineHeight: 1.5, color: theme.textSecondary }}>
          {metaParts.join(' · ')}
        </div>
        <div style={{ height: '1px', marginTop: '6px', background: theme.border }} />
      </div>

      {turns.map((turn) =>
        turn.role === 'user'
          ? (
            <div key={turn.seq} data-share-turn={turn.seq} data-share-role={turn.role} style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <div
                style={{
                  maxWidth: USER_BUBBLE_MAX_WIDTH,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  padding: `9px ${USER_BUBBLE_PAD_X}px`,
                  background: theme.bubbleBg,
                  color: theme.bubbleText,
                  borderRadius: '16px',
                  // Sharp corner on the trailing edge = the chat-bubble tail.
                  borderBottomRightRadius: '4px',
                  overflow: 'visible',
                }}
              >
                <ShareBlocks blocks={turn.blocks} role={turn.role} theme={theme} copy={copy} />
              </div>
            </div>
          )
          : (
            <div
              key={turn.seq}
              data-share-turn={turn.seq}
              data-share-role={turn.role}
              style={{ display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'visible' }}
            >
              <ShareBlocks blocks={turn.blocks} role={turn.role} theme={theme} copy={copy} />
            </div>
          ),
      )}

      <div data-share-footer="" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ height: '1px', background: theme.border }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', lineHeight: 1.4, color: theme.textTertiary }}>
          {/* Brand accent tick keeps the footer recognizable without splitting
              the localized attribution string into styled fragments. */}
          <span style={{ width: '3px', height: '12px', borderRadius: '2px', background: theme.accent }} />
          <span>
            {copy.generatedBy}
            {stamp !== undefined ? ` · ${stamp}` : ''}
          </span>
        </div>
      </div>
    </div>
  )
}

/** Render one row's blocks in order (text flows, images become badges). */
function ShareBlocks({ blocks, role, theme, copy }: { blocks: readonly ShareBlock[]; role: 'user' | 'assistant'; theme: ShareTheme; copy: ShareCardCopy }): ReactNode {
  return (
    <>
      {blocks.map((block, index) =>
        block.kind === 'text'
          ? (
            role === 'assistant'
              // Assistant prose is Markdown (ticket 09); user messages stay
              // plain text — the Chat view renders them the same way.
              ? <ShareMarkdown key={index} text={block.text} theme={theme} copy={copy} />
              : <ShareText key={index} text={block.text} theme={theme} />
          )
          : <ImageBadge key={index} theme={theme} label={copy.image} />,
      )}
    </>
  )
}

/** User-message typesetting: the plain-text fold of ticket 03, unchanged. */
function ShareText({ text, theme }: { text: string; theme: ShareTheme }): ReactNode {
  const segments = segmentShareText(text)
  if (segments.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'visible' }}>
      {segments.map((segment, index) => (
        <ShareSegment key={index} segment={segment} theme={theme} />
      ))}
    </div>
  )
}

function ShareSegment({ segment, theme }: { segment: ShareTextSegment; theme: ShareTheme }): ReactNode {
  switch (segment.kind) {
    case 'code':
    case 'table':
      // Monospace + `pre` (NOT pre-wrap): the line's natural width wins, the
      // block may visually overflow the card edge, and ticket 04 measures
      // that width to widen the slice — wrapping here would destroy the only
      // signal the width probe has.
      return (
        <div
          style={{
            fontFamily: theme.monoFamily,
            fontSize: '12.5px',
            lineHeight: 1.6,
            whiteSpace: 'pre',
            background: theme.codeBg,
            borderRadius: '8px',
            padding: '10px 12px',
            overflow: 'visible',
          }}
        >
          {segment.lines.join('\n')}
        </div>
      )
    case 'list':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {segment.items.map((item, index) => (
            <div key={index} style={{ display: 'flex', gap: '8px' }}>
              <span style={{ flexShrink: 0, color: theme.textTertiary }}>{item.marker}</span>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', overflow: 'visible' }}>{item.text}</span>
            </div>
          ))}
        </div>
      )
    case 'para':
    default:
      return (
        <div style={{ whiteSpace: 'pre-wrap', overflow: 'visible' }}>
          {segment.text}
        </div>
      )
  }
}

/* ---- markdown rendering (ticket 09, PLAN §5.1 v1.2) -------------------------
 * Assistant text renders through the pure parser in markdown.ts. Same red
 * lines as the rest of the card: inline styles only (an SVG-as-image render
 * loads no stylesheets), and NEVER hide horizontal content — code lines and
 * table cells keep their natural width so the rasterizer's width probe can
 * lift the slice (inline emphasis wraps instead, which changes nothing). */

/** Assistant text block → parsed blocks → self-styled Markdown rendering. */
function ShareMarkdown({ text, theme, copy }: { text: string; theme: ShareTheme; copy: ShareCardCopy }): ReactNode {
  const blocks = parseMarkdown(text)
  if (blocks.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'visible' }}>
      {blocks.map((block, index) => (
        <MdBlockView key={index} block={block} theme={theme} copy={copy} />
      ))}
    </div>
  )
}

/** Heading ladder over the card's 15px body; h6 demotes to the secondary tone. */
function mdHeadingStyle(level: number, theme: ShareTheme): CSSProperties {
  switch (level) {
    case 1: return { fontSize: '20px', fontWeight: 700, lineHeight: 1.4 }
    case 2: return { fontSize: '18px', fontWeight: 700, lineHeight: 1.4 }
    case 3: return { fontSize: '16.5px', fontWeight: 600, lineHeight: 1.45 }
    case 4: return { fontSize: '15.5px', fontWeight: 600, lineHeight: 1.5 }
    case 5: return { fontSize: '15px', fontWeight: 600, lineHeight: 1.5 }
    default: return { fontSize: '15px', fontWeight: 600, lineHeight: 1.5, color: theme.textSecondary }
  }
}

/** One markdown block. Every branch keeps `overflow: 'visible'` (file header). */
function MdBlockView({ block, theme, copy }: { block: MdBlock; theme: ShareTheme; copy: ShareCardCopy }): ReactNode {
  switch (block.kind) {
    case 'heading':
      return (
        <div style={{ ...mdHeadingStyle(block.level, theme), overflow: 'visible' }}>
          <MdSpans spans={block.spans} theme={theme} />
        </div>
      )
    case 'para':
      return (
        <div style={{ whiteSpace: 'pre-wrap', overflow: 'visible' }}>
          <MdSpans spans={block.spans} theme={theme} />
        </div>
      )
    case 'code':
      return (
        <div
          style={{
            background: theme.codeBg,
            borderRadius: '8px',
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            overflow: 'visible',
          }}
        >
          {block.lang !== undefined ? (
            <div style={{ fontSize: '11px', lineHeight: 1.4, color: theme.textTertiary }}>{block.lang}</div>
          ) : null}
          {/* Natural width by design: the rasterizer measures this box to lift
              the slice — wrapping here would destroy its only width signal. */}
          <div
            style={{
              fontFamily: theme.monoFamily,
              fontSize: '12.5px',
              lineHeight: 1.6,
              whiteSpace: 'pre',
              overflow: 'visible',
            }}
          >
            {block.lines.join('\n')}
          </div>
        </div>
      )
    case 'quote':
      return (
        <div
          style={{
            borderLeft: `3px solid ${theme.border}`,
            paddingLeft: '12px',
            paddingRight: '2px',
            color: theme.textSecondary,
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            overflow: 'visible',
          }}
        >
          {block.children.map((child, index) => (
            <MdBlockView key={index} block={child} theme={theme} copy={copy} />
          ))}
        </div>
      )
    case 'list':
      return <MdListView items={block.items} depth={0} theme={theme} />
    case 'table':
      return <MdTableView block={block} theme={theme} />
    case 'hr':
      return <div style={{ height: '1px', background: theme.border, overflow: 'visible' }} />
    case 'image':
      // Markdown image: same placeholder row an image block renders (the
      // picture lives on the far end of a URL the share image cannot fetch).
      return <ImageBadge theme={theme} label={copy.image} />
  }
}

/** List rows; one nesting indent under the parent item's content column. */
function MdListView({ items, depth, theme }: { items: readonly MdListItem[]; depth: number; theme: ShareTheme }): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', ...(depth > 0 ? { marginLeft: '18px' } : null) }}>
      {items.map((item, index) => {
        const ordered = item.number !== undefined
        return (
          <div key={index} style={{ display: 'flex', gap: '8px' }}>
            <span
              style={{
                flexShrink: 0,
                color: theme.textTertiary,
                // A fixed marker column keeps 1.–9. dots right-aligned.
                minWidth: ordered ? '20px' : undefined,
                textAlign: ordered ? 'right' : undefined,
              }}
            >
              {ordered ? `${item.number}.` : '•'}
            </span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ whiteSpace: 'pre-wrap', overflow: 'visible' }}>
                <MdSpans spans={item.spans} theme={theme} />
              </div>
              {item.children.length > 0 ? <MdListView items={item.children} depth={depth + 1} theme={theme} /> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Column alignment → CSS text-align ('start' keeps the card's direction). */
function mdAlignText(align: MdAlign): 'start' | 'center' | 'right' {
  if (align === 'center') return 'center'
  if (align === 'right') return 'right'
  return 'start'
}

/** GFM table as a natural-width grid: nowrap cells, hairline borders. */
function MdTableView({ block, theme }: { block: Extract<MdBlock, { kind: 'table' }>; theme: ShareTheme }): ReactNode {
  const cellBase: CSSProperties = { padding: '6px 10px', border: `1px solid ${theme.border}` }
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: '13px', lineHeight: 1.5, overflow: 'visible' }}>
      <thead>
        <tr>
          {block.header.map((cell, index) => (
            <th
              key={index}
              style={{
                ...cellBase,
                background: theme.codeBg,
                fontWeight: 600,
                textAlign: mdAlignText(block.align[index] ?? null),
                whiteSpace: 'nowrap',
                overflow: 'visible',
              }}
            >
              <MdSpans spans={cell} theme={theme} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {block.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, colIndex) => (
              <td
                key={colIndex}
                style={{
                  ...cellBase,
                  textAlign: mdAlignText(block.align[colIndex] ?? null),
                  // Natural width, same rationale as code lines above.
                  whiteSpace: 'nowrap',
                  overflow: 'visible',
                }}
              >
                <MdSpans spans={cell} theme={theme} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Render an inline span sequence (raw strings for plain text). */
function MdSpans({ spans, theme }: { spans: readonly MdSpan[]; theme: ShareTheme }): ReactNode {
  if (spans.length === 0) return null
  return (
    <>
      {spans.map((span, index) => (
        <MdSpanView key={index} span={span} theme={theme} />
      ))}
    </>
  )
}

/**
 * One inline span. Plain <span>s with explicit styles, never semantic tags:
 * the SVG-image render applies its own UA cascade, and only explicit values
 * lay out identically to the measured page render.
 */
function MdSpanView({ span, theme }: { span: MdSpan; theme: ShareTheme }): ReactNode {
  switch (span.kind) {
    case 'text':
      return span.text
    case 'bold':
      return <span style={{ fontWeight: 700 }}><MdSpans spans={span.spans} theme={theme} /></span>
    case 'italic':
      return <span style={{ fontStyle: 'italic' }}><MdSpans spans={span.spans} theme={theme} /></span>
    case 'strike':
      return <span style={{ textDecoration: 'line-through' }}><MdSpans spans={span.spans} theme={theme} /></span>
    case 'code':
      return (
        <span
          style={{
            fontFamily: theme.monoFamily,
            fontSize: '0.92em',
            background: theme.codeBg,
            borderRadius: '4px',
            padding: '1px 5px',
          }}
        >
          {span.text}
        </span>
      )
    case 'link':
      // Colored text only: the share image is not clickable, and the URL is
      // deliberately NOT repeated next to the label.
      return <span style={{ color: theme.accent }}><MdSpans spans={span.spans} theme={theme} /></span>
  }
}

/** Image attachments stay placeholders in v1 (files live on the host disk). */
function ImageBadge({ theme, label }: { theme: ShareTheme; label: string }): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '8px 12px',
        border: `1px dashed ${theme.border}`,
        borderRadius: '8px',
        fontSize: '12px',
        color: theme.textTertiary,
        overflow: 'visible',
      }}
    >
      {/* Inline SVG glyph (presentational attributes, no stylesheet) — the
          share image cannot load icon fonts or external images. */}
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style={{ flexShrink: 0 }}>
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="5.5" cy="6.5" r="1.3" fill="currentColor" />
        <path d="M2.5 12 L6.5 8 L9 10.5 L11.5 8 L13.5 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <span>{label}</span>
    </div>
  )
}
