# AGENTS.md — dsh-mobile-remote

单一 npm 包 `dsh-mobile-remote`，DSH（DeepSeek Harness）的 bundle 插件。
一个包里有两半代码，但**对用户是一个插件**：文档、安装说明、README 都不要
再按「两个包」叙述（2026-08-17 由 monorepo 的 `packages/gateway` +
`packages/mobile-ui` 合并而来，包名 `dsh-mobile-pwa` 与
`@dsh-external/dsh-mobile-nav` 已作废）。

## 目录

| 路径 | 作用 |
| --- | --- |
| `package.json` | 单包声明：`dsh.bundle.patch` → `cordis.patch.yml`，`dsh.client` → `exports["./client"]` |
| `cordis.patch.yml` | 组合层，三行 insert（界面 / 网关 / 推送），随包自带 |
| `src/index.ts` → `lib/index.js` | host 半边入口（插件行 `dsh-mobile-remote`）：唯一一条路由 `POST /_dsh/mobile-nav/upload` |
| `src/client/**` → `lib/client.js` | 浏览器半边（同一插件行，经 `dsh.client` 发现）：app 外壳、slot、样式 |
| `lan-gate.mjs` | 网关 Cordis entry（插件行 `dsh-mobile-remote-gateway`）：spawn 子进程 |
| `lib/lan-gate-server.cjs` | 网关本体（独立 Node 子进程，Node stdlib + `web-push`） |
| `dsh-push.mjs` | 推送 entry（插件行 `dsh-mobile-remote-push`）：回合结束推送 + `push_notify` 工具 |
| `pwa/**` | manifest / service worker / 注入脚本 / 手势 / 壳级 CSS / 图标 |
| `test/*.test.cjs` | 网关侧测试（真子进程 + mock 上游） |
| `scripts/check-*.mjs` | 界面侧自检（纯 `node:assert`，靠 Node ≥23.6 类型剥离直接 import `.ts`） |
| `scripts/build-client.mjs` | client 打包器（内联相对模块 → `__ModuleLoader__.load({id:"dsh-mobile-remote"})`） |
| `docs/**` | 深度文档，见下 |

## 命令

```sh
pnpm install
pnpm build     # tsc host + tsc client + build-client.mjs → lib/（产物入库，改 src/ 必须重跑并提交 lib/）
pnpm verify    # 两个 tsconfig 的 --noEmit 类型检查
pnpm test      # 网关 43 个 node:test 用例 + 三个界面自检脚本，一条命令全跑
```

## 深度文档

| 文件 | 内容 |
| --- | --- |
| [`docs/remote-access.md`](docs/remote-access.md) | 通道半边：反代配置（nginx/Caddy/Lucky）、配对流程、环境变量表、管理 API、推送、安全边界 |
| [`docs/interface.md`](docs/interface.md) | 界面半边：断点策略、调试徽章、安全区体系、兼容插件清单 |
| [`docs/dev-channel.md`](docs/dev-channel.md) | 通道半边的开发约定与「别踩」清单 |
| [`docs/dev-interface.md`](docs/dev-interface.md) | 界面半边的开发约定与大量实机踩坑记录 |
| [`docs/spec-public-auth-push.md`](docs/spec-public-auth-push.md) / [`docs/plan-public-auth-push.md`](docs/plan-public-auth-push.md) | 公网开放改造的设计与实施计划 |
| `docs/superpowers/**` | 界面 app 化重写各切片的设计与计划 |

## 合仓后仍然成立的硬约束

- **网关是子进程**：`lan-gate.mjs` 只负责 spawn + 生命周期，永远不要把
  `lib/lan-gate-server.cjs` import 进 DSH 进程。
- **CSS 分工没变**：排版类规则在 `src/client/styles/`；`pwa/app.css` 只留壳级
  规则（iOS 输入框防缩放、安全区滚动补偿、代码块横向滚动）。两边抢同一个元素
  是历史事故的根源，加规则前先确认归属。
- **`lib/` 是产物，不手改**：改 `src/` → `pnpm build` → 提交 `lib/`。
- **桌面必须 no-op**：≥1024px 逐像素与未安装时一致。
- 其余「别踩」条目见 `docs/dev-channel.md` 与 `docs/dev-interface.md`——它们
  是从真机事故里攒出来的，改相关代码前先读。
