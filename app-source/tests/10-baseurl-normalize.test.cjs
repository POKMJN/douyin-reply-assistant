// 接口地址归一化测试：覆盖各种用户写法，尤其是 Gemini 兼容层与完整端点粘贴
const { test } = require('node:test')
const assert = require('node:assert')
require('./setup.cjs')
const { apiBase, normalizeBaseUrl, extractModelIds } = require('../electron/ai-service.cjs')

test('apiBase：裸域名/带版本/尾斜杠都归一到正确 base', () => {
  assert.equal(apiBase('https://api.deepseek.com'), 'https://api.deepseek.com/v1')
  assert.equal(apiBase('https://api.deepseek.com/'), 'https://api.deepseek.com/v1')
  assert.equal(apiBase('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1')
  assert.equal(apiBase('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1')
  assert.equal(apiBase('  https://api.xxx.com/v1  '), 'https://api.xxx.com/v1')
  assert.equal(apiBase('https://xxx.com/v2'), 'https://xxx.com/v2')
})

test('apiBase：漏写协议头自动补 https', () => {
  assert.equal(apiBase('api.deepseek.com'), 'https://api.deepseek.com/v1')
  assert.equal(apiBase('api.deepseek.com/v1'), 'https://api.deepseek.com/v1')
})

test('apiBase：直接粘完整端点时剥掉资源路径（不再拼出双份）', () => {
  assert.equal(apiBase('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1')
  assert.equal(apiBase('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1')
  assert.equal(apiBase('https://api.xxx.com/v1/models'), 'https://api.xxx.com/v1')
})

test('apiBase：/api 不算版本根，仍需补 /v1', () => {
  assert.equal(apiBase('https://xxx.com/api'), 'https://xxx.com/api/v1')
  assert.equal(apiBase('https://xxx.com/api/v1'), 'https://xxx.com/api/v1')
})

test('apiBase：Gemini 官方自动补全到 /v1beta/openai（本次修复的核心）', () => {
  const host = 'https://generativelanguage.googleapis.com'
  assert.equal(apiBase(`${host}/v1beta/openai`), `${host}/v1beta/openai`)
  assert.equal(apiBase(`${host}/v1beta/openai/`), `${host}/v1beta/openai`)
  assert.equal(apiBase(`${host}/v1beta/openai/chat/completions`), `${host}/v1beta/openai`)
  // 只填到 /v1beta 或裸域名，也自动补全，避免用户照文档抄一半
  assert.equal(apiBase(`${host}/v1beta`), `${host}/v1beta/openai`)
  assert.equal(apiBase(host), `${host}/v1beta/openai`)
})

test('apiBase：清掉从文档复制带来的中文标点与零宽字符', () => {
  assert.equal(apiBase('https://api.xxx.com/v1：'), 'https://api.xxx.com/v1')
  assert.equal(apiBase('\u200bhttps://api.xxx.com/v1\u200b'), 'https://api.xxx.com/v1')
})

test('apiBase：空输入返回空串', () => {
  assert.equal(apiBase(''), '')
  assert.equal(apiBase('   '), '')
  assert.equal(apiBase(null), '')
  assert.equal(apiBase(undefined), '')
})

test('normalizeBaseUrl：明显写错的地址抛错，正常地址归一化返回', () => {
  assert.equal(normalizeBaseUrl('api.deepseek.com'), 'https://api.deepseek.com/v1')
  assert.equal(normalizeBaseUrl('https://xxx.com/api/v1/chat/completions'), 'https://xxx.com/api/v1')
  assert.throws(() => normalizeBaseUrl('not a url'), /接口地址格式不正确/)
  assert.throws(() => normalizeBaseUrl('https://'), /接口地址格式不正确/)
  assert.equal(normalizeBaseUrl(''), '')
})

test('normalizeBaseUrl：localhost 与 IP 地址放行', () => {
  assert.equal(normalizeBaseUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1')
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1')
})

test('extractModelIds：兼容多种返回格式并去重', () => {
  assert.deepEqual(
    extractModelIds({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }),
    ['gpt-4o', 'gpt-4o-mini'],
  )
  assert.deepEqual(extractModelIds({ models: ['a', 'b'] }), ['a', 'b'])
  assert.deepEqual(extractModelIds(['x', 'y']), ['x', 'y'])
  // Gemini 原生格式带 models/ 前缀，需剥掉
  assert.deepEqual(extractModelIds({ data: [{ id: 'models/gemini-2.5-flash' }] }), ['gemini-2.5-flash'])
  // 对象里用 name / model 字段
  assert.deepEqual(extractModelIds({ data: [{ name: 'by-name' }, { model: 'by-model' }] }), ['by-name', 'by-model'])
  assert.deepEqual(extractModelIds({}), [])
  assert.deepEqual(extractModelIds(null), [])
})
