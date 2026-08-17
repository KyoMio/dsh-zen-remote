/* dsh-mobile-pwa · service worker
 * Offline-capable caching + agent-done push notifications for the DSH Web UI.
 *
 * Strategy (v3 — see the "new DOM + old CSS" postmortem below):
 *  - True static shell (manifest, icons, offline fallback) -> cache-first.
 *    These are the only assets whose bytes cannot change without an entry in
 *    SHELL_PATHS changing too, so caching them aggressively is safe.
 *  - Everything else same-origin (DSH's own JS/CSS bundle, plugin client
 *    bundles incl. this plugin's own app.css/inject.js/touch-gestures.js,
 *    API calls, fonts, images) -> network-first, falling back to cache only
 *    when the network fetch actually fails (offline).
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
 * handful of files in SHELL_PATHS are safe to keep cache-first.
 *
 * Served by the gateway at /pwa/sw.js. Registered from the injected PWA script.
 */
'use strict'

const SHELL_CACHE = 'dsh-mobile-pwa-shell-v3'
const RUNTIME_CACHE = 'dsh-mobile-pwa-runtime-v3'

const SHELL_PATHS = new Set([
  '/pwa/manifest.json',
  '/pwa/icons/icon-192.png',
  '/pwa/icons/icon-512.png',
  '/pwa/icons/icon-maskable-512.png',
  '/pwa/offline.html'
])

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
  // fetches are served (cache-first for the shell, network-first for
  // everything else). A tab that's already loaded keeps running the JS it
  // already has in memory regardless of which SW version is "active" — it
  // only starts talking to the new worker on its next fetch/navigation — so
  // skipping the wait doesn't yank code out from under a running page. What
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

  // 2. HTML navigations -> network-first with offline fallback to the last
  //    successfully loaded page.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(req))
    return
  }

  // 3. Everything else same-origin GET -> network-first. This is the DSH
  //    client bundle (JS/CSS, incl. plugin client bundles), API calls,
  //    fonts and images: all of it can change on any deploy, so the server's
  //    current copy always wins; the cache only serves it when offline.
  if (req.method === 'GET') {
    event.respondWith(networkFirst(req, RUNTIME_CACHE))
    return
  }
})

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(req)
  if (cached) return cached
  const res = await fetch(req)
  if (res && res.ok) cache.put(req, res.clone())
  return res
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const res = await fetch(req)
    if (res && res.ok && req.method === 'GET') cache.put(req, res.clone())
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
      '<!doctype html><meta charset="utf-8"><title>离线</title><style>body{font-family:system-ui;background:#0f1115;color:#e6e8ec;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}p{max-width:24em;text-align:center;line-height:1.7}</style><script>setInterval(()=>location.reload(),4000)</script><p>无法连接到 DSH 服务器，正在重试…<br>请确认你的网关与服务仍在运行。</p>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    )
  }
}

// ---- push (agent-done) notifications ------------------------------------
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch (e) { /* ignore */ }
  const title = data.title || 'DSH 任务完成'
  const options = {
    body: data.body || '你的智能体已完成某一步。',
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
