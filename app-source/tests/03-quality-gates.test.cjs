// 文本质量门槛测试：AI 腔 / 思考泄漏 / 攻击性 / 空壳 / 元话语 / 限长
const { test } = require('node:test')
const assert = require('node:assert')
require('./setup.cjs')
const {
  isReasoningLeak, cleanGeneratedText, replyQualityIssues, clampCasualText,
  stripTrailingPeriod, isNoReplyDecision, isHollowOrMeta, hasEthicsIssue,
  isLowInfoComment, isMediaPlaceholder, choiceText,
} = require('../electron/ai-service.cjs')

test('思考泄漏检测：分析式开头 × 任务元词汇双命中才判泄漏', () => {
  assert.equal(isReasoningLeak('我们需要生成一条消息，要求是语气要自然'), true)
  assert.equal(isReasoningLeak('根据要求：写一条回复'), true)
  assert.equal(isReasoningLeak('让我先分析一下这个对话的上下文'), true)
  assert.equal(isReasoningLeak('我们周末一起去爬山吧'), false, '正常消息不能误杀')
  assert.equal(isReasoningLeak('我需要先走了，明天聊'), false, '"我需要"单独出现不判泄漏')
  assert.equal(isReasoningLeak('分析一下的话，这电影确实不错'), false, '只有开头命中不判泄漏')
  assert.equal(isReasoningLeak(''), false)
})

test('cleanGeneratedText：剥 thinking/代码块/星号/前缀', () => {
  assert.equal(cleanGeneratedText('<think>推理过程</think>好的'), '好的')
  assert.equal(cleanGeneratedText('```html\n好的```'), '好的')
  assert.equal(cleanGeneratedText('**这周末有点诡异**'), '这周末有点诡异')
  assert.equal(cleanGeneratedText('回复：好的呀'), '好的呀')
  assert.equal(cleanGeneratedText('[不回复]'), '')
  assert.ok(cleanGeneratedText('啊'.repeat(200)).length <= 120)
})

test('choiceText：content 字符串 / 数组 / reasoning_content 兜底', () => {
  assert.equal(choiceText({ choices: [{ message: { content: '哈哈' } }] }), '哈哈')
  assert.equal(choiceText({ choices: [{ message: { content: [{ text: '一' }, { text: '二' }] } }] }), '一 二')
  const reasoningOnly = { choices: [{ message: { content: '', reasoning_content: '第一段分析\n最终答案：吃饭了' } }] }
  assert.equal(choiceText(reasoningOnly), '最终答案：吃饭了')
  const leak = { choices: [{ message: { reasoning_content: '我们需要生成一条消息，要求是简短' } }] }
  assert.equal(choiceText(leak), '', '泄漏的思考内容必须返回空')
})

test('isNoReplyDecision', () => {
  assert.equal(isNoReplyDecision('[不回复]'), true)
  assert.equal(isNoReplyDecision('不回复'), true)
  assert.equal(isNoReplyDecision('不需要回复'), true)
  assert.equal(isNoReplyDecision('不回复你'), false)
})

test('replyQualityIssues：长度/AI腔/Markdown/连环追问', () => {
  assert.ok(replyQualityIssues('好'.repeat(40)).some((i) => i.includes('35 字')))
  assert.ok(replyQualityIssues('我理解你的感受').some((i) => i.includes('AI 腔')))
  assert.ok(replyQualityIssues('**加粗**').some((i) => i.includes('Markdown')))
  assert.ok(replyQualityIssues('你好吗？在干嘛？吃了吗？晚上有空？').some((i) => i.includes('问句太多')))
  assert.ok(replyQualityIssues('回复：好的').some((i) => i.includes('前缀')))
  assert.ok(replyQualityIssues('😄').some((i) => i.includes('空洞')))
})

test('replyQualityIssues：视频专项', () => {
  assert.ok(replyQualityIssues('这个视频好有趣', true).some((i) => i.includes('泛泛')))
  assert.ok(replyQualityIssues('视频没加载出来', true).some((i) => i.includes('未加载')))
  assert.ok(replyQualityIssues('评论区都在说这个', true).some((i) => i.includes('评论')))
  assert.ok(replyQualityIssues('哈哈哈', true).some((i) => i.includes('只有笑声')))
  assert.ok(!replyQualityIssues('那只猫打翻水杯笑死我了', true).length, '具体回复应通过')
})

test('replyQualityIssues：善意兜底（道德护栏）', () => {
  assert.ok(replyQualityIssues('你真是个废物').some((i) => i.includes('攻击性')))
  assert.ok(replyQualityIssues('谁让你不读书，活该').some((i) => i.includes('刻薄评判')))
  assert.equal(hasEthicsIssue('你真是个废物'), true)
  assert.equal(hasEthicsIssue('今天天气不错'), false)
})

test('replyQualityIssues：元话语泄漏', () => {
  assert.ok(replyQualityIssues('这不是回复乔治的信息，而是你的一个朋友给你发来的信息').some((i) => i.includes('元话语')))
  assert.equal(isHollowOrMeta('根据要求：生成一条消息'), true)
  assert.equal(isHollowOrMeta('正常聊天内容'), false)
})

test('replyQualityIssues：emoji 预算', () => {
  assert.ok(replyQualityIssues('好的😊😊😊', false, true).some((i) => i.includes('表情过多')))
  assert.ok(replyQualityIssues('好的😊', false, false).some((i) => i.includes('不需要使用表情')))
  assert.ok(!replyQualityIssues('好的😊', false, true).length)
})

test('clampCasualText：超长在句末标点收束', () => {
  const long = '今天去了那个新开的商场，逛了一下午，累死了，买了点东西，还吃了饭，感觉还不错，下次可以一起去看看'
  const clamped = clampCasualText(long, 40)
  assert.ok([...clamped].length <= 40)
  assert.ok(/[。！？~～；，]$/.test(clamped) || [...clamped].length < 40, '在标点或长度内收束')
  assert.equal(clampCasualText('短的回复', 40), '短的回复')
})

test('stripTrailingPeriod 只剥句号', () => {
  assert.equal(stripTrailingPeriod('好的。'), '好的')
  assert.equal(stripTrailingPeriod('好的！'), '好的！')
})

test('isLowInfoComment：纯笑声/打卡/纯 emoji 不进 prompt', () => {
  assert.equal(isLowInfoComment('哈哈哈哈'), true)
  assert.equal(isLowInfoComment('666'), true)
  assert.equal(isLowInfoComment('前排围观'), true)
  assert.equal(isLowInfoComment('😂😂😂'), true)
  assert.equal(isLowInfoComment('这个转场太丝滑了'), false)
  assert.equal(isLowInfoComment(''), true)
})

test('isMediaPlaceholder：空壳预览无可聊内容', () => {
  assert.equal(isMediaPlaceholder('分享[视频]'), true)
  assert.equal(isMediaPlaceholder('[表情]'), true)
  assert.equal(isMediaPlaceholder('分享[商品]: 超好用的键盘'), false)
  assert.equal(isMediaPlaceholder(''), true)
})
