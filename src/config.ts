/**
 * Config resolution for dsh-zen-remote: one flat key space, four layers.
 *
 * 2.0.0 moved the settings surface to the DSH plugin row (the loader-owned
 * `Config` schema below), while long-time users keep their
 * `<DSH_HOME>/lan-gate.config.json`. The agreed contract is resolve-time
 * fallback — nothing is ever written back — and per field the first LEGAL
 * value wins in this order:
 *
 *   1. environment variables (`LAN_GATE_*` / `DSH_PUSH_*`, historic names)
 *   2. the plugin row (what the loader hands `apply()`)
 *   3. `lan-gate.config.json`
 *   4. defaults
 *
 * A value that fails its field's check (type, range, enum) makes that layer
 * transparent, as if it had never been set — a hand-edited `port: "abc"` in
 * the row therefore surfaces the file's port, not an error. Legal ranges are
 * enforced HERE and nowhere else. The loader's `Config` schema below is
 * deliberately not a validator: every field is `z.any()` (secret/volatile
 * markers aside), because a schemastery type mismatch makes the loader reject
 * the WHOLE row and the plugin never loads at all — violating the T11 design
 * that a botched `role` degrades to host instead of breaking the plugin.
 * `Config` only tells the settings form WHICH fields exist, which one is a
 * secret, and which are volatile; `resolveConfig` owns every legality rule.
 *
 * Pure logic: no writes, no `process.env` mutation. The one deliberate read
 * is `os.hostname()` for the `serverName` default, which the DEFAULTS table
 * is specified to embed.
 */

import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Where a resolved field value came from, in resolution order. */
export type ConfigSource = 'env' | 'row' | 'file' | 'default'

/** Longest legal `serverName`, in characters. */
const SERVER_NAME_MAX = 40

/** The effective configuration one resolved value set, defaults included. */
export interface ZenRemoteConfig {
  /** Which half of the plugin runs in this DSH process; anything the layers
   * leave unresolved means `'host'` (see {@link resolveRole}). */
  role: 'host' | 'client'
  /** Port the gateway child listens on. */
  port: number
  /** Bind address of the gateway child. */
  host: string
  /** Port of the local DSH Web UI the gateway forwards to; undefined means
   * "discover the host's real listening port at gateway start". */
  targetPort: number | undefined
  /** Remote requests per minute per pairing before 429. */
  rateLimit: number
  /** Comma-separated proxy IPs the gateway trusts for X-Forwarded-*. */
  trustedProxies: string
  /** VAPID subject (a `mailto:` or `https:` URL identifying the push sender). */
  vapidSubject: string
  /** Notification/UI language: `'auto'` defers to the requester's signal. */
  lang: 'auto' | 'zh' | 'en'
  /** Comma-separated session events the push leg treats as turn end. */
  pushEvents: string
  /** Minimum milliseconds between two pushes (approval/question legs exempt). */
  pushDebounceMs: number
  /** Include the turn's final text (or pending question) in push bodies. */
  pushSummary: boolean
  /** Push when a top-level turn ends (opt-in: finishing is not an alarm). */
  pushTurnEnd: boolean
  /** Register the model-facing `push_notify` tool. */
  pushTool: boolean
  /** Server display name, at most {@link SERVER_NAME_MAX} characters. */
  serverName: string
  /** Idle-sleep window of a remote-enabled session: after this many hours
   * without new activity the remote connection closes on its own; running or
   * waiting sessions never count. (0, 8760]. */
  idleHours: number
  /** Auto-share every newly created session to the paired phone (T16). */
  autoShareNewSessions: boolean
}

function defaultServerName(): string {
  return hostname().replace(/\.local$/u, '').slice(0, SERVER_NAME_MAX)
}

/** Defaults, one per field — exactly what layer 4 hands back. */
export const DEFAULTS: ZenRemoteConfig = {
  role: 'host',
  port: 3088,
  host: '127.0.0.1',
  targetPort: undefined,
  rateLimit: 120,
  trustedProxies: '',
  vapidSubject: 'mailto:admin@localhost',
  lang: 'auto',
  pushEvents: 'agent/turn-stopping',
  pushDebounceMs: 15000,
  pushSummary: false,
  pushTurnEnd: false,
  pushTool: true,
  serverName: defaultServerName(),
  idleHours: 48,
  autoShareNewSessions: false,
}

// --- per-field validators -------------------------------------------------
// Each takes an unknown layer value and returns the normalized legal value,
// or undefined when the layer "was not set". Env strings go through the same
// validators after Number(), so one definition owns each field's range.

/**
 * Peel the loader's volatile wrapper off a row value. Schemastery hands
 * `.volatile()` fields to apply() as cosmokit `{ get() }` reference objects,
 * NOT as the value itself — a wrapper run through a validator unchecked would
 * fail every check and the row layer would silently never win for those
 * fields. Anything with a callable `get` is unwrapped; everything else passes
 * through (the same duck-typing the verifier plugin's settingsOf uses, so no
 * dependency on the wrapper's symbol protocol). Later tasks that read live
 * settings at operation time use this too.
 */
export function unwrapVolatile(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get: () => unknown }).get()
  }
  return value
}

/** Integer inside an inclusive band (ports, rate limit). */
function intIn(min: number, max: number): (value: unknown) => number | undefined {
  return (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined
}

/** Non-negative integer (debounce windows). */
function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** Finite number in (min, max] — idleHours excludes zero but allows 8760. */
function inRange(min: number, max: number): (value: unknown) => number | undefined {
  return (value) =>
    typeof value === 'number' && Number.isFinite(value) && value > min && value <= max ? value : undefined
}

/** Non-blank string, returned verbatim. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** One of the exact enum members — anything else makes the layer transparent. */
function oneOf<T extends string>(...allowed: readonly T[]): (value: unknown) => T | undefined {
  return (value) => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined)
}

/** Boolean per the file-format convention: real booleans, plus the historic
 * `1` / `"1"` (true) and `0` / `"0"` (false). Anything else is unset. */
function boolLike(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  return undefined
}

/** Comma-separated proxy list: a string verbatim, or an all-string array
 * joined with commas (the row's settings form stores arrays). */
function commaList(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join(',')
  return undefined
}

/** `serverName`: non-blank, truncated to the cap — over-long is a clip, not
 * a rejection, because the value is cosmetic and rejecting it would only
 * push users to YAML archaeology. */
function serverNameOf(value: unknown): string | undefined {
  const name = nonEmptyString(value)
  return name === undefined ? undefined : name.slice(0, SERVER_NAME_MAX)
}

/** Env validator applied to `Number(env[name])`, so `LAN_GATE_PORT='abc'`
 * lands in the same "unset" bucket as a bad row value. */
function envNumber(
  name: string,
  validate: (value: unknown) => number | undefined,
): (env: NodeJS.ProcessEnv) => number | undefined {
  return (env) => {
    const raw = env[name]
    return raw === undefined ? undefined : validate(Number(raw))
  }
}

function envString(name: string): (env: NodeJS.ProcessEnv) => string | undefined {
  return (env) => {
    const raw = env[name]
    return raw === undefined ? undefined : raw
  }
}

function envOneOf<T extends string>(
  name: string,
  ...allowed: readonly T[]
): (env: NodeJS.ProcessEnv) => T | undefined {
  const validate = oneOf(...allowed)
  return (env) => validate(env[name])
}

/** Env booleans keep their historic per-variable semantics: `'1'` means on
 * for the opt-in flags, while pushTool flips off only on exactly `'0'`. */
function envBool(name: string, isTrue: (raw: string) => boolean): (env: NodeJS.ProcessEnv) => boolean | undefined {
  return (env) => {
    const raw = env[name]
    return raw === undefined ? undefined : isTrue(raw)
  }
}

/** File-layer number leniency: `lan-gate.config.json` has no schema, and the
 * old `Number(...)` read path happily accepted digit strings, so a migrated
 * `"port": "4000"` must keep working. Only `/^\d+$/` qualifies — signs,
 * decimals and any other string stay illegal. Row values do NOT get this:
 * they arrive through the loader, where a wrong type is an editing mistake,
 * not a legacy artifact. */
function lenientFileNumber(validate: (value: unknown) => number | undefined): (value: unknown) => number | undefined {
  return (value) => (typeof value === 'string' && /^\d+$/.test(value) ? validate(Number(value)) : validate(value))
}

/** File-layer pushEvents leniency: an array of event names joins into the
 * comma-separated string the field stores. */
function filePushEvents(value: unknown): string | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join(',')
  return nonEmptyString(value)
}

// --- the field table -------------------------------------------------------

/** How each field reads one layer. Every extractor takes the FIELD VALUE
 * (the caller does the property read); `env` is present only where a
 * variable exists and reads its own name. */
interface FieldResolver<T> {
  env?: (env: NodeJS.ProcessEnv) => T | undefined
  /** Row layer, on the volatile-unwrapped value. */
  row: (value: unknown) => T | undefined
  /** File layer. A field without one deliberately never reads
   * lan-gate.config.json — targetPort keeps its historic env/row-only shape,
   * because a `"targetPort": 3080` written for a 0.1.x setup would forward
   * the gateway to the WRONG port once the host moves behind a desktop
   * build's configurable Web UI port. */
  file?: (value: unknown) => T | undefined
}

const FIELDS: { [K in keyof ZenRemoteConfig]: FieldResolver<ZenRemoteConfig[K]> } = {
  role: { row: oneOf('host', 'client'), file: oneOf('host', 'client') },
  port: { env: envNumber('LAN_GATE_PORT', intIn(1, 65535)), row: intIn(1, 65535), file: lenientFileNumber(intIn(1, 65535)) },
  host: { env: envString('LAN_GATE_HOST'), row: nonEmptyString, file: nonEmptyString },
  targetPort: { env: envNumber('LAN_GATE_TARGET_PORT', intIn(1, 65535)), row: intIn(1, 65535) },
  rateLimit: { env: envNumber('LAN_GATE_RATE_LIMIT', intIn(1, Number.MAX_SAFE_INTEGER)), row: intIn(1, Number.MAX_SAFE_INTEGER), file: lenientFileNumber(intIn(1, Number.MAX_SAFE_INTEGER)) },
  trustedProxies: { env: envString('LAN_GATE_TRUSTED_PROXIES'), row: commaList, file: commaList },
  vapidSubject: { env: envString('LAN_GATE_VAPID_SUBJECT'), row: nonEmptyString, file: nonEmptyString },
  lang: { env: envOneOf('LAN_GATE_LANG', 'auto', 'zh', 'en'), row: oneOf('auto', 'zh', 'en'), file: oneOf('auto', 'zh', 'en') },
  pushEvents: { env: envString('DSH_PUSH_EVENTS'), row: nonEmptyString, file: filePushEvents },
  pushDebounceMs: { env: envNumber('DSH_PUSH_DEBOUNCE_MS', nonNegativeInt), row: nonNegativeInt, file: lenientFileNumber(nonNegativeInt) },
  pushSummary: { env: envBool('DSH_PUSH_SUMMARY', (raw) => raw === '1'), row: boolLike, file: boolLike },
  pushTurnEnd: { env: envBool('DSH_PUSH_TURN_END', (raw) => raw === '1'), row: boolLike, file: boolLike },
  pushTool: { env: envBool('DSH_PUSH_TOOL', (raw) => raw !== '0'), row: boolLike, file: boolLike },
  serverName: { row: serverNameOf, file: serverNameOf },
  idleHours: { row: inRange(0, 8760), file: inRange(0, 8760) },
  autoShareNewSessions: { row: boolLike, file: boolLike },
}

/**
 * Resolve one field through env → row → file → default, recording which layer
 * supplied the value. The first layer whose value passes the field's check
 * wins; earlier illegal values simply do not exist.
 */
function resolveField<K extends keyof ZenRemoteConfig>(
  key: K,
  row: Record<string, unknown>,
  file: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  sources: Record<keyof ZenRemoteConfig, ConfigSource>,
): ZenRemoteConfig[K] {
  const field: FieldResolver<ZenRemoteConfig[K]> = FIELDS[key]
  const fromEnv = field.env?.(env)
  if (fromEnv !== undefined) {
    sources[key] = 'env'
    return fromEnv
  }
  // The loader wraps volatile fields in { get() } references before apply()
  // ever sees the row — peel it, or those fields could never validate.
  const fromRow = field.row(unwrapVolatile(row[key]))
  if (fromRow !== undefined) {
    sources[key] = 'row'
    return fromRow
  }
  // No file extractor means the field intentionally skips the file layer.
  if (field.file !== undefined) {
    const fromFile = field.file(file[key])
    if (fromFile !== undefined) {
      sources[key] = 'file'
      return fromFile
    }
  }
  sources[key] = 'default'
  return DEFAULTS[key]
}

/** What one row-like object looks like to the field extractors. */
function asLayer(source: unknown): Record<string, unknown> {
  return source !== null && typeof source === 'object' && !Array.isArray(source)
    ? (source as Record<string, unknown>)
    : {}
}

/**
 * The effective configuration: every field resolved through the four layers.
 * @param row - the plugin row config as `apply()` received it (loosely typed
 *   because the loader's parsed shape and hand-edited YAML differ).
 * @param file - the parsed `lan-gate.config.json`, `{}` when absent.
 * @param env - environment carrying the optional `LAN_GATE_*` / `DSH_PUSH_*`
 *   variables.
 * @returns the merged values plus, per field, the layer it came from.
 */
export function resolveConfig(
  row: unknown,
  file: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): {
  values: ZenRemoteConfig
  sources: Record<keyof ZenRemoteConfig, ConfigSource>
} {
  const safeRow = asLayer(row)
  const safeFile = asLayer(file)
  const sources = {} as Record<keyof ZenRemoteConfig, ConfigSource>
  const values: ZenRemoteConfig = {
    role: resolveField('role', safeRow, safeFile, env, sources),
    port: resolveField('port', safeRow, safeFile, env, sources),
    host: resolveField('host', safeRow, safeFile, env, sources),
    targetPort: resolveField('targetPort', safeRow, safeFile, env, sources),
    rateLimit: resolveField('rateLimit', safeRow, safeFile, env, sources),
    trustedProxies: resolveField('trustedProxies', safeRow, safeFile, env, sources),
    vapidSubject: resolveField('vapidSubject', safeRow, safeFile, env, sources),
    lang: resolveField('lang', safeRow, safeFile, env, sources),
    pushEvents: resolveField('pushEvents', safeRow, safeFile, env, sources),
    pushDebounceMs: resolveField('pushDebounceMs', safeRow, safeFile, env, sources),
    pushSummary: resolveField('pushSummary', safeRow, safeFile, env, sources),
    pushTurnEnd: resolveField('pushTurnEnd', safeRow, safeFile, env, sources),
    pushTool: resolveField('pushTool', safeRow, safeFile, env, sources),
    serverName: resolveField('serverName', safeRow, safeFile, env, sources),
    idleHours: resolveField('idleHours', safeRow, safeFile, env, sources),
    autoShareNewSessions: resolveField('autoShareNewSessions', safeRow, safeFile, env, sources),
  }
  return { values, sources }
}

/**
 * Read `<DSH_HOME>/lan-gate.config.json` (DSH_HOME defaulting to `~/.dsh`).
 * Missing file, unparsable JSON, or a non-object root (arrays included) all
 * yield `{}` — a broken file must degrade to defaults, never take the host
 * process down. Never writes.
 * @param env - environment providing DSH_HOME; defaults to `process.env`.
 */
export function readFileConfig(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  try {
    const home = env.DSH_HOME ?? join(homedir(), '.dsh')
    const parsed: unknown = JSON.parse(readFileSync(join(home, 'lan-gate.config.json'), 'utf8'))
    return asLayer(parsed)
  } catch {
    return {}
  }
}

/**
 * The normalized role behind a row's `role` knob. Anything but the exact
 * string `'client'` means host, so a typo degrades to the full plugin rather
 * than silently dropping the gateway and push halves. The value is read
 * through {@link unwrapVolatile} first: since T17 every row field arrives as
 * a `{ get() }` live reference, and comparing the wrapper itself against
 * `'client'` would always answer host (T17b). Resolution-order note:
 * {@link resolveConfig} validates each layer against the two-member enum
 * first, so an invalid row role can still be rescued by the file layer; this
 * function answers the final merged value. Kept on the main entry's export
 * surface for test/role-wiring.test.cjs.
 */
export function resolveRole(row: unknown): 'host' | 'client' {
  return unwrapVolatile((row as { role?: unknown } | null | undefined)?.role) === 'client' ? 'client' : 'host'
}

/**
 * The DSH loader's config schema for the plugin row: what the settings form
 * renders and what it hands `apply()`. Every field is `z.any()` on purpose —
 * legality is entirely {@link resolveConfig}'s job. A schemastery type
 * mismatch (`z.number()` meeting `port: "abc"`) makes the loader throw away
 * the whole row and the plugin never loads, which would break the T11
 * promise that a botched `role` degrades to host instead of killing the
 * plugin. So this schema only declares: WHICH fields exist (the form's
 * field list), WHICH one is a secret (`deviceToken`, redacted from every
 * settings wire surface), and that every field is volatile (live).
 *
 * No `.default()` anywhere: a schema default would be written into every row
 * at load and `lan-gate.config.json`'s fallback would never get a turn — the
 * real defaults live in {@link DEFAULTS}.
 *
 * EVERY field is volatile, and that is not an optimization: DSH 0.2.0's
 * settings service builds the form from volatile fields ONLY (its
 * `volatileForm` drops non-volatile ones, and a `mutate` outside the volatile
 * subtree is refused), so a non-volatile field is invisible in the settings
 * page and unsaveable from it — T12 made the restart-required fields
 * non-volatile and the whole settings surface went dark for them. The cost
 * is that the loader hands every volatile field to `apply()` as a `{ get() }`
 * wrapper instead of the value, so EVERY row read goes through
 * {@link unwrapVolatile} at use time (or through {@link resolveConfig},
 * which unwraps per field). "Changed value requires a restart" therefore
 * cannot ride the volatility flag: the fields in `RESTART_FIELDS`
 * (src/restart-fields.ts) are re-resolved the moment the loader announces a
 * volatile-only change (`loader/volatile-update`, T17b) and on a 2-second
 * poll besides, and reload the plugin row when their fingerprint moves — a
 * row reload re-runs `apply()`, which restarts the gateway child and the
 * push half.
 */
export const Config = z.object({
  role: z.any().volatile(),
  port: z.any().volatile(),
  host: z.any().volatile(),
  targetPort: z.any().volatile(),
  rateLimit: z.any().volatile(),
  trustedProxies: z.any().volatile(),
  vapidSubject: z.any().volatile(),
  lang: z.any().volatile(),
  pushEvents: z.any().volatile(),
  pushDebounceMs: z.any().volatile(),
  pushSummary: z.any().volatile(),
  pushTurnEnd: z.any().volatile(),
  pushTool: z.any().volatile(),
  serverName: z.any().volatile(),
  idleHours: z.any().volatile(),
  autoShareNewSessions: z.any().volatile(),
  // Client-half knobs (T16): where the phone finds the gateway, and the
  // pairing token it presents. `role('secret')` keeps the token out of every
  // settings wire surface, like the verifier plugin's API key.
  serverUrl: z.any().volatile(),
  deviceToken: z.string().role('secret').volatile(),
  // Interface-half knobs, read live off the row by src/index.ts (unwrapped
  // per request, like every volatile field).
  turnFoldDesktop: z.any().volatile(),
  keyboardLiftRatio: z.any().volatile(),
  keyboardLiftMaxPx: z.any().volatile(),
  keyboardSafetyPadPx: z.any().volatile(),
  maxUploadBytes: z.any().volatile(),
})
