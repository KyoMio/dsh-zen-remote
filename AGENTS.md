# AGENTS.md — Guide for AI agents

This file helps AI coding agents and LLM tooling understand and work in this repo.

## What this repo is

`dsh-mobile-pwa` is a **Cordis plugin for DeepSeek Harness (DSH)** that turns the DSH
Web UI into a complete mobile **PWA**. It runs a **standalone Node gateway child
process** that securely exposes the local DSH Web UI to the public internet behind
the user's own TLS-terminating reverse proxy, and injects PWA capability (manifest,
service worker, touch layout, gestures, agent-done push) into the served HTML.

- Trust model (v2): device identity is a pairing token (cookie `lg_device`), not
  source IP. New devices redeem a short-lived, one-time pairing code (generated
  from the local admin page) for a long-lived token; wrong codes are rate-limited
  and lock out.
- Gateway listens on `127.0.0.1:3088` by default (`LAN_GATE_HOST`); reverse-proxies
  paired devices to `127.0.0.1:3080` (`LAN_GATE_TARGET_PORT`). `X-Forwarded-For`/
  `X-Forwarded-Proto` are honored only when the socket peer is loopback (same-host
  proxy) or listed in `LAN_GATE_TRUSTED_PROXIES`.
- The only IP-based trust left: a loopback socket carrying no `X-Forwarded-*`
  headers is the local user — the sole path into the admin surface (admin page,
  `/lan-gate/status`, `/lan-gate/action`, `/lan-gate/pair`, `/pwa/push/send`).
- DSH's own webserver stays `127.0.0.1` — the gateway never touches DSH config or
  its `/api` trust fence.

## Layout

| Path | Role |
| --- | --- |
| `lan-gate.mjs` | Cordis entry. `inject: ['subprocess']`; resolves `node`, spawns `lib/lan-gate-server.cjs`, wires disposal via `ctx.effect`. Never import the server into the DSH process. |
| `dsh-push.mjs` | OPTIONAL agent-done push host plugin. `inject: []`; subscribes to DSH event-bus names from `DSH_PUSH_EVENTS` (default `agent/turn-stopping`, the official turn-close checkpoint), debounced, POSTs to the gateway's local `/pwa/push/send`. Notification body carries no conversation content by default; `DSH_PUSH_SUMMARY=1` opts into including the turn's final assistant message (payload is aes128gcm end-to-end encrypted). Must never throw. |
| `lib/lan-gate-server.cjs` | The gateway. Single-file CommonJS, **Node stdlib + one runtime dependency (`web-push`)**. HTTP + WebSocket reverse proxy, pairing-code/token state machine, rate limit, admin page, real Web Push (VAPID + aes128gcm), and **HTML PWA injection** + `/pwa/*` static serving + `/pwa/push/*`. |
| `pwa/manifest.json` | PWA install manifest. |
| `pwa/sw.js` | Service worker: cache strategies + push notifications. |
| `pwa/inject.js` | Injected page bootstrap: SW register, gesture loader, push subscribe. |
| `pwa/touch-gestures.js` | Edge-swipe back / pinch-zoom. |
| `pwa/app.css` | Mobile touch-first CSS (< 44px targets, safe-area, compact type). |
| `pwa/offline.html` | Offline fallback page. |
| `pwa/icons/` | SVG source + rasterized PNGs (192/512 + maskable). |
| `cordis.patch.yml(.example)` | Bundle patch layer / static-mount example. |
| `docs/spec-public-auth-push.md`, `docs/plan-public-auth-push.md` | Design spec and implementation plan for the public-auth-push rework. |
| `test/gateway.test.cjs` | Smoke tests: gateway boot, `/pwa` asset serving, HTML injection (boots gateway behind a mock upstream). |
| `test/auth.test.cjs` | Pairing flow, token cookie, lockout on repeated wrong codes, v1-state-file archival, device survival across restart. |
| `test/push.test.cjs` | Push subscribe/send, VAPID-signed encrypted delivery, expired-subscription (404/410) cleanup. |
| `test/util.cjs` | Shared test harness (spawns the real gateway + a mock upstream, HTTP request/pairing helpers) — not a test file itself. |

## Key behaviours — don't break these

1. **Isolation**: the gateway is a child process. Never import its server code into
   the DSH process; keep spawn + lifecycle in `lan-gate.mjs`.
2. **`pwa/` serves the real browser scripts**: `/pwa/manifest.json`, `/pwa/sw.js`,
   `/pwa/app.css`, `/pwa/icons/*` are served from disk (read via `servePwaAsset`).
   The service worker MUST live at a fixed path (`/pwa/sw.js`) for registration to
   scope correctly.
3. **Scope mobile CSS**: every mobile rule must be prefixed with
   `html:not([data-lan-device="desktop"])`, never the literal `[data-lan-device=
   "phone"]` value — a real paired phone defaults to kind "auto" and never
   carries that attribute, so a literal-phone gate silently never fires on an
   actual device (see `pwa/app.css`'s header comment and `lib/lan-gate-server.cjs`
   near `injectHtml` for the history). Desktop must never be affected.
4. **Stable selectors**: prefer `[data-slot]`/ARIA selectors over hashed build class
   names (`Sh0Q9G_` etc.), which change per frontend build.
5. **Persistence**: devices, VAPID keys, and push subscriptions are stored at
   `~/.dsh/lan-gate-state.json` (v2 schema, `{version:2, devices, vapid,
   pushSubscriptions}`). The pairing code itself is memory-only on purpose — a
   restart voids any outstanding code. A v1 (per-IP-approval) state file is
   detected and archived to `.v1.bak` on load, never migrated.
6. **Local-only admin**: `/lan-gate/status`, `/lan-gate/action`, `/lan-gate/pair`,
   `/lan-gate/admin`, `/pwa/push/send` must reject any request whose socket isn't
   loopback or that carries `X-Forwarded-*` headers (403). `/lan-gate/pair/claim`
   is the deliberate exception — reachable by anyone, guarded by the code's TTL/
   single-use and the per-IP failure lockout instead.
7. **Port fallback**: on `EADDRINUSE`, server increments the port (up to +20).
8. **Injection quoting**: the HTML-injected inline CSS/JS strings in
   `lib/lan-gate-server.cjs` are JS string literals — keep quote usage consistent
   (historical bug: double quotes inside double quotes broke the injected script).

## Common tasks

- **Change port / rate / target**: top-of-file constants in
  `lib/lan-gate-server.cjs` or env vars `LAN_GATE_PORT`, `LAN_GATE_HOST`,
  `LAN_GATE_TARGET_PORT`, `LAN_GATE_RATE_LIMIT`, `LAN_GATE_TRUSTED_PROXIES`,
  `LAN_GATE_VAPID_SUBJECT`.
- **Add a mobile CSS tweak**: mobile *layout* (typography, dialogs, composer
  chrome, popovers, touch targets) belongs to the separate
  `@dsh-external/dsh-mobile-nav` plugin, not this repo. `pwa/app.css` only
  keeps PWA-shell-level rules (browser-behavior workarounds, this plugin's
  own gesture CSS) — see its header comment before adding anything here.
  There is no second inline CSS block in `lib/lan-gate-server.cjs` any more;
  `pwa/app.css` (loaded via the injected `<link>`) is the only place.
- **Change injected page behaviour**: edit `pwa/inject.js` (wired into the injected
  bootstrap) and touch gestures in `pwa/touch-gestures.js`.
- **Change PWA metadata/icons**: edit `pwa/manifest.json` and `pwa/icons/*`; re-run
  `rsvg-convert` if you change the SVG.

## Testing

```bash
npm test
```

Runs `node --test test/*.test.cjs`, booting the real `lib/lan-gate-server.cjs`
behind a mock DSH upstream (isolated temp `DSH_HOME`) and driving it over real
HTTP: `gateway.test.cjs` covers `/pwa` asset serving, HTML injection, and status
reporting; `auth.test.cjs` covers the pairing flow, tokens, lockout, and v1-state
archival; `push.test.cjs` covers subscribe/send and VAPID-encrypted delivery.
Simulated remote clients use `X-Forwarded-For`/`X-Forwarded-Proto` headers on a
loopback socket (the same shape a same-host reverse proxy produces), so the full
"public device" path is exercised without a second real machine.
