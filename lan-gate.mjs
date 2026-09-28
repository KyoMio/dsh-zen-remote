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
// `connection` (both DSH versions provide it — unlike 0.1.2-only services such
// as uiWorkspace) lets the host side read the browser-auth token URL, so
// adding it here does not stop the plugin activating on 0.1.1.
// `webServer`（0.1.7）提供实际监听端口——网关的转发目标。写成必需依赖：
// cordis 4.0.4 的 ctx.get 对未声明服务严格，懒查会在服务进入 ACTIVE 前拿到
// undefined；而 port 要监听成功后才赋值。没有 Web 服务的 profile 本就用不上网关。
export const inject = ['subprocess', 'connection', 'webServer']

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
  const timer = ctx.get('timer')
  let handle = null

  /* 子进程 env：宿主环境的副本，叠加本行的决策。不再写回宿主 process.env——
     插件行不该有进程级副作用（此前 config 翻译和端口回写都会泄给宿主和其它
     插件行）。变量解析优先级与网关子进程原有约定一致：
     显式 env > cordis config > 宿主实际监听端口 > 3080。 */
  const childEnv = () => {
    const env = { ...process.env }
    if (config && typeof config === 'object') {
      for (const [key, envName] of Object.entries(CONFIG_ENV)) {
        if (config[key] !== undefined && config[key] !== null && env[envName] === undefined) {
          env[envName] = String(config[key])
        }
      }
    }
    // 0.1.7 桌面版的 Web UI 端口可配置、甚至可为 0（OS 派发），
    // ctx.webServer.port 才是权威值（inject 已声明，apply 时监听已就绪）；
    // 拿不到有效数字时保持 3080 兜底。
    if (env.LAN_GATE_TARGET_PORT === undefined) {
      const hostPort = ctx.webServer && typeof ctx.webServer.port === 'number' ? ctx.webServer.port : undefined
      if (hostPort !== undefined && hostPort > 0) env.LAN_GATE_TARGET_PORT = String(hostPort)
    }
    return env
  }

  const start = async () => {
    try {
      // 0.1.2 起浏览器要签名 cookie 才能进；token 只有 `GET /?token=` 一处收。
      // authenticatedUrl 是 connection 服务的公开方法，0.1.1 没有它——用它是不是
      // 函数来判断跑在哪一版，比看版本号可靠。只把这个 URL 交给子进程，密钥一律
      // 不传。
      const env = childEnv()
      const targetPort = Number(env.LAN_GATE_TARGET_PORT || 3080)
      const tokenUrl = ctx.connection && typeof ctx.connection.authenticatedUrl === 'function'
        ? ctx.connection.authenticatedUrl('http://127.0.0.1:' + targetPort)
        : undefined
      const nodePath = await ctx.subprocess.resolveExecutable('node')
      if (tokenUrl !== undefined) env['LAN_GATE_UPSTREAM_TOKEN_URL'] = tokenUrl
      else delete env['LAN_GATE_UPSTREAM_TOKEN_URL'] // 0.1.1 模式：变量不能残留
      handle = ctx.subprocess.spawn({
        argv: [nodePath, serverFile],
        cwd: here,
        env,
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
