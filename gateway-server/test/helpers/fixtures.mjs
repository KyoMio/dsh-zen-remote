import { execFileSync } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hashPassword } from '../../dist/master-key.js';

export const ADMIN_EMAIL = 'admin@local';
export const ADMIN_PASSWORD = 'admin-pass-1234';
export const TENANT_EMAIL = 'tenant@local';
export const TENANT_PASSWORD = 'tenant-pass-1234';

// Precomputed once per worker process so tests never re-run scrypt for fixture setup.
export const ADMIN_HASH = await hashPassword(ADMIN_PASSWORD);
export const TENANT_HASH = await hashPassword(TENANT_PASSWORD);

export function makeTmpDir(prefix = 'zr-gw-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function seedSession(
  store,
  {
    email = TENANT_EMAIL,
    role = 'user',
    passwordHash = role === 'admin' ? ADMIN_HASH : TENANT_HASH,
    ttlMs = 7 * 86_400_000,
  } = {},
) {
  let user = await store.findUserByEmail(email);
  if (user === null) {
    user = await store.createUser({ email, passwordHash, role });
  }
  const issued = await store.createSession(user.id, ttlMs);
  return { user, token: issued.token, cookie: `zr_gw_session=${issued.token}` };
}

let cachedTlsPair = null;

/** Lazily generates and caches one self-signed RSA 2048 cert/key pair (SAN localhost + 127.0.0.1). */
export function getTestTlsPair() {
  if (cachedTlsPair !== null) return cachedTlsPair;
  const dir = makeTmpDir('zr-gw-cert-');
  try {
    const conf = path.join(dir, 'san.cnf');
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    fs.writeFileSync(
      conf,
      [
        '[req]',
        'prompt = no',
        'distinguished_name = dn',
        'x509_extensions = ext',
        '[dn]',
        'CN = localhost',
        '[ext]',
        'subjectAltName = DNS:localhost,IP:127.0.0.1',
      ].join('\n'),
    );
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-sha256', '-config', conf, '-keyout', keyPath, '-out', certPath],
      { stdio: 'ignore' },
    );
    cachedTlsPair = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
    return cachedTlsPair;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function reserveUdpPort() {
  const sock = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(0, '127.0.0.1', () => {
      sock.removeAllListeners('error');
      resolve();
    });
  });
  const port = sock.address().port;
  await new Promise((resolve) => sock.close(() => resolve()));
  return port;
}

export async function waitFor(predicate, label = 'condition', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!(await predicate())) {
    throw new Error(`waitFor timeout (${timeoutMs}ms): ${label}`);
  }
}
