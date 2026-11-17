// 原生单端口 TLS 证书管理引擎（GT-1）：仅使用 Node 22 内置 crypto / tls / fs。
//
// 职责：
//   1. 单段文件名白名单 + realpath containment（拦截 .. / 路径分隔 / 目录外 symlink）；
//   2. X.509 摘要提取、加密私钥预检、公钥/私钥配对验证与 tls.createSecureContext 构筑；
//   3. `.tmp + fsync + rename` 原子写盘（cert 0644 / key 0600）；
//   4. 三态启动引导（tlsEnabled: null | true | false）+ Fail-Closed（过期证书仍允许启动）；
//   5. fs.watch 500ms 防抖 + acme.sh 顺序写入 1500ms 单次重试 + 热重载告警保持。
import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';

import type { GatewayStore } from '../store/types.js';

export const DEFAULT_TLS_CERT_FILE = 'fullchain.pem';
export const DEFAULT_TLS_KEY_FILE = 'privkey.pem';
export const TLS_EXPIRING_SOON_MS = 14 * 24 * 60 * 60 * 1000;
export const TLS_RELOAD_DEBOUNCE_MS = 500;
export const TLS_RELOAD_RETRY_MS = 1500;
export const MAX_CERT_PEM_BYTES = 256 * 1024;

const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]{1,128}\.(pem|crt|cer|key)$/i;
const ENCRYPTED_KEY_RE = /-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:\s*4,\s*ENCRYPTED/i;
const CERT_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;
const KEY_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----/;

export type TlsErrorCode =
  | 'TLS_INVALID_FILENAME'
  | 'TLS_CERT_DIR_READONLY'
  | 'TLS_CERT_MISSING'
  | 'TLS_KEY_MISSING'
  | 'TLS_CERT_INVALID'
  | 'TLS_KEY_ENCRYPTED'
  | 'TLS_CERT_KEY_MISMATCH';

export class TlsConfigError extends Error {
  constructor(
    readonly code: TlsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TlsConfigError';
  }
}

export interface TlsCertSummary {
  subject: string;
  issuer: string;
  san: string[];
  validFrom: string;
  validTo: string;
  fingerprint256: string;
  expired: boolean;
  expiringSoon: boolean;
}

export interface TlsDirFileInfo {
  name: string;
  kind: 'cert' | 'key' | 'unknown';
  sizeBytes: number;
  updatedAt: string;
}

export interface TlsReloadErrorView {
  code: string;
  message: string;
  at: string;
}

export interface AdminTlsView {
  enabled: boolean;
  tlsActive: boolean;
  certDirConfigured: boolean;
  certDirWritable: boolean;
  certFile: string;
  keyFile: string;
  availableFiles: TlsDirFileInfo[];
  activeCert: TlsCertSummary | null;
  lastReloadAt: string | null;
  lastReloadError: TlsReloadErrorView | null;
}

export interface RuntimeTlsFlags {
  tlsEnabled: boolean;
  activeCertExpired: boolean;
  activeCertExpiringSoon: boolean;
  reloadFailed: boolean;
}

export interface TlsContextChange {
  enabled: boolean;
  secureContext: tls.SecureContext | null;
}

export interface TlsManagerOptions {
  certDir: string;
  now?: () => number;
  debounceMs?: number;
  retryMs?: number;
  onContextChange?: (next: TlsContextChange) => void;
  onReloadFailed?: (err: TlsReloadErrorView) => void;
}

export interface ParsedCertPair {
  secureContext: tls.SecureContext;
  summary: TlsCertSummary;
}

export interface ApplyCertificateInput {
  certPem: string;
  keyPem: string;
  certFile?: string;
  keyFile?: string;
  enableTls?: boolean;
}

export interface ApplySettingsInput {
  enabled?: boolean;
  certFile?: string;
  keyFile?: string;
}

/** 校验单段安全证书文件名：允许字母数字与 `._-`，禁止路径分隔、`..` 与点开头隐藏文件 */
export function isSafeCertFilename(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.startsWith('.') || name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  return SAFE_FILENAME_RE.test(name);
}

function classifyFileKind(name: string): 'cert' | 'key' | 'unknown' {
  const lower = name.toLowerCase();
  if (lower.endsWith('.key') || lower.includes('privkey')) return 'key';
  if (lower.endsWith('.crt') || lower.endsWith('.cer')) return 'cert';
  if (lower.endsWith('.pem')) {
    if (lower.includes('key') && !lower.includes('cert') && !lower.includes('chain')) return 'key';
    if (lower.includes('cert') || lower.includes('chain')) return 'cert';
  }
  return 'unknown';
}

function parseSanList(subjectAltName: string | undefined): string[] {
  if (typeof subjectAltName !== 'string' || subjectAltName.trim().length === 0) return [];
  const list: string[] = [];
  for (const part of subjectAltName.split(',')) {
    const item = part.trim();
    if (item.length === 0) continue;
    if (item.startsWith('DNS:')) list.push(item.slice(4).trim());
    else if (item.startsWith('IP Address:')) list.push(item.slice(11).trim());
    else list.push(item);
  }
  return list;
}

function isInsideDirectory(dirReal: string, targetReal: string): boolean {
  const prefix = dirReal.endsWith(path.sep) ? dirReal : `${dirReal}${path.sep}`;
  return targetReal.startsWith(prefix);
}

function isReadonlyFsError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

function isNotFoundFsError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ENOENT';
}

/** 校验并解析证书链 + 私钥 PEM，产出可用于 tls.createSecureContext 的上下文与 X.509 摘要 */
export function parseAndValidateCertPair(certPem: string, keyPem: string, nowMs: number = Date.now()): ParsedCertPair {
  if (typeof certPem !== 'string' || Buffer.byteLength(certPem, 'utf8') > MAX_CERT_PEM_BYTES || !CERT_BLOCK_RE.test(certPem)) {
    throw new TlsConfigError('TLS_CERT_INVALID', 'certificate must be a valid non-empty PEM X.509 chain');
  }
  if (typeof keyPem !== 'string' || Buffer.byteLength(keyPem, 'utf8') > MAX_CERT_PEM_BYTES || keyPem.trim().length === 0) {
    throw new TlsConfigError('TLS_CERT_INVALID', 'private key must be a non-empty PEM string');
  }
  if (ENCRYPTED_KEY_RE.test(keyPem)) {
    throw new TlsConfigError('TLS_KEY_ENCRYPTED', 'encrypted private keys with passphrases are not supported');
  }
  if (!KEY_BLOCK_RE.test(keyPem)) {
    throw new TlsConfigError('TLS_CERT_INVALID', 'private key must be an unencrypted PEM private key');
  }

  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(certPem);
  } catch (err) {
    throw new TlsConfigError('TLS_CERT_INVALID', 'failed to parse X.509 certificate PEM', { cause: err });
  }

  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey({ key: keyPem });
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    if (msg.includes('encrypt') || msg.includes('passphrase') || msg.includes('bad decrypt')) {
      throw new TlsConfigError('TLS_KEY_ENCRYPTED', 'encrypted private keys with passphrases are not supported', { cause: err });
    }
    throw new TlsConfigError('TLS_CERT_INVALID', 'failed to parse PEM private key', { cause: err });
  }

  if (!x509.checkPrivateKey(privateKey)) {
    throw new TlsConfigError('TLS_CERT_KEY_MISMATCH', 'certificate public key does not match private key');
  }

  let secureContext: tls.SecureContext;
  try {
    secureContext = tls.createSecureContext({ cert: certPem, key: keyPem });
  } catch (err) {
    throw new TlsConfigError('TLS_CERT_INVALID', 'certificate chain and private key cannot initialize TLS context', { cause: err });
  }

  const validFromMs = x509.validFromDate.getTime();
  const validToMs = x509.validToDate.getTime();
  const expired = validToMs <= nowMs;
  const expiringSoon = !expired && validToMs - nowMs <= TLS_EXPIRING_SOON_MS;

  return {
    secureContext,
    summary: {
      subject: x509.subject,
      issuer: x509.issuer,
      san: parseSanList(x509.subjectAltName),
      validFrom: new Date(validFromMs).toISOString(),
      validTo: new Date(validToMs).toISOString(),
      fingerprint256: x509.fingerprint256,
      expired,
      expiringSoon,
    },
  };
}

export class TlsManager {
  private readonly certDir: string;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly retryMs: number;
  private onContextChange?: (next: TlsContextChange) => void;
  private onReloadFailed?: (err: TlsReloadErrorView) => void;

  private enabled = false;
  private certFile = DEFAULT_TLS_CERT_FILE;
  private keyFile = DEFAULT_TLS_KEY_FILE;
  private secureContext: tls.SecureContext | null = null;
  private activeCert: TlsCertSummary | null = null;
  private lastReloadAt: string | null = null;
  private lastReloadError: TlsReloadErrorView | null = null;

  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private suppressWatchUntilMs = 0;
  private closed = false;

  constructor(options: TlsManagerOptions) {
    this.certDir = path.resolve(options.certDir);
    this.now = options.now ?? (() => Date.now());
    this.debounceMs = options.debounceMs ?? TLS_RELOAD_DEBOUNCE_MS;
    this.retryMs = options.retryMs ?? TLS_RELOAD_RETRY_MS;
    this.onContextChange = options.onContextChange;
    this.onReloadFailed = options.onReloadFailed;
  }

  setHooks(hooks: { onContextChange?: (next: TlsContextChange) => void; onReloadFailed?: (err: TlsReloadErrorView) => void }): void {
    if (hooks.onContextChange !== undefined) this.onContextChange = hooks.onContextChange;
    if (hooks.onReloadFailed !== undefined) this.onReloadFailed = hooks.onReloadFailed;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getSecureContext(): tls.SecureContext | null {
    return this.secureContext;
  }

  getRuntimeFlags(): RuntimeTlsFlags {
    const nowMs = this.now();
    // 动态重算当前时刻的过期状态（即使用户不重启网关，天数推移也要触发安全告警）
    const validToMs = this.activeCert !== null ? Date.parse(this.activeCert.validTo) : NaN;
    const expired = Number.isFinite(validToMs) ? validToMs <= nowMs : false;
    const expiringSoon = Number.isFinite(validToMs) ? !expired && validToMs - nowMs <= TLS_EXPIRING_SOON_MS : false;
    return {
      tlsEnabled: this.enabled,
      activeCertExpired: this.enabled && expired,
      activeCertExpiringSoon: this.enabled && expiringSoon,
      reloadFailed: this.lastReloadError !== null,
    };
  }

  private assertSafeFilename(name: string): void {
    if (!isSafeCertFilename(name)) {
      throw new TlsConfigError('TLS_INVALID_FILENAME', `invalid certificate filename: ${JSON.stringify(name)}`);
    }
  }

  /**
   * 解析并校验证书目录内的文件真实路径：
   * - 读取模式：要求文件或符号链接目标解析后严格位于 realpath(certDir) 内部；
   * - 写入模式：可先建目录，并确保目标及既有符号链接均不可逃逸到目录外。
   */
  private async resolveContainedReadPath(filename: string, missingCode: 'TLS_CERT_MISSING' | 'TLS_KEY_MISSING'): Promise<string> {
    this.assertSafeFilename(filename);
    let dirReal: string;
    try {
      dirReal = await fsp.realpath(this.certDir);
    } catch (err) {
      if (isNotFoundFsError(err)) {
        throw new TlsConfigError(missingCode, `certificate file not found: ${filename}`, { cause: err });
      }
      throw new TlsConfigError('TLS_CERT_INVALID', `certificate directory is not accessible`, { cause: err });
    }

    const candidate = path.join(dirReal, filename);
    let lstat: fs.Stats;
    try {
      lstat = await fsp.lstat(candidate);
    } catch (err) {
      if (isNotFoundFsError(err)) {
        throw new TlsConfigError(missingCode, `certificate file not found: ${filename}`, { cause: err });
      }
      throw new TlsConfigError('TLS_CERT_INVALID', `cannot read certificate file: ${filename}`, { cause: err });
    }

    if (lstat.isSymbolicLink()) {
      let targetReal: string;
      try {
        targetReal = await fsp.realpath(candidate);
      } catch (err) {
        // 悬空符号链接仍要检查 linkTarget 是否指向目录外
        try {
          const rawTarget = await fsp.readlink(candidate);
          const resolvedLink = path.resolve(dirReal, rawTarget);
          if (!isInsideDirectory(dirReal, resolvedLink)) {
            throw new TlsConfigError('TLS_INVALID_FILENAME', `symlink escapes certificate directory: ${filename}`);
          }
        } catch (linkErr) {
          if (linkErr instanceof TlsConfigError) throw linkErr;
        }
        throw new TlsConfigError(missingCode, `certificate file not found: ${filename}`, { cause: err });
      }
      if (!isInsideDirectory(dirReal, targetReal)) {
        throw new TlsConfigError('TLS_INVALID_FILENAME', `symlink escapes certificate directory: ${filename}`);
      }
      const targetStat = await fsp.stat(targetReal);
      if (!targetStat.isFile()) {
        throw new TlsConfigError('TLS_INVALID_FILENAME', `certificate target must be a regular file: ${filename}`);
      }
      return targetReal;
    }

    if (!lstat.isFile()) {
      throw new TlsConfigError('TLS_INVALID_FILENAME', `certificate target must be a regular file: ${filename}`);
    }
    return candidate;
  }

  private async resolveContainedWritePath(filename: string): Promise<{ dirReal: string; targetPath: string }> {
    this.assertSafeFilename(filename);
    try {
      await fsp.mkdir(this.certDir, { recursive: true });
    } catch (err) {
      if (isReadonlyFsError(err)) {
        throw new TlsConfigError('TLS_CERT_DIR_READONLY', 'certificate directory is not writable', { cause: err });
      }
      throw err;
    }

    const dirReal = await fsp.realpath(this.certDir);
    const targetPath = path.join(dirReal, filename);

    // 若目标已存在，预先确认不是逃逸到目录外的符号链接或目录对象
    try {
      const lstat = await fsp.lstat(targetPath);
      if (lstat.isDirectory()) {
        throw new TlsConfigError('TLS_INVALID_FILENAME', `certificate target cannot be a directory: ${filename}`);
      }
      if (lstat.isSymbolicLink()) {
        const targetReal = await fsp.realpath(targetPath).catch(() => null);
        if (targetReal === null || !isInsideDirectory(dirReal, targetReal)) {
          throw new TlsConfigError('TLS_INVALID_FILENAME', `symlink escapes certificate directory: ${filename}`);
        }
      }
    } catch (err) {
      if (!isNotFoundFsError(err)) throw err;
    }

    return { dirReal, targetPath };
  }

  private async readBoundedPem(filePath: string, filename: string): Promise<string> {
    const stat = await fsp.stat(filePath);
    if (stat.size > MAX_CERT_PEM_BYTES) {
      throw new TlsConfigError('TLS_CERT_INVALID', `file exceeds maximum PEM size (${MAX_CERT_PEM_BYTES} bytes): ${filename}`);
    }
    return fsp.readFile(filePath, 'utf8');
  }

  private async loadPairFromDisk(certFile: string, keyFile: string): Promise<ParsedCertPair> {
    const certPath = await this.resolveContainedReadPath(certFile, 'TLS_CERT_MISSING');
    const keyPath = await this.resolveContainedReadPath(keyFile, 'TLS_KEY_MISSING');
    const [certPem, keyPem] = await Promise.all([
      this.readBoundedPem(certPath, certFile),
      this.readBoundedPem(keyPath, keyFile),
    ]);
    return parseAndValidateCertPair(certPem, keyPem, this.now());
  }

  private async probeFileExists(filename: string): Promise<boolean> {
    if (!isSafeCertFilename(filename)) return false;
    try {
      const dirReal = await fsp.realpath(this.certDir);
      const candidate = path.join(dirReal, filename);
      await fsp.lstat(candidate);
      return true;
    } catch {
      return false;
    }
  }

  /** 三态启动引导：必须在绑定对外网络端口前执行；已开启态或半残状态 Fail-Closed 拒绝启动 */
  async bootstrap(store: GatewayStore): Promise<void> {
    const ext = await store.getExtendedSettings();
    const certFile = ext.tlsCertFile;
    const keyFile = ext.tlsKeyFile;
    this.assertSafeFilename(certFile);
    this.assertSafeFilename(keyFile);
    this.certFile = certFile;
    this.keyFile = keyFile;

    if (ext.tlsEnabled === true) {
      const pair = await this.loadPairFromDisk(certFile, keyFile);
      this.enabled = true;
      this.secureContext = pair.secureContext;
      this.activeCert = pair.summary;
      this.lastReloadAt = new Date(this.now()).toISOString();
      this.lastReloadError = null;
      return;
    }

    if (ext.tlsEnabled === false) {
      this.enabled = false;
      this.secureContext = null;
      this.activeCert = await this.tryLoadPreviewSummary(certFile, keyFile);
      this.lastReloadError = null;
      return;
    }

    // tlsEnabled === null（首次未配置）：仅当两者皆不存在时保持明文；缺一半或损坏立即失败
    const [hasCert, hasKey] = await Promise.all([this.probeFileExists(certFile), this.probeFileExists(keyFile)]);
    if (!hasCert && !hasKey) {
      this.enabled = false;
      this.secureContext = null;
      this.activeCert = null;
      return;
    }
    if (!hasCert) {
      throw new TlsConfigError('TLS_CERT_MISSING', `found ${keyFile} without paired ${certFile}`);
    }
    if (!hasKey) {
      throw new TlsConfigError('TLS_KEY_MISSING', `found ${certFile} without paired ${keyFile}`);
    }

    const pair = await this.loadPairFromDisk(certFile, keyFile);
    await store.updateExtendedSettings({ tlsEnabled: true });
    this.enabled = true;
    this.secureContext = pair.secureContext;
    this.activeCert = pair.summary;
    this.lastReloadAt = new Date(this.now()).toISOString();
    this.lastReloadError = null;
  }

  private async tryLoadPreviewSummary(certFile: string, keyFile: string): Promise<TlsCertSummary | null> {
    try {
      const pair = await this.loadPairFromDisk(certFile, keyFile);
      return pair.summary;
    } catch {
      return null;
    }
  }

  private async checkDirWritable(): Promise<{ exists: boolean; writable: boolean }> {
    try {
      const stat = await fsp.stat(this.certDir);
      if (!stat.isDirectory()) return { exists: false, writable: false };
      try {
        await fsp.access(this.certDir, fs.constants.W_OK | fs.constants.X_OK);
        return { exists: true, writable: true };
      } catch {
        return { exists: true, writable: false };
      }
    } catch {
      // 目录尚未创建时检查父目录是否可写，避免只读环境下误判
      const parent = path.dirname(this.certDir);
      try {
        await fsp.access(parent, fs.constants.W_OK | fs.constants.X_OK);
        return { exists: false, writable: true };
      } catch {
        return { exists: false, writable: false };
      }
    }
  }

  /** 扫描证书目录：仅返回安全文件名列表与目录状态，绝不泄漏宿主机绝对路径 */
  async scanDirectory(): Promise<{ certDirConfigured: boolean; certDirWritable: boolean; files: TlsDirFileInfo[] }> {
    const dirCheck = await this.checkDirWritable();
    if (!dirCheck.exists) {
      return { certDirConfigured: false, certDirWritable: dirCheck.writable, files: [] };
    }

    let dirReal: string;
    let entries: fs.Dirent[];
    try {
      dirReal = await fsp.realpath(this.certDir);
      entries = await fsp.readdir(dirReal, { withFileTypes: true });
    } catch {
      return { certDirConfigured: false, certDirWritable: false, files: [] };
    }

    const files: TlsDirFileInfo[] = [];
    for (const entry of entries) {
      if (!isSafeCertFilename(entry.name)) continue;
      const candidate = path.join(dirReal, entry.name);
      try {
        const real = await fsp.realpath(candidate);
        if (!isInsideDirectory(dirReal, real)) continue;
        const st = await fsp.stat(real);
        if (!st.isFile()) continue;
        files.push({
          name: entry.name,
          kind: classifyFileKind(entry.name),
          sizeBytes: st.size,
          updatedAt: st.mtime.toISOString(),
        });
      } catch {
        // 悬空 symlink 或无权读取的条目跳过，不拖垮目录扫描
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { certDirConfigured: true, certDirWritable: dirCheck.writable, files };
  }

  async getStatus(): Promise<AdminTlsView> {
    const scan = await this.scanDirectory();
    const flags = this.getRuntimeFlags();
    const activeCert =
      this.activeCert === null
        ? null
        : {
            ...this.activeCert,
            expired: flags.activeCertExpired,
            expiringSoon: flags.activeCertExpiringSoon,
          };
    return {
      enabled: this.enabled,
      tlsActive: this.enabled && this.secureContext !== null,
      certDirConfigured: scan.certDirConfigured,
      certDirWritable: scan.certDirWritable,
      certFile: this.certFile,
      keyFile: this.keyFile,
      availableFiles: scan.files,
      activeCert,
      lastReloadAt: this.lastReloadAt,
      lastReloadError: this.lastReloadError,
    };
  }

  private async atomicWriteFile(dirReal: string, targetPath: string, content: string, mode: number): Promise<void> {
    const tmpPath = path.join(dirReal, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
    let handle: fsp.FileHandle | null = null;
    try {
      handle = await fsp.open(tmpPath, 'w', mode);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.chmod(tmpPath, mode);
      await fsp.rename(tmpPath, targetPath);
    } catch (err) {
      if (handle !== null) await handle.close().catch(() => {});
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      if (isReadonlyFsError(err)) {
        throw new TlsConfigError('TLS_CERT_DIR_READONLY', 'certificate directory is not writable', { cause: err });
      }
      throw err;
    }
  }

  /** 将已通过校验的证书链与私钥原子写入磁盘 */
  async writeCertificatePair(input: {
    certPem: string;
    keyPem: string;
    certFile?: string;
    keyFile?: string;
  }): Promise<ParsedCertPair> {
    const certFile = input.certFile ?? DEFAULT_TLS_CERT_FILE;
    const keyFile = input.keyFile ?? DEFAULT_TLS_KEY_FILE;
    this.assertSafeFilename(certFile);
    this.assertSafeFilename(keyFile);

    const parsed = parseAndValidateCertPair(input.certPem, input.keyPem, this.now());
    const certTarget = await this.resolveContainedWritePath(certFile);
    const keyTarget = await this.resolveContainedWritePath(keyFile);

    this.suppressWatchUntilMs = this.now() + this.debounceMs + 300;
    await this.atomicWriteFile(certTarget.dirReal, certTarget.targetPath, input.certPem, 0o644);
    await this.atomicWriteFile(keyTarget.dirReal, keyTarget.targetPath, input.keyPem, 0o600);
    return parsed;
  }

  /** 面板上传或粘贴证书：先验后写，再按需入库与热切换 */
  async applyCertificateUpload(store: GatewayStore, input: ApplyCertificateInput): Promise<AdminTlsView> {
    const certFile = input.certFile ?? DEFAULT_TLS_CERT_FILE;
    const keyFile = input.keyFile ?? DEFAULT_TLS_KEY_FILE;
    const parsed = await this.writeCertificatePair({
      certPem: input.certPem,
      keyPem: input.keyPem,
      certFile,
      keyFile,
    });

    const nextEnabled = typeof input.enableTls === 'boolean' ? input.enableTls : this.enabled;
    await store.updateExtendedSettings({
      tlsCertFile: certFile,
      tlsKeyFile: keyFile,
      ...(typeof input.enableTls === 'boolean' ? { tlsEnabled: input.enableTls } : {}),
    });

    this.clearPendingTimers();
    this.certFile = certFile;
    this.keyFile = keyFile;
    this.enabled = nextEnabled;
    this.secureContext = nextEnabled ? parsed.secureContext : null;
    this.activeCert = parsed.summary;
    this.lastReloadAt = new Date(this.now()).toISOString();
    this.lastReloadError = null;
    if (nextEnabled) {
      // 若目录是上传新建的，确认 watcher 已装好以便后续宿主续期生效
      this.ensureWatcherRunning();
    }
    this.onContextChange?.({ enabled: this.enabled, secureContext: this.secureContext });
    return this.getStatus();
  }

  /** 在线切换 TLS 开关或激活目录里的其他证书文件名 */
  async applySettings(store: GatewayStore, input: ApplySettingsInput): Promise<AdminTlsView> {
    const nextCertFile = input.certFile ?? this.certFile;
    const nextKeyFile = input.keyFile ?? this.keyFile;
    this.assertSafeFilename(nextCertFile);
    this.assertSafeFilename(nextKeyFile);
    const nextEnabled = input.enabled ?? this.enabled;

    let parsed: ParsedCertPair | null = null;
    if (nextEnabled) {
      parsed = await this.loadPairFromDisk(nextCertFile, nextKeyFile);
    } else {
      parsed = await this.tryLoadPreviewSummaryPair(nextCertFile, nextKeyFile);
    }

    await store.updateExtendedSettings({
      ...(input.enabled !== undefined ? { tlsEnabled: input.enabled } : {}),
      ...(input.certFile !== undefined ? { tlsCertFile: nextCertFile } : {}),
      ...(input.keyFile !== undefined ? { tlsKeyFile: nextKeyFile } : {}),
    });

    this.clearPendingTimers();
    this.certFile = nextCertFile;
    this.keyFile = nextKeyFile;
    this.enabled = nextEnabled;
    this.secureContext = nextEnabled && parsed !== null ? parsed.secureContext : null;
    this.activeCert = parsed?.summary ?? null;
    if (nextEnabled) {
      this.lastReloadAt = new Date(this.now()).toISOString();
      this.ensureWatcherRunning();
    }
    this.lastReloadError = null;
    this.onContextChange?.({ enabled: this.enabled, secureContext: this.secureContext });
    return this.getStatus();
  }

  private async tryLoadPreviewSummaryPair(certFile: string, keyFile: string): Promise<ParsedCertPair | null> {
    try {
      return await this.loadPairFromDisk(certFile, keyFile);
    } catch {
      return null;
    }
  }

  /** 管理员主动触发从磁盘同步重载激活证书（失败不丢弃内存旧有效上下文） */
  async reloadFromDisk(): Promise<AdminTlsView> {
    this.clearPendingTimers();
    try {
      const pair = await this.loadPairFromDisk(this.certFile, this.keyFile);
      this.activeCert = pair.summary;
      this.lastReloadAt = new Date(this.now()).toISOString();
      this.lastReloadError = null;
      if (this.enabled) {
        this.secureContext = pair.secureContext;
        this.onContextChange?.({ enabled: true, secureContext: pair.secureContext });
      }
      return this.getStatus();
    } catch (err) {
      if (this.enabled) {
        const reloadErr = this.recordReloadFailure(err);
        this.onReloadFailed?.(reloadErr);
      }
      throw err;
    }
  }

  private recordReloadFailure(err: unknown): TlsReloadErrorView {
    const code = err instanceof TlsConfigError ? err.code : 'TLS_CERT_INVALID';
    const message = err instanceof TlsConfigError ? err.message : 'failed to reload TLS certificate from directory';
    const view: TlsReloadErrorView = {
      code,
      message,
      at: new Date(this.now()).toISOString(),
    };
    this.lastReloadError = view;
    return view;
  }

  private ensureWatcherRunning(): void {
    if (this.closed || this.watcher !== null) return;
    if (!fs.existsSync(this.certDir)) return;
    try {
      this.watcher = fs.watch(this.certDir, (_eventType, filename) => {
        if (this.closed) return;
        if (typeof filename === 'string' && filename.startsWith('.')) return;
        if (this.now() < this.suppressWatchUntilMs) return;
        this.scheduleDebouncedReload();
      });
      this.watcher.on('error', () => {
        // 挂载点重建或瞬态错误时关闭旧 watcher，待后续操作再挂载，绝不崩进程
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
  }

  startWatching(): void {
    this.ensureWatcherRunning();
  }

  private scheduleDebouncedReload(): void {
    if (this.closed) return;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.tryAutoReload(false);
    }, this.debounceMs);
  }

  private async tryAutoReload(isRetry: boolean): Promise<void> {
    if (this.closed) return;
    try {
      const pair = await this.loadPairFromDisk(this.certFile, this.keyFile);
      this.activeCert = pair.summary;
      this.lastReloadAt = new Date(this.now()).toISOString();
      this.lastReloadError = null;
      if (this.enabled) {
        this.secureContext = pair.secureContext;
        this.onContextChange?.({ enabled: true, secureContext: pair.secureContext });
      }
    } catch (err) {
      if (!this.enabled) {
        this.activeCert = await this.tryLoadPreviewSummary(this.certFile, this.keyFile);
        return;
      }
      if (!isRetry) {
        // 外部 acme.sh / certbot 顺序写入 cert 与 key 时，等待一次 retryMs 重试
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.tryAutoReload(true);
        }, this.retryMs);
        return;
      }
      const reloadErr = this.recordReloadFailure(err);
      this.onReloadFailed?.(reloadErr);
    }
  }

  private clearPendingTimers(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  close(): void {
    this.closed = true;
    this.clearPendingTimers();
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
