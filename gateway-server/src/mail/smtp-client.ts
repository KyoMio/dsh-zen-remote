// 零依赖 SMTP 发信客户端（RFC 5321 子集）：node:net + node:tls + node:crypto。
//
// 支持三种安全模式：tls（隐式 TLS，通常 465）/ starttls（明文起、升级加密，通常 587）/
// none（纯明文，仅限本机或完全可信内网）。认证支持 AUTH PLAIN（优先）与 AUTH LOGIN。
// 邮件正文用 8bit + RFC 5321 点填充直发 UTF-8 明文，主题与显示名按 RFC 2047 编码。
//
// 错误消息一律不得包含 config.password：AUTH 阶段的失败只报状态码，不回显任何响应正文。
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

export type SmtpSecurityMode = 'tls' | 'starttls' | 'none';

export interface SmtpConfig {
  /** SMTP 服务器主机名或 IP */
  host: string;
  /** 端口，1..65535 */
  port: number;
  /** 安全模式：tls 隐式加密 / starttls 明文升级 / none 纯明文 */
  security: SmtpSecurityMode;
  /** 认证用户名；缺省或空串表示匿名发信 */
  username?: string;
  /** 认证密码；只在 AUTH 阶段经 base64 进线，绝不进任何错误消息或日志 */
  password?: string;
  /** 发件人地址 */
  fromAddress: string;
  /** 发件人显示名，可选（RFC 2047 编码） */
  fromName?: string;
  /** 校验服务器证书，默认 true（自签测试证书时显式传 false） */
  rejectUnauthorized?: boolean;
  /** 单次空闲等待（响应/握手）超时毫秒数，默认 15000 */
  timeoutMs?: number;
  /** EHLO 问候里的本机域名，默认 'gateway.local' */
  ehloDomain?: string;
}

export interface SendMailInput {
  /** 收件人地址（单地址） */
  to: string;
  /** 主题，非 ASCII 自动 RFC 2047 Base64 编码 */
  subject: string;
  /** 纯文本正文，行结束符统一转为 CRLF 并做点填充 */
  text: string;
}

export type SmtpErrorCode =
  | 'SMTP_HEADER_INJECTION'
  | 'SMTP_INVALID_CONFIG'
  | 'SMTP_CONNECT_FAILED'
  | 'SMTP_TIMEOUT'
  | 'SMTP_AUTH_FAILED'
  | 'SMTP_TLS_FAILED'
  | 'SMTP_PROTOCOL_ERROR'
  | 'SMTP_REJECTED';

export class SmtpClientError extends Error {
  readonly code: SmtpErrorCode;
  /** 触发错误的服务器响应码（如 535），本地校验类错误没有此值 */
  readonly smtpStatus?: number;

  constructor(code: SmtpErrorCode, message: string, smtpStatus?: number) {
    super(message);
    this.name = 'SmtpClientError';
    this.code = code;
    this.smtpStatus = smtpStatus;
    // 修 Error 子类的原型链（防御性，target ES2023 已原生支持）
    Object.setPrototypeOf(this, SmtpClientError.prototype);
  }
}

// ---------------------------------------------------------------- 校验

/** 字段命中 CR / LF / NUL 即为头部注入企图（在建立任何连接之前拦截） */
function rejectHeaderInjection(fields: Array<[string, string | undefined]>): void {
  for (const [name, value] of fields) {
    if (value === undefined) continue;
    if (/[\r\n\0]/.test(value)) {
      throw new SmtpClientError('SMTP_HEADER_INJECTION', `field ${name} contains CR/LF/NUL (header injection)`);
    }
  }
}

/** 单地址格式：不含空白与尖括号，有且只有一个 @，域名至少一段非空标签 */
function isValidAddress(address: string): boolean {
  if (/\s|[<>]/.test(address)) return false;
  const at = address.indexOf('@');
  if (at <= 0 || at !== address.lastIndexOf('@')) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!local || !domain) return false;
  return /^[^\s.@]+(?:\.[^\s.@]+)*$/.test(domain);
}

/** 发包前的同步总校验：先注入检查（连接都还没建），再格式检查 */
function validateAll(config: SmtpConfig, input: SendMailInput): void {
  rejectHeaderInjection([
    ['host', config.host],
    ['fromAddress', config.fromAddress],
    ['fromName', config.fromName],
    ['to', input.to],
    ['subject', input.subject],
    ['username', config.username],
    ['ehloDomain', config.ehloDomain],
  ]);
  if (!config.host || typeof config.host !== 'string') {
    throw new SmtpClientError('SMTP_INVALID_CONFIG', 'host must be a non-empty string');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new SmtpClientError('SMTP_INVALID_CONFIG', `port must be an integer in [1, 65535], got ${config.port}`);
  }
  if (config.security !== 'tls' && config.security !== 'starttls' && config.security !== 'none') {
    throw new SmtpClientError(
      'SMTP_INVALID_CONFIG',
      `security must be 'tls' | 'starttls' | 'none', got ${JSON.stringify(config.security)}`,
    );
  }
  if (!isValidAddress(config.fromAddress)) {
    throw new SmtpClientError('SMTP_INVALID_CONFIG', `fromAddress is not a valid single mailbox: ${JSON.stringify(config.fromAddress)}`);
  }
  if (!isValidAddress(input.to)) {
    throw new SmtpClientError('SMTP_INVALID_CONFIG', `to is not a valid single mailbox: ${JSON.stringify(input.to)}`);
  }
}

// ---------------------------------------------------------------- RFC 2047 与正文构造

const NON_ASCII_RE = /[^\x20-\x7E]/;
/** 单个 RFC 2047 编码词允许的最大 UTF-8 字节数（75 字符编码词壳占 10 + base64 4/3 膨胀） */
const RFC2047_CHUNK_BYTES = 45;

/**
 * RFC 2047 编码词：纯 ASCII 原样返回；含非 ASCII 时分块 Base64，每块 UTF-8 字节
 * 不超过 45 字节（编码词 ≤ 75 字符），块之间用 CRLF + 空格折叠。
 * 按码点累计字节切块，绝不从多字节字符中间劈开（RFC 2047 §5）。
 */
function encodeRfc2047(text: string): string {
  if (!NON_ASCII_RE.test(text)) return text;
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (current !== '' && currentBytes + charBytes > RFC2047_CHUNK_BYTES) {
      chunks.push(`=?UTF-8?B?${Buffer.from(current, 'utf8').toString('base64')}?=`);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current !== '') {
    chunks.push(`=?UTF-8?B?${Buffer.from(current, 'utf8').toString('base64')}?=`);
  }
  return chunks.join('\r\n ');
}

/** 显示名里的协议特殊字符（出现即整体加引号转义） */
const DISPLAY_NAME_SPECIALS_RE = /[()<>[\]:;@\\,."]/;

function formatFromHeader(config: SmtpConfig): string {
  if (!config.fromName) return config.fromAddress;
  if (NON_ASCII_RE.test(config.fromName)) {
    return `${encodeRfc2047(config.fromName)} <${config.fromAddress}>`;
  }
  if (DISPLAY_NAME_SPECIALS_RE.test(config.fromName)) {
    return `"${config.fromName.replace(/([\\"])/g, '\\$1')}" <${config.fromAddress}>`;
  }
  return `${config.fromName} <${config.fromAddress}>`;
}

/** \r\n / \n / \r 统一归一为 CRLF */
export function normalizeToCrlf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').join('\r\n');
}

/** RFC 5321 点填充：以 . 开头的行前置一个额外的 . */
function dotStuff(body: string): string {
  return body
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

function formatRfc5322Date(date: Date): string {
  // toUTCString 即 "Wed, 13 Nov 2026 08:00:00 GMT"，把 GMT 换成 +0000 更贴 RFC 5322
  const formatted = date.toUTCString().replace(/ GMT$/, '+0000');
  const rfc5322Shape = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/;
  if (rfc5322Shape.test(formatted)) return formatted;
  // 极端情形（引擎实现差异）退回手工拼接
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}` +
    ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

/** 构造完整 DATA payload：头 + 空行 + 点填充正文 + 独立成行的终止符 */
function buildDataPayload(config: SmtpConfig, input: SendMailInput): string {
  const fromDomain = config.fromAddress.split('@')[1] ?? 'gateway.local';
  const headers = [
    `From: ${formatFromHeader(config)}`,
    `To: ${input.to}`,
    `Subject: ${encodeRfc2047(input.subject)}`,
    `Date: ${formatRfc5322Date(new Date())}`,
    `Message-ID: <${randomUUID()}@${fromDomain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ].join('\r\n');
  // 正文补足尾 CRLF 后直接接终止行「.」：终止符必须独立成行，且不能多出一个空行
  const normalized = normalizeToCrlf(input.text);
  const body = normalized.endsWith('\r\n') ? normalized : `${normalized}\r\n`;
  return `${headers}\r\n\r\n${dotStuff(body)}.\r\n`;
}

// ---------------------------------------------------------------- 会话状态机

interface SmtpReply {
  code: number;
  /** 各行去掉三位码与分隔符后的文本 */
  lines: string[];
}

/**
 * 解析一条完整应答（多行以 NNN- 继续、NNN␣ 终止）。
 * 缓冲里已有终止行就返回并留下余量；末尾是半行或还没出现终止行则返回 undefined 等数据。
 */
function tryParseReply(buffer: string): { reply: SmtpReply; rest: string } | undefined {
  const segments = buffer.split('\r\n');
  const lines: string[] = [];
  let code = 0;
  const lastIndex = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    // split 出的最后一段还没有 CRLF 闭合（可能只是半行，如 "250 " 后面断开），
    // 一律等下一块数据；'' 结尾且只见到继续行同样说明终止行还没到
    if (segment === undefined || i === lastIndex) return undefined;
    const match = /^(\d{3})([- ])(.*)$/.exec(segment);
    if (match === null) {
      throw new SmtpClientError('SMTP_PROTOCOL_ERROR', `malformed SMTP reply line: ${JSON.stringify(segment.slice(0, 80))}`);
    }
    code = Number(match[1]);
    lines.push(match[3] ?? '');
    if (match[2] === ' ') {
      return { reply: { code, lines }, rest: segments.slice(i + 1).join('\r\n') };
    }
  }
  return undefined;
}

type ErrorClassifier = (err: Error) => Error;

/**
 * 单条 SMTP 连接的状态机：行缓冲、多行应答解析、空闲超时、错误归拢。
 * 所有失败（超时/协议错误/连接断开/系统错误）都经 fail() 收口：销毁 socket 并拒绝挂起中的 readReply。
 */
class SmtpSession {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = '';
  private pending: { resolve: (reply: SmtpReply) => void; reject: (err: Error) => void } | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private finished = false;
  private errorClassifier: ErrorClassifier;

  constructor(socket: net.Socket | tls.TLSSocket, private readonly timeoutMs: number, errorClassifier: ErrorClassifier) {
    this.socket = socket;
    this.errorClassifier = errorClassifier;
    this.attach(socket);
    this.armIdleTimer();
  }

  /** STARTTLS 升级后换绑到 TLSSocket（并让后续系统错误归入 TLS 失败） */
  replaceSocket(socket: net.Socket | tls.TLSSocket, errorClassifier: ErrorClassifier): void {
    this.detach(this.socket);
    this.socket = socket;
    this.errorClassifier = errorClassifier;
    this.attach(socket);
  }

  /** 升级握手期间让位：idle 定时器暂停，由握手套件自己的超时（SMTP_TIMEOUT）收口 */
  pauseIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  resumeIdleTimer(): void {
    this.armIdleTimer();
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  private detach(socket: net.Socket | tls.TLSSocket): void {
    socket.removeListener('data', this.onData);
    socket.removeListener('error', this.onError);
    socket.removeListener('close', this.onClose);
  }

  private onData = (chunk: Buffer): void => {
    if (this.finished) return;
    this.buffer += chunk.toString('utf8');
    // 缓冲里可能积压多条应答，逐条取出分发给等待者
    while (true) {
      let parsed: { reply: SmtpReply; rest: string } | undefined;
      try {
        parsed = tryParseReply(this.buffer);
      } catch (err) {
        this.fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (parsed === undefined) break;
      this.buffer = parsed.rest;
      const pending = this.pending;
      this.pending = undefined;
      if (pending !== undefined) {
        pending.resolve(parsed.reply);
        this.armIdleTimer();
      }
    }
  };

  private onError = (err: Error): void => {
    this.fail(this.errorClassifier(err));
  };

  private onClose = (): void => {
    if (!this.finished) {
      this.fail(new SmtpClientError('SMTP_PROTOCOL_ERROR', 'connection closed before the SMTP session finished'));
    }
  };

  private armIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.fail(new SmtpClientError('SMTP_TIMEOUT', `SMTP server idle for more than ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    // 不阻止进程退出：测试或宿主收尾时定时器不应把进程吊住
    this.idleTimer.unref?.();
  }

  /** 所有失败的收口：标记结束、清定时器、销毁 socket、拒绝挂起中的等待 */
  fail(err: Error): void {
    if (this.finished) return;
    this.finished = true;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.socket.destroy();
    const pending = this.pending;
    this.pending = undefined;
    if (pending !== undefined) pending.reject(err);
  }

  /** 成功收尾：清定时器，end() 冲刷写缓冲（QUIT）后发 FIN；对端迟迟不关时 3s 兜底强断 */
  destroy(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    // 不能直接 destroy：它会丢弃 Node 层还没写进内核的写缓冲，QUIT 可能整个丢掉
    this.socket.end();
    const killer = setTimeout(() => this.socket.destroy(), DESTROY_GRACE_MS);
    killer.unref?.();
    this.socket.once('close', () => clearTimeout(killer));
  }

  writeLine(line: string): void {
    if (this.finished) throw new SmtpClientError('SMTP_PROTOCOL_ERROR', 'SMTP session already closed');
    this.socket.write(`${line}\r\n`);
  }

  /** DATA payload 一次性写出（多行直发，终止符已在 payload 内） */
  writeRaw(payload: string): void {
    if (this.finished) throw new SmtpClientError('SMTP_PROTOCOL_ERROR', 'SMTP session already closed');
    this.socket.write(payload, 'utf8');
  }

  /** 读取一条完整应答（缓冲里已有就立即返回） */
  readReply(): Promise<SmtpReply> {
    if (this.finished) return Promise.reject(new SmtpClientError('SMTP_PROTOCOL_ERROR', 'SMTP session already closed'));
    let immediate: { reply: SmtpReply; rest: string } | undefined;
    try {
      immediate = tryParseReply(this.buffer);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.fail(error);
      return Promise.reject(error);
    }
    if (immediate !== undefined) {
      this.buffer = immediate.rest;
      return Promise.resolve(immediate.reply);
    }
    return new Promise<SmtpReply>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  /** 发命令并等应答 */
  async command(line: string): Promise<SmtpReply> {
    this.writeLine(line);
    return this.readReply();
  }

  get socketRef(): net.Socket | tls.TLSSocket {
    return this.socket;
  }
}

// ---------------------------------------------------------------- 连接与升级

function isConnectPhaseError(err: Error): Error {
  // 连接建立阶段的系统错误（ECONNREFUSED / ENOTFOUND / EHOSTUNREACH…）归为连接失败
  return new SmtpClientError('SMTP_CONNECT_FAILED', `cannot connect to SMTP server: ${err.message}`);
}

function asTlsError(err: Error): Error {
  return new SmtpClientError('SMTP_TLS_FAILED', `TLS connection to SMTP server failed: ${err.message}`);
}

/**
 * 连接 / 握手阶段的兜底：idle 定时器此时尚未接管（或已让位），任何阶段挂起都必须
 * 由这里的超时与 'close' 兜底收口——销毁 socket 并 reject，绝不留下半开连接。
 */
function connectPlain(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(
      () => fail(new SmtpClientError('SMTP_TIMEOUT', `TCP connection to SMTP server timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    const onError = (err: Error) => fail(isConnectPhaseError(err));
    const onClose = () => fail(new SmtpClientError('SMTP_CONNECT_FAILED', 'connection closed while connecting to the SMTP server'));
    function fail(err: Error): void {
      clearTimeout(timer);
      socket.destroy();
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      reject(err);
    }
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      resolve(socket);
    });
  });
}

function connectImplicitTls(host: string, port: number, rejectUnauthorized: boolean, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: tlsServername(host), rejectUnauthorized }, () => finish());
    const timer = setTimeout(
      () => fail(new SmtpClientError('SMTP_TIMEOUT', `TLS handshake with SMTP server timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    const onError = (err: Error) => fail(asTlsError(err));
    const onClose = () => fail(new SmtpClientError('SMTP_TLS_FAILED', 'connection closed during the TLS handshake'));
    function fail(err: Error): void {
      clearTimeout(timer);
      socket.destroy();
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      reject(err);
    }
    function finish(): void {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      resolve(socket);
    }
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

/**
 * STARTTLS：在既有明文 socket 上完成 TLS 握手（错误统一归 SMTP_TLS_FAILED，超时归 SMTP_TIMEOUT）。
 * removeAllListeners 之后底层关闭可能只发 'close' 不发 'error'，'close' 兜底保证 Promise 必定落定。
 */
function upgradeTlsOnSocket(socket: net.Socket | tls.TLSSocket, host: string, rejectUnauthorized: boolean, timeoutMs: number): Promise<tls.TLSSocket> {
  if (!(socket instanceof net.Socket)) {
    return Promise.reject(new SmtpClientError('SMTP_TLS_FAILED', 'underlying socket is not upgradable'));
  }
  socket.removeAllListeners(); // STARTTLS 应答已消费，旧监听全部让位给 TLS 层
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: tlsServername(host), rejectUnauthorized }, () => finish());
    const timer = setTimeout(
      () => fail(new SmtpClientError('SMTP_TIMEOUT', `TLS handshake after STARTTLS timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    const onError = (err: Error) => fail(asTlsError(err));
    const onClose = () => fail(new SmtpClientError('SMTP_TLS_FAILED', 'connection closed during the TLS handshake after STARTTLS'));
    function fail(err: Error): void {
      clearTimeout(timer);
      tlsSocket.destroy();
      tlsSocket.removeListener('error', onError);
      tlsSocket.removeListener('close', onClose);
      reject(err);
    }
    function finish(): void {
      clearTimeout(timer);
      tlsSocket.removeListener('error', onError);
      tlsSocket.removeListener('close', onClose);
      resolve(tlsSocket);
    }
    tlsSocket.once('error', onError);
    tlsSocket.once('close', onClose);
  });
}

// ---------------------------------------------------------------- 认证

/** 解析 EHLO 能力行里的 AUTH 机制清单；没有 AUTH 行返回 null，有 AUTH 行但不含 PLAIN/LOGIN 返回空数组 */
function parseAuthMechanisms(ehloLines: string[]): string[] | null {
  for (const line of ehloLines) {
    const match = /^AUTH[= ](.+)$/i.exec(line);
    if (match !== null) {
      return (match[1] ?? '')
        .trim()
        .split(/\s+/)
        .map((mech) => mech.toUpperCase())
        .filter((mech) => mech === 'PLAIN' || mech === 'LOGIN');
    }
  }
  return null;
}

/** AUTH 阶段的失败一律固定文案 + 状态码，绝不携带响应正文（更不可能携带密码） */
function authFailed(reply: SmtpReply): SmtpClientError {
  return new SmtpClientError('SMTP_AUTH_FAILED', `SMTP authentication failed (status ${reply.code})`, reply.code);
}

async function authenticate(session: SmtpSession, config: SmtpConfig, ehloLines: string[]): Promise<void> {
  const username = config.username ?? '';
  if (!username) return;
  const password = config.password ?? '';

  const advertised = parseAuthMechanisms(ehloLines);
  // 服务端未声明 AUTH 能力时按 PLAIN → LOGIN 顺序回退尝试；声明了就只在其支持的机制里选
  const candidates = advertised ?? ['PLAIN', 'LOGIN'];
  const mechanism = ['PLAIN', 'LOGIN'].find((mech) => candidates.includes(mech));
  if (mechanism === undefined) {
    throw new SmtpClientError('SMTP_AUTH_FAILED', 'server does not advertise a supported AUTH mechanism (PLAIN or LOGIN)');
  }

  if (mechanism === 'PLAIN') {
    const blob = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
    const reply = await session.command(`AUTH PLAIN ${blob}`);
    if (reply.code !== 235) throw authFailed(reply);
    return;
  }

  // AUTH LOGIN：两轮 334 挑战，分别回 base64(用户名) 与 base64(密码)
  const challenge1 = await session.command('AUTH LOGIN');
  if (challenge1.code !== 334) throw authFailed(challenge1);
  const challenge2 = await session.command(Buffer.from(username, 'utf8').toString('base64'));
  if (challenge2.code !== 334) throw authFailed(challenge2);
  const finalReply = await session.command(Buffer.from(password, 'utf8').toString('base64'));
  if (finalReply.code !== 235) throw authFailed(finalReply);
}

// ---------------------------------------------------------------- 主流程

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_EHLO_DOMAIN = 'gateway.local';
/** end() 之后等对端关连接的兜底毫秒数，超时强断 */
const DESTROY_GRACE_MS = 3000;

/** SNI 不能放 IP 地址（RFC 6066）；IP 直连时交给 Node 按 host 自行校验 */
function tlsServername(host: string): string | undefined {
  return net.isIP(host) > 0 ? undefined : host;
}

function expectReply(reply: SmtpReply, accepted: number[], what: string, code: SmtpErrorCode): void {
  if (!accepted.includes(reply.code)) {
    throw new SmtpClientError(code, `${what} failed (status ${reply.code}): ${reply.lines[0] ?? ''}`.trim(), reply.code);
  }
}

/** 建立会话：连接 → greeting → EHLO（starttls 模式在此升级 TLS 后重新 EHLO） */
async function openSession(config: SmtpConfig): Promise<{ session: SmtpSession; ehloLines: string[] }> {
  const timeoutMs =
    typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const rejectUnauthorized = config.rejectUnauthorized ?? true;

  let socket: net.Socket | tls.TLSSocket;
  let classifier: ErrorClassifier = isConnectPhaseError;
  if (config.security === 'tls') {
    socket = await connectImplicitTls(config.host, config.port, rejectUnauthorized, timeoutMs);
    classifier = asTlsError;
  } else {
    socket = await connectPlain(config.host, config.port, timeoutMs);
  }

  const session = new SmtpSession(socket, timeoutMs, classifier);
  try {
    const greeting = await session.readReply();
    expectReply(greeting, [220], 'SMTP greeting', 'SMTP_PROTOCOL_ERROR');

    const ehloDomain = config.ehloDomain ?? DEFAULT_EHLO_DOMAIN;
    let ehlo = await session.command(`EHLO ${ehloDomain}`);
    expectReply(ehlo, [250], 'EHLO', 'SMTP_PROTOCOL_ERROR');

    if (config.security === 'starttls') {
      if (!ehlo.lines.some((line) => line.trim().toUpperCase() === 'STARTTLS')) {
        throw new SmtpClientError('SMTP_TLS_FAILED', 'server does not advertise STARTTLS capability');
      }
      const starttlsReply = await session.command('STARTTLS');
      expectReply(starttlsReply, [220], 'STARTTLS', 'SMTP_TLS_FAILED');

      // 升级期间 idle 定时器让位：握手挂起由 upgradeTlsOnSocket 的超时收口，错误码稳定为 SMTP_TIMEOUT
      session.pauseIdleTimer();
      try {
        const tlsSocket = await upgradeTlsOnSocket(session.socketRef, config.host, rejectUnauthorized, timeoutMs);
        session.replaceSocket(tlsSocket, asTlsError);
      } finally {
        session.resumeIdleTimer();
      }

      ehlo = await session.command(`EHLO ${ehloDomain}`);
      expectReply(ehlo, [250], 'EHLO after STARTTLS', 'SMTP_PROTOCOL_ERROR');
    }

    return { session, ehloLines: ehlo.lines };
  } catch (err) {
    session.fail(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

/**
 * 发送一封纯文本邮件。整个会话结束（成功、失败、拒绝、超时）都在 finally 里
 * 清理定时器并销毁 socket，不留句柄。
 */
export async function sendMail(config: SmtpConfig, input: SendMailInput): Promise<void> {
  validateAll(config, input);

  const { session, ehloLines } = await openSession(config);
  try {
    await authenticate(session, config, ehloLines);

    expectReply(await session.command(`MAIL FROM:<${config.fromAddress}>`), [250], 'MAIL FROM', 'SMTP_REJECTED');
    const rcpt = await session.command(`RCPT TO:<${input.to}>`);
    expectReply(rcpt, [250, 251], 'RCPT TO', 'SMTP_REJECTED');
    const data = await session.command('DATA');
    if (data.code !== 354) {
      throw new SmtpClientError('SMTP_REJECTED', `DATA failed (status ${data.code}): ${data.lines[0] ?? ''}`.trim(), data.code);
    }

    session.writeRaw(buildDataPayload(config, input));
    expectReply(await session.readReply(), [250], 'message data', 'SMTP_REJECTED');

    session.writeLine('QUIT'); // 不等 221：字节已进内核缓冲，destroy 前 TCP 保证送达
  } finally {
    session.destroy();
  }
}
