// 控制台静态托管（PG-6b）：把 dist/public 的编译产物发给浏览器。
//
// 缓存与安全头两档：
//   /assets/*（Vite 全部哈希文件名）→ immutable 长缓存；
//   index.html 与 SPA 回退（任意未命中且不带 /assets/ 前缀的 GET）→ no-cache
//   + 严格自包含 CSP（零外部源：字体/图标/地图脚本一律打进包里）。
// /assets/ 下的缺失文件绝不回落成 HTML——浏览器该拿到的是 404 而不是被
// text/html 糊住 asset 管线；路径穿越在 resolveWithinRoot 一层被拒绝。
//
// 只接 GET / HEAD；POST 等写方法与 /api、/peer 前缀由 server.ts 的分发器先
// 拦下，不会走到这里。返回 false 表示「静态层不受理」（非 GET/HEAD），
// 调用方据此继续走 API 分发。
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 控制台 HTML 的严格自包含 CSP：全部资源仅允许同源（full-server.test.mjs 钉住逐字一致） */
export const CONSOLE_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'";

const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HTML_CACHE_CONTROL = 'no-cache';
const ASSET_PREFIX = '/assets/';
const INDEX_BASENAME = 'index.html';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export type StaticHost = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function safeDecode(pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded.includes('\0') ? null : decoded;
  } catch {
    return null;
  }
}

/** 解析出严格落在 root 之内的本地路径；越界（../、绝对地址等）返回 null */
function resolveWithinRoot(root: string, requestPath: string): string | null {
  if (!requestPath.startsWith('/')) return null;
  const decoded = safeDecode(requestPath);
  if (decoded === null) return null;
  const resolved = path.resolve(root, `.${decoded}`);
  const rootWithSep = path.resolve(root) + path.sep;
  return `${resolved}${path.sep}`.startsWith(rootWithSep) ? resolved : null;
}

function sendNotFound(res: ServerResponse, headOnly: boolean): void {
  res.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(headOnly ? undefined : 'not found');
}

async function sendFile(
  res: ServerResponse,
  filePath: string,
  headOnly: boolean,
  extraHeaders: Record<string, string>,
): Promise<void> {
  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch {
    sendNotFound(res, headOnly);
    return;
  }
  res.writeHead(200, {
    'content-type': contentTypeFor(filePath),
    'content-length': body.length,
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(headOnly ? undefined : body);
}

/** index.html 专用：no-cache + 严格自包含 CSP（SPA 回退共用同一档头） */
async function sendIndex(res: ServerResponse, root: string, headOnly: boolean): Promise<void> {
  const indexPath = path.join(path.resolve(root), INDEX_BASENAME);
  const stats = await stat(indexPath).catch(() => null);
  if (stats === null || !stats.isFile()) {
    // 还没执行 vite build 时（纯 API 部署）明确 404，不返回 200 空页
    sendNotFound(res, headOnly);
    return;
  }
  await sendFile(res, indexPath, headOnly, {
    'cache-control': HTML_CACHE_CONTROL,
    'content-security-policy': CONSOLE_CSP,
  });
}

/**
 * 创建静态托管 handler。返回 true 表示请求已应答（含 404）；
 * 返回 false 仅当方法不是 GET/HEAD（调用方继续 API 分发）。
 */
export function createStaticHost(root: string): StaticHost {
  const resolvedRoot = path.resolve(root);

  return async (req, res) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return false;
    const headOnly = method === 'HEAD';

    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://gateway.internal').pathname;
    } catch {
      sendNotFound(res, headOnly);
      return true;
    }

    const filePath = resolveWithinRoot(resolvedRoot, pathname);
    if (filePath === null) {
      sendNotFound(res, headOnly);
      return true;
    }

    const decoded = safeDecode(pathname) ?? pathname;
    if (decoded.startsWith(ASSET_PREFIX) || decoded === ASSET_PREFIX.slice(0, -1)) {
      // 哈希资源：存在即 immutable 长缓存，缺失即 404（绝不回落成 HTML）
      const stats = await stat(filePath).catch(() => null);
      if (stats === null || !stats.isFile()) {
        sendNotFound(res, headOnly);
        return true;
      }
      await sendFile(res, filePath, headOnly, { 'cache-control': ASSET_CACHE_CONTROL });
      return true;
    }

    const stats = await stat(filePath).catch(() => null);
    if (stats !== null && stats.isFile()) {
      const headers: Record<string, string> =
        path.extname(filePath).toLowerCase() === '.html'
          ? { 'cache-control': HTML_CACHE_CONTROL, 'content-security-policy': CONSOLE_CSP }
          : { 'cache-control': HTML_CACHE_CONTROL };
      await sendFile(res, filePath, headOnly, headers);
      return true;
    }

    // 其余路径（含 /）→ SPA 回退
    await sendIndex(res, resolvedRoot, headOnly);
    return true;
  };
}
