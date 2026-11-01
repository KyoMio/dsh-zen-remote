/**
 * CU-2: the debug report's redactor (SPEC 方案 C). Pure functions — no DSH
 * imports, no I/O — that turn free text and addresses into shapes an issue
 * report can carry: absolute paths lose everything but their leaf, home
 * paths fold to `~`, virtual session ids keep only the server id and the
 * first 8 characters of the session id, long secret-shaped runs become
 * `<token>`, and URL hostnames degrade to their address class. The report
 * assembler (debug-report.ts) runs every string it emits through
 * {@link redactText}; the check script pins the truth table, including the
 * "an injected path/hostname/token can never be recovered from the output"
 * assertion.
 *
 * The passes are ordered so they cannot un-do each other: URLs are lifted
 * out first (pass 0, a sentinel in their place) and restored last in
 * degraded form, so no text-wide pass can merge a URL's port and path into
 * a token run; then virtual ids (a ≥32-char id would otherwise die as a
 * token run), the home fold BEFORE the token pass (a long home path is
 * itself a ≥32 run), the token pass, and the path passes (UNC, drive
 * letter, Unix). Path leaves never contain whitespace, and Unix paths must
 * start at a boundary (string start, whitespace, `(`, `~`) so relative
 * paths and `a/b`-style words stay untouched.
 *
 * Deliberately ZERO relative imports: the check script imports this file
 * straight off src/ under Node's strip-only type stripping (the same seam
 * scripts/check-remote-drop.mjs uses for client-data/remote-drop.ts), and a
 * `.js` specifier cannot resolve there. The address-class predicate below
 * therefore restates the pairing normalizer's private-network ranges; the
 * two are pinned against each other by a lib-level test in
 * test/client-routes.test.cjs so they cannot drift apart silently.
 */
/** The address classes {@link serverUrlShape} reports. Deliberately coarse:
 * enough to triage "can the two machines even see each other", never the
 * hostname itself. */
export type ServerUrlClass = 'loopback' | 'lan-ip' | 'public-ip' | 'domain'

/** One pass's replacement result for a matched run of the token pass. */
const TOKEN_PLACEHOLDER = '<token>'

/** The private-network address ranges the pairing normalizer admits for
 * plain http (client-pairing.ts's `isPrivateNetworkHost`), restated here
 * because this module must import nothing (see the header). IPv4: `10/8`,
 * `172.16/12`, `192.168/16`, `100.64/10` (CGNAT/Tailscale); IPv6: `fc00::/7`
 * and `fe80::/10` by their first group. Loopback and `*.local` are decided
 * by the caller, not here. */
function isLanAddress(host: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4 !== null) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  const firstGroup = /^([0-9a-fA-F]{1,4}):/u.exec(host)
  if (firstGroup !== null) {
    const first = parseInt(firstGroup[1], 16)
    return (first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf)
  }
  return false
}

/** Which class one hostname belongs to. Loopback first (it is also in the
 * private ranges — order matters), then the remaining private ranges as
 * `lan-ip`, then numeric literals as public addresses, everything else as
 * `domain` (the "cannot tell" bucket, per SPEC). IPv6 brackets are
 * stripped first — classification is bracket-free. */
function classifyHost(bracketed: string): ServerUrlClass {
  const host = bracketed.startsWith('[') && bracketed.endsWith(']') ? bracketed.slice(1, -1) : bracketed
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return 'loopback'
  if (host.endsWith('.local')) return 'domain'
  if (isLanAddress(host)) return 'lan-ip'
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return 'public-ip'
  if (host.includes(':')) return 'public-ip'
  return 'domain'
}

/**
 * One server address's SHAPE: `scheme://class[:port]` — never the hostname.
 * `http://192.168.1.10:3080` → `http://lan-ip:3080`; `https://myserver.example.com`
 * → `https://domain`; the scheme's default port is omitted. Unset input
 * answers `'unset'`, unparsable input `'invalid'`.
 */
export function serverUrlShape(url: unknown): string {
  if (typeof url !== 'string' || url.trim() === '') return 'unset'
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return 'invalid'
  }
  const scheme = parsed.protocol === 'https:' ? 'https' : parsed.protocol === 'http:' ? 'http' : parsed.protocol.replace(/:$/u, '')
  const port = parsed.port
  const defaultPort = (scheme === 'https' && port === '443') || (scheme === 'http' && port === '80')
  return `${scheme}://${classifyHost(parsed.hostname)}${port !== '' && !defaultPort ? `:${port}` : ''}`
}

/**
 * A bind address's shape for the config plate (`host`): the same address
 * classes as {@link serverUrlShape}, plus `wildcard` for the all-interfaces
 * binds (`0.0.0.0` / `::`) — the one bind fact triage actually needs. Unset
 * input answers `'unset'`. A raw address never reaches the report.
 */
export function bindHostShape(host: unknown): string {
  if (typeof host !== 'string' || host.trim() === '') return 'unset'
  const value = host.trim()
  if (value === '0.0.0.0' || value === '::' || value === '[::]') return 'wildcard'
  return classifyHost(value)
}

/** The token pass: any run of ≥32 base64/base64url-ish characters (hex
 * secrets, base64 keys, JWT segments — `-` and `_` included so a base64url
 * signature dies whole instead of leaving a half) — long enough that real
 * prose never trips it, short enough to catch every credential shape this
 * plugin handles. */
const TOKEN_RUN = /[A-Za-z0-9+/=_-]{32,}/gu

/** The same run, as a CONTAINS test for one URL query value / path segment
 * (non-global: `test` must not carry `lastIndex` between calls). */
const HAS_TOKEN_RUN = /[A-Za-z0-9+/=_-]{32,}/u

/** The same run without `/`, for one URL path segment at a time — a long
 * path is not a secret, a long SEGMENT is. */
const HAS_TOKEN_SEGMENT = /[A-Za-z0-9+=_-]{32,}/u

/** Pass 0's URL candidates: a scheme this report can meet, then everything
 * up to whitespace, a quote or an angle bracket. Trailing sentence
 * punctuation is peeled back off afterwards ({@link URL_TRAILING}). */
const URL_CANDIDATE = /(?:https?|wss?|ftp):\/\/[^\s"'<>\u0000]+/gu

/** Sentence punctuation that ends a URL in prose (`see http://x/y).`) — `]`
 * is deliberately absent: it closes a bracketed IPv6 host. */
const URL_TRAILING = /[.,;:!?)}'"]+$/u

/** The in-text stand-in for one extracted URL. NUL never survives into the
 * text (pass 0 replaces any NUL the input carried), so a sentinel can only
 * be one this function placed; nothing in it trips a later pass (no `zr~`,
 * no slash, no 32-run, no drive-letter shape). */
const URL_SENTINEL = /\u0000zr-url:(\d+)\u0000/gu

/** One URL's path, redacted per segment: virtual ids truncate, and a segment
 * that carries a secret-shaped run dies whole. Ordinary routes
 * (`/_dsh/zen-remote/relay/v1/stream`) pass untouched. */
function redactUrlPath(path: string): string {
  return path
    .replace(VIRTUAL_ID, (_match: string, serverId: string, id: string) => `zr~${serverId}~${id.replace(/^session-/, '').slice(0, 8)}`)
    .split('/')
    .map((segment) => (HAS_TOKEN_SEGMENT.test(segment) ? TOKEN_PLACEHOLDER : segment))
    .join('/')
}

/** One URL's query + fragment (`?…` / `#…`), redacted per parameter: the key
 * is kept, a value carrying a secret-shaped run becomes `<token>` (a bare
 * parameter without `=` likewise). Virtual ids truncate first, so a
 * `sessionId=zr~…` value stays recognisable. This is the URL's only secret
 * pass — the URL was extracted before the text-wide token pass ran. */
function redactUrlQuery(tail: string): string {
  return tail.replace(/([?&#;])([^?&#;]*)/gu, (_match: string, separator: string, pair: string) => {
    const truncated = pair.replace(VIRTUAL_ID, (_m: string, serverId: string, id: string) => `zr~${serverId}~${id.replace(/^session-/, '').slice(0, 8)}`)
    const eq = truncated.indexOf('=')
    if (eq === -1) return `${separator}${HAS_TOKEN_RUN.test(truncated) ? TOKEN_PLACEHOLDER : truncated}`
    const value = truncated.slice(eq + 1)
    return `${separator}${truncated.slice(0, eq)}=${HAS_TOKEN_RUN.test(value) ? TOKEN_PLACEHOLDER : value}`
  })
}

/**
 * One extracted URL in its reportable form: userinfo dropped whole to
 * `<token>@`, host degraded to its address class, port and path KEPT (the
 * SPEC's "端口与 path 保留"), path segments and query values carrying a
 * secret-shaped run replaced by `<token>`.
 *
 * The userinfo boundary is the LAST `@` before the first `?`/`#` (RFC 3986:
 * the authority cannot run past them), so a password holding `/`
 * (`bob:ab/cd@host`) is still userinfo. The cost — a path that itself holds
 * `@` loses everything before it to `<token>@` — is over-redaction, the
 * safe direction.
 */
function degradeUrl(raw: string): string {
  const schemeEnd = raw.indexOf('://')
  const scheme = raw.slice(0, schemeEnd)
  const rest = raw.slice(schemeEnd + 3)
  const queryAt = rest.search(/[?#]/u)
  const head = queryAt === -1 ? rest : rest.slice(0, queryAt)
  const tail = queryAt === -1 ? '' : rest.slice(queryAt)
  const at = head.lastIndexOf('@')
  const afterUser = at === -1 ? head : head.slice(at + 1)
  const hostPort = /^(\[[^\]]*\]|[^/:]*)(:\d+)?/u.exec(afterUser)
  const host = hostPort?.[1] ?? ''
  const port = hostPort?.[2] ?? ''
  const path = afterUser.slice(hostPort?.[0].length ?? 0)
  return `${scheme}://${at === -1 ? '' : `${TOKEN_PLACEHOLDER}@`}${classifyHost(host)}${port}${redactUrlPath(path)}${redactUrlQuery(tail)}`
}

/** The UNC pass: `\\server\share\…\leaf` → `<路径:leaf>`. Server and share
 * are mandatory and never kept; inner segments may hold spaces
 * (`Shared Docs`), the leaf may not — so trailing prose stays outside. */
const UNC_PATH = /(?<![\w\\])\\\\[^\\/:*?"<>|\s]+\\[^\\/:*?"<>|\r\n]+(?:\\[^\\/:*?"<>|\r\n]+)*\\([^\\/:*?"<>|\s]+)/gu

/** A bare UNC root (`\\server\share`, no leaf beyond the share): nothing in
 * it is safe to keep. Runs after {@link UNC_PATH}. */
const UNC_ROOT = /(?<![\w\\])\\\\[^\\/:*?"<>|\s]+\\[^\\/:*?"<>|\s]+/gu

/** The virtual-id pass: `zr~<serverId>~<id>` keeps the server id and the
 * session id's first 8 characters (the debug report needs "same server?
 * same session?" — not the full id). */
const VIRTUAL_ID = /zr~([^~\s]{1,80})~([^~\s]{1,80})/gu

/** The Windows absolute-path pass: drive letter, colon, separator, then path
 * segments — reduced to `<路径:leaf>`. The drive letter must not follow a
 * word character (`https:/` is not a drive); inner segments may hold spaces
 * (`Program Files`), the leaf may not — so `D:\x\plan.txt failed` keeps
 * `failed` outside the placeholder. */
const WINDOWS_PATH = /(?<!\w)([A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*)([^\\/:*?"<>|\s]+)/gu

/** The Unix absolute-path pass, same reduction. The boundary lookbehind
 * (string start, whitespace, `(`, `~`, `>`) keeps relative paths, URL path
 * segments and `a/b` words out; `~` is excluded so a home-folded path
 * (`~/work/x.txt`) is never re-matched. */
const UNIX_PATH = /(?<![\w:/.\\~])(\/(?:[^/\s]+\/)*)([^/\s]+)/gu

/**
 * Redact one free-text value: home paths fold to `~` (their relative tail is
 * kept — that is the one shape the report intentionally preserves), absolute
 * paths reduce to `<路径:leaf>`, URL hostnames degrade to their address
 * class, virtual session ids truncate, secret-shaped runs become
 * `<token>`. Non-strings pass through unchanged.
 */
export function redactText(text: string, context: { home?: string }): string {
  if (typeof text !== 'string' || text === '') return text
  // 0. URLs out first, each replaced by a sentinel and restored LAST in
  // degraded form — so no text-wide pass can merge a URL's port and path
  // into one token run (the "ws://…:3080/_dsh/…" port loss), and the
  // userinfo/query handling lives in one place (degradeUrl). Any NUL the
  // input carried is neutralized first: a sentinel can only be ours.
  const urls: string[] = []
  let out = text.replaceAll('\u0000', '\uFFFD').replace(URL_CANDIDATE, (match: string) => {
    const trailing = URL_TRAILING.exec(match)?.[0] ?? ''
    urls.push(match.slice(0, match.length - trailing.length))
    return `\u0000zr-url:${urls.length - 1}\u0000${trailing}`
  })
  // 1. virtual ids: a ≥32-char id would otherwise die as a token run. The
  // id's `session-` label is stripped before the cut — the ids are all
  // `session-<uuid>`, so the head 8 of the label would carry nothing.
  out = out.replace(VIRTUAL_ID, (_match: string, serverId: string, id: string) => `zr~${serverId}~${id.replace(/^session-/, '').slice(0, 8)}`)
  // 2. the home directory folds to `~` BEFORE the token pass — a long home
  // path is itself a ≥32 run and would otherwise die whole, losing the
  // `~/Downloads/x.bin` shape the SPEC promises (folding only removes
  // information, so running it early is safe). Guarded: never fold the
  // filesystem root; a separator the fold leaves behind is normalized, so a
  // Windows home path reads `~/doc.txt` like its Unix counterpart.
  const home = context.home
  if (typeof home === 'string' && home.length > 1) {
    out = out.split(home).join('~').replaceAll('~\\', '~/')
  }
  // 3. secret-shaped runs.
  out = out.replace(TOKEN_RUN, () => TOKEN_PLACEHOLDER)
  // 4. UNC paths, then bare UNC roots — before the drive-letter pass.
  out = out.replace(UNC_PATH, (_match: string, leaf: string) => `<路径:${leaf}>`)
  out = out.replace(UNC_ROOT, () => '<路径>')
  // 5. Windows absolute paths → <路径:leaf>.
  out = out.replace(WINDOWS_PATH, (_match: string, _prefix: string, leaf: string) => `<路径:${leaf}>`)
  // 6. Unix absolute paths → <路径:leaf> (the leaf class already excludes
  // whitespace).
  out = out.replace(UNIX_PATH, (_match: string, _prefix: string, leaf: string) => `<路径:${leaf}>`)
  // 7. URLs back in, degraded: userinfo → `<token>@`, host → address class,
  // port and path kept, secret-shaped path segments / query values →
  // `<token>`.
  return out.replace(URL_SENTINEL, (_match: string, index: string) => degradeUrl(urls[Number(index)] ?? ''))
}

/**
 * Deep-redact one JSON-ready value: every string (at any depth) through
 * {@link redactText}; keys are kept as-is (plugin names, field names —
 * public identifiers), numbers/booleans/null pass through. Returns new
 * containers; the input is never mutated.
 */
export function redactValue(value: unknown, context: { home?: string }): unknown {
  if (typeof value === 'string') return redactText(value, context)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, context))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(item, context)
    }
    return out
  }
  return value
}
