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

/** 请求头：客户端声明支持 `binary-envelope` 原始二进制响应封包。 */
export const BINARY_ENVELOPE_REQUEST_HEADER = 'x-zr-binary-envelope'

/** 响应头 `x-zr-content-encoding` 值：二进制封包协议标记。 */
export const BINARY_ENVELOPE_ENCODING = 'binary-envelope'

/** 二进制封包总字节上限（128 MiB）。 */
export const MAX_BINARY_ENVELOPE_BYTES = 128 * 1024 * 1024

/** 单次二进制封包允许的最大附件数。 */
export const MAX_BINARY_ENVELOPE_ATTACHMENTS = 64

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** 结果里带二进制的方法（`namespace/method`）。请求侧参数不带二进制
 * （readBytes 的参数是 scope/paths），故只有结果方向需要标记。
 * `officeToPdf/render`（2.2.6）与其 0.2.2-rc.2 后继 `officeKit/render`
 * 返回的 `data` 是整份 PDF 字节：同一个 JSON 通道会把 typed array 压扁，
 * 客户端严格编解码当场拒绝——登记进来后服务端按同一标记写出、客户端按
 * 同一标记还原。 */
export const INVOKE_BINARY_RESULT_METHODS: ReadonlySet<string> = new Set([
  'workspaceFiles/readBytes',
  'officeToPdf/render',
  'officeKit/render',
])

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

interface BinaryEnvelopeAttachmentMeta {
  path: (string | number)[]
  byteLength: number
}

const textDecoderFatal = new TextDecoder('utf-8', { fatal: true })

function assertSafeValueStructure(root: unknown): void {
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (cur === null || typeof cur !== 'object') continue
    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i++) stack.push(cur[i])
      continue
    }
    for (const key of Object.getOwnPropertyNames(cur)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new Error(`unsafe forbidden key "${key}" in binary envelope`)
      }
      stack.push((cur as Record<string, unknown>)[key])
    }
  }
}

function attachAtPath(root: unknown, path: (string | number)[], bytes: Uint8Array): unknown {
  if (path.length === 0) return bytes
  let cur: unknown = root
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!
    if (typeof seg === 'number') {
      if (!Array.isArray(cur) || seg < 0 || seg >= cur.length) {
        throw new Error('invalid array index in binary envelope attachment path')
      }
      cur = cur[seg]
    } else {
      if (
        cur === null ||
        typeof cur !== 'object' ||
        Array.isArray(cur) ||
        FORBIDDEN_KEYS.has(seg) ||
        !Object.prototype.hasOwnProperty.call(cur, seg)
      ) {
        throw new Error(`invalid object segment "${seg}" in binary envelope attachment path`)
      }
      cur = (cur as Record<string, unknown>)[seg]
    }
  }
  const leaf = path[path.length - 1]!
  if (typeof leaf === 'number') {
    if (!Array.isArray(cur) || leaf < 0 || leaf >= cur.length) {
      throw new Error('invalid leaf array index in binary envelope attachment path')
    }
    cur[leaf] = bytes
  } else {
    if (
      cur === null ||
      typeof cur !== 'object' ||
      Array.isArray(cur) ||
      FORBIDDEN_KEYS.has(leaf) ||
      !Object.prototype.hasOwnProperty.call(cur, leaf)
    ) {
      throw new Error(`invalid leaf object segment "${leaf}" in binary envelope attachment path`)
    }
    ;(cur as Record<string, unknown>)[leaf] = bytes
  }
  return root
}

/**
 * 把带 Uint8Array 的响应值编码为 `[4B UInt32BE jsonLen][UTF-8 JSON][raw bytes...]`。
 * 不含任何 typed array 时返回 `null`（调用方回落普通 JSON / gzip 路径）。
 */
export function encodeBinaryEnvelope(value: unknown): Buffer | null {
  const { value: stripped, attachments } = extractResultAttachments(value)
  if (attachments.length === 0) return null
  if (attachments.length > MAX_BINARY_ENVELOPE_ATTACHMENTS) {
    throw new RangeError(`binary envelope attachment count ${attachments.length} exceeds limit ${MAX_BINARY_ENVELOPE_ATTACHMENTS}`)
  }
  const meta: BinaryEnvelopeAttachmentMeta[] = []
  let binaryBytes = 0
  for (const att of attachments) {
    meta.push({ path: att.path, byteLength: att.bytes.byteLength })
    binaryBytes += att.bytes.byteLength
  }
  const jsonBuf = Buffer.from(JSON.stringify({ ok: true, value: stripped, attachments: meta }), 'utf8')
  const totalBytes = 4 + jsonBuf.byteLength + binaryBytes
  if (totalBytes > MAX_BINARY_ENVELOPE_BYTES) {
    throw new RangeError(`binary envelope size ${totalBytes} exceeds limit ${MAX_BINARY_ENVELOPE_BYTES}`)
  }
  const out = Buffer.allocUnsafe(totalBytes)
  out.writeUInt32BE(jsonBuf.byteLength, 0)
  jsonBuf.copy(out, 4)
  let offset = 4 + jsonBuf.byteLength
  for (const att of attachments) {
    const view = Buffer.from(att.bytes.buffer, att.bytes.byteOffset, att.bytes.byteLength)
    view.copy(out, offset)
    offset += view.byteLength
  }
  return out
}

/**
 * 解码 `[4B UInt32BE jsonLen][UTF-8 JSON][raw bytes...]` 二进制封包并还原
 * `Uint8Array` 附件；严格校验长度边界、附件计数与原型污染键。
 */
export function decodeBinaryEnvelope(bytes: Uint8Array): Record<string, unknown> {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('binary envelope payload must be a Uint8Array')
  }
  if (bytes.byteLength < 4 || bytes.byteLength > MAX_BINARY_ENVELOPE_BYTES) {
    throw new RangeError(`invalid binary envelope byteLength: ${bytes.byteLength}`)
  }
  const jsonLen = Buffer.from(bytes.buffer, bytes.byteOffset, 4).readUInt32BE(0)
  if (jsonLen === 0 || 4 + jsonLen > bytes.byteLength) {
    throw new Error(`invalid binary envelope jsonLen: ${jsonLen}`)
  }
  let parsed: unknown
  try {
    const jsonText = textDecoderFatal.decode(bytes.subarray(4, 4 + jsonLen))
    parsed = JSON.parse(jsonText)
  } catch {
    throw new Error('invalid binary envelope JSON header')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('binary envelope header must be a plain object')
  }
  const envelope = parsed as Record<string, unknown>
  if (envelope.ok !== true || !Object.prototype.hasOwnProperty.call(envelope, 'value')) {
    throw new Error('binary envelope header missing ok:true or value')
  }
  if (!Array.isArray(envelope.attachments)) {
    throw new Error('binary envelope header missing attachments array')
  }
  if (envelope.attachments.length > MAX_BINARY_ENVELOPE_ATTACHMENTS) {
    throw new RangeError(`binary envelope attachment count exceeds limit ${MAX_BINARY_ENVELOPE_ATTACHMENTS}`)
  }
  assertSafeValueStructure(envelope.value)

  const attachments: BinaryEnvelopeAttachmentMeta[] = []
  let expectedBinaryBytes = 0
  for (const rawAtt of envelope.attachments) {
    if (rawAtt === null || typeof rawAtt !== 'object' || Array.isArray(rawAtt)) {
      throw new Error('invalid binary envelope attachment descriptor')
    }
    const attObj = rawAtt as Record<string, unknown>
    if (!Array.isArray(attObj.path)) {
      throw new Error('binary envelope attachment missing path array')
    }
    const cleanPath: (string | number)[] = []
    for (const seg of attObj.path) {
      if (typeof seg === 'number') {
        if (!Number.isSafeInteger(seg) || seg < 0) {
          throw new Error('invalid numeric path segment in binary envelope')
        }
        cleanPath.push(seg)
      } else if (typeof seg === 'string') {
        if (FORBIDDEN_KEYS.has(seg)) {
          throw new Error(`unsafe forbidden key "${seg}" in binary envelope attachment path`)
        }
        cleanPath.push(seg)
      } else {
        throw new Error('invalid path segment type in binary envelope')
      }
    }
    const byteLength = attObj.byteLength
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error('invalid attachment byteLength in binary envelope')
    }
    expectedBinaryBytes += byteLength
    if (4 + jsonLen + expectedBinaryBytes > bytes.byteLength) {
      throw new Error('binary envelope attachment byteLength exceeds payload')
    }
    attachments.push({ path: cleanPath, byteLength })
  }
  if (4 + jsonLen + expectedBinaryBytes !== bytes.byteLength) {
    throw new Error('binary envelope total length mismatch')
  }
  if (attachments.some((att) => att.path.length === 0) && attachments.length !== 1) {
    throw new Error('root attachment path must be sole attachment')
  }

  let rootValue = envelope.value
  let offset = 4 + jsonLen
  for (const att of attachments) {
    const sliceCopy = new Uint8Array(bytes.subarray(offset, offset + att.byteLength))
    offset += att.byteLength
    rootValue = attachAtPath(rootValue, att.path, sliceCopy)
  }
  return { ok: true, value: rootValue }
}
