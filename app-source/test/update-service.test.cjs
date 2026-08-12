const { test } = require('node:test')
const assert = require('node:assert')
const { parseVersion, isNewer } = require('../electron/update-service.cjs')

test('parseVersion 解析 v0.5.0 与 0.10.2', () => {
  assert.deepStrictEqual(parseVersion('v0.5.0'), [0, 5, 0])
  assert.deepStrictEqual(parseVersion('0.10.2'), [0, 10, 2])
})

test('parseVersion 无法解析时返回 null', () => {
  assert.strictEqual(parseVersion('abc'), null)
  assert.strictEqual(parseVersion(''), null)
  assert.strictEqual(parseVersion(null), null)
  assert.strictEqual(parseVersion(undefined), null)
})

test('isNewer 识别更高版本', () => {
  assert.strictEqual(isNewer('v0.6.0', '0.5.0'), true)
  assert.strictEqual(isNewer('v0.5.1', '0.5.0'), true)
  assert.strictEqual(isNewer('v1.0.0', '0.9.9'), true)
})

test('isNewer 不识别相同或更低版本', () => {
  assert.strictEqual(isNewer('v0.5.0', '0.5.0'), false)
  assert.strictEqual(isNewer('v0.4.9', '0.5.0'), false)
  assert.strictEqual(isNewer('v0.5.0', '0.6.0'), false)
})

test('isNewer 对无法解析的输入返回 false', () => {
  assert.strictEqual(isNewer('latest', '0.5.0'), false)
  assert.strictEqual(isNewer('v0.6.0', 'unknown'), false)
})
