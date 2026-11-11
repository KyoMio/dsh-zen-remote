// 控制台中英双语词典（PG-6a）。纯数据 + 纯函数，零 DOM 依赖：
// 后端 tsc 把它编译进 dist/web/（测试直接 import），浏览器半边经 tsconfig.web.json
// 类型检查，两边共享同一份实现。
//
// 「说人话」规范：zh 词条是界面文案的唯一事实来源。概览首屏严禁出现
// LAN / P2P / RELAY / NAT / TOFU / E2EE / Ed25519 / joinKey 等技术缩写，
// 对应的白话词条见 path.* / identity.*（如 path.lan = 局域网直连）。
// test/web-store.test.mjs 钉住 zh/en 键 100% 对称与黑话扫描。

export type Locale = 'zh' | 'en';

export type LocaleKey = keyof typeof ZH;

export type TranslateVars = Record<string, string | number>;

/** 组件持有的已绑定语言的取词函数 */
export type TranslateFn = (key: LocaleKey, vars?: TranslateVars) => string;

/** localStorage 里持久化语言选择的键 */
export const LOCALE_STORAGE_KEY = 'zen-remote-console.locale';

export const ZH = {
  'app.title': 'Zen Remote 网关',
  'app.loading': '加载中…',
  'view.networks': '网络管理',
  'view.admin': '网关管理',

  'nav.networks': '网络',

  'network.name': '名称',
  'network.devices': '设备',
  'network.deviceLimit': '设备上限',
  'network.inviteLink': '邀请链接',
  'network.rotateInviteLink': '重置邀请链接',
  'network.joinRequests': '加入申请',
  'network.createNew': '新建网络…',

  'summary.onlineDevices': '在线设备',

  'identity.verified': '身份已验证',
  'identity.mismatch': '身份异常 / 身份变了',

  'path.lan': '局域网直连',
  'path.direct': '直连',
  'path.relay': '经网关中转',

  'status.online': '在线',
  'status.offline': '离线',
  'status.pending': '待审批',
  'status.paused': '已暂停',
  'status.mismatch': '身份变了',
  'status.revoked': '已移除',

  'admin.allowSignup': '开放注册',
  'admin.perDeviceRelayLimit': '单台设备中转限速',

  'auth.login': '登录',
  'auth.signup': '注册',
  'auth.email': '邮箱',
  'auth.emailPlaceholder': 'you@example.com',
  'auth.password': '密码',
  'auth.signupQuotaHint': '注册后最多可以创建 {n} 个网络',

  'account.role.admin': '管理员',
  'account.role.user': '普通用户',
  'account.logout': '退出登录',
  'account.darkMode': '深色模式',
  'account.on': '开',
  'account.off': '关',
  'account.language': 'English / 中文',

  'error.invalidCredentials': '邮箱或密码不对',
  'error.accountDisabled': '该账号已被停用',
  'error.signupDisabled': '这个网关没有开放注册',
  'error.emailTaken': '这个邮箱已经注册过了',
  'error.generic': '出了点问题，请稍后重试',
  'error.network': '连不上网关，请稍后再试',

  // ---- PG-6b：通用按钮 ----
  'common.cancel': '取消',
  'common.done': '完成',
  'common.create': '创建',
  'common.copy': '复制',
  'common.remove': '移除',
  'common.confirmRemove': '确认移除',
  'common.reset': '重置',
  'common.confirmReset': '确认重置',
  'common.delete': '删除',
  'common.confirmDelete': '确认删除',

  // ---- PG-6b：网络概览与设置 ----
  'network.settings': '设置',
  'network.deviceCount': '{count} / {max} 台设备',
  'network.capacityFull': '· 已满',
  'network.inviteHint': '在新设备的 zen-remote 里粘贴这个链接即可加入',
  'network.rotateHint': '旧链接立即失效，已加入的设备不受影响',
  'network.deleteHint': '所有设备会立即断开，无法恢复',
  'network.settingsTitle': '网络设置',
  'network.newNetworkTitle': '新建网络',
  'network.namePlaceholder': '例如：家里',
  'network.admissionMode': '加入方式',
  'network.admissionBoth': '有链接自动加入，其他需要我批准',
  'network.admissionKey': '有链接即可加入',
  'network.admissionManual': '每台都需要我批准',
  'network.dangerZone': '危险操作',
  'network.deleteNetwork': '删除网络',
  'network.emptyTitle': '还没有网络',
  'network.emptyHint': '用顶栏的「新建网络…」创建第一个网络',

  // ---- PG-6b：概览三格 ----
  'overview.actionNeeded': '需要处理',
  'overview.requestsEmpty': '暂无申请',
  'overview.requestsEmptyHint': '新设备申请加入时会出现在这里',
  'overview.gatewayRelay': '网关中转',
  'overview.connections': '{total} 条连接中 {direct} 条直连',
  'overview.e2eeNote': '内容端到端加密，网关无法查看',

  // ---- PG-6b：加入申请 / 身份异常 ----
  'requests.identityChanged': '{name} 的身份变了',
  'requests.identityChangedHint': '这台设备重新安装或换了钥匙。确认是同一台设备后可以信任新身份。',
  'requests.trustNewIdentity': '信任新身份',
  'requests.approve': '✓ 批准',
  'requests.reject': '拒绝',
  'requests.fullHint': '设备数已达上限，先在设置里调高设备上限',

  // ---- PG-6b：设备列表与详情 ----
  'devices.back': '全部设备',
  'devices.unnamed': '未命名设备',
  'devices.clickHint': '点击设备，查看它和其他设备怎么连接',
  'devices.empty': '还没有设备加入',
  'devices.emptyBody': '在装了 dsh-zen-remote 的电脑上，把角色设为「节点端」，粘贴上面的邀请链接。',
  'devices.emptyHint': '设备入网后会显示在这里',
  'devices.directCount': '直连 {n}',
  'devices.relayCount': '中转 {n}',
  'devices.latency': '延迟',
  'devices.path': '连接方式',
  'devices.reason': '原因',
  'devices.status': '状态',
  'devices.connections': '连接',
  'devices.pause': '暂停',
  'devices.resume': '恢复',
  'devices.deviceId': '设备 ID',
  'devices.publicAddr': '公网地址',
  'devices.networkType': '网络类型',
  'devices.totalRelay': '累计中转',
  'devices.connectionsTitle': '到其他设备的连接',

  // ---- PG-6b：连接方式与平实原因 ----
  'device.blocked': '已阻断',
  'device.blockedReasonPaused': '设备已被暂停，连接已断开',
  'device.blockedReasonRevoked': '设备已被移出网络',
  'device.notConnected': '未连接',
  'device.notConnectedOffline': '设备当前离线',
  'device.notConnectedPending': '设备还没有获准加入',
  'device.notConnectedIdle': '还没有建立连接',
  'device.reasonLan': '在同一个局域网内',
  'device.reasonDirect': '已打通直连，不经过网关',
  'device.reasonRelay': '这台设备/对方网络不支持直连，已自动中转 · {rate}',
  'device.reasonRelaySelf': '这台设备的网络不支持直连，已自动中转 · {rate}',
  'device.reasonRelayPeer': '对方网络不支持直连，已自动中转 · {rate}',
  'device.reasonMismatchBlocked': '身份异常，连接已阻断',
  'device.reasonPeerPaused': '对方已暂停',

  // ---- PG-6b：网络类型（说人话） ----
  'nat.cone': '常规网络',
  'nat.symmetric': '对称型（无法直连）',
  'nat.public': '公网直连',
  'nat.unknown': '未知',

  // ---- PG-6b：相对时间 ----
  'time.justNow': '刚刚',
  'time.minutesAgo': '{n} 分钟前',
  'time.hoursAgo': '{n} 小时前',
  'time.daysAgo': '{n} 天前',

  // ---- PG-6b：网关管理 ----
  'admin.statusOk': '运行正常',
  'admin.onlineCount': '{n} 台设备在线',
  'admin.currentRelay': '当前中转 {rate}',
  'admin.registrationQuota': '注册与配额',
  'admin.maxNetworks': '每人最多网络数',
  'admin.defaultMaxPeers': '新网络默认设备上限',
  'admin.relayDirectHint': '直连不受限',
  'admin.columnUser': '账号',
  'admin.columnRole': '角色',
  'admin.columnNetworks': '网络',
  'admin.columnOnline': '在线设备',
  'admin.columnRelay': '当前中转',
  'admin.columnActions': '操作',
  'admin.disable': '停用',
  'admin.confirmDisable': '确认停用',
  'admin.enable': '启用',
  'admin.disabledTag': '已停用',

  // ---- PG-6b：底部提示条 ----
  'toast.inviteCopied': '已复制邀请链接',
  'toast.inviteReset': '邀请链接已重置',
  'toast.saved': '已保存',
  'toast.networkDeleted': '网络已删除',
  'toast.copyFailed': '复制失败，请手动选中链接复制',
} as const;

export const EN: Record<LocaleKey, string> = {
  'app.title': 'Zen Remote Gateway',
  'app.loading': 'Loading…',
  'view.networks': 'Networks',
  'view.admin': 'Gateway admin',

  'nav.networks': 'Networks',

  'network.name': 'Name',
  'network.devices': 'Devices',
  'network.deviceLimit': 'Device limit',
  'network.inviteLink': 'Invite link',
  'network.rotateInviteLink': 'Reset invite link',
  'network.joinRequests': 'Join requests',
  'network.createNew': 'New network…',

  'summary.onlineDevices': 'Online devices',

  'identity.verified': 'Identity verified',
  'identity.mismatch': 'Identity changed',

  'path.lan': 'Direct on local network',
  'path.direct': 'Direct connection',
  'path.relay': 'Relayed through gateway',

  'status.online': 'Online',
  'status.offline': 'Offline',
  'status.pending': 'Pending',
  'status.paused': 'Paused',
  'status.mismatch': 'Identity changed',
  'status.revoked': 'Removed',

  'admin.allowSignup': 'Open signup',
  'admin.perDeviceRelayLimit': 'Per-device relay speed limit',

  'auth.login': 'Sign in',
  'auth.signup': 'Sign up',
  'auth.email': 'Email',
  'auth.emailPlaceholder': 'you@example.com',
  'auth.password': 'Password',
  'auth.signupQuotaHint': 'After signing up you can create up to {n} networks',

  'account.role.admin': 'Administrator',
  'account.role.user': 'Member',
  'account.logout': 'Sign out',
  'account.darkMode': 'Dark mode',
  'account.on': 'On',
  'account.off': 'Off',
  'account.language': 'English / 中文',

  'error.invalidCredentials': 'Wrong email or password',
  'error.accountDisabled': 'This account has been disabled',
  'error.signupDisabled': 'Signup is disabled on this gateway',
  'error.emailTaken': 'That email is already registered',
  'error.generic': 'Something went wrong, please retry',
  'error.network': 'Cannot reach the gateway, please retry',

  'common.cancel': 'Cancel',
  'common.done': 'Done',
  'common.create': 'Create',
  'common.copy': 'Copy',
  'common.remove': 'Remove',
  'common.confirmRemove': 'Confirm removal',
  'common.reset': 'Reset',
  'common.confirmReset': 'Confirm reset',
  'common.delete': 'Delete',
  'common.confirmDelete': 'Confirm delete',

  'network.settings': 'Settings',
  'network.deviceCount': '{count} / {max} devices',
  'network.capacityFull': '· Full',
  'network.inviteHint': 'Paste this link into zen-remote on a new device to join',
  'network.rotateHint': 'The old link stops working immediately; already joined devices are not affected',
  'network.deleteHint': 'All devices disconnect immediately; this cannot be undone',
  'network.settingsTitle': 'Network settings',
  'network.newNetworkTitle': 'New network',
  'network.namePlaceholder': 'e.g. Home',
  'network.admissionMode': 'How devices join',
  'network.admissionBoth': 'Anyone with the link joins automatically, others need my approval',
  'network.admissionKey': 'Anyone with the link can join',
  'network.admissionManual': 'Every device needs my approval',
  'network.dangerZone': 'Danger zone',
  'network.deleteNetwork': 'Delete network',
  'network.emptyTitle': 'No networks yet',
  'network.emptyHint': 'Create your first network from the top bar',

  'overview.actionNeeded': 'Needs attention',
  'overview.requestsEmpty': 'No pending requests',
  'overview.requestsEmptyHint': 'New device requests will appear here',
  'overview.gatewayRelay': 'Gateway relay',
  'overview.connections': '{direct} of {total} connections are direct',
  'overview.e2eeNote': 'Content is end-to-end encrypted; the gateway cannot read it',

  'requests.identityChanged': '{name} changed its identity',
  'requests.identityChangedHint': 'The device was reinstalled or has new keys. If it is really the same device, trust the new identity.',
  'requests.trustNewIdentity': 'Trust new identity',
  'requests.approve': '✓ Approve',
  'requests.reject': 'Reject',
  'requests.fullHint': 'Device limit reached; raise the limit in settings first',

  'devices.back': 'All devices',
  'devices.unnamed': 'Unnamed device',
  'devices.clickHint': 'Click a device to see how it connects to others',
  'devices.empty': 'No devices have joined yet',
  'devices.emptyBody': 'On a computer with dsh-zen-remote installed, set the role to node and paste the invite link above.',
  'devices.emptyHint': 'Devices will appear here after they join',
  'devices.directCount': 'Direct {n}',
  'devices.relayCount': 'Relayed {n}',
  'devices.latency': 'Latency',
  'devices.path': 'Path',
  'devices.reason': 'Reason',
  'devices.status': 'Status',
  'devices.connections': 'Connections',
  'devices.pause': 'Pause',
  'devices.resume': 'Resume',
  'devices.deviceId': 'Device ID',
  'devices.publicAddr': 'Public address',
  'devices.networkType': 'Network type',
  'devices.totalRelay': 'Total relayed',
  'devices.connectionsTitle': 'Connections to other devices',

  'device.blocked': 'Blocked',
  'device.blockedReasonPaused': 'The device is paused; its connection is closed',
  'device.blockedReasonRevoked': 'The device has been removed from the network',
  'device.notConnected': 'Not connected',
  'device.notConnectedOffline': 'The device is offline right now',
  'device.notConnectedPending': 'The device has not been approved yet',
  'device.notConnectedIdle': 'No connection has been established yet',
  'device.reasonLan': 'On the same local network',
  'device.reasonDirect': 'Direct connection established; no gateway involved',
  'device.reasonRelay': 'Either side cannot connect directly, so traffic is relayed · {rate}',
  'device.reasonRelaySelf': "This device's network does not support direct connections, so traffic is relayed · {rate}",
  'device.reasonRelayPeer': "The other device's network does not support direct connections, so traffic is relayed · {rate}",
  'device.reasonMismatchBlocked': 'Identity changed, connection blocked',
  'device.reasonPeerPaused': 'The other device is paused',

  'nat.cone': 'Regular network',
  'nat.symmetric': 'Symmetric (no direct path)',
  'nat.public': 'Direct on public network',
  'nat.unknown': 'Unknown',

  'time.justNow': 'just now',
  'time.minutesAgo': '{n} min ago',
  'time.hoursAgo': '{n} h ago',
  'time.daysAgo': '{n} d ago',

  'admin.statusOk': 'Running normally',
  'admin.onlineCount': '{n} devices online',
  'admin.currentRelay': 'Current relay {rate}',
  'admin.registrationQuota': 'Registration & quotas',
  'admin.maxNetworks': 'Max networks per user',
  'admin.defaultMaxPeers': 'Default device limit for new networks',
  'admin.relayDirectHint': 'Direct connections are not limited',
  'admin.columnUser': 'Account',
  'admin.columnRole': 'Role',
  'admin.columnNetworks': 'Networks',
  'admin.columnOnline': 'Online devices',
  'admin.columnRelay': 'Current relay',
  'admin.columnActions': 'Actions',
  'admin.disable': 'Disable',
  'admin.confirmDisable': 'Confirm disable',
  'admin.enable': 'Enable',
  'admin.disabledTag': 'Disabled',

  'toast.inviteCopied': 'Invite link copied',
  'toast.inviteReset': 'Invite link has been reset',
  'toast.saved': 'Saved',
  'toast.networkDeleted': 'Network deleted',
  'toast.copyFailed': 'Copy failed; please copy the link manually',
};

export const LOCALES: Record<Locale, Record<LocaleKey, string>> = { zh: ZH, en: EN };

/** 语言标签 → 界面语言：zh* 归 zh，en* 归 en，其余回落 zh */
export function pickLocale(languageTag: string): Locale {
  const tag = languageTag.toLowerCase();
  if (tag.startsWith('zh')) return 'zh';
  if (tag.startsWith('en')) return 'en';
  return 'zh';
}

/** 持久化选择优先；未设置或值无效时按浏览器语言识别 */
export function resolveLocale(stored: unknown, navigatorLanguage: string): Locale {
  if (stored === 'zh' || stored === 'en') return stored;
  return pickLocale(navigatorLanguage);
}

/** 取词条并做 {name} 插值；键不存在直接抛错（TS 类型已挡住绝大多数拼写错误） */
export function translate(locale: Locale, key: LocaleKey, vars?: TranslateVars): string {
  const raw = (LOCALES[locale] as Record<string, string | undefined>)[key];
  if (raw === undefined) throw new Error(`missing translation key: ${String(key)}`);
  if (vars === undefined) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}
