/**
 * Wizard token storage (GW-13a): the secrets that must never enter the
 * plugin row or any wire response live as 0600 files under
 * `<DSH_HOME>/zen-remote-ingress/`, written through a temp-file rename so
 * a crash mid-write can never leave a half token at the real path. The
 * tunnel-token half lives in cloudflared.ts (it is the cloudflared
 * process's own input); this module owns the shared Cloudflare API token.
 *
 * Reads answer presence or hand the raw string ONLY to in-process callers
 * (the Caddy manager's env) — nothing here is ever logged or serialized
 * into a response.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ingressDir } from './binary.js'

/** `<DSH_HOME>/zen-remote-ingress/cf-api-token`. */
export function cfTokenPath(dshHome: string): string {
  return join(ingressDir(dshHome), 'cf-api-token')
}

/** Atomic 0600 write (temp sibling + rename), mirroring writeTunnelTokenFile. */
export function writeCfTokenFile(dshHome: string, token: string): string {
  const finalPath = cfTokenPath(dshHome)
  const partPath = `${finalPath}.part`
  try {
    mkdirSync(ingressDir(dshHome), { recursive: true })
    writeFileSync(partPath, token, { mode: 0o600 })
    renameSync(partPath, finalPath)
  } catch (error) {
    rmSync(partPath, { force: true })
    throw error
  }
  return finalPath
}

/** The stored token, or undefined when absent/empty. Callers feed it to the
 * Caddy manager's environment; it must never reach a response or a log. */
export function readCfTokenFile(dshHome: string): string | undefined {
  try {
    const token = readRaw(dshHome)
    return token.trim() === '' ? undefined : token
  } catch {
    return undefined
  }
}

/** Whether a non-empty token file exists (the projection's boolean only). */
export function cfTokenConfigured(dshHome: string): boolean {
  try {
    return statSync(cfTokenPath(dshHome)).isFile() && readRaw(dshHome).trim() !== ''
  } catch {
    return false
  }
}

/** Delete the stored token (the DELETE route; callers stop the processes
 * that consume it first). */
export function deleteCfTokenFile(dshHome: string): void {
  rmSync(cfTokenPath(dshHome), { force: true })
}

function readRaw(dshHome: string): string {
  return readFileSync(cfTokenPath(dshHome), 'utf8')
}
