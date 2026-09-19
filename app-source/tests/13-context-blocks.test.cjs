// 上下文装配测试：送进模型的上下文里到底有没有"视频内容"和"表情"
// 结论对应的实现：buildChatPrompt 注入 mediaContextBlock(learning.mediaLog)；
// 历史消息（含 emoji / 贴纸文本）经 normalizeLearnedMessages 后进 buildChatMessages。
const { test } = require('node:test')
const assert = require('node:assert')
require('./setup.cjs')
const { buildChatPrompt, buildChatMessages, normalizeLearnedMessages, realChatTexts, isMediaPlaceholder } = require('../electron/ai-service.cjs')

const NOW = Date.now()
const ago = (ms) => new Date(NOW - ms).toISOString()
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

function contactWith({ mediaLog = [], messages = [], examples = [], topicLog = [] } = {}) {
  return {
    name: '小明',
    profile: { examples },
    learning: { messages, mediaLog, topicLog, facts: [], contactStyle: {}, ownerStyle: {} },
  }
}

// ---------------- 视频内容 ----------------

test('上下文含视频：更早分享过的视频降权进上下文，最新一条按设计排除', () => {
  const contact = contactWith({
    mediaLog: [
      { at: ago(2 * HOUR), kind: 'video', summary: '柴犬每天准点蹲在窗台等小主人放学' },
      { at: ago(5 * 60 * 1000), kind: 'video', summary: '深蹲180kg翻车现场' },
    ],
  })
  const prompt = buildChatPrompt(contact, '看看这个', [])
  assert.ok(prompt.includes('对方此前分享过的内容'), '应注入媒体上下文块')
  assert.ok(prompt.includes('柴犬'), '更早那条视频应作为背景进上下文')
  assert.ok(!prompt.includes('深蹲180kg'), '最新一条不进背景块（它是本轮当前消息，单独全量注入）')
})

test('上下文含视频：超过 3 天的视频不再进上下文', () => {
  const contact = contactWith({
    mediaLog: [
      { at: ago(5 * DAY), kind: 'video', summary: '上上周看过的老视频' },
      { at: ago(3 * HOUR), kind: 'video', summary: '昨天的视频' },
      { at: ago(1 * HOUR), kind: 'video', summary: '刚刚发的视频' },
    ],
  })
  const prompt = buildChatPrompt(contact, '在吗', [])
  assert.ok(!prompt.includes('上上周看过的老视频'), '超期条目应过期')
  assert.ok(prompt.includes('昨天的视频'), '3 天内的条目保留')
})

test('上下文含视频：本轮媒体入参（标题/描述/评论/理解结果）会全量注入', () => {
  const contact = contactWith({})
  const media = { videoPageTitle: '三步搞定黄金蛋炒饭', videoPageDescription: '隔夜饭是关键', videoComments: ['第一次做没糊', '隔夜饭真的好用'] }
  const messages = buildChatMessages(contact, '看看这个', media, '这条视频在教蛋炒饭')
  const text = JSON.stringify(messages)
  assert.ok(text.includes('三步搞定黄金蛋炒饭'), '标题要进')
  assert.ok(text.includes('隔夜饭是关键'), '描述要进')
  assert.ok(text.includes('第一次做没糊'), '评论要进')
  assert.ok(text.includes('这条视频在教蛋炒饭'), '视频理解结果要进')
})

// ---------------- 表情 ----------------

test('上下文含表情：历史里的 emoji 与贴纸文本都会进模型消息', () => {
  const contact = contactWith({
    messages: [
      { role: 'contact', text: '我们队输了，😭' },
      { role: 'me', text: '别难过，下次赢回来' },
      { role: 'contact', text: '[早上好]' },
    ],
  })
  const messages = buildChatMessages(contact, '在吗', null, '')
  const text = JSON.stringify(messages)
  assert.ok(text.includes('😭'), 'emoji 要进上下文')
  assert.ok(text.includes('[早上好]'), '贴纸文本要进上下文')
  assert.ok(text.includes('我们队输了'), '原句完整保留')
})

test('上下文含表情：emoji 不会被历史清洗误删，只过滤已读/时间戳/思考泄漏', () => {
  const kept = normalizeLearnedMessages([
    { role: 'contact', text: '😭😭😭' },
    { role: 'contact', text: '已读' },
    { role: 'contact', text: '12:30' },
    { role: 'me', text: '我想想…先这样' },
    { role: 'contact', text: '哈哈哈哈笑死我了' },
  ])
  const texts = kept.map((m) => m.text)
  assert.ok(texts.includes('😭😭😭'), '纯 emoji 消息保留')
  assert.ok(texts.includes('哈哈哈哈笑死我了'))
  assert.ok(!texts.includes('已读'), '已读过滤')
  assert.ok(!texts.includes('12:30'), '时间戳过滤')
})

// ---------------- 说话样例 ----------------

test('说话样例：媒体占位符（分享[视频]）不会污染样例池', () => {
  assert.ok(isMediaPlaceholder('分享[视频]'))
  const texts = realChatTexts([
    { role: 'me', text: '分享[视频]' },
    { role: 'me', text: '哈哈这酒吧会玩' },
    { role: 'me', text: '分享[评论]' },
  ], 'me', 12)
  assert.deepEqual(texts, ['哈哈这酒吧会玩'])
})

test('说话样例：人工样例会以最高优先级注入提示词', () => {
  const contact = contactWith({ examples: ['困就再眯会儿，不着急'] })
  const prompt = buildChatPrompt(contact, '在吗', [])
  assert.ok(prompt.includes('人工提供的账号本人说话样例'))
  assert.ok(prompt.includes('困就再眯会儿，不着急'))
})

test('说话样例：没有样例时退化为"参考自动学习到的历史回复"', () => {
  const prompt = buildChatPrompt(contactWith({}), '在吗', [])
  assert.ok(prompt.includes('没有人工说话样例'))
})
