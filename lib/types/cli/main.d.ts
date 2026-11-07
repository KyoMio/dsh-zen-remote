/**
 * CLI-5: the process entry point behind `bin/zen-remote.mjs`. `runCli` turns
 * a parsed argv into exactly one verdict: static answers (help, version,
 * the SPEC's `--role peer` refusal, unknown commands) render here; every
 * plugin-driving command first comes alive through `ensureDshRunning` and
 * then dispatches into the CLI-3/CLI-4 command functions over the discovered
 * IPC socket; `setup` owns its preflight (install + launch) and runs the
 * three-step wizard.
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
import type { CliPrompter, ExecProbe } from './bootstrap.js';
import { discoverCliSockets } from './ipc-client.js';
export interface CliRuntimeDeps {
    /** Environment for the language resolution and the `DSH_HOME` fallback. */
    env?: NodeJS.ProcessEnv;
    /** The DSH home the sockets / profiles live under. Default
     * `<env.DSH_HOME ?? ~/.dsh>` — the same resolution config.ts uses. */
    dshHome?: string;
    /** Whether this run can prompt. Default `process.stdin.isTTY === true`. */
    isTty?: boolean;
    stdout?: {
        write(text: string): void;
    };
    /** The ask-everything funnel; the default readline prompter is built
     * lazily (and closed at the end) when a run may actually prompt. */
    prompter?: CliPrompter;
    /** `--version`'s answer; default the package.json version next to lib/. */
    packageVersion?: string;
    /** Bind-shape override (tests pin every platform branch). */
    platform?: NodeJS.Platform;
    /** uid for the launchd `gui/<uid>/…` target. */
    uid?: number;
    macosAppPath?: string;
    systemUnitDir?: string;
    /** Test seams, forwarded into the preflight / bootstrap. */
    discover?: typeof discoverCliSockets;
    spawnCommand?: (command: string, args: readonly string[]) => Promise<number>;
    execProbe?: ExecProbe;
    now?: () => Date;
    cwd?: string;
    pollIntervalMs?: number;
    abortSignal?: AbortSignal;
}
/**
 * Run one CLI invocation (argv WITHOUT the node binary and script path) and
 * answer its exit code. The bin entry assigns it to `process.exitCode`.
 */
export declare function runCli(argv: readonly string[], deps?: CliRuntimeDeps): Promise<number>;
//# sourceMappingURL=main.d.ts.map