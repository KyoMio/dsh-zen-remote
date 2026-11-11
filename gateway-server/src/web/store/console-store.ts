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

// ---------------------------------------------------------------- 数据形态（镜像服务端）

export type UserRole = 'admin' | 'user';

export interface PublicUser {
  id: string;
  email: string;
  role: UserRole;
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
  onlineDevices: number;
  totalDevices: number;
  pendingCount: number;
}

export type MemberStatus = 'pending' | 'authorized' | 'paused' | 'mismatch' | 'revoked';
export type NatType = 'cone' | 'symmetric' | 'public' | 'unknown';

/** GET /networks/:id/topology 与 SSE 共用的完整快照（镜像服务端 NetworkTopologySnapshot） */
export interface TopologySnapshot {
  network: { id: string; name: string; admissionMode: AdmissionMode; maxPeers: number };
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
  liveRelayKbps: number;
  cumulativeRelayBytes: number;
  /** 最后一次遥测/入网落库时间；从未上报过为 null（界面显示「刚刚」） */
  lastSeenAt: string | null;
}

export interface TopologyLink {
  srcNodeId: string;
  peerNodeId: string;
  path: string;
  rttMs: number;
  liveRelayKbps: number;
}

export type MemberAction = 'approve' | 'reject' | 'pause' | 'resume' | 'repin';

export interface SystemSettings {
  allowSignup: boolean;
  maxNetworksPerUser: number;
  defaultMaxPeers: number;
  relayRateKbps: number;
}

export interface AdminUserRow {
  id: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  networkCount: number;
  onlineDevices: number;
  relayKbps: number;
}

/** GET /auth/me 的返回（登录态二选一） */
export type MeResult =
  | { authenticated: true; user: PublicUser; allowSignup: boolean; maxNetworksPerUser: number }
  | { authenticated: false; allowSignup: boolean; maxNetworksPerUser: number };

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

export interface ConsoleState {
  /** 启动期 /auth/me 未回来前是 loading */
  boot: 'loading' | 'ready';
  session: SessionSlice | null;
  meta: SessionMeta;
  networks: NetworkView[];
  topology: Readonly<Record<string, TopologySnapshot>>;
  /** 网关管理页数据（仅管理员拉取）；settings 未拉到前是 null */
  adminSettings: SystemSettings | null;
  adminUsers: AdminUserRow[];
  ui: UiLocalState;
}

export function createInitialState(): ConsoleState {
  return {
    boot: 'loading',
    session: null,
    meta: { allowSignup: false, maxNetworksPerUser: 3 },
    networks: [],
    topology: {},
    adminSettings: null,
    adminUsers: [],
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

/** 退出登录：清空 session 与全部业务数据切片（隐私），保留 ui 与 meta（表单草稿不丢） */
export function setLoggedOut(state: ConsoleState, meta: SessionMeta): ConsoleState {
  return {
    ...state,
    session: null,
    meta,
    networks: [],
    topology: {},
    adminSettings: null,
    adminUsers: [],
  };
}

/** 管理员设置整体刷新（PATCH 成功后用返回值替换） */
export function applyAdminSettings(state: ConsoleState, settings: SystemSettings): ConsoleState {
  return { ...state, adminSettings: settings };
}

/** 管理员用户列表整体刷新 */
export function applyAdminUsers(state: ConsoleState, users: AdminUserRow[]): ConsoleState {
  return { ...state, adminUsers: users };
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

  /** 启动期 /auth/me 回来后的就绪动作：写 meta 与 session，未登录顺手清数据 */
  init(me: MeResult): void {
    const meta: SessionMeta = { allowSignup: me.allowSignup, maxNetworksPerUser: me.maxNetworksPerUser };
    if (me.authenticated) {
      this.setState({ ...applySession(this.state, me.user, meta), boot: 'ready' });
    } else {
      this.setState({ ...setLoggedOut(this.state, meta), boot: 'ready' });
    }
  }

  readonly setSession = (user: PublicUser, meta: SessionMeta): void => {
    this.setState(applySession(this.state, user, meta));
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

  readonly applyAdminSettings = (settings: SystemSettings): void => {
    this.setState(applyAdminSettings(this.state, settings));
  };

  readonly applyAdminUsers = (users: AdminUserRow[]): void => {
    this.setState(applyAdminUsers(this.state, users));
  };

  readonly patchUi = (patch: Partial<UiLocalState>): void => {
    this.setState(patchUiState(this.state, patch));
  };
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
  init?: { method?: string; headers?: Record<string, string>; body?: string },
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
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

  async login(email: string, password: string): Promise<{ user: PublicUser; allowSignup: boolean; maxNetworksPerUser: number }> {
    return this.request('POST', '/api/v1/auth/login', { email: normalizeEmail(email), password });
  }

  async signup(email: string, password: string): Promise<{ user: PublicUser; allowSignup: boolean; maxNetworksPerUser: number }> {
    return this.request('POST', '/api/v1/auth/signup', { email: normalizeEmail(email), password });
  }

  async logout(): Promise<void> {
    await this.request('POST', '/api/v1/auth/logout');
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

  async adminGetSettings(): Promise<SystemSettings> {
    return this.request('GET', '/api/v1/admin/settings');
  }

  async adminPatchSettings(patch: Partial<SystemSettings>): Promise<SystemSettings> {
    return this.request('PATCH', '/api/v1/admin/settings', patch);
  }

  async adminListUsers(): Promise<AdminUserRow[]> {
    return this.request('GET', '/api/v1/admin/users');
  }

  async adminSetUserActive(userId: string, active: boolean): Promise<void> {
    await this.request('PATCH', `/api/v1/admin/users/${encodeURIComponent(userId)}`, { active });
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
