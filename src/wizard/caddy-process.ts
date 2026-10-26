/**
 * Managed-Caddy process lifecycle (GW-3). The Caddyfile's content is
 * caddy.ts's job; this module owns everything with a heartbeat:
 *
 *   start: ensureBinary (GW-2, cached after the first download) →
 *          generateCaddyfile (typed refusals) → write the Caddyfile as a
 *          `.part` sibling → `caddy validate --config <part> --adapter
 *          caddyfile` → only on a clean validate rename it to the real
 *          path → `caddy run --config <Caddyfile>`. The ticket's "validate
 *          before write" is honored as validate-before-PUBLISH: the final
 *          Caddyfile on disk only ever holds bytes Caddy accepted, and a
 *          failed validate leaves neither a start nor a published file.
 *
 *   The Cloudflare API token travels in the child's ENVIRONMENT
 *   (`CF_API_TOKEN`, what the generated `{env.CF_API_TOKEN}` placeholder
 *   reads) — never in argv, which other processes on the machine can see.
 *
 *   Idempotency: start with a live process refuses (`already-running`) —
 *   switching configuration stops first (design: 切换路时先停旧进程再启新的).
 *   stop is idempotent; an exited child clears its own slot so a later
 *   start works. The host wiring hands stop to ctx.effect, so the row's
 *   disposal kills Caddy too.
 *
 * The subprocess service is structural (the tests feed a recorder), and
 * `fetch` is injectable for the ensureBinary step.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { ensureBinary, BinaryDownloadError, type DownloadProgress } from './binary-io.js'
import { caddyDataDir, caddyfilePath, ingressDir, type BinaryPlatform } from './binary.js'
import { generateCaddyfile, type CaddyfileInput } from './caddy.js'

/** The slice of DSH's subprocess service the manager drives (structural so
 * tests record instead of exec). */
export interface SubprocessHandleLike {
  terminate(): unknown
  done: Promise<{ exitCode?: number | null; signal?: string | null }>
}

export interface SubprocessServiceLike {
  spawn(options: {
    argv: string[]
    cwd?: string
    env?: NodeJS.ProcessEnv
    stdio?: unknown
    graceMs?: number
  }): SubprocessHandleLike
}

export interface CaddyManagerOptions {
  /** The host's subprocess service (ctx.subprocess). */
  subprocess: SubprocessServiceLike
  /** `<DSH_HOME>` — binaries, Caddyfile and caddy-data all live under it. */
  dshHome: string
  /** Injected transport for the one-time binary download (tests point it
   * at a mock server). */
  fetchImpl?: typeof fetch
  /** Forced platform mapping (tests). */
  platform?: BinaryPlatform
  /** Download progress relay (bytes, declared total or null). */
  onProgress?: DownloadProgress
  /** Stdio byte caps for the child, both streams. Default 64 KiB — enough
   * for the startup banner and an error or two. */
  maxLogBytes?: number
}

export type CaddyStartResult =
  | { ok: true; binaryPath: string; caddyfile: string; alreadyRunning: false }
  | {
    ok: false
    error: 'already-running' | 'missing-token' | 'bad-config' | 'download-failed' | 'validate-failed' | 'spawn-failed'
    /** The generateCaddyfile error code for `bad-config`, or a short
     * human-readable line for the transport/spawn failures. */
    detail?: string
    /** Official manual-install link, present for `download-failed`. */
    installUrl?: string
  }

export interface CaddyManager {
  /**
   * Idempotent front door: a live Caddy refuses a second start (stop
   * first to switch configuration). Throws nothing — every failure is a
   * value. The storage directory is this manager's own (under dshHome) —
   * callers supply only the user-facing fields.
   */
  start(input: Omit<CaddyfileInput, 'storageDir'> & { cfToken: unknown }): Promise<CaddyStartResult>
  /** Idempotent terminate; safe before any start. */
  stop(): void
  /** Whether a child is currently held (true between spawn and exit). */
  isRunning(): boolean
  /** The live child's Caddyfile path, or undefined. */
  runningCaddyfile(): string | undefined
  /** Whether any start has succeeded in this manager's lifetime. */
  hasStarted(): boolean
}

export function createCaddyManager(options: CaddyManagerOptions): CaddyManager {
  const { subprocess, dshHome } = options
  const maxLogBytes = options.maxLogBytes ?? 64 * 1024
  let handle: SubprocessHandleLike | null = null
  let caddyfileArg: string | undefined
  let startedOnce = false

  // GW-fix-2/L3: a WHITELIST, not the host's full environment — the host
  // process carries the relay secret and DSH's own credentials in env, and
  // a child that only needs to reach the internet and the local disk has
  // no business inheriting them. (If a Windows port ever needs SystemRoot
  // etc. to start, the names join this list deliberately, case by case.)
  const childEnv = (cfToken: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    // The one secret this child needs, by env only (the Caddyfile reads
    // {env.CF_API_TOKEN}) — never argv.
    env.CF_API_TOKEN = cfToken
    return env
  }

  const spawnChild = (argv: string[], env: NodeJS.ProcessEnv): SubprocessHandleLike =>
    subprocess.spawn({
      argv,
      cwd: dshHome,
      env,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: maxLogBytes },
        stderr: { maxBytes: maxLogBytes },
      },
      graceMs: 3000,
    })

  return {
    async start(input) {
      if (handle !== null) return { ok: false, error: 'already-running' }
      const cfToken = typeof input.cfToken === 'string' && input.cfToken.trim() !== '' ? input.cfToken : undefined
      if (cfToken === undefined) return { ok: false, error: 'missing-token' }
      const generated = generateCaddyfile({ ...input, storageDir: caddyDataDir(dshHome) })
      if (!generated.ok) return { ok: false, error: 'bad-config', detail: generated.error }

      let binaryPath: string
      try {
        binaryPath = (await ensureBinary(dshHome, 'caddy', {
          fetchImpl: options.fetchImpl,
          platform: options.platform,
          onProgress: options.onProgress,
        })).path
      } catch (error) {
        if (error instanceof BinaryDownloadError) {
          return { ok: false, error: 'download-failed', detail: error.message, installUrl: error.installUrl }
        }
        return { ok: false, error: 'download-failed', detail: String((error as Error)?.message ?? error) }
      }

      // Write → validate → publish: the `.part` file carries the exact
      // bytes under validation, so what lands at the real path is exactly
      // what Caddy accepted.
      const finalPath = caddyfilePath(dshHome)
      const partPath = `${finalPath}.part`
      try {
        mkdirSync(ingressDir(dshHome), { recursive: true })
        writeFileSync(partPath, generated.caddyfile, { mode: 0o600 })
        const validate = spawnChild([binaryPath, 'validate', '--config', partPath, '--adapter', 'caddyfile'], childEnv(cfToken))
        const outcome = await validate.done
        if ((outcome.exitCode ?? 1) !== 0) {
          rmSync(partPath, { force: true })
          return { ok: false, error: 'validate-failed' }
        }
        renameSync(partPath, finalPath)
      } catch (error) {
        rmSync(partPath, { force: true })
        return { ok: false, error: 'spawn-failed', detail: String((error as Error)?.message ?? error) }
      }

      const env = childEnv(cfToken)
      try {
        const child = spawnChild([binaryPath, 'run', '--config', finalPath], env)
        handle = child
        caddyfileArg = finalPath
        startedOnce = true
        // An exited child clears its own slot: isRunning() goes honest and
        // a later start() works without a manual stop.
        void child.done.then(() => {
          if (handle === child) {
            handle = null
            caddyfileArg = undefined
          }
        }).catch(() => {
          if (handle === child) {
            handle = null
            caddyfileArg = undefined
          }
        })
        return { ok: true, binaryPath, caddyfile: finalPath, alreadyRunning: false }
      } catch (error) {
        handle = null
        caddyfileArg = undefined
        return { ok: false, error: 'spawn-failed', detail: String((error as Error)?.message ?? error) }
      }
    },

    stop() {
      if (handle === null) return
      const child = handle
      handle = null
      caddyfileArg = undefined
      try {
        void child.terminate()
      } catch {
        // A dead child's terminate is a no-op or a throw — either way done.
      }
    },

    isRunning: () => handle !== null,
    runningCaddyfile: () => caddyfileArg,
    /** Whether a start has EVER succeeded in this row's lifetime — the
     * three-state status needs it to tell 已退出 (degraded) from 未启动. */
    hasStarted: () => startedOnce,
  }
}

/** Re-exported so the wiring (and later the routes) need one import for
 * the whole ingress-directory layout. */
export { caddyDataDir, caddyfilePath, ingressDir }
