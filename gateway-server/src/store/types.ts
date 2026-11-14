// GatewayStore 窄接口：屏蔽同步 SQLite 与异步 PostgreSQL 的差异，所有方法返回 Promise。
//
// 入网判定与成员状态迁移的决策逻辑在本文件以纯函数给出（decideJoinAttempt / decideTransition），
// sqlite-store 与 pg-store 都必须走同一份决策——同一语义不允许两套实现各自漂移。
import { timingSafeEqual } from 'node:crypto';

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

/**
 * 对外（HTTP）可见的系统动态设置：只有 4 个基础键。扩展内部字段（SMTP 密文、
 * admin API 哈希等）绝不出现在这里——getSettings / updateSettings 只读写它们。
 */
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

/**
 * 存储层完整设置（GC-2）：4 个基础键 + 7 个扩展键。扩展键只经
 * getExtendedSettings / updateExtendedSettings 读写，调用方（GC-6b 起的管理后端）
 * 自行保证密文/哈希不进 HTTP 响应。
 */
export interface ExtendedSystemSettings extends SystemSettings {
  requireEmailVerification: boolean;
  publicUrl: string | null;
  /** 管理端登录会话有效期（天）；钳位 1..90，默认 7（与 auth.ts 的 7 天会话默认一致） */
  sessionTtlDays: number;
  smtpConfigEnc: string | null;
  adminApiKeyHash: string | null;
  adminApiKeyPrefix: string | null;
  adminApiKeyCreatedAt: string | null;
}

export type ExtendedSettingsPatch = Partial<ExtendedSystemSettings>;

/** 扩展键的空库默认值（sessionTtlDays 与 SPEC 5.2.1 / auth.ts 的 7 天一致） */
export const DEFAULT_EXTENDED_SETTINGS: ExtendedSystemSettings = {
  ...DEFAULT_SETTINGS,
  requireEmailVerification: false,
  publicUrl: null,
  sessionTtlDays: 7,
  smtpConfigEnc: null,
  adminApiKeyHash: null,
  adminApiKeyPrefix: null,
  adminApiKeyCreatedAt: null,
};

/** 三项配额键：settings ↔ 默认组双向同步只同步这三个键 */
export const QUOTA_SETTINGS_KEYS: ReadonlyArray<keyof SystemSettings> = [
  'maxNetworksPerUser',
  'defaultMaxPeers',
  'relayRateKbps',
];

/** 基础 4 键的 camelCase → snake_case 映射（getSettings / updateSettings 只碰这些键） */
export const BASE_SETTINGS_KEYS: Readonly<Record<keyof SystemSettings, string>> = {
  allowSignup: 'allow_signup',
  maxNetworksPerUser: 'max_networks_per_user',
  defaultMaxPeers: 'default_max_peers',
  relayRateKbps: 'relay_rate_kbps',
};

/** 全部 11 键的 camelCase → snake_case 键映射，两个 store 共用 */
export const SETTINGS_KEYS: Readonly<Record<keyof ExtendedSystemSettings, string>> = {
  ...BASE_SETTINGS_KEYS,
  requireEmailVerification: 'require_email_verification',
  publicUrl: 'public_url',
  sessionTtlDays: 'session_ttl_days',
  smtpConfigEnc: 'smtp_config_enc',
  adminApiKeyHash: 'admin_api_key_hash',
  adminApiKeyPrefix: 'admin_api_key_prefix',
  adminApiKeyCreatedAt: 'admin_api_key_created_at',
};

/** settings 值统一以字符串存 key-value 表（null 存空串，读取时空串解析回 null） */
export function encodeSettingsValue(value: boolean | number | string | null): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return '';
  return String(value);
}

/** key-value 行 → SystemSettings（只解析基础 4 键，缺省键回退 DEFAULT_SETTINGS） */
export function parseSettingsRows(rows: ReadonlyArray<Record<string, unknown>>): SystemSettings {
  const map = settingsRowMap(rows);
  const num = (key: keyof SystemSettings, fallback: number): number => {
    const raw = map.get(BASE_SETTINGS_KEYS[key]);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    allowSignup: map.get(BASE_SETTINGS_KEYS.allowSignup) === 'true',
    maxNetworksPerUser: num('maxNetworksPerUser', DEFAULT_SETTINGS.maxNetworksPerUser),
    defaultMaxPeers: num('defaultMaxPeers', DEFAULT_SETTINGS.defaultMaxPeers),
    relayRateKbps: num('relayRateKbps', DEFAULT_SETTINGS.relayRateKbps),
  };
}

/**
 * key-value 行 → ExtendedSystemSettings（全 11 键）。扩展键缺行按
 * DEFAULT_EXTENDED_SETTINGS 回填；sessionTtlDays 按 SPEC 5.4.3 钳位到 1..90、缺省 7。
 */
export function parseExtendedSettingsRows(rows: ReadonlyArray<Record<string, unknown>>): ExtendedSystemSettings {
  const map = settingsRowMap(rows);
  const num = (key: keyof ExtendedSystemSettings, fallback: number): number => {
    const raw = map.get(SETTINGS_KEYS[key]);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  // 可空字符串键：缺行或空串都解析为 null（encodeSettingsValue 把 null 编码为空串）
  const text = (key: keyof ExtendedSystemSettings): string | null => {
    const raw = map.get(SETTINGS_KEYS[key]);
    return raw === undefined || raw.length === 0 ? null : raw;
  };
  return {
    ...parseSettingsRows(rows),
    requireEmailVerification: map.get(SETTINGS_KEYS.requireEmailVerification) === 'true',
    publicUrl: text('publicUrl'),
    sessionTtlDays: Math.min(90, Math.max(1, num('sessionTtlDays', DEFAULT_EXTENDED_SETTINGS.sessionTtlDays))),
    smtpConfigEnc: text('smtpConfigEnc'),
    adminApiKeyHash: text('adminApiKeyHash'),
    adminApiKeyPrefix: text('adminApiKeyPrefix'),
    adminApiKeyCreatedAt: text('adminApiKeyCreatedAt'),
  };
}

/** key-value 行 → snake_case → 原始字符串值的 Map（两种解析函数共用） */
function settingsRowMap(rows: ReadonlyArray<Record<string, unknown>>): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const key = row['key'];
    if (typeof key === 'string') map.set(key, String(row['value']));
  }
  return map;
}

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  active: boolean;
  /** 所属用户组；旧库行/缺省回落 grp_default */
  groupId: string;
  /** 组配额的到期时刻（ISO）；到期后有效配额自动回退默认组 */
  groupExpiresAt: string | null;
  /** 邮箱验证通过时刻（ISO）；null = 未验证 */
  emailVerifiedAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------- 用户组与配额（GC-2）

export const DEFAULT_GROUP_ID = 'grp_default';
export const DEFAULT_GROUP_CODE = 'default';
export const DEFAULT_GROUP_NAME = '默认用户组';

export interface UserGroupRecord {
  id: string;
  /** 小写标识（正则见 validateGroupInput），全库唯一、创建后不可改 */
  code: string;
  name: string;
  description: string;
  isDefault: boolean;
  maxNetworks: number;
  maxPeersPerNetwork: number;
  relayRateKbps: number;
  /** null = 不限月度中转流量 */
  monthlyRelayQuotaBytes: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserGroupInput {
  code: string;
  name: string;
  description?: string;
  /** 置为 true 时取消其余组的默认标记，并把三项配额写回 system_settings */
  isDefault?: boolean;
  maxNetworks: number;
  maxPeersPerNetwork: number;
  relayRateKbps: number;
  monthlyRelayQuotaBytes?: number | null;
}

export interface UpdateUserGroupPatch {
  name?: string;
  description?: string;
  isDefault?: boolean;
  maxNetworks?: number;
  maxPeersPerNetwork?: number;
  relayRateKbps?: number;
  monthlyRelayQuotaBytes?: number | null;
}

/** 管理员对用户的字段级修改（updateUserByAdmin） */
export interface AdminUserPatch {
  role?: UserRole;
  active?: boolean;
  groupId?: string;
  groupExpiresAt?: string | null;
  emailVerifiedAt?: string | null;
}

/** 用户的有效配额解析结果：到期回退默认组后，组 + 当月已用中转字节 */
export interface EffectiveUserQuota {
  group: UserGroupRecord;
  /** 用户行上登记的组 id（回退后与 group.id 不同） */
  assignedGroupId: string;
  groupExpiresAt: string | null;
  /** true = 登记的组配额已到期，本次有效值来自默认组 */
  isExpiredFallback: boolean;
  /** UTC 年月（YYYY-MM），monthlyRelayUsedBytes 的统计窗口 */
  yearMonth: string;
  monthlyRelayUsedBytes: number;
}

/**
 * 组字段校验（纯函数，两个 store 的 createUserGroup / updateUserGroup 共用）：
 * 违反任一规则直接抛带说明的 Error——这是 API 层的输入校验，不是业务性拒绝（StoreError）。
 */
export function validateGroupInput(input: {
  code: string;
  name: string;
  maxNetworks: number;
  maxPeersPerNetwork: number;
  relayRateKbps: number;
  monthlyRelayQuotaBytes?: number | null;
}): void {
  const { code, name, maxNetworks, maxPeersPerNetwork, relayRateKbps, monthlyRelayQuotaBytes } = input;
  if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(code)) {
    throw new Error('group code must match /^[a-z0-9][a-z0-9_-]{0,31}$/');
  }
  if (typeof name !== 'string' || name.length < 1 || name.length > 48) {
    throw new Error('group name must be 1..48 characters');
  }
  const intInRange = (value: number, min: number, max: number, label: string): void => {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`group ${label} must be a safe integer in ${min}..${max}`);
    }
  };
  intInRange(maxNetworks, 1, 100, 'maxNetworks');
  intInRange(maxPeersPerNetwork, 2, 64, 'maxPeersPerNetwork');
  intInRange(relayRateKbps, 64, 1048576, 'relayRateKbps');
  if (monthlyRelayQuotaBytes !== null && monthlyRelayQuotaBytes !== undefined) {
    if (!Number.isSafeInteger(monthlyRelayQuotaBytes) || monthlyRelayQuotaBytes < 1) {
      throw new Error('group monthlyRelayQuotaBytes must be null or a safe integer >= 1');
    }
  }
}

/** UTC 年月（YYYY-MM）；月度中转流量与配额窗口统一用它取月份 */
export function currentUtcYearMonth(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

// ---------------------------------------------------------------- 邮箱 OTP（GC-2）

export type EmailOtpPurpose = 'signup' | 'reset_password' | 'change_email';

export interface IssueEmailOtpInput {
  email: string;
  purpose: EmailOtpPurpose;
  /** 调用方对验证码做哈希后的值；store 只比对哈希，永不接触明文 */
  codeHash: string;
  ttlMs: number;
  cooldownMs: number;
  /** 缺省取当前时间；测试注入确定性时钟 */
  nowMs?: number;
}

export interface EmailOtpIssued {
  id: string;
  email: string;
  purpose: EmailOtpPurpose;
  expiresAt: string;
  cooldownUntil: string;
}

export interface VerifyEmailOtpInput {
  email: string;
  purpose: EmailOtpPurpose;
  codeHash: string;
  /** 连续错输次数达到该值即永久锁定该验证码（随后输入正确码也拒绝） */
  maxAttempts: number;
  nowMs?: number;
}

export type EmailOtpVerifyOutcome = 'ok' | 'invalid' | 'locked';

/**
 * OTP 校验决策（两个 store 共用，禁止各写一套漂移）：
 * - 已锁（attempts >= maxAttempts）→ locked，不再比对（正确码也拒之门外），不加次数；
 * - 哈希一致 → ok（调用方消费该验证码）；
 * - 不一致 → 本次错输计入（attempts+1）；达到阈值 → locked（该验证码此后永久失效），
 *   否则 invalid。locked 行保持未消费，锁定持续到它过期或被新签发覆盖。
 */
export function decideOtpVerify(
  row: { codeHash: string; attempts: number },
  inputCodeHash: string,
  maxAttempts: number,
): { outcome: EmailOtpVerifyOutcome; action: 'consume' | 'count-attempt' | 'none' } {
  if (row.attempts >= maxAttempts) return { outcome: 'locked', action: 'none' };
  if (constantTimeEqualText(row.codeHash, inputCodeHash)) return { outcome: 'ok', action: 'consume' };
  return {
    outcome: row.attempts + 1 >= maxAttempts ? 'locked' : 'invalid',
    action: 'count-attempt',
  };
}

/** 定长比较字符串（长度不同直接不等；等长走 timingSafeEqual 防时序侧信道） */
export function constantTimeEqualText(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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

/** updateSettings 的部分补丁：只收基础 4 键（扩展键走 ExtendedSettingsPatch） */
export type SettingsPatch = Partial<SystemSettings>;

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
  | 'user-not-found'
  // GC-2：用户组 / 唯一活跃管理员 / 邮箱 OTP
  | 'last-admin'
  | 'duplicate-group-code'
  | 'group-not-found'
  | 'cannot-delete-default-group'
  | 'group-in-use'
  | 'otp-cooldown'
  | 'otp-invalid'
  | 'otp-locked';

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
  /** 缺省落默认组（grp_default）；显式给出但组不存在抛 group-not-found */
  groupId?: string;
  groupExpiresAt?: string | null;
  emailVerifiedAt?: string | null;
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
  // 系统动态设置（基础 4 键：HTTP 响应只见这 4 个键，修改配额键时同事务双向同步当前默认组）
  getSettings(): Promise<SystemSettings>;
  updateSettings(patch: SettingsPatch): Promise<SystemSettings>;
  /**
   * 存储层完整设置（全 11 键，含 SMTP 密文 / admin API 哈希等扩展内部字段——调用方
   * 自行保证这些字段不进 HTTP 响应）；修改三项配额任一项同样同事务双向同步当前默认组。
   */
  getExtendedSettings(): Promise<ExtendedSystemSettings>;
  updateExtendedSettings(patch: ExtendedSettingsPatch): Promise<ExtendedSystemSettings>;

  // 用户与会话
  ensureBootstrapAdmin(input: BootstrapAdminInput): Promise<BootstrapAdminResult>;
  createUser(input: CreateUserInput): Promise<UserRecord>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  /**
   * 置为 inactive 的同时清理该用户全部登录会话。
   * 停用唯一活跃管理员抛 last-admin（GC-2）。
   */
  setUserActive(userId: string, active: boolean): Promise<void>;

  /** 管理员字段级修改；把唯一活跃管理员停用/降级抛 last-admin；groupId 不存在抛 group-not-found */
  updateUserByAdmin(userId: string, patch: AdminUserPatch): Promise<UserRecord>;
  /** 删除用户（会话/网络/成员/月度用量随外键级联清除）；删唯一活跃管理员抛 last-admin */
  deleteUser(userId: string): Promise<void>;
  /** 更新密码哈希；keepTokenHash 对应的会话保留（当前设备不掉线），其余全部吊销 */
  updateUserPassword(userId: string, passwordHash: string, keepTokenHash?: string): Promise<void>;
  /** 改邮箱并写验证时刻；撞已有邮箱抛 duplicate-email */
  updateUserEmail(userId: string, email: string, emailVerifiedAt: string | null): Promise<UserRecord>;
  /** 删除用户全部会话（exceptTokenHash 除外），返回删除行数 */
  deleteAllUserSessions(userId: string, exceptTokenHash?: string): Promise<number>;

  // 用户组与配额（GC-2）
  listUserGroups(): Promise<UserGroupRecord[]>;
  getUserGroup(id: string): Promise<UserGroupRecord | null>;
  getUserGroupByCode(code: string): Promise<UserGroupRecord | null>;
  /** code 重复抛 duplicate-group-code；字段非法抛 Error（validateGroupInput） */
  createUserGroup(input: CreateUserGroupInput): Promise<UserGroupRecord>;
  /** 组不存在抛 group-not-found；code 不可改；默认组三项配额同步写回 system_settings */
  updateUserGroup(id: string, patch: UpdateUserGroupPatch): Promise<UserGroupRecord>;
  /** 默认组抛 cannot-delete-default-group；仍有用户引用抛 group-in-use */
  deleteUserGroup(id: string): Promise<void>;
  /**
   * 用户的有效配额：登记组不存在或 groupExpiresAt 已到期时回退默认组（isExpiredFallback=true），
   * 并带出当月（UTC）已用中转字节。用户不存在抛 user-not-found。
   */
  resolveEffectiveUserQuota(userId: string, nowMs?: number): Promise<EffectiveUserQuota>;
  /** 网络属主的有效配额；网络不存在抛 network-not-found */
  resolveNetworkEffectiveQuota(networkId: string, nowMs?: number): Promise<EffectiveUserQuota>;

  // 月度流量（GC-2）
  /** 用户在指定 UTC 年月（YYYY-MM）已累计的中转字节；无行返回 0 */
  getMonthlyRelayUsage(userId: string, yearMonth: string): Promise<number>;

  // 邮箱 OTP（GC-2）
  /**
   * 签发验证码：同 (email, purpose) 冷却窗口内已有活跃验证码时抛 otp-cooldown；
   * 签发把旧的未消费行置为已消费。email 统一 trim + 小写。
   */
  issueEmailOtp(input: IssueEmailOtpInput): Promise<EmailOtpIssued>;
  /**
   * 校验并消费验证码：错输 attempts+1 必须先提交再抛 otp-invalid / otp-locked
   * （在事务里直接 throw 会回滚，5 次锁定形同虚设）；锁定后正确码也抛 otp-locked。
   */
  verifyAndConsumeEmailOtp(input: VerifyEmailOtpInput): Promise<void>;
  /** 删除过期验证码行，返回删除行数 */
  pruneExpiredOtps(nowMs: number): Promise<number>;

  createSession(userId: string, ttlMs: number): Promise<SessionIssued>;
  /** token 有效（未过期）且用户 active 才返回用户，否则 null */
  getSessionUser(tokenHash: string, now: number): Promise<UserRecord | null>;
  deleteSession(tokenHash: string): Promise<void>;
  /** 删除全部过期会话，返回删除行数 */
  pruneExpiredSessions(now: number): Promise<number>;

  // 虚拟网络
  /**
   * 普通租户建网数达到有效用户组的 maxNetworks 时抛 quota-exceeded；admin 不受限。
   * 有效组 = 登记组（不存在/配额到期时回退默认组，默认组缺行时兜底 system_settings）。
   */
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
