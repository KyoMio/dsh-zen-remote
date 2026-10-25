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
import fs from 'node:fs'
import {
  UPLOAD_DIR,
  UPLOAD_ROUTE,
  appendDraftOf,
  draftWithMention,
  draftWithoutMention,
  leafOf,
  mentionsIn,
  middleEllipsis,
  uploadUrl,
  writeMention,
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

// ---- writing mentions: appendDraft when the host has it, else setDraft ------
// DSH <= 0.2.1-rc.2 (and the rc.3 public inputActions face): setDraft only.
{
  const calls = []
  const legacy = { setDraft: (text) => calls.push(['set', text]) }
  assert.equal(appendDraftOf(legacy), undefined)
  const first = writeMention(legacy, 'read', a)
  assert.equal(first, 'read @.dsh-uploads/a.pdf ')
  const second = writeMention(legacy, first, b)
  assert.equal(second, 'read @.dsh-uploads/a.pdf @.dsh-uploads/b.zip ')
  assert.deepEqual(calls, [['set', first], ['set', second]])
}
// A host whose action face carries appendDraft: only the token is appended,
// setDraft is never touched, and `this` stays bound to the action face.
{
  const calls = []
  const modern = {
    draft: 'keep my @src/index.ts reference',
    setDraft(text) { calls.push(['set', text]) },
    appendDraft(text) { calls.push(['append', text, this === modern]) },
  }
  assert.equal(typeof appendDraftOf(modern), 'function')
  assert.equal(writeMention(modern, modern.draft, a), modern.draft)
  writeMention(modern, modern.draft, b)
  assert.deepEqual(calls, [['append', '@.dsh-uploads/a.pdf ', true], ['append', '@.dsh-uploads/b.zip ', true]])
}
// A non-function appendDraft is not an interface: fall back.
{
  const calls = []
  const odd = { appendDraft: true, setDraft: (text) => calls.push(text) }
  assert.equal(appendDraftOf(odd), undefined)
  writeMention(odd, '', a)
  assert.deepEqual(calls, ['@.dsh-uploads/a.pdf '])
}

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

// ---- static regression: the #31 attach restore ------------------------------
// The host-attach stand-down is gone for good (#31: DSH 0.2.x kept the hidden
// <input type="file"> after moving the paperclip into the "+" menu, so the
// probe matched everywhere and the phone lost its only attach affordance).
// The probe file must stay deleted, the two components must not reference it,
// and composer.css.ts must keep hiding the second official _add paperclip
// that DSH ≤ 0.1.5 still renders below 768px.
assert.equal(
  fs.existsSync(new URL('../src/client/host-attach.ts', import.meta.url)),
  false,
  'src/client/host-attach.ts must stay deleted (the removed stand-down probe)',
)
for (const rel of ['../src/client/MobileAttachButton.tsx', '../src/client/MobileAttachChips.tsx']) {
  const source = fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
  assert.ok(
    !source.includes('useOwnAttachUi') && !source.includes('host-attach'),
    `${rel} must not reference the removed host-attach stand-down`,
  )
}
// The hide rule must live in the PHONE media block only — desktop (>= 768px)
// keeps the official paperclip untouched, so match inside the 767px block.
const composer = fs.readFileSync(new URL('../src/client/styles/composer.css.ts', import.meta.url), 'utf8')
const phoneStart = composer.indexOf('@media (max-width: 767px)')
const phoneEnd = composer.indexOf('@media (min-width: 768px)')
assert.ok(
  phoneStart !== -1 && phoneEnd !== -1 && phoneStart < phoneEnd,
  'composer.css.ts phone/desktop media blocks not found in expected order',
)
assert.match(
  composer.slice(phoneStart, phoneEnd),
  /\$\{ROW\} > \[class\$\="_tools"\] > button\[class\$\="_add"\]:nth-of-type\(2\)\s*\{[^}]*display: none !important/,
  'composer.css.ts must hide the second official _add paperclip below 768px (#31)',
)
// The subagent gate must stay: the host disables its own file input while a
// subagent session is open, so ours stands down with it (#31 review).
assert.ok(
  fs.readFileSync(new URL('../src/client/MobileAttachButton.tsx', import.meta.url), 'utf8')
    .includes("row?.origin === 'subagent'"),
  'MobileAttachButton must gate the paperclip off on subagent sessions',
)

console.log('ATTACH UPLOAD CHECK OK')
