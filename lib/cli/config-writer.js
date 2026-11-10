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
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../config.js';
/**
 * The env variable each config field answers to, for fields that HAVE one.
 * Fields without an entry (role, serverName, idleHours, the wizard's ingress
 * fields, pluginBridgeConsent — src/config.ts explains each absence) can
 * never be env-shadowed, so they are deliberately missing: `writeCliConfig`
 * falls back to the field name itself when asked for one.
 */
export const ENV_VAR_BY_FIELD = {
    port: 'LAN_GATE_PORT',
    host: 'LAN_GATE_HOST',
    targetPort: 'LAN_GATE_TARGET_PORT',
    rateLimit: 'LAN_GATE_RATE_LIMIT',
    trustedProxies: 'LAN_GATE_TRUSTED_PROXIES',
    vapidSubject: 'LAN_GATE_VAPID_SUBJECT',
    lang: 'LAN_GATE_LANG',
    pushEvents: 'DSH_PUSH_EVENTS',
    pushDebounceMs: 'DSH_PUSH_DEBOUNCE_MS',
    pushSummary: 'DSH_PUSH_SUMMARY',
    pushTurnEnd: 'DSH_PUSH_TURN_END',
    pushTool: 'DSH_PUSH_TOOL',
    pushEnabled: 'DSH_PUSH_ENABLED',
    pushSessionName: 'DSH_PUSH_SESSION_NAME',
    // PG-2: the pairing cap has an env layer, so a CLI write must refuse when
    // the variable shadows the file layer.
    maxServers: 'LAN_GATE_MAX_SERVERS',
};
/**
 * Keys that CLI explicitly wrote to `lan-gate.config.json` and unshadowed in
 * `cordis.patch.yml` during this process lifetime, keyed by `dshHome`. When
 * `fiber.restart()` reloads the plugin row, `cordis-plugin-loader` re-hydrates
 * the new `config` object from its in-memory patch snapshot (without
 * re-reading `cordis.patch.yml` from disk), which would otherwise re-shadow
 * the file layer with stale `{ get() }` wrappers. `applyUnshadowedRowKeys`
 * strips those stale wrappers on the reloaded `apply()`, and a subsequent
 * Web UI save (`loader/volatile-update`) clears them via
 * `clearUnshadowedRowKeys`.
 */
const unshadowedByHome = new Map();
export function applyUnshadowedRowKeys(dshHome, row) {
    if (row === undefined || row === null || typeof row !== 'object')
        return;
    const keys = unshadowedByHome.get(dshHome);
    if (keys === undefined)
        return;
    for (const key of keys) {
        const val = row[key];
        if (val !== null && typeof val === 'object' && typeof val.get === 'function') {
            delete row[key];
        }
    }
}
export function clearUnshadowedRowKeys(dshHome, keys) {
    const set = unshadowedByHome.get(dshHome);
    if (set === undefined)
        return;
    for (const key of keys)
        set.delete(key);
}
/** Read `<dshHome>/lan-gate.config.json` — `{}` when absent or unparsable,
 * the same degrade-not-throw contract as src/config.ts's readFileConfig. */
function readFileAt(dshHome) {
    try {
        const parsed = JSON.parse(readFileSync(join(dshHome, 'lan-gate.config.json'), 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        return parsed;
    }
    catch {
        return {};
    }
}
/** Atomic 0600 rewrite: tmp + explicit chmod + rename, so a crash mid-write
 * can never leave a half file behind (the discipline of the wizard's
 * trust-proxy persister). */
function writeJsonAtomic(dshHome, body) {
    const file = join(dshHome, 'lan-gate.config.json');
    try {
        mkdirSync(dshHome, { recursive: true });
    }
    catch { /* an existing directory or an unwritable one — the write below reports it */ }
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
}
/** The candidate `cordis.patch.yml` paths: the named profile first (when
 * given), then every profile's patch file found on disk — deduplicated, and
 * only files that actually exist (the editor never CREATES one). */
function patchFileCandidates(dshHome, profileName) {
    const out = [];
    const push = (candidate) => {
        if (!out.includes(candidate) && existsQuiet(candidate))
            out.push(candidate);
    };
    if (profileName !== undefined && profileName !== '') {
        push(join(dshHome, 'profiles', profileName, 'cordis.patch.yml'));
    }
    const profilesDir = join(dshHome, 'profiles');
    try {
        for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'desktop')
                continue;
            push(join(profilesDir, entry.name, 'cordis.patch.yml'));
        }
    }
    catch { /* no profiles directory — nothing to scan */ }
    return out;
}
function existsQuiet(path) {
    try {
        statSync(path);
        return true;
    }
    catch {
        return false;
    }
}
function leadingSpaces(line) {
    const match = /^[ \t]*/u.exec(line);
    return match === null ? 0 : match[0].length;
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
/**
 * Remove `keys` from EVERY `- id: dsh-zen-remote` (or bare `id:`) entry's
 * `config:` block, purely textually: a key line and its deeper-indented
 * children disappear, every other line — comments, other plugins' blocks,
 * formatting — survives byte for byte. A block emptied by the removal keeps
 * a `config: {}` line (an entry with no config key at all changes loader
 * semantics). No match, no change: the same string comes back.
 */
export function unshadowPatchYml(text, keys) {
    if (keys.length === 0)
        return text;
    const lines = text.split('\n');
    const toDelete = new Set();
    const toReplace = new Map();
    for (let i = 0; i < lines.length; i += 1) {
        // The id line: an optional dash + `id: dsh-zen-remote`, trailing comment
        // allowed (`- id: agent-default-model # magpie` shows the shape). The
        // id KEY's column is the prefix length — `config:` sits at that column.
        const idMatch = /^([ \t]*(?:-[ \t]+)?)(id):[ \t]*dsh-zen-remote[ \t]*(?:#.*)?$/u.exec(lines[i]);
        if (idMatch === null)
            continue;
        const keyIndent = idMatch[1].length;
        // The entry's `config:` line: the first `config:` at the id column
        // before the entry ends (a shallower line starts the next entry).
        let configLine = -1;
        let configIndent = -1;
        for (let j = i + 1; j < lines.length; j += 1) {
            const line = lines[j];
            if (line.trim() === '')
                continue;
            const indent = leadingSpaces(line);
            if (indent < keyIndent)
                break;
            if (indent === keyIndent && /^[ \t]*config[ \t]*:(\s|$|#)/u.test(line)) {
                configLine = j;
                configIndent = indent;
                break;
            }
        }
        if (configLine === -1)
            continue;
        // The config block: every following line deeper than the config column
        // (blank lines skipped — they belong to no key). The shallowest indent
        // inside the block is where its top-level keys sit.
        let blockEnd = configLine + 1;
        let minIndent = Number.POSITIVE_INFINITY;
        while (blockEnd < lines.length) {
            const line = lines[blockEnd];
            if (line.trim() === '') {
                blockEnd += 1;
                continue;
            }
            const indent = leadingSpaces(line);
            if (indent <= configIndent)
                break;
            if (indent < minIndent)
                minIndent = indent;
            blockEnd += 1;
        }
        if (!Number.isFinite(minIndent))
            continue;
        for (const key of keys) {
            const keyLine = new RegExp(`^([ \\t]*)${escapeRegExp(key)}[ \\t]*:(\\s|$|#)`, 'u');
            for (let j = configLine + 1; j < blockEnd; j += 1) {
                if (toDelete.has(j))
                    continue;
                const line = lines[j];
                if (line.trim() === '')
                    continue;
                const indent = leadingSpaces(line);
                if (indent !== minIndent || !keyLine.test(line))
                    continue;
                toDelete.add(j);
                // The key's children (deeper-indented lists/maps) go with it.
                for (let q = j + 1; q < blockEnd; q += 1) {
                    const child = lines[q];
                    if (child.trim() === '')
                        continue;
                    if (leadingSpaces(child) <= indent)
                        break;
                    toDelete.add(q);
                }
            }
        }
        // Emptied block → keep a `config: {}` line so the entry's shape survives.
        let remains = false;
        for (let j = configLine + 1; j < blockEnd; j += 1) {
            if (!toDelete.has(j) && lines[j].trim() !== '') {
                remains = true;
                break;
            }
        }
        if (!remains)
            toReplace.set(configLine, `${' '.repeat(configIndent)}config: {}`);
    }
    if (toDelete.size === 0 && toReplace.size === 0)
        return text;
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
        const replacement = toReplace.get(i);
        if (replacement !== undefined)
            out.push(replacement);
        else if (!toDelete.has(i))
            out.push(lines[i]);
    }
    return out.join('\n');
}
/**
 * Write CLI config changes through the anti-shadowing pipeline. Returns the
 * refused `env-shadowed` verdict (with the exact field and its variable
 * name) WITHOUT touching any file, or the freshly resolved effective values
 * after the write, the row-key deletions and the patch-file un-shadowing.
 */
export function writeCliConfig(options) {
    const env = options.env ?? process.env;
    const row = options.row ?? {};
    const set = options.set ?? {};
    const unset = options.unset ?? [];
    const setKeys = Object.keys(set);
    const targetKeys = [...setKeys, ...unset];
    if (targetKeys.length > 0) {
        // Step 1 — the env layer is untouchable from here: a field whose CURRENT
        // effective source is `env` (a legal value lives in a LAN_GATE_* /
        // DSH_PUSH_* variable) refuses the write outright, naming the variable.
        const snapshot = resolveConfig(row, readFileAt(options.dshHome), env);
        const sources = snapshot.sources;
        for (const key of targetKeys) {
            if (sources[key] !== 'env')
                continue;
            return { ok: false, code: 'env-shadowed', field: key, envVar: ENV_VAR_BY_FIELD[key] ?? key };
        }
        // Step 2 — the file layer: merge / delete the keys atomically (0600).
        const merged = { ...readFileAt(options.dshHome) };
        for (const key of setKeys)
            merged[key] = set[key];
        for (const key of unset)
            delete merged[key];
        writeJsonAtomic(options.dshHome, merged);
        // Step 3a — the row layer: the loader wrapped the row's volatile fields
        // in `{ get() }` references, but they are still plain own properties of
        // the same object apply() holds — a delete makes the NEXT resolveConfig
        // fall through this layer to the freshly written file. Record the keys
        // for this `dshHome` so a subsequent `fiber.restart()` also strips the
        // loader's re-hydrated in-memory `{ get() }` wrappers.
        let remembered = unshadowedByHome.get(options.dshHome);
        if (remembered === undefined) {
            remembered = new Set();
            unshadowedByHome.set(options.dshHome, remembered);
        }
        for (const key of targetKeys) {
            remembered.add(key);
            if (key in row)
                delete row[key];
        }
        // Step 3b — the persisted row layer: the profile patch files the loader
        // itself writes when a settings save pins a key on the plugin row.
        for (const file of patchFileCandidates(options.dshHome, options.profileName)) {
            try {
                const before = readFileSync(file, 'utf8');
                const after = unshadowPatchYml(before, targetKeys);
                if (after === before)
                    continue;
                let mode = 0o644;
                try {
                    mode = statSync(file).mode & 0o777;
                }
                catch { /* keep the default */ }
                const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
                writeFileSync(tmp, after, { mode });
                renameSync(tmp, file);
            }
            catch { /* one unreadable profile never blocks the others */ }
        }
        options.onAfterWrite?.();
    }
    // Step 4 — the caller's reload hook fired; answer the values the layers
    // resolve to NOW (the file layer just moved; the row keys just left).
    return { ok: true, values: resolveConfig(row, readFileAt(options.dshHome), env).values };
}
//# sourceMappingURL=config-writer.js.map