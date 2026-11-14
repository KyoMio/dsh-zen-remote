// HTTP Server 组装（PG-4）：路由表汇集、同源写保护、统一信封与错误映射。
// PG-5 的 WS/SSE 与入网协议入口在此基础上扩展，不改变这里的分发语义。
import http from 'node:http';
import { IncomingMessage, ServerResponse } from 'node:http';

import { buildAuthRoutes, isCrossSiteWrite, matchRoute, NOOP_RUNTIME_STATS, sendError, storeErrorToApiError } from './http/auth.js';
import type {
  ApiServerConfig,
  GatewayHooks,
  GatewayRuntimeMeta,
  GatewayRuntimeStats,
  RouteContext,
  RouteDef,
  TopologyProvider,
} from './http/auth.js';
import { buildAccountRoutes } from './http/routes-account.js';
import { buildNetworkRoutes } from './http/routes-networks.js';
import { buildAdminRoutes } from './http/routes-admin.js';
import { buildTopologyRoutes } from './http/routes-topology.js';
import { createStaticHost } from './http/static-host.js';
import type { StaticHost } from './http/static-host.js';
import { ApiError } from './http/auth.js';
import { StoreError } from './store/types.js';
import type { GatewayStore } from './store/types.js';

export interface GatewayApiServerOptions {
  store: GatewayStore;
  /** 秘密加密主密钥（loadOrCreateMasterKey / deriveMasterKeyFromSecret 的产物） */
  masterKey: Buffer;
  /** 对外可达基础 URL；缺省时 joinUri 取请求 Host 头 */
  publicUrl?: string;
  /** GC-6a 只读运行态元信息（/admin/runtime 展示与安全告警）；缺省按保守值呈现 */
  runtimeMeta?: GatewayRuntimeMeta;
  /** PG-5 运行时统计注入（在线设备数 / 实时中转速率）；缺省全 0 */
  runtime?: GatewayRuntimeStats;
  /** PG-5 实时钩子；缺省无钩子 */
  hooks?: GatewayHooks;
  /** PG-5 拓扑实时层（ws-hub）；提供后注册 /topology 与 /events 路由 */
  topology?: TopologyProvider;
  /** PG-6b 控制台静态托管根目录（vite 产物 dist/public）；缺省不托管，纯 API 语义不变 */
  staticRoot?: string;
}

/**
 * 该不该由静态层接手：GET/HEAD 且第一个路径段不是 `api` / `peer`。
 * WS 升级请求走 server 的 upgrade 事件，与这里的分发无关。
 */
function isConsolePath(req: IncomingMessage): boolean {
  const method = req.method ?? '';
  if (method !== 'GET' && method !== 'HEAD') return false;
  try {
    const { pathname } = new URL(req.url ?? '/', 'http://gateway.internal');
    const first = pathname.slice(1).split('/', 1)[0] ?? '';
    return first !== 'api' && first !== 'peer';
  } catch {
    return true; // 解析不了的 URL 交给静态层回 404
  }
}

function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function readAuthorizationHeader(req: IncomingMessage): string {
  const value = req.headers.authorization;
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

interface DispatchDeps {
  routes: readonly RouteDef[];
  ctx: Omit<RouteContext, 'req' | 'res'>;
}

async function dispatch(req: IncomingMessage, res: ServerResponse, deps: DispatchDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://gateway.internal');
  const segments = url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map(safeDecodeSegment);

  // 同源写保护顶在最前：跨站写请求在读路由、读体之前直接 403。
  // GC-6a 豁免：Admin Bearer API Key 通道（Authorization: Bearer 且路径以
  // /api/v1/admin/ 开头）跳过同源检查——浏览器跨站请求带不上自定义 Authorization
  // 头（CORS 预检必拦），且 requireAdmin 对 Bearer 绝不回退 Cookie，因此该通道
  // 天然免疫 CSRF；其余写路由哪怕带 Authorization 仍按原样走同源校验。
  const isBearerAdminApi =
    /^Bearer\s+/i.test(readAuthorizationHeader(req)) && url.pathname.startsWith('/api/v1/admin/');
  if (!isBearerAdminApi && isCrossSiteWrite(req)) {
    sendError(res, 403, 'FORBIDDEN_ORIGIN', 'cross-site write requests are rejected');
    return;
  }

  const match = matchRoute(deps.routes, req.method ?? 'GET', segments);
  if (match === null) {
    sendError(res, 404, 'NOT_FOUND', 'no such API route');
    return;
  }

  // GC-6a：逐请求热读 settings.publicUrl（管理员改完即刻生效，无需重启）——
  // 覆盖 env 配置值；settings 未配（null）时回落 options.publicUrl，再回落请求头推断。
  const ext = await deps.ctx.store.getExtendedSettings();
  const config: ApiServerConfig =
    ext.publicUrl !== null && ext.publicUrl.length > 0
      ? { ...deps.ctx.config, publicUrl: ext.publicUrl }
      : deps.ctx.config;

  const ctx: RouteContext = { req, res, ...deps.ctx, config };
  try {
    await match.handler(ctx, match.params);
  } catch (err) {
    if (err instanceof ApiError) {
      sendError(res, err.status, err.code, err.message);
    } else if (err instanceof StoreError) {
      const mapped = storeErrorToApiError(err);
      sendError(res, mapped.status, mapped.code, mapped.message);
    } else {
      // 内部错误脱敏：不向客户端泄漏堆栈或消息
      sendError(res, 500, 'INTERNAL', 'internal server error');
    }
  } finally {
    req.resume(); // 未读的请求体直接丢弃，保住 keep-alive 连接复用
  }
}

/** 产出可直接交给 http.createServer 的请求 handler（PG-5 反代/挂载可复用） */
export function createApiRequestHandler(options: GatewayApiServerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const config: ApiServerConfig = {
    publicUrl: options.publicUrl,
    runtimeMeta: options.runtimeMeta,
  };
  const deps: DispatchDeps = {
    routes: [
      ...buildAuthRoutes(),
      ...buildAccountRoutes(),
      ...buildNetworkRoutes(),
      ...buildAdminRoutes(),
      ...(options.topology !== undefined ? buildTopologyRoutes() : []),
    ],
    ctx: {
      store: options.store,
      masterKey: options.masterKey,
      config,
      runtime: options.runtime ?? NOOP_RUNTIME_STATS,
      hooks: options.hooks ?? {},
      topology: options.topology,
    },
  };
  const staticHost: StaticHost | null = options.staticRoot !== undefined ? createStaticHost(options.staticRoot) : null;
  const runDispatch = (req: IncomingMessage, res: ServerResponse): void => {
    dispatch(req, res, deps).catch(() => {
      sendError(res, 500, 'INTERNAL', 'internal server error');
    });
  };
  return (req, res) => {
    if (staticHost === null || !isConsolePath(req)) {
      runDispatch(req, res);
      return;
    }
    void staticHost(req, res).then((handled) => {
      // 静态层只对非 GET/HEAD 返回 false，而 isConsolePath 已把这类请求挡在外面；
      // 这条分支仅作为两道闸门语义不一致时的兜底
      if (!handled) runDispatch(req, res);
    });
  };
}

export function createGatewayApiServer(options: GatewayApiServerOptions): http.Server {
  return http.createServer(createApiRequestHandler(options));
}
