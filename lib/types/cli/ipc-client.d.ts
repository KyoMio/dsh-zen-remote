/**
 * CLI-2 IPC client: the CLI half of the local control channel that
 * `src/cli/ipc-server.ts` serves inside the DSH plugin process. Discovery
 * walks the same candidate socket paths the server binds (or a single
 * explicit `--socket` path), pings each existing one with a short 200ms
 * budget, and sorts the answers into three buckets the command layer can
 * speak about: LIVE instances whose `cliProtocolVersion` matches, sockets
 * speaking a DIFFERENT protocol version (the upgrade-prompt case), and paths
 * that refused us with EACCES / EPERM (the "DSH runs as another user, try
 * `sudo -E`" case).
 *
 * The request helper is a thin http-over-Unix-socket (Windows: named pipe)
 * round trip. Transport errors REJECT — a dead socket is a real failure the
 * caller must see — while HTTP error statuses resolve normally: the IPC
 * protocol answers every failure as JSON (`{ ok: false, error: … }`), so a
 * 409 wrong-role or 409 env-shadowed is data, not an exception.
 */
import type { IncomingHttpHeaders } from 'node:http';
/** What a live plugin instance answers `GET /ping` with. Mirrors the body
 * `src/cli/ipc-server.ts` builds (minus `ok`). */
export interface CliPingResponse {
    ok: true;
    cliProtocolVersion: number;
    pluginVersion: string;
    pid: number;
    role: 'host' | 'client' | 'peer';
    serves: boolean;
    connects: boolean;
    serverName: string;
    profileName?: string;
}
export type DiscoveredLive = CliPingResponse & {
    socketPath: string;
};
export interface DiscoveredSockets {
    /** Version-matching live instances, one entry per answering socket. */
    live: DiscoveredLive[];
    /** Sockets that answered but speak another `cliProtocolVersion`. */
    versionMismatch: {
        socketPath: string;
        cliProtocolVersion: number | undefined;
    }[];
    /** Paths that refused the probe (or even the stat) with EACCES / EPERM —
     * the cross-user DSH case. */
    permissionDenied: string[];
}
export interface DiscoverCliSocketsOptions {
    dshHome: string;
    /** Probe ONLY this path instead of the candidate walk. */
    explicitSocket?: string;
    /** Bind-shape override (tests pin both platforms). */
    platform?: NodeJS.Platform;
}
export interface CliIpcRequestResult {
    status: number;
    body: unknown;
    headers: IncomingHttpHeaders;
}
export interface CliIpcClient {
    readonly socketPath: string;
    ping(): Promise<CliPingResponse>;
    getStatus(): Promise<unknown>;
    getDebugReport(): Promise<unknown>;
    writeConfig(input: {
        set?: Record<string, unknown>;
        unset?: readonly string[];
    }): Promise<CliIpcRequestResult>;
    request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<CliIpcRequestResult>;
}
/**
 * Walk the CLI socket candidates under `dshHome` (or only `explicitSocket`)
 * and classify every answering socket. Absent candidates are skipped without
 * a probe; a dead file that merely squats a candidate name simply answers
 * nothing and lands nowhere.
 */
export declare function discoverCliSockets(options: DiscoverCliSocketsOptions): Promise<DiscoveredSockets>;
/**
 * A client bound to one socket path. `request` is the generic escape hatch
 * for routes added in later CLI phases; the named methods cover the routes
 * this phase already drives.
 */
export declare function createCliIpcClient(socketPath: string): CliIpcClient;
//# sourceMappingURL=ipc-client.d.ts.map