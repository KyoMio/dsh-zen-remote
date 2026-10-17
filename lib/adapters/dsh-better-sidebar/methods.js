/**
 * better-sidebar 0.25.0 + 0.26.0 的 `/sidebar/api` 方法表（PB-12/PB-15）
 * ——适配器唯一认识的接口清单，逐条对着 `/tmp/bs-versions/{0.25.0,
 * 0.26.0}/lib/index.js` 复核（行号见各条注释，未标版本的一律以 0.25.0
 * 的构建产物为准；0.26.0 是 0.25.0 的 JSON-api 超集，除下述三处外形状
 * 不变）。表里没有的方法在远程会话里一律拒绝（reason
 * `adapter-method-unknown`）：宁可少转发，不可误转发——
 * `test/adapter-better-sidebar.test.cjs` 会把两版源码里的实际方法名集合
 * 提取出来求并集，与这张表逐一比对，防止插件升级后漏记。
 *
 * 0.26.0 相对 0.25.0 的差异（本表如何覆盖两版）：
 *  - 新增 `fs.readPage` 与 sidechat 的 `dequeue`/`model`/`models` 三个；
 *  - `fs.write` 从 JSON api 移除，改走新的 `/sidebar/write` HTTP 路由
 *    （内容作纯文本 POST 体，见 index.ts 的路由条目）。表里保留
 *    `fs.write`：0.25.0 的宿主仍从 JSON api 派发它；0.26.0 的客户端
 *    不再调它，登记无害。
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
 *
 * 信封：`/sidebar/api` 的成功响应**全部**是 `{ok:true, value:<handler
 * 返回值>}`（lib/index.js:889-896 的 `writeOk`），上面引用的行号都是
 * handler 层、不是线上形状——响应改写器一律经 `rewriteEnveloped` 先剥
 * 信封再改写再包回去（2026-10-13 修复：sidechat.start 的 childId 曾在
 * 顶层找不到而漏虚拟化，浏览器拿真实 id 发后续调用被判本地、落到子
 * 客户端本机报 session not found）。
 */
/** 剥 `{ok:true, value}` 信封 → 改写 value → 包回去；无信封原样改写。
 *  `writeOk`（lib/index.js:889）给每个 /sidebar/api 成功响应都包了这层。 */
function rewriteEnveloped(body, inner, ctx) {
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        const record = body;
        if (record.ok === true && record.value !== null && typeof record.value === 'object' && !Array.isArray(record.value)) {
            return { ...record, value: inner(record.value, ctx) };
        }
    }
    return inner(body, ctx);
}
/** 无改写的普通转发方法的简写工厂。 */
const forward = (kind, sessionField = 'sessionId') => ({ kind, sessionField });
/** 两版（0.25.0 + 0.26.0）方法名的并集，各条目的处置见上。 */
export const SIDEBAR_METHODS = {
    // ---- 会话（lib/index.js:6319-6333）----
    'session.phase': forward('read'),
    'session.cwd': {
        kind: 'read',
        sessionField: 'sessionId',
        // 请求的 sessionId 原样回显（lib/index.js:6327）。
        rewrite: (body, ctx) => rewriteEnveloped(body, (v) => rewriteTopLevel(v, 'sessionId', ctx), ctx),
    },
    // ---- 文件（lib/index.js:6334-6442）----
    'fs.tree': forward('read'),
    'fs.trees': forward('read'),
    'fs.search': forward('read'),
    'fs.read': forward('read'),
    // 分页读（0.26.0 lib/index.js:7332-7338）：payload 形状同 fs.read 加
    // 顶层 `offset` 数字；响应是文件文本，不带会话 id —— 不改写。
    'fs.readPage': forward('read'),
    // 0.26.0 起从 JSON api 移除（写内容改走 /sidebar/write 路由，见
    // index.ts）；保留给 0.25.0 的宿主——0.26.0 的客户端不再派发它。
    'fs.write': forward('write'),
    'fs.rename': forward('write'),
    'fs.mkdir': forward('write'),
    'fs.createFile': forward('write'),
    'fs.remove': forward('write'),
    // ---- git（lib/index.js:6443-6613）----
    'git.worktrees': forward('read'),
    'git.status': forward('read'),
    'git.diff': forward('read'),
    'git.diff-head': forward('read'),
    'git.branch': forward('read'),
    'git.log': forward('read'),
    // 0.28.0-alpha.0：只读拓扑提交图（lib/index.js:8626），sessionId 定位，响应无会话 id。
    'git.graph': forward('read'),
    'git.commit-diff': forward('read'),
    'git.show': forward('read'),
    'git.blame': forward('read'),
    'git.stage': forward('write'),
    'git.unstage': forward('write'),
    'git.commit': forward('write'),
    'git.push': forward('write'),
    'git.pull': forward('write'),
    'git.checkout': forward('write'),
    'git.discard': forward('write'),
    'git.revert': forward('write'),
    'git.cherry-pick': forward('write'),
    // 提交信息生成：消耗主服务端的模型额度（产品决定：跟随会话，接）。
    'git.suggest-message': forward('write'),
    // 模型目录：sessionId 可选（lib/index.js:6573-6602、6614-6626）。
    'git.commit-model': forward('read'),
    'git.models': forward('read'),
    // ---- 变更流（lib/index.js:6627-6649）----
    // 事件对象属于该会话自身的流，不带会话 id —— 不改写。
    'changes.ops': forward('read'),
    // ---- 子代理 / 工作流 / 团队（lib/index.js:4482-4662、4770-4789）----
    'subagents.live': {
        kind: 'read',
        sessionField: 'rootSessionId',
        // 响应的 live 映射以会话 id 为键（lib/index.js:4513）。
        rewrite: (body, ctx) => rewriteEnveloped(body, rewriteLiveKeys, ctx),
    },
    'workflows.list': {
        kind: 'read',
        sessionField: 'rootSessionId',
        // 每行的 originSessionId（4666）与 members[].childId（4686）。
        rewrite: (body, ctx) => rewriteEnveloped(body, rewriteWorkflowsBody, ctx),
    },
    // 响应是 {ok, value:<任务记录>}，不带会话 id —— 不改写。
    'teams.taskCreate': forward('write', 'rootSessionId'),
    'teams.taskUpdate': forward('write', 'rootSessionId'),
    // ---- 归档（lib/index.js:6663-6686；响应不带会话 id）----
    'archive.build': forward('write'),
    'archive.status': forward('read'),
    // ---- 设置（lib/index.js:6666-6682）----
    // 无会话字段：定位结果为空，远程判定天然放行本机 —— 表里登记只为
    // 文档完整与「未知方法」比对（真实存在，只是不转发）。
    'settings.get': { kind: 'read', local: true },
    'settings.update': { kind: 'write', local: true },
    // ---- 外部打开（lib/index.js:6683-6687）----
    // 在宿主机起进程：远程会话拒绝（适配器路由的 deny 钩子按「浏览器当前
    // 会话是虚拟 id」拒绝；这里登记是让方法比对认识它）。请求体不带会话
    // 字段（client.js:9383-9392 只发 action/path/url）。
    'open.external': { kind: 'write', sessionField: 'sessionId' },
    // ---- 侧聊（lib/index.js:4971-5140，buildSidechatApi）----
    // PB-13 起转发：sidechat 的子会话带 `meta.parentSession = 调用会话 id`
    // （lib/index.js:5012），zen-remote 的共享按祖先链判定，所以侧聊线程
    // 自动继承父会话的共享——闭环是 start 的响应 childId 换成虚拟 id，
    // 浏览器拿它发后续调用时经体定位回本适配器，服务端按继承校验放行。
    'sidechat.start': {
        kind: 'write',
        sessionField: 'sessionId',
        // 响应 `{ childId }`（lib/index.js:5050，外面还有 writeOk 信封）——
        // 服务端真实 id 换虚拟。
        rewrite: (body, ctx) => rewriteEnveloped(body, (v) => rewriteTopLevel(v, 'childId', ctx), ctx),
    },
    'sidechat.prompt': forward('write', 'childId'),
    'sidechat.cancel': forward('write', 'childId'),
    'sidechat.dispose': forward('write', 'childId'),
    'sidechat.info': forward('read', 'childId'),
    'sidechat.events': forward('read', 'childId'),
    // 撤回排队消息（0.26.0 lib/index.js:6206-6226）：childId 定位，可选
    // `messageId`；响应 {accepted, removed} 不带会话 id —— 不改写。
    'sidechat.dequeue': forward('write', 'childId'),
    // 模型目录（0.26.0 lib/index.js:6228）：handler 不收 payload、无会话
    // 字段 → local（settings.* 先例），登记只为「未知方法」比对。
    'sidechat.models': { kind: 'read', local: true },
    // 给线程切模型（0.26.0 lib/index.js:6229-6245）：childId 定位；响应
    // {accepted, selection} 不带会话 id —— 不改写。
    'sidechat.model': forward('write', 'childId'),
};
/** `/sidebar/api` 的路径前缀（方法名跟在后面，lib/index.js:6888）。 */
export const SIDEBAR_API_PREFIX = '/sidebar/api/';
/** 从请求 pathname 取出 API 方法名（`/sidebar/api/fs.tree` → `fs.tree`）。 */
export function sidebarMethodNameOf(pathname) {
    if (!pathname.startsWith(SIDEBAR_API_PREFIX))
        return undefined;
    const name = pathname.slice(SIDEBAR_API_PREFIX.length);
    if (name === '' || name.includes('/'))
        return undefined;
    return name;
}
/** 顶层字段的虚拟化改写（session.cwd 的形状）。 */
function rewriteTopLevel(body, field, ctx) {
    if (body === null || typeof body !== 'object' || Array.isArray(body))
        return body;
    const record = body;
    const value = record[field];
    if (typeof value !== 'string' || value === '' || ctx.isVirtual(value))
        return body;
    return { ...record, [field]: ctx.virtualize(value) };
}
/** subagents.live 的 value（信封内）：live 映射的键是会话 id。 */
function rewriteLiveKeys(value, ctx) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return value;
    const live = value.live;
    if (live === null || typeof live !== 'object' || Array.isArray(live))
        return value;
    const rewritten = {};
    for (const [id, view] of Object.entries(live)) {
        rewritten[ctx.isVirtual(id) ? id : ctx.virtualize(id)] = view;
    }
    return { ...value, live: rewritten };
}
/** workflows.list 的 value（信封内）：runs[].originSessionId 等。 */
function rewriteWorkflowsBody(value, ctx) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return value;
    const runs = value.runs;
    if (!Array.isArray(runs))
        return value;
    return {
        ...value,
        runs: runs.map((run) => rewriteWorkflowRun(run, ctx)),
    };
}
/** 一行工作流运行的改写（originSessionId + phases[].members[].childId）。 */
function rewriteWorkflowRun(run, ctx) {
    if (run === null || typeof run !== 'object' || Array.isArray(run))
        return run;
    const record = run;
    const rewritten = { ...record };
    const origin = record.originSessionId;
    if (typeof origin === 'string' && origin !== '' && !ctx.isVirtual(origin))
        rewritten.originSessionId = ctx.virtualize(origin);
    if (Array.isArray(record.phases)) {
        rewritten.phases = record.phases.map((phase) => {
            if (phase === null || typeof phase !== 'object' || Array.isArray(phase))
                return phase;
            const phaseRecord = phase;
            if (!Array.isArray(phaseRecord.members))
                return phase;
            return {
                ...phaseRecord,
                members: phaseRecord.members.map((member) => {
                    if (member === null || typeof member !== 'object' || Array.isArray(member))
                        return member;
                    const memberRecord = member;
                    const childId = memberRecord.childId;
                    if (typeof childId !== 'string' || childId === '' || ctx.isVirtual(childId))
                        return member;
                    return { ...memberRecord, childId: ctx.virtualize(childId) };
                }),
            };
        });
    }
    return rewritten;
}
//# sourceMappingURL=methods.js.map