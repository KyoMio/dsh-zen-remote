/**
 * CLI-3: the `client` subcommand family — `pair`, `unpair`, `list`. Every
 * entry point passes the connectsRole gate FIRST (the task discipline: a
 * host never dials a remote host; the message names the `setup --role
 * client` switch), then drives the plugin's own pairing routes over IPC —
 * the CLI never touches the relay pool or the state file directly, the
 * plugin process stays the single owner.
 *
 * Interactivity follows the bootstrap iron rule: a missing value prompts in
 * a TTY run, and a non-interactive run throws MissingRequiredOptionError
 * immediately — except the one retry the SPEC pins: a WRONG pairing code in
 * an interactive run falls back to re-asking ONLY the code, the already
 * entered address stays put.
 */
import type { CliExecutionContext } from './context.js';
/**
 * `client list [--json]` — the paired-host table. `--json` echoes the pool
 * status's own servers array verbatim (the machine-readable truth), the
 * terminal mode prints the header count and one line per host.
 */
export declare function runClientListCommand(ctx: CliExecutionContext): Promise<number>;
/**
 * `client pair [hostUrl] [--code <8位码>] [--name <本机名>] [--json]` — the
 * full pairing flow: local address validation, name sync through the
 * anti-shadowing config writer, the claim round-trip (with the SPEC's
 * code-only retry in interactive runs), and the bounded wait for `online`.
 */
export declare function runClientPairCommand(ctx: CliExecutionContext): Promise<number>;
/**
 * `client unpair [<hostUrl|entryId>|--all] [--yes] [--json]` — a target is
 * matched against the pool's own status rows (entry id first, then the
 * normalized address); `--all` needs `--yes` outside a TTY confirm; no
 * target at all in an interactive run picks from the current list.
 */
export declare function runClientUnpairCommand(ctx: CliExecutionContext): Promise<number>;
//# sourceMappingURL=commands-client.d.ts.map