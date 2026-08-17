<h1 align="center">Remote access (gateway half)</h1>
<p align="center">Turn DeepSeek Harness into a mobile PWA you can safely reach from the public internet: pairing-code auth + token identity + real Web Push, with your own reverse proxy terminating TLS.</p>

> Full documentation for the gateway half of `dsh-mobile-remote`: reverse proxy, pairing, environment variables, admin API, push, security boundary.
> Installation and quick start live in the [root README](../README.md) (Chinese); interface-side detail in [interface.md](interface.md).

Built on the MIT [dsh-mobile-gate](https://github.com/Bernardxu123/dsh-mobile-gate) secure-gateway base, with PWA differentiation.

[![npm version](https://img.shields.io/npm/v/the gateway half)](https://www.npmjs.com/package/the gateway half)
[![license](https://img.shields.io/github/license/KyoMio/the gateway half)](https://github.com/KyoMio/the gateway half/blob/main/LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-ready-4c8dff)](https://github.com/topics/dsh-plugin)

---

## Features

| Module | What |
| --- | --- |
| 🔑 **Public-internet identity** | The gateway listens on `127.0.0.1` only, sitting behind your own reverse proxy. New devices trade a pairing code for a long-lived device token (cookie `lg_device`) — identity follows the token, not the source IP |
| 📱 **Real PWA** | `manifest.json` + service worker: once the proxy provides HTTPS, "Add to Home Screen" actually works — standalone full-screen app with icon, splash, theme-color, maskable assets |
| 🌐 **Offline** | SW v3: only the true static shell (manifest/icons/offline page) is cache-first, everything else (DSH client bundle JS/CSS, API, page HTML) is network-first — a new deploy is picked up immediately instead of lingering behind stale cached CSS |
| 👆 **Touch gestures** | Pinch-to-resize font (resettable); edge-swipe-back has been handed off to the interface half (see "Division of labor" below), pull-to-refresh has been removed entirely (an accidental overscroll used to fire a full reload mid-conversation) |
| 🔔 **Agent-done push** | Real Web Push (VAPID-signed, aes128gcm-encrypted). Notified when the agent finishes, even from another app — the notification never carries conversation content |
| 🛎️ **`push_notify` tool** | A model-callable push tool (registered by `dsh-push.mjs`): the model can decide mid-task that the user needs a decision, that a key milestone was reached, or that an error needs a human — and push straight to the lock screen instead of waiting for the turn to end. Usage discipline (don't call this often) is spelled out in the tool description; the host also enforces it with rate limits (max 1 per 60s per session, 20/hour globally) — over the limit, the call is silently dropped, never an error. Same aes128gcm end-to-end encryption, same lock-screen-only exposure. Turn it off entirely with `pushTool: false` in `lan-gate.config.json` (or `DSH_PUSH_TOOL=0`); it's also skipped automatically on hosts without a tool registry (`ctx.tools`), with no effect on the rest of the plugin |
| 📐 **Touch layout** | This repo now only keeps shell-level rules (iOS input-zoom fix, safe-area scroll padding, horizontal-scrolling code) — layout rules (44px targets, dialogs, composer chrome) moved to the interface half, see "Division of labor" below — desktop never affected |
| 🔒 **Desktop unaffected** | Every rule is rooted at `html:not([data-lan-device="desktop"])` (or an `@media(max-width:820px)` with the same exclusion) — an explicit "desktop" kind opts out, everything else (including a real phone's default "auto" kind) opts in |
| 🛡️ **Admin surface is local-only** | Generating pairing codes, managing devices, triggering pushes — these endpoints only accept direct local connections; anything arriving through the proxy gets 403 |

---

## Architecture

```
Public device (phone/laptop) --HTTPS--> your own reverse proxy (nginx/Caddy, terminates TLS)
                                                │  HTTP + X-Forwarded-For/Proto
                                                ▼
                            gateway (isolated Node child · listens on 127.0.0.1:3088 by default)
                                                │
              ┌──────────────────────────────────┼───────────────────────────────────┐
              │                                  │                                    │
       unpaired device                   paired device (has lg_device token cookie)    direct-local request (no X-Forwarded-*)
       → any path redirects to               → reverse-proxied to DSH Web UI               → admin page / admin API / push trigger
         the pairing page,                     (127.0.0.1:3080); HTML injected:                /lan-gate/admin /status
         POST code -> token                    manifest + PWA bootstrap +                      /action /pair /pwa/push/send
                                                touch CSS + randomUUID polyfill
```

- The gateway is an isolated child process: if it crashes, DSH's main service is unaffected; it's torn down automatically when the plugin stops.
- DSH's own web server still binds `127.0.0.1` only. The gateway never touches DSH's config or its `/api` trust fence.
- The one IP-based trust left: a loopback socket carrying **no** `X-Forwarded-*` headers is treated as the local user sitting at this machine — the only path into the admin surface. Requests that came through the proxy always carry forwarded headers, so they can never look local.

---

## Division of labor with the interface half

Inside this single plugin, the boundary between the two halves is: **this repo only owns the shell and the channel** (pairing auth, tokens, rate limiting, the PWA install manifest, the service worker, first-frame safe-area injection); **all layout — typography, dialogs, composer chrome, bubble styling — belongs to the interface half**.

`pwa/app.css` was trimmed from 163 lines down to 95, keeping only shell-level rules. A stale inline `DEVICE_CSS` copy left inside the gateway (`lib/lan-gate-server.cjs`) went further than that — one of its rules stretched *any* `role="dialog" aria-modal="true"` overlay to fill the viewport, including the interface half's own session-info card, which is why it used to overflow the screen only when accessed through the gateway. That dead copy has been removed entirely. Pull-to-refresh and edge-swipe-back have also been removed from this repo's `touch-gestures.js`: the former kept firing full-page reloads on an accidental overscroll, and the latter's `history.back()` was always a no-op against DSH's own client-side routing — the interface half's own left-edge swipe gesture now owns that 24px hot zone instead. Pinch-to-resize stays here.

---

## Quick start

### 1. Install the plugin

```bash
dsh plugin --profile web add github:KyoMio/the gateway half
```

The package declares a `dsh.bundle` manifest; restart `dsh web` after installing.

Local-directory install (for hacking on the code yourself):

```bash
git clone https://github.com/KyoMio/the gateway half.git
cd the gateway half
dsh plugin --profile web add ./the gateway half
```

Static mount is also available (see [`cordis.patch.yml.example`](../cordis.patch.yml.example) — swap in the absolute checkout path) or dynamic-plugin mount (see the header comment in `lan-gate.mjs`), for setups that skip `dsh plugin add`.

### 2. Put your own reverse proxy in front

The gateway listens on `127.0.0.1:3088` only by default — it will not expose itself to the public internet on its own. To reach it from a phone or another computer, run a reverse proxy somewhere that can see the gateway, have it terminate HTTPS, and forward to the gateway. Both configs below are meant to be copy-pasted as-is.

#### nginx

```nginx
# Put this once inside the http {} block; every server{} below can reuse it
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name dsh.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name dsh.example.com;

    ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3088;
        proxy_http_version 1.1;

        # WebSocket upgrade — required by the DSH Web UI
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # The gateway relies on these two headers to identify the real client
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Recommended for long-lived/streaming responses so nothing gets buffered away
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

#### Caddy

Caddy handles HTTPS certificate issuance, WebSocket forwarding, and forwarded headers automatically — one `reverse_proxy` line is enough:

```
dsh.example.com {
    reverse_proxy 127.0.0.1:3088
}
```

> Proxy and gateway not on the same host (e.g. the proxy runs in another container/server)? The gateway only trusts `X-Forwarded-For` coming from a loopback socket by default — add the proxy's egress IP to `LAN_GATE_TRUSTED_PROXIES` (see the env var table below).

#### Lucky

[Lucky](https://github.com/gdy666/lucky) is a popular all-in-one public-access toolbox on Chinese routers/NAS boxes (DDNS + ACME certs + reverse proxy; admin UI defaults to `http://<device-ip>:16601`). Prerequisite: set up your domain's DDNS and certificate in Lucky's DDNS and security-certificate modules first (ACME auto-renews). Then:

1. **Web Service → add a web-service rule**: listen on `443`, enable TLS and attach your domain's certificate.
2. **Add a sub-rule** under it: service type "reverse proxy", frontend address = your domain (e.g. `dsh.example.com`), backend address depending on your layout:
   - Lucky and DSH on the **same machine**: `127.0.0.1:3088`, zero gateway-side config.
   - Lucky on a **router/NAS** (the common case): use `<DSH-machine-LAN-IP>:3088`, and set two env vars on the gateway — `LAN_GATE_HOST=0.0.0.0` (so Lucky can reach it; other LAN devices still only ever see the pairing page) and `LAN_GATE_TRUSTED_PROXIES=<Lucky-device-LAN-IP>` (so the gateway trusts its forwarded headers).
3. **Turn on the sub-rule's 万事大吉 ("all is well") switch** — it auto-adds the common request headers including `X-Forwarded-For`. **On a same-machine deployment this switch is part of the security boundary**: without it, requests arriving through Lucky come from loopback with no forwarded headers and get treated as the local user — exposing the admin surface to the internet. With it on, the problem doesn't exist.
4. WebSocket passes through automatically, no extra setting; if the conversation stream stalls, upgrade Lucky first.

> Exact toggle names may vary slightly across Lucky versions — the three things that matter: HTTPS cert, reverse proxy to 3088, forwarded headers (万事大吉).

#### Post-setup self-check (do this for any proxy)

From **cellular data** (not your home Wi-Fi), open `https://your-domain/lan-gate/admin` — the correct result is **403**. If you can see the admin page, your proxy is not sending `X-Forwarded-*` headers and the gateway mistook a public request for the local user — **go fix the header config immediately** (nginx: the two `proxy_set_header` lines; Lucky: the 万事大吉 switch). Only start pairing devices after this check passes.

### 3. Generate a pairing code and pair devices

1. With the proxy in place, open `http://127.0.0.1:3088/lan-gate/admin` in a browser **on the host itself**.
2. Click "generate pairing code" to get an 8-character code, valid for 10 minutes, single-use.
3. On the phone or another computer, open your proxy's HTTPS domain in a browser — you'll land on the pairing page. Enter the code (device name is optional).
4. On success you're dropped straight into the DSH Web UI (PWA-injected); identity is stored in a long-lived cookie, so switching Wi-Fi/IP never logs you out.
5. On the phone, use the browser menu's "Add to Home Screen" to get a standalone app.
6. The page will prompt you to enable "agent-done push" — grant notification permission and you'll get a system notification when the agent finishes, even from another app.

The admin page also lets you set a device's kind (phone / desktop / auto layout), rename it, and revoke a single device or all of them at once.

---

## Environment variables

| Variable | Default | What |
| --- | --- | --- |
| `LAN_GATE_PORT` | `3088` | Gateway listen port; on `EADDRINUSE` it retries up the port range (up to +20) |
| `LAN_GATE_HOST` | `127.0.0.1` | Gateway listen address. Leaving the default in place plus a reverse proxy is the recommended setup — only change this if you know exactly what you're doing |
| `LAN_GATE_TARGET_PORT` | `3080` | Local DSH Web UI port the gateway reverse-proxies to |
| `LAN_GATE_RATE_LIMIT` | `120` | Per-real-client-IP per-minute cap **for unpaired/unauthenticated requests only** (protects the pairing surface). Local users and paired devices are exempt — their guardrail is the token + revocation |
| `LAN_GATE_TRUSTED_PROXIES` | empty | Comma-separated IP list. When the proxy and gateway aren't on the same host (i.e. not a loopback socket), list the proxy's egress IP here so the gateway trusts the `X-Forwarded-For`/`X-Forwarded-Proto` it sends |
| `LAN_GATE_VAPID_SUBJECT` | `mailto:admin@localhost` | VAPID contact for Web Push. **Set this to a real mailto: address or https:// URL**: Apple rejects placeholder subjects with `403 BadJwtToken`, silently killing push to every iOS device (Google/Mozilla do not check). The gateway warns at startup if it looks invalid |

Besides env vars, the **recommended way is the config file** `~/.dsh/lan-gate.config.json` (shared by the gateway and the push plugin; restart `dsh web` after editing; explicit env vars win over the file):

```json
{
  "host": "0.0.0.0",
  "trustedProxies": "192.168.3.2",
  "rateLimit": 600,
  "pushSummary": true
}
```

Field names = env var names minus the prefix, camelCased: `port` / `host` / `targetPort` / `rateLimit` / `trustedProxies` / `vapidSubject`, plus the push half `pushEvents` / `pushDebounceMs` / `pushSummary` / `pushTool` (the `push_notify` tool switch, defaults to `true`). On DSH versions whose insert rows support Cordis config, the same camelCase fields under the row's `config:` work too.

The optional push host plugin mounts via the profile patch (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: the gateway half-push
      name: the gateway half/dsh-push.mjs
```

---

## Admin API

All of the following endpoints are **local-direct-connection only**: the request's socket must be a loopback address and carry no `X-Forwarded-*` headers at all. Anything that came through the proxy (which always carries forwarded headers) gets 403 — the public internet can never reach these.

| Endpoint | Method | What | Params |
| --- | --- | --- | --- |
| `/lan-gate/pair` | POST | Generate a new one-time pairing code (valid 10 minutes) | none |
| `/lan-gate/status` | GET | Read running state, the current pairing code, the list of paired devices | none |
| `/lan-gate/action` | POST | Manage a device | `action`: `set-kind` / `rename` / `revoke` / `revoke-all`; `id`: device id (not needed for `revoke-all`); `set-kind` also needs `kind` (`phone`/`desktop`/`auto`); `rename` also needs `name` |
| `/pwa/push/send` | POST | Send one push to every subscribed device | `title`, `body` (plain text, no conversation content) |

The exception is `/lan-gate/pair/claim` (POST) — the one endpoint reachable from anywhere, since it's how a device redeems the pairing code for a token in the first place. It's protected by the code itself (single-use, 10-minute TTL) and a failure lockout (5 wrong codes locks that IP for 15 minutes), not by local identity.

---

## Push notes

- The VAPID key pair is generated automatically on first boot and persisted to `~/.dsh/lan-gate-state.json` (override the directory with `DSH_HOME`); the public key is delivered to the page via the injected bootstrap script.
- `/pwa/push/subscribe` requires a valid device token cookie (i.e. the device must already be paired); each device gets at most one subscription, capped at 20 total, to keep strangers from spamming your server with subscriptions or using it to fire requests elsewhere.
- Push payloads carry only a title and a short body line (e.g. "DSH task complete") — **never any conversation content**. Delivery is standard Web Push (VAPID-signed, aes128gcm-encrypted); only the push service and your browser ever see the plaintext.
- Revoking a device deletes its push subscription too; a 404/410 from the push endpoint (expired subscription) gets it auto-cleaned on the next send.
- Mobile browsers require HTTPS before they'll register a service worker at all, so both push and offline support depend on step 2's reverse proxy — neither works on a real device until HTTPS is in place.
- The "notify when the agent finishes" wiring lives in the optional host plugin `dsh-push.mjs`: it listens on the DSH event bus and calls the local `/pwa/push/send`. Event names come from `DSH_PUSH_EVENTS` (comma-separated); the default `agent/turn-stopping` is the official turn-close checkpoint (fires once per turn when the model owes no response and no tool calls are live). Override the env var if your DSH version names it differently. `DSH_PUSH_DEBOUNCE_MS` (default 15000) sets the minimum gap between notifications. Want the turn's outcome in the notification body? Set `DSH_PUSH_SUMMARY=1` and the body becomes the turn's final assistant message (truncated to 120 chars). The push payload is aes128gcm-encrypted end to end — Google/Apple push servers only ever see ciphertext; the remaining exposure is your own lock screen / notification center (both OSes can hide notification content on the lock screen if that matters to you). You can also skip the plugin entirely and trigger pushes yourself: `curl -X POST http://127.0.0.1:3088/pwa/push/send -H 'Content-Type: application/json' -d '{"title":"DSH task complete"}'`.
- "The model pushes on its own" is the same `dsh-push.mjs` additionally registering a model tool, `push_notify` (`title` required, `body` optional), over the same encrypted `/pwa/push/send` path. It only shows up when the host has a tool registry (`ctx.tools`) and hasn't disabled it; `pushTool: false` in `lan-gate.config.json` (or `DSH_PUSH_TOOL=0`) turns it off entirely. Rate limiting is independent from the turn-close notifier above: at most 1 push per session per 60 seconds, 20 total per hour across all sessions — over the limit, the call is silently skipped (not sent, not an error), so a chatty model can't turn your phone into a notification firehose.

---

## Security boundary

**What's covered:**
- Pairing-code brute force — the code is single-use with a 10-minute TTL, and 5 wrong attempts locks that source IP for 15 minutes.
- Revocable tokens — lost phone, lent-out device, one click on the admin page and it stops working immediately.
- Request volume — rate-limited per resolved real client IP, 120/min by default, 429 past that.
- The admin surface is local-only — generating pairing codes, managing devices, triggering pushes: all local-direct-connection only, and anything through the proxy (always carries forwarded headers) gets 403.

**What's not covered — your responsibility:**
- A misconfigured reverse proxy — e.g. accidentally exposing `127.0.0.1:3088/lan-gate/admin` on the public domain too, or a wrong `X-Forwarded-Proto` making the gateway misjudge the client's protocol. These are configuration mistakes the gateway can't defend against.
- A stolen or shared token — this is a single-user tool; the token is equivalent to full access, with no finer-grained permission tiers. Whoever has the token can use it — if you suspect a leak, revoke it and re-pair from the admin page.
- DSH's own capability boundary — the gateway only forwards HTTPS traffic to DSH safely; it can't and doesn't add security measures DSH itself doesn't have (DSH's own `/api` trust fence is DSH's concern).
- The state file `~/.dsh/lan-gate-state.json` stores the VAPID private key and every device's token in plaintext — this file *is* full access to your gateway. Mind its file permissions on the host, and don't sync `~/.dsh` into a shared drive or an untrusted backup location.

---

## Known issue: iOS 26.x viewport shrink

On iOS 26.x, once DSH is added to the home screen and opened as a standalone PWA, the layout viewport loses a chunk of its bottom edge (measured on one iPhone on 26.5: 852px screen vs. 793px viewport — exactly one status-bar's worth) from cold start onward, until the app is fully quit and reopened. The same URL in a plain Safari tab is unaffected.

This is not a bug in this plugin — it's a known iOS 26.x system defect (the layout viewport permanently shrinks the first time the on-screen keyboard is shown inside a standalone PWA; `innerHeight`, `visualViewport.height` and `100dvh` all shrink together). The missing strip sits outside the document, so no stylesheet can reach it — only the system paints it, using the manifest's `background_color`. This repo changed that value to a light `#f9fafb` (matching the interface half's light theme background) so the dead strip blends into the page instead of standing out as a dark bar.

That's a visual mitigation, not a fix: in dark theme the strip is actually more visible (the manifest color can't follow the page theme), and it's also the launch-splash color, so the splash went from dark to light. The underlying shrink can only be fixed by Apple. the interface half applies two further mitigation layers (detection + an active reflow "heal") on its own side — see that plugin's README for details.

---

## FAQ

**Upgrading from an older version — what do I need to do?**
The old model approved devices by source IP, which is meaningless under the new token model. The first time the gateway starts with the new version, it detects the old state file and renames it to `lan-gate-state.json.v1.bak` (no data migration). Every device needs to go through pairing again.

**The pairing code says expired or wrong — now what?**
Codes are valid for 10 minutes and single-use — once expired or already used, go back to the local admin page and generate a new one. Five wrong codes in a row locks that source IP for 15 minutes; wait it out or try from a different network.

**Not receiving push notifications?**
Check in order: is the phone accessing an HTTPS domain (over plain HTTP the browser never registers a service worker, so push has nothing to run on)? Has the browser or the OS denied notification permission for this PWA? Check the local admin surface (`/lan-gate/status`) to see whether that device shows the 🔔 marker, confirming the subscription actually succeeded.

---

## Test locally

```bash
npm test   # boots a mock upstream, runs the gateway/auth/push suites: proxy+injection, pairing flow, push delivery
```

---

## Layout

| Path | Role |
| --- | --- |
| `lan-gate.mjs` | Cordis entry: spawns the gateway child process and manages its lifecycle |
| `dsh-push.mjs` | Optional agent-done push host plugin, calls the gateway's local `/pwa/push/send`; also registers the `push_notify` model tool |
| `lib/lan-gate-server.cjs` | The gateway itself: single-file CommonJS (Node stdlib + one runtime dependency, `web-push`) — HTTP/WebSocket reverse proxy, pairing/tokens, rate limiting, PWA injection, Web Push |
| `pwa/manifest.json` | PWA install manifest |
| `pwa/sw.js` | Service worker (offline caching + push notifications) |
| `pwa/inject.js` | Injected page bootstrap: SW register, gesture loader, push subscribe |
| `pwa/touch-gestures.js` | Edge-swipe back / pinch-zoom |
| `pwa/app.css` | Mobile touch-first CSS (`data-lan-device`-prefixed, desktop unaffected) |
| `pwa/offline.html` | Offline fallback page |
| `pwa/icons/` | SVG source + rasterized PNGs (192/512 + maskable) |
| `cordis.patch.yml` / `.example` | Bundle patch layer / static-mount example |
| `docs/spec-public-auth-push.md`, `docs/plan-public-auth-push.md` | Design spec and implementation plan for this rework |
| `test/gateway.test.cjs` | Smoke tests: gateway boot, `/pwa` asset serving, HTML injection |
| `test/auth.test.cjs` | Pairing flow, tokens, lockout, v1-state archival, survives restart |
| `test/push.test.cjs` | Push subscribe/send, VAPID encryption, expired-subscription cleanup |
| `test/util.cjs` | Shared test harness (boot/request/pair helpers) — not a test file itself |

See [`AGENTS.md`](../AGENTS.md) for development conventions.

---

## Changelog

### v0.3.0

**Added**

- Clear division of labor with the interface half: layout rules handed off entirely, this repo keeps only shell-level CSS (see "Division of labor" above);
- Service worker bumped to v3: cache strategy changed from "shell and client assets both stale-while-revalidate" to "only the static shell is cache-first, everything else is network-first" — a new deploy is picked up immediately instead of leaving stale CSS behind across devices;
- First-frame HTML now carries `viewport-fit=cover` directly, so a standalone PWA's safe area is correct from the very first frame instead of waiting for the client bundle to patch it in;
- `dsh-push.mjs` adds a model tool, `push_notify`: the agent can decide for itself that a push is warranted (needs a decision, hit a key milestone, needs a human after an error) and fire it mid-task instead of waiting for the whole turn to close. Same aes128gcm-encrypted channel; host-side rate limiting (1/60s per session, 20/hour globally) and the `pushTool` switch (`lan-gate.config.json`) are independent of the existing turn-close auto-push.

**Fixed**

- Manifest and icons are now credential-less (no longer stuck behind the pairing wall) — this used to hide the install prompt on Android/desktop Chrome, with iOS Safari the accidental exception since it sends cookies on that fetch anyway;
- The gateway now strips an upstream manifest `<link>` tag that used to shadow the gateway's own mobile-tailored manifest (browsers only honor the first manifest link);
- Service worker registration now declares `scope: '/'` plus a `Service-Worker-Allowed: /` response header — previously its default scope was only `/pwa/` and it never actually controlled the app;
- Removed the gateway's dead inline `DEVICE_CSS` copy, whose fullscreen-dialog rule used to stretch the interface half's session-info card off-screen — long misdiagnosed as an iOS/Chromium engine difference;
- CSS/gesture gating switched from the literal `"phone"` value to "not desktop" — a real paired device defaults to kind `"auto"`, so the old gate never actually fired on a real phone;
- Removed pull-to-refresh (an accidental overscroll used to fire a full reload mid-conversation); removed edge-swipe-back, handing that 24px zone to the interface half's own gesture (the old handler was a no-op against DSH's client-side routing anyway);
- `manifest.json`'s `background_color` switched to a light color as a visual mitigation for the iOS 26.x standalone-PWA viewport shrink dead strip (known OS defect, not a fix — see "Known issue" above).

**Internal**

- `pwa/app.css` trimmed from 163 to 95 lines; added `test/sw.test.cjs` covering the service worker's new cache strategy.

---

## Security

Installing a plugin runs third-party code with your own permissions; being listed or published is not a security review. The gateway listens on `127.0.0.1` only by default and will not expose itself to the public internet on its own — every public-facing path must go through a reverse proxy you configure and that terminates TLS yourself. Run this only on your own server, keep the state file out of untrusted locations, and audit changes to `lib/lan-gate-server.cjs`.

## License

MIT. The gateway `lib/lan-gate-server.cjs` extends `dsh-mobile-gate`; original MIT copyright/license retained — see [LICENSE](../LICENSE).
