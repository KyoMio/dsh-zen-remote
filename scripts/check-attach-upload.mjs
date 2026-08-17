// Self-check for the S7 attachment plumbing that has no safe live test.
//
// The image path ends in `session.prompt(parts, 'queue')`, which SENDS a turn
// into a real session — so what is asserted here is the payload the component
// hands that call, not the call itself. The rest is the draft/URL string math
// that the phone depends on and no type checker can catch.
//
// Run: node scripts/check-attach-upload.mjs   (needs Node >= 23.6 type stripping)
import assert from 'node:assert/strict'
import {
  PROMPT_IMAGE_TYPES,
  UPLOAD_ROUTE,
  buildImageParts,
  bytesToBase64,
  draftWithMention,
  promptImageType,
  uploadUrl,
} from '../src/client/attach-upload.ts'

// ---- which files may be inlined as prompt images ---------------------------
// The host union is exactly these four (dsh-attachment types.d.ts:5).
assert.deepEqual([...PROMPT_IMAGE_TYPES], ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
assert.equal(promptImageType('image/png'), 'image/png')
// Browsers append parameters and vary the case.
assert.equal(promptImageType('image/JPEG; charset=binary'), 'image/jpeg')
// An iPhone camera roll hands over HEIC; the host cannot inline it, so it has
// to fall through to the upload route rather than be rejected.
assert.equal(promptImageType('image/heic'), undefined)
assert.equal(promptImageType('application/pdf'), undefined)
// A file the browser cannot type at all.
assert.equal(promptImageType(''), undefined)

// ---- the session.prompt payload -------------------------------------------
const png = { name: 'shot.png', mediaType: 'image/png', base64: 'AAAB' }
const jpg = { name: 'photo.jpg', mediaType: 'image/jpeg', base64: 'CCCD' }

// No draft: images only, in pick order.
assert.deepEqual(buildImageParts([png, jpg], ''), [
  { type: 'image', mediaType: 'image/png', data: 'AAAB', name: 'shot.png' },
  { type: 'image', mediaType: 'image/jpeg', data: 'CCCD', name: 'photo.jpg' },
])

// With a draft: the caption leads, so the model reads it before the pictures.
assert.deepEqual(buildImageParts([png], 'look at this'), [
  { type: 'text', text: 'look at this' },
  { type: 'image', mediaType: 'image/png', data: 'AAAB', name: 'shot.png' },
])

// Whitespace-only draft contributes no text part (an empty text block is not
// something the user asked to send).
assert.deepEqual(buildImageParts([png], '   \n '), [
  { type: 'image', mediaType: 'image/png', data: 'AAAB', name: 'shot.png' },
])

// Nothing picked, nothing typed -> nothing to send.
assert.deepEqual(buildImageParts([], ''), [])

// ---- base64 ----------------------------------------------------------------
// Must match the host's decoder byte for byte, and must survive a payload
// bigger than one 32KB chunk (the reason the loop exists at all).
const big = new Uint8Array(70000)
for (let i = 0; i < big.length; i += 1) big[i] = i % 256
assert.equal(bytesToBase64(big), Buffer.from(big).toString('base64'))
assert.equal(bytesToBase64(new Uint8Array([0, 255, 16])), Buffer.from([0, 255, 16]).toString('base64'))
assert.equal(bytesToBase64(new Uint8Array(0)), '')

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
assert.equal(draftWithMention('', '.dsh-uploads/a.pdf'), '@.dsh-uploads/a.pdf ')
// A word already in the draft gets a separating space...
assert.equal(draftWithMention('read', '.dsh-uploads/a.pdf'), 'read @.dsh-uploads/a.pdf ')
// ...but an existing trailing space or newline is not doubled.
assert.equal(draftWithMention('read ', '.dsh-uploads/a.pdf'), 'read @.dsh-uploads/a.pdf ')
assert.equal(draftWithMention('read\n', '.dsh-uploads/a.pdf'), 'read\n@.dsh-uploads/a.pdf ')
// Two files in one pick stay in order and stay separated.
assert.equal(
  draftWithMention(draftWithMention('', '.dsh-uploads/a.pdf'), '.dsh-uploads/b.zip'),
  '@.dsh-uploads/a.pdf @.dsh-uploads/b.zip ',
)

console.log('ATTACH UPLOAD CHECK OK')
