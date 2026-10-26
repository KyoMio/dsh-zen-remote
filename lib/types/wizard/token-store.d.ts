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
/** `<DSH_HOME>/zen-remote-ingress/cf-api-token`. */
export declare function cfTokenPath(dshHome: string): string;
/** Atomic 0600 write (temp sibling + rename), with a direct-write fallback
 * on Windows if an existing file or antivirus scan refuses `renameSync` with
 * EPERM/EACCES. */
export declare function writeCfTokenFile(dshHome: string, token: string): string;
/** The stored token, or undefined when absent/empty. Callers feed it to the
 * Caddy manager's environment; it must never reach a response or a log. */
export declare function readCfTokenFile(dshHome: string): string | undefined;
/** Whether a non-empty token file exists (the projection's boolean only). */
export declare function cfTokenConfigured(dshHome: string): boolean;
/** Delete the stored token (the DELETE route; callers stop the processes
 * that consume it first). */
export declare function deleteCfTokenFile(dshHome: string): void;
//# sourceMappingURL=token-store.d.ts.map