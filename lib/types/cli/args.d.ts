/**
 * CLI-2 command-line parsing: the whole `dsh-zen-remote` grammar in one pure
 * function. It answers WHAT the user asked for — command routing, option
 * values, targets — and deliberately does not VALIDATE cross-field rules
 * (role gates, required targets): the command layer renders those verdicts
 * through the i18n dictionary. Two things the parser does decide on its own:
 * `--role peer` (and any unknown role value) is flagged `roleIssue` because
 * SPEC pins the "peer is not enabled" refusal at every entry point, and
 * `--debug`'s optional path argument is consumed only when it does not look
 * like another flag.
 *
 * Global flags may appear before or after the command word; the leading
 * positional tokens ARE the command (`host device revoke dev-7` → three
 * command words + one target), everything flag-like is an option.
 */
export type CliCommand = 'help' | 'version' | 'unknown' | 'setup' | 'status' | 'host.device.pair' | 'host.device.list' | 'host.device.revoke' | 'host.ingress.start' | 'host.ingress.stop' | 'host.ingress.verify' | 'host.ingress.snippet' | 'client.pair' | 'client.unpair' | 'client.list';
/** Why a `--role` value cannot be used as-is. `peer-not-enabled` covers the
 * SPEC's reserved role; `invalid` covers everything the vocabulary does not
 * know. Absent when the value is `host` or `client`. */
export type CliRoleIssue = 'peer-not-enabled' | 'invalid';
export interface CliOptions {
    /** Raw `--lang` value — `resolveCliLang` (i18n.ts) interprets it later. */
    lang?: string;
    json: boolean;
    yes: boolean;
    noWait: boolean;
    /** Explicit IPC socket path; discovery probes only this when present. */
    socket?: string;
    /** Seconds to wait for DSH to come up; default 20. */
    wait: number;
    /** `status --debug` without a path: write the default filename. */
    debug: boolean;
    /** `status --debug <outPath>`: the exact output file. */
    debugPath?: string;
    /** Raw `--role` value, preserved verbatim. */
    role?: string;
    roleIssue?: CliRoleIssue;
    /** `--profile p1,p2` split on commas, trimmed, empties dropped. */
    profile?: string[];
    /** `--ingress` value (caddy | cloudflared | external | lan). */
    ingress?: string;
    /** `--mode` — a synonym of `--ingress`, kept separately for callers that
     * want to know which spelling the user used. */
    mode?: string;
    domain?: string;
    cfToken?: string;
    email?: string;
    httpsPort?: number;
    publicUrl?: string;
    tunnelId?: string;
    proxy?: string;
    deviceRole?: string;
    hostUrl?: string;
    code?: string;
    name?: string;
    all: boolean;
    /** Unrecognized `--flags`, collected instead of crashing — the command
     * layer decides whether to warn. */
    unknownFlags: string[];
}
export interface ParsedCliArgs {
    command: CliCommand;
    options: CliOptions;
    /** The positional argument after the command words (a device id, a host
     * URL, an entry id). `--all` as the revoke/unpair target becomes
     * `options.all` instead. */
    target?: string;
    /** The unrecognized command words, joined for the error message. */
    unknownCommand?: string;
}
/**
 * Parse `argv` (without the node binary and script path) into a structured
 * command. `--help` / `-h` anywhere wins over everything, then `--version` /
 * `-v`; flags with no command still route to `help` (running the binary bare
 * must not fall into the interactive wizard).
 */
export declare function parseCliArgs(argv: readonly string[]): ParsedCliArgs;
//# sourceMappingURL=args.d.ts.map