/**
 * Ingress binary I/O (GW-2): download, unpack, install and cache-probe for
 * the two wizard-managed binaries. The arithmetic lives in binary.ts; this
 * file is the only one allowed to touch the filesystem or the network for
 * it.
 *
 * House rules the task pins down:
 *
 *   - No shell, no `child_process` at all. Downloads ride `fetch`, the
 *     body streams straight to a `.part` file, and the install is a POSIX
 *     rename — a crash mid-download can never leave a half binary at the
 *     install path.
 *   - The darwin arm64 cloudflared asset is a `.tgz`; it is unpacked with
 *     `zlib.gunzipSync` plus a minimal ustar reader (the archive carries a
 *     single `cloudflared` entry — no PAX/GNU long-name handling needed,
 *     but those header types are skipped correctly if an upstream rebuild
 *     adds one).
 *   - Installed images get 0755.
 *   - `ensureBinary` is idempotent: an existing executable short-circuits
 *     before any network traffic.
 *
 * `fetch` is injectable so the tests drive real downloads against a local
 * mock server without touching the network.
 */
import { type BinaryPlatform, type IngressBinary } from './binary.js';
/**
 * One failed download. `code` is the wire-stable `'download-failed'` the UI
 * classifies on; `installUrl` is the official manual-install page the
 * failure card links to. Fields are assigned in the constructor body rather
 * than declared as parameter properties (the check scripts import modules
 * through Node's strip-only type stripping, which rejects that syntax).
 */
export declare class BinaryDownloadError extends Error {
    readonly code = "download-failed";
    readonly tool: IngressBinary;
    readonly url: string;
    readonly status: number | null;
    readonly installUrl: string;
    constructor(tool: IngressBinary, url: string, status: number | null, message: string, options?: {
        cause?: unknown;
    });
}
/**
 * The installed binary's absolute path, or undefined when it is not (yet)
 * on disk in executable shape — the acceptance "binaryPath() 返回绝对路径
 * 或 undefined（未下载）". The read-only probe; see binary.ts's
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
}
/**
 * Download one binary from an explicit URL and install it. The archive
 * wrapper is inferred from the URL's `.tgz` suffix (the only archived shape
 * the distribution points use). `platform` only matters for tests that want
 * a specific install name; it defaults to this process's.
 * @returns the absolute install path.
 */
export declare function downloadBinary(dshHome: string, tool: IngressBinary, url: string, options?: DownloadBinaryOptions): Promise<string>;
export interface EnsureBinaryOptions extends DownloadBinaryOptions {
    /** Force the platform mapping (tests); defaults to this process's. */
    platform?: BinaryPlatform;
}
/**
 * The idempotent front door: an already-installed executable short-circuits
 * (no network), anything else downloads from the official distribution
 * point for the tool. `fetchImpl` injects the transport (tests point it at
 * a local mock server).
 * @returns the absolute install path and whether THIS call downloaded.
 */
export declare function ensureBinary(dshHome: string, tool: IngressBinary, options?: EnsureBinaryOptions): Promise<{
    path: string;
    downloaded: boolean;
}>;
//# sourceMappingURL=binary-io.d.ts.map