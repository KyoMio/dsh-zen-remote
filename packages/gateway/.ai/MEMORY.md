# MEMORY.md · 已验证事实（只记跑过/确认过的）

- DSH 客户端插件基于 Cordis，装法 `dsh plugin --profile web add <dir>`，manifest 字段 `dsh.bundle.patch`。
- 官方仓库 `deepseek-ai/deepseek-harness` 定位 "Everything is a Plugin"，约 10 万 star。
- 参考基座 `dsh-mobile-gate`（Bernardxu123, MIT）：独立子进程网关、首次审批+一次性令牌+每IP限流、HTML 注入。
- 生态缺口：社区移动端都只是窄屏 CSS 微调，无完整 PWA 方案 → 差异化空间确认。
- 网关零依赖单文件 CJS；`pwa/` 资产由网关注入/供出；SW 固定路径 `/pwa/sw.js`。
- 冒烟测试 3 项全通过（资产、注入、状态）。日期按本 session。
- DSH CLI 官方禁止 `--host 0.0.0.0`（/api 无认证），必须走网关做远程访问。
