/* dsh-mobile-pwa · lib/lan-gate-server.cjs
 *
 * Public-facing gateway for DeepSeek Harness (DSH), designed to sit BEHIND a
 * TLS-terminating reverse proxy (nginx/Caddy) owned by the user.
 *
 * Trust model (v2, rework/public-auth-push):
 *   - Device identity = pairing token (`lg_device` cookie), NOT source IP.
 *   - New devices see a pairing page; they redeem a short-lived one-time code
 *     generated from the local admin page. Failed attempts are rate-limited
 *     and locked out.
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
// vapidSubject, pushEvents, pushDebounceMs, pushSummary}). Explicit env wins.
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
const TRUSTED_PROXIES = String(cfg('LAN_GATE_TRUSTED_PROXIES', 'trustedProxies', '')).split(',').map(function (s) { return s.trim() }).filter(Boolean)

const COOKIE_NAME = 'lg_device'
const PAIR_CODE_TTL_MS = 10 * 60 * 1000
const PAIR_MAX_FAILS = 5
const PAIR_LOCK_MS = 15 * 60 * 1000
const MAX_PUSH_SUBSCRIPTIONS = 20
const HTML_BUFFER_MAX = 2 * 1024 * 1024

const PKG_ROOT = path.dirname(__dirname)
const PWA_DIR = path.join(PKG_ROOT, 'pwa')

// ---- state (v2) -------------------------------------------------------------
// { version: 2,
//   devices: { <id>: { id, token, name, kind, createdAt, lastSeen, ua } },
//   vapid: { publicKey, privateKey },
//   pushSubscriptions: { <deviceId>: { endpoint, keys, at, ua } } }
// Pairing codes are memory-only on purpose: a restart voids outstanding codes.
function dshHome() { return process.env.DSH_HOME || path.join(os.homedir(), '.dsh') }
function stateFile() { return path.join(dshHome(), 'lan-gate-state.json') }

function loadState() {
  var raw
  try { raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch (e) { raw = null }
  if (raw && typeof raw === 'object' && raw.version === 2) {
    return {
      version: 2,
      devices: (raw.devices && typeof raw.devices === 'object') ? raw.devices : {},
      vapid: (raw.vapid && raw.vapid.publicKey && raw.vapid.privateKey) ? raw.vapid : null,
      pushSubscriptions: (raw.pushSubscriptions && typeof raw.pushSubscriptions === 'object') ? raw.pushSubscriptions : {}
    }
  }
  if (raw && typeof raw === 'object' && raw.decisions) {
    // v1 (per-IP approvals) is meaningless under the token model: archive it.
    try { fs.renameSync(stateFile(), stateFile() + '.v1.bak'); console.log('[lan-gate] archived v1 state to lan-gate-state.json.v1.bak') } catch (e) {}
  }
  return { version: 2, devices: {}, vapid: null, pushSubscriptions: {} }
}
function saveState() {
  try {
    fs.mkdirSync(dshHome(), { recursive: true })
    var tmp = stateFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
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

var pairing = null            // { code, expiresAt }
var pairFails = new Map()     // ip -> { count, lockedUntil }
var rateMap = new Map()       // ip -> { started, count }

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

function deviceForReq(req) { var tok = parseCookies(req)[COOKIE_NAME]; return tok ? tokenIndex.get(tok) : undefined }

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
function newPairingCode() {
  var bytes = crypto.randomBytes(8), code = ''
  for (var i = 0; i < 8; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  pairing = { code: code, expiresAt: Date.now() + PAIR_CODE_TTL_MS }
  return pairing
}
function pairLock(ip) { var f = pairFails.get(ip); return (f && f.lockedUntil && f.lockedUntil > Date.now()) ? f.lockedUntil : 0 }
function pairFail(ip) { var f = pairFails.get(ip) || { count: 0, lockedUntil: 0 }; f.count += 1; if (f.count >= PAIR_MAX_FAILS) { f.lockedUntil = Date.now() + PAIR_LOCK_MS; f.count = 0 } pairFails.set(ip, f) }

function claimHandler(req, res, client) {
  if (req.method !== 'POST') { json(req, res, 405, { ok: false, reason: 'post-only' }); return }
  var locked = pairLock(client.ip)
  if (locked) { json(req, res, 429, { ok: false, reason: 'locked', retryAfterMs: locked - Date.now() }); return }
  readJsonBody(req, 4096, function (body) {
    if (!body) { json(req, res, 400, { ok: false }); return }
    var code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    var ok = pairing && pairing.expiresAt > Date.now() && code !== '' && code === pairing.code
    if (!ok) { pairFail(client.ip); json(req, res, 403, { ok: false, reason: 'bad-code' }); return }
    pairing = null // one-time
    var id = crypto.randomBytes(6).toString('hex')
    var token = crypto.randomBytes(32).toString('hex')
    var name = String(body.name || '').slice(0, 40).trim() || ('设备 ' + id.slice(0, 4))
    var device = { id: id, token: token, name: name, kind: 'auto', createdAt: Date.now(), lastSeen: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 160) }
    state.devices[id] = device
    tokenIndex.set(token, device)
    saveState()
    var flags = 'Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000' + (client.https ? '; Secure' : '')
    res.setHeader('Set-Cookie', COOKIE_NAME + '=' + token + '; ' + flags)
    json(req, res, 200, { ok: true, id: id, name: name })
  })
}

// ---- pages -----------------------------------------------------------------
function gatePage(title, body) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0f1115"><title>' + title + '</title><style>*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}html,body{margin:0;padding:0}body{min-height:100dvh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:radial-gradient(1100px 700px at 50% -10%,#1b2233 0%,#0f1115 55%);color:#e6e8ec;padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));-webkit-text-size-adjust:100%;text-size-adjust:100%}.card{width:100%;max-width:460px;margin:0 auto;padding:38px 26px 30px;border:1px solid #2a2f3a;border-radius:20px;background:#161a22;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.45)}.logo{width:56px;height:56px;margin:0 auto 18px;border-radius:16px;background:linear-gradient(135deg,#4c8dff,#7a5cff);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#fff}h1{font-size:21px;margin:0 0 6px}.sub{font-size:14px;color:#9aa3b2;margin:0 0 16px}p{font-size:14px;line-height:1.8;color:#9aa3b2;margin:8px 0}input{width:100%;padding:13px 14px;margin:6px 0;font-size:16px;border:1px solid #2f3748;border-radius:12px;background:#0b0e14;color:#e6e8ec;text-align:center}input#code{font-family:ui-monospace,Consolas,monospace;font-size:22px;letter-spacing:6px;text-transform:uppercase}.btn{display:inline-block;width:100%;margin-top:14px;padding:13px 30px;font-size:15px;font-weight:600;border:1px solid #4c8dff;color:#9cc0ff;background:rgba(76,141,255,.08);border-radius:12px;cursor:pointer;text-decoration:none;touch-action:manipulation;user-select:none}.btn:active{background:rgba(76,141,255,.22)}.bad{color:#f0716f;min-height:1.5em}</style></head><body><div class="card">' + body + '</div></body></html>'
}
function pairingPage() {
  return gatePage('设备配对 · DSH', '<div class="logo">DSH</div><h1>设备配对</h1><p class="sub">在电脑上打开管理页生成配对码，输入后即可使用</p>' +
    '<input id="code" maxlength="8" autocomplete="one-time-code" inputmode="text" placeholder="配对码">' +
    '<input id="name" maxlength="40" placeholder="设备名（可选），如：我的手机">' +
    '<button class="btn" id="go">配对</button><p class="bad" id="err"></p>' +
    '<p>管理页：本机浏览器访问<br>http://127.0.0.1:' + PROXY_PORT + '/lan-gate/admin</p>' +
    '<script>document.getElementById("go").addEventListener("click",function(){var b=this;b.disabled=true;fetch("/lan-gate/pair/claim",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:document.getElementById("code").value,name:document.getElementById("name").value})}).then(function(r){return r.json().then(function(j){return{s:r.status,j:j}})}).then(function(r){if(r.j&&r.j.ok){location.replace("/");return}b.disabled=false;var e=document.getElementById("err");e.textContent=r.s===429?"尝试次数过多，请 15 分钟后再试":"配对码不正确或已过期"}).catch(function(){b.disabled=false;document.getElementById("err").textContent="网络错误，请重试"})});</script>')
}
function rateLimitPage(ip) { return gatePage('请求过于频繁 · DSH', '<div class="logo">DSH</div><h1>请求过于频繁</h1><p class="bad">已超过每分钟 ' + RATE_LIMIT_PER_MIN + ' 次的限制，请稍候。</p>') }

function adminPage() {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0f1115"><title>DSH 网关 · 管理</title><style>*{box-sizing:border-box}html,body{margin:0;padding:0}body{min-height:100dvh;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:radial-gradient(1100px 700px at 50% -10%,#1b2233 0%,#0f1115 55%);color:#e6e8ec;padding:20px 16px 30px}.card{width:100%;max-width:560px;margin:0 auto;padding:28px 24px 24px;border:1px solid #2a2f3a;border-radius:20px;background:#161a22;box-shadow:0 20px 60px rgba(0,0,0,.45)}.head{display:flex;align-items:center;gap:12px;margin-bottom:18px}.logo{width:44px;height:44px;flex:none;border-radius:13px;background:linear-gradient(135deg,#4c8dff,#7a5cff);display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:700;color:#fff}h1{font-size:19px;margin:0}.sub{font-size:13px;color:#9aa3b2;margin:2px 0 0}.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;border-radius:999px;padding:3px 10px;border:1px solid #2a2f3a;color:#9aa3b2;margin:0 0 14px}.badge b{width:8px;height:8px;border-radius:50%;background:#34d399;box-shadow:0 0 8px #34d399}.label{font-size:13px;font-weight:600;margin:18px 0 8px}.code{font-family:ui-monospace,Consolas,monospace;font-size:26px;letter-spacing:6px;color:#9cc0ff;background:#0b0e14;border:1px solid #232a37;border-radius:10px;padding:12px 16px;text-align:center;margin:6px 0}.item{padding:10px 0;border-bottom:1px solid #232a37}.item:last-child{border-bottom:none}.name{font-size:14px;font-weight:600}.muted{font-size:12px;color:#9aa3b2;margin:3px 0;word-break:break-all}.row{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}.btn{font-size:13px;border:1px solid #2f3748;background:transparent;color:#e6e8ec;border-radius:9px;padding:7px 14px;cursor:pointer}.btn:active{background:#222838}.btn-primary{border-color:#4c8dff;color:#9cc0ff;background:rgba(76,141,255,.08)}.btn-danger{border-color:#f0716f;color:#f0716f}.kind{font-size:12px;border:1px solid #2f3748;background:transparent;color:#9aa3b2;border-radius:999px;padding:5px 12px;cursor:pointer}.kind.on{border-color:#4c8dff;color:#9cc0ff;background:rgba(76,141,255,.08)}.empty{font-size:13px;color:#9aa3b2;text-align:center;padding:12px 0}.note{font-size:12px;color:#6b7280;line-height:1.7;margin:16px 0 0}.err{color:#f0716f;font-size:13px}</style></head><body><div class="card"><div class="head"><div class="logo">DSH</div><div><h1>网关管理</h1><p class="sub">配对码 + 设备令牌 · 经反代对外</p></div></div><span class="badge"><b></b>运行中 · 127.0.0.1:' + PROXY_PORT + ' → DSH ' + TARGET_PORT + '</span>' +
    '<div class="label">配对码</div><div id="pair" class="empty">尚未生成</div><div class="row"><button class="btn btn-primary" data-act="new-code">生成配对码</button></div><p class="note">配对码 10 分钟有效、一次性。在新设备的配对页输入即可完成配对。</p>' +
    '<div class="label">已配对设备</div><div id="devices" class="empty">加载中…</div>' +
    '<div class="row" style="margin-top:14px"><button class="btn btn-danger" data-act="revoke-all">全部吊销</button></div>' +
    '<p class="note">访问方式：手机=紧凑排版+PWA，电脑=桌面布局，自动=按设备自适应。吊销立即生效并同时删除该设备的推送订阅。</p><div id="err"></div></div><script>' +
    'var KIND={auto:"自动",phone:"手机",desktop:"电脑"};function post(body){return fetch("/lan-gate/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(){refresh()}).catch(function(){})}function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function fmt(ms){return ms?new Date(ms).toLocaleString():""}' +
    'function render(s){var pairEl=document.getElementById("pair");if(s.pairing&&s.pairing.code){pairEl.innerHTML="<div class=\\"code\\">"+esc(s.pairing.code)+"</div><div class=\\"muted\\">有效至 "+fmt(s.pairing.expiresAt)+"</div>";pairEl.className=""}else{pairEl.textContent="尚未生成（或已使用/过期）";pairEl.className="empty"}' +
    'var ds=s.devices||[],h="";if(!ds.length)h="<div class=\\"empty\\">暂无已配对设备</div>";for(var i=0;i<ds.length;i++){var d=ds[i];var kb="";var ks=["auto","phone","desktop"];for(var j=0;j<ks.length;j++){var k=ks[j];kb+="<button class=\\"kind"+(d.kind===k?" on":"")+"\\" data-act=\\"set-kind\\" data-id=\\""+esc(d.id)+"\\" data-kind=\\""+k+"\\">"+KIND[k]+"</button>"}h+="<div class=\\"item\\"><div class=\\"name\\">"+esc(d.name)+(d.hasPush?" · 🔔":"")+"</div><div class=\\"muted\\">"+esc(d.ua||"")+"</div><div class=\\"muted\\">配对 "+fmt(d.createdAt)+" · 最近 "+fmt(d.lastSeen)+"</div><div class=\\"row\\">"+kb+"<button class=\\"btn btn-danger\\" data-act=\\"revoke\\" data-id=\\""+esc(d.id)+"\\">吊销</button></div></div>"}document.getElementById("devices").innerHTML=h}' +
    'function refresh(){fetch("/lan-gate/status").then(function(r){return r.json()}).then(render).catch(function(){var e=document.getElementById("err");if(e)e.innerHTML="<div class=\\"err\\">无法读取状态</div>"})}' +
    'document.addEventListener("click",function(ev){var el=ev.target;if(!el||!el.getAttribute)return;var act=el.getAttribute("data-act");if(!act)return;if(act==="new-code"){post({action:"new-code"});return}if(act==="set-kind"){post({action:"set-kind",id:el.getAttribute("data-id"),kind:el.getAttribute("data-kind")});return}if(act==="revoke"){post({action:"revoke",id:el.getAttribute("data-id")});return}if(act==="revoke-all"){post({action:"revoke-all"});return}});refresh();setInterval(refresh,3000);' +
    '</script></body></html>'
}

// ---- admin api -------------------------------------------------------------
function statusHandler(req, res) {
  var devices = []
  for (var id in state.devices) {
    var d = state.devices[id]
    devices.push({ id: d.id, name: d.name, kind: d.kind || 'auto', createdAt: d.createdAt, lastSeen: d.lastSeen, ua: d.ua, hasPush: !!state.pushSubscriptions[d.id] })
  }
  devices.sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0) })
  json(req, res, 200, {
    state: 'running', port: PROXY_PORT, target: TARGET_HOST + ':' + TARGET_PORT, pwa: true,
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
  saveState()
}
function actionHandler(req, res) {
  if (req.method !== 'POST') { json(req, res, 405, { ok: false, reason: 'post-only' }); return }
  readJsonBody(req, 16384, function (body) {
    if (!body) { json(req, res, 400, { ok: false }); return }
    var action = String(body.action || ''), id = String(body.id || '')
    if (action === 'new-code') { newPairingCode() }
    else if (action === 'set-kind') { var d = state.devices[id]; var kind = String(body.kind || ''); if (d && (kind === 'phone' || kind === 'desktop' || kind === 'auto')) { d.kind = kind; saveState() } }
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

function pwaBoot() { return '<script>window.__DSH_PWA__={vapid:"' + esc(state.vapid.publicKey) + '"};' + INJECT_JS + '</script>' }

// Small fixed entry for the local user browsing through the gateway port —
// remote/paired devices never get this (admin surface is local-only anyway).
const ADMIN_CHIP = '<a href="/lan-gate/admin" title="设备配对管理" style="position:fixed;right:14px;bottom:14px;z-index:2147483000;font:12px system-ui;padding:6px 12px;border-radius:999px;background:rgba(22,26,34,.9);color:#9cc0ff;border:1px solid #2a2f3a;text-decoration:none;opacity:.8">⚙ 配对管理</a>'

function injectHtml(html, kind, adminEntry) {
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
    pwaBoot()
  html = html.slice(0, headTail) + inject + html.slice(headTail)
  if (adminEntry) {
    var bodyClose = html.search(/<\/body>/i)
    html = bodyClose >= 0 ? html.slice(0, bodyClose) + ADMIN_CHIP + html.slice(bodyClose) : html + ADMIN_CHIP
  }
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
    var payload = JSON.stringify({ title: String(body.title || 'DSH 任务完成').slice(0, 80), body: String(body.body || '').slice(0, 120), tag: String(body.tag || 'dsh-agent-done'), data: { url: '/' } })
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
function cleanHeaders(req, clientIp) {
  var headers = req.headers
  var drop = { host: 1, origin: 1, connection: 1, 'proxy-connection': 1, 'keep-alive': 1, te: 1, trailer: 1, 'transfer-encoding': 1, upgrade: 1, 'proxy-authorization': 1, 'proxy-authenticate': 1 }
  // For HTML navigations we buffer + modify the body, so ask upstream for
  // identity encoding (otherwise we'd corrupt gzip).
  var wantsHtml = String(headers.accept || '').indexOf('text/html') >= 0
  var out = {}
  for (var k in headers) { var lk = String(k).toLowerCase(); if (drop[lk]) continue; if (wantsHtml && lk === 'accept-encoding') continue; out[k] = headers[k] }
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
  return out
}

function forwardRequest(req, res, client, device, isLocal) {
  var headers = cleanHeaders(req, client.ip)
  var upstream = http.request({ host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers: headers }, function (upRes) {
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
          var html = injectHtml(Buffer.concat(chunks).toString('utf8'), kind, isLocal === true)
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
  if (!local && !device && overRate(client.ip)) { sendHtml(req, res, 429, rateLimitPage(client.ip), { 'Retry-After': '60' }); return }

  // Local-only surface: admin UI, admin API, pairing-code generation, push trigger.
  if (pathname === '/lan-gate/status') { if (!local) { json(req, res, 403, { ok: false }); return } statusHandler(req, res); return }
  if (pathname === '/lan-gate/action') { if (!local) { json(req, res, 403, { ok: false }); return } actionHandler(req, res); return }
  if (pathname === '/lan-gate/admin') { if (!local) { json(req, res, 403, { ok: false }); return } sendHtml(req, res, 200, adminPage()); return }
  if (pathname === '/lan-gate/pair') { if (!local) { json(req, res, 403, { ok: false }); return } if (req.method !== 'POST') { json(req, res, 405, { ok: false }); return } json(req, res, 200, { ok: true, code: newPairingCode().code, expiresAt: pairing.expiresAt }); return }

  if (pathname === '/lan-gate/pair/claim') { claimHandler(req, res, client); return } // reachable by anyone, guarded by code + lockout
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
      if (pathname === '/pwa/push/subscribe') { pushSubscribeHandler(req, res, device); return }
    }
    if (pathname.indexOf('/pwa/') === 0 && pathname.indexOf('/pwa/push/') !== 0) { if (servePwaAsset(req, res)) return }
    forwardRequest(req, res, client, device, local)
    return
  }

  // Unpaired remote: everything funnels into the pairing page.
  if (pathname.indexOf('/api/') === 0 || String(req.headers.accept || '').indexOf('application/json') >= 0) { json(req, res, 401, { ok: false, reason: 'unpaired' }); return }
  sendHtml(req, res, 401, pairingPage())
})

server.on('upgrade', function (req, socket, head) {
  var client = resolveClient(req)
  var local = isLocalDirect(req, client)
  var device = local ? undefined : deviceForReq(req)
  if (!local && !device && overRate(client.ip)) { try { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n') } catch (e) {} return }
  var ok = local || device !== undefined
  if (!ok) { try { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') } catch (e) {} return }
  if (device) touchDevice(device)
  var headers = cleanHeaders(req, client.ip)
  headers['upgrade'] = req.headers['upgrade'] || 'websocket'
  headers['connection'] = 'Upgrade'
  var upstream = net.connect(TARGET_PORT, TARGET_HOST, function () {
    var raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n'
    for (var k in headers) { var v = headers[k]; if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) raw += k + ': ' + v[i] + '\r\n' } else { raw += k + ': ' + v + '\r\n' } }
    raw += '\r\n'
    var kill = function () { try { socket.destroy() } catch (e) {} try { upstream.destroy() } catch (e) {} }
    socket.on('error', kill); upstream.on('error', kill); socket.on('close', kill); upstream.on('close', kill)
    try { upstream.write(raw) } catch (e) {}
    if (head && head.length > 0) { try { upstream.write(head) } catch (e) {} }
    socket.pipe(upstream); upstream.pipe(socket)
  })
  upstream.on('error', function () { try { socket.destroy() } catch (e) {} })
})

server.on('clientError', function (e, socket) { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') } catch (e2) {} })

var maxPort = PROXY_PORT + 20
server.on('error', function (err) { if (err && err.code === 'EADDRINUSE' && PROXY_PORT < maxPort) { PROXY_PORT += 1; try { server.listen(PROXY_PORT, LISTEN_HOST) } catch (e2) { console.error('[lan-gate] listen failed: ' + String(e2 && e2.message || e2)); process.exit(1) } return } console.error('[lan-gate] server error: ' + String(err && err.message ? err.message : err)); process.exit(1) })
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
