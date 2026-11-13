// SQLite 实现的 GatewayStore：node:sqlite DatabaseSync（同步 API），方法签名仍返回 Promise
// 以符合窄接口。WAL + 外键约束在打开时显式开启。
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  seed?: SystemSettings;
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

function mapUserRow(row: Row): UserRecord {
  return {
    id: str(row.id),
    email: str(row.email),
    passwordHash: str(row.password_hash),
    role: str(row.role) === 'admin' ? 'admin' : 'user',
    active: row.active === 1 || row.active === true,
    createdAt: str(row.created_at),
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
    if (options.seed !== undefined) {
      this.seedSettings(options.seed);
    }
  }

  /** 缺键逐键播种（INSERT OR IGNORE），已有键不被 seed 覆盖 */
  private seedSettings(seed: SystemSettings): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)');
    for (const key of Object.keys(SETTINGS_KEYS) as Array<keyof SystemSettings>) {
      insert.run(SETTINGS_KEYS[key], encodeSettingsValue(seed[key]));
    }
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

  private getSettingsValue(key: keyof SystemSettings, fallback: number): number {
    const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(SETTINGS_KEYS[key]) as Row | undefined;
    const raw = row === undefined ? undefined : row.value;
    const parsed = raw === undefined || raw === null ? Number.NaN : toNum(raw);
    return Number.isFinite(parsed) && raw !== undefined && raw !== null ? parsed : fallback;
  }

  private getUserRowBy(column: 'id' | 'email', value: string): Row | undefined {
    return this.db.prepare(`SELECT * FROM users WHERE ${column} = ?`).get(value) as Row | undefined;
  }

  private getUserById(id: string): UserRecord | null {
    const row = this.getUserRowBy('id', id);
    return row === undefined ? null : mapUserRow(row);
  }

  private getNetworkRow(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM networks WHERE id = ?').get(id) as Row | undefined;
  }

  private getMemberRow(networkId: string, nodeId: string): Row | undefined {
    return this.db
      .prepare('SELECT * FROM network_members WHERE network_id = ? AND node_id = ?')
      .get(networkId, nodeId) as Row | undefined;
  }

  // ---------------------------------------------------------------- settings

  async getSettings(): Promise<SystemSettings> {
    return this.getSettingsSync();
  }

  async updateSettings(patch: SettingsPatch): Promise<SystemSettings> {
    const update = this.db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)');
    this.tx(() => {
      for (const key of Object.keys(SETTINGS_KEYS) as Array<keyof SystemSettings>) {
        const value = patch[key];
        if (value !== undefined) {
          update.run(SETTINGS_KEYS[key], encodeSettingsValue(value));
        }
      }
    });
    return this.getSettingsSync();
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
    const id = randomBytes(12).toString('hex');
    this.db
      .prepare('INSERT INTO users (id, email, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(id, input.email, input.passwordHash, input.role, nowIso());
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

  // ---------------------------------------------------------------- networks

  async createNetwork(input: CreateNetworkInput): Promise<NetworkRecord> {
    const id = randomId16();
    this.tx(() => {
      const owner = this.db.prepare('SELECT role FROM users WHERE id = ?').get(input.ownerId) as Row | undefined;
      if (owner === undefined) {
        throw new StoreError('user-not-found', `owner ${input.ownerId} does not exist`);
      }
      if (str(owner.role) !== 'admin') {
        // 原子配额：同一事务内计数并比较（SQLite 同步驱动下 BEGIN IMMEDIATE 已串行化写者）
        const limit = this.getSettingsValue('maxNetworksPerUser', DEFAULT_SETTINGS.maxNetworksPerUser);
        const countRow = this.db
          .prepare('SELECT COUNT(*) AS n FROM networks WHERE owner_id = ?')
          .get(input.ownerId) as Row;
        if (toNum(countRow.n) >= limit) {
          throw new StoreError('quota-exceeded', `network quota exhausted (limit ${limit})`);
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
    this.tx(() => {
      for (const update of updates) {
        statement.run(
          update.relayBytesDelta ?? 0,
          update.lastIp ?? null,
          update.natType ?? null,
          update.lastSeenAt ?? null,
          update.networkId,
          update.nodeId,
        );
      }
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
