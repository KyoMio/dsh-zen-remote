/**
 * Make a dropped file an ATTACHMENT in a remote session (2.2.6, follow-up).
 *
 * DSH's composer prefers a *path reference* over an upload whenever the
 * desktop shell exposes its host-path bridge: `addFiles` reads
 * `globalThis.__DSH_HOST_PATHS__` (RT dsh-client-ui-conversation
 * `hostPathBridge()` / `addFiles` ~19942-19970) and, for every non-image
 * file, inserts `@<absolute path>` into the draft instead of uploading the
 * bytes. That is correct when the UI and the DSH backend run on the same
 * machine — the agent can read the path.
 *
 * In a REMOTE session it is wrong: the path is on the machine showing the
 * UI, while the agent runs on the host. The draft ends up carrying e.g.
 * `@C:\Users\me\Desktop\日志.txt`, the prompt reaches the host as plain
 * text, and the file never exists there — exactly the "uploaded a file but
 * the agent cannot read it" failure.
 *
 * The bridge is read through the global on every composer inject, and
 * `pathFor(file)` is called per dropped file, so one Proxy is enough: while
 * the session on screen is virtual (the plugin's own
 * `data-zr-remote-session` marker, maintained by effects/remote-session.ts),
 * `pathFor` answers `undefined`. The composer's own next branch then treats
 * the file as an ordinary upload (`uploads.push(file)`), which the plugin's
 * T51 interception already relays to the host — the file becomes a real
 * attachment receipt on the server and the agent can read it.
 *
 * Everything else on the bridge passes through untouched, and outside a
 * remote session `pathFor` delegates to the shell's original. No bridge
 * (the web UI, or a shell without it) means nothing to do.
 */

/** The bridge member the composer calls; the shell's object may carry more. */
interface HostPathBridge {
  pathFor?(file: File): string | undefined
  [key: string]: unknown
}

/** The plugin-maintained marker for "the session on screen is a relay one". */
const REMOTE_ATTRIBUTE = 'data-zr-remote-session'

/** True while the page shows a remote (virtual) session. */
export function remoteSessionOnScreen(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.getAttribute(REMOTE_ATTRIBUTE) === '1'
}

/** The live wrapper, if any (one per page). */
let installed: { proxy: HostPathBridge; bridge: HostPathBridge } | undefined
/** The install generation that currently owns the wrapper. */
let owner: symbol | undefined

/**
 * Wrap the shell's host-path bridge so a remote session's dropped files
 * upload instead of becoming client-local path mentions.
 * @param isRemote - reads the current session kind; injectable for tests.
 * @returns the uninstaller (restores the original only while still ours).
 */
export function installHostPathBridgeGuard(isRemote: () => boolean = remoteSessionOnScreen): () => void {
  const token = Symbol('host-path-bridge-owner')
  // A hot reloaded instance (new apply before the old dispose) ADOPTS the
  // live wrapper: the wrapper is stateless (it reads the DOM per call), and
  // only the current owner may unwrap it — the old instance's dispose must
  // not leave the page without the guard.
  if (installed !== undefined) {
    owner = token
    return () => {
      if (owner !== token) return
      owner = undefined
      restoreInstalled()
    }
  }

  const host = globalThis as typeof globalThis & { __DSH_HOST_PATHS__?: HostPathBridge }
  const bridge = host.__DSH_HOST_PATHS__
  if (bridge === undefined || bridge === null || typeof bridge !== 'object') return () => {}

  const original = typeof bridge.pathFor === 'function' ? bridge.pathFor.bind(bridge) : undefined
  const proxy = new Proxy(bridge, {
    get(target, property, receiver) {
      if (property === 'pathFor') {
        return (file: File): string | undefined => (isRemote() ? undefined : original?.(file))
      }
      return Reflect.get(target, property, receiver)
    },
  })
  try {
    host.__DSH_HOST_PATHS__ = proxy
  } catch {
    // A shell that freezes the global keeps today's (buggy-remotely)
    // behaviour rather than breaking local drops.
    return () => {}
  }
  installed = { proxy, bridge }
  owner = token
  return () => {
    if (owner !== token) return
    owner = undefined
    restoreInstalled()
  }
}

/** Put the shell's own object back, only while our Proxy still holds the global. */
function restoreInstalled(): void {
  const current = installed
  installed = undefined
  if (current === undefined) return
  const host = globalThis as typeof globalThis & { __DSH_HOST_PATHS__?: HostPathBridge }
  if (host.__DSH_HOST_PATHS__ === current.proxy) host.__DSH_HOST_PATHS__ = current.bridge
}
