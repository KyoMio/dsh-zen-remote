# 调研：Android 软键盘弹出时输入框被遮挡（小米 + 微信输入法必现）

2026-08-21 调研。对应现象：手机 Chrome / 系统 WebView 访问本 PWA，点击底部
composer textarea，微信输入法（WeType）弹出后页面不上移，输入内容被键盘挡住；
其他环境（如 Gboard、iOS）表现正常。

置信度标注约定：

- **[规范/官方]** —— 规范原文、官方文档、官方博客、官方 bug tracker 结论
- **[源码]** —— 浏览器 / 项目源码直接读到
- **[社区]** —— 社区帖子 / 第三方 issue，属案例线索，未经一手证实

---

## 一、问题概述

页面底部有一个 textarea（composer，`position: sticky; bottom: 0`，位于内部滚动
容器中；`html/body` 是 `overflow: hidden`，本插件刻意不做 visualViewport JS，
依赖浏览器自己把聚焦元素挪进可视区 —— 见 `src/client/styles/home.css.ts` 注释
**[源码]**）。在「小米手机 + 微信输入法」组合下，键盘弹出后视口没有任何变化，
浏览器也没有把光标滚进可视区，文字被键盘盖住。

要理解根因，关键是弄清一条完整的信息链：

> Android IME 弹出 → 系统把键盘占用的高度以 window insets 形式发给应用
> → Chrome 读取 insets 算出键盘高度 → 缩小 visual viewport（视觉视口）
> → 触发 `visualViewport` resize 事件 + 自动把聚焦的输入框滚进可视区。

这条链上**任何一环断掉**，页面都不会上移。下面逐环给出平台事实。

---

## 二、平台机制事实（带来源）

### 2.1 Chrome 108 起的键盘-视口行为

- **[规范/官方]** Chrome 108（2022-11）起，Android Chrome 键盘弹出时**不再缩小
  layout viewport（布局视口）**，只缩小 visual viewport。`window.innerHeight`、
  `100vh/100dvh`、`position: fixed` 元素的位置都不再随键盘变化。此行为与
  iOS Safari 对齐。
  来源：[Chrome 官方博客 viewport-resize-behavior](https://developer.chrome.com/blog/viewport-resize-behavior)、
  [blink-dev Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/ge7xTu-VhJ0)
- **[规范/官方]** 同版本引入 viewport meta 的 `interactive-widget` 键，三个值：
  - `resizes-visual`（**默认**）：只缩 visual viewport；
  - `resizes-content`：布局视口一起缩（等于 108 之前的老行为）；
  - `overlays-content`：什么都不缩，键盘纯覆盖。
  规范条文见 [CSS Viewport Module Level 1](https://drafts.csswg.org/css-viewport/)
  （`interactive-widget` 属性；无值或非法值按 `resizes-visual` 处理），值语义另见
  [MDN viewport meta](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport)。
- **[规范/官方]** 支持版本（MDN BCD 数据，`html/elements/meta/name/viewport/interactive-widget.json`）：
  Chrome Android **108+**，Firefox Android **133+**（Firefox Android 132 先把默认行为
  改成 resizes-visual，见 [Firefox 132 for Android release notes](https://www.mozilla.org/en-US/firefox/android/132.0/releasenotes/)），
  桌面各浏览器与 Safari 均不支持（桌面无 OSK 概念，Safari iOS 未实现）。
  来源：[mdn/browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/html/elements/meta/name/viewport/interactive-widget.json)。
- **[源码]** Chrome Android 端的键盘高度是这样算出来的：
  `KeyboardUtils.calculateKeyboardHeightFromWindowInsets()` 读
  `getRootWindowInsets()` → `WindowInsetsCompat.Type.ime().bottom` 再减去
  `systemBars().bottom`；`isAndroidSoftKeyboardShowing()` 就是「算出的高度 > 0」。
  源码注释原话：*"This is a best guess based on the height of the keyboard as
  there is no standardized/foolproof way to do this."*（“这是基于键盘高度的
  最佳猜测，没有标准化的万无一失的办法”）。
  来源：[base/android/.../KeyboardUtils.java](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/base/android/java/src/org/chromium/base/ui/KeyboardUtils.java)、
  [ui/android/.../KeyboardVisibilityDelegate.java](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/android/java/src/org/chromium/ui/KeyboardVisibilityDelegate.java)。
  **推论：键盘高度完全取决于 IME 通过系统 window insets 上报的数值。IME（或被
  OEM 定制过的系统）报 0，Chrome 就认为没有键盘。**
- **[规范/官方]** 键盘弹出时把聚焦输入框挪进可视区，是浏览器侧
  `ScrollFocusedEditableNodeIntoRect` 这条 IME 专用通道做的（"used by IMEs
  (on-screen keyboards) to bring an element into view"），同样由键盘几何信息驱动。
  来源：[crbug 40774196（EditContext scroll into view）](https://issues.chromium.org/issues/40774196)。

### 2.2 visualViewport API 的事件语义

- **[规范/官方]** CSSOM View §13.1 "Resizing viewports" 原文：只有当
  VisualViewport 的 *scale / width / height 相比上次 run the resize steps 时
  发生了变化*，才在 VisualViewport 上 fire `resize`。
  来源：[drafts.csswg.org/cssom-view §13.1](https://drafts.csswg.org/cssom-view/#resizing-viewports)。
  **推论：如果键盘弹出但视口尺寸根本没被改（上一节的 insets 链断了），不触发
  resize 是"符合规范"的 —— 事件不来不是 bug，而是视口真的没变。任何"只监听
  事件"的方案在这种设备上天然失效。**
- **[规范/官方]** 已知相关事件 bug（都不是"键盘弹出完全无事件"，而是时序/数值噪声）：
  - [crbug 40924170](https://issues.chromium.org/issues/40924170)：使用
    `interactive-widget=overlays-content`（VirtualKeyboard API 通道）时，键盘
    动画期间 `window.innerHeight` 短暂变成无意义的大/小值。2024-04 修复
    （CL [5431673](https://chromium-review.googlesource.com/c/chromium/src/+/5431673)），
    2025-10 又有人在 Chrome 141 复现，追踪新 bug 450752874。
  - [crbug 41343106](https://issues.chromium.org/issues/41343106)：URL 栏动画期间
    visualViewport resize 不触发（旧案）。
  - [crbug 40768751](https://issues.chromium.org/issues/40768751)：iframe 里
    visualViewport 不发 resize。
- 第三方 IME 是否影响事件触发：**没有找到 Chromium 官方就"某第三方 IME 导致
  visualViewport 事件不触发"立案的一手记录**。但按 2.1 的源码链，IME insets
  上报异常 ⇒ 视口不缩 ⇒ 无事件，逻辑上成立且与本 bug 症状吻合（**[源码]推论**，
  非官方结论）。

### 2.3 第三方 IME / OEM 定制的特殊性

- **[规范/官方]** 原生层的两种老模式：`android:windowSoftInputMode` 的
  `adjustResize`（窗口整体缩小）与 `adjustPan`（窗口整体上平移、不缩小、
  **不产生任何页面内 resize**）。
  来源：[Android activity-element 文档](https://developer.android.com/guide/topics/manifest/activity-element#wsoft)。
  Chrome 浏览器本体不走这套（自己读 insets），但 **WebView 完全由宿主 App 的
  这个设置决定**（见 2.4）。
- **[社区]** 第三方 IME 键盘高度与系统上报不一致的公开案例：搜狗输入法键盘比默认
  输入法高约 30px，导致输入框被压住一截
  （[CSDN：固定在 H5 底部的输入框的兼容性问题](https://blog.csdn.net/kill370354/article/details/128390440)）。
- **[社区]** 小米设备网页端键盘遮挡的公开案例：
  - [CSDN：小米手机浏览器的 input/textarea 底部被遮挡](https://blog.csdn.net/wngzhem/article/details/102524828)
    （小米自带浏览器，聚焦后键盘盖住吸底输入框）；
  - [微信开放社区：小程序 webview 中 fixed 定位 input，小米 6 软键盘遮挡必现](https://developers.weixin.qq.com/community/develop/doc/0002ee32d84c1020523aaeab75b000)；
  - [微信开放社区：web-view 在 Android 检测不到键盘弹出，造成遮挡](https://developers.weixin.qq.com/community/develop/doc/167b6d37a9efaffb0722c7950ede5adc)；
  - [微信开放社区：软键盘弹出状态影响页面显示（安卓兼容）](https://developers.weixin.qq.com/community/develop/doc/000042e586c698167262e4b1961400)。
- **微信输入法（WeType）+ 小米的组合，没有检索到公开的一手 bug 记录**（Chromium
  tracker、微信开放社区、GitHub 均未见立案）。“WeType 在 MIUI/HyperOS 上 insets
  上报异常”目前只能算**与源码机制吻合的假设**，需要在设备上实测证实（见第四节
  的判别方法）。此点如实标注：**传闻/未证实**。
- **[社区]** WeType 与微信键盘生态的杂项 bug 汇总（非本问题直接证据）：
  [知乎：微信输入法发布 1 月了，你发现了哪些 bug](https://zhuanlan.zhihu.com/p/599576914)。

### 2.4 系统 WebView 的差异（重要）

- **[规范/官方]** Chrome 108 的行为变化**明确不适用于 WebView**。blink-dev 原话：
  *"There is no intended behavior change for Android WebView. The Android app is
  responsible for sizing the WebView and can implement either mode via
  windowSoftInputMode."*
  来源：[blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/ge7xTu-VhJ0/m/hq_kcusHAQAJ)，
  转引自 [crbug 40287394](https://issues.chromium.org/issues/40287394)。
- **[规范/官方]** crbug 40287394（Adobe 报告，Feature Request）实测映射关系：
  - 宿主 App `adjustResize` ⇒ 等价 `resizes-content`（布局+视觉一起缩）；
  - 宿主 App `adjustPan` / `adjustUnspecified` ⇒ 等价 `overlays-content`
    （**什么都不缩、页面完全不知道键盘存在**）；
  - Chrome 默认的 `resizes-visual` 在 WebView 里**无法实现**；
  - **VirtualKeyboard API 在 WebView 里不可用**：boundingRect 全零、
    `geometrychange` 永不触发（issue 原文）。
  该 issue 2025 年标记 Fixed（CL [6616171](https://chromium-review.googlesource.com/6616171)），
  但报告者在 WebView Canary 139 实测仍未见效（issue #21 楼），落地状态存疑。
- **推论：如果"系统 WebView 访问"指从某个 App（如微信、小米自带应用）内打开，
  且宿主是 adjustPan/unspecified，则遮挡是设计使然，与 IME 无关。** 判别方法见
  第四节。

### 2.5 PWA standalone 模式的差异

- **[社区]** 有零散反馈称同一站点"浏览器 tab 正常、装成 PWA 后键盘行为异常"：
  - [code-server #7149](https://github.com/coder/code-server/issues/7149)
    （Android 15 / Chrome 131，PWA 内键盘输入异常，"the regular chrome website
    doesn't have these issues"；已关闭，归为上游问题）；
  - [PWABuilder #2572](https://github.com/pwa-builder/PWABuilder/issues/2572)
    （TWA 中键盘收起后视口卡在缩小状态）。
- **没有找到"standalone 下键盘视口行为与 tab 系统性不同"的 Chromium 官方一手
  记录**。WebAPK 安装的 PWA 仍由 Chrome 渲染，理论上走 Chrome 的 insets 链而非
  WebView 的 windowSoftInputMode 链。此点标注：**社区案例，未证实**。

### 2.6 VirtualKeyboard API

- **[规范/官方]** `navigator.virtualKeyboard`：设 `overlaysContent = true` 后浏览器
  完全不再为键盘调整视口，改由页面用 `geometrychange` 事件 + `boundingRect` +
  CSS `env(keyboard-inset-*)` 自己布局。**只有 opt-in 之后这些能力才生效**。
  来源：[MDN VirtualKeyboard API](https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API)、
  [Chrome 官方文档](https://developer.chrome.com/docs/web-platform/virtual-keyboard)、
  [W3C 草案](https://w3c.github.io/editing/docs/virtualkeyboard/)。
- **[规范/官方]** 支持范围（MDN BCD `api/VirtualKeyboard.json`）：Chromium 系
  **94+**（含 Android Chrome）；Firefox、Safari 均未实现（分别见
  [bugzil.la/1730568](https://bugzilla.mozilla.org/show_bug.cgi?id=1730568)、
  [webkit.org/b/230225](https://bugs.webkit.org/show_bug.cgi?id=230225)）。
  非 Baseline、标注实验性。
- **[规范/官方]** WebView 中名义上存在但实际不可用（boundingRect 全零，见 2.4）。
- **适用性结论：它的键盘几何数据和 visual viewport 用的是同一条 insets 链
  （[源码]推论），所以对"IME 不上报高度"这类根因**同样无能为力**，还把 Firefox/
  Safari 排除在外。本场景不推荐作为主方案。**

### 2.7 业界聊天 UI 的实际做法（源码）

- **[源码]** Telegram Web A（[Ajaxy/telegram-tt](https://github.com/Ajaxy/telegram-tt)）：
  - viewport meta **没有** `interactive-widget`（`index.html`）；
  - [`src/util/windowSize.ts`](https://github.com/Ajaxy/telegram-tt/blob/master/src/util/windowSize.ts)：
    iOS 用 `visualViewport.height + visualViewport.pageTop` 维护 `--vh` CSS 变量并监听
    `visualViewport resize`；**Android 只听 `window.resize`**，即在 Android 上
    基本信任浏览器默认的 resizes-visual 自动行为（跟本插件目前思路一致）；
  - 键盘可见性判断就是「innerHeight 比初值小」的启发式。
- **[社区]** 通用做法参考：用 visualViewport 把底栏 `translateY` 到
  `innerHeight - vv.height - vv.offsetTop` 处
  （[dev.to: Fix mobile keyboard overlap with visualViewport](https://dev.to/franciscomoretti/fix-mobile-keyboard-overlap-with-visualviewport-3a4a)）。

---

## 三、已知案例 / 相关 bug 清单

| 编号/链接 | 内容 | 状态 | 置信度 |
| --- | --- | --- | --- |
| [crbug 40287394](https://issues.chromium.org/issues/40287394) | WebView 无法只缩 visual viewport；adjustPan≈overlays-content；VirtualKeyboard API 在 WebView 全零 | Fixed（2025，落地存疑） | 官方 |
| [crbug 40924170](https://issues.chromium.org/issues/40924170) | overlays-content 下键盘动画期间 innerHeight 出现瞬时错误值 | Fixed，2025-10 复发报告 → bug 450752874 | 官方 |
| [crbug 41176235](https://issues.chromium.org/issues/41176235) | 108 之前"键盘缩窗口打乱 SPA 布局"的历史诉求 | 历史参考 | 官方 |
| [crbug 41343106](https://issues.chromium.org/issues/41343106) / [40768751](https://issues.chromium.org/issues/40768751) | visualViewport 事件在 URL 栏动画 / iframe 场景不触发 | — | 官方 |
| [微信开放社区（小米 6 webview fixed input 必现遮挡）](https://developers.weixin.qq.com/community/develop/doc/0002ee32d84c1020523aaeab75b000) 等 3 帖 | 小米/华为设备上 webview 检测不到键盘、fixed 输入框被盖 | 无官方结论 | 社区 |
| [CSDN 小米浏览器输入框被盖](https://blog.csdn.net/wngzhem/article/details/102524828)、[搜狗键盘高 30px](https://blog.csdn.net/kill370354/article/details/128390440) | OEM 浏览器 / 第三方 IME 高度不一致案例 | — | 社区 |
| [code-server #7149](https://github.com/coder/code-server/issues/7149)、[PWABuilder #2572](https://github.com/pwa-builder/PWABuilder/issues/2572) | PWA/TWA 形态下键盘视口异常 | 关闭/未决 | 社区 |
| WeType + 小米组合 | **未检索到公开一手记录** | — | 传闻/未证实 |

---

## 四、根因候选排序（附判别性预期）

按可能性从高到低。每条给出「如果是它，会观察到什么」，用项目自带的
`?debug` 面板（`src/client/debug.ts` 已经显示 visualViewport 数据）即可判别。

1. **WeType（或 MIUI/HyperOS 对其的 insets 处理）没有把键盘高度报进
   `WindowInsets.ime()`，Chrome 端算得键盘高度为 0。**（[源码]链推论；
   WeType 环节本身未证实）
   预期观察：键盘弹出前后 `visualViewport.height` **纹丝不动**、无 resize 事件、
   `innerHeight` 不变、浏览器也不自动滚动光标。切回 Gboard 立即正常。
   若再验证：同一设备上 Chrome 换成 Firefox Android（走自己的 insets 消费逻辑）
   看是否同样失效，可区分"IME 没报"还是"Chrome 没读到"。
2. **WeType 处于悬浮/迷你键盘等特殊窗口形态**（悬浮键盘本来就不占 insets，
   overlay 是预期行为）。
   预期观察：键盘不是全宽贴底的常规形态；改回标准全键盘模式立刻正常。
3. **访问入口实为某 App 内嵌 WebView，宿主 windowSoftInputMode 是
   adjustPan/unspecified** ⇒ 等价 overlays-content，设计如此（[官方] crbug 40287394）。
   预期观察：同一页面在独立 Chrome 里正常，仅从该 App 打开时遮挡；且此时换
   Gboard 也一样遮挡（与 IME 无关）。
4. **visualViewport 缩了、事件也来了，但页面结构令浏览器自动滚动失效**
   （sticky 底栏 + `html/body overflow:hidden`，浏览器把光标滚进可视区时
   没有可滚的祖先）。
   预期观察：debug 面板里 `vv.height` 明显变小、resize 有触发，但 composer
   仍在键盘下面。此时问题在我们页面侧，走第五节方案 2 必能修。
5. **PWA standalone 形态特有 bug**（[社区]，未证实）。
   预期观察：同一 Chrome、同一输入法，浏览器 tab 里正常、仅"添加到主屏幕"的
   窗口里遮挡。
6. **Chrome 版本撞上瞬时高度 bug 族**（crbug 40924170 / 450752874，
   仅在用了 overlays-content / VirtualKeyboard API 时相关）。本项目没用这些
   模式，基本可排除；若未来启用需注意。

> 注：候选 1/2 里"页面完全不知道键盘存在"时，**不触发事件是符合 CSSOM View
> 规范的**（§13.1 只有尺寸真变了才 fire），所以"补监听"类方案救不了它们。

---

## 五、解决路径清单（按性价比排序）

1. **先做 10 分钟判别实验，再选方案**（零代码）。
   在故障机上开 `?debug` 面板：点 textarea，看 `visualViewport.height` 变不变。
   变 ⇒ 根因 4，走下面第 2 条，必修得好；不变 ⇒ 根因 1/2/3，第 2 条的事件监听
   部分对它无效，需要第 3/4 条兜底。同时记录：换 Gboard 是否正常、WeType 是否
   悬浮模式、入口是 Chrome 还是 App 内。
   依据：CSSOM View §13.1（事件只在尺寸变化时触发）+ KeyboardUtils 源码链。
2. **visualViewport `resize` + `scroll` 双监听，把 composer 平移到可视区底边**
   （适用：根因 4，以及所有"视口确实缩了"的环境；iOS 也受益）。
   公式：`offset = innerHeight - vv.height - vv.offsetTop`，对 composer 施加
   `translateY(-offset)` 或把它的容器高度设为 `vv.height`。
   注意：要同时听 `scroll`（visual viewport 平移时 offsetTop 变化不发 resize，
   规范 §13.2）；用 rAF 合并；键盘收起时归零。
   来源：[MDN VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport)、
   [dev.to 实现示例](https://dev.to/franciscomoretti/fix-mobile-keyboard-overlap-with-visualviewport-3a4a)、
   telegram-tt iOS 分支同思路（[windowSize.ts](https://github.com/Ajaxy/telegram-tt/blob/master/src/util/windowSize.ts)）。
   风险：低；纯增量，事件不来时等于没装。
3. **meta viewport 加 `interactive-widget=resizes-content`**
   （适用：想回到"键盘顶起整个布局"的老行为，让 sticky/fixed 底栏天然可见；
   Chrome Android 108+ / Firefox Android 133+，其他浏览器安全忽略）。
   来源：[Chrome 博客](https://developer.chrome.com/blog/viewport-resize-behavior)、
   [MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport)。
   风险：a) 它依赖同一条 insets 链，**对根因 1/2 大概率同样无效**（键盘高度
   为 0 时无从缩起）—— 但值得实测，因为 resizes-content 在 Chrome 内部走
   `adjustResize` 型窗口缩放路径，与 visual-viewport 路径不完全相同；
   b) 键盘弹出时 `100vh/dvh`、媒体查询、整页布局都会跳一次，本插件大量
   "document 永不滚动"的假设要回归测试。工作量：一行 meta + 回归测试。
4. **focus 后轮询兜底（专治"事件不来"的 IME）**
   （适用：根因 1/2 确诊，又不能要求用户换输入法时）。
   focusin 到 composer 后，短周期（如每 100ms，持续 ~1.5s）比对
   `vv.height`/`innerHeight`；若始终没变化，视为"哑键盘"，给 composer 加一段
   估计高度的底部让位（如 `min(40vh, 320px)`），blur 后撤掉。
   这是社区通行的启发式（[微信开放社区案例](https://developers.weixin.qq.com/community/develop/doc/167b6d37a9efaffb0722c7950ede5adc)
   即"监听 focus 前后 window 高度变化"思路的引申，**[社区]**，无官方背书）。
   风险：估高不准（键盘高度因输入法/表情面板而异）；必现误判面（外接键盘用户
   会被白白顶起 —— 可用 `navigator.virtualKeyboard`/触摸能力启发式减噪）。
   建议只在「判别实验证实事件确实不来」后再上。
5. **focus 时 `scrollIntoView` 兜底**：对本项目**基本无效** —— composer 已经
   sticky 在滚动容器底部、document 又 `overflow:hidden`，没有可滚的余地；它只
   对"输入框在长文档中部"的常规页面有意义。列出仅为完整性（**[社区]** 通行做法）。
6. **VirtualKeyboard API（`overlaysContent` + `env(keyboard-inset-*)`）**：
   本场景不推荐。仅 Chromium 94+、WebView 全零（[crbug 40287394](https://issues.chromium.org/issues/40287394)）、
   与根因 1/2 同链失效，且曾有瞬时高度 bug 族（[crbug 40924170](https://issues.chromium.org/issues/40924170)）。
7. **运维/用户侧路径**（正规修复之外的现实选项）：让该用户在 WeType 里关闭
   悬浮键盘、或临时切 Gboard 验证；升级 Android System WebView / Chrome；
   若确诊是 WeType insets 问题，向微信输入法反馈（其 Android 端无公开 tracker，
   走 App 内反馈）。**[社区/操作建议]**

推荐组合：**路径 1（判别）→ 路径 2（无条件先装上，覆盖大多数环境并给 iOS
兜底）→ 视判别结果决定是否加 3 或 4**。

---

## 六、参考链接汇总

规范 / 官方文档：

- CSS Viewport Module Level 1（interactive-widget）：<https://drafts.csswg.org/css-viewport/>
- CSSOM View §13 事件触发条件：<https://drafts.csswg.org/cssom-view/#resizing-viewports>
- Chrome 108 视口行为变更官方博客：<https://developer.chrome.com/blog/viewport-resize-behavior>
- blink-dev Intent（含 WebView 不适用声明）：<https://groups.google.com/a/chromium.org/g/blink-dev/c/ge7xTu-VhJ0>
- MDN viewport meta / interactive-widget：<https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport>
- MDN VirtualKeyboard API：<https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API>
- Chrome VirtualKeyboard 文档：<https://developer.chrome.com/docs/web-platform/virtual-keyboard>
- W3C VirtualKeyboard 草案：<https://w3c.github.io/editing/docs/virtualkeyboard/>
- Android windowSoftInputMode：<https://developer.android.com/guide/topics/manifest/activity-element#wsoft>
- BCD 支持数据：<https://github.com/mdn/browser-compat-data>（interactive-widget、api/VirtualKeyboard）

源码：

- Chromium 键盘高度计算：<https://chromium.googlesource.com/chromium/src/+/refs/heads/main/base/android/java/src/org/chromium/base/ui/KeyboardUtils.java>
- Chromium KeyboardVisibilityDelegate：<https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/android/java/src/org/chromium/ui/KeyboardVisibilityDelegate.java>
- telegram-tt 视口处理：<https://github.com/Ajaxy/telegram-tt/blob/master/src/util/windowSize.ts>
- viewport-resize-behavior explainer（bramus，Chrome DevRel）：<https://github.com/bramus/viewport-resize-behavior/blob/main/explainer.md>

Bug tracker：

- crbug 40287394（WebView 视口/VK API）：<https://issues.chromium.org/issues/40287394>
- crbug 40924170（overlays-content 瞬时高度）：<https://issues.chromium.org/issues/40924170>
- crbug 41176235 / 41343106 / 40768751（历史与事件类）：见第三节表格

社区案例（未证实）：

- 微信开放社区三帖、CSDN 两文、知乎 WeType bug 汇总、code-server #7149、
  PWABuilder #2572 —— 链接见第二、三节行内。
