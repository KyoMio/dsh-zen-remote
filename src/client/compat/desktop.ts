/**
 * Desktop-shell detection for the mobile shell's master gate.
 *
 * The official desktop app is an Electron shell whose preload exposes a
 * `dshDesktop` bridge on `window` before any page script runs
 * (apps/desktop preload-app.ts, `contextBridge.exposeInMainWorld`), which is
 * the same marker official ui-settings gates desktop-only UI on. The check
 * is therefore synchronous and stable for the whole page lifetime.
 *
 * Plain web — phone browsers, the LAN gateway, desktop browsers at any
 * window width — never has the bridge, so the mobile shell stays available
 * there. This matters because an Electron window can be dragged down to
 * ~520px wide, where every width-based gate would otherwise flip the phone
 * shell on inside the desktop app.
 *
 * @param host - host object to probe; defaults to globalThis. Injectable so
 * the two states are testable off-browser (test/desktop-shell.test.cjs) —
 * apply() short-circuits the whole mobile shell on a true answer.
 */
export function isDesktopShell(host: typeof globalThis = globalThis): boolean {
  return 'dshDesktop' in host
}
