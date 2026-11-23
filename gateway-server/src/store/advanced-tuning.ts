// 网关与节点端高级调优参数（Slice 1）：单一事实源定义、默认推荐值、
// 单字段区间校验、跨字段不变量校验，以及容错存储读取与严格补丁合并。
// 持久化复用既有 system_settings KV 表（键 advanced_tuning），零 DDL 迁移。

export interface GatewayTuningSettings {
  defaultPeerDirectMaxRttMs: number;
  wsMaxTargetBufferedKib: number;
  wsPingIntervalMs: number;
  wsPongTimeoutMs: number;
  controlRateMaxKbps: number;
  maxPreAuthPerIp: number;
  maxPreAuthSockets: number;
  preAuthTimeoutMs: number;
  maxSseStreamsPerUser: number;
}

export interface PeerTuningSettings {
  p2pWindowMax: number;
  p2pWindowInitial: number;
  p2pWindowMin: number;
  lanWindowMax: number;
  relayWindowMax: number;
  relayWindowInitial: number;
  sackCoalesceFrames: number;
  directStallSuspectMs: number;
  relayHoldBaseMs: number;
  relayHoldMaxMs: number;
  directPromoteStreak: number;
  directPromoteRatio: number;
  wsReorderGraceMs: number;
}

export interface AdvancedTuningSettings {
  gateway: GatewayTuningSettings;
  peer: PeerTuningSettings;
}

export interface AdvancedTuningPatch {
  gateway?: Partial<GatewayTuningSettings>;
  peer?: Partial<PeerTuningSettings>;
}

export const DEFAULT_GATEWAY_TUNING: Readonly<GatewayTuningSettings> = {
  defaultPeerDirectMaxRttMs: 300,
  wsMaxTargetBufferedKib: 4096,
  wsPingIntervalMs: 10000,
  wsPongTimeoutMs: 15000,
  controlRateMaxKbps: 512,
  maxPreAuthPerIp: 16,
  maxPreAuthSockets: 256,
  preAuthTimeoutMs: 15000,
  maxSseStreamsPerUser: 5,
};

export const DEFAULT_PEER_TUNING: Readonly<PeerTuningSettings> = {
  p2pWindowMax: 160,
  p2pWindowInitial: 32,
  p2pWindowMin: 16,
  lanWindowMax: 160,
  relayWindowMax: 384,
  relayWindowInitial: 160,
  sackCoalesceFrames: 6,
  directStallSuspectMs: 3500,
  relayHoldBaseMs: 30000,
  relayHoldMaxMs: 300000,
  directPromoteStreak: 2,
  directPromoteRatio: 0.7,
  wsReorderGraceMs: 2000,
};

export const DEFAULT_ADVANCED_TUNING: AdvancedTuningSettings = {
  gateway: { ...DEFAULT_GATEWAY_TUNING },
  peer: { ...DEFAULT_PEER_TUNING },
};

export const GATEWAY_TUNING_INT_BOUNDS: Readonly<Record<keyof GatewayTuningSettings, readonly [number, number]>> = {
  defaultPeerDirectMaxRttMs: [0, 10000],
  wsMaxTargetBufferedKib: [512, 32768],
  wsPingIntervalMs: [5000, 60000],
  wsPongTimeoutMs: [10000, 120000],
  controlRateMaxKbps: [64, 2048],
  maxPreAuthPerIp: [4, 256],
  maxPreAuthSockets: [32, 4096],
  preAuthTimeoutMs: [5000, 60000],
  maxSseStreamsPerUser: [1, 32],
};

export const PEER_TUNING_INT_BOUNDS: Readonly<
  Record<Exclude<keyof PeerTuningSettings, 'directPromoteRatio'>, readonly [number, number]>
> = {
  p2pWindowMax: [16, 384],
  p2pWindowInitial: [8, 160],
  p2pWindowMin: [8, 64],
  lanWindowMax: [32, 384],
  relayWindowMax: [64, 384],
  relayWindowInitial: [32, 384],
  sackCoalesceFrames: [1, 16],
  directStallSuspectMs: [1500, 15000],
  relayHoldBaseMs: [10000, 120000],
  relayHoldMaxMs: [30000, 1800000],
  directPromoteStreak: [1, 10],
  wsReorderGraceMs: [500, 10000],
};

export const DIRECT_PROMOTE_RATIO_BOUNDS: readonly [number, number] = [0.5, 0.95];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cloneAdvancedTuning(tuning: AdvancedTuningSettings = DEFAULT_ADVANCED_TUNING): AdvancedTuningSettings {
  return {
    gateway: { ...tuning.gateway },
    peer: { ...tuning.peer },
  };
}

function roundRatio(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseIntBound(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

function parseRatioBound(value: unknown): number | null {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < DIRECT_PROMOTE_RATIO_BOUNDS[0]
    || value > DIRECT_PROMOTE_RATIO_BOUNDS[1]
  ) {
    return null;
  }
  return roundRatio(value);
}

/**
 * 容错解析落库 JSON：损坏/缺失/越界或违反跨字段约束的分组自动回落默认值，
 * 保证网关与节点端启动永不因脏 KV 行崩溃。
 */
export function parseStoredAdvancedTuning(raw: string | null): AdvancedTuningSettings {
  const result = cloneAdvancedTuning(DEFAULT_ADVANCED_TUNING);
  if (raw === null || raw.trim().length === 0) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (!isPlainObject(parsed)) return result;

  if (isPlainObject(parsed['gateway'])) {
    const gw = parsed['gateway'];
    for (const key of Object.keys(GATEWAY_TUNING_INT_BOUNDS) as Array<keyof GatewayTuningSettings>) {
      const [min, max] = GATEWAY_TUNING_INT_BOUNDS[key];
      const v = parseIntBound(gw[key], min, max);
      if (v !== null) result.gateway[key] = v;
    }
    if (result.gateway.wsPongTimeoutMs <= result.gateway.wsPingIntervalMs) {
      result.gateway.wsPingIntervalMs = DEFAULT_GATEWAY_TUNING.wsPingIntervalMs;
      result.gateway.wsPongTimeoutMs = DEFAULT_GATEWAY_TUNING.wsPongTimeoutMs;
    }
  }

  if (isPlainObject(parsed['peer'])) {
    const peer = parsed['peer'];
    for (const key of Object.keys(PEER_TUNING_INT_BOUNDS) as Array<Exclude<keyof PeerTuningSettings, 'directPromoteRatio'>>) {
      const [min, max] = PEER_TUNING_INT_BOUNDS[key];
      const v = parseIntBound(peer[key], min, max);
      if (v !== null) result.peer[key] = v;
    }
    const ratio = parseRatioBound(peer['directPromoteRatio']);
    if (ratio !== null) result.peer.directPromoteRatio = ratio;

    if (
      result.peer.p2pWindowMin > result.peer.p2pWindowInitial
      || result.peer.p2pWindowInitial > result.peer.p2pWindowMax
    ) {
      result.peer.p2pWindowMin = DEFAULT_PEER_TUNING.p2pWindowMin;
      result.peer.p2pWindowInitial = DEFAULT_PEER_TUNING.p2pWindowInitial;
      result.peer.p2pWindowMax = DEFAULT_PEER_TUNING.p2pWindowMax;
    }
    if (result.peer.relayWindowInitial > result.peer.relayWindowMax) {
      result.peer.relayWindowInitial = DEFAULT_PEER_TUNING.relayWindowInitial;
      result.peer.relayWindowMax = DEFAULT_PEER_TUNING.relayWindowMax;
    }
    if (result.peer.relayHoldMaxMs < result.peer.relayHoldBaseMs) {
      result.peer.relayHoldBaseMs = DEFAULT_PEER_TUNING.relayHoldBaseMs;
      result.peer.relayHoldMaxMs = DEFAULT_PEER_TUNING.relayHoldMaxMs;
    }
  }

  return result;
}

/**
 * 严格校验管理端 PATCH 提交的 advancedTuning 补丁并合并到当前配置：
 * - 传 null 一键恢复全部默认推荐值；
 * - 拒绝未知字段、非整数、越界值以及全部 4 条跨字段约束。
 */
export function mergeAndValidateAdvancedTuning(
  current: AdvancedTuningSettings,
  rawPatch: unknown,
): AdvancedTuningSettings {
  if (rawPatch === null) {
    return cloneAdvancedTuning(DEFAULT_ADVANCED_TUNING);
  }
  if (!isPlainObject(rawPatch)) {
    throw new Error('advancedTuning must be an object or null');
  }
  for (const topKey of Object.keys(rawPatch)) {
    if (topKey !== 'gateway' && topKey !== 'peer') {
      throw new Error(`advancedTuning contains unknown section: ${topKey}`);
    }
  }

  const next = cloneAdvancedTuning(current);

  if (rawPatch['gateway'] !== undefined) {
    const gwPatch = rawPatch['gateway'];
    if (!isPlainObject(gwPatch)) {
      throw new Error('advancedTuning.gateway must be an object');
    }
    for (const key of Object.keys(gwPatch)) {
      if (!Object.hasOwn(GATEWAY_TUNING_INT_BOUNDS, key)) {
        throw new Error(`advancedTuning.gateway contains unknown field: ${key}`);
      }
      const typedKey = key as keyof GatewayTuningSettings;
      const [min, max] = GATEWAY_TUNING_INT_BOUNDS[typedKey];
      const parsed = parseIntBound(gwPatch[key], min, max);
      if (parsed === null) {
        throw new Error(`advancedTuning.gateway.${key} must be an integer in [${min}, ${max}]`);
      }
      next.gateway[typedKey] = parsed;
    }
  }

  if (rawPatch['peer'] !== undefined) {
    const peerPatch = rawPatch['peer'];
    if (!isPlainObject(peerPatch)) {
      throw new Error('advancedTuning.peer must be an object');
    }
    for (const key of Object.keys(peerPatch)) {
      if (key === 'directPromoteRatio') {
        const ratio = parseRatioBound(peerPatch[key]);
        if (ratio === null) {
          throw new Error(
            `advancedTuning.peer.directPromoteRatio must be a finite number in [${DIRECT_PROMOTE_RATIO_BOUNDS[0]}, ${DIRECT_PROMOTE_RATIO_BOUNDS[1]}]`,
          );
        }
        next.peer.directPromoteRatio = ratio;
        continue;
      }
      if (!Object.hasOwn(PEER_TUNING_INT_BOUNDS, key)) {
        throw new Error(`advancedTuning.peer contains unknown field: ${key}`);
      }
      const typedKey = key as Exclude<keyof PeerTuningSettings, 'directPromoteRatio'>;
      const [min, max] = PEER_TUNING_INT_BOUNDS[typedKey];
      const parsed = parseIntBound(peerPatch[key], min, max);
      if (parsed === null) {
        throw new Error(`advancedTuning.peer.${key} must be an integer in [${min}, ${max}]`);
      }
      next.peer[typedKey] = parsed;
    }
  }

  // 跨字段不变量
  if (next.gateway.wsPongTimeoutMs <= next.gateway.wsPingIntervalMs) {
    throw new Error('advancedTuning.gateway.wsPongTimeoutMs must be strictly greater than wsPingIntervalMs');
  }
  if (next.peer.p2pWindowMin > next.peer.p2pWindowInitial) {
    throw new Error('advancedTuning.peer.p2pWindowMin must be <= p2pWindowInitial');
  }
  if (next.peer.p2pWindowInitial > next.peer.p2pWindowMax) {
    throw new Error('advancedTuning.peer.p2pWindowInitial must be <= p2pWindowMax');
  }
  if (next.peer.relayWindowInitial > next.peer.relayWindowMax) {
    throw new Error('advancedTuning.peer.relayWindowInitial must be <= relayWindowMax');
  }
  if (next.peer.relayHoldMaxMs < next.peer.relayHoldBaseMs) {
    throw new Error('advancedTuning.peer.relayHoldMaxMs must be >= relayHoldBaseMs');
  }

  return next;
}
