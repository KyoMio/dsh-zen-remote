# dsh-mobile-nav

## Project

- 纯客户端 DSH（DeepSeek Harness）Web UI 插件；npm 包名 `@dsh-external/dsh-mobile-nav`，Git 仓库/README 名 `dsh-web-mobile`，patch 行 id `dsh-mobile-nav`。
- 作用：窄屏（<1024px）把官方 Web UI 的侧栏 rail 改为 overlay 抽屉、会话区全宽，并适配状态栏/安全区/`theme-color`、设置弹窗、文件树/预览底部浮层、统计栏等；桌面端（≥1024px）刻意无操作，与未安装插件一致。
- 单包仓库（非 monorepo），没有 workspace 配置；`packageManager` 为 `pnpm@11.7.0`。
- 入口/边界：host 半区 `src/index.ts` 只导出空 `apply()` 占位；浏览器半区 `src/client/index.tsx` 是真正入口，通过 `package.json` 的 `exports["./client"]` 和 `dsh.client.platform: "web"` 被发现。
- 发布包 `files` 包含 `lib`、`src`、`assets`、`cordis.patch.yml`、`README.md`、`LICENSE`；`lib/` 已提交，GitHub 分发无需构建脚本。

## Commands

- 安装依赖：`pnpm install`
- 构建：`pnpm build`
  - 等价于：`tsc -p tsconfig.json && tsc -p tsconfig.client.json && node scripts/build-client.mjs`
  - 修改 `src/` 后必须重跑，并提交更新后的 `lib/`。
- 类型检查：`pnpm verify`
  - 等价于：`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit`
- 打包/发布前：`npm run prepack`（内部执行 `npm run build`）；`npm pack` 会触发它。
- **没有 test/lint/CI 脚本**；用 `pnpm verify`、`git diff --check` 和手动浏览器检查。
- 本地开发安装：`dsh plugin --profile web add link:/path/to/dsh-mobile-nav`，然后重启 `dsh web`。
- 配置 sanity check：`dsh --profile web --dump-config` 应能看到 `dsh-mobile-nav` 插件行。
- 用户安装（README）：`dsh plugin --profile web add github:mexiaosqwq/dsh-web-mobile`。

## Architecture

- 双半区插件：
  - host：`src/index.ts` 空 `apply()`，仅让插件出现在 host Loader。
  - client：`src/client/index.tsx` 注册 locale、注入样式、安装 viewport/状态栏/兼容性 effect，并注册所有 slot。
- 客户端 fiber `inject = ['slots', 'layout', 'locale', 'sessionLogDownload']`。
- **断点分层（2026-08-17 S1 起）**：<768px 走 app 化两级页面栈（会话列表主页 + 会话页），官方 sidebar `display:none`；768–1023px 保持 v1.0.0 抽屉；≥1024px 严格 no-op。`MobileNavOverlay` 里抽屉相关的四段逻辑（backdrop / 浮动开关 / Escape / 点击关闭）只在 768–1023 生效，frame 标记与 aionui/settings/git-chip 三个 DOM effect 仍是 ≤1023。
- slot 注册：
  - `conversation.session.header.actions` → `MobileNavToggle`（目录开关 + 文件树按钮；<768px 目录开关被 CSS 隐藏）
  - `shell.overlay` → `MobileNavOverlay`（遮罩 / 浮动按钮 / Escape 与点击关闭，仅平板）
  - `shell.overlay` → `MobileHome`（<768px 全屏会话列表主页，order 20）
  - `sidebar.footer.action` → `MobileDrawerFooter`（文件 + 会话日志下载）
- 核心文件：
  - `src/client/MobileNavOverlay.tsx`：维护 `data-mobile-nav="frame"`，导航关闭启发式。
  - `src/client/MobileNavToggle.tsx`：会话头部控件。
  - `src/client/MobileDrawerFooter.tsx`：抽屉底部操作。
  - `src/client/styles/`：全部移动端样式，拆为 `base/layout/compat/misc.css.ts` + `index.ts`（导出 `MOBILE_CSS` = 四者按序 `join('\n')`，注入为单一 `<style data-plugin>`）。拆分是纯搬移：组件文件**不要手改 CSS 内容**，用切片脚本按原字节序切（见下 Pitfall「styles/ 按节切片」）。
  - `src/client/MobileHome.tsx`：手机主页（workspace 切换器 / 会话列表 / FAB / 底部 sheet），数据全走标准 kit `useSessions` / `useWorkspaces`，动作走注入的 `ctx.sessions.open` / `ctx.workspaces.startSession`，不读官方 DOM。
  - `src/client/nav-store.ts`：`createNavStore()` — 页面栈 `defineStore`（`view: 'home' | 'session'` + workspace 过滤），**不 persist**（启动必须落主页）；handle 在 `apply()` 里建，后续薄片注册同一 handle 即共享实例。
  - `src/client/styles/home.css.ts`：手机 app 壳样式，整块在 `@media (max-width: 767px)` 内，且**必须排在 index.ts 拼接的最后**（要压过 ≤1023px 那一大块的同权重规则）。
  - `src/client/effects/`：客户端 effect，按域拆 3 文件（phone-chrome / aionui-compat / stats-line）；`index.tsx` 只做编排（locale、样式注入、install 调用、slot 注册）。
  - `src/client/locales.ts`：`mobileNav` i18n；`zh` 是 key 源真相，`en` 是类型镜像。
  - `scripts/build-client.mjs`：自定义打包器。
- 构建流程：client tsc 输出到 `.client-build/`，`build-client.mjs` 把相对模块内联成 `window.__ModuleLoader__.load({...})` 并写入 `lib/client.js`，平台模块保留 `require()`；随后删除 `.client-build/` 和 `lib/client.js.map`。**bundle 支持递归内联 `styles/` 子目录模块**（`require` 按宿主模块目录解析到规范相对路径，再改写进扁平 `__modules` map；运行时 `__localRequire` 不变）。
- 布局驱动：`data-mobile-nav="frame"` + `data-sidebar-collapsed`；移动端 CSS 在 `(max-width: 1023px)` 生效，桌面端 `(min-width: 1024px)` 隐藏所有 mobile 控件。
- 第三方兼容（dsh-web-ui-all、dshmarket、dsh-usage-stats）通过 DOM 标记 `data-aionui-*`、`MutationObserver`、后缀类选择器/文本锚点实现，不改第三方源码。

## Conventions

- 优先使用稳定 `data-*` 属性（`data-phase`、`data-sidebar-collapsed`、`data-shell-overlay`、`data-aionui-*`）和结构化选择器；避免 hashed class。无法避免时用后缀选择器（如 `[class$="_root"]`）或文本/结构锚点。
- 所有 style 标签、监听器、MutationObserver 等长生命周期资源都要在 `ctx.effect(() => { ...; return disposer }, label)` 中创建并清理。
- i18n：新增 key 先加 `zh`，再在 `en` 加同 key 镜像；`MobileNavKey` 从 `zh` 推导。
- 客户端导入纯净性：跨 DSH 包的 SlotMap/Context 类型增强只用 type-only import；运行时只导入平台模块（React、primitives、slots 等）。
- 不要手改 `lib/`；构建产物入库，修改 `src/` 后 `pnpm build` 并提交 `lib/`。
- 提交信息用 conventional 前缀：`feat(mobile):`、`fix(mobile):`、`refactor(mobile):`、`docs:`、`chore:`。
- 桌面端必须保持 no-op：新增样式/逻辑要确保 ≥1024px 不改变 UI。

## Pitfalls

- 命名不一致：README/Git 仓库叫 `dsh-web-mobile`，npm 包名是 `@dsh-external/dsh-mobile-nav`，patch 行 id 是 `dsh-mobile-nav`；改文档/manifest 时注意区分。
- 不要手改 `lib/client.js`：由 `pnpm build` 生成，改动应落在 `src/client/`。
- `.client-build/` 是临时目录，构建脚本会删除；不要当作稳定产物。
- 抽屉打开态必须用 `transform: none`，不要用 `translateX(0)`：identity transform 会成为 fixed 定位后代的包含块，导致 settings 等浮层错位。
- composer 模型 pill（issue #9，2026-08-16 修）：`_triggerLabel` 必须保持 `flex: 1 1 auto` + `min-width: 0`（在 `> [class$="_trigger"]` 规则之后），否则 pill 拉伸时多余宽度闲置在 chevron 之后、label 拿不到。省略点是自适应的：行内有空间就显示完整模型 ID，空间不足才在极限处省略。默认模型名（~182px @13px）完整显示需视口 ≥~415px；390px 手机必然省略（物理放不下），用户报「宽度足够」时先确认实际模型 ID 长度。行间距用 8px（12px 会把 label 挤出 ~14px）。
- 抽屉点击关闭规则：忽略会话行内按钮（kebab 等）和 `[aria-modal="true"]` 模态；Escape 处理让位于模态。
- CSS 依赖 `:has()`（Chromium 105+），并遵循 `prefers-reduced-motion`。
- 为第三方插件做兼容时按 README 列出的精确版本验证（`dsh-web-ui-all` 0.1.14、`dshmarket` 1.2.2、`dsh-usage-stats` 0.1.2、`@omdsh-dev/dsh-genui` 0.8.3）；选择器保持作用域，避免影响桌面端。
- 抽屉底部顺序由 `sidebar.footer.action` list 槽的 `(priority, order)` 升序决定：`dsh-remote-web-ui` 不设 order（默认 0，听筒+下载图标行在最上）、`dsh-usage-stats` 用 10（用量/余额徽章）。mobile-nav 该注册必须用 `order: 5`：若同为 10 会平票按注册顺序，徽章会插到「文件浏览/导出会话日志」之上（2026-08-16 修过）。
- 抽屉 footer 按钮渲染成 ~3 倍高（约 100px）或行距出现 40~128px 不规则间隙时，先怀疑手机浏览器加载了旧 bundle / 残留 style 标签（当前 CSS 是 34px 按钮 + 6~8px 间距）；对比 `curl -s http://127.0.0.1:3080/ | grep -o 'dsh-mobile-nav/client.js?rev=…'` 的 rev 与服务端文件，强刷/重开页面验证后再改代码。
- **bundle 永远是最新的**：`/plugins/<id>/client.js` 响应带 `cache-control: no-cache` 且无 validators，服务端对任意 rev 查询都读当前 lib 文件 → 手机上的「旧行为」只可能来自激进缓存/长活 tab（整页 HTML/JS 被浏览器缓存），服务端无法下发旧 bundle。排查手机端时先让用户强刷 + 清站点数据，而不是改代码。**rev 核对方法（2026-08-16 验证）**：`sha1sum lib/client.js` 的前 12 位 = 页面 `client.js?rev=` 的值（rev 就是 lib 文件内容 SHA-1 前缀）。
- aionui 标记 effect 必须按当前宽度挂载并在宽度变化时重挂（matchMedia change）：只在 apply 时查一次 `narrow.matches` 会让「先宽后窄」（桌面缩放、平板分屏）后文件树点文件永远打不开预览、折叠按钮失效（2026-08-16 修，explorer 关闭 / preview 开关 / 统计行 / 动画重放 4 个 effect 同一模式）。
- 文件树**目录行不得设置 `data-aionui-preview-open`**：只允许无 `[class$="_treeArrow"]` 的文件行触发，否则点目录展开会弹出 localStorage 恢复的旧预览 tab（用户视角 = 「随便点一下全屏弹出一个 md 内容」，2026-08-16 修）。
- 预览浮层打开时文件树浮层必须让位（CSS：`[data-mobile-nav="frame"][data-aionui-preview-open] [data-aionui-explorer-col] { visibility: hidden !important }`，与 explorer-open 规则同 specificity，必须排在它之后）；关掉预览后文件树自动回来。
- 全屏预览（issue #8，2026-08-16 实现）：frame 标记 `data-mobile-preview-full` 由 `[data-mobile-nav="preview-full-toggle"]` 按钮切换。**按钮必须 append 进 preview 列内部**（`position:absolute; top:8px; right:36px`，与 suite 折叠按钮同规格 20px/radius4）——这样它随浮层的打开动画和几何过渡**构造性锁定**（子元素随父元素动），且可见性继承浮层（关闭/抽屉打开自动隐藏，无需独立规则）。suite 的 React 重渲染会清掉注入节点，要用 MutationObserver 幂等重注入（MobileNavOverlay 的 effect）。全屏几何在 `[data-mobile-nav="frame"][data-aionui-preview-open][data-mobile-preview-full] [data-aionui-preview-col]`（inset 0 + safe-area padding-top，padding-top 必须进过渡列表，按钮同时 `top: calc(safe-area + 8px)`）。预览关闭（index.tsx 的 `closePreview()`：onCollapse 和 visibility watcher 两处）必须同时清 `data-aionui-preview-open` 和 `data-mobile-preview-full`。`[data-aionui-preview-col] [class$="_tabScroll"]` 保留 `padding-right: 34px`，否则标签多时最后一个 tab / "+" 按钮会滑到全屏按钮底下。
- **stacking context 陷阱（2026-08-16 修）**：`shell.overlay` slot 渲染进 `pI_x6G_overlayLayer`（`position:absolute; z-index:20; pointer-events:none`）——它构成 stacking context，层内元素的 z-index 被封印在 20，任何 z>20 的浮层（aionui sheet z:55/56）都会盖住层内按钮。**凡是要浮在 sheet 之上的控件都不能渲染进 overlay 层**——两条出路：① 挂在 body 级（`document.body.appendChild`，CSS 用 `body:has()` 读 frame 标记）；② **更好的：直接 append 进 sheet 内部**（sheet z:56 高于 layer，按钮随浮层走、可见性自动继承）。FAB/backdrop 在层内没问题（无元素与它们重叠）。复现这类问题要在复现页里加同款 z-20 层 + `elementFromPoint` 命中测试，光看 getBoundingClientRect/z-index 不够。
- **tablet 分支陷阱**：`@media (min-width: 768px) and (max-width: 1023px)` 会把 aionui sheet 居中限宽到 `min(calc(100vw - 32px), 720px)`——用 ≥768px 视口验证移动端几何会看到「8px 边距变成居中 720px」，这不是 bug；手机验证用 <768px 视口。
- **后缀类选择器三态陷阱（issue #8 回归，2026-08-16 修）**：suite 的 hashed 类带哈希前缀（如 `-NprXq_treeRow`），且状态会追加后缀（选中行 `_treeRowSelected`、展开箭头 `_treeArrowOpen`）：
  - `[class$="_treeRow"]` 只匹配**裸状态**——选中/拖拽行整条失效（这就是「关闭后再点同一文件不弹出」的根因）；
  - `[class~="_treeRow"]` 永远不匹配——`~=` 是**整 token 精确匹配**，token 是 `-NprXq_treeRow` 而非 `_treeRow`；
  - 行匹配正确写法：`[class*="_treeRow"]`（子串匹配，覆盖裸/选中/拖拽所有状态；在 `[data-aionui-explorer-col]` 作用域内无其他含该子串的类）。
  - **箭头匹配必须排除叶子标记**：文件行也渲染箭头 span，其类是 `-NprXq_treeArrowEmpty`（仍含 `_treeArrow` 子串）——裸 `[class*="_treeArrow"]` 会把**所有行**当目录、预览永不弹出（697f911 的回归，用户实测发现）。正确写法：`[class*="_treeArrow"]:not([class*="_treeArrowEmpty"])`。
  - 教训：验证选择器时合成行必须**逐字复刻真实结构**（文件行 = 行类 + `_treeArrowEmpty` 子元素；目录行 = 行类 + `_treeArrow[Open]` 子元素），只测「无箭头子元素的裸行」会漏掉回归——697f911 就是这么翻车的。
- 抽 CSS 做复现时：`MOBILE_CSS` 由 `src/client/styles/index.ts` 按 base → layout → compat → misc 拼接——直接读对应 `styles/*.css.ts` 的模板内容拼接即可，不必解析 bundle；注释里不能写反引号（会截断模板字符串成 TS 语法错误）、注释必须完整保留（截断的 `/*` 会让 CSS 解析器吞掉下一条规则）这两条仍适用。
- **styles/ 按节切片（2026-08-16 拆分心得）**：把 `mobile.css.ts`（现已拆到 `src/client/styles/`）按主题节切片时，各节分隔是**空行 `\n\n` + 下一个 marker 的起始行**；其中 `/* dsh-web-ui family */`、`/* hero composer */` 两个 marker 是**缩进**在 `@media` 块内的（行首有两空格）。切片脚本若用「当前节 end -= 2 + 下节 start = marker 偏移」（去掉空行、下节不带头空格）会丢字节导致 round-trip 不匹配。正确做法：取 `css.lastIndexOf('\n', markerPos) + 1` 作为 marker **所在行的行首**（含缩进）当下节 start，当前节 `end = 下节行首 - 1`（保留一个尾部 `\n`），再用 `join('\n')` 把单 `\n` 补回原来空行的两个 `\n` —— 可证明字节往返一致；生成后务必跑 `node $TMPDIR/split-css.mjs` 的自检 `SPLIT OK`。
- **`build-client.mjs` 的扁平→递归（2026-08-16 修）**：该 bundler 原先对 `.client-build/` 只做**扁平** `readdir`。把 CSS 放进 `src/client/styles/`（子目录）后 tsc 会 emit 出 `.client-build/styles/*.js`，`index.js` 的 `require("./styles/index.js")` 在扁平 map 里找不到 → 构建直接 `TypeError` 崩溃。已修成**递归收集 + 按宿主模块目录把 `require("./x.js")` 解析/改写为规范相对路径**（如 `styles/base.css.js`），运行时 `__localRequire` 不变。以后往 `src/client/` 加子目录模块是安全的；若未来恢复为扁平，需注意此限制。
- **整块替换 CSS/代码前先确认替换区间边界**：用脚本按起止标记替换大块时，区间内的独立规则会一起被吞（1779cd4 事故：重写 toggle 块把「全屏几何规则」删了，功能表现为「标记/图标正常切换但浮层不变全屏」）。改完必须 grep 关键选择器/属性（如 `inset: 0`）确认没丢规则；这类回归用户实测前难以察觉。
- 2026-08-16「手机全屏 md」事故真相：全屏内容 = 会话消息里的 GenUI（dsh-ui fence）卡片（「当前结构」表格），不是任何文件/预览。当前 bundle + 当前 genui CSS 均无全屏渲染路径（aionui 列是底部浮层且被门控、genui block/panel 无 fixed 规则）→ 手机端再复现时先抓 URL 栏：裸文件页 = 浏览器导航到了文件 URL；有 app UI = 旧 JS 缓存。别凭截图猜「旧 bundle」。**补充（当晚续接会话验证，「无全屏路径」的判断不成立）**：Playwright 复用长期挂着的旧页面 context（带旧 localStorage）时，harness web 会把**最后一条 dsh-ui fence 以 `pI_x6G_frame` 兄弟节点挂到 app 根级**，并给 frame 内联 `display: none`（inline style；grid 5 轨仍是 aionui 写的）——任意宽度（360~1280）、`/` 与 `/settings`、当前与重构前 bundle 均复现，与 dsh-mobile-nav 无关（插件从不写 display、桌面宽度同样出现、旧 bundle 同样出现）。**全新 context（无旧存储）** + 会话打开则渲染完全正常，抽屉验证可正常执行。再遇「手机全屏卡」先让用户清站点数据/换新浏览器 context 验证，别据此改 mobile-nav 代码。
- **用户手机浏览器是 Via（WebView 内核 + 激进缓存，会无视 `cache-control: no-cache`）**：旧 HTML/资源会被固化 →「怎么刷新都跳不过、清缓存才好、重建 bundle（rev 变化触发整页重载）后也消失」。诊断此类问题用 `?mobile-nav-debug=1` 徽章（提交 2300b82）：右上角实时显示 URL/宽高/媒体查询/头部/composer/aionui 浮层/genui 数量/捕获的 JS 错误。**未复现时不要重建 bundle**——重建会冲掉手机端卡死状态，反而不利于取证。
- **手机端时间戳走 `Intl`，不要用 `document.documentElement.lang`**：页面 html 上写死 `lang="zh-CN"`，而官方 UI 文案跟的是 `navigator.languages`（2026-08-17 实测：html=zh-CN、UI=English）。用 html lang 建格式化器会出现「英文界面里的中文时间」。传 `undefined` 让 Intl 跟浏览器语言，与官方文案一致。
- **本机（macOS）CDP 探针**：`scripts/cdp-probe.mjs` 里的 chrome 路径/session id 是 Termux 环境遗留，macOS 上跑不了；照它的骨架临时写一份到 scratchpad，chrome 路径用 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，其余（`net.listen(0)` 动态端口、独立 profile、退出 SIGKILL + 删 profile、stdout flush 后再 exit）照抄。
- 没有测试框架：改布局后需在真实 DSH web profile + 窄屏（约 390px）和桌面（≥1024px）手动验证。**Playwright 验证配方（2026-08-16 沉淀）**：① 用**全新 browser context**（`browser.newContext()`），`addInitScript` 写入 `localStorage['dsh.sessions.current'] = JSON.stringify({sessionId})` 后直接开会话页——**不要复用长活 context**（旧 localStorage 会触发 harness「fence-only」状态：frame 内联 `display:none`、最后一条 dsh-ui fence 挂 app 根级，抽屉无法验证，且与 mobile-nav 无关，见「手机全屏 md」pitfall）；② 点 backdrop 关闭抽屉时 Playwright 默认点元素中心会被抽屉盖住（hit-test 拦截）→ 用 `page.mouse.click(x, y)` 点抽屉右侧露出区域；③ **不要用 route 拦截插件 client.js 做 A/B**——fulfill 空 body 会被浏览器缓存，后续加载报 `loaded without registering` 并挂起 goto；A/B 用 `git show <commit>:lib/client.js > lib/client.js` 直接换文件（rev 自动变化，验完恢复）；④ 本机模型无图像输入时，用 `browser_snapshot` + `browser_evaluate` 查几何/计算样式代替截图判读。⑤ **CDP 裸探针**：`node scripts/cdp-probe.mjs`（无 Playwright 依赖，直接 CDP 驱动 chromium）——直连 `/usr/lib/chromium/chrome`（**不要用 `chromium-browser` launcher**，它会注入 `--extra-plugin-dir` 等参数）、`net.listen(0)` 动态空闲端口、`~/.cache/cdp-probe-<ts>` 独立 profile、退出时 SIGKILL chrome 并重试删除 profile（zygote 短时持锁）、stdout flush 后再 `process.exit`（否则管道输出被截断）；seed session 用 `Page.reload` 而非 evaluate 里 `location.reload()`（在途 evaluate 会报 `Inspected target navigated or closed`），workspace 切换/seed 后的 evaluate 要带跨导航重试。
- **Playwright MCP 是并列会话共享单例**（一个 node 服务 + 按需拉起的浏览器）：一个会话长操作时其他会话显示「被占用」是正常的，别去重启/杀 MCP 服务或它的浏览器；probe 必须自备浏览器（见上配方⑤）并**自清理**——早前 probe 用固定端口 + `process.exit` 不杀子进程，孤儿 chrome 树能把设备 CPU 打满（zygote 60%+），让 MCP 浏览器看起来「卡住/被占用」。清理孤儿时 **`pkill -f` 会匹配到自己的命令行把自己杀掉**（bash -c 里含同样字符串）→ 用 PID 或唯一 profile 串。并列会话里别人可能同时在跑同款 probe：动态端口 + 独立 profile 是硬要求，别用固定 9333 之类的端口。
- **`[data-phase="hero"]` 不是会话 composer 的 phase**（2026-08-16 实测）：会话页 textarea 自带 `data-phase="plain"`，位于 `[data-slot="conversation.composer.bar"]` 内；`hero` 是无会话落地页。用 `hero` 锚 composer 的选择器/JS 会**静默失效**（chip reparent 不触发、样式不命中），Playwright 一测即现形。composer 稳定锚点 = `[data-slot="conversation.composer.bar"] textarea`。
- **旧 WebView 内核（Via 等，< Chromium 105）不支持 `:has()`**：`:has()` 规则整条静默丢弃，同组选择器里无 `:has` 的规则照常生效 → 典型症状「chip 定位规则生效、文字避让规则失效 → 文字压住胶囊」，且 Chromium 里验证完全正常（2026-08-16 用户实测发现）。**关键布局（文字避让等）用 JS inline style 直写**（reparent effect 里 `ta.style.paddingLeft`），不要依赖 `:has`。项目 CSS 其余 `:has` 规则（composer pill 等）在旧内核上同样失效——用户报「什么都有问题」时先怀疑这个。
- **settings 弹窗 header reparent 后结构选择器必然错位**（2026-08-16）：移动端把 header（关闭 ✕）JS-reparent 进 nav 行后，`> :last-child > :first-child` 等选择器会错位命中——close 的 32px 圆形样式会打到 options 的 section 上。settings 内部规则一律**类锚点**（`[class$="_navList"]`、`[class$="_header"]`、`[class$="_header"] > :last-child`），不要用 `:first-child/:last-child`。
- **tabs 单行横向滚动必须有 affordance**：早期无滚动条方案把最后一个 tab 无声切掉（用户无法发现可滚动）→ 曾退回 3 列 grid。恢复单行后必须带细滚动条：`scrollbar-width: thin` + `::-webkit-scrollbar { height: 2px }`（thumb 半透明圆角、track 透明）。用户嫌默认滚动条粗（2026-08-16）。
- **settings 弹窗识别选择器**：`[aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"]))`——settings 的 nav 行含 button tabs；export dialog（header+description+body，无 nav）不匹配 → 保持官方居中卡片。JS reparent 用「dialog 内存在 `[class$="_nav"]`」门控（export 无 nav → no-op；export 也有 `[class$="_header"]`，不能只查 header）。
- **目录选择器会被 settings sheet 劫持（issue #12，2026-08-16 修）**：`dsh-client-ui-directory-picker-browse` 的 dialog（`ZuhsRW_dialog`，官方 CSS 前缀 `ZuhsRW`）footerBar 有 button 子元素 → 满足 `:has(> :first-child > :last-child > button)`；它靠面包屑 `ZuhsRW_crumbTrail` 的 `role="navigation"` 被 `:not(:has([role="navigation"]))` 排除——但**点笔形「编辑」进手动输入后，面包屑被 pathInput 替换、crumbTrail（nav）消失** → settings sheet 规则瞬态命中：dialog 跳到 `top:12px`，且 `> :first-child > :first-child { display:none!important }` 把 header（含路径输入框）整个藏掉 = 用户看到的「整体向上顶、无法输入路径」（issue #12 视频实录）。「新建文件夹」createDialog（createActions 含 buttons、无 nav）同样会被命中。**修复：settings 复合选择器统一追加 `:not(:has([class*="ZuhsRW"]))`**——layout.css.ts 12 处 + compat.css.ts 1 处 + misc.css.ts 平板居中块 1 处，改选择器时全量 grep 核对。验证：390px 点编辑后 dialog 保持官方居中（24,171 342x502）、input 可见且获焦；settings sheet 仍命中（8,12 374x800）；桌面 no-op 不变。
- **用户手机 Via 激进缓存 + 引用旧截图**：用户反馈时引用的截图文件名可能已更新（如 `IMG_224256.jpg` → `IMG_225705.jpg`，Android 时间戳命名）——**先 `ls` 工作区找最新截图再分析**，别分析旧图。手机端验证前先让用户 `?mobile-nav-debug=1` 报 rev 或强刷，确认加载的是新 bundle。
- **「退回」语义（2026-08-16 教训）**：用户说「退回」= 撤销本轮改动、恢复到**之前的工作区状态**（未提交的脏状态），不是 git reset 到旧提交。被 rebase 掉的提交对象仍在 reflog（90 天内），`git cat-file -t <commit>` + `git show <commit>:<path>` 可恢复文件内容——e174f62 就是这么救回来的（compat/layout 的初始版 = 被 rebase 提交里的内容）。
- **vision_glance 的像素间距判断不可靠**（2026-08-16）：把 6px 间隙误判成「文字与胶囊重叠」。几何真值用 Playwright `getBoundingClientRect()` 测量，vision 只用于定性描述/OCR。
- **write 工具写 `docs/superpowers/specs/` 报 EACCES**（2026-08-16 遇两次）：用 bash heredoc 写文件可绕过。
- **codegraph 已启用**：`codegraph init` 生成 `.codegraph/`（已加 .gitignore）；查询用 codegraph_explore（CSS 模板字符串模块也能索引），不用再跑 grep 全家桶。

## Maintenance

- 发现新的命令、约定或坑时，就地更新本文件；保持简洁、只留 repo-specific 事实。
- 第三方兼容版本变化时，同步更新 README 的“兼容插件”列表和本文 Pitfalls。
