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
import { normalizeServerUrl } from '../client-pairing.js';
import { probeHostPath } from './probe.js';
/**
 * The config fingerprint a session binds to: any drift between start and
 * check means the verified URL is no longer the deployed URL.
 */
export function verificationFingerprint(values, gatewayPort) {
    return JSON.stringify({
        ingressMode: values.ingressMode,
        ingressDomain: values.ingressDomain,
        ingressHttpsPort: values.ingressHttpsPort,
        ingressPublicUrl: values.ingressPublicUrl,
        gatewayPort,
        host: values.host,
        trustedProxies: values.trustedProxies,
    });
}
export function createVerificationManager(options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 5000;
    const now = options.now ?? Date.now;
    let session = null;
    /** One loopback gateway call AS the local machine. Answer status+body or
     * null on any failure — every caller degrades, none throws. */
    const callGateway = async (method, path, payload) => {
        try {
            const response = await fetchImpl(`${options.gatewayBase}${path}`, {
                method,
                headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
                ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            const body = await response.json();
            return { status: response.status, body };
        }
        catch {
            return null;
        }
    };
    const readStatus = async () => {
        const reply = await callGateway('GET', '/lan-gate/status');
        if (reply === null || reply.status < 200 || reply.status >= 300)
            return null;
        const body = reply.body;
        if (body === null || typeof body !== 'object')
            return null;
        const deviceIds = Array.isArray(body.devices)
            ? body.devices.map((device) => (device !== null && typeof device === 'object' ? device.id : undefined))
                .filter((id) => typeof id === 'string')
            : [];
        const port = typeof body.port === 'number' ? body.port : null;
        const claim = body.lastWebClaim;
        const lastWebClaim = claim !== null && typeof claim === 'object'
            ? {
                id: typeof claim.id === 'string' ? claim.id : '',
                secure: claim.secure === true,
                at: typeof claim.at === 'number' ? claim.at : 0,
            }
            : null;
        return { deviceIds, port, lastWebClaim };
    };
    return {
        async start({ publicUrl }) {
            if (typeof publicUrl !== 'string' || publicUrl.trim() === '')
                return { ok: false, reason: 'no-public-url' };
            // Same admission as the probe: https anywhere, plain http only into
            // the private-network allowances. The URL the phone will open must
            // be one this machine is willing to verify at all.
            const normalized = normalizeServerUrl(publicUrl);
            if (!normalized.ok)
                return { ok: false, reason: 'bad-public-url', detail: normalized.reason };
            if ((await options.runtimeReady?.()) === false)
                return { ok: false, reason: 'runtime-not-ready' };
            const statusBefore = await readStatus();
            if (statusBefore === null)
                return { ok: false, reason: 'gateway-unreachable' };
            const outcome = await (options.probe ?? probeHostPath)(normalized.url);
            if (outcome.kind !== 'reached' || outcome.root !== 'gateway-pairing-page' || outcome.admin !== 'gateway-admin-403') {
                return { ok: false, reason: 'probe-failed', detail: outcome };
            }
            const pair = await callGateway('POST', '/lan-gate/pair', { role: 'web' });
            const pairBody = pair?.body;
            if (pair === null || pair.status < 200 || pair.status >= 300 || pairBody?.ok !== true || typeof pairBody.code !== 'string' || typeof pairBody.expiresAt !== 'number') {
                return { ok: false, reason: 'pair-refused', detail: pair === null ? null : pair.status };
            }
            session = {
                publicUrl: normalized.url,
                code: pairBody.code,
                expiresAt: pairBody.expiresAt,
                knownDeviceIds: new Set(statusBefore.deviceIds),
                fingerprint: verificationFingerprint(options.getValues(), statusBefore.port),
            };
            return { ok: true, pairingCode: session.code, publicUrl: session.publicUrl, expiresAt: session.expiresAt };
        },
        async check() {
            if (session === null)
                return { result: 'not-started' };
            const status = await readStatus();
            if (status === null)
                return { result: 'pending' };
            // The verified URL must still BE the deployed URL: a config or
            // gateway-port drift discards the session outright.
            if (verificationFingerprint(options.getValues(), status.port) !== session.fingerprint) {
                session = null;
                return { result: 'stale' };
            }
            // New devices first, expiry second: the claim itself proves the code
            // was still valid when it was redeemed, so a poll that lands moments
            // past the expiry must not swallow a pass.
            const newcomers = status.deviceIds.filter((id) => !session.knownDeviceIds.has(id));
            if (newcomers.length > 0) {
                const deviceId = newcomers[newcomers.length - 1];
                const claim = status.lastWebClaim;
                if (claim !== null && claim.id === deviceId) {
                    session = null;
                    if (!claim.secure)
                        return { result: 'cookie-insecure', deviceId };
                    return { result: 'pass', deviceId, at: claim.at };
                }
                // A claim record that has not surfaced (or names a different,
                // later claim): keep polling rather than bless an unverified cookie.
                return { result: 'pending' };
            }
            if (now() >= session.expiresAt) {
                session = null;
                return { result: 'code-expired' };
            }
            return { result: 'pending' };
        },
        hasSession: () => session !== null,
    };
}
//# sourceMappingURL=verify.js.map