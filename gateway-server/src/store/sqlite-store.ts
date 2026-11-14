// SQLite 实现的 GatewayStore：node:sqlite DatabaseSync（同步 API），方法签名仍返回 Promise
// 以符合窄接口。WAL + 外键约束在打开时显式开启。
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  active INTEGER NOT NULL DEFAULT 1,
  group_id TEXT NOT NULL DEFAULT 'grp_default',
  group_expires_at TEXT,
  email_verified_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS user_groups (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  max_networks INTEGER NOT NULL,
  max_peers_per_network INTEGER NOT NULL,
  relay_rate_kbps INTEGER NOT NULL,
  monthly_relay_quota_bytes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monthly_relay_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year_month TEXT NOT NULL,
  relay_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, year_month)
);
CREATE TABLE IF NOT EXISTS email_otps (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  cooldown_until TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_otps_lookup ON email_otps(email, purpose, created_at);
CREATE TABLE IF NOT EXISTS networks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  admission_mode TEXT NOT NULL CHECK (admission_mode IN ('key','manual','both')),
  join_key_enc TEXT NOT NULL,
  max_peers INTEGER NOT NULL CHECK (max_peers BETWEEN 1 AND 64),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_networks_owner_id ON networks(owner_id);
CREATE TABLE IF NOT EXISTS network_members (
  network_id TEXT NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  name TEXT,
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','authorized','paused','mismatch','revoked')),
  public_key_hex TEXT NOT NULL,
  candidate_public_key_hex TEXT,
  last_ip TEXT,
  nat_type TEXT NOT NULL DEFAULT 'unknown' CHECK (nat_type IN ('cone','symmetric','public','unknown')),
  cumulative_relay_bytes INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, node_id)
);
`;

export interface SqliteStoreOptions {
  /** 数据库文件路径（或 ':memory:'）；缺省 ':memory:' */
  path?: string;
  /** 空库首次播种/缺键补齐的系统设置（传 resolveGatewayConfig 派生值）；已有键不会被覆盖 */
  seed?: Partial<ExtendedSystemSettings>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 占席状态 IN 列表（PC-10 统一口径，来源 SEAT_OCCUPYING_STATUSES；编译期常量，无注入面） */
const OCCUPYING_SQL = SEAT_OCCUPYING_STATUSES.map((status) => `'${status}'`).join(',');

function randomId16(): string {
  return randomBytes(8).toString('hex');
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

type Row = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function toNum(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof value === 'bigint') return Number(value);
  return 0;
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
    active: row.active === 1 || row.active === true,
    groupId: optText(row.group_id) ?? DEFAULT_GROUP_ID,
    groupExpiresAt: optText(row.group_expires_at),
    emailVerifiedAt: optText(row.email_verified_at),
    createdAt: str(row.created_at),
  };
}

function mapGroupRow(row: Row): UserGroupRecord {
  const quota = row.monthly_relay_quota_bytes;
  return {
    id: str(row.id),
    code: str(row.code),
    name: str(row.name),
    description: typeof row.description === 'string' ? row.description : '',
    isDefault: row.is_default === 1 || row.is_default === true,
    maxNetworks: toNum(row.max_networks),
    maxPeersPerNetwork: toNum(row.max_peers_per_network),
    relayRateKbps: toNum(row.relay_rate_kbps),
    monthlyRelayQuotaBytes: quota === null || quota === undefined ? null : toNum(quota),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
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
    createdAt: str(row.created_at),
  };
}

function mapMemberRow(row: Row): MemberRecord {
  const candidate = row.candidate_public_key_hex;
  return {
    networkId: str(row.network_id),
    nodeId: str(row.node_id),
    name: typeof row.name === 'string' ? row.name : null,
    note: typeof row.note === 'string' ? row.note : null,
    status: decodeMemberStatus(str(row.status)),
    publicKeyHex: str(row.public_key_hex),
    candidatePublicKeyHex: typeof candidate === 'string' && candidate.length > 0 ? candidate : null,
    lastIp: typeof row.last_ip === 'string' ? row.last_ip : null,
    natType: str(row.nat_type) as NatType,
    cumulativeRelayBytes: toNum(row.cumulative_relay_bytes),
    lastSeenAt: typeof row.last_seen_at === 'string' ? row.last_seen_at : null,
    createdAt: str(row.created_at),
  };
}

export class SqliteStore implements GatewayStore {
  private readonly db: DatabaseSync;

  constructor(options: SqliteStoreOptions = {}) {
    const dbPath = options.path ?? ':memory:';
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SQLITE_SCHEMA);
    this.migrateUserColumns();
    // 无 seed 的重开也做缺键补齐 + 默认组兜底（INSERT OR IGNORE 不会覆盖已有值）
    this.seedSettings(options.seed ?? {});
  }

  /** 旧库平滑迁移：users 缺哪个新列就补哪个（SQLite 无 ADD COLUMN IF NOT EXISTS） */
  private migrateUserColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(users)').all() as Array<Row>;
    const present = new Set(columns.map((column) => str(column.name)));
    // DEFAULT_GROUP_ID 是编译期常量（同 OCCUPYING_SQL 模式），无注入面
    if (!present.has('group_id')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN group_id TEXT NOT NULL DEFAULT '${DEFAULT_GROUP_ID}'`);
    }
    if (!present.has('group_expires_at')) {
      this.db.exec('ALTER TABLE users ADD COLUMN group_expires_at TEXT');
    }
    if (!present.has('email_verified_at')) {
      this.db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
    }
  }

  /**
   * 缺键逐键播种（INSERT OR IGNORE），已有键不被 seed 覆盖；记录本次真正新插入的配额键，
   * 随后幂等确保默认组存在（PC-07：缺键补齐的配额同步写进活跃默认组，防止两处漂移）。
   */
  private seedSettings(seed: Partial<ExtendedSystemSettings>): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)');
    const filledQuotaKeys = new Set<keyof SystemSettings>();
    for (const key of Object.keys(SETTINGS_KEYS) as Array<keyof ExtendedSystemSettings>) {
      const value = seed[key] ?? DEFAULT_EXTENDED_SETTINGS[key];
      const result = insert.run(SETTINGS_KEYS[key], encodeSettingsValue(value));
      if (Number(result.changes) > 0 && (QUOTA_SETTINGS_KEYS as ReadonlyArray<string>).includes(key)) {
        filledQuotaKeys.add(key as keyof SystemSettings); // includes 已收窄到三项配额键
      }
    }
    this.ensureDefaultGroupSync(filledQuotaKeys);
  }

  /**
   * 幂等确保存在一个活跃默认组（is_default = 1）：先查现有默认组；仅当库里没有任何
   * 默认组时才插入 grp_default（行在但失活则恢复其默认标记）——绝不凭空复活第二个默认组。
   * seedSettings 本次真正新插入的配额键同步写进当前活跃默认组（PC-07 防漂移）。
   */
  private ensureDefaultGroupSync(filledQuotaKeys: ReadonlySet<keyof SystemSettings>): void {
    const now = nowIso();
    let active = this.db.prepare('SELECT id FROM user_groups WHERE is_default = 1 LIMIT 1').get() as Row | undefined;
    if (active === undefined) {
      const settings = this.getSettingsSync();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO user_groups
             (id, code, name, description, is_default, max_networks, max_peers_per_network, relay_rate_kbps, monthly_relay_quota_bytes, created_at, updated_at)
           VALUES (?, ?, ?, '', 1, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(DEFAULT_GROUP_ID, DEFAULT_GROUP_CODE, DEFAULT_GROUP_NAME, settings.maxNetworksPerUser, settings.defaultMaxPeers, settings.relayRateKbps, now, now);
      this.db
        .prepare('UPDATE user_groups SET is_default = 1, updated_at = ? WHERE id = ? AND is_default = 0')
        .run(now, DEFAULT_GROUP_ID);
      active = this.db.prepare('SELECT id FROM user_groups WHERE is_default = 1 LIMIT 1').get() as Row | undefined;
    }
    if (active !== undefined && filledQuotaKeys.size > 0) {
      this.syncQuotaColumnsSync(str(active.id), filledQuotaKeys, now);
    }
  }

  /** 把指定配额键的 system_settings 当前值同步写进指定组行（只动列出的键，其余列不动） */
  private syncQuotaColumnsSync(groupId: string, keys: ReadonlySet<keyof SystemSettings>, now: string): void {
    const settings = this.getSettingsSync();
    if (keys.has('maxNetworksPerUser')) {
      this.db.prepare('UPDATE user_groups SET max_networks = ?, updated_at = ? WHERE id = ?').run(settings.maxNetworksPerUser, now, groupId);
    }
    if (keys.has('defaultMaxPeers')) {
      this.db.prepare('UPDATE user_groups SET max_peers_per_network = ?, updated_at = ? WHERE id = ?').run(settings.defaultMaxPeers, now, groupId);
    }
    if (keys.has('relayRateKbps')) {
      this.db.prepare('UPDATE user_groups SET relay_rate_kbps = ?, updated_at = ? WHERE id = ?').run(settings.relayRateKbps, now, groupId);
    }
  }

  /** 默认组的三项配额写回 system_settings（用户组侧 → 设置侧的同步方向） */
  private writeDefaultQuotasToSettings(group: { maxNetworks: number; maxPeersPerNetwork: number; relayRateKbps: number }): void {
    const upsert = this.db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)');
    upsert.run(SETTINGS_KEYS.maxNetworksPerUser, encodeSettingsValue(group.maxNetworks));
    upsert.run(SETTINGS_KEYS.defaultMaxPeers, encodeSettingsValue(group.maxPeersPerNetwork));
    upsert.run(SETTINGS_KEYS.relayRateKbps, encodeSettingsValue(group.relayRateKbps));
  }

  /** 同步事务包装：SQLite 驱动是同步的，BEGIN/COMMIT 不会交错 */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private getSettingsSync(): SystemSettings {
    const rows = this.db.prepare('SELECT key, value FROM system_settings').all() as Array<Row>;
    return parseSettingsRows(rows);
  }

  private getUserRowBy(column: 'id' | 'email', value: string): Row | undefined {
    return this.db.prepare(`SELECT * FROM users WHERE ${column} = ?`).get(value) as Row | undefined;
  }

  private getUserById(id: string): UserRecord | null {
    const row = this.getUserRowBy('id', id);
    return row === undefined ? null : mapUserRow(row);
  }

  private getGroupRowById(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM user_groups WHERE id = ?').get(id) as Row | undefined;
  }

  private getNetworkRow(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM networks WHERE id = ?').get(id) as Row | undefined;
  }

  private getMemberRow(networkId: string, nodeId: string): Row | undefined {
    return this.db
      .prepare('SELECT * FROM network_members WHERE network_id = ? AND node_id = ?')
      .get(networkId, nodeId) as Row | undefined;
  }

  /**
   * 唯一活跃管理员保护：目标是当前活跃 admin、且本次操作会移除其 admin/active 身份
   * （停用 / 降为 user）时，活跃 admin 必须多于 1，否则抛 last-admin。
   */
  private assertNotLastActiveAdmin(row: Row, nextActive: boolean, nextRole?: UserRole): void {
    const isCurrentlyActiveAdmin = str(row.role) === 'admin' && (row.active === 1 || row.active === true);
    const losesAdminStanding = (nextRole !== undefined && nextRole !== 'admin') || !nextActive;
    if (!isCurrentlyActiveAdmin || !losesAdminStanding) return;
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1")
      .get() as Row;
    if (toNum(countRow.n) <= 1) {
      throw new StoreError('last-admin', 'cannot demote or disable the only active admin');
    }
  }

  /**
   * 有效组解析（SQLite 同步版）：配额到期或登记组行缺失时回退默认组。回退跟随当前
   * 活跃默认组（is_default = 1，可能与 grp_default 不同）；连活跃默认组都没有
   * （损坏库）时才按 grp_default id 兜底，最后按当前 system_settings 合成兜底记录。
   */
  private resolveEffectiveGroupSync(
    assignedGroupId: string,
    groupExpiresAt: string | null,
    nowMs: number,
  ): { group: UserGroupRecord; isExpiredFallback: boolean } {
    const expiresMs = groupExpiresAt !== null ? Date.parse(groupExpiresAt) : Number.NaN;
    const isExpiredFallback = Number.isFinite(expiresMs) && expiresMs <= nowMs;
    let row: Row | undefined;
    if (!isExpiredFallback) {
      row = this.getGroupRowById(assignedGroupId);
    }
    if (row === undefined) {
      row = this.db.prepare('SELECT * FROM user_groups WHERE is_default = 1 LIMIT 1').get() as Row | undefined;
    }
    if (row === undefined) {
      row = this.getGroupRowById(DEFAULT_GROUP_ID);
    }
    return {
      group: row !== undefined ? mapGroupRow(row) : this.syntheticDefaultGroup(),
      isExpiredFallback,
    };
  }

  /** 默认组行缺失（损坏库）时的兜底：按当前 system_settings 合成 grp_default 记录 */
  private syntheticDefaultGroup(): UserGroupRecord {
    const settings = this.getSettingsSync();
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

  // ---------------------------------------------------------------- settings

  async getSettings(): Promise<SystemSettings> {
    return this.getSettingsSync();
  }

  async getExtendedSettings(): Promise<ExtendedSystemSettings> {
    const rows = this.db.prepare('SELECT key, value FROM system_settings').all() as Array<Row>;
    return parseExtendedSettingsRows(rows);
  }

  /**
   * 写补丁的共用实现（updateSettings / updateExtendedSettings 只差键集）：事务内
   * 逐键 upsert，改三项配额任一项即同事务写回当前活跃默认组对应列（双向同步）。
   */
  private applySettingsPatchSync(patch: ExtendedSettingsPatch, keys: ReadonlyArray<keyof ExtendedSystemSettings>): void {
    const update = this.db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)');
    this.tx(() => {
      const current = this.getSettingsSync();
      const quotaTouched = QUOTA_SETTINGS_KEYS.some((key) => patch[key] !== undefined);
      for (const key of keys) {
        const value = patch[key];
        if (value !== undefined) {
          update.run(SETTINGS_KEYS[key], encodeSettingsValue(value));
        }
      }
      if (quotaTouched) {
        this.db
          .prepare('UPDATE user_groups SET max_networks = ?, max_peers_per_network = ?, relay_rate_kbps = ?, updated_at = ? WHERE is_default = 1')
          .run(
            patch.maxNetworksPerUser ?? current.maxNetworksPerUser,
            patch.defaultMaxPeers ?? current.defaultMaxPeers,
            patch.relayRateKbps ?? current.relayRateKbps,
            nowIso(),
          );
      }
    });
  }

  async updateSettings(patch: SettingsPatch): Promise<SystemSettings> {
    this.applySettingsPatchSync(patch, Object.keys(BASE_SETTINGS_KEYS) as Array<keyof SystemSettings>);
    return this.getSettingsSync();
  }

  async updateExtendedSettings(patch: ExtendedSettingsPatch): Promise<ExtendedSystemSettings> {
    this.applySettingsPatchSync(patch, Object.keys(SETTINGS_KEYS) as Array<keyof ExtendedSystemSettings>);
    return this.getExtendedSettings();
  }

  // ---------------------------------------------------------------- users & sessions

  async ensureBootstrapAdmin(input: BootstrapAdminInput): Promise<BootstrapAdminResult> {
    const existing = this.db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get() as Row | undefined;
    if (existing !== undefined) {
      return { created: false, email: input.email };
    }
    const generatedPassword = input.password === undefined ? generatePassword() : undefined;
    const passwordHash = await hashPassword(input.password ?? (generatedPassword as string));
    const id = randomBytes(12).toString('hex');
    this.db
      .prepare('INSERT INTO users (id, email, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(id, input.email, passwordHash, 'admin', nowIso());
    if (generatedPassword === undefined) {
      return { created: true, email: input.email };
    }
    return { created: true, email: input.email, generatedPassword };
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    if (this.getUserRowBy('email', input.email) !== undefined) {
      throw new StoreError('duplicate-email', `user with email ${input.email} already exists`);
    }
    if (input.groupId !== undefined && this.getGroupRowById(input.groupId) === undefined) {
      throw new StoreError('group-not-found', `user group ${input.groupId} does not exist`);
    }
    const id = randomBytes(12).toString('hex');
    // 未显式指定组时，COALESCE 子查询在同一条 INSERT 内原子写入当前活跃默认组
    // （可能与 grp_default 不同），无任何默认组时兜底 grp_default
    this.db
      .prepare(
        `INSERT INTO users (id, email, password_hash, role, active, group_id, group_expires_at, email_verified_at, created_at)
         VALUES (?, ?, ?, ?, 1, COALESCE(?, (SELECT id FROM user_groups WHERE is_default = 1 LIMIT 1), '${DEFAULT_GROUP_ID}'), ?, ?, ?)`,
      )
      .run(id, input.email, input.passwordHash, input.role, input.groupId ?? null, input.groupExpiresAt ?? null, input.emailVerifiedAt ?? null, nowIso());
    const created = this.getUserById(id);
    if (created === null) throw new StoreError('user-not-found', 'created user disappeared');
    return created;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const row = this.getUserRowBy('email', email);
    return row === undefined ? null : mapUserRow(row);
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    return this.getUserById(id);
  }

  async listUsers(): Promise<UserRecord[]> {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY created_at, id').all() as Row[];
    return rows.map(mapUserRow);
  }

  async setUserActive(userId: string, active: boolean): Promise<void> {
    this.tx(() => {
      const row = this.getUserRowBy('id', userId);
      if (row === undefined) {
        throw new StoreError('user-not-found', `user ${userId} does not exist`);
      }
      this.assertNotLastActiveAdmin(row, active);
      const result = this.db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, userId);
      if (Number(result.changes) === 0) {
        throw new StoreError('user-not-found', `user ${userId} does not exist`);
      }
      // 禁用即吊销全部登录会话
      if (!active) {
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      }
    });
  }

  async updateUserByAdmin(userId: string, patch: AdminUserPatch): Promise<UserRecord> {
    return this.tx(() => {
      const row = this.getUserRowBy('id', userId);
      if (row === undefined) {
        throw new StoreError('user-not-found', `user ${userId} does not exist`);
      }
      const nextActive = patch.active ?? (row.active === 1 || row.active === true);
      const nextRole: UserRole = patch.role ?? (str(row.role) === 'admin' ? 'admin' : 'user');
      this.assertNotLastActiveAdmin(row, nextActive, nextRole);
      if (patch.groupId !== undefined && this.getGroupRowById(patch.groupId) === undefined) {
        throw new StoreError('group-not-found', `user group ${patch.groupId} does not exist`);
      }
      const nextGroupId = patch.groupId ?? (optText(row.group_id) ?? DEFAULT_GROUP_ID);
      const nextGroupExpiresAt = patch.groupExpiresAt !== undefined ? patch.groupExpiresAt : optText(row.group_expires_at);
      const nextEmailVerifiedAt = patch.emailVerifiedAt !== undefined ? patch.emailVerifiedAt : optText(row.email_verified_at);
      this.db
        .prepare('UPDATE users SET role = ?, active = ?, group_id = ?, group_expires_at = ?, email_verified_at = ? WHERE id = ?')
        .run(nextRole, nextActive ? 1 : 0, nextGroupId, nextGroupExpiresAt, nextEmailVerifiedAt, userId);
      // 停用即吊销全部登录会话（与 setUserActive 同语义）
      if (!nextActive) {
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      }
      const updated = this.getUserById(userId);
      if (updated === null) throw new StoreError('user-not-found', 'user disappeared after admin update');
      return updated;
    });
  }

  async deleteUser(userId: string): Promise<void> {
    this.tx(() => {
      const row = this.getUserRowBy('id', userId);
      if (row === undefined) {
        throw new StoreError('user-not-found', `user ${userId} does not exist`);
      }
      this.assertNotLastActiveAdmin(row, false);
      // sessions / networks / network_members / monthly_relay_usage 随外键级联清除
      this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    });
  }

  async updateUserPassword(userId: string, passwordHash: string, keepTokenHash?: string): Promise<void> {
    this.tx(() => {
      const row = this.getUserRowBy('id', userId);
      if (row === undefined) {
        throw new StoreError('user-not-found', `user ${userId} does not exist`);
      }
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
      // keepTokenHash 对应会话保留（当前设备不掉线），其余全部吊销
      if (keepTokenHash === undefined) {
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      } else {
        this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, keepTokenHash);
      }
    });
  }

  async updateUserEmail(userId: string, email: string, emailVerifiedAt: string | null): Promise<UserRecord> {
    return this.tx(() => {
      const row = this.getUserRowBy('id', userId);
      if (row === undefined) {
        throw new StoreError('user-not-found', `user ${userId} does not exist`);
      }
      const existing = this.getUserRowBy('email', email);
      if (existing !== undefined && str(existing.id) !== userId) {
        throw new StoreError('duplicate-email', `user with email ${email} already exists`);
      }
      this.db.prepare('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?').run(email, emailVerifiedAt, userId);
      const updated = this.getUserById(userId);
      if (updated === null) throw new StoreError('user-not-found', 'user disappeared after email update');
      return updated;
    });
  }

  async deleteAllUserSessions(userId: string, exceptTokenHash?: string): Promise<number> {
    return this.tx(() => {
      const row = this.getUserRowBy('id', userId);
      if (row === undefined) {
        throw new StoreError('user-not-found', `user ${userId} does not exist`);
      }
      const result =
        exceptTokenHash === undefined
          ? this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
          : this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, exceptTokenHash);
      return Number(result.changes);
    });
  }

  async createSession(userId: string, ttlMs: number): Promise<SessionIssued> {
    const token = randomBytes(32).toString('hex');
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, userId, expiresAt, nowIso());
    return { token, tokenHash, expiresAt };
  }

  async getSessionUser(tokenHash: string, now: number): Promise<UserRecord | null> {
    const row = this.db
      .prepare(
        'SELECT s.expires_at AS expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
      )
      .get(tokenHash) as Row | undefined;
    if (row === undefined) return null;
    if (Date.parse(str(row.expires_at)) <= now) return null;
    if (!(row.active === 1 || row.active === true)) return null;
    return mapUserRow(row);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  async pruneExpiredSessions(now: number): Promise<number> {
    const result = this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date(now).toISOString());
    return Number(result.changes);
  }

  // ---------------------------------------------------------------- user groups

  async listUserGroups(): Promise<UserGroupRecord[]> {
    const rows = this.db.prepare('SELECT * FROM user_groups ORDER BY is_default DESC, code').all() as Row[];
    return rows.map(mapGroupRow);
  }

  async getUserGroup(id: string): Promise<UserGroupRecord | null> {
    const row = this.getGroupRowById(id);
    return row === undefined ? null : mapGroupRow(row);
  }

  async getUserGroupByCode(code: string): Promise<UserGroupRecord | null> {
    const row = this.db.prepare('SELECT * FROM user_groups WHERE code = ?').get(code) as Row | undefined;
    return row === undefined ? null : mapGroupRow(row);
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
    const now = nowIso();
    return this.tx(() => {
      if (this.db.prepare('SELECT id FROM user_groups WHERE code = ?').get(input.code) !== undefined) {
        throw new StoreError('duplicate-group-code', `user group code ${input.code} already exists`);
      }
      if (isDefault) {
        this.db.prepare('UPDATE user_groups SET is_default = 0 WHERE is_default = 1').run();
      }
      this.db
        .prepare(
          'INSERT INTO user_groups (id, code, name, description, is_default, max_networks, max_peers_per_network, relay_rate_kbps, monthly_relay_quota_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, input.code, input.name, description, isDefault ? 1 : 0, input.maxNetworks, input.maxPeersPerNetwork, input.relayRateKbps, monthlyRelayQuotaBytes, now, now);
      // 新默认组的三项配额写回 system_settings（同事务，双向同步）
      if (isDefault) {
        this.writeDefaultQuotasToSettings(input);
      }
      const row = this.getGroupRowById(id);
      if (row === undefined) throw new StoreError('group-not-found', 'created user group disappeared');
      return mapGroupRow(row);
    });
  }

  async updateUserGroup(id: string, patch: UpdateUserGroupPatch): Promise<UserGroupRecord> {
    return this.tx(() => {
      const existingRow = this.getGroupRowById(id);
      if (existingRow === undefined) {
        throw new StoreError('group-not-found', `user group ${id} does not exist`);
      }
      const existing = mapGroupRow(existingRow);
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
        this.db.prepare('UPDATE user_groups SET is_default = 0 WHERE id != ? AND is_default = 1').run(id);
      }
      this.db
        .prepare(
          'UPDATE user_groups SET name = ?, description = ?, is_default = ?, max_networks = ?, max_peers_per_network = ?, relay_rate_kbps = ?, monthly_relay_quota_bytes = ?, updated_at = ? WHERE id = ?',
        )
        .run(merged.name, merged.description, merged.isDefault ? 1 : 0, merged.maxNetworks, merged.maxPeersPerNetwork, merged.relayRateKbps, merged.monthlyRelayQuotaBytes, nowIso(), id);
      // 默认组三项配额同步写回 system_settings（含「修改当前默认组配额」的情形）
      if (merged.isDefault) {
        this.writeDefaultQuotasToSettings(merged);
      }
      const updatedRow = this.getGroupRowById(id);
      if (updatedRow === undefined) throw new StoreError('group-not-found', 'user group disappeared after update');
      return mapGroupRow(updatedRow);
    });
  }

  async deleteUserGroup(id: string): Promise<void> {
    this.tx(() => {
      const row = this.getGroupRowById(id);
      if (row === undefined) {
        throw new StoreError('group-not-found', `user group ${id} does not exist`);
      }
      if (row.is_default === 1 || row.is_default === true) {
        throw new StoreError('cannot-delete-default-group', 'the default user group cannot be deleted');
      }
      const countRow = this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE group_id = ?').get(id) as Row;
      if (toNum(countRow.n) > 0) {
        throw new StoreError('group-in-use', `user group ${id} still has users assigned`);
      }
      this.db.prepare('DELETE FROM user_groups WHERE id = ?').run(id);
    });
  }

  async resolveEffectiveUserQuota(userId: string, nowMs?: number): Promise<EffectiveUserQuota> {
    const at = nowMs ?? Date.now();
    const row = this.getUserRowBy('id', userId);
    if (row === undefined) {
      throw new StoreError('user-not-found', `user ${userId} does not exist`);
    }
    const user = mapUserRow(row);
    const { group, isExpiredFallback } = this.resolveEffectiveGroupSync(user.groupId, user.groupExpiresAt, at);
    const yearMonth = currentUtcYearMonth(at);
    const usageRow = this.db
      .prepare('SELECT relay_bytes FROM monthly_relay_usage WHERE user_id = ? AND year_month = ?')
      .get(userId, yearMonth) as Row | undefined;
    return {
      group,
      assignedGroupId: user.groupId,
      groupExpiresAt: user.groupExpiresAt,
      isExpiredFallback,
      yearMonth,
      monthlyRelayUsedBytes: usageRow === undefined ? 0 : toNum(usageRow.relay_bytes),
    };
  }

  async resolveNetworkEffectiveQuota(networkId: string, nowMs?: number): Promise<EffectiveUserQuota> {
    const row = this.getNetworkRow(networkId);
    if (row === undefined) {
      throw new StoreError('network-not-found', `network ${networkId} does not exist`);
    }
    return this.resolveEffectiveUserQuota(str(row.owner_id), nowMs);
  }

  async getMonthlyRelayUsage(userId: string, yearMonth: string): Promise<number> {
    const row = this.db
      .prepare('SELECT relay_bytes FROM monthly_relay_usage WHERE user_id = ? AND year_month = ?')
      .get(userId, yearMonth) as Row | undefined;
    return row === undefined ? 0 : toNum(row.relay_bytes);
  }

  // ---------------------------------------------------------------- email OTP

  /** (email, purpose) 最新一条活跃（未消费且未过期）验证码行 */
  private getActiveOtpRow(email: string, purpose: string, now: string): Row | undefined {
    return this.db
      .prepare(
        'SELECT * FROM email_otps WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(email, purpose, now) as Row | undefined;
  }

  async issueEmailOtp(input: IssueEmailOtpInput): Promise<EmailOtpIssued> {
    const email = input.email.trim().toLowerCase();
    const nowMs = input.nowMs ?? Date.now();
    const now = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + input.ttlMs).toISOString();
    const cooldownUntil = new Date(nowMs + input.cooldownMs).toISOString();
    return this.tx(() => {
      const active = this.getActiveOtpRow(email, input.purpose, now);
      if (active !== undefined) {
        const activeCooldown = Date.parse(str(active.cooldown_until));
        if (Number.isFinite(activeCooldown) && activeCooldown > nowMs) {
          throw new StoreError('otp-cooldown', `an otp for ${email} (${input.purpose}) was issued recently`);
        }
      }
      // 冷却已过：旧未消费行全部置为已消费，再插入新行
      this.db
        .prepare('UPDATE email_otps SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL')
        .run(now, email, input.purpose);
      const id = randomBytes(12).toString('hex');
      this.db
        .prepare(
          'INSERT INTO email_otps (id, email, purpose, code_hash, attempts, expires_at, cooldown_until, consumed_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?)',
        )
        .run(id, email, input.purpose, input.codeHash, expiresAt, cooldownUntil, now);
      return { id, email, purpose: input.purpose, expiresAt, cooldownUntil };
    });
  }

  async verifyAndConsumeEmailOtp(input: VerifyEmailOtpInput): Promise<void> {
    const email = input.email.trim().toLowerCase();
    const nowMs = input.nowMs ?? Date.now();
    const now = new Date(nowMs).toISOString();
    // 关键：决策在事务内落库（消费 / 计错次数），StoreError 必须在事务提交之后抛——
    // 事务回调里直接 throw 会回滚，attempts 永远加不上去，5 次锁定形同虚设。
    const outcome = this.tx(() => {
      const row = this.getActiveOtpRow(email, input.purpose, now);
      if (row === undefined) {
        return 'invalid' as const;
      }
      const decision = decideOtpVerify({ codeHash: str(row.code_hash), attempts: toNum(row.attempts) }, input.codeHash, input.maxAttempts);
      if (decision.action === 'consume') {
        this.db.prepare('UPDATE email_otps SET consumed_at = ? WHERE id = ?').run(now, str(row.id));
      } else if (decision.action === 'count-attempt') {
        this.db.prepare('UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?').run(str(row.id));
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
    const result = this.db.prepare('DELETE FROM email_otps WHERE expires_at <= ?').run(new Date(nowMs).toISOString());
    return Number(result.changes);
  }

  // ---------------------------------------------------------------- networks

  async createNetwork(input: CreateNetworkInput): Promise<NetworkRecord> {
    const id = randomId16();
    const now = Date.now();
    this.tx(() => {
      const owner = this.db
        .prepare('SELECT role, group_id, group_expires_at FROM users WHERE id = ?')
        .get(input.ownerId) as Row | undefined;
      if (owner === undefined) {
        throw new StoreError('user-not-found', `owner ${input.ownerId} does not exist`);
      }
      if (str(owner.role) !== 'admin') {
        // 原子配额：同一事务内解析有效组限额并计数比较（BEGIN IMMEDIATE 已串行化写者）。
        // 有效组 = 登记组（缺失/到期回退默认组）；组行全缺（损坏库）由 resolveEffectiveGroupSync
        // 兜底按 system_settings 合成，行为与旧版配额一致。
        const assignedGroupId = optText(owner.group_id) ?? DEFAULT_GROUP_ID;
        const groupExpiresAt = optText(owner.group_expires_at);
        const { group } = this.resolveEffectiveGroupSync(assignedGroupId, groupExpiresAt, now);
        const countRow = this.db
          .prepare('SELECT COUNT(*) AS n FROM networks WHERE owner_id = ?')
          .get(input.ownerId) as Row;
        if (toNum(countRow.n) >= group.maxNetworks) {
          throw new StoreError('quota-exceeded', `network quota exhausted (limit ${group.maxNetworks})`);
        }
      }
      this.db
        .prepare(
          'INSERT INTO networks (id, owner_id, name, admission_mode, join_key_enc, max_peers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, input.ownerId, input.name, input.admissionMode, input.joinKeyEnc, input.maxPeers, nowIso());
    });
    const row = this.getNetworkRow(id);
    if (row === undefined) throw new StoreError('network-not-found', 'created network disappeared');
    return mapNetworkRow(row);
  }

  async listNetworksByOwner(ownerId: string): Promise<NetworkRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM networks WHERE owner_id = ? ORDER BY created_at, id')
      .all(ownerId) as Row[];
    return rows.map(mapNetworkRow);
  }

  async listPublicNetworks(): Promise<Array<{ id: string; name: string; admissionMode: AdmissionMode }>> {
    const rows = this.db
      .prepare(
        'SELECT n.id, n.name, n.admission_mode FROM networks n JOIN users u ON u.id = n.owner_id WHERE u.active = 1 ORDER BY n.created_at, n.id',
      )
      .all() as Row[];
    return rows.map((row) => ({
      id: str(row.id),
      name: str(row.name),
      admissionMode: str(row.admission_mode) as AdmissionMode,
    }));
  }

  async getNetwork(id: string): Promise<NetworkRecord | null> {
    const row = this.getNetworkRow(id);
    return row === undefined ? null : mapNetworkRow(row);
  }

  async updateNetwork(id: string, patch: NetworkPatch): Promise<NetworkRecord | null> {
    const existing = this.getNetworkRow(id);
    if (existing === undefined) return null;
    const current = mapNetworkRow(existing);
    const next = {
      name: patch.name ?? current.name,
      admissionMode: patch.admissionMode ?? current.admissionMode,
      maxPeers: patch.maxPeers ?? current.maxPeers,
    };
    this.db
      .prepare('UPDATE networks SET name = ?, admission_mode = ?, max_peers = ? WHERE id = ?')
      .run(next.name, next.admissionMode, next.maxPeers, id);
    const updated = this.getNetworkRow(id);
    return updated === undefined ? null : mapNetworkRow(updated);
  }

  async rotateNetworkJoinKey(id: string, newJoinKeyEnc: string): Promise<void> {
    this.db.prepare('UPDATE networks SET join_key_enc = ? WHERE id = ?').run(newJoinKeyEnc, id);
  }

  async deleteNetwork(id: string): Promise<void> {
    // network_members 由 FK ON DELETE CASCADE 级联清除
    this.db.prepare('DELETE FROM networks WHERE id = ?').run(id);
  }

  // ---------------------------------------------------------------- members

  async upsertMemberJoinAttempt(input: JoinAttemptInput): Promise<MemberRecord | null> {
    return this.tx(() => {
      const network = this.db
        .prepare('SELECT admission_mode, max_peers FROM networks WHERE id = ?')
        .get(input.networkId) as Row | undefined;
      if (network === undefined) {
        throw new StoreError('network-not-found', `network ${input.networkId} does not exist`);
      }
      const existing = this.getMemberRow(input.networkId, input.nodeId);

      let capacityUsed = 0;
      let decisionExisting: { status: MemberStatus; publicKeyHex: string } | null = null;
      if (existing !== undefined) {
        decisionExisting = {
          status: decodeMemberStatus(str(existing.status)),
          publicKeyHex: str(existing.public_key_hex),
        };
      }
      // 容量计数在首次准入、revoked 重入或 pending（补交口令直升 / 换钥滑入 mismatch）时查询；
      // 口径与 approve 审批一致：authorized+paused+mismatch（PC-10 统一占席规则）
      if (decisionExisting === null || decisionExisting.status === 'revoked' || decisionExisting.status === 'pending') {
        const countRow = this.db
          .prepare(`SELECT COUNT(*) AS n FROM network_members WHERE network_id = ? AND status IN (${OCCUPYING_SQL})`)
          .get(input.networkId) as Row;
        capacityUsed = toNum(countRow.n);
      }

      const decision = decideJoinAttempt({
        admissionMode: str(network.admission_mode) as AdmissionMode,
        maxPeers: toNum(network.max_peers),
        existing: decisionExisting,
        incomingPublicKeyHex: input.publicKeyHex,
        joinKeyMatched: input.joinKeyMatched,
        capacityUsed,
      });

      if (decision === 'reject') return null;
      if (decision === 'limit-reached') {
        throw new StoreError('limit-reached', `network ${input.networkId} is at max peers (${toNum(network.max_peers)})`);
      }
      if (decision === 'keep' && existing !== undefined) return mapMemberRow(existing);
      if (decision === 'mismatch' && existing !== undefined) {
        this.db
          .prepare('UPDATE network_members SET status = ?, candidate_public_key_hex = ? WHERE network_id = ? AND node_id = ?')
          .run('mismatch', input.publicKeyHex, input.networkId, input.nodeId);
      } else if (decision === 'authorize' || decision === 'pending') {
        // 决策值 authorize 落库为状态值 authorized
        const nextStatus: MemberStatus = decision === 'authorize' ? 'authorized' : 'pending';
        if (existing !== undefined) {
          // revoked 复活：换上来的公钥生效、清候选
          this.db
            .prepare(
              'UPDATE network_members SET status = ?, public_key_hex = ?, candidate_public_key_hex = NULL WHERE network_id = ? AND node_id = ?',
            )
            .run(nextStatus, input.publicKeyHex, input.networkId, input.nodeId);
        } else {
          this.db
            .prepare(
              'INSERT INTO network_members (network_id, node_id, name, note, status, public_key_hex, candidate_public_key_hex, nat_type, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
            )
            .run(
              input.networkId,
              input.nodeId,
              input.name ?? null,
              input.note ?? null,
              nextStatus,
              input.publicKeyHex,
              'unknown',
              nowIso(),
            );
        }
      }
      const row = this.getMemberRow(input.networkId, input.nodeId);
      if (row === undefined) throw new StoreError('member-not-found', 'member disappeared after join attempt');
      return mapMemberRow(row);
    });
  }

  async transitionMemberStatus(
    networkId: string,
    nodeId: string,
    action: TransitionAction,
  ): Promise<MemberRecord> {
    return this.tx(() => {
      const row = this.db
        .prepare(
          'SELECT m.*, n.max_peers AS max_peers FROM network_members m JOIN networks n ON n.id = m.network_id WHERE m.network_id = ? AND m.node_id = ?',
        )
        .get(networkId, nodeId) as Row | undefined;
      if (row === undefined) {
        throw new StoreError('member-not-found', `member ${nodeId} does not exist in network ${networkId}`);
      }
      const status = decodeMemberStatus(str(row.status));
      const outcome = decideTransition(status, action);
      if (outcome === 'invalid') {
        throw new StoreError('invalid-transition', `action ${action} not allowed from status ${status}`);
      }
      // F2 加固：repin 前要求候选公钥存在；缺失（数据损坏）绝不把 "null" 写进 public_key_hex
      const candidateHex = typeof row.candidate_public_key_hex === 'string' && row.candidate_public_key_hex.length > 0 ? row.candidate_public_key_hex : null;
      if (outcome.requiresCandidate === true && candidateHex === null) {
        throw new StoreError('invalid-transition', `repin requires a stored candidate public key (member ${nodeId})`);
      }
      if (outcome.needsCapacityCheck === true) {
        // PC-10 统一口径：mismatch 也占席，approve 的空位判定必须把 mismatch 计入
        const countRow = this.db
          .prepare(`SELECT COUNT(*) AS n FROM network_members WHERE network_id = ? AND status IN (${OCCUPYING_SQL})`)
          .get(networkId) as Row;
        if (toNum(countRow.n) >= toNum(row.max_peers)) {
          throw new StoreError('limit-reached', `network ${networkId} is at max peers (${str(row.max_peers)})`);
        }
      }
      const nextPublicKey = outcome.promoteCandidate === true ? (candidateHex as string) : str(row.public_key_hex);
      this.db
        .prepare(
          'UPDATE network_members SET status = ?, public_key_hex = ?, candidate_public_key_hex = NULL WHERE network_id = ? AND node_id = ?',
        )
        .run(outcome.next, nextPublicKey, networkId, nodeId);
      const updated = this.getMemberRow(networkId, nodeId);
      if (updated === undefined) throw new StoreError('member-not-found', 'member disappeared after transition');
      return mapMemberRow(updated);
    });
  }

  async updateMemberProfile(networkId: string, nodeId: string, patch: MemberProfilePatch): Promise<MemberRecord> {
    return this.tx(() => {
      const existing = this.getMemberRow(networkId, nodeId);
      if (existing === undefined) {
        throw new StoreError('member-not-found', `member ${nodeId} does not exist in network ${networkId}`);
      }
      const nextName = 'name' in patch ? (patch.name ?? null) : (typeof existing.name === 'string' ? existing.name : null);
      const nextNote = 'note' in patch ? (patch.note ?? null) : (typeof existing.note === 'string' ? existing.note : null);
      this.db
        .prepare('UPDATE network_members SET name = ?, note = ? WHERE network_id = ? AND node_id = ?')
        .run(nextName, nextNote, networkId, nodeId);
      const updated = this.getMemberRow(networkId, nodeId);
      if (updated === undefined) throw new StoreError('member-not-found', 'member disappeared after profile update');
      return mapMemberRow(updated);
    });
  }

  async removeMember(networkId: string, nodeId: string): Promise<void> {
    this.db.prepare('DELETE FROM network_members WHERE network_id = ? AND node_id = ?').run(networkId, nodeId);
  }

  async listMembers(networkId: string): Promise<MemberRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM network_members WHERE network_id = ? ORDER BY created_at, node_id')
      .all(networkId) as Row[];
    return rows.map(mapMemberRow);
  }

  async flushMemberTelemetry(updates: TelemetryUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    const statement = this.db.prepare(
      `UPDATE network_members SET
         cumulative_relay_bytes = cumulative_relay_bytes + ?,
         last_ip = COALESCE(?, last_ip),
         nat_type = COALESCE(?, nat_type),
         last_seen_at = COALESCE(?, last_seen_at)
       WHERE network_id = ? AND node_id = ?`,
    );
    const ownerStatement = this.db.prepare('SELECT owner_id FROM networks WHERE id = ?');
    const usageStatement = this.db.prepare(
      'INSERT INTO monthly_relay_usage (user_id, year_month, relay_bytes) VALUES (?, ?, ?) ON CONFLICT(user_id, year_month) DO UPDATE SET relay_bytes = relay_bytes + excluded.relay_bytes',
    );
    this.tx(() => {
      // 同批内按 networkId 缓存属主查询，避免重复 SELECT
      const ownerCache = new Map<string, string | null>();
      for (const update of updates) {
        statement.run(
          update.relayBytesDelta ?? 0,
          update.lastIp ?? null,
          update.natType ?? null,
          update.lastSeenAt ?? null,
          update.networkId,
          update.nodeId,
        );
        // 月度流量只对正向字节做原子累计（与成员更新同批事务，全成/全败）
        const delta = update.relayBytesDelta ?? 0;
        if (delta <= 0) continue;
        let ownerId = ownerCache.get(update.networkId);
        if (ownerId === undefined) {
          const ownerRow = ownerStatement.get(update.networkId) as Row | undefined;
          ownerId = ownerRow === undefined ? null : str(ownerRow.owner_id);
          ownerCache.set(update.networkId, ownerId);
        }
        if (ownerId === null) continue; // 网络行缺失：与成员 UPDATE 一样静默跳过
        const yearMonth = (update.lastSeenAt ?? nowIso()).slice(0, 7);
        usageStatement.run(ownerId, yearMonth, delta);
      }
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
