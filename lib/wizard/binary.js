/**
 * Ingress binary arithmetic (GW-2): platform mapping, download-URL
 * construction and install-path computation for the two binaries the
 * gateway wizard manages — Caddy (custom build with the Cloudflare DNS
 * module, for DNS-01 certificates) and cloudflared (the tunnel client).
 *
 * Pure by contract: URL strings, path strings and platform facts only —
 * every touch of the filesystem or the network lives in binary-io.ts, and
 * the routes layer reads both. `node:path`/`node:os` here are arithmetic,
 * not I/O: the same discipline as virtual-id.ts's zero-dependency rule,
 * relaxed one notch because path building is this module's whole job.
 *
 * Platform coverage mirrors what both upstream distribution points actually
 * ship: darwin/linux/windows × amd64/arm64. macOS arm64's cloudflared asset
 * is a `.tgz` (the only archive shape in the set) — binary-io unpacks it.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
/** This process's platform, mapped into the download points' naming. */
export function currentPlatform() {
    if (process.platform === 'win32')
        return { os: 'windows', arch: 'amd64' };
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    if (process.platform === 'darwin')
        return { os: 'darwin', arch };
    return { os: 'linux', arch };
}
/** Caddy's custom-build API, pinned to the Cloudflare DNS module the
 * DNS-01 challenge needs (plain Caddy cannot write the TXT record). */
export function caddyDownloadUrl(platform) {
    return `https://caddyserver.com/api/download?os=${platform.os}&arch=${platform.arch}&p=github.com/caddy-dns/cloudflare`;
}
/**
 * The Caddy asset the build API answers with, PLUS its archive shape —
 * `caddyserver.com/api/download` returns a bare Mach-O/ELF binary on unix
 * (`Content-Disposition: attachment; filename="caddy_<os>_<arch>_custom"`,
 * `Content-Type: application/octet-stream`) and a bare `.exe` on Windows.
 */
export function caddyDownload(platform) {
    return { url: caddyDownloadUrl(platform), archive: platform.os === 'windows' ? 'exe' : 'none' };
}
/** cloudflared's GitHub Releases asset for one platform, plus the archive
 * shape the I/O half must unwrap (darwin assets are `.tgz`, windows ships
 * a bare `.exe`, linux a bare binary). */
export function cloudflaredDownload(platform) {
    const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
    if (platform.os === 'darwin')
        return { url: `${base}cloudflared-darwin-${platform.arch}.tgz`, archive: 'tgz' };
    if (platform.os === 'windows')
        return { url: `${base}cloudflared-windows-amd64.exe`, archive: 'exe' };
    return { url: `${base}cloudflared-linux-${platform.arch}`, archive: 'none' };
}
/** Both download URLs for one platform WITH their archive shapes, defaults
 * to the running process's. The archive metadata — not a URL suffix — is
 * what tells the I/O half how to unpack. */
export function binaryUrls(platform = currentPlatform()) {
    const caddy = caddyDownload(platform);
    const cloudflared = cloudflaredDownload(platform);
    return { caddy: caddy.url, caddyArchive: caddy.archive, cloudflared: cloudflared.url, cloudflaredArchive: cloudflared.archive };
}
/** Official manual-install pages, surfaced by the UI when a download fails. */
export const MANUAL_INSTALL_LINKS = {
    caddy: 'https://caddyserver.com/download',
    cloudflared: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
};
/** Everything ingress lives under this one directory of DSH_HOME. */
export const INGRESS_DIR_NAME = 'zen-remote-ingress';
/** `<DSH_HOME>` as the rest of the plugin resolves it (config.ts's convention). */
export function dshHomeDefault(env = process.env) {
    return env.DSH_HOME ?? join(homedir(), '.dsh');
}
/** `<DSH_HOME>/zen-remote-ingress` — Caddyfile, data dir and bin/ sit here. */
export function ingressDir(dshHome) {
    return join(dshHome, INGRESS_DIR_NAME);
}
/** `<DSH_HOME>/zen-remote-ingress/bin` — both binaries install here. */
export function binDir(dshHome) {
    return join(ingressDir(dshHome), 'bin');
}
/** `<DSH_HOME>/zen-remote-ingress/Caddyfile` — generated, validated, then
 * handed to `caddy run --config`. */
export function caddyfilePath(dshHome) {
    return join(ingressDir(dshHome), 'Caddyfile');
}
/** `<DSH_HOME>/zen-remote-ingress/caddy-data` — certificates and the ACME
 * account live here, kept out of the default Caddy home. */
export function caddyDataDir(dshHome) {
    return join(ingressDir(dshHome), 'caddy-data');
}
/** The installed file name. Windows cannot spawn an extension-less image,
 * so the `.exe` suffix is part of the install name there. */
export function binaryFileName(tool, platform = currentPlatform()) {
    if (platform.os === 'windows')
        return tool === 'caddy' ? 'caddy.exe' : 'cloudflared.exe';
    return tool;
}
/** The absolute install path for one binary (where downloadBinary puts it). */
export function binaryInstallPath(dshHome, tool, platform = currentPlatform()) {
    return join(binDir(dshHome), binaryFileName(tool, platform));
}
//# sourceMappingURL=binary.js.map