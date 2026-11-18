# Zen Remote 自建中继网关（gateway-server）

> [English](README.md)

`dsh-zen-remote` 插件的**独立自建网关**：一台自托管的虚拟网络中继服务 + Web 管理控制台。只在你要为自己的多台电脑（或一个团队）搭一条自建组网通道时才需要部署它；只用插件本体的手机扫码 / 桌面配对功能不需要这个服务。

它做四件事：

- **虚拟网络管理**：Web 控制台里创建虚拟网络、生成 `zr-net://` 邀请链接、管理成员；每个网络有独立的成员上限（默认 8，可配 2–64），并支持在控制台或环境变量中设置默认成员上限与中转限速。
- **五态成员准入**：每个成员处于 `待审批` / `已授权` / `已暂停` / `身份变更` / `已吊销` 五种状态之一；新设备入网支持口令邀请、人工审批或两者组合，控制台实时显示在线状态与每对设备间的连接路径（局域网直连 / 打洞直连 / 网关中转）。
- **打洞协调**：双 UDP 端口（主口 + 辅口）做 STUN 式探测与 NAT 打洞协调，帮网内设备尽量建立直连；直连打不通的流量才落到网关中转。
- **零知识密文中转**：网关只看到密文帧的路由头（28 字节），会话内容是节点之间端到端加密的（临时 X25519 + AES-256-GCM），**网关不持有任何会话密钥，看不到任何会话内容**——管理员在控制台里看到的是成员与连接状态，不是数据本身。

---

## 快速部署（Docker，推荐）

### 方式一：Docker Compose（直接拉取双架构预构建镜像，推荐）

仓库已提供开箱即用的 [docker-compose.yml](docker-compose.yml)（默认拉取 `kyomio/zen-remote-gateway:latest`，支持 `linux/amd64` 与 `linux/arm64`，文件内附带可选的外置 PostgreSQL 注释配置）：

```sh
mkdir -p ./certs && sudo chown 100:101 ./certs   # Linux 下如需在控制台保存/上传证书先授权（只读挂载可跳过）
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/KyoMio/dsh-zen-remote/main/gateway-server/docker-compose.yml
# 可按需编辑 docker-compose.yml 中的 ZR_GATEWAY_PUBLIC_URL（也可启动后在控制台「网关设置」热配置）
docker compose up -d
docker compose logs -f zr-gateway
```

如需锁定版本而非 `latest`，可将 `image:` 改为 `kyomio/zen-remote-gateway:0.1` 或 `kyomio/zen-remote-gateway:0.1.0`。

### 方式二：`docker run` / 本地源码构建

```sh
# 直接拉取官方镜像（如需本地源码构建，可先执行 docker build -t kyomio/zen-remote-gateway:latest ./gateway-server）
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

- `-e ZR_GATEWAY_PUBLIC_URL`：按实际对外访问地址填写（走外部 HTTPS 反代 443 时填 `https://zr.example.com`；走网关自带 19393 原生 TLS 时填 `https://zr.example.com:19393`；若先局域网测试或打算之后在控制台热修改，也可省略此变量）。

- 端口：`19393/tcp`（Web 控制台 + WebSocket，可直接内置 HTTPS/WSS）、`19393/udp`（STUN 主口）、`19394/udp`（STUN 辅口）。**TCP 与 UDP 分别映射**。主 UDP 口用于反射地址发现，辅口用于补充 NAT 分类；缺辅口时分类可能为未知，仍会尝试直连并以中转兜底。节点读取网关欢迎消息中的实际绑定探测端口，改端口时需同时调整配置、映射与防火墙；TCP 反代不代替 UDP 转发。
- 数据卷与证书目录：镜像以非 root 用户（`zr`，`uid=100:gid=101`）运行，数据目录固定为 `/data`，证书目录固定为 `/certs`。推荐使用命名卷 `-v zr-gateway-data:/data`（Docker 首挂自动继承镜像内 `zr:zr` 属主）；若在 Linux 宿主机改用目录挂载（`-v $(pwd)/data:/data`），请先执行 `mkdir -p ./data && sudo chown 100:101 ./data`。升级镜像时保留该卷或目录即可，SQLite 库与自动生成的 `master.key`（权限 `0600`）都在里面。
- **证书挂载权限说明（`-v $(pwd)/certs:/certs`）**：
  - 若需要通过管理面板「上传 / 粘贴 PEM 证书」或在线保存写入 `fullchain.pem` / `privkey.pem`，宿主机证书目录同样需让容器用户可写：`mkdir -p ./certs && sudo chown 100:101 ./certs`；
  - 若由宿主机上的 `acme.sh` / `certbot` 等工具自动续期证书，也可以 `:ro` 只读挂载（`-v /path/to/live/domain:/certs:ro`），在管理面板下拉选中已有文件并开启 TLS；宿主机续期覆盖文件后网关会自动检测并热重载；
  - 首次空目录启动默认按明文 HTTP 启动；若首次空库启动时 `/certs` 内已经放好成对有效的 `fullchain.pem` + `privkey.pem`，网关会自动开启原生 TLS。
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

- 需要 Node.js **22.5 或更高**（内置 `node:sqlite` 模块）；较早的 Node 22 版本需要 `--experimental-sqlite`，较新的 Node 22 可直接运行。
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
| `ZR_GATEWAY_CERT_DIR` | `./certs`（Docker 内固定为 `/certs`） | TLS 证书目录：存放 `fullchain.pem` / `privkey.pem` 或其他可选证书文件，管理面板上传与宿主机续期共用 |
| `ZR_GATEWAY_DATABASE_URL` | （空） | PostgreSQL 连接串；未设则使用内置 SQLite（WAL 模式）。小规模部署用默认 SQLite 即可 |
| `ZR_GATEWAY_ADMIN_USER` | `admin@local` | 初始管理员登录名 |
| `ZR_GATEWAY_ADMIN_PASSWORD` | （空） | 初始管理员密码；未设则首次初始化随机生成 16 位并打印到启动日志（只显示一次）。仅在**空库首次启动**时生效，已有库不受影响 |
| `ZR_GATEWAY_ALLOW_SIGNUP` | `false` | 设 `true` 或 `1` 开放自助注册；之后也可以在 Web 控制台里随时开关 |
| `ZR_GATEWAY_MAX_PEERS` | `8`（范围 2–64） | **新建**虚拟网络的默认成员上限（建网时可在控制台单独调整） |
| `ZR_GATEWAY_MAX_NETWORKS_PER_USER` | `3`（范围 1–50） | 普通账号可创建的虚拟网络数上限 |
| `ZR_GATEWAY_RELAY_RATE_KBPS` | `4096`（范围 64–1048576） | 单成员的中转限速（KB/s），只限制经网关中转的流量，直连流量不经过网关 |

---

## 初始配置、容量与遥测

注册开关、每账号网络数、新网络默认席位与中转限速的环境值只在数据库缺少对应设置键时写入。控制台已经保存的值优先；改环境变量并重启不会覆盖它们，运行时调整请使用控制台。SQLite 与 PostgreSQL 使用同一规则。

网络 `maxPeers` 包含本机。节点默认最多挂载 `maxPeers - 1` 个远端，本机显式 `maxServers` 还能进一步限制挂载。已授权、暂停、身份异常成员占席位；待审批、已吊销不占。缩容不踢已有挂载，但限制新加入或新增挂载；扩容后补位。修改“新网络默认席位”不批量改动已有网络。

每个网络还有一个「**直连延迟上限**」（`peerDirectMaxRttMs`，控制台网络详情里编辑，0–10000 毫秒整数，默认 300，0 = 不限制）：节点实测的直连 RTT 持续超过它就走网关中转，低延迟样本连中两次再升回直连。该值由网关随入网欢迎与网络更新广播实时下发，改完即刻生效，无需节点重新入网；节点端没有各自的本地设置，全网始终用同一个值。

控制台将本地身份阻断显示为“已阻断”，未知延迟为 `—`，实测零延迟才是 `0 ms`。拓扑概览、设备列表与设备详情统一按**双向直连**判定连接态：仅当双方链路均报直连时才显示直连与延迟区间；单侧直连而对侧报中转或尚未上报时统一显示「经网关中转」（延迟 `—`），无中转连接时不再同时显示「正在中转」。速率以 5 秒窗口统计，`KB/s` 表示 1024 字节/秒；历史 API 字段中的 `Kbps` 后缀保留，但不表示千比特/秒。当前网络顶栏跟随 SSE；管理页可见时每 3 秒刷新在线数和速率，慢请求不重叠，隐藏或离开时取消轮询。其他未订阅网络不保证实时。

## 原生 TLS（推荐）与反向代理注意事项

### 1. 内置单端口原生 TLS（无需反代，保留 `19393` 控制口与双 UDP 口）

`gateway-server` 内置单端口原生 TLS（同一 `19393/tcp` 端口自动复用明文 / TLS）：无需单独折腾 Nginx / Caddy 或拆改 `19393/udp` + `19394/udp` 探测端口，也不影响原有节点默认配置：

1. **两种配证通道**：
   - **挂载证书目录**：将包含 `fullchain.pem` 与 `privkey.pem`（或其他证书/私钥文件）的宿主机目录挂载到容器 `/certs`（或源码运行时放到 `ZR_GATEWAY_CERT_DIR`，默认 `./certs`）。首次空库启动时若默认配对文件有效，会自动开启 HTTPS/WSS；宿主机续期工具覆盖证书后，网关会自动防抖热重载。
   - **控制台在线上传与开关**：登录 Web 控制台，在「**网关管理 → TLS 与证书**」直接选择本地证书文件或粘贴 PEM 文本保存到目录并开启（需容器对 `/certs` 拥有写权限），支持**在线热切换 HTTP / HTTPS**、下拉选用目录里已有文件与手动重载，全程免重启容器。
2. **明文与加密分流规则**：开启 TLS 后，同一 `19393/tcp` 端口遇到浏览器明文 `http://` 访问会自动响应 `302 Found`（无永久缓存、无 HSTS，日后关停 TLS 不会锁死浏览器）引导跳到 `https://`；明文调用 `/api/*`、`/peer/*` 或明文 WebSocket 升级会明确返回 `426 TLS_REQUIRED`，绝不悄悄降级明文。
3. **Fail-Closed 启动守卫**：已开启 TLS 后，若重启时发现激活证书缺失或损坏，网关会直接报错退出并打清晰日志（防公网网关退回明文裸奔；若仅证书时间过期，仍允许以 HTTPS 启动以便管理员登录控制台更换证书）。

### 2. 外置反向代理（可选高级场景）与防火墙直通

如果必须复用宿主机的 443 标准端口共享单一公网域名，也可以在网关前面继续套外置 Nginx / Caddy 反代并保持网关内置 TLS 关闭（`ZR_GATEWAY_PUBLIC_URL` 填外部 `https://…` 地址），注意以下要点：

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

3. **UDP 防火墙直通**：无论是否启用原生 TLS 或外置反代，宿主机防火墙与云厂商安全组都必须放行 `19393/udp` 与 `19394/udp`，容器端口映射也要保留 UDP；TCP 反代不代替 UDP 探测转发。

4. **设置对外地址**：配置域名或反代入口后，建议在控制台「网关热配置」或环境变量 `ZR_GATEWAY_PUBLIC_URL` 填入完整公网访问 URL，控制台会立即按该地址与 TLS 状态生成正确 `zr-net://` 邀请链接（如内置 TLS 为 `19393` 可填 `https://zr.example.com:19393`）。

---

## 部署之后：三步建起一张网

1. **登录控制台**：浏览器打开 `http://<主机>:19393/`，用初始管理员账号登录（密码在首次启动日志里；登录后改掉）。
2. **创建虚拟网络**：选好成员上限与准入方式（口令邀请 / 人工审批 / 两者组合），创建后生成一条 `zr-net://…` 邀请链接。
3. **把邀请链接发给成员**：每台电脑在 `dsh-zen-remote` 插件的配置向导里选「节点端」并粘贴这条链接即可入网；开启人工审批的网络，新设备会出现在控制台的待审批列表里，点批准后自动上线。

插件侧的入网步骤与数据如何加密传输，见主仓库 [../README.zh-CN.md](../README.zh-CN.md) 的「场景 C」与 [../docs/remote-access.md](../docs/remote-access.md) 的「节点端（peer）与虚拟网络组网」。

---

## 邀请链接格式（`zr-net://`）

控制台为每个网络生成的邀请链接统一只有 `zr-net://` 一种格式：

```
zr-net://<主机>[:<端口>]/<网络ID>[?tls=0|1][#<入网口令>]
```

- `<网络ID>` 固定 16 位小写十六进制。每个网络（含仅人工审批的）创建时都会生成一个入网口令，控制台复制的完整链接始终带 `#<入网口令>` 后缀。在口令邀请 / 两者组合的准入方式下，`#<入网口令>` 是首次入网的免审凭证；在仅人工审批方式下口令不参与准入判定，手工删去 `#...` 也能正常提交入网申请（控制台的分项复制区会提示「手动审批模式无需入网口令」）。
- **省略端口时按 19393 处理**。站点走标准端口反代（HTTPS 443 / HTTP 80）时，控制台生成的链接会显式带上 `:443` / `:80`，避免被节点误回落到 19393；写了其他端口则原样保留。
- `?tls=0|1` 只在传输方式与主机默认推断**不一致**时出现：回环、私网 IPv4（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）、链路本地、IPv6 ULA、CGNAT/Tailscale（`100.64.0.0/10`）与 `.local` / `.lan` 域名默认走明文，其余公网地址默认走 TLS。因此公网裸 IP 跑明文会带 `?tls=0`（如 `zr-net://203.0.113.10:19393/<网络ID>?tls=0#<口令>`），私网 IP 挂了 TLS 反代则会带 `?tls=1`（如 `zr-net://192.168.1.10/<网络ID>?tls=1#<口令>`）。
- 节点端仍兼容**读取**旧式 `zr-net+insecure://`（等价默认明文）与 `zr-nets://`（等价默认 TLS）前缀，但新链接一律输出 `zr-net://`；手写链接也请统一用 `zr-net://` 加 `?tls=0|1`，不要再输出这两种旧前缀。
- **网关没有「关闭安全校验」的全局开关**：链接按主机推断为 TLS 时，节点只接受 `wss://` / `https://`，证书验证失败绝不自动降级明文。当前对外地址为明文 HTTP、或辅助 UDP 端口关闭时，「网关管理」页会显示一条**非阻断**的安全提示条提醒你处理（见下方「网关管理面板」）。

## 管理员账号与账号设置

首次启动自动创建初始管理员（登录名默认 `admin@local`，可用 `ZR_GATEWAY_ADMIN_USER` 改），密码随机生成并只打印一次到启动日志（也可用 `ZR_GATEWAY_ADMIN_PASSWORD` 预先指定）。

登录后，右上角头像菜单里的「**账号设置…**」可以：

- **修改密码**：保存后其他已登录设备全部自动退出，当前浏览器保持登录；
- **更换邮箱**：网关未配置发信服务（SMTP）时，输入当前密码即可直接换绑；已配置发信服务后，需要输入发到新邮箱的 6 位验证码确认。

## 网关管理面板

管理员登录后从顶栏进入「**网关管理**」，按功能划分为六个标签页（页头附只读运行态与安全提示条）：

- **用户管理**：新建账号（可指定用户组与组到期时间；不填密码时生成 16 位随机初始密码，仅显示一次）、重置密码（同样只显示一次，并立即清除该账号所有旧会话）、停用 / 删除账号、调整所属用户组与到期时间；
- **用户组**：新建 / 编辑用户组与配额、切换新用户默认组；默认组和仍有账号绑定的组不可删除；
- **网关设置**：
  - **公网访问地址**：在线热修改对外地址，保存后立即作用于之后生成的邀请链接，无需重启网关；留空则回落到环境变量 `ZR_GATEWAY_PUBLIC_URL`，两者都没设时从请求头推断；
  - 开放注册开关、注册必须验证邮箱开关、新用户默认组与登录态有效期（1–90 天）；
- **TLS 与证书**：查看当前激活证书域名、颁发者、剩余有效期与 SHA-256 指纹；在线切换单端口原生 TLS 开关、下拉选用 `ZR_GATEWAY_CERT_DIR` 目录中已有文件或立即从磁盘重载，并可直接选择文件/粘贴 PEM 文本写入 `fullchain.pem` 与 `privkey.pem`；
- **发信服务**：在线配置 SMTP 并发送测试邮件，无需重启；支持 TLS（465）/ STARTTLS（587）/ 明文三种加密方式，发信账号口令以 AES-256-GCM 加密后落库，界面不回显；
- **接口密钥**：生成 / 重置 / 吊销供外部系统调用的管理员 API Key；

此外，页头持续展示以下状态：
- **只读运行态**：TCP 端口、原生 TLS 启停状态、UDP 探测端口、存储引擎（SQLite / PostgreSQL）、主密钥来源、实时中转速率与累计流量等；
- 页面顶部的**安全提示条**（非阻断，只是提醒）：对外公网地址未启用 HTTPS、辅助 UDP 端口已关闭，或 TLS 证书即将过期 / 已过期 / 磁盘重载异常。网关刻意不提供忽略这些问题的开关——修复方式分别是开启原生 TLS（或配外部反代 HTTPS）、保持辅助 UDP 口开启或及时更新有效证书。

## 升级与正常恢复

先备份数据库与 `master.key`，升级网关，再逐台升级节点。仅更新桌面插件不会替换独立网关。旧网关可能不接受新版 `blocked` / `null` 遥测；旧节点也不具备所有暂停恢复、取消确认与握手绑定能力，混合版本期间不要把缺失状态当作连接事实。

### 容器内热更新与 15 秒自动回滚

Docker 镜像以 `dist/bootstrap.js` 作为 PID 1 守护引导器，支持在不重建容器的前提下完成 JS 与 Web 控制台热更新：

- **后台一键升级与空闲自动更新**：管理员可在「网关管理 → 网关设置」手动检查并点击「立即更新」，或保持「空闲时自动更新网关」开启（默认启用）：每 12 小时自动检查 GitHub Releases，若检测到兼容新版且连续两次（间隔 5 秒）观测到全网实时中转流量为 0，即静默下载并热切换。
- **版本目录与保留规则（`/data/releases`）**：热更新包（`zen-remote-gateway-bundle.tar.gz`）仅在官方 Release 提供 SHA-256 摘要时才启用镜像加速校验，解包前先以隔离进程执行 `--self-check`，落盘到 `/data/releases/versions/<版本号>` 并仅保留最近两代（当前版与上一可用版）。每次容器启动按「谁新跑谁」比较 `/data/releases` 与镜像内置基础版本，镜像重建升级后自动切回新版基础镜像并清理更旧缓存。
- **15 秒健康确认与自动回滚**：子进程以退出码 `75` 触发秒级切换后，新版必须在 15 秒内回报 `zr-gateway-ready`；超时或崩溃会自动强杀并回滚至上一可用版本（或基础镜像），同时在管理台顶部展示可关闭的脱敏回滚提示。
- **何时需要 `docker compose pull`**：当新版因原生依赖或 Node 主版本变化提高 `baseCompatEpoch` / `minNodeMajor`，或未使用守护引导器运行（非 Docker 守护方式）时，控制台与插件会提示执行 `docker compose pull && docker compose up -d`。

新版节点暂停时停止业务而保留受限控制连接，恢复不必重新入网。首次打洞默认约 1 秒后降级中转，已有直连丢失按最后有效收包后 15 秒判定，中转时按 `3s → 8s → 25s` 递增退避自动重探（打通后经首包 + `200ms` 快速复检约 0.3 秒切直连）。网关与节点控制面 WebSocket 通过 `10s` Ping / `15s` Pong 心跳自动清理半开断网连接，并在连接重建时随 `connSeq` 纪元同步触发两端对称自愈重锚。普通已知长度上传有额外 20 秒恢复预算，但恢复仍取决于可达性，不保证任意断网无损。

正常 SIGTERM/SIGINT 会停止接收、补写末批遥测，再关闭数据库。默认关闭预算为 5 秒；错误清理最多另留 4 秒宽限，失败非零退出并报告未确认累计。容器停止宽限应覆盖这段时间并留调度余量。数据库正常回滚后可重试；突然断电、强制终止或 COMMIT 结果不明不保证遥测零损失或恰好一次。

## 数据与备份

- 默认数据都在数据目录（Docker 里是 `/data`）：SQLite 库 + `master.key`（`0600`，首次启动自动生成）。备份 = 停服后整目录拷走；`master.key` 丢失会导致已有凭据失效，务必随库一起备份。
- 走 PostgreSQL 时，备份交给你的 PostgreSQL 例程即可，数据目录里只剩 `master.key`（仍需保留）。
