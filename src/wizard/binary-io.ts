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

import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  createWriteStream,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { gunzipSync } from 'node:zlib'
import {
  MANUAL_INSTALL_LINKS,
  binaryInstallPath,
  binDir,
  binaryUrls,
  type BinaryPlatform,
  type IngressBinary,
} from './binary.js'

/** Generous ceiling on one download; a mirror gone wrong must not be able
 * to fill the disk. Both real binaries sit far below 200 MB. */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

/**
 * One failed download. `code` is the wire-stable `'download-failed'` the UI
 * classifies on; `installUrl` is the official manual-install page the
 * failure card links to. Fields are assigned in the constructor body rather
 * than declared as parameter properties (the check scripts import modules
 * through Node's strip-only type stripping, which rejects that syntax).
 */
export class BinaryDownloadError extends Error {
  readonly code = 'download-failed'
  readonly tool: IngressBinary
  readonly url: string
  readonly status: number | null
  readonly installUrl: string

  constructor(tool: IngressBinary, url: string, status: number | null, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BinaryDownloadError'
    this.tool = tool
    this.url = url
    this.status = status
    this.installUrl = MANUAL_INSTALL_LINKS[tool]
  }
}

/** This process's platform, mapped into the download points' naming (the
 * pure half's mapping, restated to keep this half import-light). */
function currentPlatformIO(): BinaryPlatform {
  return {
    os: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux',
    arch: process.arch === 'arm64' ? 'arm64' : 'amd64',
  }
}

/** Whether `path` exists and is executable (the "already installed" test). */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The installed binary's absolute path, or undefined when it is not (yet)
 * on disk in executable shape — the acceptance "binaryPath() 返回绝对路径
 * 或 undefined（未下载）". The read-only probe; see binary.ts's
 * `binaryInstallPath` for the pure arithmetic.
 */
export function binaryPath(dshHome: string, tool: IngressBinary, platform: BinaryPlatform = currentPlatformIO()): string | undefined {
  const path = binaryInstallPath(dshHome, tool, platform)
  return isExecutableFile(path) ? path : undefined
}

/** Progress callback: bytes on disk so far, and the declared total when the
 * server sent one. */
export type DownloadProgress = (received: number, total: number | null) => void

export interface DownloadBinaryOptions {
  fetchImpl?: typeof fetch
  platform?: BinaryPlatform
  onProgress?: DownloadProgress
}

/** Write one fetched response body to `partPath` under the size cap. */
async function streamToFile(
  tool: IngressBinary,
  url: string,
  body: NodeWebReadableStream<Uint8Array>,
  partPath: string,
  onProgress: DownloadProgress | undefined,
): Promise<void> {
  let received = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length
      if (received > MAX_DOWNLOAD_BYTES) {
        done(new BinaryDownloadError(tool, url, null, `the download of ${tool} exceeds the ${MAX_DOWNLOAD_BYTES}-byte cap`))
        return
      }
      onProgress?.(received, null)
      done(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(body), counter, createWriteStream(partPath, { mode: 0o644 }))
  } catch (error) {
    rmSync(partPath, { force: true })
    throw error
  }
}

/** Size bytes of a ustar header's octal size field, 0 when unparsable. */
function tarEntrySize(header: Buffer): number {
  const raw = header.subarray(124, 136).toString('ascii').replace(/[\0 ]+$/g, '').trim()
  const size = parseInt(raw === '' ? '0' : raw, 8)
  return Number.isFinite(size) && size > 0 ? size : 0
}

/**
 * The first regular-file payload of a ustar archive as one buffer slice.
 * The cloudflared `.tgz` carries exactly one (`cloudflared`); anything else
 * (PAX/GNU metadata, directories) is skipped by advancing over its data
 * blocks, so a future archive layout change degrades to "not found" instead
 * of corrupt bytes.
 */
function firstTarFileEntry(archive: Buffer): Buffer | undefined {
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) return undefined
    const size = tarEntrySize(header)
    const typeflag = String.fromCharCode(header[156] ?? 0x20)
    const dataStart = offset + 512
    if ((typeflag === '0' || typeflag === '\0') && size > 0 && dataStart + size <= archive.length) {
      return archive.subarray(dataStart, dataStart + size)
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return undefined
}

function chmodExec(path: string): void {
  try {
    chmodSync(path, 0o755)
  } catch {
    // Windows: no executable bit — the extension does that job.
  }
}

/** Install `bytes` at `installPath`: `.part` sibling, chmod, atomic rename. */
function installBytes(bytes: Uint8Array, installPath: string): void {
  const partPath = `${installPath}.part`
  try {
    writeFileSync(partPath, bytes, { mode: 0o644 })
    chmodExec(partPath)
    renameSync(partPath, installPath)
  } catch (error) {
    rmSync(partPath, { force: true })
    throw error
  }
}

/**
 * Download one binary from an explicit URL and install it. The archive
 * wrapper is inferred from the URL's `.tgz` suffix (the only archived shape
 * the distribution points use). `platform` only matters for tests that want
 * a specific install name; it defaults to this process's.
 * @returns the absolute install path.
 */
export async function downloadBinary(
  dshHome: string,
  tool: IngressBinary,
  url: string,
  options: DownloadBinaryOptions = {},
): Promise<string> {
  const platform = options.platform ?? currentPlatformIO()
  const installPath = binaryInstallPath(dshHome, tool, platform)
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(url, { redirect: 'follow' })
  } catch (cause) {
    throw new BinaryDownloadError(tool, url, null, `the download of ${tool} failed before an answer arrived`, { cause })
  }
  if (!response.ok || response.body === null) {
    throw new BinaryDownloadError(tool, url, response.status, `the download of ${tool} answered ${response.status}`)
  }
  mkdirSync(binDir(dshHome), { recursive: true })
  const declared = Number(response.headers.get('content-length'))
  const total = Number.isFinite(declared) && declared > 0 ? declared : null
  const onProgress: DownloadProgress | undefined = options.onProgress
    ? (received) => options.onProgress?.(received, total)
    : undefined
  if (url.endsWith('.tgz')) {
    // Archive: land the compressed bytes in a sibling, then unpack.
    const tgzPath = `${installPath}.download.tgz`
    try {
      await streamToFile(tool, url, response.body as unknown as NodeWebReadableStream<Uint8Array>, tgzPath, onProgress)
      const entry = firstTarFileEntry(gunzipSync(readFileSync(tgzPath)))
      if (entry === undefined) {
        throw new BinaryDownloadError(tool, url, response.status, `the ${tool} archive carried no binary entry`)
      }
      installBytes(entry, installPath)
    } catch (error) {
      if (error instanceof BinaryDownloadError) throw error
      throw new BinaryDownloadError(tool, url, response.status, `the ${tool} archive could not be unpacked`, { cause: error })
    } finally {
      rmSync(tgzPath, { force: true })
    }
    return installPath
  }
  try {
    await streamToFile(tool, url, response.body as unknown as NodeWebReadableStream<Uint8Array>, `${installPath}.part`, onProgress)
    chmodExec(`${installPath}.part`)
    renameSync(`${installPath}.part`, installPath)
  } catch (error) {
    if (error instanceof BinaryDownloadError) throw error
    throw new BinaryDownloadError(tool, url, response.status, `the download of ${tool} could not be written to disk`, { cause: error })
  }
  return installPath
}

export interface EnsureBinaryOptions extends DownloadBinaryOptions {
  /** Force the platform mapping (tests); defaults to this process's. */
  platform?: BinaryPlatform
}

/**
 * The idempotent front door: an already-installed executable short-circuits
 * (no network), anything else downloads from the official distribution
 * point for the tool. `fetchImpl` injects the transport (tests point it at
 * a local mock server).
 * @returns the absolute install path and whether THIS call downloaded.
 */
export async function ensureBinary(
  dshHome: string,
  tool: IngressBinary,
  options: EnsureBinaryOptions = {},
): Promise<{ path: string; downloaded: boolean }> {
  const platform = options.platform ?? currentPlatformIO()
  const existing = binaryPath(dshHome, tool, platform)
  if (existing !== undefined) return { path: existing, downloaded: false }
  const url = tool === 'caddy' ? binaryUrls(platform).caddy : binaryUrls(platform).cloudflared
  const path = await downloadBinary(dshHome, tool, url, options)
  return { path, downloaded: true }
}
