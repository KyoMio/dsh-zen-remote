<h1 align="center">dsh-zen-remote</h1>
<p align="center">Turn DeepSeek Harness into a phone app you can safely reach from the public internet: a mobile UI, a pairing-code gateway, install-to-home-screen, and lock-screen push.</p>

<p align="center">
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT"></a>
<img src="https://img.shields.io/badge/release-v1.1.12-5B4CF0?style=flat-square" alt="v1.1.12">
<img src="https://img.shields.io/badge/DSH-Web%20Profile-5B4CF0?style=flat-square" alt="DSH Web Profile">
</p>

<p align="center"><a href="README.zh-CN.md">中文文档</a></p>

| Session list home | Session page | Session info card |
| --- | --- | --- |
| ![Session list home](assets/home.png) | ![Session page](assets/session.png) | ![Session info card](assets/info.png) |

| Composer permission sheet | Pairing page a public visitor sees |
| --- | --- |
| ![Composer permission sheet](assets/sheet.png) | ![Pairing page](assets/pairing.png) |

> Screenshots are a 390×844 phone viewport in the light theme; both themes are supported. The pairing page is drawn by the gateway itself and is always dark.

---

## Install

```sh
dsh plugin add dsh-zen-remote
```

Restart `dsh web` afterwards. The mobile UI and the gateway both come up — there is no config line to hand-write.

> **Compatibility — one build, both runtimes.** Verified live on DSH `0.1.1-rc.2` and `0.1.2-rc.1` (web profile), 2026-09-04.
>
> 0.1.2 removed `@deepseek-ai/dsh-client-runtime` and put the web UI behind a signed cookie, which would have broken the mobile UI and locked the phone out of the gateway. The plugin carries its own store engine instead of importing that package, probes for the services 0.1.2 moved (`uiWorkspace`, `uiSession`) and falls back to the 0.1.1 shapes when they are absent, reads a turn's events through either `session.events` or `session.snapshotEvents()`, and lets the gateway do the browser-token handshake on the phone's behalf — all of it inert on 0.1.1, where the token endpoint does not exist.
>
> One thing to know on 0.1.2: the web UI now rejects requests whose `Host` is not trusted. Reaching DSH through this plugin's gateway is unaffected (the gateway presents every request as `127.0.0.1`), but pointing a browser straight at `http://<LAN-IP>:3080` returns 403 unless you start `dsh web --trusted-host <host>`.

To uninstall: `dsh plugin remove dsh-zen-remote` (or delete the two lines from your profile's `dependencies` and `bundles`) and restart `dsh web`. To also wipe the pairing data, delete `~/.dsh/lan-gate-state.json` and `~/.dsh/lan-gate.config.json`.

<details>
<summary>Manual install / local development</summary>

Edit `~/.dsh/profiles/web/package.json` by hand — one line under `dependencies`, one under `bundles`:

```jsonc
{
  "dependencies": {
    "dsh-zen-remote": "^1.1.12"        // for local development: "link:/path/to/dsh-zen-remote"
  },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-zen-remote"
  ] } }
}
```

```sh
cd ~/.dsh/profiles/web && pnpm install
# restart dsh web
```

If you would rather not go through the profile install flow at all, see the static mount in [`cordis.patch.yml.example`](cordis.patch.yml.example).

</details>

---

## Setting up public access

Once installed, the mobile UI already works at `127.0.0.1:3080` on the machine itself. To reach it from outside, three steps.

### 1. Put a reverse proxy in front for HTTPS

The gateway listens on `127.0.0.1:3088` only — exposing it is your reverse proxy's job. **If your home connection has no public IP, or you'd rather not open a port on your router**, skip nginx/Caddy and jump to the third block (Cloudflare Tunnel).

<details open>
<summary><b>nginx</b></summary>

```nginx
# once, inside the http {} block
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl http2;
    server_name dsh.example.com;

    ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3088;
        proxy_http_version 1.1;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

</details>

<details open>
<summary><b>Caddy</b></summary>

```
dsh.example.com {
    reverse_proxy 127.0.0.1:3088
}
```

</details>

<details open>
<summary><b>No public IP? Use a Cloudflare Tunnel</b></summary>

For when your home connection gets no public IP, or you don't want to open a router port: `cloudflared` dials out from your machine, and Cloudflare handles the domain, the certificate and the entry point. Not a single port needs opening. The free tier is enough.

Prerequisite: the domain is hosted on Cloudflare (nameservers pointed at it).

1. Open the [Zero Trust dashboard](https://one.dash.cloudflare.com/) → **Networks → Tunnels → Create a tunnel** → pick **Cloudflared**, name it. After creating it the page hands you an install command with a token in it;
2. Run that command on the machine running DSH (it looks like this, with the token from the page):

   ```sh
   # macOS / Linux: install as a service that starts at boot
   cloudflared service install eyJhIjoi...your-token
   ```

3. Back on the tunnel's detail page → **Public Hostname** → **Add a public hostname**:

   | Field | Value |
   | --- | --- |
   | Subdomain / Domain | `dsh` / `example.com` (i.e. `dsh.example.com`) |
   | Service Type | `HTTP` |
   | URL | `127.0.0.1:3088` |

   Save, and `https://dsh.example.com` is live with a Cloudflare-issued certificate. Leave the gateway's `LAN_GATE_HOST` at its `127.0.0.1` default — `cloudflared` runs on the same machine.

**Step 2's 403 self-check is mandatory**, and it matters most for a tunnel: `cloudflared` reaches the gateway over a loopback connection, so the only thing separating "a visitor from the internet" from "you, sitting at this computer" is whether the tunnel forwards `X-Forwarded-For`. `cloudflared` does by default, so the pairing wall works; but if your version or config strips it, public requests get treated as the local admin and the pairing wall is decorative. **Load `/lan-gate/admin` over mobile data — a 403 is the only safe answer.**

> Note: you do not need `LAN_GATE_TRUSTED_PROXIES` here. The gateway already trusts a loopback connection as a reverse proxy, so setting it to `127.0.0.1` is a no-op — and it is **not** a substitute for the self-check above.
>
> Cloudflare's free tier supports WebSockets (DSH's conversation stream needs them) and caps a request body at 100MB, above this plugin's 20MB upload default, so nothing is affected.

The CLI route (`cloudflared tunnel login` / `create` / `route dns` plus an `ingress` block in `config.yml`) is in [docs/remote-access.en.md](docs/remote-access.en.md#cloudflare-tunnel--getting-in-without-a-public-ip).
</details>

For Lucky (routers/NAS), see [docs/remote-access.en.md](docs/remote-access.en.md#lucky). When the proxy and the gateway are on different machines, put the proxy's egress IP in `LAN_GATE_TRUSTED_PROXIES`.

### 2. Self-check

From **mobile data** (not your home Wi-Fi), open `https://your-domain/lan-gate/admin`. The correct result is a **403**.

If you can see the admin page, your proxy isn't sending the `X-Forwarded-*` headers and public requests are being treated as local ones. Go back and fix the forwarded headers before continuing.

### 3. Pair a device

```sh
# on the machine running DSH, in a browser on that machine
open http://127.0.0.1:3088/lan-gate/admin
```

1. Click "Generate pairing code" for an 8-character code (valid 10 minutes, single use);
2. On the phone, open your HTTPS domain and enter the code on the pairing page;
3. Once paired you land in DSH. Identity lives in a long-lived cookie, so switching networks doesn't log you out;
4. Use the browser's "Add to Home Screen" to install it as an app;
5. Grant notification permission, and the agent reaches your lock screen when it needs you.

The admin page can also rename devices, change a device's type, and revoke devices one at a time or all at once.

---

## Optional configuration

Environment variables, or `~/.dsh/lan-gate.config.json` (keys are the variable names minus the prefix, camelCased — `port`, `trustedProxies`; an explicit env var wins). Restart `dsh web` after changing anything.

| Variable | Default | What it does |
| --- | --- | --- |
| `LAN_GATE_PORT` | `3088` | Gateway port; if taken it retries upward (up to +20) |
| `LAN_GATE_HOST` | `127.0.0.1` | Listen address; only open this up when the proxy is on another machine |
| `LAN_GATE_TARGET_PORT` | `3080` | Local DSH Web UI port |
| `LAN_GATE_RATE_LIMIT` | `120` | Per-minute cap on unpaired requests, counted per real client IP |
| `LAN_GATE_TRUSTED_PROXIES` | empty | Comma-separated IPs; required when the proxy is on another machine |
| `LAN_GATE_VAPID_SUBJECT` | `mailto:admin@localhost` | Push contact. **On iOS this must be a real email or https URL**, or Apple refuses to deliver |
| `LAN_GATE_LANG` | `auto` | Language of the pairing page, the admin page and the push opt-in card. `auto` follows the browser's `Accept-Language` (falling back to Chinese when there is none); `zh`/`en` pin it |
| `DSH_PUSH_TURN_END` | **off** | Set `1` to also push when a turn ends. Off by default — a finished turn doesn't mean you're needed (it pushed by default before 1.0.3; this was a behaviour change). Approval-pending and question-pending notifications are unaffected and always fire |
| `DSH_PUSH_EVENTS` | `agent/turn-stopping` | Which events count as "turn ended", comma-separated; only meaningful with `DSH_PUSH_TURN_END=1` |
| `DSH_PUSH_DEBOUNCE_MS` | `15000` | Minimum gap between two automatic pushes; approval/question notifications are never suppressed by it |
| `DSH_PUSH_SUMMARY` | off | Set `1` to include this turn's final reply (prose only, never the reasoning; clipped to 120 chars) and the question text |
| `DSH_PUSH_TOOL` | on | Set `0` to remove the model-callable `push_notify` tool |
| `DSH_PUSH_LANG` | `zh` | Language of the notification copy. A notification carries no signal about who will read it, and the host process has no reliable system locale either (launchd starts it without `LANG`), so this is not autodetected: set `en` for English |
| `DSH_PUSH_APPROVAL_GRACE_MS` | `5000` | How long to wait before pushing "approval pending". With a plugin that answers approvals automatically (dsh-auto-approve and the like) installed, the push waits for its verdict — answered means no push. A slower judge still gets pushed over, so raise this if yours is |

The upload size limit (20MB by default) is `config.maxUploadBytes` on the plugin row.

To enable turn-process folding on desktop too (it only applies at phone widths by default), set `config.turnFoldDesktop` to `true` on the plugin row — that is, add this to the profile's `cordis.patch.yml`:

```yaml
- id: dsh-zen-remote
  config:
    turnFoldDesktop: true
```

Restart `dsh web` afterwards. Without touching the server config, a single browser can also turn it on for itself by visiting `?mobile-nav-turn-fold=1` once (`=0` turns it off; remembered per browser).

**Three calibration values for the soft-keyboard lift.** On a few phones the system never tells the browser how tall the keyboard is (measured: certain third-party IMEs plus Chrome; the PWA shell Xiaomi's browser installs). With no measurable signal at all, the plugin has to lift the input box by estimate. The estimate is tuned to one reported device, so it may be too high or too low on yours — all three numbers are adjustable on the plugin row:

| Setting | Default | Meaning | Allowed range |
| --- | --- | --- | --- |
| `keyboardLiftRatio` | `0.42` | Estimate the lift as this fraction of screen height | 0 – 1 |
| `keyboardLiftMaxPx` | `400` | Cap on the estimate (pixels), so the input box doesn't end up mid-screen on a tall phone | 0 – 2000 |
| `keyboardSafetyPadPx` | `15` | A little extra clearance above the keyboard, **Android only**. Third-party IMEs routinely under-report their own height (leaving out the toolbar strip above the keys); this makes up for it | 0 – 200 |

```yaml
- id: dsh-zen-remote
  config:
    keyboardLiftRatio: 0.45
    keyboardSafetyPadPx: 30
```

How to tune: if the box is lifted **too little** (the keyboard still covers part of it), raise `keyboardLiftRatio` in steps of 0.03; if it's lifted **too far** (a gap opens between the box and the keyboard), lower it. If it's off by only a little (tens of pixels, on Android), reach for `keyboardSafetyPadPx` first. Leaving all three unset keeps today's behaviour exactly; out-of-range values are clamped to the table above, so the input box can never be pushed off-screen. Phones that report properly take the measured path and none of these values affect them.

---

## When notifications fire

By default only when you are **actually needed**, along two independent lines.

**1. Decided by the system (always on, never suppressed by the debounce)**

| Situation | Notification |
| --- | --- |
| A tool is waiting for your authorization | "DSH needs your approval", with the tool name |
| The model called `ask_user_question` and is waiting | "DSH is waiting for your answer" |

Neither looks at session depth — a subagent stuck on an approval still calls out, because it's still you it's waiting for. Neither is suppressed by `DSH_PUSH_DEBOUNCE_MS` either: "something needs your nod" is the one notification that must never be swallowed.

**Timing when a machine answers**: approval events arrive as "record asked → consult the answerer → record decided", so the push doesn't fire the moment `asked` appears — it waits `DSH_PUSH_APPROVAL_GRACE_MS` (5 seconds by default) and skips anything answered within it. That window used to be 1.5s, designed around "every answerer settles in the same tick". True for a synchronous answerer, not for a model-backed one (measured: 2.4s average), and the result was a "needs your approval" push for a request that was auto-allowed — notification delivered, dialog never shown. Raise it if you switch to a slower judge.

Approvals a policy waves through don't disturb you: after the request lands, the push waits 1.5s and cancels if the matching "decided" arrives. Only genuinely unattended ones go out.

**2. Decided by the model**

The `push_notify` tool. The model should call it when you explicitly asked to be told when something finished, when it needs you to continue, or when something unexpected happened that you'd probably want to know right away. The tool description also spells out when *not* to call it (routine turn ends, progress reports, anything it can push forward on its own) — listing only the former turns it into a per-turn reflex. The same guidance is injected as standing session context, from one shared constant, so the two cannot drift apart.

**What does not fire by default**

- **A plain finished turn does not push** (changed in 1.0.3; before that every turn did). Getting work done isn't the same as needing you. Set `DSH_PUSH_TURN_END=1` for the old behaviour.
- **A subagent finishing never pushes**, regardless of that switch.

**What's in a notification**: by default the title only, with no conversation content. With `DSH_PUSH_SUMMARY=1` the body carries this turn's final reply — prose only, never the reasoning; a turn that produced no prose falls back to "Last executed: <tool>" rather than padding it out with thinking text. The push payload is aes128gcm end-to-end encrypted.

---

## Features

- Two-level page stack — session list home plus a standalone session page, pushed in and out horizontally
- Plugin entry chips on the home screen, appearing automatically for what you have installed, individually hideable
- Reworked composer: controls become icons, the permission and model menus become bottom sheets
- Session info card: six stats plus export log / rename / fork / archive
- Reasoning and tool calls within one turn fold into a single "process · N steps" row by default
- Gestures: swipe right from the left edge to go back, swipe down to dismiss a bottom sheet. Android's system back gesture is taken over as "close the overlay → back to the list → leave the app", instead of quitting the PWA on the first press
- Local attachment upload from the phone: files land in the session's working directory under `.dsh-uploads/` and an `@` reference is appended to the composer — sending it is still your call
- A pairing code buys a long-lived device token; identity follows the token, not the IP, and can be revoked at any time
- The admin surface (generate a code / manage devices / trigger a push) only accepts direct local connections; anything through the proxy gets a 403
- A real PWA: manifest plus service worker, installable to the home screen, opens offline
- Real Web Push: VAPID plus aes128gcm, no conversation body by default; fires only for approvals and questions, no longer on every turn end (see above)
- The `push_notify` tool: the model can push at a moment that matters, rate-limited
- The "internal testing notice" dialog gets a "don't show again" option: remote access re-shows the notice on every reload, and one click makes this device remember and dismiss it from then on

In depth: [interface](docs/interface.md) · [public access](docs/remote-access.en.md)

---

## Third-party plugins with mobile support

The mobile UI has specific adaptations for the plugins below. Every adaptation is anchored on that plugin's own DOM markers: if you don't have it installed the rules simply don't match, and installing a plugin that isn't listed here can't be caught in the crossfire.

| Plugin | What the mobile adaptation does | Version tested |
| --- | --- | --- |
| [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | A workbench entry button in the session page header; the panel becomes a full-width phone drawer that respects the notch safe area, with a centred close button at the bottom | 0.15.0 |
| [@nanmicoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | The AgentTeams activity overlay moves below the session header (its original position covered the header buttons) and hides itself on the session list; a subagent session keeps a tappable parent-session title in its header for jumping back | 0.1.9 |
| [@ychris12138/dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats) | Usage and balance entries fold into the home-screen chips row | 0.2.9 |
| [@opendsh/dsh-plugin-scheduled-tasks](https://github.com/Ceelog/dsh-plugins) | The scheduled-tasks entry folds into the home-screen chips row | 0.2.3 |
| dsh-at-file | `@` file references, used alongside attachment upload's `@` paths. It and this plugin's attachment chips read the same draft token, so on the phone its `.dsh-uploads/` rows are hidden to stop one file being drawn twice (thumbnail plus filename); other `@` references are left alone | 0.6.7 |
| [@ace-zone/dsh-market](https://www.npmjs.com/package/@ace-zone/dsh-market) | The plugin market dialog's top bar doesn't fit on a phone and the × gets squeezed out of the panel (no Esc on a touchscreen, so it can't be closed at all). Three decorative slots — tagline, version, homepage link — are hidden, the title shrinks with an ellipsis, and the language switch and × stay with a bigger tap target | 0.1.66 |
| [dsh-vision-toolkit](https://www.npmjs.com/package/@anionex/dsh-vision-toolkit) | Image Q&A / OCR, used with phone-side attachment upload | — |
| [dsh-web-ui suite](https://www.npmjs.com/package/@linxin666/dsh-web-ui-all) | Inherits the compatibility rules from upstream dsh-web-mobile (file tree, width-capped centred preview overlay, and so on) | — |

The technical detail behind each adaptation — anchor selectors, breakpoints, what was traded away — is in the "compatible plugins" section of the [interface doc](docs/interface.md).

---

## Known issues

**iOS 26.x standalone PWA viewport shrinkage**: after adding to the home screen, the viewport loses a status-bar's height at the bottom; an ordinary Safari tab is fine. This is an iOS defect — the missing region is outside the document and CSS cannot reach it. The plugin ships three layers of mitigation (light manifest background, safe-area compensation, forced reflow) which reduce it without guaranteeing a fix. Only quitting and reopening the whole app restores it fully.

**In a few environments the soft keyboard is completely invisible to the browser, and the lift falls back to an estimate**: in some combinations (measured: certain third-party IMEs plus Chrome; the PWA shell installed by Xiaomi's browser) the system never tells the page the keyboard's height when it opens or closes — the viewport doesn't change and no event fires (visualViewport and the VirtualKeyboard API both fail; both ruled out by measurement). The fallback: probe for about 1.2s after focus, and if the keyboard is judged invisible, lift the input box by the estimated height (the verdict is remembered per browser, so later focuses lift immediately). Two costs: the lift is an estimate and can be tens of pixels off the real keyboard, and there's no signal for the keyboard closing either, so the box only drops back once you tap or scroll outside it. Normal environments never take this path. If the lift is visibly off you don't need to change code — `keyboardLiftRatio` / `keyboardLiftMaxPx` / `keyboardSafetyPadPx` on the plugin row are there to be tuned to your device; see the configuration section above.

**Settings pages don't open through the reverse proxy (the plugin config list is blank, model cards report "settings are unavailable in this browser")**: connecting directly to `127.0.0.1:3080/3088` works fine.

The root cause is DSH's own design, not the gateway: settings RPCs are **loopback-only**. The client decides from `location.hostname` (`isLoopback` in `dsh-client-connection`), and off-loopback `dsh-client-ui-settings` degrades persistence to `memory`, so the settings mirror starts out `unavailable` — the upstream source comment reads, verbatim, "remote browsers remain process-local because settings RPCs are loopback-only". Every card that depends on that mirror (models, plugin config) goes blank together. Nothing to do with this plugin or with service worker caching (verified 2026-08-20 by USB-debugging a real device against a local control).

Workaround: change settings from a browser on the machine running DSH. The config lives in the backend, and nothing else on the phone side is affected. Making settings remotely editable requires upstream to relax that restriction.

---

## Permissions and data

- **Network**: the gateway listens on the local machine only (`127.0.0.1:3088` by default); what gets exposed is entirely up to your reverse proxy or tunnel. Push travels through the browser vendor's push service (the content is aes128gcm end-to-end encrypted, so the vendor can't read it). The plugin itself reports nothing to any third party.
- **Files**: attachment uploads are written only to `.dsh-uploads/` inside the current session's working directory; pairing state and config live in `~/.dsh/lan-gate-state.json` and `lan-gate.config.json`.
- **Credentials**: no account or password is ever collected or stored; a device's identity is a random token this plugin issues itself, in an HttpOnly cookie.

Troubleshooting: runtime logs are in `~/.dsh/logs/web.log` (gateway and push lines are prefixed `[dsh-zen-remote-*]`); the phone UI has a debug badge for self-checks (tap the home screen's top bar five times to toggle it). Please report security issues privately through GitHub Security Advisories rather than opening a public issue.

## Upstream credits

This plugin's interface layer derives from [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile), and its channel layer from [zylzyqzz/dsh-mobile-pwa](https://github.com/zylzyqzz/dsh-mobile-pwa) (itself derived from [Bernardxu123/dsh-mobile-gate](https://github.com/Bernardxu123/dsh-mobile-gate)), both MIT. The original copyright lines are preserved in [LICENSE](LICENSE).

## License

[MIT](LICENSE)
