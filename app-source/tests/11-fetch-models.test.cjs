// 获取模型列表测试：注入 fake transport，覆盖成功/多种格式/各类失败分支
const { test } = require('node:test')
const assert = require('node:assert')
require('./setup.cjs')
const { AiService } = require('../electron/ai-service.cjs')
const { createMemoryStorage } = require('./setup.cjs')

// 把明文 key 伪装成 saveProvider 存库时的 keyCipher 形态（base64(stub:key)）
const cipherFor = (key) => Buffer.from(`stub:${key}`, 'utf8').toString('base64')

function makeService(transport, providers = []) {
  const storage = createMemoryStorage({ providers })
  return { ai: new AiService(storage, { transport }), storage }
}

const okTransport = (payload) => async () => payload

function failTransport(statusCode, message = `HTTP ${statusCode}`) {
  return async () => { const error = new Error(message); error.statusCode = statusCode; throw error }
}

test('fetchModels：正常返回 OpenAI 格式，拼 {base}/models 且带 Bearer', async () => {
  const calls = []
  const transport = async (url, options) => {
    calls.push({ url, options })
    return { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }
  }
  const { ai } = makeService(transport)
  const result = await ai.fetchModels({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' })

  assert.equal(result.ok, true)
  assert.deepEqual(result.models, ['gpt-4o', 'gpt-4o-mini'])
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test')
})

test('fetchModels：baseUrl 走归一化（裸域名自动补 /v1）', async () => {
  const calls = []
  const { ai } = makeService(async (url) => { calls.push(url); return { data: [{ id: 'm' }] } })
  await ai.fetchModels({ baseUrl: 'api.deepseek.com', apiKey: 'sk-test' })
  assert.equal(calls[0], 'https://api.deepseek.com/v1/models')
})

test('fetchModels：Gemini 兼容地址归一到 /v1beta/openai/models', async () => {
  const calls = []
  const { ai } = makeService(async (url) => { calls.push(url); return { data: [{ id: 'models/gemini-2.5-flash' }] } })
  const result = await ai.fetchModels({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'sk-test' })
  assert.equal(calls[0], 'https://generativelanguage.googleapis.com/v1beta/openai/models')
  assert.deepEqual(result.models, ['gemini-2.5-flash'])
})

test('fetchModels：401 → API Key 无效', async () => {
  const { ai } = makeService(failTransport(401, 'unauthorized'))
  const result = await ai.fetchModels({ baseUrl: 'https://api.xxx.com/v1', apiKey: 'bad' })
  assert.equal(result.ok, false)
  assert.match(result.message, /API Key 无效/)
})

test('fetchModels：404 → 提示不支持模型列表，请手动填写', async () => {
  const { ai } = makeService(failTransport(404, 'not found'))
  const result = await ai.fetchModels({ baseUrl: 'https://api.xxx.com/v1', apiKey: 'sk-test' })
  assert.equal(result.ok, false)
  assert.match(result.message, /不支持模型列表/)
})

test('fetchModels：网络异常 → 返回可读失败原因', async () => {
  const { ai } = makeService(async () => { const error = new Error('socket hang up'); error.retryable = true; throw error })
  const result = await ai.fetchModels({ baseUrl: 'https://api.xxx.com/v1', apiKey: 'sk-test' })
  assert.equal(result.ok, false)
  assert.match(result.message, /获取模型列表失败/)
})

test('fetchModels：空 baseUrl / 无 Key（非本地）分别给出提示', async () => {
  const { ai } = makeService(okTransport({ data: [] }))
  assert.match((await ai.fetchModels({ baseUrl: '', apiKey: 'sk' })).message, /请先填写接口地址/)
  assert.match((await ai.fetchModels({ baseUrl: 'https://api.xxx.com/v1', apiKey: '' })).message, /请先填写 API Key/)
})

test('fetchModels：localhost 无 Key 也放行', async () => {
  const calls = []
  const { ai } = makeService(async (url) => { calls.push(url); return { data: [{ id: 'local-model' }] } })
  const result = await ai.fetchModels({ baseUrl: 'http://localhost:1234/v1', apiKey: '' })
  assert.equal(result.ok, true)
  assert.equal(calls[0], 'http://localhost:1234/v1/models')
})

test('fetchModels：编辑已有模型且输入框没填 Key 时，沿用库里已存的 Key', async () => {
  const providers = [{ name: '主力', model: 'm', baseUrl: 'https://api.xxx.com/v1', keyCipher: cipherFor('sk-stored') }]
  const calls = []
  const { ai } = makeService(async (url, options) => { calls.push({ url, options }); return { data: [{ id: 'm' }] } }, providers)
  const result = await ai.fetchModels({ baseUrl: 'https://api.xxx.com/v1', apiKey: '', index: 0 })
  assert.equal(result.ok, true)
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-stored')
})

test('fetchModels：接口返回空列表 → 提示手动填写', async () => {
  const { ai } = makeService(okTransport({ data: [] }))
  const result = await ai.fetchModels({ baseUrl: 'https://api.xxx.com/v1', apiKey: 'sk-test' })
  assert.equal(result.ok, false)
  assert.match(result.message, /未返回模型列表/)
})

test('saveProvider：保存时归一化 baseUrl 并校验', () => {
  const { ai } = makeService(okTransport({}))
  const saved = ai.saveProvider({ name: 'x', model: 'm', baseUrl: 'api.deepseek.com/v1/chat/completions', apiKey: 'sk' })
  assert.equal(saved.providers[0].baseUrl, 'https://api.deepseek.com/v1')
  assert.throws(() => ai.saveProvider({ name: 'y', model: 'm', baseUrl: 'not a url' }), /接口地址格式不正确/)
})
