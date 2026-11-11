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

import { promptOrFail, MissingRequiredOptionError } from './bootstrap.js'
import { parseInviteUri } from '../peer/crypto.js'
import {
  CLIENT_PEER_STATUS_ROUTE,
  CLIENT_PEER_JOIN_ROUTE,
  CLIENT_PEER_TRUST_ROUTE,
  CLIENT_PEER_LEAVE_ROUTE,
} from '../client-routes.js'
import type { CliExecutionContext } from './context.js'
import type { CliTranslator } from './i18n.js'
import { fetchBody, plainOf, gatewayStateLabel, peerPathLabelOf } from './commands-status.js'
import type { ServerRow } from './commands-status.js'

/** The join wait's poll cadence: frequent by default, tests shrink it. The
 * wait budget itself comes from `--wait` (the same seam the role switch and
 * `ensureDshRunning` use). */
const PEER_POLL_INTERVAL_DEFAULT_MS = 250

const ROLE_POLL_INTERVAL_DEFAULT_MS = 300

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function stringOf(row: ServerRow | null | undefined, field: string): string {
  const value = row?.[field]
  return typeof value === 'string' ? value : ''
}

function peersOf(body: ServerRow | null): ServerRow[] {
  const rows = body === null || !Array.isArray(body.peers) ? [] : body.peers
  return rows
    .map((row) => plainOf(row))
    .filter((row): row is ServerRow => row !== null)
}

async function fetchPeerStatus(ctx: CliExecutionContext): Promise<ServerRow | null> {
  return await fetchBody(() => ctx.ipc.request('GET', CLIENT_PEER_STATUS_ROUTE))
}

/** The peer-role gate every `peer *` command passes first: a fresh ping (the
 * role is a volatile row field), and anything else answers the bilingual
 * refusal naming the `setup --role peer` switch. */
async function requirePeerRole(ctx: CliExecutionContext): Promise<boolean> {
  let role: 'host' | 'client' | 'peer' = 'host'
  try {
    role = (await ctx.ipc.ping()).role
  } catch {
    // No live plugin is no peer role either — same refusal text.
  }
  if (role === 'peer') return true
  ctx.stdout.write(`${ctx.t('err.roleGate.peerCommands', { role })}\n`)
  return false
}

/**
 * The switch-to-peer procedure shared by `peer join --yes` and the setup
 * wizard: write `role: 'peer'` through the anti-shadowing writer and poll
 * until the row reloaded into the peer role AND the peer surface answers.
 * The managed Caddy / cloudflared children are NEVER touched —
 * `servesRole('peer')` is true, so the phone gateway channel survives.
 */
export async function switchToPeerRole(ctx: CliExecutionContext): Promise<boolean> {
  const { t, ipc } = ctx
  const result = await ipc.writeConfig({ set: { role: 'peer' } })
  const body = plainOf(result.body)
  if (result.status !== 200 || body?.ok !== true) {
    const error = plainOf(body?.error)
    if (error?.code === 'env-shadowed') {
      ctx.stdout.write(`${t('err.envShadowed', { field: String(error.field), envVar: String(error.envVar) })}\n`)
    } else {
      ctx.stdout.write(`${t('peer.error.configWriteFailed')}\n`)
    }
    return false
  }
  const waitSeconds = Math.max(1, ctx.args.options.wait)
  const interval = ctx.pollIntervalMs ?? ROLE_POLL_INTERVAL_DEFAULT_MS
  const deadline = Date.now() + waitSeconds * 1000
  while (true) {
    try {
      const ping = await ipc.ping()
      if (ping.role === 'peer' && (await fetchPeerStatus(ctx)) !== null) return true
    } catch {
      // A reload window can drop one ping — the deadline decides.
    }
    if (Date.now() >= deadline) return false
    await sleep(interval)
  }
}

/** The shared write of `--name` (the anti-shadowing writer, with the
 * `env-shadowed` handling `commands-client.ts` established). */
async function writeDisplayName(ctx: CliExecutionContext, name: string): Promise<boolean> {
  const { t, ipc } = ctx
  const written = await ipc.writeConfig({ set: { serverName: name } })
  const body = plainOf(written.body)
  if (written.status !== 200 || body?.ok !== true) {
    const error = plainOf(body?.error)
    if (error?.code === 'env-shadowed') {
      ctx.stdout.write(`${t('err.envShadowed', { field: String(error.field), envVar: String(error.envVar) })}\n`)
    } else {
      ctx.stdout.write(`${t('peer.error.nameWriteFailed')}\n`)
    }
    return false
  }
  return true
}

/** The invite link: the positional (`peer join <uri>`) or `--invite` wins;
 * missing values prompt in a TTY run (with a local `zr-net(s)://`
 * pre-validation) and raise MissingRequiredOptionError otherwise. A refused
 * PROVIDED link ends the run immediately — never a stdin wait. */
async function resolveInvite(ctx: CliExecutionContext): Promise<string | null> {
  const { t } = ctx
  let provided = ctx.args.target ?? ctx.args.options.invite
  while (true) {
    const raw = provided ?? await promptOrFail({
      optionName: 'invite',
      interactive: ctx.interactive,
      provided: undefined,
      ask: async () => {
        if (ctx.prompter === undefined) throw new MissingRequiredOptionError('invite')
        return await ctx.prompter.inputText(t('peer.prompt.invite'), undefined, (value) => (
          parseInviteUri(value) === null ? t('peer.error.inviteInvalid') : undefined
        ))
      },
    })
    if (parseInviteUri(raw) !== null) return raw
    ctx.stdout.write(`${t('peer.error.inviteInvalid')}\n`)
    if (!ctx.interactive || provided !== undefined) return null
    provided = undefined // interactive: back to the invite question
  }
}

/**
 * `peer join [inviteUri] [--invite <uri>] [--name <本机名>] [--yes]
 * [--no-wait] [--json]` — the full join flow: the role gate (with the
 * `--yes` / interactive switch that keeps the gateway channel alive), the
 * invite link, the optional display name, the join POST, and the bounded
 * wait for the gateway admission (pending-approval keeps waiting unless
 * `--no-wait`; revoked fails; timeout reports the still-pending state as
 * success with progress kept).
 */
export async function runPeerJoinCommand(ctx: CliExecutionContext): Promise<number> {
  const { t, ipc, args } = ctx
  const out = ctx.stdout
  try {
    // 1. The role gate: non-peer roles need a switch — silent under --yes,
    // confirmed interactively, refused otherwise.
    let role: 'host' | 'client' | 'peer' = 'host'
    try {
      role = (await ipc.ping()).role
    } catch { /* no live plugin — the switch attempt will fail below */ }
    if (role !== 'peer') {
      if (args.options.yes) {
        out.write(`${t('peer.join.switching')}\n`)
      } else if (ctx.interactive && ctx.prompter !== undefined) {
        const sure = await ctx.prompter.confirm(t('peer.join.confirmSwitch', { role }), false)
        if (!sure) {
          out.write(`${t('common.cancel')}\n`)
          return 0
        }
        out.write(`${t('peer.join.switching')}\n`)
      } else {
        out.write(`${t('peer.join.needPeerRole', { role })}\n`)
        return 1
      }
      if (!(await switchToPeerRole(ctx))) {
        out.write(`${t('setup.roleSwitchTimeout', { seconds: Math.max(1, args.options.wait) })}\n`)
        return 1
      }
    }

    // 2. The invite link (positional / --invite / prompted), 3. the name.
    const invite = await resolveInvite(ctx)
    if (invite === null) return 1
    if (args.options.name !== undefined && !(await writeDisplayName(ctx, args.options.name))) return 1

    // 4. The join POST — the engine's refusal codes render bilingually.
    out.write(`${t('peer.join.claiming')}\n`)
    const joined = await ipc.request('POST', CLIENT_PEER_JOIN_ROUTE, { inviteUri: invite })
    const joinedBody = plainOf(joined.body)
    if (joined.status < 200 || joined.status >= 300 || joinedBody?.ok !== true) {
      const error = plainOf(joinedBody?.error)
      const code = typeof error?.code === 'string' ? error.code : ''
      out.write(`${code === 'invalid-invite' ? t('peer.error.inviteInvalid') : t('peer.join.failed', { reason: code === '' ? String(joined.status) : code })}\n`)
      return 1
    }

    // 5. The bounded wait for the admission state — Ctrl-C (the entry
    // point's abort signal) leaves the wait immediately, keeping the
    // submitted request's progress, instead of blocking out --wait.
    const interval = ctx.pollIntervalMs ?? PEER_POLL_INTERVAL_DEFAULT_MS
    const deadline = Date.now() + Math.max(1, args.options.wait) * 1000
    let status = await fetchPeerStatus(ctx)
    if (status !== null && status.gatewayState === 'pending-approval') {
      out.write(`${t('peer.join.waitingApproval')}\n`)
      if (!args.options.noWait) {
        while (status !== null && status.gatewayState === 'pending-approval' && Date.now() < deadline) {
          if (ctx.abortSignal?.aborted) break
          await sleep(interval)
          status = await fetchPeerStatus(ctx)
          // The fetch raced the abort: a fresh pending answer must not
          // swallow the Ctrl-C either.
          if (ctx.abortSignal?.aborted) break
        }
        if (status !== null && status.gatewayState === 'pending-approval') {
          out.write(`${t('peer.join.stillPending')}\n`)
        }
      }
    }
    if (status === null) {
      out.write(`${t('peer.status.fetchFailed', { error: t('status.notRunning') })}\n`)
      return 1
    }
    const state = typeof status.gatewayState === 'string' ? status.gatewayState : 'offline'
    if (state === 'revoked') {
      out.write(`${t('peer.join.revoked')}\n`)
      return 1
    }
    if (state === 'authorized') {
      out.write(`${t('peer.join.lightIdentity', { state: t('common.done') })}\n`)
      out.write(`${t('peer.join.lightGateway', { state: t('common.done') })}\n`)
      out.write(`${t('peer.join.lightMembers', { state: t('common.done') })}\n`)
    }
    if (args.options.json) {
      out.write(`${JSON.stringify({
        ok: true,
        nodeId: stringOf(status, 'nodeId'),
        ...(stringOf(status, 'networkId') === '' ? {} : { networkId: stringOf(status, 'networkId') }),
        gatewayState: state,
        peers: Array.isArray(status.peers) ? status.peers : [],
      }, null, 2)}\n`)
    }
    return 0
  } catch (error) {
    if (error instanceof MissingRequiredOptionError) {
      out.write(`${t('err.missingOption', { option: error.optionName })}\n`)
      return 1
    }
    throw error
  }
}

/**
 * `peer status [--json]` — the peer engine's snapshot: this machine's node
 * id, the joined network (id + gateway origin), the admission state, and one
 * line per network device (path / rtt / mounted). `--json` echoes the
 * route's own body verbatim behind `ok: true`.
 */
export async function runPeerStatusCommand(ctx: CliExecutionContext): Promise<number> {
  if (!(await requirePeerRole(ctx))) return 1
  const { t } = ctx
  const status = await fetchPeerStatus(ctx)
  if (status === null) {
    ctx.stdout.write(`${t('peer.status.fetchFailed', { error: t('status.notRunning') })}\n`)
    return 1
  }
  if (ctx.args.options.json) {
    ctx.stdout.write(`${JSON.stringify({ ok: true, ...status }, null, 2)}\n`)
    return 0
  }
  const lines: string[] = [t('peer.status.title'), `  ${t('peer.status.nodeId', { nodeId: stringOf(status, 'nodeId') })}`]
  if (status.configured === true) {
    const origin = stringOf(status, 'gatewayOrigin') === '' ? '—' : stringOf(status, 'gatewayOrigin')
    lines.push(`  ${t('peer.status.joined', { networkId: stringOf(status, 'networkId'), origin })}`)
    lines.push(`  ${t('peer.status.gatewayState', { state: gatewayStateLabel(t, status.gatewayState) })}`)
    const peers = peersOf(status)
    lines.push(`  ${t('peer.status.deviceCount', { count: peers.length })}`)
    for (const row of peers) {
      const rttMs = row.rttMs
      const rtt = typeof rttMs === 'number' && Number.isFinite(rttMs) ? t('peer.status.rtt', { rttMs }) : '—'
      lines.push(t('peer.status.deviceLine', {
        name: stringOf(row, 'name'),
        nodeId: stringOf(row, 'nodeId'),
        path: peerPathLabelOf(t, row.path),
        rtt,
        mounted: row.mounted === true ? t('peer.mounted.yes') : t('peer.mounted.no'),
      }))
    }
  } else {
    lines.push(`  ${t('peer.status.notJoined')}`)
  }
  ctx.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

/** One device row of the trust menu: name, node id, and the path label. */
function trustRowText(t: CliTranslator, row: ServerRow): string {
  return t('peer.status.deviceLine', {
    name: stringOf(row, 'name'),
    nodeId: stringOf(row, 'nodeId'),
    path: peerPathLabelOf(t, row.path),
    rtt: '—',
    mounted: row.mounted === true ? t('peer.mounted.yes') : t('peer.mounted.no'),
  })
}

/**
 * `peer trust [nodeId] [--json]` — the explicit local confirmation after a
 * `mismatch` verdict. A missing node id picks from the mismatch devices in a
 * TTY run (none → a friendly nothing-to-do) and raises
 * MissingRequiredOptionError otherwise.
 */
export async function runPeerTrustCommand(ctx: CliExecutionContext): Promise<number> {
  const { t, ipc, args } = ctx
  const out = ctx.stdout
  try {
    if (!(await requirePeerRole(ctx))) return 1
    let nodeId = args.target
    if (nodeId === undefined) {
      if (!ctx.interactive || ctx.prompter === undefined) throw new MissingRequiredOptionError('node-id')
      const status = await fetchPeerStatus(ctx)
      const mismatches = peersOf(status).filter((row) => row.path === 'mismatch')
      if (mismatches.length === 0) {
        out.write(`${t('peer.trust.noMismatch')}\n`)
        return 0
      }
      const picked = await ctx.prompter.selectOne(
        t('peer.trust.selectQuestion'),
        mismatches.map((row) => trustRowText(t, row)),
        0,
      )
      const pickedRow = mismatches[picked]
      nodeId = pickedRow === undefined ? '' : stringOf(pickedRow, 'nodeId')
      if (nodeId === '') return 1
    }
    const result = await ipc.request('POST', CLIENT_PEER_TRUST_ROUTE, { nodeId })
    const body = plainOf(result.body)
    if (result.status === 404) {
      out.write(`${t('peer.trust.notFound', { nodeId })}\n`)
      return 1
    }
    if (result.status < 200 || result.status >= 300 || body?.ok !== true) {
      out.write(`${t('peer.trust.failed')}\n`)
      return 1
    }
    if (args.options.json) {
      out.write(`${JSON.stringify({ ok: true, nodeId }, null, 2)}\n`)
    } else {
      out.write(`${t('peer.trust.trusted', { nodeId })}\n`)
    }
    return 0
  } catch (error) {
    if (error instanceof MissingRequiredOptionError) {
      out.write(`${t('err.missingOption', { option: error.optionName })}\n`)
      return 1
    }
    throw error
  }
}

/**
 * `peer leave [--yes] [--json]` — leave the current network. The `client
 * unpair --all` discipline: no destruction without `--yes` outside a TTY
 * confirm; a cancelled confirm is not a failure.
 */
export async function runPeerLeaveCommand(ctx: CliExecutionContext): Promise<number> {
  const { t, ipc, args } = ctx
  const out = ctx.stdout
  try {
    if (!(await requirePeerRole(ctx))) return 1
    if (!args.options.yes) {
      if (!ctx.interactive || ctx.prompter === undefined) {
        out.write(`${t('err.missingOption', { option: 'yes' })}\n`)
        return 1
      }
      const sure = await ctx.prompter.confirm(t('peer.leave.confirm'), false)
      if (!sure) {
        out.write(`${t('common.cancel')}\n`)
        return 0
      }
    }
    const result = await ipc.request('POST', CLIENT_PEER_LEAVE_ROUTE, {})
    const body = plainOf(result.body)
    if (result.status < 200 || result.status >= 300 || body?.ok !== true) {
      out.write(`${t('peer.leave.failed')}\n`)
      return 1
    }
    if (args.options.json) {
      out.write(`${JSON.stringify({ ok: true }, null, 2)}\n`)
    } else {
      out.write(`${t('peer.leave.left')}\n`)
    }
    return 0
  } catch (error) {
    if (error instanceof MissingRequiredOptionError) {
      out.write(`${t('err.missingOption', { option: error.optionName })}\n`)
      return 1
    }
    throw error
  }
}
