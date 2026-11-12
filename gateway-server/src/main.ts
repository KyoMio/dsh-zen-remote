// 组装根（PG-6b）：把 store（SQLite WAL / PG）、主密钥、WS hub、双 UDP STUN、
// REST API 与控制台静态托管装进同一个 http.Server，并管好生命周期——
// `node --experimental-sqlite dist/main.js` 直接启动；测试经 startGateway
// 拿到句柄并逐层 close()（hub → udp → server → store），不留悬挂句柄。
//
// 主密钥来源与初始管理员：master.key / env secret 由 loadOrCreateMasterKey
// 决定；管理员账号经 store.ensureBootstrapAdmin 引导——空库且未给
// ZR_GATEWAY_ADMIN_PASSWORD 时生成 16 位随机密码，仅在创建成功的输出里
// 打印一次（result.generatedPassword），已建库重启绝不重复创建或改密。
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveGatewayConfig } from './config.js';
import type { GatewayConfig } from './config.js';
import { loadOrCreateMasterKey } from './master-key.js';
import { createGatewayApiServer } from './server.js';
import { PgStore } from './store/pg-store.js';
import { SqliteStore } from './store/sqlite-store.js';
import type { BootstrapAdminResult, GatewayStore } from './store/types.js';
import { PeerWsHub } from './peer-hub/ws-hub.js';
import { UdpStunService } from './peer-hub/udp-stun.js';

export interface GatewayInstance {
  readonly config: GatewayConfig;
  readonly store: GatewayStore;
  readonly hub: PeerWsHub;
  readonly udp: UdpStunService;
  readonly server: http.Server;
  /** 引导管理员的结果：created=false 表示复用已有账号（数据库已初始化过） */
  readonly admin: BootstrapAdminResult;
  /** HTTP 实际监听端口（config.port=0 时为内核分配值） */
  readonly port: number;
  /** UDP 实际端口；altPort=null 表示辅助口已按配置关闭 */
  readonly udpPorts: { primaryPort: number; altPort: number | null };
  /** 本机回环访问入口（打印与测试用） */
  readonly base: string;
  /** 逐层关停：WS 连接 → UDP 端口 → HTTP（含活动连接）→ 数据库 */
  close(): Promise<void>;
}

export interface StartGatewayOptions {
  /** 控制台静态托管根目录；缺省取 dist/main.js 旁的 dist/public */
  staticRoot?: string;
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function openStore(config: GatewayConfig): Promise<GatewayStore> {
  if (config.databaseUrl !== undefined) {
    return PgStore.connect(config.databaseUrl);
  }
  return new SqliteStore({ path: path.join(config.dataDir, 'gateway.sqlite') });
}

/**
 * 组装并启动完整网关。不安装信号处理器、不退出进程——那是 main() 的职责；
 * 测试可以开多个实例、逐个 close()。
 */
export async function startGateway(config: GatewayConfig, options: StartGatewayOptions = {}): Promise<GatewayInstance> {
  const masterKey = loadOrCreateMasterKey(config.dataDir);
  const store = await openStore(config);
  let closedStore = false;
  try {
    const admin = await store.ensureBootstrapAdmin({ email: config.adminUser, password: config.adminPassword });

    const hub = new PeerWsHub({ store, masterKey });
    const udp = new UdpStunService({
      primaryPort: config.port,
      // 配置层 `udpAltPort=0 表示关闭辅助口` → 映射成 udp-stun 的 null
      altPort: config.udpAltPort === 0 ? null : config.udpAltPort,
      admitProbe: (networkId, nodeId, publicKeyHex) => hub.admitStunProbe(networkId, nodeId, publicKeyHex),
      lanEndpointsLookup: (networkId, nodeId) => hub.getLanEndpoints(networkId, nodeId),
      onNatDetected: (record) => hub.applyNatObservation(record),
    });
    const udpPorts = await udp.bind();

    const staticRoot = options.staticRoot ?? fileURLToPath(new URL('./public', import.meta.url));
    const server = createGatewayApiServer({
      store,
      masterKey,
      publicUrl: config.publicUrl,
      runtime: hub,
      hooks: hub.hooks,
      topology: hub,
      staticRoot,
    });
    hub.attach(server);
    await listen(server, config.port);

    const address = server.address();
    const port = address !== null && typeof address === 'object' ? address.port : config.port;
    const base = `http://127.0.0.1:${port}`;
    let closing = false;

    return {
      config,
      store,
      hub,
      udp,
      server,
      admin,
      port,
      udpPorts,
      base,
      close: async (): Promise<void> => {
        if (closing) return;
        closing = true;
        await hub.close();
        await udp.close();
        await new Promise<void>((resolve) => {
          server.closeIdleConnections?.();
          server.closeAllConnections?.();
          server.close(() => resolve());
        });
        await store.close();
        closedStore = true;
      },
    };
  } catch (err) {
    // 半组装状态退出前把手头的资源关掉，不留悬挂句柄
    if (!closedStore) await store.close().catch(() => {});
    throw err;
  }
}

/** CLI 入口：读 env、启动、打印入口地址与一次性初始密码，SIGINT/SIGTERM 优雅停机 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = resolveGatewayConfig(env);
  const gw = await startGateway(config);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[gateway] received ${signal}, shutting down`);
    void gw
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error('[gateway] shutdown failed:', err);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log('Zen Remote gateway ready');
  console.log(`  console  http://127.0.0.1:${gw.port}/`);
  console.log(`  udp      ${gw.udpPorts.primaryPort}/udp${gw.udpPorts.altPort !== null ? ` + ${gw.udpPorts.altPort}/udp` : ' (alt disabled)'}`);
  console.log(`  data     ${config.dataDir}`);
  if (gw.admin.created) {
    console.log(`  admin    ${gw.admin.email}`);
    if (gw.admin.generatedPassword !== undefined) {
      console.log(`  initial password (shown once, change it after login): ${gw.admin.generatedPassword}`);
    }
  }
}

// 直接执行 dist/main.js 时启动；被测试/其他模块 import 时不做任何事
const entry = process.argv[1] !== undefined ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  void main();
}
