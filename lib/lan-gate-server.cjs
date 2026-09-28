/* dsh-mobile-pwa · lib/lan-gate-server.cjs
 *
 * Public-facing gateway for DeepSeek Harness (DSH), designed to sit BEHIND a
 * TLS-terminating reverse proxy (nginx/Caddy) owned by the user.
 *
 * Trust model (v2, rework/public-auth-push):
 *   - Device identity = pairing credential, NOT source IP. Web devices carry
 *     the `lg_device` cookie; desktop-client devices (another machine's DSH
 *     desktop app, driven by its zen-remote plugin) send
 *     `Authorization: Bearer <token>` instead.
 *   - Roles: `web` devices browse everything as before; `desktop-client`
 *     devices may only touch the relay prefix /_dsh/zen-remote/relay/ (HTTP
 *     and WebSocket) — DSH's relay routes decide what they serve. Device
 *     requests are marked for upstream with x-zen-remote-* headers.
 *   - New devices see a pairing page; they redeem a short-lived one-time code
 *     generated from the dsh-zen-remote settings page in DSH's Plugins page.
 *     Failed attempts are rate-limited and locked out.
 *   - The ONLY IP-based trust left: a loopback socket carrying no
 *     X-Forwarded-* headers is the local user (admin + pairing-code
 *     generation + push trigger). Proxied requests always carry forwarded
 *     headers, so they can never look local.
 *   - X-Forwarded-For / X-Forwarded-Proto are honored only when the socket
 *     peer is loopback (same-host proxy) or listed in
 *     LAN_GATE_TRUSTED_PROXIES.
 *
 * PWA features (manifest, service worker, push) require the HTTPS the proxy
 * provides. Push is real Web Push: VAPID + aes128gcm via the `web-push` dep
 * (the one runtime dependency; everything else is Node stdlib).
 */

const os = require('node:os')
const crypto = require('node:crypto')
const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const webpush = require('web-push')

// Optional config file: <DSH_HOME>/lan-gate.config.json — same keys as the
// cordis config ({port, host, targetPort, rateLimit, trustedProxies,
// vapidSubject, lang, pushEvents, pushDebounceMs, pushSummary}). Explicit env wins.
function configFile() {
  try {
    var home = process.env.DSH_HOME || require('node:path').join(require('node:os').homedir(), '.dsh')
    var raw = JSON.parse(require('node:fs').readFileSync(require('node:path').join(home, 'lan-gate.config.json'), 'utf8'))
    return raw !== null && typeof raw === 'object' ? raw : {}
  } catch (e) { return {} }
}
const FILE_CONFIG = configFile()
function cfg(envName, fileKey, fallback) {
  if (process.env[envName] !== undefined) return process.env[envName]
  if (FILE_CONFIG[fileKey] !== undefined && FILE_CONFIG[fileKey] !== null) return String(FILE_CONFIG[fileKey])
  return fallback
}

var PROXY_PORT = Number(cfg('LAN_GATE_PORT', 'port', 3088))
const LISTEN_HOST = cfg('LAN_GATE_HOST', 'host', '127.0.0.1')
const RATE_LIMIT_PER_MIN = Number(cfg('LAN_GATE_RATE_LIMIT', 'rateLimit', 120))
const TARGET_HOST = '127.0.0.1'
const TARGET_PORT = Number(cfg('LAN_GATE_TARGET_PORT', 'targetPort', 3080))
// 0.1.2 browser auth: the host half hands us a one-use token URL via env.
// ABSENT env = 0.1.1 mode — every auth-exchange branch below short-circuits
// and proxying behaves exactly as before. Only the token value is kept (and
// never written to any response, log, or state file).
var UPSTREAM_TOKEN = null
;(function () {
  var url = process.env.LAN_GATE_UPSTREAM_TOKEN_URL
  if (!url) return
  try { UPSTREAM_TOKEN = new URL(url).searchParams.get('token') || null } catch (e) { UPSTREAM_TOKEN = null }
})()
const TRUSTED_PROXIES = String(cfg('LAN_GATE_TRUSTED_PROXIES', 'trustedProxies', '')).split(',').map(function (s) { return s.trim() }).filter(Boolean)
// UI language for the pages this file serves. "auto" (default) follows the
// requesting browser's Accept-Language, which is the only language signal a
// pairing visitor ever gives us; "zh"/"en" pin it. dsh-push.mjs reads the same
// `lang` key but cannot do "auto" — see its own note.
const LANG = String(cfg('LAN_GATE_LANG', 'lang', 'auto'))
function langOf(req) {
  if (LANG === 'zh' || LANG === 'en') return LANG
  var first = String((req && req.headers && req.headers['accept-language']) || '').split(',')[0].trim().toLowerCase()
  return !first || first.indexOf('zh') === 0 ? 'zh' : 'en'
}

const COOKIE_NAME = 'lg_device'
// The only paths a desktop-client device may request (HTTP + WS upgrade).
// Web devices and the local user are not gated on it — the relay routes
// inside DSH decide what they get served there.
const RELAY_PREFIX = '/_dsh/zen-remote/relay/'
// T22a: shared secret between the dsh-zen-remote host plugin and this gateway.
// The plugin mints a fresh one per apply and hands it over ONLY through
// LAN_GATE_RELAY_SECRET (lan-gate.mjs writes it, unconditionally overriding
// and otherwise deleting the variable — the value is never taken from user
// config). Non-empty: every device-authenticated forward carries
// x-zen-remote-secret so DSH's relay routes can tell gateway traffic from a
// local process forging the marking headers against 127.0.0.1. Empty: no
// header is ever added, and DSH's relay routes (which reject an empty secret
// on their side) refuse every relay request.
var RELAY_SECRET = String(process.env.LAN_GATE_RELAY_SECRET || '')
// The relay gate admits a path only when its RAW form and its URL-normalized
// form are byte-identical: DSH routes on new URL(req.url).pathname, which
// resolves `..`, %-encoded dots and backslashes as "up one level", so a
// prefix check on the raw string alone would let /_dsh/zen-remote/relay/../../
// reach non-relay API routes. Exact equality means DSH's router sees exactly
// the bytes we admitted — nothing to reinterpret. Unparseable paths are
// refused (fail closed).
function relayPathOk(url) {
  var raw = String(url || '/').split('?')[0]
  var normalized
  try { normalized = new URL(raw, 'http://x').pathname } catch (e) { return false }
  return normalized === raw && raw.indexOf(RELAY_PREFIX) === 0
}
const PAIR_CODE_TTL_MS = 10 * 60 * 1000
const PAIR_MAX_FAILS = 5
const PAIR_LOCK_MS = 15 * 60 * 1000
const MAX_PUSH_SUBSCRIPTIONS = 20
const HTML_BUFFER_MAX = 2 * 1024 * 1024

const PKG_ROOT = path.dirname(__dirname)
const PWA_DIR = path.join(PKG_ROOT, 'pwa')

// ---- state (v2) -------------------------------------------------------------
// { version: 2,
//   devices: { <id>: { id, token, name, role, kind, createdAt, lastSeen, ua } },
//   vapid: { publicKey, privateKey },
//   pushSubscriptions: { <deviceId>: { endpoint, keys, at, ua } } }
// role is the access channel ('web' | 'desktop-client'); kind stays the
// display layout (auto/phone/desktop) — unrelated concerns on purpose.
// Pairing codes are memory-only on purpose: a restart voids outstanding codes.
function dshHome() { return process.env.DSH_HOME || path.join(os.homedir(), '.dsh') }
function stateFile() { return path.join(dshHome(), 'lan-gate-state.json') }

function loadState() {
  var raw
  try { raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch (e) { raw = null }
  if (raw && typeof raw === 'object' && raw.version === 2) {
    var devices = (raw.devices && typeof raw.devices === 'object') ? raw.devices : {}
    // Every device predating roles behaved as a web device — backfill 'web'
    // for missing/invalid values and rewrite the file once so the migration
    // survives restarts. version stays 2.
    var rolesPatched = false
    for (var rid in devices) {
      var rd = devices[rid]
      if (rd && typeof rd === 'object' && rd.role !== 'web' && rd.role !== 'desktop-client') { rd.role = 'web'; rolesPatched = true }
    }
    var loaded = {
      version: 2,
      devices: devices,
      vapid: (raw.vapid && raw.vapid.publicKey && raw.vapid.privateKey) ? raw.vapid : null,
      pushSubscriptions: (raw.pushSubscriptions && typeof raw.pushSubscriptions === 'object') ? raw.pushSubscriptions : {}
    }
    if (rolesPatched) saveState(loaded)
    return loaded
  }
  if (raw && typeof raw === 'object' && raw.decisions) {
    // v1 (per-IP approvals) is meaningless under the token model: archive it.
    try { fs.renameSync(stateFile(), stateFile() + '.v1.bak'); console.log('[lan-gate] archived v1 state to lan-gate-state.json.v1.bak') } catch (e) {}
  }
  return { version: 2, devices: {}, vapid: null, pushSubscriptions: {} }
}
function saveState(snapshot) {
  try {
    fs.mkdirSync(dshHome(), { recursive: true })
    var tmp = stateFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(snapshot || state, null, 2), 'utf8')
    fs.renameSync(tmp, stateFile())
  } catch (e) {}
}

var state = loadState()
if (!state.vapid) { state.vapid = webpush.generateVAPIDKeys(); saveState() }
// Apple's push service (web.push.apple.com) rejects a VAPID subject that
// isn't a routable contact with 403 BadJwtToken — the placeholder default
// works on FCM/Mozilla but silently breaks every iOS device.
const VAPID_SUBJECT = cfg('LAN_GATE_VAPID_SUBJECT', 'vapidSubject', 'mailto:admin@localhost')
if (!/^(mailto:|https:\/\/)/.test(VAPID_SUBJECT) || /localhost|\.local(\b|$)/.test(VAPID_SUBJECT) || !/\./.test(VAPID_SUBJECT.replace(/^mailto:/, ''))) {
  console.warn('[lan-gate] VAPID subject "' + VAPID_SUBJECT + '" is not a routable contact; Apple will reject pushes to iOS devices with 403 BadJwtToken. Set "vapidSubject" in <DSH_HOME>/lan-gate.config.json to a real mailto: address or https:// URL.')
}
webpush.setVapidDetails(VAPID_SUBJECT, state.vapid.publicKey, state.vapid.privateKey)

var tokenIndex = new Map() // token -> device
for (var _id in state.devices) { var _d = state.devices[_id]; if (_d && _d.token) tokenIndex.set(_d.token, _d) }

var pairing = null            // { code, expiresAt, role }
var pairFails = new Map()     // ip -> { count, lockedUntil }
var rateMap = new Map()       // ip -> { started, count }
var openSockets = new Map()   // device id -> Set<socket> — live WebSocket tunnels, killed on revoke/set-role

// ---- client identity --------------------------------------------------------
function normalizeIp(raw) { return String(raw || '').replace(/^::ffff:/, '') }
function isLoopbackIp(ip) { return ip === '127.0.0.1' || ip === '::1' }
function hasForwardHeaders(req) { return req.headers['x-forwarded-for'] !== undefined || req.headers['x-forwarded-proto'] !== undefined || req.headers['x-forwarded-host'] !== undefined }

// Resolve who is really talking to us. Forwarded headers are only trusted
// when the socket peer is the proxy (loopback or explicitly listed).
function resolveClient(req) {
  var sockIp = normalizeIp(req.socket.remoteAddress)
  var proxyTrusted = isLoopbackIp(sockIp) || TRUSTED_PROXIES.indexOf(sockIp) >= 0
  var xff = req.headers['x-forwarded-for']
  if (proxyTrusted && typeof xff === 'string' && xff.trim() !== '') {
    var parts = xff.split(',').map(function (s) { return s.trim() }).filter(Boolean)
    var proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    return { ip: normalizeIp(parts[parts.length - 1]) || sockIp, viaProxy: true, https: proto === 'https' }
  }
  return { ip: sockIp, viaProxy: false, https: false }
}
// Local user at the keyboard: loopback socket, not proxied.
function isLocalDirect(req, client) { return !client.viaProxy && isLoopbackIp(client.ip) && !hasForwardHeaders(req) }

// Each credential only ever matches its own role: a cookie is a web device,
// a Bearer token is a desktop-client device — presenting either one the
// "wrong" way authenticates nothing.
function deviceForReq(req) {
  var cookieTok = parseCookies(req)[COOKIE_NAME]
  if (cookieTok) {
    var cd = tokenIndex.get(cookieTok)
    if (cd && cd.role === 'web') return cd
  }
  var auth = String(req.headers.authorization || '')
  if (auth.slice(0, 7).toLowerCase() === 'bearer ') {
    var bd = tokenIndex.get(auth.slice(7).trim())
    if (bd && bd.role === 'desktop-client') return bd
  }
  return undefined
}

// ---- small helpers ----------------------------------------------------------
function parseCookies(req) { var out = {}, h = req.headers.cookie; if (typeof h !== 'string' || h === '') return out; var parts = h.split(';'); for (var i = 0; i < parts.length; i++) { var idx = parts[i].indexOf('='); if (idx < 0) continue; var key = parts[i].slice(0, idx).trim(), value = parts[i].slice(idx + 1).trim(); if (key !== '') out[key] = value } return out }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;') }
// Responding while the request body is still in flight leaves stray bytes on
// the socket that get parsed as a bogus next request (connection poisoning,
// visible through a keep-alive reverse proxy). Drain to 'end' before replying.
function drainThen(req, res, send) {
  var fire = function () { if (res.writableEnded) return; try { send() } catch (e) {} }
  if (req.readableEnded) { fire(); return }
  // No method shortcut: even a GET can carry a body (Content-Length), and
  // replying before it drains poisons the connection.
  req.resume(); req.on('end', fire); req.on('close', fire)
}
function json(req, res, code, value) { drainThen(req, res, function () { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }) }
function sendHtml(req, res, code, html, extraHeaders) { drainThen(req, res, function () { var h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }; for (var k in (extraHeaders || {})) h[k] = extraHeaders[k]; res.writeHead(code, h); res.end(html) }) }
function readJsonBody(req, maxBytes, cb) {
  var chunks = [], size = 0
  req.on('data', function (chunk) { if (size < maxBytes) { size += chunk.length; chunks.push(chunk) } })
  req.on('end', function () { var body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch (e) { cb(null); return } cb(body && typeof body === 'object' ? body : null) })
}
function overRate(ip) { var now = Date.now(), rate = rateMap.get(ip); if (!rate || now - rate.started >= 60000) { rate = { started: now, count: 0 }; rateMap.set(ip, rate) } rate.count += 1; return rate.count > RATE_LIMIT_PER_MIN }

// ---- pairing ---------------------------------------------------------------
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O/1/I/L
// Pairing codes are minted for one channel: a 'web' code is redeemed by the
// browser pairing page, a 'desktop-client' code by the remote desktop plugin.
function newPairingCode(role) {
  var bytes = crypto.randomBytes(8), code = ''
  for (var i = 0; i < 8; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  pairing = { code: code, expiresAt: Date.now() + PAIR_CODE_TTL_MS, role: role === 'desktop-client' ? 'desktop-client' : 'web' }
  return pairing
}
function pairLock(ip) { var f = pairFails.get(ip); return (f && f.lockedUntil && f.lockedUntil > Date.now()) ? f.lockedUntil : 0 }
function pairFail(ip) { var f = pairFails.get(ip) || { count: 0, lockedUntil: 0 }; f.count += 1; if (f.count >= PAIR_MAX_FAILS) { f.lockedUntil = Date.now() + PAIR_LOCK_MS; f.count = 0 } pairFails.set(ip, f) }

// One claim flow, two channels: wantRole 'web' is the browser pairing page
// (cookie issued), 'desktop-client' is /lan-gate/pair/claim-desktop (token in
// the JSON body, never a cookie). A correct code offered to the wrong channel
// is not a guess: it neither counts toward lockout nor consumes the code —
// the code stays live for its own channel.
function pairClaim(req, res, client, wantRole) {
  if (req.method !== 'POST') { json(req, res, 405, { ok: false, reason: 'post-only' }); return }
  var locked = pairLock(client.ip)
  if (locked) { json(req, res, 429, { ok: false, reason: 'locked', retryAfterMs: locked - Date.now() }); return }
  readJsonBody(req, 4096, function (body) {
    if (!body) { json(req, res, 400, { ok: false }); return }
    var code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    var ok = pairing && pairing.expiresAt > Date.now() && code !== '' && code === pairing.code
    if (!ok) { pairFail(client.ip); json(req, res, 403, { ok: false, reason: 'bad-code' }); return }
    if (pairing.role !== wantRole) {
      var C = copyOf(langOf(req))
      json(req, res, 403, { ok: false, reason: 'role-mismatch', expected: pairing.role, message: wantRole === 'web' ? C.errRoleDesktop : C.errRoleWeb })
      return
    }
    pairing = null // one-time
    var id = crypto.randomBytes(6).toString('hex')
    var token = crypto.randomBytes(32).toString('hex')
    var name = String(body.name || '').slice(0, 40).trim() || (copyOf(langOf(req)).deviceFallback + id.slice(0, 4))
    var device = { id: id, token: token, name: name, role: wantRole, kind: 'auto', createdAt: Date.now(), lastSeen: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 160) }
    state.devices[id] = device
    tokenIndex.set(token, device)
    saveState()
    if (wantRole === 'web') {
      var flags = 'Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000' + (client.https ? '; Secure' : '')
      res.setHeader('Set-Cookie', COOKIE_NAME + '=' + token + '; ' + flags)
      json(req, res, 200, { ok: true, id: id, name: name })
    } else {
      json(req, res, 200, { ok: true, id: id, name: name, token: token })
    }
  })
}

// ---- copy ------------------------------------------------------------------
// The gateway is a standalone child process: no bundler, no access to DSH's
// locale service, so its dictionaries live right here. `{n}` is substituted at
// use. The app's own dictionaries are src/client/locales.ts; the browser-side
// PWA files carry their own (they are served raw and cannot require this).
const COPY = {
  zh: {
    pairH1: '设备配对',
    pairSub: '在 DSH「插件」页里 dsh-zen-remote 的设置页生成配对码，在此输入即可完成配对',
    pairCode: '配对码',
    pairName: '设备名（可选），如：我的手机',
    pairGo: '配对',
    pairAdmin: '配对码在 DSH「插件」页里 dsh-zen-remote 的设置页生成',
    errRate: '尝试次数过多，请 15 分钟后再试',
    errCode: '配对码不正确或已过期',
    // Right code, wrong channel: shown by the pairing page from the 403 body.
    errRoleDesktop: '该配对码仅适用于桌面应用端，请在服务端重新生成 Web 应用端配对码。',
    errRoleWeb: '该配对码仅适用于 Web 应用端，请在服务端重新生成桌面应用端配对码。',
    errNet: '网络错误，请重试',
    rateH1: '请求过于频繁',
    rateBody: '已超过每分钟 {n} 次的限制，请稍候。',
    deviceFallback: '设备 ',
    adminTitle: 'DSH 网关 · 管理',
    adminH1: '网关管理',
    adminMoved: '管理功能已移到 DSH「插件」页里 dsh-zen-remote 的设置页。',
    turnEnd: 'DSH 任务完成',
    tapH1: '需要再点一次',
    tapBody: '从外部应用打开的链接还没登录这个浏览器。点下面的站内链接一次即可进入。',
    tapOpen: '打开 DSH 界面'
  },
  en: {
    pairH1: 'Device Pairing',
    pairSub: 'Generate a pairing code on the dsh-zen-remote settings page in the DSH Plugins page, then enter it here',
    pairCode: 'Pairing code',
    pairName: 'Device name (optional), e.g. My phone',
    pairGo: 'Pair',
    pairAdmin: 'Pairing codes are minted on the dsh-zen-remote settings page in the DSH Plugins page',
    errRate: 'Too many attempts, please try again in 15 minutes',
    errCode: 'Incorrect or expired pairing code',
    errRoleDesktop: 'This pairing code is reserved for desktop clients. Please generate a new web pairing code on the server.',
    errRoleWeb: 'This pairing code is reserved for the web app. Please generate a new desktop-client pairing code on the server.',
    errNet: 'Network error, please retry',
    rateH1: 'Too Many Requests',
    rateBody: 'Exceeded the limit of {n} requests per minute. Please slow down.',
    deviceFallback: 'Device ',
    adminTitle: 'DSH Gateway · Admin',
    adminH1: 'Gateway Admin',
    adminMoved: 'Gateway administration has moved to the dsh-zen-remote settings page in the DSH Plugins page.',
    turnEnd: 'DSH task finished',
    tapH1: 'Tap once to continue',
    tapBody: 'A link opened from another app has not logged this browser in yet. Tap the in-page link below once to enter.',
    tapOpen: 'Open DSH'
  }
}
function copyOf(lang) { return COPY[lang] || COPY.zh }
// Embeds a dictionary in an inline <script>; "<" is escaped so no value can
// close the tag early.
function copyScript(lang) { return 'var C=' + JSON.stringify(copyOf(lang)).replace(/</g, '\\u003c') + ';' }

// ---- pages -----------------------------------------------------------------
function gatePage(lang, title, body) {
  return '<!doctype html><html lang="' + (lang === 'zh' ? 'zh-CN' : 'en') + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0f1115"><title>' + title + '</title><style>*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}html,body{margin:0;padding:0}body{min-height:100dvh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:radial-gradient(1100px 700px at 50% -10%,#1b2233 0%,#0f1115 55%);color:#e6e8ec;padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));-webkit-text-size-adjust:100%;text-size-adjust:100%}.card{width:100%;max-width:460px;margin:0 auto;padding:38px 26px 30px;border:1px solid #2a2f3a;border-radius:20px;background:#161a22;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.45)}.logo{width:56px;height:56px;margin:0 auto 18px;border-radius:16px;background:linear-gradient(135deg,#4c8dff,#7a5cff);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#fff}h1{font-size:21px;margin:0 0 6px}.sub{font-size:14px;color:#9aa3b2;margin:0 0 16px}p{font-size:14px;line-height:1.8;color:#9aa3b2;margin:8px 0}input{width:100%;padding:13px 14px;margin:6px 0;font-size:16px;border:1px solid #2f3748;border-radius:12px;background:#0b0e14;color:#e6e8ec;text-align:center}input#code{font-family:ui-monospace,Consolas,monospace;font-size:22px;letter-spacing:6px;text-transform:uppercase}.btn{display:inline-block;width:100%;margin-top:14px;padding:13px 30px;font-size:15px;font-weight:600;border:1px solid #4c8dff;color:#9cc0ff;background:rgba(76,141,255,.08);border-radius:12px;cursor:pointer;text-decoration:none;touch-action:manipulation;user-select:none}.btn:active{background:rgba(76,141,255,.22)}.bad{color:#f0716f;min-height:1.5em}</style></head><body><div class="card">' + body + '</div></body></html>'
}
function pairingPage(lang) {
  var C = copyOf(lang)
  return gatePage(lang, C.pairH1 + ' · DSH', '<div class="logo">DSH</div><h1>' + C.pairH1 + '</h1><p class="sub">' + C.pairSub + '</p>' +
    '<input id="code" maxlength="8" autocomplete="one-time-code" inputmode="text" placeholder="' + C.pairCode + '">' +
    '<input id="name" maxlength="40" placeholder="' + C.pairName + '">' +
    '<button class="btn" id="go">' + C.pairGo + '</button><p class="bad" id="err"></p>' +
    '<p>' + C.pairAdmin + '</p>' +
    '<script>' + copyScript(lang) + 'document.getElementById("go").addEventListener("click",function(){var b=this;b.disabled=true;fetch("/lan-gate/pair/claim",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:document.getElementById("code").value,name:document.getElementById("name").value})}).then(function(r){return r.json().then(function(j){return{s:r.status,j:j}})}).then(function(r){if(r.j&&r.j.ok){location.replace("/");return}b.disabled=false;var e=document.getElementById("err");e.textContent=r.s===429?C.errRate:((r.j&&r.j.reason==="role-mismatch"&&r.j.message)?r.j.message:C.errCode)}).catch(function(){b.disabled=false;document.getElementById("err").textContent=C.errNet})});</script>')
}
function rateLimitPage(lang) {
  var C = copyOf(lang)
  return gatePage(lang, C.rateH1 + ' · DSH', '<div class="logo">DSH</div><h1>' + C.rateH1 + '</h1><p class="bad">' + C.rateBody.replace('{n}', RATE_LIMIT_PER_MIN) + '</p>')
}

// Strict-cookie guard: a cross-app top-level navigation never carries the
// SameSite=Strict cookie, so after one exchange round-trip the retry marker
// still 401s. Looping again would be an infinite redirect — instead serve a
// same-site page whose link, once tapped, IS same-site navigation and sends
// the cookie. href = the ORIGINAL path with the retry marker stripped.
function tapThroughPage(lang, target) {
  var C = copyOf(lang)
  return gatePage(lang, C.tapH1 + ' · DSH', '<div class="logo">DSH</div><h1>' + C.tapH1 + '</h1><p class="sub">' + C.tapBody + '</p><a class="btn" href="' + target + '">' + C.tapOpen + '</a>')
}

// The admin UI itself lives in DSH's Plugins page (the dsh-zen-remote
// settings row) — this local-only URL is just a signpost for anyone who
// bookmarked the old page.
function adminPage(lang) {
  var C = copyOf(lang)
  return gatePage(lang, C.adminTitle, '<div class="logo">DSH</div><h1>' + C.adminH1 + '</h1><p class="sub">' + C.adminMoved + '</p>')
}

// ---- admin api -------------------------------------------------------------
// Live tunnels are tracked per device so credential actions land instantly:
// revoke / revoke-all / set-role destroy every socket the device still holds
// open (the upgrade handler registers them; 'close' unregisters).
function registerDeviceSocket(id, socket) {
  var set = openSockets.get(id)
  if (!set) { set = new Set(); openSockets.set(id, set) }
  set.add(socket)
}
function killDeviceSockets(id) {
  var set = openSockets.get(id)
  if (!set) return
  openSockets.delete(id)
  set.forEach(function (s) { try { s.destroy() } catch (e) {} })
}
function statusHandler(req, res) {
  var devices = []
  for (var id in state.devices) {
    var d = state.devices[id]
    devices.push({ id: d.id, name: d.name, role: d.role || 'web', kind: d.kind || 'auto', createdAt: d.createdAt, lastSeen: d.lastSeen, ua: d.ua, hasPush: !!state.pushSubscriptions[d.id] })
  }
  devices.sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0) })
  json(req, res, 200, {
    state: 'running', port: PROXY_PORT, target: TARGET_HOST + ':' + TARGET_PORT, pwa: true,
    // 0.1.2 浏览器鉴权模式：token 存在 = 自动交换；缺失 = 0.1.1 直连。只报有无。
    upstreamAuth: UPSTREAM_TOKEN === null ? 'none' : 'token',
    pairing: (pairing && pairing.expiresAt > Date.now()) ? pairing : null,
    devices: devices, pushSubscriptions: Object.keys(state.pushSubscriptions).length
  })
}
function revokeDevice(id) {
  var d = state.devices[id]
  if (!d) return
  tokenIndex.delete(d.token)
  delete state.devices[id]
  delete state.pushSubscriptions[id]
  killDeviceSockets(id) // revocation must reach already-open tunnels too
  saveState()
}
function actionHandler(req, res) {
  if (req.method !== 'POST') { json(req, res, 405, { ok: false, reason: 'post-only' }); return }
  readJsonBody(req, 16384, function (body) {
    if (!body) { json(req, res, 400, { ok: false }); return }
    var action = String(body.action || ''), id = String(body.id || '')
    if (action === 'new-code') { newPairingCode(body.role) }
    else if (action === 'set-kind') { var d = state.devices[id]; var kind = String(body.kind || ''); if (d && (kind === 'phone' || kind === 'desktop' || kind === 'auto')) { d.kind = kind; saveState() } }
    else if (action === 'set-role') {
      var role = body.role
      if (role !== 'web' && role !== 'desktop-client') { json(req, res, 400, { ok: false, reason: 'bad-role' }); return }
      var sr = state.devices[id]
      if (!sr) { json(req, res, 404, { ok: false, reason: 'no-device' }); return }
      var changed = sr.role !== role
      sr.role = role
      // Push is a web-device surface: a device demoted to a desktop client
      // loses its push subscription (a relay client can never re-register).
      if (role === 'desktop-client') delete state.pushSubscriptions[id]
      saveState()
      if (changed) killDeviceSockets(id)
    }
    else if (action === 'rename') { var d2 = state.devices[id]; var name = String(body.name || '').slice(0, 40).trim(); if (d2 && name) { d2.name = name; saveState() } }
    else if (action === 'revoke') { revokeDevice(id) }
    else if (action === 'revoke-all') { for (var k in state.devices) revokeDevice(k) }
    else { json(req, res, 400, { ok: false }); return }
    json(req, res, 200, { ok: true })
  })
}

// ---- PWA asset serving ------------------------------------------------------
const PWA_FILE_TYPES = {
  '.json': 'application/json; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'
}
function servePwaAsset(req, res) {
  const p = String(req.url || '').split('?')[0]
  if (p.indexOf('/pwa/') !== 0) return false
  const rel = p.slice('/pwa/'.length)
  if (rel.indexOf('..') !== -1 || rel.indexOf('\0') !== -1) return false
  const abs = path.normalize(path.join(PWA_DIR, rel))
  if (abs.indexOf(path.normalize(PWA_DIR)) !== 0) return false
  let body
  try { body = fs.readFileSync(abs) } catch (e) { return false }
  const ext = path.extname(abs).toLowerCase()
  const headers = { 'Content-Type': PWA_FILE_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' }
  // sw.js is served from /pwa/ but must control the whole app (scope "/",
  // matching start_url). This header is what lets a worker ask for a scope
  // wider than its own script directory — paired with { scope: '/' } on the
  // register() call in inject.js.
  if (rel === 'sw.js') headers['Service-Worker-Allowed'] = '/'
  res.writeHead(200, headers)
  res.end(body)
  return true
}

// ---- HTML injection ---------------------------------------------------------
const UUID_POLYFILL = 'if(!window.crypto||!window.crypto.randomUUID){window.crypto.randomUUID=function(){' +
  'var b=new Uint8Array(16);window.crypto.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;' +
  'var h="";for(var i=0;i<16;i++){if(i===4||i===6||i===8||i===10)h+="-";var v=b[i].toString(16);h+=(v.length===1?"0":"")+v}' +
  'return h}}'

function injectDeviceAttr(html, kind) { if (!kind) return html; var m = html.match(/<html[^>]*/i); if (!m) return html; return html.slice(0, m.index) + m[0] + ' data-lan-device="' + kind + '"' + html.slice(m.index + m[0].length) }
function readPwaText(name) { try { return fs.readFileSync(path.join(PWA_DIR, name), 'utf8') } catch (e) { return '' } }
const INJECT_JS = readPwaText('inject.js')

// NOTE (2026-08-17): this used to be where an inline `DEVICE_CSS` <style>
// block lived, injected into every response ahead of pwa/app.css. It is GONE
// ON PURPOSE -- removed entirely, not trimmed, after auditing every rule it
// held against the app.css cleanup in commit 3ec8f38 and the gate fix in
// 19881fe:
//   - Every selector in it was rooted at the literal `[data-lan-device="phone"]`
//     value, which the gateway only ever stamps for an explicit admin
//     override. A real paired phone defaults to kind "auto" and never
//     carries that attribute at all (see injectDeviceAttr below), so on
//     every actual device in the field none of these rules ever fired --
//     they only activated when someone visited the admin page and manually
//     pinned a device to "phone" for testing. That literal-phone/no-op gap
//     is exactly what caused the "phone-mode buttons look stretched" report:
//     the `min-height:44px` touch-target rule only ever fired under manual
//     testing, never in normal use, so it went unnoticed for a long time.
//   - Font-size compression, composer pill compaction (incl. the hashed
//     `.Sh0Q9G_triggerLabel` selector), and the model-menu popover fixed
//     positioning are the same "mobile UI layout" that commit 3ec8f38 handed
//     off to @dsh-external/dsh-mobile-nav -- and the popover rule actively
//     conflicted with that plugin's own bottom sheet (fixed positioning vs.
//     the sheet's own layout).
//   - The `input`/`textarea` font-size:16px workaround duplicated a rule
//     app.css already carries under the broader `:not([data-lan-device=
//     "desktop"])` gate, so it added nothing once fixed to fire on real
//     phones.
//   - The trailing `@media (max-width:820px)` fallback block duplicated the
//     one commit 3ec8f38 already removed from app.css, for the same reason:
//     dsh-mobile-nav's own media queries aren't gated on data-lan-device, so
//     they cover that fallback on their own.
// Net effect: nothing here was both correct and not already covered
// elsewhere, so there is no replacement constant -- app.css (linked below)
// is now the single place mobile shell CSS lives in this repo.

// First-frame safe area. env(safe-area-inset-*) is 0 until the viewport meta
// carries viewport-fit=cover, so on a notched iPhone the standalone PWA paints
// its FIRST frame under the notch and only springs back once something
// disturbs the viewport (a drag). dsh-mobile-nav patches the same meta, but
// only after its bundle boots — too late for the cold-start frame. Patching it
// here puts it in the HTML itself.
// The whole tag is replaced (rather than the content merged): this is exactly
// the value dsh-mobile-nav installs at <=1023px, so gateway and plugin cannot
// drift apart. Applied to every device kind EXCEPT an explicit "desktop" —
// the default kind is "auto", which is what real phones are registered as, so
// a kind === 'phone' gate would be a no-op for them. On a screen without a
// display cutout viewport-fit=cover changes nothing.
const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
function coverViewport(html) {
  const re = /<meta\b[^>]*\bname\s*=\s*["']?viewport["']?[^>]*>/i
  if (re.test(html)) return html.replace(re, VIEWPORT_META)
  const headOpen = html.search(/<head[^>]*>/i)
  if (headOpen < 0) return html
  const at = html.indexOf('>', headOpen) + 1
  return html.slice(0, at) + VIEWPORT_META + html.slice(at)
}

// DSH itself already ships its own <link rel="manifest" href="/manifest.webmanifest">
// (generic name/icon, display:fullscreen). Left in place, it sits BEFORE our
// injected tag in <head> — and a document only ever honors the first
// rel="manifest" link it finds, so our mobile-tailored manifest.json (proper
// 192/512/maskable icons, "DeepSeek Harness Mobile" branding, the
// background_color the iOS dead-strip fix depends on) was silently shadowed
// and never took effect. Strip any pre-existing manifest link so ours is the
// only one and actually governs the install.
const MANIFEST_LINK_RE = /<link\b[^>]*\brel\s*=\s*["']?manifest["']?[^>]*>\s*/gi
function stripExistingManifestLink(html) { return html.replace(MANIFEST_LINK_RE, '') }
const MANIFEST_LINK = '<link rel="manifest" href="/pwa/manifest.json">'
// No theme-color injection here: DSH's own client already owns that meta and
// keeps it in step with the resolved theme (measured direct on :3080,
// 2026-08-20: two tags at rgb(21,21,23) under dark). Chrome honours the
// FIRST matching theme-color, so anything injected here silently outranks
// the app's correct value — the fixed '#0f1115' that used to live here did
// exactly that. Left empty on purpose.
const THEME_META = ''
const APPLE_META = '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="DSH">'
const APPLE_TOUCH = '<link rel="apple-touch-icon" href="/pwa/icons/icon-192.png">'

function pwaBoot(lang) { return '<script>window.__DSH_PWA__={vapid:"' + esc(state.vapid.publicKey) + '",lang:"' + lang + '"};' + INJECT_JS + '</script>' }

function injectHtml(html, kind, lang) {
  html = injectDeviceAttr(html, kind)
  if (kind !== 'desktop') html = coverViewport(html)
  html = stripExistingManifestLink(html)
  const headOpen = html.search(/<head[^>]*>/i)
  if (headOpen < 0) return html
  const headClose = html.search(/<\/head>/i)
  const headInsert = html.indexOf('>', headOpen) + 1
  const headTail = headClose > headInsert ? headClose : html.length
  const inject = '<script>' + UUID_POLYFILL + '</script>' +
    MANIFEST_LINK + THEME_META + APPLE_META + APPLE_TOUCH +
    '<link rel="stylesheet" href="/pwa/app.css">' +
    pwaBoot(lang)
  html = html.slice(0, headTail) + inject + html.slice(headTail)
  return html
}

// ---- push ------------------------------------------------------------------
function pushSubscribeHandler(req, res, device) {
  if (req.method !== 'POST') { json(req, res, 405, { ok: false, reason: 'post-only' }); return }
  readJsonBody(req, 32768, function (body) {
    if (!body) { json(req, res, 400, { ok: false }); return }
    var sub = body.subscription
    // Real push services are always https; the loopback-http exception exists for tests.
    var allowHttpLoopback = process.env.LAN_GATE_ALLOW_HTTP_PUSH === '1' && typeof (sub && sub.endpoint) === 'string' && /^http:\/\/127\.0\.0\.1[:/]/.test(sub.endpoint)
    if (!sub || typeof sub.endpoint !== 'string' || (!/^https:\/\//.test(sub.endpoint) && !allowHttpLoopback)) { json(req, res, 400, { ok: false, reason: 'bad-subscription' }); return }
    var isNew = !state.pushSubscriptions[device.id]
    if (isNew && Object.keys(state.pushSubscriptions).length >= MAX_PUSH_SUBSCRIPTIONS) { json(req, res, 429, { ok: false, reason: 'too-many-subscriptions' }); return }
    state.pushSubscriptions[device.id] = { endpoint: sub.endpoint, keys: sub.keys || {}, at: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 160) }
    saveState()
    json(req, res, 200, { ok: true })
  })
}
// web-push does the hard part (aes128gcm encryption + VAPID JWT) via
// generateRequestDetails; we dispatch the HTTP call ourselves so the endpoint
// scheme is honored (real push services are https; tests use http loopback).
function deliverPush(subscription, payload, cb) {
  var details
  try { details = webpush.generateRequestDetails(subscription, payload, { TTL: 3600 }) } catch (e) { cb(e); return }
  var u
  try { u = new URL(details.endpoint) } catch (e) { cb(e); return }
  var mod = u.protocol === 'https:' ? require('node:https') : http
  var pReq = mod.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: details.method, headers: details.headers }, function (pRes) {
    var chunks = []
    pRes.on('data', function (c) { if (chunks.length < 8) chunks.push(c) })
    pRes.on('end', function () {
      var code = pRes.statusCode
      if (code >= 200 && code < 300) { cb(null); return }
      var err = new Error('push status ' + code)
      err.statusCode = code
      // The provider explains the refusal in the body (e.g. Apple's
      // {"reason":"BadJwtToken"}); swallowing it made failures unreadable.
      err.body = Buffer.concat(chunks).toString('utf8').slice(0, 200)
      cb(err)
    })
  })
  pReq.on('error', function (e) { cb(e) })
  pReq.end(details.body)
}

function pushSendHandler(req, res) {
  if (req.method !== 'POST') { json(req, res, 405, { ok: false, reason: 'post-only' }); return }
  readJsonBody(req, 16384, function (body) {
    if (!body) { json(req, res, 400, { ok: false }); return }
    // Deliberately no conversation content: title + optional session label only.
    var payload = JSON.stringify({ title: String(body.title || copyOf(langOf(req)).turnEnd).slice(0, 80), body: String(body.body || '').slice(0, 120), tag: String(body.tag || 'dsh-agent-done'), data: { url: '/' } })
    var ids = Object.keys(state.pushSubscriptions)
    if (!ids.length) { json(req, res, 200, { ok: true, sent: 0, failed: 0 }); return }
    var sent = 0, failed = 0, pending = ids.length, dirty = false
    ids.forEach(function (id) {
      var sub = state.pushSubscriptions[id]
      deliverPush({ endpoint: sub.endpoint, keys: sub.keys }, payload, function (err) {
        if (!err) sent++
        else {
          failed++
          var code = err.statusCode
          var host = ''
          try { host = new URL(sub.endpoint).host } catch (e2) { host = '?' }
          console.warn('[lan-gate] push to ' + host + ' failed: ' + (code || '-') + ' ' + String(err.body || err.message || '').replace(/\s+/g, ' '))
          if (code === 404 || code === 410) { delete state.pushSubscriptions[id]; dirty = true } // expired subscription
        }
        pending--
        if (pending === 0) { if (dirty) saveState(); json(req, res, 200, { ok: true, sent: sent, failed: failed }) }
      })
    })
  })
}

// ---- proxy -----------------------------------------------------------------
function cleanHeaders(req, clientIp, device) {
  var headers = req.headers
  var drop = { host: 1, origin: 1, connection: 1, 'proxy-connection': 1, 'keep-alive': 1, te: 1, trailer: 1, 'transfer-encoding': 1, upgrade: 1, 'proxy-authorization': 1, 'proxy-authenticate': 1 }
  // For HTML navigations we buffer + modify the body, so ask upstream for
  // identity encoding (otherwise we'd corrupt gzip).
  var wantsHtml = String(headers.accept || '').indexOf('text/html') >= 0
  var out = {}
  for (var k in headers) {
    var lk = String(k).toLowerCase()
    if (drop[lk]) continue
    // The x-zen-remote-* namespace belongs to the gateway: client-supplied
    // values (forged or stale) are dropped for EVERY request, local direct
    // included, before any gateway value is written below. This covers
    // x-zen-remote-secret (T22a) too — only the gateway's own value may
    // reach upstream, never one a client brought along.
    if (lk.indexOf('x-zen-remote-') === 0) continue
    if (wantsHtml && lk === 'accept-encoding') continue
    out[k] = headers[k]
  }
  var targetOrigin = 'http://' + TARGET_HOST + ':' + TARGET_PORT
  // DSH's /api trust fence validates browser Origin/Referer against its own
  // origin; dropping Origin (the old behavior) or leaking the public domain
  // breaks state-changing plugin calls (e.g. dshmarket installs). Requests
  // reaching here already passed the device-token gate — and SameSite=Lax
  // keeps cross-site POSTs cookie-less — so presenting them to DSH as
  // same-origin does not reopen CSRF.
  if (headers.origin !== undefined) out['origin'] = targetOrigin
  if (typeof headers.referer === 'string') {
    try { var refUrl = new URL(headers.referer); out['referer'] = targetOrigin + refUrl.pathname + refUrl.search } catch (e) { delete out['referer'] }
  }
  out['host'] = TARGET_HOST + ':' + TARGET_PORT
  out['x-forwarded-for'] = clientIp
  // Marking headers: only for requests that passed device auth. The local
  // user's requests stay unmarked — DSH sees them exactly as when it is
  // browsed directly on the box.
  if (device) {
    out['x-zen-remote-via'] = 'gateway'
    out['x-zen-remote-role'] = device.role
    out['x-zen-remote-device'] = device.id
    // T22a: prove to DSH's relay routes that these marking headers were
    // written by THIS gateway and not forged by a local process hitting
    // 127.0.0.1 directly (client-supplied x-zen-remote-secret was already
    // dropped in the loop above, so this is always the gateway's own value).
    // T22a-fix: the secret rides ONLY on desktop-client traffic that actually
    // qualifies for the relay (right role + normalization-clean relay path —
    // the same admission the request already passed) — a web device's
    // forwards have no business carrying it. Local direct requests stay
    // unmarked — no device, no secret.
    if (device.role === 'desktop-client' && RELAY_SECRET && relayPathOk(req.url)) out['x-zen-remote-secret'] = RELAY_SECRET
    // The Bearer token is the gateway credential, not a DSH one — upstream
    // identifies the device by x-zen-remote-device alone. Forwarding the
    // token would hand DSH (and anything it logs) the pairing secret.
    if (device.role === 'desktop-client') delete out['authorization']
  }
  return out
}

// --- 0.1.2 browser-auth exchange --------------------------------------------
// DSH 0.1.2 requires a signed cookie even for the homepage. The gateway
// "plays courier": when the upstream 401s an HTML navigation, it does one
// `GET /?token=…` on the client's behalf (Host still rewritten to loopback,
// so the authority the cookie binds to is the same one DSH validates) and
// hands the resulting set-cookie straight back with a 303 to the client's
// original path + a retry marker. The marker breaks the SameSite=Strict
// dead-loop: a marked request that STILL 401s (cross-app navigation) gets the
// tap-through page instead of another redirect.
var AUTH_RETRY_MARKER = 'dsh-auth-retry=1'
function hasAuthRetry(url) {
  var q = String(url || '').indexOf('?')
  if (q < 0) return false
  return String(url).slice(q + 1).split('&').indexOf(AUTH_RETRY_MARKER) >= 0
}
function addAuthRetry(url) {
  return String(url || '/') + (String(url || '').indexOf('?') >= 0 ? '&' : '?') + AUTH_RETRY_MARKER
}
function stripAuthRetry(url) {
  var u = String(url || '/')
  var q = u.indexOf('?')
  if (q < 0) return u
  var rest = u.slice(q + 1).split('&').filter(function (p) { return p !== AUTH_RETRY_MARKER })
  return rest.length ? u.slice(0, q) + '?' + rest.join('&') : u.slice(0, q)
}
function isHtmlNavigation(req) {
  return req.method === 'GET'
    && String(req.headers.accept || '').indexOf('text/html') >= 0
    && String(req.url || '').split('?')[0].indexOf('/api/') !== 0
}
function serveTapThrough(req, res, rejectedUpRes) {
  try { if (rejectedUpRes) rejectedUpRes.resume() } catch (e) {}
  sendHtml(req, res, 200, tapThroughPage(langOf(req), stripAuthRetry(req.url || '/')))
}
function attemptAuthExchange(req, res, client, rejectedUpRes) {
  // Free the rejected 401 socket before making the follow-up request.
  try { rejectedUpRes.resume() } catch (e) {}
  var exchangeHeaders = cleanHeaders({ headers: { accept: 'text/html' } }, client.ip)
  var exchange = http.request({
    host: TARGET_HOST, port: TARGET_PORT, method: 'GET',
    path: '/?token=' + encodeURIComponent(UPSTREAM_TOKEN),
    headers: exchangeHeaders
  }, function (xRes) {
    var xc = xRes.statusCode || 0
    var cookies = xRes.headers['set-cookie']
    if (xc >= 300 && xc < 400 && cookies && cookies.length) {
      // The token worked: pass the upstream cookie through verbatim and send
      // the client back to its original path, marked once.
      var out = { location: addAuthRetry(req.url), 'set-cookie': cookies }
      try { res.writeHead(303, out) } catch (e2) {}
      res.end()
      return
    }
    // Token exchange failed too: guard page, never another redirect.
    serveTapThrough(req, res)
  })
  exchange.on('error', function () {
    try { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad Gateway') } catch (e) {}
  })
  exchange.end()
}

function forwardRequest(req, res, client, device) {
  var headers = cleanHeaders(req, client.ip, device)
  var upstream = http.request({ host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers: headers }, function (upRes) {
    // 0.1.2 browser auth: an HTML navigation that upstream 401s is either
    // exchanged for a cookie (first try) or, when the retry marker says we
    // already tried, answered with the tap-through page — never a 401 body
    // handed to a phone that cannot act on it, and never a second redirect.
    // Desktop-client devices are excluded: the exchange mints a BROWSER
    // session cookie, which is exactly what the relay gate exists to keep
    // from a desktop client — its upstream 401s pass through untouched.
    if (UPSTREAM_TOKEN !== null && upRes.statusCode === 401 && isHtmlNavigation(req) && !(device && device.role === 'desktop-client')) {
      if (hasAuthRetry(req.url)) { serveTapThrough(req, res, upRes); return }
      attemptAuthExchange(req, res, client, upRes)
      return
    }
    var outHeaders = {}; for (var k in upRes.headers) outHeaders[k] = upRes.headers[k]
    // upRes is already de-chunked by the http client; forwarding hop-by-hop
    // framing headers would produce an invalid (or double-framed) response.
    delete outHeaders['transfer-encoding']; delete outHeaders['connection']; delete outHeaders['keep-alive']
    var ct = String(outHeaders['content-type'] || '')
    var enc = String(outHeaders['content-encoding'] || '')
    var isHtml = ct.indexOf('text/html') >= 0 && (enc === '' || enc === 'identity')
    var kind = device && (device.kind === 'phone' || device.kind === 'desktop') ? device.kind : undefined
    if (isHtml) {
      outHeaders['cache-control'] = 'no-store'
      var chunks = [], size = 0, done = false
      upRes.on('data', function (chunk) {
        if (done) { return }
        size += chunk.length
        chunks.push(chunk)
        if (size > HTML_BUFFER_MAX) {
          // Too big to buffer: pass through untouched (no injection, no corruption).
          done = true
          try { res.writeHead(upRes.statusCode || 502, outHeaders); for (var i = 0; i < chunks.length; i++) res.write(chunks[i]) } catch (e) {}
          upRes.pipe(res)
        }
      })
      upRes.on('end', function () {
        if (done) return
        done = true
        try {
          var html = injectHtml(Buffer.concat(chunks).toString('utf8'), kind, langOf(req))
          delete outHeaders['content-length']
          outHeaders['content-length'] = String(Buffer.byteLength(html))
          res.writeHead(upRes.statusCode || 502, outHeaders)
          res.end(html)
        } catch (e) { try { res.end() } catch (e2) {} }
      })
      upRes.on('error', function () { if (!done) { done = true; try { res.end() } catch (e) {} } })
      return
    }
    try { res.writeHead(upRes.statusCode || 502, outHeaders) } catch (e) {}
    // T23a-fix2: push the response headers out NOW, not with the first body
    // byte — an NDJSON relay stream answers 200 while its body may stay idle
    // for a whole heartbeat (default 15s), and a client whose header-phase
    // timeout is just as long would judge the link dead before the first
    // ping ever arrived.
    res.flushHeaders()
    upRes.pipe(res)
  })
  upstream.on('error', function () { try { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad Gateway') } catch (e) {} })
  res.on('close', function () { try { upstream.destroy() } catch (e) {} })
  req.pipe(upstream)
}

// ---- server ----------------------------------------------------------------
var lastSeenDirty = false
function touchDevice(device) { device.lastSeen = Date.now(); lastSeenDirty = true } // persisted by sweep + shutdown

var server = http.createServer(function (req, res) {
  var client = resolveClient(req)
  var pathname = String(req.url || '/').split('?')[0]
  var local = isLocalDirect(req, client)
  var device = local ? undefined : deviceForReq(req)
  // Rate limiting protects the unauthenticated surface (pairing page/claim).
  // Local users and paired devices are exempt — the DSH SPA fires dozens of
  // requests per page load; their guardrail is the token + revocation.
  if (!local && !device && overRate(client.ip)) { sendHtml(req, res, 429, rateLimitPage(langOf(req)), { 'Retry-After': '60' }); return }

  // Local-only surface: admin UI, admin API, pairing-code generation, push trigger.
  if (pathname === '/lan-gate/status') { if (!local) { json(req, res, 403, { ok: false }); return } statusHandler(req, res); return }
  if (pathname === '/lan-gate/action') { if (!local) { json(req, res, 403, { ok: false }); return } actionHandler(req, res); return }
  if (pathname === '/lan-gate/admin') { if (!local) { json(req, res, 403, { ok: false }); return } sendHtml(req, res, 200, adminPage(langOf(req))); return }
  if (pathname === '/lan-gate/pair') {
    if (!local) { json(req, res, 403, { ok: false }); return }
    if (req.method !== 'POST') { json(req, res, 405, { ok: false }); return }
    // Body {"role":"desktop-client"} mints a desktop code; absent/unparseable
    // body (or role) means the classic web code.
    readJsonBody(req, 4096, function (body) {
      var p = newPairingCode(body && body.role)
      json(req, res, 200, { ok: true, code: p.code, expiresAt: p.expiresAt, role: p.role })
    })
    return
  }

  if (pathname === '/lan-gate/pair/claim') { pairClaim(req, res, client, 'web'); return } // browser pairing page, reachable by anyone, guarded by code + lockout
  if (pathname === '/lan-gate/pair/claim-desktop') { pairClaim(req, res, client, 'desktop-client'); return } // desktop client pairing, same guards, token in the body
  if (pathname === '/pwa/push/send') { if (!local) { json(req, res, 403, { ok: false }); return } pushSendHandler(req, res); return }

  // The web-app manifest and its icons must be readable WITHOUT the device
  // cookie: browsers fetch the manifest (and every icon it lists)
  // credential-less by spec, so behind the pairing wall Chrome silently got
  // the 401 pairing page instead — no install prompt, and the install name
  // fell back to the upstream <title> ("DeepSeek Harness"). These files carry
  // no user data. Everything else under /pwa/ stays behind the wall.
  if (pathname === '/pwa/manifest.json' || pathname.indexOf('/pwa/icons/') === 0) { if (servePwaAsset(req, res)) return }

  if (local || device) {
    if (device) {
      touchDevice(device)
      // A desktop-client device is a relay client, not a browser: everything
      // outside the relay prefix is refused before any other branch (this
      // includes /pwa/push/subscribe — push is a web-device surface). The
      // gate is normalization-aware: dot segments, %-encoded dots and
      // backslashes may not smuggle a path past the prefix.
      if (device.role === 'desktop-client' && !relayPathOk(req.url)) { json(req, res, 403, { ok: false, reason: 'relay-only' }); return }
      if (pathname === '/pwa/push/subscribe') { pushSubscribeHandler(req, res, device); return }
    }
    if (pathname.indexOf('/pwa/') === 0 && pathname.indexOf('/pwa/push/') !== 0) { if (servePwaAsset(req, res)) return }
    forwardRequest(req, res, client, device)
    return
  }

  // Unpaired remote: everything funnels into the pairing page.
  if (pathname.indexOf('/api/') === 0 || String(req.headers.accept || '').indexOf('application/json') >= 0) { json(req, res, 401, { ok: false, reason: 'unpaired' }); return }
  sendHtml(req, res, 401, pairingPage(langOf(req)))
})

server.on('upgrade', function (req, socket, head) {
  var client = resolveClient(req)
  var local = isLocalDirect(req, client)
  var device = local ? undefined : deviceForReq(req)
  if (!local && !device && overRate(client.ip)) { try { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n') } catch (e) {} return }
  var ok = local || device !== undefined
  if (!ok) { try { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') } catch (e) {} return }
  if (device) {
    touchDevice(device)
    // Same admission rule as HTTP: a desktop-client device may only open the
    // relay prefix (normalization-aware — see relayPathOk).
    if (device.role === 'desktop-client' && !relayPathOk(req.url)) { try { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') } catch (e) {} return }
  }
  var headers = cleanHeaders(req, client.ip, device)
  headers['upgrade'] = req.headers['upgrade'] || 'websocket'
  headers['connection'] = 'Upgrade'
  // Role as it stood at admission — the recheck in the connect callback
  // compares against this snapshot, so a set-role landing mid-connect is
  // caught even though the device record itself is mutated in place.
  var admittedRole = device && device.role
  var upstream = net.connect(TARGET_PORT, TARGET_HOST, function () {
    var raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n'
    for (var k in headers) { var v = headers[k]; if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) raw += k + ': ' + v[i] + '\r\n' } else { raw += k + ': ' + v + '\r\n' } }
    raw += '\r\n'
    var kill = function () { try { socket.destroy() } catch (e) {} try { upstream.destroy() } catch (e) {} }
    socket.on('error', kill); upstream.on('error', kill); socket.on('close', kill); upstream.on('close', kill)
    if (device) {
      // The gates ran when the upgrade ARRIVED; a revoke or set-role landing
      // while the upstream connection was still opening would miss the
      // not-yet-registered socket. Re-check before registering: the token
      // must still resolve to this device, and the role must not have moved
      // since admission — any drift tears both ends down immediately.
      var live = tokenIndex.get(device.token)
      if (live !== device || live.role !== admittedRole) { kill(); return }
      // Tunnel is up: register it so revoke/set-role can tear it down, and
      // drop the registration again as soon as it closes.
      registerDeviceSocket(device.id, socket)
      var unregister = function () { var set = openSockets.get(device.id); if (set) { set.delete(socket); if (set.size === 0) openSockets.delete(device.id) } }
      socket.on('close', unregister); socket.on('error', unregister)
    }
    try { upstream.write(raw) } catch (e) {}
    if (head && head.length > 0) { try { upstream.write(head) } catch (e) {} }
    socket.pipe(upstream); upstream.pipe(socket)
  })
  upstream.on('error', function () { try { socket.destroy() } catch (e) {} })
})

server.on('clientError', function (e, socket) { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') } catch (e2) {} })

var maxPort = PROXY_PORT + 20
// T17b: a row reload (settings save touching a restart-required field) tells
// the OLD gateway child to exit and starts the new one immediately, so the
// configured port can still be held by the dying process for a moment.
// Jumping straight to port+1 on the first EADDRINUSE stranded the new child
// on a port nothing else targets — the admin API and push leg kept pointing
// at the configured port and could not connect. So: retry the SAME port
// every 200ms, up to 15 times (~3s), and only then fall back to the
// original +1 walk. The final port is always printed by the listening log.
var SAME_PORT_RETRIES = 15
var SAME_PORT_RETRY_MS = 200
var samePortTries = 0
server.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    if (samePortTries < SAME_PORT_RETRIES) {
      samePortTries += 1
      // The line the port-retry test (and anyone reading the log) keys on:
      // proof the gateway really entered the same-port retry instead of
      // binding straight away.
      console.warn('[lan-gate] port ' + PROXY_PORT + ' busy, retrying (' + samePortTries + '/' + SAME_PORT_RETRIES + ')')
      setTimeout(function () { try { server.listen(PROXY_PORT, LISTEN_HOST) } catch (e2) { console.error('[lan-gate] listen failed: ' + String(e2 && e2.message || e2)); process.exit(1) } }, SAME_PORT_RETRY_MS)
      return
    }
    if (PROXY_PORT < maxPort) {
      PROXY_PORT += 1
      console.warn('[lan-gate] port still busy after ' + SAME_PORT_RETRIES + ' same-port retries, falling back to port ' + PROXY_PORT)
      try { server.listen(PROXY_PORT, LISTEN_HOST) } catch (e2) { console.error('[lan-gate] listen failed: ' + String(e2 && e2.message || e2)); process.exit(1) }
      return
    }
  }
  console.error('[lan-gate] server error: ' + String(err && err.message ? err.message : err)); process.exit(1)
})
server.listen(PROXY_PORT, LISTEN_HOST, function () { console.log('[lan-gate] listening on ' + LISTEN_HOST + ':' + PROXY_PORT + ' -> ' + TARGET_HOST + ':' + TARGET_PORT + ' (pwa=on, auth=pairing)') })

var sweep = setInterval(function () {
  var now = Date.now()
  rateMap.forEach(function (rate, ip) { if (now - rate.started >= 120000) rateMap.delete(ip) })
  pairFails.forEach(function (f, ip) { if (f.lockedUntil && f.lockedUntil < now && f.count === 0) pairFails.delete(ip) })
  if (pairing && pairing.expiresAt < now) pairing = null
  if (lastSeenDirty) { lastSeenDirty = false; saveState() }
}, 3000)
function shutdown() { clearInterval(sweep); if (lastSeenDirty) saveState(); try { server.close() } catch (e) {} process.exit(0) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
console.log('[lan-gate] gateway starting on port ' + PROXY_PORT)
