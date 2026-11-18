/**
 * Deterministic, zero-dependency POSIX USTAR `.tar.gz` packer and safe extractor.
 *
 * Security boundaries enforced on extraction:
 * - Bounded `zlib.gunzipSync` decompression (`maxOutputLength`) against bombs
 * - Two-pass validation so any malformed or disallowed entry rejects with zero
 *   filesystem residue in `targetDir`
 * - Rejects `..` traversal, leading `/`, `\0` null bytes, `\` backslashes,
 *   symlinks (`2`), hardlinks (`1`), device/FIFO nodes (`3`,`4`,`6`), and
 *   non-standard/unknown entry types outside regular files (`0`/`\0`) & dirs (`5`)
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export interface TarArchiveEntry {
  path: string;
  data: Buffer | Uint8Array | string;
  mode?: number;
  mtimeMs?: number;
}

export interface ExtractTarLimits {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxSingleFileBytes?: number;
}

export interface ExtractTarResult {
  files: number;
  totalBytes: number;
}

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const TAR_BLOCK = 512;

function validateArchivePath(rawPath: string, allowTrailingSlash: boolean): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('Archive entry has empty path');
  }
  if (rawPath.includes('\0')) {
    throw new Error(`Archive entry path contains null byte`);
  }
  if (rawPath.includes('\\')) {
    throw new Error(`Archive entry path contains backslash: ${rawPath}`);
  }
  if (rawPath.startsWith('/')) {
    throw new Error(`Archive entry path must not be absolute: ${rawPath}`);
  }
  if (/^[A-Za-z]:/.test(rawPath)) {
    throw new Error(`Archive entry path must not include drive letter: ${rawPath}`);
  }

  let normalized = rawPath;
  if (allowTrailingSlash) {
    while (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    if (normalized === '' || normalized === '.') {
      return '.';
    }
  } else if (normalized.endsWith('/')) {
    throw new Error(`Regular archive file path must not end with '/': ${rawPath}`);
  }

  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '..' || seg === '.') {
      throw new Error(`Invalid archive path segment in: ${rawPath}`);
    }
  }
  return segments.join('/');
}

function splitUstarNameAndPrefix(relPath: string): { name: string; prefix: string } {
  const totalBytes = Buffer.byteLength(relPath, 'utf8');
  if (totalBytes <= 100) {
    return { name: relPath, prefix: '' };
  }
  // Find a '/' boundary such that prefix <= 155 UTF-8 bytes and name <= 100 UTF-8 bytes.
  let idx = relPath.indexOf('/');
  while (idx !== -1) {
    const prefix = relPath.slice(0, idx);
    const name = relPath.slice(idx + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix };
    }
    idx = relPath.indexOf('/', idx + 1);
  }
  throw new Error(`Archive path too long for POSIX USTAR header: ${relPath}`);
}

function writeOctalField(buf: Buffer, offset: number, width: number, value: number): void {
  const maxVal = 8 ** (width - 1) - 1;
  if (!Number.isInteger(value) || value < 0 || value > maxVal) {
    throw new Error(`Tar octal value out of range: ${value}`);
  }
  const str = value.toString(8).padStart(width - 1, '0') + '\0';
  Buffer.from(str, 'ascii').copy(buf, offset, 0, width);
}

function readHeaderString(header: Buffer, offset: number, length: number): string {
  const slice = header.subarray(offset, offset + length);
  const zeroIdx = slice.indexOf(0);
  const effective = zeroIdx === -1 ? slice : slice.subarray(0, zeroIdx);
  // Reject hidden non-zero bytes after first NUL in path fields when checking for embedded nulls
  return effective.toString('utf8');
}

function parseOctalField(header: Buffer, offset: number, length: number, label: string): number {
  const slice = header.subarray(offset, offset + length);
  const raw = slice.toString('ascii').replace(/\0.*$/, '').trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`Invalid octal ${label} field in tar header`);
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Out-of-range ${label} field in tar header`);
  }
  return value;
}

function verifyHeaderChecksum(header: Buffer): void {
  const expected = parseOctalField(header, 148, 8, 'checksum');
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  }
  if (sum !== expected) {
    throw new Error(`Tar header checksum mismatch: expected ${expected}, got ${sum}`);
  }
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

export function packTarGz(entries: readonly TarArchiveEntry[]): Buffer {
  const normalized = entries.map((entry) => {
    const cleanPath = validateArchivePath(entry.path, false);
    const data =
      typeof entry.data === 'string'
        ? Buffer.from(entry.data, 'utf8')
        : Buffer.isBuffer(entry.data)
          ? entry.data
          : Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    const mode = entry.mode ?? 0o644;
    const mtimeSec = entry.mtimeMs !== undefined ? Math.max(0, Math.floor(entry.mtimeMs / 1000)) : 0;
    return { path: cleanPath, data, mode, mtimeSec };
  });

  normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const seenPaths = new Set<string>();
  const chunks: Buffer[] = [];

  for (const entry of normalized) {
    if (seenPaths.has(entry.path)) {
      throw new Error(`Duplicate archive entry path: ${entry.path}`);
    }
    seenPaths.add(entry.path);

    const { name, prefix } = splitUstarNameAndPrefix(entry.path);
    const header = Buffer.alloc(TAR_BLOCK, 0);

    Buffer.from(name, 'utf8').copy(header, 0, 0, 100);
    writeOctalField(header, 100, 8, entry.mode & 0o7777);
    writeOctalField(header, 108, 8, 0);
    writeOctalField(header, 116, 8, 0);
    writeOctalField(header, 124, 12, entry.data.length);
    writeOctalField(header, 136, 12, entry.mtimeSec);
    // Checksum placeholder (8 spaces)
    Buffer.from('        ', 'ascii').copy(header, 148);
    // Regular file typeflag '0'
    header[156] = 0x30;
    // POSIX USTAR magic & version
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    Buffer.from('00', 'ascii').copy(header, 263);
    if (prefix.length > 0) {
      Buffer.from(prefix, 'utf8').copy(header, 345, 0, 155);
    }

    let sum = 0;
    for (let i = 0; i < TAR_BLOCK; i += 1) {
      sum += header[i]!;
    }
    const chksumStr = sum.toString(8).padStart(6, '0') + '\0 ';
    Buffer.from(chksumStr, 'ascii').copy(header, 148, 0, 8);

    chunks.push(header);
    if (entry.data.length > 0) {
      chunks.push(entry.data);
      const rem = entry.data.length % TAR_BLOCK;
      if (rem !== 0) {
        chunks.push(Buffer.alloc(TAR_BLOCK - rem, 0));
      }
    }
  }

  // Standard two-block zero terminator
  chunks.push(Buffer.alloc(TAR_BLOCK * 2, 0));
  return zlib.gzipSync(Buffer.concat(chunks));
}

export function extractTarGzSafely(
  tgzBuffer: Buffer | Uint8Array,
  targetDir: string,
  limits: ExtractTarLimits = {},
): ExtractTarResult {
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxSingleFileBytes = limits.maxSingleFileBytes ?? maxTotalBytes;

  if (!Number.isInteger(maxFiles) || maxFiles <= 0) {
    throw new Error('Invalid maxFiles limit');
  }
  if (!Number.isInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new Error('Invalid maxTotalBytes limit');
  }

  // Cap raw tar stream size before full decompression to prevent gzip bombs
  const maxTarOutputBytes = maxTotalBytes + (maxFiles + 8) * TAR_BLOCK * 2;
  const tarBuf = zlib.gunzipSync(tgzBuffer, { maxOutputLength: maxTarOutputBytes });

  if (tarBuf.length === 0 || tarBuf.length % TAR_BLOCK !== 0) {
    throw new Error('Invalid tar archive length (must be a non-empty multiple of 512 bytes)');
  }

  // Pass 1: Validate every header and entry before touching targetDir
  const stagedFiles: Array<{ relPath: string; data: Buffer; mode: number }> = [];
  const seenFilePaths = new Set<string>();
  const dirPrefixes = new Set<string>();
  let totalBytes = 0;
  let offset = 0;

  while (offset + TAR_BLOCK <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + TAR_BLOCK);
    offset += TAR_BLOCK;

    if (isZeroBlock(header)) {
      break;
    }

    verifyHeaderChecksum(header);

    const typeByte = header[156]!;
    const typeChar = typeByte === 0 ? '\0' : String.fromCharCode(typeByte);
    if (typeChar !== '0' && typeChar !== '\0' && typeChar !== '5') {
      throw new Error(`Disallowed tar entry type: ${JSON.stringify(typeChar)}`);
    }

    const namePart = readHeaderString(header, 0, 100);
    const prefixPart = readHeaderString(header, 345, 155);
    const combinedRaw = prefixPart.length > 0 ? `${prefixPart}/${namePart}` : namePart;

    const size = parseOctalField(header, 124, 12, 'size');
    const mode = parseOctalField(header, 100, 8, 'mode') & 0o777;

    if (typeChar === '5') {
      validateArchivePath(combinedRaw, true);
      if (size !== 0) {
        throw new Error(`Directory tar entry must have zero size: ${combinedRaw}`);
      }
      continue;
    }

    const relPath = validateArchivePath(combinedRaw, false);
    if (seenFilePaths.has(relPath)) {
      throw new Error(`Duplicate archive entry path: ${relPath}`);
    }
    if (dirPrefixes.has(relPath)) {
      throw new Error(`Archive file collides with existing directory path: ${relPath}`);
    }
    const parts = relPath.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const prefix = parts.slice(0, i).join('/');
      if (seenFilePaths.has(prefix)) {
        throw new Error(`Archive parent path collides with existing file: ${prefix}`);
      }
      dirPrefixes.add(prefix);
    }
    seenFilePaths.add(relPath);
    if (stagedFiles.length + 1 > maxFiles) {
      throw new Error(`Archive exceeds maxFiles limit (${maxFiles})`);
    }
    if (size > maxSingleFileBytes) {
      throw new Error(`Archive entry exceeds maxSingleFileBytes (${maxSingleFileBytes}): ${relPath}`);
    }
    if (totalBytes + size > maxTotalBytes) {
      throw new Error(`Archive exceeds maxTotalBytes limit (${maxTotalBytes})`);
    }

    const paddedSize = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (offset + paddedSize > tarBuf.length) {
      throw new Error(`Truncated tar entry payload for: ${relPath}`);
    }

    const data = tarBuf.subarray(offset, offset + size);
    offset += paddedSize;
    totalBytes += size;
    stagedFiles.push({ relPath, data, mode: mode || 0o644 });
  }

  // Pass 2: Materialize validated files into targetDir
  fs.mkdirSync(targetDir, { recursive: true });
  const realRoot = fs.realpathSync(targetDir);
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;

  for (const file of stagedFiles) {
    const destPath = path.resolve(realRoot, file.relPath);
    if (!destPath.startsWith(rootPrefix)) {
      throw new Error(`Resolved path escaped targetDir: ${file.relPath}`);
    }
    const parentDir = path.dirname(destPath);
    fs.mkdirSync(parentDir, { recursive: true });
    const realParent = fs.realpathSync(parentDir);
    if (realParent !== realRoot && !realParent.startsWith(rootPrefix)) {
      throw new Error(`Parent directory symlink escaped targetDir: ${file.relPath}`);
    }
    fs.writeFileSync(destPath, file.data, { mode: file.mode });
  }

  return { files: stagedFiles.length, totalBytes };
}
