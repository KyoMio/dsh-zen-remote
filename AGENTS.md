# AGENTS.md — dsh-zen-remote

单一 npm 包 `dsh-zen-remote`，DSH（DeepSeek Harness）的 bundle 插件：host 半边（网关 / 中继 / 推送 / CLI）与 client 半边（浏览器 UI）同包分发，**对用户是一个插件**——文档、安装说明、README 一律不按「两个包」叙述（2026-08-17 合仓；旧包名 `dsh-mobile-pwa`、`@dsh-external/dsh-mobile-nav` 作废）。

## 命令

```sh
pnpm install
pnpm build     # tsc host + tsc client + build-client.mjs → lib/（产物入库：改 src 必须重跑并提交 lib/）
pnpm verify    # 两个 tsconfig 的 --noEmit + scripts/check-orphan-lib.mjs 死产物门禁
pnpm test      # scripts/run-tests.mjs 全量 test/*.test.{cjs,mjs} + 文档版本一致性检查；ZR_TEST_CONCURRENCY=2 可低并发压测
node --test test/<file>                                         # 主仓单文件
pnpm --dir gateway-server verify && pnpm --dir gateway-server build && pnpm --dir gateway-server test   # 网关三件套（pretest 自动 build）
node --experimental-sqlite --test gateway-server/test/<file>    # 网关单文件
```

完成判据：改动 src 后 build 产物已随提交入库、verify 与 test 全绿；动了 `gateway-server/` 就单独跑完它的三件套。

## 按任务找入口

| 做什么 | 先读 |
| --- | --- |
| 改通道半边（反代 / 配对 / 中继协议 / 推送 / 安全边界） | `docs/remote-access.md` |
| 改界面半边（断点 / 设置区块 / 远程部件 / 调试徽章 / 安全区） | `docs/interface.md` |
| 查某个文件的职责与非显然注记 | `docs/codebase-map.md` |
| 适配第三方插件 | `docs/interface.md`「兼容插件」清单 + `src/client/styles/compat.css.ts` 现有段落 |
| 写测试或改测试夹具 | `docs/testing.md` |
| 改版本号、热更新纪元或发版 | `docs/release.md` |
| 部署网关子包 | `gateway-server/README.md` |
| 做推广物料 | 项目级 skill `dsh-promo-video`（`.agents/skills/` 与 `.claude/skills/`，本地不入库） |

## 硬约束

真机事故攒出来的，改相关代码前逐条对照。

> 架构与产物边界由 `test/architecture-guardrails.test.cjs` 与 `scripts/check-orphan-lib.mjs` 机器强制（挂入 `pnpm verify`/`pnpm test`）：lib 死产物、tsconfig 漏网、lan-gate-server 进程边界、宿主层数猜想选择器、via 拒止墙完整性、volatile config 快照、生产站点脱敏——报错即含修复方案，下列散文只留机器判不了的取舍与经验。

### 产物与构建

- **`lib/` 是产物，不手改**：改 `src/` → `pnpm build` → 提交 `lib/`。死产物门禁由 `scripts/check-orphan-lib.mjs` 强制（报错自带 `git rm` 精确命令）。
- **`gateway-server/` 不进发布包**：`package.json` 的 `files` 白名单刻意不含它，主仓 build/verify/test 也不碰它。严禁 `git add -f` 被 `.gitignore` 忽略的设计 / 原型 / 过程文档（`.impeccable/`、`prototype/`、`PRODUCT.md`、`DESIGN.md`、`docs/`）。

### 进程与安全边界

- **网关是子进程**：`lan-gate.mjs` 只负责 spawn + 生命周期；进程边界由护栏②机器钉死。
- **中继共享密钥不落地**：主入口每次 apply 现生成 `LAN_GATE_RELAY_SECRET`，只经环境变量交给网关子进程（无条件覆盖、缺失即删除），中继路由逐请求 `timingSafeEqual` 校验；不外部指定、不进日志和状态文件。
- **访问控制按方法登记，两张表同步**：新增远程方法同时登记 `src/relay-access.ts` 的 `RELAY_METHODS`（服务端）与 `src/intercept.ts` 的 `CLIENT_METHOD_FIELDS`（客户端），一致性由 `test/intercept-core.test.cjs` 逐方法钉住；插件桥另走一条（声明注册表 + 路径完全相等 + 会话共享，`src/plugin-route-intercept.ts`）。**禁止「从参数里通用扫描会话 id」**——DSH 会悄悄丢掉不认识的参数名，扫描会被诱饵字段骗过；全局读（`session/list` 等）的安全靠输出过滤，不靠输入判定。
- **适配器必须可插拔**：`src/adapters/` 整目录删掉后其余功能一字不改——框架只消费 `src/plugin-adapter-core.ts`，接线只有 `src/index.ts` 一处 import，改框架两半时不得新增对适配器目录的 import（`test/adapters-pluggable.test.cjs` 静态扫描钉住）；插件自己登记的协作声明永远优先于适配器。

### 桌面端与宿主形状

- **桌面端请求没有 `Origin`/`Sec-Fetch-Site`**：DSH 桌面端主进程校验过 `Origin: dsh-app://app` 后删掉 `host`/`origin`/`cookie`/`sec-fetch-site`。所以 `src/http.ts` 的 `sameOriginPost` 对「两个头都缺」**放行**——改成「缺 Origin 即拒」会挡掉桌面窗口的全部变更请求。真正要拒的是可辨认的跨站（`Sec-Fetch-Site: cross-site`、Origin 与 Host 不符）。
- **桌面必须 no-op**：≥1024px 逐像素与未安装时一致。
- **volatile 字段在使用时现场读取**：`Config` 每个字段都是 volatile（loader 交给 `apply()` 的是 `{ get() }` 包装），`RESTART_FIELDS` 之外的字段改了不重载行，不现场读就永久拿到旧值。读行配置走 `unwrapVolatile`（单字段）或 `resolveConfig`（整组）；顶层解构快照由护栏⑤机器拦截。
- **别用 `:has()` 写死宿主 DOM 层数**：深度猜错的选择器**静默失效**（如 `flowItem > seat > AssistantMarkdown root > body > 块` 实测多了一层就失效）——测试全绿、控制台干净，只有真界面能量出来。多层深链与嵌套 `:has()` 由护栏③机器拦截（豁免登记在 `test/css-depth-allowlist.json`）；结构判断用 JS 沿父节点上溯（`foldsWholeRows` 写法），不假设层数。

### 界面时序与缓存

- **要藏宿主刚渲染出来的东西，别用 `requestAnimationFrame`**：React 在该帧 rAF 阶段之后才提交 DOM，mutation 里排的 rAF 落在下一帧，中间帧已上屏（三次事故：2026-08-18 回复晚出、08-22 工具行先显后折、08-25 流式抖动）。选择器能表达的交给样式表（`turn-fold.css.ts` 的 `BORN_FOLDED`，读宿主自己的 `data-chat-flow-kind`/`data-variant`，第一帧即隐藏）；表达不了的放进 MutationObserver 回调同步做（微任务，先于渲染）；rAF 只留给容忍晚一帧的活（全量重扫、插 chip、改文案）。
- **首帧壳只能内联注入**：冷启动占位壳由网关 `injectBootShell` 写进第一帧 HTML（`BOOT_SHELL_*` 内联常量，不放进 `pwa/app.css` 或客户端样式），DSH 一渲染 `#root` 同步摘除，带 30s CSS 渐隐兜底；不能挪进客户端插件（那个 bundle 正是首帧要等的东西）、不能引入额外请求；显式 `desktop` 设备不注入、≥1024px 由 CSS 隐藏。`test/gateway.test.cjs` 钉住。
- **长缓存只给内容寻址 URL**：网关只给 `/assets/` 下**哈希形状**（8+ 位且含数字或大小写混合，排除 `vendor-bootstrap.css` 这类普通词）且非 HTML 的响应补 `immutable`（上游已有缓存头让上游说话）；service worker 只对同一判定与 `?rev=<hex>` 插件批次缓存优先；响应类型必须与 URL 声明一致，HTML/错误页不进资源缓存。给无哈希 URL 做长缓存就是重演 v2「新 DOM + 旧 CSS」事故。
- **CSS 分工**：排版规则在 `src/client/styles/`；`pwa/app.css` 只留壳级（iOS 防缩放、安全区滚动补偿、代码块横滚）。两边抢同一元素是历史事故根源，加规则前先确认归属。

### 联调与验证

- **同机联调必须用局域网 IP 连网关**：回环地址且无转发头被判定「本机直连」，不校验设备令牌——同机同时跑服务端与子客户端时 `serverUrl` 填局域网 IP。日常两台机器使用不受影响。
- **改了界面就去真界面上量**：合成 DOM 猜不对宿主包裹层，静态自建页面会假阳性；打开 `127.0.0.1:3080` 读现有会话的 `getComputedStyle` 即可。**不要为验证建会话或发消息**（耗真实 token）。后台标签 rAF 不触发、chip 计 0 是观测假象，不是回归。

## 深度文档

| 文件 | 内容 |
| --- | --- |
| `docs/remote-access.md` | 通道半边：反代配置、设备角色与配对、环境变量表、管理 API、中继协议、推送、安全边界 |
| `docs/interface.md` | 界面半边：断点策略、设置区块与远程部件、调试徽章、安全区体系、兼容插件清单（含更新日志） |
| `docs/codebase-map.md` | 逐文件职责与非显然注记 |
| `docs/testing.md` | 测试分层、防膨胀约定与时钟/子进程/网络测试铁律（`test/*.test.{cjs,mjs}`、`gateway-server/test/*.mjs`） |
| `docs/release.md` | 双轨版本管理、`sync-doc-version.mjs`、`CURRENT_BASE_COMPAT_EPOCH`、发版流水线与历史踩坑 |
