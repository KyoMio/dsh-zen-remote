/**
 * better-sidebar 0.25.0 的 `/sidebar/api` 方法表（PB-12）——适配器唯一
 * 认识的接口清单，逐条对着 `/tmp/bs-versions/0.25.0/lib/index.js` 复核
 * （行号见各条注释，以 0.25.0 的构建产物为准）。表里没有的方法在远程
 * 会话里一律拒绝（reason `adapter-method-unknown`）：宁可少转发，不可
 * 误转发——`test/adapter-better-sidebar.test.cjs` 会把源码里的实际方法
 * 名集合提取出来与这张表逐一比对，防止插件升级后漏记。
 *
 * 会话字段：绝大多数方法在 JSON 体顶层带 `sessionId`（client.js 的
 * scopePayload，lib/client.js:3866）；子代理与工作流面板带
 * `rootSessionId`；sidechat 的后续调用带 `childId`（本单一律拒绝）。
 *
 * 响应里带会话 id 的位置（核实于 0.25.0 源码，全部只有三处）：
 *  - `session.cwd` 把请求的 `sessionId` 原样回显（lib/index.js:6327）；
 *  - `subagents.live` 的响应以会话 id 为键（lib/index.js:4513
 *    `live[sessionId] = view`，根会话与全部子会话）；
 *  - `workflows.list` 的每行 `originSessionId`（lib/index.js:4666）与
 *    `phases[].members[].childId`（lib/index.js:4686）。
 * `teams.taskCreate`/`taskUpdate` 的响应是 `{ok, value:<任务记录>}`
 * （lib/index.js:4607-4612、4650-4655），任务记录不带会话 id；
 * `changes.ops` 返回 `{events, lastSeq}`，事件属于该会话自身的流
 * （tool/call、tool/result），对象上没有会话 id 字段；
 * `archive.build` 返回 `{id, entries}`（lib/index.js:3470-3473）、
 * `archive.status` 返回 `{state, done, total, bytes, error?}`
 * （lib/index.js:3479-3485）——都不带会话 id。这四类不改写。
 * `sidechat.start` 返回 `{childId}`（lib/index.js:5050）——PB-13 起
 * 虚拟化（子客户端拿它发后续调用）。
 */
/** 响应改写器的上下文（框架的 AdapterResponseContext 的结构性子集）。 */
export interface SidebarRewriteContext {
    virtualize(id: string): string;
    isVirtual(value: unknown): boolean;
}
/** 一个 `/sidebar/api` 方法的处置。 */
export interface SidebarMethodSpec {
    /** 该方法在 JSON 体顶层的会话字段名（settings.* 无会话字段，缺省）。 */
    sessionField?: 'sessionId' | 'rootSessionId' | 'childId';
    /** 读还是写（写方法在远程会话里执行的是主服务端的磁盘与 git）。 */
    kind: 'read' | 'write';
    /** 无会话数据的方法（settings.*）：定位结果为空，天然留本机。 */
    local?: true;
    /** 响应改写器：把响应里的真实会话 id 换回虚拟 id。 */
    rewrite?: (body: unknown, ctx: SidebarRewriteContext) => unknown;
}
/** 0.25.0 的全部方法。 */
export declare const SIDEBAR_METHODS: Readonly<Record<string, SidebarMethodSpec>>;
/** `/sidebar/api` 的路径前缀（方法名跟在后面，lib/index.js:6888）。 */
export declare const SIDEBAR_API_PREFIX = "/sidebar/api/";
/** 从请求 pathname 取出 API 方法名（`/sidebar/api/fs.tree` → `fs.tree`）。 */
export declare function sidebarMethodNameOf(pathname: string): string | undefined;
//# sourceMappingURL=methods.d.ts.map