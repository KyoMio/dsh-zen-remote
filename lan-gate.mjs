// dsh-zen-remote-gateway — Cordis plugin entry
// Spawns the enhanced LAN/remote PWA gateway (lib/lan-gate-server.cjs) as an
// isolated child process, reverse-proxying the local DSH Web UI with:
//   - secure remote access (first-visit approval, one-token-per-browser, rate limit)
//   - PWA serving (/pwa/*) + mobile layout + touch gesture + offline + notifications
//
// Mount via cordis.patch.yml (see cordis.patch.yml.example) or `dsh plugin add`.
import { readFileConfig, resolveConfig } from './lib/config.js'
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

// Optional cordis config (set on the insert row in your profile patch, or
// through the DSH settings form — T12 resolves the row against
// lan-gate.config.json and env before handing it here):
//   { port, host, targetPort, rateLimit, trustedProxies, vapidSubject, lang }
// Each RESOLVED value is translated to its LAN_GATE_* env var, unconditionally
// overriding any host value; an undefined value DELETES the variable instead of
// letting a leftover host value leak into the child.
const CONFIG_ENV = {
  port: 'LAN_GATE_PORT',
  host: 'LAN_GATE_HOST',
  targetPort: 'LAN_GATE_TARGET_PORT',
  rateLimit: 'LAN_GATE_RATE_LIMIT',
  trustedProxies: 'LAN_GATE_TRUSTED_PROXIES',
  vapidSubject: 'LAN_GATE_VAPID_SUBJECT',
  lang: 'LAN_GATE_LANG',
}

export function apply(ctx, config) {
  // T12 复审遗留：与 dsh-push 相同，输入一律重新解析（resolveConfig 幂等——主
  // 入口传来的已解析值再走一遍结果不变），旧式独立网关行传来的部分行或 `{}` 也
  // 能拿到 env 和 lan-gate.config.json 的发言权，而不是被对象里恰好有什么所掩
  // 盖。precedence：env > row > lan-gate.config.json > defaults（src/config.ts）。
  const values = resolveConfig(config ?? {}, readFileConfig(), process.env).values
  const timer = ctx.get('timer')
  let handle = null
  // 行销毁标志：resolveExecutable 的 await 期间插件行可能正好被销毁（配置变更
  // 重启），此时清理函数看到的 handle 还是 null、无从 terminate；等 await 返回
  // 后照样 spawn 的话，子进程从此没人管（子进程归 subprocess 服务管，不随调用
  // 方插件自动清理）。所以在 await 之后、spawn 之前补一次检查，spawn 之后再兜
  // 一层——真发生时宁可立刻 terminate，也不留孤儿。
  let disposed = false

  /* 子进程 env：宿主环境的副本，叠加本行的决策。不再写回宿主 process.env——
     插件行不该有进程级副作用（此前 config 翻译和端口回写都会泄给宿主和其它
     插件行）。上面的 values 是重新解析后的生效值，环境变量在解析层已经考虑过
     （非法的被跳过），所以有值就无条件覆盖宿主里的同名变量；值为 undefined
     的字段必须删掉子进程里的同名变量——宿主环境里残留的非法值（如
     LAN_GATE_TARGET_PORT=xyz）若原样漏过去，子进程鉴权地址会变成
     127.0.0.1:NaN。 */
  const childEnv = () => {
    const env = { ...process.env }
    for (const [key, envName] of Object.entries(CONFIG_ENV)) {
      if (values[key] !== undefined) env[envName] = String(values[key])
      else delete env[envName]
    }
    // T22a 中继共享密钥：主入口每次 apply 现生成、只经这里进子进程，不允许由
    // 外部环境指定——所以无条件覆盖宿主里的同名变量；插件没带（client 角色、
    // 旧式独立加载）就删掉，密钥头功能随之关闭（子进程对空密钥不加头）。
    const relaySecret = config && typeof config === 'object' ? config.relaySecret : undefined
    if (typeof relaySecret === 'string' && relaySecret !== '') env.LAN_GATE_RELAY_SECRET = relaySecret
    else delete env.LAN_GATE_RELAY_SECRET
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
      if (disposed) return // 行在 await 期间被销毁：不再 spawn
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
      if (disposed) {
        // spawn 与本检查之间没有 await，外部代码插不进来；这层是给未来改动
        // 留的保险——一旦 disposed 为真，立刻收回刚拉起的孩子。
        try { handle.terminate() } catch (e) { /* ignore */ }
        handle = null
        return
      }
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
      disposed = true
      if (handle) { try { handle.terminate() } catch (e) { /* ignore */ } }
    }
  })
}
