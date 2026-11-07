/**
 * CLI-3: the `client` subcommand family — `pair`, `unpair`, `list`. Every
 * entry point passes the connectsRole gate FIRST (the task discipline: a
 * host never dials a remote host; the message names the `setup --role
 * client` switch), then drives the plugin's own pairing routes over IPC —
 * the CLI never touches the relay pool or the state file directly, the
 * plugin process stays the single owner.
 *
 * Interactivity follows the bootstrap iron rule: a missing value prompts in
 * a TTY run, and a non-interactive run throws MissingRequiredOptionError
 * immediately — except the one retry the SPEC pins: a WRONG pairing code in
 * an interactive run falls back to re-asking ONLY the code, the already
 * entered address stays put.
 */

import { promptOrFail, MissingRequiredOptionError } from './bootstrap.js'
import { normalizeServerUrl } from '../client-pairing.js'
import { CLIENT_CLAIM_ROUTE, CLIENT_UNPAIR_ROUTE, CLIENT_STATUS_ROUTE } from '../client-routes.js'
import type { CliExecutionContext } from './context.js'
import type { CliTranslator } from './i18n.js'
import { fetchBody, plainOf, serverLineText } from './commands-status.js'
import type { ServerRow } from './commands-status.js'

/** `client pair`'s online wait: the 10s budget is fixed, the interval is a
 * test seam. */
const POLL_BUDGET_MS = 10_000
const POLL_INTERVAL_DEFAULT_MS = 250

const CODE_PATTERN = /^[A-Za-z0-9]{8}$/u

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The servers rows of a client/status answer, defensively filtered. */
function serversOf(body: ServerRow | null): ServerRow[] {
  const rows = body === null ? [] : Array.isArray(body.servers) ? body.servers : []
  return rows
    .map((row) => plainOf(row))
    .filter((row): row is ServerRow => row !== null)
}

async function fetchStatus(ctx: CliExecutionContext): Promise<ServerRow | null> {
  return await fetchBody(() => ctx.ipc.request('GET', CLIENT_STATUS_ROUTE))
}

/**
 * The role gate every `client *` command passes first: fresh ping (the role
 * is a volatile row field), and a host/peer answers the bilingual refusal.
 */
async function requireConnectsRole(ctx: CliExecutionContext): Promise<boolean> {
  let connects = false
  let role = 'host'
  try {
    const ping = await ctx.ipc.ping()
    connects = ping.connects
    role = ping.role
  } catch {
    // No live plugin is no role that connects either — same refusal text.
  }
  if (connects) return true
  ctx.stdout.write(`${ctx.t('err.roleGate.clientCommands', { role })}\n`)
  return false
}

/** One ask-text-or-throw: interactive runs prompt through the prompter,
 * anything else raises the structured missing-option error. */
async function askText(ctx: CliExecutionContext, optionName: string, question: string, validate?: (value: string) => string | undefined): Promise<string> {
  return await promptOrFail({
    optionName,
    interactive: ctx.interactive,
    provided: undefined,
    ask: async () => {
      if (ctx.prompter === undefined) throw new MissingRequiredOptionError(optionName)
      return await ctx.prompter.inputText(question, undefined, validate)
    },
  })
}

// ===========================================================================
// client list
// ===========================================================================

/**
 * `client list [--json]` — the paired-host table. `--json` echoes the pool
 * status's own servers array verbatim (the machine-readable truth), the
 * terminal mode prints the header count and one line per host.
 */
export async function runClientListCommand(ctx: CliExecutionContext): Promise<number> {
  if (!(await requireConnectsRole(ctx))) return 1
  const { t } = ctx
  const body = await fetchStatus(ctx)
  if (body === null) {
    ctx.stdout.write(`${t('clientList.fetchFailed', { error: t('status.notRunning') })}\n`)
    return 1
  }
  const servers = serversOf(body)
  const max = typeof body.maxServers === 'number' ? body.maxServers : 8
  if (ctx.args.options.json) {
    ctx.stdout.write(`${JSON.stringify({ ok: true, count: servers.length, maxServers: max, servers }, null, 2)}\n`)
    return 0
  }
  ctx.stdout.write(`${t('clientList.header', { count: servers.length, max })}\n`)
  if (servers.length >= max) ctx.stdout.write(`  ${t('client.limitReached')}\n`)
  if (servers.length === 0) {
    ctx.stdout.write(`  ${t('clientList.empty')}\n`)
    return 0
  }
  for (const row of servers) {
    ctx.stdout.write(`  ${serverLineText(t, row)}\n`)
    const lastError = typeof row.lastError === 'string' ? row.lastError : ''
    if (lastError !== '') ctx.stdout.write(`      ${t('status.client.lastError', { error: lastError })}\n`)
  }
  return 0
}

// ===========================================================================
// client pair
// ===========================================================================

/** Local pre-validation of the address (SPEC: the claim route would refuse
 * it anyway — failing here saves the round-trip). Interactive runs re-ask;
 * a refused PROVIDED address ends the run with the reason on record. */
async function resolveHostUrl(ctx: CliExecutionContext): Promise<string | null> {
  const { t } = ctx
  let provided = ctx.args.target ?? ctx.args.options.hostUrl
  while (true) {
    const raw = provided ?? await askText(ctx, 'host-url', t('client.prompt.hostUrl'), (value) => {
      const normalized = normalizeServerUrl(value)
      if (normalized.ok) return undefined
      return t(normalized.reason === 'insecure-http' ? 'client.error.insecureHttp' : 'client.error.urlInvalid')
    })
    const normalized = normalizeServerUrl(raw)
    if (normalized.ok) return normalized.url
    ctx.stdout.write(`${t(normalized.reason === 'insecure-http' ? 'client.error.insecureHttp' : 'client.error.urlInvalid')}\n`)
    if (!ctx.interactive || provided !== undefined) return null
    provided = undefined // interactive: back to the address question
  }
}

/** The 8-character pairing code, same provided / prompt / refuse split.
 * `ignoreProvided` is the retry path's lever: a `--code` that already failed
 * one claim must never answer the re-ask — that would replay the same wrong
 * code forever (the CLI-3-fix loop). */
async function resolveCode(ctx: CliExecutionContext, ignoreProvided = false): Promise<string | null> {
  const { t } = ctx
  let provided = ignoreProvided ? undefined : ctx.args.options.code
  while (true) {
    const raw = provided ?? await askText(ctx, 'code', t('client.prompt.code'), (value) => (
      CODE_PATTERN.test(value) ? undefined : t('client.error.codeFormat')
    ))
    if (CODE_PATTERN.test(raw)) return raw
    ctx.stdout.write(`${t('client.error.codeFormat')}\n`)
    if (!ctx.interactive || provided !== undefined) return null
    provided = undefined
  }
}

/** The shared tail of a successful claim: wait (bounded) for the new entry
 * to reach `online`, then the three lights and the peer's name. */
async function finishPair(ctx: CliExecutionContext, serverUrl: string, claimBody: ServerRow): Promise<number> {
  const { t } = ctx
  const out = ctx.stdout
  out.write(`${t('client.claimOk')}\n`)

  const entryId = typeof claimBody.entryId === 'string' ? claimBody.entryId : ''
  let entry: ServerRow | null = null
  if (entryId !== '') {
    const interval = ctx.pollIntervalMs ?? POLL_INTERVAL_DEFAULT_MS
    const deadline = Date.now() + POLL_BUDGET_MS
    while (true) {
      const status = await fetchStatus(ctx)
      entry = serversOf(status).find((row) => row.entryId === entryId) ?? null
      if (entry?.state === 'online') break
      if (Date.now() >= deadline) break
      await sleep(interval)
    }
  }
  const online = entry?.state === 'online'
  const linkLabel = online ? t('status.online') : t('status.connecting')
  out.write(`${t('client.lightCredentials', { state: t('common.done') })}\n`)
  out.write(`${t('client.lightConnection', { state: linkLabel })}\n`)
  out.write(`${t('client.lightSync', { state: linkLabel })}\n`)
  const peerName = typeof entry?.serverName === 'string' && entry.serverName !== ''
    ? entry.serverName
    : typeof entry?.displayName === 'string' && entry.displayName !== '' ? entry.displayName : serverUrl
  out.write(`${t('client.pairedWith', { name: peerName })}\n`)
  if (ctx.args.options.json) {
    out.write(`${JSON.stringify({
      ok: true,
      entryId,
      serverUrl,
      serverName: peerName,
      state: online ? 'online' : typeof entry?.state === 'string' ? entry.state : 'connecting',
    }, null, 2)}\n`)
  }
  return 0
}

/**
 * `client pair [hostUrl] [--code <8位码>] [--name <本机名>] [--json]` — the
 * full pairing flow: local address validation, name sync through the
 * anti-shadowing config writer, the claim round-trip (with the SPEC's
 * code-only retry in interactive runs), and the bounded wait for `online`.
 */
export async function runClientPairCommand(ctx: CliExecutionContext): Promise<number> {
  if (!(await requireConnectsRole(ctx))) return 1
  const { t, ipc, args } = ctx
  const out = ctx.stdout
  try {
    const serverUrl = await resolveHostUrl(ctx)
    if (serverUrl === null) return 1
    let code = await resolveCode(ctx)
    if (code === null) return 1

    if (args.options.name !== undefined) {
      const written = await ipc.writeConfig({ set: { serverName: args.options.name } })
      const body = plainOf(written.body)
      if (written.status !== 200 || body?.ok !== true) {
        const error = plainOf(body?.error)
        if (error?.code === 'env-shadowed') {
          out.write(`${t('err.envShadowed', { field: String(error.field), envVar: String(error.envVar) })}\n`)
        } else {
          out.write(`${t('client.error.nameWriteFailed')}\n`)
        }
        return 1
      }
    }

    out.write(`${t('client.claiming')}\n`)
    while (true) {
      const result = await ipc.request('POST', CLIENT_CLAIM_ROUTE, { serverUrl, code })
      const body = plainOf(result.body) ?? {}
      if (result.status >= 200 && result.status < 300 && body.ok === true) {
        return await finishPair(ctx, serverUrl, body)
      }
      out.write(`${claimFailureText(t, result.status, body)}\n`)
      // SPEC: only a refused CODE retries, and only the code — the address
      // stays; everything else is a final verdict in any mode. role-mismatch
      // belongs here too: a web-role code is not consumed by the gateway, so
      // re-asking with the desktop code on the SAME address is the fix.
      const retryable = body.code === 'bad-code' || body.code === 'locked' || body.code === 'role-mismatch'
      if (!ctx.interactive || !retryable) return 1
      // The failed flag value may not answer again (CLI-3-fix: the infinite
      // loop) — the retry always asks the user.
      code = await resolveCode(ctx, true)
      if (code === null) return 1
    }
  } catch (error) {
    if (error instanceof MissingRequiredOptionError) {
      out.write(`${t('err.missingOption', { option: error.optionName })}\n`)
      return 1
    }
    throw error
  }
}

/** One classified claim refusal → the bilingual line. */
function claimFailureText(t: CliTranslator, status: number, body: ServerRow): string {
  switch (body.code) {
    case 'limit-reached': return t('client.limitReached')
    case 'role-mismatch': {
      const message = typeof body.message === 'string' && body.message !== '' ? body.message : undefined
      return message ?? t('client.error.roleMismatch')
    }
    case 'bad-code': return t('client.error.badCode')
    case 'locked': {
      const seconds = Math.ceil(typeof body.retryAfterMs === 'number' ? body.retryAfterMs / 1000 : 0)
      return t('client.error.locked', { seconds })
    }
    case 'unreachable': return t('client.error.unreachable')
    case 'invalid': return t('client.error.urlInvalid')
    case 'insecure-http': return t('client.error.insecureHttp')
    default: return status >= 200 && status < 300 ? t('client.error.unexpected') : t('client.error.unreachable')
  }
}

// ===========================================================================
// client unpair
// ===========================================================================

/** POST one removal and report it. `removed: 0` is the not-found verdict. */
async function unpairEntry(ctx: CliExecutionContext, entry: ServerRow): Promise<number> {
  const { t } = ctx
  const entryId = typeof entry.entryId === 'string' ? entry.entryId : ''
  const result = await ctx.ipc.request('POST', CLIENT_UNPAIR_ROUTE, { entryId })
  const body = plainOf(result.body)
  if (result.status !== 200 || body?.removed !== 1) {
    ctx.stdout.write(`${t('clientUnpair.notFound', { target: entryId })}\n`)
    return 1
  }
  if (ctx.args.options.json) {
    ctx.stdout.write(`${JSON.stringify({ ok: true, removed: 1, entryId }, null, 2)}\n`)
  } else {
    const name = typeof entry.displayName === 'string' && entry.displayName !== '' ? entry.displayName : entryId
    ctx.stdout.write(`${t('clientUnpair.removed', { name })}\n`)
  }
  return 0
}

/**
 * `client unpair [<hostUrl|entryId>|--all] [--yes] [--json]` — a target is
 * matched against the pool's own status rows (entry id first, then the
 * normalized address); `--all` needs `--yes` outside a TTY confirm; no
 * target at all in an interactive run picks from the current list.
 */
export async function runClientUnpairCommand(ctx: CliExecutionContext): Promise<number> {
  if (!(await requireConnectsRole(ctx))) return 1
  const { t, args } = ctx
  const out = ctx.stdout
  const status = await fetchStatus(ctx)
  const servers = serversOf(status)

  if (args.options.all) {
    if (!args.options.yes) {
      if (!ctx.interactive || ctx.prompter === undefined) {
        // Non-interactive without --yes must not destroy anything — the
        // missing confirmation IS the missing required option.
        out.write(`${t('err.missingOption', { option: 'yes' })}\n`)
        return 1
      }
      const sure = await ctx.prompter.confirm(t('clientUnpair.confirmAll', { count: servers.length }), false)
      if (!sure) {
        out.write(`${t('common.cancel')}\n`)
        return 0
      }
    }
    const result = await ctx.ipc.request('POST', CLIENT_UNPAIR_ROUTE, { all: true })
    const body = plainOf(result.body)
    if (result.status !== 200 || body?.ok !== true) {
      out.write(`${t('clientUnpair.failed')}\n`)
      return 1
    }
    const removed = typeof body.removed === 'number' ? body.removed : servers.length
    if (args.options.json) {
      out.write(`${JSON.stringify({ ok: true, removed }, null, 2)}\n`)
    } else {
      out.write(`${t('clientUnpair.removedAll', { count: removed })}\n`)
    }
    return 0
  }

  const target = args.target
  if (target === undefined) {
    if (!ctx.interactive || ctx.prompter === undefined) {
      out.write(`${t('clientUnpair.missingTarget')}\n`)
      return 1
    }
    if (servers.length === 0) {
      out.write(`  ${t('clientList.empty')}\n`)
      return 0
    }
    const picked = await ctx.prompter.selectOne(
      t('clientUnpair.selectQuestion'),
      servers.map((row) => serverLineText(t, row)),
      0,
    )
    const entry = servers[picked]
    return entry === undefined ? 1 : await unpairEntry(ctx, entry)
  }

  const normalizedTarget = normalizeServerUrl(target)
  const matched = servers.find((row) => row.entryId === target)
    ?? servers.find((row) => normalizedTarget.ok && row.serverUrl === normalizedTarget.url)
    ?? servers.find((row) => row.serverUrl === target)
  if (matched === undefined) {
    out.write(`${t('clientUnpair.notFound', { target })}\n`)
    return 1
  }
  return await unpairEntry(ctx, matched)
}
