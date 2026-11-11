/**
 * CLI-5: the `setup` end-to-end wizard — the web three-step wizard
 * (`GatewayWizard.tsx`) rendered onto a terminal, in one interactive /
 * parametric state machine: command-line-provided answers are taken as-is,
 * missing ones are asked in a TTY run and raise MissingRequiredOptionError
 * in a `--yes` / headless run.
 *
 * Preflight (SPEC §4) runs FIRST and always: discover the plugin's IPC
 * socket — when nothing live answers (or `--profile` was given explicitly)
 * the multi-select profile install runs, then `ensureDshRunning` brings a
 * DSH up (daemon trigger + bounded poll). Everything after that goes through
 * THAT live IPC client.
 *
 * Step 1 is the role. Switching mirrors GatewayWizard.tsx's discipline
 * exactly: anything → client stops the managed Caddy / Cloudflare tunnel
 * through their IPC stop routes BEFORE writing `role: 'client'` (a peer
 * serves the gateway too, so peer → client stops them as well), then polls
 * ping until `connects`; → host writes `role: 'host'` and polls until
 * `serves`; → peer writes `role: 'peer'` and polls until the peer surface
 * answers — NEVER stopping the managed ingress children, because
 * `servesRole('peer')` stays true and the phone gateway channel survives
 * (the row reloads under the CLI — the hot-swap socket never drops).
 *
 * Steps 2 & 3 are NOT reimplementations: the host branch drives
 * `runHostIngressStartCommand` / `runHostIngressVerifyCommand` (mode
 * switch cleanup, snippets, three lights, QR) and the client branch drives
 * `runClientPairCommand` / `runClientUnpairCommand` (claim, handshake lights,
 * removal) — the same code `host *` / `client *` use, over a synthesized
 * argv. `setup`'s own additions are only the flow around them: the
 * keep-current-config choice, the two-question recommendation funnel, the
 * retry menu after a failed verification, the desktop-client pairing
 * follow-up, and the paired-host management menu.
 */
import { parseCliArgs } from './args.js';
import { ensureDshRunning, ensurePluginInstalled, MissingRequiredOptionError } from './bootstrap.js';
import { discoverCliSockets } from './ipc-client.js';
import { CLI_PROTOCOL_VERSION } from './ipc-server.js';
import { fetchBody, plainOf, serverLineText } from './commands-status.js';
import { runHostDevicePairCommand, runHostIngressStartCommand, runHostIngressVerifyCommand, writeConfigOrReport, } from './commands-host.js';
import { runClientPairCommand, runClientUnpairCommand } from './commands-client.js';
import { runPeerJoinCommand } from './commands-peer.js';
import { WIZARD_STATUS_ROUTE, WIZARD_CADDY_STOP_ROUTE, WIZARD_TUNNEL_STOP_ROUTE } from '../wizard/routes.js';
import { CLIENT_STATUS_ROUTE, CLIENT_PEER_STATUS_ROUTE } from '../client-routes.js';
const INGRESS_MODES = ['caddy', 'cloudflared', 'external', 'lan'];
/** The role-switch ping poll: frequent by default, tests shrink it. */
const ROLE_POLL_INTERVAL_DEFAULT_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// ===========================================================================
// Small helpers
// ===========================================================================
/** A command context for one of the driven subcommands: same translator,
 * interactivity, prompter and seams, fresh args from a synthesized argv. */
function commandCtx(ctx, argv, ipc) {
    return {
        args: parseCliArgs(argv),
        ipc,
        t: ctx.t,
        interactive: ctx.interactive,
        ...(ctx.prompter === undefined ? {} : { prompter: ctx.prompter }),
        stdout: ctx.stdout,
        ...(ctx.now === undefined ? {} : { now: ctx.now }),
        ...(ctx.cwd === undefined ? {} : { cwd: ctx.cwd }),
        ...(ctx.pollIntervalMs === undefined ? {} : { pollIntervalMs: ctx.pollIntervalMs }),
        ...(ctx.abortSignal === undefined ? {} : { abortSignal: ctx.abortSignal }),
    };
}
/** The user's setup options, re-issued as argv for the driven subcommands —
 * the inner flows read the SAME values (`--domain`, `--cf-token`,
 * `--no-wait`, …) they would have read from a direct `host` / `client` /
 * `peer` invocation. */
function carryOptionArgs(options) {
    const argv = [];
    if (options.wait !== 20)
        argv.push('--wait', String(options.wait));
    if (options.noWait)
        argv.push('--no-wait');
    if (options.domain !== undefined)
        argv.push('--domain', options.domain);
    if (options.cfToken !== undefined)
        argv.push('--cf-token', options.cfToken);
    if (options.email !== undefined)
        argv.push('--email', options.email);
    if (options.httpsPort !== undefined)
        argv.push('--https-port', String(options.httpsPort));
    if (options.publicUrl !== undefined)
        argv.push('--public-url', options.publicUrl);
    if (options.tunnelId !== undefined)
        argv.push('--tunnel-id', options.tunnelId);
    if (options.proxy !== undefined)
        argv.push('--proxy', options.proxy);
    if (options.hostUrl !== undefined)
        argv.push('--host-url', options.hostUrl);
    if (options.code !== undefined)
        argv.push('--code', options.code);
    if (options.name !== undefined)
        argv.push('--name', options.name);
    if (options.invite !== undefined)
        argv.push('--invite', options.invite);
    return argv;
}
/** The pool rows of a client/status answer, defensively filtered. */
function serversOfRow(body) {
    const rows = body === null ? [] : Array.isArray(body.servers) ? body.servers : [];
    return rows
        .map((row) => plainOf(row))
        .filter((row) => row !== null);
}
function poolMaxOf(body) {
    return typeof body?.maxServers === 'number' ? body.maxServers : 8;
}
function textOf(row, field) {
    const value = row?.[field];
    return typeof value === 'string' ? value : '';
}
// ===========================================================================
// Preflight: install + launch
// ===========================================================================
/**
 * SPEC §4: discovery first; install (multi-select / `--profile`) only when
 * nothing live answers or `--profile` was given; then bring DSH up and hand
 * back the live IPC client plus its first ping. All failures print their own
 * bilingual guidance and come back as `undefined`.
 */
async function preflight(ctx) {
    const { t, args } = ctx;
    const out = ctx.stdout;
    const options = args.options;
    const discover = ctx.discover ?? discoverCliSockets;
    const discoverOptions = {
        dshHome: ctx.dshHome,
        ...(options.socket === undefined ? {} : { explicitSocket: options.socket }),
        platform: ctx.platform ?? process.platform,
    };
    const first = await discover(discoverOptions);
    if (first.live.length === 0 && first.versionMismatch.length > 0) {
        const mismatched = first.versionMismatch[0];
        out.write(`${t('err.protocolVersion', {
            found: String(mismatched?.cliProtocolVersion ?? '?'),
            expected: CLI_PROTOCOL_VERSION,
        })}\n`);
        return undefined;
    }
    // The profile the install decided on feeds the launch: with no daemon to
    // auto-start, the manual guidance must name the profile the user actually
    // picked, not the synthesized `web` default.
    let preferredProfile = 'web';
    if (first.live.length === 0 || options.profile !== undefined) {
        const install = await ensurePluginInstalled({
            dshHome: ctx.dshHome,
            ...(options.profile === undefined ? {} : { profileFlag: options.profile }),
            interactive: ctx.interactive,
            ...(ctx.prompter === undefined ? {} : { prompter: ctx.prompter }),
            ...(ctx.spawnCommand === undefined ? {} : { spawnCommand: ctx.spawnCommand }),
            stdout: out,
            t,
        });
        if (!install.ok)
            return undefined;
        if (install.preferredProfile !== undefined)
            preferredProfile = install.preferredProfile;
    }
    const up = await ensureDshRunning({
        dshHome: ctx.dshHome,
        preferredProfile,
        waitSeconds: options.wait,
        ...(options.socket === undefined ? {} : { explicitSocket: options.socket }),
        ...(ctx.platform === undefined ? {} : { platform: ctx.platform }),
        ...(ctx.uid === undefined ? {} : { uid: ctx.uid }),
        ...(ctx.execProbe === undefined ? {} : { execProbe: ctx.execProbe }),
        discover,
        ...(ctx.macosAppPath === undefined ? {} : { macosAppPath: ctx.macosAppPath }),
        ...(ctx.systemUnitDir === undefined ? {} : { systemUnitDir: ctx.systemUnitDir }),
        stdout: out,
        t,
    });
    if (!up.started)
        return undefined;
    return { ipc: up.client, ping: up.ping };
}
// ===========================================================================
// Step 1: the role
// ===========================================================================
function printStepHeader(ctx, titleKey) {
    const { t, stdout } = ctx;
    stdout.write(`\n${t('setup.divider')}\n${t(titleKey)}\n${t('setup.divider')}\n`);
}
/** Resolve the target role: the flag wins (garbage answered with the
 * bilingual refusal — `host` / `client` / `peer` are all legal since PG-10),
 * an interactive run asks with the current role highlighted, a headless run
 * fails fast on the missing option. */
async function resolveTargetRole(ctx, ping) {
    const { t, args } = ctx;
    const requested = args.options.role;
    if (requested === 'host' || requested === 'client' || requested === 'peer')
        return requested;
    if (requested !== undefined) {
        ctx.stdout.write(`${t('err.role.invalid', { value: requested })}\n`);
        return undefined;
    }
    if (ctx.interactive && ctx.prompter !== undefined) {
        printStepHeader(ctx, 'setup.step1Title');
        const picked = await ctx.prompter.selectOne(t('setup.roleQuestion'), [t('setup.roleHost'), t('setup.roleClient'), t('setup.rolePeer')], ping.role === 'client' ? 1 : ping.role === 'peer' ? 2 : 0);
        return picked === 1 ? 'client' : picked === 2 ? 'peer' : 'host';
    }
    throw new MissingRequiredOptionError('role');
}
// ===========================================================================
// Steps 2 & 3, host branch
// ===========================================================================
/** The four modes' label keys, in INGRESS_MODES order. */
const MODE_LABEL_KEYS = {
    caddy: 'setup.ingressCaddy',
    cloudflared: 'setup.ingressCloudflared',
    external: 'setup.ingressExternal',
    lan: 'setup.ingressLan',
};
/** The two-question funnel: public IP + Cloudflare-hosted domain map onto
 * the four modes (caddy needs both; cloudflared replaces the public IP;
 * external takes a public IP with the proxy the user already owns; lan
 * covers everything else). */
function recommendMode(publicIp, onCloudflare) {
    if (onCloudflare)
        return publicIp ? 'caddy' : 'cloudflared';
    return publicIp ? 'external' : 'lan';
}
async function runHostBranch(ctx, ipc) {
    const { t, args } = ctx;
    const out = ctx.stdout;
    const options = args.options;
    // Step 2: the ingress mode. Explicit --ingress/--mode wins; otherwise the
    // current effective config offers "keep and verify" as choice 0 (in a
    // headless run that keep IS the answer — re-running setup on a configured
    // host must not blow away the working ingress).
    printStepHeader(ctx, 'setup.step2HostTitle');
    const wizard = await fetchBody(() => ipc.request('GET', WIZARD_STATUS_ROUTE));
    const hasIngress = (textOf(wizard, 'mode') !== '' && textOf(wizard, 'mode') !== 'off')
        || textOf(wizard, 'publicUrl') !== '';
    let mode = options.ingress ?? options.mode;
    let keep = false;
    if (mode === undefined) {
        if (ctx.interactive && ctx.prompter !== undefined) {
            const values = [];
            const labels = [];
            if (hasIngress) {
                values.push('keep');
                labels.push(t('setup.ingressKeep'));
            }
            for (const ingressMode of INGRESS_MODES) {
                values.push(ingressMode);
                labels.push(t(MODE_LABEL_KEYS[ingressMode]));
            }
            values.push('recommend');
            labels.push(t('setup.ingressRecommend'));
            const picked = await ctx.prompter.selectOne(t('setup.ingressQuestion'), labels, 0);
            const value = values[picked];
            if (value === 'keep')
                keep = true;
            else if (value === 'recommend') {
                const publicIp = await ctx.prompter.confirm(t('setup.recommend.publicIp'), false);
                const onCloudflare = await ctx.prompter.confirm(t('setup.recommend.cfDomain'), false);
                mode = recommendMode(publicIp, onCloudflare);
                out.write(`${t('setup.recommend.result', { mode })}\n`);
            }
            else {
                mode = value;
            }
        }
        else if (hasIngress) {
            keep = true;
        }
        else {
            throw new MissingRequiredOptionError('mode');
        }
    }
    if (!keep && mode !== undefined) {
        const startCode = await runHostIngressStartCommand(commandCtx(ctx, ['host', 'ingress', 'start', '--mode', mode, ...carryOptionArgs(options)], ipc));
        if (startCode !== 0)
            return startCode;
    }
    // Step 3: the three-light verification, with the interactive retry menu
    // when the first two lights fail (a headless run just reports).
    printStepHeader(ctx, 'setup.step3HostTitle');
    while (true) {
        const verifyCode = await runHostIngressVerifyCommand(commandCtx(ctx, ['host', 'ingress', 'verify', ...carryOptionArgs(options)], ipc));
        if (verifyCode === 0)
            break;
        if (!ctx.interactive || ctx.prompter === undefined)
            return verifyCode;
        const picked = await ctx.prompter.selectOne(t('setup.verifyFailedOptions'), [t('setup.verifyRetry'), t('setup.verifyKeepExit')], 0);
        if (picked !== 0)
            return verifyCode;
    }
    // The desktop-client follow-up: one confirm, one minted desktop code.
    if (ctx.interactive && ctx.prompter !== undefined && !options.noWait) {
        if (await ctx.prompter.confirm(t('setup.desktopPairQuestion'), false)) {
            await runHostDevicePairCommand(commandCtx(ctx, ['host', 'device', 'pair', '--device-role', 'desktop-client'], ipc));
        }
    }
    // Completion summary: the wizard status as it stands NOW.
    const settled = await fetchBody(() => ipc.request('GET', WIZARD_STATUS_ROUTE));
    const settledMode = textOf(settled, 'mode') === '' ? 'off' : textOf(settled, 'mode');
    const settledUrl = textOf(settled, 'publicUrl');
    out.write(`\n${t('setup.divider')}\n`);
    out.write(`${t('setup.summary.title')}\n`);
    out.write(`${t('setup.summary.role', { role: 'host' })}\n`);
    out.write(`${t('setup.summary.ingress', { mode: settledMode, publicUrl: settledUrl === '' ? '—' : settledUrl })}\n`);
    out.write(`${t('setup.summary.hint')}\n`);
    out.write(`${t('setup.divider')}\n`);
    return 0;
}
// ===========================================================================
// Steps 2 & 3, client branch
// ===========================================================================
function printClientList(ctx, servers, max) {
    const { t } = ctx;
    ctx.stdout.write(`${t('clientList.header', { count: servers.length, max })}\n`);
    if (servers.length >= max)
        ctx.stdout.write(`  ${t('client.limitReached')}\n`);
    for (const row of servers)
        ctx.stdout.write(`  ${serverLineText(t, row)}\n`);
}
async function runClientBranch(ctx, ipc) {
    const { t, args } = ctx;
    const out = ctx.stdout;
    const options = args.options;
    printStepHeader(ctx, 'setup.step2ClientTitle');
    // Command-line pairing answers short-circuit the menu entirely. The address
    // may come as the positional (`setup <hostUrl>`) or the flag — the flag
    // wins when both appear.
    const hostUrl = options.hostUrl ?? args.target;
    const providedPair = hostUrl !== undefined && options.code !== undefined;
    const pairArgv = ['client', 'pair', ...carryOptionArgs(options)];
    if (options.hostUrl === undefined && hostUrl !== undefined)
        pairArgv.push('--host-url', hostUrl);
    // The straight-into-pairing rule (N === 0) describes the ENTRY state; after
    // a menu action the menu itself is the place to be — exiting stays the
    // user's explicit choice, never an uninvited question flow.
    let firstLap = true;
    while (true) {
        const status = await fetchBody(() => ipc.request('GET', CLIENT_STATUS_ROUTE));
        const servers = serversOfRow(status);
        const max = poolMaxOf(status);
        // N === 0 on entry (or a fully parametric pair): straight into pairing.
        if (providedPair || (firstLap && servers.length === 0)) {
            const pairCode = await runClientPairCommand(commandCtx(ctx, pairArgv, ipc));
            if (pairCode !== 0)
                return pairCode;
            if (ctx.interactive && ctx.prompter !== undefined) {
                if (await ctx.prompter.confirm(t('client.addAnother'), false)) {
                    firstLap = false;
                    continue;
                }
            }
            break;
        }
        firstLap = false;
        printClientList(ctx, servers, max);
        // N > 0 headless (no answers, nothing to do): show the list and finish.
        if (!ctx.interactive || ctx.prompter === undefined)
            break;
        // The menu: an empty pool (everything was removed) offers add + done; a
        // full pool (8/8) tops with repair / remove per SPEC; otherwise the
        // four-way menu with add as the default first choice.
        const atLimit = servers.length >= max;
        const values = servers.length === 0 ? ['add', 'done'] : atLimit ? ['repair', 'remove', 'done'] : ['add', 'repair', 'remove', 'done'];
        const labelKeys = servers.length === 0
            ? ['client.menuAdd', 'client.menuDone']
            : atLimit
                ? ['client.menuRepair', 'client.menuRemove', 'client.menuDone']
                : ['client.menuAdd', 'client.menuRepair', 'client.menuRemove', 'client.menuDone'];
        const labels = labelKeys.map((key) => t(key));
        const picked = await ctx.prompter.selectOne(t('client.menuTitle'), labels, 0);
        const value = values[picked] ?? 'done';
        if (value === 'done')
            break;
        if (value === 'add') {
            const pairCode = await runClientPairCommand(commandCtx(ctx, pairArgv, ipc));
            if (pairCode !== 0)
                return pairCode;
            // One more only while the pool still has room — at 8/8 the menu's
            // limit branch takes over on the next lap anyway.
            if (servers.length + 1 < max && ctx.interactive && ctx.prompter !== undefined) {
                if (!(await ctx.prompter.confirm(t('client.addAnother'), false)))
                    break;
            }
            continue;
        }
        if (value === 'repair') {
            const rowIndex = await ctx.prompter.selectOne(t('setup.clientRepairQuestion'), servers.map((row) => serverLineText(t, row)), 0);
            const row = servers[rowIndex];
            const repairUrl = textOf(row, 'serverUrl');
            if (repairUrl === '')
                continue;
            const repairCode = await runClientPairCommand(commandCtx(ctx, [...pairArgv, '--host-url', repairUrl], ipc));
            if (repairCode !== 0)
                return repairCode;
            continue;
        }
        // remove
        const removeCode = await runClientUnpairCommand(commandCtx(ctx, ['client', 'unpair'], ipc));
        if (removeCode !== 0)
            return removeCode;
    }
    // Completion summary: the pool as it stands NOW.
    const settled = await fetchBody(() => ipc.request('GET', CLIENT_STATUS_ROUTE));
    const settledServers = serversOfRow(settled);
    out.write(`\n${ctx.t('setup.divider')}\n`);
    out.write(`${ctx.t('setup.summary.title')}\n`);
    out.write(`${ctx.t('setup.summary.role', { role: 'client' })}\n`);
    out.write(`${ctx.t('setup.summary.client', { count: settledServers.length, max: poolMaxOf(settled) })}\n`);
    out.write(`${ctx.t('setup.summary.hint')}\n`);
    out.write(`${ctx.t('setup.divider')}\n`);
    return 0;
}
// ===========================================================================
// Steps 2 & 3, peer branch
// ===========================================================================
/**
 * The peer branch: collect the invite link (with the keep-current-network
 * offer when this machine is already in one), drive `peer join` (the SAME
 * command the `peer` family uses — invite validation, optional name, the
 * join POST and the bounded admission wait), then summarize the node state
 * next to the local gateway state.
 */
async function runPeerBranch(ctx, ipc) {
    const { t, args } = ctx;
    const out = ctx.stdout;
    const options = args.options;
    printStepHeader(ctx, 'setup.step2PeerTitle');
    const invite = options.invite ?? args.target;
    const current = await fetchBody(() => ipc.request('GET', CLIENT_PEER_STATUS_ROUTE));
    const alreadyIn = current?.configured === true;
    const keepCurrent = alreadyIn && invite === undefined && ctx.interactive && ctx.prompter !== undefined
        ? await ctx.prompter.confirm(t('setup.peerKeepQuestion'), true)
        : alreadyIn && invite === undefined; // headless without an invite: keep what works
    if (!keepCurrent) {
        // The SAME join flow `peer join` uses; the invite rides the positional
        // or the carried `--invite`, so the inner flow reads the same values.
        const pairArgv = ['peer', 'join', ...carryOptionArgs(options)];
        if (options.invite === undefined && invite !== undefined)
            pairArgv.push(invite);
        const joinCode = await runPeerJoinCommand(commandCtx(ctx, pairArgv, ipc));
        if (joinCode !== 0)
            return joinCode;
    }
    // Completion summary: the node + gateway state as it stands NOW.
    const [settled, wizard] = await Promise.all([
        fetchBody(() => ipc.request('GET', CLIENT_PEER_STATUS_ROUTE)),
        fetchBody(() => ipc.request('GET', WIZARD_STATUS_ROUTE)),
    ]);
    const settledState = settled?.configured === true
        ? `${t(`peer.gateway.${typeof settled.gatewayState === 'string' ? settled.gatewayState : 'offline'}`)} · ${typeof settled.networkId === 'string' ? settled.networkId : ''}`
        : t('peer.status.notJoined');
    const mode = textOf(wizard, 'mode') === '' ? 'off' : textOf(wizard, 'mode');
    out.write(`\n${t('setup.divider')}\n`);
    out.write(`${t('setup.summary.title')}\n`);
    out.write(`${t('setup.summary.role', { role: 'peer' })}\n`);
    out.write(`${t('setup.summary.peer', { state: settledState })}\n`);
    out.write(`${t('setup.summary.peerGateway', { mode })}\n`);
    out.write(`${t('setup.summary.peerHint')}\n`);
    out.write(`${t('setup.divider')}\n`);
    return 0;
}
// ===========================================================================
// The whole wizard
// ===========================================================================
/**
 * `dsh-zen-remote setup` — preflight, step 1 (role + switch sync), then the
 * role's steps 2 & 3. Missing required answers in a headless run throw
 * MissingRequiredOptionError for the entry point to render.
 */
export async function runSetupCommand(ctx) {
    const up = await preflight(ctx);
    if (up === undefined)
        return 1;
    const { ipc } = up;
    const { t } = ctx;
    const waitSeconds = Math.max(1, ctx.args.options.wait);
    const target = await resolveTargetRole(ctx, up.ping);
    if (target === undefined)
        return 1;
    // Step 1's switch sync (GatewayWizard.tsx's discipline): the managed
    // ingress processes belong to the outgoing role and are stopped ONLY when
    // the target role cannot serve them (`servesRole` false — switching to
    // `client`); the polls ride out the restart-watcher reload over the
    // hot-swap socket.
    const pollUntil = async (want) => {
        const interval = ctx.pollIntervalMs ?? ROLE_POLL_INTERVAL_DEFAULT_MS;
        const deadline = Date.now() + waitSeconds * 1000;
        while (true) {
            try {
                const current = await ipc.ping();
                if (await want(current))
                    return true;
            }
            catch {
                // A reload window can drop one ping — the deadline decides.
            }
            if (Date.now() >= deadline)
                return false;
            await sleep(interval);
        }
    };
    if (target === 'host') {
        if (up.ping.role !== 'host') {
            // A peer already serves (`servesRole('peer')` is true), so the old
            // `!serves` gate silently SKIPPED the write and left the machine a
            // peer forever (PG-10-fix). Gate on the role instead — and switching
            // peer→host never stops the managed ingress children: both roles
            // serve, the gateway and tunnel stay up.
            ctx.stdout.write(`${t('setup.switchingToHost')}\n`);
            if (!(await writeConfigOrReport(commandCtx(ctx, ['status'], ipc), { role: 'host' })))
                return 1;
            if (!(await pollUntil((ping) => ping.role === 'host' && ping.serves === true))) {
                ctx.stdout.write(`${t('setup.roleSwitchTimeout', { seconds: waitSeconds })}\n`);
                return 1;
            }
        }
        return await runHostBranch(ctx, ipc);
    }
    if (target === 'peer') {
        if (up.ping.role !== 'peer') {
            // The PG-10 iron rule: switching to peer NEVER stops the managed
            // Caddy / cloudflared children — `servesRole('peer')` is true, so the
            // phone / browser gateway channel survives the switch.
            ctx.stdout.write(`${t('setup.switchingToPeer')}\n`);
            if (!(await writeConfigOrReport(commandCtx(ctx, ['status'], ipc), { role: 'peer' })))
                return 1;
            const peerReady = async (ping) => {
                if (ping.role !== 'peer')
                    return false;
                // Past the reload window: the peer surface must answer before the
                // wizard moves on.
                return (await fetchBody(() => ipc.request('GET', CLIENT_PEER_STATUS_ROUTE))) !== null;
            };
            if (!(await pollUntil(peerReady))) {
                ctx.stdout.write(`${t('setup.roleSwitchTimeout', { seconds: waitSeconds })}\n`);
                return 1;
            }
        }
        return await runPeerBranch(ctx, ipc);
    }
    if (up.ping.serves) {
        // host→client AND peer→client: the outgoing role was serving the
        // gateway, so the managed ingress children stop before the write.
        ctx.stdout.write(`${t('setup.switchingToClient')}\n`);
        // Best-effort stops: a refused stop must not block the role switch.
        try {
            await ipc.request('POST', WIZARD_CADDY_STOP_ROUTE);
        }
        catch { /* transport error — the stop route is gone with the process */ }
        try {
            await ipc.request('POST', WIZARD_TUNNEL_STOP_ROUTE);
        }
        catch { /* same */ }
    }
    if (up.ping.role !== 'client') {
        if (!(await writeConfigOrReport(commandCtx(ctx, ['status'], ipc), { role: 'client' })))
            return 1;
        // A peer's old row already answers `connects: true`, so `connects` alone
        // passed the poll on the first beat and the wizard raced into the client
        // branch before the reload landed (PG-10-fix). The ROLE must read client.
        if (!(await pollUntil((ping) => ping.role === 'client' && ping.connects === true))) {
            ctx.stdout.write(`${t('setup.roleSwitchTimeout', { seconds: waitSeconds })}\n`);
            return 1;
        }
    }
    return await runClientBranch(ctx, ipc);
}
//# sourceMappingURL=command-setup.js.map