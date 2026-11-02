# 更新日志

只记用户可感知的变化；每个 Release 的正文即本文件对应版本段，其下附逐提交
完整列表，见
[GitHub Releases](https://github.com/KyoMio/dsh-zen-remote/releases)（tag 驱动自动生成）。
界面半边的细节叙事另见 [`docs/interface.md`](docs/interface.md) 的「更新日志」一节。

## 2.3.7（2026-11-02）

### 新增

- **远程附件守卫扩展到回形针与粘贴**（issue #49）：此前只有拖拽会把「带子客户端
  本机路径的非图片文件」从宿主的零拷贝捷径里拦下、改走字节上传，现在回形针选择器
  与编辑器粘贴同样命中；拖入 / 粘贴**文件夹**时整批拦下并提示；附带 fetch-route
  懒装重试与卸载守卫。
- **导出诊断信息**：插件设置区块底部一键下载 `zen-remote-debug-<role>-<时间戳>.json`
  （版本与角色 / 配置形态 / 诊断聚合 / host 另含网关摘要 / 近 300 条插件事件），
  两层脱敏（配置按字段名挑选 + 统一脱敏器），可直接附到 GitHub issue；
  经网关打开时拒绝导出，报告只能在本机生成。

### 修复

- **宽幅平板独立 PWA 顶部安全区**（≥1024px：iPad 横屏、12.9/13 吋 iPad 竖屏恰为
  1024、安卓平板）：网关对所有非 desktop 设备注入 `viewport-fit=cover`，但安全区
  补偿止步于 1023px 断点，顶部控件被压进状态栏、难以点按。新增
  `(min-width: 1024px) and (display-mode: standalone)` 双门控规则补齐上下两个安全区
  （锚定官方 AppFrame，`border-box` + `--mnav-sat`/`--mnav-sab`）；桌面浏览器与
  桌面 App 构造性 no-op，≥1024px 桌面逐像素不变的硬约束不受影响。
- **平板 PWA 整页可拖动弹回**：壳级 `overscroll-behavior` 此前只写在 body 且仅
  纵轴，视口级橡皮筋在 768px 以上仍然活着。现 html/body 双写、双向杀掉；
  内部滚动区不受影响，只是边缘滚动不再链到整页。

## 2.3.6（2026-10-31）

- 插件桥：支持 json-body WebSocket 帧的会话 id 定位与改写（`/sidebar/ws/sidechat`）。
- 中继：观察 `agent/created` 的父会话，同步未通告的 sidechat / 子代理摘要。
- 手机端：turn-tail 的 24h 时钟不再折行；信息卡合并 turns / steps 计数并显示 tok/s 速度。

## 2.3.5（2026-10-30）

- turn-fold：纯签名推理步不再留下空行（适配 DSH 0.2.1-rc.5）。
- 安全与维护：新增 SECURITY.md 与 Dependabot（`@deepseek-ai/*` 闭包手动管理）、
  测试以 `vm` 替代 `eval`；中继背压用例改为按余量驻留，修掉 CI 上的两连假失败。

## 2.3.4（2026-10-28）

- 插件桥 v2 声明补全（PB-22 ~ PB-25）：`deny` 路由对一切远程上下文统一 503 拒答；
  `rewriteIds` 新增创建型 `{ fields }` 声明，深扫改写范围扩到「请求自带 ∪ 已知会话
  清单」；路径段 / json-body 定位路由进入协作校验链（逐命中共享校验、请求体体积
  上限、隧道升级前置校验）。

## 2.3.3（2026-10-27）

- 适配 dsh-better-sidebar 0.28.2；接受 DSH 0.2.2-alpha peer 并钉该版本的会话指纹。

## 2.3.2（2026-10-26）

- 发版重跑，无代码变化（仅版本号与 README 徽章）。

## 2.3.1（2026-10-26）

- 配置向导：三步配置向导上线（README 安装 / 向导快速上手重排并配截图）；Caddy
  预编译发行版与国内镜像自动探测、cloudflared / Caddy 的连接与停滞超时、模式切换
  停进程与状态清理；CI 每日预编译 Caddy + cloudflared 全平台产物并自动跟踪上游。
- 安全：网关在 `0.0.0.0` 上拒绝未反代的公网 IP 直连；Caddy / Tunnel 模式把 host
  重置回 `127.0.0.1`。
- Windows：修复 Caddy 裸二进制下载、Cloudflare Tunnel UUID CNAME 校验、向导保存
  CF token 前先切回 host 角色、重命名回退，以及网关 spawn 时绕开 `node.cmd`
  批处理包装。

更早版本（≤ 2.2.9）见 [GitHub Releases](https://github.com/KyoMio/dsh-zen-remote/releases)。
