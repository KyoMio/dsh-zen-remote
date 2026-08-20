/* dsh-mobile-pwa · PWA bootstrap (injected into DSH page)
 * Runs on every device (desktop included): registers the service worker
 * (offline cache + notifications) and wires the agent-done push opt-in
 * unconditionally. Touch gestures are the only piece gated by device kind —
 * loaded on everything that isn't explicitly marked "desktop", see below.
 */
(function () {
  'use strict'
  if (!window.__DSH_PWA__) window.__DSH_PWA__ = {}

  // ---- Register service worker ----------------------------------------
  // Explicit scope: '/' — the script lives at /pwa/sw.js, so its default
  // scope is only /pwa/ and it would never control the app itself (start_url
  // "/"). The gateway sends Service-Worker-Allowed: / with the sw.js
  // response so Chrome permits a scope wider than the script's own directory.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/pwa/sw.js', { scope: '/' }).then((reg) => {
        window.__DSH_PWA__.reg = reg
      }).catch((err) => {
        console.warn('[dsh-pwa] SW registration failed:', err)
      })
    })
  }

  // ---- Load touch gestures on every non-desktop device -----------------
  // A paired device defaults to kind "auto" — the gateway never sets
  // data-lan-device for it (see lib/lan-gate-server.cjs), only for an
  // explicit "phone" or "desktop". Gating on the literal "phone" value meant
  // this never loaded on a real phone left at its default kind. Matching
  // app.css's own `:not([data-lan-device="desktop"])` gate here instead:
  // anything that isn't explicitly desktop gets touch gestures.
  var isNonDesktop = document.documentElement.getAttribute('data-lan-device') !== 'desktop'
  if (isNonDesktop) {
    var g = document.createElement('script')
    g.src = '/pwa/touch-gestures.js'
    g.async = true
    document.head.appendChild(g)
  }

  // ---- Agent-done notification (Web Push) -----------------------------
  // Subscribes to a gateway push endpoint. The gateway polls DSH event state and
  // triggers push. Grant & subscribe are opt-in via the button appended below.
  window.__DSH_PWA__.subscribe = function subscribe() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      alert('当前浏览器不支持推送通知')
      return Promise.reject(new Error('push unsupported'))
    }
    return new Promise(function (resolve, reject) {
      if (!window.__DSH_PWA__.reg) {
        navigator.serviceWorker.ready.then(function (reg) {
          window.__DSH_PWA__.reg = reg
          doSubscribe(reg).then(resolve).catch(reject)
        }).catch(reject)
      } else {
        doSubscribe(window.__DSH_PWA__.reg).then(resolve).catch(reject)
      }
    })
  }

  // VAPID public key arrives base64url-encoded via the injected bootstrap.
  function vapidKeyBytes() {
    var s = String(window.__DSH_PWA__.vapid || '')
    if (!s) return undefined
    s = s.replace(/-/g, '+').replace(/_/g, '/')
    while (s.length % 4) s += '='
    var raw = atob(s)
    var a = new Uint8Array(raw.length)
    for (var i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i)
    return a
  }

  function doSubscribe(reg) {
    return reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidKeyBytes()
    }).then(function (sub) {
      // Notify the gateway so it can route push to this subscription.
      return fetch('/pwa/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() })
      })
    })
  }

  // ---- Push opt-in ------------------------------------------------------
  // Deliberately NOT gated on device kind: a device left at the default
  // "auto" carries no data-lan-device attribute, and desktop browsers do
  // Web Push too. Gating this on isPhone silently disabled push for every
  // device that was never explicitly marked as a phone.
  var pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  var SNOOZE_KEY = 'dsh-pwa-notif-snooze'
  var SNOOZE_MS = 7 * 24 * 3600 * 1000
  // iOS grants Web Push only to home-screen installs, never to a Safari tab.
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  var isStandalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)

  function postSubscription(sub) {
    return fetch('/pwa/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() })
    })
  }

  // Permission already granted: make sure the gateway actually holds this
  // device's subscription (it may have been lost to a state reset, or the
  // original POST may have failed). No prompt is shown — none is needed.
  function resyncPush() {
    if (!pushSupported || window.Notification.permission !== 'granted') return
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription().then(function (sub) {
        if (sub) return postSubscription(sub)
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyBytes() }).then(postSubscription)
      })
    }).catch(function (err) { console.warn('[dsh-pwa] push resync failed:', err) })
  }

  function card(title, bodyHtml, buttonsHtml) {
    var el = document.createElement('div')
    el.id = 'dsh-pwa-notif-hint'
    el.style.cssText =
      'position:fixed;left:max(12px,env(safe-area-inset-left));right:max(12px,env(safe-area-inset-right));' +
      'bottom:max(96px,calc(env(safe-area-inset-bottom) + 96px));z-index:2147483005;max-width:420px;margin:0 auto;' +
      'background:rgba(22,26,34,.96);border:1px solid #2a2f3a;border-radius:14px;' +
      'padding:14px 16px;color:#e6e8ec;font:13px/1.6 system-ui;' +
      '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.5)'
    el.innerHTML = '<div style="font-weight:600;margin-bottom:4px">' + title + '</div>' +
      '<div style="color:#9aa3b2;margin-bottom:10px">' + bodyHtml + '</div>' +
      '<div style="display:flex;gap:8px">' + buttonsHtml + '</div>'
    document.body.appendChild(el)
    return el
  }
  var BTN_ON = '<button data-act="on" style="flex:1;background:#4c8dff;color:#fff;border:0;border-radius:9px;padding:9px 0;font-weight:600">开启</button>'
  var BTN_OFF = '<button data-act="off" style="flex:1;background:#2a2f3a;color:#9aa3b2;border:0;border-radius:9px;padding:9px 0">暂不</button>'
  var BTN_CLOSE = '<button data-act="off" style="flex:1;background:#2a2f3a;color:#9aa3b2;border:0;border-radius:9px;padding:9px 0">知道了</button>'

  // Callable by hand at any time: window.__DSH_PWA__.askPush()
  window.__DSH_PWA__.askPush = function askPush(manual) {
    var old = document.getElementById('dsh-pwa-notif-hint')
    if (old) old.remove()
    if (!pushSupported) {
      if (isIOS && !isStandalone) {
        card('🔔 任务完成提醒', '在 iPhone 上，推送通知只对「添加到主屏幕」后的应用生效。请先用 Safari 的分享菜单添加到主屏幕，再从主屏图标打开本页。', BTN_CLOSE)
          .querySelector('[data-act="off"]').addEventListener('click', function () { document.getElementById('dsh-pwa-notif-hint').remove() })
      } else if (manual) {
        alert('当前浏览器不支持 Web Push 通知')
      }
      return
    }
    if (window.Notification.permission === 'denied') {
      if (manual) alert('通知权限已被拒绝，请到浏览器/系统的站点设置里重新允许')
      return
    }
    if (window.Notification.permission === 'granted') { resyncPush(); return }

    var el = card('🔔 任务完成提醒',
      '开启后，智能体干完活会推送通知到这台设备，即使你切到别的 App。通知不含对话内容。',
      BTN_ON + BTN_OFF)
    el.querySelector('[data-act="on"]').addEventListener('click', function () {
      el.remove()
      // Must run inside the click gesture: Safari rejects subscribe() otherwise.
      window.__DSH_PWA__.subscribe().catch(function (err) {
        console.warn('[dsh-pwa] subscribe failed:', err)
        alert('开启失败：' + (err && err.message ? err.message : err))
      })
    })
    el.querySelector('[data-act="off"]').addEventListener('click', function () {
      try { localStorage.setItem(SNOOZE_KEY, String(Date.now())) } catch (e) {}
      el.remove()
    })
  }

  if (pushSupported || (isIOS && !isStandalone)) {
    var snoozedAt = 0
    try { snoozedAt = Number(localStorage.getItem(SNOOZE_KEY) || 0) } catch (e) {}
    // Migrate the old permanent dismissal to a snooze so previously dismissed
    // devices get another chance instead of being silenced forever.
    try {
      if (localStorage.getItem('dsh-pwa-notif-hint')) { localStorage.removeItem('dsh-pwa-notif-hint'); snoozedAt = 0 }
    } catch (e) {}
    if (pushSupported && window.Notification.permission === 'granted') resyncPush()
    else if (Date.now() - snoozedAt > SNOOZE_MS) {
      if (document.readyState === 'complete') window.__DSH_PWA__.askPush()
      else window.addEventListener('load', function () { window.__DSH_PWA__.askPush() })
    }
  }
})()

