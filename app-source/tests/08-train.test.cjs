// 训练场学习链路测试：recordConversationMessage 的风格归因（human 分流）
const { test } = require('node:test')
const assert = require('node:assert')
require('./setup.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { AiService } = require('../electron/ai-service.cjs')
const { createMemoryStorage } = require('./setup.cjs')

function makeService() {
  const storage = createMemoryStorage({})
  const ai = new AiService(storage, { transport: async () => ({ choices: [{ message: { content: '好的' } }] }) })
  const ds = new DouyinService({ storage, ai, partition: 'persist:test', emit: () => {} })
  return { ds, storage }
}

test('训练学习：用户示范进风格统计与历史，AI 原文只进历史', () => {
  const { ds, storage } = makeService()
  // 用户示范（human:true）
  ds.recordConversationMessage('训练·朋友', 'me', '咱就是说这瓜保熟吗', {}, { human: true })
  let s = storage.get()
  const c1 = s.contacts.find((c) => c.name === '训练·朋友')
  assert.equal(c1.learning.messages.at(-1).text, '咱就是说这瓜保熟吗')
  assert.ok(c1.learning.styleMessages.some((m) => m.text === '咱就是说这瓜保熟吗'), '用户示范进风格')
  assert.ok(c1.learning.ownerStyle.summary.includes('短句') || c1.learning.ownerStyle.sampleCount >= 1)
  // AI 原文（human:false）
  ds.recordConversationMessage('训练·朋友', 'me', '这个瓜它是保熟的', {}, { human: false })
  s = storage.get()
  const c2 = s.contacts.find((c) => c.name === '训练·朋友')
  assert.ok(c2.learning.messages.some((m) => m.text === '这个瓜它是保熟的'), 'AI 原文进对话历史')
  assert.ok(!c2.learning.styleMessages.some((m) => m.text === '这个瓜它是保熟的'), 'AI 原文不进风格（防 AI 学自己）')
})

test('训练学习：对方消息也进风格（对方的说法用于理解语境）', () => {
  const { ds, storage } = makeService()
  ds.recordConversationMessage('训练·朋友', 'contact', '你说是不是啊哈哈', {}, { human: true })
  const s = storage.get()
  const c = s.contacts.find((x) => x.name === '训练·朋友')
  assert.ok(c.learning.styleMessages.some((m) => m.role === 'contact'))
})

test('训练学习：多次示范累积 ownerStyle 样本', () => {
  const { ds, storage } = makeService()
  for (const text of ['我去', '真的假的', '笑不活了', '稳住别慌', '先吃饭再说']) {
    ds.recordConversationMessage('训练·朋友', 'me', text, {}, { human: true })
  }
  const c = storage.get().contacts.find((x) => x.name === '训练·朋友')
  assert.ok(c.learning.ownerStyle.sampleCount >= 5, `样本应 ≥5，实际 ${c.learning.ownerStyle.sampleCount}`)
})
