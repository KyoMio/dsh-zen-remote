/**
 * Persistent in-container hot-update manager for gateway-server (`/data/releases`).
 *
 * Security & reliability invariants:
 * - Official `api.github.com` release lookup also discovers the latest non-prerelease
 *   main plugin `v*` version (zero hardcoded plugin versions).
 * - Mirror prefixes are ONLY permitted when an official `sha256:<64-hex>` asset
 *   digest is present; without a verified digest, only the direct official URL is tried.
 * - Downloads stream to `.part` files bounded by `maxDownloadBytes` (default 32 MiB)
 *   and stall timeout, verified against SHA-256 before extraction.
 * - Maintains `<dataDir>/releases/node_modules` -> `<baseAppRoot>/node_modules`
 *   junction symlink so staged ESM bundles resolve native dependencies (`pg`, `ws`).
 * - Verifies `release-manifest.json` (`baseCompatEpoch`, `minNodeMajor`),
 *   `dist/public/index.html`, and isolated `--self-check` child execution before
 *   committing `state.json` (0o600) and pruning older versions beyond 2 generations.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractTarGzSafely } from './archive.js';
import { compareSemver, maxSemver, parseSemver, readPackageVersion, resolveAppRootPackagePath } from './version.js';

export const CURRENT_BASE_COMPAT_EPOCH = 1;
export const GATEWAY_RELEASE_ASSET_NAME = 'zen-remote-gateway-bundle.tar.gz';
export const DEFAULT_RELEASES_API_URL = 'https://api.github.com/repos/KyoMio/dsh-zen-remote/releases?per_page=20';
export const DEFAULT_MIRROR_PREFIXES: readonly string[] = ['https://gh-proxy.com/', 'https://ghfast.top/'];
export const DEFAULT_MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const DEFAULT_SELF_CHECK_TIMEOUT_MS = 8_000;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;
export const DOCKER_UPGRADE_COMMAND = 'docker compose pull && docker compose up -d';

const GATEWAY_TAG_RE = /^gateway-v(\d+\.\d+\.\d+)$/;
const PLUGIN_TAG_RE = /^v(\d+\.\d+\.\d+)$/;
const SHA256_DIGEST_RE = /^sha256:([0-9a-f]{64})$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

export type UpdateCompatibility = 'compatible' | 'image-pull-required';

export interface ReleaseManifest {
  schemaVersion: number;
  version: string;
  baseCompatEpoch: number;
  minNodeMajor: number;
  entry: string;
  builtAt?: string;
}

export interface ReleaseRollbackRecord {
  failedVersion: string;
  rolledBackTo: string;
  reason: string;
  at: string;
}

export interface ReleaseState {
  activeVersion: string | null;
  activeEntry: string | null;
  previousVersion: string | null;
  previousEntry: string | null;
  pendingVerify: boolean;
  baseVersionSeen: string | null;
  lastRollback: ReleaseRollbackRecord | null;
}

export interface DownloadCandidate {
  url: string;
  mirrored: boolean;
}

export interface DiscoveredGatewayRelease {
  version: string;
  tagName: string;
  downloadUrl: string;
  sha256: string | null;
  notesSummary: string | null;
  publishedAt: string | null;
}

export interface UpdateCheckResult {
  checkedAt: string;
  currentVersion: string | null;
  baseVersion: string | null;
  latestVersion: string | null;
  latestPluginVersion: string | null;
  updateAvailable: boolean;
  compatibility: UpdateCompatibility;
  incompatibilityReason: string | null;
  notesSummary: string | null;
  hasOfficialDigest: boolean;
}

export interface PrepareUpdateResult {
  status: 'prepared' | 'up-to-date' | 'image-pull-required';
  version: string | null;
  entry?: string;
  reason?: string;
}

export interface UpdateManagerOptions {
  dataDir: string;
  baseAppRoot?: string;
  currentVersion?: string | null;
  baseVersion?: string | null;
  releasesApiUrl?: string;
  mirrorPrefixes?: readonly string[];
  preferMirror?: boolean;
  fetchImpl?: typeof fetch;
  selfCheckTimeoutMs?: number;
  downloadTimeoutMs?: number;
  maxDownloadBytes?: number;
  baseCompatEpoch?: number;
  nodeMajorVersion?: number;
  selfCheckRunner?: (entryPath: string, timeoutMs: number) => Promise<void>;
  now?: () => number;
}

export function defaultReleaseState(): ReleaseState {
  return {
    activeVersion: null,
    activeEntry: null,
    previousVersion: null,
    previousEntry: null,
    pendingVerify: false,
    baseVersionSeen: null,
    lastRollback: null,
  };
}

export function releasesRootDir(dataDir: string): string {
  return path.join(dataDir, 'releases');
}

export function releaseStateFilePath(dataDir: string): string {
  return path.join(releasesRootDir(dataDir), 'state.json');
}

function sanitizeOptionalString(v: unknown, maxLen = 256): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLen) : null;
}

function normalizeRelativeEntry(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const normalized = v.trim().replace(/\\/g, '/');
  if (normalized.length === 0 || normalized.startsWith('/')) return null;
  const parts = normalized.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return parts.join('/');
}

export function readReleaseState(dataDir: string): ReleaseState {
  const filePath = releaseStateFilePath(dataDir);
  if (!fs.existsSync(filePath)) return defaultReleaseState();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return defaultReleaseState();
    const rbRaw = raw['lastRollback'];
    let lastRollback: ReleaseRollbackRecord | null = null;
    if (typeof rbRaw === 'object' && rbRaw !== null && !Array.isArray(rbRaw)) {
      const rb = rbRaw as Record<string, unknown>;
      const failedVersion = parseSemver(rb['failedVersion'])?.normalized ?? null;
      const rolledBackTo = parseSemver(rb['rolledBackTo'])?.normalized ?? null;
      const reason = sanitizeOptionalString(rb['reason'], 240);
      const at = sanitizeOptionalString(rb['at'], 64);
      if (failedVersion !== null && rolledBackTo !== null && reason !== null && at !== null) {
        lastRollback = { failedVersion, rolledBackTo, reason, at };
      }
    }
    return {
      activeVersion: parseSemver(raw['activeVersion'])?.normalized ?? null,
      activeEntry: normalizeRelativeEntry(raw['activeEntry']),
      previousVersion: parseSemver(raw['previousVersion'])?.normalized ?? null,
      previousEntry: normalizeRelativeEntry(raw['previousEntry']),
      pendingVerify: raw['pendingVerify'] === true,
      baseVersionSeen: parseSemver(raw['baseVersionSeen'])?.normalized ?? null,
      lastRollback,
    };
  } catch {
    return defaultReleaseState();
  }
}

export function writeReleaseState(dataDir: string, state: ReleaseState): void {
  const dir = releasesRootDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = releaseStateFilePath(dataDir);
  const tmp = path.join(dir, `.state.json.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* ignore chmod failure on platforms that disallow it */
  }
}

export function ensureReleasesNodeModulesLink(dataDir: string, baseAppRoot: string): string {
  const dir = releasesRootDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const linkPath = path.join(dir, 'node_modules');
  const targetPath = path.resolve(baseAppRoot, 'node_modules');
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const existing = fs.readlinkSync(linkPath);
      if (path.resolve(dir, existing) === targetPath) {
        return linkPath;
      }
      fs.unlinkSync(linkPath);
    } else {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch {
    /* linkPath does not exist yet */
  }
  fs.symlinkSync(targetPath, linkPath, 'junction');
  return linkPath;
}

export function buildDownloadCandidates(
  directUrl: string,
  officialSha256: string | null | undefined,
  mirrorPrefixes: readonly string[] = DEFAULT_MIRROR_PREFIXES,
  preferMirror = false,
): DownloadCandidate[] {
  const direct: DownloadCandidate = { url: directUrl, mirrored: false };
  const hasValidDigest = typeof officialSha256 === 'string' && SHA256_HEX_RE.test(officialSha256);
  if (!hasValidDigest || mirrorPrefixes.length === 0) {
    return [direct];
  }
  const mirrors: DownloadCandidate[] = mirrorPrefixes.map((prefix) => ({
    url: `${prefix}${directUrl}`,
    mirrored: true,
  }));
  return preferMirror ? [...mirrors, direct] : [direct, ...mirrors];
}

function defaultSelfCheckRunner(entryPath: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', entryPath, '--self-check'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env },
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2048) stderr += chunk.toString('utf8');
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error(`self-check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`self-check spawn failed: ${err.message}`));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim();
        reject(
          new Error(
            `self-check failed (code=${code ?? 'null'}, signal=${signal ?? 'null'})${detail ? `: ${detail}` : ''}`,
          ),
        );
      }
    });
  });
}

function isSafeHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export class UpdateManager {
  private readonly dataDir: string;
  private readonly baseAppRoot: string;
  private readonly currentVersion: string | null;
  private readonly baseVersion: string | null;
  private readonly releasesApiUrl: string;
  private readonly mirrorPrefixes: readonly string[];
  private readonly preferMirror: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly selfCheckTimeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly maxDownloadBytes: number;
  private readonly baseCompatEpoch: number;
  private readonly nodeMajorVersion: number;
  private readonly selfCheckRunner: (entryPath: string, timeoutMs: number) => Promise<void>;
  private readonly now: () => number;

  private latestRelease: DiscoveredGatewayRelease | null = null;
  private latestPluginVersion: string | null = null;
  private lastCheckedAt: string | null = null;
  private lastCheckError: string | null = null;
  private incompatibleVersion: string | null = null;
  private incompatibleReason: string | null = null;
  private prepareInFlight: Promise<PrepareUpdateResult> | null = null;

  constructor(options: UpdateManagerOptions) {
    this.dataDir = options.dataDir;
    this.baseAppRoot =
      options.baseAppRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    this.currentVersion =
      options.currentVersion !== undefined
        ? (parseSemver(options.currentVersion)?.normalized ?? null)
        : readPackageVersion(resolveAppRootPackagePath(import.meta.url));
    this.baseVersion =
      options.baseVersion !== undefined
        ? (parseSemver(options.baseVersion)?.normalized ?? null)
        : (parseSemver(process.env['ZR_GATEWAY_BASE_VERSION'])?.normalized ??
          readPackageVersion(path.join(this.baseAppRoot, 'package.json')) ??
          this.currentVersion);
    this.releasesApiUrl = options.releasesApiUrl ?? DEFAULT_RELEASES_API_URL;
    this.mirrorPrefixes = options.mirrorPrefixes ?? DEFAULT_MIRROR_PREFIXES;
    this.preferMirror = options.preferMirror ?? false;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.selfCheckTimeoutMs = options.selfCheckTimeoutMs ?? DEFAULT_SELF_CHECK_TIMEOUT_MS;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    this.baseCompatEpoch = options.baseCompatEpoch ?? CURRENT_BASE_COMPAT_EPOCH;
    this.nodeMajorVersion =
      options.nodeMajorVersion ?? Number.parseInt(process.versions.node.split('.')[0] ?? '22', 10);
    this.selfCheckRunner = options.selfCheckRunner ?? defaultSelfCheckRunner;
    this.now = options.now ?? Date.now;
  }

  getState(): ReleaseState {
    return readReleaseState(this.dataDir);
  }

  getCurrentVersion(): string | null {
    return this.currentVersion;
  }

  getBaseVersion(): string | null {
    return this.baseVersion;
  }

  getLatestPluginVersion(): string | null {
    return this.latestPluginVersion;
  }

  getLastCheckedAt(): string | null {
    return this.lastCheckedAt;
  }

  getLastCheckError(): string | null {
    return this.lastCheckError;
  }

  getLatestRelease(): DiscoveredGatewayRelease | null {
    return this.latestRelease;
  }

  getCompatibilityForLatest(): { compatibility: UpdateCompatibility; reason: string | null } {
    if (
      this.latestRelease !== null &&
      this.incompatibleVersion !== null &&
      this.incompatibleVersion === this.latestRelease.version
    ) {
      return { compatibility: 'image-pull-required', reason: this.incompatibleReason };
    }
    return { compatibility: 'compatible', reason: null };
  }

  isUpdateAvailable(): boolean {
    if (this.latestRelease === null || this.currentVersion === null) return false;
    return compareSemver(this.latestRelease.version, this.currentVersion) > 0;
  }

  dismissRollback(): ReleaseState {
    const state = readReleaseState(this.dataDir);
    if (state.lastRollback === null) return state;
    const next: ReleaseState = { ...state, lastRollback: null };
    writeReleaseState(this.dataDir, next);
    return next;
  }

  async checkForUpdates(): Promise<UpdateCheckResult> {
    const checkedAt = new Date(this.now()).toISOString();
    try {
      const response = await this.fetchImpl(this.releasesApiUrl, {
        redirect: 'follow',
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'dsh-zen-remote-gateway',
        },
        signal: AbortSignal.timeout(this.downloadTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`GitHub releases API returned HTTP ${response.status}`);
      }
      const payload = (await response.json()) as unknown;
      if (!Array.isArray(payload)) {
        throw new Error('GitHub releases API returned non-array payload');
      }

      let bestGateway: DiscoveredGatewayRelease | null = null;
      let bestPlugin: string | null = null;

      for (const item of payload) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        const rel = item as Record<string, unknown>;
        if (rel['draft'] === true || rel['prerelease'] === true) continue;
        const tag = typeof rel['tag_name'] === 'string' ? rel['tag_name'].trim() : '';
        if (tag.length === 0) continue;

        const pluginMatch = PLUGIN_TAG_RE.exec(tag);
        if (pluginMatch !== null) {
          bestPlugin = maxSemver(bestPlugin, pluginMatch[1]!);
          continue;
        }

        const gwMatch = GATEWAY_TAG_RE.exec(tag);
        if (gwMatch === null) continue;
        const ver = parseSemver(gwMatch[1])?.normalized ?? null;
        if (ver === null) continue;
        const assets = Array.isArray(rel['assets']) ? rel['assets'] : [];
        const asset = assets.find(
          (a): a is Record<string, unknown> =>
            typeof a === 'object' && a !== null && (a as Record<string, unknown>)['name'] === GATEWAY_RELEASE_ASSET_NAME,
        );
        if (asset === undefined || !isSafeHttpUrl(asset['browser_download_url'])) continue;

        const rawDigest = typeof asset['digest'] === 'string' ? asset['digest'].trim() : '';
        const digestMatch = SHA256_DIGEST_RE.exec(rawDigest);
        const sha256 = digestMatch !== null ? digestMatch[1]!.toLowerCase() : null;
        const bodyRaw = typeof rel['body'] === 'string' ? rel['body'].trim() : '';
        const notesSummary = bodyRaw.length > 0 ? bodyRaw.slice(0, 500) : null;
        const publishedAt = typeof rel['published_at'] === 'string' ? rel['published_at'] : null;

        if (bestGateway === null || compareSemver(ver, bestGateway.version) > 0) {
          bestGateway = {
            version: ver,
            tagName: tag,
            downloadUrl: asset['browser_download_url'],
            sha256,
            notesSummary,
            publishedAt,
          };
        }
      }

      this.latestRelease = bestGateway;
      this.latestPluginVersion = bestPlugin;
      this.lastCheckedAt = checkedAt;
      this.lastCheckError = null;
      const compat = this.getCompatibilityForLatest();

      return {
        checkedAt,
        currentVersion: this.currentVersion,
        baseVersion: this.baseVersion,
        latestVersion: bestGateway?.version ?? null,
        latestPluginVersion: bestPlugin,
        updateAvailable: this.isUpdateAvailable(),
        compatibility: compat.compatibility,
        incompatibilityReason: compat.reason,
        notesSummary: bestGateway?.notesSummary ?? null,
        hasOfficialDigest: bestGateway?.sha256 !== null && bestGateway !== null,
      };
    } catch (error) {
      this.lastCheckedAt = checkedAt;
      this.lastCheckError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  prepareUpdate(): Promise<PrepareUpdateResult> {
    if (this.prepareInFlight !== null) return this.prepareInFlight;
    const run = this.doPrepareUpdate().finally(() => {
      this.prepareInFlight = null;
    });
    this.prepareInFlight = run;
    return run;
  }

  private async doPrepareUpdate(): Promise<PrepareUpdateResult> {
    if (this.latestRelease === null) {
      await this.checkForUpdates();
    }
    const release = this.latestRelease;
    if (release === null || !this.isUpdateAvailable()) {
      return { status: 'up-to-date', version: this.currentVersion };
    }

    const candidates = buildDownloadCandidates(
      release.downloadUrl,
      release.sha256,
      this.mirrorPrefixes,
      this.preferMirror,
    );

    const relRoot = releasesRootDir(this.dataDir);
    const downloadsDir = path.join(relRoot, 'downloads');
    const stagingBase = path.join(relRoot, 'staging');
    const versionsDir = path.join(relRoot, 'versions');
    fs.mkdirSync(downloadsDir, { recursive: true });
    fs.mkdirSync(stagingBase, { recursive: true });
    fs.mkdirSync(versionsDir, { recursive: true });

    let downloadedBuf: Buffer | null = null;
    let lastError: Error | null = null;

    for (const candidate of candidates) {
      const partPath = path.join(
        downloadsDir,
        `${release.version}-${randomBytes(6).toString('hex')}.tar.gz.part`,
      );
      try {
        downloadedBuf = await this.downloadAndVerifyCandidate(candidate.url, release.sha256, partPath);
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      } finally {
        fs.rmSync(partPath, { force: true });
      }
    }

    if (downloadedBuf === null) {
      throw lastError ?? new Error('Failed to download gateway update bundle');
    }

    ensureReleasesNodeModulesLink(this.dataDir, this.baseAppRoot);

    const stagingDir = path.join(stagingBase, `${release.version}-${randomBytes(6).toString('hex')}`);
    try {
      extractTarGzSafely(downloadedBuf, stagingDir);
      const manifest = this.readAndValidateManifest(stagingDir, release.version);

      if (manifest.baseCompatEpoch > this.baseCompatEpoch) {
        const reason = `baseCompatEpoch ${manifest.baseCompatEpoch} exceeds supported ${this.baseCompatEpoch}`;
        this.incompatibleVersion = release.version;
        this.incompatibleReason = reason;
        return { status: 'image-pull-required', version: release.version, reason };
      }
      if (manifest.minNodeMajor > this.nodeMajorVersion) {
        const reason = `minNodeMajor ${manifest.minNodeMajor} exceeds runtime Node ${this.nodeMajorVersion}`;
        this.incompatibleVersion = release.version;
        this.incompatibleReason = reason;
        return { status: 'image-pull-required', version: release.version, reason };
      }

      const indexHtmlPath = path.join(stagingDir, 'dist', 'public', 'index.html');
      if (!fs.existsSync(indexHtmlPath) || !fs.statSync(indexHtmlPath).isFile()) {
        throw new Error('Staged update bundle is missing dist/public/index.html');
      }

      const entryAbs = path.resolve(stagingDir, manifest.entry);
      const realStaging = fs.realpathSync(stagingDir);
      if (!fs.existsSync(entryAbs)) {
        throw new Error(`Staged update bundle entry not found: ${manifest.entry}`);
      }
      const realEntry = fs.realpathSync(entryAbs);
      if (!realEntry.startsWith(realStaging + path.sep)) {
        throw new Error(`Staged update entry escapes staging directory`);
      }

      await this.selfCheckRunner(realEntry, this.selfCheckTimeoutMs);

      const finalVersionDir = path.join(versionsDir, manifest.version);
      if (fs.existsSync(finalVersionDir)) {
        fs.rmSync(finalVersionDir, { recursive: true, force: true });
      }
      fs.renameSync(stagingDir, finalVersionDir);

      const prevState = readReleaseState(this.dataDir);
      const nextPreviousVersion = prevState.activeVersion ?? this.currentVersion ?? this.baseVersion;
      const nextPreviousEntry = prevState.activeEntry;
      const activeEntryRel = path.posix.join('versions', manifest.version, manifest.entry);

      const nextState: ReleaseState = {
        activeVersion: manifest.version,
        activeEntry: activeEntryRel,
        previousVersion: nextPreviousVersion,
        previousEntry: nextPreviousEntry,
        pendingVerify: true,
        baseVersionSeen: this.baseVersion,
        lastRollback: prevState.lastRollback,
      };
      writeReleaseState(this.dataDir, nextState);
      this.pruneOldVersions(versionsDir, new Set([manifest.version, ...(nextPreviousVersion ? [nextPreviousVersion] : [])]));

      this.incompatibleVersion = null;
      this.incompatibleReason = null;
      return { status: 'prepared', version: manifest.version, entry: activeEntryRel };
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  private async downloadAndVerifyCandidate(
    url: string,
    expectedSha256: string | null,
    partPath: string,
  ): Promise<Buffer> {
    const response = await this.fetchImpl(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'dsh-zen-remote-gateway' },
      signal: AbortSignal.timeout(this.downloadTimeoutMs),
    });
    if (!response.ok || response.body === null) {
      throw new Error(`Download failed from ${url}: HTTP ${response.status}`);
    }

    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const fd = fs.openSync(partPath, 'w', 0o600);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        totalBytes += buf.length;
        if (totalBytes > this.maxDownloadBytes) {
          throw new Error(`Update bundle exceeds ${this.maxDownloadBytes} byte limit`);
        }
        hash.update(buf);
        fs.writeSync(fd, buf);
        chunks.push(buf);
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    } finally {
      fs.closeSync(fd);
    }

    const actualDigest = hash.digest('hex');
    if (expectedSha256 !== null && actualDigest !== expectedSha256) {
      throw new Error(`SHA-256 digest mismatch for ${url}: expected ${expectedSha256}, got ${actualDigest}`);
    }
    return Buffer.concat(chunks);
  }

  private readAndValidateManifest(stagingDir: string, expectedVersion: string): ReleaseManifest {
    const manifestPath = path.join(stagingDir, 'release-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('Staged update bundle is missing release-manifest.json');
    }
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('Invalid release-manifest.json');
    }
    const schemaVersion = raw['schemaVersion'];
    const version = parseSemver(raw['version'])?.normalized ?? null;
    const baseCompatEpoch = raw['baseCompatEpoch'];
    const minNodeMajor = raw['minNodeMajor'];
    const entry = normalizeRelativeEntry(raw['entry']);

    if (
      schemaVersion !== 1 ||
      version !== expectedVersion ||
      typeof baseCompatEpoch !== 'number' ||
      !Number.isInteger(baseCompatEpoch) ||
      baseCompatEpoch < 1 ||
      typeof minNodeMajor !== 'number' ||
      !Number.isInteger(minNodeMajor) ||
      minNodeMajor < 1 ||
      entry === null
    ) {
      throw new Error(`Invalid release-manifest.json fields for version ${expectedVersion}`);
    }

    return {
      schemaVersion,
      version,
      baseCompatEpoch,
      minNodeMajor,
      entry,
      builtAt: typeof raw['builtAt'] === 'string' ? raw['builtAt'] : undefined,
    };
  }

  private pruneOldVersions(versionsDir: string, keepVersions: Set<string>): void {
    if (!fs.existsSync(versionsDir)) return;
    for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
      if (!keepVersions.has(entry.name)) {
        fs.rmSync(path.join(versionsDir, entry.name), { recursive: true, force: true });
      }
    }
  }
}

export interface AdminUpdateRuntimeSummary {
  currentVersion: string | null;
  baseVersion: string | null;
  activeSource: 'hot-update' | 'base';
  supervisorManaged: boolean;
  autoUpdateEnabled: boolean;
  updateAvailable: boolean;
  latestVersion: string | null;
  latestPluginVersion: string | null;
  compatibility: UpdateCompatibility;
  offlinePeerRecommendedVersion: string | null;
  rollbackReason: string | null;
}

export interface AdminUpdateView extends AdminUpdateRuntimeSummary {
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  incompatibilityReason: string | null;
  notesSummary: string | null;
  hasOfficialDigest: boolean;
  lastRollback: ReleaseRollbackRecord | null;
  upgradeCommand: string;
}

export interface ApplyUpdateOutcome {
  accepted: boolean;
  status: 'restarting' | 'up-to-date' | 'image-pull-required';
  version: string | null;
  reason?: string;
  upgradeCommand?: string;
}

export interface GatewayUpdateBridge {
  getRuntimeSummary(autoUpdateEnabled: boolean): AdminUpdateRuntimeSummary;
  getStatusView(autoUpdateEnabled: boolean): AdminUpdateView;
  checkNow(autoUpdateEnabled: boolean): Promise<AdminUpdateView>;
  applyNow(autoUpdateEnabled: boolean): Promise<ApplyUpdateOutcome>;
  dismissRollback(autoUpdateEnabled: boolean): AdminUpdateView;
}

export function createGatewayUpdateBridge(options: {
  updateManager: UpdateManager;
  supervisorManaged: boolean;
  activeSource: 'hot-update' | 'base';
  getOfflinePeerRecommendedVersion?: () => string | null;
  getHighestObservedPluginVersion?: () => string | null;
  onScheduleRestart?: () => void;
  restartDelayMs?: number;
}): GatewayUpdateBridge {
  const {
    updateManager,
    supervisorManaged,
    activeSource,
    getOfflinePeerRecommendedVersion,
    getHighestObservedPluginVersion,
    onScheduleRestart,
    restartDelayMs = 50,
  } = options;

  const getRuntimeSummary = (autoUpdateEnabled: boolean): AdminUpdateRuntimeSummary => {
    const state = updateManager.getState();
    const latestRelease = updateManager.getLatestRelease();
    const compat = updateManager.getCompatibilityForLatest();
    const latestPluginVersion = maxSemver(
      updateManager.getLatestPluginVersion(),
      getHighestObservedPluginVersion?.() ?? null,
    );
    return {
      currentVersion: updateManager.getCurrentVersion(),
      baseVersion: updateManager.getBaseVersion(),
      activeSource,
      supervisorManaged,
      autoUpdateEnabled,
      updateAvailable: updateManager.isUpdateAvailable(),
      latestVersion: latestRelease?.version ?? null,
      latestPluginVersion,
      compatibility: compat.compatibility,
      offlinePeerRecommendedVersion: getOfflinePeerRecommendedVersion?.() ?? null,
      rollbackReason: state.lastRollback?.reason ?? null,
    };
  };

  const getStatusView = (autoUpdateEnabled: boolean): AdminUpdateView => {
    const summary = getRuntimeSummary(autoUpdateEnabled);
    const state = updateManager.getState();
    const latestRelease = updateManager.getLatestRelease();
    const compat = updateManager.getCompatibilityForLatest();
    return {
      ...summary,
      lastCheckedAt: updateManager.getLastCheckedAt(),
      lastCheckError: updateManager.getLastCheckError(),
      incompatibilityReason: compat.reason,
      notesSummary: latestRelease?.notesSummary ?? null,
      hasOfficialDigest: latestRelease !== null && latestRelease.sha256 !== null,
      lastRollback: state.lastRollback,
      upgradeCommand: DOCKER_UPGRADE_COMMAND,
    };
  };

  return {
    getRuntimeSummary,
    getStatusView,
    async checkNow(autoUpdateEnabled: boolean): Promise<AdminUpdateView> {
      await updateManager.checkForUpdates();
      return getStatusView(autoUpdateEnabled);
    },
    async applyNow(): Promise<ApplyUpdateOutcome> {
      const prepared = await updateManager.prepareUpdate();
      if (prepared.status === 'up-to-date') {
        return { accepted: false, status: 'up-to-date', version: prepared.version };
      }
      if (prepared.status === 'image-pull-required') {
        return {
          accepted: false,
          status: 'image-pull-required',
          version: prepared.version,
          reason: prepared.reason,
          upgradeCommand: DOCKER_UPGRADE_COMMAND,
        };
      }
      if (onScheduleRestart !== undefined) {
        const timer = setTimeout(() => {
          onScheduleRestart();
        }, restartDelayMs);
        timer.unref?.();
      }
      return {
        accepted: true,
        status: 'restarting',
        version: prepared.version,
      };
    },
    dismissRollback(autoUpdateEnabled: boolean): AdminUpdateView {
      updateManager.dismissRollback();
      return getStatusView(autoUpdateEnabled);
    },
  };
}

export interface IdleAutoUpdateSchedulerOptions {
  updateManager: UpdateManager;
  supervisorManaged: boolean;
  isAutoUpdateEnabled: () => Promise<boolean> | boolean;
  getTotalLiveRelayKbps: () => number;
  onRestart: () => void;
  initialDelayMs?: number;
  checkIntervalMs?: number;
  idleConfirmDelayMs?: number;
}

export type IdleUpdateRunOutcome =
  | 'skipped-disabled'
  | 'up-to-date'
  | 'incompatible'
  | 'deferred-busy'
  | 'applied'
  | 'error';

export class IdleAutoUpdateScheduler {
  private readonly updateManager: UpdateManager;
  private readonly supervisorManaged: boolean;
  private readonly isAutoUpdateEnabled: () => Promise<boolean> | boolean;
  private readonly getTotalLiveRelayKbps: () => number;
  private readonly onRestart: () => void;
  private readonly initialDelayMs: number;
  private readonly checkIntervalMs: number;
  private readonly idleConfirmDelayMs: number;
  private initialTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight: Promise<IdleUpdateRunOutcome> | null = null;

  constructor(options: IdleAutoUpdateSchedulerOptions) {
    this.updateManager = options.updateManager;
    this.supervisorManaged = options.supervisorManaged;
    this.isAutoUpdateEnabled = options.isAutoUpdateEnabled;
    this.getTotalLiveRelayKbps = options.getTotalLiveRelayKbps;
    this.onRestart = options.onRestart;
    this.initialDelayMs = options.initialDelayMs ?? 30_000;
    this.checkIntervalMs = options.checkIntervalMs ?? 12 * 3_600_000;
    this.idleConfirmDelayMs = options.idleConfirmDelayMs ?? 5_000;
  }

  start(): void {
    if (this.stopped || this.timer !== null) return;
    if (this.initialTimer === null) {
      this.initialTimer = setTimeout(() => {
        this.initialTimer = null;
        void this.runOnce().catch(() => {});
      }, this.initialDelayMs);
      this.initialTimer.unref?.();
    }
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => {});
    }, this.checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.initialTimer !== null) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  runOnce(): Promise<IdleUpdateRunOutcome> {
    if (this.inFlight !== null) return this.inFlight;
    const run = this.doRunOnce().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async doRunOnce(): Promise<IdleUpdateRunOutcome> {
    if (this.stopped || !this.supervisorManaged) return 'skipped-disabled';
    if (!(await this.isAutoUpdateEnabled())) return 'skipped-disabled';

    try {
      const check = await this.updateManager.checkForUpdates();
      if (!check.updateAvailable) return 'up-to-date';
      if (check.compatibility !== 'compatible') return 'incompatible';
    } catch {
      return 'error';
    }

    if (this.stopped || this.getTotalLiveRelayKbps() > 0) return 'deferred-busy';
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.idleConfirmDelayMs);
      t.unref?.();
    });
    if (this.stopped) return 'skipped-disabled';
    if (!(await this.isAutoUpdateEnabled())) return 'skipped-disabled';
    if (this.getTotalLiveRelayKbps() > 0) return 'deferred-busy';

    try {
      const prepared = await this.updateManager.prepareUpdate();
      if (prepared.status === 'image-pull-required') return 'incompatible';
      if (prepared.status === 'up-to-date') return 'up-to-date';
      if (!this.stopped) this.onRestart();
      return 'applied';
    } catch {
      return 'error';
    }
  }
}
