// HTTP Server 组装（PG-4）：路由表汇集、同源写保护、统一信封与错误映射。
// PG-5 的 WS/SSE 与入网协议入口在此基础上扩展，不改变这里的分发语义。
import http from 'node:http';
import { IncomingMessage, ServerResponse } from 'node:http';

import { buildAuthRoutes, DEFAULT_SESSION_TTL_MS, isCrossSiteWrite, matchRoute, NOOP_RUNTIME_STATS, sendError, storeErrorToApiError } from './http/auth.js';
import type {
  ApiServerConfig,
  GatewayHooks,
  GatewayRuntimeStats,
  RouteContext,
  RouteDef,
  TopologyProvider,
} from './http/auth.js';
import { buildNetworkRoutes } from './http/routes-networks.js';
import { buildAdminRoutes } from './http/routes-admin.js';
import { buildTopologyRoutes } from './http/routes-topology.js';
import { ApiError } from './http/auth.js';
import { StoreError } from './store/types.js';
import type { GatewayStore } from './store/types.js';

export interface GatewayApiServerOptions {
  store: GatewayStore;
  /** 秘密加密主密钥（loadOrCreateMasterKey / deriveMasterKeyFromSecret 的产物） */
  masterKey: Buffer;
  /** 对外可达基础 URL；缺省时 joinUri 取请求 Host 头 */
  publicUrl?: string;
  /** 会话 TTL，缺省 7 天 */
  sessionTtlMs?: number;
  /** PG-5 运行时统计注入（在线设备数 / 实时中转速率）；缺省全 0 */
  runtime?: GatewayRuntimeStats;
  /** PG-5 实时钩子；缺省无钩子 */
  hooks?: GatewayHooks;
  /** PG-5 拓扑实时层（ws-hub）；提供后注册 /topology 与 /events 路由 */
  topology?: TopologyProvider;
}

function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
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

  // 同源写保护顶在最前：跨站写请求在读路由、读体之前直接 403
  if (isCrossSiteWrite(req)) {
    sendError(res, 403, 'FORBIDDEN_ORIGIN', 'cross-site write requests are rejected');
    return;
  }

  const match = matchRoute(deps.routes, req.method ?? 'GET', segments);
  if (match === null) {
    sendError(res, 404, 'NOT_FOUND', 'no such API route');
    return;
  }

  const ctx: RouteContext = { req, res, ...deps.ctx };
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
    sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
  };
  const deps: DispatchDeps = {
    routes: [
      ...buildAuthRoutes(),
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
  return (req, res) => {
    dispatch(req, res, deps).catch(() => {
      sendError(res, 500, 'INTERNAL', 'internal server error');
    });
  };
}

export function createGatewayApiServer(options: GatewayApiServerOptions): http.Server {
  return http.createServer(createApiRequestHandler(options));
}
