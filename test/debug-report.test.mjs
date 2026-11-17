import assert from 'node:assert/strict'
import test from 'node:test'
import { bindHostShape, redactText, redactValue, serverUrlShape } from '../lib/debug-redact.js'
import { assembleDebugReport } from '../lib/debug-report.js'

const HOME_UNIX = '/Users/alice'
const HOME_WIN = 'C:\\Users\\bob'
const TOKEN_64 = 'a'.repeat(64)
const HEX_32 = '0123456789abcdef0123456789abcdef'
const INVITE_HOST = 'gw.secret.example'
const INVITE_JOIN_KEY = 'my-secret-join-key'
const INVITE_NET_ID = '9f4e2a1088c3b001'
const PG2_PRIVATE_KEY_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

test('redactText: home fold, paths, virtual ids, tokens, and URL hosts', () => {
  assert.equal(redactText('/Users/alice/work/x.txt', { home: HOME_UNIX }), '~/work/x.txt')
  assert.equal(redactText('/Users/alice', { home: HOME_UNIX }), '~')
  assert.equal(redactText('/opt/data/other.txt', { home: HOME_UNIX }), '<路径:other.txt>')
  assert.equal(redactText('C:\\Users\\bob\\doc.txt', { home: HOME_WIN }), '~/doc.txt')
  assert.equal(redactText('D:\\work\\notes.txt', { home: HOME_WIN }), '<路径:notes.txt>')

  assert.equal(redactText('failed at /opt/data/secret/report.log today', { home: HOME_UNIX }), 'failed at <路径:report.log> today')
  assert.ok(!redactText('F:\\Users\\name\\x.txt', {}).includes('Users'))
  assert.equal(redactText('a/b is relative', {}), 'a/b is relative')

  assert.equal(
    redactText('closed zr~0123abcd~session-9f8e7d6c5b4a3210 gracefully', {}),
    'closed zr~0123abcd~9f8e7d6c gracefully',
  )
  assert.ok(!redactText('zr~0123abcd~session-9f8e7d6c5b4a3210', {}).includes('9f8e7d6c5b4a3210'))

  assert.equal(redactText(`token=${TOKEN_64}`, {}), '<token>')
  assert.equal(redactText(`hex ${HEX_32} embedded`, {}), 'hex <token> embedded')
  assert.ok(!redactText(`keep ${'short'} and ${'also-short'}`, {}).includes('<token>'))

  assert.equal(redactText('probe http://127.0.0.1:3080/api failed', {}), 'probe http://loopback:3080/api failed')
  assert.equal(redactText('probe http://192.168.1.10:3080 failed', {}), 'probe http://lan-ip:3080 failed')
  assert.equal(redactText('probe https://myserver.example.com/x failed', {}), 'probe https://domain/x failed')
  assert.equal(redactText('probe https://1.2.3.4:8443/x failed', {}), 'probe https://public-ip:8443/x failed')
  assert.equal(redactText('probe http://[::1]:3080/x failed', {}), 'probe http://loopback:3080/x failed')

  const lastError = 'relay connect via http://10.0.0.5:8787 failed; dumped body to /var/tmp/secret/x.bin'
  const redactedError = redactText(lastError, { home: '/home/alice' })
  assert.ok(!redactedError.includes('10.0.0.5'))
  assert.ok(!redactedError.includes('/var/tmp'))
  assert.ok(redactedError.includes('http://lan-ip:8787'))
  assert.equal(redactedError.includes('<路径:x.bin>'), true)
  assert.equal(redactText('dumped to /home/alice/secret/x.bin', { home: '/home/alice' }).includes('~/secret/x.bin'), true)
})

test('redactText: credentialed URLs, UNC paths, schemes, sentinels, JWTs, and invite URIs', () => {
  const credUrl = redactText('fetch https://alice:s3cretPassw0rd@nas-office.example.com:8443/share/x failed', {})
  assert.equal(credUrl, 'fetch https://<token>@domain:8443/share/x failed')
  for (const leak of ['alice', 's3cretPassw0rd', 'nas-office', 'example.com']) {
    assert.ok(!credUrl.includes(leak), `credentialed URL: "${leak}" must not survive`)
  }

  const unc = redactText('opened \\\\NAS-OFFICE\\data\\users\\kyomio\\secret.docx ok', {})
  assert.equal(unc, 'opened <路径:secret.docx> ok')
  for (const leak of ['NAS-OFFICE', 'data', 'kyomio']) assert.ok(!unc.includes(leak))
  assert.equal(redactText('share \\\\NAS-OFFICE\\data gone', {}), 'share <路径> gone')
  assert.equal(redactText('\\\\NAS\\Shared Docs\\q3\\plan.xlsx failed', {}), '<路径:plan.xlsx> failed')

  assert.equal(redactText('socket ws://192.168.1.10:3088/relay closed', {}), 'socket ws://lan-ip:3088/relay closed')
  assert.equal(redactText('socket wss://relay.example.com/v1 closed', {}), 'socket wss://domain/v1 closed')
  assert.equal(redactText('mirror ftp://files.example.com/pub', {}), 'mirror ftp://domain/pub')

  assert.equal(redactText('D:\\work\\x\\plan.txt failed', {}), '<路径:plan.txt> failed')
  assert.equal(redactText('/opt/x/plan.txt failed', {}), '<路径:plan.txt> failed')
  assert.equal(redactText('C:\\Program Files\\My App\\app.log rotated', {}), '<路径:app.log> rotated')
  assert.equal(redactText('open https://domain/x', {}), 'open https://domain/x')

  // N1/N2/N3 sentinel lift-and-restore + home fold order
  assert.equal(
    redactText('ws://192.168.1.10:3080/_dsh/zen-remote/relay/v1/stream closed', {}),
    'ws://lan-ip:3080/_dsh/zen-remote/relay/v1/stream closed',
  )
  const DEVICE_HEX = 'f'.repeat(64)
  const relayQuery = redactText(`ws://192.168.1.10:3080/_dsh/zen-remote/relay/v1/stream?device=${DEVICE_HEX}&v=2`, {})
  assert.equal(relayQuery, 'ws://lan-ip:3080/_dsh/zen-remote/relay/v1/stream?device=<token>&v=2')
  assert.ok(!relayQuery.includes(DEVICE_HEX.slice(0, 16)))
  assert.equal(redactText(`https://h.example.com/share/${HEX_32}/x`, {}), 'https://domain/share/<token>/x')
  assert.equal(
    redactText('see https://h.example.com/x?sessionId=zr~0123abcd~session-9f8e7d6c5b4a3210, then retry', {}),
    'see https://domain/x?sessionId=zr~0123abcd~9f8e7d6c, then retry',
  )
  assert.equal(redactText('raw \u0000zr-url:0\u0000 sentinel', {}), 'raw \uFFFDzr-url:0\uFFFD sentinel')

  const slashPassword = redactText('https://bob:ab/cd@nas.example.com:8443/x', {})
  assert.equal(slashPassword, 'https://<token>@domain:8443/x')
  for (const leak of ['bob', 'ab/cd', 'nas.example.com', 'nas']) {
    assert.ok(!slashPassword.includes(leak))
  }
  assert.equal(redactText('https://social.example.com/users/@alice/profile', {}), 'https://<token>@domain/profile')
  assert.equal(
    redactText('dump at /Volumes/MacData/Users/kyomio/Downloads/relay-dump.bin', { home: '/Volumes/MacData/Users/kyomio' }),
    'dump at ~/Downloads/relay-dump.bin',
  )

  // PG-2 & GC-1a zr-net:// invites
  const invite = redactText(`invite zr-net://${INVITE_HOST}:19393/${INVITE_NET_ID}#${INVITE_JOIN_KEY} shared`, {})
  assert.equal(invite, `invite zr-net://domain:19393/${INVITE_NET_ID}#<token> shared`)
  for (const leak of [INVITE_HOST, INVITE_JOIN_KEY, 'secret.example']) {
    assert.ok(!invite.includes(leak))
  }
  assert.equal(
    redactText(`pairing zr-nets://${INVITE_HOST}/${INVITE_NET_ID}#${INVITE_JOIN_KEY} ok`, {}),
    `pairing zr-nets://domain/${INVITE_NET_ID}#<token> ok`,
  )
  assert.equal(
    redactText(`scan zr-net+insecure://192.168.1.10:19393/${INVITE_NET_ID}#${INVITE_JOIN_KEY} ok`, {}),
    `scan zr-net+insecure://lan-ip:19393/${INVITE_NET_ID}#<token> ok`,
  )
  assert.equal(
    redactText(`zr-net://${INVITE_HOST}/${INVITE_NET_ID}#abc123`, {}),
    `zr-net://domain/${INVITE_NET_ID}#<token>`,
  )
  assert.equal(
    redactText(`trailing zr-nets://${INVITE_HOST}/${INVITE_NET_ID}.`, {}),
    `trailing zr-nets://domain/${INVITE_NET_ID}.`,
  )
  const keyLine = redactText(`node identity privateKeyHex=${PG2_PRIVATE_KEY_HEX} leaked`, {})
  assert.ok(!keyLine.includes(PG2_PRIVATE_KEY_HEX))
  assert.ok(keyLine.includes('<token>'))

  const tlsQuery = redactText('invite zr-net://203.0.113.10:19393/0123456789abcdef?tls=0#short ok', {})
  assert.equal(tlsQuery, 'invite zr-net://public-ip:19393/0123456789abcdef?tls=0#<token> ok')
  assert.ok(!tlsQuery.includes('short'))
  const tlsLan = redactText('invite zr-net://192.168.1.5:8443/0123456789abcdef?tls=1#mykey ok', {})
  assert.equal(tlsLan, 'invite zr-net://lan-ip:8443/0123456789abcdef?tls=1#<token> ok')
  assert.ok(!tlsLan.includes('mykey'))

  // S1 base64url JWTs + S3 bindHostShape
  const JWT_PAYLOAD = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ'
  const JWT_SIG = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  const jwt = redactText(`Bearer eyJhbGciOiJIUzI1NiJ9.${JWT_PAYLOAD}.${JWT_SIG}`, {})
  assert.ok(!jwt.includes('adQssw5c'))
  assert.ok(!jwt.includes('SflKxwRJ'))
  assert.ok(!jwt.includes(JWT_PAYLOAD.slice(0, 16)))
  assert.equal(redactText(`k=${'a'.repeat(20)}-${'b'.repeat(20)}`, {}), '<token>')

  assert.equal(bindHostShape('127.0.0.1'), 'loopback')
  assert.equal(bindHostShape('0.0.0.0'), 'wildcard')
  assert.equal(bindHostShape('::'), 'wildcard')
  assert.equal(bindHostShape('192.168.1.10'), 'lan-ip')
  assert.equal(bindHostShape(undefined), 'unset')
})

test('redactValue and serverUrlShape', () => {
  const deep = redactValue({ a: { b: [`see ${TOKEN_64}`, 7, null, true] }, keep: 'plain' }, { home: HOME_UNIX })
  assert.deepEqual(deep, { a: { b: ['see <token>', 7, null, true] }, keep: 'plain' })

  assert.equal(serverUrlShape('http://127.0.0.1:3080'), 'http://loopback:3080')
  assert.equal(serverUrlShape('http://localhost'), 'http://loopback')
  assert.equal(serverUrlShape('http://192.168.1.10:3080'), 'http://lan-ip:3080')
  assert.equal(serverUrlShape('http://10.0.0.5'), 'http://lan-ip')
  assert.equal(serverUrlShape('https://100.64.0.9'), 'https://lan-ip')
  assert.equal(serverUrlShape('https://1.2.3.4:8443'), 'https://public-ip:8443')
  assert.equal(serverUrlShape('https://myserver.example.com'), 'https://domain')
  assert.equal(serverUrlShape('https://myserver.example.com:443'), 'https://domain')
  assert.equal(serverUrlShape('http://nas.local:3080'), 'http://domain:3080')
  assert.equal(serverUrlShape(''), 'unset')
  assert.equal(serverUrlShape(undefined), 'unset')
  assert.equal(serverUrlShape('not a url'), 'invalid')
  assert.ok(!serverUrlShape('https://my-nas-office.example.com:8443').includes('my-nas-office'))
})

test('assembleDebugReport: plate structure, constructive exclusion, and PG-2 peer redaction', () => {
  const lastError = 'relay connect via http://10.0.0.5:8787 failed; dumped body to /var/tmp/secret/x.bin'
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
      deviceToken: TOKEN_64,
      relaySecret: HEX_32,
      vapidPrivateKey: 'B'.repeat(64),
      serverUrl: 'https://myserver.example.com',
    },
    statusBody: {
      state: 'unreachable',
      serverUrl: 'https://myserver.example.com',
      lastError,
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

  assert.deepEqual(Object.keys(report), ['_meta', 'config', 'status', 'gateway', 'logs'])
  assert.equal(report._meta.role, 'client')
  assert.equal(report._meta.pluginVersion, '2.3.6')

  const serialized = JSON.stringify(report)
  assert.deepEqual(JSON.parse(serialized), report)
  for (const poison of [TOKEN_64, HEX_32, 'B'.repeat(64), 'myserver.example.com', 'mybox.example.com', '/Users/alice', '10.0.0.5', '192.168.1.10', '/var/tmp/secret', '9f8e7d6c5b4a3210']) {
    assert.ok(!serialized.includes(poison), `poisoned input "${poison.slice(0, 24)}…" leaked`)
  }
  assert.equal(report.config.serverUrl, 'https://domain')
  assert.equal(report.config.host, 'lan-ip')
  assert.equal(report.status.serverUrl, 'https://domain')
  assert.deepEqual(report.status.servers[0], {
    entryId: 'e1',
    serverUrl: 'https://domain',
    serverName: 'host ~/box https://domain',
    displayName: 'display ~/box https://domain',
    state: 'online',
  })
  assert.equal(report.status.servers[1].serverUrl, 'http://lan-ip:3080')
  assert.equal(report.status.servers[2].serverUrl, 'unset')
  for (const field of ['serverName', 'displayName']) {
    const text = String(report.status.servers[0][field])
    assert.ok(!text.includes('/Users/alice'))
    assert.ok(!text.includes('mybox.example.com'))
    assert.ok(text.includes('~/box'))
    assert.ok(text.includes('https://domain'))
  }
  assert.ok(String(report.status.lastError).includes('<路径:x.bin>'))
  assert.ok(String(report.logs[1].msg).includes('~/work/x.txt'))
  assert.ok(String(report.logs[1].msg).includes('<token>'))
  assert.equal(report.logs[0].msg, 'relay link online (server=0123abcd)')
  assert.equal(report.gateway.deviceCount, 2)
  assert.ok(serialized.includes('<token>'))

  const clientReport = assembleDebugReport({
    meta: { generatedAt: '2026-11-01T12:00:00.000Z', pluginVersion: '2.3.6', dshVersion: '0.2.1-rc.5', platform: 'win32 x64', role: 'client' },
    configSummary: {},
    statusBody: {},
    logs: [],
    home: HOME_WIN,
  })
  assert.ok(!('gateway' in clientReport))
  assert.deepEqual(clientReport.config.serverUrl, 'unset')

  const input = { configSummary: { deviceToken: TOKEN_64 }, statusBody: { lastError: '/opt/x.bin' }, logs: [{ t: 't', level: 'info', msg: '/opt/x.bin' }] }
  assembleDebugReport({ meta: { generatedAt: 'g', pluginVersion: 'v', dshVersion: 'd', platform: 'p', role: 'host' }, ...input, home: '/' })
  assert.equal(input.configSummary.deviceToken, TOKEN_64)
  assert.equal(input.statusBody.lastError, '/opt/x.bin')

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
  assert.deepEqual(JSON.parse(pg2Serialized), pg2Report)
  for (const poison of [PG2_PRIVATE_KEY_HEX, INVITE_HOST, INVITE_JOIN_KEY, 'secret.example', `zr-net://${INVITE_HOST}`, `#${INVITE_JOIN_KEY}`]) {
    assert.ok(!pg2Serialized.includes(poison))
  }
  assert.equal(pg2Report.config.maxServers, 16)
  assert.ok(String(pg2Report.status.lastError).includes('zr-net://domain:19393'))
  assert.ok(String(pg2Report.status.lastError).includes('#<token>'))
  assert.ok(String(pg2Report.logs[0].msg).includes('<token>'))
  assert.ok(String(pg2Report.logs[1].msg).includes('zr-nets://domain'))
})
