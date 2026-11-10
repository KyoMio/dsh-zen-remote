// 中转帧头解析（PG-5）。gateway-server 独立成包后无法 import 主包的
// src/peer/wire.ts，这里按 PG-1 的同一 28B 大端布局实现**中继路由所需的
// 明文前缀读取**——网关只读头、绝不解密载荷：
//
//   [0..1] magic(0x5a52 'ZR') · [2] version(0x01) · [3] frameType ·
//   [4..7] srcNodeId(8hex) · [8..11] dstNodeId(8hex) · [12..15] streamId ·
//   [16..23] seq(u64) · [24..27] ack
//
// 总长 44..1200（28 头 + 16 AEAD tag 起步，单加密数据报友好）。
// 垃圾帧是常态，读取失败一律返回 null、绝不抛错。
/** PG-1 的明文路由头固定 28 字节 */
export const RELAY_HEADER_BYTES = 28;

/** `'ZR'` — 中转帧魔数；不一致即不是我们的帧 */
export const RELAY_FRAME_MAGIC = 0x5a52;
export const RELAY_FRAME_VERSION = 0x01;
/** 最小合法帧：28B 头 + 16B AEAD tag */
export const RELAY_MIN_FRAME_BYTES = RELAY_HEADER_BYTES + 16;
/** 单帧硬上限（单加密数据报友好） */
export const RELAY_MAX_FRAME_BYTES = 1200;

/** PG-1 PeerFrameType 的合法范围（HELLO..RST），超界即垃圾帧 */
const FRAME_TYPE_MIN = 0x01;
const FRAME_TYPE_MAX = 0x07;

export interface RelayFrameHeader {
  srcNodeId: string;
  dstNodeId: string;
  frameType: number;
  totalBytes: number;
}

/** 读中转路由所需的明文头；任何畸形输入返回 null、绝不抛错 */
export function readRelayHeader(buf: Buffer): RelayFrameHeader | null {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length < RELAY_MIN_FRAME_BYTES || buf.length > RELAY_MAX_FRAME_BYTES) return null;
  const magic = buf.readUInt16BE(0);
  if (magic !== RELAY_FRAME_MAGIC) return null;
  const version = buf.readUInt8(2);
  if (version !== RELAY_FRAME_VERSION) return null;
  const frameType = buf.readUInt8(3);
  if (frameType < FRAME_TYPE_MIN || frameType > FRAME_TYPE_MAX) return null;
  return {
    srcNodeId: buf.subarray(4, 8).toString('hex'),
    dstNodeId: buf.subarray(8, 12).toString('hex'),
    frameType,
    totalBytes: buf.length,
  };
}
