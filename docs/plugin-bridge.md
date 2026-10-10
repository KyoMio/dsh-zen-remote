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

声明里出现未知字段直接报错（防拼错）。`methods` 与 `maxBody` 只在**显式给出**时进摘要——2.1 时代（没有这两个字段）的声明，摘要与当年完全一致，升级不破坏已桥接状态。2.1 只匹配 **exact 路径**：声明的 `path` 与请求 pathname 完全相等才算命中，把 `path` 写成前缀不会覆盖子路径。

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

## 2.1 的限制

- 2.1 只转发 **GET**；2.2 起路由可声明 `methods` 开放写方法（POST 等），请求体经中继流式转发，受该路由 `maxBody` 约束（缺省 1 MiB）——超限在本地即回答 413，不落本机、不到服务端。
- 只匹配 **exact 路径**；前缀声明不生效。
- WebSocket 不在桥接范围内。已知的插件 WebSocket（如 better-sidebar 的两条）将按中继的既有约定「订阅走流式响应、指令走普通请求」在 2.2 以流式响应加普通请求模拟（见 `docs/adr/0002`），届时再扩展声明字段。

相关阅读：主服务端一侧的路由协议见 `docs/remote-access.md` 的「插件桥」小节；设置页的同意开关与状态文案见 `docs/interface.md`。

## 适配器（zen-remote 内部）

协作声明是插件作者对自己的接口登记；**适配器**是 zen-remote 为**不配合的第三方插件**写的内部转发模块，按目标插件的**确切版本**编写，负责把该插件请求与响应里的会话 id 在两端改写（术语见 `GLOSSARY.md` 的「适配器」）。它不是对外接口：插件作者不需要、也无法登记适配器；适配器随 zen-remote 本体分发，整块可移除（`src/adapters/` 目录删掉后，其余功能一字不改照常工作，由 `test/adapters-pluggable.test.cjs` 钉住）。

一个适配器声明三类信息：

- **路由与定位**：每条路由给 `path`（exact 或前缀匹配）、可转发的方法与体上限，以及 `locator`——会话 id 在请求里的位置（query 参数 / 前缀后的路径段 / JSON 体顶层字段）。`local: true` 的前缀（如静态资源）永远留本机，不参与改道。
- **远程判定**：定位到的会话 id 全是 `zr~` 虚拟 id → 远程转发；全不是（或一个都没定位到）→ 本地放行；**混合 → 503 `bad-query`**，绝不落本机。
- **两个钩子（可选）**：子客户端侧 `client.request`（拒绝或改写 JSON 体，如在转发前拒绝 `open.external`）与 `client.response`（把响应里的真实会话 id 换回虚拟 id，JSON 响应缓冲上限 8 MB，超限原样直通）；主服务端侧 `server.request`（回环前拒绝或剥字段，如剥掉 `cwd`）。

登记规则：适配器按宿主 `pluginPackages` 服务探测目标插件的**已装版本**，版本不在适配器声明的版本清单里就不登记；登记进与协作声明同一张注册表（版本 = 已装版本，摘要 = 适配器路由表的规范化哈希），握手同一个 `plugins` 字段，整机数据的同意开关逐插件生效（默认关，设置页条目标注「由 zen-remote 适配」）。若某插件既有适配器、自己又登记了协作声明，**以插件自己的声明为准**（适配器让位，记一条日志）。

当前 `src/adapters/` 的数组为空；第一个真实适配器（better-sidebar）见后续任务。
