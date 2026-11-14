/**
 * CLI-3: the `status` command — one identity read (ping) plus whatever the
 * role actually answers, rendered either as pretty JSON (`--json`) or as
 * bilingual terminal lines. `--debug` is its own branch: fetch the plugin
 * process's redacted diagnostic report over IPC and write it to a file
 * (explicit path or a `zen-remote-debug-<role>-<yyyymmdd-hhmm>.json` in the
 * working directory).
 *
 * Per SPEC the IPC channel only carries structured data — every terminal
 * string is rendered here through the translator. The per-server line
 * renderer is shared with `commands-client.ts` (`client list` prints the
 * same rows), so the two surfaces cannot drift.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_STATUS_ROUTE, ADMIN_SHARES_ROUTE } from '../admin-routes.js';
import { WIZARD_STATUS_ROUTE } from '../wizard/routes.js';
import { CLIENT_STATUS_ROUTE, CLIENT_PEER_STATUS_ROUTE } from '../client-routes.js';
/**
 * Fetch one JSON object over IPC; every failure mode (transport error,
 * error status, non-object body) is `null` — a broken surface means "no
 * information" for a status view, never a failed command.
 */
export async function fetchBody(run) {
    try {
        const result = await run();
        if (result.status < 200 || result.status >= 300)
            return null;
        return plainOf(result.body);
    }
    catch {
        return null;
    }
}
/** One plain JSON object, or null. */
export function plainOf(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function stringOf(value) {
    return typeof value === 'string' ? value : '';
}
function arrayOf(value) {
    return Array.isArray(value) ? value : [];
}
// ===========================================================================
// Shared row rendering (status + client list)
// ===========================================================================
/** The connection-state label: the three common states translated, the rest
 * (revoked / incompatible / unpaired) each with their own word. */
export function stateLabelOf(t, value) {
    switch (value) {
        case 'online': return t('status.online');
        case 'connecting': return t('status.connecting');
        case 'offline': return t('status.offline');
        case 'revoked': return t('status.state.revoked');
        case 'incompatible': return t('status.state.incompatible');
        case 'unpaired': return t('status.unpaired');
        default: return stringOf(value) === '' ? t('status.offline') : String(value);
    }
}
/** The fingerprint-compat half of the compat/bridge column. */
export function compatLabelOf(t, value) {
    const compat = plainOf(value);
    if (compat === null)
        return t('status.client.compatUnavailable');
    const different = arrayOf(compat.different).length;
    if (different > 0)
        return t('status.client.compatDiff', { count: different });
    if (arrayOf(compat.unavailable).length > 0)
        return t('status.client.compatUnavailable');
    return t('status.client.compatOk');
}
/** The bridged-plugin half: how many of the row's plugins are bridged. */
export function bridgeLabelOf(t, value) {
    const plugins = arrayOf(value);
    const bridged = plugins.filter((entry) => plainOf(entry)?.bridged === true).length;
    return t('status.client.bridgeCount', { count: bridged });
}
/** The peer gateway admission label (PG-10): the seven engine states
 * translated, an unknown value rendered as-is. Shared with the `peer`
 * command family's own renderings. */
export function gatewayStateLabel(t, value) {
    switch (value) {
        case 'idle': return t('peer.gateway.idle');
        case 'connecting': return t('peer.gateway.connecting');
        case 'pending-approval': return t('peer.gateway.pending-approval');
        case 'authorized': return t('peer.gateway.authorized');
        case 'paused': return t('peer.gateway.paused');
        case 'revoked': return t('peer.gateway.revoked');
        case 'identity-error': return t('peer.gateway.identity-error');
        case 'offline': return t('peer.gateway.offline');
        default: return stringOf(value) === '' ? t('peer.gateway.offline') : String(value);
    }
}
/** The peer connection-path label: 局域网直连 / 直连 / 经网关中转 / 身份异常 /
 * 离线. Unknown values render as 离线, the engine's default verdict. */
export function peerPathLabelOf(t, value) {
    switch (value) {
        case 'lan': return t('peer.path.lan');
        case 'p2p': return t('peer.path.p2p');
        case 'relay': return t('peer.path.relay');
        case 'mismatch': return t('peer.path.mismatch');
        default: return t('peer.path.offline');
    }
}
/** Normalize one peer status body's capacity facts. Pure, defensive: a junk
 * body yields all-unknown, never a plausible-looking guess. */
export function peerCapacityOf(body) {
    const raw = body === null ? {} : body;
    const maxPeers = typeof raw.maxPeers === 'number' && Number.isFinite(raw.maxPeers) ? raw.maxPeers : undefined;
    const maxServersRaw = raw.maxServers;
    const maxServers = typeof maxServersRaw === 'number' && Number.isSafeInteger(maxServersRaw) && maxServersRaw >= 1 && maxServersRaw <= 64
        ? maxServersRaw
        : undefined;
    const rows = Array.isArray(raw.peers) ? raw.peers : undefined;
    const listCountable = rows !== undefined && rows.every((row) => {
        const record = plainOf(row);
        return record !== null && typeof record.mounted === 'boolean';
    });
    const mountedRaw = raw.mountedCount;
    const mountedCount = typeof mountedRaw === 'number' && Number.isSafeInteger(mountedRaw) && mountedRaw >= 0
        ? mountedRaw
        : listCountable
            ? rows.filter((row) => plainOf(row)?.mounted === true).length
            : undefined;
    return {
        maxPeers,
        maxServers,
        mountedCount,
        limitReached: mountedCount !== undefined && maxServers !== undefined ? mountedCount >= maxServers : undefined,
    };
}
/** The capacity terminal lines, indent included — the mount N/M line (or the
 * explicit unknown), the full note when the local cap is reached (existing
 * mounts stay, new ones wait), and the network-total cap as its own line
 * whenever the body announced one (even while the local capacity is
 * unknown). */
export function peerCapacityLines(t, body) {
    const facts = peerCapacityOf(body);
    const lines = [
        `  ${facts.mountedCount !== undefined && facts.maxServers !== undefined
            ? t('peer.status.mountCount', { count: facts.mountedCount, max: facts.maxServers })
            : t('peer.status.mountUnknown')}`,
    ];
    if (facts.limitReached === true) {
        lines.push(`  ${t('peer.status.mountFull', { max: facts.maxServers ?? '' })}`);
    }
    if (facts.maxPeers !== undefined) {
        lines.push(`  ${t('peer.status.networkCap', { max: facts.maxPeers })}`);
    }
    return lines;
}
/** One paired-host row, the exact shape both surfaces print:
 * `[entryId] displayName  serverUrl  state  compat/bridge`. */
export function serverLineText(t, row) {
    const name = stringOf(row.displayName) !== '' ? stringOf(row.displayName) : stringOf(row.serverName);
    return `[${stringOf(row.entryId)}] ${name}  ${stringOf(row.serverUrl)}  ${stateLabelOf(t, row.state)}  ${compatLabelOf(t, row.compat)} · ${bridgeLabelOf(t, row.pluginBridge)}`;
}
// ===========================================================================
// The status command
// ===========================================================================
function defaultDebugPath(role, now, cwd) {
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    return join(cwd, `zen-remote-debug-${role}-${stamp}.json`);
}
/** The `--debug` branch: fetch the redacted report and land it in a file.
 * With `--json` the answer also prints as `{ ok, path, report }`; the
 * bilingual completion line prints either way. */
async function debugReportFlow(ctx, ping) {
    const { t, ipc, args } = ctx;
    const out = ctx.stdout;
    let report;
    try {
        report = await ipc.getDebugReport();
    }
    catch (error) {
        out.write(`${t('status.debugFailed', { error: error instanceof Error ? error.message : String(error) })}\n`);
        return 1;
    }
    // The route answers HTTP error statuses as JSON envelopes ({ ok: false,
    // error }) — a 503 no-handler or a 404 must never land in a file dressed
    // up as a report (CLI-3-fix). Only a real report shape proceeds to disk.
    const reportRecord = plainOf(report);
    if (reportRecord === null || reportRecord.ok === false || !('_meta' in reportRecord)) {
        const error = plainOf(reportRecord?.error);
        const detail = typeof error?.code === 'string'
            ? error.code
            : reportRecord === null ? 'not an object' : 'missing _meta';
        out.write(`${t('status.debugFailed', { error: detail })}\n`);
        return 1;
    }
    const outPath = args.options.debugPath ?? defaultDebugPath(ping.role, ctx.now?.() ?? new Date(), ctx.cwd ?? process.cwd());
    try {
        writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    catch (error) {
        out.write(`${t('status.debugWriteFailed', { error: error instanceof Error ? error.message : String(error) })}\n`);
        return 1;
    }
    if (args.options.json) {
        out.write(`${JSON.stringify({ ok: true, path: outPath, report }, null, 2)}\n`);
    }
    out.write(`${t('status.debugWritten', { path: outPath })}\n`);
    return 0;
}
/** The `host` JSON section: sanitized summary of admin/status + wizard/status
 * + the share count. */
function hostJsonSection(admin, wizard, shares) {
    const gateway = admin === null ? null : plainOf(admin.gateway);
    const reachable = admin?.gatewayReachable === true;
    const port = typeof gateway?.port === 'number'
        ? gateway.port
        : typeof wizard?.gatewayActualPort === 'number' ? wizard.gatewayActualPort : null;
    const devices = gateway === null ? [] : arrayOf(gateway.devices);
    const deviceList = devices
        .map((device) => plainOf(device))
        .filter((device) => device !== null)
        .map((device) => ({ name: stringOf(device.name), role: stringOf(device.role) }));
    return {
        gateway: { reachable, port },
        ingress: {
            mode: stringOf(wizard?.mode) === '' ? 'off' : stringOf(wizard?.mode),
            publicUrl: stringOf(wizard?.publicUrl),
            caddyRunning: wizard?.caddyRunning === true,
            cloudflaredRunning: wizard?.cloudflaredRunning === true,
        },
        devices: { count: deviceList.length, list: deviceList },
        sharedSessions: arrayOf(shares?.shares).length,
    };
}
/** The terminal host section. Every read is defensive: a surface that failed
 * to answer simply prints nothing instead of a broken line. */
function renderHostSection(t, admin, wizard, shares) {
    const lines = [t('status.host.title')];
    const gateway = admin === null ? null : plainOf(admin.gateway);
    if (admin?.gatewayReachable === true && gateway !== null) {
        const port = typeof gateway.port === 'number' ? gateway.port : wizard?.gatewayActualPort;
        lines.push(`  ${typeof port === 'number' ? t('status.host.gatewayUp', { port }) : t('status.host.gatewayUpNoPort')}`);
    }
    else {
        lines.push(`  ${t('status.host.gatewayDown')}`);
    }
    const mode = stringOf(wizard?.mode) === '' ? 'off' : stringOf(wizard?.mode);
    lines.push(`  ${t('status.host.ingress', { mode })}`);
    const publicUrl = stringOf(wizard?.publicUrl);
    if (publicUrl !== '')
        lines.push(`  ${t('status.host.publicUrl', { publicUrl })}`);
    if (mode === 'caddy') {
        lines.push(`  ${t('status.host.processCaddy', { state: wizard?.caddyRunning === true ? t('status.process.running') : t('status.process.stopped') })}`);
    }
    if (mode === 'cloudflared') {
        lines.push(`  ${t('status.host.processTunnel', { state: wizard?.cloudflaredRunning === true ? t('status.process.running') : t('status.process.stopped') })}`);
    }
    const devices = gateway === null ? [] : arrayOf(gateway.devices);
    lines.push(`  ${t('status.host.devices', { count: devices.length })}`);
    for (const device of devices) {
        const record = plainOf(device);
        if (record === null)
            continue;
        const name = stringOf(record.name);
        if (name === '')
            continue;
        lines.push(t('status.host.deviceLine', { name, deviceRole: stringOf(record.role) }));
    }
    lines.push(`  ${t('status.host.sharedSessions', { count: arrayOf(shares?.shares).length })}`);
    return lines;
}
/** The terminal client section: the count line, the limit warning at 8/8,
 * one row per paired host, and the last error of a troubled row. */
function renderClientSection(t, client) {
    const lines = [t('status.client.title')];
    const servers = arrayOf(client.servers)
        .map((row) => plainOf(row))
        .filter((row) => row !== null);
    const max = typeof client.maxServers === 'number' ? client.maxServers : 8;
    lines.push(`  ${t('status.client.pairedCount', { count: servers.length, max })}`);
    if (servers.length >= max)
        lines.push(`  ${t('client.limitReached')}`);
    for (const row of servers) {
        lines.push(`  ${serverLineText(t, row)}`);
        const lastError = stringOf(row.lastError);
        if (lastError !== '')
            lines.push(`      ${t('status.client.lastError', { error: lastError })}`);
    }
    return lines;
}
/** The terminal peer section (PG-10): the node's virtual-network facts —
 * node id, joined network + gateway, admission state, and one row per
 * network device. A missing engine answer renders nothing (the section title
 * alone) instead of failing the command. */
export function renderPeerSection(t, peer) {
    const lines = [t('peer.status.title')];
    if (peer === null)
        return lines;
    const nodeId = typeof peer.nodeId === 'string' ? peer.nodeId : '';
    lines.push(`  ${t('peer.status.nodeId', { nodeId })}`);
    if (peer.gatewayState === 'identity-error') {
        lines.push(`  ${t('peer.status.gatewayState', { state: gatewayStateLabel(t, peer.gatewayState) })}`);
        lines.push(`  ${t('peer.status.identityError')}`);
        return lines;
    }
    if (peer.configured !== true) {
        lines.push(`  ${t('peer.status.notJoined')}`);
        return lines;
    }
    const networkId = typeof peer.networkId === 'string' ? peer.networkId : '';
    const origin = typeof peer.gatewayOrigin === 'string' && peer.gatewayOrigin !== '' ? peer.gatewayOrigin : '—';
    lines.push(`  ${t('peer.status.joined', { networkId, origin })}`);
    lines.push(`  ${t('peer.status.gatewayState', { state: gatewayStateLabel(t, peer.gatewayState) })}`);
    lines.push(...peerCapacityLines(t, peer));
    const peers = arrayOf(peer.peers)
        .map((row) => plainOf(row))
        .filter((row) => row !== null);
    lines.push(`  ${t('peer.status.deviceCount', { count: peers.length })}`);
    for (const row of peers) {
        const rttMs = row.rttMs;
        const rtt = typeof rttMs === 'number' && Number.isFinite(rttMs) ? t('peer.status.rtt', { rttMs }) : '—';
        lines.push(t('peer.status.deviceLine', {
            name: typeof row.name === 'string' ? row.name : '',
            nodeId: typeof row.nodeId === 'string' ? row.nodeId : '',
            path: peerPathLabelOf(t, row.path),
            rtt,
            mounted: row.mounted === true ? t('peer.mounted.yes') : t('peer.mounted.no'),
        }));
    }
    return lines;
}
/** The `--json` body: identity always, the sections the role answers. */
function statusJsonBody(ping, admin, wizard, shares, client, peer) {
    const body = {
        experimental: true,
        role: ping.role,
        pluginVersion: ping.pluginVersion,
        pid: ping.pid,
        serverName: ping.serverName,
    };
    if (ping.serves)
        body.host = hostJsonSection(admin, wizard, shares);
    if (ping.connects && client !== null) {
        body.client = { maxServers: typeof client.maxServers === 'number' ? client.maxServers : 8, servers: arrayOf(client.servers) };
    }
    if (ping.role === 'peer' && peer !== null)
        body.peer = peer;
    return body;
}
/**
 * `dsh-zen-remote status [--json] [--debug [outPath]]`. Identity from one
 * ping; the host surfaces (admin status, wizard status, share list), the
 * client pool status, and — on a peer node — the peer engine snapshot are
 * each fetched only when the role answers them. Exit codes: 0 on any
 * answered status, 1 when the ping itself or the debug round-trip failed.
 */
export async function runStatusCommand(ctx) {
    const { t, ipc, args } = ctx;
    const out = ctx.stdout;
    let ping;
    try {
        ping = await ipc.ping();
    }
    catch {
        out.write(`${t('status.notRunning')}\n`);
        return 1;
    }
    if (args.options.debug || args.options.debugPath !== undefined) {
        return await debugReportFlow(ctx, ping);
    }
    // The role decides which surfaces exist; fetches run concurrently and any
    // failure degrades to "no information" rather than failing the command.
    const [admin, wizard, shares, client, peer] = await Promise.all([
        ping.serves ? fetchBody(() => ipc.request('GET', ADMIN_STATUS_ROUTE)) : Promise.resolve(null),
        ping.serves ? fetchBody(() => ipc.request('GET', WIZARD_STATUS_ROUTE)) : Promise.resolve(null),
        ping.serves ? fetchBody(() => ipc.request('GET', ADMIN_SHARES_ROUTE)) : Promise.resolve(null),
        ping.connects ? fetchBody(() => ipc.request('GET', CLIENT_STATUS_ROUTE)) : Promise.resolve(null),
        ping.role === 'peer' ? fetchBody(() => ipc.request('GET', CLIENT_PEER_STATUS_ROUTE)) : Promise.resolve(null),
    ]);
    if (args.options.json) {
        out.write(`${JSON.stringify(statusJsonBody(ping, admin, wizard, shares, client, peer), null, 2)}\n`);
        return 0;
    }
    const lines = [
        t('status.line.role', { role: t(`status.role.${ping.role}`) }),
        t('status.machineName', { name: ping.serverName }),
        t('status.pluginVersion', { version: ping.pluginVersion }),
    ];
    if (ping.profileName !== undefined)
        lines.push(t('status.profile', { profile: ping.profileName }));
    if (ping.role === 'peer')
        lines.push(...renderPeerSection(t, peer));
    if (ping.serves)
        lines.push(...renderHostSection(t, admin, wizard, shares));
    if (ping.connects && client !== null)
        lines.push(...renderClientSection(t, client));
    out.write(`${lines.join('\n')}\n`);
    return 0;
}
//# sourceMappingURL=commands-status.js.map