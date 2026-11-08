/**
 * CLI-2 bootstrap: everything a CLI session needs BEFORE any subcommand
 * logic runs — interactive prompting, candidate-profile scanning with the
 * multi-select plugin install, and bringing a DSH instance up.
 *
 * Three injectable seams keep this testable without a real terminal or a
 * real daemon (SPEC's test seam three): a `CliPrompter` the tests replace
 * with fakes, a `spawnCommand` the tests record instead of running
 * `dsh plugin add`, and an `execProbe` the tests substitute for systemctl /
 * launchctl / open. The real implementations sit next to them in this file
 * and exercise the very same code paths.
 *
 * The non-interactive iron rule lives here: with `!isTTY` or `--yes`, a
 * question with no command-line answer throws `MissingRequiredOptionError`
 * IMMEDIATELY — a headless run must fail fast and legibly, never hang on a
 * stdin read nothing will ever answer.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createCliIpcClient, discoverCliSockets } from './ipc-client.js';
import { createTranslator, resolveCliLang } from './i18n.js';
/** Raised when a required value is missing in a run that must not prompt
 * (`!isTTY` or `--yes`). Carries the option name so the top level can render
 * one precise bilingual line instead of a stack trace. */
export class MissingRequiredOptionError extends Error {
    optionName;
    constructor(optionName) {
        super(`missing required option: --${optionName}`);
        this.name = 'MissingRequiredOptionError';
        this.optionName = optionName;
    }
}
/** The interactivity verdict every prompt flows through: a TTY and no
 * `--yes`. One function so the rule has exactly one home. */
export function isInteractiveSession(args, isTty) {
    return isTty && !args.options.yes;
}
/**
 * One ask-everything funnel: a command-line-provided (or caller-default)
 * value answers directly; otherwise interactive runs prompt, and
 * non-interactive runs throw {@link MissingRequiredOptionError} naming the
 * option — before any await that could hang.
 */
export async function promptOrFail(params) {
    if (params.provided !== undefined)
        return params.provided;
    if (!params.interactive)
        throw new MissingRequiredOptionError(params.optionName);
    return params.ask();
}
/**
 * The default `CliPrompter` over `node:readline/promises`. Scaffold strings
 * (the "pick a number" hints) go through the translator like everything
 * else; questions and choices arrive pre-translated from the callers.
 */
export function createReadlinePrompter(input, output, t) {
    const translator = t ?? createTranslator(resolveCliLang(undefined));
    const out = output ?? process.stdout;
    const rl = createInterface({ input: input ?? process.stdin, output: out });
    const write = (text) => { out.write(text); };
    const ask = async (prompt) => (await rl.question(prompt)).trim();
    return {
        async selectOne(question, choices, defaultIndex) {
            write(`\n? ${question}\n`);
            choices.forEach((choice, i) => write(`  ${i + 1}. ${choice}${i === defaultIndex ? `（${translator('prompt.defaultLabel')}）` : ''}\n`));
            while (true) {
                const line = await ask(translator('prompt.selectOne', { max: choices.length, default: defaultIndex + 1 }));
                if (line === '')
                    return defaultIndex;
                const picked = Number.parseInt(line, 10);
                if (Number.isInteger(picked) && picked >= 1 && picked <= choices.length)
                    return picked - 1;
                write(`${translator('prompt.invalid', { value: line })}\n`);
            }
        },
        async selectMulti(question, choices, defaultIndices, allowCustomInput = false) {
            write(`\n? ${question}\n`);
            const defaults = new Set(defaultIndices);
            choices.forEach((choice, i) => write(`  ${defaults.has(i) ? '[x]' : '[ ]'} ${i + 1}. ${choice}\n`));
            if (allowCustomInput)
                write(`${translator('prompt.customEntryLine', { entry: translator('install.customEntry') })}\n`);
            while (true) {
                const line = await ask(allowCustomInput ? translator('prompt.multiInputCustom') : translator('prompt.multiInputPlain'));
                if (line === '')
                    return { indices: [...defaultIndices], customNames: [] };
                const indices = [];
                let wantsCustom = false;
                let valid = true;
                for (const token of line.split(/[,\s]+/u).filter((part) => part !== '')) {
                    if (allowCustomInput && /^[aA]$/u.test(token)) {
                        wantsCustom = true;
                        continue;
                    }
                    const picked = Number.parseInt(token, 10);
                    if (!Number.isInteger(picked) || picked < 1 || picked > choices.length) {
                        valid = false;
                        break;
                    }
                    if (!indices.includes(picked - 1))
                        indices.push(picked - 1);
                }
                if (!valid) {
                    write(`${translator('prompt.invalid', { value: line })}\n`);
                    continue;
                }
                const customNames = [];
                if (wantsCustom) {
                    while (true) {
                        const name = await ask(translator('prompt.customName'));
                        if (name === '')
                            break;
                        if (!customNames.includes(name))
                            customNames.push(name);
                    }
                }
                return { indices, customNames };
            }
        },
        async inputText(question, defaultValue, validate) {
            write('\n');
            while (true) {
                const suffix = defaultValue === undefined ? '' : `（${translator('prompt.defaultLabel')}：${defaultValue}）`;
                const line = await ask(`? ${question}${suffix} `);
                const value = line === '' ? (defaultValue ?? '') : line;
                const problem = validate?.(value);
                if (problem !== undefined) {
                    write(`${problem}\n`);
                    continue;
                }
                if (value === '' && defaultValue === undefined) {
                    write(`${translator('prompt.requiredEmpty')}\n`);
                    continue;
                }
                return value;
            }
        },
        async confirm(question, defaultYes = true) {
            write('\n');
            while (true) {
                const line = await ask(`? ${question} ${defaultYes ? translator('prompt.confirmY') : translator('prompt.confirmN')} `);
                if (line === '')
                    return defaultYes;
                const lower = line.toLowerCase();
                if (lower === 'y' || lower === 'yes')
                    return true;
                if (lower === 'n' || lower === 'no')
                    return false;
                write(`${translator('prompt.invalid', { value: line })}\n`);
            }
        },
        close() {
            rl.close();
        },
    };
}
/** Does this profile's package.json carry the plugin — either as a plain
 * dependency or in `dsh.profile.bundles` (array or name-keyed map)? A
 * missing or unparsable package.json is simply "not installed". */
function profileHasPlugin(profileDir) {
    try {
        const parsed = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
        if (parsed === null || typeof parsed !== 'object')
            return false;
        const pkg = parsed;
        if (pkg.dependencies !== undefined && typeof pkg.dependencies === 'object' && 'dsh-zen-remote' in pkg.dependencies)
            return true;
        const bundles = pkg.dsh?.profile?.bundles;
        if (Array.isArray(bundles) && bundles.includes('dsh-zen-remote'))
            return true;
        if (bundles !== null && typeof bundles === 'object' && !Array.isArray(bundles) && 'dsh-zen-remote' in bundles)
            return true;
    }
    catch { /* no package.json or unreadable — not installed */ }
    return false;
}
/**
 * The installable profiles under `<dshHome>/profiles/`: real directories,
 * excluding `desktop` (the DSH app manages it and `dsh plugin` must not
 * touch it), `node_modules`, and dot-hidden entries. `web` is ALWAYS at
 * index 0 — synthesized when the directory does not exist yet — so both the
 * prompt's default check and the preferred-profile rule can rely on it.
 */
export function scanCandidateProfiles(dshHome) {
    const found = [];
    let entries = [];
    try {
        entries = readdirSync(join(dshHome, 'profiles'), { withFileTypes: true });
    }
    catch { /* no profiles directory — only the synthesized web remains */ }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        if (entry.name === 'desktop' || entry.name === 'node_modules' || entry.name.startsWith('.'))
            continue;
        found.push({ name: entry.name, installed: profileHasPlugin(join(dshHome, 'profiles', entry.name)) });
    }
    const webIndex = found.findIndex((profile) => profile.name === 'web');
    if (webIndex > 0) {
        const [web] = found.splice(webIndex, 1);
        if (web !== undefined)
            found.unshift(web);
    }
    else if (webIndex === -1) {
        found.unshift({ name: 'web', installed: false });
    }
    return found;
}
function pickPreferredProfile(profiles) {
    return profiles.includes('web') ? 'web' : profiles[0];
}
/** The real `dsh plugin add` runner: exit code as a number, spawn failures
 * (ENOENT — no `dsh` on PATH) count as code 1. */
function spawnDshPluginAdd(command, args) {
    return new Promise((resolve) => {
        execFile(command, [...args], { timeout: 120_000 }, (error) => {
            if (error === undefined) {
                resolve(0);
                return;
            }
            const code = error.code;
            resolve(typeof code === 'number' ? code : 1);
        });
    });
}
/**
 * Make sure `dsh-zen-remote` is installed into at least one usable profile:
 * explicit `--profile` wins; otherwise an already-installed profile ends the
 * flow; otherwise an interactive TTY multi-selects from the candidate scan
 * (default-checked `web`, manual names welcome) and a non-interactive run
 * defaults to `web`. Each selected profile gets
 * `dsh plugin --profile <name> add dsh-zen-remote`; a failure prints the
 * verbatim manual command and reports `install-failed`. `desktop` is
 * refused everywhere — the DeepSeek Harness app owns that profile.
 */
export async function ensurePluginInstalled(options) {
    const t = options.t ?? createTranslator(resolveCliLang(undefined));
    const out = options.stdout ?? process.stdout;
    const spawn = options.spawnCommand ?? spawnDshPluginAdd;
    const interactive = options.interactive ?? false;
    const desktopIn = (names) => names.filter((name) => name === 'desktop');
    const refused = (targets, selectedBy) => {
        const offending = desktopIn(targets);
        out.write(`${t('err.desktopProfile', { profiles: offending.join(', ') })}\n`);
        return { ok: false, code: 'desktop-refused', targets, preferredProfile: pickPreferredProfile(targets), installedNow: [], selectedBy };
    };
    let targets;
    let selectedBy;
    if (options.profileFlag !== undefined) {
        targets = options.profileFlag.map((name) => name.trim()).filter((name) => name !== '');
        selectedBy = 'flag';
        if (desktopIn(targets).length > 0)
            return refused(targets, selectedBy);
    }
    else {
        const candidates = scanCandidateProfiles(options.dshHome);
        const installed = candidates.filter((profile) => profile.installed).map((profile) => profile.name);
        if (installed.length > 0) {
            out.write(`${t('install.installed', { profiles: installed.join(', ') })}\n`);
            return { ok: true, code: 'ok', targets: installed, preferredProfile: pickPreferredProfile(installed), installedNow: [], selectedBy: 'already-installed' };
        }
        out.write(`${t('install.noneInstalled')}\n`);
        if (interactive && options.prompter !== undefined) {
            const selection = await options.prompter.selectMulti(t('install.selectQuestion'), candidates.map((profile) => profile.name), [0], true);
            const chosen = selection.indices
                .map((index) => candidates[index]?.name)
                .filter((name) => name !== undefined);
            const custom = selection.customNames.map((name) => name.trim()).filter((name) => name !== '');
            targets = [...chosen, ...custom];
            selectedBy = 'prompt';
        }
        else {
            targets = ['web'];
            selectedBy = 'default';
        }
        if (desktopIn(targets).length > 0)
            return refused(targets, selectedBy);
        if (targets.length === 0) {
            return { ok: false, code: 'no-profiles', targets, preferredProfile: undefined, installedNow: [], selectedBy };
        }
    }
    const installedNow = [];
    for (const profile of targets) {
        out.write(`${t('install.running', { profile })}\n`);
        let code;
        try {
            code = await spawn('dsh', ['plugin', '--profile', profile, 'add', 'dsh-zen-remote']);
        }
        catch {
            code = 1;
        }
        if (code !== 0) {
            const manualCommand = `dsh plugin --profile ${profile} add dsh-zen-remote`;
            out.write(`${t('install.failed', { profile, code, command: manualCommand })}\n`);
            return { ok: false, code: 'install-failed', targets, preferredProfile: pickPreferredProfile(targets), installedNow, selectedBy, failedProfile: profile, manualCommand };
        }
        installedNow.push(profile);
    }
    out.write(`${t('install.done', { profiles: installedNow.join(', ') })}\n`);
    return { ok: true, code: 'ok', targets, preferredProfile: pickPreferredProfile(targets), installedNow, selectedBy };
}
const DEFAULT_WAIT_SECONDS = 20;
const POLL_INTERVAL_MS = 300;
const DEFAULT_MACOS_APP_PATH = '/Applications/DeepSeek Harness.app';
const DEFAULT_SYSTEM_UNIT_DIR = '/etc/systemd/system';
const MACOS_LAUNCHD_LABEL = 'ai.deepseek.dsh.web';
function execProbeReal(command, args) {
    return new Promise((resolve) => {
        execFile(command, [...args], { timeout: 10_000 }, (error, stdout) => {
            if (error === undefined) {
                resolve({ code: 0, stdout: String(stdout ?? '') });
                return;
            }
            const code = error.code;
            resolve({ code: typeof code === 'number' ? code : 127, stdout: String(error.stdout ?? '') });
        });
    });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** First `dsh*.service` name in a systemd unit directory, or `undefined`. */
function listSystemUnits(dir) {
    try {
        for (const name of readdirSync(dir)) {
            if (/^dsh[\w@.-]*\.service$/u.test(name))
                return name;
        }
    }
    catch { /* no system unit dir on this machine */ }
    return undefined;
}
/**
 * Try to bring a daemon-managed DSH up, strictly by EXISTING service units —
 * the CLI never daemonizes on its own (a second supervisor would fight the
 * user's own setup). Returns whether a start command ran and succeeded.
 *   Linux: systemd user unit `dsh*.service`, else a system-level one.
 *   macOS: the launchd label, else the app bundle in /Applications.
 *   Windows (and everything unmatched): nothing to try — manual guidance.
 */
async function triggerDaemon(platform, ctx) {
    if (platform === 'linux') {
        const userUnits = await ctx.execProbe('systemctl', ['--user', 'list-unit-files', 'dsh*']);
        const unit = userUnits.code === 0
            ? /(?:^|\s)(dsh[\w@.-]*\.service)\b/u.exec(userUnits.stdout)?.[1]
            : undefined;
        if (unit !== undefined) {
            ctx.out.write(`${ctx.t('launch.linuxUserUnit', { unit })}\n`);
            const started = await ctx.execProbe('systemctl', ['--user', 'start', unit]);
            return started.code === 0;
        }
        const systemUnit = listSystemUnits(ctx.systemUnitDir);
        if (systemUnit !== undefined) {
            ctx.out.write(`${ctx.t('launch.linuxSystemUnit', { unit: systemUnit })}\n`);
            const started = await ctx.execProbe('systemctl', ['start', systemUnit]);
            return started.code === 0;
        }
        return false;
    }
    if (platform === 'darwin') {
        const target = `gui/${ctx.uid}/${MACOS_LAUNCHD_LABEL}`;
        const printed = await ctx.execProbe('launchctl', ['print', target]);
        if (printed.code === 0) {
            ctx.out.write(`${ctx.t('launch.macosService')}\n`);
            const kicked = await ctx.execProbe('launchctl', ['kickstart', '-k', target]);
            return kicked.code === 0;
        }
        if (existsSync(ctx.macosAppPath)) {
            ctx.out.write(`${ctx.t('launch.macosApp')}\n`);
            const opened = await ctx.execProbe('open', ['-a', ctx.macosAppPath]);
            return opened.code === 0;
        }
        return false;
    }
    return false;
}
/**
 * Find (or launch) a DSH this CLI can drive: discovery first — a live
 * version-matching socket answers immediately (preferring the target role
 * among multiple instances); EACCES / EPERM reports the cross-user hint and
 * stops; otherwise the platform's daemon triggers fire and discovery polls
 * until a socket appears or `waitSeconds` run out. Windows and daemon-less
 * machines get the manual-start guidance and a structured `no-daemon` result.
 */
export async function ensureDshRunning(options) {
    const t = options.t ?? createTranslator(resolveCliLang(undefined));
    const out = options.stdout ?? process.stdout;
    const execProbe = options.execProbe ?? execProbeReal;
    const discover = options.discover ?? discoverCliSockets;
    const platform = options.platform ?? process.platform;
    const waitSeconds = options.waitSeconds ?? DEFAULT_WAIT_SECONDS;
    const discoverOptions = {
        dshHome: options.dshHome,
        ...(options.explicitSocket === undefined ? {} : { explicitSocket: options.explicitSocket }),
        platform,
    };
    const pickLive = (found) => {
        if (options.targetRole !== undefined) {
            const match = found.live.find((entry) => entry.role === options.targetRole);
            if (match !== undefined)
                return match;
        }
        return found.live[0];
    };
    const liveResult = (entry) => {
        out.write(`${t('launch.found', { role: entry.role, socketPath: entry.socketPath })}\n`);
        return { started: true, client: createCliIpcClient(entry.socketPath), socketPath: entry.socketPath, ping: entry };
    };
    const deniedResult = () => {
        const message = t('err.crossUserSocket');
        out.write(`${message}\n`);
        return { started: false, outcome: 'permission-denied', message };
    };
    const first = await discover(discoverOptions);
    const firstLive = pickLive(first);
    if (firstLive !== undefined)
        return liveResult(firstLive);
    if (first.permissionDenied.length > 0)
        return deniedResult();
    out.write(`${t('launch.probing')}\n`);
    const triggered = await triggerDaemon(platform, {
        execProbe,
        uid: options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 501),
        preferredProfile: options.preferredProfile ?? 'web',
        macosAppPath: options.macosAppPath ?? DEFAULT_MACOS_APP_PATH,
        systemUnitDir: options.systemUnitDir ?? DEFAULT_SYSTEM_UNIT_DIR,
        out,
        t,
    });
    if (!triggered) {
        const message = t('launch.manual', { profile: options.preferredProfile ?? 'web' });
        out.write(`${message}\n`);
        return { started: false, outcome: 'no-daemon', message };
    }
    out.write(`${t('launch.waiting', { seconds: waitSeconds })}\n`);
    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const found = await discover(discoverOptions);
        const live = pickLive(found);
        if (live !== undefined)
            return liveResult(live);
        if (found.permissionDenied.length > 0)
            return deniedResult();
    }
    const message = t('launch.timeout', { seconds: waitSeconds });
    out.write(`${message}\n`);
    return { started: false, outcome: 'timeout', message };
}
//# sourceMappingURL=bootstrap.js.map