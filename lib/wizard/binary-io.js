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
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, closeSync, constants as fsConstants, createWriteStream, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import { MANUAL_INSTALL_LINKS, binaryDownloadCandidates, binaryInstallPath, binDir, currentPlatform, } from './binary.js';
const GITHUB_API_TIMEOUT_MS = 4_000;
const SHA256_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;
/** Generous ceiling on one download; a mirror gone wrong must not be able
 * to fill the disk. Both real binaries sit far below 200 MB. */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
/** Connection / response-headers timeout before a mirror is skipped. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Maximum idle gap between body chunks before a stalled mirror is aborted. */
const STALL_TIMEOUT_MS = 15_000;
/** ELF: `\x7fELF`. */
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
/** Mach-O 32 big-endian, Mach-O 64 big-endian, Mach-O 64 little-endian —
 * the three shapes Apple toolchains emit for this codebase's targets. */
const MACH_O_MAGICS = [
    Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
    Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
];
/** Whether the first bytes of an image look like an executable this module
 * is willing to install on a unix host (GW-fix-1/H1 item 4). */
function looksLikeUnixImage(head) {
    return ELF_MAGIC.equals(head) || MACH_O_MAGICS.some((magic) => magic.equals(head));
}
/** The first four bytes of a file (fewer when the file is shorter). */
function headBytes(path) {
    const head = Buffer.alloc(4);
    const fd = openSync(path, 'r');
    try {
        return head.subarray(0, readSync(fd, head, 0, 4, 0));
    }
    finally {
        closeSync(fd);
    }
}
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
export class BinaryDownloadError extends Error {
    code;
    tool;
    url;
    status;
    installUrl;
    constructor(tool, url, status, message, options) {
        super(message, options);
        this.name = 'BinaryDownloadError';
        this.code = options?.code ?? 'download-failed';
        this.tool = tool;
        this.url = url;
        this.status = status;
        this.installUrl = MANUAL_INSTALL_LINKS[tool];
    }
}
/** Whether `path` exists and is executable (the "already installed" test). */
function isExecutableFile(path) {
    try {
        if (!statSync(path).isFile())
            return false;
        accessSync(path, fsConstants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The installed binary's absolute path, or undefined when it is not (yet)
 * on disk in executable shape — the read-only probe; see binary.ts's
 * `binaryInstallPath` for the pure arithmetic.
 */
export function binaryPath(dshHome, tool, platform = currentPlatform()) {
    const path = binaryInstallPath(dshHome, tool, platform);
    return isExecutableFile(path) ? path : undefined;
}
/**
 * Query GitHub Releases API directly for an official asset's `sha256:...` digest.
 * Returns lowercase 64-hex SHA-256 on success, or `undefined` on any network/API/shape miss.
 */
export async function resolveOfficialAssetSha256(releaseApiUrl, assetName, fetchImpl = fetch) {
    try {
        const response = await fetchImpl(releaseApiUrl, {
            redirect: 'follow',
            headers: {
                accept: 'application/vnd.github+json',
                'user-agent': 'dsh-zen-remote',
            },
            signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
        });
        if (!response.ok)
            return undefined;
        const payload = (await response.json());
        if (!Array.isArray(payload?.assets))
            return undefined;
        for (const item of payload.assets) {
            if (item === null || typeof item !== 'object')
                continue;
            const record = item;
            if (record.name !== assetName || typeof record.digest !== 'string')
                continue;
            const match = SHA256_DIGEST_PATTERN.exec(record.digest.trim());
            if (match !== null)
                return match[1].toLowerCase();
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
/** Write one fetched response body to `partPath` under the size cap and
 * per-chunk stall timeout so a throttled or hung mirror fails over quickly.
 * Returns the raw payload's lowercase hex SHA-256 digest. */
async function streamToFile(tool, url, body, partPath, onProgress) {
    const hash = createHash('sha256');
    let received = 0;
    let stallTimer;
    const counter = new Transform({
        transform(chunk, _encoding, done) {
            received += chunk.length;
            if (received > MAX_DOWNLOAD_BYTES) {
                done(new BinaryDownloadError(tool, url, null, `the download of ${tool} exceeds the ${MAX_DOWNLOAD_BYTES}-byte cap`));
                return;
            }
            hash.update(chunk);
            if (stallTimer !== undefined)
                clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
                counter.destroy(new BinaryDownloadError(tool, url, null, `the download of ${tool} stalled after ${received} bytes`));
            }, STALL_TIMEOUT_MS);
            if (typeof stallTimer.unref === 'function')
                stallTimer.unref();
            onProgress?.(received, null);
            done(null, chunk);
        },
    });
    stallTimer = setTimeout(() => {
        counter.destroy(new BinaryDownloadError(tool, url, null, `the download of ${tool} stalled before first byte`));
    }, STALL_TIMEOUT_MS);
    if (typeof stallTimer.unref === 'function')
        stallTimer.unref();
    try {
        await pipeline(Readable.fromWeb(body), counter, createWriteStream(partPath, { mode: 0o644 }));
        return hash.digest('hex');
    }
    catch (error) {
        rmSync(partPath, { force: true });
        throw error;
    }
    finally {
        if (stallTimer !== undefined)
            clearTimeout(stallTimer);
    }
}
/** Size bytes of a ustar header's octal size field, 0 when unparsable. */
function tarEntrySize(header) {
    const raw = header.subarray(124, 136).toString('ascii').replace(/[\0 ]+$/g, '').trim();
    const size = parseInt(raw === '' ? '0' : raw, 8);
    return Number.isFinite(size) && size > 0 ? size : 0;
}
/**
 * The first regular-file payload of a ustar archive as one buffer slice.
 * The cloudflared `.tgz` carries exactly one (`cloudflared`); anything else
 * (PAX/GNU metadata, directories) is skipped by advancing over its data
 * blocks, so a future archive layout change degrades to "not found" instead
 * of corrupt bytes.
 */
function firstTarFileEntry(archive) {
    let offset = 0;
    while (offset + 512 <= archive.length) {
        const header = archive.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0))
            return undefined;
        const size = tarEntrySize(header);
        const typeflag = String.fromCharCode(header[156] ?? 0x20);
        const dataStart = offset + 512;
        if ((typeflag === '0' || typeflag === '\0') && size > 0 && dataStart + size <= archive.length) {
            return archive.subarray(dataStart, dataStart + size);
        }
        offset = dataStart + Math.ceil(size / 512) * 512;
    }
    return undefined;
}
function chmodExec(path) {
    try {
        chmodSync(path, 0o755);
    }
    catch {
        // Windows: no executable bit — the extension does that job.
    }
}
/** Install `bytes` at `installPath`: `.part` sibling, chmod, atomic rename. */
function installBytes(bytes, installPath) {
    const partPath = `${installPath}.part`;
    try {
        writeFileSync(partPath, bytes, { mode: 0o644 });
        chmodExec(partPath);
        renameSync(partPath, installPath);
    }
    catch (error) {
        rmSync(partPath, { force: true });
        throw error;
    }
}
/** The unix image-magic gate (GW-fix-1/H1 item 4): a payload that does not
 * open with an ELF or Mach-O magic is refused, nothing lands on disk. */
function assertUnixImageMagic(tool, url, status, head) {
    if (looksLikeUnixImage(head))
        return;
    throw new BinaryDownloadError(tool, url, status, `the downloaded ${tool} does not carry an ELF or Mach-O image magic`, { code: 'bad-binary-image' });
}
/**
 * Download one binary from an explicit URL and install it. The archive
 * wrapper is the CALLER'S metadata (`options.archive`) — `ensureBinary`
 * feeds it from binaryUrls(); tests pin it per fixture. `platform` only
 * matters for the install name and the magic-check gate; it defaults to
 * this process's.
 * @returns the absolute install path.
 */
export async function downloadBinary(dshHome, tool, url, options = {}) {
    const platform = options.platform ?? currentPlatform();
    const archive = options.archive ?? 'none';
    const installPath = binaryInstallPath(dshHome, tool, platform);
    const expectedSha256 = options.expectedSha256?.toLowerCase();
    if (expectedSha256 !== undefined && !SHA256_HEX_PATTERN.test(expectedSha256)) {
        throw new BinaryDownloadError(tool, url, null, `invalid expected SHA-256 digest for ${tool}`, { code: 'checksum-mismatch' });
    }
    if (archive === 'zip') {
        // Refused BEFORE any network traffic: there is no zip reader in this
        // codebase yet (GW-fix-1/H1 item 3), and half-supporting the format
        // would only install a zip's bytes as an image.
        throw new BinaryDownloadError(tool, url, null, `the ${tool} asset for Windows ships as a zip, which cannot be unpacked here yet`, { code: 'windows-zip-unsupported' });
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    let response;
    try {
        response = await fetchImpl(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
        });
    }
    catch (cause) {
        throw new BinaryDownloadError(tool, url, null, `the download of ${tool} failed before an answer arrived`, { cause });
    }
    if (!response.ok || response.body === null) {
        throw new BinaryDownloadError(tool, url, response.status, `the download of ${tool} answered ${response.status}`);
    }
    mkdirSync(binDir(dshHome), { recursive: true });
    const declared = Number(response.headers.get('content-length'));
    const total = Number.isFinite(declared) && declared > 0 ? declared : null;
    const onProgress = options.onProgress
        ? (received) => options.onProgress?.(received, total)
        : undefined;
    if (archive === 'tgz') {
        // Archive (or auto-detected bare binary if an upstream endpoint serves a
        // raw ELF/Mach-O image despite tgz metadata): land the bytes in a sibling,
        // verify SHA-256 if provided, then either install directly when the payload
        // already starts with a unix image magic or gunzip + extract the tar entry.
        const tgzPath = `${installPath}.download.tgz`;
        try {
            const actualSha256 = await streamToFile(tool, url, response.body, tgzPath, onProgress);
            if (expectedSha256 !== undefined && actualSha256 !== expectedSha256) {
                throw new BinaryDownloadError(tool, url, response.status, `the downloaded ${tool} failed SHA-256 checksum verification`, { code: 'checksum-mismatch' });
            }
            const rawBytes = readFileSync(tgzPath);
            const gzipMagic = rawBytes.length >= 2 && rawBytes[0] === 0x1f && rawBytes[1] === 0x8b;
            const entry = (!gzipMagic && platform.os !== 'windows' && looksLikeUnixImage(rawBytes.subarray(0, 4)))
                ? rawBytes
                : firstTarFileEntry(gunzipSync(rawBytes));
            if (entry === undefined) {
                throw new BinaryDownloadError(tool, url, response.status, `the ${tool} archive carried no binary entry`);
            }
            if (platform.os !== 'windows')
                assertUnixImageMagic(tool, url, response.status, entry.subarray(0, 4));
            installBytes(entry, installPath);
        }
        catch (error) {
            if (error instanceof BinaryDownloadError)
                throw error;
            throw new BinaryDownloadError(tool, url, response.status, `the ${tool} archive could not be unpacked`, { cause: error });
        }
        finally {
            rmSync(tgzPath, { force: true });
        }
        return installPath;
    }
    // Bare executable: stream to the .part, verify SHA-256 if provided, gate the magic, then rename.
    const partPath = `${installPath}.part`;
    try {
        const actualSha256 = await streamToFile(tool, url, response.body, partPath, onProgress);
        if (expectedSha256 !== undefined && actualSha256 !== expectedSha256) {
            throw new BinaryDownloadError(tool, url, response.status, `the downloaded ${tool} failed SHA-256 checksum verification`, { code: 'checksum-mismatch' });
        }
        if (platform.os !== 'windows')
            assertUnixImageMagic(tool, url, response.status, headBytes(partPath));
        chmodExec(partPath);
        renameSync(partPath, installPath);
    }
    catch (error) {
        rmSync(partPath, { force: true });
        if (error instanceof BinaryDownloadError)
            throw error;
        throw new BinaryDownloadError(tool, url, response.status, `the download of ${tool} could not be written to disk`, { cause: error });
    }
    return installPath;
}
/** Cached mainland-China network detection so repeated downloads do not
 * re-probe within the same process. */
let cachedCnNetwork;
/**
 * Detect whether the current host is in mainland China:
 * 1. Fast local check: system timezone is `Asia/Shanghai`, `Asia/Chongqing`,
 *    `Asia/Harbin`, or `Asia/Urumqi`, or `LANG`/`LC_ALL` carries `zh_CN`.
 * 2. Quick 1.5s probe to Cloudflare's `/cdn-cgi/trace` (`loc=CN`), or if
 *    direct `github.com` HEAD fails/times out within 2s.
 */
export async function detectCnNetwork(fetchImpl = fetch) {
    if (cachedCnNetwork !== undefined)
        return cachedCnNetwork;
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
        if (/^Asia\/(Shanghai|Chongqing|Harbin|Urumqi)$/i.test(tz)) {
            cachedCnNetwork = true;
            return true;
        }
    }
    catch { /* ignore */ }
    const envLang = `${process.env.LANG ?? ''} ${process.env.LC_ALL ?? ''}`;
    if (/zh_CN/i.test(envLang)) {
        cachedCnNetwork = true;
        return true;
    }
    try {
        const trace = await fetchImpl('https://www.cloudflare.com/cdn-cgi/trace', {
            signal: AbortSignal.timeout(1500),
        });
        if (trace.ok) {
            const text = await trace.text();
            if (/\bloc=CN\b/i.test(text)) {
                cachedCnNetwork = true;
                return true;
            }
            cachedCnNetwork = false;
            return false;
        }
    }
    catch {
        // ignore trace timeout
    }
    cachedCnNetwork = false;
    return false;
}
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
export async function ensureBinary(dshHome, tool, options = {}) {
    const platform = options.platform ?? currentPlatform();
    const existing = binaryPath(dshHome, tool, platform);
    if (existing !== undefined)
        return { path: existing, downloaded: false };
    const fetchImpl = options.fetchImpl ?? fetch;
    const preferCnMirror = options.preferCnMirror ??
        (options.fetchImpl !== undefined ? false : await detectCnNetwork());
    const candidates = binaryDownloadCandidates(tool, platform, preferCnMirror);
    const digestCache = new Map();
    const getOfficialDigest = (releaseApiUrl, assetName) => {
        const key = `${releaseApiUrl}|${assetName}`;
        let pending = digestCache.get(key);
        if (pending === undefined) {
            pending = resolveOfficialAssetSha256(releaseApiUrl, assetName, fetchImpl);
            digestCache.set(key, pending);
        }
        return pending;
    };
    let lastError;
    for (const candidate of candidates) {
        let expectedSha256;
        if (candidate.mirrored) {
            if (!candidate.releaseApiUrl || !candidate.assetName)
                continue;
            expectedSha256 = await getOfficialDigest(candidate.releaseApiUrl, candidate.assetName);
            if (expectedSha256 === undefined) {
                // Never trust third-party mirrors when official GitHub release SHA-256 is unavailable.
                continue;
            }
        }
        try {
            const path = await downloadBinary(dshHome, tool, candidate.url, {
                ...options,
                archive: candidate.archive,
                ...(expectedSha256 !== undefined ? { expectedSha256 } : {}),
            });
            return { path, downloaded: true };
        }
        catch (error) {
            lastError = error;
        }
    }
    if (lastError !== undefined)
        throw lastError;
    throw new BinaryDownloadError(tool, candidates[0]?.url ?? '', null, `no trusted download candidate succeeded for ${tool}`);
}
//# sourceMappingURL=binary-io.js.map