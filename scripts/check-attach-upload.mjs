// Self-check for the S7 attachment plumbing.
//
// The interesting logic is all string math now: the composer draft is the
// feature's only state, so "which chips are showing" is entirely decided by
// what mentionsIn() reads out of the draft text, and the × button is entirely
// draftWithoutMention(). Both are exercised here, including the round trip
// that the UI depends on (add N, remove them one by one, land back on '').
//
// S7.1 deleted the MIME-sorting assertions that used to live here: there is no
// image/non-image split any more — every attachment takes the upload route.
//
// Run: node scripts/check-attach-upload.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import {
  UPLOAD_DIR,
  UPLOAD_ROUTE,
  draftWithMention,
  draftWithoutMention,
  leafOf,
  mentionsIn,
  middleEllipsis,
  uploadUrl,
} from '../src/client/attach-upload.ts'

// ---- the upload URL --------------------------------------------------------
// Root-relative (so the gateway's pairing cookie rides along) and fully
// escaped: a filename with a space, an ampersand, or CJK must not be able to
// forge a second query parameter.
assert.equal(uploadUrl('session-1', 'a.txt'), `${UPLOAD_ROUTE}?session=session-1&name=a.txt`)
assert.equal(
  uploadUrl('session-2', 'my notes&session=evil.txt'),
  `${UPLOAD_ROUTE}?session=session-2&name=my+notes%26session%3Devil.txt`,
)
assert.equal(new URL(uploadUrl('s', '../../etc/passwd'), 'http://x').searchParams.get('name'), '../../etc/passwd')
assert.equal(new URL(uploadUrl('s', '照片.jpg'), 'http://x').searchParams.get('name'), '照片.jpg')

// ---- appending @mentions to the draft --------------------------------------
const a = `${UPLOAD_DIR}/a.pdf`
const b = `${UPLOAD_DIR}/b.zip`

assert.equal(draftWithMention('', a), '@.dsh-uploads/a.pdf ')
// A word already in the draft gets a separating space...
assert.equal(draftWithMention('read', a), 'read @.dsh-uploads/a.pdf ')
// ...but an existing trailing space or newline is not doubled.
assert.equal(draftWithMention('read ', a), 'read @.dsh-uploads/a.pdf ')
assert.equal(draftWithMention('read\n', a), 'read\n@.dsh-uploads/a.pdf ')
// Two files in one pick stay in order and stay separated.
assert.equal(draftWithMention(draftWithMention('', a), b), '@.dsh-uploads/a.pdf @.dsh-uploads/b.zip ')

// ---- reading the chips back out of the draft -------------------------------
assert.deepEqual(mentionsIn(''), [])
assert.deepEqual(mentionsIn('just some prose'), [])
assert.deepEqual(mentionsIn('@.dsh-uploads/a.pdf '), [a])
// Reading order, with the user's own words interleaved.
assert.deepEqual(mentionsIn('look at @.dsh-uploads/a.pdf and @.dsh-uploads/b.zip please'), [a, b])
// A pasted duplicate must not produce two chips with the same React key.
assert.deepEqual(mentionsIn('@.dsh-uploads/a.pdf @.dsh-uploads/a.pdf'), [a])
// Other @-mentions (dsh-at-file's workspace references) are not ours.
assert.deepEqual(mentionsIn('@src/index.ts @.dsh-uploads/a.pdf'), [a])
// The directory name is matched literally — the `.` is not a wildcard.
assert.deepEqual(mentionsIn('@Xdsh-uploads/a.pdf'), [])

// ---- the × button ----------------------------------------------------------
// Removing the only attachment leaves an empty draft, so the chip row and the
// composer both go clean.
assert.equal(draftWithoutMention('@.dsh-uploads/a.pdf ', a), '')
// Removing one of two leaves the other, with no double space where it was.
assert.equal(draftWithoutMention('@.dsh-uploads/a.pdf @.dsh-uploads/b.zip ', a), '@.dsh-uploads/b.zip ')
assert.equal(draftWithoutMention('read @.dsh-uploads/a.pdf please', a), 'read please')
// Prose survives even when it is the only thing left.
assert.equal(draftWithoutMention('read @.dsh-uploads/a.pdf ', a), 'read ')
// Removing something that is not there is a no-op.
assert.equal(draftWithoutMention('read @.dsh-uploads/a.pdf ', b), 'read @.dsh-uploads/a.pdf ')

// Full round trip: what the user sees after adding two and dismissing both.
let draft = draftWithMention(draftWithMention('photos:', a), b)
assert.deepEqual(mentionsIn(draft), [a, b])
draft = draftWithoutMention(draft, a)
assert.deepEqual(mentionsIn(draft), [b])
draft = draftWithoutMention(draft, b)
assert.deepEqual(mentionsIn(draft), [])
// The separator space added before the first mention stays: the user is still
// typing into this draft, and silently trimming under the caret is worse than
// one trailing space.
assert.equal(draft, 'photos: ')

// ---- chip labels -----------------------------------------------------------
assert.equal(leafOf(`${UPLOAD_DIR}/report.pdf`), 'report.pdf')
assert.equal(leafOf('report.pdf'), 'report.pdf')
// Short names are untouched; long ones lose their MIDDLE so the extension —
// the part that says what the file IS — always survives.
assert.equal(middleEllipsis('a.pdf'), 'a.pdf')
const long = middleEllipsis('quarterly-revenue-breakdown-2026.pdf')
assert.equal(long.length, 18)
assert.ok(long.startsWith('quarterly'), long)
assert.ok(long.endsWith('.pdf'), long)
assert.ok(long.includes('…'))

console.log('ATTACH UPLOAD CHECK OK')
