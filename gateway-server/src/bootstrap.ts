/**
 * PID 1 supervisor for gateway-server container hot updates.
 *
 * Responsibilities:
 * - "Newer wins" startup selection: compares `<baseAppDir>/package.json#version`
 *   against `<dataDir>/releases/state.json#activeVersion`; if the container image
 *   was upgraded (`baseVersion >= activeVersion`), drops stale hot updates and
 *   boots the base image.
 * - Spawns the active gateway bundle with Node IPC enabled.
 * - Exit code 75 (`UPDATE_RESTART_EXIT_CODE`) reloads `state.json` and launches
 *   the newly staged version in < 1s without exiting PID 1.
 * - Health verification window (`verifyTimeoutMs`, default 15,000ms): when
 *   `pendingVerify === true`, requires `{ type: 'zr-gateway-ready' }` within
 *   the window; timeout or premature crash triggers automatic rollback to
 *   `previousVersion` (or base image) with sanitized `lastRollback` persisted.
 * - Forwards `SIGTERM` / `SIGINT` cleanly to the active child.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ensureReleasesNodeModulesLink,
  readReleaseState,
  releasesRootDir,
  writeReleaseState,
} from './update/update-manager.js';
import type { ReleaseState } from './update/update-manager.js';
import { compareSemver, readPackageVersion } from './update/version.js';

export const UPDATE_RESTART_EXIT_CODE = 75;
const DEFAULT_VERIFY_TIMEOUT_MS = 15_000;

export interface BootstrapSupervisorOptions {
  dataDir?: string;
  baseAppDir?: string;
  verifyTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signalTarget?: NodeJS.EventEmitter;
}

interface LaunchTarget {
  source: 'hot-update' | 'base';
  version: string;
  entryPath: string;
  state: ReleaseState;
}

function pruneVersionsBelowOrEqual(dataDir: string, baseVersion: string): void {
  const versionsDir = path.join(releasesRootDir(dataDir), 'versions');
  if (!fs.existsSync(versionsDir)) return;
  for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
    if (compareSemver(entry.name, baseVersion) <= 0) {
      fs.rmSync(path.join(versionsDir, entry.name), { recursive: true, force: true });
    }
  }
}

function resolveLaunchTarget(dataDir: string, baseAppDir: string, baseVersion: string): LaunchTarget {
  const baseEntry = path.join(baseAppDir, 'dist', 'main.js');
  const state = readReleaseState(dataDir);
  const relRoot = releasesRootDir(dataDir);

  if (
    state.activeVersion !== null &&
    state.activeEntry !== null &&
    compareSemver(state.activeVersion, baseVersion) > 0
  ) {
    const candidate = path.resolve(relRoot, state.activeEntry);
    if (fs.existsSync(candidate)) {
      const realRoot = fs.realpathSync(relRoot);
      const realCandidate = fs.realpathSync(candidate);
      if (realCandidate.startsWith(realRoot + path.sep)) {
        if (fs.existsSync(path.join(baseAppDir, 'node_modules'))) {
          ensureReleasesNodeModulesLink(dataDir, baseAppDir);
        }
        return {
          source: 'hot-update',
          version: state.activeVersion,
          entryPath: realCandidate,
          state,
        };
      }
    }
  }

  // Base image is newer or equal, or hot-update entry is missing: switch back to base
  const needsReset =
    state.activeVersion !== null ||
    state.activeEntry !== null ||
    state.pendingVerify ||
    state.baseVersionSeen !== baseVersion;
  let nextState = state;
  if (needsReset) {
    nextState = {
      ...state,
      activeVersion: null,
      activeEntry: null,
      previousVersion: null,
      previousEntry: null,
      pendingVerify: false,
      baseVersionSeen: baseVersion,
    };
    writeReleaseState(dataDir, nextState);
    pruneVersionsBelowOrEqual(dataDir, baseVersion);
  }
  return {
    source: 'base',
    version: baseVersion,
    entryPath: baseEntry,
    state: nextState,
  };
}

function performRollback(
  dataDir: string,
  baseAppDir: string,
  failedVersion: string,
  reason: string,
  baseVersion: string,
): void {
  const prev = readReleaseState(dataDir);
  const relRoot = releasesRootDir(dataDir);

  let nextActiveVersion: string | null = null;
  let nextActiveEntry: string | null = null;
  let rolledBackTo = baseVersion;

  if (
    prev.previousVersion !== null &&
    prev.previousEntry !== null &&
    compareSemver(prev.previousVersion, baseVersion) > 0
  ) {
    const candidate = path.resolve(relRoot, prev.previousEntry);
    if (fs.existsSync(candidate)) {
      const realRoot = fs.realpathSync(relRoot);
      const realCandidate = fs.realpathSync(candidate);
      if (realCandidate.startsWith(realRoot + path.sep)) {
        nextActiveVersion = prev.previousVersion;
        nextActiveEntry = prev.previousEntry;
        rolledBackTo = prev.previousVersion;
      }
    }
  }

  const nextState: ReleaseState = {
    activeVersion: nextActiveVersion,
    activeEntry: nextActiveEntry,
    previousVersion: null,
    previousEntry: null,
    pendingVerify: false,
    baseVersionSeen: baseVersion,
    lastRollback: {
      failedVersion,
      rolledBackTo,
      reason: reason.slice(0, 200),
      at: new Date().toISOString(),
    },
  };
  writeReleaseState(dataDir, nextState);
  console.error(
    `[bootstrap] rolled back failed update ${failedVersion} -> ${rolledBackTo} (${nextState.lastRollback?.reason})`,
  );
}

export async function runBootstrapSupervisor(options: BootstrapSupervisorOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? env['ZR_GATEWAY_DATA_DIR'] ?? './data';
  const baseAppDir =
    options.baseAppDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const signalTarget = options.signalTarget ?? process;

  const baseVersion = readPackageVersion(path.join(baseAppDir, 'package.json')) ?? '0.0.0';
  let shuttingDown = false;
  let activeChild: ChildProcess | null = null;

  const onSignal = (sig: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const child = activeChild;
    if (child !== null) {
      try {
        child.send?.({ type: 'zr-shutdown' });
      } catch {
        /* ignore */
      }
      try {
        child.kill(sig);
      } catch {
        /* ignore */
      }
    }
  };
  const onSigTerm = (): void => onSignal('SIGTERM');
  const onSigInt = (): void => onSignal('SIGINT');
  signalTarget.on('SIGTERM', onSigTerm);
  signalTarget.on('SIGINT', onSigInt);

  try {
    for (;;) {
      if (shuttingDown) return 0;

      const target = resolveLaunchTarget(dataDir, baseAppDir, baseVersion);
      const childEnv: NodeJS.ProcessEnv = {
        ...env,
        ZR_GATEWAY_DATA_DIR: dataDir,
        ZR_GATEWAY_SUPERVISED: '1',
        ZR_GATEWAY_ACTIVE_SOURCE: target.source,
        ZR_GATEWAY_BASE_VERSION: baseVersion,
      };

      const outcome = await new Promise<{ kind: 'exit'; code: number | null; signal: NodeJS.Signals | null; verified: boolean; timedOut: boolean }>((resolve) => {
        const child = spawn(process.execPath, ['--experimental-sqlite', target.entryPath], {
          stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
          env: childEnv,
        });
        activeChild = child;

        let verified = !(target.source === 'hot-update' && target.state.pendingVerify);
        let timedOut = false;
        let verifyTimer: NodeJS.Timeout | null = null;

        const clearTimer = (): void => {
          if (verifyTimer !== null) {
            clearTimeout(verifyTimer);
            verifyTimer = null;
          }
        };

        if (!verified) {
          verifyTimer = setTimeout(() => {
            if (verified || shuttingDown) return;
            timedOut = true;
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }, verifyTimeoutMs);
          verifyTimer.unref?.();
        }

        child.on('message', (msg: unknown) => {
          if (typeof msg !== 'object' || msg === null) return;
          if ((msg as { type?: unknown }).type === 'zr-gateway-ready') {
            if (!verified && !timedOut) {
              verified = true;
              clearTimer();
              const latest = readReleaseState(dataDir);
              if (latest.pendingVerify && latest.activeVersion === target.version) {
                writeReleaseState(dataDir, { ...latest, pendingVerify: false });
              }
            }
          }
        });

        child.once('exit', (code, signal) => {
          clearTimer();
          if (activeChild === child) activeChild = null;
          resolve({ kind: 'exit', code, signal, verified, timedOut });
        });

        child.once('error', () => {
          clearTimer();
          if (activeChild === child) activeChild = null;
          resolve({ kind: 'exit', code: 1, signal: null, verified, timedOut });
        });
      });

      if (shuttingDown) {
        return 0;
      }

      if (target.source === 'hot-update' && !outcome.verified) {
        const reason = outcome.timedOut
          ? `startup health check timed out after ${verifyTimeoutMs}ms`
          : `exited before ready (code=${outcome.code ?? 'null'}, signal=${outcome.signal ?? 'null'})`;
        performRollback(dataDir, baseAppDir, target.version, reason, baseVersion);
        continue;
      }

      if (outcome.code === UPDATE_RESTART_EXIT_CODE) {
        continue;
      }

      return outcome.code ?? (outcome.signal ? 1 : 0);
    }
  } finally {
    signalTarget.off('SIGTERM', onSigTerm);
    signalTarget.off('SIGINT', onSigInt);
  }
}

const entry = process.argv[1] !== undefined ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  void runBootstrapSupervisor().then((code) => process.exit(code));
}
