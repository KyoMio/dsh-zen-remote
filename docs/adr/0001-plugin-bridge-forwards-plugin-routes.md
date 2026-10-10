# 插件桥转发插件自己的 HTTP 接口，主服务端以本机回环请求执行

远程会话里要显示其他插件的面板时，插件桥不转发界面、也不定义统一的数据模型，而是把插件自己注册在 DSH webServer 上的接口请求，从子客户端改道到主服务端：子客户端在本机后台的路由查找处改道（覆盖 fetch、EventSource、iframe、Worker 等一切到达后台的 HTTP），主服务端校验会话共享后，以本机回环 HTTP 请求自己的插件接口。理由：面板界面两端同版本已经有，插件接口也已经存在，zen-remote 只需决定「请求在哪台机器执行」；回环请求让插件自己的鉴权与 handler 原样生效，不必伪造 node 的 req/res。

## Considered Options

- 包装浏览器的 `window.fetch`：漏掉 iframe、Worker、EventSource 发出的请求。
- 主服务端进程内直接调插件 handler：插件 handler 是 node req/res 签名且自查 Host 与 cookie，伪造 IncomingMessage 比回环脆弱。
- 定义统一的插件数据模型、让插件把数据推给 zen-remote：要求每个插件重写数据层，第三方插件无法接入。

## Consequences

- 协作插件只需登记接口清单，并在网址参数里带会话 id；不需要依赖 zen-remote 的代码。
- 不配合的第三方插件只能由 zen-remote 内部按确切版本编写可移除的适配器，负责请求与响应里会话 id 的改写。
- 子客户端的改道依赖宿主 webServer 的内部结构（路由查找方法、路由表），与 typertGateway、fetchRoutes 的包装同属「依赖 DSH 内部」的一类，需要形态检测。
