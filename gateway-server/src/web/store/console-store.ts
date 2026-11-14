// 控制台前端状态层（PG-6a）。纯逻辑、零 DOM 依赖：后端 tsc 编译进 dist/web/
// 供测试直接 import，浏览器半边经 tsconfig.web.json 类型检查。
//
// 两半职责：
//   纯函数（createInitialState / applyTopologySnapshot / patchUiState …）
//     —— ConsoleState 是不可变对象，每次变更产出新状态；React 经
//     useSyncExternalStore(store.subscribe, store.getState) 订阅。
//   ConsoleClient —— /api/v1/* 的 REST 信封解包 + SSE 订阅。fetch 与
//     EventSource 都可以注入（浏览器用全局实现，测试用假件）。
//
// 关键 UX 保证：SSE 收到 topology-updated 只替换 topology[networkId] 这一个
// 数据切片，session / meta / networks / ui 的引用原样保留——已打开的弹窗、
// 下拉菜单、行内二次确认和正在输入的表单草稿都活在 ui 切片里，引用不变就
// 不会被实时推送冲掉。test/web-store.test.mjs 用引用相等钉住这一保证。
//
// GC-7b 扩展：公开策略（publicPolicy）与个人配额（quota）切片、管理员运行态
// / 脱敏设置 / 用户组 / 用户四张管理切片（各带独立加载与错误态），以及
// GC-5/GC-6a/GC-6b 的认证自助与管理 API 客户端方法。登出、401 或切出管理页
// 必须彻底清理管理员敏感切片（clearedAdminSlices / clearAdminSlices）。

// ---------------------------------------------------------------- 数据形态（镜像服务端）

import type { Locale } from '../i18n/locales.js';

export type UserRole = 'admin' | 'user';

export interface PublicUser {
  id: string;
  email: string;
  role: UserRole;
  /** 邮箱验证时刻；null / 缺省 = 未验证（GC-5 起后端随认证上下文返回） */
  emailVerifiedAt?: string | null;
}

export interface SessionMeta {
  allowSignup: boolean;
  maxNetworksPerUser: number;
}

export interface SessionSlice {
  user: PublicUser;
  meta: SessionMeta;
}

export type AdmissionMode = 'key' | 'manual' | 'both';

/** GET /networks 的归属者视角网络视图（joinKey 是明文，仅归属者可见） */
export interface NetworkView {
  id: string;
  name: string;
  admissionMode: AdmissionMode;
  maxPeers: number;
  createdAt: string;
  joinKey: string;
  joinUri: string;
  gatewayUrl: string;
  onlineDevices: number;
  totalDevices: number;
  pendingCount: number;
}

export type MemberStatus = 'pending' | 'authorized' | 'paused' | 'mismatch' | 'revoked';
export type NatType = 'cone' | 'symmetric' | 'public' | 'unknown';

/** GET /networks/:id/topology 与 SSE 共用的完整快照（镜像服务端 NetworkTopologySnapshot） */
export interface TopologySnapshot {
  network: { id: string; name: string; admissionMode: AdmissionMode; maxPeers: number };
  /** totalLiveRelayKbps 数值单位：KB/s = 1024 字节/秒（PC-17 契约，不是 kilobits） */
  summary: { onlineDevices: number; pendingCount: number; totalLiveRelayKbps: number };
  pending: Array<{ nodeId: string; name: string | null; lastIp: string | null }>;
  members: TopologyMemberRow[];
  links: TopologyLink[];
}

export interface TopologyMemberRow {
  nodeId: string;
  name: string | null;
  /** 归属者给设备写的备注 */
  note: string | null;
  status: MemberStatus;
  natType: NatType;
  lastIp: string | null;
  online: boolean;
  /** 实时中转速率（作为发送方），KB/s = 1024 字节/秒（PC-17 契约） */
  liveRelayKbps: number;
  cumulativeRelayBytes: number;
  /** 最后一次遥测/入网落库时间；从未上报过为 null（界面显示「刚刚」） */
  lastSeenAt: string | null;
}

export interface TopologyLink {
  srcNodeId: string;
  peerNodeId: string;
  /** 节点自报路径：白名单 lan / p2p / relay / blocked（PC16a），白名单外的值由展示层按未知处理 */
  path: string;
  /** null = 未知（中继/阻断路径没有测速协议），与实测 0 是两种观测，不得强转 */
  rttMs: number | null;
  /** 本对实时中转速率，KB/s = 1024 字节/秒（PC-17 契约） */
  liveRelayKbps: number;
}

export type MemberAction = 'approve' | 'reject' | 'pause' | 'resume' | 'repin';

export interface SystemSettings {
  allowSignup: boolean;
  maxNetworksPerUser: number;
  defaultMaxPeers: number;
  relayRateKbps: number;
}

/**
 * GET /api/v1/admin/users 的行（GC-6a，严格对齐后端 adminUserRow 19 键）：
 * publicUser 三件套 + 账号字段 + 有效组配额视图，无 passwordHash。
 * admin 的 maxNetworks / monthlyRelayQuotaBytes 为 null（不受组上限约束）。
 */
export interface AdminUserRow {
  id: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  emailVerifiedAt: string | null;
  /** 用户行上登记的组 id（回退后与 effectiveGroupId 不同） */
  groupId: string;
  groupCode: string | null;
  groupName: string | null;
  /** 到期回退后实际生效的组 */
  effectiveGroupId: string;
  effectiveGroupName: string;
  groupExpiresAt: string | null;
  isExpiredFallback: boolean;
  maxNetworks: number | null;
  networkCount: number;
  onlineDevices: number;
  /** 名下网络合计实时中转速率，KB/s = 1024 字节/秒（PC-17 契约） */
  relayKbps: number;
  monthlyRelayBytes: number;
  monthlyRelayQuotaBytes: number | null;
}

// ---------------------------------------------------------------- GC-7b：公开策略 / 配额 / 管理 API 形态（镜像 GC-5/GC-6a/GC-6b 后端）

/**
 * 公开策略段（镜像 auth.ts AuthPublicPolicy）：匿名与登录态的 /auth/me、
 * login、signup 响应都携带。控制台首屏与注册/忘记密码表单据此渲染。
 */
export interface PublicAuthMeta {
  allowSignup: boolean;
  requireEmailVerification: boolean;
  smtpConfigured: boolean;
  maxNetworksPerUser: number;
  defaultMaxPeers: number;
}

/**
 * 当前登录用户的有效配额视图（镜像 auth.ts buildUserQuotaPayload）：组到期
 * 回退默认组后，生效组 + 用量计数。maxNetworks / monthlyRelayQuotaBytes 为
 * null 表示管理员不受组上限约束（或不限月度流量）。
 */
export interface UserQuotaSummary {
  groupId: string;
  /** 用户行上登记的组 id；到期回退后与 groupId（生效组）不同 */
  assignedGroupId: string;
  groupCode: string;
  groupName: string;
  groupExpiresAt: string | null;
  /** true = 登记的组配额已到期，当前生效值来自默认组 */
  isExpiredFallback: boolean;
  maxNetworks: number | null;
  maxPeersPerNetwork: number;
  relayRateKbps: number;
  /** null = 不限月度中转流量 */
  monthlyRelayQuotaBytes: number | null;
  usedNetworks: number;
  usedMonthlyRelayBytes: number;
}

/** 登录/注册响应体（镜像 auth.ts buildSessionPayload）：user + quota + 公开策略段 */
export type SessionPayload = PublicAuthMeta & { user: PublicUser; quota: UserQuotaSummary };

/** GET /auth/me 的返回（登录态二选一；匿名带公开策略，登录态另有 user 与配额视图） */
export type MeResult =
  | ({ authenticated: true; user: PublicUser; quota: UserQuotaSummary } & PublicAuthMeta)
  | ({ authenticated: false } & PublicAuthMeta);

/**
 * init() 的入参：正常是 /auth/me 的返回（MeResult）；网络不可达的启动降级路径
 * 只能合成旧两键的匿名策略，因此匿名分支允许公开策略字段缺省，init 内部按
 * 关闸兜底（App.tsx 的 catch 分支即此形态）。
 */
export type MeInput =
  | ({ authenticated: true; user: PublicUser; quota: UserQuotaSummary } & PublicAuthMeta)
  | ({ authenticated: false } & Partial<PublicAuthMeta>);

/** 管理员视角的用户组行（镜像 routes-admin groupRowWithCount：UserGroupRecord + userCount） */
export interface UserGroup {
  id: string;
  /** 小写标识码，全库唯一、创建后不可改 */
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
  /** 当前绑定该组的用户数（列表接口现算） */
  userCount: number;
}

/** 运行态安全告警枚举（SPEC 5.4）：公网明文入口 / 辅助探测口关闭 */
export type SecurityWarning = 'PUBLIC_HTTP_PLAINTEXT' | 'UDP_ALT_DISABLED';

/** GET /api/v1/admin/runtime 的只读运行态（脱敏红线：绝无数据库串/密钥/绝对路径） */
export interface GatewayRuntimeStatus {
  listenPort: number;
  udpPort: number;
  udpAltPort: number;
  storageDriver: 'sqlite' | 'postgres';
  secretSource: 'env' | 'file';
  publicUrlEffective: string;
  publicUrlSource: 'settings' | 'env' | 'request';
  smtpConfigured: boolean;
  onlineDevices: number;
  /** 全网实时中转速率，KB/s = 1024 字节/秒（PC-17 契约） */
  totalLiveRelayKbps: number;
  cumulativeRelayBytes: number;
  securityWarnings: SecurityWarning[];
}

/** SMTP 加密方式（镜像 SmtpSecurityMode：implicit_tls→tls、plain→none 归一化后的值域） */
export type SmtpSecurity = 'tls' | 'starttls' | 'none';

/** GET/PATCH /admin/settings 返回的脱敏 smtp 视图：永无密码原文，只有 hasPassword 布尔 */
export interface AdminSmtpView {
  configured: boolean;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string;
  rejectUnauthorized: boolean;
}

/** 管理接口密钥的脱敏视图：明文只在 rotate 响应出现一次，这里只有前缀与创建时刻 */
export interface AdminApiKeyView {
  configured: boolean;
  prefix: string | null;
  createdAt: string | null;
}

/**
 * GET/PATCH /api/v1/admin/settings 的完整脱敏视图（镜像 routes-admin
 * buildSettingsView，GC-6b 扩展形态）。是旧 SystemSettings 四键的超集。
 */
export interface AdminSettingsData {
  allowSignup: boolean;
  requireEmailVerification: boolean;
  maxNetworksPerUser: number;
  defaultMaxPeers: number;
  relayRateKbps: number;
  /** null = 未设置，回落环境变量/请求头推断 */
  publicUrl: string | null;
  /** 登录态有效期（天），后端约束 1..90 */
  sessionTtlDays: number;
  defaultGroupId: string;
  smtp: AdminSmtpView;
  adminApiKey: AdminApiKeyView;
}

/** PATCH smtp 与 smtp-test 共用的发信草稿：password 省略或空 = 沿用库中已存密码 */
export interface AdminSmtpDraft {
  host: string;
  port: number;
  security: SmtpSecurity;
  username?: string;
  password?: string | null;
  fromAddress: string;
  fromName?: string;
  rejectUnauthorized?: boolean;
}

/** PATCH /api/v1/admin/settings 接受的部分更新（全部字段可选；smtp 传 null = 清空发信配置） */
export interface AdminSettingsPatch {
  allowSignup?: boolean;
  requireEmailVerification?: boolean;
  maxNetworksPerUser?: number;
  defaultMaxPeers?: number;
  relayRateKbps?: number;
  /** null = 清除，恢复环境变量/请求头推断 */
  publicUrl?: string | null;
  sessionTtlDays?: number;
  defaultGroupId?: string;
  smtp?: AdminSmtpDraft | null;
}

export interface CreateGroupInput {
  code: string;
  name: string;
  maxNetworks: number;
  maxPeersPerNetwork: number;
  relayRateKbps: number;
  monthlyRelayQuotaBytes?: number | null;
  description?: string;
  /** true = 取消其余组的默认标记，并把三项配额写回系统设置 */
  isDefault?: boolean;
}

export interface UpdateGroupPatch {
  name?: string;
  description?: string;
  isDefault?: boolean;
  maxNetworks?: number;
  maxPeersPerNetwork?: number;
  relayRateKbps?: number;
  monthlyRelayQuotaBytes?: number | null;
}

export interface CreateAdminUserInput {
  email: string;
  /** 省略 = 后端生成 16 位随机密码，仅本次响应返回 generatedPassword */
  password?: string;
  role?: UserRole;
  /** 显式组 id；null = 绑定当前默认组（后端事务内解析，不硬编码内置组） */
  groupId?: string | null;
  /** 组标识码查找（groupId 显式给定时忽略） */
  groupCode?: string | null;
  groupExpiresAt?: string | null;
  emailVerified?: boolean;
}

export interface UpdateAdminUserPatch {
  active?: boolean;
  role?: UserRole;
  /** null = 重置为当前默认组 */
  groupId?: string | null;
  groupExpiresAt?: string | null;
  emailVerified?: boolean;
}

// ---------------------------------------------------------------- UI 本地交互状态

/**
 * 弹窗、下拉菜单、行内二次确认、正在输入的表单草稿——全部放在这里，
 * SSE 合并保证这个切片引用不变，实时推送永远冲不掉交互状态。
 */
export interface UiLocalState {
  /** 顶栏网络切换下拉 */
  networkSwitcherOpen: boolean;
  /** 顶栏账号菜单 */
  accountMenuOpen: boolean;
  /** 登录页当前标签 */
  loginMode: 'login' | 'signup';
  loginEmail: string;
  loginPassword: string;
  /** 行内二次确认目标（如 'rotate-key:<id>' / 'remove:<nodeId>'），null 无 */
  confirmTarget: string | null;
  /** 打开的弹窗目标（如 'new-network'），null 无 */
  dialog: string | null;
  /** 正在输入的新网络名称草稿 */
  draftNetworkName: string;
}

// ---------------------------------------------------------------- GC-7b：管理切片的加载/错误态

/** 带独立加载态的四张管理切片 */
export type AdminSliceKey = 'runtime' | 'settings' | 'groups' | 'users';

/** 单张切片的加载阶段：idle（未拉取）/ loading（在途）/ ready（有数据）/ error（末次失败） */
export type SliceLoadPhase = 'idle' | 'loading' | 'ready' | 'error';

function withRecordEntry<V>(record: Record<AdminSliceKey, V>, key: AdminSliceKey, value: V): Record<AdminSliceKey, V> {
  const next: Record<AdminSliceKey, V> = { ...record };
  next[key] = value;
  return next;
}

// ---------------------------------------------------------------- 状态切片

export interface ConsoleState {
  /** 启动期 /auth/me 未回来前是 loading */
  boot: 'loading' | 'ready';
  session: SessionSlice | null;
  meta: SessionMeta;
  /** /auth/me 公开策略（匿名也返回）；init / applySessionPayload 同步写入 */
  publicPolicy: PublicAuthMeta;
  /** 当前登录用户的有效配额视图；未登录 / 退出后为 null */
  quota: UserQuotaSummary | null;
  networks: NetworkView[];
  topology: Readonly<Record<string, TopologySnapshot>>;
  /** 网关管理页只读运行态（仅管理员拉取）；未拉到前是 null */
  adminRuntime: GatewayRuntimeStatus | null;
  /** 网关管理页脱敏设置（GC-6b 扩展视图，旧 SystemSettings 四键的超集）；未拉到前是 null */
  adminSettings: AdminSettingsData | null;
  adminGroups: UserGroup[];
  adminUsers: AdminUserRow[];
  /** 四张管理切片各自的加载阶段（独立，互不阻塞） */
  adminLoad: Readonly<Record<AdminSliceKey, SliceLoadPhase>>;
  /** 四张管理切片各自的末次错误消息（null = 无） */
  adminError: Readonly<Record<AdminSliceKey, string | null>>;
  ui: UiLocalState;
}

export function createInitialState(): ConsoleState {
  return {
    boot: 'loading',
    session: null,
    meta: { allowSignup: false, maxNetworksPerUser: 3 },
    // /auth/me 回来前的占位公开策略：保守关闸（不许注册/不要求验证/无 SMTP），
    // maxNetworksPerUser 与旧 meta 占位一致，defaultMaxPeers 取后端默认种子 8
    publicPolicy: { allowSignup: false, requireEmailVerification: false, smtpConfigured: false, maxNetworksPerUser: 3, defaultMaxPeers: 8 },
    quota: null,
    networks: [],
    topology: {},
    adminRuntime: null,
    adminSettings: null,
    adminGroups: [],
    adminUsers: [],
    adminLoad: { runtime: 'idle', settings: 'idle', groups: 'idle', users: 'idle' },
    adminError: { runtime: null, settings: null, groups: null, users: null },
    ui: {
      networkSwitcherOpen: false,
      accountMenuOpen: false,
      loginMode: 'login',
      loginEmail: '',
      loginPassword: '',
      confirmTarget: null,
      dialog: null,
      draftNetworkName: '',
    },
  };
}

// ---------------------------------------------------------------- 纯函数状态迁移

/** 登录/注册成功：写入 session 与 meta */
export function applySession(state: ConsoleState, user: PublicUser, meta: SessionMeta): ConsoleState {
  return { ...state, session: { user, meta }, meta };
}

/**
 * 登录/注册响应体一次落库（GC-7b）：session + meta + quota + publicPolicy。
 * 后端 buildSessionPayload 与 /auth/me 登录态同构，注册后自动登录与换绑邮箱
 * 后的会话刷新都走这里。
 */
export function applySessionPayload(state: ConsoleState, payload: SessionPayload): ConsoleState {
  return {
    ...applySession(state, payload.user, {
      allowSignup: payload.allowSignup,
      maxNetworksPerUser: payload.maxNetworksPerUser,
    }),
    quota: payload.quota,
    publicPolicy: {
      allowSignup: payload.allowSignup,
      requireEmailVerification: payload.requireEmailVerification,
      smtpConfigured: payload.smtpConfigured,
      maxNetworksPerUser: payload.maxNetworksPerUser,
      defaultMaxPeers: payload.defaultMaxPeers,
    },
  };
}

/**
 * 管理员敏感切片的统一清空形态（隐私红线）：登出、收到 401、切出管理页共用。
 * 数据四张（runtime/settings/groups/users）连同各自的加载与错误态一起归零。
 */
export function clearedAdminSlices(): Pick<
  ConsoleState,
  'adminRuntime' | 'adminSettings' | 'adminGroups' | 'adminUsers' | 'adminLoad' | 'adminError'
> {
  return {
    adminRuntime: null,
    adminSettings: null,
    adminGroups: [],
    adminUsers: [],
    adminLoad: { runtime: 'idle', settings: 'idle', groups: 'idle', users: 'idle' },
    adminError: { runtime: null, settings: null, groups: null, users: null },
  };
}

/**
 * 退出登录：清空 session、quota 与全部业务数据切片 + 管理员敏感切片（隐私），
 * 保留 ui（表单草稿不丢）、meta 与 publicPolicy（公开信息，匿名可见）。
 */
export function setLoggedOut(state: ConsoleState, meta: SessionMeta): ConsoleState {
  return {
    ...state,
    session: null,
    meta,
    networks: [],
    topology: {},
    quota: null,
    ...clearedAdminSlices(),
  };
}

/** 公开策略整体刷新（/auth/me 匿名态或策略变更钩子） */
export function applyPublicPolicy(state: ConsoleState, policy: PublicAuthMeta): ConsoleState {
  return { ...state, publicPolicy: policy };
}

/** 个人配额视图刷新（/auth/me 登录态、建网删网后的用量变化） */
export function applyQuota(state: ConsoleState, quota: UserQuotaSummary | null): ConsoleState {
  return { ...state, quota };
}

/** 单张管理切片进入 loading（发起拉取前调用；互相独立，不碰其他切片） */
export function markAdminLoading(state: ConsoleState, key: AdminSliceKey): ConsoleState {
  return { ...state, adminLoad: withRecordEntry(state.adminLoad, key, 'loading') };
}

/** 单张管理切片失败：phase → error 并记录消息（数据切片保留旧值供展示兜底） */
export function markAdminError(state: ConsoleState, key: AdminSliceKey, message: string): ConsoleState {
  return {
    ...state,
    adminLoad: withRecordEntry(state.adminLoad, key, 'error'),
    adminError: withRecordEntry(state.adminError, key, message),
  };
}

/** 管理员运行态整体刷新（管理页轮询/进入页面拉取） */
export function applyAdminRuntime(state: ConsoleState, runtime: GatewayRuntimeStatus): ConsoleState {
  return {
    ...state,
    adminRuntime: runtime,
    adminLoad: withRecordEntry(state.adminLoad, 'runtime', 'ready'),
    adminError: withRecordEntry(state.adminError, 'runtime', null),
  };
}

/** 管理员设置整体刷新（PATCH 成功后用返回值替换；GC-6b 起为完整脱敏视图） */
export function applyAdminSettings(state: ConsoleState, settings: AdminSettingsData): ConsoleState {
  return {
    ...state,
    adminSettings: settings,
    adminLoad: withRecordEntry(state.adminLoad, 'settings', 'ready'),
    adminError: withRecordEntry(state.adminError, 'settings', null),
  };
}

/** 管理员用户组列表整体刷新 */
export function applyAdminGroups(state: ConsoleState, groups: UserGroup[]): ConsoleState {
  return {
    ...state,
    adminGroups: groups,
    adminLoad: withRecordEntry(state.adminLoad, 'groups', 'ready'),
    adminError: withRecordEntry(state.adminError, 'groups', null),
  };
}

/** 管理员用户列表整体刷新 */
export function applyAdminUsers(state: ConsoleState, users: AdminUserRow[]): ConsoleState {
  return {
    ...state,
    adminUsers: users,
    adminLoad: withRecordEntry(state.adminLoad, 'users', 'ready'),
    adminError: withRecordEntry(state.adminError, 'users', null),
  };
}

/** 网络列表整体刷新（REST 拉取的结果） */
export function applyNetworks(state: ConsoleState, networks: NetworkView[]): ConsoleState {
  return { ...state, networks };
}

/**
 * SSE 快照合并（含首载 REST 快照）：只替换 topology[snapshot.network.id]。
 * 其余切片引用原样保留——这是「实时推送不冲掉交互状态」的实现根基。
 */
export function applyTopologySnapshot(state: ConsoleState, snapshot: TopologySnapshot): ConsoleState {
  return { ...state, topology: { ...state.topology, [snapshot.network.id]: snapshot } };
}

/** 浅合并 ui 切片（组件改菜单开关、草稿等） */
export function patchUiState(state: ConsoleState, patch: Partial<UiLocalState>): ConsoleState {
  return { ...state, ui: { ...state.ui, ...patch } };
}

// ---------------------------------------------------------------- PC-20：顶栏计数派生（SSE 事实 → 既有字段口径）

/** 顶栏/切换菜单的设备计数三元组（与 REST NetworkView 的同名字段同口径） */
export interface NetworkDeviceCounts {
  /** 占席位成员：authorized + paused + mismatch */
  totalDevices: number;
  /** 当前在线连接数 */
  onlineDevices: number;
  /** 待审批申请数 */
  pendingCount: number;
}

/**
 * 顶栏计数派生（PC-20）：当前网络有实时快照时按快照事实计算，沿 REST
 * NetworkView 的既有字段口径（服务端 routes-networks 的 networkView：占席
 * = authorized + paused + mismatch，在线 = 当前连接数，待审批 = pending 数；
 * 席位过滤与 format.ts 的 filterJoinedMembers 同一规则——那边依赖本模块的
 * 类型，故在这里就地实现）。无快照（未订阅/未首推）或快照不属于这个网络
 * （串网防护）时回落 REST 值——没订阅的网络不假称实时。
 */
export function deriveNetworkCounts(network: NetworkView, snapshot?: TopologySnapshot): NetworkDeviceCounts {
  if (snapshot === undefined || snapshot.network.id !== network.id) {
    return { totalDevices: network.totalDevices, onlineDevices: network.onlineDevices, pendingCount: network.pendingCount };
  }
  let totalDevices = 0;
  for (const member of snapshot.members) {
    if (member.status === 'authorized' || member.status === 'paused' || member.status === 'mismatch') totalDevices += 1;
  }
  return { totalDevices, onlineDevices: snapshot.summary.onlineDevices, pendingCount: snapshot.summary.pendingCount };
}

// ---------------------------------------------------------------- 可订阅 store

/** useSyncExternalStore 友好的小 store：getState/subscribe 绑定 this，变更恰好发一次通知 */
export class ConsoleStore {
  private readonly listeners = new Set<() => void>();
  private state: ConsoleState = createInitialState();

  readonly getState = (): ConsoleState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(next: ConsoleState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * 启动期 /auth/me（fetchMe）回来后的就绪动作：公开策略无论登录与否都写入；
   * 登录态写 session 与 quota，未登录顺手清全部业务与管理员数据。
   * 缺省字段按关闸兜底（启动降级路径 / 旧形状夹具）。
   */
  init(me: MeInput): void {
    // 入参容忍匿名分支缺省公开策略字段（启动降级路径）：关闸兜底 + 旧 meta 占位
    const allowSignup = me.allowSignup ?? false;
    const maxNetworksPerUser = me.maxNetworksPerUser ?? 3;
    const meta: SessionMeta = { allowSignup, maxNetworksPerUser };
    const publicPolicy: PublicAuthMeta = {
      allowSignup,
      requireEmailVerification: me.requireEmailVerification ?? false,
      smtpConfigured: me.smtpConfigured ?? false,
      maxNetworksPerUser,
      defaultMaxPeers: me.defaultMaxPeers ?? 8,
    };
    if (me.authenticated) {
      this.setState({
        ...applySession(this.state, me.user, meta),
        boot: 'ready',
        publicPolicy,
        quota: me.quota ?? null,
      });
    } else {
      this.setState({ ...setLoggedOut(this.state, meta), boot: 'ready', publicPolicy });
    }
  }

  readonly setSession = (user: PublicUser, meta: SessionMeta): void => {
    this.setState(applySession(this.state, user, meta));
  };

  /** 登录/注册响应体一次落库：session + meta + quota + publicPolicy（GC-7b） */
  readonly applySessionPayload = (payload: SessionPayload): void => {
    this.setState(applySessionPayload(this.state, payload));
  };

  readonly applyPublicPolicy = (policy: PublicAuthMeta): void => {
    this.setState(applyPublicPolicy(this.state, policy));
  };

  readonly applyQuota = (quota: UserQuotaSummary | null): void => {
    this.setState(applyQuota(this.state, quota));
  };

  readonly logout = (meta: SessionMeta): void => {
    this.setState(setLoggedOut(this.state, meta));
  };

  readonly setNetworks = (networks: NetworkView[]): void => {
    this.setState(applyNetworks(this.state, networks));
  };

  readonly applyTopologySnapshot = (snapshot: TopologySnapshot): void => {
    this.setState(applyTopologySnapshot(this.state, snapshot));
  };

  /** 管理切片发起拉取：单张进入 loading，不碰其他切片 */
  readonly markAdminLoading = (key: AdminSliceKey): void => {
    this.setState(markAdminLoading(this.state, key));
  };

  /** 管理切片拉取失败：单张记错误与 phase，数据切片保留旧值兜底 */
  readonly markAdminError = (key: AdminSliceKey, message: string): void => {
    this.setState(markAdminError(this.state, key, message));
  };

  readonly applyAdminRuntime = (runtime: GatewayRuntimeStatus): void => {
    this.setState(applyAdminRuntime(this.state, runtime));
  };

  readonly applyAdminSettings = (settings: AdminSettingsData): void => {
    this.setState(applyAdminSettings(this.state, settings));
  };

  readonly applyAdminGroups = (groups: UserGroup[]): void => {
    this.setState(applyAdminGroups(this.state, groups));
  };

  readonly applyAdminUsers = (users: AdminUserRow[]): void => {
    this.setState(applyAdminUsers(this.state, users));
  };

  /** 切出管理页 / 收到 401 时彻底清理管理员敏感切片（不动 session 与业务数据） */
  readonly clearAdminSlices = (): void => {
    this.setState({ ...this.state, ...clearedAdminSlices() });
  };

  readonly patchUi = (patch: Partial<UiLocalState>): void => {
    this.setState(patchUiState(this.state, patch));
  };
}

// ---------------------------------------------------------------- PC-20：管理页 3 秒刷新循环（固定节拍、在途取消、过期作废）

/** 定时器注入面：固定节拍用原生 interval 语义，浏览器用全局 setInterval，测试用假件 */
export interface RefreshTimers {
  /** setInterval 语义：每 ms 调一次 handler，返回可取消句柄 */
  interval(handler: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

/** 一拍刷新的凭证：load 的落库核对、取消信号与收拍都必须经它 */
export interface RefreshTicket {
  /** 数据落库前核对：false = 本拍已作废（停表/换世代），结果必须丢弃 */
  isCurrent(): boolean;
  /** 本拍结束（成功/失败/被取消都算）必须恰好调一次：清本拍的在途标记 */
  settle(): void;
  /** 本拍的取消信号：stop()/换世代时被 abort，load 必须传给底层 fetch（PC-20 fix1 R2） */
  signal: AbortSignal;
}

export interface ManagedRefreshCycleDeps {
  intervalMs: number;
  timers: RefreshTimers;
  /** 拉一次数据；拿到的 ticket 用于世代核对、传取消信号与收拍 */
  load(ticket: RefreshTicket): Promise<void>;
}

/**
 * 固定节拍的 REST 轮询循环（PC-20 管理页；fix1 改为 interval 格点 + 在途取消）：
 * - start() 立即拉一次（不占格点）并注册一张 intervalMs 的原生 interval；已在跑时重复 start 不叠加；
 * - 格点触发时若本世代还有在途拍则跳过（忙碌跳过）——慢响应不打漂节拍、不叠加请求，
 *   节拍始终是固定 3s 格点，不是「响应耗时 + 3s」（fix1 R3）；
 * - stop() 清 interval、递增世代并 abort 在途请求——旧请求不能永久留在后台（fix1 R2）；
 *   世代守卫（isCurrent）继续兜底不可取消的迟响应，迟到结果一律不落库；
 * - 旧世代挂在途不挡新一代 start() 的立即拍（隐藏归来/重新登录都立即有新数据）。
 */
export class ManagedRefreshCycle {
  private readonly deps: ManagedRefreshCycleDeps;
  private stopped = true;
  private generation = 0;
  /** 本世代在途的拍；旧世代挂在途时不挡新世代（值为 null 表示当前无在途拍） */
  private inFlightGeneration: number | null = null;
  private inFlightController: AbortController | null = null;
  private intervalHandle: unknown = null;

  constructor(deps: ManagedRefreshCycleDeps) {
    this.deps = deps;
  }

  /** 开始：立即拉一次并注册固定节拍 interval。已在跑时是空操作，不叠加 */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.tick();
    this.intervalHandle = this.deps.timers.interval(() => this.fireTick(), this.deps.intervalMs);
  }

  /** 停：清 interval、递增世代并取消在途请求 */
  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.intervalHandle !== null) {
      this.deps.timers.cancel(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.inFlightController?.abort();
    this.inFlightController = null;
  }

  /** 固定格点触发：忙碌（本世代在途未收拍）则跳过这一拍，格点本身继续 */
  private fireTick(): void {
    if (this.stopped) return;
    if (this.inFlightGeneration === this.generation) return;
    this.tick();
  }

  private tick(): void {
    if (this.stopped) return;
    if (this.inFlightGeneration === this.generation) return;
    const generation = this.generation;
    const controller = new AbortController();
    this.inFlightGeneration = generation;
    this.inFlightController = controller;
    void this.deps.load({
      isCurrent: () => !this.stopped && generation === this.generation,
      settle: () => this.settle(generation),
      signal: controller.signal,
    });
  }

  private settle(generation: number): void {
    if (this.inFlightGeneration === generation) {
      this.inFlightGeneration = null;
      this.inFlightController = null;
    }
  }
}

// ---------------------------------------------------------------- REST + SSE 客户端

/** 统一的业务错误：status 是 HTTP 状态码，code 是服务端错误码（INVALID_CREDENTIALS 等） */
export class ConsoleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConsoleApiError';
  }
}

/** fetch 的最小结构类型：浏览器全局 fetch 与测试假件都满足 */
export interface FetchResponseLike {
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

/** EventSource 的最小结构类型：只用到 addEventListener 与 close */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

function defaultFetch(): FetchLike {
  const impl = (globalThis as { fetch?: FetchLike }).fetch;
  if (impl === undefined) {
    throw new ConsoleApiError(0, 'NO_TRANSPORT', 'fetch is not available in this environment');
  }
  // 浏览器的 window.fetch 带 WebIDL 品牌检查：receiver 不是 Window 就抛
  // Illegal invocation。绑死 globalThis，之后无论以什么形态调用都安全。
  return impl.bind(globalThis);
}

function defaultEventSourceFactory(): EventSourceFactory {
  return (url) => {
    const ctor = (globalThis as { EventSource?: new (url: string) => unknown }).EventSource;
    if (ctor === undefined) {
      throw new ConsoleApiError(0, 'NO_TRANSPORT', 'EventSource is not available in this environment');
    }
    return new ctor(url) as unknown as EventSourceLike;
  };
}

/** 信封解包：{ok:true,data} → data；{ok:false,error} → ConsoleApiError；其余 → BAD_RESPONSE */
function unwrapEnvelope(payload: unknown, status: number): unknown {
  if (typeof payload !== 'object' || payload === null) {
    throw new ConsoleApiError(status, 'BAD_RESPONSE', 'gateway returned an unexpected payload');
  }
  const obj = payload as { ok?: unknown; data?: unknown; error?: unknown };
  if (obj.ok === true) return obj.data;
  if (obj.ok === false) {
    const err = (typeof obj.error === 'object' && obj.error !== null ? obj.error : {}) as {
      code?: unknown;
      message?: unknown;
    };
    throw new ConsoleApiError(
      status,
      typeof err.code === 'string' ? err.code : 'UNKNOWN',
      typeof err.message === 'string' ? err.message : 'unknown gateway error',
    );
  }
  throw new ConsoleApiError(status, 'BAD_RESPONSE', 'gateway returned an unexpected payload');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface ConsoleClientDeps {
  /** 缺省 ''（同源部署）；反代跨源时可给完整前缀 */
  baseUrl?: string;
  fetchImpl?: FetchLike;
  eventSourceFactory?: EventSourceFactory;
}

/** /api/v1/* 的完整客户端；方法与后端路由一一对应（PG-4/PG-5 契约） */
export class ConsoleClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly eventSourceFactoryImpl: EventSourceFactory | undefined;

  constructor(deps: ConsoleClientDeps = {}) {
    this.baseUrl = deps.baseUrl ?? '';
    this.fetchImpl = deps.fetchImpl ?? defaultFetch();
    this.eventSourceFactoryImpl = deps.eventSourceFactory ?? defaultEventSourceFactory();
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    // 以局部变量调用：方法属性形式（this.fetchImpl(...)）会把 ConsoleClient
    // 实例当 receiver 传给注入件，浏览器的 WebIDL 品牌检查直接抛 Illegal invocation。
    const fetchFn = this.fetchImpl;
    if (fetchFn === undefined) {
      throw new ConsoleApiError(0, 'NO_TRANSPORT', 'fetch is not available in this environment');
    }
    let res: FetchResponseLike;
    try {
      res = await fetchFn(this.baseUrl + path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new ConsoleApiError(0, 'NETWORK_ERROR', err instanceof Error ? err.message : 'network request failed');
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new ConsoleApiError(res.status, 'BAD_RESPONSE', 'gateway returned a non-JSON response');
    }
    return unwrapEnvelope(payload, res.status) as T;
  }

  // ---- 认证

  async fetchMe(): Promise<MeResult> {
    return this.request<MeResult>('GET', '/api/v1/auth/me');
  }

  async login(email: string, password: string): Promise<SessionPayload> {
    return this.request('POST', '/api/v1/auth/login', { email: normalizeEmail(email), password });
  }

  /** 注册（自动登录）：requireEmailVerification 开启时后端强制校验 6 位 OTP */
  async signup(email: string, password: string, otpCode?: string): Promise<SessionPayload> {
    return this.request('POST', '/api/v1/auth/signup', {
      email: normalizeEmail(email),
      password,
      ...(otpCode !== undefined ? { otpCode } : {}),
    });
  }

  async logout(): Promise<void> {
    await this.request('POST', '/api/v1/auth/logout');
  }

  /**
   * 发送邮箱验证码（注册 / 找回密码）。找回密码防枚举：邮箱不存在也返回成功。
   * 错误码：429 OTP_COOLDOWN / RATE_LIMITED、403 SIGNUP_DISABLED、409 EMAIL_TAKEN、
   * 503 SMTP_NOT_CONFIGURED。
   */
  async sendOtp(input: { email: string; purpose: 'signup' | 'reset_password'; locale?: Locale }): Promise<{ sent: boolean; cooldownSec: number }> {
    return this.request('POST', '/api/v1/auth/send-otp', {
      email: normalizeEmail(input.email),
      purpose: input.purpose,
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
    });
  }

  /** 忘记密码重置：成功即该用户全部历史会话吊销；响应恒成功不暴露邮箱是否存在 */
  async resetPassword(input: { email: string; otpCode: string; newPassword: string }): Promise<{ reset: boolean }> {
    return this.request('POST', '/api/v1/auth/reset-password', {
      email: normalizeEmail(input.email),
      otpCode: input.otpCode,
      newPassword: input.newPassword,
    });
  }

  /** 自助改密：当前设备会话保持，其余全部吊销 */
  async changeMyPassword(input: { currentPassword: string; newPassword: string }): Promise<{ changed: boolean }> {
    return this.request('PATCH', '/api/v1/auth/account/password', {
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
    });
  }

  /**
   * 换绑邮箱第一步：SMTP 已配置时向新邮箱发 change_email 验证码；未配置返回
   * otpRequired: false，前端可跳过验证码直调 confirmEmailChange。
   */
  async requestEmailChange(input: { currentPassword: string; newEmail: string; locale?: Locale }): Promise<{ otpRequired: boolean; cooldownSec: number }> {
    return this.request('POST', '/api/v1/auth/account/email/request', {
      currentPassword: input.currentPassword,
      newEmail: normalizeEmail(input.newEmail),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
    });
  }

  /** 换绑邮箱第二步：SMTP 已配置时强制核验发到新邮箱的验证码 */
  async confirmEmailChange(input: { currentPassword: string; newEmail: string; otpCode?: string }): Promise<{ user: PublicUser }> {
    return this.request('POST', '/api/v1/auth/account/email', {
      currentPassword: input.currentPassword,
      newEmail: normalizeEmail(input.newEmail),
      ...(input.otpCode !== undefined ? { otpCode: input.otpCode } : {}),
    });
  }

  // ---- 网络与成员

  async listNetworks(): Promise<NetworkView[]> {
    return this.request('GET', '/api/v1/networks');
  }

  async createNetwork(input: { name: string; admissionMode?: AdmissionMode; maxPeers?: number }): Promise<NetworkView> {
    return this.request('POST', '/api/v1/networks', input);
  }

  async patchNetwork(id: string, patch: { name?: string; admissionMode?: AdmissionMode; maxPeers?: number }): Promise<NetworkView> {
    return this.request('PATCH', `/api/v1/networks/${encodeURIComponent(id)}`, patch);
  }

  async deleteNetwork(id: string): Promise<void> {
    await this.request('DELETE', `/api/v1/networks/${encodeURIComponent(id)}`);
  }

  /** 重置邀请链接：只换入网口令，已授权成员不受影响 */
  async rotateInviteKey(id: string): Promise<NetworkView> {
    return this.request('POST', `/api/v1/networks/${encodeURIComponent(id)}/rotate-key`);
  }

  async memberTransition(networkId: string, nodeId: string, action: MemberAction): Promise<void> {
    await this.request('POST', `/api/v1/networks/${encodeURIComponent(networkId)}/members/${encodeURIComponent(nodeId)}/${action}`);
  }

  async patchMember(networkId: string, nodeId: string, patch: { name?: string | null; note?: string | null }): Promise<void> {
    await this.request('PATCH', `/api/v1/networks/${encodeURIComponent(networkId)}/members/${encodeURIComponent(nodeId)}`, patch);
  }

  async removeMember(networkId: string, nodeId: string): Promise<void> {
    await this.request('DELETE', `/api/v1/networks/${encodeURIComponent(networkId)}/members/${encodeURIComponent(nodeId)}`);
  }

  /** REST 拉一次完整快照；网络不存在或他人网络返回 null（404 防枚举语义） */
  async fetchTopology(networkId: string): Promise<TopologySnapshot | null> {
    try {
      return await this.request<TopologySnapshot>('GET', `/api/v1/networks/${encodeURIComponent(networkId)}/topology`);
    } catch (err) {
      if (err instanceof ConsoleApiError && err.status === 404) return null;
      throw err;
    }
  }

  // ---- 网关管理（admin）

  // GC-6b 起该端点返回完整脱敏视图（含 smtp 与 adminApiKey）；旧方法名保留，
  // 返回类型随之对齐真实接口（AdminSettingsData 是旧 SystemSettings 四键的超集）。
  async adminGetSettings(): Promise<AdminSettingsData> {
    return this.getAdminSettings();
  }

  async adminPatchSettings(patch: Partial<SystemSettings>): Promise<AdminSettingsData> {
    return this.request('PATCH', '/api/v1/admin/settings', patch);
  }

  /** signal：管理页轮询的取消信号（PC-20 fix1——停表时 abort 在途拍），缺省行为不变 */
  async adminListUsers(signal?: AbortSignal): Promise<AdminUserRow[]> {
    return this.listAdminUsers(signal);
  }

  async adminSetUserActive(userId: string, active: boolean): Promise<void> {
    await this.request('PATCH', `/api/v1/admin/users/${encodeURIComponent(userId)}`, { active });
  }

  /** 只读运行态总览（含安全告警；脱敏红线：绝无数据库串/密钥/绝对路径） */
  async getAdminRuntime(signal?: AbortSignal): Promise<GatewayRuntimeStatus> {
    return this.request('GET', '/api/v1/admin/runtime', undefined, signal);
  }

  async getAdminSettings(signal?: AbortSignal): Promise<AdminSettingsData> {
    return this.request('GET', '/api/v1/admin/settings', undefined, signal);
  }

  /** 部分更新系统设置（smtp 传 null = 清空发信配置）；返回更新后的脱敏视图 */
  async updateAdminSettings(patch: AdminSettingsPatch): Promise<AdminSettingsData> {
    return this.request('PATCH', '/api/v1/admin/settings', patch);
  }

  /** 真实连接发一封双语测试邮件（失败 → 502 SMTP_SEND_FAILED，附脱敏诊断码） */
  async sendSmtpTest(input: { toEmail: string; locale?: Locale; smtp?: AdminSmtpDraft }): Promise<{ sent: boolean }> {
    return this.request('POST', '/api/v1/admin/settings/smtp-test', {
      toEmail: input.toEmail,
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.smtp !== undefined ? { smtp: input.smtp } : {}),
    });
  }

  /** 生成 Admin API Key：明文仅本次响应返回，落库只有 sha256 哈希与前缀 */
  async rotateAdminApiKey(): Promise<{ apiKey: string; prefix: string; createdAt: string }> {
    return this.request('POST', '/api/v1/admin/settings/api-key');
  }

  /** 吊销 Admin API Key：外部 Bearer 调用立即失效 */
  async revokeAdminApiKey(): Promise<{ revoked: boolean }> {
    return this.request('DELETE', '/api/v1/admin/settings/api-key');
  }

  /** 用户组列表（含每组 userCount 统计） */
  async listGroups(signal?: AbortSignal): Promise<UserGroup[]> {
    return this.request('GET', '/api/v1/admin/groups', undefined, signal);
  }

  /** 创建用户组；code 重复 → 409 DUPLICATE_GROUP_CODE */
  async createGroup(input: CreateGroupInput): Promise<UserGroup> {
    return this.request('POST', '/api/v1/admin/groups', input);
  }

  async updateGroup(id: string, patch: UpdateGroupPatch): Promise<UserGroup> {
    return this.request('PATCH', `/api/v1/admin/groups/${encodeURIComponent(id)}`, patch);
  }

  /** 默认组 → 400 CANNOT_DELETE_DEFAULT_GROUP；仍有用户 → 409 GROUP_IN_USE */
  async deleteGroup(id: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/api/v1/admin/groups/${encodeURIComponent(id)}`);
  }

  /** 用户列表（GC-6a 19 键行，无 passwordHash） */
  async listAdminUsers(signal?: AbortSignal): Promise<AdminUserRow[]> {
    return this.request('GET', '/api/v1/admin/users', undefined, signal);
  }

  /** 创建用户：password 省略 = 后端生成 16 位随机密码，仅本次响应返回 */
  async createAdminUser(input: CreateAdminUserInput): Promise<AdminUserRow & { generatedPassword?: string }> {
    return this.request('POST', '/api/v1/admin/users', { ...input, email: normalizeEmail(input.email) });
  }

  /** 部分更新用户（停用/降级最后一名活跃管理员 → 400 CANNOT_REMOVE_LAST_ADMIN） */
  async updateAdminUser(id: string, patch: UpdateAdminUserPatch): Promise<AdminUserRow> {
    return this.request('PATCH', `/api/v1/admin/users/${encodeURIComponent(id)}`, patch);
  }

  async deleteAdminUser(id: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/api/v1/admin/users/${encodeURIComponent(id)}`);
  }

  /** 重置用户密码并吊销其全部历史会话；newPassword 省略 = 后端随机生成 */
  async resetAdminUserPassword(id: string, newPassword?: string): Promise<{ reset: boolean; generatedPassword?: string }> {
    return this.request('POST', `/api/v1/admin/users/${encodeURIComponent(id)}/reset-password`, newPassword !== undefined ? { newPassword } : {});
  }

  // ---- SSE

  /**
   * 订阅某网络的实时快照流。snapshot（首推）与 topology-updated（增量推送）
   * 都携带完整快照，统一走 onSnapshot；坏帧静默忽略，不打断订阅。
   * 返回退订函数。
   */
  subscribeTopology(networkId: string, onSnapshot: (snapshot: TopologySnapshot) => void): () => void {
    // 同 request()：经局部变量调用，不把 ConsoleClient 实例当 receiver 传出去。
    const makeEventSource = this.eventSourceFactoryImpl;
    if (makeEventSource === undefined) {
      throw new ConsoleApiError(0, 'NO_TRANSPORT', 'EventSource is not available in this environment');
    }
    const es = makeEventSource(`${this.baseUrl}/api/v1/networks/${encodeURIComponent(networkId)}/events`);
    const handle = (event: { data?: unknown }): void => {
      if (typeof event?.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      onSnapshot(parsed as TopologySnapshot);
    };
    es.addEventListener('snapshot', handle);
    es.addEventListener('topology-updated', handle);
    return () => {
      es.close();
    };
  }
}
