// 主密钥派生与秘密加解密。
//
// 主密钥来源（按优先级）：
//   1. env `ZR_GATEWAY_SECRET`（非空）——HKDF 派生，不落盘；
//   2. `<dataDir>/master.key`——首次生成 32B 随机密钥，原子写入、权限 0600，重启复读。
//
// encryptSecret 专门用于加密数据库里的 `join_key_enc`：数据库单表泄露时看不到明文口令，
// 归属用户/管理员查询网络时用主密钥解密拼装完整 joinUri。
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HKDF_INFO = 'zr-gw-master-v1';
const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_KEY_BYTES = 64;
/** 排除易混字符（i/l/1/I/L/O/0）的密码字母表 */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function deriveMasterKeyFromSecret(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, HKDF_INFO, '', MASTER_KEY_BYTES));
}

function assertMasterKey(masterKey: Buffer): void {
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new Error(`master key must be ${MASTER_KEY_BYTES} bytes, got ${masterKey.length}`);
  }
}

/**
 * 读取或首次生成主密钥。env secret 优先于文件；损坏的 master.key（长度不对）直接抛错
 * 而不是悄悄换钥匙——换了钥匙所有已存密文都解不开。
 */
export function loadOrCreateMasterKey(dataDir: string, env: Record<string, string | undefined> = process.env): Buffer {
  const secret = env['ZR_GATEWAY_SECRET'];
  if (typeof secret === 'string' && secret.length > 0) {
    return deriveMasterKeyFromSecret(secret);
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dataDir, 'master.key');

  let existing: Buffer | null = null;
  try {
    existing = fs.readFileSync(keyPath);
  } catch {
    existing = null; // 不存在即首次生成；其他读错误在后续写入/读取时自然暴露
  }
  if (existing !== null) {
    if (existing.length !== MASTER_KEY_BYTES) {
      throw new Error(
        `master.key at ${keyPath} is corrupted (expected ${MASTER_KEY_BYTES} bytes, got ${existing.length}); ` +
          'refusing to start because every stored secret would become unreadable',
      );
    }
    try {
      fs.chmodSync(keyPath, 0o600); // 修历史上过宽的权限（Windows 上 no-op）
    } catch {
      /* 非 POSIX 平台忽略 */
    }
    return existing;
  }

  const fresh = randomBytes(MASTER_KEY_BYTES);
  const tmpPath = `${keyPath}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmpPath, fresh, { mode: 0o600 });
  fs.renameSync(tmpPath, keyPath); // 同目录 rename，原子落盘
  return fresh;
}

/** AES-256-GCM 加密，编码为 `v1:<ivHex>:<tagHex>:<cipherHex>` */
export function encryptSecret(plaintext: string, masterKey: Buffer): string {
  assertMasterKey(masterKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/** 解密 `v1:<ivHex>:<tagHex>:<cipherHex>`；格式不对或 authTag 校验失败都抛错 */
export function decryptSecret(encoded: string, masterKey: Buffer): string {
  assertMasterKey(masterKey);
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('encrypted secret has unexpected format (expected v1:<ivHex>:<tagHex>:<cipherHex>)');
  }
  const ivHex = parts[1] as string;
  const tagHex = parts[2] as string;
  const cipherHex = parts[3] as string;
  if (!/^[0-9a-f]{24}$/.test(ivHex) || !/^[0-9a-f]{32}$/.test(tagHex)) {
    throw new Error('encrypted secret has malformed iv or auth tag');
  }
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]).toString('utf8');
}

function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, (err, derivedKey) => {
      if (err !== null) reject(err);
      else resolve(derivedKey);
    });
  });
}

/** scrypt 哈希口令，格式 `scrypt:<saltHex>:<hashHex>`（16B 随机盐，同口令两次哈希不同） */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const derived = await scryptAsync(password, salt, PASSWORD_KEY_BYTES);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** 常数时间比较校验口令；stored 格式不对一律返回 false 而不是抛错 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const saltHex = parts[1] as string;
  const hashHex = parts[2] as string;
  if (!/^[0-9a-f]+$/.test(saltHex) || !/^[0-9a-f]+$/.test(hashHex)) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** 生成 16 位无偏随机密码（rejection sampling 避免模偏差） */
export function generatePassword(length = 16): string {
  const alphabetLen = PASSWORD_ALPHABET.length;
  const cutoff = 256 - (256 % alphabetLen);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= cutoff) continue;
      out += PASSWORD_ALPHABET[byte % alphabetLen];
      if (out.length === length) break;
    }
  }
  return out;
}
