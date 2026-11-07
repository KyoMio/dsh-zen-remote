/**
 * CLI-2 bilingual dictionary and language resolution. Per SPEC the IPC
 * channel only ever carries machine-readable codes and structured data —
 * every terminal string the user sees is rendered HERE, on the CLI side, in
 * the selected language. Placeholder syntax is `{name}`, filled from the
 * `params` argument.
 *
 * Vocabulary discipline (SPEC): the copy speaks ONLY of `host` / `client` /
 * `peer` — `server` / `both` and similar aliases must not leak into any
 * string, in either language. The test file scans both tables for the banned
 * English words to keep it that way.
 */
export type CliLang = 'zh' | 'en';
export type CliTranslator = ((key: string, params?: Record<string, string | number>) => string) & {
    /** The language's raw table, for tests and for key inventory checks. */
    readonly keys: Readonly<Record<string, string>>;
};
/**
 * Resolve the CLI language: `--lang` wins (`zh` / `en`; `auto` and unknown
 * values fall through), then `ZEN_REMOTE_LANG`, then the locale variables in
 * the standard `LC_ALL` > `LC_MESSAGES` > `LANG` order — anything matching
 * `/^zh/i` is Chinese, everything else (including `C`, `POSIX`, empty) is
 * English.
 */
export declare function resolveCliLang(flagLang: string | undefined, env?: NodeJS.ProcessEnv): CliLang;
/**
 * Build a translator for `lang`. Missing keys fall back to the English table
 * and then to the key itself — a forgotten key must be VISIBLE in the output,
 * never silently empty.
 */
export declare function createTranslator(lang: CliLang): CliTranslator;
//# sourceMappingURL=i18n.d.ts.map