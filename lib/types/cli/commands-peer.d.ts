/**
 * PG-10: the `peer` subcommand family — `join`, `status`, `trust`, `leave`.
 * Every entry point passes the peer-role gate FIRST (a host or client never
 * reads or writes this machine's peer state), then drives the plugin's own
 * peer routes over IPC — the CLI never touches the peer engine directly, the
 * plugin process stays the single owner.
 *
 * The role-switch procedure is the PG-10 iron rule: switching anything to
 * `peer` NEVER stops the managed Caddy / cloudflared children, because
 * `servesRole('peer')` stays true — the phone / browser gateway channel
 * survives the switch (only switching to `client` stops them, which is
 * setup's business, not ours).
 *
 * Interactivity follows the bootstrap iron rule: a missing value prompts in
 * a TTY run, and a non-interactive run throws MissingRequiredOptionError
 * immediately — a missing invite link or node id never hangs on stdin.
 */
import type { CliExecutionContext } from './context.js';
/**
 * The switch-to-peer procedure shared by `peer join --yes` and the setup
 * wizard: write `role: 'peer'` through the anti-shadowing writer and poll
 * until the row reloaded into the peer role AND the peer surface answers.
 * The managed Caddy / cloudflared children are NEVER touched —
 * `servesRole('peer')` is true, so the phone gateway channel survives.
 */
export declare function switchToPeerRole(ctx: CliExecutionContext): Promise<boolean>;
/**
 * `peer join [inviteUri] [--invite <uri>] [--name <本机名>] [--yes]
 * [--no-wait] [--json]` — the full join flow: the role gate (with the
 * `--yes` / interactive switch that keeps the gateway channel alive), the
 * invite link, the optional display name, the join POST, and the bounded
 * wait for the gateway admission (pending-approval keeps waiting unless
 * `--no-wait`; revoked fails; timeout reports the still-pending state as
 * success with progress kept).
 */
export declare function runPeerJoinCommand(ctx: CliExecutionContext): Promise<number>;
/**
 * `peer status [--json]` — the peer engine's snapshot: this machine's node
 * id, the joined network (id + gateway origin), the admission state, the
 * mount-capacity lines (PC-11c: the local mounts N/M against the effective
 * cap, the full note when reached, the network-total cap separately), and
 * one line per network device (path / rtt / mounted). `--json` echoes the
 * route's own body verbatim behind `ok: true`.
 */
export declare function runPeerStatusCommand(ctx: CliExecutionContext): Promise<number>;
/**
 * `peer trust [nodeId] [--json]` — the explicit local confirmation after a
 * `mismatch` verdict. A missing node id picks from the mismatch devices in a
 * TTY run (none → a friendly nothing-to-do) and raises
 * MissingRequiredOptionError otherwise.
 */
export declare function runPeerTrustCommand(ctx: CliExecutionContext): Promise<number>;
/**
 * `peer leave [--yes] [--json]` — leave the current network. The `client
 * unpair --all` discipline: no destruction without `--yes` outside a TTY
 * confirm; a cancelled confirm is not a failure.
 */
export declare function runPeerLeaveCommand(ctx: CliExecutionContext): Promise<number>;
//# sourceMappingURL=commands-peer.d.ts.map