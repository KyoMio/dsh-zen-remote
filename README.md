<h1 align="center">dsh-zen-remote</h1>
<p align="center">把 DeepSeek Harness 变成一个能从公网安全访问的手机 App：移动端界面重排 + 配对认证网关 + 装到主屏 + 锁屏推送。</p>

<p align="center">
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT"></a>
<img src="https://img.shields.io/badge/release-v1.1.7-5B4CF0?style=flat-square" alt="v1.1.7">
<img src="https://img.shields.io/badge/DSH-Web%20Profile-5B4CF0?style=flat-square" alt="DSH Web Profile">
</p>

| 会话列表主屏 | 会话页 | 会话信息卡 |
| --- | --- | --- |
| ![会话列表主屏](assets/home.png) | ![会话页](assets/session.png) | ![会话信息卡](assets/info.png) |

| composer 权限 sheet | 公网设备看到的配对页 |
| --- | --- |
| ![composer 权限 sheet](assets/sheet.png) | ![配对页](assets/pairing.png) |

> 截图为 390×844 手机视口、浅色主题；深浅主题均适配。配对页是网关自绘页面，固定深色设计。

---

## 安装

```sh
dsh plugin add dsh-zen-remote
```

装完重启 `dsh web`，手机界面与网关一起生效，不需要再手写任何配置行。

> 兼容性：在 DSH `0.1.1-rc.2`（web profile）上开发并实测，最后验证 2026-08-22。

卸载：`dsh plugin remove dsh-zen-remote`（或从 profile 的 `dependencies` 与 `bundles` 里删掉那两行），重启 `dsh web` 即恢复原状；要清掉配对数据再删 `~/.dsh/lan-gate-state.json` 与 `~/.dsh/lan-gate.config.json`。

<details>
<summary>手动写法 / 本地开发</summary>

手动改 `~/.dsh/profiles/web/package.json`——`dependencies` 一行、`bundles` 一行：

```jsonc
{
  "dependencies": {
    "dsh-zen-remote": "^1.1.7"        // 本地开发换成 "link:/path/to/dsh-zen-remote"
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
# 重启 dsh web
```

不想走 profile 安装流程的静态挂载写法见 [`cordis.patch.yml.example`](cordis.patch.yml.example)。

</details>

---

## 配置公网访问

装完在本机 `127.0.0.1:3080` 就能用手机界面。要从外面访问，按下面三步走。

### 1. 配一个反代中继 HTTPS

网关默认只监听 `127.0.0.1:3088`，必须由你自己的反代对外。**家宽没有公网 IP、或者不想开路由器端口**，就跳过 nginx/Caddy 直接看第三个块（Cloudflare Tunnel）。

<details open>
<summary><b>nginx</b></summary>

```nginx
# http {} 块里加一次
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
<summary><b>没有公网 IP？用 Cloudflare Tunnel</b></summary>

家宽拿不到公网 IP、或者不想在路由器上开端口时用这个：`cloudflared` 从你这台机器主动连出去，Cloudflare 那边负责域名、证书和入口，路由器一个端口都不用开。免费版够用。

前置：域名托管在 Cloudflare（NS 指过去）。

1. 打开 [Zero Trust 控制台](https://one.dash.cloudflare.com/) → **Networks → Tunnels → Create a tunnel** → 选 **Cloudflared**，起个名字，创建后页面会给你一条带 token 的安装命令；
2. 在跑 DSH 的这台机器上执行那条命令（就是下面这个形状，token 用页面给的）：

   ```sh
   # macOS / Linux：装成常驻服务，开机自启
   cloudflared service install eyJhIjoi...你的token
   ```

3. 回到隧道详情页 → **Public Hostname** → **Add a public hostname**：

   | 字段 | 填什么 |
   | --- | --- |
   | Subdomain / Domain | `dsh` / `example.com`（即 `dsh.example.com`） |
   | Service Type | `HTTP` |
   | URL | `127.0.0.1:3088` |

   保存后 `https://dsh.example.com` 就通了，证书 Cloudflare 自动签。网关的 `LAN_GATE_HOST` 保持默认 `127.0.0.1` 即可——`cloudflared` 就在本机。

**装完必须做第 2 步的 403 自检**，这一步对隧道尤其要紧：`cloudflared` 和网关走的是本机回环连接，网关区分「公网访客」和「坐在这台电脑前的你」，全靠隧道有没有带上 `X-Forwarded-For`。`cloudflared` 默认是带的，所以配对墙正常生效；但万一你的版本或配置把它去掉了，公网请求就会被当成本机管理员，配对墙形同虚设——**用手机流量访问 `/lan-gate/admin`，看到 403 才算安全**。

> 提示：不用设 `LAN_GATE_TRUSTED_PROXIES`——网关本来就把回环来的连接当作可信反代，填 `127.0.0.1` 是空操作，也**不能**替代上面那个自检。
>
> Cloudflare 免费版支持 WebSocket（DSH 对话流需要），单个请求体上限 100MB，高于本插件默认的 20MB 上传上限，不影响使用。

命令行流程（`cloudflared tunnel login` / `create` / `route dns` + `config.yml` 里写 ingress）见 [docs/remote-access.md](docs/remote-access.md#cloudflare-tunnel没有公网-ip-时的接入方式)。
</details>

Lucky（路由器/NAS）的配法见 [docs/remote-access.md](docs/remote-access.md#lucky)。反代与网关不在同一台机器时，要把反代出口 IP 填进 `LAN_GATE_TRUSTED_PROXIES`。

### 2. 自检

用**手机流量**（别连家里 Wi-Fi）访问 `https://你的域名/lan-gate/admin`，正确结果是 **403**。

能看到管理页说明反代没带 `X-Forwarded-*` 头，公网请求被当成了本机用户——回去检查转发头再往下走。

### 3. 配对设备

```sh
# 在跑 DSH 的这台机器上，用本机浏览器打开
open http://127.0.0.1:3088/lan-gate/admin
```

1. 点「生成配对码」，得到 8 位码（10 分钟有效、只能用一次）；
2. 手机打开你的 HTTPS 域名，在配对页输入这个码；
3. 配对成功即进入 DSH，身份存在长期 Cookie 里，换网络不掉线；
4. 浏览器菜单「添加到主屏幕」装成 App；
5. 同意通知权限，agent 干完活推到锁屏。

管理页还能改设备名、设备类型，或单独/全部吊销设备。

---

## 可选配置

环境变量，或 `~/.dsh/lan-gate.config.json`（键名是变量去前缀转小驼峰，如 `port` / `trustedProxies`；显式环境变量优先）。改完重启 `dsh web`。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LAN_GATE_PORT` | `3088` | 网关端口；被占用自动往上试（最多 +20） |
| `LAN_GATE_HOST` | `127.0.0.1` | 监听地址；反代不在本机时才需要放开 |
| `LAN_GATE_TARGET_PORT` | `3080` | 本机 DSH Web UI 端口 |
| `LAN_GATE_RATE_LIMIT` | `120` | 未配对请求的每分钟上限（按真实客户端 IP） |
| `LAN_GATE_TRUSTED_PROXIES` | 空 | 逗号分隔 IP；反代不在本机时必填 |
| `LAN_GATE_VAPID_SUBJECT` | `mailto:admin@localhost` | 推送联系人。**iOS 必须改成真实邮箱或 https 网址**，否则 Apple 拒发 |
| `DSH_PUSH_TURN_END` | **关** | 设 `1` 让「回合结束」也推一条。默认不推——回合结束不代表需要你（1.0.3 之前是默认推的，这是行为变更）。等授权、等回答这两类通知不受它影响，永远推 |
| `DSH_PUSH_EVENTS` | `agent/turn-stopping` | 「回合结束」算哪些事件，逗号分隔；只在 `DSH_PUSH_TURN_END=1` 时有意义 |
| `DSH_PUSH_DEBOUNCE_MS` | `15000` | 两条自动推送的最小间隔；等授权/等回答的通知不受压制 |
| `DSH_PUSH_SUMMARY` | 关 | 设 `1` 让通知带上本回合的最终回复（只取正文，不含思考过程；截 120 字）和提问原文 |
| `DSH_PUSH_TOOL` | 开 | 设 `0` 关掉模型可调用的 `push_notify` 工具 |

上传大小上限（默认 20MB）在插件行的 `config.maxUploadBytes` 里改。

想在电脑端也启用回合过程折叠（默认只在手机宽度生效），在插件行的 `config.turnFoldDesktop` 里设 `true`——即在 profile 的 `cordis.patch.yml` 加一条：

```yaml
- id: dsh-zen-remote
  config:
    turnFoldDesktop: true
```

改完重启 `dsh web`。不改服务端配置的话，单个浏览器也可以访问一次 `?mobile-nav-turn-fold=1` 自己开启（`=0` 关闭，按浏览器记忆）。

**软键盘抬升的三个校准值**。少数手机上，键盘弹出时系统压根不告诉浏览器键盘有多高（实测过：某些第三方输入法 + Chrome；小米浏览器装的 PWA 壳）。这时插件没有任何可测的信号，只能按估算把输入框抬起来。估算值是照一台报告过的机器定的，别的机器可能偏高或偏低，所以三个数都能在插件行里改：

| 配置项 | 默认 | 含义 | 允许范围 |
| --- | --- | --- | --- |
| `keyboardLiftRatio` | `0.42` | 抬升高度按屏幕高度的这个比例估算 | 0 ~ 1 |
| `keyboardLiftMaxPx` | `400` | 估算值的上限（像素），防止在长屏手机上把输入框顶到屏幕中间 | 0 ~ 2000 |
| `keyboardSafetyPadPx` | `15` | 键盘顶部再留出的一点余量，**仅安卓**。第三方输入法常常少报自己的高度（把键盘上方那条工具栏漏掉），这一点余量就是补它的 | 0 ~ 200 |

```yaml
- id: dsh-zen-remote
  config:
    keyboardLiftRatio: 0.45
    keyboardSafetyPadPx: 30
```

怎么调：输入框抬得**不够**（还被键盘挡住一截）就调大 `keyboardLiftRatio`，一次加 0.03 试；抬得**过头**（输入框和键盘之间空出一条）就调小。只差一点点（几十像素以内、且是安卓）优先加 `keyboardSafetyPadPx`。三个值一个都不写就是现在的行为，不受影响；写超出范围的值会被自动收进上表的区间，不会把输入框顶出屏幕。正常手机走的是实测路径，这几个值对它们完全没有影响。

---

## 通知什么时候会响

默认只在**真正需要你**的时候响，分两条互不依赖的线。

**一、系统自己判断的（恒开，且不受最小间隔压制）**

| 情况 | 通知 |
| --- | --- |
| 某个工具在等你授权 | 「DSH 等你授权」，带工具名 |
| 模型调用 `ask_user_question` 在等你回答 | 「DSH 等你回答」 |

这两类不看会话层级——子代理自己卡在授权上，照样喊你，因为等的还是你。也**不受
`DSH_PUSH_DEBOUNCE_MS` 压制**：「有操作等你点头」是最不能被吞掉的一条。

策略自动放行的授权不会打扰你：请求发起后先等 1.5 秒，配对的「已决定」到了就取消，
只有真正悬着没人管的才推。

**二、模型自己决定的**

`push_notify` 工具，模型在这些时候该调：你明确要求做完通知、需要你介入才能继续、
出现你大概率想立刻知道的意外。不该调的场景（常规回合结束、进度汇报、它自己能推进
的事）同样写在工具描述里——只写前者会让它每回合都调。会话开始还会注入一段同源的
上下文强化，和工具描述共用一个常量，不会各改各的。

**默认不会响的**

- **普通跑完一轮不推**（1.0.3 起的行为变更，此前每回合都推）。干完活本身不等于
  需要你。想要旧行为设 `DSH_PUSH_TURN_END=1`。
- **子代理跑完永远不推**，无论上面那个开关。

**通知里写什么**：默认只有标题，不带对话内容。开 `DSH_PUSH_SUMMARY=1` 才带这一轮
的最终回复——只取正文，不含思考过程；这一轮没说话就退回「最后执行了 xx 工具」，不拿思考内容凑数。
推送 payload 是 aes128gcm 端到端加密的。

---

## 功能

- 会话列表主屏 + 独立会话页两级页面栈，横向推入推出
- 主屏插件入口 chips，按已装插件自动出现，显隐可自定义
- composer 重排：控件图标化，权限/模型菜单变成底部 sheet
- 会话信息卡：六格统计 + 导出日志 / 重命名 / Fork / 归档
- 同一回合的推理与工具调用默认折叠成一条「过程 · N 步」
- 手势：左边缘右滑返回、底部 sheet 下滑关闭；安卓系统返回手势接管为「先关弹层 → 退回列表 → 退出应用」，不再一按就退出 PWA
- 手机本地附件上传：落到会话工作目录 `.dsh-uploads/`，输入框追加 `@` 引用，发不发你说了算
- 配对码换长期设备令牌，认令牌不认 IP，可随时吊销
- 管理面（生成配对码 / 管理设备 / 触发推送）只认本机直连，经反代一律 403
- 真 PWA：manifest + service worker，可装到主屏、可离线打开
- 真 Web Push：VAPID + aes128gcm，通知默认不带对话正文；默认只在等授权/等回答时响，回合结束不再打扰（见上）
- `push_notify` 工具：模型可在关键节点自己推一条，带限流
- 「内测声明」弹窗注入「不再弹出」可选项：远程访问每次刷新都会重弹声明，点一次后本设备记住选择、以后自动关闭

深度说明：[界面](docs/interface.md) · [公网接入](docs/remote-access.md)

---

## 已适配的第三方插件

移动端 UI 对下列插件做了专门适配。所有适配都锚定对应插件自己的 DOM 标记：
没装该插件时规则不生效，装了未列出的插件也不会被误伤。

| 插件 | 移动端适配内容 | 实测版本 |
| --- | --- | --- |
| [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | 会话页头部提供工作台入口按钮；面板变手机全宽抽屉并避让刘海安全区；底部居中的关闭按钮 | 0.15.0 |
| [@nanmicoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | AgentTeams 活动浮层挪到会话头部下方（原位置压住头部按钮）、会话列表页自动隐藏；子代理会话头部保留可点的父会话标题，一键切回主会话 | 0.1.9 |
| [@ychris12138/dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats) | 用量与余额入口收进主屏 chips 行 | 0.2.9 |
| [@opendsh/dsh-plugin-scheduled-tasks](https://github.com/Ceelog/dsh-plugins) | 定时任务入口收进主屏 chips 行 | 0.2.3 |
| dsh-at-file | @文件引用，配合附件上传的 `@` 路径引用使用；它和本插件的附件 chip 读同一份草稿 token，手机端隐藏它 `.dsh-uploads/` 下那几行以免同一个文件被画两遍（缩略图 + 文件名），其余 `@` 引用不动 | 0.6.7 |
| [@ace-zone/dsh-market](https://www.npmjs.com/package/@ace-zone/dsh-market) | 插件市场弹窗顶栏在手机上放不下，关闭的 × 被挤出面板外（触屏没有 Esc，等于关不掉）；隐藏标语 / 版本号 / 官网链接三个装饰位，标题改成省略号收缩，语言切换和 × 保留并加大点按面积 | 0.1.66 |
| [dsh-vision-toolkit](https://www.npmjs.com/package/@anionex/dsh-vision-toolkit) | 图像 Q&A/OCR，配合手机端附件上传使用 | — |
| [dsh-web-ui 全家桶](https://www.npmjs.com/package/@linxin666/dsh-web-ui-all) | 沿用上游 dsh-web-mobile 的兼容规则（文件树 / 预览浮层限宽居中等） | — |

各项适配的技术细节（锚点选择器、断点、取舍记录）见[界面文档](docs/interface.md)的「兼容插件」一节。

---

## 已知问题

**iOS 26.x 独立 PWA 视口缩水**：加到主屏后视口底部会少掉一条状态栏高度，普通 Safari 标签页正常。这是 iOS 系统缺陷，缺掉的区域在文档之外，CSS 够不着；本插件做了三层缓解（浅色 manifest 背景 + 安全区补偿 + 强制重排），能减轻但不保证复原。彻底恢复只能整个 App 退出重开。

**个别环境软键盘对浏览器完全不可见，输入框抬升靠估算兜底**：部分组合（实测过：某些第三方输入法 + Chrome；小米浏览器安装的 PWA 壳）里，键盘弹出/收起时系统不把键盘高度告知页面——视口不变、无任何事件（visualViewport、VirtualKeyboard API 一并失效，均已实测排除）。插件的兜底是：聚焦后探测约 1.2 秒，判定「键盘不可见」就按估计高度抬升输入框（判定按浏览器记忆，之后聚焦即时抬升）。代价有两条：抬升高度是估算的，可能与实际键盘有几十像素出入；键盘收起同样无信号，输入框要等你点击或滑动输入框以外的区域才回落。正常环境完全不走这条路径，不受影响。抬升高度差得明显的话不用改代码，插件行的 `keyboardLiftRatio` / `keyboardLiftMaxPx` / `keyboardSafetyPadPx` 三个值可以照着自己的机器调，见上面「配置」一节。

**经反代访问时设置页打不开（插件配置列表空白、模型卡片报「settings are unavailable in this browser」）**：直连 `127.0.0.1:3080/3088` 正常。

根因是 DSH 官方的设计，不在网关：设置类 RPC **只对回环连接开放**。客户端按 `location.hostname` 判定（`dsh-client-connection` 的 `isLoopback`），非回环时 `dsh-client-ui-settings` 把持久化降级为 `memory`，设置镜像初始状态就是 `unavailable`——官方源码注释原话是「remote browsers remain process-local because settings RPCs are loopback-only」。所有依赖这个镜像的卡片（模型、插件配置）因此一起空白，与本插件、与 service worker 缓存都无关（2026-08-20 真机 USB 调试 + 本机对照实测）。

绕法：要改配置就回跑 DSH 的那台机器上用本机浏览器改，配置存在后端，改完手机侧其它功能不受影响。想让远程也能改设置，得由上游放开这条限制。

---

## 权限与数据

- **网络**：网关只监听本机（默认 `127.0.0.1:3088`），对外暴露完全由你的反代/隧道决定；推送经浏览器推送服务商中转（内容 aes128gcm 端到端加密，服务商读不到）；插件自身不向任何第三方上报数据。
- **文件**：附件上传只写入当前会话工作目录下的 `.dsh-uploads/`；配对状态与配置存在 `~/.dsh/lan-gate-state.json` / `lan-gate.config.json`。
- **凭据**：不收集、不存储任何账号密码；设备身份是本插件自己签发的随机令牌（HttpOnly Cookie）。

排障：运行日志在 `~/.dsh/logs/web.log`（网关与推送的行带 `[dsh-zen-remote-*]` 前缀）；手机端界面自检可用调试徽章（首页顶栏连点 5 下开关）。安全问题请走 GitHub Security Advisories 私下报告，不要公开提 issue。

## 上游致谢

本插件的界面层衍生自 [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)，通道层衍生自 [zylzyqzz/dsh-mobile-pwa](https://github.com/zylzyqzz/dsh-mobile-pwa)（其自身衍生自 [Bernardxu123/dsh-mobile-gate](https://github.com/Bernardxu123/dsh-mobile-gate)），均为 MIT，原始版权行保留在 [LICENSE](LICENSE)。

## License

[MIT](LICENSE)
