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
import type { ClientServerView } from './settings-form.ts';
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
/** The deployment role the unified wizard configures: server (`host`) or
 * desktop sub-client (`client`). */
export type WizardRole = 'host' | 'client';
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