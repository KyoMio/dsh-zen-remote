/**
 * CLI-4: the `host` subcommand family — `device pair|list|revoke` and
 * `ingress start|stop|verify|snippet`. Every entry point passes the
 * servesRole gate FIRST (the task discipline: a client never drives the
 * server-owner surfaces; the message names the `setup` switch), then drives
 * the plugin's own admin/wizard routes over IPC.
 *
 * The iron rule for ingress: the CLI NEVER spawns `caddy` or `cloudflared`
 * itself — download, start, stop, status and the three-light verification
 * all happen inside the plugin process through the
 * `/_dsh/zen-remote/admin/wizard/*` routes (SPEC §1). Mode switches mirror
 * `GatewayWizard.tsx`'s discipline: any managed ingress process that does
 * not belong to the new mode is stopped through its stop route before the
 * new mode's flow runs, managed caddy/cloudflared reset `host` back to
 * `127.0.0.1`, and lan rebinds it to `0.0.0.0`.
 *
 * Interactivity follows the bootstrap iron rule: a missing value prompts in
 * a TTY run and throws MissingRequiredOptionError otherwise — except the
 * values with a SAVED fallback (domain, public URL), which the saved wizard
 * status answers before any prompt.
 */
import type { CliExecutionContext } from './context.js';
/**
 * `host device pair [--device-role web|desktop-client] [--json]` — mint one
 * pairing code through the admin pair route and print it with everything
 * the receiving side needs: the reachable URL (public URL, or the LAN
 * address assembled with the gateway's actual port), a terminal QR for web
 * devices, the copy-paste `client pair` command for desktop clients, and
 * the code with its validity window (the gateway mints 10-minute codes).
 */
export declare function runHostDevicePairCommand(ctx: CliExecutionContext): Promise<number>;
/**
 * `host device list [--json]` — the gateway's device table. `--json` echoes
 * the gateway's own devices array verbatim (the machine-readable truth);
 * the terminal mode prints one line per device with its id, name, role,
 * kind and the created / last-seen stamps.
 */
export declare function runHostDeviceListCommand(ctx: CliExecutionContext): Promise<number>;
/**
 * `host device revoke [<id>|--all] [--yes] [--json]` — one revoke POST per
 * invocation. `--all` needs `--yes` outside a TTY confirm (the missing
 * confirmation IS the missing required option); a missing target in an
 * interactive run picks from the current list.
 */
export declare function runHostDeviceRevokeCommand(ctx: CliExecutionContext): Promise<number>;
/**
 * `host ingress snippet [--proxy nginx|caddy|lucky]` — the copy-paste
 * reverse-proxy material for the external ingress mode. The upstream port
 * is the gateway's ACTUAL port (a gateway that retried past its configured
 * port must not hand out snippets pointing at the wrong place); the domain
 * falls back to the example placeholder.
 */
export declare function runHostIngressSnippetCommand(ctx: CliExecutionContext): Promise<number>;
/**
 * `host ingress start [--mode …] …` — the four ingress modes, all driven
 * through the plugin's wizard routes. The mode comes from the flags, then
 * the saved config, then the interactive question; before the new mode's
 * flow runs, every managed process that does not belong to it is stopped
 * through its own stop route (GatewayWizard.tsx's discipline).
 */
export declare function runHostIngressStartCommand(ctx: CliExecutionContext): Promise<number>;
/**
 * `host ingress stop [--yes] [--json]` — stop both managed ingress
 * processes through their stop routes (the CLI owns no process handles to
 * reach for). `--yes` outside a TTY confirm, same discipline as revoke.
 */
export declare function runHostIngressStopCommand(ctx: CliExecutionContext): Promise<number>;
/**
 * `host ingress verify [--public-url <origin>] [--no-wait] [--json]` — the
 * three-light check, driven entirely by the plugin's verify orchestration:
 * POST mints the code and walks the public URL (lights 1 + 2), GET polls
 * for the real phone pairing (light 3). `--no-wait` / `--json` stop after
 * the first two lights; an aborted signal (the entry point's Ctrl-C seam)
 * skips the wait gracefully with exit code 0 — the first two lights'
 * verdict is already on the record.
 */
export declare function runHostIngressVerifyCommand(ctx: CliExecutionContext): Promise<number>;
//# sourceMappingURL=commands-host.d.ts.map