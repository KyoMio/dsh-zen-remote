/* dsh-zen-remote · sameOriginPost (src/http.ts, T16-fix 2)
 *
 * The state-changing gate every browser-facing POST applies. The matrix the
 * T16-fix review pinned:
 *
 * - BOTH `Origin` and `Sec-Fetch-Site` missing → ACCEPT: the desktop app's
 *   main process strips both after verifying its own `dsh-app://app` origin
 *   (its forwardWebRequest), and curl-style local tools send neither; such
 *   requests are not browser-direct and must still pass connection.admit.
 * - `Sec-Fetch-Site: cross-site` → refuse, with or without Origin.
 * - `Origin` present → must agree with `Host` (protocol http/https, same
 *   host:port); anything else refused.
 * - `Origin` absent, Fetch metadata present → the old same-origin family.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const HTTP_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'http.js')).href

let sameOriginPost
test.before(async () => { ;({ sameOriginPost } = await import(HTTP_URL)) })

const req = (headers) => ({ headers })

test('both Origin and Sec-Fetch-Site missing: accepted (desktop forward, local tools)', () => {
  assert.equal(sameOriginPost(req({})), true)
  assert.equal(sameOriginPost(req({ host: '127.0.0.1:3080' })), true, 'a bare Host does not make it cross-site')
  assert.equal(sameOriginPost(req({ cookie: 'dsh-auth-x=v' })), true, 'the desktop forward replaces cookies, still no fetch headers')
})

test('Sec-Fetch-Site: cross-site refuses with and without Origin', () => {
  assert.equal(sameOriginPost(req({ 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(sameOriginPost(req({ 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })), false)
})

test('Origin must agree with Host; a mismatched or malformed Origin refuses', () => {
  assert.equal(sameOriginPost(req({ origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })), true)
  // The Host header carries no scheme, so the comparison is host:port only —
  // the origin just has to BE an http(s) URL.
  assert.equal(sameOriginPost(req({ origin: 'https://127.0.0.1:3080', host: '127.0.0.1:3080' })), true)
  assert.equal(sameOriginPost(req({ origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3081' })), false, 'port is part of the origin')
  assert.equal(sameOriginPost(req({ origin: 'https://evil.example', host: '127.0.0.1:3080' })), false)
  assert.equal(sameOriginPost(req({ origin: 'not a url', host: '127.0.0.1:3080' })), false)
  assert.equal(sameOriginPost(req({ origin: 'ftp://127.0.0.1:3080', host: '127.0.0.1:3080' })), false, 'non-http(s) origin refuses')
  assert.equal(sameOriginPost(req({ origin: 'http://127.0.0.1:3080' })), false, 'Origin without Host cannot be checked')
})

test('Origin absent with Fetch metadata keeps the old same-origin family', () => {
  assert.equal(sameOriginPost(req({ 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(sameOriginPost(req({ 'sec-fetch-site': 'same-site' })), true)
  assert.equal(sameOriginPost(req({ 'sec-fetch-site': 'none' })), true)
  assert.equal(sameOriginPost(req({ 'sec-fetch-site': 'unexpectable-value' })), false)
})
