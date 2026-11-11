/**
 * CLI-2 command-line parsing: the whole `dsh-zen-remote` grammar in one pure
 * function. It answers WHAT the user asked for — command routing, option
 * values, targets — and deliberately does not VALIDATE cross-field rules
 * (role gates, required targets): the command layer renders those verdicts
 * through the i18n dictionary. Two things the parser does decide on its own:
 * an unknown `--role` value is flagged `roleIssue` (`host` / `client` /
 * `peer` are all legal since PG-10), and `--debug`'s optional path argument
 * is consumed only when it does not look like another flag.
 *
 * Global flags may appear before or after the command word; the leading
 * positional tokens ARE the command (`host device revoke dev-7` → three
 * command words + one target), everything flag-like is an option.
 */

export type CliCommand =
  | 'help'
  | 'version'
  | 'unknown'
  | 'setup'
  | 'status'
  | 'host.device.pair'
  | 'host.device.list'
  | 'host.device.revoke'
  | 'host.ingress.start'
  | 'host.ingress.stop'
  | 'host.ingress.verify'
  | 'host.ingress.snippet'
  | 'client.pair'
  | 'client.unpair'
  | 'client.list'
  | 'peer.join'
  | 'peer.status'
  | 'peer.trust'
  | 'peer.leave'

/** Why a `--role` value cannot be used as-is. `invalid` covers everything
 * the vocabulary does not know. Absent when the value is `host`, `client`
 * or `peer` — all three are legal since PG-10. */
export type CliRoleIssue = 'invalid'

export interface CliOptions {
  /** Raw `--lang` value — `resolveCliLang` (i18n.ts) interprets it later. */
  lang?: string
  json: boolean
  yes: boolean
  noWait: boolean
  /** Explicit IPC socket path; discovery probes only this when present. */
  socket?: string
  /** Seconds to wait for DSH to come up; default 20. */
  wait: number
  /** `status --debug` without a path: write the default filename. */
  debug: boolean
  /** `status --debug <outPath>`: the exact output file. */
  debugPath?: string
  /** Raw `--role` value, preserved verbatim. */
  role?: string
  roleIssue?: CliRoleIssue
  /** `--profile p1,p2` split on commas, trimmed, empties dropped. */
  profile?: string[]
  /** `--ingress` value (caddy | cloudflared | external | lan). */
  ingress?: string
  /** `--mode` — a synonym of `--ingress`, kept separately for callers that
   * want to know which spelling the user used. */
  mode?: string
  domain?: string
  cfToken?: string
  email?: string
  httpsPort?: number
  publicUrl?: string
  tunnelId?: string
  proxy?: string
  deviceRole?: string
  hostUrl?: string
  code?: string
  name?: string
  /** `--invite <uri>` — the `zr-net(s)://` invite link of the virtual
   * network a peer node joins. */
  invite?: string
  all: boolean
  /** Unrecognized `--flags`, collected instead of crashing — the command
   * layer decides whether to warn. */
  unknownFlags: string[]
}

export interface ParsedCliArgs {
  command: CliCommand
  options: CliOptions
  /** The positional argument after the command words (a device id, a host
   * URL, an entry id). `--all` as the revoke/unpair target becomes
   * `options.all` instead. */
  target?: string
  /** The unrecognized command words, joined for the error message. */
  unknownCommand?: string
}

/** `--flag value` options, mapped onto CliOptions field names. */
const VALUE_OPTIONS: Readonly<Record<string, 'lang' | 'socket' | 'wait' | 'role' | 'profile' | 'ingress' | 'mode' | 'domain' | 'cfToken' | 'email' | 'httpsPort' | 'publicUrl' | 'tunnelId' | 'proxy' | 'deviceRole' | 'hostUrl' | 'code' | 'name' | 'invite'>> = {
  '--lang': 'lang',
  '--socket': 'socket',
  '--wait': 'wait',
  '--role': 'role',
  '--profile': 'profile',
  '--ingress': 'ingress',
  '--mode': 'mode',
  '--domain': 'domain',
  '--cf-token': 'cfToken',
  '--email': 'email',
  '--https-port': 'httpsPort',
  '--public-url': 'publicUrl',
  '--tunnel-id': 'tunnelId',
  '--proxy': 'proxy',
  '--device-role': 'deviceRole',
  '--host-url': 'hostUrl',
  '--code': 'code',
  '--name': 'name',
  '--invite': 'invite',
}

/** Boolean switches. `-y` is the only short alias (the one SPEC names). */
const BOOLEAN_OPTIONS: Readonly<Record<string, 'json' | 'yes' | 'noWait' | 'all'>> = {
  '--json': 'json',
  '--yes': 'yes',
  '-y': 'yes',
  '--no-wait': 'noWait',
  '--all': 'all',
}

const KNOWN_ROLES = new Set(['host', 'client', 'peer'])

function defaultOptions(): CliOptions {
  return {
    json: false,
    yes: false,
    noWait: false,
    wait: 20,
    debug: false,
    all: false,
    unknownFlags: [],
  }
}

function assignValue(field: (typeof VALUE_OPTIONS)[string], raw: string, options: CliOptions): void {
  switch (field) {
    case 'wait': {
      const seconds = Number(raw)
      if (Number.isFinite(seconds) && seconds >= 0) options.wait = seconds
      // A garbage value keeps the 20s default instead of poisoning the wait.
      return
    }
    case 'profile': {
      const names = raw.split(',').map((name) => name.trim()).filter((name) => name !== '')
      options.profile = names
      return
    }
    case 'httpsPort': {
      const port = Number(raw)
      if (Number.isInteger(port) && port > 0) options.httpsPort = port
      return
    }
    case 'role': {
      options.role = raw
      if (!KNOWN_ROLES.has(raw)) options.roleIssue = 'invalid'
      return
    }
    case 'lang': options.lang = raw; return
    case 'socket': options.socket = raw; return
    case 'ingress': options.ingress = raw; return
    case 'mode': options.mode = raw; return
    case 'domain': options.domain = raw; return
    case 'cfToken': options.cfToken = raw; return
    case 'email': options.email = raw; return
    case 'publicUrl': options.publicUrl = raw; return
    case 'tunnelId': options.tunnelId = raw; return
    case 'proxy': options.proxy = raw; return
    case 'deviceRole': options.deviceRole = raw; return
    case 'hostUrl': options.hostUrl = raw; return
    case 'code': options.code = raw; return
    case 'name': options.name = raw; return
    case 'invite': options.invite = raw; return
  }
}

function setBooleanFlag(field: (typeof BOOLEAN_OPTIONS)[string], options: CliOptions): void {
  switch (field) {
    case 'json': options.json = true; return
    case 'yes': options.yes = true; return
    case 'noWait': options.noWait = true; return
    case 'all': options.all = true; return
  }
}

/** Route the leading positional words into a command. Returns `undefined`
 * when the words name a valid command with a target slot still open
 * (`host device revoke …`), and a full verdict otherwise. */
function routeCommand(positionals: readonly string[], options: CliOptions): ParsedCliArgs {
  const c1 = positionals[0]
  const c2 = positionals[1]
  const c3 = positionals[2]
  const unknown = (words: readonly (string | undefined)[]): ParsedCliArgs => ({
    command: 'unknown',
    options,
    unknownCommand: words.filter((word) => word !== undefined).join(' '),
  })

  if (c1 === 'setup') {
    // `setup <hostUrl>` — the client branch's pairing address as a positional
    // (equivalent to `--host-url`; the flag still wins when both appear).
    return { command: 'setup', options, ...(c2 === undefined ? {} : { target: c2 }) }
  }
  if (c1 === 'status') return { command: 'status', options }

  if (c1 === 'host') {
    if (c2 === 'device' && (c3 === 'pair' || c3 === 'list' || c3 === 'revoke')) {
      // `revoke <id|--all>` is the only device verb with a target slot; an
      // `--all` positional means the flag, not a device literally named
      // "--all".
      let target = c3 === 'revoke' ? positionals[3] : undefined
      if (target === '--all') {
        options.all = true
        target = undefined
      }
      return { command: `host.device.${c3}`, options, ...(target === undefined ? {} : { target }) }
    }
    if (c2 === 'ingress' && (c3 === 'start' || c3 === 'stop' || c3 === 'verify' || c3 === 'snippet')) {
      return { command: `host.ingress.${c3}`, options }
    }
    return unknown([c1, c2, c3])
  }

  if (c1 === 'client') {
    if (c2 === 'pair' || c2 === 'unpair') {
      const target = positionals[2]
      return { command: `client.${c2}`, options, ...(target === undefined ? {} : { target }) }
    }
    if (c2 === 'list') return { command: 'client.list', options }
    return unknown([c1, c2])
  }

  if (c1 === 'peer') {
    if (c2 === 'join') {
      // `peer join [inviteUri]` — exactly one slot for the invite link; a
      // second positional is a typo'd command, not part of a URI.
      if (positionals.length > 3) return unknown([c1, c2, ...positionals.slice(3)])
      return { command: 'peer.join', options, ...(c3 === undefined ? {} : { target: c3 }) }
    }
    if (c2 === 'status' && c3 === undefined) return { command: 'peer.status', options }
    if (c2 === 'trust') {
      if (positionals.length > 3) return unknown([c1, c2, ...positionals.slice(3)])
      return { command: 'peer.trust', options, ...(c3 === undefined ? {} : { target: c3 }) }
    }
    if (c2 === 'leave' && c3 === undefined) return { command: 'peer.leave', options }
    return unknown([c1, c2])
  }

  return unknown([c1])
}

/**
 * Parse `argv` (without the node binary and script path) into a structured
 * command. `--help` / `-h` anywhere wins over everything, then `--version` /
 * `-v`; flags with no command still route to `help` (running the binary bare
 * must not fall into the interactive wizard).
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const options = defaultOptions()
  const positionals: string[] = []
  let index = 0
  while (index < argv.length) {
    const token = argv[index]
    if (token === undefined) break
    index += 1
    if (token === '--help' || token === '-h' || token === '--version' || token === '-v') {
      continue
    }
    if (token === '--debug') {
      // `--debug [outPath]`: a following non-flag token is the output path,
      // anything else (nothing, another flag) means the default filename.
      const next = argv[index]
      if (next !== undefined && !next.startsWith('-')) {
        options.debugPath = next
        index += 1
      } else {
        options.debug = true
      }
      continue
    }
    const booleanField = BOOLEAN_OPTIONS[token]
    if (booleanField !== undefined) {
      setBooleanFlag(booleanField, options)
      continue
    }
    const valueField = VALUE_OPTIONS[token]
    if (valueField !== undefined) {
      const next = argv[index]
      if (next === undefined || next.startsWith('-')) continue // missing value — leave the field unset
      index += 1
      assignValue(valueField, next, options)
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      options.unknownFlags.push(token)
      continue
    }
    positionals.push(token)
  }

  if (argv.includes('--help') || argv.includes('-h')) return { command: 'help', options }
  if (argv.includes('--version') || argv.includes('-v')) return { command: 'version', options }
  if (positionals.length === 0) return { command: 'help', options }
  return routeCommand(positionals, options)
}
