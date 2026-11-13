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
import type { BootstrapAdminResult, GatewayStore, SystemSettings } from './store/types.js';
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
  /** 逐层关停（PC-19 第二片）：UDP → WS（末批遥测刷盘确认后才过）→ HTTP → 数据库；共享墙钟预算与同一真实结果 */
  close(): Promise<void>;
}

export interface StartGatewayOptions {
  /** 控制台静态托管根目录；缺省取 dist/main.js 旁的 dist/public */
  staticRoot?: string;
  /**
   * 关停墙钟预算（毫秒，PC-19 第二片），覆盖末批刷盘与 store 关闭在内的整条
   * 逐层关停链；缺省 5000。预算耗尽即如实拒绝（非零结果，报告未确认累计），
   * 绝不假称成功——生产信号入口把它映射为非零退出码。
   */
  closeBudgetMs?: number;
}

/** 关停墙钟预算缺省值：末批一小批 + 逐层关闭的正常量级，余量给慢盘 */
const DEFAULT_CLOSE_BUDGET_MS = 5_000;
/**
 * 失败兜底路径上每一步资源停止的独立短预算（PC-19 shutdown fix1）：兜底绝不
 * 包含无期限 await——任何一步（含原卡点重入）超预算即放弃。清理总宽限上界 =
 * ABORT_STEP_BUDGET_MS × 关停层数（4），随失败错误一并报告。
 */
const ABORT_STEP_BUDGET_MS = 1_000;

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
  // 部署配置作为播种初始值进两种存储：空库按本轮配置播种、已有键不被覆盖、
  // 缺键逐键补齐（两种 store 同一语义），重启绝不推翻控制台改过的持久化设置。
  const seed: SystemSettings = {
    allowSignup: config.allowSignup,
    maxNetworksPerUser: config.maxNetworksPerUser,
    defaultMaxPeers: config.defaultMaxPeers,
    relayRateKbps: config.relayRateKbps,
  };
  if (config.databaseUrl !== undefined) {
    return PgStore.connect(config.databaseUrl, seed);
  }
  return new SqliteStore({ path: path.join(config.dataDir, 'gateway.sqlite'), seed });
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

    // hub 先于 UDP 构造（PC-01a fix1）：udp-stun 先绑主口并装好 message 回调、
    // 再 await 辅助口绑定，主口绑成后即可投递 UDP 事件——若把 hub 放到
    // await udp.bind() 之后，「主口已绑、辅助口未完成」的启动窗口里回调会
    // 访问未初始化的 hub。先建 hub 让全部 UDP 回调自安装起就转发已初始化对象：
    // 窗口内无连接，admitStunProbe 明确返回 null（不退回无准入 standalone 模式）、
    // 查询为空、通知无业务状态；真实绑定端口在 bind 完成后经供给器供给
    // welcome（PC-01a），不把配置值或 HTTP 端口当 UDP 端口。
    let udpPorts: { primaryPort: number; altPort: number | null } | null = null;
    const hub = new PeerWsHub({ store, masterKey, stunPorts: () => udpPorts });
    const udp = new UdpStunService({
      primaryPort: config.port,
      // 配置层 `udpAltPort=0 表示关闭辅助口` → 映射成 udp-stun 的 null
      altPort: config.udpAltPort === 0 ? null : config.udpAltPort,
      admitProbe: (networkId, nodeId, publicKeyHex) => hub.admitStunProbe(networkId, nodeId, publicKeyHex),
      lanEndpointsLookup: (networkId, nodeId) => hub.getLanEndpoints(networkId, nodeId),
      onNatDetected: (record) => hub.applyNatObservation(record),
    });
    udpPorts = await udp.bind();

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
    const closeBudgetMs = options.closeBudgetMs ?? DEFAULT_CLOSE_BUDGET_MS;
    let closePromise: Promise<void> | null = null;

    // PC-19 第二片：逐层关停（PC-19 第二片顺序）——先停 UDP 摄入（STUN 观测不再
    // 到达），再停 WS 并由 hub.close 经第一片的同一串行入口补末批（末批确认后
    // hub.close 才 resolve），随后 HTTP 与 store；末批开跑前全部摄入源已关，
    // 关 store 前无待确认批次。每层共享同一墙钟预算；重复/并发 close 共享同一
    // 真实结果（共享 closePromise），绝不因 closing 标志提前成功。
    const closeGateway = async (): Promise<void> => {
      const deadline = Date.now() + closeBudgetMs;
      const bounded = async (label: string, op: () => Promise<void>): Promise<void> => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`gateway close budget (${closeBudgetMs}ms) exhausted before ${label}`);
        }
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            op(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`${label} did not complete within gateway close budget (${closeBudgetMs}ms)`)),
                remaining,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      // PC-19 shutdown fix1：关停开始（t0）即停止 HTTP 新连接接收——server.close()
      // 的「拒新」效果立即生效，存量连接的收尾等待放在后面的有界 HTTP 层；
      // 不等末批完成才停接收。
      let serverClosed: Promise<void> | null = null;
      const stopAcceptingHttp = (): Promise<void> => {
        if (serverClosed === null) {
          serverClosed = new Promise<void>((resolve) => {
            server.closeIdleConnections?.();
            server.close(() => resolve());
          });
        }
        return serverClosed;
      };
      const closeServer = async (): Promise<void> => {
        // SSE/keep-alive 存量收尾；WS 升级连接已由 hub.terminate 摘除
        server.closeAllConnections?.();
        await stopAcceptingHttp();
      };
      stopAcceptingHttp(); // t0 即拒新连接（拒绝效果立即生效，不等任何阶段）
      // 失败兜底：每一步独立短预算，任何一步（含原卡点重入）超预算即放弃，
      // 绝不覆盖原始错误；库函数失败不称资源已全部释放（错误里如实注明
      // best-effort 与清理宽限总上界）。
      const abortStep = async (label: string, op: () => Promise<void>): Promise<void> => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            op(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${label} exceeded ${ABORT_STEP_BUDGET_MS}ms cleanup cap`)), ABORT_STEP_BUDGET_MS);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        await bounded('udp shutdown', () => udp.close());
        await bounded('ws hub shutdown (final telemetry flush included)', () => hub.close());
        await bounded('http server close', closeServer);
        await bounded('store close', () => store.close());
        closedStore = true;
      } catch (error) {
        const cleanupGraceMs = ABORT_STEP_BUDGET_MS * 4;
        await abortStep('abort: udp shutdown', () => udp.close()).catch(() => {});
        // hub.close 的拆除（闸门/定时器/socket terminate）在调用时同步完成，
        // 即使末批刷盘超预算被放弃，WS 也已全部摘除
        await abortStep('abort: ws hub shutdown', () => hub.close()).catch(() => {});
        await abortStep('abort: http server close', closeServer).catch(() => {});
        // store 可能不可取消（写挂死）——短预算内尝试后如实放弃，挂起查询随
        // 进程退出消亡，未完成状态由抛出的错误如实报告
        await abortStep('abort: store close', () => store.close()).catch(() => {});
        const summary = hub.pendingTelemetrySummary();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `gateway close failed (budget ${closeBudgetMs}ms, cleanup grace ≤ ${cleanupGraceMs}ms): ${message}; unconfirmed telemetry: ${summary.bytes} bytes across ${summary.members} members, ${summary.natObservations} NAT observations; resources stopped best-effort within cleanup grace`,
          { cause: error },
        );
      }
    };

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
      close: (): Promise<void> => {
        if (closePromise === null) closePromise = closeGateway();
        return closePromise;
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
