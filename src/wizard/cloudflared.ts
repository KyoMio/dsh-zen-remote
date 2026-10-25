/**
 * cloudflared process lifecycle (GW-7, 路 C's last mile). The tunnel's
 * connector runs in the foreground (`tunnel run`) as a child of the DSH
 * host, managed through the same subprocess service as the gateway child
 * and the managed Caddy.
 *
 * The connector secret NEVER touches argv (visible to every process on
 * the machine via ps) and is never an environment variable either — it is
 * written to `<DSH_HOME>/zen-remote-ingress/tunnel-token`, mode 0600,
 * through a temp-file-then-rename so a crash mid-write can never leave a
 * half token at the real path, and handed to cloudflared with
 * `--token-file`.
 *
 * Idempotency and cleanup mirror caddy-process.ts: a live child refuses a
 * second start (stop first to switch tunnels), stop is idempotent, and an
 * exited child clears its own slot. The host wiring hands stop to
 * ctx.effect so the row's disposal kills cloudflared too.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureBinary, BinaryDownloadError, type DownloadProgress } from './binary-io.js'
import { ingressDir, type BinaryPlatform } from './binary.js'
import type { SubprocessServiceLike, SubprocessHandleLike } from './caddy-process.js'

/** Where the connector secret lives (design.md: 不进 Config 的字段). */
export function tunnelTokenPath(dshHome: string): string {
  return join(ingressDir(dshHome), 'tunnel-token')
}

/**
 * Persist the tunnel connector secret: 0600, atomic (write the `.part`
 * sibling, then rename over the real path).
 */
export function writeTunnelTokenFile(dshHome: string, token: string): string {
  const finalPath = tunnelTokenPath(dshHome)
  const partPath = `${finalPath}.part`
  try {
    mkdirSync(ingressDir(dshHome), { recursive: true })
    writeFileSync(partPath, token, { mode: 0o600 })
    renameSync(partPath, finalPath)
  } catch (error) {
    rmSync(partPath, { force: true })
    throw error
  }
  return finalPath
}

export interface CloudflaredManagerOptions {
  /** The host's subprocess service (ctx.subprocess). */
  subprocess: SubprocessServiceLike
  /** `<DSH_HOME>` — the binary and the token file live under it. */
  dshHome: string
  /** Injected transport for the one-time binary download (tests). */
  fetchImpl?: typeof fetch
  /** Forced platform mapping (tests). */
  platform?: BinaryPlatform
  /** Download progress relay (bytes, declared total or null). */
  onProgress?: DownloadProgress
  /** Stdio byte caps for the child, both streams. Default 64 KiB. */
  maxLogBytes?: number
}

export type CloudflaredStartResult =
  | { ok: true; binaryPath: string; tokenFile: string; alreadyRunning: false }
  | {
    ok: false
    error: 'already-running' | 'missing-token' | 'download-failed' | 'spawn-failed'
    detail?: string
    installUrl?: string
  }

export interface CloudflaredManager {
  /** Idempotent front door: a live cloudflared refuses a second start. */
  start(input: { tunnelToken: unknown }): Promise<CloudflaredStartResult>
  /** Idempotent terminate; safe before any start. */
  stop(): void
  /** Whether a child is currently held. */
  isRunning(): boolean
}

export function createCloudflaredManager(options: CloudflaredManagerOptions): CloudflaredManager {
  const { subprocess, dshHome } = options
  const maxLogBytes = options.maxLogBytes ?? 64 * 1024
  let handle: SubprocessHandleLike | null = null

  // GW-fix-2/L3: whitelist env — the host process carries the relay secret
  // and DSH's own credentials, and cloudflared needs none of them (its
  // connector secret comes through the 0600 token file).
  const childEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    return env
  }

  const spawnChild = (argv: string[]): SubprocessHandleLike =>
    subprocess.spawn({
      argv,
      cwd: dshHome,
      // GW-fix-2/L3: whitelist env — the token rides the 0600 file, so the
      // child needs nothing from the host's environment beyond the basics.
      env: childEnv(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: maxLogBytes },
        stderr: { maxBytes: maxLogBytes },
      },
      graceMs: 3000,
    })

  const clearSlot = (child: SubprocessHandleLike): void => {
    if (handle === child) handle = null
  }

  return {
    async start(input) {
      if (handle !== null) return { ok: false, error: 'already-running' }
      const tunnelToken = typeof input.tunnelToken === 'string' && input.tunnelToken.trim() !== '' ? input.tunnelToken : undefined
      if (tunnelToken === undefined) return { ok: false, error: 'missing-token' }

      let binaryPath: string
      try {
        binaryPath = (await ensureBinary(dshHome, 'cloudflared', {
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

      let tokenFile: string
      try {
        tokenFile = writeTunnelTokenFile(dshHome, tunnelToken)
      } catch (error) {
        return { ok: false, error: 'spawn-failed', detail: String((error as Error)?.message ?? error) }
      }

      try {
        const child = spawnChild([binaryPath, 'tunnel', 'run', '--token-file', tokenFile])
        handle = child
        void child.done.then(() => clearSlot(child)).catch(() => clearSlot(child))
        return { ok: true, binaryPath, tokenFile, alreadyRunning: false }
      } catch (error) {
        handle = null
        return { ok: false, error: 'spawn-failed', detail: String((error as Error)?.message ?? error) }
      }
    },

    stop() {
      if (handle === null) return
      const child = handle
      handle = null
      try {
        void child.terminate()
      } catch {
        // A dead child's terminate is a no-op or a throw — either way done.
      }
    },

    isRunning: () => handle !== null,
  }
}
