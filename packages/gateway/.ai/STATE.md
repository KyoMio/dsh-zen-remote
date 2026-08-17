# STATE.md · dsh-mobile-pwa

<!-- 阶段：stage / 当前任务 task / 状态 status / 下一步 next -->

- **stage**: `rework/public-auth-push（fork KyoMio/dsh-mobile-pwa）· v0.2.0 已实机验收、合并 main`
- **task**: 公网部署改造：配对码 + 设备令牌认证、反代对接（X-Forwarded-*）、真 Web Push（VAPID + aes128gcm）
- **status**: `已发布：16 用例全绿 · 实机验收通过（Lucky 反代 + 手机配对 + dshmarket 经网关操作正常）`
- **本轮改动**（细节见 docs/spec-public-auth-push.md + .ai/DECISIONS.md rework 一节）:
  - 认证：废除按 IP 审批 / LAN 直通 / ?t= URL 令牌；配对码（一次性、10 分钟、5 错锁 15 分钟）→ lg_device Cookie；管理面仅本机直连
  - 网络：默认监听 127.0.0.1，信任回环/白名单反代的 X-Forwarded-For/Proto；修复 chunked+Content-Length、连接毒化、gzip 注入损坏三个代理层 bug
  - 推送：web-push 依赖（放弃零依赖）、VAPID 持久化、订阅要求已配对设备并设上限、404/410 自动清理、通知不带对话正文
  - 宿主插件 dsh-push.mjs：零注入、事件名 DSH_PUSH_EVENTS 可配、去抖
- **next**:
  1. 用户侧：配反代（README 有 nginx/Caddy 模板）→ 实机安装 → 手机配对 → PWA 安装 + 推送验收
  2. ~~事件名核对~~ 已定：`agent/turn-stopping`（官方 docs/subsystems/core + scoped-events catalog 证实，每回合关闭前触发一次）
  3. 验收通过后合回 main、打 tag、考虑发 npm 或给上游提 PR
