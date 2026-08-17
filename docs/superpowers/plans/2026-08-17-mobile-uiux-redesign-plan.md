# 移动端 app 化改造 · 实现计划

日期：2026-08-17 · 分支：`rework/mobile-uiux` · 设计定稿见
`../specs/2026-08-17-mobile-uiux-redesign-design.md` · 交互原型：
https://claude.ai/code/artifact/0f0169c4-c3f7-4dbb-8084-2b670ca95d60

分工：Fable 5 拆片/验收，实现派 Opus 5（结构片）/ Sonnet 5（样式片）。
每片独立提交、独立验收，验收配方沿用 AGENTS.md 的 Playwright/CDP 探针。

## 断点策略（定稿）

- **< 768px（手机）**：本计划的 app 化布局全量生效；
- **768–1023px（平板）**：保持 v1.0.0 现状（抽屉 + 限宽居中），不倒退；
- **≥ 1024px（桌面）**：严格 no-op。

## 总原则

1. **数据走官方服务，不抓 DOM**。`useSessions` / `useWorkspaces` /
   `useProjection` / `ctx.sessions` / `ctx.workspaces` 全部可用
   （证据见附录 A/B/D）。现有 `MobileNavOverlay.tsx` 的
   `[class*="sessionRow"]` 前缀匹配、MutationObserver 搬运、
   `effects/stats-line.ts` 正则认 DOM，随对应薄片删除。
2. **不接管 `conversation.composer.bar` 与 `conversation.session.header`**
   （私有注入拿不到，接管等于重写输入机/页签机）。composer 与头部用
   CSS 重排官方 chrome + 加法位插自己的小组件。
3. 新增 React 组件挂 **`shell.overlay`**（官方指定的整屏浮层加法位）。
4. 用户偏好持久化用 `defineStore({ persist })`（附录 G），不裸用
   localStorage。
5. 每片改动后 `pnpm build && pnpm verify`，Playwright 双宽度探针
   （390px 生效 / 1280px no-op），提交信息按上游惯例。
6. **（2026-08-17 用户硬约束）验证时禁止在 DSH 新建/fork 会话、
   禁止发送消息**（耗用户 token）。替代：接线走查、只读操作实测、
   可逆操作实测后立即还原；发送/新建的端到端行为留给用户实机验收。

## 薄片拆分

### S1 会话列表主屏 + 两级页面栈（Opus 5）★核心

- `shell.overlay` 注册全屏「主页」组件（仅 <768px 渲染）：
  - 数据：`useSessions`（`ids/byId/current/jobsBySession`，行内
    `displayTitle/running/pendingInteraction/updatedAt`）、`useWorkspaces`；
  - 顶部 workspace 标题切换器（sheet 弹单，含「全部」）；
  - 会话行：点击 `ctx.sessions.open(id)` 并切到会话层；运行中状态点；
  - FAB：点按 `ctx.workspaces.startSession(currentWs)`；长按弹
    workspace/模式选单；
  - 行长按/滑出操作后置（重命名 `binding(id).session.rename` /
    fork `ctx.sessions.fork` / 归档 `ctx.workspaces.archiveSession`
    先进 S4 信息卡，列表行操作二期）。
- 页面栈：本插件自建 `defineStore`（`view: 'home' | 'session'`，
  persist 不必要）；启动（<768px）落 home；`open(id)` 后切 session 层，
  返回键回 home。转场 CSS transform 300ms。
- 官方 sidebar 在 <768px 直接 `display:none`（不再是抽屉）；
  768–1023px 保留 v1.0.0 抽屉行为。
- 删除：`MobileNavOverlay.tsx` 中 backdrop/FAB/sessionRow 匹配、
  `MobileNavToggle`（手机断点下），保留平板路径所需部分。
- 验收：390px 启动即会话列表；点行进会话、返回回列表；新建会话落
  当前 workspace；768px/1280px 行为与 v1.0.0 一致；桌面 no-op。

### S2 会话页头部五件套（Sonnet 5）

- CSS 重排官方 `conversation.session.header`：隐藏面包屑/多余项；
  三列网格（左返回 92px / 中标题 / 右 92px），标题真居中；
- 返回按钮：`conversation.session.header.actions` 注册（order 最前），
  动作 = S1 页面栈回 home；
- 右侧 `header.utilities`：信息卡入口（S4）+ better-sidebar 入口
  （现有 Files 按钮重定位）；
- 官方 tablist（Chat/Trajectory）视觉隐藏但保留 DOM；标题下渲染
  「当前视图名 + 双点指示」（读 tablist 的 aria-selected 状态）。
- 验收：长短标题都居中；五件套齐；tablist 不可见但 DOM 在。

### S3 composer 重排（Opus 5）

- 目标布局（原型定稿）：卡外上方 dock chips 行（官方
  `conversation.input.dock` 原有内容：git chip / todo，CSS 重排为
  mini chips）；输入框 min 两行；底排
  [附件(新增,最左) · 权限胶囊 · 模型胶囊 · 弹性空隙 · 上下文环 · 发送]。
- 权限：CSS 把常驻 `PermissionSelect` 触发器整成「图标+文字」胶囊
  （结构选择器 `.modes`，不用哈希类名）；其弹出的 popupSelect 浮层
  （`conversation.input.overlay`）CSS 整成底部 sheet 样式。
  若 CSS 够不着触发器内部结构，退路：隐藏官方触发器，自建按钮
  `session.command('/permission')` 唤起官方 popupSelect。
- 模型：同思路处理 `conversation.input.model` slot 的官方触发器与
  菜单（模型 + 推理等级两组保持官方逻辑，只改壳）。
- 上下文环（ContextMeter 常驻 chrome）：CSS 移到发送键左侧
  （flex order），点击行为保持官方。
- 附件按钮：本片先放占位（图标 + toast「见 S7」），S7 接真功能。
- composer 顶部无分割线：毛玻璃 + mask 渐变（原型手法）。
- 官方统计栏 `conversation.composer.dock#stats`：CSS 隐藏（数据在
  S4 重画），删除 `effects/stats-line.ts`。
- 验收：390px 布局与原型一致、无横向溢出；权限/模型菜单可用；
  桌面 no-op。

### S4 会话信息卡（Sonnet 5）

- `header.utilities` 的 ⓘ 打开底部 sheet（挂 `shell.overlay` 或
  header 组件内 portal）：
  - Chat/Trajectory 分段控件：读官方 tablist 状态，切换=代点官方
    tab 按钮（无公开 setView，见附录 C）；
  - 统计六格：`useProjection('sessionStats')` + `('tokenUsage')`；
  - 徽标：`SessionSummary`（agentPreset/cwd）+ subagent 数
    （`subagentsByParent`）；
  - 动作：Session log 导出（复用现有 `sessionLogDownload` 服务）、
    重命名 / Fork / 归档（附录 B 的官方动作）。
- 验收：数据与官方统计栏一致（并排对照后再隐藏官方行）；四动作生效。

### S5 主页插件入口 chips + 设置页（Sonnet 5）

- chips 行：先做静态注册表（任务看板/SSH/Files/用量…按用户实装插件
  的入口路径逐个接：能复用 `sidebar.footer.action` 的 entry 则复用，
  接不到的入口本片记录并跳过）；行尾「···」开显隐自定义 sheet，
  偏好存 `defineStore({ persist: 'dsh-mobile-nav.chips' })`；
- 右上设置页 sheet：官方设置弹窗入口（`settings.trigger` 的动作）+
  原 drawer 底部杂项归位。
- 待查：list slot 能否由非 owner 渲染（附录未确认）；不能则静态表。
- 验收：chips 显隐即时生效且刷新后保持；设置弹窗可打开。

### S6 手势三件套（Sonnet 5）

- 内容区横滑切 Chat/Trajectory（代点官方 tab）；sheet 下滑关闭；
  FAB 长按（S1 已含）。不做屏幕边缘手势。
- 验收：iOS PWA 实机横滑/下滑手感；不与系统返回手势冲突。

### S7 移动端附件上传（Opus 5）

- 图片：纯 client 通路——`<input type="file" accept="image/*">` 读
  base64，`ctx.sessions.binding(id).session.prompt([{type:'image',…}],
  'queue')`（附录 F，公开契约）；
- 任意文件：新增 host 半边（`src/index.ts` 从空 apply 变实）：
  `webServer.register` 上传端点，照 vision-toolkit 模式
  （`ensurePathInside` 防穿越，落盘会话工作目录），client 上传后往
  输入框插入 `@路径` 文本；
- 网关侧：dsh-mobile-pwa 已同源透传，无需改；上传大小上限 +
  仅已配对令牌可用（网关已保证，端点再设 payload 上限）。
- 验收：iPhone PWA 实机传一张照片 + 一个文件，agent 能读到。

### S8 回合过程默认折叠（Opus 5，2026-08-17 追加）

- Chat 视图中，同一回合的过程动作（推理/思考、工具调用等
  `data-phase` 过程块）默认折叠为一条紧凑摘要行（「过程 · N 步」，
  运行中回合显示进行态），点击展开/收起该回合全部过程块；
  最终回复文本永远直接可见。仅 <768px。
- 实现探路顺序：① 先查 `conversation.chat.node` keyed slot 能否按
  节点类型接管/包裹渲染（附录 A）；能则用官方数据渲染摘要行；
  ② 不能则退 effect 方案：CSS 按 `data-phase` 语义属性隐藏过程块 +
  注入每回合一个折叠开关（禁止哈希类名，只用 data-*/role 语义
  选择器，MutationObserver 幂等）。
- 展开状态不持久化（刷新回到默认折叠）；桌面/平板不受影响。
- 验收：一个多步回合默认只见摘要行+最终回复；点开全量可见、再点
  收起；运行中回合摘要行实时更新步数；桌面 no-op。

### S2.1 热修（2026-08-17 实机反馈，最高优先级）

用户 iPhone 实机暴露三处（桌面 CDP 安全区恒为 0 测不到）：
① 头部第一行 72px 过高 + 隐藏 tablist 仍占位 27px——压回 ~48px，
tablist 改 display:none（不影响代点）；② better-sidebar 面板与
toggle 簇无安全区适配，刘海屏下按钮压在状态栏后不可点——补
env(safe-area-inset-top) 适配；③ 把安全区 env() 收敛为可注入的
CSS 变量（debug 参数可设假 inset），让桌面 CDP 能回归刘海布局。

## 顺序与依赖

S1 → S2 → S3 → **S2.1 热修** → S4 → **S6（手势，应用户实机反馈
提前）** → S8 → S5 → S7（host 半边独立，可与 S5 并行）。
每片完成即可实机体验，用户随时打断调整。
实机验收教训（2026-08-17）：桌面模拟环境 env(safe-area-inset-*) 恒为
0，凡涉及顶部/底部固定表面的片，必须用假 inset 注入回归后再请用户
实机验收。

## 附录：API 摸底结论（2026-08-17 调研 agent，证据带 path:line）

官方包位置：`~/.dsh/profiles/node_modules/@deepseek-ai/`（软链到
nvm 下的 dsh 安装，grep 需 -R 跟链）。`.d.ts` 的 JSDoc 即规范。

- **A slots**：全量清单见调研报告；本计划用到：`shell.overlay`
  （list/root，整屏加法位）、`conversation.session.header.actions`
  / `.utilities`（list）、`conversation.input.dock` /
  `conversation.composer.dock` / `conversation.input.left` /
  `.right`（list）、`conversation.input.model`（single 可抢，
  priority 低者胜）。composer 结构：PermissionSelect 与 ContextMeter
  是常驻 chrome 非 slot（dsh-client-ui-conversation lib/client.js
  3826-3870）。
- **B 数据**：`ctx.sessions`（list/open/fork/search/scope/binding，
  contract/sessions.d.ts）、`ctx.workspaces`（startSession/rename/
  archiveSession…，contract/workspaces.d.ts）；组件内标准 kit
  `useSessions/useWorkspaces/useSession/useProjection`
  （runtime client/index.d.ts:70-90）。重命名在 session face：
  `binding(id).session.rename(title)`。
- **C Chat/Trajectory**：页签 = `conversation.view` list slot 投影，
  激活态在 ui-conversation 私有 ChatStore（persist
  "dsh.conversation.chat"），**无公开 setView**——切换只能代点官方
  tablist 按钮。
- **D 统计**：官方 StatsLine 注册于 `conversation.composer.dock#stats`；
  数据全来自 `useProjection('sessionStats')` / `('tokenUsage')`，
  任意 session-scope 组件可重画。
- **E 控件**：权限写路径 = `/permission <preset>` 斜杠命令 +
  `ctx.commandUi` popupSelect decoration（ui-permission-presets
  lib/client.js:435-452）；模型菜单同理有 `/model` 通路；
  `session.command(text)` 公开（contract/session.d.ts:87）。
- **F 上传**：无公开上传 API。公开图片通路 =
  `session.prompt(PromptContentPart[], 'queue'|'steer')`
  （contract/session.d.ts:37，image 为内联 base64）。文件落盘需
  host 端点：`webServer.register(route)`（dsh-host-webserver），
  参照 vision-toolkit `/_dsh/vision-toolkit/paste-images` 实现。
- **G 持久化**：`defineStore({ init, persist })` / `createSnapshotStore`
  （runtime contract/store.d.ts）；host 级 `ctx.settingsScope` 对
  本机 UI 偏好过重不用。
- **未确认**（相关薄片先探再做）：git chip 来源包；
  ModelDirectoryResolver 是否具名服务；list slot 可否由非 owner
  渲染；第三方能否拿官方 ChatStore（倾向不能）。
