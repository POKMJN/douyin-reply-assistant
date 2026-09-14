// 轮次流程组合测试：按 runAutomation 的判定顺序（角色 → 回声守卫 → 引擎闸门 → AI draft）
// 模拟多轮轮询，验证"开启自动回复后不会说个不停"。
const { test } = require('node:test')
const assert = require('node:assert')
require('./setup.cjs')
const { MIN_AUTO_REPLY_GAP_MS, shouldAutoReply } = require('../electron/conversation-engine.cjs')
const { AiService } = require('../electron/ai-service.cjs')
const { createMemoryStorage } = require('./setup.cjs')

const PROVIDER = { name: '主力', model: 'test-model', baseUrl: 'https://api.test/v1', capabilities: [] }

// 复刻 runAutomation 中每联系人每轮的判定序列（顺序一致），
// aiCalls 计数代表实际发出的 AI 调用（= 自动回复次数）。
async function simulateTicks({ snapshots, draftReply = '好呀，一起' }) {
  const storage = createMemoryStorage({ providers: [PROVIDER] })
  const contactRecord = {
    id: 'c1', name: '小明',
    profile: {},
    learning: { messages: [], facts: [], topicLog: [], mediaLog: [] },
  }
  storage.update({ contacts: [contactRecord] })
  let aiCalls = 0
  const ai = new AiService(storage, {
    transport: async () => {
      aiCalls += 1
      return { choices: [{ message: { content: draftReply } }] }
    },
  })
  const lastSent = new Map()
  let contact = contactRecord

  for (const snap of snapshots) {
    const key = snap.preview
    // 模拟轮询之间的时间流逝（真实场景每轮相隔数秒到数分钟）
    if (snap.ageMs && contact.turn?.lastOutgoingAt) {
      contact = { ...contact, turn: { ...contact.turn, lastOutgoingAt: contact.turn.lastOutgoingAt - snap.ageMs } }
    }
    if (snap.roleUnknown) {
      // fromMe !== false → 不回复、不消费（真实代码 continue）
      continue
    }
    // 我方回声守卫（真实代码内联逻辑）
    const lastSentText = String(lastSent.get('小明') || '').replace(/\s+/g, ' ').trim()
    const previewText = String(snap.preview || '').replace(/\s+/g, ' ').trim()
    if (lastSentText && (previewText === lastSentText || previewText.startsWith(lastSentText) || previewText.includes('【AI · '))) {
      continue
    }
    // 引擎闸门
    const gate = shouldAutoReply(contact, { key, fromMe: false })
    if (!gate.ok) continue
    // AI draft（真实调用）
    let replyText = ''
    try {
      const draft = await ai.draft({ contact, incoming: key })
      if (draft?.ok && draft.labeledText) {
        replyText = draft.labeledText
      }
    } catch { /* 与真实逻辑一致：失败不消费，下轮重试 */ }
    if (!replyText) continue
    // 发送成功：更新 lastSeen + turn（与真实代码一致）
    lastSent.set('小明', replyText)
    const turn = { ...(contact.turn || {}), lastHandledKey: key, lastOutgoingAt: Date.now() }
    contact = { ...contact, turn }
    storage.update({ contacts: [contact] })
  }
  return { aiCalls, storage, contact }
}

test('场景A：开启自动回复，对方发一条消息，轮询 50 轮只回复 1 次（核心回归）', async () => {
  const snapshots = Array.from({ length: 50 }, (_, i) => ({ preview: '在吗在干嘛', roleUnknown: false, seenBefore: i > 0 }))
  const { aiCalls } = await simulateTicks({ snapshots })
  assert.equal(aiCalls, 1, `50 轮轮询应只调用 1 次 AI，实际 ${aiCalls}`)
})

test('场景B：我方回复后预览变成自己的回显（AI 标签），不会再次触发', async () => {
  const snapshots = [
    { preview: '周末出来玩吗', roleUnknown: false },
    { preview: '【AI · test-model】好呀，一起', roleUnknown: true }, // 自己发的，角色判定不稳
    { preview: '【AI · test-model】好呀，一起', roleUnknown: true },
    { preview: '【AI · test-model】好呀，一起', roleUnknown: false },
    { preview: '【AI · test-model】好呀，一起', roleUnknown: false },
  ]
  const { aiCalls } = await simulateTicks({ snapshots })
  assert.equal(aiCalls, 1, '自己的回显绝不能再触发回复')
})

test('场景C：对方接着发新消息 → 恰好再回复 1 次', async () => {
  const snapshots = [
    { preview: '周末出来玩吗', roleUnknown: false },
    { preview: '【AI · test-model】好呀，一起', roleUnknown: true },
    { preview: '去哪玩你说', roleUnknown: false, ageMs: MIN_AUTO_REPLY_GAP_MS + 1000 },
    { preview: '去哪玩你说', roleUnknown: false },
    { preview: '【AI · test-model】好呀，一起', roleUnknown: true },
  ]
  const { aiCalls } = await simulateTicks({ snapshots })
  assert.equal(aiCalls, 2, '两条来消息各回复一次')
})

test('场景D：AI 全挂时消息保留，恢复后只发一次', async () => {
  const storage = createMemoryStorage({ providers: [PROVIDER] })
  let fail = true
  let aiCalls = 0
  const ai = new AiService(storage, {
    transport: async () => {
      aiCalls += 1
      if (fail) { const e = new Error('接口故障'); e.statusCode = 503; e.retryable = false; throw e }
      return { choices: [{ message: { content: '恢复后的回复' } }] }
    },
  })
  let contact = { id: 'c1', name: '小明', profile: {}, learning: { messages: [], facts: [], topicLog: [], mediaLog: [] } }
  storage.update({ contacts: [contact] })
  const ticks = ['周六有空吗？', '周六有空吗？', '周六有空吗？']
  for (const preview of ticks) {
    const gate = shouldAutoReply(contact, { key: preview, fromMe: false })
    if (!gate.ok) continue
    try {
      const result = await ai.draft({ contact, incoming: preview })
      if (result.ok && result.text) {
        contact = { ...contact, turn: { lastHandledKey: preview, lastOutgoingAt: Date.now() } }
        storage.update({ contacts: [contact] })
      }
    } catch { /* AI 失败不消费，下轮重试 */ }
    fail = false // 第二轮起恢复
  }
  assert.equal(aiCalls, 2, '失败 1 次 + 恢复成功 1 次')
  assert.equal(contact.turn.lastHandledKey, '周六有空吗？')
})

test('场景E：批量联系人并发轮询——每人各自独立轮次', async () => {
  const contacts = ['甲', '乙', '丙'].map((name) => ({ id: name, name, profile: {}, learning: { messages: [], facts: [], topicLog: [], mediaLog: [] }, turn: {} }))
  let aiCalls = 0
  const counters = new Map()
  for (const contact of contacts) counters.set(contact.name, { calls: 0, replied: 0 })
  // 每人都发同一条消息，轮询 30 轮
  for (let tick = 0; tick < 30; tick += 1) {
    for (const contact of contacts) {
      counters.get(contact.name).calls += 1
      const gate = shouldAutoReply(contact, { key: '同一条消息', fromMe: false })
      if (gate.ok) {
        counters.get(contact.name).replied += 1
        aiCalls += 1
        contact.turn = { lastHandledKey: '同一条消息', lastOutgoingAt: Date.now() }
      }
    }
  }
  assert.equal(aiCalls, 3, '3 位联系人各回复 1 次，共 3 次')
  assert.ok(counters.get('甲').calls >= 30)
})
