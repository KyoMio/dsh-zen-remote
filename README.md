<h1 align="center">dsh-zen-remote</h1>
<p align="center">One DeepSeek Harness plugin, two roles. The <b>host</b> turns DSH into a phone-reachable PWA (mobile UI, pairing gateway, lock-screen push) and shares chosen sessions to paired desktops. The <b>client</b> runs inside another DSH desktop app and puts the host's shared sessions right into its own sidebar — full history, live progress, messages, approvals, terminal, everything executes on the host.</p>

<p align="center">
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT"></a>
<img src="https://img.shields.io/badge/release-v2.0.0-5B4CF0?style=flat-square" alt="v2.0.0">
<img src="https://img.shields.io/badge/DSH-0.1.7%20%7C%200.2.0-5B4CF0?style=flat-square" alt="DSH">
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

## One plugin, two roles

Same package, same plugin row. What runs is decided by the `role` setting in the DSH plugin settings page:

| | **Host** (`role: host`, the default) | **Client** (`role: client`) |
| --- | --- | --- |
| Machine | The one that runs the sessions | Another computer running the DSH desktop app |
| What it loads | Mobile UI, gateway (child process), Web Push, session sharing, the relay server | The relay client and the sidebar/session-page remote parts |
| What it does NOT load | — | No gateway, no push, no phone UI — it never fights the host for the gateway port |

A paired **desktop client** sees exactly the sessions the host has turned remote access on for, grouped under "server name · workspace name" after the local workspaces. Local sessions on the client machine are untouched.

---

## Install

```sh
dsh plugin add dsh-zen-remote
```

**Desktop profile** (how a 2.0 host actually runs): add the dependency to `~/.dsh/profiles/desktop/package.json`, install, restart the desktop app:

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": {
    "dsh-zen-remote": "^2.0.0"        // for local development: "link:/path/to/dsh-zen-remote"
  }
}
```

```sh
cd ~/.dsh/profiles/desktop && pnpm install
# then restart the DSH desktop app
```

**Web profile** (host on a headless `dsh web` box, also where phone access still points): same two steps against `~/.dsh/profiles/web/package.json`, then restart `dsh web`.

Either way there is exactly **one** bundle row to mount. Since 2.0.0 the composition layer is a single line — `dsh-zen-remote` — and the main entry loads the gateway and push sub-plugins itself, according to the role. Do **not** re-add the old `dsh-zen-remote-gateway` / `dsh-zen-remote-push` rows: the loader warns and skips them, and two gateway rows would mean two gateway processes fighting over port 3088.

<details>
<summary>Static mount / local development</summary>

Copy [`cordis.patch.yml.example`](cordis.patch.yml.example) into your profile's `cordis.patch.yml` with an absolute path — it is the same single row, with an optional `config:` block showing the row fields. `dsh plugin add` users never need it.

</details>

To uninstall: `dsh plugin remove dsh-zen-remote` (or delete the line from the profile's `dependencies` / `bundles`) and restart. To also wipe pairing and share state, delete `~/.dsh/lan-gate-state.json`, `~/.dsh/lan-gate.config.json` and `~/.dsh/zen-remote-shares.json`.

---

## Upgrading from 1.x

One-time facts, in order of likelihood to bite:

- **The three bundle rows collapse into one.** Old `dsh-zen-remote-gateway` / `dsh-zen-remote-push` rows left in a profile patch are warned about and skipped by the loader. Any `config:` you had written **on those old rows** no longer applies — move it onto the `dsh-zen-remote` row or, better, set it in the plugin settings page.
- **If you hand-inserted a `dsh-zen-remote/dsh-push.mjs` line into a profile patch back in 1.0, remove it** — the main entry loads the push half by role now, and a leftover line loads push twice.
- **`~/.dsh/lan-gate.config.json` still works.** Nothing to migrate; its values show up in the settings page. Priority per field: environment variable > plugin row settings > `lan-gate.config.json` > built-in default. The file is never written or deleted by the plugin.
- **Paired devices become Web 应用端 automatically** and keep working; no re-pairing.
- **The admin page moved.** `/lan-gate/admin` is now just a notice pointing at the plugin settings page (it still 403s anything that is not a direct local connection). Pairing codes, device management, push test and sharing all live in the DSH Plugins page → dsh-zen-remote settings block.
- With no configuration touched at all, the plugin comes up as a host and the gateway, push and phone UI behave exactly as 1.1.x did.

---

## Setting up public access (host)

Once installed, the mobile UI already works at `127.0.0.1:3080` on the machine itself. To reach it from outside: put your own TLS-terminating reverse proxy in front of the gateway, verify it with a 403 self-check, then pair devices. The full walkthroughs — nginx / Caddy / Cloudflare Tunnel / Lucky — live in [docs/remote-access.en.md](docs/remote-access.en.md). The short form:

1. The gateway listens on `127.0.0.1:3088` only; a reverse proxy (nginx, Caddy, Cloudflare Tunnel, Lucky) terminates HTTPS and forwards to it. **Self-check**: from **mobile data** (not home Wi-Fi), open `https://your-domain/lan-gate/admin` — the correct result is a **403**. If you can see the notice page, your proxy is not forwarding `X-Forwarded-*` headers and public requests are being treated as local ones — fix that before continuing.
2. Open the DSH Plugins page **on the host machine**, open the dsh-zen-remote settings block, pick the device role for the code you are about to mint, and generate an 8-character pairing code (valid 10 minutes, single use).
3. On the phone, open your HTTPS domain and enter the code on the pairing page. Once paired you land in DSH; identity lives in a long-lived cookie. Use "Add to Home Screen" to install it as an app, grant notification permission, and the agent reaches your lock screen when it needs you.

---

## Pairing devices

A pairing code is minted **for one device role**, and the role is checked at redemption — a code offered to the wrong channel is refused with a clear message, is not consumed, and does not count toward the wrong-code lockout.

| | **Web 应用端 (web app device)** | **桌面应用端 (desktop app device)** |
| --- | --- | --- |
| Shape | Phones, tablets, browsers — anything through the gateway | A computer running the DSH desktop app with this plugin in its `client` role |
| Sees | **All** server sessions | **Only** the sessions the host has enabled remote access on (enforced server-side) |
| How to pair | Open the gateway URL in a browser, enter the code on the pairing page | Fill the server URL + code into the client's plugin settings page |

**Desktop-client pairing**, step by step:

1. On the host's plugin settings page, choose 桌面应用端 and generate a code.
2. On the other computer's DSH desktop app, open the plugin settings page, set the role to **client**, enter the server address and the code.
3. The address must be `https://` unless it is a private-network host — LAN ranges (`192.168.x`, `10.x`, `172.16–31.x`), Tailscale/CGNAT (`100.64.x`), loopback, `localhost` / `*.local`, or IPv6 `::1` / `fc00::/7` / `fe80::/10`. A public address over plain http is refused, so the device token never travels in the clear.
4. On success the token is stored in the row (a secret field) and the client connects automatically. The settings block shows the connection state — connected / offline / version mismatch / token revoked — and can unpair.

The server-side settings page can rename devices, change a device's role (`set-role`), and revoke one or all. Revocation is immediate: open connections and push subscriptions die with it. Desktop-client devices can never reach any admin route — the gateway only ever forwards them into the relay prefix.

---

## Session sharing

Remote access is per session, with three toggle entries on the host:

1. the session's context-menu item in the sidebar;
2. the remote icon in the session title row (click to toggle, with a confirmation; hover shows the remaining idle time; a dot on the icon means a desktop client is watching right now);
3. the shared-sessions list in the plugin settings page, including a close-all.

**Idle sleep**: a remote-enabled session closes its remote access by itself after **48 hours** (configurable, `idleHours`) with no session activity — turns starting or ending, messages, approvals or question answers, from either the server or a client. Sessions that are mid-turn or waiting on an approval/question are never swept, and merely having a viewer open does not keep one awake. The remaining time is hoverable on the title-row icon and listed in the settings page.

**New sessions**: with `autoShareNewSessions` on, every session the host creates is shared automatically; sessions created **through** the relay (from a client's remote group) are always auto-shared, which is what makes the entry safe. Subagent and fork sessions follow their parent — no per-session toggling.

**What "remote off" means**: an unshared session's list row, history, live progress and approval/question events are all refused or filtered at the relay — not merely hidden in the UI. @-mention candidates list **only shared sessions**, and a `dsh-session:` reference embedded in a message, a queue edit or a slash command is refused for the whole call when it names an unshared session.

---

## Configuration

Everything is edited in the DSH Plugins page → dsh-zen-remote settings block. Per field the first legal value wins in this order: **environment variable > plugin row settings > `~/.dsh/lan-gate.config.json` > default**. A value that fails its field's check (type, range, enum) makes that layer transparent. Saving a field that needs a gateway/push restart (`role`, `port`, `host`, `targetPort`, `rateLimit`, `trustedProxies`, `vapidSubject`, `lang`, and the push fields) reloads the plugin row automatically — no app restart required; everything else takes effect immediately.

Row fields (matching `src/config.ts`):

| Field | Default | What it does |
| --- | --- | --- |
| `role` | `host` | `host` runs gateway + push + sharing; `client` connects to a server. Anything not exactly `client` degrades to `host` |
| `port` | `3088` | Gateway port; if taken it retries upward (up to +20) |
| `host` | `127.0.0.1` | Gateway listen address; only open this up when the proxy is on another machine |
| `targetPort` | *(auto)* | Local DSH Web UI port. Leave unset: the gateway discovers the host's real listening port (desktop builds use a configurable one) |
| `rateLimit` | `120` | Per-minute cap on unpaired requests, per real client IP |
| `trustedProxies` | empty | Comma-separated IPs; required when the proxy is on another machine |
| `vapidSubject` | `mailto:admin@localhost` | Push contact. **On iOS this must be a real email or https URL**, or Apple refuses to deliver |
| `lang` | `auto` | Language of the gateway's pages, the push opt-in card and the notification copy. `auto` follows the browser's `Accept-Language` (falling back to Chinese); `zh`/`en` pin it |
| `pushTurnEnd` | off | Also push when a turn ends. Off by default — a finished turn doesn't mean you're needed. Approval/question pushes are unaffected and always fire |
| `pushEvents` | `agent/turn-stopping` | Which events count as "turn ended", comma-separated; only meaningful with `pushTurnEnd` |
| `pushDebounceMs` | `15000` | Minimum gap between two automatic pushes; approval/question notifications are never suppressed by it |
| `pushSummary` | off | Include the turn's final reply (prose only, never the reasoning; clipped to 120 chars) and the question text in the body |
| `pushTool` | on | Set `false` to remove the model-callable `push_notify` tool |
| `serverName` | computer name | Server display name (≤ 40 chars), shown in the client's group titles |
| `idleHours` | `48` | Idle-sleep window in hours for remote-enabled sessions; range (0, 8760] |
| `autoShareNewSessions` | off | Auto-enable remote on every session the host creates |
| `serverUrl` *(client)* | empty | The server's gateway address, normalized per the rules above |
| `deviceToken` *(client)* | empty | The paired device token; stored as a secret field, redacted everywhere |
| `turnFoldDesktop` | off | Turn-process folding at every width, not just phone widths |
| `keyboardLiftRatio` / `keyboardLiftMaxPx` / `keyboardSafetyPadPx` | `0.42` / `400` / `15` | Soft-keyboard lift calibration for browsers that never report the keyboard (see the known-issues note below) |
| `maxUploadBytes` | 20 MB | Attachment upload cap |

The legacy environment variables keep working and outrank the row: `LAN_GATE_PORT`, `LAN_GATE_HOST`, `LAN_GATE_TARGET_PORT`, `LAN_GATE_RATE_LIMIT`, `LAN_GATE_TRUSTED_PROXIES`, `LAN_GATE_VAPID_SUBJECT`, `LAN_GATE_LANG`, `DSH_PUSH_TURN_END`, `DSH_PUSH_EVENTS`, `DSH_PUSH_DEBOUNCE_MS`, `DSH_PUSH_SUMMARY`, `DSH_PUSH_TOOL`, `DSH_PUSH_LANG` (notification-copy override; without it `lang` decides), and `DSH_PUSH_APPROVAL_GRACE_MS` (how long to wait before pushing "approval pending" so a faster auto-approver's verdict wins; default 5000; it and the file-only `pushApprovalGraceMs` key are not part of the settings surface). `LAN_GATE_RELAY_SECRET` is **not** settable: the plugin mints it per load and hands it to the gateway itself.

The upload-size, keyboard-calibration and turn-fold knobs behave exactly as in 1.x — just moved from "plugin row YAML" to "settings page" (a hand-edited row works too).

---

## When notifications fire

By default only when you are **actually needed**, along two independent lines.

**1. Decided by the system (always on, never suppressed by the debounce)**

| Situation | Notification |
| --- | --- |
| A tool is waiting for your authorization | "DSH needs your approval", with the tool name |
| The model called `ask_user_question` and is waiting | "DSH is waiting for your answer" |

Neither looks at session depth — a subagent stuck on an approval still calls out, because it's still you it's waiting for. Neither is suppressed by the debounce either: "something needs your nod" is the one notification that must never be swallowed. Since 2.0.0 this includes sessions running inside the desktop app: the host-side hook fires wherever the session lives.

**Timing when a machine answers**: approval events arrive as "record asked → consult the answerer → record decided", so the push waits `DSH_PUSH_APPROVAL_GRACE_MS` (5 seconds by default) and skips anything answered within it. Raise it if you run a slower model-backed approver (measured: 2.4s average). Approvals a policy waves through don't disturb you.

**2. Decided by the model**

The `push_notify` tool. The model should call it when you explicitly asked to be told when something finished, when it needs you to continue, or when something unexpected happened that you'd probably want to know right away. The tool description also spells out when *not* to call it, and the same guidance is injected as standing session context from one shared constant, so the two cannot drift apart.

**What does not fire by default**: a plain finished turn does not push (set `pushTurnEnd` / `DSH_PUSH_TURN_END=1` for the old behaviour); a subagent finishing never pushes, regardless of that switch.

**What's in a notification**: by default the title only. With `pushSummary` the body carries this turn's final reply — prose only, never the reasoning; a turn that produced no prose falls back to "Last executed: <tool>". The push payload is aes128gcm end-to-end encrypted.

---

## Features

**Host (phone access, unchanged in spirit from 1.x)**

- Two-level page stack — session list home plus a standalone session page, pushed in and out horizontally
- Plugin entry chips on the home screen, appearing automatically for what you have installed, individually hideable
- Reworked composer: controls become icons, the permission and model menus become bottom sheets
- Session info card: six stats plus export log / rename / fork / archive; share-image export as ONE long PNG
- Turn-process folding, left-edge swipe back, Android back-gesture takeover, phone-local attachment upload
- A pairing code buys a long-lived device token; identity follows the token, not the IP, revocable at any time
- Real PWA + real Web Push (VAPID + aes128gcm), firing only for approvals and questions by default

**Host (2.0 additions)**

- Session sharing with three toggle entries, idle sleep, auto-share and subagent/fork following
- Everything above works when DSH runs as the **desktop app**: the gateway forwards to the desktop backend's real port automatically, and approval/question pushes fire for desktop sessions

**Desktop client (2.0 additions)**

- Remote groups in the sidebar ("server name · workspace name"), remote sessions open like local ones: full history, live progress, messages, cancels, queue edits, approvals and question answers, model selection, file tree, changes list plus changes summary/diff, goals, slash commands, agent presets, subagent prompts/interrupts, attachments and @ references, terminals running server-side
- New sessions created inside a remote group run on the server's workspace and are shared automatically; remote sessions can be renamed, archived, pinned, forked, and their remote access closed (with confirmation) from the client
- Title-row connection icon per remote session (online / offline / version differs); a "remote closed" banner with the reason when a session is slept or closed server-side; offline groups go grey with input disabled and reconnect automatically with backoff
- First-come-first-served approvals/questions: if the server's own UI answers first, the client syncs to "already handled"

In depth: [interface](docs/interface.md) · [public access + relay protocol](docs/remote-access.en.md)

---

## Version tolerance

Three layers, strictest first:

1. **Relay protocol version** must match — in practice, **both ends need zen-remote 2.0.x**. A 1.x server's gateway doesn't know the client's bearer token and answers its requests with the generic pairing wall, which the client reports as "token invalid (or the server's zen-remote is older than 2.0.0)". DSH versions may differ.
2. **DSH interface fingerprints** decide the rest: both ends compute normalized fingerprints of the remote-interface groups the relay uses and compare them at handshake. Identical is fully compatible even when version strings differ; a difference connects anyway, annotates the remote group "（版本有差异）" (version differs), lists the differing groups in the settings diagnostics, and degrades only the affected panels.
3. **Runtime degradation**: a forwarded call that fails parameter/result validation shows "incompatible with the server version" in that one panel and is recorded in the diagnostics — everything else keeps working.

---

## Security model

What a paired device is trusted with, stated plainly:

- **A paired desktop client is a trusted device.** The remote session's terminal is a shell running as the **server's user**, without the agent sandbox or approval restrictions. The file-preview interfaces (`workspaceFiles/read` and friends) are **not** contained to the session directory — anything the server process can read is readable. A paired client can create sessions in **any** of the server's workspaces (not limited to remote-enabled ones; the created session is auto-shared).
- **"Only remote-enabled sessions are visible" constrains session data**: an unshared session's list, history, live progress and approval/question events are refused or filtered by the relay; @-mention candidates list **only shared sessions**; and a `dsh-session:` reference embedded in a message, a queue edit or a slash command refuses the whole call when it names a session without remote access. It is not a sandbox around the machine.
- **Admin actions stay local**: generating pairing codes, changing roles and revoking devices only work from the settings page on the server machine itself — requests that arrived through the gateway can view status but are refused for every mutation, and desktop clients cannot reach the admin routes at all.

---

## Known limitations

- Switching to a different server and back to the original one — or a server deleting a workspace and recreating one under the same id — leaves the affected remote groups invisible until the client page is **reloaded** (DSH's sidebar never re-accepts a removed workspace id within one page lifetime).
- Attaching a **non-image file** in a remote session fails (DSH's file upload rides a request from inside a Web Worker, which the plugin cannot intercept). **Image** attachments work.
- "Export session" errors in a remote session; the changes panel's **summary and diff do work** (relayed), while the entries that would pop a dialog on the server machine — "open", "reveal in Finder", "open in app", on the changes panel and deliverable cards alike — are hidden there.
- The host truncates @-mention candidates to the **first 50 rows before** share-filtering: on a server with many sessions, a shared one may be missing from the candidate list (the reference check itself is unaffected — references you type out are still verified one by one).
- After the server restarts, a remote session's title / running state can lag behind until the next event or a page refresh.
- The model picker lists the **client's own** local model catalog.
- Third-party plugins' own non-standard endpoints are not forwarded — their panels degrade or hide in remote sessions.
- Same-machine testing must reach the gateway over a **LAN IP**, not `127.0.0.1`: a loopback connection without forwarded headers is treated as the local user and skips token checks entirely.
- Both ends need zen-remote **2.0.x** (identical relay protocol version). DSH versions may differ; interface differences are annotated "（版本有差异）".

---

## Known issues

**iOS 26.x standalone PWA viewport shrinkage**: after adding to the home screen, the viewport loses a status-bar's height at the bottom; an ordinary Safari tab is fine. This is an iOS defect — the missing region is outside the document and CSS cannot reach it. The plugin ships three layers of mitigation (light manifest background, safe-area compensation, forced reflow) which reduce it without guaranteeing a fix. Only quitting and reopening the whole app restores it fully.

**In a few environments the soft keyboard is completely invisible to the browser, and the lift falls back to an estimate**: in some combinations the system never tells the page the keyboard's height (visualViewport and the VirtualKeyboard API both fail; both ruled out by measurement). The fallback probes for ~1.2s after focus and lifts the input box by an estimated height when the keyboard is judged invisible. If the lift is visibly off, tune `keyboardLiftRatio` / `keyboardLiftMaxPx` / `keyboardSafetyPadPx` in the settings page. Normal environments never take this path.

**Settings pages don't open through the reverse proxy** (the plugin config list is blank, model cards report "settings are unavailable in this browser"): DSH's settings RPCs are loopback-only by design — a remote browser's settings mirror starts out `unavailable`. Workaround: change settings from a browser on the machine running DSH. The gateway-forwarded plugin settings page shows the same limitation. Nothing to do with this plugin.

---

## Permissions and data

- **Network**: the gateway listens on the local machine only (`127.0.0.1:3088` by default); what gets exposed is entirely up to your reverse proxy or tunnel. Push travels through the browser vendor's push service (aes128gcm end-to-end encrypted). The relay between a desktop client and the host runs over the same gateway; its authorization is re-checked per request server-side. The plugin itself reports nothing to any third party.
- **Files**: attachment uploads are written only to `.dsh-uploads/` inside the current session's working directory; pairing state lives in `~/.dsh/lan-gate-state.json`, config in `~/.dsh/lan-gate.config.json`, the share table in `~/.dsh/zen-remote-shares.json`, the server id in `~/.dsh/zen-remote-server.json`.
- **Credentials**: no account or password is ever collected or stored; a device's identity is a random token this plugin issues itself (HttpOnly cookie for web devices, a secret row field for desktop clients), plus a per-load relay shared secret that never leaves the machine pair.

Troubleshooting: runtime logs are in `~/.dsh/logs/web.log` (gateway and push lines are prefixed `[dsh-zen-remote-*]`; desktop builds print to the app console). Security issues: please report privately through GitHub Security Advisories rather than opening a public issue.

---

## Third-party plugins with mobile support

The mobile UI has specific adaptations for the plugins below. Every adaptation is anchored on that plugin's own DOM markers: if you don't have it installed the rules simply don't match, and installing a plugin that isn't listed here can't be caught in the crossfire.

| Plugin | What the mobile adaptation does | Version tested |
| --- | --- | --- |
| [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | 0.19+: all its tabs live in DSH 0.1.5's native right sidebar, which the host takes full screen on a phone (padded clear of the notch / home indicator) — the session header keeps an entry button for it, the left-edge swipe-back closes it, and tapping an @-reference in the file tree closes it. ≤ 0.18 (own right panel, DSH < 0.1.5 only): full-width phone drawer with notch safe area and a centred close pill | 0.19.1 (legacy rules: 0.15.0) |
| [@nanmicoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | The AgentTeams activity overlay moves below the session header (its original position covered the header buttons) and hides itself on the session list; a subagent session keeps a tappable parent-session title in its header for jumping back | 0.1.9 |
| [@ychris12138/dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats) | Usage and balance entries fold into the home-screen chips row | 0.2.9 |
| [@opendsh/dsh-plugin-scheduled-tasks](https://github.com/Ceelog/dsh-plugins) | The scheduled-tasks entry folds into the home-screen chips row | 0.2.3 |
| dsh-at-file | `@` file references, used alongside attachment upload's `@` paths. It and this plugin's attachment chips read the same draft token, so on the phone its `.dsh-uploads/` rows are hidden to stop one file being drawn twice (thumbnail plus filename); other `@` references are left alone | 0.6.7 |
| [@ace-zone/dsh-market](https://www.npmjs.com/package/@ace-zone/dsh-market) | The plugin market dialog's top bar doesn't fit on a phone and the × gets squeezed out of the panel (no Esc on a touchscreen, so it can't be closed at all). Three decorative slots — tagline, version, homepage link — are hidden, the title shrinks with an ellipsis, and the language switch and × stay with a bigger tap target | 0.1.66 |
| [dsh-vision-toolkit](https://www.npmjs.com/package/@anionex/dsh-vision-toolkit) | Image Q&A / OCR, used with phone-side attachment upload | — |
| [dsh-web-ui suite](https://www.npmjs.com/package/@linxin666/dsh-web-ui-all) | Inherits the compatibility rules from upstream dsh-web-mobile (file tree, width-capped centred preview overlay, and so on) | — |

The technical detail behind each adaptation — anchor selectors, breakpoints, what was traded away — is in the "compatible plugins" section of the [interface doc](docs/interface.md).

---

## Upstream credits

This plugin's interface layer derives from [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile), and its channel layer from [zylzyqzz/dsh-mobile-pwa](https://github.com/zylzyqzz/dsh-mobile-pwa) (itself derived from [Bernardxu123/dsh-mobile-gate](https://github.com/Bernardxu123/dsh-mobile-gate)), both MIT. The original copyright lines are preserved in [LICENSE](LICENSE).

## License

[MIT](LICENSE)
