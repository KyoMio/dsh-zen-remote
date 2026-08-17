# Spec: 公网开放改造——配对码认证 + 反代对接 + 真 Web Push

分支：`rework/public-auth-push` · 状态：ready-for-agent · 2026-08-16

## Problem Statement

用户想在手机和其他电脑上随时随地使用自己家里/服务器上跑的 DSH Web UI。现状是：

- 网关的门禁按「来源 IP」审批，出了局域网（NAT/CGNAT、手机蜂窝网络）IP 又变又共享，整套认证失效；
- 全程明文 HTTP，浏览器因此拒绝注册 Service Worker——PWA 的「装到主屏、离线、推送」实际从未生效过；
- 推送发送端缺 VAPID 签名与 aes128gcm 加密，推送服务商直接拒收，「任务完成提醒」收不到；
- 若在同机套反代对外，所有外部请求源 IP 变成 127.0.0.1，命中现有「回环直通」分支，等于门全开。

用户有公网 IP，愿意自己配反代终结 TLS，不想用 VPN/隧道（不想每台设备装客户端）。

## Solution

把网关的信任模型从「IP 即身份」换成「配对码 + 设备令牌」：新设备打开站点看到配对页，输入电脑管理页生成的短时效配对码，换取长期设备令牌（Secure HttpOnly Cookie）。身份跟着令牌走，与 IP 无关。网关收缩为只监听 127.0.0.1，由用户的反代（nginx/Caddy）对外提供 HTTPS；网关通过 X-Forwarded-For 识别真实客户端。HTTPS 就位后 PWA 全套（主屏安装、离线、推送）真正可用；推送改用 web-push 标准实现（VAPID + 加密），订阅接口只对已配对设备开放，通知不携带对话内容。

## User Stories

1. As a 手机用户, I want 打开 https 网址后用一个短配对码完成配对, so that 不需要在手机上装任何客户端就能安全使用 DSH。
2. As a 手机用户, I want 配对一次后长期免登录（令牌存 Cookie）, so that 日常打开就是对话界面，没有重复认证摩擦。
3. As a 手机用户, I want 换了 Wi-Fi/蜂窝、IP 变了也不掉登录, so that 在地铁、公司、家里无缝切换。
4. As a 手机用户, I want 把 DSH 添加到主屏当 App 用, so that 有全屏、独立图标的原生体验。
5. As a 手机用户, I want 断网时看到离线页而不是浏览器报错, so that 知道是网络问题而非服务挂了。
6. As a 手机用户, I want 智能体完成任务时收到系统推送通知, so that 可以切走干别的，完事了再回来。
7. As a 手机用户, I want 推送通知不显示对话内容, so that 锁屏上不泄露我和智能体的对话，内容也不经过推送服务商。
8. As a 手机用户, I want 手机上看到紧凑排版（字号/弹窗/触摸目标适配）, so that 小屏也能舒服操作。
9. As a 其他电脑的用户, I want 用同样的配对码流程在笔记本浏览器配对, so that 出门用别的电脑也能访问，且保持桌面布局。
10. As a 本机管理员, I want 在管理页一键生成短时效、一次性的配对码, so that 授权窗口极小，码泄露也很快失效。
11. As a 本机管理员, I want 管理页列出所有已配对设备（名称、类型、最近活跃）, so that 随时掌握谁能访问我的机器。
12. As a 本机管理员, I want 单独吊销某台设备或一键全部吊销, so that 手机丢了/借出去过之后能立刻收权。
13. As a 本机管理员, I want 给每台设备设定访问方式（手机/电脑/自动）, so that 各设备拿到合适的排版。
14. As a 本机管理员, I want 管理页只能从本机直连访问（经反代进来的一律拒绝）, so that 外网没有任何入口碰到管理功能。
15. As a 本机管理员, I want 配对接口有严格的失败次数限制和锁定, so that 配对码无法被在线暴力猜出。
16. As a 本机管理员, I want 网关默认只监听 127.0.0.1, so that 即使我没配反代，机器也不会意外裸奔在公网。
17. As a 本机管理员, I want 订阅推送必须持有效设备令牌且有数量上限, so that 陌生人不能往我的服务器塞订阅、也不能借它对外打请求（SSRF）。
18. As a 本机管理员, I want 网关重启后已配对设备和推送订阅依然有效, so that 维护重启不用全家重新配对。
19. As a 反代运维者（同一个用户）, I want README 给出可直接抄的 nginx/Caddy 配置（含 WebSocket 与转发头）, so that 十分钟接好反代不踩坑。
20. As a 插件使用者, I want `dsh plugin --profile web add github:KyoMio/dsh-mobile-pwa` 一行安装, so that 不需要手工构建或改配置文件。

## Implementation Decisions

- **信任模型**：设备身份 = 令牌（32 字节随机，Cookie `lg_device`，`HttpOnly; SameSite=Lax`，经 `X-Forwarded-Proto: https` 时加 `Secure`）。彻底废除：按 IP 审批、局域网 IP 直通、`?t=` URL 下发令牌、「一次批准绑一个浏览器」的 issued 机制（配对码天然一码一设备）。
- **本机直连豁免（唯一保留的 IP 信任）**：socket 为回环 **且不带** `X-Forwarded-*` 头的请求视为本机用户——免配对直通、且是唯一能访问管理接口（admin/status/action/推送触发）的通道。经反代进来的请求永远带转发头，天然被排除。
- **代理头解析**：仅当 socket 来源为回环（反代同机）或 `LAN_GATE_TRUSTED_PROXIES` 列出的 IP 时才信任 `X-Forwarded-For`（取最后一个由可信代理追加的地址），否则以 socket IP 为准。限流按解析后的真实客户端 IP 计。
- **配对流程**：管理页「生成配对码」→ 8 位码（去混淆字符集），TTL 10 分钟、一次性；未配对设备访问任意路径得到配对页（替换原「等待批准」页），提交码 → 校验通过即签发设备令牌并 302 回 `/`。校验失败按 IP 计数，连续 5 次失败锁 15 分钟。配对时可带设备名；kind 默认 auto，管理页可改。
- **状态文件**：`~/.dsh/lan-gate-state.json` 换 v2 结构 `{version:2, devices:{id:{token,name,kind,createdAt,lastSeen,ua}}, pairing:{...}, vapid:{publicKey,privateKey}, pushSubscriptions:{...}}`。检测到 v1（decisions 结构）直接归档弃用（改名 `.v1.bak`），不做迁移——旧的按 IP 记录在新模型下无意义。
- **监听**：`LAN_GATE_HOST` 默认改为 `127.0.0.1`。保留端口占用 +1 重试、WebSocket 转发（升级请求同样验令牌 Cookie）、HTML 注入、限流（`LAN_GATE_RATE_LIMIT` 环境变量这次真正接上）。
- **推送**：引入公共 npm 依赖 `web-push`。VAPID 密钥对首启生成、持久化进状态文件；公钥经注入脚本下发给页面并真正接到 `applicationServerKey`（现有 `setVapidKey` 死代码顺手清掉）。`/pwa/push/subscribe` 要求有效设备令牌，订阅挂在设备记录下（每设备 1 条、全局上限 20），持久化；设备吊销时其订阅一并删除。`/pwa/push/send` 仍只允许本机直连触发，经 web-push 加密签名后发送；4xx 失效订阅自动清除。
- **通知内容**：只发「任务完成」级别的标题 + 会话名，不携带对话正文。
- **宿主插件 `dsh-push.mjs`**：现在的 hook 名试探数组和逐条消息触发全部重写——对照实际运行的 DSH 版本事件 API 挂「回合结束」事件，一回合一条通知。`inject` 声明按 0811 严格注入规则写实际用到的服务名。若实际 API 与预期不符，此项单独成任务，不阻塞网关侧改造。
- **打包**：维持 `dsh.bundle` + `cordis.patch.yml` 官方 bundle 形态；`web-push` 写入 `dependencies`（公共 npm 包，正常声明）；无构建步骤，纯源码入库，保持一行安装。
- **README**：重写为公网部署导向——配对使用流程、nginx 与 Caddy 参考配置（TLS、WebSocket upgrade、X-Forwarded-For/Proto）、安全边界说明；删除「Tailscale/LAN」旧叙事。

## Testing Decisions

- **接缝（唯一）**：网关子进程的 HTTP 外壳。沿用 `test/gateway.test.cjs` 现有模式——spawn 真实 `lib/lan-gate-server.cjs`（临时 `DSH_HOME`、固定高位端口）+ mock 上游 DSH HTTP 服务，全部断言走真实 HTTP 请求。只测外部行为（状态码、Set-Cookie、响应体、转发到 mock 上游/mock 推送端点的请求），不碰内部函数。
- **模拟远程客户端**：测试请求带 `X-Forwarded-For` / `X-Forwarded-Proto` 头（socket 是回环 → 可信代理路径），即可在本机完整演练「外网设备」视角，无需真实第二台机器。
- **新增用例**：配对全流程（生成码→提交→拿 Cookie→后续请求直通）；错码计数与锁定；无令牌远程请求一律见配对页（含 WebSocket 升级被拒）；管理接口对带转发头的请求 403；`?t=` 流程确认已删除；订阅无令牌 403、超上限 429；推送发送打到 mock push 端点且请求带 `Authorization: vapid` 头、body 非明文 JSON（加密生效的行为证据）；v1 状态文件被归档不加载。
- **宿主插件 `dsh-push.mjs` 不在自动化范围**：依赖真实 DSH 宿主，人工冒烟验证（装载后跑一回合看通知）。

## Out of Scope

- TLS 终结、证书、域名、DDNS——由用户的反代负责，插件只消费 `X-Forwarded-*`。
- 多用户/多角色体系——所有配对设备同权，仍是单用户工具。
- 二维码配对、TOTP、WebAuthn——配对码已满足威胁模型，这些是后续增强。
- `reference/` 下另两个仓库（dsh-mobile-gate、dsh-web-mobile）的任何改动；dsh-web-mobile 作为独立 UI 插件并装即可。
- DSH 主服务本身的任何修改。

## Further Notes

- 开放问题：宿主「回合结束」事件的确切 API 需要对照用户实际运行的 DSH 版本确认（`.claude/skills/make-dsh-plugin/references/entry-contract.md` 为契约参考）。网关侧不依赖此答案。
- HTTPS 是 PWA 生效的先决条件：Service Worker 在非安全上下文根本不注册。反代就位前，推送/离线在真机上无法验收（自动化测试不受影响）。
- 上游 remote 已配置（`upstream/main`），改造期间不追上游；如上游有安全修复再评估 cherry-pick。
