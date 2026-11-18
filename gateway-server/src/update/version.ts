/**
 * Zero-hardcoding semver parsing/comparison and dynamic package.json version reader
 * for gateway-server.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATEWAY_WIRE_COMPAT_LEVEL = 1;

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
  normalized: string;
}

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIGITS_RE = /^\d+$/;

export function parseSemver(raw: unknown): ParsedSemver | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  const match = SEMVER_RE.exec(trimmed);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }

  const preRaw = match[4];
  const prerelease: string[] = [];
  if (preRaw !== undefined) {
    for (const part of preRaw.split('.')) {
      if (part.length === 0) return null;
      if (DIGITS_RE.test(part) && part.length > 1 && part.startsWith('0')) return null;
      prerelease.push(part);
    }
  }

  const base = `${major}.${minor}.${patch}`;
  const normalized = prerelease.length > 0 ? `${base}-${prerelease.join('.')}` : base;
  return { major, minor, patch, prerelease, normalized };
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;

  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  const len = Math.min(aPre.length, bPre.length);
  for (let i = 0; i < len; i += 1) {
    const ai = aPre[i]!;
    const bi = bPre[i]!;
    if (ai === bi) continue;
    const aNum = DIGITS_RE.test(ai);
    const bNum = DIGITS_RE.test(bi);
    if (aNum && bNum) {
      const na = Number(ai);
      const nb = Number(bi);
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else {
      return ai < bi ? -1 : 1;
    }
  }

  if (aPre.length === bPre.length) return 0;
  return aPre.length < bPre.length ? -1 : 1;
}

export function maxSemver(...candidates: ReadonlyArray<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const raw of candidates) {
    const parsed = parseSemver(raw);
    if (!parsed) continue;
    if (best === null || compareSemver(parsed.normalized, best) > 0) {
      best = parsed.normalized;
    }
  }
  return best;
}

export function readPackageVersion(pkgPath: string): string | null {
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return parseSemver(parsed.version)?.normalized ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves the `<appRoot>/package.json` for the currently running gateway-server
 * bundle (works identically from `src/update/version.ts` and `dist/update/version.js`).
 */
export function resolveAppRootPackagePath(fromMetaUrl: string = import.meta.url): string {
  const dir = path.dirname(fileURLToPath(fromMetaUrl));
  return path.resolve(dir, '../../package.json');
}
