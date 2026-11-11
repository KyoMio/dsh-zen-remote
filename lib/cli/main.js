/**
 * CLI-5: the process entry point behind `bin/zen-remote.mjs`. `runCli` turns
 * a parsed argv into exactly one verdict: static answers (help, version, an
 * unknown role value, unknown commands) render here; every plugin-driving
 * command first comes alive through `ensureDshRunning` and then dispatches
 * into the CLI-3/CLI-4 command functions over the discovered IPC socket;
 * `setup` owns its preflight (install + launch) and runs the three-step
 * wizard.
 *
 * Two things belong ONLY here: the interactivity verdict for the whole run
 * (TTY && !`--yes`, with the default readline prompter created lazily and —
 * importantly — closed in the end, or an unanswered stdin handle would keep
 * the process alive after the answer printed), and the structured error
 * boundary that turns a MissingRequiredOptionError into one precise
 * bilingual line instead of a stack trace. All dependencies are injectable
 * so the tests drive the real entry function with fakes (SPEC's test seam
 * three).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from './args.js';
import { createReadlinePrompter, ensureDshRunning, isInteractiveSession, MissingRequiredOptionError } from './bootstrap.js';
import { discoverCliSockets } from './ipc-client.js';
import { CLI_PROTOCOL_VERSION } from './ipc-server.js';
import { createTranslator, resolveCliLang } from './i18n.js';
import { runStatusCommand } from './commands-status.js';
import { runClientListCommand, runClientPairCommand, runClientUnpairCommand } from './commands-client.js';
import { runPeerJoinCommand, runPeerLeaveCommand, runPeerStatusCommand, runPeerTrustCommand, } from './commands-peer.js';
import { runHostDeviceListCommand, runHostDevicePairCommand, runHostDeviceRevokeCommand, runHostIngressSnippetCommand, runHostIngressStartCommand, runHostIngressStopCommand, runHostIngressVerifyCommand, } from './commands-host.js';
import { runSetupCommand } from './command-setup.js';
function readPackageVersion() {
    try {
        const parsed = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'));
        if (parsed !== null && typeof parsed === 'object') {
            const version = parsed.version;
            if (typeof version === 'string')
                return version;
        }
    }
    catch { /* packaged oddities fall back to a visible placeholder */ }
    return 'unknown';
}
/** The complete bilingual command tree — the `help.command.*` /
 * `help.option.*` dictionary keys ARE the tree's source of truth. */
function printHelp(t, out) {
    const lines = [
        t('help.title'),
        '',
        t('help.usage'),
        '',
        t('help.description'),
        '',
        t('help.commands'),
        `  ${t('help.command.setup')}`,
        `  ${t('help.command.status')}`,
        `  ${t('help.command.hostDevice')}`,
        `  ${t('help.command.hostIngress')}`,
        `  ${t('help.command.clientPair')}`,
        `  ${t('help.command.clientUnpair')}`,
        `  ${t('help.command.clientList')}`,
        `  ${t('help.command.peerFamily')}`,
        '',
        t('help.options'),
        ...[
            'lang', 'json', 'socket', 'wait', 'yes', 'noWait', 'debug', 'role', 'profile',
            'ingress', 'domain', 'cfToken', 'email', 'httpsPort', 'publicUrl', 'tunnelId',
            'proxy', 'deviceRole', 'hostUrl', 'code', 'name', 'invite', 'all',
        ].map((option) => `  ${t(`help.option.${option}`)}`),
        '',
        t('help.footer'),
    ];
    out.write(`${lines.join('\n')}\n`);
}
/** The static verdicts that need no plugin and no IPC, in priority order. */
function staticVerdict(parsed, t, out, packageVersion) {
    if (parsed.command === 'help') {
        printHelp(t, out);
        return 0;
    }
    if (parsed.command === 'version') {
        out.write(`${packageVersion}\n`);
        return 0;
    }
    if (parsed.options.roleIssue === 'invalid') {
        out.write(`${t('err.role.invalid', { value: parsed.options.role ?? '' })}\n`);
        return 1;
    }
    if (parsed.command === 'unknown') {
        out.write(`${t('err.unknownCommand', { command: parsed.unknownCommand ?? '' })}\n`);
        return 1;
    }
    return undefined;
}
/**
 * Run one CLI invocation (argv WITHOUT the node binary and script path) and
 * answer its exit code. The bin entry assigns it to `process.exitCode`.
 */
export async function runCli(argv, deps) {
    const d = deps ?? {};
    const parsed = parseCliArgs(argv);
    const env = d.env ?? process.env;
    const t = createTranslator(resolveCliLang(parsed.options.lang, env));
    const out = d.stdout ?? process.stdout;
    const dshHome = d.dshHome ?? env.DSH_HOME ?? join(homedir(), '.dsh');
    const interactive = isInteractiveSession(parsed, d.isTty ?? process.stdin.isTTY === true);
    // The default readline prompter is created lazily and owned by this run —
    // an unclosed one would hold stdin open after the answer is printed.
    let ownedPrompter;
    const prompterFor = () => {
        if (!interactive)
            return undefined;
        if (d.prompter !== undefined)
            return d.prompter;
        if (ownedPrompter === undefined)
            ownedPrompter = createReadlinePrompter(undefined, undefined, t);
        return ownedPrompter;
    };
    // The real Ctrl-C seam (context.ts's contract): without an injected signal,
    // the process's SIGINT drives a run-owned AbortController, so the verify
    // wait can skip gracefully. A SECOND Ctrl-C force-quits — the listener must
    // never swallow Ctrl-C for phases that cannot react to the signal. The
    // listener is removed in the end; nothing leaks across runs (or into the
    // tests' process).
    const controller = new AbortController();
    const onSigint = () => {
        if (controller.signal.aborted) {
            process.exit(130);
            return;
        }
        controller.abort();
    };
    if (d.abortSignal === undefined)
        process.on('SIGINT', onSigint);
    const abortSignal = d.abortSignal ?? controller.signal;
    try {
        const verdict = staticVerdict(parsed, t, out, d.packageVersion ?? readPackageVersion());
        if (verdict !== undefined)
            return verdict;
        if (parsed.command === 'setup') {
            const setupCtx = {
                args: parsed,
                dshHome,
                interactive,
                t,
                stdout: out,
                ...(interactive ? { prompter: prompterFor() } : {}),
                ...(d.pollIntervalMs === undefined ? {} : { pollIntervalMs: d.pollIntervalMs }),
                abortSignal,
                ...(d.now === undefined ? {} : { now: d.now }),
                ...(d.cwd === undefined ? {} : { cwd: d.cwd }),
                ...(d.discover === undefined ? {} : { discover: d.discover }),
                ...(d.spawnCommand === undefined ? {} : { spawnCommand: d.spawnCommand }),
                ...(d.execProbe === undefined ? {} : { execProbe: d.execProbe }),
                ...(d.platform === undefined ? {} : { platform: d.platform }),
                ...(d.uid === undefined ? {} : { uid: d.uid }),
                ...(d.macosAppPath === undefined ? {} : { macosAppPath: d.macosAppPath }),
                ...(d.systemUnitDir === undefined ? {} : { systemUnitDir: d.systemUnitDir }),
            };
            return await runSetupCommand(setupCtx);
        }
        // status / host.* / client.*: a live plugin is the precondition — find
        // it (a version-mismatching socket is its own refusal) and bind.
        const discover = d.discover ?? discoverCliSockets;
        const platform = d.platform ?? process.platform;
        const found = await discover({
            dshHome,
            ...(parsed.options.socket === undefined ? {} : { explicitSocket: parsed.options.socket }),
            platform,
        });
        if (found.live.length === 0 && found.versionMismatch.length > 0) {
            const mismatched = found.versionMismatch[0];
            out.write(`${t('err.protocolVersion', {
                found: String(mismatched?.cliProtocolVersion ?? '?'),
                expected: CLI_PROTOCOL_VERSION,
            })}\n`);
            return 1;
        }
        const up = await ensureDshRunning({
            dshHome,
            waitSeconds: parsed.options.wait,
            ...(parsed.options.socket === undefined ? {} : { explicitSocket: parsed.options.socket }),
            ...(d.platform === undefined ? {} : { platform: d.platform }),
            ...(d.uid === undefined ? {} : { uid: d.uid }),
            ...(d.execProbe === undefined ? {} : { execProbe: d.execProbe }),
            discover,
            ...(d.macosAppPath === undefined ? {} : { macosAppPath: d.macosAppPath }),
            ...(d.systemUnitDir === undefined ? {} : { systemUnitDir: d.systemUnitDir }),
            stdout: out,
            t,
        });
        if (!up.started)
            return 1;
        const ipc = up.client;
        const prompter = prompterFor();
        const ctx = {
            args: parsed,
            ipc,
            t,
            interactive,
            ...(prompter === undefined ? {} : { prompter }),
            stdout: out,
            ...(d.now === undefined ? {} : { now: d.now }),
            ...(d.cwd === undefined ? {} : { cwd: d.cwd }),
            ...(d.pollIntervalMs === undefined ? {} : { pollIntervalMs: d.pollIntervalMs }),
            abortSignal,
        };
        switch (parsed.command) {
            case 'status': return await runStatusCommand(ctx);
            case 'host.device.pair': return await runHostDevicePairCommand(ctx);
            case 'host.device.list': return await runHostDeviceListCommand(ctx);
            case 'host.device.revoke': return await runHostDeviceRevokeCommand(ctx);
            case 'host.ingress.start': return await runHostIngressStartCommand(ctx);
            case 'host.ingress.stop': return await runHostIngressStopCommand(ctx);
            case 'host.ingress.verify': return await runHostIngressVerifyCommand(ctx);
            case 'host.ingress.snippet': return await runHostIngressSnippetCommand(ctx);
            case 'client.pair': return await runClientPairCommand(ctx);
            case 'client.unpair': return await runClientUnpairCommand(ctx);
            case 'client.list': return await runClientListCommand(ctx);
            case 'peer.join': return await runPeerJoinCommand(ctx);
            case 'peer.status': return await runPeerStatusCommand(ctx);
            case 'peer.trust': return await runPeerTrustCommand(ctx);
            case 'peer.leave': return await runPeerLeaveCommand(ctx);
            default: {
                // staticVerdict already handled help / version / unknown / setup —
                // the default arm is unreachable and only satisfies the exhaustiveness.
                out.write(`${t('err.unknownCommand', { command: parsed.unknownCommand ?? '' })}\n`);
                return 1;
            }
        }
    }
    catch (error) {
        if (error instanceof MissingRequiredOptionError) {
            out.write(`${t('err.missingOption', { option: error.optionName })}\n`);
            return 1;
        }
        out.write(`${t('err.internal', { error: error instanceof Error ? error.message : String(error) })}\n`);
        return 1;
    }
    finally {
        if (d.abortSignal === undefined)
            process.removeListener('SIGINT', onSigint);
        ownedPrompter?.close();
    }
}
//# sourceMappingURL=main.js.map