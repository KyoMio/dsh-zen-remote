import type { ClientContext } from '../compat/types.ts';
interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}
export interface LegacyGatewayPromptOptions {
    probeRole?: () => Promise<'host' | 'client' | 'peer' | undefined>;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<{
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
    }>;
    doc?: Pick<Document, 'head' | 'body' | 'createElement'>;
    sessionStore?: StorageLike | null;
    localStore?: StorageLike | null;
    isViaGateway?: () => boolean;
    retryDelaysMs?: readonly number[];
}
/**
 * Mounts a one-time upgrade guidance modal when `role === 'peer'` connects to a
 * legacy `0.1.0` gateway that lacks hot-update support. Silent on `host`,
 * `client`, `via-gateway`, and `>= 0.2.0` gateways.
 * Must be registered before the `isDesktopShell()` gate in `src/client/index.tsx`.
 */
export declare function mountLegacyGatewayUpgradePrompt(ctx: ClientContext, options?: LegacyGatewayPromptOptions): void;
export {};
//# sourceMappingURL=legacy-gateway-prompt.d.ts.map