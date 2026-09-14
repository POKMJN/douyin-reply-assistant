// 轮次状态机测试：修复"自动回复说个不停"的核心回归
const { test } = require('node:test')
const assert = require('node:assert')
const {
  shouldAutoReply, markHandled, markOutgoing, MIN_AUTO_REPLY_GAP_MS,
  turnOf, relativeTimeLabel,
} = require('../electron/conversation-engine.cjs')

const KEY_A = '你好呀'
const KEY_B = '在干嘛'

test('同一条消息只允许处理一次（说个不停回归）', () => {
  let contact = { name: '张三' }
  const gate1 = shouldAutoReply(contact, { key: KEY_A, fromMe: false })
  assert.equal(gate1.ok, true)
  contact = { ...contact, turn: markHandled(contact, KEY_A) }
  const gate2 = shouldAutoReply(contact, { key: KEY_A, fromMe: false })
  assert.equal(gate2.ok, false)
  assert.equal(gate2.reason, 'already_handled')
})

test('模拟 100 轮轮询：同一消息 key 永远不会触发第二次回复', () => {
  let contact = { name: '李四' }
  let replies = 0
  for (let tick = 0; tick < 100; tick += 1) {
    const gate = shouldAutoReply(contact, { key: KEY_A, fromMe: false })
    if (gate.ok) {
      replies += 1
      contact = { ...contact, turn: markHandled(markOutgoing(contact), KEY_A) }
    }
  }
  assert.equal(replies, 1, '同一 key 无论轮询多少轮只能回复一次')
})

test('对方连续发两条消息：每条各回复一次', () => {
  let contact = { name: '王五' }
  assert.equal(shouldAutoReply(contact, { key: KEY_A, fromMe: false }).ok, true)
  contact = { ...contact, turn: markHandled(markOutgoing(contact), KEY_A) }
  // 第二条消息（新 key）到达：超过最小间隔后允许
  const gate = shouldAutoReply(contact, { key: KEY_B, fromMe: false, now: Date.now() + MIN_AUTO_REPLY_GAP_MS + 1 })
  assert.equal(gate.ok, true)
  contact = { ...contact, turn: markHandled(markOutgoing(contact), KEY_B) }
  assert.equal(shouldAutoReply(contact, { key: KEY_B, fromMe: false }).ok, false)
})

test('最小发送间隔：刚回复过 20 秒内不再发（即使 key 判断异常）', () => {
  const now = Date.now()
  let contact = { name: '赵六', turn: { lastHandledKey: '', lastOutgoingAt: now - 5000 } }
  const gate = shouldAutoReply(contact, { key: KEY_B, fromMe: false, now })
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'min_gap')
  // 间隔过后放行
  const later = shouldAutoReply(contact, { key: KEY_B, fromMe: false, now: now + MIN_AUTO_REPLY_GAP_MS + 1 })
  assert.equal(later.ok, true)
})

test('发送方角色未确认（null/true）时一律不回复', () => {
  const contact = { name: '钱七' }
  assert.equal(shouldAutoReply(contact, { key: KEY_A, fromMe: true }).ok, false)
  assert.equal(shouldAutoReply(contact, { key: KEY_A, fromMe: null }).ok, false)
  assert.equal(shouldAutoReply(contact, { key: KEY_A, fromMe: undefined }).ok, false)
  assert.equal(shouldAutoReply(contact, { key: KEY_A }).ok, false)
})

test('空 key 不回复', () => {
  const contact = { name: '孙八' }
  assert.equal(shouldAutoReply(contact, { key: '', fromMe: false }).ok, false)
  assert.equal(shouldAutoReply(contact, { key: null, fromMe: false }).ok, false)
})

test('markOutgoing 只刷新间隔，不影响已处理 key', () => {
  let contact = { name: '周九' }
  contact = { ...contact, turn: markHandled(contact, KEY_A) }
  contact = { ...contact, turn: markOutgoing(contact) }
  assert.equal(shouldAutoReply(contact, { key: KEY_A, fromMe: false }).ok, false)
})

test('每日消息键：同文本跨天解锁、同天只处理一次（每天只发早上好场景）', () => {
  const { dailyMessageKey } = require('../electron/conversation-engine.cjs')
  const day1 = new Date('2026-09-13T08:00:00')
  const day2 = new Date('2026-09-14T08:00:00')
  const key1 = dailyMessageKey('早上好', day1)
  const key2 = dailyMessageKey('早上好', day2)
  const keySameDay = dailyMessageKey('早上好', new Date('2026-09-13T15:00:00'))
  assert.notEqual(key1, key2, '跨天同文本应是新消息')
  assert.equal(key1, keySameDay, '同天同文本应同键（防刷屏）')
  let contact = { name: '每天问早的人' }
  assert.equal(shouldAutoReply(contact, { key: key1, fromMe: false, now: day1.getTime() }).ok, true)
  contact = { ...contact, turn: markHandled(markOutgoing(contact, day1.getTime()), key1, day1.getTime()) }
  assert.equal(shouldAutoReply(contact, { key: key1, fromMe: false, now: day1.getTime() + 3600000 }).ok, false, '同天再发不再回复')
  const nextDay = shouldAutoReply(contact, { key: key2, fromMe: false, now: day2.getTime() })
  assert.equal(nextDay.ok, true, '第二天再发应重新回复')
})

test('turnOf 对脏数据健壮', () => {
  assert.deepEqual(turnOf(null), { lastHandledKey: '', lastOutgoingAt: 0 })
  assert.deepEqual(turnOf({ turn: 'garbage' }), { lastHandledKey: '', lastOutgoingAt: 0 })
  assert.deepEqual(turnOf({ turn: { lastHandledKey: 'x' } }).lastHandledKey, 'x')
})

test('relativeTimeLabel 语义', () => {
  const now = Date.now()
  assert.equal(relativeTimeLabel(new Date(now - 30 * 1000).toISOString(), now), '刚刚')
  assert.equal(relativeTimeLabel(new Date(now - 5 * 60 * 1000).toISOString(), now), '5分钟前')
  assert.equal(relativeTimeLabel(new Date(now - 3 * 60 * 60 * 1000).toISOString(), now), '3小时前')
  assert.equal(relativeTimeLabel(new Date(now - 24 * 60 * 60 * 1000).toISOString(), now), '昨天')
  assert.equal(relativeTimeLabel(new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(), now), '5天前')
  assert.equal(relativeTimeLabel('not-a-date', now), '此前')
})
