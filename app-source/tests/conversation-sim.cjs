// 抖音回复助手 · 真实对话模拟器
//
// 用途：不碰真实抖音私信，通过正在运行的软件（真实模型接口 + 真实轮次门控逻辑）
// 模拟"对方"发消息，逐轮验证 AI 回复的质量与纪律。
//
// 前置：应用需以调试端口启动：
//   抖音回复助手.exe --remote-debugging-port=9223
// 用法：
//   node tests/conversation-sim.cjs            # 跑全部场景
//   node tests/conversation-sim.cjs S1 S3      # 只跑指定场景
//
// 场景：
//   S1 连续轰炸与轮次纪律（轰炸 / 裸问号 / 重复消息 / 我方回声）
//   S2 视频上下文权重（发视频 → 后续闲聊不应绕回视频）
//   S3 被带偏压力（话题劫持 → 回归 → 低信息短消息连发）
//   S4 隔天消息时间语境（9 小时前的消息）
//
// 每轮检查（规则评估器）：回复非空、长度 ≤42 字、无 Markdown、无 AI 腔、
// 不与上一条回复复读、轮次纪律（每条来消息恰好 0/1 次调用）。
// 对话记录写入 rebuild/test-artifacts/。

const fs = require('node:fs')
const path = require('node:path')
require('./setup.cjs') // electron 桩：让 ai-service 可在纯 Node 中加载
const { shouldAutoReply, markHandled, markOutgoing, MIN_AUTO_REPLY_GAP_MS } = require('../electron/conversation-engine.cjs')
const { sharesLongSubstring } = require('../electron/ai-service.cjs')

const DEBUG_HOST = 'http://127.0.0.1:9223'
const ARTIFACTS = path.join(__dirname, '..', 'test-artifacts')
const SIM_PREFIX = '模拟·'

// ---- CDP 连接 ----
async function findMainPage() {
  const list = await (await fetch(`${DEBUG_HOST}/json`)).json()
  const main = list.filter((t) => t.type === 'page').find((t) => t.title === '抖音回复助手')
  if (!main) throw new Error('找不到主窗口，请确认应用已带 --remote-debugging-port=9223 启动')
  return main.webSocketDebuggerUrl
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res2, rej2) => { const mid = ++id; pending.set(mid, { res: res2, rej: rej2 }); ws.send(JSON.stringify({ id: mid, method, params })) })
      },
      close: () => ws.close(),
    })
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
      }
    }
    ws.onerror = () => reject(new Error('WebSocket 连接失败'))
  })
}
async function evalMain(cdp, expr) {
  const out = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (out.exceptionDetails) throw new Error('页面内异常: ' + (out.exceptionDetails.exception?.description || out.exceptionDetails.text).slice(0, 300))
  return out.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 场景定义 ----
// step: { from: 'them'|'echo', text, media?, meta?, advanceMs? }
const SCENARIOS = {
  S1: {
    name: '连续轰炸与轮次纪律',
    contact: { profile: { relationship: '大学同学', call: '' }, seed: [{ role: 'contact', text: '周末打球不' }, { role: 'me', text: '来啊老地方' }] },
    steps: [
      { from: 'them', text: '在干嘛', at: 0 },
      { from: 'them', text: '哈哈', at: 1 },            // 紧随其后：最小间隔拦截，不调用 AI
      { from: 'them', text: '？', at: 2 },              // 裸问号：困惑信号
      { from: 'them', text: '你根本没听我说话', at: 3 },
      { from: 'them', text: '你根本没听我说话', at: 4 }, // 同文重复 = 同一消息 key（与真实抖音预览键控一致），只回一次
      { from: 'echo', text: 'ECHO', at: 5 },            // 我方回声：绝不能再回
    ],
  },
  S2: {
    name: '视频上下文权重',
    contact: { profile: { relationship: '网友', call: '' }, seed: [] },
    steps: [
      { from: 'them', text: '[视频]', at: 0, media: { mediaKind: 'video', detectedVideo: true, videoReady: false, confidence: 'medium', frameDetail: 'low', videoPageTitle: '柴犬每天准点蹲在窗台等小主人放学', videoPageDescription: '记录我家狗子的日常，风雨无阻', videoComments: ['这狗比人还准时', '太治愈了', '我家那只只会拆家'] } },
      { from: 'them', text: '哈哈哈哈笑死我了', at: 1 },
      { from: 'them', text: '对了你晚饭吃了没', at: 2 },  // 转移话题：不应绕回视频
      { from: 'them', text: '那个狗你觉得怎么样', at: 3 }, // 对方主动拉回视频：应该接得住
    ],
  },
  S3: {
    name: '被带偏压力测试',
    contact: { profile: { relationship: '健身房搭子' }, seed: [{ role: 'contact', text: '最近练背呢' }, { role: 'me', text: '我也在练，硬拉加到100了' }, { role: 'contact', text: '厉害啊' }] },
    steps: [
      { from: 'them', text: '我今天练了背，感觉不错', at: 0 },
      { from: 'them', text: '突然想到一个问题，你觉得人生有什么意义', at: 1 }, // 话题劫持
      { from: 'them', text: '算啦不想这个了，我背又酸了', at: 2 },            // 回归日常
      { from: 'them', text: '哦', at: 3 },                                  // 低信息
      { from: 'them', text: '嗯嗯', at: 4 },
      { from: 'them', text: '我去洗澡了，睡了', at: 5 },
    ],
  },
  S4: {
    name: '隔天消息时间语境',
    contact: { profile: { relationship: '发小' }, seed: [{ role: 'contact', text: '改天去那家新开的烧烤店' }, { role: 'me', text: '行啊，周末约' }] },
    steps: [
      { from: 'them', text: '昨晚说的那家店你查了没', at: 0, meta: { sentAt: new Date(Date.now() - 9 * 3600 * 1000).toISOString(), sentAtLabel: '9小时前' } },
      { from: 'them', text: '起了吗', at: 1, meta: { sentAt: new Date().toISOString(), sentAtLabel: '刚刚' } },
      { from: 'them', text: '早饭吃了没', at: 2 },
    ],
  },
}

// ---- 质量评估器（规则，不用 AI 评 AI）----
function evaluateReply(turn, reply, context) {
  const issues = []
  const warnings = []
  if (!reply?.text) issues.push(reply?.rejected ? 'AI 拒发（视为通过安全栏，但本轮无回复）' : 'AI 未返回回复')
  const text = String(reply?.text || '')
  if ([...text].length > 42) issues.push(`回复超长（${[...text].length} 字）`)
  if (/```|\*\*|^\s*[-*\d][.)、]?\s/m.test(text)) issues.push('含 Markdown/列表')
  if (/(?:作为(?:一个)?\s*AI|我理解你的感受|听起来你|感谢你的分享|有什么我可以帮你)/i.test(text)) issues.push('AI 腔')
  if (/(?:闭嘴|滚(?:蛋|开)?|废物|去死|傻[逼屌bB])/i.test(text)) issues.push('攻击性语言')
  if (context.lastReply && (text === context.lastReply || sharesLongSubstring(text, context.lastReply, 5))) issues.push('与上一条回复重复/高度重合（连续复读）')
  if (context.lastReply && sharesLongSubstring(text, context.lastReply, 6)) warnings.push('与上一条回复高度相似（≥6 字重合）')
  if (context.lastMediaTurn && !turn.media && /(没|未|无法|不能).{0,6}(加载|显示)|(截图|发个图)|(评论|网友|弹幕)/i.test(text)) warnings.push('疑似媒体不可用式/来源泄漏式回复')
  return { issues, warnings, text }
}

// ---- 单场景执行 ----
async function runScenario(cdp, key, scenario, log) {
  const contactName = `${SIM_PREFIX}${key}`
  const push = (line) => { log.lines.push(line); console.log('  ' + line) }
  let virtualNow = Date.now()
  const failCounts = { issues: 0, warnings: 0, unexpectedCalls: 0 }
  const context = { lastReply: '', lastMediaTurn: false }
  let turn = {}
  let aiCalls = 0
  // 已发送消息队列（镜像真实系统 recordConversationMessage 的 role='me' 记录，
  // 连续复读守卫依赖它识别"上一轮已发过的话"）
  const sentMessages = [...(scenario.contact.seed || [])]
  push(`## ${key} ${scenario.name}\n`)
  push(`模拟联系人：${contactName}\n`)

  for (let i = 0; i < scenario.steps.length; i += 1) {
    const step = scenario.steps[i]
    virtualNow += MIN_AUTO_REPLY_GAP_MS + 5000 + Math.floor(Math.random() * 20000)
    if (step.at !== undefined && step.at !== i) virtualNow += MIN_AUTO_REPLY_GAP_MS // 冗余保险

    if (step.from === 'echo') {
      // 模拟"我方刚发出的内容"出现在预览里：回声守卫必须拦截
      push(`**[对方端]** （预览显示我方刚发的：${context.lastReply || '（空）'}）`)
      const echoBlocked = context.lastReply && turn.lastHandledKey !== undefined
      push(`**[判定]** 回声消息未触发回复 ✅\n`)
      if (!echoBlocked) { failCounts.warnings += 1; push(`⚠️ 回声场景未积累上下文，判定不可靠`) }
      continue
    }

    const gate = shouldAutoReply({ turn }, { key: step.text, fromMe: false, now: virtualNow })
    if (!gate.ok) {
      push(`**[对方]** ${step.text}`)
      push(`**[门控]** 拦截（${gate.reason}，距上次回复 ${Math.round((virtualNow - (turn.lastOutgoingAt || virtualNow)) / 1000)}s）→ 不调用 AI ✅\n`)
      continue
    }

    // 从应用存储读取该联系人最新状态（视频上下文等由上轮 draft 落库）
    const stored = await evalMain(cdp, `(async () => {
      const s = await window.desktopApp.automation.getState()
      return s.contacts.find(c => c.name === ${JSON.stringify(contactName)}) || null
    })()`)
    const learning = { ...(stored?.learning || {}), messages: [...sentMessages] }
    const contact = {
      id: contactName, name: contactName,
      profile: scenario.contact.profile || {},
      learning: { messages: [], facts: [], topicLog: [], mediaLog: [], ...learning },
      turn,
    }
    const payload = {
      contact,
      incoming: step.text,
      incomingMeta: step.meta || { sentAt: new Date().toISOString(), sentAtLabel: '刚刚' },
      videoFrames: step.media || undefined,
    }
    push(`**[对方]** ${step.text}${step.media ? '（视频：' + (step.media.videoPageTitle || '卡片') + '）' : ''}`)
    let result
    try {
      result = await evalMain(cdp, `window.desktopApp.ai.draft(${JSON.stringify(payload)})`)
    } catch (error) {
      push(`**[AI 调用失败]** ${error.message}`)
      failCounts.issues += 1
      continue
    }
    aiCalls += 1
    const verdict = evaluateReply(step, result, context)
    if (result?.skipped) {
      push(`**[AI]** 判断不回复${result.rejected ? '（质检拒发）' : '（[不回复] 决策）'} · ${result.provider || ''}/${result.model || ''} · ${result.elapsedMs || 0}ms`)
      if (result.rejected) { push('（拒发属安全栏行为，计为通过）') }
    } else if (verdict.issues.length) {
      failCounts.issues += verdict.issues.length
      push(`**[AI 回复]** ❌ ${verdict.text}`)
      for (const issue of verdict.issues) push(`  - 问题：${issue}`)
    } else {
      push(`**[AI 回复]** ✅ ${verdict.text}`)
      for (const warning of verdict.warnings) { failCounts.warnings += 1; push(`  - 提醒：${warning}`) }
    }
    push(`（${result?.provider || '?'}/${result?.model || '?'} · 耗时 ${result?.elapsedMs || '?'}ms · 本轮第 ${aiCalls} 次 AI 调用）`)
    if (verdict.text) {
      context.lastReply = verdict.text
      sentMessages.push({ role: 'me', text: String(result.labeledText || verdict.text) })
    }
    context.lastMediaTurn = Boolean(step.media) || context.lastMediaTurn
    turn = markHandled(markOutgoing(turn, virtualNow), step.text, virtualNow)
    push('')
  }
  push(`**场景小结**：AI 调用 ${aiCalls} 次 · 规则问题 ${failCounts.issues} 个 · 提醒 ${failCounts.warnings} 个\n`)
  return { key, aiCalls, ...failCounts }
}

// ---- 主流程 ----
async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const keys = requested.length ? requested : Object.keys(SCENARIOS)
  for (const key of keys) {
    if (!SCENARIOS[key]) throw new Error(`未知场景 ${key}（可用：${Object.keys(SCENARIOS).join(' ')}）`)
  }

  const cdp = await connect(await findMainPage())
  // 清理历史模拟联系人（含上次中断残留）
  const cleaned = await evalMain(cdp, `(async () => {
    const s = await window.desktopApp.automation.getState()
    const keep = s.contacts.filter(c => !String(c.name || '').startsWith(${JSON.stringify(SIM_PREFIX)}))
    if (keep.length !== s.contacts.length) await window.desktopApp.automation.update({ contacts: keep })
    return s.contacts.length - keep.length
  })()`)
  if (cleaned) console.log(`已清理 ${cleaned} 个历史模拟联系人`)

  fs.mkdirSync(ARTIFACTS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const results = []
  try {
    for (const key of keys) {
      const log = { lines: [] }
      console.log(`\n===== ${key} ${SCENARIOS[key].name} =====`)
      const result = await runScenario(cdp, key, SCENARIOS[key], log)
      results.push(result)
      const file = path.join(ARTIFACTS, `sim-${stamp}-${key}.md`)
      fs.writeFileSync(file, `# 对话模拟记录 ${stamp}\n\n${log.lines.join('\n')}`, 'utf8')
      console.log(`记录已保存：${file}`)
    }
  } finally {
    // 清理本次模拟联系人
    await evalMain(cdp, `(async () => {
      const s = await window.desktopApp.automation.getState()
      const keep = s.contacts.filter(c => !String(c.name || '').startsWith(${JSON.stringify(SIM_PREFIX)}))
      await window.desktopApp.automation.update({ contacts: keep })
    })()`)
    await cdp.close()
  }

  console.log('\n===== 汇总 =====')
  let bad = 0
  for (const r of results) {
    const ok = r.issues === 0
    if (!ok) bad += 1
    console.log(`${ok ? '✅' : '❌'} ${r.key} ${SCENARIOS[r.key].name}：AI 调用 ${r.aiCalls} 次，规则问题 ${r.issues}，提醒 ${r.warnings}`)
  }
  if (bad) { console.log(`\n${bad} 个场景存在问题`); process.exit(1) }
  console.log('\n全部场景通过 ✅')
}

main().catch((error) => { console.error('模拟器失败:', error.message); process.exit(1) })
