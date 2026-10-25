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
/** The two binaries the wizard downloads and runs. */
export type IngressBinary = 'caddy' | 'cloudflared';
/** The platform shapes both distribution points understand. */
export interface BinaryPlatform {
    os: 'darwin' | 'linux' | 'windows';
    arch: 'amd64' | 'arm64';
}
/** The archive wrapper a cloudflared asset arrives in; `none` is a bare
 * executable, `exe` Windows' own format. */
export type CloudflaredArchive = 'tgz' | 'exe' | 'none';
/** This process's platform, mapped into the download points' naming. */
export declare function currentPlatform(): BinaryPlatform;
/** Caddy's custom-build API, pinned to the Cloudflare DNS module the
 * DNS-01 challenge needs (plain Caddy cannot write the TXT record). */
export declare function caddyDownloadUrl(platform: BinaryPlatform): string;
/** cloudflared's GitHub Releases asset for one platform, plus the archive
 * shape the I/O half must unwrap (darwin assets are `.tgz`, windows ships
 * a bare `.exe`, linux a bare binary). */
export declare function cloudflaredDownload(platform: BinaryPlatform): {
    url: string;
    archive: CloudflaredArchive;
};
/** Both download URLs for one platform, defaults to the running process's. */
export declare function binaryUrls(platform?: BinaryPlatform): {
    caddy: string;
    cloudflared: string;
    cloudflaredArchive: CloudflaredArchive;
};
/** Official manual-install pages, surfaced by the UI when a download fails. */
export declare const MANUAL_INSTALL_LINKS: Readonly<Record<IngressBinary, string>>;
/** Everything ingress lives under this one directory of DSH_HOME. */
export declare const INGRESS_DIR_NAME = "zen-remote-ingress";
/** `<DSH_HOME>` as the rest of the plugin resolves it (config.ts's convention). */
export declare function dshHomeDefault(env?: NodeJS.ProcessEnv): string;
/** `<DSH_HOME>/zen-remote-ingress` — Caddyfile, data dir and bin/ sit here. */
export declare function ingressDir(dshHome: string): string;
/** `<DSH_HOME>/zen-remote-ingress/bin` — both binaries install here. */
export declare function binDir(dshHome: string): string;
/** The installed file name. Windows cannot spawn an extension-less image,
 * so the `.exe` suffix is part of the install name there. */
export declare function binaryFileName(tool: IngressBinary, platform?: BinaryPlatform): string;
/** The absolute install path for one binary (where downloadBinary puts it). */
export declare function binaryInstallPath(dshHome: string, tool: IngressBinary, platform?: BinaryPlatform): string;
//# sourceMappingURL=binary.d.ts.map