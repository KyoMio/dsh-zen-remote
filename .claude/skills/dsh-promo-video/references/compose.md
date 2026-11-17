# 合成、配乐、出片、封面、笔记

## 准备新目录

从上一版目录复制 `video.html`、`cover.html`、`render.mjs`、`encode.swift`、`mix.sh`、`check-layout.mjs`、`package.json`、`audio/make_bgm.py`。`node_modules` 用软链指向 `../zen-remote-2.0/node_modules`（playwright-core）。系统依赖：Chrome、ffmpeg（`/opt/homebrew/bin`）、swift、python3（numpy / scipy / matplotlib / PIL）。

## video.html

画布 1080×1920。视觉系统沿用上一版，不重新设计：网格背景与两团柔光、顶部插件名胶囊、每镜两行大字（重点词蓝色加底色）、设备标签胶囊、窗口外框、蓝色圈注、标注胶囊、光标与点击涟漪、收尾的设备外框。

- **时间轴**：`HL` 数组是每镜大字的起止秒，镜头切换落在小节线上。`render(t)` 按时间分段，各镜互不干扰。
- **镜头**：`CAM` 关键帧 `{t, cx, cy, z, vh}` 用截图坐标（CSS 像素），相邻帧之间缓动；`toCanvas(x, y)` 把截图坐标换算到画布。`vh` 是窗口可视高度，按内容收紧，空白太大就调小。
- **切图**：`.cap` 图层叠在同一个视口里，`only(id)` 切换。打字效果用下一张截图加 `clip-path: inset(...)` 逐步露出；终端里的打字用白色遮罩块逐步缩短。
- **标注**：圈注一律从 `BOXES` 的实测坐标算（`ringCap` 用截图坐标，`ringCanvas` 用画布坐标）。标注胶囊放在被圈元素旁的空白处，不压住卡片里的文字。
- **设置页卡片**：从 3 倍截图裁局部，`K = {x, y, s, top}` 描述截图到卡片的映射，`cardBox(K, box)` 换算框位置。
- **安全区**：顶部约 190 px 是小红书作者栏，底部约 460 px 是标题与点赞栏，文字和标注都避开。`?guides=1` 显示安全区示意。
- **impeccable 检测**：会报 `low-contrast`（浅灰字）和 `dark-glow`（蓝色光晕）。浅灰已定为 `--ink-3: #687080`；光晕是沿用的视频风格，按文件加窄范围忽略：
  `plugins/dsh-impeccable/skills/impeccable/scripts/impeccable hooks ignore-value dark-glow "*" --file promo/<目录>/video.html --reason "..."`。

预览：浏览器打开 `video.html?t=12.5` 定格；或 `node render.mjs video.html --still 12.5 out/still.png`。

## 版面自检

`node check-layout.mjs` 每 0.1 秒检查一次：标注出画、压到底部安全区、标注压到大字、两个胶囊互相重叠、圈注落在所有窗口和卡片之外。必须输出 `no issues`。

几何自检看不出内容问题，再抽 6–8 个关键时刻的帧，缩到 540 宽逐张看：圈注是否圈住目标、窗口里有没有大片空白、文字是否被遮挡。

## 配乐 audio/make_bgm.py

纯 numpy / scipy 合成，固定随机种子，可复现；文件顶部是全部参数。每版至少换掉：

- **节拍与段落**：BPM、`N`（总长 36 秒）、`SECTIONS`、`GROOVE_BARS`、`FINAL_BAR`，各段要和镜头对齐。安全那类信息量大的镜头配 breakdown，音乐让位。
- **调式与和声**：`PROG`、`CHORDS`、`PAD_VOICING`、`BASS_ROOT`、`ARP_TONES`、旋律 `MOTIF` / `ANSWER` / `CADENCE`。
- **音色**：在 `render_stems()` 里换声部组合。2.0 用了 pad、底鼓、拍手；2.2 用了电钢琴、刷鼓、沙锤。

各声部按 BS.1770 响度分别定标（顶部的 `*_LU`），母带归一到 −16 LUFS，真峰值上限 −1.3 dBFS。脚本运行时会打印各段的 RMS 和响度。三个音效（click / pop / whoosh）由同一脚本生成。

## 出片

```bash
node check-layout.mjs && node render.mjs video.html out/<名>-silent.mp4 30 && sh mix.sh
```

- `render.mjs` 逐帧截图，再交 `encode.swift` 编码，36 秒约 2.5 分钟，用后台任务跑。重跑后 `out/` 里可能残留 `*.sb-*` 临时文件，删掉即可。
- `mix.sh` 的音效列表 `"<音效> <秒> <音量>"` 要和 `video.html` 里的动作时刻一一对应：转场用 whoosh，点击用 click，保存、提交成功、状态出现用 pop。
- 核对成片：
  - `ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,duration -of compact out/<名>.mp4`
  - `ffmpeg -nostats -i out/<名>.mp4 -af ebur128=peak=true -f null - 2>&1 | grep -E "I:|Peak:"`
- 分镜总览：从成片抽约 14 帧，用 PIL 拼成两行，存为 `out/storyboard.png`。

## 封面 cover.html

画布 1080×1440，渲染命令：`node render.mjs cover.html --still 0 out/cover-3x4.png --size 1080x1440`。

版式沿用上一版：
- **顶部**：插件名与版本胶囊、150 px 大字、副标题、一排 3–4 个关键词胶囊。
- **中部**：设备外框里放真实截图。下方一块放大镜头，从同一张截图裁局部，用虚线连回屏幕原位置，屏幕和放大镜头里都画圈注。
- **底部**：一行等宽信息条。
- **右上角留空**：信息流会在那里叠播放图标。

副标题与视频主打一致；放大的局部要选最能证明主打的那一处。

## 笔记 小红书笔记.md

- **标题**：3 个候选，每个不超过 20 字，推荐第一个，与封面副标题呼应。
- **正文**：开头一段概述，接着用 `📌 小标题` 逐个讲功能，然后是安全设计（写明开启后等于授予什么权限）、安装与升级（插件市场、「插件」页添加、两端版本要求、适配的 DSH 版本、开源协议），末尾注明「视频中的界面均为真实运行截图，会话内容为演示数据」和话题标签。
- **只写实测过的功能**：拍摄中发现不工作的功能，正文里一律不提。
- **评论区置顶**：仓库地址，加上相关文档。
- **发布前确认**：README 里过时的说法、插件市场里的简介、未修的 bug、封面上传哪个文件。
