<h1 align="center">dsh-zen-remote</h1>
<p align="center">一个 DeepSeek Harness 插件、两种角色。<b>主服务端</b>把 DSH 变成手机能安全访问的 PWA（手机界面、配对网关、锁屏推送），并把选定的会话共享给已配对的桌面端；<b>子客户端</b>跑在另一台 DSH 桌面端里，把服务端共享的会话直接摆进自己的侧边栏——完整历史、实时进度、发消息、审批、终端，全部在服务端执行。</p>

<p align="center">
<a href="https://www.npmjs.com/package/dsh-zen-remote"><img src="https://img.shields.io/npm/v/dsh-zen-remote?style=flat-square&color=5B4CF0&logo=npm&label=npm" alt="npm version"></a>
<a href="https://www.npmjs.com/package/dsh-zen-remote"><img src="https://img.shields.io/npm/dm/dsh-zen-remote?style=flat-square&color=0B7285&label=downloads" alt="npm downloads"></a>
<a href="https://github.com/KyoMio/dsh-zen-remote/actions/workflows/publish.yml"><img src="https://img.shields.io/github/actions/workflow/status/KyoMio/dsh-zen-remote/publish.yml?style=flat-square&label=publish&logo=githubactions&logoColor=white" alt="publish workflow"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT"></a>
<br>
<img src="https://img.shields.io/badge/DeepSeek%20Harness-0.1.7%20%E2%80%93%200.2.x-4D6BFE?style=flat-square" alt="DeepSeek Harness 0.1.7 – 0.2.x">
<img src="https://img.shields.io/node/v/dsh-zen-remote?style=flat-square&color=339933&logo=nodedotjs&logoColor=white" alt="Node">
<a href="https://www.npmjs.com/package/dsh-zen-remote#provenance"><img src="https://img.shields.io/badge/npm-provenance%20signed-CB3837?style=flat-square&logo=npm&logoColor=white" alt="npm provenance"></a>
<img src="https://img.shields.io/badge/PWA-Web%20Push-5A0FC8?style=flat-square&logo=pwa&logoColor=white" alt="PWA + Web Push">
<img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript strict">
</p>

<p align="center"><a href="README.md">English</a></p>

| 会话列表主屏 | 会话页 | 会话信息卡 |
| --- | --- | --- |
| ![会话列表主屏](assets/home.png) | ![会话页](assets/session.png) | ![会话信息卡](assets/info.png) |

| composer 权限 sheet | 公网设备看到的配对页 |
| --- | --- |
| ![composer 权限 sheet](assets/sheet.png) | ![配对页](assets/pairing.png) |

> 截图为 390×844 手机视口、浅色主题；深浅主题均适配。配对页由网关绘制，按 DSH 官方风格、跟随系统浅色 / 深色。

---

## 目录

1. [安装](#1-安装)
2. [快速上手（一体化配置与配对向导）](#2-快速上手一体化配置与配对向导)
   - [场景 A：配置主服务端并配对手机 / 电脑](#场景-a作为主服务端开放手机与另一台电脑连入)
   - [场景 B：配置另一台电脑作为桌面客户端](#场景-b作为桌面客户端连接远端服务端)
3. [日常使用：会话共享与跨端协作](#3-日常使用会话共享与跨端协作)
4. [锁屏推送：通知什么时候会响](#4-锁屏推送通知什么时候会响)
5. [功能一览](#5-功能一览)
6. [进阶配置与字段参考](#6-进阶配置与字段参考)
7. [架构、安全模型与已知说明](#7-架构安全模型与已知说明)

---

## 1. 安装

### 界面一键安装（推荐，桌面端 App 与 Web 端通用）

打开 DSH 左侧**「插件」**页 → 点击**「添加插件」**→ 输入 `dsh-zen-remote` → 安装完成后点击**「立即启用」**，然后重启 DSH 桌面端 App（或 `dsh web`）。

### Web 服务命令行安装（无头服务器 `dsh web`）

```sh
dsh plugin --profile web add dsh-zen-remote
# 然后重启 dsh web
```

> `dsh plugin` 必须带 `--profile` 指定目标 profile。桌面端的 `desktop` profile 由 App 独占管理，命令行会拒绝 `--profile desktop`，桌面端请直接使用上面的界面安装。

<details>
<summary>手动编辑 Profile / 本地开发（<code>link:</code> 安装）与升级、卸载说明</summary>

**手工改 profile**（本地开发、`link:` 装法）：把依赖写进 profile 的 `package.json`（桌面端在 `~/.dsh/profiles/desktop`，Web 端在 `~/.dsh/profiles/web`），并确保 `"dsh-zen-remote"` 已加入同文件 `dsh.profile.bundles` 数组末尾：

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": {
    "dsh-zen-remote": "^2.3.4"        // 本地开发换成 "link:/path/to/dsh-zen-remote"
  }
}
```

```sh
cd ~/.dsh/profiles/desktop && pnpm install
# 若使用 link: 本地仓库，还需在仓库目录内执行一次 npm install --omit=dev 安装网关子进程的 web-push 依赖
```

**升级与迁移注意**：
- **开着 HMR 升级插件**：先卸载再添加（`dsh plugin --profile <name> remove dsh-zen-remote` 后再 `add`），直接在运行中的旧版上覆盖安装不会被干净接管。
- **DSH 0.2.1-alpha.3+ 模板重置**：`dsh --profile <name> --from-default-profile <模板>` 会用新副本覆盖自定义 profile，执行前请先备份 `~/.dsh/profiles/<name>`。
- **从 1.x 升级**：2.0 起挂载层合并为 `dsh-zen-remote` 单行，主入口按角色自动加载网关与推送，请删掉 `cordis.patch.yml` 里旧的 `dsh-zen-remote-gateway` / `dsh-zen-remote-push` / `dsh-push.mjs` 行。原有 `~/.dsh/lan-gate.config.json` 与已配对设备全部自动保留，无需重配。
- **彻底卸载**：在「插件」页点「卸载」后重启。若需连同配对与共享记录一并清空，删除 `~/.dsh/lan-gate-state.json`、`~/.dsh/lan-gate.config.json`、`~/.dsh/zen-remote-shares.json` 与 `~/.dsh/zen-remote-server.json`。

</details>

---

## 2. 快速上手（一体化配置与配对向导）

同一个插件包含两种运行角色：
- **作为服务端（主机，`role: host`）**：运行主力会话、启动本地安全网关与锁屏推送，允许手机浏览器/PWA 或另一台电脑连入。
- **作为桌面客户端（从机，`role: client`）**：不启动网关也不抢端口，连接到远端服务端，把服务端共享的会话直接挂载到本机侧边栏。

打开 DSH **「插件」页 → 点击 `dsh-zen-remote`**，页面顶部就是**「远程访问与设备配对」**向导卡片：

![插件详情页顶部的「远程访问与设备配对」状态总览卡片](docs/images/wizard-overview.png)

---

### 场景 A：作为主服务端（开放手机与另一台电脑连入）

点击卡片上的**「开始配置向导」**（已配置过则点**「修改接入配置」**），三步完成：

#### 第 1 步：选择「作为服务端（主机）」与接入方式

![配置向导第 1 步：选择本机角色与服务端接入方式](docs/images/wizard-step1-role-path.png)

根据你的网络环境四选一（切换接入方式时，向导会自动停止上一方式的托管进程并重置网关监听地址）：

| 接入方式 | 适合什么环境 | 向导自动为你做什么 |
| --- | --- | --- |
| **内置 Caddy（推荐）** | 有公网 IP（或已做路由器端口映射）+ 域名托管在 Cloudflare | 自动下载预编译的 `Caddy + caddy-dns/cloudflare`（中国大陆网络自动走镜像源加速），通过 DNS-01 自动申请并续期 HTTPS 证书；网关仅监听 `127.0.0.1:3088` |
| **使用已有反向代理** | 机器上已跑着 Nginx、Caddy 或 Lucky | 自动生成带 WebSocket 与 `X-Forwarded-*` 头的现成配置片段，支持一键将反代源 IP 写入受信任代理列表（手配完整说明见 [docs/remote-access.md](docs/remote-access.md)） |
| **Cloudflare Tunnel 内网穿透** | 没有公网 IP / 不想配路由器端口映射 + 域名托管在 Cloudflare | 自动下载 `cloudflared`（国内网络自动走镜像源加速），调用 Cloudflare API 自动创建或复用隧道、写入 DNS CNAME 记录并拉起隧道；网关仅监听 `127.0.0.1:3088` |
| **局域网 / Tailscale 直连** | 手机或另一台电脑在同一 Wi-Fi / 局域网，或共用 Tailscale 虚拟局域网 | 无需域名与公网证书；自动识别本机局域网 / Tailscale IPv4 地址并监听 `0.0.0.0:3088`，同时网关内置**私网源 IP 铁闸**，直接拒绝任何公网 IP 的未代理明文直连（`403 public-direct-forbidden`） |

#### 第 2 步：填写连接参数
- **内置 Caddy / Cloudflare Tunnel**：填写公开访问域名（如 `dsh.example.com`）并粘贴 Cloudflare API 令牌（点击输入框旁的「如何获取 API 令牌？」可查看分步指引与权限表；域名尚未接入 Cloudflare 可点底部「域名尚未接入 Cloudflare？」查看迁入步骤）。
- **使用已有反向代理**：填写反代对外提供的 `https://` 地址，点击「查看 Nginx / Caddy / Lucky 配置片段」复制到你的反代中。
- **局域网 / Tailscale 直连**：向导会自动检测并预填 `http://<本机局域网或Tailscale IP>:3088`，确认即可。

#### 第 3 步：连通验证与扫码 / 配对码配对

![配置向导第 3 步：自动连通性检测、手机扫码配对与桌面客户端配对](docs/images/wizard-step3-verify-pair.png)

1. **启动入口服务 & 自动连通自检**：
   - 若选了「内置 Caddy」或「Cloudflare Tunnel」，先点顶部状态栏的**「启动 Caddy」**或**「创建并启动隧道」**。
   - 向导会自动探测「本地网关就绪」与「访问地址连通」（自动验证外部访问 `/` 返回 `401` 配对页且 `/lan-gate/admin` 返回 `403` 隔离）。
2. **配对手机 / 浏览器（Web 应用端）**：
   - 保持在「配对手机 / 浏览器（扫码）」标签页，点击**「生成配对二维码」**。
   - 用手机相机或浏览器扫码打开配对页，输入屏幕上的 8 位配对码即可进入 DSH；随后在手机浏览器菜单点**「添加到主屏幕」**安装为独立 PWA，并允许通知权限以接收锁屏推送。
3. **配对另一台电脑（桌面客户端）**：
   - 切换到**「配对另一台电脑（桌面客户端）」**标签页，点击**「生成桌面配对码」**，然后点击**「复制地址与配对码」**发给另一台电脑。

> **日常快捷操作**：配置完成后，无需再进向导——直接在插件详情页顶部的总览卡片底部点**「配对手机 / 扫码」**、**「配对另一台电脑」**或**「管理设备」**（支持重命名设备、切换设备角色、单独或全部移除设备、发送测试推送）。

---

### 场景 B：作为桌面客户端（连接远端服务端）

在另一台装了 DSH 桌面端的电脑上：

1. 打开「插件」页 → `dsh-zen-remote` → 点击**「开始配置向导」**。
2. **第 1 步**：选择**「作为桌面客户端（从机）」**，点击「下一步」。
3. **第 2 步**：填写本机显示名称（如 `MacBook-Pro`）、主服务端的访问地址（公网必须为 `https://`，局域网 / Tailscale 可为 `http://192.168.x.x:3088` 或 `http://100.x.x.x:3088`）以及从主服务端复制来的 8 位桌面配对码，点击**「配对并连接」**。
4. **第 3 步**：三盏状态灯（「本地配对凭证」「服务端连接」「会话与插件同步」）全绿即表示连接成功，左侧边栏会立即出现主服务端共享的工作区与会话分组。

---

## 3. 日常使用：会话共享与跨端协作

| | **Web 应用端（手机 / 平板 / 浏览器）** | **桌面应用端（另一台 DSH 桌面客户端）** |
| --- | --- | --- |
| 可见范围 | 主服务端上的**全部**会话 | **仅**主服务端已开启「远程访问」的会话（服务端中继强制隔离） |
| 配对凭证 | 浏览器长期 HttpOnly Cookie | 插件配置中的加密设备令牌（Bearer Token） |

### 如何开启或关闭单个会话的远程共享

服务端默认只将你选定的会话暴露给桌面客户端（也可在向导第 2 步勾选「新建会话自动开启远程共享」）。有四个开关入口：

1. **主服务端侧边栏**：在会话行的「…」菜单里点**「开启远程 / 关闭远程」**；

   ![主服务端在会话的「…」菜单里开启远程](docs/images/host-share-menu.png)

2. **主服务端会话页标题栏**：点击标题右侧的地球图标（悬停可查看剩余闲置休眠时间；图标带绿点代表此刻有桌面客户端正在查看）；
3. **手机端（Web 应用端）会话页**：打开右上角会话信息卡片，切换**「远程访问」**开关；

   <p align="center"><img src="docs/images/mobile-info-remote.png" alt="手机会话信息卡片里的「远程访问」开关" width="320"></p>

4. **主服务端设置页**：「已开启远程的会话」列表支持逐个关闭或一键全部关闭。

### 在子客户端上使用远程会话

- **侧边栏分组**：服务端至少有一个会话开启远程后，子客户端侧边栏底部会出现**「服务端名 · 工作区名」**分组，点开即可像本地会话一样查看历史、流式对话、审批工具、使用终端、查看文件树与 Git diff、下载交付物或拖拽上传附件。

  ![子客户端侧边栏里的「书房 · Desktop」分组，标题行是远程连接状态图标](docs/images/client-sidebar.png)

- **关闭与自动休眠**：开启远程的会话若连续 **48 小时**（`idleHours` 可调）无任何回合活动，会自动休眠关闭远程（正在运行或等待审批/回答的会话绝不休眠）。当会话关闭远程、或客户端主动取消配对/被服务端移除时，侧边栏会自动将其归档隐藏；正在查看的会话页会展示「远程已关闭」横幅并禁用输入，重新开启后自动恢复。

  ![远程被关闭后，会话页输入框上方的「远程已关闭」横幅](docs/images/client-remote-closed.png)

---

## 4. 锁屏推送：通知什么时候会响

默认只在**真正需要你介入**的时候响，分为两条独立通道（推送载荷全程 `aes128gcm` 端到端加密）：

1. **系统自动触发（恒开，不受最小间隔压制）**：
   - **工具等待授权**：推送「DSH 等你授权」（附带工具名）。为配合自动审批插件，默认等待 `DSH_PUSH_APPROVAL_GRACE_MS`（5 秒），5 秒内已被自动审批处理的操作不会打扰你。
   - **模型调用 `ask_user_question` 等待回答**：推送「DSH 等你回答」。
   - 子代理会话卡在授权或提问上时同样会推送。
2. **模型主动调用（`push_notify` 工具）**：
   - 当你交代「做完告诉我」、或模型遇到阻塞必须你拍板时，模型会主动调用 `push_notify` 推送到手机锁屏。
   - 普通回合结束默认不推送（如需每轮结束都推，可在进阶配置中打开 `pushTurnEnd`）；开启 `pushSummary` 可在通知正文中附带本轮最终回复摘要（120 字以内，不含思考过程）。

---

## 5. 功能一览

- **移动端 PWA 界面（主服务端）**：
  - 会话列表主屏 + 独立会话页两级页面栈（支持左缘右滑返回、安卓返回手势接管、冷启动首帧骨架屏与内容哈希长缓存）
  - 主屏第三方插件入口 chips（按已装插件自动浮现，可自定义显隐）
  - 底部重排 composer（图标化按钮，权限与模型切换改为底部 Sheet，支持手机本地拍照/文件上传）
  - 会话信息卡（六格 token/耗时统计、导出日志、重命名、Fork、归档、一键导出 PNG 分享长图、远程访问开关）
- **一体化配置与配对向导（2.3 新增）**：
  - 插件详情页顶部集成 2×2 实时状态总览与三步向导弹窗，统一管理服务端四路接入（内置 Caddy、已有反代、Cloudflare Tunnel、局域网/Tailscale 直连）与桌面客户端配对
  - 预编译 `Caddy + caddy-dns/cloudflare` 与 `cloudflared` 自动下载，内置中国大陆网络自动探测与镜像加速（`gh-proxy.com` / `ghfast.top`）、连接超时与断流自动切换源，并由 GitHub Actions 每日巡检跟随上游版本自动更新
  - 局域网 / Tailscale 模式自动探测本机内网 IP 自检，网关内置私网源 IP 铁闸拦截公网未代理明文直连
  - 独立「已配对设备管理」弹窗，以及客户端解配/吊销时自动归档清理侧边栏残留会话
- **跨桌面端远程会话（桌面客户端）**：
  - 侧边栏远程工作区分组，支持完整对话流、审批/提问抢答同步、服务端模型目录同步、文件树与改动 diff、服务端远程终端
  - 交付物分段流式下载到本机、服务端 LibreOffice 渲染 Office 文档 PDF 预览、最大 500 MiB 非图片大文件流式上传与拖拽文件自动转上传
- **第三方插件桥（Plugin Bridge）**：
  - 协作插件登记桥接声明或通过内置适配器（如 `dsh-better-sidebar`），即可在子客户端的远程会话中直接读写主服务端的数据面板（整机数据需服务端主人在设置页逐插件授权）。详见 [插件桥文档](docs/plugin-bridge.md)。

深度说明：[界面设计文档](docs/interface.md) · [公网接入与中继协议](docs/remote-access.md)

---

## 6. 进阶配置与字段参考

日常使用只需通过插件详情页顶部的**「远程访问与设备配对」向导**即可完成全部配置。若需微调底层参数，可在 `dsh-zen-remote` 插件详情页的**「包含的组件」**下再次点击 `dsh-zen-remote` 展开底层配置卡片。

<details>
<summary>查看底层配置卡片截图与全部字段参考表</summary>

每个字段按此顺序取第一个合法值：**环境变量 > 插件行设置 > `~/.dsh/lan-gate.config.json` > 默认值**。修改需要重启网关/推送的字段后插件会自动重载，无需重启 App。

| 主服务端角色与配对卡片 | 已开启远程的会话列表 | 子客户端配置与诊断卡片 |
| --- | --- | --- |
| ![主服务端角色](docs/images/host-settings-role.png) ![配对与设备](docs/images/host-pairing.png) | ![已开启远程的会话](docs/images/host-settings-shares.png) | ![子客户端设置](docs/images/client-settings.png) |

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `role` | `host` | `host` 运行网关 + 推送 + 共享；`client` 作为桌面客户端连接远端服务端 |
| `serverName` | 电脑名 | **设备名称**（≤ 40 字），主服务端作侧边栏分组标题，子客户端作配对登记名，双向自动同步 |
| `port` | `3088` | 本地网关端口；被占用时自动向上递增重试（最多 +20） |
| `host` | `127.0.0.1` | 网关监听地址；本机反代/隧道保持 `127.0.0.1`，局域网/Tailscale 直连设为 `0.0.0.0` |
| `targetPort` | （自动） | 本机 DSH Web UI 端口，留空自动探测宿主实际监听端口 |
| `rateLimit` | `120` | 未配对请求每分钟速率上限（按真实客户端 IP 计数） |
| `trustedProxies` | 空 | 逗号分隔的受信任反代 IP（反代不在本机时配置） |
| `vapidSubject` | `mailto:admin@localhost` | Web Push 联系标识（**iOS 必须为真实邮箱或 `https://` 网址**，否则 Apple 拒收） |
| `lang` | `auto` | 网关页面与通知语言：`auto`（跟随浏览器）、`zh`、`en` |
| `pushTurnEnd` | 关 | 普通回合结束时是否也发送推送（等授权/等回答的通知恒开，不受此项影响） |
| `pushEvents` | `agent/turn-stopping` | 触发回合结束推送的事件名（逗号分隔） |
| `pushDebounceMs` | `15000` | 两条自动推送之间的最小间隔毫秒数 |
| `pushSummary` | 关 | 推送通知正文是否附带本回合最终回复摘要（截断至 120 字） |
| `pushTool` | 开 | 是否向模型注册 `push_notify` 主动推送工具 |
| `idleHours` | `48` | 远程共享会话的闲置自动休眠时长（小时，范围 `(0, 8760]`） |
| `autoShareNewSessions` | 关 | 主服务端新建的会话是否自动开启远程共享 |
| `pluginBridgeConsent` | `{}` | 插件桥整机数据授权表（插件名 → 布尔值） |
| `serverUrl`（客户端） | 空 | 远端主服务端的网关地址（公网强制 `https://`，内网允许 `http://`） |
| `deviceToken`（客户端） | 空 | 配对签发的客户端设备令牌（密钥字段，界面脱敏） |
| `turnFoldDesktop` | 关 | 是否在桌面端宽度也默认折叠回合中间过程 |
| `keyboardLiftRatio` / `keyboardLiftMaxPx` / `keyboardSafetyPadPx` | `0.42` / `400` / `15` | 软键盘高度不可见环境下的输入框抬升校准参数 |
| `maxUploadBytes` | 20 MB | 手机端单次附件上传大小上限 |

历史环境变量（优先级高于插件行）：`LAN_GATE_PORT`、`LAN_GATE_HOST`、`LAN_GATE_TARGET_PORT`、`LAN_GATE_RATE_LIMIT`、`LAN_GATE_TRUSTED_PROXIES`、`LAN_GATE_VAPID_SUBJECT`、`LAN_GATE_LANG`、`DSH_PUSH_TURN_END`、`DSH_PUSH_EVENTS`、`DSH_PUSH_DEBOUNCE_MS`、`DSH_PUSH_SUMMARY`、`DSH_PUSH_TOOL`、`DSH_PUSH_LANG`、`DSH_PUSH_APPROVAL_GRACE_MS`。

</details>

---

## 7. 架构、安全模型与已知说明

### 安全模型与信任边界

- **已配对的桌面客户端属于受信任设备**：远程会话中的终端以**服务端当前系统用户**权限运行，文件预览接口可读取服务端进程有权限访问的文件，且可在服务端任意工作区新建会话。
- **未开启远程的会话严格隔离**：未共享会话的列表、历史、流式事件、审批/提问以及内嵌的 `dsh-session:` 引用均在服务端中继层直接过滤或拒绝，绝不仅是在前端隐藏。
- **公网明文直连防护**：即便在局域网模式下将网关监听设为 `0.0.0.0`，网关底层的 `isPrivateOrLoopbackIp` 铁闸也只放行本机回环、RFC1918 局域网段与 Tailscale（`100.64.0.0/10` / `fd7a:115c:a1e0::/48`）的直连请求；任何来自公网 IP 的未代理直连一律返回 `403 public-direct-forbidden`。
- **管理操作仅限服务端本机**：生成配对码、修改设备角色、配置向导、吊销设备均只允许在服务端本机操作。
- **数据与隐私**：插件自身不向任何第三方收集或上报数据。配对状态存于 `~/.dsh/lan-gate-state.json`，共享表存于 `~/.dsh/zen-remote-shares.json`，托管的 Cloudflare 令牌以 `0600` 权限存于 `~/.dsh/zen-remote-ingress/`。

### 版本容错

1. **中继协议版本**：主服务端与子客户端的 `dsh-zen-remote` 版本需保持一致。
2. **DSH 宿主版本**：两端 DSH 版本可以不同。连接握手时自动比对接口组规范化指纹，存在差异的分组在侧边栏标注「（版本有差异）」，仅受影响的单面板降级，其余功能照常工作。

### 已知限制与常见问题

<details>
<summary>展开查看已知限制、iOS PWA 适配与已适配第三方插件列表</summary>

**已知限制**
- 同时打开多个 DSH 窗口时，子客户端对「当前正打开哪个会话」的判断可能存在偏差。
- 切换服务端或服务端重建同 ID 工作区后，需刷新一次客户端页面以重新加载侧边栏分组。
- 远程会话禁用「导出会话」，并隐藏会在服务端机器本机弹窗的「在访达中显示 / 在应用中打开」按钮。
- 经反向代理在外部浏览器访问时，DSH 宿主自身的「设置」页不可修改（DSH 官方设计将设置 RPC 限制为本机回环连接），修改插件配置请直接在服务端本机操作。

**iOS 独立 PWA 已知系统问题**
- **iOS 26.x 独立 PWA 视口缩水**：添加到主屏幕后底部可能少一条状态栏高度（iOS WebKit 缺陷），插件已内置三层缓解，彻底恢复需划掉 App 重开。
- **iOS 26+ 顶部系统渐进模糊**：从主屏幕打开时顶部约 95px 区域可能出现系统合成层模糊遮罩（`WKScrollPocket`），点进任意会话再返回列表页即可消除。

**已适配的第三方插件**

| 插件 | 移动端与远程适配内容 | 实测版本 |
| --- | --- | --- |
| [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | 移动端右栏全屏抽屉、左缘滑回与安全区避让；**插件桥**内置适配 `0.25.0` 至 `0.28.2` 七版（服务端授权后远程会话可直接读写服务端文件/Git/任务面板） | 0.19.1 / 适配器 0.25–0.28.2 |
| [@nanmicoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | AgentTeams 活动浮层避让会话顶栏、子代理头部保留父会话一键返回 | 0.1.9 |
| [@ychris12138/dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats) | 用量与余额入口收进手机主屏 chips 行 | 0.2.9 |
| [@opendsh/dsh-plugin-scheduled-tasks](https://github.com/Ceelog/dsh-plugins) | 定时任务入口收进手机主屏 chips 行 | 0.2.3 |
| dsh-at-file | 手机端去重 `.dsh-uploads/` 附件引用行 | 0.6.7 |
| [@ace-zone/dsh-market](https://www.npmjs.com/package/@ace-zone/dsh-market) | 插件市场弹窗顶栏移动端紧凑化，保留关闭按钮与语言切换 | 0.1.66 |
| [dsh-vision-toolkit](https://www.npmjs.com/package/@anionex/dsh-vision-toolkit) | 配合手机端附件上传进行图像问答/OCR | — |
| [dsh-web-ui 全家桶](https://www.npmjs.com/package/@linxin666/dsh-web-ui-all) | 沿用文件树与预览浮层移动端限宽居中规则 | — |

</details>

---

## 上游致谢

本插件的界面层衍生自 [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)，通道层衍生自 [zylzyqzz/dsh-mobile-pwa](https://github.com/zylzyqzz/dsh-mobile-pwa)（其自身衍生自 [Bernardxu123/dsh-mobile-gate](https://github.com/Bernardxu123/dsh-mobile-gate)），均为 MIT，原始版权行保留在 [LICENSE](LICENSE)。

## License

[MIT](LICENSE)
