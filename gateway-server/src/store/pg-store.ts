// PostgreSQL 实现的 GatewayStore：SQL 语义与 sqlite-store 同一套（同决策纯函数、同状态迁移表）。
// 查询经注入的 query(sql, params) 执行，单测可以注入 mock；运行时用 PgStore.connect()
// 动态 import('pg') 建立连接池（ZR_GATEWAY_DATABASE_URL）。
import { createHash, randomBytes } from 'node:crypto';

import { generatePassword, hashPassword } from '../master-key.js';
import {
  BASE_SETTINGS_KEYS,
  DEFAULT_EXTENDED_SETTINGS,
  DEFAULT_GROUP_CODE,
  DEFAULT_GROUP_ID,
  DEFAULT_GROUP_NAME,
  QUOTA_SETTINGS_KEYS,
  SETTINGS_KEYS,
  SEAT_OCCUPYING_STATUSES,
  StoreError,
  currentUtcYearMonth,
  decodeMemberStatus,
  decideJoinAttempt,
  decideOtpVerify,
  decideTransition,
  encodeSettingsValue,
  parseExtendedSettingsRows,
  parseSettingsRows,
  validateGroupInput,
} from './types.js';
import type {
  AdmissionMode,
  AdminUserPatch,
  BootstrapAdminInput,
  BootstrapAdminResult,
  CreateNetworkInput,
  CreateUserGroupInput,
  CreateUserInput,
  EffectiveUserQuota,
  EmailOtpIssued,
  ExtendedSettingsPatch,
  ExtendedSystemSettings,
  GatewayStore,
  IssueEmailOtpInput,
  JoinAttemptInput,
  MemberProfilePatch,
  MemberRecord,
  MemberStatus,
  NatType,
  NetworkPatch,
  NetworkRecord,
  SessionIssued,
  SettingsPatch,
  SystemSettings,
  TelemetryUpdate,
  TransitionAction,
  UpdateUserGroupPatch,
  UserGroupRecord,
  UserRole,
  UserRecord,
  VerifyEmailOtpInput,
} from './types.js';

const PG_SCHEMA_STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','user')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    group_id TEXT NOT NULL DEFAULT 'grp_default',
    group_expires_at TIMESTAMPTZ,
    email_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)',
  `CREATE TABLE IF NOT EXISTS networks (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    admission_mode TEXT NOT NULL CHECK (admission_mode IN ('key','manual','both')),
    join_key_enc TEXT NOT NULL,
    max_peers INTEGER NOT NULL CHECK (max_peers BETWEEN 1 AND 64),
    created_at TIMESTAMPTZ NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_networks_owner_id ON networks(owner_id)',
  `CREATE TABLE IF NOT EXISTS network_members (
    network_id TEXT NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    name TEXT,
    note TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','authorized','paused','mismatch','revoked')),
    public_key_hex TEXT NOT NULL,
    candidate_public_key_hex TEXT,
    last_ip TEXT,
    nat_type TEXT NOT NULL DEFAULT 'unknown' CHECK (nat_type IN ('cone','symmetric','public','unknown')),
    cumulative_relay_bytes BIGINT NOT NULL DEFAULT 0,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (network_id, node_id)
  )`,
  // GC-2：用户组 / 月度中转流量 / 邮箱 OTP
  `CREATE TABLE IF NOT EXISTS user_groups (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    max_networks INTEGER NOT NULL,
    max_peers_per_network INTEGER NOT NULL,
    relay_rate_kbps INTEGER NOT NULL,
    monthly_relay_quota_bytes BIGINT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS monthly_relay_usage (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    year_month TEXT NOT NULL,
    relay_bytes BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, year_month)
  )`,
  `CREATE TABLE IF NOT EXISTS email_otps (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    cooldown_until TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_email_otps_lookup ON email_otps(email, purpose, created_at)',
  // 旧库平滑迁移：users 缺哪个新列就补哪个（幂等）
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS group_id TEXT NOT NULL DEFAULT 'grp_default'`,
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS group_expires_at TIMESTAMPTZ',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ',
];

/** 兼容 pg Pool.query 的最小查询接口（注入便于单测） */
export type PgQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

/**
 * 事务执行器：在单个 checkout 的连接上跑 BEGIN → fn(txQuery) → COMMIT/ROLLBACK。
 * 池模式由 connect() 提供（client.release() 在 finally）；单测注入 query 时不提供，
 * PgStore 会退化为在被注入的 query 上显式发出 BEGIN/COMMIT/ROLLBACK 语句供契约测试断言。
 */
export type PgTxRunner = (fn: (tx: PgQueryFn) => Promise<unknown>) => Promise<unknown>;

export interface PgStoreOptions {
  withTransaction?: PgTxRunner;
  onClose?: () => Promise<void>;
}

interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

type Row = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function toNum(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

/** pg 的 timestamptz 返回 Date；统一转 ISO 字符串 */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return str(value);
}

/** 可空 timestamptz → ISO 字符串或 null */
function optIso(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function optText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function mapUserRow(row: Row): UserRecord {
  return {
    id: str(row.id),
    email: str(row.email),
    passwordHash: str(row.password_hash),
    role: str(row.role) === 'admin' ? 'admin' : 'user',
    active: row.active === true || row.active === 1,
    groupId: optText(row.group_id) ?? DEFAULT_GROUP_ID,
    groupExpiresAt: optIso(row.group_expires_at),
    emailVerifiedAt: optIso(row.email_verified_at),
    createdAt: toIso(row.created_at),
  };
}

function mapGroupRow(row: Row): UserGroupRecord {
  const quota = row.monthly_relay_quota_bytes;
  return {
    id: str(row.id),
    code: str(row.code),
    name: str(row.name),
    description: typeof row.description === 'string' ? row.description : '',
    isDefault: row.is_default === true || row.is_default === 1,
    maxNetworks: toNum(row.max_networks),
    maxPeersPerNetwork: toNum(row.max_peers_per_network),
    relayRateKbps: toNum(row.relay_rate_kbps),
    monthlyRelayQuotaBytes: quota === null || quota === undefined ? null : toNum(quota),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapNetworkRow(row: Row): NetworkRecord {
  return {
    id: str(row.id),
    ownerId: str(row.owner_id),
    name: str(row.name),
    admissionMode: str(row.admission_mode) as AdmissionMode,
    joinKeyEnc: str(row.join_key_enc),
    maxPeers: toNum(row.max_peers),
    createdAt: toIso(row.created_at),
  };
}

function mapMemberRow(row: Row): MemberRecord {
  return {
    networkId: str(row.network_id),
    nodeId: str(row.node_id),
    name: optText(row.name),
    note: optText(row.note),
    status: decodeMemberStatus(str(row.status)),
    publicKeyHex: str(row.public_key_hex),
    candidatePublicKeyHex: optText(row.candidate_public_key_hex),
    lastIp: optText(row.last_ip),
    natType: str(row.nat_type) as NatType,
    cumulativeRelayBytes: toNum(row.cumulative_relay_bytes),
    lastSeenAt: row.last_seen_at === null || row.last_seen_at === undefined ? null : toIso(row.last_seen_at),
    createdAt: toIso(row.created_at),
  };
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** PostgreSQL 唯一约束冲突（23505 unique_violation）判定 */
function isPgUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

/** 占席状态 IN 列表（PC-10 统一口径，来源 SEAT_OCCUPYING_STATUSES；编译期常量，无注入面） */
const OCCUPYING_SQL = SEAT_OCCUPYING_STATUSES.map((status) => `'${status}'`).join(',');

export class PgStore implements GatewayStore {
  private readonly query: PgQueryFn;
  private readonly options: PgStoreOptions;

  constructor(query: PgQueryFn, options: PgStoreOptions = {}) {
    this.query = query;
    this.options = options;
  }

  /**
   * 事务辅助（PG-3-fix F1）：所有 check-then-act 多语句操作（配额、五态容量裁决、
   * bootstrap 管理员、禁用清会话）必须整段在一个事务里跑，防止并发超配额。
   */
  private inTransaction<T>(fn: (tx: PgQueryFn) => Promise<T>): Promise<T> {
    const runner = this.options.withTransaction;
    if (runner !== undefined) {
      return runner(fn) as Promise<T>;
    }
    // 注入模式：在被注入的 query 上显式发出事务语句（供契约测试断言顺序与回滚）
    return (async () => {
      await this.query('BEGIN', []);
      try {
        const result = await fn(this.query);
        await this.query('COMMIT', []);
        return result;
      } catch (error) {
        await this.query('ROLLBACK', []);
        throw error;
      }
    })();
  }

  /** 运行时入口：动态加载 pg 驱动建池（本包未配置 ZR_GATEWAY_DATABASE_URL 时不会走到这里） */
  static async connect(databaseUrl: string, seed?: Partial<ExtendedSystemSettings>): Promise<PgStore> {
    const mod = (await import('pg')) as unknown as { Pool?: new (options: object) => PgPoolLike; default?: { Pool?: new (options: object) => PgPoolLike } };
    const PoolCtor = mod.Pool ?? mod.default?.Pool;
    if (PoolCtor === undefined) {
      throw new Error("failed to load the 'pg' module (no Pool export); install the optional pg dependency");
    }
    const pool = new PoolCtor({ connectionString: databaseUrl, max: 10 });
    const withTransaction: PgTxRunner = async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const txQuery: PgQueryFn = async (sql, params) => {
          const result = await client.query(sql, params);
          return { rows: result.rows as Array<Record<string, unknown>> };
        };
        const result = await fn(txQuery);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* 连接已坏，释放即可 */
        }
        throw error;
      } finally {
        client.release();
      }
    };
    const store = new PgStore(
      async (sql, params) => {
        const result = await pool.query(sql, params);
        return { rows: result.rows as Array<Record<string, unknown>> };
      },
      { withTransaction, onClose: () => pool.end() },
    );
    try {
      await store.initSchema();
      // 无 seed 也做缺键补齐 + 默认组兜底（ON CONFLICT DO NOTHING 不会覆盖已有值）
      await store.seedSettings(seed ?? {});
    } catch (error) {
      // 初始化失败时归还本函数创建的 pool：store 尚未交付给调用方，没人能替它 close。
      // 归还失败（连接已坏等）吞掉、原样抛出原始错误，不得用关闭错误覆盖初始化错误。
      await pool.end().catch(() => {});
      throw error;
    }
    return store;
  }

  /** 幂等建表（CREATE IF NOT EXISTS）与旧库补列（ADD COLUMN IF NOT EXISTS），每次 connect 执行 */
  async initSchema(): Promise<void> {
    for (const ddl of PG_SCHEMA_STATEMENTS) {
      await this.query(ddl, []);
    }
  }

  /**
   * 缺键逐键播种（ON CONFLICT DO NOTHING），已有键不被 seed 覆盖；RETURNING 记录本次
   * 真正新插入的配额键，随后幂等确保默认组存在（PC-07：缺键补齐的配额同步写进活跃
   * 默认组，防止两处漂移）。同一事务连接执行（PC-06）。
   */
  private async seedSettings(seed: Partial<ExtendedSystemSettings>): Promise<void> {
    await this.inTransaction(async (tx) => {
      const insert = 'INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key';
      const filledQuotaKeys = new Set<keyof SystemSettings>();
      for (const key of Object.keys(SETTINGS_KEYS) as Array<keyof ExtendedSystemSettings>) {
        const value = seed[key] ?? DEFAULT_EXTENDED_SETTINGS[key];
        const result = await tx(insert, [SETTINGS_KEYS[key], encodeSettingsValue(value)]);
        if (result.rows.length > 0 && (QUOTA_SETTINGS_KEYS as ReadonlyArray<string>).includes(key)) {
          filledQuotaKeys.add(key as keyof SystemSettings); // includes 已收窄到三项配额键
        }
      }
      await this.ensureDefaultGroupOn(tx, filledQuotaKeys);
    });
  }

  /**
   * 幂等确保存在一个活跃默认组（is_default = TRUE）：先查现有默认组；仅当库里没有
   * 任何默认组时才插入 grp_default（行在但失活则恢复其默认标记）——绝不凭空复活
   * 第二个默认组。新插入的配额键同步写进当前活跃默认组（PC-06：一律传 q）。
   */
  private async ensureDefaultGroupOn(q: PgQueryFn, filledQuotaKeys: ReadonlySet<keyof SystemSettings>): Promise<void> {
    let active = (await q('SELECT id FROM user_groups WHERE is_default = TRUE LIMIT 1', [])).rows[0] as Row | undefined;
    if (active === undefined) {
      const settings = await this.querySettingsOn(q);
      const now = new Date();
      await q(
        `INSERT INTO user_groups
           (id, code, name, description, is_default, max_networks, max_peers_per_network, relay_rate_kbps, monthly_relay_quota_bytes, created_at, updated_at)
         VALUES ($1, $2, $3, '', TRUE, $4, $5, $6, NULL, $7, $7)
         ON CONFLICT DO NOTHING`,
        [DEFAULT_GROUP_ID, DEFAULT_GROUP_CODE, DEFAULT_GROUP_NAME, settings.maxNetworksPerUser, settings.defaultMaxPeers, settings.relayRateKbps, now],
      );
      await q('UPDATE user_groups SET is_default = TRUE, updated_at = $2 WHERE id = $1 AND is_default = FALSE', [DEFAULT_GROUP_ID, now]);
      active = (await q('SELECT id FROM user_groups WHERE is_default = TRUE LIMIT 1', [])).rows[0] as Row | undefined;
    }
    if (active !== undefined && filledQuotaKeys.size > 0) {
      await this.syncQuotaColumnsOn(q, str(active.id), filledQuotaKeys);
    }
  }

  /** 把指定配额键的 system_settings 当前值同步写进指定组行（只动列出的键；PC-06：一律传 q） */
  private async syncQuotaColumnsOn(q: PgQueryFn, groupId: string, keys: ReadonlySet<keyof SystemSettings>): Promise<void> {
    const settings = await this.querySettingsOn(q);
    const now = new Date();
    if (keys.has('maxNetworksPerUser')) {
      await q('UPDATE user_groups SET max_networks = $2, updated_at = $3 WHERE id = $1', [groupId, settings.maxNetworksPerUser, now]);
    }
    if (keys.has('defaultMaxPeers')) {
      await q('UPDATE user_groups SET max_peers_per_network = $2, updated_at = $3 WHERE id = $1', [groupId, settings.defaultMaxPeers, now]);
    }
    if (keys.has('relayRateKbps')) {
      await q('UPDATE user_groups SET relay_rate_kbps = $2, updated_at = $3 WHERE id = $1', [groupId, settings.relayRateKbps, now]);
    }
  }

  /** 默认组的三项配额写回 system_settings（用户组侧 → 设置侧的同步方向；PC-06：一律传 tx） */
  private async writeDefaultQuotasOn(
    q: PgQueryFn,
    group: { maxNetworks: number; maxPeersPerNetwork: number; relayRateKbps: number },
  ): Promise<void> {
    const upsert = 'INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value';
    await q(upsert, [SETTINGS_KEYS.maxNetworksPerUser, encodeSettingsValue(group.maxNetworks)]);
    await q(upsert, [SETTINGS_KEYS.defaultMaxPeers, encodeSettingsValue(group.maxPeersPerNetwork)]);
    await q(upsert, [SETTINGS_KEYS.relayRateKbps, encodeSettingsValue(group.relayRateKbps)]);
  }

  // ---------------------------------------------------------------- settings

  /** settings 读取的共享入口：传入哪个查询函数就在哪条连接上跑（PC-06：事务内必须传 tx） */
  private async querySettingsOn(q: PgQueryFn): Promise<SystemSettings> {
    const { rows } = await q('SELECT key, value FROM system_settings', []);
    return parseSettingsRows(rows);
  }

  async getSettings(): Promise<SystemSettings> {
    return this.querySettingsOn(this.query);
  }

  async getExtendedSettings(): Promise<ExtendedSystemSettings> {
    const { rows } = await this.query('SELECT key, value FROM system_settings', []);
    return parseExtendedSettingsRows(rows);
  }

  /**
   * 写补丁的共用实现（updateSettings / updateExtendedSettings 只差键集）：事务内
   * 逐键 upsert，改三项配额任一项即同事务写回当前活跃默认组对应列（双向同步）。
   */
  private async applySettingsPatchOn(patch: ExtendedSettingsPatch, keys: ReadonlyArray<keyof ExtendedSystemSettings>): Promise<void> {
    await this.inTransaction(async (tx) => {
      const current = await this.querySettingsOn(tx);
      const quotaTouched = QUOTA_SETTINGS_KEYS.some((key) => patch[key] !== undefined);
      const upsert =
        'INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value';
      for (const key of keys) {
        const value = patch[key];
        if (value !== undefined) {
          await tx(upsert, [SETTINGS_KEYS[key], encodeSettingsValue(value)]);
        }
      }
      if (quotaTouched) {
        await tx(
          'UPDATE user_groups SET max_networks = $1, max_peers_per_network = $2, relay_rate_kbps = $3, updated_at = $4 WHERE is_default = TRUE',
          [
            patch.maxNetworksPerUser ?? current.maxNetworksPerUser,
            patch.defaultMaxPeers ?? current.defaultMaxPeers,
            patch.relayRateKbps ?? current.relayRateKbps,
            new Date(),
          ],
        );
      }
    });
  }

  async updateSettings(patch: SettingsPatch): Promise<SystemSettings> {
    await this.applySettingsPatchOn(patch, Object.keys(BASE_SETTINGS_KEYS) as Array<keyof SystemSettings>);
    return this.getSettings();
  }

  async updateExtendedSettings(patch: ExtendedSettingsPatch): Promise<ExtendedSystemSettings> {
    await this.applySettingsPatchOn(patch, Object.keys(SETTINGS_KEYS) as Array<keyof ExtendedSystemSettings>);
    return this.getExtendedSettings();
  }

  // ---------------------------------------------------------------- users & sessions

  async ensureBootstrapAdmin(input: BootstrapAdminInput): Promise<BootstrapAdminResult> {
    return this.inTransaction(async (tx) => {
      // 锁已有 admin 行：并发 bootstrap 时串行化判定（无 admin 行时靠 email 唯一约束兜底）
      const existing = await tx("SELECT id FROM users WHERE role = 'admin' LIMIT 1 FOR UPDATE", []);
      if (existing.rows.length > 0) {
        return { created: false, email: input.email };
      }
      const generatedPassword = input.password === undefined ? generatePassword() : undefined;
      const passwordHash = await hashPassword(input.password ?? (generatedPassword as string));
      const id = randomBytes(12).toString('hex');
      await tx(
        'INSERT INTO users (id, email, password_hash, role, active, created_at) VALUES ($1, $2, $3, $4, TRUE, $5)',
        [id, input.email, passwordHash, 'admin', new Date()],
      );
      if (generatedPassword === undefined) {
        return { created: true, email: input.email };
      }
      return { created: true, email: input.email, generatedPassword };
    });
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    // 整段单事务（PC-06）：组存在性预查（users.group_id 无外键约束，坏 id 会静默落库）
    // 与 INSERT 原子；未显式指定组（含 groupId: null，GC-fix-batch1 R3）时 INSERT 内
    // COALESCE 子查询原子写入当前活跃默认组（可能与 grp_default 不同）。并发撞 email
    // 唯一约束（23505）统一转 StoreError。
    try {
      return await this.inTransaction(async (tx) => {
        if (input.groupId !== undefined && input.groupId !== null) {
          const group = await tx('SELECT id FROM user_groups WHERE id = $1', [input.groupId]);
          if (group.rows.length === 0) {
            throw new StoreError('group-not-found', `user group ${input.groupId} does not exist`);
          }
        }
        const id = randomBytes(12).toString('hex');
        const inserted = await tx(
          `INSERT INTO users (id, email, password_hash, role, active, group_id, group_expires_at, email_verified_at, created_at)
           VALUES ($1, $2, $3, $4, TRUE, COALESCE($5, (SELECT id FROM user_groups WHERE is_default = TRUE LIMIT 1), '${DEFAULT_GROUP_ID}'), $6, $7, $8) RETURNING *`,
          [
            id,
            input.email,
            input.passwordHash,
            input.role,
            input.groupId ?? null,
            input.groupExpiresAt ?? null,
            input.emailVerifiedAt ?? null,
            new Date(),
          ],
        );
        return mapUserRow(inserted.rows[0] as Row);
      });
    } catch (error) {
      if (isPgUniqueViolation(error)) {
        throw new StoreError('duplicate-email', `user with email ${input.email} already exists`);
      }
      throw error;
    }
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows.length > 0 ? mapUserRow(rows[0] as Row) : null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const { rows } = await this.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows.length > 0 ? mapUserRow(rows[0] as Row) : null;
  }

  async listUsers(): Promise<UserRecord[]> {
    const { rows } = await this.query('SELECT * FROM users ORDER BY created_at, id', []);
    return rows.map((row) => mapUserRow(row as Row));
  }

  /**
   * 唯一活跃管理员保护：目标是当前活跃 admin、且本次操作会移除其 admin/active 身份时，
   * 活跃 admin 必须多于 1，否则抛 last-admin（判定在持有目标行锁的事务内执行，PC-06：一律传 tx）。
   */
  private async assertNotLastActiveAdminOn(q: PgQueryFn, row: Row, nextActive: boolean, nextRole?: UserRole): Promise<void> {
    const isCurrentlyActiveAdmin = str(row.role) === 'admin' && (row.active === true || row.active === 1);
    const losesAdminStanding = (nextRole !== undefined && nextRole !== 'admin') || !nextActive;
    if (!isCurrentlyActiveAdmin || !losesAdminStanding) return;
    const counted = await q("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = TRUE", []);
    if (toNum((counted.rows[0] as Row | undefined)?.count) <= 1) {
      throw new StoreError('last-admin', 'cannot demote or disable the only active admin');
    }
  }

  async setUserActive(userId: string, active: boolean): Promise<void> {
    await this.inTransaction(async (tx) => {
      // 锁目标行：last-admin 判定与状态翻转在事务上串行化
      const found = await tx('SELECT role, active FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (found.rows.length === 0) {
        throw new StoreError('user-not-found', `user ${userId} does not exist`);
      }
      await this.assertNotLastActiveAdminOn(tx, found.rows[0] as Row, active);
      const updated = await tx('UPDATE users SET active = $2 WHERE id = $1 RETURNING id', [userId, active]);
      if (updated.rows.length === 0) {
        throw new StoreError('user-not-found', `user ${userId} does not exist`);
      }
      if (!active) {
        // 禁用即吊销全部登录会话（与状态翻转同事务，不允许半途）
        await tx('DELETE FROM sessions WHERE user_id = $1', [userId]);
      }
    });
  }

  async updateUserByAdmin(userId: string, patch: AdminUserPatch): Promise<UserRecord> {
    return this.inTransaction(async (tx) => {
      const found = await tx('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (found.rows.length === 0) {
        throw new StoreError('user-not-found', `user ${userId} does not exist`);
      }
      const row = found.rows[0] as Row;
      const nextActive = patch.active ?? (row.active === true || row.active === 1);
      const nextRole: UserRole = patch.role ?? (str(row.role) === 'admin' ? 'admin' : 'user');
      await this.assertNotLastActiveAdminOn(tx, row, nextActive, nextRole);
      if (typeof patch.groupId === 'string') {
        const group = await tx('SELECT id FROM user_groups WHERE id = $1', [patch.groupId]);
        if (group.rows.length === 0) {
          throw new StoreError('group-not-found', `user group ${patch.groupId} does not exist`);
        }
      }
      // GC-fix-batch1 R3：string = 显式组；null = 同事务解析当前活跃默认组（可能与
      // grp_default 不同），绝不硬编码；undefined = 保持原值
      let nextGroupId: string;
      if (typeof patch.groupId === 'string') {
        nextGroupId = patch.groupId;
      } else if (patch.groupId === null) {
        const active = await tx('SELECT id FROM user_groups WHERE is_default = TRUE LIMIT 1', []);
        const activeRow = active.rows[0] as Row | undefined;
        nextGroupId = activeRow !== undefined ? str(activeRow.id) : DEFAULT_GROUP_ID;
      } else {
        nextGroupId = optText(row.group_id) ?? DEFAULT_GROUP_ID;
      }
      const nextGroupExpiresAt = patch.groupExpiresAt !== undefined ? patch.groupExpiresAt : optIso(row.group_expires_at);
      const nextEmailVerifiedAt = patch.emailVerifiedAt !== undefined ? patch.emailVerifiedAt : optIso(row.email_verified_at);
      const updated = await tx(
        'UPDATE users SET role = $2, active = $3, group_id = $4, group_expires_at = $5, email_verified_at = $6 WHERE id = $1 RETURNING *',
        [userId, nextRole, nextActive, nextGroupId, nextGroupExpiresAt, nextEmailVerifiedAt],
      );
      // 停用即吊销全部登录会话（与 setUserActive 同语义）
      if (!nextActive) {
        await tx('DELETE FROM sessions WHERE user_id = $1', [userId]);
      }
      return mapUserRow(updated.rows[0] as Row);
    });
  }

  async deleteUser(userId: string): Promise<void> {
    await this.inTransaction(async (tx) => {
      const found = await tx('SELECT role, active FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (found.rows.length === 0) {
        throw new StoreError('user-not-found', `user ${userId} does not exist`);
      }
      await this.assertNotLastActiveAdminOn(tx, found.rows[0] as Row, false);
      // sessions / networks / network_members / monthly_relay_usage 随外键级联清除
      await tx('DELETE FROM users WHERE id = $1', [userId]);
    });
  }

  async updateUserPassword(userId: string, passwordHash: string, keepTokenHash?: string): Promise<void> {
    await this.inTransaction(async (tx) => {
      const found = await tx('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (found.rows.length === 0) {
        throw new StoreError('user-not-found', `user ${userId} does not exist`);
      }
      await tx('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
      // keepTokenHash 对应会话保留（当前设备不掉线），其余全部吊销
      await tx('DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR token_hash <> $2)', [userId, keepTokenHash ?? null]);
    });
  }

  async updateUserEmail(userId: string, email: string, emailVerifiedAt: string | null): Promise<UserRecord> {
    try {
      return await this.inTransaction(async (tx) => {
        const found = await tx('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
        if (found.rows.length === 0) {
          throw new StoreError('user-not-found', `user ${userId} does not exist`);
        }
        const existing = await tx('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0 && str((existing.rows[0] as Row).id) !== userId) {
          throw new StoreError('duplicate-email', `user with email ${email} already exists`);
        }
        const updated = await tx(
          'UPDATE users SET email = $2, email_verified_at = $3 WHERE id = $1 RETURNING *',
          [userId, email, emailVerifiedAt],
        );
        return mapUserRow(updated.rows[0] as Row);
      });
    } catch (error) {
      // 并发撞 email 唯一约束（23505）统一转 StoreError
      if (isPgUniqueViolation(error)) {
        throw new StoreError('duplicate-email', `user with email ${email} already exists`);
      }
      throw error;
    }
  }

  async deleteAllUserSessions(userId: string, exceptTokenHash?: string): Promise<number> {
    return this.inTransaction(async (tx) => {
      const found = await tx('SELECT id FROM users WHERE id = $1', [userId]);
      if (found.rows.length === 0) {
        throw new StoreError('user-not-found', `user ${userId} does not exist`);
      }
      const deleted = await tx(
        'DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR token_hash <> $2) RETURNING token_hash',
        [userId, exceptTokenHash ?? null],
      );
      return deleted.rows.length;
    });
  }

  async createSession(userId: string, ttlMs: number): Promise<SessionIssued> {
    const token = randomBytes(32).toString('hex');
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.query(
      'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)',
      [tokenHash, userId, expiresAt, new Date()],
    );
    return { token, tokenHash, expiresAt: expiresAt.toISOString() };
  }

  async getSessionUser(tokenHash: string, now: number): Promise<UserRecord | null> {
    const { rows } = await this.query(
      'SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1',
      [tokenHash],
    );
    if (rows.length === 0) return null;
    const row = rows[0] as Row;
    const expiresAt = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(str(row.expires_at));
    if (!(expiresAt > now)) return null;
    if (!(row.active === true || row.active === 1)) return null;
    return mapUserRow(row);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  async pruneExpiredSessions(now: number): Promise<number> {
    const { rows } = await this.query('DELETE FROM sessions WHERE expires_at <= $1 RETURNING token_hash', [new Date(now)]);
    return rows.length;
  }

  // ---------------------------------------------------------------- user groups

  async listUserGroups(): Promise<UserGroupRecord[]> {
    const { rows } = await this.query('SELECT * FROM user_groups ORDER BY is_default DESC, code', []);
    return rows.map((row) => mapGroupRow(row as Row));
  }

  async getUserGroup(id: string): Promise<UserGroupRecord | null> {
    const { rows } = await this.query('SELECT * FROM user_groups WHERE id = $1', [id]);
    return rows.length > 0 ? mapGroupRow(rows[0] as Row) : null;
  }

  async getUserGroupByCode(code: string): Promise<UserGroupRecord | null> {
    const { rows } = await this.query('SELECT * FROM user_groups WHERE code = $1', [code]);
    return rows.length > 0 ? mapGroupRow(rows[0] as Row) : null;
  }

  async createUserGroup(input: CreateUserGroupInput): Promise<UserGroupRecord> {
    const description = input.description ?? '';
    const isDefault = input.isDefault ?? false;
    const monthlyRelayQuotaBytes = input.monthlyRelayQuotaBytes ?? null;
    validateGroupInput({
      code: input.code,
      name: input.name,
      maxNetworks: input.maxNetworks,
      maxPeersPerNetwork: input.maxPeersPerNetwork,
      relayRateKbps: input.relayRateKbps,
      monthlyRelayQuotaBytes,
    });
    const id = `grp_${randomBytes(8).toString('hex')}`;
    try {
      return await this.inTransaction(async (tx) => {
        const existing = await tx('SELECT id FROM user_groups WHERE code = $1', [input.code]);
        if (existing.rows.length > 0) {
          throw new StoreError('duplicate-group-code', `user group code ${input.code} already exists`);
        }
        if (isDefault) {
          await tx('UPDATE user_groups SET is_default = FALSE WHERE is_default = TRUE', []);
        }
        const inserted = await tx(
          'INSERT INTO user_groups (id, code, name, description, is_default, max_networks, max_peers_per_network, relay_rate_kbps, monthly_relay_quota_bytes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING *',
          [id, input.code, input.name, description, isDefault, input.maxNetworks, input.maxPeersPerNetwork, input.relayRateKbps, monthlyRelayQuotaBytes, new Date()],
        );
        // 新默认组的三项配额写回 system_settings（同事务，双向同步）
        if (isDefault) {
          await this.writeDefaultQuotasOn(tx, input);
        }
        return mapGroupRow(inserted.rows[0] as Row);
      });
    } catch (error) {
      // 并发撞 code 唯一约束（23505）统一转 StoreError
      if (isPgUniqueViolation(error)) {
        throw new StoreError('duplicate-group-code', `user group code ${input.code} already exists`);
      }
      throw error;
    }
  }

  async updateUserGroup(id: string, patch: UpdateUserGroupPatch): Promise<UserGroupRecord> {
    return this.inTransaction(async (tx) => {
      // 锁组行：默认标记切换与配额同步在事务上串行化
      const found = await tx('SELECT * FROM user_groups WHERE id = $1 FOR UPDATE', [id]);
      if (found.rows.length === 0) {
        throw new StoreError('group-not-found', `user group ${id} does not exist`);
      }
      const existing = mapGroupRow(found.rows[0] as Row);
      // code 不可改；数值与名称规则复用 validateGroupInput（传入合并后的完整字段）
      const merged = {
        name: patch.name ?? existing.name,
        description: 'description' in patch ? (patch.description ?? '') : existing.description,
        isDefault: patch.isDefault ?? existing.isDefault,
        maxNetworks: patch.maxNetworks ?? existing.maxNetworks,
        maxPeersPerNetwork: patch.maxPeersPerNetwork ?? existing.maxPeersPerNetwork,
        relayRateKbps: patch.relayRateKbps ?? existing.relayRateKbps,
        monthlyRelayQuotaBytes: 'monthlyRelayQuotaBytes' in patch ? (patch.monthlyRelayQuotaBytes ?? null) : existing.monthlyRelayQuotaBytes,
      };
      validateGroupInput({
        code: existing.code,
        name: merged.name,
        maxNetworks: merged.maxNetworks,
        maxPeersPerNetwork: merged.maxPeersPerNetwork,
        relayRateKbps: merged.relayRateKbps,
        monthlyRelayQuotaBytes: merged.monthlyRelayQuotaBytes,
      });
      if (merged.isDefault && !existing.isDefault) {
        await tx('UPDATE user_groups SET is_default = FALSE WHERE id != $1 AND is_default = TRUE', [id]);
      }
      const updated = await tx(
        'UPDATE user_groups SET name = $2, description = $3, is_default = $4, max_networks = $5, max_peers_per_network = $6, relay_rate_kbps = $7, monthly_relay_quota_bytes = $8, updated_at = $9 WHERE id = $1 RETURNING *',
        [id, merged.name, merged.description, merged.isDefault, merged.maxNetworks, merged.maxPeersPerNetwork, merged.relayRateKbps, merged.monthlyRelayQuotaBytes, new Date()],
      );
      // 默认组三项配额同步写回 system_settings（含「修改当前默认组配额」的情形）
      if (merged.isDefault) {
        await this.writeDefaultQuotasOn(tx, merged);
      }
      return mapGroupRow(updated.rows[0] as Row);
    });
  }

  async deleteUserGroup(id: string): Promise<void> {
    await this.inTransaction(async (tx) => {
      const found = await tx('SELECT * FROM user_groups WHERE id = $1 FOR UPDATE', [id]);
      if (found.rows.length === 0) {
        throw new StoreError('group-not-found', `user group ${id} does not exist`);
      }
      const row = found.rows[0] as Row;
      if (row.is_default === true || row.is_default === 1) {
        throw new StoreError('cannot-delete-default-group', 'the default user group cannot be deleted');
      }
      const counted = await tx('SELECT COUNT(*) AS count FROM users WHERE group_id = $1', [id]);
      if (toNum((counted.rows[0] as Row | undefined)?.count) > 0) {
        throw new StoreError('group-in-use', `user group ${id} still has users assigned`);
      }
      await tx('DELETE FROM user_groups WHERE id = $1', [id]);
    });
  }

  /**
   * 有效组解析（共享入口）：配额到期或登记组行缺失时回退默认组。回退跟随当前活跃
   * 默认组（is_default = TRUE，可能与 grp_default 不同）；连活跃默认组都没有
   * （损坏库/mock 空结果）时才按 grp_default id 兜底，最后按 system_settings 合成。
   * 传入哪个查询函数就在哪条连接上跑（PC-06：事务内必须传 tx）。
   */
  private async resolveEffectiveGroupOn(
    q: PgQueryFn,
    assignedGroupId: string,
    groupExpiresAt: string | null,
    nowMs: number,
  ): Promise<{ group: UserGroupRecord; isExpiredFallback: boolean }> {
    const expiresMs = groupExpiresAt !== null ? Date.parse(groupExpiresAt) : Number.NaN;
    const isExpiredFallback = Number.isFinite(expiresMs) && expiresMs <= nowMs;
    let row: Row | undefined;
    if (!isExpiredFallback) {
      const found = await q('SELECT * FROM user_groups WHERE id = $1', [assignedGroupId]);
      row = found.rows[0] as Row | undefined;
    }
    if (row === undefined) {
      const activeDefault = await q('SELECT * FROM user_groups WHERE is_default = TRUE LIMIT 1', []);
      row = activeDefault.rows[0] as Row | undefined;
    }
    if (row === undefined) {
      const fallback = await q('SELECT * FROM user_groups WHERE id = $1', [DEFAULT_GROUP_ID]);
      row = fallback.rows[0] as Row | undefined;
    }
    return {
      group: row !== undefined ? mapGroupRow(row) : await this.syntheticDefaultGroupOn(q),
      isExpiredFallback,
    };
  }

  /** 默认组行缺失（损坏库）时的兜底：按当前 system_settings 合成 grp_default 记录 */
  private async syntheticDefaultGroupOn(q: PgQueryFn): Promise<UserGroupRecord> {
    const settings = await this.querySettingsOn(q);
    const epoch = new Date(0).toISOString();
    return {
      id: DEFAULT_GROUP_ID,
      code: DEFAULT_GROUP_CODE,
      name: DEFAULT_GROUP_NAME,
      description: '',
      isDefault: true,
      maxNetworks: settings.maxNetworksPerUser,
      maxPeersPerNetwork: settings.defaultMaxPeers,
      relayRateKbps: settings.relayRateKbps,
      monthlyRelayQuotaBytes: null,
      createdAt: epoch,
      updatedAt: epoch,
    };
  }

  async resolveEffectiveUserQuota(userId: string, nowMs?: number): Promise<EffectiveUserQuota> {
    const at = nowMs ?? Date.now();
    const found = await this.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (found.rows.length === 0) {
      throw new StoreError('user-not-found', `user ${userId} does not exist`);
    }
    const user = mapUserRow(found.rows[0] as Row);
    const { group, isExpiredFallback } = await this.resolveEffectiveGroupOn(this.query, user.groupId, user.groupExpiresAt, at);
    const yearMonth = currentUtcYearMonth(at);
    const usage = await this.query('SELECT relay_bytes FROM monthly_relay_usage WHERE user_id = $1 AND year_month = $2', [
      userId,
      yearMonth,
    ]);
    return {
      group,
      assignedGroupId: user.groupId,
      groupExpiresAt: user.groupExpiresAt,
      isExpiredFallback,
      yearMonth,
      monthlyRelayUsedBytes: usage.rows.length > 0 ? toNum((usage.rows[0] as Row).relay_bytes) : 0,
    };
  }

  async resolveNetworkEffectiveQuota(networkId: string, nowMs?: number): Promise<EffectiveUserQuota> {
    const found = await this.query('SELECT owner_id FROM networks WHERE id = $1', [networkId]);
    if (found.rows.length === 0) {
      throw new StoreError('network-not-found', `network ${networkId} does not exist`);
    }
    return this.resolveEffectiveUserQuota(str((found.rows[0] as Row).owner_id), nowMs);
  }

  async getMonthlyRelayUsage(userId: string, yearMonth: string): Promise<number> {
    const { rows } = await this.query('SELECT relay_bytes FROM monthly_relay_usage WHERE user_id = $1 AND year_month = $2', [
      userId,
      yearMonth,
    ]);
    return rows.length > 0 ? toNum((rows[0] as Row).relay_bytes) : 0;
  }

  // ---------------------------------------------------------------- email OTP

  /** (email, purpose) 最新一条活跃（未消费且未过期）验证码行 */
  private async getActiveOtpRowOn(q: PgQueryFn, email: string, purpose: string, now: Date): Promise<Row | undefined> {
    const found = await q(
      'SELECT * FROM email_otps WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > $3 ORDER BY created_at DESC, id DESC LIMIT 1',
      [email, purpose, now],
    );
    return found.rows[0] as Row | undefined;
  }

  async issueEmailOtp(input: IssueEmailOtpInput): Promise<EmailOtpIssued> {
    const email = input.email.trim().toLowerCase();
    const nowMs = input.nowMs ?? Date.now();
    const now = new Date(nowMs);
    const expiresAt = new Date(nowMs + input.ttlMs);
    const cooldownUntil = new Date(nowMs + input.cooldownMs);
    return this.inTransaction(async (tx) => {
      const active = await this.getActiveOtpRowOn(tx, email, input.purpose, now);
      if (active !== undefined) {
        const activeCooldownMs =
          active.cooldown_until instanceof Date ? active.cooldown_until.getTime() : Date.parse(str(active.cooldown_until));
        if (Number.isFinite(activeCooldownMs) && activeCooldownMs > nowMs) {
          throw new StoreError('otp-cooldown', `an otp for ${email} (${input.purpose}) was issued recently`);
        }
      }
      // 冷却已过：旧未消费行全部置为已消费，再插入新行
      await tx('UPDATE email_otps SET consumed_at = $1 WHERE email = $2 AND purpose = $3 AND consumed_at IS NULL', [
        now,
        email,
        input.purpose,
      ]);
      const id = randomBytes(12).toString('hex');
      await tx(
        'INSERT INTO email_otps (id, email, purpose, code_hash, attempts, expires_at, cooldown_until, consumed_at, created_at) VALUES ($1, $2, $3, $4, 0, $5, $6, NULL, $7)',
        [id, email, input.purpose, input.codeHash, expiresAt, cooldownUntil, now],
      );
      return { id, email, purpose: input.purpose, expiresAt: expiresAt.toISOString(), cooldownUntil: cooldownUntil.toISOString() };
    });
  }

  async verifyAndConsumeEmailOtp(input: VerifyEmailOtpInput): Promise<void> {
    const email = input.email.trim().toLowerCase();
    const nowMs = input.nowMs ?? Date.now();
    const now = new Date(nowMs);
    // 关键：决策在事务内落库（消费 / 计错次数），StoreError 必须在事务提交之后抛——
    // 事务回调里直接 throw 会回滚，attempts 永远加不上去，5 次锁定形同虚设。
    const outcome = await this.inTransaction(async (tx) => {
      const row = await this.getActiveOtpRowOn(tx, email, input.purpose, now);
      if (row === undefined) {
        return 'invalid' as const;
      }
      const decision = decideOtpVerify({ codeHash: str(row.code_hash), attempts: toNum(row.attempts) }, input.codeHash, input.maxAttempts);
      if (decision.action === 'consume') {
        await tx('UPDATE email_otps SET consumed_at = $1 WHERE id = $2', [now, str(row.id)]);
      } else if (decision.action === 'count-attempt') {
        await tx('UPDATE email_otps SET attempts = attempts + 1 WHERE id = $1', [str(row.id)]);
      }
      return decision.outcome;
    });
    if (outcome === 'locked') {
      throw new StoreError('otp-locked', `otp for ${email} (${input.purpose}) is locked after too many failed attempts`);
    }
    if (outcome === 'invalid') {
      throw new StoreError('otp-invalid', `otp for ${email} (${input.purpose}) is invalid or expired`);
    }
  }

  async pruneExpiredOtps(nowMs: number): Promise<number> {
    const { rows } = await this.query('DELETE FROM email_otps WHERE expires_at <= $1 RETURNING id', [new Date(nowMs)]);
    return rows.length;
  }

  // ---------------------------------------------------------------- networks

  /**
   * 有效组的 maxNetworks（tx-only）：登记组缺失/到期回退默认组——先查活跃默认组
   * （is_default = TRUE），空结果再按 grp_default id 兜底；组行全缺（损坏库）最后
   * 按 system_settings 兜底，行为与旧版配额一致（PC-06：一律传 tx）。
   */
  private async resolveMaxNetworksOn(
    tx: PgQueryFn,
    assignedGroupId: string,
    groupExpiresAt: string | null,
    nowMs: number,
  ): Promise<number> {
    const expiresMs = groupExpiresAt !== null ? Date.parse(groupExpiresAt) : Number.NaN;
    const expired = Number.isFinite(expiresMs) && expiresMs <= nowMs;
    let rows: Array<Record<string, unknown>> = [];
    if (!expired) {
      const found = await tx('SELECT max_networks FROM user_groups WHERE id = $1', [assignedGroupId]);
      rows = found.rows;
    }
    if (rows.length === 0) {
      const activeDefault = await tx('SELECT max_networks FROM user_groups WHERE is_default = TRUE LIMIT 1', []);
      rows = activeDefault.rows;
    }
    if (rows.length === 0) {
      const fallback = await tx('SELECT max_networks FROM user_groups WHERE id = $1', [DEFAULT_GROUP_ID]);
      rows = fallback.rows;
    }
    if (rows.length > 0) return toNum((rows[0] as Row).max_networks);
    const settings = await this.querySettingsOn(tx);
    return settings.maxNetworksPerUser;
  }

  async createNetwork(input: CreateNetworkInput): Promise<NetworkRecord> {
    return this.inTransaction(async (tx) => {
      // 锁 owner 行：同一租户的并发建网在事务上串行化，配额不会被并发穿透
      const owner = await tx('SELECT role, group_id, group_expires_at FROM users WHERE id = $1 FOR UPDATE', [input.ownerId]);
      if (owner.rows.length === 0) {
        throw new StoreError('user-not-found', `owner ${input.ownerId} does not exist`);
      }
      const ownerRow = owner.rows[0] as Row;
      if (str(ownerRow.role) !== 'admin') {
        // 单语句原子配额：COUNT 与限额同语句求值，超限行 over = true。
        // 有效组 = 登记组（缺失/到期回退默认组），限额来自组的 max_networks。
        // （PC-06：组解析与 settings 兜底全部复用当前事务连接——已持 owner 行锁，
        // 再从外层池借第二条连接会让同 owner 的并发请求在池耗尽后互相等待）
        const assignedGroupId = optText(ownerRow.group_id) ?? DEFAULT_GROUP_ID;
        const groupExpiresAt = optIso(ownerRow.group_expires_at);
        const limit = await this.resolveMaxNetworksOn(tx, assignedGroupId, groupExpiresAt, Date.now());
        const counted = await tx(
          'SELECT COUNT(*) AS count, COUNT(*) >= $2 AS over FROM networks WHERE owner_id = $1',
          [input.ownerId, limit],
        );
        const countRow = (counted.rows[0] ?? {}) as Row;
        const over = countRow.over === true || toNum(countRow.count) >= limit;
        if (over) {
          throw new StoreError('quota-exceeded', `network quota exhausted (limit ${limit})`);
        }
      }
      const id = randomBytes(8).toString('hex');
      const inserted = await tx(
        'INSERT INTO networks (id, owner_id, name, admission_mode, join_key_enc, max_peers, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [id, input.ownerId, input.name, input.admissionMode, input.joinKeyEnc, input.maxPeers, new Date()],
      );
      return mapNetworkRow(inserted.rows[0] as Row);
    });
  }

  async listNetworksByOwner(ownerId: string): Promise<NetworkRecord[]> {
    const { rows } = await this.query('SELECT * FROM networks WHERE owner_id = $1 ORDER BY created_at, id', [ownerId]);
    return rows.map((row) => mapNetworkRow(row as Row));
  }

  async listPublicNetworks(): Promise<Array<{ id: string; name: string; admissionMode: AdmissionMode }>> {
    const { rows } = await this.query(
      'SELECT n.id, n.name, n.admission_mode FROM networks n JOIN users u ON u.id = n.owner_id WHERE u.active = TRUE ORDER BY n.created_at, n.id',
      [],
    );
    return rows.map((row) => ({
      id: str((row as Row).id),
      name: str((row as Row).name),
      admissionMode: str((row as Row).admission_mode) as AdmissionMode,
    }));
  }

  async getNetwork(id: string): Promise<NetworkRecord | null> {
    const { rows } = await this.query('SELECT * FROM networks WHERE id = $1', [id]);
    return rows.length > 0 ? mapNetworkRow(rows[0] as Row) : null;
  }

  async updateNetwork(id: string, patch: NetworkPatch): Promise<NetworkRecord | null> {
    const existing = await this.getNetwork(id);
    if (existing === null) return null;
    const next = {
      name: patch.name ?? existing.name,
      admissionMode: patch.admissionMode ?? existing.admissionMode,
      maxPeers: patch.maxPeers ?? existing.maxPeers,
    };
    await this.query('UPDATE networks SET name = $2, admission_mode = $3, max_peers = $4 WHERE id = $1', [
      id,
      next.name,
      next.admissionMode,
      next.maxPeers,
    ]);
    return this.getNetwork(id);
  }

  async rotateNetworkJoinKey(id: string, newJoinKeyEnc: string): Promise<void> {
    await this.query('UPDATE networks SET join_key_enc = $2 WHERE id = $1', [id, newJoinKeyEnc]);
  }

  async deleteNetwork(id: string): Promise<void> {
    // network_members 由 FK ON DELETE CASCADE 级联清除
    await this.query('DELETE FROM networks WHERE id = $1', [id]);
  }

  // ---------------------------------------------------------------- members

  async upsertMemberJoinAttempt(input: JoinAttemptInput): Promise<MemberRecord | null> {
    return this.inTransaction(async (tx) => {
      // 锁网络行：同网络的入网判定串行化，容量计数不会被并发入网穿透
      const network = await tx('SELECT id, admission_mode, max_peers FROM networks WHERE id = $1 FOR UPDATE', [input.networkId]);
      if (network.rows.length === 0) {
        throw new StoreError('network-not-found', `network ${input.networkId} does not exist`);
      }
      const networkRow = network.rows[0] as Row;

      const existingResult = await tx('SELECT * FROM network_members WHERE network_id = $1 AND node_id = $2', [
        input.networkId,
        input.nodeId,
      ]);
      const existingRow = existingResult.rows.length > 0 ? (existingResult.rows[0] as Row) : null;
      const decisionExisting: { status: MemberStatus; publicKeyHex: string } | null =
        existingRow === null
          ? null
          : { status: decodeMemberStatus(str(existingRow.status)), publicKeyHex: str(existingRow.public_key_hex) };

      // 容量计数在首次准入、revoked 重入或 pending（补交口令直升 / 换钥滑入 mismatch）时查询；
      // 口径与 approve 审批一致：authorized+paused+mismatch（PC-10 统一占席规则）
      let capacityUsed = 0;
      if (decisionExisting === null || decisionExisting.status === 'revoked' || decisionExisting.status === 'pending') {
        const counted = await tx(
          `SELECT COUNT(*) AS count FROM network_members WHERE network_id = $1 AND status IN (${OCCUPYING_SQL})`,
          [input.networkId],
        );
        capacityUsed = toNum((counted.rows[0] as Row | undefined)?.count);
      }

      // GC-fix-batch1 R1：调用方压入的 maxPeersCap 与网络容量取小后作为同一事务内的
      // 有效席位上限（非管理员属主的用户组 maxPeersPerNetwork 经此原子生效）；
      // 查询次数与顺序保持不变，只在求值处取小
      const effectiveMax = input.maxPeersCap !== undefined
        ? Math.min(toNum(networkRow.max_peers), input.maxPeersCap)
        : toNum(networkRow.max_peers);
      const decision = decideJoinAttempt({
        admissionMode: str(networkRow.admission_mode) as AdmissionMode,
        maxPeers: effectiveMax,
        existing: decisionExisting,
        incomingPublicKeyHex: input.publicKeyHex,
        joinKeyMatched: input.joinKeyMatched,
        capacityUsed,
      });

      if (decision === 'reject') return null;
      if (decision === 'limit-reached') {
        // F3：口令匹配但席位满，明确抛错，让上层能把「网络已满」与「口令错误」区分开
        throw new StoreError('limit-reached', `network ${input.networkId} is at max peers (${effectiveMax})`);
      }
      if (decision === 'keep' && existingRow !== null) return mapMemberRow(existingRow);
      if (decision === 'mismatch' && existingRow !== null) {
        const updated = await tx(
          'UPDATE network_members SET status = $3, candidate_public_key_hex = $4 WHERE network_id = $1 AND node_id = $2 RETURNING *',
          [input.networkId, input.nodeId, 'mismatch', input.publicKeyHex],
        );
        return mapMemberRow(updated.rows[0] as Row);
      }
      if (decision === 'authorize' || decision === 'pending') {
        // 决策值 authorize 落库为状态值 authorized
        const nextStatus: MemberStatus = decision === 'authorize' ? 'authorized' : 'pending';
        if (existingRow !== null) {
          // revoked 复活：换上来的公钥生效、清候选
          const updated = await tx(
            'UPDATE network_members SET status = $3, public_key_hex = $4, candidate_public_key_hex = NULL WHERE network_id = $1 AND node_id = $2 RETURNING *',
            [input.networkId, input.nodeId, nextStatus, input.publicKeyHex],
          );
          return mapMemberRow(updated.rows[0] as Row);
        }
        const inserted = await tx(
          'INSERT INTO network_members (network_id, node_id, name, note, status, public_key_hex, candidate_public_key_hex, nat_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8) RETURNING *',
          [input.networkId, input.nodeId, input.name ?? null, input.note ?? null, nextStatus, input.publicKeyHex, 'unknown', new Date()],
        );
        return mapMemberRow(inserted.rows[0] as Row);
      }
      // 其余情形（mismatch/keep 但行缺失）视为数据损坏
      throw new StoreError('member-not-found', 'member row disappeared during join attempt');
    });
  }

  async transitionMemberStatus(networkId: string, nodeId: string, action: TransitionAction, maxPeersCap?: number): Promise<MemberRecord> {
    return this.inTransaction(async (tx) => {
      // 锁网络行：同网络的容量裁决（approve）与状态迁移串行化
      const network = await tx('SELECT id, max_peers FROM networks WHERE id = $1 FOR UPDATE', [networkId]);
      if (network.rows.length === 0) {
        throw new StoreError('network-not-found', `network ${networkId} does not exist`);
      }
      const maxPeers = toNum((network.rows[0] as Row).max_peers);

      const found = await tx('SELECT * FROM network_members WHERE network_id = $1 AND node_id = $2', [networkId, nodeId]);
      if (found.rows.length === 0) {
        throw new StoreError('member-not-found', `member ${nodeId} does not exist in network ${networkId}`);
      }
      const row = found.rows[0] as Row;
      const status = decodeMemberStatus(str(row.status));
      const outcome = decideTransition(status, action);
      if (outcome === 'invalid') {
        throw new StoreError('invalid-transition', `action ${action} not allowed from status ${status}`);
      }
      // F2 加固：repin 前要求候选公钥存在；缺失（数据损坏）绝不把 "null" 写进 public_key_hex
      const candidateHex =
        typeof row.candidate_public_key_hex === 'string' && row.candidate_public_key_hex.length > 0
          ? row.candidate_public_key_hex
          : null;
      if (outcome.requiresCandidate === true && candidateHex === null) {
        throw new StoreError('invalid-transition', `repin requires a stored candidate public key (member ${nodeId})`);
      }
      if (outcome.needsCapacityCheck === true) {
        // GC-fix-batch1 R1：maxPeersCap 压低有效上限（与网络容量取小），approve 的
        // 空位判定在同一事务内对照压低后的上限；SQL 查询次数与顺序不变
        const effectiveMax = maxPeersCap !== undefined ? Math.min(maxPeers, maxPeersCap) : maxPeers;
        // PC-10 统一口径：mismatch 也占席，approve 的空位判定必须把 mismatch 计入
        const counted = await tx(
          `SELECT COUNT(*) AS count FROM network_members WHERE network_id = $1 AND status IN (${OCCUPYING_SQL})`,
          [networkId],
        );
        const used = toNum((counted.rows[0] as Row | undefined)?.count);
        if (used >= effectiveMax) {
          throw new StoreError('limit-reached', `network ${networkId} is at max peers (${effectiveMax})`);
        }
      }
      const nextPublicKey = outcome.promoteCandidate === true ? (candidateHex as string) : str(row.public_key_hex);
      const updated = await tx(
        'UPDATE network_members SET status = $3, public_key_hex = $4, candidate_public_key_hex = $5 WHERE network_id = $1 AND node_id = $2 RETURNING *',
        [networkId, nodeId, outcome.next, nextPublicKey, null],
      );
      return mapMemberRow(updated.rows[0] as Row);
    });
  }

  async updateMemberProfile(networkId: string, nodeId: string, patch: MemberProfilePatch): Promise<MemberRecord> {
    return this.inTransaction(async (tx) => {
      const found = await tx('SELECT * FROM network_members WHERE network_id = $1 AND node_id = $2', [networkId, nodeId]);
      if (found.rows.length === 0) {
        throw new StoreError('member-not-found', `member ${nodeId} does not exist in network ${networkId}`);
      }
      const row = found.rows[0] as Row;
      const nextName = 'name' in patch ? (patch.name ?? null) : (typeof row.name === 'string' ? row.name : null);
      const nextNote = 'note' in patch ? (patch.note ?? null) : (typeof row.note === 'string' ? row.note : null);
      const updated = await tx(
        'UPDATE network_members SET name = $3, note = $4 WHERE network_id = $1 AND node_id = $2 RETURNING *',
        [networkId, nodeId, nextName, nextNote],
      );
      return mapMemberRow(updated.rows[0] as Row);
    });
  }

  async removeMember(networkId: string, nodeId: string): Promise<void> {
    await this.query('DELETE FROM network_members WHERE network_id = $1 AND node_id = $2', [networkId, nodeId]);
  }

  async listMembers(networkId: string): Promise<MemberRecord[]> {
    const { rows } = await this.query('SELECT * FROM network_members WHERE network_id = $1 ORDER BY created_at, node_id', [
      networkId,
    ]);
    return rows.map((row) => mapMemberRow(row as Row));
  }

  /**
   * PC-19：整批在同一事务里全成/全败——中途普通 SQL 失败（如约束违反）回滚
   * 已执行的前序语句，调用方重试整批不会重复计数。PC-06 连接纪律：事务内
   * 一律用事务连接 tx，不借外层池连接。SQLite 侧同一 SQL 语义（见 sqlite-store
   * 的 this.tx()），两后端同批原子。
   * GC-2：正向字节增量在同一事务内对 monthly_relay_usage 按网络属主原子累计。
   */
  async flushMemberTelemetry(updates: TelemetryUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    await this.inTransaction(async (tx) => {
      // 同批内按 networkId 缓存属主查询，避免重复 SELECT
      const ownerCache = new Map<string, string | null>();
      for (const update of updates) {
        await tx(
          `UPDATE network_members SET
             cumulative_relay_bytes = cumulative_relay_bytes + $1,
             last_ip = COALESCE($2, last_ip),
             nat_type = COALESCE($3, nat_type),
             last_seen_at = COALESCE($4, last_seen_at)
           WHERE network_id = $5 AND node_id = $6`,
          [
            update.relayBytesDelta ?? 0,
            update.lastIp ?? null,
            update.natType ?? null,
            update.lastSeenAt ?? null,
            update.networkId,
            update.nodeId,
          ],
        );
        // 月度流量只对正向字节做原子累计（与成员更新同批事务，全成/全败）
        const delta = update.relayBytesDelta ?? 0;
        if (delta <= 0) continue;
        let ownerId = ownerCache.get(update.networkId);
        if (ownerId === undefined) {
          const owner = await tx('SELECT owner_id FROM networks WHERE id = $1', [update.networkId]);
          ownerId = owner.rows.length > 0 ? str((owner.rows[0] as Row).owner_id) : null;
          ownerCache.set(update.networkId, ownerId);
        }
        if (ownerId === null) continue; // 网络行缺失：与成员 UPDATE 一样静默跳过
        const yearMonth = (update.lastSeenAt ?? new Date().toISOString()).slice(0, 7);
        await tx(
          'INSERT INTO monthly_relay_usage (user_id, year_month, relay_bytes) VALUES ($1, $2, $3) ON CONFLICT(user_id, year_month) DO UPDATE SET relay_bytes = monthly_relay_usage.relay_bytes + EXCLUDED.relay_bytes',
          [ownerId, yearMonth, delta],
        );
      }
    });
  }

  async close(): Promise<void> {
    if (this.options.onClose !== undefined) {
      await this.options.onClose();
    }
  }
}
