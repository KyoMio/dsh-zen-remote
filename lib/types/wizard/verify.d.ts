/**
 * Final-verification orchestration (GW-9): the wizard's last mile, where
 * 「完成」 means a real phone really paired through the real public URL —
 * never a green light from internal checks alone (设计: 不做已联通的假绿灯).
 *
 * The flow, spread over two entry points the UI drives:
 *
 *   start({ publicUrl }): runtime ready? → walk the public URL
 *   (GW-8's probe; BOTH the pairing page and the admin-403 shape must be
 *   right) → snapshot the gateway's device ids (the baseline) → mint a WEB
 *   pairing code → remember the session IN MEMORY and answer with the
 *   code, the URL and the expiry. The code never touches the row config,
 *   and minting it restarts nothing — trustedProxies changes are what
 *   restart the gateway, and any such change invalidates the session
 *   instead (the config fingerprint below).
 *
 *   check(): re-read the gateway status. A device id the baseline did not
 *   have is a freshly paired phone; the gateway's lastWebClaim record must
 *   name THAT device with secure === true (the proxy passed
 *   X-Forwarded-Proto: https through, so the issued cookie carries the
 *   Secure flag). All green → pass. The claim recorded an insecure cookie →
 *   cookie-insecure. Past the code's expiry → code-expired. Anything else →
 *   pending, keep polling.
 *
 * The session binds to a CONFIG FINGERPRINT (ingressMode, domain,
 * httpsPort, publicUrl, the gateway's ACTUAL port, host, trustedProxies):
 * any of those moving between start and check answers stale and discards
 * the session, because the verification proved a URL that no longer exists.
 * The session is deliberately memory-only — a row reload (which a
 * trustedProxies change causes) builds a fresh manager and the session is
 * gone, exactly the same verdict the fingerprint would have produced.
 */
import type { ZenRemoteConfig } from '../config.js';
import { type HostPathOutcome } from './probe.js';
export interface VerificationManagerOptions {
    /** Loopback base of the gateway child, `http://127.0.0.1:<port>`. */
    gatewayBase: string;
    /** Fresh resolved config values per call (volatile discipline). */
    getValues: () => ZenRemoteConfig;
    /** The hostPath probe; injectable for tests (defaults to GW-8's real one). */
    probe?: (publicUrl: string) => Promise<HostPathOutcome>;
    /** Whether the ingress processes are alive (Caddy / cloudflared). The
     * wiring supplies this once the process managers are mounted; absent
     * means "checked elsewhere" and only the gateway is probed. */
    runtimeReady?: () => boolean | Promise<boolean>;
    fetchImpl?: typeof fetch;
    /** Per-gateway-call ceiling. Default 5000 ms. */
    timeoutMs?: number;
    /** Clock (tests drive expiry). */
    now?: () => number;
}
export type VerificationStartResult = {
    ok: true;
    pairingCode: string;
    publicUrl: string;
    expiresAt: number;
} | {
    ok: false;
    reason: 'no-public-url' | 'bad-public-url' | 'runtime-not-ready' | 'gateway-unreachable' | 'probe-failed' | 'pair-refused';
    /** The probe's classifications for `probe-failed`; the gateway's status
     * code for `pair-refused`; the normalize failure reason for
     * `bad-public-url`. */
    detail?: unknown;
};
export type VerificationCheckResult = {
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
/**
 * The config fingerprint a session binds to: any drift between start and
 * check means the verified URL is no longer the deployed URL.
 */
export declare function verificationFingerprint(values: ZenRemoteConfig, gatewayPort: number | null): string;
export interface VerificationManager {
    start(input: {
        publicUrl: unknown;
        probeOnly?: boolean;
    }): Promise<VerificationStartResult>;
    check(): Promise<VerificationCheckResult>;
    /** Whether a verification session is open (the route surfaces it for the
     * UI's 「待外部验证」 state). */
    hasSession(): boolean;
}
export declare function createVerificationManager(options: VerificationManagerOptions): VerificationManager;
//# sourceMappingURL=verify.d.ts.map