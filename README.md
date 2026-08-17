<h1 align="center">dsh-mobile-pwa</h1>
<p align="center">把 DeepSeek Harness 变成能安全接到公网的手机 PWA：配对码认证 + 令牌身份 + 真 Web Push，你自己的反代终结 TLS。</p>

基于 MIT 的 [`dsh-mobile-gate`](https://github.com/Bernardxu123/dsh-mobile-gate)（安全网关基座）做差异化增强。

[![npm version](https://img.shields.io/npm/v/dsh-mobile-pwa)](https://www.npmjs.com/package/dsh-mobile-pwa)
[![license](https://img.shields.io/github/license/KyoMio/dsh-mobile-pwa)](https://github.com/KyoMio/dsh-mobile-pwa/blob/main/LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-ready-4c8dff)](https://github.com/topics/dsh-plugin)

📍 生态定位：社区现有移动端方案都停留在「窄屏 CSS 微调」，本项目做的是**移动端 PWA 一站式完整方案**——从公网身份认证到装到主屏、离线、推送，全流程打通。

---

## ✨ 特性

| 模块 | 说明 |
| --- | --- |
| 🔑 **公网身份** | 网关只监听 `127.0.0.1`，放在你自己的反代后面；新设备用配对码换取长期设备令牌（Cookie `lg_device`），身份跟着令牌走，与来源 IP 完全无关 |
| 📱 **真 PWA** | `manifest.json` + service worker：反代带来 HTTPS 后，手机浏览器「添加到主屏」真正生效，全屏独立窗口运行，带图标/启动屏/主题色 |
| 🧩 **可安装** | 主屏图标、`standalone` 显示、`apple-touch-icon`、maskable 图标 |
| 🌐 **离线可用** | service worker：只有真正的静态壳（manifest/图标）缓存优先，其余（客户端 JS/CSS、API、页面 HTML）一律网络优先，断网时给离线回退页 |
| 👆 **触屏手势** | 边缘右滑返回、捏合缩放字体（可重置） |
| 🔔 **任务完成推送** | 真 Web Push（VAPID 签名 + aes128gcm 加密），agent 干完活推送到手机，通知里不带对话内容 |
| 📐 **触屏布局** | 44px 触摸目标、safe-area 适配、全屏弹窗、紧凑排版、代码横向滚动——桌面零影响 |
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

## 🚀 快速开始

### 1. 安装插件

```bash
dsh plugin --profile web add github:KyoMio/dsh-mobile-pwa
```

已声明 `dsh.bundle` manifest，装完重启一下 `dsh web` 让新插件生效。

本地目录安装（自己 clone 下来改代码时用）：

```bash
git clone https://github.com/KyoMio/dsh-mobile-pwa.git
cd dsh-mobile-pwa
dsh plugin --profile web add ./dsh-mobile-pwa
```

也可以走静态挂载（参考 [`cordis.patch.yml.example`](cordis.patch.yml.example)，把绝对路径替换进你的 profile patch）或动态插件（见 `lan-gate.mjs` 注释），适合不想走 `dsh plugin add` 安装流程的场景。

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

#### 配好后自检（任何反代都做一遍）

用**手机流量**（不要连家里 Wi-Fi）访问 `https://你的域名/lan-gate/admin`——正确结果是 **403**。如果居然能看到管理页，说明反代没有带上 `X-Forwarded-*` 转发头，网关把公网请求误判成了本机用户，**立即回去检查转发头配置**（nginx 检查 `proxy_set_header` 两行；Lucky 检查「万事大吉」）。自检通过后再开始配对设备。

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

除了环境变量，**推荐用配置文件** `~/.dsh/lan-gate.config.json`（网关和推送插件两半共用一份，改完重启 `dsh web` 生效；显式环境变量优先于文件）：

```json
{
  "host": "0.0.0.0",
  "trustedProxies": "192.168.3.2",
  "rateLimit": 600,
  "pushSummary": true
}
```

字段名 = 环境变量去掉前缀转小驼峰：`port` / `host` / `targetPort` / `rateLimit` / `trustedProxies` / `vapidSubject`，推送半边是 `pushEvents` / `pushDebounceMs` / `pushSummary`。挂载行支持 Cordis config 的 DSH 版本也可以把网关配置写在 insert 行的 `config:` 下（同名小驼峰字段），效果等同。

推送宿主插件（可选）在 profile 的 `~/.dsh/profiles/web/cordis.patch.yml` 里挂载：

```yaml
- insert:
    - id: dsh-mobile-pwa-push
      name: dsh-mobile-pwa/dsh-push.mjs
```

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
- 「agent 干完活自动推送」由可选宿主插件 `dsh-push.mjs` 负责：它监听 DSH 事件总线并调用本机 `/pwa/push/send`。事件名通过 `DSH_PUSH_EVENTS`（逗号分隔）配置，默认 `agent/turn-stopping`——官方文档定义的「回合即将关闭」检查点（模型不再欠响应、无存活工具调用时触发，每回合一次）；如果你的 DSH 版本更旧/更新导致事件名不同，用该环境变量覆盖即可。`DSH_PUSH_DEBOUNCE_MS`（默认 15000）控制两条通知的最小间隔。想让通知带上这回合的结果摘要？设 `DSH_PUSH_SUMMARY=1`，通知正文会换成本回合最后一条助手消息（截 120 字）——推送 payload 本身是 aes128gcm 端到端加密的，Google/Apple 的推送服务器只见密文，剩下的暴露面是你自己的锁屏和通知中心（两大系统都支持「锁屏隐藏通知内容」，介意就开）。不装它也可以自己在任何脚本里 `curl -X POST http://127.0.0.1:3088/pwa/push/send -H 'Content-Type: application/json' -d '{"title":"DSH 任务完成"}'` 手动触发。

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
| `dsh-push.mjs` | （可选）agent 完成推送宿主插件，调网关本机 `/pwa/push/send` |
| `lib/lan-gate-server.cjs` | 网关本体：单文件 CommonJS（Node stdlib + `web-push` 一个运行时依赖），HTTP/WebSocket 反代 + 配对/令牌 + 限流 + PWA 注入 + Web Push |
| `pwa/manifest.json` | PWA 安装清单 |
| `pwa/sw.js` | service worker（离线缓存 + 推送通知） |
| `pwa/inject.js` | 注入页引导：注册 SW + 加载手势 + 通知订阅 |
| `pwa/touch-gestures.js` | 边缘返弹 / 捏合缩放 |
| `pwa/app.css` | 移动触屏布局（`data-lan-device` 前缀，桌面零影响） |
| `pwa/offline.html` | 离线回退页 |
| `pwa/icons/` | SVG 源 + 192/512 PNG + maskable 图标 |
| `cordis.patch.yml` / `.example` | 插件 bundle 挂载层 / 静态挂载示例 |
| `docs/spec-public-auth-push.md`、`docs/plan-public-auth-push.md` | 这次公网开放改造的设计文档与实施计划 |
| `test/gateway.test.cjs` | 网关启停、`/pwa` 资源、HTML 注入的冒烟测试 |
| `test/auth.test.cjs` | 配对流程、令牌、错码锁定、v1 状态归档、重启后设备存活 |
| `test/push.test.cjs` | 推送订阅与发送、VAPID 加密、失效订阅自动清理 |
| `test/util.cjs` | 测试共用的启动/请求/配对辅助函数（本身不是测试用例） |

---

## 🧑‍💻 开发贴士

- **隔离**：网关是子进程，`lan-gate.mjs` 只负责 spawn + 生命周期，永不 import 它的服务代码进 DSH 进程。
- **移动 CSS 前缀**：新规则一律挂 `html[data-lan-device="phone"]` 或排除 `desktop` 的 `@media(max-width:820px)`，**桌面必须永不受影响**。
- **稳定选择器**：用 `[data-slot=...]` / ARIA 而非 hash 类名，避免前端构建后失效。
- **注入页的单引号坑**：`lib/lan-gate-server.cjs` 里的注入脚本字符串，历史上有「双引号套双引号」bug，注意字面量转义。
- **本机直连判定**：新增/修改路由前先看 `isLocalDirect`——它是管理面 403 防护的唯一依据，别绕过它。

---

## 🙏 致谢

- [`dsh-mobile-gate`](https://github.com/Bernardxu123/dsh-mobile-gate)（MIT）——安全网关基座。
- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) —— 社区插件精选列表。

---

## ⚠️ 安全须知

安装插件 = 在你的机器上运行第三方代码，权限与你本人相同。收录/发布不等于安全审查。网关默认只监听 `127.0.0.1`，不会自己对公网裸奔——所有对外访问都必须经过你自己配置、终结 TLS 的反代。请：**只在你自己的服务器上跑、别把状态文件同步到不受信的地方、定期审计 `lib/lan-gate-server.cjs` 的变更**。

## License

MIT。网关 `lib/lan-gate-server.cjs` 基于 `dsh-mobile-gate` 扩展，保留原 MIT 版权与许可，详见 [LICENSE](LICENSE)。
