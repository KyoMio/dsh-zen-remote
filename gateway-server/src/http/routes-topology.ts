// 拓扑快照与 SSE 实时流（PG-5）。控制台消费的两个只读接口：
//
//   GET /api/v1/networks/:id/topology  完整快照（网络概览、待审批、五态成员、
//                                      节点对路径与实时速率、全网速率）
//   GET /api/v1/networks/:id/events    text/event-stream：先推一次 snapshot，
//                                      之后成员申请/审批/上下线/path-report
//                                      变更及 3s 速率跳动（ws-hub 内部 tick）
//                                      推 topology-updated
//
// 归属校验与网络路由同一套语义：不存在或他人网络一律 404（防枚举），
// admin 也只看自己名下的网络。数据本体由 PG-5 的 ws-hub（TopologyProvider）
// 渲染，这里只做鉴权、信封与 SSE 帧。
import type { ServerResponse } from 'node:http';

import { ApiError, requireUser, sendOk } from './auth.js';
import type { RouteContext, RouteDef, TopologyProvider } from './auth.js';

async function loadOwnedNetworkForTopology(ctx: RouteContext, userId: string, networkId: string): Promise<void> {
  const network = await ctx.store.getNetwork(networkId);
  if (network === null || network.ownerId !== userId) {
    throw new ApiError(404, 'NOT_FOUND', 'network not found');
  }
}

function requireTopology(ctx: RouteContext): TopologyProvider {
  if (ctx.topology === undefined) {
    // 只在服务端未装配实时层时发生；路由注册已按条件守过一次
    throw new ApiError(500, 'INTERNAL', 'topology provider is not wired');
  }
  return ctx.topology;
}

async function handleGetTopology(ctx: RouteContext, params: Record<string, string>): Promise<void> {
  const user = await requireUser(ctx);
  const networkId = params['id'] ?? '';
  await loadOwnedNetworkForTopology(ctx, user.id, networkId);
  const snapshot = await requireTopology(ctx).renderTopology(networkId);
  if (snapshot === null) {
    throw new ApiError(404, 'NOT_FOUND', 'network not found');
  }
  sendOk(ctx.res, snapshot);
}

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleStreamTopology(ctx: RouteContext, params: Record<string, string>): Promise<void> {
  const user = await requireUser(ctx);
  const networkId = params['id'] ?? '';
  await loadOwnedNetworkForTopology(ctx, user.id, networkId);
  const provider = requireTopology(ctx);
  const snapshot = await provider.renderTopology(networkId);
  if (snapshot === null) {
    throw new ApiError(404, 'NOT_FOUND', 'network not found');
  }
  ctx.res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  ctx.res.write('retry: 3000\n\n');
  writeSseEvent(ctx.res, 'snapshot', snapshot);
  const unsubscribe = provider.subscribe(networkId, (updated) => {
    writeSseEvent(ctx.res, 'topology-updated', updated);
  });
  // 注意：req 的 'close' 在「请求消息读完整」时就触发（Node ≥16 语义），
  // dispatcher 的 req.resume() 一跑它就 fire——退订会挂在这里导致后续推送
  // 全部丢失。res 的 'close' 才是「连接断开」。
  const cleanup = (): void => {
    unsubscribe();
    ctx.res.off('close', cleanup);
  };
  ctx.res.on('close', cleanup);
}

export function buildTopologyRoutes(): RouteDef[] {
  return [
    { method: 'GET', path: '/api/v1/networks/:id/topology', handler: handleGetTopology },
    { method: 'GET', path: '/api/v1/networks/:id/events', handler: handleStreamTopology },
  ];
}
