# 桥接声明 v2：定位器/前缀/远程拒绝/响应改写进协作协议

状态：Proposed（2026-10-28）

## Context

协作声明（ADR 0001 / PB-1）要求浏览器的请求把会话 id 放在 **query 参数**、路径 **完全相等** 匹配、**GET 起步**（2.2 加 `methods`/`maxBody`/`upgrade`）。像 dsh-better-sidebar 这类面板插件的实际形状是：会话 id 在 **JSON body 顶层**（`sessionId`/`childId`）或**前缀路由的路径段**里、媒体/上传路由是**前缀注册**、`sidechat.start` 的响应里返回**服务端真实会话 id**（浏览器拿去发后续请求会被判本地，链路断裂）、还有个别方法（`open.external`）在远程会话**必须拒绝而不能落本机**。这些能力适配器框架（PB-11 `plugin-adapter-core.ts`）全部已有——定位器三形态、前缀匹配、deny 钩子、响应改写——但只给 zen-remote 内部适配器用，第三方插件想协作接入就得改自己的客户端代码，协作路线对这类插件事实上不可用。

## Decision

把适配器框架已有的四类能力以**声明字段**的形式暴露进 `BridgeRoute`，全部可选、**显式声明才进摘要**（与 `methods`/`maxBody`/`upgrade` 同一条兼容规则，2.1/2.2 时代的声明摘要逐位不变）：

| 新字段 | 形状 | 语义 |
| --- | --- | --- |
| `locator` | `{ in:'query', name } \| { in:'path-segment', index } \| { in:'json-body', fields }` | 会话 id 的位置，替代/泛化 `sessionParam`（无 `locator` 时 `sessionParam` 语义原样保留；两者同写校验报错）。`path-segment` 仅允许配 `prefix` |
| `prefix` | `true` | 前缀匹配：相等或恰深一段，RAW 未解码路径名，与适配器同一条 `adapterPathMatches` 规则 |
| `deny` | `true` | 远程会话中命中该路由一律统一 503（reason `route-denied`），绝不落本机——声明式的 `open.external` 保险 |
| `rewriteIds` | `true` | 响应 JSON（缓冲上限 8 MB，同适配器）**深扫**：凡是等于本机已知真实会话 id 的字符串，换成其虚拟形态；未知字符串原样过 |

关键取舍：

- **`rewriteIds` 是深扫而非按字段声明**。这是 tasks/plugin-bridge/todo.md 里在案 BUG 的直接教训：better-sidebar 的 `/sidebar/api` 响应带 `{ok, value:{…}}` 信封，适配器按"顶层字段"改写全部落空（真实 `childId` 漏给浏览器，远程侧聊断裂）。按字段声明改写会重演同一个坑；"等于已知真实 id 才改"两个方向都安全（未知串原样过=不会误改，已知真实 id 必改=不会漏改）。
- **服务端 `/v1/plugin` 协作链同步扩**：路径校验从完全相等改为同一条前缀规则（纵深防御，与子客户端同一判定）；`deny` 是纯客户端判定，服务端不感知。
- **摘要与握手零变化**：`compareBridges`/`plugins` 握手字段把摘要当不透明串比对，新旧混合只是"两端版本不一致"退回未桥接，与适配器现状相同。两端都升到新版才有 v2 能力，文档写明。
- **`maxBody` 上限维持 64 MiB**：better-sidebar 的 500 MiB 媒体上传路由暂不进协作面（该路由可继续留在适配器里或暂不桥接）；放开上限涉及整机同意墙的强度问题，单独立项再议。

## Consequences

- 第三方面板插件不改客户端代码即可协作接入（声明 ~30 行），zen-remote 撤掉对应适配器只是时间问题。
- `plugin-route-intercept.ts` 的协作 surrogate 与适配器 surrogate 在定位/分类/改写三步上**复用同一套 `plugin-adapter-core` 纯函数**（`locateAdapterIds` / `classifyAdapterRequest` / `rewriteAdapterRequest`），两半不各写一份。
- 子客户端需要一张"已知真实会话 id → 虚拟形态"的活表供 `rewriteIds` 查询——中继客户端本就维护共享会话映射，新增的是把它暴露给插件改道层的一个只读接缝。
- 旧版 zen-remote 端遇到 v2 字段会按 unknown-field 拒绝登记（typo guard），表现为普通的版本不一致退避，无需迁移逻辑。
