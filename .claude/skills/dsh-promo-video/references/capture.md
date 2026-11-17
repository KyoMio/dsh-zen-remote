# 拍素材：隔离 DSH 实例与截图

模板：`promo/zen-remote-2.2/work/`（实例与演示仓库）和 `promo/zen-remote-2.2/capture-scripts/`（脚本）。新一版复制 `capture-scripts/` 后，先改 `lib.mjs` 顶部的 `W` / `CAP` 路径。

## 起实例

1. **CLI**：装和桌面端 App 同版本的 DSH 到 `work/cli`（版本用 `plutil -extract CFBundleShortVersionString raw "/Applications/DeepSeek Harness.app/Contents/Info.plist"` 查）。npm 必须用 nvm 那套：
   `~/.nvm/versions/node/v25.8.0/bin/npm i @deepseek-ai/dsh@<版本>`。
2. **启动器 `work/run.sh`**：`env -i` 清空环境，只给 PATH、`HOME=work/<host|client>`、LANG、`DEEPSEEK_API_KEY=mock-not-a-real-key`。
   DSH 会话里的 shell 继承了 `DSH_HOME`、`DSH_PROFILE` 等变量，只改 HOME 会读到用户真实的 profile。
3. **装插件**：`sh run.sh host plugin --profile promohost add <插件>@<版本> …`，client 同理（`promoclient`）。装完在两个 profile 的 `package.json` 的 `dsh.profile.bundles` 第二位补 `@deepseek-ai/dsh-web-app`，与真实 profile 一致。
4. **配置**：写 `work/<role>/.dsh/profiles/<profile>/cordis.patch.yml`：
   - zen-remote：`role`、`serverName`（演示名 Mac mini / MacBook Pro）、`port: 3397`、`host`；插件桥同意写 `pluginBridgeConsent`。
   - 模型路由指向本地假模型：`- id: llm-deepseek` / `config: { baseURL: http://127.0.0.1:3399/anthropic, thinking: disabled }`。
5. **启动**：`sh run.sh host --profile promohost --no-open --port 3391 > host.log`，client 用 3392，都用后台任务。登录 URL 从日志的 `dsh web:` 一行取（`lib.mjs` 的 `url()`）。
6. **终端提示符**：`work/host/.zshrc` 写 `PROMPT='%F{green}mac-mini%f %F{blue}%1~%f %# '`，截图里不暴露真实主机名。

## 演示数据

- **演示仓库**：`work/demo/<项目>`（主服务端）、`work/demo-mbp/<项目>`（子客户端），`git init` 后用 `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` 造几条历史提交，工作区留好开拍时需要的改动。
- **工作区与会话**：`node seed.mjs <role> <仓库路径> - <会话标题…>`，经 typert 接口 `workspace/create`（路径必须是绝对路径，脚本已 `path.resolve`）、`session/create`、`session/rename`。
- **对话内容**：停掉实例后 `node append-turns.mjs work/<role>/.dsh`，按标题把 `SCRIPTS` 里写好的对话追加进会话日志（zstd 分帧；首帧只放会话头）。再启动，`node warm.mjs <role> <工作区名>` 逐个打开会话；不预热的话子客户端远程分组里标题显示「未命名」。
- **需要模型真回答的流程**（侧聊等）：`node mock-llm.mjs 3399` 起本地假模型（Anthropic Messages 流式格式，回放固定回答）。全程不连真实模型、不配真实密钥。
- **每拍一条前复位**：拍编辑、提交之类会改仓库的镜头，重拍前 `git reset --soft HEAD~1 && git reset && git checkout <文件>` 回到开拍状态。

## 配对与共享（zen-remote）

- **同机配对必须用局域网 IP**：回环直连不校验设备令牌，演示不真实。所以主服务端网关 `host: 0.0.0.0` 只在拍摄期间打开，拍完立刻改回 `127.0.0.1`。
- `node pair-ui.mjs`：主服务端 `revoke-all`、生成 `desktop-client` 配对码，在子客户端设置页填 `http://<局域网 IP>:3397` 完成配对。
- `node share.mjs <会话 id…>`：经 `POST /_dsh/zen-remote/admin/shares` 开启远程。
- **插件桥同意**：设置页截图里点「允许转发整机数据」再「保存」（`cap-hsettings.mjs`）。

## 截图

- **浏览器**：Playwright（`promo/zen-remote-2.0/node_modules/playwright-core`，`channel: 'chrome'`），视口 1440×900，`deviceScaleFactor: 3`，`locale: zh-CN`，亮色。
- **浏览器 profile 分开**：每个持久化 profile 目录名各不相同（`client-final`、`client-t1`…）。DSH 把右侧栏的标签布局按会话存在 localStorage，旧 profile 会带着上次的标签，正式拍摄前删掉 `work/shots/pw-<名>` 重来。
- **交互探查**：`node ex.mjs <role[:profile]> <会话标题> '<动作 JSON>'` 逐步点、输、截图、dump 文本。动作清单写在脚本头部注释里，先用它摸清界面再写正式拍摄脚本。
- **截图前**：调用 `lib.mjs` 的 `tidy()`，把本机路径、IP 换成演示值（`~/projects`、`192.168.1.10:3088`）。
- **坐标**：圈注要用的元素在截图同一时刻记录坐标（CSS 像素）。文字用 Range 取紧贴矩形（`cap-main.mjs` 的 `tbox`），控件用 `boundingBox()`，写进 `captures/boxes-<段>.json`；合成前合并成 `captures/boxes.js`（`window.BOXES = {...}`）。**垂直居中弹窗注意**：向导/设置弹窗用了 `align-items: center`，展开新区块（如生成二维码面板、成功提示条）后弹窗变高、顶部上移，上方元素（如步骤条、三盏状态灯）的 `y` 坐标会跟着上移——必须在对应那张截图的同一状态重新 `boundingBox()`，不能复用展开前的坐标。
- **相邻两张截图的变化区**：用 PIL `ImageChops.difference` 求变化区域的外接框，可以核对坐标、决定打字动画的裁切范围。

### DSH 0.2 / better-sidebar 0.25 界面的坑

- **右侧栏有多个 `[data-sidebar-right-panel]`**（每个打开过的会话一个），选择器一律加 `.filter({ visible: true })`；在 `page.evaluate` 里先找 `offsetParent !== null` 的那个再打标记。
- **右侧栏新标签**：点「开始」标签，或标签栏的「新标签页」按钮，在启动器里选「文件 / 文件变动 / 新建终端 / 侧边对话(beta)」。「新建终端」要按 role=button 定位，它的文字 span 被按钮盖住。
- **底部面板会自己展开**：先点「折叠底部面板」再开右侧栏。
- **git diff 预览**默认折叠，点变更行后还要点 `›` 才展开出 diff 行。
- **编辑器**是 CodeMirror：点 `.cm-line` 定位后用键盘输入。Markdown 列表行回车会自动续上 `- `，所以在上一行末尾回车，只输内容。
- **同名文字不止一处**（例如 `CHANGELOG.md` 同时出现在标签页和文件树），要用 `:not([role=tab] *)` 排除标签页。

## 已知问题记录

- **zen-remote 2.2.0**：better-sidebar 适配器的响应改写不生效（接口返回 `{ok, value}` 信封），远程侧聊不可用；主服务端重启后冷子会话报 `not-shared`。详情在插件本地的 `tasks/plugin-bridge/todo.md`。修复前不拍侧聊。
- **看图工具**（zai-vision）对 4320×2700 的原图常超时。缩到 ≤720 宽或裁出局部再看；超时就直接用 `read_image` 看图。
