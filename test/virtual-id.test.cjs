/* dsh-zen-remote · virtual ids (src/virtual-id.ts, T23b-1)
 *
 * The whole interception rests on this mapping being losslessly reversible
 * for ANY original id (session ids, workspace ids — arbitrary uuid strings,
 * and the spike proved ids with `~`, `:` and `/` render and open fine), so
 * these tests pin the round trip, the strict skeleton check (8 lowercase
 * hex, no less, no more) and the exact set of near-miss strings that must
 * NOT parse. `fromVirtual` accepts unknown-typed input on purpose — values
 * read out of wire payloads are untyped at the boundary.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { toVirtual, fromVirtual, isVirtual, VIRTUAL_ID_PREFIX } = require('../lib/virtual-id.js')

test('toVirtual/fromVirtual round trip', () => {
  assert.equal(toVirtual('721b94fb', 'session-712828e2-492f-4ad1-8a88-ece10ecc4cc0'), 'zr~721b94fb~session-712828e2-492f-4ad1-8a88-ece10ecc4cc0')
  assert.deepEqual(fromVirtual('zr~721b94fb~session-712828e2-492f-4ad1-8a88-ece10ecc4cc0'), {
    serverId: '721b94fb',
    id: 'session-712828e2-492f-4ad1-8a88-ece10ecc4cc0',
  })
  // Workspaces share the same shape — nothing session-specific here.
  const workspace = toVirtual('0123abcd', '9e7f4c2a-1111-2222-3333-444455556666')
  assert.deepEqual(fromVirtual(workspace), { serverId: '0123abcd', id: '9e7f4c2a-1111-2222-3333-444455556666' })
})

test('the original id may contain any characters, `~` included', () => {
  const weird = 'we~ird:id/with，中文 and emoji 🎛'
  const virtual = toVirtual('deadbeef', weird)
  assert.deepEqual(fromVirtual(virtual), { serverId: 'deadbeef', id: weird })
  // A second `~` right after the prefix belongs to the ORIGINAL id only
  // after the 8-hex + separator skeleton; parsing never splits on `~` again.
  assert.deepEqual(fromVirtual('zr~cafe0123~~leading-tilde'), { serverId: 'cafe0123', id: '~leading-tilde' })
  // The empty remainder is legal by the grammar (toVirtual never produces
  // one in practice, but the parser stays total).
  assert.deepEqual(fromVirtual('zr~cafe0123~'), { serverId: 'cafe0123', id: '' })
})

test('isVirtual agrees with fromVirtual', () => {
  assert.equal(isVirtual(toVirtual('ab12cd34', 'session-x')), true)
  assert.equal(isVirtual('session-plain'), false)
  for (const junk of ['', 'zr~', 'session-1', null, undefined, 42, {}, ['zr~ab12cd34~x']]) {
    assert.equal(isVirtual(junk), false, String(typeof junk) + ' ' + String(junk))
  }
})

test('malformed skeletons are refused, reason by reason', () => {
  for (const [id, why] of [
    ['zr', 'prefix alone'],
    ['zr~', 'prefix with separator only'],
    ['zr~1234567~x', '7 hex chars'],
    ['zr~123456789~x', '9 hex chars is server id + id start, not a server id'],
    ['zr~1234567~', '7 hex and nothing else'],
    ['zr~ABCDEFGH~x', 'uppercase hex'],
    ['zr~12345678x', 'missing the separating ~'],
    ['zr~1234567', 'too short overall'],
    ['zr~~12345678~x', 'empty server id'],
    ['zr~123456g8~x', 'non-hex char'],
    ['zr~12345678', 'no remainder at all'],
    ['Zr~12345678~x', 'wrong prefix case'],
    [' zr~12345678~x', 'leading space'],
    ['xr~12345678~x', 'wrong prefix letter'],
    ['zr~12345678~x'.slice(1), 'missing the leading z'],
  ]) {
    assert.equal(fromVirtual(id), undefined, `${why}: ${JSON.stringify(id)}`)
    assert.equal(isVirtual(id), false, why)
  }
})

test('the prefix constant stays the wire contract', () => {
  assert.equal(VIRTUAL_ID_PREFIX, 'zr~')
})
