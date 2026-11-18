/**
 * Pure version-comparison and coordination helpers for peer/gateway handshake.
 *
 * Zero Node or DOM dependencies so both host (`src/peer/engine.ts`) and
 * browser/shared client-data (`src/client-data/settings-form.ts`) can import
 * this module directly without hardcoding expected release versions.
 */
export const PEER_WIRE_COMPAT_LEVEL = 1;
/**
 * Fallback version assumed only when an already-welcomed gateway omitted the
 * `gatewayVersion` field (the initial `0.1.0` release before version handshake).
 */
export const INFERRED_LEGACY_GATEWAY_VERSION = '0.1.0';
const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIGITS_RE = /^\d+$/;
export function parseSemver(raw) {
    if (typeof raw !== 'string')
        return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > 64)
        return null;
    const match = SEMVER_RE.exec(trimmed);
    if (!match)
        return null;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
        return null;
    }
    const preRaw = match[4];
    const prerelease = [];
    if (preRaw !== undefined) {
        for (const part of preRaw.split('.')) {
            if (part.length === 0)
                return null;
            if (DIGITS_RE.test(part) && part.length > 1 && part.startsWith('0'))
                return null;
            prerelease.push(part);
        }
    }
    const base = `${major}.${minor}.${patch}`;
    const normalized = prerelease.length > 0 ? `${base}-${prerelease.join('.')}` : base;
    return { major, minor, patch, prerelease, normalized };
}
export function compareSemver(a, b) {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb)
        return 0;
    if (pa.major !== pb.major)
        return pa.major < pb.major ? -1 : 1;
    if (pa.minor !== pb.minor)
        return pa.minor < pb.minor ? -1 : 1;
    if (pa.patch !== pb.patch)
        return pa.patch < pb.patch ? -1 : 1;
    const aPre = pa.prerelease;
    const bPre = pb.prerelease;
    if (aPre.length === 0 && bPre.length === 0)
        return 0;
    if (aPre.length === 0)
        return 1;
    if (bPre.length === 0)
        return -1;
    const len = Math.min(aPre.length, bPre.length);
    for (let i = 0; i < len; i += 1) {
        const ai = aPre[i];
        const bi = bPre[i];
        if (ai === bi)
            continue;
        const aNum = DIGITS_RE.test(ai);
        const bNum = DIGITS_RE.test(bi);
        if (aNum && bNum) {
            const na = Number(ai);
            const nb = Number(bi);
            if (na !== nb)
                return na < nb ? -1 : 1;
        }
        else if (aNum !== bNum) {
            // SemVer 2.0.0: numeric identifiers always have lower precedence than non-numeric
            return aNum ? -1 : 1;
        }
        else {
            return ai < bi ? -1 : 1;
        }
    }
    if (aPre.length === bPre.length)
        return 0;
    return aPre.length < bPre.length ? -1 : 1;
}
export function maxSemver(...candidates) {
    let best = null;
    for (const raw of candidates) {
        const parsed = parseSemver(raw);
        if (!parsed)
            continue;
        if (best === null || compareSemver(parsed.normalized, best) > 0) {
            best = parsed.normalized;
        }
    }
    return best;
}
export function evaluatePeerVersionSync(input) {
    const selfPlugin = parseSemver(input.pluginVersion)?.normalized ?? input.pluginVersion;
    const recommendedGateway = parseSemver(input.recommendedGatewayVersion)?.normalized ?? input.recommendedGatewayVersion;
    const inferredLegacyGateway = input.gatewayVersion === null;
    const gatewayVersion = inferredLegacyGateway
        ? INFERRED_LEGACY_GATEWAY_VERSION
        : parseSemver(input.gatewayVersion)?.normalized ?? null;
    const gatewayOutdated = gatewayVersion !== null &&
        parseSemver(recommendedGateway) !== null &&
        compareSemver(gatewayVersion, recommendedGateway) < 0;
    const highestPlugin = maxSemver(input.recommendedPluginVersion, input.maxPeerPluginVersion);
    const selfParsed = parseSemver(selfPlugin);
    const pluginOutdated = selfParsed !== null && highestPlugin !== null && compareSemver(highestPlugin, selfParsed.normalized) > 0;
    const newerPluginVersion = pluginOutdated ? highestPlugin : null;
    const wireCompatLevel = typeof input.gatewayWireCompatLevel === 'number' && Number.isInteger(input.gatewayWireCompatLevel)
        ? input.gatewayWireCompatLevel
        : PEER_WIRE_COMPAT_LEVEL;
    return {
        pluginVersion: selfPlugin,
        gatewayVersion,
        recommendedGatewayVersion: recommendedGateway,
        wireCompatLevel,
        gatewayOutdated,
        pluginOutdated,
        newerPluginVersion,
        inferredLegacyGateway,
    };
}
export function sanitizeConsoleOrigin(gatewayHttpOrigin) {
    if (typeof gatewayHttpOrigin !== 'string')
        return null;
    const trimmed = gatewayHttpOrigin.trim();
    if (trimmed.length === 0)
        return null;
    try {
        const url = new URL(trimmed);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return null;
        if (!url.hostname || url.origin === 'null')
            return null;
        return url.origin;
    }
    catch {
        return null;
    }
}
export function versionDismissKey(kind, consoleOrigin, targetVersion) {
    const originPart = sanitizeConsoleOrigin(consoleOrigin) ?? 'global';
    const versionPart = parseSemver(targetVersion)?.normalized ?? targetVersion.trim();
    return `zr:version-dismiss:${kind}:${originPart}:${versionPart}`;
}
//# sourceMappingURL=version-sync.js.map