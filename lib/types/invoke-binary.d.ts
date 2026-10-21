/**
 * invoke 二进制载荷的线上标记（2026-10-14 修复）：`v1/invoke` 是纯 JSON
 * 通道，而 `workspaceFiles/readBytes` 的结果带 `data: Uint8Array`——直接
 * `JSON.stringify` 会把 typed array 打成普通对象，子客户端侧的 zod 校验
 * （expected "Uint8Array"）当场拒绝，远程会话的图片预览报「读取失败」。
 *
 * 两端共用同一份规则：服务端在应答前对已知二进制方法的结果做深度标记
 * （typed array → `{ $zr-u8: <base64> }`），子客户端在 forwardInvoke 拿回
 * 值后还原成真 `Uint8Array`。两端都按同一个 `INVOKE_BINARY_RESULT_METHODS`
 * 常量开关——单一来源，不可能漂移（这是登记表同步硬约束之外的第三张
 * 「小表」，但它只此一处定义）。
 *
 * 纯逻辑：不 import DSH、不碰 I/O。
 */
/** 标记键。线上只会出现服务端写入的标记；客户端只认这个键。 */
export declare const BINARY_MARKER = "$zr-u8";
/** 结果里带二进制的方法（`namespace/method`）。请求侧参数不带二进制
 * （readBytes 的参数是 scope/paths），故只有结果方向需要标记。
 * `officeToPdf/render`（2.2.6）返回的 `data` 是整份 PDF 字节：同一个
 * JSON 通道会把 typed array 压扁，客户端严格编解码当场拒绝——登记进来
 * 后服务端按同一标记写出、客户端按同一标记还原。 */
export declare const INVOKE_BINARY_RESULT_METHODS: ReadonlySet<string>;
/** 深度遍历，把 typed array（含 Buffer）换成 `{ $zr-u8: base64 }` 标记。 */
export declare function markInvokeBinary(value: unknown, depth?: number): unknown;
/** 深度遍历，把 `{ $zr-u8: base64 }` 标记还原成 `Uint8Array`。
 *  标记只会是本模块的 `markInvokeBinary` 写下的（键名即凭据），base64
 *  恒有效；万一混入同键的怪值，`Buffer.from(..., 'base64')` 的宽容解码
 *  也不会抛。非标记对象原样返回（同一引用，不惊动浅比较的调用方）。 */
export declare function restoreInvokeBinary(value: unknown, depth?: number): unknown;
/** dispatchRpc 信封的附件旁路形状（dsh-api-gateway 的 encodeRpcResult）：
 *  Uint8Array 不进 JSON 值，抽到 `attachments: [{path, bytes}]`，原位置
 *  置 null，渲染层按 path 回填。远程路径必须产出同样的契约，否则
 *  typed array 在后台→浏览器的桥上被 JSON 压扁（2026-10-14 实机定位）。 */
export interface ResultAttachment {
    path: (string | number)[];
    bytes: Uint8Array;
}
/** 把（已还原的）结果值里的 Uint8Array 抽成附件；值内原位置置 null。
 *  没有 typed array 时 value 原引用返回、attachments 为空数组。 */
export declare function extractResultAttachments(value: unknown): {
    value: unknown;
    attachments: ResultAttachment[];
};
//# sourceMappingURL=invoke-binary.d.ts.map