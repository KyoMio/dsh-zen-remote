# Zen Remote 自建中继网关（gateway-server）

`dsh-zen-remote` 插件的**独立自建网关**：一台自托管的虚拟网络中继服务 + Web 管理控制台。只在你要为自己的多台电脑（或一个团队）搭一条自建组网通道时才需要部署它；只用插件本体的手机扫码 / 桌面配对功能不需要这个服务。

它做四件事：

- **虚拟网络管理**：Web 控制台里创建虚拟网络、生成 `zr-net://` 邀请链接、管理成员；普通账号可建多个网络（上限可配），每个网络有独立的成员上限（默认 8，可配 2–64）。
- **五态成员准入**：每个成员处于 `待审批` / `已授权` / `已暂停` / `身份变更` / `已吊销` 五种状态之一；新设备入网支持口令邀请、人工审批或两者组合，控制台实时显示在线状态与每对设备间的连接路径（局域网直连 / 打洞直连 / 网关中转）。
- **打洞协调**：双 UDP 端口（主口 + 辅口）做 STUN 式探测与 NAT 打洞协调，帮网内设备尽量建立直连；直连打不通的流量才落到网关中转。
- **零知识密文中转**：网关只看到密文帧的路由头（28 字节），会话内容是节点之间端到端加密的（临时 X25519 + AES-256-GCM），**网关不持有任何会话密钥，看不到任何会话内容**——管理员在控制台里看到的是成员与连接状态，不是数据本身。

---

## 快速部署（Docker，推荐）

```sh
docker build -t zr-gateway ./gateway-server

docker run -d --name zr-gateway \
  --restart unless-stopped \
  -p 19393:19393/tcp \
  -p 19393:19393/udp \
  -p 19394:19394/udp \
  -v zr-gateway-data:/data \
  zr-gateway
```

- 端口：`19393/tcp`（Web 控制台 + WebSocket）、`19393/udp`（STUN 主口）、`19394/udp`（STUN 辅口）。**TCP 与 UDP 都要映射**——少了 UDP 口，打洞协调不工作，所有设备都只能走中转。
- 数据卷：镜像以非 root 用户（`zr`，`uid=100:gid=101`）运行，数据目录固定为 `/data`。推荐使用命名卷 `-v zr-gateway-data:/data`（Docker 首挂自动继承镜像内 `zr:zr` 属主）；若在 Linux 宿主机改用目录挂载（`-v $(pwd)/data:/data`），请先执行 `mkdir -p ./data && sudo chown 100:101 ./data`。升级镜像时保留该卷或目录即可，SQLite 库与自动生成的 `master.key`（权限 `0600`）都在里面。
- **首次启动看日志拿管理员密码**：

  ```sh
  docker logs zr-gateway
  # Zen Remote gateway ready
  #   console  http://127.0.0.1:19393/
  #   udp      19393/udp + 19394/udp
  #   admin    admin@local
  #   initial password (shown once, change it after login): <16 位随机密码>
  ```

  初始密码**只打印这一次**，登录后请立即在控制台里改掉。想自己指定，见下方 `ZR_GATEWAY_ADMIN_PASSWORD`。

## 源码构建启动（Node.js 22.5+）

不用 Docker 时，在本目录（`gateway-server/`）里：

```sh
pnpm install
pnpm build
node --experimental-sqlite dist/main.js
```

- 需要 Node.js **22.5 或更高**（内置 `node:sqlite` 模块，Node 22.x 下要带 `--experimental-sqlite` 标志）。
- 控制台前端已随 `pnpm build` 一并编译进 `dist/public`，由网关进程自己托管，不需要额外的静态服务器。
- 若配置了 `ZR_GATEWAY_DATABASE_URL` 走 PostgreSQL，`--experimental-sqlite` 标志留着也无害。

---

## 环境变量

全部可选；不设就用默认值。配置错了（比如整数越界）网关会**启动期直接报错退出**，不会带病运行。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ZR_GATEWAY_PORT` | `19393` | 主端口（1–65535）：TCP 承载 Web 控制台与 `/peer/v1/ws` WebSocket，同端口号的 UDP 承载 STUN 主口 |
| `ZR_GATEWAY_UDP_ALT_PORT` | 主端口 + 1（即 `19394`） | 辅助 UDP 口（1–65535）：用于对端 NAT 类型探测；设 `0` 关闭（关闭后打洞成功率下降，不推荐） |
| `ZR_GATEWAY_PUBLIC_URL` | （空） | 反向代理后的对外 URL（不带末尾斜杠，如 `https://zr.example.com`）；设置后邀请链接用这个域名拼接。不设则用本机地址 |
| `ZR_GATEWAY_DATA_DIR` | `./data` | 数据目录：SQLite 库与 `0600` 权限的 `master.key`。Docker 镜像里固定为 `/data` |
| `ZR_GATEWAY_DATABASE_URL` | （空） | PostgreSQL 连接串；未设则使用内置 SQLite（WAL 模式）。小规模部署用默认 SQLite 即可 |
| `ZR_GATEWAY_ADMIN_USER` | `admin@local` | 初始管理员登录名 |
| `ZR_GATEWAY_ADMIN_PASSWORD` | （空） | 初始管理员密码；未设则首次初始化随机生成 16 位并打印到启动日志（只显示一次）。仅在**空库首次启动**时生效，已有库不受影响 |
| `ZR_GATEWAY_ALLOW_SIGNUP` | `false` | 设 `true` 或 `1` 开放自助注册；之后也可以在 Web 控制台里随时开关 |
| `ZR_GATEWAY_MAX_PEERS` | `8`（范围 2–64） | **新建**虚拟网络的默认成员上限（建网时可在控制台单独调整） |
| `ZR_GATEWAY_MAX_NETWORKS_PER_USER` | `3`（范围 1–50） | 普通账号可创建的虚拟网络数上限 |
| `ZR_GATEWAY_RELAY_RATE_KBPS` | `4096`（范围 64–1048576） | 单成员的中转限速（KB/s），只限制经网关中转的流量，直连流量不经过网关 |

---

## 反向代理与防火墙注意事项

网关自身不内置 TLS。只在内网使用可以直接访问 `http://<主机>:19393/`；要公网或 HTTPS 访问，请在前面套一层 Nginx / Caddy，并注意：

1. **WebSocket 要放行升级**：节点端连网关走 `/peer/v1/ws`。Nginx 示例：

   ```nginx
   location /peer/v1/ws {
       proxy_pass http://127.0.0.1:19393;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_read_timeout 3600s;   # 长连接，别让默认 60s 掐断
   }
   ```

   Caddy 的 `reverse_proxy` 天然支持 WebSocket，无需额外配置。

2. **SSE 别开缓冲**：控制台的实时拓扑走 `/api/v1/networks/<网络id>/events`（`text/event-stream`）。Nginx 对这条路径要 `proxy_buffering off;`，否则状态刷新会卡住不动。Caddy 默认不缓冲，无需处理。

3. **UDP 防火墙直通**：宿主机防火墙（以及云厂商安全组）必须放行 `19393/udp` 与 `19394/udp`，容器端口映射也要保留 UDP。UDP 不通时打洞无法进行，网内设备全部退化为网关中转（功能不受影响，只是直连提速没了）。

4. **设置对外地址**：套了反代后，把 `ZR_GATEWAY_PUBLIC_URL` 设为对外的 `https://…` 地址，这样控制台生成的邀请链接才会带正确的对外域名，成员粘贴后才能连上。

---

## 部署之后：三步建起一张网

1. **登录控制台**：浏览器打开 `http://<主机>:19393/`，用初始管理员账号登录（密码在首次启动日志里；登录后改掉）。
2. **创建虚拟网络**：选好成员上限与准入方式（口令邀请 / 人工审批 / 两者组合），创建后生成一条 `zr-net://…` 邀请链接。
3. **把邀请链接发给成员**：每台电脑在 `dsh-zen-remote` 插件的配置向导里选「节点端」并粘贴这条链接即可入网；开启人工审批的网络，新设备会出现在控制台的待审批列表里，点批准后自动上线。

插件侧的入网步骤与数据如何加密传输，见主仓库 `README.zh-CN.md` 的「场景 C」与 `docs/remote-access.md` 的「节点端（peer）与虚拟网络组网」。

## 数据与备份

- 默认数据都在数据目录（Docker 里是 `/data`）：SQLite 库 + `master.key`（`0600`，首次启动自动生成）。备份 = 停服后整目录拷走；`master.key` 丢失会导致已有凭据失效，务必随库一起备份。
- 走 PostgreSQL 时，备份交给你的 PostgreSQL 例程即可，数据目录里只剩 `master.key`（仍需保留）。
