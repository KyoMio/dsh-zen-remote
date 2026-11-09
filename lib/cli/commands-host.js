/**
 * CLI-4: the `host` subcommand family — `device pair|list|revoke` and
 * `ingress start|stop|verify|snippet`. Every entry point passes the
 * servesRole gate FIRST (the task discipline: a client never drives the
 * server-owner surfaces; the message names the `setup` switch), then drives
 * the plugin's own admin/wizard routes over IPC.
 *
 * The iron rule for ingress: the CLI NEVER spawns `caddy` or `cloudflared`
 * itself — download, start, stop, status and the three-light verification
 * all happen inside the plugin process through the
 * `/_dsh/zen-remote/admin/wizard/*` routes (SPEC §1). Mode switches mirror
 * `GatewayWizard.tsx`'s discipline: any managed ingress process that does
 * not belong to the new mode is stopped through its stop route before the
 * new mode's flow runs, managed caddy/cloudflared reset `host` back to
 * `127.0.0.1`, and lan rebinds it to `0.0.0.0`.
 *
 * Interactivity follows the bootstrap iron rule: a missing value prompts in
 * a TTY run and throws MissingRequiredOptionError otherwise — except the
 * values with a SAVED fallback (domain, public URL), which the saved wizard
 * status answers before any prompt.
 */
import { hostOf } from '../config.js';
import { normalizeServerUrl } from '../client-pairing.js';
import { ADMIN_STATUS_ROUTE, ADMIN_PAIR_ROUTE, ADMIN_ACTION_ROUTE } from '../admin-routes.js';
import { WIZARD_STATUS_ROUTE, WIZARD_TRUST_PROXY_ROUTE, WIZARD_VERIFY_ROUTE, WIZARD_CF_TOKEN_ROUTE, WIZARD_CADDY_START_ROUTE, WIZARD_CADDY_STOP_ROUTE, WIZARD_TUNNEL_CHECK_ROUTE, WIZARD_TUNNEL_SETUP_ROUTE, WIZARD_TUNNEL_STOP_ROUTE, } from '../wizard/routes.js';
import { nginxSnippet, caddySnippet, luckySteps } from '../wizard/proxy-snippets.js';
import { renderTerminalQr } from './qr-terminal.js';
import { promptOrFail, MissingRequiredOptionError } from './bootstrap.js';
import { fetchBody, plainOf } from './commands-status.js';
const DEVICE_ROLES = ['web', 'desktop-client'];
const INGRESS_MODES = ['caddy', 'cloudflared', 'external', 'lan'];
const PROXY_KINDS = ['nginx', 'caddy', 'lucky'];
/** The default gateway port, same as config.ts's own default. */
const DEFAULT_GATEWAY_PORT = 3088;
/** `host ingress verify`'s phone-pairing poll interval: a poll a second
 * keeps the tunnel quiet; tests shrink it via the seam. */
const VERIFY_POLL_INTERVAL_DEFAULT_MS = 1000;
/** `lan`'s gateway-restart readiness poll: frequent, because the reload is
 * fast (config-writer triggers checkNow immediately). */
const LAN_POLL_INTERVAL_DEFAULT_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// ===========================================================================
// Shared helpers
// ===========================================================================
/**
 * The role gate every `host *` command passes first: a fresh ping (the role
 * is a volatile row field), and anything that does not serve answers the
 * bilingual refusal naming the current role.
 */
async function requireServesRole(ctx) {
    let serves = false;
    let role = 'client';
    try {
        const ping = await ctx.ipc.ping();
        serves = ping.serves;
        role = ping.role;
    }
    catch {
        // No live plugin is no role that serves either — same refusal text.
    }
    if (serves)
        return true;
    ctx.stdout.write(`${ctx.t('err.roleGate.hostRequired', { role })}\n`);
    return false;
}
/** One JSON object over IPC; every failure mode is `null` — "no
 * information", never a thrown command. */
async function fetchRecord(ctx, method, path, body) {
    return await fetchBody(() => ctx.ipc.request(method, path, body));
}
/** The anti-shadowing config write, reporting `env-shadowed` and generic
 * failures through the translator. Shared with `command-setup.ts`'s role
 * switch, which writes the same way. */
export async function writeConfigOrReport(ctx, set) {
    const { t } = ctx;
    const result = await ctx.ipc.writeConfig({ set });
    const body = plainOf(result.body);
    if (result.status !== 200 || body?.ok !== true) {
        const error = plainOf(body?.error);
        if (error?.code === 'env-shadowed') {
            ctx.stdout.write(`${t('err.envShadowed', { field: String(error.field), envVar: String(error.envVar) })}\n`);
        }
        else {
            ctx.stdout.write(`${t('host.ingress.configWriteFailed')}\n`);
        }
        return false;
    }
    return true;
}
/** One ask-text-or-throw: interactive runs prompt through the prompter,
 * anything else raises the structured missing-option error. */
async function askText(ctx, optionName, question) {
    return await promptOrFail({
        optionName,
        interactive: ctx.interactive,
        provided: undefined,
        ask: async () => {
            if (ctx.prompter === undefined)
                throw new MissingRequiredOptionError(optionName);
            return await ctx.prompter.inputText(question, undefined, undefined);
        },
    });
}
/** The gateway child's ACTUAL port (it may have retried past the configured
 * one): the wizard status's live fact, else the admin status's gateway
 * payload, else the configured `port`, else the 3088 default. */
function gatewayPortOf(wizard, admin) {
    if (typeof wizard?.gatewayActualPort === 'number')
        return wizard.gatewayActualPort;
    const gateway = plainOf(admin?.gateway);
    if (typeof gateway?.port === 'number')
        return gateway.port;
    const config = plainOf(admin?.config);
    const values = plainOf(config?.values);
    if (typeof values?.port === 'number')
        return values.port;
    return DEFAULT_GATEWAY_PORT;
}
/** The address a phone / other machine can reach this host at: the saved
 * public URL first, then the LAN address assembled with the gateway's
 * actual port. Empty when neither exists. */
function publicUrlOf(wizard, admin) {
    const saved = typeof wizard?.publicUrl === 'string' ? wizard.publicUrl : '';
    if (saved !== '')
        return saved;
    const lan = typeof wizard?.lanAddress === 'string' ? wizard.lanAddress : '';
    if (lan === '')
        return '';
    return `http://${lan}:${gatewayPortOf(wizard, admin)}`;
}
/** `YYYY-MM-DD HH:mm` in the local timezone, or a dash for absent stamps. */
function formatStamp(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return '—';
    const d = new Date(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** The paired-device rows of an admin/status answer, defensively filtered. */
function devicesOf(admin) {
    const gateway = plainOf(admin?.gateway);
    if (!Array.isArray(gateway?.devices))
        return [];
    return gateway.devices
        .map((device) => plainOf(device))
        .filter((device) => device !== null);
}
function deviceLineText(t, device) {
    return t('host.device.deviceLine', {
        id: String(device.id ?? ''),
        name: String(device.name ?? ''),
        deviceRole: String(device.role ?? ''),
        kind: String(device.kind ?? ''),
    });
}
// ===========================================================================
// host device pair
// ===========================================================================
/**
 * `host device pair [--device-role web|desktop-client] [--json]` — mint one
 * pairing code through the admin pair route and print it with everything
 * the receiving side needs: the reachable URL (public URL, or the LAN
 * address assembled with the gateway's actual port), a terminal QR for web
 * devices, the copy-paste `client pair` command for desktop clients, and
 * the code with its validity window (the gateway mints 10-minute codes).
 */
export async function runHostDevicePairCommand(ctx) {
    if (!(await requireServesRole(ctx)))
        return 1;
    const { t, args, ipc } = ctx;
    const out = ctx.stdout;
    let deviceRole = args.options.deviceRole;
    if (deviceRole === undefined) {
        if (ctx.interactive && ctx.prompter !== undefined) {
            const picked = await ctx.prompter.selectOne(t('host.device.prompt.role'), [t('host.device.role.web'), t('host.device.role.desktop')], 0);
            deviceRole = picked === 1 ? 'desktop-client' : 'web';
        }
        else {
            // Non-interactive runs default to the web device — the common case.
            deviceRole = 'web';
        }
    }
    else if (!DEVICE_ROLES.includes(deviceRole)) {
        out.write(`${t('host.device.error.badRole', { value: deviceRole })}\n`);
        return 1;
    }
    if (args.options.json) {
        // --json is a machine-readable run: the structured answer only.
        const pairJson = await ipc.request('POST', ADMIN_PAIR_ROUTE, { role: deviceRole });
        const pairJsonBody = plainOf(pairJson.body);
        const jsonCode = typeof pairJsonBody?.code === 'string' ? pairJsonBody.code : '';
        const jsonExpiresAt = typeof pairJsonBody?.expiresAt === 'number' ? pairJsonBody.expiresAt : 0;
        if (pairJson.status < 200 || pairJson.status >= 300 || pairJsonBody?.ok !== true || jsonCode === '') {
            out.write(`${JSON.stringify({ ok: false }, null, 2)}\n`);
            return 1;
        }
        const [jsonWizard, jsonAdmin] = await Promise.all([
            fetchRecord(ctx, 'GET', WIZARD_STATUS_ROUTE),
            fetchRecord(ctx, 'GET', ADMIN_STATUS_ROUTE),
        ]);
        const jsonUrl = publicUrlOf(jsonWizard, jsonAdmin);
        out.write(`${JSON.stringify({
            ok: true,
            deviceRole,
            code: jsonCode,
            expiresAt: jsonExpiresAt,
            role: deviceRole,
            ...(jsonUrl === '' ? {} : { url: jsonUrl }),
        }, null, 2)}\n`);
        return 0;
    }
    out.write(`${t('host.device.minting')}\n`);
    const pairResult = await ipc.request('POST', ADMIN_PAIR_ROUTE, { role: deviceRole });
    const pairBody = plainOf(pairResult.body);
    const code = typeof pairBody?.code === 'string' ? pairBody.code : '';
    const expiresAt = typeof pairBody?.expiresAt === 'number' ? pairBody.expiresAt : 0;
    if (pairResult.status < 200 || pairResult.status >= 300 || pairBody?.ok !== true || code === '') {
        out.write(`${t('host.device.pairFailed')}\n`);
        return 1;
    }
    const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
    const [wizard, admin] = await Promise.all([
        fetchRecord(ctx, 'GET', WIZARD_STATUS_ROUTE),
        fetchRecord(ctx, 'GET', ADMIN_STATUS_ROUTE),
    ]);
    const url = publicUrlOf(wizard, admin);
    const desktopCode = typeof pairBody?.desktopCode === 'string' ? pairBody.desktopCode : '';
    out.write(`${t('host.device.pairTitle')}\n`);
    if (deviceRole === 'web') {
        if (url !== '') {
            out.write(`${t('setup.pairingQr')}\n`);
            const qr = renderTerminalQr(url);
            if (qr !== null)
                out.write(`${qr}\n`);
            out.write(`${url}\n`);
        }
        else {
            out.write(`${t('host.device.noAddress')}\n`);
        }
    }
    else if (url !== '') {
        out.write(`${t('host.device.desktopCommand')}\n`);
        out.write(`  dsh-zen-remote client pair ${url} --code ${code}\n`);
        out.write(`${t('host.device.desktopWizard')}\n`);
    }
    else {
        out.write(`${t('host.device.noAddress')}\n`);
    }
    out.write(`${t('host.device.pairingCode', { code, minutes })}\n`);
    if (deviceRole === 'web' && desktopCode !== '') {
        out.write(`${t('setup.desktopPairingCode', { code: desktopCode })}\n`);
        if (url !== '') {
            out.write(`  ${t('setup.desktopPairingCmd', { url, code: desktopCode })}\n`);
        }
    }
    return 0;
}
// ===========================================================================
// host device list
// ===========================================================================
/**
 * `host device list [--json]` — the gateway's device table. `--json` echoes
 * the gateway's own devices array verbatim (the machine-readable truth);
 * the terminal mode prints one line per device with its id, name, role,
 * kind and the created / last-seen stamps.
 */
export async function runHostDeviceListCommand(ctx) {
    if (!(await requireServesRole(ctx)))
        return 1;
    const { t, args } = ctx;
    const out = ctx.stdout;
    const admin = await fetchRecord(ctx, 'GET', ADMIN_STATUS_ROUTE);
    const gateway = plainOf(admin?.gateway);
    if (admin === null || gateway === null) {
        out.write(`${t('host.device.listFailed')}\n`);
        return 1;
    }
    if (args.options.json) {
        out.write(`${JSON.stringify({ ok: true, devices: gateway.devices ?? [] }, null, 2)}\n`);
        return 0;
    }
    const devices = devicesOf(admin);
    out.write(`${t('host.device.listTitle')}\n`);
    if (devices.length === 0) {
        out.write(`  ${t('host.device.listEmpty')}\n`);
        return 0;
    }
    for (const device of devices) {
        out.write(`${deviceLineText(t, device)}\n`);
        out.write(`${t('host.device.deviceTiming', {
            created: formatStamp(device.createdAt),
            lastSeen: formatStamp(device.lastSeen),
        })}\n`);
    }
    return 0;
}
// ===========================================================================
// host device revoke
// ===========================================================================
/**
 * `host device revoke [<id>|--all] [--yes] [--json]` — one revoke POST per
 * invocation. `--all` needs `--yes` outside a TTY confirm (the missing
 * confirmation IS the missing required option); a missing target in an
 * interactive run picks from the current list.
 */
export async function runHostDeviceRevokeCommand(ctx) {
    if (!(await requireServesRole(ctx)))
        return 1;
    const { t, args, ipc } = ctx;
    const out = ctx.stdout;
    if (args.options.all) {
        const admin = await fetchRecord(ctx, 'GET', ADMIN_STATUS_ROUTE);
        const count = devicesOf(admin).length;
        if (!args.options.yes) {
            if (!ctx.interactive || ctx.prompter === undefined) {
                out.write(`${t('err.missingOption', { option: 'yes' })}\n`);
                return 1;
            }
            const sure = await ctx.prompter.confirm(t('host.device.revokeConfirmAll'), false);
            if (!sure) {
                out.write(`${t('common.cancel')}\n`);
                return 0;
            }
        }
        const result = await ipc.request('POST', ADMIN_ACTION_ROUTE, { action: 'revoke-all' });
        const body = plainOf(result.body);
        if (result.status !== 200 || body?.ok !== true) {
            out.write(`${t('host.device.revokeFailed')}\n`);
            return 1;
        }
        if (args.options.json) {
            out.write(`${JSON.stringify({ ok: true, action: 'revoke-all', count }, null, 2)}\n`);
        }
        else {
            out.write(`${t('host.device.revoked', { count })}\n`);
        }
        return 0;
    }
    let target = args.target;
    if (target === undefined) {
        if (!ctx.interactive || ctx.prompter === undefined) {
            out.write(`${t('host.device.revokeMissingTarget')}\n`);
            return 1;
        }
        const admin = await fetchRecord(ctx, 'GET', ADMIN_STATUS_ROUTE);
        const devices = devicesOf(admin);
        if (devices.length === 0) {
            out.write(`  ${t('host.device.listEmpty')}\n`);
            return 0;
        }
        const picked = await ctx.prompter.selectOne(t('host.device.selectQuestion'), devices.map((device) => deviceLineText(t, device)), 0);
        target = String(devices[picked]?.id ?? '');
        if (target === '')
            return 1;
    }
    const result = await ipc.request('POST', ADMIN_ACTION_ROUTE, { action: 'revoke', id: target });
    const body = plainOf(result.body);
    if (result.status !== 200 || body?.ok !== true) {
        out.write(`${t('host.device.revokeFailed')}\n`);
        return 1;
    }
    if (args.options.json) {
        out.write(`${JSON.stringify({ ok: true, action: 'revoke', id: target }, null, 2)}\n`);
    }
    else {
        out.write(`${t('host.device.revokedOne', { id: target })}\n`);
    }
    return 0;
}
// ===========================================================================
// ingress snippet rendering (shared with `ingress start external`)
// ===========================================================================
/** Print one reverse-proxy flavor's snippet. Returns false when the
 * generator refused an input (a broken wizard status), true otherwise. */
function printSnippet(ctx, kind, domain, port) {
    const { t } = ctx;
    const out = ctx.stdout;
    const upstreamHost = '127.0.0.1';
    if (kind === 'nginx') {
        const snippet = nginxSnippet({ domain, upstreamHost, upstreamPort: port });
        if (!snippet.ok) {
            out.write(`${t('host.ingress.error.badDomain')}\n`);
            return false;
        }
        out.write(`${t('host.ingress.snippetTitle', { proxy: 'Nginx', port })}\n`);
        out.write(`${snippet.text}\n`);
        return true;
    }
    if (kind === 'caddy') {
        const snippet = caddySnippet({ domain, upstreamHost, upstreamPort: port });
        if (!snippet.ok) {
            out.write(`${t('host.ingress.error.badDomain')}\n`);
            return false;
        }
        out.write(`${t('host.ingress.snippetTitle', { proxy: 'Caddy', port })}\n`);
        out.write(`${snippet.text}\n`);
        return true;
    }
    const steps = luckySteps({ upstreamHost, upstreamPort: port });
    if (!steps.ok) {
        out.write(`${t('host.ingress.error.badDomain')}\n`);
        return false;
    }
    out.write(`${t('host.ingress.snippetTitle', { proxy: 'Lucky', port })}\n`);
    for (const step of steps.steps)
        out.write(`${step}\n`);
    return true;
}
/** Which flavors to print: an explicit `--proxy`, one prompted in an
 * interactive run, or all three headlessly. */
async function resolveSnippetKinds(ctx) {
    const { t, args } = ctx;
    const proxy = args.options.proxy;
    if (proxy !== undefined) {
        if (!PROXY_KINDS.includes(proxy)) {
            ctx.stdout.write(`${t('host.ingress.error.badProxy', { value: proxy })}\n`);
            return null;
        }
        return [proxy];
    }
    if (ctx.interactive && ctx.prompter !== undefined) {
        const picked = await ctx.prompter.selectOne(t('host.ingress.snippetQuestion'), ['Nginx', 'Caddy', 'Lucky'], 0);
        const kind = ['nginx', 'caddy', 'lucky'][picked];
        return kind === undefined ? null : [kind];
    }
    return ['nginx', 'caddy', 'lucky'];
}
/**
 * `host ingress snippet [--proxy nginx|caddy|lucky]` — the copy-paste
 * reverse-proxy material for the external ingress mode. The upstream port
 * is the gateway's ACTUAL port (a gateway that retried past its configured
 * port must not hand out snippets pointing at the wrong place); the domain
 * falls back to the example placeholder.
 */
export async function runHostIngressSnippetCommand(ctx) {
    if (!(await requireServesRole(ctx)))
        return 1;
    const { t } = ctx;
    const kinds = await resolveSnippetKinds(ctx);
    if (kinds === null)
        return 1;
    const [wizard, admin] = await Promise.all([
        fetchRecord(ctx, 'GET', WIZARD_STATUS_ROUTE),
        fetchRecord(ctx, 'GET', ADMIN_STATUS_ROUTE),
    ]);
    const port = gatewayPortOf(wizard, admin);
    const domain = typeof wizard?.domain === 'string' && wizard.domain !== '' ? wizard.domain : 'dsh.example.com';
    for (const kind of kinds) {
        if (!printSnippet(ctx, kind, domain, port))
            return 1;
    }
    return 0;
}
// ===========================================================================
// host ingress start
// ===========================================================================
/** Save a command-line-provided Cloudflare token through the 0600 token
 * route. Absent flags are a no-op; a refused save is the failure. */
async function saveCfTokenIfProvided(ctx) {
    const provided = ctx.args.options.cfToken;
    if (provided === undefined || provided === '')
        return true;
    const result = await ctx.ipc.request('POST', WIZARD_CF_TOKEN_ROUTE, { token: provided });
    const body = plainOf(result.body);
    if (result.status !== 200 || body?.ok !== true) {
        ctx.stdout.write(`${ctx.t('host.ingress.cfTokenFailed')}\n`);
        return false;
    }
    return true;
}
/** Ask for the token exactly when none is saved yet (interactive runs
 * only) — a token already on disk must never be re-asked. Prints the
 * mode-specific Cloudflare permission checklist right before the prompt. */
async function askCfTokenIfUnconfigured(ctx, wizard, mode = 'caddy') {
    if (ctx.args.options.cfToken !== undefined && ctx.args.options.cfToken !== '')
        return true;
    if (wizard?.cfTokenConfigured === true)
        return true;
    if (!ctx.interactive || ctx.prompter === undefined)
        return true;
    ctx.stdout.write(`\n${ctx.t('setup.cfTokenGuide.title')}\n`);
    ctx.stdout.write(`${ctx.t(mode === 'cloudflared' ? 'setup.cfTokenGuide.tunnel' : 'setup.cfTokenGuide.caddy')}\n`);
    const token = await ctx.prompter.inputText(ctx.t('setup.cfTokenQuestion'), undefined, undefined);
    if (token.trim() === '')
        return true;
    const result = await ctx.ipc.request('POST', WIZARD_CF_TOKEN_ROUTE, { token: token.trim() });
    const body = plainOf(result.body);
    if (result.status !== 200 || body?.ok !== true) {
        ctx.stdout.write(`${ctx.t('host.ingress.cfTokenFailed')}\n`);
        return false;
    }
    return true;
}
/** The domain: the flag wins, then the saved config, then the prompt. The
 * value must pass config.ts's bare-hostname gate (the same admission the
 * wizard cards apply). */
async function resolveDomain(ctx, wizard) {
    const { t, args } = ctx;
    let provided = args.options.domain;
    if (provided === undefined || provided === '') {
        const saved = typeof wizard?.domain === 'string' && wizard.domain !== '' ? wizard.domain : undefined;
        if (saved !== undefined)
            return hostOf(saved) ?? null;
        provided = await askText(ctx, 'domain', t('setup.domainQuestion'));
    }
    const domain = hostOf(provided);
    if (domain === undefined) {
        ctx.stdout.write(`${t('host.ingress.error.badDomain')}\n`);
        return null;
    }
    return domain;
}
function startFailedCaddy(t, body) {
    const error = typeof body?.error === 'string' ? body.error : '';
    const detail = typeof body?.detail === 'string' ? body.detail : '';
    const installUrl = typeof body?.installUrl === 'string' ? body.installUrl : '';
    switch (error) {
        case 'already-running': return t('host.ingress.caddyError.alreadyRunning');
        case 'missing-token': return t('host.ingress.caddyError.missingToken');
        case 'bad-config': return t('host.ingress.caddyError.badConfig', { detail });
        case 'download-failed': return t('host.ingress.caddyError.downloadFailed', { detail, installUrl });
        case 'validate-failed': return t('host.ingress.caddyError.validateFailed', { detail });
        case 'spawn-failed': return t('host.ingress.caddyError.spawnFailed', { detail });
        default: return t('host.ingress.caddyError.generic', { error: error === '' ? 'unknown' : error, detail });
    }
}
/** Managed Caddy: token → saved config (loopback host, mode + domain +
 * port + optional ACME email) → the plugin's start route, which downloads
 * and validates the binary inside the plugin process. */
async function startCaddy(ctx, sources) {
    const { t, args, ipc } = ctx;
    const out = ctx.stdout;
    const domain = await resolveDomain(ctx, sources.wizard);
    if (domain === null)
        return 1;
    const httpsPort = args.options.httpsPort ?? (typeof sources.wizard?.httpsPort === 'number' ? sources.wizard.httpsPort : 443);
    const email = args.options.email;
    if (!(await saveCfTokenIfProvided(ctx)))
        return 1;
    if (!(await askCfTokenIfUnconfigured(ctx, sources.wizard)))
        return 1;
    if (!(await writeConfigOrReport(ctx, {
        role: 'host',
        host: '127.0.0.1',
        ingressMode: 'caddy',
        ingressDomain: domain,
        ingressHttpsPort: httpsPort,
        ...(email !== undefined && email !== '' ? { ingressAcmeEmail: email } : {}),
    })))
        return 1;
    const start = await ipc.request('POST', WIZARD_CADDY_START_ROUTE);
    const body = plainOf(start.body);
    if (start.status !== 200 || body?.ok !== true) {
        out.write(`${startFailedCaddy(t, body)}\n`);
        return 1;
    }
    if (args.options.json) {
        out.write(`${JSON.stringify({ ok: true, mode: 'caddy' }, null, 2)}\n`);
        return 0;
    }
    out.write(`${t('host.ingress.started', { mode: 'caddy' })}\n`);
    return 0;
}
function tunnelFailureLine(t, key, body) {
    const reason = typeof body?.reason === 'string' && body.reason !== '' ? body.reason : 'unknown';
    return t(key, { reason });
}
/** Managed Cloudflare Tunnel: token → zone check → saved config → the
 * tunnel setup (create, or adopt an existing same-name tunnel after an
 * interactive confirm). */
async function startCloudflared(ctx, sources) {
    const { t, args, ipc } = ctx;
    const out = ctx.stdout;
    const domain = await resolveDomain(ctx, sources.wizard);
    if (domain === null)
        return 1;
    if (!(await saveCfTokenIfProvided(ctx)))
        return 1;
    if (!(await askCfTokenIfUnconfigured(ctx, sources.wizard, 'cloudflared')))
        return 1;
    const check = await ipc.request('POST', WIZARD_TUNNEL_CHECK_ROUTE, { domain });
    const checkBody = plainOf(check.body);
    if (check.status !== 200 || checkBody?.ok !== true) {
        out.write(`${tunnelFailureLine(t, 'host.ingress.tunnelCheckFailed', checkBody)}\n`);
        if (checkBody?.reason === 'auth' || checkBody?.reason === 'zone-not-found') {
            out.write(`${t('setup.cfTokenGuide.title')}\n${t('setup.cfTokenGuide.tunnel')}\n`);
        }
        return 1;
    }
    if (!(await writeConfigOrReport(ctx, {
        role: 'host',
        host: '127.0.0.1',
        ingressMode: 'cloudflared',
        ingressDomain: domain,
    })))
        return 1;
    const tunnelId = args.options.tunnelId;
    let setup = await ipc.request('POST', WIZARD_TUNNEL_SETUP_ROUTE, {
        domain,
        ...(tunnelId !== undefined && tunnelId !== '' ? { tunnelId } : {}),
    });
    let setupBody = plainOf(setup.body);
    if (setup.status !== 200 || setupBody?.ok !== true) {
        if (setupBody?.reason === 'tunnel-conflict') {
            const existing = Array.isArray(setupBody.existing)
                ? setupBody.existing.map((entry) => plainOf(entry)).filter((entry) => entry !== null)
                : [];
            const existingId = typeof existing[0]?.id === 'string' ? existing[0].id : '';
            if (existingId !== '') {
                if (ctx.interactive && ctx.prompter !== undefined) {
                    const reuse = await ctx.prompter.confirm(t('setup.tunnelConflict', { tunnelId: existingId }), true);
                    if (reuse) {
                        setup = await ipc.request('POST', WIZARD_TUNNEL_SETUP_ROUTE, { domain, tunnelId: existingId });
                        setupBody = plainOf(setup.body);
                    }
                }
                else {
                    out.write(`${t('host.ingress.tunnelConflictNonInteractive', { tunnelId: existingId })}\n`);
                }
            }
        }
        if (setup.status !== 200 || setupBody?.ok !== true) {
            out.write(`${tunnelFailureLine(t, 'host.ingress.tunnelSetupFailed', setupBody)}\n`);
            if (setupBody?.reason === 'auth' || setupBody?.reason === 'zone-not-found') {
                out.write(`${t('setup.cfTokenGuide.title')}\n${t('setup.cfTokenGuide.tunnel')}\n`);
            }
            return 1;
        }
    }
    const settled = setupBody;
    const startedTunnelId = typeof settled.tunnelId === 'string' ? settled.tunnelId : '';
    const tunnelPublicUrl = typeof settled.publicUrl === 'string' ? settled.publicUrl : '';
    if (args.options.json) {
        out.write(`${JSON.stringify({
            ok: true,
            mode: 'cloudflared',
            ...(startedTunnelId === '' ? {} : { tunnelId: startedTunnelId }),
            ...(tunnelPublicUrl === '' ? {} : { publicUrl: tunnelPublicUrl }),
        }, null, 2)}\n`);
        return 0;
    }
    out.write(`${t('host.ingress.started', { mode: 'cloudflared' })}\n`);
    return 0;
}
/** External reverse proxy: validate the https origin, save it, print the
 * snippets, and offer the detected untrusted-proxy IP to the trust list
 * (automatically headlessly, confirmed interactively). */
async function startExternal(ctx, sources) {
    const { t, args, ipc } = ctx;
    const out = ctx.stdout;
    let provided = args.options.publicUrl;
    if (provided === undefined || provided === '') {
        const saved = typeof sources.wizard?.publicUrl === 'string' && sources.wizard.publicUrl !== '' ? sources.wizard.publicUrl : undefined;
        if (saved !== undefined)
            provided = saved;
    }
    if (provided === undefined || provided === '') {
        provided = await askText(ctx, 'public-url', t('setup.publicUrlQuestion'));
    }
    const normalized = normalizeServerUrl(provided);
    if (!normalized.ok) {
        out.write(`${t(normalized.reason === 'insecure-http' ? 'client.error.insecureHttp' : 'client.error.urlInvalid')}\n`);
        return 1;
    }
    // External means a real reverse proxy in front: plain http has no
    // X-Forwarded-Proto story at all.
    if (!normalized.url.startsWith('https://')) {
        out.write(`${t('client.error.insecureHttp')}\n`);
        return 1;
    }
    if (!(await writeConfigOrReport(ctx, {
        role: 'host',
        ingressMode: 'external',
        ingressPublicUrl: normalized.url,
    })))
        return 1;
    // The external flow prints material for ALL three proxies (unless the
    // user named one) — a mid-flow flavor question would just be noise.
    const proxy = args.options.proxy;
    if (proxy !== undefined && !PROXY_KINDS.includes(proxy)) {
        out.write(`${t('host.ingress.error.badProxy', { value: proxy })}\n`);
        return 1;
    }
    const kinds = proxy !== undefined ? [proxy] : ['nginx', 'caddy', 'lucky'];
    const snippetDomain = typeof sources.wizard?.domain === 'string' && sources.wizard.domain !== '' ? sources.wizard.domain : 'dsh.example.com';
    for (const kind of kinds) {
        if (!printSnippet(ctx, kind, snippetDomain, gatewayPortOf(sources.wizard, sources.admin)))
            return 1;
    }
    const forwarded = plainOf(sources.wizard?.lastForwardedSource);
    const ip = typeof forwarded?.ip === 'string' ? forwarded.ip : '';
    if (ip !== '') {
        const trust = async () => {
            const result = await ipc.request('POST', WIZARD_TRUST_PROXY_ROUTE, { ip });
            const body = plainOf(result.body);
            return result.status === 200 && body?.ok === true;
        };
        if (ctx.interactive && ctx.prompter !== undefined) {
            const sure = await ctx.prompter.confirm(t('host.ingress.trustProxyQuestion', { ip }), true);
            if (sure) {
                if (!(await trust())) {
                    out.write(`${t('host.ingress.trustProxyFailed')}\n`);
                    return 1;
                }
                out.write(`${t('host.ingress.trustProxyDone', { ip })}\n`);
            }
        }
        else {
            // Headless / --yes: the detection is not actionable any other way —
            // trust the proxy automatically and say so.
            if (!(await trust())) {
                out.write(`${t('host.ingress.trustProxyFailed')}\n`);
                return 1;
            }
            out.write(`${t('host.ingress.trustProxyAuto', { ip })}\n`);
        }
    }
    if (args.options.json) {
        out.write(`${JSON.stringify({ ok: true, mode: 'external', publicUrl: normalized.url }, null, 2)}\n`);
        return 0;
    }
    out.write(`${t('host.ingress.started', { mode: 'external' })}\n`);
    return 0;
}
/** LAN / Tailscale direct: rebind the gateway to 0.0.0.0, clear the
 * managed ingress mode, and wait (bounded) for the restarted gateway to
 * answer the admin status again on 0.0.0.0. */
async function startLan(ctx, sources) {
    const { t, args } = ctx;
    const out = ctx.stdout;
    const port = gatewayPortOf(sources.wizard, sources.admin);
    let lanUrl = args.options.publicUrl;
    if (lanUrl === undefined || lanUrl === '') {
        const rawCandidates = Array.isArray(sources.wizard?.lanAddresses) ? sources.wizard.lanAddresses : [];
        const candidates = rawCandidates
            .map((item) => plainOf(item))
            .filter((item) => item !== null && typeof item.ip === 'string' && item.ip !== '');
        if (candidates.length > 1 && ctx.interactive && ctx.prompter !== undefined) {
            const labels = [
                ...candidates.map((c) => {
                    const tag = c.kind === 'tailscale' ? 'Tailscale' : 'LAN';
                    const iface = typeof c.iface === 'string' && c.iface !== '' ? ` · ${c.iface}` : '';
                    return `http://${String(c.ip)}:${port} (${tag}${iface})`;
                }),
                t('host.ingress.lanPickCustom'),
            ];
            const picked = await ctx.prompter.selectOne(t('host.ingress.lanPickQuestion'), labels, 0);
            const chosen = candidates[picked];
            if (chosen !== undefined) {
                lanUrl = `http://${String(chosen.ip)}:${port}`;
            }
            else {
                lanUrl = await askText(ctx, 'public-url', t('setup.publicUrlQuestion'));
            }
        }
        else if (candidates.length === 1) {
            lanUrl = `http://${String(candidates[0].ip)}:${port}`;
        }
        else {
            const lan = typeof sources.wizard?.lanAddress === 'string' && sources.wizard.lanAddress !== '' ? sources.wizard.lanAddress : '';
            if (lan !== '') {
                lanUrl = `http://${lan}:${port}`;
            }
            else {
                lanUrl = await askText(ctx, 'public-url', t('setup.publicUrlQuestion'));
            }
        }
    }
    if (!(await writeConfigOrReport(ctx, {
        role: 'host',
        host: '0.0.0.0',
        ingressMode: 'off',
        ingressPublicUrl: lanUrl,
    })))
        return 1;
    const waitSeconds = Math.max(1, args.options.wait);
    out.write(`${t('host.ingress.lanWaiting', { seconds: waitSeconds })}\n`);
    const interval = ctx.pollIntervalMs ?? LAN_POLL_INTERVAL_DEFAULT_MS;
    const deadline = Date.now() + waitSeconds * 1000;
    const checkHostField = typeof sources.wizard?.gatewayActualHost === 'string';
    await sleep(interval); // the restart watcher needs a beat to see the rebind
    while (true) {
        const admin = await fetchRecord(ctx, 'GET', ADMIN_STATUS_ROUTE);
        if (admin?.gatewayReachable === true) {
            if (!checkHostField)
                break;
            const latestWizard = await fetchRecord(ctx, 'GET', WIZARD_STATUS_ROUTE);
            const actualHost = latestWizard?.gatewayActualHost;
            if (actualHost === undefined || actualHost === '0.0.0.0' || actualHost === '::')
                break;
        }
        if (Date.now() >= deadline) {
            out.write(`${t('host.ingress.lanTimeout', { seconds: waitSeconds })}\n`);
            return 1;
        }
        await sleep(interval);
    }
    if (args.options.json) {
        out.write(`${JSON.stringify({ ok: true, mode: 'lan', publicUrl: lanUrl }, null, 2)}\n`);
        return 0;
    }
    out.write(`${t('host.ingress.started', { mode: 'lan' })}\n`);
    return 0;
}
/**
 * `host ingress start [--mode …] …` — the four ingress modes, all driven
 * through the plugin's wizard routes. The mode comes from the flags, then
 * the saved config, then the interactive question; before the new mode's
 * flow runs, every managed process that does not belong to it is stopped
 * through its own stop route (GatewayWizard.tsx's discipline).
 */
export async function runHostIngressStartCommand(ctx) {
    if (!(await requireServesRole(ctx)))
        return 1;
    const { t, args } = ctx;
    const out = ctx.stdout;
    try {
        const sources = {
            wizard: await fetchRecord(ctx, 'GET', WIZARD_STATUS_ROUTE),
            admin: await fetchRecord(ctx, 'GET', ADMIN_STATUS_ROUTE),
        };
        let mode = args.options.mode ?? args.options.ingress;
        if (mode === undefined) {
            const saved = typeof sources.wizard?.mode === 'string' && INGRESS_MODES.includes(sources.wizard.mode)
                ? sources.wizard.mode
                : undefined;
            if (saved !== undefined)
                mode = saved;
        }
        if (mode === undefined) {
            if (ctx.interactive && ctx.prompter !== undefined) {
                const picked = await ctx.prompter.selectOne(t('setup.ingressQuestion'), [t('setup.ingressCaddy'), t('setup.ingressCloudflared'), t('setup.ingressExternal'), t('setup.ingressLan')], 0);
                mode = ['caddy', 'cloudflared', 'external', 'lan'][picked];
            }
            else {
                throw new MissingRequiredOptionError('mode');
            }
        }
        if (!INGRESS_MODES.includes(mode)) {
            out.write(`${t('host.ingress.error.badMode', { value: mode })}\n`);
            return 1;
        }
        // Mode-switch cleanup: an old tunnel or Caddy child never keeps
        // running across a mode change.
        if (mode !== 'caddy')
            await ctx.ipc.request('POST', WIZARD_CADDY_STOP_ROUTE);
        if (mode !== 'cloudflared')
            await ctx.ipc.request('POST', WIZARD_TUNNEL_STOP_ROUTE);
        if (mode === 'caddy')
            return await startCaddy(ctx, sources);
        if (mode === 'cloudflared')
            return await startCloudflared(ctx, sources);
        if (mode === 'external')
            return await startExternal(ctx, sources);
        return await startLan(ctx, sources);
    }
    catch (error) {
        if (error instanceof MissingRequiredOptionError) {
            out.write(`${t('err.missingOption', { option: error.optionName })}\n`);
            return 1;
        }
        throw error;
    }
}
// ===========================================================================
// host ingress stop
// ===========================================================================
/**
 * `host ingress stop [--yes] [--json]` — stop both managed ingress
 * processes through their stop routes (the CLI owns no process handles to
 * reach for). `--yes` outside a TTY confirm, same discipline as revoke.
 */
export async function runHostIngressStopCommand(ctx) {
    if (!(await requireServesRole(ctx)))
        return 1;
    const { t, args, ipc } = ctx;
    const out = ctx.stdout;
    if (!args.options.yes) {
        if (!ctx.interactive || ctx.prompter === undefined) {
            out.write(`${t('err.missingOption', { option: 'yes' })}\n`);
            return 1;
        }
        const sure = await ctx.prompter.confirm(t('host.ingress.confirmStop'), false);
        if (!sure) {
            out.write(`${t('common.cancel')}\n`);
            return 0;
        }
    }
    const caddy = await ipc.request('POST', WIZARD_CADDY_STOP_ROUTE);
    const tunnel = await ipc.request('POST', WIZARD_TUNNEL_STOP_ROUTE);
    const caddyBody = plainOf(caddy.body);
    const tunnelBody = plainOf(tunnel.body);
    if (caddy.status !== 200 || caddyBody?.ok !== true || tunnel.status !== 200 || tunnelBody?.ok !== true) {
        out.write(`${t('host.ingress.stopFailed')}\n`);
        return 1;
    }
    if (args.options.json) {
        out.write(`${JSON.stringify({ ok: true }, null, 2)}\n`);
        return 0;
    }
    out.write(`${t('host.ingress.stopped')}\n`);
    return 0;
}
// ===========================================================================
// host ingress verify
// ===========================================================================
/** One verify-start failure's two lights: which of the first two checks
 * the failure belongs to. `probe-failed` happens with the gateway already
 * reachable (light 1 on, light 2 off); `pair-refused` happens with the
 * probe already passed (both on). */
function renderVerifyFailure(ctx, reason, detail) {
    const { t } = ctx;
    const out = ctx.stdout;
    const pass = t('common.done');
    const fail = t('host.ingress.lightFail');
    if (reason === 'probe-failed') {
        out.write(`${t('setup.verifyLight1', { state: pass })}\n`);
        out.write(`${t('setup.verifyLight2', { state: fail })}\n`);
    }
    else if (reason === 'pair-refused') {
        out.write(`${t('setup.verifyLight1', { state: pass })}\n`);
        out.write(`${t('setup.verifyLight2', { state: pass })}\n`);
    }
    else {
        out.write(`${t('setup.verifyLight1', { state: fail })}\n`);
        out.write(`${t('setup.verifyLight2', { state: fail })}\n`);
    }
    switch (reason) {
        case 'no-public-url':
            out.write(`${t('host.ingress.verifyReason.noPublicUrl')}\n`);
            break;
        case 'bad-public-url':
            out.write(`${t('host.ingress.verifyReason.badPublicUrl')}\n`);
            break;
        case 'runtime-not-ready':
            out.write(`${t('host.ingress.verifyReason.runtimeNotReady')}\n`);
            break;
        case 'gateway-unreachable':
            out.write(`${t('host.ingress.verifyReason.gatewayUnreachable')}\n`);
            break;
        case 'probe-failed':
            out.write(`${t('host.ingress.verifyReason.probeFailed')}\n`);
            break;
        case 'pair-refused': {
            const status = typeof detail === 'number' || typeof detail === 'string' ? String(detail) : '';
            out.write(`${t('host.ingress.verifyReason.pairRefused', { detail: status })}\n`);
            break;
        }
        default:
            out.write(`${t('host.ingress.verifyReason.generic', { reason })}\n`);
            break;
    }
}
/**
 * `host ingress verify [--public-url <origin>] [--no-wait] [--json]` — the
 * three-light check, driven entirely by the plugin's verify orchestration:
 * POST mints the code and walks the public URL (lights 1 + 2), GET polls
 * for the real phone pairing (light 3). `--no-wait` / `--json` stop after
 * the first two lights; an aborted signal (the entry point's Ctrl-C seam)
 * skips the wait gracefully with exit code 0 — the first two lights'
 * verdict is already on the record.
 */
export async function runHostIngressVerifyCommand(ctx) {
    if (!(await requireServesRole(ctx)))
        return 1;
    const { t, args, ipc } = ctx;
    const out = ctx.stdout;
    try {
        const [wizard, admin] = await Promise.all([
            fetchRecord(ctx, 'GET', WIZARD_STATUS_ROUTE),
            fetchRecord(ctx, 'GET', ADMIN_STATUS_ROUTE),
        ]);
        let publicUrl = args.options.publicUrl;
        if (publicUrl === undefined || publicUrl === '')
            publicUrl = publicUrlOf(wizard, admin);
        if (publicUrl === undefined || publicUrl === '') {
            publicUrl = await askText(ctx, 'public-url', t('setup.publicUrlQuestion'));
        }
        let start = await ipc.request('POST', WIZARD_VERIFY_ROUTE, { publicUrl });
        let startBody = plainOf(start.body);
        let started = start.status === 200 && startBody?.ok === true;
        // In LAN / Tailscale mode (`http://` private/Tailscale origin), the original
        // DSH Web UI only listens on 127.0.0.1, so the user cannot open the Web UI
        // to see a pairing code — the CLI is the ONLY place that can output it. If
        // the local gateway is up (Light 1 ready) but the machine's self-probe of
        // its own LAN/Tailscale IP hit a virtual-interface hairpin or routing
        // restriction (`probe-failed`), fall back to `allowUnprobed: true` so the
        // pairing code and QR are still minted for real device verification.
        if (!started && startBody?.reason === 'probe-failed' && publicUrl.startsWith('http://')) {
            const retry = await ipc.request('POST', WIZARD_VERIFY_ROUTE, { publicUrl, allowUnprobed: true });
            const retryBody = plainOf(retry.body);
            if (retry.status === 200 && retryBody?.ok === true) {
                start = retry;
                startBody = retryBody;
                started = true;
            }
        }
        if (args.options.json) {
            // --json is a machine-readable run: the structured verdict, no
            // interactive wait either way.
            if (!started || startBody === null) {
                const reason = typeof startBody?.reason === 'string' && startBody.reason !== '' ? startBody.reason : 'internal';
                out.write(`${JSON.stringify({ ok: false, reason }, null, 2)}\n`);
                return 1;
            }
            out.write(`${JSON.stringify({
                ok: true,
                publicUrl: typeof startBody.publicUrl === 'string' && startBody.publicUrl !== '' ? startBody.publicUrl : publicUrl,
                pairingCode: typeof startBody.pairingCode === 'string' ? startBody.pairingCode : '',
                expiresAt: typeof startBody.expiresAt === 'number' ? startBody.expiresAt : 0,
            }, null, 2)}\n`);
            return 0;
        }
        out.write(`${t('host.ingress.verifyTitle', { publicUrl })}\n`);
        if (!started || startBody === null) {
            const reason = typeof startBody?.reason === 'string' && startBody.reason !== '' ? startBody.reason : 'internal';
            renderVerifyFailure(ctx, reason, startBody?.detail);
            return 1;
        }
        const code = typeof startBody.pairingCode === 'string' ? startBody.pairingCode : '';
        const desktopCode = typeof startBody.desktopPairingCode === 'string' ? startBody.desktopPairingCode : '';
        const verifiedUrl = typeof startBody.publicUrl === 'string' && startBody.publicUrl !== '' ? startBody.publicUrl : publicUrl;
        out.write(`${t('setup.verifyLight1', { state: t('common.done') })}\n`);
        if (startBody.probeWarning !== undefined) {
            out.write(`${t('host.ingress.verifyLanProbeWarn')}\n`);
        }
        else {
            out.write(`${t('setup.verifyLight2', { state: t('common.done') })}\n`);
        }
        if (verifiedUrl !== '') {
            out.write(`\n${t('setup.pairingQr')}\n`);
            const qr = renderTerminalQr(verifiedUrl);
            if (qr !== null)
                out.write(`${qr}\n`);
            out.write(`  ${verifiedUrl}\n`);
        }
        out.write(`\n${t('setup.divider')}\n`);
        out.write(`  ${t('setup.pairingCode', { code })}\n`);
        if (desktopCode !== '') {
            out.write(`  ${t('setup.desktopPairingCode', { code: desktopCode })}\n`);
            if (verifiedUrl !== '') {
                out.write(`  ${t('setup.desktopPairingCmd', { url: verifiedUrl, code: desktopCode })}\n`);
            }
        }
        out.write(`${t('setup.divider')}\n`);
        if (args.options.noWait) {
            out.write(`${t('host.ingress.verifySkipped')}\n`);
            return 0;
        }
        out.write(`${t('setup.pairingWait')}\n`);
        const interval = ctx.pollIntervalMs ?? VERIFY_POLL_INTERVAL_DEFAULT_MS;
        while (true) {
            if (ctx.abortSignal?.aborted) {
                out.write(`${t('host.ingress.verifySkipped')}\n`);
                return 0;
            }
            await sleep(interval);
            let checkBody = null;
            try {
                const check = await ipc.request('GET', WIZARD_VERIFY_ROUTE);
                checkBody = plainOf(check.body);
            }
            catch {
                continue; // one lost poll is not a verdict — keep waiting
            }
            if (ctx.abortSignal?.aborted) {
                out.write(`${t('host.ingress.verifySkipped')}\n`);
                return 0;
            }
            const result = typeof checkBody?.result === 'string' ? checkBody.result : '';
            if (result === 'pass') {
                out.write(`${t('setup.verifyLight3', { state: t('common.done') })}\n`);
                out.write(`${t('setup.pairingDone')}\n`);
                // Persist the verified URL so a later `status` shows it (a failed
                // write is a warning — the verification itself already passed).
                const written = await ctx.ipc.writeConfig({ set: { ingressPublicUrl: verifiedUrl } });
                const writtenBody = plainOf(written.body);
                if (written.status !== 200 || writtenBody?.ok !== true) {
                    out.write(`${t('host.ingress.configWriteFailed')}\n`);
                }
                return 0;
            }
            if (result === 'cookie-insecure') {
                out.write(`${t('host.ingress.verifyCookieInsecure')}\n`);
                return 1;
            }
            if (result === 'code-expired') {
                out.write(`${t('host.ingress.verifyExpired')}\n`);
                return 1;
            }
            if (result === 'stale') {
                out.write(`${t('host.ingress.verifyStale')}\n`);
                return 1;
            }
            // pending / not-started / unrecognized: keep polling until the code's
            // own expiry (the orchestration answers code-expired then).
        }
    }
    catch (error) {
        if (error instanceof MissingRequiredOptionError) {
            out.write(`${t('err.missingOption', { option: error.optionName })}\n`);
            return 1;
        }
        throw error;
    }
}
//# sourceMappingURL=commands-host.js.map