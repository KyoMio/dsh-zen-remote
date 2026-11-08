/**
 * The CLI's anti-shadowing config writer (CLI-1).
 *
 * `resolveConfig` reads four layers in the order env > row > file > default
 * (src/config.ts). A CLI write lands in the FILE layer
 * (`<dshHome>/lan-gate.config.json`), so two layers can silently swallow it:
 * an environment variable set at the top, and a value the loader put on the
 * plugin row (persisted in the current profile's `cordis.patch.yml`). The
 * writer refuses the first case with the exact variable name, and REMOVES the
 * shadowing keys in the other two — the in-memory row object `apply()` still
 * holds, and the `dsh-zen-remote` `config:` block of every profile patch file
 * it can find — so the just-written file value is what the next
 * `resolveConfig` answers. `onAfterWrite` then lets the caller (the IPC
 * delegate in src/index.ts) trigger the restart watcher immediately, so a
 * restart-required field reloads the row without waiting out the 2s poll.
 *
 * The file is read from `dshHome` DIRECTLY, not through `readFileConfig(env)`:
 * the latter resolves `<env.DSH_HOME ?? ~/.dsh>` and would silently read the
 * developer's real file when a test passes an explicit dshHome with an empty
 * env — resolution and the write must never disagree about which file is the
 * truth.
 *
 * The `cordis.patch.yml` edit is line-based on purpose: the files are
 * user-owned YAML full of comments and hand-tuned formatting that a
 * parse-serialize round trip would destroy, and the edit itself (delete a
 * key line and its indented children from one plugin's config block) is a
 * purely textual operation.
 */
import type { ZenRemoteConfig } from '../config.js';
/**
 * The env variable each config field answers to, for fields that HAVE one.
 * Fields without an entry (role, serverName, idleHours, the wizard's ingress
 * fields, pluginBridgeConsent — src/config.ts explains each absence) can
 * never be env-shadowed, so they are deliberately missing: `writeCliConfig`
 * falls back to the field name itself when asked for one.
 */
export declare const ENV_VAR_BY_FIELD: Readonly<Partial<Record<keyof ZenRemoteConfig, string>>>;
export interface WriteCliConfigOptions {
    /** The DSH home the config files live under (`lan-gate.config.json`,
     * `profiles/<name>/cordis.patch.yml`). Authoritative — env.DSH_HOME is
     * not consulted. */
    dshHome: string;
    /** The profile whose `cordis.patch.yml` is scanned FIRST; the fallback
     * scan over every `<dshHome>/profiles/<name>/cordis.patch.yml` runs
     * besides it, so an un-named profile carrying a stale key is un-shadowed
     * too. */
    profileName?: string | undefined;
    /** The plugin row as `apply()` received it (volatile `{ get() }` wrappers
     * included). Shadowing keys on it are DELETED so the file layer shows
     * through; omit on a composition without a row. */
    row?: Record<string, unknown> | undefined;
    /** The environment carrying `LAN_GATE_*` / `DSH_PUSH_*`; defaults to
     * `process.env`. */
    env?: NodeJS.ProcessEnv | undefined;
    /** Keys to merge into `lan-gate.config.json` (and un-shadow everywhere). */
    set?: Record<string, unknown> | undefined;
    /** Keys to delete from `lan-gate.config.json` (and un-shadow everywhere). */
    unset?: readonly string[] | undefined;
    /** Called AFTER every successful write (never on a refusal and never for
     * an empty write) — the IPC delegate passes the restart watcher's
     * `checkNow`, which reloads the row at once when a restart-required field
     * moved. */
    onAfterWrite?: (() => void) | undefined;
}
export type WriteCliConfigResult = {
    ok: true;
    values: ZenRemoteConfig;
} | {
    ok: false;
    code: 'env-shadowed';
    field: string;
    envVar: string;
};
export declare function applyUnshadowedRowKeys(dshHome: string, row: Record<string, unknown> | undefined): void;
export declare function clearUnshadowedRowKeys(dshHome: string, keys: readonly string[]): void;
/**
 * Remove `keys` from EVERY `- id: dsh-zen-remote` (or bare `id:`) entry's
 * `config:` block, purely textually: a key line and its deeper-indented
 * children disappear, every other line — comments, other plugins' blocks,
 * formatting — survives byte for byte. A block emptied by the removal keeps
 * a `config: {}` line (an entry with no config key at all changes loader
 * semantics). No match, no change: the same string comes back.
 */
export declare function unshadowPatchYml(text: string, keys: readonly string[]): string;
/**
 * Write CLI config changes through the anti-shadowing pipeline. Returns the
 * refused `env-shadowed` verdict (with the exact field and its variable
 * name) WITHOUT touching any file, or the freshly resolved effective values
 * after the write, the row-key deletions and the patch-file un-shadowing.
 */
export declare function writeCliConfig(options: WriteCliConfigOptions): WriteCliConfigResult;
//# sourceMappingURL=config-writer.d.ts.map