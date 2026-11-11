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
import type { ParsedCliArgs } from './args.js';
import type { CliPrompter, ExecProbe } from './bootstrap.js';
import { discoverCliSockets } from './ipc-client.js';
import type { CliTranslator } from './i18n.js';
/** Everything `runSetupCommand` needs beyond a plain command context: the
 * preflight owns discovery and launch, so it takes the same injectable
 * seams `main.ts` collected (SPEC's test seam three). */
export interface SetupCommandContext {
    args: ParsedCliArgs;
    dshHome: string;
    /** TTY && !`--yes`, decided once by the entry point. */
    interactive: boolean;
    t: CliTranslator;
    stdout: {
        write(text: string): void;
    };
    /** Present whenever the run may prompt. */
    prompter?: CliPrompter;
    /** Poll-interval seam (role-switch wait, shared with the driven commands). */
    pollIntervalMs?: number;
    /** Ctrl-C seam — forwarded into the verify wait. */
    abortSignal?: AbortSignal;
    now?: () => Date;
    cwd?: string;
    /** Discover seam (tests stage socket states per call). */
    discover?: typeof discoverCliSockets;
    /** `dsh plugin add` runner seam. */
    spawnCommand?: (command: string, args: readonly string[]) => Promise<number>;
    /** Daemon probe/trigger seam. */
    execProbe?: ExecProbe;
    platform?: NodeJS.Platform;
    uid?: number;
    macosAppPath?: string;
    systemUnitDir?: string;
}
/**
 * `dsh-zen-remote setup` — preflight, step 1 (role + switch sync), then the
 * role's steps 2 & 3. Missing required answers in a headless run throw
 * MissingRequiredOptionError for the entry point to render.
 */
export declare function runSetupCommand(ctx: SetupCommandContext): Promise<number>;
//# sourceMappingURL=command-setup.d.ts.map