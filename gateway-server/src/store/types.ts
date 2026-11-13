// GatewayStore 窄接口：屏蔽同步 SQLite 与异步 PostgreSQL 的差异，所有方法返回 Promise。
//
// 入网判定与成员状态迁移的决策逻辑在本文件以纯函数给出（decideJoinAttempt / decideTransition），
// sqlite-store 与 pg-store 都必须走同一份决策——同一语义不允许两套实现各自漂移。

export type UserRole = 'admin' | 'user';

export type AdmissionMode = 'key' | 'manual' | 'both';

export type MemberStatus = 'pending' | 'authorized' | 'paused' | 'mismatch' | 'revoked';

export type NatType = 'cone' | 'symmetric' | 'public' | 'unknown';

export type TransitionAction = 'approve' | 'reject' | 'pause' | 'resume' | 'repin';

/** 数据库里的 status 字符串 → MemberStatus（CHECK 约束之外的值视为数据损坏，直接抛错） */
export function decodeMemberStatus(value: string): MemberStatus {
  switch (value) {
    case 'pending':
    case 'authorized':
    case 'paused':
    case 'mismatch':
    case 'revoked':
      return value;
    default:
      throw new Error(`unknown member status in database: ${value}`);
  }
}

/**
 * 占席状态集合（PC-10 统一口径）：authorized / paused / mismatch 各占一席；
 * pending（待审批）与 revoked（已吊销）不占席。两个 store 的容量计数 SQL 与
 * REST 设备表展示共用同一口径，禁止各处自写字面量漂移。
 */
export const SEAT_OCCUPYING_STATUSES: ReadonlyArray<MemberStatus> = ['authorized', 'paused', 'mismatch'];

export interface SystemSettings {
  allowSignup: boolean;
  maxNetworksPerUser: number;
  defaultMaxPeers: number;
  relayRateKbps: number;
}

/** 空库首次播种/缺省合并用的默认值（与 resolveGatewayConfig 的默认一致） */
export const DEFAULT_SETTINGS: SystemSettings = {
  allowSignup: false,
  maxNetworksPerUser: 3,
  defaultMaxPeers: 8,
  relayRateKbps: 4096,
};

/** settings 的 camelCase → snake_case 键映射，两个 store 共用 */
export const SETTINGS_KEYS: Readonly<Record<keyof SystemSettings, string>> = {
  allowSignup: 'allow_signup',
  maxNetworksPerUser: 'max_networks_per_user',
  defaultMaxPeers: 'default_max_peers',
  relayRateKbps: 'relay_rate_kbps',
};

/** settings 值统一以字符串存 key-value 表 */
export function encodeSettingsValue(value: boolean | number): string {
  return typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
}

/** key-value 行 → SystemSettings（缺省键回退 DEFAULT_SETTINGS；pg 的 count/bigint 字符串也在此转 number） */
export function parseSettingsRows(rows: ReadonlyArray<Record<string, unknown>>): SystemSettings {
  const map = new Map<string, string>();
  for (const row of rows) {
    const key = row['key'];
    if (typeof key === 'string') map.set(key, String(row['value']));
  }
  const num = (key: keyof SystemSettings, fallback: number): number => {
    const raw = map.get(SETTINGS_KEYS[key]);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    allowSignup: map.get(SETTINGS_KEYS.allowSignup) === 'true',
    maxNetworksPerUser: num('maxNetworksPerUser', DEFAULT_SETTINGS.maxNetworksPerUser),
    defaultMaxPeers: num('defaultMaxPeers', DEFAULT_SETTINGS.defaultMaxPeers),
    relayRateKbps: num('relayRateKbps', DEFAULT_SETTINGS.relayRateKbps),
  };
}

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
}

export interface SessionIssued {
  /** 明文 token 只在签发响应中出现一次，库里只存 sha256(token) */
  token: string;
  tokenHash: string;
  expiresAt: string;
}

export interface NetworkRecord {
  /** 16 位小写 hex，store 生成 */
  id: string;
  ownerId: string;
  /** 最长 32 字符 */
  name: string;
  admissionMode: AdmissionMode;
  /** AES-256-GCM 密文（master-key.encryptSecret），库里永不存明文口令 */
  joinKeyEnc: string;
  maxPeers: number;
  createdAt: string;
}

export interface MemberRecord {
  networkId: string;
  /** 8 位小写 hex，复合主键 (networkId, nodeId) */
  nodeId: string;
  name: string | null;
  note: string | null;
  status: MemberStatus;
  publicKeyHex: string;
  /** 仅 mismatch 状态暂存待裁决的新公钥，其余状态为 null */
  candidatePublicKeyHex: string | null;
  lastIp: string | null;
  natType: NatType;
  cumulativeRelayBytes: number;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface SettingsPatch {
  allowSignup?: boolean;
  maxNetworksPerUser?: number;
  defaultMaxPeers?: number;
  relayRateKbps?: number;
}

export interface NetworkPatch {
  name?: string;
  admissionMode?: AdmissionMode;
  maxPeers?: number;
}

export interface MemberProfilePatch {
  name?: string | null;
  note?: string | null;
}

export interface JoinAttemptInput {
  networkId: string;
  nodeId: string;
  name?: string | null;
  note?: string | null;
  publicKeyHex: string;
  /** 挑战验签通过后，调用方比对 join key 的结果（HTTP 层职责，store 不碰明文口令） */
  joinKeyMatched: boolean;
}

export interface TelemetryUpdate {
  networkId: string;
  nodeId: string;
  /** 中继字节增量（SQL 侧累加，不是覆盖） */
  relayBytesDelta?: number;
  lastIp?: string | null;
  natType?: NatType | null;
  lastSeenAt?: string | null;
}

/** StoreError：业务性拒绝统一抛此错误，调用方按 code 分支（HTTP 层映射状态码） */
export type StoreErrorCode =
  | 'duplicate-email'
  | 'quota-exceeded'
  | 'limit-reached'
  | 'invalid-transition'
  | 'member-not-found'
  | 'network-not-found'
  | 'user-not-found';

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'StoreError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- 入网判定（共享决策）

export type JoinDecision = 'authorize' | 'pending' | 'reject' | 'keep' | 'mismatch' | 'limit-reached';

export interface JoinDecisionInput {
  admissionMode: AdmissionMode;
  maxPeers: number;
  /** 现有成员行；新成员传 null */
  existing: { status: MemberStatus; publicKeyHex: string } | null;
  incomingPublicKeyHex: string;
  joinKeyMatched: boolean;
  /** authorized + paused + mismatch 的成员数（mismatch 也占席位） */
  capacityUsed: number;
}

/**
 * 入网状态决策（PG-3 任务单语义 + PG-3-fix F2/F3 + PC-10 统一席位口径 + manual/both 全矩阵校准）：
 * - 已存在且非 revoked、公钥不同 → 'mismatch'（暂存候选，等管理员裁决）；但 pending（不占席）
 *   换钥滑入 mismatch（占席）是新增席位，满额时同样明确抛 'limit-reached'，不允许借道占席；
 *   authorized/paused → mismatch 是占席内的原位换钥，席位不变、不查容量；
 * - 已存在且非 revoked、公钥相同：
 *   - 若当前为 'pending' 且本次持有效口令（key/both 模式） → 按新准入校验席位升 'authorize' 或 'limit-reached'；
 *   - 其余状态 → 'keep'（保持现状，幂等；manual 下持邀请链接重试仍保持 pending）；
 * - 新成员或此前 revoked：
 *   - 口令匹配（key/both 模式）且席位未满 → 'authorize'；
 *   - 口令匹配（key/both 模式）但席位满 → 'limit-reached'（store 层转 StoreError——上层需要向节点端
 *     明确区分「网络已满」与「口令错误」，两者不能都落成 null）；
 *   - manual 模式（无论是否带邀请口令）或 both 模式无有效口令 → 'pending'（待审批，不占席位，approve 时再查容量）；
 *   - key 模式口令不匹配 → 'reject'，拒绝不入库。
 */
export function decideJoinAttempt(input: JoinDecisionInput): JoinDecision {
  const { admissionMode, maxPeers, existing, incomingPublicKeyHex, joinKeyMatched, capacityUsed } = input;
  const keyAdmitted = joinKeyMatched && (admissionMode === 'key' || admissionMode === 'both');
  if (existing !== null && existing.status !== 'revoked') {
    if (existing.publicKeyHex !== incomingPublicKeyHex) {
      if (existing.status === 'pending') {
        return capacityUsed < maxPeers ? 'mismatch' : 'limit-reached';
      }
      return 'mismatch';
    }
    if (existing.status === 'pending' && keyAdmitted) {
      return capacityUsed < maxPeers ? 'authorize' : 'limit-reached';
    }
    return 'keep';
  }
  if (keyAdmitted) return capacityUsed < maxPeers ? 'authorize' : 'limit-reached';
  if (admissionMode === 'manual' || admissionMode === 'both') return 'pending';
  return 'reject';
}

// ---------------------------------------------------------------- 状态迁移（共享决策）

export interface TransitionOutcome {
  next: MemberStatus;
  /**
   * 迁移会新增席位占用（不占席 → 占席）时需要原子校验 authorized+paused+mismatch < maxPeers，
   * 满额抛 limit-reached（PC-10 统一口径：mismatch 也占席，计数必须含它）：
   * - approve：pending 不占席，升为 authorized 会新增占用，满额拒绝；
   * - repin / resume / 幂等 approve 是占席 → 占席，席位不变、不查容量——「pending → mismatch」
   *   借道占席的路径已在入网决策（decideJoinAttempt）满额拦截，store 层无需再挡 repin；
   *   缩容后的超额存量也必须能在占席状态之间恢复/换锚。
   */
  needsCapacityCheck?: boolean;
  /** repin：candidatePublicKeyHex 提升为 publicKeyHex 并清空候选 */
  promoteCandidate?: boolean;
  /** repin（F2 加固）：迁移前要求候选公钥存在，缺失即 invalid-transition，绝不把 null 写进公钥 */
  requiresCandidate?: boolean;
}

export function decideTransition(status: MemberStatus, action: TransitionAction): TransitionOutcome | 'invalid' {
  switch (action) {
    case 'approve':
      if (status === 'pending') return { next: 'authorized', needsCapacityCheck: true };
      if (status === 'paused') return { next: 'authorized' };
      if (status === 'authorized') return { next: 'authorized' }; // 幂等
      return 'invalid';
    case 'reject':
      // pending 拒绝入网；mismatch 拒绝候选钥匙——身份可疑一律吊销，
      // 持正确凭证可经 upsertMemberJoinAttempt 重新入网（revoked 重新判定）
      if (status === 'pending' || status === 'mismatch') return { next: 'revoked' };
      return 'invalid';
    case 'pause':
      if (status === 'authorized' || status === 'paused') return { next: 'paused' }; // paused 幂等
      return 'invalid';
    case 'resume':
      if (status === 'paused' || status === 'authorized') return { next: 'authorized' }; // authorized 幂等
      return 'invalid';
    case 'repin':
      if (status === 'mismatch') {
        // mismatch 本身占席：mismatch → authorized 席位保持，不再查容量（缩容超额存量也放行）
        return { next: 'authorized', promoteCandidate: true, requiresCandidate: true };
      }
      return 'invalid';
  }
}

// ---------------------------------------------------------------- 窄接口

export interface BootstrapAdminInput {
  email: string;
  password?: string;
}

export type BootstrapAdminResult =
  | { created: true; email: string; generatedPassword?: string }
  | { created: false; email: string };

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  role: UserRole;
}

export interface CreateNetworkInput {
  ownerId: string;
  name: string;
  admissionMode: AdmissionMode;
  joinKeyEnc: string;
  maxPeers: number;
}

/** 节点端按网关地址发现网络时的最小公开摘要（不含 joinKeyEnc、不含 ownerId） */
export interface PublicNetworkSummary {
  id: string;
  name: string;
  admissionMode: AdmissionMode;
}

export interface GatewayStore {
  // 系统动态设置
  getSettings(): Promise<SystemSettings>;
  updateSettings(patch: SettingsPatch): Promise<SystemSettings>;

  // 用户与会话
  ensureBootstrapAdmin(input: BootstrapAdminInput): Promise<BootstrapAdminResult>;
  createUser(input: CreateUserInput): Promise<UserRecord>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  /** 置为 inactive 的同时清理该用户全部登录会话 */
  setUserActive(userId: string, active: boolean): Promise<void>;

  createSession(userId: string, ttlMs: number): Promise<SessionIssued>;
  /** token 有效（未过期）且用户 active 才返回用户，否则 null */
  getSessionUser(tokenHash: string, now: number): Promise<UserRecord | null>;
  deleteSession(tokenHash: string): Promise<void>;
  /** 删除全部过期会话，返回删除行数 */
  pruneExpiredSessions(now: number): Promise<number>;

  // 虚拟网络
  /** 普通租户建网数超过系统 maxNetworksPerUser 时抛 quota-exceeded；admin 不受限 */
  createNetwork(input: CreateNetworkInput): Promise<NetworkRecord>;
  listNetworksByOwner(ownerId: string): Promise<NetworkRecord[]>;
  /** 活跃账号名下的网络公开摘要（供节点端按网关地址发现并申请人工审批入网） */
  listPublicNetworks(): Promise<PublicNetworkSummary[]>;
  getNetwork(id: string): Promise<NetworkRecord | null>;
  updateNetwork(id: string, patch: NetworkPatch): Promise<NetworkRecord | null>;
  rotateNetworkJoinKey(id: string, newJoinKeyEnc: string): Promise<void>;
  /** 级联删除 network_members */
  deleteNetwork(id: string): Promise<void>;

  // 网络成员五态机
  /** 返回 null 表示拒绝不入库 */
  upsertMemberJoinAttempt(input: JoinAttemptInput): Promise<MemberRecord | null>;
  /** 非法迁移抛 invalid-transition；满额抛 limit-reached；成员不存在抛 member-not-found */
  transitionMemberStatus(networkId: string, nodeId: string, action: TransitionAction): Promise<MemberRecord>;
  /** 修改成员显示名称或备注；成员不存在抛 member-not-found */
  updateMemberProfile(networkId: string, nodeId: string, patch: MemberProfilePatch): Promise<MemberRecord>;
  removeMember(networkId: string, nodeId: string): Promise<void>;
  listMembers(networkId: string): Promise<MemberRecord[]>;
  /** 批量累加中继字节并更新 lastIp / natType / lastSeenAt */
  flushMemberTelemetry(updates: TelemetryUpdate[]): Promise<void>;

  close(): Promise<void>;
}
