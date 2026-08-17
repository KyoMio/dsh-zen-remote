// dsh-zen-remote-gateway — Cordis plugin entry
// Spawns the enhanced LAN/remote PWA gateway (lib/lan-gate-server.cjs) as an
// isolated child process, reverse-proxying the local DSH Web UI with:
//   - secure remote access (first-visit approval, one-token-per-browser, rate limit)
//   - PWA serving (/pwa/*) + mobile layout + touch gesture + offline + notifications
//
// Mount via cordis.patch.yml (see cordis.patch.yml.example) or `dsh plugin add`.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'dsh-zen-remote-gateway'
export const inject = ['subprocess']

const here = dirname(fileURLToPath(import.meta.url))
const serverFile = join(here, 'lib', 'lan-gate-server.cjs')

// Optional cordis config (set on the insert row in your profile patch):
//   { port, host, targetPort, rateLimit, trustedProxies, vapidSubject }
// Values are translated to LAN_GATE_* env vars; explicit env vars win.
const CONFIG_ENV = {
  port: 'LAN_GATE_PORT',
  host: 'LAN_GATE_HOST',
  targetPort: 'LAN_GATE_TARGET_PORT',
  rateLimit: 'LAN_GATE_RATE_LIMIT',
  trustedProxies: 'LAN_GATE_TRUSTED_PROXIES',
  vapidSubject: 'LAN_GATE_VAPID_SUBJECT',
}

export function apply(ctx, config) {
  if (config && typeof config === 'object') {
    for (const [key, envName] of Object.entries(CONFIG_ENV)) {
      if (config[key] !== undefined && config[key] !== null && process.env[envName] === undefined) {
        process.env[envName] = String(config[key])
      }
    }
  }
  const timer = ctx.get('timer')
  let handle = null

  const start = async () => {
    try {
      const nodePath = await ctx.subprocess.resolveExecutable('node')
      handle = ctx.subprocess.spawn({
        argv: [nodePath, serverFile],
        cwd: here,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 131072 },
          stderr: { maxBytes: 131072 }
        },
        graceMs: 3000
      })
      handle.done.then((outcome) => {
        console.log(`[dsh-zen-remote-gateway] gateway exited code=${outcome.exitCode} signal=${outcome.signal}`)
      }).catch((err) => {
        console.error(`[dsh-zen-remote-gateway] spawn failed: ${String(err && err.message || err)}`)
      })
      if (timer) {
        timer.timeout(() => {
          const r = handle && handle.collected && handle.collected.stdout
          if (r) { const read = r.readFrom(0); if (read && read.text) console.log(`[dsh-zen-remote-gateway] ${read.text.trim()}`) }
          const e = handle && handle.collected && handle.collected.stderr
          if (e) { const eread = e.readFrom(0); if (eread && eread.text) console.error(`[dsh-zen-remote-gateway] stderr: ${eread.text.trim()}`) }
        }, 1500)
      }
    } catch (err) {
      console.error(`[dsh-zen-remote-gateway] ${String(err && err.message || err)}`)
    }
  }

  start()

  ctx.effect(() => {
    return () => {
      if (handle) { try { handle.terminate() } catch (e) { /* ignore */ } }
    }
  })
}
