# 公网接入（通道半边详解）

> `dsh-zen-remote` 的通道半边完整文档：反代对接、配对流程、环境变量、管理 API、推送、安全边界。
> 安装与快速上手见[根 README](../README.md)；界面侧细节见 [interface.md](interface.md)。
> 网关基座衍生自 MIT 的 [`dsh-mobile-gate`](https://github.com/Bernardxu123/dsh-mobile-gate)。

---

## ✨ 特性

| 模块 | 说明 |
| --- | --- |
| 🔑 **公网身份** | 网关只监听 `127.0.0.1`，放在你自己的反代后面；新设备用配对码换取长期设备令牌（Cookie `lg_device`），身份跟着令牌走，与来源 IP 完全无关 |
| 📱 **真 PWA** | `manifest.json` + service worker：反代带来 HTTPS 后，手机浏览器「添加到主屏」真正生效，全屏独立窗口运行，带图标/启动屏/主题色 |
| 🧩 **可安装** | 主屏图标、`standalone` 显示、`apple-touch-icon`、maskable 图标 |
| 🌐 **离线可用** | service worker（v3）：只有真正的静态壳（manifest/图标/离线页）缓存优先，其余（DSH 客户端 JS/CSS、API、页面 HTML）一律网络优先——装了新版本手机上立刻吃到，不会像早期版本那样在部署之后还残留旧 CSS |
| 👆 **触屏手势** | 捏合缩放字体（可重置）；左缘返回手势已让位给界面半边（见下方「分工」），下拉刷新已整体移除（误触发全页重载会把人从对话中间弹回列表） |
| 🔔 **卡住了就推送** | 真 Web Push（VAPID 签名 + aes128gcm 加密）。默认只在**真正需要你**的时候推：某个工具在等授权、模型在等你回答问题。「回合结束」默认不推（设 `DSH_PUSH_TURN_END=1` 打开）。通知里默认不带对话内容 |
| 🛎️ **`push_notify` 工具** | 模型可主动调用的推送工具（在 `dsh-push.mjs` 里注册）：任务中途要用户拿主意、跑到关键节点、或出错需要人来处理时，模型自己决定推一条到锁屏。纪律写在工具描述里明确要求模型别高频用；宿主侧再兜底限流（同会话 60 秒最多 1 条、全局每小时最多 20 条），超额直接不发送、不报错。同样是 aes128gcm 端到端加密，推送服务器只见密文，暴露面只有你自己的锁屏。`lan-gate.config.json` 里 `pushTool: false`（或 `DSH_PUSH_TOOL=0`）可整体关掉；宿主没装工具注册服务（`ctx.tools`）时自动跳过，不影响插件其余功能 |
| 📐 **触屏布局** | 本仓库只留壳级规则（iOS 输入框防缩放、安全区滚动补偿、代码横向滚动）——排版类规则（44px 触摸目标、弹窗、composer 外观等）已交给界面半边，见下方「分工」——桌面零影响 |
| 🔒 **桌面不受影响** | 所有规则都以 `html:not([data-lan-device="desktop"])`（或带同样排除条件的 `@media`）为根——只有显式标成「桌面」才会被排除，其余（包括真机默认的「自动」）都生效 |
| 🛡️ **管理面本机独占** | 生成配对码、管理设备、触发推送——这些接口只认本机直连，经反代进来的请求一律 403 |

---

## 🏗️ 架构

```
公网设备(手机/电脑) --HTTPS--> 你自己的反代(nginx/Caddy，负责 TLS 终结)
                                       │  HTTP + X-Forwarded-For/Proto
                                       ▼
                     网关(独立 Node 子进程 · 默认只监听 127.0.0.1:3088)
                                       │
        ┌──────────────────────────────┼────────────────────────────────┐
        │                              │                                 │
   未配对设备                    已配对设备(带 lg_device 令牌 Cookie)         本机直连(无 X-Forwarded-* 头)
   → 任意路径都跳配对页             → 反代到 DSH Web UI(127.0.0.1:3080)         → 管理页/管理 API/推送触发
     提交配对码换令牌                 HTML 注入：manifest + PWA 引导 +             /lan-gate/admin /status
                                     触屏 CSS + randomUUID polyfill            /action /pair /pwa/push/send
```

- 网关是独立子进程，与 DSH 主进程隔离：挂掉不影响主服务，插件停止时自动终止。
- DSH 主服务本身仍然只监听 `127.0.0.1`，网关不改它的任何配置，也不碰它 `/api` 的信任栅栏。
- 唯一保留的「按 IP 信任」：回环 socket 且不带任何 `X-Forwarded-*` 头的请求，判定为坐在这台机器前面的本机用户——这是管理面的唯一入口。经反代进来的请求一定带转发头，天然进不去。

---

## 🧩 与界面半边的分工

同一个插件里两半代码的边界是：

- **本仓库只管「壳」和「通道」**：配对认证、令牌、限流、PWA 安装清单、service worker、首帧安全区注入；
- **排版全部交给界面半边**：字号、弹窗、composer 外观、气泡样式这些「长什么样」的规则一律不在本仓库管。

这不是设计初衷，是一次热修的结果：`pwa/app.css` 早期有 163 行,和界面半边抢同一批元素的样式,现在裁到 95 行,只剩壳级规则(iOS 输入框防缩放、安全区滚动补偿、pinch 缩放变量、代码块横向滚动)。裁剪时漏了一处——网关 `lib/lan-gate-server.cjs` 里还内联着一份没人记得的 `DEVICE_CSS` 副本,和裁剪前的 `app.css` 一样,其中一条「全屏弹窗」规则会把**任何**带 `role="dialog" aria-modal="true"` 的浮层撑满整个视口,包括界面半边自己的会话信息卡——症状是「经网关访问时信息卡整卡溢出屏幕、直连 DSH 却正常」,看着像内核差异,其实是网关注入的这份死代码在捣鬼。这份 `DEVICE_CSS` 现已整体删除。

手势也重新分了工:下拉刷新已经从 `touch-gestures.js` 里整体移除(用户反馈:不小心多滑一下就触发全页重载,把人从对话中间弹回会话列表);左缘右滑返回的 24px 边缘热区也让了出来,现在归界面半边的手势系统(关掉打开的浮层、或回到会话列表),本仓库这边原来的边缘返回本来就对 DSH 的前端路由不起作用(`history.back()` 在单页应用里是空操作)。捏合缩放字体保留在本仓库。

---

## 📲 安装细节的几处修复

- **manifest 不再被上游标签挡住**:DSH 自己的页面已经带了一个 `<link rel="manifest">`,浏览器只认页面里第一个 manifest 链接——网关这边手机定制的 manifest(正确图标、背景色、安装名)以前排在后面,被上游那份通用 manifest 静默盖掉。现在网关会把上游的 manifest 标签剥掉,只留自己注入的这份。
- **manifest 与图标享有凭证豁免**:manifest 和它引用的三个图标现在不挡在配对墙后面——浏览器抓取 manifest/图标时按规范是不带 Cookie 的,挡在墙后会让 Chrome/Android 直接看不到安装按钮(iOS Safari 因为这次请求照样带 Cookie,所以之前只有 iOS 能装,不是巧合是 bug)。
- **service worker 作用域修复**:注册时显式声明 `scope: '/'`,网关也在 `sw.js` 响应上带 `Service-Worker-Allowed: /`——以前没声明作用域,SW 默认只管它自己所在的 `/pwa/` 目录,从来没真正接管过整个 app。
- **安装名固定为「DSH Mobile」**:`pwa/manifest.json` 的 `short_name` 就是安装到主屏后图标下面显示的名字。
- **首帧就有安全区**:`viewport-fit=cover` 现在直接写在网关转发的第一帧 HTML 里,不用等界面半边的客户端脚本启动后才补——独立 PWA 冷启动那一刻起安全区就生效,不再是「刚打开时贴着刘海,拖一下才弹回去」。

---

## 🚀 快速开始

### 1. 安装插件

```bash
dsh plugin add dsh-zen-remote
```

装完重启 `dsh web`。手动写法与本地开发装法见[根 README](../README.md#安装)；不走 `dsh plugin add` 的静态挂载见 [`cordis.patch.yml.example`](../cordis.patch.yml.example)。

### 2. 配你自己的反代

网关默认只监听 `127.0.0.1:3088`，不会自己裸奔到公网。想从手机或别的电脑访问，你需要在能连到它的机器上跑一个反代来终结 HTTPS，再把流量转给网关。下面两份配置可以直接抄。

#### nginx

```nginx
# http {} 块里加一次即可，多个 server 复用
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

        # WebSocket 升级——DSH Web UI 需要
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # 网关靠这两个头识别真实客户端和协议，缺了它们配对/推送都会出问题
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 长连接/流式响应建议关掉缓冲，避免响应被攒着不发
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

#### Caddy

Caddy 默认自带 HTTPS 证书签发、WebSocket 转发和转发头，一行 `reverse_proxy` 就够：

```
dsh.example.com {
    reverse_proxy 127.0.0.1:3088
}
```

> 反代和网关不在同一台机器上（比如反代跑在另一个容器/服务器）？网关默认只信任回环地址发来的 `X-Forwarded-For`，这种情况要把反代的出口 IP 加进 `LAN_GATE_TRUSTED_PROXIES`，见下面环境变量表。

#### Lucky

[Lucky](https://github.com/gdy666/lucky) 是软硬路由/NAS 上常用的公网工具箱（DDNS + ACME 证书 + 反代一体，后台默认 `http://<设备IP>:16601`）。前置：先在 Lucky 的 DDNS 和安全证书模块把域名解析、证书签发做好（ACME 自动续期）。然后：

1. **Web 服务 → 添加 Web 服务规则**：监听端口 `443`，开启 TLS 并关联你的域名证书。
2. **规则下添加子规则**：服务类型选「反向代理」，前端地址填你的域名（如 `dsh.example.com`），后端地址按部署形态填：
   - Lucky 和 DSH **同一台机器**：`127.0.0.1:3088`，网关侧零配置。
   - Lucky 跑在**路由器/NAS 上**（更常见）：填 `DSH机器的局域网IP:3088`，同时给网关设两个环境变量——`LAN_GATE_HOST=0.0.0.0`（让 Lucky 能连到网关；此时局域网内其他设备也只能看到配对页，门禁仍然有效）和 `LAN_GATE_TRUSTED_PROXIES=Lucky所在设备的局域网IP`（网关才会信任它带来的转发头）。
3. **子规则里把「万事大吉」开关打开**——它负责自动添加 `X-Forwarded-For` 等常用请求头。**同机部署时这个开关是安全边界的一部分**：不开的话，经 Lucky 进来的请求源地址是回环又不带转发头，会被网关当成「本机用户」直通，等于把管理面暴露给公网。开了就没这个问题。
4. WebSocket 是自动透传的，不需要单独设置；如果对话流卡住，优先把 Lucky 升级到新版本。

> 具体开关名称可能随 Lucky 版本略有差异，认准三样东西即可：HTTPS 证书、反向代理到 3088、转发头（万事大吉）。

#### Cloudflare Tunnel（没有公网 IP 时的接入方式）

家宽运营商不给公网 IP（大多数国内宽带的现状）、或者不想在路由器上开端口映射时，用 Cloudflare Tunnel：`cloudflared` 从你这台机器**主动向外**建一条长连接，Cloudflare 负责域名解析、TLS 证书和公网入口，再把请求从这条连接送回本机的 `127.0.0.1:3088`。路由器一个端口都不用开，家里的 IP 也不暴露。免费版就够用。

前置条件只有一个：域名托管在 Cloudflare（NS 指向 Cloudflare）。

网关这边**零改动**：`LAN_GATE_HOST` 保持默认的 `127.0.0.1` 就行，`cloudflared` 与它同机。

##### 方式一：Zero Trust 控制台的 token 流（推荐）

隧道配置存在 Cloudflare 那边，本机只存一个 token，改配置不用碰机器。

1. 打开 [Zero Trust 控制台](https://one.dash.cloudflare.com/) → **Networks → Tunnels → Create a tunnel** → 选 **Cloudflared**，起个名字。
2. 创建完页面会给出一条带 token 的安装命令，在跑 DSH 的机器上执行：

   ```sh
   cloudflared service install eyJhIjoi...你的token
   ```

   这会把 `cloudflared` 装成常驻服务并开机自启。macOS 上装之前先 `brew install cloudflared`，Debian/Ubuntu 用官方 `.deb`。

3. 回到隧道详情页 → **Public Hostname** → **Add a public hostname**：

   | 字段 | 填什么 |
   | --- | --- |
   | Subdomain | `dsh` |
   | Domain | `example.com` |
   | Path | 留空 |
   | Service Type | `HTTP` |
   | URL | `127.0.0.1:3088` |

   保存即生效，DNS 记录 Cloudflare 自动建，证书自动签。

4. 直接跳到下一节做 403 自检。

##### 方式二：命令行 + config.yml（进阶）

想把隧道配置也放进版本管理、或者一条隧道要挂多个服务时用这个流程：

```sh
cloudflared tunnel login                      # 浏览器里授权域名，证书落到 ~/.cloudflared/
cloudflared tunnel create dsh                 # 记下输出里的 <TUNNEL-ID>
cloudflared tunnel route dns dsh dsh.example.com
```

`~/.cloudflared/config.yml`：

```yaml
tunnel: <TUNNEL-ID>
credentials-file: /home/you/.cloudflared/<TUNNEL-ID>.json

ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:3088
  - service: http_status:404          # 兜底规则，必须是最后一条
```

```sh
cloudflared tunnel run dsh            # 先前台跑通
sudo cloudflared service install      # 通了再装成常驻服务
```

##### 为什么隧道场景下自检格外重要

`cloudflared` 是从**本机回环**连到网关的，也就是说网关看到的 socket 来源永远是 `127.0.0.1`。网关区分「公网访客」和「坐在这台电脑前的人」，靠的是请求里有没有 `X-Forwarded-*` 转发头（判定见 `lib/lan-gate-server.cjs` 的 `isLocalDirect`：带任何转发头就一定不是本机用户）。`cloudflared` 默认会带上 `X-Forwarded-For` 和 `X-Forwarded-Proto`，所以配对墙正常生效；但**万一你的版本或某条 ingress 配置把它去掉了，公网请求就会被当成本机管理员，管理页直接对外**。这个风险 nginx/Caddy 同机部署时同样存在（Lucky 的「万事大吉」开关就是这件事），只是隧道场景下更容易被忽略，因为你没有亲手写过任何一行转发头配置。

**不需要设 `LAN_GATE_TRUSTED_PROXIES=127.0.0.1`**：网关的 `resolveClient()` 本来就把回环来的连接当作可信反代（`isLoopbackIp(sockIp) || TRUSTED_PROXIES.indexOf(sockIp) >= 0`），填 `127.0.0.1` 是个空操作，既不会报错也不会改变任何行为——更要紧的是它**不能**替代下面的自检。这条语义有测试钉住（`test/auth.test.cjs` 的 `same-host tunnel:` 两个用例，填与不填结果完全一致）。`LAN_GATE_TRUSTED_PROXIES` 真正要填的场合只有一个：反代/隧道进程**不在**这台机器上（比如跑在路由器或另一台服务器），那时来源 IP 不是回环，必须把它列进来网关才会信任它带来的转发头。

##### 常见坑

- **`Error 1033` / 隧道离线**：`cloudflared` 服务没起来或 token 过期。`cloudflared tunnel info <名字>` 看连接数，`sudo launchctl list | grep cloudflared`（macOS）或 `systemctl status cloudflared`（Linux）看服务状态。
- **502 Bad Gateway**：隧道通了但回源失败——网关没在跑，或 Public Hostname 的 URL 写成了 `3080`（DSH 本体）而不是 `3088`（网关）。写 3080 会绕开整个配对墙，**等于把 DSH 裸奔到公网**，务必确认是 3088。
- **对话流卡住 / 消息不出来**：WebSocket 没通。Cloudflare 免费版支持 WebSocket，一般是 Zero Trust 里给这个 hostname 挂了 Access 策略拦住了升级请求，或者 ingress 里写了 `disableChunkedEncoding`。
- **上传大文件失败**：Cloudflare 免费版单请求体上限 100MB。本插件默认上传上限 20MB，低于它，正常不会撞上；真要传更大的文件，先调 Cloudflare 套餐再调 `maxUploadBytes`。
- **想再收紧一层**：可以在 Zero Trust → Access 里给这个 hostname 加一条策略（邮箱 OTP 之类），叠在配对码之前。不是必须的，配对墙本身已经是一道认证。

#### 配好后自检（任何反代都做一遍）

用**手机流量**（不要连家里 Wi-Fi）访问 `https://你的域名/lan-gate/admin`——正确结果是 **403**。如果居然能看到管理页，说明反代没有带上 `X-Forwarded-*` 转发头，网关把公网请求误判成了本机用户，**立即回去检查转发头配置**（nginx 检查 `proxy_set_header` 两行；Lucky 检查「万事大吉」；Cloudflare Tunnel 见上一节）。自检通过后再开始配对设备。

### 3. 生成配对码、配对设备

1. 反代配好后，在**这台机器本机**的浏览器打开 `http://127.0.0.1:3088/lan-gate/admin`。
2. 点「生成配对码」，得到一个 8 位码，10 分钟内有效，只能用一次。
3. 手机或另一台电脑，浏览器打开你反代的 HTTPS 域名，会看到配对页，输入配对码（可选填设备名）。
4. 配对成功后自动进入 DSH Web UI（已注入 PWA），身份保存在长期 Cookie 里，换 Wi-Fi/换 IP 都不会掉线。
5. 手机上通过浏览器菜单「添加到主屏幕」，就能像原生 App 一样独立打开。
6. 页面会提示开启「任务完成推送」，同意通知权限后，agent 干完活即使切到别的 App 也能收到系统通知。

在管理页还可以：把设备类型设为手机/电脑/自动排版、给设备改名、单独吊销某台设备或一键全部吊销。

---

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LAN_GATE_PORT` | `3088` | 网关监听端口；被占用会自动往上 +1 重试（最多 +20） |
| `LAN_GATE_HOST` | `127.0.0.1` | 网关监听地址。留默认值 + 反代是推荐做法；只有你清楚自己在干什么时才改成别的 |
| `LAN_GATE_TARGET_PORT` | `3080` | 本机 DSH Web UI 端口，网关反代到这里 |
| `LAN_GATE_RATE_LIMIT` | `120` | **只对未配对/未认证请求**按真实客户端 IP 计的每分钟上限（保护配对页和配对接口）。本机和已配对设备不受限——它们的防线是令牌与吊销 |
| `LAN_GATE_TRUSTED_PROXIES` | 空 | 逗号分隔的 IP 列表。反代和网关不在同一台机器（回环地址）时，把反代的出口 IP 填进来，网关才会信任它带来的 `X-Forwarded-For`/`X-Forwarded-Proto` |
| `LAN_GATE_VAPID_SUBJECT` | `mailto:admin@localhost` | Web Push 的 VAPID 联系人字段。**务必改成真实邮箱或 https 网址**：Apple 会用 `403 BadJwtToken` 拒绝占位符，导致 iOS 设备静默收不到推送（Google/Mozilla 不校验）。填错时启动日志有告警 |
| `LAN_GATE_LANG` | `auto` | 网关自己那几个页面（配对页、限流页、管理页）和注入到应用里的推送开关卡片用什么语言。`auto` 按请求的 `Accept-Language` 决定——配对访客唯一会主动交出的语言信号；没有这个头就用中文。`zh`/`en` 写死，不再看浏览器 |
| `DSH_PUSH_LANG` | `zh` | 推送通知本身的文案语言（等授权 / 等回答 / 回合完成）。这里**不做自动探测**：通知是宿主进程生成的，既没有请求头，`launchd` 也不给它 `LANG`（中文用户的机器上 `Intl` 照样报 `en-US`）。要英文就显式设 `en` |

除了环境变量，**推荐用配置文件** `~/.dsh/lan-gate.config.json`（网关和推送插件两半共用一份，改完重启 `dsh web` 生效；显式环境变量优先于文件）：

```json
{
  "host": "0.0.0.0",
  "trustedProxies": "192.168.1.2",
  "rateLimit": 600,
  "pushSummary": true
}
```

字段名 = 环境变量去掉前缀转小驼峰：`port` / `host` / `targetPort` / `rateLimit` / `trustedProxies` / `vapidSubject`，推送半边是 `pushTurnEnd`（回合结束是否推送，默认 `false`）/ `pushEvents` / `pushDebounceMs` / `pushSummary` / `pushTool`（`push_notify` 工具开关，默认 `true`）。语言只有一个键 `lang`，两边共用：网关认 `auto`（跟随浏览器）/`zh`/`en`，推送半边只认 `en`，其余一律中文——所以 `"lang": "auto"` 的意思是「页面跟随浏览器、通知保持中文」。挂载行支持 Cordis config 的 DSH 版本也可以把网关配置写在 insert 行的 `config:` 下（同名小驼峰字段），效果等同。

推送半边（`dsh-push.mjs`）随包自带，装包即挂载，**不需要在 profile 的
`cordis.patch.yml` 里手写任何一行**。从旧的两包结构升级上来的话，profile patch
里那行手挂的 `网关半边/dsh-push.mjs` 要删掉，否则会重复挂载。

---

## 🔌 管理 API

以下接口全部**仅限本机直连**：请求的 socket 必须是回环地址、且不带任何 `X-Forwarded-*` 头。只要请求经过反代（一定带转发头），一律返回 403——公网碰不到这些接口。

| 接口 | 方法 | 作用 | 参数 |
| --- | --- | --- | --- |
| `/lan-gate/pair` | POST | 生成一个新的一次性配对码（10 分钟有效） | 无 |
| `/lan-gate/status` | GET | 查看运行状态、当前配对码、已配对设备列表 | 无 |
| `/lan-gate/action` | POST | 管理设备 | `action`: `set-kind` / `rename` / `revoke` / `revoke-all`；`id`: 设备 id（`revoke-all` 不需要）；`set-kind` 还需要 `kind`（`phone`/`desktop`/`auto`）；`rename` 还需要 `name` |
| `/pwa/push/send` | POST | 给所有已订阅设备发一条推送 | `title`、`body`（都是纯文字，不含对话内容） |

配对入口 `/lan-gate/pair/claim`（POST）是唯一对外开放的例外——它就是设备输入配对码换令牌的地方，靠码本身（一次性、10 分钟过期）和失败锁定（连续 5 次错码锁该 IP 15 分钟）来防护，不需要本机身份。

---

## 🔔 推送说明

- VAPID 密钥对首次启动时自动生成，存在 `~/.dsh/lan-gate-state.json` 里（目录可用 `DSH_HOME` 环境变量改），公钥通过注入脚本下发给页面。
- 订阅接口 `/pwa/push/subscribe` 要求带有效的设备令牌 Cookie（也就是必须先配对成功），每台设备最多一条订阅，全局最多 20 条，防止陌生人往你服务器塞订阅、也防止借这个接口对外发请求。
- 推送内容只有标题和一句简短正文（比如「DSH 任务完成」），**不携带任何对话内容**——走的是标准 Web Push（VAPID 签名 + aes128gcm 加密），只有推送服务商和你的浏览器能看到密文。
- 设备被吊销时，它的推送订阅一并删除；推送目标返回 404/410（订阅已失效）时网关会自动清掉这条订阅。
- 手机浏览器要求页面必须是 HTTPS 才会注册 Service Worker，所以推送和离线能力都依赖第 2 步配好的反代——反代没配好之前，这两项在真机上都不会生效。
- 「什么时候推」由可选宿主插件 `dsh-push.mjs` 决定：它监听 DSH 事件总线并调用本机 `/pwa/push/send`。分两条腿。**事件腿（默认开、必推）**：某个工具在等你授权（会话事件 `approval/asked` 一秒半内没等到配对的 `approval/decided`），或者模型调了 `ask_user_question` 在等你回答（会话事件 `tool/call`）——这两类不受去抖压制，子代理里发生的也照推。**回合结束（默认关）**：想要「干完活就响一下」的老行为，设 `DSH_PUSH_TURN_END=1`（1.0.3 之前这是默认行为，现在改成了要显式打开）；打开之后只有顶层会话会推，子代理跑完永远不推。算哪些事件仍由 `DSH_PUSH_EVENTS`（逗号分隔）配置，默认 `agent/turn-stopping`——官方文档定义的「回合即将关闭」检查点；DSH 版本不同导致事件名对不上时用它覆盖。`DSH_PUSH_DEBOUNCE_MS`（默认 15000）控制两条通知的最小间隔。想让通知带上这回合的结果摘要？设 `DSH_PUSH_SUMMARY=1`，正文会换成本回合的**最终文本回复**（只取 `text` 内容块，思考过程不会漏出来；整回合没说话就退回「最后执行了 <工具名>」；截 120 字）——推送 payload 本身是 aes128gcm 端到端加密的，Google/Apple 的推送服务器只见密文，剩下的暴露面是你自己的锁屏和通知中心（两大系统都支持「锁屏隐藏通知内容」，介意就开）。不装它也可以自己在任何脚本里 `curl -X POST http://127.0.0.1:3088/pwa/push/send -H 'Content-Type: application/json' -d '{"title":"DSH 任务完成"}'` 手动触发。
- 「模型主动推送」由同一个 `dsh-push.mjs` 额外注册一个模型工具 `push_notify`（`title` 必填、`body` 可选），走的是同一条 `/pwa/push/send` 加密发送通道。工具描述里同时写清了**该调**和**不该调**的场景（只写前者会变成每回合都调），同一段文字还通过 `ctx.systemPrompt` 作为会话上下文再强化一遍，两处共用同一个常量、不会各改各的。宿主装了工具注册服务（`ctx.tools`）且没关闭时才会出现；`lan-gate.config.json` 的 `pushTool: false`（或环境变量 `DSH_PUSH_TOOL=0`）可以整体关掉。宿主侧限流独立于上面的自动推送：同一会话 60 秒内最多发 1 条，全部会话合计每小时最多 20 条，超出直接跳过（不发送、不算错误），避免模型高频调用把你手机刷成消息轰炸；发出去之后它会把去抖时钟拨到当下，所以紧跟其后的自动推送会被压掉。

---

## 🛡️ 安全边界

**防住了什么：**
- 配对码暴力破解——码本身 10 分钟一次性，连续 5 次错码会把那个来源 IP 锁 15 分钟。
- 令牌可以随时吊销——手机丢了、借给别人用完了，管理页点一下就失效，立即生效。
- 请求量——按解析出的真实客户端 IP 限流，默认每分钟 120 次，超了就 429。
- 管理面只有本机能碰——生成配对码、管理设备、触发推送，这些接口只认本机直连，经反代来的请求（一定带转发头）一律 403。

**没防住什么，需要你自己注意：**
- 反代配置错了——比如不小心把 `127.0.0.1:3088/lan-gate/admin` 也挂到公网域名下，或者 `X-Forwarded-Proto` 设错导致网关判断错客户端协议，这些是配置问题，网关本身防不住。
- 令牌被别人拿到——这是单用户工具，令牌等于访问权限，没有更细的权限分级；谁拿到令牌谁就能用，怀疑泄露就去管理页吊销重配。
- DSH 自身的能力边界——网关只负责把 HTTPS 流量安全地转发给 DSH，不会也不能给 DSH 本身加它没有的安全措施（比如 `/api` 自己的信任栅栏是 DSH 那边的事）。
- 状态文件 `~/.dsh/lan-gate-state.json` 明文存着 VAPID 私钥和所有设备的令牌——这个文件本身就等于全部访问权限，注意宿主机上它的文件权限，别把 `~/.dsh` 目录同步进公共网盘或备份到不受信的地方。

---

## ⚠️ 已知问题：iOS 26.x 视口收缩

现象:iPhone 上把 DSH 加到主屏、以独立 PWA 打开后,视口底部会凭空少掉一截(实测 iPhone 一台 26.5 系统上是 852 屏幕高度对 793 视口高度,少了正好一条状态栏的高度),从冷启动那一刻就在,直到你把整个 app 彻底退出重开才会恢复;在普通 Safari 标签页里打开同一个网址则完全正常。

这不是本插件的 bug,是 iOS 26.x 的系统级缺陷(独立 PWA 里第一次弹出软键盘后,布局视口永久性变矮,`innerHeight`/`visualViewport.height`/`100dvh` 三个值一起变小,社区已有记录)。少掉的那截视口在文档范围之外,任何 CSS 都够不着,只能由系统自己拿背景色画上——本仓库把 `manifest.json` 的 `background_color` 设成 `#f9fafb`(和界面半边浅色主题背景一致),让这条系统画的死区尽量看起来像页面背景的延伸,而不是一条突兀的黑条。

> 安卓底部那条**不是**这个值画的,别顺手改这里去治它:那是 Android 系统导航栏,跟随系统夜间模式,网页够不着(见下方「安卓导航栏」)。

这只是视觉缓解,不是根治:深色主题下这条带反而会更显眼(系统画的是 manifest 里那个固定颜色,没法跟着页面主题切换),而且它同时也是启动闪屏的颜色,所以闪屏从深色变成了浅色。真正的坏行为(视口变矮本身)只能等苹果修复系统缺陷。界面半边那边另外做了两层缓解(检测 + 主动摘窗重排),细节见该插件的 README。

---

## ❓ 常见问题

**从旧版本升级要做什么？**
旧版是按来源 IP 审批的，这套逻辑在新的令牌模型下没有意义。网关用新版本第一次启动时，会检测到旧的状态文件并直接把它改名归档成 `lan-gate-state.json.v1.bak`（不做数据迁移）。所有设备都需要重新走一遍配对流程。

**配对码提示过期或不对怎么办？**
配对码 10 分钟有效、用一次就失效，过期或用过了要回到本机管理页重新点「生成配对码」。如果连续输错 5 次，那个来源 IP 会被锁 15 分钟，等一等或者换个网络再试。

**推送收不到怎么排查？**
按顺序查：手机是不是用 HTTPS 域名访问的（HTTP 下浏览器根本不会注册 Service Worker，推送无从谈起）？浏览器/PWA 有没有被系统或用户拒绝通知权限？可以到本机管理页对应的状态接口（`/lan-gate/status`）看这台设备名字后面有没有 🔔 标记，确认订阅到底成功没有。

---

## ⚙️ 本机测试

```bash
npm test   # 起 mock 上游，跑 gateway/auth/push 三组测试：反代与注入、配对流程、推送发送
```

---

## 🗂️ 项目结构

| 路径 | 作用 |
| --- | --- |
| `lan-gate.mjs` | Cordis 插件入口：spawn 网关子进程 + 生命周期管理 |
| `dsh-push.mjs` | （可选）agent 完成推送宿主插件，调网关本机 `/pwa/push/send`；同时注册模型工具 `push_notify` |
| `lib/lan-gate-server.cjs` | 网关本体：单文件 CommonJS（Node stdlib + `web-push` 一个运行时依赖），HTTP/WebSocket 反代 + 配对/令牌 + 限流 + PWA 注入 + Web Push |
| `pwa/manifest.json` | PWA 安装清单 |
| `pwa/sw.js` | service worker（离线缓存 + 推送通知） |
| `pwa/inject.js` | 注入页引导：注册 SW + 加载手势 + 通知订阅 |
| `pwa/touch-gestures.js` | 边缘返弹 / 捏合缩放 |
| `pwa/app.css` | 移动触屏布局（`data-lan-device` 前缀，桌面零影响） |
| `pwa/offline.html` | 离线回退页 |
| `pwa/icons/` | SVG 源 + 192/512 PNG + maskable 图标 |
| `cordis.patch.yml` / `.example` | 插件 bundle 挂载层 / 静态挂载示例 |
| `test/gateway.test.cjs` | 网关启停、`/pwa` 资源、HTML 注入的冒烟测试 |
| `test/auth.test.cjs` | 配对流程、令牌、错码锁定、v1 状态归档、重启后设备存活 |
| `test/push.test.cjs` | 推送订阅与发送、VAPID 加密、失效订阅自动清理 |
| `test/util.cjs` | 测试共用的启动/请求/配对辅助函数（本身不是测试用例） |

---

## 🧑‍💻 开发贴士

- **隔离**：网关是子进程，`lan-gate.mjs` 只负责 spawn + 生命周期，永不 import 它的服务代码进 DSH 进程。
- **移动 CSS 前缀**：新规则一律挂 `html:not([data-lan-device="desktop"])`（不是字面量 `="phone"`——真机配对后默认是 `"auto"`，从来不会被打成 `"phone"`，挂字面量等于永远不生效），**桌面必须永不受影响**。
- **app.css 只放壳级规则**：字号、弹窗、composer 外观这类排版规则不要往这里加，那是界面半边的地盘（见 README「与界面半边的分工」一节）；新规则先问一句「这条是不是在跟界面半边抢同一个元素」。
- **稳定选择器**：用 `[data-slot=...]` / ARIA 而非 hash 类名，避免前端构建后失效。
- **注入页的单引号坑**：`lib/lan-gate-server.cjs` 里的注入脚本字符串，历史上有「双引号套双引号」bug，注意字面量转义。
- **本机直连判定**：新增/修改路由前先看 `isLocalDirect`——它是管理面 403 防护的唯一依据，别绕过它。

---

## 📝 更新日志

### v0.3.0

**新增**

- 与界面半边明确分工：排版类规则全部让出，本仓库只保留壳级 CSS（详见「与界面半边的分工」一节）；
- service worker 升到 v3：缓存策略从「静态壳 + 客户端资产都 stale-while-revalidate」改成「只有静态壳（manifest/图标/离线页）缓存优先，客户端 JS/CSS/API/页面 HTML 一律网络优先」，装了新版本手机上立刻吃到，不会跨部署残留旧 CSS；
- 首帧 HTML 直接带 `viewport-fit=cover`，独立 PWA 冷启动第一帧就有安全区，不用等客户端脚本补；
- `dsh-push.mjs` 新增模型工具 `push_notify`：agent 可以自己判断「该推一条给用户了」（需要决策/关键节点/出错需人工介入）主动触发锁屏推送，不必等到整个回合结束。同一条 aes128gcm 加密通道，宿主侧限流（会话 60 秒 1 条、全局每小时 20 条）与开关 `pushTool`（`lan-gate.config.json`）独立于原有的「回合结束自动推送」。

**修复**

- manifest/图标凭证豁免，不再挡在配对墙后（此前 Android/桌面 Chrome 因此看不到安装按钮，只有 iOS Safari 碰巧能装）；
- 网关剥掉 DSH 页面里排在前面的上游 manifest 标签，避免网关自己那份手机定制 manifest 被浏览器忽略；
- service worker 注册补 `scope: '/'` + 响应头 `Service-Worker-Allowed: /`，此前默认作用域只有 `/pwa/`，从未真正接管过整站；
- 删掉网关内联的 `DEVICE_CSS` 死代码副本——其中一条全屏弹窗规则会把界面半边的会话信息卡撑满屏并溢出视口，此前一直被误判为「iOS 内核差异」；
- CSS/手势的 `data-lan-device` 判定从字面量 `"phone"` 改成排除 `"desktop"`——真机配对后默认是 `"auto"`，此前这个判定条件让相关补丁在真机上从未生效过；
- 下拉刷新移除（误触发全页重载会把人从对话中间弹回列表）；边缘返回手势移除，让位给界面半边的左缘手势（原实现对 SPA 路由本就是空操作）；
- manifest 的 `background_color` 改成浅色，视觉缓解 iOS 26.x 独立 PWA 视口收缩留下的系统死区（已知系统缺陷，非根治，见「已知问题」一节）。安卓底部导航栏与该值无关。

**内部**

- `pwa/app.css` 从 163 行裁到 95 行；补充 `test/sw.test.cjs` 覆盖 service worker 的新缓存策略。

---

## 🙏 致谢

- [`dsh-mobile-gate`](https://github.com/Bernardxu123/dsh-mobile-gate)（MIT）——安全网关基座。
- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) —— 社区插件精选列表。

---

## ⚠️ 安全须知

安装插件 = 在你的机器上运行第三方代码，权限与你本人相同。收录/发布不等于安全审查。网关默认只监听 `127.0.0.1`，不会自己对公网裸奔——所有对外访问都必须经过你自己配置、终结 TLS 的反代。请：**只在你自己的服务器上跑、别把状态文件同步到不受信的地方、定期审计 `lib/lan-gate-server.cjs` 的变更**。

## License

MIT。网关 `lib/lan-gate-server.cjs` 基于 `dsh-mobile-gate` 扩展，保留原 MIT 版权与许可，详见 [LICENSE](../LICENSE)。
