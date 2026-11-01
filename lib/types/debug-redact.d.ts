/**
 * CU-2: the debug report's redactor (SPEC 方案 C). Pure functions — no DSH
 * imports, no I/O — that turn free text and addresses into shapes an issue
 * report can carry: absolute paths lose everything but their leaf, home
 * paths fold to `~`, virtual session ids keep only the server id and the
 * first 8 characters of the session id, long secret-shaped runs become
 * `<token>`, and URL hostnames degrade to their address class. The report
 * assembler (debug-report.ts) runs every string it emits through
 * {@link redactText}; the check script pins the truth table, including the
 * "an injected path/hostname/token can never be recovered from the output"
 * assertion.
 *
 * The passes are ordered so they cannot un-do each other: URLs are lifted
 * out first (pass 0, a sentinel in their place) and restored last in
 * degraded form, so no text-wide pass can merge a URL's port and path into
 * a token run; then virtual ids (a ≥32-char id would otherwise die as a
 * token run), the home fold BEFORE the token pass (a long home path is
 * itself a ≥32 run), the token pass, and the path passes (UNC, drive
 * letter, Unix). Path leaves never contain whitespace, and Unix paths must
 * start at a boundary (string start, whitespace, `(`, `~`) so relative
 * paths and `a/b`-style words stay untouched.
 *
 * Deliberately ZERO relative imports: the check script imports this file
 * straight off src/ under Node's strip-only type stripping (the same seam
 * scripts/check-remote-drop.mjs uses for client-data/remote-drop.ts), and a
 * `.js` specifier cannot resolve there. The address-class predicate below
 * therefore restates the pairing normalizer's private-network ranges; the
 * two are pinned against each other by a lib-level test in
 * test/client-routes.test.cjs so they cannot drift apart silently.
 */
/** The address classes {@link serverUrlShape} reports. Deliberately coarse:
 * enough to triage "can the two machines even see each other", never the
 * hostname itself. */
export type ServerUrlClass = 'loopback' | 'lan-ip' | 'public-ip' | 'domain';
/**
 * One server address's SHAPE: `scheme://class[:port]` — never the hostname.
 * `http://192.168.1.10:3080` → `http://lan-ip:3080`; `https://myserver.example.com`
 * → `https://domain`; the scheme's default port is omitted. Unset input
 * answers `'unset'`, unparsable input `'invalid'`.
 */
export declare function serverUrlShape(url: unknown): string;
/**
 * A bind address's shape for the config plate (`host`): the same address
 * classes as {@link serverUrlShape}, plus `wildcard` for the all-interfaces
 * binds (`0.0.0.0` / `::`) — the one bind fact triage actually needs. Unset
 * input answers `'unset'`. A raw address never reaches the report.
 */
export declare function bindHostShape(host: unknown): string;
/**
 * Redact one free-text value: home paths fold to `~` (their relative tail is
 * kept — that is the one shape the report intentionally preserves), absolute
 * paths reduce to `<路径:leaf>`, URL hostnames degrade to their address
 * class, virtual session ids truncate, secret-shaped runs become
 * `<token>`. Non-strings pass through unchanged.
 */
export declare function redactText(text: string, context: {
    home?: string;
}): string;
/**
 * Deep-redact one JSON-ready value: every string (at any depth) through
 * {@link redactText}; keys are kept as-is (plugin names, field names —
 * public identifiers), numbers/booleans/null pass through. Returns new
 * containers; the input is never mutated.
 */
export declare function redactValue(value: unknown, context: {
    home?: string;
}): unknown;
//# sourceMappingURL=debug-redact.d.ts.map