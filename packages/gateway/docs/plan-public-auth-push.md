# Plan: 公网开放改造实施计划

对应 spec：[spec-public-auth-push.md](spec-public-auth-push.md) · 分支 `rework/public-auth-push`

原则：每个任务独立可验收、测试跟着任务走（同一提交内红→绿）、任何时刻 `npm test` 全绿。顺序保证不出现「门开着」的中间态：认证先行，推送最后。

## T1 · 客户端身份解析（X-Forwarded-* 信任）

**改动**：`lib/lan-gate-server.cjs` 新增 `resolveClient(req)`：返回 `{ip, viaProxy, https}`。仅当 socket 为回环或在 `LAN_GATE_TRUSTED_PROXIES` 内才解析 `X-Forwarded-For`/`X-Forwarded-Proto`；`isLocalDirect = 回环 socket 且无转发头`。限流改用解析后 IP。`LAN_GATE_HOST` 默认改 `127.0.0.1`；`LAN_GATE_RATE_LIMIT` 环境变量真正接上。
**验收**：带 XFF 的回环请求被当作远程客户端；不带的照旧本机直通；非可信来源伪造 XFF 不生效（按 socket IP 计）。

## T2 · 状态文件 v2

**改动**：v2 结构（devices/pairing/vapid/pushSubscriptions，见 spec）；启动时检测 v1 `decisions` 结构 → 改名 `lan-gate-state.json.v1.bak`、以空 v2 起步；原子写沿用 tmp+rename。
**验收**：v1 文件被归档不加载；v2 读写往返一致；损坏 JSON 不崩溃、以空态起步。

## T3 · 配对流程（认证核心）

**改动**：
- `POST /lan-gate/pair` 生成配对码（本机直连专用）：8 位、TTL 10 分钟、一次性；
- 未配对远程请求 → 配对页（替换 pendingPage/轮询；表单提交码 + 可选设备名）；
- `POST /lan-gate/pair/claim`（远程可达）：校验码 → 建设备记录、签发令牌、`Set-Cookie lg_device`（XFP=https 时带 `Secure`）→ 302 `/`；失败按 IP 计 5 次锁 15 分钟；
- 删除：按 IP 的 decisions 判定、`?t=` 查询串下发、issued 绑定、deniedPage/boundPage。
**验收**：全流程真 HTTP 演练通过；错码锁定生效；令牌只经 Set-Cookie 出现，响应中无 URL 令牌。

## T4 · 全面执行令牌（HTTP + WebSocket + /pwa/*）

**改动**：转发判定统一为 `isLocalDirect || 有效 lg_device Cookie`；WebSocket upgrade 同判定；`/pwa/*` 静态资源同判定（配对页所需的内联样式不依赖 /pwa/*）；管理接口（admin/status/action）collapse 为 `isLocalDirect` 一个条件；admin 设备列表改为按设备（名称/kind/lastSeen/吊销），状态接口输出 devices + pairing 态。
**验收**：无 Cookie 远程请求任意路径（含 WS、/pwa/*）全部拦下；带转发头访问 admin → 403；吊销后同 Cookie 立即失效。

## T5 · 推送服务端（web-push 真实现）

**改动**：`package.json` 增 `dependencies: {"web-push": "^3"}`；首启生成 VAPID 对入状态文件；`PWA_BOOT` 注入真实公钥；`/pwa/push/subscribe` 要求有效设备令牌、订阅挂设备（每设备 1 条、全局 ≤20）、持久化；`/pwa/push/send` 仍限本机直连，改走 `webpush.sendNotification`；410/404 响应清除该订阅；吊销设备连带删订阅。
**验收**：mock push 端点收到的请求带 `Authorization: vapid` 且 body 非明文 JSON；无令牌订阅 403；上限 429；重启后订阅仍在。

## T6 · 客户端注入脚本收尾

**改动**：`pwa/inject.js` 把 VAPID 公钥（base64url→Uint8Array）接到 `applicationServerKey`；删除死代码 `setVapidKey`；订阅失败提示文案更新。`pwa/sw.js` 不动（逻辑本就正确，只是此前无 HTTPS 跑不起来）。
**验收**：注入后的页面脚本括号平衡测试（沿用现有 guard 用例）通过；bootstrap 含真实公钥。

## T7 · 宿主插件 dsh-push.mjs 重写（独立，可后置）

**改动**：对照实际 DSH 版本事件 API（先读 `.claude/skills/make-dsh-plugin/references/entry-contract.md` + 实机 `dsh --profile web --dump-config`）挂回合结束事件；一回合一条通知；通知体不带对话正文；`inject` 按实际服务名声明。
**验收**：人工冒烟——真实宿主装载，跑一回合收到一条不含正文的通知；宿主无 `cannot get property without inject` 报错。
**注**：被实际 API 卡住时不阻塞 T1–T6 发布，通知功能可先靠手动 curl `/pwa/push/send` 验证。

## T8 · 文档与发布

**改动**：README 重写（配对使用流程、nginx + Caddy 参考配置含 WS/转发头、安全边界、环境变量表）；README.en 同步；`cordis.patch.yml.example` 更新；版本 0.2.0；按 make-dsh-plugin 规范补仓库 description/topics；`.ai/STATE.md`、`DECISIONS.md` 记录本轮决策。
**验收**：照 README 从零走通「安装→配反代→配对→推送」；`dsh plugin --profile web add github:KyoMio/dsh-mobile-pwa#rework/public-auth-push` 一行装上。

## 依赖关系

T1 → T2 → T3 → T4 →（T5 → T6）→ T8；T7 独立，随时可做。T4 完成前不对外暴露任何部署。
