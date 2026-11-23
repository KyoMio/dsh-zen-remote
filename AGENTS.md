# AGENTS.md — dsh-zen-remote

单一 npm 包 `dsh-zen-remote`，DSH（DeepSeek Harness）的 bundle 插件：host 半边（网关 / 中继 / 推送 / CLI）与 client 半边（浏览器 UI）同包分发，**对用户是一个插件**——文档、安装说明、README 一律不按「两个包」叙述（2026-08-17 合仓；旧包名 `dsh-mobile-pwa`、`@dsh-external/dsh-mobile-nav` 作废）。

## 命令

```sh
pnpm install
pnpm build     # tsc host + tsc client + build-client.mjs → lib/（产物入库：改 src 必须重跑并提交 lib/）
pnpm verify    # 两个 tsconfig 的 --noEmit
pnpm test      # scripts/run-tests.mjs 全量 test/*.test.{cjs,mjs} + 文档版本一致性检查；ZR_TEST_CONCURRENCY=2 可低并发压测
node --test test/<file>                                         # 主仓单文件
pnpm --dir gateway-server verify && pnpm --dir gateway-server build && pnpm --dir gateway-server test   # 网关三件套（pretest 自动 build）
node --experimental-sqlite --test gateway-server/test/<file>    # 网关单文件
```

完成判据：改动 src 后 build 产物已随提交入库、verify 与 test 全绿；动了 `gateway-server/` 就单独跑完它的三件套。

**动手前先查远端状态**：开始修改或提交前，先执行 `git fetch --all --prune` 与 `git status -sb`，核对当前分支与目标基线（如 `origin/main` / `origin/dev`）的领先/落后状态及是否已被 squash 合入，避免在旧分支上继续追加提交引发合并冲突。

## 按任务找入口

| 做什么 | 先读 |
| --- | --- |
| 改通道半边（反代 / 配对 / 中继协议 / 推送 / 安全边界） | `docs/remote-access.md` |
| 改界面半边（断点 / 设置区块 / 远程部件 / 调试徽章 / 安全区） | `docs/interface.md` |
| 查某个文件的职责与非显然注记 | `docs/codebase-map.md` |
| 适配第三方插件 | `docs/interface.md`「兼容插件」清单 + `src/client/styles/compat.css.ts` 现有段落 |
| 部署网关子包 | `gateway-server/README.md` |
| 做推广物料 | 项目级 skill `dsh-promo-video`（`.claude/skills/`，本地不入库） |

## 硬约束

真机事故攒出来的，改相关代码前逐条对照。

### 产物与构建

- **`lib/` 是产物，不手改**：改 `src/` → `pnpm build` → 提交 `lib/`。**删 src 时必须手动 `git rm` 对应 lib 产物**——tsc 只增量写、从不清理，CI 的 `git diff --exit-code -- lib` 关卡对死产物全盲（2026-10-24 PR #34 踩过）。
- **`gateway-server/` 不进发布包**：`package.json` 的 `files` 白名单刻意不含它，主仓 build/verify/test 也不碰它。严禁 `git add -f` 被 `.gitignore` 忽略的设计 / 原型 / 过程文档（`.impeccable/`、`prototype/`、`PRODUCT.md`、`DESIGN.md`、`docs/`）。

### 进程与安全边界

- **网关是子进程**：`lan-gate.mjs` 只负责 spawn + 生命周期，永远不要把 `lib/lan-gate-server.cjs` import 进 DSH 进程。
- **中继共享密钥不落地**：主入口每次 apply 现生成 `LAN_GATE_RELAY_SECRET`，只经环境变量交给网关子进程（无条件覆盖、缺失即删除），中继路由逐请求 `timingSafeEqual` 校验；不外部指定、不进日志和状态文件。
- **访问控制按方法登记，两张表同步**：新增远程方法同时登记 `src/relay-access.ts` 的 `RELAY_METHODS`（服务端）与 `src/intercept.ts` 的 `CLIENT_METHOD_FIELDS`（客户端），一致性由 `test/intercept-core.test.cjs` 逐方法钉住；插件桥另走一条（声明注册表 + 路径完全相等 + 会话共享，`src/plugin-route-intercept.ts`）。**禁止「从参数里通用扫描会话 id」**——DSH 会悄悄丢掉不认识的参数名，扫描会被诱饵字段骗过；全局读（`session/list` 等）的安全靠输出过滤，不靠输入判定。
- **适配器必须可插拔**：`src/adapters/` 整目录删掉后其余功能一字不改——框架只消费 `src/plugin-adapter-core.ts`，接线只有 `src/index.ts` 一处 import，改框架两半时不得新增对适配器目录的 import（`test/adapters-pluggable.test.cjs` 静态扫描钉住）；插件自己登记的协作声明永远优先于适配器。

### 桌面端与宿主形状

- **桌面端请求没有 `Origin`/`Sec-Fetch-Site`**：DSH 桌面端主进程校验过 `Origin: dsh-app://app` 后删掉 `host`/`origin`/`cookie`/`sec-fetch-site`。所以 `src/http.ts` 的 `sameOriginPost` 对「两个头都缺」**放行**——改成「缺 Origin 即拒」会挡掉桌面窗口的全部变更请求。真正要拒的是可辨认的跨站（`Sec-Fetch-Site: cross-site`、Origin 与 Host 不符）。
- **桌面必须 no-op**：≥1024px 逐像素与未安装时一致。
- **volatile 字段在使用时现场读取**：`Config` 每个字段都是 volatile（loader 交给 `apply()` 的是 `{ get() }` 包装）。读行配置走 `unwrapVolatile`（单字段）或 `resolveConfig`（整组），禁止 apply 时拍快照；`RESTART_FIELDS` 之外的字段改了不重载行，不现场读就永久拿到旧值。
- **别用 `:has()` 写死宿主 DOM 层数**：槽位会额外套层（真实是 `flowItem > seat > AssistantMarkdown root > body > 块`），深度猜错的选择器**静默失效**——测试全绿、控制台干净，只有真界面能量出来。结构判断用 JS 沿父节点上溯（`foldsWholeRows` 写法），不假设层数。

### 界面时序与缓存

- **要藏宿主刚渲染出来的东西，别用 `requestAnimationFrame`**：React 在该帧 rAF 阶段之后才提交 DOM，mutation 里排的 rAF 落在下一帧，中间帧已上屏（三次事故：2026-08-18 回复晚出、08-22 工具行先显后折、08-25 流式抖动）。选择器能表达的交给样式表（`turn-fold.css.ts` 的 `BORN_FOLDED`，读宿主自己的 `data-chat-flow-kind`/`data-variant`，第一帧即隐藏）；表达不了的放进 MutationObserver 回调同步做（微任务，先于渲染）；rAF 只留给容忍晚一帧的活（全量重扫、插 chip、改文案）。
- **首帧壳只能内联注入**：冷启动占位壳由网关 `injectBootShell` 写进第一帧 HTML（`BOOT_SHELL_*` 内联常量，不放进 `pwa/app.css` 或客户端样式），DSH 一渲染 `#root` 同步摘除，带 30s CSS 渐隐兜底；不能挪进客户端插件（那个 bundle 正是首帧要等的东西）、不能引入额外请求；显式 `desktop` 设备不注入、≥1024px 由 CSS 隐藏。`test/gateway.test.cjs` 钉住。
- **长缓存只给内容寻址 URL**：网关只给 `/assets/` 下**哈希形状**（8+ 位且含数字或大小写混合，排除 `vendor-bootstrap.css` 这类普通词）且非 HTML 的响应补 `immutable`（上游已有缓存头让上游说话）；service worker 只对同一判定与 `?rev=<hex>` 插件批次缓存优先；响应类型必须与 URL 声明一致，HTML/错误页不进资源缓存。给无哈希 URL 做长缓存就是重演 v2「新 DOM + 旧 CSS」事故。
- **CSS 分工**：排版规则在 `src/client/styles/`；`pwa/app.css` 只留壳级（iOS 防缩放、安全区滚动补偿、代码块横滚）。两边抢同一元素是历史事故根源，加规则前先确认归属。

### 联调与验证

- **同机联调必须用局域网 IP 连网关**：回环地址且无转发头被判定「本机直连」，不校验设备令牌——同机同时跑服务端与子客户端时 `serverUrl` 填局域网 IP。日常两台机器使用不受影响。
- **改了界面就去真界面上量**：合成 DOM 猜不对宿主包裹层，静态自建页面会假阳性；打开 `127.0.0.1:3080` 读现有会话的 `getComputedStyle` 即可。**不要为验证建会话或发消息**（耗真实 token）。后台标签 rAF 不触发、chip 计 0 是观测假象，不是回归。

## 测试规范

1. **分层与后缀**：主仓运行时 / 后端单测 → `test/<domain>.test.cjs`，驱动编译产物 `lib/*.js` 与 `lib/lan-gate-server.cjs`，禁运行时 `require('typescript')` 抠源码、禁反向引用 `gateway-server/dist/`；主仓客户端逻辑 / 样式契约 / 仓库守卫 → `test/<domain>.test.mjs`，靠 Node ≥23.6 原生类型剥离直引 `src/client/**`、`src/client-data/**` 与 `.css.ts`，禁再在 `scripts/` 新增 `check-*.mjs`；网关子包与跨端 E2E → `gateway-server/test/*.mjs`，复用 `test/helpers/fixtures.mjs` 夹具，由 `gateway-ci.yml`（含真实 PostgreSQL）独立守护，与主仓 `publish.yml`、`npm test` 零跨包依赖。
2. **防膨胀**：新功能或修 bug 优先追加进已有领域测试文件，禁按工单号（`t0xx-*`）或单条 CSS 规则拆独立小文件；单文件超 ~2,000 行且子域正交才拆，共享夹具下沉 `test/helpers/`。
3. **铁律**：轮询 / 退避 / 宽限期走 `t.mock.timers`、注入 `clock` 或 20–150ms 短超时，禁秒级真实 sleep；`Promise.race` 的定时器在 `finally` 清 `clearTimeout`；子进程、端口、监听器、全局 mock 一律挂 `t.after` 清理，只读网关测试文件级共享子进程；端口一律传 `0`，模拟连接重置用 `test/util.cjs` 的 `startResetServer()`，禁 `freePort()`/`deadPort()` TOCTOU；背压测试用可控 Mock `ServerResponse` 或注入小阈值，禁灌几十 MiB 赌内核缓冲；异步到达用有界 `waitFor` 轮询，禁给真实时钟设 `<100ms` 上界；禁锁死源码变量名、缩进、精确调用次数的正则断言；临时文件与测试 `HOME` 一律 `os.tmpdir()` + `t.after` 回收，严禁写 `.scratch/`、禁 `process.chdir()`。

## 版本管理与发版

### 版本单一事实源与兼容规则

- **双轨独立版本、禁源码硬编码**：主插件版本唯一在根 `package.json#version`，自建网关版本独立维护在 `gateway-server/package.json#version`。根 `package.json#gatewayVersion`（插件握手上报的推荐网关版本）**不手改**，由 `scripts/sync-doc-version.mjs` 在 `pnpm build` / `npm version` 时自动从 `gateway-server/package.json#version` 同步，并由 `pnpm test` 末尾的 `--check` 强校验（无 `gateway-server/` 的已发布包自动跳过）；网关侧推荐插件版本由运行时动态取 GitHub Releases 最新 `v*` 与在线节点最高 `pluginVersion` 的较大值。源码严禁写死期望网关版或插件版（仅保留历史初版兜底 `'0.1.0'`、旧版弹窗阈值 `< '0.2.0'` 与线协议兼容代次整数）。
- **何时升网关版本**：只改主插件、网关无实质改动时，**不动** `gateway-server/package.json#version`（避免插件发小补丁时误弹催更提示）；改了 `gateway-server/src` 需用户跟进升级时，**先升 `gateway-server/package.json#version`，再跑 `pnpm build` 将新 `gatewayVersion` 同步进根 `package.json`**（若 `gateway-v<ver>` tag 已存在且 `gateway-server/src` 有新提交，`sync-doc-version.mjs` 会打黄字告警防漏升）。
- **何时升热更新兼容纪元 / 线协议代次**：
  - 纯 TS / Web 控制台改动保持 `CURRENT_BASE_COMPAT_EPOCH` 不变，容器直接经 `/data/releases` 秒级热更新（`15s` 健康确认，超时自动回滚）；**只有改动原生依赖、`Dockerfile` 系统层、`gateway-server/src/bootstrap.ts` 守护契约或提高 Node 主版本下限时**，才递增 `gateway-server/src/update/update-manager.ts` 的 `CURRENT_BASE_COMPAT_EPOCH`（或调高 `gateway-server/scripts/pack-release.mjs` 的 `minNodeMajor`），让旧容器自动拒收热包并提示 `docker compose pull && docker compose up -d`。
  - **破坏性协议变更**：仅当握手或帧格式无法向后兼容时，才同步上调 `src/peer/version-sync.ts` 的 `PEER_WIRE_COMPAT_LEVEL` 与 `gateway-server/src/update/version.ts` 的 `GATEWAY_WIRE_COMPAT_LEVEL`（及允许区间），触发 `incompatible` 停连提示。

### 发版流程（双端同改时：先发网关、再发主包）

1. **网关子包发版（`gateway-v*`）**：升好 `gateway-server/package.json#version`、跑通网关三件套并提交推送后，打匹配 tag 推送：
   ```sh
   git tag gateway-v0.2.0 && git push origin gateway-v0.2.0
   ```
   `gateway-docker.yml` 会校验 tag 与 `gateway-server/package.json#version` 一致，构建多架构镜像（`:<ver>`、`:<major.minor>`、`:latest`）推 Docker Hub（配 `DOCKERHUB_USERNAME`/`TOKEN` secrets），随后调 `gateway-server/scripts/pack-release.mjs` 打包 `zen-remote-gateway-bundle.tar.gz` 上传至同名 GitHub Release（由 GitHub 自动生成官方 `sha256` 摘要供容器热更新核验）。日常改动由 `gateway-ci.yml` 独立守护，与主包流水线零跨包依赖。

2. **主插件发版（`v*`）**：全部由 tag 驱动，确认根 `package.json#gatewayVersion` 已随 `pnpm build` 同步入库后，先把 `CHANGELOG.md`「未发布」标题改成版本号 + 日期做成**独立的 `docs(changelog)` 提交**（`npm version` 要求完全干净树，「随 version commit 一起提交」的旧写法作废）：
   ```sh
   npm version patch      # 跑 sync-doc-version.mjs 同步两份 README 徽章与 gatewayVersion + 建 commit 和 v* tag
   git push --follow-tags # 推 tag 才是真正触发器
   ```

- CHANGELOG 只记用户可感知的变化，未发布段落攒待发内容；GitHub Release 正文**就是** CHANGELOG 该版本段（workflow 用同一条 awk 提取，缺段在 npm 发布前被守卫挡下），其下附与上一 tag 的 compare 链接（不用 `--generate-notes`：无法与 `--notes-file` 共存，正文来源要可预测）。
- `publish.yml` 链：装依赖 → `pnpm build` → **`git diff --exit-code -- lib`**（入库产物必须与重建一致）→ `pnpm verify` → `pnpm test` → tag 与版本一致性 → `pnpm publish`（Trusted Publishing，OIDC 无令牌）→ 建 GitHub Release（刻意排 npm 后：宣告的是「已发出去」；可重入；`fetch-depth: 0`）。
- 人工配置仅一处：npmjs 包设置登记可信发布者 `KyoMio/dsh-zen-remote` + 文件名 `publish.yml`；Release 用自带 `GITHUB_TOKEN`，job `permissions` 的 `contents` 须 `write`。
- README 版本徽章与 `gatewayVersion` 由 `scripts/sync-doc-version.mjs` 挂在 `build` 与 `version` 生命周期改写；`pnpm test` 的 `--check` 在漏同步时挂掉；锚点变了改脚本（找不到标记直接非零退出，不默默通过）。

**发版踩坑（2026-09~11 三次事故复盘）**：

- `npm version` 要求完全干净树；未跟踪的本地草稿或临时目录挡道时写进 `.git/info/exclude`（本地忽略，不动仓库；`gateway-server/` 已纳入版本库，切勿整体忽略）。
- 本地重建 `lib/` 提交前核对 `lib/types/client/nav-store.d.ts` 是否被翻转（类型引用随本地 node_modules 形态变化：软链解析为 dsh-client-ui-slots，CI 全新 install 解析为 dsh-client-store，CI-canonical 是后者）；核对产物用 git worktree 全新 frozen install，不拿主检出当基准。
- 剥离功能 / 吸收 PR 后必查 `lib/` 残留：`git diff --exit-code -- lib` 对死产物全盲，用 `git ls-files lib/` 对照 `src/`（或逐标识符 grep）找 stale 产物显式 `git rm`。
- 已推送未发布的 tag 可删远端重打（`git push origin :refs/tags/vX` 再在修复提交上重打重推；网关同理 `:refs/tags/gateway-vX`），流水线自动重跑；未曾发布的版本重指 tag 才干净。
- `pnpm publish` 成功后 registry CDN 有几分钟传播延迟：`npm view`/tarball 404 是负缓存假象，用 dist-tags 端点 + cache-bust GET 判真伪，别急着重发。
- 本地全绿 ≠ CI 绿（CI Node 24）：测试文件里 `await import()` ESM 时，所有 `require()` 放文件顶部且排在 import() 之前（Node 24 报 `ERR_REQUIRE_ESM_RACE_CONDITION`）；断言先 `waitFor` 再按 namespace/method 查。发版失败看 `gh run view --log-failed`。

## 深度文档

| 文件 | 内容 |
| --- | --- |
| `docs/remote-access.md` | 通道半边：反代配置、设备角色与配对、环境变量表、管理 API、中继协议、推送、安全边界 |
| `docs/interface.md` | 界面半边：断点策略、设置区块与远程部件、调试徽章、安全区体系、兼容插件清单（含更新日志） |
| `docs/codebase-map.md` | 逐文件职责与非显然注记 |
