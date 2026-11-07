/**
 * The CLI's local IPC control server (CLI-1): a small HTTP server over a
 * 0600 Unix domain socket (`<dshHome>/zen-remote-cli.sock`, Windows: a named
 * pipe), owned by the DSH plugin process. Every DSH `webServer` route sits
 * behind signed-cookie auth, and the pieces the CLI must drive (the relay
 * pool, the managed Caddy / cloudflared children, the wizard state) follow
 * the plugin's single-in-process-owner discipline — so the CLI talks to THIS
 * process over THIS socket instead of a second entry point. Same user, same
 * machine: the 0600 socket IS the authentication.
 *
 * Lifecycle: the server is module-level (one per process, per dshHome). A
 * plugin row reload — including the role flips `restart-watcher` triggers —
 * re-acquires it and swaps the request DELEGATE in place; the underlying
 * socket never unbinds, so a CLI session survives every reload. When the
 * last owning row released it and a short grace period passes without a new
 * acquire, the server closes and the socket file is removed (the grace
 * covers the cordis dispose order, where the OLD row's disposer runs after
 * the NEW row's apply — a plain refcount would tear down between them).
 *
 * The wiring side (src/index.ts) folds the acquire/release into the existing
 * `'dsh-zen-remote: restart watcher'` effect on purpose: test/
 * role-wiring.test.cjs pins the exact number of top-level `ctx.effect`
 * registrations per role, so the IPC lifecycle may not add one.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ZenRemoteConfig } from '../config.js';
/** The CLI protocol's major version. A client asking for a different one is
 * talking to a build it cannot drive (SPEC: refuse and tell the user to
 * upgrade the plugin). */
export declare const CLI_PROTOCOL_VERSION = 1;
/** The protocol handshake route. */
export declare const CLI_PING_ROUTE = "/_dsh/zen-remote/cli/ping";
/** The config-write route (POST `{set, unset}` → the anti-shadowing writer). */
export declare const CLI_CONFIG_ROUTE = "/_dsh/zen-remote/cli/config";
/** Socket file / pipe basename: `zen-remote-cli.sock`, `-2.sock`, … */
export declare const CLI_SOCKET_BASENAME = "zen-remote-cli";
/** How long a fully-released IPC server waits for a re-acquire (the hot
 * reload window: cordis runs the OLD row's disposer AFTER the new apply, so
 * refcount 0 is momentary during every reload). Exported for tests. */
export declare const CLI_CLOSE_GRACE_MS = 250;
/**
 * The bind candidates, in backoff order: `<dshHome>/zen-remote-cli.sock`,
 * then `-2.sock` … `-8.sock` (two DSH instances on one machine — a web
 * profile and a headless one — each get their own channel). Windows has no
 * filesystem sockets: named pipes under the package's pipe name
 * `dsh-zen-remote-cli` with the same numbering.
 */
export declare function candidateSocketPaths(dshHome: string, platform?: NodeJS.Platform): string[];
/** One role-gated handler set the IPC server forwards to — the row-scoped
 * closures src/index.ts builds per apply (per role branch). */
export interface CliIpcDelegate {
    /** The CURRENT effective role, re-read per request (a volatile row field). */
    role(): 'host' | 'client' | 'peer';
    /** The row's display name (this device's name on a client). */
    serverName(): string;
    /** The profile context's name, when the composition has one. */
    profileName(): string | undefined;
    /** This package's version, for the handshake header and ping body. */
    pluginVersion(): string;
    /** The anti-shadowing config write (src/cli/config-writer.ts, wired with
     * the row object and the restart watcher's checkNow). */
    writeConfig(input: {
        set?: Record<string, unknown>;
        unset?: readonly string[];
    }): {
        ok: true;
        values: ZenRemoteConfig;
    } | {
        ok: false;
        code: 'env-shadowed';
        field: string;
        envVar: string;
    };
    /** Host-role handler sets; absent means the composition never built them
     * (the wrong-role gate answers before any consumer reaches here). */
    wizardHandler?: CliRouteHandler | undefined;
    adminHandler?: CliRouteHandler | undefined;
    /** Both roles mount a client handler (remote-status / debug-report are
     * role-agnostic); the wrong-role gate covers the pairing routes. */
    clientHandler?: CliRouteHandler | undefined;
}
export type CliRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export interface CliIpcServerOptions {
    dshHome: string;
    delegate: CliIpcDelegate;
    /** Bind-shape override (tests pin both platforms' candidate lists). */
    platform?: NodeJS.Platform;
}
export interface CliIpcServer {
    /** The candidate path this instance actually bound. */
    readonly socketPath: string;
    /** Hot reload: replace the delegate without touching the socket. */
    swapDelegate(delegate: CliIpcDelegate): void;
    /** Close the server, clean the socket file, and answer once drained. */
    close(): Promise<void>;
}
/**
 * Bind one CLI IPC server: walk the candidate paths, probing occupied files
 * for a live owner (skip those), cleaning stale ones, and answering with the
 * bound handle. Throws when every candidate is taken by a live instance.
 */
export declare function createCliIpcServer(options: CliIpcServerOptions): Promise<CliIpcServer>;
/**
 * Acquire (or hot-swap into) this process's IPC server for `dshHome`.
 * Synchronous on purpose: apply() runs inside cordis and cannot await. The
 * returned handle's `release()` is the row disposer; a release that hits
 * refcount 0 closes the server after {@link CLI_CLOSE_GRACE_MS} unless a new
 * row acquires first.
 */
export declare function acquireCliIpcServer(dshHome: string, delegate: CliIpcDelegate): {
    release(): void;
};
//# sourceMappingURL=ipc-server.d.ts.map