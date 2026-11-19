# codebase-map — 逐文件职责与非显然注记

配合根目录 `AGENTS.md` 使用：那边是命令、硬约束与流程；这边是「改某个文件前需要知道的注记」。
标注与 `AGENTS.md` 硬约束重复的两条（adapters 可插拔、gateway-server 不进发布包）以 AGENTS.md 为准。

| 路径 | 作用与非显然注记 |
| --- | --- |
| `package.json` | 单包声明：`dsh.bundle.patch` → `cordis.patch.yml`，`dsh.client` → `exports["./client"]` |
| `cordis.patch.yml` | 组合层，**一行** insert（`dsh-zen-remote`）；网关与推送由主入口按角色加载，不各占一行 |
| `src/index.ts` → `lib/index.js` | 主入口（插件行 `dsh-zen-remote`）：读 `role`，host 就 `ctx.plugin()` 加载网关与推送子插件，并挂 host 路由（附件上传 / 客户端配置 / 分享导出 / 管理 / 子客户端 / 中继）；也是 `src/adapters/` 的唯一接线点 |
| `src/config.ts` | 配置模型：四层回退（env > 插件行 > `lan-gate.config.json` > 默认值）、loader 的 `Config` schema（全 volatile）、`resolveRole`（`host` / `client` / `peer`，非精确串降级 host）、`servesRole`（host+peer）/ `connectsRole`（client+peer）两个角色闸 |
| `src/http.ts` | host 路由共用 JSON 响应封装与同源 POST 门（桌面端无 Origin 头的放行语义见 AGENTS.md 硬约束） |
| `src/admin-routes.ts` | 设置页管理后端 `/_dsh/zen-remote/admin/*`：代调网关本机 API（配对 / 设备 / 测试推送）+ 共享开关；`GET /admin/shares` 走单次冷安全 `session/list`（`{ _request: {} }`）摘要优先（保留显式 `null`）与处理器实例级两级单飞 + 上限 3 FIFO 回退池，`POST` 变更即时失效在飞列表 |
| `src/client-routes.ts` | 子客户端路由 `/_dsh/zen-remote/client/*`：remote-status（三角色都挂，host 只应答这一条、其余 404）、配对代理、设置页诊断、plain-HTTP 转发 `client/http/*`（改动摘要 / diff）、`debug-report`（脱敏诊断报告，via 墙先于分派，CU-3） |
| `src/client-pairing.ts` | 子客户端配对纯逻辑：服务端地址归一化（http 仅限内网段）、claim/探针结果分类 |
| `src/state-store.ts` | 主进程三合一状态存储（MS-1）：`~/.dsh/zen-remote-state.json`（0600、tmp+rename 原子写）承载 `serverId`、共享表、已配对服务端（上限 `maxServers` 默认 8）与一次性迁移；PG-2 起另承载 peer 三块：`peerIdentity`（自证明 Ed25519，读时校验 nodeId=hash(key)，坏块丢弃重建）、`peerNetwork`、`pinnedPeers`（TOFU 锚定，`verifyOrPinPeerKey` 绝不自动覆盖、`repinPeerKey` 仅显式调用换锚） |
| `src/share-store.ts` | 共享会话表（读写 state 文件 `sessions` 段，重启恢复），中继访问控制的事实来源 |
| `src/activity.ts` | 会话活动统计 + 闲置休眠扫描（`idleHours`，运行中/等待中不计时） |
| `src/share-ops.ts` | `agent/created` 的自动共享 / 分叉跟随 / busy 恢复 |
| `src/share-export.ts` | 分享图路由 `GET /_dsh/mobile-nav/share-export`（完整日志折叠人类转写） |
| `src/relay-server.ts` | 服务端中继路由 `/_dsh/zen-remote/relay/*`：ping / handshake / invoke / NDJSON stream（含 `knownCursor` 增量 `snapshot-sync` 与 `writeChain` 串行 gzip 封装）/ `v1/session-snapshot`（冷安全单帧快照与增量，每设备上限 2 / 跨设备全局上限 3）/ event-result / `v1/http`（plain-HTTP 直通，进程内交宿主 `/api` 共享 handler）/ `v1/upload`（附件字节转宿主暂存）/ unshare |
| `src/relay-access.ts` | 中继按方法登记访问控制表（服务端那张）；`v1/http` 按路由登记表也在这里 |
| `src/upload-limits.ts` | 单一载荷上限真相源：`MAX_UPLOAD_BYTES`（500 MiB）、`DEFAULT_MAX_UPLOAD_BYTES`（20 MiB，手机端附件默认上限）、`MAX_INVOKE_BODY_BYTES`（72 MiB，容纳 50 MiB base64 内联图片）、`MAX_FILE_MEDIA_BYTES`（20 MiB，单次转发媒体上限） |
| `src/relay-filter.ts` | 全局流与列表的输出过滤（`workspace/follow` / `session/control` / `session/list` / @ 引用候选行） |
| `src/session-reference.ts` | 两端共用 `dsh-session:` 引用编解码与「可注入文本」扫描规则（prompt content、排队 edit、`commands/execute` 字符串）：服务端照它校验、子客户端照它改写，同一份规则防漂移 |
| `src/session-history-cache.ts` | 纯内存远程会话历史缓存（不落盘）：四级预算（全进程 `64 MiB` / 单设备 `24 MiB` & `32` 会话 / 单快照 `8 MiB` / `session/page` `16 MiB` & `128` 页）、双层 LRU（`prewarmed` 先于 `visited` 淘汰）、`600` 条整轮裁头、`peekSnapshotMeta` 只读轻量元信息查询、`30 min` 离线回收与 `2,000 ms` 一次性交接槽 |
| `src/session-prewarm.ts` | 冷安全后台自动预热调度器：按 `updatedAt` 降序、每在线设备 `concurrency = 1` 预热 Top `16` 根会话（跳过 `subagent`），前沿请求即刻 `abort()`、空闲 `300 ms` 后恢复，联动 `workspace/follow` 移出、`session/control` 水印、`api-session/status` 及 `404`/`403` 降级 |
| `src/relay-client.ts` | 子客户端中继客户端：握手、接口指纹比对、退避重连、吊销识别、`O(N)` `Uint8Array` 流式行切分（`64 MiB` 上限）、协商式 `gzip` 解压与 `64 MiB` 防炸弹、`/v1/session-snapshot` 与 `knownCursor` 流参数 |
| `src/relay-pool.ts` | 多服务端连接池（最多 8 台）：同 `serverId` 去重（保留最新配对）、重名显示名派生 `-1`/`-2`（`deriveDisplayServerNames`）、按 entryId/serverId 定位、单台/全部重连与改名广播 |
| `src/peer/` | 节点端双路径组网引擎：`wire.ts` 线协议（28B 明文路由头 + ≤1200B 密文帧）、`crypto.ts` 自证明身份（`nodeId = sha256(pub)[0..8]`）、`zr-net://` 邀请链接与会话级 X25519+AES-256-GCM AEAD（兼容 OpenSSL 与 BoringSSL）、`arq.ts` 滑动窗口可靠流、`punch.ts` 双 UDP STUN 打洞（60s 静默重探、`lan`/`p2p` 分类）、`mux.ts` 虚拟 HTTP 复用、`engine.ts` 网关信令（`/peer/v1/ws` 挑战应答）与独立 TOFU 锚定 |
| `src/intercept.ts` | 子客户端本机拦截：包装 `typertGateway`、远程调用走中继、虚拟 id 改写、面板判定（客户端字段表在这里），以及 `session/follow` SWR 0ms 秒开三路追平、`session/page` 缓存、前台忙碌追踪与自动预热调度接线 |
| `src/intercept-shape.ts` | 被包装方法形态检测，不符即拒绝安装远程拦截（本地行为不受影响） |
| `src/plugin-bridge.ts` | 插件桥纯逻辑（PB-1）：桥接声明校验/规范化与 16 位摘要、`zenRemote` 注册表、两端 `compareBridges`；不 import DSH、不碰 I/O |
| `src/plugin-loopback.ts` | 插件桥回环执行器（PB-3）：本机回环 GET 插件路由，token 换 cookie（401 重换一次），cookie 只存内存；https 仅对字面 127.0.0.1 放宽证书校验 |
| `src/plugin-route-intercept.ts` | 子客户端改道（PB-4）：包装宿主 webServer 的 `match`，声明命中的虚拟 id 走 `relay.pluginRequest`；未桥接统一 503（`x-zen-remote: unbridged`），绝不落本机插件 |
| `src/plugin-adapter-core.ts` | 适配器框架核心（PB-11）：路由/定位器校验、三种定位（query/路径段/JSON 体）的「远程/本地/混合」判定与双向改写、摘要与让位判定；纯逻辑，框架两半只 import 这里 |
| `src/adapters/` | 适配器目录（`index.ts` 只导出 `ADAPTERS`，`types.ts` 放作者接口）——可插拔铁律见 AGENTS.md 硬约束 |
| `src/client-data/plugin-bridge.ts` | 设置页纯函数（PB-5）：桥接状态 → 文案键、整机数据同意表切换；浏览器半边，不 import 主包 |
| `src/fetch-route-intercept.ts` | 拦截第二半：包装宿主 `fetchRoutes` 的上传与导出——非图片附件经 `relay/v1/upload` 流式转服务端（超限本地拒、失败回宿主 200 失败信封）、虚拟 id 导出后台 403（形态检测、懒装重试、卸载守卫） |
| `src/virtual-id.ts` | `zr~<serverId>~<id>` 虚拟 id 算术（纯函数零依赖；client-data 半边许可 import，先例 remote-drop / remote-status） |
| `src/log-ring.ts` | 诊断导出内存日志环（CU-1）：上限 300 条不落盘；两分支 logWarn/logInfo 收口双写（logger + 环），生命周期事件 push 进环 |
| `src/debug-report.ts` + `src/debug-redact.ts` | 诊断报告装配与脱敏（CU-2，纯逻辑零 DSH import）：五板块、配置按字段名挑选（秘密构造性缺席）；脱敏 URL 走哨兵摘出-还原（userinfo→`<token>@`、host→地址类型、端口 path 保留、query 长值 token 化）、家目录折叠先于 token 趟；`test/debug-report.test.mjs` 真值表钉住 |
| `src/merge-streams.ts` | 三条全局流/列表的本地 + 远程合并状态机（侧边栏远程分组） |
| `src/fingerprint.ts` | DSH 接口指纹：规范化描述符 → 分组 JSON Schema 哈希，供握手比对 |
| `src/restart-fields.ts` / `restart-watcher.ts` | 需重启字段的指纹监测，变化即重载插件行 |
| `src/client/**` → `lib/client.js` | 浏览器半边（经 `dsh.client` 发现）：app 外壳、slot、样式、设置区块（`settings/`）、远程部件（`remote-*` / `Remote*`）、`effects/legacy-gateway-prompt.ts`（桌面门前挂载的旧版 `0.1.0` 网关一次性引导弹窗） |
| `src/peer/version-sync.ts` → `lib/peer/version-sync.js` | 零依赖纯逻辑双向版本同步判定（semver 比较、旧 `0.1.0` 网关推断、脱敏 `sanitizeConsoleOrigin`、`versionDismissKey`），供 `PeerEngine` 与 `/client/peer/status` 共享 |
| `src/client-data/current-session.ts` + `src/client/current-session-report.ts` | 当前会话信号浏览器上报（T62）：拦截层读不到浏览器 localStorage，由浏览器端解析宿主选择存储、变化时 POST `client/current-session`；纯函数（解析 + 变化判定）与上报循环分居 |
| `src/client-data/remote-group-expansion.ts` + `src/client/remote-group-expansion.ts` | 服务端分组展开记忆与恢复（T64）：宿主 retainAccountKeys 每次加载清掉 zr~ 分组记录，浏览器端镜像进自己存储、按记录（默认展开）点击行恢复；纯函数与 keeper 循环分居 |
| `lan-gate.mjs` | 网关子插件入口（host 角色加载）：只 spawn + 生命周期，共享密钥与 `LAN_GATE_TARGET_PROTOCOL` 经它进子进程，并消费监听端口回调 |
| `lib/lan-gate-server.cjs` | 网关本体（独立 Node 子进程，stdlib + `web-push`）：设备角色、标记头与共享密钥、desktop-client 只放行中继前缀、`0o600` 原子写盘与 `.corrupt.*` 备份、900s 上传超时放宽、`https:` 上游与 `<DSH_HOME>/lan-gate-runtime.json` 实际端口探测 |
| `dsh-push.mjs` | 推送子插件（与网关一起加载）：回合结束推送 + `push_notify` 工具；动态从 `lan-gate-runtime.json` 读实际端口并校验 `pid` 存活；`onTurnEnd` 前置短路资格/去抖，`resolveSessionName` 优先经 `ctx.reflect.get('sessionProjections')` 直读并支持 `''` 负缓存（仅非空 `session/title` 覆写），开摘要时与 `turnSummary` 复用单次 `evs` |
| `bin/zen-remote.mjs` + `src/cli/**` → `lib/cli/` | CLI `dsh-zen-remote`：插件进程内 0600 IPC socket 服务端与客户端、防遮蔽配置写入（`config-writer.ts`）、双语 i18n（`args.ts` / `i18n.ts`）、`status`/`host *`/`client *`/`peer *` 子命令、`setup` 三步向导与角色切换联动（`command-setup.ts`）、多 profile 安装与 DSH 自动拉起（`bootstrap.ts`）；全部经 IPC 驱动插件进程，CLI 绝不 spawn caddy / cloudflared |
| `gateway-server/` | 独立中继网关与 Web 控制台子包——不进发布包、独立三件套与流水线，细则见 AGENTS.md 硬约束与 `gateway-server/README.md`：虚拟网络管理、五态成员准入（`pending`/`authorized`/`paused`/`mismatch`/`revoked`）、双端口 UDP STUN 协调、零知识 E2EE 中转（网关无私钥只路由密文帧）、PID-1 热更新守护（`src/bootstrap.ts`）与版本检查/校验解包/空闲调度模块（`src/update/{archive,version,update-manager}.ts`）、Docker 交付 |
| `pwa/**` | manifest / service worker / 注入脚本 / 手势 / 壳级 CSS / 图标（CSS 分工铁律见 AGENTS.md） |
| `test/*.test.cjs` + `test/*.test.mjs` + `test/helpers/*.cjs` | 主仓统一 `node:test` 测试集（分层归属与铁律见 AGENTS.md 测试规范） |
| `scripts/run-tests.mjs` | 自适应并发测试运行器：按 `ZR_TEST_CONCURRENCY`（默认 `min(availableParallelism(), 6)`）驱动 `node --test` |
| `scripts/verify-better-sidebar-tarballs.mjs` | 离线维护者脚本：校验 `/tmp/bs-versions/` 历史 tarball 与 better-sidebar 适配器表（不进默认 `npm test`） |
| `scripts/verify-fingerprint-live.mjs` | 活体指纹校验：对真实闭包按插件 registry 层同一路径算分组哈希，DSSH 版本适配 PR 用它现场复算 |
| `scripts/build-client.mjs` | client 打包器（内联相对模块 → `__ModuleLoader__.load({id:"dsh-zen-remote"})`） |
| `docs/**` | 深度文档，见 AGENTS.md「深度文档」表 |
