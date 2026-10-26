/**
 * Tunnel orchestration (GW-13b, 路 C's autopilot): one call drives the
 * whole Cloudflare-side setup the design promises — zone/account lookup
 * (through the ancestor-chain check), tunnel create-or-adopt, ingress
 * configuration against the gateway's ACTUAL port, the proxied CNAME,
 * and the cloudflared child.
 *
 * Rules the review and the design pin down:
 *
 *   - **已有同名隧道**：the first setup pass answers `tunnel-conflict`
 *     with the same-name list; the UI lets the user pick one and re-runs
 *     with `tunnelId`, which adopts the existing tunnel through the token
 *     endpoint instead of creating anything.
 *   - **模式切换**：starting the tunnel stops the managed Caddy first
 *     (`stopCaddy`) — never two ingress processes at once.
 *   - The connector token travels from the Cloudflare answer into the
 *     0600 token file and the child's `--token-file`; it never reaches a
 *     response or a log.
 *   - Every failure is a VALUE with a stable `reason` the UI maps to
 *     locale copy; CloudflareError codes map losslessly (`cf-*` → the
 *     orchestration's own reasons), unknown ones degrade to `api`.
 */
import { hostOf } from '../config.js';
import { createCloudflareApi } from './cloudflare.js';
import { writeTunnelTokenFile } from './cloudflared.js';
/** The tunnel name the wizard mints and looks for. */
export const TUNNEL_NAME = 'dsh-zen-remote';
/** CloudflareError.code → the orchestration's reason vocabulary. */
function mapCloudflareError(error) {
    if (error !== null && typeof error === 'object' && 'code' in error) {
        const code = error.code;
        const detail = error.message;
        if (code === 'cf-auth-failed')
            return { ok: false, reason: 'auth', detail: String(detail ?? '') };
        if (code === 'cf-network')
            return { ok: false, reason: 'network', detail: String(detail ?? '') };
        if (code === 'cf-zone-not-found')
            return { ok: false, reason: 'zone-not-found' };
    }
    return { ok: false, reason: 'api', detail: String(error?.message ?? error) };
}
/**
 * Drive the whole tunnel setup. Throws nothing — every outcome is a value.
 */
export async function setupTunnel(options, input) {
    const token = options.readToken();
    if (token === undefined || token.trim() === '')
        return { ok: false, reason: 'no-token' };
    const host = hostOf(input.domain);
    if (host === undefined)
        return { ok: false, reason: 'bad-domain' };
    const api = options.apiFactory !== undefined
        ? options.apiFactory(token)
        : createCloudflareApi({ token, fetchImpl: options.fetchImpl });
    // Zone + account: the ancestor-chain check answers both in one verdict.
    let zoneId;
    let accountId;
    try {
        const check = await api.checkDomainOnCloudflare(host);
        if (!check.onCloudflare || check.zoneId === null || check.accountId === null) {
            return { ok: false, reason: 'zone-not-found' };
        }
        zoneId = check.zoneId;
        accountId = check.accountId;
    }
    catch (error) {
        return mapCloudflareError(error);
    }
    // Tunnel: adopt the user's choice, or create a fresh one — but a fresh
    // create refuses when same-name tunnels already exist (the UI offers the
    // list; the re-run carries `tunnelId`).
    let tunnelId;
    let tunnelToken;
    try {
        if (input.tunnelId !== undefined && input.tunnelId !== '') {
            tunnelId = input.tunnelId;
            tunnelToken = await api.getTunnelToken(accountId, tunnelId);
        }
        else {
            const existing = await api.listTunnels(accountId);
            const sameName = existing.filter((tunnel) => tunnel.name === TUNNEL_NAME);
            if (sameName.length > 0)
                return { ok: false, reason: 'tunnel-conflict', existing: sameName };
            const created = await api.createTunnel(accountId, TUNNEL_NAME);
            tunnelId = created.id;
            tunnelToken = created.token;
        }
    }
    catch (error) {
        return mapCloudflareError(error);
    }
    const gatewayPort = await options.gatewayPort();
    // The ingress mapping: the public hostname serves the local gateway.
    try {
        await api.configureIngress(accountId, tunnelId, host, `http://127.0.0.1:${gatewayPort}`);
    }
    catch (error) {
        return mapCloudflareError(error);
    }
    // DNS idempotence next (GW-fix-4/M3): an existing CNAME for this name
    // pointing at the SAME tunnel is a no-op; pointing elsewhere is a real
    // conflict we refuse instead of silently overwriting.
    try {
        const existing = await api.listDnsRecords(zoneId, host);
        const prior = existing.find((record) => record.name === host);
        if (prior !== undefined) {
            const expected = `${tunnelId}.cfargotunnel.com`;
            if (prior.content !== expected) {
                return { ok: false, reason: 'dns-conflict', detail: prior.content };
            }
        }
        else {
            await api.createDnsRecord(zoneId, host, `${tunnelId}.cfargotunnel.com`);
        }
    }
    catch (error) {
        return mapCloudflareError(error);
    }
    // L1: the Cloudflare half is DONE — only now stop the managed Caddy and
    // start the tunnel, so a failed API call leaves the old path untouched.
    options.cloudflared.stopCaddy();
    // Connector secret → 0600 file → child.
    let tokenFile;
    try {
        tokenFile = writeTunnelTokenFile(options.dshHome, tunnelToken);
    }
    catch (error) {
        return { ok: false, reason: 'spawn-failed', detail: String(error?.message ?? error) };
    }
    const started = await options.cloudflared.start({ tunnelToken });
    if (!started.ok) {
        return { ok: false, reason: 'spawn-failed', detail: started.error };
    }
    return { ok: true, tunnelId, publicUrl: `https://${host}`, tokenFile };
}
export async function checkDomainOnCloudflare(options, domain) {
    const token = options.readToken();
    if (token === undefined || token.trim() === '')
        return { ok: false, reason: 'no-token' };
    const host = hostOf(domain);
    if (host === undefined)
        return { ok: false, reason: 'bad-domain' };
    const api = options.apiFactory !== undefined
        ? options.apiFactory(token)
        : createCloudflareApi({ token, fetchImpl: options.fetchImpl });
    try {
        const check = await api.checkDomainOnCloudflare(host);
        return { ok: true, onCloudflare: check.onCloudflare, zoneId: check.zoneId, accountId: check.accountId };
    }
    catch (error) {
        const mapped = mapCloudflareError(error);
        return { ok: false, reason: mapped.reason === 'auth' ? 'auth' : mapped.reason === 'network' ? 'network' : 'api', detail: mapped.detail };
    }
}
//# sourceMappingURL=tunnel-orchestrator.js.map