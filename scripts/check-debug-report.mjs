// Behaviour check for the debug report's redactor and assembler
// (src/debug-redact.ts + src/debug-report.ts, CU-2): the redaction truth
// table (home fold, absolute paths to their leaf, virtual-id truncation,
// token runs, URL host classes), the serverUrl shaper, the report's plate
// structure, and the constructive-exclusion assertion — an input poisoned
// with paths, hostnames and tokens must come out with NONE of them
// recoverable from the serialized report.
//
// Run: node scripts/check-debug-report.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

// The host half's sources import each other with `.js` specifiers (the tsc
// emit convention). Under strip-only type stripping those specifiers do not
// resolve against the .ts sources, so this check registers one synchronous
// resolve hook: for a relative `.js` specifier that misses, retry the same
// specifier with `.ts` when that file exists. Nothing else is rewritten.
// Registered before the dynamic imports below — static imports would be
// resolved before any module body runs.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (
        (specifier.startsWith('./') || specifier.startsWith('../'))
        && specifier.endsWith('.js')
        && typeof context.parentURL === 'string'
      ) {
        const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, format: 'module', shortCircuit: true }
        }
      }
      throw error
    }
  },
})

const { bindHostShape, redactText, redactValue, serverUrlShape } = await import('../src/debug-redact.ts')
const { assembleDebugReport } = await import('../src/debug-report.ts')

const HOME_UNIX = '/Users/alice'
const HOME_WIN = 'C:\\Users\\bob'
const TOKEN_64 = 'a'.repeat(64)
const HEX_32 = '0123456789abcdef0123456789abcdef'

// ---- 1. redactText: home fold ------------------------------------------------
assert.equal(redactText('/Users/alice/work/x.txt', { home: HOME_UNIX }), '~/work/x.txt', 'a home path folds to ~ and keeps its relative tail')
assert.equal(redactText('/Users/alice', { home: HOME_UNIX }), '~', 'the bare home folds to ~')
assert.equal(redactText('/opt/data/other.txt', { home: HOME_UNIX }), '<路径:other.txt>', 'a non-home absolute path reduces to its leaf')
assert.equal(redactText('C:\\Users\\bob\\doc.txt', { home: HOME_WIN }), '~/doc.txt', 'a Windows home path folds to ~')
assert.equal(redactText('D:\\work\\notes.txt', { home: HOME_WIN }), '<路径:notes.txt>', 'a non-home Windows path reduces to its leaf')

// ---- 2. redactText: absolute paths ------------------------------------------
assert.equal(redactText('failed at /opt/data/secret/report.log today', { home: HOME_UNIX }), 'failed at <路径:report.log> today', 'the path keeps only its leaf, inline')
assert.ok(!redactText('F:\\Users\\name\\x.txt', {}).includes('Users'), 'the Windows path directory chain is gone')
assert.equal(redactText('a/b is relative', {}), 'a/b is relative', 'a relative word pair stays untouched')

// ---- 3. redactText: virtual ids ----------------------------------------------
assert.equal(
  redactText('closed zr~0123abcd~session-9f8e7d6c5b4a3210 gracefully', {}),
  'closed zr~0123abcd~9f8e7d6c gracefully',
  'a virtual id keeps the server id and the session id head',
)
assert.ok(!redactText('zr~0123abcd~session-9f8e7d6c5b4a3210', {}).includes('9f8e7d6c5b4a3210'), 'the full virtual id is not recoverable')

// ---- 4. redactText: token runs -----------------------------------------------
// `=` is in the run class (base64 padding), so a `token=<64 chars>` blob is
// ONE run and dies whole — the label going with it is fine for redaction.
assert.equal(redactText(`token=${TOKEN_64}`, {}), '<token>', 'a 64-char secret run becomes <token>, label included')
assert.equal(redactText(`hex ${HEX_32} embedded`, {}), 'hex <token> embedded', 'a 32-char hex run becomes <token>')
assert.ok(!redactText(`keep ${'short'} and ${'also-short'}`, {}).includes('<token>'), 'short words never trip the token pass')

// ---- 5. redactText: URL hosts -------------------------------------------------
assert.equal(redactText('probe http://127.0.0.1:3080/api failed', {}), 'probe http://loopback:3080/api failed', 'a loopback host degrades to its class')
assert.equal(redactText('probe http://192.168.1.10:3080 failed', {}), 'probe http://lan-ip:3080 failed', 'a LAN host degrades to its class')
assert.equal(redactText('probe https://myserver.example.com/x failed', {}), 'probe https://domain/x failed', 'a domain host degrades to its class')
assert.equal(redactText('probe https://1.2.3.4:8443/x failed', {}), 'probe https://public-ip:8443/x failed', 'a public IP degrades to its class')
assert.equal(redactText('probe http://[::1]:3080/x failed', {}), 'probe http://loopback:3080/x failed', 'a bracketed IPv6 loopback degrades to its class')

// ---- 6. redactText: a realistic free-text lastError ---------------------------
// A home-nested path folds to `~` (the one shape kept); a path elsewhere
// reduces to its leaf; the embedded URL keeps only its address class.
const lastError = 'relay connect via http://10.0.0.5:8787 failed; dumped body to /var/tmp/secret/x.bin'
const redactedError = redactText(lastError, { home: '/home/alice' })
assert.ok(!redactedError.includes('10.0.0.5'), 'the LAN IP is gone from the embedded URL')
assert.ok(!redactedError.includes('/var/tmp'), 'the injected non-home path is not recoverable')
assert.ok(redactedError.includes('http://lan-ip:8787'), 'the embedded URL keeps its shape')
assert.equal(redactedError.includes('<路径:x.bin>'), true, 'the embedded path keeps only its leaf')
assert.equal(redactText('dumped to /home/alice/secret/x.bin', { home: '/home/alice' }).includes('~/secret/x.bin'), true, 'a home-nested embedded path folds to ~')

// ---- 6b. CU-fix: the four review-reproduced breaches (inputs verbatim) -------
// C1-a: a credentialed URL — neither the password nor the real hostname may
// survive; the userinfo dies whole.
const credUrl = redactText('fetch https://alice:s3cretPassw0rd@nas-office.example.com:8443/share/x failed', {})
assert.equal(credUrl, 'fetch https://<token>@domain:8443/share/x failed', 'userinfo dropped whole, host degraded, port kept')
for (const leak of ['alice', 's3cretPassw0rd', 'nas-office', 'example.com']) {
  assert.ok(!credUrl.includes(leak), `credentialed URL: "${leak}" is not recoverable`)
}
// C1-b: a Windows UNC path — server and share names never survive.
const unc = redactText('opened \\\\NAS-OFFICE\\data\\users\\kyomio\\secret.docx ok', {})
assert.equal(unc, 'opened <路径:secret.docx> ok', 'a UNC path keeps only its leaf')
for (const leak of ['NAS-OFFICE', 'data', 'kyomio']) assert.ok(!unc.includes(leak), `UNC: "${leak}" is not recoverable`)
assert.equal(redactText('share \\\\NAS-OFFICE\\data gone', {}), 'share <路径> gone', 'a bare UNC root keeps nothing')
assert.equal(redactText('\\\\NAS\\Shared Docs\\q3\\plan.xlsx failed', {}), '<路径:plan.xlsx> failed', 'inner UNC segments may hold spaces; the leaf may not')
// C1-c: ws:// / wss:// / ftp:// addresses degrade like http(s).
assert.equal(redactText('socket ws://192.168.1.10:3088/relay closed', {}), 'socket ws://lan-ip:3088/relay closed', 'ws:// host degrades')
assert.equal(redactText('socket wss://relay.example.com/v1 closed', {}), 'socket wss://domain/v1 closed', 'wss:// host degrades')
assert.equal(redactText('mirror ftp://files.example.com/pub', {}), 'mirror ftp://domain/pub', 'ftp:// host degrades')
// C1-d: a drive-letter leaf no longer swallows the sentence after it.
assert.equal(redactText('D:\\work\\x\\plan.txt failed', {}), '<路径:plan.txt> failed', 'the leaf stops at whitespace')
assert.equal(redactText('/opt/x/plan.txt failed', {}), '<路径:plan.txt> failed', 'the Unix leaf stops at whitespace too')
assert.equal(redactText('C:\\Program Files\\My App\\app.log rotated', {}), '<路径:app.log> rotated', 'inner Windows segments may hold spaces')
assert.equal(redactText('open https://domain/x', {}), 'open https://domain/x', 'a URL scheme colon is not a drive letter')

// ---- 6e. CU-fix2: the re-review's three breaches (N1/N2/N3) ------------------
// N1: a long URL path no longer merges with the port into one token run —
// the URL is lifted out before the token pass and restored degraded, port
// and path kept (the ws relay stream as the re-review reproduced it).
assert.equal(
  redactText('ws://192.168.1.10:3080/_dsh/zen-remote/relay/v1/stream closed', {}),
  'ws://lan-ip:3080/_dsh/zen-remote/relay/v1/stream closed',
  'N1: the port and the path survive a long URL path',
)
// N1 (added by the main session): the lifted URL skips the text-wide token
// pass, so its query secrets are redacted on restore — the port stays, the
// device value dies whole, the key stays readable.
const DEVICE_HEX = 'f'.repeat(64)
const relayQuery = redactText(`ws://192.168.1.10:3080/_dsh/zen-remote/relay/v1/stream?device=${DEVICE_HEX}&v=2`, {})
assert.equal(relayQuery, 'ws://lan-ip:3080/_dsh/zen-remote/relay/v1/stream?device=<token>&v=2', 'N1: a long query value becomes <token>, port kept')
assert.ok(!relayQuery.includes(DEVICE_HEX.slice(0, 16)), 'N1: the query secret is not recoverable')
assert.equal(redactText(`https://h.example.com/share/${HEX_32}/x`, {}), 'https://domain/share/<token>/x', 'N1: a secret-shaped path segment dies, the rest of the path stays')
assert.equal(
  redactText('see https://h.example.com/x?sessionId=zr~0123abcd~session-9f8e7d6c5b4a3210, then retry', {}),
  'see https://domain/x?sessionId=zr~0123abcd~9f8e7d6c, then retry',
  'N1: a virtual id in a query value truncates; trailing punctuation stays outside the URL',
)
assert.equal(redactText('raw \u0000zr-url:0\u0000 sentinel', {}), 'raw \uFFFDzr-url:0\uFFFD sentinel', 'N1: an input NUL can never forge a sentinel')
// N2: a password holding `/` is still userinfo — the boundary is the LAST
// `@` before `?`/`#`, so neither the password nor the host survives.
const slashPassword = redactText('https://bob:ab/cd@nas.example.com:8443/x', {})
assert.equal(slashPassword, 'https://<token>@domain:8443/x', 'N2: userinfo with a slash dies whole')
for (const leak of ['bob', 'ab/cd', 'nas.example.com', 'nas']) {
  assert.ok(!slashPassword.includes(leak), `N2: "${leak}" is not recoverable`)
}
// N2's accepted side effect: a path that itself holds `@` loses everything
// before that `@` to `<token>@` — over-redaction, the safe direction.
assert.equal(
  redactText('https://social.example.com/users/@alice/profile', {}),
  'https://<token>@domain/profile',
  'N2 side effect: a path `@` over-redacts (accepted)',
)
// N3: the home fold runs BEFORE the token pass — a long home path keeps its
// `~/…` tail instead of dying whole as one run.
assert.equal(
  redactText('dump at /Volumes/MacData/Users/kyomio/Downloads/relay-dump.bin', { home: '/Volumes/MacData/Users/kyomio' }),
  'dump at ~/Downloads/relay-dump.bin',
  'N3: a long home path folds to ~/… and keeps its tail',
)

// ---- 6f. PG-2: the peer invite URIs (zr-net://) are first-class secrets ------
// The invite carries the gateway address AND the join key; both must die.
const INVITE_HOST = 'gw.secret.example'
const INVITE_JOIN_KEY = 'my-secret-join-key'
const INVITE_NET_ID = '9f4e2a1088c3b001'
const PG2_PRIVATE_KEY_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const invite = redactText(`invite zr-net://${INVITE_HOST}:19393/${INVITE_NET_ID}#${INVITE_JOIN_KEY} shared`, {})
assert.equal(invite, `invite zr-net://domain:19393/${INVITE_NET_ID}#<token> shared`, 'the invite keeps its shape: scheme, port and network id; host and join key die')
for (const leak of [INVITE_HOST, INVITE_JOIN_KEY, 'secret.example']) {
  assert.ok(!invite.includes(leak), `zr-net: "${leak}" is not recoverable`)
}
// zr-nets:// (TLS-forced) and zr-net+insecure:// (plaintext, local tests) get
// the same treatment, each keeping its own scheme.
assert.equal(
  redactText(`pairing zr-nets://${INVITE_HOST}/${INVITE_NET_ID}#${INVITE_JOIN_KEY} ok`, {}),
  `pairing zr-nets://domain/${INVITE_NET_ID}#<token> ok`,
  'zr-nets:// degrades the same way (scheme default port omitted)',
)
assert.equal(
  redactText(`scan zr-net+insecure://192.168.1.10:19393/${INVITE_NET_ID}#${INVITE_JOIN_KEY} ok`, {}),
  `scan zr-net+insecure://lan-ip:19393/${INVITE_NET_ID}#<token> ok`,
  'zr-net+insecure:// degrades to the address class like ws://',
)
// The fragment folds UNCONDITIONALLY — a join key shorter than the 32-char
// token-run threshold is still a credential.
assert.equal(
  redactText(`zr-net://${INVITE_HOST}/${INVITE_NET_ID}#abc123`, {}),
  `zr-net://domain/${INVITE_NET_ID}#<token>`,
  'a short join key folds too; the fragment is a credential by definition',
)
// An invite WITHOUT a fragment keeps its degraded host and its network id.
assert.equal(
  redactText(`trailing zr-nets://${INVITE_HOST}/${INVITE_NET_ID}.`, {}),
  `trailing zr-nets://domain/${INVITE_NET_ID}.`,
  'a fragmentless invite keeps only scheme+class+network id (trailing punctuation peeled)',
)
// A 64-hex Ed25519 private seed in free text dies as a token run.
const keyLine = redactText(`node identity privateKeyHex=${PG2_PRIVATE_KEY_HEX} leaked`, {})
assert.ok(!keyLine.includes(PG2_PRIVATE_KEY_HEX), 'the private seed is not recoverable')
assert.ok(keyLine.includes('<token>'))

// ---- 6c. S1: base64url runs (a JWT) die whole --------------------------------
const JWT_PAYLOAD = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ'
const JWT_SIG = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
const jwt = redactText(`Bearer eyJhbGciOiJIUzI1NiJ9.${JWT_PAYLOAD}.${JWT_SIG}`, {})
assert.ok(!jwt.includes('adQssw5c'), 'the signature tail past "_" is not left behind')
assert.ok(!jwt.includes('SflKxwRJ'), 'the signature head is gone')
assert.ok(!jwt.includes(JWT_PAYLOAD.slice(0, 16)), 'the payload is gone')
assert.equal(redactText(`k=${'a'.repeat(20)}-${'b'.repeat(20)}`, {}), '<token>', 'a hyphen no longer splits a run below the threshold')

// ---- 6d. S3: the bind host's shape -------------------------------------------
assert.equal(bindHostShape('127.0.0.1'), 'loopback', 'loopback bind')
assert.equal(bindHostShape('0.0.0.0'), 'wildcard', 'all-interfaces bind')
assert.equal(bindHostShape('::'), 'wildcard', 'IPv6 all-interfaces bind')
assert.equal(bindHostShape('192.168.1.10'), 'lan-ip', 'a LAN bind keeps only its class')
assert.equal(bindHostShape(undefined), 'unset', 'no bind host')

// ---- 7. redactValue: deep pass -------------------------------------------------
const deep = redactValue({ a: { b: [`see ${TOKEN_64}`, 7, null, true] }, keep: 'plain' }, { home: HOME_UNIX })
assert.deepEqual(deep, { a: { b: ['see <token>', 7, null, true] }, keep: 'plain' }, 'strings redact at any depth; non-strings pass')
assert.ok(!('mutated' in ({})), 'sanity')

// ---- 8. serverUrlShape ---------------------------------------------------------
assert.equal(serverUrlShape('http://127.0.0.1:3080'), 'http://loopback:3080', 'loopback class')
assert.equal(serverUrlShape('http://localhost'), 'http://loopback', 'localhost class, no port')
assert.equal(serverUrlShape('http://192.168.1.10:3080'), 'http://lan-ip:3080', 'LAN class')
assert.equal(serverUrlShape('http://10.0.0.5'), 'http://lan-ip', 'LAN class, no port')
assert.equal(serverUrlShape('https://100.64.0.9'), 'https://lan-ip', 'CGNAT/Tailscale is LAN class')
assert.equal(serverUrlShape('https://1.2.3.4:8443'), 'https://public-ip:8443', 'public IP class')
assert.equal(serverUrlShape('https://myserver.example.com'), 'https://domain', 'domain class')
assert.equal(serverUrlShape('https://myserver.example.com:443'), 'https://domain', 'the scheme default port is omitted')
assert.equal(serverUrlShape('http://nas.local:3080'), 'http://domain:3080', 'an mDNS name is domain class')
assert.equal(serverUrlShape(''), 'unset', 'unset input')
assert.equal(serverUrlShape(undefined), 'unset', 'non-string input')
assert.equal(serverUrlShape('not a url'), 'invalid', 'unparsable input')
assert.ok(!serverUrlShape('https://my-nas-office.example.com:8443').includes('my-nas-office'), 'the hostname never survives the shaper')

// ---- 9. assembleDebugReport: plate structure -----------------------------------
const report = assembleDebugReport({
  meta: {
    generatedAt: '2026-11-01T12:00:00.000Z',
    pluginVersion: '2.3.6',
    dshVersion: '0.2.1-rc.5',
    platform: 'darwin arm64',
    role: 'client',
    profileName: 'default',
  },
  configSummary: {
    role: 'client',
    host: '192.168.1.10',
    port: 3080,
    idleHours: 12,
    maxUploadBytes: 52428800,
    autoShareNewSessions: true,
    pluginBridgeConsent: { 'dsh-better-sidebar': false },
    // Poisoned extras: a secret-bearing field that construction should have
    // kept out — and if it ever sneaks back in, the deep redactor catches it.
    deviceToken: TOKEN_64,
    relaySecret: HEX_32,
    vapidPrivateKey: 'B'.repeat(64),
    serverUrl: 'https://myserver.example.com',
  },
  statusBody: {
    state: 'unreachable',
    serverUrl: 'https://myserver.example.com',
    lastError,
    // MS-5: the pool mode's per-server rows carry every paired server's REAL
    // address; each must come out as a shape, never the address itself.
    // MS-5-fix: the row's OTHER fields are poisoned too (a hostile server
    // name can carry a home path and a domain — both arrive verbatim from
    // the handshake), so the shaper rebuild must not restore what the deep
    // pass cleaned.
    servers: [
      {
        entryId: 'e1',
        serverUrl: 'https://myserver.example.com:443',
        serverName: 'host /Users/alice/box https://mybox.example.com',
        displayName: 'display /Users/alice/box https://mybox.example.com',
        state: 'online',
      },
      { entryId: 'e2', serverUrl: 'http://192.168.1.10:3080', state: 'offline', nextRetryAt: 1234567890123 },
      { entryId: 'e3', serverUrl: '' },
    ],
  },
  gatewaySummary: { reachable: true, port: 3080, deviceCount: 2, shareCount: 1 },
  logs: [
    { t: '2026-11-01T11:59:59.000Z', level: 'info', msg: 'relay link online (server=0123abcd)' },
    { t: '2026-11-01T12:00:00.000Z', level: 'warn', msg: `refused: /Users/alice/work/x.txt ${TOKEN_64}` },
  ],
  home: HOME_UNIX,
})

// The plates exist, in order, with the host-only plate present.
assert.deepEqual(Object.keys(report), ['_meta', 'config', 'status', 'gateway', 'logs'], 'all five plates, in order')
assert.equal(report._meta.role, 'client', '_meta carries the role')
assert.equal(report._meta.pluginVersion, '2.3.6', '_meta carries the plugin version')

// ---- 10. the constructive-exclusion assertion ----------------------------------
const serialized = JSON.stringify(report)
// JSON round-trip: the report the user downloads must parse back.
assert.deepEqual(JSON.parse(serialized), report, 'the report survives a JSON round-trip')
for (const poison of [TOKEN_64, HEX_32, 'B'.repeat(64), 'myserver.example.com', 'mybox.example.com', '/Users/alice', '10.0.0.5', '192.168.1.10', '/var/tmp/secret', '9f8e7d6c5b4a3210']) {
  assert.ok(!serialized.includes(poison), `poisoned input "${poison.slice(0, 24)}…" is not recoverable from the output`)
}
assert.equal(report.config.serverUrl, 'https://domain', 'config.serverUrl is a shape, not the address')
assert.equal(report.config.host, 'lan-ip', 'config.host is a bind shape, not the address (S3)')
assert.equal(report.status.serverUrl, 'https://domain', 'status.serverUrl degraded through the deep pass')
// MS-5: every pool server row's address is a SHAPE — the scheme-default port
// is omitted and unset degrades, the shaper's own normalization, not just the
// deep pass's URL downgrade.
assert.deepEqual(report.status.servers[0], {
  entryId: 'e1',
  serverUrl: 'https://domain',
  serverName: 'host ~/box https://domain',
  displayName: 'display ~/box https://domain',
  state: 'online',
}, 'the default port went away with the host; the poisoned row fields came out redacted')
assert.equal(report.status.servers[1].serverUrl, 'http://lan-ip:3080', 'a LAN address keeps only class+port')
assert.equal(report.status.servers[2].serverUrl, 'unset', 'an unset address degrades to unset')
// MS-5-fix regression: the serverUrl shaper rebuild must not RESTORE the raw
// row — serverName / displayName / lastError travel through redactValue like
// every other string, so a hostile handshake-supplied name leaks neither a
// home path nor a hostname into the report.
for (const field of ['serverName', 'displayName']) {
  const text = String(report.status.servers[0][field])
  assert.ok(!text.includes('/Users/alice'), `servers[0].${field} keeps no home path`)
  assert.ok(!text.includes('mybox.example.com'), `servers[0].${field} keeps no hostname`)
  assert.ok(text.includes('~/box'), `servers[0].${field} keeps the home-folded leaf`)
  assert.ok(text.includes('https://domain'), `servers[0].${field} keeps only the degraded host class`)
}
assert.ok(String(report.status.lastError).includes('<路径:x.bin>'), 'the status lastError kept only the path leaf')
assert.ok(String(report.logs[1].msg).includes('~/work/x.txt'), 'log lines keep the home-folded tail')
assert.ok(String(report.logs[1].msg).includes('<token>'), 'log lines lose token runs')
assert.equal(report.logs[0].msg, 'relay link online (server=0123abcd)', 'a clean log line passes through unchanged')
assert.equal(report.gateway.deviceCount, 2, 'the gateway plate rides through')
assert.ok(serialized.includes('<token>'), 'the redactor placeholder is present')

// The no-gateway (client role) shape: no gateway plate at all.
const clientReport = assembleDebugReport({
  meta: { generatedAt: '2026-11-01T12:00:00.000Z', pluginVersion: '2.3.6', dshVersion: '0.2.1-rc.5', platform: 'win32 x64', role: 'client' },
  configSummary: {},
  statusBody: {},
  logs: [],
  home: HOME_WIN,
})
assert.ok(!('gateway' in clientReport), 'no gateway plate without a summary')
assert.deepEqual(clientReport.config.serverUrl, 'unset', 'an unset serverUrl shapes to unset')

// The assembler never mutates its input.
const input = { configSummary: { deviceToken: TOKEN_64 }, statusBody: { lastError: '/opt/x.bin' }, logs: [{ t: 't', level: 'info', msg: '/opt/x.bin' }] }
assembleDebugReport({ meta: { generatedAt: 'g', pluginVersion: 'v', dshVersion: 'd', platform: 'p', role: 'host' }, ...input, home: '/' })
assert.equal(input.configSummary.deviceToken, TOKEN_64, 'input config untouched')
assert.equal(input.statusBody.lastError, '/opt/x.bin', 'input status untouched')

// ---- 11. PG-2: a report poisoned with a peer identity and an invite URI ------
// The state file holds a private seed and the invite link; a debug report
// must carry NEITHER, wherever in the plates they surface.
const pg2Report = assembleDebugReport({
  meta: { generatedAt: '2026-11-10T00:00:00.000Z', pluginVersion: '2.4.1', dshVersion: '0.2.1', platform: 'darwin arm64', role: 'peer' },
  configSummary: { role: 'peer', maxServers: 16 },
  statusBody: {
    state: 'online',
    lastError: `join failed for zr-net://${INVITE_HOST}:19393/${INVITE_NET_ID}#${INVITE_JOIN_KEY}`,
  },
  logs: [
    { t: '2026-11-10T00:00:00.000Z', level: 'warn', msg: `identity materialized privateKeyHex=${PG2_PRIVATE_KEY_HEX}` },
    { t: '2026-11-10T00:00:01.000Z', level: 'info', msg: `peer network invite zr-nets://${INVITE_HOST}/${INVITE_NET_ID}#${INVITE_JOIN_KEY}` },
  ],
  home: HOME_UNIX,
})
const pg2Serialized = JSON.stringify(pg2Report)
assert.deepEqual(JSON.parse(pg2Serialized), pg2Report, 'the PG-2 report survives a JSON round-trip')
for (const poison of [PG2_PRIVATE_KEY_HEX, INVITE_HOST, INVITE_JOIN_KEY, 'secret.example', `zr-net://${INVITE_HOST}`, `#${INVITE_JOIN_KEY}`]) {
  assert.ok(!pg2Serialized.includes(poison), `PG-2 poisoned input "${poison.slice(0, 24)}…" is not recoverable from the report`)
}
assert.equal(pg2Report.config.maxServers, 16, 'maxServers is a number, it rides the config plate')
assert.ok(String(pg2Report.status.lastError).includes('zr-net://domain:19393'), 'the status lastError keeps the degraded invite shape')
assert.ok(String(pg2Report.status.lastError).includes('#<token>'), 'the join key became #<token>')
assert.ok(String(pg2Report.logs[0].msg).includes('<token>'), 'the log-line private seed died')
assert.ok(String(pg2Report.logs[1].msg).includes('zr-nets://domain'), 'the log-line invite degrades')

console.log('check-debug-report: all assertions passed')
