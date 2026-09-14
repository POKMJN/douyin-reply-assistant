// 上下文权重测试：视频作为一等上下文 + 防带偏
const { test } = require('node:test')
const assert = require('node:assert')
const {
  appendMediaLog, mediaContextBlock, topicMemoryBlock, longTermMemoryBlock,
  buildTurnGuidance, normalizeHistory, cleanTopicSummary, factText,
} = require('../electron/conversation-engine.cjs')

const HOUR = 60 * 60 * 1000

test('视频上下文：当轮最新条目作为"当前消息"处理，不重复注入背景块', () => {
  const learning = { mediaLog: [] }
  learning.mediaLog = appendMediaLog(learning, { summary: '猫打翻水杯的搞笑视频' }).mediaLog
  const block = mediaContextBlock(learning) // 当轮回复 excludeLatest=true
  assert.equal(block, '', '本轮正在回复的视频不应同时出现在背景块里')
  // 下一轮（对方又发新消息）：上一条视频变成背景
  const next = { mediaLog: [...learning.mediaLog, { at: new Date().toISOString(), kind: 'video', summary: '新视频' }] }
  const block2 = mediaContextBlock(next)
  assert.ok(block2.includes('猫打翻水杯'), '上一轮的视频应降权为背景提及')
  assert.ok(!block2.includes('新视频'), '最新视频仍然不进背景块')
})

test('视频上下文：超过 3 天过期，不再注入', () => {
  const old = new Date(Date.now() - 4 * 24 * HOUR).toISOString()
  const learning = { mediaLog: [{ at: old, kind: 'video', summary: '很久之前的视频' }] }
  assert.equal(mediaContextBlock(learning, { excludeLatest: false }), '')
})

test('视频上下文：最多注入 3 条背景，带相对时间', () => {
  const now = Date.now()
  const learning = {
    mediaLog: [
      { at: new Date(now - 10 * HOUR).toISOString(), summary: '视频甲' },
      { at: new Date(now - 8 * HOUR).toISOString(), summary: '视频乙' },
      { at: new Date(now - 6 * HOUR).toISOString(), summary: '视频丙' },
      { at: new Date(now - 4 * HOUR).toISOString(), summary: '视频丁' },
      { at: new Date(now - 2 * HOUR).toISOString(), summary: '视频戊' },
    ],
  }
  const block = mediaContextBlock(learning)
  assert.ok(block.includes('视频乙') && block.includes('视频丙') && block.includes('视频丁'), '排除最新（戊）后取最近 3 条（乙丙丁）')
  assert.ok(!block.includes('视频戊'), '最新视频不进背景块')
  assert.ok(!block.includes('视频甲'), '超出 3 条的更早条目不注入')
})

test('话题记忆块：最多 2 条，消毒分点残留', () => {
  const learning = {
    topicLog: [
      { at: new Date().toISOString(), text: '1. 聊了周末安排 2. 关系温度似乎是热络' },
      { at: new Date().toISOString(), text: '吐槽加班' },
      { at: new Date().toISOString(), text: '更早的话题' },
    ],
  }
  const block = topicMemoryBlock(learning)
  assert.ok(block.includes('吐槽加班'), '保留最近话题')
  assert.ok(block.includes('更早的话题'), '第二近的话题保留')
  assert.ok(!block.includes('聊了周末安排'), '超出 2 条的更旧话题不注入')
  assert.ok(!block.includes('1.'), '分点编号被消毒')
})

test('长期记忆块：噪音事实被过滤，上限 8 条', () => {
  const facts = Array.from({ length: 12 }, (_, i) => ({ text: `事实${i}：对方喜欢爬山` }))
  facts.push({ text: '对方最近没有消息' })
  facts.push({ text: '无法确认对方的工作' })
  const block = longTermMemoryBlock({ facts })
  assert.ok(!block.includes('最近没有消息'))
  assert.ok(!block.includes('无法确认'))
  assert.ok(!block.includes('事实0'), '只保留最近 8 条')
  assert.ok(block.includes('事实11'))
})

test('回合指导：任何输入都带"一条回复"铁律与防带偏总纲', () => {
  for (const incoming of ['你好', '？', '哈哈', '在吗', '']) {
    const guidance = buildTurnGuidance({ learning: { messages: [] } }, incoming)
    assert.ok(guidance.includes('唯一的一条回复'), `输入"${incoming}"缺少一条回复铁律`)
    assert.ok(guidance.includes('不是切换人设'), `输入"${incoming}"缺少防带偏总纲`)
  }
})

test('回合指导：裸问号按困惑处理，不推进自己的话题', () => {
  const guidance = buildTurnGuidance({}, '？？？')
  assert.ok(guidance.includes('困惑、不满或没看懂'))
  assert.ok(guidance.includes('不要继续推进自己之前的话题'))
})

test('回合指导：低信息短消息不强行展开', () => {
  const guidance = buildTurnGuidance({}, '哦')
  assert.ok(guidance.includes('低信息短消息'))
  assert.ok(guidance.includes('不要强行展开新话题'))
})

test('回合指导：我方刚提问过则优先承接回答', () => {
  const contact = { learning: { messages: [{ role: 'me', text: '你周末有空吗？' }] } }
  const guidance = buildTurnGuidance(contact, '有啊')
  assert.ok(guidance.includes('优先承接对方的回答'))
})

test('回合指导：负面情绪先共振不说教', () => {
  const guidance = buildTurnGuidance({}, '今天累死了，烦死了')
  assert.ok(guidance.includes('负面情绪'))
  assert.ok(guidance.includes('不要擅自分析原因'))
})

test('normalizeHistory 过滤已读/时间噪音并限长', () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'me' : 'contact', text: `消息${i}` }))
  messages.push({ role: 'contact', text: '已读' }, { role: 'contact', text: '12:30' }, { role: 'contact', text: '' })
  const normalized = normalizeHistory(messages, 14)
  assert.equal(normalized.length, 14)
  assert.ok(!normalized.some((m) => m.text === '已读'))
  assert.equal(normalized.at(-1).text, '消息29')
})

test('cleanTopicSummary 与 factText 兼容旧数据', () => {
  assert.equal(cleanTopicSummary('概括：聊了电影'), '聊了电影')
  assert.equal(factText('纯字符串'), '纯字符串')
  assert.equal(factText({ text: '对象形态' }), '对象形态')
  assert.equal(factText(null), '')
})
