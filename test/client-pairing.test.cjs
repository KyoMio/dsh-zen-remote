/* dsh-zen-remote · client pairing logic (src/client-pairing.ts, T16)
 *
 * Pure decisions only: the server-address normalizer's private-network
 * allowances (each tested at BOTH range edges, plus the nearest outside
 * address), the claim classifier's four refusal buckets + happy shape, and
 * the probe classifier's state machine. The built lib/client-pairing.js is
 * imported directly — no sockets, no clocks.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const PAIRING_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'client-pairing.js')).href

let pairing
test.before(async () => { pairing = await import(PAIRING_URL) })

// ---- normalizeServerUrl ------------------------------------------------------

test('http is accepted for every allowed private IPv4 range and rejected outside it', () => {
  // 172.16.0.0/12 edges: 172.15 is outside, 172.16/172.31 inside, 172.32 outside.
  assert.equal(pairing.normalizeServerUrl('http://172.15.0.1:3088').ok, false)
  assert.equal(pairing.normalizeServerUrl('http://172.16.0.1:3088').ok, true)
  assert.equal(pairing.normalizeServerUrl('http://172.31.255.254:3088').ok, true)
  assert.equal(pairing.normalizeServerUrl('http://172.32.0.1:3088').ok, false)
  // 100.64.0.0/10 edges (CGNAT / Tailscale): 100.63 outside, 100.64/100.127 inside.
  assert.equal(pairing.normalizeServerUrl('http://100.63.0.1:3088').ok, false)
  assert.equal(pairing.normalizeServerUrl('http://100.64.0.1:3088').ok, true)
  assert.equal(pairing.normalizeServerUrl('http://100.127.255.254:3088').ok, true)
  assert.equal(pairing.normalizeServerUrl('http://100.128.0.1:3088').ok, false)
  // 10.0.0.0/8, 192.168.0.0/16, 127.0.0.0/8.
  assert.equal(pairing.normalizeServerUrl('http://10.1.2.3:3088').ok, true)
  assert.equal(pairing.normalizeServerUrl('http://11.0.0.1:3088').ok, false)
  assert.equal(pairing.normalizeServerUrl('http://192.168.3.129:3088').ok, true)
  assert.equal(pairing.normalizeServerUrl('http://192.169.0.1:3088').ok, false)
  assert.equal(pairing.normalizeServerUrl('http://127.0.0.1:3088').ok, true)
  assert.equal(pairing.normalizeServerUrl('http://128.0.0.1:3088').ok, false)
})

test('http is rejected for public IPs and ordinary domain names, https always accepted', () => {
  assert.equal(pairing.normalizeServerUrl('http://8.8.8.8:3088').ok, false)
  assert.equal(pairing.normalizeServerUrl('http://1.2.3.4').ok, false)
  assert.equal(pairing.normalizeServerUrl('http://dsh.example.com:3088').ok, false)
  // The insecure-http reason, distinct from a shape failure.
  assert.deepEqual(pairing.normalizeServerUrl('http://8.8.8.8:3088'), { ok: false, reason: 'insecure-http' })
  // https: any host, any port, always fine.
  assert.equal(pairing.normalizeServerUrl('https://dsh.example.com').ok, true)
  assert.equal(pairing.normalizeServerUrl('https://8.8.8.8:3088').ok, true)
  assert.equal(pairing.normalizeServerUrl('https://192.168.3.129:3088').ok, true)
})

test('http is accepted for localhost, .local names and allowed IPv6 loopback/link-local/ULA', () => {
  assert.equal(pairing.normalizeServerUrl('http://localhost:3088').ok, true)
  assert.equal(pairing.normalizeServerUrl('http://localhost').ok, true)
  assert.equal(pairing.normalizeServerUrl('http://mybox.local:3088').ok, true)
  assert.equal(pairing.normalizeServerUrl('http://mybox.localdev:3088').ok, false, 'only a .local SUFFIX counts')
  assert.equal(pairing.normalizeServerUrl('http://[::1]:3088').ok, true)
  assert.equal(pairing.normalizeServerUrl('http://[fc00::1]:3088').ok, true)
  assert.equal(pairing.normalizeServerUrl('http://[fdff::1]:3088').ok, true, 'fc00::/7 ends at fdff')
  assert.equal(pairing.normalizeServerUrl('http://[fe80::1]:3088').ok, true)
  assert.equal(pairing.normalizeServerUrl('http://[febf::1]:3088').ok, true)
  assert.equal(pairing.normalizeServerUrl('http://[fec0::1]:3088').ok, false, 'fe80::/10 ends at febf')
  assert.equal(pairing.normalizeServerUrl('http://[fb00::1]:3088').ok, false)
  assert.equal(pairing.normalizeServerUrl('http://[fe00::1]:3088').ok, false)
  assert.equal(pairing.normalizeServerUrl('http://[2001:db8::1]:3088').ok, false)
})

test('the normalizer strips whitespace and trailing slashes and returns a clean origin', () => {
  assert.deepEqual(
    pairing.normalizeServerUrl('  http://192.168.3.129:3088/  '),
    { ok: true, url: 'http://192.168.3.129:3088' },
  )
  assert.deepEqual(
    pairing.normalizeServerUrl('http://192.168.3.129:3088///'),
    { ok: true, url: 'http://192.168.3.129:3088' },
  )
})

test('paths, query strings, fragments, credentials and exotic schemes are invalid', () => {
  assert.deepEqual(pairing.normalizeServerUrl('http://192.168.3.129:3088/lan-gate'), { ok: false, reason: 'invalid' })
  assert.deepEqual(pairing.normalizeServerUrl('https://dsh.example.com/app/'), { ok: false, reason: 'invalid' })
  assert.deepEqual(pairing.normalizeServerUrl('http://192.168.3.129:3088/?x=1'), { ok: false, reason: 'invalid' })
  assert.deepEqual(pairing.normalizeServerUrl('https://dsh.example.com#frag'), { ok: false, reason: 'invalid' })
  assert.deepEqual(pairing.normalizeServerUrl('http://user:pass@192.168.3.129:3088'), { ok: false, reason: 'invalid' })
  assert.deepEqual(pairing.normalizeServerUrl('https://alice@dsh.example.com'), { ok: false, reason: 'invalid' })
  assert.deepEqual(pairing.normalizeServerUrl('ftp://192.168.3.129:3088'), { ok: false, reason: 'invalid' })
  assert.deepEqual(pairing.normalizeServerUrl('192.168.3.129:3088'), { ok: false, reason: 'invalid' }, 'no scheme at all')
  assert.deepEqual(pairing.normalizeServerUrl(''), { ok: false, reason: 'invalid' })
  assert.deepEqual(pairing.normalizeServerUrl('not a url'), { ok: false, reason: 'invalid' })
})

test('acceptance sample: public http refused, LAN http and public https accepted', () => {
  assert.equal(pairing.normalizeServerUrl('http://8.8.8.8:3088').ok, false)
  assert.equal(pairing.normalizeServerUrl('http://192.168.3.129:3088/').ok, true)
  assert.equal(pairing.normalizeServerUrl('https://dsh.example.com').ok, true)
})

// ---- classifyClaimResponse ---------------------------------------------------

test('classifyClaimResponse: the success shape carries token, device id and name', () => {
  assert.deepEqual(
    pairing.classifyClaimResponse(200, { ok: true, id: 'abcd1234', name: '台式机', token: 'tok-xyz' }),
    { ok: true, token: 'tok-xyz', deviceId: 'abcd1234', deviceName: '台式机' },
  )
  assert.equal(
    pairing.classifyClaimResponse(201, { ok: true, id: 'x', name: 'n', token: 't' }).ok,
    true,
    'any 2xx counts',
  )
})

test('classifyClaimResponse: role mismatch passes the server message through', () => {
  assert.deepEqual(
    pairing.classifyClaimResponse(403, { ok: false, reason: 'role-mismatch', expected: 'web', message: '该配对码仅适用于 Web 应用端' }),
    { ok: false, code: 'role-mismatch', message: '该配对码仅适用于 Web 应用端' },
  )
  assert.deepEqual(
    pairing.classifyClaimResponse(403, { ok: false, reason: 'role-mismatch', expected: 'web' }),
    { ok: false, code: 'role-mismatch' },
    'message is optional',
  )
})

test('classifyClaimResponse: bad code and lockout map to their own buckets', () => {
  assert.deepEqual(pairing.classifyClaimResponse(403, { ok: false, reason: 'bad-code' }), { ok: false, code: 'bad-code' })
  assert.deepEqual(
    pairing.classifyClaimResponse(429, { ok: false, reason: 'locked', retryAfterMs: 900123 }),
    { ok: false, code: 'locked', retryAfterMs: 900123 },
  )
  // A missing retryAfterMs degrades to 0 rather than NaN.
  assert.deepEqual(pairing.classifyClaimResponse(429, { ok: false, reason: 'locked' }), { ok: false, code: 'locked', retryAfterMs: 0 })
})

test('classifyClaimResponse: anything else is unexpected', () => {
  assert.equal(pairing.classifyClaimResponse(500, { ok: false }).code, 'unexpected')
  assert.equal(pairing.classifyClaimResponse(200, { ok: false, reason: 'bad-code' }).code, 'unexpected', 'status must agree with the body')
  assert.equal(pairing.classifyClaimResponse(200, { ok: true }).code, 'unexpected', 'a success WITHOUT a token is not one')
  assert.equal(pairing.classifyClaimResponse(200, '<html>not json</html>').code, 'unexpected')
  assert.equal(pairing.classifyClaimResponse(0, undefined).code, 'unexpected')
  assert.equal(pairing.classifyClaimResponse(404, { ok: true, token: 't' }).code, 'unexpected', '404 never counts as success')
})

// ---- classifyProbe -----------------------------------------------------------

test('classifyProbe: no HTTP answer at all is unreachable', () => {
  assert.equal(pairing.classifyProbe({ kind: 'error' }), 'unreachable')
})

test('classifyProbe: 401 means revoked, 403 relay-only means unexpected', () => {
  assert.equal(pairing.classifyProbe({ kind: 'response', status: 401, body: { ok: false, reason: 'unpaired' } }), 'revoked')
  assert.equal(pairing.classifyProbe({ kind: 'response', status: 401, body: undefined }), 'revoked', 'the body is irrelevant for 401')
  assert.equal(pairing.classifyProbe({ kind: 'response', status: 403, body: { ok: false, reason: 'relay-only' } }), 'unexpected')
})

test('classifyProbe: every other answered status counts as connected', () => {
  assert.equal(pairing.classifyProbe({ kind: 'response', status: 200, body: { ok: true } }), 'connected')
  assert.equal(pairing.classifyProbe({ kind: 'response', status: 404, body: { ok: false, error: { code: 'not-found' } } }), 'connected')
  assert.equal(pairing.classifyProbe({ kind: 'response', status: 403, body: { ok: false } }), 'connected', 'a 403 without relay-only is still an accepted token')
  assert.equal(pairing.classifyProbe({ kind: 'response', status: 403, body: undefined }), 'connected')
  assert.equal(pairing.classifyProbe({ kind: 'response', status: 500, body: undefined }), 'connected')
})
