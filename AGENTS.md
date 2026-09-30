# AGENTS.md — dsh-zen-remote

单一 npm 包 `dsh-zen-remote`，DSH（DeepSeek Harness）的 bundle 插件。
一个包里有两半代码，但**对用户是一个插件**：文档、安装说明、README 都不要
再按「两个包」叙述（2026-08-17 由 monorepo 的 `packages/gateway` +
`packages/mobile-ui` 合并而来，包名 `dsh-mobile-pwa` 与
`@dsh-external/dsh-mobile-nav` 已作废）。

## 目录

| 路径 | 作用 |
| --- | --- |
| `package.json` | 单包声明：`dsh.bundle.patch` → `cordis.patch.yml`，`dsh.client` → `exports["./client"]` |
| `cordis.patch.yml` | 组合层，**一行** insert（`dsh-zen-remote`），随包自带；网关与推送由主入口按角色加载，不再各占一行 |
| `src/index.ts` → `lib/index.js` | 主入口（插件行 `dsh-zen-remote`）：读 `role`，host 就 `ctx.plugin()` 加载网关与推送子插件，并挂 host 路由（附件上传 / 客户端配置 / 分享导出 / 管理 / 子客户端 / 中继） |
| `src/config.ts` | 配置模型：四层回退（env > 插件行 > `lan-gate.config.json` > 默认值）、loader 的 `Config` schema（全 volatile）、`resolveRole` |
| `src/http.ts` | host 路由共用的 JSON 响应封装与同源 POST 门 |
| `src/admin-routes.ts` | 设置页管理后端 `/_dsh/zen-remote/admin/*`：代调网关本机 API（配对 / 设备 / 测试推送）+ 共享开关 |
| `src/client-routes.ts` | 子客户端路由 `/_dsh/zen-remote/client/*`：remote-status（两角色都挂，host 只应答这一条、其余 404）、配对代理、设置页诊断、plain-HTTP 转发 `client/http/*`（改动摘要 / diff） |
| `src/client-pairing.ts` | 子客户端配对纯逻辑：服务端地址归一化（http 仅限内网段）、claim/探针结果分类 |
| `src/share-store.ts` | 共享会话表（`~/.dsh/zen-remote-shares.json`，持久化，重启恢复），中继访问控制的事实来源 |
| `src/activity.ts` | 会话活动统计 + 闲置休眠扫描（`idleHours`，运行中/等待中不计时） |
| `src/share-ops.ts` | `agent/created` 的自动共享 / 分叉跟随 / busy 恢复 |
| `src/share-export.ts` | 分享图路由 `GET /_dsh/mobile-nav/share-export`（完整日志折叠人类转写） |
| `src/relay-server.ts` | 服务端中继路由 `/_dsh/zen-remote/relay/*`：ping / handshake / invoke / NDJSON stream / event-result / `v1/http`（改动摘要 / diff 的 plain-HTTP 直通，进程内交宿主 `/api` 共享 handler）/ unshare |
| `src/relay-access.ts` | 中继的按方法登记访问控制表（服务端那一张；`v1/http` 的按路由登记表也在这里） |
| `src/relay-filter.ts` | 全局流与全局列表的输出过滤（`workspace/follow` / `session/control` / `session/list` / @ 引用候选行） |
| `src/session-reference.ts` | 两端共用的 `dsh-session:` 引用编解码与「可注入文本」扫描规则（prompt content、排队消息 edit、`commands/execute` 全部字符串）：服务端照它校验、子客户端照它改写，同一份规则防两端漂移 |
| `src/relay-client.ts` | 子客户端中继客户端：握手、接口指纹比对、退避重连、吊销识别 |
| `src/intercept.ts` | 子客户端本机拦截：包装 `typertGateway`，远程会话调用改走中继、虚拟 id 改写、面板判定（客户端那张字段表也在这里） |
| `src/intercept-shape.ts` | 被包装方法的形态检测，不符即拒绝安装远程拦截（本地行为不受影响） |
| `src/fetch-route-intercept.ts` | 子客户端本机拦截的第二半：包装宿主连接服务 `fetchRoutes` 表的上传与导出两项——远程会话的非图片附件经 `relay/v1/upload` 流式转服务端（超限本地拒、失败回宿主自己的 200 失败信封）、虚拟 id 的导出后台 403（形态检测、懒装重试、卸载守卫） |
| `src/virtual-id.ts` | `zr~<serverId>~<id>` 虚拟 id 算术（纯函数，无状态） |
| `src/merge-streams.ts` | 三条全局流/列表的本地 + 远程合并状态机（侧边栏远程分组） |
| `src/fingerprint.ts` | DSH 接口指纹：规范化描述符 → 分组 JSON Schema 哈希，供握手比对 |
| `src/restart-fields.ts` / `restart-watcher.ts` | 需重启字段的指纹监测，变化即重载插件行 |
| `src/client/**` → `lib/client.js` | 浏览器半边（同一插件行，经 `dsh.client` 发现）：app 外壳、slot、样式、设置区块（`settings/`）、共享与远程部件（`remote-*` / `Remote*`） |
| `src/client-data/current-session.ts` + `src/client/current-session-report.ts` | 当前会话信号的浏览器上报（T62）：拦截层在后台进程读不到浏览器 localStorage，由浏览器端解析宿主选择存储、值变化时 POST 到 `client/current-session` 路由；纯函数（解析 + 变化判定）与上报循环分居两文件 |
| `lan-gate.mjs` | 网关子插件入口，由主入口按 host 角色加载（不再自己占插件行）：spawn 子进程，共享密钥只经它进子进程 |
| `lib/lan-gate-server.cjs` | 网关本体（独立 Node 子进程，Node stdlib + `web-push`）：设备角色、标记头与共享密钥、desktop-client 只放行中继前缀 |
| `dsh-push.mjs` | 推送子插件（与网关一起由主入口加载）：回合结束推送 + `push_notify` 工具 |
| `pwa/**` | manifest / service worker / 注入脚本 / 手势 / 壳级 CSS / 图标 |
| `test/*.test.cjs` | 网关侧测试（真子进程 + mock 上游）+ 中继端到端（`relay-e2e.test.cjs`）+ 纯逻辑导入测试 |
| `scripts/check-*.mjs` | 界面侧自检（纯 `node:assert`，靠 Node ≥23.6 类型剥离直接 import `.ts`） |
| `scripts/build-client.mjs` | client 打包器（内联相对模块 → `__ModuleLoader__.load({id:"dsh-zen-remote"})`） |
| `docs/**` | 深度文档，见下 |

## 命令

```sh
pnpm install
pnpm build     # tsc host + tsc client + build-client.mjs → lib/（产物入库，改 src/ 必须重跑并提交 lib/）
pnpm verify    # 两个 tsconfig 的 --noEmit 类型检查
pnpm test      # 网关 node:test 用例 + 三个界面自检脚本 + 文档版本号一致性检查，一条命令全跑
```

**版本号**：两份 README（`README.md` 英文为主文档，`README.zh-CN.md` 中文）里的
release 徽章和 profile 依赖示例由 `scripts/sync-doc-version.mjs` 按 `package.json`
改写，挂在 `version` 生命周期脚本上——`npm version patch` 会把改好的两份 README
带进同一个发版提交，不用手改
（徽章曾经一路卡在 v1.0.0 到 1.0.2）。`pnpm test` 里的 `--check` 会在漏同步时
把测试挂掉。文档里的锚点变了就更新那个脚本：找不到标记它直接非零退出，不会
默默通过。

**发版**：全部由 tag 驱动，本地只做一步。

```sh
npm version patch      # 改 package.json + 同步两份 README + 建 commit 和 v* tag
git push --follow-tags # 推 tag 才是真正的触发器
```

推上去之后 `.github/workflows/publish.yml` 依次做：装依赖 → `pnpm build` →
**`git diff --exit-code -- lib`**（入库产物必须与重新构建的结果一致，挡住
「改了 src 忘了 build 就打 tag」）→ `pnpm verify` → `pnpm test` →
tag 名与 `package.json` 版本一致性 → `pnpm publish`（npm Trusted Publishing，
OIDC 无令牌，provenance 自动生成）→ **建 GitHub Release**。

Release 那步刻意排在 npm 之后：它宣告的是「这个版本已经发出去了」，npm 失败就
不该留下一个指向不存在版本的发布页。发布说明用 `--generate-notes` 按上一个 tag
以来的提交自动生成，所以**提交信息就是 changelog**，不另外维护文件。这一步可重入
（先 `gh release view` 查在不在，在就跳过），重跑失败的 workflow 不会因为
Release 已存在而挂掉。

需要人工配置的只有一处：npmjs.com 的包设置里登记可信发布者
`KyoMio/dsh-zen-remote` + 文件名 `publish.yml`。GitHub Release 那步用的是
workflow 自带的 `GITHUB_TOKEN`，不需要额外密钥——但 job 的 `permissions` 里
`contents` 必须是 `write`（原来是 `read`）。

## 深度文档

| 文件 | 内容 |
| --- | --- |
| [`docs/remote-access.md`](docs/remote-access.md) | 通道半边：反代配置（nginx/Caddy/Lucky）、设备角色与配对、环境变量表、管理 API、远程中继协议、推送、安全边界 |
| [`docs/interface.md`](docs/interface.md) | 界面半边：断点策略、设置区块与远程部件、调试徽章、安全区体系、兼容插件清单 |


## 合仓后仍然成立的硬约束

- **网关是子进程**：`lan-gate.mjs` 只负责 spawn + 生命周期，永远不要把
  `lib/lan-gate-server.cjs` import 进 DSH 进程。
- **中继共享密钥不落地**：主入口每次 apply 现生成 `LAN_GATE_RELAY_SECRET`，
  只经环境变量交给网关子进程（无条件覆盖、缺失即删除），中继路由逐请求
  `timingSafeEqual` 校验。不允许由外部环境指定，也不要把它写进日志或状态文件。
- **中继访问控制按方法登记，两张表同步**：新增远程方法必须同时登记
  `src/relay-access.ts` 的 `RELAY_METHODS`（服务端，授权看登记的归属字段）
  和 `src/intercept.ts` 的 `CLIENT_METHOD_FIELDS`（客户端，改写判定），
  一致性由 `test/intercept.test.cjs` 的逐方法比对测试钉住。禁止「从参数里
  通用扫描会话 id」的写法——DSH 会悄悄丢掉不认识的参数名，扫描会被诱饵
  字段骗过；全局读（`session/list` 等）安全靠输出过滤，不靠输入判定。
- **桌面端请求没有 `Origin`/`Sec-Fetch-Site`**：DSH 桌面端主进程把窗口请求
  转发给本机后台前，自己校验过 `Origin: dsh-app://app`，然后删掉
  `host` / `origin` / `cookie` / `sec-fetch-site`。所以 `src/http.ts` 的
  `sameOriginPost` 对「两个头都缺」的请求是**放行**的（`admit` 顶在前面）；
  别把它改成「缺 Origin 即拒绝」，那会把桌面端窗口里的所有变更请求挡掉。
  真正要拒的是可辨认的跨站（`Sec-Fetch-Site: cross-site`、Origin 与 Host 不符）。
- **volatile 字段在使用时现场读取**：`Config` 的每个字段都是 volatile——
  loader 交给 `apply()` 的是 `{ get() }` 包装而不是值。任何读行配置的地方
  都要走 `unwrapVolatile`（单字段）或 `resolveConfig`（整组），禁止在
  apply 时拍快照存着用；`RESTART_FIELDS` 之外的字段（`serverName`、
  `idleHours`、`serverUrl`、`deviceToken`、界面旋钮）改了不重载行，
  不现场读就是永久拿到旧值。
- **CSS 分工没变**：排版类规则在 `src/client/styles/`；`pwa/app.css` 只留壳级
  规则（iOS 输入框防缩放、安全区滚动补偿、代码块横向滚动）。两边抢同一个元素
  是历史事故的根源，加规则前先确认归属。
- **`lib/` 是产物，不手改**：改 `src/` → `pnpm build` → 提交 `lib/`。
- **桌面必须 no-op**：≥1024px 逐像素与未安装时一致。
  是从真机事故里攒出来的，改相关代码前先读。
- **要藏宿主刚渲染出来的东西，别用 `requestAnimationFrame`**：React 在该帧的
  rAF 阶段之后才提交 DOM，所以从 mutation 里排的 rAF 落在**下一帧**——中间那
  一帧已经画到屏幕上，用户就看见闪。两个月内三次「晚一帧」的 bug（2026-08-18
  回复要等回合结束才出现、08-22 工具调用行先显后折、08-25 issue #3 流式抖动）
  都是这个根子。两条出路：能用选择器表达的交给样式表（`turn-fold.css.ts` 的
  `BORN_FOLDED`，读宿主自己的 `data-chat-flow-kind` / `data-variant`，React
  插入节点的同一次提交里就带着，第一帧就是隐藏的）；表达不了的放进
  MutationObserver 回调里同步做（`turn-fold.ts` 的 `markWholeRows`）——回调是
  微任务，跑在这一帧渲染更新之前，两个方向都不会晚。rAF 只留给能容忍晚一帧的
  活（全量重扫、插 chip、改文案）。
- **别用 `:has()` 写死宿主的 DOM 层数**：包裹层数不等于组件源码看上去的层数
  ——槽位会额外套一层（真实是 `flowItem > seat > AssistantMarkdown root >
  body > 块`，比组件自身结构多一层）。深度猜错的选择器**静默失效**：测试全绿、
  控制台干净，只有拿真界面量才看得出来。需要结构判断就用 JS 遍历
  （`foldsWholeRow` 那种沿父节点上溯的写法），不假设层数。
- **同机联调必须用局域网 IP 连网关**：回环地址且无转发头的请求被网关判定为「本机直连」，不校验设备令牌——同一台机器上同时跑服务端与子客户端做开发测试时，`serverUrl` 要填局域网 IP 而不是 `127.0.0.1` / `localhost`。只影响这种同机开发测试，日常两台机器（子客户端经内网/公网地址连服务端）的使用不受影响。
- **改了界面就去真界面上量**：`turn-fold` 这类规则用自建的静态页面验证会给出
  假阳性（合成 DOM 猜不对宿主的包裹层）。打开 `127.0.0.1:3080` 读现有会话的
  `getComputedStyle` 即可，**不要为了验证去建会话或发消息**（耗真实 token，见
  工作区 AGENTS.md 的硬约束）。注意浏览器标签在后台时 rAF 不触发，chip 会是 0
  个——那是观测假象，不是回归，截图把窗口唤到前台再看。
