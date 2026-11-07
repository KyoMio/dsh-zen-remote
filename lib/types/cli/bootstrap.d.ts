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
import type { Readable, Writable } from 'node:stream';
import { discoverCliSockets } from './ipc-client.js';
import type { CliIpcClient, CliPingResponse } from './ipc-client.js';
import type { CliTranslator } from './i18n.js';
export interface CliMultiSelection {
    /** Indices into the `choices` array, in the order the user entered them. */
    indices: number[];
    /** Names typed via the manual-input entry (`a`). */
    customNames: string[];
}
export interface CliPrompter {
    selectOne(question: string, choices: readonly string[], defaultIndex: number): Promise<number>;
    selectMulti(question: string, choices: readonly string[], defaultIndices: readonly number[], allowCustomInput?: boolean): Promise<CliMultiSelection>;
    inputText(question: string, defaultValue?: string, validate?: (value: string) => string | undefined): Promise<string>;
    confirm(question: string, defaultYes?: boolean): Promise<boolean>;
    close(): void;
}
/** Raised when a required value is missing in a run that must not prompt
 * (`!isTTY` or `--yes`). Carries the option name so the top level can render
 * one precise bilingual line instead of a stack trace. */
export declare class MissingRequiredOptionError extends Error {
    readonly optionName: string;
    constructor(optionName: string);
}
/** The interactivity verdict every prompt flows through: a TTY and no
 * `--yes`. One function so the rule has exactly one home. */
export declare function isInteractiveSession(args: {
    options: {
        yes: boolean;
    };
}, isTty: boolean): boolean;
/**
 * One ask-everything funnel: a command-line-provided (or caller-default)
 * value answers directly; otherwise interactive runs prompt, and
 * non-interactive runs throw {@link MissingRequiredOptionError} naming the
 * option — before any await that could hang.
 */
export declare function promptOrFail<T>(params: {
    optionName: string;
    interactive: boolean;
    provided: T | undefined;
    ask: () => Promise<T>;
}): Promise<T>;
/**
 * The default `CliPrompter` over `node:readline/promises`. Scaffold strings
 * (the "pick a number" hints) go through the translator like everything
 * else; questions and choices arrive pre-translated from the callers.
 */
export declare function createReadlinePrompter(input?: Readable, output?: Writable, t?: CliTranslator): CliPrompter;
export interface CandidateProfile {
    name: string;
    installed: boolean;
}
/**
 * The installable profiles under `<dshHome>/profiles/`: real directories,
 * excluding `desktop` (the DSH app manages it and `dsh plugin` must not
 * touch it), `node_modules`, and dot-hidden entries. `web` is ALWAYS at
 * index 0 — synthesized when the directory does not exist yet — so both the
 * prompt's default check and the preferred-profile rule can rely on it.
 */
export declare function scanCandidateProfiles(dshHome: string): CandidateProfile[];
export interface EnsurePluginInstalledOptions {
    dshHome: string;
    /** Explicit `--profile p1,p2` targets; skips the scan-and-ask flow and
     * installs even over already-installed profiles (idempotent add). */
    profileFlag?: readonly string[];
    /** TTY && !`--yes`, decided by the caller (see isInteractiveSession). */
    interactive?: boolean;
    prompter?: CliPrompter;
    /** Injectable runner for `dsh plugin … add` — tests record instead of run. */
    spawnCommand?: (command: string, args: readonly string[]) => Promise<number>;
    stdout?: {
        write(text: string): void;
    };
    t?: CliTranslator;
}
export interface EnsurePluginInstalledResult {
    ok: boolean;
    code: 'ok' | 'desktop-refused' | 'install-failed' | 'no-profiles';
    /** Every profile this step decided is (or should now be) installed. */
    targets: string[];
    /** `web` when the targets include it, else the first target. */
    preferredProfile: string | undefined;
    /** Profiles the install actually ran for, in order. */
    installedNow: string[];
    selectedBy: 'flag' | 'prompt' | 'default' | 'already-installed';
    failedProfile?: string;
    manualCommand?: string;
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
export declare function ensurePluginInstalled(options: EnsurePluginInstalledOptions): Promise<EnsurePluginInstalledResult>;
export interface ExecProbeResult {
    code: number;
    stdout: string;
}
export type ExecProbe = (command: string, args: readonly string[]) => Promise<ExecProbeResult>;
export interface EnsureDshRunningOptions {
    dshHome: string;
    /** Among several live instances prefer the one serving this role. */
    targetRole?: 'host' | 'client';
    /** Feeds the manual-start guidance and (nothing spawns daemons per-profile
     * today) future per-profile daemons. */
    preferredProfile?: string;
    /** Poll budget after a daemon trigger; default 20s. */
    waitSeconds?: number;
    /** Probe only this socket instead of the candidate walk. */
    explicitSocket?: string;
    /** Platform override (tests pin every branch on one machine). */
    platform?: NodeJS.Platform;
    /** uid for the launchd `gui/<uid>/…` target; default process.getuid(). */
    uid?: number;
    /** Injectable command runner for the daemon probes/triggers. */
    execProbe?: ExecProbe;
    /** Injectable discovery (tests can stage socket states per call). */
    discover?: typeof discoverCliSockets;
    /** macOS app bundle path; tests relocate it off the real /Applications. */
    macosAppPath?: string;
    /** System systemd unit dir; tests relocate it off the real /etc. */
    systemUnitDir?: string;
    stdout?: {
        write(text: string): void;
    };
    t?: CliTranslator;
}
export type EnsureDshRunningResult = {
    started: true;
    client: CliIpcClient;
    socketPath: string;
    ping: CliPingResponse;
} | {
    started: false;
    outcome: 'permission-denied' | 'no-daemon' | 'timeout';
    message: string;
};
/**
 * Find (or launch) a DSH this CLI can drive: discovery first — a live
 * version-matching socket answers immediately (preferring the target role
 * among multiple instances); EACCES / EPERM reports the cross-user hint and
 * stops; otherwise the platform's daemon triggers fire and discovery polls
 * until a socket appears or `waitSeconds` run out. Windows and daemon-less
 * machines get the manual-start guidance and a structured `no-daemon` result.
 */
export declare function ensureDshRunning(options: EnsureDshRunningOptions): Promise<EnsureDshRunningResult>;
//# sourceMappingURL=bootstrap.d.ts.map