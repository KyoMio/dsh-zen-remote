/**
 * Pure version-comparison and coordination helpers for peer/gateway handshake.
 *
 * Zero Node or DOM dependencies so both host (`src/peer/engine.ts`) and
 * browser/shared client-data (`src/client-data/settings-form.ts`) can import
 * this module directly without hardcoding expected release versions.
 */
export declare const PEER_WIRE_COMPAT_LEVEL = 1;
/**
 * Fallback version assumed only when an already-welcomed gateway omitted the
 * `gatewayVersion` field (the initial `0.1.0` release before version handshake).
 */
export declare const INFERRED_LEGACY_GATEWAY_VERSION = "0.1.0";
export interface ParsedSemver {
    major: number;
    minor: number;
    patch: number;
    prerelease: readonly string[];
    normalized: string;
}
export interface EvaluatePeerVersionSyncInput {
    pluginVersion: string;
    recommendedGatewayVersion: string;
    gatewayVersion: string | null;
    recommendedPluginVersion?: string | null;
    maxPeerPluginVersion?: string | null;
    gatewayWireCompatLevel?: number | null;
}
export interface PeerVersionSyncEvaluation {
    pluginVersion: string;
    gatewayVersion: string | null;
    recommendedGatewayVersion: string;
    wireCompatLevel: number;
    gatewayOutdated: boolean;
    pluginOutdated: boolean;
    newerPluginVersion: string | null;
    inferredLegacyGateway: boolean;
}
export declare function parseSemver(raw: unknown): ParsedSemver | null;
export declare function compareSemver(a: string, b: string): -1 | 0 | 1;
export declare function maxSemver(...candidates: ReadonlyArray<string | null | undefined>): string | null;
export declare function evaluatePeerVersionSync(input: EvaluatePeerVersionSyncInput): PeerVersionSyncEvaluation;
export declare function sanitizeConsoleOrigin(gatewayHttpOrigin: string): string | null;
export declare function versionDismissKey(kind: 'gateway' | 'plugin', consoleOrigin: string, targetVersion: string): string;
//# sourceMappingURL=version-sync.d.ts.map