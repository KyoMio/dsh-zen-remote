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
| `cordis.patch.yml` | 组合层，三行 insert（界面 / 网关 / 推送），随包自带 |
| `src/index.ts` → `lib/index.js` | host 半边入口（插件行 `dsh-zen-remote`）：唯一一条路由 `POST /_dsh/mobile-nav/upload` |
| `src/client/**` → `lib/client.js` | 浏览器半边（同一插件行，经 `dsh.client` 发现）：app 外壳、slot、样式 |
| `lan-gate.mjs` | 网关 Cordis entry（插件行 `dsh-zen-remote-gateway`）：spawn 子进程 |
| `lib/lan-gate-server.cjs` | 网关本体（独立 Node 子进程，Node stdlib + `web-push`） |
| `dsh-push.mjs` | 推送 entry（插件行 `dsh-zen-remote-push`）：回合结束推送 + `push_notify` 工具 |
| `pwa/**` | manifest / service worker / 注入脚本 / 手势 / 壳级 CSS / 图标 |
| `test/*.test.cjs` | 网关侧测试（真子进程 + mock 上游） |
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

## 深度文档

| 文件 | 内容 |
| --- | --- |
| [`docs/remote-access.md`](docs/remote-access.md) | 通道半边：反代配置（nginx/Caddy/Lucky）、配对流程、环境变量表、管理 API、推送、安全边界 |
| [`docs/interface.md`](docs/interface.md) | 界面半边：断点策略、调试徽章、安全区体系、兼容插件清单 |


## 合仓后仍然成立的硬约束

- **网关是子进程**：`lan-gate.mjs` 只负责 spawn + 生命周期，永远不要把
  `lib/lan-gate-server.cjs` import 进 DSH 进程。
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
- **改了界面就去真界面上量**：`turn-fold` 这类规则用自建的静态页面验证会给出
  假阳性（合成 DOM 猜不对宿主的包裹层）。打开 `127.0.0.1:3080` 读现有会话的
  `getComputedStyle` 即可，**不要为了验证去建会话或发消息**（耗真实 token，见
  工作区 AGENTS.md 的硬约束）。注意浏览器标签在后台时 rAF 不触发，chip 会是 0
  个——那是观测假象，不是回归，截图把窗口唤到前台再看。
