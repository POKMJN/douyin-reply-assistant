// 消息队列测试：收集 → 规划 → 串行执行
// 覆盖 rebuild/tools/run-automation.template.cjs 里的队列实现。
const { test } = require('node:test')
const assert = require('node:assert')
require('./setup.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { AiService } = require('../electron/ai-service.cjs')
const { createMemoryStorage } = require('./setup.cjs')

const PROVIDER = { name: '主力', model: 'test-model', baseUrl: 'https://api.test/v1', capabilities: [] }

const makeContact = (name, preview, extra = {}) => ({
  id: name,
  name,
  preview,
  fromMe: false,
  unread: false,
  profile: {},
  learning: { messages: [], facts: [], topicLog: [], mediaLog: [] },
  turn: {},
  ...extra,
})

function makeService({ contacts = [], settings, automation, transport } = {}) {
  const storage = createMemoryStorage({
    providers: [PROVIDER],
    contacts,
    ...(settings ? { settings } : {}),
    ...(automation ? { automation } : {}),
  })
  const ai = new AiService(storage, {
    transport: transport || (async () => ({ choices: [{ message: { content: '好呀，那就这么定了' } }] })),
  })
  const ds = new DouyinService({ storage, ai, partition: 'persist:test', emit: () => {} })
  ds.sent = []
  // 页面相关方法打桩：队列测试只验证编排，不碰真实浏览器
  ds.selectConversation = async () => null
  ds.captureVisibleMessages = async () => []
  ds.captureLatestIncomingMessageIdentity = async () => null
  ds.isLastMessageFromMe = async () => false
  ds.sendMessage = async (name, text, meta) => { ds.sent.push({ name, text, meta }) }
  return { ds, storage, ai }
}

const ctxOf = (contacts, over = {}) => ({
  contacts,
  canSend: () => true,
  settings: { showAiModelLabel: true, aiReplyDraftOnly: false },
  today: '2026-09-15',
  factCandidates: [],
  topicCandidates: [],
  autoReplyOn: true,
  blacklist: new Set(),
  aiDisabledContacts: new Set(),
  ...over,
})

// ---------------- 入队 ----------------

test('入队：同一联系人连发多条合并成一批，只保留最新消息', () => {
  const { ds } = makeService()
  ds.enqueueIncoming({ name: '小明', key: 'k1', preview: '在吗', enqueuedAt: 1000 })
  ds.enqueueIncoming({ name: '小明', key: 'k2', preview: '出来玩吗', enqueuedAt: 2000 })
  ds.enqueueIncoming({ name: '小明', key: 'k3', preview: '就今天', enqueuedAt: 3000 })
  const queue = ds.incomingQueueMap()
  assert.equal(queue.size, 1, '同一联系人只占一条队列项')
  assert.equal(queue.get('小明').key, 'k3', '保留最新一条消息')
  assert.equal(queue.get('小明').mergedCount, 3, '连发条数被记录')
  assert.equal(queue.get('小明').enqueuedAt, 1000, '入队时间保持最早一条（等待时长从最早算起）')
})

test('入队：不同联系人各自排队', () => {
  const { ds } = makeService()
  ds.enqueueIncoming({ name: '甲', key: 'k', preview: '在吗', enqueuedAt: 1 })
  ds.enqueueIncoming({ name: '乙', key: 'k', preview: '在吗', enqueuedAt: 2 })
  assert.equal(ds.incomingQueueMap().size, 2)
})

test('入队：同一条消息被反复重新发现时不算连发（不涨计数、不刷日志）', () => {
  const { ds } = makeService()
  ds.enqueueIncoming({ name: '小明', key: 'k1', preview: '在吗', enqueuedAt: 1 })
  ds.incomingQueueMap().get('小明').deferUntil = 123456
  for (let i = 0; i < 5; i += 1) ds.enqueueIncoming({ name: '小明', key: 'k1', preview: '在吗', enqueuedAt: 1 })
  const item = ds.incomingQueueMap().get('小明')
  assert.equal(item.mergedCount, 1, '同一条消息反复入队不该被算成连发')
  assert.equal(item.deferUntil, 123456, '延后时间不能被重新入队冲掉')
  const mergedLogs = (ds.storage.get().logs || []).filter((l) => l.type === 'queue_merged')
  assert.equal(mergedLogs.length, 0, '不该产生 queue_merged 日志')
})

test('入队：合并日志按联系人 10 分钟节流（媒体指纹抖动不会刷屏）', () => {
  const { ds } = makeService()
  ds.enqueueIncoming({ name: '小明', key: 'k1', preview: '分享[图集]', enqueuedAt: 1 })
  ds.enqueueIncoming({ name: '小明', key: 'k2', preview: '分享[图集]', enqueuedAt: 2 })
  ds.enqueueIncoming({ name: '小明', key: 'k3', preview: '分享[图集]', enqueuedAt: 3 })
  ds.enqueueIncoming({ name: '小明', key: 'k4', preview: '分享[图集]', enqueuedAt: 4 })
  const mergedLogs = (ds.storage.get().logs || []).filter((l) => l.type === 'queue_merged')
  assert.equal(mergedLogs.length, 1, '10 分钟内只记一条合并日志')
  assert.equal(ds.incomingQueueMap().get('小明').mergedCount, 4, '计数照常累加')
})

// ---------------- 规划 ----------------

test('规划：达到每日发送上限 → hold（消息保留，不消费）', () => {
  const { ds } = makeService()
  ds.enqueueIncoming({ name: '小明', key: 'k1', preview: '在吗', enqueuedAt: 1 })
  const plans = ds.planIncomingQueue({ canSend: () => false })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].action, 'hold')
  assert.equal(plans[0].reason, 'daily_limit')
  assert.equal(ds.incomingQueueMap().size, 1, '限额不消费消息')
})

test('规划：延后未到点 → defer（不回队列头）', () => {
  const { ds } = makeService()
  ds.enqueueIncoming({ name: '小明', key: 'k1', preview: '在吗', enqueuedAt: 1 })
  ds.incomingQueueMap().get('小明').deferUntil = Date.now() + 60_000
  const plans = ds.planIncomingQueue({ canSend: () => true })
  assert.equal(plans[0].action, 'defer')
  assert.equal(plans[0].reason, 'wait_until')
})

test('规划：条件满足 → reply', () => {
  const { ds } = makeService()
  ds.enqueueIncoming({ name: '小明', key: 'k1', preview: '在吗', enqueuedAt: 1 })
  const plans = ds.planIncomingQueue({ canSend: () => true })
  assert.equal(plans[0].action, 'reply')
})

// ---------------- 执行（串行 + 顺序） ----------------

test('执行：按入队时间先到先处理，且严格串行', async () => {
  const { ds } = makeService()
  const seen = []
  let concurrent = 0
  let maxConcurrent = 0
  ds.handleIncomingItem = async (item) => {
    concurrent += 1
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    await new Promise((r) => setTimeout(r, 10))
    seen.push(item.name)
    concurrent -= 1
    ds.incomingQueueMap().delete(item.name)
    return 'consumed'
  }
  ds.enqueueIncoming({ name: '乙', key: 'k', preview: 'x', enqueuedAt: 2000 })
  ds.enqueueIncoming({ name: '甲', key: 'k', preview: 'x', enqueuedAt: 1000 })
  await ds.drainIncomingQueue(ctxOf([{ name: '甲' }, { name: '乙' }]))
  assert.deepEqual(seen, ['甲', '乙'], '先入队的先处理')
  assert.equal(maxConcurrent, 1, '同一时刻只处理一条')
})

test('执行：连发三条合并后只调用一次 AI、只发一条', async () => {
  let calls = 0
  const { ds } = makeService({
    transport: async () => { calls += 1; return { choices: [{ message: { content: '好呀，那就这么定了' } }] } },
  })
  const contact = makeContact('小明', '就今天')
  ds.enqueueIncoming({ name: '小明', key: 'k1', preview: '在吗', enqueuedAt: 1 })
  ds.enqueueIncoming({ name: '小明', key: 'k2', preview: '出来玩吗', enqueuedAt: 2 })
  ds.enqueueIncoming({ name: '小明', key: 'k3', preview: '就今天', enqueuedAt: 3 })
  await ds.drainIncomingQueue(ctxOf([contact]))
  assert.equal(calls, 1, '合并成一批只调用一次 AI')
  assert.equal(ds.sent.length, 1, '只发出一条')
  assert.equal(ds.incomingQueueMap().size, 0, '消费后出队')
  assert.equal(ds.lastSeen.get('小明'), 'k3', 'lastSeen 推进到最新 key')
})

test('执行：预览就是我刚发出的内容（回声）→ 直接消费出队，不调用 AI', async () => {
  let calls = 0
  const { ds } = makeService({
    transport: async () => { calls += 1; return { choices: [{ message: { content: '不该出现的回复' } }] } },
  })
  ds.lastSent.set('小明', '在的，咋啦')
  ds.enqueueIncoming({ name: '小明', key: 'k1', preview: '在的，咋啦', enqueuedAt: 1 })
  await ds.drainIncomingQueue(ctxOf([makeContact('小明', '在的，咋啦')]))
  assert.equal(calls, 0, '回声守卫必须拦住')
  assert.equal(ds.sent.length, 0)
  assert.equal(ds.incomingQueueMap().size, 0)
  assert.equal(ds.lastSeen.get('小明'), 'k1')
})

test('执行：发送方无法确认 → 延后保留，绝不抢发', async () => {
  let calls = 0
  const { ds } = makeService({
    transport: async () => { calls += 1; return { choices: [{ message: { content: '不该出现的回复' } }] } },
  })
  ds.isLastMessageFromMe = async () => null
  ds.enqueueIncoming({ name: '小明', key: 'k1', preview: '在吗', enqueuedAt: 1 })
  await ds.drainIncomingQueue(ctxOf([makeContact('小明', '在吗')]))
  assert.equal(calls, 0)
  assert.equal(ds.incomingQueueMap().size, 1, '消息保留在队列')
  assert.equal(ds.lastSeen.get('小明'), undefined, '不推进 lastSeen')
})

test('执行：AI 调用失败 → 延后并带重试时间（消息不消费）', async () => {
  const { ds } = makeService({
    transport: async () => { const error = new Error('接口故障'); error.statusCode = 503; error.retryable = false; throw error },
  })
  ds.enqueueIncoming({ name: '小明', key: 'k1', preview: '在吗', enqueuedAt: 1 })
  await ds.drainIncomingQueue(ctxOf([makeContact('小明', '在吗')]))
  const queued = ds.incomingQueueMap().get('小明')
  assert.ok(queued, '失败后消息仍留在队列')
  assert.ok(queued.deferUntil > Date.now(), '带上了重试时间')
  assert.equal(ds.lastSeen.get('小明'), undefined)
  assert.equal(ds.sent.length, 0)
})

test('执行：草稿模式 → 只落草稿、不发送，消息闭环', async () => {
  const { ds, storage } = makeService({ settings: { aiReplyDraftOnly: true, showAiModelLabel: true } })
  ds.enqueueIncoming({ name: '小明', key: 'k1', preview: '在吗', enqueuedAt: 1 })
  await ds.drainIncomingQueue(ctxOf([makeContact('小明', '在吗')], { settings: { aiReplyDraftOnly: true, showAiModelLabel: true } }))
  assert.equal(ds.sent.length, 0, '草稿模式不发送')
  assert.equal((storage.get().pendingDrafts || []).length, 1, '落了一条草稿')
  assert.equal(ds.incomingQueueMap().size, 0)
  assert.equal(ds.lastSeen.get('小明'), 'k1')
})

// ---------------- 收集 ----------------

test('收集：首见联系人只建基线不入队；同一条不重复入队；新消息才入队', async () => {
  const { ds } = makeService()
  const ctx = ctxOf([])
  await ds.collectIncoming([makeContact('小明', '在吗')], ctx)
  assert.equal(ds.incomingQueueMap().size, 0, '首见只建基线')
  assert.ok(ds.lastSeen.has('小明'))
  await ds.collectIncoming([makeContact('小明', '在吗')], ctx)
  assert.equal(ds.incomingQueueMap().size, 0, '同一条消息不重复入队')
  await ds.collectIncoming([makeContact('小明', '出来玩吗')], ctx)
  assert.equal(ds.incomingQueueMap().size, 1, '新消息入队')
})

test('收集：黑名单与 AI 停用联系人都不入队', async () => {
  const { ds } = makeService()
  ds.lastSeen.set('黑名单甲', '旧消息')
  ds.lastSeen.set('停用乙', '旧消息')
  const ctx = ctxOf([], { blacklist: new Set(['黑名单甲']), aiDisabledContacts: new Set(['停用乙']) })
  await ds.collectIncoming([makeContact('黑名单甲', '新消息'), makeContact('停用乙', '新消息')], ctx)
  assert.equal(ds.incomingQueueMap().size, 0)
})

test('收集：未消费的消息在下一轮会被重新入队（等价于重启不丢）', async () => {
  const { ds } = makeService()
  const ctx = ctxOf([])
  await ds.collectIncoming([makeContact('小明', '在吗')], ctx) // 建基线
  await ds.collectIncoming([makeContact('小明', '出来玩吗')], ctx)
  assert.equal(ds.incomingQueueMap().size, 1)
  // 模拟"没处理成"：清空内存队列但 lastSeen 未推进（重启后的第一轮）
  ds.incomingQueue = new Map()
  await ds.collectIncoming([makeContact('小明', '出来玩吗')], ctx)
  assert.equal(ds.incomingQueueMap().size, 1, '未消费的消息会被重新发现')
})

test('收集：我方刚发出的长回复被列表截断或带有模型标签（出站回声）→ 自动推进 lastSeen 绝不入队', async () => {
  const { ds } = makeService()
  const ctx = ctxOf([])
  // 先建基线
  await ds.collectIncoming([makeContact('小明', '你觉得怎么样')], ctx)
  assert.equal(ds.incomingQueueMap().size, 0)

  // 模拟我方发送了较长回复
  const longReply = '我感觉挺好玩的呀，这种风格的视频很有意思，下次还可以多看看'
  ds.lastSent.set('小明', longReply)

  // 1. 列表预览被省略号截断（如抖音PC端展示宽度限制）
  const truncatedPreview = '我感觉挺好玩的呀，这种风格的视频很有意思...'
  await ds.collectIncoming([makeContact('小明', truncatedPreview)], ctx)
  assert.equal(ds.incomingQueueMap().size, 0, '截断回声绝不入队')
  assert.ok(ds.lastSeen.get('小明').includes(truncatedPreview), 'lastSeen 自动跟进')

  // 2. 列表预览带有模型标签（如 [主力]）
  ds.lastSent.set('小红', '这是一条带有模型标签的自动回复内容')
  await ds.collectIncoming([makeContact('小红', '原消息')], ctx) // 基线
  await ds.collectIncoming([makeContact('小红', '[主力] 这是一条带有模型标签的自动回复内容')], ctx)
  assert.equal(ds.incomingQueueMap().size, 0, '带标签的回声绝不入队')
})

test('执行：如果被截断的我方回复进入执行阶段，回声守卫双向匹配成功消费出队、不调 AI', async () => {
  let calls = 0
  const { ds } = makeService({
    transport: async () => { calls += 1; return { choices: [{ message: { content: '不该重复回复' } }] } },
  })
  const longReply = '哈哈哈哈这也太逗了吧，简直绝了，笑死我了'
  ds.lastSent.set('小明', longReply)
  // 模拟 preview 只有前 12 个字，但代表我方刚发的内容
  const truncatedPreview = '哈哈哈哈这也太逗了吧，'
  ds.enqueueIncoming({ name: '小明', key: 'k_echo', preview: truncatedPreview, enqueuedAt: 1 })
  await ds.drainIncomingQueue(ctxOf([makeContact('小明', truncatedPreview)]))
  assert.equal(calls, 0, '双向截断回声守卫必须拦住，绝不调 AI')
  assert.equal(ds.sent.length, 0, '不重复发送')
  assert.equal(ds.incomingQueueMap().size, 0, '正常出队消费')
})

