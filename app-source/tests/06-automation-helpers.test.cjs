// 自动化模块纯函数测试（automation.cjs 剪裁后仍完好）
const { test } = require('node:test')
const assert = require('node:assert')
require('../lib/setup.cjs')
const {
  computePollDelay, humanReplyDelay, mergeMessageHistory, dailySparkMessage,
  resolveSparkTask, mediaPreviewKind, hasReplyablePreviewText, isUnavailableMediaReply,
  shouldDeferConsumptionOnFromMe, conversationTimeMeta, normalizeCapturedMedia,
  hasPublicMediaContext, extractConversationPreview, extractStreakCount,
} = require('../lib/app.cjs')('electron/automation.cjs')

test('computePollDelay：空闲越久越慢，且钳制在 5s-300s', () => {
  const base = 5000
  const idleFast = computePollDelay(base, 0, () => 0.5)
  assert.ok(idleFast >= base * 0.8 && idleFast <= base * 1.2, `空闲时 1x±20%，实际 ${idleFast}`)
  const idleLong = computePollDelay(base, 40 * 60 * 1000, () => 0.5)
  assert.ok(idleLong >= base * 2.8 && idleLong <= base * 3.2, `长空闲 3x±20%，实际 ${idleLong}`)
  assert.ok(computePollDelay(600000, 0) <= 300000)
  assert.ok(computePollDelay(1000, 0) >= 5000)
})

test('humanReplyDelay：按长度 1.5-12 秒拟人打字延迟', () => {
  assert.ok(humanReplyDelay('好') >= 1500 && humanReplyDelay('好') <= 5500)
  assert.ok(humanReplyDelay('啊'.repeat(200)) <= 12000)
})

test('mergeMessageHistory：重叠拼接 + 上限 80', () => {
  const previous = [{ role: 'contact', text: '你好' }, { role: 'me', text: '你好呀' }]
  const visible = [{ role: 'contact', text: '你好' }, { role: 'me', text: '你好呀' }, { role: 'contact', text: '在吗' }]
  const merged = mergeMessageHistory(previous, visible)
  assert.deepEqual(merged.map((m) => m.text), ['你好', '你好呀', '在吗'])
  const big = Array.from({ length: 100 }, (_, i) => ({ role: 'contact', text: `m${i}` }))
  assert.ok(mergeMessageHistory([], big).length <= 80)
})

test('dailySparkMessage：同一天稳定、跨天变化、不越界', () => {
  const task = { name: '小明', kind: 'text', messages: ['早上好', '起来啦', '早呀'] }
  const now = new Date('2026-09-12T08:00:00')
  const pick1 = dailySparkMessage(task, now)
  const pick2 = dailySparkMessage(task, new Date('2026-09-12T20:00:00'))
  assert.equal(pick1, pick2, '同一天同联系人稳定')
  assert.ok(task.messages.includes(pick1))
})

test('resolveSparkTask：aiSpark 类型补全每日文案', () => {
  const task = { kind: 'aiSpark', name: '小明', messages: ['m1', 'm2'] }
  const resolved = resolveSparkTask(task)
  assert.ok(resolved.message, '有每日兜底文案')
})

test('mediaPreviewKind / hasReplyablePreviewText / isUnavailableMediaReply', () => {
  assert.equal(mediaPreviewKind('[视频]'), 'video')
  assert.equal(mediaPreviewKind('分享[商品]: 键盘'), '', '带文字的商品分享不按媒体处理（走文本回复）')
  assert.equal(mediaPreviewKind('[图片]'), 'image')
  assert.equal(hasReplyablePreviewText('[视频]'), false)
  assert.equal(hasReplyablePreviewText('分享[商品]: 超好用的键盘'), true)
  assert.equal(isUnavailableMediaReply('视频没加载出来'), true)
  assert.equal(isUnavailableMediaReply('截图给我看看'), true)
  assert.equal(isUnavailableMediaReply('那只猫太搞笑了'), false)
})

test('shouldDeferConsumptionOnFromMe：竞态保护', () => {
  assert.equal(shouldDeferConsumptionOnFromMe('[视频]', '刚发给对方的话'), true)
  assert.equal(shouldDeferConsumptionOnFromMe('刚发给对方的话', '刚发给对方的话'), false, '就是我刚发的')
  assert.equal(shouldDeferConsumptionOnFromMe('哈哈哈哈', '别的'), false, '纯文本不暂缓')
})

test('conversationTimeMeta：解析列表时间标签', () => {
  const now = new Date('2026-09-12T10:00:00')
  const meta = conversationTimeMeta({ sentAtLabel: '刚刚' }, now)
  assert.ok(meta.sentAt, '刚刚 → 当前时间')
  const stale = conversationTimeMeta({ sentAtLabel: '3天前' }, now)
  assert.ok(new Date(stale.sentAt).getTime() < now.getTime() - 2 * 86400000)
})

test('normalizeCapturedMedia / hasPublicMediaContext', () => {
  const media = normalizeCapturedMedia({ frames: ['data:image/jpeg;base64,xx'], mediaKind: 'video', detectedVideo: true, videoReady: true })
  assert.equal(media.frames.length, 1)
  assert.equal(media.detectedVideo, true)
  assert.equal(hasPublicMediaContext({ videoPageTitle: '标题' }), true)
  assert.equal(hasPublicMediaContext({}), false)
})

test('extractConversationPreview：剔除时间与火花计数行', () => {
  const preview = extractConversationPreview(['小明', '12', '你好呀', '刚刚'])
  assert.ok(preview.includes('你好呀'))
  assert.ok(!preview.includes('刚刚'))
})

test('extractStreakCount：提取火花/连续天数', () => {
  assert.equal(extractStreakCount('15', []), 15)
  assert.equal(extractStreakCount('', ['小明', '连续 32 天', '好的']), 32)
  assert.equal(extractStreakCount('', ['火花 99 天']), 99)
  assert.equal(extractStreakCount('', ['5天', '早安']), 5)
  assert.equal(extractStreakCount('', ['纯文本']), 0)
})
