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
const { toVirtual, fromVirtual, isVirtual, VIRTUAL_ID_PREFIX, encodeServerIdZeroWidth, decodeServerIdZeroWidth, VIRTUAL_GROUP_NAME_MARK } = require('../lib/virtual-id.js')

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

// ---- MS-4: the zero-width serverId encoding inside virtual group names ----
//
// The model menu classifies groups by heading text (T74); with several
// servers paired, the heading must also carry WHICH server a group came
// from. The scheme: WORD JOINER, then the 32 bits of the 8-hex serverId as
// ZERO WIDTH SPACE (0) / ZERO WIDTH NON-JOINER (1), MSB first per nibble,
// then a WORD JOINER terminator — all invisible.

const BIT0 = '\u200b'
const BIT1 = '\u200c'

/** The reference encoder the literals below pin against: 8 hex chars →
 * 32 invisible bits, MSB first per nibble, wrapped in the mark pair. */
function referenceEncode(serverId) {
  let bits = ''
  for (const nibble of serverId) {
    for (const bit of Number.parseInt(nibble, 16).toString(2).padStart(4, '0')) {
      bits += bit === '0' ? BIT0 : BIT1
    }
  }
  return `${VIRTUAL_GROUP_NAME_MARK}${bits}${VIRTUAL_GROUP_NAME_MARK}`
}

test('encodeServerIdZeroWidth: 8-hex server ids become mark + 32 invisible bits + mark', () => {
  assert.equal(encodeServerIdZeroWidth('721b94fb'), referenceEncode('721b94fb'))
  // The invisible alphabet, pinned literally: all-zero and all-one.
  assert.equal(encodeServerIdZeroWidth('00000000'), `${VIRTUAL_GROUP_NAME_MARK}${BIT0.repeat(32)}${VIRTUAL_GROUP_NAME_MARK}`)
  assert.equal(encodeServerIdZeroWidth('ffffffff'), `${VIRTUAL_GROUP_NAME_MARK}${BIT1.repeat(32)}${VIRTUAL_GROUP_NAME_MARK}`)
  // Exactly 32 zero-width chars between the two marks, nothing visible.
  const encoded = encodeServerIdZeroWidth('0fedcba9')
  assert.equal(encoded.length, 34)
  assert.ok(encoded.startsWith(VIRTUAL_GROUP_NAME_MARK))
  assert.ok(encoded.endsWith(VIRTUAL_GROUP_NAME_MARK))
  for (const ch of encoded.slice(1, -1)) {
    assert.ok(ch === BIT0 || ch === BIT1, 'only the two zero-width code points may sit between the marks')
  }
})

test('encodeServerIdZeroWidth: a non-8-hex server id degrades to the legacy single mark', () => {
  for (const junk of ['', 'abc', '1234567', '123456789', 'ABCDEF01', 'zzzzzzzz', null, undefined, 42]) {
    assert.equal(encodeServerIdZeroWidth(junk), VIRTUAL_GROUP_NAME_MARK, String(junk))
  }
})

test('decodeServerIdZeroWidth: round-trips every 8-hex shape and reads it out of a full heading', () => {
  for (const serverId of ['721b94fb', '00000000', 'ffffffff', '0fedcba9', 'deadbeef']) {
    assert.equal(decodeServerIdZeroWidth(encodeServerIdZeroWidth(serverId)), serverId, serverId)
  }
  // The exact shape mergeModelCatalogs produces: encoded prefix, then the
  // (visible) server name · group name — decode reads ONLY the prefix.
  const heading = `${encodeServerIdZeroWidth('721b94fb')}书房 · Codex`
  assert.equal(decodeServerIdZeroWidth(heading), '721b94fb')
})

test('decodeServerIdZeroWidth: everything that is not the exact encoding answers undefined', () => {
  // The legacy single-mark form (an un-encoded virtual group) must NOT
  // decode — the classifier reads that as "remote, server unknown".
  assert.equal(decodeServerIdZeroWidth(`${VIRTUAL_GROUP_NAME_MARK}书房 · Codex`), undefined)
  assert.equal(decodeServerIdZeroWidth(VIRTUAL_GROUP_NAME_MARK), undefined)
  // No mark at all — local headings, arbitrary text, junk.
  for (const text of ['', '书房 · Codex', 'local group', BIT0.repeat(32), null, undefined, 42]) {
    assert.equal(decodeServerIdZeroWidth(text), undefined, JSON.stringify(text))
  }
  // Near misses: 31 bits, 33 bits, visible text inside the window, no
  // terminator after the window, a visible char before the terminator.
  assert.equal(decodeServerIdZeroWidth(`${VIRTUAL_GROUP_NAME_MARK}${BIT0.repeat(31)}${VIRTUAL_GROUP_NAME_MARK}`), undefined, '31 bits')
  assert.equal(decodeServerIdZeroWidth(`${VIRTUAL_GROUP_NAME_MARK}${BIT0.repeat(33)}${VIRTUAL_GROUP_NAME_MARK}`), undefined, '33 bits')
  assert.equal(decodeServerIdZeroWidth(`${VIRTUAL_GROUP_NAME_MARK}x${BIT0.repeat(31)}${VIRTUAL_GROUP_NAME_MARK}`), undefined, 'visible char in the window')
  assert.equal(decodeServerIdZeroWidth(`${VIRTUAL_GROUP_NAME_MARK}${BIT1.repeat(32)}x`), undefined, 'no terminator right after the window')
})
