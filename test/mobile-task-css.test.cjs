const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const headerCss = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'client', 'styles', 'header.css.ts'),
  'utf8',
)

test('phone header keeps native task action roots visible and positioned for their menus', () => {
  const taskRootRule = /\[data-phase\] header \[data-slot="conversation\.session\.header\.actions"\] > \[class\$="_root"\]:has\(> button\[class\$="_trigger"\]\)\s*\{([\s\S]*?)\}/
  const match = headerCss.match(taskRootRule)

  assert.ok(match, 'the phone stylesheet must explicitly address native task action roots')
  assert.match(match[1], /display:\s*(?:block|inline-flex)\s*!important/)
  assert.match(match[1], /position:\s*relative\s*!important/)
})
