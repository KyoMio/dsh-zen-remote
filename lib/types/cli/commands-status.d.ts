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
import type { CliIpcRequestResult } from './ipc-client.js';
import type { CliTranslator } from './i18n.js';
import type { CliExecutionContext } from './context.js';
/** One pool `servers` row (client/status), defensively typed — the command
 * layer renders whatever shape arrived, it never trusts it. */
export type ServerRow = Record<string, unknown>;
/**
 * Fetch one JSON object over IPC; every failure mode (transport error,
 * error status, non-object body) is `null` — a broken surface means "no
 * information" for a status view, never a failed command.
 */
export declare function fetchBody(run: () => Promise<CliIpcRequestResult>): Promise<ServerRow | null>;
/** One plain JSON object, or null. */
export declare function plainOf(value: unknown): ServerRow | null;
/** The connection-state label: the three common states translated, the rest
 * (revoked / incompatible / unpaired) each with their own word. */
export declare function stateLabelOf(t: CliTranslator, value: unknown): string;
/** The fingerprint-compat half of the compat/bridge column. */
export declare function compatLabelOf(t: CliTranslator, value: unknown): string;
/** The bridged-plugin half: how many of the row's plugins are bridged. */
export declare function bridgeLabelOf(t: CliTranslator, value: unknown): string;
/** One paired-host row, the exact shape both surfaces print:
 * `[entryId] displayName  serverUrl  state  compat/bridge`. */
export declare function serverLineText(t: CliTranslator, row: ServerRow): string;
/**
 * `dsh-zen-remote status [--json] [--debug [outPath]]`. Identity from one
 * ping; the host surfaces (admin status, wizard status, share list) and the
 * client pool status each fetched only when the role answers them. Exit
 * codes: 0 on any answered status, 1 when the ping itself or the debug
 * round-trip failed.
 */
export declare function runStatusCommand(ctx: CliExecutionContext): Promise<number>;
//# sourceMappingURL=commands-status.d.ts.map