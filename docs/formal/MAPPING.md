# ZR-7 形式化模型 ↔ 源码实现逐条对照（R2 修订版，Sync 基线 `f93eb25c`）

本文记录 `docs/formal/` 下 3 份 TLA+ 规约与 `dsh-zen-remote` 源码的逐动作对照、12 项非重言式反向变异（able-to-fail）结果、开源仓如实发现（Findings #1–#3），以及模型边界与未建模假设。

- **分支 / 同步基线**：`zr7-formal-models`（基于 `dev@f93eb25c`）
- **工具**：TLC `2.19`（`/opt/homebrew/bin/tlc` + OpenJDK 17）与 `$pstack-statechart`
- **R2 修订说明**：在 R1 基础上消除 `CompleteProbe` 残留的 `lastReconnectSource' = "probe_ok"` 硬编码（使单行删除 `ok /\` 即可独立触发 `InvProbeFailNeverAutoReconnects` 违规），并以 `ResolveHttpIsHttps` / `ResolveHttpClientIp` 算子将 Gap #3a/#3b 准确挂接到 cookie 签发与用户限流路径（不再触发于 Bearer 管理接口）。

---

## 一、子系统 1：`PairingWizardReconnect.tla` ↔ 实现

| TLA+ 动作 | 实现位置 | 语义对照与抽象说明 |
|---|---|---|
| `WizardOpenWithoutRestart` | `src/client/wizard/GatewayWizard.tsx:898-913` | 未改动 `RESTART_FIELDS` 时直接进入就绪态，`rowGen == configGen`。 |
| `WizardEditRestartField` | `src/restart-watcher.ts:92-140` (`startRestartWatcher`)、`src/restart-fields.ts:19-35` (`RESTART_FIELDS`)、`src/wizard/verify.ts:87-97,223-226` | 配对前或配对后改写重启字段均使 `VerificationSession` 作废（`codeMintedAtGen' = -1`）、关闭现有 WS 隧道并停止连接，等待 `fiber.restart()` 完成。 |
| `CompleteRowReload` | `src/index.ts:2318-2324` (`fiber.restart()`)、`src/client/wizard/GatewayWizard.tsx:987-1003` | 插件行重启完成且新子网关端口就绪后 `rowGen' = configGen`、`wizardPhase' = "ready"`。 |
| `MintPairingCode` | `src/wizard/verify.ts:171-215` (`createVerificationManager.start`) | 仅在 `wizardPhase = "ready"` 且 `rowGen = configGen` 时向网关 `POST /lan-gate/pair` 铸造配对码。 |
| `ClaimPairing` | `src/client-pairing.ts:181-207` (`classifyClaimResponse`)、`lib/lan-gate-server.cjs` claim 路径 | 兑换当前代次配对码使 `relayState' = "online"`；`viewState` 不原子更新，保持滞后至下一次 `StatusPollSync`。 |
| `RejectUnauthWsUpgrade` | `lib/lan-gate-server.cjs:1450-1460` (`server.on('upgrade')`) | 远端未认证请求（`!local && device === undefined`）直接返回 `HTTP/1.1 403 Forbidden` 并关闭 socket。 |
| `WsUpgradeStart` | `lib/lan-gate-server.cjs:1456-1478` | 第一阶段准入仅校验 `paired`（与子客户端 `relayState` 解耦），进入 `wsState' = "upgrading"` 与 `upstreamConnect`。 |
| `WsUpstreamReady` | `lib/lan-gate-server.cjs:1487-1499` (`live !== device \|\| live.role !== admittedRole`) | 上游连接回调阶段二次核验设备仍有效（防 `RevokeDevice` 在建连窗口并发落地造成 TOCTOU 漏杀）；通过才置 `wsState' = "open"`。 |
| `RevokeDevice` | `lib/lan-gate-server.cjs:1493-1499`、`src/relay-client.ts:913-920` | 吊销设备立即拆断已开 `open` WS socket 并重置 `paired = FALSE`；在飞 `upgrading` socket 留待 `WsUpstreamReady` 复检拒止。 |
| `TransportDrop` | `src/relay-client.ts:895-922` (`setState('offline')`) | 传输断开使 `relayState` 降为 `"offline"`，浏览器 `snapshot.view?.state` 仍暂留旧 `"online"`。 |
| `StatusPollSync` | `src/client-data/remote-status.ts:479-523` | `RemoteStatusStore` 轮询同步 `viewState` 至当前 `relayState`（可发生在在线态视图滞后或离线态视图滞后窗口）。 |
| `HintSuppressedWhileOnline` | `src/client-data/remote-status.ts:545` (`if (snapshot.view?.state === 'online') return`) | `viewState === "online"` 时健康链路门控吞掉 hint，不发 `POST /client/network-hint`。 |
| `SendNetworkHint` | `src/client-data/remote-status.ts:540-562` → `src/client-routes.ts:1272-1314` → `src/relay-client.ts:1717-1752` | 仅受 `viewState /= "online"` 门控，记录 `lastHintSawView' = viewState` 并发起正交的 `probeHealth()`（可与 `ManualRetry` / `connecting` / `online` 并发交错）。 |
| `CompleteProbe` (`ProbeSucceeds` / `ProbeFails`) | `src/client-routes.ts:1305-1312`、`src/relay-client.ts:1757-1765` (`networkRestored`) | `ok = TRUE` 时调用 `networkRestored()`（仅当 `relayState = "offline"` 才推进 `connecting`）；`ok = FALSE` 直接返回 `reachable: false`，绝不调用 `networkRestored()`。 |
| `ManualRetry` / `ConnectSucceeds` / `ConnectFails` | `src/client-routes.ts:1214-1270`、`src/relay-client.ts:1704-1709` | 手动重连可与在飞 `hintInFlight` 交错；`ConnectSucceeds` 更新 `relayState' = "online"`（`viewState` 仍由 `StatusPollSync` 异步追平）。 |

- **模型验证结果**：251 distinct states，1265 states generated，深度 15，5 条不变量 + `NoDeadlock` 全通过（0 反例，exit 0）。
- **状态图**：[pairing-wizard-reconnect.mmd](./pairing-wizard-reconnect.mmd)（13 态 / 41 边）。

---

## 二、子系统 2：`PluginBridgeRouting.tla` ↔ 实现

| TLA+ 动作 | 实现位置 | 语义对照与抽象说明 |
|---|---|---|
| `AdapterRegister` | `src/index.ts:819-825`、`src/plugin-bridge.ts:560-570` (`registerNormalized`) | 仅当 `registry.get(plugin) === undefined` 时由内置适配器注册 `(v1, d1)`。注：`src/index.ts:824` 生产接线丢弃返回值，未在运行期保留 `dispose` 句柄；`adapterHandleAlive` 同时建模 `createBridgeRegistry().registerNormalized` 的带身份保护 disposer 语义。 |
| `AdapterYieldsToPlugin` | `src/index.ts:820-823` | 若插件已先行通过 `zenRemote.bridge(...)` 登记，适配器主动让位并保留插件条目。 |
| `PluginSelfRegister` | `src/plugin-bridge.ts:548-559` (`register`) | 插件自身调用 `zenRemote.bridge(...)` 时无条件覆盖同名适配器条目并更新 `(v2, d2)` 摘要。 |
| `StaleAdapterDispose` | `src/plugin-bridge.ts:565-569` (`byPlugin.get(plugin) !== normalized`) | 当槽位不再属于适配器（`regOwner /= "adapter"`，含被插件覆盖或插件注销后），旧 disposer 引用相等守卫使其成为安全 no-op。 |
| `ActiveAdapterDispose` / `PluginDispose` | `src/plugin-bridge.ts:554-569` | 当前持有者注销时清空槽位并回到 `unregistered`。 |
| `HandshakeSync` | `src/plugin-bridge.ts:628-649` (`compareBridges`) | 按 `offline → server-too-old → not-on-server → version-mismatch → declaration-mismatch → consent-off → bridged` 裁决，仅名+精确版本+精确摘要+授权全一致才进入 `bridged`。 |
| `HandleVirtualRequest` | `src/plugin-route-intercept.ts:701-708,1078-1183` (`surrogateHandler` / `answerUnbridged`)、`src/plugin-route-intercept.ts:673-690,2650-2660` | 已注册路由遇到 `zr~` 虚拟 ID 时，若非 `bridged` 态一律返回统一 `503`（`x-zen-remote: unbridged`），绝不落入本机 `originalHandler`。 |
| `ServerRefusesBridgedCall` | `src/plugin-tunnel.ts:92-173` (`validatePluginCall`)、`src/plugin-route-intercept.ts:1271-1275` | 即使子客户端缓存为 `bridged`，服务端复核（如 `consent-off` / `plugin-mismatch`）仍以 `x-zen-remote-error` 拒回 `503`，不落本机。 |
| `HandleUnregisteredRoute` | `src/plugin-route-intercept.ts:2050-2091,2785-2802` (`wrappedMatch` / `wrappedUpgradesGet`) | **未注册边界如实声明**：当插件从未注册或已注销（`regOwner = "none"` / `bridgeState = "unregistered"`）时，拦截包装器原样返回宿主原路由，透传至 `originalHandler`（而非返回 503）。 |
| `HandleLocalRequest` | `src/plugin-route-intercept.ts:1142-1145` (`passthrough`) | 不含 `zr~` 虚拟 ID 的本机请求直接透传本机原处理器。 |

- **模型验证结果**：94 distinct states，925 states generated，深度 6，4 条不变量 + `NoDeadlock` 全通过（0 反例，exit 0）。
- **状态图**：[plugin-bridge-routing.mmd](./plugin-bridge-routing.mmd)（9 态 / 30 边）。

---

## 三、子系统 3：`GatewayRateLimitAuth.tla` ↔ 实现

| TLA+ 动作 / 算子 | 实现位置 | 语义对照与抽象说明 |
|---|---|---|
| `ResolvePreAuthIp` / `WsConnectUntrusted` / `WsConnectTrustedProxy` | `gateway-server/src/peer-hub/ws-hub.ts:319-331` (`resolvePreAuthClientIp`)、`:676-685` (`setupConnection`) | `socketIp ∉ trustedProxies` 时无视伪造 `x-real-ip`/`x-forwarded-for`，一律归入 `"direct"` 桶；仅 `socketIp ∈ trustedProxies` 时采纳合法 `x-real-ip` 分桶；超 per-IP 或全局上限均以 WS `1013` 拒连。 |
| `WsReleasePreAuth` | `gateway-server/src/peer-hub/ws-hub.ts:700-708` | 认证结束或 socket 关闭时释放预认证并发槽位。 |
| `AuthorizeHttp` / `ResolveHttpIsHttps` / `ResolveHttpClientIp` / `HttpAuthRequest` | `gateway-server/src/http/auth.ts:367-423` (`requireAdmin` / `requireUser`)、`:317-335` (`requestIsHttps`)、`:475-477` (`requestClientIp`)、`:469-472,971-991` (`handleMe` / `handleLogout`)、`gateway-server/src/server.ts:133-135` (`isBearerAdminApi`) | `requireAdmin` 优先校验 `Authorization: Bearer`，成功返 `api_admin`、失败直接 `401` 绝不回退 Cookie；非 admin 路由仅读 Cookie（Finding #1）；`ResolveHttpIsHttps` 在 `cookie_issue` 路径无条件采信 `x-forwarded-proto`（Gap #3a），`ResolveHttpClientIp` 在 `ratelimit_user` 路径始终返回 `"socket"` 忽略 `trustedProxies`（Gap #3b）。 |
| `OtpRequest` (`OtpCase`) | `gateway-server/src/http/auth.ts:914-969` (`handleSignup`)、`:997-1036` (`handleSendOtp`)、`:1042-1076` (`handleResetPassword`) | `signup` 对已存在 admin 邮箱置 `deliver = FALSE`；`reset_password` 对激活态 admin 仍置 `deliver = TRUE`（Finding #2）；但任何 admin 邮箱的 OTP 流程均绝不创建会话 Cookie（`otpMintedSession = FALSE`）。 |

- **通过配置验证结果（`GatewayRateLimitAuth.cfg`）**：420 distinct states，3183 states generated，深度 6，5 条代码真实成立不变量 + `NoDeadlock` 全通过（0 反例，exit 0）。
- **状态图**：[gateway-rate-limit-auth.mmd](./gateway-rate-limit-auth.mmd)（14 态 / 27 边，3 个正交区域）。

---

## 四、开源仓如实发现（Findings #1–#3，未弱化模型亦未改产品代码）

对 `GatewayRateLimitAuth.tla` 运行 `GatewayRateLimitAuth-finding.cfg`（TLC / `$pstack-statechart` 退出码 `1` / `12`），实证以下 3 处开源代码行为差异（完整反例见 [gateway-rate-limit-auth-finding-report.md](./gateway-rate-limit-auth-finding-report.md)）：

1. **Finding #1（`InvAllRoutesBearerOverridesCookie` 违反，1 步反例）**
   - **代码位置**：`gateway-server/src/http/auth.ts:367-374`（`requireUser`，覆盖 `routes-account.ts`、`routes-networks.ts`、`routes-topology.ts`）、`:469-472`（`currentSessionTokenHash`）、`:971-978`（`handleLogout`）、`:980-991`（`handleMe`）。
   - **现象**：仅 `requireAdmin`（`auth.ts:409-423`）校验 `Authorization: Bearer`；全部非 admin 路由只读 `zr_gw_session` Cookie。若同时携带 `Bearer` 与浏览器 `Cookie` 访问 `/api/v1/auth/me`、`/api/v1/networks` 等用户路由，请求会忽略 `Bearer` 并按 Cookie 身份执行。
2. **Finding #2（`InvAdminRefusedAllOtpDelivery` 违反，1 步反例）**
   - **代码位置**：`gateway-server/src/http/auth.ts:1027-1035`（`handleSendOtp('reset_password')`）、`:1070-1071`（`handleResetPassword`）、`:686-714`（`issueAndSendOtp`）。
   - **现象**：`signup` 因 `existing !== null` 拒绝给 admin 发码，但 `reset_password` 仅检查 `existing !== null && existing.active`，未排除 `existing.role === 'admin'`（启用 SMTP 时可触发向 admin 发码与改密，但整个 OTP 流程绝不签发会话 Cookie，`InvAdminNeverIssuedOtpSession` 成立）。另：`issueAndSendOtp` 在 `deliver = false`（已知邮箱 `signup`）分支会消耗 `otpEmailDailyRateLimiter` 配额且不调用 `releaseEmail()`（`auth.ts:687,711-714`）。
3. **Finding #3 / Gap #3（`InvHttpProxyTrustConsistent` 违反，1 步反例）**
   - **代码位置**：`gateway-server/src/http/auth.ts:317-335`（`requestIsHttps` → `issueSessionCookie`）、`routes-admin.ts:1004`（`computeSuggestedHttpsUrl`）、`routes-networks.ts:119`（`buildJoinEndpoint`）；以及 `gateway-server/src/http/auth.ts:475-477`（`requestClientIp`）。
   - **现象**：与 `ws-hub.ts:319-331` 严格核验 `trustedProxies.has(socketIp)` 不同，HTTP 侧 `requestIsHttps` 对任何直连请求无条件信任 `X-Forwarded-Proto: https`（可在明文 HTTP 下诱导写 `; Secure` Cookie 或 `?tls=1`）；而 `requestClientIp` 则完全忽略 `trustedProxies`，导致经本地反代接入的 HTTP 登录/OTP 限流（`SlidingWindowRateLimiter`）全部折叠到同一 `socket.remoteAddress` 桶。

---

## 五、反向变异验证（Able-to-Fail，12/12 非重言式捕获）

所有变异均仅以单点改动破坏对应源码守卫/裁决表达式（**零额外修改**），以 `tlc -workers 1` 实测全部 exit 12：

| 编号 | 破坏的真实守卫 / 逻辑 | 捕获不变量 | TLC 结果 |
|---|---|---|---|
| **Mut1A** | `CompleteProbe` 仅删除 `ok /\` 守卫（失败分支误走重连） | `InvProbeFailNeverAutoReconnects` | exit 12（48 distinct states） |
| **Mut1B** | `SendNetworkHint` 去掉 `/\ viewState /= "online"` 门控 | `InvHintGatedByOnlineView` | exit 12（25 distinct states） |
| **Mut1C** | `MintPairingCode` 允许在 `reloading` 态直接铸码 | `InvPairingCodeOnlyAfterReload` | exit 12（6 distinct states） |
| **Mut1D** | `WsUpstreamReady` 去掉 `/\ paired` 二次核验（TOCTOU 漏放已吊销连接） | `InvUnauthWsUpgradeRejected` | exit 12（41 distinct states） |
| **Mut2A** | `ComputeBridge` 对 `bad_digest` 误放行 `"bridged"` | `InvBridgedRequiresExactTriplet` | exit 12（16 distinct states） |
| **Mut2B** | `HandleVirtualRequest` 非 `bridged` 态回落 `local_handler` | `InvNonBridgedVirtualAlways503` | exit 12（18 distinct states） |
| **Mut2C** | `AdapterYieldsToPlugin` 反向覆盖插件自声明 | `InvPluginSelfDeclOverridesAdapter` | exit 12（20 distinct states） |
| **Mut2D** | `StaleAdapterDispose` 去掉引用相等守卫并清空槽位 | `InvPluginSelfDeclOverridesAdapter` | exit 12（34 distinct states） |
| **Mut3A** | `ResolvePreAuthIp` 去掉 `fromTrusted` 检查直接采信伪造头 | `InvTrustedProxyHeaderGate` | exit 12（2 distinct states） |
| **Mut3B** | `WsConnect` 去掉 `bucketCount >= MaxPreAuthPerIp` 检查 | `TypeOK` / `InvPreAuthLimitsBounded` | exit 12（12 distinct states） |
| **Mut3C** | `AuthorizeHttp` 在 `bad_key` 时回退 `hasCookie` | `InvAdminBearerNeverFallsBackToCookie` | exit 12（6 distinct states） |
| **Mut3D** | `OtpCase` 允许 `reset_password` 也签发会话 | `InvAdminNeverIssuedOtpSession` | exit 12（9 distinct states） |

---

## 六、未建模项与假设边界（如实声明）

1. **有界模型参数**：子系统 1 重启代次限定为 `{0, 1}`；子系统 2 仅建模单个代表性插件及离散化服务端握手结果；子系统 3 取 `MaxPreAuthPerIp = 1, MaxPreAuthGlobal = 2`（控制全图 `< 500` 态以渲染完整状态图）。
2. **定时器与退避抖动**：`T43` 指数退避、`NETWORK_HINT_MIN_GAP_MS = 3000` 与 `SlidingWindowRateLimiter` 时间窗未展开为连续时钟。
3. **多节点并发与 `PeerRateLimiter`**：`RelayPool` 多服务端实例折叠为单实例；`gateway-server/src/peer-hub/rate-limiter.ts` 为已建立会话后的 DATA/控制帧令牌桶与 5s 遥测滑窗限速器，正交于建连前预认证与 HTTP 鉴权状态机，未纳入本模型。
