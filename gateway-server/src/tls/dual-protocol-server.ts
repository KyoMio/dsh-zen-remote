// 单端口（19393/tcp）双协议复用服务器（GT-2）：
//   - 在同一个 net.Server 上按连接首字节（0x16 = TLS ClientHello）分流明文 HTTP 与原生 TLS；
//   - TLS 启用时：
//       * 首字节 0x16 → 包裹为 tls.TLSSocket（打上 ZR_NATIVE_TLS_SYMBOL 标记）交内部 http.Server（REST + PeerWsHub wss）；
//       * 明文页面 GET/HEAD（非 /api、/peer、无 Upgrade）→ 302 Found + Cache-Control: no-store 跳转 https://；
//       * 明文 /api/*、/peer/*、非 GET/HEAD、明文 WS Upgrade → 426 Upgrade Required (TLS_REQUIRED JSON)；
//       * 严禁返回 301 / 308 / Strict-Transport-Security，避免后续关闭 TLS 时浏览器缓存锁死控制台。
//   - 在线热切换（setMode）：新 TCP 连接立刻走新模式；若 enabled 发生翻转，已建立且在响应中的
//     keep-alive 连接等当前响应完全 flush（res.once('finish')）后自然收尾，空闲旧连接立即关闭。
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

import type {
  AdminTlsView,
  ApplyCertificateInput,
  ApplySettingsInput,
  RuntimeTlsFlags,
} from './tls-manager.js';

/** 挂在原生 TLS socket 上的跨模块标记，供 auth.requestIsHttps 识别（不依赖 socket 实现细节） */
export const ZR_NATIVE_TLS_SYMBOL = Symbol.for('zr.gateway.nativeTls');

const PEEK_TIMEOUT_MS = 10_000;
const MAX_PLAINTEXT_HEAD_BYTES = 16 * 1024;
const SAFE_HOST_RE = /^(?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?$/;

/** HTTP 管理层与运行期 TLS 控制器的窄桥接契约（由 main.ts 组装，server/routes 消费） */
export interface GatewayTlsBridge {
  getRuntimeFlags(): RuntimeTlsFlags;
  getStatus(): Promise<AdminTlsView>;
  putCertificate(input: ApplyCertificateInput): Promise<AdminTlsView>;
  updateSettings(input: ApplySettingsInput): Promise<AdminTlsView>;
  reload(): Promise<AdminTlsView>;
}

export interface DualProtocolMode {
  enabled: boolean;
  secureContext: tls.SecureContext | null;
}

export interface DualProtocolServerOptions {
  requestHandler: (req: IncomingMessage, res: ServerResponse) => void;
  initialMode: DualProtocolMode;
}

export interface DualProtocolServer {
  readonly netServer: net.Server;
  /** 内部 http.Server（供 PeerWsHub.attach 与 GatewayInstance.server 复用，已代理 address/close 语义） */
  readonly httpServer: http.Server;
  isTlsEnabled(): boolean;
  setMode(next: DualProtocolMode): void;
  close(): Promise<void>;
}

interface TrackedConn {
  mode: 'http' | 'tls';
  rawSocket: net.Socket;
  transportSocket: net.Socket | tls.TLSSocket;
  activeResponses: number;
  drainAfterFinish: boolean;
  upgraded: boolean;
}

/** 校验并提取安全 Host（含合法端口），拦截 CRLF / `@` / 空白 / `/` 等注入形态 */
export function sanitizeRedirectHost(rawHost: string | undefined): string | null {
  if (typeof rawHost !== 'string') return null;
  const trimmed = rawHost.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return null;
  const match = SAFE_HOST_RE.exec(trimmed);
  if (match === null) return null;
  const portPart = match[1];
  if (portPart !== undefined) {
    const port = Number(portPart);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }
  return trimmed;
}

/** 剥离路径前导多斜杠 / 反斜杠，防止 `GET //evil.com` 变成跨站开放重定向 */
export function sanitizeRedirectTarget(rawTarget: string | undefined): string {
  if (typeof rawTarget !== 'string' || rawTarget.length === 0) return '/';
  if (/[\x00-\x1f\x7f]/.test(rawTarget)) return '/';
  let candidate = rawTarget;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      candidate = `${parsed.pathname}${parsed.search}`;
    } catch {
      return '/';
    }
  }
  const normalized = candidate.replace(/^[/\\]+/, '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function sendPlaintextRedirect(socket: net.Socket, method: string, host: string, target: string): void {
  const location = `https://${host}${target}`;
  const head =
    `HTTP/1.1 302 Found\r\n` +
    `Location: ${location}\r\n` +
    `Cache-Control: no-store\r\n` +
    `Content-Length: 0\r\n` +
    `Connection: close\r\n` +
    `\r\n`;
  if (!socket.destroyed) {
    socket.end(head);
  }
  void method;
}

const TLS_REQUIRED_BODY = JSON.stringify({
  ok: false,
  error: {
    code: 'TLS_REQUIRED',
    message: 'TLS is enabled on this port; connect using https:// or wss://',
  },
});
const TLS_REQUIRED_BYTES = Buffer.byteLength(TLS_REQUIRED_BODY, 'utf8');

function sendPlaintextTlsRequired(socket: net.Socket, method: string): void {
  const head =
    `HTTP/1.1 426 Upgrade Required\r\n` +
    `Upgrade: TLS/1.2\r\n` +
    `Content-Type: application/json; charset=utf-8\r\n` +
    `Cache-Control: no-store\r\n` +
    `Content-Length: ${TLS_REQUIRED_BYTES}\r\n` +
    `Connection: close\r\n` +
    `\r\n`;
  if (socket.destroyed) return;
  socket.end(method === 'HEAD' ? head : `${head}${TLS_REQUIRED_BODY}`);
}

function handlePlaintextOnTlsPort(socket: net.Socket, initialHead: string): void {
  const lines = initialHead.split('\r\n');
  const requestLine = lines[0] ?? '';
  const parts = requestLine.split(' ');
  const method = (parts[0] ?? '').toUpperCase();
  const rawTarget = parts[1] ?? '/';

  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.length === 0) break;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    if (!headers.has(key)) headers.set(key, val);
  }

  const safeHost = sanitizeRedirectHost(headers.get('host'));
  const safeTarget = sanitizeRedirectTarget(rawTarget);
  const pathname = safeTarget.split(/[?#]/, 1)[0] ?? '/';
  const isApiOrPeer =
    pathname === '/api' || pathname.startsWith('/api/') || pathname === '/peer' || pathname.startsWith('/peer/');
  const hasUpgrade = headers.has('upgrade');

  if ((method === 'GET' || method === 'HEAD') && !hasUpgrade && !isApiOrPeer && safeHost !== null) {
    sendPlaintextRedirect(socket, method, safeHost, safeTarget);
    return;
  }
  sendPlaintextTlsRequired(socket, method);
}

/** 读完明文 HTTP 请求头（限 16 KB 与 PEEK_TIMEOUT_MS）后分派 302 或 426 */
function readPlaintextRequestAndRespond(socket: net.Socket): void {
  let buffer = '';
  let finished = false;

  const cleanup = (): void => {
    clearTimeout(timer);
    socket.removeListener('data', onData);
    socket.removeListener('end', onEnd);
    socket.removeListener('error', onError);
    socket.removeListener('close', onError);
  };

  const abort = (): void => {
    if (finished) return;
    finished = true;
    cleanup();
    if (!socket.destroyed) socket.destroy();
  };

  const timer = setTimeout(abort, PEEK_TIMEOUT_MS);

  const onEnd = (): void => {
    if (finished) return;
    finished = true;
    cleanup();
    if (buffer.length > 0) handlePlaintextOnTlsPort(socket, buffer);
    else if (!socket.destroyed) socket.end();
  };

  const onError = (): void => {
    abort();
  };

  const onData = (chunk: Buffer): void => {
    if (finished) return;
    buffer += chunk.toString('latin1');
    const headEnd = buffer.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      finished = true;
      cleanup();
      handlePlaintextOnTlsPort(socket, buffer.slice(0, headEnd));
      return;
    }
    if (buffer.length > MAX_PLAINTEXT_HEAD_BYTES) {
      abort();
    }
  };

  socket.on('data', onData);
  socket.once('end', onEnd);
  socket.once('error', onError);
  socket.once('close', onError);
  socket.resume();
}

export function createDualProtocolServer(options: DualProtocolServerOptions): DualProtocolServer {
  let tlsEnabled = options.initialMode.enabled && options.initialMode.secureContext !== null;
  let currentSecureContext = options.initialMode.secureContext;
  let closing = false;
  let netClosePromise: Promise<void> | null = null;

  const trackedConns = new Set<TrackedConn>();
  const byTransport = new WeakMap<net.Socket, TrackedConn>();

  const finalizeDrain = (entry: TrackedConn): void => {
    if (entry.transportSocket.destroyed) return;
    entry.transportSocket.end();
    const forceDestroy = setTimeout(() => {
      if (!entry.rawSocket.destroyed) entry.rawSocket.destroy();
    }, 100);
    forceDestroy.unref();
  };

  // 在调用 options.requestHandler 前登记 activeResponses，确保同步响应或句柄内触发 setMode 时不会错过在途请求计数
  const trackedRequestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    const entry = byTransport.get(req.socket as net.Socket);
    if (entry !== undefined) {
      entry.activeResponses += 1;
      let decremented = false;
      const onDone = (): void => {
        if (decremented) return;
        decremented = true;
        entry.activeResponses = Math.max(0, entry.activeResponses - 1);
        if (entry.drainAfterFinish && entry.activeResponses === 0) {
          finalizeDrain(entry);
        }
      };
      res.once('finish', onDone);
      res.once('close', onDone);
    }
    options.requestHandler(req, res);
  };

  const httpServer = http.createServer(trackedRequestHandler);

  const trackConn = (entry: TrackedConn): void => {
    trackedConns.add(entry);
    byTransport.set(entry.transportSocket, entry);
    entry.transportSocket.once('close', () => {
      trackedConns.delete(entry);
      byTransport.delete(entry.transportSocket);
    });
  };

  httpServer.on('upgrade', (req) => {
    const entry = byTransport.get(req.socket as net.Socket);
    if (entry !== undefined) {
      entry.upgraded = true;
    }
  });

  const handOffToPlainHttp = (socket: net.Socket): void => {
    if (closing || socket.destroyed) {
      socket.destroy();
      return;
    }
    const entry: TrackedConn = {
      mode: 'http',
      rawSocket: socket,
      transportSocket: socket,
      activeResponses: 0,
      drainAfterFinish: false,
      upgraded: false,
    };
    trackConn(entry);
    httpServer.emit('connection', socket);
    socket.resume();
  };

  const handOffToTls = (socket: net.Socket, secureContext: tls.SecureContext): void => {
    if (closing || socket.destroyed) {
      socket.destroy();
      return;
    }
    const tlsSocket = new tls.TLSSocket(socket, {
      isServer: true,
      secureContext,
    });
    (tlsSocket as unknown as Record<symbol, unknown>)[ZR_NATIVE_TLS_SYMBOL] = true;
    tlsSocket.on('error', () => {
      if (!tlsSocket.destroyed) tlsSocket.destroy();
      if (!socket.destroyed) socket.destroy();
    });
    const entry: TrackedConn = {
      mode: 'tls',
      rawSocket: socket,
      transportSocket: tlsSocket,
      activeResponses: 0,
      drainAfterFinish: false,
      upgraded: false,
    };
    trackConn(entry);
    httpServer.emit('connection', tlsSocket);
  };

  const sniffAndRoute = (socket: net.Socket, secureContext: tls.SecureContext): void => {
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeListener('readable', onReadable);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
      socket.removeListener('close', onError);
    };

    const abort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!socket.destroyed) socket.destroy();
    };

    const timer = setTimeout(abort, PEEK_TIMEOUT_MS);

    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!socket.destroyed) socket.end();
    };

    const onError = (): void => {
      abort();
    };

    const onReadable = (): void => {
      if (settled) return;
      const byte = socket.read(1) as Buffer | null;
      if (byte === null || byte.length === 0) {
        if (socket.readableEnded || socket.destroyed) {
          onEnd();
        } else {
          socket.once('readable', onReadable);
        }
        return;
      }

      settled = true;
      cleanup();
      socket.pause();
      socket.unshift(byte);

      if (closing) {
        socket.destroy();
        return;
      }

      if (byte[0] === 0x16) {
        // 首字节 0x16 = TLS Handshake ClientHello
        const ctx = currentSecureContext ?? secureContext;
        handOffToTls(socket, ctx);
        return;
      }

      // 明文请求打到已开启 TLS 的同一端口：由明文分流器决定 302 跳转还是 426 TLS_REQUIRED
      readPlaintextRequestAndRespond(socket);
    };

    socket.once('readable', onReadable);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.once('close', onError);
  };

  const netServer = net.createServer({ pauseOnConnect: true }, (socket) => {
    socket.on('error', () => {
      if (!socket.destroyed) socket.destroy();
    });
    if (closing) {
      socket.destroy();
      return;
    }
    if (!tlsEnabled || currentSecureContext === null) {
      handOffToPlainHttp(socket);
      return;
    }
    sniffAndRoute(socket, currentSecureContext);
  });

  const stopNetAccepting = (): Promise<void> => {
    if (netClosePromise === null) {
      netClosePromise = new Promise<void>((resolve) => {
        if (!netServer.listening) {
          resolve();
          return;
        }
        netServer.close(() => resolve());
      });
    }
    return netClosePromise;
  };

  const destroyIdleTracked = (): void => {
    for (const entry of trackedConns) {
      if (entry.activeResponses === 0 && !entry.upgraded) {
        entry.transportSocket.destroy();
        entry.rawSocket.destroy();
      }
    }
  };

  const destroyAllTracked = (): void => {
    for (const entry of trackedConns) {
      entry.transportSocket.destroy();
      entry.rawSocket.destroy();
    }
  };

  const origCloseIdle = httpServer.closeIdleConnections?.bind(httpServer);
  const origCloseAll = httpServer.closeAllConnections?.bind(httpServer);

  const close = async (): Promise<void> => {
    closing = true;
    origCloseIdle?.();
    origCloseAll?.();
    destroyAllTracked();
    await stopNetAccepting();
  };

  // 让内部未直接 listen() 的 httpServer 在被外部调 address()/close() 时表现与真实监听 server 一致
  httpServer.address = () => netServer.address();
  httpServer.closeIdleConnections = () => {
    origCloseIdle?.();
    destroyIdleTracked();
  };
  httpServer.closeAllConnections = () => {
    origCloseAll?.();
    destroyAllTracked();
  };
  httpServer.close = (cb?: (err?: Error) => void): http.Server => {
    closing = true;
    void stopNetAccepting().then(
      () => cb?.(),
      (err) => cb?.(err instanceof Error ? err : new Error(String(err))),
    );
    return httpServer;
  };

  return {
    netServer,
    httpServer,
    isTlsEnabled: () => tlsEnabled,
    setMode(next: DualProtocolMode): void {
      const prevEnabled = tlsEnabled;
      const nextEnabled = next.enabled && next.secureContext !== null;
      tlsEnabled = nextEnabled;
      currentSecureContext = next.secureContext;
      if (prevEnabled === nextEnabled) {
        return; // 仅证书续期换 SecureContext 时不中断已有连接，新握手直接生效
      }
      const oldMode: 'http' | 'tls' = prevEnabled ? 'tls' : 'http';
      for (const entry of trackedConns) {
        if (entry.mode !== oldMode) continue;
        if (entry.activeResponses === 0) {
          entry.transportSocket.destroy();
          entry.rawSocket.destroy();
        } else {
          entry.drainAfterFinish = true;
        }
      }
    },
    close,
  };
}
