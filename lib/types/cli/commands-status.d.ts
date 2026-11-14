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
/** The peer gateway admission label (PG-10): the seven engine states
 * translated, an unknown value rendered as-is. Shared with the `peer`
 * command family's own renderings. */
export declare function gatewayStateLabel(t: CliTranslator, value: unknown): string;
/** The peer connection-path label: 局域网直连 / 直连 / 经网关中转 / 身份异常 /
 * 离线. Unknown values render as 离线, the engine's default verdict. */
export declare function peerPathLabelOf(t: CliTranslator, value: unknown): string;
/** The mount-capacity facts one `client/peer/status` body normalizes to. */
export interface PeerCapacityFacts {
    /** The network's announced device cap INCLUDING this machine — the raw
     * `maxPeers` verbatim when it answered a finite number. NOT the mount cap. */
    maxPeers: number | undefined;
    /** This machine's EFFECTIVE remote-mount cap: a safe integer in the
     * config's own 1..64 band; a fractional or out-of-band word is protocol
     * junk and stays unknown. */
    maxServers: number | undefined;
    /** This machine's actual mounted remotes: the body's count when it is a
     * non-negative safe integer (never clamped — an over-cap stock after a
     * downscale stays visible); without one, the per-row `mounted` flags count
     * only when EVERY row of the list carries a boolean (an explicit empty
     * list is a real zero; a list with missing flags stays unknown). */
    mountedCount: number | undefined;
    /** `mountedCount >= maxServers` once BOTH facts are known; `undefined`
     * otherwise — `false` would claim room that may not exist. */
    limitReached: boolean | undefined;
}
/** Normalize one peer status body's capacity facts. Pure, defensive: a junk
 * body yields all-unknown, never a plausible-looking guess. */
export declare function peerCapacityOf(body: ServerRow | null): PeerCapacityFacts;
/** The capacity terminal lines, indent included — only the core N/M mount
 * line (or explicit unknown fallback) is emitted normally; full / network-cap
 * warning notes append only when the local mount limit is reached. */
export declare function peerCapacityLines(t: CliTranslator, body: ServerRow | null): string[];
/** One paired-host row, the exact shape both surfaces print:
 * `[entryId] displayName  serverUrl  state  compat/bridge`. */
export declare function serverLineText(t: CliTranslator, row: ServerRow): string;
/** The terminal peer section (PG-10): the node's virtual-network facts —
 * node id, joined network + gateway, admission state, and one row per
 * network device. A missing engine answer renders nothing (the section title
 * alone) instead of failing the command. */
export declare function renderPeerSection(t: CliTranslator, peer: ServerRow | null): string[];
/**
 * `dsh-zen-remote status [--json] [--debug [outPath]]`. Identity from one
 * ping; the host surfaces (admin status, wizard status, share list), the
 * client pool status, and — on a peer node — the peer engine snapshot are
 * each fetched only when the role answers them. Exit codes: 0 on any
 * answered status, 1 when the ping itself or the debug round-trip failed.
 */
export declare function runStatusCommand(ctx: CliExecutionContext): Promise<number>;
//# sourceMappingURL=commands-status.d.ts.map