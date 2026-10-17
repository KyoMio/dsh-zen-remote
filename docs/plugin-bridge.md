# 插件桥（给插件作者）

你的插件只要**登记一份桥接声明**，它的面板数据就能在远程会话里照常显示：子客户端把「该插件的某次 GET 请求」改道到主服务端，主服务端用本机回环 HTTP 请求你插件的接口，把响应原样交回浏览器。你不需要依赖 zen-remote 的任何运行时——没装 zen-remote 时，`inject` 永远不触发，你的插件行为与从前完全一致。

什么时候用：你的插件在**会话页**里渲染自己的面板，面板数据来自插件自己注册在 DSH webServer 上的 GET 接口，且数据按会话区分（或明确属于整机数据）。装了 zen-remote 的两台 DSH 之间，远程会话里的面板将取**服务端**的数据，而不是子客户端本机的空数据。

> 术语见 `GLOSSARY.md`：已桥接、桥接声明、整机数据。

## 接入

在插件的 `apply` 里向 zen-remote 登记一份声明，dispose 挂进 `effect`（行卸载时撤下）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeDeclaration, ZenRemoteService } from 'dsh-zen-remote'

export function apply(ctx: Context) {
  ctx.inject(['zenRemote'], (c) => {
    const bridge: ZenRemoteService = c.zenRemote
    const declaration: BridgeDeclaration = {
      plugin: '@scope/my-plugin',       // 必须与 package.json 的 name 一致
      version: '0.2.0',                 // 必须与运行版本一致
      routes: [
        { path: '/my-plugin/session-data', scope: 'session' },
        { path: '/my-plugin/all-tasks', scope: 'server' },
      ],
    }
    const dispose = bridge.bridge(declaration)
    ctx.effect(() => dispose, 'my-plugin: bridge declaration')
  })
}
```

- 类型从主包拿：`import type { BridgeDeclaration, ZenRemoteService } from 'dsh-zen-remote'`。
- 没装 zen-remote：`inject(['zenRemote'])` 不触发，以上代码零影响；装了旧版 zen-remote：同样不触发（服务是 2.1 起提供）。
- 两端都要登记：zen-remote 判定「已桥接」要求**两端插件名、确切版本、声明摘要**一致（声明摘要 = 对规范化声明做 sha256 取 16 位十六进制；路由顺序不影响摘要，任何字段值影响）。两端不一致时面板拿到 503（见下文），不会落到本机数据。

## 声明字段表

`BridgeDeclaration = { plugin, version, routes }`，校验失败登记时直接抛错：

| 字段 | 规则 |
| --- | --- |
| `plugin` | 非空字符串；npm 包名形状（允许 `@scope/name`，全小写）；长度 ≤ 214 |
| `version` | 非空字符串（原样比较，不做 semver 解析） |
| `routes` | 非空数组，最多 64 条 |

每条 `BridgeRoute`：

| 字段 | 规则 |
| --- | --- |
| `path` | 以 `/` 开头；不含 `?`、`#`、`..`、空白；**不得**以 `/_dsh/` 或 `/api` 开头（宿主与 zen-remote 自己的前缀不能被桥接）；同一声明内不得重复 |
| `scope` | 必填，只能是 `'session'`（数据属于单个会话）或 `'server'`（整机数据，需主服务端主人逐插件同意） |
| `sessionParam` | 可选，缺省 `'sessionId'`；须匹配 `/^[A-Za-z][A-Za-z0-9_]{0,63}$/`——你的接口用别的名字接会话 id 时在这里声明 |
| `stream` | 可选，缺省 `false`；标记该路由以流式响应回答 |
| `methods` | 可选，缺省 `['GET']`；大写 HTTP 方法数组，只接受 `GET`、`HEAD`、`POST`、`PUT`、`PATCH`、`DELETE`，去重并按字典序排序后进规范化与摘要（2.2 起，写请求） |
| `maxBody` | 可选，缺省 `1048576`（1 MiB）；请求体上限（字节），正整数，最高 64 MiB（2.2 起） |
| `upgrade` | 可选；置 `true` 标记该路由是 WebSocket 升级端点，远程会话里经字节隧道转发（2.2 起，见下文「WebSocket 路由」）。只能为 `true` 或省略；不能与 `stream` 同用；升级路由只有 GET——显式 `methods` 里出现其他方法登记即报错 |

声明里出现未知字段直接报错（防拼错）。`methods`、`maxBody` 与 `upgrade` 只在**显式给出**时进摘要——2.1 时代（没有这三个字段）的声明，摘要与当年完全一致，升级不破坏已桥接状态。2.1 只匹配 **exact 路径**：声明的 `path` 与请求 pathname 完全相等才算命中，把 `path` 写成前缀不会覆盖子路径。

## 你的插件要守的约定

- **请求 query 带当前会话 id**：浏览器侧对 `scope:'session'` 路由的请求必须带 `sessionParam`（缺省 `sessionId`）参数；改道时 zen-remote 靠它找回真实会话 id。没有该参数的请求不算远程请求，会落到本机。
- **服务端按会话 id 解析上下文，不信客户端路径**：同一份面板代码在两台机器上各有一个实例，你的接口拿到的会话 id 永远是**服务端**的会话；不要假设「请求来自本机浏览器」。
- **响应不改写**：响应体原样交回浏览器。不要在响应里携带自己的本机地址或让浏览器再拿响应里的会话 id 去发第二个请求——第二个请求是否改道由它自己的参数决定，跨请求拼链路是远程面板最常见的坏法。
- **侧切换重开流**：`scope:'session'` 的流式响应绑定当前会话；用户把面板切到另一个会话时重新发起请求，不要复用旧流。

## 未桥接时浏览器看到什么

远程会话里、声明命中的路由上，任何导致「无法转发」的情形都回答**同一个 503 形状**，且**绝不落到本机插件**（本机数据不会混进远程会话）：

```
HTTP/1.1 503
x-zen-remote: unbridged
content-type: application/json; charset=utf-8

{"ok":false,"error":{"code":"zr-plugin-unbridged","reason":"<reason>","plugin":"<插件名>"}}
```

`reason` 的全部取值：

| reason | 含义 |
| --- | --- |
| `not-on-server` | 服务端没登记这个插件 |
| `version-mismatch` | 两端版本不同（升级某端后未重启行） |
| `declaration-mismatch` | 版本相同但声明摘要不同 |
| `consent-off` | 声明含 `scope:'server'` 路由，且主服务端主人未同意（设置页「插件桥」里逐插件打开） |
| `offline` | 中继离线（或传输失败） |
| `server-too-old` | 服务端 zen-remote 过旧，握手没有插件表 |
| `server-changed` | 会话 id 指向另一台服务端（切换服务端后页面未刷新） |
| `bad-query` | 会话参数重复，或虚拟会话 id 解析失败（浏览器侧缺失 / 为空的请求走本地放行，到不了 503） |
| `method-not-bridged` | 请求方法不在该路由声明的 `methods` 内（未声明即只转发 GET） |
| `not-shared` / `busy` / `plugin-unknown` / `plugin-mismatch` / `route-undeclared` / `loopback-auth` / `internal` | 服务端中继路由的对应拒绝原样透传（会话未共享 / 该设备并发超限 / 服务端无此登记 / 版本或摘要不符 / 路径未声明 / 服务端回环鉴权失败 / 服务端内部错误） |

## 限制

- 2.1 只转发 **GET**；2.2 起路由可声明 `methods` 开放写方法（POST 等），请求体经中继流式转发，受该路由 `maxBody` 约束（缺省 1 MiB）——超限在本地即回答 413，不落本机、不到服务端。
- 只匹配 **exact 路径**；前缀声明不生效。

## WebSocket 路由（2.2 起）

路由声明 `upgrade: true` 后即成为 WebSocket 升级端点：远程会话里浏览器对该路径的 `new WebSocket(...)` 由子客户端本机接住，经中继的**字节隧道**接到服务端本机插件——升级请求头（`sec-websocket-key` / `sec-websocket-version`，及可选的 `sec-websocket-protocol` / `sec-websocket-extensions`）与双向字节各自**原样搬运，两端都不解析 WebSocket 帧**：101 响应、每个帧、关闭字节都是不透明字节，真正的握手由插件路由在服务端本机完成。三路由的协议形状见 `docs/remote-access.md` 的「插件桥」一节；决策记录见 `docs/adr/0002`。

浏览器侧没有新接口：拿到的仍是原生 `WebSocket`，感知不到隧道。升级无法转发时（未桥接、会话不可达等原因）浏览器看到的就是一次握手失败——子客户端在 socket 上回答与 HTTP 改道相同的 503 `zr-plugin-unbridged` 形状（reason 取值见上表），表现为 `error` / `close` 事件。

限制：

- 声明侧：`upgrade` 只能为 `true` 或省略，不能与 `stream` 同用，升级路由只有 GET（见字段表）；
- 上行字节按最大 64 KiB 分块、严格按序转发（服务端按序号把关，乱序即断）；下行字节每行最多 48 KiB，走一条 NDJSON 流；
- 每设备并发隧道上限 8；
- 隧道随浏览器 socket 断开即关闭；服务端一侧的字节流断掉时浏览器 socket 直接切断——字节隧道不代拟关闭帧，插件自己发的关闭字节（若有）已作为数据先行到达。

相关阅读：主服务端一侧的路由协议见 `docs/remote-access.md` 的「插件桥」小节；设置页的同意开关与状态文案见 `docs/interface.md`。

## 适配器（zen-remote 内部）

协作声明是插件作者对自己的接口登记；**适配器**是 zen-remote 为**不配合的第三方插件**写的内部转发模块，按目标插件的**确切版本**编写，负责把该插件请求与响应里的会话 id 在两端改写（术语见 `GLOSSARY.md` 的「适配器」）。它不是对外接口：插件作者不需要、也无法登记适配器；适配器随 zen-remote 本体分发，整块可移除（`src/adapters/` 目录删掉后，其余功能一字不改照常工作，由 `test/adapters-pluggable.test.cjs` 钉住）。

一个适配器声明三类信息：

- **路由与定位**：每条路由给 `path`（exact 或前缀匹配）、可转发的方法与体上限，以及 `locator`——会话 id 在请求里的位置（query 参数 / 前缀后的路径段 / JSON 体顶层字段）。`local: true` 的前缀（如静态资源）永远留本机，不参与改道。
- **远程判定**：定位到的会话 id 全是 `zr~` 虚拟 id → 远程转发；全不是（或一个都没定位到）→ 本地放行；**混合 → 503 `bad-query`**，绝不落本机。
- **两个钩子（可选）**：子客户端侧 `client.request`（拒绝或改写 JSON 体，如在转发前拒绝 `open.external`）与 `client.response`（把响应里的真实会话 id 换回虚拟 id，JSON 响应缓冲上限 8 MB，超限原样直通）；主服务端侧 `server.request`（回环前拒绝或剥字段，如剥掉 `cwd`）。

登记规则：适配器按宿主 `pluginPackages` 服务探测目标插件的**已装版本**，版本不在适配器声明的版本清单里就不登记；登记进与协作声明同一张注册表（版本 = 已装版本，摘要 = 适配器路由表的规范化哈希），握手同一个 `plugins` 字段，整机数据的同意开关逐插件生效（默认关，设置页条目标注「由 zen-remote 适配」）。若某插件既有适配器、自己又登记了协作声明，**以插件自己的声明为准**（适配器让位，记一条日志）。

## 开发一个适配器

先确认目标插件真的需要适配器：能让作者加几行 `zenRemote.bridge(...)` 就优先走协作声明——适配器只在第三方插件不配合时使用。当前唯一在册的适配器是 **`dsh-better-sidebar`（0.25.0、0.26.0、0.26.1 与 0.28.0-alpha.0 四版）**（`src/adapters/dsh-better-sidebar/`），新适配器照它写。

步骤：

1. **摸清接口面**：读目标插件的构建产物（`~/.dsh/profiles/<profile>/node_modules/<包>/lib/`），列出全部 HTTP 路由与 WebSocket：每个路由的方法、会话 id 在哪个字段（query / 路径段 / JSON 体）、读还是写、响应里有没有会话 id、有没有不带会话字段的调用。每个结论带行号。带会话 id 的请求体会不会另外携带本机路径（如 `cwd`）也要核实——主服务端要按会话自己解析，客户端传来的路径必须剥掉。
2. **写适配器**：`src/adapters/<插件名>/` 一个目录，`versions` 只写核对过的确切版本；路由表里**表外方法一律拒绝**（宁可少转发，不可误转发）；需要在「无会话字段」的情况下按当前会话拒绝的入口（如 better-sidebar 的 `open.external`）用 `deny` 钩子 + 浏览器上报的当前会话信号。适配器一律按整机数据对待（主人逐插件同意，默认关）。
3. **登记**：`src/adapters/index.ts` 的 `ADAPTERS` 加一行，这是整个目录与框架之间的唯一接线。
4. **测试**：方法表与目标插件源码集合的对照测试（源码缺失时 skip）、每种定位的改写、响应改写、版本漂移不登记、e2e 至少读写各一条全链路。可插拔的静态扫描与空表回归由 `test/adapters-pluggable.test.cjs` 自动覆盖新适配器。
5. **文档**：两份 README 的兼容清单、`docs/interface.md`、安全边界（整机数据时写明等于什么权限）同步更新。

路由匹配：协作声明只支持 **exact 路径**；适配器路由额外支持**前缀匹配**（`match: 'prefix'`，会话 id 在路径段时按段定位）。
