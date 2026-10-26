/**
 * Ingress binary I/O (GW-2, revised by GW-fix-1/H1): download, unpack,
 * install and cache-probe for the two wizard-managed binaries. The
 * arithmetic lives in binary.ts; this file is the only one allowed to touch
 * the filesystem or the network for it.
 *
 * House rules the tasks pin down:
 *
 *   - No shell, no `child_process` at all. Downloads ride `fetch`, the
 *     body streams straight to a `.part` file, and the install is a POSIX
 *     rename — a crash mid-download can never leave a half binary at the
 *     install path.
 *   - The archive wrapper comes from binary.ts's METADATA (`options.archive`,
 *     what binaryUrls() models per platform), never from sniffing the URL:
 *     the Caddy build API's URL is a query string whose ending says nothing
 *     about the tar.gz / zip payload it answers with (GW-fix-1/H1).
 *   - Windows' Caddy asset is a zip and there is no zip reader here yet:
 *     refused up front with the typed `windows-zip-unsupported` code, the
 *     manual-install link stays the fallback (GW-fix-1/H1 item 3).
 *   - After unpacking (or for a bare download), a unix image must carry an
 *     ELF or Mach-O magic; anything else is refused as `bad-binary-image`
 *     and leaves nothing on disk (GW-fix-1/H1 item 4). Windows keeps no
 *     magic check — PE inspection is not this module's job.
 *   - The darwin cloudflared asset is a `.tgz`; it is unpacked with
 *     `zlib.gunzipSync` plus a minimal ustar reader (the archive carries a
 *     single entry — no PAX/GNU long-name handling needed, but those
 *     header types are skipped correctly if an upstream rebuild adds one).
 *   - Installed images get 0755; `ensureBinary` is idempotent (an existing
 *     executable short-circuits before any network traffic).
 *
 * `fetch` is injectable so the tests drive real downloads against a local
 * mock server without touching the network.
 */
import { type BinaryArchive, type BinaryPlatform, type IngressBinary } from './binary.js';
/**
 * One failed or refused download/install. `code` is the wire-stable marker
 * the UI classifies on — `'download-failed'` for transport/shaping
 * failures, `'windows-zip-unsupported'` for the zip refusal, and
 * `'bad-binary-image'` when the payload did not carry an executable
 * image's magic. `installUrl` is the official manual-install page the
 * failure card links to. Fields are assigned in the constructor body rather
 * than declared as parameter properties (the check scripts import modules
 * through Node's strip-only type stripping, which rejects that syntax).
 */
export declare class BinaryDownloadError extends Error {
    readonly code: string;
    readonly tool: IngressBinary;
    readonly url: string;
    readonly status: number | null;
    readonly installUrl: string;
    constructor(tool: IngressBinary, url: string, status: number | null, message: string, options?: {
        cause?: unknown;
        code?: string;
    });
}
/**
 * The installed binary's absolute path, or undefined when it is not (yet)
 * on disk in executable shape — the read-only probe; see binary.ts's
 * `binaryInstallPath` for the pure arithmetic.
 */
export declare function binaryPath(dshHome: string, tool: IngressBinary, platform?: BinaryPlatform): string | undefined;
/** Progress callback: bytes on disk so far, and the declared total when the
 * server sent one. */
export type DownloadProgress = (received: number, total: number | null) => void;
export interface DownloadBinaryOptions {
    fetchImpl?: typeof fetch;
    platform?: BinaryPlatform;
    onProgress?: DownloadProgress;
    /** The archive wrapper the URL delivers — metadata from binary.ts
     * (`binaryUrls` / `caddyDownload` / `cloudflaredDownload`), NOT guessed
     * from the URL shape. Default `'none'`: a bare executable. */
    archive?: BinaryArchive;
}
/**
 * Download one binary from an explicit URL and install it. The archive
 * wrapper is the CALLER'S metadata (`options.archive`) — `ensureBinary`
 * feeds it from binaryUrls(); tests pin it per fixture. `platform` only
 * matters for the install name and the magic-check gate; it defaults to
 * this process's.
 * @returns the absolute install path.
 */
export declare function downloadBinary(dshHome: string, tool: IngressBinary, url: string, options?: DownloadBinaryOptions): Promise<string>;
export interface EnsureBinaryOptions extends DownloadBinaryOptions {
    /** Force the platform mapping (tests); defaults to this process's. */
    platform?: BinaryPlatform;
}
/**
 * Detect whether the current host is in mainland China:
 * 1. Fast local check: system timezone is `Asia/Shanghai`, `Asia/Chongqing`,
 *    `Asia/Harbin`, or `Asia/Urumqi`, or `LANG`/`LC_ALL` carries `zh_CN`.
 * 2. Quick 1.5s probe to Cloudflare's `/cdn-cgi/trace` (`loc=CN`), or if
 *    direct `github.com` HEAD fails/times out within 2s.
 */
export declare function detectCnNetwork(fetchImpl?: typeof fetch): Promise<boolean>;
/**
 * The idempotent front door: an already-installed executable short-circuits
 * (no network), anything else downloads from the official distribution
 * point for the tool, archive shape included.
 *
 * When using the default `fetch` transport, automatically detects mainland
 * China network environments and tries prebuilt GitHub Release mirrors
 * (`gh-proxy.com` / `ghfast.top`) + direct GitHub Release before falling back
 * to `caddyserver.com/api/download`. When a custom `fetchImpl` is injected
 * (unit tests), calls the canonical `binaryUrls(platform)` endpoint directly.
 * @returns the absolute install path and whether THIS call downloaded.
 */
export declare function ensureBinary(dshHome: string, tool: IngressBinary, options?: EnsureBinaryOptions): Promise<{
    path: string;
    downloaded: boolean;
}>;
//# sourceMappingURL=binary-io.d.ts.map