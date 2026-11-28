# ZR-7 形式化模型 ↔ 源码实现逐条对照（Sync 基线 `f93eb25c`）

本文记录 `docs/formal/` 下 3 份 TLA+ 规约与 `dsh-zen-remote` 源码的逐动作对照、12 项反向变异（able-to-fail）结果、开源仓如实发现（Findings），以及模型边界与未建模假设。

- **分支 / 同步基线**：`zr7-formal-models`（基于 `dev@f93eb25c`）
- **工具**：TLC `2.19`（`/opt/homebrew/bin/tlc` + OpenJDK 17）与 `$pstack-statechart`

---

## 一、子系统 1：`PairingWizardReconnect.tla` ↔ 实现

| TLA+ 动作 | 实现位置 | 语义对照与抽象说明 |
|---|---|---|
| `WizardOpenWithoutRestart` | `src/client/wizard/GatewayWizard.tsx:898-913` | 未改动 `RESTART_FIELDS` 时直接进入就绪态，`rowGen == configGen`。 |
| `WizardEditRestartField` | `src/restart-watcher.ts:92-140` (`startRestartWatcher`)、`src/restart-fields.ts:19-35` (`RESTART_FIELDS`)、`src/wizard/verify.ts:87-97,223-226` | 改写重启字段（如 `host`/`trustedProxies`/`port`）使指纹漂移：内存 `VerificationSession` 判 `stale` 作废（`codeMintedAtGen' = -1`），`startRestartWatcher` 触发 `fiber.restart()` 进入重载。 |
| `CompleteRowReload` | `src/index.ts:2318-2324` (`fiber.restart()`)、`src/client/wizard/GatewayWizard.tsx:987-1003` | 插件行重启完成且新子网关端口就绪后 `rowGen' = configGen`、`wizardPhase' = "ready"`。 |
| `MintPairingCode` | `src/wizard/verify.ts:171-215` (`createVerificationManager.start`) | 仅在 `wizardPhase = "ready"` 且 `rowGen = configGen` 时向网关 `POST /lan-gate/pair` 铸造配对码。 |
| `ClaimPairing` | `src/client-pairing.ts:181-207` (`classifyClaimResponse`)、`lib/lan-gate-server.cjs` claim 路径 | 兑换当前代次配对码，建立已配对设备凭证与在线态。 |
| `RejectUnauthWsUpgrade` | `lib/lan-gate-server.cjs:1450-1460` (`server.on('upgrade')`) | 远端未认证请求（`!local && device === undefined`）直接返回 `HTTP/1.1 403 Forbidden` 并关闭 socket。 |
| `AdmitAuthWsUpgrade` | `lib/lan-gate-server.cjs:1461-1500` | 仅当已配对且在线时放行 WS 隧道，并在上游连接就绪回调二次核验 `live === device && live.role === admittedRole`。 |
| `RevokeDevice` | `lib/lan-gate-server.cjs:1493-1499` (`openSockets` teardown)、`src/relay-client.ts:913-920` | 吊销设备立即拆断已开 WS socket，重置 `paired = FALSE` 与 `relayState = "unpaired"`。 |
| `TransportDrop` | `src/relay-client.ts:895-922` (`setState('offline')`) | 传输断开使 `relayState` 降为 `"offline"`、WS 断开；浏览器 `snapshot.view?.state` 仍暂留旧 `"online"`（忠实刻画陈旧视图窗口）。 |
| `StatusPollSync` | `src/client-data/remote-status.ts:479-523` | `RemoteStatusStore` 轮询同步 `snapshot.view?.state` 到最新服务端状态。 |
| `HintSuppressedWhileOnline` | `src/client-data/remote-status.ts:545` (`if (snapshot.view?.state === 'online') return`) | 浏览器视图仍为 `"online"` 时 `network-hint` 被健康链路门控吞掉，不发 `POST /client/network-hint`。 |
| `NetworkHintSend` | `src/client-data/remote-status.ts:540-562` → `src/client-routes.ts:1272-1314` (`CLIENT_NETWORK_HINT_ROUTE`) → `src/relay-client.ts:1717-1752` (`probeHealth`) | 视图非 `online` 时发送 `network-hint`，服务端先调用只读 `relay.probeHealth()`（`GET /_dsh/zen-remote/relay/ping`）。 |
| `ProbeSucceedsAndRestores` | `src/client-routes.ts:1305-1312`、`src/relay-client.ts:1757-1765` (`networkRestored`) | `probeHealth()` 返回 `true` 才推进到 `networkRestored()` 发起受控重连。 |
| `ProbeFailsNoReconnect` | `src/client-routes.ts:1306-1309` | `probeHealth()` 返回 `false` 直接响应 `{ ok: true, reachable: false, reconnected: false }`，绝不调用 `networkRestored()` 或 `connect()`。 |
| `ManualRetry` / `ConnectSucceeds` / `ConnectFails` | `src/client-routes.ts:1214-1270` (`CLIENT_RECONNECT_ROUTE`)、`src/relay-client.ts:1704-1709` (`reconnect`) | 用户显式点击重连触发 `reconnect()`，成功转 `online`，失败回 `offline`。 |

- **模型验证结果**：46 distinct states，150 states generated，深度 12，5 条不变量 + `NoDeadlock` 全通过（0 反例，exit 0）。
- **状态图**：[pairing-wizard-reconnect.mmd](./pairing-wizard-reconnect.mmd)（11 态 / 23 边）。

---

## 二、子系统 2：`PluginBridgeRouting.tla` ↔ 实现

| TLA+ 动作 | 实现位置 | 语义对照与抽象说明 |
|---|---|---|
| `AdapterRegister` | `src/index.ts:819-825`、`src/plugin-bridge.ts:560-570` (`registerNormalized`) | 仅当 `registry.get(plugin) === undefined` 时由内置适配器注册 `(v1, d1)` 声明并持有独立 dispose 身份。 |
| `AdapterYieldsToPlugin` | `src/index.ts:820-823` | 若插件已先行通过 `zenRemote.bridge(...)` 登记，适配器主动让位并保留插件条目。 |
| `PluginSelfRegister` | `src/plugin-bridge.ts:548-559` (`register`) | 插件自身调用 `zenRemote.bridge(...)` 时无条件覆盖同名适配器条目并更新 `(v2, d2)` 摘要。 |
| `StaleAdapterDispose` | `src/plugin-bridge.ts:565-569` (`byPlugin.get(plugin) !== normalized`) | 适配器旧 dispose 闭包的引用相等守卫发现槽位已被插件声明替换，安全 no-op 不误删插件条目。 |
| `ActiveAdapterDispose` / `PluginDispose` | `src/plugin-bridge.ts:554-569` | 当前持有者注销时清空槽位并回到 `unregistered`。 |
| `HandshakeSync` | `src/plugin-bridge.ts:628-649` (`compareBridges`) | 严格按 `offline → server-too-old → not-on-server → version-mismatch → declaration-mismatch → consent-off → bridged` 顺序裁决，仅名+精确版本+精确摘要（及 `server` scope 授权）全一致才进入 `bridged`。 |
| `HandleVirtualRequest` | `src/plugin-route-intercept.ts:701-708,1078-1183` (`surrogateHandler` / `answerUnbridged`)、`src/plugin-route-intercept.ts:673-690,2650-2660` (`answerUnbridgedSocket`) | 携带 `zr~` 虚拟 ID 的已声明路由在非 `bridged` 态一律返回统一 `503`（`x-zen-remote: unbridged`），绝不落入本机 `originalHandler`。 |
| `HandleLocalRequest` | `src/plugin-route-intercept.ts:1142-1145` (`passthrough`) | 不含 `zr~` 虚拟 ID 的本机请求直接透传本机原处理器。 |

- **模型验证结果**：77 distinct states，736 states generated，深度 5，4 条不变量 + `NoDeadlock` 全通过（0 反例，exit 0）。
- **状态图**：[plugin-bridge-routing.mmd](./plugin-bridge-routing.mmd)（7 态 / 23 边）。

---

## 三、子系统 3：`GatewayRateLimitAuth.tla` ↔ 实现

| TLA+ 动作 | 实现位置 | 语义对照与抽象说明 |
|---|---|---|
| `WsConnectUntrusted` | `gateway-server/src/peer-hub/ws-hub.ts:319-331` (`resolvePreAuthClientIp`)、`:676-685` (`setupConnection`) | `socketIp ∉ trustedProxies` 时无视伪造 `x-real-ip`/`x-forwarded-for`，一律按 `socketIp` 归入直连桶；超 per-IP 或全局上限以 WS `1013` 拒连。 |
| `WsConnectTrustedProxyA` / `WsConnectTrustedProxyB` | `gateway-server/src/peer-hub/ws-hub.ts:327-331,676-685` | `socketIp ∈ trustedProxies` 时解析合法 `x-real-ip` 分桶限流；注：`resolvePreAuthClientIp` 仅读取 `x-real-ip`，不读取 `x-forwarded-for`；HTTP 侧 `requestClientIp`（`auth.ts:475-477`）恒取 `socket.remoteAddress`。 |
| `WsReleasePreAuth` | `gateway-server/src/peer-hub/ws-hub.ts:700-708` | 认证结束或 socket 关闭时释放预认证并发槽位。 |
| `AdminReqValidBearerWithCookie` | `gateway-server/src/http/auth.ts:409-417` (`requireAdmin`)、`gateway-server/src/server.ts:133-135` | `/api/v1/admin/*` 携带合法 `Authorization: Bearer` 时以内置 `SYSTEM_API_ADMIN` 放行，免疫同请求中携带的浏览器 Cookie。 |
| `AdminReqInvalidBearerWithCookie` | `gateway-server/src/http/auth.ts:411-415` | `/api/v1/admin/*` 携带无效 `Bearer` 时直接抛 `401 INVALID_API_KEY`，即使请求同时带有效 admin Cookie 也绝不回退。 |
| `AdminReqCookieOnly` | `gateway-server/src/http/auth.ts:418-422` | 无 `Bearer` 头时读取 `zr_gw_session` Cookie 并校验 `role === 'admin'`。 |
| `UserReqWithBearerAndCookie` | `gateway-server/src/http/auth.ts:367-374` (`requireUser`)、`:980-991` (`handleMe`) | **如实暴露 Finding #1**：非 admin 路由（`requireUser` 与 `handleMe`）仅读取 Cookie，未检视 `Authorization: Bearer`。 |
| `SignupOtpForAdmin` | `gateway-server/src/http/auth.ts:1015-1026` (`handleSendOtp('signup')`)、`:914-969` | 注册发码对已存在邮箱置 `deliver = false`，admin 邮箱永不获发注册验证码或自动登录会话。 |
| `ResetPasswordOtpForAdmin` | `gateway-server/src/http/auth.ts:1027-1035` (`handleSendOtp('reset_password')`)、`:1042-1076` | **如实暴露 Finding #2**：忘记密码发码仅判断 `existing !== null && existing.active`，未排除 `existing.role === 'admin'`（仍不签发任何会话 Cookie）。 |

- **通过配置验证结果（`GatewayRateLimitAuth.cfg`）**：270 distinct states，1978 states generated，深度 6，5 条代码真实成立不变量 + `NoDeadlock` 全通过（0 反例，exit 0）。
- **状态图**：[gateway-rate-limit-auth.mmd](./gateway-rate-limit-auth.mmd)（13 态 / 25 边，3 个正交区域）。

---

## 四、开源仓如实发现（Findings，未篡改模型亦未擅改产品代码）

按 `$pstack-create-formal-verification-skill`「Findings stay findings」铁律，对 `GatewayRateLimitAuth.tla` 运行更严格的目标规约 `GatewayRateLimitAuth-finding.cfg`（TLC / `$pstack-statechart` 退出码 `1` / `12`），实证以下 2 处代码与目标期望的差距：

1. **Finding #1（`InvAllRoutesBearerOverridesCookie` 违反，深度 2 / 1 步反例）**
   - **代码位置**：`gateway-server/src/http/auth.ts:367-374`（`requireUser`）与 `:980-991`（`handleMe`）；调用面覆盖 `routes-account.ts`、`routes-networks.ts`、`routes-topology.ts`。
   - **现象**：仅 `requireAdmin` 检查 `readBearerToken(ctx.req)`；所有非 admin 路由只读 `zr_gw_session` Cookie。若自动化脚本或客户端在携带用户浏览器 Cookie 的同时传 `Authorization: Bearer <token>` 请求 `/api/v1/auth/me` 或 `/api/v1/networks`，路由会忽略 `Bearer` 并按 Cookie 用户身份执行（1 步反例：`Init -> UserReqWithBearerAndCookie`）。
2. **Finding #2（`InvAdminRefusedAllOtpDelivery` 违反，深度 2 / 1 步反例）**
   - **代码位置**：`gateway-server/src/http/auth.ts:1027-1035`（`handleSendOtp` 的 `reset_password` 分支）与 `:1042-1076`（`handleResetPassword`）。
   - **现象**：`signup` 分支因 `existing !== null` 拒绝给已注册的 admin 发码，但 `reset_password` 分支仅校验 `existing !== null && existing.active`，未判断 `existing.role !== 'admin'`。因此启用 SMTP 时，激活态 `admin` 邮箱仍可收到并核销 `reset_password` OTP（不过整个 OTP 流程确实从不签发 `zr_gw_session` 会话，`InvAdminNeverIssuedOtpSession` 成立）。

---

## 五、反向变异验证（Able-to-Fail，12/12 全部捕获）

所有变异均在 `/tmp` 临时副本上以 `tlc -workers 1` 验证（原始规约保持不变）：

| 编号 | 破坏点 | 捕获不变量 | TLC 结果 | 复现方式 |
|---|---|---|---|---|
| **Mut1A** | `ProbeFailsNoReconnect` 改回切入 `connecting` | `InvProbeFailNeverAutoReconnects` | exit 12（22 distinct states） | 将 `relayState'` 改为 `"connecting"` 跑 `PairingWizardReconnect.cfg` |
| **Mut1B** | `NetworkHintSend` 删去 `viewState /= "online"` 门控 | `InvHintGatedByOnlineView` | exit 12（12 distinct states） | 去掉门控并记录 `hintSentWhileViewOnline'` |
| **Mut1C** | `MintPairingCode` 允许在 `reloading` 态铸码 | `InvPairingCodeOnlyAfterReload` | exit 12（6 distinct states） | 允许 `wizardPhase \in {"reloading","ready"}` |
| **Mut1D** | `AdmitAuthWsUpgrade` 删去 `/\ paired` 前置 | `InvUnauthWsUpgradeRejected` | exit 12（4 distinct states） | 移除 `/\ paired` 并记录 `wsAdmittedWithoutAuth'` |
| **Mut2A** | `ComputeBridge` 对 `bad_digest` 误放行 `"bridged"` | `InvBridgedRequiresExactTriplet` | exit 12（15 distinct states） | `srv = "bad_digest"` 分支返回 `"bridged"` |
| **Mut2B** | 非 `bridged` 态虚拟路由落入 `local_handler` | `InvNonBridgedVirtualAlways503` | exit 12（17 distinct states） | 将 `else "refused_503"` 改为 `"local_handler"` |
| **Mut2C** | `AdapterYieldsToPlugin` 反向覆盖插件声明 | `InvPluginSelfDeclOverridesAdapter` | exit 12（19 distinct states） | 让适配器覆盖 `regOwner = "plugin"` |
| **Mut2D** | `StaleAdapterDispose` 摘除插件自声明 | `InvPluginSelfDeclOverridesAdapter` | exit 12（27 distinct states） | 去掉身份相等判断直接清槽 |
| **Mut3A** | `WsConnectUntrusted` 采信伪造 `X-Real-IP` | `InvTrustedProxyHeaderGate` | exit 12（2 distinct states） | 未信连接改写 `preAuthProxiedA` 与 `untrustedHeaderAdopted'` |
| **Mut3B** | `WsConnectUntrusted` 删去 `preAuthDirect >= MaxPreAuthPerIp` | `TypeOK` / `InvPreAuthLimitsBounded` | exit 12（11 distinct states） | 仅保留 `TotalPreAuth >= MaxPreAuthGlobal` |
| **Mut3C** | `AdminReqInvalidBearerWithCookie` 回退 Cookie | `InvAdminBearerNeverFallsBackToCookie` | exit 12（6 distinct states） | 置 `adminFellBackToCookie' = TRUE` |
| **Mut3D** | `SignupOtpForAdmin` 为 admin 签发会话 | `InvAdminNeverIssuedOtpSession` | exit 12（9 distinct states） | 置 `adminOtpSessionIssued' = TRUE` |

---

## 六、未建模项与假设边界（如实声明）

1. **有界模型参数**：子系统 1 将重启代次限定为 `{0, 1}`；子系统 2 仅建模单个代表性插件及离散化服务端握手结果（`serverScopeConsent` 折叠为 `consent_off` 一档）；子系统 3 以 `MaxPreAuthPerIp = 1, MaxPreAuthGlobal = 2` 建模配额竞争（以保证全图 `< 500` 状态可生成完整状态图）。
2. **定时器与退避抖动**：`T43` 指数退避计时器、`NETWORK_HINT_MIN_GAP_MS = 3000` 节流窗口与滑动窗限流时间片未展开为实时时钟。
3. **多节点并发与多端 Pool**：`RelayPool` 多服务端实例与 `ws-hub` 的 `inFlightAuthByIp` 异步窗口折叠为单实例单槽计数。
4. **`requestIsHttps` 代理头**：`auth.ts:317-330` 读取 `x-forwarded-proto` 用于决定 Cookie `Secure` 属性，与 `resolvePreAuthClientIp` / `requestClientIp` 的限流键解析正交，未并入子系统 3 限流模型。
