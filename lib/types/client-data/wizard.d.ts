/**
 * Wizard UI pure logic (GW-10): route constants, wire types, the step
 * state machine, form validation and the derived lights — everything the
 * React components need that a test can drive without a DOM. Mirrors of
 * the host half's shapes (src/wizard/routes.ts / verify.ts /
 * proxy-snippets.ts) live HERE because the browser bundle cannot import
 * those modules (they transitively import node builtins through
 * config.ts); the check script cross-checks the snippet templates against
 * the host's so the two cannot drift.
 *
 * Validation mirrors src/config.ts's `hostOf` for the same reason — the
 * row layer applies the same rule when the fields land there, so a client
 * that accepts something the resolver would silently drop would only set
 * the user up for a mystery.
 *
 * MS-6 adds the paired-pool overview pieces: the pool count is a first-class
 * "configured" signal (MS-5 pairs straight into the pool store, not the
 * row), and {@link deriveClientOverviewSummary} derives the overview card's
 * counters and its two lights (connection health / pool fill) off the
 * `client/status` pool list.
 */
import type { ClientServerView, PeerSyncReadinessView } from './settings-form.ts';
/** Wizard route constants — mirror of src/wizard/routes.ts. */
export declare const WIZARD_STATUS_ROUTE = "/_dsh/zen-remote/admin/wizard/status";
export declare const WIZARD_VERIFY_ROUTE = "/_dsh/zen-remote/admin/wizard/verify";
export declare const WIZARD_CF_TOKEN_ROUTE = "/_dsh/zen-remote/admin/wizard/cf-token";
export declare const WIZARD_TUNNEL_TOKEN_ROUTE = "/_dsh/zen-remote/admin/wizard/tunnel-token";
export declare const WIZARD_CADDY_START_ROUTE = "/_dsh/zen-remote/admin/wizard/caddy/start";
export declare const WIZARD_CADDY_STOP_ROUTE = "/_dsh/zen-remote/admin/wizard/caddy/stop";
export declare const WIZARD_CADDY_STATUS_ROUTE = "/_dsh/zen-remote/admin/wizard/caddy/status";
export declare const WIZARD_TUNNEL_CHECK_ROUTE = "/_dsh/zen-remote/admin/wizard/tunnel/check-domain";
export declare const WIZARD_TUNNEL_SETUP_ROUTE = "/_dsh/zen-remote/admin/wizard/tunnel/setup";
export declare const WIZARD_TUNNEL_STOP_ROUTE = "/_dsh/zen-remote/admin/wizard/tunnel/stop";
export declare const WIZARD_TUNNEL_STATUS_ROUTE = "/_dsh/zen-remote/admin/wizard/tunnel/status";
/** Wire mirror of src/wizard/routes.ts's CaddyProcessState. */
export type CaddyState = 'running' | 'stopped' | 'never-started';
/** Wire mirror of src/wizard/tunnel-orchestrator.ts's results. */
export interface TunnelExisting {
    id: string;
    name: string;
    status: string;
}
export type TunnelSetupWire = {
    ok: true;
    tunnelId: string;
    publicUrl: string;
} | {
    ok: false;
    reason: string;
    detail?: string;
    existing?: TunnelExisting[];
};
export type TunnelCheckWire = {
    ok: true;
    onCloudflare: boolean;
    zoneId: string | null;
} | {
    ok: false;
    reason: string;
    detail?: string;
};
/** The tunnel setup failure's locale key (plus params). Pure. */
export declare function tunnelFailureCopy(reason: string, detail?: string): {
    key: string;
    params: Record<string, string>;
};
/** The domain check's copy (the migration card's re-check). Pure. */
export declare function tunnelCheckCopy(result: TunnelCheckWire): {
    key: string;
    tone: 'ok' | 'error';
};
/** Wire mirror of src/wizard/status.ts's WizardStatus. */
export interface WizardStatusBody {
    ok: true;
    mode: 'off' | 'caddy' | 'external' | 'cloudflared';
    domain: string;
    httpsPort: number;
    publicUrl: string;
    cfTokenConfigured: boolean;
    tunnelTokenConfigured: boolean;
    caddyRunning: boolean;
    cloudflaredRunning: boolean;
    gatewayActualPort: number | null;
    lanAddress?: string;
    lastHostProbe: {
        result: string;
        deviceId: string | null;
        at: number | null;
    } | null;
    lastExternalVerification: {
        result: string;
        deviceId: string | null;
        at: number | null;
    } | null;
    lastForwardedSource: {
        ip: string;
        at: number;
    } | null;
}
/** Wire mirror of src/wizard/verify.ts's poll result. */
export type WizardVerifyPoll = {
    result: 'not-started';
} | {
    result: 'stale';
} | {
    result: 'code-expired';
} | {
    result: 'pending';
} | {
    result: 'cookie-insecure';
    deviceId: string;
} | {
    result: 'pass';
    deviceId: string;
    at: number;
};
/** Wire mirror of src/wizard/verify.ts's start result. */
export type WizardVerifyStart = {
    ok: true;
    pairingCode: string;
    publicUrl: string;
    expiresAt: number;
} | {
    ok: false;
    reason: 'no-public-url' | 'bad-public-url' | 'runtime-not-ready' | 'gateway-unreachable' | 'probe-failed' | 'pair-refused';
    detail?: unknown;
};
/** The deployment role the unified wizard configures: server (`host`),
 * desktop sub-client (`client`) or peer node (`peer`, PG-9 — joins a device
 * network for two-way session access while keeping the phone-PWA half). */
export type WizardRole = 'host' | 'client' | 'peer';
/**
 * The row role a channel-config save writes (PG-9-fix): the phone-PWA
 * flows (Caddy / Cloudflare Tunnel / reverse proxy / LAN) run under
 * `wizardRole: 'host'`, and a peer that opened them from its lower PWA
 * section must keep its row role — writing `'host'` there would kick the
 * machine out of its virtual network. `keepPeerRole` is set exactly when
 * the user ENTERED the host-flow from a peer surface; a deliberate pick of
 * 「作为主服务端」 on the role cards clears it.
 */
export declare function targetHostSaveRole(keepPeerRole: boolean): 'host' | 'peer';
/** The three wizard steps: pick a path, fill its form, verify end to end. */
export type WizardStep = 'pick' | 'configure' | 'verify';
/** The four server-ingress paths (the three public ones plus LAN-only `'lan'`). */
export type WizardPath = 'caddy' | 'external' | 'cloudflared' | 'lan';
/** Where the wizard opens: a configured ingress jumps straight to verify. */
export declare function initialStep(status: WizardStatusBody | undefined): WizardStep;
/**
 * Whether the inline overview card should render the configured status
 * dashboard instead of the first-time setup prompt. MS-6: the paired pool's
 * size is the client's first-class signal — since MS-5 a claim lands in the
 * pool store and never touches the row's `serverUrl` / `deviceToken`, so a
 * freshly multi-paired machine with an empty row must still read as
 * configured. `> 0` answers true no matter what the other inputs say; the
 * field is optional and an omitted one (or a zero) changes nothing.
 */
export declare function isWizardConfigured(input: {
    effectiveClient: boolean;
    wizardStatus: WizardStatusBody | undefined;
    pairedDeviceCount: number;
    hasSavedHostConfig: boolean;
    tokenConfigured: boolean;
    clientServerUrl: string;
    clientState: string | undefined;
    pairedServerCount?: number;
    /** PG-9: the peer engine reports a joined network. True answers
     * configured no matter what the host/client signals say (a peer row has
     * neither a wizard ingress nor paired servers, yet its overview renders). */
    peerConfigured?: boolean;
}): boolean;
export interface WizardFormSeed {
    domain: string;
    httpsPort: string;
    serverUrl: string;
    path: WizardPath | undefined;
}
/**
 * The configure-form seed from one wizard status projection (GW-fix-3/M1):
 * the projection (wizard/status) is the ONLY surface that carries the
 * ingress fields — admin/status strips them by design, so the form must
 * seed from here. Empty values leave the form untouched.
 */
export declare function formSeedOf(status: WizardStatusBody | undefined): WizardFormSeed;
/**
 * The reverse-proxy snippet's upstream port: the gateway's ACTUAL port as
 * the wizard runtime reports it, falling back to the configured default
 * 3088 when no status has landed yet (GW-fix-3/M2).
 */
export declare function upstreamPortOf(status: WizardStatusBody | undefined): number;
/** The step AFTER pick, given the user's path choice. */
export declare function stepAfterPick(): WizardStep;
export declare function isValidHostname(value: string): boolean;
/** Port strings: [1, 65535]. */
export declare function isValidPort(value: string): boolean;
/** The public origin a verified domain+port answers on (443 hides the port). */
export declare function publicUrlFrom(domain: string, httpsPort: number): string;
/** Which configure form is complete enough to advance. */
export declare function configureReadiness(path: WizardPath, form: {
    domain: string;
    httpsPort: string;
    cfToken: string;
    serverUrl: string;
}): {
    ok: true;
    publicUrl: string;
    httpsPort: number;
} | {
    ok: false;
    error: 'bad-domain' | 'bad-port' | 'missing-token' | 'bad-server-url';
};
export type LightState = 'pass' | 'pending' | 'fail';
export interface WizardLights {
    /** The gateway child answers on this machine. */
    gateway: LightState;
    /** The public URL walks back to this gateway. */
    publicUrl: LightState;
    /** A phone actually paired through it. */
    pairing: LightState;
}
/**
 * The three progress lights, derived from the admin/status reachability
 * plus the verification poll result. Before a session is started the poll
 * answers `not-started`, which is a pending state — the public and pairing
 * lights stay amber (nothing has been tried, so red would just shout);
 * once started, an amber poll keeps them amber, a wrong-shape answer
 * (redirect, someone else's server) turns the public light red, and an
 * insecure cookie turns the pairing light red without ever passing.
 */
export declare function deriveWizardLights(input: {
    gatewayReachable: boolean;
    poll: WizardVerifyPoll | undefined;
    startResult?: WizardVerifyStart | undefined;
}): WizardLights;
export interface ClientWizardLights {
    /** Whether a desktop-client token is saved on this machine. */
    credential: LightState;
    /** Whether the client can reach and authenticate with the server. */
    connection: LightState;
    /** Whether the session-sync and plugin-bridge interceptors are active. */
    sync: LightState;
}
/** The overview card's derived counters and lights (MS-6): the 第 3 格
 * 「连接状态」 shows `M / N 台在线` with {@link WizardOverviewSummary.connectionLight}
 * summarizing the pool's health, and the 第 4 格 「已配对服务端」 shows
 * `已配对 N / maxServers 台` with {@link WizardOverviewSummary.serversLight}
 * turning red exactly at the cap. Input is the DERIVED pool list
 * ({@link ClientServerView} — the view vocabulary's state words), in pairing
 * order; order never matters to the counts. */
export interface WizardOverviewSummary {
    totalCount: number;
    onlineCount: number;
    /** Everything that is neither connected nor revoked (unreachable,
     * unexpected, incompatible, invalid-url, …). */
    offlineCount: number;
    revokedCount: number;
    maxServers: number;
    limitReached: boolean;
    connectionLight: LightState;
    serversLight: LightState;
}
/**
 * Derive the sub-client overview summary off one derived pool list: green
 * only when EVERY paired server is connected; red when any server is in a
 * state that will not recover on its own (revoked / incompatible /
 * invalid-url) or when the pool is FULL — the cap is a servers fact, so a
 * full pool of healthy connections still shows a red servers light while its
 * connection light stays green; amber for the rest (nothing paired yet, or
 * servers the retry ladder is still working on).
 */
export declare function deriveClientOverviewSummary(servers: readonly ClientServerView[], maxServers?: number): WizardOverviewSummary;
/**
 * Derive the three status lights for the desktop sub-client verification
 * step (`role === 'client'`).
 */
export declare function deriveClientWizardLights(input: {
    tokenConfigured: boolean;
    clientState: string | undefined;
    interceptInstalled?: boolean | undefined;
}): ClientWizardLights;
/**
 * The wizard step-3's three lights for ONE selected paired server (MS-8):
 * the credential is green by the row's own existence (the token lives in the
 * pool store, never in the row) and red only when the server refused it
 * (`revoked`); the connection follows the same fail-set the global lights
 * use (an offline server mid-retry is red here too — the step is staring at
 * THAT one server, not the pool); sync is green on a connected row whose
 * interface groups all match, red on a compat mismatch, amber otherwise.
 * `undefined` (nothing paired, or nothing selected yet) keeps all three
 * amber.
 */
export declare function deriveClientServerLights(server: ClientServerView | undefined): ClientWizardLights;
/**
 * One network device's connection path, in the VIEW vocabulary the peer
 * status route answers: the three usable paths (`lan` 局域网直连 / `p2p`
 * 直连 / `relay` 经网关中转), a locally blocked identity (`mismatch` — the
 * device's public key moved under the same node id) and `offline` (not
 * connected right now, or locally ignored).
 */
export type PeerDevicePath = 'lan' | 'p2p' | 'relay' | 'mismatch' | 'offline';
/** One row of the peer status body's `peers` (PG-9). */
export interface PeerDeviceView {
    nodeId: string;
    name: string;
    mounted: boolean;
    path: PeerDevicePath;
    /** Round-trip time of the current path in ms; `null` when not connected. */
    rttMs: number | null;
}
/**
 * The peer/status body's mount-capacity facts, verbatim from the
 * `derivePeerStatusView` view's PC-11a fields (the wizard and the settings
 * section both hand these over). Any field left out — or `undefined` — means
 * that fact is UNKNOWN downstream; nothing here guesses a default. Two
 * vocabularies that must never be conflated: `maxPeers` is the RAW network
 * device cap INCLUDING this machine, while `maxServers` is this machine's
 * EFFECTIVE remote-mount cap, and `mountedCount` counts this machine's
 * mounted remotes — never the discovered rows (`peers.length`) and never
 * the network's occupied seats.
 */
export interface PeerCapacityFacts {
    /** This machine's effective remote-mount cap (undefined = unknown). */
    maxServers?: number | undefined;
    /** This machine's actually mounted remotes (undefined = unknown). */
    mountedCount?: number | undefined;
    /** `mountedCount >= maxServers` once BOTH are known; undefined otherwise. */
    limitReached?: boolean | undefined;
    /** The network's raw device cap including this node (undefined = unknown). */
    maxPeers?: number | undefined;
}
/** The peer node's overview counters and two lights (PG-9): the 第 3 格
 * 「直连 / 中转连接」 summarizes the usable paths, the 第 4 格 「网内设备」
 * shows 本机已挂载 N / M 台远端设备 with {@link PeerOverviewSummary.devicesLight}
 * turning red exactly at the LOCAL mount cap (满额, PC-11a's tri-state) or
 * on a locally blocked identity — amber while the capacity facts are unknown
 * (an old body), never green on a guess. */
export interface PeerOverviewSummary {
    totalCount: number;
    /** `lan` + `p2p` — the devices whose sessions flow without the gateway. */
    directCount: number;
    /** `relay` — reachable, but every frame rides the gateway. */
    relayCount: number;
    /** Locally blocked identities awaiting the 信任新身份 decision. */
    mismatchCount: number;
    offlineCount: number;
    /** PC-11a: this machine's mounted remotes, verbatim from the body — NOT
     * the discovered count and never derived from the rows here (unknown
     * stays unknown). */
    mountedCount: number | undefined;
    /** PC-11a: this machine's effective mount cap (undefined = unknown). */
    maxServers: number | undefined;
    /** The network's raw device cap including this node (undefined =
     * unknown). Annotation-only: the mount display never divides by it. */
    maxPeers: number | undefined;
    /** PC-11a tri-state: `true` at (or over) the local mount cap — an
     * over-cap stock after a downscale stays `true` with the count shown
     * unclamped — and `undefined` while the cap or the count is unknown
     * (`false` would claim room that may not exist). */
    limitReached: boolean | undefined;
    connectionLight: LightState;
    devicesLight: LightState;
}
/**
 * Derive the peer overview summary off the status route's device rows
 * ({@link PeerDeviceView}) and the body's capacity facts
 * ({@link PeerCapacityFacts}): the connection light is green when every
 * device is on a usable path, red the moment one locally blocked identity
 * waits for a trust decision, amber otherwise (empty network, all offline);
 * the device light follows the LOCAL mount cap — red exactly when
 * `limitReached` is true, amber while it is unknown — and shares the
 * mismatch red. The capacity facts pass through verbatim; when the flag is
 * missing but both counts are known it is re-derived by the PC-11a
 * definition (`mountedCount >= maxServers`), so a caller that carries the
 * raw numbers cannot disagree with the route's own verdict.
 */
export declare function derivePeerOverviewSummary(peers: readonly PeerDeviceView[], capacity?: PeerCapacityFacts, options?: {
    includeSelf?: boolean;
}): PeerOverviewSummary;
/** The third light's copy vocabulary (PC-14a) — exactly the locale keys the
 * derived verdicts may render, kept as a literal union so the component's
 * typed `t` accepts it and a typo fails the build instead of rendering
 * #MISSING. Every key here exists in BOTH dictionaries. */
export type PeerDiscoveryCopyKey = 'wizard.peer.syncReady' | 'wizard.peer.syncWaitingPeers' | 'wizard.peer.syncIgnored' | 'wizard.peer.syncPartialReady' | 'wizard.peer.syncBlocked' | 'wizard.peer.syncNotMounted' | 'wizard.peer.syncNotOnline' | 'wizard.peer.syncGatewayHold' | 'wizard.peer.syncUnknown' | 'wizard.peer.notJoined';
/** The third peer wizard light's verdict (PC-14a): the light word plus the
 * locale key (and its params) the rendered state line reads from — the
 * copy explains WHY the light is what it is, derived once here so the
 * component only renders. */
export interface PeerDiscoveryLightView {
    light: LightState;
    copyKey: PeerDiscoveryCopyKey;
    copyParams?: Record<string, string>;
}
/**
 * The third peer wizard light (设备发现与会话同步) off the body's OWN sync
 * facts (PC-14a): `ready` under an authorized gateway is the ONLY green —
 * never a non-empty peers list, a lan path or a mounted count. `partial` is
 * honestly pending (its KNOWN ready/candidate counts ride the copy; unknown
 * counts never guess 0); a blocked identity — and any locally known
 * mismatch, which is a LOCAL fact that survives even an old body — is red;
 * everything else is amber. An old body without the sync block (or with an
 * unknown state word) reads the explicit UNKNOWN copy: the decided fallback,
 * never "peers non-empty is green". The copy speaks of handshakes completed
 * and syncing MAY START — never that any concrete session data has finished
 * synchronizing.
 */
export declare function derivePeerDiscoveryLight(input: {
    gatewayState: string;
    mismatchCount: number;
    sync?: PeerSyncReadinessView | undefined;
}): PeerDiscoveryLightView;
/** The peer node's three wizard lights (PG-9 + PC-14a): ① 本机身份已就绪,
 * ② 网络准入状态 (authorized green, pending-approval amber — the
 * 「等待网络管理员批准」copy), ③ 设备发现与会话同步 — the third light reads
 * the body's sync facts through {@link derivePeerDiscoveryLight}; without
 * them (an old body) it stays pending with the explicit unknown copy. */
export interface PeerWizardLights {
    identity: LightState;
    admission: LightState;
    discovery: LightState;
}
/**
 * Derive the peer node's three lights off the peer status facts: identity is
 * green once the engine reports a node id (red on `identity-error`, amber
 * otherwise while the engine is not wired); admission maps the gateway state
 * (green `authorized`, amber `pending-approval` / `connecting` / `offline` /
 * unconfigured, red `mismatch` / `revoked` / `paused` / `identity-error`);
 * discovery follows the sync facts per {@link derivePeerDiscoveryLight}.
 */
export declare function derivePeerWizardLights(input: {
    identityReady: boolean;
    gatewayState: string;
    mismatchCount: number;
    sync?: PeerSyncReadinessView | undefined;
}): PeerWizardLights;
/**
 * PC-15: assembles a full `zr-net…://` invite from the wizard's advanced
 * split-fill (gateway address + 16-hex network ID + optional passphrase) so
 * the join flow can reuse the EXISTING invite branch unchanged.
 *
 * This module rides in the browser bundle, so it CANNOT import
 * src/peer/crypto.ts (node:crypto). Everything below is a hand mirror of
 * that module's parsing rules — `parseGatewayJoinInput` for the address
 * grammar and scheme handling, `parseInviteAuthority` for host[:port],
 * `isLoopbackOrPrivateHostname` for the private/public inference, and
 * `buildKeylessInviteUri`'s scheme table — with
 * `scripts/check-wizard-ui.mjs` round-tripping positive samples through the
 * REAL parser so the two cannot drift. No cryptography is duplicated: the
 * join key is opaque text, percent-encoded and decoded by the existing
 * parser on the consuming side.
 */
export type PeerAdvancedJoinError = 'bad-adv-gateway' | 'bad-adv-network-id' | 'bad-adv-join-key';
/**
 * Assemble the invite. The network ID is normalized to lowercase (the same
 * normalization parseInviteUri applies); the passphrase rides verbatim — no
 * trimming, every typed character is meaningful, and the empty string means
 * NO key (the byte-equivalent of the route's own keyless manual-approval
 * invite). A malformed part is refused locally; the caller never sends it.
 */
export declare function assemblePeerInviteUri(input: {
    gatewayAddress: string;
    networkId: string;
    joinKey?: string;
}): {
    ok: true;
    inviteUri: string;
} | {
    ok: false;
    error: PeerAdvancedJoinError;
};
/** Pairing-code countdown, whole seconds, never negative. */
export declare function pairingSecondsLeft(expiresAt: number, now: number): number;
/**
 * The managed-Caddy start-failure copy: maps the wire error code to a
 * locale key (+params / manual-install link). Pure — the check script pins
 * every mapping.
 */
export declare function caddyFailureCopy(error: string, detail?: string, installUrl?: string): {
    key: string;
    params: Record<string, string>;
    installUrl?: string;
};
export interface SnippetInput {
    domain: string;
    upstreamHost: string;
    upstreamPort: number;
    lang?: 'zh' | 'en' | undefined;
}
export declare function nginxSnippetText(input: SnippetInput): string | null;
export declare function caddySnippetText(input: SnippetInput): string | null;
/** The Lucky steps (mirror of proxy-snippets.ts luckySteps). */
export declare function luckyStepTexts(input: SnippetInput): string[] | null;
/** The snippet kinds the reverse-proxy card tabs over, in tab order. */
export declare const SNIPPET_KINDS: readonly ["nginx", "caddy", "lucky"];
export type SnippetKind = (typeof SNIPPET_KINDS)[number];
//# sourceMappingURL=wizard.d.ts.map