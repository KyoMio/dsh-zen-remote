// 网关配置解析：env 变量 → GatewayConfig，全部显式默认值与范围校验。
// 错误一律在启动期抛出（配置错了宁可起不来，也不要带病运行）。

export interface GatewayConfig {
  /** 主 HTTP 端口，env `ZR_GATEWAY_PORT`，默认 19393 */
  port: number;
  /** 辅助 UDP 端口，env `ZR_GATEWAY_UDP_ALT_PORT`，默认 port + 1；设为 '0' 表示关闭辅助口 */
  udpAltPort: number;
  /** 对外可达的基础 URL（无末尾斜杠），env `ZR_GATEWAY_PUBLIC_URL`，可选 */
  publicUrl: string | undefined;
  /** 数据目录，env `ZR_GATEWAY_DATA_DIR`，默认 `./data` */
  dataDir: string;
  /** PostgreSQL 连接串，env `ZR_GATEWAY_DATABASE_URL`，可选（缺省用内置 SQLite） */
  databaseUrl: string | undefined;
  /** 初始管理员邮箱，env `ZR_GATEWAY_ADMIN_USER`，默认 `admin@local` */
  adminUser: string;
  /** 初始管理员密码，env `ZR_GATEWAY_ADMIN_PASSWORD`；未设置时首次初始化随机生成 16 位密码 */
  adminPassword: string | undefined;
  /** 是否开放注册，env `ZR_GATEWAY_ALLOW_SIGNUP`（只认 'true'/'1'），默认 false */
  allowSignup: boolean;
  /** 新建虚拟网络的默认成员上限，env `ZR_GATEWAY_MAX_PEERS`，默认 8，范围 2..64 */
  defaultMaxPeers: number;
  /** 普通租户建网数上限，env `ZR_GATEWAY_MAX_NETWORKS_PER_USER`，默认 3，范围 1..50 */
  maxNetworksPerUser: number;
  /** 单成员中继限速（KB/s），env `ZR_GATEWAY_RELAY_RATE_KBPS`，默认 4096，范围 64..1048576 */
  relayRateKbps: number;
}

type Env = Record<string, string | undefined>;

function intInRange(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`);
  }
  return value;
}

function optionalNonEmpty(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw !== undefined && raw !== '' ? raw : undefined;
}

export function resolveGatewayConfig(env: Env = process.env): GatewayConfig {
  const port = intInRange(env, 'ZR_GATEWAY_PORT', 19393, 1, 65535);
  const udpAltRaw = env['ZR_GATEWAY_UDP_ALT_PORT'];
  let udpAltPort: number;
  if (udpAltRaw === undefined || udpAltRaw === '') {
    udpAltPort = port + 1 > 65535 ? 0 : port + 1; // 默认辅助口 = 主口 + 1，越界即关闭
  } else if (udpAltRaw === '0') {
    udpAltPort = 0; // 显式 0 = 关闭辅助口
  } else {
    udpAltPort = intInRange(env, 'ZR_GATEWAY_UDP_ALT_PORT', 0, 1, 65535);
  }

  const publicUrlRaw = optionalNonEmpty(env, 'ZR_GATEWAY_PUBLIC_URL');
  const allowSignupRaw = env['ZR_GATEWAY_ALLOW_SIGNUP'];

  return {
    port,
    udpAltPort,
    publicUrl: publicUrlRaw !== undefined ? publicUrlRaw.replace(/\/+$/, '') || undefined : undefined,
    dataDir: optionalNonEmpty(env, 'ZR_GATEWAY_DATA_DIR') ?? './data',
    databaseUrl: optionalNonEmpty(env, 'ZR_GATEWAY_DATABASE_URL'),
    adminUser: optionalNonEmpty(env, 'ZR_GATEWAY_ADMIN_USER') ?? 'admin@local',
    adminPassword: optionalNonEmpty(env, 'ZR_GATEWAY_ADMIN_PASSWORD'),
    allowSignup: allowSignupRaw === 'true' || allowSignupRaw === '1',
    defaultMaxPeers: intInRange(env, 'ZR_GATEWAY_MAX_PEERS', 8, 2, 64),
    maxNetworksPerUser: intInRange(env, 'ZR_GATEWAY_MAX_NETWORKS_PER_USER', 3, 1, 50),
    relayRateKbps: intInRange(env, 'ZR_GATEWAY_RELAY_RATE_KBPS', 4096, 64, 1048576),
  };
}
