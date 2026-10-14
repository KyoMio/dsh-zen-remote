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
export const BINARY_MARKER = '$zr-u8'

/** 结果里带二进制的方法（`namespace/method`）。请求侧参数不带二进制
 * （readBytes 的参数是 scope/paths），故只有结果方向需要标记。 */
export const INVOKE_BINARY_RESULT_METHODS: ReadonlySet<string> = new Set(['workspaceFiles/readBytes'])

/** 深度上限：与其余 walker（share-store 祖先链、会话引用扫描）一致。 */
const MAX_DEPTH = 16

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !isTypedArray(value)

const isTypedArray = (value: unknown): value is ArrayBufferView =>
  ArrayBuffer.isView(value) === true && !(value instanceof DataView)

/** 深度遍历，把 typed array（含 Buffer）换成 `{ $zr-u8: base64 }` 标记。 */
export function markInvokeBinary(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return value
  if (isTypedArray(value)) return { [BINARY_MARKER]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  if (Array.isArray(value)) {
    let changed = false
    const out: unknown[] = []
    for (const item of value) {
      const marked = markInvokeBinary(item, depth + 1)
      if (marked !== item) changed = true
      out.push(marked)
    }
    return changed ? out : value
  }
  if (isPlainObject(value)) {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const marked = markInvokeBinary(item, depth + 1)
      if (marked !== item) changed = true
      out[key] = marked
    }
    return changed ? out : value
  }
  return value
}

/** 深度遍历，把 `{ $zr-u8: base64 }` 标记还原成 `Uint8Array`。
 *  标记只会是本模块的 `markInvokeBinary` 写下的（键名即凭据），base64
 *  恒有效；万一混入同键的怪值，`Buffer.from(..., 'base64')` 的宽容解码
 *  也不会抛。非标记对象原样返回（同一引用，不惊动浅比较的调用方）。 */
export function restoreInvokeBinary(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return value
  if (Array.isArray(value)) {
    let changed = false
    const out: unknown[] = value.map((item) => {
      const restored = restoreInvokeBinary(item, depth + 1)
      if (restored !== item) changed = true
      return restored
    })
    return changed ? out : value
  }
  if (isPlainObject(value)) {
    const marked = value[BINARY_MARKER]
    // 空串也是合法标记（base64 空串 = 0 字节，mark 自己写下的）；
    // 只排除非字符串与带兄弟键的诱饵形状。
    if (typeof marked === 'string' && Object.keys(value).length === 1) {
      return new Uint8Array(Buffer.from(marked, 'base64'))
    }
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const restored = restoreInvokeBinary(item, depth + 1)
      if (restored !== item) changed = true
      out[key] = restored
    }
    return changed ? out : value
  }
  return value
}

/** dispatchRpc 信封的附件旁路形状（dsh-api-gateway 的 encodeRpcResult）：
 *  Uint8Array 不进 JSON 值，抽到 `attachments: [{path, bytes}]`，原位置
 *  置 null，渲染层按 path 回填。远程路径必须产出同样的契约，否则
 *  typed array 在后台→浏览器的桥上被 JSON 压扁（2026-10-14 实机定位）。 */
export interface ResultAttachment {
  path: (string | number)[]
  bytes: Uint8Array
}

/** 把（已还原的）结果值里的 Uint8Array 抽成附件；值内原位置置 null。
 *  没有 typed array 时 value 原引用返回、attachments 为空数组。 */
export function extractResultAttachments(value: unknown): { value: unknown; attachments: ResultAttachment[] } {
  const attachments: ResultAttachment[] = []
  const walk = (input: unknown, path: (string | number)[], depth: number): unknown => {
    if (depth >= MAX_DEPTH) return input
    if (isTypedArray(input)) {
      attachments.push({ path, bytes: input as Uint8Array })
      return null
    }
    if (Array.isArray(input)) {
      let changed = false
      const out: unknown[] = input.map((item, index) => {
        const extracted = walk(item, [...path, index], depth + 1)
        if (extracted !== item) changed = true
        return extracted
      })
      return changed ? out : input
    }
    if (isPlainObject(input)) {
      let changed = false
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(input)) {
        const extracted = walk(item, [...path, key], depth + 1)
        if (extracted !== item) changed = true
        out[key] = extracted
      }
      return changed ? out : input
    }
    return input
  }
  return { value: walk(value, [], 0), attachments }
}
