// PostgreSQL 实现的 GatewayStore：SQL 语义与 sqlite-store 同一套（同决策纯函数、同状态迁移表）。
// 查询经注入的 query(sql, params) 执行，单测可以注入 mock；运行时用 PgStore.connect()
// 动态 import('pg') 建立连接池（ZR_GATEWAY_DATABASE_URL）。
import { createHash, randomBytes } from 'node:crypto';

import { generatePassword, hashPassword } from '../master-key.js';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  SEAT_OCCUPYING_STATUSES,
  StoreError,
  decodeMemberStatus,
  encodeSettingsValue,
  parseSettingsRows,
  decideJoinAttempt,
  decideTransition,
} from './types.js';
import type {
  AdmissionMode,
  BootstrapAdminInput,
  BootstrapAdminResult,
  CreateNetworkInput,
  CreateUserInput,
  GatewayStore,
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
  UserRecord,
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
    createdAt: toIso(row.created_at),
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
  static async connect(databaseUrl: string, seed?: SystemSettings): Promise<PgStore> {
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
      if (seed !== undefined) {
        await store.seedSettings(seed);
      }
    } catch (error) {
      // 初始化失败时归还本函数创建的 pool：store 尚未交付给调用方，没人能替它 close。
      // 归还失败（连接已坏等）吞掉、原样抛出原始错误，不得用关闭错误覆盖初始化错误。
      await pool.end().catch(() => {});
      throw error;
    }
    return store;
  }

  /** 幂等建表（CREATE IF NOT EXISTS），每次 connect 执行 */
  async initSchema(): Promise<void> {
    for (const ddl of PG_SCHEMA_STATEMENTS) {
      await this.query(ddl, []);
    }
  }

  /** 缺键逐键播种（ON CONFLICT DO NOTHING），已有键不被 seed 覆盖；多语句在同一事务连接上执行 */
  private async seedSettings(seed: SystemSettings): Promise<void> {
    await this.inTransaction(async (tx) => {
      const insert = 'INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING';
      for (const key of Object.keys(SETTINGS_KEYS) as Array<keyof SystemSettings>) {
        await tx(insert, [SETTINGS_KEYS[key], encodeSettingsValue(seed[key])]);
      }
    });
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

  async updateSettings(patch: SettingsPatch): Promise<SystemSettings> {
    const upsert =
      'INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value';
    for (const key of Object.keys(SETTINGS_KEYS) as Array<keyof SystemSettings>) {
      const value = patch[key];
      if (value !== undefined) {
        await this.query(upsert, [SETTINGS_KEYS[key], encodeSettingsValue(value)]);
      }
    }
    return this.getSettings();
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
    // 单条 INSERT 原子；并发撞 email 唯一约束（23505）统一转 StoreError
    try {
      const id = randomBytes(12).toString('hex');
      const inserted = await this.query(
        'INSERT INTO users (id, email, password_hash, role, active, created_at) VALUES ($1, $2, $3, $4, TRUE, $5) RETURNING *',
        [id, input.email, input.passwordHash, input.role, new Date()],
      );
      return mapUserRow(inserted.rows[0] as Row);
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

  async setUserActive(userId: string, active: boolean): Promise<void> {
    await this.inTransaction(async (tx) => {
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
      'SELECT s.token_hash, s.expires_at, u.id, u.email, u.password_hash, u.role, u.active, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1',
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

  // ---------------------------------------------------------------- networks

  async createNetwork(input: CreateNetworkInput): Promise<NetworkRecord> {
    return this.inTransaction(async (tx) => {
      // 锁 owner 行：同一租户的并发建网在事务上串行化，配额不会被并发穿透
      const owner = await tx('SELECT role FROM users WHERE id = $1 FOR UPDATE', [input.ownerId]);
      if (owner.rows.length === 0) {
        throw new StoreError('user-not-found', `owner ${input.ownerId} does not exist`);
      }
      if (str((owner.rows[0] as Row).role) !== 'admin') {
        // 单语句原子配额：COUNT 与限额同语句求值，超限行 over = true
        // （PC-06：settings 读取复用当前事务连接——这里已持 owner 行锁，再从外层池借
        // 第二条连接会让同 owner 的并发请求在池耗尽后互相等待）
        const settings = await this.querySettingsOn(tx);
        const counted = await tx(
          'SELECT COUNT(*) AS count, COUNT(*) >= $2 AS over FROM networks WHERE owner_id = $1',
          [input.ownerId, settings.maxNetworksPerUser],
        );
        const countRow = (counted.rows[0] ?? {}) as Row;
        const over = countRow.over === true || toNum(countRow.count) >= settings.maxNetworksPerUser;
        if (over) {
          throw new StoreError('quota-exceeded', `network quota exhausted (limit ${settings.maxNetworksPerUser})`);
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

      const decision = decideJoinAttempt({
        admissionMode: str(networkRow.admission_mode) as AdmissionMode,
        maxPeers: toNum(networkRow.max_peers),
        existing: decisionExisting,
        incomingPublicKeyHex: input.publicKeyHex,
        joinKeyMatched: input.joinKeyMatched,
        capacityUsed,
      });

      if (decision === 'reject') return null;
      if (decision === 'limit-reached') {
        // F3：口令匹配但席位满，明确抛错，让上层能把「网络已满」与「口令错误」区分开
        throw new StoreError('limit-reached', `network ${input.networkId} is at max peers (${toNum(networkRow.max_peers)})`);
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

  async transitionMemberStatus(networkId: string, nodeId: string, action: TransitionAction): Promise<MemberRecord> {
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
        // PC-10 统一口径：mismatch 也占席，approve 的空位判定必须把 mismatch 计入
        const counted = await tx(
          `SELECT COUNT(*) AS count FROM network_members WHERE network_id = $1 AND status IN (${OCCUPYING_SQL})`,
          [networkId],
        );
        const used = toNum((counted.rows[0] as Row | undefined)?.count);
        if (used >= maxPeers) {
          throw new StoreError('limit-reached', `network ${networkId} is at max peers (${maxPeers})`);
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
   */
  async flushMemberTelemetry(updates: TelemetryUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    await this.inTransaction(async (tx) => {
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
      }
    });
  }

  async close(): Promise<void> {
    if (this.options.onClose !== undefined) {
      await this.options.onClose();
    }
  }
}
