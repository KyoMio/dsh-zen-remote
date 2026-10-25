/**
 * Caddyfile generation (GW-3), pure logic — every byte the managed Caddy
 * will run comes out of {@link generateCaddyfile}, so the validation and
 * the injection guards live HERE and the process half (caddy-process.ts)
 * only writes, validates and spawns what this answered.
 *
 * Shape (design.md 路 A), with one deliberate correction to the design
 * sketch: the global DNS-01 option in a real Caddyfile is `acme_dns
 * <provider> <token-placeholder>` — the sketch's bare `dns cloudflare`
 * line is site-block `tls` syntax and is not valid as a global option.
 * The DNS-01 challenge itself is the point: the certificate is ordered
 * through Cloudflare's API (the token rides the `CF_API_TOKEN`
 * environment variable, never the file), so neither 80 nor 443 needs to
 * be reachable from outside for issuance; only the HTTPS service port
 * must be.
 *
 * Injection posture: every interpolated value passes a charset gate —
 * the domain through config.ts's `hostOf` (the exact validator the row
 * layer applies), the storage path free of control characters, quotes and
 * braces (Caddyfile's block delimiters), the env-var name as a legal
 * POSIX name. Nothing else from the outside world reaches the output.
 */
import { hostOf } from '../config.js';
/** The default environment variable the Cloudflare token rides in on. */
export const CF_TOKEN_ENV_DEFAULT = 'CF_API_TOKEN';
/** Integers in [1, 65535] only. */
function portOf(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : undefined;
}
/** Storage paths go into the Caddyfile quoted; anything that could break
 * out of the quoting or forge a block delimiter is refused — control
 * characters (newlines foremost), quotes, braces. */
function storageDirOf(value) {
    if (typeof value !== 'string' || value === '')
        return undefined;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f"{}]/.test(value))
        return undefined;
    return value;
}
/** Env names: POSIX uppercase convention, strictly. */
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
/**
 * Build the complete Caddyfile for the managed Caddy. Refuses (typed)
 * instead of throwing so the caller can map each refusal to a form error.
 */
export function generateCaddyfile(input) {
    const domain = hostOf(input.domain);
    if (domain === undefined)
        return { ok: false, error: 'bad-domain' };
    const httpsPort = portOf(input.httpsPort);
    if (httpsPort === undefined)
        return { ok: false, error: 'bad-https-port' };
    const gatewayPort = portOf(input.gatewayPort);
    if (gatewayPort === undefined)
        return { ok: false, error: 'bad-gateway-port' };
    const storageDir = storageDirOf(input.storageDir);
    if (storageDir === undefined)
        return { ok: false, error: 'bad-storage' };
    const tokenEnv = typeof input.cfTokenEnvName === 'string' && ENV_NAME_PATTERN.test(input.cfTokenEnvName)
        ? input.cfTokenEnvName
        : CF_TOKEN_ENV_DEFAULT;
    if (input.cfTokenEnvName !== undefined && input.cfTokenEnvName !== '' && tokenEnv !== input.cfTokenEnvName) {
        return { ok: false, error: 'bad-token-env' };
    }
    const caddyfile = [
        '{',
        `\tacme_dns cloudflare {env.${tokenEnv}}`,
        `\tstorage file_system "${storageDir}"`,
        '\tadmin off',
        '}',
        '',
        `https://${domain}:${httpsPort} {`,
        `\treverse_proxy 127.0.0.1:${gatewayPort}`,
        '}',
        '',
    ].join('\n');
    return { ok: true, caddyfile, domain, httpsPort, gatewayPort };
}
//# sourceMappingURL=caddy.js.map