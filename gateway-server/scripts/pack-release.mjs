#!/usr/bin/env node
/**
 * Pack compiled gateway-server artifacts into a deterministic POSIX USTAR
 * `.tar.gz` bundle (`zen-remote-gateway-bundle.tar.gz`) containing:
 *   - release-manifest.json
 *   - package.json
 *   - dist/**
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packTarGz } from '../dist/update/archive.js';
import { CURRENT_BASE_COMPAT_EPOCH } from '../dist/update/update-manager.js';

const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseOutArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) {
      return path.resolve(argv[i + 1]);
    }
  }
  return path.join(gatewayRoot, 'dist-bundle', 'zen-remote-gateway-bundle.tar.gz');
}

function collectFiles(dirAbs, relPrefix, out) {
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const abs = path.join(dirAbs, entry.name);
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      collectFiles(abs, rel, out);
    } else if (entry.isFile()) {
      const mode = (fs.statSync(abs).mode & 0o777) || 0o644;
      out.push({ path: rel, data: fs.readFileSync(abs), mode });
    }
  }
}

const outPath = parseOutArg(process.argv.slice(2));
const pkgRaw = fs.readFileSync(path.join(gatewayRoot, 'package.json'), 'utf8');
const pkg = JSON.parse(pkgRaw);
const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
if (!version) {
  throw new Error('gateway-server/package.json#version is missing');
}

const distDir = path.join(gatewayRoot, 'dist');
if (!fs.existsSync(path.join(distDir, 'main.js')) || !fs.existsSync(path.join(distDir, 'public', 'index.html'))) {
  throw new Error('gateway-server/dist is incomplete — run `pnpm --dir gateway-server build` first');
}

const manifest = {
  schemaVersion: 1,
  version,
  baseCompatEpoch: CURRENT_BASE_COMPAT_EPOCH,
  minNodeMajor: 22,
  entry: 'dist/main.js',
  builtAt: new Date().toISOString(),
};

const entries = [
  { path: 'package.json', data: pkgRaw, mode: 0o644 },
  { path: 'release-manifest.json', data: JSON.stringify(manifest, null, 2) + '\n', mode: 0o644 },
];
collectFiles(distDir, 'dist', entries);

const tgz = packTarGz(entries);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, tgz);

const sha256 = createHash('sha256').update(tgz).digest('hex');
console.log(`packed ${outPath} (${tgz.length} bytes, sha256=${sha256}, entries=${entries.length})`);
