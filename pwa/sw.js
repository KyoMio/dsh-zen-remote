/* dsh-mobile-pwa · service worker
 * Offline-capable caching + agent-done push notifications for the DSH Web UI.
 *
 * Strategy (v4 — see the "new DOM + old CSS" postmortem below):
 *  - True static shell (manifest, icons, offline fallback) -> cache-first.
 *    These are the only assets whose bytes cannot change without an entry in
 *    SHELL_PATHS changing too, so caching them aggressively is safe.
 *  - Content-addressed build output (a Vite hash in the filename, or DSH's
 *    plugin graph served with ?rev=<build revision>) -> cache-first. The URL is
 *    a function of the bytes, so a hit can never be stale: a new deploy is a
 *    NEW URL. This is what makes the second and later cold starts cheap — the
 *    app shell JS/CSS and the ~12 MB plugin graph come from CacheStorage
 *    instead of crossing the reverse proxy again. Stored payloads must match
 *    the type their URL claims, and endless streams are never cached.
 *  - Everything else same-origin (unhashed JS/CSS incl. this plugin's own
 *    app.css/inject.js/touch-gestures.js, API calls, fonts, images) ->
 *    network-first, falling back to cache only when the network fetch
 *    actually fails (offline).
 *  - SPA navigations (HTML doc) -> network-first, falling back to the last
 *    successfully loaded page when offline.
 *
 * v2 treated ALL JS/CSS/fonts/images as cache-first-ish (stale-while-
 * revalidate: serve the cached copy immediately, refresh in the background).
 * That's exactly backwards for a bundle that changes on every deploy without
 * its filename changing: a phone that had the PWA open across a deploy kept
 * serving yesterday's cached JS/CSS on the very next cold start, while HTML
 * navigation (already network-first) served today's markup — a "new DOM +
 * old CSS" mismatch (e.g. cards rendered full-bleed) that a fresh local
 * profile never reproduces because it has nothing stale to serve. Only the
 * handful of files in SHELL_PATHS are safe to keep cache-first — plus, from
 * v4 on, content-addressed URLs, whose freshness proof is the URL itself.
 *
 * Served by the gateway at /pwa/sw.js. Registered from the injected PWA script.
 */
'use strict'

const SHELL_CACHE = 'dsh-mobile-pwa-shell-v4'
const RUNTIME_CACHE = 'dsh-mobile-pwa-runtime-v4'

const SHELL_PATHS = new Set([
  '/pwa/manifest.json',
  '/pwa/icons/icon-192.png',
  '/pwa/icons/icon-512.png',
  '/pwa/icons/icon-maskable-512.png',
  '/pwa/offline.html'
])

// A Vite content hash in the filename (/assets/index-CN7NIWNw.js, hashed
// fonts, lazy language chunks): 8+ base64url characters after the last dash.
// A plain-word filename that happens to match the shape (vendor-bootstrap.css,
// app-BOOTSTRAP.js) has no digit and only one letter case and is rejected; a
// genuine all-lowercase hash would merely fall back to network-first.
const IMMUTABLE_ASSET_RE = /^\/assets\/(?:[^/]+\/)*[^/]+-([A-Za-z0-9_-]{8,})\.(?:js|mjs|css|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/
// DSH serves a whole plugin batch through /plugins/??<id>/client.js&rev=<hash>.
// DSH derives that revision as a 12-char sha1 hex slice over the plugin
// artifact's mtime/ctime/size (a build revision, not a content hash) and
// serves those URLs immutable itself; requiring hex rejects words like
// rev=default/latest.
const IMMUTABLE_PLUGIN_RE = /^\/plugins\//
const IMMUTABLE_REV_RE = /[?&]rev=([0-9a-f]{8,})(?:&|$)/i
function isContentAddressedAsset(pathname) {
  const m = IMMUTABLE_ASSET_RE.exec(pathname)
  if (m === null) return false
  const hash = m[1]
  return /[0-9]/.test(hash) || (/[a-z]/.test(hash) && /[A-Z]/.test(hash))
}
function isImmutableUrl(url) {
  return isContentAddressedAsset(url.pathname) ||
    (IMMUTABLE_PLUGIN_RE.test(url.pathname) && IMMUTABLE_REV_RE.test(url.search))
}
// cacheFirst only stores what the URL claims to be. A 200 HTML/SPA-fallback or
// error page served at an asset URL (deploy race, login wall, revoked device)
// must never become a permanent "asset" in CacheStorage.
function responseContentType(res) {
  try { return res && res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('content-type') || '') : '' } catch (e) { return '' }
}
function immutablePayloadOk(url, res) {
  const ct = responseContentType(res).toLowerCase()
  if (ct === '') return false
  if (url.pathname.indexOf('/plugins/') === 0) return ct.indexOf('javascript') !== -1 || ct.indexOf('ecmascript') !== -1
  if (/\.css$/.test(url.pathname)) return ct.indexOf('text/css') === 0
  if (/\.(?:m?js)$/.test(url.pathname)) return ct.indexOf('javascript') !== -1 || ct.indexOf('ecmascript') !== -1
  // DSH's static server treats fonts (and some images) as octet-stream — the
  // extension is still the payload's identity, and an HTML page never carries
  // that type.
  if (/\.(?:woff2?|ttf|otf|eot)$/.test(url.pathname)) return ct.indexOf('font/') === 0 || ct.indexOf('application/octet-stream') === 0
  return ct.indexOf('image/') === 0 || ct.indexOf('application/octet-stream') === 0
}

// ---- Copy -------------------------------------------------------------
// A worker has no window and no gateway injection, so the language comes from
// the worker's own navigator (guarded: the test sandbox has none). Only two
// surfaces need it — the offline fallback and the push payload's defaults,
// which the gateway normally fills in anyway.
const T = (String((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase().indexOf('zh') === 0 ? {
  offlineTitle: '离线',
  offlineBody: '无法连接到 DSH 服务器，正在重试…<br>请确认你的网关与服务仍在运行。',
  pushTitle: 'DSH 任务完成',
  pushBody: '你的智能体已完成某一步。'
} : {
  offlineTitle: 'Offline',
  offlineBody: 'Cannot reach the DSH server, retrying…<br>Check that your gateway and DSH are still running.',
  pushTitle: 'DSH task finished',
  pushBody: 'Your agent finished a step.'
})

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll([
      '/pwa/manifest.json',
      '/pwa/icons/icon-192.png',
      '/pwa/icons/icon-512.png',
      '/pwa/icons/icon-maskable-512.png'
    ]))
  )
  // Safe to activate immediately: this worker only decides how *future*
  // fetches are served (cache-first for the static shell and content-addressed
  // build output, network-first for everything else). A tab that's already
  // loaded keeps running the JS it already has in memory regardless of which
  // SW version is "active" — it only starts talking to the new worker on its
  // next fetch/navigation — so skipping the wait doesn't yank code out from
  // under a running page. What
  // it *does* fix: without it, an old SW can sit "waiting" indefinitely on a
  // phone that never fully closes the PWA, which is the same staleness bug
  // this rewrite targets, just at the SW-registration layer instead of the
  // cache layer.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  )
  // Take over already-open tabs right away rather than waiting for their
  // next full reload. Paired with network-first below, this means an open
  // tab starts getting fresh JS/CSS/HTML on its very next fetch instead of
  // continuing to hit whatever the previous worker had cached.
  self.clients.claim()
})

// ---- fetch handler -------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)

  // Same-origin only; we only manage the DSH origin behind the gateway.
  if (url.origin !== self.location.origin) return

  // 1. True static shell -> cache-first.
  if (req.method === 'GET' && SHELL_PATHS.has(url.pathname)) {
    event.respondWith(cacheFirst(req, SHELL_CACHE))
    return
  }

  // 2. Content-addressed build output -> cache-first. The URL names its own
  //    bytes (Vite filename hash, or DSH's ?rev=<content hash> plugin graph),
  //    so a deploy reaches the phone as a new URL rather than new bytes under
  //    a cached one — no "new DOM + old CSS" risk.
  if (req.method === 'GET' && isImmutableUrl(url)) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE, (res) => immutablePayloadOk(url, res)))
    return
  }

  // 3. HTML navigations -> network-first with offline fallback to the last
  //    successfully loaded page.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(req))
    return
  }

  // 4. Everything else same-origin GET -> network-first. Unhashed JS/CSS,
  //    API calls, fonts and images can change on any deploy without their
  //    URL changing, so the server's current copy always wins; the cache
  //    only serves them when offline.
  if (req.method === 'GET') {
    event.respondWith(networkFirst(req, RUNTIME_CACHE))
    return
  }
})

// A response cannot be cloned/consumed to completion without blocking the
// caller, so NEVER await cache.put() on the response path: /plugins/events is
// an endless text/event-stream, and awaiting its clone would keep
// respondWith() pending forever (the stream would never open). Fire and
// forget; a rejected write (quota, Vary:*) must not break the fetch either.
function isEndlessResponse(res) {
  const ct = responseContentType(res).toLowerCase()
  return ct.indexOf('text/event-stream') !== -1 ||
    ct.indexOf('application/x-ndjson') !== -1 ||
    ct.indexOf('multipart/') === 0
}

async function cacheFirst(req, cacheName, accept) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(req)
  if (cached) return cached
  const res = await fetch(req)
  if (res && res.ok && !isEndlessResponse(res) && (!accept || accept(res))) {
    cache.put(req, res.clone()).catch(() => {})
  }
  return res
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const res = await fetch(req)
    if (res && res.ok && req.method === 'GET' && !isEndlessResponse(res)) {
      cache.put(req, res.clone()).catch(() => {})
    }
    return res
  } catch (err) {
    const cached = await cache.match(req)
    if (cached) return cached
    throw err
  }
}

async function networkFirstNavigation(req) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const res = await fetch(req)
    if (res && res.ok) cache.put('/pwa/offline.html', res.clone())
    return res
  } catch (err) {
    const cached = await cache.match('/pwa/offline.html')
    if (cached) return cached
    // Last resort: offline fallback hint.
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>' + T.offlineTitle + '</title><style>body{font-family:system-ui;background:#0f1115;color:#e6e8ec;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}p{max-width:24em;text-align:center;line-height:1.7}</style><script>setInterval(()=>location.reload(),4000)</script><p>' + T.offlineBody + '</p>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    )
  }
}

// ---- push (agent-done) notifications ------------------------------------
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch (e) { /* ignore */ }
  const title = data.title || T.pushTitle
  const options = {
    body: data.body || T.pushBody,
    icon: '/pwa/icons/icon-192.png',
    badge: '/pwa/icons/icon-192.png',
    tag: data.tag || 'dsh-agent-done',
    renotify: true,
    data: data.data || {}
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) { client.navigate(target); return client.focus() }
      }
      return self.clients.openWindow(target)
    })
  )
})
