# Zen Remote Self-Hosted Relay Gateway (`gateway-server`)

> [中文文档](README.zh-CN.md)

The **standalone self-hosted gateway** for the `dsh-zen-remote` plugin: a self-hosted virtual-network relay server + Web management console. Deploy this only when you want to link multiple computers (or a team) into a self-hosted peer mesh; the plugin's built-in phone QR pairing and desktop-client host pairing work without this service.

It performs four core jobs:

- **Virtual network management**: create virtual networks in the Web console, generate `zr-net://` invite links, and manage devices; each network carries an independent peer limit (default `8`, configurable `2–64`), with defaults and relay rate limits configurable via console or environment variables.
- **Five-state member admission**: every member sits in `pending`, `authorized`, `paused`, `mismatch`, or `revoked`; new machines join by invite passphrase, manual approval, or both, while the console displays live online states and per-pair connection paths (`LAN direct` / `P2P direct` / `Gateway relay`).
- **NAT hole-punch coordination**: dual UDP ports (primary + secondary) perform STUN-style reflection and NAT hole-punch coordination so peers establish direct connections whenever possible; only unpunchable traffic falls back to the relay.
- **Zero-knowledge ciphertext relay**: the gateway only sees the 28-byte cleartext routing header on relayed frames; session payloads are end-to-end encrypted between peers (ephemeral X25519 + AES-256-GCM), so **the gateway holds no session keys and cannot read any session content**.

---

## Quick Deploy (Docker, Recommended)

### Option A: Docker Compose (Prebuilt Multi-Arch Image, Recommended)

Use [docker-compose.yml](docker-compose.yml) (pulls `kyomio/zen-remote-gateway:latest` for `linux/amd64` and `linux/arm64`, with an optional PostgreSQL service block commented inside):

```sh
mkdir -p ./certs && sudo chown 100:101 ./certs   # Linux: let non-root user zr write uploaded certs (skip if mounting :ro)
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/KyoMio/dsh-zen-remote/main/gateway-server/docker-compose.yml
# Optional: edit docker-compose.yml to set ZR_GATEWAY_PUBLIC_URL (or configure it later in the Web console)
docker compose up -d
docker compose logs -f zr-gateway
```

To pin a release instead of `latest`, change `image:` to `kyomio/zen-remote-gateway:0.1` or `kyomio/zen-remote-gateway:0.1.0`.

### Option B: `docker run` / Local Image Build

```sh
# Pull the prebuilt image (or build locally from ./gateway-server: docker build -t kyomio/zen-remote-gateway:latest ./gateway-server)
docker run -d --name zr-gateway \
  --restart unless-stopped \
  -p 19393:19393/tcp \
  -p 19393:19393/udp \
  -p 19394:19394/udp \
  -e ZR_GATEWAY_PUBLIC_URL=https://zr.example.com \
  -v zr-gateway-data:/data \
  -v $(pwd)/certs:/certs \
  kyomio/zen-remote-gateway:latest
```

- `-e ZR_GATEWAY_PUBLIC_URL`: set this to the external URL peers and browsers will use to reach the gateway (for an external HTTPS reverse proxy on port `443`, use `https://zr.example.com`; for built-in single-port native TLS on `19393`, use `https://zr.example.com:19393`; you can also omit it for local LAN testing or hot-configure it later in the Web console).
- **Ports**: `19393/tcp` (Web console + WebSocket, supports built-in HTTPS/WSS), `19393/udp` (primary STUN port), and `19394/udp` (secondary STUN port). **Map TCP and UDP separately.** The primary UDP port handles reflexive address discovery; the secondary UDP port refines NAT classification (without the secondary port, classification falls back to unknown while direct hole-punching and relay fallback still work). Peers discover the advertised probe ports from the gateway's welcome message — keep config, port mappings, and firewall rules aligned when changing ports; TCP reverse proxies do not forward UDP.
- **Data volume & certificate directory**: the container runs as non-root (`zr`, `uid=100:gid=101`) with `/data` and `/certs`. A named volume (`-v zr-gateway-data:/data`) is recommended (Docker initializes volume ownership automatically). When bind-mounting a host directory on Linux (`-v $(pwd)/data:/data`), run `mkdir -p ./data && sudo chown 100:101 ./data` first. Preserve `/data` across upgrades: it holds both the SQLite database and the auto-generated `master.key` (`0600`).
- **Certificate mount permissions (`-v $(pwd)/certs:/certs`)**:
  - To upload or paste PEM certificates in the Web console and save `fullchain.pem` / `privkey.pem`, make `./certs` writable by `100:101` (`mkdir -p ./certs && sudo chown 100:101 ./certs`).
  - If certificates are managed externally on the host (e.g. `acme.sh` / `certbot`), a read-only mount (`-v /path/to/live/domain:/certs:ro`) works as well: select the certificate files in the console and enable TLS, and the gateway will hot-reload automatically whenever renewed files overwrite disk copies.
  - On first boot against an empty directory, the gateway starts in plain HTTP unless a valid `fullchain.pem` + `privkey.pem` pair already exists in `/certs`, in which case native TLS activates automatically.
- **Retrieve the initial admin password from container logs**:

  ```sh
  docker logs zr-gateway
  # Zen Remote gateway ready
  #   console  http://127.0.0.1:19393/
  #   udp      19393/udp + 19394/udp
  #   admin    admin@local
  #   initial password (shown once, change it after login): <16-char password>
  ```

  The initial password is **printed once** — change it inside the console right after signing in (or pre-set `ZR_GATEWAY_ADMIN_PASSWORD`).

## Source Build (Node.js 22.5+)

Without Docker, inside `gateway-server/`:

```sh
pnpm install
pnpm build
node --experimental-sqlite dist/main.js
```

- Requires Node.js **22.5+** (uses built-in `node:sqlite`; older Node 22 releases require `--experimental-sqlite`).
- `pnpm build` compiles the console frontend into `dist/public`, served directly by the gateway process with no external web server required.
- Keeping `--experimental-sqlite` when passing `ZR_GATEWAY_DATABASE_URL` for PostgreSQL is harmless.

---

## Environment Variables

All optional; defaults apply when omitted. Invalid configuration values fail fast on startup rather than running degraded.

| Variable | Default | Description |
| --- | --- | --- |
| `ZR_GATEWAY_PORT` | `19393` | Primary port (`1–65535`): TCP serves the Web console & `/peer/v1/ws` WebSocket; UDP on the same port is the primary STUN socket |
| `ZR_GATEWAY_UDP_ALT_PORT` | primary + 1 (`19394`) | Secondary UDP port (`1–65535`) for NAT classification; set `0` to disable (lowers direct hole-punch success rate, not recommended) |
| `ZR_GATEWAY_PUBLIC_URL` | *(empty)* | External public URL without a trailing slash (e.g. `https://zr.example.com` or `https://zr.example.com:19393`), used to build `zr-net://` invite links |
| `ZR_GATEWAY_DATA_DIR` | `./data` (`/data` in Docker) | Data directory storing SQLite DB and `0600` `master.key` |
| `ZR_GATEWAY_CERT_DIR` | `./certs` (`/certs` in Docker) | TLS certificate directory (`fullchain.pem` / `privkey.pem` or other selectable PEM files) |
| `ZR_GATEWAY_DATABASE_URL` | *(empty)* | PostgreSQL connection string; omit to use built-in SQLite (WAL mode) |
| `ZR_GATEWAY_ADMIN_USER` | `admin@local` | Initial administrator login email / username |
| `ZR_GATEWAY_ADMIN_PASSWORD` | *(empty)* | Initial admin password; omit on first empty-DB boot to generate a random 16-char password once in startup logs |
| `ZR_GATEWAY_ALLOW_SIGNUP` | `false` | Set `true` or `1` to enable self-service signup (also toggleable live in the console) |
| `ZR_GATEWAY_MAX_PEERS` | `8` (`2–64`) | Default max members per **newly created** virtual network |
| `ZR_GATEWAY_MAX_NETWORKS_PER_USER` | `3` (`1–50`) | Initial max virtual networks per standard account |
| `ZR_GATEWAY_RELAY_RATE_KBPS` | `4096` (`64–1048576`) | Per-member relay rate cap (KB/s, `1024 B/s`); direct peer traffic does not traverse the gateway |

---

## Initial Configuration, Capacity & Telemetry

Environment defaults for signup, max networks per user, default max peers, and relay rate only populate database settings when those keys do not yet exist. Values saved in the Web console take precedence across restarts (`SQLite` and `PostgreSQL` behave identically).

Network `maxPeers` counts the local machine itself: a peer mounts up to `maxPeers - 1` remote devices by default, further bounded by any local `maxServers` cap. Authorized, paused, and identity-blocked (`mismatch`) members occupy seats; pending and revoked entries do not. Lowering `maxPeers` keeps existing mounts intact while blocking new seats; changing the default max peers applies only to newly created networks.

Each network also defines a **Direct Max RTT** (`peerDirectMaxRttMs`, editable per network in the console; integer `0–10000` ms, default `300`, `0` = unlimited): when measured direct RTT stays above this threshold, traffic demotes to gateway ciphertext relay, and upgrades back only after two consecutive samples `≤ 0.7×` the cap. The gateway pushes this threshold in welcome payloads and live network updates so all peers apply the same rule without rejoining or maintaining separate local overrides.

The console displays locally rejected identities as *"Blocked"* (*已阻断*), unknown RTT as `—`, and measured sub-millisecond RTT as `0 ms`. Overview cards, device list rows, and device details apply **strict bilateral direct merging**: a pair counts as direct only when both sides report direct links; if one side reports relay or has not yet reported while the other reports direct, both display *"Relayed via gateway"* with `—` latency, and fully direct devices never show a simultaneous *"Relaying"* badge. Rates use 5-second sliding windows where `KB/s` = `1024 B/s` (legacy `Kbps` API field names are retained for compatibility and do not denote kilobits/s). The active network's header stays live over SSE; visible admin pages poll online counts and relay rates every 3 seconds without overlapping slow requests and cancel polling when hidden or closed.

## Native TLS (Recommended) & Reverse Proxy Notes

### 1. Built-In Single-Port Native TLS (No Proxy Needed, Keeps `19393` + Dual UDP Ports)

`gateway-server` includes single-port native TLS on `19393/tcp` (auto-multiplexing plaintext HTTP and TLS on the same TCP port without needing an external Nginx/Caddy layer or changing `19393/udp` + `19394/udp`):

1. **Two ways to supply certificates**:
   - **Mount a cert directory**: mount `fullchain.pem` and `privkey.pem` (or other PEM files) into `/certs` (`ZR_GATEWAY_CERT_DIR`). If both default files are valid on first empty boot, HTTPS/WSS enables automatically; overwriting renewed certificates triggers debounced hot reload.
   - **Upload & toggle live in the console**: sign in → **Gateway Admin → TLS & Certificates**, upload/paste PEM certs into `/certs` (requires write access), switch active files from the dropdown, or **hot-toggle HTTP / HTTPS without restarting the container**.
2. **Cleartext & encrypted routing**: when TLS is enabled, browser `http://` visits to `19393/tcp` receive `302 Found` redirects to `https://` (no HSTS / permanent cache, so disabling TLS later never locks browsers out), while cleartext calls to `/api/*`, `/peer/*`, or plain WebSocket upgrades are rejected with `426 TLS_REQUIRED`.
3. **Fail-closed startup guard**: if TLS is enabled and the active certificate files are missing or corrupt on restart, the gateway exits with a clear error rather than silently downgrading to plaintext HTTP (expired certificates still permit HTTPS startup so an administrator can sign in and replace them).

### 2. Optional External Reverse Proxy & UDP Firewall Pass-Through

If you must share port `443` behind an external Nginx/Caddy proxy, keep built-in TLS off and set `ZR_GATEWAY_PUBLIC_URL` to the public `https://…` URL:

1. **Allow WebSocket upgrades (`/peer/v1/ws`)**:
   ```nginx
   location /peer/v1/ws {
       proxy_pass http://127.0.0.1:19393;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_read_timeout 3600s;   # keep persistent WS alive past Nginx's 60s default
   }
   ```
   Caddy's `reverse_proxy` handles WebSockets out of the box.
2. **Disable proxy buffering on SSE**: live topology updates use `/api/v1/networks/<networkId>/events` (`text/event-stream`). In Nginx, add `proxy_buffering off;` on that location (Caddy streams SSE unbuffered by default).
3. **Open UDP in the host firewall / cloud security group**: `19393/udp` and `19394/udp` must remain reachable directly (and mapped in Docker) regardless of whether TLS terminates on the gateway or an external proxy — TCP proxies cannot forward UDP STUN probes.
4. **Set the public URL**: configure `ZR_GATEWAY_PUBLIC_URL` (or set it live under **Gateway Settings**) so generated `zr-net://` links carry the exact external origin and port.

---

## Three Steps After Deployment

1. **Sign in to the console**: open `http://<host>:19393/` and log in with `admin@local` and the initial password printed in container logs (change it after logging in).
2. **Create a virtual network**: choose the peer seat limit and admission policy (invite passphrase / manual approval / both) to obtain a `zr-net://…` invite link.
3. **Share the link with your machines**: in each computer's `dsh-zen-remote` setup wizard, pick **Peer Node** and paste the link (for manual approval networks, approve pending machines from the network page).

For plugin-side setup and E2EE transport details, see **Scenario C** in [../README.md](../README.md) and [../docs/remote-access.en.md](../docs/remote-access.en.md).

---

## Invite Link Format (`zr-net://`)

The console issues a single canonical URI format:

```
zr-net://<host>[:<port>]/<networkId>[?tls=0|1][#<joinKey>]
```

- `<networkId>` is always 16 lowercase hex characters. Copying the full link includes `#<joinKey>`, while manual-approval networks also work without the `#<joinKey>` fragment.

Invite keys expire after **7 days** and authorize at most **10 devices** by default. Creation and key rotation accept `inviteTtlHours` (integer `1–720`, default `168`) and `inviteMaxUses` (integer `1–1000`, default `10`). The console shows expiry and usage and can regenerate the link, resetting its usage. Existing members can reconnect after expiry or exhaustion; manual approvals do not consume uses. Existing links receive a seven-day grace period when upgrading.
- **Omitting the port defaults to `19393`**. When behind standard ports (`https://` `443` or `http://` `80`), generated links explicitly include `:443` or `:80`.
- `?tls=0|1` appears whenever transport differs from default host inference: loopback, RFC 1918 private IPv4 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local, IPv6 ULA, CGNAT/Tailscale (`100.64.0.0/10`), and `.local` / `.lan` default to cleartext (`?tls=1` if fronted by TLS); public hosts/domains default to TLS (`?tls=0` for cleartext public IP).
- Peers still accept legacy `zr-net+insecure://` and `zr-nets://` links on input, while all generated links use `zr-net://`.
- **No insecure-TLS bypass**: whenever a link resolves to TLS, peers require verified `wss://` / `https://` and never fall back silently. Non-blocking security banners appear in **Gateway Admin** if the public URL lacks HTTPS, the secondary UDP port is disabled, or TLS certificates are expiring/invalid.

## Admin Account & Account Settings

A default admin account (`admin@local` or `ZR_GATEWAY_ADMIN_USER`) is created automatically on first empty boot. Use **Account Settings…** in the top-right user menu to:

- **Change password**: immediately revokes all other active sessions for your account while keeping your current browser signed in.

New passwords (signup, reset, account change, and administrator-assigned passwords) must be **10–128 characters**, must not be common passwords, use fewer than four distinct characters, be entirely consecutive ascending/descending characters, or contain the email local part when it is at least four characters long. Existing passwords still work for login, and the bootstrap admin environment password is not subject to this policy. Signup code requests return the same success for registered and unregistered addresses without sending mail to registered addresses. With verification disabled, failed duplicate signups return a generic error. All signup attempts are limited to 20 per client IP per 15 minutes, regardless of the email verification setting.
- **Change email**: changes directly with your current password when SMTP is unconfigured, or via a 6-digit verification code sent to the new address once SMTP is configured.

## Web Admin Console

Admins access **Gateway Admin** from the top bar, organized into six functional tabs alongside a read-only runtime header and security banners:

- **Users**: create accounts (with optional auto-generated 16-char password shown once), reset passwords (shown once and clears all old sessions), enable/disable/delete accounts, and manage group assignment & expiration.
- **User Groups**: create/edit user groups and switch the default signup group (default and in-use groups cannot be deleted).
- **Gateway Settings**: hot-edit the public URL (`publicUrl`, takes effect immediately on new invite links without restart; falls back to `ZR_GATEWAY_PUBLIC_URL`, then request headers), self-signup toggle, email verification toggle, default group, and session TTL (`1–90` days).
- **TLS & Certificates**: inspect active certificate domain, issuer, remaining validity, and SHA-256 fingerprint; hot-toggle single-port native TLS; select files from `ZR_GATEWAY_CERT_DIR` or reload from disk; or upload/paste `fullchain.pem` and `privkey.pem` directly.
- **Email Service**: live SMTP configuration and test-email delivery (`TLS` / `STARTTLS` / plaintext; SMTP credentials are encrypted at rest with AES-256-GCM and never echoed back).
- **API Keys**: generate, rotate, or revoke the administrator API key for programmatic management.

## Upgrades & Graceful Recovery

Back up both the database and `master.key` before upgrading the gateway, then upgrade peer plugins machine by machine (updating the desktop plugin alone does not update the standalone gateway container).

### In-container hot-updates & 15s automatic rollback

The container starts via `dist/bootstrap.js` (PID 1 supervisor) and supports in-container JS/Web hot-updates without exiting or recreating the container:

- **One-click & idle auto-update**: In **Gateway Admin**, you can check for updates and click **Update now**, or enable **Auto-update gateway while idle** (enabled by default; checks every 12 hours and applies verified compatible releases after confirming zero live relay throughput twice at a 5-second interval).
- **Release cache & retention (`/data/releases`)**: Hot-update bundles (`zen-remote-gateway-bundle.tar.gz`) are verified against the official GitHub Release SHA-256 digest (third-party mirror fallback is skipped whenever an official digest is absent), preflight-checked with `node --experimental-sqlite <staged>/dist/main.js --self-check`, and stored under `/data/releases/versions/<ver>` (retaining only the active and previous 2 generations). On startup, `bootstrap.js` always prefers whichever is newer between `/data/releases` and the container's base image (`baseVersion`).
- **15s startup health confirmation & automatic rollback**: After hot-swapping (`exit 75`), the new gateway must send `zr-gateway-ready` within 15 seconds; otherwise `bootstrap.js` kills it, rolls `state.json` back to the previous working version (or base image), restarts immediately, and surfaces a dismissible rollback banner in the admin console.
- **When `docker compose pull` is still required**: If a release increments `baseCompatEpoch` or `minNodeMajor` (native SQLite/Node ABI or supervisor changes), or when running outside `bootstrap.js`, the console prompts you to run `docker compose pull && docker compose up -d`.

Paused peers keep a restricted control connection alive so resuming does not require re-joining. Initial hole-punching falls back to relay after ~1s, lost direct routes detect timeouts after 15s from the last valid packet, and relayed sessions re-probe for direct paths with `3s → 8s → 25s` progressive backoff (promoting in ~0.3s after handshake + `200ms` fast confirm under the RTT cap). The WebSocket control plane runs `10s` Ping / `15s` Pong keepalives to reap half-open connections quickly and propagates monotonic `connSeq` epochs so both sides symmetrically re-anchor after reconnects. Known-length uploads allow an extra 20s recovery window subject to reachability.

On `SIGTERM` / `SIGINT`, the gateway stops accepting new connections, flushes final telemetry within a 5s shutdown budget (up to 4s extra cleanup grace on error), and closes the database cleanly; set container stop grace periods accordingly.

## Data & Backups

- By default, `/data` stores both the SQLite database (`WAL` mode) and `master.key` (`0600`). Back up by stopping the container and copying the entire directory; losing `master.key` invalidates stored credentials.
- With PostgreSQL (`ZR_GATEWAY_DATABASE_URL`), back up PostgreSQL using standard DB tooling and preserve `master.key` from the data directory.
