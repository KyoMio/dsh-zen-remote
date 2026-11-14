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
import { parseGatewayJoinInput } from '../peer/crypto.js'
import type { ParsedGatewayJoinInput } from '../peer/crypto.js'
import {
  CLIENT_PEER_STATUS_ROUTE,
  CLIENT_PEER_JOIN_ROUTE,
  CLIENT_PEER_TRUST_ROUTE,
  CLIENT_PEER_LEAVE_ROUTE,
} from '../client-routes.js'
import type { CliExecutionContext } from './context.js'
import type { CliTranslator } from './i18n.js'
import { fetchBody, plainOf, gatewayStateLabel, peerPathLabelOf, renderPeerSection } from './commands-status.js'
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

async function fetchPeerStatus(ctx: CliExecutionContext, timeoutMs?: number, signal?: AbortSignal): Promise<ServerRow | null> {
  return await fetchBody(() => ctx.ipc.request('GET', CLIENT_PEER_STATUS_ROUTE, undefined, timeoutMs, signal))
}

/** A sleep the cutter can interrupt (PC-14b-fix1): Ctrl-C and the hard
 * deadline wake the poll loop immediately instead of after the interval,
 * and the timer plus the listener are cleaned on every path. */
function sleepBounded(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => finish()
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// --- PC-14b: the real-readiness verdict ------------------------------------------
//
// The join wait's one contract: only `gateway authorized` + `sync ready`
// (PC-14a's body facts) may claim the member-sync light and exit 0 — never a
// non-empty peers list. Explicit admission/identity terminations fail
// immediately instead of burning the budget; the budget ends non-zero with
// the last observed state; `--no-wait` claims `submitted` only, with `ready`
// riding the observed snapshot alone; Ctrl-C ends bounded with the 130
// convention and never sends a leave.

/** Why the wait stopped on an explicit termination: the gateway admission
 * verdicts (`revoked` / `paused` / `mismatch`) and the identity block (a
 * TOFU mismatch — locally visible even on an old body without sync). */
type PeerJoinBlockReason = 'revoked' | 'paused' | 'mismatch' | 'identity-mismatch'

/** One poll's verdict: achieved readiness, an explicit termination, or
 * keep-waiting (connecting / pending-approval / offline / partial /
 * waiting-peers / ignored / an old body without sync — all honestly
 * unresolved, never guessed into success). */
type PeerJoinProgress =
  | { kind: 'ready' }
  | { kind: 'blocked'; reason: PeerJoinBlockReason }
  | { kind: 'wait' }

const PEER_JOIN_BLOCK_COPY: Readonly<Record<PeerJoinBlockReason, string>> = {
  revoked: 'peer.join.revoked',
  paused: 'peer.join.paused',
  mismatch: 'peer.join.mismatch',
  'identity-mismatch': 'peer.join.syncBlocked',
}

/** The PC-14b verdict for one status snapshot: authorized + `sync.ready` is
 * the ONLY ready; the gateway terminations fail immediately; everything else
 * — including an old body whose sync block is absent — keeps waiting. The
 * gate order mirrors the route's own verdict (`peerSyncBodyOf`): before
 * admission the gateway state governs; only under an authorized gateway does
 * the identity block stop the wait — a mismatch row is a LOCAL fact (the
 * `peer trust` scan rule, `path === 'mismatch'`) that survives old bodies
 * without sync. */
function classifyPeerJoinProgress(status: ServerRow | null): PeerJoinProgress {
  if (status === null) return { kind: 'wait' }
  const state = typeof status.gatewayState === 'string' ? status.gatewayState : 'offline'
  if (state === 'revoked') return { kind: 'blocked', reason: 'revoked' }
  if (state === 'paused') return { kind: 'blocked', reason: 'paused' }
  if (state === 'mismatch') return { kind: 'blocked', reason: 'mismatch' }
  if (state !== 'authorized') return { kind: 'wait' }
  if (peersOf(status).some((row) => row.path === 'mismatch')) return { kind: 'blocked', reason: 'identity-mismatch' }
  const sync = plainOf(status.sync)
  const syncState = typeof sync?.state === 'string' ? sync.state : ''
  if (syncState === 'ready') return { kind: 'ready' }
  if (syncState === 'blocked') return { kind: 'blocked', reason: 'identity-mismatch' }
  return { kind: 'wait' }
}

/** The sync block's counts parse with the SAME rule as the PC-14a backend
 * derivation (fix1): non-negative safe integers — a negative, fractional or
 * otherwise junk count reads as unknown, never as “-1/2.5 台”. */
function isPeerSyncCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** The members line's honest wording: the sync block's own words; a junk or
 * absent block reads as unknown, never guessed. The mark does NOT come from
 * here — the exit verdict owns it ({@link printPeerJoinStateLines}). */
function peerSyncWording(t: CliTranslator, status: ServerRow): string {
  const sync = plainOf(status.sync)
  const state = typeof sync?.state === 'string' ? sync.state : ''
  const reason = typeof sync?.reason === 'string' ? sync.reason : ''
  switch (state) {
    case 'ready': return t('peer.sync.ready')
    case 'partial': {
      const readyCount = sync !== null && isPeerSyncCount(sync.readyCount) ? sync.readyCount : null
      const candidateCount = sync !== null && isPeerSyncCount(sync.candidateCount) ? sync.candidateCount : null
      return readyCount !== null && candidateCount !== null
        ? t('peer.sync.partial', { ready: readyCount, total: candidateCount })
        : t('peer.sync.unknown')
    }
    case 'not-ready':
      if (reason === 'peers-not-mounted') return t('peer.sync.notMounted')
      if (reason === 'peers-not-online') return t('peer.sync.notOnline')
      if (reason.startsWith('gateway-')) return t('peer.sync.gatewayHold')
      return t('peer.sync.unknown')
    case 'waiting-peers': return t('peer.sync.waitingPeers')
    case 'ignored': return t('peer.sync.ignored')
    default: return t('peer.sync.unknown')
  }
}

/** The three observed state lines (identity / gateway admission / member
 * sync), each with a green mark ONLY on its own real pass. Fix1: the third
 * line obeys the SAME verdict the exit code will — a stale historical
 * sync.ready under a dead/paused gateway reads as the gateway hold, an
 * identity block names the block, and only a verdict-ready snapshot shows
 * the member ✓. “文字已经就绪、退出却失败”的矛盾从这里不可能出现。 */
function printPeerJoinStateLines(t: CliTranslator, out: { write(text: string): void }, status: ServerRow | null): void {
  if (status === null) return
  if (stringOf(status, 'nodeId') !== '') out.write(`${t('peer.join.lightIdentity')}\n`)
  else out.write(`${t('peer.join.lightIdentityPending')}\n`)
  const authorized = status.gatewayState === 'authorized'
  out.write(`${t('peer.join.lightGateway', { state: gatewayStateLabel(t, status.gatewayState), mark: authorized ? ' ✓' : '' })}\n`)
  const verdict = classifyPeerJoinProgress(status)
  const syncWording = verdict.kind === 'ready'
    ? t('peer.sync.ready')
    : verdict.kind === 'blocked' && verdict.reason === 'identity-mismatch'
      ? t('peer.sync.blocked')
      : !authorized
        ? t('peer.sync.gatewayHold')
        : peerSyncWording(t, status)
  out.write(`${t('peer.join.lightMembers', { sync: syncWording, mark: verdict.kind === 'ready' ? ' ✓' : '' })}\n`)
}

/** The join command's JSON body: `submitted` speaks of the accepted join
 * POST alone; `ready` is true only when the observed snapshot said so —
 * never inferred from the exit code. The backend's sync block echoes
 * verbatim (absent stays absent, old bodies don't grow one). */
function peerJoinResultBody(status: ServerRow, ready: boolean): Record<string, unknown> {
  const sync = plainOf(status.sync)
  return {
    ok: true,
    submitted: true,
    ready,
    nodeId: stringOf(status, 'nodeId'),
    ...(stringOf(status, 'networkId') === '' ? {} : { networkId: stringOf(status, 'networkId') }),
    gatewayState: typeof status.gatewayState === 'string' ? status.gatewayState : 'offline',
    ...(sync === null ? {} : { sync }),
    peers: Array.isArray(status.peers) ? status.peers : [],
  }
}

/** Why a join run failed after an accepted POST: the block reasons share the
 * classifier's words; the wait outcomes name themselves. */
type PeerJoinFailureReason = PeerJoinBlockReason | 'timeout' | 'aborted' | 'status-unavailable'

/** The failure body (fix1): `--json` runs get a structured answer for the
 * wait outcomes too — `submitted` keeps the accepted POST's fact, `ready`
 * stays false without an observed ready, `reason` names the outcome, and
 * the LAST OBSERVED state rides along verbatim (no snapshot → no invented
 * state). */
function peerJoinFailureBody(status: ServerRow | null, reason: PeerJoinFailureReason): Record<string, unknown> {
  const sync = status === null ? null : plainOf(status.sync)
  return {
    ok: false,
    submitted: true,
    ready: false,
    reason,
    ...(status === null ? {} : {
      ...(stringOf(status, 'nodeId') === '' ? {} : { nodeId: stringOf(status, 'nodeId') }),
      ...(stringOf(status, 'networkId') === '' ? {} : { networkId: stringOf(status, 'networkId') }),
      gatewayState: typeof status.gatewayState === 'string' ? status.gatewayState : 'offline',
      ...(sync === null ? {} : { sync }),
      peers: Array.isArray(status.peers) ? status.peers : [],
    }),
  }
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

/** The invite link or gateway address: the positional (`peer join <uri>`) or
 * `--invite` wins; missing values prompt in a TTY run (with local
 * `parseGatewayJoinInput` pre-validation) and raise MissingRequiredOptionError
 * otherwise. A refused PROVIDED input ends the run immediately — never a
 * stdin wait. */
async function resolveInvite(ctx: CliExecutionContext): Promise<{ raw: string; parsed: ParsedGatewayJoinInput } | null> {
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
          parseGatewayJoinInput(value) === null ? t('peer.error.inviteInvalid') : undefined
        ))
      },
    })
    const parsed = parseGatewayJoinInput(raw)
    if (parsed !== null) return { raw: raw.trim(), parsed }
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
 * wait for REAL readiness (PC-14b): only authorized + sync.ready exits 0
 * with the three lights green; revoked / paused / mismatch / an identity
 * block fail immediately; the budget ends non-zero with the last actual
 * state; `--no-wait` claims `submitted` only (JSON names `submitted` and
 * `ready` apart); Ctrl-C ends bounded with the 130 convention, keeping the
 * submitted request's progress — never a leave.
 *
 * Fix1 hardening: the cancel signal and the hard wall-clock deadline cut the
 * IN-FLIGHT status request itself (the socket idle timeout is not a wall
 * clock — a slow drip of legal bytes keeps resetting it), a ready answer
 * that lands past the deadline counts for nothing, the third light obeys
 * the same verdict the exit code will, and `--json` runs print exactly one
 * JSON document on stdout with every human line on stderr — failures
 * included (`ok:false` / `submitted` / `ready:false` / `reason`).
 */
export async function runPeerJoinCommand(ctx: CliExecutionContext): Promise<number> {
  const { t, ipc, args } = ctx
  const out = ctx.stdout
  // PC-14b-fix1: a --json run keeps stdout to the single JSON document —
  // every human line (progress, lights, failures) rides stderr instead.
  const human = args.options.json ? ctx.stderr ?? process.stderr : out
  const emitJson = (body: Record<string, unknown>): void => {
    if (args.options.json) out.write(`${JSON.stringify(body, null, 2)}\n`)
  }
  try {
    // 1. The role gate: non-peer roles need a switch — silent under --yes,
    // confirmed interactively, refused otherwise.
    let role: 'host' | 'client' | 'peer' = 'host'
    try {
      role = (await ipc.ping()).role
    } catch { /* no live plugin — the switch attempt will fail below */ }
    if (role !== 'peer') {
      if (args.options.yes) {
        human.write(`${t('peer.join.switching')}\n`)
      } else if (ctx.interactive && ctx.prompter !== undefined) {
        const sure = await ctx.prompter.confirm(t('peer.join.confirmSwitch', { role }), false)
        if (!sure) {
          human.write(`${t('common.cancel')}\n`)
          return 0
        }
        human.write(`${t('peer.join.switching')}\n`)
      } else {
        human.write(`${t('peer.join.needPeerRole', { role })}\n`)
        return 1
      }
      if (!(await switchToPeerRole(ctx))) {
        human.write(`${t('setup.roleSwitchTimeout', { seconds: Math.max(1, args.options.wait) })}\n`)
        return 1
      }
    }

    // 2. The invite link or gateway address (positional / --invite / prompted), 3. the name.
    const resolvedJoin = await resolveInvite(ctx)
    if (resolvedJoin === null) return 1
    const { raw: gatewayAddress, parsed: parsedJoin } = resolvedJoin
    if (args.options.name !== undefined && !(await writeDisplayName(ctx, args.options.name))) return 1

    // 4. The join POST — invite links send `{ inviteUri }`; gateway addresses
    // send `{ gatewayUrl }` and handle multi-network selection (`409 select-network`).
    human.write(`${t('peer.join.claiming')}\n`)
    let joined = await ipc.request(
      'POST',
      CLIENT_PEER_JOIN_ROUTE,
      parsedJoin.kind === 'invite'
        ? { inviteUri: parsedJoin.inviteUri }
        : { gatewayUrl: gatewayAddress },
    )
    let joinedBody = plainOf(joined.body)
    if (
      parsedJoin.kind === 'gateway'
      && joined.status === 409
      && plainOf(joinedBody?.error)?.code === 'select-network'
      && Array.isArray(joinedBody?.networks)
      && joinedBody.networks.length > 0
    ) {
      const candidates = joinedBody.networks
        .map((n) => plainOf(n))
        .filter((n): n is ServerRow => n !== null && typeof n.id === 'string' && typeof n.name === 'string')
      if (candidates.length > 0 && ctx.interactive && ctx.prompter !== undefined) {
        const pickedIndex = await ctx.prompter.selectOne(
          t('peer.join.selectNetwork'),
          candidates.map((c) => `${String(c.name)} (${String(c.id)})`),
          0,
        )
        const chosen = candidates[pickedIndex]
        if (chosen === undefined) return 1
        joined = await ipc.request('POST', CLIENT_PEER_JOIN_ROUTE, {
          gatewayUrl: gatewayAddress,
          networkId: String(chosen.id),
        })
        joinedBody = plainOf(joined.body)
      } else {
        const summary = candidates.map((c) => `${String(c.name)} (${String(c.id)})`).join(', ')
        human.write(`${t('peer.join.selectNetworkRequired', { networks: summary })}\n`)
        return 1
      }
    }
    if (joined.status < 200 || joined.status >= 300 || joinedBody?.ok !== true) {
      const error = plainOf(joinedBody?.error)
      const code = typeof error?.code === 'string' ? error.code : ''
      human.write(`${code === 'invalid-invite' ? t('peer.error.inviteInvalid') : t('peer.join.failed', { reason: code === '' ? String(joined.status) : code })}\n`)
      return 1
    }

    // 5. The bounded wait for REAL readiness (PC-14b + fix1): one cutter
    // drives both the outer abort (Ctrl-C) and the hard wall-clock deadline;
    // the in-flight request and the poll sleep listen on its signal, so a
    // hung or trickling answer cannot outlive the budget and a late ready
    // cannot slip past a fired deadline (the deadline check precedes the
    // verdict at every loop top). Transport failures are "no new
    // information" — the last OBSERVED snapshot stays the report.
    const interval = ctx.pollIntervalMs ?? PEER_POLL_INTERVAL_DEFAULT_MS
    const waitSeconds = Math.max(1, args.options.wait)
    const deadline = Date.now() + waitSeconds * 1000
    const remainingMs = (): number => Math.max(1, deadline - Date.now())
    const cutter = new AbortController()
    const deadlineTimer = setTimeout(() => cutter.abort(), remainingMs())
    const onOuterAbort = (): void => cutter.abort()
    ctx.abortSignal?.addEventListener('abort', onOuterAbort, { once: true })
    let status: ServerRow | null = null
    const statusUnavailable = (): number => {
      human.write(`${t('peer.status.fetchFailed', { error: t('status.notRunning') })}\n`)
      emitJson(peerJoinFailureBody(null, 'status-unavailable'))
      return 1
    }
    const reportBlocked = (reason: PeerJoinBlockReason): number => {
      human.write(`${t(PEER_JOIN_BLOCK_COPY[reason])}\n`)
      emitJson(peerJoinFailureBody(status, reason))
      return 1
    }
    const reportAborted = (): number => {
      human.write(`${t('peer.join.aborted')}\n`)
      emitJson(peerJoinFailureBody(status, 'aborted'))
      return 130
    }
    const reportTimeout = (): number => {
      if (status === null) return statusUnavailable()
      printPeerJoinStateLines(t, human, status)
      human.write(`${status.gatewayState === 'pending-approval' ? t('peer.join.stillPending') : t('peer.join.waitTimeout', { seconds: waitSeconds })}\n`)
      emitJson(peerJoinFailureBody(status, 'timeout'))
      return 1
    }
    try {
      if (ctx.abortSignal?.aborted) return reportAborted()
      status = await fetchPeerStatus(ctx, remainingMs(), cutter.signal)
      if (ctx.abortSignal?.aborted) return reportAborted()
      if (Date.now() >= deadline) return reportTimeout()
      if (!args.options.noWait) {
        let approvalAnnounced = false
        while (true) {
          // Cancel and the hard deadline outrank whatever the fetch just
          // brought back — a ready body past the deadline is not success.
          if (ctx.abortSignal?.aborted) return reportAborted()
          if (Date.now() >= deadline) return reportTimeout()
          const progress = classifyPeerJoinProgress(status)
          if (progress.kind === 'ready' && status !== null) {
            printPeerJoinStateLines(t, human, status)
            emitJson(peerJoinResultBody(status, true))
            return 0
          }
          if (progress.kind === 'blocked') return reportBlocked(progress.reason)
          if (!approvalAnnounced && status !== null && status.gatewayState === 'pending-approval') {
            approvalAnnounced = true
            human.write(`${t('peer.join.waitingApproval')}\n`)
          }
          await sleepBounded(Math.min(interval, remainingMs()), cutter.signal)
          status = await fetchPeerStatus(ctx, remainingMs(), cutter.signal) ?? status
        }
      }
      // --no-wait (PC-14b): `submitted` is the only claim — readiness rides
      // the one observed snapshot and never the exit code.
      if (status === null) return statusUnavailable()
      const snapshot = classifyPeerJoinProgress(status)
      if (snapshot.kind === 'blocked') return reportBlocked(snapshot.reason)
      printPeerJoinStateLines(t, human, status)
      if (snapshot.kind !== 'ready') {
        human.write(`${status.gatewayState === 'pending-approval' ? t('peer.join.waitingApproval') : t('peer.join.submitted')}\n`)
      }
      emitJson(peerJoinResultBody(status, snapshot.kind === 'ready'))
      return 0
    } finally {
      // The cutter's timer and the outer listener never outlive the wait.
      clearTimeout(deadlineTimer)
      ctx.abortSignal?.removeEventListener('abort', onOuterAbort)
    }
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
 * id, the joined network (id + gateway origin), the admission state, the
 * mount-capacity lines (PC-11c: the local mounts N/M against the effective
 * cap, the full note when reached, the network-total cap separately), and
 * one line per network device (path / rtt / mounted). `--json` echoes the
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
  const lines = renderPeerSection(t, status)
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
