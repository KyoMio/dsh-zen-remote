// 节点身份与信令验签（PG-5）。gateway-server 是独立 npm 包（tsconfig rootDir=src），
// 无法 import 主包 src/peer/crypto.ts，这里按 PG-1 的同一套自证明方案与域分隔
// 字符串实现**网关侧的验证半边**——两侧 canonical 消息必须逐字节一致：
//
//   入网签名:  zr-gw-auth-v1|<networkId>|<nodeId>|<challengeHex>|<timestamp>
//   入网口令:  HMAC-SHA256(key = joinKey utf8) over
//              zr-join-v1|<networkId>|<nodeId>|<challengeHex>
//   STUN 探测: zr-stun-probe-v1|<networkId>|<nodeId>|<nonce>|<timestamp>
//
// 自证明身份：nodeId = sha256(publicKey bytes) 前 8 位 hex（4 字节）。凡进入
// 签名消息的 hex 一律先转小写，使消息是「值」的函数而不是「写法」的函数。
// 验证是边界：畸形输入一律返回 false，绝不抛错。
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

const LOWER_HEX = /^[0-9a-f]+$/;
const NODE_ID_PATTERN = /^[0-9a-f]{8}$/;
const NETWORK_ID_PATTERN = /^[0-9a-fA-F]{16}$/;

const AUTH_DOMAIN = 'zr-gw-auth-v1';
const JOIN_PROOF_DOMAIN = 'zr-join-v1';
const STUN_PROBE_DOMAIN = 'zr-stun-probe-v1';

export interface IdentityBinding {
  nodeId: string;
  publicKeyHex: string;
}

/** 归一化 16 hex networkId（接受大小写）；非法返回 null */
export function normalizeNetworkId(value: unknown): string | null {
  if (typeof value !== 'string' || !NETWORK_ID_PATTERN.test(value)) return null;
  return value.toLowerCase();
}

/** 归一化 8 hex nodeId；非法返回 null */
export function normalizeNodeId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length !== 8 || !LOWER_HEX.test(value.toLowerCase())) return null;
  return value.toLowerCase();
}

/** 归一化 64 hex（32 字节）公钥；非法返回 null */
export function normalizePublicKeyHex(value: unknown): string | null {
  if (typeof value !== 'string' || value.length !== 64 || !LOWER_HEX.test(value.toLowerCase())) return null;
  return value.toLowerCase();
}

/** nodeId 是否恰为 publicKey 的自证明哈希；非法输入返回 false */
export function verifySelfCertifyingNodeId(nodeId: string, publicKeyHex: string): boolean {
  const id = normalizeNodeId(nodeId);
  const pub = normalizePublicKeyHex(publicKeyHex);
  if (id === null || pub === null) return false;
  return createHash('sha256').update(Buffer.from(pub, 'hex')).digest('hex').slice(0, 8) === id;
}

function ed25519PublicFromRaw(publicKeyHex: string): KeyObject {
  // JWK 回转是 node:crypto 对 OKP 裸公钥的唯一导入路径
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyHex, 'hex').toString('base64url') },
    format: 'jwk',
  });
}

/** 128 hex Ed25519 签名校验（消息已由调用方拼好）；畸形输入返回 false */
function verifyEd25519(message: Buffer, publicKeyHex: string, signatureHex: string): boolean {
  const pub = normalizePublicKeyHex(publicKeyHex);
  if (pub === null) return false;
  if (typeof signatureHex !== 'string' || signatureHex.length !== 128 || !LOWER_HEX.test(signatureHex.toLowerCase())) {
    return false;
  }
  try {
    return verify(null, message, ed25519PublicFromRaw(pub), Buffer.from(signatureHex.toLowerCase(), 'hex'));
  } catch {
    return false;
  }
}

export function gatewayAuthMessage(networkId: string, nodeId: string, challengeHex: string, timestamp: number): Buffer {
  return Buffer.from(`${AUTH_DOMAIN}|${networkId}|${nodeId}|${challengeHex}|${timestamp}`, 'utf8');
}

/**
 * 校验挑战应答签名：自证明身份先于签名数学检查。
 * challengeHex 须为偶长 hex（网关自己生成的 32B hex 天然满足）。
 */
export function verifyGatewayChallengeSignature(params: {
  networkId: string;
  nodeId: string;
  publicKeyHex: string;
  challengeHex: string;
  timestamp: number;
  signatureHex: string;
}): boolean {
  const { networkId, nodeId, publicKeyHex, timestamp } = params;
  if (typeof params.challengeHex !== 'string' || params.challengeHex.length === 0 || params.challengeHex.length % 2 !== 0 || !LOWER_HEX.test(params.challengeHex.toLowerCase())) return false;
  if (typeof timestamp !== 'number' || !Number.isInteger(timestamp)) return false;
  if (!verifySelfCertifyingNodeId(nodeId, publicKeyHex)) return false;
  const message = gatewayAuthMessage(networkId.toLowerCase(), nodeId.toLowerCase(), params.challengeHex.toLowerCase(), timestamp);
  return verifyEd25519(message, publicKeyHex, params.signatureHex);
}

export function joinKeyProofMessage(networkId: string, nodeId: string, challengeHex: string): Buffer {
  return Buffer.from(`${JOIN_PROOF_DOMAIN}|${networkId}|${nodeId}|${challengeHex}`, 'utf8');
}

/** 常数时间校验入网口令证明（64 hex HMAC）；畸形输入返回 false */
export function verifyJoinKeyProofHex(params: {
  joinKey: string;
  networkId: string;
  nodeId: string;
  challengeHex: string;
  proofHex: string;
}): boolean {
  const { joinKey, proofHex } = params;
  if (typeof joinKey !== 'string' || joinKey.length === 0) return false;
  if (typeof proofHex !== 'string' || proofHex.length !== 64 || !LOWER_HEX.test(proofHex.toLowerCase())) return false;
  if (typeof params.challengeHex !== 'string' || params.challengeHex.length === 0 || params.challengeHex.length % 2 !== 0 || !LOWER_HEX.test(params.challengeHex.toLowerCase())) return false;
  try {
    const expected = createHmac('sha256', Buffer.from(joinKey, 'utf8'))
      .update(joinKeyProofMessage(params.networkId.toLowerCase(), params.nodeId.toLowerCase(), params.challengeHex.toLowerCase()))
      .digest();
    return timingSafeEqual(expected, Buffer.from(proofHex.toLowerCase(), 'hex'));
  } catch {
    return false;
  }
}

export function stunProbeMessage(networkId: string, nodeId: string, nonce: string, timestamp: number): Buffer {
  return Buffer.from(`${STUN_PROBE_DOMAIN}|${networkId}|${nodeId}|${nonce}|${timestamp}`, 'utf8');
}

/**
 * 校验 STUN 探测签名（防伪造反射更新）。nonce 须为 2..32 位偶长 hex
 * ——原样回显给探测方，回显垃圾等于免费放大器。
 */
export function verifyStunProbeSignature(params: {
  networkId: string;
  nodeId: string;
  publicKeyHex: string;
  nonce: string;
  timestamp: number;
  signatureHex: string;
}): boolean {
  const { nonce, timestamp } = params;
  if (typeof nonce !== 'string' || nonce.length < 2 || nonce.length > 32 || nonce.length % 2 !== 0 || !LOWER_HEX.test(nonce.toLowerCase())) return false;
  if (typeof timestamp !== 'number' || !Number.isInteger(timestamp)) return false;
  if (!verifySelfCertifyingNodeId(params.nodeId, params.publicKeyHex)) return false;
  const message = stunProbeMessage(params.networkId.toLowerCase(), params.nodeId.toLowerCase(), nonce.toLowerCase(), timestamp);
  return verifyEd25519(message, params.publicKeyHex, params.signatureHex);
}
