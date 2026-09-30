<h1 align="center">Remote access (gateway half)</h1>
<p align="center">Turn DeepSeek Harness into a mobile PWA you can safely reach from the public internet: pairing-code auth + token identity + real Web Push, with your own reverse proxy terminating TLS — plus device roles and the remote relay that serves paired desktop clients.</p>

> Full documentation for the gateway half of `dsh-zen-remote`: reverse proxy, device roles and pairing, environment variables, admin API, the remote relay, push, security boundary.
> Installation and quick start live in the [root README](../README.md); interface-side detail in [interface.md](interface.md) (Chinese).

Built on the MIT [dsh-mobile-gate](https://github.com/Bernardxu123/dsh-mobile-gate) secure-gateway base, with PWA differentiation.

---

## Features

| Module | What |
| --- | --- |
| 🔑 **Public-internet identity** | The gateway listens on `127.0.0.1` only, sitting behind your own reverse proxy. New devices trade a pairing code for a long-lived device token (cookie `lg_device` for web devices, a JSON token for desktop clients) — identity follows the token, not the source IP |
| 👥 **Device roles** | A pairing code is minted for one role: **web app device** (phones/tablets/browsers through the gateway, see all sessions) or **desktop app device** (another DSH desktop running this plugin as the client role — relay prefix only, shared sessions only). A code offered to the wrong channel is refused with a clear message, not consumed |
| 📡 **Remote relay** | Desktop clients talk to the host over zen-remote's own relay protocol (HTTP invokes + NDJSON stream subscriptions); the server re-verifies session ownership per request against a per-method allowlist — data of an unshared session never leaves the box |
| 📱 **Real PWA** | `manifest.json` + service worker: once the proxy provides HTTPS, "Add to Home Screen" actually works — standalone full-screen app with icon, splash, theme-color, maskable assets |
| 🌐 **Offline** | SW v3: only the true static shell (manifest/icons/offline page) is cache-first, everything else (DSH client bundle JS/CSS, API, page HTML) is network-first — a new deploy is picked up immediately instead of lingering behind stale cached CSS |
| 👆 **Touch gestures** | Pinch-to-resize font (resettable); edge-swipe-back has been handed off to the interface half (see "Division of labor" below), pull-to-refresh has been removed entirely (an accidental overscroll used to fire a full reload mid-conversation) |
| 🔔 **Push when you're actually needed** | Real Web Push (VAPID-signed, aes128gcm-encrypted). By default it fires only when something is genuinely waiting on you: a tool needs authorization, or the model asked you a question. Plain turn-end is opt-in (`DSH_PUSH_TURN_END=1`). The notification carries no conversation content unless you ask for it |
| 🛎️ **`push_notify` tool** | A model-callable push tool (registered by the push half): the model can decide mid-task that the user needs a decision, that a key milestone was reached, or that an error needs a human — and push straight to the lock screen instead of waiting for the turn to end. Usage discipline (don't call this often) is spelled out in the tool description; the host also enforces it with rate limits (max 1 per 60s per session, 20/hour globally) — over the limit, the call is silently dropped, never an error. Same aes128gcm end-to-end encryption, same lock-screen-only exposure. Turn it off entirely with `pushTool: false` (or `DSH_PUSH_TOOL=0`); it's also skipped automatically on hosts without a tool registry (`ctx.tools`), with no effect on the rest of the plugin |
| 📐 **Touch layout** | This repo now only keeps shell-level rules (iOS input-zoom fix, safe-area scroll padding, horizontal-scrolling code) — layout rules (44px targets, dialogs, composer chrome) moved to the interface half, see "Division of labor" below — desktop never affected |
| 🔒 **Desktop unaffected** | Every rule is rooted at `html:not([data-lan-device="desktop"])` (or an `@media(max-width:820px)` with the same exclusion) — an explicit "desktop" kind opts out, everything else (including a real phone's default "auto" kind) opts in |
| 🛡️ **Admin surface is local-only** | Generating pairing codes, managing devices, triggering pushes — these endpoints only accept direct local connections; anything arriving through the proxy gets 403. Since 2.0.0 they are driven from the dsh-zen-remote settings block in the DSH Plugins page (the plugin backend calls them as the local machine); the `/lan-gate/admin` page is now just a notice pointing there |

---

## Architecture

```
Public device (phone/laptop) --HTTPS--> your own reverse proxy (nginx/Caddy, terminates TLS)
                                                │  HTTP + X-Forwarded-For/Proto
                                                ▼
                            gateway (isolated Node child · listens on 127.0.0.1:3088 by default)
                                                │
              ┌───────────────────┬─────────────┴────────────┬──────────────────────────────┐
              │                   │                           │                              │
       unpaired device      web app device (paired)     desktop app device (paired)     direct-local request
       → any path redirects   → forwarded to DSH (auto-    → relay prefix only            (no X-Forwarded-*)
         to the pairing page    discovered real port)      /_dsh/zen-remote/relay/*      → admin API / push trigger
         POST code -> token     with device marker headers  with marker headers +        /lan-gate/status /action /pair
                              + bearer shared secret;       the shared secret             /pwa/push/send
                                any other path 403s
```

- The gateway is an isolated child process: if it crashes, DSH's main service is unaffected; it's torn down automatically when the plugin stops. If the main process itself dies without a normal shutdown (crash, `kill -9`), the child checks the parent's liveness every 5 seconds and exits on its own once it is gone, instead of squatting on the port.
- DSH's own web server still binds `127.0.0.1` only. The gateway never touches DSH's config or its `/api` trust fence; the forward target port is discovered from the host's real listening port (desktop builds use a configurable one).
- The one IP-based trust left: a request is treated as the local user sitting at this machine — the only path into the admin surface — only when the socket is loopback, **no** `X-Forwarded-*` header is present, **and** the `Host` header, with the port stripped, is exactly `127.0.0.1` / `localhost` / `[::1]`. Requests that came through the proxy always carry forwarded headers, so they can never look local. The Host check is what blocks DNS rebinding: when an attacker's own domain resolves to 127.0.0.1, the request may still arrive over loopback, but its Host is not a loopback name and it never reaches the admin surface. **Mind the flip side**: in same-machine testing the client must reach the gateway over a LAN IP — a loopback address is treated as local-direct and skips token checks entirely.

---

## Division of labor with the interface half

Inside this single plugin, the boundary between the two halves is: **this repo only owns the shell and the channel** (pairing auth, tokens, rate limiting, the PWA install manifest, the service worker, first-frame safe-area injection); **all layout — typography, dialogs, composer chrome, bubble styling — belongs to the interface half**.

`pwa/app.css` was trimmed from 163 lines down to 95, keeping only shell-level rules. A stale inline `DEVICE_CSS` copy left inside the gateway (`lib/lan-gate-server.cjs`) went further than that — one of its rules stretched *any* `role="dialog" aria-modal="true"` overlay to fill the viewport, including the interface half's own session-info card, which is why it used to overflow the screen only when accessed through the gateway. That dead copy has been removed entirely. Pull-to-refresh and edge-swipe-back have also been removed from this repo's `touch-gestures.js`: the former kept firing full-page reloads on an accidental overscroll, and the latter's `history.back()` was always a no-op against DSH's own client-side routing — the interface half's own left-edge swipe gesture now owns that 24px hot zone instead. Pinch-to-resize stays here.

---

## Quick start

### 1. Install the plugin

```bash
dsh plugin add dsh-zen-remote
```

The package declares a `dsh.bundle` manifest with a single row; restart DSH (the desktop app, or `dsh web`) after installing. Desktop-profile and manual install steps live in the [root README](../README.md#install).

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

#### Cloudflare Tunnel — getting in without a public IP

When your ISP won't hand you a public IP, or you'd rather not open a port on the router, use a Cloudflare Tunnel: `cloudflared` opens a long-lived connection **outbound** from your machine, Cloudflare handles DNS, the TLS certificate and the public entry point, and requests come back down that connection to `127.0.0.1:3088` on your box. Not a single router port is opened and your home IP is never exposed. The free tier is enough.

There is exactly one prerequisite: the domain is hosted on Cloudflare (nameservers pointed at it).

**Zero gateway-side changes**: leave `LAN_GATE_HOST` at its `127.0.0.1` default — `cloudflared` runs on the same machine.

##### Option A: the Zero Trust dashboard token flow (recommended)

The tunnel config lives on Cloudflare's side and the machine only stores a token, so you never have to touch the machine to change it.

1. Open the [Zero Trust dashboard](https://one.dash.cloudflare.com/) → **Networks → Tunnels → Create a tunnel** → pick **Cloudflared** and name it.
2. Once created, the page hands you an install command with a token. Run it on the machine running DSH:

   ```sh
   cloudflared service install eyJhIjoi...your-token
   ```

   That installs `cloudflared` as a service that starts at boot. On macOS, `brew install cloudflared` first; on Debian/Ubuntu use the official `.deb`.

3. Back on the tunnel's detail page → **Public Hostname** → **Add a public hostname**:

   | Field | Value |
   | --- | --- |
   | Subdomain | `dsh` |
   | Domain | `example.com` |
   | Path | leave empty |
   | Service Type | `HTTP` |
   | URL | `127.0.0.1:3088` |

   It takes effect on save; Cloudflare creates the DNS record and issues the certificate for you.

4. Skip straight to the next section and do the 403 self-check.

##### Option B: CLI plus config.yml (advanced)

Use this when you want the tunnel config in version control too, or when one tunnel fronts several services:

```sh
cloudflared tunnel login                      # authorize the domain in a browser; certs land in ~/.cloudflared/
cloudflared tunnel create dsh                 # note the <TUNNEL-ID> in the output
cloudflared tunnel route dns dsh dsh.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-ID>
credentials-file: /home/you/.cloudflared/<TUNNEL-ID>.json

ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:3088
  - service: http_status:404          # catch-all, must be last
```

```sh
cloudflared tunnel run dsh            # prove it works in the foreground first
sudo cloudflared service install      # then install it as a service
```

##### Why the self-check matters even more with a tunnel

`cloudflared` connects to the gateway over **local loopback**, which means the socket the gateway sees always originates at `127.0.0.1`. What separates "a visitor from the internet" from "the person sitting at this computer" is whether the request carries `X-Forwarded-*` headers (see `isLocalDirect` in `lib/lan-gate-server.cjs`: any forwarded header at all means this is definitely not the local user). `cloudflared` sends `X-Forwarded-For` and `X-Forwarded-Proto` by default, so the pairing wall works — but **if your version or one of your ingress rules strips them, public requests get treated as the local admin and the admin page is served straight to the internet**. The same risk exists for a same-machine nginx/Caddy deployment (Lucky's 万事大吉 switch is exactly this), it's just easier to miss with a tunnel because you never hand-wrote a single line of forwarded-header config.

**You do not need `LAN_GATE_TRUSTED_PROXIES=127.0.0.1`**: the gateway's `resolveClient()` already treats a loopback connection as a trusted proxy (`isLoopbackIp(sockIp) || TRUSTED_PROXIES.indexOf(sockIp) >= 0`), so setting it to `127.0.0.1` is a no-op — it neither errors nor changes any behaviour, and more importantly it is **not** a substitute for the self-check below. This semantic is pinned by tests (the two `same-host tunnel:` cases in `test/auth.test.cjs` — identical results with and without it). There is exactly one situation that calls for `LAN_GATE_TRUSTED_PROXIES`: the proxy or tunnel process is **not** on this machine (a router, another server), where the source IP isn't loopback and the gateway needs it listed before it will trust the forwarded headers it brings.

##### Common traps

- **`Error 1033` / tunnel offline**: `cloudflared` isn't running, or the token expired. `cloudflared tunnel info <name>` shows the connection count; `sudo launchctl list | grep cloudflared` (macOS) or `systemctl status cloudflared` (Linux) shows the service.
- **502 Bad Gateway**: the tunnel is up but the origin isn't reachable — either the gateway isn't running, or the Public Hostname URL says `3080` (DSH itself) instead of `3088` (the gateway). Pointing it at 3080 bypasses the entire pairing wall, i.e. **puts DSH bare on the internet**; make sure it says 3088.
- **The conversation stream stalls / messages never appear**: WebSockets aren't getting through. Cloudflare's free tier supports them, so usually there's an Access policy on that hostname in Zero Trust blocking the upgrade request, or `disableChunkedEncoding` in the ingress rule.
- **Large uploads fail**: Cloudflare's free tier caps a request body at 100MB. This plugin's 20MB upload default sits below that, so you shouldn't hit it; for genuinely larger files, raise the Cloudflare plan before raising `maxUploadBytes`.
- **Want one more layer**: you can add an Access policy for this hostname in Zero Trust → Access (email OTP or similar) stacked in front of the pairing code. Not required — the pairing wall is already an authentication step.

#### Post-setup self-check (do this for any proxy)

From **cellular data** (not your home Wi-Fi), open `https://your-domain/lan-gate/admin` — the correct result is **403**. If you can see the admin page, your proxy is not sending `X-Forwarded-*` headers and the gateway mistook a public request for the local user — **go fix the header config immediately** (nginx: the two `proxy_set_header` lines; Lucky: the 万事大吉 switch; Cloudflare Tunnel: see the previous section). Only start pairing devices after this check passes.

### 3. Generate a pairing code and pair devices

Since 2.0.0 pairing codes are minted from the dsh-zen-remote settings block in the DSH Plugins page (the old `/lan-gate/admin` page is just a notice pointing there, still local-direct-only):

1. With the proxy in place, open the DSH Plugins page **on the host machine** and expand the dsh-zen-remote settings block.
2. Pick the device role (web app device / desktop app device) and click generate — an 8-character code, valid for 10 minutes, single-use. **The code is bound to the role**: a web-device code offered to the desktop channel is refused and vice versa; a wrong-channel code is neither consumed nor counted toward the lockout.
3. Web app device: on the phone or another computer, open your proxy's HTTPS domain in a browser — you'll land on the pairing page. Enter the code (device name is optional).
4. Desktop app device: in the other computer's DSH desktop app, open the plugin settings block, switch the role to **client**, and enter the server URL plus the code. The URL must be `https://` unless it is a private-network host — LAN ranges (`192.168.x`, `10.x`, `172.16–31.x`), Tailscale/CGNAT (`100.64.x`), loopback, `localhost` / `*.local`, or IPv6 `::1` / `fc00::/7` / `fe80::/10`.
5. On success a web device is dropped straight into the DSH Web UI (PWA-injected); identity is stored in a long-lived cookie, so switching Wi-Fi/IP never logs you out.
6. On the phone, use the browser menu's "Add to Home Screen" to get a standalone app.
7. The page will prompt you to enable "agent-done push" — grant notification permission and you'll get a system notification when the agent finishes, even from another app.

The settings block can also rename devices, change a device's role (`set-role`), and revoke one or all. Revocation is immediate: the device's open connections and push subscription die with it. Desktop-client devices can never reach any admin endpoint — the gateway only ever forwards them into the relay prefix; every other path (including DSH pages and `/api`) gets 403 (`reason: 'relay-only'`).

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
| `LAN_GATE_LANG` | `auto` | Language of the pages the gateway serves itself (pairing, rate-limit, admin) and of the push opt-in card it injects into the app. `auto` follows the request's `Accept-Language` — the only language signal a pairing visitor ever volunteers; with no such header it falls back to Chinese. `zh`/`en` pin it and ignore the browser |
| `LAN_GATE_RELAY_SECRET` | *(auto-generated)* | The relay shared secret: since 2.0.0 it is how a desktop client's forwarded request proves to the host's relay routes that the marker headers were written by this gateway. **Minted fresh by the plugin on every load** of the main entry (32 random bytes handed to the gateway child through the environment, unconditionally overwriting) and **not externally settable** — a value hand-placed in the host environment is overwritten or deleted at child startup; when the plugin doesn't supply one (client role, standalone load) the header feature is off and the gateway stamps nothing |
| `DSH_PUSH_LANG` | `zh` | Language of the notification copy itself (approval pending / question pending / turn finished). Since 2.0.0 it is an env override over the settings `lang`; with neither set the copy is Chinese. Deliberately **not** autodetected: a notification is produced host-side, where there is no request header and launchd hands the process no `LANG` (`Intl` reports `en-US` even on a Chinese user's machine). Set `en` explicitly for English |

Besides env vars, **the recommended surface is the dsh-zen-remote settings block in the DSH Plugins page** (the full field table lives in the root README); the legacy `~/.dsh/lan-gate.config.json` keeps working. Per field the first legal value wins in this order: **environment variable > plugin row settings > `lan-gate.config.json` > default** — a value that fails its field's check makes that layer transparent (a hand-edited `port: "abc"` surfaces the file's port, not an error). File keys = env var names minus the prefix, camelCased:

```json
{
  "host": "0.0.0.0",
  "trustedProxies": "192.168.1.2",
  "rateLimit": 600,
  "pushSummary": true
}
```

The push half adds `pushTurnEnd` / `pushEvents` / `pushDebounceMs` / `pushSummary` / `pushTool`. Language is a single shared key, `lang`: the gateway understands `auto` (follow the browser) / `zh` / `en`, the push half understands only `en` and treats everything else as Chinese — so `"lang": "auto"` means "pages follow the browser, notifications stay Chinese". Two more keys live outside the settings surface: `pushApprovalGraceMs` (env `DSH_PUSH_APPROVAL_GRACE_MS`). The 2.0 fields `role` (`host`/`client` — the one 2.0 field the file layer also reads), `serverName`, `idleHours`, `autoShareNewSessions`, `serverUrl` and `deviceToken` come from the settings page or the plugin row, not this file.

Saving a field that needs a gateway/push restart (`role`, `port`, `host`, `targetPort`, `rateLimit`, `trustedProxies`, `vapidSubject`, `lang`, and the push fields) makes the plugin detect the change and reload its own row — the gateway child restarts with it, no app restart needed.

Since 2.0.0 the gateway and the push half **no longer take one row each**: the package's own `cordis.patch.yml` mounts a single `dsh-zen-remote` row, and the main entry loads the two sub-plugins itself with `ctx.plugin()`, per `role`, handing them the merged effective config. Stale `dsh-zen-remote-gateway` / `dsh-zen-remote-push` rows left in a profile patch are warned about and skipped by the loader — delete them; re-adding a gateway row by hand would spawn a second gateway process fighting over the port.

---

## Admin API

All of the following endpoints are **local-direct-connection only**: the request's socket must be a loopback address, carry no `X-Forwarded-*` headers at all, and name a loopback host (see Architecture). On top of that judgment sit two more gates aimed at browsers (a cross-site POST from a web page needs no preflight, so the socket/Host judgment alone cannot stop one): any request carrying an `Origin` header gets 403, and any request with a body whose `Content-Type` is not `application/json` gets 415 — the plugin backend's proxied calls and a scripted `curl` (JSON header, no Origin) are unaffected. Anything that came through the proxy (which always carries forwarded headers) gets 403 — the public internet can never reach these. Since 2.0.0 the caller is the plugin backend, not a browser admin page: requests from the settings page arrive on the same-origin routes `/_dsh/zen-remote/admin/*` and the host process calls the gateway below **as** the local machine (forwarded requests wearing the `x-zen-remote-via` marker may read status but mutations are refused — the one exception is toggling a session's remote access on `/_dsh/zen-remote/admin/shares`, which a web app device (a phone) may do; the phone session info card's remote access switch uses it).

| Endpoint | Method | What | Params |
| --- | --- | --- | --- |
| `/lan-gate/pair` | POST | Generate a new one-time pairing code (valid 10 minutes). **The code is role-bound** | `role` (optional): `desktop-client` mints a desktop-app-device code; absent/unparsable means a web-device code. The response carries `role` |
| `/lan-gate/status` | GET | Read running state, the current pairing code, the list of paired devices (each with its `role`) | none |
| `/lan-gate/action` | POST | Manage a device | `action`: `set-role` / `set-kind` / `rename` / `revoke` / `revoke-all`; `id`: device id (not needed for `revoke-all`); `set-role` also needs `role` (`web`/`desktop-client` — switching to `desktop-client` deletes the device's push subscription); `set-kind` also needs `kind` (`phone`/`desktop`/`auto`); `rename` also needs `name` |
| `/pwa/push/send` | POST | Send one push to every subscribed device | `title`, `body` (plain text, no conversation content) |

The redemption endpoints are the exception reachable from anywhere, protected by the code itself (single-use, 10-minute TTL) and a failure lockout (5 wrong codes locks that IP for 15 minutes) — each channel accepting only its own role:

- `/lan-gate/pair/claim` (POST) — the browser pairing page, **web-device** codes only, issues a cookie on success;
- `/lan-gate/pair/claim-desktop` (POST) — desktop-client pairing, **desktop-device** codes only, the token travels in the JSON body (`{ok, id, name, token}`), never as a cookie.

A role mismatch answers 403 `role-mismatch` with a localized message; the wrong-channel code is not consumed and does not count toward the lockout.

---

## The remote relay (desktop clients' data channel)

A desktop client has no DSH login cookie, and the relay deliberately does not forward DSH's native `/api` or WebSocket connections. Instead the client and the host speak zen-remote's own relay protocol: **every single call is a plain HTTP POST, every streaming subscription is an HTTP streaming response**, all under the host plugin's dedicated prefix `/_dsh/zen-remote/relay/`, entering and leaving through the gateway. No hand-rolled WebSocket; the client aborts the request to cancel a subscription.

**Three gates, re-checked per request:**

1. **Gateway device auth** — the request must carry a valid desktop-client device token (Bearer), and the gateway forwards desktop-client traffic into the relay prefix only;
2. **Marker headers + shared secret** — the gateway stamps every admitted forward with `x-zen-remote-via: gateway`, `x-zen-remote-role`, `x-zen-remote-device` and `x-zen-remote-secret` (the shared secret); client-forged copies of that namespace are stripped at the gateway's entrance. The relay routes re-verify the secret and the marker headers on every request — any mismatch is 401. Without the secret, any local process could hit `127.0.0.1` directly and forge the markers;
3. **A per-method allowlist** — every allowed method is registered with EXACTLY the argument fields that locate its session; authorization looks at those fields and nothing else, and any method not in the table is refused. This is deliberately **not** "scan the arguments for session ids": DSH's parameter validation silently drops unknown names, so a hostile client could pad a decoy shared id into a call whose real ownership field goes unchecked.

**Routes** (prefix `/_dsh/zen-remote/relay`):

| Route | Method | What |
| --- | --- | --- |
| `/ping` | GET | Liveness probe, `{ok:true}` |
| `/v1/handshake` | POST | Handshake: exchanges the relay protocol version, server id / display name, DSH version, and the interface fingerprint tables. A relay-protocol-version mismatch refuses the connection; the answer carries `serverName` (the server's display name) and `deviceName` (this device's name in the server's records) |
| `/v1/device/name` | POST | Device rename: **handled by the gateway itself, never forwarded to DSH** — open to paired desktop app devices only, and it renames only the CALLING device's own record; body `{"name":"…"}` (1–40 chars). Renames reach the other side through the stream heartbeat (~15s) and the handshake refresh (~30s) |
| `/v1/invoke` | POST | One DSH remote call on a shared session (single-shot, JSON in and out) |
| `/v1/stream` | POST | Opens one DSH stream subscription. **NDJSON format**: one JSON value per line; `{"type":"ping"}` heartbeat lines (every 15s by default) keep reverse proxies from timing idle streams away, and each one carries the current `serverName` / `deviceName` (a server rename reaches every connected client within one heartbeat); when a share closes or a subscription loses its session the server writes `{"type":"error","error":{"code":"unshared"}}` and ends the response |
| `/v1/event-result` | POST | The answer half for approval/question events (`{eventId, result}`); the server matches it against what it forwarded, per device, before handing it over |
| `/v1/http` | POST | The plain-HTTP long tail of the changes summary / diff panels: the `{route, query}` body admits only `changes.summary` / `changes.diff` and forwards GETs only (the query string is this call's coordinate, never a request body to forward); the query is **normalized and rebuilt** along an allowlist — only `sessionId` (exactly once, share-checked) and `seq` / `index` (at most once each, decimal non-negative integers) survive, unknown parameters are dropped, and the synthetic URL is composed from the normalized result alone (a control-character parsing differential between the two URL parsers was once an authorization bypass) — then dispatched **in-process** through the host's shared `/api` fetch handler, no loopback HTTP |
| `/v1/upload` | POST | The **non-image attachment** upload of a remote session: the request body is a raw byte stream (not JSON); the query string is normalized and rebuilt along an allowlist — only `sessionId` (exactly once, share-checked, 403 when not shared) and `name` (at most once) survive; the cap is 100 MiB, enforced twice (a `Content-Length` pre-check plus a counting pump over the stream), over-limit answers 413 (the refusal is written before the tail bytes are drained); at most 8 concurrent uploads per device (429 past that); then, like `/v1/http`, dispatched **in-process** through the host's shared `/api` handler — the staged receipt lands under the same session the later `session/prompt` resolves the attachment against |
| `/v1/unshare` | POST | The client closes a session's remote access itself (table members only) |

**The allowlist** (everything else is `forbidden-method`): session reads and writes (`session/follow`, `session/page`, `session/prompt`, `session/cancel`, `session/rename`, `session/selectModel`, `session/updateQueue`, `session/attachment`, `session/projections`), creation and forking (`session/create`, `session/fork` — results auto-share), subagents (`subagents/prompt`, `subagents/interruptByParent`, judged by the parent), attachments and @ references (`fileUploads/upload`, `fileReferences/list`, `sessionReferenceResolver/candidates`), the panel long tail (`goals/*` five verbs, `commands/list|execute`, `agentPresets/select`, `sessionFeedback/record`), file tree and previews (`workspaceFiles/list|changes|read|readBytes|stat`), terminals (`terminal/*`), jobs (`job/list|follow|kill`), `skills/list`, message feedback (`messageFeedback/*`), `schedule/list`, workspace session ops (`workspace/pinSession` and friends), plus four global reads: the `session/control` stream, `session/list`, the `workspace/follow` stream and `session/modelCatalog`. The first three carry no session argument — their safety is **output filtering**: every frame / every result row is narrowed by the share table before it is written, so an unshared session's row never reaches the client; in `session/list` result rows, a `parentSessionId` naming an inaccessible session is deleted as well (the rest of the row passes through unchanged). `session/modelCatalog` is likewise parameter-less and globally read-only — it is the server's model-provider directory, group and model ids plus display names only, no session data; the server empties the `failures` array in the result (the host's per-group error texts may carry endpoint or credential details the client never shows anyway). `sessionReferenceResolver/candidates` (the @-mention resolver) answers with EVERY server session's title, cwd and a ready-made mention, so it travels through the same row-level filtering — only shared sessions' rows leave the box. Approval/question events ride a `$zr/events` subscription, each forwarded event judged by its `agentId`.

The `/v1/http` route is a second allowlist, keyed by **route name** (not part of the method table), under the same discipline: an unregistered route is 404 before any id is read, and a registered one is judged only along its declared session parameter. The client-side counterpart is `GET /_dsh/zen-remote/client/http/<route>` — the browser fetch wrapper redirects the `/api/changes.*` calls it intercepted (virtual session ids) here, the original id is restored before the relay round-trip, and the upstream Content-Type is held to JSON — anything else downgrades to `text/plain` + `nosniff`.

`/v1/upload` starts on the **sub-client's own machine**: DSH's non-image attachment upload rides a request issued from inside a Web Worker, which neither a `window.fetch` wrapper nor the typert interception can see, so the plugin instead wraps the upload entry (`/api/session/uploadFileBinary`) of the host connection service's `fetchRoutes` table in the local backend and catches the request there — an upload carrying a virtual session id streams through the relay to the server (a local id passes through untouched, its body never read by us), an over-cap upload is refused locally on the client, slow links are bounded by the client-side 300-second timeout, and an upload's timeout or transport failure never moves the connection state. A local failure is still answered in the host's own "200 + failure envelope" shape, so the readable message lands on the attachment card. Export (`/api/session.export`) is the other entry wrapped in the same pass: an export naming a virtual id is refused in the backend with 403 `remote-unsupported` (the UI menu item is hidden remotely too).

**Security boundary of the relay:**

- The server executes everything through the DSH gateway service's public invoke/stream methods, under the operator identity — **it never replaces DSH internals**;
- Subagent and fork sessions never enter the table; reachability walks the ancestor chain (a shared ancestor shares the family);
- `dsh-session:` references are scanned too: DSH injects the referenced session's content along **messages** (the content text blocks of `session/prompt` / `subagents/prompt`), **queue edits** (`session/updateQueue`'s edit content) and **slash commands** (EVERY string of a `commands/execute` call — a command handler steers its raw input in as the next user message), with no access check of its own at injection time, so a call whose reference names an unshared session is refused server-side with 403; the @-mention candidates (`sessionReferenceResolver/candidates`) likewise only ever list shared sessions' rows;
- Terminals are deliberate (a desktop client is a trusted device): what opens is a **server-side** PTY running as the server user, without the agent sandbox or approval restrictions; closing the session's remote access kills its terminal streams with it;
- `workspaceFiles/read` and friends are not contained to the session directory (DSH itself does not contain them) — anything the server process can read is readable, under the same trusted-device premise as terminals;
- Concurrent streams are budgeted per device (32), and so are invokes kept in flight at once — past the per-device cap the invoke answers 429 `too-many-invokes`. Error codes shaped `*/internal` (`gateway/internal` and friends) are returned as the bare code with no message — that kind of message quotes server-side internals. Event answers are matched against the subscription and device they were forwarded to. Approval/question forwarding is **first come, first served**: whichever of the server's own UI and the sub-client answers first wins; the later answer is refused by the gateway and the client syncs to "already handled". The relay **never answers on the client's behalf**: an unshared session's approval/question events are not forwarded at all, and with the server's own UI offline too, the approval simply keeps waiting — the gateway re-delivers still-pending events to the next `$events` subscriber. A wait, never a rejection (an abstention would fail every pending approval of the session at once and break the push → wake → approve flow). Notification-type events (EMIT frames: session-list summaries, account expirations and other server-wide state) of an unshared session are never forwarded.

---

## Push notes

- The VAPID key pair is generated automatically on first boot and persisted to `~/.dsh/lan-gate-state.json` (override the directory with `DSH_HOME`); the public key is delivered to the page via the injected bootstrap script.
- `/pwa/push/subscribe` requires a valid device token cookie (i.e. the device must already be paired); each device gets at most one subscription, capped at 20 total, to keep strangers from spamming your server with subscriptions or using it to fire requests elsewhere.
- Push payloads carry only a title and a short body line (e.g. "DSH task complete") — **never any conversation content**. Delivery is standard Web Push (VAPID-signed, aes128gcm-encrypted); only the push service and your browser ever see the plaintext.
- Revoking a device deletes its push subscription too; a 404/410 from the push endpoint (expired subscription) gets it auto-cleaned on the next send.
- Mobile browsers require HTTPS before they'll register a service worker at all, so both push and offline support depend on step 2's reverse proxy — neither works on a real device until HTTPS is in place.
- "When do I get pushed" is decided by the optional host plugin `dsh-push.mjs`: it listens on the DSH event bus and calls the local `/pwa/push/send`. Two legs. **Event leg (on by default, always fires):** a tool is waiting for your authorization (session event `approval/asked` with no matching `approval/decided` within 1.5s), or the model called `ask_user_question` and is waiting for your answer (session event `tool/call`). Neither is suppressed by the debounce, and both fire for subagents too. **Turn end (off by default):** for the old "buzz me when it finishes" behaviour set `DSH_PUSH_TURN_END=1` (this was the default before 1.0.3 — now it must be turned on explicitly); once on, only top-level sessions push and a subagent finishing never does. Which events count as a turn end still comes from `DSH_PUSH_EVENTS` (comma-separated), default `agent/turn-stopping` — the official turn-close checkpoint; override it if your DSH version names it differently. `DSH_PUSH_DEBOUNCE_MS` (default 15000) sets the minimum gap between notifications. Want the turn's outcome in the body? Set `DSH_PUSH_SUMMARY=1` and the body becomes the turn's final **text** output (`text` blocks only, so the model's reasoning never leaks; a turn that produced no prose falls back to the last tool name; truncated to 120 chars). The push payload is aes128gcm-encrypted end to end — Google/Apple push servers only ever see ciphertext; the remaining exposure is your own lock screen / notification center (both OSes can hide notification content on the lock screen if that matters to you). You can also skip the plugin entirely and trigger pushes yourself: `curl -X POST http://127.0.0.1:3088/pwa/push/send -H 'Content-Type: application/json' -d '{"title":"DSH task complete"}'`.
- "The model pushes on its own" is the same `dsh-push.mjs` additionally registering a model tool, `push_notify` (`title` required, `body` optional), over the same encrypted `/pwa/push/send` path. Its description spells out both when to call it **and when not to** (listing only the former turns it into a per-turn reflex), and the same text is also injected as standing session context via `ctx.systemPrompt` — both come from one shared constant, so they cannot drift apart. It only shows up when the host has a tool registry (`ctx.tools`) and hasn't disabled it; `pushTool: false` in `lan-gate.config.json` (or `DSH_PUSH_TOOL=0`) turns it off entirely. Rate limiting is independent from the automatic notifications above: at most 1 push per session per 60 seconds, 20 total per hour across all sessions — over the limit, the call is silently skipped (not sent, not an error), so a chatty model can't turn your phone into a notification firehose. A push it does send resets the shared debounce clock, so an automatic notification right behind it is suppressed.

---

## Security boundary

**What's covered:**
- Pairing-code brute force — the code is single-use with a 10-minute TTL, and 5 wrong attempts locks that source IP for 15 minutes.
- Role-bound codes — a web-device code cannot redeem through the desktop channel and vice versa; wrong-channel attempts neither consume the code nor count toward the lockout.
- Revocable tokens — lost device, lent-out machine, one click in the settings block and it stops working immediately (open connections, established HTTP relay streams and push subscriptions all die with it).
- Desktop clients are fenced into the relay prefix — every other path (DSH pages, `/api` included) gets 403.
- The relay's three gates — device token, gateway marker headers + the per-load shared secret (`LAN_GATE_RELAY_SECRET`, not externally settable), and the per-method allowlist with output filtering; an unshared session's data never leaves the box.
- Request volume — **unpaired** requests are rate-limited per resolved real client IP, 120/min by default, 429 past that; paired devices are exempt (desktop clients have the relay's own concurrency caps instead).
- The admin surface is local-only — generating pairing codes, managing devices, triggering pushes: all local-direct only (loopback socket, no forwarded headers, loopback Host), and anything through the proxy (always carries forwarded headers) gets 403; so do requests carrying an `Origin` header or a non-JSON body (403/415) — DNS rebinding and cross-site simple requests cannot get in; a forwarded request wearing the gateway marker may read but not mutate (toggling a session's remote access excepted, see above).

**What's not covered — your responsibility:**
- A misconfigured reverse proxy — e.g. accidentally exposing `127.0.0.1:3088/lan-gate/admin` on the public domain too, or a wrong `X-Forwarded-Proto` making the gateway misjudge the client's protocol. These are configuration mistakes the gateway can't defend against.
- A stolen or shared token — this is a single-user tool; the token is equivalent to full access, with no finer-grained permission tiers. Whoever has the token can use it — if you suspect a leak, revoke it and re-pair from the settings page.
- **A desktop client is a trusted device** — its terminal runs as the server user without the agent sandbox or approval restrictions, file previews are not contained to the session directory, and it can create sessions in any server workspace. "Only shared sessions are visible" constrains session data, not the machine; giving a pairing code to a computer you don't trust is handing it the machine.
- DSH's own capability boundary — the gateway only forwards traffic to DSH safely; it can't and doesn't add security measures DSH itself doesn't have (DSH's own `/api` trust fence is DSH's concern).
- The state file `~/.dsh/lan-gate-state.json` stores the VAPID private key and every device's token in plaintext — this file *is* full access to your gateway. Mind its file permissions on the host, and don't sync `~/.dsh` into a shared drive or an untrusted backup location.

---

## Known issue: iOS 26.x viewport shrink

On iOS 26.x, once DSH is added to the home screen and opened as a standalone PWA, the layout viewport loses a chunk of its bottom edge (measured on one iPhone on 26.5: 852px screen vs. 793px viewport — exactly one status-bar's worth) from cold start onward, until the app is fully quit and reopened. The same URL in a plain Safari tab is unaffected.

This is not a bug in this plugin — it's a known iOS 26.x system defect (the layout viewport permanently shrinks the first time the on-screen keyboard is shown inside a standalone PWA; `innerHeight`, `visualViewport.height` and `100dvh` all shrink together). The missing strip sits outside the document, so no stylesheet can reach it — only the system paints it, using the manifest's `background_color`. This repo keeps that value at a light `#f9fafb` (matching the interface half's light theme background) so the dead strip blends into the page instead of standing out as a dark bar.

> The Android bottom band is **not** painted from this value — do not change it to chase that. It is the Android system navigation bar, which follows the system dark-mode setting and is out of the page's reach.

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
| `lan-gate.mjs` | Gateway sub-plugin entry, loaded by the main entry on the host role: spawns the gateway child process and manages its lifecycle |
| `dsh-push.mjs` | Push sub-plugin (loaded alongside the gateway on the host role): listens on the DSH event bus, calls the gateway's local `/pwa/push/send`, and registers the `push_notify` model tool |
| `lib/lan-gate-server.cjs` | The gateway itself: single-file CommonJS (Node stdlib + one runtime dependency, `web-push`) — HTTP/WebSocket reverse proxy, pairing/tokens, rate limiting, PWA injection, Web Push |
| `pwa/manifest.json` | PWA install manifest |
| `pwa/sw.js` | Service worker (offline caching + push notifications) |
| `pwa/inject.js` | Injected page bootstrap: SW register, gesture loader, push subscribe |
| `pwa/touch-gestures.js` | Edge-swipe back / pinch-zoom |
| `pwa/app.css` | Mobile touch-first CSS (`data-lan-device`-prefixed, desktop unaffected) |
| `pwa/offline.html` | Offline fallback page |
| `pwa/icons/` | SVG source + rasterized PNGs (192/512 + maskable) |
| `cordis.patch.yml` / `.example` | Bundle patch layer / static-mount example |
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
- `manifest.json`'s `background_color` switched to a light color as a visual mitigation for the iOS 26.x standalone-PWA viewport shrink dead strip (known OS defect, not a fix — see "Known issue" above). Unrelated to the Android navigation bar.

**Internal**

- `pwa/app.css` trimmed from 163 to 95 lines; added `test/sw.test.cjs` covering the service worker's new cache strategy.

---

## Security

Installing a plugin runs third-party code with your own permissions; being listed or published is not a security review. The gateway listens on `127.0.0.1` only by default and will not expose itself to the public internet on its own — every public-facing path must go through a reverse proxy you configure and that terminates TLS yourself. Run this only on your own server, keep the state file out of untrusted locations, and audit changes to `lib/lan-gate-server.cjs`.

## License

MIT. The gateway `lib/lan-gate-server.cjs` extends `dsh-mobile-gate`; original MIT copyright/license retained — see [LICENSE](../LICENSE).
