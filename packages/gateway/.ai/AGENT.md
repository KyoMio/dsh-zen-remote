# dsh-mobile-pwa · AI Project OS 落地

> 本目录（`.ai/`）采用项目主人指定的「AI Project OS V2」体系：新 AI 先读本文件，老 AI 正常干活；所有任务有证据、有记录、有下一步。

## 一句话总纲
> 主 AI 管全局，子 Agent 干专项；所有任务有证据、有记录、有下一步。
只服务 5 件事：可快速接手、不重复学习、复杂可拆分、有证据才算完成、阶段结束必有下一步。

## 项目三个铁律
1. **网关隔离**：`lib/lan-gate-server.cjs` 是独立子进程，任何情况下不得 import 进 DSH 主进程。
2. **桌面零影响**：所有移动 CSS 以 `html[data-lan-device="phone"]` 或排除 `desktop` 的 `@media` 为根。
3. **验证靠跑命令贴原始输出**，不靠「声称完成」。

## 接手检查清单（新 AI 必做）
- [ ] `npm test` 全绿（node --test test/*.test.cjs）
- [ ] `node --check` 覆盖 lib + pwa/*.js + *.mjs
- [ ] 读 `AGENTS.md`（本仓库开发约定）
- [ ] 读 `../README.md` 弄清产品定位

## 下一步入口
看 `STATE.md` 的 `next` 字段；复杂任务进展写 `tasks/active.md`。
