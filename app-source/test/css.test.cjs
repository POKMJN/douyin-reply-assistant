const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('settings toggles keep fixed switch dimensions', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'dist', 'enhancements.css'), 'utf8')

  assert.match(css, /\.setting-row input\[type=checkbox\]/)
  assert.match(css, /appearance:\s*none/)
  assert.match(css, /height:\s*20px/)
  assert.match(css, /transform:\s*translateX\(16px\)/)
  assert.match(css, /border-radius:\s*999px/)
})
